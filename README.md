# KXX Telegram Photo Bot

Telegram bot for uploading photos to the gallery with EXIF data extraction and HEIC support.

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

## Deploy To Koyeb (Webhook Mode)

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
