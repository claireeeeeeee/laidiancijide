(() => {
'use strict';

const $ = id => document.getElementById('control-' + id);
const form = $('login'), room = $('room'), key = $('key'), questions = $('questions');
const roomList = $('rooms'), create = $('create-room');
const keyStorage = 'ldc_bluff_control_session';
const params = new URLSearchParams(location.search);
const messages = {
  forbidden: '主持密钥不对', bad_code: '房间号须为六位数字', not_found: '找不到这个房间',
  bad_question: '这道题已用过或不在本房间的题库中', not_installed: '主持接口尚未上线',
  network: '同步暂时中断，请检查网络', code_taken: '这个房间号已存在', busy: '暂时无法生成房间号，请重试'
};
const phases = {
  setup: '设置', recruit: '报名', roles: '看身份', choose: '选题', think: '准备',
  speak: '发言', guess: '指认', reveal: '揭晓', final: '最终排名'
};
const roles = { smart: '大聪明', honest: '老实人', bluffer: '捣蛋鬼' };
const cancelled = Symbol('control request cancelled');
let session, snapshot, pending = false, filterState;
let refreshing = false, operation = 0;

room.value = params.get('r') || '';
function consumeLinkKey() {
  const linkKey = new URLSearchParams(location.hash.slice(1)).get('key');
  if (linkKey) history.replaceState(null, '', location.pathname + location.search);
  return linkKey;
}
const linkKey = consumeLinkKey();
try { key.value = linkKey || sessionStorage.getItem(keyStorage) || ''; }
catch (e) { key.value = linkKey || ''; }


function choices() {
  const search = $('search').value.trim().toLowerCase();
  const options = (snapshot?.questions || []).filter(q => q.text.toLowerCase().includes(search));
  const signature = JSON.stringify(options);
  if (signature !== filterState) {
    const selected = questions.value;
    questions.replaceChildren(new Option(options.length ? '请选择一道题' : '没有符合条件的题', ''),
      ...options.map(q => new Option(q.text, q.id)));
    if (options.some(q => q.id === selected)) questions.value = selected;
    filterState = signature;
  }
  $('select').disabled = !questions.value || pending;
  $('clear').disabled = !snapshot?.queued || pending;
  roomList.disabled = pending;
  create.querySelector('button').disabled = pending;
}

function renderRoomList(rooms) {
  const selected = session?.room;
  roomList.replaceChildren(new Option('请选择房间', ''),
    ...rooms.map(r => new Option(r.code + ' · ' + r.players + ' 人', r.code)));
  if (selected && !rooms.some(r => r.code === selected)) roomList.add(new Option(selected, selected));
  roomList.value = selected || '';
}

function render() {
  $('game').hidden = !snapshot;
  $('invite').hidden = !snapshot;
  if (!snapshot) return;
  const link = new URL('index.html', location.href);
  link.searchParams.set('r', snapshot.code);
  $('join-link').href = link.href;
  $('round').textContent = '房间 ' + snapshot.code + ' · ' + (snapshot.round ? '第 ' + snapshot.round + ' 轮 · ' : '') +
    (phases[snapshot.phase] || '等待') + ' · ' + (snapshot.bank === 'story' ? '故事题' : '知识题');
  const list = $('players');
  list.replaceChildren(...snapshot.players.map(p => {
    const row = document.createElement('div');
    row.className = 'control-player';
    const name = document.createElement('span');
    name.textContent = p.name + (p.online ? '' : '（离线）');
    const role = document.createElement('span');
    role.textContent = roles[p.role] || '未分配';
    row.append(name, role);
    return row;
  }));
  if (!snapshot.players.length) list.textContent = '还没有玩家加入';
  const current = snapshot.current_question;
  $('current').hidden = !current?.text;
  $('current-question').textContent = current?.text || '';
  $('current-answer').textContent = current?.answer ? '答案 ' + current.answer : '';
  const queued = snapshot.questions.find(q => q.id === snapshot.queued);
  $('queued').textContent = queued ? '已指定「' + queued.text + '」。玩家进入选题时会看到这道题。'
    : '当前可以指定本房间尚未使用的题目。';
  choices();
}

function exit(message = '') {
  session = null;
  snapshot = null;
  filterState = null;
  $('dashboard').hidden = true;
  form.hidden = false;
  key.value = '';
  try { sessionStorage.removeItem(keyStorage); } catch (e) {}
  for (const id of ['players', 'rooms', 'questions', 'queued', 'round', 'current-question', 'current-answer']) $(id).replaceChildren();
  $('search').value = '';
  $('status').textContent = message;
  render();
}

async function request(action, code, id, isCurrent = () => true) {
  const current = session;
  if (!current) throw cancelled;
  const result = await LdcApi.bluffControl(code, current.key, action, id);
  if (session !== current || !isCurrent()) throw cancelled;
  if (!result?.ok) {
    const message = messages[result?.error] || '操作失败，请重试';
    if (result?.error === 'forbidden') exit(message);
    throw new Error(message);
  }
  return result;
}

async function run(work) {
  if (!session || pending) return;
  operation++;
  pending = true;
  form.querySelector('button').disabled = true;
  choices();
  try {
    await work();
  } catch (error) {
    if (error !== cancelled) $('status').textContent = error.message;
  } finally {
    pending = false;
    form.querySelector('button').disabled = false;
    choices();
    if (location.hash) loginFromHash();
  }
}

function rememberRoom(code) {
  session.room = code;
  const url = new URL(location.href);
  if (code) url.searchParams.set('r', code);
  else url.searchParams.delete('r');
  url.hash = '';
  history.replaceState(null, '', url);
}

async function loadRoom(code) {
  snapshot = code ? await request('view', code) : null;
  rememberRoom(code);
  roomList.value = code;
  render();
}

async function refresh() {
  if (!session?.room || !session.verified || pending || refreshing) return;
  const current = session;
  const version = operation;
  const isCurrent = () => session === current && operation === version;
  refreshing = true;
  try {
    const result = await request('view', current.room, undefined, isCurrent);
    if (!isCurrent()) return;
    if ($('status').textContent === messages.network) $('status').textContent = '';
    if (JSON.stringify(result) !== JSON.stringify(snapshot)) {
      snapshot = result;
      render();
    }
  } catch (error) {
    if (error !== cancelled && isCurrent()) $('status').textContent = error.message;
  } finally {
    refreshing = false;
  }
}

async function updateQuestion(action, id) {
  if (!session?.room || !session.verified) return;
  await run(async () => {
    const current = session;
    const result = await request(action, current.room, id);
    if (session !== current) return;
    snapshot = result;
    $('status').textContent = action === 'select' ? '题目已指定' : '已取消指定';
    render();
  });
}

form.addEventListener('submit', e => {
  e.preventDefault();
  if (pending) return;
  session = { room: room.value, key: key.value, verified: false };
  $('status').textContent = '';
  run(async () => {
    const result = await request('rooms', null);
    session.verified = true;
    try { sessionStorage.setItem(keyStorage, session.key); } catch (e) {}
    key.value = '';
    $('dashboard').hidden = false;
    form.hidden = true;
    renderRoomList(result.rooms);
    await loadRoom(session.room);
  });
});
roomList.addEventListener('change', () => run(async () => {
  const selected = roomList.value;
  $('status').textContent = '';
  await loadRoom(selected);
}));
create.addEventListener('submit', e => {
  e.preventDefault();
  run(async () => {
    const result = await request('create', $('new-code').value || null);
    const code = result.code;
    $('new-code').value = '';
    $('status').textContent = '已创建房间 ' + code;
    rememberRoom(code);
    const list = await request('rooms', null);
    renderRoomList(list.rooms);
    await loadRoom(code);
  });
});
$('copy').addEventListener('click', async () => {
  const link = $('join-link').href;
  try {
    await navigator.clipboard.writeText(link);
    $('status').textContent = '玩家链接已复制';
  } catch (e) { $('status').textContent = link; }
});
$('search').addEventListener('input', choices);
questions.addEventListener('change', choices);
$('select').addEventListener('click', () => updateQuestion('select', questions.value));
$('clear').addEventListener('click', () => updateQuestion('clear'));
$('exit').addEventListener('click', () => exit());
setInterval(() => { if (!document.hidden) refresh(); }, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
function loginFromHash() {
  if (pending) return;
  const secret = consumeLinkKey();
  if (!secret) return;
  exit();
  room.value = new URLSearchParams(location.search).get('r') || '';
  key.value = secret;
  if (form.checkValidity()) form.requestSubmit();
}
window.addEventListener('hashchange', loginFromHash);
if (key.value && form.checkValidity()) form.requestSubmit();
})();
