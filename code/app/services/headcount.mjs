// ============================================================================
// app/services/headcount.mjs · 编制：下达 / 查看
// ----------------------------------------------------------------------------
// 「逐级下分」是集团管控的核心动作，它有一个非常容易做错的地方：
//
//   把它当成"给下级设一个数" → 上级的额度没有减少 → 集团 30 个编，
//   区域拿走 20、门店又从区域拿 20，三层各自账面自洽，总数 70。
//
// 库里 fn_hc_set 的判据是"**子项之和 ≤ 父项额度**"，且**只在 cascaded 模式下成立**
// （group_pool 模式下"分给下级"这件事本身不存在）。这条判据只有一个来源，
// 所以服务层这里不复制它，也不试图"先算一下再写"——先算一遍再写，
// 算的那一遍与写的那一遍之间就有窗口，而窗口正是并发下超分的成因。
// ============================================================================
import { requireOrg, prepareRead } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { view: 'headcount', set: 'headcount' };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 三个数同屏：额度 / 已下分 / 可招。只给一个数，读者无从判断"少"是少在哪。 */
export async function view(tx, { userId, period }) {
  if (!PERIOD_RE.test(String(period || ''))) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');
  await prepareRead(tx, { userId, resource: RESOURCES.view });

  const rows = (await tx.query(
    `SELECT o.id, o.name, o.parent_id, o.path,
            fn_hc_quota(o.id,$1)     AS quota,
            -- 183：额度是本期定的、沿用更早一期、还是从来没有过。
            -- ★ 三个数与这个状态必须同屏：只给额度，读者无法分辨"这月没定编"与"定了但数没变"。
            qe.status                AS quota_status,
            qe.carried_from          AS quota_carried_from,
            fn_hc_allocated(o.id,$1) AS allocated,
            fn_hc_available(o.id,$1) AS available,
            fn_hc_hireable(o.id,$1)  AS hireable,
            fn_hc_used(o.id,$1)      AS used
       FROM org_unit o,
            LATERAL fn_hc_quota_effective(o.id,$1) qe
      WHERE o.is_active ORDER BY o.path`, [period])).rows;

  const over = (await tx.query('SELECT * FROM fn_hc_over($1)', [period])).rows;
  const uncovered = (await tx.query('SELECT * FROM fn_hc_uncovered($1)', [period])).rows;
  const slack = (await tx.query('SELECT * FROM fn_hc_slack($1)', [period])).rows;
  return { period, rows, over, uncovered, slack };
}

/**
 * 下达/调整编制 = 追加一个版本（append-only）。
 * ★ 权限用 cost_org 维度：编制是挂在组织上的资源，谁能看这个组织就能给这个组织下编。
 */
export async function setBudget(tx, { userId, orgId, period, quota, reason }) {
  if (!Number.isInteger(orgId) || orgId <= 0) throw bizErr('E_ARG_INVALID', 'org 必须是正整数');
  if (!PERIOD_RE.test(String(period || ''))) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');
  if (!Number.isInteger(quota) || quota < 0) throw bizErr('E_ARG_INVALID', 'quota 必须是非负整数');
  if (!reason || String(reason).trim().length < 4)
    throw bizErr('E_ARG_INVALID', 'reason 至少 4 个字（调编必须说明原因）');

  await requireOrg(tx, { userId, resource: RESOURCES.set, orgId, dim: 'cost_org', action: 'write' });

  const ver = (await tx.query('SELECT fn_hc_set($1,$2,$3,$4,$5) v',
    [orgId, period, quota, String(userId), String(reason).trim()])).rows[0].v;

  const after = (await tx.query(
    `SELECT fn_hc_quota($1,$2) quota, fn_hc_allocated($1,$2) allocated,
            fn_hc_available($1,$2) available`, [orgId, period])).rows[0];

  return { org_id: orgId, period, version: Number(ver),
           quota: after.quota, allocated: after.allocated, available: after.available };
}
