'use strict';

// 插件宿主（子进程）
// 插件代码在这里跑，权限由 Node 的 --permission 限制；
// 想读上下文 / 发消息 / 调模型，只能通过 IPC 向主进程申请。

const path = require('path');

const dir = process.argv[2];
const manifest = require(path.join(dir, 'manifest.json'));
const mod = require(path.join(dir, 'index.js'));

let seq = 0;
const pending = new Map();

function call(api, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    process.send({ type: 'call', id, api, args });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('API 超时: ' + api));
      }
    }, 5000);
  });
}

const api = {
  log: (msg) => process.send({ type: 'log', text: String(msg) }),
};

const perms = new Set(manifest.permissions || []);
if (perms.has('read_context')) api.getContext = (n) => call('getContext', [n || 20]);
if (perms.has('send_message')) api.send = (t) => call('send', [String(t)]);
if (perms.has('call_llm')) api.llm = (p) => call('llm', [String(p)]);

process.on('message', async (m) => {
  if (m.type === 'reply') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.result);
    return;
  }
  if (m.type === 'message') {
    try {
      await mod.onMessage(m.payload, api);
      process.send({ type: 'done' });
    } catch (e) {
      process.send({ type: 'error', text: String(e && e.stack || e) });
    }
  }
});

process.on('uncaughtException', (e) => {
  process.send({ type: 'error', text: 'uncaught: ' + String(e && e.stack || e) });
});

process.send({ type: 'ready', id: manifest.id });
