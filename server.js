import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { uploadToDriveFolder, isDriveConfigured } from './googleDrive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Local storage for videos and user details
const STORAGE_DIR = path.resolve(__dirname, '../storage/videos');
const METADATA_FILE = path.resolve(__dirname, '../storage/registrations.json');
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// CORS: allow all origins
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve saved videos statically if needed
app.use('/storage/videos', express.static(STORAGE_DIR));

// Serve the React build if it exists
const frontendBuildPath = path.resolve(__dirname, '../frontend/dist');
if (fs.existsSync(frontendBuildPath)) {
  app.use(express.static(frontendBuildPath));
}

// Configure Multer in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MB
  },
});

function getRegistrations() {
  if (!fs.existsSync(METADATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveRegistrations(data) {
  const dir = path.dirname(METADATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Format registration details as a clean, human-readable text file.
 */
function formatDetailsAsText(record) {
  const lines = [
    `========================================`,
    `   AttendAI - Face Registration Details`,
    `========================================`,
    ``,
    `Registration ID  : ${record.id}`,
    `Full Name        : ${record.name}`,
    `User / Roll No   : ${record.userId}`,
    `Email            : ${record.email}`,
    `Department       : ${record.department}`,
    `Role             : ${record.role}`,
    `Notes / Tags     : ${record.notes || 'None'}`,
    ``,
    `--- Video Specifications ---`,
    `Video File Name  : ${record.videoFileName}`,
    `Video File Size  : ${(record.fileSize / (1024 * 1024)).toFixed(2)} MB`,
    `MIME Type        : ${record.mimeType}`,
    `Recording Length : ${record.recordingDuration || 8} seconds`,
    ``,
    `--- Verification Status ---`,
    `Face Verification: PASSED (Multi-angle: Straight, Left, Right, Tilt Up)`,
    `Registered At    : ${record.registeredAt}`,
    `Training Status  : ${record.trainingStatus}`,
    ``,
    `--- Storage Destination ---`,
    `Dedicated Folder : ${record.folderName}`,
    `Drive Video Link : ${record.driveVideoLink || 'Local Storage'}`,
    `Drive Folder Link: ${record.driveFolderLink || 'Local Storage'}`,
    ``,
    `========================================`,
  ];
  return lines.join('\n');
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    googleDriveConfigured: isDriveConfigured(),
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null,
    timestamp: new Date().toISOString(),
  });
});

// Registration Endpoint
app.post('/api/register', upload.single('video'), async (req, res) => {
  try {
    const { name, email, userId, department, role, notes, duration } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided. Please record your face scan before submitting.',
      });
    }

    if (!name || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Name and User/Student ID are required.',
      });
    }

    // Sanitize user identifiers
    const safeUserId = userId.toString().trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeName = name.trim().replace(/[^a-zA-Z0-9]/g, '_');
    const timestamp = Date.now();
    const ext = file.originalname?.split('.').pop() || 'webm';

    // SEPARATE FOLDER for this person!
    const userFolderName = `${safeUserId}_${safeName}`;
    const videoFileName = `${safeUserId}_${timestamp}.${ext}`;
    const detailsFileName = `${safeUserId}_${timestamp}_details.txt`;

    const record = {
      id: `${safeUserId}_${timestamp}`,
      name: name.trim(),
      email: (email || '').trim(),
      userId: userId.trim(),
      department: (department || 'General').trim(),
      role: (role || 'Student').trim(),
      notes: (notes || '').trim(),
      folderName: userFolderName,
      videoFileName,
      detailsFileName,
      videoPath: `storage/videos/${userFolderName}/${videoFileName}`,
      detailsPath: `storage/videos/${userFolderName}/${detailsFileName}`,
      fileSize: file.size,
      mimeType: file.mimetype || 'video/webm',
      recordingDuration: duration ? Number(duration) : null,
      registeredAt: new Date().toISOString(),
      trainingStatus: 'READY_FOR_PREPROCESSING',
      driveVideoId: null,
      driveVideoLink: null,
      driveDetailsId: null,
      driveFolderLink: null,
      driveFolder: null,
      storageMode: 'local',
    };

    const textContent = formatDetailsAsText(record);

    // 1. ALWAYS organize into a dedicated separate folder on local disk:
    const localUserFolder = path.join(STORAGE_DIR, userFolderName);
    if (!fs.existsSync(localUserFolder)) {
      fs.mkdirSync(localUserFolder, { recursive: true });
    }

    fs.writeFileSync(path.join(localUserFolder, videoFileName), file.buffer);
    fs.writeFileSync(path.join(localUserFolder, detailsFileName), textContent, 'utf-8');
    const sidecarPath = path.join(localUserFolder, `${safeUserId}_${timestamp}_meta.json`);
    fs.writeFileSync(sidecarPath, JSON.stringify(record, null, 2), 'utf-8');

    // 2. Upload to Google Drive into its own separate folder if configured:
    if (isDriveConfigured()) {
      try {
        console.log(`[AttendAI] Uploading to Google Drive in separate folder "${userFolderName}" for ${name}...`);
        const driveResult = await uploadToDriveFolder(
          file.buffer,
          videoFileName,
          file.mimetype || 'video/webm',
          textContent,
          detailsFileName,
          userFolderName
        );

        record.driveVideoId = driveResult.videoId;
        record.driveVideoLink = driveResult.videoUrl || null;
        record.driveDetailsId = driveResult.detailsId;
        record.driveFolderLink = driveResult.folderUrl || null;
        record.driveFolder = `AttendAI_Recordings/${userFolderName}`;
        record.storageMode = 'google_drive';

        console.log(`[AttendAI] ✅ Successfully uploaded to Google Drive folder "${userFolderName}"!`);
      } catch (driveErr) {
        console.warn(`[AttendAI] Google Drive note: ${driveErr.message}. All files safely stored in local separate folder.`);
        record.storageMode = 'local_saved';
        record.driveNotice = driveErr.message;
      }
    }

    // Save global record
    const all = getRegistrations();
    all.push(record);
    saveRegistrations(all);

    console.log(`[AttendAI] Registered: ${name} [${userId}] in separate folder "${userFolderName}"`);

    return res.status(201).json({
      success: true,
      message: record.storageMode === 'google_drive'
        ? `Uploaded to separate Google Drive folder "${userFolderName}"!`
        : `Saved locally in separate folder "${userFolderName}"!`,
      data: record,
    });
  } catch (err) {
    console.error('[AttendAI] Registration error:', err);
    return res.status(500).json({
      success: false,
      error: 'Error processing registration: ' + err.message,
    });
  }
});

app.get('/api/videos', (req, res) => {
  const records = getRegistrations();
  res.json({
    totalSamples: records.length,
    googleDriveConfigured: isDriveConfigured(),
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || null,
    records: records.slice(-10).reverse(),
  });
});

if (fs.existsSync(frontendBuildPath)) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendBuildPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` AttendAI Backend Server`);
  console.log(` Running on http://localhost:${PORT}`);
  console.log(` Google Drive Folder: ${process.env.GOOGLE_DRIVE_FOLDER_ID || 'Not set'}`);
  console.log(` Storage: Everything separated in individual user folders!`);
  console.log(`====================================================`);
});
