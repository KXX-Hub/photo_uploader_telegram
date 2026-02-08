require('dotenv').config({ path: '/Users/hongzhikai/Desktop/kxx-profile/photo_uploader_telegram/.env' });

const admin = require('firebase-admin');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const path = require('path');

const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-admin-key.json';
const resolvedServiceAccountPath = path.isAbsolute(serviceAccountPath)
  ? serviceAccountPath
  : path.resolve('/Users/hongzhikai/Desktop/kxx-profile/photo_uploader_telegram', serviceAccountPath);

if (!admin.apps.length) {
  const serviceAccount = require(resolvedServiceAccountPath);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();
const bucket = (process.env.R2_BUCKET_NAME || '').split('/').filter(Boolean)[0];

const r2Client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function listAllObjects() {
  let token;
  const keys = [];
  do {
    const res = await r2Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));

    for (const obj of (res.Contents || [])) {
      keys.push(obj.Key);
    }

    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  return keys;
}

async function deleteR2Objects(keys) {
  if (!keys.length) return 0;
  let deleted = 0;

  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await r2Client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: chunk.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));
    deleted += chunk.length;
  }

  return deleted;
}

async function deleteFirestorePhotos() {
  const snapshot = await db.collection('photos').get();
  if (snapshot.empty) return 0;

  let deleted = 0;
  const docs = snapshot.docs;

  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    const chunk = docs.slice(i, i + 400);
    chunk.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += chunk.length;
  }

  return deleted;
}

(async () => {
  console.log('🧹 Reset start...');

  const [r2Keys, firestoreDeleted] = await Promise.all([
    listAllObjects(),
    deleteFirestorePhotos(),
  ]);

  const r2Deleted = await deleteR2Objects(r2Keys);

  console.log(`✅ Firestore photos deleted: ${firestoreDeleted}`);
  console.log(`✅ R2 objects deleted: ${r2Deleted}`);
  console.log('🎉 Reset complete. You can re-upload now.');
})().catch((err) => {
  console.error('❌ Reset failed:', err.message || err);
  process.exit(1);
});
