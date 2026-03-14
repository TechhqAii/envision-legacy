import { Resend } from 'resend';
import { put } from '@vercel/blob';

const resend = new Resend(process.env.RESEND_API_KEY);

// --- Google Veo via Gemini API ---
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';
const QSTASH_API = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2';
const MAX_POLLS = 24; // 24 × 15s = 6 min max
const BASE_URL = 'https://envision-legacy.vercel.app';

// --- Utilities ---

/** Escape HTML special chars to prevent XSS in email templates. */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Download Google-hosted video (requires API key) → re-upload to Vercel Blob (public). */
async function downloadAndReupload(googleVideoUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
  const resp = await fetch(googleVideoUrl, {
    headers: { 'x-goog-api-key': apiKey },
    redirect: 'follow',
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Video download failed (${resp.status}): ${err.substring(0, 200)}`);
  }

  const videoBuffer = Buffer.from(await resp.arrayBuffer());
  const blob = await put(`animations/veo-${Date.now()}.mp4`, videoBuffer, {
    access: 'public',
    contentType: 'video/mp4',
  });

  console.log(`   ☁️ Re-uploaded to Blob: ${blob.url} (${videoBuffer.length} bytes)`);
  return blob.url;
}

/** Download a customer image and return base64 + mime type. */
async function downloadImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Image download failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  return {
    base64: Buffer.from(buffer).toString('base64'),
    mimeType: resp.headers.get('content-type') || 'image/jpeg',
  };
}

/** Schedule a delayed poll via QStash. */
async function schedulePollViaQStash(payload) {
  const resp = await fetch(`${QSTASH_API}/publish/${BASE_URL}/api/generate-animation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Delay': '15s',
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

// --- Main handler ---

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', BASE_URL);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth check
  if (req.headers.authorization !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse body safely
  let body;
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { operationName } = body;
  if (operationName) return handlePoll(res, body);
  return handleStart(res, body);
}

// --- START: submit image to Veo ---

async function handleStart(res, body) {
  const { imageUrl, customerEmail, customerName, prompt } = body;

  if (!imageUrl || !customerEmail) {
    return res.status(400).json({ error: 'Missing imageUrl or customerEmail' });
  }

  console.log(`🎬 Veo START — ${customerName} (${customerEmail})`);

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

    const { base64, mimeType } = await downloadImageAsBase64(imageUrl);

    const motionPrompt = prompt ||
      'Gentle lifelike motion as if reliving a cherished moment. Soft breathing, natural blinking, slight warm smile, subtle head movement. Preserve every detail of the person face, clothing, and background. Emotional and cinematic quality.';

    const veoResp = await fetch(`${GEMINI_API}/models/${VEO_MODEL}:predictLongRunning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        instances: [{
          prompt: motionPrompt,
          image: { bytesBase64Encoded: base64, mimeType },
        }],
      }),
    });

    if (!veoResp.ok) {
      const errText = await veoResp.text();
      throw new Error(`Veo API ${veoResp.status}: ${errText.substring(0, 300)}`);
    }

    const data = await veoResp.json();
    return await processVeoResponse(data, customerEmail, customerName, imageUrl, res);
  } catch (err) {
    console.error('Animation start failed:', err.message);
    await sendFailureNotification(customerName, customerEmail, imageUrl, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// --- Process Veo response (shared by start + poll) ---

async function processVeoResponse(data, customerEmail, customerName, imageUrl, res) {
  // Check for immediate completion
  const directUri =
    data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
    data.generatedSamples?.[0]?.video?.uri;

  if (directUri) {
    console.log(`   ✅ Video ready immediately`);
    const publicUrl = await downloadAndReupload(directUri);
    await sendDeliveryEmails(customerEmail, customerName, publicUrl);
    return res.status(200).json({ success: true, videoUrl: publicUrl });
  }

  // Otherwise, start polling
  const opName = data.name || data.operationName;
  if (!opName) throw new Error('No operation name returned from Veo');

  console.log(`   ⏳ Operation: ${opName}`);
  await schedulePollViaQStash({
    operationName: opName,
    customerEmail,
    customerName,
    imageUrl,
    pollCount: 1,
  });

  return res.status(200).json({ success: true, status: 'processing' });
}

// --- POLL: check operation status ---

async function handlePoll(res, body) {
  const { operationName, customerEmail, customerName, imageUrl, pollCount = 0 } = body;
  const apiKey = process.env.GEMINI_API_KEY;

  console.log(`🔄 Poll #${pollCount} — ${customerName}`);

  if (pollCount > MAX_POLLS) {
    await sendFailureNotification(customerName, customerEmail, imageUrl, 'Timed out after 6 minutes');
    return res.status(200).json({ success: false, error: 'Timed out' });
  }

  try {
    const resp = await fetch(`${GEMINI_API}/${operationName}`, {
      headers: { 'x-goog-api-key': apiKey },
    });

    if (!resp.ok) {
      // Transient failure — retry
      await schedulePollViaQStash({ ...body, pollCount: pollCount + 1 });
      return res.status(200).json({ status: 'retrying' });
    }

    const data = await resp.json();

    if (data.done) {
      if (data.error) throw new Error(`Veo: ${JSON.stringify(data.error)}`);

      const videoUrl =
        data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        data.response?.generatedSamples?.[0]?.video?.uri;

      if (!videoUrl) throw new Error('Veo completed but no video URI');

      console.log(`   ✅ Animation complete`);
      const publicUrl = await downloadAndReupload(videoUrl);
      await sendDeliveryEmails(customerEmail, customerName, publicUrl);
      return res.status(200).json({ success: true, videoUrl: publicUrl });
    }

    // Not done — schedule next poll
    await schedulePollViaQStash({ ...body, pollCount: pollCount + 1 });
    return res.status(200).json({ status: 'polling', pollCount: pollCount + 1 });
  } catch (err) {
    console.error(`Poll #${pollCount} error:`, err.message);
    await sendFailureNotification(customerName, customerEmail, imageUrl, err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
}

// --- Email ---

async function sendDeliveryEmails(customerEmail, customerName, videoUrl) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: customerEmail,
      subject: 'Your Memory Has Come to Life! ✨',
      html: buildDeliveryEmail(customerName, videoUrl),
    });
    console.log(`   📧 Delivered to ${customerEmail}`);
  } catch (e) {
    console.error('Delivery email error:', e.message);
  }

  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `✅ Animation → ${escapeHtml(customerName)}`,
      html: `<p>Animation delivered to ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p><p><a href="${escapeHtml(videoUrl)}">View Video</a></p>`,
    });
  } catch (e) {
    console.error('Owner email error:', e.message);
  }
}

async function sendFailureNotification(customerName, customerEmail, imageUrl, errorMsg) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `⚠️ Animation failed — ${escapeHtml(customerName)}`,
      html: `<p><strong>Failed:</strong> ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p><p>Image: <a href="${escapeHtml(imageUrl)}">View</a></p><p>Error: ${escapeHtml(errorMsg)}</p><p>Please generate manually.</p>`,
    });
  } catch (e) {
    console.error('Failure notification error:', e.message);
  }
}

function buildDeliveryEmail(customerName, videoUrl) {
  const name = escapeHtml(customerName) || 'there';
  const safeUrl = escapeHtml(videoUrl);
  return `
    <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #f8f4ee; padding: 40px; border-radius: 12px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="font-family: 'Arial Black', sans-serif; font-size: 24px; letter-spacing: 3px; color: #1a1a1a; margin: 0;">ENVISION LEGACY</h1>
        <p style="color: #8b775a; font-style: italic; margin: 4px 0 0;">Where Memories Live Again</p>
      </div>
      <div style="background: white; padding: 32px; border-radius: 8px; border: 1px solid #e8e0d4;">
        <h2 style="color: #1a1a1a; margin-top: 0;">Your Memory is Alive, ${name}! ✨</h2>
        <p style="color: #555; line-height: 1.7;">We have brought your photo to life with AI. Click below to download your animated memory.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${safeUrl}" style="display: inline-block; background: #c4793a; color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 600;">Download Your Video</a>
        </div>
        <p style="color: #c4793a; font-style: italic; margin-top: 20px;">With warmth,<br>The Envision Legacy Team</p>
      </div>
    </div>
  `;
}
