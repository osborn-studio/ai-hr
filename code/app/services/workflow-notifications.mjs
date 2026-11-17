import{q,id,same,list,bad,currentOperator,authorization}from'./platform-core.mjs';

// Notification membership never grants approval or business access. A copy is
// retained only after its current full projection succeeds in this transaction.
export async function notificationCandidates(t,{instance,node}){
 const explicit=list(node.recipient_ids??node.approver_ids??[]).map(x=>id(x)),roles=list(node.recipient_role_codes??node.role_codes??[]);
 if(roles.some(x=>typeof x!=='string'||!x.trim()))bad('抄送角色编码无效');
 if(node.include_applicant!==undefined&&typeof node.include_applicant!=='boolean')bad('是否通知申请人须明确选择');
 const members=roles.length?await q(t,`SELECT DISTINCT m.account_id FROM ty_auth_membership m JOIN ty_auth_role r ON r.id=m.role_id WHERE m.group_id=$1 AND r.code=ANY($2::text[])AND r.status='active'AND m.status='active'AND m.valid_from<=now()AND(m.valid_to IS NULL OR now()<m.valid_to)`,[instance.group_id,roles]):[];
 const ids=[...new Set([...explicit,...members.map(x=>x.account_id),...(node.include_applicant?[instance.applicant_id]:[])].map(String))],result=[];
 for(const actor of ids){
  const op=await currentOperator(t,actor);if(!op||op.status!=='active'||!same(op.group_id,instance.group_id)||op.profile_code==='config_admin')continue;
  const decision=await authorization(t,{userId:actor,resource:'workflow_self',action:'read',groupId:instance.group_id,companyId:instance.company_id,personId:instance.person_id,departmentId:instance.department_id});
  if(decision.allowed)result.push(actor);
 }
 return result;
}
export async function retainNotificationCopies(t,{instance,node,projectInstance}){
 const candidates=await notificationCandidates(t,{instance,node}),retained=[];
 for(const actor of candidates){
  await t.query('SAVEPOINT workflow_notification_candidate');
  try{
   await t.query('INSERT INTO ty_workflow_copy(instance_id,account_id,node_id)VALUES($1,$2,$3)ON CONFLICT DO NOTHING',[instance.id,actor,node.id]);
   await projectInstance(t,actor,instance.id);
   await t.query('RELEASE SAVEPOINT workflow_notification_candidate');retained.push(actor);
  }catch(error){
   await t.query('ROLLBACK TO SAVEPOINT workflow_notification_candidate');await t.query('RELEASE SAVEPOINT workflow_notification_candidate');
   if(!['E_TY_FORBIDDEN','E_TY_NOT_FOUND'].includes(error.code)&&!/^E_TY_(FORBIDDEN|NOT_FOUND):/.test(error.message))throw error;
  }
 }
 return retained;
}
export async function notifyWorkflowResult(t,{instance,outcome,projectInstance}){
 if(instance.graph_snapshot?.notification_policy?.applicant_on_result!==true)return[];
 return retainNotificationCopies(t,{instance,node:{id:'sys.result.'+outcome,include_applicant:true},projectInstance});
}
