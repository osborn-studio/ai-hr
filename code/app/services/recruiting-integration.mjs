// Caller-owned transactions. No HTTP and no direct employment creation here.
import{createHash}from'node:crypto';
import * as h from'./hr-common.mjs';
import{shape,decision,project,companyScope}from'./hr-files.mjs';
import * as native from'./hr-recruitment.mjs';
import * as files from'./hr-files.mjs';
import{parseRecruitingFile,recruitingTemplate}from'./recruiting-files.mjs';
import{sourceId}from'./recruiting-provider.mjs';
const{q,one,id,same,bad,deny,conflict,missing,text,revision,hash}=h;
const FULL=['source_channel','source_ref','full_name','contact','attachments'];
const TABLES={channel:'ty_rc_channel',source:'ty_rc_root',job:'ty_rc_job'};
const fields={
 'channel.create':['group_id','requisition_id','provider','connection_id','external_tenant','external_job_id','name','evidence_ref','authorized_until'],
 'channel.approve':['id','expected_revision','reason'],'channel.disable':['id','expected_revision','reason'],
 'job.enqueue':['channel_id','from','to','source_key','continuation_of'],
 'job.cancel':['id','expected_revision','reason'],
 'file.import':['channel_id','filename','mime','content_base64','record'],
 'source.accept':['id','expected_revision','version_id','candidate_code','reason'],
 'source.update':['id','expected_revision','version_id','expected_candidate_revision','reason'],
 'source.reject':['id','expected_revision','version_id','reason'],
 'source.acknowledge':['id','expected_revision','version_id','reason']};
const aad=v=>'tyhr-recruiting-source-v1:'+v.root_id+':'+v.source_version;
const originalAad=v=>aad(v)+':original';
async function context(t,userId,groupId){const a=await h.actor(t,userId,groupId);if(['store_staff','station_staff','outsourced_staff','vendor_contact','outsource_hr'].includes(a.profile_code))deny('当前本人或供应商服务身份不办理企业招聘来源');return a;}
async function channel(t,key,lock=false){const c=await one(t,'SELECT c.*,r.department_id,r.position_id,r.status requisition_status FROM ty_rc_channel c JOIN ty_hr_requisition r ON r.id=c.requisition_id WHERE c.id=$1'+(lock==='share'?' FOR SHARE OF c':lock?' FOR UPDATE OF c':''),[id(key)]);if(!c)missing();return c;}
async function root(t,key,lock=false){const r=await one(t,'SELECT r.*,c.requisition_id,c.provider,c.external_tenant,c.external_job_id,q.department_id,q.position_id,n.linked_person_id person_id FROM ty_rc_root r JOIN ty_rc_channel c ON c.id=r.channel_id JOIN ty_hr_requisition q ON q.id=c.requisition_id LEFT JOIN ty_hr_candidate n ON n.id=r.native_candidate_id WHERE r.id=$1'+(lock?' FOR UPDATE OF r':''),[id(key)]);if(!r)missing();return r;}
async function version(t,r,key=r.latest_version_id){const v=await one(t,'SELECT * FROM ty_rc_version WHERE id=$1 AND root_id=$2',[id(key),r.id]);if(!v)missing();return v;}
async function hr(t,userId,row,action,keys=FULL){await context(t,userId,row.group_id);return decision(t,userId,'hr_recruitment',action,row,keys);}
async function fileAccess(t,userId,row,action='read'){await decision(t,userId,'hr_files',action,row,['content','filename','mime']);}
async function connection(t,c,userId,action='sync'){
 const co=await one(t,'SELECT * FROM ty_integration_connection WHERE id=$1 FOR SHARE',[c.connection_id]);
 if(!co||!same(co.group_id,c.group_id)||co.provider!=='feishu'||co.company_id&&!same(co.company_id,c.company_id)||co.config.organization_id!==c.external_tenant)conflict('招聘来源与外部企业连接已不一致');
 await decision(t,userId,'integration_manage',action,{...c,department_id:null},['config','capabilities','sources']);
 if(co.status!=='active'||!co.secret_cipher||c.connection_revision!==co.revision||c.secret_revision!==co.secret_revision)conflict('招聘来源须重新核定当前连接和凭据版本');return co;
}
async function active(t,c,userId,{network=false}={}){
 await hr(t,userId,c,'read',FULL);
 if(c.status!=='active'||Date.parse(c.authorized_until)<=Date.now()||c.requisition_status!=='approved')conflict('来源授权到期、停用或招聘需求未核准');
 await hr(t,c.approved_by,c,'approve',FULL);await h.ensureIndependent(t,c.approved_by,c.created_by,c);
 if(c.provider==='feishu_hire'){await connection(t,c,c.approved_by,'approve');if(network)return connection(t,c,userId,'sync');}
 return null;
}
async function audit(t,userId,row,operation,extra={}){await h.audit(t,userId,row.group_id,'recruiting.source.'+operation,'recruiting_source',row.id,{...extra,revision:row.revision});}
function unpack(v){const data=h.unseal({cipher:v.payload_cipher,iv:v.payload_iv,tag:v.payload_tag},aad(v));if(hash(data.raw)!==v.source_hash)conflict('来源原件摘要校验失败');return data;}
async function proof(t,userId,row,action='approve'){await hr(t,userId,row,action);await fileAccess(t,userId,row);}
async function rowForOperation(t,operation,input){
 if(operation==='channel.create'){const r=await one(t,'SELECT * FROM ty_hr_requisition WHERE id=$1',[id(input.requisition_id)]);if(!r)missing();return r;}
 if(operation.startsWith('source.'))return root(t,input.id);
 if(operation.startsWith('job.')&&operation!=='job.enqueue'){const j=await one(t,'SELECT * FROM ty_rc_job WHERE id=$1',[id(input.id)]);if(!j)missing();return{...await channel(t,j.channel_id),...j};}
 return channel(t,input.channel_id??input.id);
}
const actionFor=op=>op==='channel.approve'||op.startsWith('source.')?'approve':op==='channel.create'?'create':op==='job.enqueue'||op==='file.import'?'create':'update';
export const recruitingOperations=Object.keys(fields);
export async function dispatchCommand(t,{userId,operation,input={},operationId}){
 if(!fields[operation])bad('招聘来源动作尚未开放');shape(input,fields[operation]);const row=await rowForOperation(t,operation,input);await hr(t,userId,row,actionFor(operation));
 if(input.group_id&&!same(input.group_id,row.group_id))deny();
 if(operation.startsWith('source.')||operation==='file.import')await fileAccess(t,userId,row);
 return h.command(t,{userId,input,operationId,operation:'recruiting.'+operation,groupId:row.group_id,project:result=>receipt(t,userId,result),execute:async()=>{
  if(operation==='channel.create')return createChannel(t,userId,row,input);
  if(operation==='channel.approve'||operation==='channel.disable')return decideChannel(t,userId,input,operation.endsWith('disable'));
  if(operation==='job.enqueue')return enqueue(t,userId,input);
  if(operation==='job.cancel'){const j=await one(t,'SELECT * FROM ty_rc_job WHERE id=$1 FOR UPDATE',[id(input.id)]);revision(j,input.expected_revision);if(j.state!=='queued')conflict('只能取消未运行采集');text(input.reason,'取消依据',4);await t.query("UPDATE ty_rc_job SET state='cancelled',revision=revision+1 WHERE id=$1",[j.id]);return{kind:'job',id:j.id};}
  if(operation==='file.import'){const c=await channel(t,input.channel_id,true);await active(t,c,userId);if(c.provider!=='file')bad('平台采集和文件证据不能混用同一来源');const events=parseRecruitingFile(input),saved=await ingestRecruitingEvents(t,{channel:c,userId,events});return{kind:'source',id:saved[0].root_id,received_count:saved.length};}
  return review(t,userId,operation,input);
 }});
}
async function createChannel(t,userId,r,i){
 if(r.status!=='approved')conflict('来源只能绑定当前已核招聘需求');if(!['file','feishu_hire'].includes(i.provider))bad('当前适配仅为飞书招聘只读与文件原件');
 const until=text(i.authorized_until,'授权截止时间');if(!/(Z|[+-]\d\d:\d\d)$/.test(until)||!Number.isFinite(Date.parse(until))||Date.parse(until)<=Date.now())bad('授权截止时间须有效并含时区');
 let co=null;if(i.provider==='feishu_hire'){
  co=await one(t,'SELECT * FROM ty_integration_connection WHERE id=$1',[id(i.connection_id)]);if(!co)missing();await decision(t,userId,'integration_manage','write',{...r,department_id:null},['config','capabilities','sources']);
  if(co.provider!=='feishu'||!same(co.group_id,r.group_id)||co.company_id&&!same(co.company_id,r.company_id)||co.status!=='active'||!co.secret_cipher||co.config.organization_id!==i.external_tenant)bad('请选择有据企业标识一致且已配置凭据的飞书连接');
 }else if(i.connection_id)bad('文件来源不伪装平台连接');
 const c=await one(t,'INSERT INTO ty_rc_channel(group_id,company_id,requisition_id,provider,connection_id,external_tenant,external_job_id,name,evidence_ref,authorized_until,connection_revision,secret_revision,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)RETURNING *',[
  r.group_id,r.company_id,r.id,i.provider,co?.id??null,sourceId(i.external_tenant,'来源企业标识'),sourceId(i.external_job_id,'来源职位标识'),text(i.name,'来源名称',1,160),text(i.evidence_ref,'企业、职位映射及个资处理授权依据',4,2000),until,co?.revision??null,co?.secret_revision??null,userId]);
 await audit(t,userId,c,'channel.created');return{kind:'channel',id:c.id};
}
async function decideChannel(t,userId,i,disable){const c=await channel(t,i.id,true);revision(c,i.expected_revision);text(i.reason,'核对依据',4);
 if(disable){if(c.status==='disabled')conflict('来源已经停用');await t.query("UPDATE ty_rc_channel SET status='disabled',revision=revision+1 WHERE id=$1",[c.id]);}
 else{if(c.status!=='draft'||c.requisition_status!=='approved'||Date.parse(c.authorized_until)<=Date.now())conflict('仅授权有效的招聘来源草稿可以核准');await h.ensureIndependent(t,userId,c.created_by,c);if(c.provider==='feishu_hire')await connection(t,c,userId,'approve');await t.query("UPDATE ty_rc_channel SET status='active',approved_by=$2,revision=revision+1 WHERE id=$1",[c.id,userId]);}
 await audit(t,userId,c,disable?'channel.disabled':'channel.approved');return{kind:'channel',id:c.id};}
function instant(v){if(typeof v!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))bad('采集窗口须含明确时区');return Date.parse(v);}
async function enqueue(t,userId,i){const c=await channel(t,i.channel_id,true);if(c.provider!=='feishu_hire')bad('文件来源无外部采集任务');await active(t,c,userId,{network:true});
 const from=instant(i.from),to=instant(i.to);if(from>=to||to-from>31*86400000||to>Date.now()+300000)bad('采集窗口须有序、不超过31天且不能进入未来');
 const request={from_ms:String(from),to_ms:String(to),cursor:null};if(i.continuation_of){const p=await one(t,'SELECT * FROM ty_rc_job WHERE id=$1',[id(i.continuation_of)]);if(!p||!same(p.channel_id,c.id)||p.state!=='completed'||!p.result.next_cursor||p.request.from_ms!==request.from_ms||p.request.to_ms!==request.to_ms)bad('续页须引用同一来源同一窗口的完成任务');request.cursor=p.result.next_cursor;}
 const key=text(i.source_key,'稳定采集批次',8,200),old=await one(t,'SELECT * FROM ty_rc_job WHERE channel_id=$1 AND source_key=$2',[c.id,key]);if(old){if(old.input_hash!==hash(request))conflict('同一采集批次内容改变');return{kind:'job',id:old.id};}
 const job=await one(t,'INSERT INTO ty_rc_job(channel_id,group_id,company_id,request,input_hash,source_key,channel_revision,created_by)VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)RETURNING *',[c.id,c.group_id,c.company_id,JSON.stringify(request),hash(request),key,c.revision,userId]);await audit(t,userId,c,'job.queued',{job_id:job.id});return{kind:'job',id:job.id};}
// Internal worker boundary; no caller input can choose a URL or the authority.
export async function readRecruitingIntent(t,job){const c=await channel(t,job.channel_id,'share');if(c.revision!==job.channel_revision)conflict('来源授权版本已变化');await hr(t,job.created_by,c,'create');await fileAccess(t,job.created_by,c);const co=await active(t,c,job.created_by,{network:true});return{channel:c,connection:co};}
export async function ingestRecruitingEvents(t,{channel:c,userId,events,jobId=null}){
 await active(t,c,userId);await hr(t,userId,c,'create');await fileAccess(t,userId,c);const saved=[];
 for(const e of events){sourceId(e.external_id);sourceId(e.external_talent_id);if(!/^\d{1,13}$/.test(String(e.source_at_ms))||Number(e.source_at_ms)>Date.now()+300000)bad('来源更新时间无效或进入未来');
  let r=await one(t,'SELECT * FROM ty_rc_root WHERE channel_id=$1 AND external_id=$2 FOR UPDATE',[c.id,e.external_id]);if(!r)r=await one(t,'INSERT INTO ty_rc_root(channel_id,group_id,company_id,external_id,external_talent_id)VALUES($1,$2,$3,$4,$5)RETURNING *',[c.id,c.group_id,c.company_id,e.external_id,e.external_talent_id]);
  if(r.external_talent_id!==e.external_talent_id)conflict('稳定应聘编号改绑了人才，须另行核对，不能换人');
  const old=await one(t,'SELECT * FROM ty_rc_version WHERE root_id=$1 AND(source_version=$2 OR source_hash=$3)',[r.id,e.source_version,e.source_hash]);if(old){if(old.source_version!==e.source_version||old.source_hash!==e.source_hash)conflict('同一来源版本内容冲突');saved.push({root_id:r.id,version_id:old.id,replayed:true});continue;}
  let disposition='current';if(r.latest_version_id){const latest=await version(t,r);if(BigInt(e.source_at_ms)<BigInt(latest.source_at_ms))disposition='stale';else if(BigInt(e.source_at_ms)===BigInt(latest.source_at_ms))disposition='conflict';}
  const source={normalized:Object.fromEntries(['external_id','external_talent_id','full_name','contact','source_state'].map(k=>[k,e[k]])),raw:e.raw};if(hash(e.raw)!==e.source_hash)bad('来源摘要不一致');
  const v={root_id:r.id,source_version:text(e.source_version,'源版本',1,300)},sealed=h.seal(source,aad(v));let original=null;if(e.original){const o=e.original,bytes=Buffer.from(o.bytes);if(bytes.length>3*1024*1024||createHash('sha256').update(bytes).digest('hex')!==o.sha256)bad('原件完整性失败');original={...o,...h.sealBytes(bytes,originalAad(v))};}
  const out=await one(t,'INSERT INTO ty_rc_version(root_id,source_version,source_at_ms,source_hash,source_state,disposition,payload_cipher,payload_iv,payload_tag,original_cipher,original_iv,original_tag,filename,mime,original_hash,byte_length,job_id,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)RETURNING *',[
   r.id,v.source_version,e.source_at_ms,e.source_hash,e.source_state,disposition,sealed.cipher,sealed.iv,sealed.tag,original?.cipher??null,original?.iv??null,original?.tag??null,original?.filename??null,original?.mime??null,original?.sha256??null,original?.bytes.length??null,jobId,userId]);
  if(disposition==='current')await t.query('UPDATE ty_rc_root SET latest_version_id=$2,conflict_version_id=NULL,revision=revision+1 WHERE id=$1',[r.id,out.id]);
  else if(disposition==='conflict')await t.query('UPDATE ty_rc_root SET conflict_version_id=$2,revision=revision+1 WHERE id=$1',[r.id,out.id]);
  await audit(t,userId,{...c,id:r.id},'received',{version_id:out.id,disposition,sha256:e.source_hash});saved.push({root_id:r.id,version_id:out.id,disposition});
 }return saved;
}
async function review(t,userId,op,i){const before=await root(t,i.id),c=await channel(t,before.channel_id,'share'),r=await root(t,i.id,true);revision(r,i.expected_revision);const v=await version(t,r,i.version_id);if(r.conflict_version_id)conflict('相同更新时间出现内容冲突，须由来源提供明确较新版本；当前版本不能进入候选或Offer');if(!same(v.id,r.latest_version_id)||v.disposition!=='current')conflict('只能核对当前来源版本，旧版不覆盖新版');await proof(t,userId,r);await h.ensureIndependent(t,userId,v.created_by,r);const reason=text(i.reason,'人工核对依据',4,2000);
 let candidateId=r.native_candidate_id,decisionName;
 if(op==='source.accept'){
  await active(t,c,userId);if(candidateId)conflict('此来源已接收，不能重复创建候选');if(await one(t,"SELECT 1 FROM ty_rc_review WHERE root_id=$1 AND version_id=$2 AND decision='rejected'",[r.id,v.id]))conflict('此版本已驳回，须有新的来源版本再核对');if(v.source_state!=='active')conflict('已撤回或不活跃来源不能接收为候选');await hr(t,userId,r,'create');const data=unpack(v).normalized;
  const n=await native.dispatchCommand(t,{userId,operation:'candidate.create',operationId:'rc-accept:'+r.id+':'+v.id,input:{requisition_id:r.requisition_id,code:text(i.candidate_code,'原生候选编号',1,80),full_name:data.full_name,contact:data.contact,source_channel:c.provider==='feishu_hire'?'飞书招聘':'文件原件',source_ref:'recruiting-source:'+r.id+':'+v.id}});candidateId=n.candidate_id;
  await t.query('UPDATE ty_rc_root SET native_candidate_id=$2,reviewed_version_id=$3,revision=revision+1 WHERE id=$1',[r.id,candidateId,v.id]);
  // A PDF is the candidate's original; a multi-row workbook or platform summary
  // is evidence only and never presented as a complete, reviewed CV.
  if(v.mime==='application/pdf'){await attachOriginal(t,userId,r,v,candidateId,n.revision);}
  decisionName='accepted';
 }else if(op==='source.update'){
  await active(t,c,userId);if(!candidateId||v.source_state!=='active')conflict('仅已接收且仍有效的来源可核对更新');if(same(r.reviewed_version_id,v.id))conflict('当前版本已核对');
  const candidate=await one(t,'SELECT * FROM ty_hr_candidate WHERE id=$1 FOR UPDATE',[candidateId]);revision(candidate,i.expected_candidate_revision);await hr(t,userId,r,'update');
  if(['hired','withdrawn','rejected'].includes(candidate.status)||await one(t,"SELECT 1 FROM ty_hr_offer WHERE candidate_id=$1 AND status IN('pending','approved','sent','accepted','hired')",[candidateId]))conflict('须先处置有效Offer或已结束候选；来源更新不得改写入职历史');
  const data=unpack(v).normalized,contact=candidate.contact_cipher?h.unseal({cipher:candidate.contact_cipher,iv:candidate.contact_iv,tag:candidate.contact_tag},`hr-candidate:${r.group_id}:${candidateId}:${candidate.contact_revision}`):{};
  // Native candidate identity/source snapshots are immutable (218). A provider
  // correction cannot rewrite them. Different identity/contact needs explicit
  // disposal of the old application and a separately identified new application.
  if(data.full_name!==candidate.full_name||hash(data.contact)!==hash(contact))conflict('来源姓名或联系方式已改变，不能改写既有候选身份快照；请核查并在原生流程处置后另建明确来源应聘');
  await t.query('UPDATE ty_hr_candidate SET resume_reviewed_by=NULL,resume_reviewed_at=NULL,resume_review_ref=NULL,reviewed_resume_sha256=NULL,revision=revision+1 WHERE id=$1',[candidateId]);
  if(v.mime==='application/pdf')await attachOriginal(t,userId,r,v,candidateId,candidate.revision+1);
  await t.query('UPDATE ty_rc_root SET reviewed_version_id=$2,revision=revision+1 WHERE id=$1',[r.id,v.id]);decisionName='updated';
 }else if(op==='source.reject'){
  if(candidateId)conflict('已接收候选需在原生候选流程处置，不能删除来源');if(await one(t,"SELECT 1 FROM ty_rc_review WHERE root_id=$1 AND version_id=$2 AND decision='rejected'",[r.id,v.id]))conflict('当前来源已驳回');decisionName='rejected';await t.query('UPDATE ty_rc_root SET revision=revision+1 WHERE id=$1',[r.id]);
 }else{
  if(v.source_state==='active')bad('只有来源不活跃或撤回才可登记核查');decisionName='withdrawal_acknowledged';await t.query('UPDATE ty_rc_root SET revision=revision+1 WHERE id=$1',[r.id]);
 }
 await t.query('INSERT INTO ty_rc_review(root_id,version_id,native_candidate_id,decision,reason,created_by)VALUES($1,$2,$3,$4,$5,$6)',[r.id,v.id,candidateId,decisionName,reason,userId]);await audit(t,userId,r,decisionName,{version_id:v.id,candidate_id:candidateId});return{kind:'source',id:r.id};
}
async function originalBytes(v){const bytes=h.unsealBytes({cipher:v.original_cipher,iv:v.original_iv,tag:v.original_tag},originalAad(v));if(bytes.length!==v.byte_length||createHash('sha256').update(bytes).digest('hex')!==v.original_hash)conflict('来源附件完整性校验失败');return bytes;}
async function attachOriginal(t,userId,r,v,candidateId,expectedRevision){await fileAccess(t,userId,r,'create');const bytes=await originalBytes(v),f=await files.dispatchCommand(t,{userId,operation:'file.upload',operationId:'rc-file:'+r.id+':'+v.id,input:{owner_kind:'candidate',owner_id:candidateId,filename:v.filename,mime:v.mime,content_base64:bytes.toString('base64'),sha256:v.original_hash}});await native.dispatchCommand(t,{userId,operation:'candidate.resume.attach',operationId:'rc-attach:'+r.id+':'+v.id,input:{id:candidateId,expected_revision:expectedRevision,resume_file_id:f.file_id}});}
async function receipt(t,userId,result){const row=result.kind==='source'?await root(t,result.id):result.kind==='channel'?await channel(t,result.id):await one(t,'SELECT * FROM ty_rc_job WHERE id=$1',[result.id]);if(!row)missing();await hr(t,userId,row,'read',FULL);return{kind:result.kind,id:row.id,status:row.status??row.state??'received',revision:row.revision,...(row.native_candidate_id?{candidate_id:row.native_candidate_id}:{}),...(result.received_count?{received_count:result.received_count}:{}),...(result.replayed?{replayed:true}:{}),external_write_performed:false};}
async function allowed(t,userId,row,action,keys=FULL){try{await hr(t,userId,row,action,keys);return true;}catch(e){if(e.code==='E_TY_FORBIDDEN'||e.message.startsWith('E_TY_FORBIDDEN:'))return false;throw e;}}
async function actions(t,userId,kind,row){const a=[];if(kind==='channels'){if(row.status==='draft'&&await allowed(t,userId,row,'approve')){try{await h.ensureIndependent(t,userId,row.created_by,row);if(row.provider==='feishu_hire')await connection(t,row,userId,'approve');a.push('channel.approve');}catch{}}if(row.status!=='disabled'&&await allowed(t,userId,row,'update'))a.push('channel.disable');if(row.status==='active'&&await allowed(t,userId,row,'create')){try{await active(t,row,userId,{network:row.provider==='feishu_hire'});a.push(row.provider==='file'?'file.import':'job.enqueue');}catch{}}}
 if(kind==='sources'&&await allowed(t,userId,row,'approve')){const v=await version(t,row);try{await proof(t,userId,row);await h.ensureIndependent(t,userId,v.created_by,row);const c=await channel(t,row.channel_id);if(v.source_state==='active'){await active(t,c,userId);a.push(row.native_candidate_id?'source.update':'source.accept');if(!row.native_candidate_id)a.push('source.reject');}else a.push('source.acknowledge');}catch{}}
 if(kind==='sources'){try{await proof(t,userId,row,'read');a.push('source.download');}catch{}}
 if(kind==='jobs'&&row.state==='queued'&&await allowed(t,userId,row,'update'))a.push('job.cancel');if(kind==='jobs'&&row.state==='completed'&&row.result?.next_cursor&&await allowed(t,userId,row,'create')){try{await active(t,await channel(t,row.channel_id),userId,{network:true});a.push('job.continue');}catch{}}return a;}
export async function queryWorkspace(t,{userId,input={}}){shape(input,['group_id','company_id','view','id','page','page_size','q','channel_id']);const actor=await context(t,userId,input.group_id),view=input.view??'sources';if(!['channels','sources','jobs'].includes(view))bad('招聘来源视图无效');const scope=await companyScope(t,actor.group_id,input.company_id),out=[];
 const raw=view==='channels'?await q(t,'SELECT c.*,r.department_id,r.status requisition_status FROM ty_rc_channel c JOIN ty_hr_requisition r ON r.id=c.requisition_id WHERE c.group_id=$1 ORDER BY c.id DESC',[actor.group_id]):view==='sources'?await q(t,'SELECT x.*,c.name channel_name,c.provider,c.external_tenant,c.external_job_id,c.requisition_id,r.department_id FROM ty_rc_root x JOIN ty_rc_channel c ON c.id=x.channel_id JOIN ty_hr_requisition r ON r.id=c.requisition_id WHERE x.group_id=$1 ORDER BY x.id DESC',[actor.group_id]):await q(t,'SELECT x.*,c.name channel_name,r.department_id FROM ty_rc_job x JOIN ty_rc_channel c ON c.id=x.channel_id JOIN ty_hr_requisition r ON r.id=c.requisition_id WHERE x.group_id=$1 ORDER BY x.id DESC',[actor.group_id]);
 for(const row of raw){if(scope&&!scope.includes(String(row.company_id))||input.id&&!same(input.id,row.id)||input.channel_id&&!same(input.channel_id,row.channel_id??row.id))continue;
  const keys=['company_id','requisition_id','channel_id','name','channel_name','provider','external_tenant','external_job_id','evidence_ref','authorized_until','external_id','external_talent_id','latest_version_id','reviewed_version_id','native_candidate_id','created_at','created_by','error_code','result','state'];
  const exposed=await project(t,userId,'hr_recruitment',row,keys,{namespace:'source_ref'});if(!exposed)continue;
  if(view==='sources'){const v=await version(t,row),privacy=await project(t,userId,'hr_recruitment',row,['full_name','contact']);if(privacy?.__allowed.length){const data=unpack(v).normalized;for(const key of privacy.__allowed)exposed[key]=data[key];}if(await allowed(t,userId,row,'read',['source_ref']))Object.assign(exposed,{source_version:v.source_version,source_at_ms:String(v.source_at_ms),source_state:v.source_state,disposition:v.disposition,filename:v.filename,original_sha256:v.original_hash,version_id:v.id,needs_review:!same(row.reviewed_version_id,v.id),candidate_revision:row.native_candidate_id?(await one(t,'SELECT revision FROM ty_hr_candidate WHERE id=$1',[row.native_candidate_id]))?.revision:null});}
  if(view==='jobs'&&await allowed(t,userId,row,'read',['source_ref']))Object.assign(exposed,{window_from:new Date(Number(row.request.from_ms)).toISOString(),window_to:new Date(Number(row.request.to_ms)).toISOString()});
  exposed.allowed_actions=await actions(t,userId,view,row);if(view==='sources'&&same(row.reviewed_version_id,row.latest_version_id))exposed.allowed_actions=exposed.allowed_actions.filter(x=>!['source.accept','source.update'].includes(x));out.push(exposed);
 }
 const references={requisitions:[],connections:[]};for(const r of await q(t,"SELECT * FROM ty_hr_requisition WHERE group_id=$1 AND status='approved'ORDER BY id DESC",[actor.group_id])){if(scope&&!scope.includes(String(r.company_id)))continue;if(await allowed(t,userId,r,'create'))references.requisitions.push({id:r.id,company_id:r.company_id,title:r.title,code:r.code});}
 for(const co of await q(t,"SELECT * FROM ty_integration_connection WHERE group_id=$1 AND provider='feishu'AND status='active'ORDER BY id DESC",[actor.group_id])){if(scope&&co.company_id&&!scope.includes(String(co.company_id)))continue;const d=await h.authorization(t,{userId,resource:'integration_manage',action:'read',groupId:co.group_id,companyId:co.company_id,fields:['config','capabilities']});if(d.allowed)references.connections.push({id:co.id,name:co.name,company_id:co.company_id,external_tenant:co.config.organization_id??null,secret_configured:!!co.secret_cipher});}
 const canCreate=references.requisitions.length>0;return{...h.paging(h.search(out,input.q,['name','channel_name','full_name','external_id','external_job_id']),input),view,references,capabilities:{can_create:canCreate,allowed_actions:canCreate?['channel.create']:[]},metadata:{providers:[{code:'feishu_hire',name:'飞书招聘（只读投递）',configured_only_after_enterprise_authorization:true},{code:'file',name:'Excel / PDF原件',manual_review_required:true}],unconfigured:['钉钉智能招聘读取协议待授权核验','猎聘企业读取协议待授权核验','智联企业读取协议待授权核验'],external_connections_verified:false,automatic_onboarding:false}};
}
export async function sourceDownload(t,{userId,input}){shape(input,['id','version_id']);const r=await root(t,input.id);await proof(t,userId,r,'read');const v=await version(t,r,input.version_id??r.latest_version_id),data=unpack(v);let bytes,filename,mime;
 if(v.original_cipher){bytes=await originalBytes(v);filename=v.filename;mime=v.mime;}else{bytes=Buffer.from(JSON.stringify(data.raw,null,2));filename='招聘来源-'+r.id+'-'+v.id+'.json';mime='application/json';}
 await audit(t,userId,r,'downloaded',{version_id:v.id,sha256:v.source_hash});return{filename,mime,content_base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),content_disposition:'attachment',version_id:v.id};}
export async function sourceTemplate(t,{userId,input={}}){shape(input,['channel_id']);const c=await channel(t,input.channel_id);await hr(t,userId,c,'read',FULL);return recruitingTemplate();}
// Precise native seam: call before existing Offer mutation using its loaded row.
// Disposals remain possible; no other module gets to create employment here.
export async function assertNativeRecruitingSource(t,{userId,operation,row}){
 if(!operation.startsWith('offer.')||operation==='offer.withdraw')return;
 if(!(await one(t,"SELECT to_regclass('public.ty_rc_root')IS NOT NULL ok")).ok)return;
 const candidateId=operation==='offer.create'?row.id:row.candidate_id;
 const r=await one(t,'SELECT * FROM ty_rc_root WHERE native_candidate_id=$1',[candidateId]);if(!r)return;
 const c=await channel(t,r.channel_id),v=await version(t,r);await active(t,c,userId);
 if(r.conflict_version_id||!same(r.reviewed_version_id,r.latest_version_id)||v.source_state!=='active')conflict('当前外部来源未核对或已不活跃；须先办理来源，不能沿旧版Offer继续入职');
}
