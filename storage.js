'use strict';

// 本地存储：node:sqlite（Node 22.5+ 内置，零编译依赖）
// 设计：聊天记录默认只存在本机；服务端只负责路由。
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.AIQ_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'aiq.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pubkey TEXT,
  token TEXT UNIQUE,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT,
  owner_id TEXT,
  last_seq INTEGER DEFAULT 0,
  created INTEGER
);

CREATE TABLE IF NOT EXISTS members (
  group_id TEXT,
  user_id TEXT,
  joined INTEGER,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  group_id TEXT,
  seq INTEGER,
  sender_id TEXT,
  kind TEXT DEFAULT 'user',
  text TEXT,
  ts INTEGER,
  PRIMARY KEY (group_id, seq)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT,
  key TEXT,
  value TEXT,
  PRIMARY KEY (user_id, key)
);
`);

// 老库补列：群邀请码
try { db.exec('ALTER TABLE groups ADD COLUMN invite TEXT'); } catch { /* 已存在 */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_invite ON groups(invite)'); } catch {}

const q = {
  insertUser: db.prepare('INSERT INTO users (id,name,pubkey,token,created) VALUES (?,?,?,?,?)'),
  userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
  insertGroup: db.prepare('INSERT INTO groups (id,name,owner_id,invite,last_seq,created) VALUES (?,?,?,?,0,?)'),
  group: db.prepare('SELECT * FROM groups WHERE id = ?'),
  groupByInvite: db.prepare('SELECT * FROM groups WHERE invite = ?'),
  allGroups: db.prepare('SELECT g.*, (SELECT COUNT(*) FROM members m WHERE m.group_id=g.id) AS members FROM groups g ORDER BY created DESC'),
  myGroups: db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM members m2 WHERE m2.group_id=g.id) AS members
    FROM groups g JOIN members m ON m.group_id = g.id AND m.user_id = ?
    ORDER BY g.created DESC`),
  addMember: db.prepare('INSERT OR IGNORE INTO members (group_id,user_id,joined) VALUES (?,?,?)'),
  isMember: db.prepare('SELECT 1 FROM members WHERE group_id=? AND user_id=?'),
  bumpSeq: db.prepare('UPDATE groups SET last_seq = last_seq + 1 WHERE id = ?'),
  nextSeq: db.prepare('SELECT last_seq FROM groups WHERE id = ?'),
  insertMsg: db.prepare('INSERT INTO messages (group_id,seq,sender_id,kind,text,ts) VALUES (?,?,?,?,?,?)'),
  history: db.prepare(`
    SELECT m.*, COALESCE(u.name, m.sender_id) AS sender_name
    FROM messages m LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.group_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT 500
  `),
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'),
  getUserSetting: db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?'),
  setUserSetting: db.prepare('INSERT INTO user_settings (user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value'),
};

module.exports = {
  db,
  DATA_DIR,

  saveUser(u) {
    q.insertUser.run(u.id, u.name, u.pubkey || null, u.token, u.created || Date.now());
    return u;
  },
  userByToken(token) { return q.userByToken.get(token) || null; },

  createGroup(g) {
    q.insertGroup.run(g.id, g.name, g.ownerId, g.invite || null, Date.now());
    q.addMember.run(g.id, g.ownerId, Date.now());
    return q.group.get(g.id);
  },
  listGroups() { return q.allGroups.all(); },
  myGroups(userId) { return q.myGroups.all(userId); },
  getGroup(id) { return q.group.get(id) || null; },
  groupByInvite(code) { return q.groupByInvite.get(String(code || '').toUpperCase()) || null; },
  joinGroup(groupId, userId) { q.addMember.run(groupId, userId, Date.now()); },
  isMember(groupId, userId) { return !!q.isMember.get(groupId, userId); },

  appendMessage(groupId, senderId, text, kind = 'user') {
    const g = q.group.get(groupId);
    if (!g) return null;
    q.bumpSeq.run(groupId);
    const seq = q.group.get(groupId).last_seq;
    const msg = { group_id: groupId, seq, sender_id: senderId, kind, text, ts: Date.now() };
    q.insertMsg.run(groupId, seq, senderId, kind, text, msg.ts);
    return msg;
  },

  history(groupId, since = 0) { return q.history.all(groupId, since); },
  lastSeq(groupId) { const g = q.group.get(groupId); return g ? g.last_seq : 0; },

  getSetting(key, dflt = null) { const r = q.getSetting.get(key); return r ? r.value : dflt; },
  setSetting(key, value) { q.setSetting.run(key, String(value)); },

  // 每个用户自己的设置（AI Key 不再全服务器共享）
  getUserSetting(userId, key, dflt = null) {
    const r = q.getUserSetting.get(userId, key);
    return r ? r.value : dflt;
  },
  setUserSetting(userId, key, value) { q.setUserSetting.run(userId, key, String(value)); },
};
