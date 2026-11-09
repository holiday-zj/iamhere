// index.js — 在身边 MVP API 服务器（零依赖，Node http + node:sqlite）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./db');
const alerts = require('./alerts');
const emer = require('./emergency');
const disp = require('./dispatch');
const { all, get, run, now, notify, notifyChildren, notifyAll, addTimeline, familyOf, userName } = D;

const PORT = Number(process.env.PORT || 8081);
const WEB_DIR = path.join(__dirname, '..', 'web');

// ---------- helpers ----------
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = m => { throw new HttpErr(400, m); };
const denied = m => { throw new HttpErr(403, m || '无权限'); };
const notfound = m => { throw new HttpErr(404, m || '不存在'); };

function readBody(req) {
  return new Promise((res, rej) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { rej(new HttpErr(400, 'JSON 格式错误')); } });
    req.on('error', rej);
  });
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.query?.token || null);
  if (!tok) return null;
  const t = get('SELECT user_id FROM tokens WHERE token=?', tok);
  if (!t) return null;
  return get('SELECT * FROM users WHERE id=?', t.user_id) || null;
}
function requireAuth(req) { const u = auth(req); if (!u) throw new HttpErr(401, '请先登录'); return u; }
function famOf(user) {
  const m = get('SELECT family_id FROM family_members WHERE user_id=?', user.id);
  return m ? get('SELECT * FROM families WHERE id=?', m.family_id) : null;
}
function famMembers(fid) {
  return all('SELECT u.id,u.name,u.role,u.rel,u.age,u.avatar,u.phone FROM family_members m JOIN users u ON u.id=m.user_id WHERE m.family_id=? ORDER BY u.role DESC, u.id', fid);
}
function eldersOf(fid) {
  return all("SELECT u.id,u.name,u.age,u.avatar,u.health_json FROM family_members m JOIN users u ON u.id=m.user_id WHERE m.family_id=? AND u.role='elder'", fid);
}
function canSeeElder(user, elderId) {
  const fid = familyOf(elderId);
  return fid && get('SELECT 1 FROM family_members WHERE family_id=? AND user_id=?', fid, user.id);
}
const pub = u => u && ({ id: u.id, name: u.name, role: u.role, rel: u.rel, age: u.age, avatar: u.avatar, phone: u.phone });

// ---------- auth routes ----------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[a-z_]+/gi, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, opts });
}

route('POST', '/api/register', async (req, body) => {
  const { phone, password, name, role } = body;
  if (!/^1\d{10}$/.test(phone || '')) bad('手机号格式不正确');
  if (!password || password.length < 6) bad('密码至少 6 位');
  if (!name) bad('请填写姓名');
  if (!['child', 'elder', 'provider'].includes(role)) bad('角色不正确');
  if (get('SELECT id FROM users WHERE phone=?', phone)) bad('该手机号已注册');
  const r = run('INSERT INTO users(phone,pass_hash,name,role,created_at) VALUES(?,?,?,?,?)',
    phone, D.hashPass(password), name, role, now());
  const id = Number(r.lastInsertRowid);
  if (role === 'provider') {
    run('INSERT INTO provider_profiles(user_id,city,specialties) VALUES(?,?,?)', id, body.city || '长沙', JSON.stringify(body.specialties || ['accompany_half']));
  }
  return { id, name, role };
});

route('POST', '/api/login', async (req, body) => {
  const u = get('SELECT * FROM users WHERE phone=?', body.phone || '');
  if (!u || !D.checkPass(body.password || '', u.pass_hash)) throw new HttpErr(401, '手机号或密码错误');
  const tok = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)', tok, u.id, now());
  return { token: tok, user: pub(u), family: famOf(u) ? { id: famOf(u).id, name: famOf(u).name } : null };
});

route('GET', '/api/me', async req => {
  const u = requireAuth(req);
  const f = famOf(u);
  return { user: pub(u), family: f ? { id: f.id, name: f.name, city: f.city, plan: f.plan } : null };
});

// ---------- family ----------
route('POST', '/api/family', async (req, body) => {
  const u = requireAuth(req);
  if (u.role !== 'child') denied('仅子女可创建家庭圈');
  if (famOf(u)) bad('您已在家庭圈中');
  const name = body.name || `${u.name}的家`;
  const r = run('INSERT INTO families(name,city,created_by,created_at) VALUES(?,?,?,?)', name, body.city || '长沙', u.id, now());
  const fid = Number(r.lastInsertRowid);
  run('INSERT INTO family_members(family_id,user_id,joined_at) VALUES(?,?,?)', fid, u.id, now());
  addTimeline(fid, null, 'family', `${u.name} 创建了家庭圈「${name}」`);
  return { id: fid, name };
});

route('POST', '/api/family/invite', async req => {
  const u = requireAuth(req);
  const f = famOf(u); if (!f) bad('请先创建或加入家庭圈');
  const planMax = { free: 3, premium: 6, elite: 10 }[f.plan] || 3;
  const cnt = get('SELECT COUNT(*) c FROM family_members WHERE family_id=?', f.id).c;
  if (cnt >= planMax) bad(`当前会员（${f.plan}）家庭圈上限 ${planMax} 人，升级会员可扩容`);
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  run('INSERT INTO invites(code,family_id,created_by,created_at) VALUES(?,?,?,?)', code, f.id, u.id, now());
  return { code, url: `/index.html?invite=${code}`, expiresIn: '24小时' };
});

route('POST', '/api/family/join', async (req, body) => {
  const u = requireAuth(req);
  if (famOf(u)) bad('您已在家庭圈中');
  const inv = get('SELECT * FROM invites WHERE code=?', String(body.code || '').toUpperCase());
  if (!inv) notfound('邀请码无效');
  if (now() - inv.created_at > 86400e3) bad('邀请码已过期，请重新获取');
  run('INSERT INTO family_members(family_id,user_id,joined_at) VALUES(?,?,?)', inv.family_id, u.id, now());
  run('UPDATE invites SET used_by=? WHERE code=?', u.id, inv.code);
  const f = get('SELECT name FROM families WHERE id=?', inv.family_id);
  addTimeline(inv.family_id, null, 'family', `${u.name} 加入了家庭圈`);
  notifyAll(inv.family_id, '👨‍👩‍👧 新成员加入', `${u.name} 加入了「${f.name}」`, 'family');
  return { family: f.name };
});

route('GET', '/api/family', async req => {
  const u = requireAuth(req);
  const f = famOf(u); if (!f) return { family: null };
  return {
    family: { id: f.id, name: f.name, city: f.city, plan: f.plan },
    members: famMembers(f.id).map(pub),
    elders: eldersOf(f.id).map(e => ({ id: e.id, name: e.name, age: e.age, avatar: e.avatar })),
    timeline: all('SELECT * FROM timeline WHERE family_id=? ORDER BY ts DESC LIMIT 50', f.id),
  };
});

route('POST', '/api/family/bind', async (req, body) => {
  // 绑定父母：老人已注册 → 用手机号直接拉入；未注册 → 生成绑定码（老人端输入后自动注册并绑定）
  const u = requireAuth(req);
  const f = famOf(u); if (!f) bad('请先创建家庭圈');
  const e = get("SELECT * FROM users WHERE phone=? AND role='elder'", body.phone || '');
  if (e) {
    if (familyOf(e.id)) bad('该老人已绑定其他家庭');
    run('INSERT INTO family_members(family_id,user_id,joined_at) VALUES(?,?,?)', f.id, e.id, now());
    notify(e.id, f.id, '👨‍👩‍👧 家人绑定了您', `${u.name} 邀请您加入「${f.name}」家庭圈`, 'family');
    addTimeline(f.id, e.id, 'family', `绑定父母：${e.name}`);
    notifyChildren(f.id, '✅ 绑定成功', `${e.name} 已加入家庭圈`, 'family');
    return { bound: true, elder: pub(e) };
  }
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  run('INSERT INTO invites(code,family_id,created_by,created_at) VALUES(?,?,?,?)', code, f.id, u.id, now());
  return { bound: false, bindCode: code, tip: '老人未注册。请让老人在"老人端"输入此绑定码并设置手机号密码，即可自动加入家庭圈' };
});

route('POST', '/api/family/plan', async (req, body) => {
  const u = requireAuth(req);
  const f = famOf(u); if (!f) bad('请先加入家庭圈');
  if (u.role !== 'child') denied();
  if (!['free', 'premium', 'elite'].includes(body.plan)) bad('套餐不正确');
  run('UPDATE families SET plan=? WHERE id=?', body.plan, f.id);
  addTimeline(f.id, null, 'plan', `会员升级为 ${body.plan}`);
  return { plan: body.plan };
});

// ---------- 状态大屏 ----------
function elderStatus(eid) {
  const e = get('SELECT * FROM users WHERE id=?', eid);
  const h = { conditions: [], allergies: [] };
  try { Object.assign(h, JSON.parse(e.health_json || '{}')); } catch {}
  const latest = type => get('SELECT value, ts, source FROM vitals WHERE elder_id=? AND type=? ORDER BY ts DESC LIMIT 1', eid, type);
  const t = now();
  const hr = latest('heart_rate'), spo2 = latest('spo2');
  const sys = latest('systolic'), dia = latest('diastolic');
  const steps = latest('steps'), sleep = latest('sleep');
  const lastCheckin = get("SELECT ts FROM events WHERE elder_id=? AND kind='checkin' ORDER BY ts DESC LIMIT 1", eid)?.ts;
  const lastDoor = get("SELECT kind, ts, data FROM events WHERE elder_id=? AND kind IN('door_in','door_out') ORDER BY ts DESC LIMIT 1", eid);
  const lastContact = get("SELECT ts, data FROM events WHERE elder_id=? AND kind='contact' ORDER BY ts DESC LIMIT 1", eid);
  // 今日用药
  alerts.ensureTodayLogs(eid);
  const logs = all('SELECT l.*, m.name med_name, m.dose FROM med_logs l JOIN meds m ON m.id=l.med_id WHERE l.elder_id=? AND l.date=? ORDER BY l.time', eid, alerts.todayStr());
  const meds = { taken: 0, pending: 0, missed: 0, items: logs.map(l => ({ id: l.id, med: l.med_name, dose: l.dose, time: l.time, status: l.status })) };
  for (const l of logs) meds[l.status]++;
  // 位置
  let loc = '未知', locTs = 0;
  if (lastDoor) {
    locTs = lastDoor.ts;
    loc = lastDoor.kind === 'door_out' ? '外出中' : '在家';
    if (lastDoor.kind === 'door_out') {
      try { const g = JSON.parse(lastDoor.data || '{}'); if (g.loc) loc = `外出中（${g.loc}）`; } catch {}
    }
  }
  const gps = get("SELECT ts, data FROM events WHERE elder_id=? AND kind='gps' ORDER BY ts DESC LIMIT 1", eid);
  if (gps && gps.ts > locTs) { locTs = gps.ts; try { const g = JSON.parse(gps.data); if (g.loc) loc = `外出中（${g.loc}）`; } catch {} }
  // 活跃 SOS / 预警
  const activeSos = get("SELECT id,status FROM sos WHERE elder_id=? AND status NOT IN('resolved','cancelled')", eid);
  const openAlerts = all("SELECT * FROM alerts WHERE elder_id=? AND status='new' ORDER BY created_at DESC LIMIT 5", eid);
  // 总状态
  let status = 'normal', statusText = '✅ 正常';
  if (activeSos) { status = 'sos'; statusText = '🚨 应急中'; }
  else if (openAlerts.some(a => a.level === 'critical')) { status = 'critical'; statusText = '🔴 需要关注'; }
  else if (openAlerts.length || meds.missed > 0 || (sys && (sys.value > alerts.THRESHOLDS.systolic.high || sys.value < alerts.THRESHOLDS.systolic.low))) { status = 'warning'; statusText = '⚠️ 略有异常'; }
  const fresh = v => v && t - v.ts < 24 * 3600e3 ? v : null;
  return {
    id: eid, name: e.name, age: e.age, avatar: e.avatar, status, statusText,
    health: { conditions: h.conditions, allergies: h.allergies, address: h.address || '' },
    vitals: {
      heart_rate: fresh(hr), spo2: fresh(spo2),
      bp: (fresh(sys) || fresh(dia)) ? { sys: fresh(sys), dia: fresh(dia) } : null,
      steps: fresh(steps), sleep: fresh(sleep),
    },
    meds, loc, lastCheckin, lastContact: lastContact ? { ts: lastContact.ts, type: JSON.parse(lastContact.data || '{}').type || '联系' } : null,
    activeSos, alerts: openAlerts,
  };
}

route('GET', '/api/dashboard', async req => {
  const u = requireAuth(req);
  const f = famOf(u); if (!f) return { family: null, elders: [] };
  return {
    family: { name: f.name, city: f.city, plan: f.plan },
    elders: eldersOf(f.id).map(e => elderStatus(e.id)),
    trend7: trend7(f.id),
  };
});

function trend7(fid) {
  // 近 7 天状态趋势（活动量/打卡次数/预警数）——"情绪指标"简化实现
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d0 = new Date(now() - i * 86400e3);
    const ds = alerts.fmtDate(d0);
    const start = new Date(ds + 'T00:00:00+08:00').getTime();
    const end = start + 86400e3;
    const ev = get("SELECT COUNT(*) c FROM events e JOIN family_members m ON m.user_id=e.elder_id WHERE m.family_id=? AND e.ts>=? AND e.ts<? AND e.kind IN('checkin','door_out','door_in')", fid, start, end).c;
    const al = get('SELECT COUNT(*) c FROM alerts WHERE family_id=? AND created_at>=? AND created_at<?', fid, start, end).c;
    out.push({ date: ds.slice(5), activity: ev, alerts: al });
  }
  return out;
}

route('GET', '/api/vitals', async req => {
  const u = requireAuth(req);
  const eid = Number(req.query.elder_id);
  if (!canSeeElder(u, eid)) denied();
  const type = req.query.type || 'heart_rate';
  const hours = Math.min(Number(req.query.hours || 24), 24 * 30);
  const rows = all('SELECT ts, value, source FROM vitals WHERE elder_id=? AND type=? AND ts>=? ORDER BY ts', eid, type, now() - hours * 3600e3);
  return { elder_id: eid, type, points: rows };
});

route('POST', '/api/vitals', async (req, body) => {
  const u = requireAuth(req);
  const eid = Number(body.elder_id);
  if (u.role !== 'elder' && !canSeeElder(u, eid)) denied();
  if (u.role === 'elder' && u.id !== eid) denied('只能上报自己的数据');
  const type = body.type;
  if (!['heart_rate', 'spo2', 'systolic', 'diastolic', 'steps', 'sleep', 'weight', 'glucose'].includes(type)) bad('指标类型不正确');
  const value = Number(body.value);
  if (!isFinite(value)) bad('数值不正确');
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', eid, Number(body.ts) || now(), type, value, body.source || (u.role === 'elder' ? 'manual' : 'device'));
  alerts.checkVital(eid, type, value);
  return { ok: true };
});

route('POST', '/api/events', async (req, body) => {
  const u = requireAuth(req);
  const eid = Number(body.elder_id ?? u.id);
  if (u.role === 'elder' && u.id !== eid) denied();
  if (u.role !== 'elder' && !canSeeElder(u, eid)) denied();
  const kind = body.kind;
  if (!['checkin', 'door_in', 'door_out', 'gps', 'contact'].includes(kind)) bad('事件类型不正确');
  const data = JSON.stringify(body.data || {});
  run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', eid, now(), kind, data);
  const fid = familyOf(eid);
  if (kind === 'checkin' && fid) {
    notifyChildren(fid, '💚 父母打卡', `${userName(eid)} 打卡"我很好"（${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）`, 'checkin');
  }
  return { ok: true };
});

route('GET', '/api/sharecard', async req => {
  // 传播设计：脱敏分享卡片（不展示具体数值）
  const u = requireAuth(req);
  const f = famOf(u); if (!f) bad('请先加入家庭圈');
  const cards = eldersOf(f.id).map(e => {
    const st = elderStatus(e.id);
    const steps = st.vitals.steps?.value;
    return {
      name: e.name.replace(/./g, (c, i) => i === 0 ? c : '*'),
      statusText: { normal: '今天一切正常', warning: '有点小状况，已安排关注', critical: '需要重点关注', sos: '应急处理中' }[st.status] || '今天一切正常',
      summary: `步数 ${steps ? Math.round(steps / 100) * 100 + '+' : '—'}｜用药 ${st.meds.taken ? `已服 ${st.meds.taken} 次` : '按时提醒中'}｜${st.loc}`,
    };
  });
  return {
    title: `今天在身边 · ${f.name}`,
    date: alerts.todayStr(),
    cards,
    hook: '你有多久没看到父母的真实状态了？',
    slogan: '你不在身边的日子，让爱替你在。',
  };
});

// ---------- 用药 ----------
route('GET', '/api/meds', async req => {
  const u = requireAuth(req);
  const eid = Number(req.query.elder_id || u.id);
  if (!canSeeElder(u, eid) && !(u.role === 'elder' && u.id === eid)) denied();
  alerts.ensureTodayLogs(eid);
  return {
    meds: all('SELECT * FROM meds WHERE elder_id=? AND active=1', eid),
    today: all('SELECT l.*, m.name med_name, m.dose FROM med_logs l JOIN meds m ON m.id=l.med_id WHERE l.elder_id=? AND l.date=? ORDER BY l.time', eid, alerts.todayStr()),
  };
});

route('POST', '/api/meds', async (req, body) => {
  const u = requireAuth(req);
  const eid = Number(body.elder_id || u.id);
  if (!canSeeElder(u, eid) && !(u.role === 'elder' && u.id === eid)) denied();
  if (!body.name) bad('请填写药品名');
  let times = ['08:00'];
  try { if (Array.isArray(body.times) && body.times.length) times = body.times; } catch {}
  const r = run('INSERT INTO meds(elder_id,name,dose,times) VALUES(?,?,?,?)', eid, body.name, body.dose || '', JSON.stringify(times));
  alerts.ensureTodayLogs(eid);
  addTimeline(familyOf(eid), eid, 'med', `新增用药：${body.name} ${body.dose || ''}（${times.join('/')}）`);
  return { id: Number(r.lastInsertRowid) };
});

route('POST', '/api/meds/:id/take', async (req, body, p) => {
  const u = requireAuth(req);
  const logId = Number(p.id);
  const l = get('SELECT * FROM med_logs WHERE id=?', logId);
  if (!l) notfound();
  if (!canSeeElder(u, l.elder_id) && !(u.role === 'elder' && u.id === l.elder_id)) denied();
  run("UPDATE med_logs SET status='taken', taken_ts=? WHERE id=?", now(), logId);
  const m = get('SELECT name FROM meds WHERE id=?', l.med_id);
  run("INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)", l.elder_id, now(), 'checkin', JSON.stringify({ sub: 'med', med: m?.name }));
  return { ok: true, status: 'taken' };
});

// ---------- 家庭协同：任务/轮值/费用/投票 ----------
route('GET', '/api/tasks', async req => {
  const u = requireAuth(req); const f = famOf(u); if (!f) return { tasks: [] };
  return { tasks: all('SELECT t.*, u.name claimed_name FROM tasks t LEFT JOIN users u ON u.id=t.claimed_by WHERE t.family_id=? ORDER BY t.status, t.due_date', f.id) };
});
route('POST', '/api/tasks', async (req, body) => {
  const u = requireAuth(req); const f = famOf(u); if (!f) bad('请先加入家庭圈');
  if (u.role === 'provider') denied();
  if (!body.title) bad('请填写任务');
  const r = run('INSERT INTO tasks(family_id,elder_id,title,detail,due_date,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    f.id, body.elder_id || null, body.title, body.detail || '', body.due_date || '', u.id, now());
  notifyAll(f.id, '📌 新任务', `${u.name} 发布了任务：${body.title}${body.due_date ? `（${body.due_date}）` : ''}`, 'task');
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/tasks/:id/claim', async (req, body, p) => {
  const u = requireAuth(req);
  const t = get('SELECT * FROM tasks WHERE id=?', Number(p.id));
  if (!t) notfound();
  if (t.family_id !== famOf(u)?.id) denied();
  if (t.status !== 'open') bad('任务已被认领或完成');
  run("UPDATE tasks SET status='claimed', claimed_by=? WHERE id=?", u.id, t.id);
  notifyAll(t.family_id, '🙋 任务已认领', `${u.name} 认领了「${t.title}」`, 'task');
  addTimeline(t.family_id, t.elder_id, 'task', `${u.name} 认领任务「${t.title}」`);
  return { ok: true };
});
route('POST', '/api/tasks/:id/done', async (req, body, p) => {
  const u = requireAuth(req);
  const t = get('SELECT * FROM tasks WHERE id=?', Number(p.id));
  if (!t) notfound();
  if (t.family_id !== famOf(u)?.id) denied();
  if (t.claimed_by && t.claimed_by !== u.id && u.role !== 'child') denied('只有认领人可完成');
  run("UPDATE tasks SET status='done' WHERE id=?", t.id);
  notifyAll(t.family_id, '✅ 任务完成', `「${t.title}」已由 ${userName(t.claimed_by || u.id)} 完成`, 'task');
  addTimeline(t.family_id, t.elder_id, 'task', `任务完成「${t.title}」`);
  return { ok: true };
});

route('GET', '/api/duty', async req => {
  const u = requireAuth(req); const f = famOf(u); if (!f) return { duty: [] };
  const month = (req.query.month || alerts.todayStr().slice(0, 7));
  return { duty: all('SELECT d.*, u.name user_name FROM duty d JOIN users u ON u.id=d.user_id WHERE d.family_id=? AND d.date LIKE ? ORDER BY d.date', f.id, month + '%') };
});
route('POST', '/api/duty', async (req, body) => {
  const u = requireAuth(req); const f = famOf(u); if (!f) bad('请先加入家庭圈');
  if (!body.user_id || !body.date) bad('缺少参数');
  run('INSERT INTO duty(family_id,user_id,date,note) VALUES(?,?,?,?)', f.id, Number(body.user_id), body.date, body.note || '');
  return { ok: true };
});

route('GET', '/api/expenses', async req => {
  const u = requireAuth(req); const f = famOf(u); if (!f) return { expenses: [], aa: null };
  const rows = all('SELECT e.*, u.name paid_name FROM expenses e JOIN users u ON u.id=e.paid_by WHERE e.family_id=? ORDER BY e.created_at DESC', f.id);
  // AA 结算：按 split=aa 均摊（家庭成员中 role=child 者分摊），给出净转账建议
  const kids = famMembers(f.id).filter(m => m.role === 'child');
  const bal = {}; for (const k of kids) bal[k.id] = 0;
  for (const e of rows.filter(r => r.split === 'aa')) {
    const share = e.amount / kids.length;
    for (const k of kids) bal[k.id] -= share;
    if (bal[e.paid_by] !== undefined) bal[e.paid_by] += e.amount;
  }
  const creditors = Object.entries(bal).filter(([, v]) => v > 0.01).sort((a, b) => b[1] - a[1]);
  const debtors = Object.entries(bal).filter(([, v]) => v < -0.01).sort((a, b) => a[1] - b[1]);
  const transfers = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const amt = Math.min(creditors[ci][1], -debtors[di][1]);
    if (amt > 0.01) transfers.push({ from: userName(Number(debtors[di][0])), to: userName(Number(creditors[ci][0])), amount: Math.round(amt * 100) / 100 });
    creditors[ci][1] -= amt; debtors[di][1] += amt;
    if (creditors[ci][1] <= 0.01) ci++;
    if (debtors[di][1] >= -0.01) di++;
  }
  return { expenses: rows, aa: { members: kids.map(k => ({ name: k.name, balance: Math.round((bal[k.id] || 0) * 100) / 100 })), transfers, total: rows.reduce((s, r) => s + r.amount, 0) } };
});
route('POST', '/api/expenses', async (req, body) => {
  const u = requireAuth(req); const f = famOf(u); if (!f) bad('请先加入家庭圈');
  if (!body.title || !(Number(body.amount) > 0)) bad('请填写事项和金额');
  run('INSERT INTO expenses(family_id,title,category,amount,paid_by,split,created_at) VALUES(?,?,?,?,?,?,?)',
    f.id, body.title, body.category || '其他', Number(body.amount), u.id, body.split === 'self' ? 'self' : 'aa', now());
  notifyAll(f.id, '💰 赡养支出记录', `${u.name} 记录了「${body.title}」¥${body.amount}`, 'expense');
  return { ok: true };
});

route('GET', '/api/votes', async req => {
  const u = requireAuth(req); const f = famOf(u); if (!f) return { votes: [] };
  const vs = all('SELECT * FROM votes WHERE family_id=? ORDER BY created_at DESC', f.id);
  return { votes: vs.map(v => ({ ...v, options: JSON.parse(v.options), records: all('SELECT r.*, u.name user_name FROM vote_records r JOIN users u ON u.id=r.user_id WHERE r.vote_id=?', v.id) })) };
});
route('POST', '/api/votes', async (req, body) => {
  const u = requireAuth(req); const f = famOf(u); if (!f) bad('请先加入家庭圈');
  if (!body.title || !Array.isArray(body.options) || body.options.length < 2) bad('请填写议题和至少两个选项');
  const r = run('INSERT INTO votes(family_id,title,options,deadline,created_by,created_at) VALUES(?,?,?,?,?,?)',
    f.id, body.title, JSON.stringify(body.options), body.deadline ? new Date(body.deadline).getTime() : now() + 3 * 86400e3, u.id, now());
  notifyAll(f.id, '🗳️ 家庭投票', `${u.name} 发起投票：${body.title}`, 'vote');
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/votes/:id/cast', async (req, body, p) => {
  const u = requireAuth(req);
  const v = get('SELECT * FROM votes WHERE id=?', Number(p.id));
  if (!v) notfound();
  if (v.family_id !== famOf(u)?.id) denied();
  if (v.status !== 'open') bad('投票已结束');
  const opts = JSON.parse(v.options);
  if (!opts.includes(body.choice)) bad('选项无效');
  run('INSERT OR REPLACE INTO vote_records(vote_id,user_id,choice) VALUES(?,?,?)', v.id, u.id, body.choice);
  const total = famMembers(v.family_id).filter(m => m.role === 'child').length;
  const cast = get('SELECT COUNT(*) c FROM vote_records WHERE vote_id=?', v.id).c;
  if (cast >= total) {
    run("UPDATE votes SET status='closed' WHERE id=?", v.id);
    const winner = all('SELECT choice, COUNT(*) c FROM vote_records WHERE vote_id=? GROUP BY choice ORDER BY c DESC LIMIT 1', v.id)[0];
    notifyAll(v.family_id, '🗳️ 投票结果', `「${v.title}」结果：${winner?.choice}（${winner?.c} 票）`, 'vote');
    addTimeline(v.family_id, null, 'vote', `家庭决策「${v.title}」→ ${winner?.choice}`);
  }
  return { ok: true, closed: cast >= total };
});

// ---------- 服务下单 / 订单 ----------
route('GET', '/api/services', async req => {
  requireAuth(req);
  return { services: Object.entries(disp.SERVICES).map(([k, v]) => ({ type: k, ...v })) };
});

route('POST', '/api/orders', async (req, body) => {
  const u = requireAuth(req); const f = famOf(u); if (!f) bad('请先加入家庭圈');
  if (!disp.SERVICES[body.service_type]) bad('服务类型不存在');
  const eid = Number(body.elder_id || (u.role === 'elder' ? u.id : 0));
  if (!canSeeElder(u, eid) && !(u.role === 'elder' && u.id === eid)) bad('请选择家庭圈内的老人');
  const scheduled = Number(body.scheduled_at) || now() + 3600e3;
  const fromElder = u.role === 'elder' ? 1 : 0;
  // 子女审核机制：大额/高风险 → 需子女确认；小额低风险 → 直接派单+事后通知
  const highRisk = ['accompany_full', 'rehab', 'bath'].includes(body.service_type);
  const needReview = (fromElder && (disp.price(body.service_type) >= 100 || highRisk)) ? 1 : 0;
  const r = run('INSERT INTO orders(family_id,elder_id,service_type,scheduled_at,location,notes,price,status,need_review,created_by,from_elder,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    f.id, eid, body.service_type, scheduled, body.location || '', body.notes || '', disp.price(body.service_type),
    needReview ? 'awaiting_review' : 'pending', needReview, u.id, fromElder, now());
  const id = Number(r.lastInsertRowid);
  if (needReview) {
    notifyChildren(f.id, '🧓 父母发起服务请求', `${userName(eid)} 想预约「${disp.label(body.service_type)}」，需要您确认后派单`, 'order');
  } else {
    disp.dispatch(id);
    if (fromElder) notifyChildren(f.id, '📋 父母已下单', `${userName(eid)} 预约了「${disp.label(body.service_type)}」（小额服务已自动派单）`, 'order');
  }
  return { id, need_review: !!needReview };
});

route('GET', '/api/orders', async req => {
  const u = requireAuth(req);
  if (u.role === 'provider') {
    return { orders: all('SELECT o.*, e.name elder_name, e.age elder_age FROM orders o JOIN users e ON e.id=o.elder_id WHERE o.provider_id=? ORDER BY o.scheduled_at DESC', u.id) };
  }
  const f = famOf(u); if (!f) return { orders: [] };
  return { orders: all('SELECT o.*, e.name elder_name, p.name provider_name FROM orders o JOIN users e ON e.id=o.elder_id LEFT JOIN users p ON p.id=o.provider_id WHERE o.family_id=? ORDER BY o.created_at DESC LIMIT 100', f.id) };
});

route('POST', '/api/orders/:id/review', async (req, body, p) => {
  const u = requireAuth(req);
  const o = get('SELECT * FROM orders WHERE id=?', Number(p.id));
  if (!o) notfound();
  if (u.role !== 'child' || famOf(u)?.id !== o.family_id) denied('仅子女可审核');
  if (o.status !== 'awaiting_review') bad('订单不在待审核状态');
  if (body.approve === false) {
    run("UPDATE orders SET status='rejected' WHERE id=?", o.id);
    notify(o.elder_id, o.family_id, '订单未通过', `您预约的「${disp.label(o.service_type)}」家人建议再商量一下，稍后会联系您`, 'order');
    return { ok: true, status: 'rejected' };
  }
  run("UPDATE orders SET status='pending', need_review=0 WHERE id=?", o.id);
  disp.dispatch(o.id);
  notify(o.elder_id, o.family_id, '✅ 家人已确认', `您预约的「${disp.label(o.service_type)}」已确认并安排人员`, 'order');
  return { ok: true, status: 'assigned' };
});

route('POST', '/api/orders/:id/accept', async (req, body, p) => {
  const u = requireAuth(req);
  const o = get('SELECT * FROM orders WHERE id=?', Number(p.id));
  if (!o) notfound();
  if (o.provider_id !== u.id) denied();
  if (o.status !== 'assigned') bad('订单状态不允许');
  run("UPDATE orders SET status='accepted' WHERE id=?", o.id);
  run('INSERT INTO provider_updates(order_id,ts,text) VALUES(?,?,?)', o.id, now(), `${u.name} 已接单，将按时到达`);
  notifyChildren(o.family_id, '🧾 服务人员已接单', `「${disp.label(o.service_type)}」${u.name} 已接单`, 'order');
  notify(o.elder_id, o.family_id, '✅ 已安排', `「${disp.label(o.service_type)}」服务人员 ${u.name} 已接单`, 'order');
  return { ok: true };
});

route('POST', '/api/orders/:id/progress', async (req, body, p) => {
  const u = requireAuth(req);
  const o = get('SELECT * FROM orders WHERE id=?', Number(p.id));
  if (!o) notfound();
  if (o.provider_id !== u.id) denied();
  if (!body.text) bad('请填写进展');
  run('INSERT INTO provider_updates(order_id,ts,text) VALUES(?,?,?)', o.id, now(), body.text);
  notifyChildren(o.family_id, '📍 服务进展', `「${disp.label(o.service_type)}」${body.text}`, 'order');
  return { ok: true };
});

route('POST', '/api/orders/:id/complete', async (req, body, p) => {
  const u = requireAuth(req);
  const o = get('SELECT * FROM orders WHERE id=?', Number(p.id));
  if (!o) notfound();
  if (o.provider_id !== u.id) denied();
  if (!['accepted', 'in_service'].includes(o.status)) bad('订单状态不允许');
  run("UPDATE orders SET status='done' WHERE id=?", o.id);
  run('INSERT INTO provider_updates(order_id,ts,text) VALUES(?,?,?)', o.id, now(), '服务完成' + (body.summary ? `：${body.summary}` : ''));
  run('UPDATE provider_profiles SET jobs=jobs+1 WHERE user_id=?', u.id);
  notifyChildren(o.family_id, '✅ 服务完成', `「${disp.label(o.service_type)}」已完成，欢迎评价${body.summary ? `。${body.summary}` : ''}`, 'order');
  addTimeline(o.family_id, o.elder_id, 'order', `完成服务「${disp.label(o.service_type)}」¥${o.price}`);
  // 医嘱归档入口提示
  if (o.service_type.startsWith('accompany') && body.doctor_note) {
    run('INSERT INTO reports(elder_id,title,ts,summary,created_by) VALUES(?,?,?,?,?)',
      o.elder_id, '就诊记录（陪诊归档）', now(), body.doctor_note, u.id);
    addTimeline(o.family_id, o.elder_id, 'report', '陪诊师归档就诊记录与医嘱');
  }
  return { ok: true };
});

route('POST', '/api/orders/:id/rate', async (req, body, p) => {
  const u = requireAuth(req);
  const o = get('SELECT * FROM orders WHERE id=?', Number(p.id));
  if (!o) notfound();
  if (famOf(u)?.id !== o.family_id) denied();
  if (o.status !== 'done') bad('订单未完成');
  if (o.rating) bad('已评价过');
  const rating = Math.max(1, Math.min(5, Number(body.rating) || 5));
  run('UPDATE orders SET rating=?, review=? WHERE id=?', rating, body.review || '', o.id);
  if (o.provider_id) {
    const st = get('SELECT rating, jobs FROM provider_profiles WHERE user_id=?', o.provider_id);
    if (st) run('UPDATE provider_profiles SET rating=? WHERE user_id=?',
      Math.round(((st.rating * st.jobs + rating) / (st.jobs + 1)) * 10) / 10, o.provider_id);
  }
  return { ok: true };
});

route('POST', '/api/orders/:id/cancel', async (req, body, p) => {
  const u = requireAuth(req);
  const o = get('SELECT * FROM orders WHERE id=?', Number(p.id));
  if (!o) notfound();
  if (famOf(u)?.id !== o.family_id && !(u.role === 'elder' && u.id === o.elder_id)) denied();
  if (['done', 'cancelled'].includes(o.status)) bad('无法取消');
  run("UPDATE orders SET status='cancelled' WHERE id=?", o.id);
  if (o.provider_id) notify(o.provider_id, o.family_id, '订单已取消', `「${disp.label(o.service_type)}」客户已取消`, 'order');
  notifyChildren(o.family_id, '订单已取消', `「${disp.label(o.service_type)}」已取消`, 'order');
  return { ok: true };
});

route('GET', '/api/orders/:id', async (req, body, p) => {
  const u = requireAuth(req);
  const o = get('SELECT o.*, e.name elder_name, e.phone elder_phone, pu.name provider_name, pr.rating provider_rating FROM orders o JOIN users e ON e.id=o.elder_id LEFT JOIN users pu ON pu.id=o.provider_id LEFT JOIN provider_profiles pr ON pr.user_id=o.provider_id WHERE o.id=?', Number(p.id));
  if (!o) notfound();
  if (famOf(u)?.id !== o.family_id && o.provider_id !== u.id) denied();
  return { order: o, updates: all('SELECT * FROM provider_updates WHERE order_id=? ORDER BY ts', o.id) };
});

// ---------- 应急中心 ----------
route('POST', '/api/sos', async (req, body) => {
  const u = requireAuth(req);
  const eid = u.role === 'elder' ? u.id : Number(body.elder_id);
  if (u.role !== 'elder' && !canSeeElder(u, eid)) denied();
  if (!eid) bad('缺少 elder_id');
  const id = emer.create(eid, body.trigger || (u.role === 'elder' ? 'button' : 'manual'));
  return { sos_id: id };
});

route('GET', '/api/sos', async req => {
  const u = requireAuth(req); const f = famOf(u); if (!f) return { list: [] };
  return {
    active: all("SELECT s.*, e.name elder_name FROM sos s JOIN users e ON e.id=s.elder_id WHERE s.family_id=? AND s.status NOT IN('resolved','cancelled')", f.id),
    history: all("SELECT s.*, e.name elder_name FROM sos s JOIN users e ON e.id=s.elder_id WHERE s.family_id=? ORDER BY s.started_at DESC LIMIT 20", f.id),
  };
});

route('GET', '/api/sos/:id', async (req, body, p) => {
  const u = requireAuth(req);
  const s = get('SELECT * FROM sos WHERE id=?', Number(p.id));
  if (!s) notfound();
  if (famOf(u)?.id !== s.family_id && !(u.role === 'elder' && u.id === s.elder_id)) denied();
  let log = []; try { log = JSON.parse(s.log); } catch {}
  return { sos: { ...s, log, status_label: emer.LEVEL_LABEL[s.status] || s.status, card: emer.card(s.id) } };
});

route('POST', '/api/sos/:id/cancel', async (req, body, p) => {
  const u = requireAuth(req);
  const s = emer.cancelByElder(Number(p.id), u.id);
  if (!s) bad('无法取消（只有触发警报的老人本人可确认安全取消）');
  return { ok: true };
});
route('POST', '/api/sos/:id/ack', async (req, body, p) => {
  const u = requireAuth(req);
  const s = emer.ack(Number(p.id), u.id);
  if (!s) bad('无法响应');
  return { ok: true };
});
route('POST', '/api/sos/:id/resolve', async (req, body, p) => {
  const u = requireAuth(req);
  const s = emer.resolve(Number(p.id), u.id, body.note);
  if (!s) bad('无法解除');
  return { ok: true };
});

// ---------- 通知 ----------
route('POST', '/api/alerts/:id/ack', async (req, body, p) => {
  const u = requireAuth(req);
  const a = get('SELECT * FROM alerts WHERE id=?', Number(p.id));
  if (!a) notfound();
  if (famOf(u)?.id !== a.family_id) denied();
  run("UPDATE alerts SET status='acked', ack_by=? WHERE id=?", u.id, a.id);
  return { ok: true };
});

route('GET', '/api/notifications', async req => {
  const u = requireAuth(req);
  return {
    notifications: all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50', u.id),
    unread: get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0', u.id).c,
  };
});
route('POST', '/api/notifications/read', async req => {
  const u = requireAuth(req);
  run('UPDATE notifications SET read=1 WHERE user_id=?', u.id);
  return { ok: true };
});

// ---------- 医疗档案 ----------
route('GET', '/api/reports', async req => {
  const u = requireAuth(req);
  const eid = Number(req.query.elder_id || u.id);
  if (!canSeeElder(u, eid) && !(u.role === 'elder' && u.id === eid)) denied();
  return { reports: all('SELECT * FROM reports WHERE elder_id=? ORDER BY ts DESC', eid) };
});
route('POST', '/api/reports', async (req, body) => {
  const u = requireAuth(req);
  const eid = Number(body.elder_id || u.id);
  if (!canSeeElder(u, eid) && !(u.role === 'elder' && u.id === eid)) denied();
  if (!body.title) bad('请填写标题');
  const r = run('INSERT INTO reports(elder_id,title,ts,summary,created_by) VALUES(?,?,?,?,?)', eid, body.title, now(), body.summary || '', u.id);
  addTimeline(familyOf(eid), eid, 'report', `归档：${body.title}`);
  return { id: Number(r.lastInsertRowid) };
});
route('POST', '/api/reports/:id/ai', async (req, body, p) => {
  // 体检报告 AI 白话解读（规则模板版；预留接入大模型）
  const u = requireAuth(req);
  const r = get('SELECT * FROM reports WHERE id=?', Number(p.id));
  if (!r) notfound();
  if (!canSeeElder(u, r.elder_id)) denied();
  const eid = r.elder_id;
  const parts = [];
  const hr = get("SELECT value FROM vitals WHERE elder_id=? AND type='heart_rate' ORDER BY ts DESC LIMIT 1", eid);
  const sys = get("SELECT value FROM vitals WHERE elder_id=? AND type='systolic' ORDER BY ts DESC LIMIT 1", eid);
  const sleep = get("SELECT value FROM vitals WHERE elder_id=? AND type='sleep' ORDER BY ts DESC LIMIT 1", eid);
  parts.push(`【白话版解读】这份报告整体${sys && sys.value > 140 ? '需要重点关注血压问题' : '情况平稳'}。`);
  if (sys) parts.push(`· 血压 ${sys.value}${get("SELECT value FROM vitals WHERE elder_id=? AND type='diastolic' ORDER BY ts DESC LIMIT 1", eid)?.value ? '/' + get("SELECT value FROM vitals WHERE elder_id=? AND type='diastolic' ORDER BY ts DESC LIMIT 1", eid).value : ''} mmHg：${sys.value > 140 ? '高于参考值，建议本周内复测并咨询医生，低盐饮食' : sys.value < 90 ? '偏低，注意起身缓慢防头晕' : '在参考范围内，继续保持'}`);
  if (hr) parts.push(`· 心率 ${hr.value} 次/分：${hr.value > 100 ? '偏快，注意休息、避免浓茶咖啡，持续偏快请就医' : hr.value < 55 ? '偏慢，如无运动员背景建议做心电图' : '正常'}`);
  if (sleep) parts.push(`· 睡眠 ${sleep.value} 小时：${sleep.value < 5.5 ? '明显不足，长期影响血压和免疫，建议排查夜间不适' : sleep.value > 9 ? '偏多，留意是否白天乏力' : '基本充足'}`);
  const meds = all('SELECT name FROM meds WHERE elder_id=? AND active=1', eid);
  if (meds.length > 3) parts.push(`· 目前在用 ${meds.length} 种药物（${meds.map(m => m.name).join('、')}），多药同服请让医生核对相互作用`);
  parts.push(`· 未来 6 个月建议：${sys && sys.value > 140 ? '每周一、三、五早晚各测一次血压并记录；' : '保持每周 3 次以上适度活动；'}按时服药打卡；下次复诊前 3 天平台会自动提醒。`);
  parts.push('（以上为健康提示，不能替代医生诊断。如有不适请及时就医。）');
  const note = parts.join('\n');
  run('UPDATE reports SET ai_note=? WHERE id=?', note, r.id);
  return { ai_note: note };
});

// ---------- 设备模拟（IoT 层替身：手表/门磁/血压计/药盒） ----------
route('GET', '/api/devices', async req => {
  const u = requireAuth(req); const f = famOf(u); if (!f) return { devices: [] };
  return { devices: all('SELECT d.*, e.name elder_name FROM devices d JOIN users e ON e.id=d.elder_id WHERE d.family_id=?', f.id) };
});
route('POST', '/api/devices', async (req, body) => {
  const u = requireAuth(req); const f = famOf(u); if (!f) bad('请先加入家庭圈');
  const eid = Number(body.elder_id);
  if (!canSeeElder(u, eid)) denied();
  if (!['watch', 'radar', 'door', 'bp', 'pillbox'].includes(body.type)) bad('设备类型不正确');
  const names = { watch: '智能手表', radar: '毫米波雷达', door: '智能门磁', bp: '血压计', pillbox: '智能药盒' };
  const r = run('INSERT INTO devices(family_id,elder_id,type,name) VALUES(?,?,?,?)', f.id, eid, body.type, names[body.type]);
  return { id: Number(r.lastInsertRowid), name: names[body.type] };
});
route('POST', '/api/devices/:id/push', async (req, body, p) => {
  // 模拟设备数据上报（真实环境走 MQTT）
  const u = requireAuth(req);
  const d = get('SELECT * FROM devices WHERE id=?', Number(p.id));
  if (!d) notfound();
  if (!canSeeElder(u, d.elder_id)) denied();
  const ts = now();
  const pushed = [];
  function vit(type, value) {
    run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', d.elder_id, ts, type, value, 'device');
    alerts.checkVital(d.elder_id, type, value);
    pushed.push(`${type}=${value}`);
  }
  const data = body.data || {};
  if (d.type === 'watch') {
    if (data.heart_rate != null) vit('heart_rate', data.heart_rate);
    if (data.spo2 != null) vit('spo2', data.spo2);
    if (data.steps != null) vit('steps', data.steps);
    if (data.sleep != null) vit('sleep', data.sleep);
    if (data.fall) {
      run("INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)", d.elder_id, ts, 'fall', '{}');
      const sid = emer.create(d.elder_id, 'fall_detect');
      pushed.push(`跌倒检测→SOS#${sid}`);
    }
  } else if (d.type === 'bp') {
    if (data.systolic != null) vit('systolic', data.systolic);
    if (data.diastolic != null) vit('diastolic', data.diastolic);
  } else if (d.type === 'door') {
    const kind = data.open ? 'door_out' : 'door_in';
    run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', d.elder_id, ts, kind, JSON.stringify(data));
    pushed.push(kind);
  } else if (d.type === 'radar') {
    run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', d.elder_id, ts, 'activity', JSON.stringify(data));
    pushed.push('activity');
  } else if (d.type === 'pillbox') {
    const log = get("SELECT * FROM med_logs WHERE elder_id=? AND date=? AND status='pending' ORDER BY time LIMIT 1", d.elder_id, alerts.todayStr());
    if (log) { run("UPDATE med_logs SET status='taken', taken_ts=? WHERE id=?", ts, log.id); pushed.push(`药盒开盖→打卡 ${log.time}`); }
  }
  run('UPDATE devices SET last_ts=? WHERE id=?', ts, d.id);
  return { ok: true, pushed };
});

// ---------- 服务商档案 ----------
route('GET', '/api/provider/profile', async req => {
  const u = requireAuth(req);
  if (u.role !== 'provider') denied();
  const p = get('SELECT * FROM provider_profiles WHERE user_id=?', u.id);
  return { profile: p ? { ...p, specialties: JSON.parse(p.specialties) } : null, user: pub(u) };
});
route('POST', '/api/provider/profile', async (req, body) => {
  const u = requireAuth(req);
  if (u.role !== 'provider') denied();
  run('UPDATE provider_profiles SET city=?, specialties=?, online=? WHERE user_id=?',
    body.city || '长沙', JSON.stringify(body.specialties || []), body.online === false ? 0 : 1, u.id);
  return { ok: true };
});

// ---------- HTTP server ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  req.query = Object.fromEntries(url.searchParams);
  if (p.startsWith('/api/')) {
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = p.match(r.rx);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      const out = await r.handler(req, body, params);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }
    throw new HttpErr(404, '接口不存在: ' + p);
  }
  // 静态文件
  let fp = p === '/' ? '/index.html' : p;
  const file = path.join(WEB_DIR, path.normalize(fp));
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw new HttpErr(404, '页面不存在');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (e) {
    const code = e instanceof HttpErr ? e.code : 500;
    if (code === 500) console.error('[500]', req.method, req.url, e);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message || '服务器错误' }));
  }
});

// 定时引擎：应急升级 + 预警扫描
const SWEEP_MS = Number(process.env.SWEEP_MS || 15000);
const timer = setInterval(() => {
  try { emer.sweep(); alerts.sweep(); } catch (e) { console.error('[sweep]', e); }
}, SWEEP_MS);
timer.unref();

server.listen(PORT, () => {
  console.log(`在身边 MVP 服务已启动: http://0.0.0.0:${PORT} (数据: ${D.DATA_DIR})`);
});
module.exports = { server, routes };
