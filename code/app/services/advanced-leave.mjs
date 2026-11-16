// Caller executes every exported mutation inside its route-owned transaction: one connection,
// one transaction. This domain never commits, pays money or rewrites legacy leave.
import {createHash} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import {accessFor,companyDescendants,ledgerDescendants} from './foundation.mjs';
import {exactDecimal,decimalAdd,decimalSubtract,compareDecimal,cumulativeGrant,multiShiftMinutes,excludeCalendarDates,expiryDecision,cnAnnualBand,cnAnnualProration,hkAnnualDays,grantOverwriteDecision,leavePayAdoptionDelta} from '../leave-calculations.mjs';
export const RESOURCES=['advanced_leave_config','advanced_leave_manage','advanced_leave_approve','advanced_leave_payroll','advanced_leave_self'];
const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
const one=async(t,s,a=[])=>(await q(t,s,a))[0];
const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
const conflict=m=>{throw bizErr('E_TY_CONFLICT',m);};
const deny=()=>{throw bizErr('E_TY_FORBIDDEN','缺少高级假期功能与数据范围授权');};
const same=(a,b)=>String(a)===String(b);
const iso=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const json=v=>JSON.stringify(v);
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const hash=v=>createHash('sha256').update(json(canonical(v))).digest('hex');
function text(v,name,min=1){if(typeof v!=='string'||v.trim().length<min||v.length>2000)bad(`${name}必填且格式有效`);return v.trim();}
function date(v,name='日期'){if(!/^\d{4}-\d{2}-\d{2}$/.test(v||'')||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)bad(`${name}须为有效ISO日期`);return v;}
function decimal(v,{positive=false,negative=true}={}){let out;try{out=exactDecimal(v);}catch{bad('数量必须是精确十进制文本');}if(compareDecimal(out,v)!==0)bad('数量最多4位小数');if(positive&&compareDecimal(out,'0')<=0||!negative&&compareDecimal(out,'0')<0)bad('数量超出范围');return out;}
async function emit(t,gid,key,type,payload,actor){await t.query('INSERT INTO ty_leave_outbox(group_id,event_key,event_type,payload,actor_id)VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING',[gid,key,type,json(payload),actor]);}
async function receipt(t,userId,operation,operationId,payload){text(operationId,'操作幂等号');await t.query('SELECT id FROM sys_account WHERE id=$1 FOR UPDATE',[userId]);const old=await one(t,'SELECT * FROM ty_leave_command WHERE actor_id=$1 AND operation=$2 AND operation_key=$3',[userId,operation,operationId]);if(old&&old.payload_hash!==hash(payload))conflict('同一操作号的请求内容不同');return old?{...old.result,replayed:true}:null;}
async function saveReceipt(t,userId,operation,operationId,payload,result){await t.query('INSERT INTO ty_leave_command(actor_id,operation,operation_key,payload_hash,result)VALUES($1,$2,$3,$4,$5::jsonb)',[userId,operation,operationId,hash(payload),json(result)]);return result;}
async function auth(t,userId,resource,row,write=true,{self=false}={}){
 const a=await accessFor(t,userId),p=a.persona;
 if(!(await one(t,'SELECT fn_role_can($1,$2,$3) ok',[userId,resource,write?'write':'read']))?.ok)deny();
 if(p&&['vendor_contact','outsource_hr','outsourced_staff'].includes(p.profile_code))deny();
 if(write&&p?.profile_code==='boss')deny();
 if(p?.profile_code==='config_admin'&&resource!=='advanced_leave_config')deny();
 if(self){if(!p?.person_id||!same(p.person_id,row.person_id)||!same(p.group_id,row.group_id))deny();return a;}
 if(a.selfOnly)deny();
 // Configuration's platform capability does not leak into business writes.
 if(resource==='advanced_leave_config'&&a.platformAdmin)return a;
 if(!a.row(row,write))deny();return a;
}
async function employment(t,id){const e=await one(t,'SELECT e.*,c.ledger_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id WHERE e.id=$1',[id]);if(!e)bad('没有可核对的公司关系');return e;}
async function account(t,userId,id,resource='advanced_leave_manage',write=true,self=false){
 if(self&&resource!=='advanced_leave_manage')deny();
 const r=await one(t,`SELECT a.*,r.group_id,r.person_id,r.legal_employer_key,r.jurisdiction,r.valid_from relationship_from,r.valid_to relationship_to,r.qualifications
 FROM ty_leave_account a JOIN ty_leave_relationship r ON r.id=a.relationship_id WHERE a.id=$1`,[id]);if(!r)throw bizErr('E_TY_NOT_FOUND','假期账户不存在');
 await t.query('SELECT id FROM ty_leave_relationship WHERE id=$1 FOR UPDATE',[r.relationship_id]);
 const es=await q(t,'SELECT e.*,c.ledger_id FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id JOIN ty_company c ON c.id=e.company_id WHERE x.relationship_id=$1',[r.relationship_id]);
 if(!es.length)bad('尚未关联已核实的公司关系');
 if(self)await auth(t,userId,'advanced_leave_self',r,write,{self:true});
 else{const a=await auth(t,userId,resource,es[0],write);if(!es.every(e=>a.row(e,write)))deny();}
 // One lock order across grants, reservations, imports and corrections avoids a
 // relationship/account inversion on real PostgreSQL (WASM alone cannot prove it).
 const current=await one(t,'SELECT * FROM ty_leave_account WHERE id=$1 FOR UPDATE',[id]);
 return{...r,...current,employments:es};
}
function validateRules(input){
 const r=input.rules;if(!r||Array.isArray(r)||typeof r!=='object')bad('规则须为结构化对象');
 if(!['day','minute'].includes(input.unit)||!['CN','HK'].includes(input.jurisdiction))bad('须明确两地体系及计量单位');
 if(!['roster','calendar'].includes(r.quantity_basis))bad('须选择排班分钟/比例或日历日计算口径');
 if(input.unit==='minute'&&r.quantity_basis!=='roster')bad('分钟假必须依已发布排班计算');
 if(r.step!==undefined)decimal(r.step,{positive:true});if(r.max_quantity!==undefined)decimal(r.max_quantity,{positive:true});
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
 await auth(t,userId,'advanced_leave_config',row);const oldReceipt=await receipt(t,userId,'scheme.create',operationId,input);if(oldReceipt)return oldReceipt;await t.query('SELECT id FROM ty_group WHERE id=$1 FOR UPDATE',[input.group_id]);
 const version=Number((await one(t,'SELECT coalesce(max(version),0)+1 n FROM ty_leave_scheme WHERE group_id=$1 AND code=$2',[input.group_id,input.code])).n);
 const scheme=await one(t,`INSERT INTO ty_leave_scheme(group_id,company_id,code,version,name,jurisdiction,unit,statutory,valid_from,valid_to,rules,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)RETURNING *`,[input.group_id,input.company_id||null,text(input.code,'假种编码'),version,text(input.name,'名称'),input.jurisdiction,input.unit,input.statutory===true,date(input.valid_from),input.valid_to?date(input.valid_to):null,json(input.rules),userId]);return saveReceipt(t,userId,'scheme.create',operationId,input,{scheme});
}
export async function publishScheme(t,{userId,id}){
 const s=await one(t,'SELECT * FROM ty_leave_scheme WHERE id=$1 FOR UPDATE',[id]);if(!s)bad('规则不存在');
 const c=s.company_id?await one(t,'SELECT *,id company_id FROM ty_company WHERE id=$1',[s.company_id]):s;
 await auth(t,userId,'advanced_leave_config',c);if(s.status==='published')return{scheme:s,replayed:true};if(same(s.created_by,userId))throw bizErr('E_LEAVE_SELF_APPROVE','规则发布须由另一有权人员复核');validateRules(s);
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
 for(const id of ids){const e=await employment(t,id);await auth(t,userId,'advanced_leave_manage',e);if(e.status==='cancelled'||!same(e.person_id,input.person_id)||!same(e.group_id,input.group_id))bad('公司关系与永久人员不一致');es.push(e);}
 const source=text(input.source_key,'实际关系来源键'),evidence=text(input.evidence_ref,'核实证据',4),from=date(input.valid_from),to=input.valid_to?date(input.valid_to):null;
 if(es.some(e=>iso(e.hire_date)<from||(to&&(!e.leave_date||iso(e.leave_date)>=to))))bad('核实的实际关系期间未覆盖公司关系段');
 await t.query('SELECT id FROM ty_person WHERE id=$1 FOR UPDATE',[input.person_id]);
 const old=await one(t,'SELECT * FROM ty_leave_relationship WHERE group_id=$1 AND source_key=$2 FOR UPDATE',[input.group_id,source]);
 if(old){
  if(!same(old.person_id,input.person_id)||old.legal_employer_key!==input.legal_employer_key||old.jurisdiction!==input.jurisdiction||hash(old.qualifications)!==hash(input.qualifications||{})||iso(old.valid_from)!==from||iso(old.valid_to||'')!==(to||''))conflict('实际关系来源键已有不同内容，资格更正须另行核定');
  const previous=await q(t,'SELECT e.*,c.ledger_id FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id JOIN ty_company c ON c.id=e.company_id WHERE x.relationship_id=$1',[old.id]);for(const e of previous)await auth(t,userId,'advanced_leave_manage',e);
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
 const ar=await one(t,'SELECT id FROM ty_leave_account WHERE relationship_id=$1 AND code=$2',[r.id,s.code]);const a=await account(t,userId,ar.id),effectiveDate=date(input.valid_from);await schemeFor(t,a,s.id,input.as_of?date(input.as_of):effectiveDate);
 if(effectiveDate<iso(r.valid_from)||r.valid_to&&effectiveDate>=iso(r.valid_to)||!a.employments.some(e=>e.status!=='cancelled'&&iso(e.hire_date)<=effectiveDate&&(!e.leave_date||iso(e.leave_date)>=effectiveDate)))bad('权益起日须落在已核实实际关系和有效公司关系内');
 const payload={total:decimal(input.total,{negative:false}),numerator:decimal(input.numerator??'1',{negative:false}),denominator:decimal(input.denominator??'1',{positive:true}),valid_from:input.valid_from,expires_on:input.expires_on||null,entitlement_year:input.entitlement_year,scheme_id:s.id,as_of:input.as_of||input.valid_from};
 if(s.statutory&&s.code==='annual'){
  let minimum;if(s.jurisdiction==='CN'){const facts=r.qualifications;if(facts.continuous_work_12_months!==true||facts.service_years===undefined)bad('法定年假资格或累计工龄待核');const band=cnAnnualBand({serviceYears:facts.service_years});minimum=input.proration_calendar_days!==undefined?cnAnnualProration({calendarDays:input.proration_calendar_days,annualDays:band}).days:band;}else{if(r.qualifications.completed_continuous_years===undefined)bad('香港连续合约年资待核');minimum=hkAnnualDays({completedYears:r.qualifications.completed_continuous_years});}
  if(compareDecimal(payload.total,minimum)<0)bad('配置发放额低于已核定法定目标');
 }
 await t.query(`INSERT INTO ty_leave_lot(account_id,stable_key,scheme_id,entitlement_year,valid_from,expires_on,statutory)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT DO NOTHING`,[a.id,text(input.stable_key,'稳定权益键'),s.id,input.entitlement_year,payload.valid_from,input.expires_on?date(input.expires_on):null,s.statutory]);
 const l=await one(t,'SELECT * FROM ty_leave_lot WHERE account_id=$1 AND stable_key=$2 FOR UPDATE',[a.id,input.stable_key]);
 if(l.statutory!==s.statutory||iso(l.valid_from)!==payload.valid_from||iso(l.expires_on||'')!==(payload.expires_on||'')||Number(l.entitlement_year)!==Number(input.entitlement_year))conflict('稳定权益批次不可改变法定性质或期间重建');
 const key=text(input.event_key,'发放幂等键'),old=await one(t,'SELECT * FROM ty_leave_event WHERE lot_id=$1 AND event_key=$2',[l.id,key]);if(old){if(hash(old.payload)!==hash(payload))conflict('同一发放幂等键内容不同');return{account_id:a.id,lot:l,event:old,replayed:true};}
 const prior=(await one(t,"SELECT coalesce(sum(delta),0)::text n FROM ty_leave_event WHERE lot_id=$1 AND event_kind='grant'",[l.id])).n;
 const calc=cumulativeGrant({...payload,alreadyGranted:prior,scale:4,rounding:s.rules.grant_rounding||'floor',step:s.rules.grant_step||null});if(compareDecimal(calc.delta,'0')<0)conflict('累计目标下降须先预演并批准人工差额');
 await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id,payload)VALUES($1,$2,'grant',$3,$4,$5,$6::jsonb)",[l.id,key,calc.delta,text(input.evidence_ref,'发放依据',4),userId,json(payload)]);
 await emit(t,a.group_id,`grant:${l.id}:${key}`,'leave.entitlement.granted',{lot_id:l.id,...calc},userId);return{account_id:a.id,lot:await one(t,'SELECT * FROM ty_leave_lot WHERE id=$1',[l.id]),...calc};
}
export async function balance(t,{userId,accountId,self=false,on=null}){self=self||(await accessFor(t,userId)).selfOnly;const a=await account(t,userId,accountId,'advanced_leave_manage',false,self);const lots=await q(t,`SELECT *, (granted-held-allocated-taken-cash_reserved-expired)::text available FROM ty_leave_lot WHERE account_id=$1 ORDER BY expires_on NULLS LAST,id`,[a.id]);return{account:a,lots,totals:lots.reduce((s,l)=>Object.fromEntries(['granted','held','allocated','taken','cash_reserved','expired','available'].map(k=>[k,decimalAdd(s[k]||'0',l[k])])),{}),on:on||null};}
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
export async function submitRequest(t,{userId,input,self=false}){
 self=self||(await accessFor(t,userId)).selfOnly;
 const a=await account(t,userId,input.account_id,'advanced_leave_manage',true,self),e=await employment(t,input.employment_id);
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
 if(s.rules.step&&!calc.snapshot.statutory_calendar_step_exception){const r=await one(t,'SELECT mod($1::numeric,$2::numeric)=0 ok',[calc.quantity,s.rules.step]);if(!r.ok)bad('申请数量不符合最小步长');}
 const lots=await q(t,`SELECT *,(granted-held-allocated-taken-cash_reserved-expired)::text available FROM ty_leave_lot WHERE account_id=$1 AND valid_from<=$2::date AND (expires_on IS NULL OR expires_on>=$3::date) AND expiry_state='active' ORDER BY expires_on NULLS LAST,id FOR UPDATE`,[a.id,on,last]);
 if(compareDecimal(lots.reduce((n,l)=>decimalAdd(n,l.available),'0'),calc.quantity)<0)throw bizErr('E_LEAVE_OVER_QUOTA','可用批次余额不足');
 const request=await one(t,`INSERT INTO ty_leave_request(account_id,scheme_id,employment_id,request_key,starts_at,ends_at,quantity,facts,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)RETURNING *`,[a.id,s.id,e.id,key,input.starts_at,input.ends_at,calc.quantity,json({input_hash:hash({...input,request_key:undefined}),quantity_basis:s.rules.quantity_basis,...calc.snapshot,evidence_ref:input.evidence_ref||null,rule_version:s.version}),userId]);
 let remaining=calc.quantity;for(const l of lots){if(compareDecimal(remaining,'0')<=0)break;const n=compareDecimal(l.available,remaining)<0?l.available:remaining;if(compareDecimal(n,'0')<=0)continue;await t.query("INSERT INTO ty_leave_allocation(account_id,request_id,lot_id,quantity,state)VALUES($1,$2,$3,$4,'held')",[a.id,request.id,l.id,n]);remaining=decimalSubtract(remaining,n);}
 await emit(t,a.group_id,`request:${request.id}:pending`,'leave.approval.requested',{request_id:request.id,person_id:a.person_id},userId);return{request};
}
async function requestContext(t,userId,id,resource='advanced_leave_approve',self=false){const r=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1',[id]);if(!r)throw bizErr('E_LEAVE_NO_REQUEST','申请不存在');const a=await account(t,userId,r.account_id,resource,true,self);const locked=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1 FOR UPDATE',[id]);return{r:locked,a};}
export async function decideRequest(t,{userId,id,approve,reason}){if(typeof approve!=='boolean')bad('须明确批准或驳回');const{r,a}=await requestContext(t,userId,id);if(same(r.created_by,userId))throw bizErr('E_LEAVE_SELF_APPROVE','不能审批本人经办申请');if(r.status!=='pending')throw bizErr('E_LEAVE_ALREADY_DECIDED','单据已处理');await t.query('UPDATE ty_leave_allocation SET state=$2 WHERE request_id=$1 AND state=\'held\'',[id,approve?'allocated':'released']);const request=await one(t,'UPDATE ty_leave_request SET status=$2,approved_by=$3 WHERE id=$1 RETURNING *',[id,approve?'approved':'rejected',userId]);await emit(t,a.group_id,`request:${id}:${request.status}`,'leave.approval.decided',{request_id:id,approve,reason:text(reason,'审批意见',4)},userId);return{request};}
export async function settleRequest(t,{userId,id,evidenceRef}){const{r,a}=await requestContext(t,userId,id,'advanced_leave_manage');if(r.status==='taken')return{request:r,replayed:true};if(r.status!=='approved')conflict('只有已批准申请可以确认实际已休');if(!await one(t,'SELECT 1 ok WHERE $1::timestamptz<=clock_timestamp()',[r.ends_at]))bad('未来批准占用不能提前记为实际已休');text(evidenceRef,'实际已休核对依据',4);await t.query("UPDATE ty_leave_allocation SET state='taken' WHERE request_id=$1 AND state='allocated'",[id]);const request=await one(t,"UPDATE ty_leave_request SET status='taken' WHERE id=$1 RETURNING *",[id]);await emit(t,a.group_id,`request:${id}:taken`,'leave.taken.confirmed',{request_id:id,evidence_ref:evidenceRef},userId);return{request};}
export async function cancelRequest(t,{userId,id,reason,self=false}){self=self||(await accessFor(t,userId)).selfOnly;const{r,a}=await requestContext(t,userId,id,'advanced_leave_manage',self);text(reason,'取消依据',4);if(r.status==='cancelled')return{request:r,replayed:true};if(!['pending','approved'].includes(r.status))conflict('已休或已驳回申请不可直接取消，须办理有据更正');if(self&&(r.status!=='pending'||!same(r.created_by,userId)))deny();await t.query("UPDATE ty_leave_allocation SET state='released' WHERE request_id=$1 AND state IN('held','allocated')",[id]);const request=await one(t,"UPDATE ty_leave_request SET status='cancelled' WHERE id=$1 RETURNING *",[id]);await emit(t,a.group_id,`request:${id}:cancelled`,'leave.request.cancelled',{request_id:id,reason},userId);return{request};}
export async function previewAdjustment(t,{userId,input,operationId}){
 const found=await one(t,'SELECT account_id FROM ty_leave_lot WHERE id=$1',[input.lot_id]);if(!found)bad('批次不存在');
 const a=await account(t,userId,found.account_id),old=await receipt(t,userId,'adjustment.preview',operationId,input);if(old)return old;
 const l=await one(t,'SELECT * FROM ty_leave_lot WHERE id=$1 FOR UPDATE',[input.lot_id]);
 const available=decimalSubtract(l.granted,[l.held,l.allocated,l.taken,l.cash_reserved,l.expired].reduce((s,v)=>decimalAdd(s,v),'0'));
 if(!['delta','target_available'].includes(input.mode))bad('调整模式不支持');
 const value=decimal(input.value),delta=input.mode==='delta'?value:decimalSubtract(value,available);
 if(compareDecimal(decimalAdd(available,delta),'0')<0)bad('调整不能侵占已用及已占用权益');
 if(l.statutory&&compareDecimal(delta,'0')<0&&!input.legal_correction_ref)bad('法定负向更正须补充法律核定依据');
 const adjustment=await one(t,'INSERT INTO ty_leave_adjustment(lot_id,baseline_revision,mode,input_value,delta,evidence_ref,reason,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8)RETURNING *',[l.id,a.revision,input.mode,value,delta,text(input.evidence_ref,'证据',4),text(input.reason,'调整原因',4)+(input.legal_correction_ref?`；核定${input.legal_correction_ref}`:''),userId]);
 return saveReceipt(t,userId,'adjustment.preview',operationId,input,{adjustment,available_before:available,available_after:decimalAdd(available,delta)});
}
export async function applyAdjustment(t,{userId,id}){const p=await one(t,'SELECT * FROM ty_leave_adjustment WHERE id=$1',[id]);if(!p)bad('预演不存在');const l=await one(t,'SELECT * FROM ty_leave_lot WHERE id=$1',[p.lot_id]);const a=await account(t,userId,l.account_id,'advanced_leave_approve');const locked=await one(t,'SELECT * FROM ty_leave_adjustment WHERE id=$1 FOR UPDATE',[id]);if(locked.applied_at)return{adjustment:locked,replayed:true};if(same(p.created_by,userId))throw bizErr('E_LEAVE_SELF_APPROVE','人工调整须另一有权人员复核');if(!grantOverwriteDecision({baselineRevision:p.baseline_revision,currentRevision:a.revision}).allowed)conflict('预演基线已变，须重新预演与复核');if(compareDecimal(p.delta,'0')!==0)await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id,payload)VALUES($1,$2,'adjust',$3,$4,$5,$6::jsonb)",[l.id,`adjust:${id}`,p.delta,p.evidence_ref,userId,json({adjustment_id:id,mode:p.mode,input_value:p.input_value,reason:p.reason})]);const adjustment=await one(t,'UPDATE ty_leave_adjustment SET approved_by=$2,applied_at=clock_timestamp() WHERE id=$1 RETURNING *',[id,userId]);await emit(t,a.group_id,`adjust:${id}`,'leave.balance.adjusted',{adjustment_id:id},userId);return{adjustment};}
export async function importEntitlements(t,{userId,namespace,rows}){text(namespace,'导入命名空间');if(!Array.isArray(rows)||!rows.length||rows.length>500)bad('每批须为1至500行');const results=[];for(const row of rows){text(row.row_key,'行唯一键');const checksum=hash(row),r=await grantCumulative(t,{userId,input:{...row,event_key:`import:${namespace}:${row.row_key}`}}),old=await one(t,'SELECT * FROM ty_leave_import_row WHERE account_id=$1 AND namespace=$2 AND row_key=$3',[r.account_id,namespace,row.row_key]);if(old){if(old.payload_hash!==checksum)conflict('同一导入行键已有不同内容，须明确新版本');results.push({...old.result,replayed:true});continue;}const result={account_id:r.account_id,lot_id:r.lot.id,delta:r.delta||'0.0000'};await t.query('INSERT INTO ty_leave_import_row VALUES($1,$2,$3,$4,$5::jsonb,$6)',[r.account_id,namespace,row.row_key,checksum,json(result),userId]);results.push(result);}return{results};}
export async function expireLots(t,{userId,accountId,on}){const a=await account(t,userId,accountId),cut=date(on),lots=await q(t,"SELECT * FROM ty_leave_lot WHERE account_id=$1 AND expires_on<$2::date AND expiry_state='active' FOR UPDATE",[a.id,cut]),results=[];for(const l of lots){const remaining=decimalSubtract(l.granted,decimalAdd(l.taken,l.expired)),reserved=[l.held,l.allocated,l.cash_reserved].reduce((n,v)=>decimalAdd(n,v),'0'),d=expiryDecision({statutory:l.statutory,remaining,approvedReservations:reserved});if(d.action==='legal_review'){await t.query("UPDATE ty_leave_lot SET expiry_state='legal_review' WHERE id=$1",[l.id]);await emit(t,a.group_id,`expiry:${l.id}`,'leave.statutory.review_required',{lot_id:l.id,remaining},userId);}else if(compareDecimal(d.expire,'0')>0){await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id)VALUES($1,$2,'expire',-$3::numeric,$4,$5)",[l.id,`expiry:${cut}`,d.expire,`published-policy:${l.scheme_id}`,userId]);if(compareDecimal(reserved,'0')===0)await t.query("UPDATE ty_leave_lot SET expiry_state='expired' WHERE id=$1",[l.id]);}results.push({lot_id:l.id,...d});}return{results};}
export async function createPayrollCandidate(t,{userId,input}){
 const a=await account(t,userId,input.account_id,'advanced_leave_payroll');
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
 const o=await one(t,'SELECT * FROM ty_leave_payroll_obligation WHERE id=$1',[id]);if(!o)bad('候选不存在');const a=await account(t,userId,o.account_id,'advanced_leave_payroll');
 const r=await one(t,'SELECT * FROM ty_leave_payroll_obligation WHERE id=$1 FOR UPDATE',[id]),key=text(commandKey,'采用幂等键'),old=await one(t,'SELECT * FROM ty_leave_payroll_adoption WHERE obligation_id=$1 AND command_key=$2',[id,key]);
 if(old){if(Number(old.source_revision)!==Number(revision)||old.payroll_batch_ref!==payrollBatchRef)conflict('采用键内容不同');return{adoption:old,replayed:true,bank_instruction_created:false};}
 if(Number(revision)!==Number(r.revision))conflict('候选版本已变化，须重新复核');
 const prior=await one(t,'SELECT * FROM ty_leave_payroll_adoption WHERE obligation_id=$1 AND source_revision=$2',[id,revision]);if(prior)return{adoption:prior,replayed:true,bank_instruction_created:false};
 if(same(r.created_by,userId))throw bizErr('E_LEAVE_SELF_APPROVE','给薪来源须由另一有权人员复核采用');
 const calc=leavePayAdoptionDelta({target:r.target,normalCovered:r.normal_covered,alreadyAdopted:r.adopted,revision,currentRevision:r.revision});
 const adoption=await one(t,'INSERT INTO ty_leave_payroll_adoption(obligation_id,command_key,source_revision,delta,payroll_batch_ref,approved_by)VALUES($1,$2,$3,$4,$5,$6)RETURNING *',[id,key,revision,calc.delta,text(payrollBatchRef,'已核定工资批次引用'),userId]);
 await t.query('UPDATE ty_leave_payroll_obligation SET adopted=$2 WHERE id=$1',[id,calc.additionalTarget]);await emit(t,a.group_id,`adopt:${id}:${revision}`,'leave.payroll.adopted',{obligation_id:id,adoption_id:adoption.id,delta:calc.delta,payroll_batch_ref:payrollBatchRef},userId);return{adoption,bank_instruction_created:false};
}
export async function queryWorkspace(t,{userId,accountId,self=false,groupId=null,ledgerId=null,companyId=null,q:search='',page=1,pageSize=20,view='accounts'}){
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
 coalesce((SELECT sum(granted-held-allocated-taken-cash_reserved-expired) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text available,
 coalesce((SELECT sum(held) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text held,
 coalesce((SELECT sum(allocated) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text allocated,
 coalesce((SELECT sum(taken) FROM ty_leave_lot l WHERE l.account_id=a.id),0)::text taken
 FROM ty_leave_account a JOIN ty_leave_relationship r ON r.id=a.relationship_id JOIN ty_person p ON p.id=r.person_id WHERE ${where} ORDER BY p.person_number,a.code LIMIT $6 OFFSET $7`,[...params,pageSize,(page-1)*pageSize]);
 const requests=accounts.length?await q(t,'SELECT id,account_id,starts_at,ends_at,quantity,status,created_by FROM ty_leave_request WHERE account_id=ANY($1::bigint[]) ORDER BY starts_at DESC LIMIT 100',[accounts.map(x=>x.id)]):[];
 const relationships=!self&&capabilities.can_manage?await q(t,`SELECT r.*,p.person_number,p.full_name FROM ty_leave_relationship r JOIN ty_person p ON p.id=r.person_id WHERE ($1::bigint IS NULL OR r.group_id=$1) AND NOT EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND NOT(e.company_id=ANY($2::bigint[]))) AND EXISTS(SELECT 1 FROM ty_leave_relationship_employment x JOIN ty_employment e ON e.id=x.employment_id WHERE x.relationship_id=r.id AND e.company_id=ANY($3::bigint[])) ORDER BY p.person_number,r.id LIMIT 100`,[groupId,authorizedIds,ids]):[];
 const employmentRows=!self&&capabilities.can_manage?await q(t,`SELECT e.*,p.person_number,p.full_name,c.name company_name,x.relationship_id FROM ty_employment e JOIN ty_person p ON p.id=e.person_id JOIN ty_company c ON c.id=e.company_id LEFT JOIN ty_leave_relationship_employment x ON x.employment_id=e.id WHERE e.company_id=ANY($1::bigint[]) AND e.status<>'cancelled' AND ($2::text='' OR p.person_number ILIKE '%'||$2||'%' OR p.full_name ILIKE '%'||$2||'%') ORDER BY p.person_number,e.id LIMIT 101`,[ids,String(search).slice(0,100)]):[];
 return{accounts,requests,schemes:schemes.filter(s=>!self||accounts.some(ac=>same(ac.group_id,s.group_id)&&ac.code===s.code)),relationships,employment_options:employmentRows.slice(0,100),employment_options_truncated:employmentRows.length>100,capabilities,page,page_size:pageSize,total,self};
}
