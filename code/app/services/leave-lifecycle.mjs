// V17 lifecycle commands. STAGING until the parent's integration checkpoint.
// Every mutation is one caller-owned transaction. No bank instruction or wage
// posting is produced here: confirmed monetary sources await the adoption bridge.
import {createHash} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import {sameHuman,humanIsPerson} from './human-identity.mjs';
import * as core from './advanced-leave.mjs';
import {readLeaveRoster,assertRequestRosterCurrent} from './leave-roster-source.mjs';
import {exactDecimal,exactFraction,decimalAdd,decimalSubtract,compareDecimal,cumulativeGrant,cnAnnualBand,cnAnnualProration,hkAnnualDays,hkAnnualCashChoice,hkADW} from '../leave-calculations.mjs';
export const RESOURCES=['advanced_leave_manage','advanced_leave_approve','advanced_leave_payroll','advanced_leave_self'];
const FINANCIAL_KINDS=new Set(['overtime_basis','overtime_allocate','comp_cash','cash_qualification','annual_cash']);
const KIND_FIELDS={extend:['effective_expires_on','evidence_ref'],carry:['transferred_in','transferred_out','quantity','evidence_ref'],recurring:['slots','valid_from','valid_to','evidence_ref'],advance:['advanced','quantity','due_on','evidence_ref'],advance_repay:['advanced','transferred_in','transferred_out','quantity','evidence_ref'],overtime_basis:['verified_minutes','cash_unit_rate','pricing_ref','evidence_ref'],overtime_allocate:['cash_basis','comp_basis','comp_generated','evidence_ref'],comp_cash:['converted','quantity','gross_target','evidence_ref'],cash_qualification:['wage_basis','maximum_days','facts','evidence_ref'],annual_cash:['cash_reserved','converted','gross_target','normal_covered','quantity','evidence_ref']};
export function lifecycleAccessSpec(kind,phase='submit'){
 const fields=KIND_FIELDS[kind];if(!fields)bad('未知生命周期事项');
 if(phase==='approve')return{resource:'advanced_leave_approve',action:'approve',fields:['status','payload','quantity']};
 return{resource:FINANCIAL_KINDS.has(kind)?'advanced_leave_payroll':'advanced_leave_manage',action:phase==='execute'?'execute':phase==='cancel'?'cancel':'submit',fields:phase==='cancel'?['status','quantity',...(kind==='annual_cash'?['cash_reserved']:[])]:fields};
}
const q=async(t,s,a=[])=>(await t.query(s,a)).rows,one=async(t,s,a=[])=>(await q(t,s,a))[0];
const same=(a,b)=>String(a)===String(b),iso=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10),json=JSON.stringify;
const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);},conflict=m=>{throw bizErr('E_TY_CONFLICT',m);},deny=()=>{throw bizErr('E_TY_FORBIDDEN','生命周期操作缺少完整功能与关系范围授权');};
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
const digest=v=>createHash('sha256').update(json(canonical(v))).digest('hex');
function text(v,label,min=1){if(typeof v!=='string'||v.trim().length<min||v.length>4000)bad(`${label}须明确填写`);return v.trim();}
function date(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v||'')||!Number.isFinite(Date.parse(v+'T00:00Z'))||new Date(v+'T00:00Z').toISOString().slice(0,10)!==v)bad('须为有效ISO日期');return v;}
function qty(v,positive=true){let n;try{n=exactDecimal(v);}catch{bad('数量须精确十进制文本');}if(compareDecimal(n,v)!==0||compareDecimal(n,'0')<(positive?1:0))bad('数量须非负且最多4位小数');return n;}
const add=(a,b)=>decimalAdd(a,b),sub=(a,b)=>decimalSubtract(a,b),gt=(a,b)=>compareDecimal(a,b)>0;
function multiply(a,b,scale=4){const x=exactFraction(a),y=exactFraction(b);return exactDecimal({numerator:String(BigInt(x.numerator)*BigInt(y.numerator)),denominator:String(BigInt(x.denominator)*BigInt(y.denominator))},scale);}
const productFraction=(a,b)=>{const x=exactFraction(a),y=exactFraction(b);return exactFraction({numerator:String(BigInt(x.numerator)*BigInt(y.numerator)),denominator:String(BigInt(x.denominator)*BigInt(y.denominator))});};
function sumFractions(values){let n=0n,d=1n;const gcd=(a,b)=>b?gcd(b,a%b):a;for(const value of values){const x=exactFraction(value);n=n*BigInt(x.denominator)+BigInt(x.numerator)*d;d*=BigInt(x.denominator);const g=gcd(n,d);n/=g;d/=g;}return{numerator:String(n),denominator:String(d)};}
function ratio(a,n,d,scale=4,mode='half_up'){const x=exactFraction(a);return exactDecimal({numerator:String(BigInt(x.numerator)*BigInt(n)),denominator:String(BigInt(x.denominator)*BigInt(d))},scale,mode);}
const available=l=>[l.held,l.allocated,l.taken,l.cash_reserved,l.expired,l.converted,l.transferred_out].reduce(sub,[l.granted,l.advanced,l.transferred_in].reduce(add,'0'));
async function emit(t,a,key,type,payload,userId){await t.query('INSERT INTO ty_leave_outbox(group_id,event_key,event_type,payload,actor_id)VALUES($1,$2,$3,$4::jsonb,$5)ON CONFLICT DO NOTHING',[a.group_id,key,type,json(payload),userId]);}
async function context(t,userId,id,resource='advanced_leave_manage',{selfAllowed=false,read=false,kind=null,phase='submit',action=null,fields=[]}={}){
 const spec=kind?lifecycleAccessSpec(kind,phase):null;return core.accountContext(t,{userId,accountId:id,resource:spec?.resource||resource,write:!read,selfAllowed,action:action||spec?.action||(read?'read':resource==='advanced_leave_approve'?'approve':'write'),fields:spec?.fields||fields});
}
async function lot(t,a,id){const l=await one(t,'SELECT * FROM ty_leave_lot WHERE id=$1 AND account_id=$2 FOR UPDATE',[id,a.id]);if(!l)bad('批次不属于此账户');return l;}
async function scheme(t,a,id,on){const s=await one(t,'SELECT s.*,p.valid_to effective_to FROM ty_leave_scheme s JOIN ty_leave_scheme_period p ON p.scheme_id=s.id WHERE s.id=$1',[id]);if(!s||s.status!=='published'||!same(s.group_id,a.group_id)||s.code!==a.code||s.unit!==a.unit||s.jurisdiction!==a.jurisdiction||iso(s.valid_from)>on||s.effective_to&&iso(s.effective_to)<=on||s.company_id&&!a.employments.some(e=>same(e.company_id,s.company_id)))bad('没有适用的已发布规则版本');return s;}
async function nativeOvertime(t,id){return one(t,`SELECT v.credited_minutes,s.overtime,d.employment_id,d.work_date,p.status,p.id period_id,to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI:SS') starts_at,to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI:SS') ends_at,to_jsonb(v)->>'actual_in' actual_in,to_jsonb(v)->>'actual_out' actual_out FROM ty_roster_segment s JOIN ty_roster_day d ON d.id=s.day_id JOIN ty_roster_period p ON p.id=d.period_id JOIN v_ty_time_segment v ON v.id=s.id WHERE s.id=$1 FOR SHARE OF s,d,p`,[id]);}
const nativeHash=n=>digest({...n,work_date:iso(n.work_date),employment_id:String(n.employment_id),period_id:String(n.period_id),credited_minutes:String(n.credited_minutes)});
async function assertSourceSnapshot(t,source){if(source.source_kind!=='native_confirmed')return;const revision=await one(t,'SELECT facts FROM ty_leave_overtime_revision WHERE source_id=$1 AND revision=$2',[source.id,source.latest_revision]),current=await nativeOvertime(t,Number(source.work_fact_key));if(!revision||!current||current.status!=='closed'||nativeHash(current)!==revision.facts.native_source_hash)conflict('原生加班源出现新变化，保留已确认权益，新分配/转换须先核准来源修订');}
async function priorProposal(t,a,kind,input,key=input.stable_key){
 const old=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE account_id=$1 AND kind=$2 AND stable_key=$3 AND revision=$4',[a.id,kind,key,Number(input.revision)]);if(!old)return null;
 const selected={...input,stable_key:key};delete selected.account_id;
 const stored=Object.fromEntries(Object.keys(selected).map(k=>[k,old.payload[k]]));
 if(digest(selected)!==digest(stored))conflict('同一事项修订的请求内容不同');return{proposal:old,replayed:true};
}
async function workflowRequirement(t,a,userId,kind){
 if(!(await one(t,"SELECT to_regclass('public.ty_workflow_instance')IS NOT NULL ok"))?.ok)return{required:false};
 let workflow;try{workflow=await import('./platform-workflow.mjs');}catch{throw bizErr('E_LEAVE_USE_APPROVAL','已安装统一流程但领域绑定检查尚未接入，不能走直接核准旁路');}
 if(typeof workflow.approvalRequirement!=='function')throw bizErr('E_LEAVE_USE_APPROVAL','统一审批绑定检查尚未配置，不能默认直接核准');
 const requirements=[];for(const companyId of[...new Set(a.employments.map(e=>e.company_id))])requirements.push(await workflow.approvalRequirement(t,{userId,subjectType:'leave_lifecycle_proposal',groupId:a.group_id,companyId,kind}));
 return{required:requirements.some(r=>r.required),requirements};
}
async function propose(t,a,userId,kind,input,quantity=null,baselineOffset=0){
 const key=text(input.stable_key,'稳定事项键'),rev=Number(input.revision);if(!Number.isSafeInteger(rev)||rev<1)bad('修订须为正整数');
 const payload={...input};delete payload.account_id;const fingerprint=digest(payload),old=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE account_id=$1 AND kind=$2 AND stable_key=$3 AND revision=$4',[a.id,kind,key,rev]);
 if(old){if(old.payload_hash!==fingerprint)conflict('同一事项修订的内容不同');return{proposal:old,replayed:true};}
 const latest=await one(t,'SELECT max(revision) revision FROM ty_leave_lifecycle_proposal WHERE account_id=$1 AND kind=$2 AND stable_key=$3',[a.id,kind,key]);if(latest?.revision&&Number(latest.revision)>=rev)conflict('不能倒插事项修订');
 const requirement=await workflowRequirement(t,a,userId,kind);
 const proposal=await one(t,`INSERT INTO ty_leave_lifecycle_proposal(account_id,kind,stable_key,revision,payload,payload_hash,baseline_revision,quantity,evidence_ref,created_by,approval_route)VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)RETURNING *`,[a.id,kind,key,rev,json(payload),fingerprint,Number(a.revision)+baselineOffset,quantity,text(input.evidence_ref,'核对依据',4),userId,requirement.required?'workflow':'direct']);
 await emit(t,a,`lifecycle:${proposal.id}:pending`,'leave.lifecycle.approval_requested',{proposal_id:proposal.id,kind},userId);return{proposal};
}
async function ledger(t,p,lotId,kind,quantity,key=kind){if(gt(quantity,'0'))await t.query('INSERT INTO ty_leave_lifecycle_ledger(proposal_id,lot_id,event_key,kind,quantity)VALUES($1,$2,$3,$4,$5)',[p.id,lotId,key,kind,quantity]);}
async function newLot(t,a,p,s,stableKey,year,from,to){return one(t,`INSERT INTO ty_leave_lot(account_id,stable_key,scheme_id,entitlement_year,valid_from,expires_on,effective_expires_on,statutory)VALUES($1,$2,$3,$4,$5,$6,$6,$7)RETURNING *`,[a.id,stableKey,s.id,year,date(from),to?date(to):null,s.statutory]);}
async function creditOrigin(t,l,p,kind,root,source,parent=null){await t.query('INSERT INTO ty_leave_credit_origin(lot_id,root_key,kind,parent_lot_id,source_key,proposal_id)VALUES($1,$2,$3,$4,$5,$6)',[l.id,root,kind,parent,source,p.id]);}
async function cashObligation(t,a,p,root,currency,gross,covered='0',mode='target'){
 const old=await one(t,'SELECT * FROM ty_leave_lifecycle_cash_obligation WHERE account_id=$1 AND root_key=$2 FOR UPDATE',[a.id,root]);if(old&&old.currency!==currency)conflict('稳定现金义务币种不可改');
 let exactGross=exactFraction(gross);
 if(root.startsWith('annual:')){const rows=await q(t,"SELECT r.quantity,c.daily_rate_numerator,c.daily_rate_denominator,c.normal_daily_covered FROM ty_leave_cash_reservation r JOIN ty_leave_cash_qualification c ON c.id=r.qualification_id WHERE c.account_id=$1 AND c.root_key||':cash'=$2 AND r.status='converted'",[a.id,root]);exactGross=sumFractions(rows.map(r=>productFraction(r.quantity,{numerator:r.daily_rate_numerator,denominator:r.daily_rate_denominator})));covered=exactDecimal(sumFractions(rows.map(r=>productFraction(r.quantity,r.normal_daily_covered))),4);gross=exactDecimal(exactGross,4);}
 else if(root.startsWith('ot:')){const source=await one(t,'SELECT * FROM ty_leave_overtime_source WHERE id=$1 AND account_id=$2',[Number(root.split(':')[1]),a.id]);exactGross=productFraction(sub(source.cash_basis,source.initial_cash_basis),source.cash_unit_rate);gross=exactDecimal(exactGross,4);covered='0.0000';}
 else{gross=mode==='delta'?add(old?.gross_target||'0',gross):gross;covered=mode==='delta'?add(old?.normal_covered||'0',covered):covered;exactGross=exactFraction(gross);}
 if(!old&&!gt(gross,'0'))return null;if(gt(covered,gross))bad('普通工资覆盖额大于同事项总目标');
 const row=old?await one(t,'UPDATE ty_leave_lifecycle_cash_obligation SET revision=revision+1,gross_target=$2,normal_covered=$3,gross_numerator=$4,gross_denominator=$5 WHERE id=$1 RETURNING *',[old.id,gross,covered,exactGross.numerator,exactGross.denominator]):await one(t,'INSERT INTO ty_leave_lifecycle_cash_obligation(account_id,root_key,currency,revision,gross_target,normal_covered,gross_numerator,gross_denominator)VALUES($1,$2,$3,1,$4,$5,$6,$7)RETURNING *',[a.id,root,currency,gross,covered,exactGross.numerator,exactGross.denominator]);
 await t.query('INSERT INTO ty_leave_lifecycle_cash_revision VALUES($1,$2,$3,$4,$5,$6,$7)',[row.id,row.revision,p.id,gross,covered,exactGross.numerator,exactGross.denominator]);return row;
}

export async function proposeExtension(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_manage',{kind:'extend'}),prior=await priorProposal(t,a,'extend',input);if(prior)return prior;const l=await lot(t,a,input.lot_id),s=await scheme(t,a,input.scheme_id,date(input.as_of));
 if(!s.rules.extension?.enabled)bad('延期规则未启用');const old=l.effective_expires_on||l.expires_on;if(!old||date(input.new_expires_on)<=iso(old))bad('延期只可延长原有有限期限');
 if(!gt(available(l),'0'))bad('已用、已兑付或全部占用的量不能重复延期');
 if(l.statutory&&!s.rules.extension.statutory_legal_route)bad('法定延期路由待核，不能用任意备注授权');
 const days=(Date.parse(input.new_expires_on)-Date.parse(iso(old)))/86400000;if(s.rules.extension.max_days&&days>Number(s.rules.extension.max_days))bad('超过已发布延期上限');
 return propose(t,a,userId,'extend',{...input,previous_expires_on:iso(old),legal_route:l.statutory?s.rules.extension.statutory_legal_route:'published_contract_policy'});
}
export async function proposeCarry(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_manage',{kind:'carry'}),prior=await priorProposal(t,a,'carry',input);if(prior)return prior;const l=await lot(t,a,input.lot_id),s=await scheme(t,a,input.scheme_id,date(input.target_valid_from)),amount=qty(input.quantity);
 if(!s.rules.carry?.enabled||gt(amount,available(l)))bad('未启用结转或超过未占用净额');if(s.rules.carry.max_quantity&&gt(amount,s.rules.carry.max_quantity))bad('超过已批准结转量');
 if(l.statutory&&!s.rules.carry.statutory_legal_route)bad('法定结转路由尚未核定');if(l.advanced!=='0.0000'&&gt(l.advanced,'0'))bad('未清偿预支不能作为新年度已得权益结转');
 date(input.target_expires_on);if(input.target_expires_on<input.target_valid_from)bad('接续期限无效');return propose(t,a,userId,'carry',input,amount);
}
export async function proposeRecurring(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_manage',{selfAllowed:true,kind:'recurring'}),prior=await priorProposal(t,a,'recurring',input);if(prior)return prior;const s=await scheme(t,a,input.scheme_id,date(input.valid_from));
 if(!s.rules.recurring?.enabled||date(input.valid_to)<=input.valid_from||!a.employments.some(e=>same(e.id,input.employment_id)))bad('周期规则、期间或关系不适用');
 const e=a.employments.find(e=>same(e.id,input.employment_id));if(e.status==='cancelled'||iso(e.hire_date)>input.valid_from||e.leave_date&&new Date(Date.parse(iso(e.leave_date)) +86400000).toISOString().slice(0,10)<input.valid_to||s.effective_to&&iso(s.effective_to)<input.valid_to||input.valid_from<iso(a.relationship_from)||a.relationship_to&&iso(a.relationship_to)<input.valid_to)bad('周期须分段落在有效公司关系、实际关系及规则期间内');
 if((Date.parse(input.valid_to)-Date.parse(input.valid_from))/86400000>Number(s.rules.recurring.max_authorization_days||366))bad('周期授权不得超出已核资格窗口，须分期重新核定');
 for(const f of s.rules.recurring.required_facts||[])if(a.qualifications[f]!==true)bad(`周期资格${f}尚未核定`);
 const untilFact=s.rules.recurring.qualification_valid_to_fact;if(untilFact&&(!a.qualifications[untilFact]||date(a.qualifications[untilFact])<input.valid_to))bad('周期授权超过已核资格截止，不能仅延长表单日期');
 if(s.statutory&&a.jurisdiction==='CN'&&s.rules.recurring.legal_type==='nursing'){const children=Number(a.qualifications.nursing_children);if(!untilFact||!Number.isSafeInteger(children)||children<1)bad('哺乳资格期限或同时哺乳婴儿数待核');if(Number(s.rules.recurring.max_minutes_per_day||s.rules.recurring.max_minutes_per_occurrence||60)<60*children||s.rules.recurring.no_balance!==true)bad('哺乳工作时段不能低于适用法定每日权益或扣普通假期余额');}
 if(!Array.isArray(input.slots)||!input.slots.length||input.slots.length>7)bad('须提供1至7个明确时窗');
 const keys=new Set();for(const slot of input.slots){text(slot.key,'时窗稳定键');if(keys.has(slot.key)||!Array.isArray(slot.weekdays)||!slot.weekdays.length||slot.weekdays.some(d=>!Number.isInteger(d)||d<0||d>6)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.end))bad('周期时窗键、星期或时间无效');keys.add(slot.key);const minutes=x=>Number(x.slice(0,2))*60+Number(x.slice(3));let n=minutes(slot.end)-minutes(slot.start);if(n<=0)n+=1440;if(n>Number(s.rules.recurring.max_minutes_per_occurrence||60))bad('超过周期单次上限');}
 const daily=Array(7).fill(0),intervals=[];for(const slot of input.slots){const start=Number(slot.start.slice(0,2))*60+Number(slot.start.slice(3)),end=Number(slot.end.slice(0,2))*60+Number(slot.end.slice(3));for(const d of slot.weekdays){const n=end>start?end-start:1440-start+end;daily[d]+=Math.min(n,1440-start);if(n>1440-start)daily[(d+1)%7]+=n-(1440-start);const a=d*1440+start,b=a+n;for(const[x,y]of intervals)if(a<y&&b>x||a-10080<y&&b-10080>x||a+10080<y&&b+10080>x)bad('周期时窗互相重叠，不能按两个时窗重复生成');intervals.push([a,b]);}}
 if(daily.some(n=>n>Number(s.rules.recurring.max_minutes_per_day||s.rules.recurring.max_minutes_per_occurrence||60)))bad('组合时窗超过每天授权上限');
 return propose(t,a,userId,'recurring',input);
}
export async function proposeAdvance(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_manage',{kind:'advance'}),prior=await priorProposal(t,a,'advance',input);if(prior)return prior;const s=await scheme(t,a,input.scheme_id,date(input.valid_from)),amount=qty(input.quantity);
 if(s.statutory||a.unit!=='minute'||s.rules.entitlement_kind!=='comp_time'||!s.rules.advance?.enabled)bad('仅已发布企业调休预支规则可办理');
 const debt=(await one(t,'SELECT coalesce(sum(outstanding),0)::text n FROM ty_leave_advance WHERE account_id=$1',[a.id])).n;
 if(!s.rules.advance.max_quantity||gt(add(debt,amount),s.rules.advance.max_quantity))bad('超过预支债务上限');
 date(input.due_on);if(input.due_on<input.valid_from||!s.rules.advance.purposes?.includes(input.purpose))bad('用途或归还期限不在获准规则内');return propose(t,a,userId,'advance',input,amount);
}

async function approveSimple(t,a,p,userId){const x=p.payload;
 if(p.kind==='extend'){const l=await lot(t,a,x.lot_id),old=iso(l.effective_expires_on||l.expires_on);if(old!==x.previous_expires_on)conflict('原期限已改变，须重审');const s=await scheme(t,a,x.scheme_id,x.as_of);if(!s.rules.extension?.enabled||l.statutory&&!s.rules.extension.statutory_legal_route)bad('延期合法路由不再适用');await t.query('INSERT INTO ty_leave_extension VALUES($1,$2,$3,$4,$5)',[p.id,l.id,old,x.new_expires_on,x.legal_route]);await t.query("UPDATE ty_leave_lot SET effective_expires_on=$2,expiry_state='active' WHERE id=$1",[l.id,x.new_expires_on]);await t.query('UPDATE ty_leave_account SET revision=revision+1 WHERE id=$1',[a.id]);return{lot_id:l.id,effective_expires_on:x.new_expires_on};}
 if(p.kind==='carry'){const l=await lot(t,a,x.lot_id),s=await scheme(t,a,x.scheme_id,x.target_valid_from);if(gt(p.quantity,available(l)))conflict('可结转净额已不足');const n=await newLot(t,a,p,s,`carry:${p.stable_key}:${p.revision}`,l.entitlement_year,x.target_valid_from,x.target_expires_on),origin=await one(t,'SELECT * FROM ty_leave_credit_origin WHERE lot_id=$1',[l.id]);await creditOrigin(t,n,p,'carry',origin?.root_key||`entitlement:${a.id}:${l.stable_key}`,origin?.source_key||`lot:${l.id}`,l.id);await t.query('INSERT INTO ty_leave_transfer VALUES($1,$2,$3,$4)',[p.id,l.id,n.id,p.quantity]);await ledger(t,p,l.id,'carry_out',p.quantity);await ledger(t,p,n.id,'carry_in',p.quantity);return{from_lot_id:l.id,to_lot_id:n.id,quantity:p.quantity};}
 if(p.kind==='recurring'){const s=await scheme(t,a,x.scheme_id,x.valid_from),e=a.employments.find(e=>same(e.id,x.employment_id));if(!e||e.status==='cancelled'||iso(e.hire_date)>x.valid_from||e.leave_date&&new Date(Date.parse(iso(e.leave_date))+86400000).toISOString().slice(0,10)<x.valid_to||s.effective_to&&iso(s.effective_to)<x.valid_to)conflict('周期公司关系或规则期间已改变');for(const f of s.rules.recurring.required_facts||[])if(a.qualifications[f]!==true)bad('周期资格已变，须重新核定');const old=await q(t,"SELECT * FROM ty_leave_recurring_authorization WHERE account_id=$1 AND stable_key=$2 AND status='active' FOR UPDATE",[a.id,p.stable_key]);for(const prior of old)await t.query("UPDATE ty_leave_recurring_authorization SET status='superseded' WHERE id=$1",[prior.id]);const authorization=await one(t,'INSERT INTO ty_leave_recurring_authorization(proposal_id,account_id,stable_key,revision,scheme_id,employment_id,valid_from,valid_to,slots)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)RETURNING *',[p.id,a.id,p.stable_key,p.revision,x.scheme_id,x.employment_id,x.valid_from,x.valid_to,json(x.slots)]);return{authorization};}
 if(p.kind==='advance'){const s=await scheme(t,a,x.scheme_id,x.valid_from),debt=(await one(t,'SELECT coalesce(sum(outstanding),0)::text n FROM ty_leave_advance WHERE account_id=$1',[a.id])).n;if(gt(add(debt,p.quantity),s.rules.advance.max_quantity))conflict('预支余量已改变');const l=await newLot(t,a,p,s,`advance:${p.stable_key}:${p.revision}`,Number(x.valid_from.slice(0,4)),x.valid_from,x.due_on);await creditOrigin(t,l,p,'advance',`advance:${p.id}`,`advance:${p.id}`);await ledger(t,p,l.id,'advance',p.quantity);const advance=await one(t,"INSERT INTO ty_leave_advance(proposal_id,account_id,lot_id,original_quantity,outstanding,due_on,status)VALUES($1,$2,$3,$4,$4,$5,'open')RETURNING *",[p.id,a.id,l.id,p.quantity,x.due_on]);return{advance,earned_overtime_created:false};}
 bad('不支持的生命周期类型');
}
export async function assertProposalApprovalAccess(t,{userId,id}){
 const p=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1',[id]);if(!p)bad('事项不存在');
 const a=await context(t,userId,p.account_id,'advanced_leave_approve',{kind:p.kind,phase:'approve'});
 if(FINANCIAL_KINDS.has(p.kind))await context(t,userId,p.account_id,'advanced_leave_payroll',{action:'approve',fields:KIND_FIELDS[p.kind]});return a;
}
export async function approveProposal(t,{userId,id,approve=true,reason}){
 const first=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1',[id]);if(!first)bad('待办不存在');const a=await assertProposalApprovalAccess(t,{userId,id}),p=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1 FOR UPDATE',[id]);
 const requirement=await workflowRequirement(t,a,userId,p.kind);if(p.approval_route==='workflow'||requirement.required)throw bizErr('E_LEAVE_USE_APPROVAL','此类事项已绑定审批流，须凭原审批实例批准回执执行，不能走直接核准');
 if(p.status!=='pending'){if(p.status!==(approve?'approved':'rejected'))conflict('事项已处理，不能用重试改成相反结论');return{proposal:p,replayed:true};}if(await sameHuman(t,p.created_by,userId)||await humanIsPerson(t,userId,a.group_id,a.person_id))throw bizErr('E_LEAVE_SELF_APPROVE','生命周期事项须另一有权人员复核');text(reason,'复核意见',4);
 if(typeof approve!=='boolean')bad('须明确批准或驳回');if(approve&&!same(p.baseline_revision,a.revision))conflict('账户预演基线已改变，须重新预演');
 const proposal=await one(t,'UPDATE ty_leave_lifecycle_proposal SET status=$2,approved_by=$3,execution_actor_id=$3,approved_at=clock_timestamp()WHERE id=$1 RETURNING *',[id,approve?'approved':'rejected',userId]);
 let result={};if(approve)result=await applyApprovedProposal(t,a,proposal,userId);
 else if(p.kind==='annual_cash')await releaseCash(t,a,proposal);
 await emit(t,a,`lifecycle:${id}:${proposal.status}`,'leave.lifecycle.decided',{proposal_id:id,kind:p.kind,approve,reason,...result},userId);return{proposal,...result,bank_instruction_created:false};
}
async function applyApprovedProposal(t,a,proposal,userId){
 if(['extend','carry','recurring','advance'].includes(proposal.kind))return approveSimple(t,a,proposal,userId);
 if(proposal.kind==='overtime_basis')return approveOvertimeBasis(t,a,proposal,userId);
 if(proposal.kind==='overtime_allocate')return approveOvertimeAllocation(t,a,proposal,userId);
 if(proposal.kind==='comp_cash')return approveCompCash(t,a,proposal,userId);
 if(proposal.kind==='advance_repay')return approveAdvanceRepayment(t,a,proposal,userId);
 if(proposal.kind==='cash_qualification')return approveCashQualification(t,a,proposal,userId);
 if(proposal.kind==='annual_cash')return approveAnnualCash(t,a,proposal,userId);bad('类型待实现');
}
export async function executeApprovedProposal(t,{userId,id,approvalReceiptId}){
 const first=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1',[id]);if(!first)bad('事项不存在');
 const a=await context(t,userId,first.account_id,'advanced_leave_manage',{kind:first.kind,phase:'execute'});
 const p=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1 FOR UPDATE',[id]);
 if(!(await one(t,"SELECT to_regclass('public.ty_workflow_instance')IS NOT NULL ok"))?.ok)throw bizErr('E_LEAVE_USE_APPROVAL','尚未安装统一审批平台，不能伪造审批回执');
 const workflow=await import('./platform-workflow.mjs');
 const receipt=await workflow.verifyApprovalReceipt(t,{userId,instanceId:approvalReceiptId,subjectType:'leave_lifecycle_proposal',subjectId:String(id),sourceHash:p.payload_hash});
 if(!same(receipt.original_requester_id,p.created_by)||await sameHuman(t,receipt.approved_by,p.created_by)||await humanIsPerson(t,receipt.approved_by,a.group_id,a.person_id)||!same(receipt.execution_actor_id,userId))conflict('原申请人、真实批准人或实际执行者与冻结审批回执不一致');
 if(p.status==='approved'){if(!same(p.workflow_instance_id,receipt.instance_id))conflict('事项已由另一回执生效');return{proposal:p,replayed:true,bank_instruction_created:false};}
 if(p.status!=='pending')conflict('事项已取消或拒绝，旧批准回执不能复活');if(!same(p.baseline_revision,a.revision))conflict('审批后业务基线已改变，须重演重审，不能改用旧回执');
 const proposal=await one(t,"UPDATE ty_leave_lifecycle_proposal SET status='approved',approved_by=$2,execution_actor_id=$3,workflow_instance_id=$4,approved_at=clock_timestamp()WHERE id=$1 RETURNING *",[id,receipt.approved_by,userId,receipt.instance_id]);
 const result=await applyApprovedProposal(t,a,proposal,userId);
 const applied=await t.query("UPDATE ty_workflow_instance SET business_state='applied' WHERE id=$1 AND status='approved' AND source_hash=$2 AND business_state IN('pending','blocked')RETURNING id",[receipt.instance_id,p.payload_hash]);if(!applied.rows.length)conflict('审批回执业务状态已改变，本事务不留半笔领域账');
 await emit(t,a,`lifecycle:${id}:workflow:${receipt.instance_id}`,'leave.lifecycle.approval_receipt_applied',{proposal_id:id,workflow_instance_id:receipt.instance_id,original_requester_id:receipt.original_requester_id,approved_by:receipt.approved_by,execution_actor_id:userId,...result},userId);return{proposal,...result,approval_receipt:receipt,bank_instruction_created:false};
}
export async function rejectWorkflowProposal(t,{userId,id,instanceId}){
 const inst=await one(t,'SELECT * FROM ty_workflow_instance WHERE id=$1 FOR UPDATE',[instanceId]);if(!inst)bad('审批实例不存在');
 const platform=await import('./platform-core.mjs');await platform.requireAccess(t,userId,'workflow_self','approve',{group_id:inst.group_id,company_id:inst.company_id,person_id:inst.person_id});
 const task=await one(t,"SELECT 1 ok FROM ty_workflow_task WHERE instance_id=$1 AND approver_id=$2 AND status='rejected'",[instanceId,userId]);
 if(inst.status!=='rejected'||!same(inst.last_approver_id,userId)||!task||await sameHuman(t,inst.applicant_id,userId))deny();
 const first=await one(t,'SELECT p.*,r.group_id FROM ty_leave_lifecycle_proposal p JOIN ty_leave_account a ON a.id=p.account_id JOIN ty_leave_relationship r ON r.id=a.relationship_id WHERE p.id=$1',[id]);
 const blocked=async()=>{await t.query("UPDATE ty_workflow_instance SET business_state='blocked' WHERE id=$1",[instanceId]);await emit(t,{group_id:inst.group_id},`lifecycle-reject:${instanceId}:blocked`,'leave.lifecycle.rejection_needs_review',{proposal_id:id,workflow_instance_id:instanceId,domain_applied:false},userId);return{blocked:true,domain_applied:false};};
 if(!first||inst.subject_type!=='leave_lifecycle_proposal'||!same(inst.subject_id,id)||inst.source_hash!==first.payload_hash||!same(inst.applicant_id,first.created_by)||!same(inst.group_id,first.group_id))return blocked();
 let a;try{a=await assertProposalApprovalAccess(t,{userId,id});if(await humanIsPerson(t,userId,a.group_id,a.person_id))deny();}catch(e){if(String(e.message).startsWith('E_TY_FORBIDDEN:'))return blocked();throw e;}
 const p=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1 FOR UPDATE',[id]);if(p.status==='rejected'&&same(p.workflow_instance_id,instanceId))return{replayed:true,domain_applied:true};if(p.status!=='pending')return blocked();
 await t.query('SAVEPOINT leave_lifecycle_reject');
 try{if(p.kind==='annual_cash')await releaseCash(t,a,p);const proposal=await one(t,"UPDATE ty_leave_lifecycle_proposal SET status='rejected',approved_by=$2,execution_actor_id=$2,workflow_instance_id=$3,approved_at=clock_timestamp()WHERE id=$1 RETURNING *",[id,userId,instanceId]);await t.query("UPDATE ty_workflow_instance SET business_state='applied' WHERE id=$1",[instanceId]);await t.query('RELEASE SAVEPOINT leave_lifecycle_reject');await emit(t,a,`lifecycle-reject:${instanceId}:applied`,'leave.lifecycle.rejected',{proposal_id:id,workflow_instance_id:instanceId,original_requester_id:p.created_by,approved_by:userId,execution_actor_id:userId},userId);return{proposal,domain_applied:true,cash_released:p.kind==='annual_cash',bank_instruction_created:false};}
 catch{await t.query('ROLLBACK TO SAVEPOINT leave_lifecycle_reject');await t.query('RELEASE SAVEPOINT leave_lifecycle_reject');return blocked();}
}

export async function proposeOvertimeBasis(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_payroll',{kind:'overtime_basis'}),s=await scheme(t,a,input.scheme_id,date(input.as_of));
 if(a.unit!=='minute'||s.statutory||s.rules.entitlement_kind!=='comp_time'||!s.rules.compensation?.enabled)bad('须使用已发布的企业加班补偿方案');
 const amount=qty(input.verified_minutes),cash=qty(input.initial_cash_basis||'0',false),comp=qty(input.initial_comp_basis||'0',false),hold=qty(input.unknown_hold_basis||'0',false);
 if(gt(add(add(cash,comp),hold),amount))bad('已付/已转/未知占用超过已核原始分钟');
 if(gt(cash,'0'))text(input.historical_cash_posting_ref,'原现金采用或已付依据',4);if(gt(comp,'0'))text(input.historical_comp_posting_ref,'原调休已生成依据',4);
 if(!['native_confirmed','external_verified'].includes(input.source_kind))bad('须区分原生封存事实或外部已核基线');
 let namespace=text(input.source_namespace,'来源命名空间'),fact=text(input.work_fact_key,'稳定工作事实键'),workDate=input.work_date?date(input.work_date):null,employmentId=input.employment_id||null,nativeSourceHash=null;
 if(input.source_kind==='native_confirmed'){
  namespace='native_ty_time_segment';const id=Number(input.native_segment_id);if(!Number.isSafeInteger(id)||id<1)bad('原生来源须指向真实班段');fact=String(id);
  const native=await nativeOvertime(t,id);
  if(!native||native.status!=='closed'||!native.overtime||!a.employments.some(e=>same(e.id,native.employment_id))||workDate&&iso(native.work_date)!==workDate||compareDecimal(String(native.credited_minutes),amount)!==0)bad('原生来源必须匹配该实际关系的已封存实核加班分钟');workDate=iso(native.work_date);employmentId=native.employment_id;nativeSourceHash=nativeHash(native);
 }else{
  if(input.verification_state!=='reviewed_external_baseline')bad('外部资料必须先明确核定状态，不能伪称原生打卡事实');text(input.external_locator,'外部核定定位',4);text(input.external_document_hash,'外部核定文件摘要',16);
 }
 const periodBaseline=input.source_kind==='external_verified'&&input.source_granularity==='period';
 if(periodBaseline){if(date(input.period_to)<=date(input.period_from)||input.classification_verified!==true||input.original_day_details_unavailable!==true)bad('无逐日原件的已核期间基线须保留真实粒度与类别核定，不能伪造工作日期');text(input.classification_locator,'原类别分桶核定定位',4);workDate=null;}
 else{if(!workDate)bad('逐日来源须有可核工作日期');const possible=a.employments.filter(e=>e.status!=='cancelled'&&iso(e.hire_date)<=workDate&&(!e.leave_date||iso(e.leave_date)>=workDate));if(!employmentId&&possible.length===1)employmentId=possible[0].id;if(!possible.some(e=>same(e.id,employmentId)))bad('须明确该日期所属有效公司关系，不能从多段关系猜测');}
 const personal=s.rules.personnel_calendars?.[String(employmentId)],calendar=personal?{...personal,holiday_dates:[...new Set([...(s.rules.holiday_dates||[]),...(personal.holiday_dates||[])])]}:s.rules;
 const expected=periodBaseline?input.classification:a.jurisdiction==='HK'?'HK_CONTRACT':calendar.holiday_dates?.includes(workDate)?'CN_HOLIDAY':calendar.rest_dates?.includes(workDate)?'CN_REST':'CN_WEEKDAY';
 if(!['CN_WEEKDAY','CN_REST','CN_HOLIDAY','HK_CONTRACT'].includes(expected)||a.jurisdiction==='CN'&&expected==='HK_CONTRACT'||a.jurisdiction==='HK'&&expected!=='HK_CONTRACT')bad('法域与加班分类不一致');
 if(a.jurisdiction==='CN'&&!periodBaseline&&(calendar.calendar_status!=='verified'||!calendar.calendar_version||!Array.isArray(calendar.holiday_dates)||!Array.isArray(calendar.rest_dates)||!calendar.calendar_valid_from||!calendar.calendar_valid_to||workDate<calendar.calendar_valid_from||workDate>=calendar.calendar_valid_to))bad('内地加班分类日历待核');
 if(input.classification!==expected)bad('加班日型须匹配已发布适用日历');
 const allowComp=expected==='CN_REST'?s.rules.compensation.cn_rest_comp_allowed===true:expected==='HK_CONTRACT'?s.rules.compensation.hk_contract_comp_allowed===true:false;
 if(expected==='HK_CONTRACT'&&allowComp)text(input.employee_agreement_ref,'香港合约调休约定',4);
 if(input.allow_comp===true&&!allowComp||!allowComp&&gt(comp,'0'))bad('该日型不能以调休替代应有现金');
 if(!Number.isSafeInteger(input.ratio_numerator)||!Number.isSafeInteger(input.ratio_denominator)||input.ratio_numerator<1||input.ratio_denominator<1||input.ratio_numerator<input.ratio_denominator)bad('补偿比例须为不减少基础权益的正有理数');
 text(input.pricing_ref,'已核计价/最低保障依据',4);if(compareDecimal(input.cash_unit_rate,'0')<0)bad('计价不可负');
 if(input.pricing_source_kind!=='external_verified')bad('原生加班分钟不等于原生计价基线；须明确另行核准的工资计价来源');text(input.pricing_document_hash,'计价原件摘要',16);text(input.pricing_source_locator,'计价核定定位',4);
 if(a.jurisdiction==='CN'){const base=qty(input.verified_ordinary_hourly_base);const multiplier={CN_WEEKDAY:150,CN_REST:200,CN_HOLIDAY:300}[expected],minimum=ratio(base,multiplier,6000,10);if(compareDecimal(input.cash_unit_rate,minimum)<0)bad('加班现金单价低于已核普通小时工资及适用法定日型最低倍数');}
 if(input.currency!==(a.jurisdiction==='HK'?'HKD':'CNY'))bad('币种与实际关系体系不一致');
 return propose(t,a,userId,'overtime_basis',{...input,employment_id:employmentId,work_date:workDate,source_granularity:periodBaseline?'period':'day',source_namespace:namespace,work_fact_key:fact,native_source_hash:nativeSourceHash,allow_comp:allowComp,allow_comp_cash:allowComp&&input.allow_comp_cash===true&&s.rules.compensation.allow_comp_cash===true,stable_key:`ot:${input.source_kind}:${namespace}:${fact}`});
}
async function approveOvertimeBasis(t,a,p){
 const x=p.payload,old=await one(t,'SELECT * FROM ty_leave_overtime_source WHERE account_id=$1 AND source_kind=$2 AND source_namespace=$3 AND work_fact_key=$4 FOR UPDATE',[a.id,x.source_kind,x.source_namespace,x.work_fact_key]);
 if(x.source_kind==='native_confirmed'){const current=await nativeOvertime(t,x.native_segment_id);if(!current||current.status!=='closed'||nativeHash(current)!==x.native_source_hash)conflict('审批后原生加班事实或封存版本已变，须重演重审');}
 if(old){
  if(Number(old.latest_revision)>=Number(p.revision))conflict('加班来源版本已前进');
  for(const[k,v]of Object.entries({classification:x.classification,currency:x.currency,pricing_ref:x.pricing_ref,allow_comp:x.allow_comp,allow_comp_cash:x.allow_comp_cash===true,ratio_numerator:x.ratio_numerator,ratio_denominator:x.ratio_denominator}))if(String(old[k])!==String(v))conflict('已分配工作事实的类别、比例和计价身份不可改写');
  for(const k of['initial_cash_basis','initial_comp_basis','unknown_hold_basis','cash_unit_rate'])if(compareDecimal(old[k],x[k]||'0')!==0)conflict('历史已用及未知占用基线不可覆盖，须专门有据处理');
  if(gt(add(add(old.cash_basis,old.comp_basis),old.unknown_hold_basis),x.verified_minutes))conflict('新核定量小于已分配量');
 }
 const source=old?await one(t,'UPDATE ty_leave_overtime_source SET latest_revision=$2,verified_minutes=$3 WHERE id=$1 RETURNING *',[old.id,p.revision,x.verified_minutes]):await one(t,`INSERT INTO ty_leave_overtime_source(account_id,relationship_id,source_kind,source_namespace,work_fact_key,latest_revision,classification,verified_minutes,initial_cash_basis,initial_comp_basis,unknown_hold_basis,cash_basis,comp_basis,ratio_numerator,ratio_denominator,currency,cash_unit_rate,allow_comp,allow_comp_cash,pricing_ref)VALUES($1,$18,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8,$9,$11,$12,$13,$14,$15,$16,$17)RETURNING *`,[a.id,x.source_kind,x.source_namespace,x.work_fact_key,p.revision,x.classification,x.verified_minutes,x.initial_cash_basis||'0',x.initial_comp_basis||'0',x.unknown_hold_basis||'0',x.ratio_numerator,x.ratio_denominator,x.currency,x.cash_unit_rate,x.allow_comp,x.allow_comp_cash===true,x.pricing_ref,a.relationship_id]);
 await t.query('INSERT INTO ty_leave_overtime_revision VALUES($1,$2,$3,$4::jsonb)',[source.id,p.revision,p.id,json(x)]);return{source};
}
export async function proposeOvertimeAllocation(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_manage',{kind:'overtime_allocate'}),prior=await priorProposal(t,a,'overtime_allocate',input,`ot-allocation:${input.source_id}`);if(prior)return prior;const s=await one(t,'SELECT * FROM ty_leave_overtime_source WHERE id=$1 AND account_id=$2 FOR UPDATE',[input.source_id,a.id]);if(!s||Number(s.latest_revision)!==Number(input.source_revision))conflict('来源核定版本已改变');
 await assertSourceSnapshot(t,s);
 const cash=qty(input.cash_basis_target,false),comp=qty(input.comp_basis_target,false);if(compareDecimal(cash,s.cash_basis)<0||compareDecimal(comp,s.comp_basis)<0)bad('累计分配不可隐式撤回已付或已转部分');
 if(gt(add(add(cash,comp),s.unknown_hold_basis),s.verified_minutes)||!s.allow_comp&&gt(comp,'0'))bad('基础分钟超额或调休日型不合法');
 await scheme(t,a,input.scheme_id,date(input.grant_valid_from));return propose(t,a,userId,'overtime_allocate',{...input,stable_key:`ot-allocation:${s.id}`});
}
async function approveOvertimeAllocation(t,a,p,userId){
 const x=p.payload,source=await one(t,'SELECT * FROM ty_leave_overtime_source WHERE id=$1 AND account_id=$2 FOR UPDATE',[x.source_id,a.id]);if(Number(source.latest_revision)!==Number(x.source_revision))conflict('加班来源版本已变');
 await assertSourceSnapshot(t,source);
 const cashDelta=sub(x.cash_basis_target,source.cash_basis),compDelta=sub(x.comp_basis_target,source.comp_basis);if(compareDecimal(cashDelta,'0')<0||compareDecimal(compDelta,'0')<0||gt(add(add(x.cash_basis_target,x.comp_basis_target),source.unknown_hold_basis),source.verified_minutes))conflict('分配基线已变');
 const s=await scheme(t,a,x.scheme_id,x.grant_valid_from);if(!source.allow_comp&&gt(compDelta,'0'))bad('法定现金不得用调休代替');
 const lifetimeNewComp=sub(add(x.comp_basis_target,source.comp_returned_basis),source.initial_comp_basis),raw=ratio(lifetimeNewComp,source.ratio_numerator,source.ratio_denominator,10),mintTarget=cumulativeGrant({total:raw,numerator:'1',denominator:'1',step:s.rules.compensation?.grant_step||'1',scale:4,rounding:'floor'}).target,mintDelta=sub(mintTarget,source.comp_generated);if(compareDecimal(mintDelta,'0')<0)conflict('已生成调休不得用新分配覆盖');
 let l=null;if(gt(mintDelta,'0')){const days=Number(s.rules.compensation?.valid_days);if(!Number.isSafeInteger(days)||days<1||days>3660)bad('调休有效期尚未核定');const expiry=new Date(Date.parse(x.grant_valid_from+'T00:00Z')+days*86400000).toISOString().slice(0,10);l=await newLot(t,a,p,s,`ot:${source.id}:allocation:${p.revision}`,Number(x.grant_valid_from.slice(0,4)),x.grant_valid_from,expiry);}
 await t.query('INSERT INTO ty_leave_overtime_allocation VALUES($1,$2,$3,$4,$5,$6)',[p.id,source.id,cashDelta,compDelta,mintDelta,l?.id||null]);
 if(l){await creditOrigin(t,l,p,'earned_overtime',`ot:${source.id}`,`ot:${source.id}`);await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id,payload)VALUES($1,$2,'grant',$3,$4,$5,$6::jsonb)",[l.id,`ot-allocation:${p.id}`,mintDelta,p.evidence_ref,userId,json({lifecycle_proposal_id:p.id,source_id:source.id,source_revision:source.latest_revision,comp_basis_delta:compDelta})]);}
 await t.query('UPDATE ty_leave_overtime_source SET cash_basis=$2,comp_basis=$3,comp_generated=$4 WHERE id=$1',[source.id,x.cash_basis_target,x.comp_basis_target,mintTarget]);
 const cashTarget=multiply(sub(x.cash_basis_target,source.initial_cash_basis),source.cash_unit_rate),obligation=await cashObligation(t,a,p,`ot:${source.id}:cash`,source.currency,cashTarget);
 return{source_id:source.id,cash_basis_delta:cashDelta,comp_basis_delta:compDelta,comp_quantity_delta:mintDelta,lot_id:l?.id||null,obligation,actual_overtime_minutes_created:false};
}
export async function proposeCompCash(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_manage',{kind:'comp_cash'}),prior=await priorProposal(t,a,'comp_cash',input);if(prior)return prior;const l=await lot(t,a,input.lot_id),origin=await one(t,"SELECT * FROM ty_leave_credit_origin WHERE lot_id=$1 AND kind IN('earned_overtime','carry')",[l.id]);if(!origin||!origin.source_key.startsWith('ot:'))bad('须能追溯到已核加班原始补偿根');
 const source=await one(t,'SELECT * FROM ty_leave_overtime_source WHERE id=$1 AND account_id=$2 FOR UPDATE',[Number(origin.source_key.slice(3)),a.id]),quantity=qty(input.quantity);if(!source?.allow_comp_cash||gt(quantity,available(l)))bad('无获准调休转回现金路由或剩余量不足');if(gt(l.advanced,'0'))bad('预支不是已得加班，不得转现金');
 await assertSourceSnapshot(t,source);
 return propose(t,a,userId,'comp_cash',{...input,source_id:source.id,source_revision:source.latest_revision},quantity);
}
async function approveCompCash(t,a,p){const x=p.payload,l=await lot(t,a,x.lot_id),s=await one(t,'SELECT * FROM ty_leave_overtime_source WHERE id=$1 AND account_id=$2 FOR UPDATE',[x.source_id,a.id]);await assertSourceSnapshot(t,s);if(!s.allow_comp_cash||Number(s.latest_revision)!==Number(x.source_revision)||gt(p.quantity,available(l)))conflict('剩余调休或来源核定已改变');const qf=exactFraction(p.quantity),exactBasis={numerator:String(BigInt(qf.numerator)*BigInt(s.ratio_denominator)),denominator:String(BigInt(qf.denominator)*BigInt(s.ratio_numerator))},basis=exactDecimal(exactBasis,4);if(compareDecimal(basis,exactBasis)!==0)bad('所选转换量不能精确还原基础分钟，请选兼容步长或人工核定');if(gt(basis,sub(s.comp_basis,s.initial_comp_basis)))bad('不能转换历史已用或已转换基础量');await t.query('INSERT INTO ty_leave_comp_cash_conversion VALUES($1,$2,$3,$4,$5)',[p.id,s.id,l.id,p.quantity,basis]);await ledger(t,p,l.id,'comp_cash',p.quantity);const cash=add(s.cash_basis,basis);await t.query('UPDATE ty_leave_overtime_source SET cash_basis=$2,comp_basis=comp_basis-$3,comp_returned_basis=comp_returned_basis+$3 WHERE id=$1',[s.id,cash,basis]);const obligation=await cashObligation(t,a,p,`ot:${s.id}:cash`,s.currency,multiply(sub(cash,s.initial_cash_basis),s.cash_unit_rate));return{basis_minutes:basis,converted_quota:p.quantity,obligation,actual_overtime_minutes_created:false};}

export async function proposeAdvanceRepayment(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_manage',{kind:'advance_repay'}),prior=await priorProposal(t,a,'advance_repay',input,`repay:${input.advance_id}:${input.stable_key}`);if(prior)return prior;const d=await one(t,'SELECT * FROM ty_leave_advance WHERE id=$1 AND account_id=$2 FOR UPDATE',[input.advance_id,a.id]),l=await lot(t,a,input.source_lot_id),origin=await one(t,"SELECT * FROM ty_leave_credit_origin WHERE lot_id=$1 AND kind IN('earned_overtime','carry','verified_external_earned')",[l.id]),amount=qty(input.quantity);
 if(!d||!origin||gt(l.advanced,'0')||gt(amount,available(l))||gt(amount,d.outstanding))bad('须用真实已得调休归还未清偿预支，不得造加班或超额');
 return propose(t,a,userId,'advance_repay',{...input,stable_key:`repay:${d.id}:${input.stable_key}`},amount);
}
async function approveAdvanceRepayment(t,a,p,userId){const x=p.payload,d=await one(t,'SELECT * FROM ty_leave_advance WHERE id=$1 AND account_id=$2 FOR UPDATE',[x.advance_id,a.id]),l=await lot(t,a,x.source_lot_id);if(gt(p.quantity,available(l))||gt(p.quantity,d.outstanding))conflict('可清偿量已改变');await ledger(t,p,l.id,'repay_source',p.quantity);await ledger(t,p,d.lot_id,'repay_loan',p.quantity);await t.query('INSERT INTO ty_leave_advance_repayment VALUES($1,$2,$3,$4,$5,$6,clock_timestamp())',[d.id,p.stable_key,l.id,p.quantity,p.id,userId]);const remaining=sub(d.outstanding,p.quantity);await t.query('UPDATE ty_leave_advance SET outstanding=$2,status=$3 WHERE id=$1',[d.id,remaining,gt(remaining,'0')?'open':'repaid']);return{advance_id:d.id,repaid:p.quantity,outstanding:remaining,payroll_deduction_created:false};}
export async function reviewExitAdvances(t,{userId,accountId,on,evidenceRef}){
 const a=await context(t,userId,accountId,'advanced_leave_manage',{action:'execute',fields:['advanced','outstanding','status']});date(on);text(evidenceRef,'离职核对依据',4);
 if(a.employments.some(e=>e.status!=='ended'||!e.leave_date||iso(e.leave_date)>on))bad('此实际关系仍有未结束公司关系，不能推断整体离职');
 const debts=await q(t,'SELECT * FROM ty_leave_advance WHERE account_id=$1 AND outstanding>0 FOR UPDATE',[a.id]);
 for(const debt of debts){await t.query("UPDATE ty_leave_advance SET status='exit_review' WHERE id=$1",[debt.id]);await t.query("INSERT INTO ty_leave_lifecycle_review(account_id,stable_key,kind,payload,created_by)VALUES($1,$2,'advance_exit_review',$3::jsonb,$4)ON CONFLICT DO NOTHING",[a.id,`advance-exit:${debt.id}`,json({advance_id:debt.id,outstanding:debt.outstanding,evidence_ref:evidenceRef,no_automatic_wage_deduction:true}),userId]);}
 await emit(t,a,`advance-exit:${a.id}:${on}`,'leave.advance.exit_review',{advance_ids:debts.map(d=>d.id),no_automatic_wage_deduction:true},userId);return{debts,payroll_deduction_created:false,private_debt_inferred:false};
}

async function verifiedWageFacts(t,userId,a,x){
 const f=x.wage_basis;if(!f||!['native_confirmed','external_verified'].includes(f.source_kind))bad('计价工资基线未核定');
 if(f.source_kind==='external_verified'){if(f.verification_status!=='verified')bad('计价工资基线未核定');text(f.source_ref,'工资基线来源',4);text(f.document_hash,'外部工资基线摘要',16);text(f.source_locator,'外部工资核定定位',4);return f;}
 const keys=['source_kind','verification_status','employment_id','reference_date','kind'];if(Object.keys(f).some(k=>!keys.includes(k)))bad('原生工资基线只接受雇佣、日期及用途选择，不接受客户端工资金额');
 const e=a.employments.find(e=>same(e.id,f.employment_id));if(!e||!same(e.person_id,a.person_id)||!same(e.group_id,a.group_id))bad('原生工资基线必须来自该假期关系的实际雇佣');const on=date(f.reference_date),kind=a.jurisdiction==='HK'?'hk_adw':'cn_annual_average';if(f.kind&&f.kind!==kind)bad('原生工资基线用途与假期地区不一致');
 if(!(await one(t,"SELECT to_regclass('public.ty_pay_batch')IS NOT NULL ok"))?.ok)bad('原生工资模块尚未安装');const mapping=await one(t,"SELECT * FROM ty_pay_config WHERE company_id=$1 AND employment_id=$2 AND kind='relationship'AND status='approved'AND valid_from<=$3 AND(valid_to IS NULL OR valid_to>$3)ORDER BY revision DESC,id DESC LIMIT 1",[e.company_id,e.id,on]);if(!mapping||mapping.data.actual_employer_key!==a.legal_employer_key)bad('原生工资与假期的实际法律雇主映射须先核对一致');
 const selector={employment_id:e.id,reference_date:on,kind},w=await(await import('./payroll-source.mjs')).nativeWageBasis(t,{userId,input:selector});if(w.verification_status!=='verified'||w.source_kind!=='native_confirmed'||!w.source_hash)bad('原生工资基线未完成核定');return{...w,selector,source_ref:'native-payroll:'+e.id+':'+on+':'+w.source_hash};
}
async function assertWageBasisCurrent(t,userId,a,payload){const saved=payload.verified_wage_basis;if(saved?.source_kind!=='native_confirmed')return;const current=await verifiedWageFacts(t,userId,a,{wage_basis:payload.wage_basis});if(current.source_hash!==saved.source_hash||digest(current.source_refs)!==digest(saved.source_refs))conflict('已确认工资来源已变化，须重新核定年假计价资格');}

export async function proposeCashQualification(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_payroll',{kind:'cash_qualification'}),prior=await priorProposal(t,a,'cash_qualification',input,`annual-cash-qualification:${input.entitlement_year}`);if(prior)return prior;const s=await scheme(t,a,input.scheme_id,date(input.as_of));if(a.unit!=='day')bad('年假现金资格须保留日权益，不能将分钟当日');
 const year=Number(input.entitlement_year);if(!Number.isInteger(year)||year<1900||year>9999)bad('权益年度无效');
 if(!['reconciled_zero','reconciled_amount'].includes(input.historical_status))bad('往年及已付/已采用/现金历史待核，不能默认零');
 const historical=qty(input.historical_cash_days||'0',false);if(gt(historical,'0'))text(input.historical_posting_ref,'历史现金核对回执',4);
 let maximum='0',rate,normal='0';const facts=input.facts||{},w=s.statutory?await verifiedWageFacts(t,userId,a,input):null;
 if(s.statutory){if(a.code!=='annual')bad('法定假日或其他不可买断假种不能套用年假现金路径');
  if(a.jurisdiction==='CN'){
   if(a.qualifications.continuous_work_12_months!==true||a.qualifications.service_years===undefined)bad('内地法定年假资格及累计工龄待核，不能默认零或买断');
   if(!['CN_UNTAKEN_CONSENT','CN_TERMINATION'].includes(input.route))bad('内地法定年假须走明确法定分支');
   if(w.overtime_excluded!==true)bad('内地未休年假工资基数须剔除加班工资');const base=exactFraction(w.monthly_average_excluding_overtime),divisor=exactFraction('21.75');rate={numerator:String(BigInt(base.numerator)*BigInt(divisor.denominator)*3n),denominator:String(BigInt(base.denominator)*BigInt(divisor.numerator))};
   if(w.source_kind==='native_confirmed'){const c=facts.normal_wage_coverage;if(!c||c.source_kind!=='external_verified'||c.verification_status!=='verified')bad('未休年假的已付普通工资覆盖额须另行核定，不能从平均工资推断');text(c.source_ref,'普通工资覆盖依据',4);text(c.document_hash,'普通工资覆盖凭证摘要',16);text(c.source_locator,'普通工资覆盖凭证定位',4);normal=qty(c.daily_amount,false);}else normal=qty(w.normal_daily_already_covered||'0',false);if(gt(normal,ratio({numerator:base.numerator,denominator:base.denominator},BigInt(divisor.denominator),BigInt(divisor.numerator),10)))bad('普通工资覆盖额须对应同一休假日已付普通工资');
   const band=cnAnnualBand({serviceYears:a.qualifications.service_years,eligible:a.qualifications.continuous_work_12_months===true});
   if(input.route==='CN_UNTAKEN_CONSENT'){if(facts.employer_unable_to_arrange!==true)bad('须有不能安排年假的事实');text(facts.employer_unable_ref,'未能安排事实依据',4);text(facts.employee_written_consent_ref,'员工书面同意',4);maximum=band;}
   else{const ended=date(facts.termination_date);if(a.employments.some(e=>e.status!=='ended'||!e.leave_date)||a.employments.map(e=>iso(e.leave_date)).sort().at(-1)!==ended)bad('终止日期须由实际关系所有公司段核对');if(Number(ended.slice(0,4))!==year)bad('终止折算须使用终止年度');const from=[`${year}-01-01`,iso(a.relationship_from)].sort().at(-1),days=String((Date.parse(ended)-Date.parse(from))/86400000+1),arranged=(await one(t,'SELECT coalesce(sum(taken),0)::text n FROM ty_leave_lot WHERE account_id=$1 AND entitlement_year=$2',[a.id,year])).n;maximum=cnAnnualProration({calendarDays:days,annualDays:band,alreadyTaken:arranged,termination:true}).days;}
  }else{
   if(a.qualifications.completed_continuous_years===undefined)bad('香港连续合约年资待核，不能默认零或买断');
   if(!['HK_IN_SERVICE_EXCESS10','HK_TERMINATION_DETERMINED'].includes(input.route))bad('香港法定年假须选明确合法路径');
   if(w.paired_exclusions_verified!==true)bad('香港ADW排除日及对应工资须成对核定');rate=hkADW({wages:w.wages,calendarDays:w.calendar_days,excludedDays:w.excluded_days||'0',excludedWages:w.excluded_wages||'0'}).fraction;
   if(input.route==='HK_IN_SERVICE_EXCESS10'){text(facts.employee_cash_election_ref,'员工选择超过10日部分的证明',4);const days=hkAnnualDays({completedYears:a.qualifications.completed_continuous_years});maximum=hkAnnualCashChoice({entitledDays:days,requestedDays:'0'}).maxCashDays;}
   else{if(facts.authority_type!=='adjudicated_legal_entitlement'||facts.completed_year_rights_preserved!==true)bad('香港终止模板未知部分须保持待核，不能凭任意备注允许买断');for(const key of['determination_ref','issuer_ref','determination_document_hash','dismissal_classification'])text(facts[key],`外部法律核定${key}`,4);if(a.employments.some(e=>e.status!=='ended'||!e.leave_date))bad('仍有有效真实雇佣，不得套终止路径');maximum=qty(facts.determined_days,false);}
  }
 }else{
  if(input.route!=='CONTRACTUAL'||!s.rules.cash_conversion?.enabled||s.rules.cash_conversion.daily_rate===undefined)bad('企业福利现金政策待核');text(facts.employee_election_ref,'员工选择及合约依据',4);rate=exactFraction(s.rules.cash_conversion.daily_rate);maximum=qty(s.rules.cash_conversion.maximum_days,false);
 }
 if(gt(historical,maximum))bad('已核历史转换量超过资格上限，须人工处理原记录而非重发');
 return propose(t,a,userId,'cash_qualification',{...input,verified_wage_basis:w,stable_key:`annual-cash-qualification:${year}`,maximum_days:maximum,historical_cash_days:historical,daily_rate:rate,normal_daily_covered:normal,currency:a.jurisdiction==='HK'?'HKD':'CNY'});
}
async function approveCashQualification(t,a,p,userId){await assertWageBasisCurrent(t,userId,a,p.payload);const x=p.payload,root=`annual:${x.entitlement_year}`,old=await one(t,"SELECT * FROM ty_leave_cash_qualification WHERE account_id=$1 AND root_key=$2 AND status='approved' FOR UPDATE",[a.id,root]);if(old&&gt(old.reserved_days,'0'))conflict('上一版本有现金预占，须先处理后再核新版');const converted=old?.converted_days||'0';if(old&&compareDecimal(old.historical_cash_days,x.historical_cash_days)!==0)conflict('历史现金基线不得覆盖');if(gt(add(x.historical_cash_days,converted),x.maximum_days))conflict('新资格上限小于已转换量');if(old)await t.query("UPDATE ty_leave_cash_qualification SET status='superseded' WHERE id=$1",[old.id]);const qualification=await one(t,`INSERT INTO ty_leave_cash_qualification(proposal_id,account_id,entitlement_year,root_key,revision,route,maximum_days,historical_cash_days,converted_days,currency,daily_rate_numerator,daily_rate_denominator,normal_daily_covered,facts,status)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,'approved')RETURNING *`,[p.id,a.id,x.entitlement_year,root,p.revision,x.route,x.maximum_days,x.historical_cash_days,converted,x.currency,x.daily_rate.numerator,x.daily_rate.denominator,x.normal_daily_covered,json(x)]);return{qualification};}
export async function proposeAnnualCash(t,{userId,input}){
 const a=await context(t,userId,input.account_id,'advanced_leave_payroll',{kind:'annual_cash'}),prior=await priorProposal(t,a,'annual_cash',input);if(prior)return prior;const l=await lot(t,a,input.lot_id),c=await one(t,"SELECT * FROM ty_leave_cash_qualification WHERE id=$1 AND account_id=$2 AND status='approved' FOR UPDATE",[input.qualification_id,a.id]),amount=qty(input.quantity);if(!c||Number(c.revision)!==Number(input.qualification_revision)||Number(l.entitlement_year)!==Number(c.entitlement_year))bad('没有该原年度的当前现金资格');
 if(gt(amount,available(l))||gt(add(add(add(c.historical_cash_days,c.converted_days),c.reserved_days),amount),c.maximum_days))bad('超过未占用原权益或法定可转换上限');
 const result=await propose(t,a,userId,'annual_cash',input,amount,1);if(result.replayed)return result;
 const gross=ratio(amount,c.daily_rate_numerator,c.daily_rate_denominator),covered=multiply(amount,c.normal_daily_covered);await t.query("INSERT INTO ty_leave_cash_reservation VALUES($1,$2,$3,$4,$5,$6,'held')",[result.proposal.id,c.id,l.id,amount,gross,covered]);await t.query('UPDATE ty_leave_cash_qualification SET reserved_days=reserved_days+$2 WHERE id=$1',[c.id,amount]);await ledger(t,result.proposal,l.id,'cash_hold',amount);return{...result,gross_target:gross,normal_covered:covered,additional_cash_target:sub(gross,covered)};
}
async function releaseCash(t,a,p){const r=await one(t,'SELECT * FROM ty_leave_cash_reservation WHERE proposal_id=$1 FOR UPDATE',[p.id]);if(!r||r.status!=='held')conflict('现金预占已变化');await ledger(t,p,r.lot_id,'cash_release',r.quantity);await t.query("UPDATE ty_leave_cash_reservation SET status='released' WHERE proposal_id=$1",[p.id]);await t.query('UPDATE ty_leave_cash_qualification SET reserved_days=reserved_days-$2 WHERE id=$1',[r.qualification_id,r.quantity]);}
async function approveAnnualCash(t,a,p,userId){const r=await one(t,'SELECT * FROM ty_leave_cash_reservation WHERE proposal_id=$1 FOR UPDATE',[p.id]),c=await one(t,"SELECT * FROM ty_leave_cash_qualification WHERE id=$1 AND status='approved' FOR UPDATE",[r?.qualification_id]);if(!r||!c||r.status!=='held'||Number(c.revision)!==Number(p.payload.qualification_revision))conflict('现金资格或预占已变');await assertWageBasisCurrent(t,userId,a,c.facts);await ledger(t,p,r.lot_id,'cash_convert',r.quantity);await t.query("UPDATE ty_leave_cash_reservation SET status='converted' WHERE proposal_id=$1",[p.id]);await t.query('UPDATE ty_leave_cash_qualification SET reserved_days=reserved_days-$2,converted_days=converted_days+$2 WHERE id=$1',[c.id,r.quantity]);const obligation=await cashObligation(t,a,p,`${c.root_key}:cash`,c.currency,r.gross_target,r.normal_covered,'delta');return{converted_days:r.quantity,obligation};}
export async function cancelProposal(t,{userId,id,reason}){const first=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1',[id]);if(!first)bad('事项不存在');const a=await context(t,userId,first.account_id,'advanced_leave_manage',{selfAllowed:first.kind==='recurring',kind:first.kind,phase:'cancel'}),p=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1 FOR UPDATE',[id]);if(p.status==='cancelled')return{proposal:p,replayed:true};if(p.status!=='pending')conflict('已确认权益或现金义务不能直接恢复，须正式更正及采用回执核对');text(reason,'取消原因',4);if(a.self&&!same(p.created_by,userId))deny();if(p.kind==='annual_cash')await releaseCash(t,a,p);const proposal=await one(t,"UPDATE ty_leave_lifecycle_proposal SET status='cancelled' WHERE id=$1 RETURNING *",[id]);await emit(t,a,`lifecycle:${id}:cancelled`,'leave.lifecycle.cancelled',{proposal_id:id,reason},userId);return{proposal};}

export async function buildOccurrences(t,{userId,authorizationId,from,to}){
 const initial=await one(t,'SELECT * FROM ty_leave_recurring_authorization WHERE id=$1',[authorizationId]);if(!initial)bad('周期授权不存在');const a=await context(t,userId,initial.account_id,'advanced_leave_manage',{selfAllowed:true,action:'submit',fields:['starts_at','ends_at','status']}),auth=await one(t,"SELECT * FROM ty_leave_recurring_authorization WHERE id=$1 AND status='active' FOR UPDATE",[authorizationId]);
 if(!auth||date(from)<iso(auth.valid_from)||date(to)>iso(auth.valid_to)||to<=from||(Date.parse(to)-Date.parse(from))/86400000>93)bad('每次生成须在授权范围内且不超过93日');
 const source=await one(t,"SELECT payload FROM ty_leave_lifecycle_proposal WHERE id=$1 AND status='approved'",[auth.proposal_id]);if(!source)bad('没有有效审批授权');
 const result=[],seen=[];
 for(let n=Date.parse(from+'T00:00Z');n<Date.parse(to+'T00:00Z');n+=86400000){const day=new Date(n).toISOString().slice(0,10),weekday=new Date(n).getUTCDay();for(const slot of auth.slots){if(!slot.weekdays.includes(weekday))continue;
  const start=`${day}T${slot.start}:00+08:00`,endDay=slot.end<=slot.start?new Date(n+86400000).toISOString().slice(0,10):day,end=`${endDay}T${slot.end}:00+08:00`,root=`${auth.stable_key}:${day}:${slot.key}`;
  const roster=await readLeaveRoster(t,{employmentId:auth.employment_id,startsAt:start,endsAt:end}),hasRoster=Number(roster.minutes)>0;
  const old=await one(t,'SELECT * FROM ty_leave_recurring_occurrence WHERE account_id=$1 AND root_key=$2 FOR UPDATE',[a.id,root]);seen.push(root);
  if(old?.request_id){const request=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1',[old.request_id]),changed=Date.parse(old.starts_at)!==Date.parse(start)||Date.parse(old.ends_at)!==Date.parse(end)||!hasRoster;if(request&&['pending','approved','taken'].includes(request.status)){if(changed)await t.query("UPDATE ty_leave_recurring_occurrence SET status='needs_replacement',last_seen_revision=$2 WHERE id=$1",[old.id,auth.revision]);result.push({id:old.id,account_id:a.id,root_key:root,status:changed?'needs_replacement':'requested',request_id:old.request_id,history_preserved:true});continue;}}
  if(!hasRoster){if(old)await t.query("UPDATE ty_leave_recurring_occurrence SET status='withdrawn',authorization_id=$2,source_revision=$3,last_seen_revision=$3 WHERE id=$1",[old.id,auth.id,auth.revision]);continue;}
  const row=old?await one(t,"UPDATE ty_leave_recurring_occurrence SET authorization_id=$2,source_revision=$3,last_seen_revision=$3,starts_at=$4,ends_at=$5,status='candidate',request_id=NULL WHERE id=$1 RETURNING *",[old.id,auth.id,auth.revision,start,end]):await one(t,"INSERT INTO ty_leave_recurring_occurrence(account_id,root_key,authorization_id,source_revision,work_date,slot_key,starts_at,ends_at,status,last_seen_revision)VALUES($1,$2,$3,$4,$5,$6,$7,$8,'candidate',$4)RETURNING *",[a.id,root,auth.id,auth.revision,day,slot.key,start,end]);result.push(row);
 }}
 const absent=await q(t,`SELECT * FROM ty_leave_recurring_occurrence WHERE account_id=$1 AND left(root_key,length($2))=$2 AND work_date>=$3::date AND work_date<$4::date AND NOT(root_key=ANY($5::text[])) FOR UPDATE`,[a.id,auth.stable_key+':',from,to,seen]);
 for(const old of absent){await t.query('UPDATE ty_leave_recurring_occurrence SET status=$2 WHERE id=$1',[old.id,old.request_id?'needs_replacement':'withdrawn']);}
 await emit(t,a,`recurring-build:${auth.id}:${from}:${to}:${digest(result.map(x=>[x.id,x.status]))}`,'leave.recurring.candidates_built',{authorization_id:auth.id,from,to,candidates:result.length,actual_taken_created:false},userId);return{occurrences:result,actual_taken_created:false};
}
export async function submitOccurrence(t,{userId,id}){
 const first=await one(t,'SELECT * FROM ty_leave_recurring_occurrence WHERE id=$1',[id]);if(!first)bad('发生候选不存在');const a=await context(t,userId,first.account_id,'advanced_leave_manage',{selfAllowed:true,action:'submit',fields:['quantity','starts_at','ends_at','evidence_ref']}),o=await one(t,'SELECT * FROM ty_leave_recurring_occurrence WHERE id=$1 FOR UPDATE',[id]);
 if(o.request_id){const request=await one(t,'SELECT * FROM ty_leave_request WHERE id=$1',[o.request_id]);if(request&&['pending','approved','taken'].includes(request.status)){await assertRequestRosterCurrent(t,request);return{occurrence:o,request,replayed:true,actual_taken_created:false};}}
 const auth=await one(t,"SELECT * FROM ty_leave_recurring_authorization WHERE id=$1 AND status='active'",[o.authorization_id]);if(!auth||Number(auth.revision)!==Number(o.source_revision)||iso(o.work_date)<iso(auth.valid_from)||iso(o.work_date)>=iso(auth.valid_to))conflict('周期授权已更新或该日不在资格期间，须重建候选');
 if(o.status!=='candidate')conflict('须先处理原申请变更，再确认新的发生候选');
 const s=await scheme(t,a,auth.scheme_id,iso(o.work_date));
 for(const f of s.rules.recurring.required_facts||[])if(a.qualifications[f]!==true)bad(`发生日资格${f}待核`);
 const untilFact=s.rules.recurring.qualification_valid_to_fact;if(untilFact&&(!a.qualifications[untilFact]||iso(o.work_date)>=date(a.qualifications[untilFact])))bad('发生日已超已核资格期间');
 const priorMinutes=(await one(t,`SELECT coalesce(sum((r.facts->>'minutes')::numeric),0)::text n FROM ty_leave_recurring_request_link x JOIN ty_leave_request r ON r.id=x.request_id JOIN ty_leave_recurring_occurrence o ON o.id=x.occurrence_id JOIN ty_leave_recurring_authorization z ON z.id=x.authorization_id WHERE o.account_id=$1 AND z.stable_key=$2 AND o.work_date=$3 AND r.status IN('pending','approved','taken')`,[a.id,auth.stable_key,o.work_date])).n;
 if(s.rules.recurring?.no_balance===true){
  if(a.unit!=='minute')bad('无余额周期给薪时段须以分钟保留原始计量');const roster=await readLeaveRoster(t,{employmentId:auth.employment_id,startsAt:new Date(o.starts_at).toISOString(),endsAt:new Date(o.ends_at).toISOString()});
  const minutes=String(roster.minutes);if(!gt(minutes,'0')||gt(minutes,String(s.rules.recurring.max_minutes_per_occurrence||60)))bad('发生时段已无适用排班或超授权量');if(gt(add(priorMinutes,minutes),String(s.rules.recurring.max_minutes_per_day||s.rules.recurring.max_minutes_per_occurrence||60)))bad('同一周期根该日已有预占或已休，不得换时窗键或修订再次领取每日额度');
  const key=`recurring:${o.root_key}`;let l=await one(t,'SELECT * FROM ty_leave_lot WHERE account_id=$1 AND stable_key=$2 FOR UPDATE',[a.id,key]),createdLot=false;if(!l){const p=await one(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1',[auth.proposal_id]);l=await newLot(t,a,p,s,key,Number(iso(o.work_date).slice(0,4)),iso(o.work_date),iso(o.work_date));createdLot=true;}
  // A cancelled occurrence may be re-requested under a changed roster. Keep
  // the same entitlement root and append only a positive cumulative difference;
  // a smaller current window never rewrites or claws back the historic grant.
  const granted=(await one(t,"SELECT coalesce(sum(delta),0)::text n FROM ty_leave_event WHERE lot_id=$1 AND event_kind='grant'",[l.id])).n,target=gt(minutes,granted)?minutes:granted,change=cumulativeGrant({total:target,numerator:'1',denominator:'1',alreadyGranted:granted,scale:4,rounding:'half_up'});
  if(gt(change.delta,'0')){const p=await one(t,"SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1 AND status='approved'",[auth.proposal_id]);if(!p)conflict('周期授予须保留当前已核授权来源');const eventKey=createdLot?`authorization:${auth.id}`:`authorization:${auth.id}:target:${change.target}:roster:${roster.snapshot.impact_hash||roster.snapshot.source_hash}`;await t.query("INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id,payload)VALUES($1,$2,'grant',$3,$4,$5,$6::jsonb)",[l.id,eventKey,change.delta,p.evidence_ref,userId,json({recurring_authorization_id:auth.id,occurrence_root:o.root_key,entitlement_only_not_actual_taken:true,roster_basis:roster.snapshot,cumulative_target:change.target,prior_granted:granted,grant_delta:change.delta})]);}
 }
 const sequence=Number(o.request_sequence)+1;
 const submitted=await core.submitRequest(t,{userId,self:a.self,input:{account_id:a.id,scheme_id:auth.scheme_id,employment_id:auth.employment_id,recurring_occurrence_id:o.id,request_key:`occurrence:${o.root_key}:n${sequence}`,starts_at:new Date(o.starts_at).toISOString(),ends_at:new Date(o.ends_at).toISOString(),evidence_ref:`approved-recurring-authorization:${auth.id}`}});
 const originalApproval=await one(t,"SELECT * FROM ty_leave_lifecycle_proposal WHERE id=$1 AND status='approved'",[auth.proposal_id]);
 const inherit=s.rules.recurring?.per_occurrence_approval!==true&&!await sameHuman(t,originalApproval.approved_by,userId)&&!await humanIsPerson(t,originalApproval.approved_by,a.group_id,a.person_id);
 await t.query('INSERT INTO ty_leave_recurring_request_link(request_id,occurrence_id,authorization_id,sequence,approval_mode,inherited_approved_by,original_requester_id,execution_actor_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[submitted.request.id,id,auth.id,sequence,inherit?'inherited_authorization':'requires_review',inherit?originalApproval.approved_by:null,originalApproval.created_by,userId]);
 let request=submitted.request;if(inherit){await t.query("UPDATE ty_leave_allocation SET state='allocated' WHERE request_id=$1 AND state='held'",[request.id]);request=await one(t,"UPDATE ty_leave_request SET status='approved',approved_by=$2 WHERE id=$1 RETURNING *",[request.id,originalApproval.approved_by]);await emit(t,a,`recurring:${id}:authorization:${auth.id}:n${sequence}`,'leave.recurring.approval_inherited',{request_id:request.id,authorization_id:auth.id,approval_proposal_id:originalApproval.id,original_approved_by:originalApproval.approved_by,execution_actor_id:userId,actual_taken_created:false},userId);}
 const occurrence=await one(t,"UPDATE ty_leave_recurring_occurrence SET status='requested',request_id=$2,request_sequence=$3 WHERE id=$1 RETURNING *",[id,request.id,sequence]);return{occurrence,request,approval_mode:inherit?'inherited_authorization':'requires_review',actual_taken_created:false};
}
export async function workspace(t,{userId,accountId}){
 const a=await context(t,userId,accountId,'advanced_leave_manage',{selfAllowed:true,read:true}),lots=await q(t,'SELECT * FROM ty_leave_lot WHERE account_id=$1 ORDER BY id',[a.id]),proposals=await q(t,'SELECT * FROM ty_leave_lifecycle_proposal WHERE account_id=$1 ORDER BY id DESC LIMIT 100',[a.id]);
 let financial=false;if(!a.self){try{await context(t,userId,accountId,'advanced_leave_payroll',{read:true});financial=true;}catch(e){if(!String(e.message).startsWith('E_TY_FORBIDDEN:'))throw e;}}
 const overtime=a.self?[]:await q(t,'SELECT * FROM ty_leave_overtime_source WHERE account_id=$1 ORDER BY id DESC',[a.id]);
 const result={account:a,lots:lots.map(l=>({...l,available:available(l)})),proposals:a.self?proposals.filter(p=>p.kind==='recurring'&&same(p.created_by,userId)):financial?proposals:proposals.filter(p=>!['overtime_basis','cash_qualification','annual_cash'].includes(p.kind)),authorizations:await q(t,'SELECT * FROM ty_leave_recurring_authorization WHERE account_id=$1 ORDER BY id DESC LIMIT 100',[a.id]),occurrences:await q(t,'SELECT * FROM ty_leave_recurring_occurrence WHERE account_id=$1 ORDER BY work_date DESC LIMIT 100',[a.id]),advances:await q(t,'SELECT * FROM ty_leave_advance WHERE account_id=$1 ORDER BY id DESC',[a.id]),cash_obligations:financial?await q(t,'SELECT * FROM ty_leave_lifecycle_cash_obligation WHERE account_id=$1 ORDER BY id DESC',[a.id]):[],overtime_sources:financial?overtime:overtime.map(({cash_unit_rate,pricing_ref,...r})=>r),capabilities:{can_view_financial:financial}};
 return projectServiceResult(t,{userId,result});
}

const PROJECTED=Symbol('leave-lifecycle-projected');
export async function projectServiceResult(t,{userId,result}){
 if(!result||typeof result!=='object'||result[PROJECTED]||!(await one(t,"SELECT to_regclass('public.ty_auth_grant')IS NOT NULL ok"))?.ok)return result;
 const out={},cache=new Map(),read=async(accountId,financial=false)=>{const key=`${accountId}:${financial}`;if(!cache.has(key)){try{cache.set(key,await context(t,userId,accountId,financial?'advanced_leave_payroll':'advanced_leave_manage',{read:true,selfAllowed:!financial}));}catch(e){if(!String(e.message).startsWith('E_TY_FORBIDDEN:'))throw e;cache.set(key,null);}}return cache.get(key);};
 const proposal=result.proposal||null,accountId=proposal?.account_id||result.account?.id||result.source?.account_id||result.advance?.account_id||result.qualification?.account_id||result.occurrence?.account_id||result.obligation?.account_id;
 const financial=proposal?FINANCIAL_KINDS.has(proposal.kind):!!(result.source||result.obligation||result.qualification),main=accountId?await read(accountId,financial):null;
 const project=async(row,finance=false,fallback=accountId)=>{const ctx=await read(row.account_id||fallback,finance);return ctx?core.projectAccountRow(t,{context:ctx,row}):{};};
 const safeProtocol=new Set(['replayed','blocked','domain_applied','bank_instruction_created','actual_taken_created','actual_overtime_minutes_created','payroll_deduction_created','private_debt_inferred','approval_mode','cash_released']);const flat={};for(const[k,v]of Object.entries(result))if(v===null||typeof v!=='object'){if(safeProtocol.has(k))out[k]=v;else flat[k]=v;}if(main)Object.assign(out,await core.projectAccountRow(t,{context:main,row:flat}));
 if(result.proposal){if(main)out.proposal=await core.projectAccountRow(t,{context:main,row:result.proposal});else{const ctx=await read(result.proposal.account_id);out.proposal=ctx?await core.projectAccountRow(t,{context:ctx,row:Object.fromEntries(Object.entries(result.proposal).filter(([k])=>!['payload','payload_hash','evidence_ref'].includes(k)))}):{};}}
 for(const[key,finance]of[['account',false],['advance',false],['authorization',false],['occurrence',false],['source',true],['qualification',true],['obligation',true]])if(result[key])out[key]=await project(result[key],finance,result[key].id===accountId?accountId:accountId);
 if(result.request){const projected=await core.projectServiceResult(t,{userId,result:{request:result.request}});out.request=projected.request;}
 for(const[key,finance]of[['lots',false],['proposals',null],['authorizations',false],['occurrences',false],['advances',false],['debts',false],['cash_obligations',true],['overtime_sources',true]])if(result[key]){out[key]=[];for(const row of result[key]){const needed=finance===null?FINANCIAL_KINDS.has(row.kind):finance;let value=await project(row,needed);if(!Object.keys(value).length&&key==='overtime_sources'){const ctx=await read(row.account_id||accountId);if(ctx)value=await core.projectAccountRow(t,{context:ctx,row:Object.fromEntries(Object.entries(row).filter(([k])=>!['cash_unit_rate','pricing_ref'].includes(k)))});}if(Object.keys(value).length)out[key].push(value);}}
 if(result.capabilities)out.capabilities=result.capabilities;
 if(result.approval_receipt&&main)out.approval_receipt=await core.projectAccountRow(t,{context:main,row:result.approval_receipt});
 return{...out,[PROJECTED]:true};
}
