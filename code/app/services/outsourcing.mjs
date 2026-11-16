import {bizErr} from '../errors.mjs';
import {accessFor,companyDescendants,ledgerDescendants} from './foundation.mjs';
import {personaFor} from './persona-guard.mjs';
import {csv} from '../csv.mjs';
const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
const same=(a,b)=>String(a)===String(b),day=v=>v instanceof Date?v.toISOString().slice(0,10):String(v||'').slice(0,10);
const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
const deny=()=>{throw bizErr('E_TY_FORBIDDEN','当前身份无权访问此供应商、人员、账单或沟通记录');};
const obj=v=>v&&typeof v==='object'&&!Array.isArray(v);
export const RESOURCES=['outsource_ops','outsource_bill','outsource_self'];
export async function scope(t,{userId,groupId,companyId,ledgerId,self=false,write=false}){
 const p=await personaFor(t,userId),a=await accessFor(t,userId),vendor=(await q(t,'SELECT * FROM ty_outsource_portal_user WHERE account_id=$1',[userId]))[0];
 const gid=Number(groupId||p?.group_id);if(!gid||!a.group(gid))deny();
 if(self&&!p?.person_id)deny();
 const resource=self?'outsource_self':'outsource_ops';if(!(await q(t,'SELECT fn_role_can($1,$2,$3) ok',[userId,resource,write?'write':'read']))[0].ok)deny();
 const cs=await q(t,'SELECT c.*,c.id company_id FROM ty_company c WHERE group_id=$1',[gid]);
 const cids=await companyDescendants(t,companyId),lids=await ledgerDescendants(t,ledgerId);
 const allowed=cs.filter(c=>a.row(c)&&(!companyId||cids.includes(String(c.id)))&&(!ledgerId||lids.includes(String(c.ledger_id)))).map(c=>String(c.id));
 const contracts=(await q(t,`SELECT c.*,s.name supplier_name,s.region_code,s.currency_code FROM ty_outsource_contract c JOIN ty_outsource_supplier s ON s.id=c.supplier_id WHERE c.group_id=$1 ORDER BY c.id`,[gid])).filter(c=>!vendor||same(c.supplier_id,vendor.supplier_id));
 const companyScopes=await q(t,'SELECT cc.* FROM ty_outsource_contract_company cc JOIN ty_outsource_contract c ON c.id=cc.contract_id WHERE c.group_id=$1',[gid]);
 const owned=contracts.filter(c=>vendor||companyScopes.some(s=>same(s.contract_id,c.id)&&allowed.includes(String(s.company_id))));
 const engagements=(await q(t,`SELECT e.*,p.full_name,p.person_number,co.name company_name,c.service_kind,c.supplier_id,s.name supplier_name,em.employment_type FROM ty_outsource_engagement e JOIN ty_person p ON p.id=e.person_id JOIN ty_company co ON co.id=e.company_id JOIN ty_employment em ON em.id=e.employment_id JOIN ty_outsource_contract c ON c.id=e.contract_id JOIN ty_outsource_supplier s ON s.id=c.supplier_id WHERE c.group_id=$1 ORDER BY e.person_id,e.valid_from`,[gid])).filter(e=>owned.some(c=>same(c.id,e.contract_id))&&(vendor||allowed.includes(String(e.company_id)))&&(!self||same(e.person_id,p.person_id)));
 const resultContracts=self?owned.filter(c=>engagements.some(e=>same(e.contract_id,c.id))):owned;
 const finance=!self&&!!(await q(t,"SELECT fn_role_can($1,'outsource_bill','read') ok",[userId]))[0].ok;
 return{p,a,vendor,group_id:gid,company_ids:allowed,contracts:resultContracts,companyScopes,engagements,self,finance,can_write:write,userId};
}
async function audit(t,userId,action,kind,id,before,after){await t.query('INSERT INTO ty_outsource_audit(actor_id,action,entity_kind,entity_id,before_data,after_data)VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)',[userId,action,kind,id,before?JSON.stringify(before):null,after?JSON.stringify(after):null]);}
const contractAllowed=(s,id)=>s.contracts.some(c=>same(c.id,id));
function internal(s){if(s.vendor||s.self)deny();}
function threadAllowed(s,th){return !!th&&contractAllowed(s,th.contract_id)&&(s.self?same(th.person_id,s.p.person_id):s.vendor?true:th.person_id?s.engagements.some(e=>same(e.person_id,th.person_id)&&same(e.contract_id,th.contract_id)):s.companyScopes.filter(cc=>same(cc.contract_id,th.contract_id)).every(cc=>s.company_ids.includes(String(cc.company_id))));}
export async function board(t,args){
 const s=await scope(t,args),ids=s.contracts.map(c=>c.id);
 const supplierIds=[...new Set(s.contracts.map(c=>c.supplier_id))];
 const suppliers=(await q(t,'SELECT * FROM ty_outsource_supplier WHERE group_id=$1 ORDER BY id',[s.group_id])).filter(v=>supplierIds.some(id=>same(id,v.id))||(!s.vendor&&!s.self&&(v.owner_company_id?s.company_ids.includes(String(v.owner_company_id)):s.a.shared(s.group_id,true))));
 const bills=s.finance&&ids.length?(await q(t,`SELECT b.*,c.name contract_name,c.supplier_id,s.name supplier_name,s.currency_code,s.region_code,(SELECT coalesce(sum(amount),0)::text FROM ty_outsource_bill_line WHERE bill_id=b.id) total FROM ty_outsource_bill b JOIN ty_outsource_contract c ON c.id=b.contract_id JOIN ty_outsource_supplier s ON s.id=c.supplier_id WHERE b.contract_id=ANY($1::bigint[]) AND($2::boolean=false OR b.status<>'draft') ORDER BY b.period DESC,b.id DESC`,[ids,!!s.vendor])).filter(b=>s.vendor||s.companyScopes.filter(x=>same(x.contract_id,b.contract_id)).every(x=>s.company_ids.includes(String(x.company_id)))).map(b=>s.vendor?{...b,snapshot:undefined}:b):[];
 const threads=ids.length?(await q(t,`SELECT th.*,c.supplier_id,s.name supplier_name,p.full_name,p.person_number FROM ty_outsource_thread th JOIN ty_outsource_contract c ON c.id=th.contract_id JOIN ty_outsource_supplier s ON s.id=c.supplier_id LEFT JOIN ty_person p ON p.id=th.person_id WHERE th.contract_id=ANY($1::bigint[])ORDER BY th.created_at DESC,th.id DESC`,[ids])).filter(th=>threadAllowed(s,th)):[];
 const visibleThreadIds=threads.map(th=>th.id);
 const messages=visibleThreadIds.length?(await q(t,`SELECT m.*,a.display_name author_name FROM ty_outsource_message m JOIN sys_account a ON a.id=m.author_id WHERE thread_id=ANY($1::bigint[])ORDER BY m.id`,[visibleThreadIds])).filter(m=>s.self?m.visibility==='shared':s.vendor?m.visibility!=='internal':true):[];
 const candidates=!s.vendor&&!s.self?(await q(t,`SELECT e.id employment_id,e.person_id,e.company_id,e.employment_type,p.full_name,p.person_number FROM ty_employment e JOIN ty_person p ON p.id=e.person_id WHERE e.company_id=ANY($1::bigint[])AND e.status='active'ORDER BY p.person_number,e.id`,[s.company_ids])):[];
 const redactedContracts=s.contracts.map(c=>s.finance?c:{...c,pricing:undefined,terms:undefined,share_payroll_details:undefined});
 return{candidates,mode:s.self?'employee':s.vendor?'supplier':'hr',group_id:s.group_id,suppliers:s.self?suppliers.map(v=>({id:v.id,name:v.name,contacts:v.contacts})):s.vendor?suppliers.map(v=>({...v,notes:undefined})):suppliers,contracts:redactedContracts,engagements:s.engagements.map(e=>s.self?{...e,legal_employer_name:e.legal_employer_name}:e),bills,threads,messages,contract_companies:s.companyScopes.filter(cc=>contractAllowed(s,cc.contract_id)),companies:(await q(t,`SELECT c.id,c.name,l.region_code,l.currency_code FROM ty_company c CROSS JOIN LATERAL fn_ty_company_locale(c.id)l WHERE c.id=ANY($1::bigint[])ORDER BY c.id`,[s.vendor?s.companyScopes.filter(cc=>contractAllowed(s,cc.contract_id)).map(cc=>cc.company_id):s.company_ids])),capabilities:{manage_suppliers:!s.self&&!s.vendor&&(await q(t,"SELECT fn_role_can($1,'outsource_ops','write') ok",[args.userId]))[0].ok,write_threads:(await q(t,'SELECT fn_role_can($1,$2,\'write\') ok',[args.userId,s.self?'outsource_self':'outsource_ops']))[0].ok,finance:s.finance,write_bills:s.finance&&(await q(t,"SELECT fn_role_can($1,'outsource_bill','write') ok",[args.userId]))[0].ok},notice:'所有姓名、供应商、合同、费用和沟通均为虚构演示。消息仅保存在本系统，没有发送邮件、短信、钉钉或实际付款。'};
}
export async function saveSupplier(t,{userId,id,input}){
 const s=await scope(t,{userId,groupId:input.group_id,write:true});internal(s);
 const old=id?(await q(t,'SELECT * FROM ty_outsource_supplier WHERE id=$1',[id]))[0]:null;if(id&&(!old||!same(old.group_id,s.group_id)))deny();
 const owner=input.owner_company_id||old?.owner_company_id||null;if(!s.a.shared(s.group_id,true)&&(!owner||!s.company_ids.includes(String(owner))))deny();if(old?.owner_company_id&&!s.company_ids.includes(String(old.owner_company_id))&&!s.a.shared(s.group_id,true))deny();
 const merged={...old,...input};if(!merged.name?.trim()||!merged.code?.trim()||!['CN','HK'].includes(merged.region_code)||merged.currency_code!==(merged.region_code==='CN'?'CNY':'HKD')||!Array.isArray(merged.contacts||[])||merged.contacts?.length>20)bad('供应商名称编码、地区币种及联系人格式不正确');
 for(const c of merged.contacts||[])if(!obj(c)||typeof c.name!=='string'||!c.name.trim()||String(c.email||'').length>200||String(c.phone||'').length>40)bad('联系人须有姓名，电话和邮箱长度需有效');
 const fields=['group_id','owner_company_id','code','name','region_code','currency_code','status','qualification_status','qualification_ref','qualification_valid_to','contacts','billing_title','bank_name','bank_account_last4','notes'];
 const v={group_id:s.group_id,owner_company_id:owner,status:'active',qualification_status:'pending',qualification_ref:'',qualification_valid_to:null,contacts:[],billing_title:'',bank_name:'',bank_account_last4:'',notes:'',...merged};v.group_id=s.group_id;v.owner_company_id=owner;
 const args=fields.map(k=>k==='contacts'?JSON.stringify(v[k]):v[k]);
 const row=id?(await q(t,`UPDATE ty_outsource_supplier SET ${fields.map((k,i)=>k+'=$'+(i+1)).join(',')},updated_at=clock_timestamp() WHERE id=$${fields.length+1} RETURNING *`,[...args,id]))[0]:(await q(t,`INSERT INTO ty_outsource_supplier(${fields.join(',')},created_by)VALUES(${fields.map((k,i)=>'$'+(i+1)).join(',')},$${fields.length+1})RETURNING *`,[...args,userId]))[0];
 await audit(t,userId,id?'update':'create','supplier',row.id,old,row);return{row};
}
export async function saveContract(t,{userId,id,input}){
 const s=await scope(t,{userId,groupId:input.group_id,write:true});internal(s);
 if(id)bad('合同采用新增版本维护，请新建合同编码，保留原合同及账单关系');
 const supplier=(await q(t,'SELECT * FROM ty_outsource_supplier WHERE id=$1 AND group_id=$2',[input.supplier_id,s.group_id]))[0];
 if(!supplier||supplier.status!=='active')bad('请选择有效供应商');
 const ids=[...new Set((input.company_ids||[]).map(Number))];if(!ids.length||ids.some(id=>!s.company_ids.includes(String(id))))deny();
 if(!input.code?.trim()||!input.name?.trim()||!['staffing_outsource','dispatch','payroll_agency'].includes(input.service_kind)||!obj(input.pricing))bad('合同名称、编码、服务类型与收费规则必填');
 const row=(await q(t,'INSERT INTO ty_outsource_contract(group_id,supplier_id,code,name,service_kind,valid_from,valid_to,status,pricing,share_payroll_details,owner_account_id,terms,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)RETURNING *',[s.group_id,supplier.id,input.code,input.name,input.service_kind,input.valid_from,input.valid_to,input.status||'active',JSON.stringify(input.pricing),input.share_payroll_details===true,userId,input.terms||'',userId]))[0];
 for(const id of ids)await t.query('INSERT INTO ty_outsource_contract_company(contract_id,company_id)VALUES($1,$2)',[row.id,id]);await audit(t,userId,'create','contract',row.id,null,row);return{row};
}
export async function createThread(t,{userId,input,self=false}){
 const s=await scope(t,{userId,groupId:input.group_id,write:true,self});if(!contractAllowed(s,input.contract_id))deny();
 const personId=self?s.p.person_id:input.person_id||null;
 if(!threadAllowed(s,{contract_id:input.contract_id,person_id:personId}))deny();
 if(self&&input.person_id&&!same(input.person_id,personId))deny();
 if(!['attendance','onboarding','offboarding','payroll','billing','other'].includes(input.category)||typeof input.subject!=='string'||!input.subject.trim()||input.subject.length>200)bad('请选择事项类型并填写主题');
 const thread=(await q(t,'INSERT INTO ty_outsource_thread(contract_id,person_id,bill_id,category,subject,due_date,created_by)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING *',[input.contract_id,personId,input.bill_id||null,input.category,input.subject.trim(),input.due_date||null,userId]))[0];
 await postMessage(t,{userId,id:thread.id,input:{group_id:s.group_id,body:input.body,visibility:'shared'},self});await audit(t,userId,'create','thread',thread.id,null,thread);return{thread};
}
export async function postMessage(t,{userId,id,input,self=false}){
 const s=await scope(t,{userId,groupId:input.group_id,write:true,self}),th=(await q(t,'SELECT * FROM ty_outsource_thread WHERE id=$1 FOR UPDATE',[id]))[0];
 if(!threadAllowed(s,th))deny();
 const visibility=input.visibility||'shared';if(!['shared','hr_vendor','internal'].includes(visibility)||(s.vendor&&visibility==='internal')||(self&&visibility!=='shared'))deny();
 if(typeof input.body!=='string'||!input.body.trim()||input.body.length>4000)bad('请填写1至4000字沟通内容');
 if(th.status==='resolved')bad('已解决事项保持只读，请另建新事项');
 const message=(await q(t,'INSERT INTO ty_outsource_message(thread_id,author_id,visibility,body)VALUES($1,$2,$3,$4)RETURNING *',[th.id,userId,visibility,input.body.trim()]))[0];
 const status=self||s.vendor?'waiting_hr':input.wait_for==='employee'?'waiting_employee':'waiting_vendor';await t.query('UPDATE ty_outsource_thread SET status=$2 WHERE id=$1',[th.id,status]);await audit(t,userId,'message','thread',th.id,null,{message_id:message.id,visibility});return{message};
}
export async function resolveThread(t,{userId,id,input}){
 const s=await scope(t,{userId,groupId:input.group_id,write:true});internal(s);const th=(await q(t,'SELECT * FROM ty_outsource_thread WHERE id=$1 FOR UPDATE',[id]))[0];if(!threadAllowed(s,th))deny();if(typeof input.reason!=='string'||input.reason.trim().length<4)bad('请填写至少四字的解决依据');
 if(th.status==='resolved')return{thread:th};await postMessage(t,{userId,id,input:{...input,body:input.reason,visibility:'shared'}});const row=(await q(t,"UPDATE ty_outsource_thread SET status='resolved',resolved_by=$2,resolved_at=clock_timestamp()WHERE id=$1 RETURNING *",[id,userId]))[0];await audit(t,userId,'resolve','thread',id,th,row);return{thread:row};
}
async function billScope(t,userId,id,write=false){const b=(await q(t,'SELECT b.*,c.group_id,c.supplier_id FROM ty_outsource_bill b JOIN ty_outsource_contract c ON c.id=b.contract_id WHERE b.id=$1',[id]))[0];if(!b)deny();const s=await scope(t,{userId,groupId:b.group_id,write});if(!s.finance||!contractAllowed(s,b.contract_id)||(s.vendor&&b.status==='draft'))deny();if(write&&!(await q(t,"SELECT fn_role_can($1,'outsource_bill','write')ok",[userId]))[0].ok)deny();if(!s.vendor&&!s.companyScopes.filter(c=>same(c.contract_id,b.contract_id)).every(c=>s.company_ids.includes(String(c.company_id))))deny();return{s,b};}
export async function billDetail(t,{userId,id}){
 const{s,b}=await billScope(t,userId,id),c=s.contracts.find(c=>same(c.id,b.contract_id));
 const lines=await q(t,'SELECT l.*,p.full_name,p.person_number,c.name company_name FROM ty_outsource_bill_line l LEFT JOIN ty_person p ON p.id=l.person_id JOIN ty_company c ON c.id=l.company_id WHERE bill_id=$1 ORDER BY l.id',[id]);
 const signed=await q(t,'SELECT id,display_name FROM sys_account WHERE id=ANY($1::bigint[])',[[b.hr_confirmed_by,b.vendor_confirmed_by].filter(Boolean)]);
 return{bill:{...b,...(s.vendor?{snapshot:undefined}:{}),hr_confirmed_name:signed.find(a=>same(a.id,b.hr_confirmed_by))?.display_name,vendor_confirmed_name:signed.find(a=>same(a.id,b.vendor_confirmed_by))?.display_name},contract:c,lines:lines.map(l=>s.vendor?{...l,source_ref:undefined,...(!c.share_payroll_details?{full_name:undefined,person_number:undefined,person_id:null}:{})}:l),total:(await q(t,'SELECT coalesce(sum(amount),0)::text total FROM ty_outsource_bill_line WHERE bill_id=$1',[id]))[0].total,can_write:!s.vendor&&b.status==='draft'&&(await q(t,"SELECT fn_role_can($1,'outsource_bill','write')ok",[userId]))[0].ok,can_confirm:b.status==='shared'&&(await q(t,"SELECT fn_role_can($1,'outsource_bill','write')ok",[userId]))[0].ok,mode:s.vendor?'supplier':'hr'};
}
export async function createBill(t,{userId,input}){
 const s=await scope(t,{userId,groupId:input.group_id,write:true});internal(s);if(!s.finance||!contractAllowed(s,input.contract_id))deny();
 if(!s.companyScopes.filter(c=>same(c.contract_id,input.contract_id)).every(c=>s.company_ids.includes(String(c.company_id))))deny();
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period||''))bad('请选择账单月份');
 const old=input.supersedes_id?(await billScope(t,userId,input.supersedes_id,true)).b:null;if(old&&(!same(old.contract_id,input.contract_id)||day(old.period)!==input.period+'-01'))bad('更正版本须同合同同月');
 const row=(await q(t,'INSERT INTO ty_outsource_bill(contract_id,period,version,supersedes_id,note,created_by)VALUES($1,$2::date,$3,$4,$5,$6)RETURNING *',[input.contract_id,input.period+'-01',old?old.version+1:1,old?.id||null,input.note||'',userId]))[0];
 if(old){const lines=await q(t,'SELECT * FROM ty_outsource_bill_line WHERE bill_id=$1 ORDER BY id',[old.id]);for(const l of lines)await t.query('INSERT INTO ty_outsource_bill_line(bill_id,company_id,person_id,item_code,description,quantity,unit_price,source_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[row.id,l.company_id,l.person_id,l.item_code,l.description,l.quantity,l.unit_price,JSON.stringify(l.source_ref),userId]);}
 await audit(t,userId,'create','bill',row.id,null,row);return{bill:row};
}
export async function saveBillLine(t,{userId,billId,id,input}){
 const{s,b}=await billScope(t,userId,billId,true);internal(s);if(b.status!=='draft')bad('共享账单已冻结，请建更正版本');
 if(!s.company_ids.includes(String(input.company_id)))deny();if(typeof input.description!=='string'||!input.description.trim()||!Number.isFinite(Number(input.quantity))||!Number.isFinite(Number(input.unit_price)))bad('明细说明、数量和单价必填');
 const old=id?(await q(t,'SELECT * FROM ty_outsource_bill_line WHERE id=$1 AND bill_id=$2',[id,billId]))[0]:null;if(id&&!old)deny();
 const args=[billId,input.company_id,input.person_id||null,input.item_code,input.description,input.quantity,input.unit_price,JSON.stringify(input.source_ref||{}),userId];
 const row=id?(await q(t,'UPDATE ty_outsource_bill_line SET company_id=$2,person_id=$3,item_code=$4,description=$5,quantity=$6,unit_price=$7,source_ref=$8::jsonb,created_by=$9 WHERE bill_id=$1 AND id=$10 RETURNING *',[...args,id]))[0]:(await q(t,'INSERT INTO ty_outsource_bill_line(bill_id,company_id,person_id,item_code,description,quantity,unit_price,source_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)RETURNING *',args))[0];
 await audit(t,userId,'line','bill',billId,old,row);return{row};
}
export async function decideBill(t,{userId,id,input}){
 const{s,b}=await billScope(t,userId,id,true);if(!['share','dispute','confirm'].includes(input.action))bad('不支持的账单动作');
 const status=(await q(t,'SELECT fn_ty_outsource_bill_decide($1,$2,$3,$4,$5)status',[id,userId,input.action,Number(input.revision),input.note||'']))[0].status;return{id,status};
}
export async function exportBill(t,{userId,id}){const r=await billDetail(t,{userId,id});return csv({columns:[{key:'company_name',label:'服务公司'},{key:'person_number',label:'人员工号'},{key:'full_name',label:'姓名'},{key:'description',label:'费用项目'},{key:'quantity',label:'数量',numeric:true},{key:'unit_price',label:'单价',numeric:true},{key:'amount',label:'金额',numeric:true}],rows:r.lines});}

export async function saveEngagement(t,{userId,id,input}){
 const s=await scope(t,{userId,groupId:input.group_id,write:true});internal(s);
 if(!contractAllowed(s,input.contract_id)||!s.company_ids.includes(String(input.company_id)))deny();
 if(!input.service_role?.trim()||!input.legal_employer_name?.trim())bad('服务岗位及实际雇主必填');
 const old=id?(await q(t,'SELECT * FROM ty_outsource_engagement WHERE id=$1',[id]))[0]:null;
 if(id&&(!old||!contractAllowed(s,old.contract_id)||!s.company_ids.includes(String(old.company_id))))deny();
 if(old&&(['contract_id','person_id','company_id','employment_id'].some(k=>!same(old[k],input[k]))||day(old.valid_from)!==input.valid_from))bad('服务关系身份和生效日不可移动，请保留旧记录并新建');
 const row=id?(await q(t,'UPDATE ty_outsource_engagement SET valid_to=$2,status=$3,service_role=$4,legal_employer_name=$5 WHERE id=$1 RETURNING *',[id,input.valid_to||null,input.status||'active',input.service_role,input.legal_employer_name]))[0]:(await q(t,'INSERT INTO ty_outsource_engagement(contract_id,person_id,company_id,employment_id,valid_from,valid_to,status,service_role,legal_employer_name,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)RETURNING *',[input.contract_id,input.person_id,input.company_id,input.employment_id,input.valid_from,input.valid_to||null,input.status||'active',input.service_role,input.legal_employer_name,userId]))[0];
 await audit(t,userId,id?'update':'create','engagement',row.id,old,row);return{row};
}
export async function generateBill(t,{userId,id}){
 const{s,b}=await billScope(t,userId,id,true);internal(s);if(b.status!=='draft')bad('只有草稿可从来源生成');
 if((await q(t,'SELECT id FROM ty_outsource_bill_line WHERE bill_id=$1 LIMIT 1',[id])).length)bad('已有明细的账单不重复生成；请复核或建立独立更正版本');
 const c=s.contracts.find(c=>same(c.id,b.contract_id)),period=day(b.period).slice(0,7);
 const engagements=s.engagements.filter(e=>same(e.contract_id,c.id)&&day(e.valid_from)<=period+'-31'&&(!e.valid_to||day(e.valid_to)>=period+'-01'));
 let added=0;
 if(c.service_kind==='payroll_agency'){
  if(!engagements.length)bad('本月没有有效代发服务人员');
  const rows=await q(t,`SELECT r.* FROM ty_payroll_row r JOIN ty_payroll_batch b ON b.id=r.batch_id WHERE b.status='confirmed'AND b.period=$1 AND b.group_id=$2 AND r.employment_id=ANY($3::bigint[])ORDER BY r.id`,[period,s.group_id,engagements.map(e=>e.employment_id)]);
  if(rows.length!==engagements.length)bad('代发人员尚未全部匹配本月已确认工资；不能猜测金额');
  for(const r of rows){
   for(const[code,component,label]of [['employee_net','net_pay','员工净薪代发资金'],['employee_contribution','employee_contribution','员工个人供款代缴资金'],['employer_contribution','employer_contribution','企业供款代缴资金'],...(c.region_code==='CN'?[['withheld_tax','cn_tax','个人所得税代缴资金']]:[])]){
    const amount=component==='cn_tax'?r.result_data.items.find(i=>i.code==='cn_tax')?.amount:r.result_data.totals[component];if(amount===undefined)bad('工资来源缺少明确的资金分项');
    await saveBillLine(t,{userId,billId:id,input:{company_id:r.company_id,person_id:r.person_id,item_code:code,description:label,quantity:1,unit_price:amount,source_ref:{kind:'payroll',row_id:r.id,batch_id:r.batch_id,component}}});added++;
   }
   if(c.pricing.mode==='per_person'){
    const fee=c.pricing.service_fee??c.pricing.unit_price;if(fee===undefined)bad('合同缺少按人服务费参数');
    await saveBillLine(t,{userId,billId:id,input:{company_id:r.company_id,person_id:r.person_id,item_code:'service_fee',description:'合同约定按人按月服务费',quantity:1,unit_price:fee,source_ref:{kind:'contract',contract_id:c.id}}});added++;
   }
  }
  if(c.pricing.mode==='fixed'){
   const fee=c.pricing.fixed_amount??c.pricing.unit_price;if(fee===undefined)bad('合同缺少固定服务费');await saveBillLine(t,{userId,billId:id,input:{company_id:engagements[0].company_id,item_code:'service_fee',description:'合同约定固定月度服务费',quantity:1,unit_price:fee,source_ref:{kind:'contract',contract_id:c.id}}});added++;
  }
 }else{
  if(c.pricing.mode!=='accepted_service_hours'||!Number.isFinite(Number(c.pricing.unit_price)))bad('此合同请按明确的验收结算方式录入费用，不推定工时单价');
  const rp=(await q(t,"SELECT * FROM ty_roster_period WHERE group_id=$1 AND period=$2::date AND status='closed'",[s.group_id,period+'-01']))[0];if(!rp)bad('服务月份缺少封存考勤；请先验收，不用历史直营工时推算外包费');
  for(const e of engagements){const minutes=(await q(t,`SELECT coalesce(sum(s.credited_minutes),0)::int n FROM v_ty_time_segment s WHERE s.period_id=$1 AND s.employment_id=$2 AND s.work_company_id=$3 AND s.work_date>=$4::date AND($5::date IS NULL OR s.work_date<=$5::date)`,[rp.id,e.employment_id,e.company_id,e.valid_from,e.valid_to]))[0].n;if(!minutes)continue;
   await saveBillLine(t,{userId,billId:id,input:{company_id:e.company_id,person_id:e.person_id,item_code:'service_hours',description:'本合同当月封存服务工时',quantity:(minutes/60).toFixed(6),unit_price:c.pricing.unit_price,source_ref:{kind:'attendance',period_id:rp.id,employment_id:e.employment_id,minutes}}});added++;
  }
  if(!added)bad('本合同当月没有可结算服务工时');
 }
 await audit(t,userId,'generate','bill',id,null,{period,lines:added,contract_id:c.id});return{added,bill:(await billDetail(t,{userId,id})).bill};
}
export async function printBill(t,{userId,id}){
 const r=await billDetail(t,{userId,id}),state={draft:'草稿',shared:'待双方确认',disputed:'存在差异',agreed:'双方已确认'},esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>供应商月度对账单</title><style>body{font:13px/1.7 -apple-system,"PingFang SC",sans-serif;color:#173b69;margin:32px}h1{font-size:24px;color:#145aa7;border-bottom:2px solid #c4a35d;padding-bottom:12px}table{width:100%;border-collapse:collapse}th{background:#edf4ff;text-align:left}th,td{padding:10px;border-bottom:1px solid #dce6f5}small{color:#758ba7}td.num{text-align:right;font-variant-numeric:tabular-nums}footer{margin-top:28px;color:#7386a0}.total{text-align:right;font-size:22px;color:#1357a3}.signatures{display:flex;justify-content:space-between;margin-top:25px}@page{size:A4 landscape;margin:18mm}@media print{body{margin:0}thead{display:table-header-group}tr{break-inside:avoid}}</style><h1>天意人力资源系统　供应商对账单</h1><p>服务月份 ${day(r.bill.period).slice(0,7)}　版本 V${r.bill.version}　币种 ${esc(r.contract.currency_code)}</p><p>供应商 ${esc(r.contract.supplier_name)}<br>服务合同 ${esc(r.contract.name)} / ${esc(r.contract.code)}</p><p>状态 ${esc(state[r.bill.status]||r.bill.status)}　${esc(r.bill.note)}</p><table><thead><tr><th>服务公司</th><th>人员</th><th>费用或代发资金项目</th><th>数量</th><th>单价</th><th>金额</th></tr></thead><tbody>${r.lines.map(l=>`<tr><td>${esc(l.company_name)}</td><td>${esc(l.full_name||'合同费用')}<br><small>${esc(l.person_number||'')}</small></td><td>${esc(l.description)}</td><td class="num">${esc(l.quantity)}</td><td class="num">${esc(l.unit_price)}</td><td class="num">${esc(l.amount)}</td></tr>`).join('')}</tbody></table><p class="total">${esc(r.contract.currency_code)} ${r.total}</p><div class="signatures"><span>HR确认：${esc(r.bill.hr_confirmed_name||'待确认')}<br>${day(r.bill.hr_confirmed_at)}</span><span>供应商确认：${esc(r.bill.vendor_confirmed_name||'待确认')}<br>${day(r.bill.vendor_confirmed_at)}</span></div><footer>全虚构演示，仅作为对账记录。本单不是发票，不代表实际付款；代发资金、供款及服务费分别列示。可用浏览器打印或另存PDF。</footer></html>`;
}
