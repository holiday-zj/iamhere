// dispatch.js — 派单引擎：就近（同城）+ 评分 + 专长匹配（PRD 模块三/七）
'use strict';
const { all, get, run, now, notify, notifyChildren, addTimeline, userName } = require('./db');

const SERVICES = {
  accompany_half: { label: '半日陪诊(4h内)', price: 238, review: 1 },
  accompany_full: { label: '全日陪诊(8h内)', price: 398, review: 1 },
  med_pickup:     { label: '复诊代取药', price: 98, review: 0 },
  bath:           { label: '助浴上门', price: 120, review: 1 },
  cleaning:       { label: '助洁/家政', price: 90, review: 0 },
  meal:           { label: '助餐配送', price: 25, review: 0 },
  rehab:          { label: '康复理疗', price: 180, review: 1 },
  errand:         { label: '代跑腿/买菜', price: 30, review: 0 },
  repair:         { label: '家修上门', price: 60, review: 0 },
  psych:          { label: '心理慰藉/陪聊', price: 80, review: 1 },
};
const label = t => (SERVICES[t] ? SERVICES[t].label : t);
const price = t => (SERVICES[t] ? SERVICES[t].price : 0);

function dispatch(orderId) {
  const o = get('SELECT * FROM orders WHERE id=?', orderId);
  if (!o) return null;
  const fam = get('SELECT city FROM families WHERE id=?', o.family_id);
  const city = fam?.city || '长沙';
  const cands = all(
    'SELECT p.*, u.name FROM provider_profiles p JOIN users u ON u.id=p.user_id WHERE p.online=1 AND p.city=?',
    city
  ).filter(p => {
    let sp = []; try { sp = JSON.parse(p.specialties || '[]'); } catch {}
    return sp.includes(o.service_type);
  }).sort((a, b) => (b.rating - a.rating) || (a.jobs - b.jobs));

  if (!cands.length) {
    run("UPDATE orders SET status='manual' WHERE id=?", orderId);
    notifyChildren(o.family_id, '📋 暂无可接单人员',
      `「${label(o.service_type)}」订单已转平台客服人工跟进，抱歉让您久等`, 'order');
    return null;
  }
  const best = cands[0];
  run("UPDATE orders SET provider_id=?, status='assigned' WHERE id=?", best.user_id, orderId);
  notify(best.user_id, o.family_id, '🧾 新派单',
    `${label(o.service_type)}｜${new Date(o.scheduled_at).toLocaleString('zh-CN')}｜${o.location || '见备注'}，请尽快接单`, 'order');
  notifyChildren(o.family_id, '✅ 已匹配服务人员',
    `「${label(o.service_type)}」已匹配 ${best.name}（评分 ${best.rating.toFixed(1)}，服务 ${best.jobs} 单），等待接单`, 'order');
  addTimeline(o.family_id, o.elder_id, 'order', `下单「${label(o.service_type)}」，匹配 ${best.name}`);
  return best.user_id;
}

module.exports = { dispatch, SERVICES, label, price };
