# Cloudflare R2 配置指南

## 如何找到 R2 配置資訊

### 1. R2_BUCKET_NAME (Bucket 名稱)

1. 登入 Cloudflare Dashboard: https://dash.cloudflare.com/
2. 點擊左側選單的 **R2**
3. 在 R2 頁面中，你會看到你的 Bucket 列表
4. **Bucket 名稱** 就是 `R2_BUCKET_NAME`
   - 例如：`kxx-photos` 或 `my-photo-bucket`

### 2. R2_ENDPOINT (Endpoint URL)

1. 在 R2 頁面中，點擊你的 Bucket
2. 進入 Bucket 設定頁面
3. 在 **Settings** 分頁中，找到 **S3 API** 區塊
4. 你會看到 **Account ID** 和 **Endpoint**
5. **R2_ENDPOINT** 格式為：
   ```
   https://<account-id>.r2.cloudflarestorage.com
   ```
   - 例如：`https://abc123def456.r2.cloudflarestorage.com`

### 3. R2_ACCESS_KEY_ID 和 R2_SECRET_ACCESS_KEY

1. 在 Cloudflare Dashboard 中，點擊右上角的 **個人資料圖示**
2. 選擇 **My Profile**
3. 在左側選單中，點擊 **API Tokens**
4. 找到 **R2 Token** 區塊，點擊 **Create API token**
5. 選擇 **Object Read & Write** 權限
6. 選擇你的 R2 Bucket
7. 點擊 **Create API Token**
8. 會顯示：
   - **Access Key ID** → 這就是 `R2_ACCESS_KEY_ID`
   - **Secret Access Key** → 這就是 `R2_SECRET_ACCESS_KEY`
   - ⚠️ **重要：Secret Access Key 只會顯示一次，請立即複製保存！**

### 4. R2_PUBLIC_URL (公開 URL)

有兩種方式：

#### 方式 A: 使用 R2 的自訂網域（推薦）
1. 在 R2 Bucket 設定中，進入 **Settings** 分頁
2. 找到 **Public Access** 區塊
3. 如果已設定自訂網域，使用該網域作為 `R2_PUBLIC_URL`
   - 例如：`https://photos.yourdomain.com`

#### 方式 B: 使用 Cloudflare Workers 或 Pages
1. 如果使用 Workers 或 Pages 作為代理，使用該 URL
   - 例如：`https://your-worker.your-subdomain.workers.dev`

#### 方式 C: 使用 R2 的公開 URL（如果已啟用）
1. 在 Bucket 設定中，啟用 **Public Access**
2. 使用格式：`https://pub-<account-id>.r2.dev/<bucket-name>`
   - 例如：`https://pub-abc123def456.r2.dev/kxx-photos`

## 完整範例 .env 配置

```env
# Telegram Bot Token
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Firebase Service Account
FIREBASE_SERVICE_ACCOUNT_PATH=../firebase-admin-key.json

# Cloudflare R2 Configuration
R2_ENDPOINT=https://abc123def456.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your_access_key_id_here
R2_SECRET_ACCESS_KEY=your_secret_access_key_here
R2_BUCKET_NAME=kxx-photos
R2_PUBLIC_URL=https://photos.yourdomain.com
```

## 注意事項

- ⚠️ **Secret Access Key 只會顯示一次**，請妥善保存
- 🔒 不要將 `.env` 文件提交到 Git
- 🌐 如果使用自訂網域，需要在 Cloudflare DNS 中設定 CNAME 記錄
- 📝 R2_ENDPOINT 中的 `<account-id>` 可以在 Cloudflare Dashboard 右上角找到
