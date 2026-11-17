// Current original-domain projections are the authority; reminder rows grant no access.
import * as h from'./hr-common.mjs';import * as contracts from'./hr-contracts.mjs';import * as people from'./people-services.mjs';
const{q,one,same,hash,day}=h;
export const REMINDER_TYPES={contract_expiry:'合同到期',certificate_expiry:'证照到期',dorm_stay_expiry:'入住期限',dorm_lease_expiry:'房源租约到期'};
export const sourceResource={contract_expiry:'hr_contract',certificate_expiry:'people_cert_manage',dorm_stay_expiry:'people_dorm_manage',dorm_lease_expiry:'people_dorm_manage'};
export const permissionFailure=e=>/^E_TY_(FORBIDDEN|NOT_FOUND|CONFLICT):/.test(e.message)||['E_TY_FORBIDDEN','E_TY_NOT_FOUND','E_TY_CONFLICT'].includes(e.code);
const nativeFields=r=>Object.fromEntries(Object.entries(r).filter(([k])=>!['__allowed','source_hash','allowed_actions','workflow','can_edit_salary','can_edit_body','body_cipher','body_iv','body_tag'].includes(k)));
async function pages(read){const rows=[];let page=1;for(;;){const x=await read(page++);if(!x||!Array.isArray(x.rows)||!Number.isFinite(Number(x.total)))throw Error('E_TY_CONFLICT: 原业务未返回有效的授权分页');rows.push(...x.rows);if(rows.length>=Number(x.total))break;if(page>1000)h.bad('提醒来源过多，请限定公司');}return rows;}
export async function localDate(t,timezone){if(typeof timezone!=='string'||!await one(t,'SELECT 1 FROM pg_timezone_names WHERE name=$1',[timezone]))h.bad('请选择明确有效的提醒时区');return(await one(t,"SELECT(clock_timestamp()AT TIME ZONE $1)::date::text d",[timezone])).d;}
function source(kind,raw,projected,due,semantics,key,revision,extra={}){return{kind,source_id:raw.id,source_key:key,source_revision:String(revision),group_id:raw.group_id,company_id:raw.company_id,person_id:raw.person_id??null,employment_id:raw.employment_id??null,due_on:day(due),date_semantics:semantics,source_hash:hash({kind,key,revision:String(revision),group_id:raw.group_id,company_id:raw.company_id,person_id:raw.person_id??null,employment_id:raw.employment_id??null,due_on:day(due),state:raw.status??raw.state,...extra}),details:nativeFields(projected)};}
export async function collectSources(t,{userId,groupId,companyId=null,kind,timezone='Asia/Shanghai',asOf=null}){
 if(!REMINDER_TYPES[kind])h.bad('未登记的提醒类型');const actor=await h.actor(t,userId,groupId);if(actor.profile_code==='config_admin')h.deny('系统配置不读取业务到期来源');const on=asOf?h.date(asOf):await localDate(t,timezone),out=[];
 if(kind==='contract_expiry'){
  const rows=await pages(page=>contracts.queryWorkspace(t,{userId,input:{group_id:groupId,company_id:companyId||undefined,view:'contracts',page,page_size:100}}));
  for(const row of rows){if(row.status!=='signed'||!row.ends_on)continue;const raw=await one(t,"SELECT *FROM ty_hr_contract WHERE id=$1 AND group_id=$2 AND status='signed'AND ends_on IS NOT NULL",[row.id,groupId]);if(!raw)continue;
   const covered=await one(t,"SELECT 1 FROM ty_hr_contract WHERE parent_key=$1 AND employment_id=$2 AND version>$3 AND status IN('signed','terminated')AND signed_on IS NOT NULL AND starts_on<=$4::date AND(ends_on IS NULL OR ends_on>=$4::date)",[raw.parent_key,raw.employment_id,raw.version,h.addDays(raw.ends_on,1)]);if(covered)continue;
   // Original contract projection resolves employment, legal employer and self/HR scope.
   out.push(source(kind,raw,row,raw.ends_on,'contract_inclusive_end','contract:'+raw.id,raw.revision,{legal_entity_company_id:raw.legal_entity_company_id,source_hash:raw.source_hash}));
  }
 }else if(kind==='certificate_expiry'){
  const rows=await pages(async page=>(await people.queryWorkspace(t,{userId,module:'certificates',groupId,companyId,asOf:on,page,pageSize:100})).holdings);
  for(const row of rows){if(row.state!=='verified'||!row.valid_to||row.term_mode==='unknown')continue;const raw=await one(t,"SELECT r.*FROM ty_cert_holding r WHERE r.id=$1 AND r.group_id=$2 AND r.state='verified'AND r.valid_from<=$3::date AND NOT EXISTS(SELECT 1 FROM ty_cert_holding n WHERE n.group_id=r.group_id AND n.source_key=r.source_key AND n.revision>r.revision AND n.state IN('verified','revoked')AND n.valid_from<=$3::date)",[row.id,groupId,on]);if(!raw)continue;
   if(raw.person_id){const active=await one(t,"SELECT 1 FROM ty_employment e WHERE e.group_id=$1 AND e.person_id=$2 AND e.company_id=$3 AND($4::bigint IS NULL OR e.id=$4)AND e.status='active'AND e.hire_date<=$5::date AND(e.leave_date IS NULL OR e.leave_date>=$5::date)",[raw.group_id,raw.person_id,raw.company_id,raw.employment_id,on]);if(!active)continue;}
   out.push(source(kind,raw,row,raw.valid_to,'certificate_first_invalid','certificate:'+raw.source_key,raw.revision,{type_id:raw.type_id}));
  }
 }else if(kind==='dorm_stay_expiry'){
  const rows=await pages(async page=>(await people.queryWorkspace(t,{userId,module:'dormitory',groupId,companyId,asOf:on,page,pageSize:100})).stays);
  for(const row of rows){if(row.state!=='occupied'||!row.ends_at)continue;const raw=await one(t,"SELECT *FROM ty_dorm_stay WHERE id=$1 AND group_id=$2 AND state='occupied'",[row.id,groupId]);if(!raw)continue;const due=(await one(t,"SELECT($1::timestamptz AT TIME ZONE $2)::date::text d",[raw.ends_at,timezone])).d;
   out.push(source(kind,raw,row,due,'stay_exclusive_end','dorm-stay:'+raw.id,raw.revision,{bed_id:raw.bed_id,ends_at:new Date(raw.ends_at).toISOString()}));
  }
 }else{
  if(['vendor_contact','outsource_hr'].includes(actor.profile_code))h.deny();
  for(const raw of await q(t,"SELECT r.*FROM ty_br_lease r WHERE r.group_id=$1 AND($2::bigint IS NULL OR fn_ty_ix_company_contains($2,r.company_id))AND r.status='verified'AND NOT EXISTS(SELECT 1 FROM ty_br_lease n WHERE n.group_id=r.group_id AND n.house_id=r.house_id AND n.source_key=r.source_key AND n.version>r.version AND n.status IN('verified','withdrawn'))ORDER BY r.id",[groupId,companyId])){
   let decision;try{decision=await h.requireAccess(t,userId,'people_dorm_manage','read',{...raw,fields:['ends_at']});}catch(error){if(permissionFailure(error))continue;throw error;}const house=await one(t,'SELECT *FROM ty_dorm_house WHERE id=$1 AND group_id=$2 AND company_id=$3',[raw.house_id,groupId,raw.company_id]);if(!house)continue;
   const grant=decision.allowing_grants.find(g=>h.fieldAllowed(g,'ends_at')),details={id:raw.id,status:raw.status,version:raw.version,ends_on:raw.ends_on};for(const[key,field,value]of[['house_id','id',raw.house_id],['house_name','name',house.name],['starts_on','starts_at',raw.starts_on],['evidence_ref','evidence_ref',raw.evidence_ref]])if(grant&&h.fieldAllowed(grant,field))details[key]=value;
   out.push(source(kind,raw,details,raw.ends_on,'lease_inclusive_end','dorm-lease:'+raw.house_id+':'+raw.source_key,raw.revision,{version:raw.version}));
  }
 }
 return out;
}
export async function currentSource(t,{userId,notice,timezone=notice.timezone??'Asia/Shanghai'}){const rows=await collectSources(t,{userId,groupId:notice.group_id,companyId:notice.company_id,kind:notice.kind,timezone});return rows.find(r=>same(r.source_id,notice.source_id)&&r.source_key===notice.source_key)??null;}
export function sameSource(a,b){return !!a&&a.source_hash===b.source_hash&&day(a.due_on)===day(b.due_on)&&same(a.company_id,b.company_id)&&same(a.person_id,Object.hasOwn(b,'subject_person_id')?b.subject_person_id:b.person_id??null);}
export function sourceWindow(source,rule,on){const offset=Math.round((Date.parse(day(source.due_on)+'T00:00Z')-Date.parse(on+'T00:00Z'))/86400000);return{eligible:offset<=rule.lead_days&&offset>=-rule.overdue_days&&(rule.schedule==='daily'||rule.threshold_days.includes(offset)),offset,cycle_key:(rule.schedule==='daily'?'day:':'threshold:')+on};}
export async function projectOriginalSource(t,{userId,notice,timezone='Asia/Shanghai'}){
 const actor=await h.actor(t,userId,notice.group_id);if(actor.profile_code==='config_admin')h.deny();let row;
 if(notice.kind==='contract_expiry')row=(await contracts.queryWorkspace(t,{userId,input:{group_id:notice.group_id,company_id:notice.company_id,view:'contracts',id:notice.source_id,page:1,page_size:100}})).rows.find(r=>same(r.id,notice.source_id));
 else if(notice.kind==='certificate_expiry'||notice.kind==='dorm_stay_expiry'){
  const module=notice.kind==='certificate_expiry'?'certificates':'dormitory',key=module==='certificates'?'holdings':'stays',rows=await pages(async page=>(await people.queryWorkspace(t,{userId,module,groupId:notice.group_id,companyId:notice.company_id,page,pageSize:100}))[key]);row=rows.find(r=>same(r.id,notice.source_id));
 }else{
  const raw=await one(t,'SELECT *FROM ty_br_lease WHERE id=$1 AND group_id=$2 AND company_id=$3',[notice.source_id,notice.group_id,notice.company_id]);if(!raw)h.missing();if(['vendor_contact','outsource_hr'].includes(actor.profile_code))h.deny();const decision=await h.requireAccess(t,userId,'people_dorm_manage','read',{...raw,fields:['ends_at']}),grant=decision.allowing_grants.find(g=>h.fieldAllowed(g,'ends_at')),house=await one(t,'SELECT name FROM ty_dorm_house WHERE id=$1',[raw.house_id]);row={id:raw.id,status:raw.status,version:raw.version,ends_on:raw.ends_on};for(const[k,f,v]of[['house_id','id',raw.house_id],['house_name','name',house?.name],['starts_on','starts_at',raw.starts_on],['evidence_ref','evidence_ref',raw.evidence_ref]])if(grant&&h.fieldAllowed(grant,f))row[k]=v;
 }
 if(!row)h.missing();const key=notice.kind==='certificate_expiry'?'valid_to':notice.kind==='dorm_stay_expiry'?'ends_at':'ends_on';if(!Object.hasOwn(row,key))h.deny('当前未获原业务到期依据字段的阅读授权');return nativeFields(row);
}
