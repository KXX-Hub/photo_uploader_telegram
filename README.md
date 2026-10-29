# KXX Photo Uploader

Photo pipeline for the kxx-profile gallery: EXIF extraction, HEIC/RAW conversion,
WebP compression, Cloudflare R2 storage and Firestore. It runs as two independent
entry points that share `src/photo-service.js`:

| Service | Start command | Needs Telegram? | What it serves |
| --- | --- | --- | --- |
| Upload service | `npm run start:upload` | Only for the original archive | `POST /upload`, `DELETE /photos/:id`, `GET /photos/:id/original`, `GET /healthz`, upload page at `GET /` (used by the website dashboard) |
| Telegram bot | `npm start` | Yes | Photos sent to the bot, plus the same web routes unless `ENABLE_WEB_UPLOAD=false` |

The website dashboard only needs the upload service.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

3. Make sure you have `firebase-admin-key.json` in the parent directory.

4. Run the bot:
```bash
npm start
```

## Deploy the upload service to Koyeb (no Telegram)

1. Create a new Koyeb Web Service from `KXX-Hub/photo_uploader_telegram`.
   - Start command: `npm run start:upload`
   - Exposed port: `3000` (or set `PORT`)
   - Health check: `GET /healthz`
2. Set environment variables:
   - Firebase Admin: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
     (or `FIREBASE_SERVICE_ACCOUNT_PATH`)
   - R2: `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL`
     (optional `R2_OBJECT_PREFIX`, `R2_ORIGINALS_PREFIX`, `R2_THUMBNAILS_PREFIX`)
   - Access: allowed Google accounts come from Firestore `settings/dashboard_auth`;
     optional `ADMIN_EMAILS`, `UPLOAD_SECRET` (for the page at `GET /`), `CORS_ORIGIN`
   - Optional original archive: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ARCHIVE_CHAT_ID`
     (see below). Without them the service runs without Telegram.
3. Point the website at it: set `REACT_APP_UPLOAD_URL=https://<upload-service-domain>` in
   kxx-profile's `.env` (or Vercel env) and redeploy the site.
4. When you no longer want the Telegram bot, pause or delete the bot service on Koyeb.
   If you keep it, set `ENABLE_WEB_UPLOAD=false` on it so only one service handles uploads.

## Keep originals in a Telegram channel (optional)

The site only stores resized WebP copies. To also keep every original, byte for
byte with its EXIF, the upload service can post it as a file to a private
Telegram channel. Nobody chats with the bot; it's only the key for the API.

1. Create a private Telegram channel.
2. Add your bot (from @BotFather) to it as an admin that can post and delete messages.
3. Find the channel id (forward one of its posts to @userinfobot); it looks like
   `-1001234567890`.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ARCHIVE_CHAT_ID` on the upload service.

Each web upload is then posted to the channel, and its photo document gets an
`original` field (message id, file id, name, size, link). The dashboard can
download originals up to 20 MB (`GET /photos/:id/original`); bigger ones open
in Telegram, since bots can't fetch files over 20 MB. Deleting a photo also
deletes its original from the channel. Uploads are capped at 50 MB, Telegram's
limit for bots.

## Deploy the Telegram bot to Koyeb (Webhook Mode)

This bot supports two modes:
- Polling mode: default when `WEBHOOK_DOMAIN` is empty
- Webhook mode: enabled when `WEBHOOK_DOMAIN` is set (recommended for Koyeb)

### 1. Push your latest code to GitHub

Koyeb will deploy directly from your repository.

### 2. Create a Koyeb Web Service

- Source: GitHub repo `KXX-Hub/photo_uploader_telegram`
- Build/Runtime: Node.js
- Start command: `npm start`
- Exposed port: `3000` (or use `PORT` env var)

### 3. Set environment variables in Koyeb

Required:
- `TELEGRAM_BOT_TOKEN`
- `FIREBASE_SERVICE_ACCOUNT_PATH`
- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `R2_PUBLIC_URL`

Webhook-specific:
- `WEBHOOK_DOMAIN=https://<your-koyeb-domain>`
- `WEBHOOK_PATH=/telegram-<random-string>` (must not be `/telegram`)
- `TELEGRAM_WEBHOOK_SECRET=<random-secret>` (required in webhook mode)
- `PORT=3000`

Optional:
- `R2_OBJECT_PREFIX`
- `R2_ORIGINALS_PREFIX`
- `R2_THUMBNAILS_PREFIX`

### 4. Verify deployment

- Open `https://<your-koyeb-domain>/healthz`
- Should return `ok`

### 5. Verify Telegram webhook

Once service is healthy, startup logs should show:
- `Webhook server listening on port ...`
- `Webhook URL: ...`

Then send a message/photo to the bot and confirm it is processed.

## Features

- Photo upload to Cloudflare R2
- EXIF data extraction (device, GPS, camera settings)
- HEIC/HEIF file support with automatic conversion
- Reverse geocoding for location names
- Automatic thumbnail generation
- Image compression
- Firestore integration

## Environment Variables

- `TELEGRAM_BOT_TOKEN`: Your Telegram bot token
- `FIREBASE_SERVICE_ACCOUNT_PATH`: Path to Firebase service account key
- `WEBHOOK_DOMAIN`: Public HTTPS domain for Telegram webhook (Koyeb URL or custom domain)
- `WEBHOOK_PATH`: Webhook path (default `/telegram`)
- `TELEGRAM_WEBHOOK_SECRET`: Secret token for webhook request validation
- `PORT`: HTTP server port (default `3000`)
- `R2_ENDPOINT`: Cloudflare R2 endpoint URL
- `R2_ACCESS_KEY_ID`: R2 access key ID
- `R2_SECRET_ACCESS_KEY`: R2 secret access key
- `R2_BUCKET_NAME`: R2 bucket name
- `R2_PUBLIC_URL`: Public URL for R2 bucket
- `TELEGRAM_ALLOWED_USER_IDS`: Comma-separated Telegram user IDs allowed to use the bot
- `ENABLE_WEB_UPLOAD`: Set to `false` on the bot when the upload service runs separately
- `ADMIN_EMAILS`, `UPLOAD_SECRET`, `CORS_ORIGIN`: Upload service access (see above)
- `TELEGRAM_ARCHIVE_CHAT_ID`: Channel that keeps the originals of web uploads (see above)
