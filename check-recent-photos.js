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

async function checkRecentPhotos() {
  try {
    console.log('🔍 Checking recent photos for issues...\n');
    
    const photosRef = db.collection('photos');
    const snapshot = await photosRef.orderBy('uploadedAt', 'desc').limit(20).get();
    
    if (snapshot.empty) {
      console.log('❌ No photos found');
      return;
    }
    
    const issues = [];
    const photosToFix = [];
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      const issuesForPhoto = [];
      
      // Check for missing thumbnail
      if (!data.thumbnail && !data.thumbnailUrl) {
        issuesForPhoto.push('Missing thumbnail');
      } else if (data.thumbnailUrl && !data.thumbnail) {
        issuesForPhoto.push('Has thumbnailUrl but missing thumbnail field');
      }
      
      // Check for missing uploadedAt
      if (!data.uploadedAt) {
        issuesForPhoto.push('Missing uploadedAt');
      }
      
      // Check for old timestamp field
      if (data.timestamp && !data.uploadedAt) {
        issuesForPhoto.push('Has old timestamp field instead of uploadedAt');
      }
      
      if (issuesForPhoto.length > 0) {
        issues.push({
          id: doc.id,
          url: data.url,
          issues: issuesForPhoto,
          data: data
        });
        photosToFix.push({ id: doc.id, data: data });
      }
    });
    
    if (issues.length === 0) {
      console.log('✅ All recent photos look good!');
      return;
    }
    
    console.log(`⚠️  Found ${issues.length} photos with issues:\n`);
    
    issues.forEach((issue, index) => {
      console.log(`Photo ${index + 1}:`);
      console.log(`  ID: ${issue.id}`);
      console.log(`  URL: ${issue.url || 'N/A'}`);
      console.log(`  Issues: ${issue.issues.join(', ')}`);
      console.log(`  Has thumbnail: ${issue.data.thumbnail ? 'Yes' : issue.data.thumbnailUrl ? 'Yes (thumbnailUrl)' : 'No'}`);
      console.log(`  Has uploadedAt: ${issue.data.uploadedAt ? 'Yes' : 'No'}`);
      console.log(`  Has timestamp: ${issue.data.timestamp ? 'Yes' : 'No'}`);
      console.log('');
    });
    
    console.log(`\n📋 Summary: ${issues.length} photos need fixing`);
    console.log(`\nOptions:`);
    console.log(`1. Fix these photos (update missing fields)`);
    console.log(`2. Delete these photos`);
    
    return { issues, photosToFix };
    
  } catch (error) {
    console.error('❌ Error checking photos:', error);
  } finally {
    process.exit(0);
  }
}

checkRecentPhotos();
