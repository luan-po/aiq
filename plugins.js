'use strict';

// 插件加载器 v1：每个插件跑在独立子进程里
// - 子进程用 Node 权限模型启动：只允许读插件目录，没网络、不能起子进程
// - 插件想要「读上下文 / 发消息 / 调模型」，只能 IPC 回来申请，主进程按 manifest 权限放行
// - 插件崩了 / 卡死 → 杀掉重启，不影响服务器

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const PLUGIN_DIR = process.env.AIQ_PLUGIN_DIR || path.join(__dirname, 'plugins');
const HOST = path.join(__dirname, 'plugin-host.js');
const KNOWN_PERMS = new Set(['read_context', 'send_message', 'call_llm']);
const CALL_TIMEOUT = 8000;
const MAX_RESTARTS = 5;

const loaded = [];
const log = [];

function logLine(s) {
  log.push(`[${new Date().toISOString()}] ${s}`);
  if (log.length > 300) log.shift();
  console.log('[plugin]', s);
}

function validate(m) {
  const errs = [];
  if (!m || typeof m !== 'object') return ['manifest 不是对象'];
  if (!m.id) errs.push('缺 id');
  if (!m.name) errs.push('缺 name');
  const perms = m.permissions || [];
  if (!Array.isArray(perms)) errs.push('permissions 必须是数组');
  else perms.forEach(p => { if (!KNOWN_PERMS.has(p)) errs.push('未知权限 ' + p); });
  return errs;
}

class Plugin {
  constructor(manifest, dir) {
    this.manifest = manifest;
    this.dir = dir;
    this.child = null;
    this.ctx = null;
    this.restarts = 0;
    this.stopped = false;
  }

  start() {
    const execArgv = [
      '--permission',
      `--allow-fs-read=${this.dir}`,
      `--allow-fs-read=${HOST}`,
    ];
    const env = { ...process.env };
    // 打包后 server 跑在 Electron 主进程里，子进程得拿同一个 exe 当 node 用
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

    this.child = fork(HOST, [this.dir], { execArgv, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });

    this.child.on('message', (m) => this.onMessage(m));
    this.child.on('exit', (code) => {
      if (this.stopped) return;
      this.restarts++;
      if (this.restarts > MAX_RESTARTS) return logLine(`[${this.manifest.id}] 崩溃太多次，已停用`);
      logLine(`[${this.manifest.id}] 子进程退出(${code})，重启 ${this.restarts}/${MAX_RESTARTS}`);
      setTimeout(() => this.start(), 500);
    });
  }

  onMessage(m) {
    if (m.type === 'ready') return logLine(`[${this.manifest.id}] 沙箱就绪`);
    if (m.type === 'log') return logLine(`[${this.manifest.id}] ${m.text}`);
    if (m.type === 'error') return logLine(`[${this.manifest.id}] 报错：${String(m.text).split('\n')[0]}`);
    if (m.type !== 'call') return;

    const ctx = this.ctx;
    const done = (error, result) => {
      if (this.child && this.child.connected) this.child.send({ type: 'reply', id: m.id, error, result });
    };
    try {
      if (m.api === 'getContext') {
        if (!ctx) return done('没有上下文');
        const n = m.args[0] || 20;
        return done(null, ctx.history.slice(-n).map(x => ({ from: x.sender_name || x.sender_id, text: x.text, kind: x.kind })));
      }
      if (m.api === 'send') {
        if (!ctx) return done('没有上下文');
        ctx.send(String(m.args[0] || '').slice(0, 2000));
        return done(null, true);
      }
      if (m.api === 'llm') {
        if (!ctx) return done('没有上下文');
        return ctx.llm(String(m.args[0] || ''))
          .then(t => done(null, t))
          .catch(e => done(String(e && e.message || e)));
      }
      return done('未知 API: ' + m.api);
    } catch (e) {
      done(String(e && e.message || e));
    }
  }

  dispatch(ctx, payload) {
    this.ctx = ctx;
    return new Promise((resolve) => {
      if (!this.child || !this.child.connected) return resolve();
      const timer = setTimeout(() => {
        logLine(`[${this.manifest.id}] 超过 ${CALL_TIMEOUT}ms 没返回，杀掉重启`);
        try { this.child.kill('SIGKILL'); } catch {}
        resolve();
      }, CALL_TIMEOUT);
      const onDone = (m) => {
        if (m.type === 'done' || m.type === 'error') {
          clearTimeout(timer);
          this.child.off('message', onDone);
          resolve();
        }
      };
      this.child.on('message', onDone);
      this.child.send({ type: 'message', payload });
    });
  }

  stop() {
    this.stopped = true;
    try { this.child && this.child.kill(); } catch {}
  }
}

function loadAll() {
  loaded.forEach(p => p.stop());
  loaded.length = 0;
  if (!fs.existsSync(PLUGIN_DIR)) { fs.mkdirSync(PLUGIN_DIR, { recursive: true }); return; }

  for (const name of fs.readdirSync(PLUGIN_DIR)) {
    const dir = path.join(PLUGIN_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const mf = path.join(dir, 'manifest.json');
    const entry = path.join(dir, 'index.js');
    if (!fs.existsSync(mf) || !fs.existsSync(entry)) { logLine(`跳过 ${name}：缺 manifest.json 或 index.js`); continue; }

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { logLine(`跳过 ${name}：manifest 解析失败 ${e.message}`); continue; }

    const errs = validate(manifest);
    if (errs.length) { logLine(`跳过 ${name}：${errs.join('；')}`); continue; }

    const p = new Plugin(manifest, dir);
    p.start();
    loaded.push(p);
    logLine(`已加载 ${manifest.id}（沙箱，权限：${(manifest.permissions || []).join(',') || '无'}）`);
  }
}

async function dispatch(ctx) {
  for (const p of loaded) {
    try {
      await p.dispatch(ctx, { text: ctx.text, from: ctx.fromName, groupId: ctx.groupId });
    } catch (e) {
      logLine(`[${p.manifest.id}] 派发出错：${e.message}`);
    }
  }
}

function list() {
  return loaded.map(p => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version || '0',
    description: p.manifest.description || '',
    permissions: p.manifest.permissions || [],
    sandboxed: true,
  }));
}

module.exports = { loadAll, dispatch, list, log: () => log.slice(-100), PLUGIN_DIR };
