require('dotenv').config();
const admin = require('firebase-admin');
const { S3Client, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const path = require('path');

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    const possiblePaths = [
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
      './firebase-admin-key.json',
      '../firebase-admin-key.json',
      path.join(__dirname, 'firebase-admin-key.json')
    ].filter(Boolean);
    
    let serviceAccount = null;
    let loadedPath = null;
    
    for (const serviceAccountPath of possiblePaths) {
      try {
        serviceAccount = require(serviceAccountPath);
        loadedPath = serviceAccountPath;
        break;
      } catch (e) {
        // Try next path
      }
    }
    
    if (!serviceAccount) {
      throw new Error(`Could not find firebase-admin-key.json`);
    }
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error('❌ Error loading Firebase service account:', error.message);
    process.exit(1);
  }
}

const db = admin.firestore();

// Initialize R2 Client
const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const R2_BUCKET = process.env.R2_BUCKET_NAME;

// Check if photo can be displayed on webpage
function canDisplayOnWebpage(photo) {
  // Must have url
  if (!photo.url) {
    return false;
  }
  
  // Must have thumbnail (or thumbnailUrl as fallback)
  if (!photo.thumbnail && !photo.thumbnailUrl) {
    return false;
  }
  
  // Must have uploadedAt or timestamp for sorting (can be Timestamp object)
  if (!photo.uploadedAt && !photo.timestamp) {
    return false;
  }
  
  return true;
}

// Extract file path from URL
function extractFilePath(url) {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    // Remove leading slash
    return urlObj.pathname.substring(1);
  } catch (e) {
    // If not a valid URL, assume it's already a path
    return url.startsWith('/') ? url.substring(1) : url;
  }
}

async function cleanupPhotos() {
  try {
    console.log('🔍 Checking photos in Firestore...\n');
    
    const photosRef = db.collection('photos');
    const snapshot = await photosRef.get();
    
    if (snapshot.empty) {
      console.log('❌ No photos found in Firestore');
      return;
    }
    
    console.log(`📊 Total photos in Firestore: ${snapshot.size}\n`);
    
    const photosToDelete = [];
    const validPhotos = [];
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (canDisplayOnWebpage(data)) {
        validPhotos.push({ id: doc.id, ...data });
      } else {
        photosToDelete.push({ id: doc.id, ...data });
      }
    });
    
    console.log(`✅ Valid photos (can display): ${validPhotos.length}`);
    console.log(`❌ Invalid photos (cannot display): ${photosToDelete.length}\n`);
    
    if (photosToDelete.length === 0) {
      console.log('✅ All photos are valid! No cleanup needed.');
      return;
    }
    
    console.log('📋 Photos to delete:');
    photosToDelete.forEach((photo, index) => {
      console.log(`  ${index + 1}. ID: ${photo.id}`);
      console.log(`     URL: ${photo.url || 'MISSING'}`);
      console.log(`     Thumbnail: ${photo.thumbnail || photo.thumbnailUrl || 'MISSING'}`);
      console.log(`     UploadedAt: ${photo.uploadedAt || photo.timestamp || 'MISSING'}`);
    });
    
    console.log('\n🗑️  Starting cleanup...\n');
    
    let deletedFromFirestore = 0;
    let deletedFromR2 = 0;
    let r2Errors = 0;
    
    for (const photo of photosToDelete) {
      try {
        // Delete from Firestore
        await db.collection('photos').doc(photo.id).delete();
        deletedFromFirestore++;
        console.log(`✅ Deleted from Firestore: ${photo.id}`);
        
        // Delete from R2
        const filesToDelete = [];
        
        if (photo.url) {
          const filePath = extractFilePath(photo.url);
          if (filePath) filesToDelete.push(filePath);
        }
        
        if (photo.thumbnail) {
          const thumbPath = extractFilePath(photo.thumbnail);
          if (thumbPath) filesToDelete.push(thumbPath);
        } else if (photo.thumbnailUrl) {
          const thumbPath = extractFilePath(photo.thumbnailUrl);
          if (thumbPath) filesToDelete.push(thumbPath);
        }
        
        // Delete files from R2
        for (const filePath of filesToDelete) {
          try {
            await r2Client.send(new DeleteObjectCommand({
              Bucket: R2_BUCKET,
              Key: filePath
            }));
            deletedFromR2++;
            console.log(`  ✅ Deleted from R2: ${filePath}`);
          } catch (r2Error) {
            r2Errors++;
            console.log(`  ⚠️  Failed to delete from R2: ${filePath} - ${r2Error.message}`);
          }
        }
      } catch (error) {
        console.error(`❌ Error deleting photo ${photo.id}:`, error.message);
      }
    }
    
    console.log('\n📊 Cleanup Summary:');
    console.log(`  ✅ Deleted from Firestore: ${deletedFromFirestore}`);
    console.log(`  ✅ Deleted from R2: ${deletedFromR2}`);
    if (r2Errors > 0) {
      console.log(`  ⚠️  R2 deletion errors: ${r2Errors}`);
    }
    console.log(`\n✅ Cleanup completed!`);
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  } finally {
    process.exit(0);
  }
}

cleanupPhotos();
