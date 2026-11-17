// Only build typed commands. Wage amounts and statutory results come from the server.
export const list=v=>Array.isArray(v)?v:[];
export const PAYROLL_SYSTEMS=[['CN_PAYROLL','中国内地','CNY'],['HK_PAYROLL','中国香港','HKD']];
export const PAYROLL_CATEGORIES={cash_earnings:'现金应发',reimbursement:'报销往来',personal_deduction:'个人扣项',employee_withholding:'个人代扣',employer_cost:'雇主成本',noncash_shadow:'非现金参考',statistical_base:'基数参考',agency_funds:'代发资金',restricted_payment_funds:'限制付款',procurement_service:'采购服务'};
export const PAYROLL_STATES={draft:'草稿',calculated:'已预演',reviewed:'已复核',adopted:'已采用',confirmed:'已确认',cancelled:'已取消',approved:'已批准',superseded:'历史版本',not_applicable:'不适用',confirmed_zero:'已核为0',pending_review:'待核',unavailable_not_installed:'未配置',reserved:'已占用',released:'已释放'};
export const CONFIG_NAMES={systems:'公司算薪体系',relationship:'雇主与发薪主体',profile:'人员工资参数',rulebook:'工资项目方案',wage_calendar:'平均工资日历',formula_proposal:'公式与代码提案',policy:'薪税政策版本',enrollment:'人员薪税资格',opening:'累计期初核定',batch_period:'支付与税供款期间'};
export const SOURCE_NAMES={salary_profile:'工资档案',time_report:'考勤核定',leave_cash:'假期与加班酬金',people_candidate:'费用与福利',performance_result:'历史绩效奖金',performance_award:'绩效与奖金',training_award:'培训与岗位资格薪酬'};
export const systemName=v=>PAYROLL_SYSTEMS.find(x=>x[0]===v)?.[1]||v||'—';
export const moneyText=(v,state)=>state==='not_applicable'?'不适用':v===undefined?'—':v===null||v===''?'待核':String(v);
export function payrollQuery(scope,filter={}){return Object.fromEntries(Object.entries({...scope,...filter}).filter(([k,v])=>['group_id','company_id','ledger_id','view','period','system','q','page','page_size','batch_id','kind','person_id','employment_id','domain','status'].includes(k)&&v!==undefined&&v!==null&&v!==''));}
export function sourceKey(s){return `${s.domain}:${s.id}:${s.employment_id||''}`;}
export function previewInput(batch,selections,enrollmentIds=[]){
 if(!batch?.id)throw new Error('先选择实际工资批次');const people=new Map(),reports=new Map(),sources=[],seen=new Set();
 for(const s of selections){const key=sourceKey(s);if(seen.has(key))continue;seen.add(key);if(!s.id||!s.domain)throw new Error('来源指针不完整');
  if(s.currency&&s.currency!==batch.currency)throw new Error('所选来源币种与批次不一致');
  if(s.company_id&&String(s.company_id)!==String(batch.company_id))throw new Error('请选择本发薪公司的实际来源');
  if(s.domain==='salary_profile'){if(people.has(String(s.employment_id)))throw new Error('同一雇佣只能选一个当前工资档案');people.set(String(s.employment_id),{employment_id:s.employment_id,profile_id:s.id});}
  else if(s.domain==='time_report'){if(reports.has(String(s.employment_id)))throw new Error('同一雇佣月份只能选一个当前考勤版本');reports.set(String(s.employment_id),s.id);}
  else sources.push({domain:s.domain,id:s.id,...(s.employment_id?{employment_id:s.employment_id}:{})});
 }
 for(const[e,report]of reports){if(!people.has(e))throw new Error('考勤核定须与同一真实雇佣的工资档案一起选择');people.get(e).report_id=report;}
 if(!people.size&&!sources.length)throw new Error('至少选择一个真实工资来源');
 return{batch_id:batch.id,expected_revision:batch.revision,employments:[...people.values()],sources,statutory:{enrollment_ids:[...new Set(enrollmentIds.map(String))]}};
}
export function monthlyWindow(month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))throw new Error('请选择工资月');const[y,m]=month.split('-').map(Number);return{from:month+'-01',to:new Date(Date.UTC(y,m,1)).toISOString().slice(0,10)};}
export function currentConfigs(rows,{kind,companyId,system,employmentId,period}={}){const window=period?monthlyWindow(period):null,by=new Map();for(const r of list(rows)){if(r.status!=='approved'||kind&&r.kind!==kind||companyId&&String(r.company_id)!==String(companyId)||system&&r.system!==system||employmentId&&String(r.employment_id)!==String(employmentId))continue;if(window&&(String(r.valid_from).slice(0,10)>window.from||r.valid_to&&String(r.valid_to).slice(0,10)<window.to))continue;const key=r.stable_key||`${r.kind}:${r.employment_id||r.company_id}:${r.system}`;if(!by.has(key)||Number(by.get(key).revision)<Number(r.revision))by.set(key,r);}return[...by.values()];}
export function exactInput(v,name='金额'){const s=String(v??'').trim();if(!/^-?\d{1,24}(\.\d{1,12})?$/.test(s))throw new Error(name+'须为明确十进制数，未知不能填0');return s;}
export function profileData(rows){const parameters={};for(const r of rows){if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(r.key||''))throw new Error('参数编码需为字母、数字及下划线');if(parameters[r.key])throw new Error('参数编码重复');parameters[r.key]={value:exactInput(r.value,r.key),unit:r.unit||'currency_amount'};}if(!rows.length)throw new Error('请填写工资参数');return{parameters};}
export function rulebookData(inputs,rules,sourceTreatments={}){const map={};for(const r of inputs){if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(r.key||'')||map[r.key])throw new Error('输入变量编码无效或重复');map[r.key]={unit:r.unit||'currency_amount',source:r.source||'profile',...(r.source==='time_report'?{metric:r.source_key||r.key}:{key:r.source_key||r.key})};}if(!rules.length)throw new Error('请至少选择一个工资项目');return{inputs:map,rules:rules.map(r=>{if(!r.code||!String(r.formula||'').trim())throw new Error('项目与公式不可为空');return{code:r.code,formula:r.formula,unit:r.unit||'currency_amount',wage_tags:{hk_adw:r.hk_adw||'pending_review',cn_average:r.cn_average||'pending_review',cn_annual_leave:r.cn_annual_leave||'pending_review',ordinary_wage:r.ordinary_wage||'pending_review'}};}),native_statutory:true,currency_rounding:'half_up_2',statutory_requirements:[],source_treatments:sourceTreatments};}
export function parseCalendarCsv(source){const rows=[];let row=[],cell='',quoted=false;for(let i=0;i<source.length;i++){const c=source[i];if(c==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(!quoted&&(c===','||c==='\n')){row.push(cell);cell='';if(c==='\n'){rows.push(row);row=[];}}else if(c!=='\r')cell+=c;}if(quoted)throw new Error('CSV引号未闭合');if(cell||row.length){row.push(cell);rows.push(row);}const header=(rows.shift()||[]).map(v=>v.replace(/^\uFEFF/,'').trim());const required=['date','eligible_wages','excluded_wages','excluded_days','ordinary_wages'];if(required.some(k=>!header.includes(k)))throw new Error('文件缺少日期、计入工资或排除字段');const days=rows.filter(r=>r.some(Boolean)).map(r=>{const x=Object.fromEntries(header.map((k,i)=>[k,r[i]||'']));if(!/^\d{4}-\d{2}-\d{2}$/.test(x.date))throw new Error('日历日期格式需YYYY-MM-DD');for(const k of required.slice(1))x[k]=exactInput(x[k],k);return x;});if(!days.length||new Set(days.map(d=>d.date)).size!==days.length)throw new Error('日历为空或日期重复');return{days};}

export const autoStatutoryCode=code=>/^CN_(IIT_WITHHOLD|EMP_(PENSION|MEDICAL|UNEMPLOYMENT|HOUSING_FUND)|ER_(PENSION|MEDICAL|UNEMPLOYMENT|WORK_INJURY|MATERNITY|HOUSING_FUND))$/.test(code)||/^HK_(EMP|ER)_MPF_MANDATORY$/.test(code);

export const fictionalPolicyExample=row=>row?.policy_values==='wholly_fictional_not_current_legal_baseline'||row?.data?.policy_values==='wholly_fictional_not_current_legal_baseline'||String(row?.stable_key||'').startsWith('TY-NATIVE-PAYROLL-DEMO-202610-V1:')||/^全虚构10月.*工资（原生）$/.test(row?.label||'');
export const FICTIONAL_POLICY_NOTICE='演示参数方案，非现行法规标准。正式核算请使用按生效日核准的标准政策，并核实人员资格与工时。';

export const payrollDisplayLabel=row=>/^全虚构10月.*工资（原生）$/.test(row?.label||'')?`${String(row.period||'2026-10').slice(0,7)} · ${row.company_name||'工资核算'}${row.company_name?'工资':''}`:row?.label||'';

export const standardPolicyExample=row=>row?.policy_values==='official_parameters_with_reviewed_demo_qualifications'||row?.data?.policy_values==='official_parameters_with_reviewed_demo_qualifications';
export const STANDARD_POLICY_NOTICE='演示帐套：法定参数按地区与生效日期核准；人员资格、单位核定表和业务金额为演示业务凭据。工资确认不等于付款、申报或缴费。';
