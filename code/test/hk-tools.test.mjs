// Entirely fictional hours and wages; independent expected values are explicit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDb } from '../app/db.mjs';
const db=await createDb({url:process.env.DATABASE_URL||undefined});let passed=0;
const check=(label,value)=>{assert.ok(value,label);passed++;console.log('PASS '+label);};
const call=async(fn,input)=>(await db.query(`SELECT ${fn}($1::jsonb) r`,[JSON.stringify(input)])).rows[0].r;
const plus=(s,n)=>new Date(Date.parse(s+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const hours=(values,start='2026-07-06')=>({employment_start:start,as_of:plus(start,values.length*7-1),continuous_service_verified:true,
 weekly_hours:values.map((v,i)=>({week_start:plus(start,i*7),qualifying_hours:v,employer_key:'TEST-EMPLOYER',verified:true}))});
async function reject(label,fn){await assert.rejects(fn,e=>e.code==='23514');passed++;console.log('PASS '+label);}
try{
 await db.exec(readFileSync(new URL('../db/203_tyhr_hong_kong_calculators.sql',import.meta.url),'utf8'));
 check('2026每周17小时边界',(await call('fn_ty_hk_hours_condition',hours([17,17,17,17]))).hours_condition_met===true);
 check('2026四周68小时边界',(await call('fn_ty_hk_hours_condition',hours([20,20,20,8]))).hours_condition_met===true);
 check('67.99小时不冒充68',(await call('fn_ty_hk_hours_condition',hours([20,20,20,7.99]))).hours_condition_met===false);
 check('新雇佣首三周不借用468绕过',(await call('fn_ty_hk_hours_condition',hours([16,20,20,20]))).hours_condition_met===false);
 check('不足四周不满足条件',(await call('fn_ty_hk_hours_condition',hours([30,30,30]))).hours_condition_met===false);
 const old=hours([18,18,18,18],'2025-11-03');check('旧期间仍18小时',(await call('fn_ty_hk_hours_condition',old)).hours_condition_met===true);
 old.weekly_hours[0].qualifying_hours=17.99;check('不把新17小时追溯旧期间',(await call('fn_ty_hk_hours_condition',old)).hours_condition_met===false);
 const unknown=hours([20,20,20,8]);unknown.weekly_hours[1].verified=false;
 check('未核验工时保持未知',(await call('fn_ty_hk_hours_condition',unknown)).hours_condition_met===null);
 const continuity=hours([20,20,20,20]);continuity.continuous_service_verified=false;
 check('同雇主连续受雇未核验不下结论',(await call('fn_ty_hk_hours_condition',continuity)).hours_condition_met===null);
 const other=hours([20,20,20,20]);other.weekly_hours[2].employer_key='OTHER';
 await reject('不同法定雇主不得拼接',()=>call('fn_ty_hk_hours_condition',other));
 const gap=hours([20,20,20,20]);gap.weekly_hours[1].week_start=plus(gap.weekly_hours[1].week_start,1);
 await reject('周记录缺口拒绝',()=>call('fn_ty_hk_hours_condition',gap));
 const transition=hours([20,20,20,20],'2025-12-22');check('生效日跨周明确未就绪',!(await call('fn_ty_hk_hours_condition',transition)).ready);
 const avg={entitlement_date:'2026-11-15',hire_date:'2020-01-01',benefit_type:'annual_leave',paid_days:2,eligibility_verified:true,
 history:Array.from({length:12},(_,i)=>({period:new Date(Date.UTC(2025,10+i,1)).toISOString().slice(0,7),wages:10000,excluded_days:0,excluded_wages:0,verified:true}))};
 let r=await call('fn_ty_hk_average_daily_wage',avg);
 check('前12个完整历月而非滚动365日',r.window_from==='2025-11-01'&&r.window_to_exclusive==='2026-11-01'&&r.eligible_days===365);
 check('平均日薪及年假金额独立核对',Number(r.average_daily_wage)===328.76712329&&Number(r.benefit_amount)===657.53);
 r=await call('fn_ty_hk_average_daily_wage',{...avg,benefit_type:'sickness',paid_days:4});
 check('疾病津贴80%按未舍入日薪算总额',Number(r.benefit_amount)===1052.05);
 const excluded=structuredClone(avg);excluded.history[0].excluded_days=2;excluded.history[0].excluded_wages=500;
 r=await call('fn_ty_hk_average_daily_wage',excluded);check('天数与对应工资同时排除',r.eligible_days===363&&r.eligible_wages===119500&&Number(r.benefit_amount)===658.40);
 r=await call('fn_ty_hk_average_daily_wage',{...avg,hire_date:'2026-08-16',history:avg.history.slice(-3).map((v,i)=>({...v,wages:i===0?8000:10000}))});
 check('受雇不足12月及首月部分天数',r.window_from==='2026-08-16'&&r.eligible_days===77&&r.eligible_wages===28000);
 r=await call('fn_ty_hk_average_daily_wage',{...avg,history:avg.history.slice(1)});check('缺月不能当零工资',r.ready===false&&r.average_daily_wage===null);
 r=await call('fn_ty_hk_average_daily_wage',{...avg,history:[...avg.history,avg.history[0]]});check('重复月不能重复加总',r.ready===false&&r.average_daily_wage===null);
 const unverified=structuredClone(avg);unverified.history[3].verified=false;
 check('未核验历史保持未就绪',!(await call('fn_ty_hk_average_daily_wage',unverified)).ready);
 r=await call('fn_ty_hk_average_daily_wage',{...avg,eligibility_verified:false});check('平均工资与假种资格分开',r.ready&&r.benefit_amount===null&&!r.benefit_ready);
 r=await call('fn_ty_hk_average_daily_wage',{...avg,history:avg.history.map(v=>({...v,wages:0}))});check('真实0工资保留0结果',r.ready&&Number(r.average_daily_wage)===0&&Number(r.benefit_amount)===0);
 r=await call('fn_ty_hk_average_daily_wage',{...avg,paid_days:0});check('0天与缺天数不同',r.benefit_ready&&Number(r.benefit_amount)===0);
 const excessive=structuredClone(avg);excessive.history[0].excluded_days=100;
 await reject('超范围排除天数拒绝',()=>call('fn_ty_hk_average_daily_wage',excessive));
 await reject('无效日期明确拒绝',()=>call('fn_ty_hk_average_daily_wage',{...avg,entitlement_date:'2026-02-30'}));
 console.log(`香港核验工具 · ${passed} 条通过 · 驱动 ${db.driver}`);
}finally{await db.close();}
