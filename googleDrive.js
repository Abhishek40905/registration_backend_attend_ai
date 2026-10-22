import { google } from 'googleapis';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import https from 'https';

let timeSyncCompleted = false;

// Auto-sync local clock with Google server time to prevent token validity issues
export async function syncServerClock() {
  if (timeSyncCompleted) return;
  return new Promise((resolve) => {
    try {
      const req = https.get('https://www.google.com', { rejectUnauthorized: false }, (res) => {
        if (res.headers && res.headers.date) {
          const serverEpochMs = new Date(res.headers.date).getTime();
          const localEpochMs = Date.now();
          const offsetMs = serverEpochMs - localEpochMs;

          if (Math.abs(offsetMs) > 60000) {
            console.log(`[GoogleDrive] Detected time skew of ${(offsetMs / 3600000).toFixed(2)}h. Syncing clock with Google servers...`);
            const RealDate = Date;
            global.Date = class extends RealDate {
              constructor(...args) {
                if (args.length === 0) {
                  super(RealDate.now() + offsetMs);
                } else {
                  super(...args);
                }
              }
              static now() {
                return RealDate.now() + offsetMs;
              }
            };
          }
        }
        timeSyncCompleted = true;
        resolve();
      });
      req.on('error', () => {
        timeSyncCompleted = true;
        resolve();
      });
      req.setTimeout(3000, () => {
        req.destroy();
        timeSyncCompleted = true;
        resolve();
      });
    } catch {
      timeSyncCompleted = true;
      resolve();
    }
  });
}

// Authenticate using OAuth 2.0 or Service Account
export async function getAuthClient() {
  await syncServerClock();

  // 1. Priority: OAuth 2.0 Refresh Token (works with personal @gmail.com accounts!)
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'https://developers.google.com/oauthplayground'
    );
    oauth2Client.setCredentials({
      refresh_token: refreshToken,
    });
    return oauth2Client;
  }

  // 2. Fallback: Service Account (works with Shared Drives or delegation)
  let email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath && fs.existsSync(keyPath)) {
    try {
      const raw = fs.readFileSync(keyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      email = parsed.client_email || email;
      privateKey = parsed.private_key || privateKey;
    } catch (err) {
      console.warn('[GoogleDrive] Could not read JSON key file:', err.message);
    }
  }

  if (email && privateKey) {
    const formattedKey = privateKey.replace(/\\n/g, '\n');
    return new google.auth.JWT({
      email,
      key: formattedKey,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  }

  throw new Error('No Google credentials found. Provide OAuth2 keys or Service Account keys.');
}

export async function getDriveClient() {
  const auth = await getAuthClient();
  return google.drive({ version: 'v3', auth });
}

/**
 * Ensure a separate folder exists for this specific person inside parentFolderId.
 */
export async function ensureUserFolder(drive, parentFolderId, userFolderName) {
  const query = `'${parentFolderId}' in parents and name = '${userFolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name, webViewLink)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0];
  }

  const folderMetadata = {
    name: userFolderName,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentFolderId],
  };

  const folder = await drive.files.create({
    requestBody: folderMetadata,
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  console.log(`[GoogleDrive] Created separate folder for user: "${userFolderName}" → ID: ${folder.data.id}`);
  return folder.data;
}

/**
 * Upload to Google Drive via Google Apps Script Web App (Personal @gmail.com bypass)
 */
export async function uploadViaAppsScript(fileBuffer, fileName, mimeType, textContent, detailsFileName, userFolderName) {
  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  if (!scriptUrl) return null;

  console.log(`[GoogleDrive] Uploading via Google Apps Script to Drive folder "${userFolderName}"...`);

  const payload = {
    folderName: userFolderName,
    videoFileName: fileName,
    mimeType: mimeType || 'video/webm',
    videoBase64: fileBuffer.toString('base64'),
    detailsFileName: detailsFileName,
    textContent: textContent,
  };

  const res = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!json.success) {
    throw new Error(json.error || 'Apps Script upload failed');
  }
  return json;
}

/**
 * Upload to Google Drive using Google Apps Script or OAuth 2.0 / Service Account
 */
export async function uploadToDriveFolder(fileBuffer, fileName, mimeType, textContent, detailsFileName, userFolderName) {
  // 1. If Google Apps Script Web App URL is provided, prioritize it (works seamlessly for personal @gmail.com)
  if (process.env.GOOGLE_APPS_SCRIPT_URL) {
    return await uploadViaAppsScript(fileBuffer, fileName, mimeType, textContent, detailsFileName, userFolderName);
  }

  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!rootFolderId) {
    throw new Error('Missing GOOGLE_DRIVE_FOLDER_ID in server/.env');
  }

  const drive = await getDriveClient();
  const userFolder = await ensureUserFolder(drive, rootFolderId, userFolderName);

  // 1. Upload video file into this user's separate folder
  const videoStream = new Readable();
  videoStream.push(fileBuffer);
  videoStream.push(null);

  const videoRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [userFolder.id],
    },
    media: {
      mimeType: mimeType || 'video/webm',
      body: videoStream,
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  // 2. Upload details text file into this user's separate folder
  const textStream = new Readable();
  textStream.push(textContent);
  textStream.push(null);

  const detailsRes = await drive.files.create({
    requestBody: {
      name: detailsFileName,
      parents: [userFolder.id],
    },
    media: {
      mimeType: 'text/plain',
      body: textStream,
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  return {
    folderId: userFolder.id,
    folderUrl: userFolder.webViewLink,
    videoId: videoRes.data.id,
    videoUrl: videoRes.data.webViewLink,
    detailsId: detailsRes.data.id,
    detailsUrl: detailsRes.data.webViewLink,
  };
}

export function isDriveConfigured() {
  const hasOAuth = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
  const hasServiceAccount = !!(
    (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH && fs.existsSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH)) ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY)
  );
  const hasAppsScript = !!process.env.GOOGLE_APPS_SCRIPT_URL;
  const hasFolder = !!process.env.GOOGLE_DRIVE_FOLDER_ID;
  return (hasOAuth || hasServiceAccount || hasAppsScript) && hasFolder;
}
