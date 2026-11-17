// Read-only Feishu Hire protocol. Official evidence and exact scope limits are
// recorded in docs/releases/20261117-recruiting-sources.md. No arbitrary URL.
import{requestJson}from'./integration-providers.mjs';
import{hash,bad,text}from'./platform-core.mjs';
import{setTimeout as pause}from'node:timers/promises';
const endpoint='https://open.feishu.cn/open-apis/';
export function sourceId(value,name='来源编号'){
 if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,200}$/.test(value))bad(name+'须为稳定文本编号');return value;
}
export function normalizeFeishuApplication(data,{channel,applicationId}){
 const d=data?.data?.application_detail,b=d?.basic_info,p=d?.talent;
 if(!b||!p||b.id!==applicationId||b.job_id!==channel.external_job_id||p.id!==b.talent_id)bad('飞书投递、人才和已核职位映射不一致');
 const ms=String(b.modify_time??'');if(!/^\d{13}$/.test(ms)||!['1','2'].includes(String(b.active_status)))bad('飞书响应缺少可比较更新时间或投递状态');
 const normalized={external_id:sourceId(b.id),external_talent_id:sourceId(b.talent_id),source_at_ms:ms,
  source_state:Number(b.active_status)===1?'active':'inactive',full_name:text(p.name,'人才姓名',1,100),contact:{}};
 if(p.mobile_number)normalized.contact.mobile=text((p.mobile_code?String(p.mobile_code)+' ':'')+p.mobile_number,'联系电话',1,60);
 if(p.email)normalized.contact.email=text(p.email,'联系邮箱',1,254);
 const source_hash=hash(data);return{...normalized,source_version:ms+':'+source_hash,source_hash,raw:data,original:null};
}
export async function pullRecruitingApplications({channel,connection,credentials,request,fetchImpl}){
 if(channel.provider!=='feishu_hire'||connection.provider!=='feishu'||connection.config.organization_id!==channel.external_tenant)bad('仅开放已核企业的飞书招聘只读适配');
 const io={fetchImpl,timeoutMs:12000},auth=await requestJson(endpoint+'auth/v3/tenant_access_token/internal',{
  ...io,method:'POST',body:{app_id:text(credentials.app_id??connection.config.app_id,'应用ID'),app_secret:text(credentials.app_secret,'应用密钥')}});
 const token=text(auth.data.tenant_access_token,'平台访问凭证'),headers={authorization:'Bearer '+token};
 const params=new URLSearchParams({job_id:channel.external_job_id,active_status:'3',page_size:'20',update_start_time:request.from_ms,update_end_time:request.to_ms});
 if(request.cursor)params.set('page_token',request.cursor);
 const list=await requestJson(endpoint+'hire/v1/applications?'+params,{...io,headers}),page=list.data?.data;
 if(!page||!Array.isArray(page.items)||page.items.length>20||typeof page.has_more!=='boolean'||page.items.some(x=>typeof x!=='string')||new Set(page.items).size!==page.items.length)bad('飞书投递列表协议不匹配');
 if(page.has_more&&(!page.page_token||page.page_token===request.cursor))bad('飞书分页没有前进，保留原游标待核');
 const events=[];for(const applicationId of page.items){if(events.length)await pause(120);sourceId(applicationId);const url=new URL(endpoint+'hire/v1/applications/'+encodeURIComponent(applicationId)+'/get_detail');url.searchParams.append('options','with_talent');
  const detail=await requestJson(url,{...io,headers}),event=normalizeFeishuApplication(detail.data,{channel,applicationId});
  if(BigInt(event.source_at_ms)<BigInt(request.from_ms)||BigInt(event.source_at_ms)>BigInt(request.to_ms))bad('飞书投递更新时间超出当前授权采集窗口');events.push(event);
 }
 return{events,next_cursor:page.has_more?text(page.page_token,'分页标记',1,2000):null,response_hash:hash({list:list.data,versions:events.map(e=>e.source_hash)}),network_mode:'provider',coverage:'returned_records_only_no_absence_inference'};
}
