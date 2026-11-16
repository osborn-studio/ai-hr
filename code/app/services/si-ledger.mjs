// ============================================================================
// app/services/si-ledger.mjs · 社保参保台账：参保 / 停缴 / 调基 / 月度明细 / 对账
// ----------------------------------------------------------------------------
// 这一层只做四件事：校验参数形状、灌权限、调库、把 numeric 转成数。
// **所有判断都在库里**（166 的 fn_si_*）：
//   · 起缴月是否早于入职月、晚于离职月；
//   · 同人同城同险种的期间是否重叠（排他约束，23P01）；
//   · 基数是否越出 si_policy 的上下限；
//   · 调基的旧基数、历史段收口到哪一个月。
// JS 里再判一遍，就有两处会漂 —— 而漂的那一次是**给一个人少缴了五个月社保**。
//
// ★ 与 141 申报表的边界：
//   申报表回答"按当期政策应当报多少"（给社保局）；
//   台账回答"当时实际按多少缴的"（给员工、给稽核）。
//   两个数不一样时，不是哪个函数写错了，是**真的不一致** —— 对账（reconcile）
//   就是把这个不一致逐人列出来，而不是让其中一个数去迁就另一个。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

// 社保属于薪酬域：能算薪的人才能改参保台账（参保基数直接决定工资条扣多少）
export const RESOURCES = { read: 'payroll_run', write: 'payroll_run' };

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const isId = (v) => Number.isInteger(v) && v > 0;
const num = (v) => (v === null || v === undefined ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

const needPeriod = (v, label) => {
  const p = str(v);
  if (!p || !PERIOD.test(p)) {
    throw bizErr('E_ARG_INVALID', `${label} 必须是 YYYY-MM（收到 ${v ?? '空'}）`);
  }
  return p;
};

// 险种入参：字符串或 { item, base_amount }。不在 JS 里校验险种名 ——
// 规范键由库里的 fn_si_item_canon 归一（142 定的规矩：入口只一处）。
// 允许的键。★ `base` 是 `base_amount` 的别名 —— 库里只认 base_amount，
//   而"base"是所有人第一次都会写的那个词。别名可以给，**未知键不行**：
//   全生命周期验收里发现，传 { item:'pension', base:6000 } 时库里读不到 base_amount，
//   会**静默回落到月薪 8000** —— 不报错、基数悄悄换了另一个数，
//   少缴多缴都补不回来。静默取另一个值比报错严重得多。
const ITEM_KEYS = ['item', 'base_amount', 'base'];

const needItems = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw bizErr('E_ARG_INVALID', 'items 必须是非空数组（如 ["pension","medical"]）');
  }
  return items.map((it, i) => {
    if (typeof it === 'string' && it.trim()) return { item: it.trim() };
    if (!it || typeof it !== 'object') {
      throw bizErr('E_ARG_INVALID',
        `items 第 ${i + 1} 项只能是险种键字符串或 { item, base_amount }`);
    }
    const unknown = Object.keys(it).filter((k) => !ITEM_KEYS.includes(k));
    if (unknown.length) {
      throw bizErr('E_SIL_BAD_ARG',
        `items 第 ${i + 1} 项有无法识别的字段「${unknown.join('、')}」——`
        + `只认 ${ITEM_KEYS.join(' / ')}。不给报错就会静默回落到月薪，基数悄悄换了另一个数`);
    }
    if (!str(it.item)) throw bizErr('E_SIL_BAD_ARG', `items 第 ${i + 1} 项缺 item（险种键）`);
    const base = it.base_amount ?? it.base ?? null;
    if (base !== null && !Number.isFinite(Number(base))) {
      throw bizErr('E_SIL_BAD_ARG', `items 第 ${i + 1} 项的基数不是数字`);
    }
    return { item: str(it.item), base_amount: base === null ? null : Number(base) };
  });
};

/**
 * 参保台账清单。
 * period 给了就只看"该月仍在缴"的段 —— 这是回答「他 3 月参保了吗」的入口：
 * 有行 = 在缴，无行 = 没参保。**不要用工资条反推**（见 166 文件头 ①）。
 */
export async function enrollments(tx, { userId, employeeId = null, city = null,
  period = null, openOnly = false }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });  // ★ 行闸（170）：这四个读接口原来 requireSession 之后就直查全表，
  //   于是 A 店 HR 打开页面看到的是全集团的人（权限矩阵 PM8 抓到）。
  //   人员范围一律以「花名册口径」为准：先按 employee_roster 重建 scope，
  //   再用 fn_scope_people() 过滤 —— 那是行闸的唯一表达式，不要手抄 EXISTS。
  await tx.query('SELECT app_begin_scope($1,$2,$3)',
    [userId, 'employee_roster', null]);

  if (employeeId !== null && !isId(Number(employeeId))) {
    throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  }
  const p = period === null ? null : needPeriod(period, 'period');
  const rows = (await tx.query(
    `SELECT e.id, e.employee_id, e.city, e.item,
            public.fn_si_item_name(e.item) AS item_name,
            public.fn_si_item_seq(e.item) AS seq,
            e.start_period, e.end_period, e.base_amount,
            e.rate_employee, e.rate_employer, e.source, e.note,
            e.created_by, e.created_at,
            pe.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = e.employee_id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            round(e.base_amount * e.rate_employee, 2) AS emp_amount,
            round(e.base_amount * e.rate_employer, 2) AS er_amount
       FROM si_enrollment e
       LEFT JOIN person pe ON pe.id = e.employee_id
      WHERE ($1::bigint IS NULL OR e.employee_id = $1)
        AND e.employee_id IN (SELECT employee_id FROM fn_scope_people())
        AND ($2::text IS NULL OR e.city = $2)
        AND ($3::text IS NULL OR (e.start_period <= $3
              AND (e.end_period IS NULL OR e.end_period >= $3)))
        AND (NOT $4::boolean OR e.end_period IS NULL)
      ORDER BY e.employee_id, e.city, public.fn_si_item_seq(e.item), e.item,
               e.start_period DESC
      LIMIT 1000`,
    [employeeId === null ? null : Number(employeeId), str(city), p,
      Boolean(openOnly)])).rows;

  const open = rows.filter((r) => r.end_period === null);
  return {
    rows: rows.map((r) => ({
      ...r,
      id: Number(r.id),
      employee_id: Number(r.employee_id),
      seq: Number(r.seq),
      base_amount: num(r.base_amount),
      rate_employee: num(r.rate_employee),
      rate_employer: num(r.rate_employer),
      emp_amount: num(r.emp_amount),
      er_amount: num(r.er_amount),
    })),
    kpi: {
      total: rows.length,
      // 在缴段：end_period 为空。这个数才是"当前参保人数×险种"的真实口径
      open: open.length,
      people: new Set(rows.map((r) => String(r.employee_id))).size,
      cities: new Set(rows.map((r) => r.city)).size,
      // 只数在缴段的月缴个人部分，避免把已停缴的历史段也算成当前成本
      monthly_employee: open.reduce((s, r) => s + Number(r.emp_amount || 0), 0),
    },
  };
}

/**
 * 参保（批量险种）。
 * ★ 起缴月由调用方给，不从 hire_date 推算 —— 入职当月缴不缴各地不同，
 *   推算在跨月 15 日前后会给出两个都"看起来合理"的答案（166 文件头 ①）。
 */
export async function enroll(tx, { userId, employeeId, city, items, fromPeriod }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  const c = str(city);
  if (!c) throw bizErr('E_ARG_INVALID', 'city 必填（参保城市决定费率与上下限）');
  const from = needPeriod(fromPeriod, 'fromPeriod');
  const list = needItems(items);

  const n = Number((await tx.query(
    `SELECT fn_si_enroll($1,$2,$3::jsonb,$4,$5) AS n`,
    [Number(employeeId), c, JSON.stringify(list), from, String(userId)])).rows[0].n);

  return {
    employee_id: Number(employeeId),
    city: c,
    from_period: from,
    // inserted=0 表示这几段已经记过（同基数同费率幂等）；不是失败
    inserted: n,
    items: list,
    _log: { employee: Number(employeeId), city: c, from, inserted: n },
  };
}

/** 停缴：末缴月含在内。行不删，只是收口 —— 删了就答不出"他 3 月参保了吗"。 */
export async function stop(tx, { userId, employeeId, city, endPeriod }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  const c = str(city);
  if (!c) throw bizErr('E_ARG_INVALID', 'city 必填');
  const end = needPeriod(endPeriod, 'endPeriod');

  const n = Number((await tx.query(
    `SELECT fn_si_stop($1,$2,$3,$4) AS n`,
    [Number(employeeId), c, end, String(userId)])).rows[0].n);

  return {
    employee_id: Number(employeeId),
    city: c,
    end_period: end,
    stopped: n,
    _log: { employee: Number(employeeId), city: c, end, stopped: n },
  };
}

/**
 * 调基：旧段收口 + 留痕 + 新段。
 * reason 必填 —— 员工问"为什么这个月扣多了"时，这是唯一的解释。
 */
export async function adjustBase(tx, { userId, employeeId, city, effectivePeriod,
  newBase, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  const c = str(city);
  if (!c) throw bizErr('E_ARG_INVALID', 'city 必填');
  const eff = needPeriod(effectivePeriod, 'effectivePeriod');
  const b = num(newBase);
  if (!Number.isFinite(b) || b <= 0) {
    throw bizErr('E_ARG_INVALID', 'newBase 必须是大于 0 的数');
  }
  const why = str(reason);
  if (!why) {
    throw bizErr('E_ARG_INVALID', 'reason 必填（调基要能回答"为什么调"）');
  }

  const n = Number((await tx.query(
    `SELECT fn_si_adjust_base($1,$2,$3,$4,$5,$6) AS n`,
    [Number(employeeId), c, eff, b, why, String(userId)])).rows[0].n);

  return {
    employee_id: Number(employeeId),
    city: c,
    effective_period: eff,
    new_base: b,
    // adjusted = 本次一并调整的险种数（各项基数可能因上下限不同而各自夹逼）
    adjusted: n,
    _log: { employee: Number(employeeId), city: c, effective: eff, base: b },
  };
}

/**
 * 某月逐险种明细：基数、个人额、单位额。
 * 空数组 = 这个月没有参保记录（不是"扣了 0"）。两者在回答员工时必须分开。
 */
export async function month(tx, { userId, employeeId, period }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  const p = needPeriod(period, 'period');

  const rows = (await tx.query(
    `SELECT * FROM fn_si_month($1,$2)`,
    [Number(employeeId), p])).rows;

  return {
    employee_id: Number(employeeId),
    period: p,
    // enrolled=false 是"这个月没参保"，与"参保但费率 0"是两件事
    enrolled: rows.length > 0,
    rows: rows.map((r) => ({
      ...r,
      seq: Number(r.seq),
      base_amount: num(r.base_amount),
      rate_employee: num(r.rate_employee),
      rate_employer: num(r.rate_employer),
      emp_amount: num(r.emp_amount),
      er_amount: num(r.er_amount),
    })),
    totals: {
      employee: rows.reduce((s, r) => s + Number(r.emp_amount || 0), 0),
      employer: rows.reduce((s, r) => s + Number(r.er_amount || 0), 0),
    },
  };
}

/**
 * 对账：台账算出的个人额 vs 工资条实际扣款。
 * ★ 缺一边也算差异：
 *   no_ledger = 工资扣了社保，台账上没有 → 漏保（稽核会问"这些钱缴到哪去了"）；
 *   no_payslip = 台账在缴，本期却没有工资条 → 漏扣或少报。
 *   只返回 status != 'ok' 的明细放在 mismatches，页面直接拿它做待办。
 */
export async function reconcile(tx, { userId, period }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const p = needPeriod(period, 'period');

  const rows = (await tx.query(
    `SELECT * FROM fn_si_reconcile($1)`, [p])).rows;
  const mapped = rows.map((r) => ({
    ...r,
    ledger_employee: num(r.ledger_employee),
    payslip_employee: num(r.payslip_employee),
    diff: num(r.diff),
  }));
  const by = (s) => mapped.filter((r) => r.status === s);

  return {
    period: p,
    rows: mapped,
    mismatches: mapped.filter((r) => r.status !== 'ok'),
    kpi: {
      people: mapped.length,
      ok: by('ok').length,
      diff: by('diff').length,
      no_ledger: by('no_ledger').length,
      no_payslip: by('no_payslip').length,
      abs_diff: mapped.reduce((s, r) => s + Math.abs(Number(r.diff || 0)), 0),
    },
  };
}
