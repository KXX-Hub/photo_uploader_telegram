const admin = require('firebase-admin');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const exifr = require('exifr');
const heicConvert = require('heic-convert');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Firebase Admin
if (!admin.apps.length) {
  const firebaseProjectId = process.env.FIREBASE_PROJECT_ID;
  const firebaseClientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  let serviceAccount;
  if (firebaseProjectId && firebaseClientEmail && firebasePrivateKey) {
    serviceAccount = {
      projectId: firebaseProjectId,
      clientEmail: firebaseClientEmail,
      // Koyeb env usually stores literal \n, convert to real line breaks.
      privateKey: firebasePrivateKey.replace(/\\n/g, '\n')
    };
  } else {
    const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-admin-key.json';
    // Resolve from project cwd so env can use paths like ./firebase-admin-key.json reliably.
    const resolvedServiceAccountPath = path.isAbsolute(serviceAccountPath)
      ? serviceAccountPath
      : path.resolve(process.cwd(), serviceAccountPath);
    serviceAccount = require(resolvedServiceAccountPath);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
// Enable ignoreUndefinedProperties to prevent Firestore errors
db.settings({ ignoreUndefinedProperties: true });

// Initialize Cloudflare R2
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = (process.env.R2_BUCKET_NAME || '').split('/').filter(Boolean)[0];
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const R2_OBJECT_PREFIX = (process.env.R2_OBJECT_PREFIX || '').replace(/^\/+|\/+$/g, '');
const R2_ORIGINALS_PREFIX = (process.env.R2_ORIGINALS_PREFIX || 'originals').replace(/^\/+|\/+$/g, '');
const R2_THUMBNAILS_PREFIX = (process.env.R2_THUMBNAILS_PREFIX || 'thumbnails').replace(/^\/+|\/+$/g, '');

function buildObjectKey(folder, fileName) {
  return [R2_OBJECT_PREFIX, folder, fileName].filter(Boolean).join('/');
}

function formatApertureToOneDecimal(value) {
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(num)) return null;
  const rounded = Math.round(num * 10) / 10;
  return `f/${rounded.toFixed(1)}`;
}

function roundToOneDecimal(value) {
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 10) / 10;
}
const ENABLE_REVERSE_GEOCODE = process.env.ENABLE_REVERSE_GEOCODE !== 'false';
const geocodeCache = new Map();
const GEOCODE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function getGeocodeCacheKey(lat, lon) {
  return `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
}

// Reverse geocoding function
async function reverseGeocode(lat, lon) {
  const cacheKey = getGeocodeCacheKey(lat, lon);
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GEOCODE_CACHE_TTL_MS) {
    return cached.location;
  }
  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: {
        lat,
        lon,
        format: 'json',
        'accept-language': 'en',
        addressdetails: 1
      },
      headers: {
        'User-Agent': 'KXX-Photo-Bot/1.0'
      },
      // Keep bot responsive; skip reverse geocode if service is slow.
      timeout: 2000
    });

    if (response.data && response.data.address) {
      const addr = response.data.address;
      const city = addr.city || addr.town || addr.village || addr.municipality || '';
      const country = addr.country || '';
      const location = `${city}, ${country}`.trim();
      geocodeCache.set(cacheKey, { location, ts: Date.now() });
      return location;
    }
    return null;
  } catch (error) {
    console.error('Reverse geocoding error:', error.message);
    return null;
  }
}

// Parse location from text
function parseLocationFromText(text) {
  if (!text) return null;
  
  // Try to extract location from caption
  const locationMatch = text.match(/📍\s*(.+)/i) || text.match(/location[:\s]+(.+)/i);
  if (locationMatch) {
    return locationMatch[1].trim();
  }
  return null;
}

// Process photo
async function processPhoto(photo, caption, ctx) {
  try {
    const t0 = Date.now();
    const mark = (label) => console.log(`⏱️ ${label}: ${Date.now() - t0}ms`);

    // Download photo
    const file = await ctx.telegram.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const response = await axios.get(fileUrl, {
      responseType: 'arraybuffer',
      timeout: 15000
    });
    const buffer = Buffer.from(response.data);
    mark('download');
    
    // Detect file type - support multiple formats
    const fileName = photo.file_name?.toLowerCase() || '';
    const mimeType = photo.mime_type?.toLowerCase() || '';
    
    // Check for HEIC/HEIF
    const isHeic = fileName.endsWith('.heic') || 
                   fileName.endsWith('.heif') ||
                   mimeType.includes('heic') ||
                   mimeType.includes('heif') ||
                   buffer.slice(4, 8).toString() === 'ftyp';
    
    // Check for other RAW formats
    const isRaw = fileName.endsWith('.raw') || 
                  fileName.endsWith('.cr2') || 
                  fileName.endsWith('.nef') ||
                  fileName.endsWith('.arw') ||
                  fileName.endsWith('.dng') ||
                  mimeType.includes('raw');
    
    // Check for other formats
    const isPng = fileName.endsWith('.png') || mimeType.includes('png');
    const isTiff = fileName.endsWith('.tiff') || fileName.endsWith('.tif') || mimeType.includes('tiff');
    const isWebP = fileName.endsWith('.webp') || mimeType.includes('webp');
    
    const isJpeg = fileName.endsWith('.jpg') || 
                   fileName.endsWith('.jpeg') || 
                   mimeType.includes('jpeg') ||
                   (buffer[0] === 0xFF && buffer[1] === 0xD8);

    let exifData = {};
    let processedBuffer = buffer;
    let finalMimeType = photo.mime_type || 'image/jpeg';

    // Extract EXIF data
    try {
      // Fast path: one parse is usually enough.
      exifData = await exifr.parse(buffer, {
        translateKeys: true,
        translateValues: true,
        reviveValues: true,
        sanitize: true
      }) || {};
    } catch (error) {
      console.error('EXIF extraction error:', error.message);
    }
    mark('exif');

    // Process HEIC/HEIF files
    if (isHeic) {
      try {
        // Try sharp first with auto-orientation
        processedBuffer = await sharp(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        console.log('Sharp failed, trying heic-convert:', error.message);
        // Fallback to heic-convert
        try {
          const outputBuffer = await heicConvert({
            buffer: buffer,
            format: 'JPEG',
            quality: 0.9
          });
          // Convert JPEG to WebP with auto-orientation
          processedBuffer = await sharp(outputBuffer)
            .rotate() // Auto-rotate based on EXIF orientation
            .webp({ quality: 90 })
            .toBuffer();
          finalMimeType = 'image/webp';
        } catch (convertError) {
          console.error('HEIC conversion error:', convertError.message);
          throw new Error('Failed to process HEIC file');
        }
      }
    } else if (isRaw || isTiff) {
      // Process RAW and TIFF files
      try {
        processedBuffer = await sharp(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        console.error('RAW/TIFF processing error:', error.message);
        throw new Error('Failed to process RAW/TIFF file');
      }
    } else if (isPng) {
      // Process PNG files
      try {
        processedBuffer = await sharp(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        console.error('PNG processing error:', error.message);
        throw new Error('Failed to process PNG file');
      }
    } else if (!isWebP && !isJpeg) {
      // Convert other formats to WebP
      try {
        processedBuffer = await sharp(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        console.error('Format conversion error:', error.message);
        throw new Error('Failed to process image file');
      }
    } else {
      // For JPEG and WebP, also apply auto-orientation
      processedBuffer = await sharp(buffer)
        .rotate() // Auto-rotate based on EXIF orientation
        .toBuffer();
    }
    mark('normalize');

    // Extract GPS coordinates
    let gps = null;
    if (exifData.latitude && exifData.longitude) {
      gps = {
        latitude: exifData.latitude,
        longitude: exifData.longitude
      };
    } else if (exifData.GPSLatitude && exifData.GPSLongitude) {
      gps = {
        latitude: exifData.GPSLatitude,
        longitude: exifData.GPSLongitude
      };
    }

    // Get location from GPS or caption
    let location = parseLocationFromText(caption);
    if (!location && gps && ENABLE_REVERSE_GEOCODE) {
      location = await reverseGeocode(gps.latitude, gps.longitude);
    }
    mark('location');

    // Extract device info
    const device = exifData.Make && exifData.Model 
      ? `${exifData.Make} ${exifData.Model}`.trim()
      : exifData.Model || exifData.Make || null;

    // Compress and thumbnail in parallel to reduce response latency.
    const [compressedBuffer, thumbnailBuffer] = await Promise.all([
      sharp(processedBuffer)
        .resize(2000, 2000, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: 85, effort: 4 })
        .toBuffer(),
      sharp(processedBuffer)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 4 })
        .toBuffer()
    ]);
    mark('compress');

    // Generate filename using original filename
    let baseFilename = '';
    if (fileName && fileName.trim()) {
      // Use original filename, remove extension and add .webp
      const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');
      // Sanitize filename: remove special characters, keep only alphanumeric, dash, underscore
      const sanitizedName = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_');
      baseFilename = sanitizedName || `photo_${Date.now()}`;
    } else {
      // Fallback if no filename
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 9);
      baseFilename = `photo_${timestamp}_${randomStr}`;
    }
    
    const filename = buildObjectKey(R2_ORIGINALS_PREFIX, `${baseFilename}.webp`);
    const thumbFilename = buildObjectKey(R2_THUMBNAILS_PREFIX, `${baseFilename}.webp`);

    // Step 1: Upload photos to R2 (存照片到 R2)
    console.log('📤 Uploading to R2...');
    console.log(`   Bucket: ${R2_BUCKET}`);
    console.log(`   Main photo: ${filename}`);
    console.log(`   Thumbnail: ${thumbFilename}`);
    
    try {
      const uploadPromises = [
        r2Client.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: filename,
          Body: compressedBuffer,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000'
        })),
        r2Client.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: thumbFilename,
          Body: thumbnailBuffer,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000'
        }))
      ];

      await Promise.all(uploadPromises);
      console.log('✅ Photos uploaded to R2 successfully');
    } catch (uploadError) {
      console.error('❌ R2 Upload Error:', uploadError);
      throw new Error(`Failed to upload to R2: ${uploadError.message}`);
    }
    mark('r2-upload');

    // Step 2: Prepare photo information for Firestore
    const photoUrl = `${R2_PUBLIC_URL}/${filename}`;
    const thumbnailUrl = `${R2_PUBLIC_URL}/${thumbFilename}`;

    // Prepare EXIF data for PhotosPage (匹配 PhotosPage 的數據結構)
    const settings = {};
    if (exifData.FNumber !== undefined) {
      const aperture = formatApertureToOneDecimal(exifData.FNumber);
      if (aperture) settings.aperture = aperture;
    } else if (exifData.ApertureValue !== undefined) {
      const aperture = formatApertureToOneDecimal(exifData.ApertureValue);
      if (aperture) settings.aperture = aperture;
    }
    
    if (exifData.ExposureTime !== undefined) {
      if (exifData.ExposureTime < 1) {
        settings.shutter = `1/${Math.round(1 / exifData.ExposureTime)}s`;
      } else {
        settings.shutter = `${exifData.ExposureTime}s`;
      }
    } else if (exifData.ShutterSpeedValue !== undefined) {
      settings.shutter = `${exifData.ShutterSpeedValue}s`;
    }
    
    if (exifData.ISO !== undefined) settings.iso = `ISO ${exifData.ISO}`;
    else if (exifData.ISOSpeedRatings !== undefined) settings.iso = `ISO ${exifData.ISOSpeedRatings}`;
    
    if (exifData.FocalLength !== undefined) settings.focalLength = `${exifData.FocalLength}mm`;
    
    // Format date for PhotosPage (YYYY-MM-DD HH:mm:ss)
    let dateStr = null;
    if (exifData.DateTimeOriginal) {
      const date = new Date(exifData.DateTimeOriginal);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      dateStr = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    } else if (exifData.CreateDate) {
      const date = new Date(exifData.CreateDate);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      dateStr = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    // Step 3: Prepare data to save in Firestore (存網址和資訊到 Firestore)
    const photoData = {
      // R2 URLs (網址) - 使用 thumbnail 以匹配 PhotosPage
      url: photoUrl,
      thumbnail: thumbnailUrl,  // PhotosPage 使用 thumbnail
      thumbnailUrl: thumbnailUrl,  // 保留以向後兼容
      
      // Timestamp (使用 uploadedAt 以匹配 PhotosPage 的查詢)
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
      
      // Photo info (資訊)
      originalSize: buffer.length,
      compressedSize: compressedBuffer.length,
      compressionRatio: ((1 - compressedBuffer.length / buffer.length) * 100).toFixed(1)
    };

    // Only add fields if they have values (avoid undefined)
    if (device) photoData.device = device;
    if (location) photoData.location = location;
    if (gps) photoData.gps = gps;
    if (dateStr) photoData.date = dateStr;
    if (Object.keys(settings).length > 0) photoData.settings = settings;
    
    // Also keep exif for backward compatibility
    const exifInfo = {};
    if (exifData.FNumber !== undefined) exifInfo.aperture = roundToOneDecimal(exifData.FNumber);
    else if (exifData.ApertureValue !== undefined) exifInfo.aperture = roundToOneDecimal(exifData.ApertureValue);
    if (exifData.ExposureTime !== undefined) exifInfo.shutterSpeed = exifData.ExposureTime;
    else if (exifData.ShutterSpeedValue !== undefined) exifInfo.shutterSpeed = exifData.ShutterSpeedValue;
    if (exifData.ISO !== undefined) exifInfo.iso = exifData.ISO;
    else if (exifData.ISOSpeedRatings !== undefined) exifInfo.iso = exifData.ISOSpeedRatings;
    if (exifData.FocalLength !== undefined) exifInfo.focalLength = exifData.FocalLength;
    if (exifData.DateTimeOriginal !== undefined) exifInfo.dateTaken = exifData.DateTimeOriginal;
    else if (exifData.CreateDate !== undefined) exifInfo.dateTaken = exifData.CreateDate;
    if (Object.keys(exifInfo).length > 0) photoData.exif = exifInfo;

    // Step 4: Save to Firestore (存到 Firestore)
    console.log('💾 Saving to Firestore...');
    await db.collection('photos').add(photoData);
    console.log('✅ Saved to Firestore');
    mark('firestore-write');

    // Send confirmation message
    const exifCount = Object.keys(exifData).length;
    const message = `✅ Photo uploaded successfully!\n\n` +
      `📊 Compression: ${photoData.compressionRatio}% smaller\n` +
      (device ? `📷 Device: ${device}\n` : '') +
      (location ? `📍 Location: ${location}\n` : '') +
      (gps ? `🗺️ GPS: ${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}\n` : '') +
      `📋 EXIF keys: ${exifCount}\n\n` +
      `💡 Tip: To preserve EXIF data, send photos as files instead of images.`;
    mark('total');

    return message;
  } catch (error) {
    console.error('Photo processing error:', error);
    throw error;
  }
}

// Initialize bot
function initialize(bot) {
  bot.use(async (ctx, next) => {
    const updateType = ctx.updateType || 'unknown';
    const fromId = ctx.from?.id || 'unknown';
    const chatId = ctx.chat?.id || 'unknown';
    console.log(`📩 Update received: type=${updateType} from=${fromId} chat=${chatId}`);
    return next();
  });

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
      const message = await processPhoto(photo, caption, ctx);
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
        const message = await processPhoto(doc, ctx.message.caption || '', ctx);
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
