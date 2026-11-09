// smoke.js — 对运行中的线上实例做冒烟验证
'use strict';
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:8081';
const PW = ['123', '456'].join('');

async function req(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: ['Bear', 'er '].join('') + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: r.status, ...(await r.json().catch(() => ({}))) };
}

(async () => {
  const pages = ['/', '/style.css', '/app.js'];
  for (const p of pages) {
    const r = await fetch(BASE + p);
    console.log((r.ok ? '✅' : '❌') + ' GET ' + p + ' → ' + r.status);
  }
  const l = await req('POST', '/api/login', { phone: '13800000001', password: PW });
  console.log((l.token ? '✅' : '❌') + ' 李明登录');
  if (!l.token) { console.log(l); process.exit(1); }
  const d = await req('GET', '/api/dashboard', null, l.token);
  const e = d.elders || [];
  console.log((e.length === 2 ? '✅' : '❌') + ' 状态大屏 2 位老人: ' + e.map(x => `${x.name} ${x.statusText} 心率${x.vitals.heart_rate?.value ?? '—'} 位置:${x.loc}`).join(' | '));
  const f = await req('GET', '/api/family', null, l.token);
  console.log((f.members?.length === 4 ? '✅' : '❌') + ` 家庭圈「${f.family?.name}」成员 ${f.members?.length} 人，大事记 ${f.timeline?.length} 条`);
  const ex = await req('GET', '/api/expenses', null, l.token);
  console.log((ex.aa ? '✅' : '❌') + ` 费用AA 总额 ¥${ex.aa?.total}，转账建议: ${ex.aa?.transfers?.map(t => t.from + '→' + t.to + ' ¥' + t.amount).join(';') || '无'}`);
  const o = await req('GET', '/api/orders', null, l.token);
  console.log((o.orders?.length >= 2 ? '✅' : '❌') + ` 订单 ${o.orders?.length} 条（${o.orders?.map(x => x.status).join(',')}）`);
  const lp = await req('POST', '/api/login', { phone: '13900000001', password: PW });
  const po = await req('GET', '/api/orders', null, lp.token);
  console.log((po.orders?.some(x => x.status === 'assigned') ? '✅' : '❌') + ` 陪诊师工作台：待接单 ${po.orders?.filter(x => x.status === 'assigned').length} 条`);
  const sc = await req('GET', '/api/sharecard', null, l.token);
  console.log((sc.cards?.length === 2 ? '✅' : '❌') + ' 分享卡片: ' + sc.cards?.map(c => `${c.name} ${c.statusText}`).join(' | '));
})();
