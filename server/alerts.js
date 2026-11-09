// alerts.js — 预警引擎：阈值规则 + 定时扫描（PRD 模块一 异常预警规则）
'use strict';
const { all, get, run, now, notifyChildren, addTimeline, familyOf, userName } = require('./db');

const THRESHOLDS = {
  heart_rate: { low: 50, high: 110, unit: 'bpm', label: '心率' },
  spo2:       { low: 92, high: 999, unit: '%',   label: '血氧' },
  systolic:   { low: 90, high: 150, unit: 'mmHg', label: '收缩压' },
  diastolic:  { low: 60, high: 95,  unit: 'mmHg', label: '舒张压' },
};

const pad = n => String(n).padStart(2, '0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtHM = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const todayStr = () => fmtDate(new Date());
const nowHM = () => fmtHM(new Date());

function raise(elderId, level, kind, message) {
  const fid = familyOf(elderId);
  if (!fid) return null;
  const r = run('INSERT INTO alerts(family_id,elder_id,level,kind,message,created_at) VALUES(?,?,?,?,?,?)',
    fid, elderId, level, kind, message, now());
  notifyChildren(fid, level === 'critical' ? '🚨 需要关注' : '⚠️ 预警提醒', message, 'alert');
  addTimeline(fid, elderId, 'alert', message);
  return Number(r.lastInsertRowid);
}

function dedup(elderId, kind, hours) {
  return get('SELECT id FROM alerts WHERE elder_id=? AND kind=? AND created_at>?',
    elderId, kind, now() - hours * 3600e3);
}

// 生命体征入库时即时校验
function checkVital(elderId, type, value) {
  const t = THRESHOLDS[type];
  if (!t) return null;
  if (value > t.high || value < t.low) {
    if (dedup(elderId, 'vital_' + type, 6)) return null;
    const dir = value > t.high ? '偏高' : '偏低';
    const level = (type === 'spo2' || type === 'heart_rate') ? 'critical' : 'warning';
    return raise(elderId, level, 'vital_' + type,
      `${userName(elderId)} ${t.label} ${value}${t.unit} ${dir}（参考 ${t.low}-${t.high}），请及时关注`);
  }
  return null;
}

// 保证今天的用药计划生成 med_logs
function ensureTodayLogs(elderId) {
  const today = todayStr(), hm = nowHM();
  for (const med of all('SELECT * FROM meds WHERE elder_id=? AND active=1', elderId)) {
    let times = ['08:00'];
    try { times = JSON.parse(med.times); } catch {}
    for (const time of times) {
      if (!get('SELECT id FROM med_logs WHERE med_id=? AND date=? AND time=?', med.id, today, time)) {
        run('INSERT INTO med_logs(elder_id,med_id,date,time,status) VALUES(?,?,?,?,?)',
          elderId, med.id, today, time, 'pending');
      }
    }
  }
}

function minusMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  let tot = h * 60 + m - mins;
  tot = ((tot % 1440) + 1440) % 1440;
  return `${pad(Math.floor(tot / 60))}:${pad(tot % 60)}`;
}

// 定时扫描：无活动 12h / 2 天未出门 / 漏服 2 次 / 过期未打卡药 → missed
function sweep() {
  const t = now();
  const today = todayStr();
  const cutoff = minusMinutes(nowHM(), 30);
  for (const l of all("SELECT * FROM med_logs WHERE status='pending' AND date<=?", today)) {
    if (l.date < today || l.time < cutoff) run("UPDATE med_logs SET status='missed' WHERE id=?", l.id);
  }
  for (const e of all("SELECT id FROM users WHERE role='elder'")) {
    const eid = e.id;
    if (!familyOf(eid)) continue;
    const hasDevice = get('SELECT COUNT(*) c FROM devices WHERE elder_id=?', eid).c > 0;
    if (hasDevice) {
      const lastSig = get(
        'SELECT MAX(m) m FROM (SELECT MAX(ts) m FROM vitals WHERE elder_id=? UNION ALL SELECT MAX(ts) FROM events WHERE elder_id=?)',
        eid, eid)?.m;
      if (lastSig && t - lastSig > 12 * 3600e3 && !dedup(eid, 'no_activity', 24)) {
        raise(eid, 'critical', 'no_activity',
          `${userName(eid)} 已超过 12 小时未检测到活动信号，请立即联系确认安全`);
      }
    }
    const lastDoor = get("SELECT MAX(ts) m FROM events WHERE elder_id=? AND kind IN('door_in','door_out')", eid)?.m;
    if (lastDoor && t - lastDoor > 48 * 3600e3 && !dedup(eid, 'no_outing', 48)) {
      raise(eid, 'info', 'no_outing', `${userName(eid)} 已连续 2 天未出门，可能需要关注`);
    }
    const d0 = fmtDate(new Date(t - 48 * 3600e3));
    const missed = get("SELECT COUNT(*) c FROM med_logs WHERE elder_id=? AND status='missed' AND date>=?", eid, d0).c;
    if (missed >= 2 && !dedup(eid, 'med_missed', 24)) {
      raise(eid, 'warning', 'med_missed', `${userName(eid)} 近 48 小时漏服药物 ${missed} 次，请跟进提醒`);
    }
  }
}

module.exports = { THRESHOLDS, checkVital, raise, sweep, ensureTodayLogs, todayStr, nowHM, fmtDate, dedup };
