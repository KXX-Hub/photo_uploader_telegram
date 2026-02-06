require('dotenv').config();
const { Telegraf } = require('telegraf');
const telegramBot = require('./telegram-bot');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Initialize bot
telegramBot.initialize(bot);

// Start bot
bot.launch().then(() => {
  console.log('🤖 Telegram bot is running...');
}).catch((error) => {
  console.error('❌ Error starting bot:', error);
  process.exit(1);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
