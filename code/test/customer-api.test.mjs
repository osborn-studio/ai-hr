// HTTP regression: confirmed performance -> payroll input -> calculation -> lock.
// Synthetic data only. DATABASE_URL must point to a disposable empty database.
import assert from 'node:assert/strict';
import { createApp } from '../app/server.mjs';
import { hashPassword } from '../app/services/auth.mjs';
const {server,db}=await createApp();
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;let token;let passed=0;
const check=(name,value)=>{assert.ok(value,name);passed++;console.log('PASS '+name);};
async function req(path,{method='GET',body,status=200,auth=true}={}){
  const r=await fetch(base+path,{method,headers:{...(auth&&token?{authorization:`Bearer ${token}`} :{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const value=await r.json();assert.equal(r.status,status,`${method} ${path}: ${JSON.stringify(value)}`);passed++;return value;
}
try{
  const password='SyntheticHttp2026';
  await db.query("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES(1000,'http_tester','合成接口验收')");
  await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason) VALUES(1000,10,(SELECT min(id) FROM sys_data_scope),current_date,'ROLE','synthetic HTTP fixture')");
  await db.query('SELECT fn_credential_set(1000,$1)',[hashPassword(password)]);
  token=(await req(`/login?user=1000&pwd=${password}`,{method:'POST',auth:false})).token;
  await req('/api/customer-payroll/batches',{auth:false,status:401});
  await req('/api/foundation/demo-seed',{method:'POST',body:{}});
  const boot=await req('/api/foundation/bootstrap');const g=boot.groups[0],p=boot.people[0],grade=boot.grades[0],e=boot.employments.find(e=>e.status==='active'),co=boot.companies.find(c=>c.id===e.company_id);
  const cycle=(await req('/api/customer-performance/cycles',{method:'POST',body:{group_id:g.id,company_ids:[co.id],code:'HTTP-11',name:'合成11月考核',start_date:'2026-11',end_date:'2026-12',payout_period:'2026-11',currency_code:'HKD',region_code:'HK'}})).cycle;
  await req(`/api/customer-performance/cycles/${cycle.id}/scheme`,{method:'PUT',body:{rules:{confirmed:true,aggregation:'floor_average_months',payout_assignment:'last_month_employment',score_base:1,score_floor:0,metrics:[{code:'quality',unit:'ratio',method:'direct_deduction'}],rating_bands:[{min_score:0,grade:'C',factor:1}],grade_bases:{[grade.id]:1000}},source_refs:[{sheet:'synthetic',range:'A1:C2'}]}});
  await req(`/api/customer-performance/cycles/${cycle.id}/inputs`,{method:'PUT',body:{company_metrics:[{company_id:co.id,period:'2026-11',metrics:{quality:{value:.1,unit:'ratio',status:'verified'}},source_saved_score:.9}],person_months:[{person_id:p.id,employment_id:e.id,company_id:co.id,period:'2026-11',grade_id:grade.id,eligibility_status:'verified',source_saved_amount:900}],responsibilities:[]}});
  const calc=await req(`/api/customer-performance/cycles/${cycle.id}/calculate`,{method:'POST',body:{}});
  check('绩效按独立预期计算900且无阻断',calc.issues.length===0&&Number(calc.results.find(x=>x.kind==='person_bonus').amount)===900);
  await req(`/api/customer-performance/cycles/${cycle.id}/confirm`,{method:'POST',body:{result_version:999,reason:'过期版本'},status:409});
  await req(`/api/customer-performance/cycles/${cycle.id}/confirm`,{method:'POST',body:{result_version:calc.cycle.result_version,reason:'合成来源与900奖金逐项核对'}});
  const candidates=await req(`/api/customer-performance/cycles/${cycle.id}/payroll-candidates`);
  check('确认后输出唯一工资候选',candidates.candidates.length===1&&candidates.candidates[0].amount===900);
  const b=(await req('/api/customer-payroll/batches',{method:'POST',body:{group_id:g.id,period:'2026-11',currency:'HKD',region_code:'HK',kind:'calculated',label:'合成新月工资',rows:[{source_key:'SYNTHETIC-1',source_person_name:'合成测试人员',source_company_name:'合成门店',person_id:p.id,company_id:co.id,employment_id:e.id,data_kind:'inputs',inputs:{base_salary:1000},items:[],source_totals:{}}]}})).batch;
  const applied=await req(`/api/customer-payroll/batches/${b.id}/performance`,{method:'POST',body:{cycle_id:cycle.id}});
  check('确认奖金落入工资输入',applied.applied?.length===1);
  const again=await req(`/api/customer-payroll/batches/${b.id}/performance`,{method:'POST',body:{cycle_id:cycle.id}});
  check('重复导入不会重复加奖金',again.applied?.length===0&&again.already_applied?.length===1);
  const rules=[{code:'base_pay',name:'合成基本工资',kind:'earning',expression:'base_salary'},{code:'performance',name:'合成绩效奖金',kind:'earning',expression:'performance_bonus'}];
  const draft=(await req('/api/customer-payroll/rules',{method:'POST',body:{group_id:g.id,currency:'HKD',region:'HK',name:'合成规则草稿',rules,status:'draft'}})).ruleset;
  await req(`/api/customer-payroll/batches/${b.id}/calculate`,{method:'POST',body:{ruleset_id:draft.id}});
  await req(`/api/customer-payroll/batches/${b.id}/confirm`,{method:'POST',body:{},status:422});
  const approved=(await req('/api/customer-payroll/rules',{method:'POST',body:{group_id:g.id,currency:'HKD',region:'HK',name:'合成批准规则',rules,status:'approved',approval_ack:true,policy_notes:'仅合成数据回归：1000基本工资与900已确认奖金，不包含法定工资政策假设'}})).ruleset;
  await req(`/api/customer-payroll/batches/${b.id}/calculate`,{method:'POST',body:{ruleset_id:approved.id}});
  const report=await req(`/api/customer-payroll/batches/${b.id}/report`);
  check('HTTP完整链实发1900，未重复奖金',report.summary.net_pay==='1900.00'&&report.rows.length===1&&report.rows[0].result.items.length===2);
  await req(`/api/customer-payroll/batches/${b.id}/validate`,{method:'POST',body:{}});
  await req(`/api/customer-payroll/batches/${b.id}/confirm`,{method:'POST',body:{}});
  await req(`/api/customer-payroll/batches/${b.id}/calculate`,{method:'POST',body:{ruleset_id:approved.id},status:409});
  for(const [path,type] of [[`/api/customer-payroll/batches/${b.id}/export.csv`,'text/csv'],[`/api/customer-payroll/batches/${b.id}/print.html`,'text/html'],[`/api/customer-performance/cycles/${cycle.id}/export.csv`,'text/csv']]){
    const r=await fetch(base+path,{headers:{authorization:`Bearer ${token}`}}),text=await r.text();check('受控导出 '+type,r.status===200&&r.headers.get('content-type').includes(type)&&text.length>50&&r.headers.get('cache-control')==='no-store');
  }
  for(const path of ['/api/customer-payroll/rule-catalog','/api/customer-payroll/input-template'])await req(`${path}?group_id=${g.id}`);
  await req(`/api/customer-payroll/batches?group_id=${g.id}&company_id=${co.id}`);
  await req(`/api/customer-performance/cycles?group_id=${g.id}&company_id=${co.id}`);
  const entity=await req('/api/foundation/bridge/entities',{method:'POST',body:{company_id:co.id,name:'纯虚构法定主体（接口测试）有限公司',credit_code:'TEST-ENTITY-001'}});
  check('主体自动编号且保留明确名称',Number(entity.row.id)>1&&entity.row.name==='纯虚构法定主体（接口测试）有限公司');
  const tr=await fetch(base+'/api/foundation/import/template.xlsx',{headers:{authorization:`Bearer ${token}`}});
  check('花名册模板可下载',tr.status===200&&tr.headers.get('content-type').includes('spreadsheetml'));
  const importInput={group_id:g.id,ledger_id:co.ledger_id,filename:'synthetic-roster.xlsx',content_base64:Buffer.from(await tr.arrayBuffer()).toString('base64')};
  const preview=await req('/api/foundation/import/preview',{method:'POST',body:importInput});
  check('模板原生预检只含虚构人且待显式映射',preview.rows.length===1&&preview.rows[0].full_name==='虚构员工甲'&&!preview.can_commit);
  const mapped={...importInput,company_mapping:{'虚构星河店':{create:true}}};
  await req('/api/foundation/import/commit',{method:'POST',body:mapped,status:422});
  const imported=await req('/api/foundation/import/commit',{method:'POST',body:{...mapped,review_ack:true}});
  check('显式导入创建身份雇佣且无伪造岗位部门',imported.stats.identities_created===1&&imported.stats.employments_created===1);
  const repeated=await req('/api/foundation/import/commit',{method:'POST',body:{...mapped,review_ack:true}});
  check('同文件再次导入幂等',repeated.already_imported===true);
  const hkBrand=(await req('/api/foundation/brands',{method:'POST',body:{group_id:g.id,code:'HTTP-HK',name:'虚构香港业务',region_code:'HK',currency_code:'HKD'}})).row;
  const hkLedger=(await req('/api/foundation/ledgers',{method:'POST',body:{group_id:g.id,brand_id:hkBrand.id,scope_mode:'brand',code:'HTTP-HK',name:'虚构香港帐套'}})).row;
  const hkCompany=(await req('/api/foundation/companies',{method:'POST',body:{group_id:g.id,brand_id:hkBrand.id,ledger_id:hkLedger.id,code:'HTTP-HK-01',name:'虚构香港一店'}})).row;
  const hourData={company_id:hkCompany.id,employment_start:'2026-08-31',as_of:'2026-09-27',continuous_service_verified:true,
    weekly_hours:['2026-08-31','2026-09-07','2026-09-14','2026-09-21'].map((week_start,i)=>({week_start,qualifying_hours:[20,20,20,8][i],verified:true,employer_key:'SYNTHETIC-EMPLOYER'}))};
  const hr=await req('/api/hk-tools/continuous-contract',{method:'POST',body:hourData});
  check('香港工时HTTP按17/68规则计算',hr.ready&&hr.hours_condition_met===true&&hr.company.currency_code==='HKD');
  await req('/api/hk-tools/continuous-contract',{method:'POST',body:{...hourData,company_id:co.id},status:422});
  const wageHistory=Array.from({length:12},(_,i)=>({period:new Date(Date.UTC(2025,10+i,1)).toISOString().slice(0,7),wages:10000,excluded_days:0,excluded_wages:0,verified:true}));
  const adw=await req('/api/hk-tools/average-daily-wage',{method:'POST',body:{company_id:hkCompany.id,entitlement_date:'2026-11-15',hire_date:'2020-01-01',history:wageHistory,benefit_type:'annual_leave',paid_days:2,eligibility_verified:true}});
  check('香港平均日薪HTTP保留独立预期657.53',adw.ready&&Number(adw.benefit_amount)===657.53&&adw.window_from==='2025-11-01');
  console.log(`客户业务HTTP · ${passed} 条通过 · 驱动 ${db.driver}`);
}finally{await new Promise(r=>server.close(r));await db.close();}
