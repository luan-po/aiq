'use strict';

// 插件加载器 v0
// 约定：plugins/<id>/manifest.json + index.js
// 权限白名单：read_context / send_message / call_llm
// ⚠️ v0 只是「能力白名单」，还不是真沙箱（同进程）。v1 换 WASM / 子进程隔离。

const fs = require('fs');
const path = require('path');

const PLUGIN_DIR = process.env.AIQ_PLUGIN_DIR || path.join(__dirname, 'plugins');
const KNOWN_PERMS = new Set(['read_context', 'send_message', 'call_llm']);

const loaded = [];   // { manifest, module, dir }
const log = [];

function logLine(s) {
  log.push(`[${new Date().toISOString()}] ${s}`);
  if (log.length > 300) log.shift();
  console.log('[plugin]', s);
}

function validate(manifest) {
  const errs = [];
  if (!manifest || typeof manifest !== 'object') errs.push('manifest 不是对象');
  if (!manifest.id) errs.push('缺 id');
  if (!manifest.name) errs.push('缺 name');
  const perms = manifest.permissions || [];
  if (!Array.isArray(perms)) errs.push('permissions 必须是数组');
  else perms.forEach(p => { if (!KNOWN_PERMS.has(p)) errs.push(`未知权限 ${p}`); });
  return errs;
}

function makeApi(manifest, ctx) {
  const perms = new Set(manifest.permissions || []);
  const api = {
    log: (m) => logLine(`[${manifest.id}] ${m}`),
  };
  if (perms.has('read_context')) {
    api.getContext = (limit = 20) => ctx.history.slice(-limit).map(m => ({ from: m.sender_id, text: m.text, kind: m.kind }));
  }
  if (perms.has('send_message')) {
    api.send = (text) => ctx.send(String(text).slice(0, 2000));
  }
  if (perms.has('call_llm')) {
    api.llm = (prompt) => ctx.llm(prompt);
  }
  return api;
}

function loadAll() {
  loaded.length = 0;
  if (!fs.existsSync(PLUGIN_DIR)) { fs.mkdirSync(PLUGIN_DIR, { recursive: true }); return; }

  for (const name of fs.readdirSync(PLUGIN_DIR)) {
    const dir = path.join(PLUGIN_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const mf = path.join(dir, 'manifest.json');
    const entry = path.join(dir, 'index.js');
    if (!fs.existsSync(mf) || !fs.existsSync(entry)) { logLine(`跳过 ${name}：缺 manifest.json 或 index.js`); continue; }

    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); }
    catch (e) { logLine(`跳过 ${name}：manifest.json 解析失败 ${e.message}`); continue; }

    const errs = validate(manifest);
    if (errs.length) { logLine(`跳过 ${name}：${errs.join('；')}`); continue; }

    try {
      delete require.cache[require.resolve(entry)];
      const mod = require(entry);
      if (typeof mod.onMessage !== 'function') { logLine(`跳过 ${name}：没有导出 onMessage`); continue; }
      loaded.push({ manifest, module: mod, dir });
      logLine(`已加载 ${manifest.id} v${manifest.version || '0'} (${(manifest.permissions || []).join(',') || '无权限'})`);
    } catch (e) {
      logLine(`加载失败 ${name}：${e.message}`);
    }
  }
}

// 每条消息触发一次；插件抛错不影响主流程
async function dispatch(ctx) {
  for (const p of loaded) {
    try {
      const api = makeApi(p.manifest, ctx);
      await p.module.onMessage({ text: ctx.text, from: ctx.fromName, groupId: ctx.groupId }, api);
    } catch (e) {
      logLine(`[${p.manifest.id}] 执行出错：${e.message}`);
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
  }));
}

module.exports = { loadAll, dispatch, list, log: () => log.slice(-100), PLUGIN_DIR };
