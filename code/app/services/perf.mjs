// ============================================================================
// app/services/perf.mjs · 绩效：周期 / 结果 / 封存
// ----------------------------------------------------------------------------
// 封存是"把会变的数固定下来"的唯一动作，也是算薪的前置门。
// 它原来是直接 db.query —— 没有事务、没有留痕、失败只回 409 带原始 message。
//
// 这里补的是三件事，都很小，但都影响"事后能不能复盘"：
//   ① 一个事务：封存中途失败不会留下一半已固化的系数
//   ② 业务码映射：已封存 / 无方案 / 档位缺失 各自是不同的事
//   ③ 留痕在事务外（见 server 的 logReq）
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { cycle: 'perf_cycle' };

export async function view(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.cycle });
  // ★ 行闸（170）：绩效结果也是"人"的数据，同样要按花名册口径收口。
  //   周期清单（cycles）是全集团的，不过滤 —— 它不含个人信息。
  await tx.query('SELECT app_begin_scope($1,$2,$3)',
    [userId, 'employee_roster', null]);
  const cycles = (await tx.query(
    `SELECT c.*,
            (SELECT count(*)::int FROM perf_result r WHERE r.cycle_id = c.id) AS rows,
            (SELECT count(*)::int FROM perf_result r WHERE r.cycle_id = c.id AND r.state = 'scored') AS scored
       FROM perf_cycle c ORDER BY c.id`)).rows;
  // ★ 每个周期带一份"还差谁"：只看 perf_result 的界面永远答不出封存卡在哪。
  const pend = (await tx.query(
    `SELECT cycle_id,
            count(*) FILTER (WHERE bucket = 'missing')::int  AS missing,
            count(*) FILTER (WHERE bucket = 'scored')::int   AS scored,
            count(*) FILTER (WHERE bucket = 'excluded')::int AS excluded
       FROM v_perf_pending GROUP BY cycle_id`)).rows;
  const results = (await tx.query(
    `SELECT r.*, p.full_name FROM perf_result r
       LEFT JOIN person p ON p.id = r.employee_id
      WHERE r.employee_id IN (SELECT employee_id FROM fn_scope_people())
      ORDER BY r.cycle_id, r.employee_id`)).rows;
  return { cycles, results, pending: pend };
}

/** 封存：把评分固化成系数。已封存的周期不可再封、不可解封、结果不可改。 */
export async function seal(tx, { userId, cycleId }) {
  if (!Number.isInteger(cycleId) || cycleId <= 0) throw bizErr('E_ARG_INVALID', 'cycle 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.cycle });
  const n = (await tx.query('SELECT fn_perf_seal($1,$2) n', [cycleId, String(userId)])).rows[0].n;
  return { sealed: true, cycle: cycleId, factors_fixed: Number(n) };
}

export async function distribution(tx, { userId, cycleId }) {
  // ★ 这条原来没有 requireSession：同一份「每档多少人」在 /api/perf/dist（158）
  //   要鉴权，在 /api/perf/distribution（旧）却谁都能拉。两个入口读同一张表，
  //   权限面却不一样 —— 那种洞不会报错，只会在某次外部审计里被翻出来。
  //   绩效分布是"谁在什么档"的聚合，本身就属于绩效周期的读权限。
  if (!Number.isInteger(cycleId) || cycleId <= 0) {
    throw bizErr('E_ARG_INVALID', 'cycle 必须是正整数');
  }
  await requireSession(tx, { userId, resource: RESOURCES.cycle });
  return (await tx.query('SELECT * FROM fn_perf_distribution($1)', [cycleId])).rows;
}

/**
 * 打分：分数进来，档位出去，系数**不写**。
 * ★ 系数只在 seal 里固化。这里回传的 factor 是"预告"，用于界面提示 ——
 *   写进去就等于"系数在分数之前就定了"，而那正是封存这件事要防的。
 */
export async function score(tx, { userId, cycleId, employeeId, scoreValue, note }) {
  if (!Number.isInteger(cycleId) || cycleId <= 0) throw bizErr('E_ARG_INVALID', 'cycle 必须是正整数');
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数');
  if (scoreValue === null || scoreValue === undefined || scoreValue === ''
      || !Number.isFinite(Number(scoreValue))) {
    throw bizErr('E_ARG_INVALID', 'score 必须是数字');
  }
  await requireSession(tx, { userId, resource: RESOURCES.cycle });

  const r = (await tx.query('SELECT * FROM fn_perf_score($1,$2,$3,$4,$5)',
    [cycleId, employeeId, Number(scoreValue), note ?? null, String(userId)])).rows[0];
  return {
    cycle_id: cycleId, employee_id: employeeId,
    score: Number(scoreValue), grade: r.grade,
    // 预告：封存后会按这个系数发钱；现在库里还没有它
    factor_preview: Number(r.factor),
  };
}

/** 排除：不参与考核，必须写原因 */
export async function exclude(tx, { userId, cycleId, employeeId, note }) {
  if (!Number.isInteger(cycleId) || cycleId <= 0) throw bizErr('E_ARG_INVALID', 'cycle 必须是正整数');
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.cycle });
  await tx.query('SELECT fn_perf_exclude($1,$2,$3,$4)',
    [cycleId, employeeId, note ?? '', String(userId)]);
  return { cycle_id: cycleId, employee_id: employeeId, state: 'excluded' };
}

/** 待评名单：封存前要能回答"还差谁" */
export async function pending(tx, { userId, cycleId }) {
  await requireSession(tx, { userId, resource: RESOURCES.cycle });
  return (await tx.query(
    `SELECT employee_id, full_name, state, bucket
       FROM v_perf_pending WHERE cycle_id = $1
      ORDER BY CASE bucket WHEN 'missing' THEN 0 WHEN 'scored' THEN 1 ELSE 2 END, employee_id`,
    [cycleId])).rows;
}
