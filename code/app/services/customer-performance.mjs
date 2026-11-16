// The workbook supplies evidence; only explicitly verified rules and identities
// participate in calculation. Transaction ownership remains with runRead/runWrite.
import { bizErr } from '../errors.mjs';
import { accessFor } from './foundation.mjs';
import { csv } from '../csv.mjs';
import { readXlsx } from '../xlsx.mjs';
import { companyLocale,regionCode } from './payroll-jurisdiction.mjs';
import { inspectSourcePerformance,mapSourcePerformance } from './customer-performance-import.mjs';

export const RESOURCES = { cycle: 'perf_cycle' };
const eq = (a,b) => String(a)===String(b);
const bad = message => { throw bizErr('E_TY_ARGUMENT',message); };
const deny = message => { throw bizErr('E_TY_FORBIDDEN',message||'需要绩效岗位权限及考核公司的基础范围授权'); };
const missing = () => { throw bizErr('E_TY_NOT_FOUND','考核周期不存在或不在授权范围'); };
const id = (v,label='编号') => {
  if(!Number.isSafeInteger(Number(v)) || Number(v)<=0) bad(`${label}必须是正整数`);
  return Number(v);
};
const date = v => v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const month = v => {
  const s=String(v??'');
  if(!/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/.test(s)) bad('月份格式应为 YYYY-MM，且必须为有效月份');
  return s.slice(0,7)+'-01';
};
function obj(v,label='数据') { if(!v||typeof v!=='object'||Array.isArray(v)) bad(`${label}必须是对象`); return v; }
function array(v,label) { if(!Array.isArray(v)||v.length>10000) bad(`${label}必须是最多10000行的数组`);return v; }
function text(v,label) { if(typeof v!=='string'||!v.trim()||v.length>500) bad(`${label}应为1至500字文本`);return v.trim(); }
const json=v=>JSON.stringify(v);
const q=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows;

async function access(tx,userId,action) {
  if(!(await q(tx,'SELECT fn_role_can($1,$2,$3) ok',[userId,RESOURCES.cycle,action]))[0]?.ok) deny(`当前角色没有绩效${action==='write'?'修改':'查看'}权限`);
  return accessFor(tx,userId);
}
async function context(tx,{userId,cycleId,groupId,ledgerId,companyId},action='read',whole=false,lock=false) {
  const optional=(value,label)=>(value===null||value===undefined||value==='')?null:id(value,label);
  const gid=optional(groupId,'集团编号'),lid=optional(ledgerId,'帐套编号'),cid=optional(companyId,'公司编号');
  const a=await access(tx,userId,action);
  const cycle=(await q(tx,`SELECT * FROM ty_perf_cycle WHERE id=$1${lock?' FOR UPDATE':''}`,[id(cycleId,'周期编号')]))[0];
  if(!cycle||(gid&&!eq(gid,cycle.group_id))) missing();
  const companies=await q(tx,`SELECT c.* FROM ty_perf_cycle_company pc JOIN ty_company c ON c.id=pc.company_id WHERE pc.cycle_id=$1 ORDER BY c.id`,[cycle.id]);
  const visible=companies.filter(c=>a.row({...c,company_id:c.id},action==='write')
    &&(!lid||eq(lid,c.ledger_id))&&(!cid||eq(cid,c.id)));
  if(!visible.length) missing();
  if(whole&&visible.length!==companies.length) deny('此操作需要整个考核周期所有公司的写权限和完整公司上下文；不能用局部帐套或公司范围修改全体结果');
  return {a,cycle,companies,visible,full:visible.length===companies.length};
}
function publicCycle(c,full) {
  const out={...c,start_date:date(c.start_date),end_date:date(c.end_date),payout_period:date(c.payout_period).slice(0,7)};
  if(!full) { out.rules={};out.source_refs=[];out.confirmation_note=null; }
  return out;
}
function numeric(v,label,{nullable=false,min=-Infinity,max=Infinity}={}) {
  if((v===null||v===undefined||v==='')&&nullable)return null;
  if(typeof v==='boolean'||v===null||v===undefined||v===''||!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max) bad(`${label}数值无效`);
  return Number(v);
}
function validateRules(r,grades,partial=false,depth=0) {
  obj(r,'方案规则');if(depth>3)bad('方案覆盖层级过深');
  if(r.confirmed!==undefined&&typeof r.confirmed!=='boolean')bad('confirmed必须是真或假');
  for(const k of ['score_base','score_floor','score_tolerance','amount_tolerance']) if(r[k]!==undefined)numeric(r[k],k,{min:0});
  if(r.metrics!==undefined) {
    const seen=new Set();
    for(const m of array(r.metrics,'指标')) {
      obj(m,'指标');text(m.code,'指标编码');text(m.unit,'指标单位');
      if(seen.has(m.code))bad('指标编码不可重复');seen.add(m.code);
      if(!['deduction_bands','target_attainment','direct_deduction'].includes(m.method))bad('不支持的指标算法');
      if(m.weight!==undefined)numeric(m.weight,'指标权重',{min:0});
      if(m.method!=='direct_deduction') for(const b of array(m.bands,'指标阈值')) {
        obj(b,'阈值');if(b.min!==undefined)numeric(b.min,'阈值下限');if(b.max!==undefined)numeric(b.max,'阈值上限');
        if(b.min!==undefined&&b.max!==undefined&&Number(b.min)>=Number(b.max))bad('阈值下限须小于上限');numeric(b.deduction,'扣分',{min:0});
      }
    }
  }
  if(r.rating_bands!==undefined) {
    const seen=new Set();
    for(const b of array(r.rating_bands,'评级档位')) {
      obj(b,'评级');numeric(b.min_score,'最低分');text(b.grade,'评级');numeric(b.factor,'奖金系数',{min:0});
      if(seen.has(Number(b.min_score)))bad('评级最低分不可重复');seen.add(Number(b.min_score));
    }
  }
  if(r.grade_bases!==undefined)for(const [key,value] of Object.entries(obj(r.grade_bases,'职级基数'))) {
    if(!grades.some(g=>eq(g.id,key)))bad('奖金基数引用了其他集团或不存在的职级');numeric(value,'职级奖金基数',{min:0});
  }
  if(r.month_overrides!==undefined)for(const [key,v] of Object.entries(obj(r.month_overrides,'月度规则'))) {month(key);validateRules(v,grades,true,depth+1);}
  if(r.company_overrides!==undefined)for(const v of Object.values(obj(r.company_overrides,'公司规则')))validateRules(v,grades,true,depth+1);
  if(r.management!==undefined)validateRules(obj(r.management,'管理责任规则'),grades,true,depth+1);
}

export async function listCycles(tx,{userId,groupId,ledgerId,companyId}={}) {
  const a=await access(tx,userId,'read');
  const rows=await q(tx,'SELECT * FROM ty_perf_cycle ORDER BY start_date DESC,id DESC');
  const owned=await q(tx,'SELECT pc.cycle_id,c.* FROM ty_perf_cycle_company pc JOIN ty_company c ON c.id=pc.company_id ORDER BY c.id');
  const cycles=[];
  for(const c of rows) {
    if(groupId&&!eq(groupId,c.group_id))continue;
    const all=owned.filter(v=>eq(v.cycle_id,c.id));
    const visible=all.filter(v=>a.row({...v,company_id:v.id})&&(!ledgerId||eq(ledgerId,v.ledger_id))&&(!companyId||eq(companyId,v.id)));
    if(!visible.length)continue;
    const full=visible.length===all.length;
    cycles.push({...publicCycle(c,full),company_ids:visible.map(v=>v.id),visible_company_count:visible.length,partial_scope:!full,
      can_write:full&&all.every(v=>a.row({...v,company_id:v.id},true))&&!!(await q(tx,'SELECT fn_role_can($1,$2,$3) ok',[userId,RESOURCES.cycle,'write']))[0]?.ok});
  }
  return {cycles};
}

export async function createCycle(tx,{userId,input}) {
  obj(input);const a=await access(tx,userId,'write');const gid=id(input.group_id,'集团编号');
  const ids=[...new Set(array(input.company_ids,'公司清单').map(v=>id(v,'公司编号')))];if(!ids.length)bad('请选择考核公司');
  const companies=await q(tx,'SELECT * FROM ty_company WHERE id=ANY($1::bigint[])',[ids]);
  if(companies.length!==ids.length||companies.some(c=>!eq(c.group_id,gid)))bad('公司与集团不一致');
  if(companies.some(c=>!a.row({...c,company_id:c.id},true)))deny('创建周期需要所选全部公司的绩效写范围');
  const start=month(input.start_date),end=month(input.end_date),payout=month(input.payout_period);
  const currency=input.currency_code;if(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))bad('请明确选择三个大写字母的绩效币种');
  const locale=await companyLocale(tx,ids,{region:regionCode(input.region_code),currency});
  const cycle=(await q(tx,`INSERT INTO ty_perf_cycle(group_id,code,name,start_date,end_date,payout_period,currency_code,created_by,region_code)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[gid,text(input.code,'周期编码'),text(input.name,'周期名称'),start,end,payout,currency,userId,locale.region_code]))[0];
  for(const cid of ids)await tx.query('INSERT INTO ty_perf_cycle_company(cycle_id,company_id) VALUES($1,$2)',[cycle.id,cid]);
  await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data) VALUES($1,'create','performance',$2,$3::jsonb)`,[userId,cycle.id,json({company_ids:ids,code:cycle.code})]);
  return {cycle:publicCycle((await q(tx,'SELECT * FROM ty_perf_cycle WHERE id=$1',[cycle.id]))[0],true)};
}

export async function saveScheme(tx,{userId,cycleId,input,...scope}) {
  obj(input);const ctx=await context(tx,{userId,cycleId,...scope},'write',true,true);
  if(input.region_code&&ctx.cycle.region_code&&regionCode(input.region_code)!==ctx.cycle.region_code)bad('既有绩效地区不能直接变更，请建立新周期');
  const locale=await companyLocale(tx,ctx.companies.map(c=>c.id),{region:regionCode(input.region_code)??ctx.cycle.region_code,currency:ctx.cycle.currency_code});
  if(!ctx.cycle.region_code&&locale.region_code)await tx.query('UPDATE ty_perf_cycle SET region_code=$2 WHERE id=$1',[ctx.cycle.id,locale.region_code]);
  const rules=obj(input.rules,'方案规则');const grades=await q(tx,'SELECT id FROM ty_grade WHERE group_id=$1',[ctx.cycle.group_id]);validateRules(rules,grades);
  if(rules.company_overrides&&Object.keys(rules.company_overrides).some(k=>!ctx.companies.some(c=>eq(c.id,k))))bad('公司例外只能引用周期内公司');
  const refs=input.source_refs===undefined?ctx.cycle.source_refs:array(input.source_refs,'来源指针');
  const cycle=(await q(tx,'UPDATE ty_perf_cycle SET rules=$2::jsonb,source_refs=$3::jsonb,confirmation_note=$4 WHERE id=$1 RETURNING *',
    [ctx.cycle.id,json(rules),json(refs),input.confirmation_note??null]))[0];
  await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data) VALUES($1,'scheme','performance',$2,$3::jsonb)`,[userId,cycle.id,json({input_revision:cycle.input_revision,rules})]);
  return {cycle:publicCycle(cycle,true)};
}

function inputRow(kind,row) {
  obj(row);const out={company_id:id(row.company_id,'公司编号'),period:month(row.period)};
  if(kind==='company_metrics')return {...out,metrics:obj(row.metrics,'指标值'),source_saved_score:numeric(row.source_saved_score,'源分数',{nullable:true}),source_ref:row.source_ref??{}};
  out.person_id=id(row.person_id,'人员编号');
  if(kind==='responsibilities')return {...out,weight:numeric(row.weight,'责任权重',{min:0.0000001,max:1}),status:row.status||'unverified',source_ref:row.source_ref??{}};
  return {...out,employment_id:id(row.employment_id,'雇佣编号'),grade_id:id(row.grade_id,'职级编号'),score_source:row.score_source||'company',
    eligibility_weight:numeric(row.eligibility_weight??1,'资格折算',{min:0,max:1}),eligibility_status:row.eligibility_status||'unverified',
    bonus_base_override:numeric(row.bonus_base_override,'个人月度基数',{nullable:true,min:0}),bonus_base_status:row.bonus_base_status||'unverified',
    source_saved_score:numeric(row.source_saved_score,'源分数',{nullable:true}),source_saved_amount:numeric(row.source_saved_amount,'源奖金',{nullable:true}),
    source_saved_cycle_amount:numeric(row.source_saved_cycle_amount,'源周期奖金',{nullable:true}),
    source_saved_alternative_cycle_amount:numeric(row.source_saved_alternative_cycle_amount,'源替代方案奖金',{nullable:true}),source_ref:row.source_ref??{}};
}
export async function saveInputs(tx,{userId,cycleId,input,...scope}) {
  obj(input);const ctx=await context(tx,{userId,cycleId,...scope},'write',true,true);const counts={};
  const tables={company_metrics:'ty_perf_company_metric',person_months:'ty_perf_person_month',responsibilities:'ty_perf_responsibility'};
  for(const [kind,table] of Object.entries(tables))if(Object.hasOwn(input,kind)) {
    const rows=array(input[kind],kind).map(row=>inputRow(kind,row));
    if(rows.some(r=>!ctx.companies.some(c=>eq(c.id,r.company_id))))bad('输入包含周期外公司');
    await tx.query(`DELETE FROM ${table} WHERE cycle_id=$1`,[ctx.cycle.id]);
    for(const row of rows) {
      const keys=['cycle_id',...Object.keys(row)];const values=[ctx.cycle.id,...Object.values(row).map(v=>typeof v==='object'&&v!==null?json(v):v)];
      await tx.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,values);
    }
    counts[kind]=rows.length;
  }
  await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data) VALUES($1,'inputs','performance',$2,$3::jsonb)`,[userId,ctx.cycle.id,json(counts)]);
  return {cycle:publicCycle((await q(tx,'SELECT * FROM ty_perf_cycle WHERE id=$1',[ctx.cycle.id]))[0],true),counts};
}
export const saveMetrics=saveInputs;
export const saveAssignments=saveInputs;
export const saveTargets=saveInputs;

export async function report(tx,{userId,cycleId,...scope}) {
  const ctx=await context(tx,{userId,cycleId,...scope});const ids=ctx.visible.map(c=>Number(c.id));const included=v=>ids.some(i=>eq(i,v));
  const results=(await q(tx,`SELECT r.*,p.person_number,p.full_name FROM ty_perf_result r LEFT JOIN ty_person p ON p.id=r.person_id
    WHERE r.cycle_id=$1 AND r.result_version=$2 ORDER BY r.kind,r.period,r.company_id,r.person_id`,[ctx.cycle.id,ctx.cycle.result_version]))
    .filter(r=>included(r.company_id)&&(r.dependencies||[]).every(included)).map(r=>({...r,period:date(r.period).slice(0,7)}));
  const data={};
  for(const [kind,table] of Object.entries({company_metrics:'ty_perf_company_metric',person_months:'ty_perf_person_month',responsibilities:'ty_perf_responsibility'})) {
    data[kind]=(await q(tx,`SELECT * FROM ${table} WHERE cycle_id=$1 AND company_id=ANY($2::bigint[]) ORDER BY period,id`,[ctx.cycle.id,ids])).map(r=>({...r,period:date(r.period).slice(0,7)}));
  }
  if(!ctx.full) {
    const allResponsibilities=await q(tx,'SELECT person_id,period,company_id FROM ty_perf_responsibility WHERE cycle_id=$1',[ctx.cycle.id]);
    data.person_months=data.person_months.filter(v=>v.score_source!=='management'||allResponsibilities
      .filter(s=>eq(s.person_id,v.person_id)&&date(s.period).slice(0,7)===v.period).every(s=>included(s.company_id)));
  }
  // A manager's responsibility rows from other companies are not exposed. The
  // final aggregate is also hidden unless all its dependencies are readable.
  const issues=results.flatMap(r=>(r.issues||[]).map(issue=>({...issue,blocking:r.blocking!==false,result_id:r.id,kind:r.kind,company_id:r.company_id,person_id:r.person_id,period:r.period})));
  const bonuses=results.filter(r=>r.kind==='person_bonus');
  const canWrite=ctx.full&&ctx.companies.every(c=>ctx.a.row({...c,company_id:c.id},true))&&!!(await q(tx,'SELECT fn_role_can($1,$2,$3) ok',[userId,RESOURCES.cycle,'write']))[0]?.ok;
  return {cycle:publicCycle(ctx.cycle,ctx.full),companies:ctx.visible,...data,results,issues,
    totals:{basis:ctx.full?'entire_cycle':'visible_rows_only',visible_people:bonuses.length,ready_people:bonuses.filter(r=>r.amount!==null&&!r.issues.length).length,
      amount:bonuses.reduce((n,r)=>n+(r.amount===null||r.issues.length?0:Number(r.amount)),0)},
    scope:{partial:!ctx.full,can_write:canWrite,can_confirm:canWrite&&ctx.cycle.status==='calculated'&&!issues.some(i=>i.blocking)&&bonuses.length>0}};
}
export async function calculate(tx,{userId,cycleId,...scope}) {
  await context(tx,{userId,cycleId,...scope},'write',true,true);await tx.query('SELECT fn_ty_perf_calculate($1,$2)',[id(cycleId),userId]);return report(tx,{userId,cycleId,...scope});
}
export async function confirm(tx,{userId,cycleId,input,...scope}) {
  obj(input);const ctx=await context(tx,{userId,cycleId,...scope},'write',true,true);
  if(input.region_code&&ctx.cycle.region_code&&regionCode(input.region_code)!==ctx.cycle.region_code)bad('既有绩效地区不能直接变更，请建立新周期');
  const locale=await companyLocale(tx,ctx.companies.map(c=>c.id),{region:regionCode(input.region_code)??ctx.cycle.region_code,currency:ctx.cycle.currency_code,requireRegion:true});
  if(!ctx.cycle.region_code)await tx.query('UPDATE ty_perf_cycle SET region_code=$2 WHERE id=$1',[ctx.cycle.id,locale.region_code]);
  await tx.query('SELECT fn_ty_perf_confirm($1,$2,$3,$4)',[id(cycleId),id(input.result_version,'结果版本'),userId,text(input.reason,'核验依据')]);return report(tx,{userId,cycleId,...scope});
}
export async function setCycleLocale(tx,{userId,cycleId,input,...scope}){
  obj(input);const ctx=await context(tx,{userId,cycleId,...scope},'write',true,true);
  if(ctx.cycle.status==='confirmed')bad('已确认绩效地区不可修改');
  const selected=regionCode(input.region_code,{nullable:false});
  if(ctx.cycle.region_code&&ctx.cycle.region_code!==selected)bad('绩效地区已明确，请建立新周期');
  await companyLocale(tx,ctx.companies.map(c=>c.id),{region:selected,currency:ctx.cycle.currency_code,requireRegion:true});
  const cycle=(await q(tx,'UPDATE ty_perf_cycle SET region_code=$2 WHERE id=$1 RETURNING *',[ctx.cycle.id,selected]))[0];
  await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data) VALUES($1,'set_region','performance',$2,$3::jsonb)`,[userId,cycle.id,json({region_code:selected})]);
  return{cycle:publicCycle(cycle,true)};
}

export async function getPayrollCandidates(tx,{userId,cycleId,period,companyId,...scope}={}) {
  const r=await report(tx,{userId,cycleId,companyId,...scope});if(r.cycle.status!=='confirmed')return {candidates:[],blocked:'PERFORMANCE_NOT_CONFIRMED'};
  const p=period?month(period).slice(0,7):null;
  return {candidates:r.results.filter(v=>v.kind==='person_bonus'&&v.amount!==null&&!v.issues.length&&(!p||p===v.period)&&(!companyId||eq(companyId,v.company_id))).map(v=>({
    cycle_id:r.cycle.id,result_version:r.cycle.result_version,result_id:v.id,person_id:v.person_id,person_number:v.person_number,full_name:v.full_name,
    employment_id:v.employment_id,company_id:v.company_id,period:v.period,amount:Number(v.amount),amount_exact:String(v.amount),currency_code:r.cycle.currency_code,region_code:r.cycle.region_code,
    source_key:`perf:${r.cycle.id}:${r.cycle.result_version}:${v.id}`,
  }))};
}

export async function exportReport(tx,args) {
  const r=await report(tx,args);
  return {filename:`performance_${r.cycle.code}_v${r.cycle.result_version}.csv`,content:csv({columns:[
    {key:'kind',label:'结果类型'},{key:'period',label:'月份'},{key:'company_id',label:'公司编号',numeric:true},{key:'person_number',label:'初始员工编号'},
    {key:'full_name',label:'姓名'},{key:'score',label:'分数',numeric:true},{key:'rating',label:'评级'},{key:'amount',label:'奖金',numeric:true},{key:'issue_count',label:'阻断项数',numeric:true},
  ],rows:r.results.map(v=>({...v,issue_count:v.issues.length}))})};
}

function parseCsv(content) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<content.length;i++) {
    const ch=content[i];if(ch==='"') {if(quoted&&content[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&content[i+1]==='\n')i++;row.push(cell);if(row.some(v=>v!==''))rows.push(row);row=[];cell='';}
    else cell+=ch;
  }
  if(quoted)bad('CSV引号未闭合');if(cell!==''||row.length){row.push(cell);rows.push(row);}return rows;
}
function fileRows(input) {
  if(input.rows!==undefined)return array(input.rows,'导入预览行');
  if(typeof input.content_base64!=='string'||input.content_base64.length>2800000)bad('请提交最多2MB的模板文件或结构化rows');
  const buf=Buffer.from(input.content_base64,'base64');let rows;
  if(/\.xlsx$/i.test(input.filename||'')) {
    // Refuse pathological expansion before using the existing first-sheet reader.
    let total=0;for(let i=0;i+46<=buf.length;i++)if(buf.readUInt32LE(i)===0x02014b50){total+=buf.readUInt32LE(i+24);if(total>20000000)bad('工作簿解压后过大，请使用精简导入模板');}
    try{rows=readXlsx(buf);}catch{bad('无法读取XLSX模板，请确认文件及首张工作表');}
  } else if(/\.csv$/i.test(input.filename||''))rows=parseCsv(buf.toString('utf8').replace(/^\uFEFF/,''));
  else bad('仅支持规范CSV/XLSX模板；原始多表绩效书须先完成明确字段映射');
  if(rows.length<2)bad('模板至少需要表头及一行数据');
  const header=rows.shift().map(v=>String(v).trim());if(!header.includes('record_type'))bad('首表缺少record_type规范表头；原表序号不能自动充当员工编号');
  return array(rows,'导入行').map(row=>Object.fromEntries(header.map((k,i)=>[k,row[i]??''])));
}
export async function importPreview(tx,{userId,cycleId,input,...scope}) {
  obj(input);const ctx=await context(tx,{userId,cycleId,...scope},'write',true);
  const people=await q(tx,'SELECT id,person_number FROM ty_person WHERE group_id=$1',[ctx.cycle.group_id]);
  const grades=await q(tx,'SELECT id,code FROM ty_grade WHERE group_id=$1',[ctx.cycle.group_id]);
  const employments=await q(tx,'SELECT * FROM ty_employment WHERE group_id=$1',[ctx.cycle.group_id]);
  if(input.rows===undefined&&/\.xlsx$/i.test(input.filename||'')&&typeof input.content_base64==='string') {
    if(input.content_base64.length>4000000)bad('原生绩效文件最多3MB');
    const source=inspectSourcePerformance(Buffer.from(input.content_base64,'base64'),{year:Number(input.source_year||date(ctx.cycle.start_date).slice(0,4))});
    if(source)return mapSourcePerformance(source,{mapping:input.mapping||{},cycle:ctx.cycle,companies:ctx.companies,people,grades,employments,filename:input.filename});
  }
  const rows=fileRows(input);
  const proposed={company_metrics:[],person_months:[],responsibilities:[]};const issues=[];const preview=[];const metrics=new Map();
  for(const [index,raw] of rows.entries()) {
    try {
      const row={...obj(raw)},kind=row.record_type;
      if(!['company_metric','person_month','responsibility'].includes(kind))bad('record_type必须为company_metric/person_month/responsibility');
      const co=ctx.companies.filter(c=>row.company_id?eq(c.id,row.company_id):eq(c.code,row.company_code));if(co.length!==1)bad('公司编号或编码无法唯一匹配；不按店名模糊匹配');
      row.company_id=co[0].id;row.period=month(row.period);const periodEnd=new Date(`${row.period}T00:00:00Z`);periodEnd.setUTCMonth(periodEnd.getUTCMonth()+1);
      if(row.period<date(ctx.cycle.start_date)||row.period>=date(ctx.cycle.end_date))bad('月份不属于周期');
      row.source_ref={filename:input.filename||'structured_rows',row:index+2,...(typeof row.source_ref==='object'?row.source_ref:{})};
      if(kind==='company_metric') {
        text(row.metric_code,'指标编码');const key=`${row.company_id}:${row.period}`;
        const item=metrics.get(key)||{company_id:row.company_id,period:row.period,metrics:{},source_ref:row.source_ref};
        if(item.metrics[row.metric_code])bad('同公司同月指标重复');
        item.metrics[row.metric_code]={value:numeric(row.value,'指标值'),unit:text(row.unit,'指标单位'),status:row.status||'unverified',source_ref:row.source_ref};
        if(row.target!==undefined&&row.target!=='')item.metrics[row.metric_code].target=numeric(row.target,'指标目标');
        if(row.source_saved_score!==undefined&&row.source_saved_score!=='')item.source_saved_score=numeric(row.source_saved_score,'源分数');metrics.set(key,item);
      } else {
        const ps=people.filter(p=>row.person_id?eq(p.id,row.person_id):eq(p.person_number,row.person_number));if(ps.length!==1)bad('初始员工编号无法唯一匹配；姓名和表内序号不作为身份主键');row.person_id=ps[0].id;
        if(kind==='person_month') {
          const gs=grades.filter(g=>row.grade_id?eq(g.id,row.grade_id):eq(g.code,row.grade_code));if(gs.length!==1)bad('职级编码无法唯一匹配');row.grade_id=gs[0].id;
          const es=employments.filter(e=>eq(e.person_id,row.person_id)&&eq(e.company_id,row.company_id)&&e.status!=='cancelled'&&date(e.hire_date)<periodEnd.toISOString().slice(0,10)&&(!e.leave_date||date(e.leave_date)>=row.period)&&(!row.employment_id||eq(e.id,row.employment_id)));
          if(es.length!==1)bad('月份内雇佣无法唯一匹配，请明确employment_id');row.employment_id=es[0].id;
          proposed.person_months.push(inputRow('person_months',row));
        } else proposed.responsibilities.push(inputRow('responsibilities',row));
      }
      preview.push({row:index+2,status:'matched',record_type:kind,company_id:row.company_id,person_id:row.person_id??null,period:row.period.slice(0,7)});
    } catch(e) {issues.push({row:index+2,code:'IMPORT_ROW_BLOCKED',message:e.message});preview.push({row:index+2,status:'blocked'});}
  }
  proposed.company_metrics=[...metrics.values()];
  return {filename:input.filename||'structured_rows',preview,issues,can_apply:issues.length===0&&rows.length>0,proposed,
    notice:'预览不会保存、确认规则或批准奖金。status/eligibility_status需核验后明确为verified；原表序号与姓名不自动建立人员身份。'};
}
