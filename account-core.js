(() => {
'use strict';
const key='ldc_site_session';
const cfg=window.LDC_CONFIG || {};
const read=()=>localStorage.getItem(key);
const state={user:null};
function save(token) {
  if (token) localStorage.setItem(key,token);
  else localStorage.removeItem(key);
}
async function rpc(name,args) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try {
    const res=await fetch(cfg.supabaseUrl+'/rest/v1/rpc/'+name,{
      method:'POST',headers:{'Content-Type':'application/json',apikey:cfg.supabaseAnonKey,Authorization:'Bearer '+cfg.supabaseAnonKey},
      body:JSON.stringify(args),signal:controller.signal
    });
    if (!res.ok) return {ok:false,error:res.status===404?'not_installed':'server'};
    return await res.json();
  } catch { return {ok:false,error:'network'}; }
  finally { clearTimeout(timeout); }
}
async function account(action,args={}) {
  const requestedToken=read();
  const out=await rpc('ldc_account',{p_action:action,p_token:requestedToken,p_args:args});
  if (!out.token && requestedToken!==read()) return {ok:false,error:'account_changed'};
  if (out.ok && out.user) state.user=out.user;
  if (out.ok && out.token) save(out.token);
  if ((out.ok && action==='logout') || out.error==='account_required') { save(null); state.user=null; }
  return out;
}
function pageURL(redirect=false) {
  const target=new URL('account.html',location.href);
  target.searchParams.set('return',(location.pathname.split('/').pop() || 'index.html')+location.search);
  if (redirect) target.searchParams.set('entry','1');
  return target;
}
function requireLogin() { location.replace(pageURL(true)); }
async function load() {
  if (!read()) return {ok:false,error:'account_required'};
  return account('me');
}
function scoped(kind,code,action,args={}) {
  const requestedToken=read();
  return rpc('ldc_account_'+kind,{p_token:requestedToken,p_code:code,p_action:action,p_args:args}).then(out=>{
    if (requestedToken!==read()) return {ok:false,error:'account_changed'};
    if (out.error==='account_required') { save(null); state.user=null; requireLogin(); }
    return out;
  });
}
const admin=(key,action,args={})=>rpc('ldc_account_admin',{p_key:key,p_action:action,p_args:args});
window.addEventListener('storage',event=>{
  if (event.key===key && state.user && !document.querySelector('#account-page')) location.reload();
});
window.LdcAccount={state,account,load,requireLogin,pageURL,scoped,admin};
})();
