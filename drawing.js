(() => {
'use strict';

const cfg = window.LDC_CONFIG || {};
const Account = window.LdcAccount;
const url = new URL(location.href);
const $ = selector => document.querySelector(selector);
const page = $('#draw-page');
const mock = url.searchParams.has('mock');
const localBackend = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && cfg.supabaseUrl===location.origin;
const modal = $('#draw-dialog');
const NAME = '有内鬼，继续画！';
const COLORS = ['#b72b49','#285bbd','#147442','#8546a1','#d05a12','#157b85','#9a572f','#bc3a86','#666500','#354963'];
const BANKS = ['日常用品','动物','食物','交通工具','自然','场景','职业','抽象概念','搞怪题目'];
const DIFFICULTIES = [['mix','简单与普通'],['easy','简单'],['normal','普通'],['hard','困难']];
const ERRORS = {
  bad_code:'请输入六位数字房间码。', not_found:'找不到这个房间或对局。',
  not_member:'请用原来的设备重新加入。', name_taken:'这个昵称已有席位，请换一个昵称。',
  bad_name:'昵称需要 1 至 12 个字。', full:'房间人数已满，或人数少于当前席位。',
  in_progress:'这局已开始，请等下一局。', not_ready:'需要达到设定人数，且所有玩家都已准备。',
  bad_settings:'请检查房间设置。', empty:'这个题库和难度组合没有可用题目。',
  bad_target:'请选择一位可投票的玩家。', already_voted:'本次投票已经提交。',
  phase:'游戏已进入下一步。', session_changed:'这个席位已在另一页打开。请刷新后继续。', not_yours:'现在还没有轮到你绘画。',
  bad_stroke:'笔画未能提交。', not_installed:'绘画房间的数据库尚未安装。',
  forbidden:'管理员密钥不正确。', network:'连接暂时中断，正在重试。', server:'服务器暂时无法处理请求。'
};
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v) { try { localStorage.setItem(k,v); } catch {} }
};
const skin = storage.get('ldc_skin');
if (['night','oc','sakura'].includes(skin)) document.documentElement.dataset.skin = skin;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const makeToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2,'0')).join('');
const session = makeToken();
const codeValid = value => /^[0-9]{6}$/.test(value || '');
const tokenKey = code => 'ldc_draw_token_' + code;
const known = () => data ? { known_game:data.game, known_turn:data.turn } : {};
let code = codeValid(url.searchParams.get('r')) ? url.searchParams.get('r') : '';
let token = code ? storage.get(tokenKey(code)) : null;
let data = null, strokes = [], clockOffset = 0, shown = '', lastResponse = 0;
let timer, polling = false, busy = false, noticeTimer, livePointer = null, path = null, committed = false;
let skipTurn = null;
let previewTimer, seq = 0, lastDraftSize = 0, previewBusy = false, selected = '', ballotKey = '';
let history = null, replay = null, settingForm = false, networkLost = false, topicShown = false;
let topics = [];

async function rpc(fn,args) {
  if (mock && !localBackend) return {ok:false,error:'not_installed'};
  try {
    const response = await fetch(cfg.supabaseUrl + '/rest/v1/rpc/' + fn,{
      method:'POST',headers:{'Content-Type':'application/json',apikey:cfg.supabaseAnonKey, Authorization:'Bearer ' + cfg.supabaseAnonKey},
      body:JSON.stringify(args),signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) return {ok:false,error:response.status===404?'not_installed':'server'};
    return await response.json();
  } catch { return {ok:false,error:'network'}; }
}
const api = (action,args = {},room = code,key = token) => mock
  ? rpc('ldc_draw_play',{p_code:room,p_token:key,p_action:action,p_args:{...args,session}})
  : Account.scoped('drawing',room,action,{...args,session});
function notify(error,raw = false) {
  const msg = $('#draw-notice');
  msg.textContent = raw ? error : ERRORS[error] || '请再试一次。';
  msg.classList.remove('hide');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => msg.classList.add('hide'),3000);
}
const playerName = id => data?.players.find(p => p.id===id)?.name || '离线玩家';
const btn = (act,label,kind='b3',disabled=false) => `<button type="button" class="btn ${kind}" data-draw="${act}" ${disabled?'disabled':''}>${label}</button>`;
const board = () => '<canvas id="draw-board" class="draw-board" width="1000" height="1000" aria-label="共享画布"></canvas>';
const current = () => data?.phase==='draw' ? data.players[data.turn % data.players.length] : null;
const ownsTurn = () => Boolean(current() && current().id===data.me && data.drawing_session && !document.hidden);
const palette = index => COLORS[index % COLORS.length];
const dot = index => `<span aria-hidden="true" class="draw-color" style="--player-color:${palette(index)}"></span>`;
const header = (title,note='') => `<div class="draw-kicker">${code?`房间 ${esc(code)}`:'多人绘画推理'}${note?` · ${note}`:''}</div><h1 class="h-title disp draw-title">${title}</h1>`;
const options = (list,value) => list.map(([key,label]) => `<option value="${esc(key)}" ${String(key)===String(value)?'selected':''}>${esc(label)}</option>`).join('');
const select = (name,label,list,value) => `<label>${label}<select name="${name}">${options(list,value)}</select></label>`;
function showDialog(html) {
  modal.innerHTML = html;
  if (!modal.open) modal.showModal();
}
function renderLanding() {
  const suggested = storage.get('ldc_name') || '';
  page.innerHTML = header(NAME) + '<p class="tip">大家轮流画一笔，只有一人不知道题目。你能从笔画里找出那位空白画家吗？</p>' +
    `<form class="draw-form" id="draw-join">
      ${mock?`<label>昵称<input maxlength="12" required name="name" value="${esc(suggested)}" autocomplete="nickname"></label>`:''}
      <label>房间码<input inputmode="numeric" pattern="[0-9]{6}" required maxlength="6" name="code" value="${esc(code)}"></label>
      <button class="btn b1">加入房间</button>
      ${btn('create','建立房间')}
    </form>` + window.LdcInstallGuide.slot() + (storage.get('ldc_admin') ? btn('topic-admin','管理绘画题库') : '');
  $('#draw-share').hidden = true;
}
function settingsHTML(s) {
  const nums = (values,unit) => values.map(v => [v,v===0?'不限时':v+unit]);
  return `<form class="draw-form" id="draw-settings">
     <div class="draw-grid">
      ${select('size','人数',nums([3,4,5,6,7,8,9,10],' 人'),s.size)}
      ${select('rounds','每人笔数',nums([1,2,3],' 笔'),s.rounds)}
      ${select('turn_secs','每笔限时',nums([0,10,20,30,60],' 秒'),s.turn_secs)}
      ${select('discussion_secs','讨论限时',nums([0,30,60,120],' 秒'),s.discussion_secs)}
      ${select('order','绘画顺序',[['random','随机'],['join','加入顺序']],s.order)}
      ${select('votes','投票方式',[['anonymous','匿名，揭晓后公开'],['public','公开'],['secret','只公布票数']],s.votes)}
      ${select('bank','题库',[['all','综合'],...BANKS.map(b=>[b,b])],s.bank)}
      ${select('difficulty','难度',DIFFICULTIES,s.difficulty)}
     </div>
     <div class="draw-actions"><button class="btn b1">保存设置</button>${btn('settings','取消')}</div>
  </form>`;
}
function roster() {
  const d = data;
  return `<div class="list draw-roster">${d.players.map((p,i) => {
    let status = p.online ? '在线' : '暂时离线';
    if (d.phase==='lobby' && p.online) status = p.ready?'已准备':'未准备';
    if (d.phase==='roles' && p.online) status = d.seen.includes(p.id)?'已查看':'待查看';
    if (d.phase==='draw') {
      const lastTurn = i + Math.floor(d.turn/d.players.length)*d.players.length;
      if (lastTurn===d.turn) status = p.online?'正在绘画':'等待重连';
      else if (lastTurn<d.turn) status = d.skipped.includes(lastTurn)?'已跳过':'已完成';
      else if (p.online) status = '等待中';
    }
    if (d.phase==='discuss' && p.online) status=d.agreed.includes(p.id)?'同意投票':'讨论中';
    return `<div class="row">${d.phase==='lobby'?'':dot(i)}<span class="who">${esc(p.name)}${p.id===d.me?'（我）':''}</span><span class="st">${status}</span></div>`;
  }).join('')}</div>`;
}
function historyHTML() {
  if (!data.history?.length) return '';
  return `<details class="draw-history"><summary>最近对局</summary>
    ${data.history.map(h=>`<div class="row"><button class="link" data-draw="history" data-game="${esc(h.game)}">${esc(h.topic)} · ${new Date(h.finished_at).toLocaleDateString('zh-CN')}</button>
      <button class="link" data-draw="hide-history" data-game="${esc(h.game)}">删除我的记录</button></div>`).join('')}</details>`;
}
function lobbyHTML() {
  const d = data, mine = d.players.find(p=>p.id===d.me);
  const all = d.players.length===d.settings.size && d.players.every(p=>p.online && p.ready);
  return header(NAME,`${d.players.filter(p=>p.online).length}/${d.settings.size} 人在线`) + roster() + window.LdcInstallGuide.slot() +
    (settingForm ? settingsHTML(d.settings) :
      `<p class="note">每人 ${d.settings.rounds} 笔 · ${d.settings.bank==='all'?'综合题库':esc(d.settings.bank)} · ${d.settings.turn_secs?`每笔 ${d.settings.turn_secs} 秒`:'绘画不限时'}</p>
      <div class="draw-actions">${btn('ready',mine?.ready?'取消准备':'准备',mine?.ready?'b3':'b1')}${btn('start','开始游戏','b1',!all)}</div>
      <div class="draw-actions">${btn('settings','游戏设置')}${btn('leave','退出房间')}</div>`) + historyHTML();
}
function topicHTML() {
  return `<details class="draw-topic" id="draw-topic" ${topicShown?'open':''}><summary>查看自己的题卡</summary>
    ${data.is_blank?'<p>你是空白画家。观察大家的笔画，试着混进去。</p>':`<p>本局主题 <strong>${esc(data.topic)}</strong></p>`}</details>`;
}
function voteHTML() {
  const d = data;
  const voted = d.voted.includes(d.me);
  const eligible = d.targets.some(id=>id!==d.me);
  return header(d.ballot===2?'平票重投':'谁是空白画家？') + board() + topicHTML() +
    `<div class="list draw-roster">${d.players.filter(p=>d.targets.includes(p.id)||p.id===d.me).map(p=>
      `<button type="button" class="row" data-draw="pick" data-player="${esc(p.id)}" aria-pressed="${p.id===selected}" ${voted||p.id===d.me?'disabled':''}>
      ${dot(d.players.indexOf(p))}<span class="who">${esc(p.name)}${p.id===d.me?'（我）':''}</span>
      ${d.votes?`<span class="st">${Object.values(d.votes).filter(id=>id===p.id).length} 票</span>`:''}</button>`).join('')}</div>
    ${voted||!eligible?`<p class="note">${voted?'已投票，等待其他玩家。':'这轮没有可投的候选人。'}</p>`:btn('vote','提交投票','b1',!selected)}
    <p class="note">已投票 ${d.voted.length} 人</p>`;
}
function resultHTML(r,old=false) {
  const votes = (map,title) => map && Object.keys(map).length
    ? `<details><summary>${title}</summary>${Object.entries(map).map(([v,t])=>`<p class="note">${esc(r.map[v])} → ${esc(r.map[t])}</p>`).join('')}</details>`:'';
  return header(r.caught?'普通玩家获胜':'空白画家获胜') +
    `<div class="draw-topic"><strong>${esc(r.topic)}</strong> · 空白画家是 ${esc(r.map[r.blank])}</div>` + board() +
    `<div class="list draw-roster">${r.order.map((id,i)=>`<div class="row">${dot(i)}<span class="who">${esc(r.map[id])}</span>
       <span class="st">${(r.strokes||strokes).filter(s=>s.player===id).length} 笔 · ${r.scores[id]||0} 票</span></div>`).join('')}</div>
     ${votes(r.first_votes,'首轮投票')}${votes(r.votes,'本轮投票')}
     <div class="draw-actions">${btn('replay','回放画作')}${btn('save','保存 PNG')}</div>
     ${old?btn('close-history','返回房间'):`<div class="draw-actions">${btn('again','再玩一局','b1')}${btn('change-bank','更换题库')}</div>
     <div class="draw-actions">${btn('punishment','进入惩罚游戏')}</div>${historyHTML()}`}`;
}
function screen() {
  const d = data;
  if (history) return resultHTML(history,true);
  if (d.phase==='lobby') return lobbyHTML();
  if (!d.member) return header('等待下一局')+'<p class="note">本局已揭晓，可以请场上玩家开启下一局。</p>'+historyHTML();
  switch (d.phase) {
    case 'roles': return header('查看身份') + `<section class="qcard"><p>${d.is_blank?'你是空白画家':esc(d.topic)}</p></section>
      <p class="tip">${d.is_blank?'观察其他人的笔画，尽量让自己画得像知道题目。':'记住主题，先别告诉其他玩家。'}</p>` + roster() +
      btn('seen',d.seen.includes(d.me)?'等待其他玩家确认':'我已查看','b1',d.seen.includes(d.me));
    case 'draw': {
      const p = current();
      return header(ownsTurn()?'轮到你画一笔':`${esc(p?.name)}在画`,`第 ${Math.floor(d.turn/d.players.length)+1}/${d.settings.rounds} 轮`) +
        `<p class="note draw-board-note">${p?.id===d.me&&!d.drawing_session?'此席位已在另一页打开。':p?.online?'抬手即提交，一次只能画一笔。':'等当前玩家重连，超时后自动跳过。'} <span class="draw-timer"></span></p>` +
        board() + topicHTML() + roster() + (ownsTurn()?btn('skip','跳过本笔'):'');
    }
    case 'discuss': return header('画完了，聊一聊') + board() + topicHTML() + '<p class="note">找出不知道主题的人。 <span class="draw-timer"></span></p>' +
      roster() + btn('agree',d.agreed.includes(d.me)?'等待其他玩家同意':'我同意开始投票','b1',d.agreed.includes(d.me));
    case 'vote': return voteHTML();
    case 'result': return d.result ? resultHTML(d.result) : header('正在揭晓');
    default: return header(NAME);
  }
}
function render(force=false) {
  if (!data) { if (!shown || force) { renderLanding(); shown='entry'; } return; }
  const d = data;
  const signature = JSON.stringify([d.phase,d.game,d.turn,d.ballot,d.voted,d.votes,d.players,d.seen,d.agreed,d.settings,d.drawing_session,d.history?.map(h=>h.game),history?.game,settingForm,selected]);
  const editing = settingForm && page.querySelector('#draw-settings');
  if (!replay && (force || shown!==signature) && (livePointer===null || !page.querySelector('#draw-board')) && (!editing || force || d.phase!=='lobby')) {
    const opened = page.querySelector('.draw-history')?.open;
    if (page.querySelector('#draw-topic')) topicShown = page.querySelector('#draw-topic').open;
    page.innerHTML = screen();
    if (opened && page.querySelector('.draw-history')) page.querySelector('.draw-history').open = true;
    shown = signature;
    const canvas = $('#draw-board');
    if (canvas) attachBoard(canvas);
  }
  $('#draw-share').hidden = false;
  paint();
  tick();
}
function accept(out) {
  if (!out?.phase) return;
  const now = Date.parse(out.now);
  if (now<lastResponse) return;
  lastResponse=now;
  clockOffset=now-Date.now();
  if (!data || out.game!==data.game || out.turn!==data.turn || out.phase!==data.phase) {
    cancelStroke();
    if ($('#draw-dialog [data-draw=retry-stroke]')) modal.close();
    if (!data || out.game!==data.game || out.phase==='lobby') strokes=[];
    if (out.phase!=='lobby') settingForm=false;
    if (out.phase==='roles') topicShown=false;
  }
  const k = `${out.game}:${out.ballot}`;
  if (k!==ballotKey) { selected=''; ballotKey=k; }
  if (Array.isArray(out.strokes)) strokes=out.strokes;
  data=out;
  if (out.history_result) history=out.history_result;
  render();
}
function tick() {
  const timerEl=$('.draw-timer');
  if (timerEl) timerEl.textContent=data.deadline?`剩余 ${Math.max(0,Math.ceil((Date.parse(data.deadline)-Date.now()-clockOffset)/1000))} 秒`:'';
}
setInterval(tick,250);
function schedulePoll(delay) {
  clearTimeout(timer);
  if (data && !document.hidden) timer=setTimeout(poll,delay);
}
async function poll() {
  if (polling || !data || document.hidden) return;
  polling=true;
  const currentCode=code, currentToken=token;
  try {
    const out=await api('poll',known());
    if (currentCode!==code || currentToken!==token || document.hidden || !data) return;
    if (out.ok) {
      networkLost=false;
      accept(out);
    } else if (out.error==='not_member') {
      data=null;
      render(true);
      notify(out.error);
    } else if (!networkLost) {
      networkLost=true;
      notify(out.error);
    }
  } finally {
    polling=false;
    schedulePoll(networkLost?1200:data?.phase==='draw'?170:750);
  }
}
async function join(room,name) {
  if (!codeValid(room)) { notify('bad_code'); return; }
  const key=mock?(storage.get(tokenKey(room)) || makeToken()):'account';
  const out=await api('join',{name},room,key);
  if (!out.ok) { notify(out.error); return; }
  code=room; token=key; data=null; lastResponse=0; settingForm=false; history=null; shown='';
  if (mock) {
    storage.set(tokenKey(code),key);
    if (name) storage.set('ldc_name',name);
  }
  url.searchParams.set('r',code);
  url.searchParams.delete('lobby');
  window.history.replaceState(null,'',url);
  if (!mock) $('#draw-profile').href=Account.pageURL();
  accept(out);
  schedulePoll(20);
}
async function command(action,args={}) {
  if (busy || !data) return;
  busy=true;
  const room=code, key=token;
  try {
    const out=await api(action,{...known(),game:data.game,turn:data.turn,ballot:data.ballot,...args});
    if (room!==code || key!==token) return;
    if (action==='leave' && out.ok) {
      cancelStroke(); data=null; clearTimeout(timer); code=''; token=null; lastResponse=0; history=null;
      url.searchParams.delete('r'); url.searchParams.delete('lobby');
      window.history.replaceState(null,'',url);
      if (!mock) $('#draw-profile').href=Account.pageURL();
      render(true);
      return;
    }
    accept(out);
    if (!out.ok) notify(out.error);
    if (out.ok && ['configure','history','hide_history'].includes(action)) render(true);
    return out;
  } finally { busy=false; }
}
function line(ctx,points,color,width) {
  if (!points?.length) return;
  ctx.strokeStyle=color;
  ctx.fillStyle=color;
  ctx.lineCap='round';
  ctx.lineJoin='round';
  ctx.lineWidth=width;
  ctx.beginPath();
  if (points.length===1) {
    ctx.arc(points[0][0],points[0][1],width/2,0,Math.PI*2);
    ctx.fill();
    return;
  }
  ctx.moveTo(...points[0]);
  for (let i=1;i<points.length;i++) ctx.lineTo(...points[i]);
  ctx.stroke();
}
function paint() {
  const canvas=$('#draw-board');
  if (!canvas) return;
  const writable=ownsTurn() && !history && !committed;
  canvas.dataset.writable=String(writable);
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,1000,1000);
  const source=history?.strokes || strokes;
  const order=history?.order || data.players.map(p=>p.id);
  if (replay) {
    let left=replay.position;
    for (const s of source) {
      if (left<=0) break;
      line(ctx,s.points.slice(0,Math.ceil(left)),palette(order.indexOf(s.player)),7);
      left-=s.points.length;
    }
    return;
  }
  for (const s of source) line(ctx,s.points,palette(order.indexOf(s.player)),7);
  const active=current();
  if (active && !history) {
    const points=active.id===data.me && path && data.drawing_session ? path : data.draft?.points;
    if (points) line(ctx,points,palette(data.turn%data.players.length),7);
  }
}
function sample(canvas,event) {
  const r=canvas.getBoundingClientRect();
  const normalize=(value,start,length)=>Math.round(Math.max(0,Math.min(1,(value-start)/length))*1000);
  return [normalize(event.clientX,r.left+canvas.clientLeft,canvas.clientWidth),
          normalize(event.clientY,r.top+canvas.clientTop,canvas.clientHeight)];
}
function appendPoint(point) {
  const last=path.at(-1);
  if (last && Math.hypot(point[0]-last[0],point[1]-last[1])<2) return;
  if (path.length>=360) path=path.filter((_,i)=>i%2===0 || i===path.length-1);
  path.push(point);
}
async function preview() {
  if (!path || committed || previewBusy || !ownsTurn() || lastDraftSize===path.length) return;
  previewBusy=true;
  lastDraftSize=path.length;
  try {
    await api('preview',{...known(),game:data.game,turn:data.turn,seq:++seq,points:path});
  } finally { previewBusy=false; }
}
function cancelStroke() {
  clearInterval(previewTimer);
  livePointer=null; path=null; committed=false; lastDraftSize=0;
}
function attachBoard(canvas) {
  canvas.addEventListener('pointerdown',event=>{
    if (!ownsTurn() || livePointer!==null || committed || event.button!==0) return;
    event.preventDefault();
    livePointer=event.pointerId;
    path=[sample(canvas,event)]; lastDraftSize=0;
    canvas.setPointerCapture(event.pointerId);
    previewTimer=setInterval(preview,120);
    preview();
    paint();
  });
  canvas.addEventListener('pointermove',event=>{
    if (event.pointerId!==livePointer || !path) return;
    for (const point of event.getCoalescedEvents?.() || []) appendPoint(sample(canvas,point));
    appendPoint(sample(canvas,event));
    paint();
  });
  canvas.addEventListener('pointerup',async event=>{
    if (event.pointerId!==livePointer || !path) return;
    appendPoint(sample(canvas,event));
    clearInterval(previewTimer);
    livePointer=null;
    committed=true;
    paint();
    const game=data.game, turn=data.turn, points=path;
    const out=await command('finish',{game,turn,points});
    if (data?.game===game && data.turn===turn && !out?.ok) {
      if (out?.error==='network') showDialog('<h2>笔画还没确认</h2><p>网络中断。连接恢复后，可以重试提交同一笔。</p>'+btn('retry-stroke','重试提交','b1')+btn('close','关闭'));
      else { cancelStroke(); render(true); }
    }
  });
  canvas.addEventListener('pointercancel',()=>{
    if (livePointer===null) return;
    cancelStroke();
    command('cancel_preview',{seq:++seq});
    render(true);
  });
}
function stopReplay() {
  if (replay) cancelAnimationFrame(replay.frame);
  replay=null;
  paint();
}
function startReplay() {
  stopReplay();
  const length=(history?.strokes || strokes).reduce((n,s)=>n+s.points.length,0);
  if (!length) return notify('这局没有笔画。',true);
  const rate=Math.max(40,length/12);
  replay={position:0,speed:1,paused:false,time:performance.now()};
  showDialog(`<h2>回放画作</h2><div class="draw-actions">${btn('replay-pause','暂停','b1')}${btn('replay-reset','从头播放')}</div>
    <label>播放速度 <select id="draw-speed">${options([[1,'1 倍'],[2,'2 倍'],[4,'4 倍']],1)}</select></label>${btn('close','关闭')}`);
  paint();
  function frame(time) {
    if (!replay) return;
    if (!replay.paused) replay.position=Math.min(length,replay.position+Math.min(50,time-replay.time)*rate*replay.speed/1000);
    replay.time=time;
    paint();
    replay.frame=requestAnimationFrame(frame);
  }
  // 同一个画布放到回放弹层里，触屏也能边看边切换速度。
  const canvas=$('#draw-board');
  if (canvas) {
    replay.anchor=document.createComment('绘画回放');
    canvas.before(replay.anchor);
    modal.querySelector('h2').after(canvas);
  }
  replay.frame=requestAnimationFrame(frame);
}
function finishReplay() {
  if (!replay) return;
  const canvas=$('#draw-board');
  if (replay.anchor?.isConnected && canvas) replay.anchor.replaceWith(canvas);
  else canvas?.remove();
  stopReplay();
  render();
}
function savePNG(keepsake) {
  const r=history || data.result;
  const canvas=document.createElement('canvas');
  canvas.width=1000; canvas.height=keepsake?1200:1000;
  const ctx=canvas.getContext('2d');
  ctx.fillStyle='#fffdf8'; ctx.fillRect(0,0,canvas.width,canvas.height);
  for (const s of r.strokes || strokes) line(ctx,s.points,palette(r.order.indexOf(s.player)),7);
  if (keepsake) {
    ctx.fillStyle='#253043'; ctx.font='bold 36px system-ui,sans-serif';
    ctx.fillText(NAME+' · '+r.topic,32,1056,930);
    ctx.font='24px system-ui,sans-serif';
    r.order.forEach((id,i)=>{
      const x=35+(i%5)*193, y=1112+Math.floor(i/5)*42;
      ctx.fillStyle=palette(i); ctx.fillRect(x,y-17,16,16);
      ctx.fillStyle='#253043'; ctx.fillText(r.map[id],x+23,y,155);
    });
  }
  canvas.toBlob(blob=>{
    if (!blob) return notify('图片保存失败。',true);
    const imageURL=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=imageURL; a.download=`画作-${r.topic}.png`; a.click();
    setTimeout(()=>URL.revokeObjectURL(imageURL),30000);
  },'image/png');
}
function share() {
  if (!code) return;
  const invitation=new URL('drawing.html',location.href);
  invitation.searchParams.set('r',code);
  if (mock) invitation.searchParams.set('mock','1');
  let qr='';
  if (window.qrcode) {
    const q=window.qrcode(0,'M');
    q.addData(invitation.href); q.make(); qr=q.createSvgTag({cellSize:4,margin:0,scalable:true});
  }
  showDialog(`<h2>邀请朋友</h2><div class="room-no disp">${esc(code)}</div>${qr?`<div class="qr">${qr}</div>`:''}
    <p class="url">${esc(invitation.href)}</p>${btn('copy-share','复制链接','b1')}${btn('close','关闭')}`);
}
function rules() {
  showDialog(`<h2>${NAME}</h2>
    <ol><li>3–10 人在同一房间准备，任意玩家都可开始。</li>
    <li>只有一人不知道主题。确认身份后，大家按顺序各画一笔，抬手即提交。</li>
    <li>画完后讨论，每人投一票找空白画家。最高票平票时重投一次，再平票则空白画家获胜。</li>
    <li>掉线后用原来的设备返回，身份和已提交的笔画会保留。当前画家超时未回来时，跳过该笔。</li></ol>${btn('close','关闭','b1')}`);
}
function punishment() {
  const r=history || data.result;
  const picks=r.caught?[r.blank]:r.order.filter(id=>id!==r.blank);
  const targets=[['suggested',picks.map(id=>r.map[id]).join('、')],...r.order.map(id=>[id,r.map[id]])];
  showDialog(`<h2>进入惩罚游戏</h2><label>接受惩罚 <select id="draw-penalty">${options(targets,'suggested')}</select></label>
    ${btn('go-punishment','打开真心话大冒险','b1')}${btn('close','关闭')}`);
}
async function editTopics(action='list',form={},id=null) {
  const key=storage.get('ldc_admin');
  if (!key) return;
  const out=await rpc('ldc_draw_topic_admin',{p_key:key,p_action:action,p_id:id,p_word:form.word||null,
    p_category:form.category||null,p_difficulty:form.difficulty||null});
  if (!out.ok) return notify(out.error);
  topics=out.topics || [];
  topicEditor();
}
function topicEditor(id) {
  const item=topics.find(t=>String(t.id)===id);
  showDialog(`<h2>绘画题库</h2><form id="draw-topic-editor" class="draw-form">
    <input type="hidden" name="id" value="${item?.id||''}">
    <label>题目<input name="word" required maxlength="24" value="${esc(item?.word)}"></label>
    <div class="draw-grid">${select('category','分类',BANKS.map(x=>[x,x]),item?.category)}
      ${select('difficulty','难度',DIFFICULTIES.slice(1),item?.difficulty)}</div>
    <button class="btn b1">${item?'保存编辑':'添加题目'}</button>
  </form>
  <details class="draw-history" ${item?'':'open'}><summary>已有题目</summary><div class="list">
    ${topics.map(t=>`<div class="row"><button class="link" data-draw="edit-topic" data-id="${t.id}">${esc(t.word)}</button>
      ${t.active?`<button class="link" data-draw="disable-topic" data-id="${t.id}">停用</button>`:'<span class="st">已停用</span>'}</div>`).join('')}
  </div></details>${btn('close','关闭')}`);
}
modal.addEventListener('submit',async event=>{
  if (event.target.id!=='draw-topic-editor') return;
  event.preventDefault();
  const form=Object.fromEntries(new FormData(event.target));
  await editTopics('save',form,form.id?Number(form.id):null);
});
async function create(name) {
  const out=await api('create');
  if (!out.ok) return notify(out.error);
  await join(out.code,name);
  if (data?.code===out.code) { settingForm=true; render(true); }
}
page.addEventListener('submit',async event=>{
  event.preventDefault();
  const form=event.target, values=Object.fromEntries(new FormData(form));
  if (form.id==='draw-join') {
    if (busy) return;
    busy=true;
    try { await join(values.code,values.name?.trim()); } finally { busy=false; }
  } else if (form.id==='draw-settings') {
    const out=await command('configure',{settings:values});
    if (out?.ok) { settingForm=false; render(true); }
  }
});
$('#draw-share').addEventListener('click',share);
$('#draw-rules').addEventListener('click',rules);
modal.addEventListener('close',finishReplay);
modal.addEventListener('change',event=>{
  if (event.target.id==='draw-speed' && replay) replay.speed=Number(event.target.value);
});
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-draw]');
  if (!button || button.disabled) return;
  const action=button.dataset.draw;
  switch (action) {
    case 'create': {
      if (busy) return;
      const field=page.querySelector('[name=name]');
      if (field && (!field.reportValidity() || !field.value.trim())) return notify('bad_name');
      busy=true;
      try { await create(field?.value.trim()); } finally { busy=false; }
      break;
    }
    case 'settings': settingForm=!settingForm; render(true); break;
    case 'topic-admin': await editTopics(); break;
    case 'edit-topic': topicEditor(button.dataset.id); break;
    case 'disable-topic': await editTopics('disable',{},Number(button.dataset.id)); break;
    case 'copy-share':
      try { await navigator.clipboard.writeText(modal.querySelector('.url').textContent); notify('已复制链接。',true); }
      catch { notify('请长按房间链接复制。',true); }
      break;
    case 'close': modal.close(); break;
    case 'pick': selected=button.dataset.player; render(true); break;
    case 'vote': await command('vote',{target:selected}); break;
    case 'skip': skipTurn={game:data.game,turn:data.turn}; showDialog('<h2>跳过这一笔？</h2><p>这一笔会记为跳过，接下来轮到下一位。</p>'+btn('confirm-skip','确认跳过','b1')+btn('close','取消')); break;
    case 'confirm-skip': modal.close(); await command('skip',skipTurn); break;
    case 'retry-stroke': {
      const out=path && await command('finish',{points:path});
      if (out?.ok) modal.close();
      break;
    }
    case 'leave': showDialog('<h2>退出房间？</h2>'+btn('confirm-leave','确认退出','b1')+btn('close','取消')); break;
    case 'confirm-leave': modal.close(); await command('leave'); break;
    case 'change-bank':
      if ((await command('again'))?.ok) { settingForm=true; render(true); }
      break;
    case 'history': await command('history',{game:button.dataset.game}); break;
    case 'close-history': history=null; render(true); break;
    case 'hide-history':
      showDialog(`<h2>删除我的这条记录？</h2><p>该记录将从你的对局列表移除。</p><button class="btn b1" data-draw="confirm-hide-history" data-game="${esc(button.dataset.game)}">删除</button>`+btn('close','取消')); break;
    case 'confirm-hide-history': modal.close(); await command('hide_history',{game:button.dataset.game}); break;
    case 'replay': startReplay(); break;
    case 'replay-pause': if (replay) { replay.paused=!replay.paused; button.textContent=replay.paused?'继续':'暂停'; } break;
    case 'replay-reset': if (replay) replay.position=0; break;
    case 'save': showDialog('<h2>保存作画</h2>'+btn('save-board','纯画布','b1')+btn('save-keepsake','纪念版')+btn('close','关闭')); break;
    case 'save-board': savePNG(false); modal.close(); break;
    case 'save-keepsake': savePNG(true); modal.close(); break;
    case 'punishment': punishment(); break;
    case 'go-punishment': {
      const link=new URL('index.html',location.href);
      const r=data.result;
      const id=$('#draw-penalty').value;
      const names=id==='suggested' ? (r.caught?[r.blank]:r.order.filter(player=>player!==r.blank)) : [id];
      if (!(await command('open_punishment'))?.ok) return;
      link.searchParams.set('penalty',names.map(player=>r.map[player]).join('、'));
      link.searchParams.set('r',code);
      link.searchParams.set('game','truth');
      location.href=link;
      break;
    }
    case 'ready': case 'start': case 'seen': case 'agree': case 'again': await command(action); break;
  }
});
document.addEventListener('visibilitychange',()=>{
  if (document.hidden) {
    if (livePointer!==null) command('cancel_preview',{seq:++seq});
    cancelStroke();
    clearTimeout(timer);
  } else {
    render(true);
    schedulePoll(0);
  }
});
window.addEventListener('pageshow',()=>{ if (data) schedulePoll(0); });
async function boot() {
  if (!mock) {
    const identity=await Account.load();
    if (!identity.ok) { Account.requireLogin(); return; }
    const profile=$('#draw-profile');
    profile.title=identity.user.nickname;
    profile.querySelector('.player-profile-avatar').textContent=[...identity.user.nickname][0];
    profile.href=Account.pageURL();
    profile.hidden=false;
  }
  render();
  const from=url.searchParams.get('from');
  if (codeValid(from)) $('#draw-back').href='index.html?r='+from;
  if (code && (!mock || token)) {
    const out=await api('join');
    if (out.ok) {
      if (!mock) token='account';
      accept(out); schedulePoll(0); return;
    }
    if (!(url.searchParams.has('lobby') && out.error==='not_found') && out.error!=='not_member' && out.error!=='bad_name') notify(out.error);
  }
  if (code && url.searchParams.has('lobby')) {
    const lobbyToken=storage.get('ldc_tok_'+code);
    if (!mock || lobbyToken) {
      const out=await api('lobby',{lobby_token:lobbyToken});
      if (out.ok) await join(code,out.nickname);
      else notify(out.error);
    }
  }
}
boot();
})();
