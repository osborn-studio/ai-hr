// Independent fictional workspace, including clean legacy-domain bootstrapping.
// DATABASE_URL must point to a disposable isolated database, never a preview DB.
import assert from 'node:assert/strict';
import {createApp} from '../app/server.mjs';
import {withTx} from '../app/db.mjs';
import {seed} from '../app/services/test-workspace.mjs';
import * as foundation from '../app/services/foundation.mjs';
import * as performance from '../app/services/customer-performance.mjs';
import * as payroll from '../app/services/customer-payroll.mjs';
import * as oldPeople from '../app/services/people.mjs';
import * as roster from '../app/services/roster-write.mjs';
import * as training from '../app/services/training.mjs';

process.env.SEED_SKIP='1';
const {db}=await createApp();let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name);};
const eq=(name,a,b)=>{assert.deepEqual(a,b,name);checks++;console.log('PASS '+name);};
const run=(fn,args)=>withTx(db,t=>fn(t,{userId:1000,...args}));
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
const count=async(table,gid)=>Number((await q(`SELECT count(*) n FROM ${table} WHERE group_id=$1`,[gid]))[0].n);
const day=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const sameSet=(a,b)=>[...a].map(String).sort().join(',')===[...b].map(String).sort().join(',');
async function reject(name,fn,match){await assert.rejects(fn,match);checks++;console.log('PASS '+name);}

try {
  eq('SEED_SKIP=1没有旧演示组织',(await q('SELECT count(*)::int n FROM org_unit'))[0].n,0);
  await db.query("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES(1000,'synthetic_workspace_admin','全虚构测试管理员'),(1001,'synthetic_workspace_reader','全虚构普通账号')");
  const bootstrap=(await q("INSERT INTO sys_data_scope(id,name,combinator) SELECT coalesce(max(id),0)+1,'测试启动空范围','intersection' FROM sys_data_scope RETURNING id"))[0].id;
  await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason) VALUES(1000,10,$1,current_date,'ROLE','fully synthetic workspace test')",[bootstrap]);
  await reject('没有合成确认不得生成',()=>run(seed,{input:{}}),/confirm_synthetic/);
  await reject('普通账号不得生成测试帐套',()=>withTx(db,t=>seed(t,{userId:1001,input:{confirm_synthetic:true}})),/E_TY_FORBIDDEN/);
  await reject('无效算法不静默替换',()=>run(seed,{input:{confirm_synthetic:true,selected_aggregation:'unknown'}}),/E_TY_ARGUMENT/);
  const [receipt,duplicate]=await Promise.all([run(seed,{input:{confirm_synthetic:true}}),run(seed,{input:{confirm_synthetic:true}})]);
  check('并发只生成一次且另一请求幂等返回',receipt.seeded&&!duplicate.seeded&&duplicate.already_exists&&String(receipt.group_id)===String(duplicate.group_id));
  const gid=receipt.group_id,ids=receipt.ids,legacy=ids.legacy;
  check('回执只有ID和计数且付款为零',receipt.complete&&receipt.synthetic&&receipt.summary.payments_executed===0&&!Object.hasOwn(receipt,'rows')&&!Object.hasOwn(receipt,'salaries'));
  eq('集团名称符合指定',(await q('SELECT name FROM ty_group WHERE id=$1',[gid]))[0].name,'天意集团');
  const brands=await q('SELECT * FROM ty_brand WHERE group_id=$1 ORDER BY code',[gid]);
  eq('品牌地区币种明确分别为内地人民币与香港港币',brands.map(b=>[b.name,b.region_code,b.currency_code]),[['香香鱼米','CN','CNY'],['大富烤肉','HK','HKD']]);
  const ledgers=await q('SELECT * FROM ty_ledger WHERE group_id=$1 ORDER BY id',[gid]);
  eq('两品牌帐套和一个集团帐套共三个',[ledgers.length,ledgers.filter(l=>l.scope_mode==='brand').length,ledgers.filter(l=>l.scope_mode==='group').length],[3,2,1]);
  const companies=await q('SELECT c.*,loc.region_code,loc.currency_code FROM ty_company c CROSS JOIN LATERAL fn_ty_company_locale(c.id) loc WHERE c.group_id=$1 ORDER BY c.id',[gid]);
  const hq=companies.find(c=>c.company_kind==='headquarters');
  check('总部直属集团独立CN帐套不挂任何品牌',hq.name==='天意集团总部'&&hq.brand_id===null&&hq.ledger_id===ledgers.find(l=>l.scope_mode==='group').id&&hq.region_code==='CN'&&hq.currency_code==='CNY');
  eq('二十门店加一总部公司',[companies.filter(c=>c.company_kind==='store').length,companies.length],[20,21]);
  check('每品牌十店且香港十店全部HK/HKD',companies.filter(c=>/^香香鱼米\d{2}店$/.test(c.name)&&c.region_code==='CN'&&c.currency_code==='CNY').length===10&&companies.filter(c=>/^大富烤肉\d{2}店$/.test(c.name)&&c.region_code==='HK'&&c.currency_code==='HKD').length===10);
  eq('标准岗位职级公司岗位独立建模',[await count('ty_job',gid),await count('ty_grade',gid),await count('ty_company_position',gid)],[3,3,61]);
  const areas=await q('SELECT w.* FROM ty_work_area w JOIN ty_company c ON c.id=w.company_id WHERE c.group_id=$1',[gid]);
  check('二十店均有两类档口且绑定内部部门',areas.length===40&&areas.filter(a=>a.mode==='department_extension').length===20&&areas.filter(a=>a.mode==='work_area_in_department').length===20&&areas.every(a=>a.department_id));
  const people=await q('SELECT * FROM ty_person WHERE group_id=$1 ORDER BY id',[gid]);
  check('六十二人姓名与永久编号均独立虚构',people.length===62&&people.every(p=>/^虚构人员\d{2}$/.test(p.full_name)&&/^TY\d{6}$/.test(p.person_number))&&new Set(people.map(p=>p.person_number)).size===62);
  eq('保存六十三段雇佣和六十四段任职',[await count('ty_employment',gid),await count('ty_position_assignment',gid)],[63,64]);
  const stores=companies.filter(c=>c.company_kind==='store');
  const currentCounts=await q(`SELECT c.id,count(e.id)::int n FROM ty_company c LEFT JOIN ty_employment e ON e.company_id=c.id AND e.status='active' WHERE c.group_id=$1 AND c.company_kind='store' GROUP BY c.id`,[gid]);
  check('二十门店当前各有三名员工',currentCounts.length===20&&currentCounts.every(c=>c.n===3));
  const timeline=await run(foundation.timeline,{personId:people[0].id});
  eq('跨品牌跨地区复聘安排在季度前',[day(timeline.employments[0].leave_date),day(timeline.employments[1].hire_date)],['2026-06-30','2026-07-01']);
  check('同人跨帐套履历贯通并保留季度内职级变化',timeline.employments.length===2&&timeline.employments[0].ledger_id!==timeline.employments[1].ledger_id&&timeline.employments[1].assignments.length===2&&timeline.employments[1].assignments[0].grade_id!==timeline.employments[1].assignments[1].grade_id);
  eq('晋级任职右开边界准确',[day(timeline.employments[1].assignments[0].valid_to),day(timeline.employments[1].assignments[1].valid_from)],['2026-08-01','2026-08-01']);
  const reports={},comparisons={},payrollReports={};
  for(const region of ['CN','HK']) {
    const r=ids.regions[region],currency=region==='HK'?'HKD':'CNY',n=region==='HK'?30:32;
    reports[region]=await run(performance.report,{cycleId:r.selected_cycle_id});comparisons[region]=await run(performance.report,{cycleId:r.comparison_cycle_id});
    const chosen=reports[region],comparison=comparisons[region];
    check(`${region}绩效按本地区币种独立且方案状态正确`,chosen.cycle.region_code===region&&chosen.cycle.currency_code===currency&&chosen.cycle.status==='confirmed'&&comparison.cycle.status==='calculated'&&chosen.person_months.length===n*3&&!chosen.issues.some(i=>i.blocking));
    check(`${region}所有输入和公司仅在本地区`,chosen.companies.every(c=>companies.find(x=>x.id===c.id).region_code===region)&&chosen.company_metrics.every(m=>m.source_ref.kind==='synthetic')&&chosen.person_months.every(m=>r.person_ids.includes(m.person_id)));
    const candidates=await run(performance.getPayrollCandidates,{cycleId:r.selected_cycle_id,period:'2026-11'});
    check(`${region}仅本地区已确认方案输出完整候选`,candidates.candidates.length===n&&candidates.candidates.every(c=>c.currency_code===currency&&c.region_code===region)&&(await run(performance.getPayrollCandidates,{cycleId:r.comparison_cycle_id})).candidates.length===0);
    const history=await run(payroll.report,{batchId:r.payroll_batches.history_october}),november=await run(payroll.report,{batchId:r.payroll_batches.locked_november}),december=await run(payroll.report,{batchId:r.payroll_batches.editable_december});
    payrollReports[region]={history,november,december};
    check(`${region}三工资批次地区币种人数都准确`,[history,november,december].every(b=>b.batch.region_code===region&&b.batch.currency===currency&&b.rows.length===n)&&history.batch.status==='validated'&&november.batch.status==='confirmed'&&december.batch.status==='draft');
    check(`${region}历史及已锁定工资均完整核验且绩效不重复`,history.rows.every(x=>x.validation.ok)&&november.rows.every(x=>x.validation.ok&&x.performance_inputs.length===1&&x.result.items.find(i=>i.code==='performance').amount===x.performance_inputs[0].amount));
    check(`${region}每家门店历史及新工资各有三人`,stores.filter(c=>c.region_code===region).every(c=>history.rows.filter(x=>x.company_id===c.id).length===3&&november.rows.filter(x=>x.company_id===c.id).length===3));
    const ruleset=(await q('SELECT * FROM ty_payroll_ruleset WHERE id=$1',[r.ruleset_id]))[0];
    check(`${region}专属规则模块不串地区`,region==='HK'?ruleset.rules.filter(x=>x.jurisdiction_module==='HK_MPF').length===2&&ruleset.region==='HK'&&ruleset.policy_notes.includes('mpfa.org.hk'):
      ruleset.rules.every(x=>x.jurisdiction_module==='BASE')&&ruleset.region==='CN'&&november.rows.every(x=>!x.result.items.some(i=>i.code.startsWith('mpf_'))&&x.result.totals.employee_contribution==='0.00'));
    if(region==='HK')check('香港MPF参考参数与资格明确输入',november.rows.every(x=>x.effective_inputs.mpf_rate===.05&&x.effective_inputs.employee_mpf_threshold===7100&&x.effective_inputs.mpf_cap===1500&&typeof x.effective_inputs.employee_mpf_eligible==='boolean'));
    await reject(`${region}锁定工资禁止重新试算`,()=>run(payroll.calculateBatch,{batchId:r.payroll_batches.locked_november,input:{ruleset_id:r.ruleset_id}}),/E_TY_CONFLICT/);
    check(`${region}十二月草稿可以完整试算`,(await run(payroll.calculateBatch,{batchId:r.payroll_batches.editable_december,input:{ruleset_id:r.ruleset_id}})).ok);
  }
  eq('四绩效周期六工资批次地区完整拆分',[await count('ty_perf_cycle',gid),await count('ty_payroll_batch',gid)],[4,6]);
  check('内地与香港管理责任从不跨币种',Object.entries(reports).every(([region,r])=>r.responsibilities.every(s=>companies.find(c=>c.id===s.company_id).region_code===region)));
  eq('管理责任共三人各覆盖本地区十店',[new Set([...reports.CN.responsibilities,...reports.HK.responsibilities].map(r=>r.person_id)).size,reports.CN.responsibilities.length,reports.HK.responsibilities.length],[3,60,30]);
  const p1=reports.HK.results.find(r=>r.kind==='person_bonus'&&r.person_id===people[0].id);
  eq('P1独立预期逐月平均取整奖金1835',Number(p1.amount),1835);
  eq('P1独立预期平均分期末职级奖金2272',Number(p1.details.average_score_last_grade),2272);
  eq('P1独立预期两方案差额负437',Number(p1.details.difference),-437);
  eq('P1独立预期香港十一月实发19546.59',payrollReports.HK.november.rows.find(r=>r.person_id===people[0].id).result.totals.net_pay,'19546.59');
  check('P1季度内只有香港雇佣和HKD绩效',reports.HK.person_months.filter(r=>r.person_id===people[0].id).every(r=>r.employment_id===timeline.employments[1].id)&&!reports.CN.person_months.some(r=>r.person_id===people[0].id));
  await reject('不能把香港公司放进人民币绩效周期',()=>run(performance.createCycle,{input:{group_id:gid,company_ids:[stores.find(c=>c.region_code==='HK').id],code:'BAD-FX',name:'错误跨币种',start_date:'2026-07',end_date:'2026-10',payout_period:'2026-11',region_code:'CN',currency_code:'CNY'}}),/E_TY_ARGUMENT/);
  const oldIds=people.map(p=>p.legacy_person_id);
  check('桥接后六十二人都有唯一旧人员身份',oldIds.every(Boolean)&&new Set(oldIds).size===62&&legacy.employment_ids.length===63);
  check('跨地区历史雇佣复用同一旧人员',timeline.employments.every(e=>e.legacy_employment_id)&&Number((await q('SELECT count(DISTINCT person_id)::int n FROM employment WHERE id=ANY($1::bigint[])',[timeline.employments.map(e=>e.legacy_employment_id)]))[0].n)===1);
  const binding=await q('SELECT b.* FROM ty_legacy_company_binding b JOIN ty_company c ON c.id=b.company_id WHERE c.group_id=$1',[gid]);
  check('二十店加总部桥接到二十一独立旧节点',binding.length===21&&new Set(binding.map(b=>b.legacy_org_id)).size===21);
  check('发薪和社保主体明选且内地香港分开',binding.every(b=>b.payroll_legal_entity_id===b.si_legal_entity_id&&b.payroll_legal_entity_id===legacy.legal_entity_ids[companies.find(c=>c.id===b.company_id).region_code])&&legacy.legal_entity_ids.CN!==legacy.legal_entity_ids.HK);
  const scope=(await q('SELECT * FROM sys_data_scope WHERE id=$1',[legacy.scope_id]))[0],scopeRules=await q('SELECT * FROM sys_data_scope_rule WHERE data_scope_id=$1',[legacy.scope_id]);
  check('新增TY-TEST四维范围仅含测试组织及两测试主体',scope.name==='TY-TEST'&&scopeRules.length===4&&scopeRules.every(r=>r.value_type==='nodes'&&sameSet(r.value_ids,r.dimension.endsWith('org')?legacy.organization_ids:Object.values(legacy.legal_entity_ids))));
  check('显式给调用管理员追加测试范围而不改普通桥接',Number((await q('SELECT count(*)::int n FROM sys_user_role WHERE id=$1 AND user_id=1000 AND role_id=10 AND data_scope_id=$2',[legacy.role_grant_id,legacy.scope_id]))[0].n)===1);
  const oldRoster=await run(oldPeople.roster,{asOf:'2026-11-01'});
  eq('旧花名册真实服务可见这六十二人',oldRoster.filter(p=>oldIds.includes(p.employee_id)).length,62);
  check('旧组织名称保留天意与两品牌名称',binding.every(b=>legacy.organization_ids.includes(b.legacy_org_id))&&(await q('SELECT name FROM org_unit WHERE id=ANY($1::bigint[])',[legacy.organization_ids])).some(o=>o.name.includes('大富烤肉')));
  const oldStore=binding.find(b=>b.company_id===stores.find(c=>c.region_code==='HK').id);
  const week=await run(roster.week,{storeId:oldStore.legacy_org_id,from:legacy.schedule_date,days:7});
  check('旧排班服务可见新香港店三人及测试排班',week.people.length===3&&week.rows.some(s=>s.shift_code===legacy.shift_code));
  eq('每个门店有一条未来排班',legacy.schedule_ids.length,20);
  let enrollments=0;for(const region of ['CN','HK']) {
    const year=Number(legacy.schedule_date.slice(0,4));
    const board=await run(training.board,{entityId:legacy.legal_entity_ids[region],year});
    enrollments+=board.kpi.enrolled;
    check(`${region}旧培训服务可见本地区新人员与报名`,board.people.length===(region==='HK'?30:32)&&board.sessions.some(s=>legacy.training_session_ids.includes(s.id)));
  }
  eq('虚构课程两场次共六十二报名',enrollments,62);
  const beforeCounts=[await count('ty_person',gid),await count('ty_employment',gid),await count('ty_payroll_batch',gid),binding.length,Number((await q('SELECT count(*)::int n FROM training_enrollment'))[0].n)];
  await run(foundation.save,{collection:'companies',id:companies[0].id,input:{name:'香香鱼米01店（用户编辑）'}});
  const again=await run(seed,{input:{confirm_synthetic:true,selected_aggregation:'average_score_last_grade'}});
  check('重复初始化不覆盖用户编辑或已选方案',!again.seeded&&again.selected_aggregations.HK==='floor_average_months'&&(await q('SELECT name FROM ty_company WHERE id=$1',[companies[0].id]))[0].name.endsWith('（用户编辑）'));
  eq('桥接人员工资报名均幂等不重复',[await count('ty_person',gid),await count('ty_employment',gid),await count('ty_payroll_batch',gid),Number((await q('SELECT count(*)::int n FROM ty_legacy_company_binding b JOIN ty_company c ON c.id=b.company_id WHERE c.group_id=$1',[gid]))[0].n),Number((await q('SELECT count(*)::int n FROM training_enrollment'))[0].n)],beforeCounts);
  check('组织绩效工资桥接授权均有审计',Number((await q("SELECT count(*)::int n FROM ty_audit WHERE entity_kind='test_workspace' AND entity_id=$1",[gid]))[0].n)>=2&&Number((await q('SELECT count(*)::int n FROM ty_payroll_audit WHERE batch_id=$1',[ids.regions.HK.payroll_batches.locked_november]))[0].n)>5);
  // A second synthetic group exercises the pre-existing legacy-root path and
  // proves each region can choose the other aggregation for actual locked pay.
  await run(foundation.save,{collection:'groups',id:gid,input:{code:'TY-TEST-RETAINED'}});
  const alternate=await run(seed,{input:{confirm_synthetic:true,selected_aggregations:{CN:'average_score_last_grade',HK:'average_score_last_grade'}}});
  check('已有旧根下新建独立测试分支且可完整再次初始化',alternate.complete&&alternate.ids.legacy.parent_org_id!==alternate.ids.legacy.root_org_id&&alternate.summary.legacy_people===62);
  const altPayroll=await run(payroll.report,{batchId:alternate.ids.regions.HK.payroll_batches.locked_november});
  const altPersonId=alternate.ids.person_ids[0],altSalary=altPayroll.rows.find(r=>r.person_id===altPersonId);
  eq('另选算法完整进入香港工资且奖金2272.00',altSalary.result.items.find(i=>i.code==='performance').amount,'2272.00');
  eq('另选算法香港实发独立预期19961.74',altSalary.result.totals.net_pay,'19961.74');
  check('内地也独立选择另一算法并锁定本币工资',(await run(performance.report,{cycleId:alternate.ids.regions.CN.selected_cycle_id})).cycle.rules.aggregation==='average_score_last_grade'&&(await run(payroll.report,{batchId:alternate.ids.regions.CN.payroll_batches.locked_november})).batch.currency==='CNY');
  await run(foundation.save,{collection:'groups',id:alternate.group_id,input:{code:'TY-TEST-ALTERNATE-RETAINED'}});
  const reserved=(await run(foundation.save,{collection:'groups',input:{code:'TY-TEST',name:'用户自建保留集团'}})).row;
  const preserved=await run(seed,{input:{confirm_synthetic:true}});
  check('编码已被用户使用时不覆盖也不谎报完整',!preserved.seeded&&!preserved.complete&&preserved.group_id===reserved.id&&(await q('SELECT name FROM ty_group WHERE id=$1',[reserved.id]))[0].name==='用户自建保留集团');
  console.log(`全虚构地区工作区 · ${checks} 条通过 · 驱动 ${db.driver}`);
}finally{await db.close();}
