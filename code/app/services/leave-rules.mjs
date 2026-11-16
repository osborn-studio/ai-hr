// ============================================================================
// app/services/leave-rules.mjs · 假种的三条发放/申请规则（152）
// ----------------------------------------------------------------------------
// 这一层只做四件事：列规则、改规则、按月发放、提交前校验。
// **额度怎么拆、怎么取整、什么时候拒，一律在库里算** —— 这里不写第二套。
//
// 为什么坚持"取整只在库里做一次"：
//   界面要预览"每月 0.83 天"，实际发放是 0.5 天，尾差补到 12 月。如果前端
//   自己也 round 一遍，页面就会显示 0.83，而台账上是 0.5，HR 会认为系统算错了。
//
// ★ 单位口径（这一版最容易错的地方）：
//   leave_request.qty 与 leave_grant.qty 都是**天**（138 定的口径），
//   而 max_hours_per_request / proof_after_hours 是**小时**。
//   所以进库前必须 天 → 小时（× 每日标准工时，默认 8），出库后再换回天数。
//   混着传的后果是"请 1 天被当成 1 小时"，于是永远不触发门槛 —— 静默失效。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

// ★ 假期域的资源码统一是 leave_request（与 leave-board 一致）：
//   另开 leave_policy 会让"能看额度但不能改假种"这种组合在库里不存在，
//   而实际客户就是要这么配。
export const RESOURCES = { read: 'leave_request', write: 'leave_request' };

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isPosInt = (n) => Number.isInteger(n) && n > 0;

const days = (v) => Math.round(Number(v) * 100) / 100;
const hours = (v) => Math.round(Number(v) * 100) / 100;

/** 每日标准工时（天 ↔ 小时换算的唯一来源，默认 8） */
async function stdHoursPerDay(tx) {
  const r = (await tx.query(
    `SELECT COALESCE(value_num, 8) h FROM fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, app_today())`
  )).rows[0];
  const h = Number(r?.h);
  return Number.isFinite(h) && h > 0 ? h : 8;
}

/**
 * 假种列表 + 三项规则 + 本年已批天数。
 * 规则原样给出（含 NULL = 不限/不需要），不在这里翻译成"0 = 不限"：
 * 0 与 NULL 在业务上相反，服务层替它翻译就会把"一次也不能请"变成"随便请"。
 */
/**
 * 请假**资格**（164）：这个人有没有资格休这种假、今年应享几天。
 *
 * ★ 与 checkRequest（152）分工：那个判"这一单合不合规"（额度、凭证、单次上限），
 *   这个判"有没有资格"。两者都要过 —— 缺一条就会出「有额度但没资格」
 *   或「有资格但没额度」的怪事，而两种怪事在页面上长得一模一样。
 */
export async function eligibility(tx, { userId, employeeId, typeCode, from, to }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || ''))
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) {
    throw bizErr('E_ARG_INVALID', '起止日必须是 YYYY-MM-DD');
  }
  const rows = (await tx.query(
    `SELECT * FROM fn_leave_eligibility($1,$2,$3::date,$4::date)`,
    [employeeId, String(typeCode || ''), from, to])).rows;
  const blocks = rows.filter((r) => r.level === 'block');
  const warns = rows.filter((r) => r.level === 'warn');

  // 资格与"能休几天"一起给：只给结论不给数字，页面说不出"你今年应享 2 天"
  const info = (await tx.query(
    `SELECT fn_annual_leave_entitled($1, EXTRACT(YEAR FROM $2::date)::int) entitled,
            fn_leave_qualified($1, $2::date) qualified,
            fn_medical_period_months($1, $2::date) medical_months,
            fn_cumulative_years($1, $2::date) service_years`,
    [employeeId, from])).rows[0];

  return {
    employee_id: employeeId, type_code: typeCode, from, to,
    ok: blocks.length === 0,
    blocks: blocks.map((b) => ({ code: b.code, message: b.message })),
    warns: warns.map((w) => ({ code: w.code, message: w.message })),
    entitled_days: Number(info.entitled),
    qualified: info.qualified === true,
    medical_months: Number(info.medical_months),
    service_years: Number(info.service_years),
  };
}

export async function types(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  const rows = (await tx.query(
    `SELECT t.id, t.code, t.name, t.expire_policy, t.pay_ratio,
            t.is_system, t.is_active, t.note,
            t.grant_mode, t.round_step, t.round_dir,
            t.max_hours_per_request, t.proof_after_hours,
            COALESCE((SELECT sum(r.qty) FROM leave_request r
                       WHERE r.leave_type_id = t.id AND r.status = 'approved'
                         AND r.date_from >= date_trunc('year', app_today())::date), 0) AS used_this_year
       FROM leave_type t
      WHERE t.is_active
      ORDER BY t.is_system DESC, t.id`)).rows;

  return {
    canWrite,
    // 枚举的中文名只写一处：界面两处各写一份必然漂
    grantModes: { once: '一次性发放', monthly: '按月平均发放' },
    roundDirs: { half: '四舍五入', down: '向下取整', up: '向上取整' },
    rows: rows.map((r) => ({
      ...r,
      grant_mode: r.grant_mode || 'once',
      round_step: Number(r.round_step),
      round_dir: r.round_dir || 'half',
      max_hours_per_request: r.max_hours_per_request == null ? null : Number(r.max_hours_per_request),
      proof_after_hours: r.proof_after_hours == null ? null : Number(r.proof_after_hours),
      used_this_year: days(r.used_this_year),
    })),
  };
}

/**
 * 改一个假种的规则。只改传进来的项（undefined = 不动）。
 * ★ 用 null 显式表示"取消限制"（max_hours_per_request / proof_after_hours），
 *   所以这里必须能区分 undefined 与 null —— 前端"清空"传 null，"不改"就别传。
 */
export async function setRule(tx, {
  userId, typeId, grantMode, roundStep, roundDir, maxHours, proofAfterHours, reason,
}) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isPosInt(Number(typeId))) throw bizErr('E_ARG_INVALID', 'type 必须是假种 id（正整数）');

  const cur = (await tx.query(
    `SELECT id, code, name, grant_mode, round_step, round_dir,
            max_hours_per_request, proof_after_hours
       FROM leave_type WHERE id = $1`, [Number(typeId)])).rows[0];
  if (!cur) throw bizErr('E_NOT_FOUND', `假种 ${typeId} 不存在`);

  // 校验放在服务层是给"人话"，库里那几条 CHECK 是最后一道（23514 读起来不像人话）
  if (grantMode !== undefined && !['once', 'monthly'].includes(String(grantMode))) {
    throw bizErr('E_ARG_INVALID', 'grant_mode 只支持 once（一次性）/ monthly（按月平均）');
  }
  if (roundDir !== undefined && !['up', 'down', 'half'].includes(String(roundDir))) {
    throw bizErr('E_ARG_INVALID', 'round_dir 只支持 up / down / half');
  }
  if (roundStep !== undefined) {
    const s = Number(roundStep);
    if (!Number.isFinite(s) || s <= 0 || s > 10) {
      throw bizErr('E_ARG_INVALID', '最小步长要在 0 与 10 天之间（0.5 = 半天）');
    }
  }
  if (maxHours !== undefined && maxHours !== null) {
    const h = Number(maxHours);
    if (!Number.isFinite(h) || h <= 0) {
      throw bizErr('E_ARG_INVALID', '单次最大时长要么是正数（小时），要么传 null 表示不限');
    }
  }
  if (proofAfterHours !== undefined && proofAfterHours !== null) {
    const h = Number(proofAfterHours);
    if (!Number.isFinite(h) || h <= 0) {
      throw bizErr('E_ARG_INVALID', '证明门槛要么是正数（小时），要么传 null 表示不需要证明');
    }
    // 门槛高于上限时，这条规则永远触发不了 —— 静默失效，必须先拦
    const max = maxHours !== undefined ? maxHours : cur.max_hours_per_request;
    if (max != null && h > Number(max)) {
      throw bizErr('E_ARG_INVALID',
        `证明门槛（${h} 小时）高于单次最大时长（${Number(max)} 小时），这条规则永远不会触发`);
    }
  }

  // ★ 从 once 改成 monthly 不追溯已有台账：已经一次性发过的年份不能悄悄拆开，
  //   拆开会让"已用天数"分摊到 12 条上，而历史请假单挂在原来的整条授予上。
  const r = await tx.query(
    `UPDATE leave_type SET
       grant_mode           = COALESCE($2, grant_mode),
       round_step           = COALESCE($3, round_step),
       round_dir            = COALESCE($4, round_dir),
       max_hours_per_request = CASE WHEN $5::boolean THEN $6::numeric ELSE max_hours_per_request END,
       proof_after_hours     = CASE WHEN $7::boolean THEN $8::numeric ELSE proof_after_hours END
     WHERE id = $1
     RETURNING id, code, name, grant_mode, round_step, round_dir,
               max_hours_per_request, proof_after_hours`,
    [Number(typeId),
      grantMode === undefined ? null : String(grantMode),
      roundStep === undefined ? null : Number(roundStep),
      roundDir === undefined ? null : String(roundDir),
      maxHours !== undefined, maxHours === undefined ? null : (maxHours === null ? null : Number(maxHours)),
      proofAfterHours !== undefined,
      proofAfterHours === undefined ? null : (proofAfterHours === null ? null : Number(proofAfterHours))]
  );

  const row = r.rows[0];
  return {
    id: Number(row.id), code: row.code, name: row.name,
    grant_mode: row.grant_mode, round_step: Number(row.round_step), round_dir: row.round_dir,
    max_hours_per_request: row.max_hours_per_request == null ? null : Number(row.max_hours_per_request),
    proof_after_hours: row.proof_after_hours == null ? null : Number(row.proof_after_hours),
    _log: { type: Number(typeId), reason: String(reason || '').trim() || null },
  };
}

/**
 * 按月平均发放：把全年总额拆成 12 条授予（每月 1 日生效），尾差补 12 月。
 * 重跑幂等（库里先删「按月发放」前缀的行再重建），可以直接当"重算"按钮用。
 * 返回发放后的 12 个月明细，界面不必自己再算一遍。
 */
export async function grantMonthly(tx, { userId, employeeId, typeId, year, total }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isPosInt(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是 person.id（正整数）');
  if (!isPosInt(Number(typeId))) throw bizErr('E_ARG_INVALID', 'type 必须是假种 id（正整数）');

  const y = Number(year) || Number((await tx.query(
    `SELECT EXTRACT(year FROM app_today()) y`)).rows[0].y);
  const totalArg = (total === undefined || total === null || total === '') ? null : Number(total);
  if (totalArg !== null && (!Number.isFinite(totalArg) || totalArg <= 0)) {
    throw bizErr('E_ARG_INVALID', '总额要么是正数（天），要么不传（年假按档位算）');
  }

  const got = Number((await tx.query(
    `SELECT fn_leave_grant_monthly($1,$2,$3,$4::numeric,$5) t`,
    [Number(employeeId), Number(typeId), y, totalArg, String(userId)])).rows[0].t);

  const rows = (await tx.query(
    `SELECT valid_from::text AS valid_from, qty, leave_year, reason
       FROM leave_grant
      WHERE employee_id = $1 AND leave_type_id = $2
        AND COALESCE(leave_year, EXTRACT(year FROM valid_from)::int) = $3
        AND reason LIKE '按月发放%'
      ORDER BY valid_from`, [Number(employeeId), Number(typeId), y])).rows;

  return {
    employee_id: Number(employeeId), type_id: Number(typeId), year: y,
    total: days(got),
    months: rows.map((r) => ({
      valid_from: r.valid_from, qty: days(r.qty), month: Number(String(r.valid_from).slice(5, 7)),
    })),
    // 对账口径：这里直接给出"12 个月合计"，让界面显示的数与台账同源
    granted_sum: days(rows.reduce((a, r) => a + Number(r.qty), 0)),
    _log: { employee_id: Number(employeeId), type_id: Number(typeId), year: y, total: days(got) },
  };
}

/**
 * 提交前校验：最大时长 + 证明门槛。**在 fn_leave_apply 之前调用**。
 * 小时数可以不传：传了 days 就按每日标准工时换算（天 → 小时）。
 */
export async function checkRequest(tx, {
  userId, employeeId, typeId, from, to, hours: h, days: d, proofNote,
}) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isPosInt(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是 person.id（正整数）');
  if (!isPosInt(Number(typeId))) throw bizErr('E_ARG_INVALID', 'type 必须是假种 id（正整数）');
  if (!isDate(from) || !isDate(to)) throw bizErr('E_ARG_INVALID', 'from / to 要写 YYYY-MM-DD');

  const perDay = await stdHoursPerDay(tx);
  let hrs = h === undefined || h === null || h === '' ? null : Number(h);
  if (hrs === null) {
    const dd = Number(d);
    if (!Number.isFinite(dd) || dd <= 0) {
      throw bizErr('E_ARG_INVALID', '要么给小时数（hours），要么给请假天数（days）');
    }
    hrs = dd * perDay;
  }
  if (!Number.isFinite(hrs) || hrs <= 0) throw bizErr('E_ARG_INVALID', '请假时长必须是正数');

  await tx.query(`SELECT fn_leave_request_check($1,$2,$3::date,$4::date,$5::numeric,$6)`,
    [Number(employeeId), Number(typeId), from, to, hrs, proofNote == null ? null : String(proofNote)]);

  const rule = (await tx.query(
    `SELECT name, grant_mode, max_hours_per_request, proof_after_hours
       FROM leave_type WHERE id = $1`, [Number(typeId)])).rows[0];

  return {
    ok: true, employee_id: Number(employeeId), type_id: Number(typeId),
    hours: hours(hrs), days: days(hrs / perDay), hours_per_day: perDay,
    max_hours_per_request: rule?.max_hours_per_request == null ? null : Number(rule.max_hours_per_request),
    proof_after_hours: rule?.proof_after_hours == null ? null : Number(rule.proof_after_hours),
    proof_required: rule?.proof_after_hours != null && hrs > Number(rule.proof_after_hours),
  };
}

/**
 * 提交请假：校验 → 建单 → 把证明说明写回单据，**同一个事务**。
 * 之所以三合一：★ 校验与建单分开事务的话，中间改一次假种配置就能绕过去；
 * 证明说明晚一步写，就会出现"单据已批、证明那一栏永远空着"的单子 ——
 * 而空着的那栏，事后正是审计要查的那一栏。
 */
export async function submit(tx, {
  userId, employeeId, typeId, from, to, days: d, proofNote,
}) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isPosInt(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是 person.id（正整数）');
  if (!isPosInt(Number(typeId))) throw bizErr('E_ARG_INVALID', 'type 必须是假种 id（正整数）');
  if (!isDate(from) || !isDate(to)) throw bizErr('E_ARG_INVALID', 'from / to 要写 YYYY-MM-DD');

  const qty = Number(d);
  if (!Number.isFinite(qty) || qty <= 0) throw bizErr('E_ARG_INVALID', '请假天数必须是正数');

  const perDay = await stdHoursPerDay(tx);
  const note = proofNote == null ? null : String(proofNote).trim().slice(0, 200) || null;

  // ① 先校验（不冻结额度，拒了不留 released 行）
  await tx.query(`SELECT fn_leave_request_check($1,$2,$3::date,$4::date,$5::numeric,$6)`,
    [Number(employeeId), Number(typeId), from, to, qty * perDay, note]);

  // ② 建单 + 冻结额度（fn_leave_apply 内部一次做完）
  const id = Number((await tx.query(
    `SELECT fn_leave_apply($1,$2,$3::numeric,$4::date,$5::date) id`,
    [Number(employeeId), Number(typeId), qty, from, to])).rows[0].id);

  // ③ 证明说明写回单据（附件本身在文件系统里，单据只留"交了什么"）
  if (note) {
    await tx.query(`UPDATE leave_request SET proof_note = $2 WHERE id = $1`, [id, note]);
  }

  return {
    requestId: id, employee_id: Number(employeeId), type_id: Number(typeId),
    days: days(qty), hours: hours(qty * perDay), proof_note: note, status: 'pending',
    _log: { request: id, type: Number(typeId), days: days(qty), proof: note },
  };
}
