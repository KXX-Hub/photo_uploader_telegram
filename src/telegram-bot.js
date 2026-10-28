// Telegram front end: downloads photos sent to the bot and hands them to the
// shared photo pipeline. Uploading from the website does not need this file.
const axios = require('axios');
const { processPhotoBuffer } = require('./photo-service');

// Optional Telegram allowlist: comma-separated user IDs in TELEGRAM_ALLOWED_USER_IDS.
const TELEGRAM_ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Telegram-specific wrapper: downloads file from Telegram then calls processPhotoBuffer
async function processPhoto(photo, caption, ctx) {
  const file = await ctx.telegram.getFile(photo.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 15000 });
  const buffer = Buffer.from(response.data);
  return processPhotoBuffer(buffer, photo.file_name || '', photo.mime_type || '', caption);
}

// Initialize bot
function initialize(bot) {
  bot.use(async (ctx, next) => {
    const updateType = ctx.updateType || 'unknown';
    const fromId = ctx.from?.id || 'unknown';
    const chatId = ctx.chat?.id || 'unknown';
    console.log(`📩 Update received: type=${updateType} from=${fromId} chat=${chatId}`);
    if (TELEGRAM_ALLOWED_USER_IDS.length && !TELEGRAM_ALLOWED_USER_IDS.includes(String(ctx.from?.id))) {
      console.warn(`🚫 Ignoring update from user ${fromId} (not in TELEGRAM_ALLOWED_USER_IDS)`);
      if (ctx.chat) await ctx.reply('🚫 This bot is private.').catch(() => {});
      return;
    }
    return next();
  });

  if (!TELEGRAM_ALLOWED_USER_IDS.length) {
    console.warn('⚠️ TELEGRAM_ALLOWED_USER_IDS is not set: anyone who finds this bot can upload photos.');
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
      console.error('❌ Error processing photo:', error);
      console.error('Error stack:', error.stack);
      await safeReply(ctx, '❌ Error processing photo: ' + error.message);
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
      console.error('❌ Error processing document:', error);
      console.error('Error stack:', error.stack);
      await safeReply(ctx, '❌ Error processing document: ' + error.message);
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
