// Photo pipeline shared by the upload server and the Telegram bot:
// EXIF reading, format conversion, WebP compression, R2 storage and Firestore.
// Needs Firebase Admin and R2 credentials only (no Telegram token).
const admin = require('firebase-admin');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const exifr = require('exifr');
const { Worker } = require('worker_threads');
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

// Decoding limits. A small file can describe an enormous image (a
// "decompression bomb"); sharp refuses anything over ~50 megapixels, and every
// format is downscaled to the 2000px output size as soon as it's decoded.
const MAX_INPUT_PIXELS = 50 * 1000 * 1000;
const MAX_EDGE = 2000;
const SHARP_OPTS = { limitInputPixels: MAX_INPUT_PIXELS };
const decode = (input) => sharp(input, SHARP_OPTS);

// Errors whose message is safe to show to the person uploading.
function userError(message, statusCode = 400) {
  const err = new Error(message);
  err.publicMessage = message;
  err.statusCode = statusCode;
  return err;
}

// Coordinates are stored at ~100 m precision (3 decimals): photo documents are
// publicly readable, and an exact position could reveal a home address.
function coarseGps(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { latitude: Math.round(la * 1000) / 1000, longitude: Math.round(lo * 1000) / 1000 };
}

// Largest image any item in a HEIF container declares: every image item
// (primary, tiles, thumbnails, alpha/depth) has an 'ispe' property — 4-byte
// size, 'ispe', 4 bytes of version/flags, then width and height. Used as a
// container-wide budget check alongside libheif's own primary-image size.
function heifMaxDeclaredPixels(buffer) {
  let max = 0;
  for (let i = buffer.indexOf('ispe'); i !== -1; i = buffer.indexOf('ispe', i + 4)) {
    if (i < 4 || i + 16 > buffer.length) continue;
    max = Math.max(max, buffer.readUInt32BE(i + 8) * buffer.readUInt32BE(i + 12));
  }
  return max;
}

// Decodes HEIC/HEIF with libheif when sharp's build can't. The largest size
// declared anywhere in the container must be within the pixel budget before
// any decoding starts; the worker then checks libheif's own output size for
// the primary image (for tiled images, the full grid) before decoding pixels.
// Each file gets its own worker, which is always ended afterwards, so libheif's
// WASM memory never outlives the upload. The RGBA result then goes through the
// same limited sharp path as everything else.
const HEIC_TIMEOUT_MS = 60 * 1000;

async function decodeHeic(buffer) {
  if (heifMaxDeclaredPixels(buffer) > MAX_INPUT_PIXELS) {
    throw userError('This image is too large (over 50 megapixels).');
  }
  const worker = new Worker(path.join(__dirname, 'heic-worker.js'), {
    workerData: { buffer, maxPixels: MAX_INPUT_PIXELS }
  });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('HEIC decode timed out')), HEIC_TIMEOUT_MS);
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error(`HEIC worker exited with code ${code}`)));
    });
    if (result.error === 'too-large') throw userError('This image is too large (over 50 megapixels).');
    if (result.error === 'empty') throw userError('No image found in this HEIC file.');
    if (result.error) throw userError('Could not read this HEIC file. It may be damaged.');
    const { width, height, pixels } = result;
    return sharp(Buffer.from(pixels), { ...SHARP_OPTS, raw: { width, height, channels: 4 } });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

const clip = (value, max = 100) => String(value || '').trim().slice(0, max);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

// Turn a public R2 URL back into its object key (for photos saved before
// storagePath/thumbnailPath were recorded).
function objectKeyFromUrl(url) {
  if (!url) return null;
  if (R2_PUBLIC_URL && url.startsWith(`${R2_PUBLIC_URL}/`)) {
    return decodeURIComponent(url.slice(R2_PUBLIC_URL.length + 1));
  }
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, '')) || null;
  } catch {
    return null;
  }
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
    return locationMatch[1].trim().slice(0, 100);
  }
  return null;
}

// Core photo processing — accepts a buffer directly (used by both Telegram bot and web upload)
async function processPhotoBuffer(buffer, fileName, mimeType, caption, exifOverrides = {}) {
  fileName = (fileName || '').toLowerCase();
  mimeType = (mimeType || '').toLowerCase();

  try {
    const t0 = Date.now();
    const mark = (label) => console.log(`⏱️ ${label}: ${Date.now() - t0}ms`);
    
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
    let finalMimeType = mimeType || 'image/jpeg';

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
        processedBuffer = await decode(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        // sharp refused it for size: never retry with a decoder that has no limit.
        if (/pixel limit/i.test(error.message)) {
          throw userError('This image is too large (over 50 megapixels).');
        }
        console.log('Sharp failed, trying heic-convert:', error.message);
        // Fallback: libheif, size-checked from its own header parse.
        try {
          // libheif already applies the image's rotation/mirroring.
          processedBuffer = await (await decodeHeic(buffer))
            .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 90 })
            .toBuffer();
          finalMimeType = 'image/webp';
        } catch (convertError) {
          console.error('HEIC conversion error:', convertError.message);
          if (convertError.publicMessage) throw convertError;
          throw userError('Could not read this HEIC file. It may be damaged or too large.');
        }
      }
    } else if (isRaw || isTiff) {
      // Process RAW and TIFF files
      try {
        processedBuffer = await decode(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        console.error('RAW/TIFF processing error:', error.message);
        throw userError('Could not read this RAW/TIFF file. It may be damaged or too large.');
      }
    } else if (isPng) {
      // Process PNG files
      try {
        processedBuffer = await decode(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        console.error('PNG processing error:', error.message);
        throw userError('Could not read this PNG file. It may be damaged or too large.');
      }
    } else if (!isWebP && !isJpeg) {
      // Convert other formats to WebP
      try {
        processedBuffer = await decode(buffer)
          .rotate() // Auto-rotate based on EXIF orientation
          .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 90 })
          .toBuffer();
        finalMimeType = 'image/webp';
      } catch (error) {
        console.error('Format conversion error:', error.message);
        throw userError('Could not read this image file. It may be damaged or too large.');
      }
    } else {
      // For JPEG and WebP, also apply auto-orientation
      processedBuffer = await decode(buffer)
        .rotate() // Auto-rotate based on EXIF orientation
          .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .toBuffer();
    }
    mark('normalize');

    // Extract GPS coordinates (stored coarse; see coarseGps)
    let gps = null;
    if (exifData.latitude && exifData.longitude) {
      gps = coarseGps(exifData.latitude, exifData.longitude);
    }

    // Get location from GPS or caption
    let location = parseLocationFromText(caption);
    if (!location && gps && ENABLE_REVERSE_GEOCODE) {
      location = await reverseGeocode(gps.latitude, gps.longitude);
    }
    mark('location');

    // Extract device info
    let device = exifData.Make && exifData.Model
      ? `${exifData.Make} ${exifData.Model}`.trim()
      : exifData.Model || exifData.Make || null;

    // Compress and thumbnail in parallel to reduce response latency.
    const [compressedBuffer, thumbnailBuffer] = await Promise.all([
      decode(processedBuffer)
        .resize(2000, 2000, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: 85, effort: 4 })
        .toBuffer(),
      decode(processedBuffer)
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
      const sanitizedName = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
      // Suffix keeps a re-uploaded file name from overwriting an existing photo in R2.
      const uniqueSuffix = `${Date.now().toString(36)}${Math.random().toString(36).substring(2, 6)}`;
      baseFilename = sanitizedName ? `${sanitizedName}_${uniqueSuffix}` : `photo_${Date.now()}`;
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
      throw userError('Could not store the photo. Try again in a minute.', 502);
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

    // Apply client-provided EXIF overrides (fallback for formats where buffer EXIF is unavailable)
    // Overrides are untrusted text: length-capped and format-checked.
    if (!device && exifOverrides.device) device = clip(exifOverrides.device, 80);
    if (!dateStr && DATE_PATTERN.test(clip(exifOverrides.date, 19))) dateStr = clip(exifOverrides.date, 19);
    if (!settings.aperture && exifOverrides.aperture) settings.aperture = clip(exifOverrides.aperture, 12);
    if (!settings.shutter && exifOverrides.shutter) settings.shutter = clip(exifOverrides.shutter, 12);
    if (!settings.iso && /^\d{1,6}$/.test(clip(exifOverrides.iso, 6))) settings.iso = `ISO ${clip(exifOverrides.iso, 6)}`;
    if (!settings.focalLength && exifOverrides.focalLength) settings.focalLength = clip(exifOverrides.focalLength, 12);
    if (!gps && exifOverrides.latitude != null && exifOverrides.longitude != null) {
      const lat = parseFloat(exifOverrides.latitude);
      const lon = parseFloat(exifOverrides.longitude);
      gps = coarseGps(lat, lon);
      if (gps && !location && ENABLE_REVERSE_GEOCODE) {
        location = await reverseGeocode(gps.latitude, gps.longitude);
      }
    }

    // Step 3: Prepare data to save in Firestore (存網址和資訊到 Firestore)
    const photoData = {
      // R2 URLs (網址) - 使用 thumbnail 以匹配 PhotosPage
      url: photoUrl,
      thumbnail: thumbnailUrl,  // PhotosPage 使用 thumbnail
      thumbnailUrl: thumbnailUrl,  // 保留以向後兼容
      storageProvider: 'r2',
      storagePath: filename,
      thumbnailPath: thumbFilename,
      
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
    const docRef = await db.collection('photos').add(photoData);
    console.log('✅ Saved to Firestore');
    mark('firestore-write');

    // Build result message
    const exifCount = Object.keys(exifData).length;
    const message = `✅ Photo uploaded successfully!\n\n` +
      `📊 Compression: ${photoData.compressionRatio}% smaller\n` +
      (device ? `📷 Device: ${device}\n` : '') +
      (location ? `📍 Location: ${location}\n` : '') +
      (gps ? `🗺️ GPS: ${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}\n` : '') +
      `📋 EXIF keys: ${exifCount}\n\n` +
      `💡 Tip: To preserve EXIF data, send photos as files instead of images.`;
    mark('total');

    return { message, id: docRef.id };
  } catch (error) {
    console.error('Photo processing error:', error);
    throw error;
  }
}

// Delete a photo everywhere: both R2 objects, then the Firestore document.
async function deletePhoto(photoId) {
  const ref = db.collection('photos').doc(photoId);
  const snap = await ref.get();
  if (!snap.exists) {
    const err = new Error('Photo not found');
    err.publicMessage = 'Photo not found';
    err.statusCode = 404;
    throw err;
  }

  const data = snap.data();
  const keys = [];
  if (data.storageProvider !== 'firebase') {
    const mainKey = data.storagePath || objectKeyFromUrl(data.url);
    const thumbKey = data.thumbnailPath || objectKeyFromUrl(data.thumbnail || data.thumbnailUrl);
    // Only delete objects this service created, so a tampered document can't
    // point a delete at anything else in the bucket.
    const ownPrefixes = [`${buildObjectKey(R2_ORIGINALS_PREFIX, '')}/`, `${buildObjectKey(R2_THUMBNAILS_PREFIX, '')}/`];
    const isOwnKey = (key) => typeof key === 'string' && !key.includes('..') && ownPrefixes.some((prefix) => key.startsWith(prefix));
    if (isOwnKey(mainKey)) keys.push(mainKey);
    if (isOwnKey(thumbKey) && thumbKey !== mainKey) keys.push(thumbKey);
  }

  await Promise.all(keys.map((Key) => r2Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key }))));
  await ref.delete();
  console.log(`🗑️ Deleted photo ${photoId} (R2 objects: ${keys.join(', ') || 'none'})`);
  return { id: photoId, deletedObjects: keys };
}

module.exports = {
  processPhotoBuffer,
  deletePhoto,
  admin,
  db
};
