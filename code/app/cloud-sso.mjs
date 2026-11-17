import{PUBLIC_ERROR,publicEntrypoints}from'./services/external-sso.mjs';
import{beginSso,completeSso,redeemSso}from'./sso-flow.mjs';
const COOKIE='tyhr_sso_bind';
const cookie=(value,secure,maxAge)=>COOKIE+'='+value+'; Path=/auth/sso; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(secure?'; Secure':'');
function browserNonce(req){const matches=String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));return matches.length===1?matches[0].slice(COOKIE.length+1):'';}
export async function handleSsoPublic({req,res,url,db,readBody,fetchImpl}){
 if(!['/auth/sso/entrypoints','/auth/sso/start','/auth/sso/callback','/auth/sso/redeem'].includes(url.pathname))return false;
 const send=(status,body,headers={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(body));};
 try{
  if(!(await db.query("SELECT to_regclass('public.ty_sso_profile')IS NOT NULL ok")).rows[0].ok)throw Error('not ready');
  if(url.pathname==='/auth/sso/entrypoints'){if(req.method!=='GET')throw Error('method');send(200,await publicEntrypoints(db));return true;}
  if(url.pathname==='/auth/sso/callback'){
   if(req.method!=='GET'||url.searchParams.getAll('state').length!==1||url.searchParams.has('code')===url.searchParams.has('authCode'))throw Error('callback');const key=url.searchParams.has('code')?'code':'authCode';if(url.searchParams.getAll(key).length!==1)throw Error('duplicate');
   const result=await completeSso(db,{state:url.searchParams.get('state'),code:url.searchParams.get(key),browserNonce:browserNonce(req),fetchImpl});res.writeHead(303,{'location':result.redirect_to,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end();return true;
  }
  if(req.method!=='POST'||!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))throw Error('method');const raw=await readBody(req,4096);let input;try{input=JSON.parse(raw.toString('utf8'));}catch{throw Error('json');}if(!input||typeof input!=='object'||Array.isArray(input))throw Error('json');
  if(url.pathname==='/auth/sso/start'){
   if(Object.keys(input).some(k=>!['key','mode','return_path'].includes(k)))throw Error('shape');const out=await beginSso(db,{input,source:(process.env.TRUST_PROXY==='1'?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():'')||req.socket.remoteAddress||'unknown',requestOrigin:req.headers.origin});send(200,{authorize_url:out.authorize_url},{'set-cookie':cookie(out.browser_nonce,out.secure_cookie,300)});return true;
  }
  if(Object.keys(input).some(k=>k!=='ticket'))throw Error('shape');const{secure_cookie,...out}=await redeemSso(db,{ticket:input.ticket,browserNonce:browserNonce(req),requestOrigin:req.headers.origin});send(200,out,{'set-cookie':cookie('',secure_cookie,0)});return true;
 }catch{send(403,PUBLIC_ERROR);return true;}
}
