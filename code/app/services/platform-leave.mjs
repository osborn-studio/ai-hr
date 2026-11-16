import{sameHuman,humanIsPerson}from'./human-identity.mjs';
import{one,same,bad,deny,conflict,id,hash,requireAccess}from'./platform-core.mjs';
import{accountContext,submitRequest}from'./advanced-leave.mjs';

export async function leaveRequestSource(t,requestId){
 const row=await one(t,`SELECT r.*,a.relationship_id,l.group_id,l.person_id,e.company_id,
 jsonb_build_object('id',r.id::text,'account_id',r.account_id::text,'employment_id',r.employment_id::text,'scheme_id',r.scheme_id::text,'starts_at',r.starts_at AT TIME ZONE 'UTC','ends_at',r.ends_at AT TIME ZONE 'UTC','quantity',r.quantity::text,'facts',r.facts,'created_by',r.created_by::text)frozen
 FROM ty_leave_request r JOIN ty_leave_account a ON a.id=r.account_id JOIN ty_leave_relationship l ON l.id=a.relationship_id JOIN ty_employment e ON e.id=r.employment_id WHERE r.id=$1`,[id(requestId)]);if(!row)bad('请假来源不存在');const {frozen,group_id,person_id,company_id,relationship_id,...request}=row;
 return{request,group_id,person_id,company_id,relationship_id,source_hash:hash(frozen)};
}
export async function submitLeaveSubject(t,{userId,input,values,form,operationId}){
 if(input.subject_id||values.request_id){
  const source=await leaveRequestSource(t,input.subject_id||values.request_id);if(!same(source.group_id,form.group_id)||!same(source.request.created_by,userId))deny('只能将本人经办的原请假单转入审批');if(source.request.status!=='pending')conflict('原请假单已处理');
  await accountContext(t,{userId,accountId:source.request.account_id,resource:'advanced_leave_manage',write:true,selfAllowed:true,action:'submit',fields:['quantity','facts']});
  await ensureFormBinding(t,userId,form,input,source);
  const r=source.request;return{type:'leave_request',id:r.id,hash:source.source_hash,person_id:source.person_id,company_id:source.company_id,authoritative_quantity:String(r.quantity),authoritative_values:{request_id:String(r.id),account_id:String(r.account_id),employment_id:String(r.employment_id),scheme_id:String(r.scheme_id),quantity:String(r.quantity),starts_at:new Date(r.starts_at).toISOString(),ends_at:new Date(r.ends_at).toISOString()}};
 }
 const employment=await one(t,'SELECT * FROM ty_employment WHERE id=$1',[id(values.employment_id)]);if(!employment||!same(employment.group_id,form.group_id))bad('请假公司与集团不符');if(input.company_id&&!same(input.company_id,employment.company_id))bad('当前公司与请假实际任职公司不符');
 const result=await submitRequest(t,{userId,input:{account_id:values.account_id,employment_id:values.employment_id,scheme_id:values.scheme_id,starts_at:values.starts_at,ends_at:values.ends_at,request_key:`workflow:${operationId}`,...(values.quantity!==undefined&&values.quantity!==''?{quantity:values.quantity}:{})}});
 const source=await leaveRequestSource(t,result.request.id);await ensureFormBinding(t,userId,form,input,source);return{type:'leave_request',id:source.request.id,hash:source.source_hash,person_id:source.person_id,company_id:source.company_id,authoritative_quantity:String(source.request.quantity)};
}
async function ensureFormBinding(t,userId,form,input,source){if(input.company_id&&!same(input.company_id,source.company_id)||form.company_id&&!same(form.company_id,source.company_id))bad('所选表单公司不属于请假实际来源');const scheme=await one(t,'SELECT code FROM ty_leave_scheme WHERE id=$1',[source.request.scheme_id]);const requirement=await(await import('./platform-workflow.mjs')).approvalRequirement(t,{userId,subjectType:'leave_request',groupId:source.group_id,companyId:source.company_id,kind:scheme.code});if(requirement.required&&!same(requirement.form_id,form.id))bad('须使用当前有效审批绑定的表单，不能改选较弱流程');}
export async function executeApprovedLeave(t,{userId,id:requestId,approvalReceiptId}){
 const first=await leaveRequestSource(t,requestId);
 // The current actor needs domain execution rights; a past approver is never
 // impersonated to bypass session or self-approval checks.
 await accountContext(t,{userId,accountId:first.request.account_id,resource:'advanced_leave_approve',write:true});
 await requireAccess(t,userId,'advanced_leave_approve','execute',{group_id:first.group_id,company_id:first.company_id,person_id:first.person_id,fields:['status','approved_by']});
 const request=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1 FOR UPDATE',[first.request.id]);
 const source=await leaveRequestSource(t,request.id);
 const{verifyApprovalReceipt}=await import('./platform-workflow.mjs');const receipt=await verifyApprovalReceipt(t,{userId,instanceId:approvalReceiptId,subjectType:'leave_request',subjectId:String(request.id),sourceHash:source.source_hash});
 if(!same(receipt.original_requester_id,request.created_by)||await sameHuman(t,receipt.approved_by,request.created_by)||await humanIsPerson(t,receipt.approved_by,source.group_id,source.person_id)||!same(receipt.execution_actor_id,userId))deny('请假审批的申请人、批准人或实际执行人不符');
 if(request.status==='approved'){
  const existing=await one(t,"SELECT 1 FROM ty_workflow_instance WHERE id=$1 AND business_state='applied'",[receipt.instance_id]);if(!existing||!same(request.approved_by,receipt.approved_by))conflict('请假已由其他路径处理');return{request,replayed:true};
 }
 if(request.status!=='pending')conflict('请假来源已变化，审批不能覆盖已取消或已处理的记录');
 await t.query("UPDATE ty_leave_allocation SET state='allocated'WHERE request_id=$1 AND state='held'",[request.id]);
 const updated=await one(t,"UPDATE ty_leave_request SET status='approved',approved_by=$2 WHERE id=$1 RETURNING *",[request.id,receipt.approved_by]);
 await t.query("UPDATE ty_workflow_instance SET business_state='applied',revision=revision+1 WHERE id=$1",[receipt.instance_id]);
 const{emit,audit}=await import('./platform-core.mjs');await emit(t,source.group_id,`leave-request:${request.id}:workflow-approved`,'leave.approval.decided',{request_id:request.id,workflow_instance_id:receipt.instance_id,approved_by:receipt.approved_by,execution_actor_id:userId,allocated_is_taken:false});
 await audit(t,userId,source.group_id,'leave.request.workflow.execute','leave_request',request.id,{workflow_instance_id:receipt.instance_id,approved_by:receipt.approved_by});
 return{request:updated,actual_taken:false,approved_by:receipt.approved_by,execution_actor_id:userId};
}
export async function rejectLeaveSubject(t,{userId,instance}){
 const first=await leaveRequestSource(t,instance.subject_id);
 await accountContext(t,{userId,accountId:first.request.account_id,resource:'advanced_leave_approve',write:true,action:'approve',fields:['status','approved_by']});
 const current=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1 FOR UPDATE',[first.request.id]);const source=await leaveRequestSource(t,current.id);
 const task=await one(t,"SELECT 1 FROM ty_workflow_task WHERE instance_id=$1 AND approver_id=$2 AND status='rejected'",[instance.id,userId]);
 if(!task||await sameHuman(t,userId,current.created_by)||await humanIsPerson(t,userId,source.group_id,source.person_id)||!same(instance.applicant_id,current.created_by))deny('拒绝审批没有有效的真实任务来源');
 const {emit}=await import('./platform-core.mjs');
 if(source.source_hash!==instance.source_hash||current.status!=='pending'){
  await t.query("UPDATE ty_workflow_instance SET business_state='blocked',block_reason='请假来源已变化，拒绝后额度释放待核',revision=revision+1 WHERE id=$1",[instance.id]);
  await emit(t,source.group_id,`workflow:${instance.id}:leave-rejection-review`,'leave.rejection.review_required',{request_id:current.id,workflow_instance_id:instance.id,current_status:current.status});return{released:false,review_required:true};
 }
 await t.query("UPDATE ty_leave_allocation SET state='released'WHERE request_id=$1 AND state='held'",[current.id]);
 await t.query("UPDATE ty_leave_request SET status='rejected',approved_by=$2 WHERE id=$1",[current.id,userId]);
 await t.query("UPDATE ty_workflow_instance SET business_state='applied',revision=revision+1 WHERE id=$1",[instance.id]);
 await emit(t,source.group_id,`workflow:${instance.id}:leave-rejected`,'leave.approval.rejected',{request_id:current.id,workflow_instance_id:instance.id,reviewed_by:userId,held_released:true});return{released:true};
}
