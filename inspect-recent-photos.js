require('dotenv').config();
const admin = require('firebase-admin');
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
    
    for (const serviceAccountPath of possiblePaths) {
      try {
        serviceAccount = require(serviceAccountPath);
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

async function inspectRecentPhotos() {
  try {
    console.log('🔍 Inspecting recent photos (last 10)...\n');
    
    const photosRef = db.collection('photos');
    let snapshot;
    
    // Try to get photos ordered by uploadedAt
    try {
      snapshot = await photosRef.orderBy('uploadedAt', 'desc').limit(10).get();
    } catch (e) {
      // If that fails, get all and take first 10
      const allSnapshot = await photosRef.get();
      const docs = allSnapshot.docs;
      // Sort by ID (newest first) as fallback
      docs.sort((a, b) => b.id.localeCompare(a.id));
      snapshot = { docs: docs.slice(0, 10), empty: docs.length === 0 };
    }
    
    if (snapshot.empty || snapshot.docs.length === 0) {
      console.log('❌ No photos found');
      return;
    }
    
    console.log(`Found ${snapshot.docs.length} recent photos:\n`);
    
    const photosWithIssues = [];
    
    snapshot.docs.forEach((doc, index) => {
      const data = doc.data();
      const issues = [];
      
      // Check fields
      if (!data.thumbnail && !data.thumbnailUrl) {
        issues.push('❌ Missing thumbnail');
      }
      if (!data.uploadedAt) {
        issues.push('❌ Missing uploadedAt');
      }
      if (!data.url) {
        issues.push('❌ Missing URL');
      }
      
      console.log(`Photo ${index + 1}:`);
      console.log(`  ID: ${doc.id}`);
      console.log(`  URL: ${data.url || 'N/A'}`);
      console.log(`  Thumbnail: ${data.thumbnail ? '✅' : data.thumbnailUrl ? '⚠️ (thumbnailUrl)' : '❌'}`);
      console.log(`  uploadedAt: ${data.uploadedAt ? '✅' : '❌'}`);
      console.log(`  Device: ${data.device || 'N/A'}`);
      console.log(`  Location: ${data.location || 'N/A'}`);
      
      if (issues.length > 0) {
        console.log(`  Issues: ${issues.join(', ')}`);
        photosWithIssues.push({ id: doc.id, data: data, issues: issues });
      }
      console.log('');
    });
    
    if (photosWithIssues.length > 0) {
      console.log(`\n⚠️  Found ${photosWithIssues.length} photos with issues`);
      console.log('\nOptions:');
      console.log('1. Fix these photos (add missing fields)');
      console.log('2. Delete these photos');
      console.log('\nRun: node fix-recent-photos.js to fix them');
    } else {
      console.log('✅ All recent photos look good!');
    }
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    process.exit(0);
  }
}

inspectRecentPhotos();
