'use strict';

// 安全回归测试：验证「没授权就碰不到别人的群」
// 跑法：先起服务（PORT=8092 AIQ_DATA_DIR=... node server.js），再 node test-security.js

const BASE = process.env.BASE || 'http://127.0.0.1:8092';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

async function get(path) {
  const r = await fetch(BASE + path);
  let data = {};
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

(async () => {
  console.log('安全回归：群成员边界');

  // 阿鱼 建群
  const a = (await post('/api/register', { name: '阿鱼' })).data;
  const g = (await post('/api/groups', { token: a.token, name: '私密群' })).data.group;
  await post('/api/send', { token: a.token, groupId: g.id, text: '这句只有群成员能看' });

  ok('建群返回邀请码', !!g.invite, JSON.stringify(g));

  // 小鲸：陌生人
  const b = (await post('/api/register', { name: '小鲸' })).data;

  // 1. 群列表不含别人的群
  const bl = (await get(`/api/groups?token=${b.token}`)).data;
  ok('陌生人看不到别人的群', !(bl.groups || []).some(x => x.id === g.id), JSON.stringify(bl.groups));

  // 2. 读历史被拒
  const h1 = await get(`/api/history?token=${b.token}&groupId=${g.id}&since=0`);
  ok('陌生人读不到群历史（403）', h1.status === 403, 'status=' + h1.status);

  // 3. 发言被拒
  const s1 = await post('/api/send', { token: b.token, groupId: g.id, text: '混进来' });
  ok('陌生人发不了言（403）', s1.status === 403, 'status=' + s1.status);

  // 4. 没邀请码加不进去
  const j0 = await post('/api/join', { token: b.token, groupId: g.id });
  ok('没有邀请码加不了群', j0.status === 400, 'status=' + j0.status);

  // 5. 错邀请码也不行
  const j1 = await post('/api/join', { token: b.token, invite: 'ZZZZZZ' });
  ok('错邀请码加不了群', j1.status === 400, 'status=' + j1.status);

  // 6. 正确邀请码可以进
  const j2 = await post('/api/join', { token: b.token, invite: g.invite });
  ok('用邀请码能加群', j2.status === 200, JSON.stringify(j2.data));

  const h2 = await get(`/api/history?token=${b.token}&groupId=${g.id}&since=0`);
  ok('进群后能读历史', h2.status === 200 && (h2.data.messages || []).length > 0, 'status=' + h2.status);

  // 7. AI 设置按用户隔离
  await post('/api/settings', { token: a.token, apiKey: 'sk-test-aaa', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
  const sa = (await get(`/api/settings?token=${a.token}`)).data;
  const sb = (await get(`/api/settings?token=${b.token}`)).data;
  ok('A 存的 key 只在 A 名下', sa.hasKey === true && sb.hasKey === false, `a.hasKey=${sa.hasKey} b.hasKey=${sb.hasKey}`);

  // 8. 机器人 token 不是默认值
  const botDefault = await post('/api/bot/send', { token: 'bot-local-token', groupId: g.id, text: '冒充' });
  ok('默认 bot token 无效', botDefault.status === 401, 'status=' + botDefault.status);

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
