// ============================================================================
// app/services/salary-import.mjs · 工资表导入（Excel / CSV）
// ----------------------------------------------------------------------------
// 客户给的工资表长这样（Excel，首行表头）：
//
//   项目名称 | 代码        | 类型   | 公式
//   基本工资 | BASE        | 固定   |
//   岗位津贴 | POST_ALLOW  | 固定   |
//   全勤奖   | FULL_BONUS  | 公式   | BASE*0.05
//
// 或者这样（每人一行）：
//
//   工号   | 姓名 | 基本工资 | 岗位津贴 | 餐补
//   E0001  | 示例员工 | 9000   | 3000     | 600
//
// 两种都支持，但**语义完全不同**，所以分成 kind=items / kind=data，
// 不靠"猜表头"自动判断 —— 猜错会把一张人员表当成项目表导进工资项里，
// 而那看起来只是"项名奇怪"。
//
// 三条纪律：
//   ① 一行一结论：ok 的行入库，失败的行留原因。整批失败会让 HR 反复改表，
//      静默跳过更糟（少一个人不会报错）。
//   ② 先全量校验再写库：先跑一遍 check 收集错误，任何一行有错就整批不写 ——
//      否则"导了一半"的工资表比没导更危险（有人有数、有人没数，看不出来）。
//   ③ 金额按项目归属：数据行的金额落到项目代码上，不按列顺序硬编码 ——
//      列顺序是客户排的，下次就会变。
// ============================================================================
import { parseDelimited, toObjects, toAmount } from '../sheet.mjs';
import { readXlsx } from '../xlsx.mjs';
import { bizErr } from '../errors.mjs';

const ITEM_COLS = {
  name: ['项目名称', '项目', '工资项', '名称', '项名'],
  code: ['代码', '项目代码', '编码', 'item_code', 'code'],
  kind: ['类型', '类别', '项目类型', 'kind'],
  formula: ['公式', '计算式', '算式', 'formula'],
  order: ['排序', '顺序', 'order'],
};

const DATA_COLS = {
  no: ['工号', '员工编号', 'employee_no', '编号'],
  name: ['姓名', '员工', '员工姓名', 'name'],
};

/** 找出表头里哪一列承担某个角色（找不到返回 -1） */
const pickCol = (headers, aliases) => {
  const norm = headers.map(h => String(h || '').trim().toLowerCase());
  for (const a of aliases) {
    const i = norm.indexOf(a.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
};

/** 把文件读成二维字符串数组：.xlsx 走 zip 解析，其余按文本当分隔符表 */
export function readSheet(buffer, filename = '') {
  const lower = String(filename).toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readXlsx(buffer);
  let text = buffer.toString('utf8');
  // 不是 UTF-8 的（Excel 中文版默认 GBK）会被解成乱码：这里只报告，不猜编码 ——
  // 猜错比报错更麻烦（乱码的项目名会真的建进库）。
  if (text.includes('\uFFFD')) {
    throw bizErr('E_IMPORT_ENCODING',
      '文件不是 UTF-8 编码（Excel 另存 CSV 时选"CSV UTF-8"），或请直接上传 .xlsx');
  }
  return parseDelimited(text);
}

/** 项目代码：大写字母开头，只含大写字母/数字/下划线，2–24 位 */
const CODE_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
const KIND_MAP = {
  '固定': 'fixed', 'fixed': 'fixed',
  '浮动': 'variable', 'variable': 'variable',
  '公式': 'formula', 'formula': 'formula',
  '统计': 'statistic', 'statistic': 'statistic',
};

/**
 * 导入工资项目（含公式）。
 * @returns {{batchId:number, total:number, ok:number, fail:number, rows:Array}}
 */
export async function importItems(tx, { buffer, filename, userId }) {
  const grid = readSheet(buffer, filename);
  if (!grid.length) throw bizErr('E_IMPORT_EMPTY', '文件里没有任何行');
  const { headers, rows } = toObjects(grid);

  const iName = pickCol(headers, ITEM_COLS.name);
  const iCode = pickCol(headers, ITEM_COLS.code);
  const iKind = pickCol(headers, ITEM_COLS.kind);
  const iFormula = pickCol(headers, ITEM_COLS.formula);
  const iOrder = pickCol(headers, ITEM_COLS.order);
  if (iName < 0 || iCode < 0) {
    throw bizErr('E_IMPORT_HEADER',
      `表头里必须有「项目名称」与「代码」两列（当前表头：${headers.join(' / ')}）`);
  }

  const batchId = Number((await tx.query(
    `INSERT INTO salary_import_batch(kind, filename, row_total, created_by)
     VALUES ('items',$1,$2,$3) RETURNING id`,
    [String(filename).slice(0, 200), rows.length, String(userId)])).rows[0].id);

  // 已登记的项（公式里可以引用它们）
  const known = new Set((await tx.query(`SELECT code FROM salary_item`)).rows.map(r => r.code));
  const results = [];

  for (const { row_no, cells } of rows) {
    const name = String(cells[iName] ?? '').trim();
    const code = String(cells[iCode] ?? '').trim().toUpperCase();
    const kindRaw = iKind >= 0 ? String(cells[iKind] ?? '').trim() : '';
    const formula = iFormula >= 0 ? String(cells[iFormula] ?? '').trim() : '';
    const order = iOrder >= 0 ? toAmount(cells[iOrder]) : null;

    const payload = { name, code, kind: kindRaw, formula, order };
    let error = null;
    let itemKind = null;

    if (!name || name.length < 2) error = 'E_ROW_NAME: 项目名称至少 2 个字';
    else if (!CODE_RE.test(code)) error = `E_ROW_CODE: 代码只能用大写字母/数字/下划线（收到 ${code || '空'}）`;
    else {
      itemKind = KIND_MAP[kindRaw] || (formula ? 'formula' : 'fixed');
      if (!['fixed', 'variable', 'formula', 'statistic'].includes(itemKind)) {
        error = `E_ROW_KIND: 类型只能是 固定/浮动/公式/统计（收到 ${kindRaw}）`;
      } else if (formula) {
        // 公式校验放在库函数里（唯一来源）：字符白名单、括号、变量是否已登记。
        // ★ 用 fn_formula_try（不抛错）而不是 fn_formula_check：
        //   事务里一条语句失败会让整个事务 abort，后面每一行都会跟着失效 ——
        //   那是"逐行校验"最不该出现的行为。
        const allow = {};
        for (const c of [...known, code]) allow[c] = true;
        const bad = (await tx.query(`SELECT fn_formula_try($1,$2::jsonb) e`,
          [formula, JSON.stringify(allow)])).rows[0].e;
        if (bad) error = String(bad).split('\n')[0].slice(0, 240);
        else itemKind = 'formula';
      }
    }

    if (!error) {
      await tx.query(
        `INSERT INTO salary_item(code, name, item_kind, formula, sort_order, is_active, note)
         VALUES ($1,$2,$3,$4,$5,true,$6)
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name, item_kind = EXCLUDED.item_kind,
               formula = EXCLUDED.formula, sort_order = EXCLUDED.sort_order,
               is_active = true, note = EXCLUDED.note`,
        [code, name, itemKind, formula || null, order ?? 100, `导入自 ${filename}`.slice(0, 200)]);
      known.add(code);
      results.push({ row_no, payload: { ...payload, item_kind: itemKind }, ok: true, error: null });
    } else {
      results.push({ row_no, payload, ok: false, error });
    }
  }

  return finishBatch(tx, batchId, results);
}

/**
 * 导入每人金额（data）。这一步只解析 + 校验 + 留痕，**不写工资结构** ——
 * 应用是单独一次动作（applyBatch），因为"导进来"和"发多少钱"之间
 * 应该有一次人看得见的确认。
 */
export async function importData(tx, { buffer, filename, period, userId }) {
  const grid = readSheet(buffer, filename);
  if (!grid.length) throw bizErr('E_IMPORT_EMPTY', '文件里没有任何行');
  const { headers, rows } = toObjects(grid);

  const iNo = pickCol(headers, DATA_COLS.no);
  const iName = pickCol(headers, DATA_COLS.name);
  if (iNo < 0 && iName < 0) {
    throw bizErr('E_IMPORT_HEADER',
      `表头里必须有「工号」或「姓名」列（当前表头：${headers.join(' / ')}）`);
  }

  // 项目列：除工号/姓名之外的每一列，按"名称"或"代码"匹配已登记项目
  const items = (await tx.query(
    `SELECT code, name, item_kind FROM salary_item WHERE is_active`)).rows;
  const byName = new Map(items.map(x => [String(x.name).trim(), x]));
  const byCode = new Map(items.map(x => [x.code, x]));
  const colItem = [];   // [{ idx, code|null, name }]
  headers.forEach((h, idx) => {
    if (idx === iNo || idx === iName || !h) return;
    const hit = byCode.get(String(h).trim().toUpperCase()) || byName.get(String(h).trim());
    colItem.push({ idx, header: h, code: hit?.code ?? null, itemKind: hit?.item_kind ?? null });
  });
  if (!colItem.length) throw bizErr('E_IMPORT_HEADER', '表里没有任何工资项目列');

  const batchId = Number((await tx.query(
    `INSERT INTO salary_import_batch(kind, filename, row_total, created_by, note)
     VALUES ('data',$1,$2,$3,$4) RETURNING id`,
    [String(filename).slice(0, 200), rows.length, String(userId),
     `期间 ${period || '未指定'}`])).rows[0].id);

  const results = [];
  for (const { row_no, cells } of rows) {
    const empNo = iNo >= 0 ? String(cells[iNo] ?? '').trim() : '';
    const who = iName >= 0 ? String(cells[iName] ?? '').trim() : '';
    const payload = { employee_no: empNo, name: who };
    let error = null;

    const person = (await tx.query(
      `SELECT COALESCE(
                (SELECT n.assigned_person_id FROM employee_no n
                  WHERE n.no = $1 AND n.retired_at IS NULL),
                (SELECT p.id FROM person p WHERE $1 <> '' AND p.full_name = $1 LIMIT 1)
              ) pid`, [empNo || who])).rows[0]?.pid;

    if (!person) error = `E_ROW_PERSON: 找不到工号/姓名「${empNo || who}」对应的人`;
    if (!error) {
      payload.person_id = Number(person);
      for (const ci of colItem) {
        const raw = String(cells[ci.idx] ?? '').trim();
        if (raw === '') continue;
        const amt = toAmount(raw);
        if (amt === null) { error = `E_ROW_AMOUNT: 「${ci.header}」不是金额（${raw}）`; break; }
        if (!ci.code) { error = `E_ROW_ITEM: 表里的「${ci.header}」不是已登记的工资项，先导项目表`; break; }
        if (ci.itemKind === 'formula') { error = `E_ROW_ITEM: 「${ci.header}」是公式项，金额由系统算，不能直接给`; break; }
        payload[ci.code] = amt;
      }
    }
    results.push({ row_no, payload, ok: !error, error });
  }

  // 同一个人出现两行 → 整批拒绝（合并会让"以哪行为准"变成没人说得清的事）
  const seen = new Map();
  for (const r of results) {
    if (!r.ok || !r.payload.person_id) continue;
    if (seen.has(r.payload.person_id)) {
      r.ok = false;
      r.error = `E_ROW_DUP: 同一个人在第 ${seen.get(r.payload.person_id)} 行已经出现过`;
    } else seen.set(r.payload.person_id, r.row_no);
  }

  return finishBatch(tx, batchId, results);
}

async function finishBatch(tx, batchId, results) {
  for (const r of results) {
    await tx.query(
      `INSERT INTO salary_import_row(batch_id, row_no, payload, ok, error)
       VALUES ($1,$2,$3::jsonb,$4,$5)`,
      [batchId, r.row_no, JSON.stringify(r.payload), r.ok, r.error]);
  }
  const ok = results.filter(r => r.ok).length;
  const fail = results.length - ok;
  await tx.query(
    `UPDATE salary_import_batch SET row_ok=$2, row_fail=$3, status=$4 WHERE id=$1`,
    [batchId, ok, fail, 'parsed']);
  return { batchId, total: results.length, ok, fail, rows: results };
}

/** 批次详情（含逐行结论） */
export async function getBatch(tx, batchId) {
  const b = (await tx.query(
    `SELECT * FROM salary_import_batch WHERE id=$1`, [batchId])).rows[0];
  if (!b) throw bizErr('E_NOT_FOUND', `导入批次 ${batchId} 不存在`);
  const rows = (await tx.query(
    `SELECT row_no, payload, ok, error FROM salary_import_row
      WHERE batch_id=$1 ORDER BY row_no`, [batchId])).rows;
  return { batch: b, rows };
}

/**
 * 应用数据批次：把每人的金额写成"月薪标准 + 工资结构"。
 * ★ 合计 = 全部项目之和。结构与月薪必须相等（fn_salary_structure_set 会校验），
 *   所以两步写在同一个事务里，任何一个人失败就整批回滚。
 */
export async function applyDataBatch(tx, { batchId, period, userId }) {
  const { batch, rows } = await getBatch(tx, batchId);
  if (batch.kind !== 'data') throw bizErr('E_ARG_INVALID', '只有"每人金额"批次需要应用（项目批次导入即生效）');
  if (batch.status === 'applied') throw bizErr('E_ALREADY_APPLIED', '这一批已经应用过了');
  if (batch.row_fail > 0) throw bizErr('E_IMPORT_HAS_ERROR', `还有 ${batch.row_fail} 行没通过校验，先修表`);

  const p0 = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))
    ? period
    : (await tx.query(`SELECT to_char(app_today(),'YYYY-MM') p`)).rows[0].p;
  const from = `${p0}-01`;
  // ★ 在职判断用**期末**，不是期初：月中入职的人（比如 11-14 入职）
  //   在 11-01 还不存在，但他的 11 月工资是要发的。算薪用的是期末，这里必须一致，
  //   否则"导进去了但发不出来"，而原因看起来像"这个人没在职"。
  const to = (await tx.query(
    `SELECT (to_date($1||'-01','YYYY-MM-DD') + interval '1 month - 1 day')::date d`,
    [p0])).rows[0].d;
  const byPerson = new Map();
  for (const r of rows) {
    const p = r.payload;
    if (!p.person_id) continue;
    if (!byPerson.has(p.person_id)) byPerson.set(p.person_id, {});
    for (const [k, v] of Object.entries(p)) {
      if (/^[A-Z][A-Z0-9_]+$/.test(k) && typeof v === 'number') byPerson.get(p.person_id)[k] = v;
    }
  }

  let done = 0;
  for (const [personId, items] of byPerson) {
    const emp = (await tx.query(
      `SELECT e.id FROM employment e
        WHERE e.person_id = $1 AND daterange(e.hire_date, e.leave_date,'[]') @> $2::date
        ORDER BY e.hire_date DESC LIMIT 1`, [personId, to])).rows[0];
    if (!emp) throw bizErr('E_ROW_PERSON', `人员 ${personId} 在 ${from} 没有在职记录`);

    const total = Object.values(items).reduce((a, b) => a + b, 0);
    if (!(total > 0)) throw bizErr('E_ROW_AMOUNT', `人员 ${personId} 的项目合计为 0`);

    // ★ 导入覆盖也走**调整单**（106）：否则"手工调的"有 before/after 痕迹、
    //   "导入覆盖的"没有 —— 而后者一次能改几十个人，出事时更该查得到。
    const arr = Object.entries(items).map(([item_code, amount]) => ({ item_code, amount }));
    const adjCode = (await tx.query(
      `SELECT fn_salary_adjust_create($1,$2,$3::jsonb,$4,'import',$5) c`,
      [personId, p0, JSON.stringify(arr), `工资表导入覆盖（${batch.filename}）`.slice(0, 200),
       String(userId)])).rows[0].c;
    await tx.query(`SELECT fn_salary_adjust_apply($1,$2)`, [adjCode, String(userId)]);
    done += 1;
  }

  await tx.query(
    `UPDATE salary_import_batch SET status='applied', applied_at=now() WHERE id=$1`, [batchId]);
  return { batchId, applied: done, period: from.slice(0, 7) };
}
