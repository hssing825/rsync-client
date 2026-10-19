@echo off
echo ========================================
echo   Rsync Client - Docker 启动脚本
echo ========================================
echo.

cd /d "%~dp0"

echo [1/2] 构建 Docker 镜像...
docker-compose build

if errorlevel 1 (
    echo Docker 构建失败！
    pause
    exit /b 1
)

echo.
echo [2/2] 启动 Docker 容器...
docker-compose up -d

echo.
echo ========================================
echo   服务器地址: http://localhost:3000
echo   查看日志: docker-compose logs -f
echo   停止服务: docker-compose down
echo ========================================
echo.

pause