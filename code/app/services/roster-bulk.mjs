// ============================================================================
// app/services/roster-bulk.mjs · 排班的批量动作（151）
// ----------------------------------------------------------------------------
// 复制一天 / 复制一周 / 导入 / 导出。四个动作，两条规矩：
//
//   · **判断都在库里**（复制是否覆盖、规则是否超限、重叠、锁定）。
//     这一层只做参数校验与形状转换 —— JS 再判一次就有两个地方会漂。
//   · **导入部分成功**。接口把 errors 原样给出去（row / code / message），
//     页面按行号标红；不要在这一层把"3 行错"变成"整批失败"。
//
// ★ 导出的宽表在服务层拼：库里出长表（一行一段），因为"一天多段在 Excel 里
//   怎么写进一个格子"是展示决定，不是数据事实。临时班次拼成「临时班次 16:00-21:00」——
//   产品模板明确它导不回去，导出时要让人看见而不是看起来像正常班次。
//
// ★ 门禁沿用 145：能改考勤的人才该能批量排班（后果落在工时与工资上）。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'attendance_daily', write: 'attendance_daily' };

const isId = (v) => Number.isInteger(v) && v > 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// 一次导入的上限。不是性能限制，是"错行清单"的可用性：
// 一次报两千条错，人只会关掉对话框，然后整张表原样不管。
const MAX_IMPORT_ROWS = 5000;

/** 复制一天到另一天（目标日已有排班则整天跳过） */
export async function copy(tx, { userId, employeeId, from, to }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isDate(from) || !isDate(to)) throw bizErr('E_ARG_INVALID', 'from / to 写 YYYY-MM-DD');
  if (String(from) === String(to)) throw bizErr('E_ARG_INVALID', 'from 与 to 是同一天，复制没有目标');

  const r = (await tx.query(
    `SELECT * FROM fn_roster_copy($1,$2::date,$3::date,$4)`,
    [employeeId, String(from), String(to), String(userId)])).rows[0];

  return {
    copied: Number(r.copied), skipped: Number(r.skipped), note: r.note,
    employee_id: employeeId, from: String(from), to: String(to),
    _log: { person: employeeId, from, to, copied: Number(r.copied), skipped: Number(r.skipped) },
  };
}

/** 复制一整周（周一到周日逐天复制） */
export async function copyWeek(tx, { userId, employeeId, srcMonday, dstMonday }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isDate(srcMonday) || !isDate(dstMonday)) {
    throw bizErr('E_ARG_INVALID', 'srcMonday / dstMonday 写 YYYY-MM-DD');
  }
  if (String(srcMonday) === String(dstMonday)) {
    throw bizErr('E_ARG_INVALID', '源周与目标周相同，复制没有目标');
  }

  const r = (await tx.query(
    `SELECT * FROM fn_roster_copy_week($1,$2::date,$3::date,$4)`,
    [employeeId, String(srcMonday), String(dstMonday), String(userId)])).rows[0];

  return {
    copied: Number(r.copied), skipped: Number(r.skipped), note: r.note,
    employee_id: employeeId, src_monday: String(srcMonday), dst_monday: String(dstMonday),
    _log: { person: employeeId, srcMonday, dstMonday,
            copied: Number(r.copied), skipped: Number(r.skipped) },
  };
}

/**
 * 导入：rows 由调用方从 CSV / xlsx 解析成对象数组
 *   [{ employee_no, date, shift }]，shift 可以是班次码，也可以是「清空」。
 * ★ 门禁之外不再按行校验格式 —— 格式错的行走库里同一个循环，报回来带行号。
 *   在 JS 里先筛一遍，就会出现"JS 放过了、库拒了"的两份判断。
 */
export async function importRows(tx, { userId, rows }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!Array.isArray(rows)) throw bizErr('E_ARG_INVALID', 'rows 必须是对象数组');
  if (rows.length === 0) throw bizErr('E_ARG_INVALID', 'rows 是空的（没有任何数据行）');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw bizErr('E_ARG_INVALID', `一次最多导入 ${MAX_IMPORT_ROWS} 行（收到 ${rows.length}）`);
  }

  const r = (await tx.query(
    `SELECT * FROM fn_roster_import($1::jsonb,$2)`,
    [JSON.stringify(rows), String(userId)])).rows[0];

  const errors = r.errors ?? [];
  return {
    ok: Number(r.ok), fail: Number(r.fail), total: rows.length,
    // 行号是"第几条数据行"（表头不算）—— 页面按它标红
    errors,
    has_error: Number(r.fail) > 0,
    _log: { rows: rows.length, ok: Number(r.ok), fail: Number(r.fail) },
  };
}

/**
 * 导出：库里出长表，这里 pivot 成产品模板的宽表
 *   部门 | 用户ID | 工号 | 姓名 | 2026-11-16 | 2026-11-17 | …
 * ★ 同一天多段拼进一个格子（` / `），因为 Excel 的日期列就是一格一天。
 *   拼不进去的（太长的划线）不截断 —— 截断会让人以为那天只上了一段。
 */
export async function exportRows(tx, { userId, storeId, from, days }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(storeId)) throw bizErr('E_ARG_INVALID', 'store 必须是正整数（门店 org_unit.id）');
  if (!isDate(from)) throw bizErr('E_ARG_INVALID', 'from 写 YYYY-MM-DD');
  const d = days === undefined || days === null || days === '' ? 7 : Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 31) throw bizErr('E_ARG_INVALID', 'days 取 1..31');

  const long = (await tx.query(
    `SELECT * FROM fn_roster_export($1::bigint,$2::date,$3::int)`,
    [storeId, String(from), d])).rows;

  // 日期列：从 from 起连续 d 天（与周表一致，稀疏行由这里补成整列）
  const dates = [];
  const base = new Date(`${from}T00:00:00Z`);
  for (let i = 0; i < d; i += 1) {
    dates.push(new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  const dkey = (date) => `d_${date}`;
  const MH = (s) => String(s || '').slice(0, 5);   // 'HH:MM'（库里已经是 HH24:MI）

  // 一个人一行：key 用 user_id + 工号，避免同名人撞行
  const people = new Map();
  for (const r of long) {
    const key = `${r.user_id}|${r.employee_no || r.person_name}`;
    if (!people.has(key)) {
      const row = {
        dept: r.dept || '', user_id: r.user_id, employee_no: r.employee_no || '',
        person_name: r.person_name, temp_rows: 0,
      };
      for (const dt of dates) row[dkey(dt)] = '';
      people.set(key, row);
    }
    const row = people.get(key);
    const isTemp = r.shift_code === '临时班次';
    const label = isTemp
      ? `临时班次 ${MH(r.start_hm)}-${MH(r.end_hm)}`
      : (r.start_hm ? `${r.shift_code} ${MH(r.start_hm)}-${MH(r.end_hm)}` : r.shift_code);
    if (isTemp) row.temp_rows += 1;
    const cell = dkey(String(r.work_date).slice(0, 10));
    row[cell] = row[cell] ? `${row[cell]} / ${label}` : label;
  }

  const columns = [
    { key: 'dept', label: '部门' },
    { key: 'user_id', label: '用户ID' },
    { key: 'employee_no', label: '工号' },
    { key: 'person_name', label: '姓名' },
    ...dates.map((dt) => ({ key: dkey(dt), label: dt })),
  ];

  const rows = [...people.values()];
  return {
    store_id: storeId, from: String(from), days: d,
    dates, columns, rows,
    // 长表原样回给调用方（要 CSV "一行一段" 时不用再查一次库）
    long,
    kpi: {
      people: rows.length,
      cells: long.length,
      // 临时班次的行数：> 0 就说明这张表导不回去，页面要先提示
      temp_rows: rows.reduce((a, r) => a + r.temp_rows, 0),
    },
  };
}
