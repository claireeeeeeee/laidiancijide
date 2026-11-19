// 数据接口：正式版调用 Supabase 的 ldc_ 函数，并用 Realtime 广播通知房间里其他人刷新；
// ?mock=1 时改用浏览器本地的模拟数据库（规则和 supabase_setup.sql 一致，只用于试玩和测试）。
(() => {
'use strict';
const cfg = window.LDC_CONFIG || {};
const params = new URLSearchParams(location.search);
const MOCK = params.has('mock') || !cfg.supabaseUrl || !cfg.supabaseAnonKey;
const ONLINE_MS = 20000;
const VOTE_MS = 20000;
const GAMES_READY = ['dice'];

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
  createRoom: adminKey => rpc('ldc_create_room', { p_admin_key: adminKey }),
  adminRooms: adminKey => rpc('ldc_admin_rooms', { p_admin_key: adminKey }),
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
function applyProposal(st, p, online) {
  st = { ...st };
  const d = st.dice;
  if (p.kind === 'switch_game') {
    st.game = p.payload.game ?? null; st.paused = false; delete st.paused_by;
    if (st.game === 'dice') st.dice = diceInit();
  } else if (p.kind === 'resume') {
    st.paused = false; delete st.paused_by;
  } else if (p.kind === 'skip_player' && d) {
    const t = p.payload.player, results = { ...d.results }; delete results[t];
    st.dice = { ...d, participants: del(d.participants, t), results };
  } else if (p.kind === 'restart_round' && d) {
    st.dice = diceNewRound({ ...d, round: Math.max((d.round || 1) - 1, 0) }, online);
  }
  return st;
}
function settle(st, online) {
  st = clone(st);
  const p = st.proposal;
  if (p && typeof p === 'object') {
    const allYes = online.every(o => p.votes[o] === true);
    if (allYes || Date.now() >= p.deadline) {
      delete st.proposal;
      st = applyProposal(st, p, online);
      st.notice = { kind: p.kind, ok: true, by: p.by, payload: p.payload, at: Date.now() };
    }
  }
  if (st.paused) return st;
  if (st.game === 'dice' && st.dice) {
    let d = st.dice;
    if (d.phase === 'ready' && online.length >= 2 && subset(online, d.ready)) d = diceNewRound(d, online);
    else if (d.phase === 'rolling') {
      if (d.participants.length === 0) d = { ...d, phase: 'ready', ready: [] };
      else if (subset(d.participants, d.done)) d = diceReveal(d);
    }
    st.dice = d;
  }
  return st;
}
const roomPlayers = (db, room) => db.players.filter(p => p.room_id === room.id).sort((a, b) => a.seat - b.seat);
const onlineIds = (db, room) => roomPlayers(db, room).filter(p => !p.left_at && Date.now() - p.last_seen < ONLINE_MS).map(p => p.id);
function view(db, room, me) {
  let st = clone(room.state);
  if (st.game === 'dice' && st.dice && st.dice.phase !== 'reveal') {
    const mine = st.dice.results[me];
    st.dice.results = mine == null ? {} : { [me]: mine };
  }
  return {
    ok: true, code: room.code, me, version: room.version, now: Date.now(),
    players: roomPlayers(db, room).filter(p => !p.left_at).map(p => ({ id: p.id, name: p.nickname, seat: p.seat, online: Date.now() - p.last_seen < ONLINE_MS })),
    state: st
  };
}
function commit(db, room, st) {
  if (JSON.stringify(st) !== JSON.stringify(room.state)) { room.state = st; room.version++; }
  save(db);
}

const mock = {
  // 模拟模式：任何非空钥匙都算管理员
  async createRoom(adminKey) {
    await sleep(120);
    if (!adminKey) return { ok: false, error: 'forbidden' };
    const db = load();
    let code; do { code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0'); } while (db.rooms[code]);
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
  async join(code, name, token) {
    await sleep(100);
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    if (token) {
      const p = db.players.find(x => x.room_id === room.id && x.token_hash === token);
      if (p) { p.left_at = null; p.last_seen = Date.now(); save(db); return { ...view(db, room, p.id), token, resumed: true }; }
    }
    const n = name12(name); if (!n) return { ok: false, error: 'bad_name' };
    const ps = roomPlayers(db, room);
    if (ps.filter(p => !p.left_at).length >= 16) return { ok: false, error: 'full' };
    const tok = rid(32), pid = uuid();
    db.players.push({ id: pid, room_id: room.id, nickname: n, token_hash: tok, seat: Math.max(0, ...ps.map(p => p.seat)) + 1, last_seen: Date.now(), left_at: null });
    room.version++; save(db);
    return { ...view(db, room, pid), token: tok };
  },
  async act(code, token, action, a = {}) {
    await sleep(60);
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    const meP = db.players.find(x => x.room_id === room.id && x.token_hash === token && !x.left_at);
    if (!meP) return { ok: false, error: 'not_member' };
    meP.last_seen = Date.now();
    const me = meP.id, online = onlineIds(db, room), now = Date.now();
    let st = settle(room.state, online), d = st.dice, err = null, res = {};

    if (action === 'state') { /* 只刷新 */ }
    else if (action === 'propose') {
      const k = a.kind;
      if (st.proposal && typeof st.proposal === 'object') err = 'busy';
      else if (k === 'switch_game') {
        const g = a.payload?.game ?? null;
        if (g !== null && !GAMES_READY.includes(g)) err = 'not_ready';
        else if (g === (st.game ?? null)) err = 'same';
      } else if (k === 'resume') { if (!st.paused) err = 'not_paused'; }
      else if (k === 'skip_player') {
        const t = a.payload?.player;
        if (st.game !== 'dice' || d?.phase !== 'rolling' || !d.participants.includes(t) || d.done.includes(t) || t === me) err = 'bad_target';
      } else if (k === 'restart_round') { if (st.game !== 'dice') err = 'no_game'; }
      else err = 'bad_kind';
      if (!err) st.proposal = { id: rid(4), kind: k, payload: a.payload || {}, by: me, votes: { [me]: true }, deadline: now + VOTE_MS, at: now };
    } else if (action === 'vote') {
      const p = st.proposal;
      if (!p || p.id !== a.id) err = 'stale';
      else if (a.yes) p.votes[me] = true;
      else { delete st.proposal; st.notice = { kind: p.kind, ok: false, by: me, payload: p.payload, at: now }; }
    } else if (action === 'pause') {
      if (!st.game) err = 'no_game';
      else if (!st.paused) { st.paused = true; st.paused_by = me; st.notice = { kind: 'pause', ok: true, by: me, at: now }; }
    } else if (['ready', 'unready', 'roll', 'next_round'].includes(action)) {
      if (st.game !== 'dice' || !d) err = 'no_game';
      else if (st.paused) err = 'paused';
      else if (action === 'ready') { if (d.phase !== 'ready') err = 'phase'; else d.ready = add(d.ready, me); }
      else if (action === 'unready') { if (d.phase !== 'ready') err = 'phase'; else d.ready = del(d.ready, me); }
      else if (action === 'roll') {
        if (d.phase !== 'rolling') err = 'phase';
        else if (!d.participants.includes(me)) err = 'not_in_round';
        else if (d.done.includes(me)) { err = 'already'; res = { value: d.results[me] }; }
        else { const v = 1 + Math.floor(Math.random() * 6); d.results[me] = v; d.done = add(d.done, me); res = { value: v }; }
      } else if (action === 'next_round') { if (d.phase !== 'reveal') err = 'phase'; else st.dice = diceNewRound(d, online); }
    } else err = 'bad_action';

    st = settle(st, online);
    commit(db, room, st);
    const out = { ...view(db, room, me), ...res };
    return err ? { ...out, ok: false, error: err } : out;
  },
  async rename(code, token, name) {
    await sleep(60);
    const n = name12(name); if (!n) return { ok: false, error: 'bad_name' };
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    const p = db.players.find(x => x.room_id === room.id && x.token_hash === token && !x.left_at);
    if (!p) return { ok: false, error: 'not_member' };
    p.nickname = n; p.last_seen = Date.now(); room.version++; save(db);
    return view(db, room, p.id);
  },
  async leave(code, token) {
    await sleep(60);
    const db = load(), room = db.rooms[code]; if (!room) return { ok: false, error: 'not_found' };
    const p = db.players.find(x => x.room_id === room.id && x.token_hash === token && !x.left_at);
    if (!p) return { ok: true };
    p.left_at = Date.now();
    let st = clone(room.state);
    if (st.game === 'dice' && st.dice) {
      st.dice.ready = del(st.dice.ready, p.id);
      if (st.dice.phase === 'rolling' && !st.dice.done.includes(p.id)) st.dice.participants = del(st.dice.participants, p.id);
      st = settle(st, onlineIds(db, room));
    }
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

window.LdcApi = { MOCK, GAMES_READY, ...(MOCK ? mock : real), subscribe, bump, _mock: mock };
})();
