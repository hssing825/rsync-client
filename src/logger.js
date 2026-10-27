const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

class TaskLogger {
  constructor() {
    // 内存中缓存日志记录：logId -> logEntry
    // 任务运行时，日志只存在内存中，完成后才写入文件
    this.logs = new Map();
    // 缓存任务名称：taskId -> taskName
    this.taskNames = new Map();
  }

  // 设置任务名称缓存
  setTaskName(taskId, taskName) {
    this.taskNames.set(String(taskId), taskName);
  }

  getTaskName(taskId) {
    return this.taskNames.get(String(taskId)) || `任务 ${taskId}`;
  }

  getDateString(date = new Date()) {
    return date.toISOString().split('T')[0];
  }

  getLogFilePath(dateStr) {
    return path.join(logDir, `task-${dateStr}.log`);
  }

  generateLogId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  // 添加日志记录（任务开始时调用）
  addLog(data) {
    const logId = this.generateLogId();
    const logEntry = {
      id: logId,
      task_id: data.task_id,
      task_name: data.task_name || this.getTaskName(data.task_id),
      status: data.status || 'running',
      message: data.message || '',
      started_at: new Date().toISOString(),
      finished_at: null
    };

    // 只存在内存中，不写入文件
    this.logs.set(logId, logEntry);

    return { lastID: logId };
  }

  // 更新日志记录（任务运行时频繁调用，只更新内存）
  updateLog(logId, data) {
    const logEntry = this.logs.get(logId);
    if (!logEntry) {
      console.error(`[Logger] Log entry not found: ${logId}`);
      return;
    }

    // 只更新内存中的记录，不写入文件
    Object.assign(logEntry, data);
    if (data.finished_at) {
      logEntry.finished_at = data.finished_at;
    }

    // 只有任务完成时才写入文件
    if (data.finished_at || data.status === 'success' || data.status === 'failed' || data.status === 'error') {
      this.writeLogToFile(logEntry);
      // 写入后从内存中移除
      this.logs.delete(logId);
    }
  }

  // 写入日志到文件（只在任务完成时调用）
  writeLogToFile(logEntry) {
    const dateStr = this.getDateString(new Date(logEntry.started_at));
    const logFile = this.getLogFilePath(dateStr);

    // 确保目录存在
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(logFile, logLine, 'utf8');
  }

  // 从文件加载日志
  loadLogFromFile(logId) {
    const files = this.getLogFiles();
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.trim().split('\n');
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.id === logId) {
              this.logs.set(logId, entry);
              return;
            }
          } catch (e) {
            // 跳过无效行
          }
        }
      } catch (e) {
        // 跳过无法读取的文件
      }
    }
  }

  // 获取日志文件列表
  getLogFiles() {
    try {
      const files = fs.readdirSync(logDir)
        .filter(f => f.startsWith('task-') && f.endsWith('.log'))
        .sort()
        .reverse();
      return files.map(f => path.join(logDir, f));
    } catch (e) {
      return [];
    }
  }

  // 获取任务的日志列表
  getTaskLogs(taskId, limit = 50) {
    const logs = [];
    const files = this.getLogFiles();

    // 先从内存中查找运行中的日志
    for (const [logId, logEntry] of this.logs) {
      if (String(logEntry.task_id) === String(taskId)) {
        logs.push(logEntry);
        if (logs.length >= limit) return logs;
      }
    }

    // 再从文件中查找历史日志
    for (const file of files) {
      if (logs.length >= limit) break;

      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.trim().split('\n');
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (String(entry.task_id) === String(taskId)) {
              logs.push(entry);
              if (logs.length >= limit) break;
            }
          } catch (e) {
            // 跳过无效行
          }
        }
      } catch (e) {
        // 跳过无法读取的文件
      }
    }

    // 按开始时间倒序排列
    return logs.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  }

  // 获取单个日志
  getLog(logId) {
    if (this.logs.has(logId)) {
      return this.logs.get(logId);
    }

    // 从文件中查找
    this.loadLogFromFile(logId);
    return this.logs.get(logId) || null;
  }

  // 删除任务的所有日志
  deleteTaskLogs(taskId) {
    // 清理内存
    for (const [key, value] of this.logs) {
      if (String(value.task_id) === String(taskId)) {
        this.logs.delete(key);
      }
    }

    // 清理文件
    const files = this.getLogFiles();
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.trim().split('\n');
        const filteredLines = lines.filter(line => {
          try {
            const entry = JSON.parse(line);
            return String(entry.task_id) !== String(taskId);
          } catch (e) {
            return true;
          }
        });

        if (filteredLines.length < lines.length) {
          fs.writeFileSync(file, filteredLines.join('\n') + '\n', 'utf8');
        }
      } catch (e) {
        // 跳过
      }
    }
  }

  // 清理旧日志文件
  cleanOldLogs(maxAgeDays = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
    const cutoffStr = this.getDateString(cutoffDate);

    const files = this.getLogFiles();
    let cleanedCount = 0;

    for (const file of files) {
      const fileName = path.basename(file);
      const dateMatch = fileName.match(/task-(\d{4}-\d{2}-\d{2})\.log/);
      
      if (dateMatch && dateMatch[1] < cutoffStr) {
        try {
          fs.unlinkSync(file);
          cleanedCount++;
          console.log(`[Logger] Deleted old log file: ${fileName}`);
        } catch (e) {
          console.error(`[Logger] Failed to delete ${fileName}:`, e.message);
        }
      }
    }

    // 清理内存中的旧日志
    for (const [key, value] of this.logs) {
      const logDate = this.getDateString(new Date(value.started_at));
      if (logDate < cutoffStr) {
        this.logs.delete(key);
      }
    }

    console.log(`[Logger] Cleaned ${cleanedCount} old log files`);
    return cleanedCount;
  }

  // 获取日志文件列表（用于前端展示）
  getLogFileList() {
    const files = this.getLogFiles();
    return files.map(file => {
      const fileName = path.basename(file);
      const dateMatch = fileName.match(/task-(\d{4}-\d{2}-\d{2})\.log/);
      const stats = fs.statSync(file);
      
      // 读取文件内容，获取任务名称
      let taskNames = [];
      try {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.trim().split('\n');
        const taskIds = new Set();
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            taskIds.add(entry.task_id);
            if (entry.task_name) {
              this.taskNames.set(String(entry.task_id), entry.task_name);
            }
          } catch (e) {
            // 跳过
          }
        }
        
        for (const taskId of taskIds) {
          taskNames.push(this.getTaskName(taskId));
        }
      } catch (e) {
        // 忽略
      }
      
      return {
        filename: fileName,
        date: dateMatch ? dateMatch[1] : 'unknown',
        size: stats.size,
        created: stats.birthtime,
        task_names: taskNames
      };
    });
  }

  // 读取指定日期的日志文件内容
  getLogFileContent(dateStr) {
    const logFile = this.getLogFilePath(dateStr);
    
    if (!fs.existsSync(logFile)) {
      return null;
    }

    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const lines = content.trim().split('\n');
      const logs = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.task_name) {
            this.taskNames.set(String(entry.task_id), entry.task_name);
          }
          logs.push(entry);
        } catch (e) {
          // 跳过无效行
        }
      }

      return logs;
    } catch (e) {
      return null;
    }
  }
}

// 导出单例
module.exports = new TaskLogger();