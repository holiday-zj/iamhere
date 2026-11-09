// emergency.js — 一键应急中心：4 级分级响应引擎（PRD 模块二）
'use strict';
const { all, get, run, now, notify, notifyChildren, notifyAll, addTimeline, userName } = require('./db');

// L1 60s 无取消 → L2；L2 3min 无子女响应 → L3；L3 5min → L4（呼叫120）
// SOS_TIME_SCALE 可整体缩放（测试/演示用）
const SCALE = Number(process.env.SOS_TIME_SCALE || 1);
const LEVEL_MS = { level1: 60e3 * SCALE, level2: 180e3 * SCALE, level3: 300e3 * SCALE };
const LEVEL_LABEL = {
  level1: 'L1 自动检测/触发确认中',
  level2: 'L2 已通知紧急联系人',
  level3: 'L3 已通知社区+就近人员上门',
  level4: 'L4 已呼叫120+全员通知',
  resolved: '已解除', cancelled: '已取消（老人确认安全）',
};

function appendLog(sosId, text) {
  const s = get('SELECT log FROM sos WHERE id=?', sosId);
  if (!s) return;
  let l = []; try { l = JSON.parse(s.log); } catch {}
  l.push({ ts: now(), text });
  run('UPDATE sos SET log=? WHERE id=?', JSON.stringify(l), sosId);
}

function create(elderId, trigger) {
  const fm = get('SELECT family_id FROM family_members WHERE user_id=?', elderId);
  if (!fm) throw new Error('老人未绑定家庭');
  const fid = fm.family_id;
  const active = get("SELECT id FROM sos WHERE elder_id=? AND status NOT IN('resolved','cancelled')", elderId);
  if (active) return Number(active.id);
  const r = run(
    'INSERT INTO sos(elder_id,family_id,trigger,status,started_at,level_started_at,log) VALUES(?,?,?,?,?,?,?)',
    elderId, fid, trigger || 'button', 'level1', now(), now(), '[]');
  const id = Number(r.lastInsertRowid);
  appendLog(id, `SOS 触发（${trigger || 'button'}）。老人端语音确认中："您还好吗？需要帮助吗？"（60 秒无回应将升级）`);
  notifyChildren(fid, '🚨 紧急警报',
    `${userName(elderId)} 触发 SOS！正在等待老人确认，请立刻打开 App 查看`, 'sos');
  addTimeline(fid, elderId, 'sos', `${userName(elderId)} 触发 SOS 应急流程`);
  return id;
}

function escalate(id) {
  const order = ['level1', 'level2', 'level3', 'level4'];
  const s = get('SELECT * FROM sos WHERE id=?', id);
  if (!s) return null;
  const i = order.indexOf(s.status);
  if (i < 0 || i >= 3) return s.status;
  const next = order[i + 1];
  run('UPDATE sos SET status=?, level_started_at=? WHERE id=?', next, now(), id);
  const elder = userName(s.elder_id);
  if (next === 'level2') {
    appendLog(id, `升级 ${LEVEL_LABEL.level2}：App 推送 + 电话呼叫 + 短信 三通道通知所有紧急联系人（3 分钟无回应继续升级）`);
    notifyChildren(s.family_id, '🚨 应急升级 L2',
      `${elder} 未确认安全！三通道呼叫中，请立即响应（App 点"我来处理"可暂停升级）`, 'sos');
  } else if (next === 'level3') {
    appendLog(id, `升级 ${LEVEL_LABEL.level3}：通知社区/物业，派就近服务人员上门查看，同时持续呼叫子女（5 分钟后呼叫 120）`);
    notifyAll(s.family_id, '🚨 应急升级 L3',
      `${elder} 的紧急事件：联系人无回应，已通知社区与就近服务人员上门`, 'sos');
  } else if (next === 'level4') {
    appendLog(id, `升级 ${LEVEL_LABEL.level4}：呼叫 120，应急信息卡（定位+病史+用药+过敏+联系人）已发送急救人员，全体家庭成员收到全程状态更新`);
    notifyAll(s.family_id, '🚨 应急升级 L4：已呼叫 120',
      `${elder} 的急救流程已启动，应急信息卡已发送，请立刻赶往现场！`, 'sos');
  }
  addTimeline(s.family_id, s.elder_id, 'sos', `应急事件升级至 ${LEVEL_LABEL[next]}`);
  return next;
}

function ack(id, userId) {
  const s = get('SELECT * FROM sos WHERE id=?', id);
  if (!s || ['resolved', 'cancelled'].includes(s.status)) return null;
  run('UPDATE sos SET acked_by=? WHERE id=?', userId, id);
  appendLog(id, `${userName(userId)} 已响应"我来处理"，升级暂停`);
  notifyAll(s.family_id, '✅ 已有家人响应', `${userName(userId)} 正在处理 ${userName(s.elder_id)} 的应急事件`, 'sos');
  return s;
}

function resolve(id, userId, note) {
  const s = get('SELECT * FROM sos WHERE id=?', id);
  if (!s || ['resolved', 'cancelled'].includes(s.status)) return null;
  run('UPDATE sos SET status=?, resolved_at=?, resolved_by=? WHERE id=?', 'resolved', now(), userId, id);
  appendLog(id, `${userName(userId)} 确认解除：${note || '老人平安'}`);
  notifyAll(s.family_id, '💚 应急已解除', `${userName(s.elder_id)} 的应急事件已由 ${userName(userId)} 确认解除。${note || ''}`, 'sos');
  addTimeline(s.family_id, s.elder_id, 'sos', `应急事件解除（${note || '平安'}）`);
  return s;
}

function cancelByElder(id, elderId) {
  const s = get('SELECT * FROM sos WHERE id=?', id);
  if (!s || s.elder_id !== elderId || ['resolved', 'cancelled'].includes(s.status)) return null;
  run("UPDATE sos SET status='cancelled', resolved_at=?, resolved_by=? WHERE id=?", now(), elderId, id);
  appendLog(id, '老人确认"我没事"，警报取消');
  notifyChildren(s.family_id, '💚 虚惊一场', `${userName(elderId)} 确认安全，SOS 已取消`, 'sos');
  addTimeline(s.family_id, elderId, 'sos', 'SOS 取消（老人确认安全）');
  return s;
}

// 定时推进升级
function sweep() {
  for (const s of all("SELECT * FROM sos WHERE status IN('level1','level2','level3')")) {
    const limit = LEVEL_MS[s.status];
    if (!limit) continue;
    if (s.status === 'level2' && s.acked_by) continue; // 子女已响应，暂停升级
    if (now() - s.level_started_at > limit) escalate(s.id);
  }
}

// 应急信息卡（发给急救人员/家属）
function card(id) {
  const s = get('SELECT * FROM sos WHERE id=?', id);
  if (!s) return null;
  const e = get('SELECT * FROM users WHERE id=?', s.elder_id);
  let h = {}; try { h = JSON.parse(e.health_json || '{}'); } catch {}
  const contacts = all(
    "SELECT u.name, u.phone, u.rel FROM family_members m JOIN users u ON u.id=m.user_id WHERE m.family_id=? AND u.role='child'",
    s.family_id);
  const meds = all('SELECT name, dose, times FROM meds WHERE elder_id=? AND active=1', s.elder_id)
    .map(m => { let t = []; try { t = JSON.parse(m.times); } catch {} return `${m.name} ${m.dose}（${t.join('/')}）`; });
  const gps = get("SELECT data FROM events WHERE elder_id=? AND kind='gps' ORDER BY ts DESC LIMIT 1", s.elder_id);
  let loc = h.address || '家中';
  if (gps) { try { loc = JSON.parse(gps.data).loc || loc; } catch {} }
  return {
    elder: { name: e.name, age: e.age, address: h.address || '', conditions: h.conditions || [], allergies: h.allergies || [], note: h.note || '' },
    location: loc,
    meds,
    contacts,
    sos_status: s.status,
    sos_status_label: LEVEL_LABEL[s.status] || s.status,
  };
}

module.exports = { create, escalate, ack, resolve, cancelByElder, sweep, card, LEVEL_MS, LEVEL_LABEL };
