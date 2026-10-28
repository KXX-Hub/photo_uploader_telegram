// Standalone upload service for the website dashboard.
//   npm run start:upload
// Serves POST /upload, DELETE /photos/:id, GET /healthz and a simple upload page
// at GET /. Needs Firebase Admin + R2 credentials, but no Telegram bot token, so
// it can run (and keep running) without the Telegram bot.
require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const Busboy = require('busboy');
const photoService = require('./photo-service');

const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

// ─── Web Upload: HTML page ────────────────────────────────────────────────────
function getUploadHTML() {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Photo Uploader</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0f0f0f;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .container { width: 100%; max-width: 560px; }
    h1 {
      font-size: 1.4rem;
      font-weight: 600;
      margin-bottom: 24px;
      color: #fff;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 0.8rem;
      color: #888;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      color: #e5e5e5;
      padding: 10px 12px;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #555; }
    .drop-zone {
      border: 2px dashed #333;
      border-radius: 10px;
      padding: 40px 24px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      margin-top: 16px;
    }
    .drop-zone.drag-over { border-color: #666; background: #222; }
    .drop-zone-icon { font-size: 2.5rem; margin-bottom: 10px; }
    .drop-zone-text { color: #888; font-size: 0.9rem; }
    .drop-zone-text strong { color: #bbb; }
    input[type="file"] { display: none; }
    .file-list { margin-top: 16px; }
    .file-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      background: #111;
      border-radius: 8px;
      margin-bottom: 6px;
      font-size: 0.85rem;
    }
    .file-item-name { flex: 1; color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-item-size { color: #666; white-space: nowrap; }
    .file-item-remove { cursor: pointer; color: #555; font-size: 1rem; padding: 0 4px; }
    .file-item-remove:hover { color: #f55; }
    .btn {
      width: 100%;
      background: #e5e5e5;
      color: #0f0f0f;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      margin-top: 16px;
    }
    .btn:hover { background: #fff; }
    .btn:disabled { background: #333; color: #666; cursor: not-allowed; }
    .progress-bar-wrap {
      background: #222;
      border-radius: 99px;
      height: 4px;
      margin-top: 14px;
      overflow: hidden;
      display: none;
    }
    .progress-bar {
      height: 100%;
      background: #fff;
      width: 0%;
      transition: width 0.3s;
    }
    .results { margin-top: 16px; }
    .result-item {
      padding: 12px 14px;
      border-radius: 8px;
      margin-bottom: 8px;
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .result-ok { background: #0d2010; border: 1px solid #1a4020; color: #7ed99a; }
    .result-err { background: #1f0d0d; border: 1px solid #3d1515; color: #e07070; }
    .status-text { color: #888; font-size: 0.82rem; margin-top: 10px; text-align: center; }
  </style>
</head>
<body>
<div class="container">
  <h1>📷 Photo Uploader</h1>

  ${UPLOAD_SECRET ? `
  <div class="card">
    <label>Upload Token</label>
    <input type="password" id="token" placeholder="Enter your upload token" autocomplete="off">
  </div>
  ` : ''}

  <div class="card">
    <label>Caption (optional)</label>
    <input type="text" id="caption" placeholder="Add a caption or 📍 location...">

    <div class="drop-zone" id="dropZone">
      <div class="drop-zone-icon">🖼️</div>
      <div class="drop-zone-text"><strong>Click to select</strong> or drag &amp; drop photos here</div>
      <div class="drop-zone-text" style="margin-top:6px;font-size:0.8rem">JPEG · PNG · HEIC · WebP · RAW · TIFF</div>
    </div>
    <input type="file" id="fileInput" multiple accept="image/*,.heic,.heif,.raw,.cr2,.nef,.arw,.dng,.tiff,.tif">

    <div class="file-list" id="fileList"></div>

    <button class="btn" id="uploadBtn" disabled>Upload Photos</button>
    <div class="progress-bar-wrap" id="progressWrap">
      <div class="progress-bar" id="progressBar"></div>
    </div>
    <div class="status-text" id="statusText"></div>
  </div>

  <div class="results" id="results"></div>
</div>

<script>
  let files = [];

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const fileList = document.getElementById('fileList');
  const uploadBtn = document.getElementById('uploadBtn');
  const progressWrap = document.getElementById('progressWrap');
  const progressBar = document.getElementById('progressBar');
  const statusText = document.getElementById('statusText');
  const results = document.getElementById('results');

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    addFiles([...e.dataTransfer.files]);
  });

  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  function addFiles(newFiles) {
    newFiles.forEach(f => {
      if (!files.find(x => x.name === f.name && x.size === f.size)) files.push(f);
    });
    renderFileList();
  }

  function renderFileList() {
    fileList.innerHTML = files.map((f, i) => \`
      <div class="file-item">
        <span class="file-item-name">\${f.name}</span>
        <span class="file-item-size">\${(f.size / 1024 / 1024).toFixed(1)} MB</span>
        <span class="file-item-remove" onclick="removeFile(\${i})">✕</span>
      </div>
    \`).join('');
    uploadBtn.disabled = files.length === 0;
  }

  function removeFile(i) {
    files.splice(i, 1);
    renderFileList();
  }

  uploadBtn.addEventListener('click', async () => {
    if (!files.length) return;

    ${UPLOAD_SECRET ? `
    const token = document.getElementById('token').value.trim();
    if (!token) { alert('Please enter your upload token.'); return; }
    ` : ''}

    uploadBtn.disabled = true;
    results.innerHTML = '';
    progressWrap.style.display = 'block';
    progressBar.style.width = '0%';

    const caption = document.getElementById('caption').value.trim();
    let done = 0;

    for (const file of files) {
      statusText.textContent = \`Uploading \${file.name}...\`;
      const fd = new FormData();
      fd.append('photo', file, file.name);
      if (caption) fd.append('caption', caption);

      try {
        const res = await fetch('/upload', {
          method: 'POST',
          headers: ${UPLOAD_SECRET ? `{ 'Authorization': 'Bearer ' + token }` : `{}`},
          body: fd
        });
        const data = await res.json();
        if (res.ok && data.success) {
          results.insertAdjacentHTML('beforeend',
            \`<div class="result-item result-ok"><strong>\${file.name}</strong><br>\${data.message.replace(/\\n/g, '<br>')}</div>\`);
        } else {
          results.insertAdjacentHTML('beforeend',
            \`<div class="result-item result-err"><strong>\${file.name}</strong><br>\${data.error || 'Upload failed'}</div>\`);
        }
      } catch (err) {
        results.insertAdjacentHTML('beforeend',
          \`<div class="result-item result-err"><strong>\${file.name}</strong><br>Network error: \${err.message}</div>\`);
      }

      done++;
      progressBar.style.width = \`\${Math.round((done / files.length) * 100)}%\`;
    }

    statusText.textContent = \`Done — \${done} file\${done !== 1 ? 's' : ''} processed.\`;
    files = [];
    renderFileList();
    uploadBtn.disabled = true;
  });
</script>
</body>
</html>`;
}

// ─── Auth ────────────────────────────────────────────────────────────────────
// Accepts either the UPLOAD_SECRET (built-in upload page / scripts) or a Firebase
// ID token from the website dashboard whose email is on the dashboard allowlist
// (Firestore settings/dashboard_auth, plus optional ADMIN_EMAILS env).
// Fails closed: with no secret and no allowlist, nothing is authorized.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function secretMatches(provided) {
  if (!UPLOAD_SECRET || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(UPLOAD_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getAllowedEmails() {
  const allowed = new Set(ADMIN_EMAILS);
  try {
    const snap = await photoService.db.collection('settings').doc('dashboard_auth').get();
    const data = snap.exists ? snap.data() : {};
    (Array.isArray(data.allowedEmails) ? data.allowedEmails : []).forEach((e) => allowed.add(String(e).trim().toLowerCase()));
    if (data.allowedEmail) allowed.add(String(data.allowedEmail).trim().toLowerCase());
  } catch (err) {
    console.error('❌ Could not read dashboard allowlist:', err.message);
  }
  return allowed;
}

async function authorize(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  if (secretMatches(token)) return { via: 'secret' };

  try {
    const decoded = await photoService.admin.auth().verifyIdToken(token);
    const email = (decoded.email || '').toLowerCase();
    if (!email || !decoded.email_verified) return null;
    const allowed = await getAllowedEmails();
    return allowed.has(email) ? { via: 'firebase', email } : null;
  } catch {
    return null;
  }
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ─── Web Upload: POST /upload handler ────────────────────────────────────────
async function handleUpload(req, res) {
  if (!(await authorize(req))) {
    req.resume();
    sendJSON(res, 401, { error: 'Unauthorized' });
    return;
  }

  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } });
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request: ' + err.message }));
    return;
  }

  let fileBuffer = null;
  let fileName = '';
  let mimeType = '';
  let caption = '';
  const exifOverrides = {};
  const EXIF_FIELDS = ['date', 'device', 'aperture', 'shutter', 'iso', 'focalLength', 'latitude', 'longitude'];

  busboy.on('file', (fieldName, fileStream, info) => {
    fileName = info.filename || '';
    mimeType = info.mimeType || '';
    const chunks = [];
    fileStream.on('data', chunk => chunks.push(chunk));
    fileStream.on('close', () => { fileBuffer = Buffer.concat(chunks); });
  });

  busboy.on('field', (name, value) => {
    if (name === 'caption') caption = value;
    else if (EXIF_FIELDS.includes(name) && value) exifOverrides[name] = value;
  });

  busboy.on('close', async () => {
    if (!fileBuffer || fileBuffer.length === 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file received' }));
      return;
    }
    try {
      const { message, id } = await photoService.processPhotoBuffer(fileBuffer, fileName, mimeType, caption, exifOverrides);
      sendJSON(res, 200, { success: true, message, id });
    } catch (err) {
      console.error('❌ Web upload error:', err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  busboy.on('error', err => {
    console.error('❌ Busboy error:', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload parsing failed' }));
  });

  req.pipe(busboy);
}

// ─── Web: DELETE /photos/:id handler ─────────────────────────────────────────
async function handleDelete(req, res, photoId) {
  if (!(await authorize(req))) {
    sendJSON(res, 401, { error: 'Unauthorized' });
    return;
  }
  try {
    const result = await photoService.deletePhoto(photoId);
    sendJSON(res, 200, { success: true, ...result });
  } catch (err) {
    console.error('❌ Delete error:', err);
    sendJSON(res, err.statusCode || 500, { error: err.message });
  }
}

// ─── CORS headers ────────────────────────────────────────────────────────────
// Comma-separated list of allowed origins; "*" allows any.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'https://www.0xkxx.com,https://0xkxx.com,http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function setCORSHeaders(req, res) {
  const origin = req.headers.origin;
  if (CORS_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

// ─── Shared request handler (web routes) ─────────────────────────────────────
function handleWebRoutes(req, res, url) {
  setCORSHeaders(req, res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(getUploadHTML());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/upload') {
    handleUpload(req, res);
    return true;
  }
  const deleteMatch = url.pathname.match(/^\/photos\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    handleDelete(req, res, deleteMatch[1]);
    return true;
  }
  return false;
}

// Shared by the standalone server below and by the bot (src/index.js), which
// still mounts these routes unless ENABLE_WEB_UPLOAD=false.
function startUploadServer(port = Number(process.env.PORT || 3000)) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (handleWebRoutes(req, res, url)) return;

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`📤 Upload service listening on port ${port}`);
  });
  return server;
}

if (require.main === module) {
  startUploadServer();
}

module.exports = { handleWebRoutes, startUploadServer };
