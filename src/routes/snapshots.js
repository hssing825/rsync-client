const express = require('express');
const db = require('../database');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const router = express.Router();

router.get('/', (req, res) => {
  try {
    const { task_id, limit } = req.query;
    const snapshots = db.getSnapshots(task_id, parseInt(limit) || 50);
    res.json({ success: true, data: snapshots });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const snapshot = db.getSnapshot(req.params.id);
    if (!snapshot) {
      return res.status(404).json({ success: false, message: 'Snapshot not found' });
    }
    res.json({ success: true, data: snapshot });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const snapshot = db.getSnapshot(req.params.id);
    if (!snapshot) {
      return res.status(404).json({ success: false, message: 'Snapshot not found' });
    }

    if (snapshot.snapshot_path && fs.existsSync(snapshot.snapshot_path)) {
      const isWindows = process.platform === 'win32';
      const rmCmd = isWindows ? 'rmdir' : 'rm';
      const rmArgs = isWindows ? ['/s', '/q', snapshot.snapshot_path] : ['-rf', snapshot.snapshot_path];
      
      const child = spawn(rmCmd, rmArgs);
      
      child.on('close', (code) => {
        if (code === 0) {
          db.deleteSnapshot(req.params.id);
          res.json({ success: true, message: 'Snapshot deleted' });
        } else {
          res.status(500).json({ success: false, message: 'Failed to delete snapshot files' });
        }
      });
      
      child.on('error', (error) => {
        res.status(500).json({ success: false, message: error.message });
      });
    } else {
      db.deleteSnapshot(req.params.id);
      res.json({ success: true, message: 'Snapshot deleted' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:id/restore', (req, res) => {
  try {
    const snapshot = db.getSnapshot(req.params.id);
    if (!snapshot) {
      return res.status(404).json({ success: false, message: 'Snapshot not found' });
    }

    const { restore_path, files } = req.body;
    
    if (!restore_path) {
      return res.status(400).json({ success: false, message: 'Restore path is required' });
    }

    if (!fs.existsSync(snapshot.snapshot_path)) {
      return res.status(404).json({ success: false, message: 'Snapshot files not found' });
    }

    let sourcePath = snapshot.snapshot_path;
    if (process.platform === 'win32') {
      const winPathMatch = sourcePath.match(/^([A-Za-z]):[\/\\]/);
      if (winPathMatch) {
        const drive = winPathMatch[1].toLowerCase();
        const restPath = sourcePath.substring(2).replace(/\\/g, '/');
        sourcePath = `/cygdrive/${drive}${restPath}`;
      } else {
        sourcePath = sourcePath.replace(/\\/g, '/');
      }
    }

    let targetPath = restore_path;
    if (process.platform === 'win32') {
      const winPathMatch = targetPath.match(/^([A-Za-z]):[\/\\]/);
      if (winPathMatch) {
        const drive = winPathMatch[1].toLowerCase();
        const restPath = targetPath.substring(2).replace(/\\/g, '/');
        targetPath = `/cygdrive/${drive}${restPath}`;
      } else {
        targetPath = targetPath.replace(/\\/g, '/');
      }
    }

    if (!fs.existsSync(restore_path)) {
      fs.mkdirSync(restore_path, { recursive: true });
    }

    const rsyncArgs = ['-avz', '--progress'];
    
    if (files && files.length > 0) {
      files.forEach(file => {
        rsyncArgs.push('--include', file);
      });
      rsyncArgs.push('--exclude', '*');
    }

    const child = spawn('rsync', [...rsyncArgs, sourcePath + '/', targetPath + '/']);
    
    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        db.updateSnapshot(req.params.id, {
          restored_at: new Date().toISOString(),
          restore_path: restore_path,
          restore_status: 'success'
        });
        
        res.json({ 
          success: true, 
          message: 'Restore completed successfully',
          restored_files: stdoutData.split('\n').filter(line => line.trim())
        });
      } else {
        db.updateSnapshot(req.params.id, {
          restore_status: 'failed'
        });
        
        res.status(500).json({ 
          success: false, 
          message: `Restore failed with exit code ${code}`,
          error: stderrData
        });
      }
    });

    child.on('error', (error) => {
      res.status(500).json({ success: false, message: error.message });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id/files', (req, res) => {
  try {
    const snapshot = db.getSnapshot(req.params.id);
    if (!snapshot) {
      return res.status(404).json({ success: false, message: 'Snapshot not found' });
    }

    if (!fs.existsSync(snapshot.snapshot_path)) {
      return res.status(404).json({ success: false, message: 'Snapshot files not found' });
    }

    const listFiles = (dir, baseDir = '') => {
      const results = [];
      const items = fs.readdirSync(dir);
      
      items.forEach(item => {
        const fullPath = path.join(dir, item);
        const relativePath = baseDir ? path.join(baseDir, item) : item;
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          results.push({
            name: item,
            path: relativePath,
            type: 'directory',
            size: 0,
            modified: stat.mtime.toISOString()
          });
          results.push(...listFiles(fullPath, relativePath));
        } else {
          results.push({
            name: item,
            path: relativePath,
            type: 'file',
            size: stat.size,
            modified: stat.mtime.toISOString()
          });
        }
      });
      
      return results;
    };

    const files = listFiles(snapshot.snapshot_path);
    res.json({ success: true, data: files });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/tasks/:taskId/create', async (req, res) => {
  try {
    const task = db.getTask(req.params.taskId);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const { name, description } = req.body;
    
    const PROJECT_ROOT = path.join(__dirname, '..', '..');
    const snapshotsDir = path.join(PROJECT_ROOT, 'data', 'snapshots');
    
    if (!fs.existsSync(snapshotsDir)) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotName = name || `snapshot-${task.name}-${timestamp}`;
    const snapshotPath = path.join(snapshotsDir, `task-${task.id}-${timestamp}`);

    if (!fs.existsSync(snapshotPath)) {
      fs.mkdirSync(snapshotPath, { recursive: true });
    }

    let sourcePath = task.source_path;
    if (!path.isAbsolute(sourcePath)) {
      sourcePath = path.join(PROJECT_ROOT, sourcePath);
    }

    if (process.platform === 'win32') {
      const winPathMatch = sourcePath.match(/^([A-Za-z]):[\/\\]/);
      if (winPathMatch) {
        const drive = winPathMatch[1].toLowerCase();
        const restPath = sourcePath.substring(2).replace(/\\/g, '/');
        sourcePath = `/cygdrive/${drive}${restPath}`;
      } else {
        sourcePath = sourcePath.replace(/\\/g, '/');
      }
    }

    let targetPath = snapshotPath;
    if (process.platform === 'win32') {
      const winPathMatch = targetPath.match(/^([A-Za-z]):[\/\\]/);
      if (winPathMatch) {
        const drive = winPathMatch[1].toLowerCase();
        const restPath = targetPath.substring(2).replace(/\\/g, '/');
        targetPath = `/cygdrive/${drive}${restPath}`;
      } else {
        targetPath = targetPath.replace(/\\/g, '/');
      }
    }

    const child = spawn('rsync', ['-avz', '--delete', sourcePath + '/', targetPath + '/']);
    
    let stdoutData = '';
    let stderrData = '';
    let fileCount = 0;
    let totalSize = 0;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutData += text;
      
      const lines = text.split('\n');
      lines.forEach(line => {
        if (line.trim() && !line.startsWith('sent') && !line.startsWith('total')) {
          fileCount++;
        }
      });
    });

    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        const sizeMatch = stdoutData.match(/total size is ([\d,]+)/);
        if (sizeMatch) {
          totalSize = parseInt(sizeMatch[1].replace(/,/g, ''));
        }

        const snapshot = db.addSnapshot({
          task_id: task.id,
          task_name: task.name,
          name: snapshotName,
          description: description || '',
          snapshot_path: snapshotPath,
          source_path: task.source_path,
          file_count: fileCount,
          total_size: totalSize,
          status: 'completed',
          created_at: new Date().toISOString()
        });

        res.json({ 
          success: true, 
          data: { id: snapshot.lastID },
          message: 'Snapshot created successfully'
        });
      } else {
        if (fs.existsSync(snapshotPath)) {
          const isWindows = process.platform === 'win32';
          const rmCmd = isWindows ? 'rmdir' : 'rm';
          const rmArgs = isWindows ? ['/s', '/q', snapshotPath] : ['-rf', snapshotPath];
          spawn(rmCmd, rmArgs);
        }

        res.status(500).json({ 
          success: false, 
          message: `Snapshot creation failed with exit code ${code}`,
          error: stderrData
        });
      }
    });

    child.on('error', (error) => {
      if (fs.existsSync(snapshotPath)) {
        const isWindows = process.platform === 'win32';
        const rmCmd = isWindows ? 'rmdir' : 'rm';
        const rmArgs = isWindows ? ['/s', '/q', snapshotPath] : ['-rf', snapshotPath];
        spawn(rmCmd, rmArgs);
      }

      res.status(500).json({ success: false, message: error.message });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;