// Keeps the original of every web upload, byte for byte (EXIF included), as a
// file in a private Telegram channel. The site keeps serving the resized WebP
// copies from R2; the channel is the archive.
//
// Needs TELEGRAM_BOT_TOKEN and TELEGRAM_ARCHIVE_CHAT_ID (the channel's id, e.g.
// -1001234567890). The bot only has to be an admin of that channel that can
// post and delete messages; nobody chats with it. With either variable
// missing, uploads work as before and no original is kept.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = (process.env.TELEGRAM_ARCHIVE_CHAT_ID || '').trim();
const API = 'https://api.telegram.org';

// Bots can send files up to 50 MB, but only fetch them back up to 20 MB.
// Bigger originals stay in the channel and are downloaded from Telegram itself.
const MAX_SEND_BYTES = 50 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_CAPTION_CHARS = 1024;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 90 * 1000;

const enabled = Boolean(TOKEN && CHAT_ID);

const redact = (text) => String(text || '').split(TOKEN || '\u0000').join('<bot-token>');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls a Bot API method, waiting out rate limits (a channel takes about 20
// posts a minute, so a large batch can hit them).
async function callApi(method, body) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(`${API}/bot${TOKEN}/${method}`, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Telegram ${method} failed: ${redact(err.cause?.message || err.message)}`);
    }
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (data.ok) return data.result;

    const retryAfter = Number(data.parameters?.retry_after);
    if (res.status === 429 && retryAfter > 0 && attempt < MAX_RETRIES) {
      console.warn(`⏳ Telegram rate limit on ${method}, retrying in ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      continue;
    }
    const err = new Error(`Telegram ${method} failed: ${redact(data.description)}`);
    err.telegramCode = data.error_code;
    throw err;
  }
}

// t.me link to the message: public channels by name, private ones by id.
function messageLink(chat, messageId) {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat.id);
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${messageId}` : '';
}

/**
 * Posts the original file to the archive channel. Returns what to store on
 * the photo's Firestore document as `original`.
 */
async function archiveOriginal({ buffer, fileName, mimeType, caption }) {
  if (!enabled) throw new Error('Telegram archive is not configured');
  if (buffer.length > MAX_SEND_BYTES) throw new Error('File is over the 50 MB Telegram limit');

  const form = new FormData();
  form.append('chat_id', CHAT_ID);
  form.append('document', new Blob([buffer], { type: mimeType || 'application/octet-stream' }), fileName || 'photo');
  if (caption) form.append('caption', caption.slice(0, MAX_CAPTION_CHARS));
  // Keep it a plain file: no conversion, no preview re-encoding.
  form.append('disable_content_type_detection', 'true');

  const message = await callApi('sendDocument', form);
  const file = message.document || message.animation || message.video;
  if (!file) throw new Error('Telegram did not keep the upload as a file');

  return {
    provider: 'telegram',
    chatId: String(message.chat.id),
    messageId: message.message_id,
    link: messageLink(message.chat, message.message_id),
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    fileName: file.file_name || fileName || '',
    mimeType: file.mime_type || mimeType || '',
    size: file.file_size || buffer.length,
  };
}

/**
 * Removes an archived original from the channel. Throws when Telegram
 * refuses (for example, the bot lost its admin rights).
 */
async function deleteArchived(original) {
  if (!enabled || !Number.isInteger(original?.messageId)) return false;
  await callApi('deleteMessage', new URLSearchParams({ chat_id: CHAT_ID, message_id: String(original.messageId) }));
  return true;
}

/**
 * Fetches an archived original back from Telegram. Returns the download
 * response, whose body streams the file.
 */
async function downloadArchived(original) {
  if (!enabled) throw new Error('Telegram archive is not configured');
  const file = await callApi('getFile', new URLSearchParams({ file_id: String(original.fileId) }));
  if (!file.file_path) throw new Error('Telegram returned no file path');
  let res;
  try {
    res = await fetch(`${API}/file/bot${TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`Telegram download failed: ${redact(err.cause?.message || err.message)}`);
  }
  if (!res.ok || !res.body) throw new Error(`Telegram download failed: HTTP ${res.status}`);
  return res;
}

module.exports = {
  enabled,
  MAX_SEND_BYTES,
  MAX_DOWNLOAD_BYTES,
  archiveOriginal,
  deleteArchived,
  downloadArchived,
};
