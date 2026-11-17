// Only documented provider result protocols. No arbitrary receipt gateway.
import{requestJson}from'./integration-providers.mjs';import{hash,bad,text}from'./platform-core.mjs';
const fail=(code='E_NOTIFICATION_RECEIPT_PROTOCOL')=>{throw Object.assign(Error('消息回执协议未通过核验'),{code});};
const sid=v=>{if(typeof v!=='string'||!v||v.length>256||v!==v.trim()||/[\u0000-\u001f\u007f]/.test(v))fail();return v;};
export function receiptTimestamp(value,{earliest=0}={}){if(typeof value!=='string'||!/^\d{13}$/.test(value))fail();const ms=Number(value);if(ms<Date.parse('2020-01-01T00:00:00Z')||ms<earliest-300000||ms>Date.now()+300000)fail();return new Date(ms).toISOString();}
async function token(connection,credentials,io){const app=text(credentials.app_id??connection.config.app_id,'消息应用ID'),secret=text(credentials.app_secret,'消息应用密钥');if(connection.provider==='feishu')return text((await requestJson('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{...io,method:'POST',body:{app_id:app,app_secret:secret}})).data.tenant_access_token,'平台访问凭证');if(connection.provider==='dingtalk')return text((await requestJson('https://oapi.dingtalk.com/gettoken?'+new URLSearchParams({appkey:app,appsecret:secret}),io)).data.access_token,'平台访问凭证');fail('E_NOTIFICATION_RECEIPT_UNSUPPORTED');}
async function dingResult(access,{agent,task,fetchImpl=globalThis.fetch}){
 const url='https://oapi.dingtalk.com/topapi/message/corpconversation/getsendresult?'+new URLSearchParams({access_token:access});let response;try{response=await fetchImpl(url,{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded;charset=utf-8'},body:new URLSearchParams({agent_id:agent,task_id:task}).toString(),redirect:'manual',signal:AbortSignal.timeout(15000)});}catch{fail('E_INTEGRATION_NETWORK');}
 if(response.status===429)fail('E_INTEGRATION_RATE_LIMIT');if(response.status>=300&&response.status<400)fail('E_INTEGRATION_REDIRECT');if(!response.ok)fail('E_INTEGRATION_HTTP');let body='',length=0;
 for await(const part of response.body){length+=part.byteLength;if(length>2*1024*1024)fail('E_INTEGRATION_RESPONSE_SIZE');body+=Buffer.from(part).toString('utf8');}let data;try{data=JSON.parse(body);}catch{fail();}if(data.errcode!==0||!data.send_result)fail('E_INTEGRATION_PROVIDER_REJECTED');return data;
}
function userList(value){if(value===undefined)return[];const a=Array.isArray(value)?value:value?.string;if(!Array.isArray(a)||a.some(x=>typeof x!=='string'))fail();return a;}
export async function queryNotificationReceipt({connection,profile,credentials,delivery,job,fetchImpl}){
 const remote=sid(delivery.remote_id),recipient=sid(delivery.recipient_external_id),sent=Date.parse(job.completed_at??delivery.created_at),age=Date.now()-sent;
 if(!Number.isFinite(sent)||age< -300000)fail();if(connection.provider==='wecom')fail('E_NOTIFICATION_RECEIPT_UNSUPPORTED');if(age>(connection.provider==='feishu'?7:1)*86400000)fail('E_NOTIFICATION_RECEIPT_EXPIRED');
 const io={fetchImpl,timeoutMs:15000},access=await token(connection,credentials,io);
 if(connection.provider==='feishu'){
  const type=profile.settings.user_id_type??'user_id';if(!['user_id','open_id','union_id'].includes(type))fail();const pages=[],seen=new Set();let cursor=null;
  for(let page=0;page<5;page++){
   const query=new URLSearchParams({user_id_type:type,page_size:'100'});if(cursor)query.set('page_token',cursor);
   const out=await requestJson('https://open.feishu.cn/open-apis/im/v1/messages/'+encodeURIComponent(remote)+'/read_users?'+query,{...io,headers:{authorization:'Bearer '+access}}),data=out.data?.data;
   if(!data||!Array.isArray(data.items)||data.items.length>100||data.has_more!==undefined&&typeof data.has_more!=='boolean')fail();pages.push(out.data);
   for(const item of data.items){if(item.user_id_type!==type||item.tenant_key!==connection.config.organization_id||item.user_id!==recipient)fail('E_NOTIFICATION_RECEIPT_RECIPIENT');const reported_at=receiptTimestamp(item.timestamp,{earliest:sent});return{observations:[{remote_id:remote,recipient_external_id:recipient,kind:'read',reported_at,raw:{pages}}],response_hash:hash(pages)};}
   if(!data.has_more)return{observations:[{remote_id:remote,recipient_external_id:recipient,kind:'not_reported',reported_at:null,raw:{pages}}],response_hash:hash(pages)};
   if(typeof data.page_token!=='string'||!data.page_token||seen.has(data.page_token))fail('E_NOTIFICATION_RECEIPT_CURSOR');seen.add(data.page_token);cursor=data.page_token;
  }fail('E_NOTIFICATION_RECEIPT_CURSOR');
 }
 if(connection.provider==='dingtalk'){
  const agent=String(profile.settings.agent_id??'');if(!/^[1-9]\d*$/.test(agent)||!/^\d+$/.test(remote))fail();const raw=await dingResult(access,{agent,task:remote,fetchImpl}),r=raw.send_result;
  const lists={read:userList(r.read_user_id_list),unread:userList(r.unread_user_id_list),failed:userList(r.failed_user_id_list),invalid_recipient:[...userList(r.invalid_user_id_list),...userList(r.forbidden_user_id_list)]};
  if(r.forbidden_list!==undefined){if(!Array.isArray(r.forbidden_list)||r.forbidden_list.some(x=>typeof x.userid!=='string'))fail();lists.invalid_recipient.push(...r.forbidden_list.map(x=>x.userid));}
  if(Object.values(lists).flat().some(x=>x!==recipient))fail('E_NOTIFICATION_RECEIPT_RECIPIENT');const matches=Object.entries(lists).filter(([,a])=>a.includes(recipient));if(matches.length>1)fail('E_NOTIFICATION_RECEIPT_CONFLICT');const kind=matches[0]?.[0]??'not_reported';return{observations:[{remote_id:remote,recipient_external_id:recipient,kind,reported_at:null,raw}],response_hash:hash(raw)};
 }fail('E_NOTIFICATION_RECEIPT_UNSUPPORTED');
}
// Called only after225 verified signature, tenant/app, nonce and encrypted raw
// envelope. A reader match never becomes an HR approval or local read action.
export function feishuReadObservations(payload,{connection,profile}){
 if(payload?.header?.event_type!=='im.message.message_read_v1')return[];
 const e=payload.event,type=profile.settings.user_id_type??'user_id',reader=e?.reader;
 if(!['user_id','open_id','union_id'].includes(type)||reader?.tenant_key!==connection.config.organization_id||!Array.isArray(e?.message_id_list)||!e.message_id_list.length||e.message_id_list.length>100||new Set(e.message_id_list).size!==e.message_id_list.length)fail();
 const who=sid(reader.reader_id?.[type]),reported_at=receiptTimestamp(reader.read_time),eventId=sid(payload.header.event_id);
 return e.message_id_list.map(message=>({remote_id:sid(message),recipient_external_id:who,kind:'read',reported_at,source_key:'feishu-read:'+eventId+':'+message,raw:payload}));
}
