// api-test.js — 全流程 API 测试（注册→家庭→大屏→预警→SOS分级→下单派单→协同→AA）
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.TEST_PORT || 8099);
process.env.DATA_DIR = path.join(__dirname, '..', 'data', 'test-' + Date.now());
process.env.PORT = String(PORT);
process.env.SWEEP_MS = '300';
process.env.SOS_TIME_SCALE = '0.01'; // 应急升级时间 ×0.01：L1=0.6s L2=1.8s L3=3s

const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: ['Bear','er '].join('') + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  return { code: res.status, ...j };
}
async function reg(phone, name, role, extra = {}) {
  const r = await req('POST', '/api/register', { phone, password: 'test123456', name, role, ...extra });
  if (r.error) throw new Error('register ' + name + ': ' + r.error);
  const l = await req('POST', '/api/login', { phone, password: 'test123456' });
  return { token: l.token, id: l.user.id, name };
}

(async () => {
  require('../server/index.js');
  await sleep(600);

  console.log('\n[1] 注册与家庭圈');
  const dad = await reg('15000000001', '张父', 'elder');
  const sis = await reg('15000000002', '张姐', 'child');
  const bro = await reg('15000000003', '张弟', 'child');
  const pz = await reg('15000000009', '陈陪诊', 'provider', { city: '长沙', specialties: ['accompany_half', 'errand', 'bath', 'med_pickup'] });
  ok('四种角色注册', !!(dad.token && sis.token && bro.token && pz.token));

  const cf = await req('POST', '/api/family', { name: '张家', city: '长沙' }, sis.token);
  ok('创建家庭圈', cf.id > 0, cf);
  const inv = await req('POST', '/api/family/invite', {}, sis.token);
  ok('生成邀请码', !!inv.code, inv);
  const jb = await req('POST', '/api/family/join', { code: inv.code }, bro.token);
  ok('弟弟用邀请码加入', jb.family === '张家', jb);
  const bind = await req('POST', '/api/family/bind', { phone: '15000000001' }, sis.token);
  ok('绑定已注册的父亲', bind.bound === true, bind);
  const fam = await req('GET', '/api/family', null, sis.token);
  ok('家庭圈 3 成员+1 老人', fam.members.length === 3 && fam.elders.length === 1, fam.members?.length);

  console.log('\n[2] 状态大屏：设备上报 + 打卡 + 门磁');
  const devW = await req('POST', '/api/devices', { elder_id: dad.id, type: 'watch' }, sis.token);
  ok('添加手表设备', devW.id > 0, devW);
  const push = await req('POST', `/api/devices/${devW.id}/push`, { data: { heart_rate: 75, spo2: 97, steps: 3200, sleep: 6.2 } }, sis.token);
  ok('手表数据上报', push.pushed.length === 4, push);
  await req('POST', '/api/vitals', { elder_id: dad.id, type: 'systolic', value: 138 }, sis.token);
  await req('POST', '/api/vitals', { elder_id: dad.id, type: 'diastolic', value: 85 }, sis.token);
  await req('POST', '/api/events', { elder_id: dad.id, kind: 'door_out', data: { loc: '菜市场' } }, sis.token);
  await req('POST', '/api/events', { elder_id: dad.id, kind: 'checkin' }, dad.token);
  const dash = await req('GET', '/api/dashboard', null, sis.token);
  const e = dash.elders[0];
  ok('大屏心率=75', e.vitals.heart_rate?.value === 75, e.vitals);
  ok('大屏血压 138/85', e.vitals.bp?.sys?.value === 138, e.vitals.bp);
  ok('位置=外出中(菜市场)', e.loc.includes('菜市场'), e.loc);
  ok('老人打卡时间存在', !!e.lastCheckin, e);
  ok('大屏有打卡通知给子女', (await req('GET', '/api/notifications', null, bro.token)).notifications.some(n => n.kind === 'checkin'));
  const share = await req('GET', '/api/sharecard', null, sis.token);
  ok('脱敏分享卡片生成', share.cards[0].name.includes('*') && !!share.hook, share.cards?.[0]);

  console.log('\n[3] 预警引擎：阈值触发');
  const hv = await req('POST', '/api/vitals', { elder_id: dad.id, type: 'systolic', value: 165 }, sis.token);
  await sleep(100);
  const dash2 = await req('GET', '/api/dashboard', null, sis.token);
  const e2 = dash2.elders[0];
  ok('血压165→预警产生', e2.alerts.some(a => a.kind === 'vital_systolic'), e2.alerts);
  ok('状态变为 warning/critical', ['warning', 'critical'].includes(e2.status), e2.status);
  const ackA = await req('POST', `/api/alerts/${e2.alerts[0].id}/ack`, {}, sis.token);
  ok('预警可确认', ackA.ok === true, ackA);
  // 用药：00:05 的药已过宽限期 → missed；23:55 的药 → pending 可打卡
  await req('POST', '/api/meds', { elder_id: dad.id, name: '降压药', dose: '1片', times: ['00:05'] }, sis.token);
  await req('POST', '/api/meds', { elder_id: dad.id, name: '钙片', dose: '1片', times: ['23:55'] }, sis.token);
  await sleep(1200); // sweep 将 00:05 的 pending 标为 missed（已过 30 分钟宽限）
  const meds = await req('GET', '/api/meds?elder_id=' + dad.id, null, sis.token);
  const missed = meds.today.filter(m => m.status === 'missed');
  ok('过期未服药→missed', missed.length >= 1, meds.today);
  const takeable = meds.today.find(m => m.status === 'pending');
  ok('存在待服药项', !!takeable, meds.today.map(m => m.status));
  if (takeable) {
    await req('POST', `/api/meds/${takeable.id}/take`, {}, dad.token);
    const m2 = await req('GET', '/api/meds?elder_id=' + dad.id, null, sis.token);
    ok('老人打卡服药→taken', m2.today.find(m => m.id === takeable.id).status === 'taken');
  } else ok('老人打卡服药→taken', false, '无可打卡项');

  console.log('\n[4] SOS 四级分级响应');
  const sosR = await req('POST', '/api/sos', { trigger: 'button' }, dad.token);
  ok('老人触发SOS', sosR.sos_id > 0, sosR);
  let s = await req('GET', '/api/sos/' + sosR.sos_id, null, sis.token);
  ok('L1 状态+语音确认日志', s.sos.status === 'level1' && s.sos.log.some(l => l.text.includes('语音确认')), s.sos.status);
  ok('子女收到SOS推送', (await req('GET', '/api/notifications', null, bro.token)).notifications.some(n => n.kind === 'sos'));
  ok('应急信息卡完整', s.sos.card.meds.length >= 0 && s.sos.card.contacts.length === 2, s.sos.card?.contacts);
  await sleep(1300);
  s = await req('GET', '/api/sos/' + sosR.sos_id, null, sis.token);
  ok('60s无回应→升级L2（测试加速）', s.sos.status === 'level2', s.sos.status);
  const ack = await req('POST', `/api/sos/${sosR.sos_id}/ack`, {}, sis.token);
  ok('姐姐响应"我来处理"', ack.ok === true, ack);
  await sleep(1300);
  s = await req('GET', '/api/sos/' + sosR.sos_id, null, sis.token);
  ok('子女已响应→暂停升级（仍L2）', s.sos.status === 'level2', s.sos.status);
  const res1 = await req('POST', `/api/sos/${sosR.sos_id}/resolve`, { note: '父亲只是头晕已休息' }, sis.token);
  ok('解除应急', res1.ok === true, res1);
  // 升级链完整跑一遍：新SOS不ack → L2→L3→L4
  const sos2 = await req('POST', '/api/sos', { elder_id: dad.id, trigger: 'child_manual' }, bro.token);
  await sleep(1200); // L2
  await sleep(2200); // L3
  let s2 = await req('GET', '/api/sos/' + sos2.sos_id, null, sis.token);
  ok('无响应升级至 L3（社区上门）', s2.sos.status === 'level3', s2.sos.status);
  await sleep(3200); // L4
  s2 = await req('GET', '/api/sos/' + sos2.sos_id, null, sis.token);
  ok('继续无响应升级至 L4（呼叫120）', s2.sos.status === 'level4', s2.sos.status);
  ok('全家收到L4通知', (await req('GET', '/api/notifications', null, sis.token)).notifications.some(n => n.title.includes('L4')));
  await req('POST', `/api/sos/${sos2.sos_id}/resolve`, { note: '120到场无大碍' }, sis.token);
  // 跌倒检测自动触发
  const fallPush = await req('POST', `/api/devices/${devW.id}/push`, { data: { fall: true } }, sis.token);
  ok('手表跌倒检测→自动SOS', fallPush.pushed.some(p => p.includes('跌倒')), fallPush);
  const activeSos = (await req('GET', '/api/sos', null, sis.token)).active;
  ok('跌倒SOS活跃', activeSos.length === 1, activeSos.length);
  const c = await req('POST', `/api/sos/${activeSos[0].id}/cancel`, {}, dad.token);
  ok('老人本人取消（我没事）', c.ok === true, c);
  const c2 = await req('POST', `/api/sos/${activeSos[0].id}/cancel`, {}, sis.token);
  ok('非本人不可取消（返回错误）', !!c2.error, c2);

  console.log('\n[5] 陪诊下单 → 派单 → 服务 → 评价 → 医嘱归档');
  const o = await req('POST', '/api/orders', { service_type: 'accompany_half', elder_id: dad.id, scheduled_at: Date.now() + 86400e3, location: '湘雅医院 心内科' }, sis.token);
  ok('子女下单陪诊', o.id > 0 && o.need_review === false, o);
  let od = await req('GET', '/api/orders/' + o.id, null, sis.token);
  ok('派单引擎匹配同城高分陪诊师', od.order.provider_id === pz.id && od.order.status === 'assigned', od.order.status);
  const acc = await req('POST', `/api/orders/${o.id}/accept`, {}, pz.token);
  ok('陪诊师接单', acc.ok === true, acc);
  await req('POST', `/api/orders/${o.id}/progress`, { text: '已到老人家楼下，陪同前往医院' }, pz.token);
  await req('POST', `/api/orders/${o.id}/progress`, { text: '候诊中，前面还有3人' }, pz.token);
  od = await req('GET', '/api/orders/' + o.id, null, sis.token);
  ok('子女实时看到2条进展', od.updates.length >= 3, od.updates.length); // 接单+2进展
  const comp = await req('POST', `/api/orders/${o.id}/complete`, { summary: '顺利完成', doctor_note: '医嘱：继续服药，2周后复查心电图' }, pz.token);
  ok('服务完成', comp.ok === true, comp);
  const reps = await req('GET', '/api/reports?elder_id=' + dad.id, null, sis.token);
  ok('医嘱自动归档到医疗档案', reps.reports.some(r => r.title.includes('陪诊归档')), reps.reports);
  const rate = await req('POST', `/api/orders/${o.id}/rate`, { rating: 5, review: '非常专业' }, sis.token);
  ok('子女评价成功', rate.ok === true, rate);
  const prof = await req('GET', '/api/provider/profile', null, pz.token);
  ok('陪诊师评分更新', prof.profile.rating === 5 && prof.profile.jobs === 1, prof.profile);

  console.log('\n[6] 老人自主下单 + 子女审核机制');
  const oSmall = await req('POST', '/api/orders', { service_type: 'errand', scheduled_at: Date.now() + 3600e3 }, dad.token);
  ok('老人小额下单→直接派单(事后通知)', oSmall.need_review === false, oSmall);
  const oBig = await req('POST', '/api/orders', { service_type: 'accompany_full', scheduled_at: Date.now() + 2 * 86400e3 }, dad.token);
  ok('老人大额下单→需子女审核', oBig.need_review === true, oBig);
  let oBigD = await req('GET', '/api/orders/' + oBig.id, null, sis.token);
  ok('订单状态 awaiting_review', oBigD.order.status === 'awaiting_review', oBigD.order.status);
  ok('子女收到审核通知', (await req('GET', '/api/notifications', null, bro.token)).notifications.some(n => n.title.includes('父母发起服务请求')));
  const rv = await req('POST', `/api/orders/${oBig.id}/review`, { approve: true }, sis.token);
  ok('子女同意→自动派单', rv.status === 'assigned', rv);
  const rvBad = await req('POST', `/api/orders/${oBig.id}/review`, { approve: true }, bro.token);
  ok('重复审核被拒绝', !!rvBad.error, rvBad);
  // 弟弟无权限给外部老人下单
  const oBad = await req('POST', '/api/orders', { service_type: 'errand', elder_id: 99999 }, bro.token);
  ok('不能为圈外老人下单', !!oBad.error, oBad);

  console.log('\n[7] 家庭协同：任务/投票/费用AA');
  const t = await req('POST', '/api/tasks', { title: '下周三陪爸爸复诊', due_date: '2026-11-12' }, sis.token);
  ok('发布任务', t.id > 0, t);
  await req('POST', `/api/tasks/${t.id}/claim`, {}, bro.token);
  const tl = await req('GET', '/api/tasks', null, sis.token);
  ok('弟弟认领任务', tl.tasks.find(x => x.id === t.id).status === 'claimed');
  const dup = await req('POST', `/api/tasks/${t.id}/claim`, {}, sis.token);
  ok('重复认领被拒', !!dup.error, dup);
  await req('POST', `/api/tasks/${t.id}/done`, {}, bro.token);
  ok('任务完成', (await req('GET', '/api/tasks', null, sis.token)).tasks.find(x => x.id === t.id).status === 'done');

  const v1 = await req('POST', '/api/votes', { title: '是否请护工', options: ['请住家护工', '请钟点工', '暂不请'] }, sis.token);
  ok('发起投票', v1.id > 0, v1);
  await req('POST', `/api/votes/${v1.id}/cast`, { choice: '请钟点工' }, sis.token);
  const castBad = await req('POST', `/api/votes/${v1.id}/cast`, { choice: '不存在的选项' }, bro.token);
  ok('非法选项被拒', !!castBad.error, castBad);
  const cast2 = await req('POST', `/api/votes/${v1.id}/cast`, { choice: '请钟点工' }, bro.token);
  ok('全员投票→自动结束', cast2.closed === true, cast2);
  const vl = await req('GET', '/api/votes', null, sis.token);
  ok('投票状态 closed', vl.votes[0].status === 'closed', vl.votes[0].status);

  await req('POST', '/api/expenses', { title: '爸爸药费', amount: 300, category: '药品' }, sis.token);
  await req('POST', '/api/expenses', { title: '妈妈复查', amount: 200, category: '医疗' }, bro.token);
  const exp = await req('GET', '/api/expenses', null, sis.token);
  ok('AA总额=500', exp.aa.total === 500, exp.aa.total);
  // 姐付300弟付200，各摊250 → 姐应收50 弟应付50
  ok('AA结算建议：弟→姐 ¥50', exp.aa.transfers.length === 1 && exp.aa.transfers[0].amount === 50 && exp.aa.transfers[0].to === '张姐', exp.aa.transfers);

  console.log('\n[8] 权限与边界');
  const noAuth = await req('GET', '/api/dashboard', null);
  ok('未登录访问被拒(401)', noAuth.code === 401, noAuth.code);
  const badLogin = await req('POST', '/api/login', { phone: '15000000002', password: 'wrong' });
  ok('错误密码登录失败', badLogin.code === 401, badLogin.code);
  const dupReg = await req('POST', '/api/register', { phone: '15000000001', password: 'test123456', name: '重复', role: 'child' });
  ok('重复注册被拒', !!dupReg.error, dupReg);
  const badPhone = await req('POST', '/api/register', { phone: '123', password: 'test123456', name: 'x', role: 'child' });
  ok('非法手机号被拒', !!badPhone.error, badPhone);
  const outsider = await reg('15000000077', '路人', 'child');
  const peek = await req('GET', '/api/vitals?elder_id=' + dad.id, null, outsider.token);
  ok('外人不能看老人数据(403)', peek.code === 403, peek.code);
  const fakeSos = await req('POST', '/api/sos/' + sosR.sos_id + '/resolve', {}, outsider.token);
  ok('外人不能操作应急(403/400)', !!fakeSos.error, fakeSos);
  const elderOther = await req('POST', '/api/vitals', { elder_id: sis.id, type: 'heart_rate', value: 80 }, dad.token);
  ok('老人不能替他人上报', !!elderOther.error, elderOther);

  console.log('\n[9] AI 档案解读 + 会员');
  const rp = await req('POST', '/api/reports', { elder_id: dad.id, title: '2026年度体检', summary: '血压偏高' }, sis.token);
  const ai = await req('POST', `/api/reports/${rp.id}/ai`, {}, sis.token);
  ok('AI白话解读生成', ai.ai_note.includes('白话版') && ai.ai_note.includes('血压'), ai.ai_note?.slice(0, 60));
  const plan = await req('POST', '/api/family/plan', { plan: 'elite' }, sis.token);
  ok('会员升级尊享版', plan.plan === 'elite', plan);
  const planBad = await req('POST', '/api/family/plan', { plan: 'elite' }, dad.token);
  ok('老人不能改会员(403)', !!planBad.error, planBad);

  console.log(`\n════ 结果: ${pass} 通过, ${fail} 失败 ════`);
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
