const OpenListSync = require('./src/cloud/openlist');

async function testOpenList() {
  console.log('=== OpenList 同步功能测试 ===\n');

  // 测试配置 - 请根据实际情况修改
  const config = {
    username: 'admin',
    password: 'admin',
    webdav_url: 'http://localhost:5244/dav',
    remote_path: '/backup'
  };

  console.log('1. 创建 OpenList 同步实例...');
  const openlistSync = new OpenListSync(config);

  console.log('2. 测试连接...');
  const testResult = await openlistSync.testConnection();
  console.log('连接结果:', testResult);

  if (!testResult.success) {
    console.log('\n连接失败，请检查配置：');
    console.log('- OpenList 服务是否运行');
    console.log('- WebDAV 地址是否正确（通常是 http://ip:5244/dav）');
    console.log('- 用户名和密码是否正确');
    return;
  }

  console.log('\n3. 测试同步功能...');
  
  // 创建测试任务
  const testTask = {
    name: '测试同步任务',
    source_path: './test-data',
    target_path: '/test-backup',
    sync_mode: 'incremental',
    rsync_options: JSON.stringify({
      exclude: '*.tmp\n*.log'
    })
  };

  const result = await openlistSync.sync(testTask, {
    onProgress: (percent, completed, total, currentFile) => {
      console.log(`进度: ${percent}% (${completed}/${total}) - ${currentFile}`);
    },
    onFileComplete: (relativePath, status, errorMessage) => {
      const statusText = status === 'skipped' ? '跳过' : status === true ? '成功' : `失败: ${errorMessage}`;
      console.log(`文件: ${relativePath} - ${statusText}`);
    }
  });

  console.log('\n=== 同步结果 ===');
  console.log('成功:', result.success);
  console.log('消息:', result.message);
  console.log('上传文件:', result.uploadedFiles);
  console.log('跳过文件:', result.skippedFiles);
  console.log('失败文件:', result.failedFiles);
  console.log('总文件数:', result.totalFiles);
  console.log('耗时:', result.duration, '秒');
}

testOpenList().catch(console.error);