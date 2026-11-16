// ============================================================================
// app/services/severance.mjs · 离职结算（134）
// ----------------------------------------------------------------------------
// 经济补偿金是离职时最大的一笔钱，也是错一次就上仲裁的一笔。
// 金额全部由 fn_severance_calc 出，这一层不算任何数 —— 只做三件事：
// 读清单、试算、落单/确认/作废。
//
// ★ 试算与落单分成两步：结算单一旦确认就不能作废（钱发了只能红冲），
//   所以必须让人先看到"年限怎么进位、月工资取了多少、有没有封顶"再决定。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payroll_run', write: 'payroll_policy' };

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** 结算单清单 + 社平工资 + 可选情形 + 在职人员 */
export async function overview(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  const rows = (await tx.query(
    `SELECT s.id, s.employment_id, s.person_id, p.full_name AS person_name,
            (SELECT n.no FROM employee_no n WHERE n.assigned_person_id = p.id
              AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            s.leave_date::text AS leave_date, s.reason_code, r.name AS reason_name,
            s.service_months, s.n_months, s.avg_wage, s.base_wage,
            s.pre2008_months, s.n_old, s.severance_old, s.n_new, s.severance_new,
            s.cap_applied, s.cap_years_applied,
            s.severance_amount, s.notice_amount, s.annual_leave_amount,
            s.tax_amount, s.total_amount, s.net_amount, s.status, s.note,
            s.created_by, s.confirmed_by, s.confirmed_at::text AS confirmed_at
       FROM severance_settlement s
       JOIN person p ON p.id = s.person_id
       JOIN severance_reason r ON r.code = s.reason_code
      ORDER BY s.leave_date DESC, s.id DESC`)).rows;

  const reasons = (await tx.query(
    `SELECT code, name, n_multiple, notice_pay, legal_note FROM severance_reason
      WHERE is_active ORDER BY n_multiple DESC, code`)).rows;

  // 可结算的人：在职（已离职但还没结算的也列出来 —— 漏结算比多列一个人严重）
  const people = (await tx.query(
    `SELECT e.id AS employment_id, e.person_id, p.full_name AS person_name,
            e.hire_date::text AS hire_date, e.leave_date::text AS leave_date,
            (SELECT n.no FROM employee_no n WHERE n.assigned_person_id = p.id
              AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            EXISTS (SELECT 1 FROM severance_settlement s WHERE s.employment_id = e.id) AS settled
       FROM employment e JOIN person p ON p.id = e.person_id
      ORDER BY e.leave_date NULLS FIRST, p.full_name`)).rows;

  const wages = (await tx.query(
    `SELECT city, wage_year, monthly, note FROM local_avg_wage
      ORDER BY city, wage_year DESC`)).rows;

  return { rows, reasons, people, wages, canWrite };
}

/** 试算：不落单 */
export async function quote(tx, { userId, employmentId, leaveDate, reasonCode, notice }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!Number.isInteger(employmentId) || employmentId <= 0) {
    throw bizErr('E_ARG_INVALID', 'employment 必须是正整数（任职 id，不是工号）');
  }
  if (!isDate(leaveDate)) throw bizErr('E_ARG_INVALID', '离职日写 YYYY-MM-DD');

  const c = (await tx.query(
    `SELECT * FROM fn_severance_calc($1,$2::date,$3,'上海',$4)`,
    [employmentId, leaveDate, String(reasonCode || 'mutual'), notice === true || notice === 'true'])).rows[0];

  return {
    service_months: Number(c.service_months), service_days_rest: Number(c.service_days_rest),
    n_months: Number(c.n_months), raw_n: Number(c.raw_n),
    avg_wage: Number(c.avg_wage), base_wage: Number(c.base_wage),
    cap_applied: c.cap_applied, cap_years_applied: c.cap_years_applied,
    local_avg: Number(c.local_avg), cap_multiple: Number(c.cap_multiple),
    severance: Number(c.severance), notice: Number(c.notice),
    annual_leave: Number(c.annual_leave),
    exempt: Number(c.exempt), taxable: Number(c.taxable), tax: Number(c.tax),
    total: Number(c.total), net: Number(c.net),
    // 2008 前入职的人分两段算（135）：前段按老办法不封顶，后段按 47 条
    split: c.split === true,
    pre2008_months: Number(c.pre2008_months), n_old: Number(c.n_old),
    old_wage: Number(c.old_wage), severance_old: Number(c.severance_old),
    post2008_months: Number(c.post2008_months), n_new: Number(c.n_new),
    severance_new: Number(c.severance_new),
  };
}

/** 落单 */
export async function create(tx, { userId, employmentId, leaveDate, reasonCode, note, notice }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isDate(leaveDate)) throw bizErr('E_ARG_INVALID', '离职日写 YYYY-MM-DD');
  if (String(note || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写说明（至少 4 个字）—— 三个月后要答得出"为什么按 N 结"');
  }
  const id = Number((await tx.query(
    `SELECT fn_severance_create($1,$2::date,$3,'上海',$4,$5,$6) i`,
    [employmentId, leaveDate, String(reasonCode || 'mutual'), String(note).trim(),
     String(userId), notice === true || notice === 'true'])).rows[0].i);

  const r = (await tx.query(
    `SELECT n_months, severance_amount, notice_amount, annual_leave_amount, tax_amount,
            total_amount, net_amount, status FROM severance_settlement WHERE id=$1`, [id])).rows[0];
  return {
    id, n_months: Number(r.n_months), severance: Number(r.severance_amount),
    notice: Number(r.notice_amount), annual_leave: Number(r.annual_leave_amount),
    tax: Number(r.tax_amount), total: Number(r.total_amount), net: Number(r.net_amount),
    status: r.status,
    _log: { employment_id: employmentId, total: Number(r.total_amount) },
  };
}

export async function confirm(tx, { userId, id }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!Number.isInteger(id) || id <= 0) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  await tx.query(`SELECT fn_severance_confirm($1,$2)`, [id, String(userId)]);
  return { id, status: 'confirmed', _log: { id } };
}

export async function voidOne(tx, { userId, id, why }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (String(why || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '作废要写原因（至少 4 个字）');
  }
  await tx.query(`SELECT fn_severance_void($1,$2,$3)`, [id, String(why).trim(), String(userId)]);
  return { id, status: 'void', _log: { id, why } };
}
