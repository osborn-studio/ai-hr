// ============================================================================
// app/services/report-trend.mjs · 多期趋势：把单期快照铺成一条线
// ----------------------------------------------------------------------------
// 这个文件刻意**很薄**，和 report.mjs 的 panel() 一样薄。所有口径都在 146 的
// fn_rpt_trend 里，而 fn_rpt_trend 自己也不重算 —— 它逐期调 fn_rpt_panel。
//
// 为什么服务层不在这里"顺手"算点什么（比如自己 reduce 出峰值、环比）：
//   一旦这里开始算数，"趋势图上的数"就有了第二个来源，而它与库里的那份
//   分叉时不会有人收到任何信号。这里只做三件事：
//
//     ① 参数形状（org 是正整数、两个期间是 YYYY-MM）；
//     ② 行闸（报表按成本组织汇总，与 panel 同一个维、同一条 requireOrg）；
//     ③ 把逐期行折成一个能直接画图的 kpi 摘要。
//
// ③ 里有一个口径决定必须写出来：**均值只算有数据的月份**。
//   把"这一期没算过"的 0 放进分母，等于把"没发工资"当成"发得少"，
//   而趋势图上那条均值线会被拖低到没人能解释的位置。
// ============================================================================
import { requireOrg } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { report: 'report' };
const RES = RESOURCES.report;

const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/**
 * 期间形状。
 * ★ 必须在进入 SQL 之前挡住：`2026-3` 会被拼成 `2026-3-01`，而 PG 能把它
 *   解析成 3 月 1 日 —— 于是"写错"与"写对"在结果上同形，差别只在别人怎么看。
 *   起止顺序与跨度上限**不在这里判**，交给 fn_rpt_trend：
 *   那条规则是报表口径的一部分，判在服务层会让"接口受限、SQL 不受限"，
 *   于是下一个人从别处调这个函数时，限制就消失了。
 */
function assertPeriod(period, name) {
  if (!PERIOD.test(String(period || ''))) {
    throw bizErr('E_ARG_INVALID', `${name} 必须是 YYYY-MM（如 2026-03）`);
  }
}

/** 逐月趋势 + 环比。返回 { org_id, from, to, rows, kpi } */
export async function trend(tx, { userId, orgId, from, to }) {
  if (!Number.isInteger(orgId) || orgId <= 0) throw bizErr('E_ARG_INVALID', 'org 必须是正整数');
  assertPeriod(from, 'from');
  assertPeriod(to, 'to');

  // 报表按成本组织口径汇总（人数 / 工时 / 薪酬都归到组织上），维度与 panel() 一致。
  // ★ 少了这一句，任何登录账号换个 org 参数就能读别的店一整年的工资曲线 ——
  //   比读单期更糟：一条曲线能看出规模、季节性、以及有没有裁过员。
  await requireOrg(tx, { userId, resource: RES, orgId, dim: 'cost_org' });

  const rows = (await tx.query(
    'SELECT * FROM fn_rpt_trend($1,$2,$3)', [orgId, from, to])).rows;

  // 只有"真的算过"的月份参与均值与峰谷。
  const live = rows.filter((r) => r.has_data === true);
  const closed = (v) => Math.round(Number(v) * 100) / 100;

  const kpi = {
    // months 是**区间内的月份数**（含没有数据的月份）：
    // 它是"这条线应该有几个点"，不是"有几个有效点"。两者混用，
    // 图上缺的那一段就永远查不出来。
    months: rows.length,
    months_with_data: live.length,
    avg_gross: live.length ? closed(live.reduce((a, r) => a + Number(r.gross), 0) / live.length) : null,
    peak: live.length
      ? { period: live.reduce((a, r) => (Number(r.gross) > Number(a.gross) ? r : a)).period,
          gross: closed(Math.max(...live.map((r) => Number(r.gross)))) }
      : null,
    trough: live.length
      ? { period: live.reduce((a, r) => (Number(r.gross) < Number(a.gross) ? r : a)).period,
          gross: closed(Math.min(...live.map((r) => Number(r.gross)))) }
      : null,
  };

  return { org_id: orgId, from, to, rows, kpi };
}
