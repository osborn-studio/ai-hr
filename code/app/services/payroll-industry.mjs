import{one,q,id,text,bad,deny,conflict,same,paging,revision,search,obj}from'./platform-core.mjs';
import{payrollInternals as H}from'./payroll-source.mjs';
import{sameHuman,humanIsPerson}from'./human-identity.mjs';
import{hkIndustryCasual}from'../payroll-industry-calculations.mjs';
import{amount,plus,minus,fraction}from'../payroll-calculations.mjs';
import{standardPack,STANDARD_PACKS}from'../payroll-standard-packs.mjs';
const json=v=>JSON.stringify(v);
const BASIS_FIELDS=['data','sources','amount','mode','groups','eligibility','document_hash','evidence_ref','source_locator','source_kind','actual_employer_key','subject_key','report_root_id','report_id','report_head_revision','report_source_hash'];
const RELATIONSHIP_FIELDS=['id','data','status','system','employment_id','person_id'];
const allowedKeys=(input,keys)=>{obj(input);if(Object.keys(input).some(k=>!keys.includes(k)))bad('行业供款请求包含不支持的字段');};
async function basisScope(t,e,period){
 const start=H.period((period instanceof Date?H.date(period):String(period)).slice(0,7));
 const departments=await q(t,"SELECT DISTINCT department_id FROM ty_position_assignment WHERE employment_id=$1 AND status<>'cancelled'AND valid_from<$3::date AND(valid_to IS NULL OR valid_to>$2::date)",[e.id,start,H.monthEnd(start)]);
 // A month spanning departments is an aggregate; a single-department grant
 // cannot authorize all of it by borrowing another grant's scope.
 return{...e,department_id:departments.length===1?departments[0].department_id:null};
}
async function can(t,userId,resource,action,scope,fields){try{await H.access(t,userId,resource,action,scope,fields);return true;}catch(e){if(/^E_TY_FORBIDDEN:/.test(e.message))return false;throw e;}}
async function relationshipRead(t,userId,scope,config){
 await H.access(t,userId,'payroll_slips_read_all','read',scope,RELATIONSHIP_FIELDS);
 if(config.kind!=='relationship'||!same(config.employment_id,scope.id)||!same(config.person_id,scope.person_id)||config.system!=='HK_PAYROLL')bad('须选择此人香港实际关系的已核供款主体');
}
async function basisContext(t,b){
 // Cancellation does not erase the historic basis. Keep its original scope
 // readable while excluding it from new approval or creation.
 const e=await one(t,'SELECT * FROM ty_employment WHERE id=$1',[b.employment_id]);if(!e)bad('行业依据的原雇佣不存在');return basisScope(t,e,b.period);
}
async function canApprove(t,userId,b,scope,current){return scope.status!=='cancelled'&&b.status==='draft'&&current&&!(await sameHuman(t,b.created_by,userId))&&!(await humanIsPerson(t,userId,b.group_id,b.person_id))&&await can(t,userId,'payroll_sources','read',scope,BASIS_FIELDS)&&await can(t,userId,'payroll_slips_read_all','read',scope,RELATIONSHIP_FIELDS)&&await can(t,userId,'payroll_confirm','approve',scope,BASIS_FIELDS);}
export function validateIndustryPolicy(data,from){const pack=standardPack(data.standard_pack_id,from);if(pack.type!=='HK_MPF_INDUSTRY'||data.scheme_type!=='industry'||data.employee_code!=='HK_EMP_MPF_MANDATORY'||data.employer_code!=='HK_ER_MPF_MANDATORY'||data.contribution_holiday!==false||H.hash(data.bands)!==H.hash(pack.parameters.bands))bad('行业临时MPF须使用适用日已核官方日额表及独立两侧组件，不能套月薪百分比或供款假期');return pack;}
export function industryCalculation(c){const p=c.policy.data,b=c.industry_basis,v=c.period_parameters;const result=hkIndustryCasual({mode:b.mode,groups:b.groups.map(g=>({...g,facts:g.facts.map(f=>({...f,employeeEligible:f.employeeEligible&&v.employee_eligible,employerEligible:f.employerEligible&&v.employer_eligible}))})),bands:p.bands,eligibility:b.eligibility,alreadyEmployeeTarget:c.opening.data.employee_target,alreadyEmployerTarget:c.opening.data.employer_target});for(const side of['employee','employer'])if(result[side].target!==null){const exact=plus(result[side].target,amount(v[side+'_arrears']));result[side].target=amount(exact);result[side].exact=fraction(exact);result[side].delta=amount(minus(exact,c.opening.data[side+'_target']));result[side].arrears=amount(v[side+'_arrears']);}return result;}
export async function createIndustryBasis(t,{userId,input,operationId}){
 allowedKeys(input,['employment_id','relationship_config_id','period','mode','groups','eligibility','source_kind','document_hash','source_locator','evidence_ref','report_id','report_root_id']);
 const employment=await H.employment(t,input.employment_id),period=H.period(input.period),e=await basisScope(t,employment,period);
 await H.access(t,userId,'payroll_sources','write',e,BASIS_FIELDS);
 await H.access(t,userId,'payroll_slips_read_all','read',e,RELATIONSHIP_FIELDS);
 const rc=await H.approved(t,await H.config(t,input.relationship_config_id));await relationshipRead(t,userId,e,rc);
 const mode=input.mode,groups=structuredClone(input.groups),eligibility=structuredClone(input.eligibility);const pack=standardPack('HK_MPF_INDUSTRY_20260430',period);hkIndustryCasual({mode,groups,bands:pack.parameters.bands,eligibility,alreadyEmployeeTarget:'0',alreadyEmployerTarget:'0'});
 const kind=input.source_kind;if(!['native_time_and_reviewed_allocation','external_reviewed_workdays_and_allocation'].includes(kind))bad('须区分原生考勤工作日与有据外部基线，不能自标native_verified');let root=null,report=null;
 if(kind==='native_time_and_reviewed_allocation'){root=await one(t,"SELECT * FROM ty_time_report_root WHERE employment_id=$1 AND group_id=$2 AND period=$3 AND perspective='employer'AND owner_company_id=$4",[e.id,e.group_id,period,e.company_id]);if(!root?.current_report_id)bad('本月尚无当前已核雇主考勤头');report=await one(t,'SELECT * FROM ty_time_report_version WHERE id=$1',[root.current_report_id]);if(report.grain!=='daily')bad('行业实际工作日不能由月汇总值猜测，须日报或有据外部工作日核定');}
 else if(input.report_id||input.report_root_id)bad('外部核定不能标注原生已验证报告');
 const document=text(input.document_hash,'原工资期与工作日原件摘要',16),locator=text(input.source_locator,'原件定位',4),evidence=text(input.evidence_ref,'行业资格、日薪方式及原工资期核定依据',4);
 return H.cmd(t,{userId,operationId,operation:'industry.basis.create',input,execute:async()=>{await t.query('SELECT id FROM ty_person WHERE id=$1 FOR UPDATE',[e.person_id]);const rev=Number((await one(t,'SELECT coalesce(max(revision),0)+1 n FROM ty_pay_industry_basis WHERE group_id=$1 AND person_id=$2 AND actual_employer_key=$3 AND subject_key=$4 AND period=$5',[e.group_id,e.person_id,rc.data.actual_employer_key,rc.data.contribution_subject_key,period])).n),r=await one(t,'INSERT INTO ty_pay_industry_basis(group_id,company_id,person_id,employment_id,actual_employer_key,subject_key,period,revision,source_kind,report_root_id,report_id,report_head_revision,report_source_hash,mode,groups,eligibility,document_hash,evidence_ref,source_locator,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20)RETURNING id',[e.group_id,e.company_id,e.person_id,e.id,rc.data.actual_employer_key,rc.data.contribution_subject_key,period,rev,kind,root?.id||null,report?.id||null,root?.head_revision||null,report?.source_hash||null,mode,json(groups),json(eligibility),document,evidence,locator,userId]);return{id:r.id};},receipt:async v=>({basis:await H.project(t,userId,'payroll_sources',e,await one(t,'SELECT * FROM ty_pay_industry_basis WHERE id=$1',[v.id])),creates_payment:false})});
}
export async function approveIndustryBasis(t,{userId,input,operationId}){
 allowedKeys(input,['id','expected_revision']);
 const b=await one(t,'SELECT * FROM ty_pay_industry_basis WHERE id=$1',[id(input.id)]);if(!b)bad('行业工资期依据不存在');const scope=await basisContext(t,b);
 await H.access(t,userId,'payroll_sources','read',scope,BASIS_FIELDS);
 await H.access(t,userId,'payroll_slips_read_all','read',scope,RELATIONSHIP_FIELDS);
 await H.access(t,userId,'payroll_confirm','approve',scope,BASIS_FIELDS);
 if(scope.status==='cancelled')conflict('原雇佣已撤销，历史依据保留但不能继续核准');
 return H.cmd(t,{userId,operationId,operation:'industry.basis.approve',input,execute:async()=>{const r=await one(t,'SELECT * FROM ty_pay_industry_basis WHERE id=$1 FOR UPDATE',[b.id]);revision(r,input.expected_revision);if(r.status!=='draft')conflict('行业依据已处理');if(await sameHuman(t,r.created_by,userId)||await humanIsPerson(t,userId,r.group_id,r.person_id))deny('行业工作日、资格及分配须独立非受益人员核准');await t.query("UPDATE ty_pay_industry_basis SET status='approved',approved_by=$2,approved_at=clock_timestamp()WHERE id=$1",[r.id,userId]);await one(t,'SELECT fn_ty_pay_industry_basis_valid($1)',[r.id]);return{id:r.id};},receipt:async v=>({basis:await H.project(t,userId,'payroll_sources',scope,await one(t,'SELECT * FROM ty_pay_industry_basis WHERE id=$1',[v.id]))})});
}
export async function industryWorkspace(t,{userId,input}){
 allowedKeys(input,['group_id','company_id','person_id','employment_id','id','period','page','page_size','q']);
 const group=id(input.group_id),company=id(input.company_id,true),period=input.period?H.period(input.period):null,out=[];
 for(const r of await q(t,'SELECT b.*,p.full_name,p.person_number,c.name company_name FROM ty_pay_industry_basis b JOIN ty_person p ON p.id=b.person_id JOIN ty_company c ON c.id=b.company_id WHERE b.group_id=$1 ORDER BY b.id DESC',[group])){
  if(input.id&&!same(r.id,id(input.id))||company&&!same(r.company_id,company)||input.person_id&&!same(r.person_id,id(input.person_id))||input.employment_id&&!same(r.employment_id,id(input.employment_id))||period&&H.date(r.period)!==period)continue;
  const scope=await basisContext(t,r);
  const current=!await one(t,"SELECT 1 FROM ty_pay_industry_basis WHERE group_id=$1 AND person_id=$2 AND actual_employer_key=$3 AND subject_key=$4 AND period=$5 AND status='approved'AND revision>$6",[r.group_id,r.person_id,r.actual_employer_key,r.subject_key,r.period,r.revision]);
  const v=await H.project(t,userId,'payroll_sources',scope,{...r,current});if(!v?.id)continue;
  out.push({...v,allowed_actions:{approve:await canApprove(t,userId,r,scope,current)}});
 }
 const scope={group_id:group,...(company?{company_id:company}:{})};
 let canCreate=await can(t,userId,'payroll_sources','write',scope,BASIS_FIELDS)&&await can(t,userId,'payroll_slips_read_all','read',scope,RELATIONSHIP_FIELDS);
 if(!canCreate)for(const e of await q(t,"SELECT * FROM ty_employment WHERE group_id=$1 AND status<>'cancelled'AND($2::bigint IS NULL OR company_id=$2)",[group,company])){
  const target=await basisScope(t,e,period||new Date());
  if(await can(t,userId,'payroll_sources','write',target,BASIS_FIELDS)&&await can(t,userId,'payroll_slips_read_all','read',target,RELATIONSHIP_FIELDS)){canCreate=true;break;}
 }
 return{...paging(search(out,input.q,['full_name','person_number','company_name','source_kind','evidence_ref','source_locator']),input),capabilities:{can_create_basis:canCreate}};
}
export async function industryStandards(t,{userId,input}){
 allowedKeys(input,['group_id','company_id','on']);const scope={group_id:id(input.group_id),...(input.company_id?{company_id:id(input.company_id)}:{})},on=H.date(input.on);
 if(scope.company_id){const c=await H.company(t,scope.company_id);if(!same(c.group_id,scope.group_id))deny();}
 await H.access(t,userId,'payroll_config','read',scope,['data']);
 return{packs:Object.values(STANDARD_PACKS).filter(p=>p.type==='HK_MPF_INDUSTRY'&&p.valid_from<=on&&(!p.valid_to||on<p.valid_to)).map(p=>standardPack(p.id,on))};
}
