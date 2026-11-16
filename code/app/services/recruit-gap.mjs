// ============================================================================
// app/services/recruit-gap.mjs · 缺岗 → 招聘需求（188）
// ----------------------------------------------------------------------------
// 这一层刻意做得很薄，薄到只有四件事，而每一件都是"库管不了"的：
//   ① 参数形状（门店是不是正整数、期间是不是 YYYY-MM）；
//   ② 岗位层 + 行闸：招聘需求的写权限 + 这家门店在不在我的范围里
//      （与 recruit.mjs 的 openRequisition 同一套 —— 同一条业务两种入口，
//       两套判据必然漂，而漂的那天没人报错）；
//   ③ 操作人（created_by / 库里的 p_by）：从会话取，不从参数取；
//   ④ 把库函数的逐行结果收成"开了几条 / 跳过几条 / 各自原因"。
//
// ★ 缺岗口径与生成规则全在库里（fn_hc_gap_to_requisition）。这里**不复算**
//   "缺几个"：
//     档口编 − 到岗 这个式子一旦在 JS 里再写一遍，两个数迟早不一样，
//     而现场看到的是"页面说缺 3 个，点一键开需求只开了 2 个" ——
//     没有任何一处会报错。172/188 都把式子留在库里，就是为了只留一份。
//
// ★ 为什么不是"点一次就把所有缺口都开完"（p_period 必传）：
//   缺岗是**按月**的（档口编是月粒度），不写期间就等于用"今天"去猜，
//   于是同一批缺口在不同日子点，开出的单不一样。期间必须是调用方说的。
// ============================================================================
import { requireOrg } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { write: 'requisition' };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 按档口缺岗生成招聘需求（幂等）。
 *
 * @param storeId 门店（org_unit.id，叶子部门）
 * @param period  期间 YYYY-MM —— 缺岗按该期**期末日**判（与档口编同一个月粒度）
 * @returns {store_id, period, opened_count, skipped_count, opened[], skipped[]}
 *   opened 每条带 requisition_id；skipped 每条带 reason（库里那句拒绝原样带回）。
 */
export async function gapToRequisition(tx, { userId, storeId, period, by = null }) {
  if (!Number.isInteger(Number(storeId)) || Number(storeId) <= 0) {
    throw bizErr('E_ARG_INVALID', 'store 必须是正整数');
  }
  if (!PERIOD_RE.test(String(period || ''))) {
    throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM（缺岗按这个月的期末日判）');
  }

  // ② 岗位层（requisition 写）+ 行闸（cost_org 维度，与看考勤同一批门店）
  await requireOrg(tx, {
    userId, resource: RESOURCES.write, orgId: Number(storeId), dim: 'cost_org',
  });

  // ③ 操作人从会话取：p_by 会落到 requisition.created_by（审计用），
  //   能由参数决定的话，"这是谁开的"就只是调用方的一句自述。
  const actor = String(by || userId);

  const rows = (await tx.query(
    `SELECT store_station_id, station_code, station_name,
            position_id, position_name, need,
            requisition_id, state, reason
       FROM fn_hc_gap_to_requisition($1,$2,$3)`,
    [Number(storeId), String(period), actor])).rows;

  const brief = (r) => ({
    store_station_id: r.store_station_id === null ? null : Number(r.store_station_id),
    station_code: r.station_code,
    station_name: r.station_name,
    position_id: Number(r.position_id),
    position_name: r.position_name,
    need: Number(r.need),
  });
  const opened = rows.filter((r) => r.state === 'opened')
    .map((r) => ({ ...brief(r), requisition_id: Number(r.requisition_id) }));
  const skipped = rows.filter((r) => r.state !== 'opened')
    .map((r) => ({ ...brief(r), reason: r.reason }));

  return {
    store_id: Number(storeId),
    period: String(period),
    opened_count: opened.length,
    skipped_count: skipped.length,
    opened,
    skipped,
  };
}
