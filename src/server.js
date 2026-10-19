const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const serverRoutes = require('./routes/servers');
const taskRoutes = require('./routes/tasks');
const webdavRoutes = require('./routes/webdav');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.use('/api/servers', serverRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/webdav', webdavRoutes);

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Rsync Client running on http://localhost:${PORT}`);
});