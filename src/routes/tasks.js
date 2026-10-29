const express = require('express');
const db = require('../database');
const { exec, spawn } = require('child_process');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const OpenListSync = require('../cloud/openlist');

const router = express.Router();

const runningTasks = {};
const scheduledTasks = {};

// 项目根目录
const PROJECT_ROOT = path.join(__dirname, '..', '..');

// 将路径转换为 rsync 兼容格式（Windows 下转为 Cygwin 路径）
function toRsyncPath(p) {
  if (process.platform === 'win32') {
    const winPathMatch = p.match(/^([A-Za-z]):[\/\\]/);
    if (winPathMatch) {
      const drive = winPathMatch[1].toLowerCase();
      const restPath = p.substring(2).replace(/\\/g, '/');
      return `/cygdrive/${drive}${restPath}`;
    }
    return p.replace(/\\/g, '/');
  }
  return p;
}

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

async function executeTask(taskId, direction = 'push') {
  const task = db.getTask(taskId);
  
  if (!task) return;

  const startTime = Date.now();
  const isPull = direction === 'pull';
  const directionText = isPull ? '拉取' : '推送';

  // 检查是否是 OpenList 同步任务
  if (task.sync_type === 'openlist') {
    await executeOpenListTask(taskId, task, startTime, direction);
    return;
  }

  // 解析本地路径：支持相对路径和绝对路径，并转换为 rsync 兼容格式
  let rawLocalPath = task.source_path;
  if (!path.isAbsolute(rawLocalPath)) {
    rawLocalPath = path.join(PROJECT_ROOT, rawLocalPath);
  }
  const localPath = toRsyncPath(rawLocalPath);

  // 根据方向确定 rsync 的源和目标
  // 推送：本地 -> 目标；拉取：目标 -> 本地
  const remotePath = buildTargetPath(task);
  const sourcePath = isPull ? remotePath : localPath;
  const targetPath = isPull ? localPath : remotePath;

  // 拉取时以远程目录内容为源，避免在本地生成同名的嵌套子目录
  const rsyncSource = isPull ? `${sourcePath.replace(/\/+$/, '')}/` : sourcePath;

  console.log(`\n[Task ${taskId}] Starting task (${directionText}): ${task.name}`);
  console.log(`[Task ${taskId}] Source: ${rsyncSource}`);
  console.log(`[Task ${taskId}] Target: ${targetPath}`);

  const logEntry = db.addLog({
    task_id: taskId,
    task_name: task.name,
    status: 'running',
    message: `任务开始（${directionText}）`
  });

  db.updateTask(taskId, { status: 'running', last_run_at: new Date().toISOString() });

  const rsyncOptions = JSON.parse(task.rsync_options || '{}');
  const rsyncArgs = buildRsyncArgs(task, rsyncOptions);

  console.log(`[Task ${taskId}] Rsync command: rsync ${rsyncArgs.join(' ')} ${rsyncSource} ${targetPath}`);

  const child = spawn('rsync', [...rsyncArgs, rsyncSource, targetPath]);
  runningTasks[taskId] = child;

  let stdoutData = '';
  let stderrData = '';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdoutData += text;
    console.log(`[Task ${taskId}] ${text.trim()}`);
    updateLogProgress(logEntry.lastID, rsyncSource, targetPath, rsyncArgs);
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrData += text;
    console.error(`[Task ${taskId}] ${text.trim()}`);
    updateLogProgress(logEntry.lastID, rsyncSource, targetPath, rsyncArgs);
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
    const summary = `任务${result}（${directionText}）| 耗时: ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
    
    const fullLog = [
      summary,
      `源路径: ${rsyncSource}`,
      `目标: ${targetPath}`,
      `命令: rsync ${rsyncArgs.join(' ')} ${rsyncSource} ${targetPath}`,
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

    if (code === 0 && !isPull && task.sync_type === 'local' && task.auto_snapshot !== 0) {
      createSnapshotAfterBackup(taskId, task, localPath);
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

async function executeOpenListTask(taskId, task, startTime, direction = 'push') {
  const isPull = direction === 'pull';
  const directionText = isPull ? '拉取' : '推送';
  console.log(`\n[Task ${taskId}] Starting OpenList sync (${directionText}): ${task.name}`);

  const logEntry = db.addLog({
    task_id: taskId,
    task_name: task.name,
    status: 'running',
    message: `OpenList 同步开始（${directionText}）`
  });

  db.updateTask(taskId, { status: 'running', last_run_at: new Date().toISOString() });

  // 累积进度消息
  let progressMessages = [];
  // 取消标志
  let isCancelled = false;
  runningTasks[taskId] = { cancel: () => { isCancelled = true; } };

  try {
    // 获取服务器配置
    const server = db.getServer(task.server_id);
    if (!server) {
      throw new Error('Server not found');
    }

    // 创建 OpenList 同步实例
    const openlistSync = new OpenListSync({
      username: server.username,
      password: server.password,
      webdav_url: server.webdav_url,
      remote_path: task.target_path,
      max_retries: 3,
      retry_delay: 5000
    });

    // 执行同步
    const result = await openlistSync.sync(task, {
      direction,
      onCancel: () => isCancelled,
      onProgress: (percent, completed, total, currentFile) => {
        if (isCancelled) return;
        const progressMsg = `进度: ${percent}% (${completed}/${total}) - ${currentFile}`;
        console.log(`[Task ${taskId}] ${progressMsg}`);
        progressMessages.push(progressMsg);
        // 只更新内存中的进度，不写文件
        db.updateLog(logEntry.lastID, {
          status: 'running',
          message: progressMessages.join('\n')
        });
      },
      onFileComplete: (relativePath, status, errorMessage) => {
        if (isCancelled) return;
        let statusText;
        if (status === 'skipped') {
          statusText = '跳过';
        } else if (status === 'deleted') {
          statusText = '已删除';
        } else if (status === true) {
          statusText = '成功';
        } else {
          statusText = `失败: ${errorMessage}`;
        }
        console.log(`[Task ${taskId}] ${relativePath}: ${statusText}`);
      }
    });

    if (isCancelled) {
      console.log(`\n[Task ${taskId}] OpenList sync cancelled`);
      db.updateLog(logEntry.lastID, {
        status: 'stopped',
        message: progressMessages.join('\n') + '\n\n=== Task Manually Stopped ===',
        finished_at: new Date().toISOString()
      });
      db.updateTask(taskId, { status: 'stopped' });
      delete runningTasks[taskId];
      return;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const status = result.success ? 'success' : 'failed';
    const statusText = result.success ? '成功' : '失败';
    
    const fullLog = [
      `=== OpenList 同步${statusText}（${directionText}） ===`,
      `任务: ${task.name}`,
      `本地路径: ${task.source_path}`,
      `远程路径: ${server.webdav_url}${task.target_path}`,
      ``,
      `进度记录:`,
      ...progressMessages,
      ``,
      `统计:`,
      `- ${isPull ? '下载' : '上传'}文件: ${result.uploadedFiles || 0}`,
      `- 跳过文件: ${result.skippedFiles || 0}`,
      `- 失败文件: ${result.failedFiles || 0}`,
      `- 总文件数: ${result.totalFiles || 0}`,
      `- 耗时: ${duration}s`,
      ``,
      `消息: ${result.message}`
    ].join('\n');

    console.log(`\n[Task ${taskId}] ${fullLog}`);

    db.updateLog(logEntry.lastID, {
      status,
      message: fullLog,
      finished_at: new Date().toISOString()
    });

    db.updateTask(taskId, { status: status === 'success' ? 'idle' : 'error' });
    delete runningTasks[taskId];

  } catch (error) {
    if (isCancelled) {
      console.log(`\n[Task ${taskId}] OpenList sync cancelled`);
      db.updateLog(logEntry.lastID, {
        status: 'stopped',
        message: progressMessages.join('\n') + '\n\n=== Task Manually Stopped ===',
        finished_at: new Date().toISOString()
      });
      db.updateTask(taskId, { status: 'stopped' });
      delete runningTasks[taskId];
      return;
    }
    
    console.error(`\n[Task ${taskId}] OpenList sync error: ${error.message}`);
    
    const fullLog = [
      `=== OpenList 同步失败 ===`,
      `任务: ${task.name}`,
      `错误: ${error.message}`,
      ``,
      `进度记录:`,
      ...progressMessages,
      ``,
      `=== 故障排查 ===`,
      `1. 检查 OpenList 服务是否运行`,
      `2. 验证 WebDAV 地址是否正确`,
      `3. 检查用户名和密码`,
      `4. 确认网络连接正常`
    ].join('\n');

    db.updateLog(logEntry.lastID, {
      status: 'error',
      message: fullLog,
      finished_at: new Date().toISOString()
    });

    db.updateTask(taskId, { status: 'error' });
    delete runningTasks[taskId];
  }
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
    const { name, sync_type, server_id, module, source_path, target_path, cron_expression, auto_snapshot, rsync_options, sync_mode } = req.body;
    
    if (!name || !source_path || !target_path) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // 远程同步和 OpenList 同步必须指定服务器，本地同步不需要
    if ((sync_type === 'remote' || sync_type === 'openlist') && !server_id) {
      return res.status(400).json({ success: false, message: 'Remote/OpenList sync requires a server' });
    }

    const result = db.addTask({
      name,
      sync_type: sync_type || 'remote',
      server_id: (sync_type === 'local') ? null : parseInt(server_id),
      module: module || null,
      source_path,
      target_path,
      cron_expression: cron_expression || null,
      auto_snapshot: auto_snapshot !== undefined ? (auto_snapshot ? 1 : 0) : 1,
      sync_mode: sync_mode || 'incremental',
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
    if (req.body.sync_mode !== undefined) updateData.sync_mode = req.body.sync_mode;
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
      const proc = runningTasks[req.params.id];
      try {
        if (typeof proc.cancel === 'function') {
          proc.cancel();
        } else if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        // 进程可能已经退出
      }
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
  await runTaskHandler(req, res, 'push');
});

router.post('/:id/pull', async (req, res) => {
  await runTaskHandler(req, res, 'pull');
});

async function runTaskHandler(req, res, direction) {
  try {
    const task = db.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    // 清理僵尸进程
    if (runningTasks[req.params.id]) {
      const proc = runningTasks[req.params.id];
      try {
        if (typeof proc.cancel === 'function') {
          proc.cancel();
        } else if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch (e) {
        // 进程可能已经退出
      }
      delete runningTasks[req.params.id];
    }

    // 同步执行 executeTask，确保状态正确更新后再返回响应
    await executeTask(req.params.id, direction);
    
    res.json({ success: true, message: 'Task started' });
  } catch (err) {
    console.error(`[Task ${req.params.id}] Run error:`, err.message);
    db.updateTask(req.params.id, { status: 'error' });
    res.status(500).json({ success: false, message: err.message });
  }
}

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
        // OpenList 任务使用 cancel 函数
        if (typeof proc.cancel === 'function') {
          proc.cancel();
        } else {
          // rsync 进程直接 kill
          proc.kill('SIGKILL');
        }
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