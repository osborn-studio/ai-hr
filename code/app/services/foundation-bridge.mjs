// Explicit new-domain -> legacy projection. Does not grant legacy permissions.
import { accessFor } from './foundation.mjs';
import { bizErr } from '../errors.mjs';
import { saveEntity } from './contract.mjs';

export const RESOURCES = ['ledger'];
const bad = message => { throw bizErr('E_TY_ARGUMENT', message); };
const id = (value, name, optional = false) => {
  if ((value === null || value === undefined || value === '') && optional) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) bad(`${name}必须是有效的正整数`);
  return n;
};
async function companyFor(tx, userId, companyId, write = false) {
  const access = await accessFor(tx, userId);
  const row = (await tx.query('SELECT * FROM ty_company WHERE id=$1', [id(companyId, '公司')])).rows[0];
  if (!row || !access.row({ ...row, company_id: row.id })) throw bizErr('E_TY_NOT_FOUND', '公司不存在或不在授权范围内');
  if (write && !access.admin) throw bizErr('E_TY_FORBIDDEN', '业务桥接仅限平台基础管理员，且不会自动授予旧业务权限');
  return { row, access };
}
export async function createLegalEntity(tx,{userId,input}) {
  const {row:company}=await companyFor(tx,userId,input.company_id,true);
  const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>96)bad('请填写不超过96字的正式主体名称');
  await tx.query('SELECT pg_advisory_xact_lock(20261116,160)');
  if((await tx.query('SELECT 1 FROM legal_entity WHERE name=$1',[name])).rows.length)bad('同名主体已存在，请核对后选择现有主体');
  const n=(await tx.query(`SELECT greatest(
    coalesce((SELECT max(id) FROM legal_entity),0),
    coalesce((SELECT max(legal_entity_id) FROM employment),0),
    coalesce((SELECT max(legal_entity_id) FROM pay_run),0),
    coalesce((SELECT max(payroll_legal_entity_id) FROM ty_legacy_company_binding),0),
    coalesce((SELECT max(si_legal_entity_id) FROM ty_legacy_company_binding),0))+1 id`)).rows[0].id;
  const row=await saveEntity(tx,{userId,id:n,name,creditCode:input.credit_code,
    address:input.address,stampName:input.stamp_name});
  await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)
    VALUES($1,'create_legal_entity','company',$2,$3::jsonb)`,[userId,company.id,JSON.stringify({legal_entity_id:row.id,name})]);
  return {row};
}
async function legacyAccess(tx, userId, binding) {
  const roles = {};
  for (const resource of ['employee_roster', 'attendance_daily', 'payroll_run', 'payslip']) {
    roles[resource] = !!(await tx.query('SELECT fn_role_can($1,$2,\'read\') ok', [userId, resource])).rows[0].ok;
  }
  const dimensions = { cost_org: false, attendance_org: false, payroll_legal_entity: false, si_entity: false };
  if (binding) {
    await tx.query("SELECT app_begin_scope($1,'employee_roster',NULL)", [userId]);
    for (const [dim, wanted, entity] of [
      ['cost_org', binding.legacy_org_id, false], ['attendance_org', binding.legacy_org_id, false],
      ['payroll_legal_entity', binding.payroll_legal_entity_id, true], ['si_entity', binding.si_legal_entity_id, true],
    ]) {
      const table = entity ? 'tmp_scope_entity' : 'tmp_scope_org';
      const key = entity ? 'entity_id' : 'org_id';
      dimensions[dim] = !!(await tx.query(`SELECT EXISTS(SELECT 1 FROM pg_temp.${table} s WHERE s.dim_code=$1 AND s.${key}=$2
        AND NOT EXISTS(SELECT 1 FROM pg_temp.tmp_scope_deny d WHERE d.dim_code=$1 AND d.${key}=$2)) ok`, [dim, wanted])).rows[0].ok;
    }
  }
  return { roles, dimensions, ready: Object.values(roles).every(Boolean) && Object.values(dimensions).every(Boolean),
    notice: '桥接不改变登录账号的旧资源、四维范围及字段权限；必须单独明确授权，未授权不会自动放开。' };
}
export async function status(tx, { userId, companyId }) {
  const { row: company, access } = await companyFor(tx, userId, companyId);
  const binding = (await tx.query('SELECT * FROM ty_legacy_company_binding WHERE company_id=$1', [company.id])).rows[0] || null;
  const employments = (await tx.query(`SELECT e.id,e.person_id,e.hire_date,e.leave_date,e.status,e.legacy_employment_id,
    p.person_number,p.full_name,p.legacy_person_id,
    EXISTS(SELECT 1 FROM salary_standard s WHERE s.employment_id=e.legacy_employment_id) salary_configured
    FROM ty_employment e JOIN ty_person p ON p.id=e.person_id WHERE e.company_id=$1 ORDER BY e.hire_date,e.id`, [company.id])).rows;
  const permissions = await legacyAccess(tx, userId, binding);
  return { company, binding, employments, legacy_authorization: permissions,
    readiness: { organization: !!binding, people: !!binding && employments.length > 0 && employments.every(e => e.legacy_employment_id && e.legacy_person_id),
      payroll_inputs: !!binding && employments.length > 0 && employments.every(e => e.legacy_employment_id && e.salary_configured),
      legacy_access: permissions.ready },
    choices: access.admin ? {
      legacy_organizations: (await tx.query('SELECT id,parent_id,name,path,kind FROM org_unit ORDER BY path,id')).rows,
      legal_entities: (await tx.query('SELECT id,name FROM legal_entity ORDER BY id')).rows,
    } : {},
    notice: '未映射的新公司和人员不会自动出现在兼容业务中。工资输入就绪不代表考勤已确认、政策适用或已算薪。' };
}
export async function preview(tx, { userId, input }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('请提交桥接配置对象');
  const { row: company } = await companyFor(tx, userId, input.company_id, true);
  const binding = (await tx.query('SELECT * FROM ty_legacy_company_binding WHERE company_id=$1', [company.id])).rows[0] || null;
  const parentId = id(input.legacy_parent_org_id, '兼容父组织', true);
  const orgId = id(input.legacy_org_id, '已有兼容门店节点', true);
  const payrollId = id(input.payroll_legal_entity_id ?? binding?.payroll_legal_entity_id, '发薪主体', true);
  const siId = id(input.si_legal_entity_id ?? binding?.si_legal_entity_id, '社保主体', true);
  const from = input.effective_from ?? binding?.effective_from;
  const fromDate = from instanceof Date ? from.toISOString().slice(0, 10) : String(from || '');
  const problems = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) problems.push('请明确桥接生效日');
  if (!payrollId || !(await tx.query('SELECT 1 FROM legal_entity WHERE id=$1', [payrollId])).rows.length) problems.push('请先维护并选择明确的发薪主体');
  if (!siId || !(await tx.query('SELECT 1 FROM legal_entity WHERE id=$1', [siId])).rows.length) problems.push('请先维护并选择明确的社保主体');
  if (!binding && !orgId && !company.legacy_org_id && !parentId && input.create_legacy_root !== true) problems.push('请选择旧业务父节点，或在空兼容域显式建立根节点');
  if (parentId && !(await tx.query('SELECT 1 FROM org_unit WHERE id=$1', [parentId])).rows.length) problems.push('兼容父节点不存在');
  if (orgId && !(await tx.query("SELECT 1 FROM org_unit WHERE id=$1 AND kind='dept'", [orgId])).rows.length) problems.push('已有兼容门店节点无效');
  if (input.create_legacy_root === true && !parentId && !binding && !orgId && (await tx.query('SELECT 1 FROM org_unit WHERE parent_id IS NULL')).rows.length) problems.push('兼容根节点已存在，请显式选择父节点');
  const eids = input.employment_ids ?? [];
  if (!Array.isArray(eids)) bad('employment_ids必须是雇佣记录编号数组');
  const selected = [...new Set(eids.map(x => id(x, '雇佣记录')))];
  const employments = selected.length ? (await tx.query(`SELECT e.*,p.full_name,p.person_number FROM ty_employment e
    JOIN ty_person p ON p.id=e.person_id WHERE e.id=ANY($1::bigint[]) ORDER BY e.id`, [selected])).rows : [];
  if (employments.length !== selected.length || employments.some(e => Number(e.company_id) !== Number(company.id))) problems.push('所选雇佣不全部属于当前公司');
  for (const e of employments) {
    if (e.status === 'cancelled') problems.push(`雇佣 ${e.id} 已取消`);
    if ((await tx.query(`SELECT 1 FROM ty_employment x WHERE x.person_id=$1 AND x.id<>$2 AND x.status<>'cancelled'
      AND daterange(x.hire_date,x.leave_date,'[]') && daterange($3::date,$4::date,'[]')`, [e.person_id, e.id, e.hire_date, e.leave_date])).rows.length) problems.push(`雇佣 ${e.id} 存在并行经历，旧模块无法无损映射`);
    if (fromDate && String(e.hire_date instanceof Date ? e.hire_date.toISOString().slice(0, 10) : e.hire_date) < fromDate) problems.push(`雇佣 ${e.id} 入职日早于桥接生效日`);
  }
  const salaryInputs = input.salary_standards ?? [];
  if (!Array.isArray(salaryInputs)) bad('salary_standards必须为显式薪资标准数组');
  const salaries = salaryInputs.map(s => {
    const employmentId = id(s.employment_id, '薪资对应雇佣');
    if (!selected.includes(employmentId)) bad('薪资标准只能属于本次明确选择的雇佣');
    if (!Number.isFinite(Number(s.monthly_amount)) || Number(s.monthly_amount) <= 0) bad('月薪标准必须明确且大于0');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.effective_from || ''))) bad('薪资标准生效日必须填写');
    return { employment_id: employmentId, monthly_amount: Number(s.monthly_amount), effective_from: s.effective_from };
  });
  if (new Set(salaries.map(s => s.employment_id)).size !== salaries.length) bad('同一雇佣的薪资标准请只提交一次');
  return { ready: problems.length === 0, problems, company,
    plan: { company_id: Number(company.id), legacy_parent_org_id: parentId, legacy_org_id: orgId,
      payroll_legal_entity_id: payrollId, si_legal_entity_id: siId, effective_from: fromDate,
      create_legacy_root: input.create_legacy_root === true, employment_ids: selected, salary_standards: salaries },
    preview_employments: employments.map(e => ({ id: e.id, person_number: e.person_number, full_name: e.full_name, hire_date: e.hire_date, leave_date: e.leave_date })),
    warnings: ['本操作只建立兼容适配，不把门店公司改成新版部门。', '不会创建合同、审批、考勤、工资或培训成绩。',
      '不自动授予旧业务权限；未填写薪资标准的人员不视为薪资输入就绪。', '旧薪酬地区政策必须单独核定，桥接不代表香港或其他地区算薪已验证。'] };
}
export async function commit(tx, { userId, input }) {
  if (input?.confirm !== true) bad('请先查看桥接预览，并显式确认所选公司、主体和雇佣');
  const p = await preview(tx, { userId, input });
  if (!p.ready) bad(p.problems.join('；'));
  const plan = p.plan;
  const organization = (await tx.query('SELECT fn_ty_bridge_company($1,$2,$3,$4,$5,$6::date,$7,$8) data',
    [plan.company_id, plan.legacy_parent_org_id, plan.legacy_org_id, plan.payroll_legal_entity_id, plan.si_legal_entity_id,
      plan.effective_from, userId, plan.create_legacy_root])).rows[0].data;
  const people = [];
  for (const employmentId of plan.employment_ids) {
    const salary = plan.salary_standards.find(s => s.employment_id === employmentId);
    people.push((await tx.query('SELECT fn_ty_bridge_employment($1,$2,$3::numeric,$4::date) data',
      [employmentId, userId, salary?.monthly_amount ?? null, salary?.effective_from ?? null])).rows[0].data);
  }
  await tx.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data) VALUES($1,'legacy_bridge','companies',$2,$3::jsonb)",
    [userId, plan.company_id, JSON.stringify({ organization, employments: people.map(e => e.employment_id), salary_standard_count: plan.salary_standards.length })]);
  return { committed: true, organization, people, status: await status(tx, { userId, companyId: plan.company_id }) };
}
