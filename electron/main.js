'use strict';

// Electron 壳：内置启动服务端，窗口直接指向本地服务
const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = Number(process.env.PORT || 8090);
const LOG = path.join(os.tmpdir(), 'aiq-boot.log');

function log(msg) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

log('--- 启动 ---');

let win = null;

process.on('uncaughtException', (e) => {
  log('uncaughtException: ' + (e && e.stack || e));
});
process.on('unhandledRejection', (e) => {
  log('unhandledRejection: ' + (e && e.stack || e));
});

async function boot() {
  // 数据与插件放在用户目录，打包后也不会丢
  const userDir = app.getPath('userData');
  const dataDir = path.join(userDir, 'data');
  const pluginDir = path.join(userDir, 'plugins');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  process.env.AIQ_DATA_DIR = dataDir;
  process.env.AIQ_PLUGIN_DIR = pluginDir;
  log('数据目录=' + dataDir);

  process.env.PORT = String(PORT);
  const serverPath = path.join(__dirname, '..', 'server.js');
  const { start } = require(serverPath);
  await start(PORT);
  log('服务已启动');

  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    title: 'AIQ',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  log('窗口已建');

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(boot).catch(e => {
  log('boot 抛错: ' + (e && e.stack || e));
  try { dialog.showErrorBox('AIQ 启动失败', String(e && e.message || e)); } catch {}
});

app.on('window-all-closed', () => app.quit());
