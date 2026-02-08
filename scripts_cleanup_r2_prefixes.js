require('dotenv').config({ path: '/Users/hongzhikai/Desktop/kxx-profile/photo_uploader_telegram/.env' });
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucket = (process.env.R2_BUCKET_NAME || '').split('/').filter(Boolean)[0];
const prefixes = ['kxx-photos/', 'photos/', 'photo/'];

async function listAll(prefix) {
  let token;
  const keys = [];
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    (res.Contents || []).forEach((o) => keys.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteBatch(keys) {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await client.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: chunk.map((Key) => ({ Key })),
        Quiet: true,
      },
    }));
  }
}

(async () => {
  let totalDeleted = 0;
  for (const prefix of prefixes) {
    const keys = await listAll(prefix);
    if (!keys.length) {
      console.log(`${prefix} => 0 objects`);
      continue;
    }
    await deleteBatch(keys);
    totalDeleted += keys.length;
    console.log(`${prefix} => deleted ${keys.length} objects`);
  }
  console.log(`Done. Total deleted: ${totalDeleted}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
