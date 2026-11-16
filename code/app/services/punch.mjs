// ============================================================================
// app/services/punch.mjs · 打卡（自建）：薄到只做四件事
// ----------------------------------------------------------------------------
// 规矩都在库里（065）：服务端时间、门店解析、围栏距离、只增不改。
// 这一层只负责：身份换算（账号 → 员工）、岗位授权、参数形状、事务。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
import { resolveEmployee } from './leave.mjs';   // 账号→员工：与请假同一份换算

export const RESOURCES = { punch: 'punch' };
const RES = RESOURCES.punch;

export async function punch(tx, { userId, kind, storeId = null, lat = null, lng = null,
                                  clientAt = null, device = null }) {
  if (!['in', 'out'].includes(kind)) throw bizErr('E_ARG_INVALID', 'kind 只能是 in / out');
  const emp = await resolveEmployee(tx, userId);
  // ★ 写动作：打卡是"我这个岗位能做的事"，不是"能看这类数据"
  await requireSession(tx, { userId, resource: RES, action: 'write' });

  const r = (await tx.query(
    `SELECT * FROM fn_punch($1,$2,$3,$4,$5,$6,$7,'app')`,
    [emp.personId, kind, storeId, lat, lng, clientAt, device])).rows[0];

  return {
    id: Number(r.punch_id), punch_at: r.punched_at, kind,
    store_id: r.at_store, distance_m: r.dist_m,
    outside: r.is_outside,        // 围栏外：照常记录，但界面要显示
  };
}

/** 打卡页首屏：今天的上下班与"还差什么" */
export async function today(tx, { userId }) {
  const emp = await resolveEmployee(tx, userId);
  await requireSession(tx, { userId, resource: RES });
  const row = (await tx.query(
    `SELECT first_in, last_out, punch_count, any_outside FROM v_punch_today WHERE employee_id=$1`,
    [emp.personId])).rows[0];
  const rule = (await tx.query(
    `SELECT a.org_id, o.name, o.lat, o.lng, COALESCE(r.radius_m,300) radius_m
       FROM employee_org_assignment a JOIN org_unit o ON o.id = a.org_id
       LEFT JOIN punch_rule r ON r.store_id = o.id
      WHERE a.employee_id=$1 AND a.dim_code='attendance_org'
        AND daterange(a.valid_from, a.valid_to, '[]') @> app_today()
      ORDER BY a.valid_from DESC LIMIT 1`, [emp.personId])).rows[0];

  return {
    employee_id: emp.personId,
    store: rule ? { id: rule.org_id, name: rule.name, lat: rule.lat, lng: rule.lng,
                    radius_m: rule.radius_m } : null,
    today: row ? {
      first_in: row.first_in, last_out: row.last_out,
      punch_count: row.punch_count, outside: row.any_outside,
      state: !row.first_in ? 'not_started' : !row.last_out ? 'on_duty' : 'done',
    } : { first_in: null, last_out: null, punch_count: 0, outside: false, state: 'not_started' },
  };
}

/**
 * 打卡流水（按天）。谁能看全员？
 * ★ 判据是"有没有 punch 的**写**权限"：补卡/管考勤的人才有写权限，
 *   而"能看全员打卡"正是这类人。普通店员只有读权限 → 只看自己。
 *   用岗位权限而不是"再写一个 is_hr 判断"：那样会多出第二套身份口径。
 */
export async function log(tx, { userId, date }) {
  const emp = await resolveEmployee(tx, userId).catch(() => null);
  await requireSession(tx, { userId, resource: RES });

  const staff = (await tx.query('SELECT fn_role_can($1,$2,$3) c',
    [userId, RES, 'write'])).rows[0].c;

  const rows = (await tx.query(
    `SELECT p.id, p.employee_id, pe.full_name, n.no AS employee_no,
            p.punch_at, p.kind, p.source, p.store_id,
            o.name AS store_name, p.device_id, p.distance_m,
            (p.punch_at AT TIME ZONE app_tz())::date AS work_date
       FROM punch p
       JOIN person pe ON pe.id = p.employee_id
       LEFT JOIN employee_no n ON n.assigned_person_id = p.employee_id AND n.retired_at IS NULL
       LEFT JOIN org_unit o ON o.id = p.store_id
      WHERE (p.punch_at AT TIME ZONE app_tz())::date = $1::date
        AND ($2::boolean OR p.employee_id = $3)
      ORDER BY p.punch_at DESC
      LIMIT 500`,
    [date, staff, emp ? emp.personId : -1])).rows;

  const sources = [...new Set(rows.map((r) => r.source))];
  // 那一天没记录时，"最近一次有记录是哪天、几条"比一句"没有打卡"有用得多 ——
  // 同步是否在跑，看这个就知道。
  const latest = rows.length ? null : (await tx.query(
    `SELECT (punch_at AT TIME ZONE app_tz())::date d, count(*)::int n
       FROM punch
      WHERE ($1::boolean OR employee_id = $2)
      GROUP BY 1 ORDER BY 1 DESC LIMIT 1`,
    [staff, emp ? emp.personId : -1])).rows[0];
  return {
    date, staff, scope: staff ? 'all' : 'me',
    count: rows.length, sources,
    latest: latest ? { date: (latest.d instanceof Date
      ? latest.d.toISOString().slice(0, 10) : String(latest.d).slice(0, 10)), count: Number(latest.n) } : null,
    // ★ date 列回来是 Date 对象，`String(d).slice(0,10)` 得到 "Fri Nov 13" ——
    //   必须 toISOString()。同一个坑这已经是第三次（XP2 / 061 / 这里）。
    rows: rows.map((r) => ({
      ...r,
      punch_at: r.punch_at,
      work_date: r.work_date instanceof Date
        ? r.work_date.toISOString().slice(0, 10) : String(r.work_date).slice(0, 10),
    })),
  };
}
