// Full synthetic prerequisite build + real service seeder. Disposable empty DB only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createDb, withTx } from '../app/db.mjs';
import { seed as seedWorkspace } from '../app/services/test-workspace.mjs';
import { seed as seedAccounts } from '../app/services/test-accounts.mjs';
import { upgradeDemo } from '../app/services/organization.mjs';
import { seed as seedOutsourcing } from '../app/services/outsourcing-demo.mjs';
import { seedOctober } from '../app/services/advanced-time-demo.mjs';
import { seedAdvancedLeaveDemo, VERSION } from '../tools/seed-advanced-leave-demo.mjs';
import * as leave from '../app/services/advanced-leave.mjs';

const db = await createDb({ url: process.env.DATABASE_URL || undefined });
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await q(sql, args))[0];
let checks = 0;
const check = (label, value) => { assert.ok(value, label); checks++; console.log('PASS ' + label); };
const run = (fn, args = {}, actor = 9000) => withTx(db, t => fn(t, { ...args, userId: actor }));
const secretFingerprint = async () => createHash('sha256').update(JSON.stringify(
  await q('SELECT user_id,pwd_hash FROM sys_user_credential ORDER BY user_id'))).digest('hex');
try {
  assert.equal(Number((await one("SELECT count(*) n FROM pg_tables WHERE schemaname='public'")).n), 0,
    'Demo test may never modify an existing database');
  await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
  const dir = new URL('../db/', import.meta.url);
  for (const f of readdirSync(dir).filter(x => /^\d{3}_.*\.sql$/.test(x)).sort())
    await db.exec('BEGIN;\n' + readFileSync(new URL(f, dir), 'utf8') + '\nCOMMIT;');
  await db.initSession();
  await assert.rejects(() => seedAdvancedLeaveDemo(db), /confirm-synthetic/); checks++;
  await assert.rejects(() => seedAdvancedLeaveDemo(db, { confirmSynthetic: true }), /TY-TEST/); checks++;
  await db.exec("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES(9000,'tyhr_admin','虚构技术初始化');\n" +
    "INSERT INTO sys_data_scope(id,name,combinator)VALUES(9000,'虚构初始权限','intersection');\n" +
    "INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)VALUES(9000,10,9000,'2026-01-01','ROLE','fully synthetic fixture');");
  const w = await run(seedWorkspace, { input: { confirm_synthetic: true } });
  await run(seedAccounts, { input: { group_id: w.group_id, confirm_synthetic: true, include_work_area_assignments: true } });
  await run(upgradeDemo);
  await run(seedOctober, { input: { confirm_synthetic: true } });
  await run(seedOutsourcing, { input: { confirm_synthetic: true } });
  const base = await one(`SELECT (SELECT count(*) FROM ty_person WHERE group_id=$1)::int people,
    (SELECT count(*) FROM ty_test_account_profile WHERE group_id=$1)::int accounts`, [w.group_id]);
  check('Prerequisite is actual unified 62-person/77-account fictional workspace', base.people === 62 && base.accounts === 77);
  const fingerprint = await secretFingerprint();
  const beforeEvents = await one('SELECT count(*)::int n FROM ty_leave_event');
  const index = await seedAdvancedLeaveDemo(db, { confirmSynthetic: true });
  check('First import reports stable synthetic version and completed receipt', index.version === VERSION && index.complete && index.synthetic && !index.replayed);
  check('No people, accounts, passwords or external receipts created', index.created_people === 0 && index.created_accounts === 0 && index.changed_passwords === 0 && index.external_receipts === 0);
  check('Credentials unchanged byte for byte', fingerprint === await secretFingerprint());
  const scenarios = new Map(index.scenes.map(s => [s.key, s]));
  check('Active CN annual example is not a statutory holiday', !['2026-10-01','2026-10-02','2026-10-03'].includes(
    new Date(Date.parse(scenarios.get('CN-PENDING').data.starts_at) + 8*3600000).toISOString().slice(0,10)));
  check('Scene index links existing person numbers, operator roles and actual data IDs', index.scenes.length >= 16 && index.scenes.every(s => s.person_number && s.operator.login && s.relationship_id && Object.keys(s.data).length));
  const statuses = await q('SELECT id,status FROM ty_leave_request');
  for (const [key, status] of [['CN-TAKEN','taken'],['CN-PENDING','pending'],['CN-CANCELLED','cancelled'],
    ['HK-FUTURE-APPROVED','approved'],['HK-REJECTED','rejected'],['HK-SICK-PENDING','pending'],['CN-MULTISHIFT-MINUTES','pending']]) {
    const s = scenarios.get(key);
    check('Actual service request status ' + key, statuses.some(r => String(r.id) === String(s?.data.request_id) && r.status === status));
  }
  const minute = scenarios.get('CN-MULTISHIFT-MINUTES');
  const minuteRequest = await one('SELECT quantity::text,facts FROM ty_leave_request WHERE id=$1', [minute.data.request_id]);
  check('Two half-hours across real split shifts consume 60 minutes, not the intervening gap', Number(minuteRequest.quantity) === 60 && minuteRequest.facts.minutes === 60);
  const pending = scenarios.get('ADJUST-PENDING'), applied = scenarios.get('ADJUST-APPROVED');
  check('Pending manual correction is not already posted', !(await one('SELECT applied_at FROM ty_leave_adjustment WHERE id=$1', [pending.data.adjustment_id])).applied_at);
  check('Reviewed manual correction has actual second-person approval', !!(await one('SELECT applied_at FROM ty_leave_adjustment WHERE id=$1', [applied.data.adjustment_id])).applied_at);
  const templateSchemes = await q("SELECT status,rules FROM ty_leave_scheme WHERE code LIKE 'demo-%pending'");
  check('Unverified maternity/childcare/local sick/TOIL templates stay draft and disabled', templateSchemes.length === 6 && templateSchemes.every(s => s.status === 'draft' && s.rules.enabled === false));
  check('Unknown childcare entitlement is null, never a national default or zero', templateSchemes.some(s => Object.hasOwn(s.rules, 'annual_days') && s.rules.annual_days === null));
  check('HK statutory annual entitlement follows actual uncompleted anniversaries', index.people.filter(p => p.region === 'HK').every(p => p.statutory_annual_days === '0'));
  check('Regional annual titles remain distinct even when account codes both equal annual',
    index.people.filter(p=>p.region==='HK').every(p=>p.annual_scheme_name==='香港法定年假·周年取得')
    && index.people.filter(p=>p.region==='CN').every(p=>p.annual_scheme_name==='内地法定年假·累计工龄'));
  check('HK extra annual is separate from legal annual', index.people.filter(p => p.region === 'HK').every(p => p.extra_annual_account_id && p.extra_annual_account_id !== p.annual_account_id));
  const pay = scenarios.get('PAYROLL-CANDIDATE-NET-DELTA');
  check('Two pay-source revisions exist under one obligation', Number((await one('SELECT count(*) n FROM ty_leave_payroll_source WHERE obligation_id=$1', [pay.data.obligation_id])).n) === 2);
  check('Candidate delta preview is 100 while no payroll adoption or bank receipt is fabricated', Number(pay.data.preview_delta) === 100 && Number((await one('SELECT count(*) n FROM ty_leave_payroll_adoption WHERE obligation_id=$1', [pay.data.obligation_id])).n) === 0);
  // Change a real pending approval after first initialization. Re-running must not
  // restore the demonstration's original desired status or duplicate its grants.
  const changed = scenarios.get('CN-PENDING');
  await run(leave.decideRequest, { id: changed.data.request_id, approve: false, reason: '虚构演示后由使用人驳回保留' }, index.roles.reviewer.account_id);
  const rowsBeforeReplay = await one(`SELECT (SELECT count(*) FROM ty_leave_event)::int events,
    (SELECT count(*) FROM ty_leave_request)::int requests,(SELECT count(*) FROM sys_user_role)::int roles`);
  const repeated = await seedAdvancedLeaveDemo(db, { confirmSynthetic: true });
  const rowsAfterReplay = await one(`SELECT (SELECT count(*) FROM ty_leave_event)::int events,
    (SELECT count(*) FROM ty_leave_request)::int requests,(SELECT count(*) FROM sys_user_role)::int roles`);
  check('Repeat returns original completed index without replaying business actions', repeated.replayed && repeated.existing_business_state_preserved && JSON.stringify(rowsBeforeReplay) === JSON.stringify(rowsAfterReplay));
  check('Repeat preserves user-changed approval and credentials', (await one('SELECT status FROM ty_leave_request WHERE id=$1', [changed.data.request_id])).status === 'rejected' && fingerprint === await secretFingerprint());
  check('Only one initialization receipt and no duplicated yearly grant roots', Number((await one("SELECT count(*) n FROM ty_audit WHERE entity_kind='advanced_leave_demo' AND after_data->>'version'=$1", [VERSION])).n) === 1 && Number((await one('SELECT count(*) n FROM ty_leave_event')).n) > beforeEvents.n);
  const command = fileURLToPath(new URL('../tools/seed-advanced-leave-demo.mjs', import.meta.url));
  for (const args of [[], ['--confirm-synthetic']]) {
    const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', env: {
      ...process.env, DATABASE_URL: '', PGLITE_DATA_DIR: '', CONTROL_URL: '' } });
    check('CLI rejects missing confirmation or persistent connection ' + JSON.stringify(args), result.status === 1 && result.stdout === '');
  }
  // An explicitly manufactured legacy fixture reproduces the first published
  // synthetic seeder's incorrect Oct-3 selection. It is not a new valid claim.
  const oldScene = scenarios.get('CN-PENDING');
  const legacy = await withTx(db, async tx => {
    const row = (await tx.query(`INSERT INTO ty_leave_request(account_id,scheme_id,employment_id,request_key,
      starts_at,ends_at,quantity,facts,created_by)VALUES($1,$2,$3,'LEGACY-CALENDAR-FIXTURE',
      '2026-10-03T10:00+08:00','2026-10-03T21:00+08:00',1,'{"synthetic_legacy_fixture":true}',$4)RETURNING *`,
      [oldScene.data.account_id,oldScene.data.scheme_id,oldScene.employment_id,index.roles.manager.account_id])).rows[0];
    await tx.query("INSERT INTO ty_leave_allocation(account_id,request_id,lot_id,quantity,state)VALUES($1,$2,$3,1,'held')",
      [oldScene.data.account_id,row.id,oldScene.data.lot_id]);
    return row;
  });
  const legacyIndex = structuredClone(index), bad = legacyIndex.scenes.find(s => s.key==='CN-PENDING');
  bad.data.request_id=legacy.id;bad.data.starts_at='2026-10-03T10:00:00+08:00';bad.data.ends_at='2026-10-03T21:00:00+08:00';
  await db.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'calendar_correction','advanced_leave_demo',$2,$3::jsonb)",
    [index.roles.manager.account_id,index.group_id,JSON.stringify(legacyIndex)]);
  const repaired = await seedAdvancedLeaveDemo(db,{confirmSynthetic:true});
  const replacement = repaired.scenes.find(s=>s.key==='CN-PENDING');
  check('Legacy wrong calendar example is corrected by cancellation and a new real request',
    repaired.corrected_legacy_calendar && (await one('SELECT status FROM ty_leave_request WHERE id=$1',[legacy.id])).status==='cancelled'
    && replacement.data.request_id!==legacy.id && (await one('SELECT status FROM ty_leave_request WHERE id=$1',[replacement.data.request_id])).status==='pending');
  check('Calendar correction retains the original user-reviewed request',
    (await one('SELECT status FROM ty_leave_request WHERE id=$1',[oldScene.data.request_id])).status==='rejected');
  check('Corrected calendar case is idempotent on another run',
    (await seedAdvancedLeaveDemo(db,{confirmSynthetic:true})).replayed && fingerprint===await secretFingerprint());
  console.log(JSON.stringify({ suite: 'advanced-leave-demo', checks, driver: db.driver,
    scenes: index.scenes.length, created_counts: index.created_counts, wholly_fictional: true, passwords_changed: 0 }));
} finally { await db.close(); }
