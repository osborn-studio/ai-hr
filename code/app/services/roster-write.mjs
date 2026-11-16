// ============================================================================
// app/services/roster-write.mjs · 排班写入（145）
// ----------------------------------------------------------------------------
// 这一层做六件事：看周表、排一个班、撤一个班、推给门店、门店确认、锁定。
// 所有判断都在库里（重叠、锁定、跨店原因、空表不许推、争议不许锁）——
// 这里不重复一遍规则：JS 里再判一次，就有两个地方会漂。
//
// ★ 为什么多了一个"撤"（spec 里是五个动作）：同日多段是允许的，重叠才拒，
//   于是"改了排班"只能靠撤掉重排。没有撤销，门店退回（disputed）之后
//   那条排班既改不了也锁不上 —— 争议会变成死路，最后没人敢点"有争议"。
//
// ★ 为什么写权限用 attendance_daily 而不是 067 那个 roster 资源：
//   排班的后果落在考勤与算薪上（段 → 工时），能改考勤的人才该能排班。
//   067 的 roster 资源是给"看板划线"那套留的，两者混用会让
//   "只能看考勤"的人也能排出影响工资的段。
//
// ★ 没有"退回"接口。锁定的班要改，得先有人把确认退回去 ——
//   而退回这个动作故意没有入口：它是"门店签过的字作废"，得有个人负责。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
import { inStationScope, stationScope } from './scope.mjs';

export const RESOURCES = { read: 'attendance_daily', write: 'attendance_daily' };

const isId = (v) => Number.isInteger(v) && v > 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isPeriod = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));

/**
 * 周表：这一段日期里每个人的每天（**稀疏行**：没排班的日子不出现）。
 * 页面自己按 from + days 补空格 —— 接口不生成"空单元格"，
 * 否则"没排班"和"排了休息"在数据里长得一样。
 */
export async function week(tx, { userId, storeId, from, days }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(storeId)) throw bizErr('E_ARG_INVALID', 'store 必须是正整数（门店 org_unit.id）');
  if (!isDate(from)) throw bizErr('E_ARG_INVALID', 'from 写 YYYY-MM-DD');
  const d = days === undefined || days === null || days === '' ? 7 : Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 31) throw bizErr('E_ARG_INVALID', 'days 取 1..31');

  const rows = (await tx.query(
    `SELECT w.* FROM fn_roster_week($1::bigint, $2::date, $3::int) w
      WHERE ${inStationScope('w.employee_id', '$4', '$2::date')}`,
    [storeId, String(from), d, userId])).rows;

  // 行标题（人）：与"有没有排班"无关 —— 这一周一个人都没排也要有行，
  // 否则页面会显示"这家店没人"，而事实是"人都在、班还没排"。
  // ★ 182：与上面那行**同一个闸**（inStationScope）。两处分别写的话，
  //   会出现"标题列着整店的人、格子只有本档口的班" —— 那一屏里每个人都少排了班。
  const people = (await tx.query(
    `SELECT DISTINCT p.id AS employee_id, p.full_name AS person_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = p.id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no
       FROM employee_org_assignment a
       JOIN employment e ON e.person_id = a.employee_id
                        AND daterange(e.hire_date, e.leave_date, '[]') @> $2::date
       JOIN person p ON p.id = a.employee_id
      -- ★ 两个维度都认：门店人员归属在真实客户里有的挂 cost_org、有的挂
      --   attendance_org，只认一个会让"这家店没人"与"人都在、班没排"看起来一样。
      --   DISTINCT 去过重，同一个人两个维度都挂也只出现在一行。
      WHERE a.org_id = $1 AND a.dim_code IN ('attendance_org', 'cost_org')
        AND daterange(a.valid_from, a.valid_to, '[]') @> $2::date
        AND ${inStationScope('p.id', '$3', '$2::date')}
      ORDER BY p.id`, [storeId, String(from), userId])).rows;

  const shifts = (await tx.query(
    `SELECT code, name, color, start_time, end_time, is_rest
       FROM shift_def ORDER BY start_time, code`)).rows;

  return {
    store_id: storeId, from: String(from), days: d,
    shifts, people, rows,
    // 182：这一周为什么人多/人少，页面要说得出来。
    // ★ 判定日取 **from**（这一屏的起始日），不逐日重算：与花名册的 as_of 同一条规矩
    //   —— 一个屏幕一个时点。逐日重算会让"人"这个列表每天都不一样，
    //   而它在这屏上只有一列（行标题），没法按天画。
    station_scope: await stationScope(tx, { userId, asOf: String(from) }),
    // 页面要给"这一周有几天排了 / 几条还是未开始"一个小计，这里算好，不让人在前端数
    kpi: {
      cells: rows.length,
      people: people.length,
      rest: rows.filter((r) => r.is_rest).length,
      notStarted: rows.filter((r) => r.confirm_status === 'not_started').length,
      locked: rows.filter((r) => r.confirm_status === 'locked').length,
      disputed: rows.filter((r) => r.confirm_status === 'disputed').length,
    },
  };
}

/** 排一个班：建 schedule + 段 + 确认单（not_started），一步落 */
export async function assign(tx, { userId, employeeId, date, shift, storeId, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isId(storeId)) throw bizErr('E_ARG_INVALID', 'store 必须是正整数（门店 org_unit.id）');
  if (!isDate(date)) throw bizErr('E_ARG_INVALID', 'date 写 YYYY-MM-DD');
  const s = String(shift || '').trim().toUpperCase();
  if (!s) throw bizErr('E_ARG_INVALID', 'shift 必填（班次码，见 shift_def）');

  const id = Number((await tx.query(
    `SELECT fn_roster_assign($1,$2::date,$3,$4,$5,$6) id`,
    [employeeId, String(date), s, storeId,
      String(reason || '').trim() || null, String(userId)])).rows[0].id);

  // 回读段与确认单：页面要说"排了 8:00-16:00、确认单还没开始"，
  // 而不是笼统地报"成功"（休息班没有段，这两个字段就是空的）。
  const seg = (await tx.query(
    `SELECT sg.start_at, sg.end_at, cs.id AS sheet_id, cs.status
       FROM schedule sc
       LEFT JOIN schedule_segment sg ON sg.schedule_id = sc.id
       LEFT JOIN confirm_sheet cs ON cs.segment_id = sg.id
      WHERE sc.id = $1 ORDER BY sg.seq LIMIT 1`, [id])).rows[0];

  return {
    schedule_id: id, employee_id: employeeId, work_date: String(date), shift: s,
    start_at: seg?.start_at ?? null, end_at: seg?.end_at ?? null,
    sheet_id: seg?.sheet_id ?? null, confirm_status: seg?.status ?? null,
    _log: { schedule: id, person: employeeId, date: String(date), shift: s, store: storeId },
  };
}

/**
 * 撤掉某天某个班（p_shift 为空 = 整天）。
 * ★ 它存在是因为"改"必须有个出路：排错的班不能覆盖（同日多段是允许的，
 *   重叠才拒），而门店退回之后那条既改不了也锁不上 —— 没有撤销，
 *   争议就是死路，最后谁都不敢点"有争议"。
 */
export async function clear(tx, { userId, employeeId, date, shift }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isDate(date)) throw bizErr('E_ARG_INVALID', 'date 写 YYYY-MM-DD');
  const s = String(shift || '').trim().toUpperCase() || null;

  const n = Number((await tx.query(
    `SELECT fn_roster_clear($1,$2::date,$3,$4) n`,
    [employeeId, String(date), s, String(userId)])).rows[0].n);

  return { cleared: n, employee_id: employeeId, work_date: String(date), shift: s,
           _log: { cleared: n, person: employeeId, date: String(date), shift: s } };
}

/**
 * 划线排班（148）：给人划一段任意时段，不从班次里选。
 * ★ 这是"上到几点就划到几点"的入口 —— 兼职工/临时工的排法。
 *   休息时长按制度项自动扣，排班人也可以显式给一个数覆盖（各家吃饭时间不同）。
 */
export async function line(tx, { userId, employeeId, date, from, to, storeId,
  breakMin, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isId(storeId)) throw bizErr('E_ARG_INVALID', 'store 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw bizErr('E_ARG_INVALID', 'date 写 YYYY-MM-DD');
  }
  const okTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
  if (!okTime(from) || !okTime(to)) throw bizErr('E_ARG_INVALID', '起止时间写 HH:MM');
  const bm = breakMin === null || breakMin === undefined || breakMin === ''
    ? null : Number(breakMin);
  if (bm !== null && (!Number.isFinite(bm) || bm < 0)) {
    throw bizErr('E_ARG_INVALID', '休息分钟必须是非负数字');
  }

  const r = (await tx.query(
    `SELECT * FROM fn_roster_line($1,$2::date,$3::time,$4::time,$5,$6,$7,$8)`,
    [employeeId, String(date), String(from), String(to), storeId, bm,
      String(reason || '').trim() || null, String(userId)])).rows[0];

  return {
    schedule_id: Number(r.schedule_id), segment_id: Number(r.segment_id),
    minutes: Number(r.minutes), break_min: Number(r.break_min),
    net_minutes: Number(r.net_minutes),
    _log: { person: employeeId, date, from, to, minutes: Number(r.minutes) },
  };
}

/** 推到门店：not_started → pushed，写确认人与到期日 */export async function push(tx, { userId, storeId, period }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(storeId)) throw bizErr('E_ARG_INVALID', 'store 必须是正整数');
  if (!isPeriod(period)) throw bizErr('E_ARG_INVALID', 'period 写 YYYY-MM');

  const n = Number((await tx.query(
    `SELECT fn_roster_push($1,$2,$3) n`,
    [storeId, String(period), String(userId)])).rows[0].n);

  // 到期日与确认人回读：页面上"推给谁、几号前签"是这个动作的全部意义
  const due = (await tx.query(
    `SELECT min(cs.confirm_due_at) AS due_at,
            min(cs.confirm_owner_id) AS owner_id
       FROM confirm_sheet cs
       JOIN schedule_segment sg ON sg.id = cs.segment_id
       JOIN schedule sc ON sc.id = sg.schedule_id
      WHERE sg.store_id = $1
        AND sc.work_date >= ($2 || '-01')::date
        AND sc.work_date <  (($2 || '-01')::date + interval '1 month')`,
    [storeId, String(period)])).rows[0];

  return {
    pushed: n, store_id: storeId, period: String(period),
    confirm_due_at: due?.due_at ?? null, confirm_owner_id: due?.owner_id ?? null,
    _log: { store: storeId, period, pushed: n },
  };
}

/** 门店确认：ok=1 → store_confirmed；ok=0 → disputed（必须写意见） */
export async function confirm(tx, { userId, storeId, period, ok, note }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(storeId)) throw bizErr('E_ARG_INVALID', 'store 必须是正整数');
  if (!isPeriod(period)) throw bizErr('E_ARG_INVALID', 'period 写 YYYY-MM');
  if (ok === undefined || ok === null || ok === '') {
    throw bizErr('E_ARG_INVALID', 'ok 必填（1 = 认可 / 0 = 有争议）');
  }

  const n = Number((await tx.query(
    `SELECT fn_roster_confirm($1,$2,$3,$4,$5) n`,
    [storeId, String(period), ok === true || ok === '1' || ok === 1,
      String(note || '').trim() || null, String(userId)])).rows[0].n);

  return {
    confirmed: n, store_id: storeId, period: String(period),
    status: ok === true || ok === '1' || ok === 1 ? 'store_confirmed' : 'disputed',
    note: String(note || '').trim() || null,
    _log: { store: storeId, period, n, ok },
  };
}

/** 锁定：store_confirmed → locked（有争议会被库拒） */
export async function lock(tx, { userId, storeId, period }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(storeId)) throw bizErr('E_ARG_INVALID', 'store 必须是正整数');
  if (!isPeriod(period)) throw bizErr('E_ARG_INVALID', 'period 写 YYYY-MM');

  const n = Number((await tx.query(
    `SELECT fn_roster_lock($1,$2,$3) n`,
    [storeId, String(period), String(userId)])).rows[0].n);

  return { locked: n, store_id: storeId, period: String(period),
           _log: { store: storeId, period, locked: n } };
}
