const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'db.json');
const adapter = new FileSync(dbPath);
const db = low(adapter);

db.defaults({
  servers: [],
  tasks: [],
  snapshots: [],
  webdavConfig: {
    enabled: false,
    port: 8080,
    username: '',
    password: '',
    storage_path: './webdav-storage'
  }
}).write();

function generateId(collection) {
  const items = db.get(collection).value();
  return items.length > 0 ? Math.max(...items.map(i => i.id)) + 1 : 1;
}

const database = {
  getServers() {
    return db.get('servers').sortBy('created_at').reverse().value();
  },

  getServer(id) {
    return db.get('servers').find({ id: parseInt(id) }).value();
  },

  addServer(data) {
    const id = generateId('servers');
    const server = {
      id,
      ...data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.get('servers').push(server).write();
    return { lastID: id };
  },

  updateServer(id, data) {
    db.get('servers')
      .find({ id: parseInt(id) })
      .assign({ ...data, updated_at: new Date().toISOString() })
      .write();
  },

  deleteServer(id) {
    db.get('servers').remove({ id: parseInt(id) }).write();
  },

  getTasks() {
    const tasks = db.get('tasks').sortBy('created_at').reverse().value();
    const servers = db.get('servers').value();
    return tasks.map(task => {
      const server = task.server_id ? servers.find(s => s.id === task.server_id) : null;
      return {
        ...task,
        server_name: server ? server.name : (task.sync_type === 'local' ? '本地' : ''),
        server_host: server ? server.host : '',
        host: server ? server.host : task.host,
        port: server ? server.port : task.port,
        username: server ? server.username : task.username,
        password: server ? server.password : task.password
      };
    });
  },

  cleanOldLogs(maxAgeDays = 30) {
    return logger.cleanOldLogs(maxAgeDays);
  },

  getTask(id) {
    const task = db.get('tasks').find({ id: parseInt(id) }).value();
    if (!task) return null;
    const server = db.get('servers').find({ id: task.server_id }).value();
    return {
      ...task,
      server_name: server ? server.name : '',
      server_host: server ? server.host : '',
      host: server ? server.host : task.host,
      port: server ? server.port : task.port,
      username: server ? server.username : task.username,
      password: server ? server.password : task.password
    };
  },

  addTask(data) {
    const id = generateId('tasks');
    const task = {
      id,
      ...data,
      enabled: data.enabled !== undefined ? data.enabled : true,
      status: 'idle',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.get('tasks').push(task).write();
    return { lastID: id };
  },

  updateTask(id, data) {
    db.get('tasks')
      .find({ id: parseInt(id) })
      .assign({ ...data, updated_at: new Date().toISOString() })
      .write();
  },

  deleteTask(id) {
    db.get('tasks').remove({ id: parseInt(id) }).write();
    logger.deleteTaskLogs(id);
  },

  getTaskLogs(taskId, limit = 50) {
    return logger.getTaskLogs(taskId, limit);
  },

  getLog(logId) {
    return logger.getLog(logId);
  },

  addLog(data) {
    return logger.addLog(data);
  },

  updateLog(logId, data) {
    logger.updateLog(logId, data);
  },

  // 新增：获取日志文件列表
  getLogFileList() {
    return logger.getLogFileList();
  },

  // 新增：获取指定日期的日志内容
  getLogFileContent(dateStr) {
    return logger.getLogFileContent(dateStr);
  },

  getWebDAVConfig() {
    return db.get('webdavConfig').value();
  },

  updateWebDAVConfig(data) {
    db.set('webdavConfig', { ...data, updated_at: new Date().toISOString() }).write();
  },

  addSnapshot(data) {
    const id = generateId('snapshots');
    const snapshot = {
      id,
      ...data,
      created_at: new Date().toISOString()
    };
    db.get('snapshots').push(snapshot).write();
    return { lastID: id };
  },

  getSnapshots(taskId = null, limit = 50) {
    let query = db.get('snapshots');
    if (taskId) {
      query = query.filter({ task_id: parseInt(taskId) });
    }
    return query.sortBy('created_at').reverse().take(limit).value();
  },

  getSnapshot(id) {
    return db.get('snapshots').find({ id: parseInt(id) }).value();
  },

  deleteSnapshot(id) {
    db.get('snapshots').remove({ id: parseInt(id) }).write();
  },

  updateSnapshot(id, data) {
    db.get('snapshots')
      .find({ id: parseInt(id) })
      .assign(data)
      .write();
  }
};

module.exports = database;