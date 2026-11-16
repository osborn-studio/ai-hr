// Native, typed people services. Caller-owned transaction: auth, locks, state transition,
// execution receipt, outbox and idempotency receipt use the same connection.
import {createHash} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import {accessFor} from './foundation.mjs';
import {sameHuman,humanIsPerson} from './human-identity.mjs';
const q=async(t,s,p=[])=>(await t.query(s,p)).rows;
const one=async(t,s,p=[])=>(await q(t,s,p))[0];
const same=(a,b)=>String(a)===String(b);
const day=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
const deny=()=>{throw bizErr('E_TY_FORBIDDEN','缺少本模块功能与完整数据范围授权');};
const conflict=m=>{throw bizErr('E_TY_CONFLICT',m);};
const absent=()=>{throw bizErr('E_TY_NOT_FOUND','记录不存在或不在当前权限内');};
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const txt=(v,n,min=1)=>{if(typeof v!=='string'||v.trim().length<min||v.length>2000)bad(n+'须为有效文本');return v.trim();};
const id=(v,n='ID')=>{if(!/^\d+$/.test(String(v))||!Number.isSafeInteger(Number(v))||Number(v)<1)bad(n+'须为正整数');return Number(v);};
const dec=(v,scale=2,positive=false)=>{if(typeof v!=='string'||!new RegExp('^(0|[1-9]\\d{0,13})(\\.\\d{1,'+scale+'})?$').test(v)||positive&&!/[1-9]/.test(v))bad('金额/数量须为精确非负十进制文本且不超允许精度');return v;};
const date=v=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T00:00Z'))||new Date(v+'T00:00Z').toISOString().slice(0,10)!==v)bad('日期无效');return v;};
const instant=v=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))bad('时间须含明确时区');return new Date(v).toISOString();};
const currency=v=>{if(!['CNY','HKD'].includes(v))bad('币种仅支持CNY/HKD，禁止隐式换币');return v;};
const choice=(v,vs,n)=>{if(!vs.includes(v))bad(n+'不在允许选项内');return v;};
const bool=(v,d=false)=>{if(v===undefined)return d;if(typeof v!=='boolean')bad('布尔值无效');return v;};
const M={dormitory:'dorm',certificates:'cert',goods:'goods'};
const REQUEST=Symbol('people-services-request');
function scoped(t,context){return{query:(...args)=>t.query(...args),[REQUEST]:context};}
async function native(t,userId){const ctx=t[REQUEST]||{};if(!ctx.native)ctx.native=(async()=>{if(!(await one(t,"SELECT to_regclass('public.ty_auth_grant') IS NOT NULL ok")).ok)return null;const core=await import('./platform-core.mjs');const managed=!!await one(t,'SELECT 1 FROM ty_auth_managed WHERE account_id=$1 UNION ALL SELECT 1 FROM ty_auth_membership WHERE account_id=$1 UNION ALL SELECT 1 FROM ty_auth_grant WHERE account_id=$1 LIMIT 1',[userId]);return{core,managed};})();return ctx.native;}
const aliases={number_masked:'number_text',net_settled:'amount',held:'amount',available:'amount',refund_due:'amount',reconciliation_excess:'amount',allocated:'amount',target:'amount',payroll_limit:'amount',stock:'quantity',bed_code:'code',room_name:'name',house_name:'name',type_name:'name',item_name:'name',purpose_name:'name'};
const structural=new Set(['id','group_id','company_id','revision','state','status']);
function grantVisibility(grant,keys){const allow=grant.fields_allow||['*'],deny=grant.fields_deny||[];return new Set(keys.filter(k=>{const field=aliases[k]||k;return!deny.includes(k)&&!deny.includes(field)&&(structural.has(k)||allow.includes('*')||allow.includes(k)||allow.includes(field));}));}
async function decisions(t,u,resource,row,action='read',fields=[]){
 const n=await native(t,u);if(!n)return null;const request=t[REQUEST];request.decisions??=new Map();request.departments??=new Map();const key=JSON.stringify([u,resource,action,row.group_id,row.company_id,row.person_id,row.employment_id,row.department_id,[...fields].sort()]);if(request.decisions.has(key))return request.decisions.get(key);
 let deps=row.department_id?[row.department_id]:[];if(!deps.length&&row.employment_id){const depKey=String(row.employment_id);if(!request.departments.has(depKey))request.departments.set(depKey,(await q(t,"SELECT DISTINCT department_id FROM ty_position_assignment WHERE employment_id=$1 AND status='active'AND valid_from<=$2::date AND(valid_to IS NULL OR valid_to>$2::date)",[row.employment_id,request.asOf||(await one(t,'SELECT app_today()::text AS d')).d])).map(x=>x.department_id));deps=request.departments.get(depKey);}
 const out=[];for(const dep of deps.length?deps:[null]){const d=await n.core.authorization(t,{userId:u,resource,action,groupId:row.group_id,companyId:row.company_id,personId:row.person_id,departmentId:dep,fields});if(d.allowed)out.push(d);}request.decisions.set(key,out);return out;
}
function bestVisibility(ds,keys){let best=null;for(const d of ds||[])for(const g of d.allowing_grants||[]){const visible=grantVisibility(g,keys);if(!best||visible.size>best.size)best=visible;}return best;}
function visibleSearch(row,search){const term=String(search||'').normalize('NFKC').trim().toLocaleLowerCase();return!term||Object.values(row).some(v=>['string','number'].includes(typeof v)&&String(v).normalize('NFKC').toLocaleLowerCase().includes(term));}
async function projectRow(t,u,module,row,{self=false,role='manage',member=false,scopeRow=null}={}){
 const n=await native(t,u);if(!n?.managed)return row;
 const ctx=scopeRow||(member?{...row,person_id:row.id}:row);if(!ctx.group_id)return null;
 const ds=await decisions(t,u,`people_${M[module]}_${self?'self':role}`,ctx);const visible=bestVisibility(ds,Object.keys(row));if(!visible)return null;
 const out=Object.fromEntries(Object.entries(row).filter(([k])=>visible.has(k)));
 if(module==='certificates'&&('number_text'in row||'number_masked'in row)){
  const sensitive=bestVisibility(await decisions(t,u,'people_cert_sensitive',ctx),['number_text','evidence_ref','evidence_hash']);
  const full=!self&&visible.has('number_text')&&sensitive?.has('number_text');
  if(!full){const number=String(row.number_text??row.number_masked??'');delete out.number_text;out.number_masked=visible.has('number_text')||visible.has('number_masked')?'*'.repeat(Math.max(0,number.length-4))+number.slice(-4):'****';}
  else out.number_masked=row.number_text;
  for(const k of ['evidence_ref','evidence_hash'])if(self||!visible.has(k)||!sensitive?.has(k))delete out[k];
 }
 return out;
}
const nativeAction=a=>a.endsWith('.decide')||a.endsWith('.verify')||a.endsWith('.reject')||['requirement.recognize','repair.accept','charge.revise'].includes(a)?'approve':a.endsWith('.create')||a==='benefit.candidate'?'create':a.endsWith('.request')||a.endsWith('.submit')||a.endsWith('.report')?'submit':a.endsWith('.cancel')||a.endsWith('.revoke')?'cancel':a.endsWith('.post')||a.startsWith('payment.')||a.endsWith('.checkin')||a.endsWith('.checkout')||a.endsWith('.transfer')||a.endsWith('.return')||a.endsWith('.borrow')?'execute':'update';
const TABLES={
 dormitory:{house:'ty_dorm_house',room:'ty_dorm_room',bed:'ty_dorm_bed',stay:'ty_dorm_stay',repair:'ty_dorm_repair',bill:'ty_dorm_bill',charge:'ty_dorm_charge'},
 certificates:{type:'ty_cert_type',requirement:'ty_cert_requirement',holding:'ty_cert_holding',custody:'ty_cert_custody'},
 goods:{purpose:'ty_goods_purpose',item:'ty_goods_item',document:'ty_goods_doc'}
};
const F={
 'dormitory.house.create':'company_id source_key name address jurisdiction',
 'dormitory.room.create':'house_id code name','dormitory.bed.create':'room_id code',
 'dormitory.stay.request':'employment_id bed_id source_key starts_at ends_at',
 'dormitory.stay.decide':'id approve decision_ref','dormitory.stay.checkin':'id execution_ref',
 'dormitory.stay.checkout':'id ends_at execution_ref','dormitory.stay.cancel':'id reason',
 'dormitory.stay.transfer':'id target_bed_id at ends_at source_key decision_ref execution_ref',
 'dormitory.repair.report':'employment_id bed_id source_key description blocks_capacity',
 'dormitory.repair.progress':'id state','dormitory.repair.accept':'id acceptance_ref',
 'dormitory.bill.create':'house_id source_key period_from period_to fee_kind currency amount source_ref',
 'dormitory.bill.allocate':'id employment_id parent_key allocated target legal_ref payroll_allowed payroll_limit wage_guard_ref',
 'dormitory.bill.allocate-weighted':'id rows enterprise_residual',
 'dormitory.bill.decide':'id approve decision_ref','dormitory.bill.post':'id enterprise_residual execution_ref',
 'dormitory.charge.revise':'id expected_revision target reason decision_ref',
 'dormitory.charge.dispute':'id disputed reason',
 'dormitory.payment.reserve':'id source_key method amount',
 'dormitory.payment.confirm':'id receipt_ref','dormitory.payment.unknown':'id reason',
 'dormitory.payment.release':'id receipt_ref','dormitory.payment.refund':'id source_key amount receipt_ref',
 'dormitory.benefit.candidate':'employment_id parent_key revision currency target source_ref inclusion_key',
 'certificates.type.create':'company_id code name owner_kind jurisdiction requirement_kind term_mode rule_ref reminder_days',
 'certificates.requirement.create':'type_id person_id employment_id source_key required_from required_to applicability_ref',
 'certificates.requirement.recognize':'id holding_id source_key valid_from valid_to verification_ref',
 'certificates.holding.submit':'type_id employment_id source_key revision supersedes_id issuer number_text valid_from valid_to term_mode evidence_ref evidence_hash',
 'certificates.holding.verify':'id verification_ref','certificates.holding.reject':'id reason',
 'certificates.holding.revoke':'id reason','certificates.original.borrow':'id borrower_person_id source_key borrowed_at due_at',
 'certificates.original.return':'id returned_at return_ref',
 'goods.purpose.create':'company_id code name','goods.purpose.disable':'id',
 'goods.item.create':'company_id code name specification unit location',
 'goods.document.submit':'item_id purpose_id employment_id proxy_person_id source_key kind quantity related_doc_id currency auxiliary_amount cost_inclusion_key occurred_on reason',
 'goods.document.decide':'id approve decision_ref','goods.document.post':'id execution_ref','goods.document.cancel':'id reason'
};
export const ACTIONS=Object.freeze(Object.fromEntries(Object.keys(M).map(m=>[m,Object.keys(F).filter(k=>k.startsWith(m+'.')).map(k=>k.slice(m.length+1))])));
function inputFor(module,action,input){
 const fields=F[module+'.'+action];if(!fields)bad('模块动作未定义');
 if(!input||typeof input!=='object'||Array.isArray(input))bad('输入须为对象');
 const allowed=new Set(fields.split(' '));for(const k of Object.keys(input))if(!allowed.has(k))bad('不允许字段:'+k);
 return input;
}
async function company(t,companyId){const r=await one(t,'SELECT *,id company_id FROM ty_company WHERE id=$1',[id(companyId)]);if(!r)absent();return r;}
async function employment(t,employmentId,on=null){const r=await one(t,`SELECT e.*,e.id employment_id,c.ledger_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id WHERE e.id=$1`,[id(employmentId)]);if(!r)absent();if(on&&(r.status==='cancelled'||day(r.hire_date)>on||r.leave_date&&day(r.leave_date)<on))bad('办理日期不在有效雇佣区间');return r;}
async function context(t,r){const c=await company(t,r.company_id);if(!same(c.group_id,r.group_id))bad('公司集团不一致');return{...c,...r,ledger_id:c.ledger_id};}
async function auth(t,userId,module,role,row,write=true,self=false){
 const a=await accessFor(t,userId),p=a.persona;
 if(!M[module]||!await one(t,"SELECT id FROM sys_account WHERE id=$1 AND status='active'",[userId]))deny();
 if(p&&['vendor_contact','outsource_hr','config_admin'].includes(p.profile_code))deny();
 if(write&&p?.profile_code==='boss')deny();
 const resource=`people_${M[module]}_${self?'self':role}`;
 const n=await native(t,userId);
 if(!n?.managed&&!(await one(t,'SELECT fn_role_can($1,$2,$3) ok',[userId,resource,write?'write':'read']))?.ok)deny();
 if(self){if(!p?.person_id||!same(p.group_id,row.group_id)||!same(p.person_id,row.person_id)||!a.grants.some(g=>same(g.group_id,row.group_id)&&(!write||g.can_write)))deny();if(n?.managed&&!((await decisions(t,userId,resource,await context(t,row),write?(t[REQUEST]?.action||'write'):'read',write?(t[REQUEST]?.fields||[]):[]))?.length))deny();return a;}
 if(a.selfOnly||p?.profile_code==='outsourced_staff')deny();
 if(n?.managed){const ds=await decisions(t,userId,resource,await context(t,row),write?(t[REQUEST]?.action||'write'):'read',write?(t[REQUEST]?.fields||[]):[]);if(!ds?.length)deny();return a;}
 if(!a.row(await context(t,row),write))deny();return a;
}
async function accessible(t,u,m,r,role='manage',write=true,allowSelf=false){
 const a=await accessFor(t,u),self=allowSelf&&a.selfOnly;
 await auth(t,u,m,role,r,write,self);return r;
}
async function owned(t,u,m,kind,recordId,role='manage',write=true,allowSelf=false){
 const table=TABLES[m]?.[kind];if(!table)bad('无效实体');
 const r=await one(t,`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`,[id(recordId)]);if(!r)absent();
 await accessible(t,u,m,r,role,write,allowSelf);return r;
}
async function insert(t,table,values){const ks=Object.keys(values);return one(t,`INSERT INTO ${table}(${ks.join(',')}) VALUES(${ks.map((_,n)=>'$'+(n+1)).join(',')}) RETURNING *`,Object.values(values));}
const scope=e=>({group_id:e.group_id,company_id:e.company_id,person_id:e.person_id,employment_id:e.id});
const org=c=>({group_id:c.group_id,company_id:c.company_id??c.id});
async function emit(t,u,m,kind,row,event){await t.query('INSERT INTO ty_ps_outbox(group_id,company_id,module,entity_kind,entity_id,revision,event,actor_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',[row.group_id,row.company_id,m,kind,row.id,row.revision||1,event,u]);}
async function candidate(t,u,m,row,{parent,revision=1,kind,currency:cur=null,target=null,inclusion,ref,basis=null}){
 const values={...org(row),person_id:row.person_id||null,employment_id:row.employment_id||null,module:m,parent_key:parent,source_key:parent,revision,kind,currency:cur,target,inclusion_key:inclusion,cost_basis:basis||(kind==='employee_charge'?'recovery':kind==='noncash_benefit'?'noncash':kind==='qualification_review'?'qualification':'external_source'),source_ref:ref,created_by:u};
 const old=await one(t,'SELECT * FROM ty_ps_candidate WHERE group_id=$1 AND module=$2 AND parent_key=$3 AND revision=$4 AND kind=$5',[row.group_id,m,parent,revision,kind]);
 if(old){const equal=(await one(t,'SELECT $1::numeric IS NOT DISTINCT FROM $2::numeric ok',[old.target,target])).ok;if(!equal||old.currency!==cur||!same(old.company_id,values.company_id)||!same(old.person_id,values.person_id)||!same(old.employment_id,values.employment_id)||old.inclusion_key!==values.inclusion_key||old.cost_basis!==values.cost_basis||old.source_ref!==values.source_ref)conflict('同一源版本候选上下文或金额不同');return old;}
 return insert(t,'ty_ps_candidate',values);
}
async function secondActor(t,row,u,requested='requested_by'){if(await sameHuman(t,row[requested],u)||await humanIsPerson(t,u,row.group_id,row.person_id))deny();}
function pending(row){if(row.state!=='pending')conflict('仅待核状态可审核');}
async function decision(t,u,m,kind,i){const r=await owned(t,u,m,kind,i.id,'approve');pending(r);await secondActor(t,r,u);return one(t,`UPDATE ${TABLES[m][kind]} SET state=$1,approved_by=$2,decision_ref=$3 WHERE id=$4 RETURNING *`,[bool(i.approve)?'approved':'rejected',u,txt(i.decision_ref,'审核依据',4),r.id]);}
async function bedContext(t,u,bedId,employee,write=true){
 const b=await one(t,`SELECT b.*,r.status room_status,h.status house_status,r.house_id,h.name house_name,r.name room_name FROM ty_dorm_bed b JOIN ty_dorm_room r ON r.id=b.room_id JOIN ty_dorm_house h ON h.id=r.house_id WHERE b.id=$1 FOR UPDATE OF b`,[id(bedId)]);if(!b)absent();
 if(!same(b.group_id,employee.group_id))bad('床位跨集团');
 // A broad grant on the employee never borrows an unrelated property grant.
 await auth(t,u,'dormitory',t[REQUEST]?.mainRole||'manage',{...b,person_id:employee.person_id,employment_id:employee.employment_id||employee.id},write);
 if(b.status!=='active'||b.room_status!=='active'||b.house_status!=='active'||await one(t,"SELECT id FROM ty_dorm_repair WHERE bed_id=$1 AND blocks_capacity AND state<>'accepted'",[b.id]))conflict('目标床位不可用或维修未验收');return b;
}
async function dorm(t,u,a,i){
 if(a==='house.create'){const c=await company(t,i.company_id);await auth(t,u,'dormitory','manage',c);return insert(t,'ty_dorm_house',{...org(c),source_key:txt(i.source_key,'来源键'),name:txt(i.name,'房源名称'),address:txt(i.address,'地址'),jurisdiction:choice(i.jurisdiction,['CN','HK'],'地区'),created_by:u});}
 if(a==='room.create'){const h=await owned(t,u,'dormitory','house',i.house_id);return insert(t,'ty_dorm_room',{...org(h),house_id:h.id,code:txt(i.code,'房间码'),name:txt(i.name,'房间名称')});}
 if(a==='bed.create'){const r=await owned(t,u,'dormitory','room',i.room_id);return insert(t,'ty_dorm_bed',{...org(r),room_id:r.id,code:txt(i.code,'床位码')});}
 if(a==='stay.request'){
  const s=instant(i.starts_at),e=instant(i.ends_at);if(e<=s)bad('结束须晚于开始');const local=(await one(t,"SELECT ($1::timestamptz AT TIME ZONE 'Asia/Hong_Kong')::date::text AS local_day",[s])).local_day;const emp=await employment(t,i.employment_id,local);
  const ac=await accessFor(t,u);await accessible(t,u,'dormitory',emp,'manage',true,true);
  if(ac.selfOnly){const b=await one(t,'SELECT * FROM ty_dorm_bed WHERE id=$1',[id(i.bed_id)]);if(!b||!same(b.group_id,emp.group_id)||!same(b.company_id,emp.company_id))deny();}
  else await bedContext(t,u,i.bed_id,emp);
  return insert(t,'ty_dorm_stay',{...scope(emp),bed_id:id(i.bed_id),source_key:txt(i.source_key,'来源键'),starts_at:s,ends_at:e,requested_by:u});
 }
 if(a==='stay.decide'){const r=await owned(t,u,'dormitory','stay',i.id,'approve');pending(r);await secondActor(t,r,u);if(bool(i.approve))await bedContext(t,u,r.bed_id,r);return one(t,'UPDATE ty_dorm_stay SET state=$1,approved_by=$2,decision_ref=$3 WHERE id=$4 RETURNING *',[i.approve?'approved':'rejected',u,txt(i.decision_ref,'审批依据',4),r.id]);}
 if(a==='stay.checkin'){const r=await owned(t,u,'dormitory','stay',i.id);if(r.state!=='approved')conflict('须批准预约后实际入住');await bedContext(t,u,r.bed_id,r);return one(t,"UPDATE ty_dorm_stay SET state='occupied',checked_in_at=starts_at,execution_ref=$1,revision=revision+1 WHERE id=$2 RETURNING *",[txt(i.execution_ref,'入住交接回执',4),r.id]);}
 if(a==='stay.checkout'){const r=await owned(t,u,'dormitory','stay',i.id);const end=instant(i.ends_at);if(r.state!=='occupied'||end<=new Date(r.starts_at).toISOString()||end>new Date(r.ends_at).toISOString())conflict('退宿时间须在实际入住区间内');return one(t,"UPDATE ty_dorm_stay SET state='ended',ends_at=$1,checked_out_at=$1,execution_ref=$2,revision=revision+1 WHERE id=$3 RETURNING *",[end,txt(i.execution_ref,'退宿交接回执',4),r.id]);}
 if(a==='stay.cancel'){const r=await owned(t,u,'dormitory','stay',i.id,'manage',true,true);if(!['pending','approved'].includes(r.state))conflict('实际入住不可当作取消');txt(i.reason,'取消原因',4);return one(t,"UPDATE ty_dorm_stay SET state='cancelled',revision=revision+1 WHERE id=$1 RETURNING *",[r.id]);}
 if(a==='stay.transfer'){
  const r=await owned(t,u,'dormitory','stay',i.id,'approve');await secondActor(t,r,u);if(r.state!=='occupied')conflict('仅实际在住可换宿');const at=instant(i.at),end=instant(i.ends_at);if(at<=new Date(r.starts_at).toISOString()||at>=new Date(r.ends_at).toISOString()||end<=at||same(i.target_bed_id,r.bed_id))bad('换宿区间/目标无效');
  await bedContext(t,u,i.target_bed_id,r);await t.query("UPDATE ty_dorm_stay SET ends_at=$1,checked_out_at=$1,state='ended',revision=revision+1 WHERE id=$2",[at,r.id]);
  return insert(t,'ty_dorm_stay',{...org(r),person_id:r.person_id,employment_id:r.employment_id,bed_id:id(i.target_bed_id),source_key:txt(i.source_key,'换宿稳定来源'),starts_at:at,ends_at:end,state:'occupied',requested_by:r.requested_by,approved_by:u,decision_ref:txt(i.decision_ref,'换宿核准',4),checked_in_at:at,execution_ref:txt(i.execution_ref,'换宿交接',4)});
 }
 if(a==='repair.report'){const emp=await employment(t,i.employment_id);await accessible(t,u,'dormitory',emp,'manage',true,true);const b=await one(t,'SELECT * FROM ty_dorm_bed WHERE id=$1',[id(i.bed_id)]);if(!b||!same(b.group_id,emp.group_id))deny();const ac=await accessFor(t,u);if(!ac.selfOnly)await auth(t,u,'dormitory','manage',b);if(ac.selfOnly&&!await one(t,"SELECT id FROM ty_dorm_stay WHERE bed_id=$1 AND person_id=$2 AND state='occupied'",[b.id,emp.person_id]))deny();if(ac.selfOnly&&i.blocks_capacity===true)deny();return insert(t,'ty_dorm_repair',{...scope(emp),bed_id:b.id,source_key:txt(i.source_key,'报修来源'),description:txt(i.description,'故障描述',4),blocks_capacity:bool(i.blocks_capacity),reported_by:u});}
 if(a==='repair.progress'){const r=await owned(t,u,'dormitory','repair',i.id);if(r.state==='accepted')conflict('已验收不能覆盖');return one(t,'UPDATE ty_dorm_repair SET state=$1 WHERE id=$2 RETURNING *',[choice(i.state,['working','completed'],'维修状态'),r.id]);}
 if(a==='repair.accept'){const r=await owned(t,u,'dormitory','repair',i.id,'approve');if(r.state!=='completed')conflict('须完成维修后验收');return one(t,"UPDATE ty_dorm_repair SET state='accepted',accepted_by=$1,acceptance_ref=$2 WHERE id=$3 RETURNING *",[u,txt(i.acceptance_ref,'维修验收',4),r.id]);}
 if(a==='bill.create'){const h=await owned(t,u,'dormitory','house',i.house_id);return insert(t,'ty_dorm_bill',{...org(h),house_id:h.id,source_key:txt(i.source_key,'账单来源'),period_from:date(i.period_from),period_to:date(i.period_to),fee_kind:choice(i.fee_kind,['rent','water','electricity','other'],'费用类型'),currency:currency(i.currency),amount:dec(i.amount),requested_by:u,source_ref:txt(i.source_ref,'原始账单',4)});}
 if(a==='bill.allocate'){const b=await owned(t,u,'dormitory','bill',i.id);pending(b);const e=await employment(t,i.employment_id);await auth(t,u,'dormitory','manage',e);if(!same(e.group_id,b.group_id))deny();return insert(t,'ty_dorm_charge',{...scope(e),bill_id:b.id,parent_key:txt(i.parent_key,'个人费用父义务'),currency:b.currency,allocated:dec(i.allocated),target:dec(i.target),legal_ref:txt(i.legal_ref,'费用最终可收依据',4),payroll_allowed:bool(i.payroll_allowed),payroll_limit:dec(i.payroll_limit||'0'),wage_guard_ref:i.wage_guard_ref?txt(i.wage_guard_ref,'工资保护核定',4):null,created_by:u});}
 if(a==='bill.allocate-weighted'){
  const b=await owned(t,u,'dormitory','bill',i.id);pending(b);if(!Array.isArray(i.rows)||i.rows.length<1||i.rows.length>100)bad('须提供1至100条已核住用权重');
  if(await one(t,'SELECT id FROM ty_dorm_charge WHERE bill_id=$1',[b.id]))conflict('已有分摊须先处理原草稿，不能重复分配');
  const keys=new Set(),rows=[];for(const r of i.rows){if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['employment_id','parent_key','weight','target_cap','legal_ref','payroll_allowed','payroll_limit','wage_guard_ref'].includes(k)))bad('分摊行字段不合法');const e=await employment(t,r.employment_id);await auth(t,u,'dormitory','manage',e);if(!same(e.group_id,b.group_id))deny();const k=txt(r.parent_key,'分摊稳定父义务');if(keys.has(k))bad('分摊义务不得重复');keys.add(k);rows.push({...r,employment_id:e.id,parent_key:k,weight:dec(r.weight,4,true),target_cap:dec(r.target_cap)});}
  const residual=dec(i.enterprise_residual);const valid=await one(t,'SELECT $1::numeric<=$2::numeric ok',[residual,b.amount]);if(!valid.ok)bad('企业残余超过源费用');
  const amounts=await q(t,`WITH weights AS(SELECT parent_key,weight::numeric weight FROM jsonb_to_recordset($1::jsonb) AS x(parent_key text,weight text)),base AS(SELECT *,($2::numeric-$3::numeric)*100*weight/sum(weight)OVER() exact_cents FROM weights),ranked AS(SELECT *,floor(exact_cents) base_cents,row_number()OVER(ORDER BY exact_cents-floor(exact_cents) DESC,parent_key COLLATE "C") rn,($2::numeric-$3::numeric)*100-sum(floor(exact_cents))OVER() extras FROM base)SELECT parent_key,((base_cents+CASE WHEN rn<=extras THEN 1 ELSE 0 END)/100)::numeric(18,2)::text allocated FROM ranked ORDER BY parent_key COLLATE "C"`,[JSON.stringify(rows),b.amount,residual]);
  const charges=[];for(const r of rows){const allocated=amounts.find(x=>x.parent_key===r.parent_key).allocated;const target=(await one(t,'SELECT least($1::numeric,$2::numeric)::numeric(18,2)::text target',[allocated,r.target_cap])).target;const c=await dorm(t,u,'bill.allocate',{id:b.id,employment_id:r.employment_id,parent_key:r.parent_key,allocated,target,legal_ref:r.legal_ref,payroll_allowed:r.payroll_allowed,payroll_limit:r.payroll_limit,wage_guard_ref:r.wage_guard_ref});await t.query("UPDATE ty_dorm_charge SET weight=$1,allocation_basis='reviewed_weights_largest_remainder' WHERE id=$2",[r.weight,c.id]);charges.push({...c,weight:r.weight,allocation_basis:'reviewed_weights_largest_remainder'});}
  return{...b,allocation_basis:'reviewed_weights_largest_remainder',enterprise_residual:residual,charges};
 }
 if(a==='bill.decide')return decision(t,u,'dormitory','bill',i);
 if(a==='bill.post'){const b=await owned(t,u,'dormitory','bill',i.id);if(b.state!=='approved')conflict('账单须先核准');const residual=dec(i.enterprise_residual);txt(i.execution_ref,'账单发布回执',4);const totals=await one(t,'SELECT coalesce(sum(allocated),0)+$2::numeric=$3::numeric ok FROM ty_dorm_charge WHERE bill_id=$1',[b.id,residual,b.amount]);if(!totals.ok)conflict('员工原始分配+企业残余须等于源账单');const row=await one(t,"UPDATE ty_dorm_bill SET state='posted',enterprise_residual=$1,execution_ref=$3 WHERE id=$2 RETURNING *",[residual,b.id,i.execution_ref]);for(const c of await q(t,'SELECT * FROM ty_dorm_charge WHERE bill_id=$1',[b.id]))await candidate(t,u,'dormitory',c,{parent:c.parent_key,kind:'employee_charge',currency:c.currency,target:c.target,inclusion:'charge:'+c.parent_key,ref:'dorm_charge:'+c.id});await candidate(t,u,'dormitory',b,{parent:'bill:'+b.source_key,kind:'company_cost',currency:b.currency,target:b.amount,inclusion:'dorm_source:'+b.source_key,ref:'dorm_bill:'+b.id});return row;}
 if(a==='charge.revise'){const c=await owned(t,u,'dormitory','charge',i.id,'approve');await secondActor(t,c,u,'created_by');if(Number(i.expected_revision)!==Number(c.revision))conflict('费用版本已变');const target=dec(i.target);txt(i.decision_ref,'费用重核依据',4);const reason=txt(i.reason,'更正原因',4);const next=await one(t,'UPDATE ty_dorm_charge SET target=$1,revision=revision+1 WHERE id=$2 AND revision=$3 RETURNING *',[target,c.id,c.revision]);if(!next)conflict('费用版本已变');
  // Only unexecuted, known reservations may be cancelled. Unknown outcomes stay
  // held for reconciliation; a legally reduced fee never becomes arrears.
  await t.query("UPDATE ty_dorm_settlement SET state='released',receipt_ref='fee reduced: unexecuted reservation cancelled' WHERE charge_id=$1 AND state='reserved'",[c.id]);
  await insert(t,'ty_dorm_charge_revision',{charge_id:c.id,revision:next.revision,target,reason,actor_id:u});await candidate(t,u,'dormitory',next,{parent:c.parent_key,revision:next.revision,kind:'employee_charge',currency:c.currency,target,inclusion:'charge:'+c.parent_key,ref:'dorm_charge:'+c.id});return next;
 }
 if(a==='charge.dispute'){const c=await owned(t,u,'dormitory','charge',i.id,'manage',true,true);txt(i.reason,'争议说明',4);if(!(await accessFor(t,u)).selfOnly||i.disputed===true)return one(t,'UPDATE ty_dorm_charge SET disputed=$1 WHERE id=$2 RETURNING *',[bool(i.disputed),c.id]);deny();}
 if(a==='payment.reserve'){const c=await owned(t,u,'dormitory','charge',i.id,i.method==='payroll'?'payroll':'manage');const b=await one(t,'SELECT state FROM ty_dorm_bill WHERE id=$1',[c.bill_id]);if(b.state!=='posted')conflict('须发布本人费用后结算');return insert(t,'ty_dorm_settlement',{charge_id:c.id,source_key:txt(i.source_key,'结算来源'),method:choice(i.method,['self_payment','payroll'],'结算渠道'),amount:dec(i.amount,2,true),actor_id:u});}
 if(a.startsWith('payment.')){
  let s=await one(t,'SELECT * FROM ty_dorm_settlement WHERE id=$1',[id(i.id)]);if(!s)absent();const c=await owned(t,u,'dormitory','charge',s.charge_id,s.method==='payroll'?'payroll':'manage');s=await one(t,'SELECT * FROM ty_dorm_settlement WHERE id=$1 FOR UPDATE',[s.id]);
  if(a==='payment.refund')return insert(t,'ty_dorm_settlement',{charge_id:c.id,source_key:txt(i.source_key,'退款来源'),method:'refund',amount:dec(i.amount,2,true),state:'confirmed',refund_of:s.id,actor_id:u,confirmed_by:u,receipt_ref:txt(i.receipt_ref,'实际退款/工资冲回回执',4)});
  if(!['reserved','unknown'].includes(s.state))conflict('结算已经终态，不可重复执行');
  if(a==='payment.unknown')return one(t,"UPDATE ty_dorm_settlement SET state='unknown',receipt_ref=$1 WHERE id=$2 RETURNING *",[txt(i.reason,'待对账原因',4),s.id]);
  return one(t,'UPDATE ty_dorm_settlement SET state=$1,receipt_ref=$2,confirmed_by=$4 WHERE id=$3 RETURNING *',[a==='payment.confirm'?'confirmed':'released',txt(i.receipt_ref,a==='payment.confirm'?'真实收款/核准工资确认记账回执':'已核撤销回执',4),s.id,u]);
 }
 if(a==='benefit.candidate'){const e=await employment(t,i.employment_id);await auth(t,u,'dormitory','payroll',e);return candidate(t,u,'dormitory',{...scope(e)},{parent:txt(i.parent_key,'住宿待遇义务'),revision:id(i.revision),kind:'noncash_benefit',currency:currency(i.currency),target:dec(i.target),inclusion:txt(i.inclusion_key,'成本包含关系'),ref:txt(i.source_ref,'已核待遇来源',4)});}
 bad('未实现动作');
}

async function cert(t,u,a,i){
 if(a==='type.create'){const c=await company(t,i.company_id);await auth(t,u,'certificates','manage',c);return insert(t,'ty_cert_type',{...org(c),code:txt(i.code,'证照类型码'),name:txt(i.name,'证照类型名'),owner_kind:choice(i.owner_kind,['company','person'],'持有人'),jurisdiction:choice(i.jurisdiction,['CN','HK'],'地区'),requirement_kind:choice(i.requirement_kind,['verified_legal','enterprise','recommended','pending'],'要求性质'),term_mode:choice(i.term_mode,['fixed','permanent','unstated','unknown'],'期限模式'),rule_ref:txt(i.rule_ref,'适用规则来源',4),reminder_days:i.reminder_days===undefined?30:id(i.reminder_days,'提醒天数')});}
 if(a==='requirement.create'){const tpe=await owned(t,u,'certificates','type',i.type_id);const e=i.employment_id?await employment(t,i.employment_id):null;if(e){await auth(t,u,'certificates','manage',e);if(!same(e.company_id,tpe.company_id))bad('要求须用于类型适用公司');}if(i.person_id&&!same(i.person_id,e?.person_id))bad('人员须来自可信雇佣');return insert(t,'ty_cert_requirement',{...org(tpe),person_id:e?.person_id||null,employment_id:e?.id||null,type_id:tpe.id,source_key:txt(i.source_key,'要求来源'),required_from:date(i.required_from),required_to:i.required_to?date(i.required_to):null,applicability_ref:txt(i.applicability_ref,'适用范围依据',4)});}
 if(a==='requirement.recognize'){const r=await owned(t,u,'certificates','requirement',i.id,'verify');const h=await owned(t,u,'certificates','holding',i.holding_id,'verify');await secondActor(t,h,u,'submitted_by');return insert(t,'ty_cert_recognition',{...org(r),person_id:r.person_id,employment_id:r.employment_id,requirement_id:r.id,holding_id:h.id,source_key:txt(i.source_key,'认可来源'),valid_from:date(i.valid_from),valid_to:i.valid_to?date(i.valid_to):null,verified_by:u,verification_ref:txt(i.verification_ref,'岗位适用认可依据',4)});}
 if(a==='holding.submit'){
  const tp=await one(t,'SELECT * FROM ty_cert_type WHERE id=$1',[id(i.type_id)]);if(!tp)absent();const e=i.employment_id?await employment(t,i.employment_id):null;const ctx=e||tp;await accessible(t,u,'certificates',ctx,'manage',true,!!e);if(e&&!same(e.company_id,tp.company_id))bad('类型与提交公司不一致');
  const revision=id(i.revision||1),term=choice(i.term_mode,['fixed','permanent','unstated','unknown'],'有效期模式');if(revision===1&&i.supersedes_id||revision>1&&!i.supersedes_id)bad('续期须关联上一版本');
  return insert(t,'ty_cert_holding',{...org(tp),person_id:e?.person_id||null,employment_id:e?.id||null,type_id:tp.id,source_key:txt(i.source_key,'持证稳定来源'),revision,supersedes_id:i.supersedes_id?id(i.supersedes_id):null,issuer:txt(i.issuer,'发证机构'),number_text:txt(i.number_text,'证号'),valid_from:date(i.valid_from),valid_to:i.valid_to?date(i.valid_to):null,term_mode:term,evidence_ref:txt(i.evidence_ref,'证明位置',4),evidence_hash:txt(i.evidence_hash,'证据摘要',4),submitted_by:u});
 }
 if(['holding.verify','holding.reject','holding.revoke','requirement.recognize'].includes(a)){const h=await owned(t,u,'certificates','holding',i.id,'verify');await secondActor(t,h,u,'submitted_by');if(a==='holding.revoke'){if(h.state!=='verified')conflict('仅核验证照可撤销');return one(t,"UPDATE ty_cert_holding SET state='revoked',revocation_ref=$1 WHERE id=$2 RETURNING *",[txt(i.reason,'撤销依据',4),h.id]);}pending(h);const row=await one(t,'UPDATE ty_cert_holding SET state=$1,verified_by=$2,verification_ref=$3 WHERE id=$4 RETURNING *',[a==='holding.verify'?'verified':'rejected',u,txt(i.verification_ref||i.reason,'核验依据',4),h.id]);if(row.state==='verified')await candidate(t,u,'certificates',row,{parent:'cert:'+row.source_key,revision:row.revision,kind:'qualification_review',inclusion:'qualification:'+row.source_key,ref:'cert_holding:'+row.id});return row;}
 if(a==='original.borrow'){const h=await owned(t,u,'certificates','holding',i.id);if(h.state!=='verified')conflict('原件须核验后借出');const p=await one(t,'SELECT * FROM ty_person WHERE id=$1 AND group_id=$2',[id(i.borrower_person_id),h.group_id]);if(!p)deny();const pe=await q(t,'SELECT e.*,e.id employment_id,c.ledger_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id WHERE person_id=$1',[p.id]);const access=await accessFor(t,u);if(!pe.some(e=>access.row(e,true)))deny();if((await native(t,u))?.managed){let permitted=false;for(const e of pe)if((await decisions(t,u,'people_cert_manage',e,t[REQUEST]?.action||'execute',t[REQUEST]?.fields||[]))?.length)permitted=true;if(!permitted)deny();}return insert(t,'ty_cert_custody',{holding_id:h.id,source_key:txt(i.source_key,'借阅来源'),borrower_person_id:p.id,borrowed_at:instant(i.borrowed_at),due_at:instant(i.due_at),handled_by:u});}
 if(a==='original.return'){let c=await one(t,'SELECT * FROM ty_cert_custody WHERE id=$1',[id(i.id)]);if(!c)absent();await owned(t,u,'certificates','holding',c.holding_id);c=await one(t,'SELECT * FROM ty_cert_custody WHERE id=$1 FOR UPDATE',[c.id]);if(c.returned_at)conflict('已归还，不可覆盖');return one(t,'UPDATE ty_cert_custody SET returned_at=$1,return_ref=$2 WHERE id=$3 RETURNING *',[instant(i.returned_at),txt(i.return_ref,'归还交接',4),c.id]);}
 bad('未实现动作');
}
async function goods(t,u,a,i){
 if(a==='purpose.create'||a==='item.create'){const c=await company(t,i.company_id);await auth(t,u,'goods','manage',c);if(a==='purpose.create')return insert(t,'ty_goods_purpose',{...org(c),code:txt(i.code,'用途码'),name:txt(i.name,'用途名称')});return insert(t,'ty_goods_item',{...org(c),code:txt(i.code,'物品码'),name:txt(i.name,'物品名称'),specification:i.specification?txt(i.specification,'规格'):'',unit:txt(i.unit,'单位'),location:i.location?txt(i.location,'库位'):''});}
 if(a==='purpose.disable'){const p=await owned(t,u,'goods','purpose',i.id);return one(t,"UPDATE ty_goods_purpose SET status='inactive' WHERE id=$1 RETURNING *",[p.id]);}
 if(a==='document.submit'){
  const it=await one(t,'SELECT * FROM ty_goods_item WHERE id=$1',[id(i.item_id)]);if(!it)absent();const kind=choice(i.kind,['receipt','issue','return','correction_in','correction_out'],'单据类型');const original=kind==='return'?await one(t,"SELECT * FROM ty_goods_doc WHERE id=$1 AND state='posted'AND kind='issue'",[id(i.related_doc_id)]):null;if(kind==='return'&&!original)bad('退回须关联已实际领用原单');if(original&&i.employment_id&&!same(i.employment_id,original.employment_id))bad('退回雇佣必须沿用原领用');const e=original?await employment(t,original.employment_id):i.employment_id?await employment(t,i.employment_id,date(i.occurred_on)):null;const ac=await accessFor(t,u);if(ac.selfOnly&&!['issue','return'].includes(kind))deny();await accessible(t,u,'goods',e||it,'manage',true,!!e);if(e&&!same(e.company_id,it.company_id))bad('物品与领用公司不一致');if(it.status!=='active')bad('物品已停用');
  if(i.purpose_id){const p=(await native(t,u))?.managed?await one(t,"SELECT * FROM ty_goods_purpose WHERE id=$1 AND company_id=$2 AND status='active'",[id(i.purpose_id),it.company_id]):await owned(t,u,'goods','purpose',i.purpose_id,'manage',false,false).catch(async err=>{if(!ac.selfOnly)throw err;return one(t,"SELECT * FROM ty_goods_purpose WHERE id=$1 AND company_id=$2 AND status='active'",[id(i.purpose_id),it.company_id]);});if(!p||p.status!=='active'||!same(p.company_id,it.company_id))bad('用途不可用');}
  if(i.proxy_person_id){const p=await one(t,'SELECT id FROM ty_person WHERE id=$1 AND group_id=$2',[id(i.proxy_person_id),it.group_id]);if(!p||ac.selfOnly&&!same(p.id,ac.persona.person_id))deny();if(!ac.selfOnly){const es=await q(t,'SELECT e.*,e.id employment_id,c.ledger_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id WHERE e.person_id=$1',[p.id]);if(!es.some(e=>ac.row(e,true)))deny();if((await native(t,u))?.managed){let permitted=false;for(const e of es)if((await decisions(t,u,'people_goods_manage',e,t[REQUEST]?.action||'submit',t[REQUEST]?.fields||[]))?.length)permitted=true;if(!permitted)deny();}}}
  return insert(t,'ty_goods_doc',{...org(it),person_id:e?.person_id||null,employment_id:e?.id||null,item_id:it.id,purpose_id:i.purpose_id?id(i.purpose_id):null,source_key:txt(i.source_key,'单据稳定来源'),kind,quantity:dec(i.quantity,4,true),related_doc_id:i.related_doc_id?id(i.related_doc_id):null,proxy_person_id:i.proxy_person_id?id(i.proxy_person_id):null,currency:i.currency?currency(i.currency):null,auxiliary_amount:i.auxiliary_amount!==undefined?dec(i.auxiliary_amount):null,cost_inclusion_key:i.cost_inclusion_key?txt(i.cost_inclusion_key,'成本包含键'):null,occurred_on:date(i.occurred_on),reason:txt(i.reason,'业务依据',4),requested_by:u});
 }
 if(a==='document.decide')return decision(t,u,'goods','document',i);
 if(a==='document.cancel'){const r=await owned(t,u,'goods','document',i.id,'manage',true,true);txt(i.reason,'取消原因',4);if(!['pending','approved'].includes(r.state))conflict('实际库存不能取消，须关联更正');return one(t,"UPDATE ty_goods_doc SET state='cancelled' WHERE id=$1 RETURNING *",[r.id]);}
 if(a==='document.post'){
  const d=await owned(t,u,'goods','document',i.id);if(d.state!=='approved')conflict('须批准后实际办理');await t.query('SELECT id FROM ty_goods_item WHERE id=$1 FOR UPDATE',[d.item_id]);
  const row=await one(t,"UPDATE ty_goods_doc SET state='posted',handled_by=$1,execution_ref=$2 WHERE id=$3 RETURNING *",[u,txt(i.execution_ref,'实际交接回执',4),d.id]);
  await t.query("INSERT INTO ty_goods_movement(doc_id,item_id,delta)VALUES($1,$2,CASE WHEN $3 IN('receipt','return','correction_in')THEN $4::numeric ELSE -$4::numeric END)",[d.id,d.item_id,d.kind,d.quantity]);
  // An optional auxiliary amount is not a valuation engine. Receipt and issue
  // carry the same inclusion key when they describe the same external cost.
  if(d.auxiliary_amount!==null)await candidate(t,u,'goods',d,{parent:'goods:'+d.source_key,kind:'company_cost',currency:d.currency,target:d.auxiliary_amount,inclusion:d.cost_inclusion_key,basis:d.kind==='receipt'?'external_source':'allocation',ref:'goods_doc:'+d.id});return row;
 }
 bad('未实现动作');
}

const META={
 dormitory:{title:'宿舍与住宿福利',tabs:['房源床位','入住换退','报修','费用分摊','结算与退款'],fields:[['amount','decimal','金额，币种分列'],['starts_at','datetime','入住起点（含）'],['ends_at','datetime','退宿终点（不含）']],states:['pending','approved','occupied','ended','rejected','cancelled']},
 certificates:{title:'门店与个人证照',tabs:['证照要求','持证与核验','续期','原件借还','临期提醒'],fields:[['term_mode','enum','固定/长期/未注明/未知'],['number_masked','text','已脱敏证号'],['valid_to','date','失效第一天']],states:['pending','verified','rejected','revoked']},
 goods:{title:'物品领用',tabs:['物品与用途','采购入库','领用退回','个人记录','统计'],fields:[['quantity','decimal','基本单位，最多4位小数'],['auxiliary_amount','decimal','辅助金额，不替代财务结算']],states:['pending','approved','posted','rejected','cancelled']}
};
function actionRole(m,a,input){if(a.includes('decide')||a==='stay.transfer'||a==='repair.accept'||a==='charge.revise')return'approve';if(m==='certificates'&&['holding.verify','holding.reject','holding.revoke','requirement.recognize'].includes(a))return'verify';if(m==='dormitory'&&(a==='benefit.candidate'||a.startsWith('payment.')&&input.method==='payroll'))return'payroll';return'manage';}
async function exposeHolding(t,userId,row){if((await native(t,userId))?.managed)return row;const sensitive=(await one(t,"SELECT fn_role_can($1,'people_cert_sensitive','read')ok",[userId])).ok&&!(await accessFor(t,userId)).selfOnly;if(sensitive)return row;const out={...row};if(row.number_text!==undefined)out.number_masked='*'.repeat(Math.max(0,row.number_text.length-4))+row.number_text.slice(-4);delete out.number_text;delete out.evidence_ref;delete out.evidence_hash;return out;}
export async function dispatchCommand(t,{userId,module,action,input,operationId}){
 if(!M[module]||!F[module+'.'+action])bad('不支持的模块或动作');
 input=inputFor(module,action,input);
 t=scoped(t,{action:nativeAction(action),fields:Object.keys(input).filter(k=>!['id','expected_revision'].includes(k)).map(k=>aliases[k]||k),mainRole:actionRole(module,action,input)});
 txt(operationId,'操作幂等号',4);if(operationId.length>150)bad('幂等号过长');
 await t.query('SELECT id FROM sys_account WHERE id=$1 FOR UPDATE',[userId]);
 const digest=hash({action,input}),old=await one(t,'SELECT * FROM ty_ps_command WHERE actor_id=$1 AND module=$2 AND operation_id=$3',[userId,module,operationId]);
 if(old){if(old.payload_hash!==digest)conflict('同一操作号内容不同');const r=old.result.row,ctx={...old.result.context,person_id:r.person_id||old.result.context.person_id};await accessible(t,userId,module,ctx,actionRole(module,action,{...input,method:r.method||input.method}),true,['stay.request','stay.cancel','repair.report','holding.submit','document.submit','document.cancel','charge.dispute'].includes(action));let exposed=module==='certificates'&&action.startsWith('holding.')?await exposeHolding(t,userId,r):r;if((await native(t,userId))?.managed)exposed=await projectRow(t,userId,module,exposed,{self:(await accessFor(t,userId)).selfOnly,scopeRow:ctx})||{id:r.id,state:r.state,revision:r.revision};return{...old.result,row:exposed,replayed:true};}
 let row=await(module==='dormitory'?dorm:module==='certificates'?cert:goods)(t,userId,action,input);
 let ctx=row;if(module==='dormitory'&&action.startsWith('payment.'))ctx=await one(t,'SELECT * FROM ty_dorm_charge WHERE id=$1',[row.charge_id]);
 if(module==='certificates'&&action.startsWith('original.'))ctx=await one(t,'SELECT * FROM ty_cert_holding WHERE id=$1',[row.holding_id]);
 await emit(t,userId,module,action.split('.')[0],{...ctx,id:row.id},action);
 if(module==='certificates'&&action.startsWith('holding.'))row=await exposeHolding(t,userId,row);
 if((await native(t,userId))?.managed)row=await projectRow(t,userId,module,row,{self:(await accessFor(t,userId)).selfOnly,scopeRow:ctx})||{id:row.id,state:row.state,revision:row.revision};
 const result={module,action,row,context:{group_id:ctx.group_id,company_id:ctx.company_id,person_id:ctx.person_id||null,employment_id:ctx.employment_id||null},workflow:{engine:'controlled-domain-receipt',binding:row.workflow_binding||null,approved_is_executed:false}};
 await insert(t,'ty_ps_command',{actor_id:userId,module,operation_id:operationId,action,payload_hash:digest,result:JSON.stringify(result)});return result;
}
export async function queryWorkspace(t,{userId,module,groupId,ledgerId,companyId,personId,asOf,page=1,pageSize=20,q:search=''}){
 if(!M[module])bad('模块不存在');t=scoped(t,{action:'read',fields:[],asOf:asOf?date(asOf):null,authorizedCompanies:new Set()});const np=await native(t,userId),nativeScoped=!!np?.managed;const a=await accessFor(t,userId),p=a.persona;
 if(['config_admin','vendor_contact','outsource_hr'].includes(p?.profile_code))deny();
 const self=!!a.selfOnly,resource=`people_${M[module]}_${self?'self':'manage'}`;
 if(!nativeScoped&&!(await one(t,'SELECT fn_role_can($1,$2,\'read\') ok',[userId,resource]))?.ok)deny();
 if(!await one(t,"SELECT id FROM sys_account WHERE id=$1 AND status='active'",[userId]))deny();
 const gid=id(groupId,'集团');if(self&&(!same(p.group_id,gid)||personId&&!same(personId,p.person_id)||!a.grants.some(g=>same(g.group_id,gid))))deny();
 const on=asOf?date(asOf):(await one(t,'SELECT app_today()::text AS local_day')).local_day;t[REQUEST].asOf=on;if(!Number.isInteger(Number(page))||Number(page)<1||!Number.isInteger(Number(pageSize))||Number(pageSize)<1||Number(pageSize)>100)bad('分页参数无效');
 const companies=await q(t,'SELECT *,id company_id FROM ty_company WHERE group_id=$1 ORDER BY id',[gid]);
 let allowed=companies.filter(c=>self?true:a.row(c));
 const descendants=async(table,root)=>q(t,`WITH RECURSIVE s AS(SELECT id FROM ${table} WHERE id=$1 AND group_id=$2 UNION ALL SELECT c.id FROM ${table} c JOIN s ON c.${table==='ty_company'?'parent_company_id':'parent_ledger_id'}=s.id)SELECT id FROM s`,[id(root),gid]);
 if(companyId){if(!self&&!allowed.some(c=>same(c.id,companyId)))deny();const ids=(await descendants('ty_company',companyId)).map(x=>String(x.id));allowed=allowed.filter(c=>ids.includes(String(c.id)));}
 if(ledgerId){const ids=(await descendants('ty_ledger',ledgerId)).map(x=>String(x.id));allowed=allowed.filter(c=>ids.includes(String(c.ledger_id)));}
 const person=self?p.person_id:personId?id(personId):null;
 if(self){const es=await q(t,'SELECT DISTINCT company_id FROM ty_employment WHERE person_id=$1 AND group_id=$2',[person,gid]);allowed=allowed.filter(c=>es.some(e=>same(e.company_id,c.id)));}
 if(!allowed.length&&!self)deny();
 const ids=allowed.map(c=>c.id),params=[gid,ids,person],pattern=nativeScoped?'%':'%'+String(search).slice(0,100).replace(/[\\%_]/g,'\\$&')+'%';
 const filter="r.group_id=$1 AND r.company_id=ANY($2::bigint[]) AND ($3::bigint IS NULL OR r.person_id=$3)";
 const ownedFilter="r.group_id=$1 AND r.company_id=ANY($2::bigint[])";
 const points=[...allowed];if(nativeScoped){for(const e of await q(t,'SELECT e.*,e.id employment_id,c.ledger_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id WHERE e.group_id=$1 AND e.company_id=ANY($2::bigint[])AND($3::bigint IS NULL OR e.person_id=$3)',params))points.push(e);let gate=false;for(const r of points)if((await decisions(t,userId,resource,r))?.length){gate=true;t[REQUEST].authorizedCompanies.add(String(r.company_id));}if(!gate)deny();}
 const paginate=async(sql,ps=params,{member=false}={})=>{
  if(!nativeScoped){const count=await one(t,'SELECT count(*) total FROM('+sql+') scoped',ps);const n=ps.length;const rows=await q(t,sql+` ORDER BY id DESC LIMIT $${n+1} OFFSET $${n+2}`,[...ps,Number(pageSize),(Number(page)-1)*Number(pageSize)]);return{rows,total:Number(count.total),page:Number(page),page_size:Number(pageSize)};}
  const visible=[];for(const raw of await q(t,sql+' ORDER BY id DESC',ps)){const r=await projectRow(t,userId,module,{group_id:gid,...raw},{self,member});if(r&&visibleSearch(r,search)){visible.push(r);t[REQUEST].authorizedCompanies.add(String(raw.company_id));}}return{rows:visible.slice((Number(page)-1)*Number(pageSize),Number(page)*Number(pageSize)),total:visible.length,page:Number(page),page_size:Number(pageSize)};
 };

 const capability={};for(const role of ['manage','approve','verify','payroll','sensitive','self'])capability[role]=!!(await one(t,'SELECT fn_role_can($1,$2,\'write\') ok',[userId,`people_${M[module]}_${role}`])).ok&&!(['config_admin','boss'].includes(p?.profile_code))&&(role==='self'?!!p?.person_id:!self&&allowed.some(c=>a.row(c,true)));
 const members=await paginate(`SELECT p.id,p.person_number,p.full_name,e.id employment_id,e.company_id FROM ty_person p JOIN ty_employment e ON e.person_id=p.id WHERE p.group_id=$1 AND e.company_id=ANY($2::bigint[])AND($3::bigint IS NULL OR p.id=$3)AND(p.full_name ILIKE $4 OR p.person_number ILIKE $4)`,[...params,pattern],{member:true});

 let data;
 if(module==='dormitory'){
  const stays=await paginate(`SELECT r.*,p.full_name,p.person_number,b.code bed_code,rm.name room_name,h.name house_name FROM ty_dorm_stay r JOIN ty_person p ON p.id=r.person_id JOIN ty_dorm_bed b ON b.id=r.bed_id JOIN ty_dorm_room rm ON rm.id=b.room_id JOIN ty_dorm_house h ON h.id=rm.house_id WHERE ${filter} AND (p.full_name ILIKE $4 OR p.person_number ILIKE $4)`,[...params,pattern]);
  const houses=self?[]:await q(t,`SELECT r.*, (SELECT count(*) FROM ty_dorm_room x WHERE x.house_id=r.id) rooms,(SELECT count(*) FROM ty_dorm_bed b JOIN ty_dorm_room x ON x.id=b.room_id WHERE x.house_id=r.id) beds FROM ty_dorm_house r WHERE ${ownedFilter} ORDER BY r.id LIMIT 100`,[gid,ids]);
  const beds=self?[]:await q(t,`SELECT b.*,rm.name room_name,rm.house_id,h.name house_name,EXISTS(SELECT 1 FROM ty_dorm_stay s WHERE s.bed_id=b.id AND s.state IN('approved','occupied','ended')AND s.starts_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Hong_Kong')AND s.ends_at>($3::date::timestamp AT TIME ZONE 'Asia/Hong_Kong')) occupied,(SELECT s.person_id FROM ty_dorm_stay s WHERE s.bed_id=b.id AND s.state IN('occupied','ended')AND s.starts_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Hong_Kong')AND s.ends_at>($3::date::timestamp AT TIME ZONE 'Asia/Hong_Kong') AND s.company_id=ANY($2::bigint[]) ORDER BY s.id DESC LIMIT 1) occupant_person_id,EXISTS(SELECT 1 FROM ty_dorm_repair x WHERE x.bed_id=b.id AND x.blocks_capacity AND x.state<>'accepted') repair_block FROM ty_dorm_bed b JOIN ty_dorm_room rm ON rm.id=b.room_id JOIN ty_dorm_house h ON h.id=rm.house_id WHERE b.group_id=$1 AND b.company_id=ANY($2::bigint[]) ORDER BY b.id LIMIT 200`,[gid,ids,on]);
  const charges=await paginate(`SELECT r.*,b.period_from,b.period_to,b.fee_kind,coalesce(s.net,0)::text net_settled,coalesce(s.held,0)::text held,greatest(0,r.target-coalesce(s.net,0)-coalesce(s.held,0))::text available,greatest(0,coalesce(s.net,0)-r.target)::text refund_due,greatest(0,coalesce(s.net,0)+coalesce(s.held,0)-r.target)::text reconciliation_excess FROM ty_dorm_charge r JOIN ty_dorm_bill b ON b.id=r.bill_id LEFT JOIN LATERAL(SELECT sum(CASE WHEN method='refund' THEN -amount ELSE amount END)FILTER(WHERE state='confirmed')net,sum(amount)FILTER(WHERE state IN('reserved','unknown')AND method<>'refund')held FROM ty_dorm_settlement x WHERE x.charge_id=r.id)s ON true WHERE ${filter}`);
  data={stays,houses,beds,charges,settlements:await paginate(`SELECT s.*,r.group_id,r.company_id,r.person_id,r.employment_id,r.parent_key,r.currency FROM ty_dorm_settlement s JOIN ty_dorm_charge r ON r.id=s.charge_id WHERE ${filter}`),repairs:await paginate(`SELECT r.* FROM ty_dorm_repair r WHERE ${filter}`),bills:self?{rows:[],total:0}:await paginate(`SELECT r.* FROM ty_dorm_bill r WHERE ${ownedFilter}`,[gid,ids])};
 }else if(module==='certificates'){
  const sensitive=capability.sensitive&&!self;
  const holdings=await paginate(`SELECT r.id,r.group_id,r.company_id,r.person_id,r.employment_id,r.type_id,r.source_key,r.revision,r.supersedes_id,r.issuer,CASE WHEN $4::boolean THEN r.number_text ELSE repeat('*',greatest(length(r.number_text)-4,0))||right(r.number_text,4)END number_masked,${sensitive||nativeScoped?'r.evidence_ref,r.evidence_hash,':''}${nativeScoped?'r.number_text,':''}r.valid_from,r.valid_to,r.term_mode,r.state,r.submitted_by,r.verified_by,r.verification_ref,t.name type_name,t.requirement_kind FROM ty_cert_holding r JOIN ty_cert_type t ON t.id=r.type_id WHERE ${filter}`,[...params,sensitive]);
  const requirements=await paginate(`SELECT r.*,t.name type_name,t.requirement_kind,CASE WHEN t.requirement_kind='pending' THEN 'applicability_pending' WHEN EXISTS(SELECT 1 FROM ty_cert_holding h WHERE h.type_id=r.type_id AND h.person_id IS NOT DISTINCT FROM r.person_id AND h.state='verified'AND h.valid_from<=$4::date AND(h.valid_to IS NULL OR h.valid_to>$4::date)AND h.term_mode<>'unknown') OR EXISTS(SELECT 1 FROM ty_cert_recognition x JOIN ty_cert_holding h ON h.id=x.holding_id WHERE x.requirement_id=r.id AND x.valid_from<=$4::date AND(x.valid_to IS NULL OR x.valid_to>$4::date)AND h.state='verified'AND h.valid_from<=$4::date AND(h.valid_to IS NULL OR h.valid_to>$4::date)AND h.term_mode<>'unknown')THEN 'satisfied' ELSE 'missing_or_unverified' END coverage FROM ty_cert_requirement r JOIN ty_cert_type t ON t.id=r.type_id WHERE ${filter} AND r.required_from<=$4::date AND(r.required_to IS NULL OR r.required_to>$4::date)`,[...params,on]);
  const reminders=await q(t,`SELECT 'cert:'||r.source_key risk_key,r.id,r.revision,r.group_id,r.company_id,r.person_id,r.employment_id,t.name,r.valid_to,CASE WHEN r.valid_to<=$4::date THEN 'expired' ELSE 'expiring'END risk FROM ty_cert_holding r JOIN ty_cert_type t ON t.id=r.type_id WHERE ${filter} AND r.state='verified' AND r.valid_to<=$4::date+t.reminder_days AND NOT EXISTS(SELECT 1 FROM ty_cert_holding n WHERE n.source_key=r.source_key AND n.group_id=r.group_id AND n.revision>r.revision AND n.state='verified'AND n.valid_from<=$4::date AND(n.valid_to IS NULL OR n.valid_to>$4::date)) ORDER BY r.valid_to,r.id LIMIT 100`,[...params,on]);
  data={recognitions:await paginate(`SELECT x.*,h.source_key evidence_source_key,h.revision evidence_revision FROM ty_cert_recognition x JOIN ty_cert_requirement r ON r.id=x.requirement_id JOIN ty_cert_holding h ON h.id=x.holding_id WHERE ${filter}`),types:await q(t,`SELECT r.* FROM ty_cert_type r WHERE ${ownedFilter} ORDER BY id LIMIT 100`,[gid,ids]),holdings,requirements,reminders,custody:self?[]:await q(t,`SELECT c.* FROM ty_cert_custody c JOIN ty_cert_holding r ON r.id=c.holding_id WHERE ${filter} ORDER BY c.id DESC LIMIT 100`,params)};
 }else{
  const documents=await paginate(`SELECT r.*,it.name item_name,it.unit,pr.name purpose_name,p.full_name,p.person_number FROM ty_goods_doc r JOIN ty_goods_item it ON it.id=r.item_id LEFT JOIN ty_goods_purpose pr ON pr.id=r.purpose_id LEFT JOIN ty_person p ON p.id=r.person_id WHERE ${filter}AND(it.name ILIKE $4 OR coalesce(p.full_name,'')ILIKE $4)`,[...params,pattern]);
  const statistics=await q(t,`SELECT r.kind,count(*)::integer documents,count(DISTINCT r.person_id)::integer beneficiaries,it.unit,sum(r.quantity)::text quantity,r.currency,sum(r.auxiliary_amount)::text auxiliary_amount FROM ty_goods_doc r JOIN ty_goods_item it ON it.id=r.item_id WHERE ${filter} AND r.state='posted' GROUP BY r.kind,it.unit,r.currency ORDER BY r.kind,it.unit`,params);
  data={documents,items:await q(t,`SELECT r.id,r.group_id,r.company_id,r.code,r.name,r.specification,r.unit,r.location,${self?'NULL::numeric':'r.stock'} stock,r.status FROM ty_goods_item r WHERE ${ownedFilter} ORDER BY r.id LIMIT 100`,[gid,ids]),purposes:await q(t,`SELECT r.* FROM ty_goods_purpose r WHERE ${ownedFilter} ORDER BY r.id LIMIT 100`,[gid,ids]),statistics};
 }
 if(nativeScoped){
  for(const [key,value]of Object.entries(data)){if(!Array.isArray(value)||key==='statistics')continue;const rows=[];for(const raw of value){let scopeRow=null;if(key==='custody')scopeRow=await one(t,'SELECT * FROM ty_cert_holding WHERE id=$1',[raw.holding_id]);const r=await projectRow(t,userId,module,{group_id:gid,...raw},{self,scopeRow});if(r&&visibleSearch(r,search)){if(key==='beds'&&r.occupant_person_id){const resident=await one(t,'SELECT * FROM ty_dorm_stay WHERE bed_id=$1 AND person_id=$2 ORDER BY id DESC LIMIT 1',[raw.id,r.occupant_person_id]);if(!resident||!((await decisions(t,userId,resource,resident,'read',['person_id']))?.length))r.occupant_person_id=null;}rows.push(r);t[REQUEST].authorizedCompanies.add(String((scopeRow||raw).company_id));}}data[key]=rows;}
  if(module==='goods'){
   const groups=new Map();for(const raw of await q(t,`SELECT r.*,it.unit FROM ty_goods_doc r JOIN ty_goods_item it ON it.id=r.item_id WHERE ${filter}AND r.state='posted'`,params)){const r=await projectRow(t,userId,module,raw,{self});if(!r||!visibleSearch(r,search))continue;const k=JSON.stringify([r.kind||null,r.unit||null,r.currency||null]);if(!groups.has(k))groups.set(k,{kind:r.kind||null,unit:r.unit||null,currency:r.currency||null,ids:[],quantity_ids:[],amount_ids:[],people:new Set(),person_hidden:false});const g=groups.get(k);g.ids.push(raw.id);if(r.quantity!==undefined&&r.unit!==undefined)g.quantity_ids.push(raw.id);if(r.auxiliary_amount!==undefined&&r.currency!==undefined)g.amount_ids.push(raw.id);if(r.person_id)g.people.add(String(r.person_id));else if(raw.person_id)g.person_hidden=true;}
   data.statistics=[];for(const g of groups.values()){const sums=await one(t,'SELECT sum(quantity)FILTER(WHERE id=ANY($1::bigint[]))::text quantity,sum(auxiliary_amount)FILTER(WHERE id=ANY($2::bigint[]))::text auxiliary_amount FROM ty_goods_doc WHERE id=ANY($3::bigint[])',[g.quantity_ids,g.amount_ids,g.ids]);data.statistics.push({kind:g.kind,unit:g.unit,currency:g.currency,documents:g.ids.length,beneficiaries:g.person_hidden?null:g.people.size,...sums});}
  }
  for(const role of Object.keys(capability)){capability[role]=false;if(self&&role!=='self'||!self&&role==='self')continue;const verbs=role==='approve'||role==='verify'?['approve']:role==='payroll'?['execute','create']:role==='sensitive'?['read']:['write','create','submit','execute','update','cancel'];outer:for(const r of points)for(const verb of verbs)if((await decisions(t,userId,`people_${M[module]}_${role}`,r,verb))?.length){capability[role]=true;break outer;}}
  allowed=allowed.filter(c=>t[REQUEST].authorizedCompanies.has(String(c.id)));
 }
 return{module,context:{group_id:gid,ledger_id:ledgerId||null,company_id:companyId||null,person_id:person,as_of:on},metadata:{...META[module],lookup_limit:100,bed_lookup_limit:200,lookup_truncation_reported:true,actions:ACTIONS[module],action_fields:Object.fromEntries(ACTIONS[module].map(action=>[action,F[module+'.'+action].split(' ')])),decimal_transport:'string',workflow:'审批核准与实际办理分别留回执'},capabilities:capability,source_candidates:self?{rows:[],total:0,page:Number(page),page_size:Number(pageSize)}:await paginate(`SELECT r.*,'candidate_only'::text adoption_state FROM ty_ps_candidate r WHERE ${filter}AND r.module=$4`,[...params,module]),companies:self?allowed.map(c=>({id:c.id,name:c.name})):allowed.map(c=>({id:c.id,name:c.name,ledger_id:c.ledger_id})),members,lookup_truncated:Object.fromEntries(Object.entries(data).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length>=(k==='beds'?200:100)])),...data};
}
