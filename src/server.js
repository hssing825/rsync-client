const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const serverRoutes = require('./routes/servers');
const taskRoutes = require('./routes/tasks');
const webdavRoutes = require('./routes/webdav');

const app = express();
const PORT = process.env.PORT || 3000;

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

// 启动时清理旧日志（保留最近 7 天）
try {
  const cleaned = db.cleanOldLogs(7);
  if (cleaned && cleaned.length > 0) {
    console.log(`[Startup] Cleaned ${cleaned.length} old log entries`);
  }
} catch (err) {
  console.error('[Startup] Failed to clean old logs:', err.message);
}

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Rsync Client running on http://localhost:${PORT}`);
});