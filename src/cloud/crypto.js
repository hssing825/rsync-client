const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

const MAGIC = Buffer.from('RSENC1', 'ascii');
const FORMAT_VERSION = 2;
const SALT_SIZE = 16;
const IV_SIZE = 12;
const TAG_SIZE = 16;

// 头部布局: MAGIC(6) + 版本(1) + 标志(1) + 明文长度(8) + 明文修改时间(8) + 盐(16) + IV(12)
const HEADER_SIZE = MAGIC.length + 1 + 1 + 8 + 8 + SALT_SIZE + IV_SIZE;
const OVERHEAD = HEADER_SIZE + TAG_SIZE;
const KEY_LENGTH = 32;
const TMP_SUFFIX = '.rsenc.tmp';
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const OFFSET_VERSION = MAGIC.length;
const OFFSET_FLAGS = MAGIC.length + 1;
const OFFSET_PLAIN_SIZE = MAGIC.length + 2;
const OFFSET_PLAIN_MTIME = MAGIC.length + 10;
const OFFSET_SALT = MAGIC.length + 18;
const OFFSET_IV = OFFSET_SALT + SALT_SIZE;

// scrypt 派生开销较大，按「密码 + 盐」缓存结果，避免逐文件重复计算
const keyCache = new Map();
const KEY_CACHE_LIMIT = 64;

function generateSalt() {
  return crypto.randomBytes(SALT_SIZE);
}

function deriveKey(password, salt) {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'hex');
  const passwordDigest = crypto.createHash('sha256').update(String(password)).digest('hex');
  const cacheKey = `${passwordDigest}:${saltBuf.toString('hex')}`;

  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  const key = crypto.scryptSync(String(password), saltBuf, KEY_LENGTH, SCRYPT_OPTIONS);
  if (keyCache.size >= KEY_CACHE_LIMIT) {
    keyCache.delete(keyCache.keys().next().value);
  }
  keyCache.set(cacheKey, key);
  return key;
}

function buildHeader(plainSize, plainMtimeMs, salt, iv) {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, OFFSET_VERSION);
  header.writeUInt8(0, OFFSET_FLAGS);
  header.writeBigUInt64BE(BigInt(plainSize), OFFSET_PLAIN_SIZE);
  header.writeBigUInt64BE(BigInt(Math.max(0, Math.round(plainMtimeMs))), OFFSET_PLAIN_MTIME);
  salt.copy(header, OFFSET_SALT);
  iv.copy(header, OFFSET_IV);
  return header;
}

function parseHeader(buffer) {
  if (!buffer || buffer.length < HEADER_SIZE) {
    return { encrypted: false };
  }
  if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    return { encrypted: false };
  }

  const version = buffer.readUInt8(OFFSET_VERSION);
  if (version !== FORMAT_VERSION) {
    return { encrypted: false, unsupportedVersion: version };
  }

  return {
    encrypted: true,
    plainSize: Number(buffer.readBigUInt64BE(OFFSET_PLAIN_SIZE)),
    plainMtimeMs: Number(buffer.readBigUInt64BE(OFFSET_PLAIN_MTIME)),
    salt: Buffer.from(buffer.subarray(OFFSET_SALT, OFFSET_SALT + SALT_SIZE)),
    iv: Buffer.from(buffer.subarray(OFFSET_IV, HEADER_SIZE))
  };
}

function readHeader(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < OVERHEAD) {
    return { encrypted: false, size: stat.size };
  }

  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    fs.readSync(fd, header, 0, HEADER_SIZE, 0);
    return { ...parseHeader(header), size: stat.size };
  } finally {
    fs.closeSync(fd);
  }
}

// 构建「头部 + 密文 + 认证标签」的可读流，用于直接上传，全程不落盘
function createEncryptStream(filePath, password, salt) {
  const stat = fs.statSync(filePath);
  const saltBuf = Buffer.isBuffer(salt) ? salt : generateSalt();
  const iv = crypto.randomBytes(IV_SIZE);
  const key = deriveKey(password, saltBuf);
  const header = buildHeader(stat.size, stat.mtimeMs, saltBuf, iv);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const output = new PassThrough();
  const input = fs.createReadStream(filePath);

  input.on('error', (error) => output.destroy(error));
  cipher.on('error', (error) => output.destroy(error));

  // 上传被取消或中断时，及时释放本地文件句柄
  output.on('close', () => {
    input.destroy();
    cipher.destroy();
  });

  output.write(header);
  input.pipe(cipher).pipe(output, { end: false });
  cipher.on('end', () => {
    try {
      output.end(cipher.getAuthTag());
    } catch (error) {
      output.destroy(error);
    }
  });

  return {
    stream: output,
    contentLength: stat.size + OVERHEAD,
    plainSize: stat.size
  };
}

// 把「头部 + 密文 + 标签」的响应流边解密边写入本地，全程不落盘
function decryptStreamToFile(readable, destFilePath, password, options = {}) {
  const { onCancel = null } = options;

  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destFilePath), { recursive: true });

    // 先写入临时文件，校验通过后再原子替换，避免解密失败破坏本地已有文件
    const tmpFilePath = `${destFilePath}${TMP_SUFFIX}`;
    const output = fs.createWriteStream(tmpFilePath);
    let headerBuffer = Buffer.alloc(0);
    let decipher = null;
    let tail = Buffer.alloc(0);
    let header = null;
    let rawMode = false;
    let plainBytes = 0;
    let settled = false;
    let outputClosed = false;

    const cleanupTmp = () => {
      try {
        if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
      } catch (e) {
        // 忽略清理失败
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      readable.destroy();
      if (decipher) decipher.destroy();
      const done = () => {
        cleanupTmp();
        reject(error);
      };
      if (outputClosed) {
        done();
      } else {
        output.once('close', done);
        output.destroy();
      }
    };

    const writeOut = (buffer) => {
      if (!buffer || buffer.length === 0) return;
      if (!output.write(buffer)) {
        readable.pause();
        output.once('drain', () => readable.resume());
      }
    };

    readable.on('data', (chunk) => {
      if (settled) return;
      if (onCancel && onCancel()) {
        fail(new Error('Task cancelled'));
        return;
      }

      try {
        if (!decipher && !rawMode) {
          headerBuffer = Buffer.concat([headerBuffer, chunk]);
          if (headerBuffer.length < HEADER_SIZE) return;

          header = parseHeader(headerBuffer.subarray(0, HEADER_SIZE));
          if (!header.encrypted) {
            // 兼容远端存放的未加密文件，原样写出
            rawMode = true;
            writeOut(headerBuffer);
            plainBytes += headerBuffer.length;
            headerBuffer = Buffer.alloc(0);
            return;
          }

          decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(password, header.salt), header.iv);
          chunk = headerBuffer.subarray(HEADER_SIZE);
          headerBuffer = Buffer.alloc(0);
        }

        if (rawMode) {
          writeOut(chunk);
          plainBytes += chunk.length;
          return;
        }

        // 末尾 16 字节是认证标签，需要保留到流结束再校验
        const buffered = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
        if (buffered.length <= TAG_SIZE) {
          tail = Buffer.from(buffered);
          return;
        }

        const body = buffered.subarray(0, buffered.length - TAG_SIZE);
        tail = Buffer.from(buffered.subarray(buffered.length - TAG_SIZE));
        const plain = decipher.update(body);
        plainBytes += plain.length;
        writeOut(plain);
      } catch (error) {
        fail(error);
      }
    });

    readable.on('end', () => {
      if (settled) return;
      try {
        if (rawMode) {
          output.end();
          return;
        }
        if (!decipher) {
          // 流在读到完整头部前就结束：按未加密文件原样写出
          writeOut(headerBuffer);
          plainBytes += headerBuffer.length;
          headerBuffer = Buffer.alloc(0);
          output.end();
          return;
        }
        decipher.setAuthTag(tail);
        const final = decipher.final();
        if (final.length > 0) {
          plainBytes += final.length;
          output.write(final);
        }
        output.end();
      } catch (error) {
        fail(error);
      }
    });

    readable.on('error', fail);
    output.on('error', fail);

    // Windows 下需等文件句柄完全释放后才能改名，因此统一在 close 后再替换
    output.on('close', () => {
      outputClosed = true;
      if (settled) return;
      settled = true;
      try {
        fs.renameSync(tmpFilePath, destFilePath);
        const mtimeMs = header && header.encrypted ? header.plainMtimeMs : Date.now();
        const when = new Date(mtimeMs > 0 ? mtimeMs : Date.now());
        fs.utimesSync(destFilePath, when, when);
      } catch (error) {
        cleanupTmp();
        reject(error);
        return;
      }
      resolve({ plainBytes, header });
    });
  });
}

function matchesExclude(relativePath, pattern) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!pattern) return false;

  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    return normalized === dir || normalized.startsWith(`${dir}/`);
  }

  const ext = path.extname(normalized);
  return pattern === path.basename(normalized) || pattern === `*${ext}`;
}

// GCM 认证失败通常意味着密码错误或文件损坏，用于给出明确提示
function isAuthError(error) {
  if (!error || !error.message) return false;
  const message = String(error.message).toLowerCase();
  return message.includes('unable to authenticate')
    || message.includes('bad decrypt')
    || message.includes('wrong final block length');
}

module.exports = {
  MAGIC,
  OVERHEAD,
  HEADER_SIZE,
  TAG_SIZE,
  FORMAT_VERSION,
  TMP_SUFFIX,
  generateSalt,
  deriveKey,
  buildHeader,
  parseHeader,
  readHeader,
  createEncryptStream,
  decryptStreamToFile,
  matchesExclude,
  isAuthError
};