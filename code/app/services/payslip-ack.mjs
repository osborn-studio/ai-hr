// ============================================================================
// app/services/payslip-ack.mjs · 工资条签收（186）
// ----------------------------------------------------------------------------
// 与 `payslip-view.mjs` 是两件事，别合并：
//   · 留痕（184/185）回答"**谁看过**"        → 取证，append-only
//   · 签收（本文件）回答"**我认不认这张数**" → 发薪闭环，一张单一条回执
//
// ★ 三条判据都在这里，路由不重复实现：
//   ① 只能签**自己的**（employee_id 由会话推出来，不从参数取）；
//   ② 一张单只有一条回执（`UNIQUE (payslip_id)` + ON CONFLICT DO NOTHING，
//      重复点不报错也不改时间 —— 幂等，因为"再点一次"不是错误）；
//   ③ 代录（纸质回执录回系统）要 `payroll_run` **写**权限，并记下 `acked_by`。
//
// ★ 为什么 employee_id 从会话取而不是参数取：
//   参数可以被改。签收是"本人确认"，如果 employee_id 能传，代签就成了一个
//   参数错误 —— 而代签在合规上是最不能出现的那类事。
// ============================================================================
import { requireSession, prepareRead } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payslip', manage: 'payroll_run', all: 'payroll_slips_read_all' };

const isBig = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

/** 会话 → person.id。没有绑人的账号签不了（不是 403，是"你没有工资条"）。 */
async function myPerson(tx, userId) {
  const p = (await tx.query('SELECT fn_my_person($1) p', [userId])).rows[0].p;
  return p === null ? null : Number(p);
}

/**
 * 本人签收一张工资条。
 * @param slipId 指定哪一张（不给就签"我在该批次/最新"的那一张）
 * @param runId  指定批次（与 slipId 二选一）
 */
export async function ackSelf(tx, { userId, slipId = null, runId = null, ip = null }) {
  await requireSession(tx, { userId, resource: RESOURCES.read });
  const me = await myPerson(tx, userId);
  if (me === null) throw bizErr('E_NO_EMPLOYEE', '当前账号没有对应的人员记录，签不了工资条');

  if (slipId !== null && !isBig(slipId)) throw bizErr('E_ARG_INVALID', 'slip 必须是正整数');
  if (runId !== null && !isBig(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数');

  // ★ 一定要带 `p.employee_id = me`：这是"只能签自己"的唯一实现。
  //   想改成"按 slip 直接找"的话，代签就只差一个参数了。
  const slip = (await tx.query(
    `SELECT p.id, p.pay_run_id, p.employee_id
       FROM payslip p
      WHERE p.employee_id = $1
        AND ($2::bigint IS NULL OR p.id = $2)
        AND ($3::bigint IS NULL OR p.pay_run_id = $3)
      ORDER BY p.id DESC
      LIMIT 1`, [me, slipId, runId])).rows[0];
  if (!slip) {
    throw bizErr('E_SLIP_NOT_FOUND',
      slipId !== null
        ? '这张工资条不存在，或者不是你本人的（只能签自己的）'
        : '你在该批次里没有工资条');
  }

  const ins = (await tx.query(
    `INSERT INTO payslip_ack(payslip_id, employee_id, pay_run_id, method, acked_by, ip)
     VALUES ($1,$2,$3,'web',$4,$5)
     ON CONFLICT (payslip_id) DO NOTHING
     RETURNING id, acked_at`, [slip.id, me, slip.pay_run_id, userId, ip])).rows[0];

  if (ins) {
    return { payslip_id: Number(slip.id), pay_run_id: Number(slip.pay_run_id),
      acked_at: ins.acked_at, already: false };
  }
  // 已经签过：返回原来那条（幂等）。★ 不改时间 —— 改了就成了"他刚才又签了一次"，
  // 而事实是他没再签，只是又点了一下按钮。
  const old = (await tx.query(
    `SELECT acked_at FROM payslip_ack WHERE payslip_id = $1`, [slip.id])).rows[0];
  return { payslip_id: Number(slip.id), pay_run_id: Number(slip.pay_run_id),
    acked_at: old ? old.acked_at : null, already: true };
}

/**
 * 代录纸质回执（HR）。需要 `payroll_run` 写权限，并记下经办人。
 * ★ 为什么不复用 ackSelf：代录的 employee_id 来自**参数**（纸质单上的人），
 *   与"本人从会话取"是两条完全不同的信任路径，混成一个函数迟早会把
 *   "本人签"写成"谁能传参数谁就能签"。
 */
export async function ackOnBehalf(tx, { userId, slipId, method = 'paper', note = null, ip = null }) {
  if (!isBig(slipId)) throw bizErr('E_ARG_INVALID', 'slip 必须是正整数');
  if (!['paper', 'import'].includes(method)) {
    throw bizErr('E_ARG_INVALID', '代录的 method 只能是 paper（纸质）或 import（导入）');
  }
  await requireSession(tx, { userId, resource: RESOURCES.manage, action: 'write' });

  const slip = (await tx.query(
    `SELECT id, pay_run_id, employee_id FROM payslip WHERE id = $1`, [slipId])).rows[0];
  if (!slip) throw bizErr('E_SLIP_NOT_FOUND', '这张工资条不存在');

  const ins = (await tx.query(
    `INSERT INTO payslip_ack(payslip_id, employee_id, pay_run_id, method, acked_by, ip, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (payslip_id) DO NOTHING
     RETURNING id, acked_at`,
    [slip.id, slip.employee_id, slip.pay_run_id, method, userId, ip, note])).rows[0];

  if (ins) {
    return { payslip_id: Number(slip.id), employee_id: Number(slip.employee_id),
      method, acked_at: ins.acked_at, already: false };
  }
  const old = (await tx.query(
    `SELECT acked_at, method, acked_by FROM payslip_ack WHERE payslip_id = $1`, [slip.id])).rows[0];
  return { payslip_id: Number(slip.id), employee_id: Number(slip.employee_id),
    method: old ? old.method : method, acked_at: old ? old.acked_at : null, already: true };
}

/**
 * 签收进度。
 * ★ 行闸在这里做（`fn_scope_people`），视图 `v_payslip_ack_progress` 不带范围 ——
 *   两处各带一套范围，迟早会漂，而"我看到 374 张、HR 看到 380 张"这种差
 *   现场没有人能解释。
 */
export async function viewAcks(tx, { userId, runId = null }) {
  await prepareRead(tx, { userId, resource: RESOURCES.read });
  const seeAll = (await tx.query('SELECT fn_role_can($1,$2,$3) o',
    [userId, RESOURCES.all, 'read'])).rows[0].o === true;
  const me = await myPerson(tx, userId);

  if (runId !== null && !isBig(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数');

  // ★ 187 起必须读 **v_payslip_ack_effective**，不能再直接 JOIN payslip_ack：
  //   签收可以被撤回，而撤回**不会删原回执**（那等于"他从没签过"）。
  //   直接 JOIN 原表会把"已撤回"算成已签 —— 于是同一份数据，
  //   /api/payslip/acks 说签了、库里的进度视图说没签，两边各对一半。
  //   视图列名与原表完全一致，所以只换表名。
  // 自己那张：无论有没有 read_all，都先给出来（这是员工最关心的一行）
  const mine = (await tx.query(
    `SELECT p.id AS payslip_id, p.pay_run_id, a.acked_at, a.method
       FROM payslip p
       LEFT JOIN v_payslip_ack_effective a ON a.payslip_id = p.id
      WHERE p.employee_id = $1
        AND ($2::bigint IS NULL OR p.pay_run_id = $2)
      ORDER BY p.id DESC
      LIMIT 20`, [me, runId])).rows.map((r) => ({
    payslip_id: Number(r.payslip_id),
    pay_run_id: Number(r.pay_run_id),
    acked: r.acked_at !== null,
    acked_at: r.acked_at,
    method: r.method,
  }));

  if (!seeAll) {
    return { view_scope: 'self', mine, progress: null, pending: [] };
  }

  // HR：按期给进度 + 未签名单（受行闸）
  const periodEnd = `(SELECT (to_date(r.period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
                        FROM pay_run r WHERE r.id = $1)`;
  const progress = (await tx.query(
    `SELECT count(*)::int AS slips,
            count(a.id)::int AS acked,
            (count(*) - count(a.id))::int AS pending,
            round(100.0 * count(a.id) / NULLIF(count(*),0), 1) AS ack_rate
       FROM payslip p
       LEFT JOIN v_payslip_ack_effective a ON a.payslip_id = p.id
      WHERE p.pay_run_id = $1
        AND p.employee_id IN (SELECT employee_id FROM fn_scope_people(${periodEnd}))`,
    [runId])).rows[0];

  const pending = (await tx.query(
    `SELECT p.id AS payslip_id, p.employee_id, pe.full_name
       FROM payslip p
       LEFT JOIN v_payslip_ack_effective a ON a.payslip_id = p.id
       LEFT JOIN person pe ON pe.id = p.employee_id
      WHERE p.pay_run_id = $1 AND a.id IS NULL
        AND p.employee_id IN (SELECT employee_id FROM fn_scope_people(${periodEnd}))
      ORDER BY p.employee_id
      LIMIT 50`, [runId])).rows.map((r) => ({
    payslip_id: Number(r.payslip_id),
    employee_id: Number(r.employee_id),
    name: r.full_name,
  }));

  return {
    view_scope: 'all',
    mine,
    progress: progress ? {
      slips: Number(progress.slips),
      acked: Number(progress.acked),
      pending: Number(progress.pending),
      ack_rate: progress.ack_rate === null ? null : Number(progress.ack_rate),
    } : null,
    pending,
  };
}
