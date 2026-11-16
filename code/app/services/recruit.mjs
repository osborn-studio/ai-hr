// ============================================================================
// app/services/recruit.mjs · 招聘：开需求 / 发 offer / 看板
// ----------------------------------------------------------------------------
// 这一块的写路径原来是**根本不存在**的：offer 只在种子数据里由 SQL 直接签发。
// 也就是说，"发一个 offer"这件事只有运维能做过，产品上没有任何入口。
//
// 补入口的时候有两件事不能做错：
//
//   ① 不能在服务层算名额。`还能发几个 offer` = 额度 − 已下分 − 已入职 − 已发 offer，
//      这个式子在 fn_hc_can_offer 里有一份。接口层再算一份，两份必然会不同步，
//      而不同步的那天，两份都"看起来对"。
//   ② 不能因为"offer 是 HR 发的"就跳过行闸。招聘的组织维度就是需求挂的那个门店，
//      用同一个 cost_org 维度判，与考勤列表看到的是同一批门店。
// ============================================================================
import { requireOrg, prepareRead } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { board: 'requisition', write: 'requisition' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 招聘看板：需求 / offer / 每个叶子组织还能发几个 */
export async function board(tx, { userId, asOf }) {
  if (!DATE_RE.test(String(asOf || ''))) throw bizErr('E_ARG_INVALID', 'as_of 必须是 YYYY-MM-DD');
  await prepareRead(tx, { userId, resource: RESOURCES.board });

  const requisitions = (await tx.query(
    `SELECT r.id, r.org_id, o.name AS org_name, r.position, r.headcount, r.status,
            r.opened_at, r.reason,
            (SELECT count(*)::int FROM offer f
              WHERE f.requisition_id = r.id AND f.status IN ('pending','accepted')) AS live_offers
       FROM requisition r JOIN org_unit o ON o.id = r.org_id
      ORDER BY r.id`)).rows;

  const offers = (await tx.query(
    `SELECT f.id, f.candidate_key, f.candidate_name, f.status, f.org_id,
            f.requisition_id,
            fn_offer_valid_until(f.id) AS valid_until,
            (SELECT monthly_amount FROM offer_version v
              WHERE v.offer_id = f.id ORDER BY version DESC LIMIT 1) AS amount,
            (SELECT count(*)::int FROM offer_version v WHERE v.offer_id = f.id) AS versions
       FROM offer f ORDER BY f.id`)).rows;

  const capacity = (await tx.query(
    `SELECT o.id, o.name,
            fn_hc_can_offer(o.id,$1::date) AS can_offer,
            fn_hc_offered(o.id,$1::date) AS offered,
            fn_hc_quota_asof(o.id,$1::date) AS quota
       FROM org_unit o
      WHERE o.is_active
        -- 只列叶子组织：非叶子不招人，它的"可招"没有意义（会与下属双算）
        AND NOT EXISTS (SELECT 1 FROM org_unit c WHERE c.parent_id = o.id AND c.is_active)
      ORDER BY o.path`, [asOf])).rows;

  return { as_of: asOf, requisitions, offers, capacity };
}

/** 开需求：挂在门店（叶子）上，名额不得超过"还能发" —— 两条都在触发器里 */
export async function openRequisition(tx, { userId, orgId, position, headcount, openedAt, reason }) {
  if (!Number.isInteger(orgId) || orgId <= 0) throw bizErr('E_ARG_INVALID', 'org 必须是正整数');
  if (!position) throw bizErr('E_ARG_INVALID', 'position 必填');
  if (!Number.isInteger(headcount) || headcount <= 0) throw bizErr('E_ARG_INVALID', 'headcount 必须是正整数');
  if (!DATE_RE.test(String(openedAt || ''))) throw bizErr('E_ARG_INVALID', 'opened_at 必须是 YYYY-MM-DD');
  if (String(reason || '').trim().length < 4)
    throw bizErr('E_ARG_INVALID', 'reason 至少 4 个字（开需求必须写依据）');

  await requireOrg(tx, { userId, resource: RESOURCES.write, orgId, dim: 'cost_org' });

  const r = (await tx.query(
    `INSERT INTO requisition(org_id, position, headcount, opened_at, reason, created_by)
     VALUES ($1,$2,$3,$4::date,$5,$6) RETURNING id`,
    [orgId, position, headcount, openedAt, reason || null, String(userId)])).rows[0];

  return { requisition_id: Number(r.id), org_id: orgId, headcount };
}

/**
 * 发 offer。
 * ★ 业务日期 p_on 显式传：不传就取数据库当前日期，
 *   于是"同一份数据今天发得出、明天发不出"，而拒绝信息里没有日期。
 */
export async function issueOffer(tx, { userId, requisitionId, candidateKey, candidateName,
                                       position, amount, validUntil, on, reason }) {
  if (!Number.isInteger(requisitionId) || requisitionId <= 0) throw bizErr('E_ARG_INVALID', 'rq 必须是正整数');
  if (!candidateKey || !candidateName) throw bizErr('E_ARG_INVALID', 'candidate_key / candidate_name 必填');
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw bizErr('E_ARG_INVALID', 'amount 必须是正数');
  if (!DATE_RE.test(String(validUntil || ''))) throw bizErr('E_ARG_INVALID', 'valid_until 必须是 YYYY-MM-DD');
  if (!DATE_RE.test(String(on || ''))) throw bizErr('E_ARG_INVALID', 'on 必须是 YYYY-MM-DD');
  // ★ reason ≥ 4 字是库里的 ck_ov_reason。这里提前拦，不是为了"更严格的校验"，
  //   是为了让失败**有名字**：否则调用方拿到的是 422 CHECK_VIOLATION，
  //   而它无法从那个码里读出"是依据太短了"。
  if (String(reason || '').trim().length < 4)
    throw bizErr('E_ARG_INVALID', 'reason 至少 4 个字（发 offer 必须写依据）');

  // 行闸的组织取自需求本身 —— 不由调用方传 org，
  // 否则"传一个我有权的 org、发一个别人的需求的 offer"就成立了。
  const rq = (await tx.query('SELECT org_id FROM requisition WHERE id=$1', [requisitionId])).rows[0];
  if (!rq) throw bizErr('E_RQ_NOT_FOUND', `需求 ${requisitionId} 不存在`);

  await requireOrg(tx, { userId, resource: RESOURCES.write, orgId: Number(rq.org_id), dim: 'cost_org' });

  const id = (await tx.query(
    'SELECT fn_offer_issue($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9) id',
    [requisitionId, candidateKey, candidateName, position || null,
     Number(amount), validUntil, on, String(userId), reason || null])).rows[0].id;

  return { offer_id: Number(id), requisition_id: requisitionId, org_id: Number(rq.org_id), status: 'pending' };
}

/**
 * 入职：offer → 任职 + 归属 + 月薪。
 * ★ 不自己插 employment / salary_standard：那三处必须同源（都来自 offer 最新版本），
 *   而这条件判断已经在 fn_offer_onboard 里。服务层再写一遍就是两份口径。
 * ★ person 为空时按候选人姓名建档 —— 本仓没有"新建员工"入口，这是最小补丁。
 */
export async function hire(tx, { userId, offerId, hireDate, entityId, personId }) {
  if (!Number.isInteger(offerId) || offerId <= 0) throw bizErr('E_ARG_INVALID', 'offer 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hireDate || ''))) throw bizErr('E_ARG_INVALID', 'date 必须是 YYYY-MM-DD');
  if (!Number.isInteger(entityId) || entityId <= 0) throw bizErr('E_ARG_INVALID', 'entity 必须是正整数');

  const row = (await tx.query(
    'SELECT org_id FROM offer WHERE id=$1', [offerId])).rows[0];
  if (!row) throw bizErr('E_OFFER_NOT_FOUND', `offer ${offerId} 不存在`);

  // 权限判在"这个 offer 挂在哪个组织"上，与发 offer 同一条判据
  await requireOrg(tx, { userId, resource: RESOURCES.write, orgId: Number(row.org_id), dim: 'cost_org' });

  const r = (await tx.query(
    'SELECT * FROM fn_hire_from_offer($1,$2,$3::date,$4,$5)',
    [offerId, personId ?? null, hireDate, entityId, String(userId)])).rows[0];

  return {
    offer_id: offerId,
    person_id: Number(r.person_id),
    employment_id: Number(r.employment_id),
    hire_date: hireDate,
  };
}
