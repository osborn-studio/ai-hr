import{subjectDepartment}from'./workflow-scope.mjs';
import{q,one,same,bad,deny,id,groupFor,requireAccess,authorization,currentOperator,visibleOperators,paging,search}from'./platform-core.mjs';
import * as authz from './platform-authz.mjs';
import * as flow from './platform-workflow.mjs';
import{resourceFields}from'./resource-fields.mjs';

const LABELS={read:'查看',write:'维护',create:'新增',update:'修改',delete:'删除',submit:'提交',cancel:'撤销',approve:'审批',publish:'发布',execute:'执行',export:'导出',manage:'管理',design:'设计',simulate:'模拟',reset_password:'重置口令',sync:'同步'};
export async function commonWorkspace(t,userId,input){
 const g=await groupFor(t,userId,input.group_id),operator=await currentOperator(t,userId);const companies=[];
 for(const c of await q(t,'SELECT id,group_id,ledger_id,name,parent_company_id,org_level FROM ty_company WHERE group_id=$1 ORDER BY id',[g.id]))if(g.access.row({...c,company_id:c.id}))companies.push(c);
 const scope={groupId:g.id,companyId:input.company_id||operator.company_id||null,personId:operator.person_id};scope.departmentId=await subjectDepartment(t,scope);
 const can=async(resource,action)=>(await authorization(t,{userId,resource,action,...scope})).allowed;
 const config=await can('system_configuration','write'),design=await can('workflow_manage','write'),publish=await can('workflow_manage','publish'),readDesign=await can('workflow_manage','read');
 const capabilities={can_manage_operators:config,can_manage_roles:config,can_manage_grants:config,can_design_forms:design,can_publish_forms:publish,can_design_workflows:design,can_publish_workflows:publish,can_manage_integrations:await can('integration_manage','write'),can_submit:await can('workflow_self','submit'),can_approve:await can('workflow_self','approve'),can_execute:operator.profile_code!=='config_admin'&&await can('workflow_manage','execute'),can_simulate:config,can_pick_approvers:readDesign};
 let resources=[];if(config)resources=await q(t,'SELECT resource_code code,label FROM sys_perm_resource ORDER BY label,resource_code');
 capabilities.can_request_transfer=!!operator.person_id&&operator.profile_code!=='config_admin'&&(await one(t,"SELECT to_regclass('public.ty_portal_read')IS NOT NULL ok")).ok&&capabilities.can_submit;
 capabilities.can_request_service=capabilities.can_request_transfer&&(await one(t,"SELECT to_regclass('public.ty_personal_service_request')IS NOT NULL ok")).ok;
 capabilities.can_upload_attachments=operator.profile_code!=='config_admin'&&(await one(t,"SELECT to_regclass('public.ty_pf_attachment')IS NOT NULL ok")).ok&&capabilities.can_submit;
 const catalogue=await resourceFields(t,g.id);
 return{group_id:g.id,current_operator:operator,companies,resource_catalogue:resources.map(r=>({...r,actions:authz.ACTIONS.map(code=>({code,label:LABELS[code]})),fields:catalogue.byResource[r.code]||catalogue.defaultFields})),fields_catalogue:catalogue.all,capabilities,as_of:new Date().toISOString(),unavailable_modules:[]};
}
async function designRows(t,userId,table,group,company){const out=[];for(const r of await q(t,`SELECT * FROM ${table} WHERE group_id=$1 ORDER BY code,version DESC`,[group])){if(company&&r.company_id&&!same(company,r.company_id))continue;if((await authorization(t,{userId,resource:'workflow_manage',action:'read',groupId:group,companyId:r.company_id||company})).allowed)out.push(r);}return out;}
async function availableForms(t,userId,group,company,businessType=null){const out=[],operator=await currentOperator(t,userId);for(const f of await q(t,"SELECT f.* FROM ty_form_definition f JOIN ty_workflow_definition w ON w.id=f.workflow_id WHERE f.group_id=$1 AND f.status='published'AND w.status='published' ORDER BY f.name,f.version DESC",[group])){if(businessType&&f.business_type!==businessType)continue;if(f.company_id&&!same(f.company_id,company))continue;if((await authorization(t,{userId,resource:'workflow_self',action:'submit',groupId:group,companyId:company,personId:operator?.person_id})).allowed)out.push(f);}return out;}
async function instances(t,userId,group,{own=false,company=null}={}){const out=[],companyIds=company?await(await import('./foundation.mjs')).companyDescendants(t,company):null;for(const r of await q(t,'SELECT id,company_id FROM ty_workflow_instance WHERE group_id=$1 AND($2::bigint IS NULL OR applicant_id=$2)ORDER BY id DESC',[group,own?userId:null])){if(companyIds&&!companyIds.includes(String(r.company_id)))continue;try{out.push(await flow.projectInstance(t,userId,r.id));}catch(e){if(!['E_TY_FORBIDDEN','E_TY_NOT_FOUND'].includes(e.code))throw e;}}return out;}
async function tasks(t,userId,group,company,canExecute){const out=[],companyIds=company?await(await import('./foundation.mjs')).companyDescendants(t,company):null,operator=await currentOperator(t,userId);
 const rows=await q(t,`SELECT k.*,i.group_id,i.company_id,i.person_id,(to_jsonb(i)->>'department_id')::bigint department_id,i.title,i.status instance_status,i.business_state,i.revision instance_revision,a.display_name applicant_name FROM ty_workflow_task k JOIN ty_workflow_instance i ON i.id=k.instance_id JOIN sys_account a ON a.id=i.applicant_id WHERE i.group_id=$1 AND k.approver_id=$2 ORDER BY k.id DESC`,[group,userId]);
 for(const r of rows){if(companyIds&&!companyIds.includes(String(r.company_id)))continue;if(!(await authorization(t,{userId,resource:'workflow_self',action:'read',groupId:group,companyId:r.company_id,personId:r.person_id,departmentId:r.department_id})).allowed)continue;
  const permitted=(await authorization(t,{userId,resource:'workflow_self',action:'approve',groupId:group,companyId:r.company_id,personId:r.person_id,departmentId:r.department_id})).allowed;
  if(!(await authorization(t,{userId,resource:'workflow_self',action:'read',groupId:group,companyId:r.company_id,personId:r.person_id,departmentId:r.department_id,fields:['title']})).allowed)r.title='审批事项';
  if(!(await authorization(t,{userId,resource:'workflow_self',action:'read',groupId:group,companyId:r.company_id,personId:r.person_id,departmentId:r.department_id,fields:['applicant_name']})).allowed)delete r.applicant_name;
  const actions=r.status==='pending'&&r.instance_status==='running'&&permitted?[{code:'approve',label:'批准'},{code:'reject',label:'驳回'},{code:'transfer',label:'转交'}]:[];
  if(operator.profile_code!=='config_admin'&&r.instance_status==='approved'&&r.business_state==='pending'&&(await authorization(t,{userId,resource:'workflow_manage',action:'execute',groupId:group,companyId:r.company_id,personId:r.person_id,departmentId:r.department_id})).allowed)actions.push({code:'execute',label:'执行业务'});out.push({...r,actions});
 }return out;
}
export async function queryWorkspace(t,{userId,input}){
 const base=await commonWorkspace(t,userId,input),g=base.group_id,company=input.company_id||base.current_operator.company_id||null,kind=input.kind||'portal';let rows=[],alias;
 if(kind==='integrations'){const integration=await import('./platform-integration.mjs');const result=await integration.queryIntegrationWorkspace(t,{userId,input:{...input,group_id:g}});return{...base,...result,capabilities:{...base.capabilities,...result.capabilities}};}
 if(kind==='permissions'){
  const view=input.view||'operators';if(view==='options'){
   if(!base.capabilities.can_pick_approvers&&!base.capabilities.can_manage_operators)deny('没有审批候选目录权限');rows=await visibleOperators(t,userId,g,{options:true,companyId:company});alias='operators';base.role_options=await q(t,"SELECT code,name FROM ty_auth_role WHERE group_id=$1 AND status='active'ORDER BY name",[g]);
  }else{
   await requireAccess(t,userId,'system_configuration','read',{group_id:g,company_id:company});
   if(view==='operators'){rows=await visibleOperators(t,userId,g,{companyId:company});alias='operators';}
   else if(view==='roles'){rows=await q(t,'SELECT * FROM ty_auth_role WHERE group_id=$1 ORDER BY name',[g]);alias='roles';}
   else if(view==='memberships'){rows=await q(t,`SELECT m.*,r.name role_name,a.display_name account_name FROM ty_auth_membership m JOIN ty_auth_role r ON r.id=m.role_id JOIN sys_account a ON a.id=m.account_id WHERE m.group_id=$1 AND($2::bigint IS NULL OR m.company_id IS NULL OR m.company_id=$2)ORDER BY m.id DESC`,[g,company]);alias='memberships';}
   else if(view==='grants'){rows=await q(t,'SELECT * FROM ty_auth_grant WHERE group_id=$1 AND($2::bigint IS NULL OR company_id IS NULL OR company_id=$2)ORDER BY id DESC',[g,company]);alias='grants';}
   else bad('权限工作区视图无效');
  }
 }else if(kind==='forms'){
  await requireAccess(t,userId,'workflow_manage','read',{group_id:g,company_id:company});rows=await designRows(t,userId,'ty_form_definition',g,company);alias='forms';
  base.workflows=(await designRows(t,userId,'ty_workflow_definition',g,company)).filter(r=>r.status==='published');
 }else if(kind==='workflows'){
  await requireAccess(t,userId,'workflow_manage','read',{group_id:g,company_id:company});const view=input.view||'definitions';
  if(view==='definitions'){rows=await designRows(t,userId,'ty_workflow_definition',g,company);alias='workflows';}
  else if(view==='instances'){rows=base.current_operator.profile_code==='config_admin'?[]:await instances(t,userId,g,{company});alias='instances';}
  else if(view==='forms'){rows=await availableForms(t,userId,g,company,input.business_type||null);alias='forms';}
  else if(view==='tasks'){rows=await tasks(t,userId,g,company,base.capabilities.can_execute);alias='tasks';}else bad('流程工作区视图无效');
 }else if(kind==='portal'){
  const portalScoped=(await one(t,"SELECT to_regclass('public.ty_portal_read')IS NOT NULL ok")).ok;if(!portalScoped)await requireAccess(t,userId,'workflow_self','read',{group_id:g,company_id:company,person_id:base.current_operator.person_id});const view=input.view||'tasks';
  if(view==='detail'){
   const detail=await flow.projectInstance(t,userId,id(input.id));if(!same(detail.group_id,g))deny('事项不属于当前集团');rows=[detail];alias='instances';
   base.logs=detail.logs;
  }
  else if(view==='forms'){rows=await availableForms(t,userId,g,company,input.business_type||null);alias='forms';}
  else if(view==='tasks'){rows=await tasks(t,userId,g,company,base.capabilities.can_execute);alias='tasks';}
  else if(view==='requests'){rows=await instances(t,userId,g,{own:true,company});alias='instances';}
  else if(view==='alerts'&&(await one(t,"SELECT to_regclass('public.ty_portal_read')IS NOT NULL ok")).ok){const alerts=await(await import('./portal-notices.mjs')).listNotices(t,{userId,input:{group_id:g,company_id:company}});rows=alerts.rows;base.unavailable_notice_domains=alerts.unavailable_domains;alias='alerts';}
  else if(view==='alerts'){for(const c of await q(t,'SELECT c.instance_id,c.seen_at FROM ty_workflow_copy c JOIN ty_workflow_instance i ON i.id=c.instance_id WHERE c.account_id=$1 AND i.group_id=$2 ORDER BY i.id DESC',[userId,g])){try{const i=await flow.projectInstance(t,userId,c.instance_id);if(company&&!same(company,i.company_id))continue;rows.push({id:i.id,title:i.title,channel:'站内抄送',issued_state:'recorded',read_state:c.seen_at?'read':'unread',business_status:i.status,seen_at:c.seen_at});}catch(e){if(!['E_TY_FORBIDDEN','E_TY_NOT_FOUND'].includes(e.code))throw e;}}alias='alerts';}else bad('个人门户视图无效');
  base.forms=await availableForms(t,userId,g,company,input.business_type||null);
 }else bad('工作区类型无效');
 rows=search(rows,input.q,['name','title','display_name','login','code','resource','account_name','role_name']);if(input.id)rows=rows.filter(r=>same(r.id,input.id));const result=paging(rows,input);return{...base,...result,[alias]:result.rows};
}
const COMMANDS={
 'operator.create':authz.createOperator,'operator.update':authz.updateOperator,'operator.reset_password':authz.resetPassword,
 'role.save':authz.saveRole,'role.assign':authz.assignRole,'role.revoke_member':authz.revokeMember,'grant.save':authz.saveGrant,'grant.revoke':authz.revokeGrant,
 'instance.submit':flow.submitInstance,'instance.decide':flow.decideInstance,'instance.transfer':flow.transferTask,'instance.delegate':flow.delegateTasks,'instance.execute':flow.executeInstance,'instance.cancel':flow.cancelInstance,
};
export async function dispatchCommand(t,{userId,input,operationId,operation}){const name=operation.replace(/^system\./,'');if(name.startsWith('integration.'))return(await import('./platform-integration.mjs')).dispatchIntegrationCommand(t,{userId,input,operationId,operation:name});
 if(['form.save','workflow.save','form.publish','workflow.publish'].includes(name))return(name.endsWith('.save')?flow.saveDefinition:flow.publishDefinition)(t,{userId,input,operationId,kind:name.split('.')[0]});
 const fn=COMMANDS[name];if(!fn)bad('平台动作未登记');return fn(t,{userId,input,operationId});
}
export async function operationStatus(t,{userId,input}){
 if(typeof input.operationId!=='string'||input.operationId.length<8)bad('原操作编号必填');const operation=input.operation?.replace(/^system\./,'');const rows=await q(t,'SELECT * FROM ty_platform_command WHERE actor_id=$1 AND operation_key=$2 AND($3::text IS NULL OR operation=$3)',[userId,input.operationId,operation||null]);
 const receipts=[];for(const r of rows){const resource=r.operation.startsWith('integration.')?'integration_manage':/^(operator|role|grant)\./.test(r.operation)?'system_configuration':r.operation.startsWith('instance.')&&r.operation!=='instance.execute'?'workflow_self':'workflow_manage';
  let target=r.result.connection||r.result.instance||r.result.grant||r.result.membership||r.result.operator||r.result.workflow||r.result.form||{};
  if(r.operation.startsWith('integration.')){const connectionId=target.id||r.result.connection_id||r.result.mapping?.connection_id||r.result.job?.connection_id;if(connectionId)target=await one(t,'SELECT company_id FROM ty_integration_connection WHERE id=$1 AND group_id=$2',[connectionId,r.group_id])||{};}
  await requireAccess(t,userId,resource,'read',{group_id:r.group_id,company_id:target.company_id,person_id:target.person_id});receipts.push({operation:r.operation,completed_at:r.created_at});}
 // Status intentionally does not rehydrate an old business response or secret.
 // A missing receipt cannot prove a remote command was never executed.
 return{state:receipts.length?'completed':'not_found',completed:receipts.length>0,operation_id:input.operationId,result:{receipts,credential_available:false},not_found_is_execution_proof:false};
}
export const simulateAuthorization=authz.simulate;
export const previewWorkflow=flow.previewWorkflow;
