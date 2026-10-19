const express = require('express');
const db = require('../database');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const servers = db.getServers();
    res.json({ success: true, data: servers });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const server = db.getServer(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, message: 'Server not found' });
    }
    res.json({ success: true, data: server });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, host, port, username, password, module } = req.body;
    
    if (!name || !host) {
      return res.status(400).json({ success: false, message: 'Name and host are required' });
    }

    const result = db.addServer({
      name,
      host,
      port: port || 873,
      username: username || null,
      password: password || null,
      module: module || null
    });

    res.status(201).json({ success: true, data: { id: result.lastID } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { name, host, port, username, password, module } = req.body;
    
    const server = db.getServer(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, message: 'Server not found' });
    }

    db.updateServer(req.params.id, {
      name,
      host,
      port,
      username,
      password,
      module
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const server = db.getServer(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, message: 'Server not found' });
    }

    db.deleteServer(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/test', (req, res) => {
  const { host, port, username, password, module } = req.body;
  
  if (!host) {
    return res.status(400).json({ success: false, message: 'Host is required' });
  }

  const { exec } = require('child_process');
  const os = require('os');
  const isWindows = os.platform() === 'win32';
  const portNum = port || 873;
  
  let rsyncCmd;
  if (username && password) {
    process.env.RSYNC_PASSWORD = password;
    rsyncCmd = `rsync --port=${portNum} --list-only ${username}@${host}::${module || ''}`;
  } else {
    rsyncCmd = `rsync --port=${portNum} --list-only ${host}::${module || ''}`;
  }

  exec(rsyncCmd, { timeout: 10000 }, (error, stdout, stderr) => {
    delete process.env.RSYNC_PASSWORD;
    
    if (error) {
      let message = `Connection failed: ${stderr || error.message}`;
      
      if (isWindows && error.message && error.message.includes('not recognized')) {
        message = 'rsync 未安装。Docker 部署时会自动安装。本地开发请安装 cwRsync 或使用 WSL。';
      }
      
      return res.json({ 
        success: false, 
        message,
        details: stderr || error.message,
        is_windows: isWindows
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Connection successful',
      modules: stdout.trim()
    });
  });
});

module.exports = router;