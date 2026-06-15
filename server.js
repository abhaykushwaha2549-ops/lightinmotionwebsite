const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const isServerless = process.env.VERCEL === '1' || process.env.NOW_REGION;
const dataFile = isServerless ? '/tmp/data.json' : path.join(__dirname, 'data.json');
const downloadDir = isServerless ? '/tmp/download' : path.join(__dirname, 'public', 'download');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// If serverless, initialize /tmp/data.json from the committed template if it doesn't exist
if (isServerless && !fs.existsSync(dataFile)) {
  try {
    const templatePath = path.join(__dirname, 'data.json');
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, dataFile);
    } else {
      fs.writeFileSync(dataFile, '{}');
    }
  } catch (e) {
    console.error('Failed to initialize ephemeral data.json in /tmp:', e);
  }
}

// Ensure download directory exists
try {
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }
} catch (e) {
  console.error('Failed to create download directory:', e);
}

// Serve downloads route correctly regardless of path
app.use('/download', express.static(downloadDir));

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

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'abhaykushwaha2549-ops/lightinmotionwebsite'; // Target repository

async function uploadToGitHub(filePath, filename, version) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN environment variable is not configured');
  const tag = version ? `v${version.replace(/^v/i, '')}` : 'v1.0.0';

  // 1. Get or create release
  let release;
  let res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}`, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Node-Express-App'
    }
  });

  if (res.status === 404) {
    const createRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node-Express-App'
      },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        body: `Automated upload of assets for version ${tag}`
      })
    });
    if (!createRes.ok) throw new Error(`Failed to create GitHub release: ${await createRes.text()}`);
    release = await createRes.json();
  } else if (!res.ok) {
    throw new Error(`GitHub API error getting release: ${await res.text()}`);
  } else {
    release = await res.json();
  }

  // 2. Check if asset already exists in this release and delete it
  const existingAsset = release.assets.find(a => a.name === filename);
  if (existingAsset) {
    const deleteRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${existingAsset.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Node-Express-App'
      }
    });
    if (!deleteRes.ok) console.warn(`Could not delete existing asset: ${await deleteRes.text()}`);
  }

  // 3. Upload file
  let uploadUrl = release.upload_url.split('{')[0];
  uploadUrl += `?name=${encodeURIComponent(filename)}`;

  const fileBuffer = fs.readFileSync(filePath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileBuffer.length.toString(),
      'User-Agent': 'Node-Express-App'
    },
    body: fileBuffer
  });

  if (!uploadRes.ok) throw new Error(`Failed to upload asset to GitHub: ${await uploadRes.text()}`);
  const assetData = await uploadRes.json();
  return assetData.browser_download_url;
}

// ── Upload APK / EXE / ZIP ──
app.post('/api/upload', (req, res, next) => {
  // Check password from query or header before file is processed
  const pass = req.query.password || req.headers['x-admin-password'];
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const platform = req.body.platform; // 'android' | 'tv' | 'windows'
  const version  = (req.body.version || '').trim();
  let downloadUrl = `/download/${req.file.filename}`;

  if (GITHUB_TOKEN) {
    try {
      downloadUrl = await uploadToGitHub(req.file.path, req.file.filename, version);
      try {
        fs.unlinkSync(req.file.path);
      } catch (err) {
        console.error('Failed to delete temporary local file:', err.message);
      }
    } catch (err) {
      console.error('GitHub Release Upload Failed:', err.message);
      return res.status(500).json({ error: `GitHub upload failed: ${err.message}` });
    }
  } else {
    console.warn('GITHUB_TOKEN is not configured. Storing file locally (will be deleted on restart).');
  }

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
