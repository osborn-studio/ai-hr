// ============================================================================
// app/services/payslip-ack-revoke.mjs · 工资条签收的撤回（187）
// ----------------------------------------------------------------------------
// 与 `payslip-ack.mjs`（186）是同一件事的两个方向，但**不能合并**：
//   · 签收是员工动作，身份从会话推出来（employee_id 不许当参数传）；
//   · 撤回是 HR 动作，对象是**某一张单的回执**，且必须写清"为什么"。
//   两条信任路径不同（一个"我是谁"，一个"我凭什么动别人的单"），
//   混成一个函数，迟早会把"本人签"写成"谁能传参数谁就能签"。
//
// ★★ 为什么是 INSERT 而不是 UPDATE ★★
//   186 的表是 append-only，而且那个触发器**不该被为撤回放开**：
//   UPDATE 掉一条回执，等于"这个员工从来没签过"——
//   可事实是他签过（可能还发了纸质件、还在群里确认过）。
//   撤回要增加一个事实（谁在什么时候因为什么撤的），不是抹掉一个事实。
//   于是：
//     · `payslip_ack` 那行永远在（时间、方式、经办人都查得到）；
//     · `payslip_ack_revoke` 那行回答"它后来为什么不算数了"；
//     · "有效签收"是派生的：有回执且没有撤销记录（v_payslip_ack_effective）。
//
// ★ 三条判据都在这一个文件里（路由不重复实现）：
//   ① 理由 ≥ 4 个字 —— 撤回是合规动作，"撤了但没写为什么"这件事本身不可解释；
//   ② 需要 payroll_run **写**权限 —— 与代录纸质回执（186 的 ackOnBehalf）
//      同一档权限：都是"替员工改发薪闭环上的事实"，不该由只读角色做；
//   ③ 只能撤**已存在且没撤过**的回执 —— 分别给 E_ACK_NOT_FOUND(404) 与
//      E_ACK_ALREADY_REVOKED(409)：前者是"单号错了"，后者是"状态变了"，
//      下一步动作完全不同（去对单 vs 去看撤销记录）。
//
// ★ 我另加了第 ④ 条行闸（规格里没写，报告里也列了）：
//   `slip 的 employee_id` 必须落在 `fn_scope_people(该批次期末日)` 里。
//   理由：payroll_run 写权限是**岗位层**的，它不区分门店。legacy_store_hr 这类
//   角色对整库都有 payroll_run 写权限，少了这一条，A 店 HR 可以撤掉 B 店员工的签收，
//   而这是"替别的门店改发薪事实"——比看错一行严重得多。
//   为什么用 fn_scope_people 而不是自己写 EXISTS：170:61-64 定了它是行闸的唯一表达式；
//   两份口径必然漂，而漂的那天没有人报错。
//   ★ 已知边界（如实写）：行闸按**该批次期末日**的 cost_org 归属判，
//     于是"期末日已离职（当天无归属）"的员工的回执，门店 HR 撤不了 ——
//     只有能看到集团根的人（集团 HR）能撤。要放宽就该先讨论
//     "离职员工的发薪事实归谁管"，而不是在这里偷偷改成按今天判。
// ============================================================================
import { requireSession, prepareRead } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { manage: 'payroll_run', read: 'payroll_run' };

const isBig = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const MIN_REASON = 4;

/** 一条回执 → 它所属批次的期末日（行闸要用同一时点，不能按今天判）。 */
const PERIOD_END = `(SELECT (to_date(r.period || '-01','YYYY-MM-DD')
                             + interval '1 month - 1 day')::date
                       FROM pay_run r WHERE r.id = a.pay_run_id)`;

/**
 * 撤回一条签收回执。
 *
 * @param slipId 工资条 id（payslip.id）。★ 用 slip 而不是 ack_id：
 *               前端手上是"这张工资条"，而 ack_id 是内部行号 ——
 *               让调用方去猜内部行号，猜错的表现是"撤了别人的回执"。
 * @param reason 撤回理由（≥ 4 个字，去首尾空白后判）
 * @returns { revoke_id, payslip_id, pay_run_id, acked_at, revoked_at, reason }
 */
export async function revoke(tx, { userId, slipId, reason }) {
  if (!isBig(slipId)) throw bizErr('E_ARG_INVALID', 'slip 必须是正整数');
  const why = String(reason ?? '').trim();
  if (why.length < MIN_REASON) {
    // 与 186 的 ck_ackrv_reason（length(btrim(reason)) >= 4）同一条规。
    // 服务层先判不是为了"更严格"，是为了让失败**有名字**：
    // 落到 23514 只会回一句 CHECK_VIOLATION，而前端要说的是"把理由写清楚"。
    throw bizErr('E_ACK_REASON', `撤回理由至少 ${MIN_REASON} 个字（撤回要说明为什么，不能只点一下）`);
  }

  // ② 岗位层：payroll_run 写（与代录纸质回执同一档）
  await requireSession(tx, { userId, resource: RESOURCES.manage, action: 'write' });

  const ack = (await tx.query(
    `SELECT a.id, a.payslip_id, a.pay_run_id, a.employee_id, a.acked_at, a.method,
            ${PERIOD_END} AS period_end
       FROM payslip_ack a
      WHERE a.payslip_id = $1`, [slipId])).rows[0];
  if (!ack) {
    // 404 而不是 409：这张单没有回执，是"你撤的东西不存在"，不是"状态冲突"。
    throw bizErr('E_ACK_NOT_FOUND',
      `工资条 ${slipId} 没有签收回执 —— 没签过的单没有可撤的东西（单号或工资条选错了？）`);
  }

  // ④ 行闸：这条回执属于的人，必须在"我看得到的人"里。
  //   ★ fail-closed：fn_scope_people 在没有范围时返回 0 行（170:63）。
  const inScope = (await tx.query(
    `SELECT 1 FROM fn_scope_people($1::date) WHERE employee_id = $2 LIMIT 1`,
    [ack.period_end, ack.employee_id])).rows.length > 0;
  if (!inScope) {
    throw bizErr('E_OUT_OF_SCOPE',
      `这张工资条的人不在你的数据范围内（按批次期末 ${ack.period_end || '（批次已不存在）'} 判）`);
  }

  // ③ 已撤过 → 409。先查一次是为了给出**准确**的错（而不是靠唯一冲突猜），
  //   但真正的闸仍是 uk_ackrv_ack：并发下两个请求都会走到 INSERT，
  //   第二个被 ON CONFLICT 吃掉并得到同一个 409。
  const old = (await tx.query(
    `SELECT id, at FROM payslip_ack_revoke WHERE ack_id = $1`, [ack.id])).rows[0];
  if (old) {
    throw bizErr('E_ACK_ALREADY_REVOKED',
      `这条签收已经撤回过（${new Date(old.at).toISOString()}）—— 一条回执只能撤一次，`
      + '要改理由请走更正流程，不是再撤一次');
  }

  const ins = (await tx.query(
    `INSERT INTO payslip_ack_revoke(ack_id, revoked_by, reason)
     VALUES ($1,$2,$3)
     ON CONFLICT (ack_id) DO NOTHING
     RETURNING id, at`, [ack.id, userId, why])).rows[0];
  if (!ins) {
    // 并发：另一条请求刚撤完。同一个 409，措辞不再带时间（这里拿不到对方的）。
    throw bizErr('E_ACK_ALREADY_REVOKED',
      '这条签收刚刚被撤回（并发请求）—— 一条回执只能撤一次');
  }

  return {
    revoke_id: Number(ins.id),
    payslip_id: Number(ack.payslip_id),
    pay_run_id: Number(ack.pay_run_id),
    acked_at: ack.acked_at,       // 原回执的时间仍在 —— 撤回不改变"他签过"
    method: ack.method,
    revoked_at: ins.at,
    reason: why,
  };
}

/**
 * 撤回记录（给 HR 看）。
 * ★ 为什么不只给一个计数：撤回是少数事件，但要回答的问题有两个 ——
 *   "这一期撤了几条"（数）与"每条为什么撤、谁撤的"（明细）。
 *   只给数，下一次有人问"为什么 8 月签收率掉了"就得再写一条 SQL。
 *
 * @param runId 批次。省略时给最近的记录（按今天的归属判范围）——
 *              ★ 这个分支会挡掉"期末日已离职"的人的记录，与 revoke 的边界相同。
 */
export async function listRevokes(tx, { userId, runId = null }) {
  if (runId !== null && runId !== undefined && !isBig(runId)) {
    throw bizErr('E_ARG_INVALID', 'run 必须是正整数');
  }
  await prepareRead(tx, { userId, resource: RESOURCES.read });

  // 判定日：给了批次就按该批次期末（与 revoke / 进度视图同一时点），
  // 否则按今天。★ 两个分支的日期口径都写出来 —— 不写的话，
  // "为什么这一条昨天还在、今天不见了"永远查不出是行闸还是数据没了。
  const asOf = runId
    ? `(SELECT (to_date(r.period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
          FROM pay_run r WHERE r.id = $1::bigint)`
    : 'app_today()';

  const rows = (await tx.query(
    `SELECT rv.id AS revoke_id, rv.reason, rv.at AS revoked_at,
            rv.revoked_by,
            -- LEFT JOIN + 兜底文案（与 139 的会签列表同法）：迁移直接建出来的库
            -- 没有账号档案（139:58-60），此时名字为空会让"谁撤的"整列看不见，
            -- 而人以为"没人撤过"。号码至少能让人去查。
            COALESCE(NULLIF(btrim(ru.display_name), ''), '账号 ' || rv.revoked_by) AS revoked_by_name,
            a.payslip_id, a.pay_run_id, a.employee_id, a.acked_at, a.method,
            pe.full_name AS employee_name
       FROM payslip_ack_revoke rv
       JOIN payslip_ack a ON a.id = rv.ack_id
       LEFT JOIN person pe ON pe.id = a.employee_id
       LEFT JOIN sys_account ru ON ru.id = rv.revoked_by
      WHERE ($1::bigint IS NULL OR a.pay_run_id = $1::bigint)
        AND a.employee_id IN (SELECT employee_id FROM fn_scope_people(${asOf}))
      ORDER BY rv.at DESC, rv.id DESC
      LIMIT 200`, [runId ?? null])).rows;

  return {
    run_id: runId === null || runId === undefined ? null : Number(runId),
    count: rows.length,
    rows: rows.map((r) => ({
      revoke_id: Number(r.revoke_id),
      payslip_id: Number(r.payslip_id),
      pay_run_id: Number(r.pay_run_id),
      employee_id: Number(r.employee_id),
      employee_name: r.employee_name,
      method: r.method,
      acked_at: r.acked_at,
      revoked_at: r.revoked_at,
      revoked_by: Number(r.revoked_by),
      revoked_by_name: r.revoked_by_name,
      reason: r.reason,
    })),
  };
}
