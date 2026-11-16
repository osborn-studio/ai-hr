// ============================================================================
// app/services/perf-metric.mjs · 绩效指标：指标库 / 考核项 / 逐项得分 / 汇总
// ----------------------------------------------------------------------------
// 这一层只做四件事：列、写、录分、汇总。**折分、加权、封顶一律在库里**——
// 界面要能预览"营业额 95% 得 95 分"，但如果前端自己也算一遍，页面上的
// 分数与 perf_result_item.score 迟早会不一样，而那时候没人分得清哪个是对的。
//
// 三个必须由库回答的问题，所以这里只转发：
//   ① 权重合计是不是 1（fn_perf_item_set 存的时候校验，不等汇总才发现）
//   ② 单项得分有没有越过上下限、超限有没有写说明（fn_perf_item_score）
//   ③ 总分怎么算出来、档位怎么跟着变（fn_perf_total → fn_perf_score）
//
// 资源码统一用 perf_cycle：指标与考核项是"方案的组成部分"，
// 另开 perf_metric 会让"能看周期但不能看方案"这种组合在库里不存在，
// 而实际客户就是要这么配（店长看得到自己的分，改不了口径）。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'perf_cycle', write: 'perf_cycle' };

const isPosInt = (n) => Number.isInteger(n) && n > 0;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/** 指标库（含四类与方向的中文名 —— 枚举只写这一处） */
export async function metrics(tx, { userId, onlyActive = true }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const rows = (await tx.query(
    `SELECT id, code, name, kind, unit, direction, score_min, score_max, note, is_active
       FROM perf_metric
      WHERE ($1::boolean IS NOT TRUE) OR is_active
      ORDER BY kind, code`, [onlyActive])).rows;
  return {
    rows: rows.map((r) => ({
      ...r,
      score_min: Number(r.score_min),
      score_max: Number(r.score_max),
    })),
    // 库里的 kind/direction 是机器码，界面需要的是这四个字
    kinds: { quant: '量化', behavior: '行为价值观', bonus: '加分项', penalty: '扣分项' },
    directions: { up: '越大越好', down: '越小越好' },
  };
}

/**
 * 某个方案的考核项 + 体检结果。
 * ★ 体检一起返回：只列"营业额 0.4 / 客诉 0.2"，读者不会发现合计只有 0.95。
 */
export async function items(tx, { userId, schemeId }) {
  if (!isPosInt(schemeId)) throw bizErr('E_ARG_INVALID', 'scheme 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });

  const scheme = (await tx.query(
    `SELECT id, version, name, effective_from, agg_rule FROM perf_scheme WHERE id = $1`,
    [schemeId])).rows[0];
  if (!scheme) throw bizErr('E_PERF_NO_SCHEME', `绩效方案 ${schemeId} 不存在`);

  const rows = (await tx.query(
    `SELECT i.id, i.scheme_id, i.metric_id, m.code AS metric_code, m.name AS metric_name,
            m.kind, m.unit, m.direction, m.score_min, m.score_max,
            i.weight, i.target_value, i.formula, i.seq
       FROM perf_item i JOIN perf_metric m ON m.id = i.metric_id
      WHERE i.scheme_id = $1 ORDER BY i.seq, i.id`, [schemeId])).rows;

  const problems = (await tx.query(
    `SELECT metric_code, problem FROM fn_perf_item_check($1)`, [schemeId])).rows;

  return {
    scheme,
    rows: rows.map((r) => ({
      ...r,
      weight: Number(r.weight),
      target_value: r.target_value === null ? null : Number(r.target_value),
      score_min: Number(r.score_min),
      score_max: Number(r.score_max),
    })),
    weight_sum: rows.reduce((s, r) => s + Number(r.weight), 0),
    problems,
    aggRules: { weighted: '加权求和', sum: '算术求和', avg: '算术平均' },
  };
}

/** 整方案覆盖式写入（先删后插，同一事务）；权重和 ≠ 1 由库里拒 */
export async function setItems(tx, { userId, schemeId, items: list }) {
  if (!isPosInt(schemeId)) throw bizErr('E_ARG_INVALID', 'scheme 必须是正整数');
  if (!Array.isArray(list) || list.length === 0) {
    throw bizErr('E_PERF_ITEM_EMPTY', '考核项至少要有一项（权重和 0 永远不等于 1）');
  }
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  // 只做形状校验，口径判断留给库：这里多拦一道就多一套会漂的规则
  const clean = list.map((it, i) => {
    if (!it || typeof it !== 'object') throw bizErr('E_PERF_ITEM_ARG', `第 ${i + 1} 项不是对象`);
    if (!isPosInt(Number(it.metric_id)) && !it.metric_code) {
      throw bizErr('E_PERF_ITEM_ARG', `第 ${i + 1} 项需要 metric_id 或 metric_code`);
    }
    if (num(it.weight) === null || !Number.isFinite(num(it.weight))) {
      throw bizErr('E_PERF_ITEM_ARG', `第 ${i + 1} 项需要数字 weight`);
    }
    return {
      metric_id: isPosInt(Number(it.metric_id)) ? Number(it.metric_id) : undefined,
      metric_code: it.metric_code || undefined,
      weight: num(it.weight),
      target_value: num(it.target_value),
      formula: it.formula ? String(it.formula) : null,
      seq: Number.isInteger(Number(it.seq)) ? Number(it.seq) : i + 1,
    };
  });

  const n = (await tx.query('SELECT fn_perf_item_set($1,$2::jsonb,$3) n',
    [schemeId, JSON.stringify(clean), String(userId)])).rows[0].n;

  return {
    scheme_id: schemeId,
    count: Number(n),
    weight_sum: clean.reduce((s, it) => s + it.weight, 0),
  };
}

/**
 * 录一项实际值 → 库里折成该项得分。
 * 返回 score 是**库里算的**，不是这里算的；超限被拒时，note 决定它是
 * "特批通过"还是 E_PERF_SCORE_RANGE。
 */
export async function scoreItem(tx, { userId, resultId, itemId, actual, note }) {
  if (!isPosInt(resultId)) throw bizErr('E_ARG_INVALID', 'result 必须是正整数');
  if (!isPosInt(itemId)) throw bizErr('E_ARG_INVALID', 'item 必须是正整数');
  if (num(actual) === null || !Number.isFinite(num(actual))) {
    throw bizErr('E_PERF_NO_ACTUAL', 'actual 必须是数字（公式项也要给 ACTUAL）');
  }
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  const score = (await tx.query(
    'SELECT fn_perf_item_score($1,$2,$3,$4) s',
    [resultId, itemId, num(actual), note ?? null])).rows[0].s;

  return {
    result_id: resultId,
    item_id: itemId,
    actual_value: num(actual),
    score: Number(score),
    // 超限特批会在库里留 note；这里回一个标记，界面能把它标黄
    approved_over: Boolean(note && String(note).trim().length >= 4),
  };
}

/**
 * 汇总并回写总分（档位跟着重算）。
 * ★ 缺项按 0 计但不静默：调用方拿到 missing 清单，界面必须能说出"还差客诉"。
 */
export async function total(tx, { userId, resultId }) {
  if (!isPosInt(resultId)) throw bizErr('E_ARG_INVALID', 'result 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  const totalScore = Number((await tx.query(
    'SELECT fn_perf_total($1,$2) t', [resultId, String(userId)])).rows[0].t);

  const row = (await tx.query(
    `SELECT r.id, r.cycle_id, r.employee_id, r.score, r.grade, r.note,
            (SELECT g.factor FROM perf_grade g
              JOIN perf_cycle c ON c.id = r.cycle_id
              JOIN perf_scheme s ON s.id = fn_perf_scheme_asof(c.period_to)
             WHERE g.scheme_id = s.id AND g.grade = r.grade) AS factor_preview
       FROM perf_result r WHERE r.id = $1`, [resultId])).rows[0];

  // 缺项清单与库里告警同源（同一套 join 条件），不另写一份判断
  const missing = (await tx.query(
    `SELECT m.code FROM perf_item i
       JOIN perf_metric m ON m.id = i.metric_id
       JOIN perf_result r ON r.id = $1
       JOIN perf_cycle  c ON c.id = r.cycle_id
      WHERE i.scheme_id = fn_perf_scheme_asof(c.period_to)
        AND NOT EXISTS (SELECT 1 FROM perf_result_item ri
                         WHERE ri.result_id = r.id AND ri.item_id = i.id)
      ORDER BY i.seq, i.id`, [resultId])).rows.map((x) => x.code);

  return {
    result_id: resultId,
    employee_id: row.employee_id,
    total: totalScore,
    score: Number(row.score),        // 库里回写的值，应当等于 total
    grade: row.grade,
    // 和 fn_perf_score 一样：factor 只是预告，封存时才固化
    factor_preview: row.factor_preview === null ? null : Number(row.factor_preview),
    missing,
  };
}

/** 方案体检：权重和 / 缺目标 / 公式算不出来 —— 一次列全 */
export async function check(tx, { userId, schemeId }) {
  if (!isPosInt(schemeId)) throw bizErr('E_ARG_INVALID', 'scheme 必须是正整数');
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const rows = (await tx.query(
    'SELECT metric_code, problem FROM fn_perf_item_check($1)', [schemeId])).rows;
  return { scheme_id: schemeId, ok: rows.length === 0, rows };
}
