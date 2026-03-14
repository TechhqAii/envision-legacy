import { Resend } from 'resend';
import { put } from '@vercel/blob';

const resend = new Resend(process.env.RESEND_API_KEY);
const HEYGEN_API = 'https://api.heygen.com';
const HEYGEN_UPLOAD = 'https://upload.heygen.com';
const QSTASH_API = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2';
const BASE_URL = 'https://envision-legacy.vercel.app';
const MAX_POLLS = 60;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function schedulePoll(payload, delaySec = '10s') {
  const resp = await fetch(`${QSTASH_API}/publish/${BASE_URL}/api/generate-avatar`, {
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

// --- Normalize MIME types for HeyGen ---
function normalizeContentType(contentType) {
  const map = {
    'audio/wav': 'audio/x-wav',
    'audio/wave': 'audio/x-wav',
    'audio/mpeg': 'audio/mpeg',
    'audio/mp3': 'audio/mpeg',
    'image/jpeg': 'image/jpeg',
    'image/jpg': 'image/jpeg',
    'image/png': 'image/png',
    'image/webp': 'image/webp',
  };
  const base = contentType.split(';')[0].trim().toLowerCase();
  return map[base] || base;
}

// --- Upload asset to HeyGen ---
async function uploadAssetToHeyGen(apiKey, buffer, filename, contentType) {
  const normalizedType = normalizeContentType(contentType);
  console.log(`   Content-Type: ${contentType} → ${normalizedType}`);

  const resp = await fetch(`${HEYGEN_UPLOAD}/v1/asset`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': normalizedType,
    },
    body: buffer,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Asset upload failed (${resp.status}): ${errText.substring(0, 300)}`);
  }

  const data = await resp.json();
  console.log(`   Upload response: ${JSON.stringify(data).substring(0, 200)}`);
  return data.data?.id || data.data?.asset_id || data.data?.talking_photo_id;
}

// ===== MAIN HANDLER =====
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

  // Route based on phase
  const { phase, videoId } = body;
  if (phase === 'poll_avatar') return handlePollAvatar(res, body);
  if (phase === 'poll_video' || videoId) return handlePollVideo(res, body);
  return handleGenerateAvatar(res, body);
}

// ===== PHASE 1: Upload audio, create Photo Avatar, schedule polls =====
async function handleGenerateAvatar(res, body) {
  const { audioUrl, photoUrl, customerEmail, customerName } = body;

  if (!audioUrl || !photoUrl || !customerEmail) {
    return res.status(400).json({ error: 'Missing audioUrl, photoUrl, or customerEmail' });
  }

  console.log(`🎭 Avatar Generation START — ${customerName} (${customerEmail})`);
  const apiKey = process.env.HEYGEN_API_KEY;
  if (!apiKey) {
    await sendFailureNotification(customerName, customerEmail, 'HEYGEN_API_KEY not configured');
    return res.status(500).json({ error: 'HeyGen not configured' });
  }

  try {
    // 1. Download and upload audio to HeyGen
    console.log(`   📥 Downloading audio: ${audioUrl}`);
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw new Error(`Audio download failed: ${audioResp.status}`);
    const audioBuffer = Buffer.from(await audioResp.arrayBuffer());
    const audioType = audioResp.headers.get('content-type') || 'audio/wav';
    console.log(`   Downloaded audio: ${audioBuffer.length} bytes (${audioType})`);

    console.log(`   📤 Uploading audio to HeyGen...`);
    const audioAssetId = await uploadAssetToHeyGen(apiKey, audioBuffer, 'audio.wav', audioType);
    console.log(`   ✅ Audio asset: ${audioAssetId}`);

    // 2. Create Photo Avatar using the photo URL directly
    //    The HeyGen v2 Photo Avatar API accepts image_url
    console.log(`   📸 Creating Photo Avatar from: ${photoUrl}`);
    const createResp = await fetch(`${HEYGEN_API}/v2/photo_avatar`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        image_url: photoUrl,
      }),
    });

    const createText = await createResp.text();
    console.log(`   Photo Avatar API (${createResp.status}): ${createText.substring(0, 400)}`);

    if (!createResp.ok) {
      throw new Error(`Photo Avatar creation failed (${createResp.status}): ${createText.substring(0, 400)}`);
    }

    const createData = JSON.parse(createText);
    // Extract IDs from the response
    const photoAvatarId = createData.data?.photo_avatar_id || createData.data?.avatar_id || createData.data?.id;
    const generationId = createData.data?.generation_id;
    const lookId = createData.data?.look_id;

    console.log(`   ✅ Photo Avatar response: avatar=${photoAvatarId}, generation=${generationId}, look=${lookId}`);

    // If we already got a look_id, we can go straight to video generation
    if (lookId) {
      console.log(`   🎬 Look ready, proceeding to video generation...`);
      await schedulePoll({
        phase: 'generate_video',
        photoAvatarId,
        lookId,
        audioAssetId,
        customerEmail,
        customerName,
      }, '5s');
    } else {
      // Need to poll for the photo avatar to be ready
      await schedulePoll({
        phase: 'poll_avatar',
        photoAvatarId,
        generationId,
        audioAssetId,
        customerEmail,
        customerName,
        pollCount: 1,
      }, '15s');
    }

    return res.status(200).json({ success: true, status: 'creating_avatar', photoAvatarId });
  } catch (err) {
    console.error('Avatar generation failed:', err.message);
    await sendFailureNotification(customerName, customerEmail, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ===== PHASE 2: Poll for Photo Avatar readiness, then generate video =====
async function handlePollAvatar(res, body) {
  const { photoAvatarId, generationId, audioAssetId, customerEmail, customerName, pollCount = 0 } = body;
  const apiKey = process.env.HEYGEN_API_KEY;

  console.log(`📸 Photo Avatar Poll #${pollCount} — ${customerName} (avatar: ${photoAvatarId})`);

  if (pollCount > MAX_POLLS) {
    await sendFailureNotification(customerName, customerEmail, 'Photo Avatar creation timed out');
    return res.status(200).json({ success: false, error: 'Timed out' });
  }

  try {
    // Check photo avatar generation status
    const checkUrl = generationId
      ? `${HEYGEN_API}/v2/photo_avatar/generation_status?generation_id=${generationId}`
      : `${HEYGEN_API}/v2/photo_avatar/${photoAvatarId}`;

    const statusResp = await fetch(checkUrl, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'x-api-key': apiKey,
      },
    });

    const statusText = await statusResp.text();
    console.log(`   Status response (${statusResp.status}): ${statusText.substring(0, 300)}`);

    const statusData = JSON.parse(statusText);
    const status = statusData.data?.status;
    const lookId = statusData.data?.look_id || statusData.data?.looks?.[0]?.id;

    if ((status === 'completed' || status === 'ready' || status === 'success') && (lookId || photoAvatarId)) {
      // Photo avatar is ready — generate the video
      console.log(`   ✅ Photo Avatar ready! look_id=${lookId}`);
      await schedulePoll({
        phase: 'generate_video',
        photoAvatarId,
        lookId: lookId || photoAvatarId,
        audioAssetId,
        customerEmail,
        customerName,
      }, '3s');
      return res.status(200).json({ status: 'avatar_ready', lookId });
    } else if (status === 'failed' || status === 'error') {
      throw new Error(`Photo Avatar creation failed: ${statusText.substring(0, 300)}`);
    } else {
      // Still processing
      console.log(`   ⏳ Photo Avatar status: ${status || 'unknown'}, polling again...`);
      await schedulePoll({
        ...body,
        pollCount: pollCount + 1,
      }, '10s');
      return res.status(200).json({ status: 'processing' });
    }
  } catch (err) {
    console.error('Photo Avatar poll error:', err.message);
    await sendFailureNotification(customerName, customerEmail, err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
}

// ===== PHASE 3: Generate video using Photo Avatar =====
async function handleGenerateVideo(res, body) {
  const { photoAvatarId, lookId, audioAssetId, customerEmail, customerName } = body;
  const apiKey = process.env.HEYGEN_API_KEY;

  console.log(`🎬 Video Generation — ${customerName} (avatar: ${photoAvatarId}, look: ${lookId})`);

  try {
    const videoGenResp = await fetch(`${HEYGEN_API}/v2/video/generate`, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        video_inputs: [
          {
            character: {
              type: 'photo_avatar',
              photo_avatar_id: photoAvatarId,
              look_id: lookId,
            },
            voice: {
              type: 'audio',
              audio_asset_id: audioAssetId,
            },
          },
        ],
        dimension: {
          width: 512,
          height: 512,
        },
      }),
    });

    const genText = await videoGenResp.text();
    console.log(`   Video generate response (${videoGenResp.status}): ${genText.substring(0, 400)}`);

    if (!videoGenResp.ok) {
      throw new Error(`Video generation failed (${videoGenResp.status}): ${genText.substring(0, 400)}`);
    }

    const videoGenData = JSON.parse(genText);
    const newVideoId = videoGenData.data?.video_id;

    if (!newVideoId) {
      throw new Error(`No video_id in response: ${genText.substring(0, 300)}`);
    }

    console.log(`   ✅ Video generation started: ${newVideoId}`);

    // Schedule polling for video completion
    await schedulePoll({
      phase: 'poll_video',
      videoId: newVideoId,
      customerEmail,
      customerName,
      pollCount: 1,
    }, '30s');

    return res.status(200).json({ success: true, status: 'generating_video', videoId: newVideoId });
  } catch (err) {
    console.error('Video generation failed:', err.message);
    await sendFailureNotification(customerName, customerEmail, err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
}

// ===== PHASE 4: Poll for video completion =====
async function handlePollVideo(res, body) {
  const { videoId, customerEmail, customerName, pollCount = 0 } = body;
  const apiKey = process.env.HEYGEN_API_KEY;

  // Handle generate_video phase (not a poll — actually generates the video)
  if (body.phase === 'generate_video') {
    return handleGenerateVideo(res, body);
  }

  console.log(`🎬 Video Poll #${pollCount} — ${customerName} (video: ${videoId})`);

  if (pollCount > MAX_POLLS) {
    await sendFailureNotification(customerName, customerEmail, 'Avatar video generation timed out');
    return res.status(200).json({ success: false, error: 'Timed out' });
  }

  try {
    const statusResp = await fetch(
      `${HEYGEN_API}/v1/video_status.get?video_id=${videoId}`,
      {
        method: 'GET',
        headers: {
          'accept': 'application/json',
          'x-api-key': apiKey,
        },
      }
    );

    if (!statusResp.ok) {
      const errText = await statusResp.text();
      throw new Error(`Status check failed (${statusResp.status}): ${errText.substring(0, 300)}`);
    }

    const statusData = await statusResp.json();
    const status = statusData.data?.status;
    const videoUrl = statusData.data?.video_url;

    console.log(`   Status: ${status}`);

    if (status === 'completed' && videoUrl) {
      console.log(`   🎥 Video ready! Downloading...`);

      const videoResp = await fetch(videoUrl);
      if (!videoResp.ok) throw new Error(`Video download failed: ${videoResp.status}`);
      const videoBuffer = Buffer.from(await videoResp.arrayBuffer());
      console.log(`   Downloaded: ${videoBuffer.length} bytes`);

      // Upload to Vercel Blob
      const blob = await put(`avatars/avatar-${Date.now()}.mp4`, videoBuffer, {
        access: 'public',
        contentType: 'video/mp4',
      });
      console.log(`   ☁️ Uploaded to Blob: ${blob.url}`);

      // Send delivery email
      await sendDeliveryEmails(customerEmail, customerName, blob.url);

      return res.status(200).json({ success: true, videoUrl: blob.url });
    } else if (status === 'failed') {
      const errorMsg = statusData.data?.error || 'Video generation failed';
      throw new Error(errorMsg);
    } else {
      await schedulePoll({
        ...body,
        pollCount: pollCount + 1,
      }, '10s');
      return res.status(200).json({ status: 'processing' });
    }
  } catch (err) {
    console.error('Video poll error:', err.message);
    await sendFailureNotification(customerName, customerEmail, err.message);
    return res.status(200).json({ success: false, error: err.message });
  }
}

// ===== EMAIL =====
async function sendDeliveryEmails(customerEmail, customerName, videoUrl) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: customerEmail,
      subject: 'They Live Again ✨ Your AI Avatar is Ready',
      html: buildDeliveryEmail(customerName, videoUrl),
    });
    console.log(`   📧 Avatar delivered to ${customerEmail}`);
  } catch (e) {
    console.error('Delivery email error:', e.message);
  }

  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `✅ Avatar → ${escapeHtml(customerName)}`,
      html: `<p>Avatar video delivered to ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p><p><a href="${escapeHtml(videoUrl)}">Watch Video</a></p>`,
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
      subject: `⚠️ Avatar failed — ${escapeHtml(customerName)}`,
      html: `<p><strong>Failed:</strong> ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p><p>Error: ${escapeHtml(errorMsg)}</p><p>Please process manually.</p>`,
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
        <h2 style="color: #1a1a1a; margin-top: 0;">They Live Again, ${name} 🎥</h2>
        <p style="color: #555; line-height: 1.7;">Something incredible awaits you. We've brought them back — not just their voice, but their face, their expressions, their presence. Click below to watch your personalized AI avatar video.</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${safeUrl}" style="display: inline-block; background: #c4793a; color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 600;">Watch Your Avatar Video</a>
        </div>
        <div style="background: #f8f4ee; padding: 16px; border-radius: 8px; border-left: 3px solid #c4793a;">
          <p style="margin: 0; color: #555; font-size: 14px;">
            <strong>Tips:</strong><br>
            • Right-click and "Save As" to download the video<br>
            • Share with family — they'll be speechless<br>
            • This link is permanent
          </p>
        </div>
        <p style="color: #c4793a; font-style: italic; margin-top: 20px;">With warmth,<br>The Envision Legacy Team</p>
      </div>
    </div>
  `;
}
