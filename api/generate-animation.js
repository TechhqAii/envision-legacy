import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// --- Google Veo via Gemini API ---
const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-fast-generate-001';

async function downloadImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = resp.headers.get('content-type') || 'image/jpeg';
  return { base64, mimeType: contentType };
}

async function createVeoTask(imageUrl, prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  // Download the image and convert to base64
  const { base64, mimeType } = await downloadImageAsBase64(imageUrl);

  const motionPrompt = prompt ||
    'Gentle lifelike motion as if reliving a cherished moment. Soft breathing, natural blinking, slight warm smile, subtle head movement. Preserve every detail of the person face, clothing, and background. Emotional and cinematic quality.';

  const resp = await fetch(`${GEMINI_API}/models/${VEO_MODEL}:generateVideos?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{
        prompt: motionPrompt,
        image: {
          bytesBase64Encoded: base64,
          mimeType: mimeType,
        },
      }],
      parameters: {
        aspectRatio: '16:9',
        sampleCount: 1,
        durationSeconds: 5,
        personGeneration: 'allow_adult',
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Veo API error:', resp.status, err);
    throw new Error(`Veo API error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  console.log('Veo response:', JSON.stringify(data).substring(0, 500));

  // The API returns an operation name for async polling
  const operationName = data.name || data.operationName;
  if (!operationName) {
    // Check if video was returned directly
    if (data.generatedSamples?.[0]?.video?.uri) {
      return { type: 'direct', videoUrl: data.generatedSamples[0].video.uri };
    }
    throw new Error('No operation name or video returned from Veo');
  }

  return { type: 'async', operationName };
}

async function pollForResult(operationName) {
  const apiKey = process.env.GEMINI_API_KEY;
  const maxAttempts = 60; // 5 minutes max (poll every 5s)

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const resp = await fetch(`${GEMINI_API}/${operationName}?key=${apiKey}`, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!resp.ok) {
      console.error(`Poll ${i + 1} failed: ${resp.status}`);
      continue;
    }

    const data = await resp.json();
    console.log(`Poll ${i + 1}: done=${data.done}`);

    if (data.done) {
      // Extract video URL from the response
      const video = data.response?.generatedSamples?.[0]?.video;
      if (video?.uri) {
        return video.uri;
      }
      // Alternative response format
      if (data.result?.generatedSamples?.[0]?.video?.uri) {
        return data.result.generatedSamples[0].video.uri;
      }
      // Check for errors
      if (data.error) {
        throw new Error(`Veo generation failed: ${JSON.stringify(data.error)}`);
      }
      throw new Error('Veo completed but no video URL found in response');
    }
  }

  throw new Error('Video generation timed out after 5 minutes');
}

// --- Main handler ---
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify internal secret
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const { imageUrl, customerEmail, customerName, prompt } = JSON.parse(Buffer.concat(chunks).toString());

  if (!imageUrl || !customerEmail) {
    return res.status(400).json({ error: 'Missing imageUrl or customerEmail' });
  }

  console.log(`🎬 Starting Veo animation for ${customerName} (${customerEmail})`);
  console.log(`   Image: ${imageUrl}`);
  console.log(`   Model: ${VEO_MODEL}`);

  try {
    // Step 1: Create animation task
    const result = await createVeoTask(imageUrl, prompt);

    let videoUrl;
    if (result.type === 'direct') {
      videoUrl = result.videoUrl;
    } else {
      console.log(`   Operation: ${result.operationName}`);
      // Step 2: Poll for result
      videoUrl = await pollForResult(result.operationName);
    }

    console.log(`   ✅ Animation complete: ${videoUrl}`);

    // Step 3: Send delivery email
    if (videoUrl) {
      await resend.emails.send({
        from: 'Envision Legacy <orders@envisionlegacy.com>',
        to: customerEmail,
        subject: 'Your Memory Has Come to Life! ✨',
        html: buildDeliveryEmail({ customerName, videoUrl }),
      });
      console.log(`   📧 Delivery email sent to ${customerEmail}`);

      // Notify owner
      await resend.emails.send({
        from: 'Envision Legacy <orders@envisionlegacy.com>',
        to: process.env.OWNER_EMAIL || 'orders@envisionlegacy.com',
        subject: `✅ Animation delivered to ${customerName}`,
        html: `<p>Animation generated and delivered via Veo (${VEO_MODEL}).</p><p><a href="${videoUrl}">View Video</a></p><p>Customer: ${customerName} (${customerEmail})</p>`,
      });
    }

    return res.status(200).json({ success: true, videoUrl });
  } catch (err) {
    console.error('Animation generation failed:', err);

    // Notify owner of failure
    try {
      await resend.emails.send({
        from: 'Envision Legacy <orders@envisionlegacy.com>',
        to: process.env.OWNER_EMAIL || 'orders@envisionlegacy.com',
        subject: `⚠️ Animation failed for ${customerName}`,
        html: `<p>Veo animation generation failed.</p><p>Customer: ${customerName} (${customerEmail})</p><p>Image: <a href="${imageUrl}">View</a></p><p>Error: ${err.message}</p><p>Please generate manually and deliver.</p>`,
      });
    } catch (e) {
      console.error('Failed to send failure notification:', e);
    }

    return res.status(500).json({ error: 'Animation generation failed', details: err.message });
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
        <p style="color: #555; line-height: 1.7; margin-top: 20px;">
          Want to do more? <a href="https://envision-legacy.vercel.app/order.html" style="color: #c4793a;">Clone their voice</a> or <a href="https://envision-legacy.vercel.app/order.html?service=bundle" style="color: #c4793a;">get the full Legacy Bundle</a>.
        </p>
        <p style="color: #c4793a; font-style: italic;">With warmth,<br>The Envision Legacy Team</p>
      </div>
    </div>
  `;
}
