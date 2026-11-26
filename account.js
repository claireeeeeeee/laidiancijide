(() => {
'use strict';
const A=window.LdcAccount;
const page=document.querySelector('#account-page');
const back=document.querySelector('#account-back');
const q=new URLSearchParams(location.search);
const adminMode=q.has('admin');
const candidate=q.get('return') || '';
const safeReturn=/^(index|drawing)\.html(?:\?|$)/.test(candidate)?candidate:'index.html';
const inRoom=new URL(safeReturn,location.href).searchParams.has('r');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const gameNames={bluff:'瞎掰王',drawing:'有内鬼，继续画！',werewolf:'狼人杀',undercover:'谁是卧底',dice:'摇骰子',truth:'真心话大冒险',king:'国王游戏',adjustment:'管理员调整'};
const errors={network:'网络暂时无法连接，请重试。',server:'服务器暂时无法处理请求。',not_installed:'用户系统尚未部署。',
  bad_name:'昵称需要 1 到 12 个字。',name_taken:'这个昵称已经有人使用。',
  name_conflict:'有相近的旧昵称，请输入原来的大小写，或请管理员帮你查找。',
  forbidden:'管理员密钥不正确。',not_found:'没有找到这个账号。',account_required:'请先登录。',bad_action:'请检查填写内容。'};
const skin=localStorage.getItem('ldc_skin');
if (['night','oc','sakura'].includes(skin)) document.documentElement.dataset.skin=skin;
if (adminMode) document.title='账号管理 · 来点刺激的';
back.href=safeReturn;
let timer,busy=false,view='entry',profile=null,ledger=null,filters={},items=[],selected=null,adminKey='',results=null,query='';

const title=t=>`<h1 class="h-title disp">${t}</h1>`;
const button=(action,label,kind='b3')=>`<button class="btn ${kind}" type="button" data-account="${action}">${label}</button>`;
const submit=label=>`<button class="btn b1">${label}</button>`;
const sign=n=>n>0?'+'+n:String(n);
const date=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'';
const name=g=>gameNames[g]||g;
function notify(msg) {
  const el=document.querySelector('#account-notice');
  el.textContent=errors[msg]||msg;
  el.classList.remove('hide');
  clearTimeout(timer);
  timer=setTimeout(()=>el.classList.add('hide'),3800);
}
function entries(list) {
  return list.length?list.map(r=>`<details class="account-entry">
    <summary><span>${esc(name(r.game))}<small>${esc(date(r.created_at))}</small></span>
      <b class="${r.delta<0?'loss':'gain'}">${sign(r.delta)} 分</b></summary>
    <dl><dt>原因</dt><dd>${esc(r.reason)}</dd>${r.room?`<dt>房间</dt><dd>${esc(r.room)}</dd>`:''}
    ${r.game_id?`<dt>对局</dt><dd>${esc(r.game_id)}</dd>`:''}
    <dt>变化前</dt><dd>${r.before_balance} 分</dd><dt>变化后</dt><dd>${r.after_balance} 分</dd></dl></details>`).join(''):'<p class="note">没有符合条件的记录。</p>';
}
function identity(u) {
  return `<div class="account-name"><span class="account-avatar" aria-hidden="true">${esc([...u.nickname][0])}</span>
    <h1 class="h-title disp">${esc(u.nickname)}</h1></div>
    <div class="account-stats"><span><b>${u.balance}</b>当前积分</span>
    <span><b>${u.games}</b>游戏场次</span><span><b>${u.types}</b>游戏种类</span></div>`;
}
const selectOpts=(options,value)=>options.map(([k,v])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(v)}</option>`).join('');
function profileHTML() {
  if (!profile) return title('个人资料')+'<p class="note">正在读取资料。</p>';
  const u=profile.user;
  return identity(u)+ `<div class="qcard"><h2>最近积分变化</h2>${entries(profile.ledger.items.slice(0,5))}
    ${button('ledger','查看全部积分记录')}</div>
    <div class="qcard"><h2>最近游戏</h2>
    ${u.last_game?`<p>最近一次 ${esc(date(u.last_game))}</p>`:''}
    ${profile.recent_games.length?profile.recent_games.map(a=>`<p>${esc(name(a.game))}${a.result?' · '+esc(a.result):''}${a.delta?' · '+sign(a.delta)+' 分':''}
      ${a.finished_at?'<br><small>'+esc(date(a.finished_at))+'</small>':''}</p>`).join(''):'<p class="note">还没有可查看的对局记录。</p>'}</div>
    <div class="account-actions">${button('rename','修改昵称')}${button('switch','切换玩家')}</div>`;
}
function ledgerHTML() {
  return title('积分流水')+`<form id="ledger-filter" class="qcard">
    <div class="account-grid"><label>游戏<select name="game">${selectOpts([['','全部游戏'],...(ledger?.games||[]).map(g=>[g,name(g)])],filters.game||'')}</select></label>
      <label>时间<select name="period">${selectOpts([['','全部时间'],['7','最近 7 天'],['30','最近 30 天'],['custom','自定义']],filters.period||'')}</select></label></div>
    <div class="account-grid" id="ledger-dates" ${filters.period==='custom'?'':'hidden'}>
      <label>开始日期<input name="start" type="date" value="${esc(filters.start)}"></label>
      <label>结束日期<input name="end" type="date" value="${esc(filters.end)}"></label></div>
    ${submit('应用筛选')}</form>
    <p class="note">共 ${ledger?.count||0} 条 · 筛选范围变动合计 ${sign(ledger?.total||0)} 分</p>
    ${entries(items)}${ledger?.more?button('more','加载更多'):''}${button('profile','返回资料')}`;
}
function loginHTML() {
  return title('来点刺激的')+`<form id="enter" class="qcard">
    <label>你的昵称<input name="nickname" maxlength="12" required autocomplete="nickname" placeholder="输入昵称"></label>
    ${submit('进入游戏')}</form>`;
}
function adminHTML() {
  if (!adminKey) return title('账号管理')+`<form id="admin-login" class="qcard"><label>管理员密钥<input name="key" type="password" required></label>${submit('进入后台')}</form>`;
  if (selected) {
    const u=selected.user;
    return title('玩家资料')+identity(u)+`<p class="note">用户 ID ${esc(u.id)}</p>
      <p class="note">注册 ${esc(date(u.created_at))}<br>最近活跃 ${esc(date(u.last_active_at))}</p>
      ${selected.names.length?`<p class="note">曾用昵称 ${selected.names.map(n=>esc(n.name)).join('、')}</p>`:''}
      <form class="qcard" id="admin-rename"><label>修改昵称<input name="nickname" maxlength="12" required value="${esc(u.nickname)}"></label>${submit('保存昵称')}</form>
      <form class="qcard" id="adjust"><h2>调整积分</h2><label>积分变化<input name="delta" type="number" step="1" required></label>
      <label>调整原因<input name="reason" maxlength="200" required></label>${submit('记录调整')}</form>
      <div class="qcard"><h2>积分流水</h2>${entries(selected.ledger.items)}
      ${selected.ledger.more?button('admin-more','加载更多'):''}</div>${button('admin-back','返回用户查询')}`;
  }
  return title('账号管理')+
    `<form id="search" class="qcard"><label>昵称或曾用昵称<input name="query" value="${esc(query)}"></label>${submit('查询玩家')}</form>
    ${results?'<div class="list">'+(results.length?results.map(u=>`<button class="row" data-account="admin-user" data-user="${u.id}">
    <span class="who">${esc(u.nickname)}</span><span>${u.balance} 分 · ${u.games} 局</span></button>`).join(''):'<p class="note">没有匹配的用户。</p>')+'</div>':''}
    ${button('admin-exit','退出后台')}`;
}
function render() {
  back.hidden=!adminMode && !A.state.user;
  if (adminMode) { page.innerHTML=adminHTML(); return; }
  if (view==='entry') page.innerHTML=loginHTML();
  else if (view==='ledger') page.innerHTML=ledgerHTML();
  else if (view==='rename') page.innerHTML=title('修改昵称')+`<form id="rename" class="qcard"><label>新昵称<input name="nickname" maxlength="12" required value="${esc(A.state.user.nickname)}"></label>${submit('保存昵称')}</form>${button('profile','取消')}`;
  else page.innerHTML=profileHTML();
}
function filtersArgs() {
  const start=filters.start?new Date(filters.start+'T00:00:00'):null;
  const end=filters.end?new Date(filters.end+'T00:00:00'):null;
  const args={game:filters.game};
  if (filters.period==='custom') {
    if (start&&end&&start>end) return null;
    if (start) args.from=start.toISOString();
    if (end) { end.setDate(end.getDate()+1); args.until=end.toISOString(); }
  } else if (filters.period) {
    const recent=new Date();
    recent.setDate(recent.getDate()-Number(filters.period));
    args.from=recent.toISOString();
  }
  return args;
}
async function readLedger(more=false) {
  const args=filtersArgs();
  if (!args) return notify('结束日期不能早于开始日期。');
  if (more) args.before_id=items.at(-1)?.id;
  const out=await A.account('ledger',args);
  if (!out.ok) return fail(out);
  ledger=out; items=more?items.concat(out.items):out.items; view='ledger'; render();
}
async function readProfile() {
  const out=await A.account('profile');
  if (!out.ok) return fail(out);
  profile=out; view='profile'; render();
}
function fail(out) {
  if (out.error==='account_required') { view='entry'; render(); }
  notify(out.error);
}
async function adminRequest(action,args,callback) {
  const out=await A.admin(adminKey,action,args);
  if (!out.ok) { if (out.error==='forbidden') { adminKey=''; render(); } return notify(out.error); }
  callback(out); render();
}
async function run(callback) {
  if (busy) return;
  busy=true;
  try { await callback(); } finally { busy=false; }
}
page.addEventListener('change',event=>{
  if (event.target.name==='period') document.querySelector('#ledger-dates').hidden=event.target.value!=='custom';
});
page.addEventListener('submit',event=>{
  event.preventDefault();
  const form=event.target, values=Object.fromEntries(new FormData(form));
  run(async()=>{
    switch (form.id) {
      case 'enter': {
        const out=await A.account('enter',values);
        if (!out.ok) { fail(out); return; }
        location.replace(safeReturn);
        break;
      }
      case 'rename': {
        const out=await A.account('rename',values);
        if (!out.ok) return fail(out);
        await readProfile(); break;
      }
      case 'ledger-filter': filters=values; await readLedger(); break;
      case 'admin-login':
        adminKey=values.key; await adminRequest('search',{query},out=>{ results=out.users; }); break;
      case 'search':
        query=values.query; await adminRequest('search',values,out=>{ results=out.users; }); break;
      case 'admin-rename':
        await adminRequest('rename',{...values,user:selected.user.id},out=>{ selected=out; }); break;
      case 'adjust':
        if (!form.dataset.event) form.dataset.event=[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
        await adminRequest('adjust',{...values,user:selected.user.id,event:form.dataset.event},out=>{ selected=out; }); break;
    }
  });
});
page.addEventListener('click',event=>{
  const el=event.target.closest('[data-account]');
  if (!el) return;
  run(async()=>{
    switch (el.dataset.account) {
      case 'rename': view=el.dataset.account; render(); break;
      case 'ledger': filters={}; await readLedger(); break;
      case 'more': await readLedger(true); break;
      case 'profile': await readProfile(); break;
      case 'switch': {
        if (inRoom && !window.confirm('你正在参与游戏，切换玩家可能导致退出当前房间。确认切换？')) return;
        const out=await A.account('logout');
        if (!out.ok && out.error!=='account_required') return fail(out);
        profile=null; items=[]; ledger=null; view='entry'; render(); break;
      }
      case 'admin-user': await adminRequest('profile',{user:el.dataset.user},out=>{ selected=out; }); break;
      case 'admin-more':
        await adminRequest('profile',{user:selected.user.id,before_id:selected.ledger.items.at(-1).id},out=>{
          out.ledger.items=selected.ledger.items.concat(out.ledger.items); selected=out;
        }); break;
      case 'admin-back': selected=null; render(); break;
      case 'admin-exit': adminKey=''; results=null; selected=null; query=''; render(); break;
    }
  });
});
(async()=>{
  if (adminMode) { render(); return; }
  const out=await A.load();
  if (out.ok) {
    if (q.get('entry')==='1') { location.replace(safeReturn); return; }
    await readProfile();
  } else {
    render();
    if (out.error!=='account_required') notify(out.error);
  }
})();
})();
