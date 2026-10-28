require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http');
const { URL } = require('url');
const telegramBot = require('./telegram-bot');

// The website's upload API also runs standalone (npm run start:upload). Set
// ENABLE_WEB_UPLOAD=false here once that service is deployed on its own.
const ENABLE_WEB_UPLOAD = process.env.ENABLE_WEB_UPLOAD !== 'false';
const handleWebRoutes = ENABLE_WEB_UPLOAD
  ? require('./upload-server').handleWebRoutes
  : () => false;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is missing. Check your .env file.');
  process.exit(1);
}

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
      if (!webhookSecret) {
        throw new Error('TELEGRAM_WEBHOOK_SECRET is required when WEBHOOK_DOMAIN is set');
      }
      if (webhookPath === '/telegram') {
        throw new Error('WEBHOOK_PATH must be customized (do not use default /telegram in production)');
      }
      if (!webhookPath.startsWith('/')) {
        throw new Error('WEBHOOK_PATH must start with /');
      }
      let webhookUrl = webhookDomain;
      if (!webhookUrl.startsWith('https://')) {
        throw new Error('WEBHOOK_DOMAIN must start with https://');
      }
      if (!webhookUrl.endsWith(webhookPath)) {
        webhookUrl = webhookUrl.replace(/\/+$/, '') + webhookPath;
      }

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

    // Polling mode — start a standalone HTTP server just for web upload
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
