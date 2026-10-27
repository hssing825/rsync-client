# Rsync 备份管理系统

基于 Node.js 的 Rsync 备份管理工具，提供 Web 界面，支持移动端和 PC 端访问。

## 功能特性

- ✅ 多任务管理：添加、编辑、删除备份任务
- ✅ 定时执行：支持 Cron 表达式自动运行
- ✅ 手动/禁用：灵活控制任务运行状态
- ✅ 服务器管理：配置多个 Rsync 目标服务器
- ✅ 连通性测试：测试服务器连接状态
- ✅ 参数配置：自定义 Rsync 选项
- ✅ 实时日志：查看任务运行日志
- ✅ WebDAV 集成：内置 WebDAV 服务器
- ✅ 响应式设计：适配移动端和 PC 端
- ✅ Docker 支持：一键部署到容器环境

## 快速开始

### 方式一：本地运行（开发调试）

**Windows:**
```bash
# 双击运行
start.bat

# 或手动运行
npm install
npm start
```

**Linux/Mac:**
```bash
npm install
npm start
```

访问：http://localhost:3000

### 方式二：Docker 运行（生产环境）

**Windows:**
```bash
# 双击运行
start-docker.bat

# 或手动运行
docker-compose up -d
```

**Linux/Mac:**
```bash
docker-compose up -d
```

访问：http://localhost:3000

### 方式三：Docker 开发模式

```bash
# 使用开发配置（支持热重载）
docker-compose -f docker-compose.dev.yml up -d
```

## 项目结构

```
rsyncClient/
├── src/
│   ├── server.js           # 主服务器文件
│   ├── database.js         # 数据库配置
│   ├── routes/
│   │   ├── servers.js      # 服务器管理 API
│   │   ├── tasks.js        # 任务管理 API
│   │   └── webdav.js       # WebDAV API
│   └── public/
│       └── index.html      # Web 界面
├── data/                   # 数据库文件（自动创建）
├── webdav-storage/         # WebDAV 存储目录
├── Dockerfile              # 生产环境 Docker 配置
├── Dockerfile.dev          # 开发环境 Docker 配置
├── docker-compose.yml      # 生产环境编排
├── docker-compose.dev.yml  # 开发环境编排
├── start.bat               # Windows 本地启动脚本
├── start-docker.bat        # Windows Docker 启动脚本
└── package.json
```

## 使用指南

### 1. 添加 Rsync 服务器

1. 进入"服务器管理"标签页
2. 点击"添加服务器"
3. 填写服务器信息：
   - 名称：服务器标识
   - 主机：IP 或域名
   - 端口：默认 873
   - 用户名/密码：认证信息
   - 模块：Rsync 模块名
4. 点击"测试"验证连接
5. 保存配置

### 2. 创建备份任务

1. 进入"任务管理"标签页
2. 点击"添加任务"
3. 配置任务：
   - 任务名称
   - 选择服务器
   - 源路径：本地备份目录
   - 目标路径：远程存储路径
   - 定时规则：Cron 表达式（可选）
   - Rsync 选项：压缩、排除、带宽限制等
4. 保存任务

### 3. 管理任务

- **手动运行**：点击"运行"按钮
- **停止任务**：点击"停止"按钮
- **启用/禁用**：使用开关控制
- **查看日志**：点击"日志"按钮
- **编辑/删除**：相应操作按钮

### 4. WebDAV 配置

1. 进入"WebDAV 设置"标签页
2. 启用 WebDAV 服务
3. 配置端口、用户名、密码
4. 设置存储路径
5. 保存配置

## Cron 表达式示例

| 表达式 | 说明 |
|--------|------|
| `0 2 * * *` | 每天凌晨 2 点 |
| `0 */6 * * *` | 每 6 小时 |
| `0 9-18 * * 1-5` | 工作日 9-18 点每小时 |
| `0 0 * * 0` | 每周日午夜 |
| `*/30 * * * *` | 每 30 分钟 |

## Docker 命令

```bash
# 构建镜像
docker-compose build

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down

# 重启服务
docker-compose restart

# 查看状态
docker-compose ps
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3002 | 服务端口 |
| NODE_ENV | production | 运行环境 |

## 数据持久化

Docker 模式下，以下目录会挂载到宿主机：

- `./data` - SQLite 数据库文件
- `./webdav-storage` - WebDAV 存储文件

## 注意事项

### Rsync 依赖说明

**Docker 部署（推荐）**：
- ✅ Dockerfile 已自动安装 rsync（`RUN apk add --no-cache rsync`）
- ✅ 无需任何额外配置，开箱即用
- ✅ 生产环境推荐使用 Docker 部署

**本地开发（Windows）**：
- ❌ Windows 系统默认没有 rsync 命令
- 需要手动安装以下任一方案：

  **方案 1：cwRsync（推荐）**
  ```bash
  # 1. 下载：https://www.itefix.net/cwrsync-free-edition
  # 2. 安装后添加到系统 PATH
  # 3. 重启终端
  rsync --version
  ```

  **方案 2：WSL（Windows Subsystem for Linux）**
  ```powershell
  # 安装 WSL
  wsl --install
  
  # 在 WSL 中安装 rsync
  wsl sudo apt update
  wsl sudo apt install rsync
  ```

  **方案 3：Chocolatey**
  ```powershell
  choco install rsync
  ```

**Linux/Mac**：
```bash
# Linux
sudo apt install rsync  # Debian/Ubuntu
sudo yum install rsync  # CentOS/RHEL

# Mac
brew install rsync
```

### 其他注意事项

1. **防火墙**：确保端口 3000 和 873 可用
2. **权限**：确保有读写备份目录的权限
3. **开发建议**：Windows 开发推荐使用 Docker 开发模式，避免 rsync 安装问题
   ```bash
   docker-compose -f docker-compose.dev.yml up -d
   ```

## 技术栈

- **后端**: Node.js + Express
- **数据库**: SQLite (better-sqlite3)
- **任务调度**: node-cron
- **前端**: Vue 3 + Element Plus
- **WebDAV**: webdav-server
- **容器**: Docker + Docker Compose

## License

MIT