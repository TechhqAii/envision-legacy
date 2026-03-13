import { Resend } from 'resend';
import { put } from '@vercel/blob';

const resend = new Resend(process.env.RESEND_API_KEY);

// --- Google Veo via Gemini API ---
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';
const QSTASH_API = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2';
const MAX_POLLS = 24;

// Download video from Google (requires API key) and re-upload to Vercel Blob (public)
async function downloadAndReupload(googleVideoUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log(`   📥 Downloading video from Google...`);
  
  // Google video URLs need the API key in the header
  const resp = await fetch(googleVideoUrl, {
    headers: { 'x-goog-api-key': apiKey },
    redirect: 'follow',
  });
  
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`   Video download failed: ${resp.status}`, err);
    throw new Error(`Video download failed: ${resp.status}`);
  }
  
  const videoBuffer = Buffer.from(await resp.arrayBuffer());
  console.log(`   Downloaded ${videoBuffer.length} bytes`);
  
  // Upload to Vercel Blob
  const filename = `animations/veo-${Date.now()}.mp4`;
  const blob = await put(filename, videoBuffer, {
    access: 'public',
    contentType: 'video/mp4',
  });
  
  console.log(`   ☁️ Uploaded to Vercel Blob: ${blob.url}`);
  return blob.url;
}

async function downloadImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  return { base64, mimeType: contentType };
}

async function schedulePollViaQStash(payload) {
  const baseUrl = 'https://envision-legacy.vercel.app';
  const resp = await fetch(`${QSTASH_API}/publish/${baseUrl}/api/generate-animation`, {
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
    console.error('QStash publish error:', resp.status, err);
    throw new Error(`QStash error: ${resp.status}`);
  }
  const data = await resp.json();
  console.log(`   📬 Scheduled poll via QStash (messageId: ${data.messageId})`);
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const { imageUrl, customerEmail, customerName, prompt, operationName, pollCount = 0 } = body;

  if (operationName) return handlePoll(req, res, body);

  if (!imageUrl || !customerEmail) {
    return res.status(400).json({ error: 'Missing imageUrl or customerEmail' });
  }

  console.log(`🎬 Starting Veo animation for ${customerName} (${customerEmail})`);
  console.log(`   Image: ${imageUrl}`);
  console.log(`   Model: ${VEO_MODEL}`);

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const { base64, mimeType } = await downloadImageAsBase64(imageUrl);
    console.log(`   Downloaded: ${base64.length} chars base64, ${mimeType}`);

    const motionPrompt = prompt ||
      'Gentle lifelike motion as if reliving a cherished moment. Soft breathing, natural blinking, slight warm smile, subtle head movement. Preserve every detail of the person face, clothing, and background. Emotional and cinematic quality.';

    // Try bytesBase64Encoded format (Vertex-style, used by predictLongRunning)
    const requestBody = {
      instances: [{
        prompt: motionPrompt,
        image: {
          bytesBase64Encoded: base64,
          mimeType: mimeType,
        },
      }],
    };

    console.log(`   📤 Submitting to Veo (bytesBase64Encoded format)...`);
    const veoResp = await fetch(`${GEMINI_API}/models/${VEO_MODEL}:predictLongRunning`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    if (!veoResp.ok) {
      const errText = await veoResp.text();
      console.error(`Veo API error (${veoResp.status}):`, errText);

      // If bytesBase64Encoded fails, try with imageBytes format
      if (veoResp.status === 400) {
        console.log(`   🔄 Retrying with imageBytes format...`);
        const retryBody = {
          instances: [{
            prompt: motionPrompt,
            image: {
              imageBytes: base64,
              mimeType: mimeType,
            },
          }],
        };

        const retryResp = await fetch(`${GEMINI_API}/models/${VEO_MODEL}:predictLongRunning`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(retryBody),
        });

        if (!retryResp.ok) {
          const retryErr = await retryResp.text();
          console.error(`Retry also failed (${retryResp.status}):`, retryErr);
          throw new Error(`Veo API error ${retryResp.status}: ${retryErr}`);
        }

        const retryData = await retryResp.json();
        console.log('Veo retry response:', JSON.stringify(retryData).substring(0, 300));
        return await processVeoResponse(retryData, customerEmail, customerName, imageUrl, res);
      }

      throw new Error(`Veo API error ${veoResp.status}: ${errText}`);
    }

    const data = await veoResp.json();
    console.log('Veo response:', JSON.stringify(data).substring(0, 300));
    return await processVeoResponse(data, customerEmail, customerName, imageUrl, res);
  } catch (err) {
    console.error('Animation start failed:', err);
    await sendFailureNotification(customerName, customerEmail, imageUrl, err.message);
    return res.status(500).json({ error: 'Animation start failed', details: err.message });
  }
}

async function processVeoResponse(data, customerEmail, customerName, imageUrl, res) {
  // Check for direct result
  const directUri =
    data.generatedSamples?.[0]?.video?.uri ||
    data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (directUri) {
    console.log(`   ✅ Video returned directly: ${directUri}`);
    const publicUrl = await downloadAndReupload(directUri);
    await sendDeliveryEmails(customerEmail, customerName, publicUrl);
    return res.status(200).json({ success: true, videoUrl: publicUrl });
  }

  const opName = data.name || data.operationName;
  if (!opName) throw new Error('No operation name or video returned from Veo');

  console.log(`   ⏳ Operation started: ${opName}`);
  await schedulePollViaQStash({
    operationName: opName,
    customerEmail,
    customerName,
    imageUrl,
    pollCount: 1,
  });

  return res.status(200).json({ success: true, status: 'processing', operationName: opName });
}

async function handlePoll(req, res, body) {
  const { operationName, customerEmail, customerName, imageUrl, pollCount = 0 } = body;
  const apiKey = process.env.GEMINI_API_KEY;

  console.log(`🔄 Poll #${pollCount} for ${customerName} — ${operationName}`);

  if (pollCount > MAX_POLLS) {
    console.error(`   ❌ Max polls exceeded`);
    await sendFailureNotification(customerName, customerEmail, imageUrl, 'Timed out after 6 minutes');
    return res.status(200).json({ success: false, error: 'Timed out' });
  }

  try {
    const resp = await fetch(`${GEMINI_API}/${operationName}`, {
      headers: { 'x-goog-api-key': apiKey },
    });

    if (!resp.ok) {
      console.error(`   Poll failed: ${resp.status}`);
      await schedulePollViaQStash({ ...body, pollCount: pollCount + 1 });
      return res.status(200).json({ status: 'retrying' });
    }

    const data = await resp.json();
    console.log(`   Status: done=${data.done}`);

    if (data.done) {
      if (data.error) throw new Error(`Veo error: ${JSON.stringify(data.error)}`);

      const videoUrl =
        data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        data.response?.generatedSamples?.[0]?.video?.uri;

      if (!videoUrl) throw new Error('Veo completed but no video URL found');

      console.log(`   ✅ Animation complete: ${videoUrl}`);
      const publicUrl = await downloadAndReupload(videoUrl);
      await sendDeliveryEmails(customerEmail, customerName, publicUrl);
      return res.status(200).json({ success: true, videoUrl: publicUrl });
    }

    console.log(`   ⏳ Not ready, scheduling poll #${pollCount + 1}...`);
    await schedulePollViaQStash({ ...body, pollCount: pollCount + 1 });
    return res.status(200).json({ status: 'polling', pollCount: pollCount + 1 });
  } catch (err) {
    console.error(`   Poll error:`, err);
    await sendFailureNotification(customerName, customerEmail, imageUrl, err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
}

// --- Email helpers ---
async function sendDeliveryEmails(customerEmail, customerName, videoUrl) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: customerEmail,
      subject: 'Your Memory Has Come to Life! ✨',
      html: buildDeliveryEmail({ customerName, videoUrl }),
    });
    console.log(`   📧 Delivery email sent to ${customerEmail}`);
  } catch (e) {
    console.error('Delivery email failed:', e);
  }
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `✅ Animation delivered to ${customerName}`,
      html: `<p>Animation delivered.</p><p><a href="${videoUrl}">View Video</a></p><p>Customer: ${customerName} (${customerEmail})</p>`,
    });
  } catch (e) {
    console.error('Owner notification failed:', e);
  }
}

async function sendFailureNotification(customerName, customerEmail, imageUrl, errorMsg) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `⚠️ Animation failed for ${customerName}`,
      html: `<p>Animation failed.</p><p>Customer: ${customerName} (${customerEmail})</p><p>Image: <a href="${imageUrl}">View</a></p><p>Error: ${errorMsg}</p><p>Please generate manually.</p>`,
    });
  } catch (e) {
    console.error('Failure notification failed:', e);
  }
}

function buildDeliveryEmail({ customerName, videoUrl }) {
  const name = customerName || 'there';
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
          <a href="${videoUrl}" style="display: inline-block; background: #c4793a; color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 600;">Download Your Video</a>
        </div>
        <p style="color: #c4793a; font-style: italic; margin-top: 20px;">With warmth,<br>The Envision Legacy Team</p>
      </div>
    </div>
  `;
}
