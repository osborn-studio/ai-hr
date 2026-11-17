import React,{useEffect,useState}from'react';
import{Button,Notice}from'./UI.jsx';import{createApi}from'../api.mjs';
import{ssoMode,ssoProviderNames,ssoAuthorizationURL}from'../auth-sso.mjs';
import{notificationLoginPath}from'../notification-links.mjs';
export default function SsoLogin({disabled=false}){
 const[entries,setEntries]=useState([]),[busy,setBusy]=useState(null),[error,setError]=useState(null);
 useEffect(()=>{const c=new AbortController();createApi().request('/auth/sso/entrypoints',{signal:c.signal}).then(r=>setEntries(Array.isArray(r.entries)?r.entries:[])).catch(()=>{});return()=>c.abort();},[]);
 const available=entries.map(e=>({...e,mode:ssoMode(e,navigator.userAgent)})).filter(e=>e.mode);
 if(!available.length)return null;
 return<div className="sso-login"><p>或使用企业平台登录</p>{error&&<Notice tone="danger">{error.message}</Notice>}<div>{available.map(e=><Button key={e.key} disabled={disabled||busy!==null} busy={busy===e.key} onClick={async()=>{setBusy(e.key);setError(null);try{const out=await createApi().request('/auth/sso/start',{method:'POST',body:{key:e.key,mode:e.mode,return_path:notificationLoginPath(location.hash)}});location.assign(ssoAuthorizationURL(out.authorize_url,e.provider));}catch(err){setError(err);setBusy(null);}}}>{e.name||ssoProviderNames[e.provider]+'登录'}</Button>)}</div></div>;
}
