import { Resend } from 'resend';
import { put } from '@vercel/blob';

const resend = new Resend(process.env.RESEND_API_KEY);
const FISH_API = 'https://api.fish.audio';
const QSTASH_API = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2';
const BASE_URL = 'https://envision-legacy.vercel.app';
const MAX_POLLS = 40; // 40 × 15s = ~10 min max (full mode takes ~5 min)

/** Escape HTML for email templates. */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Schedule a delayed poll via QStash. */
async function schedulePollViaQStash(payload, delaySec = '10s') {
  const resp = await fetch(`${QSTASH_API}/publish/${BASE_URL}/api/generate-voice`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Delay': delaySec,
      'Upstash-Forward-Authorization': `Bearer ${process.env.INTERNAL_API_SECRET}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`QStash publish failed (${resp.status}): ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  console.log(`   📬 Poll scheduled (messageId: ${data.messageId})`);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', BASE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.headers.authorization !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { modelId } = body;
  if (modelId) return handleSynthesize(res, body);
  return handleClone(res, body);
}

// --- STEP 1: Create voice clone model ---
async function handleClone(res, body) {
  const { voiceSampleUrl, customerEmail, customerName, voiceMessage } = body;

  if (!voiceSampleUrl || !customerEmail || !voiceMessage) {
    return res.status(400).json({ error: 'Missing voiceSampleUrl, customerEmail, or voiceMessage' });
  }

  console.log(`🎤 Voice Clone START — ${customerName} (${customerEmail})`);
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) {
    await sendFailureNotification(customerName, customerEmail, 'FISH_AUDIO_API_KEY not configured');
    return res.status(500).json({ error: 'Fish Audio not configured' });
  }

  try {
    // Download voice sample
    console.log(`   Downloading voice sample: ${voiceSampleUrl}`);
    const sampleResp = await fetch(voiceSampleUrl);
    if (!sampleResp.ok) throw new Error(`Voice sample download failed: ${sampleResp.status}`);
    const sampleBuffer = Buffer.from(await sampleResp.arrayBuffer());
    const sampleType = sampleResp.headers.get('content-type') || 'audio/webm';
    console.log(`   Downloaded: ${sampleBuffer.length} bytes (${sampleType})`);

    // Create voice model via Fish Audio
    console.log(`   📤 Creating Fish Audio voice model...`);

    // Build multipart form data manually
    const boundary = `----FishAudio${Date.now()}`;
    const modelTitle = `envision-${customerName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`;

    // Determine file extension
    let ext = 'webm';
    if (sampleType.includes('mp3') || sampleType.includes('mpeg')) ext = 'mp3';
    else if (sampleType.includes('wav')) ext = 'wav';
    else if (sampleType.includes('mp4')) ext = 'mp4';
    else if (sampleType.includes('m4a')) ext = 'm4a';
    else if (sampleType.includes('ogg')) ext = 'ogg';

    const parts = [];

    // Title field
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\nprivate`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ntts`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="train_mode"\r\n\r\nfull`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${modelTitle}`);

    // Audio file
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="voices"; filename="sample.${ext}"\r\nContent-Type: ${sampleType}\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--`;

    const headerBuf = Buffer.from(parts.join('\r\n') + '\r\n' + fileHeader);
    const footerBuf = Buffer.from(fileFooter);
    const fullBody = Buffer.concat([headerBuf, sampleBuffer, footerBuf]);

    const modelResp = await fetch(`${FISH_API}/model`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: fullBody,
    });

    if (!modelResp.ok) {
      const errText = await modelResp.text();
      throw new Error(`Fish Audio model creation failed (${modelResp.status}): ${errText.substring(0, 300)}`);
    }

    const modelData = await modelResp.json();
    const newModelId = modelData._id || modelData.id;
    console.log(`   ✅ Model created: ${newModelId}`);

    // Schedule synthesis (give model a moment to be ready)
    // Full mode takes ~5 min, give it time before first synthesis attempt
    await schedulePollViaQStash({
      modelId: newModelId,
      voiceMessage,
      customerEmail,
      customerName,
      pollCount: 1,
    }, '30s');

    return res.status(200).json({ success: true, status: 'cloning', modelId: newModelId });
  } catch (err) {
    console.error('Voice clone failed:', err.message);
    await sendFailureNotification(customerName, customerEmail, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// --- STEP 2: Synthesize speech with cloned voice ---
async function handleSynthesize(res, body) {
  const { modelId, voiceMessage, customerEmail, customerName, pollCount = 0 } = body;
  const apiKey = process.env.FISH_AUDIO_API_KEY;

  console.log(`🔊 Voice Synth #${pollCount} — ${customerName} (model: ${modelId})`);

  if (pollCount > MAX_POLLS) {
    await sendFailureNotification(customerName, customerEmail, 'Voice synthesis timed out');
    return res.status(200).json({ success: false, error: 'Timed out' });
  }

  try {
    const ttsResp = await fetch(`${FISH_API}/v1/tts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: voiceMessage,
        reference_id: modelId,
        format: 'mp3',
        latency: 'normal',
        normalize: true,
      }),
    });

    if (!ttsResp.ok) {
      const errText = await ttsResp.text();
      // If model not ready yet, retry
      if (ttsResp.status === 400 || ttsResp.status === 404 || ttsResp.status === 422) {
        console.log(`   Model not ready, retrying...`);
        await schedulePollViaQStash({ ...body, pollCount: pollCount + 1 }, '10s');
        return res.status(200).json({ status: 'waiting' });
      }
      throw new Error(`TTS failed (${ttsResp.status}): ${errText.substring(0, 300)}`);
    }

    const contentType = ttsResp.headers.get('content-type') || '';

    // If JSON response, it might be an error
    if (contentType.includes('application/json')) {
      const jsonResp = await ttsResp.json();
      throw new Error(`TTS returned JSON: ${JSON.stringify(jsonResp).substring(0, 300)}`);
    }

    // Got audio — upload to Vercel Blob
    const audioBuffer = Buffer.from(await ttsResp.arrayBuffer());
    console.log(`   ✅ Synthesized: ${audioBuffer.length} bytes`);

    const blob = await put(`voices/clone-${Date.now()}.mp3`, audioBuffer, {
      access: 'public',
      contentType: 'audio/mpeg',
    });

    console.log(`   ☁️ Uploaded to Blob: ${blob.url}`);

    // Send delivery email
    await sendDeliveryEmails(customerEmail, customerName, blob.url);

    return res.status(200).json({ success: true, audioUrl: blob.url });
  } catch (err) {
    console.error('Voice synthesis error:', err.message);
    await sendFailureNotification(customerName, customerEmail, err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
}

// --- Email ---
async function sendDeliveryEmails(customerEmail, customerName, audioUrl) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: customerEmail,
      subject: 'Their Voice Lives On ✨',
      html: buildDeliveryEmail(customerName, audioUrl),
    });
    console.log(`   📧 Delivered to ${customerEmail}`);
  } catch (e) {
    console.error('Delivery email error:', e.message);
  }

  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `✅ Voice Clone → ${escapeHtml(customerName)}`,
      html: `<p>Voice clone delivered to ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p><p><a href="${escapeHtml(audioUrl)}">Listen</a></p>`,
    });
  } catch (e) {
    console.error('Owner email error:', e.message);
  }
}

async function sendFailureNotification(customerName, customerEmail, errorMsg) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `⚠️ Voice Clone failed — ${escapeHtml(customerName)}`,
      html: `<p><strong>Failed:</strong> ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p><p>Error: ${escapeHtml(errorMsg)}</p><p>Please process manually.</p>`,
    });
  } catch (e) {
    console.error('Failure notification error:', e.message);
  }
}

function buildDeliveryEmail(customerName, audioUrl) {
  const name = escapeHtml(customerName) || 'there';
  const safeUrl = escapeHtml(audioUrl);
  return `
    <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #f8f4ee; padding: 40px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="font-family: 'Arial Black', sans-serif; font-size: 24px; letter-spacing: 3px; color: #1a1a1a; margin: 0;">ENVISION LEGACY</h1>
        <p style="color: #8b775a; font-style: italic; margin: 4px 0 0;">Where Memories Live Again</p>
      </div>
      <div style="background: white; padding: 32px; border-radius: 8px; border: 1px solid #e8e0d4;">
        <h2 style="color: #1a1a1a; margin-top: 0;">Their Voice Lives On, ${name} 🎙️</h2>
        <p style="color: #555; line-height: 1.7;">We've brought their voice back to life. Click below to listen to your personalized message spoken in their voice.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${safeUrl}" style="display: inline-block; background: #c4793a; color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 600;">Listen to Your Message</a>
        </div>
        <div style="background: #f8f4ee; padding: 16px; border-radius: 8px; border-left: 3px solid #c4793a;">
          <p style="margin: 0; color: #555; font-size: 14px;">
            <strong>Tips:</strong><br>
            • Right-click and "Save As" to download the audio<br>
            • Play it for family — they'll be amazed<br>
            • This link is permanent
          </p>
        </div>
        <p style="color: #c4793a; font-style: italic; margin-top: 20px;">With warmth,<br>The Envision Legacy Team</p>
      </div>
    </div>
  `;
}
