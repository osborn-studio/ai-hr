// Fully fabricated, deterministic business workspace. No customer files, source
// adapters, external communications, payments or account credentials are used.
// The caller owns one transaction, exactly as with other service operations.
import {bizErr} from '../errors.mjs';
import * as foundation from './foundation.mjs';
import * as performance from './customer-performance.mjs';
import * as payroll from './customer-payroll.mjs';
import * as bridge from './foundation-bridge.mjs';
import * as roster from './roster-write.mjs';
import * as training from './training.mjs';

export const RESOURCES=['ledger','perf_cycle','payroll_run','payroll_slips_read_all'];
const CODE='TY-TEST';
const VERSION='TY-TEST-v3';
const PEOPLE_COUNT=62;
const MANAGER_ORDINALS=[61,62];
const PERFORMANCE_MANAGER_ORDINALS=[33,61,62];
const AGGREGATIONS=['floor_average_months','average_score_last_grade'];
const money=n=>Number(n).toFixed(2);
const q=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows;
const fail=m=>{throw bizErr('E_TY_CONFLICT',m);};

export async function seed(tx,{userId,input}) {
  if(input?.confirm_synthetic!==true)throw bizErr('E_TY_ARGUMENT','请明确confirm_synthetic，确认仅创建全虚构测试帐套');
  const selected=input.selected_aggregation||'floor_average_months';
  if(!AGGREGATIONS.includes(selected))throw bizErr('E_TY_ARGUMENT','请选择支持的绩效聚合算法');
  const selectedByRegion={CN:input.selected_aggregations?.CN||selected,HK:input.selected_aggregations?.HK||selected};
  if(Object.values(selectedByRegion).some(v=>!AGGREGATIONS.includes(v)))throw bizErr('E_TY_ARGUMENT','请选择各地区支持的绩效聚合算法');
  const a=await foundation.accessFor(tx,userId);
  if(!a.admin)throw bizErr('E_TY_FORBIDDEN','完整测试工作区仅限基础管理员生成');
  for(const [resource,action] of [['perf_cycle','write'],['payroll_run','write'],['payroll_slips_read_all','read']]) {
    if(!(await q(tx,'SELECT fn_role_can($1,$2,$3) ok',[userId,resource,action]))[0]?.ok)
      throw bizErr('E_TY_FORBIDDEN','生成完整业务演示还需要绩效和薪酬岗位权限');
  }
  // Serialize the explicit one-off bootstrap without opening its own transaction.
  await tx.query('LOCK TABLE ty_group IN SHARE ROW EXCLUSIVE MODE');
  const existing=(await q(tx,'SELECT id FROM ty_group WHERE code=$1',[CODE]))[0];
  if(existing) {
    const receipt=(await q(tx,`SELECT after_data FROM ty_audit WHERE entity_kind='test_workspace' AND entity_id=$1 AND action='seed'
      ORDER BY id DESC LIMIT 1`,[existing.id]))[0]?.after_data;
    return receipt?{...receipt,seeded:false,already_exists:true,notice:'完整虚构测试帐套已存在，未覆盖任何业务记录。'}:
      {seeded:false,already_exists:true,complete:false,group_id:existing.id,notice:'TY-TEST编码已存在，未覆盖；没有找到本服务的完整初始化回执。'};
  }
  const add=async(collection,data)=>(await foundation.save(tx,{userId,collection,input:data})).row;
  const group=await add('groups',{code:CODE,name:'天意集团'}),gid=group.id;
  const brandA=await add('brands',{group_id:gid,code:'SYN-A',name:'香香鱼米',region_code:'CN',currency_code:'CNY'});
  const brandB=await add('brands',{group_id:gid,code:'SYN-B',name:'大富烤肉',region_code:'HK',currency_code:'HKD'});
  const ledgerA=await add('ledgers',{group_id:gid,brand_id:brandA.id,scope_mode:'brand',code:'SYN-LEDGER-A',name:'香香鱼米测试帐套',region_code:'CN',currency_code:'CNY'});
  const ledgerB=await add('ledgers',{group_id:gid,brand_id:brandB.id,scope_mode:'brand',code:'SYN-LEDGER-B',name:'大富烤肉测试帐套',region_code:'HK',currency_code:'HKD'});
  const ledgerHQ=await add('ledgers',{group_id:gid,scope_mode:'group',code:'SYN-LEDGER-HQ',name:'天意集团总部测试帐套',region_code:'CN',currency_code:'CNY'});
  const companySpecs=[];
  for(const [brand,ledger,key] of [[brandA,ledgerA,'A'],[brandB,ledgerB,'B']])for(let n=1;n<=10;n++)companySpecs.push({
    code:`SYN-${key}-${String(n).padStart(2,'0')}`,name:`${brand.name}${String(n).padStart(2,'0')}店`,ledger,brand,kind:'store',storeNumber:n,
  });
  companySpecs.push({code:'SYN-HQ',name:'天意集团总部',ledger:ledgerHQ,brand:null,kind:'headquarters'});
  const companies=[];
  for(const s of companySpecs)companies.push(await add('companies',{group_id:gid,ledger_id:s.ledger.id,brand_id:s.brand?.id||null,code:s.code,name:s.name,company_kind:s.kind,
    address:s.kind==='headquarters'?'内地·全虚构测试总部':`${s.brand.id===brandB.id?'香港':'内地'}·全虚构演示广场${String(s.storeNumber).padStart(2,'0')}`}));
  const jobs=[];for(const [code,name] of [['SYN-SERVICE','演示服务岗'],['SYN-CHEF','演示料理岗'],['SYN-MANAGER','演示营运管理岗']])jobs.push(await add('jobs',{group_id:gid,code,name,job_family:'全虚构测试职系'}));
  const grades=[];for(let i=1;i<=3;i++)grades.push(await add('grades',{group_id:gid,code:`SYN-L${i}`,name:`演示职级${i}`,level:i}));
  const departments=[],areas=[],positions=[],byCompany=new Map();
  for(const company of companies) {
    const hq=company.company_kind==='headquarters';
    const front=await add('departments',{company_id:company.id,code:hq?'SYN-OPS':'SYN-FRONT',name:hq?'演示营运部':'演示前厅部'});departments.push(front);
    let kitchen=null;
    if(!hq) {
      kitchen=await add('departments',{company_id:company.id,code:'SYN-KITCHEN',name:'演示厨房部'});departments.push(kitchen);
      areas.push(await add('work-areas',{company_id:company.id,department_id:kitchen.id,code:'SYN-DEPT-AREA',name:'演示厨房档口',mode:'department_extension'}));
      areas.push(await add('work-areas',{company_id:company.id,department_id:kitchen.id,code:'SYN-WORK-AREA',name:'演示炉灶工作区',mode:'work_area_in_department'}));
    }
    const slots={};
    for(const job of hq?[jobs[2]]:jobs) {
      const dept=job.id===jobs[1].id?kitchen:front;
      const position=await add('positions',{group_id:gid,company_id:company.id,department_id:dept.id,job_id:job.id,code:job.code,name:job.name});
      positions.push(position);slots[job.code]={department:dept,position};
    }
    byCompany.set(String(company.id),slots);
  }
  const people=[],employments=[],assignments=[],current=[];
  const makeAssignment=async(employment,company,grade,index,start)=>{
    const jobCode=MANAGER_ORDINALS.includes(index)||index%3===0?'SYN-MANAGER':index%3===1?'SYN-SERVICE':'SYN-CHEF';
    const slot=byCompany.get(String(company.id))[jobCode];
    const row=await add('assignments',{group_id:gid,company_id:company.id,employment_id:employment.id,department_id:slot.department.id,position_id:slot.position.id,grade_id:grade.id,
      ...(jobCode==='SYN-CHEF'?{work_area_id:areas.find(a=>String(a.company_id)===String(company.id)&&a.mode==='work_area_in_department').id}:{}),valid_from:start,is_primary:true});
    assignments.push(row);return row;
  };
  for(let i=1;i<=PEOPLE_COUNT;i++) {
    const person=await add('people',{group_id:gid,full_name:`虚构人员${String(i).padStart(2,'0')}`});people.push(person);
    // Swap one current slot between A01/B01: every store still has three
    // employees after the cross-brand rehire, without inventing a fourth worker.
    const company=MANAGER_ORDINALS.includes(i)?companies[20]:i===1?companies[10]:i===31?companies[0]:companies[Math.floor((i-1)/3)];
    const grade=i===1?grades[1]:MANAGER_ORDINALS.includes(i)?grades[2]:grades[(i-1)%3];
    const type=!MANAGER_ORDINALS.includes(i)&&i%3!==0&&i%4===0?'PT':'FT';
    let oldEmployment=null;
    if(i===1) {
      oldEmployment=await add('employments',{group_id:gid,person_id:person.id,company_id:companies[0].id,employment_type:'FT',hire_date:'2026-01-01'});
      await makeAssignment(oldEmployment,companies[0],grades[0],i,'2026-01-01');
      oldEmployment=(await foundation.save(tx,{userId,collection:'employments',id:oldEmployment.id,input:{status:'ended',leave_date:'2026-06-30'}})).row;
      employments.push(oldEmployment);
    }
    const employment=await add('employments',{group_id:gid,person_id:person.id,company_id:company.id,employment_type:type,hire_date:i===1?'2026-07-01':'2026-01-01',...(oldEmployment?{rehire_link:oldEmployment.id}:{})});
    employments.push(employment);
    if(i===1) {
      const july=await makeAssignment(employment,company,grades[0],i,'2026-07-01');
      await foundation.save(tx,{userId,collection:'assignments',id:july.id,input:{status:'ended',valid_to:'2026-08-01'}});
      await makeAssignment(employment,company,grade,i,'2026-08-01');
    } else await makeAssignment(employment,company,grade,i,'2026-01-01');
    current.push({ordinal:i,person,company,grade,type,employment,oldEmployment,region:company.ledger_id===ledgerB.id?'HK':'CN'});
  }
  const periods=['2026-07','2026-08','2026-09'];
  // Independent synthetic deductions. They are not copied from a customer row.
  const deductionPatterns=[[[.08,.01],[.025,.015],[0,0]],[[.01,.01],[.08,.03],[.02,.01]],[[.04,.03],[.035,.015],[.005,.005]]];
  const deductions=companies.map((co,index)=>co.company_kind==='headquarters'?[[.005,.005],[.01,.01],[0,0]]:deductionPatterns[index===10?1:index%3]);
  const companyMetrics=companies.flatMap((co,index)=>periods.map((period,m)=>({company_id:co.id,period,metrics:{
    quality:{value:deductions[index][m][0],unit:'ratio',status:'verified',source_ref:{kind:'synthetic',fixture_version:VERSION,metric:'quality'}},
    turnover:{value:deductions[index][m][1],unit:'ratio',status:'verified',source_ref:{kind:'synthetic',fixture_version:VERSION,metric:'turnover'}},
  },source_saved_score:1-deductions[index][m][0]-deductions[index][m][1],source_ref:{kind:'synthetic',fixture_version:VERSION,company_code:co.code,period}})));
  const personMonths=current.flatMap(p=>periods.map((period,m)=>({person_id:p.person.id,company_id:p.company.id,
    employment_id:p.employment.id,grade_id:p.ordinal===1&&m===0?grades[0].id:p.grade.id,
    period,score_source:PERFORMANCE_MANAGER_ORDINALS.includes(p.ordinal)?'management':'company',eligibility_status:'verified',eligibility_weight:1,
    source_ref:{kind:'synthetic',fixture_version:VERSION,person_ordinal:p.ordinal,period}})));
  const responsibilities=current.filter(p=>PERFORMANCE_MANAGER_ORDINALS.includes(p.ordinal)).flatMap(p=>periods.flatMap(period=>companies.slice(p.region==='HK'?10:0,p.region==='HK'?20:10).map((co,i)=>({
    person_id:p.person.id,company_id:co.id,period,weight:p.ordinal===62?(i<5?.04:.16):.1,status:'verified',source_ref:{kind:'synthetic',fixture_version:VERSION},
  }))));
  const baseRules={confirmed:true,payout_assignment:'last_month_employment',alternative_eligibility:'last_month',alternative_rounding:'round_2',score_base:1,score_floor:0,
    metrics:[{code:'quality',unit:'ratio',method:'direct_deduction'},{code:'turnover',unit:'ratio',method:'direct_deduction'}],
    rating_bands:[{min_score:.995,grade:'S',factor:2},{min_score:.945,grade:'A',factor:1.5},{min_score:.845,grade:'B',factor:1.2},{min_score:.505,grade:'C',factor:1},{min_score:0,grade:'D',factor:0}],
    grade_bases:{[grades[0].id]:1000,[grades[1].id]:1600,[grades[2].id]:2200},management:{confirmed:true,method:'weighted_company_scores'},
    score_tolerance:.000001,amount_tolerance:.01,policy_notes:'全虚构测试参数；按地区及币种独立选择聚合、分级、资格和基数，不依赖外部客户审批，不作汇率换算。'};
  const basePayrollRules=[
    {code:'base_pay',name:'合成基本工资',kind:'earning',expression:'ROUND(IF(employment_type="FT",salary_rate/period_days*employed_days,salary_rate*worked_hours),2)'},
    {code:'overtime',name:'合成加班工资',kind:'earning',expression:'ROUND(IF(employment_type="FT",salary_rate/overtime_divisor*overtime_hours*overtime_multiplier,0),2)'},
    {code:'meal_allowance',name:'合成餐费津贴',kind:'earning',expression:'meal_allowance'},
    {code:'transport_allowance',name:'合成交通津贴',kind:'earning',expression:'transport_allowance'},
    {code:'performance',name:'本地区已选合成方案绩效',kind:'earning',expression:'performance_bonus'},
    {code:'absence',name:'合成假勤扣款',kind:'deduction',expression:'absence_deduction'},
  ].map(r=>({...r,jurisdiction_module:'BASE'}));
  const mpfRules=[
    {code:'mpf_employee',name:'香港雇员MPF示例',kind:'employee_contribution',jurisdiction_module:'HK_MPF',expression:'IF(employee_mpf_eligible,IF(mpf_relevant_income<employee_mpf_threshold,0,ROUND(MIN(mpf_relevant_income*mpf_rate,mpf_cap),2)),0)'},
    {code:'mpf_employer',name:'香港雇主MPF示例',kind:'employer_contribution',jurisdiction_module:'HK_MPF',expression:'IF(employer_mpf_eligible,ROUND(MIN(mpf_relevant_income*mpf_rate,mpf_cap)+employer_mpf_arrears,2),0)'},
  ];
  function syntheticInputs(p,period,bonus=0) {
    const rate=p.type==='FT'?18000+p.ordinal*137:75+p.ordinal*2;
    const days=period==='2026-11'?30:31,hours=90+p.ordinal*2,ot=p.ordinal%4;
    const meal=300+(p.ordinal%4)*50,transport=100+(p.ordinal%3)*40;
    const base=p.type==='FT'?rate:rate*hours,overtime=p.type==='FT'?Number(money(rate/200*ot*1.25)):0;
    const inputs={employment_type:p.type,salary_rate:rate,period_days:days,employed_days:days,worked_hours:hours,overtime_hours:ot,overtime_divisor:200,overtime_multiplier:1.25,
      meal_allowance:meal,transport_allowance:transport,absence_deduction:p.ordinal%5===0?50:0};
    if(p.region==='HK')Object.assign(inputs,{employee_mpf_eligible:p.ordinal%4!==0,employer_mpf_eligible:true,
      mpf_relevant_income:Number(money(base+overtime+meal+transport+bonus)),employee_mpf_threshold:7100,mpf_rate:.05,mpf_cap:1500,employer_mpf_arrears:p.ordinal===40?80:0});
    return inputs;
  }
  function mapping(p,period) {return {source_key:`${VERSION}:${p.region}:${period}:${p.ordinal}`,source_person_name:p.person.full_name,source_person_number:p.person.person_number,
    source_company_name:p.company.name,source_period:period,company_id:p.company.id,person_id:p.person.id,employment_id:p.employment.id};}
  function snapshot(p) {
    const x=syntheticInputs(p,'2026-10'),base=x.employment_type==='FT'?x.salary_rate:x.salary_rate*x.worked_hours;
    const overtime=x.employment_type==='FT'?Number(money(x.salary_rate/200*x.overtime_hours*1.25)):0;
    const ee=p.region==='HK'&&x.employee_mpf_eligible?Number(money(Math.min(x.mpf_relevant_income*.05,1500))):0;
    const er=p.region==='HK'?Number(money(Math.min(x.mpf_relevant_income*.05,1500)+x.employer_mpf_arrears)):0;
    const rawItems=[['base_pay','合成历史基本工资','earning',base],['overtime','合成历史加班','earning',overtime],['meal_allowance','合成历史餐费','earning',x.meal_allowance],
      ['transport_allowance','合成历史交通','earning',x.transport_allowance],['absence','合成历史假勤扣款','deduction',x.absence_deduction]];
    if(p.region==='HK')rawItems.push(['mpf_employee','香港历史雇员供款示例','employee_contribution',ee],['mpf_employer','香港历史雇主供款示例','employer_contribution',er]);
    const items=rawItems.map(([code,name,kind,amount])=>({code,name,kind,amount:money(amount)}));
    const income=base+overtime+x.meal_allowance+x.transport_allowance;
    return {...mapping(p,'2026-10'),data_kind:'source_snapshot',inputs:{},items,source_totals:{income_total:money(income),deduction_total:money(x.absence_deduction),employee_contribution:money(ee),employer_contribution:money(er),net_pay:money(income-x.absence_deduction-ee)}};
  }
  const regional={};
  for(const region of ['CN','HK']) {
    const currency=region==='HK'?'HKD':'CNY',staff=current.filter(p=>p.region===region),regionCompanies=companies.filter(c=>region==='HK'?c.ledger_id===ledgerB.id:c.ledger_id!==ledgerB.id);
    const companyIds=regionCompanies.map(c=>c.id),personIds=staff.map(p=>p.person.id);
    const metrics=companyMetrics.filter(r=>companyIds.includes(r.company_id)),months=personMonths.filter(r=>personIds.includes(r.person_id)),responsibility=responsibilities.filter(r=>personIds.includes(r.person_id));
    const cycles=[];
    for(const aggregation of AGGREGATIONS) {
      const label=aggregation==='floor_average_months'?'逐月金额平均取整':'平均分期末职级';
      const cycle=(await performance.createCycle(tx,{userId,input:{group_id:gid,code:`SYN-${region}-Q3-${aggregation==='floor_average_months'?'MONTHLY':'AVERAGE'}`,
        name:`${region==='HK'?'香港':'内地'}虚构三季度·${label}`,start_date:'2026-07',end_date:'2026-10',payout_period:'2026-11',region_code:region,currency_code:currency,company_ids:companyIds}})).cycle;
      await performance.saveScheme(tx,{userId,cycleId:cycle.id,input:{rules:{...baseRules,aggregation},source_refs:[{kind:'synthetic',fixture_version:VERSION,region,currency}],confirmation_note:'测试操作者选定本地区虚构方案'}});
      await performance.saveInputs(tx,{userId,cycleId:cycle.id,input:{company_metrics:metrics,person_months:months,responsibilities:responsibility}});
      let result=await performance.calculate(tx,{userId,cycleId:cycle.id});
      if(!result.scope.can_confirm)fail(`${region}合成绩效仍有阻断，请检查初始化规则`);
      if(aggregation===selectedByRegion[region])result=await performance.confirm(tx,{userId,cycleId:cycle.id,input:{result_version:result.cycle.result_version,reason:'操作者启用本地区本币种的全虚构演示方案，不代表客户制度或真实付款'}});
      cycles.push({id:cycle.id,aggregation,status:result.cycle.status});
    }
    const selectedCycle=cycles.find(c=>c.aggregation===selectedByRegion[region]),comparisonCycle=cycles.find(c=>c.aggregation!==selectedByRegion[region]);
    const candidates=(await performance.getPayrollCandidates(tx,{userId,cycleId:selectedCycle.id,period:'2026-11'})).candidates;
    if(candidates.length!==staff.length||candidates.some(c=>c.currency_code!==currency||c.region_code!==region))fail(`${region}确认绩效须完整覆盖本地区且不混币种`);
    const bonusFor=p=>Number(candidates.find(c=>String(c.person_id)===String(p.person.id))?.amount??0);
    const policy=region==='HK'?'香港MPF仅参考一般按月5%、雇员入息下限7100、供款上限1500，来源 https://www.mpfa.org.hk/en/mpf-system/mandatory-contributions/employees （2026-11-16核对）；资格为显式合成布尔输入，不从FT/PT推断年龄、豁免、供款假期或完整法定资格。':
      '内地仅启用BASE通用合成工资项目，未启用香港MPF，也没有自动推定内地个税、社保、公积金标准；需要时由操作者独立配置相应地区模块及参数。';
    const ruleset=(await payroll.saveRuleSet(tx,{userId,input:{group_id:gid,name:`${region==='HK'?'香港':'内地'}全虚构FT/PT测试规则`,region,currency,status:'approved',approval_ack:true,
      rules:region==='HK'?[...basePayrollRules,...mpfRules]:basePayrollRules,policy_notes:`员工、公司、金额、工时全部独立编造，FT日历天/PT工时、OT除数200倍数1.25、津贴扣款均仅作测试。${policy}没有真实付款或客户资料。`}})).ruleset;
    const header={group_id:gid,region_code:region,currency};
    const history=(await payroll.createBatch(tx,{userId,input:{...header,period:'2026-10',kind:'source_snapshot',label:`${region}全虚构10月历史快照·未付款`,
      metadata:{filename:`synthetic-${region}-history-october`,adapter:VERSION},rows:staff.map(snapshot)}})).batch;
    if(!(await payroll.validateBatch(tx,{userId,batchId:history.id})).ok)fail(`${region}历史快照对账失败`);
    const newBatch=(await payroll.createBatch(tx,{userId,input:{...header,period:'2026-11',kind:'calculated',label:`${region}全虚构11月工资·已锁定未付款`,metadata:{filename:`synthetic-${region}-inputs-november`,adapter:VERSION},
      rows:staff.map(p=>({...mapping(p,'2026-11'),data_kind:'inputs',inputs:syntheticInputs(p,'2026-11',bonusFor(p)),items:[],source_totals:{}}))}})).batch;
    const applied=await payroll.applyPerformanceCandidates(tx,{userId,batchId:newBatch.id,input:{cycle_id:selectedCycle.id}});
    const repeated=await payroll.applyPerformanceCandidates(tx,{userId,batchId:newBatch.id,input:{cycle_id:selectedCycle.id}});
    if(applied.applied.length!==staff.length||applied.blocked.length||repeated.applied.length||repeated.already_applied.length!==staff.length)fail(`${region}绩效过账未满足完整幂等`);
    if(!(await payroll.calculateBatch(tx,{userId,batchId:newBatch.id,input:{ruleset_id:ruleset.id}})).ok)fail(`${region}工资试算失败`);
    if(!(await payroll.validateBatch(tx,{userId,batchId:newBatch.id})).ok)fail(`${region}工资核验失败`);
    await payroll.confirmBatch(tx,{userId,batchId:newBatch.id});
    const editable=(await payroll.createBatch(tx,{userId,input:{...header,period:'2026-12',kind:'calculated',label:`${region}全虚构12月待操作工资`,metadata:{filename:`synthetic-${region}-inputs-december`,adapter:VERSION},
      rows:staff.map(p=>({...mapping(p,'2026-12'),data_kind:'inputs',inputs:syntheticInputs(p,'2026-12'),items:[],source_totals:{}}))}})).batch;
    regional[region]={region_code:region,currency_code:currency,selected_aggregation:selectedByRegion[region],company_ids:companyIds,person_ids:personIds,
      performance_cycle_ids:cycles.map(c=>c.id),selected_cycle_id:selectedCycle.id,comparison_cycle_id:comparisonCycle.id,ruleset_id:ruleset.id,
      payroll_batches:{history_october:history.id,locked_november:newBatch.id,editable_december:editable.id},
      summary:{people:staff.length,companies:regionCompanies.length,company_months_per_cycle:metrics.length,person_months_per_cycle:months.length,responsibility_rows:responsibility.length,
        historical_rows:staff.length,november_rows:staff.length,december_rows:staff.length}};
  }

  // Explicit projection and explicit legacy authorization are separate actions.
  // This opt-in synthetic initializer is authorized to do both; the ordinary
  // bridge service continues to grant no resource or data-scope permissions.
  const legalEntities={};
  legalEntities.CN=(await bridge.createLegalEntity(tx,{userId,input:{company_id:companies[0].id,name:`天意集团测试内地用工主体（虚构·G${gid}）`,address:'全虚构内地测试地址'}})).row.id;
  legalEntities.HK=(await bridge.createLegalEntity(tx,{userId,input:{company_id:companies[10].id,name:`天意集团测试香港用工主体（虚构·G${gid}）`,address:'全虚构香港测试地址'}})).row.id;
  let root=(await q(tx,'SELECT id FROM org_unit WHERE parent_id IS NULL ORDER BY id LIMIT 1'))[0]?.id||null;
  let parent=root?Number((await q(tx,"SELECT fn_org_add($1,$2,'region',NULL) id",[root,`TY-TEST测试兼容范围·G${gid}`]))[0].id):null;
  const legacyOrgIds=[],legacyEmploymentIds=[];
  for(const company of companies) {
    const region=company.ledger_id===ledgerB.id?'HK':'CN';
    const input={company_id:company.id,payroll_legal_entity_id:legalEntities[region],si_legal_entity_id:legalEntities[region],effective_from:'2026-01-01',
      employment_ids:employments.filter(e=>String(e.company_id)===String(company.id)).map(e=>e.id),confirm:true,
      ...(parent?{legacy_parent_org_id:parent}:{create_legacy_root:true})};
    const projected=await bridge.commit(tx,{userId,input});
    if(!parent){parent=projected.organization.legacy_parent_org_id;root=parent;}
    legacyOrgIds.push(projected.organization.legacy_org_id);
    legacyEmploymentIds.push(...projected.people.map(p=>p.legacy_employment_id));
  }
  await tx.query('LOCK TABLE sys_data_scope IN SHARE ROW EXCLUSIVE MODE');
  const scopeId=(await q(tx,"INSERT INTO sys_data_scope(id,name,combinator) SELECT coalesce(max(id),0)+1,'TY-TEST','intersection' FROM sys_data_scope RETURNING id"))[0].id;
  for(const [dimension,values] of [['cost_org',legacyOrgIds],['attendance_org',legacyOrgIds],['payroll_legal_entity',Object.values(legalEntities)],['si_entity',Object.values(legalEntities)]])
    await tx.query("INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES($1,$2,'nodes',$3::bigint[])",[scopeId,dimension,values]);
  const roleGrantId=(await q(tx,`INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,granted_by,grant_kind,grant_reason)
    VALUES($1,10,$2,'2026-01-01',$1,'ROLE','confirm_synthetic:仅TY-TEST组织和虚构主体的显式测试授权') RETURNING id`,[userId,scopeId]))[0].id;
  await tx.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data) VALUES($1,'synthetic_legacy_scope','test_workspace',$2,$3::jsonb)",
    [userId,gid,JSON.stringify({scope_id:scopeId,role_grant_id:roleGrantId,org_ids:legacyOrgIds,legal_entities:legalEntities})]);
  const legacyPeople=(await q(tx,'SELECT id,legacy_person_id FROM ty_person WHERE group_id=$1 ORDER BY id',[gid]));
  const personMap=new Map(legacyPeople.map(p=>[String(p.id),Number(p.legacy_person_id)]));
  const shiftCode=`TYT${gid}`;
  await tx.query('LOCK TABLE shift_def IN SHARE ROW EXCLUSIVE MODE');
  await tx.query("INSERT INTO shift_def(code,name,start_time,end_time,color,is_rest,shift_id) SELECT $1,'天意测试日班','09:00','17:00','#3476b8',false,coalesce(max(shift_id),0)+1 FROM shift_def",[shiftCode]);
  const nextWeek=(await q(tx,"SELECT (date_trunc('week',current_date)+interval '7 days')::date::text date"))[0].date;
  const schedules=[];
  for(const company of companies.filter(c=>c.company_kind==='store')) {
    const p=current.find(p=>String(p.company.id)===String(company.id));
    const org=legacyOrgIds[companies.findIndex(c=>String(c.id)===String(company.id))];
    schedules.push((await roster.assign(tx,{userId,employeeId:personMap.get(String(p.person.id)),date:nextWeek,shift:shiftCode,storeId:Number(org),reason:'全虚构测试工作区：未来一周排班示例'})).schedule_id);
  }
  const course=await training.createCourse(tx,{userId,code:`TYTEST-${gid}`,name:'天意测试服务与安全入门（虚构）',category:'skill',stdHours:2,statutory:false,note:'独立虚构的功能演练课程，不产生法定培训结论'});
  const sessions=[];let enrollmentCount=0;
  for(const region of ['CN','HK']) {
    const session=await training.createSession(tx,{userId,courseId:course.id,entityId:Number(legalEntities[region]),date:nextWeek,fromTime:'18:00',toTime:'20:00',hours:2,capacity:64,trainer:'虚构培训讲师',place:`${region}全虚构培训场地`});
    const enrolled=await training.enroll(tx,{userId,sessionId:session.id,employeeIds:current.filter(p=>p.region===region).map(p=>personMap.get(String(p.person.id)))});
    sessions.push(session.id);enrollmentCount+=enrolled.count;
  }
  const legacy={scope_id:scopeId,role_grant_id:roleGrantId,root_org_id:root,parent_org_id:parent,organization_ids:legacyOrgIds,legal_entity_ids:legalEntities,
    person_ids:[...personMap.values()],employment_ids:legacyEmploymentIds,shift_code:shiftCode,schedule_date:nextWeek,schedule_ids:schedules,
    course_id:course.id,training_session_ids:sessions,training_enrollment_count:enrollmentCount};
  const result={seeded:true,complete:true,synthetic:true,fixture_version:VERSION,group_id:gid,selected_aggregation:selected,selected_aggregations:selectedByRegion,
    ids:{group_id:gid,brand_ids:[brandA.id,brandB.id],ledger_ids:[ledgerA.id,ledgerB.id,ledgerHQ.id],company_ids:companies.map(x=>x.id),department_ids:departments.map(x=>x.id),work_area_ids:areas.map(x=>x.id),
      job_ids:jobs.map(x=>x.id),grade_ids:grades.map(x=>x.id),position_ids:positions.map(x=>x.id),person_ids:people.map(x=>x.id),employment_ids:employments.map(x=>x.id),assignment_ids:assignments.map(x=>x.id),
      regions:regional,selected_cycle_id:regional.HK.selected_cycle_id,comparison_cycle_id:regional.HK.comparison_cycle_id,performance_cycle_ids:Object.values(regional).flatMap(r=>r.performance_cycle_ids),
      ruleset_id:regional.HK.ruleset_id,payroll_batches:regional.HK.payroll_batches,legacy},
    summary:{brands:2,brand_stores:{'香香鱼米':10,'大富烤肉':10},ledgers:3,brand_ledgers:2,group_ledgers:1,stores:20,headquarters_companies:1,departments:departments.length,work_areas:areas.length,jobs:jobs.length,grades:grades.length,positions:positions.length,people:PEOPLE_COUNT,
      employments:employments.length,assignments:assignments.length,performance_cycles:4,regions:Object.fromEntries(Object.entries(regional).map(([k,r])=>[k,{...r.summary,currency:r.currency_code,selected_aggregation:r.selected_aggregation}])),management_people:3,
      confirmed_performance_candidates:PEOPLE_COUNT,performance_inputs_posted:PEOPLE_COUNT,historical_rows:PEOPLE_COUNT,historical_status:'validated',november_rows:PEOPLE_COUNT,november_status:'confirmed',december_rows:PEOPLE_COUNT,december_status:'draft',payroll_batches:6,
      legacy_companies:legacyOrgIds.length,legacy_people:personMap.size,legacy_employments:legacyEmploymentIds.length,legacy_schedules:schedules.length,training_enrollments:enrollmentCount,payments_executed:0},
    notice:'全虚构测试工作区已建立：内地CNY、香港HKD独立绩效与工资，不混币种或作汇率换算；同人履历贯通。各地区已选周期和11月工资锁定，对照周期及12月工资可编辑。兼容排班培训已显式桥接并仅授权这些测试组织/主体；没有真实资料或付款。'};
  await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data) VALUES($1,'seed','test_workspace',$2,$3::jsonb)`,[userId,gid,JSON.stringify(result)]);
  return result;
}
