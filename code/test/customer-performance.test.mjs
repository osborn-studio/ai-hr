// Synthetic evidence only. Both drivers use exactly the same business service.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import * as perf from '../app/services/customer-performance.mjs';
import { inspectSourcePerformance } from '../app/services/customer-performance-import.mjs';
import { makeZip } from '../app/zip.mjs';

const xc=(ref,value,formula)=>`<c r="${ref}"${typeof value==='string'?' t="inlineStr"':''}>${formula?`<f>${formula.replaceAll('&','&amp;').replaceAll('<','&lt;')}</f>`:''}${typeof value==='string'?`<is><t>${value}</t></is>`:`<v>${value}</v>`}</c>`;
function sourceFixture() {
  const sheets=['賞与','员工明细第3季度','汇总判定','AM KSP'];
  let details=xc('C3',7)+xc('D3',8)+xc('E3',9)+xc('A4',1)+xc('B4','虚构导入人员');
  for(const [ref,val] of Object.entries({C4:'源甲店',D4:'源乙店',E4:'源乙店',F4:'L1',G4:'L2',H4:'L2',J4:'C',L4:'A',N4:'S'}))details+=xc(ref,val);
  details+=xc('I4',.9,'VLOOKUP(C4,汇总判定!BS:CM,20,FALSE)')+xc('K4',.95,'VLOOKUP(D4,汇总判定!AJ:BF,22,FALSE)')+xc('M4',1,'VLOOKUP(E4,汇总判定!A:W,22,FALSE)');
  details+=xc('O4',90,'I4*100')+xc('P4',285,'K4*200*1.5')+xc('Q4',400,'M4*200*2')+xc('R4',258,'INT(AVERAGE(O4:Q4))');
  let summary='';
  for(const [label,score,rating,sv] of [['BS','CL','CM',.9],['AJ','BE','BF',.95],['A','V','W',1]])for(const [row,name] of [[5,'源甲店'],[6,'源乙店']])summary+=xc(`${label}${row}`,name)+xc(`${score}${row}`,sv,'1-SUM(L5:U5)')+xc(`${rating}${row}`,'C');
  summary+='<c r="AG5" t="e"><f>VLOOKUP(A5,[1]Sheet3!A:V,2,FALSE)</f><v>#N/A</v></c>';
  const management=xc('F3','虚构管理列')+xc('F20',.9,'1-SUM(F14:F19)')+xc('F21','C')+xc('F22',30,'F80*F20/3')+'<c r="F79" t="e"><f>AVERAGE(F22,F44,F67)</f><v>#DIV/0!</v></c>';
  const parts=['',details,summary,management];
  return makeZip([
    {name:'xl/workbook.xml',data:`<workbook xmlns:r="r"><sheets>${sheets.map((n,i)=>`<sheet name="${n}" r:id="r${i+1}"/>`).join('')}</sheets></workbook>`},
    {name:'xl/_rels/workbook.xml.rels',data:`<Relationships>${sheets.map((_,i)=>`<Relationship Id="r${i+1}" Target="worksheets/sheet${i+1}.xml"/>`).join('')}</Relationships>`},
    ...parts.map((data,i)=>({name:`xl/worksheets/sheet${i+1}.xml`,data:`<worksheet><sheetData><row r="1">${data}</row></sheetData></worksheet>`})),
    {name:'xl/externalLinks/externalLink1.xml',data:'<externalLink/>'},
  ]);
}

let db;
if(process.env.DATABASE_URL) {
  const pg=(await import('pg')).default;pg.types.setTypeParser(20,v=>Number(v));pg.types.setTypeParser(1082,v=>new Date(`${v}T00:00:00Z`));
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query("SET TIME ZONE 'UTC'");
  db={query:(s,a)=>c.query(s,a),exec:s=>c.query(s),close:()=>c.end()};console.log('绩效驱动：真实 PostgreSQL');
} else {db=await PGlite.create({extensions:{btree_gist}});console.log('绩效驱动：PGlite');}
const results=[];const rec=(name,ok)=>results.push({name,ok:!!ok});
const q=async(s,a=[]) => (await db.query(s,a)).rows;
const insert=async(table,data)=>{const keys=Object.keys(data);return Number((await q(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING id`,Object.values(data)))[0].id);};
async function tx(fn){await db.exec('BEGIN');try{const r=await fn(db);await db.exec('COMMIT');return r;}catch(e){await db.exec('ROLLBACK');throw e;}}
async function reject(name,fn,code='E_TY_'){try{await tx(fn);rec(name,false);}catch(e){rec(name,String(e.message).includes(code));}}
const run=(fn,args)=>tx(t=>fn(t,{userId:1000,...args,...(fn===perf.createCycle?{input:{region_code:'CN',currency_code:'CNY',...args.input}}:{})}));

try {
  for(const f of ['193_tyhr_foundation.sql','194_tyhr_foundation_governance.sql','196_tyhr_customer_payroll.sql','197_tyhr_customer_performance.sql','199_tyhr_payroll_input_review.sql','200_tyhr_payroll_formula_guard.sql'])await db.exec(readFileSync(new URL('../db/'+f,import.meta.url),'utf8'));
  await db.exec('CREATE TABLE sys_check_registry(check_code text PRIMARY KEY,name text,domain text,kind text,guard_object text,guard_schema text,guard_table text,guard_kind text,runner text,assertion_sql text)');
  for(const f of ['201_tyhr_region_currency.sql','202_tyhr_region_payroll_guard.sql'])await db.exec(readFileSync(new URL('../db/'+f,import.meta.url),'utf8'));
  await db.exec(`CREATE FUNCTION fn_role_can(uid bigint,resource text,action text) RETURNS boolean LANGUAGE sql AS $$
    SELECT CASE WHEN resource='ledger' THEN uid IN(1000,1003) WHEN resource='perf_cycle' THEN uid IN(1000,1001,1004) OR (uid=1002 AND action='read') ELSE false END $$;`);
  const g=await insert('ty_group',{code:'PERF',name:'绩效虚构测试集团'});
  const l1=await insert('ty_ledger',{group_id:g,scope_mode:'group',code:'A',name:'甲测试帐套'});
  const l2=await insert('ty_ledger',{group_id:g,scope_mode:'group',code:'B',name:'乙测试帐套'});
  const a=await insert('ty_company',{group_id:g,ledger_id:l1,code:'A',name:'甲测试公司'});
  const b=await insert('ty_company',{group_id:g,ledger_id:l2,code:'B',name:'乙测试公司'});
  const other=await insert('ty_group',{code:'OTHER',name:'其他测试集团'});
  const ol=await insert('ty_ledger',{group_id:other,scope_mode:'group',code:'O',name:'其他帐套'});
  const oc=await insert('ty_company',{group_id:other,ledger_id:ol,code:'O',name:'其他公司'});
  const gr1=await insert('ty_grade',{group_id:g,code:'L1',name:'测试一级',level:1});
  const gr2=await insert('ty_grade',{group_id:g,code:'L2',name:'测试二级',level:2});
  const p=await insert('ty_person',{group_id:g,person_number:'TEST-001',full_name:'测试跨店人员'});
  const mgr=await insert('ty_person',{group_id:g,person_number:'TEST-002',full_name:'测试责任管理人员'});
  const e1=await insert('ty_employment',{group_id:g,person_id:p,company_id:a,hire_date:'2026-07-01',leave_date:'2026-07-31',status:'ended'});
  const e2=await insert('ty_employment',{group_id:g,person_id:p,company_id:b,hire_date:'2026-08-01'});
  const em=await insert('ty_employment',{group_id:g,person_id:mgr,company_id:a,hire_date:'2026-07-01'});
  await insert('ty_access_grant',{account_id:1001,group_id:g,company_id:a,can_read:true,can_write:true,valid_from:'2020-01-01'});
  await insert('ty_access_grant',{account_id:1002,group_id:g,can_read:true,can_write:true,valid_from:'2020-01-01'});
  const c=(await run(perf.createCycle,{input:{group_id:g,code:'Q3',name:'虚构三季度绩效',start_date:'2026-07',end_date:'2026-10',payout_period:'2026-11',company_ids:[a,b]}})).cycle;
  rec('可建立跨帐套公司的季度考核',c.status==='draft');
  await reject('基础管理员无绩效岗位授权仍不得读奖金',t=>perf.report(t,{userId:1003,cycleId:c.id}),'E_TY_FORBIDDEN');
  await reject('仅有绩效岗位没有基础公司范围不能读',t=>perf.report(t,{userId:1004,cycleId:c.id}),'E_TY_NOT_FOUND');
  await reject('公司窄范围不能新建含其他公司周期',t=>perf.createCycle(t,{userId:1001,input:{group_id:g,code:'BAD',name:'错误范围',start_date:'2026-07',end_date:'2026-10',payout_period:'2026-11',company_ids:[a,b]}}));
  await reject('跨集团公司不能混入同周期',t=>perf.createCycle(t,{userId:1000,input:{group_id:g,code:'BAD-G',name:'错误集团',start_date:'2026-07',end_date:'2026-10',payout_period:'2026-11',company_ids:[a,oc]}}));
  const rules={confirmed:true,aggregation:'floor_average_months',payout_assignment:'last_month_employment',score_base:1,score_floor:0,
    metrics:[{code:'quality',unit:'ratio',method:'direct_deduction'}],rating_bands:[{min_score:1,grade:'S',factor:2},{min_score:.95,grade:'A',factor:1.5},{min_score:0,grade:'C',factor:1}],
    grade_bases:{[gr1]:100,[gr2]:200},management:{confirmed:true,method:'weighted_company_scores'},score_tolerance:.0001,amount_tolerance:.001};
  await run(perf.saveScheme,{cycleId:c.id,input:{rules,source_refs:[{sheet:'虚构来源',range:'A1:C10'}]}});
  const metrics=[['2026-07',.1,0],['2026-08',0,.05],['2026-09',0,0]].flatMap(([period,va,vb])=>[
    {company_id:a,period,metrics:{quality:{value:va,unit:'ratio',status:'verified'}},source_saved_score:1-va},
    {company_id:b,period,metrics:{quality:{value:vb,unit:'ratio',status:'verified'}},source_saved_score:1-vb}]);
  const personMonths=[
    {person_id:p,company_id:a,employment_id:e1,period:'2026-07',grade_id:gr1,source_saved_amount:90},
    {person_id:p,company_id:b,employment_id:e2,period:'2026-08',grade_id:gr2,source_saved_amount:285},
    {person_id:p,company_id:b,employment_id:e2,period:'2026-09',grade_id:gr2,source_saved_amount:400},
    ...['2026-07','2026-08','2026-09'].map(period=>({person_id:mgr,company_id:a,employment_id:em,period,grade_id:gr1,score_source:'management'})),
  ].map(v=>({...v,eligibility_status:'verified'}));
  const responsibilities=['2026-07','2026-08','2026-09'].flatMap(period=>[{person_id:mgr,company_id:a,period,weight:.25,status:'verified'},{person_id:mgr,company_id:b,period,weight:.75,status:'verified'}]);
  await run(perf.saveInputs,{cycleId:c.id,input:{company_metrics:metrics,person_months:personMonths,responsibilities}});
  const r=await run(perf.calculate,{cycleId:c.id});
  rec('公司月分数与源保存值对账无误',r.results.filter(x=>x.kind==='company').length===6&&!r.issues.length);
  const pb=r.results.find(x=>x.kind==='person_bonus'&&Number(x.person_id)===p);
  rec('逐月归属和职级计算后平均取整',Number(pb.amount)===258&&Number(pb.company_id)===b&&Number(pb.employment_id)===e2);
  rec('责任聚合使用已核验权重且不重复发放',Number(r.results.find(x=>x.kind==='person_bonus'&&Number(x.person_id)===mgr).amount)===163);
  rec('未确认结果不能成为薪酬候选',(await run(perf.getPayrollCandidates,{cycleId:c.id})).candidates.length===0);
  const scopedAdmin=await run(perf.report,{cycleId:c.id,ledgerId:l1});
  rec('集团管理员选帐套后报告只含该帐套公司',scopedAdmin.companies.length===1&&Number(scopedAdmin.companies[0].id)===a&&scopedAdmin.company_metrics.length===3&&scopedAdmin.results.every(x=>Number(x.company_id)===a));
  rec('帐套部分上下文隐藏跨公司管理结果与确认能力',scopedAdmin.scope.partial&&!scopedAdmin.scope.can_write&&!scopedAdmin.scope.can_confirm&&scopedAdmin.totals.basis==='visible_rows_only'&&!scopedAdmin.results.some(x=>x.kind==='person_bonus'||Number(x.person_id)===mgr)&&!scopedAdmin.person_months.some(x=>Number(x.person_id)===mgr));
  const companyReport=await run(perf.report,{cycleId:c.id,companyId:b});
  rec('公司筛选与结果依赖同时约束展示',companyReport.companies.length===1&&Number(companyReport.companies[0].id)===b&&companyReport.results.every(x=>Number(x.company_id)===b)&&!companyReport.results.some(x=>x.kind==='person_bonus'));
  const scopedListing=await run(perf.listCycles,{groupId:g,ledgerId:l1});
  rec('管理员局部帐套周期清单不可标为完整或可写',scopedListing.cycles.length===1&&scopedListing.cycles[0].partial_scope&&!scopedListing.cycles[0].can_write&&scopedListing.cycles[0].company_ids.length===1);
  await reject('公司与所选帐套不匹配不回退全周期',t=>perf.report(t,{userId:1000,cycleId:c.id,ledgerId:l1,companyId:b}),'E_TY_NOT_FOUND');
  await reject('周期与所选集团不匹配不回退全周期',t=>perf.report(t,{userId:1000,cycleId:c.id,groupId:other}),'E_TY_NOT_FOUND');
  await reject('无效上下文编号不得静默忽略',t=>perf.report(t,{userId:1000,cycleId:c.id,ledgerId:'wrong'}),'E_TY_ARGUMENT');
  for(const [label,fn,input] of [['重算',perf.calculate,undefined],['确认',perf.confirm,{result_version:r.cycle.result_version,reason:'局部上下文不能确认全体'}],['改规则',perf.saveScheme,{rules}],['改输入',perf.saveInputs,{person_months:[]}],['设地区',perf.setCycleLocale,{region_code:'CN'}],['导入',perf.importPreview,{rows:[]}]])
    await reject(`管理员局部帐套上下文不能${label}整个周期`,t=>fn(t,{userId:1000,cycleId:c.id,ledgerId:l1,input}),'E_TY_FORBIDDEN');
  const narrow=await tx(t=>perf.report(t,{userId:1001,cycleId:c.id}));
  rec('窄公司范围结果不出现其他公司',narrow.results.every(x=>Number(x.company_id)===a)&&narrow.company_metrics.every(x=>Number(x.company_id)===a));
  rec('跨公司最终奖金和管理月汇总不能从局部范围推知',!narrow.results.some(x=>x.kind==='person_bonus'||Number(x.person_id)===mgr)&&!narrow.person_months.some(x=>Number(x.person_id)===mgr));
  rec('局部报告不返回其他公司方案或来源',narrow.scope.partial&&Object.keys(narrow.cycle.rules).length===0&&narrow.cycle.source_refs.length===0&&narrow.totals.basis==='visible_rows_only');
  const listing=await tx(t=>perf.listCycles(t,{userId:1001,groupId:g}));rec('周期清单仅含可见公司且不能显示全体写能力',listing.cycles.length===1&&listing.cycles[0].company_ids.length===1&&!listing.cycles[0].can_write);
  await reject('局部写范围不能重新计算全周期',t=>perf.calculate(t,{userId:1001,cycleId:c.id}),'E_TY_FORBIDDEN');
  await reject('局部写范围不能确认全体',t=>perf.confirm(t,{userId:1001,cycleId:c.id,input:{result_version:r.cycle.result_version,reason:'局部测试'}}),'E_TY_FORBIDDEN');
  await reject('只读绩效角色即使基础可写仍不能改',t=>perf.saveScheme(t,{userId:1002,cycleId:c.id,input:{rules}}),'E_TY_FORBIDDEN');
  await reject('确认必须匹配当前结果版本',t=>perf.confirm(t,{userId:1000,cycleId:c.id,input:{result_version:99,reason:'错误版本'}}),'E_TY_CONFLICT');
  const conf=await run(perf.confirm,{cycleId:c.id,input:{result_version:r.cycle.result_version,reason:'虚构夹具完整核验'}});
  rec('完整已核验结果可冻结',conf.cycle.status==='confirmed');
  const candidates=(await run(perf.getPayrollCandidates,{cycleId:c.id,period:'2026-11'})).candidates;
  rec('确认后按付款月份输出两条稳定来源候选',candidates.length===2&&candidates.every(v=>v.source_key.startsWith(`perf:${c.id}:1:`)&&v.period==='2026-11'&&v.currency_code==='CNY'));
  rec('管理员帐套候选不返回跨帐套依赖奖金',(await run(perf.getPayrollCandidates,{cycleId:c.id,ledgerId:l1})).candidates.length===0);
  rec('管理员公司候选不返回跨公司依赖奖金',(await run(perf.getPayrollCandidates,{cycleId:c.id,companyId:b})).candidates.length===0);
  const scopedCsv=await run(perf.exportReport,{cycleId:c.id,ledgerId:l1});
  rec('CSV导出服从帐套上下文且隐藏依赖不全的经理',scopedCsv.content.trim().split('\n').length===scopedAdmin.results.length+1&&!scopedCsv.content.includes('测试责任管理人员')&&!scopedCsv.content.includes('person_bonus'));
  rec('错发薪月份不返回候选',(await run(perf.getPayrollCandidates,{cycleId:c.id,period:'2026-12'})).candidates.length===0);
  rec('局部公司不能获取依赖其他公司的奖金候选',(await tx(t=>perf.getPayrollCandidates(t,{userId:1001,cycleId:c.id}))).candidates.length===0);
  await reject('冻结后输入不能被服务覆盖',t=>perf.saveInputs(t,{userId:1000,cycleId:c.id,input:{person_months:[]}}),'E_TY_CONFLICT');
  await reject('直接SQL不能修改冻结月指标',t=>t.query('UPDATE ty_perf_company_metric SET metrics=$2::jsonb WHERE cycle_id=$1',[c.id,'{}']),'E_TY_CONFLICT');
  await reject('直接SQL不能删除冻结结果',t=>t.query('DELETE FROM ty_perf_result WHERE cycle_id=$1',[c.id]),'E_TY_CONFLICT');
  const c2=(await run(perf.createCycle,{input:{group_id:g,code:'BLOCK',name:'阻断验证',start_date:'2026-07',end_date:'2026-10',payout_period:'2026-11',company_ids:[a,b]}})).cycle;
  await run(perf.saveScheme,{cycleId:c2.id,input:{rules:{...rules,confirmed:false}}});
  await run(perf.saveInputs,{cycleId:c2.id,input:{company_metrics:metrics,person_months:personMonths,responsibilities}});
  const blocked=await run(perf.calculate,{cycleId:c2.id});rec('未确认算法返回可解释阻断而不补零',blocked.issues.some(i=>i.code==='RULE_UNCONFIRMED')&&blocked.results.filter(x=>x.kind==='person_bonus').every(x=>x.amount===null));
  await reject('存在阻断结果不允许确认',t=>perf.confirm(t,{userId:1000,cycleId:c2.id,input:{result_version:1,reason:'不该确认'}}),'E_TY_CONFLICT');
  await run(perf.saveScheme,{cycleId:c2.id,input:{rules}});
  await reject('输入变更后旧计算版本不能确认',t=>perf.confirm(t,{userId:1000,cycleId:c2.id,input:{result_version:1,reason:'旧版本'}}),'E_TY_CONFLICT');
  const badMetrics=structuredClone(metrics);badMetrics[0].metrics.quality.unit='percent';badMetrics[1].metrics.quality.status='source_error';
  await run(perf.saveInputs,{cycleId:c2.id,input:{company_metrics:badMetrics}});
  const un=await run(perf.calculate,{cycleId:c2.id});rec('单位冲突与源缓存错误分别阻断',un.issues.some(i=>i.code==='UNIT_CONFLICT')&&un.issues.some(i=>i.code==='INPUT_UNVERIFIED'));
  const mismatch=structuredClone(metrics);mismatch[0].source_saved_score=.5;
  await run(perf.saveInputs,{cycleId:c2.id,input:{company_metrics:mismatch}});const mis=await run(perf.calculate,{cycleId:c2.id});rec('重算与源分数不符必须对账',mis.issues.some(i=>i.code==='SOURCE_SCORE_MISMATCH'));
  await run(perf.saveInputs,{cycleId:c2.id,input:{company_metrics:metrics,person_months:personMonths.filter(x=>x.period!=='2026-09')}});const missingMonth=await run(perf.calculate,{cycleId:c2.id});rec('人员缺少月份不自动补零算奖金',missingMonth.issues.some(i=>i.code==='MONTH_MISSING'));
  await reject('雇佣公司不匹配由数据库拒绝',t=>t.query(`INSERT INTO ty_perf_person_month(cycle_id,company_id,period,person_id,employment_id,grade_id) VALUES($1,$2,'2026-08-01',$3,$4,$5)`,[c2.id,a,p,e2,gr1]),'E_TY_ARGUMENT');
  const pv=await run(perf.importPreview,{cycleId:c2.id,input:{filename:'虚构.csv',rows:[{record_type:'person_month',company_code:'B',period:'2026-08',person_id:p,grade_code:'L2',eligibility_status:'unverified'}]}});
  rec('导入预检可用精确编码匹配雇佣但不自动核验资格',pv.can_apply&&pv.proposed.person_months[0].employment_id===e2&&pv.proposed.person_months[0].eligibility_status==='unverified');
  const pvbad=await run(perf.importPreview,{cycleId:c2.id,input:{rows:[{record_type:'person_month',company_code:'B',period:'2026-08',person_number:'表内序号1',grade_code:'L2'}]}});rec('原表序号不被误认成永久员工号',!pvbad.can_apply&&pvbad.issues.length===1);
  const exported=await run(perf.exportReport,{cycleId:c.id});rec('导出使用统一BOM CSV且有阻断列',exported.content.startsWith('\uFEFF')&&exported.content.includes('阻断项数'));
  const source=sourceFixture(),parsed=inspectSourcePerformance(source,{year:2026});
  rec('原生预检读取具名页不误读首张提案页',parsed.format==='source_s01'&&parsed.source_summary.people_count===1&&parsed.source_summary.person_month_count===3);
  rec('原生预检保留7/8/9月且正确识别横向逆序',parsed.candidates.companies.find(x=>x.period==='2026-07').score_source.source_ref.cell==='CL5'&&parsed.candidates.companies.find(x=>x.period==='2026-09').score_source.source_ref.cell==='V5');
  rec('外链与两类公式缓存错误分别保留',parsed.source_summary.external_formula_count===1&&parsed.source_summary.external_relationship_count===1&&parsed.source_summary.error_cell_count===2);
  rec('原生公式与缓存仅作候选且规则未确认',parsed.candidates.people[0].months[0].source_cells.score.formula.includes('VLOOKUP')&&parsed.rules_proposal.confirmed===false&&parsed.rules_proposal.management.confirmed===false);
  const rawPreview=await run(perf.importPreview,{cycleId:c2.id,input:{filename:'虚构原生.xlsx',content_base64:source.toString('base64')}});
  rec('原生未映射身份与公司时不允许应用',!rawPreview.can_apply&&rawPreview.mapping_required&&rawPreview.issues.some(x=>x.code==='PERSON_MAPPING_REQUIRED'));
  const mapped=await run(perf.importPreview,{cycleId:c2.id,input:{filename:'虚构原生.xlsx',content_base64:source.toString('base64'),mapping:{companies:{'源甲店':a,'源乙店':b},people:{'1':p},grades:{L1:gr1,L2:gr2}}}});
  rec('原生显式映射后形成规范人月候选',mapped.can_apply&&mapped.proposed.person_months.length===3&&mapped.proposed.company_metrics.length===6);
  rec('映射没有把原序号写成永久员工号',mapped.proposed.person_months.every(x=>Number(x.person_id)===p)&&mapped.candidates.people[0].source_ordinal==='1');
  rec('推算个人基数和资格仍需核验',mapped.proposed.person_months.every(x=>x.bonus_base_status==='unverified'&&x.eligibility_status==='unverified')&&Math.abs(Number(mapped.proposed.person_months[1].bonus_base_override)-200)<1e-9);
  rec('原生保存季度源奖金用于最终对账',mapped.proposed.person_months[2].source_saved_cycle_amount===258);
  await reject('TRUNCATE不能绕过已确认历史保护',t=>t.query('TRUNCATE ty_perf_result'),'TRUNCATE');
  await reject('直接改状态不能绕过确认门槛',t=>t.query(`UPDATE ty_perf_cycle SET status='confirmed' WHERE id=$1`,[c2.id]),'E_TY_CONFLICT');
  const c3=(await run(perf.createCycle,{input:{group_id:g,code:'ALT',name:'两方案比较验证',start_date:'2026-07',end_date:'2026-10',payout_period:'2026-11',company_ids:[a,b]}})).cycle;
  const alternativeRules={...rules,aggregation:'average_score_last_grade',alternative_eligibility:'last_month',alternative_rounding:'none'};
  await run(perf.saveScheme,{cycleId:c3.id,input:{rules:alternativeRules}});
  const alternativePeople=personMonths.map(x=>x.person_id===p&&x.period==='2026-09'?{...x,source_saved_cycle_amount:258,source_saved_alternative_cycle_amount:285}:x);
  await run(perf.saveInputs,{cycleId:c3.id,input:{company_metrics:metrics,person_months:alternativePeople,responsibilities}});
  const ar=await run(perf.calculate,{cycleId:c3.id}),ap=ar.results.find(x=>x.kind==='person_bonus'&&Number(x.person_id)===p);
  rec('可显式选择先平均分再用期末职级',Number(ap.amount)===285&&ar.scope.can_confirm);
  rec('两方案同时展示差额且不擅自批准比较值',Number(ap.details.monthly_bonus_average)===258&&Number(ap.details.average_score_last_grade)===285&&Number(ap.details.difference)===-27&&ap.details.comparison_only_not_approval);
  rec('替代方案独立对账不误用原R列',!ar.issues.some(x=>x.code==='SOURCE_CYCLE_AMOUNT_MISMATCH')&&!ar.issues.some(x=>x.code==='SOURCE_ALTERNATIVE_AMOUNT_MISMATCH'));
  await run(perf.confirm,{cycleId:c3.id,input:{result_version:ar.cycle.result_version,reason:'虚构替代方案明确确认'}});
  const altCandidates=(await run(perf.getPayrollCandidates,{cycleId:c3.id})).candidates;
  rec('替代方案确认后只输出选定版本奖金',Number(altCandidates.find(x=>Number(x.person_id)===p).amount)===285);
  const exact=(await q("SELECT amount::text amount FROM ty_perf_result WHERE cycle_id=$1 AND kind='person_bonus' AND person_id=$2",[c3.id,mgr]))[0].amount;
  rec('入薪候选保留数据库原始十进制不经Number重转',altCandidates.find(x=>Number(x.person_id)===mgr).amount_exact===exact);
  await run(perf.saveScheme,{cycleId:c2.id,input:{rules:{...rules,aggregation:'average_score_last_grade'}}});
  await run(perf.saveInputs,{cycleId:c2.id,input:{company_metrics:metrics,person_months:personMonths,responsibilities}});
  const policyMissing=await run(perf.calculate,{cycleId:c2.id});rec('替代方案缺资格或舍入口径仍阻断',policyMissing.issues.some(x=>x.code==='ALTERNATIVE_POLICY_UNCONFIRMED')&&!policyMissing.scope.can_confirm);
  await run(perf.saveScheme,{cycleId:c2.id,input:{rules}});
  await run(perf.saveInputs,{cycleId:c2.id,input:{person_months:personMonths.map(x=>({...x,bonus_base_override:100,bonus_base_status:'unverified'}))}});
  const baseMissing=await run(perf.calculate,{cycleId:c2.id});rec('个人奖金基数覆盖未经核验不可确认',baseMissing.issues.some(x=>x.code==='PERSON_BASE_UNCONFIRMED')&&!baseMissing.scope.can_confirm);
} finally {await db.close();}
for(const r of results)console.log(`${r.ok?'PASS':'FAIL'} ${r.name}`);
const failed=results.filter(r=>!r.ok).length;console.log(`绩效 ${results.length} 条，通过 ${results.length-failed}，失败 ${failed}`);process.exitCode=failed?1:0;
