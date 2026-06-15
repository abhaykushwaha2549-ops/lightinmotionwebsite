const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataFile = path.join(__dirname, 'data.json');
const downloadDir = path.join(__dirname, 'public', 'download');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// Ensure download directory exists
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

// ── Multer storage (keep original filename, store in public/download/) ──
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, downloadDir),
  filename: (req, file, cb) => {
    // Sanitise filename and keep extension
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-() ]/g, '_');
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.apk', '.exe', '.zip', '.msi'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only .apk, .exe, .zip, .msi files are allowed'));
  }
});

// ── Admin HTML ──
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Verify admin password ──
app.post('/api/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) return res.json({ success: true });
  res.status(401).json({ error: 'Unauthorized' });
});

// ── Get data ──
app.get('/api/data', (req, res) => {
  fs.readFile(dataFile, 'utf8', (err, raw) => {
    if (err) return res.status(500).json({ error: 'Failed to read data' });
    res.json(JSON.parse(raw));
  });
});

// ── Update text data ──
app.post('/api/data', (req, res) => {
  const { password, data } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  fs.writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8', err => {
    if (err) return res.status(500).json({ error: 'Failed to save data' });
    res.json({ success: true });
  });
});

// ── Upload APK / EXE / ZIP ──
app.post('/api/upload', (req, res, next) => {
  // Check password from query or header before file is processed
  const pass = req.query.password || req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const platform = req.body.platform; // 'android' | 'tv' | 'windows'
  const version  = (req.body.version || '').trim();
  const downloadUrl = `/download/${req.file.filename}`;

  // Auto-update data.json if platform + version provided
  if (platform && version) {
    try {
      const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      if (!data.downloads) data.downloads = {};
      if (!data.downloads[platform]) data.downloads[platform] = {};
      data.downloads[platform].version = version;
      data.downloads[platform].url = downloadUrl;
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
    } catch(e) {
      console.error('data.json update failed:', e.message);
    }
  }

  res.json({ success: true, url: downloadUrl, filename: req.file.filename });
});

// ── List uploaded files ──
app.get('/api/files', (req, res) => {
  const pass = req.query.password || req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const files = fs.readdirSync(downloadDir).map(name => {
      const stat = fs.statSync(path.join(downloadDir, name));
      return { name, size: stat.size, modified: stat.mtime };
    });
    res.json(files);
  } catch(e) {
    res.json([]);
  }
});

// ── Delete a file ──
app.delete('/api/files/:name', (req, res) => {
  const pass = req.query.password || req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  const filePath = path.join(downloadDir, path.basename(req.params.name));
  fs.unlink(filePath, err => {
    if (err) return res.status(404).json({ error: 'File not found' });
    res.json({ success: true });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin panel at http://localhost:${PORT}/admin`);
});
