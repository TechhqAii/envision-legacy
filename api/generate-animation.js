import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// --- Provider: Runway ML Gen-4 Turbo ---
// Swap this section to use Kling, Luma, or any other provider.
// Just replace createAnimationTask() and pollForResult().

const RUNWAY_API = 'https://api.dev.runwayml.com/v1';

async function createAnimationTask(imageUrl, prompt) {
  const provider = process.env.ANIMATION_PROVIDER || 'runway';

  if (provider === 'runway') {
    return createRunwayTask(imageUrl, prompt);
  }
  // Future: add kling, luma, etc.
  throw new Error(`Unknown animation provider: ${provider}`);
}

async function createRunwayTask(imageUrl, prompt) {
  const resp = await fetch(`${RUNWAY_API}/image_to_video`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': '2024-11-06',
    },
    body: JSON.stringify({
      model: 'gen4_turbo',
      promptImage: imageUrl,
      promptText: prompt || 'Gentle subtle motion, bring the photo to life with natural movement, soft breathing, blinking eyes, slight head turn',
      duration: 5,
      ratio: '16:9',
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Runway API error:', resp.status, err);
    throw new Error(`Runway API error: ${resp.status}`);
  }

  const data = await resp.json();
  return data.id; // task ID for polling
}

async function pollForResult(taskId) {
  const maxAttempts = 60; // 5 minutes max (poll every 5s)

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 5000)); // wait 5s

    const resp = await fetch(`${RUNWAY_API}/tasks/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`,
        'X-Runway-Version': '2024-11-06',
      },
    });

    if (!resp.ok) continue;

    const data = await resp.json();
    console.log(`Poll ${i + 1}: status=${data.status}`);

    if (data.status === 'SUCCEEDED') {
      return data.output?.[0] || data.artifacts?.[0]?.url || null;
    }
    if (data.status === 'FAILED') {
      throw new Error(`Animation generation failed: ${data.failure || 'unknown error'}`);
    }
    // status === 'RUNNING' or 'PENDING' → keep polling
  }

  throw new Error('Animation generation timed out after 5 minutes');
}

// --- Main handler ---
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify internal secret (only webhook should call this)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { imageUrl, customerEmail, customerName, prompt } = req.body;

  if (!imageUrl || !customerEmail) {
    return res.status(400).json({ error: 'Missing imageUrl or customerEmail' });
  }

  console.log(`🎬 Starting animation for ${customerName} (${customerEmail})`);
  console.log(`   Image: ${imageUrl}`);

  try {
    // Step 1: Create animation task
    const taskId = await createAnimationTask(imageUrl, prompt);
    console.log(`   Task created: ${taskId}`);

    // Step 2: Poll for result
    const videoUrl = await pollForResult(taskId);
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
        html: `<p>Animation has been generated and delivered.</p><p><a href="${videoUrl}">View Video</a></p><p>Customer: ${customerName} (${customerEmail})</p>`,
      });
    }

    return res.status(200).json({ success: true, videoUrl });
  } catch (err) {
    console.error('Animation generation failed:', err);

    // Send failure notification to owner
    try {
      await resend.emails.send({
        from: 'Envision Legacy <orders@envisionlegacy.com>',
        to: process.env.OWNER_EMAIL || 'orders@envisionlegacy.com',
        subject: `⚠️ Animation failed for ${customerName}`,
        html: `<p>Animation generation failed.</p><p>Customer: ${customerName} (${customerEmail})</p><p>Image: <a href="${imageUrl}">View</a></p><p>Error: ${err.message}</p><p>Please generate manually and deliver.</p>`,
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
          We've brought your photo to life. Click the button below to download your animated memory.
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
            • Share it with family — they'll love it<br>
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
