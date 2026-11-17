// The token is server-only; a JSON command cannot impersonate an approved workflow receipt.
import * as h from './hr-common.mjs';
import {workforceAccess as access,loadContract} from './workforce-native.mjs';
const {q,one,id,same,bad,deny,missing,conflict}=h;
export const WF_REVIEW_INSTANCE=Symbol('workforce.workflow.receipt');
const F={
 profile:['status','qualification_kind','qualification_valid_from','qualification_valid_to','qualification_ref','contacts','bank'],
 price:['status','unit_price','currency','unit','component','minimum_target','valid_from','valid_to','rounding','tiers','tax_basis'],
 contract:['code','name','company_ids','service_kind','valid_from','valid_to','terms','evidence_ref'],
 order:['code','department_id','position_id','service_role','valid_from','valid_to','quantity','evidence_ref'],
 engagement:['person_id','employment_id','order_id','valid_from','valid_to','service_role','legal_employer_name','legal_kind','qualification_profile_id','dispatch_post_kind','dispatch_basis_ref','evidence_ref'],
 acceptance:['accepted_quantity','original_quantity','metric','unit','work_date','slice_end','source_kind','source_report_id','source_hash','evidence_ref','allocations'],
 bill:['target','lines','source_hash','status','period','currency','evidence_ref'],
 opening:['recognised_target','net_settled','held','evidence_ref'],
 finance:['amount','status','currency','source_hash','allocations','evidence_ref'],
 funds:['amount','status','source_hash','mandate_id','evidence_ref','period','currency']
};
export const REVIEW_TYPES={
 workforce_profile:{operation:'profile.review',view:'profiles',label:'供应商资格与收款核定',resource:'outsource_ops',fields:F.profile,pending:'draft',kind:'qualification_kind'},
 workforce_price:{operation:'price.review',view:'prices',label:'合同价目核定',resource:'outsource_bill',fields:F.price,pending:'draft',kind:'component'},
 workforce_contract:{operation:'contract.review',view:'contracts',label:'服务合同核定',resource:'outsource_ops',fields:F.contract,pending:'draft',kind:'service_kind'},
 workforce_order:{operation:'order.review',view:'orders',label:'服务订单核定',resource:'outsource_ops',fields:F.order,pending:'draft',kind:'service_kind'},
 workforce_engagement:{operation:'engagement.review',view:'engagements',label:'用工关系核定',resource:'outsource_ops',fields:F.engagement,pending:'draft',kind:'legal_kind'},
 workforce_acceptance:{operation:'acceptance.review',view:'acceptances',label:'服务量与工作地核定',resource:'outsource_bill',fields:F.acceptance,pending:'draft',kind:'source_kind'},
 workforce_bill:{operation:'bill.review',view:'bills',label:'供应商对账复核',resource:'outsource_bill',fields:F.bill,pending:'draft'},
 workforce_opening:{operation:'opening.review',view:'openings',label:'历史往来期初核定',resource:'outsource_finance',fields:F.opening,pending:'pending'},
 workforce_bank_receipt:{operation:'bank.review',view:'bank_receipts',label:'银行原始事实核定',resource:'outsource_finance',fields:F.finance,pending:'draft',kind:'kind'},
 workforce_advance:{operation:'advance.review',view:'advances',label:'供应商预付款核定',resource:'outsource_finance',fields:F.finance,pending:'pending'},
 workforce_payment:{operation:'payment.review',view:'payments',label:'供应商付款核准',resource:'outsource_finance',fields:F.finance,pending:'draft'},
 workforce_mandate:{operation:'mandate.review',view:'mandates',label:'个人代发授权核定',resource:'outsource_finance',fields:F.funds,pending:'pending',kind:'kind'},
 workforce_instruction:{operation:'instruction.review',view:'instructions',label:'净工资代发指令核准',resource:'outsource_finance',fields:F.funds,pending:'draft',kind:'component'},
 workforce_personal_receipt:{operation:'personal_receipt.review',view:'personal_receipts',label:'逐人结果证据复核',resource:'outsource_finance',fields:F.funds,pending:'draft',kind:'effect'}
};
const BY_OPERATION=Object.fromEntries(Object.entries(REVIEW_TYPES).map(([type,d])=>[d.operation,type]));
const SQL={
 workforce_profile:'SELECT x.*,s.owner_company_id company_id FROM ty_wf_vendor_profile x JOIN ty_outsource_supplier s ON s.id=x.supplier_id WHERE x.id=$1',
 workforce_price:'SELECT x.*,c.supplier_id FROM ty_wf_price x JOIN ty_outsource_contract c ON c.id=x.contract_id WHERE x.id=$1',
 workforce_contract:'SELECT x.*,x.contract_id id,c.supplier_id,c.service_kind FROM ty_wf_contract_control x JOIN ty_outsource_contract c ON c.id=x.contract_id WHERE x.contract_id=$1',
 workforce_order:'SELECT x.*,c.supplier_id,c.service_kind FROM ty_wf_order x JOIN ty_outsource_contract c ON c.id=x.contract_id WHERE x.id=$1',
 workforce_engagement:'SELECT x.*,e.contract_id,c.supplier_id FROM ty_wf_engagement_review x JOIN ty_outsource_engagement e ON e.id=x.engagement_id JOIN ty_outsource_contract c ON c.id=e.contract_id WHERE x.id=$1',
 workforce_acceptance:'SELECT x.*,r.group_id,r.company_id,r.person_id,r.employment_id,e.contract_id,c.supplier_id FROM ty_wf_acceptance_version x JOIN ty_wf_acceptance_root r ON r.id=x.root_id JOIN ty_outsource_engagement e ON e.id=x.engagement_id JOIN ty_outsource_contract c ON c.id=e.contract_id WHERE x.id=$1',
 workforce_bill:'SELECT x.*,r.group_id,r.company_id,r.supplier_id,r.contract_id,r.period,r.currency FROM ty_wf_bill_version x JOIN ty_wf_bill_root r ON r.id=x.root_id WHERE x.id=$1',
 workforce_opening:'SELECT x.*,r.group_id,r.company_id,r.supplier_id,r.contract_id,r.period,r.currency FROM ty_wf_opening x JOIN ty_wf_bill_root r ON r.id=x.root_id WHERE x.id=$1',
 workforce_bank_receipt:'SELECT x.*,x.recorded_by created_by FROM ty_wf_bank_receipt x WHERE x.id=$1',
 workforce_advance:'SELECT x.* FROM ty_wf_advance x WHERE x.id=$1',
 workforce_payment:'SELECT x.*,r.group_id,r.company_id,r.supplier_id,r.contract_id,r.period,r.currency,a.last_version_id FROM ty_wf_payment x JOIN ty_wf_payable a ON a.id=x.payable_id JOIN ty_wf_bill_root r ON r.id=a.root_id WHERE x.id=$1',
 workforce_mandate:'SELECT x.* FROM ty_wf_mandate x WHERE x.id=$1',
 workforce_instruction:'SELECT x.* FROM ty_wf_personal_instruction x WHERE x.id=$1',
 workforce_personal_receipt:'SELECT x.*,x.recorded_by created_by,i.company_id,i.person_id,i.employment_id,i.supplier_id,i.contract_id,i.period FROM ty_wf_personal_receipt x JOIN ty_wf_personal_instruction i ON i.id=x.instruction_id WHERE x.id=$1'
};
export async function reviewSource(t,{type,sourceId,lock=false}){
 const definition=REVIEW_TYPES[type];if(!definition)bad('未定义的用工审批事项');const row=await one(t,SQL[type]+(lock?' FOR UPDATE OF x':''),[id(sourceId)]);if(!row)missing();
 let contexts=[row],kinds=definition.kind?[row[definition.kind]]:[];
 if(type==='workforce_profile'){const cs=await q(t,'SELECT DISTINCT cc.company_id FROM ty_outsource_contract c JOIN ty_outsource_contract_company cc ON cc.contract_id=c.id WHERE c.supplier_id=$1',[row.supplier_id]);contexts=[row,...cs.map(x=>({...row,company_id:x.company_id}))];}
 if(type==='workforce_contract'){const c=await loadContract(t,row.id);contexts=c.company_ids.map(cid=>({...row,company_id:cid}));row.company_id=null;}
 if(type==='workforce_engagement'){const e=await h.employment(t,row.employment_id);if(!same(e.company_id,row.company_id))contexts.push({...row,company_id:e.company_id});}
 if(type==='workforce_acceptance'){for(const x of await q(t,'SELECT work_company_id FROM ty_wf_acceptance_allocation WHERE acceptance_version_id=$1',[row.id]))contexts.push({...row,company_id:x.work_company_id});}
 if(type==='workforce_bill'||type==='workforce_payment'||type==='workforce_opening'){
  let version=type==='workforce_bill'?row.id:row.last_version_id;if(type==='workforce_opening')version=(await one(t,'SELECT last_version_id FROM ty_wf_payable WHERE root_id=$1',[row.root_id]))?.last_version_id;
  if(version){const lines=await q(t,'SELECT DISTINCT person_id,employment_id,purpose FROM ty_wf_bill_line WHERE version_id=$1',[version]);kinds=[...new Set(lines.map(x=>x.purpose))];for(const x of lines)if(x.person_id)contexts.push({...row,...x});}
 }
 contexts=[...new Map(contexts.map(r=>[[r.company_id??'',r.person_id??'',r.employment_id??''].join(':'),r])).values()];
 for(const ctx of contexts)if(ctx.employment_id&&!ctx.department_id){const assignment=await one(t,"SELECT department_id FROM ty_position_assignment WHERE employment_id=$1 AND company_id=$2 AND status<>'cancelled'AND valid_from<=app_today()AND(valid_to IS NULL OR app_today()<valid_to)ORDER BY is_primary DESC,valid_from DESC,id DESC LIMIT 1",[ctx.employment_id,ctx.company_id]);if(assignment)ctx.department_id=assignment.department_id;}
 const hash=(await one(t,'SELECT fn_ty_wf_approval_fingerprint($1,$2)hash',[type,row.id])).hash;if(!hash)missing();
 const companyIds=[...new Set(contexts.map(c=>c.company_id??null))];
 return{type,id:row.id,definition,row,contexts,kinds:kinds.length?kinds:[null],hash,group_id:row.group_id,company_id:type==='workforce_contract'&&companyIds.length===1?companyIds[0]:row.company_id??null,person_id:row.person_id??null,original_created_by:row.created_by??row.recorded_by};
}
export async function reviewAccess(t,userId,s,action){
 for(const ctx of s.contexts){await access(t,userId,s.definition.resource,action,ctx,action==='read'?['status']:s.definition.fields);if(s.type==='workforce_profile'&&action!=='read')await access(t,userId,'outsource_private','read',ctx,['contacts','bank']);}
}
export async function reviewIndependent(t,userId,s,submittedBy=null){for(const ctx of s.contexts){await h.ensureIndependent(t,userId,s.original_created_by,ctx);if(submittedBy)await h.ensureIndependent(t,userId,submittedBy,ctx);}}
export async function bindingForReview(t,s,{includeExisting=true}={}){
 const flow=await import('./platform-workflow.mjs'),bindings=[];
 for(const ctx of s.contexts)for(const kind of s.kinds){const b=await flow.approvalRequirement(t,{subjectType:s.type,groupId:s.group_id,companyId:ctx.company_id,kind});if(b.required)bindings.push(b);}
 if(bindings.length){if(new Set(bindings.map(b=>String(b.form_id))).size!==1)conflict('此事项涉及不同公司或费用类别的审批设置，请先统一有效流程');return bindings[0];}
 if(includeExisting&&await one(t,"SELECT 1 FROM ty_workflow_instance WHERE subject_type=$1 AND subject_id=$2 AND status IN('running','blocked','approved')AND business_state IN('pending','source_changed','blocked')",[s.type,s.id]))return{required:true,existing_instance:true};
 return{required:false};
}
export async function authorizeReview(t,args){
 const operation=args.operation.replace(/^workforce\./,''),type=BY_OPERATION[operation];if(!type)return{reviewer:args.userId,action:null};
 const source=await reviewSource(t,{type,sourceId:args.input.id}),instanceId=args[WF_REVIEW_INSTANCE];
 if(!instanceId){if((await bindingForReview(t,source)).required)conflict('此事项已绑定或进入审批，请从审批待办核准并实际办理');return{reviewer:args.userId,action:'approve',source};}
 if(args.input.approve!==true)deny('核准凭证只执行原审批通过的确切事项');
 const proof=await(await import('./platform-workflow.mjs')).verifyApprovalReceipt(t,{userId:args.userId,instanceId,subjectType:type,subjectId:source.id,sourceHash:source.hash});
 if(source.row.status!==source.definition.pending)conflict('该审批来源已办理或已变化');
 await reviewAccess(t,args.userId,source,'execute');await reviewAccess(t,proof.approved_by,source,'approve');await reviewIndependent(t,proof.approved_by,source,proof.original_requester_id);
 return{reviewer:proof.approved_by,action:'execute',source,proof};
}
export async function submitBoundReview(t,{userId,input,operationId}){
 h.obj(input);for(const k of Object.keys(input))if(!['subject_type','id','expected_revision','reason'].includes(k))bad('审批提交只接受明确业务引用');
 const source=await reviewSource(t,{type:input.subject_type,sourceId:input.id});await reviewAccess(t,userId,source,'submit');h.text(input.reason,'提交说明',4,1000);
 return h.commandFor(t,{userId,input,operationId,operation:'workforce.approval.submit',groupId:source.group_id,project:r=>r,execute:async()=>{
  const s=await reviewSource(t,{type:source.type,sourceId:source.id,lock:true});h.revision(s.row,input.expected_revision);if(s.row.status!==s.definition.pending)conflict('仅未办理的草稿可提交审批');await reviewAccess(t,userId,s,'submit');const b=await bindingForReview(t,s,{includeExisting:false});if(!b.required)bad('请先发布并绑定本类事项的审批流');
  if(await one(t,"SELECT 1 FROM ty_workflow_instance WHERE subject_type=$1 AND subject_id=$2 AND status IN('running','blocked','approved')AND business_state IN('pending','source_changed','blocked')",[s.type,s.id]))conflict('此事项已有在办审批，请处理原待办');
  const form=await one(t,'SELECT schema FROM ty_form_definition WHERE id=$1',[b.form_id]),safe=safeValues(s),values={};for(const f of form.schema.fields){if(!['subject_id','group_id','company_id'].includes(f.key))bad('此业务审批表仅保存安全引用');values[f.key]=safe[f.key];}const result=await(await import('./platform-workflow.mjs')).submitInstance(t,{userId,input:{form_id:b.form_id,subject_id:s.id,company_id:s.company_id,values},operationId:'WF-SUBMIT:'+operationId});return{id:s.id,status:'approval_pending',workflow_instance_id:result.instance.id,subject_type:s.type};
 }});
}
export function safeValues(s){return{subject_id:String(s.id),group_id:String(s.group_id),company_id:s.company_id==null?null:String(s.company_id)};}
export async function decorateReviewRows(t,{userId,input,result}){
 const type=Object.keys(REVIEW_TYPES).find(k=>REVIEW_TYPES[k].view===result.view);if(!type||!Array.isArray(result.rows))return result;
 for(const row of result.rows){const s=await reviewSource(t,{type,sourceId:row.id});if(s.row.status!==s.definition.pending)continue;const b=await bindingForReview(t,s);if(!b.required)continue;row.allowed_actions=(row.allowed_actions??[]).filter(x=>x!==s.definition.operation);const pending=await one(t,"SELECT id FROM ty_workflow_instance WHERE subject_type=$1 AND subject_id=$2 AND status IN('running','blocked','approved')AND business_state IN('pending','blocked')ORDER BY id DESC LIMIT 1",[s.type,s.id]);if(pending){try{const inst=await(await import('./platform-workflow.mjs')).projectInstance(t,userId,pending.id);row.workflow_instance_id=inst.id;row.workflow_status=inst.status;row.workflow_business_state=inst.business_state;row.allowed_actions.push('approval.open');}catch(e){if(!String(e.message).startsWith('E_TY_FORBIDDEN:'))throw e;}continue;}if(!b.existing_instance)try{await reviewAccess(t,userId,s,'submit');row.allowed_actions.push('approval.submit');row.approval_subject_type=type;row.approval_form_id=b.form_id;}catch(e){if(!String(e.message).startsWith('E_TY_FORBIDDEN:'))throw e;}}
 return result;
}
