'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const store = require('./storage');
const plugins = require('./plugins');

const PORT = Number(process.env.PORT || 8090);
const BOT_URL = process.env.BOT_URL || '';
const BOT_TOKEN = process.env.BOT_TOKEN || 'bot-local-token';

const rid = (n = 8) => crypto.randomBytes(n).toString('hex');

// ---------- HTTP ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const file = path.join(__dirname, 'public', 'index.html');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'no client' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(file));
    }

    if (req.method === 'POST' && p === '/api/register') {
      const b = await readBody(req);
      if (!b.name) return json(res, 400, { error: '名字呢' });
      const user = { id: 'u_' + rid(6), name: String(b.name).slice(0, 24), token: rid(16), created: Date.now() };
      store.saveUser(user);
      return json(res, 200, { id: user.id, name: user.name, token: user.token });
    }

    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req);
      const u = store.userByToken(b.token);
      if (!u) return json(res, 401, { error: 'token 无效' });
      return json(res, 200, { id: u.id, name: u.name, token: u.token });
    }

    if (req.method === 'GET' && p === '/api/groups') {
      const u = store.userByToken(url.searchParams.get('token'));
      if (!u) return json(res, 401, { error: 'token 无效' });
      return json(res, 200, { groups: store.listGroups().map(g => ({ id: g.id, name: g.name, members: g.members, lastSeq: g.last_seq })) });
    }

    if (req.method === 'POST' && p === '/api/groups') {
      const b = await readBody(req);
      const u = store.userByToken(b.token);
      if (!u) return json(res, 401, { error: 'token 无效' });
      const g = store.createGroup({ id: 'g_' + rid(6), name: String(b.name || '新群').slice(0, 30), ownerId: u.id });
      return json(res, 200, { group: { id: g.id, name: g.name } });
    }

    if (req.method === 'POST' && p === '/api/join') {
      const b = await readBody(req);
      const u = store.userByToken(b.token);
      const g = store.getGroup(b.groupId);
      if (!u || !g) return json(res, 400, { error: '群或用户不存在' });
      store.joinGroup(g.id, u.id);
      return json(res, 200, { ok: true, group: { id: g.id, name: g.name } });
    }

    if (req.method === 'GET' && p === '/api/history') {
      const u = store.userByToken(url.searchParams.get('token'));
      if (!u) return json(res, 401, { error: 'token 无效' });
      const gid = url.searchParams.get('groupId');
      const since = Number(url.searchParams.get('since') || 0);
      const msgs = store.history(gid, since).map(m => ({ seq: m.seq, from: m.sender_id, kind: m.kind, text: m.text, ts: m.ts }));
      return json(res, 200, { messages: msgs, lastSeq: store.lastSeq(gid) });
    }

    if (req.method === 'POST' && p === '/api/send') {
      const b = await readBody(req);
      const u = store.userByToken(b.token);
      if (!u) return json(res, 401, { error: 'token 无效' });
      const m = store.appendMessage(b.groupId, u.id, b.text);
      if (!m) return json(res, 400, { error: '群不存在' });
      const msg = { seq: m.seq, from: m.sender_id, kind: m.kind, text: m.text, ts: m.ts };
      broadcast(b.groupId, msg, u.name);
      hookBot(b.groupId, u.name, msg.text);
      runPlugins(b.groupId, u, msg.text);
      return json(res, 200, { message: msg });
    }

    if (req.method === 'POST' && p === '/api/bot/send') {
      const b = await readBody(req);
      if (b.token !== BOT_TOKEN) return json(res, 401, { error: 'bot token 不对' });
      const m = store.appendMessage(b.groupId, b.botId || 'bot', b.text, 'bot');
      if (!m) return json(res, 400, { error: '群不存在' });
      const msg = { seq: m.seq, from: m.sender_id, kind: m.kind, text: m.text, ts: m.ts };
      broadcast(b.groupId, msg, b.name || 'AI');
      return json(res, 200, { message: msg });
    }

    // ---------- 设置（BYOK：用户自己的 key 存在本机） ----------
    if (req.method === 'GET' && p === '/api/settings') {
      const u = store.userByToken(url.searchParams.get('token'));
      if (!u) return json(res, 401, { error: 'token 无效' });
      const s = store.getSetting('ai', '{}');
      const obj = JSON.parse(s || '{}');
      return json(res, 200, {
        baseUrl: obj.baseUrl || 'https://api.deepseek.com/v1',
        model: obj.model || 'deepseek-chat',
        hasKey: !!obj.apiKey,
      });
    }

    if (req.method === 'POST' && p === '/api/settings') {
      const b = await readBody(req);
      const u = store.userByToken(b.token);
      if (!u) return json(res, 401, { error: 'token 无效' });
      const cur = JSON.parse(store.getSetting('ai', '{}') || '{}');
      const next = {
        baseUrl: b.baseUrl || cur.baseUrl || 'https://api.deepseek.com/v1',
        model: b.model || cur.model || 'deepseek-chat',
        apiKey: b.apiKey || cur.apiKey || '',
      };
      store.setSetting('ai', JSON.stringify(next));
      return json(res, 200, { ok: true, baseUrl: next.baseUrl, model: next.model, hasKey: !!next.apiKey });
    }

    // ---------- AI：读群聊上下文回答问题 ----------
    if (req.method === 'POST' && p === '/api/ai') {
      const b = await readBody(req);
      const u = store.userByToken(b.token);
      if (!u) return json(res, 401, { error: 'token 无效' });
      const cfg = JSON.parse(store.getSetting('ai', '{}') || '{}');
      if (!cfg.apiKey) return json(res, 400, { error: '还没填 API Key' });

      const last = Number(b.lastSeq || 0) || 999999;
      let ctxLines;
      if (Array.isArray(b.context) && b.context.length) {
        // 前端已经把最近 10 条拼好传上来了
        ctxLines = b.context.slice(-10).join('\n');
      } else {
        const msgs = store.history(b.groupId, 0).slice(-40).filter(m => m.seq <= last);
        ctxLines = msgs.map(m => {
          const who = m.kind === 'bot' ? 'AI' : (m.sender_id === u.id ? u.name : m.sender_id);
          return `${who}: ${m.text}`;
        }).join('\n');
      }

      const sys = '你是一个群聊助手。回答要短、口语化，别用客服腔，不要复述聊天记录，除非用户要求。';
      const userPrompt = `以下是群聊最近的消息：\n${ctxLines || '（空）'}\n\n我的请求：${b.prompt || '总结一下大家刚才聊了什么'}`;

      try {
        const r = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model || 'deepseek-chat',
            messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }],
            temperature: 0.7,
            max_tokens: 600,
          }),
        });
        const data = await r.json();
        if (!r.ok) return json(res, 502, { error: (data && data.error && data.error.message) || '模型接口报错' });
        const text = data.choices && data.choices[0] && data.choices[0].message.content;
        return json(res, 200, { text: text || '（空回复）' });
      } catch (e) {
        return json(res, 502, { error: '请求失败: ' + String(e && e.message || e) });
      }
    }

    if (req.method === 'GET' && p === '/api/net') {
      const os = require('os');
      const ips = [];
      for (const list of Object.values(os.networkInterfaces())) {
        for (const it of list || []) {
          if (it.family === 'IPv4' && !it.internal) ips.push(it.address);
        }
      }
      // 优先挑家庭/办公常见的 192.168 网段（VPN、虚拟机网卡排后面）
      const rank = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 2 : 1;
      ips.sort((a, b) => rank(a) - rank(b));
      return json(res, 200, { port: Number(process.env.PORT || 8090), ips, origin: `http://${ips[0] || '127.0.0.1'}:${Number(process.env.PORT || 8090)}` });
    }

    if (req.method === 'GET' && p === '/api/plugins') {
      const u = store.userByToken(url.searchParams.get('token'));
      if (!u) return json(res, 401, { error: 'token 无效' });
      return json(res, 200, { plugins: plugins.list(), log: plugins.log() });
    }

    // ---------- /ai：以「AI 助手」身份把回答发进群里 ----------
    if (req.method === 'POST' && p === '/api/ai/say') {
      const b = await readBody(req);
      const u = store.userByToken(b.token);
      if (!u) return json(res, 401, { error: 'token 无效' });
      const g = store.getGroup(b.groupId);
      if (!g) return json(res, 400, { error: '群不存在' });

      const msgs = store.history(b.groupId, 0).slice(-30);
      const ctxLines = msgs.map(m => {
        const who = m.kind === 'bot' ? 'AI 助手' : (m.sender_id === u.id ? u.name : m.sender_id);
        return `${who}: ${m.text}`;
      }).join('\n');

      try {
        const text = await callLLM(
          `最近的群聊记录：\n${ctxLines || '（空）'}\n\n现在的请求：${b.prompt}`,
          '你在一个聊天群里。回答要短、口语化，不要客服腔，不要复述聊天记录。'
        );
        const m = store.appendMessage(b.groupId, 'ai-assistant', text, 'bot');
        const msg = { seq: m.seq, from: m.sender_id, kind: m.kind, text: m.text, ts: m.ts };
        broadcast(b.groupId, msg, 'AI 助手');
        return json(res, 200, { message: msg });
      } catch (e) {
        return json(res, 502, { error: String(e && e.message || e) });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e && e.message || e) });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map();

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://x').searchParams.get('token');
  const user = store.userByToken(token);
  if (!user) return ws.close(4001, 'token 无效');
  ws.user = user;
  ws.groups = new Set();

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'join') {
      const g = store.getGroup(m.groupId);
      if (!g) return ws.send(JSON.stringify({ type: 'error', text: '群不存在' }));
      store.joinGroup(g.id, user.id);
      ws.groups.add(g.id);
      if (!rooms.has(g.id)) rooms.set(g.id, new Set());
      rooms.get(g.id).add(ws);
      ws.send(JSON.stringify({ type: 'joined', groupId: g.id, lastSeq: g.last_seq }));
    }
    if (m.type === 'send') {
      const mm = store.appendMessage(m.groupId, user.id, m.text);
      if (!mm) return;
      const msg = { seq: mm.seq, from: mm.sender_id, kind: mm.kind, text: mm.text, ts: mm.ts };
      broadcast(m.groupId, msg, user.name);
      hookBot(m.groupId, user.name, msg.text);
      runPlugins(m.groupId, user, msg.text);
    }
  });

  ws.on('close', () => {
    for (const gid of ws.groups) {
      const set = rooms.get(gid);
      if (set) { set.delete(ws); if (!set.size) rooms.delete(gid); }
    }
  });
});

function broadcast(groupId, msg, fromName) {
  const set = rooms.get(groupId);
  if (!set) return;
  const payload = JSON.stringify({ type: 'msg', groupId, message: msg, fromName });
  for (const ws of set) if (ws.readyState === 1) ws.send(payload);
}

function hookBot(groupId, fromName, text) {
  if (!BOT_URL) return;
  fetch(BOT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: groupId, user_name: fromName, message: text, bot_token: BOT_TOKEN }),
  }).catch(() => {});
}

// ---------- 插件派发 ----------
async function callLLM(promptText, systemText) {
  const cfg = JSON.parse(store.getSetting('ai', '{}') || '{}');
  if (!cfg.apiKey) throw new Error('还没填 API Key');
  const r = await fetch(`${(cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model || 'deepseek-chat',
      messages: [
        { role: 'system', content: systemText || '你在一个聊天群里当助手，回答要短、口语化。' },
        { role: 'user', content: promptText },
      ],
      temperature: 0.7,
      max_tokens: 600,
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || '模型接口报错');
  return data.choices?.[0]?.message?.content || '';
}

function runPlugins(groupId, user, text) {
  if (!plugins.list().length) return;
  const history = store.history(groupId, 0);
  const ctx = {
    groupId, text, fromName: user.name, history,
    send: (t) => {
      const m = store.appendMessage(groupId, 'plugin', t, 'bot');
      if (m) broadcast(groupId, { seq: m.seq, from: m.sender_id, kind: m.kind, text: m.text, ts: m.ts }, '插件');
    },
    llm: (p) => callLLM(p),
  };
  plugins.dispatch(ctx).catch(e => console.error('[plugin] dispatch', e));
}

function start(port = PORT, host = process.env.HOST || '0.0.0.0') {
  plugins.loadAll();
  return new Promise((resolve) => server.listen(port, host, () => {
    console.log(`AIQ 起来了: http://${host}:${port}`);
    resolve(port);
  }));
}

if (require.main === module) start();

module.exports = { start, server };
