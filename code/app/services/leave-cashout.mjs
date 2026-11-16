// ============================================================================
// app/services/leave-cashout.mjs · 未休年假折现（129）
// ----------------------------------------------------------------------------
// 这一层只做三件事：读口径与台账、试算、登记/作废。金额一分都不在这里算 ——
// 全部由 fn_annual_leave_quote / fn_annual_leave_cashout 出。
//
// 为什么要"试算"单独一个接口：折现是发钱，登记即留痕。
// 如果只能"登记一下看看多少"，HR 每次估价都会在台账上留下一条需要作废的单，
// 而作废单本身又会被审计问到"为什么作废了 5 次"。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payroll_run', write: 'payroll_policy' };

const isPeriod = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** 页面数据：口径 + 档位 + 本年度台账 + 可否改 */
export async function overview(tx, { userId, year }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  const y = Number(year) || Number((await tx.query('SELECT EXTRACT(year FROM app_today()) y')).rows[0].y);

  const policy = (await tx.query(
    `SELECT value_text AS mode FROM fn_policy_effective('LEAVE_ANNUAL_CASHOUT', NULL, app_today())`
  )).rows[0]?.mode || 'off';

  // 结转政策（132）：默认 void = 往年余额不参与折现
  const carry = (await tx.query(
    `SELECT
       (SELECT value_text FROM fn_policy_effective('LEAVE_CARRY_POLICY', NULL, app_today())) pol,
       (SELECT value_text FROM fn_policy_effective('LEAVE_CARRY_DEADLINE', NULL, app_today())) dl`
  )).rows[0] || {};

  const tiers = (await tx.query(
    `SELECT years_from, days, note FROM annual_leave_tier ORDER BY years_from`)).rows;

  const rows = (await tx.query(
    `SELECT c.id, c.employee_id, p.full_name AS person_name,
            (SELECT n.no FROM employee_no n WHERE n.assigned_person_id = p.id
                   AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            c.leave_year, c.days, c.monthly_wage, c.daily_wage, c.rate, c.amount,
            c.settle_period, c.status, c.reason, c.created_by, c.created_at
       FROM leave_cashout c
       JOIN person p ON p.id = c.employee_id
      WHERE c.leave_year = $1
      ORDER BY c.id DESC`, [y])).rows;

  // 谁还有可折的假：HR 得先看得见"谁会掉额度"，不然年底才发现一堆人没折
  const candidates = (await tx.query(
    `SELECT e.person_id, p.full_name AS person_name,
            (SELECT n.no FROM employee_no n WHERE n.assigned_person_id = p.id
                   AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            fn_cumulative_years(e.person_id, app_today()) AS years,
            fn_annual_leave_days(e.person_id, app_today()) AS entitled,
            fn_annual_leave_unused(e.person_id, app_today()) AS unused
       FROM employment e
       JOIN person p ON p.id = e.person_id
      WHERE e.leave_date IS NULL
        AND fn_annual_leave_unused(e.person_id, app_today()) > 0
      ORDER BY fn_annual_leave_unused(e.person_id, app_today()) DESC, p.full_name
      LIMIT 100`)).rows;

  return { year: y, policy, carry: carry.pol || 'void', carryDeadline: carry.dl || '03-31',
           tiers, rows, candidates, canWrite };
}

/** 试算：不落账，只回答"会付多少" */
export async function quote(tx, { userId, employeeId, on }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（这里要的是 person.id，不是工号）');
  }
  if (on && !isDate(on)) throw bizErr('E_ARG_INVALID', 'on 必须是 YYYY-MM-DD');

  const d = on || (await tx.query('SELECT app_today() d')).rows[0].d;
  const q = (await tx.query(`SELECT * FROM fn_annual_leave_quote($1,$2)`, [employeeId, d])).rows[0];
  const who = (await tx.query(
    `SELECT p.full_name AS name, (SELECT n.no FROM employee_no n WHERE n.assigned_person_id = p.id
                   AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            fn_cumulative_years($1,$2) AS years
       FROM person p WHERE p.id = $1`, [employeeId, d])).rows[0];

  // 按年度拆开（132）：HR 要能回答"这 6 天里哪 3 天是去年的"
  const breakdown = (await tx.query(
    `SELECT leave_year, granted, used, cashed, remaining, state
       FROM fn_annual_leave_breakdown($1,$2) ORDER BY leave_year`, [employeeId, d])).rows;

  return {
    employee_id: employeeId, on: d, name: who?.name ?? null, employee_no: who?.employee_no ?? null,
    years: who?.years ?? null,
    breakdown: breakdown.map(b => ({
      year: Number(b.leave_year), granted: Number(b.granted), used: Number(b.used),
      cashed: Number(b.cashed), remaining: Number(b.remaining), state: b.state,
    })),
    days: Number(q.days), monthly_wage: Number(q.monthly_wage), daily_wage: Number(q.daily_wage),
    rate: Number(q.rate), amount: Number(q.amount), mode: q.mode,
    // 口径说明直接跟着数走：界面不用自己拼文案，也不用猜 2 和 3 分别什么意思
    explain: q.mode === 'off' ? '当前制度是 off：未休年假不折现，一分不付'
      : q.mode === 'total_300' ? '一次性 300%：不再另发那几天的正常工资（离职已结清的情形）'
        : '额外补 200%：300% 里含已照发的正常工资，所以在职折现只补 2 倍',
  };
}

/** 登记折现：写台账，进下个月（或指定月）工资条 */
export async function create(tx, { userId, employeeId, on, period, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw bizErr('E_ARG_INVALID', 'employee 必须是正整数');
  }
  if (on && !isDate(on)) throw bizErr('E_ARG_INVALID', 'on 必须是 YYYY-MM-DD');
  if (!isPeriod(period)) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM（落到哪个月工资）');
  if (String(reason || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）—— 折现是发钱，要说得清为什么');
  }
  const d = on || (await tx.query('SELECT app_today() d')).rows[0].d;

  const id = Number((await tx.query(
    `SELECT fn_annual_leave_cashout($1,$2,$3,$4,$5) i`,
    [employeeId, d, period, String(reason).trim(), String(userId)])).rows[0].i);

  const row = (await tx.query(`SELECT * FROM leave_cashout WHERE id = $1`, [id])).rows[0];
  return {
    id, days: Number(row.days), amount: Number(row.amount), rate: Number(row.rate),
    settle_period: row.settle_period, status: row.status,
    _log: { employee_id: employeeId, days: Number(row.days), amount: Number(row.amount) },
  };
}

/** 作废：只有钱还没进工资条才能作废 */
export async function voidOne(tx, { userId, id, why }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!Number.isInteger(id) || id <= 0) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  if (String(why || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '作废要写原因（至少 4 个字）');
  }
  await tx.query(`SELECT fn_annual_leave_cashout_void($1,$2,$3)`,
    [id, String(why).trim(), String(userId)]);
  return { id, status: 'void', _log: { id, why } };
}

/**
 * 改折现口径。只认 off / extra_200 / total_300 三个值。
 * ★ 走 policy_value 而不是直接 UPDATE policy_def：口径是有生效日的，
 *   今天改成 300%、上个月的工资条不能跟着变（政策页那套规矩照旧）。
 */
export async function setPolicy(tx, { userId, mode, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const m = String(mode || '').trim();
  if (!['off', 'extra_200', 'total_300'].includes(m)) {
    throw bizErr('E_ALC_MODE', '口径只支持 off / extra_200 / total_300');
  }
  if (String(reason || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）—— 这一项决定"要不要开始给大家折现"');
  }
  const today = (await tx.query('SELECT app_today() d')).rows[0].d;
  await tx.query(
    `INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
     VALUES ('LEAVE_ANNUAL_CASHOUT', $1, $2, $3, $4)
     ON CONFLICT (policy_code, effective_from) DO UPDATE
       SET value_text = EXCLUDED.value_text, published_by = EXCLUDED.published_by,
           reason = EXCLUDED.reason`,
    [today, m, String(userId), String(reason).trim()]);
  return { mode: m, effective_from: today, _log: { mode: m, reason } };
}

/** 改结转政策（往年余额算不算） */
export async function setCarry(tx, { userId, policy, deadline, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const p = String(policy || '').trim();
  if (!['void', 'carry_1y'].includes(p)) {
    throw bizErr('E_ARG_INVALID', '结转政策只支持 void（不结转，法定）/ carry_1y（结转一年）');
  }
  const dl = String(deadline || '03-31').trim();
  if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dl)) {
    throw bizErr('E_ARG_INVALID', '截止日写 MM-DD（如 03-31）');
  }
  if (String(reason || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）—— 这一项决定"去年的假还算不算"');
  }
  const today = (await tx.query('SELECT app_today() d')).rows[0].d;
  await tx.query(
    `INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
     VALUES ('LEAVE_CARRY_POLICY', $1, $2, $3, $4)
     ON CONFLICT (policy_code, effective_from) DO UPDATE
       SET value_text = EXCLUDED.value_text, published_by = EXCLUDED.published_by,
           reason = EXCLUDED.reason`, [today, p, String(userId), String(reason).trim()]);
  await tx.query(
    `INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
     VALUES ('LEAVE_CARRY_DEADLINE', $1, $2, $3, $4)
     ON CONFLICT (policy_code, effective_from) DO UPDATE
       SET value_text = EXCLUDED.value_text, published_by = EXCLUDED.published_by,
           reason = EXCLUDED.reason`, [today, dl, String(userId), String(reason).trim()]);
  return { policy: p, deadline: dl, effective_from: today, _log: { policy: p, deadline: dl } };
}

/** 改年假档位：只能往上调，法定是下限 */
export async function setTier(tx, { userId, yearsFrom, days, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const y = Number(yearsFrom);
  const d = Number(days);
  if (!Number.isFinite(y) || y < 0) throw bizErr('E_ARG_INVALID', '年限必须是非负数字');
  if (!Number.isFinite(d) || d <= 0) throw bizErr('E_ARG_INVALID', '天数必须是正数');
  if (String(reason || '').trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）');
  }
  // 法定下限先在这里拦一次：库里也有 ck_alt_legal，但 23514 读起来不像人话
  const legal = y >= 20 ? 15 : (y >= 10 ? 10 : 5);
  if (d < legal) {
    throw bizErr('E_AL_TIER_LOW', `累计工龄满 ${y} 年法定 ${legal} 天，只能多给不能少给`);
  }
  const r = await tx.query(
    `UPDATE annual_leave_tier SET days = $2, note = COALESCE(note,'') || ' | ' || $3
      WHERE years_from = $1 RETURNING years_from`, [y, d, String(reason).trim().slice(0, 40)]);
  if (r.rowCount === 0) {
    throw bizErr('E_NOT_FOUND', `没有累计工龄满 ${y} 年这一档（新增档位请直接改库并写迁移）`);
  }
  return { years_from: y, days: d, _log: { years_from: y, days: d, reason } };
}
