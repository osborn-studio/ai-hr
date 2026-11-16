// ============================================================================
// app/services/roster-report.mjs · 排班报表（155）
// ----------------------------------------------------------------------------
// 三张视图：排班率（按天）、班次热力图（按班次×日期）、人员工时（已排/已发生）。
//
// 这一层**只做三件事**，和 report-trend.mjs 一样薄：
//   ① 参数形状（org 正整数、from 是 YYYY-MM-DD、days 1..31）；
//   ② 行闸（报表按组织汇总 → requireOrg，维度与 report.mjs 的 panel 相同）；
//   ③ 把长表折成页面直接能画的形状（热力图转矩阵、工时算差值分类）。
//
// ★ 口径一律不进这一层：
//   · need / planned / rate / 划线人数 都在 fn_roster_rate 里；
//   · 热力图的人数在 fn_roster_heat 里（这里只 pivot，不重数）；
//   · planned 与 happened **在库里就是两列**，这里不把两列加成一个"总工时"。
//   在 JS 里再算一次，就会有第二个来源，而它分叉时不会有任何信号。
//
// ★ 只读，不需要写权限：RESOURCES 只有 read（attendance_daily）。
//   排班报表的读者是 HR / 店长，不是排班的人 —— 能看与能排是两层权限。
//
// ★ 门禁用 cost_org（与 report.mjs 的 panel / fn_rpt_* 一致）：
//   报表都归到成本组织。库函数里同时认 attendance_org，是"人挂哪个维度都有"的
//   数据容错，不是放宽门禁 —— 判"这个 org 在不在你范围内"只判一个维，
//   判两个维会让"只有成本组织范围"的账号查不到自己该看的店。
// ============================================================================
import { requireOrg } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'attendance_daily' };

const isId = (v) => Number.isInteger(v) && v > 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const MAX_DAYS = 31;   // 与库里的上限一致；这里先挡是为了给出人话的参数错误

/** 三个动作共用的参数形状 + 行闸（形状过了才进库，库里的上限是第二道） */
async function gate(tx, { userId, orgId, from, days }) {
  if (!isId(orgId)) throw bizErr('E_ARG_INVALID', 'org 必须是正整数（org_unit.id）');
  if (!isDate(from)) throw bizErr('E_ARG_INVALID', 'from 写 YYYY-MM-DD');
  const d = days === undefined || days === null || days === '' ? 7 : Number(days);
  if (!Number.isInteger(d) || d < 1 || d > MAX_DAYS) {
    throw bizErr('E_ARG_INVALID', `days 取 1..${MAX_DAYS}`);
  }
  await requireOrg(tx, { userId, resource: RESOURCES.read, orgId, dim: 'cost_org' });
  return d;
}

/** 从 from 起连续 n 天的日期（与 fn_roster_heat 的 generate_series 同一把尺子） */
function dateRange(from, n) {
  const base = new Date(`${from}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * date 列统一成 'YYYY-MM-DD'。
 * ★ 两个驱动都会把 date 解析成 **UTC 零点** 的 Date（PGlite 与 pg 都是），
 *   所以 toISOString 取日期是对的；用本地 getDate() 反而在负时区会掉一天。
 *   真 PG 若配了别的解析器（返回字符串），这里也接得住。
 */
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * ① 排班率（按天）。
 *
 * kpi 里的 rate 是**加权**（总已排 ÷ 总在职），不是逐日比率的算术平均：
 * 算术平均会让"1 个人的日子"和"20 个人的日子"等权，于是周末（人少）的
 * 0% 或 100% 会把整周拉得面目全非。加权和"这周到底排满了没有"是同一个问题。
 * 只有 need > 0 的日子进分母；need = 0 的日子既不算 0% 也不算 100%，
 * 单独用 no_rate_days 标出来 —— 那些天是"没有分母"，不是"排得不好"。
 */
export async function rate(tx, { userId, orgId, from, days }) {
  const d = await gate(tx, { userId, orgId, from, days });

  const rows = (await tx.query(
    `SELECT * FROM fn_roster_rate($1::bigint,$2::date,$3::int)`,
    [orgId, String(from), d])).rows;

  // rate 从库里是 numeric（pg 会以字符串回），统一成 number | null。
  // null 必须原样保留：它是"没有分母"，不能被 Number() 变成 0。
  const norm = rows.map((r) => ({
    work_date: day(r.work_date),
    need: Number(r.need),
    planned: Number(r.planned),
    rate: r.rate === null ? null : Number(r.rate),
    temp: Number(r.temp),
  }));

  const withNeed = norm.filter((r) => r.need > 0);
  const need = withNeed.reduce((a, r) => a + r.need, 0);
  const planned = withNeed.reduce((a, r) => a + r.planned, 0);

  return {
    org_id: orgId, from: String(from), days: d,
    rows: norm,
    kpi: {
      days: norm.length,
      need,
      planned,
      // 加权排班率；一天都没有分母时为 null（不是 0）
      rate: need > 0 ? Math.round((planned / need) * 10000) / 10000 : null,
      temp: norm.reduce((a, r) => a + r.temp, 0),
      // 分母为 0 的天数：新店 / 全店离职 / 组织挂错都是这个形状
      no_rate_days: norm.filter((r) => r.need === 0).length,
      // 有分母但一个人都没排的天数：这是"真的漏排"，与上面那一类是两回事
      empty_days: norm.filter((r) => r.need > 0 && r.planned === 0).length,
    },
  };
}

/**
 * ② 班次热力图（转成矩阵）。
 *
 * 库里回的是长表（shift_code, work_date, person_count），这里 pivot 成：
 *   { dates: [...], rows: [{ shift_code, shift_name, color, cells:[{date,count}], total }] }
 * 页面按 rows × cells 直接铺格子，不需要在前端再 groupBy 一次。
 *
 * ★ cells 一定补齐到 days 个（库里已经给了完整网格，这里补是第二道保险）：
 *   热力图少一格会让后面的格子整体左移，而画面上完全看不出来 ——
 *   一条"颜色对得上、日期错位一天"的图，比一张空图更危险。
 * ★ 行的顺序照库里给的（按上班时间，划线那行 *TEMP 在最后）：
 *   在 JS 里再排一次，就会与班次主数据的顺序分叉。
 */
export async function heat(tx, { userId, orgId, from, days }) {
  const d = await gate(tx, { userId, orgId, from, days });
  const dates = dateRange(String(from), d);

  const long = (await tx.query(
    `SELECT * FROM fn_roster_heat($1::bigint,$2::date,$3::int)`,
    [orgId, String(from), d])).rows;

  const byShift = new Map();
  for (const r of long) {
    if (!byShift.has(r.shift_code)) {
      byShift.set(r.shift_code, {
        shift_code: r.shift_code,
        shift_name: r.shift_name,
        color: r.color,
        is_temp: r.shift_code === '*TEMP',
        cells: [],
        total: 0,
        peak: 0,
      });
    }
    const row = byShift.get(r.shift_code);
    const count = Number(r.person_count);
    row.cells.push({ date: day(r.work_date), count });
    row.total += count;
    if (count > row.peak) row.peak = count;
  }

  // 缺的日期补 0（按 dates 的顺序重排，不依赖库里的行序）
  for (const row of byShift.values()) {
    const byDate = new Map(row.cells.map((c) => [c.date, c.count]));
    row.cells = dates.map((dt) => ({ date: dt, count: byDate.get(dt) ?? 0 }));
    // 这一行有几天有人：热力图上"这个班这周开了几天"（叫 active_days，
    // 不叫 days —— 外层的 days 是"画了几天"，两个数在这张图上同时存在）
    row.active_days = row.cells.filter((c) => c.count > 0).length;
  }

  const rows = [...byShift.values()];
  return {
    org_id: orgId, from: String(from), days: d,
    dates,
    rows,
    kpi: {
      shifts: rows.length,
      // 格子里的总人天：与排班率那边的 planned 合计是同一个口径，
      // 两个数对不上就说明有人排了没归到任何班次（那是数据问题，不是口径问题）
      person_days: rows.reduce((a, r) => a + r.total, 0),
      temp_person_days: rows.filter((r) => r.is_temp).reduce((a, r) => a + r.total, 0),
      max: rows.reduce((a, r) => Math.max(a, r.peak), 0),
    },
  };
}

/**
 * ③ 按员工的工时：planned 与 happened 分两列，**不加总**。
 *
 * kpi 里给出两个分类，这正是"分开两列"要回答的问题：
 *   · gap_unplanned —— 没排却上了（planned = 0 而 happened > 0）：钱要付，
 *     但排班表上看不见；连着几天出现就是"计划全错"，不是个人问题。
 *   · gap_absent    —— 排了没上（planned > 0 而 happened = 0）：计划落空，
 *     要按旷工/调休处理。整列都是这个的人，可能是考勤没同步，而不是全员旷工 ——
 *     所以这两个数只报人数，不报"缺勤率"。
 */
export async function hours(tx, { userId, orgId, from, days }) {
  const d = await gate(tx, { userId, orgId, from, days });

  const rows = (await tx.query(
    `SELECT * FROM fn_roster_hours($1::bigint,$2::date,$3::int)`,
    [orgId, String(from), d])).rows;

  const norm = rows.map((r) => ({
    employee_id: Number(r.employee_id),
    person_name: r.person_name,
    employee_no: r.employee_no,
    planned_minutes: Number(r.planned_minutes),
    happened_minutes: Number(r.happened_minutes),
    days: Number(r.days),
    // 差值只作为**页面排序/标红用**，不是"欠班时长"：
    // 排了 8 小时实际上了 8.5 小时是加班，不是欠 0 小时。
    diff_minutes: Number(r.happened_minutes) - Number(r.planned_minutes),
  }));

  const sum = (k) => norm.reduce((a, r) => a + r[k], 0);
  return {
    org_id: orgId, from: String(from), days: d,
    rows: norm,
    kpi: {
      people: norm.length,
      planned_minutes: sum('planned_minutes'),
      happened_minutes: sum('happened_minutes'),
      // 有排班的人 / 真上了班的人（分开数：这两个集合不相等才是正常现象）
      with_plan: norm.filter((r) => r.planned_minutes > 0).length,
      with_actual: norm.filter((r) => r.happened_minutes > 0).length,
      gap_unplanned: norm.filter((r) => r.planned_minutes === 0 && r.happened_minutes > 0).length,
      gap_absent: norm.filter((r) => r.planned_minutes > 0 && r.happened_minutes === 0).length,
    },
  };
}
