// =============================================================================
// 考勤导入：日报（工号 + 日期 + 工时）与月报（工号 + 各项天数/工时）
// -----------------------------------------------------------------------------
// 与工资表导入同一套做法：两阶段（解析出逐行结论 → 再点应用）。
// 一次导几十人，最坏的情况是"看起来导进去了" —— 所以行级结论必须留着。
//
// ★ 解析与落库分开：
//   这里只做"能不能认出来"（表头、工号、数值），落库由库函数做
//   （fn_att_period_import_apply / fn_att_daily_import_apply），
//   因为落库要过一堆约束（封账、状态、值域），那些判据只在库里有唯一一份。
// =============================================================================
import { parseDelimited, toObjects, toAmount } from '../sheet.mjs';
import { readXlsx } from '../xlsx.mjs';
import { bizErr } from '../errors.mjs';

/** 表头别名：客户给的表不会刚好叫「应出勤」 */
const MONTHLY_COLS = {
  work_days:           ['应出勤', '应出勤天数', '应出勤(天)', 'work_days', 'workdays'],
  present_days:        ['出勤', '实际出勤', '出勤天数', 'present_days'],
  leave_days:          ['请假', '请假天数', 'leave_days'],
  personal_leave_days: ['事假', '事假天数', 'personal_leave_days'],
  absent_days:         ['旷工', '旷工天数', 'absent_days'],
  work_hours:          ['工时', '实际工时', 'work_hours', 'hours'],
  ot_hours:            ['加班', '加班工时', 'ot_hours'],
};
const KEY_COLS = {
  employee_no: ['工号', '员工编号', 'employee_no', 'emp_no'],
  name:        ['姓名', '员工姓名', 'name'],
};
const DAILY_COLS = {
  employee_no: ['工号', '员工编号', 'employee_no', 'emp_no'],
  name:        ['姓名', '员工姓名', 'name'],
  date:        ['日期', '考勤日期', 'date', 'work_date'],
  hours:       ['工时', '实际工时', 'work_hours', 'hours'],
};

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** 在一行里按别名找列下标 */
const findCol = (headers, aliases) => {
  for (const a of aliases) {
    const i = headers.findIndex(h => norm(h) === norm(a));
    if (i >= 0) return i;
  }
  return -1;
};

const readByExt = (buffer, filename) => {
  const low = String(filename || '').toLowerCase();
  if (low.endsWith('.xlsx')) return readXlsx(buffer);
  // CSV/TSV/TXT：按文本解析；非 UTF-8 直接报错，不猜编码
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw bizErr('E_IMPORT_ENCODING', '文件不是 UTF-8 编码；请在 Excel 里「另存为 CSV UTF-8」再导');
  }
  return parseDelimited(text);
};

/**
 * 月报导入：解析 + 逐行校验（不落库）
 * @returns {{ headers: string[], rows: {row_no, ok, error, payload}[] }}
 */
export async function parseMonthly(tx, { buffer, filename }) {
  const table = readByExt(buffer, filename);
  const { headers, rows } = toObjects(table);
  if (!rows.length) throw bizErr('E_IMPORT_EMPTY', '表里没有数据行');

  const iNo = findCol(headers, KEY_COLS.employee_no);
  const iName = findCol(headers, KEY_COLS.name);
  if (iNo < 0 && iName < 0) {
    throw bizErr('E_IMPORT_HEADER', '表头要有「工号」或「姓名」，否则不知道该把这一行给谁');
  }
  const idx = {};
  for (const [k, aliases] of Object.entries(MONTHLY_COLS)) {
    idx[k] = findCol(headers, aliases);
  }
  if (Object.values(idx).every(i => i < 0)) {
    throw bizErr('E_IMPORT_HEADER',
      '一个可识别的数据列都没有（应出勤/出勤/请假/事假/旷工/工时/加班 至少要有其一）');
  }

  const out = [];
  for (const { row_no, cells } of rows) {
    const rec = { row_no, ok: false, error: null, payload: {} };
    const no = iNo >= 0 ? String(cells[iNo] ?? '').trim() : '';
    const name = iName >= 0 ? String(cells[iName] ?? '').trim() : '';

    // 工号优先；没有工号才按姓名（同名会撞，所以要求唯一）
    let personId = null;
    if (no) {
      personId = (await tx.query(
        `SELECT assigned_person_id AS id FROM employee_no
          WHERE no = $1 AND retired_at IS NULL LIMIT 1`, [no])).rows[0]?.id ?? null;
      if (!personId) { rec.error = `E_ROW_PERSON: 工号 ${no} 找不到在职人员`; out.push(rec); continue; }
    } else if (name) {
      const hits = (await tx.query(
        `SELECT id FROM person WHERE full_name = $1 LIMIT 2`, [name])).rows;
      if (hits.length === 0) { rec.error = `E_ROW_PERSON: 姓名「${name}」找不到`; out.push(rec); continue; }
      if (hits.length > 1) {
        rec.error = `E_ROW_PERSON: 姓名「${name}」有多人重名，请用工号`;
        out.push(rec); continue;
      }
      personId = hits[0].id;
    } else {
      rec.error = 'E_ROW_KEY: 这一行既没工号也没姓名';
      out.push(rec); continue;
    }

    // 数值列：留空 = 不改这一列（这是"部分覆盖"，不是"清成 0"）
    let any = false;
    for (const [k, i] of Object.entries(idx)) {
      if (i < 0) continue;
      const raw = String(cells[i] ?? '').trim();
      if (raw === '') continue;
      const v = toAmount(raw);
      if (v === null || Number.isNaN(v)) {
        rec.error = `E_ROW_VALUE: 「${headers[i]}」不是数字（${raw}）`;
        break;
      }
      if (v < 0) { rec.error = `E_ROW_VALUE: 「${headers[i]}」不能为负（${raw}）`; break; }
      rec.payload[k] = v;
      any = true;
    }
    if (rec.error) { out.push(rec); continue; }
    if (!any) { rec.error = 'E_ROW_EMPTY: 这一行所有数据列都是空的'; out.push(rec); continue; }

    rec.payload.person_id = Number(personId);
    rec.ok = true;
    out.push(rec);
  }
  return { headers, rows: out };
}

/**
 * 日报导入：工号 + 日期 + 工时
 */
export async function parseDaily(tx, { buffer, filename }) {
  const table = readByExt(buffer, filename);
  const { headers, rows } = toObjects(table);
  if (!rows.length) throw bizErr('E_IMPORT_EMPTY', '表里没有数据行');

  const iNo = findCol(headers, DAILY_COLS.employee_no);
  const iName = findCol(headers, DAILY_COLS.name);
  const iDate = findCol(headers, DAILY_COLS.date);
  const iHours = findCol(headers, DAILY_COLS.hours);
  if ((iNo < 0 && iName < 0) || iDate < 0 || iHours < 0) {
    throw bizErr('E_IMPORT_HEADER', '日报表要有「工号」(或姓名)、「日期」、「工时」三列');
  }

  const out = [];
  for (const { row_no, cells } of rows) {
    const rec = { row_no, ok: false, error: null, payload: {} };
    const no = iNo >= 0 ? String(cells[iNo] ?? '').trim() : '';
    const name = iName >= 0 ? String(cells[iName] ?? '').trim() : '';
    const d = String(cells[iDate] ?? '').trim();
    const h = String(cells[iHours] ?? '').trim();
    if (!d || !h) { rec.error = 'E_ROW_EMPTY: 日期或工时为空'; out.push(rec); continue; }

    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(d) || /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(d);
    if (!dateOk) { rec.error = `E_ROW_DATE: 日期格式认不出（${d}），要 2026-11-03 这样`; out.push(rec); continue; }
    const date = d.replace(/\//g, '-');

    const hours = toAmount(h);
    if (hours === null || Number.isNaN(hours) || hours < 0) {
      rec.error = `E_ROW_VALUE: 工时不是非负数字（${h}）`; out.push(rec); continue;
    }

    let personId = null;
    if (no) {
      personId = (await tx.query(
        `SELECT assigned_person_id AS id FROM employee_no
          WHERE no = $1 AND retired_at IS NULL LIMIT 1`, [no])).rows[0]?.id ?? null;
      if (!personId) { rec.error = `E_ROW_PERSON: 工号 ${no} 找不到在职人员`; out.push(rec); continue; }
    } else {
      const hits = (await tx.query(`SELECT id FROM person WHERE full_name = $1 LIMIT 2`, [name])).rows;
      if (hits.length !== 1) {
        rec.error = hits.length ? `E_ROW_PERSON: 姓名「${name}」重名，请用工号` : `E_ROW_PERSON: 姓名「${name}」找不到`;
        out.push(rec); continue;
      }
      personId = hits[0].id;
    }

    rec.payload = { employee_id: Number(personId), work_date: date, work_hours: hours };
    rec.ok = true;
    out.push(rec);
  }
  return { headers, rows: out };
}

/** 写批次 + 逐行结论（两阶段的第一阶段） */
export async function saveBatch(tx, { kind, period, filename, rows, userId }) {
  const ok = rows.filter(r => r.ok).length;
  const batchId = Number((await tx.query(
    `INSERT INTO att_import_batch(kind, period, filename, row_total, row_ok, row_fail, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [kind, period, filename, rows.length, ok, rows.length - ok, String(userId)])).rows[0].id);

  for (const r of rows) {
    await tx.query(
      `INSERT INTO att_import_row(batch_id, row_no, ok, error, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [batchId, r.row_no, r.ok, r.error, JSON.stringify(r.payload || {})]);
  }
  return { batchId, total: rows.length, ok, fail: rows.length - ok };
}

/** 批次详情（给人看"这行过了没有、为什么没过"） */
export async function getBatch(tx, batchId) {
  const b = (await tx.query(`SELECT * FROM att_import_batch WHERE id = $1`, [batchId])).rows[0];
  if (!b) throw bizErr('E_NOT_FOUND', `导入批次 ${batchId} 不存在`);
  const rows = (await tx.query(
    `SELECT row_no, ok, error, payload FROM att_import_row
      WHERE batch_id = $1 ORDER BY row_no`, [batchId])).rows;
  return { batch: b, rows };
}
