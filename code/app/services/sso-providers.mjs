// Internal-application OAuth only. Provider access/refresh tokens stay in memory.
import{createHash}from'node:crypto';
const HOSTS=new Set(['qyapi.weixin.qq.com','api.dingtalk.com','oapi.dingtalk.com','open.feishu.cn','accounts.feishu.cn']);
const fail=code=>{throw Object.assign(Error(code),{code});};
const required=v=>{if(typeof v!=='string'||!v.trim()||v.length>8192)fail('E_SSO_PROVIDER_IDENTITY');return v;};
export const PROVIDER_MODES=Object.freeze({wecom:['web','in_app'],dingtalk:['web'],feishu:['web','in_app']});
export function authorizationUrl({connection,profile,runtime,state,verifier,mode}){
 if(!PROVIDER_MODES[connection.provider]?.includes(mode)||!profile.enabled_modes.includes(mode))fail('E_SSO_UNAVAILABLE');
 const redirect=profile.public_origin+profile.callback_path,app=required(connection.config.app_id),corp=required(connection.config.organization_id);
 if(connection.provider==='wecom'){
  const agent=String(runtime.settings.agent_id??app);if(!/^[1-9]\d*$/.test(agent))fail('E_SSO_AGENT');
  const url=new URL(mode==='web'?'https://login.work.weixin.qq.com/wwlogin/sso/login':'https://open.weixin.qq.com/connect/oauth2/authorize');
  url.search=new URLSearchParams({appid:corp,agentid:agent,redirect_uri:redirect,state,...(mode==='web'?{login_type:'CorpApp'}:{response_type:'code',scope:'snsapi_base'})}).toString();if(mode==='in_app')url.hash='wechat_redirect';return url.toString();
 }
 if(connection.provider==='dingtalk'){const url=new URL('https://login.dingtalk.com/oauth2/auth');url.search=new URLSearchParams({client_id:app,response_type:'code',scope:'openid',corpId:corp,redirect_uri:redirect,state}).toString();return url.toString();}
 const url=new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');url.search=new URLSearchParams({client_id:app,response_type:'code',redirect_uri:redirect,scope:'contact:user.base:readonly contact:user.employee_id:readonly',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();return url.toString();
}
async function request(url,{method='GET',headers={},body,fetchImpl=globalThis.fetch}={}){
 const target=new URL(url);if(target.protocol!=='https:'||!HOSTS.has(target.hostname)||target.username||target.password||target.hash||target.port&&target.port!=='443')fail('E_SSO_PROVIDER_HOST');
 let r;try{r=await fetchImpl(target.toString(),{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});}catch{fail('E_SSO_PROVIDER_NETWORK');}
 if(!r.ok)fail('E_SSO_PROVIDER_RESPONSE');const parts=[];let bytes=0;const reader=r.body?.getReader();if(reader){try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>128*1024){await reader.cancel();fail('E_SSO_PROVIDER_SIZE');}parts.push(Buffer.from(next.value));}}finally{reader.releaseLock();}}
 let d;try{d=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{fail('E_SSO_PROVIDER_RESPONSE');}if(!d||Array.isArray(d)||typeof d!=='object'||d.error||d.errcode!==undefined&&d.errcode!==0||d.code!==undefined&&d.code!==0)fail('E_SSO_PROVIDER_RESPONSE');return d;
}
export async function verifyProviderIdentity({connection,profile,credentials,code,verifier,fetchImpl}){
 required(code);const provider=connection.provider,corp=required(connection.config.organization_id),app=required(connection.config.app_id),secret=required(credentials.app_secret??credentials.corp_secret??credentials.client_secret);
 if(provider!=='wecom'&&credentials.app_id&&credentials.app_id!==app||credentials.client_id&&credentials.client_id!==app)fail('E_SSO_APP_MISMATCH');
 const io={fetchImpl};let external;
 if(provider==='wecom'){
  const token=await request('https://qyapi.weixin.qq.com/cgi-bin/gettoken?'+new URLSearchParams({corpid:corp,corpsecret:secret}),io);
  const data=await request('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo?'+new URLSearchParams({access_token:required(token.access_token),code}),io);
  external=required(data.userid);if(data.openid||data.external_userid||external.includes('/'))fail('E_SSO_EXTERNAL_USER');
  // getuserinfo can identify a member outside app visibility. Read via this
  // exact internal app token as well; do not turn an external contact into HR.
  const member=await request('https://qyapi.weixin.qq.com/cgi-bin/user/get?'+new URLSearchParams({access_token:token.access_token,userid:external}),io);
  if(member.userid!==external||member.status!==1)fail('E_SSO_MEMBER_INACTIVE');
 }else if(provider==='dingtalk'){
  const token=await request('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{...io,method:'POST',body:{clientId:app,clientSecret:secret,code,grantType:'authorization_code'}});
  if(token.corpId!==corp||!Number.isFinite(token.expireIn)||token.expireIn<=0)fail('E_SSO_TENANT_MISMATCH');
  const data=await request('https://api.dingtalk.com/v1.0/contact/users/me',{...io,headers:{'x-acs-dingtalk-access-token':required(token.accessToken)}}),union=required(data.unionId),appToken=await request('https://oapi.dingtalk.com/gettoken?'+new URLSearchParams({appkey:app,appsecret:secret}),io);
  const member=await request('https://oapi.dingtalk.com/topapi/user/getbyunionid?'+new URLSearchParams({access_token:required(appToken.access_token)}),{...io,method:'POST',body:{unionid:union}});external=required(member.result?.userid);
  const detail=await request('https://oapi.dingtalk.com/topapi/v2/user/get?'+new URLSearchParams({access_token:appToken.access_token}),{...io,method:'POST',body:{userid:external}});
  if(detail.result?.userid!==external||detail.result?.unionid!==union||detail.result?.active!==true)fail('E_SSO_MEMBER_INACTIVE');
 }else if(provider==='feishu'){
  // v3 enforces the PKCE relationship and replaces the historical v2 endpoint.
  const token=await request('https://accounts.feishu.cn/oauth/v3/token',{...io,method:'POST',body:{grant_type:'authorization_code',client_id:app,client_secret:secret,code,redirect_uri:profile.public_origin+profile.callback_path,code_verifier:required(verifier),scope:'contact:user.base:readonly contact:user.employee_id:readonly'}});
  if(token.token_type!=='Bearer'||!Number.isFinite(token.expires_in)||token.expires_in<=0)fail('E_SSO_PROVIDER_TOKEN');
  const data=await request('https://open.feishu.cn/open-apis/authen/v1/user_info',{...io,headers:{authorization:'Bearer '+required(token.access_token)}});
  if(data.data?.tenant_key!==corp)fail('E_SSO_TENANT_MISMATCH');external=required(data.data.user_id);
 }else fail('E_SSO_UNAVAILABLE');
 return{provider,organization_id:corp,external_id:external};
}
