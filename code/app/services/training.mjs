// ============================================================================
// app/services/training.mjs · 培训学习（144）
// ----------------------------------------------------------------------------
// 这一层只做四件事：看板、建课程、开场次、报名与记学时。
// 所有判断都在库里（学时不够不结业、结业不可改、容量不自动扩容）——
// 这里不重复一遍规则：JS 里再判一次，就有两个地方会漂。
//
// ★ 一件刻意的设计：**没有"点通过"这个接口**。
//   结业由 fn_training_attend 按"到场学时 >= 课程标准学时"判定。
//   一旦开了"人工通过"，这个字段迟早全是"通过"，而它是要拿去应付检查的。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'employee_roster', write: 'employee_roster' };

const CATS = ['safety', 'onboarding', 'skill', 'compliance'];
const isId = (v) => Number.isInteger(v) && v > 0;

/**
 * 看板：课程 + 场次（含报名统计）+ 年度学时缺口。
 * @param {number} year 统计年度（默认业务年度）
 */
export async function board(tx, { userId, entityId, year }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(entityId)) throw bizErr('E_ARG_INVALID', 'entity 必须是正整数（发薪法人）');

  const y = Number(year) || Number((await tx.query(
    `SELECT EXTRACT(year FROM app_today()) y`)).rows[0].y);

  const canWrite = (await tx.query(
    `SELECT fn_role_can($1,$2,'write') o`, [userId, RESOURCES.write])).rows[0].o;

  const courses = (await tx.query(
    `SELECT c.id, c.code, c.name, c.category, c.std_hours, c.is_statutory,
            c.valid_months, c.note, c.is_active,
            (SELECT count(*)::int FROM training_session s WHERE s.course_id = c.id) AS sessions,
            (SELECT count(*)::int FROM training_enrollment e
               JOIN training_session s ON s.id = e.session_id
              WHERE s.course_id = c.id AND e.status = 'completed') AS completed
       FROM training_course c
      ORDER BY c.is_statutory DESC, c.category, c.name`)).rows;

  const sessions = (await tx.query(
    // ★ 时间在库里按业务时区格式化：直接把 timestamptz 传到 JS 再拼字符串，
    //   `String(Date)` 给的是 "Fri Mar 05 2026 …"，切片切到的是日期不是时分 ——
    //   而"14:00 的培训显示 00:00"是会被当成排班错的。
    `SELECT s.id, s.course_id, c.name AS course_name, c.category, c.std_hours,
            s.starts_at, s.ends_at, s.hours, s.trainer, s.place, s.capacity, s.status,
            to_char(s.starts_at AT TIME ZONE app_tz(), 'HH24:MI') AS start_hm,
            to_char(s.starts_at AT TIME ZONE app_tz(), 'YYYY-MM-DD') AS start_day,
            (SELECT count(*)::int FROM training_enrollment e
              WHERE e.session_id = s.id AND e.status <> 'cancelled') AS enrolled,
            (SELECT count(*)::int FROM training_enrollment e
              WHERE e.session_id = s.id AND e.status = 'completed') AS completed
       FROM training_session s JOIN training_course c ON c.id = s.course_id
      WHERE s.legal_entity_id = $1 AND EXTRACT(year FROM s.starts_at) = $2
      ORDER BY s.starts_at DESC`, [entityId, y])).rows;

  const gap = (await tx.query('SELECT * FROM fn_training_gap($1,$2)', [entityId, y])).rows;

  const need = Number((await tx.query(
    `SELECT COALESCE(value_num,0) n FROM fn_policy_effective('TRAINING_MIN_HOURS_YEAR',NULL,$1)`,
    [`${y}-12-31`])).rows[0].n);

  // 人员年度学时（含已结业的明细），给页面"谁学了多少"用
  const people = (await tx.query(
    `SELECT em.person_id, pe.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            public.fn_training_hours(em.person_id, $2) AS hours,
            (SELECT count(*)::int FROM training_enrollment e
               JOIN training_session s ON s.id = e.session_id
              WHERE e.employee_id = em.person_id AND e.status = 'completed'
                AND EXTRACT(year FROM s.starts_at) = $2) AS courses
       FROM employment em JOIN person pe ON pe.id = em.person_id
      WHERE em.legal_entity_id = $1
        AND daterange(em.hire_date, em.leave_date, '[]') @> make_date($2, 12, 31)
      ORDER BY public.fn_training_hours(em.person_id, $2) DESC, pe.full_name`,
    [entityId, y])).rows;

  return {
    year: y, entity: entityId, need_hours: need, canWrite,
    courses, sessions, gap, people,
    kpi: {
      courses: courses.length,
      statutory: courses.filter((c) => c.is_statutory).length,
      sessions: sessions.length,
      planned: sessions.filter((s) => s.status === 'planned').length,
      enrolled: sessions.reduce((a, s) => a + Number(s.enrolled), 0),
      completed: sessions.reduce((a, s) => a + Number(s.completed), 0),
      gapPeople: gap.length,
      // 达标 = 有学时要求时，缺口为 0 的人 / 总人数
      okRate: need > 0 && people.length
        ? Math.round((people.length - gap.length) / people.length * 100) : null,
    },
  };
}

/** 建课程 */
export async function createCourse(tx, { userId, code, name, category, stdHours,
  statutory, validMonths, note }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  const c = String(code || '').trim();
  const n = String(name || '').trim();
  if (!c || c.length > 32) throw bizErr('E_ARG_INVALID', '课程编码必填且不超过 32 字');
  if (!n) throw bizErr('E_ARG_INVALID', '课程名称必填');
  if (!CATS.includes(String(category))) {
    throw bizErr('E_ARG_INVALID', `课程类别只能是 ${CATS.join(' / ')}`);
  }
  const h = Number(stdHours);
  if (!Number.isFinite(h) || h <= 0) throw bizErr('E_ARG_INVALID', '标准学时必须大于 0');

  const id = Number((await tx.query(
    `INSERT INTO training_course(code,name,category,std_hours,is_statutory,valid_months,note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [c, n, String(category), h, !!statutory,
      validMonths ? Number(validMonths) : null, String(note || '').trim() || null])).rows[0].id);
  return { id, code: c, _log: { course: id, code: c, hours: h } };
}

/** 开场次 */
export async function createSession(tx, { userId, courseId, entityId, date,
  fromTime, toTime, hours, trainer, place, capacity }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(courseId)) throw bizErr('E_ARG_INVALID', 'course 必须是正整数');
  if (!isId(entityId)) throw bizErr('E_ARG_INVALID', 'entity 必须是正整数');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw bizErr('E_ARG_INVALID', '日期写 YYYY-MM-DD');
  }
  const t1 = String(fromTime || '09:00');
  const t2 = String(toTime || '12:00');
  if (!/^\d{2}:\d{2}$/.test(t1) || !/^\d{2}:\d{2}$/.test(t2)) {
    throw bizErr('E_ARG_INVALID', '时间写 HH:MM');
  }
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) throw bizErr('E_ARG_INVALID', '本场学时必须大于 0');

  const id = Number((await tx.query(
    `INSERT INTO training_session(course_id,legal_entity_id,starts_at,ends_at,hours,
       trainer,place,capacity,created_by)
     VALUES ($1,$2, ($3 || ' ' || $4)::timestamp AT TIME ZONE app_tz(),
                  ($3 || ' ' || $5)::timestamp AT TIME ZONE app_tz(),
             $6,$7,$8,$9,$10) RETURNING id`,
    [courseId, entityId, String(date), t1, t2, h,
      String(trainer || '').trim() || null, String(place || '').trim() || null,
      capacity ? Number(capacity) : null, String(userId)])).rows[0].id);
  return { id, _log: { session: id, course: courseId, hours: h } };
}

/** 报名（可一次报一批） */
export async function enroll(tx, { userId, sessionId, employeeIds }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(sessionId)) throw bizErr('E_ARG_INVALID', 'session 必须是正整数');
  const list = (Array.isArray(employeeIds) ? employeeIds : [employeeIds])
    .map(Number).filter(isId);
  if (!list.length) throw bizErr('E_ARG_INVALID', '至少给一个人（person.id）');

  const ids = [];
  for (const emp of list) {
    ids.push(Number((await tx.query(
      `SELECT fn_training_enroll($1,$2,$3) i`, [sessionId, emp, String(userId)])).rows[0].i));
  }
  return { session_id: sessionId, enrolled: ids, count: ids.length,
           _log: { session: sessionId, persons: ids.length } };
}

/**
 * 记到场学时。不给 hours 就用本场学时。
 * ★ 返回值可能是 attended（学时不够）或 completed —— 页面据此显示"还差几学时"，
 *   而不是笼统地报"成功"。
 */
export async function attend(tx, { userId, enrollId, hours }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(enrollId)) throw bizErr('E_ARG_INVALID', 'enroll 必须是正整数');
  const h = hours === null || hours === undefined || hours === '' ? null : Number(hours);
  if (h !== null && !Number.isFinite(h)) throw bizErr('E_ARG_INVALID', '学时必须是数字');

  const st = String((await tx.query(
    `SELECT fn_training_attend($1,$2,$3) s`, [enrollId, h, String(userId)])).rows[0].s);

  // 回读差额：页面要说"还差 4 学时"，而不是只说"未结业"
  const d = (await tx.query(
    `SELECT e.attended_hours, c.std_hours, c.name,
            GREATEST(c.std_hours - COALESCE(e.attended_hours,0), 0) AS missing
       FROM training_enrollment e
       JOIN training_session s ON s.id = e.session_id
       JOIN training_course c ON c.id = s.course_id
      WHERE e.id = $1`, [enrollId])).rows[0];
  return {
    enroll_id: enrollId, status: st,
    attended_hours: d?.attended_hours ?? null,
    std_hours: d?.std_hours ?? null,
    missing_hours: Number(d?.missing ?? 0),
    _log: { enroll: enrollId, hours: h, status: st },
  };
}

/** 一个人的培训明细（课程 / 学时 / 结业时间） */
export async function detail(tx, { userId, personId, year }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(personId)) throw bizErr('E_ARG_INVALID', 'person 必须是正整数');
  const y = Number(year) || Number((await tx.query(
    `SELECT EXTRACT(year FROM app_today()) y`)).rows[0].y);

  const rows = (await tx.query(
    `SELECT c.name AS course_name, c.category, c.std_hours,
            s.starts_at, s.hours AS session_hours, s.trainer,
            e.id AS enroll_id, e.status, e.attended_hours, e.completed_at
       FROM training_enrollment e
       JOIN training_session s ON s.id = e.session_id
       JOIN training_course c ON c.id = s.course_id
      WHERE e.employee_id = $1 AND EXTRACT(year FROM s.starts_at) = $2
      ORDER BY s.starts_at DESC`, [personId, y])).rows;

  return { person: personId, year: y, rows,
           hours: Number((await tx.query(
             `SELECT fn_training_hours($1,$2) h`, [personId, y])).rows[0].h) };
}
