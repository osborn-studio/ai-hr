// ============================================================================
// app/services/dispatch.mjs · 借调（人员调度，153）
// ----------------------------------------------------------------------------
// 这一层只做四件事：参数形状、身份换算、顺序、把库函数的返回值翻译成页面要的形状。
// **业务判据一条都不在这里**（在职、组织、重叠、状态机、原因长度全在库里）——
// JS 里再判一遍就有两个地方会漂，而漂的那一天通常是有人从 MCP 工具调进来的。
//
// 权限用 attendance_daily：借调的后果落在考勤与算薪上（支援那几天工时归哪家店），
// 能改考勤的人才该能派人。与 145 排班写入同一个理由，也同一个资源码。
//
// ★ 这一层刻意**没有** "把归属搬过去" 的动作。归属是
//   fn_dispatch_approve 里那条带 valid_from / valid_to 的
//   employee_org_assignment 写的 —— 到期自然失效，不需要任何人再点一次。
// ============================================================================
import { requireSession, requireOrg } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'attendance_daily', write: 'attendance_daily' };

const isId = (v) => Number.isInteger(v) && v > 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isPeriod = (v) => /^\d{4}-\d{2}$/.test(String(v || ''));

const STATUS = ['draft', 'approved', 'rejected', 'cancelled', 'finished'];

/**
 * 借调单列表。
 * 过滤条件全部可选：门店（作为借出方或接收方都算）、某人、状态、期间。
 * 期间用的口径是"这段借调**碰到了**这个月"，不是"开始日在这个月"——
 * 跨月的借调（10-28 → 11-03）在 11 月的账上也要看得见。
 */
export async function list(tx, { userId, orgId, employeeId, status, period }) {
  await requireSession(tx, { userId, resource: RESOURCES.read });

  // ★ 行闸。requireSession 只证明"这类资源你能看"，回答不了"哪些行"。
  //   缺了这一段，四维全空的账号会看到**全部**借调单 —— 而它不会报错，
  //   只会让权限看起来是好的。（M2 证明的正是这件事：没范围 = 0 行。）
  //   口径：借出方或接收方任一在我的范围内就算看得见。只认接收方的话，
  //   借出店的店长看不见"我的人被借走了"；只认借出方则反过来。
  //   两个维度都认，理由同 roster-write.week：真实客户里有的挂 cost_org、有的挂 attendance_org。
  const where = [`EXISTS (
      SELECT 1 FROM pg_temp.tmp_scope_org s
       WHERE s.dim_code IN ('cost_org','attendance_org')
         AND s.org_id IN (d.from_org, d.to_org)
         AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny dn
                          WHERE dn.dim_code = s.dim_code AND dn.org_id = s.org_id))`];
  const args = [];
  if (orgId !== undefined && orgId !== null && orgId !== '') {
    if (!isId(Number(orgId))) throw bizErr('E_ARG_INVALID', 'org 必须是正整数（org_unit.id）');
    args.push(Number(orgId));
    where.push(`(d.from_org = $${args.length} OR d.to_org = $${args.length})`);
  }
  if (employeeId !== undefined && employeeId !== null && employeeId !== '') {
    if (!isId(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
    args.push(Number(employeeId));
    where.push(`d.employee_id = $${args.length}`);
  }
  if (status !== undefined && status !== null && status !== '') {
    const s = String(status);
    if (!STATUS.includes(s)) throw bizErr('E_ARG_INVALID', `status 取 ${STATUS.join('/')}`);
    args.push(s);
    where.push(`d.status = $${args.length}`);
  }
  if (period !== undefined && period !== null && period !== '') {
    if (!isPeriod(period)) throw bizErr('E_ARG_INVALID', 'period 写 YYYY-MM');
    args.push(String(period));
    where.push(`daterange(d.from_date, d.to_date, '[]')
                && daterange(($${args.length} || '-01')::date,
                             (($${args.length} || '-01')::date + interval '1 month - 1 day')::date, '[]')`);
  }

  const rows = (await tx.query(
    `SELECT d.id, d.employee_id, p.full_name AS person_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = d.employee_id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            d.from_org, fo.name AS from_org_name,
            d.to_org,   o.name  AS to_org_name,
            d.from_date, d.to_date,
            (d.to_date - d.from_date + 1) AS days,
            d.reason, d.status, d.note,
            d.approved_by, d.approved_at, d.ended_at,
            d.created_by, d.created_at
       FROM roster_dispatch d
       JOIN org_unit fo ON fo.id = d.from_org
       JOIN org_unit o  ON o.id  = d.to_org
       JOIN person  p   ON p.id  = d.employee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY d.from_date DESC, d.id DESC
      LIMIT 500`, args)).rows;

  return {
    rows,
    kpi: {
      total: rows.length,
      draft: rows.filter((r) => r.status === 'draft').length,
      approved: rows.filter((r) => r.status === 'approved').length,
      finished: rows.filter((r) => r.status === 'finished').length,
    },
  };
}

/** 建借调草稿（不动任何归属：草稿不该改变考勤口径） */
export async function create(tx, { userId, employeeId, toOrg, from, to, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isId(toOrg)) throw bizErr('E_ARG_INVALID', 'to_org 必须是正整数（目标门店 org_unit.id）');
  if (!isDate(from) || !isDate(to)) throw bizErr('E_ARG_INVALID', 'from / to 写 YYYY-MM-DD');

  const id = Number((await tx.query(
    `SELECT fn_dispatch_create($1,$2,$3::date,$4::date,$5,$6) id`,
    [employeeId, toOrg, String(from), String(to),
      String(reason || '').trim() || null, String(userId)])).rows[0].id);

  // 回读：页面要说清"从哪借到哪、几天"，而不只是"成功"。
  // from_org 是库里算出来的（时点归属，回退成本组织），不能由调用方给。
  const r = (await tx.query(
    `SELECT d.id, d.employee_id, d.from_org, fo.name AS from_org_name,
            d.to_org, o.name AS to_org_name, d.from_date, d.to_date,
            (d.to_date - d.from_date + 1) AS days, d.reason, d.status
       FROM roster_dispatch d
       JOIN org_unit fo ON fo.id = d.from_org
       JOIN org_unit o  ON o.id  = d.to_org
      WHERE d.id = $1`, [id])).rows[0];

  return {
    ...r,
    _log: { dispatch: id, person: employeeId, from_to: `${from}~${to}`, to_org: toOrg },
  };
}

/**
 * 审批：ok=1 通过 / ok=0 驳回（必须写意见）。
 * 通过 = 写那条带有效期的 attendance_org 归属，之后到期自动失效，不需要再调任何接口。
 */
export async function approve(tx, { userId, id, ok, note }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数（roster_dispatch.id）');
  if (ok === undefined || ok === null || ok === '') {
    throw bizErr('E_ARG_INVALID', 'ok 必填（1 = 通过 / 0 = 驳回）');
  }
  const pass = ok === true || ok === 1 || ok === '1';

  const status = String((await tx.query(
    `SELECT fn_dispatch_approve($1,$2,$3,$4) s`,
    [id, pass, String(userId), String(note || '').trim() || null])).rows[0].s);

  return {
    id, status, ok: pass,
    // 通过时把归属段带回去：前端可以直接显示"11-16 到 11-18 落到 B 店考勤组"，
    // 不用再发一个请求去查"到底写进去了没有"。
    assignment: pass ? await currentAssignment(tx, id) : null,
    _log: { dispatch: id, ok: pass, status },
  };
}

/** 提前结束：把归属的 valid_to 收到今天，状态 finished */
export async function end(tx, { userId, id, on }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(id)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数（roster_dispatch.id）');
  if (on !== undefined && on !== null && on !== '' && !isDate(on)) {
    throw bizErr('E_ARG_INVALID', 'on 写 YYYY-MM-DD（不传 = 今天）');
  }

  const status = String((await tx.query(
    `SELECT fn_dispatch_end($1,$2,$3::date) s`,
    [id, String(userId), on ? String(on) : null])).rows[0].s);

  return { id, status, _log: { dispatch: id, status, on: on || 'today' } };
}

/** 某人某天是否在借调中 —— 排班/划线要在排之前问一句 */
export async function active(tx, { userId, employeeId, on }) {
  await requireSession(tx, { userId, resource: RESOURCES.read });
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isDate(on)) throw bizErr('E_ARG_INVALID', 'on 写 YYYY-MM-DD');

  const r = (await tx.query(
    `SELECT * FROM fn_dispatch_active($1,$2::date)`, [employeeId, String(on)])).rows[0];

  // 在借调就明确返回"那天该落到哪家店"，让调用方不用自己拼
  return {
    on: String(on), employee_id: employeeId,
    dispatching: !!r,
    to_org: r?.to_org ?? null, to_org_name: r?.to_org_name ?? null,
    dispatch_id: r?.dispatch_id ?? null,
  };
}

/** 借出组织在某期间的成本转移（按人天工时，落到各接收门店） */
export async function cost(tx, { userId, fromOrg, period }) {
  if (!isId(fromOrg)) throw bizErr('E_ARG_INVALID', 'from_org 必须是正整数（借出组织 org_unit.id）');
  if (!isPeriod(period)) throw bizErr('E_ARG_INVALID', 'period 写 YYYY-MM');
  // 这是一份**组织级报表**，不是一个列表：它没有行可过滤，只有"这个组织能不能看"。
  // 所以用 requireOrg（含岗位层 + 四维范围），而不是 requireSession。
  await requireOrg(tx, { userId, resource: RESOURCES.read, orgId: fromOrg, dim: 'cost_org' });

  const rows = (await tx.query(
    `SELECT * FROM fn_dispatch_cost($1,$2)`, [fromOrg, String(period)])).rows;

  return {
    from_org: fromOrg, period: String(period),
    rows,
    // 合计放在这里算：两个门店各读一遍再自己加，迟早加出两个不同的数
    total_hours: Math.round(rows.reduce((s, r) => s + Number(r.hours || 0), 0) * 100) / 100,
    total_person_days: rows.reduce((s, r) => s + Number(r.days || 0), 0),
  };
}

// 单据对应的那条归属段（审批后回读用）。只读，不改。
async function currentAssignment(tx, id) {
  return (await tx.query(
    `SELECT a.id, a.employee_id, a.org_id, o.name AS org_name, a.valid_from, a.valid_to
       FROM roster_dispatch d
       JOIN employee_org_assignment a
         ON a.employee_id = d.employee_id AND a.dim_code = 'attendance_org'
        AND a.org_id = d.to_org
        AND a.valid_from = d.from_date
       JOIN org_unit o ON o.id = a.org_id
      WHERE d.id = $1
      ORDER BY a.id DESC LIMIT 1`, [id])).rows[0] ?? null;
}
