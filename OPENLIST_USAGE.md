# OpenList 同步功能使用指南

## 功能概述

通过 OpenList 作为中转，将本地文件同步到 OpenList，再由 OpenList 分发到各个网盘。

## 架构流程

```
本地文件 → 备份服务器 → OpenList (WebDAV) → 目标网盘
```

## 快速开始

### 1. 添加 OpenList 服务器

**API 请求：**
```bash
POST /api/servers
Content-Type: application/json

{
  "name": "我的OpenList",
  "server_type": "openlist",
  "username": "admin",
  "password": "your_password",
  "webdav_url": "http://your-openlist-ip:5244/dav"
}
```

**说明：**
- `webdav_url`: OpenList 的 WebDAV 地址，通常是 `http://ip:5244/dav`
- `username`: OpenList 用户名
- `password`: OpenList 密码

### 2. 测试连接

**API 请求：**
```bash
POST /api/servers/test
Content-Type: application/json

{
  "server_type": "openlist",
  "username": "admin",
  "password": "your_password",
  "webdav_url": "http://your-openlist-ip:5244/dav"
}
```

### 3. 创建同步任务

**API 请求：**
```bash
POST /api/tasks
Content-Type: application/json

{
  "name": "备份到OpenList",
  "sync_type": "openlist",
  "server_id": 1,
  "source_path": "F:/workspace/data",
  "target_path": "/backup/mydata",
  "sync_mode": "incremental",
  "cron_expression": "0 2 * * *",
  "rsync_options": {
    "exclude": "*.tmp\n*.log\nnode_modules"
  }
}
```

**参数说明：**
- `sync_type`: 必须为 `openlist`
- `server_id`: OpenList 服务器 ID
- `source_path`: 本地源路径（支持相对路径和绝对路径）
- `target_path`: OpenList 中的目标路径
- `sync_mode`: 同步模式
  - `incremental`: 增量同步（默认，只同步变更的文件）
  - `full`: 全量同步（每次都上传所有文件）
- `cron_expression`: 定时任务表达式（可选）
- `rsync_options.exclude`: 排除规则（可选）

### 4. 执行任务

**API 请求：**
```bash
POST /api/tasks/1/run
```

### 5. 查看任务日志

**API 请求：**
```bash
GET /api/tasks/1/logs
```

## 同步模式说明

### 增量同步（推荐）
- 只上传新增或修改的文件
- 通过比较文件大小和修改时间判断
- 节省带宽和时间
- 适合日常备份

### 全量同步
- 每次都上传所有文件
- 适合首次备份或强制刷新
- 耗时较长

## 排除规则示例

```
*.tmp
*.log
node_modules
.git
.DS_Store
Thumbs.db
```

## 注意事项

1. **OpenList 配置**
   - 确保 OpenList 已正确挂载网盘
   - 确保 WebDAV 功能已启用
   - 建议使用专用账号进行备份

2. **网络要求**
   - 备份服务器需要能访问 OpenList 服务
   - 建议在同一内网，速度更快

3. **文件限制**
   - 单个文件大小受 OpenList 和网盘限制
   - 大文件上传可能需要更长时间

4. **增量同步原理**
   - 比较文件大小
   - 比较修改时间（允许1秒误差）
   - 文件相同则跳过，不同则上传

## 故障排查

### 连接失败
1. 检查 OpenList 服务是否运行
2. 验证 WebDAV 地址是否正确
3. 检查用户名和密码
4. 确认网络连接正常

### 上传失败
1. 检查 OpenList 挂载的网盘是否有足够空间
2. 检查网盘是否支持写入
3. 查看任务日志获取详细错误信息

### 同步慢
1. 检查网络带宽
2. 使用增量同步模式
3. 添加排除规则减少文件数量
4. 检查 OpenList 和网盘的上传限速

## API 完整示例

### 完整工作流

```bash
# 1. 添加 OpenList 服务器
curl -X POST http://localhost:3002/api/servers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My OpenList",
    "server_type": "openlist",
    "username": "admin",
    "password": "admin123",
    "webdav_url": "http://192.168.1.100:5244/dav"
  }'

# 2. 测试连接
curl -X POST http://localhost:3002/api/servers/test \
  -H "Content-Type: application/json" \
  -d '{
    "server_type": "openlist",
    "username": "admin",
    "password": "admin123",
    "webdav_url": "http://192.168.1.100:5244/dav"
  }'

# 3. 创建任务
curl -X POST http://localhost:3002/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Daily Backup",
    "sync_type": "openlist",
    "server_id": 1,
    "source_path": "F:/workspace/data",
    "target_path": "/backup/daily",
    "sync_mode": "incremental",
    "cron_expression": "0 2 * * *",
    "rsync_options": {
      "exclude": "*.tmp\n*.log"
    }
  }'

# 4. 执行任务
curl -X POST http://localhost:3002/api/tasks/1/run

# 5. 查看日志
curl http://localhost:3002/api/tasks/1/logs
```

## 技术实现

- **WebDAV 协议**: 使用标准 WebDAV 协议与 OpenList 通信
- **增量同步**: 基于文件大小和修改时间的智能比对
- **断点续传**: 支持失败重试（默认3次）
- **进度显示**: 实时显示上传进度
- **定时任务**: 支持 cron 表达式定时执行