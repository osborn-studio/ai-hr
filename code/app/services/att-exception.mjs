// ============================================================================
// app/services/att-exception.mjs · 考勤异常闭环的接口层
// ----------------------------------------------------------------------------
// 规矩全在库里（168），这一层只做四件事：身份换算、岗位授权、行范围、参数形状。
//
// 六个动作对应闭环的六步：
//   scan          识别   —— 扫一个月，按排班与打卡生成异常（幂等）
//   exceptions    看见   —— 异常清单（带员工、日期、分钟数、状态）
//   punchFixOpen  申请   —— 开一张补卡单（草稿，等人批）
//   punchFixApply 落库   —— 审批通过后写 punch + 重算当天人日
//   close         处置   —— notify / explain / resolve / waive 状态机
//   dupPunch      复核   —— 疑似代人打卡，只报不拦
//
// ★ 权限判据只有一套：资源码 `attendance_daily`（063 登记的那一个）。
//   另开一个 `att_exception` 资源码会出现两套范围模型，而它们必然不同步 ——
//   不同步的那一天，通常是"能看异常的人改不了考勤"这种半通不通的状态。
//   补卡是"改考勤"，所以写权限就是 attendance_daily 的写权限。
// ============================================================================
import { requireSession, prepareRead } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'attendance_daily', write: 'attendance_daily' };

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FIX_TYPES = ['in', 'out', 'both'];
const ACTIONS = ['notify', 'explain', 'resolve', 'waive'];

/**
 * date 列回来是 Date（UTC 零点），`String(d).slice(0,10)` 得到的是 "Tue Nov 03"。
 * 这个坑本仓踩过三次（XP2 / 061 / punch.mjs），所以统一在这里转一次。
 */
const d10 = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10));

function needPeriod(period) {
  if (!PERIOD.test(String(period || ''))) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');
}

function needDay(day) {
  if (!DAY.test(String(day || ''))) throw bizErr('E_ARG_INVALID', 'date 必须是 YYYY-MM-DD');
}

function needId(id, name) {
  if (!Number.isInteger(id) || id <= 0) throw bizErr('E_ARG_INVALID', `${name} 必须是正整数`);
}

/**
 * 行闸：这个人当天挂在哪个考勤组织，就必须在 tmp_scope_org 里。
 *
 * ★ 为什么不调 requireOrg：那个函数要一个 orgId，而补卡单、异常行上**没有门店字段**
 *   （门店是员工当天的归属推出来的，不存副本 —— 存了就会与归属不同步）。
 *   所以这里反过来：先按人+日查到归属，再拿它去判范围，判据仍是同一张临时表。
 *   少了这一步，"看不到这个人的考勤"与"能替他补卡"就会同时成立。
 */
async function assertEmployeeInScope(tx, { employeeId, workDate }) {
  const r = await tx.query(
    `SELECT 1
       FROM employee_org_assignment a
      WHERE a.employee_id = $1 AND a.dim_code = 'attendance_org'
        AND daterange(a.valid_from, a.valid_to, '[]') @> $2::date
        AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                     WHERE s.dim_code = 'attendance_org' AND s.org_id = a.org_id)
        AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                         WHERE d.dim_code = 'attendance_org' AND d.org_id = a.org_id)
      LIMIT 1`, [employeeId, workDate]);
  if (r.rows.length === 0) {
    throw bizErr('E_OUT_OF_SCOPE',
      `无权处理员工 ${employeeId} 在 ${workDate} 的考勤（考勤组织不在数据范围内）`);
  }
}

// ---------------------------------------------------------------------------
// ① 识别：扫一个月
// ---------------------------------------------------------------------------
/**
 * 生成考勤异常。★ 写动作：它往 att_exception 里插行，所以判**写**权限。
 * 幂等（同一人同一天同 kind 只一行），所以可以随手重跑 —— 月初跑到月末都安全。
 *
 * @param graceMin 迟到宽限（分钟），默认 5。1 分钟的"迟到"是噪声，
 *                 而噪声多了就没人看这张表了 —— 口径要能被调，不能写死在心里。
 */
export async function scan(tx, { userId, period, graceMin = 5 }) {
  needPeriod(period);
  if (!Number.isInteger(graceMin) || graceMin < 0 || graceMin > 120) {
    throw bizErr('E_ARG_INVALID', 'grace_min 必须是 0–120 的整数');
  }
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  const rows = (await tx.query('SELECT exc_kind, inserted FROM fn_att_scan($1,$2)',
    [period, graceMin])).rows;
  const byKind = {};
  let inserted = 0;
  for (const r of rows) { byKind[r.exc_kind] = Number(r.inserted); inserted += Number(r.inserted); }
  return { period, grace_min: graceMin, inserted, by_kind: byKind };
}

// ---------------------------------------------------------------------------
// ② 看见：异常清单
// ---------------------------------------------------------------------------
/**
 * 异常清单。未关闭的排前面 —— 这张表是"今天该处理什么"，不是账本；
 * 已关闭的要能查到（员工月底来问），但不该占住第一屏。
 */
export async function exceptions(tx, { userId, period, kind = null, status = null,
                                      employeeId = null }) {
  needPeriod(period);
  if (kind !== null && !['late', 'early', 'absent', 'miss_punch', 'no_roster', 'under_hours'].includes(kind)) {
    throw bizErr('E_ARG_INVALID', 'kind 不在 late/early/absent/miss_punch/no_roster/under_hours 里');
  }
  if (status !== null && !['open', 'explained', 'resolved', 'waived'].includes(status)) {
    throw bizErr('E_ARG_INVALID', 'status 不在 open/explained/resolved/waived 里');
  }
  if (employeeId !== null) needId(employeeId, 'employee');

  await prepareRead(tx, { userId, resource: RESOURCES.read });

  const rows = (await tx.query(
    `SELECT e.id, e.employee_id, p.full_name, n.no AS employee_no,
            e.work_date, e.kind, e.minutes, e.source, e.status, e.note,
            e.resolved_by, e.resolved_at, e.created_at
       FROM att_exception e
       JOIN person p ON p.id = e.employee_id
       LEFT JOIN employee_no n ON n.assigned_person_id = e.employee_id AND n.retired_at IS NULL
      WHERE to_char(e.work_date, 'YYYY-MM') = $1
        AND ($2::varchar IS NULL OR e.kind = $2)
        AND ($3::varchar IS NULL OR e.status = $3)
        AND ($4::bigint IS NULL OR e.employee_id = $4)
        -- 行闸：这个人当天的考勤组织要在范围内（与补卡、封账同一条判据）
        AND EXISTS (SELECT 1 FROM employee_org_assignment a
                     WHERE a.employee_id = e.employee_id AND a.dim_code = 'attendance_org'
                       AND daterange(a.valid_from, a.valid_to, '[]') @> e.work_date
                       AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                                    WHERE s.dim_code = 'attendance_org' AND s.org_id = a.org_id))
        AND NOT EXISTS (SELECT 1 FROM employee_org_assignment a
                          JOIN pg_temp.tmp_scope_deny d
                            ON d.dim_code = 'attendance_org' AND d.org_id = a.org_id
                         WHERE a.employee_id = e.employee_id AND a.dim_code = 'attendance_org'
                           AND daterange(a.valid_from, a.valid_to, '[]') @> e.work_date)
      ORDER BY (e.status IN ('open','explained')) DESC, e.work_date DESC, e.id`,
    [period, kind, status, employeeId])).rows;

  return rows.map((r) => ({ ...r, id: Number(r.id), employee_id: Number(r.employee_id),
                            work_date: d10(r.work_date) }));
}

// ---------------------------------------------------------------------------
// ③ 申请：开补卡单
// ---------------------------------------------------------------------------
export async function punchFixOpen(tx, { userId, employeeId, workDate, fixType, fixTime, reason }) {
  needId(employeeId, 'employee');
  needDay(workDate);
  if (!FIX_TYPES.includes(fixType)) throw bizErr('E_ARG_INVALID', 'fix_type 只能是 in / out / both');
  if (!fixTime) throw bizErr('E_ARG_INVALID', 'fix_time 必填（补的是被补的那个时刻，不是提交时刻）');
  if (String(reason || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', 'reason 至少 4 个字 —— 补了没理由等于没留痕');
  }

  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  await assertEmployeeInScope(tx, { employeeId, workDate });

  const r = (await tx.query(
    'SELECT fix_id, fix_code FROM fn_punch_fix_open($1,$2::date,$3,$4::timestamptz,$5,$6)',
    [employeeId, workDate, fixType, fixTime, reason, String(userId)])).rows[0];

  return { fix_id: Number(r.fix_id), code: r.fix_code, employee_id: employeeId,
           work_date: workDate, fix_type: fixType, fix_time: fixTime, status: 'draft' };
}

// ---------------------------------------------------------------------------
// ④ 落库：补卡生效
// ---------------------------------------------------------------------------
/**
 * 补卡落库。判据全在库里（未通过 / 已落库 / 无人日 / 已封账 分别有自己的码），
 * 这一层只负责"这个人归不归我管"，并且**不做任何兜底** ——
 * 在服务层重复判一遍"已落库"，会出现两个判据不同步的那一天。
 */
export async function punchFixApply(tx, { userId, fixId }) {
  needId(fixId, 'fix');

  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  const f = (await tx.query(
    'SELECT employee_id, work_date, status, code FROM punch_fix WHERE id = $1', [fixId])).rows[0];
  if (!f) throw bizErr('E_PFX_NOT_FOUND', `补卡单 ${fixId} 不存在`);
  await assertEmployeeInScope(tx, { employeeId: Number(f.employee_id), workDate: d10(f.work_date) });

  const r = (await tx.query('SELECT * FROM fn_punch_fix_apply($1,$2)', [fixId, String(userId)])).rows[0];
  return {
    fix_id: Number(r.fix_id), code: f.code,
    punch_written: Number(r.punch_n),
    work_hours_before: Number(r.hours_before),
    work_hours_after: Number(r.work_hours),
    store_id: r.at_store === null ? null : Number(r.at_store),
  };
}

// ---------------------------------------------------------------------------
// ⑤ 处置：状态机
// ---------------------------------------------------------------------------
/**
 * 处理一条异常。跳步由库里的状态机拒（open 直接 resolve → E_ATX_SKIP_STEP）——
 * 那一条判据放在服务层就会被下一条新接口绕过。
 */
export async function close(tx, { userId, exceptionId, action, note = null }) {
  needId(exceptionId, 'exception');
  if (!ACTIONS.includes(action)) throw bizErr('E_ARG_INVALID', 'action 只能是 notify / explain / resolve / waive');

  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  const e = (await tx.query(
    'SELECT employee_id, work_date, kind, status FROM att_exception WHERE id = $1',
    [exceptionId])).rows[0];
  if (!e) throw bizErr('E_ATX_NOT_FOUND', `异常 ${exceptionId} 不存在`);
  await assertEmployeeInScope(tx, { employeeId: Number(e.employee_id), workDate: d10(e.work_date) });

  const r = (await tx.query('SELECT * FROM fn_att_exception_close($1,$2,$3,$4)',
    [exceptionId, action, String(userId), note])).rows[0];
  return { exception_id: Number(r.exception_id), kind: r.exc_kind, status: r.new_status };
}

// ---------------------------------------------------------------------------
// ⑥ 复核：疑似代人打卡
// ---------------------------------------------------------------------------
/**
 * 列出疑似代人打卡。★ 只报不拦（理由见 168 的函数注释）：
 * 门店共用一台考勤机同样会命中，硬拦会把人逼回口头报备。
 */
export async function dupPunch(tx, { userId, period }) {
  needPeriod(period);
  await prepareRead(tx, { userId, resource: RESOURCES.read });

  const rows = (await tx.query(
    `SELECT d.reason, d.employee_id, pe.full_name AS employee_name,
            d.peer_id, pe2.full_name AS peer_name,
            d.punched_at, d.device_id, d.gap_sec, d.work_date
       FROM fn_att_dup_punch($1) d
       JOIN person pe ON pe.id = d.employee_id
       LEFT JOIN person pe2 ON pe2.id = d.peer_id
      WHERE EXISTS (SELECT 1 FROM employee_org_assignment a
                     WHERE a.employee_id = d.employee_id AND a.dim_code = 'attendance_org'
                       AND daterange(a.valid_from, a.valid_to, '[]') @> d.work_date
                       AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                                    WHERE s.dim_code = 'attendance_org' AND s.org_id = a.org_id))
      ORDER BY d.punched_at DESC`, [period])).rows;

  return {
    period,
    count: rows.length,
    rows: rows.map((r) => ({ ...r, employee_id: Number(r.employee_id),
                             peer_id: Number(r.peer_id), gap_sec: Number(r.gap_sec),
                             work_date: d10(r.work_date) })),
  };
}
