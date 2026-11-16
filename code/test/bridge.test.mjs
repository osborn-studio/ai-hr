// Explicit bridge regression; isolated app/database and fictitious fixtures only.
import { createApp } from '../app/server.mjs';
import { withTx } from '../app/db.mjs';
import * as bridge from '../app/services/foundation-bridge.mjs';
import * as roster from '../app/services/roster-write.mjs';
import * as training from '../app/services/training.mjs';
import { toHttp } from '../app/errors.mjs';

const { server, db } = await createApp();
console.log(`天意显式桥接驱动：${process.env.DATABASE_URL ? '真实 PostgreSQL / createApp' : 'PGlite / createApp'}`);
const results = [];
const rec = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];
const insert = async (table, data) => {
  const keys = Object.keys(data);
  return Number((await one(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(data))).id);
};
const reject = async (name, fn, codes = []) => {
  try { await fn(); rec(name, false, 'unexpectedly accepted'); }
  catch (e) {
    const businessCode = toHttp(e).body.error;
    rec(name, !codes.length || codes.includes(e.code) || codes.includes(businessCode), `${e.code || ''}/${businessCode} ${String(e.message).split('\n')[0]}`);
  }
};
const call = (method, input) => withTx(db, tx => bridge[method](tx, { userId: 1000, input }));
try {
  await db.query("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES(1000,'bridgeadmin','桥接测试管理员'),(1001,'bridgeread','桥接测试只读')");
  await db.query("INSERT INTO sys_data_scope(id,name,combinator) VALUES(100,'桥接测试范围','intersection') ON CONFLICT(id) DO NOTHING");
  await db.query("INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,effective_from) VALUES(999111,1000,10,100,'2020-01-01')");
  const group = await insert('ty_group', { code: 'BRIDGE', name: '桥接测试集团' });
  const ledger = await insert('ty_ledger', { group_id: group, scope_mode: 'group', code: 'L1', name: '桥接测试帐套' });
  const ledger2 = await insert('ty_ledger', { group_id: group, scope_mode: 'group', code: 'L2', name: '桥接第二帐套' });
  const company = await insert('ty_company', { group_id: group, ledger_id: ledger, code: 'C1', name: '桥接甲公司' });
  const company2 = await insert('ty_company', { group_id: group, ledger_id: ledger2, code: 'C2', name: '桥接乙公司' });
  const person = Number((await one("SELECT fn_ty_create_person($1,'P00001','桥接虚构人员') id", [group])).id);
  const employment = await insert('ty_employment', { group_id: group, person_id: person, company_id: company, hire_date: '2026-01-01' });
  await insert('ty_access_grant', { account_id: 1001, group_id: group, company_id: company, ledger_id: ledger, can_read: true, valid_from: '2020-01-01' });
  const before = await withTx(db, tx => bridge.status(tx, { userId: 1000, companyId: company }));
  rec('新人员与公司默认未映射，不假称兼容就绪', !before.readiness.organization && !before.readiness.people && !before.readiness.payroll_inputs);
  rec('默认未映射人员不复制到旧person', (await one('SELECT legacy_person_id FROM ty_person WHERE id=$1', [person])).legacy_person_id === null);
  await reject('非管理员不能预览/提交桥接', () => withTx(db, tx => bridge.preview(tx, { userId: 1001, input: { company_id: company } })), ['E_TY_FORBIDDEN']);
  const missing = await call('preview', { company_id: company, employment_ids: [employment] });
  rec('缺发薪社保主体的预览列出缺口，不猜测法人', !missing.ready && missing.problems.some(p => p.includes('发薪主体')) && missing.problems.some(p => p.includes('社保主体')));
  rec('预览不创建公司适配节点', Number((await one('SELECT count(*) n FROM ty_legacy_company_binding')).n) === 0);
  await reject('未显式确认不执行桥接', () => call('commit', { company_id: company }), ['E_TY_ARGUMENT']);
  await db.query("INSERT INTO legal_entity(id,name) VALUES(19001,'桥接显式发薪主体'),(19002,'桥接显式社保主体')");
  const parent = Number((await one('SELECT id FROM org_unit WHERE parent_id IS NULL ORDER BY id LIMIT 1')).id);
  const input = { company_id: company, legacy_parent_org_id: parent, payroll_legal_entity_id: 19001,
    si_legal_entity_id: 19002, effective_from: '2026-01-01', employment_ids: [employment], confirm: true,
    salary_standards: [{ employment_id: employment, monthly_amount: 6000, effective_from: '2026-01-01' }] };
  const p = await call('preview', input);
  rec('明确组织/双主体/雇佣和薪资后预览可执行', p.ready && p.plan.payroll_legal_entity_id !== p.plan.si_legal_entity_id);
  const applied = await call('commit', input);
  const mapping = applied.people[0];
  const orgId = Number(applied.organization.legacy_org_id);
  const oldPerson = Number(mapping.legacy_person_id);
  const oldEmployment = Number(mapping.legacy_employment_id);
  rec('显式桥接建立稳定公司适配键', applied.committed && Number((await one('SELECT legacy_org_id FROM ty_company WHERE id=$1', [company])).legacy_org_id) === orgId);
  rec('旧dept仅是兼容键，新版不出现同名内部部门', (await one('SELECT kind FROM org_unit WHERE id=$1', [orgId])).kind === 'dept' && Number((await one('SELECT count(*) n FROM ty_department WHERE company_id=$1', [company])).n) === 0);
  rec('人员与雇佣显式映射，不把新ID当旧ID传递', Number((await one('SELECT legacy_person_id FROM ty_person WHERE id=$1', [person])).legacy_person_id) === oldPerson && Number((await one('SELECT legacy_employment_id FROM ty_employment WHERE id=$1', [employment])).legacy_employment_id) === oldEmployment);
  rec('集团永久号保持，旧工号用集团命名空间避免撞号', (await one('SELECT person_number FROM ty_person WHERE id=$1', [person])).person_number === 'P00001' && (await one('SELECT no FROM employee_no WHERE assigned_person_id=$1', [oldPerson])).no === `G${group}:P00001`);
  const dims = await q('SELECT dim_code,org_id FROM employee_org_assignment WHERE employee_id=$1', [oldPerson]);
  rec('四维归属分别建立，发薪社保主体不会合并', dims.length === 4 && Number(dims.find(d => d.dim_code === 'cost_org').org_id) === orgId && Number(dims.find(d => d.dim_code === 'attendance_org').org_id) === orgId && Number(dims.find(d => d.dim_code === 'payroll_legal_entity').org_id) === 19001 && Number(dims.find(d => d.dim_code === 'si_entity').org_id) === 19002);
  rec('旧薪资标准仅来自显式批准输入', Number((await one('SELECT monthly_amount FROM salary_standard WHERE employment_id=$1', [oldEmployment])).monthly_amount) === 6000);
  const repeated = await call('commit', input);
  rec('重复桥接幂等，不复制自然人、雇佣或四维段', Number(repeated.people[0].legacy_person_id) === oldPerson && Number(repeated.people[0].legacy_employment_id) === oldEmployment && Number((await one('SELECT count(*) n FROM employee_org_assignment WHERE employee_id=$1', [oldPerson])).n) === 4 && Number((await one('SELECT count(*) n FROM salary_standard WHERE employment_id=$1', [oldEmployment])).n) === 1);
  const onlyRead = await withTx(db, tx => bridge.status(tx, { userId: 1001, companyId: company }));
  rec('新公司只读授权不会自动变成旧业务权限', !onlyRead.legacy_authorization.ready && !Object.values(onlyRead.legacy_authorization.roles).some(Boolean));
  await reject('跨公司雇佣不能混入当前桥接', () => call('commit', { ...input, company_id: company2 }), ['E_TY_ARGUMENT']);
  await reject('同日不同薪资标准不会静默覆盖', () => call('commit', { ...input, salary_standards: [{ employment_id: employment, monthly_amount: 7000, effective_from: '2026-01-01' }] }), ['23514']);
  rec('失败事务回滚后原薪资标准保留', Number((await one('SELECT monthly_amount FROM salary_standard WHERE employment_id=$1', [oldEmployment])).monthly_amount) === 6000);

  // Explicit old-domain role + scope, separately from new ty_access_grant.
  const scope = await insert('sys_data_scope', { name: '显式兼容四维范围', combinator: 'intersection' });
  for (const [dim, kind, values] of [['cost_org', 'nodes', [orgId]], ['attendance_org', 'nodes', [orgId]], ['payroll_legal_entity', 'nodes', [19001]], ['si_entity', 'nodes', [19002]]]) {
    await db.query('INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES($1,$2,$3,$4)', [scope, dim, kind, values]);
  }
  await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from) VALUES(1000,1,$1,'2020-01-01')", [scope]);
  await withTx(db, async tx => {
    await tx.query("SELECT app_begin_scope(1000,'employee_roster',NULL)");
    const visible = (await tx.query("SELECT employee_id FROM fn_emp_roster('2026-01-15') WHERE employee_id=$1", [oldPerson])).rows;
    rec('明确旧四维授权后兼容花名册能看到新映射人员', visible.length === 1);
  });
  const scheduled = await withTx(db, tx => roster.assign(tx, { userId: 1000, employeeId: oldPerson, date: '2026-01-15', shift: 'EARLY', storeId: orgId, reason: '桥接回归排班' }));
  rec('兼容排班真实服务能为桥接人员落排班', !!scheduled && Number((await one('SELECT count(*) n FROM schedule WHERE employee_id=$1 AND store_id=$2', [oldPerson, orgId])).n) === 1);
  const course = await withTx(db, tx => training.createCourse(tx, { userId: 1000, code: 'BRIDGE-TRAIN', name: '桥接测试课程', category: 'skill', stdHours: 2 }));
  const session = await withTx(db, tx => training.createSession(tx, { userId: 1000, courseId: course.id, entityId: 19001, date: '2026-01-15', fromTime: '09:00', toTime: '11:00', hours: 2, capacity: 5 }));
  const enrolled = await withTx(db, tx => training.enroll(tx, { userId: 1000, sessionId: session.id, employeeIds: [oldPerson] }));
  rec('兼容培训真实服务能为桥接人员报名', !!enrolled && Number((await one('SELECT count(*) n FROM training_enrollment WHERE employee_id=$1 AND session_id=$2', [oldPerson, session.id])).n) === 1);

  await db.query("SELECT fn_ty_end_employment($1,'2026-01-31')", [employment]);
  rec('已映射雇佣结束同步到旧雇佣', String((await one('SELECT leave_date::text d FROM employment WHERE id=$1', [oldEmployment])).d) === '2026-01-31');
  rec('结束仅关闭桥接创建的四维段，旧模型采用含末日', (await q('SELECT valid_to::text d FROM employee_org_assignment WHERE employee_id=$1', [oldPerson])).every(x => x.d === '2026-01-31'));
  const rehire = await insert('ty_employment', { group_id: group, person_id: person, company_id: company2, hire_date: '2026-02-01', rehire_link: employment });
  await call('commit', { company_id: company2, legacy_parent_org_id: parent, payroll_legal_entity_id: 19001, si_legal_entity_id: 19002,
    effective_from: '2026-02-01', employment_ids: [rehire], confirm: true });
  rec('跨帐套复聘复用同一个旧自然人而新建旧雇佣段', Number((await one('SELECT person_id FROM employment WHERE id=(SELECT legacy_employment_id FROM ty_employment WHERE id=$1)', [rehire])).person_id) === oldPerson && Number((await one('SELECT count(*) n FROM employment WHERE person_id=$1', [oldPerson])).n) === 2);
  const notPaid = await withTx(db, tx => bridge.status(tx, { userId: 1000, companyId: company2 }));
  rec('未给薪资标准不视为薪资输入就绪', !notPaid.readiness.payroll_inputs);
  const parallel = await insert('ty_employment', { group_id: group, person_id: person, company_id: company, hire_date: '2026-02-01' });
  const conflict = await call('preview', { ...input, employment_ids: [parallel], salary_standards: [] });
  rec('并行雇佣在预览明确阻断，而非丢失一份归属', !conflict.ready && conflict.problems.some(p => p.includes('并行')));
  await reject('数据库函数也拒绝并行桥接', () => db.query('SELECT fn_ty_bridge_employment($1,1000)', [parallel]), ['23514']);
  rec('桥接审计保留明确动作', Number((await one("SELECT count(*) n FROM ty_audit WHERE action='legacy_bridge'")).n) >= 3);
} catch (e) {
  rec('桥接回归前置与完整链路', false, `${e.code || ''} ${String(e.message).split('\n')[0]}`);
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await db.close();
}
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` [${r.detail}]` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`天意显式桥接 · ${results.length} 条 · 通过 ${results.length - failed} · 失败 ${failed}`);
process.exitCode = failed ? 1 : 0;
