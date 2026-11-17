import * as h from'./hr-common.mjs';

const DOMAINS=['business_reminder','workflow_copy','contract_reminder','certificate_reminder','performance_notice','learning_notice'];
const permissionError=e=>String(e.message).startsWith('E_TY_FORBIDDEN:')||String(e.message).startsWith('E_TY_NOT_FOUND:');
async function collect(read){const rows=[];let page=1,total=0;do{const part=await read(page);total=part.total;rows.push(...part.rows);page++;if(total>100000)h.bad('提醒超过十万项，请限定公司');}while((page-1)*100<total);return rows;}
const wrap=(domain,r,more={})=>({id:domain+':'+r.id,domain,source_id:String(r.id),channel:'站内提醒',issued_state:'recorded',delivery_status:'internal_only',...more});

// Domain readers perform current row and field authorization before counting
// and searching. This inbox does not turn historic recipient IDs into grants.
export async function listNotices(t,{userId,input={}}){
 const operator=await h.actor(t,userId,input.group_id);if(operator.profile_code==='config_admin')h.deny('系统配置不读取业务通知');
 const group=operator.group_id,company=input.company_id?h.id(input.company_id):null,rows=[],unavailable=[];
 for(const copy of await h.q(t,'SELECT DISTINCT ON(c.instance_id)c.*,i.group_id FROM ty_workflow_copy c JOIN ty_workflow_instance i ON i.id=c.instance_id WHERE c.account_id=$1 AND i.group_id=$2 ORDER BY c.instance_id DESC,c.seen_at NULLS FIRST,c.node_id',[userId,group])){
  try{const i=await(await import('./platform-workflow.mjs')).projectInstance(t,userId,copy.instance_id);if(company&&!h.same(company,i.company_id))continue;rows.push(wrap('workflow_copy',{id:i.id},{title:i.title,category:'审批抄送',business_status:i.status,seen_at:copy.seen_at,created_at:i.created_at,route:'my/requests',instance_id:i.id}));}catch(e){if(!permissionError(e))throw e;}
 }
 const add=async(domain,table,read,map)=>{if(!(await h.one(t,'SELECT to_regclass($1)IS NOT NULL ok',['public.'+table])).ok){unavailable.push(domain);return;}try{for(const r of await collect(read))rows.push(wrap(domain,r,map(r)));}catch(e){if(!permissionError(e))throw e;}};
 await add('contract_reminder','ty_hr_reminder',page=>import('./hr-contracts.mjs').then(s=>s.queryWorkspace(t,{userId,input:{group_id:group,company_id:company,view:'reminders',page,page_size:100}})),r=>({title:r.title||'合同到期提醒',category:'合同到期',business_status:r.state,seen_at:r.seen_at,created_at:r.event_on,route:'people/contract-reminders'}));
 await add('certificate_reminder','ty_cert_holding',async page=>{const result=await(await import('./people-services.mjs')).queryWorkspace(t,{userId,module:'certificates',groupId:group,companyId:company,page,pageSize:100});return result.reminders_page;},r=>({title:r.name?String(r.name)+'到期提醒':'证照到期提醒',category:'证照到期',business_status:r.risk,created_at:r.valid_to,route:'people/certificates'}));
 await add('performance_notice','ty_pr_notice',page=>import('./performance-native.mjs').then(s=>s.queryWorkspace(t,{userId,input:{group_id:group,company_id:company,view:'notices',page,page_size:100}})),r=>({title:r.title||'绩效办理提醒',category:'绩效通知',business_status:'recorded',read_at:r.read_at,created_at:r.created_at,route:'my/performance'}));
 await add('learning_notice','ty_lr_notice',page=>import('./learning-native.mjs').then(s=>s.queryWorkspace(t,{userId,input:{group_id:group,company_id:company,view:'notices',page,page_size:100}})),r=>({title:r.title||'学习办理提醒',category:'培训考试',business_status:'recorded',read_at:r.read_at,created_at:r.created_at,route:'my/learning'}));
 if((await h.one(t,"SELECT to_regclass('public.ty_br_notice')IS NOT NULL ok")).ok){const reminders=await(await import('./business-reminders.mjs')).listPersonalReminders(t,{userId,input:{group_id:group,company_id:company}});for(const r of reminders)rows.push(wrap('business_reminder',r,{title:r.category+'提醒',category:r.category,business_status:r.state,created_at:r.created_at,due_on:r.due_on,route:'my/alerts',notice_id:r.id,reminder_type:r.kind}));const covered=new Set(reminders.filter(r=>r.kind==='contract_expiry').map(r=>r.source_key+':'+h.day(r.due_on)));for(let i=rows.length-1;i>=0;i--)if(rows[i].domain==='contract_reminder'){const old=await h.one(t,'SELECT source_key,event_on FROM ty_hr_reminder WHERE id=$1',[rows[i].source_id]),match=/^contract-expiry:([1-9][0-9]*):/.exec(old?.source_key||'');if(match&&covered.has('contract:'+match[1]+':'+h.day(old.event_on)))rows.splice(i,1);}}
 const reads=new Map((await h.q(t,'SELECT domain,source_id,read_at FROM ty_portal_read WHERE account_id=$1 AND group_id=$2',[userId,group])).map(r=>[r.domain+':'+r.source_id,r.read_at]));
 for(const row of rows){row.read_at=row.read_at||row.seen_at||reads.get(row.id)||null;row.read_state=row.read_at?'read':'unread';}
 const unique=[...new Map(rows.map(r=>[r.id,r])).values()];unique.sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))||b.id.localeCompare(a.id));
 return{rows:unique,unavailable_domains:unavailable,external_delivery_verified:false};
}

export async function markRead(t,{userId,input,operationId}){
 h.obj(input);if(Object.keys(input).some(k=>!['group_id','company_id','domain','source_id'].includes(k))||!DOMAINS.includes(input.domain))h.bad('提醒已读参数无效');
 const source=h.text(String(input.source_id),'提醒来源',1,160),operator=await h.actor(t,userId,input.group_id);
 const verify=async()=>{const list=await listNotices(t,{userId,input});if(!list.rows.some(r=>r.domain===input.domain&&r.source_id===source))h.deny('当前提醒或字段不在本人可见范围');};await verify();
 return h.command(t,{userId,groupId:operator.group_id,operation:'portal.notice.read',operationId,input,project:async r=>{await verify();return r;},execute:async()=>{
  if(input.domain==='business_reminder')await(await import('./business-reminders.mjs')).reminderTarget(t,{userId,input:{notice_id:source}});
  else if(input.domain==='workflow_copy')await t.query('UPDATE ty_workflow_copy SET seen_at=coalesce(seen_at,now())WHERE instance_id=$1 AND account_id=$2',[h.id(source),userId]);
  else if(input.domain==='contract_reminder')await(await import('./hr-contracts.mjs')).dispatchCommand(t,{userId,input:{id:h.id(source)},operation:'reminder.read',operationId:'portal-'+h.hash([operationId,input.domain]).slice(0,40)});
  else if(input.domain==='performance_notice')await(await import('./performance-native.mjs')).dispatchCommand(t,{userId,input:{group_id:operator.group_id,id:h.id(source)},operation:'performance.notice.read',operationId:'portal-'+h.hash([operationId,input.domain]).slice(0,40)});
  else if(input.domain==='learning_notice')await(await import('./learning-native.mjs')).dispatchCommand(t,{userId,input:{group_id:operator.group_id,id:h.id(source)},operation:'learning.notice.read',operationId:'portal-'+h.hash([operationId,input.domain]).slice(0,40)});
  await t.query('INSERT INTO ty_portal_read(account_id,group_id,domain,source_id)VALUES($1,$2,$3,$4)ON CONFLICT DO NOTHING',[userId,operator.group_id,input.domain,source]);
  const receipt=await h.one(t,'SELECT read_at FROM ty_portal_read WHERE account_id=$1 AND domain=$2 AND source_id=$3',[userId,input.domain,source]);
  return{domain:input.domain,source_id:source,read_at:receipt.read_at,read:true,business_effect_verified:false};
 }});
}
