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
      direction = 'push',
      onProgress = null,
      onFileComplete = null
    } = options;

    const startTime = Date.now();
    const isPull = direction === 'pull';
    let sourcePath = task.source_path;
    
    // 解析源路径：支持相对路径和绝对路径
    const PROJECT_ROOT = path.join(__dirname, '..', '..');
    if (!path.isAbsolute(sourcePath)) {
      sourcePath = path.join(PROJECT_ROOT, sourcePath);
    }

    // 推送时验证源路径存在；拉取时本地路径是目标，允许自动创建
    if (!isPull) {
      if (!fs.existsSync(sourcePath)) {
        return {
          success: false,
          message: `源路径不存在: ${sourcePath}`
        };
      }
    } else if (fs.existsSync(sourcePath) && !fs.statSync(sourcePath).isDirectory()) {
      return {
        success: false,
        message: `本地目标路径不是目录: ${sourcePath}`
      };
    }

    // remoteBasePath 已经是目标路径，不需要再次拼接 task.target_path
    const remoteDir = this.remoteBasePath.replace(/\\/g, '/');

    console.log(`\n[OpenList Sync] Starting sync (${isPull ? '拉取' : '推送'}): ${task.name}`);
    console.log(`[OpenList Sync] Local: ${sourcePath}`);
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

      const commonOptions = {
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
      };

      // 根据方向执行推送或拉取
      const result = isPull
        ? await this.webdav.pullDirectory(remoteDir, sourcePath, commonOptions)
        : await this.webdav.syncDirectory(sourcePath, remoteDir, commonOptions);

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