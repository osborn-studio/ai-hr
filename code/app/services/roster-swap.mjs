// ============================================================================
// app/services/roster-swap.mjs · 换班（154）
// ----------------------------------------------------------------------------
// 五个动作：看单 / 填单 / 对方确认 / 主管审批 / 查记录。
//
// 判断全在库里（fn_swap_create / fn_swap_agree / fn_swap_decide / fn_swap_log）：
// 在职、段是否属于那天、换完会不会重叠、要不要先由对方确认、定案之后还能不能改。
// 这一层再判一次就有两个地方会漂 —— 而漂的那一次不会让任何断言变红。
//
// ★ 为什么写权限用 attendance_daily（与 145/148/151 一致）：
//   换班的后果落在排班段上，段就是工时，工时就是钱。能改考勤的人才该能换班。
//   067 那个 roster 资源是给"看板划线"留的，混用会让"只能看考勤"的人
//   也能改出影响工资的段。
//
// ★ 四种类型（Excel 原文，一个都不能少）：
//   self    调换自己的班次  —— 只改自己的段，不需要对方确认
//   swap    和别人调换班次  —— 两边的段互换归属（日期随班走）
//   cover   我替别人上班    —— 对方那天的段挪到我名下
//   covered 别人替我上班    —— 我这天的段挪到对方名下
//   cover 与 covered 不是同一个动作的别名：报表要回答"这个月替了几次、
//   被替了几次"，合并之后两个数就只能猜。
//
// ★ 半天换班（机场外包案例：「一天两个班次，且交换半天的班次」）：
//   from_seg / to_seg 写该段**开始时刻** HH:MM，只动那一段，另一段不动。
//   不写 = 整天。一天两段时 self 类型必须指明 —— 猜错的后果是把没人同意的
//   那半段班也换走了，而单子上看不出来。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'attendance_daily', write: 'attendance_daily' };

const isId = (v) => Number.isInteger(v) && v > 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
// 段没有名字，只有开始时刻这一个稳定身份（同日多段时 seq 从 1 重来）
const isSeg = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const KINDS = ['self', 'swap', 'cover', 'covered'];

/**
 * 换班单列表（在办/待确认的队列）。
 * ★ 这是唯一一处直接读表的地方：它只是"把单子摆出来"，
 *   没有任何业务判断（谁能确认、能不能批都在库里的函数里）。
 *   person 给了就只看与他有关的单（发起方或对方）。
 */
export async function list(tx, { userId, status, kind, person, from, to }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (status && !['draft', 'agreed', 'approved', 'rejected', 'cancelled'].includes(status)) {
    throw bizErr('E_ARG_INVALID', 'status 只认 draft / agreed / approved / rejected / cancelled');
  }
  if (kind && !KINDS.includes(kind)) {
    throw bizErr('E_ARG_INVALID', `kind 只认 ${KINDS.join(' / ')}`);
  }
  if (person !== undefined && person !== null && person !== '' && !isId(Number(person))) {
    throw bizErr('E_ARG_INVALID', 'person 必须是正整数（person.id）');
  }
  if (from && !isDate(from)) throw bizErr('E_ARG_INVALID', 'from 写 YYYY-MM-DD');
  if (to && !isDate(to)) throw bizErr('E_ARG_INVALID', 'to 写 YYYY-MM-DD');

  const rows = (await tx.query(
    `SELECT s.id, s.kind, s.status, s.from_person, s.to_person,
            fp.full_name AS from_name, tp.full_name AS to_name,
            s.from_date, s.from_seg, s.to_date, s.to_seg,
            s.from_shift, s.to_shift, s.reason, s.decide_note,
            s.agreed_at, s.approved_by, s.approved_at, s.applied_at,
            s.created_by, s.created_at
       FROM roster_swap s
       LEFT JOIN person fp ON fp.id = s.from_person
       LEFT JOIN person tp ON tp.id = s.to_person
      WHERE ($1::varchar IS NULL OR s.status = $1)
        AND ($2::varchar IS NULL OR s.kind = $2)
        AND ($3::bigint IS NULL OR s.from_person = $3 OR s.to_person = $3)
        AND ($4::date   IS NULL OR s.from_date >= $4)
        AND ($5::date   IS NULL OR s.from_date <= $5)
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT 500`,
    [status || null, kind || null,
      person === undefined || person === null || person === '' ? null : Number(person),
      from || null, to || null])).rows;

  return { rows, kpi: {
    total: rows.length,
    draft: rows.filter((r) => r.status === 'draft').length,
    agreed: rows.filter((r) => r.status === 'agreed').length,
    approved: rows.filter((r) => r.status === 'approved').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
  } };
}

/**
 * 填单。
 * self 必带 toShift（换成哪个班）；其余三种必带 toPerson，
 * cover 还要 toDate（被替的那天），covered 的 toDate 默认等于 fromDate。
 */
export async function create(tx, { userId, kind, fromPerson, toPerson, fromDate,
  fromSeg, toDate, toSeg, toShift, reason }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });

  const k = String(kind || '').trim().toLowerCase();
  if (!KINDS.includes(k)) {
    throw bizErr('E_ARG_INVALID', `kind 只认 ${KINDS.join(' / ')}（收到 ${kind || '空'}）`);
  }
  const fp = Number(fromPerson);
  if (!isId(fp)) throw bizErr('E_ARG_INVALID', 'fromPerson 必须是正整数（person.id）');
  if (!isDate(fromDate)) throw bizErr('E_ARG_INVALID', 'fromDate 写 YYYY-MM-DD');

  const tp = toPerson === undefined || toPerson === null || toPerson === ''
    ? null : Number(toPerson);
  if (k !== 'self') {
    if (!isId(tp)) throw bizErr('E_ARG_INVALID', `${k} 必须给 toPerson（对方是谁）`);
  } else if (tp !== null && !isId(tp)) {
    throw bizErr('E_ARG_INVALID', 'toPerson 要么不给，要么是正整数');
  }

  if (toDate && !isDate(toDate)) throw bizErr('E_ARG_INVALID', 'toDate 写 YYYY-MM-DD');
  const fs = String(fromSeg || '').trim() || null;
  const ts = String(toSeg || '').trim() || null;
  if (fs && !isSeg(fs)) throw bizErr('E_ARG_INVALID', 'fromSeg 写段开始时刻 HH:MM（不给 = 整天）');
  if (ts && !isSeg(ts)) throw bizErr('E_ARG_INVALID', 'toSeg 写段开始时刻 HH:MM（不给 = 整天）');

  const sh = String(toShift || '').trim().toUpperCase() || null;
  if (k === 'self' && !sh) {
    throw bizErr('E_ARG_INVALID', 'self 必须给 toShift（换成哪个班次，见 shift_def）');
  }
  // 原因长度也在库里判（E_SWAP_NO_REASON）—— 这里只做"给了没有"的形状校验，
  // 不写第二份"至少 4 字"，否则两处的阈值迟早不一致。
  if (!String(reason || '').trim()) throw bizErr('E_ARG_INVALID', 'reason 必填（至少 4 个字）');

  const id = Number((await tx.query(
    `SELECT fn_swap_create($1,$2,$3,$4::date,$5,$6::date,$7,$8,$9,$10) AS id`,
    [k, fp, tp, String(fromDate), fs,
      k === 'covered' && !toDate ? String(fromDate) : (toDate || null),
      ts, String(reason).trim(), String(userId), sh])).rows[0].id);

  return {
    id, kind: k, status: 'draft',
    from_person: fp, to_person: tp,
    from_date: String(fromDate), from_seg: fs,
    to_date: toDate || (k === 'covered' || k === 'self' ? String(fromDate) : null),
    to_seg: ts, to_shift: sh,
    // self 直接可以审批，其余三种要等对方确认 —— 页面据此决定显示哪个按钮
    needs_agree: k !== 'self',
    _log: { swap: id, kind: k, from: fp, to: tp, fromDate, toDate, reason: String(reason).trim() },
  };
}

/** 对方确认：draft → agreed（只允许对方本人，库里判 E_SWAP_NOT_YOURS） */
export async function agree(tx, { userId, id }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const sid = Number(id);
  if (!isId(sid)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');

  const status = String((await tx.query(
    `SELECT fn_swap_agree($1,$2) AS s`, [sid, String(userId)])).rows[0].s);

  return { id: sid, status, _log: { swap: sid, agree: true, by: String(userId) } };
}

/**
 * 主管审批：通过 → 自动改排班（applied_at 落库）；驳回 → rejected。
 * ★ "改排班"这件事在库里（fn_swap_apply）：删源段、在目标人名下重建段、
 *   重算两边 roster_slot。这一层不碰 schedule 表 —— 越过后它一次都写不对。
 */
export async function decide(tx, { userId, id, ok, note }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const sid = Number(id);
  if (!isId(sid)) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  if (ok === undefined || ok === null || ok === '') {
    throw bizErr('E_ARG_INVALID', 'ok 必填（1 = 通过 / 0 = 驳回）');
  }
  const pass = ok === true || ok === 1 || ok === '1';

  const status = String((await tx.query(
    `SELECT fn_swap_decide($1,$2,$3,$4) AS s`,
    [sid, pass, String(note || '').trim() || null, String(userId)])).rows[0].s);

  // 通过之后把"排班变成什么样"回读出来：页面要说"已落库，A 那天变成晚班"，
  // 而不是笼统地报"审批成功"—— 换班的意义全在这一步。
  let applied = null;
  if (pass) {
    applied = (await tx.query(
      `SELECT s.kind, s.from_person, s.to_person, s.from_date, s.to_date,
              s.from_shift, s.to_shift, s.applied_at,
              (SELECT count(*)::int FROM schedule sc
                JOIN schedule_segment sg ON sg.schedule_id = sc.id
               WHERE sc.employee_id = s.from_person AND sc.work_date = s.from_date) AS from_segs,
              (SELECT count(*)::int FROM schedule sc
                JOIN schedule_segment sg ON sg.schedule_id = sc.id
               WHERE sc.employee_id = COALESCE(s.to_person, s.from_person)
                 AND sc.work_date = CASE WHEN s.kind = 'self' THEN s.from_date ELSE s.to_date END
              ) AS to_segs
         FROM roster_swap s WHERE s.id = $1`, [sid])).rows[0] ?? null;
  }

  return {
    id: sid, status, applied,
    _log: { swap: sid, ok: pass, note: String(note || '').trim() || null },
  };
}

/**
 * 换班记录（产品要求"排班报表里可随时查看员工换班记录"）。
 * role 说明这个人在这张单里是发起方还是对方 —— 同一条记录在两个人的列表里
 * 长得一样的话，"我替了谁"与"谁替了我"就分不开了。
 */
export async function log(tx, { userId, person, from, to }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const p = Number(person);
  if (!isId(p)) throw bizErr('E_ARG_INVALID', 'person 必须是正整数（person.id）');
  if (from && !isDate(from)) throw bizErr('E_ARG_INVALID', 'from 写 YYYY-MM-DD');
  if (to && !isDate(to)) throw bizErr('E_ARG_INVALID', 'to 写 YYYY-MM-DD');

  const rows = (await tx.query(
    `SELECT * FROM fn_swap_log($1::bigint, $2::date, $3::date)`,
    [p, from || null, to || null])).rows;

  return {
    person: p, from: from || null, to: to || null, rows,
    kpi: {
      total: rows.length,
      // 三种口径分开数：替别人 / 被别人替 / 互调（自己的班次不算"替"）
      cover: rows.filter((r) => r.kind === 'cover').length,
      covered: rows.filter((r) => r.kind === 'covered').length,
      swap: rows.filter((r) => r.kind === 'swap').length,
      self: rows.filter((r) => r.kind === 'self').length,
      applied: rows.filter((r) => r.status === 'approved').length,
    },
  };
}
