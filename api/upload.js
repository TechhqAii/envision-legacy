import { put } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Collect request body as Buffer
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // Parse boundary from Content-Type
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'No multipart boundary found' });
    }
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const boundaryBuf = Buffer.from(`--${boundary}`);

    // Find the file part
    const { filename, fileBuffer } = extractFile(body, boundaryBuf);

    if (!filename || !fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ error: 'No file found in upload' });
    }

    // Check file size (25MB max)
    if (fileBuffer.length > 25 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large. Maximum 25MB.' });
    }

    // Upload to Vercel Blob
    const timestamp = Date.now();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blobPath = `uploads/${timestamp}-${safeName}`;

    const blob = await put(blobPath, fileBuffer, {
      access: 'public',
      contentType: getContentType(filename),
    });

    console.log(`✅ Uploaded: ${safeName} (${fileBuffer.length} bytes) → ${blob.url}`);

    return res.status(200).json({
      url: blob.url,
      filename: safeName,
      size: fileBuffer.length,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Upload failed', details: err.message });
  }
}

function extractFile(body, boundaryBuf) {
  // Find all boundary positions
  const positions = [];
  let pos = 0;
  while (pos < body.length) {
    const idx = body.indexOf(boundaryBuf, pos);
    if (idx === -1) break;
    positions.push(idx);
    pos = idx + boundaryBuf.length;
  }

  // Each part is between consecutive boundaries
  for (let i = 0; i < positions.length - 1; i++) {
    const partStart = positions[i] + boundaryBuf.length;
    const partEnd = positions[i + 1];
    const partData = body.subarray(partStart, partEnd);

    // Find the double CRLF that separates headers from body
    const headerEndMarker = Buffer.from('\r\n\r\n');
    const headerEndIdx = partData.indexOf(headerEndMarker);
    if (headerEndIdx === -1) continue;

    const headerStr = partData.subarray(0, headerEndIdx).toString('utf-8');

    // Check if this part has a filename
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    if (!filenameMatch) continue;

    const filename = filenameMatch[1];
    // File data starts after headers + double CRLF, ends before trailing CRLF
    const fileData = partData.subarray(headerEndIdx + 4, partData.length - 2);

    return { filename, fileBuffer: fileData };
  }

  return { filename: null, fileBuffer: null };
}

function getContentType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    heic: 'image/heic',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
  };
  return types[ext] || 'application/octet-stream';
}
