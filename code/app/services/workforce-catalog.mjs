// Typed choices and detail tables use the same current domain grants as commands.
import * as h from './hr-common.mjs';
import {companyDescendants} from './foundation.mjs';
import {workforceAccess as access,loadContract} from './workforce-native.mjs';
const {q,one,id,same,bad}=h;
const forbidden=e=>String(e.message).startsWith('E_TY_FORBIDDEN:');
const PRICE_FIELDS=['status','unit_price','currency','unit','component','minimum_target','valid_from','valid_to','rounding','tiers','tax_basis'];
async function project(t,userId,resource,row,keys){
  let decision;try{decision=await access(t,userId,resource,'read',row);}catch(e){if(forbidden(e))return null;throw e;}
  let visible=[];for(const grant of decision.allowing_grants||[]){const selected=keys.filter(k=>h.fieldAllowed(grant,k));if(selected.length>visible.length)visible=selected;}
  if(!visible.length)return null;
  return {id:row.id,...Object.fromEntries(visible.filter(k=>Object.hasOwn(row,k)).map(k=>[k,row[k]])),allowed_actions:[]};
}
export function matchesQueryPeriod(row,input){
  if(input.currency&&row.currency!==undefined&&input.currency!==row.currency)return false;
  if(!input.period)return true;
  const month=input.period.slice(0,7),value=row.period??row.work_date??row.occurred_on??row.issued_on;
  if(value!=null)return h.day(value).slice(0,7)===month;
  if(row.valid_from!=null){const start=month+'-01',end=h.addDays(start,32).slice(0,7)+'-01';return h.day(row.valid_from)<end&&(row.valid_to==null||h.day(row.valid_to)>=start);}
  return false;
}
export async function queryWorkspace(t,{userId,input}){
  const a=await h.actor(t,userId,input.group_id),companies=input.company_id?await companyDescendants(t,id(input.company_id)):null,view=input.view,rows=[];
  if(view==='references')return references(t,{userId,input,a,companies});
  if(['vendor_contact','store_staff','station_staff','outsourced_staff'].includes(a.profile_code))return {...h.paging([],input),view,capabilities:{allowed_actions:[]}};
  if(view==='prices'){
    const raw=await q(t,'SELECT p.*,c.supplier_id FROM ty_wf_price p JOIN ty_outsource_contract c ON c.id=p.contract_id WHERE p.group_id=$1 ORDER BY p.contract_id,p.code,p.version DESC',[a.group_id]);
    for(const r of raw){if(!within(r,input,companies))continue;const tiers=await q(t,'SELECT lower_quantity,upper_quantity,unit_price FROM ty_wf_price_tier WHERE price_id=$1 ORDER BY lower_quantity',[r.id]);const value=await project(t,userId,'outsource_bill',{...r,tiers},['group_id','company_id','contract_id','supplier_id','code','version','component','unit','currency','unit_price','minimum_target','valid_from','valid_to','rounding','tiers','tax_basis','evidence_ref','status','revision','created_by','approved_by','review_ref']);if(!value)continue;if(r.status==='draft')try{await access(t,userId,'outsource_bill','approve',r,PRICE_FIELDS);await h.ensureIndependent(t,userId,r.created_by,r);value.allowed_actions.push('price.review');}catch(e){if(!forbidden(e))throw e;}rows.push(value);}
  }else if(view==='bill_lines'){
    const v=await one(t,'SELECT v.*,r.group_id,r.company_id,r.supplier_id,r.contract_id,r.period,r.currency FROM ty_wf_bill_version v JOIN ty_wf_bill_root r ON r.id=v.root_id WHERE v.id=$1',[id(input.version_id)]);if(!v||!same(v.group_id,a.group_id))h.missing();if(!within(v,{...input,id:null},companies))return {...h.paging([],input),view};
    for(const r of await q(t,'SELECT*FROM ty_wf_bill_line WHERE version_id=$1 ORDER BY line_key,id',[v.id])){if(input.id&&!same(r.id,input.id)||input.person_id&&!same(r.person_id,input.person_id))continue;const keys=['version_id','line_key','purpose','item_code','description','person_id','employment_id','acceptance_version_id','acceptance_allocation_id','price_id','source_kind','source_hash','economic_key','base_or_extra','base_quantity','quantity','unit','unit_price','amount','cost_membership','cost_inclusion_key','payable_effect','evidence_ref','personal_instruction_id'];const value=await project(t,userId,'outsource_bill',{...v,...r},keys);if(value)rows.push(value);}
  }else if(view==='openings'){
    for(const r of await q(t,'SELECT o.*,r.group_id,r.company_id,r.supplier_id,r.contract_id,r.period,r.currency FROM ty_wf_opening o JOIN ty_wf_bill_root r ON r.id=o.root_id WHERE r.group_id=$1 ORDER BY o.id DESC',[a.group_id])){if(!within(r,input,companies)||input.root_id&&!same(input.root_id,r.root_id))continue;const value=await project(t,userId,'outsource_finance',r,['root_id','group_id','company_id','supplier_id','contract_id','period','currency','recognised_target','net_settled','held','as_of','evidence_ref','status','revision','created_by','verified_by','review_ref']);if(!value)continue;if(r.status==='pending')try{await access(t,userId,'outsource_finance','approve',r,['recognised_target','net_settled','held','evidence_ref']);await h.ensureIndependent(t,userId,r.created_by,r);value.allowed_actions.push('opening.review');}catch(e){if(!forbidden(e))throw e;}rows.push(value);}
  }else bad('未定义的用工协作明细视图');
  return {...h.paging(h.search(rows,input.q,['code','description','line_key','item_code','period']),input),view,capabilities:{allowed_actions:[]},metadata:{money_format:'decimal_string',source_quantity_unit:'minute',quantity_display_does_not_replace_source:true}};
}
function within(r,input,companies){return (!companies||companies.includes(String(r.company_id)))&&(!input.id||same(input.id,r.id))&&(!input.supplier_id||same(input.supplier_id,r.supplier_id))&&(!input.contract_id||same(input.contract_id,r.contract_id))&&(!input.status||input.status===r.status)&&matchesQueryPeriod(r,input);}
const REF_FIELDS={
  companies:['id','code','name','company_id'],
  suppliers:['id','code','name','supplier_id','status','region_code','currency_code'],
  departments:['id','code','name','company_id','department_id'],
  positions:['id','code','name','company_id','position_id'],
  employments:['id','person_id','employment_id','company_id','full_name','person_number','employment_type','hire_date','leave_date','legal_subject_name']
};
async function references(t,{userId,input,a,companies}){
  const kind=input.reference_kind;if(!Object.hasOwn(REF_FIELDS,kind))bad('请明确选择公司、供应商、部门、岗位或真实人员关系');
  if(['vendor_contact','store_staff','station_staff','outsourced_staff'].includes(a.profile_code))return {...h.paging([],input),view:'references',reference_kind:kind,capabilities:{allowed_actions:[]}};
  const resource=input.reference_resource||'outsource_ops';if(!['outsource_ops','outsource_bill','outsource_finance'].includes(resource))bad('引用所属业务权限无效');
  let raw;if(kind==='suppliers')raw=await q(t,'SELECT s.*,s.owner_company_id company_id,s.id supplier_id FROM ty_outsource_supplier s WHERE group_id=$1 ORDER BY id',[a.group_id]);
  else if(kind==='employments')raw=await q(t,'SELECT e.*,e.id employment_id,p.full_name,p.person_number FROM ty_employment e JOIN ty_person p ON p.id=e.person_id WHERE e.group_id=$1 ORDER BY p.person_number,e.id DESC',[a.group_id]);
  else{const table={companies:'ty_company',departments:'ty_department',positions:'ty_company_position'}[kind],fk={companies:'company_id',departments:'department_id',positions:'position_id'}[kind];raw=await q(t,`SELECT x.*,x.id ${fk}${kind==='companies'?'':',x.company_id'} FROM ${table} x WHERE group_id=$1 ORDER BY x.id`,[a.group_id]);}
  const rows=[];for(const r of raw){if(kind!=='suppliers'&&companies&&(!r.company_id||!companies.includes(String(r.company_id)))||input.person_id&&!same(input.person_id,r.person_id)||input.status&&r.status!==input.status)continue;
    // A global supplier is exposed only through a currently authorized actual contract context.
    let contexts=[r];if(kind==='suppliers'&&!r.company_id){const cs=await q(t,'SELECT DISTINCT cc.company_id FROM ty_outsource_contract c JOIN ty_outsource_contract_company cc ON cc.contract_id=c.id WHERE c.supplier_id=$1',[r.id]);contexts=[r,...cs.map(c=>({...r,company_id:c.company_id}))];}
    let value=null;for(const ctx of contexts){if(companies&&(!ctx.company_id||!companies.includes(String(ctx.company_id))))continue;if(kind==='employments'){try{await h.requireAccess(t,userId,'hr_people','read',{group_id:r.group_id,company_id:r.company_id,person_id:r.person_id,fields:['full_name','person_number','employment_type','hire_date','leave_date','legal_subject_name']});}catch(e){if(forbidden(e))continue;throw e;}}
      const candidate=await project(t,userId,resource,ctx,REF_FIELDS[kind]);if(candidate&&(!value||Object.keys(candidate).length>Object.keys(value).length))value=candidate;}
    if(value){if(kind==='companies'){const specs={'contract.create':['outsource_ops',['code','name','company_ids','service_kind','valid_from','valid_to','terms','evidence_ref']],'order.create':['outsource_ops',['code','department_id','position_id','service_role','valid_from','valid_to','quantity','evidence_ref']],'price.create':['outsource_bill',PRICE_FIELDS],'bill.create':['outsource_bill',['target','lines','source_hash','status','period','currency','evidence_ref']],'bank.register':['outsource_finance',['amount','status','currency','source_hash','allocations','evidence_ref']],'invoice.register':['outsource_finance',['amount','status','currency','source_hash','allocations','evidence_ref']]};for(const[action,[res,fields]]of Object.entries(specs))try{await access(t,userId,res,'create',r,fields);value.allowed_actions.push(action);}catch(e){if(!forbidden(e))throw e;}}rows.push(value);}
  }
  return {...h.paging(h.search(rows,input.q,['code','name','full_name','person_number']),input),view:'references',reference_kind:kind,capabilities:{allowed_actions:[...new Set(rows.flatMap(r=>r.allowed_actions))]},metadata:{select_id_only:true,person_match:'canonical_employment_id_never_same_name',resource}};
}
