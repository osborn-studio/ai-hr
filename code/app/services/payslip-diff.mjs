// ============================================================================
// app/services/payslip-diff.mjs · 工资条环比（136）
// ----------------------------------------------------------------------------
// 员工问"这个月为什么少了 300"，HR 现在的答案是"你自己看明细"。
// 明细能看出每一项是多少，看不出哪一项变了 —— 而这正是被问的那件事。
//
// 这一层只做转发：差异与归因都在库里（fn_payslip_diff / fn_payslip_explain）。
// 不在服务层算，是因为归因要跨考勤、社保、调薪、税档四张表 —— 放在 SQL 里
// 才是"一次取数、一个口径"；分到 JS 里就成了两处逻辑各自漂。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payslip' };

const isPeriod = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));

export async function diff(tx, { userId, personId, period, base }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!Number.isInteger(personId) || personId <= 0) {
    throw bizErr('E_ARG_INVALID', 'person 必须是正整数（person.id，不是工号）');
  }
  if (!isPeriod(period)) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');
  if (base && !isPeriod(base)) throw bizErr('E_ARG_INVALID', 'base 必须是 YYYY-MM');

  const rows = (await tx.query(
    `SELECT * FROM fn_payslip_diff($1,$2,$3)`, [personId, period, base || null])).rows;
  const explain = (await tx.query(
    `SELECT seq, code, msg FROM fn_payslip_explain($1,$2,$3)
      ORDER BY seq`, [personId, period, base || null])).rows;

  return { person_id: personId, period, base: base || null, rows, explain };
}
