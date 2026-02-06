require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
if (!admin.apps.length) {
  try {
    // Try multiple possible paths
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
      throw new Error(`Could not find firebase-admin-key.json in: ${possiblePaths.join(', ')}`);
    }
    
    console.log(`✅ Loaded Firebase service account from: ${loadedPath}`);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  } catch (error) {
    console.error('❌ Error loading Firebase service account:', error.message);
    process.exit(1);
  }
}

const db = admin.firestore();

async function checkPhotos() {
  try {
    console.log('🔍 Checking Firestore photos collection...\n');
    
    const photosRef = db.collection('photos');
    // Try to order by uploadedAt first, fallback to timestamp
    let snapshot;
    try {
      snapshot = await photosRef.orderBy('uploadedAt', 'desc').limit(10).get();
    } catch (e) {
      try {
        snapshot = await photosRef.orderBy('timestamp', 'desc').limit(10).get();
      } catch (e2) {
        snapshot = await photosRef.limit(10).get();
      }
    }
    
    if (snapshot.empty) {
      console.log('❌ No photos found in Firestore');
      return;
    }
    
    console.log(`✅ Found ${snapshot.size} recent photos:\n`);
    
    snapshot.forEach((doc, index) => {
      const data = doc.data();
      console.log(`Photo ${index + 1}:`);
      console.log(`  ID: ${doc.id}`);
      console.log(`  URL: ${data.url || 'N/A'}`);
      console.log(`  Thumbnail: ${data.thumbnailUrl || 'N/A'}`);
      console.log(`  Device: ${data.device || 'N/A'}`);
      console.log(`  Location: ${data.location || 'N/A'}`);
      console.log(`  Timestamp: ${data.timestamp?.toDate?.() || data.timestamp || 'N/A'}`);
      console.log(`  Size: ${data.compressedSize ? (data.compressedSize / 1024).toFixed(2) + ' KB' : 'N/A'}`);
      console.log('');
    });
    
    // Check total count
    const allPhotos = await photosRef.get();
    console.log(`📊 Total photos in Firestore: ${allPhotos.size}`);
    
  } catch (error) {
    console.error('❌ Error checking photos:', error);
  } finally {
    process.exit(0);
  }
}

checkPhotos();
