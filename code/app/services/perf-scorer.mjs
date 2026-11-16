// ============================================================================
// app/services/perf-scorer.mjs · 绩效结果：评分人 / 改分史 / 强制分布（158）
// ----------------------------------------------------------------------------
// 三个读动作，都很薄：
//   results       某一期的结果 —— 每行带"谁打的、什么时候打的、改过几次"
//   history       一个人的改分史 —— 按版本倒序，最新一版在上
//   distribution  强制分布 —— 每档都出行，0 人档也出
//
// ★ 口径一律在库里（fn_perf_result_of / fn_perf_history / fn_perf_distribution）：
//   · scored_by_name 怎么取（账号名 → 回落 id 原文）；
//   · changed_count 怎么数（台账行数，独立于 version，两条来源互为对照）；
//   · 0 人档怎么补（从 perf_grade 出发，不是从结果表出发）。
//   在 JS 里再补一遍，就会有第二个来源 —— 而它分叉时不会有任何信号。
//
// ★ 这一层**没有任何写动作**，也没有留痕逻辑：改分台账是库里的触发器写的
//   （trg_pr_log）。服务层写台账意味着"绕过服务层就没有台账"，
//   而绩效分恰恰是最想被绕过的那一类数。
//
// ★ RESOURCES 的 read / write 是同一个资源码（perf_cycle）：
//   看结果与打分/封存是同一件事的两面，在这里另立一个资源会让
//   "能打分但不能看结果"这种组合凭空出现。本文件只用到 read，
//   write 留在这里是为了让下一个往本模块加写动作的人不必再造一个资源码。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'perf_cycle', write: 'perf_cycle' };

const isId = (v) => Number.isInteger(v) && v > 0;

/** pg 以字符串回 numeric；null 必须原样保留（它是"没有分母"/"未记录"，不是 0） */
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** 两个动作共用的参数形状 + 读闸（形状过了才进库） */
async function gate(tx, userId, cycleId) {
  if (!isId(cycleId)) throw bizErr('E_ARG_INVALID', 'cycle 必须是正整数（perf_cycle.id）');
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
}

/**
 * 某一期的结果：谁打的、什么时候打的、改过几次。
 *
 * kpi.unsigned 是"有分但没有评分人"的行数 —— 它们只可能来自存量
 * （026 时代与种子直接 INSERT 的那些行）。这个数不是零就意味着
 * "这一期有一部分分说不清是谁评的"，而这正是本文件要让它可见的东西：
 * 编一个名字把它做成 0 才是更坏的选择。
 */
export async function results(tx, { userId, cycleId }) {
  await gate(tx, userId, cycleId);

  const rows = (await tx.query(
    'SELECT * FROM fn_perf_result_of($1::bigint)', [cycleId])).rows.map((r) => ({
    employee_id: Number(r.employee_id),
    full_name: r.full_name,
    state: r.state,
    score: num(r.score),
    grade: r.grade,
    note: r.note,
    scored_by: r.scored_by,
    // 名字取不到时库里已回 id 原文；两者都为空才是真的没记录
    scored_by_name: r.scored_by_name,
    scored_at: r.scored_at,
    version: Number(r.version),
    changed_count: Number(r.changed_count),
  }));

  const scored = rows.filter((r) => r.state === 'scored');
  return {
    cycle_id: cycleId,
    rows,
    kpi: {
      people: rows.length,
      scored: scored.length,
      excluded: rows.filter((r) => r.state === 'excluded').length,
      // 有分但没签字：存量行。显示出来，不抹平。
      unsigned: scored.filter((r) => !r.scored_by).length,
      // 被改过的行数（改了几次看每行的 changed_count）
      changed: rows.filter((r) => r.changed_count > 0).length,
    },
  };
}

/**
 * 一个人的改分史。
 *
 * new_score 为 NULL 的那一条是"被排除"（88 → NULL），与"改成分数"（88 → 92）
 * 在同一个列表里，看 new_score 是 NULL 还是数字就能分开 ——
 * 这是"排除也是一种判断"的可查面。
 */
export async function history(tx, { userId, cycleId, employeeId }) {
  await gate(tx, userId, cycleId);
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');

  const rows = (await tx.query(
    'SELECT * FROM fn_perf_history($1::bigint,$2::bigint)', [cycleId, employeeId])).rows
    .map((r) => ({
      version: Number(r.version),
      old_score: num(r.old_score),
      new_score: num(r.new_score),
      note: r.note,
      changed_by_name: r.changed_by_name,
      changed_at: r.changed_at,
    }));

  return { cycle_id: cycleId, employee_id: employeeId, rows, changes: rows.length };
}

/**
 * 强制分布：每档都出行。
 *
 * kpi.zero 是"这一档一个人都没有"的档数 —— 与"方案里没有这一档"是两件事：
 * 前者要有人去谈（执行没到位），后者不用管（方案没配）。
 * 合并成一个"3 行"的报表，这两件事就再也分不开了。
 */
export async function distribution(tx, { userId, cycleId }) {
  await gate(tx, userId, cycleId);

  const rows = (await tx.query(
    'SELECT * FROM fn_perf_distribution($1::bigint)', [cycleId])).rows.map((r) => ({
    grade: r.grade,
    n: Number(r.n),
    pct: num(r.pct),
    // null = 这一档不参与强制分布（方案里没配占比），不是"目标 0%"
    target_pct: num(r.target_pct),
    over_by: num(r.over_by),
  }));

  return {
    cycle_id: cycleId,
    rows,
    kpi: {
      // 各档人数之和 = 已评人数；与 results 的 scored 对不上就说明口径分叉了
      total: rows.reduce((a, r) => a + r.n, 0),
      grades: rows.length,
      zero: rows.filter((r) => r.n === 0).length,
      over: rows.filter((r) => r.over_by !== null && r.over_by > 0).length,
    },
  };
}
