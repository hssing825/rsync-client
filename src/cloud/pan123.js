const axios = require('axios');
const fs = require('fs');
const path = require('path');

class Pan123Sync {
  constructor(config) {
    this.username = config.username;
    this.password = config.password;
    // 123云盘 WebDAV 地址
    this.webdavUrl = config.webdav_url || 'https://webdav.123pan.cn/webdav';
    
    // 创建axios实例用于WebDAV
    this.client = axios.create({
      baseURL: this.webdavUrl,
      timeout: 60000,
      auth: {
        username: this.username,
        password: this.password
      },
      headers: {
        'Content-Type': 'application/octet-stream'
      }
    });
  }

  // 测试连接
  async testConnection() {
    try {
      // 使用 PROPFIND 方法测试 WebDAV 连接
      const response = await this.client.request({
        method: 'PROPFIND',
        url: '/',
        headers: {
          'Depth': '0'
        }
      });

      if (response.status === 207) { // WebDAV 多状态响应
        return {
          success: true,
          message: '连接成功',
          userInfo: {
            username: this.username,
            type: '123云盘 (WebDAV)'
          }
        };
      } else {
        return { success: false, message: `连接失败: HTTP ${response.status}` };
      }
    } catch (error) {
      if (error.response) {
        return { success: false, message: `连接失败: ${error.response.status} ${error.response.statusText}` };
      }
      return { success: false, message: `连接失败: ${error.message}` };
    }
  }

  // 确保目录存在
  async ensureDirectoryExists(remotePath) {
    const parts = remotePath.split('/').filter(p => p);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;

      try {
        // 尝试 MKCOL 创建目录
        await this.client.request({
          method: 'MKCOL',
          url: currentPath
        });
      } catch (error) {
        // 405 表示目录已存在，其他错误继续
        if (error.response && error.response.status !== 405) {
          // 忽略错误，继续
        }
      }
    }

    return { success: true };
  }

  // 上传文件
  async uploadFile(localFilePath, remotePath, onProgress = null) {
    try {
      // 确保父目录存在
      const parentPath = path.dirname(remotePath).replace(/\\/g, '/');
      if (parentPath !== '.' && parentPath !== '/') {
        await this.ensureDirectoryExists(parentPath);
      }

      const fileStats = fs.statSync(localFilePath);
      const fileSize = fileStats.size;
      const fileStream = fs.createReadStream(localFilePath);

      // 使用 PUT 方法上传文件
      const response = await this.client.put(remotePath, fileStream, {
        headers: {
          'Content-Length': fileSize
        },
        onUploadProgress: (progressEvent) => {
          if (onProgress) {
            const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
            onProgress(percent, progressEvent.loaded, progressEvent.total);
          }
        }
      });

      if (response.status === 201 || response.status === 204 || response.status === 200) {
        return { success: true, message: '上传成功' };
      } else {
        return { success: false, message: `上传失败: HTTP ${response.status}` };
      }
    } catch (error) {
      if (error.response) {
        return { success: false, message: `上传失败: ${error.response.status} ${error.response.statusText}` };
      }
      return { success: false, message: `上传失败: ${error.message}` };
    }
  }

  // 列出本地文件
  listFiles(dir, exclude = []) {
    const results = [];

    const walk = (currentDir) => {
      const items = fs.readdirSync(currentDir);

      for (const item of items) {
        const fullPath = path.join(currentDir, item);
        const relativePath = path.relative(dir, fullPath);

        const shouldExclude = exclude.some(pattern => {
          if (pattern.endsWith('/')) {
            return relativePath.startsWith(pattern.slice(0, -1));
          }
          const ext = path.extname(item);
          return pattern === item || pattern === `*${ext}`;
        });

        if (shouldExclude) continue;

        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results;
  }

  // 同步目录
  async syncDirectory(localDir, remoteDir, options = {}) {
    const {
      deleteFiles = false,
      exclude = [],
      onProgress = null,
      onFileComplete = null
    } = options;

    try {
      // 确保远程根目录存在
      await this.ensureDirectoryExists(remoteDir);

      const files = this.listFiles(localDir, exclude);
      const totalFiles = files.length;
      let uploadedFiles = 0;

      for (const file of files) {
        const relativePath = path.relative(localDir, file);
        const remotePath = path.join(remoteDir, relativePath).replace(/\\/g, '/');

        if (onProgress) {
          const percent = Math.round((uploadedFiles / totalFiles) * 100);
          onProgress(percent, uploadedFiles, totalFiles, relativePath);
        }

        const result = await this.uploadFile(file, remotePath);

        if (result.success) {
          uploadedFiles++;
          if (onFileComplete) {
            onFileComplete(relativePath, true);
          }
        } else {
          if (onFileComplete) {
            onFileComplete(relativePath, false, result.message);
          }
        }
      }

      if (onProgress) {
        onProgress(100, uploadedFiles, totalFiles, '完成');
      }

      return {
        success: true,
        message: `同步完成: ${uploadedFiles}/${totalFiles} 个文件`,
        uploadedFiles,
        totalFiles
      };
    } catch (error) {
      return { success: false, message: `同步失败: ${error.message}` };
    }
  }
}

module.exports = Pan123Sync;