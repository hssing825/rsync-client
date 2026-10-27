const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const serverRoutes = require('./routes/servers');
const taskRoutes = require('./routes/tasks');
const webdavRoutes = require('./routes/webdav');
const snapshotRoutes = require('./routes/snapshots');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.use('/api/servers', serverRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/webdav', webdavRoutes);
app.use('/api/snapshots', snapshotRoutes);

// 启动时清理旧日志（保留最近 30 天）
try {
  const cleaned = db.cleanOldLogs(30);
  console.log(`[Startup] Cleaned old log files: ${cleaned}`);
} catch (err) {
  console.error('[Startup] Failed to clean old logs:', err.message);
}

// 日志管理 API
app.get('/api/logs', (req, res) => {
  try {
    const logFiles = db.getLogFileList();
    res.json({ success: true, data: logFiles });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/logs/:date', (req, res) => {
  try {
    const logs = db.getLogFileContent(req.params.date);
    if (logs === null) {
      return res.status(404).json({ success: false, message: 'Log file not found' });
    }
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/logs/:date', (req, res) => {
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    const logFile = path.join(logDir, `task-${req.params.date}.log`);
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
      res.json({ success: true, message: 'Log file deleted' });
    } else {
      res.status(404).json({ success: false, message: 'Log file not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Rsync Client running on http://0.0.0.0:${PORT}`);
});