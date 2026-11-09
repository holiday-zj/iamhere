// db.js — SQLite 初始化（node:sqlite，零依赖）
'use strict';
process.env.TZ = process.env.TZ || 'Asia/Shanghai';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'zaishenbian.db'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'child',
  rel TEXT DEFAULT '',
  age INTEGER DEFAULT 0,
  avatar TEXT DEFAULT '🙂',
  health_json TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS families(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, city TEXT DEFAULT '长沙', plan TEXT DEFAULT 'free',
  created_by INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS family_members(
  family_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at INTEGER NOT NULL,
  PRIMARY KEY(family_id, user_id)
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY, family_id INTEGER NOT NULL, created_by INTEGER NOT NULL,
  used_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS devices(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER, elder_id INTEGER NOT NULL,
  type TEXT NOT NULL, name TEXT DEFAULT '', last_ts INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS vitals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, elder_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  type TEXT NOT NULL, value REAL NOT NULL, source TEXT DEFAULT 'device'
);
CREATE INDEX IF NOT EXISTS idx_vitals ON vitals(elder_id, type, ts);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, elder_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL, data TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events ON events(elder_id, ts);
CREATE TABLE IF NOT EXISTS meds(
  id INTEGER PRIMARY KEY AUTOINCREMENT, elder_id INTEGER NOT NULL, name TEXT NOT NULL,
  dose TEXT DEFAULT '', times TEXT DEFAULT '["08:00"]', active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS med_logs(
  id INTEGER PRIMARY KEY AUTOINCREMENT, elder_id INTEGER NOT NULL, med_id INTEGER NOT NULL,
  date TEXT NOT NULL, time TEXT NOT NULL, status TEXT DEFAULT 'pending', taken_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_medlogs ON med_logs(elder_id, date);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, elder_id INTEGER,
  title TEXT NOT NULL, detail TEXT DEFAULT '', due_date TEXT DEFAULT '',
  status TEXT DEFAULT 'open', claimed_by INTEGER, created_by INTEGER, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS duty(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  date TEXT NOT NULL, note TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, title TEXT NOT NULL,
  category TEXT DEFAULT '其他', amount REAL NOT NULL, paid_by INTEGER NOT NULL,
  split TEXT DEFAULT 'aa', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS votes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, title TEXT NOT NULL,
  options TEXT NOT NULL, deadline INTEGER, created_by INTEGER,
  created_at INTEGER NOT NULL, status TEXT DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS vote_records(
  vote_id INTEGER NOT NULL, user_id INTEGER NOT NULL, choice TEXT NOT NULL,
  PRIMARY KEY(vote_id, user_id)
);
CREATE TABLE IF NOT EXISTS timeline(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, elder_id INTEGER,
  ts INTEGER NOT NULL, type TEXT DEFAULT 'note', summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, elder_id INTEGER NOT NULL,
  service_type TEXT NOT NULL, provider_id INTEGER, scheduled_at INTEGER NOT NULL,
  location TEXT DEFAULT '', notes TEXT DEFAULT '', price REAL DEFAULT 0,
  status TEXT DEFAULT 'pending', need_review INTEGER DEFAULT 0, created_by INTEGER,
  from_elder INTEGER DEFAULT 0, rating REAL, review TEXT DEFAULT '', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_updates(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, ts INTEGER NOT NULL, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_profiles(
  user_id INTEGER PRIMARY KEY, city TEXT DEFAULT '长沙', specialties TEXT DEFAULT '[]',
  rating REAL DEFAULT 5.0, jobs INTEGER DEFAULT 0, online INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, elder_id INTEGER NOT NULL,
  level TEXT DEFAULT 'warning', kind TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT DEFAULT 'new', created_at INTEGER NOT NULL, ack_by INTEGER
);
CREATE TABLE IF NOT EXISTS sos(
  id INTEGER PRIMARY KEY AUTOINCREMENT, elder_id INTEGER NOT NULL, family_id INTEGER NOT NULL,
  trigger TEXT DEFAULT 'button', status TEXT DEFAULT 'level1', started_at INTEGER NOT NULL,
  level_started_at INTEGER NOT NULL, acked_by INTEGER, resolved_at INTEGER, resolved_by INTEGER,
  log TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, family_id INTEGER,
  title TEXT NOT NULL, body TEXT DEFAULT '', kind TEXT DEFAULT 'info',
  read INTEGER DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, elder_id INTEGER NOT NULL, title TEXT NOT NULL, ts INTEGER NOT NULL,
  summary TEXT DEFAULT '', ai_note TEXT DEFAULT '', created_by INTEGER
);
`);

const now = () => Date.now();
function all(sql, ...p) { return db.prepare(sql).all(...p); }
function get(sql, ...p) { return db.prepare(sql).get(...p); }
function run(sql, ...p) { return db.prepare(sql).run(...p); }
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + '$' + h;
}
function checkPass(pw, stored) {
  try {
    const [salt, h] = String(stored).split('$');
    const t = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(t, 'hex'), Buffer.from(h, 'hex'));
  } catch { return false; }
}
function notify(userId, familyId, title, body, kind) {
  run('INSERT INTO notifications(user_id,family_id,title,body,kind,created_at) VALUES(?,?,?,?,?,?)',
    userId, familyId || null, title || '', body || '', kind || 'info', now());
}
function familyOf(elderId) {
  return get('SELECT family_id FROM family_members WHERE user_id=?', elderId)?.family_id || null;
}
function notifyChildren(familyId, title, body, kind) {
  for (const m of all('SELECT user_id FROM family_members WHERE family_id=?', familyId)) {
    const u = get('SELECT role FROM users WHERE id=?', m.user_id);
    if (u && u.role === 'child') notify(m.user_id, familyId, title, body, kind);
  }
}
function notifyAll(familyId, title, body, kind) {
  for (const m of all('SELECT user_id FROM family_members WHERE family_id=?', familyId)) {
    notify(m.user_id, familyId, title, body, kind);
  }
}
function addTimeline(familyId, elderId, type, summary) {
  run('INSERT INTO timeline(family_id,elder_id,ts,type,summary) VALUES(?,?,?,?,?)',
    familyId, elderId || null, now(), type, summary);
}
function userName(uid) { return get('SELECT name FROM users WHERE id=?', uid)?.name || '用户'; }

module.exports = {
  db, all, get, run, now, hashPass, checkPass, notify, notifyChildren, notifyAll,
  addTimeline, familyOf, userName, DATA_DIR,
};
