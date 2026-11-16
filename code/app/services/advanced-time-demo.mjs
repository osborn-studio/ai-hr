// Opt-in synthetic October fixture. No customer files are read.
import {bizErr} from '../errors.mjs';
import {accessFor} from './foundation.mjs';
import * as payroll from './customer-payroll.mjs';
import * as performance from './customer-performance.mjs';
import {monthly} from './advanced-time.mjs';
import {calculate,money,parseFormula} from './customer-payroll-engine.mjs';
const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
const same=(a,b)=>String(a)===String(b);
const VERSION='TY-TIME-202610-v1';
const iso=(n)=>`2026-10-${String(n).padStart(2,'0')}`;
const stamp=(date,h,m=0)=>new Date(Date.parse(date+'T00:00:00Z')+h*3600000+m*60000).toISOString().replace('T',' ').slice(0,19);
const addMin=(s,n)=>new Date(Date.parse(s.replace(' ','T')+'Z')+n*60000).toISOString().replace('T',' ').slice(0,19);
const shiftDefs=[['LUNCH','午市班','#1677FF','10:00–14:00'],['DINNER','晚市班','#7555D9','17:00–21:00'],['EARLY','早班','#14967D','09:00–13:00 / 14:00–18:00'],['LATE','晚班','#D98B16','13:00–17:00 / 18:00–22:00'],['NIGHT','跨夜班','#304698','18:00–22:00 / 22:30–次日02:30'],['OT','加班班段','#D83E69','经核定的额外班段'],['SWAP','调班','#007EAA','保留调前调后班段轨迹']];
export async function seedOctober(t,{userId,input}){
 if(input?.confirm_synthetic!==true)throw bizErr('E_TY_ARGUMENT','必须明确confirm_synthetic，仅建立虚构记录');
 const a=await accessFor(t,userId);if(!a.platformAdmin)throw bizErr('E_TY_FORBIDDEN','演示月初始化须由全权限演示或技术初始化账号执行');
 const group=(await q(t,"SELECT * FROM ty_group WHERE code='TY-TEST' FOR UPDATE"))[0];if(!group)throw bizErr('E_TY_ARGUMENT','请先建立天意虚构工作区');
 const old=(await q(t,"SELECT * FROM ty_roster_period WHERE group_id=$1 AND period='2026-10-01'",[group.id]))[0];if(old){if(old.synthetic_version!==VERSION)throw bizErr('E_TY_CONFLICT','10月已有其他来源考勤，不覆盖');return receipt(t,old);}
 const period=(await q(t,"INSERT INTO ty_roster_period(group_id,period,label,synthetic_version,created_by)VALUES($1,'2026-10-01','2026年10月全虚构演示月',$2,$3)RETURNING *",[group.id,VERSION,userId]))[0];
 for(const [code,name,color,description] of shiftDefs)await t.query('INSERT INTO ty_shift_definition(group_id,code,name,color,description,updated_by)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(group_id,code)DO NOTHING',[group.id,code,name,color,description,userId]);
 const people=await q(t,`SELECT DISTINCT ON(p.id) p.*,e.id employment_id,e.company_id home_company_id,e.employment_type,c.brand_id,c.name company_name,l.region_code,l.currency_code,a.department_id,a.work_area_id,a.grade_id,j.code job_code FROM ty_person p JOIN ty_employment e ON e.person_id=p.id JOIN ty_company c ON c.id=e.company_id CROSS JOIN LATERAL fn_ty_company_locale(c.id) l JOIN ty_position_assignment a ON a.employment_id=e.id AND a.is_primary JOIN ty_company_position pos ON pos.id=a.position_id JOIN ty_job j ON j.id=pos.job_id WHERE p.group_id=$1 AND e.hire_date<='2026-10-01' AND(e.leave_date IS NULL OR e.leave_date>='2026-10-31') AND e.status<>'cancelled' AND a.status<>'cancelled' AND a.valid_from<='2026-10-01' AND(a.valid_to IS NULL OR a.valid_to>'2026-10-31') ORDER BY p.id,e.hire_date DESC,a.valid_from DESC`,[group.id]);
 if(people.length!==62)throw bizErr('E_TY_CONFLICT','完整10月演示须有62名虚构在职人员，不推断缺失人员');
 const stores=await q(t,"SELECT * FROM ty_company WHERE group_id=$1 AND company_kind='store' ORDER BY id",[group.id]);
 const departments=await q(t,'SELECT d.* FROM ty_department d JOIN ty_company c ON c.id=d.company_id WHERE c.group_id=$1 ORDER BY d.id',[group.id]);
 const areas=await q(t,'SELECT w.* FROM ty_work_area w JOIN ty_company c ON c.id=w.company_id WHERE c.group_id=$1 ORDER BY w.id',[group.id]);
 const changes=[];
 for(let i=0;i<people.length;i++){
  const p=people[i],ordinal=i+1,working=[];
  for(let n=1;n<=31;n++){
   const wd=new Date(iso(n)+'T00:00:00Z').getUTCDay();
   const rest=p.region_code==='HK'?wd===0:((n+ordinal)%7>=5);
   if(!rest)working.push(n);
  }
  const scenario=new Map(working.slice(1,12).map((n,j)=>[n,j]));
  for(let n=1;n<=31;n++){
   const date=iso(n),event=scenario.get(n),wd=new Date(date+'T00:00:00Z').getUTCDay();
   const rest=p.region_code==='HK'?wd===0:((n+ordinal)%7>=5);
   let kind=rest?'rest':'work',note='';
   if(p.region_code==='CN'&&n<=7)note=n<=3?'国庆法定节日标签；本演示在岗，节日工资另列试算参数':'国庆调休标签；本演示按轮休表执行';
   if(p.region_code==='HK'&&(n===1||n===19)){kind='holiday';note=n===1?'香港国庆日（演示资格已显式确认）':'周日休息与重阳节重叠，19日补假示例';}
   if(!rest&&kind==='work'&&event===4)kind='annual_leave';
   if(!rest&&kind==='work'&&event===5)kind='sick_leave';
   if(!rest&&kind==='work'&&event===6)kind='personal_leave';
   if(!rest&&kind==='work'&&event===7&&ordinal%5===0)kind='absence';
   const day=(await q(t,'INSERT INTO ty_roster_day(period_id,person_id,employment_id,home_company_id,work_date,day_kind,calendar_note)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING *',[period.id,p.id,p.employment_id,p.home_company_id,date,kind,note]))[0];
   if(kind==='rest')continue;
   const leave=kind==='work'?null:kind;
   let blocks=ordinal%5===0?[[18,22,'NIGHT'],[22.5,26.5,'NIGHT']]:ordinal%3===0?[[9,13,'EARLY'],[14,18,'EARLY']]:ordinal%3===1?[[10,14,'LUNCH'],[17,21,'DINNER']]:[[13,17,'LATE'],[18,22,'LATE']];
   const segments=[];
   for(let k=0;k<blocks.length;k++){
    const [from,to,code]=blocks[k];const targetArea=p.job_code==='SYN-CHEF'?areas.filter(a=>same(a.company_id,p.home_company_id))[k%2]:null;
    const dpt=targetArea?.department_id||p.department_id;
    const s=(await q(t,'INSERT INTO ty_roster_segment(day_id,segment_no,shift_code,work_company_id,department_id,work_area_id,start_at,end_at,leave_kind)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)RETURNING *',[day.id,k+1,code,p.home_company_id,dpt,targetArea?.id||null,stamp(date,from),stamp(date,to),leave]))[0];segments.push(s);
   }
   if(kind==='work'&&event===8){
    const first=blocks[0][0],last=blocks[1][1],start=last>24?first-1:last;
    const s=(await q(t,"INSERT INTO ty_roster_segment(day_id,segment_no,shift_code,work_company_id,department_id,start_at,end_at,overtime)VALUES($1,3,'OT',$2,$3,$4,$5,true)RETURNING *",[day.id,p.home_company_id,p.department_id,stamp(date,start),stamp(date,start+(last>24?1:2))]))[0];segments.push(s);
   }
   if(kind==='work'&&event===9){
    const targets=stores.filter(c=>same(c.brand_id,p.brand_id)&&!same(c.id,p.home_company_id));const target=targets[ordinal%targets.length];
    if(target){const dep=departments.find(d=>same(d.company_id,target.id)&&(p.job_code==='SYN-CHEF'?d.name.includes('厨房'):!d.name.includes('厨房')))||departments.find(d=>same(d.company_id,target.id));const area=p.job_code==='SYN-CHEF'?areas.find(a=>same(a.company_id,target.id)&&same(a.department_id,dep.id)):null;changes.push({kind:'secondment',reason:'同品牌跨店支援，保留原雇主发薪归属',patches:segments.map(s=>({segment_id:s.id,work_company_id:target.id,department_id:dep.id,work_area_id:area?.id||null}))});}
   }
   if(kind==='work'&&event===10&&ordinal%9===0){const target=stores.find(c=>!same(c.brand_id,p.brand_id)),dep=departments.find(d=>same(d.company_id,target.id));changes.push({kind:'cross_brand_support',reason:'跨品牌远程运营支援演示，不改变劳动合同和地区计薪归属',patches:segments.map(s=>({segment_id:s.id,work_company_id:target.id,department_id:dep.id,work_area_id:null}))});}
   if(kind==='work'&&event===0){const s=segments[0];changes.push({kind:'shift_swap',reason:'员工申请调整首班开始时间，主管核定后生效',patches:[{segment_id:s.id,start_at:addMin(stamp(date,blocks[0][0]),30),end_at:addMin(stamp(date,blocks[0][1]),30),shift_code:'SWAP'}]});}
   for(const change of changes.splice(0)){
    const c=(await q(t,'INSERT INTO ty_roster_change(period_id,kind,reason,patches,created_by)VALUES($1,$2,$3,$4::jsonb,$5)RETURNING id',[period.id,change.kind,change.reason,JSON.stringify(change.patches),userId]))[0];await t.query('SELECT fn_ty_roster_decide($1,$2,true,$3)',[c.id,userId,'演示主管已核对技能、时间与支援范围']);
   }
   const finalSegments=await q(t,`SELECT *,to_char(start_at,'YYYY-MM-DD HH24:MI:SS') start_at,to_char(end_at,'YYYY-MM-DD HH24:MI:SS') end_at FROM ty_roster_segment WHERE day_id=$1 ORDER BY segment_no`,[day.id]);
   for(const s of finalSegments){if(leave)continue;
    let actualIn=s.start_at instanceof Date?s.start_at.toISOString().replace('T',' ').slice(0,19):String(s.start_at).slice(0,19),actualOut=s.end_at instanceof Date?s.end_at.toISOString().replace('T',' ').slice(0,19):String(s.end_at).slice(0,19);
    if(event===1&&s.segment_no===1)actualIn=addMin(actualIn,15+ordinal%3*5);
    if(event===2&&s.segment_no===2)actualOut=addMin(actualOut,-20);
    await t.query("INSERT INTO ty_time_punch(segment_id,direction,punched_at,source,source_ref)VALUES($1,'in',$2,'synthetic',$3)",[s.id,actualIn,VERSION+':'+s.id+':in']);
    if(event===3&&s.segment_no===2){await t.query("INSERT INTO ty_time_correction(segment_id,direction,corrected_at,reason,reviewed_by)VALUES($1,'out',$2,'虚构设备离线缺下班卡，主管核对值班记录补卡',$3)",[s.id,actualOut,userId]);}
    else await t.query("INSERT INTO ty_time_punch(segment_id,direction,punched_at,source,source_ref)VALUES($1,'out',$2,'synthetic',$3)",[s.id,actualOut,VERSION+':'+s.id+':out']);
   }
  }
 }
 await t.query("UPDATE ty_roster_period SET status='published' WHERE id=$1",[period.id]);
 const summary=monthly(await q(t,'SELECT * FROM v_ty_attendance_day WHERE period_id=$1',[period.id]));
 if(summary.length!==62||summary.some(r=>r.calendar_days!==31||r.missing_punches))throw new Error('October synthetic attendance integrity failed');
 await t.query("UPDATE ty_roster_period SET status='closed',closed_by=$2,closed_at=clock_timestamp() WHERE id=$1",[period.id,userId]);
 await seedPayroll(t,{userId,group,period,summary,people});
 await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'synthetic_october','time_period',$2,$3::jsonb)",[userId,period.id,JSON.stringify({version:VERSION,people:62,person_days:62*31,real_data_imported:false,payments_executed:0})]);
 return receipt(t,period);
}
async function seedPayroll(t,{userId,group,period,summary,people}){
 const base=[
  {code:'performance',name:'Performance bonus',kind:'earning',expression:'performance_bonus'},
  {code:'base_pay',name:'月薪或时薪基本工资',kind:'earning',expression:'ROUND(IF(employment_type="FT",salary_rate,salary_rate*worked_hours),2)'},
  {code:'overtime',name:'已核定加班工资',kind:'earning',expression:'ROUND(hourly_basis*overtime_hours*overtime_multiplier,2)'},
  {code:'meal_allowance',name:'按出勤餐费津贴',kind:'earning',expression:'ROUND(attended_days*meal_daily,2)'},
  {code:'attendance_deduction',name:'事假缺勤与未在岗扣款',kind:'deduction',expression:'ROUND(IF(employment_type="FT",hourly_basis*unpaid_hours,0),2)'},
  {code:'sick_deduction',name:'病假示例差额扣款',kind:'deduction',expression:'ROUND(IF(employment_type="FT",hourly_basis*sick_hours*(1-sick_pay_ratio),0),2)'},
  {code:'sick_pay',name:'时薪病假工资示例',kind:'earning',expression:'ROUND(IF(employment_type="FT",0,salary_rate*sick_hours*sick_pay_ratio),2)'},
  {code:'leave_pay',name:'时薪带薪假日与年假示例',kind:'earning',expression:'ROUND(IF(employment_type="FT",0,salary_rate*other_paid_leave_hours),2)'},
  {code:'holiday_premium',name:'节日在岗额外工资试算',kind:'earning',expression:'ROUND(hourly_basis*festival_work_hours*festival_extra_multiplier,2)'},
 ].map(r=>({...r,jurisdiction_module:'BASE'}));
 const cn=[
  {code:'cn_social_employee',name:'内地个人社保（合成基数与比例）',kind:'employee_contribution',expression:'ROUND(social_basis*social_employee_rate,2)',jurisdiction_module:'CN_SOCIAL_INSURANCE'},
  {code:'cn_social_employer',name:'内地单位社保（合成比例）',kind:'employer_contribution',expression:'ROUND(social_basis*social_employer_rate,2)',jurisdiction_module:'CN_SOCIAL_INSURANCE'},
  {code:'cn_housing_employee',name:'公积金个人（合成参数）',kind:'employee_contribution',expression:'ROUND(social_basis*housing_rate,2)',jurisdiction_module:'CN_SOCIAL_INSURANCE'},
  {code:'cn_housing_employer',name:'公积金单位（合成参数）',kind:'employer_contribution',expression:'ROUND(social_basis*housing_rate,2)',jurisdiction_module:'CN_SOCIAL_INSURANCE'},
  {code:'cn_tax',name:'个税（虚构累计法参数）',kind:'deduction',expression:'MAX(0,ROUND((taxable_ytd*tax_rate-quick_deduction)-tax_prepaid,2))',jurisdiction_module:'CN_IIT'}];
 const hk=[
  {code:'mpf_employee',name:'香港个人MPF（资格显式）',kind:'employee_contribution',expression:'IF(employee_mpf_eligible,IF(mpf_relevant_income<employee_mpf_threshold,0,ROUND(MIN(mpf_relevant_income*mpf_rate,mpf_cap),2)),0)',jurisdiction_module:'HK_MPF'},
  {code:'mpf_employer',name:'香港雇主MPF（资格显式）',kind:'employer_contribution',expression:'IF(employer_mpf_eligible,ROUND(MIN(mpf_relevant_income*mpf_rate,mpf_cap),2),0)',jurisdiction_module:'HK_MPF'}];
 for(const region of ['CN','HK']){
  const currency=region==='CN'?'CNY':'HKD',rows=[],snapshot=[];
  const perf=await seedPerformance(t,{userId,group,period,people:people.filter(p=>p.region_code===region),region,currency});
  const bonusFor=id=>Number(perf.candidates.find(c=>same(c.person_id,id))?.amount||0);
  for(const m of summary.filter(r=>r.region_code===region)){
   const p=people.find(p=>same(p.id,m.person_id)),ordinal=people.indexOf(p)+1;
   const detail=(await q(t,`SELECT count(DISTINCT work_date)FILTER(WHERE credited_minutes>0 AND NOT overtime)::int attended_days,coalesce(sum(planned_minutes)FILTER(WHERE leave_kind='sick_leave'),0)::int sick,coalesce(sum(planned_minutes)FILTER(WHERE leave_kind IN('annual_leave','holiday')),0)::int other_paid,coalesce(sum(credited_minutes)FILTER(WHERE work_date BETWEEN '2026-10-01' AND '2026-10-03' AND leave_kind IS NULL AND NOT overtime),0)::int festival FROM v_ty_time_segment WHERE period_id=$1 AND person_id=$2`,[period.id,p.id]))[0];
   const type=p.employment_type==='FT'?'FT':'PT',rate=type==='FT'?(region==='CN'?7800:16800)+ordinal*83:(region==='CN'?32:78)+ordinal%7;
   const plannedHours=m.planned_minutes/60,hourly=type==='FT'?Number(money(rate/Math.max(1,plannedHours))):rate;
   const inputs={employment_type:type,salary_rate:rate,worked_hours:Number((m.worked_minutes/60).toFixed(6)),hourly_basis:hourly,overtime_hours:m.overtime_minutes/60,overtime_multiplier:region==='CN'?1.5:1.25,attended_days:detail.attended_days,meal_daily:region==='CN'?18:35,unpaid_hours:(m.unpaid_leave_minutes+m.unworked_minutes)/60,sick_hours:detail.sick/60,sick_pay_ratio:.8,other_paid_leave_hours:detail.other_paid/60,festival_work_hours:region==='CN'?detail.festival/60:0,festival_extra_multiplier:region==='CN'?2:0};
   const partial=calculate(base.map(r=>({...r,formula:parseFormula(r.expression)})),{...inputs,performance_bonus:bonusFor(p.id)}),income=Number(partial.totals.income_total),deductions=Number(partial.totals.deduction_total);
   if(region==='CN')Object.assign(inputs,{social_basis:type==='FT'?6000:3000,social_employee_rate:.105,social_employer_rate:.245,housing_rate:.07,taxable_ytd:18000+ordinal*1200,tax_rate:.03,quick_deduction:0,tax_prepaid:500});
   else Object.assign(inputs,{employee_mpf_eligible:ordinal%11!==0,employer_mpf_eligible:true,mpf_relevant_income:Number(money(income-deductions)),employee_mpf_threshold:7100,mpf_rate:.05,mpf_cap:1500});
   rows.push({source_key:`${VERSION}:${region}:${p.person_number}`,source_person_name:p.full_name,source_person_number:p.person_number,source_company_name:p.company_name,source_period:'2026-10',company_id:p.home_company_id,person_id:p.id,employment_id:p.employment_id,data_kind:'inputs',inputs,items:[],source_totals:{}});
   snapshot.push({...m,sick_minutes:detail.sick,other_paid_leave_minutes:detail.other_paid,festival_work_minutes:detail.festival,input_parameters:inputs});
  }
  const rules=[...base,...(region==='CN'?cn:hk)];
  const ruleset=(await payroll.saveRuleSet(t,{userId,input:{group_id:group.id,name:`${region} 2026年10月考勤关联演示规则`,currency,region,rules,status:'approved',approval_ack:true,policy_notes:'全部为独立虚构演示。内地社保公积金基数比例及累计个税数据均为测试参数，非地区正式标准。香港月供MPF显式资格与相关入息；病假80%、日历按工作班段8小时计、加班CN1.5/HK1.25为可选合同演示，非默认法律结论。香港假期资格在合成样本中明确设定。内地国庆1–3日在岗额外2倍仅为试算。无真实付款。'}})).ruleset;
  const batch=(await payroll.createBatch(t,{userId,input:{group_id:group.id,period:'2026-10',region_code:region,currency,kind:'calculated',label:`${region==='CN'?'内地':'香港'}10月考勤关联工资 · 全虚构未付款`,metadata:{adapter:VERSION,filename:`${VERSION}-${region}`},rows}})).batch;
  const applied=await payroll.applyPerformanceCandidates(t,{userId,batchId:batch.id,input:{cycle_id:perf.selected_id,rounding:'round_2'}});if(applied.applied.length!==rows.length||applied.blocked.length)throw new Error('October performance posting incomplete');
  const result=await payroll.calculateBatch(t,{userId,batchId:batch.id,input:{ruleset_id:ruleset.id}});if(!result.ok)throw new Error('Synthetic October payroll calculation failed: '+JSON.stringify(result.checks?.filter(r=>!r.ok)));
  const validation=await payroll.validateBatch(t,{userId,batchId:batch.id});if(!validation.ok)throw new Error('Synthetic October payroll validation failed');
  await payroll.confirmBatch(t,{userId,batchId:batch.id});
  await t.query('INSERT INTO ty_time_payroll_link(period_id,batch_id,region_code,snapshot,created_by)VALUES($1,$2,$3,$4::jsonb,$5)',[period.id,batch.id,region,JSON.stringify(snapshot),userId]);
 }
}
async function receipt(t,period){return{synthetic:true,version:VERSION,period_id:period.id,period:'2026-10',people:Number((await q(t,'SELECT count(DISTINCT person_id) n FROM ty_roster_day WHERE period_id=$1',[period.id]))[0].n),person_days:Number((await q(t,'SELECT count(*) n FROM ty_roster_day WHERE period_id=$1',[period.id]))[0].n),segments:Number((await q(t,'SELECT count(*) n FROM v_ty_time_segment WHERE period_id=$1',[period.id]))[0].n),payroll_batches:(await q(t,'SELECT batch_id,region_code FROM ty_time_payroll_link WHERE period_id=$1 ORDER BY region_code',[period.id])),payments_executed:0};}
async function seedPerformance(t,{userId,group,period,people,region,currency}){
 const companyIds=[...new Set(people.map(p=>p.home_company_id))],grades=await q(t,'SELECT * FROM ty_grade WHERE group_id=$1 ORDER BY level,id',[group.id]);
 const baseRules={confirmed:true,payout_assignment:'last_month_employment',alternative_eligibility:'last_month',alternative_rounding:'round_2',score_base:1,score_floor:0,metrics:[{code:'quality',unit:'ratio',method:'direct_deduction'},{code:'turnover',unit:'ratio',method:'direct_deduction'}],rating_bands:[{min_score:.995,grade:'S',factor:2},{min_score:.945,grade:'A',factor:1.5},{min_score:.845,grade:'B',factor:1.2},{min_score:.505,grade:'C',factor:1},{min_score:0,grade:'D',factor:0}],grade_bases:Object.fromEntries(grades.map((g,i)=>[g.id,1000+i*600])),management:{confirmed:true,method:'weighted_company_scores'},score_tolerance:.000001,amount_tolerance:.01,policy_notes:'全虚构10月门店服务质量和人员稳定指标，个人按当月有效职级及资格核定；两种奖金策略保留，演示选择逐月金额取整，无客户真实数据。'};
 const companyMetrics=companyIds.map((id,i)=>({company_id:id,period:'2026-10',metrics:{quality:{value:.013+(i%3)*.01,unit:'ratio',status:'verified',source_ref:{kind:'synthetic',version:VERSION}},turnover:{value:.007+(i%4)*.005,unit:'ratio',status:'verified',source_ref:{kind:'synthetic',version:VERSION}}},source_ref:{kind:'synthetic',time_period_id:period.id,version:VERSION}}));
 const months=people.map(p=>({person_id:p.id,company_id:p.home_company_id,employment_id:p.employment_id,grade_id:p.grade_id,period:'2026-10',score_source:'company',eligibility_status:'verified',eligibility_weight:1,source_ref:{kind:'synthetic',time_period_id:period.id,version:VERSION}}));
 const cycles=[];
 for(const [i,aggregation] of ['floor_average_months','average_score_last_grade'].entries()){
  const cycle=(await performance.createCycle(t,{userId,input:{group_id:group.id,code:`SYN-${region}-202610-${i?'AVERAGE':'MONTHLY'}`,name:`${region==='CN'?'内地':'香港'}10月虚构绩效 · ${i?'平均分与期末职级':'逐月奖金取整'}`,start_date:'2026-10',end_date:'2026-11',payout_period:'2026-10',region_code:region,currency_code:currency,company_ids:companyIds}})).cycle;
  await performance.saveScheme(t,{userId,cycleId:cycle.id,input:{rules:{...baseRules,aggregation},source_refs:[{kind:'synthetic',version:VERSION,time_period_id:period.id}],confirmation_note:'测试帐套自行选用，无外部业务确认依赖'}});
  await performance.saveInputs(t,{userId,cycleId:cycle.id,input:{company_metrics:companyMetrics,person_months:months,responsibilities:[]}});
  let result=await performance.calculate(t,{userId,cycleId:cycle.id});if(!result.scope.can_confirm)throw new Error('October performance blocked: '+JSON.stringify(result.summary));
  if(!i)result=await performance.confirm(t,{userId,cycleId:cycle.id,input:{result_version:result.cycle.result_version,reason:'演示采用逐月奖金取整方案，另一方案保留试算，客户可另选'}});
  cycles.push(cycle.id);
 }
 const candidates=(await performance.getPayrollCandidates(t,{userId,cycleId:cycles[0],period:'2026-10'})).candidates;if(candidates.length!==people.length)throw new Error('October performance candidates incomplete');return{selected_id:cycles[0],alternative_id:cycles[1],candidates};
}
