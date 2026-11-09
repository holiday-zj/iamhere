/* 在身边 — Web 前端（子女端 / 老人端 / 服务商端 三合一 SPA，零依赖） */
'use strict';
const $app = document.getElementById('app');
let S = { token: localStorage.getItem('zsb_token') || null, me: null, family: null, tab: 'home', role_view: null };
const H = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtT = ts => ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtHM = ts => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';

async function api(path, method, body) {
  const r = await fetch(path, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: ['Bear','er '].join('') + S.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || '请求失败'); e.code = r.status; throw e; }
  return j;
}
function toast(msg, ms) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms || 2400);
}
function sheet(title, innerHTML, onMount) {
  closeSheet();
  const mask = document.createElement('div');
  mask.className = 'sheet-mask';
  mask.innerHTML = `<div class="sheet"><h3>${title}</h3>${innerHTML}</div>`;
  mask.addEventListener('click', e => { if (e.target === mask) closeSheet(); });
  document.body.appendChild(mask);
  if (onMount) onMount(mask);
  return mask;
}
function closeSheet() { document.querySelectorAll('.sheet-mask').forEach(e => e.remove()); }

/* ================= 渲染入口 ================= */
async function boot() {
  if (S.token) {
    try {
      const me = await api('/api/me');
      S.me = me.user; S.family = me.family;
      S.role_view = localStorage.getItem('zsb_view_' + S.me.id) || (S.me.role === 'elder' ? 'elder' : S.me.role);
    } catch { S.token = null; localStorage.removeItem('zsb_token'); }
  }
  // 邀请码直达
  const inv = new URLSearchParams(location.search).get('invite');
  if (inv && S.me && !S.family) {
    try { const r = await api('/api/family/join', 'POST', { code: inv }); toast('已加入「' + r.family + '」'); refreshFamily(); } catch (e) { toast(e.message); }
    history.replaceState({}, '', '/');
  }
  render();
  setInterval(pollLoop, 8000);
}
async function refreshFamily() {
  try { const me = await api('/api/me'); S.me = me.user; S.family = me.family; } catch {}
}
async function pollLoop() {
  if (!S.token) return;
  try {
    const n = await api('/api/notifications');
    const badge = document.getElementById('ntfBadge');
    if (badge) { badge.textContent = n.unread > 99 ? '99+' : n.unread; badge.style.display = n.unread ? 'flex' : 'none'; }
    // 活跃 SOS → 老人端/子女端强制弹层
    if (S.family) {
      const sos = await api('/api/sos');
      const active = sos.active || [];
      if (active.length && !document.getElementById('sosOverlay')) openSosOverlay(active[0].id);
      if (!active.length && document.getElementById('sosOverlay') && !S._sosManual) document.getElementById('sosOverlay').remove();
    }
  } catch {}
}
function render() {
  document.body.classList.toggle('elder-mode', S.role_view === 'elder');
  if (!S.me) return renderAuth();
  if (S.role_view === 'elder') return renderElder();
  if (S.role_view === 'provider') return renderProvider();
  return renderChild();
}

/* ================= 登录/注册 ================= */
let authMode = 'login', authRole = 'child';
function renderAuth() {
  const invite = new URLSearchParams(location.search).get('invite');
  $app.innerHTML = `
  <div class="auth-wrap">
    <div class="auth-logo">🏡</div>
    <div class="auth-title">在身边</div>
    <div class="auth-slogan">你不在身边的日子，让爱替你在。</div>
    <div class="auth-card">
      <div class="seg">
        <button id="mLogin" class="${authMode === 'login' ? 'on' : ''}">登录</button>
        <button id="mReg" class="${authMode === 'reg' ? 'on' : ''}">注册</button>
      </div>
      <div id="authForm"></div>
    </div>
    <div class="auth-foot">演示提示：注册后请创建/加入家庭圈体验完整功能${invite ? '<br>您收到邀请码 <b>' + H(invite) + '</b>，注册登录后自动加入' : ''}</div>
  </div>`;
  document.getElementById('mLogin').onclick = () => { authMode = 'login'; renderAuth(); };
  document.getElementById('mReg').onclick = () => { authMode = 'reg'; renderAuth(); };
  const form = document.getElementById('authForm');
  if (authMode === 'login') {
    form.innerHTML = `
      <label class="f">手机号</label><input id="aPhone" type="tel" maxlength="11" placeholder="11 位手机号">
      <label class="f">密码</label><input id="aPass" type="password" placeholder="密码">
      <div style="margin-top:18px"><button class="btn" style="width:100%" id="aGo">登 录</button></div>`;
    document.getElementById('aGo').onclick = doLogin;
  } else {
    form.innerHTML = `
      <div class="seg" style="margin-top:0">
        <button data-r="child" class="${authRole === 'child' ? 'on' : ''}">我是子女</button>
        <button data-r="elder" class="${authRole === 'elder' ? 'on' : ''}">我是老人</button>
        <button data-r="provider" class="${authRole === 'provider' ? 'on' : ''}">我是服务人员</button>
      </div>
      <label class="f">手机号</label><input id="aPhone" type="tel" maxlength="11" placeholder="11 位手机号">
      <label class="f">姓名</label><input id="aName" placeholder="${authRole === 'provider' ? '如：王陪诊' : '如：李小明'}">
      <label class="f">密码（至少 6 位）</label><input id="aPass" type="password">
      ${authRole === 'provider' ? '<label class="f">所在城市</label><input id="aCity" value="长沙">' : ''}
      <div style="margin-top:18px"><button class="btn" style="width:100%" id="aGo">注 册</button></div>`;
    form.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { authRole = b.dataset.r; renderAuth(); });
    document.getElementById('aGo').onclick = doRegister;
  }
  async function doLogin() {
    try {
      const r = await api('/api/login', 'POST', { phone: v('aPhone'), password: v('aPass') });
      S.token = r.token; localStorage.setItem('zsb_token', r.token);
      S.me = r.user; S.family = r.family;
      S.role_view = r.user.role === 'elder' ? 'elder' : r.user.role;
      localStorage.setItem('zsb_view_' + r.user.id, S.role_view);
      toast('欢迎回来，' + r.user.name);
      render();
    } catch (e) { toast(e.message); }
  }
  async function doRegister() {
    try {
      await api('/api/register', 'POST', { phone: v('aPhone'), password: v('aPass'), name: v('aName'), role: authRole, city: v('aCity') || undefined, specialties: authRole === 'provider' ? Object.keys(SVC) : undefined });
      toast('注册成功，请登录');
      authMode = 'login'; renderAuth();
      document.getElementById('aPhone').value = v('aPhone') || '';
    } catch (e) { toast(e.message); }
  }
  function v(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
}

/* ================= 子女端 ================= */
const SVC = {};
async function loadServices() {
  if (Object.keys(SVC).length) return;
  try { const r = await api('/api/services'); for (const s of r.services) SVC[s.type] = s; } catch {}
}
function shell(active, inner, fab) {
  $app.innerHTML = `
    <div class="topbar"><h1>🏡 在身边</h1><div class="slogan">${H(S.family ? S.family.name + ' · ' + S.family.city : '异地子女养老协同平台')}</div>
      <div class="right">
        <span class="me-chip" id="viewSwitch">${S.me.name}·子女端 ▾</span>
        <button class="bell" id="bellBtn">🔔<span class="dot" id="ntfBadge" style="display:none"></span></button>
      </div>
    </div>
    ${inner}
    ${fab || ''}
    <div class="tabbar">
      ${[['home', '🏠', '状态大屏'], ['service', '🧾', '服务'], ['family', '👨‍👩‍👧', '家庭'], ['record', '📋', '档案'], ['me', '⚙️', '我的']]
      .map(([k, ic, t]) => `<button data-k="${k}" class="${active === k ? 'on' : ''}"><span class="ic">${ic}</span>${t}</button>`).join('')}
    </div>`;
  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => { S.tab = b.dataset.k; render(); });
  document.getElementById('bellBtn').onclick = openNotifications;
  document.getElementById('viewSwitch').onclick = switchView;
  pollLoop();
}
function switchView() {
  sheet('切换视图', `
    <button class="btn" style="width:100%;margin-bottom:10px" data-v="child">👩‍💼 子女端（当前）</button>
    ${S.me.role !== 'elder' ? '<button class="btn ghost" style="width:100%;margin-bottom:10px" data-v="elder">👴 老人端（大字模式预览）</button>' : ''}
    ${S.me.role === 'provider' ? '<button class="btn ghost" style="width:100%;margin-bottom:10px" data-v="provider">🧑‍⚕️ 服务商端</button>' : ''}
    <div class="divider"></div>
    <button class="btn grey" style="width:100%" id="logoutBtn">退出登录</button>`, m => {
    m.querySelectorAll('[data-v]').forEach(b => b.onclick = () => {
      S.role_view = b.dataset.v; localStorage.setItem('zsb_view_' + S.me.id, S.role_view); closeSheet(); render();
    });
    m.querySelector('#logoutBtn').onclick = () => {
      localStorage.removeItem('zsb_token'); S = { token: null, me: null, family: null, tab: 'home', role_view: null }; closeSheet(); render();
    };
  });
}
async function openNotifications() {
  const r = await api('/api/notifications');
  const icons = { sos: '🚨', alert: '⚠️', order: '🧾', checkin: '💚', family: '👨‍👩‍👧', task: '📌', vote: '🗳️', expense: '💰' };
  sheet('消息通知', r.notifications.length ? r.notifications.map(n => `
    <div class="ntf ${n.read ? '' : 'unread'}"><div class="ic">${icons[n.kind] || '📩'}</div>
      <div class="grow"><b style="font-size:14px">${H(n.title)}</b><div class="sub" style="margin-top:2px">${H(n.body)}</div>
      <div class="sub" style="margin-top:3px">${fmtT(n.created_at)}</div></div></div>`).join('') : '<div class="empty">暂无消息</div>');
  api('/api/notifications/read', 'POST').then(pollLoop);
}

async function renderChild() {
  await loadServices();
  if (!S.family) return renderNoFamily();
  if (S.tab === 'home') return tabHome();
  if (S.tab === 'service') return tabService();
  if (S.tab === 'family') return tabFamily();
  if (S.tab === 'record') return tabRecord();
  return tabMe();
}
function renderNoFamily() {
  shell('home', `
    <div class="card" style="margin-top:30px;text-align:center">
      <div style="font-size:46px">👨‍👩‍👧</div>
      <h3 style="justify-content:center;margin-top:8px">还没有家庭圈</h3>
      <p class="sub" style="margin:6px 0 16px">创建家庭圈后：绑定父母 → 邀请兄弟姐妹 → 开启状态大屏与协同赡养</p>
      <button class="btn" style="width:100%" id="cFam">创建家庭圈</button>
      <div class="divider"></div>
      <button class="btn ghost" style="width:100%" id="jFam">用邀请码加入</button>
    </div>`);
  document.getElementById('cFam').onclick = () => sheet('创建家庭圈', `
    <label class="f">家庭圈名称</label><input id="fName" value="${H(S.me.name)}的家">
    <label class="f">父母所在城市</label><input id="fCity" value="长沙">
    <div style="margin-top:16px"><button class="btn" style="width:100%" id="fGo">创建</button></div>`, m => {
    m.querySelector('#fGo').onclick = async () => {
      try { await api('/api/family', 'POST', { name: m.querySelector('#fName').value, city: m.querySelector('#fCity').value }); await refreshFamily(); closeSheet(); render(); }
      catch (e) { toast(e.message); }
    };
  });
  document.getElementById('jFam').onclick = () => sheet('加入家庭圈', `
    <label class="f">邀请码</label><input id="jCode" placeholder="6 位邀请码" style="text-transform:uppercase">
    <div style="margin-top:16px"><button class="btn" style="width:100%" id="jGo">加入</button></div>`, m => {
    m.querySelector('#jGo').onclick = async () => {
      try { await api('/api/family/join', 'POST', { code: m.querySelector('#jCode').value }); await refreshFamily(); closeSheet(); render(); toast('加入成功'); }
      catch (e) { toast(e.message); }
    };
  });
}

/* ---- Tab1 状态大屏 ---- */
async function tabHome() {
  const d = await api('/api/dashboard');
  const maxAct = Math.max(1, ...d.trend7.map(t => t.activity));
  const elderCards = d.elders.map(e => {
    const v = e.vitals;
    const bpBad = v.bp && ((v.bp.sys && (v.bp.sys.value > 150 || v.bp.sys.value < 90)) || (v.bp.dia && (v.bp.dia.value > 95 || v.bp.dia.value < 60)));
    return `
    <div class="card">
      <div class="elder-head">
        <div class="avatar">${e.avatar || '👴'}</div>
        <div><b style="font-size:17px">${H(e.name)}</b> <span class="sub">${e.age}岁</span>
          <div class="sub" style="margin-top:3px">🏠 ${H(e.loc)}${e.lastCheckin ? '｜💚 打卡 ' + fmtHM(e.lastCheckin) : ''}</div></div>
        <span class="status-pill sp-${e.status}">${e.statusText}</span>
      </div>
      <div class="vgrid">
        <div class="vcell">❤️ 心率<b class="${v.heart_rate && (v.heart_rate.value > 110 || v.heart_rate.value < 50) ? 'bad' : 'good'}">${v.heart_rate ? v.heart_rate.value + ' bpm' : '—'}</b></div>
        <div class="vcell">🩸 血压<b class="${bpBad ? 'bad' : 'good'}">${v.bp && v.bp.sys ? v.bp.sys.value + '/' + (v.bp.dia ? v.bp.dia.value : '—') : '—'}</b></div>
        <div class="vcell">😴 睡眠<b>${v.sleep ? v.sleep.value + ' h' : '—'}</b></div>
        <div class="vcell">🚶 今日步数<b>${v.steps ? v.steps.value : '—'}</b></div>
      </div>
      <div class="medrow">${e.meds.items.length ? e.meds.items.map(m =>
        `<span class="medchip ${m.status}">${m.time} ${H(m.med)} ${m.status === 'taken' ? '✅' : m.status === 'missed' ? '❌' : '⏳'}</span>`).join('')
        : '<span class="sub">未设置用药提醒</span>'}</div>
      ${e.lastContact ? `<div class="sub" style="margin-top:8px">📞 最后联系：${fmtT(e.lastContact.ts)} ${H(e.lastContact.type)}</div>` : ''}
      ${e.alerts.length ? `<div class="divider"></div>` + e.alerts.map(a =>
        `<div class="item"><span class="tag ${a.level === 'critical' ? 'crit' : a.level === 'warning' ? 'warn' : 'info'}">${a.level === 'critical' ? '紧急' : a.level === 'warning' ? '预警' : '关注'}</span> ${H(a.message)} <span class="sub">${fmtT(a.created_at)}</span>
        <button class="btn sm grey" style="float:right" onclick="ackAlert(${a.id},this)">知道了</button></div>`).join('') : ''}
      <div style="margin-top:10px;display:flex;gap:8px">
        <button class="btn sm ghost" onclick="openTrend(${e.id},'heart_rate','心率')">📈 趋势</button>
        <button class="btn sm ghost" onclick="openElderDetail(${e.id})">详情/设备</button>
        <button class="btn sm ghost" onclick="quickCall(${e.id})">📞 记录联系</button>
      </div>
    </div>`;
  }).join('');
  shell('home', `
    ${elderCards || '<div class="card"><div class="empty">还没有绑定父母<br><br><button class="btn" onclick="goFamilyTab()">去家庭圈绑定 →</button></div></div>'}
    <div class="card"><h3>📊 近 7 天全家状态趋势</h3>
      <div class="trend">${d.trend7.map(t => `<div class="bar" style="height:${Math.max(6, t.activity / maxAct * 100)}%" title="活动${t.activity} 预警${t.alerts}">${t.alerts ? '<span class="al"></span>' : ''}<small>${t.date}</small></div>`).join('')}</div>
      <div class="sub" style="margin-top:20px">柱高=活动/打卡/出入次数，红点=当日有预警</div>
    </div>
    <div class="share-card">
      <h4>📤 今日父母状态 · 分享卡片（已脱敏）</h4>
      <div id="shareBody" class="sub" style="margin-top:8px">点击下方按钮生成</div>
      <div class="hook">"你有多久没看到父母的真实状态了？"</div>
      <button class="btn sm" style="margin-top:10px" onclick="genShare()">生成分享卡片</button>
    </div>`,
    `<div class="sos-fab"><button onclick="manualSos()">SOS</button></div>`);
}
window.goFamilyTab = () => { S.tab = 'family'; render(); };
window.ackAlert = async (id, btn) => {
  await api('/api/alerts/' + id + '/ack', 'POST').catch(() => {});
  btn.closest('.item')?.remove(); toast('已确认');
};
window.genShare = async () => {
  const c = await api('/api/sharecard');
  document.getElementById('shareBody').innerHTML =
    `<b>${H(c.title)}｜${c.date}</b><br>` + c.cards.map(x => `${H(x.name)}：${H(x.statusText)}（${H(x.summary)}）`).join('<br>') +
    `<br><span style="color:var(--brand)">${H(c.slogan)}</span><br><button class="btn sm green" style="margin-top:8px" onclick="copyShare()">复制文案去分享</button>`;
  window._shareText = `${c.title}｜${c.date}\n` + c.cards.map(x => `${x.name}：${x.statusText}（${x.summary}）`).join('\n') + `\n${c.hook}\n${c.slogan} #在身边#`;
};
window.copyShare = () => {
  navigator.clipboard?.writeText(window._shareText).then(() => toast('已复制，去朋友圈/家庭群粘贴吧')).catch(() => toast(window._shareText, 6000));
};
window.quickCall = async (eid) => {
  const type = await pick(['视频通话', '语音通话', '微信语音', '回家探望'], '记录一次联系');
  if (!type) return;
  await api('/api/events', 'POST', { elder_id: eid, kind: 'contact', data: { type } });
  toast('已记录：' + type);
};
function pick(options, title) {
  return new Promise(res => {
    sheet(title || '请选择', options.map(o => `<button class="btn ghost" style="width:100%;margin-bottom:10px" data-o="${H(o)}">${H(o)}</button>`).join(''), m => {
      m.querySelectorAll('[data-o]').forEach(b => b.onclick = () => { closeSheet(); res(b.dataset.o); });
      m.addEventListener('click', e => { if (e.target === m) { closeSheet(); res(null); } });
    });
  });
}
window.openTrend = async (eid, type, label) => {
  const hours = await pick(['24小时|24', '3天|72', '7天|168'].map(s => s.split('|')[0]), label + ' 趋势');
  if (!hours) return;
  const h = { '24小时': 24, '3天': 72, '7天': 168 }[hours];
  const r = await api(`/api/vitals?elder_id=${eid}&type=${type}&hours=${h}`);
  const pts = r.points;
  sheet(`${label}趋势（近${hours}小时）`, !pts.length ? '<div class="empty">暂无数据</div>' : `
    <canvas id="trendCv" width="440" height="200" style="width:100%;background:#fbf8f3;border-radius:12px"></canvas>
    <div class="sub" style="margin-top:8px">共 ${pts.length} 条记录，最新 ${pts[pts.length - 1].value}</div>`, m => {
    if (!pts.length) return;
    const cv = m.querySelector('#trendCv'), ctx = cv.getContext('2d');
    const vs = pts.map(p => p.value), lo = Math.min(...vs), hi = Math.max(...vs), span = (hi - lo) || 1;
    ctx.strokeStyle = '#e8734a'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((p, i) => {
      const x = 10 + i / Math.max(1, pts.length - 1) * (cv.width - 20);
      const y = cv.height - 15 - (p.value - lo) / span * (cv.height - 35);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = '#8a7a6a'; ctx.font = '11px sans-serif';
    ctx.fillText(hi, 4, 14); ctx.fillText(lo, 4, cv.height - 4);
  });
};
window.openElderDetail = async (eid) => {
  const devs = await api('/api/devices');
  const my = devs.devices.filter(d => d.elder_id === eid);
  sheet('设备与手动录入', `
    <h3 style="font-size:14px;margin-bottom:8px">已接入设备</h3>
    ${my.length ? my.map(d => `<div class="kv"><span>${{ watch: '⌚ 智能手表', radar: '📡 毫米波雷达', door: '🚪 智能门磁', bp: '🩸 血压计', pillbox: '💊 智能药盒' }[d.type] || d.type}</span><span class="sub">${d.last_ts ? '最近上报 ' + fmtT(d.last_ts) : '未上报'}</span></div>`).join('') : '<div class="empty">暂无设备（演示可用下方"模拟设备"）</div>'}
    <div class="divider"></div>
    <label class="f">添加/模拟设备</label>
    <select id="devType"><option value="watch">智能手表（心率/血氧/步数/睡眠/跌倒）</option><option value="bp">血压计</option><option value="door">智能门磁</option><option value="radar">毫米波雷达（室内活动）</option><option value="pillbox">智能药盒</option></select>
    <div style="margin:10px 0"><button class="btn sm" id="devAdd">添加并模拟一次上报</button></div>
    <div class="divider"></div>
    <h3 style="font-size:14px;margin-bottom:8px">手动录入（无设备也可用）</h3>
    <div class="row"><select id="mType" style="flex:1"><option value="systolic">收缩压</option><option value="diastolic">舒张压</option><option value="heart_rate">心率</option><option value="steps">步数</option><option value="sleep">睡眠(h)</option><option value="weight">体重(kg)</option><option value="glucose">血糖</option></select>
    <input id="mVal" type="number" step="0.1" placeholder="数值" style="width:110px"></div>
    <div style="margin-top:10px"><button class="btn sm ghost" id="mGo">录入</button></div>`, m => {
    m.querySelector('#devAdd').onclick = async () => {
      const type = m.querySelector('#devType').value;
      const r = await api('/api/devices', 'POST', { elder_id: eid, type });
      await api(`/api/devices/${r.id}/push`, 'POST', { data: simData(type) });
      toast('✅ ' + r.name + '已接入并上报'); closeSheet(); render();
    };
    m.querySelector('#mGo').onclick = async () => {
      try {
        await api('/api/vitals', 'POST', { elder_id: eid, type: m.querySelector('#mType').value, value: Number(m.querySelector('#mVal').value), source: 'manual' });
        toast('已录入'); closeSheet(); render();
      } catch (e) { toast(e.message); }
    };
  });
};
function simData(type) {
  const R = (a, b) => Math.round((a + Math.random() * (b - a)) * 10) / 10;
  if (type === 'watch') return { heart_rate: R(60, 85), spo2: R(95, 99), steps: Math.round(R(1500, 6000)), sleep: R(5.5, 8) };
  if (type === 'bp') return { systolic: Math.round(R(115, 145)), diastolic: Math.round(R(70, 90)) };
  if (type === 'door') return { open: Math.random() > 0.5, loc: '菜市场' };
  if (type === 'radar') return { room: '客厅', moving: true };
  if (type === 'pillbox') return { opened: true };
  return {};
}
window.manualSos = async () => {
  const fam = await api('/api/family');
  if (!fam.elders?.length) return toast('请先绑定父母');
  const eid = fam.elders.length === 1 ? fam.elders[0].id : Number((await pick(fam.elders.map(e => `${e.name}|${e.id}`), '为谁启动应急？'))?.split('|')[1]);
  if (!eid) return;
  if (!confirm(`确认为 ${fam.elders.find(e => e.id === eid)?.name} 启动 SOS 应急流程？\n（将分级通知所有紧急联系人）`)) return;
  const r = await api('/api/sos', 'POST', { elder_id: eid, trigger: 'child_manual' });
  S._sosManual = true;
  openSosOverlay(r.sos_id);
};

/* ---- SOS 全屏弹层 ---- */
async function openSosOverlay(id) {
  document.getElementById('sosOverlay')?.remove();
  const r = await api('/api/sos/' + id);
  const s = r.sos;
  const isElder = S.role_view === 'elder';
  const el = document.createElement('div');
  el.className = 'sos-full'; el.id = 'sosOverlay';
  el.innerHTML = `
    <h2>${isElder ? '🚨 求助已发出' : '🚨 应急事件进行中'}</h2>
    <div style="font-size:15px;opacity:.95">${isElder ? '正在通知家人，请保持设备在身边' : s.status_label}</div>
    ${isElder ? `<button class="big" id="sosCancel">我没事<br>取消求助</button>` : `<button class="big" id="sosAck">我来处理</button>`}
    <div style="display:flex;gap:10px">
      ${!isElder ? `<button class="cancel" id="sosResolve">✅ 确认解除</button>` : ''}
      <button class="cancel" id="sosClose">最小化</button>
    </div>
    <div class="soslog" id="sosLog">${s.log.map(l => `<p>· ${fmtHM(l.ts)} ${H(l.text)}</p>`).join('')}</div>
    ${s.card ? `<div class="soslog" style="max-height:110px"><b>应急信息卡（自动发送急救人员）</b>
      <p>👤 ${H(s.card.elder.name)} ${s.card.elder.age}岁｜📍 ${H(s.card.location)}</p>
      <p>🩺 病史：${H((s.card.elder.conditions || []).join('、') || '无记录')}｜过敏：${H((s.card.elder.allergies || []).join('、') || '无')}</p>
      <p>💊 用药：${H(s.card.meds.join('；') || '无')}</p>
      <p>📞 联系人：${s.card.contacts.map(c => H(c.name) + ' ' + H(c.rel || '') + ' ' + H(c.phone)).join('；')}</p></div>` : ''}`;
  document.body.appendChild(el);
  el.querySelector('#sosClose').onclick = () => { el.remove(); };
  if (isElder) el.querySelector('#sosCancel').onclick = async () => {
    await api(`/api/sos/${id}/cancel`, 'POST').catch(e => toast(e.message));
    el.remove(); toast('已取消，家人会收到平安通知');
  };
  else {
    el.querySelector('#sosAck').onclick = async () => { await api(`/api/sos/${id}/ack`, 'POST'); toast('已响应，升级暂停'); el.remove(); };
    el.querySelector('#sosResolve').onclick = async () => {
      const note = prompt('解除说明（可选）：', '老人平安') ?? '';
      await api(`/api/sos/${id}/resolve`, 'POST', { note }); el.remove(); S._sosManual = false; toast('应急已解除'); render();
    };
  }
  // 每 5 秒刷新日志与等级
  const tick = setInterval(async () => {
    if (!document.getElementById('sosOverlay')) return clearInterval(tick);
    try {
      const rr = await api('/api/sos/' + id);
      if (['resolved', 'cancelled'].includes(rr.sos.status)) { clearInterval(tick); el.remove(); S._sosManual = false; toast('应急已结束'); render(); return; }
      document.getElementById('sosLog').innerHTML = rr.sos.log.map(l => `<p>· ${fmtHM(l.ts)} ${H(l.text)}</p>`).join('');
    } catch {}
  }, 5000);
}

/* ---- Tab2 服务 ---- */
async function tabService() {
  const o = await api('/api/orders');
  const stLabel = { pending: '待派单', assigned: '已匹配', accepted: '已接单', in_service: '服务中', done: '已完成', cancelled: '已取消', rejected: '未通过', awaiting_review: '待子女确认', manual: '人工跟进' };
  const pendingReview = o.orders.filter(x => x.status === 'awaiting_review');
  const icons = { accompany_half: '🏥', accompany_full: '🏥', med_pickup: '💊', bath: '🛁', cleaning: '🧹', meal: '🍚', rehab: '🦵', errand: '🛒', repair: '🔧', psych: '💬' };
  shell('service', `
    ${pendingReview.length ? `<div class="card" style="border:2px solid var(--amber)"><h3>🧓 父母发起的请求（待您确认）</h3>
      ${pendingReview.map(x => `<div class="item"><b>${icons[x.service_type] || ''} ${H(SVC[x.service_type]?.label || x.service_type)}</b> <span class="sub">¥${x.price}｜${fmtT(x.scheduled_at)}</span>
        <div style="margin-top:6px"><button class="btn sm green" onclick="reviewOrder(${x.id},true)">同意并派单</button>
        <button class="btn sm grey" onclick="reviewOrder(${x.id},false)">先商量</button></div></div>`).join('')}</div>` : ''}
    <div class="card"><h3>🧾 为父母预约服务</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${Object.values(SVC).map(s => `<button class="btn ghost" style="padding:13px 8px;font-size:13.5px" onclick="orderFlow('${s.type}')">${icons[s.type] || '📦'} ${H(s.label)}<br><span style="font-size:12px;color:var(--sub)">¥${s.price}起</span></button>`).join('')}
      </div></div>
    <div class="card"><h3>📜 订单记录</h3>
      ${o.orders.length ? o.orders.map(x => `
        <div class="item">
          <div class="row"><b>${icons[x.service_type] || ''} ${H(SVC[x.service_type]?.label || x.service_type)}</b>
          <span class="tag ${x.status === 'done' ? 'ok' : ['cancelled', 'rejected'].includes(x.status) ? 'crit' : 'info'}">${stLabel[x.status] || x.status}</span>
          <span class="grow"></span><b>¥${x.price}</b></div>
          <div class="sub" style="margin-top:3px">为 ${H(x.elder_name)}｜${fmtT(x.scheduled_at)}${x.provider_name ? '｜服务人员：' + H(x.provider_name) : ''}${x.from_elder ? '｜👴 父母自订' : ''}</div>
          <div style="margin-top:6px;display:flex;gap:6px">
            <button class="btn sm ghost" onclick="orderDetail(${x.id})">详情</button>
            ${x.status === 'done' && !x.rating ? `<button class="btn sm" onclick="rateOrder(${x.id})">评价</button>` : ''}
            ${x.rating ? `<span class="sub" style="align-self:center">已评 ${'⭐'.repeat(x.rating)}</span>` : ''}
            ${['pending', 'assigned', 'awaiting_review'].includes(x.status) ? `<button class="btn sm grey" onclick="cancelOrder(${x.id})">取消</button>` : ''}
          </div>
        </div>`).join('') : '<div class="empty">暂无订单</div>'}
    </div>`,
    `<div class="sos-fab"><button onclick="manualSos()">SOS</button></div>`);
}
window.orderFlow = async (type) => {
  const fam = await api('/api/family');
  if (!fam.elders?.length) return toast('请先绑定父母');
  const eid = fam.elders.length === 1 ? fam.elders[0].id : Number((await pick(fam.elders.map(e => `${e.name}|${e.id}`), '为谁预约？'))?.split('|')[1]);
  if (!eid) return;
  const s = SVC[type];
  sheet(`预约「${s.label}」`, `
    <label class="f">服务时间</label><input id="oTime" type="datetime-local" value="${defaultDT()}">
    <label class="f">地点/医院（可选）</label><input id="oLoc" placeholder="如：湘雅医院 骨科">
    <label class="f">备注（可选）</label><textarea id="oNote" rows="2" placeholder="特殊需求，如需要轮椅协助"></textarea>
    <div class="kv" style="margin-top:10px"><span>价格</span><b>¥${s.price}</b></div>
    <div style="margin-top:14px"><button class="btn" style="width:100%" id="oGo">立即下单（平台匹配就近高分服务人员）</button></div>`, m => {
    m.querySelector('#oGo').onclick = async () => {
      try {
        const r = await api('/api/orders', 'POST', { service_type: type, elder_id: eid, scheduled_at: new Date(m.querySelector('#oTime').value).getTime(), location: m.querySelector('#oLoc').value, notes: m.querySelector('#oNote').value });
        closeSheet(); toast(r.need_review ? '已提交，等待子女确认' : '✅ 下单成功，正在匹配服务人员');
        render();
      } catch (e) { toast(e.message); }
    };
  });
};
function defaultDT() {
  const d = new Date(Date.now() + 86400e3); d.setMinutes(0); d.setSeconds(0);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T09:00`;
}
window.reviewOrder = async (id, approve) => {
  await api(`/api/orders/${id}/review`, 'POST', { approve }); toast(approve ? '已同意并派单' : '已婉拒'); render();
};
window.cancelOrder = async id => { if (confirm('确认取消该订单？')) { await api(`/api/orders/${id}/cancel`, 'POST'); render(); } };
window.rateOrder = async id => {
  const rating = await pick(['5|非常满意', '4|满意', '3|一般', '2|不满意', '1|很差'], '服务评价');
  if (!rating) return;
  await api(`/api/orders/${id}/rate`, 'POST', { rating: Number(rating.split('|')[0]) }); toast('感谢评价'); render();
};
window.orderDetail = async id => {
  const r = await api('/api/orders/' + id);
  const o = r.order;
  sheet('订单详情', `
    <div class="kv"><span>服务</span><b>${H(SVC[o.service_type]?.label || o.service_type)}</b></div>
    <div class="kv"><span>老人</span><span>${H(o.elder_name)}${o.elder_phone ? ' ' + H(o.elder_phone) : ''}</span></div>
    <div class="kv"><span>时间</span><span>${fmtT(o.scheduled_at)}</span></div>
    <div class="kv"><span>状态</span><span>${o.status}</span></div>
    ${o.provider_name ? `<div class="kv"><span>服务人员</span><span>${H(o.provider_name)}（评分 ${o.provider_rating}）</span></div>` : ''}
    ${o.notes ? `<div class="kv"><span>备注</span><span>${H(o.notes)}</span></div>` : ''}
    <div class="divider"></div><h3 style="font-size:14px">服务进展</h3>
    ${r.updates.length ? r.updates.map(u => `<div class="ntf"><div class="grow"><div style="font-size:13.5px">${H(u.text)}</div><div class="sub">${fmtT(u.ts)}</div></div></div>`).join('') : '<div class="empty">暂无进展</div>'}
    ${o.review ? `<div class="divider"></div><div class="sub">我的评价：${'⭐'.repeat(o.rating)} ${H(o.review)}</div>` : ''}`);
};

/* ---- Tab3 家庭协同 ---- */
async function tabFamily() {
  const [fam, tasks, duty, exp, votes] = await Promise.all([
    api('/api/family'), api('/api/tasks'), api('/api/duty'), api('/api/expenses'), api('/api/votes')]);
  const members = fam.members;
  const kidIds = members.filter(m => m.role === 'child').map(m => m.id);
  const stMap = { open: '待认领', claimed: '进行中', done: '已完成' };
  const planLabel = { free: '免费版', premium: '高级版 ¥39/月', elite: '尊享版 ¥99/月' };
  shell('family', `
    <div class="card"><h3>👨‍👩‍👧 ${H(fam.family.name)} <span class="tag info">${planLabel[fam.family.plan]}</span></h3>
      ${members.map(m => `<div class="item"><div class="row"><span style="font-size:20px">${m.role === 'elder' ? '👴' : m.role === 'provider' ? '🧑‍⚕️' : '🧑'}</span>
        <b>${H(m.name)}</b><span class="sub">${{ child: '子女', elder: '父母', provider: '服务人员' }[m.role]}${m.rel ? '·' + H(m.rel) : ''}</span></div></div>`).join('')}
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="btn sm" onclick="inviteFamily()">邀请家人</button>
        <button class="btn sm ghost" onclick="bindElder()">绑定父母</button>
        <button class="btn sm ghost" onclick="planSheet('${fam.family.plan}')">会员升级</button>
      </div></div>
    <div class="card"><h3>📌 任务认领 <button class="btn sm" style="margin-left:auto" onclick="newTask()">+ 发布</button></h3>
      ${tasks.tasks.length ? tasks.tasks.map(t => `
        <div class="item"><div class="row"><b>${H(t.title)}</b><span class="tag ${t.status === 'done' ? 'ok' : t.status === 'claimed' ? 'info' : 'warn'}">${stMap[t.status]}</span></div>
        <div class="sub">${t.due_date ? '📅 ' + t.due_date + '｜' : ''}${t.claimed_name ? '认领人：' + H(t.claimed_name) : '等待认领'}${t.detail ? '｜' + H(t.detail) : ''}</div>
        ${t.status === 'open' ? `<button class="btn sm ghost" style="margin-top:5px" onclick="claimTask(${t.id})">🙋 我来</button>` : ''}
        ${t.status === 'claimed' ? `<button class="btn sm green" style="margin-top:5px" onclick="doneTask(${t.id})">完成</button>` : ''}</div>`).join('') : '<div class="empty">暂无任务，例如"下周三陪爸爸复诊"</div>'}</div>
    <div class="card"><h3>📅 轮值日历（本月） <button class="btn sm" style="margin-left:auto" onclick="newDuty(${JSON.stringify(kidIds)})">+ 排班</button></h3>
      ${duty.duty.length ? '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">' + duty.duty.map(d =>
        `<div style="background:#fdeee4;border-radius:8px;padding:5px 2px;text-align:center;font-size:11px"><b>${d.date.slice(8)}</b><br>${H(d.user_name)}</div>`).join('') + '</div>' : '<div class="empty">本月暂无排班（谁每天打电话/谁周末回家）</div>'}</div>
    <div class="card"><h3>💰 费用 AA <button class="btn sm" style="margin-left:auto" onclick="newExpense()">+ 记一笔</button></h3>
      <div class="kv"><span>累计支出</span><b>¥${exp.aa.total.toFixed(2)}</b></div>
      ${exp.aa.members.map(m => `<div class="kv"><span>${H(m.name)}</span><span class="${m.balance > 0 ? '' : 'sub'}">${m.balance > 0 ? '应收 ¥' + m.balance : m.balance < 0 ? '应付 ¥' + (-m.balance) : '已结清'}</span></div>`).join('')}
      ${exp.aa.transfers.length ? `<div class="sub" style="margin-top:6px">💡 结算建议：${exp.aa.transfers.map(t => `${H(t.from)} → ${H(t.to)} ¥${t.amount}`).join('；')}</div>` : ''}
      ${exp.expenses.slice(0, 5).map(e => `<div class="item"><div class="row"><span>${H(e.title)}</span><span class="grow"></span><b>¥${e.amount}</b></div><div class="sub">${H(e.paid_name)} 支付｜${e.category}｜${e.split === 'aa' ? 'AA分摊' : '个人承担'}</div></div>`).join('')}</div>
    <div class="card"><h3>🗳️ 家庭投票 <button class="btn sm" style="margin-left:auto" onclick="newVote()">+ 发起</button></h3>
      ${votes.votes.length ? votes.votes.map(v => `
        <div class="item"><b>${H(v.title)}</b> <span class="tag ${v.status === 'open' ? 'warn' : 'ok'}">${v.status === 'open' ? '进行中' : '已决'}</span>
        ${v.options.map(op => {
          const cnt = v.records.filter(r => r.choice === op).length;
          const mine = v.records.find(r => r.user_id === S.me.id)?.choice === op;
          return `<div class="row" style="margin-top:6px"><button class="btn sm ${mine ? '' : 'ghost'}" ${v.status !== 'open' || mine ? 'disabled' : ''} onclick="castVote(${v.id},'${H(op).replace(/'/g, "\\'")}')">${H(op)}${mine ? ' ✓' : ''}</button><span class="sub">${cnt} 票</span></div>`;
        }).join('')}</div>`).join('') : '<div class="empty">重大分歧投票决定：是否请护工/选哪家养老院</div>'}</div>
    <div class="card"><h3>📖 家庭大事记</h3>
      ${fam.timeline.length ? fam.timeline.map(t => `<div class="item"><span class="sub">${fmtT(t.ts)}</span> ${H(t.summary)}</div>`).join('') : '<div class="empty">暂无记录</div>'}</div>`,
    `<div class="sos-fab"><button onclick="manualSos()">SOS</button></div>`);
}
window.inviteFamily = async () => {
  const r = await api('/api/family/invite', 'POST');
  sheet('邀请家人', `
    <p class="sub">把邀请码发给兄弟姐妹/家人，对方注册登录后输入即可加入：</p>
    <div style="text-align:center;font-size:34px;font-weight:900;letter-spacing:6px;margin:16px 0;color:var(--brand)">${r.code}</div>
    <button class="btn" style="width:100%" onclick="navigator.clipboard?.writeText('我在「在身边」建了咱家的养老协同圈，邀请码 ${r.code}，快加入一起照顾爸妈！').then(()=>toast('邀请文案已复制'))">复制邀请文案</button>`);
};
window.bindElder = () => sheet('绑定父母', `
  <label class="f">父母手机号（已注册则直接拉入）</label><input id="bPhone" type="tel" maxlength="11" placeholder="11 位手机号">
  <label class="f">称呼</label><input id="bRel" placeholder="如：爸爸 / 妈妈">
  <div style="margin-top:16px"><button class="btn" style="width:100%" id="bGo">绑定</button></div>
  <p class="sub" style="margin-top:10px">未注册时会生成绑定码，老人用"老人端→输入绑定码"即可自动注册加入。</p>`, m => {
  m.querySelector('#bGo').onclick = async () => {
    try {
      const r = await api('/api/family/bind', 'POST', { phone: m.querySelector('#bPhone').value.trim(), rel: m.querySelector('#bRel').value });
      if (r.bound) { toast('✅ 已绑定 ' + r.elder.name); closeSheet(); render(); }
      else sheet('绑定码', `<div style="text-align:center;font-size:36px;font-weight:900;letter-spacing:6px;color:var(--brand);margin:14px 0">${r.bindCode}</div><p class="sub">${H(r.tip)}</p>`);
    } catch (e) { toast(e.message); }
  };
});
window.planSheet = cur => sheet('会员套餐', `
  ${[['free', '免费版', '状态大屏(手动打卡)+家庭群3人+每月1次应急', '0'],
     ['premium', '高级版', '+硬件数据接入+无限应急+用药提醒+陪诊9折', '39'],
     ['elite', '尊享版', '+每月2次免费陪诊+专属客服+体检AI解读+家庭群10人+优先派单', '99']]
  .map(([k, n, d, p]) => `<div class="item"><div class="row"><b>${n} ${cur === k ? '<span class="tag ok">当前</span>' : ''}</b><span class="grow"></span><b style="color:var(--brand)">¥${p}${p !== '0' ? '/月' : ''}</b></div>
    <div class="sub">${d}</div>${cur !== k ? `<button class="btn sm" style="margin-top:6px" onclick="setPlan('${k}')">选择（演示免费开通）</button>` : ''}</div>`).join('')}`);
window.setPlan = async p => { await api('/api/family/plan', 'POST', { plan: p }); closeSheet(); toast('已开通'); render(); };
window.newTask = () => sheet('发布任务', `
  <label class="f">任务</label><input id="tTitle" placeholder="如：下周三陪爸爸复诊">
  <label class="f">截止日期（可选）</label><input id="tDue" type="date">
  <div style="margin-top:14px"><button class="btn" style="width:100%" onclick="doNewTask()">发布给全家认领</button></div>`);
window.doNewTask = async () => {
  const t = document.getElementById('tTitle').value.trim();
  if (!t) return toast('请填写任务');
  await api('/api/tasks', 'POST', { title: t, due_date: document.getElementById('tDue').value }); closeSheet(); render();
};
window.claimTask = async id => { await api(`/api/tasks/${id}/claim`, 'POST'); render(); };
window.doneTask = async id => { await api(`/api/tasks/${id}/done`, 'POST'); render(); };
window.newDuty = async kids => {
  const fam = await api('/api/family');
  const kidMembers = fam.members.filter(m => m.role === 'child');
  sheet('排班', `<label class="f">日期</label><input id="dDate" type="date" value="${alerts_today()}">
  <label class="f">值班人</label><select id="dUser">${kidMembers.map(m => `<option value="${m.id}">${H(m.name)}</option>`).join('')}</select>
  <label class="f">内容</label><input id="dNote" value="打电话问候">
  <div style="margin-top:14px"><button class="btn" style="width:100%" onclick="doNewDuty()">保存</button></div>`);
};
function alerts_today() { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
window.doNewDuty = async () => {
  await api('/api/duty', 'POST', { date: document.getElementById('dDate').value, user_id: Number(document.getElementById('dUser').value), note: document.getElementById('dNote').value });
  closeSheet(); render();
};
window.newExpense = () => sheet('记一笔赡养支出', `
  <label class="f">事项</label><input id="eTitle" placeholder="如：爸爸降压药">
  <label class="f">金额（元）</label><input id="eAmt" type="number" step="0.01">
  <label class="f">分类</label><select id="eCat"><option>医疗</option><option>药品</option><option>服务</option><option>生活</option><option>其他</option></select>
  <label class="f">分摊方式</label><select id="eSplit"><option value="aa">兄弟姐妹 AA</option><option value="self">个人承担</option></select>
  <div style="margin-top:14px"><button class="btn" style="width:100%" onclick="doNewExpense()">保存</button></div>`);
window.doNewExpense = async () => {
  try {
    await api('/api/expenses', 'POST', { title: document.getElementById('eTitle').value, amount: Number(document.getElementById('eAmt').value), category: document.getElementById('eCat').value, split: document.getElementById('eSplit').value });
    closeSheet(); render();
  } catch (e) { toast(e.message); }
};
window.newVote = () => sheet('发起家庭投票', `
  <label class="f">议题</label><input id="vTitle" placeholder="如：是否给妈妈请住家护工">
  <label class="f">选项A</label><input id="vA" placeholder="如：请护工">
  <label class="f">选项B</label><input id="vB" placeholder="如：先请钟点工">
  <div style="margin-top:14px"><button class="btn" style="width:100%" onclick="doNewVote()">发起投票</button></div>`);
window.doNewVote = async () => {
  const title = document.getElementById('vTitle').value.trim();
  const opts = [document.getElementById('vA').value.trim(), document.getElementById('vB').value.trim()].filter(Boolean);
  if (!title || opts.length < 2) return toast('请填写议题和两个选项');
  await api('/api/votes', 'POST', { title, options: opts }); closeSheet(); render();
};
window.castVote = async (id, choice) => { const r = await api(`/api/votes/${id}/cast`, 'POST', { choice }); toast(r.closed ? '投票已结束，结果已公布' : '已投票'); render(); };

/* ---- Tab4 医疗档案 ---- */
async function tabRecord() {
  const fam = await api('/api/family');
  const elders = fam.elders || [];
  const eid = elders[0]?.id;
  shell('record', `
    ${elders.length > 1 ? `<div class="card"><label class="f">选择老人</label><select id="recElder" onchange="render()">${elders.map(e => `<option value="${e.id}">${H(e.name)}</option>`).join('')}</select></div>` : ''}
    <div id="recBody"><div class="empty">加载中…</div></div>`,
    `<div class="sos-fab"><button onclick="manualSos()">SOS</button></div>`);
  if (!eid) { document.getElementById('recBody').innerHTML = '<div class="empty">请先绑定父母</div>'; return; }
  const [reps, meds] = await Promise.all([api(`/api/reports?elder_id=${eid}`), api(`/api/meds?elder_id=${eid}`)]);
  document.getElementById('recBody').innerHTML = `
    <div class="card"><h3>💊 用药清单 <button class="btn sm" style="margin-left:auto" onclick="newMed(${eid})">+ 添加</button></h3>
      ${meds.meds.length ? meds.meds.map(m => `<div class="item"><b>${H(m.name)}</b> <span class="sub">${H(m.dose)}｜每日 ${JSON.parse(m.times).join(' / ')}</span></div>`).join('') : '<div class="empty">暂无用药记录</div>'}</div>
    <div class="card"><h3>📄 体检/就诊档案 <button class="btn sm" style="margin-left:auto" onclick="newReport(${eid})">+ 归档</button></h3>
      ${reps.reports.length ? reps.reports.map(r => `
        <div class="item"><b>${H(r.title)}</b> <span class="sub">${fmtT(r.ts)}</span>
        ${r.summary ? `<div class="sub" style="margin-top:4px">${H(r.summary).slice(0, 100)}</div>` : ''}
        ${r.ai_note ? `<pre style="white-space:pre-wrap;background:#f4faf6;border-radius:10px;padding:10px;font-size:12.5px;margin-top:6px;font-family:inherit">${H(r.ai_note)}</pre>`
          : `<button class="btn sm ghost" style="margin-top:6px" onclick="aiReport(${r.id})">🤖 AI 白话解读</button>`}</div>`).join('') : '<div class="empty">拍照上传体检报告（演示版为文字归档）<br>陪诊医嘱会自动归档到这里</div>'}</div>`;
}
window.newMed = eid => sheet('添加用药', `
  <label class="f">药品名</label><input id="mdName" placeholder="如：苯磺酸氨氯地平">
  <label class="f">剂量</label><input id="mdDose" placeholder="如：5mg 1片">
  <label class="f">服药时间（可多选常用）</label>
  <div class="row" style="gap:6px;flex-wrap:wrap">${['08:00', '12:00', '18:00', '21:00'].map(t => `<label style="font-size:13px"><input type="checkbox" class="mdT" value="${t}" ${t === '08:00' ? 'checked' : ''} style="width:auto"> ${t}</label>`).join('')}</div>
  <div style="margin-top:14px"><button class="btn" style="width:100%" onclick="doNewMed(${eid})">保存并开启提醒</button></div>`);
window.doNewMed = async eid => {
  const name = document.getElementById('mdName').value.trim();
  if (!name) return toast('请填写药品名');
  const times = [...document.querySelectorAll('.mdT:checked')].map(c => c.value);
  await api('/api/meds', 'POST', { elder_id: eid, name, dose: document.getElementById('mdDose').value.trim(), times });
  closeSheet(); toast('已添加'); render();
};
window.newReport = eid => sheet('归档报告/就诊记录', `
  <label class="f">标题</label><input id="rpTitle" placeholder="如：2026-11 市一院心内科就诊">
  <label class="f">内容摘要/医嘱</label><textarea id="rpSum" rows="4" placeholder="诊断、医嘱、下次复诊时间…"></textarea>
  <div style="margin-top:14px"><button class="btn" style="width:100%" onclick="doNewReport(${eid})">归档</button></div>`);
window.doNewReport = async eid => {
  await api('/api/reports', 'POST', { elder_id: eid, title: document.getElementById('rpTitle').value, summary: document.getElementById('rpSum').value });
  closeSheet(); toast('已归档'); render();
};
window.aiReport = async id => {
  toast('AI 解读中…');
  const r = await api(`/api/reports/${id}/ai`, 'POST');
  sheet('🤖 AI 白话解读（给子女看的版本）', `<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;line-height:1.7">${H(r.ai_note)}</pre>`);
};

/* ---- Tab5 我的 ---- */
function tabMe() {
  const planLabel = { free: '免费版', premium: '高级版', elite: '尊享版' };
  shell('me', `
    <div class="card" style="text-align:center;padding:22px">
      <div class="avatar" style="margin:0 auto;width:64px;height:64px;font-size:34px">🧑</div>
      <h3 style="justify-content:center;margin-top:8px">${H(S.me.name)}</h3>
      <div class="sub">${H(S.me.phone)}｜${S.family ? H(S.family.name) + ' · ' + planLabel[S.family.plan] : '未加入家庭圈'}</div>
    </div>
    <div class="card">
      <div class="item" onclick="switchView()"><b>🔁 切换视图</b><div class="sub">预览老人端大字模式 / 服务商端</div></div>
      <div class="item" onclick="openNotifications()"><b>🔔 消息通知</b></div>
      <div class="item" onclick="emergencyHistory()"><b>🚨 应急记录</b><div class="sub">历次 SOS 事件与响应时间</div></div>
      <div class="item" onclick="annualBill()"><b>🧧 家庭养老账单</b><div class="sub">今年为父母做了什么（可分享）</div></div>
    </div>
    <div class="card sub" style="text-align:center">在身边 V0.1 MVP · 零依赖 Node + SQLite<br>感知 → 预警 → 响应 → 服务 → 复盘</div>`,
    `<div class="sos-fab"><button onclick="manualSos()">SOS</button></div>`);
}
window.emergencyHistory = async () => {
  const r = await api('/api/sos');
  sheet('应急记录', r.history.length ? r.history.map(s => `
    <div class="item"><b>${H(s.elder_name)}</b> <span class="tag ${['resolved', 'cancelled'].includes(s.status) ? 'ok' : 'crit'}">${emer_label(s.status)}</span>
    <div class="sub">触发：${{ button: 'SOS按钮', fall_detect: '跌倒检测', voice: '语音呼救', child_manual: '子女手动', no_activity: '长时间无活动' }[s.trigger] || s.trigger}｜${fmtT(s.started_at)}${s.resolved_at ? '｜历时 ' + Math.round((s.resolved_at - s.started_at) / 1000) + ' 秒' : ''}</div></div>`).join('') : '<div class="empty">暂无应急记录（希望永远为空）</div>');
};
function emer_label(s) { return { level1: 'L1确认中', level2: 'L2通知家人', level3: 'L3社区上门', level4: 'L4呼叫120', resolved: '已解除', cancelled: '已取消' }[s] || s; }
window.annualBill = async () => {
  const [exp, tasks, sosR, orders] = await Promise.all([api('/api/expenses'), api('/api/tasks'), api('/api/sos'), api('/api/orders')]);
  const done = tasks.tasks.filter(t => t.status === 'done').length;
  const svc = orders.orders.filter(o => o.status === 'done').length;
  sheet('🧧 家庭养老账单', `
    <div style="text-align:center;padding:8px 0">
      <div style="font-size:40px">💝</div>
      <h3 style="justify-content:center">${new Date().getFullYear()} 年，${H(S.family?.name || '我们家')}为父母做了这些</h3>
      <div class="kv"><span>记录赡养支出</span><b>¥${exp.aa.total.toFixed(0)}</b></div>
      <div class="kv"><span>完成照护任务</span><b>${done} 项</b></div>
      <div class="kv"><span>预约上门服务</span><b>${svc} 次</b></div>
      <div class="kv"><span>应急响应</span><b>${sosR.history.length} 次</b></div>
      <p class="sub" style="margin-top:12px">"距离再远，也在身边。"</p>
      <button class="btn sm green" onclick="navigator.clipboard?.writeText('${new Date().getFullYear()}年我们家为父母：支出¥${exp.aa.total.toFixed(0)}、完成任务${done}项、上门服务${svc}次。距离再远，也在身边。#在身边#').then(()=>toast('账单文案已复制'))">复制账单去分享</button>
    </div>`);
};

/* ================= 老人端（超大字/极简） ================= */
async function renderElder() {
  let meds = { today: [] }, me = S.me;
  try { meds = await api('/api/meds'); } catch {}
  const nextMed = meds.today.find(m => m.status === 'pending');
  const missedMed = meds.today.find(m => m.status === 'missed');
  $app.innerHTML = `
    <div class="elder-home">
      <div class="elder-greet">${greet()}，${H(me.name)}${me.age ? '' : ''}</div>
      <div class="elder-note">${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</div>
      <button class="elder-btn eb-sos" onclick="elderSos()"><span class="ic">🆘</span>紧急求助<br><span style="font-size:15px;font-weight:400;opacity:.9">遇到危险，立即按这里</span></button>
      <button class="elder-btn eb-checkin" onclick="elderCheckin()"><span class="ic">💚</span>报平安<br><span style="font-size:15px;font-weight:400;opacity:.9">按一下，孩子们就放心了</span></button>
      ${nextMed ? `<button class="elder-btn eb-med" onclick="elderTakeMed(${nextMed.id})"><span class="ic">💊</span>该吃药了：${H(nextMed.med_name)} ${H(nextMed.dose || '')}<br><span style="font-size:15px;color:var(--green)">点一下 = 我已服药（${nextMed.time}）</span></button>`
        : `<div class="elder-btn eb-med" style="opacity:.7"><span class="ic">💊</span>${meds.today.length ? '今天的药都按时吃啦 👍' : '暂无用药提醒'}</div>`}
      ${missedMed ? `<div class="elder-note" style="color:var(--red)">⚠️ ${missedMed.time} 的「${H(missedMed.med_name)}」还没吃，别忘了</div>` : ''}
      <button class="elder-btn eb-service" onclick="elderService()"><span class="ic">🙋</span>我要服务<br><span style="font-size:15px;font-weight:400;opacity:.9">看病 / 买菜 / 修东西 / 找人聊天</span></button>
      <button class="elder-btn eb-call" onclick="elderCall()"><span class="ic">📞</span>给孩子打个电话</button>
      <div class="elder-note">孩子们都能看到您的状态，这不是监控，是关心 💕</div>
      <div style="text-align:center"><button class="btn grey sm" onclick="switchView()">切换到子女端</button></div>
    </div>`;
}
function greet() { const h = new Date().getHours(); return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'; }
window.elderSos = async () => {
  if (!confirm('确认发出紧急求助？\n家人会立刻收到通知。如果是误触，可在 60 秒内点"我没事"取消。')) return;
  const r = await api('/api/sos', 'POST', { trigger: 'button' });
  S._sosManual = true;
  openSosOverlay(r.sos_id);
};
window.elderCheckin = async () => {
  await api('/api/events', 'POST', { kind: 'checkin' });
  toast('💚 已报平安，孩子们收到啦！', 3000);
};
window.elderTakeMed = async id => {
  await api(`/api/meds/${id}/take`, 'POST');
  toast('✅ 已记录服药，真棒！'); render();
};
window.elderService = () => sheet('我要服务（点一下就行）', `
  ${[['accompany_half', '🏥 我想看病'], ['errand', '🛒 我想买菜/拿快递'], ['repair', '🔧 家里东西坏了'], ['psych', '💬 我想找人聊天'], ['bath', '🛁 我想洗澡(助浴)'], ['meal', '🍚 订饭']]
  .map(([t, l]) => `<button class="btn ghost" style="width:100%;margin-bottom:12px;font-size:18px;padding:16px" onclick="elderOrder('${t}')">${l}</button>`).join('')}
  <p class="sub">下单后孩子们会收到通知；小额服务直接安排，大额服务孩子确认后再安排。</p>`);
window.elderOrder = async type => {
  try {
    const r = await api('/api/orders', 'POST', { service_type: type, scheduled_at: Date.now() + 2 * 3600e3, notes: '老人自主下单' });
    closeSheet();
    toast(r.need_review ? '✅ 已通知孩子确认，很快安排' : '✅ 已下单，服务人员马上安排', 3500);
  } catch (e) { toast(e.message); }
};
window.elderCall = async () => {
  try {
    const fam = await api('/api/family');
    const kids = fam.members.filter(m => m.role === 'child');
    if (!kids.length) return toast('还没有家人加入');
    sheet('打给谁？', kids.map(k => `<a class="btn" style="display:block;width:100%;margin-bottom:12px;text-align:center;text-decoration:none;font-size:18px" href="tel:${H(k.phone)}" onclick="logContact()">📞 ${H(k.name)}${k.rel ? '（' + H(k.rel) + '）' : ''}</a>`).join(''));
  } catch (e) { toast(e.message); }
};
window.logContact = async () => {
  await api('/api/events', 'POST', { kind: 'contact', data: { type: '电话' } }).catch(() => {});
};

/* ================= 服务商端 ================= */
async function renderProvider() {
  const [orders, prof] = await Promise.all([api('/api/orders'), api('/api/provider/profile')]);
  const p = prof.profile;
  const stLabel = { assigned: '🆕 待接单', accepted: '已接单', in_service: '服务中', done: '已完成', cancelled: '已取消', pending: '待派单' };
  $app.innerHTML = `
    <div class="topbar"><h1>🧑‍⚕️ 服务商工作台</h1><div class="slogan">${H(S.me.name)}｜${H(p?.city || '')}｜评分 ${p?.rating}｜完成 ${p?.jobs} 单</div>
      <div class="right"><span class="me-chip" id="viewSwitch2">切换视图 ▾</span></div></div>
    <div class="card"><h3>我的订单</h3>
      ${orders.orders.length ? orders.orders.map(o => `
        <div class="item">
          <div class="row"><b>${H(SVC[o.service_type]?.label || o.service_type)}</b><span class="tag ${o.status === 'done' ? 'ok' : 'info'}">${stLabel[o.status] || o.status}</span><span class="grow"></span><b>¥${o.price}</b></div>
          <div class="sub">${H(o.elder_name)}（${o.elder_age}岁）｜${fmtT(o.scheduled_at)}｜${H(o.location || '见备注')}</div>
          ${o.notes ? `<div class="sub">备注：${H(o.notes)}</div>` : ''}
          <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap">
            ${o.status === 'assigned' ? `<button class="btn sm" onclick="pAccept(${o.id})">接单</button>` : ''}
            ${o.status === 'accepted' ? `<button class="btn sm" onclick="pProgress(${o.id},'已到达，服务开始')">开始服务</button>` : ''}
            ${['accepted', 'in_service'].includes(o.status) ? `
              <button class="btn sm ghost" onclick="pProgress(${o.id})">📍 同步进展给子女</button>
              <button class="btn sm green" onclick="pComplete(${o.id})">完成服务</button>` : ''}
            ${o.status === 'done' && o.rating ? `<span class="sub">客户评价 ${'⭐'.repeat(o.rating)}</span>` : ''}
          </div>
        </div>`).join('') : '<div class="empty">暂无派单。保持在线，派单引擎按"同城+评分+专长"优先派给您</div>'}
    </div>
    <div class="card sub">💡 陪诊服务 SOP：接单→联系老人确认→提醒携带物品→全程同步子女（候诊/就诊/检查/取药）→医嘱归档→完成。服务期间平台投保意外险。</div>`;
  document.getElementById('viewSwitch2').onclick = switchView;
  pollLoop();
}
window.pAccept = async id => { await api(`/api/orders/${id}/accept`, 'POST'); toast('已接单'); render(); };
window.pProgress = async (id, preset) => {
  const text = preset || prompt('同步给子女的进展（如：已候诊/医生开了检查单/已取药）：');
  if (!text) return;
  await api(`/api/orders/${id}/progress`, 'POST', { text });
  if (!preset) { const o = await api('/api/orders'); render(); }
  toast('已同步给子女');
};
window.pComplete = async id => {
  const summary = prompt('服务总结（可选）：', '服务顺利完成') ?? '';
  const dn = prompt('若是陪诊：填写医嘱摘要归档到医疗档案（可留空）：', '') ?? '';
  await fetch(`/api/orders/${id}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ['Bear','er '].join('') + S.token },
    body: JSON.stringify({ summary, doctor_note: dn }),
  });
  toast('✅ 服务完成'); render();
};

boot();
