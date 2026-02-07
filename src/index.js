require('dotenv').config();
const { Telegraf } = require('telegraf');
const telegramBot = require('./telegram-bot');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('❌ TELEGRAM_BOT_TOKEN is missing. Check your .env file.');
  process.exit(1);
}

const bot = new Telegraf(token);

// Initialize bot
telegramBot.initialize(bot);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    )
  ]);
}

async function start() {
  try {
    const me = await withTimeout(bot.telegram.getMe(), 15000, 'Telegram getMe');
    console.log(`✅ Bot auth OK: @${me.username} (${me.id})`);

    await withTimeout(
      bot.launch({
        // Avoid processing stale queued updates after restarts.
        dropPendingUpdates: true
      }),
      70000,
      'Bot launch'
    );

    console.log('🤖 Telegram bot is running (polling, dropPendingUpdates=true)...');
  } catch (error) {
    console.error('❌ Error starting bot:', error.message || error);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
