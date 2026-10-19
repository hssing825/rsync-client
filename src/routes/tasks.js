const express = require('express');
const db = require('../database');
const { exec, spawn } = require('child_process');
const cron = require('node-cron');

const router = express.Router();

const runningTasks = {};
const scheduledTasks = {};

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
  
  if (!task || !task.enabled) return;

  console.log(`\n[Task ${taskId}] Starting task: ${task.name}`);
  console.log(`[Task ${taskId}] Source: ${task.source_path}`);
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

  console.log(`[Task ${taskId}] Rsync command: rsync ${rsyncArgs.join(' ')} ${task.source_path} ${targetPath}`);

  const child = spawn('rsync', [...rsyncArgs, task.source_path, targetPath]);
  runningTasks[taskId] = child;

  let stdoutData = '';
  let stderrData = '';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdoutData += text;
    console.log(`[Task ${taskId}] ${text.trim()}`);
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrData += text;
    console.error(`[Task ${taskId}] ERROR: ${text.trim()}`);
  });

  child.on('close', (code) => {
    delete runningTasks[taskId];
    
    const status = code === 0 ? 'success' : 'failed';
    let message = code === 0 ? 'Task completed successfully' : `Task failed with exit code ${code}`;
    
    const fullLog = [
      `=== Task Started ===`,
      `Source: ${task.source_path}`,
      `Target: ${targetPath}`,
      `Command: rsync ${rsyncArgs.join(' ')} ${task.source_path} ${targetPath}`,
      ``,
      `=== Output ===`,
      stdoutData || '(no output)',
      ``,
      `=== Errors ===`,
      stderrData || '(no errors)',
      ``,
      `=== Result ===`,
      message
    ].join('\n');

    console.log(`\n[Task ${taskId}] ${message}`);
    console.log(`[Task ${taskId}] Exit code: ${code}`);

    db.updateLog(logEntry.lastID, {
      status,
      message: fullLog,
      finished_at: new Date().toISOString()
    });

    db.updateTask(taskId, { status: status === 'success' ? 'idle' : 'error' });
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

function buildRsyncArgs(task, options) {
  const args = [];
  
  args.push('-avz');
  
  if (options.delete) args.push('--delete');
  if (options.progress) args.push('--progress');
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
    const { name, server_id, source_path, target_path, cron_expression, rsync_options } = req.body;
    
    if (!name || !server_id || !source_path || !target_path) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const result = db.addTask({
      name,
      server_id: parseInt(server_id),
      source_path,
      target_path,
      cron_expression: cron_expression || null,
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
    const { name, server_id, source_path, target_path, cron_expression, enabled, rsync_options } = req.body;
    
    const task = db.getTask(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: 'Task not found' });
    }

    db.updateTask(req.params.id, {
      name,
      server_id: parseInt(server_id),
      source_path,
      target_path,
      cron_expression,
      enabled: enabled ? 1 : 0,
      rsync_options: JSON.stringify(rsync_options || {})
    });

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

loadScheduledTasks();

module.exports = router;