// Caller executes every exported mutation inside its route-owned transaction: one connection,
// one transaction. This domain never commits, pays money or rewrites legacy leave.
import {createHash} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import {sameHuman,humanIsPerson} from './human-identity.mjs';
import {accessFor,companyDescendants,ledgerDescendants} from './foundation.mjs';
import {exactDecimal,decimalAdd,decimalSubtract,compareDecimal,cumulativeGrant,multiShiftMinutes,excludeCalendarDates,expiryDecision,cnAnnualBand,cnAnnualProration,hkAnnualDays,grantOverwriteDecision,leavePayAdoptionDelta} from '../leave-calculations.mjs';
export const RESOURCES=['advanced_leave_config','advanced_leave_manage','advanced_leave_approve','advanced_leave_payroll','advanced_leave_self'];
const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
const one=async(t,s,a=[])=>(await q(t,s,a))[0];
const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
const conflict=m=>{throw bizErr('E_TY_CONFLICT',m);};
const deny=()=>{throw bizErr('E_TY_FORBIDDEN','缺少高级假期功能与数据范围授权');};
const same=(a,b)=>String(a)===String(b);
const AUTHORIZATION=Symbol('advanced-leave-complete-authorization');
const PROJECTED=Symbol('advanced-leave-projected-result');
async function platformFor(t){
 if(!(await one(t,"SELECT to_regclass('public.ty_auth_grant')IS NOT NULL ok"))?.ok)return null;
 try{const p=await import('./platform-core.mjs');if(typeof p.authorization!=='function'||typeof p.requireAccess!=='function')deny();return p;}catch{throw bizErr('E_TY_FORBIDDEN','统一授权已安装但假期授权适配未就绪，不能回退旧范围放行');}
}
const FIELD_FAMILY={salary:new Set(['target','normal_covered','adopted','delta','cash_unit_rate','gross_target','gross_numerator','gross_denominator','normal_daily_covered','daily_rate_numerator','daily_rate_denominator','wage_basis','result_data','source_data']),medical:new Set(['qualifications','evidence_ref','facts','reason']),identity:new Set(['full_name','person_number','person_id'])};
const FINANCIAL_METADATA=new Set(['id','account_id','obligation_id','revision','source_revision','status','currency','created_by','approved_by','created_at','approved_at','execution_actor_id','workflow_instance_id','kind']);
function grantField(g,field,resource){if(g.source==='built_in_baseline')return true;const denyFields=g.fields_deny||[],allowFields=g.fields_allow||[],parts=field.split('.'),leaf=parts.at(-1),alias=resource!=='advanced_leave_payroll'?({target:'granted',delta:'granted',expire:'expired',available_before:'available',available_after:'available'}[leaf]||leaf):leaf;if(denyFields.includes(field)||denyFields.includes(leaf)||denyFields.includes(alias)||resource==='advanced_leave_payroll'&&denyFields.includes('salary')&&!FINANCIAL_METADATA.has(leaf))return false;for(const[family,fields]of Object.entries(FIELD_FAMILY))if((family!=='salary'||resource==='advanced_leave_payroll')&&denyFields.includes(family)&&(parts.some(p=>fields.has(p))||family==='salary'&&parts[0]==='payload'))return false;return allowFields.includes('*')||allowFields.includes(field)||allowFields.includes(leaf)||allowFields.includes(alias)||parts.some((_,i)=>allowFields.includes(parts.slice(0,i+1).join('.')));}
function fieldsInDecision(d,fields,resource){return d.allowed&&(d.allowing_grants||[]).some(g=>fields.every(f=>grantField(g,f,resource)));}
const iso=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const json=v=>JSON.stringify(v);
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const hash=v=>createHash('sha256').update(json(canonical(v))).digest('hex');
function text(v,name,min=1){if(typeof v!=='string'||v.trim().length<min||v.length>2000)bad(`${name}必填且格式有效`);return v.trim();}
function date(v,name='日期'){if(!/^\d{4}-\d{2}-\d{2}$/.test(v||'')||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)bad(`${name}须为有效ISO日期`);return v;}
function decimal(v,{positive=false,negative=true}={}){let out;try{out=exactDecimal(v);}catch{bad('数量必须是精确十进制文本');}if(compareDecimal(out,v)!==0)bad('数量最多4位小数');if(positive&&compareDecimal(out,'0')<=0||!negative&&compareDecimal(out,'0')<0)bad('数量超出范围');return out;}
// JSON extraction keeps 211-only regressions compatible before lifecycle columns
// are installed, while all domains use the same exact supply/consumption ledger.
const lotAvailableSQL=(alias='l')=>`${alias}.granted+coalesce((to_jsonb(${alias})->>'advanced')::numeric,0)+coalesce((to_jsonb(${alias})->>'transferred_in')::numeric,0)-${alias}.held-${alias}.allocated-${alias}.taken-${alias}.cash_reserved-${alias}.expired-coalesce((to_jsonb(${alias})->>'converted')::numeric,0)-coalesce((to_jsonb(${alias})->>'transferred_out')::numeric,0)`;
const lotExpiresSQL=(alias='l')=>`coalesce((to_jsonb(${alias})->>'effective_expires_on')::date,${alias}.expires_on)`;
const lifecycleFields=l=>({...l,advanced:l.advanced||'0.0000',transferred_in:l.transferred_in||'0.0000',transferred_out:l.transferred_out||'0.0000',converted:l.converted||'0.0000',source_protection:l.source_protection||'none'});
const lotAvailable=l=>[l.held,l.allocated,l.taken,l.cash_reserved,l.expired,l.converted||'0',l.transferred_out||'0'].reduce((n,v)=>decimalSubtract(n,v),[l.granted,l.advanced||'0',l.transferred_in||'0'].reduce((n,v)=>decimalAdd(n,v),'0'));
async function emit(t,gid,key,type,payload,actor){await t.query('INSERT INTO ty_leave_outbox(group_id,event_key,event_type,payload,actor_id)VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING',[gid,key,type,json(payload),actor]);}
async function receipt(t,userId,operation,operationId,payload){text(operationId,'操作幂等号');await t.query('SELECT id FROM sys_account WHERE id=$1 FOR UPDATE',[userId]);const old=await one(t,'SELECT * FROM ty_leave_command WHERE actor_id=$1 AND operation=$2 AND operation_key=$3',[userId,operation,operationId]);if(old&&old.payload_hash!==hash(payload))conflict('同一操作号的请求内容不同');return old?{...old.result,replayed:true}:null;}
async function saveReceipt(t,userId,operation,operationId,payload,result){await t.query('INSERT INTO ty_leave_command(actor_id,operation,operation_key,payload_hash,result)VALUES($1,$2,$3,$4,$5::jsonb)',[userId,operation,operationId,hash(payload),json(result)]);return result;}
async function auth(t,userId,resource,row,write=true,{self=false,action=write?(resource==='advanced_leave_approve'?'approve':'write'):'read',fields=[]}={}){
 const a=await accessFor(t,userId),p=a.persona;
 if(p&&['vendor_contact','outsource_hr','outsourced_staff'].includes(p.profile_code))deny();
 if(a.selfOnly&&!self)deny();
 if(write&&p?.profile_code==='boss')deny();
 if(p?.profile_code==='config_admin'&&resource!=='advanced_leave_config')deny();
 if(self&&(!p?.person_id||!same(p.person_id,row.person_id)||!same(p.group_id,row.group_id)))deny();
 const platform=await platformFor(t);if(platform){const decision=await platform.requireAccess(t,userId,resource,action,{group_id:row.group_id,company_id:row.company_id||null,person_id:row.person_id||null,department_id:row.department_id||null,fields});if(!fieldsInDecision(decision,fields,resource))deny();return{...a,[AUTHORIZATION]:{platform,decisions:[decision],resource,action}};}
 if(!(await one(t,'SELECT fn_role_can($1,$2,$3) ok',[userId,resource,write?'write':'read']))?.ok)deny();
 if(self)return a;
 if(a.selfOnly)deny();
 // Configuration's platform capability does not leak into business writes.
 if(resource==='advanced_leave_config'&&a.platformAdmin)return a;
 if(!a.row(row,write))deny();return a;
}
async function employment(t,id){const e=await one(t,'SELECT e.*,c.ledger_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id WHERE e.id=$1',[id]);if(!e)bad('没有可核对的公司关系');return e;}
async function account(t,userId,id,resource='advanced_leave_manage',write=true,self=false,options={}){
 if(self&&resource!=='advanced_leave_manage')deny();
 const r=await one(t,`SELECT a.*,r.group_id,r.person_id,r.legal_employer_key,r.jurisdiction,r.valid_from relationship_from,r.valid_to relationship_to,r.qualifications
 FROM ty_leave_account a JOIN ty_leave_relationship r ON r.id=a.relationship_id WHERE a.id=$1`,[id]);if(!r)throw bizErr('E_TY_NOT_FOUND','假期账户不存在');
 await t.query('SELECT id FROM ty_leave_relationship WHERE id=$1 FOR UPDATE',[r.relationship_id]);
 const es=await q(t,'SELECT e.*,c.ledger_id FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id JOIN ty_company c ON c.id=e.company_id WHERE x.relationship_id=$1',[r.relationship_id]);
 if(!es.length)bad('尚未关联已核实的公司关系');
 const decisions=[];let platform=null;for(const e of es){const result=await auth(t,userId,self?'advanced_leave_self':resource,{...e,person_id:r.person_id},write,{...options,self});if(result[AUTHORIZATION]){platform=result[AUTHORIZATION].platform;decisions.push(...result[AUTHORIZATION].decisions);}}
 // One lock order across grants, reservations, imports and corrections avoids a
 // relationship/account inversion on real PostgreSQL (WASM alone cannot prove it).
 const current=await one(t,'SELECT * FROM ty_leave_account WHERE id=$1 FOR UPDATE',[id]);
 return{...r,...current,employments:es,...(platform?{[AUTHORIZATION]:{platform,decisions,resource:self?'advanced_leave_self':resource,action:options.action||(write?(resource==='advanced_leave_approve'?'approve':'write'):'read')}}:{})};
}
// Internal integration seam, never registered as a browser command. The caller
// selects a fixed business resource; configuration access cannot read this data.
export async function accountContext(t,{userId,accountId,resource='advanced_leave_manage',write=true,selfAllowed=false,action,fields=[]}){
 if(!['advanced_leave_manage','advanced_leave_approve','advanced_leave_payroll'].includes(resource))deny();
 const identity=await accessFor(t,userId),self=selfAllowed&&identity.selfOnly;if(identity.selfOnly&&!self)deny();
 return{...await account(t,userId,accountId,resource,write,self,{action:action||(write?(resource==='advanced_leave_approve'?'approve':'write'):'read'),fields}),self};
}
export async function projectAccountRow(t,{context:ctx,row,resource=null}){
 const platform=await platformFor(t);if(!platform)return row;const meta=ctx?.[AUTHORIZATION];if(!meta||meta.action!=='read'||resource&&resource!==meta.resource)deny();
 const visible=path=>meta.decisions.every(d=>fieldsInDecision(d,[path],meta.resource));
 const walk=(value,prefix='')=>{if(value===null||typeof value!=='object'||value instanceof Date)return value;if(Array.isArray(value))return value.map(v=>walk(v,prefix));const out={};for(const[k,v]of Object.entries(value)){const path=prefix?`${prefix}.${k}`:k;if(visible(path))out[k]=walk(v,path);}return out;};return walk(row);
}
async function assertGenericLotControl(t,l,{allowZeroPlaceholder=false}={}){
 const installed=(await one(t,"SELECT to_regclass('public.ty_leave_credit_origin')IS NOT NULL ok"))?.ok;
 if(installed&&await one(t,'SELECT 1 ok FROM ty_leave_credit_origin WHERE lot_id=$1',[l.id]))bad('该批次受原加班、预支或结转来源控制，请回原来源核定，不能通用增发或覆盖');
 const s=await one(t,'SELECT rules FROM ty_leave_scheme WHERE id=$1',[l.scheme_id]);if(s?.rules.recurring?.no_balance===true&&!allowZeroPlaceholder)bad('周期工作时段只可凭已批准发生候选取得，不能手工增发或覆盖每日额度');
}
function validateRules(input){
 const r=input.rules;if(!r||Array.isArray(r)||typeof r!=='object')bad('规则须为结构化对象');
 if(!['day','minute'].includes(input.unit)||!['CN','HK'].includes(input.jurisdiction))bad('须明确两地体系及计量单位');
 if(!['roster','calendar'].includes(r.quantity_basis))bad('须选择排班分钟/比例或日历日计算口径');
 if(input.unit==='minute'&&r.quantity_basis!=='roster')bad('分钟假必须依已发布排班计算');
 if(r.step!==undefined)decimal(r.step,{positive:true});if(r.max_quantity!==undefined)decimal(r.max_quantity,{positive:true});
 if(r.recurring!==undefined){const c=r.recurring;if(!c||typeof c!=='object'||Array.isArray(c)||typeof c.enabled!=='boolean'||c.no_balance!==undefined&&typeof c.no_balance!=='boolean'||c.per_occurrence_approval!==undefined&&typeof c.per_occurrence_approval!=='boolean'||c.required_facts!==undefined&&(!Array.isArray(c.required_facts)||c.required_facts.some(f=>typeof f!=='string'||!f.trim())))bad('周期开关、资格字段与审批方式须为明确结构');for(const k of['max_minutes_per_day','max_minutes_per_occurrence','max_authorization_days'])if(c[k]!==undefined&&(!Number.isSafeInteger(c[k])||c[k]<=0))bad('周期分钟/授权天数上限须为正整数');if(c.no_balance===true&&(input.unit!=='minute'||r.quantity_basis!=='roster'))bad('无余额周期工作时段须保留排班分钟计量');}
 if(input.statutory){
  if(input.code==='annual'&&input.unit!=='day')bad('法定年假须保留日权益，分钟计量需有明确日权益换算，不能直接将分钟当法定天数');
  if(!r.legal_rule_ref||!r.legal_review_ref||r.expiry_action!=='legal_review')bad('法定模板须有法规版本、核定依据及到期保护');
  if(r.allow_negative===true||r.forfeit_on_exit===true)bad('人工配置不能取消法定权益');
  if(input.code==='annual'&&input.jurisdiction==='CN'&&(r.proration_denominator!==365||r.proration_rounding!=='floor'))bad('内地法定年假折算必须365及整天下取整');
 }
}
export async function createScheme(t,{userId,input,operationId}){
 validateRules(input);const row={group_id:input.group_id,company_id:input.company_id};
 if(row.company_id){const c=await one(t,'SELECT *,id company_id FROM ty_company WHERE id=$1',[row.company_id]);if(!c||!same(c.group_id,row.group_id))bad('公司与集团不一致');Object.assign(row,c);}
 await auth(t,userId,'advanced_leave_config',row,true,{action:'create',fields:['code','name','jurisdiction','unit','statutory','valid_from','valid_to','rules']});const oldReceipt=await receipt(t,userId,'scheme.create',operationId,input);if(oldReceipt)return oldReceipt;await t.query('SELECT id FROM ty_group WHERE id=$1 FOR UPDATE',[input.group_id]);
 const version=Number((await one(t,'SELECT coalesce(max(version),0)+1 n FROM ty_leave_scheme WHERE group_id=$1 AND code=$2',[input.group_id,input.code])).n);
 const scheme=await one(t,`INSERT INTO ty_leave_scheme(group_id,company_id,code,version,name,jurisdiction,unit,statutory,valid_from,valid_to,rules,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)RETURNING *`,[input.group_id,input.company_id||null,text(input.code,'假种编码'),version,text(input.name,'名称'),input.jurisdiction,input.unit,input.statutory===true,date(input.valid_from),input.valid_to?date(input.valid_to):null,json(input.rules),userId]);return saveReceipt(t,userId,'scheme.create',operationId,input,{scheme});
}
export async function publishScheme(t,{userId,id}){
 const s=await one(t,'SELECT * FROM ty_leave_scheme WHERE id=$1 FOR UPDATE',[id]);if(!s)bad('规则不存在');
 const c=s.company_id?await one(t,'SELECT *,id company_id FROM ty_company WHERE id=$1',[s.company_id]):s;
 await auth(t,userId,'advanced_leave_config',c,true,{action:'approve',fields:['rules','status']});if(s.status==='published')return{scheme:s,replayed:true};if(await sameHuman(t,s.created_by,userId))throw bizErr('E_LEAVE_SELF_APPROVE','规则发布须由另一有权人员复核');validateRules(s);
 await t.query('SELECT id FROM ty_group WHERE id=$1 FOR UPDATE',[s.group_id]);
 const periods=await q(t,`SELECT p.*,x.version,x.unit,x.jurisdiction,x.statutory FROM ty_leave_scheme_period p JOIN ty_leave_scheme x ON x.id=p.scheme_id WHERE p.group_id=$1 AND p.code=$2 AND p.company_scope=$3 ORDER BY p.valid_from FOR UPDATE OF p`,[s.group_id,s.code,s.company_id||0]);
 if(periods.some(p=>p.unit!==s.unit||p.jurisdiction!==s.jurisdiction||p.statutory!==s.statutory))bad('同一假种不能用发布版本直接改变计量、地区或法定性质，须专门迁移');
 if(periods.some(p=>iso(p.valid_from)>=iso(s.valid_from)||Number(p.version)>=Number(s.version)))conflict('新发布版本须在既有版本之后生效，不得倒插历史');
 const predecessor=periods.at(-1),scheme=await one(t,"UPDATE ty_leave_scheme SET status='published',approved_by=$2,published_at=clock_timestamp() WHERE id=$1 RETURNING *",[id,userId]);
 if(predecessor&&(!predecessor.valid_to||iso(predecessor.valid_to)>iso(s.valid_from)))await t.query('UPDATE ty_leave_scheme_period SET valid_to=$2,superseded_by=$3 WHERE scheme_id=$1',[predecessor.scheme_id,s.valid_from,id]);
 await t.query('INSERT INTO ty_leave_scheme_period(scheme_id,group_id,code,company_scope,valid_from,valid_to,original_valid_to)VALUES($1,$2,$3,$4,$5,$6,$6)',[id,s.group_id,s.code,s.company_id||0,s.valid_from,s.valid_to]);
 await emit(t,s.group_id,`scheme:${id}:published`,'leave.scheme.published',{scheme_id:id,predecessor_scheme_id:predecessor?.scheme_id||null,predecessor_previous_to:predecessor?.valid_to||null,effective_from:s.valid_from},userId);return{scheme};
}
export async function verifyRelationship(t,{userId,input}){
 const ids=[...new Set(input.employment_ids||[])];if(!ids.length)bad('须选择已核实的公司关系段');const es=[];
 for(const id of ids){const e=await employment(t,id);await auth(t,userId,'advanced_leave_manage',e,true,{fields:['person_id','legal_employer_key','qualifications','evidence_ref','valid_from','valid_to']});if(e.status==='cancelled'||!same(e.person_id,input.person_id)||!same(e.group_id,input.group_id))bad('公司关系与永久人员不一致');es.push(e);}
 const source=text(input.source_key,'实际关系来源键'),evidence=text(input.evidence_ref,'核实证据',4),from=date(input.valid_from),to=input.valid_to?date(input.valid_to):null;
 if(es.some(e=>iso(e.hire_date)<from||(to&&(!e.leave_date||iso(e.leave_date)>=to))))bad('核实的实际关系期间未覆盖公司关系段');
 await t.query('SELECT id FROM ty_person WHERE id=$1 FOR UPDATE',[input.person_id]);
 const old=await one(t,'SELECT * FROM ty_leave_relationship WHERE group_id=$1 AND source_key=$2 FOR UPDATE',[input.group_id,source]);
 if(old){
  if(!same(old.person_id,input.person_id)||old.legal_employer_key!==input.legal_employer_key||old.jurisdiction!==input.jurisdiction||hash(old.qualifications)!==hash(input.qualifications||{})||iso(old.valid_from)!==from||iso(old.valid_to||'')!==(to||''))conflict('实际关系来源键已有不同内容，资格更正须另行核定');
  const previous=await q(t,'SELECT e.*,c.ledger_id FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id JOIN ty_company c ON c.id=e.company_id WHERE x.relationship_id=$1',[old.id]);for(const e of previous)await auth(t,userId,'advanced_leave_manage',e,true,{fields:['person_id','legal_employer_key','qualifications','evidence_ref','valid_from','valid_to']});
  for(const e of es)await t.query('INSERT INTO ty_leave_relationship_employment VALUES($1,$2) ON CONFLICT(relationship_id,employment_id)DO NOTHING',[old.id,e.id]);
  await emit(t,input.group_id,`relationship:${old.id}:segments:${hash(ids)}`,'leave.relationship.segments_verified',{relationship_id:old.id,employment_ids:ids,evidence_ref:evidence},userId);return{relationship:old,replayed:es.every(e=>previous.some(p=>same(p.id,e.id)))};
 }
 const relationship=await one(t,`INSERT INTO ty_leave_relationship(group_id,person_id,source_key,legal_employer_key,jurisdiction,valid_from,valid_to,verified_by,evidence_ref,qualifications)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)RETURNING *`,[input.group_id,input.person_id,source,text(input.legal_employer_key,'实际雇主键'),input.jurisdiction,from,to,userId,evidence,json(input.qualifications||{})]);
 for(const e of es)await t.query('INSERT INTO ty_leave_relationship_employment VALUES($1,$2)',[relationship.id,e.id]);await emit(t,input.group_id,`relationship:${relationship.id}`,'leave.relationship.verified',{relationship_id:relationship.id,employment_ids:ids},userId);return{relationship};
}
async function schemeFor(t,a,id,on){const s=await one(t,'SELECT s.*,p.valid_to effective_to FROM ty_leave_scheme s JOIN ty_leave_scheme_period p ON p.scheme_id=s.id WHERE s.id=$1',[id]);if(!s||s.status!=='published'||!same(s.group_id,a.group_id)||s.code!==a.code||s.unit!==a.unit||s.jurisdiction!==a.jurisdiction||iso(s.valid_from)>on||s.effective_to&&iso(s.effective_to)<=on||s.company_id&&!a.employments.some(e=>same(e.company_id,s.company_id)))bad('该日没有适用的已发布假期规则');return s;}
export async function grantCumulative(t,{userId,input}){
 const r=await one(t,'SELECT * FROM ty_leave_relationship WHERE id=$1 FOR UPDATE',[input.relationship_id]);if(!r)bad('实际关系未核实');
 const s=await one(t,'SELECT * FROM ty_leave_scheme WHERE id=$1',[input.scheme_id]);if(!s||s.code!==input.code)bad('发放规则不匹配');
 await t.query('INSERT INTO ty_leave_account(relationship_id,code,unit)VALUES($1,$2,$3)ON CONFLICT DO NOTHING',[r.id,s.code,s.unit]);
 const ar=await one(t,'SELECT id FROM ty_leave_account WHERE relationship_id=$1 AND code=$2',[r.id,s.code]);const a=await account(t,userId,ar.id,'advanced_leave_manage',true,false,{fields:['granted','evidence_ref']}),effectiveDate=date(input.valid_from);await schemeFor(t,a,s.id,input.as_of?date(input.as_of):effectiveDate);
 if(effectiveDate<iso(r.valid_from)||r.valid_to&&effectiveDate>=iso(r.valid_to)||!a.employments.some(e=>e.status!=='cancelled'&&iso(e.hire_date)<=effectiveDate&&(!e.leave_date||iso(e.leave_date)>=effectiveDate)))bad('权益起日须落在已核实实际关系和有效公司关系内');
 const payload={total:decimal(input.total,{negative:false}),numerator:decimal(input.numerator??'1',{negative:false}),denominator:decimal(input.denominator??'1',{positive:true}),valid_from:input.valid_from,expires_on:input.expires_on||null,entitlement_year:input.entitlement_year,scheme_id:s.id,as_of:input.as_of||input.valid_from};
 if(s.statutory&&s.code==='annual'){
  let minimum;if(s.jurisdiction==='CN'){const facts=r.qualifications;if(facts.continuous_work_12_months!==true||facts.service_years===undefined)bad('法定年假资格或累计工龄待核');const band=cnAnnualBand({serviceYears:facts.service_years});minimum=input.proration_calendar_days!==undefined?cnAnnualProration({calendarDays:input.proration_calendar_days,annualDays:band}).days:band;}else{if(r.qualifications.completed_continuous_years===undefined)bad('香港连续合约年资待核');minimum=hkAnnualDays({completedYears:r.qualifications.completed_continuous_years});}
  if(compareDecimal(payload.total,minimum)<0)bad('配置发放额低于已核定法定目标');
 }
 await t.query(`INSERT INTO ty_leave_lot(account_id,stable_key,scheme_id,entitlement_year,valid_from,expires_on,statutory)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT DO NOTHING`,[a.id,text(input.stable_key,'稳定权益键'),s.id,input.entitlement_year,payload.valid_from,input.expires_on?date(input.expires_on):null,s.statutory]);
 const l=await one(t,'SELECT * FROM ty_leave_lot WHERE account_id=$1 AND stable_key=$2 FOR UPDATE',[a.id,input.stable_key]);
 await assertGenericLotControl(t,l,{allowZeroPlaceholder:compareDecimal(payload.total,'0')===0});
 if(l.statutory!==s.statutory||iso(l.valid_from)!==payload.valid_from||iso(l.expires_on||'')!==(payload.expires_on||'')||Number(l.entitlement_year)!==Number(input.entitlement_year))conflict('稳定权益批次不可改变法定性质或期间重建');
 const key=text(input.event_key,'发放幂等键'),old=await one(t,'SELECT * FROM ty_leave_event WHERE lot_id=$1 AND event_key=$2',[l.id,key]);if(old){if(hash(old.payload)!==hash(payload))conflict('同一发放幂等键内容不同');return{account_id:a.id,lot:l,event:old,replayed:true};}
 const prior=(await one(t,"SELECT coalesce(sum(delta),0)::text n FROM ty_leave_event WHERE lot_id=$1 AND event_kind='grant'",[l.id])).n;
 const calc=cumulativeGrant({...payload,alreadyGranted:prior,scale:4,rounding:s.rules.grant_rounding||'floor',step:s.rules.grant_step||null});if(compareDecimal(calc.delta,'0')<0)conflict('累计目标下降须先预演并批准人工差额');
 await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id,payload)VALUES($1,$2,'grant',$3,$4,$5,$6::jsonb)",[l.id,key,calc.delta,text(input.evidence_ref,'发放依据',4),userId,json(payload)]);
 await emit(t,a.group_id,`grant:${l.id}:${key}`,'leave.entitlement.granted',{lot_id:l.id,...calc},userId);return{account_id:a.id,lot:await one(t,'SELECT * FROM ty_leave_lot WHERE id=$1',[l.id]),...calc};
}
export async function balance(t,{userId,accountId,self=false,on=null}){self=self||(await accessFor(t,userId)).selfOnly;const a=await account(t,userId,accountId,'advanced_leave_manage',false,self);const lots=(await q(t,`SELECT l.*,(${lotAvailableSQL()})::text available,${lotExpiresSQL()} effective_expires_on FROM ty_leave_lot l WHERE account_id=$1 ORDER BY ${lotExpiresSQL()} NULLS LAST,id`,[a.id])).map(lifecycleFields);return{account:a,lots,totals:lots.reduce((s,l)=>Object.fromEntries(['granted','advanced','transferred_in','transferred_out','converted','held','allocated','taken','cash_reserved','expired','available'].map(k=>[k,decimalAdd(s[k]||'0',l[k])])),{}),on:on||null};}
async function quantityFor(t,a,s,input){
 const start=new Date(input.starts_at),end=new Date(input.ends_at);if(!Number.isFinite(+start)||!Number.isFinite(+end)||start>=end||!/[Zz]|[+-]\d\d:\d\d$/.test(input.starts_at)||!/[Zz]|[+-]\d\d:\d\d$/.test(input.ends_at))bad('请使用含时区且结束晚于开始的时间');
 if(start.getTime()%60000||end.getTime()%60000)bad('假期须精确到分钟');
 const protectedCNAnnual=s.statutory&&s.jurisdiction==='CN'&&s.code==='annual';
 const personalCalendar=s.rules.personnel_calendars?.[String(input.employment_id)];
 if(personalCalendar&&((s.rules.holiday_dates!==undefined&&!Array.isArray(s.rules.holiday_dates))||!Array.isArray(personalCalendar.holiday_dates)))bad('适用个人法定日历格式待核，不能扣假');
 const calendar=personalCalendar?{...personalCalendar,holiday_dates:[...new Set([...(s.rules.holiday_dates||[]),...(personalCalendar.holiday_dates||[])])]}:s.rules;
 const firstDate=new Date(+start+8*3600000).toISOString().slice(0,10),lastDate=new Date(+end-1+8*3600000).toISOString().slice(0,10);
 if(protectedCNAnnual&&(calendar.calendar_status!=='verified'||!calendar.calendar_version||!Array.isArray(calendar.holiday_dates)||!Array.isArray(calendar.rest_dates)||!calendar.calendar_valid_from||!calendar.calendar_valid_to||date(calendar.calendar_valid_from)>firstDate||date(calendar.calendar_valid_to)<=lastDate))bad('该实际关系及申请期间的法定节日和休息日日历待核，暂不扣年假；请先补核适用日历，不能改记旷工或无薪');
 if(protectedCNAnnual)for(const d of[...calendar.holiday_dates,...calendar.rest_dates])date(d);
 let quantity,snapshot;
 if(s.rules.quantity_basis==='roster'){
  const segments=await q(t,`SELECT s.id,to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00' start,to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00' "end",d.work_date,p.status
   FROM ty_roster_segment s JOIN ty_roster_day d ON d.id=s.day_id JOIN ty_roster_period p ON p.id=d.period_id
   WHERE d.employment_id=$1 AND NOT s.overtime AND s.start_at<($3::timestamptz AT TIME ZONE 'Asia/Shanghai') AND s.end_at>($2::timestamptz AT TIME ZONE 'Asia/Shanghai') FOR SHARE OF s,d,p`,[input.employment_id,input.starts_at,input.ends_at]);
  if(!segments.length||segments.some(s=>!['published','closed'].includes(s.status)))bad('须先具备已发布的有效排班，不能由客户端自报工时');
  const counted=protectedCNAnnual?excludeCalendarDates({segments,excludedDates:[...calendar.holiday_dates,...calendar.rest_dates]}):{segments,excluded:[]};
  const minutes=multiShiftMinutes({segments:counted.segments,requestStart:input.starts_at,requestEnd:input.ends_at});
  const excludedMinutes=protectedCNAnnual?multiShiftMinutes({segments,requestStart:input.starts_at,requestEnd:input.ends_at})-minutes:0;
  if(s.unit==='minute')quantity=String(minutes);else{
   // Per-work-date denominator comes from the complete published roster, never a global eight-hour day.
   quantity='0';for(const d of [...new Set(segments.map(x=>iso(x.work_date)))]){const all=await q(t,`SELECT to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00' start,to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI:SS')||'+08:00' "end" FROM ty_roster_segment s JOIN ty_roster_day d ON d.id=s.day_id WHERE d.employment_id=$1 AND d.work_date=$2 AND NOT s.overtime FOR SHARE OF s,d`,[input.employment_id,d]);const full=multiShiftMinutes({segments:all,requestStart:all.reduce((v,x)=>x.start<v?x.start:v,all[0].start),requestEnd:all.reduce((v,x)=>x.end>v?x.end:v,all[0].end)}),eligible=protectedCNAnnual?excludeCalendarDates({segments:all,excludedDates:[...calendar.holiday_dates,...calendar.rest_dates]}).segments:all,part=multiShiftMinutes({segments:eligible,requestStart:input.starts_at,requestEnd:input.ends_at});quantity=decimalAdd(quantity,cumulativeGrant({total:'1',numerator:String(part),denominator:String(full),scale:4,rounding:'half_up'}).target);}
  }snapshot={segment_ids:segments.map(x=>x.id),minutes,...(protectedCNAnnual?{calendar_version:calendar.calendar_version,calendar_status:calendar.calendar_status,calendar_scope:s.rules.personnel_calendars?.[String(input.employment_id)]?'employment':'published_scheme',counted_segments:counted.segments.map(x=>({id:x.id,start:x.start,end:x.end,calendar_date:x.calendar_date})),excluded_segments:counted.excluded.filter(x=>Date.parse(x.start)<+end&&Date.parse(x.end)>+start).map(x=>({id:x.id,start:new Date(Math.max(Date.parse(x.start),+start)).toISOString(),end:new Date(Math.min(Date.parse(x.end),+end)).toISOString(),calendar_date:x.calendar_date,reason:calendar.holiday_dates.includes(x.calendar_date)?'statutory_holiday':'appointed_rest_day'})),excluded_minutes:excludedMinutes,statutory_calendar_step_exception:excludedMinutes>0}:{})};
 }else{
  // Calendar-day leave requires whole local midnight boundaries, and an explicit
  // versioned calendar. HK counts collisions and leaves replacement tasks alive.
  const local=v=>new Date(+v+8*3600000).toISOString();const aDate=local(start),bDate=local(end);if(!aDate.endsWith('T00:00:00.000Z')||!bDate.endsWith('T00:00:00.000Z'))bad('日历日假须为本地午夜起止');
  const dates=[];for(let n=+start;n<+end;n+=86400000){const d=new Date(n+8*3600000).toISOString().slice(0,10);if(s.jurisdiction==='HK'||!calendar.rest_dates?.includes(d)&&!calendar.holiday_dates?.includes(d))dates.push(d);}
  if(s.jurisdiction==='CN'&&(!s.rules.calendar_version||!Array.isArray(s.rules.rest_dates)||!Array.isArray(s.rules.holiday_dates)))bad('内地日历须核定休息日和法定假日版本');
  quantity=String(dates.length);snapshot={calendar_version:calendar.calendar_version,dates,replacement_rest_dates:s.jurisdiction==='HK'?dates.filter(d=>calendar.rest_dates?.includes(d)):[],replacement_holiday_dates:s.jurisdiction==='HK'?dates.filter(d=>calendar.holiday_dates?.includes(d)):[]};
 }
 if(protectedCNAnnual&&compareDecimal(quantity,'0')===0)bad('该区间仅含已核法定节日或本人休息日，无需扣法定年假；请按法定假日、休息日及实际排班办理，不得改记旷工或无薪');
 quantity=decimal(quantity,{positive:true});if(s.rules.step&&compareDecimal(quantity,s.rules.step)<0&&!snapshot.statutory_calendar_step_exception)bad('小于最小申请单位');
 if(s.rules.max_quantity&&compareDecimal(quantity,s.rules.max_quantity)>0)bad('超出单次申请上限');return{quantity,snapshot,start,end};
}
async function validateRecurringSubmission(t,a,s,input,calc){
 if(!s.rules.recurring?.enabled)return;
 if(!(await one(t,"SELECT to_regclass('public.ty_leave_recurring_occurrence')IS NOT NULL ok"))?.ok)bad('周期服务尚未安装，请先完成授权配置，不能手工把周期工作时段当普通假期扣减');
 const id=Number(input.recurring_occurrence_id);if(!Number.isSafeInteger(id)||id<1)bad('请从已批准的周期发生候选提交，普通请假入口不能绕过周期资格和每日权益');
 const o=await one(t,`SELECT o.*,z.account_id authorization_account,z.scheme_id,z.employment_id,z.valid_from authorization_from,z.valid_to authorization_to,z.status authorization_status,z.stable_key authorization_root,z.revision authorization_revision,p.status approval_status,p.id approval_proposal_id FROM ty_leave_recurring_occurrence o JOIN ty_leave_recurring_authorization z ON z.id=o.authorization_id JOIN ty_leave_lifecycle_proposal p ON p.id=z.proposal_id WHERE o.id=$1 FOR UPDATE OF o`,[id]);
 if(!o||!same(o.account_id,a.id)||!same(o.authorization_account,a.id)||!same(o.scheme_id,s.id)||!same(o.employment_id,input.employment_id)||o.authorization_status!=='active'||o.approval_status!=='approved'||o.status!=='candidate'||Number(o.source_revision)!==Number(o.authorization_revision)||iso(o.work_date)<iso(o.authorization_from)||iso(o.work_date)>=iso(o.authorization_to)||Date.parse(o.starts_at)!==Date.parse(input.starts_at)||Date.parse(o.ends_at)!==Date.parse(input.ends_at))bad('周期候选、实际关系、规则、时窗或批准版本不一致，请重建候选后办理');
 if(s.rules.quantity_basis!=='roster'||!Number.isSafeInteger(calc.snapshot.minutes)||calc.snapshot.minutes<=0)bad('周期发生须使用已核排班分钟，不能用客户端自报天数替代');
 for(const f of s.rules.recurring.required_facts||[])if(a.qualifications[f]!==true)bad('发生日周期资格尚未核定');
 const until=s.rules.recurring.qualification_valid_to_fact;if(until&&(!a.qualifications[until]||iso(o.work_date)>=date(a.qualifications[until])))bad('该次发生已超已核资格期限');
 const daily=String(s.rules.recurring.max_minutes_per_day||s.rules.recurring.max_minutes_per_occurrence||60),perOccurrence=String(s.rules.recurring.max_minutes_per_occurrence||60);
 if(s.statutory&&s.jurisdiction==='CN'&&s.rules.recurring.legal_type==='nursing'){
  const children=Number(a.qualifications.nursing_children);if(!until||!Number.isSafeInteger(children)||children<1||compareDecimal(daily,String(children*60))<0||s.rules.recurring.no_balance!==true||s.rules.recurring.pay_semantics&&s.rules.recurring.pay_semantics!=='paid_worktime')bad('哺乳资格期限、每日法定工作时段或带薪语义待核，不能改成普通无薪假');
 }
 const prior=(await one(t,`SELECT coalesce(sum((r.facts->>'minutes')::numeric),0)::text n FROM ty_leave_recurring_request_link x JOIN ty_leave_request r ON r.id=x.request_id JOIN ty_leave_recurring_occurrence o ON o.id=x.occurrence_id JOIN ty_leave_recurring_authorization z ON z.id=x.authorization_id WHERE o.account_id=$1 AND z.stable_key=$2 AND o.work_date=$3 AND r.status IN('pending','approved','taken')`,[a.id,o.authorization_root,o.work_date])).n;
 if(compareDecimal(String(calc.snapshot.minutes),perOccurrence)>0||compareDecimal(decimalAdd(prior,String(calc.snapshot.minutes)),daily)>0)bad('周期根当日已批、待批及已休合计超额，不能换时窗键、入口或修订重复领取');
 Object.assign(calc.snapshot,{recurring_occurrence_id:o.id,recurring_authorization_id:o.authorization_id,recurring_root_key:o.root_key,approval_basis_proposal_id:o.approval_proposal_id,pay_semantics:s.statutory&&s.jurisdiction==='CN'&&s.rules.recurring.legal_type==='nursing'?'paid_worktime':s.rules.recurring.pay_semantics||'configured_leave'});
}
export async function submitRequest(t,{userId,input,self=false}){
 self=self||(await accessFor(t,userId)).selfOnly;
 const a=await account(t,userId,input.account_id,'advanced_leave_manage',true,self,{action:'submit',fields:['quantity','starts_at','ends_at','evidence_ref']}),e=await employment(t,input.employment_id);
 await t.query('SELECT id FROM ty_leave_relationship WHERE id=$1 FOR UPDATE',[a.relationship_id]);
 if(!a.employments.some(x=>same(x.id,e.id)))bad('公司关系不属于该实际关系账户');
 const key=text(input.request_key,'申请幂等键'),old=await one(t,'SELECT * FROM ty_leave_request WHERE account_id=$1 AND request_key=$2',[a.id,key]);
 if(old){if(old.facts.input_hash!==hash({...input,request_key:undefined}))conflict('同一申请键内容不同');return{request:old,replayed:true};}
 if(!Number.isFinite(Date.parse(input.starts_at))||!Number.isFinite(Date.parse(input.ends_at)))bad('申请起止时间无效');
 const on=new Date(Date.parse(input.starts_at)+8*3600000).toISOString().slice(0,10),last=new Date(Date.parse(input.ends_at)-1+8*3600000).toISOString().slice(0,10),s=await schemeFor(t,a,input.scheme_id,on);
 const overlap=await one(t,`SELECT r.id FROM ty_leave_request r JOIN ty_leave_account a ON a.id=r.account_id WHERE a.relationship_id=$1 AND r.status IN('pending','approved','taken') AND tstzrange(r.starts_at,r.ends_at,'[)')&&tstzrange($2::timestamptz,$3::timestamptz,'[)')`,[a.relationship_id,input.starts_at,input.ends_at]);if(overlap)conflict('同一实际关系已有重叠假期申请');
 if(s.company_id&&!same(s.company_id,e.company_id))bad('此规则不适用该公司');
 if(e.status==='cancelled'||on<iso(e.hire_date)||e.leave_date&&last>iso(e.leave_date)||on<iso(a.relationship_from)||a.relationship_to&&last>=iso(a.relationship_to)||s.effective_to&&last>=iso(s.effective_to))bad('申请跨越关系或规则失效边界，须分段办理');
 for(const f of s.rules.required_qualification_facts||[])if(a.qualifications[f]!==true)bad(`资格事实${f}尚未核定`);
 if(s.rules.evidence_required&&!input.evidence_ref)bad('此假种必须提供证明');
 const calc=await quantityFor(t,a,s,input);if(input.quantity!==undefined&&compareDecimal(input.quantity,calc.quantity)!==0)bad('客户端数量与服务端权威折算不一致');
 await validateRecurringSubmission(t,a,s,input,calc);
 if(s.rules.step&&!calc.snapshot.statutory_calendar_step_exception){const r=await one(t,'SELECT mod($1::numeric,$2::numeric)=0 ok',[calc.quantity,s.rules.step]);if(!r.ok)bad('申请数量不符合最小步长');}
 const lots=await q(t,`SELECT l.*,(${lotAvailableSQL()})::text available FROM ty_leave_lot l WHERE account_id=$1 AND valid_from<=$2::date AND (${lotExpiresSQL()} IS NULL OR ${lotExpiresSQL()}>=$3::date) AND expiry_state='active' ORDER BY ${lotExpiresSQL()} NULLS LAST,id FOR UPDATE`,[a.id,on,last]);
 if(compareDecimal(lots.reduce((n,l)=>decimalAdd(n,l.available),'0'),calc.quantity)<0)throw bizErr('E_LEAVE_OVER_QUOTA','可用批次余额不足');
 const request=await one(t,`INSERT INTO ty_leave_request(account_id,scheme_id,employment_id,request_key,starts_at,ends_at,quantity,facts,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)RETURNING *`,[a.id,s.id,e.id,key,input.starts_at,input.ends_at,calc.quantity,json({input_hash:hash({...input,request_key:undefined}),quantity_basis:s.rules.quantity_basis,...calc.snapshot,evidence_ref:input.evidence_ref||null,rule_version:s.version}),userId]);
 let remaining=calc.quantity;for(const l of lots){if(compareDecimal(remaining,'0')<=0)break;const n=compareDecimal(l.available,remaining)<0?l.available:remaining;if(compareDecimal(n,'0')<=0)continue;await t.query("INSERT INTO ty_leave_allocation(account_id,request_id,lot_id,quantity,state)VALUES($1,$2,$3,$4,'held')",[a.id,request.id,l.id,n]);remaining=decimalSubtract(remaining,n);}
 await emit(t,a.group_id,`request:${request.id}:pending`,'leave.approval.requested',{request_id:request.id,person_id:a.person_id},userId);return{request};
}
async function requestContext(t,userId,id,resource='advanced_leave_approve',self=false,options={}){const r=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1',[id]);if(!r)throw bizErr('E_LEAVE_NO_REQUEST','申请不存在');const a=await account(t,userId,r.account_id,resource,true,self,options);const locked=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1 FOR UPDATE',[id]);return{r:locked,a};}
async function requireDirectRequestApproval(t,userId,r,a){
 if(!(await one(t,"SELECT to_regclass('public.ty_workflow_binding')IS NOT NULL ok"))?.ok)return;
 const workflow=await import('./platform-workflow.mjs'),e=a.employments.find(e=>same(e.id,r.employment_id)),s=await one(t,'SELECT code FROM ty_leave_scheme WHERE id=$1',[r.scheme_id]);
 const requirement=await workflow.approvalRequirement(t,{userId,subjectType:'leave_request',groupId:a.group_id,companyId:e?.company_id,kind:s?.code});
 const existing=await one(t,"SELECT 1 ok FROM ty_workflow_instance WHERE subject_type='leave_request'AND subject_id=$1 AND status IN('running','approved')LIMIT 1",[String(r.id)]);
 if(requirement.required||existing)throw bizErr('E_LEAVE_USE_APPROVAL','此请假已绑定审批流程或存在冻结审批实例，请通过原流程回执执行，不能直接审批旁路');
}
export async function decideRequest(t,{userId,id,approve,reason}){if(typeof approve!=='boolean')bad('须明确批准或驳回');const{r,a}=await requestContext(t,userId,id,'advanced_leave_approve',false,{action:'approve',fields:['status','quantity','facts']});await requireDirectRequestApproval(t,userId,r,a);if(await sameHuman(t,r.created_by,userId)||await humanIsPerson(t,userId,a.group_id,a.person_id))throw bizErr('E_LEAVE_SELF_APPROVE','不能审批本人经办申请');if(r.status!=='pending')throw bizErr('E_LEAVE_ALREADY_DECIDED','单据已处理');await t.query('UPDATE ty_leave_allocation SET state=$2 WHERE request_id=$1 AND state=\'held\'',[id,approve?'allocated':'released']);const request=await one(t,'UPDATE ty_leave_request SET status=$2,approved_by=$3 WHERE id=$1 RETURNING *',[id,approve?'approved':'rejected',userId]);await emit(t,a.group_id,`request:${id}:${request.status}`,'leave.approval.decided',{request_id:id,approve,reason:text(reason,'审批意见',4)},userId);return{request};}
export async function settleRequest(t,{userId,id,evidenceRef}){const{r,a}=await requestContext(t,userId,id,'advanced_leave_manage',false,{action:'execute',fields:['taken','quantity','facts','evidence_ref']});if(r.status==='taken')return{request:r,replayed:true};if(r.status!=='approved')conflict('只有已批准申请可以确认实际已休');if(!await one(t,'SELECT 1 ok WHERE $1::timestamptz<=clock_timestamp()',[r.ends_at]))bad('未来批准占用不能提前记为实际已休');text(evidenceRef,'实际已休核对依据',4);await t.query("UPDATE ty_leave_allocation SET state='taken' WHERE request_id=$1 AND state='allocated'",[id]);const request=await one(t,"UPDATE ty_leave_request SET status='taken' WHERE id=$1 RETURNING *",[id]);await emit(t,a.group_id,`request:${id}:taken`,'leave.taken.confirmed',{request_id:id,evidence_ref:evidenceRef},userId);return{request};}
export async function cancelRequest(t,{userId,id,reason,self=false}){self=self||(await accessFor(t,userId)).selfOnly;const{r,a}=await requestContext(t,userId,id,'advanced_leave_manage',self,{action:'cancel',fields:['status','quantity','reason']});text(reason,'取消依据',4);if(r.status==='cancelled')return{request:r,replayed:true};if(!['pending','approved'].includes(r.status))conflict('已休或已驳回申请不可直接取消，须办理有据更正');if(self&&(r.status!=='pending'||!same(r.created_by,userId)))deny();await t.query("UPDATE ty_leave_allocation SET state='released' WHERE request_id=$1 AND state IN('held','allocated')",[id]);const request=await one(t,"UPDATE ty_leave_request SET status='cancelled' WHERE id=$1 RETURNING *",[id]);await emit(t,a.group_id,`request:${id}:cancelled`,'leave.request.cancelled',{request_id:id,reason},userId);return{request};}
export async function previewAdjustment(t,{userId,input,operationId}){
 const found=await one(t,'SELECT account_id FROM ty_leave_lot WHERE id=$1',[input.lot_id]);if(!found)bad('批次不存在');
 const a=await account(t,userId,found.account_id,'advanced_leave_manage',true,false,{fields:['granted','available','evidence_ref','reason']}),old=await receipt(t,userId,'adjustment.preview',operationId,input);if(old)return old;
 const l=await one(t,'SELECT * FROM ty_leave_lot WHERE id=$1 FOR UPDATE',[input.lot_id]);
 await assertGenericLotControl(t,l);const available=lotAvailable(l);
 if(!['delta','target_available'].includes(input.mode))bad('调整模式不支持');
 const value=decimal(input.value),delta=input.mode==='delta'?value:decimalSubtract(value,available);
 if(compareDecimal(decimalAdd(available,delta),'0')<0)bad('调整不能侵占已用及已占用权益');
 if(l.statutory&&compareDecimal(delta,'0')<0&&!input.legal_correction_ref)bad('法定负向更正须补充法律核定依据');
 const adjustment=await one(t,'INSERT INTO ty_leave_adjustment(lot_id,baseline_revision,mode,input_value,delta,evidence_ref,reason,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8)RETURNING *',[l.id,a.revision,input.mode,value,delta,text(input.evidence_ref,'证据',4),text(input.reason,'调整原因',4)+(input.legal_correction_ref?`；核定${input.legal_correction_ref}`:''),userId]);
 return saveReceipt(t,userId,'adjustment.preview',operationId,input,{adjustment,available_before:available,available_after:decimalAdd(available,delta)});
}
export async function applyAdjustment(t,{userId,id}){
 const p=await one(t,'SELECT * FROM ty_leave_adjustment WHERE id=$1',[id]);if(!p)bad('预演不存在');const l=await one(t,'SELECT * FROM ty_leave_lot WHERE id=$1',[p.lot_id]);
 const a=await account(t,userId,l.account_id,'advanced_leave_approve',true,false,{action:'approve',fields:['granted','available','evidence_ref','reason']}),locked=await one(t,'SELECT * FROM ty_leave_adjustment WHERE id=$1 FOR UPDATE',[id]);if(locked.applied_at)return{adjustment:locked,replayed:true};
 await assertGenericLotControl(t,l);if(await sameHuman(t,p.created_by,userId)||await humanIsPerson(t,userId,a.group_id,a.person_id))throw bizErr('E_LEAVE_SELF_APPROVE','人工调整须另一有权人员复核');if(!grantOverwriteDecision({baselineRevision:p.baseline_revision,currentRevision:a.revision}).allowed)conflict('预演基线已变，须重新预演与复核');
 if(compareDecimal(p.delta,'0')!==0)await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id,payload)VALUES($1,$2,'adjust',$3,$4,$5,$6::jsonb)",[l.id,`adjust:${id}`,p.delta,p.evidence_ref,userId,json({adjustment_id:id,mode:p.mode,input_value:p.input_value,reason:p.reason})]);
 const adjustment=await one(t,'UPDATE ty_leave_adjustment SET approved_by=$2,applied_at=clock_timestamp() WHERE id=$1 RETURNING *',[id,userId]);await emit(t,a.group_id,`adjust:${id}`,'leave.balance.adjusted',{adjustment_id:id},userId);return{adjustment};
}
export async function importEntitlements(t,{userId,namespace,rows}){text(namespace,'导入命名空间');if(!Array.isArray(rows)||!rows.length||rows.length>500)bad('每批须为1至500行');const results=[];for(const row of rows){text(row.row_key,'行唯一键');const checksum=hash(row),r=await grantCumulative(t,{userId,input:{...row,event_key:`import:${namespace}:${row.row_key}`}}),old=await one(t,'SELECT * FROM ty_leave_import_row WHERE account_id=$1 AND namespace=$2 AND row_key=$3',[r.account_id,namespace,row.row_key]);if(old){if(old.payload_hash!==checksum)conflict('同一导入行键已有不同内容，须明确新版本');results.push({...old.result,replayed:true});continue;}const result={account_id:r.account_id,lot_id:r.lot.id,delta:r.delta||'0.0000'};await t.query('INSERT INTO ty_leave_import_row VALUES($1,$2,$3,$4,$5::jsonb,$6)',[r.account_id,namespace,row.row_key,checksum,json(result),userId]);results.push(result);}return{results};}
export async function expireLots(t,{userId,accountId,on}){
 const a=await account(t,userId,accountId,'advanced_leave_manage',true,false,{action:'execute',fields:['expired','available','expiry_state']}),cut=date(on),lots=await q(t,`SELECT l.* FROM ty_leave_lot l WHERE account_id=$1 AND ${lotExpiresSQL()}<$2::date AND expiry_state='active' FOR UPDATE`,[a.id,cut]),results=[];
 for(const raw of lots){const l=lifecycleFields(raw),reserved=[l.held,l.allocated,l.cash_reserved].reduce((n,v)=>decimalAdd(n,v),'0'),remaining=decimalAdd(lotAvailable(l),reserved),protectedSource=l.statutory||l.source_protection!=='none',d=expiryDecision({statutory:protectedSource,remaining,approvedReservations:reserved});
  if(d.action==='legal_review'){await t.query("UPDATE ty_leave_lot SET expiry_state='legal_review' WHERE id=$1",[l.id]);await emit(t,a.group_id,`expiry:${l.id}:${String(l.effective_expires_on||l.expires_on)}`,l.statutory?'leave.statutory.review_required':'leave.source.review_required',{lot_id:l.id,remaining,source_protection:l.source_protection},userId);}
  else if(compareDecimal(d.expire,'0')>0){await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id)VALUES($1,$2,'expire',-$3::numeric,$4,$5)",[l.id,`expiry:${cut}:r${a.revision}`,d.expire,`published-policy:${l.scheme_id}`,userId]);if(compareDecimal(reserved,'0')===0)await t.query("UPDATE ty_leave_lot SET expiry_state='expired' WHERE id=$1",[l.id]);}
  results.push({lot_id:l.id,...d});
 }return{results};
}
export async function createPayrollCandidate(t,{userId,input}){
 const a=await account(t,userId,input.account_id,'advanced_leave_payroll',true,false,{fields:['target','normal_covered','currency','source_ref']});
 const target=decimal(input.target,{negative:false}),covered=decimal(input.normal_covered||'0',{negative:false});
 if(compareDecimal(covered,target)>0)bad('普通工资覆盖额不能超过同事项总目标');if(!Number.isInteger(input.revision)||input.revision<1)bad('来源版本须正整数');
 text(input.source_ref,'核准给薪来源');const key=text(input.parent_key,'稳定父义务键'),old=await one(t,'SELECT * FROM ty_leave_payroll_obligation WHERE account_id=$1 AND parent_key=$2 FOR UPDATE',[a.id,key]);
 if(old){
  if(old.currency!==input.currency)conflict('同一父义务币种不可改变');
  const source=await one(t,'SELECT * FROM ty_leave_payroll_source WHERE obligation_id=$1 AND revision=$2',[old.id,input.revision]);
  if(source){if(compareDecimal(target,source.target)!==0||compareDecimal(covered,source.normal_covered)!==0||source.source_ref!==input.source_ref)conflict('同来源版本目标不同');return{obligation:old,replayed:true,stale:input.revision<old.revision};}
  if(input.revision<old.revision)conflict('旧来源版本未曾核定，不得倒插');
 }
 const obligation=old?await one(t,'UPDATE ty_leave_payroll_obligation SET revision=$2,target=$3,normal_covered=$4,source_ref=$5,created_by=$6 WHERE id=$1 RETURNING *',[old.id,input.revision,target,covered,input.source_ref,userId]):await one(t,'INSERT INTO ty_leave_payroll_obligation(account_id,parent_key,currency,revision,target,normal_covered,source_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8)RETURNING *',[a.id,key,input.currency,input.revision,target,covered,input.source_ref,userId]);
 await t.query('INSERT INTO ty_leave_payroll_source(obligation_id,revision,target,normal_covered,source_ref,created_by)VALUES($1,$2,$3,$4,$5,$6)',[obligation.id,input.revision,target,covered,input.source_ref,userId]);
 return{obligation};
}
export async function adoptPayrollCandidate(t,{userId,id,commandKey,revision,payrollBatchRef}){
 const o=await one(t,'SELECT * FROM ty_leave_payroll_obligation WHERE id=$1',[id]);if(!o)bad('候选不存在');const a=await account(t,userId,o.account_id,'advanced_leave_payroll',true,false,{action:'execute',fields:['target','normal_covered','adopted','delta','payroll_batch_ref']});
 const r=await one(t,'SELECT * FROM ty_leave_payroll_obligation WHERE id=$1 FOR UPDATE',[id]),key=text(commandKey,'采用幂等键'),old=await one(t,'SELECT * FROM ty_leave_payroll_adoption WHERE obligation_id=$1 AND command_key=$2',[id,key]);
 if(old){if(Number(old.source_revision)!==Number(revision)||old.payroll_batch_ref!==payrollBatchRef)conflict('采用键内容不同');return{adoption:old,replayed:true,bank_instruction_created:false};}
 if(Number(revision)!==Number(r.revision))conflict('候选版本已变化，须重新复核');
 const prior=await one(t,'SELECT * FROM ty_leave_payroll_adoption WHERE obligation_id=$1 AND source_revision=$2',[id,revision]);if(prior)return{adoption:prior,replayed:true,bank_instruction_created:false};
 if(await sameHuman(t,r.created_by,userId)||await humanIsPerson(t,userId,a.group_id,a.person_id))throw bizErr('E_LEAVE_SELF_APPROVE','给薪来源须由另一有权人员复核采用');
 const calc=leavePayAdoptionDelta({target:r.target,normalCovered:r.normal_covered,alreadyAdopted:r.adopted,revision,currentRevision:r.revision});
 const adoption=await one(t,'INSERT INTO ty_leave_payroll_adoption(obligation_id,command_key,source_revision,delta,payroll_batch_ref,approved_by)VALUES($1,$2,$3,$4,$5,$6)RETURNING *',[id,key,revision,calc.delta,text(payrollBatchRef,'已核定工资批次引用'),userId]);
 await t.query('UPDATE ty_leave_payroll_obligation SET adopted=$2 WHERE id=$1',[id,calc.additionalTarget]);await emit(t,a.group_id,`adopt:${id}:${revision}`,'leave.payroll.adopted',{obligation_id:id,adoption_id:adoption.id,delta:calc.delta,payroll_batch_ref:payrollBatchRef},userId);return{adoption,bank_instruction_created:false};
}
export async function queryWorkspace(t,{userId,accountId,self=false,groupId=null,ledgerId=null,companyId=null,q:search='',page=1,pageSize=20,view='accounts'}){
 if(await platformFor(t))return{...await nativeWorkspace(t,{userId,accountId,self,groupId,ledgerId,companyId,search,page,pageSize,view}),[PROJECTED]:true};
 const a=await accessFor(t,userId);self=self||a.selfOnly;
 const capabilities={};for(const[k,r]of Object.entries({can_configure:'advanced_leave_config',can_manage:'advanced_leave_manage',can_approve:'advanced_leave_approve',can_payroll:'advanced_leave_payroll',can_self:'advanced_leave_self'}))capabilities[k]=!!(await one(t,'SELECT fn_role_can($1,$2,\'write\') ok',[userId,r]))?.ok;
 if(a.persona?.profile_code==='config_admin'){capabilities.can_manage=false;capabilities.can_approve=false;capabilities.can_payroll=false;}
 if(self){if(!a.persona?.person_id||!capabilities.can_self)deny();capabilities.can_manage=false;capabilities.can_approve=false;capabilities.can_payroll=false;capabilities.can_configure=false;}
 if(a.persona?.profile_code==='boss'){for(const k of Object.keys(capabilities))capabilities[k]=false;}
 const canRead=await one(t,'SELECT fn_role_can($1,$2,\'read\') ok',[userId,self?'advanced_leave_self':'advanced_leave_manage']);
 if(!canRead?.ok&&!capabilities.can_configure)deny();
 const selfCompanies=self?(await q(t,'SELECT company_id FROM ty_employment WHERE person_id=$1 AND group_id=$2 AND status<>\'cancelled\'',[a.persona.person_id,a.persona.group_id])).map(e=>String(e.company_id)):[];
 const accessible=(await q(t,'SELECT *,id company_id FROM ty_company WHERE ($1::bigint IS NULL OR group_id=$1)',[groupId])).filter(c=>self?selfCompanies.includes(String(c.id)):a.row(c,false));
 const companyIds=await companyDescendants(t,companyId),ledgerIds=await ledgerDescendants(t,ledgerId);
 const companies=accessible.filter(c=>(!companyId||companyIds.includes(String(c.id)))&&(!ledgerId||ledgerIds.includes(String(c.ledger_id))));
 const ids=companies.map(c=>c.id),authorizedIds=accessible.map(c=>c.id);if((companyId||ledgerId)&&!ids.length&&!self)deny();
 const schemeRows=await q(t,`SELECT s.*,p.valid_to effective_to FROM ty_leave_scheme s LEFT JOIN ty_leave_scheme_period p ON p.scheme_id=s.id WHERE ($1::bigint IS NULL OR s.group_id=$1) AND (s.company_id IS NULL OR s.company_id=ANY($2::bigint[])) ORDER BY s.code,s.version DESC`,[groupId,ids]);
 const schemes=schemeRows.filter(s=>(self?same(s.group_id,a.persona.group_id):a.group(s.group_id))&&(capabilities.can_configure||s.status==='published'));
 if(accountId){
  const b=await balance(t,{userId,accountId,self});if(groupId&&!same(groupId,b.account.group_id)||(companyId||ledgerId)&&!b.account.employments.some(e=>ids.some(id=>same(id,e.company_id))))deny();
  const adjustments=!self&&(capabilities.can_manage||capabilities.can_approve)?await q(t,'SELECT x.* FROM ty_leave_adjustment x JOIN ty_leave_lot l ON l.id=x.lot_id WHERE l.account_id=$1 ORDER BY x.id DESC LIMIT 100',[accountId]):[];
  const payroll_obligations=!self&&capabilities.can_payroll?await q(t,'SELECT * FROM ty_leave_payroll_obligation WHERE account_id=$1 ORDER BY id DESC LIMIT 100',[accountId]):[];
  const adoptions=payroll_obligations.length?await q(t,'SELECT * FROM ty_leave_payroll_adoption WHERE obligation_id=ANY($1::bigint[]) ORDER BY id DESC LIMIT 200',[payroll_obligations.map(o=>o.id)]):[];
  return{...b,accounts:[],requests:await q(t,'SELECT * FROM ty_leave_request WHERE account_id=$1 ORDER BY starts_at DESC LIMIT 100',[accountId]),schemes:schemes.filter(s=>same(s.group_id,b.account.group_id)&&s.code===b.account.code&&(!s.company_id||b.account.employments.some(e=>same(e.company_id,s.company_id)))),adjustments,payroll_obligations,adoptions,capabilities,self};
 }
 page=Number(page);pageSize=Number(pageSize);if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)bad('分页参数无效');
 if(!['accounts','relationships'].includes(view))bad('未知假期视图');
 if(!canRead?.ok)return{accounts:[],requests:[],schemes,capabilities,page,page_size:pageSize,total:0,self};
 if(view==='relationships'){
  if(self||!capabilities.can_manage)deny();
  const relWhere=`($1::bigint IS NULL OR r.group_id=$1) AND NOT EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND NOT(e.company_id=ANY($2::bigint[]))) AND EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND e.company_id=ANY($3::bigint[])) AND ($4::text='' OR p.person_number ILIKE '%'||$4||'%' OR p.full_name ILIKE '%'||$4||'%')`;
  const relParams=[groupId,authorizedIds,ids,String(search).slice(0,100)],relationship_total=Number((await one(t,`SELECT count(*) n FROM ty_leave_relationship r JOIN ty_person p ON p.id=r.person_id WHERE ${relWhere}`,relParams)).n);
  const relationships=await q(t,`SELECT r.*,p.person_number,p.full_name,(SELECT string_agg(DISTINCT c.name,'、') FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id JOIN ty_company c ON c.id=e.company_id WHERE x.relationship_id=r.id) company_name FROM ty_leave_relationship r JOIN ty_person p ON p.id=r.person_id WHERE ${relWhere} ORDER BY p.person_number,r.id LIMIT $5 OFFSET $6`,[...relParams,pageSize,(page-1)*pageSize]);
  return{accounts:[],requests:[],schemes,relationships,employment_options:[],capabilities,page,page_size:pageSize,total:0,relationship_total,relationship_page:page,relationship_page_size:pageSize,self,view};
 }
 const where=`($1::bigint IS NULL OR r.group_id=$1) AND ($2::bigint IS NULL OR p.id=$2) AND ($3::text='' OR p.person_number ILIKE '%'||$3||'%' OR p.full_name ILIKE '%'||$3||'%') AND EXISTS(SELECT 1 FROM ty_leave_relationship_employment x WHERE x.relationship_id=r.id) AND ($2::bigint IS NOT NULL OR NOT EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND NOT(e.company_id=ANY($4::bigint[])))) AND ($5::bigint[] IS NULL OR EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND e.company_id=ANY($5::bigint[])))`;
 const params=[groupId,self?a.persona.person_id:null,String(search).slice(0,100),authorizedIds,(companyId||ledgerId)?ids:null];
 const total=Number((await one(t,`SELECT count(*) n FROM ty_leave_account a JOIN ty_leave_relationship r ON r.id=a.relationship_id JOIN ty_person p ON p.id=r.person_id WHERE ${where}`,params)).n);
 const accounts=await q(t,`SELECT a.id,a.code,a.unit,a.revision,r.id relationship_id,r.group_id,r.person_id,p.person_number,p.full_name,r.jurisdiction,
 (SELECT string_agg(DISTINCT c.name,'、') FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id JOIN ty_company c ON c.id=e.company_id WHERE x.relationship_id=r.id) company_name,
 coalesce((SELECT sum(${lotAvailableSQL()}) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text available,
 coalesce((SELECT sum(held) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text held,
 coalesce((SELECT sum(allocated) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text allocated,
 coalesce((SELECT sum(taken) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text taken
 FROM ty_leave_account a JOIN ty_leave_relationship r ON r.id=a.relationship_id JOIN ty_person p ON p.id=r.person_id WHERE ${where} ORDER BY p.person_number,a.code LIMIT $6 OFFSET $7`,[...params,pageSize,(page-1)*pageSize]);
 const requests=accounts.length?await q(t,'SELECT id,account_id,starts_at,ends_at,quantity,status,created_by FROM ty_leave_request WHERE account_id=ANY($1::bigint[]) ORDER BY starts_at DESC LIMIT 100',[accounts.map(x=>x.id)]):[];
 const relationships=!self&&capabilities.can_manage?await q(t,`SELECT r.*,p.person_number,p.full_name FROM ty_leave_relationship r JOIN ty_person p ON p.id=r.person_id WHERE ($1::bigint IS NULL OR r.group_id=$1) AND NOT EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND NOT(e.company_id=ANY($2::bigint[]))) AND EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND e.company_id=ANY($3::bigint[])) ORDER BY p.person_number,r.id LIMIT 100`,[groupId,authorizedIds,ids]):[];
 const employmentRows=!self&&capabilities.can_manage?await q(t,`SELECT e.*,p.person_number,p.full_name,c.name company_name,x.relationship_id FROM ty_employment e JOIN ty_person p ON p.id=e.person_id JOIN ty_company c ON c.id=e.company_id LEFT JOIN ty_leave_relationship_employment x ON x.employment_id=e.id WHERE e.company_id=ANY($1::bigint[]) AND e.status<>'cancelled' AND ($2::text='' OR p.person_number ILIKE '%'||$2||'%' OR p.full_name ILIKE '%'||$2||'%') ORDER BY p.person_number,e.id LIMIT 101`,[ids,String(search).slice(0,100)]):[];
 return{accounts,requests,schemes:schemes.filter(s=>!self||accounts.some(ac=>same(ac.group_id,s.group_id)&&ac.code===s.code)),relationships,employment_options:employmentRows.slice(0,100),employment_options_truncated:employmentRows.length>100,capabilities,page,page_size:pageSize,total,self};
}

const forbidden=e=>String(e?.message||'').startsWith('E_TY_FORBIDDEN:');
async function maybeAccount(t,args){try{return await accountContext(t,args);}catch(e){if(forbidden(e))return null;throw e;}}
async function maybeAuth(t,userId,resource,row,action='read',fields=[]){try{return await auth(t,userId,resource,row,!['read','export'].includes(action),{action,fields});}catch(e){if(forbidden(e))return null;throw e;}}
const matchesSearch=(row,search)=>{const needle=String(search||'').normalize('NFKC').toLocaleLowerCase().trim();return!needle||['full_name','person_number','company_name','code','name'].some(k=>String(row[k]??'').normalize('NFKC').toLocaleLowerCase().includes(needle));};
function pageRows(rows,page,pageSize){return{rows:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,page_size:pageSize};}
async function relationContext(t,userId,r,write=false,fields=[]){
 const es=await q(t,'SELECT e.*,c.ledger_id,c.name company_name FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id JOIN ty_company c ON c.id=e.company_id WHERE x.relationship_id=$1',[r.id]);if(!es.length)return null;const decisions=[];let platform=null;
 for(const e of es){const c=await maybeAuth(t,userId,'advanced_leave_manage',e,write?'write':'read',fields);if(!c)return null;platform=c[AUTHORIZATION].platform;decisions.push(...c[AUTHORIZATION].decisions);}
 return{...r,employments:es,[AUTHORIZATION]:{platform,decisions,resource:'advanced_leave_manage',action:write?'write':'read'}};
}
async function nativeWorkspace(t,{userId,accountId,self,groupId,ledgerId,companyId,search,page,pageSize,view}){
 const identity=await accessFor(t,userId);self=self||identity.selfOnly;if(self&&!identity.persona?.person_id)deny();
 if(!['accounts','relationships'].includes(view))bad('未知假期视图');page=Number(page);pageSize=Number(pageSize);if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)bad('分页参数无效');
 const lids=await ledgerDescendants(t,ledgerId),cids=await companyDescendants(t,companyId),inNavigation=c=>(!companyId||cids.includes(String(c.company_id??c.id)))&&(!ledgerId||lids.includes(String(c.ledger_id)));
 const capabilities={can_configure:false,can_manage:false,can_approve:false,can_payroll:false,can_self:self};
 const companies=await q(t,'SELECT *,id company_id FROM ty_company WHERE ($1::bigint IS NULL OR group_id=$1)',[groupId]);
 const configContexts=new Map();for(const c of companies.filter(inNavigation)){const readable=await maybeAuth(t,userId,'advanced_leave_config',c);if(readable)configContexts.set(String(c.id),readable);if(!capabilities.can_configure&&await maybeAuth(t,userId,'advanced_leave_config',c,'create',['code','name','jurisdiction','unit','statutory','valid_from','valid_to','rules']))capabilities.can_configure=true;}
 const rawAccounts=await q(t,`SELECT a.id,r.group_id,r.person_id,r.id relationship_id,p.person_number,p.full_name FROM ty_leave_account a JOIN ty_leave_relationship r ON r.id=a.relationship_id JOIN ty_person p ON p.id=r.person_id WHERE($1::bigint IS NULL OR r.group_id=$1)AND($2::bigint IS NULL OR r.person_id=$2)AND($3::bigint IS NULL OR a.id=$3)ORDER BY a.id`,[groupId,self?identity.persona.person_id:null,accountId||null]);
 const visible=[];
 for(const raw of rawAccounts){const ctx=await maybeAccount(t,{userId,accountId:raw.id,resource:'advanced_leave_manage',write:false,selfAllowed:self});if(!ctx||!ctx.employments.some(inNavigation))continue;
  const totals=await one(t,`SELECT coalesce(sum(${lotAvailableSQL()}),0)::text available,coalesce(sum(l.held),0)::text held,coalesce(sum(l.allocated),0)::text allocated,coalesce(sum(l.taken),0)::text taken FROM ty_leave_lot l WHERE l.account_id=$1`,[raw.id]);
  const companyNames=ctx.employments.map(e=>companies.find(c=>same(c.id,e.company_id))?.name).filter(Boolean);
  const summary=await projectAccountRow(t,{context:ctx,row:{id:ctx.id,code:ctx.code,unit:ctx.unit,revision:ctx.revision,relationship_id:ctx.relationship_id,group_id:ctx.group_id,person_id:ctx.person_id,person_number:raw.person_number,full_name:raw.full_name,jurisdiction:ctx.jurisdiction,company_name:[...new Set(companyNames)].join('、'),...totals}});
  if(!Object.keys(summary).length||!matchesSearch(summary,search))continue;visible.push({ctx,summary});
  if(!self){if(!capabilities.can_manage&&await maybeAccount(t,{userId,accountId:ctx.id,fields:['granted','evidence_ref']}))capabilities.can_manage=true;if(!capabilities.can_approve&&await maybeAccount(t,{userId,accountId:ctx.id,resource:'advanced_leave_approve',action:'approve',fields:['status','quantity','facts']}))capabilities.can_approve=true;if(!capabilities.can_payroll&&await maybeAccount(t,{userId,accountId:ctx.id,resource:'advanced_leave_payroll',action:'execute',fields:['target','normal_covered','adopted','delta','payroll_batch_ref']}))capabilities.can_payroll=true;}
 }
 if(accountId&&!visible.length)deny();
 const rawSchemes=await q(t,'SELECT s.*,p.valid_to effective_to FROM ty_leave_scheme s LEFT JOIN ty_leave_scheme_period p ON p.scheme_id=s.id WHERE($1::bigint IS NULL OR s.group_id=$1) ORDER BY s.code,s.version DESC',[groupId]),schemes=[];
 const employmentIds=new Set(visible.flatMap(v=>v.ctx.employments.map(e=>String(e.id))));
 for(const s of rawSchemes){if(s.company_id&&!companies.some(c=>same(c.id,s.company_id)&&inNavigation(c)))continue;
  let ctx=s.company_id?configContexts.get(String(s.company_id)):null;if(!s.company_id&&!self)ctx=await maybeAuth(t,userId,'advanced_leave_config',s);
  if(!ctx){if(s.status!=='published')continue;ctx=visible.find(v=>same(v.ctx.group_id,s.group_id)&&v.ctx.code===s.code&&(!s.company_id||v.ctx.employments.some(e=>same(e.company_id,s.company_id))))?.ctx;}
  if(!ctx)continue;const safe={...s,rules:{...s.rules}};if(safe.rules.personnel_calendars)safe.rules.personnel_calendars=Object.fromEntries(Object.entries(safe.rules.personnel_calendars).filter(([id])=>employmentIds.has(id)));const projected=await projectAccountRow(t,{context:ctx,row:safe});if(Object.keys(projected).length)schemes.push(projected);
 }
 if(accountId){const ctx=visible[0].ctx,rawLots=(await q(t,`SELECT l.*,(${lotAvailableSQL()})::text available,${lotExpiresSQL()} effective_expires_on FROM ty_leave_lot l WHERE account_id=$1 ORDER BY ${lotExpiresSQL()} NULLS LAST,id`,[ctx.id])).map(lifecycleFields),lots=[];for(const row of rawLots)lots.push(await projectAccountRow(t,{context:ctx,row}));
  const totalRaw=rawLots.reduce((s,l)=>Object.fromEntries(['granted','advanced','transferred_in','transferred_out','converted','held','allocated','taken','cash_reserved','expired','available'].map(k=>[k,decimalAdd(s[k]||'0',l[k])])),{}),requests=[],adjustments=[];
  for(const row of await q(t,'SELECT * FROM ty_leave_request WHERE account_id=$1 ORDER BY starts_at DESC LIMIT 100',[ctx.id]))requests.push(await projectAccountRow(t,{context:ctx,row}));
  if(!self)for(const row of await q(t,'SELECT x.* FROM ty_leave_adjustment x JOIN ty_leave_lot l ON l.id=x.lot_id WHERE l.account_id=$1 ORDER BY x.id DESC LIMIT 100',[ctx.id]))adjustments.push(await projectAccountRow(t,{context:ctx,row}));
  const payrollCtx=self?null:await maybeAccount(t,{userId,accountId:ctx.id,resource:'advanced_leave_payroll',write:false}),payroll_obligations=[],adoptions=[];
  if(payrollCtx){const raw=await q(t,'SELECT * FROM ty_leave_payroll_obligation WHERE account_id=$1 ORDER BY id DESC LIMIT 100',[ctx.id]);for(const row of raw)payroll_obligations.push(await projectAccountRow(t,{context:payrollCtx,row}));if(raw.length)for(const row of await q(t,'SELECT * FROM ty_leave_payroll_adoption WHERE obligation_id=ANY($1::bigint[]) ORDER BY id DESC LIMIT 200',[raw.map(r=>r.id)]))adoptions.push(await projectAccountRow(t,{context:payrollCtx,row}));}
  return{account:await projectAccountRow(t,{context:ctx,row:ctx}),lots,totals:await projectAccountRow(t,{context:ctx,row:totalRaw}),requests,adjustments,payroll_obligations,adoptions,accounts:[],schemes,capabilities,self};
 }
 const relationships=[],employmentOptions=[];
 if(!self){for(const r of await q(t,`SELECT r.*,p.person_number,p.full_name FROM ty_leave_relationship r JOIN ty_person p ON p.id=r.person_id WHERE($1::bigint IS NULL OR r.group_id=$1) ORDER BY r.id`,[groupId])){const ctx=await relationContext(t,userId,r);if(!ctx||!ctx.employments.some(inNavigation))continue;const row=await projectAccountRow(t,{context:ctx,row:{...r,company_name:[...new Set(ctx.employments.map(e=>e.company_name))].join('、')}});if(Object.keys(row).length&&matchesSearch(row,search))relationships.push(row);}
  for(const e of await q(t,`SELECT e.*,c.ledger_id,c.name company_name,p.person_number,p.full_name,x.relationship_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id JOIN ty_person p ON p.id=e.person_id LEFT JOIN ty_leave_relationship_employment x ON x.employment_id=e.id WHERE($1::bigint IS NULL OR e.group_id=$1)AND e.status<>'cancelled' ORDER BY e.id`,[groupId])){if(!inNavigation(e))continue;const readable=await maybeAuth(t,userId,'advanced_leave_manage',e),writable=await maybeAuth(t,userId,'advanced_leave_manage',e,'write',['person_id','legal_employer_key','qualifications','evidence_ref','valid_from','valid_to']);if(!readable||!writable)continue;const row=await projectAccountRow(t,{context:readable,row:e});if(Object.keys(row).length&&matchesSearch(row,search))employmentOptions.push(row);}
 }
 if(view==='relationships'){if(self)deny();const p=pageRows(relationships,page,pageSize);return{accounts:[],requests:[],schemes,relationships:p.rows,employment_options:[],capabilities,page,page_size:pageSize,total:0,relationship_total:p.total,relationship_page:page,relationship_page_size:pageSize,self,view};}
 visible.sort((a,b)=>String(a.summary.person_number??a.summary.id??'').localeCompare(String(b.summary.person_number??b.summary.id??'')));const p=pageRows(visible,page,pageSize),requests=[];for(const{ctx}of p.rows)for(const row of await q(t,'SELECT id,account_id,starts_at,ends_at,quantity,status,created_by FROM ty_leave_request WHERE account_id=$1 ORDER BY starts_at DESC LIMIT 100',[ctx.id]))requests.push(await projectAccountRow(t,{context:ctx,row}));
 return{accounts:p.rows.map(r=>r.summary),requests,schemes,relationships:relationships.slice(0,100),employment_options:employmentOptions.slice(0,100),employment_options_truncated:employmentOptions.length>100,capabilities,page,page_size:pageSize,total:p.total,self};
}

// Explicit API-boundary projection. Commands keep raw, already-authorized domain
// receipts internally; callers must await this before returning them to a client.
// A write/execute grant is never reused as read permission for its result body.
export async function projectServiceResult(t,{userId,result}){
 if(!result||typeof result!=='object'||!await platformFor(t)||result[PROJECTED])return result;
 const out={},contexts=new Map(),identity=await accessFor(t,userId);
 const readContext=async(accountId,resources=['advanced_leave_manage'])=>{
  for(const resource of resources){const key=`${resource}:${accountId}`;if(!contexts.has(key))contexts.set(key,await maybeAccount(t,{userId,accountId,resource,write:false,selfAllowed:resource==='advanced_leave_manage'}));if(contexts.get(key))return contexts.get(key);}return null;
 };
 const rowForAccount=async(row,accountId,resources)=>{const ctx=await readContext(accountId,resources);return ctx?await projectAccountRow(t,{context:ctx,row}):{};};
 let main=null;
 if(result.account?.id)main=await readContext(result.account.id);
 else if(result.account_id)main=await readContext(result.account_id);
 else if(result.request?.account_id)main=await readContext(result.request.account_id,['advanced_leave_manage','advanced_leave_approve']);
 else if(result.lot?.account_id)main=await readContext(result.lot.account_id);
 else if(result.obligation?.account_id)main=await readContext(result.obligation.account_id,['advanced_leave_payroll']);
 const protocol=new Set(['replayed','stale','bank_instruction_created','self','on','page','page_size','total','view','relationship_total','relationship_page','relationship_page_size','employment_options_truncated']);
 const flat={};for(const[k,v]of Object.entries(result))if(v===null||typeof v!=='object'){if(protocol.has(k))out[k]=v;else flat[k]=v;}
 if(main)Object.assign(out,await projectAccountRow(t,{context:main,row:flat}));
 if(result.scheme){const s=result.scheme,c=s.company_id?await one(t,'SELECT *,id company_id FROM ty_company WHERE id=$1',[s.company_id]):s,ctx=await maybeAuth(t,userId,'advanced_leave_config',c);out.scheme=ctx?await projectAccountRow(t,{context:ctx,row:s}):{};}
 if(result.relationship){const r=result.relationship,ctx=await relationContext(t,userId,r);out.relationship=ctx?await projectAccountRow(t,{context:ctx,row:r}):{};}
 if(result.account)out.account=main?await projectAccountRow(t,{context:main,row:result.account}):{};
 if(result.lot)out.lot=await rowForAccount(result.lot,result.lot.account_id);
 if(result.event)out.event=main?await projectAccountRow(t,{context:main,row:result.event}):{};
 if(result.request)out.request=await rowForAccount(result.request,result.request.account_id,['advanced_leave_manage','advanced_leave_approve']);
 if(result.adjustment){const l=await one(t,'SELECT account_id FROM ty_leave_lot WHERE id=$1',[result.adjustment.lot_id]);out.adjustment=l?await rowForAccount(result.adjustment,l.account_id,['advanced_leave_manage','advanced_leave_approve']):{};}
 if(result.obligation)out.obligation=await rowForAccount(result.obligation,result.obligation.account_id,['advanced_leave_payroll']);
 if(result.adoption){const o=await one(t,'SELECT account_id FROM ty_leave_payroll_obligation WHERE id=$1',[result.adoption.obligation_id]);out.adoption=o?await rowForAccount(result.adoption,o.account_id,['advanced_leave_payroll']):{};}
 if(result.lots){out.lots=[];for(const row of result.lots){const accountId=row.account_id||result.account?.id;if(accountId)out.lots.push(await rowForAccount(row,accountId));}}
 if(result.totals)out.totals=main?await projectAccountRow(t,{context:main,row:result.totals}):{};
 if(result.results){out.results=[];for(const row of result.results){let accountId=row.account_id;if(!accountId&&row.lot_id)accountId=(await one(t,'SELECT account_id FROM ty_leave_lot WHERE id=$1',[row.lot_id]))?.account_id;out.results.push(accountId?await rowForAccount(row,accountId):{});}}
 // queryWorkspace is projected in its dedicated path, including safe search,
 // counts and pagination. Unknown result structures are not copied wholesale.
 return{...out,[PROJECTED]:true};
}
