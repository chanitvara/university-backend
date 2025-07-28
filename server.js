// server.js

// --- 0. Environment Variables ---
require('dotenv').config();

// --- 1. Import Libraries ---
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const multer = require('multer');
const stream = require('stream');

// --- 2. Initialize App, Google Client, and Multer ---
const app = express();
const PORT = process.env.PORT || 3001;

// **อัปเดต:** เปลี่ยนเป็น .array() เพื่อรับไฟล์ได้สูงสุด 50 ไฟล์ จากฟิลด์ที่ชื่อ 'imageFiles'
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { files: 50 } // กำหนดลิมิต 50 ไฟล์
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3001/api/auth/google/callback'
);

let authenticatedUserClient = null;

// --- 3. Middlewares ---
app.use(cors());
app.use(express.json()); // สำหรับอ่าน JSON body (ใช้ในฟังก์ชันแก้ไข)
app.use(express.urlencoded({ extended: true })); // สำหรับอ่าน Form-encoded body

// --- 4. API Routes ---

// === Authentication Routes (No changes) ===
app.get('/api/auth/google', (req, res) => {
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.file'
  ];
  const authorizationUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', scope: scopes, include_granted_scopes: true,
  });
  res.redirect(authorizationUrl);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    const userClient = new google.auth.OAuth2();
    userClient.setCredentials(tokens);
    authenticatedUserClient = userClient;
    const oauth2 = google.oauth2({ auth: userClient, version: 'v2' });
    const { data } = await oauth2.userinfo.get();
    res.redirect(`http://localhost:3000?user=${encodeURIComponent(JSON.stringify(data))}`);
  } catch (error) {
    console.error('Authentication Error:', error);
    res.status(500).send('Authentication failed');
  }
});


// === File Management Routes ===

// **อัปเดต:** 4.3 Endpoint สำหรับอัปโหลดไฟล์ (รองรับหลายไฟล์)
// ใช้ middleware `upload.array('imageFiles', 50)`
app.post('/api/upload', upload.array('imageFiles', 50), async (req, res) => {
  if (!authenticatedUserClient) {
    return res.status(401).json({ message: 'Unauthorized: Please log in first.' });
  }
  try {
    const { event, photographer, date } = req.body;
    const files = req.files; // ตอนนี้ req.files เป็น array

    if (!files || files.length === 0) {
        return res.status(400).json({ message: 'No files uploaded.' });
    }

    const drive = google.drive({ version: 'v3', auth: authenticatedUserClient });
    const parentFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    // หาหรือสร้างโฟลเดอร์ของงาน (Event)
    const query = `mimeType='application/vnd.google-apps.folder' and name='${event}' and '${parentFolderId}' in parents and trashed=false`;
    const searchResult = await drive.files.list({ q: query, fields: 'files(id, name)' });
    
    let eventFolderId;
    if (searchResult.data.files.length > 0) {
      eventFolderId = searchResult.data.files[0].id;
    } else {
      const newFolder = await drive.files.create({
        resource: { name: event, mimeType: 'application/vnd.google-apps.folder', parents: [parentFolderId] },
        fields: 'id'
      });
      eventFolderId = newFolder.data.id;
    }

    // วนลูปอัปโหลดทุกไฟล์
    const uploadPromises = files.map(file => {
        const bufferStream = new stream.PassThrough();
        bufferStream.end(file.buffer);
        return drive.files.create({
            media: { mimeType: file.mimetype, body: bufferStream },
            requestBody: { name: `${date}_${photographer}_${file.originalname}`, parents: [eventFolderId] },
            fields: 'id, name, webViewLink, thumbnailLink' // ขอ thumbnailLink มาด้วย
        });
    });

    const uploadedFiles = await Promise.all(uploadPromises);
    const responseData = uploadedFiles.map(result => result.data);

    res.status(200).json({ 
        message: 'All files uploaded successfully!',
        files: responseData
    });

  } catch (error) {
    console.error('Error uploading files:', error);
    res.status(500).json({ message: 'Failed to upload files.' });
  }
});

// **ใหม่:** 4.4 Endpoint สำหรับลบไฟล์
app.delete('/api/files/:fileId', async (req, res) => {
    if (!authenticatedUserClient) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
        const { fileId } = req.params;
        const drive = google.drive({ version: 'v3', auth: authenticatedUserClient });
        await drive.files.delete({ fileId: fileId });
        res.status(200).json({ message: 'File deleted successfully' });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).json({ message: 'Failed to delete file' });
    }
});

// **ใหม่:** 4.5 Endpoint สำหรับแก้ไขข้อมูลไฟล์ (โดยการเปลี่ยนชื่อ)
app.put('/api/files/:fileId', async (req, res) => {
    if (!authenticatedUserClient) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    try {
        const { fileId } = req.params;
        const { event, photographer, date, originalName } = req.body; // รับชื่อไฟล์เดิมมาด้วย
        
        const drive = google.drive({ version: 'v3', auth: authenticatedUserClient });

        // สร้างชื่อไฟล์ใหม่จากข้อมูลที่แก้ไข
        const newFileName = `${date}_${photographer}_${originalName}`;

        await drive.files.update({
            fileId: fileId,
            requestBody: {
                name: newFileName
            }
        });
        
        // ในระบบที่ซับซ้อนกว่านี้ อาจจะต้องย้ายไฟล์ไปโฟลเดอร์ของ Event ใหม่ด้วย
        // แต่สำหรับตอนนี้ เราจะเปลี่ยนแค่ชื่อไฟล์ก่อนเพื่อความง่าย

        res.status(200).json({ message: 'File updated successfully', newName: newFileName });
    } catch (error) {
        console.error('Error updating file:', error);
        res.status(500).json({ message: 'Failed to update file' });
    }
});

// --- 5. Start the Server ---
app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
