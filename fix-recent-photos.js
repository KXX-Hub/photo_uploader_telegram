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

async function fixRecentPhotos() {
  try {
    console.log('🔍 Checking recent photos...\n');
    
    const photosRef = db.collection('photos');
    // Get recent photos - try uploadedAt first, fallback to getting all and sorting
    let snapshot;
    try {
      snapshot = await photosRef.orderBy('uploadedAt', 'desc').limit(20).get();
    } catch (e) {
      // If orderBy fails, get all and sort manually
      snapshot = await photosRef.get();
    }
    
    if (snapshot.empty) {
      console.log('❌ No photos found');
      return;
    }
    
    const photosToFix = [];
    const photosToDelete = [];
    
    snapshot.forEach((doc) => {
      const data = doc.data();
      const issues = [];
      
      // Check for missing thumbnail
      if (!data.thumbnail && !data.thumbnailUrl) {
        issues.push('Missing thumbnail');
      }
      
      // Check for missing uploadedAt
      if (!data.uploadedAt) {
        issues.push('Missing uploadedAt');
      }
      
      // Check if URL is valid
      if (!data.url || !data.url.includes('r2.dev')) {
        issues.push('Invalid or missing URL');
      }
      
      if (issues.length > 0) {
        photosToFix.push({
          id: doc.id,
          data: data,
          issues: issues
        });
      }
    });
    
    if (photosToFix.length === 0) {
      console.log('✅ All photos look good!');
      return;
    }
    
    console.log(`⚠️  Found ${photosToFix.length} photos with issues:\n`);
    
    photosToFix.forEach((photo, index) => {
      console.log(`Photo ${index + 1}:`);
      console.log(`  ID: ${photo.id}`);
      console.log(`  URL: ${photo.data.url || 'N/A'}`);
      console.log(`  Issues: ${photo.issues.join(', ')}`);
      console.log(`  Has thumbnail: ${photo.data.thumbnail ? 'Yes' : photo.data.thumbnailUrl ? 'Yes (old field)' : 'No'}`);
      console.log(`  Has uploadedAt: ${photo.data.uploadedAt ? 'Yes' : 'No'}`);
      console.log('');
    });
    
    // Decide: if photos are missing critical fields and can't be fixed, delete them
    // Otherwise, try to fix them
    const canFix = photosToFix.every(p => {
      // Can fix if has URL and either has thumbnailUrl or can generate thumbnail
      return p.data.url && (p.data.thumbnailUrl || p.data.url);
    });
    
    if (!canFix) {
      console.log('❌ Some photos cannot be fixed (missing critical data).');
      console.log('🗑️  Deleting photos that cannot be fixed...\n');
      
      for (const photo of photosToFix) {
        if (!photo.data.url || !photo.data.url.includes('r2.dev')) {
          console.log(`  Deleting ${photo.id} (invalid URL)`);
          await db.collection('photos').doc(photo.id).delete();
          photosToDelete.push(photo.id);
        }
      }
    }
    
    // Fix photos that can be fixed
    console.log('🔧 Fixing photos...\n');
    let fixedCount = 0;
    
    for (const photo of photosToFix) {
      if (photosToDelete.includes(photo.id)) continue;
      
      const updates = {};
      let needsUpdate = false;
      
      // Fix thumbnail field
      if (!photo.data.thumbnail && photo.data.thumbnailUrl) {
        updates.thumbnail = photo.data.thumbnailUrl;
        needsUpdate = true;
      } else if (!photo.data.thumbnail && photo.data.url) {
        // Generate thumbnail URL from main URL (if possible)
        // For now, use the main URL as thumbnail
        updates.thumbnail = photo.data.url;
        needsUpdate = true;
      }
      
      // Fix uploadedAt field
      if (!photo.data.uploadedAt) {
        if (photo.data.timestamp) {
          // Use existing timestamp
          if (photo.data.timestamp.toDate) {
            updates.uploadedAt = photo.data.timestamp;
          } else {
            updates.uploadedAt = admin.firestore.FieldValue.serverTimestamp();
          }
        } else {
          // Use server timestamp
          updates.uploadedAt = admin.firestore.FieldValue.serverTimestamp();
        }
        needsUpdate = true;
      }
      
      if (needsUpdate) {
        try {
          await db.collection('photos').doc(photo.id).update(updates);
          console.log(`  ✅ Fixed photo ${photo.id}`);
          fixedCount++;
        } catch (error) {
          console.log(`  ❌ Failed to fix photo ${photo.id}: ${error.message}`);
        }
      }
    }
    
    console.log(`\n✅ Fixed ${fixedCount} photos`);
    if (photosToDelete.length > 0) {
      console.log(`🗑️  Deleted ${photosToDelete.length} photos that couldn't be fixed`);
    }
    
  } catch (error) {
    console.error('❌ Error fixing photos:', error);
  } finally {
    process.exit(0);
  }
}

fixRecentPhotos();
