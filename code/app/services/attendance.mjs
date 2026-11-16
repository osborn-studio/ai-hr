// ============================================================================
// app/services/attendance.mjs · 考勤：读列表 / 封账 / 未封账清单
// ----------------------------------------------------------------------------
// 封账是这套系统里最像"写权限"的东西，而它原来是这样过的：
//
//   await db.query(...) 判 store 在不在 tmp_scope_org 里
//   await db.query('SELECT fn_att_close(...)')   ← 另一条语句
//
// 两条语句在单连接上刚好能跑通，一旦上了连接池，判的是一个连接的临时表、
// 写的是另一个连接的 —— 判完就等于没判。所以这里把它收进一个事务，
// 并且判据仍然是**读用的那四张临时表**，不另开一套"封账权限"。
// ============================================================================
import { requireOrg, prepareRead } from './guard.mjs';
import { bizErr } from '../errors.mjs';
import { inStationScope } from './scope.mjs';

export const RESOURCES = { list: 'attendance_daily', close: 'attendance_daily' };

// 行闸 SQL：每维一个 EXISTS，deny 用 NOT EXISTS。四维全空自然返回 0 行。
// ★ 182：门店这一层之后再加"只看本档口"（见下方 inStationScope）。
//   两个 EXISTS 判的是"这家店在不在我范围内"，第三行判的是"这个人在不在我档口"。
//   前者少一个就是跨店泄漏，后者少一行就是厨师长看到整店 —— 两种都不报错。
// ★ 日期用 NULL = 按今天：这屏本来就没有 as_of（它是"当前考勤"），
//   不硬塞一个日期参数，避免"页面是今天、行闸是期末"这种两个时点（docs/45 踩过）。
const SCOPED_DAILY = `
  SELECT x.id, x.employee_id, x.store_id, x.work_date, x.work_hours,
         x.span_hours, x.in_attendance_hours
    FROM attendance_daily_store x
   WHERE EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                  WHERE s.dim_code = 'cost_org' AND s.org_id = x.store_id)
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                  WHERE s.dim_code = 'attendance_org' AND s.org_id = x.store_id)
     AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                      WHERE d.dim_code = 'cost_org' AND d.org_id = x.store_id)
     AND ${inStationScope('x.employee_id', '$1', 'NULL')}
   ORDER BY x.id`;

/** 考勤列表：四维里用成本组织 + 考勤组织两维，两个 EXISTS 都要满足 */
export async function listDaily(tx, { userId }) {
  await prepareRead(tx, { userId, resource: RESOURCES.list });
  return (await tx.query(SCOPED_DAILY, [userId])).rows;
}

/**
 * 封账。
 * ★ 期间必传：不传就封"当前月"，而"当前月"在跨月那一天会变成另一个月 ——
 *   于是同一个调用在不同日期封了不同的账，且日志里看不出区别。
 */
export async function closePeriod(tx, { userId, storeId, period }) {
  if (!Number.isInteger(storeId) || storeId <= 0) throw bizErr('E_ARG_INVALID', 'store 必须是正整数');
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');

  await requireOrg(tx, { userId, resource: RESOURCES.close, orgId: storeId, dim: 'cost_org', action: 'write' });

  // 空期间、重复封账都由库里拒（E_ATT_CLOSE_EMPTY / E_ATT_ALREADY_CLOSED）——
  // 这两个判据必须和 snapshot 在同一个函数里，否则"判的时候没数据、封的时候有数据"。
  await tx.query('SELECT fn_att_close($1,$2,$3)', [storeId, period, String(userId)]);

  // 封完立刻校验：重算摘要，与刚冻结的那份比。不一致说明封的过程中数据在动，
  // 这种情形必须在**同一个事务里**被发现，否则等到算薪时才炸，已经找不到现场。
  const chk = (await tx.query('SELECT * FROM fn_att_verify($1,$2)', [storeId, period])).rows;
  return { closed: true, store: storeId, period, verified: chk.length === 0 };
}

/** 未封账清单：算薪门禁读它；这里暴露成接口，因为"看不见才是问题" */
export async function unclosed(tx, { period }) {
  const rows = (await tx.query('SELECT store_id, why FROM fn_att_unclosed($1)', [period])).rows;
  return { period, rows, all_closed: rows.length === 0 };
}

/**
 * 补账：封账后唯一的修正通道。
 * ★ 权限判在**门店**上（cost_org），与封账同一条判据 —— 能封账的人才能补账。
 *   另开一条"补账权限"就会出现两套范围模型，而它们必然不同步。
 */
export async function adjust(tx, { userId, employeeId, storeId, workDate, delta, period, reason }) {
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数');
  if (!Number.isInteger(storeId) || storeId <= 0) throw bizErr('E_ARG_INVALID', 'store 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workDate || ''))) throw bizErr('E_ARG_INVALID', 'date 必须是 YYYY-MM-DD');
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');
  if (!Number.isFinite(Number(delta)) || Number(delta) === 0) {
    throw bizErr('E_ARG_INVALID', 'delta 必须是非零数字（要改就改多少写多少）');
  }

  await requireOrg(tx, { userId, resource: RESOURCES.close, orgId: storeId, dim: 'cost_org', action: 'write' });

  const id = (await tx.query(
    'SELECT fn_att_adjust($1,$2,$3::date,$4,$5,$6,$7) id',
    [employeeId, storeId, workDate, Number(delta), period, reason, String(userId)])).rows[0].id;
  return { adjustment_id: Number(id), employee_id: employeeId, store: storeId,
           work_date: workDate, delta: Number(delta), apply_period: period };
}

/** 补账清单：写在表里但看不见，等于只有一个写入方知道它存在 */
export async function adjustments(tx, { userId, period }) {
  await prepareRead(tx, { userId, resource: RESOURCES.list });
  return (await tx.query(
    `SELECT a.id, a.employee_id, a.store_id, a.work_date, a.hours_delta,
            a.apply_period, a.reason, a.created_by, a.created_at
       FROM attendance_adjustment a
      WHERE a.apply_period = $1
        AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                     WHERE s.dim_code='cost_org' AND s.org_id = a.store_id)
        -- 182：同一屏的第二个出口，同一条档口闸 —— 漏这一处就是
        -- "列表按档口收窄了、补账明细还列着整店的人"（170 文件头那种漏法）。
        AND ${inStationScope('a.employee_id', '$2', 'NULL')}
      ORDER BY a.id DESC`, [period, userId])).rows;
}
