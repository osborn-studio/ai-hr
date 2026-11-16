// ============================================================================
// app/services/roster-rule.mjs · 排班规则（149）
// ----------------------------------------------------------------------------
// 表建好了但没有门 —— 这一层补上。规则是**按组织**挂的（我们没有考勤组，
// 门店就是排班的天然单位），取不到就向上找一级，再取不到 = 不校验。
//
// ★ 只有一条写入口 `set`：整条 upsert。不给"逐字段改"是因为这些字段互相牵制
//   （日上限 × 连续天数 × 月休天数），分开改容易出现"改了上限但月休还是老值"
//   这种半新半旧的规则，而它比没规则更难解释。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'attendance_daily', write: 'attendance_daily' };

const isId = (v) => Number.isInteger(v) && v > 0;
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bizErr('E_ARG_INVALID', '数值必须是非负数字');
  return n;
};
const arrOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const a = (Array.isArray(v) ? v : String(v).split(','))
    .map((x) => Number(String(x).trim())).filter((x) => Number.isFinite(x));
  return a.length ? a.sort((x, y) => x - y) : null;
};

/** 当前生效的规则（含"这条是从哪一级取到的"） */
export async function current(tx, { userId, orgId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(orgId)) throw bizErr('E_ARG_INVALID', 'org 必须是正整数');

  const own = (await tx.query(
    `SELECT * FROM roster_rule WHERE org_id=$1 AND is_active LIMIT 1`, [orgId])).rows[0] || null;
  const eff = (await tx.query(
    `SELECT * FROM fn_roster_rule_of($1)`, [orgId])).rows[0] || null;
  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  return {
    org_id: orgId,
    own,                                   // 本组织自己定的（可能为 null）
    effective: eff && eff.id ? eff : null,  // 实际生效的（继承来的）
    // 生效规则来自哪一级：本组织 / 上级 / 全局缺省 —— 页面要能把这句话说出来
    source: !eff || !eff.id ? 'none'
      : (Number(eff.org_id) === orgId ? 'self'
        : (Number(eff.org_id) === 0 ? 'global' : 'parent')),
    canWrite,
  };
}

/** 整条 upsert（按组织） */
export async function set(tx, { userId, orgId, patch }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(orgId)) throw bizErr('E_ARG_INVALID', 'org 必须是正整数');
  const p = patch && typeof patch === 'object' ? patch : {};
  const name = String(p.name || '').trim();
  if (!name) throw bizErr('E_ARG_INVALID', '规则名称必填（它会长在报错信息里，人要看得懂）');

  const row = (await tx.query(
    `INSERT INTO roster_rule(code, name, org_id, max_min_workday, max_min_restday, max_min_holiday,
       max_min_week, max_min_month, max_consecutive_days, min_rest_days_month,
       warn_daily_hours, warn_week_hours, warn_month_hours,
       allow_pick_shift_unrostered, allow_punch_unrostered,
       can_edit_past, edit_window_months, publish_mode,
       remind_enabled, remind_before_days, remind_scope, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (org_id) WHERE is_active DO UPDATE SET
       name = EXCLUDED.name,
       max_min_workday = EXCLUDED.max_min_workday,
       max_min_restday = EXCLUDED.max_min_restday,
       max_min_holiday = EXCLUDED.max_min_holiday,
       max_min_week    = EXCLUDED.max_min_week,
       max_min_month   = EXCLUDED.max_min_month,
       max_consecutive_days = EXCLUDED.max_consecutive_days,
       min_rest_days_month  = EXCLUDED.min_rest_days_month,
       warn_daily_hours = EXCLUDED.warn_daily_hours,
       warn_week_hours  = EXCLUDED.warn_week_hours,
       warn_month_hours = EXCLUDED.warn_month_hours,
       allow_pick_shift_unrostered = EXCLUDED.allow_pick_shift_unrostered,
       allow_punch_unrostered      = EXCLUDED.allow_punch_unrostered,
       can_edit_past = EXCLUDED.can_edit_past,
       edit_window_months = EXCLUDED.edit_window_months,
       publish_mode = EXCLUDED.publish_mode,
       remind_enabled = EXCLUDED.remind_enabled,
       remind_before_days = EXCLUDED.remind_before_days,
       remind_scope = EXCLUDED.remind_scope
     RETURNING id`,
    [`R${orgId}`, name, orgId,
      numOrNull(p.max_min_workday), numOrNull(p.max_min_restday), numOrNull(p.max_min_holiday),
      numOrNull(p.max_min_week), numOrNull(p.max_min_month),
      numOrNull(p.max_consecutive_days), numOrNull(p.min_rest_days_month),
      arrOrNull(p.warn_daily_hours), arrOrNull(p.warn_week_hours), arrOrNull(p.warn_month_hours),
      !!p.allow_pick_shift_unrostered, !!p.allow_punch_unrostered,
      p.can_edit_past === undefined ? true : !!p.can_edit_past,
      p.edit_window_months === undefined ? 6 : Number(p.edit_window_months) || 0,
      String(p.publish_mode || 'save'),
      !!p.remind_enabled,
      p.remind_before_days === undefined ? 1 : Number(p.remind_before_days) || 1,
      String(p.remind_scope || 'manager'),
      String(userId)])).rows[0];

  return { id: Number(row.id), org_id: orgId,
           _log: { org: orgId, name, publish: p.publish_mode || 'save' } };
}

/**
 * 试算：给一个"人 + 日期 + 分钟数"，问规则拦不拦。
 * 页面在划线之前就能问 —— 而不是排完才被拒。
 */
export async function check(tx, { userId, employeeId, date, orgId, minutes }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw bizErr('E_ARG_INVALID', 'date 写 YYYY-MM-DD');
  }
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) throw bizErr('E_ARG_INVALID', 'minutes 必须是正数');
  return (await tx.query(
    `SELECT * FROM fn_roster_check($1,$2::date,$3,$4)`,
    [employeeId, String(date), orgId, Math.round(m)])).rows;
}
