// ============================================================================
// app/services/roster-team.mjs · 班组排班 + 周期排班（150）
// ----------------------------------------------------------------------------
// 这一层只做两件事：看（有哪些组、有哪些周期模板）、动（建组/加人/整组排班/
// 存模板/套模板）。所有判断都在库里（一人一组是移动、空组不许排、pattern 的
// day 必须连续、请假/锁定/借调在外要跳过）—— 这里不重复一遍规则：
// JS 里再判一次，就有两个地方会漂，而漂的那一天通常是在加维度的时候。
//
// ★ 为什么整组排班要回"跳过了谁"，而不是只回一个数：
//   fn_team_assign 按产品要求"单人失败只跳过"，于是返回 11 而组里 12 个人
//   是完全正常的结果。只回 11 的话，操作员会以为这组就 11 个人 ——
//   漏排的那个人要到月底算薪才发现（那天没有工时）。所以排完回读一遍
//   "组里谁今天没有这个班"，把差额补成名字。
//
// ★ 为什么套用周期要回 items 而不只回 skipped 数：
//   一次铺 30 天、跳过 4 天，操作员第一个问题是"跳的是哪几天、为什么"。
//   让他自己去 schedule 表里比对，等于让他在 30 行里找一个空格 ——
//   库函数已经把原因按天拼好了（"07-03 已请假；07-07 已锁定"），
//   这一层只是把它拆成能渲染的行。
//
// ★ 写权限沿用 attendance_daily（与 145 一致）：排班的后果落在考勤与算薪上，
//   能改考勤的人才该能排班。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'attendance_daily', write: 'attendance_daily' };

const isId = (v) => Number.isInteger(v) && v > 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** 班次表：页面要画颜色选择器，前端不该自己维护一份班次码 */
const shiftsOf = async (tx) => (await tx.query(
  `SELECT code, name, color, start_time, end_time, is_rest
     FROM shift_def ORDER BY start_time, code`)).rows;

/**
 * 班组列表（含成员）。
 * @param {number|null} orgId 只看某家店；不传 = 全部（按组织排序）
 */
export async function teams(tx, { userId, orgId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const org = orgId === undefined || orgId === null || orgId === '' ? null : Number(orgId);
  if (org !== null && !isId(org)) {
    throw bizErr('E_ARG_INVALID', 'org 必须是正整数（org_unit.id），不传 = 全部');
  }

  const rows = (await tx.query(
    `SELECT t.id, t.name, t.org_id, o.name AS org_name, t.created_by, t.created_at,
            (SELECT count(*)::int FROM roster_team_member m WHERE m.team_id = t.id) AS members
       FROM roster_team t
       LEFT JOIN org_unit o ON o.id = t.org_id
      WHERE ($1::bigint IS NULL OR t.org_id = $1::bigint)
      ORDER BY t.org_id, t.name`, [org])).rows;

  // 成员一次取完再分组：逐组查一次会在 20 个组时变成 21 条 SQL，
  // 而这一屏就是"看所有组"，正是组最多的那种场合。
  const mem = (await tx.query(
    `SELECT m.team_id, m.employee_id, p.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = p.id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            m.joined_at, m.added_by
       FROM roster_team_member m
       JOIN person p ON p.id = m.employee_id
      WHERE ($1::bigint IS NULL OR m.team_id IN (
              SELECT t2.id FROM roster_team t2 WHERE t2.org_id = $1::bigint))
      ORDER BY p.full_name`, [org])).rows;

  const byTeam = new Map();
  for (const m of mem) {
    if (!byTeam.has(m.team_id)) byTeam.set(m.team_id, []);
    byTeam.get(m.team_id).push(m);
  }

  return {
    org_id: org,
    shifts: await shiftsOf(tx),
    teams: rows.map((t) => ({ ...t, member_list: byTeam.get(t.id) || [] })),
    kpi: {
      teams: rows.length,
      members: mem.length,
      empty: rows.filter((t) => Number(t.members) === 0).length,
      // 一个人只能在一个组，所以"人天"就是去重后的人数 —— 这里是全量人数，
      // 与上面 members 的差别只在于 members 是"关系行数"（同样一人一行）。
      people: new Set(mem.map((m) => m.employee_id)).size,
    },
  };
}

/** 建班组 */
export async function createTeam(tx, { userId, name, orgId }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const n = String(name || '').trim();
  if (!n || n.length > 96) throw bizErr('E_ARG_INVALID', '班组名称必填且不超过 96 字');
  if (!isId(Number(orgId))) throw bizErr('E_ARG_INVALID', 'org 必须是正整数（门店 org_unit.id）');

  const id = Number((await tx.query(
    `SELECT fn_team_create($1,$2,$3) id`, [n, Number(orgId), String(userId)])).rows[0].id);

  return { id, name: n, org_id: Number(orgId), members: 0,
           _log: { team: id, name: n, org: Number(orgId) } };
}

/**
 * 往班组加人。已在别组的人是**移动**（不是报错）——
 * 产品原话"以最后更新的班组为准"，见 150 头部第 ① 条。
 */
export async function addMembers(tx, { userId, teamId, employeeIds }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(teamId))) throw bizErr('E_ARG_INVALID', 'team 必须是正整数');
  const list = (Array.isArray(employeeIds) ? employeeIds : String(employeeIds || '').split(','))
    .map((v) => Number(v)).filter(isId);
  if (!list.length) throw bizErr('E_ARG_INVALID', '至少给一个人（employee / person.id）');

  const added = Number((await tx.query(
    `SELECT fn_team_add($1,$2::bigint[],$3) n`,
    [Number(teamId), list, String(userId)])).rows[0].n);

  // 回读组里现在有谁：移动过来的那些人原来在哪个组已经查不到了（那一行被改掉了），
  // 所以页面要在调用前自己记一下 oldTeam —— 这不是缺陷，是"一人一组"的必然结果。
  const members = (await tx.query(
    `SELECT m.employee_id, p.full_name
       FROM roster_team_member m JOIN person p ON p.id = m.employee_id
      WHERE m.team_id = $1 ORDER BY p.full_name`, [Number(teamId)])).rows;

  return { team_id: Number(teamId), added, members,
           _log: { team: Number(teamId), persons: list } };
}

/**
 * 整组排班：给全组某天排同一个班次。
 * ★ 返回 skipped 与 skipped_people —— 部分成功必须被看见，
 *   否则"11 成 1 跳"和"这组就 11 个人"在页面上长得一样。
 */
export async function assignTeam(tx, { userId, teamId, date, shift, storeId }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(teamId))) throw bizErr('E_ARG_INVALID', 'team 必须是正整数');
  if (!isDate(date)) throw bizErr('E_ARG_INVALID', 'date 写 YYYY-MM-DD');
  if (!isId(Number(storeId))) throw bizErr('E_ARG_INVALID', 'store 必须是正整数（门店 org_unit.id）');
  const s = String(shift || '').trim().toUpperCase();
  if (!s) throw bizErr('E_ARG_INVALID', 'shift 必填（班次码，见 shift_def）');

  const total = Number((await tx.query(
    `SELECT count(*)::int n FROM roster_team_member WHERE team_id = $1`,
    [Number(teamId)])).rows[0].n);

  const planned = Number((await tx.query(
    `SELECT fn_team_assign($1,$2::date,$3,$4,$5) n`,
    [Number(teamId), String(date), s, Number(storeId), String(userId)])).rows[0].n);

  // 回读"组里今天没有这个班的人"：不做这一步，skipped 只是一个数字，
  // 而操作员需要的是名字（他要单独去处理那个人）。
  const missed = (await tx.query(
    `SELECT m.employee_id, p.full_name
       FROM roster_team_member m
       JOIN person p ON p.id = m.employee_id
      WHERE m.team_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM schedule sc
           WHERE sc.employee_id = m.employee_id
             AND sc.work_date = $2::date
             AND sc.shift_id = (SELECT sd.shift_id FROM shift_def sd WHERE sd.code = $3))
      ORDER BY p.full_name`, [Number(teamId), String(date), s])).rows;

  return {
    team_id: Number(teamId), date: String(date), shift: s, store_id: Number(storeId),
    members: total, planned, skipped: total - planned, skipped_people: missed,
    _log: { team: Number(teamId), date: String(date), shift: s,
            store: Number(storeId), planned },
  };
}

/** 周期模板列表 */
export async function cycles(tx, { userId, orgId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  const org = orgId === undefined || orgId === null || orgId === '' ? null : Number(orgId);
  if (org !== null && !isId(org)) {
    throw bizErr('E_ARG_INVALID', 'org 必须是正整数（org_unit.id），不传 = 全部');
  }

  const rows = (await tx.query(
    `SELECT c.id, c.name, c.org_id, c.days, c.pattern, c.created_by, c.created_at,
            o.name AS org_name
       FROM roster_cycle c
       LEFT JOIN org_unit o ON o.id = c.org_id
      WHERE ($1::bigint IS NULL OR c.org_id = $1::bigint)
      ORDER BY c.org_id, c.name`, [org])).rows;

  return {
    org_id: org,
    shifts: await shiftsOf(tx),
    // pattern 在库里是 jsonb，PGlite/pg 都会给回 JS 对象 —— 这里不再 stringify，
    // 否则页面要 parse 两次（一次接口、一次自己写的）。
    cycles: rows,
  };
}

/**
 * 新建或覆盖周期模板。
 * @param {number|null} id 传了就整条覆盖（不是部分更新：pattern 与 days 必须一起对）
 * @param {Array|string} pattern [{"day":1,"shift":"EARLY"}, …] 或它的 JSON 字符串
 */
export async function setCycle(tx, { userId, id, name, orgId, pattern }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const n = String(name || '').trim();
  if (!n || n.length > 96) throw bizErr('E_ARG_INVALID', '周期名称必填且不超过 96 字');
  if (!isId(Number(orgId))) throw bizErr('E_ARG_INVALID', 'org 必须是正整数（门店 org_unit.id）');

  // pattern 从 query 上来时是一段 JSON 文本；形状不合法就在这里停，
  // 不把它当字符串塞进 jsonb（那样库里会抛 22P02，映射层只能当服务故障）。
  let pat = pattern;
  if (typeof pat === 'string') {
    try { pat = JSON.parse(pat); } catch {
      throw bizErr('E_ARG_INVALID', 'pattern 不是合法 JSON（形如 [{"day":1,"shift":"EARLY"}]）');
    }
  }
  if (!Array.isArray(pat) || pat.length < 2) {
    throw bizErr('E_ARG_INVALID', 'pattern 至少两项（周期长度 2..31 天）');
  }
  // 只做最浅的一层形状检查：day 连续、班次存在这些要看库（那里才是唯一判据）。
  for (const it of pat) {
    if (!it || !Number.isInteger(Number(it.day)) || typeof it.shift !== 'string') {
      throw bizErr('E_ARG_INVALID', 'pattern 每项要有整数 day 与字符串 shift');
    }
  }
  const clean = pat.map((it) => ({ day: Number(it.day), shift: String(it.shift).toUpperCase() }));

  const cid = Number((await tx.query(
    `SELECT fn_cycle_set($1::bigint,$2,$3,$4::jsonb,$5) id`,
    [id === undefined || id === null || id === '' ? null : Number(id),
      n, Number(orgId), JSON.stringify(clean), String(userId)])).rows[0].id);

  // 回读 days：它是从 pattern 推出来的（不是入参），页面要显示"7 天"就得读回来
  const row = (await tx.query(
    `SELECT id, name, org_id, days, pattern FROM roster_cycle WHERE id = $1`, [cid])).rows[0];

  return { ...row, _log: { cycle: cid, name: n, days: row?.days } };
}

/**
 * 套用周期：按 pattern 循环铺 from..to。
 * ★ 部分成功是正常结果（见 150 头部第 ③ 条），所以这里不抛错，
 *   把 planned / skipped / 逐日原因原样交出去。
 */
export async function applyCycle(tx, { userId, cycleId, employeeId, from, to, storeId }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(cycleId))) throw bizErr('E_ARG_INVALID', 'cycle 必须是正整数');
  if (!isId(Number(employeeId))) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (!isId(Number(storeId))) throw bizErr('E_ARG_INVALID', 'store 必须是正整数（门店 org_unit.id）');
  if (!isDate(from) || !isDate(to)) throw bizErr('E_ARG_INVALID', 'from / to 写 YYYY-MM-DD');

  const r = (await tx.query(
    `SELECT planned, skipped, skip_reason FROM fn_cycle_apply($1,$2,$3::date,$4::date,$5,$6)`,
    [Number(cycleId), Number(employeeId), String(from), String(to),
      Number(storeId), String(userId)])).rows[0];

  // "07-03 已请假；07-07 已锁定" → [{date:'07-03', reason:'已请假'}, …]
  const items = (r?.skip_reason || '')
    .split('；')
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d{2}-\d{2})\s+(.*)$/.exec(s.trim());
      return m ? { day: m[1], reason: m[2] } : { day: null, reason: s.trim() };
    });

  return {
    cycle_id: Number(cycleId), employee_id: Number(employeeId),
    from: String(from), to: String(to), store_id: Number(storeId),
    planned: Number(r?.planned ?? 0),
    skipped: Number(r?.skipped ?? 0),
    skip_reason: r?.skip_reason ?? null,
    items,
    _log: { cycle: Number(cycleId), person: Number(employeeId),
            from: String(from), to: String(to), planned: Number(r?.planned ?? 0),
            skipped: Number(r?.skipped ?? 0) },
  };
}
