const express = require('express');
const db = require('../database');
const WebDAVSync = require('../cloud/webdav');

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
    const { name, host, port, username, password, module, server_type, cloud_type, webdav_url } = req.body;
    
    if (!name) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }

    const serverData = {
      name,
      server_type: server_type || 'rsync',
      cloud_type: cloud_type || null,
      webdav_url: webdav_url || null
    };

    if (server_type === 'openlist') {
      serverData.server_type = 'openlist';
      serverData.cloud_type = 'openlist';
      serverData.username = username || null;
      serverData.password = password || null;
      serverData.webdav_url = webdav_url || null;
      serverData.host = null;
      serverData.port = null;
      serverData.module = null;
    } else if (server_type === 'cloud') {
      serverData.cloud_type = cloud_type || 'webdav';
      serverData.username = username || null;
      serverData.password = password || null;
      serverData.host = null;
      serverData.port = null;
      serverData.module = null;
    } else {
      if (!host) {
        return res.status(400).json({ success: false, message: 'Host is required for rsync server' });
      }
      serverData.host = host;
      serverData.port = port || 873;
      serverData.username = username || null;
      serverData.password = password || null;
      serverData.module = module || null;
    }

    const result = db.addServer(serverData);

    res.status(201).json({ success: true, data: { id: result.lastID } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const { name, host, port, username, password, module, server_type, cloud_type, webdav_url } = req.body;
    
    const server = db.getServer(req.params.id);
    if (!server) {
      return res.status(404).json({ success: false, message: 'Server not found' });
    }

    const updateData = { name };

    if (server_type === 'openlist') {
      updateData.server_type = 'openlist';
      updateData.cloud_type = 'openlist';
      updateData.username = username !== undefined ? username : server.username;
      updateData.password = password !== undefined ? password : server.password;
      updateData.webdav_url = webdav_url !== undefined ? webdav_url : server.webdav_url;
      updateData.host = null;
      updateData.port = null;
      updateData.module = null;
    } else if (server_type === 'cloud') {
      updateData.server_type = 'cloud';
      updateData.cloud_type = cloud_type || server.cloud_type || 'webdav';
      updateData.username = username !== undefined ? username : server.username;
      updateData.password = password !== undefined ? password : server.password;
      updateData.webdav_url = webdav_url !== undefined ? webdav_url : server.webdav_url;
      updateData.host = null;
      updateData.port = null;
      updateData.module = null;
    } else {
      updateData.server_type = 'rsync';
      updateData.host = host !== undefined ? host : server.host;
      updateData.port = port !== undefined ? port : server.port;
      updateData.username = username !== undefined ? username : server.username;
      updateData.password = password !== undefined ? password : server.password;
      updateData.module = module !== undefined ? module : server.module;
      updateData.cloud_type = null;
      updateData.webdav_url = null;
    }

    db.updateServer(req.params.id, updateData);

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

router.post('/test', async (req, res) => {
  const { host, port, username, password, module, server_type, webdav_url } = req.body;
  
  if (server_type === 'openlist' || server_type === 'cloud') {
    try {
      const webdav = new WebDAVSync({
        username: username,
        password: password,
        webdav_url: webdav_url
      });
      
      const result = await webdav.testConnection();
      
      if (result.success) {
        return res.json({ 
          success: true, 
          message: server_type === 'openlist' ? 'OpenList连接成功' : 'WebDAV连接成功',
          userInfo: result.userInfo
        });
      } else {
        return res.json({ 
          success: false, 
          message: result.message
        });
      }
    } catch (error) {
      return res.json({ 
        success: false, 
        message: `连接失败: ${error.message}`
      });
    }
  }
  
  // RSYNC server test
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