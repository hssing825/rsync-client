const axios = require('axios');
const fs = require('fs');
const path = require('path');

class WebDAVSync {
  constructor(config) {
    this.username = config.username;
    this.password = config.password;
    this.webdavUrl = config.webdav_url;
    this.maxRetries = config.max_retries || 3;
    this.retryDelay = config.retry_delay || 5000;
    
    // 创建axios实例用于WebDAV
    this.client = axios.create({
      baseURL: this.webdavUrl,
      timeout: 300000, // 5分钟超时，适合大文件
      auth: {
        username: this.username,
        password: this.password
      },
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
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
            type: 'WebDAV (OpenList)'
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
    // 移除开头的 /
    const normalizedPath = remotePath.replace(/^\//, '');
    const parts = normalizedPath.split('/').filter(p => p);
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      try {
        // 尝试 MKCOL 创建目录
        await this.client.request({
          method: 'MKCOL',
          url: currentPath
        });
      } catch (error) {
        // 405 Method Not Allowed 表示目录已存在
        // 其他错误忽略，继续处理
        if (error.response && error.response.status === 405) {
          // 目录已存在，继续
        } else if (error.response && error.response.status === 409) {
          // 冲突，可能父目录不存在，继续尝试
        }
        // 其他错误也忽略，继续尝试
      }
    }

    return { success: true };
  }

  // 获取远程文件信息
  async getRemoteFileInfo(remotePath) {
    try {
      // 移除开头的 /
      const normalizedPath = remotePath.replace(/^\//, '');
      const response = await this.client.request({
        method: 'PROPFIND',
        url: normalizedPath,
        headers: {
          'Depth': '0'
        }
      });

      if (response.status === 207) {
        const xml = response.data;
        const sizeMatch = xml.match(/<getcontentlength>(\d+)<\/getcontentlength>/);
        const dateMatch = xml.match(/<getlastmodified>([^<]+)<\/getlastmodified>/);

        return {
          exists: true,
          size: sizeMatch ? parseInt(sizeMatch[1]) : null,
          lastModified: dateMatch ? new Date(dateMatch[1]) : null
        };
      }
      return { exists: false };
    } catch (error) {
      if (error.response && (error.response.status === 404 || error.response.status === 405)) {
        return { exists: false };
      }
      return { exists: false, error: error.message };
    }
  }

  // 列出远程目录
  async listRemoteDirectory(remotePath, depth = 'infinity') {
    try {
      // 移除开头的 /
      const normalizedPath = remotePath.replace(/^\//, '');
      const response = await this.client.request({
        method: 'PROPFIND',
        url: normalizedPath,
        headers: {
          'Depth': depth
        }
      });

      if (response.status === 207) {
        const xml = response.data;
        const files = [];
        
        // 解析 XML 响应 - 支持命名空间前缀（如 d:response, d:href）
        const responseRegex = /<[\w:]*response[\s>][\s\S]*?<\/[\w:]*response>/g;
        let match;
        
        while ((match = responseRegex.exec(xml)) !== null) {
          const responseXml = match[0];
          
          // 支持命名空间前缀的 href
          const hrefMatch = responseXml.match(/<[\w:]*href[^>]*>([^<]+)<\/[\w:]*href>/);
          // 支持命名空间前缀的 getcontentlength
          const sizeMatch = responseXml.match(/<[\w:]*getcontentlength[^>]*>(\d+)<\/[\w:]*getcontentlength>/);
          // 支持命名空间前缀的 getlastmodified
          const dateMatch = responseXml.match(/<[\w:]*getlastmodified[^>]*>([^<]+)<\/[\w:]*getlastmodified>/);
          // 支持命名空间前缀的 resourcetype
          const typeMatch = responseXml.match(/<[\w:]*resourcetype[^>]*>([\s\S]*?)<\/[\w:]*resourcetype>/);

          if (hrefMatch) {
            // 保留原始编码，交由 getRemoteRelativePath 统一解码，避免二次解码
            const href = hrefMatch[1];
            const isCollection = typeMatch && typeMatch[1].includes('<collection/>');
            
            if (!isCollection && sizeMatch) {
              files.push({
                path: href,
                size: parseInt(sizeMatch[1]),
                lastModified: dateMatch ? new Date(dateMatch[1]) : null
              });
            }
          }
        }

        return { success: true, files };
      }
      return { success: false, message: `Failed to list directory: HTTP ${response.status}` };
    } catch (error) {
      return { success: false, message: `Failed to list directory: ${error.message}` };
    }
  }

  // 上传文件（带重试）
  async uploadFile(localFilePath, remotePath, onProgress = null, onCancel = null) {
    let retries = 0;
    
    while (retries <= this.maxRetries) {
      try {
        // 检查是否已取消
        if (onCancel && onCancel()) {
          throw new Error('Task cancelled');
        }

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
            // 检查是否已取消
            if (onCancel && onCancel()) {
              fileStream.destroy();
              throw new Error('Task cancelled');
            }
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
        retries++;
        if (retries > this.maxRetries) {
          if (error.response) {
            return { success: false, message: `上传失败: ${error.response.status} ${error.response.statusText}` };
          }
          return { success: false, message: `上传失败: ${error.message}` };
        }
        
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      }
    }
  }

  // 删除远程文件
  async deleteFile(remotePath) {
    try {
      const normalizedPath = remotePath.replace(/^\//, '');
      const response = await this.client.delete(normalizedPath);
      return { success: true, message: '删除成功' };
    } catch (error) {
      if (error.response) {
        return { success: false, message: `删除失败: ${error.response.status} ${error.response.statusText}` };
      }
      throw new Error(`删除失败: ${error.message}`);
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
          results.push({
            fullPath,
            relativePath: relativePath.replace(/\\/g, '/'),
            size: stat.size,
            mtime: stat.mtime
          });
        }
      }
    };

    walk(dir);
    return results;
  }

  // 计算远程文件相对于同步根目录的路径
  // 兼容 WebDAV 地址带多段路径的情况（如 http://host:5244/op/dav）
  getRemoteRelativePath(href, remoteDir) {
    let relativePath = String(href || '').replace(/\\/g, '/');
    try {
      relativePath = decodeURIComponent(relativePath);
    } catch (e) {
      // 已经是解码后的路径，忽略重复解码错误
    }

    // href 可能是完整 URL，先取出路径部分
    if (/^https?:\/\//i.test(relativePath)) {
      try {
        relativePath = new URL(relativePath).pathname;
      } catch (e) {
        relativePath = relativePath.replace(/^https?:\/\/[^/]+/i, '');
      }
    }

    // 去掉 WebDAV 基础路径前缀
    let basePath = '';
    try {
      basePath = new URL(this.webdavUrl).pathname.replace(/\/+$/, '');
    } catch (e) {
      basePath = '';
    }
    if (basePath && basePath !== '/') {
      if (relativePath.startsWith(basePath + '/')) {
        relativePath = relativePath.substring(basePath.length + 1);
      } else if (relativePath === basePath) {
        return '';
      }
    }

    relativePath = relativePath.replace(/^\/+/, '');

    // 去掉同步根目录前缀
    const normalizedRemoteDir = (remoteDir || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (normalizedRemoteDir) {
      if (relativePath.startsWith(normalizedRemoteDir + '/')) {
        relativePath = relativePath.substring(normalizedRemoteDir.length + 1);
      } else if (relativePath === normalizedRemoteDir) {
        return '';
      } else {
        // 兜底：在路径中查找同步根目录位置
        const index = relativePath.indexOf(normalizedRemoteDir + '/');
        if (index > 0) {
          relativePath = relativePath.substring(index + normalizedRemoteDir.length + 1);
        }
      }
    }

    return relativePath.replace(/^\/+/, '');
  }

  // 检查文件是否需要同步
  needsSync(localFile, remoteFile) {
    if (!remoteFile || !remoteFile.exists) {
      return true; // 远程文件不存在，需要同步
    }

    // 只比较文件大小
    // 注意：WebDAV 返回的 lastModified 通常是上传时间而非文件原始修改时间，不可靠
    if (localFile.size !== remoteFile.size) {
      return true; // 大小不同，需要同步
    }

    return false; // 文件大小相同，认为是同一个文件
  }

  // 下载远程文件到本地
  async downloadFile(remotePath, localFilePath, onProgress = null, onCancel = null) {
    let retries = 0;

    while (retries <= this.maxRetries) {
      try {
        if (onCancel && onCancel()) {
          throw new Error('Task cancelled');
        }

        // 确保本地父目录存在
        const parentDir = path.dirname(localFilePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        const normalizedPath = remotePath.replace(/^\//, '');
        const response = await this.client.get(normalizedPath, {
          responseType: 'stream',
          onDownloadProgress: (progressEvent) => {
            if (onCancel && onCancel()) {
              throw new Error('Task cancelled');
            }
            if (onProgress && progressEvent.total) {
              const percent = Math.round((progressEvent.loaded / progressEvent.total) * 100);
              onProgress(percent, progressEvent.loaded, progressEvent.total);
            }
          }
        });

        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(localFilePath);
          response.data.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
          response.data.on('error', reject);
        });

        return { success: true, message: '下载成功' };
      } catch (error) {
        retries++;
        if (error.message === 'Task cancelled') {
          if (fs.existsSync(localFilePath)) {
            try { fs.unlinkSync(localFilePath); } catch (e) { /* ignore */ }
          }
          return { success: false, message: '任务已取消' };
        }
        if (retries > this.maxRetries) {
          if (error.response) {
            return { success: false, message: `下载失败: ${error.response.status} ${error.response.statusText}` };
          }
          return { success: false, message: `下载失败: ${error.message}` };
        }
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      }
    }
  }

  // 从远程拉取到本地（反向同步）
  async pullDirectory(remoteDir, localDir, options = {}) {
    const {
      deleteFiles = false,
      exclude = [],
      onProgress = null,
      onFileComplete = null,
      onCancel = null,
      incremental = true
    } = options;

    try {
      // 确保本地目录存在
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      // 获取远程文件列表
      const remoteListResult = await this.listRemoteDirectory(remoteDir);
      if (!remoteListResult.success) {
        return { success: false, message: `无法列出远程目录: ${remoteListResult.message}` };
      }

      // 规范化远程相对路径
      const remoteFiles = [];
      remoteListResult.files.forEach(file => {
        const relativePath = this.getRemoteRelativePath(file.path, remoteDir);

        if (!relativePath) return;

        // 排除规则
        const shouldExclude = exclude.some(pattern => {
          if (pattern.endsWith('/')) {
            return relativePath.startsWith(pattern.slice(0, -1));
          }
          const ext = path.extname(relativePath);
          return pattern === path.basename(relativePath) || pattern === `*${ext}`;
        });
        if (shouldExclude) return;

        remoteFiles.push({
          relativePath,
          fullRemotePath: `${remoteDir.replace(/\/$/, '')}/${relativePath}`.replace(/\/+/g, '/'),
          size: file.size,
          lastModified: file.lastModified
        });
      });

      const totalFiles = remoteFiles.length;
      let downloadedFiles = 0;
      let skippedFiles = 0;
      let failedFiles = 0;

      // 列出本地文件（用于增量比对和删除检查）
      const localFiles = this.listFiles(localDir, exclude);
      const localFilesMap = new Map();
      localFiles.forEach(f => localFilesMap.set(f.relativePath.replace(/\\/g, '/'), f));

      // 删除本地存在但远程不存在的文件
      if (deleteFiles && incremental) {
        const remoteRelativeSet = new Set(remoteFiles.map(f => f.relativePath));
        for (const localFile of localFiles) {
          if (onCancel && onCancel()) {
            throw new Error('Task cancelled');
          }
          if (!remoteRelativeSet.has(localFile.relativePath)) {
            console.log(`[WebDAV] Deleting local file: ${localFile.relativePath}`);
            try {
              fs.unlinkSync(localFile.fullPath);
              if (onFileComplete) {
                onFileComplete(localFile.relativePath, 'deleted');
              }
            } catch (error) {
              console.error(`[WebDAV] Failed to delete local file ${localFile.relativePath}: ${error.message}`);
            }
          }
        }
      }

      for (const remoteFile of remoteFiles) {
        if (onCancel && onCancel()) {
          throw new Error('Task cancelled');
        }

        if (onProgress) {
          const percent = totalFiles === 0 ? 100 : Math.round(((downloadedFiles + skippedFiles) / totalFiles) * 100);
          onProgress(percent, downloadedFiles + skippedFiles, totalFiles, remoteFile.relativePath);
        }

        // 增量比对：本地已存在且大小相同则跳过
        const localFile = localFilesMap.get(remoteFile.relativePath);
        if (incremental && localFile && localFile.size === remoteFile.size) {
          skippedFiles++;
          if (onFileComplete) {
            onFileComplete(remoteFile.relativePath, 'skipped');
          }
          continue;
        }

        const localFullPath = path.join(localDir, remoteFile.relativePath);
        const result = await this.downloadFile(remoteFile.fullRemotePath, localFullPath, null, onCancel);

        if (result.success) {
          downloadedFiles++;
          if (onFileComplete) {
            onFileComplete(remoteFile.relativePath, true);
          }
        } else {
          failedFiles++;
          if (onFileComplete) {
            onFileComplete(remoteFile.relativePath, false, result.message);
          }
        }
      }

      if (onProgress) {
        onProgress(100, downloadedFiles + skippedFiles, totalFiles, '完成');
      }

      return {
        success: true,
        message: `拉取完成: ${downloadedFiles} 个文件下载, ${skippedFiles} 个文件跳过${failedFiles > 0 ? `, ${failedFiles} 个失败` : ''}`,
        uploadedFiles: downloadedFiles,
        skippedFiles,
        totalFiles,
        failedFiles
      };
    } catch (error) {
      if (error.message === 'Task cancelled') {
        return { success: false, message: '任务已取消' };
      }
      return { success: false, message: `拉取失败: ${error.message}` };
    }
  }

  // 增量同步目录
  async syncDirectory(localDir, remoteDir, options = {}) {
    const {
      deleteFiles = false,
      exclude = [],
      onProgress = null,
      onFileComplete = null,
      onCancel = null,
      incremental = true
    } = options;

    try {
      // 确保远程根目录存在
      await this.ensureDirectoryExists(remoteDir);

      const localFiles = this.listFiles(localDir, exclude);
      const totalFiles = localFiles.length;
      let uploadedFiles = 0;
      let skippedFiles = 0;
      let failedFiles = 0;

      // 获取远程文件列表（如果是增量同步）
      let remoteFilesMap = new Map();
      if (incremental) {
        const remoteListResult = await this.listRemoteDirectory(remoteDir);
        if (remoteListResult.success) {
          remoteListResult.files.forEach(file => {
            // 提取相对路径（兼容 WebDAV 地址带多段路径）
            const relativePath = this.getRemoteRelativePath(file.path, remoteDir);
            if (!relativePath) return;

            remoteFilesMap.set(relativePath, { ...file, exists: true });
          });
        }
      }

      // 构建本地文件路径集合（用于删除检查）
      const localFilePaths = new Set(localFiles.map(f => f.relativePath.replace(/\\/g, '/')));

      console.log(`[WebDAV] deleteFiles=${deleteFiles}, incremental=${incremental}, remoteFilesMap.size=${remoteFilesMap.size}, localFilePaths.size=${localFilePaths.size}`);

      // 删除目标文件中不存在于源文件的文件
      if (deleteFiles && incremental) {
        let deletedFiles = 0;
        for (const [remoteRelativePath, remoteFile] of remoteFilesMap) {
          if (onCancel && onCancel()) {
            throw new Error('Task cancelled');
          }
          if (!localFilePaths.has(remoteRelativePath)) {
            console.log(`[WebDAV] Deleting remote file: ${remoteRelativePath}`);
            try {
              const fullRemotePath = path.join(remoteDir, remoteRelativePath).replace(/\\/g, '/');
              await this.deleteFile(fullRemotePath);
              deletedFiles++;
              if (onFileComplete) {
                onFileComplete(remoteRelativePath, 'deleted');
              }
            } catch (error) {
              if (error.message === 'Task cancelled') throw error;
              console.error(`[WebDAV] Failed to delete ${remoteRelativePath}: ${error.message}`);
            }
          }
        }
        if (deletedFiles > 0) {
          console.log(`[WebDAV] Deleted ${deletedFiles} remote files that no longer exist locally`);
        }
      }

      for (const localFile of localFiles) {
        // 检查是否已取消
        if (onCancel && onCancel()) {
          throw new Error('Task cancelled');
        }

        const remotePath = path.join(remoteDir, localFile.relativePath).replace(/\\/g, '/');
        // 统一使用正斜杠进行匹配
        const normalizedLocalPath = localFile.relativePath.replace(/\\/g, '/');
        const remoteFile = remoteFilesMap.get(normalizedLocalPath);

        if (onProgress) {
          const percent = totalFiles === 0 ? 100 : Math.round(((uploadedFiles + skippedFiles) / totalFiles) * 100);
          onProgress(percent, uploadedFiles + skippedFiles, totalFiles, localFile.relativePath);
        }

        // 检查是否需要同步
        if (incremental && !this.needsSync(localFile, remoteFile)) {
          skippedFiles++;
          if (onFileComplete) {
            onFileComplete(localFile.relativePath, 'skipped');
          }
          continue;
        }

        const result = await this.uploadFile(localFile.fullPath, remotePath, null, onCancel);

        if (result.success) {
          uploadedFiles++;
          if (onFileComplete) {
            onFileComplete(localFile.relativePath, true);
          }
        } else {
          failedFiles++;
          if (onFileComplete) {
            onFileComplete(localFile.relativePath, false, result.message);
          }
        }
      }

      if (onProgress) {
        onProgress(100, uploadedFiles + skippedFiles, totalFiles, '完成');
      }

      return {
        success: true,
        message: `同步完成: ${uploadedFiles} 个文件上传, ${skippedFiles} 个文件跳过${failedFiles > 0 ? `, ${failedFiles} 个失败` : ''}`,
        uploadedFiles,
        skippedFiles,
        totalFiles,
        failedFiles
      };
    } catch (error) {
      return { success: false, message: `同步失败: ${error.message}` };
    }
  }
}

module.exports = WebDAVSync;