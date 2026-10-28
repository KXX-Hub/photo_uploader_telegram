// Telegram front end: downloads photos sent to the bot and hands them to the
// shared photo pipeline. Uploading from the website does not need this file.
const axios = require('axios');
const { processPhotoBuffer } = require('./photo-service');

// Telegram allowlist: comma-separated user IDs in TELEGRAM_ALLOWED_USER_IDS.
// Required: with no IDs set, the bot ignores every update (fails closed).
const TELEGRAM_ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// The file URL embeds the bot token. Errors from downloading it (axios keeps
// the URL in config/request) must never reach a log or a reply as-is.
const MAX_TELEGRAM_FILE_BYTES = 50 * 1024 * 1024;
const redactToken = (text) => String(text || '').split(process.env.TELEGRAM_BOT_TOKEN || '\u0000').join('<bot-token>');

// Telegram-specific wrapper: downloads file from Telegram then calls processPhotoBuffer
async function processPhoto(photo, caption, ctx) {
  const file = await ctx.telegram.getFile(photo.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  let response;
  try {
    response = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: MAX_TELEGRAM_FILE_BYTES,
      maxRedirects: 0,
    });
  } catch (err) {
    throw new Error(`Could not download the file from Telegram (${redactToken(err.code || err.message)})`);
  }
  const buffer = Buffer.from(response.data);
  return processPhotoBuffer(buffer, String(photo.file_name || '').slice(0, 255), photo.mime_type || '', String(caption || '').slice(0, 200));
}

// Logs an error without stack details that could carry the token.
const logError = (label, error) => console.error(label, redactToken(error?.message));

// Initialize bot
function initialize(bot) {
  bot.use(async (ctx, next) => {
    const updateType = ctx.updateType || 'unknown';
    const fromId = ctx.from?.id || 'unknown';
    const chatId = ctx.chat?.id || 'unknown';
    console.log(`📩 Update received: type=${updateType} from=${fromId} chat=${chatId}`);
    if (!TELEGRAM_ALLOWED_USER_IDS.includes(String(ctx.from?.id))) {
      console.warn(`🚫 Ignoring update from user ${fromId} (not in TELEGRAM_ALLOWED_USER_IDS)`);
      if (ctx.chat) await ctx.reply('🚫 This bot is private.').catch(() => {});
      return;
    }
    return next();
  });

  if (!TELEGRAM_ALLOWED_USER_IDS.length) {
    console.warn('⚠️ TELEGRAM_ALLOWED_USER_IDS is not set: the bot will ignore every message until it is.');
  }

  async function safeReply(ctx, text) {
    try {
      const sent = await ctx.reply(text);
      console.log(`✅ Reply sent to chat ${ctx.chat?.id}, message ${sent.message_id}`);
      return sent;
    } catch (error) {
      console.error(`❌ Reply failed for chat ${ctx.chat?.id}:`, error?.description || error.message);
      throw error;
    }
  }

  // Handle photo messages
  bot.on('photo', async (ctx) => {
    try {
      const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get largest photo
      const caption = ctx.message.caption || '';
      
      console.log('📸 Received photo from user:', ctx.from.id);
      await safeReply(ctx, '📸 Processing...');
      const { message } = await processPhoto(photo, caption, ctx);
      await safeReply(ctx, message);
    } catch (error) {
      logError('❌ Error processing photo:', error);
      await safeReply(ctx, '❌ Could not process that photo. Try again, or send it as a file.');
    }
  });

  // Handle document messages (for HEIC, RAW, and other image formats)
  bot.on('document', async (ctx) => {
    try {
      const doc = ctx.message.document;
      const mimeType = doc.mime_type?.toLowerCase() || '';
      const fileName = doc.file_name?.toLowerCase() || '';
      
      console.log('📄 Received document:', fileName, mimeType);
      
      // Support various image formats
      const imageExtensions = ['.heic', '.heif', '.raw', '.cr2', '.nef', '.arw', '.dng', 
                               '.tiff', '.tif', '.png', '.jpg', '.jpeg', '.webp'];
      const isImageFile = mimeType.startsWith('image/') || 
                         imageExtensions.some(ext => fileName.endsWith(ext));
      
      if (isImageFile) {
        await safeReply(ctx, '📸 Processing...');
        const { message } = await processPhoto(doc, ctx.message.caption || '', ctx);
        await safeReply(ctx, message);
      } else {
        await safeReply(ctx, '❌ Unsupported file format. Please send an image file.');
      }
    } catch (error) {
      logError('❌ Error processing document:', error);
      await safeReply(ctx, '❌ Could not process that file. Try again with a JPEG, PNG, HEIC or RAW image.');
    }
  });

  // Start command
  bot.start((ctx) => {
    ctx.reply('👋 Welcome! Send me a photo to upload it to your gallery.');
  });

  // Help command
  bot.help((ctx) => {
    ctx.reply('📸 Send me photos to upload them to your gallery.\n\n' +
      '💡 Tips:\n' +
      '• Send photos as files to preserve EXIF data\n' +
      '• Add location in caption with 📍\n' +
      '• Supported formats: HEIC, HEIF, RAW, TIFF, PNG, JPEG, WebP\n' +
      '• All images are converted to WebP for optimal storage');
  });
}

module.exports = {
  initialize
};
