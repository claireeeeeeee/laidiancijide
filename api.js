// 数据接口：正式版调用 Supabase 的 ldc_ 函数，并用 Realtime 广播通知房间里其他人刷新；
// ?mock=1 时改用浏览器本地的模拟数据库（规则和 supabase_setup.sql 一致，只用于试玩和测试）。
(() => {
'use strict';
const cfg = window.LDC_CONFIG || {};
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock') || !cfg.supabaseUrl || !cfg.supabaseAnonKey;
const ONLINE_MS = 20000;
const VOTE_MS = 20000;
const GAMES_READY = ['dice', 'truth', 'king', 'bluff'];

// ---------- 正式版 ----------
async function rpc(fn, args) {
  let res;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl && setTimeout(() => ctl.abort(), 15000);
  try {
    res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${cfg.supabaseAnonKey}` },
      body: JSON.stringify(args),
      signal: ctl ? ctl.signal : undefined
    });
  } catch (e) { return { ok: false, error: 'network' }; }
  finally { if (timer) clearTimeout(timer); }
  if (!res.ok) return { ok: false, error: res.status === 404 ? 'not_installed' : 'server', status: res.status };
  try { return await res.json(); } catch (e) { return { ok: false, error: 'server' }; }
}

const real = {
  createRoom: (adminKey, code) => rpc('ldc_create_room', { p_admin_key: adminKey, p_code: code || null }),
  adminRooms: adminKey => rpc('ldc_admin_rooms', { p_admin_key: adminKey }),
  bluffControl: (code, accessKey, action, id) => rpc('ldc_bluff_control', {
    p_code: code, p_access_key: accessKey, p_action: action, p_question_id: id || null
  }),
  join: (code, name, token) => rpc('ldc_join', { p_code: code, p_name: name || '', p_token: token || '' }),
  act: (code, token, action, args) => rpc('ldc_act', { p_code: code, p_token: token, p_action: action, p_args: args || {} }),
  rename: (code, token, name) => rpc('ldc_rename', { p_code: code, p_token: token, p_name: name }),
  leave: (code, token) => rpc('ldc_leave', { p_code: code, p_token: token })
};

// ---------- 模拟数据库（规则对照 supabase_setup.sql） ----------
const MOCK_KEY = 'ldc_mock_db_v1';
const rid = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, '0')).join('');
const uuid = () => { const h = rid(16); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const load = () => { try { return JSON.parse(localStorage.getItem(MOCK_KEY)) || { rooms: {}, players: [] }; } catch (e) { return { rooms: {}, players: [] }; } };
const save = d => localStorage.setItem(MOCK_KEY, JSON.stringify(d));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));
const name12 = s => { s = String(s || '').trim(); const n = [...s].length; return n >= 1 && n <= 12 ? s : null; };
const add = (arr, v) => (arr || []).includes(v) ? (arr || []) : [...(arr || []), v];
const del = (arr, v) => (arr || []).filter(x => x !== v);
const subset = (a, b) => (a || []).every(x => (b || []).includes(x));

const diceInit = () => ({ phase: 'ready', round: 0, ready: [], participants: [], done: [], results: {}, askers: [], takers: [], all_same: false, history: [] });
function diceNewRound(d, online) {
  if (online.length < 2) return { ...d, phase: 'ready', ready: [], participants: [], done: [], results: {}, askers: [], takers: [], all_same: false };
  return { ...d, phase: 'rolling', round: (d.round || 0) + 1, ready: [], participants: online.slice(), done: [], results: {}, askers: [], takers: [], all_same: false };
}
function diceReveal(d) {
  const vals = d.participants.map(p => d.results[p]);
  const mx = Math.max(...vals), mn = Math.min(...vals), same = mx === mn;
  const askers = same ? [] : d.participants.filter(p => d.results[p] === mx);
  const takers = same ? [] : d.participants.filter(p => d.results[p] === mn);
  const h = { round: d.round, results: d.results, askers, takers, all_same: same };
  return { ...d, phase: 'reveal', askers, takers, all_same: same, history: [h, ...(d.history || [])].slice(0, 10) };
}
// ---------- 真心话大冒险（对照 SQL 的 _ldc_truth_init / _ldc_t_doers / _ldc_t_can / _ldc_draw） ----------
const truthInit = mode => ({ mode, phase: mode === 'dice' ? 'choose' : 'setup', order_kind: 'seat', order: [], turn: 0, lap: 1,
  askers: [], takers: [], q: null, show_answer: false, verdict: null, timer: 0, timer_end: null, timer_left: null, last: null, count: 0 });
const pick = arr => arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const tDoers = t => t.mode === 'turns' && t.order.length ? [t.order[t.turn]] : t.mode === 'dice' ? (t.takers || []) : [];
function tCan(t, online, kind, me) {
  const a = (kind === 'chooser' && t.mode === 'dice' ? t.askers : tDoers(t)).filter(x => online.includes(x));
  return a.length === 0 || a.includes(me);
}
function draw(db, st, type, cat, online) {
  const Q = (window.LDC_QUESTIONS || []).filter(q => q.game === 'truth' && q.type === type && (!cat || q.cat === cat));
  const cur = st.truth.q && st.truth.q.id, used = st.used_q || [];
  const q = pick(Q.filter(x => x.id !== cur && !used.includes(x.id))) || pick(Q.filter(x => x.id !== cur));
  if (!q) return null;
  let others = online.filter(x => !tDoers(st.truth).includes(x)); if (!others.length) others = online;
  const nm = id => (db.players.find(p => p.id === id) || {}).nickname;
  let text = q.text, target = null;
  if (text.includes('{TA}')) { target = pick(others); text = text.split('{TA}').join(nm(target) || 'TA'); }
  if (text.includes('{某人}')) { const s = pick(others); text = text.split('{某人}').join(nm(s) || '旁边的人'); }
  return { id: q.id, type: q.type, cat: q.cat, text, answer: q.answer, explain: q.explain, target };
}

const kingClear = k => {
  const { targets, q, results, show_answer, ...round } = k;
  return { ...round, phase: 'command', key: rid(12) };
};
const kingSetup = (mode = 'secret', round = 0) => ({ phase: 'setup', mode, round });
function kingRound(k, king, online, advance = true) {
  if (!online.includes(king) || online.length < 2) return kingSetup(k.mode, k.round);
  const numbered = shuffle(online.filter(id => id !== king));
  return { phase: 'command', mode: k.mode, round: k.round + Number(advance), king, key: rid(12),
    numbers: Object.fromEntries(numbered.map((id, index) => [id, index + 1])), size: numbered.length };
}
function kingAction(db, st, online, me, action, a) {
  const k = st.king;
  if (st.game !== 'king' || !k) return 'no_game';
  if (!k.key || a.key !== k.key) return 'phase';

  if (action === 'k_publish') {
    if (k.phase !== 'command') return 'phase';
    if (k.king !== me) return 'not_yours';
    const nums = a.numbers;
    if (!Array.isArray(nums) || !nums.length || new Set(nums).size !== nums.length ||
        nums.some(n => !Number.isInteger(n) || n < 1 || n > k.size)) return 'king_numbers';
    const targets = Object.keys(k.numbers).filter(id => nums.includes(k.numbers[id])).sort();
    if (targets.some(id => !online.includes(id))) return 'king_offline';
    let q;
    if (a.type === 'custom') {
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (!text || [...text].length > 200) return 'king_text';
      q = { text };
    } else {
      if (!['truth', 'dare', 'quiz'].includes(a.type)) return 'bad_kind';
      q = draw(db, { ...st, truth: { ...truthInit('dice'), takers: targets } }, a.type, '', online);
      if (!q) return 'empty';
      st.used_q = [q.id, ...(st.used_q || [])].slice(0, 400);
  if (st.bluff_next_q === q.id) delete st.bluff_next_q;
    }
    st.king = { ...k, phase: 'challenge', targets, q, results: {}, show_answer: false };
  } else if (action === 'k_answer') {
    if (k.phase !== 'challenge' || !k.q.answer || k.show_answer) return 'phase';
    if (me !== k.king && !k.targets.includes(me)) return 'not_yours';
    k.show_answer = true;
  } else if (action === 'k_result') {
    if (k.phase !== 'challenge' || k.results[me]) return 'phase';
    if (!k.targets.includes(me)) return 'not_yours';
    if (!['done', 'skip'].includes(a.result)) return 'bad_kind';
    k.results[me] = a.result;
    if (k.targets.every(id => k.results[id])) {
      if (Object.values(k.results).includes('done')) k.phase = 'handover';
      else st.king = kingClear(k);
    }
  } else if (action === 'k_next') {
    if (k.phase !== 'handover') return 'phase';
    if (k.king !== me && (online.includes(k.king) || !k.numbers[me])) return 'not_yours';
    const eligible = k.targets.filter(id => k.results[id] === 'done' && online.includes(id));
    if (!eligible.length || online.length < 2) return 'king_offline';
    const next = a.player === 'random' ? pick(eligible) : a.player;
    if (!eligible.includes(next)) return 'bad_target';
    st.king = kingRound(k, next, online);
  } else return 'bad_action';
  return null;
}

// ---------- 瞎掰王（对照 SQL 的 _ldc_bluff_*） ----------
const bluffFresh = () => ({ away: [], away_clock: null, roles: {}, seen: [], choices: [], q: null, ready: [], order: [], spoken: [], cur: null, skipped: [], warned: [], wrong: [],
  pick: null, correct: null, void: false, honest: null, delta: {}, timer_end: null, timer_left: null });
const bluffInit = () => ({ phase: 'setup', bank: 'mix', mode: 'knowledge', think: 30, timer: 180, warn_on: true, rounds: 5, round: 0, settings_order: [],
  players: [], want: {}, deadline: null, smart: null, volunteered: false, ...bluffFresh(), warns_left: 0,
  scores: {}, stats: {}, history: [] });
const bluffRecruit = (b, online) => ({ ...b, ...bluffFresh(), phase: 'recruit', round: (b.round || 0) + 1, players: online.slice(), want: {},
  deadline: Date.now() + VOTE_MS, smart: null, volunteered: false });
function bluffAssign(b) {
  const others = b.players.filter(x => x !== b.smart), roles = {}, n = b.players.length;
  const previousHonest = b.history?.[0]?.honest;
  // 上轮老实人仍有机会抽中，其他候选人的权重是其四倍。
  const alternatives = others.includes(previousHonest) ? others.filter(x => x !== previousHonest) : [];
  const h = pick(others.concat(alternatives, alternatives, alternatives));
  others.forEach(x => { roles[x] = x === h ? 'honest' : 'bluffer'; });
  return { ...b, ...bluffFresh(), phase: 'roles', roles, order: shuffle(others),
    warns_left: b.warn_on !== false ? (n <= 4 ? 0 : n <= 8 ? 1 : 2) : 0 };
}
const bankHas = (bk, q) => q.type === (bk === 'story' ? 'story' : 'knowledge');
function bluffAvailable(st) {
  return (window.LDC_QUESTIONS || []).filter(q =>
    q.game === 'bluff' && bankHas(st.bluff?.bank, q) && !(st.used_q || []).includes(q.id));
}
// 已指定时只有这一道候选题；其他情况沿用随机二选一。
function bluffTwo(st, notIds = []) {
  const available = bluffAvailable(st);
  const fixed = available.find(q => q.id === st.bluff_next_q);
  const rank = q => (notIds.includes(q.id) ? 1 : 0);
  const choices = fixed ? [fixed] : shuffle(available).sort((a, b) => rank(a) - rank(b)).slice(0, 2);
  return choices.map(q => ({ id: q.id, text: q.text }));
}
// 准备秒数（默认 30 秒）
const bluffThink = b => ([30, 60, 120].includes(b.think) ? b.think : 30);
function bluffBegin(st, id) {
  const q = (window.LDC_QUESTIONS || []).find(x => x.id === id && x.game === 'bluff'), b = st.bluff;
  if (!q) return st;
  st.bluff = { ...b, q: { id: q.id, text: q.text, answer: q.answer, explain: q.explain, hints: shuffle(q.hints || []) }, choices: [], phase: 'think', ready: [],
    spoken: [], cur: null, skipped: [], timer_left: null, timer_end: Date.now() + bluffThink(b) * 1000 };
  st.used_q = [q.id, ...(st.used_q || [])].slice(0, 400);
  return st;
}
const inc = (m, k, v) => ({ ...m, [k]: (m[k] || 0) + v });
const stat = (s, p, k, v) => ({ ...s, [p]: inc(s[p] || {}, k, v) });
// 结束一轮（计分规则见 SQL 的 _ldc_bluff_finish）
function bluffFinish(b, pk, isVoid) {
  const honest = Object.keys(b.roles || {}).find(k => b.roles[k] === 'honest') || null;
  const ok = !isVoid && pk != null && pk === honest, sm = b.smart, n = b.players.length;
  const wrong = !isVoid && pk != null && !ok ? [pk] : [];
  let d = {}, st = { ...(b.stats || {}) }; const sc = { ...(b.scores || {}) };
  if (!isVoid) {
    wrong.forEach(w => { d = inc(d, w, 1); st = stat(st, w, 'picked', 1); });
    if (ok) { d = inc(d, sm, n >= 7 ? 2 : 1); d = inc(d, honest, 1); st = stat(st, sm, 'found', 1); }
    (b.warned || []).forEach(w => {
      d = inc(d, w, -1); d = inc(d, sm, w === honest ? -3 : 1);
      st = stat(st, sm, 'warn', 1); if (w !== honest) st = stat(st, sm, 'warn_hit', 1);
    });
    st = stat(st, sm, 'smart', 1);
    if (honest) st = stat(st, honest, 'honest', 1);
    Object.keys(b.roles).filter(k => b.roles[k] === 'bluffer').forEach(k => { st = stat(st, k, 'bluffer', 1); });
    Object.keys(d).forEach(k => { sc[k] = (sc[k] || 0) + d[k]; });
  }
  const h = { round: b.round, smart: sm, honest, pick: pk, correct: ok, void: isVoid, q: b.q && b.q.text, delta: d };
  return { ...b, phase: 'reveal', away: [], away_clock: null, pick: pk, correct: ok, void: isVoid, honest, wrong, delta: d, scores: sc, stats: st, cur: null,
    timer_end: null, timer_left: null, history: [h, ...(b.history || [])].slice(0, 20) };
}
function bluffSettle(st, online) {
  let b = st.bluff; if (!b) return st;
  if (!('bank' in b)) b = { ...bluffInit(), scores: b.scores || {} };   // 旧版本的房间
  const present = (b.settings_order || []).filter(id => online.includes(id));
  b.settings_order = [...present, ...online.filter(id => !present.includes(id))];
  if (b.phase === 'guess' && b.wrong?.length) {
    st.bluff = bluffFinish(b, b.wrong[0], false);
    return st;
  }
  if (b.phase === 'guess' && b.warns_left > 0) b.phase = 'speak';
  if (b.phase === 'speak') Object.assign(b, { cur: null, timer_end: null, timer_left: null, away_clock: null });
  const now = Date.now();
  if (['recruit', 'roles', 'choose', 'think', 'speak', 'guess'].includes(b.phase)) {
    const newcomers = online.filter(id => !b.players.includes(id));
    if (newcomers.length) {
      b.players = b.players.concat(newcomers);
      if (b.phase !== 'recruit') {
        b.roles = { ...b.roles, ...Object.fromEntries(newcomers.map(id => [id, 'bluffer'])) };
        b.order = b.order.concat(newcomers);
        if (b.phase === 'guess') b.phase = 'speak';
      }
    }
    const away = (b.players || []).filter(id => !online.includes(id));
    if (away.length) {
      if (!b.away?.length) {
        const key = b.phase === 'recruit' ? 'deadline' : 'timer_end';
        if (typeof b[key] === 'number') {
          b.away_clock = { key, left: Math.max(b[key] - now, 1000) };
          b[key] = null;
        }
      }
      st.bluff = { ...b, away };
      return st;
    }
    if (b.away?.length) {
      if (b.away_clock) b[b.away_clock.key] = now + b.away_clock.left;
      b.away = [];
      b.away_clock = null;
      st.bluff = b;
      return st;
    }
  }
  const pon = (b.players || []).filter(x => online.includes(x));
  if (b.phase === 'recruit') {
    if (pon.every(x => x in b.want) || now >= b.deadline) {
      if (pon.length < 3) b = { ...b, phase: 'setup' };
      else {
        const fixed = pon.includes(st.bluff_next_honest) ? st.bluff_next_honest : null;
        const smartPool = pon.filter(x => x !== fixed);
        const vol = smartPool.filter(x => b.want[x] === true);
        b = bluffAssign({ ...b, players: pon, volunteered: vol.length > 0, smart: pick(vol.length ? vol : smartPool) });
        if (fixed) {
          const drawnHonest = Object.keys(b.roles).find(id => b.roles[id] === 'honest');
          b.roles[drawnHonest] = 'bluffer';
          b.roles[fixed] = 'honest';
        }
        delete st.bluff_next_honest;
      }
    }
  } else if (b.phase === 'roles') {
    if (pon.length && subset(pon, b.seen)) { st.bluff = b; b = { ...b, phase: 'choose', choices: bluffTwo(st) }; }   // 空数组 = 题玩完了
  } else if (b.phase === 'think') {
    if ((pon.length && subset(pon, b.ready || [])) || (typeof b.timer_end === 'number' && now >= b.timer_end))
      b = { ...b, phase: 'speak', cur: null, timer_left: null, timer_end: null };
  }
  st.bluff = b; return st;
}

function applyProposal(st, p, online) {
  st = { ...st };
  const d = st.dice, tr = st.truth;
  if (p.kind === 'switch_game') {
    st.game = p.payload.game ?? null; st.paused = false; delete st.paused_by;
    delete st.king;
    if (st.game === 'king') st.king = kingSetup();
    if (st.game === 'dice') st.dice = diceInit();
    if (st.game === 'truth') st.truth = { ...truthInit('setup'), timer: (tr && tr.timer) || 0 };
    if (st.game === 'bluff') {
      const keep = {}; ['bank', 'mode', 'think', 'timer', 'warn_on', 'rounds', 'settings_order', 'scores', 'stats', 'round', 'history'].forEach(k => { if (st.bluff && k in st.bluff) keep[k] = st.bluff[k]; });
      st.bluff = { ...bluffInit(), ...keep };
    }
  } else if (p.kind === 'resume') {
    st.paused = false; delete st.paused_by;
    if (tr && typeof tr.timer_left === 'number') st.truth = { ...tr, timer_end: Date.now() + tr.timer_left, timer_left: null };
    if (st.bluff && typeof st.bluff.timer_left === 'number') st.bluff = { ...st.bluff, timer_end: Date.now() + st.bluff.timer_left, timer_left: null };
  } else if (p.kind === 'restart_round' && st.game === 'bluff') {
    const b = st.bluff;
    st.bluff = { ...b, ...bluffFresh(), phase: 'setup', smart: null,
      round: b.phase === 'recruit' ? Math.max(0, b.round - 1) : b.round };
  } else if (p.kind === 'bluff_redraw' && st.bluff) {
    st.bluff = bluffAssign(st.bluff);
  } else if (p.kind === 'bluff_void' && st.bluff) {
    st.bluff = bluffFinish(st.bluff, null, true);
  } else if (st.game === 'king' && p.kind === 'king_start') {
    const { mode, player } = p.payload;
    st.king = kingRound(kingSetup(mode, st.king.round), player === 'random' ? pick(online) : player, online);
  } else if (st.game === 'king' && p.kind === 'king_redeal' && st.king.phase === 'command' && st.king.key === p.payload.key) {
    st.king = kingRound(st.king, st.king.king, online, false);
  } else if (st.game === 'king' && p.kind === 'king_skip' && st.king.phase === 'challenge' && st.king.key === p.payload.key) {
    st.king = kingClear(st.king);
  } else if (st.game === 'king' && p.kind === 'restart_round') {
    st.king = kingSetup(st.king.mode, Math.max(st.king.round - 1, 0));
  } else if (p.kind === 'restart_round' && st.game === 'truth') {
    st.truth = { ...truthInit('setup'), timer: (tr && tr.timer) || 0 };
  } else if (p.kind === 'skip_player' && d) {
    const t = p.payload.player, results = { ...d.results }; delete results[t];
    st.dice = { ...d, participants: del(d.participants, t), results };
  } else if (p.kind === 'restart_round' && d) {
    st.dice = diceNewRound({ ...d, round: Math.max((d.round || 1) - 1, 0) }, online);
  }
  return st;
}
// 在线、而且当前在某个游戏页面的人（对照 SQL 的 _ldc_here）
const here = (st, online, g) => g ? online.filter(x => (st.where || {})[x] === g) : [];
// 把在 from 页面的人都带到 to 页面（对照 _ldc_move）
function moveWhere(st, from, to) { const w = { ...(st.where || {}) }; Object.keys(w).forEach(k => { if (w[k] === from) w[k] = to; }); st.where = w; }
// 各个游戏的自动推进：只看在这个游戏页面的在线玩家；暂停的游戏不推进
function settle(st, online) {
  st = clone(st); delete st.proposal; delete st.game; st.where = st.where || {};
  const pg = st.paused ? st.paused_game : null;
  if (st.dice && pg !== 'dice') {
    let d = st.dice; const h = here(st, online, 'dice');
    if (d.phase === 'ready' && h.length >= 2 && subset(h, d.ready)) d = diceNewRound(d, h);
    else if (d.phase === 'rolling') {
      const need = d.participants.filter(x => !online.includes(x) || h.includes(x));   // 去了别的页面的人不再等
      if (!d.done.length && !need.length) d = { ...d, phase: 'ready', ready: [] };
      else if (d.done.length && subset(need, d.done)) d = diceReveal({ ...d, participants: d.participants.filter(x => d.done.includes(x)) });
    }
    st.dice = d;
  }
  if (st.bluff && pg !== 'bluff') st = bluffSettle(st, here(st, online, 'bluff'));
  return st;
}
const roomPlayers = (db, room) => db.players.filter(p => p.room_id === room.id).sort((a, b) => a.seat - b.seat);
const onlineIds = (db, room) => roomPlayers(db, room).filter(p => !p.left_at && Date.now() - p.last_seen < ONLINE_MS).map(p => p.id);
function playerByToken(db, room, token) {
  const credential = roomPlayers(db, room).find(p => p.token_hash === token);
  return credential?.alias_of ? db.players.find(p => p.id === credential.alias_of) : credential;
}
function mergeRoomNames(db, room) {
  const active = roomPlayers(db, room).filter(p => !p.alias_of);
  if (new Set(active.map(p => p.nickname)).size === active.length) return room.state;
  const st = clone(room.state), { bluff: b, dice: d, king: k, truth: t } = st;
  const reserved = new Set([
    ...(['recruit', 'roles', 'choose', 'think', 'speak', 'guess'].includes(b?.phase) ? b.players : []),
    ...(d?.phase === 'rolling' ? d.participants : []),
    ...(['command', 'challenge', 'handover'].includes(k?.phase) ? [k.king, ...Object.keys(k.numbers)] : []),
    ...(['choose', 'question'].includes(t?.phase) ? [...(t.askers || []), ...tDoers(t), t.q?.target] : [])
  ]);
  active.sort((a, b) => Number(reserved.has(b.id)) - Number(reserved.has(a.id)) || Number(Boolean(a.left_at)) - Number(Boolean(b.left_at)));
  const canonical = new Map();
  for (const p of active) {
    const root = canonical.get(p.nickname);
    if (!root) { canonical.set(p.nickname, p); continue; }
    if (reserved.has(p.id)) continue;
    for (const alias of db.players) { if (alias.alias_of === p.id) alias.alias_of = root.id; }
    p.alias_of = root.id;
    if (!p.left_at) root.left_at = null;
    p.left_at ||= Date.now();
    root.last_seen = Math.max(root.last_seen, p.last_seen);
    if (st.bluff_next_honest === p.id) st.bluff_next_honest = root.id;
    if (b?.scores && p.id in b.scores) {
      b.scores = inc(b.scores, root.id, b.scores[p.id]);
      delete b.scores[p.id];
    }
    if (b?.stats?.[p.id]) {
      for (const [key, value] of Object.entries(b.stats[p.id])) b.stats = stat(b.stats, root.id, key, value);
      delete b.stats[p.id];
    }
    if (t?.mode === 'turns' && t.order.includes(p.id)) {
      if (t.order.indexOf(p.id) < t.turn) t.turn--;
      t.order = del(t.order, p.id);
    }
    st.where ||= {};
    if (!st.where[root.id] && st.where[p.id]) st.where[root.id] = st.where[p.id];
    delete st.where[p.id];
  }
  return st;
}
function view(db, room, me) {
  let st = clone(room.state);
  if (st.dice && st.dice.phase !== 'reveal') {
    const mine = st.dice.results[me];
    st.dice.results = mine == null ? {} : { [me]: mine };
  }
  if (st.truth && st.truth.q && !st.truth.show_answer) {
    const q = { ...st.truth.q, has_answer: st.truth.q.answer != null }; delete q.answer; delete q.explain; st.truth.q = q;
  }
  const k = st.king;
  if (k?.mode === 'secret' && k.numbers) {
    const mine = k.numbers[me];
    k.numbers = mine ? { [me]: mine } : {};
  }
  if (k?.q && !k.show_answer) {
    k.q.has_answer = Boolean(k.q.answer);
    delete k.q.answer;
    delete k.q.explain;
  }
  if (st.bluff && !['reveal', 'final'].includes(st.bluff.phase)) {
    const mine = st.bluff.roles[me];
    st.bluff.roles = mine == null ? {} : { [me]: mine };
    // 老实人只在思考时间看得到答案
    if (st.bluff.q && (mine !== 'honest' || st.bluff.phase !== 'think')) { const q = { ...st.bluff.q }; delete q.answer; delete q.explain; st.bluff.q = q; }
  }
  delete st.used_q; delete st.game; delete st.proposal; delete st.bluff_next_q; delete st.bluff_next_honest;
  const roster = roomPlayers(db, room);
  const aliasNames = Object.fromEntries(roster.filter(a => a.alias_of).flatMap(a => {
    const root = roster.find(p => p.id === a.alias_of);
    return root && root.seat !== a.seat ? [[a.id, root.nickname]] : [];
  }));
  return {
    ok: true, code: room.code, me, version: room.version, now: Date.now(),
    players: roster.filter(p => !p.left_at && !p.alias_of).map(p => ({ id: p.id, name: p.nickname, seat: p.seat, online: Date.now() - p.last_seen < ONLINE_MS })),
    alias_names: aliasNames,
    state: st
  };
}
function commit(db, room, st) {
  if (JSON.stringify(st) !== JSON.stringify(room.state)) { room.state = st; room.version++; }
  save(db);
}

const mock = {
  // 模拟模式：任何非空钥匙都算管理员
  async createRoom(adminKey, want) {
    await sleep(120);
    if (!adminKey) return { ok: false, error: 'forbidden' };
    const db = load();
    let code = want ? String(want).trim() : '';
    if (code) {
      if (!/^\d{6}$/.test(code)) return { ok: false, error: 'bad_code' };
      if (db.rooms[code]) return { ok: false, error: 'code_taken' };
    } else do { code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0'); } while (db.rooms[code]);
    db.rooms[code] = { id: uuid(), code, state: { game: null, paused: false }, version: 0, created_at: Date.now() };
    save(db);
    return { ok: true, code };
  },
  async adminRooms(adminKey) {
    await sleep(60);
    if (!adminKey) return { ok: false, error: 'forbidden' };
    const db = load();
    return { ok: true, rooms: Object.values(db.rooms).sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 50).map(r => {
      const ps = roomPlayers(db, r).filter(p => !p.left_at);
      return { code: r.code, created_at: r.created_at, game: r.state.game, players: ps.length, online: ps.filter(p => Date.now() - p.last_seen < ONLINE_MS).length };
    }) };
  },
  async bluffControl(code, accessKey, action, id) {
    await sleep(60);
    if (!accessKey) return { ok: false, error: 'forbidden' };
    if (action === 'rooms') return mock.adminRooms(accessKey);
    if (action === 'create') return mock.createRoom(accessKey, code);
    if (!/^\d{6}$/.test(code)) return { ok: false, error: 'bad_code' };
    if (!['view', 'select', 'clear', 'set_honest', 'clear_honest'].includes(action)) return { ok: false, error: 'bad_action' };
    const db = load(), room = db.rooms[code];
    if (!room) return { ok: false, error: 'not_found' };
    const st = clone(room.state), b = st.bluff || bluffInit();
    const online = onlineIds(db, room);
    const eligibleHonest = here(st, online, 'bluff').filter(p => b.phase !== 'recruit' || b.players.includes(p));
    const questions = bluffAvailable(st).map(q => ({ id: q.id, text: q.text.split('｜')[0] }))
      .sort((a, b) => a.text.localeCompare(b.text, 'zh-CN'));
    if (action === 'select') {
      if (!questions.some(q => q.id === id)) return { ok: false, error: 'bad_question' };
      st.bluff_next_q = id;
    } else if (action === 'clear') delete st.bluff_next_q;
    else if (action === 'set_honest') {
      if (!eligibleHonest.includes(id)) return { ok: false, error: 'bad_honest' };
      st.bluff_next_honest = id;
    } else if (action === 'clear_honest') delete st.bluff_next_honest;
    if (st.bluff_next_q !== room.state.bluff_next_q) {
      if (b.phase === 'choose') b.choices = bluffTwo(st);
      commit(db, room, st);
    }
    if (st.bluff_next_honest !== room.state.bluff_next_honest) {
      room.state = st;
      save(db);
    }
    const players = roomPlayers(db, room).filter(p => !p.alias_of && (!p.left_at || b.players.includes(p.id))).map(p => ({
      id: p.id, name: p.nickname, online: online.includes(p.id),
      can_pin_honest: eligibleHonest.includes(p.id),
      role: p.id === b.smart ? 'smart' : b.roles[p.id] || null
    }));
    return { ok: true, code, phase: b.phase, round: b.round, bank: b.bank === 'story' ? 'story' : 'knowledge',
      queued: st.bluff_next_q || null, queued_honest: st.bluff_next_honest || null, current_question: b.q, players, questions };
  },
  async join(code, name, token) {
    await sleep(100);
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    const n = name12(name);
    if (!n && !playerByToken(db, room, token)) return { ok: false, error: 'bad_name' };
    let st = mergeRoomNames(db, room);
    commit(db, room, st);
    const ps = roomPlayers(db, room);
    const byToken = token && playerByToken(db, room, token);
    const existing = byToken || ps.find(p => !p.alias_of && p.nickname === n && !p.left_at)
      || ps.find(p => !p.alias_of && p.nickname === n);
    const tok = byToken ? token : rid(32);
    if (existing) {
      if (st.where?.[existing.id] === 'bluff' && (existing.left_at || Date.now() - existing.last_seen >= ONLINE_MS)) {
        st = settle(st, onlineIds(db, room));
      }
      existing.left_at = null;
      existing.last_seen = Date.now();
      if (!byToken) db.players.push({
        id: uuid(), room_id: room.id, nickname: existing.nickname, token_hash: tok,
        seat: existing.seat, alias_of: existing.id, last_seen: Date.now(), left_at: Date.now()
      });
      if (st.where?.[existing.id] === 'bluff') st = settle(st, onlineIds(db, room));
      commit(db, room, st);
      return { ...view(db, room, existing.id), token: tok, resumed: true };
    }
    if (!n) return { ok: false, error: 'bad_name' };
    if (ps.filter(p => !p.left_at).length >= 16) return { ok: false, error: 'full' };
    const pid = uuid();
    db.players.push({ id: pid, room_id: room.id, nickname: n, token_hash: tok, seat: Math.max(0, ...ps.map(p => p.seat)) + 1, last_seen: Date.now(), left_at: null });
    room.version++; save(db);
    return { ...view(db, room, pid), token: tok };
  },
  async act(code, token, action, a = {}) {
    await sleep(60);
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    const caller = playerByToken(db, room, token);
    if (!caller || caller.left_at) return { ok: false, error: 'not_member' };
    const merged = mergeRoomNames(db, room);
    const meP = playerByToken(db, room, token);
    const before = room.state.where?.[meP.id] === 'bluff' && Date.now() - meP.last_seen >= ONLINE_MS
      ? settle(merged, onlineIds(db, room)) : merged;
    meP.last_seen = Date.now();
    const me = meP.id, allOnline = onlineIds(db, room), now = Date.now();
    let st = settle(before, allOnline), d = st.dice, err = null, res = {};
    // 这次操作属于哪个游戏；参与者 = 在线、而且在这个游戏页面的人
    const ag = ['ready', 'unready', 'roll', 'next_round', 'to_truth'].includes(action) ? 'dice'
      : action.startsWith('t_') ? 'truth' : action.startsWith('k_') ? 'king' : action.startsWith('b_') ? 'bluff'
      : action === 'propose' ? ((a.payload && a.payload.game) || st.where[me] || null)
      : action === 'pause' ? (st.where[me] || null) : null;
    const online = here(st, allOnline, ag);
    const paused = !!st.paused && st.paused_game === ag;
    st.game = ag;

    if (action === 'state') { /* 只刷新 */ }
    else if (action === 'goto') {
      // 进入某个游戏页面（null = 回大厅），不用别人同意
      const g = a.game ?? null;
      if (g !== null && !GAMES_READY.includes(g)) err = 'not_ready';
      else {
        st.where = { ...st.where, [me]: g };
        if (g === 'dice') {
          if (!st.dice) st.dice = diceInit();
          if (st.dice.phase === 'rolling') st.dice.participants = add(st.dice.participants, me);
        }
        if (g === 'truth' && !st.truth) st.truth = truthInit('setup');
        if (g === 'truth' && st.truth.mode === 'turns') st.truth.order = add(st.truth.order, me);
        if (g === 'king') {
          const k = st.king || kingSetup();
          if (k.phase !== 'setup' && k.king !== me && !k.numbers[me]) {
            k.size++;
            k.numbers[me] = k.size;
          }
          st.king = k;
        }
        if (g === 'bluff' && !st.bluff) st.bluff = bluffInit();
      }
    }
    else if (action === 'propose') {
      // 以前要大家同意的操作，现在点了就执行
      const k = a.kind;
      if (!ag) err = 'no_game';
      else if (k === 'resume') { if (!paused) err = 'not_paused'; }
      else if (k === 'skip_player') {
        const t = a.payload?.player;
        if (st.game !== 'dice' || d?.phase !== 'rolling' || !d.participants.includes(t) || d.done.includes(t) || t === me) err = 'bad_target';
      } else if (k === 'king_start') {
        const { mode, player } = a.payload || {};
        if (st.game !== 'king' || st.king.phase !== 'setup') err = 'phase';
        else if (paused) err = 'paused';
        else if (online.length < 2) err = 'king_people';
        else if (!['public', 'secret'].includes(mode) || (player !== 'random' && !online.includes(player))) err = 'bad_target';
      } else if (k === 'king_redeal' || k === 'king_skip') {
        const king = st.king;
        if (st.game !== 'king' || !king || king.key !== a.payload?.key ||
            king.phase !== (k === 'king_redeal' ? 'command' : 'challenge')) err = 'phase';
        else if (paused) err = 'paused';
        else if (k === 'king_redeal' && (!online.includes(king.king) || online.length < 2)) err = 'king_offline';
      } else if (k === 'restart_round') { if (!st[st.game]) err = 'no_game'; }
      else if (k === 'bluff_redraw' || k === 'bluff_void') {
        const ph = st.bluff && st.bluff.phase;
        if (st.game !== 'bluff' || !['roles', 'choose', 'think', 'speak', 'guess'].includes(ph) || (k === 'bluff_redraw' && ph === 'guess')) err = 'phase';
        else if (ph === 'speak' && st.bluff.smart !== me) err = 'not_yours';
      }
      else err = 'bad_kind';
      if (!err) {
        const p = { kind: k, payload: { ...(a.payload || {}), game: ag }, by: me };
        st = applyProposal(st, p, online);
        st.notice = { kind: k, ok: true, by: me, payload: p.payload, at: now };
        if (k === 'king_start') st.invite = { game: 'king', by: me, what: 'start', at: now };
      }
    } else if (action === 'pause') {
      if (!ag) err = 'no_game';
      else if (ag === 'bluff' && st.bluff?.phase === 'setup') err = 'phase';
      else if (!st.paused) {
        st.paused = true; st.paused_by = me; st.paused_game = ag; st.notice = { kind: 'pause', ok: true, by: me, at: now, payload: { game: ag } };
        if (st.truth && typeof st.truth.timer_end === 'number') { st.truth.timer_left = Math.max(st.truth.timer_end - now, 0); st.truth.timer_end = null; }
        if (st.bluff && typeof st.bluff.timer_end === 'number') { st.bluff.timer_left = Math.max(st.bluff.timer_end - now, 0); st.bluff.timer_end = null; }
      }
    } else if (typeof action === 'string' && action.startsWith('k_')) {
      err = paused ? 'paused' : kingAction(db, st, online, me, action, a);
    } else if (['ready', 'unready', 'roll', 'next_round'].includes(action)) {
      if (!d) err = 'no_game';
      else if (paused) err = 'paused';
      else if (action === 'ready') {
        if (d.phase !== 'ready') err = 'phase';
        else { d.ready = add(d.ready, me); st.invite = { game: 'dice', by: me, what: 'ready', at: now }; }
      }
      else if (action === 'unready') { if (d.phase !== 'ready') err = 'phase'; else d.ready = del(d.ready, me); }
      else if (action === 'roll') {
        if (d.phase !== 'rolling') err = 'phase';
        else if (!d.participants.includes(me)) err = 'not_in_round';
        else if (d.done.includes(me)) { err = 'already'; res = { value: d.results[me] }; }
        else { const v = 1 + Math.floor(Math.random() * 6); d.results[me] = v; d.done = add(d.done, me); res = { value: v }; }
      } else if (action === 'next_round') { if (d.phase !== 'reveal') err = 'phase'; else st.dice = diceNewRound(d, online); }
    } else if (action === 'to_truth') {
      if (!d || d.phase !== 'reveal' || d.all_same) err = 'phase';
      else if (paused) err = 'paused';
      else { st.game = 'truth'; st.truth = { ...truthInit('dice'), askers: d.askers, takers: d.takers, round: d.round, timer: (st.truth && st.truth.timer) || 0 }; moveWhere(st, 'dice', 'truth'); }
    } else if (action.startsWith('t_')) {
      const t = st.truth;
      if (!t) err = 'no_game';
      else if (paused) err = 'paused';
      else if (action === 't_start') {
        if (t.phase !== 'setup') err = 'phase';
        else if (!['free', 'turns'].includes(a.mode)) err = 'bad_action';
        else {
          Object.assign(t, { mode: a.mode, order_kind: a.order || 'seat', turn: 0, lap: 1, phase: 'choose', order: a.order === 'random' ? shuffle(online) : online.slice() });
          st.invite = { game: 'truth', by: me, what: 'start', at: now };
        }
      } else if (action === 't_draw') {
        if (!['choose', 'question'].includes(t.phase)) err = 'phase';
        else if (!['truth', 'dare', 'quiz'].includes(a.type)) err = 'bad_action';
        else if (!tCan(t, online, 'chooser', me)) err = 'not_yours';
        else {
          const q = draw(db, st, a.type, a.cat || null, online);
          if (!q) err = 'empty';
          else {
            Object.assign(t, { q, phase: 'question', show_answer: false, verdict: null, timer_left: null, timer_end: t.timer > 0 ? now + t.timer * 1000 : null });
            st.used_q = [q.id, ...(st.used_q || [])].slice(0, 400);
          }
        }
      } else if (action === 't_timer') {
        const v = +a.secs || 0;
        if (![0, 15, 30, 60, 120].includes(v)) err = 'bad_action';
        else Object.assign(t, { timer: v, timer_left: null, timer_end: v > 0 && t.phase === 'question' ? now + v * 1000 : null });
      } else if (action === 't_answer') {
        if (t.phase !== 'question') err = 'phase'; else t.show_answer = true;
      } else if (action === 't_verdict') {
        if (t.phase !== 'question' || !t.q.target) err = 'phase';
        else if (t.q.target !== me && online.includes(t.q.target)) err = 'not_yours';
        else t.verdict = a.right ? 'right' : 'wrong';
      } else if (action === 't_done') {
        if (t.phase !== 'question') err = 'phase';
        else if (!tCan(t, online, 'doer', me)) err = 'not_yours';
        else {
          Object.assign(t, { last: { text: t.q.text, skipped: !!a.skipped, verdict: t.verdict, who: tDoers(t) }, count: (t.count || 0) + 1,
            q: null, show_answer: false, verdict: null, timer_end: null, timer_left: null });
          if (t.mode === 'free') t.phase = 'choose';
          else if (t.mode === 'dice') t.phase = 'done';
          else {
            if (t.turn + 1 >= t.order.length) Object.assign(t, { turn: 0, lap: (t.lap || 1) + 1, order: t.order_kind === 'random' ? shuffle(online) : online.slice() });
            else t.turn += 1;
            t.phase = 'choose';
          }
        }
      } else if (action === 't_back_dice') {
        if (t.mode !== 'dice') err = 'phase';
        else { st.game = 'dice'; st.dice = diceNewRound(st.dice || diceInit(), online); moveWhere(st, 'truth', 'dice'); }
      } else err = 'bad_action';
    } else if (action.startsWith('b_')) {
      let b = st.bluff;
      const isSmart = b?.smart === me;
      if (!b || !online.includes(me)) err = 'no_game';
      else if (paused) err = 'paused';
      else if (b.away?.length) err = 'bluff_waiting';
      else if (['b_setup', 'b_timer', 'b_think', 'b_start'].includes(action) && b.phase !== 'setup') err = 'phase';
      else if (['b_setup', 'b_timer', 'b_think', 'b_start'].includes(action) && b.settings_order?.[0] !== me) err = 'bluff_settings_owner';
      else if (action === 'b_setup') {
        if ('bank' in a) {
          if (['idiom', 'word', 'allusion', 'mix', 'story'].includes(a.bank)) {
            if ((b.bank === 'story') !== (a.bank === 'story')) delete st.bluff_next_q;
            b.bank = a.bank;
            b.mode = a.bank === 'story' ? 'story' : 'knowledge';
          } else err = 'bad_action';
        }
        if ('warn_on' in a) b.warn_on = a.warn_on !== false;
        if ('rounds' in a) { if ([0, 1, 3, 5, 8].includes(a.rounds)) b.rounds = a.rounds; else err = 'bad_action'; }
      } else if (action === 'b_timer') {
        const v = a.secs == null ? -1 : +a.secs;
        if (![0, 60, 120, 180].includes(v)) err = 'bad_action';
        else b.timer = v;
      } else if (action === 'b_think') {
        const v = +a.secs || 0;
        if (![30, 60, 120].includes(v)) err = 'bad_action'; else b.think = v;
      } else if (action === 'b_ready') {
        if (b.phase !== 'think') err = 'phase';
        else if (!b.players.includes(me)) err = 'not_in_round';
        else b.ready = add(b.ready || [], me);
      } else if (action === 'b_start' || action === 'b_next_round') {
        if (action === 'b_next_round' && b.phase !== 'reveal') err = 'phase';
        else if (action === 'b_next_round' && b.rounds > 0 && b.round >= b.rounds) err = 'finished';
        else if (online.length < 3) err = 'need3';
        else { b = bluffRecruit(b, online); st.invite = { game: 'bluff', by: me, what: 'start', at: now }; }
      } else if (action === 'b_final') {
        if (b.phase !== 'reveal') err = 'phase'; else b.phase = 'final';
      } else if (action === 'b_again') {
        if (b.phase !== 'final') err = 'phase';
        else b = { ...b, ...bluffFresh(), phase: 'setup', round: 0, scores: {}, stats: {}, history: [], players: [], smart: null };
      } else if (action === 'b_want') {
        if (b.phase !== 'recruit') err = 'phase';
        else if (!b.players.includes(me)) err = 'not_in_round';
        else b.want = { ...b.want, [me]: !!a.yes };
      } else if (action === 'b_seen') {
        if (b.phase !== 'roles') err = 'phase';
        else if (!b.players.includes(me)) err = 'not_in_round';
        else b.seen = add(b.seen, me);
      } else if (action === 'b_discuss_done') {
        if (b.phase !== 'speak') err = 'phase';
        else if (!isSmart) err = 'not_yours';
        else if (b.warns_left > 0) err = 'warnings_pending';
        else b.phase = 'guess';
      } else if (action === 'b_warn') {
        if (b.phase !== 'speak') err = 'phase';
        else if (b.smart !== me) err = 'not_yours';
        else if (!(b.warns_left > 0)) err = 'no_warns';
        else if (!a.player || !b.order.includes(a.player) || (b.warned || []).includes(a.player)) err = 'bad_target';
        else Object.assign(b, { warned: add(b.warned || [], a.player), warns_left: b.warns_left - 1 });
      } else if (action === 'b_choose' || action === 'b_more') {
        if (b.phase !== 'choose') err = 'phase';
        else if (!isSmart) err = 'not_yours';
        else if (action === 'b_more') b.choices = bluffTwo(st, b.choices.map(c => c.id));
        else if (!b.choices.some(c => c.id === a.id)) err = 'bad_target';
        else { st = bluffBegin(st, a.id); b = st.bluff; }
      } else if (action === 'b_pick') {
        if (b.phase !== 'guess') err = 'phase';
        else if (!isSmart) err = 'not_yours';
        else if (!a.player || !b.order.includes(a.player)) err = 'bad_target';
        else b = bluffFinish(b, a.player, false);
      } else err = 'bad_action';
      if (!err) st.bluff = b;
    } else err = 'bad_action';

    st = settle(st, allOnline);
    commit(db, room, st);
    const out = { ...view(db, room, me), ...res };
    return err ? { ...out, ok: false, error: err } : out;
  },
  async rename(code, token, name) {
    await sleep(60);
    const n = name12(name); if (!n) return { ok: false, error: 'bad_name' };
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    const p = playerByToken(db, room, token);
    if (!p || p.left_at) return { ok: false, error: 'not_member' };
    if (roomPlayers(db, room).some(other => !other.alias_of && other.id !== p.id && other.nickname === n)) return { ok: false, error: 'name_taken' };
    p.nickname = n; p.last_seen = Date.now(); room.version++; save(db);
    return view(db, room, p.id);
  },
  async leave(code, token) {
    await sleep(60);
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    const p = playerByToken(db, room, token);
    if (!p || p.left_at) return { ok: true };
    p.left_at = Date.now();
    let st = clone(room.state);
    if (st.where && st.where[p.id] !== 'bluff') { st.where = { ...st.where }; delete st.where[p.id]; }
    if (st.dice) {
      st.dice.ready = del(st.dice.ready, p.id);
      if (st.dice.phase === 'rolling' && !st.dice.done.includes(p.id)) st.dice.participants = del(st.dice.participants, p.id);
    }
    st = settle(st, onlineIds(db, room));
    room.state = st; room.version++; save(db);
    return { ok: true };
  }
};

// ---------- 实时通知：谁改了房间就广播一声，其他人收到后重新拉取 ----------
let sb = null;
function client() {
  if (sb || MOCK || !window.supabase) return sb;
  try { sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: false } }); } catch (e) { sb = null; }
  return sb;
}
const channels = {};
function subscribe(code, onBump) {
  if (MOCK) {
    const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ldc-mock') : null;
    const h = e => { if (e.data === code) onBump(); };
    if (bc) bc.addEventListener('message', h);
    const s = e => { if (e.key === MOCK_KEY) onBump(); };
    window.addEventListener('storage', s);
    channels[code] = { send: () => bc && bc.postMessage(code) };
    return () => { if (bc) bc.close(); window.removeEventListener('storage', s); delete channels[code]; };
  }
  const c = client(); if (!c) return () => {};
  const ch = c.channel('ldc-' + code, { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'bump' }, () => onBump()).subscribe();
  channels[code] = { send: () => ch.send({ type: 'broadcast', event: 'bump', payload: {} }).catch(() => {}) };
  return () => { try { c.removeChannel(ch); } catch (e) {} delete channels[code]; };
}
function bump(code) { const ch = channels[code]; if (ch) try { ch.send(); } catch (e) {} }

if (MOCK && !window.LDC_QUESTIONS) { const sc = document.createElement('script'); sc.src = 'questions.js?v=3'; document.head.appendChild(sc); }

mock.__two = bluffTwo;   // 只给测试用
window.LdcApi = { MOCK, GAMES_READY, ...(MOCK ? mock : real), subscribe, bump, _mock: mock };
})();
