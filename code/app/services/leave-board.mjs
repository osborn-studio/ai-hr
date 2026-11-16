// ============================================================================
// app/services/leave-board.mjs · 假期额度与请假单（假期域）
// ----------------------------------------------------------------------------
// 之前假期域只有"年假折现"一个页面，而折现是**年底才做一次**的事。
// 真正每天要看的两个问题是：
//   ① 谁还有多少假（额度）—— 店长问"我这人还能不能批三天"，
//   ② 有哪些单子挂在那儿等我批（请假单）。
//
// ★ 权限不另写一套：人员范围一律走 fn_emp_roster（按 cost_org 行闸）。
//   另写一个"这个人是否归我管"，就会与花名册漂 —— 而漂的形态是
//   "名单里看得见、额度页看不见"，两边都像对的。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { request: 'leave_request' };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 假种列表（顺带给出每个假种本年已批天数，用于表头提示） */
export async function types(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.request, action: 'read' });
  // ★ 列名以实际表为准（127 只加了 is_system / pay_ratio / is_active / note）：
  //   想当然写 is_paid / annual_quota / sort_order 会撞 42703，
  //   而那个报错只说"列不存在"，不提示"你记的是另一版设计"。
  return (await tx.query(
    `SELECT t.id, t.code, t.name, t.expire_policy, t.pay_ratio,
            t.is_system, t.is_active, t.note,
            COALESCE((SELECT sum(r.qty) FROM leave_request r
                       WHERE r.leave_type_id = t.id AND r.status = 'approved'
                         AND r.date_from >= date_trunc('year', app_today())::date), 0) AS used_this_year
       FROM leave_type t
      WHERE t.is_active
      ORDER BY t.is_system DESC, t.id`)).rows;
}

/**
 * 额度总览：某个假种下，**花名册里每个人**的授予/已用/冻结/可用。
 * ★ 用 LEFT JOIN 而不是 INNER：没有额度记录的人也要出现在表里（显示 0），
 *   否则"他没额度"和"他不在名单里"看起来一样 —— 而这两件事的处理完全不同。
 */
export async function board(tx, { userId, typeId }) {
  await requireSession(tx, { userId, resource: RESOURCES.request, action: 'read' });
  const t = Number(typeId);
  if (!Number.isInteger(t) || t <= 0) throw bizErr('E_ARG_INVALID', 'type 必须是假种 id');

  const rows = (await tx.query(
    `WITH r AS (SELECT employee_id, full_name, org_name FROM fn_emp_roster(app_today()))
     SELECT r.employee_id, r.full_name, r.org_name,
            COALESCE(b.granted, 0)   AS granted,
            COALESCE(b.used, 0)      AS used,
            COALESCE(b.frozen, 0)    AS frozen,
            COALESCE(b.cashed, 0)    AS cashed,
            COALESCE(b.expired, 0)   AS expired,
            COALESCE(b.available, 0) AS available
       FROM r
       LEFT JOIN v_leave_balance b
              ON b.employee_id = r.employee_id AND b.leave_type_id = $1
      ORDER BY r.org_name NULLS LAST, r.full_name`, [t])).rows;

  // 汇总：不在这里 sum 出来给前端算 —— 前端再 sum 一次就会出现两个数
  const sum = rows.reduce((a, x) => ({
    granted: a.granted + Number(x.granted),
    used: a.used + Number(x.used),
    frozen: a.frozen + Number(x.frozen),
    cashed: a.cashed + Number(x.cashed),
    available: a.available + Number(x.available),
  }), { granted: 0, used: 0, frozen: 0, cashed: 0, available: 0 });

  return { type_id: t, headcount: rows.length, rows, sum };
}

/**
 * 请假单：默认近 90 天，待审的排在最前（且不受时间窗限制 ——
 * 挂了一个月没人批的单子，正是最该被看见的那些）。
 */
export async function requests(tx, { userId, days }) {
  await requireSession(tx, { userId, resource: RESOURCES.request, action: 'read' });
  const d = Math.max(1, Math.min(365, Number(days) || 90));

  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,'leave_request','write') o`, [userId])).rows[0].o;

  const rows = (await tx.query(
    `WITH r AS (SELECT employee_id, full_name, org_name FROM fn_emp_roster(app_today()))
     SELECT lr.id, lr.employee_id, r.full_name, r.org_name,
            t.name AS type_name, t.code AS type_code,
            lr.qty, lr.date_from, lr.date_to, lr.status, lr.decided_at,
            (app_today() - lr.date_from) AS days_since_start
       FROM leave_request lr
       JOIN r ON r.employee_id = lr.employee_id
       JOIN leave_type t ON t.id = lr.leave_type_id
      WHERE lr.status = 'pending'
         OR lr.date_from >= app_today() - ($1 || ' days')::interval
      ORDER BY (lr.status = 'pending') DESC, lr.date_from DESC, lr.id DESC
      LIMIT 300`, [String(d)])).rows;

  const pending = rows.filter(x => x.status === 'pending').length;
  return { days: d, rows, pending, canWrite };
}
