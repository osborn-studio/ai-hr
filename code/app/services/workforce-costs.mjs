import{q,one,same,id}from'./platform-core.mjs';
import{companyDescendants,ledgerDescendants}from'./foundation.mjs';
import{workforceAccess}from'./workforce-native.mjs';
import{amount,plus,compare}from'../payroll-calculations.mjs';
const permissionError=e=>/^E_TY_(FORBIDDEN|NOT_FOUND):/.test(e.message)||['E_TY_FORBIDDEN','E_TY_NOT_FOUND'].includes(e.code);
const month=value=>String(value instanceof Date?value.toISOString():value).slice(0,7)+'-01';
const periodEnd=value=>{const p=month(value);return new Date(Date.UTC(Number(p.slice(0,4)),Number(p.slice(5,7)),1)).toISOString().slice(0,10);};
const atomKey=r=>[r.company_id,month(r.period),r.currency,r.inclusion_key].map(String).join('|');

// A bill's current posted target belongs to its earning month. This is an
// accrual cost projection, separate from AP movements, funding and bank cash.
export async function supplierCostRows(t,{userId,input,action='read',nativeRows=[],helpers}){
 if(!(await one(t,"SELECT to_regclass('public.ty_wf_ap_entry')IS NOT NULL ok")).ok)return[];
 const companies=input.company_id?await companyDescendants(t,id(input.company_id)):null,ledgers=input.ledger_id?await ledgerDescendants(t,id(input.ledger_id)):null;
 const roots=await q(t,`SELECT r.*,c.name company_name,c.ledger_id,p.last_version_id,v.version,v.status posted_status,v.posted_at
 FROM ty_wf_bill_root r JOIN ty_company c ON c.id=r.company_id LEFT JOIN ty_wf_payable p ON p.root_id=r.id
 LEFT JOIN ty_wf_bill_version v ON v.id=p.last_version_id
 WHERE r.group_id=$1 AND($2::date IS NULL OR r.period=$2::date)ORDER BY r.period,r.company_id,r.id`,[id(input.group_id),input.period?month(input.period):null]);
 const payrollAtoms=new Map();for(const row of nativeRows)if(row.amount!==undefined&&row.amount!==null&&row.currency&&row.inclusion_key){const key=atomKey(row);payrollAtoms.set(key,amount(plus(payrollAtoms.get(key)||'0',row.amount)));}
 const output=[];
 for(const root of roots){
  if(companies&&!companies.includes(String(root.company_id))||ledgers&&!ledgers.includes(String(root.ledger_id))||input.currency&&input.currency!==root.currency||input.system&&root.currency!==(input.system==='HK_PAYROLL'?'HKD':'CNY'))continue;
  if(!root.last_version_id||root.posted_status!=='posted'){
   if(!root.legacy_bill_id)continue;
   const scope={group_id:root.group_id,company_id:root.company_id};
   try{await workforceAccess(t,userId,'outsource_finance',action,scope,['amount','currency']);await helpers.access(t,userId,'payroll_cost',action,scope,['amount','currency']);}catch(error){if(permissionError(error))continue;throw error;}
   const row={id:'workforce-opening:'+root.id,group_id:root.group_id,company_id:root.company_id,company_name:root.company_name,period:root.period,currency:root.currency,system:root.currency==='HKD'?'HK_PAYROLL':'CN_PAYROLL',label:'供应商历史成本待核定',economic_component:'供应商服务成本',recognition_basis:'accrual',source_domain:'workforce_supplier',source_ref:'workforce:bill-root:'+root.id,amount:null,requires_cost_review:true,cost_review_reason:'历史往来尚无已核当前明细，未按零计入'};
   const visible=await helpers.project(t,userId,'payroll_cost',scope,row,action);if(visible)output.push(visible);continue;
  }
  const lines=await q(t,"SELECT*FROM ty_wf_bill_line WHERE version_id=$1 AND cost_membership='independent'AND purpose<>'agency_funds'ORDER BY id",[root.last_version_id]),atoms=new Map();
  for(const line of lines){
   let departmentId=null;
   if(line.employment_id){const dates=await q(t,'SELECT DISTINCT department_id FROM ty_position_assignment WHERE employment_id=$1 AND valid_from<$3::date AND(valid_to IS NULL OR valid_to>$2::date)',[line.employment_id,month(root.period),periodEnd(root.period)]);if(dates.length===1)departmentId=dates[0].department_id;}
   const scope={group_id:root.group_id,company_id:root.company_id,person_id:line.person_id,department_id:departmentId};
   try{await workforceAccess(t,userId,'outsource_finance',action,scope,['amount','currency']);await helpers.access(t,userId,'payroll_cost',action,scope,['amount','currency']);}catch(error){if(permissionError(error))continue;throw error;}
   // Equal inclusion keys are components of the same bill target; the posted
   // version is used once, regardless of how many older versions exist.
   const key=[line.cost_inclusion_key,line.person_id||'',departmentId||''].join('|'),old=atoms.get(key);
   if(old)old.amount=amount(plus(old.amount,line.amount));else atoms.set(key,{...scope,inclusion_key:line.cost_inclusion_key,amount:amount(line.amount),line_id:line.id});
  }
  for(const value of atoms.values()){
   const row={id:'workforce-cost:'+root.id+':'+value.line_id,group_id:root.group_id,company_id:root.company_id,company_name:root.company_name,person_id:value.person_id,department_id:value.department_id,period:root.period,currency:root.currency,system:root.currency==='HKD'?'HK_PAYROLL':'CN_PAYROLL',label:'供应商对账第'+root.version+'版',economic_component:'供应商服务成本',recognition_basis:'accrual',source_domain:'workforce_supplier',source_ref:'workforce:bill:'+root.last_version_id,source_bill_id:root.last_version_id,inclusion_key:value.inclusion_key,source_amount:value.amount,amount:value.amount,cost_membership:'independent',requires_cost_review:false};
   const recognized=payrollAtoms.get(atomKey(row));
   if(recognized!==undefined){if(compare(recognized,value.amount)===0){row.amount='0.00';row.cost_membership='included_in_parent';row.cost_review_reason='同一成本来源已在工资成本归集';}else{row.amount=null;row.requires_cost_review=true;row.cost_review_reason='同一成本来源与已确认工资成本金额不一致，待核定';}}
   const visible=await helpers.project(t,userId,'payroll_cost',value,row,action);if(visible)output.push(visible);
  }
 }
 return output;
}
