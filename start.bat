@echo off
echo ========================================
echo   Rsync Client - 本地开发启动脚本
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 检查依赖...
if not exist "node_modules\" (
    echo 安装依赖...
    call npm install
    if errorlevel 1 (
        echo 依赖安装失败！
        pause
        exit /b 1
    )
) else (
    echo 依赖已存在
)

echo.
echo [2/3] 创建数据目录...
if not exist "data" mkdir data
if not exist "webdav-storage" mkdir webdav-storage

echo.
echo [3/3] 启动服务器...
echo.
echo ========================================
echo   服务器地址: http://localhost:3000
echo   按 Ctrl+C 停止服务器
echo ========================================
echo.

call npm start

pause