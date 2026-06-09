require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http');
const { URL } = require('url');
const Busboy = require('busboy');
const telegramBot = require('./telegram-bot');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is missing. Check your .env file.');
  process.exit(1);
}

const UPLOAD_SECRET = process.env.UPLOAD_SECRET || '';

const bot = new Telegraf(token);
telegramBot.initialize(bot);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

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
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 24px; color: #fff; }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 16px;
    }
    label { display: block; font-size: 0.8rem; color: #888; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
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
    .progress-bar-wrap { background: #222; border-radius: 99px; height: 4px; margin-top: 14px; overflow: hidden; display: none; }
    .progress-bar { height: 100%; background: #fff; width: 0%; transition: width 0.3s; }
    .results { margin-top: 16px; }
    .result-item { padding: 12px 14px; border-radius: 8px; margin-bottom: 8px; font-size: 0.85rem; line-height: 1.5; }
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
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); addFiles([...e.dataTransfer.files]); });
  fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

  function addFiles(newFiles) {
    newFiles.forEach(f => { if (!files.find(x => x.name === f.name && x.size === f.size)) files.push(f); });
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

  function removeFile(i) { files.splice(i, 1); renderFileList(); }

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
          results.insertAdjacentHTML('beforeend', \`<div class="result-item result-ok"><strong>\${file.name}</strong><br>\${data.message.replace(/\\n/g, '<br>')}</div>\`);
        } else {
          results.insertAdjacentHTML('beforeend', \`<div class="result-item result-err"><strong>\${file.name}</strong><br>\${data.error || 'Upload failed'}</div>\`);
        }
      } catch (err) {
        results.insertAdjacentHTML('beforeend', \`<div class="result-item result-err"><strong>\${file.name}</strong><br>Network error: \${err.message}</div>\`);
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

// ─── Web Upload: POST /upload handler ────────────────────────────────────────
function handleUpload(req, res) {
  // Auth check
  if (UPLOAD_SECRET) {
    const auth = req.headers['authorization'] || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided !== UPLOAD_SECRET) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
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
  // EXIF override fields pre-extracted by the browser dashboard
  const overrideMeta = {};

  busboy.on('file', (fieldName, fileStream, info) => {
    fileName = info.filename || '';
    mimeType = info.mimeType || '';
    const chunks = [];
    fileStream.on('data', chunk => chunks.push(chunk));
    fileStream.on('close', () => { fileBuffer = Buffer.concat(chunks); });
  });

  busboy.on('field', (name, value) => {
    if      (name === 'caption')     caption                  = value;
    else if (name === 'date')        overrideMeta.date        = value;
    else if (name === 'device')      overrideMeta.device      = value;
    else if (name === 'aperture')    overrideMeta.aperture    = value;
    else if (name === 'shutter')     overrideMeta.shutter     = value;
    else if (name === 'iso')         overrideMeta.iso         = value;
    else if (name === 'focalLength') overrideMeta.focalLength = value;
    else if (name === 'latitude')  { const v = parseFloat(value); if (!isNaN(v)) overrideMeta.latitude  = v; }
    else if (name === 'longitude') { const v = parseFloat(value); if (!isNaN(v)) overrideMeta.longitude = v; }
  });

  busboy.on('close', async () => {
    if (!fileBuffer || fileBuffer.length === 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'No file received' }));
      return;
    }
    try {
      const message = await telegramBot.processPhotoBuffer(fileBuffer, fileName, mimeType, caption, overrideMeta);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, message }));
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

// ─── CORS headers ────────────────────────────────────────────────────────────
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

// ─── Shared request handler ───────────────────────────────────────────────────
function handleWebRoutes(req, res, url) {
  setCORSHeaders(res);

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
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    const me = await withTimeout(bot.telegram.getMe(), 15000, 'Telegram getMe');
    console.log(`✅ Bot auth OK: @${me.username} (${me.id})`);

    const webhookDomain = process.env.WEBHOOK_DOMAIN;
    const webhookPath = process.env.WEBHOOK_PATH || '/telegram';
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    const port = Number(process.env.PORT || 3000);

    if (webhookDomain) {
      if (!webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET is required when WEBHOOK_DOMAIN is set');
      if (webhookPath === '/telegram') throw new Error('WEBHOOK_PATH must be customized (do not use default /telegram in production)');
      if (!webhookPath.startsWith('/')) throw new Error('WEBHOOK_PATH must start with /');
      let webhookUrl = webhookDomain;
      if (!webhookUrl.startsWith('https://')) throw new Error('WEBHOOK_DOMAIN must start with https://');
      if (!webhookUrl.endsWith(webhookPath)) webhookUrl = webhookUrl.replace(/\/+$/, '') + webhookPath;

      await bot.telegram.setWebhook(webhookUrl, {
        secret_token: webhookSecret || undefined,
        drop_pending_updates: true
      });

      const webhookHandler = bot.webhookCallback(webhookPath);

      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (req.method === 'GET' && url.pathname === '/healthz') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
          return;
        }
        if (req.method === 'POST' && url.pathname === webhookPath) {
          if (webhookSecret) {
            const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
            if (headerSecret !== webhookSecret) {
              res.writeHead(401, { 'content-type': 'text/plain' });
              res.end('unauthorized');
              return;
            }
          }
          return webhookHandler(req, res);
        }
        if (handleWebRoutes(req, res, url)) return;
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      });

      server.listen(port, '0.0.0.0', () => {
        console.log(`🌐 Server listening on port ${port}`);
        console.log(`🔗 Webhook URL: ${webhookUrl}`);
        console.log(`🖼️  Upload page: http://localhost:${port}/`);
      });

      console.log('🤖 Telegram bot is running (webhook mode)...');
      return;
    }

    // Polling mode
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
      console.log(`🌐 Web upload server listening on port ${port}`);
      console.log(`🖼️  Upload page: http://localhost:${port}/`);
    });

    console.log('🚀 Starting polling...');
    await bot.launch({ dropPendingUpdates: true });
    console.log('🤖 Telegram bot is running (polling mode)...');

  } catch (error) {
    console.error('❌ Error starting bot:', error.message || error);
    process.exit(1);
  }
}

start();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
