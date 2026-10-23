const express = require('express');
const db = require('../database');
const { exec, spawn } = require('child_process');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const runningTasks = {};
const scheduledTasks = {};

// 项目根目录
const PROJECT_ROOT = path.join(__dirname, '..', '..');

function loadScheduledTasks() {
  const tasks = db.getTasks().filter(t => t.enabled && t.cron_expression);
  
  tasks.forEach(task => {
    if (task.cron_expression && cron.validate(task.cron_expression)) {
      scheduleTask(task);
    }
  });
}

function scheduleTask(task) {
  if (scheduledTasks[task.id]) {
    scheduledTasks[task.id].stop();
  }

  const cronTask = cron.schedule(task.cron_expression, async () => {
    await executeTask(task.id);
  });

  scheduledTasks[task.id] = cronTask;
}

async function executeTask(taskId) {
  const task = db.getTask(taskId);
  
  if (!task) return;

  const startTime = Date.now();

  // 解析源路径：支持相对路径和绝对路径
  let sourcePath = task.source_path;
  if (!path.isAbsolute(sourcePath)) {
    // 相对路径：相对于项目根目录
    sourcePath = path.join(PROJECT_ROOT, sourcePath);
  }
  
  // Windows 路径转换为 rsync 兼容格式
  // cwRsync 使用 Cygwin 路径格式：/cygdrive/c/... 或 /cygdrive/f/...
  if (process.platform === 'win32') {
    // 检测是否是 Windows 路径（如 F:/workspace 或 F:\workspace）
    const winPathMatch = sourcePath.match(/^([A-Za-z]):[\/\\]/);
    if (winPathMatch) {
      const drive = winPathMatch[1].toLowerCase();
      const restPath = sourcePath.substring(2).replace(/\\/g, '/');
      sourcePath = `/cygdrive/${drive}${restPath}`;
    } else {
      // 已经是正斜杠的路径
      sourcePath = sourcePath.replace(/\\/g, '/');
    }
  }

  console.log(`\n[Task ${taskId}] Starting task: ${task.name}`);
  console.log(`[Task ${taskId}] Source: ${sourcePath}`);
  console.log(`[Task ${taskId}] Target: ${buildTargetPath(task)}`);

  const logEntry = db.addLog({
    task_id: taskId,
    status: 'running',
    message: 'Task started'
  });

  db.updateTask(taskId, { status: 'running', last_run_at: new Date().toISOString() });

  const rsyncOptions = JSON.parse(task.rsync_options || '{}');
  const rsyncArgs = buildRsyncArgs(task, rsyncOptions);
  const targetPath = buildTargetPath(task);

  console.log(`[Task ${taskId}] Rsync command: rsync ${rsyncArgs.join(' ')} ${sourcePath} ${targetPath}`);

  const child = spawn('rsync', [...rsyncArgs, sourcePath, targetPath]);
  runningTasks[taskId] = child;

  let stdoutData = '';
  let stderrData = '';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdoutData += text;
    console.log(`[Task ${taskId}] ${text.trim()}`);
    updateLogProgress(logEntry.lastID, sourcePath, targetPath, rsyncArgs);
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrData += text;
    console.error(`[Task ${taskId}] ${text.trim()}`);
    updateLogProgress(logEntry.lastID, sourcePath, targetPath, rsyncArgs);
  });

  function updateLogProgress(logId, src, tgt, args) {
    const combinedOutput = (stdoutData + '\n' + stderrData).trim();
    const lines = combinedOutput.split('\n').filter(l => l.trim());
    const latestLines = lines.slice(-20).join('\n');
    
    // 调试：检查是否有进度信息
    const lastLine = lines[lines.length - 1] || '';
    const hasProgress = lastLine.includes('%') || lastLine.includes('to-chk=');
    console.log(`[Task ${taskId}] updateLogProgress called, logId=${logId}, hasProgress=${hasProgress}, lastLine=${lastLine}`);
    
    try {
      db.updateLog(logId, {
        status: 'running',
        message: latestLines
      });
      console.log(`[Task ${taskId}] Database updated successfully`);
    } catch (err) {
      console.error(`[Task ${taskId}] Database update failed:`, err);
    }
  }

  child.on('close', (code) => {
    delete runningTasks[taskId];
    
    const status = code === 0 ? 'success' : 'failed';
    const result = code === 0 ? '成功' : `失败 (退出码 ${code})`;
    const summary = `任务${result} | 耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    
    const fullLog = [
      summary,
      `源路径: ${sourcePath}`,
      `目标: ${targetPath}`,
      `命令: rsync ${rsyncArgs.join(' ')} ${sourcePath} ${targetPath}`,
      ``,
      `输出:`,
      stdoutData || '(无输出)',
      ``,
      stderrData ? `错误: ${stderrData}` : ''
    ].filter(Boolean).join('\n');

    console.log(`\n[Task ${taskId}] ${summary}`);
    console.log(`[Task ${taskId}] Exit code: ${code}`);

    db.updateLog(logEntry.lastID, {
      status,
      message: fullLog,
      finished_at: new Date().toISOString()
    });

    db.updateTask(taskId, { status: status === 'success' ? 'idle' : 'error' });

    if (code === 0 && task.sync_type === 'local' && task.auto_snapshot !== 0) {
      createSnapshotAfterBackup(taskId, task, sourcePath);
    }
  });

  child.on('error', (error) => {
    delete runningTasks[taskId];
    
    console.error(`\n[Task ${taskId}] Spawn error: ${error.message}`);
    
    const fullLog = [
      `=== Task Failed ===`,
      `Error: ${error.message}`,
      ``,
      `=== Troubleshooting ===`,
      `1. Check if rsync is installed and in PATH`,
      `2. Verify source path exists: ${task.source_path}`,
      `3. Check target server connectivity`,
      `4. Review rsync options configuration`
    ].join('\n');

    db.updateLog(logEntry.lastID, {
      status: 'error',
      message: fullLog,
      finished_at: new Date().toISOString()
    });

    db.updateTask(taskId, { status: 'error' });
  });
}

function createSnapshotAfterBackup(taskId, task, sourcePath) {
  const PROJECT_ROOT = path.join(__dirname, '..', '..');
  const snapshotsDir = path.join(PROJECT_ROOT, 'data', 'snapshots');
  
  if (!fs.existsSync(snapshotsDir)) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotName = `auto-${task.name}-${timestamp}`;
  const snapshotPath = path.join(snapshotsDir, `task-${taskId}-${timestamp}`);

  if (!fs.existsSync(snapshotPath)) {
    fs.mkdirSync(snapshotPath, { recursive: true });
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

  console.log(`\n[Task ${taskId}] Creating snapshot: ${snapshotName}`);
  console.log(`[Task ${taskId}] Snapshot path: ${targetPath}`);

  const child = spawn('rsync', ['-avz', '--delete', sourcePath + '/', targetPath + '/']);
  
  let stdoutData = '';
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
    console.error(`[Task ${taskId}] Snapshot error: ${data.toString()}`);
  });

  child.on('close', (code) => {
    if (code === 0) {
      const sizeMatch = stdoutData.match(/total size is ([\d,]+)/);
      if (sizeMatch) {
        totalSize = parseInt(sizeMatch[1].replace(/,/g, ''));
      }

      db.addSnapshot({
        task_id: taskId,
        task_name: task.name,
        name: snapshotName,
        description: 'Auto snapshot after successful backup',
        snapshot_path: snapshotPath,
        source_path: task.source_path,
        file_count: fileCount,
        total_size: totalSize,
        status: 'completed',
        created_at: new Date().toISOString()
      });

      console.log(`[Task ${taskId}] Snapshot created successfully`);
    } else {
      console.error(`[Task ${taskId}] Snapshot creation failed with exit code ${code}`);
      if (fs.existsSync(snapshotPath)) {
        const isWindows = process.platform === 'win32';
        const rmCmd = isWindows ? 'rmdir' : 'rm';
        const rmArgs = isWindows ? ['/s', '/q', snapshotPath] : ['-rf', snapshotPath];
        spawn(rmCmd, rmArgs);
      }
    }
  });

  child.on('error', (error) => {
    console.error(`[Task ${taskId}] Snapshot creation error: ${error.message}`);
    if (fs.existsSync(snapshotPath)) {
      const isWindows = process.platform === 'win32';
      const rmCmd = isWindows ? 'rmdir' : 'rm';
      const rmArgs = isWindows ? ['/s', '/q', snapshotPath] : ['-rf', snapshotPath];
      spawn(rmCmd, rmArgs);
    }
  });
}

function buildRsyncArgs(task, options) {
  const args = [];
  
  args.push('-avz');
  
  if (options.delete) args.push('--delete');
  if (options.progress) {
    // 使用 progress2 显示总体文件数量进度
    args.push('--info=progress2');
  }
  if (options.dry_run) args.push('--dry-run');
  if (options.compress) args.push('--compress');
  if (options.archive) args.push('--archive');
  if (options.verbose) args.push('--verbose');
  if (options.times) args.push('--times');
  if (options.owner) args.push('--owner');
  if (options.group) args.push('--group');
  if (options.perms) args.push('--perms');
  if (options.recursive) args.push('--recursive');
  if (options.links) args.push('--links');
  if (options.hard_links) args.push('--hard-links');
  if (options.devices) args.push('--devices');
  if (options.specials) args.push('--specials');
  
  if (options.exclude) {
    options.exclude.split('\n').filter(e => e.trim()).forEach(exclude => {
      args.push('--exclude', exclude.trim());
    });
  }
  
  if (options.include) {
    options.include.split('\n').filter(i => i.trim()).forEach(include => {
      args.push('--include', include.trim());
    });
  }
  
  if (options.bandwidth_limit) {
    args.push('--bwlimit', options.bandwidth_limit);
  }
  
  if (options.password_file) {
    args.push('--password-file', options.password_file);
  }
  
  // SSH 模式特殊处理（Windows 兼容性）
  const module = task.module ? task.module.trim() : '';
  if (!module && task.username) {
    // SSH 模式：使用 ssh 命令并添加 Windows 兼容参数
    const sshCmd = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    args.push('--rsh', sshCmd);
  } else if (options.rsh) {
    args.push('--rsh', options.rsh);
  }
  
  if (options.port && options.port !== 873) {
    args.push('--port', options.port);
  }
  
  return args;
}

function buildTargetPath(task) {
  const syncType = task.sync_type || 'remote';
  
  // 本地同步：直接返回目标路径
  if (syncType === 'local') {
    let targetPath = task.target_path || '';
    // Windows 路径转换为 rsync 兼容格式
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
    return targetPath;
  }
  
  // 远程同步
  const module = task.module ? task.module.trim() : '';
  const targetPath = task.target_path || '';
  
  if (module) {
    // rsync 守护进程模式：user@host::module/path
    const cleanPath = targetPath.replace(/^\//, '');
    
    if (task.username && task.password) {
      process.env.RSYNC_PASSWORD = task.password;
      return `${task.username}@${task.host}::${module}/${cleanPath}`;
    }
    
    return `${task.host}::${module}/${cleanPath}`;
  } else {
    // SSH 模式：user@host:/path
    if (task.username) {
      return `${task.username}@${task.host}:${targetPath}`;
    }
    return `${task.host}:${targetPath}`;
  }
}

router.get('/', (req, res) => {
  try {
    const tasks = db.getTasks();
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const task = db.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }
    res.json({ success: true, data: task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, sync_type, server_id, module, source_path, target_path, cron_expression, auto_snapshot, rsync_options } = req.body;
    
    if (!name || !source_path || !target_path) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // 远程同步必须指定服务器，本地同步不需要
    if (sync_type === 'remote' && !server_id) {
      return res.status(400).json({ success: false, message: 'Remote sync requires a server' });
    }

    const result = db.addTask({
      name,
      sync_type: sync_type || 'remote',
      server_id: sync_type === 'local' ? null : parseInt(server_id),
      module: module || null,
      source_path,
      target_path,
      cron_expression: cron_expression || null,
      auto_snapshot: auto_snapshot !== undefined ? (auto_snapshot ? 1 : 0) : 1,
      rsync_options: JSON.stringify(rsync_options || {})
    });

    const task = db.getTask(result.lastID);
    
    if (task.enabled && task.cron_expression) {
      scheduleTask(task);
    }

    res.status(201).json({ success: true, data: { id: result.lastID } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const task = db.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    const updateData = {};
    
    // 只更新实际提供的字段
    if (req.body.name !== undefined) updateData.name = req.body.name;
    if (req.body.sync_type !== undefined) updateData.sync_type = req.body.sync_type;
    if (req.body.server_id !== undefined) updateData.server_id = req.body.sync_type === 'local' ? null : parseInt(req.body.server_id);
    if (req.body.module !== undefined) updateData.module = req.body.module || null;
    if (req.body.source_path !== undefined) updateData.source_path = req.body.source_path;
    if (req.body.target_path !== undefined) updateData.target_path = req.body.target_path;
    if (req.body.cron_expression !== undefined) updateData.cron_expression = req.body.cron_expression;
    if (req.body.auto_snapshot !== undefined) updateData.auto_snapshot = req.body.auto_snapshot ? 1 : 0;
    if (req.body.enabled !== undefined) updateData.enabled = req.body.enabled ? 1 : 0;
    if (req.body.rsync_options !== undefined) updateData.rsync_options = JSON.stringify(req.body.rsync_options);

    db.updateTask(req.params.id, updateData);

    const updatedTask = db.getTask(req.params.id);
    
    if (scheduledTasks[req.params.id]) {
      scheduledTasks[req.params.id].stop();
      delete scheduledTasks[req.params.id];
    }
    
    if (updatedTask.enabled && updatedTask.cron_expression) {
      scheduleTask(updatedTask);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const task = db.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    if (runningTasks[req.params.id]) {
      runningTasks[req.params.id].kill();
      delete runningTasks[req.params.id];
    }

    if (scheduledTasks[req.params.id]) {
      scheduledTasks[req.params.id].stop();
      delete scheduledTasks[req.params.id];
    }

    db.deleteTask(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const task = db.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    // 清理僵尸进程
    if (runningTasks[req.params.id]) {
      const proc = runningTasks[req.params.id];
      try {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        // 进程可能已经退出
      }
      delete runningTasks[req.params.id];
    }

    // 同步执行 executeTask，确保状态正确更新后再返回响应
    await executeTask(req.params.id);
    
    res.json({ success: true, message: 'Task started' });
  } catch (err) {
    console.error(`[Task ${req.params.id}] Run error:`, err.message);
    db.updateTask(req.params.id, { status: 'error' });
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:id/stop', (req, res) => {
  try {
    const task = db.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    // 如果有运行中的进程，强制终止
    if (runningTasks[req.params.id]) {
      const proc = runningTasks[req.params.id];
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        // 进程可能已经退出
      }
      delete runningTasks[req.params.id];
    }

    console.log(`\n[Task ${req.params.id}] Task manually stopped`);

    // 更新任务状态
    db.updateTask(req.params.id, { status: 'stopped' });

    // 更新日志
    const logs = db.getTaskLogs(req.params.id, 1);
    if (logs.length > 0 && logs[0].status === 'running') {
      db.updateLog(logs[0].id, {
        status: 'stopped',
        message: (logs[0].message || '') + '\n\n=== Task Manually Stopped ===',
        finished_at: new Date().toISOString()
      });
    }

    res.json({ success: true, message: 'Task stopped' });
  } catch (err) {
    console.error(`[Task ${req.params.id}] Stop error:`, err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id/logs', (req, res) => {
  try {
    const logs = db.getTaskLogs(req.params.id);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/:id/logs/:logId/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const logId = req.params.logId;
  
  const sendLog = () => {
    const log = db.getLog(logId);
    if (log) {
      res.write(`data: ${JSON.stringify(log)}\n\n`);
    }
  };
  
  sendLog();
  const interval = setInterval(sendLog, 1000);
  
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

router.get('/scheduled', (req, res) => {
  const scheduled = Object.keys(scheduledTasks).map(id => ({
    task_id: id,
    next_run: scheduledTasks[id].nextDate().toJSDate()
  }));
  
  res.json({ success: true, data: scheduled });
});

// 清理旧日志
router.post('/logs/clean', (req, res) => {
  try {
    const { days } = req.body;
    const daysToKeep = days || 7;
    
    const cleaned = db.cleanOldLogs(daysToKeep);
    
    res.json({ 
      success: true, 
      message: `Cleaned ${cleaned ? cleaned.length : 0} old log entries`,
      cleaned: cleaned ? cleaned.length : 0
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

loadScheduledTasks();

module.exports = router;