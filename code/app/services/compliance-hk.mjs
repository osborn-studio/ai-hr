// ============================================================================
// app/services/compliance-hk.mjs · 香港线合规资料的两个只读出口（191 / 192）
// ----------------------------------------------------------------------------
// 两张表 + 两个只读函数都在库里（db/191_person_document.sql、db/192_mpf_account.sql），
// 这一层只做三件事，一件判据都不写：
//   ① 参数形状校验（days 的上下界、person 是否为正整数）；
//   ② 行闸：**同一套** fn_scope_people_station（与花名册/考勤同一个"我能看哪些人"）。
//      在这里另写"这个人归不归我管"，就会与花名册漂 —— 漂的形态是
//      "名单里看得到他，证照清单里看不到"，两边都像对的。
//   ③ 把 null 与空串归一（"没录"只有一种表示）。
//
// ★★ 这一层**不碰算薪**：证照与 MPF 账号都不进任何工资公式（docs/44 的口径）。
//   不要把 MPF 账号表接到 payslip / salary_standard 上 ——
//   "资料没录全"会变成"钱算错"，而算错的钱是要补的。
//
// ★ 「没有账号」与「没在供款」不是一回事：这里只回答前者（谁该开户而没开）。
//   金额口径在算薪侧（docs/44 CK19–CK20），两边不互相引用。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = {
  document: 'person_document',
  mpf: 'mpf_account',
};

/** 空串 → null：页面上 "" 是空白格、null 是"—"，"没录"必须只有一种表示。 */
const nn = (v) => (v === '' || v === undefined ? null : v);

/**
 * 证照到期清单：p_days 天内到期（只含当前在职、未过期）。
 * ★ 90 是常用档（工作签证续办留出的时间），但仍要显式传 ——
 *   写死 90 的后果是半年后有人要"180 天"，只能在代码里改。
 */
export async function expiringDocuments(tx, { userId, days = 90 }) {
  const d = Number(days);
  if (!Number.isInteger(d) || d <= 0 || d > 3650) {
    throw bizErr('E_ARG_INVALID', 'days 必须是 1..3650 之间的整数');
  }
  await requireSession(tx, { userId, resource: RESOURCES.document });

  const rows = (await tx.query(
    `SELECT d.person_id, d.full_name, d.doc_type, d.doc_no, d.expiry_date,
            d.days_left, d.issuing_country, d.note
       FROM fn_documents_expiring($1) d
      -- ★ 行闸：与他能不能看这个人（花名册）是同一套判据。
      --   日期传 NULL = 按今天判档口（与考勤一致：证照清单没有"历史某天"这种问法）。
      WHERE d.person_id IN (SELECT employee_id FROM fn_scope_people_station($2::bigint, NULL))`,
    [d, userId])).rows;

  return rows.map((r) => ({ ...r, doc_no: nn(r.doc_no), note: nn(r.note) }));
}

/**
 * 该有 MPF 账号却没有的人。
 * ★ reason：no_mpf_account（正常缺）/ birth_unknown（生日未知，不默认豁免，要人核）。
 */
export async function mpfMissing(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.mpf });

  const rows = (await tx.query(
    `SELECT m.person_id, m.full_name, m.hire_date, m.days_employed, m.age, m.reason
       FROM fn_mpf_missing() m
      WHERE m.person_id IN (SELECT employee_id FROM fn_scope_people_station($1::bigint, NULL))`,
    [userId])).rows;

  return rows.map((r) => ({ ...r, reason: nn(r.reason) }));
}
