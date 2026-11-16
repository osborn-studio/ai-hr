// Isolated, wholly fictional DB/service security regression. No existing database
// is accepted. DATABASE_URL is supplied only by an external disposable-DB runner.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createDb, withTx } from '../app/db.mjs';
import * as leave from '../app/services/advanced-leave.mjs';

const db = await createDb({ url: process.env.DATABASE_URL || undefined });
const q = async (sql, args = [], tx = db) => (await tx.query(sql, args)).rows;
const one = async (sql, args = [], tx = db) => (await q(sql, args, tx))[0];
const add = async (table, values, tx = db) => {
  const keys = Object.keys(values);
  return one(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, Object.values(values), tx);
};
const results = [];
let operationSequence = 0;
const errorCode = e => /^(E_[A-Z0-9_]+):/.exec(e.message || '')?.[1] || e.code;
const check = async (name, fn) => {
  try { await fn(); results.push({ name, pass: true }); console.log('PASS ' + name); }
  catch (e) { results.push({ name, pass: false }); console.error('FAIL ' + name + ': ' + e.message); }
};
const rejected = async (fn, codes) => {
  const rollbackSentinel = new Error('TEST_UNEXPECTED_ACCEPT');
  try {
    await withTx(db, async tx => { await fn(tx); throw rollbackSentinel; });
    assert.fail('Transaction unexpectedly returned');
  } catch (e) {
    assert.notEqual(e, rollbackSentinel, 'Unsafe operation was accepted (test rolled it back)');
    assert.ok(codes.includes(errorCode(e)), `Expected ${codes.join('/')} but received ${errorCode(e)}: ${e.message}`);
  }
};
const sqlRejected = (sql, args = [], codes = ['23503', '23514']) => rejected(tx => tx.query(sql, args), codes);
const run = (fn, args = {}, userId = 9101) => withTx(db, tx => fn(tx,
  { operationId: `SEC-OP-${++operationSequence}`, ...args, userId }));
const amount = async (lotId, tx = db) => one('SELECT granted::text,held::text,allocated::text,taken::text,expired::text FROM ty_leave_lot WHERE id=$1', [lotId], tx);
const dec = (actual, expected) => {
  const parts = v => { const s = String(v); assert.match(s, /^-?\d+(\.\d+)?$/); const [a,b=''] = s.split('.'); return [BigInt(a+b),10n**BigInt(b.length)]; };
  const [an,ad] = parts(actual), [en,ed] = parts(expected); assert.equal(an*ed,en*ad);
};

try {
  // Fail before any schema/data mutation if someone passes an existing database.
  assert.equal(Number((await one("SELECT count(*) n FROM pg_tables WHERE schemaname='public'")).n), 0,
    'Security suite requires a new empty database; existing databases are forbidden');
  await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
  const dir = new URL('../db/', import.meta.url);
  for (const name of readdirSync(dir).filter(x => /^\d{3}_.*\.sql$/.test(x)).sort())
    await db.exec('BEGIN;\n' + readFileSync(new URL(name, dir), 'utf8') + '\nCOMMIT;');
  await db.initSession();

  const ga = await add('ty_group', { code: 'SEC-A', name: '虚构安全集团甲' });
  const go = await add('ty_group', { code: 'SEC-O', name: '虚构安全集团乙' });
  const la = await add('ty_ledger', { group_id: ga.id, code: 'A', name: '虚构甲帐套', scope_mode: 'group' });
  const lo = await add('ty_ledger', { group_id: go.id, code: 'O', name: '虚构乙帐套', scope_mode: 'group' });
  const ca = await add('ty_company', { group_id: ga.id, ledger_id: la.id, code: 'A', name: '虚构甲店' });
  const cb = await add('ty_company', { group_id: ga.id, ledger_id: la.id, code: 'B', name: '虚构乙店' });
  const co = await add('ty_company', { group_id: go.id, ledger_id: lo.id, code: 'O', name: '虚构异集团店' });
  const person = async (group, name) => (await one('SELECT fn_ty_create_person($1,NULL,$2) id', [group, name])).id;
  const pa = await person(ga.id, '虚构安禾'), pc = await person(ga.id, '虚构陈岚'), po = await person(go.id, '虚构欧青');
  const employment = (p, c, g) => add('ty_employment', { group_id: g, person_id: p, company_id: c, hire_date: '2026-01-01' });
  const ea = await employment(pa, ca.id, ga.id), eb = await employment(pa, cb.id, ga.id);
  const ec = await employment(pc, ca.id, ga.id), eo = await employment(po, co.id, go.id);
  await db.exec("INSERT INTO sys_role(id,code,name) VALUES(9101,'leave_sec_full','虚构假期全功能'),(9102,'leave_sec_self','虚构假期本人');\n" +
    "INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write) SELECT 9101,resource_code,true,true FROM sys_perm_resource WHERE resource_code LIKE 'advanced_leave_%';\n" +
    "INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write) VALUES(9102,'advanced_leave_self',true,true);\n" +
    "INSERT INTO sys_data_scope(id,name,combinator) VALUES(9101,'虚构假期安全范围','intersection');");
  const user = async (id, profile, company = null, p = null, role = 9101) => {
    await db.query('INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3)', [id, `fictional_leave_sec_${id}`, '虚构安全账号']);
    await add('sys_user_role', { user_id: id, role_id: role, data_scope_id: 9101, effective_from: '2026-01-01', grant_kind: 'ROLE', grant_reason: 'wholly fictional security test' });
    await add('ty_test_account_profile', { account_id: id, group_id: ga.id, person_id: p, company_id: p ? company : null, profile_code: profile, seed_version: 'SEC-FAKE' });
    await add('ty_access_grant', { account_id: id, group_id: ga.id, company_id: company, can_read: true, can_write: true });
  };
  await user(9101, 'group_hr_director');
  await user(9102, 'group_hr_director');
  await user(9103, 'company_hr_director', ca.id);
  await user(9104, 'store_staff', ca.id, pa, 9102);
  await user(9105, 'config_admin'); // Even a deliberately over-broad role must not grant business rights.

  const relation = async (p, e, source, employer) => (await run(leave.verifyRelationship, { input: {
    group_id: ga.id, person_id: p, employment_ids: [e], source_key: source, legal_employer_key: employer,
    jurisdiction: 'CN', valid_from: '2026-01-01', evidence_ref: '虚构已核关系证据',
    qualifications: { continuous_work_12_months: true, service_years: '11' }
  } })).relationship;
  const ra = await relation(pa, ea.id, 'FAKE-REL-A', 'FAKE-EMPLOYER-A');
  const rb = await relation(pa, eb.id, 'FAKE-REL-B', 'FAKE-EMPLOYER-B');
  const makeScheme = async (code, company, statutory = false, jurisdiction = 'CN', unit = 'day') => {
    const scheme = (await run(leave.createScheme, { input: { group_id: ga.id, company_id: company, code,
      name: `虚构${code}方案`, jurisdiction, unit, statutory, valid_from: '2026-01-01', rules: {
        quantity_basis: 'calendar', step: '0.5', calendar_version: 'FAKE-REVIEWED-CALENDAR-NOV2026',
        calendar_status:'verified',calendar_valid_from:'2026-11-01',calendar_valid_to:'2026-12-01',
        rest_dates: [], holiday_dates: [], legal_rule_ref: 'FAKE-CN-ANNUAL-2008', legal_review_ref: '虚构法律适用核定',
        expiry_action: statutory ? 'legal_review' : 'expire', proration_denominator: 365, proration_rounding: 'floor'
      } } })).scheme;
    return (await run(leave.publishScheme, { id: scheme.id }, 9102)).scheme;
  };
  const sa = await makeScheme('annual', ca.id, true), sb = await makeScheme('annual', cb.id, true);
  const sw = await makeScheme('welfare', ca.id);
  const hk = await makeScheme('annual', null, true, 'HK');
  const grantInput = (r, s, stable, total = '10') => ({ relationship_id: r.id, scheme_id: s.id, code: s.code,
    stable_key: stable, event_key: 'FAKE-INITIAL', total, numerator: '1', denominator: '1',
    valid_from: '2026-01-01', expires_on: '2026-12-31', entitlement_year: 2026, evidence_ref: '虚构授予证据' });
  const ia = grantInput(ra, sa, 'FAKE-LOT-A'), ib = grantInput(rb, sb, 'FAKE-LOT-B');
  const aa = await run(leave.grantCumulative, { input: ia });
  const ab = await run(leave.grantCumulative, { input: ib });
  const aw = await run(leave.grantCumulative, { input: grantInput(ra, sw, 'FAKE-LOT-W', '5') });
  const request = (account, scheme, emp, key, day) => ({ account_id: account, scheme_id: scheme, employment_id: emp,
    request_key: key, starts_at: `${day}T00:00:00+08:00`, ends_at: `${day}T00:00:00+08:00` });
  const dayRequest = (account, scheme, emp, key, day, next) => ({ ...request(account, scheme, emp, key, day), ends_at: `${next}T00:00:00+08:00` });

  await check('直接SQL拒绝跨集团人员关系引用', () => sqlRejected(
    "INSERT INTO ty_leave_relationship(group_id,person_id,source_key,legal_employer_key,jurisdiction,valid_from,verified_by,evidence_ref) VALUES($1,$2,'BAD-GROUP','FAKE-X','CN','2026-01-01',9101,'虚构错误证据')", [ga.id, po]));
  await check('直接SQL拒绝同集团异人雇佣映射', () => sqlRejected(
    'INSERT INTO ty_leave_relationship_employment VALUES($1,$2)', [ra.id, ec.id]));
  await check('直接SQL拒绝异集团雇佣映射', () => sqlRejected(
    'INSERT INTO ty_leave_relationship_employment VALUES($1,$2)', [ra.id, eo.id]));
  await check('直接SQL拒绝把法定额度降为福利额度', () => sqlRejected(
    "INSERT INTO ty_leave_lot(account_id,stable_key,scheme_id,entitlement_year,valid_from,statutory) VALUES($1,'BAD-STAT',$2,2026,'2026-01-01',false)", [aa.account_id, sa.id]));
  await check('直接SQL拒绝额度地区与实际关系不一致', () => sqlRejected(
    "INSERT INTO ty_leave_lot(account_id,stable_key,scheme_id,entitlement_year,valid_from,statutory) VALUES($1,'BAD-REGION',$2,2026,'2026-01-01',true)", [aa.account_id, hk.id]));
  await check('直接SQL拒绝另一公司专属方案用于本账户', () => sqlRejected(
    "INSERT INTO ty_leave_lot(account_id,stable_key,scheme_id,entitlement_year,valid_from,statutory) VALUES($1,'BAD-COMPANY',$2,2026,'2026-01-01',true)", [aa.account_id, sb.id]));
  await check('直接SQL拒绝原法定批次改标志绕过清零守卫', () => sqlRejected(
    'UPDATE ty_leave_lot SET statutory=false WHERE id=$1', [aa.lot.id]));
  await check('直接SQL拒绝法定批次过期扣销', () => sqlRejected(
    "INSERT INTO ty_leave_event(lot_id,event_key,event_kind,delta,evidence_ref,actor_id) VALUES($1,'BAD-EXP','expire',-1,'虚构过期理由',9101)", [aa.lot.id]));
  await check('直接SQL拒绝通过改账户父关系搬运历史额度', () => sqlRejected(
    'UPDATE ty_leave_account SET relationship_id=$1 WHERE id=$2', [rb.id, aw.account_id]));
  await check('直接SQL拒绝通过改实际关系人员搬运历史额度', () => sqlRejected(
    'UPDATE ty_leave_relationship SET person_id=$1 WHERE id=$2', [pc, ra.id]));
  await check('直接SQL申请不得引用未映射的异人员雇佣', () => rejected(async tx => {
    // Supply an otherwise balanced allocation so a generic deferred balance
    // failure cannot masquerade as the required identity/reference rejection.
    const r = await one("INSERT INTO ty_leave_request(account_id,scheme_id,employment_id,request_key,starts_at,ends_at,quantity,facts,created_by) VALUES($1,$2,$3,'BAD-EMP','2026-11-20T00:00+08:00','2026-11-21T00:00+08:00',1,'{}',9101)RETURNING id", [aa.account_id, sa.id, ec.id], tx);
    await tx.query("INSERT INTO ty_leave_allocation(account_id,request_id,lot_id,quantity,state)VALUES($1,$2,$3,1,'held')", [aa.account_id,r.id,aa.lot.id]);
  }, ['23503','23514']));

  await check('公司HR规则查询只返回有权公司方案', async () => {
    const view = await run(leave.queryWorkspace, { accountId: aa.account_id, groupId: ga.id }, 9103);
    assert.ok(view.schemes.some(s => String(s.id) === String(sa.id)));
    assert.ok(!view.schemes.some(s => String(s.id) === String(sb.id)));
    assert.ok(!view.accounts.some(a => String(a.id) === String(ab.account_id)));
  });
  await check('服务拒绝另一公司方案用于本店发放', () => rejected(tx => leave.grantCumulative(tx, { userId: 9103,
    input: { ...ia, scheme_id: sb.id, stable_key: 'BAD-SERVICE-SCHEME', event_key: 'BAD' } }), ['E_TY_ARGUMENT', 'E_TY_FORBIDDEN']));
  // The parallel account above belongs to the same person and is legitimately self-readable.
  // Build a second person's account before the actual impersonation checks below.
  const rc = await relation(pc, ec.id, 'FAKE-REL-C', 'FAKE-EMPLOYER-A');
  const ac = await run(leave.grantCumulative, { input: grantInput(rc, sa, 'FAKE-LOT-C') });
  await check('本人入口允许同一永久人员的并行真实关系', async () => {
    const mine = await run(leave.balance, { accountId: ab.account_id, self: true }, 9104);
    assert.equal(String(mine.account.person_id), String(pa));
  });
  await check('本人入口拒绝真正其他人员并忽略伪造身份字段', () => rejected(tx => leave.submitRequest(tx,
    { userId: 9104, self: true, input: { ...dayRequest(ac.account_id, sa.id, ec.id, 'BAD-SELF', '2026-11-20', '2026-11-21'),
      userId: 9101, person_id: pa, group_id: ga.id } }), ['E_TY_FORBIDDEN']));
  await check('普通员工省略self查询仍只读本人', async () => {
    const mine = await run(leave.balance, { accountId: aa.account_id, self: false }, 9104);
    assert.equal(String(mine.account.person_id), String(pa));
  });
  await check('本人权限不能替代HR权限制造工资候选', () => rejected(tx => leave.createPayrollCandidate(tx,
    { userId: 9104, input: { account_id: aa.account_id, parent_key: 'BAD-SELF-PAY', currency: 'CNY',
      revision: 1, target: '800', normal_covered: '0', source_ref: '虚构恶意自报来源' } }), ['E_TY_FORBIDDEN']));
  await check('本人权限不能替代HR权限预演人工增额', () => rejected(tx => leave.previewAdjustment(tx,
    { userId: 9104, operationId: 'BAD-SELF-ADJUST', input: { lot_id: aa.lot.id, mode: 'delta', value: '1',
      evidence_ref: '虚构恶意增额证据', reason: '虚构恶意自增假期' } }), ['E_TY_FORBIDDEN']));
  await check('本人权限不能替代HR权限新增权益批次', () => rejected(tx => leave.grantCumulative(tx,
    { userId: 9104, input: { ...ia, stable_key: 'BAD-SELF-LOT', event_key: 'BAD-SELF-GRANT' } }), ['E_TY_FORBIDDEN']));
  await check('配置admin即使误配业务角色也不能读取工资假期业务', () => rejected(tx => leave.balance(tx,
    { userId: 9105, accountId: aa.account_id }), ['E_TY_FORBIDDEN']));
  await check('请求幂等重放只保留一份预占且不同内容拒绝', async () => {
    const input = dayRequest(aa.account_id, sa.id, ea.id, 'FAKE-REQ-ONE', '2026-11-20', '2026-11-21');
    const first = await run(leave.submitRequest, { input });
    const replay = await run(leave.submitRequest, { input });
    assert.equal(String(replay.request.id), String(first.request.id));
    dec((await amount(aa.lot.id)).held, '1');
    await rejected(tx => leave.submitRequest(tx, { userId: 9101, input: { ...input, ends_at: '2026-11-22T00:00:00+08:00' } }), ['E_TY_CONFLICT']);
    dec((await amount(aa.lot.id)).held, '1');
  });
  await check('同一实际关系不同假种不得重复解释同一时间', () => rejected(tx => leave.submitRequest(tx,
    { userId: 9101, input: dayRequest(aw.account_id, sw.id, ea.id, 'BAD-OVERLAP', '2026-11-20', '2026-11-21') }), ['E_TY_CONFLICT', '23P01']));
  await check('同人不同真实关系允许各自有效请假', async () => {
    await run(leave.submitRequest, { input: dayRequest(ab.account_id, sb.id, eb.id, 'FAKE-PARALLEL', '2026-11-20', '2026-11-21') });
    dec((await amount(ab.lot.id)).held, '1');
  });
  await check('直接SQL跨假种时间重叠也被数据库拒绝', () => sqlRejected(
    "INSERT INTO ty_leave_request(account_id,scheme_id,employment_id,request_key,starts_at,ends_at,quantity,facts,created_by) VALUES($1,$2,$3,'BAD-DIRECT-OVERLAP','2026-11-20T00:00+08:00','2026-11-21T00:00+08:00',1,'{}',9101)", [aw.account_id, sw.id, ea.id], ['23P01']));
  await check('并发跨假种申请最多一份成功且余额守恒', async () => {
    const outcomes = await Promise.allSettled([
      run(leave.submitRequest, { input: dayRequest(aa.account_id, sa.id, ea.id, 'FAKE-RACE-A', '2026-11-24', '2026-11-25') }),
      run(leave.submitRequest, { input: dayRequest(aw.account_id, sw.id, ea.id, 'FAKE-RACE-W', '2026-11-24', '2026-11-25') })
    ]);
    assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    const failures = outcomes.filter(x => x.status === 'rejected');
    assert.ok(failures.every(x => ['E_TY_CONFLICT', '23P01'].includes(errorCode(x.reason))));
    assert.equal(Number((await one("SELECT count(*) n FROM ty_leave_request r JOIN ty_leave_account a ON a.id=r.account_id WHERE a.relationship_id=$1 AND starts_at='2026-11-24T00:00+08:00'", [ra.id])).n), 1);
  });
  await check('调额CAS在新预占后拒绝旧批准且未删占用', async () => {
    const preview = await run(leave.previewAdjustment, { input: { lot_id: aa.lot.id, mode: 'target_available', value: '7',
      evidence_ref: '虚构调额证据', reason: '虚构已核更正', legal_correction_ref: '虚构法定更正依据' } });
    await run(leave.submitRequest, { input: dayRequest(aa.account_id, sa.id, ea.id, 'FAKE-CAS-RESERVE', '2026-11-27', '2026-11-28') });
    const before = await amount(aa.lot.id);
    await rejected(tx => leave.applyAdjustment(tx, { userId: 9102, id: preview.adjustment.id }), ['E_TY_CONFLICT']);
    assert.deepEqual(await amount(aa.lot.id), before);
    assert.equal(Number((await one("SELECT count(*) n FROM ty_leave_event WHERE lot_id=$1 AND event_key=$2", [aa.lot.id, `adjust:${preview.adjustment.id}`])).n), 0);
  });
  await check('人工调额拒绝自审、双人执行及重试只落一笔', async () => {
    const p = await run(leave.previewAdjustment, { input: { lot_id: aa.lot.id, mode: 'delta', value: '1',
      evidence_ref: '虚构增额证据', reason: '虚构复核增额' } });
    await rejected(tx => leave.applyAdjustment(tx, { userId: 9101, id: p.adjustment.id }), ['E_LEAVE_SELF_APPROVE']);
    await run(leave.applyAdjustment, { id: p.adjustment.id }, 9102);
    const replay = await run(leave.applyAdjustment, { id: p.adjustment.id }, 9102);
    assert.equal(replay.replayed, true);
    dec((await amount(aa.lot.id)).granted, '11');
    assert.equal(Number((await one("SELECT count(*) n FROM ty_leave_event WHERE lot_id=$1 AND event_key=$2", [aa.lot.id, `adjust:${p.adjustment.id}`])).n), 1);
  });
  await check('授予同键同内容重试不重复、不同内容不覆盖', async () => {
    await run(leave.grantCumulative, { input: ia });
    const before = await amount(aa.lot.id);
    await rejected(tx => leave.grantCumulative(tx, { userId: 9101, input: { ...ia, total: '12' } }), ['E_TY_CONFLICT']);
    assert.deepEqual(await amount(aa.lot.id), before);
  });
  await check('工资采用父义务唯一、版本替代只记净差且不等于付款', async () => {
    const input = { account_id: aa.account_id, parent_key: 'FAKE-ONE-PAY-OBLIGATION', currency: 'CNY',
      revision: 1, target: '800', normal_covered: '600', source_ref: 'FAKE-APPROVED-SOURCE-1' };
    const c = await run(leave.createPayrollCandidate, { input });
    for (let n = 0; n < 3; n++) await run(leave.createPayrollCandidate, { input });
    await rejected(tx => leave.adoptPayrollCandidate(tx, { userId: 9101, id: c.obligation.id,
      commandKey: 'BAD-PAY-SELF-APPROVE', revision: 1, payrollBatchRef: 'FAKE-BATCH-1' }), ['E_LEAVE_SELF_APPROVE']);
    const first = await run(leave.adoptPayrollCandidate, { id: c.obligation.id, commandKey: 'FAKE-ADOPT-1', revision: 1, payrollBatchRef: 'FAKE-BATCH-1' }, 9102);
    dec(first.adoption.delta, '200'); assert.equal(first.bank_instruction_created, false);
    const replay = await run(leave.adoptPayrollCandidate, { id: c.obligation.id, commandKey: 'FAKE-ADOPT-ALIAS', revision: 1, payrollBatchRef: 'FAKE-BATCH-1' }, 9102);
    assert.equal(replay.replayed, true);
    await run(leave.createPayrollCandidate, { input: { ...input, revision: 2, target: '900', source_ref: 'FAKE-APPROVED-SOURCE-2' } });
    const second = await run(leave.adoptPayrollCandidate, { id: c.obligation.id, commandKey: 'FAKE-ADOPT-2', revision: 2, payrollBatchRef: 'FAKE-BATCH-2' }, 9102);
    dec(second.adoption.delta, '100');
    const stale = await run(leave.createPayrollCandidate, { input }); assert.equal(stale.stale, true);
    await rejected(tx => leave.adoptPayrollCandidate(tx, { userId: 9101, id: c.obligation.id, commandKey: 'BAD-STALE', revision: 1, payrollBatchRef: 'FAKE-BATCH-3' }), ['E_TY_CONFLICT']);
    assert.equal(Number((await one('SELECT count(*) n FROM ty_leave_payroll_obligation WHERE account_id=$1 AND parent_key=$2', [aa.account_id, input.parent_key])).n), 1);
    const sums = await one('SELECT count(*) n,sum(delta)::text delta FROM ty_leave_payroll_adoption WHERE obligation_id=$1', [c.obligation.id]);
    assert.equal(Number(sums.n), 2); dec(sums.delta, '300');
  });

  const failed = results.filter(x => !x.pass);
  console.log(JSON.stringify({ suite: 'advanced-leave-security', driver: db.driver, tests: results.length,
    passed: results.length - failed.length, failed: failed.length, skipped: 0, wholly_fictional: true }));
  if (failed.length) process.exitCode = 1;
} finally { await db.close(); }
