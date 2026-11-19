// 来点刺激的 · 网页（首页 / 房间大厅 / 摇骰子）
(() => {
'use strict';
const A = window.LdcApi;
const $ = s => document.querySelector(s);
const app = $('#app'), overlay = $('#overlay'), toastEl = $('#toast');
const Q = new URLSearchParams(location.search);
const PS = A.MOCK && Q.get('p') ? '_p' + Q.get('p') : '';          // 模拟模式下用 &p=2 扮演别的玩家
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const tokKey = code => 'ldc_tok_' + code + PS;
const NAME_KEY = 'ldc_name' + PS;
const ADMIN_KEY = 'ldc_admin';
const GAMES = [
  { id: 'dice', name: '摇骰子', k: '骰', hl: 'hl1' },
  { id: 'truth', name: '真心话<br>大冒险', plain: '真心话大冒险', k: '题', hl: 'hl2' },
  { id: 'king', name: '国王游戏', k: '王', hl: 'hl3' },
  { id: 'bluff', name: '瞎掰王', k: '掰', hl: 'hl1' }
];
const gameName = id => (GAMES.find(g => g.id === id) || {}).plain || (GAMES.find(g => g.id === id) || {}).name || '';
const SKINS = [['night', '深夜'], ['oc', '蜜橙'], ['sakura', '樱粉']];
const ERR = {
  busy: '已经有一个提议在等大家同意', not_ready: '这个游戏还在做，下一版上线', same: '已经在玩这个了', not_paused: '游戏没有暂停',
  bad_target: '现在不能跳过 TA', paused: '游戏暂停中', phase: '已经到下一步了', not_in_round: '这一轮你没参加，下一轮一起',
  already: '你已经摇过了', stale: '这个提议已经结束了', network: '网络不太好，再试一次', not_member: '你已经不在这个房间了',
  not_found: '没有这个房间，检查一下房间号', forbidden: '管理员钥匙不对', bad_name: '名字要 1 到 12 个字', full: '房间满了（最多 16 人）',
  not_installed: '服务器还没装好', server: '服务器出错了，再试一次', no_game: '现在没有在玩游戏', bad_kind: '操作不对', bad_action: '操作不对'
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 状态 ----------
const S = {
  view: 'home', code: null, token: null, data: null, sig: '', offset: 0, lastNotice: null,
  rolling: false, landed: false, menu: false, sheet: null, offline: false, flicked: false, motion: null
};
let unsub = null, pollTimer = null, tickTimer = null, inflight = false, bumpTimer = null;

// ---------- 工具 ----------
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.remove('hide');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.add('hide'), 2600);
}
const me = () => S.data && S.data.me;
const st = () => (S.data && S.data.state) || {};
const players = () => (S.data && S.data.players) || [];
const pname = id => { const p = players().find(x => x.id === id); return p ? p.name : '离开的人'; };
const names = ids => ids.map(pname).join('、');
const onlineIds = () => players().filter(p => p.online).map(p => p.id);
const serverNow = () => Date.now() + S.offset;
function roomLink(code) {
  const u = new URL(location.href); u.search = ''; u.hash = '';
  u.searchParams.set('r', code);
  if (A.MOCK) u.searchParams.set('mock', '1');
  return u.toString();
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (e2) {}
    t.remove(); return ok;
  }
}
function setSkin(k) {
  document.documentElement.dataset.skin = k; LS.set('ldc_skin', k);
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = k === 'night' ? '#1E1033' : k === 'oc' ? '#F3F7FC' : '#FFEAF3';
}
const skinBtn = () => `<button class="icon-btn round" data-act="skin" aria-label="换皮肤" aria-haspopup="true"><span class="skin-dot"></span></button>`;
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const dieHTML = (v, cls = '') => `<div class="die ${cls}" id="die" role="img" aria-label="${v ? v + ' 点' : '骰子'}">${
  Array.from({ length: 9 }, (_, i) => `<span class="${PIPS[v || 6].includes(i) ? 'on' : ''}"></span>`).join('')}</div>`;
function setDieFace(v) {
  const d = $('#die'); if (!d) return;
  [...d.children].forEach((s, i) => s.className = PIPS[v].includes(i) ? 'on' : '');
}

// ---------- 首页 ----------
function homeHTML() {
  const admin = !!LS.get(ADMIN_KEY);
  return `
  <div class="topbar"><div class="grow"></div>${skinBtn()}</div>
  <main class="screen">
    <h1 class="home-title disp hl1 big grad ${S.flicked ? '' : 'flick'}">来点刺激的<span class="spark" style="right:-4px;top:-40px;font-size:30px" aria-hidden="true">✦</span><span class="spark" style="left:4px;bottom:-56px;font-size:18px" aria-hidden="true">✦</span></h1>
    <div class="home-sub disp">来都来了</div>
    <div class="push stack">
      ${admin ? `<div class="row2" style="display:grid;grid-template-columns:1fr auto;gap:10px">
        <button class="btn b3" data-act="admin-create">创建房间</button>
        <button class="btn b3" style="width:auto;padding:16px" data-act="admin-rooms">我建的</button></div>` : ''}
      <div class="room-cap" style="margin:0">房间号</div>
      <label class="code-wrap" aria-label="房间号">
        <div class="code-boxes" id="boxes">${Array.from({ length: 6 }, () => '<b></b>').join('')}</div>
        <input class="code-input" id="codeInput" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" aria-label="输入 6 位房间号">
      </label>
      <div class="err" id="homeErr"></div>
      <button class="btn b1" data-act="join">加入</button>
    </div>
  </main>`;
}
function paintBoxes() {
  const v = ($('#codeInput') || {}).value || '';
  const bs = document.querySelectorAll('#boxes b');
  bs.forEach((b, i) => { b.textContent = v[i] || ''; b.classList.toggle('cur', i === Math.min(v.length, 5) && document.activeElement === $('#codeInput')); });
}

// ---------- 输名字 ----------
function nameHTML() {
  return `
  <div class="topbar"><button class="icon-btn" data-act="home">‹ 首页</button><div class="grow"></div>${skinBtn()}</div>
  <main class="screen">
    <div class="h-cap">房间 ${esc(S.code)}</div>
    <h1 class="h-title disp">你叫什么</h1>
    <div class="stack">
      <input type="text" id="nameInput" class="name-input" maxlength="12" autocomplete="nickname" placeholder="名字" value="${esc(LS.get(NAME_KEY) || '')}"
        style="width:100%;font-size:20px;padding:16px;border-radius:14px;border:1.5px solid var(--line);background:var(--well);color:var(--ink)">
      <div class="err" id="nameErr"></div>
    </div>
    <div class="push"><button class="btn b1" data-act="name-submit">进入</button></div>
  </main>`;
}

// ---------- 房间 ----------
function proposalHTML() {
  const p = st().proposal; if (!p) return '';
  const on = onlineIds(), yes = on.filter(id => p.votes[id]).length;
  const sec = Math.max(0, Math.ceil((p.deadline - serverNow()) / 1000));
  let what = '';
  if (p.kind === 'switch_game') what = p.payload.game ? `想玩${gameName(p.payload.game)}` : '想回大厅';
  else if (p.kind === 'resume') what = '想继续';
  else if (p.kind === 'skip_player') what = `想跳过${esc(pname(p.payload.player))}`;
  else if (p.kind === 'restart_round') what = '想重开这一轮';
  const voted = !!p.votes[me()], mine = p.by === me();
  const btns = mine ? `<button class="no" data-act="vote" data-id="${p.id}" data-yes="0">撤回</button>`
    : voted ? '' : `<button class="yes" data-act="vote" data-id="${p.id}" data-yes="1">同意</button><button class="no" data-act="vote" data-id="${p.id}" data-yes="0">不了</button>`;
  return `<div class="ask" role="alert"><p>${mine ? '你' : esc(pname(p.by))}${what}<span>${yes}/${on.length}，<span data-countdown="${p.deadline}">${sec}</span> 秒</span></p>${btns}</div>`;
}
function peopleHTML() {
  return `<div class="people">${players().map(p => `<span class="p ${p.online ? '' : 'off'} ${p.id === me() ? 'me' : ''}">
    <i class="av${p.seat % 3}">${esc([...p.name][0] || '?')}</i>${esc(p.name)}${p.id === me() ? '<em>我</em>' : ''}</span>`).join('')}</div>`;
}
function lobbyHTML() {
  return `
    <div class="room-cap">房间号</div>
    <div class="room-no disp hl2 ${S.flicked ? '' : 'flick'}">${esc(S.code)}</div>
    <div class="share"><button class="chip" data-act="copy-link">复制链接</button><button class="chip" data-act="share">二维码</button></div>
    ${peopleHTML()}
    <div class="push"></div>
    <div class="games">${GAMES.map(g => {
      const ready = A.GAMES_READY.includes(g.id);
      return `<button class="g ${ready ? '' : 'soon'}" data-act="pick" data-game="${g.id}"><span class="k ${g.hl}">${g.k}</span><h3>${g.name}${ready ? '' : '<small>下一版</small>'}</h3></button>`;
    }).join('')}</div>
    <div class="foot"><button class="link" data-act="rename">改名字</button><button class="link" data-act="leave">离开房间</button></div>`;
}
function diceHTML() {
  const d = st().dice || {}, my = me();
  if (d.phase === 'ready') {
    const on = players().filter(p => p.online);
    const iReady = (d.ready || []).includes(my);
    return `
      <div class="h-cap">摇骰子</div>
      <h1 class="h-title disp">准备</h1>
      <div class="list">${on.map(p => `<div class="row"><span class="who">${esc(p.name)}${p.id === my ? '（我）' : ''}</span>
        <span class="st ${(d.ready || []).includes(p.id) ? 'ok' : ''}">${(d.ready || []).includes(p.id) ? '准备好了' : '还没准备'}</span></div>`).join('')}</div>
      <p class="note">${on.length < 2 ? '至少 2 个人在线才能开始' : '在线的人都准备好就自动开始'}</p>
      <div class="push stack">${iReady ? '<button class="btn b3" data-act="unready">取消准备</button>' : '<button class="btn b1" data-act="ready">准备好了</button>'}</div>`;
  }
  if (d.phase === 'rolling') {
    const inRound = (d.participants || []).includes(my), done = (d.done || []).includes(my);
    const mine = d.results && d.results[my];
    const needPerm = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function' && S.motion !== 'on';
    let top = '';
    if (!inRound) top = `<div class="die-stage">${dieHTML(6, 'blank')}</div><p class="note">这一轮你没参加，下一轮一起</p>`;
    else if (done && !S.rolling) top = `<div class="die-stage">${dieHTML(mine, S.landed ? 'landed' : '')}</div><p class="mine">你摇到了 <b>${mine}</b>，等其他人</p>`;
    else top = `<div class="die-stage">${dieHTML(S.rollFace || 6, S.rolling ? 'rolling' : '')}</div>
      <p class="note">${S.motion === 'on' || (!needPerm && 'DeviceMotionEvent' in window) ? '摇一摇手机，或者点下面' : '点下面掷骰子'}</p>`;
    const rows = (d.participants || []).map(id => {
      const ok = (d.done || []).includes(id);
      const p = players().find(x => x.id === id);
      return `<div class="row"><span class="who">${esc(pname(id))}${id === my ? '（我）' : ''}${p && !p.online ? '<span class="st">（离线）</span>' : ''}</span>
        ${ok ? '<span class="st ok">已摇</span>' : `<span class="st">还没摇</span>${id !== my ? `<button class="mini" data-act="skip" data-pid="${id}">跳过</button>` : ''}`}</div>`;
    }).join('');
    const doneN = (d.done || []).length, all = (d.participants || []).length;
    return `
      <div class="h-cap">第 ${d.round} 轮，${doneN}/${all} 已摇</div>
      <h1 class="h-title disp">摇一摇</h1>
      ${top}
      <div class="list" style="margin-top:14px">${rows}</div>
      <div class="push stack" style="margin-top:16px">
        ${inRound && !done ? `${needPerm ? '<button class="btn b2" data-act="motion">开启摇一摇</button>' : ''}<button class="btn b1" data-act="roll" ${S.rolling ? 'disabled' : ''}>掷骰子</button>` : ''}
      </div>`;
  }
  if (d.phase === 'reveal') {
    const order = [...(d.participants || [])].sort((a, b) => (d.results[b] || 0) - (d.results[a] || 0));
    const rows = order.map(id => {
      const ask = d.askers.includes(id), take = d.takers.includes(id);
      return `<div class="row"><span class="n ${ask ? 'hl1' : take ? 'hl2' : 'dim'}">${d.results[id]}</span><span class="who">${esc(pname(id))}</span>
        ${ask ? '<span class="tag hl1">出题</span>' : take ? '<span class="tag hl2">挑战</span>' : ''}</div>`;
    }).join('');
    const verdict = d.all_same ? '全员一样，再摇一轮吧' : `${esc(names(d.askers))} 出题，${esc(names(d.takers))} 挑战`;
    return `
      <div class="h-cap">第 ${d.round} 轮</div>
      <h1 class="h-title disp">点数揭晓</h1>
      <div class="list reveal">${rows}</div>
      <p class="verdict">${verdict}</p>
      <div class="push stack">
        ${d.all_same ? '<button class="btn b1" data-act="next-round">再摇一轮</button>'
          : '<button class="btn b1" data-act="pick" data-game="truth">去真心话大冒险</button><button class="btn b2" data-act="next-round">再摇一轮</button>'}
      </div>`;
  }
  return '';
}
function roomHTML() {
  const s = st();
  const inGame = !!s.game;
  const body = !inGame ? lobbyHTML() : s.game === 'dice' ? diceHTML() : '';
  return `
  <div class="topbar">
    ${inGame ? '<button class="icon-btn" data-act="back-lobby">‹ 大厅</button>' : `<span class="st" style="font-size:13px;color:var(--muted)">${players().filter(p => p.online).length} 人在线</span>`}
    <div class="grow"></div>
    ${inGame && !s.paused ? '<button class="icon-btn" data-act="pause">暂停</button>' : ''}
    ${inGame ? '<button class="icon-btn" data-act="share">邀请</button>' : ''}
    ${skinBtn()}
  </div>
  ${S.offline ? '<div class="offline-bar">网络断了，正在重连…</div>' : ''}
  ${s.paused ? '' : proposalHTML()}
  <main class="screen">${body}</main>
  ${s.paused ? `<div class="paused"><div class="card">
      <h2 class="disp">暂停中</h2>
      <p class="note" style="margin:0">${esc(pname(s.paused_by))}暂停了</p>
      ${proposalHTML() || '<button class="btn b1" data-act="resume">继续</button>'}
    </div></div>` : ''}`;
}

// ---------- 弹层 ----------
function sheetHTML() {
  const sh = S.sheet; if (!sh) return '';
  let inner = '';
  if (sh.type === 'share') {
    let qr = '';
    try { const q = window.qrcode(0, 'M'); q.addData(roomLink(S.code)); q.make(); qr = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); } catch (e) {}
    inner = `<h2>邀请朋友</h2><div class="big-code disp">${esc(S.code)}</div>
      ${qr ? `<div class="qr">${qr}</div>` : ''}<div class="url">${esc(roomLink(S.code))}</div>
      <button class="btn b1" data-act="copy-link">复制链接</button><button class="btn b3" data-act="close">关闭</button>`;
  } else if (sh.type === 'created') {
    inner = `<h2>房间建好了</h2><div class="big-code disp">${esc(sh.code)}</div><p>把房间号或者链接发给朋友。你想玩也要点「进入」，和大家一样。</p>
      <div class="row2"><button class="btn b3" data-act="copy-code-link" data-code="${esc(sh.code)}">复制链接</button><button class="btn b1" data-act="enter" data-code="${esc(sh.code)}">进入</button></div>
      <button class="link" data-act="close">关闭</button>`;
  } else if (sh.type === 'rooms') {
    inner = `<h2>我建的房间</h2>${sh.rooms.length ? `<div class="rooms">${sh.rooms.map(r => `<button data-act="enter" data-code="${esc(r.code)}">
      <b>${esc(r.code)}</b><span>${r.players} 人${r.online ? `，${r.online} 人在线` : ''}${r.game ? `，${gameName(r.game)}` : ''}</span>›</button>`).join('')}</div>` : '<p>还没有建过房间</p>'}
      <button class="btn b3" data-act="close">关闭</button>`;
  } else if (sh.type === 'rename') {
    const my = players().find(p => p.id === me());
    inner = `<h2>改名字</h2><input type="text" id="renameInput" maxlength="12" value="${esc(my ? my.name : '')}">
      <div class="row2"><button class="btn b3" data-act="close">取消</button><button class="btn b1" data-act="rename-save">保存</button></div>`;
  } else if (sh.type === 'leave') {
    inner = `<h2>离开房间？</h2><p>用这台手机再打开链接，会回到原来的身份。</p>
      <div class="row2"><button class="btn b3" data-act="close">取消</button><button class="btn b1" data-act="leave-yes">离开</button></div>`;
  }
  return `<div class="sheet-bg" data-act="close-bg"><div class="sheet" role="dialog" aria-modal="true">${inner}</div></div>`;
}
function menuHTML() {
  if (!S.menu) return '';
  const cur = document.documentElement.dataset.skin;
  return `<div class="menu" role="menu">${SKINS.map(([k, n]) => `<button role="menuitemradio" aria-checked="${k === cur}" data-act="set-skin" data-skin="${k}">
    <i style="background:${k === 'night' ? 'linear-gradient(135deg,#FF4FA3 50%,#3EE6E0 50%)' : k === 'oc' ? 'linear-gradient(135deg,#FF9A3C 50%,#104E8B 50%)' : 'linear-gradient(135deg,#FFCEE3 0 33%,#678EC9 33% 66%,#262277 66%)'}"></i>${n}</button>`).join('')}</div>`;
}
function renderOverlay() { overlay.innerHTML = sheetHTML() + menuHTML(); }

// ---------- 渲染 ----------
function render() {
  const keepCode = $('#codeInput') ? $('#codeInput').value : '';
  app.innerHTML = S.view === 'home' ? homeHTML() : S.view === 'name' ? nameHTML() : S.view === 'room' ? roomHTML() : '';
  if (S.view === 'home') { const i = $('#codeInput'); if (i) { i.value = keepCode; paintBoxes(); } }
  S.flicked = true;
  renderOverlay();
}

// ---------- 房间数据 ----------
function setData(d) {
  if (!d || !d.players) return false;
  if (S.data && d.version < S.data.version) return false;
  S.offset = (d.now || Date.now()) - Date.now();
  const sig = JSON.stringify([d.version, d.players, d.state]);
  const first = !S.data;
  S.data = d;
  const n = d.state && d.state.notice;
  if (n && n.at !== S.lastNotice) {
    if (!first && S.lastNotice !== null) toast(noticeText(n));
    S.lastNotice = n.at;
  } else if (first) S.lastNotice = n ? n.at : 0;
  if (sig !== S.sig || S.view !== 'room') { S.sig = sig; S.view = 'room'; render(); }
  return true;
}
function noticeText(n) {
  const by = n.by === me() ? '你' : pname(n.by);
  switch (n.kind) {
    case 'switch_game': return n.ok ? (n.payload && n.payload.game ? `开始${gameName(n.payload.game)}` : '回到大厅了') : `${by}不同意，继续现在的`;
    case 'pause': return `${by}暂停了游戏`;
    case 'resume': return n.ok ? '继续游戏' : `${by}还不想继续`;
    case 'skip_player': return n.ok ? `这轮跳过了${pname(n.payload && n.payload.player)}` : `${by}不同意跳过`;
    case 'restart_round': return n.ok ? '这一轮重开了' : `${by}不同意重开`;
    default: return '';
  }
}
async function refresh() {
  if (S.view !== 'room' || inflight || !S.code) return;
  inflight = true;
  const r = await A.act(S.code, S.token, 'state', {});
  inflight = false;
  if (r && r.error === 'network') { if (!S.offline) { S.offline = true; render(); } return; }
  if (S.offline) { S.offline = false; S.sig = ''; }
  if (r && r.error === 'not_member') { LS.del(tokKey(S.code)); stopRoom(); S.view = 'name'; render(); return; }
  if (r && r.error === 'not_found') { stopRoom(); goHome('房间不在了'); return; }
  setData(r);
}
async function act(action, args, quiet) {
  const r = await A.act(S.code, S.token, action, args || {});
  if (r && r.players) setData(r);
  if (r && r.ok === false && !quiet) toast(ERR[r.error] || '出错了');
  if (r && r.ok !== false) A.bump(S.code);
  return r;
}
function startRoom() {
  stopRoom();
  unsub = A.subscribe(S.code, () => { clearTimeout(bumpTimer); bumpTimer = setTimeout(refresh, 120); });
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 3000);
  tickTimer = setInterval(tick, 500);
}
function stopRoom() {
  if (unsub) unsub(); unsub = null;
  clearInterval(pollTimer); clearInterval(tickTimer); pollTimer = tickTimer = null;
}
function tick() {
  let expired = false;
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const left = +el.dataset.countdown - serverNow();
    el.textContent = Math.max(0, Math.ceil(left / 1000));
    if (left < -300) expired = true;
  });
  if (expired) refresh();
}

// ---------- 页面跳转 ----------
function goHome(err) {
  stopRoom(); S.view = 'home'; S.code = null; S.data = null; S.sig = ''; S.sheet = null;
  const u = new URL(location.href); u.searchParams.delete('r'); history.replaceState(null, '', u);
  render();
  if (err) { const e = $('#homeErr'); if (e) e.textContent = err; }
}
async function enterRoom(code) {
  S.code = code; S.data = null; S.sig = ''; S.lastNotice = null; S.sheet = null;
  const u = new URL(location.href); u.searchParams.set('r', code); history.replaceState(null, '', u);
  const tok = LS.get(tokKey(code));
  if (tok) {
    const r = await A.join(code, '', tok);
    if (r.ok) { S.token = tok; setData(r); startRoom(); return; }
    if (r.error === 'not_found') { goHome(ERR.not_found); return; }
    if (r.error === 'network') { goHome(ERR.network); return; }
    LS.del(tokKey(code));
  } else {
    // 不带名字调用一次：房间不存在会返回 not_found，存在会返回 bad_name
    const r = await A.join(code, '', null);
    if (r.error === 'not_found') { goHome(ERR.not_found); return; }
    if (r.error === 'network') { goHome(ERR.network); return; }
  }
  S.view = 'name'; render();
  const i = $('#nameInput'); if (i && !i.value) i.focus();
}
async function submitName() {
  const i = $('#nameInput'), e = $('#nameErr'), n = (i.value || '').trim();
  if (!n || [...n].length > 12) { e.textContent = ERR.bad_name; return; }
  const r = await A.join(S.code, n, null);
  if (!r.ok) { e.textContent = ERR[r.error] || '出错了'; if (r.error === 'not_found') goHome(ERR.not_found); return; }
  LS.set(NAME_KEY, n); LS.set(tokKey(S.code), r.token); S.token = r.token;
  setData(r); startRoom(); A.bump(S.code);
}

// ---------- 摇骰子 ----------
let rollAnim = null;
async function doRoll() {
  const d = st().dice || {};
  if (S.rolling || d.phase !== 'rolling' || !(d.participants || []).includes(me()) || (d.done || []).includes(me())) return;
  S.rolling = true; S.landed = false; S.rollFace = 1 + Math.floor(Math.random() * 6); render();
  if (navigator.vibrate) try { navigator.vibrate(30); } catch (e) {}
  rollAnim = setInterval(() => { S.rollFace = 1 + Math.floor(Math.random() * 6); setDieFace(S.rollFace); }, 90);
  const [r] = await Promise.all([A.act(S.code, S.token, 'roll', {}), new Promise(res => setTimeout(res, 800))]);
  clearInterval(rollAnim); S.rolling = false; S.rollFace = null;
  if (r && r.value) { S.landed = true; setTimeout(() => { S.landed = false; }, 500); }
  if (r && r.players) { S.sig = ''; setData(r); } else render();
  if (r && r.ok === false && r.error !== 'already') toast(ERR[r.error] || '出错了');
  if (r && r.ok !== false) A.bump(S.code);
  if (navigator.vibrate && r && r.value) try { navigator.vibrate([20, 40, 20]); } catch (e) {}
}
// 摇晃检测：只是触发方式，点数由服务器决定
let lastAcc = null, shakeHits = [], motionBound = false;
function onMotion(e) {
  const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
  if (lastAcc) {
    const delta = Math.abs(a.x - lastAcc.x) + Math.abs(a.y - lastAcc.y) + Math.abs(a.z - lastAcc.z);
    const now = Date.now();
    if (delta > 24) { shakeHits = shakeHits.filter(t => now - t < 600); shakeHits.push(now); if (shakeHits.length >= 3) { shakeHits = []; doRoll(); } }
  }
  lastAcc = { x: a.x, y: a.y, z: a.z };
}
function bindMotion() { if (motionBound || !('DeviceMotionEvent' in window)) return; window.addEventListener('devicemotion', onMotion); motionBound = true; }
async function askMotion() {
  try {
    const r = await DeviceMotionEvent.requestPermission();
    if (r === 'granted') { S.motion = 'on'; bindMotion(); toast('摇一摇已开启'); } else { S.motion = 'off'; toast('没开权限，点按钮也一样'); }
  } catch (e) { S.motion = 'off'; toast('这台手机不支持摇一摇，点按钮就行'); }
  S.sig = ''; render();
}

// ---------- 事件 ----------
app.addEventListener('input', e => {
  if (e.target.id === 'codeInput') { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); paintBoxes(); const er = $('#homeErr'); if (er) er.textContent = ''; }
});
app.addEventListener('focusin', e => { if (e.target.id === 'codeInput') paintBoxes(); });
app.addEventListener('focusout', e => { if (e.target.id === 'codeInput') setTimeout(paintBoxes, 0); });
app.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'codeInput') handle('join');
  if (e.target.id === 'nameInput') handle('name-submit');
});
overlay.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.id === 'renameInput') handle('rename-save'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { S.menu = false; S.sheet = null; renderOverlay(); } });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) { if (S.menu) { S.menu = false; renderOverlay(); } return; }
  if (b.dataset.act === 'close-bg' && e.target !== b) return;
  handle(b.dataset.act, b.dataset, b);
});

const busy = new Set();
async function handle(a, ds = {}, el) {
  if (a !== 'skin' && S.menu) { S.menu = false; renderOverlay(); }
  if (busy.has(a)) return;
  busy.add(a); if (el && el.tagName === 'BUTTON' && !['skin', 'set-skin', 'close', 'close-bg'].includes(a)) el.disabled = true;
  try {
    switch (a) {
      case 'skin': S.menu = !S.menu; renderOverlay(); break;
      case 'set-skin': setSkin(ds.skin); S.menu = false; renderOverlay(); break;
      case 'home': goHome(); break;
      case 'join': {
        const v = ($('#codeInput') || {}).value || '';
        if (!/^\d{6}$/.test(v)) { $('#homeErr').textContent = '房间号是 6 位数字'; break; }
        await enterRoom(v); break;
      }
      case 'name-submit': await submitName(); break;
      case 'admin-create': {
        const r = await A.createRoom(LS.get(ADMIN_KEY));
        if (!r.ok) { toast(ERR[r.error] || '出错了'); if (r.error === 'forbidden') { LS.del(ADMIN_KEY); render(); } break; }
        S.sheet = { type: 'created', code: r.code }; renderOverlay(); break;
      }
      case 'admin-rooms': {
        const r = await A.adminRooms(LS.get(ADMIN_KEY));
        if (!r.ok) { toast(ERR[r.error] || '出错了'); break; }
        S.sheet = { type: 'rooms', rooms: r.rooms }; renderOverlay(); break;
      }
      case 'enter': S.sheet = null; renderOverlay(); await enterRoom(ds.code); break;
      case 'copy-code-link': toast(await copy(roomLink(ds.code)) ? '链接已复制' : '复制不了，长按房间号自己复制'); break;
      case 'copy-link': toast(await copy(roomLink(S.code)) ? '链接已复制' : '复制不了，长按地址自己复制'); break;
      case 'share': S.sheet = { type: 'share' }; renderOverlay(); break;
      case 'close': case 'close-bg': S.sheet = null; renderOverlay(); break;
      case 'pick': {
        if (!A.GAMES_READY.includes(ds.game)) { toast(ERR.not_ready); break; }
        await act('propose', { kind: 'switch_game', payload: { game: ds.game } }); break;
      }
      case 'back-lobby': await act('propose', { kind: 'switch_game', payload: { game: null } }); break;
      case 'vote': await act('vote', { id: ds.id, yes: ds.yes === '1' }); break;
      case 'pause': await act('pause'); break;
      case 'resume': await act('propose', { kind: 'resume' }); break;
      case 'ready': await act('ready'); break;
      case 'unready': await act('unready'); break;
      case 'roll': await doRoll(); break;
      case 'motion': await askMotion(); break;
      case 'next-round': S.landed = false; await act('next_round'); break;
      case 'skip': await act('propose', { kind: 'skip_player', payload: { player: ds.pid } }); break;
      case 'rename': S.sheet = { type: 'rename' }; renderOverlay(); setTimeout(() => { const i = $('#renameInput'); if (i) i.focus(); }, 50); break;
      case 'rename-save': {
        const n = ($('#renameInput').value || '').trim();
        const r = await A.rename(S.code, S.token, n);
        if (!r.ok) { toast(ERR[r.error] || '出错了'); break; }
        LS.set(NAME_KEY, n); S.sheet = null; renderOverlay(); setData(r); A.bump(S.code); break;
      }
      case 'leave': S.sheet = { type: 'leave' }; renderOverlay(); break;
      case 'leave-yes': { await A.leave(S.code, S.token); A.bump(S.code); goHome(); break; }
    }
  } finally {
    busy.delete(a);
    if (el && el.isConnected) el.disabled = false;
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('online', refresh);

// ---------- 启动 ----------
function readAdminHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.get('admin')) return false;
  LS.set(ADMIN_KEY, h.get('admin'));
  history.replaceState(null, '', location.pathname + location.search);
  setTimeout(() => toast('这个浏览器已经可以创建房间'), 300);
  return true;
}
window.addEventListener('hashchange', () => { if (readAdminHash() && S.view === 'home') render(); });
(function boot() {
  readAdminHash();
  if (!(typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')) bindMotion();
  const r = Q.get('r');
  if (r && /^\d{6}$/.test(r)) enterRoom(r);
  else { S.view = 'home'; render(); }
})();

window.LdcApp = { S, handle, refresh };
})();
