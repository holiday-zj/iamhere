// seed.js — 演示数据：李家（子女×2 + 父母×2）+ 陪诊师 + 设备 + 用药 + 任务/费用
'use strict';
const D = require('./db');
const { run, get, all, now, hashPass } = D;
const alerts = require('./alerts');

if (get("SELECT id FROM users WHERE phone='13800000001'")) {
  console.log('已有种子数据，跳过。删除 data/zaishenbian.db 可重置。');
  process.exit(0);
}

function user(phone, name, role, extra = {}) {
  const r = run('INSERT INTO users(phone,pass_hash,name,role,rel,age,avatar,health_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    phone, hashPass('123456'), name, role, extra.rel || '', extra.age || 0, extra.avatar || '🙂',
    JSON.stringify(extra.health || {}), now());
  return Number(r.lastInsertRowid);
}

const ming = user('13800000001', '李明', 'child', { rel: '儿子' });
const hong = user('13800000002', '李红', 'child', { rel: '女儿' });
const dad = user('13800000003', '李建国', 'elder', {
  rel: '爸爸', age: 73, avatar: '👨‍🦳',
  health: { conditions: ['高血压2级', '2型糖尿病'], allergies: ['青霉素'], address: '长沙市雨花区XX小区3栋502', note: '每日早晚测血压' },
});
const mom = user('13800000004', '王秀兰', 'elder', {
  rel: '妈妈', age: 69, avatar: '👩‍🦳',
  health: { conditions: ['骨质疏松'], allergies: [], address: '长沙市雨花区XX小区3栋502' },
});
const provider = user('13900000001', '王陪诊', 'provider');
run('INSERT INTO provider_profiles(user_id,city,specialties,rating,jobs) VALUES(?,?,?,?,?)',
  provider, '长沙', JSON.stringify(['accompany_half', 'accompany_full', 'med_pickup', 'errand', 'bath', 'cleaning', 'meal', 'rehab', 'repair', 'psych']), 4.9, 128);

const f = run('INSERT INTO families(name,city,plan,created_by,created_at) VALUES(?,?,?,?,?)', '李家', '长沙', 'premium', ming, now());
const fid = Number(f.lastInsertRowid);
for (const u of [ming, hong, dad, mom]) run('INSERT INTO family_members(family_id,user_id,joined_at) VALUES(?,?,?)', fid, u, now());

// 设备
function dev(eid, type, name) { run('INSERT INTO devices(family_id,elder_id,type,name,last_ts) VALUES(?,?,?,?,?)', fid, eid, type, name, now()); }
dev(dad, 'watch', '智能手表'); dev(dad, 'door', '智能门磁'); dev(dad, 'bp', '血压计'); dev(dad, 'pillbox', '智能药盒');
dev(mom, 'watch', '智能手表'); dev(mom, 'radar', '毫米波雷达');

// 用药
run("INSERT INTO meds(elder_id,name,dose,times) VALUES(?,?,?,?)", dad, '苯磺酸氨氯地平', '5mg 1片', JSON.stringify(['08:00']));
run("INSERT INTO meds(elder_id,name,dose,times) VALUES(?,?,?,?)", dad, '二甲双胍', '0.5g 1片', JSON.stringify(['08:00', '18:00']));
run("INSERT INTO meds(elder_id,name,dose,times) VALUES(?,?,?,?)", mom, '碳酸钙D3', '1片', JSON.stringify(['12:00']));
alerts.ensureTodayLogs(dad); alerts.ensureTodayLogs(mom);

// 近 7 天体征数据
const day = 86400e3;
for (let i = 6; i >= 0; i--) {
  const base = now() - i * day;
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', dad, base - 3 * 3600e3, 'heart_rate', 70 + Math.round(Math.random() * 8), 'device');
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', dad, base - 3 * 3600e3, 'systolic', 132 + Math.round(Math.random() * 14), 'device');
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', dad, base - 3 * 3600e3, 'diastolic', 80 + Math.round(Math.random() * 8), 'device');
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', dad, base - 2 * 3600e3, 'steps', 2500 + Math.round(Math.random() * 2500), 'device');
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', dad, base - 1 * 3600e3, 'sleep', Math.round((5.8 + Math.random()) * 10) / 10, 'device');
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', mom, base - 3 * 3600e3, 'heart_rate', 66 + Math.round(Math.random() * 6), 'device');
  run('INSERT INTO vitals(elder_id,ts,type,value,source) VALUES(?,?,?,?,?)', mom, base - 2 * 3600e3, 'steps', 4000 + Math.round(Math.random() * 2000), 'device');
  run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', dad, base - 4 * 3600e3, 'door_out', JSON.stringify({ loc: '小区花园' }));
  run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', dad, base - 3 * 3600e3, 'door_in', '{}');
  run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', mom, base - 5 * 3600e3, 'door_out', JSON.stringify({ loc: '菜市场' }));
  run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', mom, base - 4 * 3600e3, 'door_in', '{}');
  run('INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)', mom, base - 4 * 3600e3, 'checkin', '{}');
}
run("INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)", dad, now() - 20 * 3600e3, 'contact', JSON.stringify({ type: '视频通话' }));
run("INSERT INTO events(elder_id,ts,kind,data) VALUES(?,?,?,?)", mom, now() - 2 * 3600e3, 'checkin', '{}');

// 家庭协同示例
run('INSERT INTO tasks(family_id,elder_id,title,detail,due_date,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
  fid, dad, '下周三陪爸爸复诊（心内科）', '带上上次的检查单', '', 'open', ming, now() - 2 * day);
run('INSERT INTO tasks(family_id,title,due_date,status,claimed_by,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
  fid, '给妈妈买冬季棉鞋（39码）', '', 'claimed', hong, hong, now() - day);
run('INSERT INTO duty(family_id,user_id,date,note) VALUES(?,?,?,?)', fid, ming, alerts.todayStr(), '晚饭后打电话');
run('INSERT INTO expenses(family_id,title,category,amount,paid_by,split,created_at) VALUES(?,?,?,?,?,?,?)', fid, '爸爸降压药（3个月量）', '药品', 286, ming, 'aa', now() - 5 * day);
run('INSERT INTO expenses(family_id,title,category,amount,paid_by,split,created_at) VALUES(?,?,?,?,?,?,?)', fid, '妈妈骨质疏松复查', '医疗', 420, hong, 'aa', now() - 3 * day);
const v = run('INSERT INTO votes(family_id,title,options,deadline,created_by,created_at) VALUES(?,?,?,?,?,?)',
  fid, '春节谁回老家陪父母？', JSON.stringify(['李明一家回', '李红一家回', '接父母来深圳']), now() + 30 * day, ming, now() - day);
run('INSERT INTO vote_records(vote_id,user_id,choice) VALUES(?,?,?)', Number(v.lastInsertRowid), hong, '接父母来深圳');
run('INSERT INTO timeline(family_id,ts,type,summary) VALUES(?,?,?,?)', fid, now() - 6 * day, 'family', '李明 创建了家庭圈「李家」');
run('INSERT INTO timeline(family_id,ts,type,summary) VALUES(?,?,?,?)', fid, now() - 6 * day, 'family', '李红、李建国、王秀兰 加入家庭圈');

// 档案示例
run('INSERT INTO reports(elder_id,title,ts,summary,created_by) VALUES(?,?,?,?,?)', dad, '2026-10 市一院心内科就诊',
  now() - 20 * day, '诊断：高血压2级（中危）。医嘱：继续氨氯地平 5mg qd，低盐饮食，每日家庭血压监测，1个月后复诊。', ming);

// 一个已完成订单 + 一个待接单
require('./dispatch');
const o1 = run('INSERT INTO orders(family_id,elder_id,service_type,provider_id,scheduled_at,location,price,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  fid, mom, 'errand', provider, now() - 2 * day, '菜市场', 30, 'done', ming, now() - 3 * day);
run('UPDATE orders SET rating=5, review=? WHERE id=?', '王师傅很热心，帮妈妈把菜送上楼', o1.lastInsertRowid);
run('INSERT INTO orders(family_id,elder_id,service_type,provider_id,scheduled_at,location,notes,price,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  fid, dad, 'accompany_half', provider, now() + 2 * day, '湘雅医院 心内科', '复诊，需带既往病历', 238, 'assigned', ming, now());
run('INSERT INTO provider_updates(order_id,ts,text) VALUES(?,?,?)', Number(o1.lastInsertRowid), now() - 2 * day, '服务完成：已送老人回家');

// 通知
D.notify(ming, fid, '👋 欢迎使用在身边', '演示账号已就绪：状态大屏、SOS、陪诊下单、家庭协同均可体验', 'family');

console.log('✅ 种子数据完成。演示账号（密码均为 123456）：');
console.log('  子女·李明 13800000001 ｜ 子女·李红 13800000002');
console.log('  父亲·李建国 13800000003 ｜ 母亲·王秀兰 13800000004');
console.log('  陪诊师·王陪诊 13900000001');
