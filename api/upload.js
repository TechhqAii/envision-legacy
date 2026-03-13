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
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const boundary = req.headers['content-type']?.split('boundary=')[1];
    if (!boundary) {
      return res.status(400).json({ error: 'No multipart boundary found' });
    }

    const body = Buffer.concat(chunks);
    const bodyStr = body.toString('latin1');

    // Simple multipart parser to extract file
    const parts = bodyStr.split(`--${boundary}`).filter(p => p.includes('filename='));

    if (parts.length === 0) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const part = parts[0];
    const filenameMatch = part.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `upload-${Date.now()}`;

    // Find the start of file data (after double CRLF)
    const headerEnd = part.indexOf('\r\n\r\n') + 4;
    const dataEnd = part.lastIndexOf('\r\n');
    const fileData = body.subarray(
      bodyStr.indexOf(part.substring(headerEnd, headerEnd + 20)) + body.indexOf(Buffer.from(part.substring(headerEnd, headerEnd + 20), 'latin1')),
      body.length
    );

    // Rebuild file buffer from the raw body
    const partStart = body.indexOf(Buffer.from(`filename="${filename}"`, 'latin1'));
    const dataStart = body.indexOf(Buffer.from('\r\n\r\n', 'latin1'), partStart) + 4;
    const nextBoundary = body.indexOf(Buffer.from(`--${boundary}`, 'latin1'), dataStart);
    const fileBuffer = body.subarray(dataStart, nextBoundary - 2); // -2 for trailing \r\n

    const timestamp = Date.now();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const blobPath = `uploads/${timestamp}-${safeName}`;

    const blob = await put(blobPath, fileBuffer, {
      access: 'public',
      contentType: getContentType(filename),
    });

    return res.status(200).json({
      url: blob.url,
      filename: safeName,
      size: fileBuffer.length,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
}

function getContentType(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const types = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
  };
  return types[ext] || 'application/octet-stream';
}
