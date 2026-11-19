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
  not_yours: '现在不是你来操作', empty: '这个分类没有题了', bad_code: '房间号要 6 位数字', code_taken: '这个房间号已经有了',
  king_people: '至少两位玩家在线才能开始', king_numbers: '请选择有效的挑战号码', king_text: '命令要写 1 到 200 个字',
  king_offline: '有相关玩家离线，可以等 TA 回来或重新安排本轮',
  need3: '至少 3 个人在线才能玩', not_installed: '服务器还没装好', server: '服务器出错了，再试一次', no_game: '现在没有在玩游戏', bad_kind: '操作不对', bad_action: '操作不对'
};
const TTYPES = [{ id: 'truth', name: '真心话', hl: 'hl1' }, { id: 'dare', name: '大冒险', hl: 'hl2' }, { id: 'quiz', name: '智力问答', hl: 'hl3' }];
const TCATS = {
  truth: ['感情隐私', '个人糗事', '友情关系', '秘密心事', '大胆提问'],
  dare: ['搞怪表演', '社交挑战', '互动任务', '动作挑战', '随机整活'],
  quiz: ['明星娱乐', '影视动漫', '生活常识', '脑筋急转弯', '逻辑推理', '朋友默契']
};
const TIMERS = [[0, '不限'], [15, '15 秒'], [30, '30 秒'], [60, '60 秒'], [120, '2 分钟']];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 状态 ----------
const S = {
  view: 'home', code: null, token: null, data: null, sig: '', offset: 0, lastNotice: null,
  tType: 'truth', tCat: '',
  kingPlayer: 'random', kingDraft: { key: null, text: '', numbers: [] },
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
// 打过字之后重新加载一次页面再进房间：清掉 iPhone「摇动以撤销」的撤销记录，摇骰子时就不会弹「撤销键入」
function cleanEnter(code) {
  const u = new URL(location.href); u.hash = '';
  u.searchParams.set('r', code);
  try { (document.activeElement || {}).blur && document.activeElement.blur(); } catch (e) {}
  location.replace(u.toString());
}
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
  else if (p.kind === 'king_start') what = `提议${p.payload.player === 'random' ? '随机选国王' : `让${esc(pname(p.payload.player))}当国王`} · ${p.payload.mode === 'public' ? '公开编号' : '秘密编号'}`;
  else if (p.kind === 'king_redeal') what = '想重新发编号';
  else if (p.kind === 'king_skip') what = '想跳过当前命令';
  else if (p.kind === 'bluff_redraw') what = '想换题（身份重新分）';
  else if (p.kind === 'bluff_void') what = '想让这轮作废';
  else if (p.kind === 'restart_round') what = st().game === 'truth' ? '想换个玩法' : st().game === 'bluff' ? '想改设置' : '想重开这一轮';
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
    let top = '';
    if (!inRound) top = `<div class="die-stage">${dieHTML(6, 'blank')}</div><p class="note">这一轮你没参加，下一轮一起</p>`;
    else if (done && !S.rolling) top = `<div class="die-stage">${dieHTML(mine, S.landed ? 'landed' : '')}</div><p class="mine">你摇到了 <b>${mine}</b>，等其他人</p>`;
    else top = `<div class="die-stage">${dieHTML(S.rollFace || 6, S.rolling ? 'rolling' : '')}</div>
      <p class="note">${motionNote()}</p>`;
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
        ${inRound && !done ? `<button class="btn b1" data-act="roll" ${S.rolling ? 'disabled' : ''}>掷骰子</button>` : ''}
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
          : '<button class="btn b1" data-act="to-truth">去真心话大冒险</button><button class="btn b2" data-act="next-round">再摇一轮</button>'}
      </div>`;
  }
  return '';
}
// ---------- 真心话大冒险 ----------
const tDoers = t => t.mode === 'turns' && t.order.length ? [t.order[t.turn]] : t.mode === 'dice' ? (t.takers || []) : [];
function tCan(t, kind) {
  const on = onlineIds();
  const a = (kind === 'chooser' && t.mode === 'dice' ? t.askers : tDoers(t)).filter(x => on.includes(x));
  return a.length === 0 || a.includes(me());
}
const tActors = (t, kind) => (kind === 'chooser' && t.mode === 'dice' ? t.askers : tDoers(t));
const typeName = id => (TTYPES.find(x => x.id === id) || {}).name || '';
function timerText(t) {
  if (typeof t.timer_left === 'number') return `${Math.ceil(t.timer_left / 1000)} 秒（暂停中）`;
  if (typeof t.timer_end !== 'number') return '';
  const left = t.timer_end - serverNow();
  return left > 0 ? `${Math.ceil(left / 1000)} 秒` : '时间到';
}
function truthHTML() {
  const t = st().truth || {}, my = me();
  const youOr = ids => ids.length === 1 && ids[0] === my ? '你' : esc(names(ids));
  if (t.phase === 'setup') {
    return `
      <div class="h-cap">真心话大冒险</div>
      <h1 class="h-title disp">怎么玩</h1>
      <div class="stack">
        <button class="g wide" data-act="t-start" data-mode="free"><span class="k hl1">抽</span><h3>自由抽题<small>抽到什么，大家自己定谁来</small></h3></button>
        <button class="g wide" data-act="t-start" data-mode="turns" data-order="seat"><span class="k hl2">轮</span><h3>轮流挑战<small>按进房间的顺序</small></h3></button>
        <button class="g wide" data-act="t-start" data-mode="turns" data-order="random"><span class="k hl3">乱</span><h3>随机顺序轮流<small>每一圈重新打乱</small></h3></button>
      </div>`;
  }
  if (t.phase === 'choose') {
    const can = tCan(t, 'chooser');
    const doers = tDoers(t), choosers = tActors(t, 'chooser');
    const cap = t.mode === 'turns' ? `第 ${t.lap || 1} 圈` : t.mode === 'dice' ? `第 ${t.round} 轮骰子的惩罚` : '自由抽题';
    const title = t.mode === 'turns' ? `轮到${youOr(doers)}` : t.mode === 'dice' ? `${youOr(doers)}接受挑战` : '抽一题';
    const who = t.mode === 'dice' ? `${youOr(choosers)}来选题` : '';
    const cats = TCATS[S.tType] || [];
    return `
      <div class="h-cap">${cap}</div>
      <h1 class="h-title disp">${title}</h1>
      ${who ? `<p class="note" style="text-align:left;margin:-8px 0 12px">${who}</p>` : ''}
      <div class="types">${TTYPES.map(x => `<button class="type ${S.tType === x.id ? 'on' : ''}" data-act="t-type" data-type="${x.id}" ${can ? '' : 'disabled'}><span class="disp ${x.hl}">${x.name}</span></button>`).join('')}</div>
      <div class="chips">${['', ...cats].map(c => `<button class="chip ${S.tCat === c ? 'on' : ''}" data-act="t-cat" data-cat="${esc(c)}" ${can ? '' : 'disabled'}>${c || '随机'}</button>`).join('')}</div>
      <div class="timer-row"><span>计时</span>${TIMERS.map(([v, n]) => `<button class="chip ${(t.timer || 0) === v ? 'on' : ''}" data-act="t-timer" data-secs="${v}">${n}</button>`).join('')}</div>
      <div class="push stack">
        ${can ? '<button class="btn b1" data-act="t-draw">抽一题</button>' : `<p class="note">等${esc(names(choosers.filter(x => onlineIds().includes(x))))}选题</p>`}
        ${t.mode !== 'dice' ? '<button class="link" data-act="t-restart">换个玩法</button>' : ''}
      </div>`;
  }
  if (t.phase === 'question' && t.q) {
    const q = t.q, canDo = tCan(t, 'doer'), canChoose = tCan(t, 'chooser'), doers = tDoers(t);
    const tt = timerText(t);
    let extra = '';
    if (q.type === 'quiz' && q.has_answer && !t.show_answer) extra += '<button class="btn b3" data-act="t-answer">看答案</button>';
    if (t.show_answer && q.answer) extra += `<div class="answer"><b>答案</b>${esc(q.answer)}${q.explain ? `<small>${esc(q.explain)}</small>` : ''}</div>`;
    if (q.target) {
      const targetOn = onlineIds().includes(q.target);
      if (t.verdict) extra += `<div class="answer"><b>${esc(pname(q.target))}说</b>${t.verdict === 'right' ? '答对了' : '答错了'}</div>`;
      else if (q.target === my || !targetOn) extra += `<p class="note">${q.target === my ? '你来判断' : `${esc(pname(q.target))}不在线，大家来判断`}</p><div class="row2"><button class="btn b3" data-act="t-verdict" data-right="1">答对了</button><button class="btn b3" data-act="t-verdict" data-right="0">答错了</button></div>`;
      else extra += `<p class="note">由${esc(pname(q.target))}判断对不对</p>`;
    }
    return `
      <div class="h-cap">${typeName(q.type)}，${esc(q.cat)}</div>
      <h1 class="h-title disp">${doers.length ? `${youOr(doers)}${q.type === 'dare' ? '来挑战' : '来回答'}` : typeName(q.type)}</h1>
      <div class="qcard"><p>${esc(q.text)}</p>${tt ? `<div class="timer" data-timer>${tt}</div>` : ''}</div>
      <div class="stack" style="margin-top:14px">${extra}</div>
      <div class="push stack" style="margin-top:16px">
        ${canDo ? '<button class="btn b1" data-act="t-done">完成</button>' : `<p class="note">等${esc(names(doers))}完成</p>`}
        <div class="row2">
          ${canChoose ? '<button class="btn b3" data-act="t-redraw">换一题</button>' : '<span></span>'}
          ${canDo ? '<button class="btn b3" data-act="t-skip">跳过</button>' : '<span></span>'}
        </div>
      </div>`;
  }
  if (t.phase === 'done') {
    const l = t.last || {};
    return `
      <div class="h-cap">第 ${t.round} 轮骰子的惩罚</div>
      <h1 class="h-title disp">${l.skipped ? '跳过了' : '挑战完成'}</h1>
      ${l.text ? `<div class="qcard dim-card"><p>${esc(l.text)}</p></div>` : ''}
      <div class="push stack">
        <button class="btn b1" data-act="t-back-dice">再摇一轮</button>
        <button class="btn b3" data-act="back-lobby">回大厅</button>
      </div>`;
  }
  return '';
}

function kingHTML() {
  const k = st().king;
  if (!k) return '';
  const online = onlineIds();
  if (k.phase === 'setup') {
    const options = players().filter(p => p.online).map(p =>
      `<option value="${esc(p.id)}"${S.kingPlayer === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    return `<div class="h-cap">国王游戏</div><h1 class="h-title disp">谁来当国王</h1>
      <div class="stack">
        <label class="stack">本轮国王<select id="kingPlayer" class="king-field"><option value="random">随机选人</option>${options}</select></label>
        <p class="note">至少两位玩家在线。选定编号方式后，由大家确认开局。</p>
        <button class="btn b1" data-act="k-start" data-mode="secret" ${online.length < 2 ? 'disabled' : ''}>秘密编号</button>
        <button class="btn b3" data-act="k-start" data-mode="public" ${online.length < 2 ? 'disabled' : ''}>公开编号</button>
      </div>`;
  }
  const isKing = k.king === me();
  const myNumber = k.numbers[me()];
  const numbers = k.mode === 'public'
    ? `<div class="chips">${Object.entries(k.numbers).sort((a, b) => a[1] - b[1])
        .map(([id, n]) => `<span class="chip">${n}号 · ${esc(pname(id))}</span>`).join('')}</div>`
    : myNumber ? `<p class="note">只有你能看到自己的编号：${myNumber}号</p>` : '';
  const head = `<div class="h-cap">国王游戏 · 第 ${k.round} 轮</div>
    <h1 class="h-title disp">${isKing ? '你是国王' : `${esc(pname(k.king))}是国王`}</h1>${numbers}`;
  const restart = '<button class="link" data-act="k-restart">重新指定国王</button>';
  if (k.phase === 'command') {
    const draft = S.kingDraft;
    const buttons = Array.from({ length: k.size }, (_, i) => i + 1).map(n =>
      `<button class="chip ${draft.numbers.includes(n) ? 'on' : ''}" aria-pressed="${draft.numbers.includes(n)}" data-act="k-num" data-num="${n}">${n}号</button>`).join('');
    return head + (isKing ? `<div class="stack king-controls">
      <div>选择一个或多个号码<div class="chips">${buttons}</div></div>
      <label class="stack">自写命令<textarea id="kingText" class="king-field" rows="3" maxlength="200" placeholder="写下要完成的挑战">${esc(draft.text)}</textarea></label>
      <button class="btn b1" data-act="k-publish" data-type="custom">发布命令</button>
      <div>或从题库抽一题<div class="chips">${TTYPES.map(x => `<button class="chip" data-act="k-publish" data-type="${x.id}">${x.name}</button>`).join('')}</div></div>
    </div>` : '<p class="note">等国王发布命令</p>') +
      `<div class="push stack"><button class="link" data-act="k-redeal" ${online.length < 2 || !online.includes(k.king) ? 'disabled' : ''}>重新发编号</button>${restart}</div>`;
  }
  const myTask = k.targets.includes(me()), q = k.q;
  const task = `<div class="qcard king-controls"><p>${esc(q.text)}</p></div>
    <div class="chips">${k.targets.map(id => `<span class="chip">${esc(pname(id))} · ${k.results[id] === 'done' ? '已完成' : k.results[id] === 'skip' ? '已跳过' : '等待挑战'}</span>`).join('')}</div>
    ${k.show_answer && q.answer ? `<div class="answer"><b>答案</b>${esc(q.answer)}${q.explain ? `<small>${esc(q.explain)}</small>` : ''}</div>` : ''}`;
  if (k.phase === 'challenge') {
    return head + task + `<div class="push stack">
      ${!k.show_answer && q.has_answer && (isKing || myTask) ? '<button class="btn b3" data-act="k-answer">看答案</button>' : ''}
      ${myTask && !k.results[me()] ? '<div class="row2"><button class="btn b1" data-act="k-result" data-result="done">完成挑战</button><button class="btn b3" data-act="k-result" data-result="skip">我跳过</button></div>' : ''}
      <button class="link" data-act="k-skip">提议跳过整道命令</button>${restart}</div>`;
  }
  const eligible = k.targets.filter(id => k.results[id] === 'done' && online.includes(id));
  const canPick = isKing || (!online.includes(k.king) && Boolean(myNumber));
  return head + task + `<div class="push stack">
    <p class="note">${eligible.length && online.length >= 2 ? canPick ? '从已完成挑战的人中选下一任国王' : '等国王交接' : '等待完成挑战的玩家上线，或重新指定国王'}</p>
    ${canPick && eligible.length && online.length >= 2 ? `<div class="chips">${eligible.map(id =>
      `<button class="chip" data-act="k-next" data-player="${esc(id)}">${esc(pname(id))}接任</button>`).join('')}</div>
      ${eligible.length > 1 ? '<button class="btn b1" data-act="k-next" data-player="random">随机选下一任</button>' : ''}` : ''}
    ${restart}</div>`;
}

// ---------- 瞎掰王 ----------
const BMODES = [{ id: 'knowledge', name: '知识瞎掰', sub: '只有老实人知道答案', hl: 'hl1' }, { id: 'story', name: '故事瞎掰', sub: '老实人讲真事', hl: 'hl2' }];
const BTIMERS = [[0, '不限'], [30, '30 秒'], [60, '60 秒'], [90, '90 秒']];
const ROLE_NAME = { smart: '大聪明', honest: '老实人', bluffer: '瞎掰人' };
function roleTip(role, mode) {
  if (role === 'smart') return '听大家讲，找出唯一的老实人';
  if (role === 'honest') return mode === 'knowledge' ? '你能看到答案，照实说' : '讲一件真实发生过的事';
  if (role === 'bluffer') return mode === 'knowledge' ? '你看不到答案，编一个像真的' : '编一个没发生过的事';
  return '这一轮你在旁边看';
}
function bluffScores(b) {
  const sc = b.scores || {}, ids = Object.keys(sc);
  if (!b.scoring || !ids.length) return '';
  ids.sort((x, y) => sc[y] - sc[x]);
  return `<div class="h-cap" style="margin-top:18px">总分</div><div class="list">${ids.map(id => `<div class="row"><span class="who">${esc(pname(id))}${id === me() ? '（我）' : ''}</span><span class="n" style="font-size:26px;width:auto">${sc[id]}</span></div>`).join('')}</div>`;
}
function bluffMine(b) {
  const my = me(), role = b.smart === my ? 'smart' : (b.roles || {})[my];
  const q = b.q || {};
  let html = `<p class="mine-role"><span class="rtag r-${role || 'none'}">${role ? '你是' + ROLE_NAME[role] : '你在旁边看'}</span>${role ? roleTip(role, b.mode) : ''}</p>`;
  if (role === 'honest' && q.answer) html += `<div class="answer"><b>答案（只有你看得到）</b>${esc(q.answer)}${q.explain ? `<small>${esc(q.explain)}</small>` : ''}</div>`;
  return html;
}
function bluffHTML() {
  const b = st().bluff || {}, my = me();
  const inRound = (b.players || []).includes(my), isSmart = b.smart === my;
  const youOr = id => id === my ? '你' : esc(pname(id));
  const links = (redraw) => `<div class="foot">${redraw ? '<button class="link" data-act="b-redraw">换题</button>' : ''}<button class="link" data-act="b-void">这轮作废</button></div>`;
  if (b.phase === 'setup') {
    const on = onlineIds().length;
    return `
      <div class="h-cap">瞎掰王</div>
      <h1 class="h-title disp">设置</h1>
      <div class="bmodes">${BMODES.map(m => `<button class="type ${b.mode === m.id ? 'on' : ''}" data-act="b-mode" data-mode="${m.id}"><span class="disp ${m.hl}">${m.name}</span><small>${m.sub}</small></button>`).join('')}</div>
      <div class="timer-row"><span>每人发言</span>${BTIMERS.map(([v, n]) => `<button class="chip ${(b.timer || 0) === v ? 'on' : ''}" data-act="b-timer" data-secs="${v}">${n}</button>`).join('')}</div>
      <div class="timer-row"><span>计分</span><button class="chip ${b.scoring !== false ? 'on' : ''}" data-act="b-score" data-on="1">开</button><button class="chip ${b.scoring === false ? 'on' : ''}" data-act="b-score" data-on="0">关</button></div>
      ${bluffScores(b)}
      <div class="push stack">
        ${on < 3 ? '<p class="note">至少 3 个人在线才能开始</p>' : ''}
        <button class="btn b1" data-act="b-start" ${on < 3 ? 'disabled' : ''}>开始</button>
      </div>`;
  }
  if (b.phase === 'recruit') {
    const want = b.want || {};
    const rows = (b.players || []).map(id => `<div class="row"><span class="who">${esc(pname(id))}${id === my ? '（我）' : ''}</span>
      <span class="st ${want[id] === true ? 'ok' : ''}">${want[id] === true ? '想当' : want[id] === false ? '不当' : '还没选'}</span></div>`).join('');
    return `
      <div class="h-cap">第 ${b.round} 轮，<span data-countdown="${b.deadline}">${Math.max(0, Math.ceil((b.deadline - serverNow()) / 1000))}</span> 秒</div>
      <h1 class="h-title disp">谁当大聪明</h1>
      <div class="list">${rows}</div>
      <p class="note">有人想当就从里面抽一个，没人想当就随机</p>
      <div class="push stack">${inRound ? `<div class="row2">
        <button class="btn ${want[my] === true ? 'b1' : 'b3'}" data-act="b-want" data-yes="1">我想当</button>
        <button class="btn ${want[my] === false ? 'b1' : 'b3'}" data-act="b-want" data-yes="0">这轮不当</button></div>` : '<p class="note">这一轮你在旁边看</p>'}</div>`;
  }
  if (b.phase === 'roles') {
    const role = isSmart ? 'smart' : (b.roles || {})[my];
    const seen = (b.seen || []).includes(my);
    const on = (b.players || []).filter(id => onlineIds().includes(id));
    return `
      <div class="h-cap">第 ${b.round} 轮，大聪明是${youOr(b.smart)}</div>
      <h1 class="h-title disp">你的身份</h1>
      <div class="rolecard r-${role || 'none'}"><div class="disp">${role ? ROLE_NAME[role] : '旁观'}</div><p>${roleTip(role, b.mode)}</p></div>
      <p class="note">${(b.seen || []).length}/${on.length} 已确认</p>
      <div class="push stack">${inRound && !seen ? '<button class="btn b1" data-act="b-seen">我知道了</button>' : '<p class="note">等其他人确认</p>'}</div>
      ${links(false)}`;
  }
  const q = b.q || {};
  const qcard = `<div class="qcard"><p>${esc(q.text || '')}</p>${b.phase === 'speak' && timerText(b) ? `<div class="timer" data-btimer>${timerText(b)}</div>` : ''}</div>`;
  if (b.phase === 'speak') {
    const cur = b.order[b.cur];
    const rows = b.order.map((id, i) => `<div class="row ${i === b.cur ? 'cur' : ''}"><span class="n" style="font-size:22px;width:28px">${i + 1}</span><span class="who">${esc(pname(id))}${id === my ? '（我）' : ''}</span>
      <span class="st ${i < b.cur ? 'ok' : ''}">${i < b.cur ? ((b.skipped || []).includes(id) ? '跳过了' : '说完了') : i === b.cur ? '正在说' : ''}</span></div>`).join('');
    const offlineBoth = !onlineIds().includes(cur) && !onlineIds().includes(b.smart);
    return `
      <div class="h-cap">${b.mode === 'knowledge' ? '知识瞎掰' : '故事瞎掰'}，${esc(q.cat || '')}</div>
      <h1 class="h-title disp">${youOr(cur)}来说</h1>
      ${qcard}
      ${bluffMine(b)}
      <div class="list" style="margin-top:12px">${rows}</div>
      <div class="push stack" style="margin-top:14px">
        ${cur === my ? '<button class="btn b1" data-act="b-next">说完了</button><button class="link" data-act="b-skip">不想说，跳过</button>'
          : isSmart || offlineBoth ? '<button class="btn b2" data-act="b-next">下一位</button>' : `<p class="note">等${esc(pname(cur))}说完</p>`}
      </div>
      ${links(true)}`;
  }
  if (b.phase === 'ask') {
    const smartOff = !onlineIds().includes(b.smart);
    return `
      <div class="h-cap">大家都说完了</div>
      <h1 class="h-title disp">追问时间</h1>
      ${qcard}
      ${bluffMine(b)}
      <div class="push stack" style="margin-top:14px">
        ${isSmart || smartOff ? '<p class="note">想问谁就问谁，问完去猜</p><button class="btn b1" data-act="b-to-guess">去猜老实人</button>' : `<p class="note">${esc(pname(b.smart))}在追问</p>`}
      </div>
      ${links(true)}`;
  }
  if (b.phase === 'guess') {
    const can = isSmart || !onlineIds().includes(b.smart);
    if (S.bPick && !b.order.includes(S.bPick)) S.bPick = null;
    return `
      <div class="h-cap">${esc(q.text || '')}</div>
      <h1 class="h-title disp">${can ? '谁是老实人' : `${esc(pname(b.smart))}在猜`}</h1>
      <div class="cands">${b.order.map(id => `<button class="cand ${S.bPick === id ? 'on' : ''}" data-act="b-cand" data-pid="${id}" ${can ? '' : 'disabled'}>${esc(pname(id))}${id === my ? '（我）' : ''}</button>`).join('')}</div>
      <div class="push stack">${can ? `<button class="btn b1" data-act="b-pick" ${S.bPick ? '' : 'disabled'}>${S.bPick ? `确定是${esc(pname(S.bPick))}` : '先选一个人'}</button><p class="note">确定后不能改</p>` : ''}</div>
      ${links(false)}`;
  }
  if (b.phase === 'reveal') {
    const roles = b.roles || {};
    const ids = [b.smart, ...(b.order && b.order.length ? b.order : Object.keys(roles))].filter((x, i, a) => x && a.indexOf(x) === i);
    const rows = ids.map(id => {
      const role = id === b.smart ? 'smart' : roles[id];
      const d = (b.delta || {})[id];
      return `<div class="row"><span class="who">${esc(pname(id))}${id === my ? '（我）' : ''}${id === b.pick ? '<span class="st">（被选中）</span>' : ''}</span>
        <span class="rtag r-${role}">${ROLE_NAME[role] || ''}</span>${d ? `<span class="st ok">+${d}</span>` : ''}</div>`;
    }).join('');
    const title = b.void ? '这轮作废' : b.correct ? '猜中了' : '猜错了';
    const sub = b.void ? '不计分' : `${youOr(b.smart)}选了${b.pick ? youOr(b.pick) : '—'}，老实人是${youOr(b.honest)}`;
    return `
      <div class="h-cap">第 ${b.round} 轮</div>
      <h1 class="h-title disp ${b.void ? '' : b.correct ? 'hl1' : 'hl2'}">${title}</h1>
      <p class="note" style="text-align:left;margin:-8px 0 12px">${sub}</p>
      <div class="list reveal">${rows}</div>
      ${q.text ? `<div class="answer" style="margin-top:12px"><b>${esc(q.text)}</b>${q.answer ? esc(q.answer) : '老实人讲的是真事'}${q.explain ? `<small>${esc(q.explain)}</small>` : ''}</div>` : ''}
      ${bluffScores(b)}
      <div class="push stack" style="margin-top:16px">
        <button class="btn b1" data-act="b-next-round">下一轮</button>
        <button class="link" data-act="b-restart">改设置</button>
      </div>`;
  }
  return '';
}

function roomHTML() {
  const s = st();
  const inGame = !!s.game;
  const body = !inGame ? lobbyHTML() : s.game === 'dice' ? diceHTML() : s.game === 'truth' ? truthHTML() : s.game === 'king' ? kingHTML() : s.game === 'bluff' ? bluffHTML() : '';
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
    </div></div>` : ''}
  ${motionModalHTML()}`;
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
  } else if (sh.type === 'create') {
    inner = `<h2>创建房间</h2><input type="text" id="newCode" inputmode="numeric" maxlength="6" placeholder="想要的房间号，不填就随机">
      <div class="row2"><button class="btn b3" data-act="close">取消</button><button class="btn b1" data-act="admin-create-go">创建</button></div>`;
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
  const kingFocused = document.activeElement?.id === 'kingText';
  const kingSelection = kingFocused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  app.innerHTML = S.view === 'home' ? homeHTML() : S.view === 'name' ? nameHTML() : S.view === 'room' ? roomHTML() : '';
  if (S.view === 'home') { const i = $('#codeInput'); if (i) { i.value = keepCode; paintBoxes(); } }
  if (kingSelection && $('#kingText')) { $('#kingText').focus(); $('#kingText').setSelectionRange(...kingSelection); }
  S.flicked = true;
  renderOverlay();
}

// ---------- 房间数据 ----------
function setData(d) {
  if (!d || !d.players) return false;
  const tq = d.state && d.state.truth && d.state.truth.q;
  if (tq) { S.tType = tq.type; }
  if (S.data && d.version < S.data.version) return false;
  S.offset = (d.now || Date.now()) - Date.now();
  const sig = JSON.stringify([d.version, d.players, d.state]);
  const first = !S.data;
  S.data = d;
  const kingKey = d.state?.king?.key || null;
  if (S.kingDraft.key !== kingKey) S.kingDraft = { key: kingKey, text: '', numbers: [] };
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
    case 'king_start': return n.ok ? '国王游戏开始' : '开局提议取消';
    case 'king_redeal': return n.ok ? '重新发编号' : '发编号提议取消';
    case 'king_skip': return n.ok ? '跳过当前命令' : '跳过提议取消';
    case 'switch_game': return n.ok ? (n.payload && n.payload.game ? `开始${gameName(n.payload.game)}` : '回到大厅了') : `${by}不同意，继续现在的`;
    case 'pause': return `${by}暂停了游戏`;
    case 'resume': return n.ok ? '继续游戏' : `${by}还不想继续`;
    case 'skip_player': return n.ok ? `这轮跳过了${pname(n.payload && n.payload.player)}` : `${by}不同意跳过`;
    case 'bluff_redraw': return n.ok ? '换题了，重新看身份' : `${by}不同意换题`;
    case 'bluff_void': return n.ok ? '这轮作废，不计分' : `${by}不同意作废`;
    case 'restart_round': return n.ok ? (st().game === 'truth' ? '重新选玩法' : st().game === 'bluff' ? '回到设置' : '这一轮重开了') : `${by}不同意`;
    default: return '';
  }
}
let pending = false;
async function refresh() {
  if (S.view !== 'room' || !S.code) return;
  if (inflight) { pending = true; return; }       // 正在刷新时又收到通知：这次结束后再刷一次
  inflight = true;
  const r = await A.act(S.code, S.token, 'state', {});
  inflight = false;
  if (pending) { pending = false; setTimeout(refresh, 0); }
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
  const t = st().truth;
  if (t) document.querySelectorAll('[data-timer]').forEach(el => {
    const txt = timerText(t); el.textContent = txt; el.classList.toggle('up', txt === '时间到');
  });
  const bl = st().bluff;
  if (bl) document.querySelectorAll('[data-btimer]').forEach(el => {
    const txt = timerText(bl); el.textContent = txt; el.classList.toggle('up', txt === '时间到');
  });
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
  cleanEnter(S.code);
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
// ---------- 摇一摇 ----------
// 摇晃只是触发方式，点数由服务器决定。
// S.motion：checking 检测中 / ask 第一次用、要问权限 / again 以前允许过（点任意按钮时悄悄重新开启）
//          / denied 以前点了不允许 / on 已开启 / none 这台设备不能摇
const MOTION_KEY = 'ldc_motion';
const needsPermission = () => typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
let lastAcc = null, shakeHits = [], motionBound = false, probeTimer = null;
function onMotion(e) {
  const a = e.accelerationIncludingGravity; if (!a || a.x == null) return;
  if (S.motion !== 'on') setMotion('on');
  if (lastAcc) {
    const delta = Math.abs(a.x - lastAcc.x) + Math.abs(a.y - lastAcc.y) + Math.abs(a.z - lastAcc.z);
    const now = Date.now();
    if (delta > 24) { shakeHits = shakeHits.filter(t => now - t < 600); shakeHits.push(now); if (shakeHits.length >= 3) { shakeHits = []; doRoll(); } }
  }
  lastAcc = { x: a.x, y: a.y, z: a.z };
}
function setMotion(v) { if (S.motion === v) return; S.motion = v; if (S.view === 'room') { S.sig = ''; render(); } }
// 开始监听，1.5 秒内收到传感器数据才算真的能用（电脑等没有传感器的设备收不到）
function bindMotion() {
  if (!('DeviceMotionEvent' in window)) { setMotion('none'); return; }
  if (!motionBound) { window.addEventListener('devicemotion', onMotion); motionBound = true; }
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => { if (S.motion !== 'on') setMotion('none'); }, 1500);
}
function initMotion() {
  if (!('DeviceMotionEvent' in window)) { S.motion = 'none'; return; }
  if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) { S.motion = 'none'; return; }   // 电脑没有动作传感器
  if (!needsPermission()) { S.motion = 'checking'; bindMotion(); return; }       // 安卓等：不用问权限
  const saved = LS.get(MOTION_KEY);
  S.motion = saved === 'granted' ? 'again' : saved === 'denied' ? 'denied' : 'ask';
}
async function askMotion(silent) {
  if (!needsPermission()) { bindMotion(); return; }
  let r = 'denied';
  try { r = await DeviceMotionEvent.requestPermission(); } catch (e) { r = 'error'; }
  if (r === 'granted') {
    LS.set(MOTION_KEY, 'granted'); S.motion = 'checking'; bindMotion();
    if (!silent) toast('摇一摇已开启');
  } else {
    if (r === 'denied') LS.set(MOTION_KEY, 'denied');
    S.motion = 'denied';                       // 没开成也关掉弹窗，改用按钮掷骰
  }
  S.sig = ''; render();
}
// 以前允许过：用户点任何按钮时顺便重新开启（苹果要求必须在点击里请求，已允许过的不会再弹窗）
document.addEventListener('click', () => { if (S.motion === 'again') askMotion(true); }, true);
// 第一次用：进入摇骰子时弹窗，点「允许」之前点不到后面的按钮
function motionModalHTML() {
  const s0 = st(), d = s0.dice || {};
  if (S.motion !== 'ask' || s0.game !== 'dice' || s0.paused || !['ready', 'rolling'].includes(d.phase)) return '';
  return `<div class="modal-bg" role="dialog" aria-modal="true" aria-labelledby="mTitle"><div class="modal">
    <div class="modal-icon" aria-hidden="true">${dieHTML(5, 'mini').replace('id="die"', '')}</div>
    <h2 id="mTitle" class="disp">开启摇一摇</h2>
    <p>摇手机就能掷骰子</p>
    <button class="btn b1" data-act="motion">允许</button>
  </div></div>`;
}
function motionNote() {
  if (S.motion === 'on' || S.motion === 'again' || S.motion === 'checking') return '摇一摇，或者点下面';
  if (S.motion === 'denied') return '摇一摇没开，点下面掷骰子';
  return '点下面掷骰子';
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
overlay.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'renameInput') handle('rename-save');
  if (e.key === 'Enter' && e.target.id === 'newCode') handle('admin-create-go');
});
app.addEventListener('input', e => {
  if (e.target.id === 'kingText') S.kingDraft.text = e.target.value;
});
app.addEventListener('change', e => {
  if (e.target.id === 'kingPlayer') S.kingPlayer = e.target.value;
});
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
        cleanEnter(v); break;
      }
      case 'name-submit': await submitName(); break;
      case 'admin-create': S.sheet = { type: 'create' }; renderOverlay(); setTimeout(() => { const i = $('#newCode'); if (i) i.focus(); }, 50); break;
      case 'admin-create-go': {
        const want = (($('#newCode') || {}).value || '').trim();
        if (want && !/^\d{6}$/.test(want)) { toast(ERR.bad_code); break; }
        const r = await A.createRoom(LS.get(ADMIN_KEY), want);
        if (!r.ok) { toast(ERR[r.error] || '出错了'); if (r.error === 'forbidden') { LS.del(ADMIN_KEY); render(); } break; }
        S.sheet = { type: 'created', code: r.code }; renderOverlay(); break;
      }
      case 'admin-rooms': {
        const r = await A.adminRooms(LS.get(ADMIN_KEY));
        if (!r.ok) { toast(ERR[r.error] || '出错了'); break; }
        S.sheet = { type: 'rooms', rooms: r.rooms }; renderOverlay(); break;
      }
      case 'enter': S.sheet = null; renderOverlay(); cleanEnter(ds.code); break;
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
      case 'to-truth': await act('to_truth'); break;
      case 't-start': await act('t_start', { mode: ds.mode, order: ds.order || 'seat' }); break;
      case 't-type': S.tType = ds.type; S.tCat = ''; S.sig = ''; render(); break;
      case 't-cat': S.tCat = ds.cat || ''; S.sig = ''; render(); break;
      case 't-timer': await act('t_timer', { secs: +ds.secs }); break;
      case 't-draw': await act('t_draw', { type: S.tType, cat: S.tCat }); break;
      case 't-redraw': { const q = (st().truth || {}).q; await act('t_draw', { type: q ? q.type : S.tType, cat: S.tCat && q && q.cat === S.tCat ? S.tCat : '' }); break; }
      case 't-answer': await act('t_answer'); break;
      case 't-verdict': await act('t_verdict', { right: ds.right === '1' }); break;
      case 't-done': await act('t_done', { skipped: false }); break;
      case 't-skip': await act('t_done', { skipped: true }); break;
      case 't-back-dice': await act('t_back_dice'); break;
      case 't-restart': await act('propose', { kind: 'restart_round' }); break;
      case 'k-start':
        await act('propose', { kind: 'king_start', payload: { mode: ds.mode, player: $('#kingPlayer').value } }); break;
      case 'k-num': {
        const n = Number(ds.num), nums = S.kingDraft.numbers;
        S.kingDraft.numbers = nums.includes(n) ? nums.filter(x => x !== n) : [...nums, n];
        el.classList.toggle('on', S.kingDraft.numbers.includes(n));
        el.setAttribute('aria-pressed', String(S.kingDraft.numbers.includes(n)));
        break;
      }
      case 'k-publish':
        await act('k_publish', { key: st().king.key, type: ds.type, numbers: S.kingDraft.numbers, text: S.kingDraft.text }); break;
      case 'k-answer': await act('k_answer', { key: st().king.key }); break;
      case 'k-result': await act('k_result', { key: st().king.key, result: ds.result }); break;
      case 'k-next': await act('k_next', { key: st().king.key, player: ds.player }); break;
      case 'k-skip': await act('propose', { kind: 'king_skip', payload: { key: st().king.key } }); break;
      case 'k-redeal': await act('propose', { kind: 'king_redeal', payload: { key: st().king.key } }); break;
      case 'k-restart': await act('propose', { kind: 'restart_round' }); break;
      case 'b-mode': await act('b_setup', { mode: ds.mode }); break;
      case 'b-score': await act('b_setup', { scoring: ds.on === '1' }); break;
      case 'b-timer': await act('b_timer', { secs: +ds.secs }); break;
      case 'b-start': await act('b_start'); break;
      case 'b-want': await act('b_want', { yes: ds.yes === '1' }); break;
      case 'b-seen': await act('b_seen'); break;
      case 'b-next': await act('b_next'); break;
      case 'b-skip': await act('b_skip_speak'); break;
      case 'b-to-guess': S.bPick = null; await act('b_to_guess'); break;
      case 'b-cand': S.bPick = ds.pid; S.sig = ''; render(); break;
      case 'b-pick': if (S.bPick) { await act('b_pick', { player: S.bPick }); S.bPick = null; } break;
      case 'b-next-round': await act('b_next_round'); break;
      case 'b-redraw': await act('propose', { kind: 'bluff_redraw' }); break;
      case 'b-void': await act('propose', { kind: 'bluff_void' }); break;
      case 'b-restart': await act('propose', { kind: 'restart_round' }); break;
      case 'rename': S.sheet = { type: 'rename' }; renderOverlay(); setTimeout(() => { const i = $('#renameInput'); if (i) i.focus(); }, 50); break;
      case 'rename-save': {
        const n = ($('#renameInput').value || '').trim();
        const r = await A.rename(S.code, S.token, n);
        if (!r.ok) { toast(ERR[r.error] || '出错了'); break; }
        LS.set(NAME_KEY, n); S.sheet = null; renderOverlay(); setData(r); A.bump(S.code); setTimeout(() => cleanEnter(S.code), 300); break;
      }
      case 'leave': S.sheet = { type: 'leave' }; renderOverlay(); break;
      case 'leave-yes': { await A.leave(S.code, S.token); A.bump(S.code); goHome(); break; }
    }
  } finally {
    busy.delete(a);
    if (el && el.isConnected) el.disabled = false;
  }
}

// ---------- 手机键盘：弹出时页面收紧，输入框和按钮留在键盘上方 ----------
const vv = window.visualViewport;
function fitViewport() {
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', h + 'px');
  const el = document.activeElement;
  const typing = el && el.tagName === 'INPUT';
  const kb = typing && (vv ? window.innerHeight - vv.height > 120 || window.screen.height - vv.height > 260 : false);
  document.body.classList.toggle('kb', !!(kb || (typing && 'ontouchstart' in window)));
  if (typing) setTimeout(() => {
    const target = el.closest('.sheet') || el.closest('.screen') || el;
    const btn = target.querySelector('.btn.b1') || el;
    window.scrollTo(0, 0);
    btn.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, 60);
}
if (vv) { vv.addEventListener('resize', fitViewport); vv.addEventListener('scroll', () => { if (document.body.classList.contains('kb')) fitViewport(); }); }
window.addEventListener('resize', fitViewport);
document.addEventListener('focusin', e => { if (e.target.tagName === 'INPUT') setTimeout(fitViewport, 250); });
document.addEventListener('focusout', () => setTimeout(() => { if (!document.activeElement || document.activeElement.tagName !== 'INPUT') { document.body.classList.remove('kb'); document.documentElement.style.removeProperty('--vvh'); } }, 100));

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
  initMotion();
  const r = Q.get('r');
  if (r && /^\d{6}$/.test(r)) enterRoom(r);
  else { S.view = 'home'; render(); }
})();

window.LdcApp = { S, handle, refresh, render, askMotion, setMotion };
})();
