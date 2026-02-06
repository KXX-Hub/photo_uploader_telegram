require('dotenv').config();
const admin = require('firebase-admin');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
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

// Extract file path from URL
function extractFilePath(url) {
  if (!url) return null;
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.substring(1);
  } catch (e) {
    return url.startsWith('/') ? url.substring(1) : url;
  }
}

async function deletePhoto() {
  try {
    console.log('🔍 Searching for photo...\n');
    
    // Search for photo with Apple iPhone 17 Pro in Champaign
    const photosRef = db.collection('photos');
    const snapshot = await photosRef
      .where('device', '==', 'Apple iPhone 17 Pro')
      .where('location', '==', 'Champaign, United States')
      .get();
    
    if (snapshot.empty) {
      console.log('❌ No photo found matching: Apple iPhone 17 Pro in Champaign, United States');
      console.log('🔍 Trying broader search...\n');
      
      // Try searching by location only
      const locationSnapshot = await photosRef
        .where('location', '==', 'Champaign, United States')
        .orderBy('uploadedAt', 'desc')
        .limit(5)
        .get();
      
      if (locationSnapshot.empty) {
        console.log('❌ No photos found in Champaign, United States');
        return;
      }
      
      console.log(`📋 Found ${locationSnapshot.size} photos in Champaign, United States:\n`);
      locationSnapshot.forEach((doc) => {
        const data = doc.data();
        console.log(`  ID: ${doc.id}`);
        console.log(`  Device: ${data.device || 'N/A'}`);
        console.log(`  Date: ${data.date || 'N/A'}`);
        console.log(`  URL: ${data.url || 'N/A'}`);
        console.log('');
      });
      
      // Delete the first one (most recent)
      const firstDoc = locationSnapshot.docs[0];
      const photoData = firstDoc.data();
      
      console.log(`🗑️  Deleting photo: ${firstDoc.id}\n`);
      
      // Delete from Firestore
      await db.collection('photos').doc(firstDoc.id).delete();
      console.log(`✅ Deleted from Firestore: ${firstDoc.id}`);
      
      // Delete from R2
      const filesToDelete = [];
      if (photoData.url) {
        const filePath = extractFilePath(photoData.url);
        if (filePath) filesToDelete.push(filePath);
      }
      if (photoData.thumbnail) {
        const thumbPath = extractFilePath(photoData.thumbnail);
        if (thumbPath) filesToDelete.push(thumbPath);
      } else if (photoData.thumbnailUrl) {
        const thumbPath = extractFilePath(photoData.thumbnailUrl);
        if (thumbPath) filesToDelete.push(thumbPath);
      }
      
      for (const filePath of filesToDelete) {
        try {
          await r2Client.send(new DeleteObjectCommand({
            Bucket: R2_BUCKET,
            Key: filePath
          }));
          console.log(`  ✅ Deleted from R2: ${filePath}`);
        } catch (r2Error) {
          console.log(`  ⚠️  Failed to delete from R2: ${filePath} - ${r2Error.message}`);
        }
      }
      
      console.log('\n✅ Photo deleted successfully!');
      return;
    }
    
    // Found exact match - delete all matching photos
    const deletePromises = [];
    snapshot.forEach((doc) => {
      const photoData = doc.data();
      console.log(`🗑️  Found photo to delete: ${doc.id}`);
      console.log(`  Device: ${photoData.device}`);
      console.log(`  Location: ${photoData.location}`);
      console.log(`  Date: ${photoData.date || 'N/A'}\n`);
      
      deletePromises.push((async () => {
        // Delete from Firestore
        await db.collection('photos').doc(doc.id).delete();
        console.log(`✅ Deleted from Firestore: ${doc.id}`);
        
        // Delete from R2
        const filesToDelete = [];
        if (photoData.url) {
          const filePath = extractFilePath(photoData.url);
          if (filePath) filesToDelete.push(filePath);
        }
        if (photoData.thumbnail) {
          const thumbPath = extractFilePath(photoData.thumbnail);
          if (thumbPath) filesToDelete.push(thumbPath);
        } else if (photoData.thumbnailUrl) {
          const thumbPath = extractFilePath(photoData.thumbnailUrl);
          if (thumbPath) filesToDelete.push(thumbPath);
        }
        
        for (const filePath of filesToDelete) {
          try {
            await r2Client.send(new DeleteObjectCommand({
              Bucket: R2_BUCKET,
              Key: filePath
            }));
            console.log(`  ✅ Deleted from R2: ${filePath}`);
          } catch (r2Error) {
            console.log(`  ⚠️  Failed to delete from R2: ${filePath} - ${r2Error.message}`);
          }
        }
      })());
    });
    
    await Promise.all(deletePromises);
    
    console.log('\n✅ Photo deleted successfully!');
    
  } catch (error) {
    console.error('❌ Error deleting photo:', error);
  } finally {
    process.exit(0);
  }
}

deletePhoto();
