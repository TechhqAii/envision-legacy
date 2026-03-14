import { Resend } from 'resend';
import { put } from '@vercel/blob';

const resend = new Resend(process.env.RESEND_API_KEY);

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const VEO_MODEL = process.env.VEO_MODEL || 'veo-3.1-fast-generate-preview';
const QSTASH_API = process.env.QSTASH_URL || 'https://qstash.upstash.io/v2';
const BASE_URL = 'https://envision-legacy.vercel.app';
const MAX_POLLS = 24;

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function schedulePoll(payload, delaySec = '15s') {
  const resp = await fetch(`${QSTASH_API}/publish/${BASE_URL}/api/generate-photobook`, {
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

async function downloadImageAsBase64(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Image download failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  return {
    base64: Buffer.from(buffer).toString('base64'),
    mimeType: resp.headers.get('content-type') || 'image/jpeg',
  };
}

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
  const blob = await put(`photobooks/veo-${Date.now()}.mp4`, videoBuffer, {
    access: 'public',
    contentType: 'video/mp4',
  });

  return blob.url;
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

  // Route based on phase
  const { phase } = body;
  if (phase === 'poll_animation') return handlePollAnimation(res, body);
  if (phase === 'start_next') return handleStartNextPhoto(res, body);
  if (phase === 'build_album') return handleBuildAlbum(res, body);
  return handleStartPhotoBook(res, body);
}

// ===== PHASE 1: Start animating each photo =====
async function handleStartPhotoBook(res, body) {
  const { photoUrls, albumTitle, customerEmail, customerName } = body;

  console.log(`📖 Photo Book START — ${customerName} (${customerEmail})`);
  console.log(`   Album: "${albumTitle}"`);

  let photos;
  try {
    photos = typeof photoUrls === 'string' ? JSON.parse(photoUrls) : photoUrls;
  } catch {
    return res.status(400).json({ error: 'Invalid photoUrls' });
  }

  if (!photos || !photos.length) {
    return res.status(400).json({ error: 'No photos provided' });
  }

  console.log(`   📸 ${photos.length} photos to animate`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  }

  // Start animation for the first photo
  // We process one at a time to stay within Vercel function time limits
  const currentPhoto = photos[0];
  const results = []; // will accumulate video URLs

  try {
    console.log(`   🎬 Starting animation for photo 1/${photos.length}: ${currentPhoto.caption}`);

    const { base64, mimeType } = await downloadImageAsBase64(currentPhoto.url);

    const motionPrompt = 'Gentle lifelike motion as if reliving a cherished moment. Soft breathing, natural blinking, slight warm smile, subtle head movement. Preserve every detail of the person face, clothing, and background. Emotional and cinematic quality.';

    const generateResp = await fetch(
      `${GEMINI_API}/models/${VEO_MODEL}:predictLongRunning`,
      {
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
      }
    );

    if (!generateResp.ok) {
      const errText = await generateResp.text();
      throw new Error(`Veo generation failed (${generateResp.status}): ${errText.substring(0, 300)}`);
    }

    const genData = await generateResp.json();

    // Check if the response has a video directly or needs polling
    const directUri =
      genData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
      genData.generatedSamples?.[0]?.video?.uri;

    if (directUri) {
      // Video returned immediately
      const videoUrl = await downloadAndReupload(directUri);
      results.push({ ...currentPhoto, videoUrl });
      console.log(`   ✅ Photo 1 animated immediately`);

      // Schedule next photo or build album
      if (photos.length > 1) {
        await schedulePoll({
          phase: 'start_next',
          photoIndex: 1,
          photos: JSON.stringify(photos),
          results: JSON.stringify(results),
          albumTitle,
          customerEmail,
          customerName,
        }, '5s');
      } else {
        await schedulePoll({
          phase: 'build_album',
          results: JSON.stringify(results),
          albumTitle,
          customerEmail,
          customerName,
        }, '5s');
      }
    } else {
      // Needs polling — extract operation name
      const opName = genData.name || genData.operationName;
      if (!opName) {
        throw new Error('No operation name or video in response');
      }

      console.log(`   ⏳ Operation: ${opName}`);
      await schedulePoll({
        phase: 'poll_animation',
        operationName: opName,
        photoIndex: 0,
        photos: JSON.stringify(photos),
        results: JSON.stringify(results),
        albumTitle,
        customerEmail,
        customerName,
        pollCount: 1,
      }, '15s');
    }

    return res.status(200).json({ success: true, status: 'processing' });
  } catch (err) {
    console.error('Photo book start failed:', err.message);
    await sendFailureNotification(customerName, customerEmail, err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ===== PHASE 2: Poll for animation completion, then start next photo =====
async function handlePollAnimation(res, body) {
  const { operationName, photoIndex, photos: photosStr, results: resultsStr,
          albumTitle, customerEmail, customerName, pollCount = 0 } = body;

  const apiKey = process.env.GEMINI_API_KEY;
  const photos = JSON.parse(photosStr);
  const results = JSON.parse(resultsStr);

  console.log(`📖 Photo Book Poll #${pollCount} — photo ${photoIndex + 1}/${photos.length}`);

  if (pollCount > MAX_POLLS) {
    // Skip this photo and move on
    console.log(`   ⏰ Timed out on photo ${photoIndex + 1}, skipping`);
    results.push({ ...photos[photoIndex], videoUrl: null, error: 'Timed out' });

    if (photoIndex + 1 < photos.length) {
      // Start next photo
      return handleStartNextPhoto(res, {
        photoIndex: photoIndex + 1,
        photos: photosStr,
        results: JSON.stringify(results),
        albumTitle, customerEmail, customerName,
      });
    } else {
      // Build album with what we have
      await schedulePoll({
        phase: 'build_album',
        results: JSON.stringify(results),
        albumTitle, customerEmail, customerName,
      }, '5s');
      return res.status(200).json({ status: 'building_album' });
    }
  }

  try {
    const statusResp = await fetch(
      `${GEMINI_API}/${operationName}`,
      { method: 'GET', headers: { 'x-goog-api-key': apiKey } }
    );

    if (!statusResp.ok) {
      const errText = await statusResp.text();
      throw new Error(`Status check failed (${statusResp.status}): ${errText.substring(0, 200)}`);
    }

    const statusData = await statusResp.json();

    if (statusData.done) {
      if (statusData.error) {
        throw new Error(`Veo error: ${JSON.stringify(statusData.error).substring(0, 200)}`);
      }

      // Check for video
      const videoUri =
        statusData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        statusData.response?.generatedSamples?.[0]?.video?.uri;

      if (videoUri) {
        const videoUrl = await downloadAndReupload(videoUri);
        results.push({ ...photos[photoIndex], videoUrl });
        console.log(`   ✅ Photo ${photoIndex + 1} animated: ${videoUrl.substring(0, 60)}...`);
      } else {
        results.push({ ...photos[photoIndex], videoUrl: null, error: 'No video in response' });
        console.log(`   ⚠️ Photo ${photoIndex + 1}: no video returned`);
      }

      // Start next photo or build album
      if (photoIndex + 1 < photos.length) {
        return handleStartNextPhoto(res, {
          photoIndex: photoIndex + 1,
          photos: photosStr,
          results: JSON.stringify(results),
          albumTitle, customerEmail, customerName,
        });
      } else {
        await schedulePoll({
          phase: 'build_album',
          results: JSON.stringify(results),
          albumTitle, customerEmail, customerName,
        }, '5s');
        return res.status(200).json({ status: 'building_album' });
      }
    } else {
      // Still processing
      await schedulePoll({
        ...body,
        results: resultsStr,
        pollCount: pollCount + 1,
      }, '15s');
      return res.status(200).json({ status: 'processing' });
    }
  } catch (err) {
    console.error('Poll error:', err.message);
    // Try again
    await schedulePoll({
      ...body,
      pollCount: pollCount + 1,
    }, '15s');
    return res.status(200).json({ status: 'retrying' });
  }
}

// Start animation for the next photo in the queue
async function handleStartNextPhoto(res, body) {
  const { photoIndex, photos: photosStr, results: resultsStr,
          albumTitle, customerEmail, customerName } = body;

  const photos = JSON.parse(photosStr);
  const currentPhoto = photos[photoIndex];
  const apiKey = process.env.GEMINI_API_KEY;

  console.log(`   🎬 Starting animation for photo ${photoIndex + 1}/${photos.length}: ${currentPhoto.caption}`);

  try {
    const { base64, mimeType } = await downloadImageAsBase64(currentPhoto.url);

    const motionPrompt = 'Gentle lifelike motion as if reliving a cherished moment. Soft breathing, natural blinking, slight warm smile, subtle head movement. Preserve every detail of the person face, clothing, and background. Emotional and cinematic quality.';

    const generateResp = await fetch(
      `${GEMINI_API}/models/${VEO_MODEL}:predictLongRunning`,
      {
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
      }
    );

    if (!generateResp.ok) {
      const errText = await generateResp.text();
      throw new Error(`Veo generation failed: ${errText.substring(0, 200)}`);
    }

    const genData = await generateResp.json();
    const opName = genData.name || genData.operationName;

    if (opName) {
      await schedulePoll({
        phase: 'poll_animation',
        operationName: opName,
        photoIndex,
        photos: photosStr,
        results: resultsStr,
        albumTitle, customerEmail, customerName,
        pollCount: 1,
      }, '15s');
    } else {
      // Direct result
      const directUri =
        genData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
        genData.generatedSamples?.[0]?.video?.uri;
      const results = JSON.parse(resultsStr);
      if (directUri) {
        const videoUrl = await downloadAndReupload(directUri);
        results.push({ ...currentPhoto, videoUrl });
      } else {
        results.push({ ...currentPhoto, videoUrl: null, error: 'No video' });
      }

      if (photoIndex + 1 < photos.length) {
        return handleStartNextPhoto(res, {
          photoIndex: photoIndex + 1,
          photos: photosStr,
          results: JSON.stringify(results),
          albumTitle, customerEmail, customerName,
        });
      } else {
        await schedulePoll({
          phase: 'build_album',
          results: JSON.stringify(results),
          albumTitle, customerEmail, customerName,
        }, '5s');
      }
    }

    return res.status(200).json({ status: 'processing' });
  } catch (err) {
    console.error(`Photo ${photoIndex + 1} animation failed:`, err.message);
    const results = JSON.parse(resultsStr);
    results.push({ ...currentPhoto, videoUrl: null, error: err.message });

    if (photoIndex + 1 < photos.length) {
      return handleStartNextPhoto(res, {
        photoIndex: photoIndex + 1,
        photos: photosStr,
        results: JSON.stringify(results),
        albumTitle, customerEmail, customerName,
      });
    } else {
      await schedulePoll({
        phase: 'build_album',
        results: JSON.stringify(results),
        albumTitle, customerEmail, customerName,
      }, '5s');
      return res.status(200).json({ status: 'building_album' });
    }
  }
}

// ===== PHASE 3: Build the album HTML page and deliver =====
async function handleBuildAlbum(res, body) {
  const { results: resultsStr, albumTitle, customerEmail, customerName } = body;
  const results = JSON.parse(resultsStr);

  console.log(`📖 Building album "${albumTitle}" with ${results.length} photos`);

  const successCount = results.filter(r => r.videoUrl).length;
  console.log(`   ✅ ${successCount} animated, ${results.length - successCount} static`);

  // Build HTML album page
  const albumHtml = buildAlbumPage(albumTitle, customerName, results);

  // Upload to Vercel Blob
  const blob = await put(`photobooks/album-${Date.now()}.html`, albumHtml, {
    access: 'public',
    contentType: 'text/html',
  });

  console.log(`   ☁️ Album uploaded: ${blob.url}`);

  // Send delivery email
  await sendDeliveryEmails(customerEmail, customerName, albumTitle, blob.url, successCount, results.length);

  return res.status(200).json({ success: true, albumUrl: blob.url });
}

// ===== EMAIL TEMPLATES =====
async function sendDeliveryEmails(customerEmail, customerName, albumTitle, albumUrl, animatedCount, totalCount) {
  const name = escapeHtml(customerName) || 'there';
  const title = escapeHtml(albumTitle);
  const url = escapeHtml(albumUrl);

  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: customerEmail,
      subject: `Your Photo Book is Ready ✨ "${albumTitle}"`,
      html: `
        <div style="font-family: 'Georgia', serif; max-width: 600px; margin: 0 auto; background: #f8f4ee; padding: 40px; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="font-family: 'Arial Black', sans-serif; font-size: 24px; letter-spacing: 3px; color: #1a1a1a; margin: 0;">ENVISION LEGACY</h1>
            <p style="color: #8b775a; font-style: italic; margin: 4px 0 0;">Where Memories Live Again</p>
          </div>
          <div style="background: white; padding: 32px; border-radius: 8px; border: 1px solid #e8e0d4;">
            <h2 style="color: #1a1a1a; margin-top: 0;">Your Photo Book is Ready, ${name}! 📖</h2>
            <p style="color: #555; line-height: 1.7;">Your digital photo album "<strong>${title}</strong>" with ${animatedCount} animated photos is ready to view and share.</p>
            <div style="text-align: center; margin: 28px 0;">
              <a href="${url}" style="display: inline-block; background: #c4793a; color: white; padding: 14px 32px; border-radius: 50px; text-decoration: none; font-weight: 600;">Open Your Photo Book</a>
            </div>
            <div style="background: #f8f4ee; padding: 16px; border-radius: 8px; border-left: 3px solid #c4793a;">
              <p style="margin: 0; color: #555; font-size: 14px;">
                <strong>Tips:</strong><br>
                • Share the link with family and friends<br>
                • Hover over each photo to see it come alive<br>
                • This link is permanent — bookmark it!
              </p>
            </div>
            <p style="color: #c4793a; font-style: italic; margin-top: 20px;">With warmth,<br>The Envision Legacy Team</p>
          </div>
        </div>
      `,
    });
    console.log(`   📧 Photo book delivered to ${customerEmail}`);
  } catch (e) {
    console.error('Delivery email error:', e.message);
  }

  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `✅ Photo Book → ${name} (${animatedCount}/${totalCount} animated)`,
      html: `<p>Photo book "${title}" delivered to ${name} (${escapeHtml(customerEmail)})</p><p><a href="${url}">View Album</a></p>`,
    });
  } catch (e) {
    console.error('Owner notify error:', e.message);
  }
}

async function sendFailureNotification(customerName, customerEmail, errorMsg) {
  try {
    await resend.emails.send({
      from: 'Envision Legacy <orders@techhq.ai>',
      to: process.env.OWNER_EMAIL || 'orders@techhq.ai',
      subject: `⚠️ Photo Book failed — ${escapeHtml(customerName)}`,
      html: `<p><strong>Failed:</strong> ${escapeHtml(customerName)} (${escapeHtml(customerEmail)})</p><p>Error: ${escapeHtml(errorMsg)}</p>`,
    });
  } catch (e) {
    console.error('Failure notify error:', e.message);
  }
}

// ===== ALBUM PAGE BUILDER =====
function buildAlbumPage(albumTitle, customerName, results) {
  const title = escapeHtml(albumTitle);
  const name = escapeHtml(customerName);

  const photoCells = results.map((photo, i) => {
    const caption = escapeHtml(photo.caption || `Photo ${i + 1}`);
    const imgUrl = escapeHtml(photo.url);

    if (photo.videoUrl) {
      const vidUrl = escapeHtml(photo.videoUrl);
      return `
        <div class="photo-cell">
          <div class="photo-frame">
            <img src="${imgUrl}" alt="${caption}" loading="lazy">
            <video src="${vidUrl}" loop muted playsinline preload="auto" style="display:none"></video>
          </div>
          <p class="caption">${caption}</p>
        </div>
      `;
    } else {
      return `
        <div class="photo-cell">
          <div class="photo-frame">
            <img src="${imgUrl}" alt="${caption}" loading="lazy">
          </div>
          <p class="caption">${caption}</p>
        </div>
      `;
    }
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Envision Legacy Photo Book</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', sans-serif;
  background: #1a1a1a; color: #f5f0e8;
  min-height: 100vh;
}
.album-header {
  text-align: center;
  padding: 60px 24px 40px;
  position: relative;
}
.album-header::after {
  content: ''; display: block;
  width: 60px; height: 2px;
  background: #c4793a;
  margin: 20px auto 0;
}
.album-header h1 {
  font-family: 'Playfair Display', serif;
  font-size: 36px; font-weight: 400;
  letter-spacing: 1px;
}
.album-header p {
  font-size: 14px; color: #8b775a;
  margin-top: 8px; font-style: italic;
}
.album-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 24px; padding: 0 24px 60px;
  max-width: 1000px; margin: 0 auto;
}
.photo-cell {
  background: #2a2520;
  border-radius: 12px; overflow: hidden;
  transition: transform 0.4s, box-shadow 0.4s;
}
.photo-cell:hover {
  transform: translateY(-4px);
  box-shadow: 0 16px 48px rgba(0,0,0,0.4);
}
.photo-frame {
  position: relative; overflow: hidden;
  aspect-ratio: 1;
}
.photo-frame img, .photo-frame video {
  width: 100%; height: 100%;
  object-fit: cover; display: block;
  transition: opacity 0.5s;
}
.photo-frame video {
  position: absolute; top: 0; left: 0;
}
.caption {
  padding: 14px 16px;
  font-family: 'Playfair Display', serif;
  font-style: italic; font-size: 14px;
  color: #d4c5ab; text-align: center;
}
.album-footer {
  text-align: center;
  padding: 20px 24px 40px;
  font-size: 12px; color: #555;
}
.album-footer a {
  color: #c4793a; text-decoration: none;
}
.album-footer a:hover { text-decoration: underline; }
@media (max-width: 600px) {
  .album-header h1 { font-size: 26px; }
  .album-grid { grid-template-columns: 1fr; gap: 16px; }
}
</style>
</head>
<body>
<header class="album-header">
  <h1>${title}</h1>
  <p>A memory collection by ${name}</p>
</header>
<div class="album-grid">
${photoCells}
</div>
<footer class="album-footer">
  <p>Created with <a href="https://envision-legacy.vercel.app" target="_blank">Envision Legacy</a> — Where Memories Live Again</p>
  <p style="margin-top:4px;">Hover over each photo to see it come alive ✨</p>
</footer>
<script>
document.querySelectorAll('.photo-frame').forEach(frame => {
  const vid = frame.querySelector('video');
  if (!vid) return;
  frame.addEventListener('mouseenter', () => {
    vid.style.display = 'block';
    vid.currentTime = 0;
    vid.play().catch(() => {});
    setTimeout(() => { vid.style.opacity = '1'; }, 50);
  });
  frame.addEventListener('mouseleave', () => {
    vid.pause();
    vid.style.opacity = '0';
    setTimeout(() => { vid.style.display = 'none'; }, 500);
  });
});
</script>
</body>
</html>`;
}
