// ============================================================================
// app/services/si-declare.mjs · 社保申报基数（133）
// ----------------------------------------------------------------------------
// 一年一次的动作：把每个人的缴费基数按"上年度月平均工资"算出来、夹到当地上下限、
// 由 HR 核过之后定下来。定了之后一年内不随月薪变动。
//
// ★ 为什么生成与确认分成两步：基数报错了要走更正申报，比补一张请假单麻烦得多。
//   系统算的是 source='calc' 的建议值，人改过的行标 manual 并且在重跑时不被覆盖。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payroll_run', write: 'payroll_policy' };

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** 某年度的申报基数清单 + 当地上下限 */
export async function overview(tx, { userId, year, city }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  const c = String(city || '上海');
  let y = Number(year) || Number((await tx.query(
    `SELECT EXTRACT(year FROM app_today()) y`)).rows[0].y);

  // ★ 没显式指定年度时：当年没定过基数，就显示最近一次定过的年度。
  //   调基通常在年中做下一年度的准备（7 月做的是 7 月起生效的那一年），
  //   只显示"当年"会让刚录完的人下次进来看到一片空白，以为没保存。
  if (!year) {
    const hasCur = Number((await tx.query(
      `SELECT count(*)::int n FROM si_base_declare WHERE declare_year=$1 AND city=$2`,
      [y, c])).rows[0].n);
    if (hasCur === 0) {
      const latest = (await tx.query(
        `SELECT max(declare_year) y FROM si_base_declare WHERE city=$1`, [c])).rows[0].y;
      if (latest) y = Number(latest);
    }
  }

  const pol = (await tx.query(
    `SELECT effective_from::text f, base_floor, base_ceiling
       FROM si_policy WHERE city=$1 AND effective_from <= make_date($2,7,1)
      ORDER BY effective_from DESC LIMIT 1`, [c, y])).rows[0] || null;

  const rows = (await tx.query(
    `SELECT d.id, d.employee_id, p.full_name AS person_name,
            (SELECT n.no FROM employee_no n WHERE n.assigned_person_id = p.id
              AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            d.declare_year, d.effective_from::text AS effective_from,
            d.monthly_avg, d.base_amount, d.months_counted, d.source, d.reason,
            d.created_by, d.created_at
       FROM si_base_declare d
       JOIN person p ON p.id = d.employee_id
      WHERE d.declare_year = $1 AND d.city = $2
      ORDER BY p.full_name`, [y, c])).rows;

  return { year: y, city: c, floor: pol?.base_floor ?? null, ceiling: pol?.base_ceiling ?? null,
           policyFrom: pol?.f ?? null, rows, canWrite };
}

/** 生成（calc）：上年度月平均 → 夹上下限 */
export async function build(tx, { userId, year, city, effectiveFrom }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    throw bizErr('E_ARG_INVALID', 'year 要写 2027 这样的年度');
  }
  if (effectiveFrom && !isDate(effectiveFrom)) {
    throw bizErr('E_ARG_INVALID', '生效日写 YYYY-MM-DD（各地调基时间不同，不写死）');
  }
  const n = Number((await tx.query(
    `SELECT fn_si_declare_build($1,$2,$3::date,$4) n`,
    [y, String(city || '上海'), effectiveFrom || null, String(userId)])).rows[0].n);
  return { year: y, generated: n, _log: { year: y, generated: n } };
}

/** 手工改一个人的基数 */
export async function setOne(tx, { userId, employeeId, year, city, base, why }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  }
  const y = Number(year);
  const b = Number(base);
  if (!Number.isFinite(b) || b <= 0) throw bizErr('E_ARG_INVALID', '基数必须是正数');
  if (String(why || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）—— 这个数报错了要更正申报');
  }
  const id = Number((await tx.query(
    `SELECT fn_si_declare_set($1,$2,$3,$4,$5,$6) i`,
    [employeeId, y, b, String(city || '上海'), String(why).trim(), String(userId)])).rows[0].i);
  return { id, employee_id: employeeId, base_amount: b, _log: { employeeId, year: y, base: b } };
}
