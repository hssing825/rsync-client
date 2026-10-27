const WebDAVSync = require('./webdav');
const path = require('path');
const fs = require('fs');

class OpenListSync {
  constructor(config) {
    this.webdav = new WebDAVSync({
      username: config.username,
      password: config.password,
      webdav_url: config.webdav_url,
      max_retries: config.max_retries || 3,
      retry_delay: config.retry_delay || 5000
    });
    this.remoteBasePath = config.remote_path || '/';
  }

  // 测试 OpenList 连接
  async testConnection() {
    return await this.webdav.testConnection();
  }

  // 同步到 OpenList
  async sync(task, options = {}) {
    const {
      onProgress = null,
      onFileComplete = null
    } = options;

    const startTime = Date.now();
    let sourcePath = task.source_path;
    
    // 解析源路径：支持相对路径和绝对路径
    const PROJECT_ROOT = path.join(__dirname, '..', '..');
    if (!path.isAbsolute(sourcePath)) {
      sourcePath = path.join(PROJECT_ROOT, sourcePath);
    }

    // 验证源路径存在
    if (!fs.existsSync(sourcePath)) {
      return {
        success: false,
        message: `源路径不存在: ${sourcePath}`
      };
    }

    // remoteBasePath 已经是目标路径，不需要再次拼接 task.target_path
    const remoteDir = this.remoteBasePath.replace(/\\/g, '/');

    console.log(`\n[OpenList Sync] Starting sync: ${task.name}`);
    console.log(`[OpenList Sync] Source: ${sourcePath}`);
    console.log(`[OpenList Sync] Remote: ${remoteDir}`);

    try {
      // 解析排除规则
      const excludePatterns = [];
      let rsyncOptions = {};
      if (task.rsync_options) {
        rsyncOptions = typeof task.rsync_options === 'string' 
          ? JSON.parse(task.rsync_options) 
          : task.rsync_options;
        
        if (rsyncOptions.exclude) {
          excludePatterns.push(...rsyncOptions.exclude.split('\n').filter(e => e.trim()));
        }
      }

      // 执行同步
      const result = await this.webdav.syncDirectory(sourcePath, remoteDir, {
        incremental: task.sync_mode !== 'full',
        deleteFiles: rsyncOptions.delete || false,
        exclude: excludePatterns,
        onCancel: options.onCancel,
        onProgress: (percent, completed, total, currentFile) => {
          if (onProgress) {
            onProgress(percent, completed, total, currentFile);
          }
          console.log(`[OpenList Sync] Progress: ${percent}% (${completed}/${total}) - ${currentFile}`);
        },
        onFileComplete: (relativePath, status, errorMessage) => {
          if (onFileComplete) {
            onFileComplete(relativePath, status, errorMessage);
          }
        }
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      
      return {
        success: result.success,
        message: `${result.message} | 耗时: ${duration}s`,
        uploadedFiles: result.uploadedFiles,
        skippedFiles: result.skippedFiles,
        totalFiles: result.totalFiles,
        failedFiles: result.failedFiles,
        duration
      };
    } catch (error) {
      return {
        success: false,
        message: `同步失败: ${error.message}`
      };
    }
  }
}

module.exports = OpenListSync;