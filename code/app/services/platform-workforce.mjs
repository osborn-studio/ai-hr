// Typed adapter for14 source-backed approval subjects. Workflow values never hold bank or payroll details.
import * as h from './hr-common.mjs';
import {reviewSource,reviewAccess,reviewIndependent,bindingForReview,safeValues,REVIEW_TYPES,WF_REVIEW_INSTANCE} from './workforce-approvals.mjs';
const{one,same,bad,deny,conflict}=h;
const SAFE=new Set(['subject_id','group_id','company_id']);
export async function submitWorkforceSubject(t,{userId,input,values,form}){
 if(!REVIEW_TYPES[form.business_type]||form.schema.fields.some(f=>!SAFE.has(f.key)))bad('此表仅保存明确业务引用，金额、收款资料及证据须穿透当前业务权限');
 const s=await reviewSource(t,{type:form.business_type,sourceId:input.subject_id??values.subject_id});if(s.row.status!==s.definition.pending)conflict('审批来源已办理');await reviewAccess(t,userId,s,'submit');
 const b=await bindingForReview(t,s,{includeExisting:false});if(!b.required||!same(b.form_id,form.id)||!same(s.group_id,form.group_id)||form.company_id&&!same(form.company_id,s.company_id)||input.company_id&&!same(input.company_id,s.company_id))deny('须使用本事项全部适用范围与类别的确切审批绑定');
 return{type:s.type,id:s.id,hash:s.hash,person_id:s.person_id,company_id:s.company_id,authoritative_title:s.definition.label+' #'+s.id,authoritative_values:safeValues(s)};
}
export async function assertWorkforceApproval(t,{userId,instance}){const s=await reviewSource(t,{type:instance.subject_type,sourceId:instance.subject_id});if(s.row.status!==s.definition.pending||s.hash!==instance.source_hash)conflict('审批来源已变化，请核对新版本');await reviewAccess(t,userId,s,'approve');await reviewIndependent(t,userId,s,instance.applicant_id);}
export async function projectWorkforceInstance(t,{userId,instance}){const s=await reviewSource(t,{type:instance.subject_type,sourceId:instance.subject_id});await reviewAccess(t,userId,s,'read');const out={...instance,title:s.definition.label+' #'+s.id,values:safeValues(s)};out.logs=(out.logs??[]).map(({reason,...x})=>x);delete out.source_hash;delete out.form_values;delete out.approval_reason;return out;}
export async function executeWorkforceSubject(t,{userId,instance}){
 const s=await reviewSource(t,{type:instance.subject_type,sourceId:instance.subject_id});await reviewAccess(t,userId,s,'execute');if(s.hash!==instance.source_hash||s.row.status!==s.definition.pending){await t.query("UPDATE ty_workflow_instance SET status='blocked',business_state='blocked',revision=revision+1 WHERE id=$1",[instance.id]);return{blocked:true,source_changed:true};}
 const proof=await(await import('./platform-workflow.mjs')).verifyApprovalReceipt(t,{userId,instanceId:instance.id,subjectType:s.type,subjectId:s.id,sourceHash:s.hash});await reviewAccess(t,proof.approved_by,s,'approve');await reviewIndependent(t,proof.approved_by,s,proof.original_requester_id);
 await t.query('SAVEPOINT workforce_business_execution');
 try{
  await(await import('./workforce-native.mjs')).dispatchCommand(t,{userId,operation:s.definition.operation,operationId:'WF-EXECUTE:'+instance.id,input:{id:s.id,expected_revision:s.row.revision,approve:true,review_ref:'已按指定审批流程核准；凭证 '+instance.id},[WF_REVIEW_INSTANCE]:instance.id});
  await t.query('INSERT INTO ty_wf_approval_execution(group_id,company_id,subject_type,subject_id,instance_id,source_hash,original_created_by,submitted_by,approved_by,executed_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[s.group_id,s.company_id,s.type,s.id,instance.id,s.hash,s.original_created_by,proof.original_requester_id,proof.approved_by,userId]);
  await t.query("UPDATE ty_workflow_instance SET business_state='applied',revision=revision+1 WHERE id=$1",[instance.id]);await t.query('RELEASE SAVEPOINT workforce_business_execution');return{applied:true,id:s.id};
 }catch(e){await t.query('ROLLBACK TO SAVEPOINT workforce_business_execution');await t.query('RELEASE SAVEPOINT workforce_business_execution');if(String(e.message).startsWith('E_TY_CONFLICT:')){await t.query("UPDATE ty_workflow_instance SET status='blocked',business_state='blocked',revision=revision+1 WHERE id=$1",[instance.id]);return{blocked:true,source_changed:true};}throw e;}
}
// Rejection/cancellation closes the intent, preserving the draft and all liabilities.
// A rejected draft may be corrected by a new source version; it is never silently approved.
async function close(t,{userId,instance},cancel=false){const s=await reviewSource(t,{type:instance.subject_type,sourceId:instance.subject_id});await reviewAccess(t,userId,s,cancel?'cancel':'approve');if(!cancel)await reviewIndependent(t,userId,s,instance.applicant_id);await t.query("UPDATE ty_workflow_instance SET business_state='not_applicable',revision=revision+1 WHERE id=$1",[instance.id]);return{closed:true,source_preserved:true};}
export const rejectWorkforceSubject=(t,args)=>close(t,args);
export const cancelWorkforceSubject=(t,args)=>close(t,args,true);
