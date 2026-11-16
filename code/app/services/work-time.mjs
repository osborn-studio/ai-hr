// ============================================================================
// app/services/work-time.mjs · 综合计算工时制（131）
// ----------------------------------------------------------------------------
// 这一层只做两件事：查"谁在用非标准工时、周期跑到哪了"，以及改制度。
// 加班小时怎么算，全在 fn_att_ot_split / fn_comp_ot_split 里 —— 这里不算钱。
//
// ★ 为什么改工时制度要有 payroll_policy 权限（HR 主管以上）：
//   同一个人从"标准工时"改成"季度综合"，下个季度的加班费算法就整个换了一套
//   （休息日不再单独 200%，超时按季度总数算）。这不是填档案，是改算钱规则。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payroll_run', write: 'payroll_policy' };

const SYS_CN = {
  standard: '标准工时',
  comp_month: '月综合工时',
  comp_quarter: '季综合工时',
  comp_year: '年综合工时',
  flexible: '不定时工作制',
};

const isPeriod = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

/** 当前有哪些人在用非标准工时，以及本期周期进度 */
export async function overview(tx, { userId, period }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  const p = isPeriod(period) ? period : (await tx.query(`SELECT app_today()::text d`)).rows[0].d.slice(0, 7);
  if (!isPeriod(p)) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');

  // 非标准工时的人 + 周期进度。standard 的人不进这张表 ——
  // 他们是多数，列出来只会把"需要看的那七八个人"淹掉。
  const rows = (await tx.query(
    `SELECT e.id AS employment_id, e.person_id, p.full_name AS person_name,
            (SELECT n.no FROM employee_no n WHERE n.assigned_person_id = p.id
              AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            COALESCE(e.work_time_system,'standard') AS sys,
            e.comp_approved_until::text AS approved_until,
            s.from_date::text AS from_date, s.to_date::text AS to_date,
            s.settle_period, s.std_hours, s.actual_hours, s.ot_hours,
            s.holiday_hours, s.rest_hours, s.is_settle, s.approved_ok
       FROM employment e
       JOIN person p ON p.id = e.person_id
       LEFT JOIN LATERAL public.fn_att_comp_status(e.person_id, $1) s ON true
      WHERE e.leave_date IS NULL
        AND COALESCE(e.work_time_system,'standard') <> 'standard'
      ORDER BY e.work_time_system, p.full_name`, [p])).rows;

  return {
    period: p,
    canWrite,
    // 前端不用自己维护一份中文名，两处各写一份必然漂
    sysLabels: SYS_CN,
    rows: rows.map((r) => ({
      ...r,
      sys_label: SYS_CN[r.sys] || r.sys,
      // 备案过期不影响算薪，但必须提示：没有备案按综合工时算本身就是违法用工
      approve_warn: r.approved_until == null || r.approved_ok === false,
    })),
  };
}

/** 改一个人的工时制度（要备案有效期） */
export async function setWorkTime(tx, { userId, employmentId, sys, approvedUntil, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!Number.isInteger(employmentId) || employmentId <= 0) {
    throw bizErr('E_ARG_INVALID', 'employment 必须是正整数（任职 id，不是工号）');
  }
  const s = String(sys || '').trim();
  if (!Object.keys(SYS_CN).includes(s)) {
    throw bizErr('E_ARG_INVALID', `工时制度只支持 ${Object.keys(SYS_CN).join(' / ')}`);
  }
  if (String(reason || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）—— 这一项换的是算加班费的整套算法');
  }
  // 综合工时与不定时都必须有劳动行政部门审批备案（劳部发〔1994〕503 号）
  if (s !== 'standard') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(approvedUntil || ''))) {
      throw bizErr('E_ARG_INVALID',
        '综合工时/不定时要填备案有效期（YYYY-MM-DD）：没有劳动部门批准的"综合工时"是违法用工');
    }
    if (approvedUntil < (await tx.query('SELECT app_today()::text d')).rows[0].d.slice(0, 10)) {
      throw bizErr('E_ARG_INVALID', '备案有效期已经过期了；续期之后再改制度');
    }
  }

  const before = (await tx.query(
    `SELECT work_time_system, comp_approved_until::text a FROM employment WHERE id=$1`,
    [employmentId])).rows[0];
  if (!before) throw bizErr('E_NOT_FOUND', `没有这条任职记录（employment id = ${employmentId}）`);

  await tx.query(
    `UPDATE employment SET work_time_system=$2, comp_approved_until=$3 WHERE id=$1`,
    [employmentId, s === 'standard' ? null : s, s === 'standard' ? null : approvedUntil]);

  return {
    employment_id: employmentId,
    before: before.work_time_system || 'standard',
    after: s,
    approved_until: s === 'standard' ? null : approvedUntil,
    _log: { employment_id: employmentId, sys: s, reason },
  };
}
