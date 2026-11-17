import{subjectDepartment,snapshotScopeAvailable}from'./workflow-scope.mjs';
import{grantAllowsField}from'./platform-core.mjs';
import{sameHuman,humanIsPerson}from'./human-identity.mjs';
import{retainNotificationCopies,notifyWorkflowResult}from'./workflow-notifications.mjs';
import{q,one,same,bad,deny,conflict,missing,id,text,obj,revision,groupFor,rowScope,requireAccess,authorization,command,audit,emit,hash,currentOperator,visibleOperators}from'./platform-core.mjs';
import{validateGraph,validateSchema,validateValues,nextNode,projectValues}from'../platform-model.mjs';

const projectReceipt=(t,userId)=>async result=>result.instance?{...result,instance:await projectInstance(t,userId,result.instance.id)}:result;
const TABLES={workflow:'ty_workflow_definition',form:'ty_form_definition'};
const RESOURCE='workflow_manage';
// Each business adapter reopens its own source and current complete grants.
// Generic workflow values never substitute for payroll/personnel authority.
async function businessAdapter(t,type){
 if(['time_change','time_punch_correction'].includes(type)){if(!(await one(t,"SELECT to_regclass('public.ty_tw_execution')IS NOT NULL ok")).ok)bad('排班考勤审批尚未安装');const a=await import('./platform-time.mjs');return{submit:a.submitTimeSubject,approve:a.assertTimeApproval,project:a.projectTimeInstance,execute:a.executeTimeSubject,reject:a.rejectTimeSubject,cancel:a.cancelTimeSubject};}
 if(type==='payroll_finance'){
  if(!(await one(t,"SELECT to_regclass('public.ty_pay_finance_subject')IS NOT NULL ok")).ok)bad('薪酬资金审批尚未安装');
  const a=await import('./platform-payroll-finance.mjs');return{submit:a.submitFinanceSubject,approve:a.assertFinanceApproval,project:a.projectFinanceInstance,execute:a.executeFinanceSubject,reject:a.rejectFinanceSubject,cancel:a.cancelFinanceSubject};
 }
 if(['workforce_profile','workforce_price','workforce_contract','workforce_order','workforce_engagement','workforce_acceptance','workforce_bill','workforce_opening','workforce_bank_receipt','workforce_advance','workforce_payment','workforce_mandate','workforce_instruction','workforce_personal_receipt'].includes(type)){
  if(!(await one(t,"SELECT to_regclass('public.ty_wf_approval_execution')IS NOT NULL ok")).ok)bad('外包业务审批尚未安装');
  const a=await import('./platform-workforce.mjs');return{submit:a.submitWorkforceSubject,approve:a.assertWorkforceApproval,project:a.projectWorkforceInstance,execute:a.executeWorkforceSubject,reject:a.rejectWorkforceSubject,cancel:a.cancelWorkforceSubject};
 }
 if(type==='personal_service'){
  if(!(await one(t,"SELECT to_regclass('public.ty_personal_service_request')IS NOT NULL ok")).ok)bad('个人住宿与领用审批尚未安装');
  const a=await import('./personal-services.mjs');return{submit:a.submitSubject,approve:a.assertApproval,project:a.projectInstance,execute:a.executeSubject,reject:a.rejectSubject,cancel:a.cancelSubject};
 }
 if(['payroll_source_preview','payroll_batch'].includes(type)){
  if(!(await one(t,"SELECT to_regclass('public.ty_pay_batch')IS NOT NULL ok")).ok)bad('薪酬业务适配器尚未安装');
  const a=await import('./platform-payroll.mjs');return{submit:a.submitPayrollSubject,approve:a.assertPayrollApproval,project:a.projectPayrollInstance,execute:a.executePayrollSubject,reject:a.rejectPayrollSubject,cancel:a.cancelPayrollSubject};
 }
 if(type==='hr_change'){
  if(!(await one(t,"SELECT to_regclass('public.ty_hr_change_request')IS NOT NULL ok")).ok)bad('人事异动适配器尚未安装');
  const a=await import('./platform-hr.mjs');return{submit:a.submitHrSubject,approve:a.assertHrApproval,project:a.projectHrInstance,execute:a.executeHrSubject,reject:a.rejectHrSubject,cancel:a.cancelHrSubject};
 }
 if(['hr_requisition','hr_offer','hr_contract_sign','hr_contract_term'].includes(type)){
  if(!(await one(t,"SELECT to_regclass('public.ty_hr_record_proposal')IS NOT NULL ok")).ok)bad('招聘合同审批适配器尚未安装');
  const a=await import('./platform-hr-records.mjs');return{submit:a.submitHrRecordSubject,approve:a.assertHrRecordApproval,project:a.projectHrRecordInstance,execute:a.executeHrRecordSubject,reject:a.rejectHrRecordSubject,cancel:a.cancelHrRecordSubject};
 }
 if(['learning_result','learning_application'].includes(type)){
  const table=type==='learning_result'?'public.ty_lr_grade':'public.ty_lr_application';if(!(await one(t,'SELECT to_regclass($1)IS NOT NULL ok',[table])).ok)bad('培训考试审批模块尚未安装');
  const a=await import('./platform-learning.mjs');return{submit:a.submitLearningSubject,approve:a.assertLearningApproval,project:a.projectLearningInstance,execute:a.executeLearningSubject,reject:a.rejectLearningSubject,cancel:a.cancelLearningSubject};
 }
 if(type==='performance_result'){
  if(!(await one(t,"SELECT to_regclass('public.ty_pr_cycle_root')IS NOT NULL ok")).ok)bad('绩效结果审批模块尚未安装');
  const a=await import('./platform-performance.mjs');return{submit:a.submitPerformanceSubject,approve:a.assertPerformanceApproval,project:a.projectPerformanceInstance,execute:a.executePerformanceSubject,reject:a.rejectPerformanceSubject,cancel:a.cancelPerformanceSubject};
 }
 return null;
}
async function definition(t,kind,key){const r=await one(t,`SELECT * FROM ${TABLES[kind]} WHERE id=$1`,[id(key)]);if(!r)missing();return r;}
async function scope(t,userId,group,company=null,action='write',context={}){await requireAccess(t,userId,RESOURCE,action,{...context,group_id:group,company_id:company});}
async function validateRefs(t,schema,values,group,company,userId){
 for(const f of schema.fields){const value=values[f.key];if(value==null)continue;
  if(f.type==='person'){if(!await one(t,'SELECT 1 FROM ty_person WHERE id=$1 AND group_id=$2',[id(value),group]))bad('表单人员不属于集团');const a=await groupFor(t,userId,group);if(a.access.selfOnly&&!same(a.access.selfPersonId,value))deny('只能提交本人的业务表单');if(company&&!await one(t,"SELECT 1 FROM ty_employment WHERE person_id=$1 AND company_id=$2 AND status<>'cancelled'",[value,company]))bad('表单人员没有所选公司的雇佣记录');}
  if(f.type==='company'){const c=await one(t,'SELECT id company_id,group_id,ledger_id FROM ty_company WHERE id=$1 AND group_id=$2',[id(value),group]);if(!c)bad('表单公司不属于集团');await rowScope(t,userId,c);}
  if(f.type==='file'&&value.length&&!(await one(t,"SELECT to_regclass('public.ty_pf_attachment')IS NOT NULL ok")).ok)bad('附件存储尚未接入；不能把未核验的文件路径作为附件');
 }
}
async function optionsFor(t,userId,group,company){return visibleOperators(t,userId,group,{options:true,companyId:company});}
export async function assertDomainApproval(t,{userId,instance,currentRoster=false}){
 if(instance.subject_type==='leave_request'){
  const source=await(await import('./platform-leave.mjs')).leaveRequestSource(t,instance.subject_id);
  await(await import('./advanced-leave.mjs')).accountContext(t,{userId,accountId:source.request.account_id,resource:'advanced_leave_approve',write:true,action:'approve',fields:['status','quantity','facts']});
  if(currentRoster)await(await import('./leave-roster-source.mjs')).assertRequestRosterCurrent(t,source.request);
 }else if(instance.subject_type==='leave_lifecycle_proposal')await(await import('./leave-lifecycle.mjs')).assertProposalApprovalAccess(t,{userId,id:instance.subject_id});
 else{const a=await businessAdapter(t,instance.subject_type);if(a)await a.approve(t,{userId,instance});}
}
async function resolveApprovers(t,instance,node){
 const explicit=[...new Set((node.approver_ids||[]).map(x=>id(x)))],eligible=await q(t,`SELECT a.id FROM sys_account a LEFT JOIN ty_operator_binding b ON b.account_id=a.id LEFT JOIN ty_test_account_profile p ON p.account_id=a.id WHERE a.status='active' AND coalesce(b.group_id,p.group_id)=$1 AND coalesce(b.profile_code,p.profile_code)NOT IN('config_admin','vendor_contact','outsource_hr','outsourced_staff')`,[instance.group_id]);
 const candidates=new Map(eligible.map(x=>[String(x.id),x]));const roleCodes=node.role_codes||[];
 let roles=[];if(roleCodes.length)roles=await q(t,`SELECT DISTINCT m.account_id FROM ty_auth_membership m JOIN ty_auth_role r ON r.id=m.role_id WHERE m.group_id=$1 AND r.code=ANY($2::text[]) AND r.status='active' AND m.status='active' AND m.valid_from<=now()AND(m.valid_to IS NULL OR now()<m.valid_to)`,[instance.group_id,roleCodes]);
 const initial=[...new Set([...explicit,...roles.map(x=>Number(x.account_id))])],out=[];
 for(let actor of initial){if(!candidates.has(String(actor)))continue;
  const delegation=await one(t,"SELECT * FROM ty_workflow_delegate WHERE group_id=$1 AND from_account_id=$2 AND status='active' AND valid_from<=now()AND now()<valid_to ORDER BY valid_from DESC LIMIT 1",[instance.group_id,actor]);
  if(delegation&&candidates.has(String(delegation.to_account_id)))actor=Number(delegation.to_account_id);
  if(await sameHuman(t,actor,instance.applicant_id)||await humanIsPerson(t,actor,instance.group_id,instance.person_id))continue;
  if(!(await authorization(t,{userId:actor,resource:'workflow_self',action:'approve',groupId:instance.group_id,companyId:instance.company_id,personId:instance.person_id,departmentId:instance.department_id})).allowed)continue;
  try{await assertDomainApproval(t,{userId:actor,instance});}catch(e){if(String(e.message).startsWith('E_TY_FORBIDDEN:'))continue;throw e;}
  out.push(actor);
 }return[...new Set(out)];
}
async function log(t,instance,userId,action,node,metadata={}){await t.query('INSERT INTO ty_workflow_log(instance_id,node_id,actor_id,action,metadata)VALUES($1,$2,$3,$4,$5::jsonb)',[instance.id,node||null,userId,action,JSON.stringify(metadata)]);}
async function advance(t,instance,from,userId){
 const map=new Map(instance.graph_snapshot.nodes.map(n=>[n.id,n]));let next=from;
 for(let step=0;step<=128;step++){
  const n=map.get(next);if(!n)bad('审批快照连接丢失');
  if(n.type==='approval'){
   const approvers=await resolveApprovers(t,instance,n);
   if(!approvers.length){await t.query("UPDATE ty_workflow_instance SET status='blocked',current_node=$2,block_reason='当前节点没有具备权限且非申请人的审批人员',revision=revision+1 WHERE id=$1",[instance.id,n.id]);await log(t,instance,userId,'blocked',n.id);return;}
   for(const actor of approvers)await t.query("INSERT INTO ty_workflow_task(instance_id,node_id,approver_id,mode)VALUES($1,$2,$3,$4)ON CONFLICT DO NOTHING",[instance.id,n.id,actor,n.mode||'any']);
   await t.query("UPDATE ty_workflow_instance SET status='running',current_node=$2,block_reason=NULL,revision=revision+1 WHERE id=$1",[instance.id,n.id]);await log(t,instance,userId,'task.created',n.id,{approver_ids:approvers});return;
  }
  if(n.type==='notify'){
   const recipients=await retainNotificationCopies(t,{instance,node:n,projectInstance});
   await emit(t,instance.group_id,`workflow:${instance.id}:notify:${n.id}`,'workflow.copy',{instance_id:instance.id,recipient_ids:recipients});
  }
  if(n.type==='end'){
   await t.query("UPDATE ty_workflow_instance SET status='approved',current_node=$2,finished_at=now(),revision=revision+1 WHERE id=$1",[instance.id,n.id]);
   await notifyWorkflowResult(t,{instance,outcome:'approved',projectInstance});await log(t,instance,userId,'approved',n.id);await emit(t,instance.group_id,`workflow:${instance.id}:approved`,'workflow.approved',{instance_id:instance.id,subject_type:instance.subject_type,subject_id:instance.subject_id});return;
  }
  try{next=nextNode(n,instance.form_values);}catch(e){bad(e.message);}
 }bad('流程超过最大节点数');
}

export async function saveDefinition(t,{userId,input,operationId,kind}){
 if(!TABLES[kind])bad('设计对象类型无效');const g=await groupFor(t,userId,input.group_id);await scope(t,userId,g.id,input.company_id);
 return command(t,{userId,groupId:g.id,operation:`${kind}.save`,operationId,input,execute:async()=>{
  const name=text(input.name,'名称',1,120),code=text(input.code,'编码',2,80),business=text(input.business_type||'general','业务类型',1,80),company=id(input.company_id,true);
  if(!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(code))bad('编码须为字母开头的稳定编码');
  const content=obj(kind==='workflow'?input.graph:input.schema,kind==='workflow'?'审批图':'表单');const validation=kind==='workflow'?validateGraph(content):validateSchema(content);if(!validation.valid)bad(validation.issues.join('；'));
  let workflow=null;if(kind==='form'&&input.workflow_id){workflow=await definition(t,'workflow',input.workflow_id);if(!same(workflow.group_id,g.id)||workflow.company_id&&(!company||!same(company,workflow.company_id)))bad('工作流范围与表单不符');}
  let row;
  if(input.id){const old=await definition(t,kind,input.id);await scope(t,userId,old.group_id,old.company_id);if(!same(old.group_id,g.id)||old.status!=='draft')conflict('已发布版本不可覆盖，请创建新版本');revision(old,input.expected_revision);const params=[old.id,name,business,company,JSON.stringify(content)];row=await one(t,`UPDATE ${TABLES[kind]} SET name=$2,business_type=$3,company_id=$4,${kind==='workflow'?'graph':'schema'}=$5::jsonb${kind==='form'?',workflow_id=$6':''},revision=revision+1 WHERE id=$1 RETURNING *`,kind==='form'?[...params,workflow?.id||null]:params);}
  else{await t.query('SELECT id FROM ty_group WHERE id=$1 FOR UPDATE',[g.id]);const version=Number((await one(t,`SELECT coalesce(max(version),0)+1 v FROM ${TABLES[kind]} WHERE group_id=$1 AND code=$2`,[g.id,code])).v);const params=[g.id,company,code,name,version,business,JSON.stringify(content),userId];row=await one(t,`INSERT INTO ${TABLES[kind]}(group_id,company_id,code,name,version,business_type,${kind==='workflow'?'graph':'schema'},created_by${kind==='form'?',workflow_id':''})VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8${kind==='form'?',$9':''})RETURNING *`,kind==='form'?[...params,workflow?.id||null]:params);}
  await audit(t,userId,g.id,`${kind}.save`,kind,row.id,{version:row.version});return{[kind]:row};
 }});
}
export async function publishDefinition(t,{userId,input,operationId,kind}){
 const d=await definition(t,kind,input.id);await scope(t,userId,d.group_id,d.company_id,'publish');
 return command(t,{userId,groupId:d.group_id,operation:`${kind}.publish`,operationId,input,execute:async()=>{
  const old=await one(t,`SELECT * FROM ${TABLES[kind]} WHERE id=$1 FOR UPDATE`,[d.id]);revision(old,input.expected_revision);if(old.status!=='draft')conflict('只有草稿可以发布');if(await sameHuman(t,old.created_by,userId))deny('设计者和发布复核人须为不同操作人员');
  const result=kind==='workflow'?validateGraph(old.graph):validateSchema(old.schema);if(!result.valid)bad(result.issues.join('；'));
  if(kind==='form'){const w=await definition(t,'workflow',old.workflow_id);if(w.status!=='published'||w.business_type!==old.business_type)bad('表单须绑定同一业务类型的确切已发布审批流');}
  const row=await one(t,`UPDATE ${TABLES[kind]} SET status='published',published_by=$2,published_at=now(),revision=revision+1 WHERE id=$1 RETURNING *`,[old.id,userId]);
  if(kind==='form'&&old.business_type!=='general'){
   await t.query("UPDATE ty_workflow_binding SET status='disabled',valid_to=now(),revision=revision+1 WHERE group_id=$1 AND company_id IS NOT DISTINCT FROM $2 AND business_type=$3 AND kind IS NOT DISTINCT FROM $4 AND status='active'",[old.group_id,old.company_id,old.business_type,input.binding_kind||null]);
   await t.query('INSERT INTO ty_workflow_binding(group_id,company_id,business_type,kind,form_id,created_by)VALUES($1,$2,$3,$4,$5,$6)',[old.group_id,old.company_id,old.business_type,input.binding_kind||null,old.id,userId]);
  }
  await audit(t,userId,d.group_id,`${kind}.publish`,kind,d.id,{version:row.version});return{[kind]:row};
 }});
}
export async function previewWorkflow(t,{userId,input}){
 const g=await groupFor(t,userId,input.group_id);await scope(t,userId,g.id,input.company_id,'read');const graph=obj(input.graph||((await definition(t,'workflow',input.workflow_id)).graph));const v=validateGraph(graph);if(!v.valid)return{...v,path:[],resolved_approvers:[]};
 const values=obj(input.values||{}),map=new Map(graph.nodes.map(n=>[n.id,n])),path=[],resolved=[];let n=graph.nodes.find(n=>n.type==='start');try{for(let i=0;n&&i<129;i++){path.push({id:n.id,type:n.type,label:n.label});if(n.type==='approval')resolved.push({node_id:n.id,approver_ids:await resolveApprovers(t,{group_id:g.id,company_id:input.company_id||null,applicant_id:userId},n)});if(n.type==='end')break;n=map.get(nextNode(n,values));}}catch(e){return{valid:false,issues:[e.message],path,resolved_approvers:resolved};}return{valid:true,issues:[],path,resolved_approvers:resolved};
}

export async function approvalRequirement(t,{userId,subjectType,groupId,companyId,kind}){
 const installed=!!(await one(t,"SELECT to_regclass('public.ty_workflow_binding') IS NOT NULL ok"))?.ok;if(!installed)return{required:false,platform_installed:false};
 const bindings=await q(t,`SELECT b.*,f.workflow_id FROM ty_workflow_binding b JOIN ty_form_definition f ON f.id=b.form_id WHERE b.group_id=$1 AND b.business_type=$2 AND(b.company_id IS NULL OR b.company_id=$3)AND(b.kind IS NULL OR b.kind=$4)AND b.status='active'AND b.valid_from<=now()AND(b.valid_to IS NULL OR now()<b.valid_to)ORDER BY b.company_id NULLS LAST,b.kind NULLS LAST,b.id DESC`,[groupId,subjectType,companyId||null,kind||null]);
 const b=bindings[0];return b?{required:true,platform_installed:true,binding_id:b.id,form_id:b.form_id,workflow_id:b.workflow_id}:{required:false,platform_installed:true};
}
export async function verifyApprovalReceipt(t,{userId,instanceId,subjectType,subjectId,sourceHash}){
 const inst=await one(t,'SELECT * FROM ty_workflow_instance WHERE id=$1',[id(instanceId)]);if(!inst)missing();
 await scope(t,userId,inst.group_id,inst.company_id,'execute',inst);
 if(inst.status!=='approved'||!inst.last_approver_id||await sameHuman(t,inst.last_approver_id,inst.applicant_id)||await humanIsPerson(t,inst.last_approver_id,inst.group_id,inst.person_id))deny('审批尚未完成有效的非本人复核');
 if(inst.subject_type!==subjectType||!same(inst.subject_id,subjectId)||inst.source_hash!==sourceHash)conflict('审批凭证与当前业务来源不一致');
 if(!['pending','applied'].includes(inst.business_state))conflict('业务执行已阻断，请核查来源');
 return{instance_id:inst.id,approved_by:inst.last_approver_id,original_requester_id:inst.applicant_id,execution_actor_id:userId,source_hash:inst.source_hash};
}
async function subjectFor(t,userId,f,input,values,operationId){
 if(f.business_type==='general')return{type:'general',id:null,hash:hash({form_id:f.id,values})};
 if(f.business_type==='leave_request')return(await import('./platform-leave.mjs')).submitLeaveSubject(t,{userId,input,values,form:f,operationId});
 if(f.business_type==='leave_lifecycle_proposal'){
  const p=await one(t,`SELECT p.*,r.group_id,r.person_id,a.relationship_id FROM ty_leave_lifecycle_proposal p JOIN ty_leave_account a ON a.id=p.account_id JOIN ty_leave_relationship r ON r.id=a.relationship_id WHERE p.id=$1`,[id(input.subject_id??values.proposal_id)]);if(!p||!same(p.group_id,f.group_id))missing();if(!same(p.created_by,userId))deny('只有原提案者可以提交该业务审批');if(p.status!=='pending')conflict('提案已处理');
  const companies=await q(t,'SELECT DISTINCT e.company_id FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=$1 ORDER BY e.company_id',[p.relationship_id]);if(!companies.length)bad('提案缺少可核对的实际公司关系');
  const sourceEmployment=p.payload?.employment_id?await one(t,'SELECT company_id FROM ty_employment WHERE id=$1 AND id IN(SELECT employment_id FROM ty_leave_relationship_employment WHERE relationship_id=$2)',[p.payload.employment_id,p.relationship_id]):null;
  const ownerCompany=sourceEmployment?.company_id||(companies.length===1?companies[0].company_id:null);
  if(ownerCompany&&input.company_id&&!same(input.company_id,ownerCompany))bad('表单公司与提案实际来源公司不符');
  if(!ownerCompany&&(f.company_id||input.company_id))bad('跨公司提案须使用集团统一表单及集团范围，不能任选一家公司的流程');
  for(const c of companies){const requirement=await approvalRequirement(t,{userId,subjectType:f.business_type,groupId:f.group_id,companyId:c.company_id,kind:p.kind});if(requirement.required&&!same(requirement.form_id,f.id))bad('实际关系公司存在不同审批绑定，请由集团统一核定，不能改选较弱流程');}
  return{type:f.business_type,id:p.id,hash:p.payload_hash,person_id:p.person_id,company_id:ownerCompany||null,group_scoped:!ownerCompany};
 }
 const adapter=await businessAdapter(t,f.business_type);if(adapter)return adapter.submit(t,{userId,input,values,form:f});
 bad('该业务执行适配器尚未接入；请使用普通表单，不能冒称业务已经生效');
}
export async function submitInstance(t,{userId,input,operationId}){
 const f=await definition(t,'form',input.form_id),operator=await currentOperator(t,userId),company=id(input.company_id===undefined?operator?.company_id:input.company_id,true);
 const nativeScope=await snapshotScopeAvailable(t);if(nativeScope)await groupFor(t,userId,f.group_id);else await requireAccess(t,userId,'workflow_self','submit',{group_id:f.group_id,company_id:company,person_id:operator?.person_id});
 return command(t,{userId,groupId:f.group_id,operation:'instance.submit',operationId,input,project:projectReceipt(t,userId),execute:async()=>{
  if(f.status!=='published')bad('只能使用已发布表单');if(f.company_id&&(!company||!same(f.company_id,company)))bad('表单不适用于当前公司');
  const w=await definition(t,'workflow',f.workflow_id);if(w.status!=='published')bad('流程版本已停用，请刷新可发表单');const parsed=validateValues(f.schema,input.values);if(!parsed.valid)bad(parsed.issues.join('；'));await validateRefs(t,f.schema,parsed.values,f.group_id,company,userId);
  if(!nativeScope)await requireAccess(t,userId,'workflow_self','submit',{group_id:f.group_id,company_id:company,person_id:operator?.person_id,fields:Object.keys(parsed.values)});
  const files=f.schema.fields.some(x=>x.type==='file'&&parsed.values[x.key]?.length)?await import('./portal-files.mjs'):null;if(files)await files.validateFormAttachments(t,{userId,form:f,values:parsed.values,companyId:company});
  const subject=await subjectFor(t,userId,f,input,parsed.values,operationId);
  if(nativeScope){const targetCompany=subject.group_scoped?null:subject.company_id||company,targetPerson=subject.person_id||operator?.person_id||null;await requireAccess(t,userId,'workflow_self','submit',{group_id:f.group_id,company_id:targetCompany,person_id:targetPerson,department_id:await subjectDepartment(t,{groupId:f.group_id,companyId:targetCompany,personId:targetPerson}),fields:Object.keys(parsed.values)});}
  const frozenValues={...parsed.values};for(const [key,value]of Object.entries(subject.authoritative_values||{}))if(Object.hasOwn(frozenValues,key))frozenValues[key]=value;if(subject.authoritative_quantity&&Object.hasOwn(frozenValues,'quantity'))frozenValues.quantity=subject.authoritative_quantity;
  const inst=await one(t,`INSERT INTO ty_workflow_instance(group_id,company_id,form_id,workflow_id,form_version,workflow_version,title,applicant_id,person_id,form_values,graph_snapshot,source_hash,subject_type,subject_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14)RETURNING *`,[f.group_id,subject.group_scoped?null:subject.company_id||company,f.id,w.id,f.version,w.version,text(subject.authoritative_title||input.title||f.name,'事项标题',1,200),userId,subject.person_id||operator?.person_id||null,JSON.stringify(frozenValues),JSON.stringify(w.graph),subject.hash,subject.type,subject.id]);
  if(nativeScope)await requireAccess(t,userId,'workflow_self','submit',{...inst,fields:Object.keys(parsed.values)});
  if(files)await files.bindFormAttachments(t,{userId,instance:inst,form:f,values:parsed.values,companyId:company});
  await log(t,inst,userId,'submitted',null);await advance(t,inst,w.graph.nodes.find(n=>n.type==='start').id,userId);return{instance:await projectInstance(t,userId,inst.id)};
 }});
}
export async function projectInstance(t,userId,instanceId,{fields:requestedFields=null}={}){
 const inst=await one(t,'SELECT i.*,f.schema FROM ty_workflow_instance i JOIN ty_form_definition f ON f.id=i.form_id WHERE i.id=$1',[id(instanceId)]);if(!inst)missing();const own=same(userId,inst.applicant_id),task=await one(t,'SELECT 1 FROM ty_workflow_task WHERE instance_id=$1 AND approver_id=$2',[inst.id,userId]),copy=await one(t,'SELECT 1 FROM ty_workflow_copy WHERE instance_id=$1 AND account_id=$2',[inst.id,userId]);
 const operator=await currentOperator(t,userId);if(operator?.profile_code==='config_admin')deny('系统配置不开放业务表单内容');
 if(!own&&!task&&!copy)await scope(t,userId,inst.group_id,inst.company_id,'read',inst);else await requireAccess(t,userId,'workflow_self','read',inst);
 const decision=await authorization(t,{userId,resource:task||copy||own?'workflow_self':'workflow_manage',action:'read',groupId:inst.group_id,companyId:inst.company_id,personId:inst.person_id,departmentId:inst.department_id}),keys=requestedFields?inst.schema.fields.map(f=>f.key).filter(k=>requestedFields.includes(k)):[...inst.schema.fields.map(f=>f.key),'title','approval_reason','actor_name'];let selected=[];for(const grant of decision.allowing_grants||[]){const allowed=keys.filter(k=>grantAllowsField(grant,k));if(allowed.length>selected.length)selected=allowed;}const allowedFields=inst.schema.fields.map(f=>f.key).filter(k=>selected.includes(k));
 const values=projectValues(inst.schema,inst.form_values,{restricted:true,allowedFields});
 const visible=inst.schema.fields.filter(f=>Object.hasOwn(values,f.key));
 const out={...inst,values,value_labels:Object.fromEntries(visible.map(f=>[f.key,f.label])),value_types:Object.fromEntries(visible.map(f=>[f.key,f.type])),node_label:inst.graph_snapshot.nodes.find(n=>n.id===inst.current_node)?.label||inst.current_node};
 if(!selected.includes('title'))out.title='审批事项';
 const reasonAllowed=selected.includes('approval_reason');
 const labels={submitted:'已提交','task.created':'已分配审批','task.approved':'审批通过','task.rejected':'审批驳回','task.transferred':'已转交',approved:'审批完成',blocked:'待核处理',cancelled:'申请已撤回','business.executed':'业务已办理','business.blocked':'业务办理已阻断'};
 out.logs=(await q(t,'SELECT l.id,l.node_id,l.action,l.created_at,l.metadata,a.display_name actor_name FROM ty_workflow_log l JOIN sys_account a ON a.id=l.actor_id WHERE l.instance_id=$1 ORDER BY l.id',[inst.id])).map(l=>({id:l.id,node_id:l.node_id,node_label:inst.graph_snapshot.nodes.find(n=>n.id===l.node_id)?.label||l.node_id,action:l.action,label:labels[l.action]||'处理记录',created_at:l.created_at,...(selected.includes('actor_name')?{actor_name:l.actor_name}:{}),...(reasonAllowed&&l.metadata?.reason?{reason:l.metadata.reason}:{})}));
 delete out.form_values;delete out.graph_snapshot;delete out.schema;const adapter=await businessAdapter(t,inst.subject_type);return adapter?adapter.project(t,{userId,instance:out}):out;
}
async function taskFor(t,userId,key){const task=await one(t,'SELECT * FROM ty_workflow_task WHERE id=$1',[id(key)]);if(!task)missing();const inst=await one(t,'SELECT * FROM ty_workflow_instance WHERE id=$1 FOR UPDATE',[task.instance_id]);if(!same(task.approver_id,userId))deny('该任务未分配给当前人员');await requireAccess(t,userId,'workflow_self','approve',inst);if(await sameHuman(t,inst.applicant_id,userId)||await humanIsPerson(t,userId,inst.group_id,inst.person_id))deny('申请人不能审批本人事项');return{task,inst};}
export async function decideInstance(t,{userId,input,operationId}){
 const{task,inst}=await taskFor(t,userId,input.task_id);
 return command(t,{userId,groupId:inst.group_id,operation:'instance.decide',operationId,input,project:projectReceipt(t,userId),execute:async()=>{
  revision(task,input.expected_revision);if(task.status!=='pending'||inst.status!=='running'||task.node_id!==inst.current_node)conflict('审批任务已变化');if(typeof input.approve!=='boolean')bad('请选择批准或驳回');const reason=text(input.reason,'审批意见',2);
  await assertDomainApproval(t,{userId,instance:inst,currentRoster:input.approve});
  await t.query('UPDATE ty_workflow_task SET status=$2,reason=$3,acted_at=now(),revision=revision+1 WHERE id=$1',[task.id,input.approve?'approved':'rejected',reason]);await log(t,inst,userId,input.approve?'task.approved':'task.rejected',task.node_id,{reason});
  if(!input.approve){await t.query("UPDATE ty_workflow_instance SET status='rejected',finished_at=now(),revision=revision+1,last_approver_id=$2 WHERE id=$1",[inst.id,userId]);await t.query("UPDATE ty_workflow_task SET status='cancelled',revision=revision+1 WHERE instance_id=$1 AND status='pending'",[inst.id]);
   if(inst.subject_type==='leave_request')await(await import('./platform-leave.mjs')).rejectLeaveSubject(t,{userId,instance:inst});
   else if(inst.subject_type==='leave_lifecycle_proposal')await(await import('./leave-lifecycle.mjs')).rejectWorkflowProposal(t,{userId,id:inst.subject_id,instanceId:inst.id});
   else{const a=await businessAdapter(t,inst.subject_type);if(a)await a.reject(t,{userId,instance:inst});}
   await notifyWorkflowResult(t,{instance:inst,outcome:'rejected',projectInstance});await emit(t,inst.group_id,`workflow:${inst.id}:rejected`,'workflow.rejected',{instance_id:inst.id});}
  else{
   await t.query('UPDATE ty_workflow_instance SET last_approver_id=$2,revision=revision+1 WHERE id=$1',[inst.id,userId]);
   const pending=await one(t,"SELECT count(*) n FROM ty_workflow_task WHERE instance_id=$1 AND node_id=$2 AND status='pending'",[inst.id,task.node_id]);
   if(task.mode==='any'||Number(pending.n)===0){await t.query("UPDATE ty_workflow_task SET status='skipped',revision=revision+1 WHERE instance_id=$1 AND node_id=$2 AND status='pending'",[inst.id,task.node_id]);const n=inst.graph_snapshot.nodes.find(n=>n.id===task.node_id);await advance(t,inst,nextNode(n,inst.form_values),userId);}
  }return{instance:await projectInstance(t,userId,inst.id)};
 }});
}
export async function transferTask(t,{userId,input,operationId}){
 const{task,inst}=await taskFor(t,userId,input.task_id);
 return command(t,{userId,groupId:inst.group_id,operation:'instance.transfer',operationId,input,project:projectReceipt(t,userId),execute:async()=>{
  revision(task,input.expected_revision);if(task.status!=='pending'||inst.status!=='running')conflict('任务已变化');const target=id(input.to_account_id);if(await sameHuman(t,target,userId)||await sameHuman(t,target,inst.applicant_id))bad('不能转交给本人或申请人');const eligible=await resolveApprovers(t,inst,{approver_ids:[target]});if(!eligible.includes(target))deny('接收人不具备当前公司审批权限');const reason=text(input.reason,'转交原因',4);
  await t.query("UPDATE ty_workflow_task SET status='transferred',reason=$2,acted_at=now(),revision=revision+1 WHERE id=$1",[task.id,reason]);const prior=await one(t,'SELECT * FROM ty_workflow_task WHERE instance_id=$1 AND node_id=$2 AND approver_id=$3',[inst.id,task.node_id,target]);if(prior)conflict('目标人员已参与该节点，请刷新任务');await t.query('INSERT INTO ty_workflow_task(instance_id,node_id,approver_id,mode)VALUES($1,$2,$3,$4)',[inst.id,task.node_id,target,task.mode]);await t.query('UPDATE ty_workflow_instance SET revision=revision+1 WHERE id=$1',[inst.id]);await log(t,inst,userId,'task.transferred',task.node_id,{to_account_id:target,reason});return{instance:await projectInstance(t,userId,inst.id)};
 }});
}
export async function delegateTasks(t,{userId,input,operationId}){
 const g=await groupFor(t,userId,input.group_id),operator=await currentOperator(t,userId);await requireAccess(t,userId,'workflow_self','approve',{group_id:g.id,company_id:operator.company_id});
 return command(t,{userId,groupId:g.id,operation:'instance.delegate',operationId,input,execute:async()=>{
  const target=id(input.to_account_id),from=new Date(input.valid_from),to=new Date(input.valid_to);if(await sameHuman(t,target,userId)||!Number.isFinite(+from)||!Number.isFinite(+to)||to<=from||+to-+from>90*86400000)bad('代理人员及不超过90天的明确有效期必填');const options=await optionsFor(t,userId,g.id,operator.company_id);if(!options.some(r=>same(r.id,target)))deny('代理人员不在可选范围');const reason=text(input.reason,'委托原因',4);if(await one(t,"SELECT 1 FROM ty_workflow_delegate WHERE group_id=$1 AND from_account_id=$2 AND status='active' AND tstzrange(valid_from,valid_to,'[)')&&tstzrange($3,$4,'[)')",[g.id,userId,from,to]))conflict('已有重叠有效代理');const d=await one(t,'INSERT INTO ty_workflow_delegate(group_id,from_account_id,to_account_id,valid_from,valid_to,reason)VALUES($1,$2,$3,$4,$5,$6)RETURNING *',[g.id,userId,target,from,to,reason]);await audit(t,userId,g.id,'instance.delegate','delegate',d.id,{to_account_id:target,valid_from:from,valid_to:to});return{delegation:d};
 }});
}
export async function executeInstance(t,{userId,input,operationId}){
 const inst=await one(t,'SELECT * FROM ty_workflow_instance WHERE id=$1',[id(input.instance_id)]);if(!inst)missing();if((await currentOperator(t,userId))?.profile_code==='config_admin')deny('配置岗位不执行业务表单');await scope(t,userId,inst.group_id,inst.company_id,'execute',inst);
 return command(t,{userId,groupId:inst.group_id,operation:'instance.execute',operationId,input,project:projectReceipt(t,userId),execute:async()=>{
  const current=await one(t,'SELECT * FROM ty_workflow_instance WHERE id=$1 FOR UPDATE',[inst.id]);revision(current,input.expected_revision);if(current.status!=='approved')conflict('审批完成后才可执行');if(current.business_state==='applied'||current.business_state==='not_applicable')return{instance:await projectInstance(t,userId,inst.id),already_applied:true};
  let result;if(current.subject_type==='leave_lifecycle_proposal'){const lifecycle=await import('./leave-lifecycle.mjs');result=await lifecycle.executeApprovedProposal(t,{userId,id:current.subject_id,approvalReceiptId:current.id});}
  else if(current.subject_type==='leave_request'){result=await(await import('./platform-leave.mjs')).executeApprovedLeave(t,{userId,id:current.subject_id,approvalReceiptId:current.id});}
  else if(current.subject_type==='general'){if(!current.last_approver_id)deny('未经过实际审批节点');await t.query("UPDATE ty_workflow_instance SET business_state='not_applicable',revision=revision+1 WHERE id=$1",[inst.id]);result={business_receipt_only:true};}
  else{const a=await businessAdapter(t,current.subject_type);if(!a)bad('该业务执行器尚未安装');if(input.business_input!==undefined&&current.subject_type!=='personal_service')bad('此业务不接收额外交接参数');result=await a.execute(t,{userId,instance:current,executionInput:input.business_input??{}});}const blocked=!!(result?.blocked||result?.source_changed);await log(t,inst,userId,blocked?'business.blocked':'business.executed',null,{subject_type:current.subject_type,subject_id:current.subject_id});return{instance:await projectInstance(t,userId,inst.id),result:{domain_receipt:true,subject_type:current.subject_type,subject_id:current.subject_id,external_payment_created:false,...(blocked?{blocked:true,business_applied:false,source_changed:!!result?.source_changed}:{})}};
 }});
}
export async function cancelInstance(t,{userId,input,operationId}){
 const inst=await one(t,'SELECT * FROM ty_workflow_instance WHERE id=$1',[id(input.instance_id)]);if(!inst)missing();if(!await sameHuman(t,inst.applicant_id,userId))deny('只能撤回本人提交的申请');await requireAccess(t,userId,'workflow_self','cancel',inst);
 return command(t,{userId,groupId:inst.group_id,operation:'instance.cancel',operationId,input,project:projectReceipt(t,userId),execute:async()=>{
  const current=await one(t,'SELECT * FROM ty_workflow_instance WHERE id=$1 FOR UPDATE',[inst.id]);revision(current,input.expected_revision);if(!['running','blocked'].includes(current.status))conflict('只能撤回在办或阻断申请，已完成事项请走业务更正');const reason=text(input.reason,'撤回原因',4);
  if(current.subject_type==='leave_request'){
   const source=await(await import('./platform-leave.mjs')).leaveRequestSource(t,current.subject_id);if(source.source_hash!==current.source_hash)conflict('业务来源已变，请先核对');await(await import('./advanced-leave.mjs')).cancelRequest(t,{userId,id:current.subject_id,reason});
  }else if(current.subject_type==='leave_lifecycle_proposal')await(await import('./leave-lifecycle.mjs')).cancelProposal(t,{userId,id:current.subject_id,reason});
  else{const a=await businessAdapter(t,current.subject_type);if(a)await a.cancel(t,{userId,instance:current,reason});}
  await t.query("UPDATE ty_workflow_task SET status='cancelled',revision=revision+1 WHERE instance_id=$1 AND status='pending'",[current.id]);
  await t.query("UPDATE ty_workflow_instance SET status='cancelled',business_state='not_applicable',finished_at=now(),revision=revision+1 WHERE id=$1",[current.id]);await notifyWorkflowResult(t,{instance:current,outcome:'cancelled',projectInstance});await log(t,current,userId,'cancelled',current.current_node,{reason});await emit(t,current.group_id,`workflow:${current.id}:cancelled`,'workflow.cancelled',{instance_id:current.id});return{instance:await projectInstance(t,userId,current.id)};
 }});
}
