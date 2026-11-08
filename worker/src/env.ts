export interface AppEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;
  GATEWAY_TOKEN?: string;
  GDRIVE_CLIENT_ID?: string;
  GDRIVE_CLIENT_SECRET?: string;
  GDRIVE_REFRESH_TOKEN?: string;
  GDRIVE_FOLDER_ID?: string;
}
