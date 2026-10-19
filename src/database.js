const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const fs = require('fs');

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
  taskLogs: [],
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
      const server = servers.find(s => s.id === task.server_id);
      return {
        ...task,
        server_name: server ? server.name : '',
        server_host: server ? server.host : '',
        host: server ? server.host : task.host,
        port: server ? server.port : task.port,
        username: server ? server.username : task.username,
        password: server ? server.password : task.password,
        module: server ? server.module : task.module
      };
    });
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
      password: server ? server.password : task.password,
      module: server ? server.module : task.module
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
    db.get('taskLogs').remove({ task_id: parseInt(id) }).write();
  },

  getTaskLogs(taskId, limit = 50) {
    return db.get('taskLogs')
      .filter({ task_id: parseInt(taskId) })
      .sortBy('started_at')
      .reverse()
      .take(limit)
      .value();
  },

  getLog(logId) {
    return db.get('taskLogs').find({ id: parseInt(logId) }).value();
  },

  addLog(data) {
    const id = generateId('taskLogs');
    const log = {
      id,
      ...data,
      started_at: new Date().toISOString()
    };
    db.get('taskLogs').push(log).write();
    return { lastID: id };
  },

  updateLog(logId, data) {
    db.get('taskLogs')
      .find({ id: parseInt(logId) })
      .assign(data)
      .write();
  },

  getWebDAVConfig() {
    return db.get('webdavConfig').value();
  },

  updateWebDAVConfig(data) {
    db.set('webdavConfig', { ...data, updated_at: new Date().toISOString() }).write();
  }
};

module.exports = database;