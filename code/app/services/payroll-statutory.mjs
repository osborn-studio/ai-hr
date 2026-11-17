// Verified statutory payroll parameters. No credentials, rates or tax eligibility defaults.
import {one,q,id,text,bad,deny,conflict,paging,search,revision} from './platform-core.mjs';
import {sameHuman,humanIsPerson} from './human-identity.mjs';
import {payrollInternals as H} from './payroll-source.mjs';
import {amount,plus,minus,compare,fraction} from '../payroll-calculations.mjs';
import {exactDecimal} from '../leave-calculations.mjs';
import {cnCumulativeIIT,cnSocialContribution,hkMpfRegular} from '../payroll-statutory-calculations.mjs';
const num=v=>{H.numeric(v);if(compare(v,'0')<0)bad('薪税参数不能为负');return v;};
const bool=(v,k)=>{if(typeof v!=='boolean')bad(k+'必须是已核true/false');return v;};
const active=(v,on)=>v?.status==='approved'&&H.date(v.valid_from)<=on&&(!v.valid_to||H.date(v.valid_to)>on);
const catalogPairs={pension:['CN_EMP_PENSION','CN_ER_PENSION'],medical:['CN_EMP_MEDICAL','CN_ER_MEDICAL'],unemployment:['CN_EMP_UNEMPLOYMENT','CN_ER_UNEMPLOYMENT'],work_injury:[null,'CN_ER_WORK_INJURY'],maternity:[null,'CN_ER_MATERNITY'],housing:['CN_EMP_HOUSING_FUND','CN_ER_HOUSING_FUND']};
const scopeOf=r=>({group_id:r.group_id,company_id:r.company_id,person_id:r.person_id,employment_id:r.employment_id});
const res=r=>r.person_id?'payroll_sources':'payroll_config';
async function get(t,key){const r=await one(t,'SELECT * FROM ty_pay_stat_config WHERE id=$1',[id(key)]);if(!r)bad('薪税核定配置不存在');return r;}
async function validate(t,input){const d=input.data;if(!d||typeof d!=='object'||Array.isArray(d))bad('薪税配置须为结构化对象');
 if(input.kind==='policy'){
  if(!['CN_IIT','CN_SOCIAL','HK_MPF_REGULAR'].includes(d.type))bad('尚未实现此法定模板，不能泛用普通月度规则');
  if(d.type==='CN_IIT'){
   if(input.system!=='CN_PAYROLL')bad('内地税表体系错误');
   cnCumulativeIIT({incomeBefore:'0',deductibleBefore:'0',specialBefore:'0',otherBefore:'0',basicBefore:'0',taxWithheldBefore:'0',currentIncomeDelta:'0',currentDeductibleDelta:'0',currentSpecialDelta:'0',currentOtherDelta:'0',basicForPeriod:'0',basicAlreadyRecognized:'0',brackets:d.brackets});
   if(!Array.isArray(d.deductible_codes))bad('须明确已核个人社保公积金扣除项目集合');
   for(const code of d.deductible_codes)if(!Object.values(catalogPairs).flat().filter(Boolean).filter(c=>c.startsWith('CN_EMP_')).includes(code))bad('个人税前扣除不能混入雇主成本或未知项目');
  }else{
   for(const k of ['lower','upper','employee_rate','employer_rate'])num(d[k]);
   if(d.type==='CN_SOCIAL'){
    if(input.system!=='CN_PAYROLL'||!Object.values(catalogPairs).some(([a,b])=>a===d.employee_code&&b===d.employer_code))bad('社保公积金须使用已知个人/雇主原子配对，不混岗位工资');
    cnSocialContribution({declaredBase:'0',lower:d.lower,upper:d.upper,employeeRate:d.employee_rate,employerRate:d.employer_rate,employeeApplicable:true,employerApplicable:true,employeeArrears:'0',employerArrears:'0',alreadyEmployeeTarget:'0',alreadyEmployerTarget:'0'});
   }else{
    if(input.system!=='HK_PAYROLL'||d.scheme_type!=='regular'||d.period_type!=='monthly'||d.employee_code!=='HK_EMP_MPF_MANDATORY'||d.employer_code!=='HK_ER_MPF_MANDATORY')bad('普通月度MPF政策不能套用行业临时/日供款；须另配适用模板');
    num(d.employee_cap);num(d.employer_cap);hkMpfRegular({schemeType:'regular',periodType:'monthly',relevantIncomeCumulative:'0',lower:d.lower,upper:d.upper,employeeRate:d.employee_rate,employerRate:d.employer_rate,employeeCap:d.employee_cap,employerCap:d.employer_cap,employeeEligible:true,employerEligible:true,employeeArrears:'0',employerArrears:'0',alreadyEmployeeTarget:'0',alreadyEmployerTarget:'0'});
   }
  }
  if(!d.scope_by_item||typeof d.scope_by_item!=='object'||Array.isArray(d.scope_by_item))bad('须逐薪项核定计入或排除，不能默认全部现金都计税/MPF');
  for(const[code,state]of Object.entries(d.scope_by_item)){const item=await one(t,'SELECT * FROM ty_pay_item_catalog WHERE code=$1',[code]);if(!['include','exclude'].includes(state)||!item)bad('薪税范围须为目录中项目的include/exclude');if(state==='include'&&(!['cash_earnings','reimbursement','noncash_shadow'].includes(item.category)&&item.metadata.employee_cash_wage_effect!=='decrease_gross'||d.type==='HK_MPF_REGULAR'&&item.category==='noncash_shadow'))bad('此薪税模板不能把个人代扣、雇主成本、统计基数或资金采购项目计入收入；非现金待遇须使用已适配的专门口径');}
 }else if(input.kind==='opening'){
  d.cutoff_period=H.period(d.cutoff_period);text(d.subject_key,'期初实际税供款主体',4);text(d.document_hash,'期初凭据摘要',16);text(d.source_locator,'期初凭据定位',4);
  for(const k of ['income','deductible','basic','special','other','tax_recognized','employee_target','employer_target'])num(d[k]);
  if(d.source_kind!=='external_reviewed_opening')bad('期初须独立核定外部基线，不能自标native_verified');
 }else if(input.kind==='enrollment'){
  const p=await get(t,d.policy_id),o=await get(t,d.opening_id);if(p.kind!=='policy'||p.status!=='approved'||o.kind!=='opening'||o.status!=='approved'||p.group_id!=input.group_id||o.group_id!=input.group_id||o.person_id!=input.person_id||p.system!==input.system||o.system!==input.system)bad('政策/期初必须已核且属于同人、集团及体系');
  text(d.actual_employer_key,'实际法律雇主',4);text(d.subject_key,'税供款主体',4);text(d.plan_key,'参保或纳税身份计划',4);if(o.data.subject_key!==d.subject_key)bad('期初主体与参保/纳税身份不一致');
  if(!d.periods||typeof d.periods!=='object'||!Object.keys(d.periods).length)bad('人员逐期资格、申报基数、费用扣除参数不能缺失');
  if(p.data.type==='CN_IIT')d.cumulative_start_period=H.period(d.cumulative_start_period);
  for(const[period,v]of Object.entries(d.periods)){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))bad('逐期人员参数键必须YYYY-MM');H.period(period);if(p.data.type==='CN_IIT')for(const k of ['basic','special','other'])num(v[k]);else{for(const side of ['employee','employer']){bool(v[side+'_eligible'],side+'资格');num(v[side+'_arrears']);}if(p.data.type==='CN_SOCIAL')num(v.declared_base);}}
 }else if(input.kind==='batch_period'){
  const b=await one(t,'SELECT * FROM ty_pay_batch WHERE id=$1',[id(d.batch_id)]);if(!b||b.group_id!=input.group_id||b.company_id!=input.company_id||b.system!==input.system)bad('薪税期间不属于此工资批次');
  if(b.status==='confirmed')bad('封存工资的支付/税供款期间不能改写，须另行核定更正');
  d.tax_period=H.period(d.tax_period);d.contribution_period=H.period(d.contribution_period);d.expected_payment_date=H.date(d.expected_payment_date);if(d.expected_payment_date.slice(0,7)!==d.tax_period.slice(0,7))bad('预计支付月与预计扣税月不一致，不能默认以工资归属月替代');
 }else bad('薪税配置类型错误');
}
export async function saveStatutoryConfiguration(t,{userId,input,operationId}){
 const c=await H.company(t,input.company_id),person=input.person_id?id(input.person_id):null,e=input.employment_id?await H.employment(t,input.employment_id):null;
 if(person&&!await one(t,'SELECT 1 FROM ty_person WHERE id=$1 AND group_id=$2',[person,c.group_id])||e&&(e.person_id!=person||e.company_id!=c.id))bad('薪税永久人员/雇佣作用域错误');
 if(['enrollment','opening'].includes(input.kind)!==!!person)bad('人员资格与期初须绑定永久人员，政策/批次不冒充个人资料');
 const scope={...c,person_id:person,employment_id:e?.id};await H.access(t,userId,res(scope),'write',scope,['data','evidence_ref']);
 const data=structuredClone(input.data),from=H.date(input.valid_from),to=input.valid_to?H.date(input.valid_to):null;if(to&&to<=from)bad('有效期间须半开有序');
 const body={...input,group_id:c.group_id,person_id:person,data};await validate(t,body);const stable=text(input.stable_key,'薪税版本根',4,180);
 return H.cmd(t,{userId,operationId,operation:'statutory.config.save',input,execute:async()=>{await t.query('SELECT id FROM ty_group WHERE id=$1 FOR UPDATE',[c.group_id]);const prior=await one(t,'SELECT * FROM ty_pay_stat_config WHERE group_id=$1 AND kind=$2 AND stable_key=$3 ORDER BY revision DESC LIMIT 1',[c.group_id,input.kind,stable]);if(prior&&[String(prior.company_id)===String(c.id),String(prior.person_id)===String(person),String(prior.employment_id)===String(e?.id||null),prior.system===input.system].some(ok=>!ok))bad('同一薪税版本根不能换人、换公司、换雇佣或换体系；合法接续须新根并显式核对');const rev=Number((await one(t,'SELECT coalesce(max(revision),0)+1 n FROM ty_pay_stat_config WHERE group_id=$1 AND kind=$2 AND stable_key=$3',[c.group_id,input.kind,stable])).n);const row=await one(t,'INSERT INTO ty_pay_stat_config(group_id,company_id,person_id,employment_id,kind,stable_key,revision,system,valid_from,valid_to,data,evidence_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)RETURNING id',[c.group_id,c.id,person,e?.id||null,input.kind,stable,rev,input.system,from,to,JSON.stringify(data),text(input.evidence_ref,'薪税政策/资格/期初依据',4),userId]);return{config_id:row.id};},receipt:async v=>({config:await H.project(t,userId,res(scope),scope,await get(t,v.config_id))})});
}
export async function approveStatutoryConfiguration(t,{userId,input,operationId}){
 const c=await get(t,input.id);await H.access(t,userId,c.person_id?'payroll_confirm':'payroll_config','approve',c,['data','status']);
 return H.cmd(t,{userId,operationId,operation:'statutory.config.approve',input,execute:async()=>{const r=await one(t,'SELECT * FROM ty_pay_stat_config WHERE id=$1 FOR UPDATE',[c.id]);if(await sameHuman(t,r.created_by,userId)||await humanIsPerson(t,userId,r.group_id,r.person_id))deny('薪税基线/资格不能由同一人员或受益人核准');if(r.status!=='draft')conflict('薪税版本已处理');revision(r,input.expected_revision);await validate(t,r);await t.query("UPDATE ty_pay_stat_config SET status='approved',approved_by=$2,approved_at=clock_timestamp()WHERE id=$1",[r.id,userId]);return{config_id:r.id};},receipt:async v=>({config:await H.project(t,userId,res(c),c,await get(t,v.config_id))})});
}
export async function statutoryWorkspace(t,{userId,input}){const rows=await q(t,'SELECT * FROM ty_pay_stat_config WHERE group_id=$1 ORDER BY id DESC',[id(input.group_id)]),out=[];for(const r of rows){if(input.kind&&input.kind!==r.kind||input.person_id&&input.person_id!=r.person_id||input.company_id&&input.company_id!=r.company_id)continue;const v=await H.project(t,userId,res(r),r,r);if(v)out.push(v);}return paging(search(out,input.q,['stable_key','kind','system']),input);}
function independent(c,component){const p=c.policy.data,o=c.opening.data,v=c.period_parameters,typ=c.type;
 if(typ==='CN_IIT'){const x=cnCumulativeIIT({incomeBefore:o.income,deductibleBefore:o.deductible,specialBefore:o.special,otherBefore:o.other,basicBefore:o.basic,taxWithheldBefore:o.tax_recognized,currentIncomeDelta:c.native_income,currentDeductibleDelta:c.native_deductible,currentSpecialDelta:c.native_special,currentOtherDelta:c.native_other,basicForPeriod:c.native_basic,basicAlreadyRecognized:'0',brackets:p.brackets});return{target:x.taxTarget,initial:o.tax_recognized,result:x};}
 const args={lower:p.lower,upper:p.upper,employeeRate:p.employee_rate,employerRate:p.employer_rate,employeeArrears:v.employee_arrears,employerArrears:v.employer_arrears,alreadyEmployeeTarget:o.employee_target,alreadyEmployerTarget:o.employer_target};
 const x=typ==='CN_SOCIAL'?cnSocialContribution({...args,declaredBase:v.declared_base,employeeApplicable:v.employee_eligible,employerApplicable:v.employer_eligible}):hkMpfRegular({...args,schemeType:p.scheme_type,periodType:p.period_type,relevantIncomeCumulative:exactDecimal(fraction(plus(o.income,c.native_income)),12),employeeCap:p.employee_cap,employerCap:p.employer_cap,employeeEligible:v.employee_eligible,employerEligible:v.employer_eligible});
 const side=component===p.employee_code?'employee':'employer';return{target:x[side].target,initial:o[side+'_target'],state:x[side].state,result:x};
}
export async function buildStatutoryLines(t,{userId,batch:b,lines,selections}){
 if(!Array.isArray(selections.enrollment_ids)||!selections.enrollment_ids.length||selections.enrollment_ids.length>10000)bad('原生法定核算须选择真实已核人员资格，不猜税率或参保基数');
 const result=[],dependencies=[],seen=new Set(),enrollments=[];
 for(const key of selections.enrollment_ids){const n=await get(t,key),p=await get(t,n.data.policy_id);enrollments.push({n,p});}
 enrollments.sort((a,z)=>Number(a.p.data.type==='CN_IIT')-Number(z.p.data.type==='CN_IIT'));
 for(const{n,p}of enrollments){const eids=[...new Set(lines.filter(l=>l.scope.person_id==n.person_id&&l.scope.employment_id).map(l=>l.scope.employment_id))];if(!eids.length)bad('法定资格未对应本批实际工资受益人');const e=await H.employment(t,eids[0]);await H.sourceScope(t,userId,b,e);for(const c of[n,p,await get(t,n.data.opening_id)])await H.access(t,userId,res(c),'read',c,['data','sources','amount']);
  const raw=await one(t,'SELECT fn_ty_pay_stat_context($1,$2,$3,$4::jsonb)c',[b.id,e.id,n.id,JSON.stringify(p.data.type==='CN_IIT'?[...lines,...result.filter(l=>l.code!=='CN_IIT_WITHHOLD')]:lines)]),c=raw.c;
  for(const w of await q(t,"SELECT DISTINCT r.group_id,r.company_id,r.person_id FROM ty_pay_row r JOIN ty_pay_batch b ON b.id=r.batch_id WHERE r.group_id=$1 AND r.person_id=$2 AND b.status='confirmed'AND(CASE WHEN $3='CN_IIT'THEN b.tax_subject_key ELSE b.contribution_subject_key END)=$4",[b.group_id,e.person_id,c.type,c.subject_key]))await H.access(t,userId,'payroll_sources','read',w,['sources','amount']);
  for(const component of c.type==='CN_IIT'?['CN_IIT_WITHHOLD']:[p.data.employee_code,p.data.employer_code].filter(Boolean)){
   const key=`stat:${b.group_id}:${e.person_id}:${c.subject_key}:${c.legal_employer_key}:${component}:${c.type==='CN_IIT'?c.period.slice(0,4)+'-01-01':c.period}`;if(seen.has(key))bad('同一参保或纳税身份重复选择，不能各门店重复应用上限');seen.add(key);
   const pure=independent(c,component),sql=(await one(t,'SELECT fn_ty_pay_stat_math($1::jsonb,$2)m',[JSON.stringify(c),component])).m;
   if(pure.target===null){if(sql.state!=='not_applicable')bad('资格不适用口径冲突');continue;}
   if(compare(pure.target,sql.target)!==0)bad('法定数学双重核验不一致，禁止入薪');
   await t.query('INSERT INTO ty_pay_stat_root(group_id,person_id,subject_key,legal_employer_key,plan_key,component,period,global_key,opening_id,current_target)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)ON CONFLICT(global_key)DO NOTHING',[b.group_id,e.person_id,c.subject_key,c.legal_employer_key,c.plan_key,component,c.type==='CN_IIT'?c.period.slice(0,4)+'-01-01':c.period,key,c.opening.id,pure.initial]);
   const root=await one(t,'SELECT * FROM ty_pay_stat_root WHERE global_key=$1 FOR UPDATE',[key]);if(root.plan_key!==c.plan_key||root.opening_id!=c.opening.id||root.latest_period&&H.date(root.latest_period)>c.period)bad('累计期初已采用或后续期间已核，不能换期初/倒回月份重置');
   const global=c.type==='CN_IIT'&&compare(pure.target,root.current_target)<0?root.current_target:pure.target,localKey=key+':segment:'+e.id,prior=(await one(t,"SELECT coalesce(sum(a.delta),0)::text n FROM ty_pay_adoption a JOIN ty_pay_obligation o ON o.id=a.obligation_id WHERE o.group_id=$1 AND o.economic_key=$2 AND a.state='confirmed'",[b.group_id,localKey])).n,target=amount(plus(prior,minus(global,root.current_target)));
   if(compare(target,'0')<0)bad('跨公司已结法定额下降涉及原承担关系，须先核定反向调整，不直接造负累计或银行退款');
   const snapshot={selector:{domain:'statutory_calculation',enrollment_id:n.id},stat_root_id:root.id,root_revision:root.head_revision,enrollment_id:n.id,policy_id:p.id,opening_id:c.opening.id,batch_period_id:c.batch_period.id,stat_period:c.period,global_target:amount(global),context_hash:H.hash(c),context_fingerprint:(await one(t,'SELECT md5($1::jsonb::text)h',[JSON.stringify(c)])).h,overpaid_credit:c.type==='CN_IIT'?amount(compare(root.current_target,pure.target)>0?minus(root.current_target,pure.target):'0'):'0.00',recognition_state:'payroll_confirmed_projection_not_remitted',calculation_basis:'full_cumulative_target_not_new_cash',full_target_calculation:pure.result};
   const line=await H.makeLine(t,b,{economic_key:localKey,source_domain:'statutory_calculation',source_id:root.id,source_revision:H.hash({context:c,root_revision:root.head_revision}),source_hash:H.hash(snapshot),scope:{...e,employment_id:e.id},code:component,target,snapshot,wage_tags:{cash_component_nature:'statutory_component',hk_adw:'not_applicable',cn_average:'not_applicable',ordinary_wage:'not_applicable'},cost_atom:component===p.data.employer_code?localKey:null,inclusion_key:key,cost_membership:component===p.data.employer_code?'independent':'excluded'});line.relationship_config_id=(await H.actualConfig(t,e,b)).id;result.push(line);
   dependencies.push({domain:'native_statutory',root_id:root.id,head_revision:root.head_revision,context_hash:snapshot.context_hash});
  }
 }
 return{lines:result,dependencies};
}
