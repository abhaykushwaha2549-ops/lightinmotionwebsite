const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dataFile = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = "admin"; // Simple password

// Clean route for Admin Panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get data
app.get('/api/data', (req, res) => {
    fs.readFile(dataFile, 'utf8', (err, data) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to read data' });
        }
        res.json(JSON.parse(data));
    });
});

// Update data
app.post('/api/data', (req, res) => {
    const { password, data } = req.body;
    
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Unauthorized: Incorrect password' });
    }

    fs.writeFile(dataFile, JSON.stringify(data, null, 2), 'utf8', (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to save data' });
        }
        res.json({ success: true });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Admin panel at http://localhost:${PORT}/admin.html`);
});
