// ============================================================================
// app/services/recruit-flow.mjs · 招聘后半段：面试 / 背调 / 录用审批
// ----------------------------------------------------------------------------
// recruit.mjs 管的是"开需求 → 发 offer"，这一层管的是**在发 offer 之前**
// 发生的那三件事，而那三件事原来只存在于邮件与面试官的记忆里。
//
// ★ 三条不做的事（每条都有原因，不是省事）：
//
//   ① **不在这里判合规。** "没有授权不许背调"由 background_check 的
//      ck_bg_consent 与 fn_bg_check_add 判。服务层再判一遍，就有两份口径；
//      而两份口径不同步的那天，被绕过的一定是弱的那份（绕过库只需要一条 SQL）。
//      这里只做"库管不到"的那部分：参数形状、组织范围。
//
//   ② **不把"可发"缓存成 offer 的一列。** 三步齐备是 fn_offer_issuable 算出来的；
//      接口每次问一次库，比维护一个会和审批表不同步的标志位便宜得多。
//
//   ③ **不替人签字。** approve 只是把"谁在什么时候做了什么决定"记下来，
//      approver 默认取当前登录人，但允许显式传（代理审批要留原审批人）。
//
// ★ 资源码是 `requisition`，**不是** `recruitment`：
//   028 登记的是 requisition（招聘需求），064 的角色授权也用它。
//   写成一个没登记的码，症状不是"权限不够"，是 `app_begin_scope` 直接
//   `E_RESOURCE_UNREGISTERED`（500）—— 而它看起来像服务故障。
//   api.test 的 AG0 就是拿各服务的 RESOURCES 与 sys_perm_resource 做差集。
// ============================================================================
import { requireOrg, requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'requisition', write: 'requisition' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
const isPosInt = (n) => Number.isInteger(n) && n > 0;
const str = (v) => String(v ?? '').trim();

/** 面试方式：枚举只写这一处，界面与校验都用它 */
const METHODS = { onsite: '到店/到场', video: '视频', phone: '电话' };
const CONCLUSIONS = { pass: '通过', hold: '待定', reject: '淘汰' };
const BG_KINDS = { education: '学历', employment: '前雇主', credit: '征信', criminal: '无犯罪记录' };
const BG_RESULTS = { clear: '无异常', risk: '有风险', unknown: '无法核实' };
const STEPS = { hc: '编制', budget: '预算', hr_head: 'HR 负责人' };

/** 需求 → 组织。面试记录的组织维度就是需求挂的那个门店（与 recruit.mjs 同一条判据）。 */
async function orgOfRequisition(tx, requisitionId) {
  const r = (await tx.query('SELECT org_id FROM requisition WHERE id = $1', [requisitionId])).rows[0];
  if (!r) throw bizErr('E_RQ_NOT_FOUND', `需求 ${requisitionId} 不存在`);
  return Number(r.org_id);
}

async function orgOfOffer(tx, offerId) {
  const r = (await tx.query('SELECT org_id FROM offer WHERE id = $1', [offerId])).rows[0];
  if (!r) throw bizErr('E_OFFER_NOT_FOUND', `offer ${offerId} 不存在`);
  return Number(r.org_id);
}

// ---------------------------------------------------------------------------
// 面试
// ---------------------------------------------------------------------------
/**
 * 某个需求（可再按候选人收窄）的面试轮次。
 * ★ 读也过组织闸：面试记录里有候选人姓名与评分，它与"这个门店的招聘"是同一批数据，
 *   不能出现"看不到招聘看板却读得到候选人姓名"。
 */
export async function rounds(tx, { userId, requisitionId, candidateKey = null }) {
  if (!isPosInt(requisitionId)) throw bizErr('E_ARG_INVALID', 'rq 必须是正整数');
  const orgId = await orgOfRequisition(tx, requisitionId);
  await requireOrg(tx, { userId, resource: RESOURCES.read, orgId, dim: 'cost_org' });

  const rows = (await tx.query(
    `SELECT id, requisition_id, candidate_key, candidate_name, round_no, interviewer,
            scheduled_at, method, score, conclusion, comment, created_at,
            -- 这个人在本需求上一共面了几轮：看板要能一眼看出"走到最后一轮了没有"，
            -- 而只列 1..n 行的话，读者得自己数
            count(*) OVER (PARTITION BY candidate_key)::int AS rounds_of_candidate
       FROM interview_round
      WHERE requisition_id = $1
        AND ($2::varchar IS NULL OR candidate_key = $2::varchar)
      ORDER BY candidate_key, round_no`, [requisitionId, candidateKey])).rows;

  return { requisition_id: requisitionId, rows, methods: METHODS, conclusions: CONCLUSIONS };
}

/**
 * 记一轮面试。
 * ★ 轮次递增、面试人不能是本人、淘汰必须写评语 —— 三条全在库里判，
 *   这里只把明显的形状错误提前挡住（否则调用方拿到的是 422 CHECK_VIOLATION，
 *   从那个码里读不出"是评语太短了"）。
 */
export async function addRound(tx, {
  userId, requisitionId, candidateKey, candidateName, roundNo,
  interviewer, scheduledAt, method, score = null, conclusion = null, comment = null,
}) {
  if (!isPosInt(requisitionId)) throw bizErr('E_ARG_INVALID', 'rq 必须是正整数');
  if (!str(candidateKey)) throw bizErr('E_ARG_INVALID', 'candidate_key 必填（用身份证 hash，不用姓名）');
  if (str(candidateName).length < 2) throw bizErr('E_ARG_INVALID', 'candidate_name 至少 2 个字');
  if (!isPosInt(roundNo)) throw bizErr('E_ARG_INVALID', 'round_no 必须是正整数（第几轮）');
  if (str(interviewer).length < 2) throw bizErr('E_ARG_INVALID', 'interviewer 必填');
  if (!TS_RE.test(str(scheduledAt)))
    throw bizErr('E_ARG_INVALID', 'scheduled_at 必须是 YYYY-MM-DD 或 YYYY-MM-DD HH:mm');
  if (!METHODS[method])
    throw bizErr('E_ARG_INVALID', `method 只能是 ${Object.keys(METHODS).join(' / ')}`);
  if (score !== null && score !== '' && score !== undefined) {
    const s = Number(score);
    if (!Number.isInteger(s) || s < 0 || s > 100)
      throw bizErr('E_ARG_INVALID', 'score 是 0–100 的整数（或留空＝只记录不评分）');
  }
  if (conclusion !== null && conclusion !== '' && conclusion !== undefined && !CONCLUSIONS[conclusion])
    throw bizErr('E_ARG_INVALID', `conclusion 只能是 ${Object.keys(CONCLUSIONS).join(' / ')}`);
  // ★ 这一条与库里的 ck_ir_reject_note 是同一条规则。提前拦的理由只有一个：
  //   拒绝信息要能读出"淘汰必须写清为什么"，而不是一句约束名。
  if (conclusion === 'reject' && str(comment).length < 10)
    throw bizErr('E_ARG_INVALID', '结论是淘汰时必须写 ≥10 字评语（淘汰要写清为什么）');

  const orgId = await orgOfRequisition(tx, requisitionId);
  await requireOrg(tx, { userId, resource: RESOURCES.write, orgId, dim: 'cost_org' });

  const id = (await tx.query(
    `SELECT fn_interview_add($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10) AS id`,
    [requisitionId, str(candidateKey), str(candidateName), roundNo, str(interviewer),
     str(scheduledAt), method,
     score === '' || score === undefined || score === null ? null : Number(score),
     conclusion || null, comment || null])).rows[0].id;

  return {
    interview_id: Number(id),
    requisition_id: requisitionId,
    round_no: roundNo,
    conclusion: conclusion || null,
  };
}

// ---------------------------------------------------------------------------
// 背调
// ---------------------------------------------------------------------------
/**
 * 某个候选人的背调记录（含未授权待查的行）。
 * ★ 只灌权限、不判对象：候选人不属于任何组织，他没有"哪个门店的候选人"这回事 ——
 *   硬绑一个 org 会逼着调用方去猜，而猜错的方向是"看不到"或"看得到别人的"。
 */
export async function bgChecks(tx, { userId, candidateKey }) {
  if (!str(candidateKey)) throw bizErr('E_ARG_INVALID', 'candidate_key 必填');
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });

  const rows = (await tx.query(
    `SELECT id, candidate_key, kind, consent_at, checked_at, result, detail, checked_by, created_at,
            -- 两条对界面有用、但对每个人都要算一遍的判断放库里算，前端不再复述规则
            (consent_at IS NOT NULL)                         AS has_consent,
            (checked_at IS NOT NULL)                         AS is_done
       FROM background_check
      WHERE candidate_key = $1
      ORDER BY created_at DESC, id DESC`, [str(candidateKey)])).rows;

  return { candidate_key: str(candidateKey), rows, kinds: BG_KINDS, results: BG_RESULTS };
}

/**
 * 记一次背调：先授权、后结论。
 * ★ 授权时间必填这条**不在服务层判**（见文件头 ①）：
 *   库里的 ck_bg_consent 与 fn_bg_check_add 的 E_BG_NO_CONSENT 是唯一口径。
 *   服务层原样把 consent_at 传下去，让"缺授权"由库拒，并带上那个名字 ——
 *   在服务层先抛一次，等于把同一条合规规则实现两遍。
 */
export async function addBgCheck(tx, {
  userId, candidateKey, kind, consentAt = null, checkedAt = null,
  result = null, detail = null, checkedBy = null,
}) {
  if (!str(candidateKey)) throw bizErr('E_ARG_INVALID', 'candidate_key 必填');
  if (!BG_KINDS[kind]) throw bizErr('E_ARG_INVALID', `kind 只能是 ${Object.keys(BG_KINDS).join(' / ')}`);
  if (consentAt !== null && consentAt !== '' && !TS_RE.test(str(consentAt)))
    throw bizErr('E_ARG_INVALID', 'consent_at 必须是 YYYY-MM-DD 或 YYYY-MM-DD HH:mm');
  if (checkedAt !== null && checkedAt !== '' && !TS_RE.test(str(checkedAt)))
    throw bizErr('E_ARG_INVALID', 'checked_at 必须是 YYYY-MM-DD 或 YYYY-MM-DD HH:mm');
  if (result !== null && result !== '' && !BG_RESULTS[result])
    throw bizErr('E_ARG_INVALID', `result 只能是 ${Object.keys(BG_RESULTS).join(' / ')}`);
  if (result === 'risk' && str(detail).length < 10)
    throw bizErr('E_ARG_INVALID', '结论是有风险时必须写 ≥10 字：风险是什么（否则这条记录没法被引用）');

  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  const id = (await tx.query(
    `SELECT fn_bg_check_add($1,$2,$3::timestamptz,$4::timestamptz,$5,$6,$7) AS id`,
    [str(candidateKey), kind,
     consentAt ? str(consentAt) : null,
     checkedAt ? str(checkedAt) : null,
     result || null, detail || null,
     str(checkedBy) || str(userId)])).rows[0].id;

  return { bg_check_id: Number(id), candidate_key: str(candidateKey), kind };
}

// ---------------------------------------------------------------------------
// 录用审批
// ---------------------------------------------------------------------------
/** 某个 offer 的三步审批 + 是否可发 */
export async function approvals(tx, { userId, offerId }) {
  if (!isPosInt(offerId)) throw bizErr('E_ARG_INVALID', 'offer 必须是正整数');
  const orgId = await orgOfOffer(tx, offerId);
  await requireOrg(tx, { userId, resource: RESOURCES.read, orgId, dim: 'cost_org' });

  const rows = (await tx.query(
    `SELECT step, approver, decision, decided_at, note, created_at
       FROM offer_approval WHERE offer_id = $1
      ORDER BY CASE step WHEN 'hc' THEN 1 WHEN 'budget' THEN 2 ELSE 3 END`, [offerId])).rows;
  const iss = (await tx.query('SELECT fn_offer_issuable($1) AS ok', [offerId])).rows[0].ok;

  // ★ 缺哪一步要说出来：只回一个 issuable=false，读者还得自己数一遍
  const done = rows.filter((r) => r.decision === 'approved').map((r) => r.step);
  const missing = Object.keys(STEPS).filter((s) => !done.includes(s));

  return { offer_id: offerId, rows, issuable: iss === true, missing_steps: missing, steps: STEPS };
}

/**
 * 签一步。
 * ★ approver 默认取当前登录人，但允许显式传：代理审批要留**原审批人**，
 *   写成"代签的那个人"会让事后追责追错人。
 */
export async function approve(tx, {
  userId, offerId, step, decision, approver = null, note = null,
}) {
  if (!isPosInt(offerId)) throw bizErr('E_ARG_INVALID', 'offer 必须是正整数');
  if (!STEPS[step]) throw bizErr('E_ARG_INVALID', `step 只能是 ${Object.keys(STEPS).join(' / ')}`);
  if (decision !== 'approved' && decision !== 'rejected')
    throw bizErr('E_ARG_INVALID', 'decision 只能是 approved / rejected');
  if (decision === 'rejected' && str(note).length < 4)
    throw bizErr('E_ARG_INVALID', '驳回必须写 ≥4 字理由（否则申请人不知道要改什么）');

  const orgId = await orgOfOffer(tx, offerId);
  await requireOrg(tx, { userId, resource: RESOURCES.write, orgId, dim: 'cost_org' });

  const r = (await tx.query(
    'SELECT * FROM fn_offer_approve($1,$2,$3,$4,$5)',
    [offerId, step, str(approver) || str(userId), decision, note ? str(note) : null])).rows[0];

  // "还不能发"必须带着"缺哪几步"，否则下一个人还要自己去数一遍 ——
  // 而数的时候漏掉一步，就是把一个没有预算签字的 offer 发出去了。
  const okSteps = (await tx.query(
    `SELECT step FROM offer_approval WHERE offer_id = $1 AND decision = 'approved'`,
    [offerId])).rows.map((x) => x.step);
  const missing = Object.keys(STEPS).filter((s) => !okSteps.includes(s));

  return {
    offer_id: offerId,
    step: r.step,
    decision: r.decision,
    steps_ok: Number(r.steps_ok),
    issuable: r.issuable === true,
    offer_status: r.offer_status,
    missing_steps: r.issuable === true ? [] : missing,
  };
}

// ---------------------------------------------------------------------------
// 候选人历史
// ---------------------------------------------------------------------------
/**
 * 这个 candidate_key 的老底：面过几轮、投过几个岗位、有没有重复。
 * ★ 与审批/面试不同，这里**不判组织**：候选人不属于任何组织，
 *   而"这个人是不是被两个门店各面了一轮"恰恰要跨组织才看得见。
 */
export async function candidateHistory(tx, { userId, candidateKey }) {
  if (!str(candidateKey)) throw bizErr('E_ARG_INVALID', 'candidate_key 必填');
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });

  const r = (await tx.query(
    'SELECT * FROM fn_candidate_history($1)', [str(candidateKey)])).rows[0];

  return {
    candidate_key: r.candidate_key,
    rounds: Number(r.rounds),
    requisitions: Number(r.requisitions),
    offers: Number(r.offers),
    passed_rounds: Number(r.passed_rounds),
    rejected_rounds: Number(r.rejected_rounds),
    first_round_at: r.first_round_at,
    last_round_at: r.last_round_at,
    is_duplicate: r.is_duplicate === true,
    positions: r.positions,
    note: r.note,
  };
}
