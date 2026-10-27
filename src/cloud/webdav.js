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
            const href = decodeURIComponent(hrefMatch[1]);
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
  async uploadFile(localFilePath, remotePath, onProgress = null) {
    let retries = 0;
    
    while (retries <= this.maxRetries) {
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
            relativePath,
            size: stat.size,
            mtime: stat.mtime
          });
        }
      }
    };

    walk(dir);
    return results;
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

  // 增量同步目录
  async syncDirectory(localDir, remoteDir, options = {}) {
    const {
      deleteFiles = false,
      exclude = [],
      onProgress = null,
      onFileComplete = null,
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
            // 提取相对路径
            let relativePath = file.path;
            relativePath = decodeURIComponent(relativePath).replace(/^\//, '');
            
            // 移除 WebDAV 根路径前缀（如 /dav/）
            const davPrefix = relativePath.split('/')[0];
            if (davPrefix && relativePath.startsWith(davPrefix + '/')) {
              relativePath = relativePath.substring(davPrefix.length + 1);
            }
            
            // 移除 remoteDir 前缀
            const normalizedRemoteDir = remoteDir.replace(/^\//, '');
            if (relativePath.startsWith(normalizedRemoteDir)) {
              relativePath = relativePath.substring(normalizedRemoteDir.length).replace(/^\//, '');
            }
            
            remoteFilesMap.set(relativePath, { ...file, exists: true });
          });
        }
      }

      for (const localFile of localFiles) {
        const remotePath = path.join(remoteDir, localFile.relativePath).replace(/\\/g, '/');
        const remoteFile = remoteFilesMap.get(localFile.relativePath);

        if (onProgress) {
          const percent = Math.round(((uploadedFiles + skippedFiles) / totalFiles) * 100);
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

        const result = await this.uploadFile(localFile.fullPath, remotePath);

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