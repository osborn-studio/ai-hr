// ============================================================================
// app/services/settlement.mjs · 外包结算：build / diff / confirm
// ----------------------------------------------------------------------------
// 结算上没有组织维度（对象是供应商），所以这里用 requireSession 而不是 requireOrg：
// **灌权限但不判对象**。
//
// 为什么不能干脆不灌：不灌的话，紧接着的 SQL 里如果有任何行闸，
// 它读的是空临时表 —— 于是一个"集团级操作"悄悄变成"什么都看不到"，
// 而症状看起来像数据没同步。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { settle: 'settlement' };

export async function build(tx, { userId, supplierId, period }) {
  if (!Number.isInteger(supplierId) || supplierId <= 0) throw bizErr('E_ARG_INVALID', 'supplier 必须是正整数');
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');

  await requireSession(tx, { userId, resource: RESOURCES.settle, action: 'write' });
  const id = (await tx.query('SELECT fn_settle_build($1,$2) id', [supplierId, period])).rows[0].id;
  return { settlement_id: Number(id), supplier_id: supplierId, period };
}

/** 确认：有差异就结不了。拒绝必须说清"差在哪、差几条"，所以不吞消息。 */
export async function confirm(tx, { userId, settlementId }) {
  if (!Number.isInteger(settlementId) || settlementId <= 0)
    throw bizErr('E_ARG_INVALID', 'id 必须是正整数');

  await requireSession(tx, { userId, resource: RESOURCES.settle, action: 'write' });
  await tx.query('SELECT fn_settle_confirm($1,$2)', [settlementId, String(userId)]);
  return { confirmed: true, id: settlementId };
}

export async function list(tx, { period }) {
  return (await tx.query(
    `SELECT s.id, s.period, s.status, s.our_hours, s.our_amount,
            s.their_hours, s.their_amount, s.diff_count, sup.name
       FROM settlement s JOIN supplier sup ON sup.id = s.supplier_id
      WHERE s.period = $1 ORDER BY s.id`, [period])).rows;
}

export async function diff(tx, { supplierId, period }) {
  return (await tx.query(
    `SELECT d.worker_id, w.full_name, d.work_date, d.kind, d.ours, d.theirs, d.hours_diff
       FROM fn_supplier_diff($1,$2) d
       JOIN outsourced_worker w ON w.id = d.worker_id
      ORDER BY d.work_date, d.worker_id`, [supplierId, period])).rows;
}
