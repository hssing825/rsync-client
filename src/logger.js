const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

class TaskLogger {
  constructor() {
    this.currentDate = this.getDateString();
    this.currentLogFile = this.getLogFilePath(this.currentDate);
    this.logs = new Map(); // 内存中缓存日志记录
  }

  getDateString(date = new Date()) {
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
  }

  getLogFilePath(dateStr) {
    return path.join(logDir, `task-${dateStr}.log`);
  }

  // 生成唯一日志 ID
  generateLogId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  }

  // 添加日志记录
  addLog(data) {
    const logId = this.generateLogId();
    const logEntry = {
      id: logId,
      task_id: data.task_id,
      status: data.status || 'running',
      message: data.message || '',
      started_at: new Date().toISOString(),
      finished_at: null
    };

    this.logs.set(logId, logEntry);
    this.writeLogToFile(logEntry);

    return { lastID: logId };
  }

  // 写入日志到文件
  writeLogToFile(logEntry) {
    const dateStr = this.getDateString(new Date(logEntry.started_at));
    const logFile = this.getLogFilePath(dateStr);

    const logLine = JSON.stringify(logEntry) + '\n';
    fs.appendFileSync(logFile, logLine, 'utf8');
  }

  // 更新日志记录
  updateLog(logId, data) {
    const logEntry = this.logs.get(logId);
    if (!logEntry) {
      // 如果内存中没有，尝试从文件加载
      this.loadLogFromFile(logId);
    }

    const entry = this.logs.get(logId);
    if (entry) {
      Object.assign(entry, data);
      if (data.finished_at) {
        entry.finished_at = data.finished_at;
      }
      this.writeLogToFile(entry);
    }
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
            return true; // 保留无效行
          }
        });

        if (filteredLines.length < lines.length) {
          fs.writeFileSync(file, filteredLines.join('\n') + '\n', 'utf8');
        }
      } catch (e) {
        // 跳过无法处理的文件
      }
    }

    // 清理内存
    for (const [key, value] of this.logs) {
      if (String(value.task_id) === String(taskId)) {
        this.logs.delete(key);
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
      
      return {
        filename: fileName,
        date: dateMatch ? dateMatch[1] : 'unknown',
        size: stats.size,
        created: stats.birthtime
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