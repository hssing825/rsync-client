const express = require('express');
const db = require('../database');
const webdav = require('webdav-server');

const router = express.Router();

let webdavServer = null;

router.get('/', (req, res) => {
  try {
    const config = db.getWebDAVConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/configure', (req, res) => {
  try {
    const { enabled, port, username, password, storage_path } = req.body;
    
    db.updateWebDAVConfig({
      enabled: enabled ? 1 : 0,
      port,
      username,
      password,
      storage_path
    });

    if (enabled) {
      startWebDAVServer({ port, username, password, storage_path });
    } else {
      stopWebDAVServer();
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/start', (req, res) => {
  try {
    const config = db.getWebDAVConfig();
    
    if (!config) {
      return res.status(400).json({ success: false, message: 'WebDAV not configured' });
    }

    if (webdavServer) {
      return res.status(400).json({ success: false, message: 'WebDAV server is already running' });
    }

    startWebDAVServer(config);
    res.json({ success: true, message: `WebDAV server started on port ${config.port}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/stop', (req, res) => {
  try {
    stopWebDAVServer();
    res.json({ success: true, message: 'WebDAV server stopped' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/status', (req, res) => {
  try {
    const config = db.getWebDAVConfig();
    res.json({ 
      success: true, 
      running: webdavServer !== null,
      config: config || null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function startWebDAVServer(config) {
  if (webdavServer) {
    stopWebDAVServer();
  }

  const server = new webdav.WebDAVServer();
  
  const userManager = new webdav.SimpleUserManager();
  const user = userManager.addUser(config.username, config.password, false);
  
  const privilegeManager = new webdav.SimplePathPrivilegeManager();
  privilegeManager.setRights(user, '/', ['all']);

  const fsManager = new webdav.PhysicalFS(config.storage_path || './webdav-storage');
  
  server.setFileSystem(fsManager, () => {});
  server.setUserManager(userManager);
  server.setPrivilegeManager(privilegeManager);

  server.start(config.port || 8080, () => {
    console.log(`WebDAV server started on port ${config.port || 8080}`);
  });

  webdavServer = server;
}

function stopWebDAVServer() {
  if (webdavServer) {
    webdavServer.stop(() => {
      console.log('WebDAV server stopped');
    });
    webdavServer = null;
  }
}

module.exports = router;