// 端到端自测：注册两个人 → 建群 → WS 收发 → 断线补拉 → 机器人回复
const WebSocket = require('ws');
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const WS = BASE.replace('http', 'ws') + '/ws';

const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
const get = (p) => fetch(BASE + p).then(r => r.json());

function client(token) {
  const ws = new WebSocket(`${WS}?token=${token}`);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  return new Promise((resolve) => {
    ws.on('open', () => resolve({ ws, inbox }));
  });
}

(async () => {
  const a = await post('/api/register', { name: '阿鱼' });
  const b = await post('/api/register', { name: '小鲸' });
  console.log('注册:', a.name, b.name);

  const g = (await post('/api/groups', { token: a.token, name: '测试群' })).group;
  console.log('建群:', g.name, g.id);

  const ca = await client(a.token);
  const cb = await client(b.token);
  ca.ws.send(JSON.stringify({ type: 'join', groupId: g.id }));
  cb.ws.send(JSON.stringify({ type: 'join', groupId: g.id }));
  await new Promise(r => setTimeout(r, 300));

  ca.ws.send(JSON.stringify({ type: 'send', groupId: g.id, text: '你好' }));
  await new Promise(r => setTimeout(r, 500));

  const gotByB = cb.inbox.find(x => x.type === 'msg');
  console.log('B 收到:', gotByB ? gotByB.message.text + ' (seq ' + gotByB.message.seq + ')' : '没收到');

  const bot = await post('/api/bot/send', { token: 'bot-local-token', groupId: g.id, text: '我是机器人' });
  await new Promise(r => setTimeout(r, 400));
  const botSeen = ca.inbox.find(x => x.type === 'msg' && x.message.kind === 'bot');
  console.log('机器人消息:', botSeen ? botSeen.message.text : '没收到');

  // 断线补拉：模拟只拿到 seq 1
  const hist = await get(`/api/history?token=${b.token}&groupId=${g.id}&since=0`);
  console.log('补拉条数:', hist.messages.length, '| 最后 seq:', hist.lastSeq);

  ca.ws.close(); cb.ws.close();
  const ok = gotByB && botSeen && hist.messages.length >= 2;
  console.log(ok ? '✅ 全部通过' : '❌ 有问题');
  process.exit(ok ? 0 : 1);
})();
