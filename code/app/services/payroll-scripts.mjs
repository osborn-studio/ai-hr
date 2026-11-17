import { q, one, same, bad, deny, conflict, missing, id, text, obj, hash, revision, paging, search, audit, emit } from './platform-core.mjs';
import { payrollInternals as H, saveConfiguration } from './payroll-source.mjs';
import { sameHuman, humanIsPerson } from './human-identity.mjs';
import { companyDescendants, ledgerDescendants } from './foundation.mjs';
import { runPayrollScript, SCRIPT_ENGINE, validateScriptOutput } from './payroll-script-engine.mjs';
import { createHash } from 'node:crypto';

const PREFIX = 'payroll.script.';
const protectedKey = key => /(minimum|statutory|native_verified|guard|tax|mpf|contribution|review|non_working_cash|other_work_minutes|classification|qualification|source)/i.test(key);
const sourceHash = source => createHash('sha256').update(source).digest('hex');
const parameterKey = key => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key);
const TIME = new Set(['planned_minutes','worked_minutes','actual_minutes','overtime_minutes','paid_leave_minutes','unpaid_leave_minutes','late_minutes','early_minutes','missing_punches','overtime_workday_minutes','overtime_restday_minutes','overtime_statutory_holiday_minutes']);
const snapshot = async (t, key) => (await one(t, 'SELECT to_jsonb(c) snapshot FROM ty_pay_config c WHERE id=$1', [key]))?.snapshot;
const script = async (t, key) => { const s = await one(t, 'SELECT * FROM ty_ps_script WHERE id=$1', [id(key)]); if (!s) missing(); return s; };
const getRun = async (t, key) => { const r = await one(t, 'SELECT * FROM ty_ps_run WHERE id=$1', [id(key)]); if (!r) missing(); return r; };
async function configAccess(t, u, s, action, fields = ['code','source','input_spec','output_spec']) { return H.access(t, u, 'payroll_config', action, s, fields); }
function profileFields(data){return [...Object.keys(data?.parameters||{}).map(k=>'data.parameters.'+k),...Object.keys(data||{}).filter(k=>k!=='parameters').map(k=>'data.'+k)];}
async function runAccess(t, u, r, action = 'read') { return H.access(t, u, 'payroll_sources', action, r, ['data','sources','amount',...profileFields(r.base_snapshot?.data)]); }
const forbidden=e=>e?.code==='E_TY_FORBIDDEN'||String(e?.message).startsWith('E_TY_FORBIDDEN:');
async function allowed(fn){try{await fn();return true;}catch(e){if(forbidden(e))return false;throw e;}}
function specs(input, output) {
  obj(input, '取数声明'); obj(output, '输出参数声明');
  if (Object.keys(input).length > 24 || !Object.keys(output).length || Object.keys(output).length > 32) bad('取数最多24项，输出参数须1至32项');
  for (const [key, value] of Object.entries(input)) {
    if (!parameterKey(key)) bad('输入别名须为有效稳定编码'); obj(value);
    if (!['profile_parameter','time_report'].includes(value.source) || !parameterKey(value.key) || value.source === 'time_report' && !TIME.has(value.key)) bad('只能取当前已核工资参数或已核考勤分钟，不接受客户端金额与任意SQL');
    text(value.unit, '输入单位', 1, 80);
  }
  for (const [key, value] of Object.entries(output)) {
    if (!parameterKey(key) || protectedKey(key)) bad('法定保障、税供款及核验参数不能由脚本改写'); obj(value); text(value.unit, '输出单位', 1, 80);
    if (value.minimum == null || value.maximum == null) bad('每个输出参数须明确已核上下界');
    H.numeric(value.minimum); H.numeric(value.maximum);
    // Use the same exact comparison as execution validation, including schema bounds.
    validateScriptOutput({ parameters: { [key]: { value: value.minimum, unit: value.unit } } }, { [key]: value });
    validateScriptOutput({ parameters: { [key]: { value: value.maximum, unit: value.unit } } }, { [key]: value });
  }
}
async function current(t, u, s, employmentId, requestedPeriod, reportId) {
  const e = await H.employment(t, employmentId), p = H.period(requestedPeriod instanceof Date?H.date(requestedPeriod):requestedPeriod), end = H.monthEnd(p);
  if (!same(e.group_id, s.group_id) || !same(e.company_id, s.company_id)) bad('代码与实际雇佣须属同一公司与集团');
  await runAccess(t, u, e);
  if (s.status !== 'approved' || H.date(s.valid_from) > p || s.valid_to && H.date(s.valid_to) < end) conflict('代码未独立核准、已停用或不覆盖本期');
  const b = await H.latest(t, { companyId:e.company_id, employmentId:e.id, kind:'profile', system:s.system, on:p, end });
  const r = await H.latest(t, { companyId:e.company_id, employmentId:e.id, kind:'relationship', system:s.system, on:p, end });
  if (!b || !r || !same(b.person_id,e.person_id) || !same(r.person_id,e.person_id)) bad('本期当前已核工资档案或真实法律关系未就绪');
  await H.access(t,u,'payroll_sources','read',e,['data','sources','amount',...profileFields(b.data)]);
  if (H.date(e.hire_date) >= end || e.leave_date && H.date(e.leave_date) < p) bad('雇佣不在所选期间');
  const base = await snapshot(t,b.id), rel = await snapshot(t,r.id), needsTime = Object.values(s.input_spec).some(v=>v.source==='time_report');
  const time = needsTime ? await H.timeSource(t,u,{group_id:e.group_id,company_id:e.company_id,period:p,system:s.system},e,id(reportId)) : null;
  const values = {};
  for (const [key, source] of Object.entries(s.input_spec)) {
    if (source.source === 'profile_parameter') {
      const value = b.data.parameters[source.key];
      if (!value || value.unit !== source.unit || value.value == null) bad('已核参数缺失或单位不符：'+key);
      H.numeric(value.value); values[key] = { value:value.value,unit:value.unit,source:'profile_parameter' };
    } else {
      const value=time?.values[source.key];
      if (value === null || value === undefined || typeof value==='object') bad('已核考勤输入仍未知，不能以0代替：'+key);
      if (source.unit !== (source.key==='missing_punches'?'count':'minute')) bad('考勤输入单位不符：'+key);
      values[key]={value:String(value),unit:source.unit,source:'time_report'};
    }
  }
  for (const [key,spec] of Object.entries(s.output_spec)) {
    const prior=b.data.parameters[key];
    if (!prior || prior.unit!==spec.unit) bad('脚本不能创建新参数或改变既有参数单位：'+key);
  }
  return { e,p,end,b,r,base,rel,time,input:{period:p.slice(0,7),system:s.system,values} };
}
async function scriptReceipt(t,u,key) { const s=await script(t,key);await configAccess(t,u,s,'read');return {script:await H.project(t,u,'payroll_config',s,s)}; }
async function runReceipt(t,u,key) { const r=await getRun(t,key);await runAccess(t,u,r);return {run:await H.project(t,u,'payroll_sources',r,r),proposal:await one(t,'SELECT profile_config_id,run_id,created_at FROM ty_ps_origin WHERE run_id=$1',[r.id]),creates_wage:false,creates_payment:false}; }
async function triggerRow(t,key){const r=await one(t,'SELECT * FROM ty_ps_trigger WHERE id=$1',[id(key)]);if(!r)missing();return r;}
async function triggerReceipt(t,u,key){const r=await triggerRow(t,key);await runAccess(t,u,r);return{trigger:r};}
async function jobReceipt(t,u,key){const r=await one(t,'SELECT j.*,tr.group_id,tr.company_id,tr.person_id,tr.employment_id FROM ty_ps_job j JOIN ty_ps_trigger tr ON tr.id=j.trigger_id WHERE j.id=$1',[id(key)]);if(!r)missing();await runAccess(t,u,r);return{job:r,creates_wage:false,requires_independent_profile_approval:true};}

export async function saveScript(t,{userId,input,operationId}) {
  const c=await H.company(t,input.company_id);await configAccess(t,userId,c,'write');
  const source=text(input.source,'JavaScript函数表达式',1,65536),code=text(input.code,'代码编码',3,64);
  if (!/^[A-Za-z][A-Za-z0-9_]{2,63}$/.test(code)) bad('代码编码格式无效');
  if (!['CN_PAYROLL','HK_PAYROLL'].includes(input.system)) bad('须显式选择内地或香港体系');
  specs(input.input_spec,input.output_spec);
  const from=H.date(input.valid_from),to=input.valid_to?H.date(input.valid_to):null;if(to&&to<=from)bad('有效期间须半开且有序');
  return H.cmd(t,{userId,operationId,operation:PREFIX+'save',input,execute:async()=>{
    await t.query('SELECT id FROM ty_company WHERE id=$1 FOR UPDATE',[c.id]);
    const n=Number((await one(t,'SELECT coalesce(max(revision),0)+1 n FROM ty_ps_script WHERE company_id=$1 AND code=$2',[c.id,code])).n);
    const r=await one(t,'INSERT INTO ty_ps_script(group_id,company_id,code,name,revision,system,valid_from,valid_to,source,source_hash,input_spec,output_spec,engine,evidence_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)RETURNING id',[c.group_id,c.id,code,text(input.name,'规则名称',1,160),n,input.system,from,to,source,sourceHash(source),JSON.stringify(input.input_spec),JSON.stringify(input.output_spec),JSON.stringify(SCRIPT_ENGINE),text(input.evidence_ref,'代码用途与核验依据',4),userId]);
    await audit(t,userId,c.group_id,'payroll.script.save','payroll_script',r.id,{source_hash:sourceHash(source),revision:n});return{script_id:r.id};
  },receipt:r=>scriptReceipt(t,userId,r.script_id)});
}
export async function approveScript(t,{userId,input,operationId}) {
 const s=await script(t,input.id);await configAccess(t,userId,s,'approve');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'approve',input,execute:async()=>{
  const r=await one(t,'SELECT * FROM ty_ps_script WHERE id=$1 FOR UPDATE',[s.id]);revision(r,input.expected_revision);
  if(r.status!=='draft')conflict('代码已处理，请另建版本');if(await sameHuman(t,r.created_by,userId))deny('代码提交和启用须不同自然人');specs(r.input_spec,r.output_spec);
  await t.query("UPDATE ty_ps_script SET status='approved',approved_by=$2,approved_at=now()WHERE id=$1",[r.id,userId]);
  await emit(t,r.group_id,`payroll-script:${r.id}:approved`,'payroll.script.approved',{script_id:r.id,automatic_payroll:false});return{script_id:r.id};
 },receipt:r=>scriptReceipt(t,userId,r.script_id)});
}
export async function disableScript(t,{userId,input,operationId}){
 const s=await script(t,input.id);await configAccess(t,userId,s,'write');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'disable',input,execute:async()=>{const r=await one(t,'SELECT * FROM ty_ps_script WHERE id=$1 FOR UPDATE',[s.id]);revision(r,input.expected_revision);if(r.status!=='approved')conflict('只能停用已核代码');text(input.reason,'停用原因',4);await t.query("UPDATE ty_ps_script SET status='disabled'WHERE id=$1",[r.id]);return{script_id:r.id};},receipt:r=>scriptReceipt(t,userId,r.script_id)});
}
export async function previewScript(t,{userId,input,operationId}){
 const s=await script(t,input.script_id);await configAccess(t,userId,s,'read');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'preview',input,execute:async()=>{
  const c=await current(t,userId,s,input.employment_id,input.period,input.report_id);await runAccess(t,userId,c.e,'write');
  if(input.base_profile_id&&!same(input.base_profile_id,c.b.id)||input.base_hash&&input.base_hash!==H.hash(c.base))conflict('当前工资档案已变，请刷新再预演');
  let result,error;try{result=await runPayrollScript({code:s.source,input:c.input,declaredParameters:s.output_spec});}catch(e){error=/^[a-z_]+$/.test(e.message)?e.message:'engine_failed';}
  const output=result?.output??null,merged=output?{...structuredClone(c.b.data),parameters:{...structuredClone(c.b.data.parameters),...output.parameters}}:null;
  const r=await one(t,'INSERT INTO ty_ps_run(script_id,group_id,company_id,person_id,employment_id,period,base_profile_id,base_hash,base_snapshot,relationship_id,relationship_snapshot,report_id,report_root_id,report_head_revision,input_snapshot,input_hash,output_snapshot,output_hash,merged_data,engine,code_hash,status,error_code,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19::jsonb,$20::jsonb,$21,$22,$23,$24)RETURNING id',[s.id,c.e.group_id,c.e.company_id,c.e.person_id,c.e.id,c.p,c.b.id,H.hash(c.base),JSON.stringify(c.base),c.r.id,JSON.stringify(c.rel),c.time?.id||null,c.time?.root_id||null,c.time?.head_revision||null,JSON.stringify(c.input),result?.input_hash||hash(c.input),output?JSON.stringify(output):null,result?.output_hash||null,merged?JSON.stringify(merged):null,JSON.stringify(SCRIPT_ENGINE),s.source_hash,result?'completed':'failed',error||null,userId]);
  await emit(t,c.e.group_id,`payroll-script-run:${r.id}`,'payroll.script.previewed',{run_id:r.id,status:result?'completed':'failed',profile_created:false,payroll_adopted:false});return{run_id:r.id};
 },receipt:r=>runReceipt(t,userId,r.run_id)});
}
async function revalidateRun(t,u,r){
 const s=await script(t,r.script_id),c=await current(t,u,s,r.employment_id,r.period,r.report_id);
 if(!same(c.b.id,r.base_profile_id)||H.hash(c.base)!==r.base_hash||!same(c.r.id,r.relationship_id)||H.hash(c.rel)!==H.hash(r.relationship_snapshot)||c.time&&(String(c.time.root_id)!==String(r.report_root_id)||Number(c.time.head_revision)!==Number(r.report_head_revision)))conflict('代码、工资参数、实际关系或考勤当前根已改变，须重做预演');return c;
}
export async function createProposal(t,{userId,input,operationId}){
 const r=await getRun(t,input.run_id);await runAccess(t,userId,r,'write');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'proposal.create',input,execute:async()=>{
  await t.query('SELECT id FROM ty_company WHERE id=$1 FOR UPDATE',[r.company_id]);
  const old=await one(t,'SELECT profile_config_id FROM ty_ps_origin WHERE run_id=$1',[r.id]);if(old)return{run_id:r.id};
  if(r.status!=='completed')bad('失败预演不能生成工资参数');const c=await revalidateRun(t,userId,r);
  const result=await saveConfiguration(t,{userId,operationId:'script-profile-'+r.id+'-'+operationId,input:{kind:'profile',company_id:r.company_id,employment_id:r.employment_id,system:c.b.system,currency:c.b.currency,valid_from:c.p,valid_to:c.end,data:r.merged_data,evidence_ref:text(input.evidence_ref,'参数提案依据',4)}});
  if(!result.config?.id)deny('生成工资草稿所需字段不可见');
  await t.query('INSERT INTO ty_ps_origin(profile_config_id,run_id,base_profile_id,base_hash,created_by)VALUES($1,$2,$3,$4,$5)',[result.config.id,r.id,r.base_profile_id,r.base_hash,userId]);
  await emit(t,r.group_id,`payroll-script-run:${r.id}:proposal`,'payroll.script.parameter_proposed',{run_id:r.id,profile_config_id:result.config.id,status:'draft',requires_independent_approval:true});return{run_id:r.id};
 },receipt:x=>runReceipt(t,userId,x.run_id)});
}
export async function saveTrigger(t,{userId,input,operationId}){
 const s=await script(t,input.script_id),e=await H.employment(t,input.employment_id);await configAccess(t,userId,s,'write');await runAccess(t,userId,e,'write');
 if(!same(e.company_id,s.company_id)||!same(e.group_id,s.group_id)||s.status!=='approved')bad('触发器须引用同公司已核代码和真实关系');
 const from=H.date(input.valid_from),to=input.valid_to?H.date(input.valid_to):null;if(to&&to<=from)bad('触发器有效期无效');if(!['manual','time_report.confirmed','salary_profile.approved'].includes(input.event_kind))bad('触发时点尚未开放');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'trigger.save',input,execute:async()=>{const r=await one(t,'INSERT INTO ty_ps_trigger(script_id,group_id,company_id,employment_id,person_id,event_kind,valid_from,valid_to,evidence_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)RETURNING id',[s.id,e.group_id,e.company_id,e.id,e.person_id,input.event_kind,from,to,text(input.evidence_ref,'触发规则依据',4),userId]);return{trigger_id:r.id};},receipt:r=>triggerReceipt(t,userId,r.trigger_id)});
}
export async function approveTrigger(t,{userId,input,operationId}){
 const tr=await triggerRow(t,input.id);await configAccess(t,userId,tr,'approve');await runAccess(t,userId,tr,'write');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'trigger.approve',input,execute:async()=>{
  const r=await one(t,'SELECT * FROM ty_ps_trigger WHERE id=$1 FOR UPDATE',[tr.id]);revision(r,input.expected_revision);
  if(r.status!=='draft')conflict('触发器已处理');if(await sameHuman(t,r.created_by,userId)||await humanIsPerson(t,userId,r.group_id,r.person_id))deny('触发器启用须非提交人、非受益人的另一自然人');
  await t.query("UPDATE ty_ps_trigger SET status='approved',revision=revision+1,approved_by=$2,approved_at=now()WHERE id=$1",[r.id,userId]);return{trigger_id:r.id};
 },receipt:r=>triggerReceipt(t,userId,r.trigger_id)});
}
export async function disableTrigger(t,{userId,input,operationId}){const r=await triggerRow(t,input.id);await configAccess(t,userId,r,'write');return H.cmd(t,{userId,operationId,operation:PREFIX+'trigger.disable',input,execute:async()=>{revision(r,input.expected_revision);text(input.reason,'停用原因',4);await t.query("UPDATE ty_ps_trigger SET status='disabled',revision=revision+1 WHERE id=$1",[r.id]);return{trigger_id:r.id};},receipt:x=>triggerReceipt(t,userId,x.trigger_id)});}
export async function enqueueTrigger(t,{userId,input,operationId}){
 const tr=await triggerRow(t,input.trigger_id);await runAccess(t,userId,tr,'write');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'trigger.enqueue',input,execute:async()=>{
  const s=await script(t,tr.script_id),c=await current(t,userId,s,tr.employment_id,input.period,input.report_id);if(tr.status!=='approved'||H.date(tr.valid_from)>c.p||tr.valid_to&&H.date(tr.valid_to)<c.end)conflict('触发器未启用或不覆盖本期');
  let sourceId=null,sourceRevision=null,domain='manual',key;
  if(tr.event_kind==='time_report.confirmed'){if(!c.time)bad('此触发器的脚本须显式声明考勤输入');domain='time_report';sourceId=c.time.id;sourceRevision=String(c.time.head_revision);key=`time:${c.time.root_id}:${c.time.head_revision}`;}
  else if(tr.event_kind==='salary_profile.approved'){if(await one(t,'SELECT 1 FROM ty_ps_origin WHERE profile_config_id=$1',[c.b.id]))bad('脚本生成参数不得重新触发脚本，防止递归');domain='salary_profile';sourceId=c.b.id;sourceRevision=String(c.b.revision);key=`profile:${c.b.id}:${c.b.revision}`;}
  else key='manual:'+text(input.event_key,'人工触发来源号',8,120);
  const old=await one(t,'SELECT id FROM ty_ps_job WHERE trigger_id=$1 AND event_key=$2',[tr.id,key]);if(old)return{job_id:old.id};
  const job=await one(t,'INSERT INTO ty_ps_job(trigger_id,event_key,source_domain,source_id,source_revision,period,report_id,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8)RETURNING id',[tr.id,key,domain,sourceId,sourceRevision,c.p,c.time?.id||null,userId]);
  await emit(t,tr.group_id,`payroll-script-job:${job.id}`,'payroll.script.preview_queued',{job_id:job.id,profile_created:false,payroll_adopted:false});return{job_id:job.id};
 },receipt:r=>jobReceipt(t,userId,r.job_id)});
}
export async function processJob(t,{userId,input,operationId}){
 const job=await one(t,'SELECT j.*,tr.group_id,tr.company_id,tr.person_id,tr.employment_id,tr.script_id FROM ty_ps_job j JOIN ty_ps_trigger tr ON tr.id=j.trigger_id WHERE j.id=$1',[id(input.id)]);if(!job)missing();await runAccess(t,userId,job,'write');
 return H.cmd(t,{userId,operationId,operation:PREFIX+'job.process',input,execute:async()=>{
  const j=await one(t,'SELECT * FROM ty_ps_job WHERE id=$1 FOR UPDATE',[job.id]);revision(j,input.expected_revision);if(j.state!=='queued')conflict('任务已处理');
  const tr=await triggerRow(t,j.trigger_id),s=await script(t,tr.script_id);if(tr.status!=='approved'||s.status!=='approved')conflict('代码或触发器已停用');
  const c=await current(t,userId,s,tr.employment_id,j.period,j.report_id);if(j.source_domain==='salary_profile'&&!same(j.source_id,c.b.id)||j.source_domain==='time_report'&&(!same(j.source_id,c.time?.id)||String(j.source_revision)!==String(c.time.head_revision)))conflict('触发来源已改变，请重新排队');
  const out=await previewScript(t,{userId,operationId:'script-job-'+j.id+'-'+operationId,input:{script_id:job.script_id,employment_id:job.employment_id,period:H.date(j.period).slice(0,7),report_id:j.report_id}});
  await t.query("UPDATE ty_ps_job SET state=$2,revision=revision+1,run_id=$3,processed_by=$4,processed_at=now(),reason=$5 WHERE id=$1",[j.id,out.run.status==='completed'?'completed':'blocked',out.run.id,userId,out.run.error_code]);return{job_id:j.id};
 },receipt:r=>jobReceipt(t,userId,r.job_id)});
}
export async function aiProposal(t,{userId,input,operationId}){
 const c=await H.company(t,input.company_id);await configAccess(t,userId,c,'write');
 const purpose=input.purpose||'draft_script';if(!['draft_script','explain_run'].includes(purpose))bad('AI工具用途未开放');
 if(purpose==='explain_run'){const r=await getRun(t,input.run_id);if(!same(r.company_id,c.id))bad('预演不属于当前公司');await runAccess(t,userId,r);}
 const request={goal:text(input.goal,'需求说明',4,2000),...(purpose==='explain_run'?{run_id:id(input.run_id)}:{}),provider_configured:false,execution_state:'not_executed'};
 return H.cmd(t,{userId,operationId,operation:PREFIX+'ai.propose',input,execute:async()=>{const r=await one(t,'INSERT INTO ty_ps_ai_proposal(group_id,company_id,purpose,request,proposal,run_id,created_by)VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)RETURNING id',[c.group_id,c.id,purpose,JSON.stringify(request),JSON.stringify({kind:'typed_request',goal:request.goal,requires_human_authoring:true,creates_payment:false}),purpose==='explain_run'?input.run_id:null,userId]);return{ai_proposal_id:r.id};},receipt:async r=>{await configAccess(t,userId,c,'read');return{ai_proposal_id:r.ai_proposal_id,provider_configured:false,execution_state:'not_executed',message:'已保存结构化需求，尚未配置模型；可手工起草并独立核准代码。'};}});
}
export const operations=Object.freeze({save:saveScript,approve:approveScript,disable:disableScript,preview:previewScript,'proposal.create':createProposal,'trigger.save':saveTrigger,'trigger.approve':approveTrigger,'trigger.disable':disableTrigger,'trigger.enqueue':enqueueTrigger,'job.process':processJob,'ai.propose':aiProposal});
export async function dispatchCommand(t,args){const op=args.operation?.replace(/^payroll\.script\./,'');if(!operations[op])bad('工资脚本动作未开放');return operations[op](t,args);}
export async function queryWorkspace(t,{userId,input}){
 const group=id(input.group_id),cids=input.company_id?await companyDescendants(t,input.company_id):null,lids=input.ledger_id?await ledgerDescendants(t,input.ledger_id):null,view=input.view||'scripts',rows=[];
 if(!['scripts','runs','triggers','jobs','proposals','ai','options'].includes(view))bad('脚本视图未开放');
 if(view==='options'){
  const es=await q(t,"SELECT e.*,c.ledger_id,c.name company_name,p.person_number,p.full_name FROM ty_employment e JOIN ty_company c ON c.id=e.company_id JOIN ty_person p ON p.id=e.person_id WHERE e.group_id=$1 AND e.status<>'cancelled'ORDER BY e.id",[group]);
  for(const e of es){if(cids&&!cids.includes(String(e.company_id))||lids&&!lids.includes(String(e.ledger_id)))continue;try{await H.access(t,userId,'payroll_sources','read',e,['data','sources','amount','person_id','full_name','person_number']);rows.push({id:e.id,employment_id:e.id,person_id:e.person_id,company_id:e.company_id,company_name:e.company_name,person_number:e.person_number,full_name:e.full_name});}catch(err){if(!forbidden(err))throw err;}}
  const companies=[];
  for(const c of await q(t,'SELECT *,id company_id FROM ty_company WHERE group_id=$1 ORDER BY id',[group])){if(cids&&!cids.includes(String(c.id))||lids&&!lids.includes(String(c.ledger_id)))continue;if(await allowed(()=>configAccess(t,userId,c,'read')))companies.push({id:c.id,name:c.name,can_create:await allowed(()=>configAccess(t,userId,c,'write'))});}
  let currentProfile=null,reportOptions=[];
  if(input.employment_id){const e=await H.employment(t,input.employment_id);if(!same(e.group_id,group)||cids&&!cids.includes(String(e.company_id)))deny();await runAccess(t,userId,e);const p=H.period(input.period),end=H.monthEnd(p),system=input.system||'CN_PAYROLL';const profile=await H.latest(t,{companyId:e.company_id,employmentId:e.id,kind:'profile',system,on:p,end});
   if(profile){await H.access(t,userId,'payroll_sources','read',e,['data','sources','amount',...profileFields(profile.data)]);currentProfile={id:profile.id,hash:H.hash(await snapshot(t,profile.id)),system:profile.system,valid_from:profile.valid_from,valid_to:profile.valid_to,parameters:profile.data.parameters};}
   for(const root of await q(t,"SELECT h.*,v.label FROM ty_time_report_root h JOIN ty_time_report_version v ON v.id=h.current_report_id WHERE h.employment_id=$1 AND h.period=$2 AND h.perspective='employer'AND h.owner_company_id=$3 AND v.status='confirmed'",[e.id,p,e.company_id])){try{await H.timeSource(t,userId,{group_id:e.group_id,company_id:e.company_id,period:p,system},e,root.current_report_id);reportOptions.push({id:root.current_report_id,label:root.label,head_revision:root.head_revision});}catch(e){if(!forbidden(e))throw e;}}
  }
  const scriptOptions=[];for(const s of await q(t,"SELECT * FROM ty_ps_script WHERE group_id=$1 AND status='approved'ORDER BY code,revision DESC",[group])){if(cids&&!cids.includes(String(s.company_id)))continue;if(await allowed(()=>configAccess(t,userId,s,'read')))scriptOptions.push({id:s.id,company_id:s.company_id,code:s.code,name:s.name,revision:s.revision,system:s.system,input_spec:s.input_spec,output_spec:s.output_spec});}
  return{...paging(search(rows,input.q,['person_number','full_name','company_name']),input),companies,script_options:scriptOptions,current_profile:currentProfile,report_options:reportOptions,engine:SCRIPT_ENGINE,isolation_configured:process.env.TYHR_PAYROLL_SCRIPT_SANDBOX==='quickjs-wasm-v1',capabilities:{can_create:companies.some(c=>c.can_create),can_preview:rows.length>0}};
 }
 const sql=view==='scripts'?'SELECT s.* FROM ty_ps_script s WHERE group_id=$1 ORDER BY id DESC':view==='runs'?'SELECT r.* FROM ty_ps_run r WHERE group_id=$1 ORDER BY id DESC':view==='triggers'?'SELECT tr.* FROM ty_ps_trigger tr WHERE group_id=$1 ORDER BY id DESC':view==='proposals'?'SELECT r.*,o.profile_config_id,c.status profile_status,c.revision profile_revision FROM ty_ps_origin o JOIN ty_ps_run r ON r.id=o.run_id JOIN ty_pay_config c ON c.id=o.profile_config_id WHERE r.group_id=$1 ORDER BY r.id DESC':view==='ai'?'SELECT a.* FROM ty_ps_ai_proposal a WHERE group_id=$1 ORDER BY id DESC':'SELECT j.*,tr.group_id,tr.company_id,tr.person_id,tr.employment_id FROM ty_ps_job j JOIN ty_ps_trigger tr ON tr.id=j.trigger_id WHERE tr.group_id=$1 ORDER BY j.id DESC';
 for(const r of await q(t,sql,[group])){
  const c=await H.company(t,r.company_id);if(cids&&!cids.includes(String(r.company_id))||lids&&!lids.includes(String(c.ledger_id))||input.id&&!same(input.id,r.id)||input.employment_id&&!same(input.employment_id,r.employment_id))continue;
  try{if(['scripts','ai'].includes(view))await configAccess(t,userId,r,'read');else await runAccess(t,userId,r);const resource=['scripts','ai'].includes(view)?'payroll_config':'payroll_sources',v=await H.project(t,userId,resource,r,r);if(v){v.actions=[];
   if(view==='scripts'){if(r.status==='draft'&&!await sameHuman(t,r.created_by,userId)&&await allowed(()=>configAccess(t,userId,r,'approve')))v.actions.push({code:'approve',label:'独立启用'});if(r.status==='approved'&&await allowed(()=>configAccess(t,userId,r,'write')))v.actions.push({code:'disable',label:'停用'});}
   if(view==='runs'&&r.status==='completed'&&!await one(t,'SELECT 1 FROM ty_ps_origin WHERE run_id=$1',[r.id])&&await allowed(()=>runAccess(t,userId,r,'write')))v.actions.push({code:'proposal.create',label:'生成参数草稿'});
   if(view==='proposals'&&r.profile_status==='draft'&&!await sameHuman(t,r.created_by,userId)&&!await humanIsPerson(t,userId,r.group_id,r.person_id)&&await allowed(()=>H.access(t,userId,'payroll_confirm','approve',r,['data','status'])))v.actions.push({code:'profile.approve',label:'独立核准参数'});
   if(view==='triggers'){if(r.status==='draft'&&!await sameHuman(t,r.created_by,userId)&&!await humanIsPerson(t,userId,r.group_id,r.person_id)&&await allowed(()=>configAccess(t,userId,r,'approve')))v.actions.push({code:'trigger.approve',label:'独立启用'});if(r.status==='approved'&&await allowed(()=>runAccess(t,userId,r,'write')))v.actions.push({code:'trigger.enqueue',label:'排队预演'});if(r.status==='approved'&&await allowed(()=>configAccess(t,userId,r,'write')))v.actions.push({code:'trigger.disable',label:'停用'});}
   if(view==='jobs'&&r.state==='queued'&&await allowed(()=>runAccess(t,userId,r,'write')))v.actions.push({code:'job.process',label:'执行预演'});rows.push(v);
  }}catch(err){if(!forbidden(err))throw err;}
 }
 return{...paging(search(rows,input.q,['code','name','status','state','error_code']),input),engine:SCRIPT_ENGINE,isolation_configured:process.env.TYHR_PAYROLL_SCRIPT_SANDBOX==='quickjs-wasm-v1',preview_only:true,profile_approval_separate:true};
}
