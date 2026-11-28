// 来点刺激的 · 动画（GSAP，vendor/gsap.min.js）
// 页面每次收到新数据都会整页重画，所以动画只在「状态刚变的那一下」播一次：
// render() 之后调用 LdcMotion.run()，和上一次画出来的状态比，变了什么就播什么。
// 用 opacity 而不是 visibility，保证动画中途文字照样读得到；系统开了「减弱动态效果」就全部不播。
(() => {
'use strict';
const gsap = window.gsap;
const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
const on = () => !!gsap && !reduce.matches;
const $$ = (root, s) => (root ? [...root.querySelectorAll(s)] : []);
const $1 = (root, s) => (root ? root.querySelector(s) : null);
const CLEAR = 'opacity,transform';
let helpers = { pname: id => id };
let prev = null, prevOverlay = { sheet: null, menu: false }, lastLen = 0, prevModal = false;

const MOON = '<svg viewBox="0 0 60 60" aria-hidden="true"><path d="M38 4a27 27 0 1 0 18 42A23 23 0 0 1 38 4z" fill="#FFD25A"/></svg>';
const SUN = '<svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="12" fill="#FFD25A"/><g stroke="#FFD25A" stroke-width="4" stroke-linecap="round">'
  + [0, 45, 90, 135, 180, 225, 270, 315].map(a => { const r = a * Math.PI / 180; return `<line x1="${30 + 19 * Math.cos(r)}" y1="${30 + 19 * Math.sin(r)}" x2="${30 + 26 * Math.cos(r)}" y2="${30 + 26 * Math.sin(r)}"/>`; }).join('')
  + '</g></svg>';

function fxLayer() {
  let el = document.getElementById('fx');
  if (!el) { el = document.createElement('div'); el.id = 'fx'; el.setAttribute('aria-hidden', 'true'); document.body.appendChild(el); }
  return el;
}
function cssColor(name, alpha) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#([0-9a-f]{6})/i.exec(v);
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${alpha})`;
}
const shake = (el, at, tl) => (tl || gsap).to(el, { keyframes: { x: [0, -7, 7, -5, 5, -2, 0] }, duration: .45, ease: 'none', clearProps: 'transform' }, at);
const flash = (tl, el, color, at) => {
  el.classList.add('fx-glow');
  tl.fromTo(el, { backgroundColor: cssColor(color, 0) }, { backgroundColor: cssColor(color, .22), duration: .25, yoyo: true, repeat: 1, clearProps: 'backgroundColor' }, at);
};
// 数字从 0 跳到最终值（保留原来的正负号写法）
function countUp(tl, el, at, dur = .6) {
  const text = el.textContent.trim(), m = /^([+\-−]?)(\d+)$/.exec(text);
  if (!m) return;
  const to = +m[2], o = { v: 0 };
  const show = v => { el.textContent = (v ? m[1] : '') + v; };
  show(0);
  tl.to(o, { v: to, duration: dur, ease: 'power1.out', onUpdate: () => show(Math.round(o.v)), onComplete: () => { el.textContent = text; } }, at);
}

// ---------- 状态快照 ----------
function snap(S) {
  const d = S.data, s = (d && d.state) || {}, me = d && d.me;
  const g = S.view === 'room' ? ((s.where || {})[me] || null) : null;
  const dc = s.dice || {}, t = s.truth || {}, k = s.king || {}, b = s.bluff || {}, u = s.undercover || {}, w = s.werewolf || {};
  let phase = null;
  if (g === 'dice') phase = [dc.phase, dc.round];
  else if (g === 'truth') phase = [t.phase, t.q && (t.q.id || t.q.text)];
  else if (g === 'king') phase = [k.phase, k.round, k.key, k.king];
  else if (g === 'bluff') phase = [b.phase, b.round];
  else if (g === 'undercover') phase = [u.phase, u.round, u.runoff];
  else if (g === 'werewolf') phase = [w.phase, w.game_no, w.night_no, w.step, w.runoff];
  return {
    view: S.view, code: S.code, game: g, page: JSON.stringify([S.view, S.code, g, phase]),
    players: ((d && d.players) || []).map(p => p.id),
    diceDone: dc.done || [], dicePhase: dc.phase,
    truthQ: t.phase === 'question' && t.q ? (t.q.id || t.q.text) : null,
    king: k.king, kingRound: k.round, kingPhase: k.phase,
    bPhase: b.phase, bRound: b.round, bVoid: !!b.void, warned: b.warned || [],
    uPhase: u.phase, uRound: u.round, uAlive: u.alive || [],
    wPhase: w.phase, wGame: w.game_no, wNight: w.night_no, wAlive: w.alive || [],
    invite: s.invite && s.invite.at,
    paused: !!s.paused && !!g && s.paused_game === g
  };
}

// ---------- 通用进场 ----------
function enter(root, skip) {
  const items = $$(root, 'main.screen > *').filter(el => !skip || !skip.some(s => el === s || el.contains(s)));
  if (!items.length) return;
  gsap.from(items, { opacity: 0, y: 14, duration: .35, stagger: .04, ease: 'power2.out', clearProps: CLEAR });
}
function homeIn(root) {
  const tl = gsap.timeline({ defaults: { ease: 'power3.out', clearProps: CLEAR } });
  tl.from($$(root, '.home-title'), { opacity: 0, y: -18, scale: .94, duration: .6 })
    .from($$(root, '.home-sub'), { opacity: 0, y: 8, duration: .4 }, '-=.3')
    .from($$(root, 'main.screen > .push > *, main.screen > :not(.home-title):not(.home-sub):not(.push)'), { opacity: 0, y: 16, duration: .4, stagger: .05 }, '-=.2');
}
function lobbyIn(root) {
  const tl = gsap.timeline({ defaults: { ease: 'power3.out', clearProps: CLEAR } });
  tl.from($$(root, '.room-no'), { opacity: 0, y: 18, scale: .92, duration: .55 })
    .from($$(root, '.share .chip'), { opacity: 0, y: 10, stagger: .06, duration: .3 }, '-=.3')
    .from($$(root, '.people .p'), { scale: 0, duration: .45, ease: 'back.out(2.2)', stagger: { each: .06, amount: .5 } }, '-=.2')
    .from($$(root, '.games > *'), { opacity: 0, y: 26, duration: .45, stagger: .05 }, '-=.3')
    .from($$(root, '.foot, .install-guide-tip, .install-guide-short'), { opacity: 0, duration: .3 }, '-=.2');
}

// ---------- 各游戏的关键一刻 ----------
function diceReveal(root) {
  const rows = $$(root, '.list.reveal .row'), tags = $$(root, '.list.reveal .tag'), verdict = $$(root, '.verdict');
  const tl = gsap.timeline();
  enter(root, [$1(root, '.list.reveal'), ...verdict]);
  gsap.set(tags, { opacity: 0 }); gsap.set(verdict, { opacity: 0 });
  const gap = Math.min(.42, 1.8 / Math.max(rows.length, 1));
  rows.forEach((r, i) => {
    const n = $1(r, '.n'), at = .25 + i * gap, final = n ? n.textContent : '';
    tl.from(r, { opacity: 0, x: -24, duration: .3, ease: 'power2.out', clearProps: CLEAR }, at);
    if (n) {
      tl.to({}, { duration: .4, onUpdate: () => { n.textContent = 1 + Math.floor(Math.random() * 6); }, onComplete: () => { n.textContent = final; } }, at)
        .fromTo(n, { scale: 1.5 }, { scale: 1, duration: .3, ease: 'back.out(3)', clearProps: 'transform' }, at + .4);
    }
  });
  tl.addLabel('verdict', '+=.2');
  tags.forEach((tag, i) => {
    const row = tag.closest('.row'), ask = tag.classList.contains('hl1'), at = `verdict+=${i * .12}`;
    tl.to(tag, { opacity: 1, duration: .01 }, at)
      .from(tag, { scale: 2.2, duration: .35, ease: 'power4.in', clearProps: 'transform' }, at);
    if (ask) flash(tl, row, '--a1', `verdict+=${.3 + i * .12}`);
    else shake(row, `verdict+=${.4 + i * .12}`, tl);
  });
  tl.to(verdict, { opacity: 1, duration: .4, clearProps: 'opacity' }, '+=.1')
    .from(verdict, { y: 8, duration: .4, clearProps: 'transform' }, '<');
}
function cardDraw(card, delay = 0) {
  if (!card) return;
  gsap.fromTo(card, { rotationY: -90, opacity: 0, y: -24, transformPerspective: 900 },
    { rotationY: 0, opacity: 1, y: 0, duration: .6, delay, ease: 'back.out(1.6)', clearProps: CLEAR });
}
function kingNew(root) {
  const crown = $1(root, '.king-title .crown'), num = $$(root, '.my-num'), chips = $$(root, '.king-numbers .chip');
  enter(root);
  const tl = gsap.timeline({ delay: .15 });
  if (crown) {
    tl.from(crown, { y: -140, rotation: -25, opacity: 0, duration: .9, ease: 'bounce.out', clearProps: CLEAR })
      .to(crown, { rotation: 10, duration: .12, yoyo: true, repeat: 1, clearProps: 'transform' }, '-=.05');
  }
  if (num.length) tl.fromTo(num, { rotationX: 90, scale: 1.4, transformPerspective: 500 }, { rotationX: 0, scale: 1, duration: .5, ease: 'back.out(2)', clearProps: 'transform' }, '+=.05');
  if (chips.length) tl.from(chips, { scale: 0, duration: .35, ease: 'back.out(2.5)', stagger: .05, clearProps: 'transform' }, '-=.2');
}
function stamp(el, tl, at) {
  if (!el) return;
  tl.from(el, { scale: 2.6, rotation: -10, opacity: 0, duration: .4, ease: 'power4.in', transformOrigin: '30% 60%', clearProps: CLEAR }, at);
}
function bluffReveal(root, isVoid) {
  if (isVoid) { enter(root); return; }
  const tl = gsap.timeline({ delay: .1 });
  const title = $1(root, 'main.screen > .h-title');
  gsap.set($$(root, 'main.screen > *').filter(el => el !== title && !el.classList.contains('h-cap')), { opacity: 0 });
  stamp(title, tl, 0);
  tl.to(root, { keyframes: { y: [0, 6, -3, 1, 0] }, duration: .3, ease: 'none', clearProps: 'transform' })
    .to($$(root, 'main.screen > *').filter(el => el !== title && !el.classList.contains('h-cap')), { opacity: 1, duration: .3, stagger: .06, clearProps: 'opacity' }, '-=.1')
    .from($$(root, '.list.reveal .row'), { opacity: 0, x: -20, stagger: .1, duration: .35, ease: 'power2.out', clearProps: CLEAR }, '-=.2')
    .from($$(root, '.list.reveal .rtag'), { rotationX: 90, opacity: 0, stagger: .12, duration: .35, ease: 'back.out(2)', transformPerspective: 400, clearProps: CLEAR }, '-=.3');
  $$(root, '.list.reveal .st.ok, .list.reveal .st.neg').forEach(el => countUp(tl, el, '-=.3'));
  tl.from($$(root, '.list.reveal .wtag'), { scale: 0, duration: .3, ease: 'back.out(3)', clearProps: 'transform' }, '<');
}
function finalRank(root) {
  const rows = $$(root, '.frow').reverse(), tl = gsap.timeline({ delay: .1 });
  const title = $1(root, 'main.screen > .h-title');
  if (title) tl.from(title, { opacity: 0, scale: .8, duration: .5, ease: 'back.out(2)', clearProps: CLEAR });
  const gap = Math.min(.35, 1.8 / Math.max(rows.length, 1));
  rows.forEach((r, i) => {
    const at = .5 + i * gap + (i === rows.length - 1 ? .3 : 0);
    tl.from(r, { opacity: 0, y: 30, duration: .4, ease: 'power3.out', clearProps: CLEAR }, at);
    const n = $1(r, '.ftop .n'); if (n) countUp(tl, n, at + .1, .5);
  });
  const first = rows[rows.length - 1];
  if (first) {
    tl.from($1(first, '.frank'), { scale: 0, rotation: -180, duration: .5, ease: 'back.out(2.5)', clearProps: 'transform' }, '-=.3')
      .fromTo(first, { boxShadow: `0 0 0 0 ${cssColor('--a3', 0)}` }, { boxShadow: `0 0 26px 2px ${cssColor('--a3', .45)}`, duration: .5, yoyo: true, repeat: 1, clearProps: 'boxShadow' });
  }
  tl.from($$(root, 'main.screen > .push'), { opacity: 0, duration: .3, clearProps: 'opacity' }, '-=.4');
}
function resultStamp(root) {
  const tl = gsap.timeline({ delay: .1 });
  stamp($1(root, 'main.screen > .h-title'), tl, 0);
  tl.from($$(root, 'main.screen > .qcard, main.screen > .note'), { opacity: 0, y: 10, duration: .3, stagger: .08, clearProps: CLEAR })
    .from($$(root, 'main.screen > .list .row'), { opacity: 0, x: -18, duration: .3, stagger: .07, clearProps: CLEAR }, '-=.1')
    .from($$(root, 'main.screen > .list .tag'), { rotationX: 90, opacity: 0, duration: .3, stagger: .07, transformPerspective: 400, clearProps: CLEAR }, '-=.3')
    .from($$(root, 'main.screen > .push, main.screen > .timer-row'), { opacity: 0, duration: .3, clearProps: 'opacity' });
}
function roleFlip(el, delay = 0) {
  if (!el) return;
  gsap.fromTo(el, { rotationY: 90, scale: .9, opacity: 0, transformPerspective: 800 },
    { rotationY: 0, scale: 1, opacity: 1, duration: .65, delay, ease: 'back.out(1.5)', clearProps: CLEAR });
}

// ---------- 全屏效果（不挡点击） ----------
function outCard(ids, delay = 0) {
  if (!ids.length) return;
  const el = document.createElement('div');
  el.className = 'fx-out';
  el.innerHTML = `<div class="fx-out-card"><b><span></span><i></i></b><small>出局</small></div>`;
  el.querySelector('span').textContent = ids.map(helpers.pname).join('、');
  fxLayer().appendChild(el);
  const card = el.firstChild;
  gsap.set(el, { opacity: 0 });
  gsap.timeline({ delay, onComplete: () => el.remove() })
    .to(el, { opacity: 1, duration: .01 })
    .from(card, { scale: .7, y: 20, duration: .4, ease: 'back.out(2)' })
    .to(el.querySelector('i'), { scaleX: 1, duration: .45, ease: 'power2.inOut' }, '+=.15')
    .to(el.querySelector('span'), { opacity: .45, duration: .4 }, '<.15')
    .to(card, { y: 6, duration: .4 }, '<')
    .to(el, { opacity: 0, duration: .4 }, '+=.8');
}
function night(text, dark, delay = 0) {
  const el = document.createElement('div');
  el.className = 'fx-night';
  el.innerHTML = `${dark ? MOON : SUN}<p></p>`;
  el.querySelector('p').textContent = text;
  fxLayer().appendChild(el);
  const icon = el.querySelector('svg'), p = el.querySelector('p');
  const tl = gsap.timeline({ delay, onComplete: () => el.remove() });
  if (dark) {
    tl.fromTo(el, { opacity: 0 }, { opacity: .96, duration: .9, ease: 'power2.inOut' })
      .from(icon, { y: 60, opacity: 0, duration: .8, ease: 'power3.out' }, '-=.4')
      .from(p, { opacity: 0, letterSpacing: '.6em', duration: .7 }, '<.15')
      .to(el, { opacity: 0, duration: .8, ease: 'power2.inOut' }, '+=.9');
  } else {
    gsap.set(el, { opacity: .96 });
    tl.from(icon, { y: 60, opacity: 0, rotation: -60, duration: .8, ease: 'power3.out' })
      .from(p, { opacity: 0, letterSpacing: '.6em', duration: .6 }, '<.15')
      .to(el, { opacity: 0, duration: .9, ease: 'power2.inOut' }, '+=.6');
  }
}

// ---------- 主入口 ----------
function special(p, c, root) {
  const same = p && p.view === c.view && p.code === c.code;
  const sameGame = same && p.game === c.game;
  if (c.view === 'home') { homeIn(root); return true; }
  if (c.view === 'room' && c.game === null) { lobbyIn(root); return true; }
  if (c.game === 'dice' && c.dicePhase === 'reveal' && sameGame && p.dicePhase !== 'reveal') { diceReveal(root); return true; }
  if (c.game === 'truth' && c.truthQ && c.truthQ !== (sameGame ? p.truthQ : null)) {
    const card = $1(root, 'main.screen > .qcard'); enter(root, [card]); cardDraw(card, .1); return true;
  }
  if (c.game === 'king' && c.kingPhase === 'command' && (!sameGame || p.king !== c.king || p.kingRound !== c.kingRound || p.kingPhase === 'setup')) { kingNew(root); return true; }
  if (c.game === 'king' && c.kingPhase === 'challenge' && sameGame && p.kingPhase !== 'challenge') {
    const card = $1(root, 'main.screen > .qcard'); enter(root, [card]); cardDraw(card, .1); return true;
  }
  if (c.game === 'bluff' && sameGame && p.bPhase !== c.bPhase) {
    if (c.bPhase === 'roles') { const card = $1(root, '.rolecard'); enter(root, [card]); roleFlip(card, .1); return true; }
    if (c.bPhase === 'think') {
      const card = $1(root, 'main.screen > .qcard'); enter(root, [card]); cardDraw(card, .1);
      gsap.from($$(card, '.qhint'), { scale: 0, duration: .35, delay: .6, stagger: .08, ease: 'back.out(2.5)', clearProps: 'transform' });
      return true;
    }
    if (c.bPhase === 'reveal') { bluffReveal(root, c.bVoid); return true; }
    if (c.bPhase === 'final') { finalRank(root); return true; }
  }
  if (c.game === 'undercover' && sameGame) {
    if (c.uPhase === 'result' && p.uPhase !== 'result') { resultStamp(root); return true; }
    if (c.uPhase === 'discuss' && p.uRound !== c.uRound) { const card = $1(root, 'main.screen > .qcard'); enter(root, [card]); roleFlip(card, .1); return true; }
  }
  if (c.game === 'werewolf' && sameGame) {
    if (c.wPhase === 'result' && p.wPhase !== 'result') { resultStamp(root); return true; }
    if (c.wGame !== p.wGame) { const card = $1(root, '.bluff-word-card'); enter(root, [card]); roleFlip(card, .3); return true; }
  }
  return false;
}
function incremental(p, c, root) {
  if (c.game === null && c.view === 'room') {
    c.players.filter(id => !p.players.includes(id)).forEach(id => {
      const el = $1(root, `.people .p[data-pid="${CSS.escape(id)}"]`);
      if (!el) return;
      gsap.timeline().from(el, { scale: 0, duration: .5, ease: 'back.out(2.6)', clearProps: 'transform' })
        .fromTo(el, { boxShadow: `0 0 0 0 ${cssColor('--a2', 0)}` }, { boxShadow: `0 0 0 3px ${cssColor('--a2', .9)}`, duration: .2, yoyo: true, repeat: 1, clearProps: 'boxShadow' });
    });
  }
  if (c.game === 'dice' && c.dicePhase === 'rolling') {
    c.diceDone.filter(id => !p.diceDone.includes(id)).forEach(id => {
      const el = $1(root, `.row[data-pid="${CSS.escape(id)}"] .st.ok`);
      if (el) gsap.from(el, { scale: 1.8, opacity: 0, duration: .35, ease: 'back.out(2)', clearProps: CLEAR });
    });
  }
  if (c.game === 'bluff' && c.warned.length > p.warned.length) {
    const tags = $$(root, '.wtag');
    gsap.from(tags, { scale: 0, rotation: -20, duration: .4, ease: 'back.out(3)', clearProps: 'transform' });
    tags.forEach(t => { const row = t.closest('.row,.cand'); if (row) shake(row, .2); });
  }
}
function run(S, root) {
  const c = snap(S), p = prev;
  prev = c;
  const hasModal = !!$1(root, '.modal-bg'), modalNew = hasModal && !prevModal;
  prevModal = hasModal;
  if (!on() || !root) return;
  if (modalNew) modal($1(root, '.modal-bg'));
  const same = p && p.view === c.view && p.code === c.code;
  const sameGame = same && p.game === c.game;
  if (!p || p.page !== c.page) { if (!special(p, c, root)) enter(root); }
  else if (same) incremental(p, c, root);
  if (!same) return;
  if (c.invite && c.invite !== p.invite) gsap.from($$(root, '.ask.invite'), { opacity: 0, y: -36, scale: .96, duration: .5, ease: 'back.out(1.8)', clearProps: CLEAR });
  if (c.paused && !p.paused) {
    gsap.from($$(root, '.paused'), { opacity: 0, duration: .25, clearProps: 'opacity' });
    gsap.from($$(root, '.paused .card'), { scale: .85, y: 20, duration: .4, ease: 'back.out(2)', clearProps: 'transform' });
  }
  if (!sameGame) return;
  // 出局 / 天黑天亮
  if (c.game === 'undercover' && c.uRound === p.uRound) {
    const out = p.uAlive.filter(id => !c.uAlive.includes(id));
    outCard(out);
  }
  if (c.game === 'werewolf' && c.wGame === p.wGame) {
    const out = p.wAlive.filter(id => !c.wAlive.includes(id));
    let t = 0;
    if (c.wPhase === 'day' && p.wPhase === 'night') { night('天亮了', false); t = 1.3; }
    if (out.length) { outCard(out, t); t += 2.1; }
    if (c.wPhase === 'night' && p.wPhase !== 'night') night(`第 ${c.wNight} 夜 · 天黑请闭眼`, true, t);
  } else if (c.game === 'werewolf' && c.wPhase === 'night' && c.wGame !== p.wGame) {
    night(`第 ${c.wNight || 1} 夜 · 天黑请闭眼`, true, 1.2);
  }
}

// ---------- 首页输房间号 / 弹层 / 提示 / 倒计时 ----------
function typed(boxes, len) {
  const was = lastLen; lastLen = len;
  if (!on() || len <= was || !boxes.length) return;
  const b = boxes[len - 1];
  if (b) gsap.fromTo(b, { scale: .55, y: 6 }, { scale: 1, y: 0, duration: .35, ease: 'back.out(3)', clearProps: 'transform' });
  if (len === boxes.length) gsap.to(boxes, { y: -8, duration: .16, ease: 'power2.out', stagger: .05, yoyo: true, repeat: 1, delay: .2, clearProps: 'transform' });
}
function overlayRun(S, el) {
  const sheet = S.sheet && S.sheet.type, menu = !!S.menu, p = prevOverlay;
  prevOverlay = { sheet, menu };
  if (!on() || !el) return;
  if (sheet && sheet !== p.sheet) {
    gsap.from($$(el, '.sheet-bg'), { opacity: 0, duration: .25, clearProps: 'opacity' });
    gsap.from($$(el, '.sheet'), { yPercent: 100, duration: .4, ease: 'power3.out', clearProps: 'transform' });
  }
  if (menu && !p.menu) gsap.from($$(el, '.menu'), { opacity: 0, scale: .9, y: -8, transformOrigin: 'top right', duration: .25, ease: 'back.out(2)', clearProps: CLEAR });
}
function toast(el) {
  if (!on() || !el) return;
  gsap.fromTo(el, { xPercent: -50, x: 0, y: -18, opacity: 0 }, { xPercent: -50, y: 0, opacity: 1, duration: .35, ease: 'back.out(2)', clearProps: CLEAR });
}
function pulse(el) {
  if (!on() || !el) return;
  gsap.fromTo(el, { scale: 1.35 }, { scale: 1, duration: .4, ease: 'power2.out', clearProps: 'transform' });
}
function shakeEl(el) { if (on() && el) shake(el); }
function modal(el) {
  if (!on() || !el) return;
  gsap.from(el, { opacity: 0, duration: .25, clearProps: 'opacity' });
  gsap.from($$(el, '.modal'), { scale: .85, y: 20, duration: .4, ease: 'back.out(2)', clearProps: 'transform' });
}

window.LdcMotion = { init(h) { helpers = { ...helpers, ...h }; }, run, typed, overlayRun, toast, pulse, shake: shakeEl, modal };
})();
