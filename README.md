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
- `R2_ENDPOINT`: Cloudflare R2 endpoint URL
- `R2_ACCESS_KEY_ID`: R2 access key ID
- `R2_SECRET_ACCESS_KEY`: R2 secret access key
- `R2_BUCKET_NAME`: R2 bucket name
- `R2_PUBLIC_URL`: Public URL for R2 bucket
