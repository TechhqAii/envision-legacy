import { GoogleGenAI } from '@google/genai';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';
const QSTASH_API = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2';
const MAX_POLLS = 24; // 24 polls × 15s delay = 6 minutes max

async function downloadImageAsBuffer(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  return { buffer: Buffer.from(buffer), mimeType: contentType };
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

// --- Main handler (handles both START and POLL) ---
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify auth
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  const { imageUrl, customerEmail, customerName, prompt, operationName, pollCount = 0 } = body;

  // --- POLL MODE ---
  if (operationName) {
    return handlePoll(req, res, body);
  }

  // --- START MODE ---
  if (!imageUrl || !customerEmail) {
    return res.status(400).json({ error: 'Missing imageUrl or customerEmail' });
  }

  console.log(`🎬 Starting Veo animation for ${customerName} (${customerEmail})`);
  console.log(`   Image: ${imageUrl}`);
  console.log(`   Model: ${VEO_MODEL}`);

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    // Download image
    const { buffer, mimeType } = await downloadImageAsBuffer(imageUrl);
    console.log(`   Downloaded image: ${buffer.length} bytes, ${mimeType}`);

    const motionPrompt = prompt ||
      'Gentle lifelike motion as if reliving a cherished moment. Soft breathing, natural blinking, slight warm smile, subtle head movement. Preserve every detail of the person face, clothing, and background. Emotional and cinematic quality.';

    // Use Google AI SDK to generate video
    const ai = new GoogleGenAI({ apiKey });

    console.log(`   📤 Submitting to Veo via SDK...`);
    let operation = await ai.models.generateVideos({
      model: VEO_MODEL,
      prompt: motionPrompt,
      image: {
        imageBytes: buffer.toString('base64'),
        mimeType: mimeType,
      },
    });

    console.log(`   Veo response: done=${operation.done}, name=${operation.name}`);

    // Check if done immediately (unlikely but possible)
    if (operation.done) {
      const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (videoUri) {
        console.log(`   ✅ Video returned immediately: ${videoUri}`);
        await sendDeliveryEmails(customerEmail, customerName, videoUri);
        return res.status(200).json({ success: true, videoUrl: videoUri });
      }
    }

    // Get operation name for polling
    const opName = operation.name;
    if (!opName) {
      throw new Error('No operation name returned from Veo');
    }

    console.log(`   ⏳ Operation started: ${opName}`);
    console.log(`   Scheduling first poll via QStash...`);

    await schedulePollViaQStash({
      operationName: opName,
      customerEmail,
      customerName,
      imageUrl,
      pollCount: 1,
    });

    return res.status(200).json({ success: true, status: 'processing', operationName: opName });
  } catch (err) {
    console.error('Animation start failed:', err);
    await sendFailureNotification(customerName, customerEmail, imageUrl, err.message);
    return res.status(500).json({ error: 'Animation start failed', details: err.message });
  }
}

// --- POLL handler ---
async function handlePoll(req, res, body) {
  const { operationName, customerEmail, customerName, imageUrl, pollCount = 0 } = body;
  const apiKey = process.env.GEMINI_API_KEY;

  console.log(`🔄 Poll #${pollCount} for ${customerName} — ${operationName}`);

  if (pollCount > MAX_POLLS) {
    console.error(`   ❌ Max polls exceeded`);
    await sendFailureNotification(customerName, customerEmail, imageUrl, 'Animation timed out after 6 minutes');
    return res.status(200).json({ success: false, error: 'Timed out' });
  }

  try {
    const ai = new GoogleGenAI({ apiKey });

    // Poll operation status using SDK
    let operation = await ai.operations.getVideosOperation({
      operation: { name: operationName },
    });

    console.log(`   Status: done=${operation.done}`);

    if (operation.done) {
      if (operation.error) {
        throw new Error(`Veo error: ${JSON.stringify(operation.error)}`);
      }

      const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (!videoUri) {
        throw new Error('Veo completed but no video URI found');
      }

      console.log(`   ✅ Animation complete: ${videoUri}`);
      await sendDeliveryEmails(customerEmail, customerName, videoUri);
      return res.status(200).json({ success: true, videoUrl: videoUri });
    }

    // Not done — schedule another poll
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
      html: `<p>Animation generated and delivered.</p><p><a href="${videoUrl}">View Video</a></p><p>Customer: ${customerName} (${customerEmail})</p>`,
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
        <p style="color: #555; line-height: 1.7;">
          We have brought your photo to life with AI. Click below to download your animated memory.
        </p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${videoUrl}" style="display: inline-block; background: #c4793a; color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 600; letter-spacing: 0.5px;">
            Download Your Video
          </a>
        </div>
        <div style="background: #f8f4ee; padding: 16px; border-radius: 8px; border-left: 3px solid #c4793a;">
          <p style="margin: 0; color: #555; font-size: 14px;">
            <strong>Tips:</strong><br>
            • Right-click the video to save it to your device<br>
            • Share it with family — they will love it<br>
            • This link expires in 30 days
          </p>
        </div>
        <p style="color: #c4793a; font-style: italic; margin-top: 20px;">With warmth,<br>The Envision Legacy Team</p>
      </div>
    </div>
  `;
}
