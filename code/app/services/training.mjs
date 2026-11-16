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
import { requireSession, requireOrg } from './guard.mjs';
import { inStationScope } from './scope.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'employee_roster', write: 'employee_roster' };

const CATS = ['safety', 'onboarding', 'skill', 'compliance'];
const isId = (v) => Number.isInteger(v) && v > 0;

// The session belongs to a payroll entity. People are additionally constrained
// by the existing cost/station roster scope on that session's business date.
// Never aggregate a person's unrestricted training history after a current-only
// visibility check: employees may have moved between stores or employers.
const entityVisible = entity => `EXISTS (SELECT 1 FROM pg_temp.tmp_scope_entity se
  WHERE se.dim_code='payroll_legal_entity' AND se.entity_id=${entity})
  AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny sd
    WHERE sd.dim_code='payroll_legal_entity' AND sd.entity_id=${entity})`;
const personVisible = (person, on, entity, user) => `${entityVisible(entity)}
  AND ${inStationScope(person,user,on)}
  AND EXISTS (SELECT 1 FROM employment em_scope WHERE em_scope.person_id=${person}
    AND em_scope.legal_entity_id=${entity}
    AND daterange(em_scope.hire_date,em_scope.leave_date,'[]') @> ${on})`;
const sessionDay = alias => `(${alias}.starts_at AT TIME ZONE app_tz())::date`;
async function businessYear(tx,year) {
  const y=year===undefined||year===null||year===''?Number((await tx.query('SELECT EXTRACT(year FROM app_today()) y')).rows[0].y):Number(year);
  if(!Number.isInteger(y)||y<1900||y>9998)throw bizErr('E_ARG_INVALID','year 必须是有效四位年份');
  return y;
}
async function requireEntity(tx,userId,entityId,action='read') {
  await requireOrg(tx,{userId,resource:RESOURCES.read,orgId:entityId,dim:'payroll_legal_entity',action});
}
async function sessionFor(tx,userId,sessionId,action='write') {
  const s=(await tx.query(`SELECT s.*,${sessionDay('s')} AS business_date FROM training_session s WHERE id=$1`,[sessionId])).rows[0];
  if(!s)throw bizErr('E_TR_NO_SESSION','培训场次不存在或不在授权范围');
  await requireEntity(tx,userId,Number(s.legal_entity_id),action);
  return s;
}
async function requirePersonAtSession(tx,userId,personId,sessionId) {
  const ok=(await tx.query(`SELECT EXISTS(SELECT 1 FROM training_session s WHERE s.id=$1
    AND ${personVisible('$2::bigint',sessionDay('s'),'s.legal_entity_id','$3')}) ok`,[sessionId,personId,userId])).rows[0].ok;
  if(!ok)throw bizErr('E_OUT_OF_SCOPE','人员在培训日期不属于本场次主体或不在当前授权范围');
}

/** 主体选择器与培训同用花名册角色，不要求算薪岗位。 */
export async function entities(tx,{userId}) {
  await requireSession(tx,{userId,resource:RESOURCES.read,action:'read'});
  const rows=(await tx.query(`SELECT DISTINCT s.entity_id AS id,
    COALESCE(l.name,'发薪主体 '||s.entity_id::text) AS name
    FROM pg_temp.tmp_scope_entity s LEFT JOIN legal_entity l ON l.id=s.entity_id
    WHERE s.dim_code='payroll_legal_entity' AND ${entityVisible('s.entity_id')}
    ORDER BY id`)).rows;
  return {rows};
}

/** 看板只累计所选主体、所选年度及场次日期可见人员。 */
export async function board(tx, { userId, entityId, year }) {
  await requireSession(tx,{userId,resource:RESOURCES.read,action:'read'});
  if(!isId(entityId))throw bizErr('E_ARG_INVALID','entity 必须是正整数（发薪法人）');
  await requireEntity(tx,userId,entityId);
  const y=await businessYear(tx,year);
  const canWrite=!!(await tx.query(`SELECT fn_role_can($1,$2,'write') o`,[userId,RESOURCES.write])).rows[0].o;
  const inYear=`EXTRACT(year FROM s.starts_at AT TIME ZONE app_tz())=$2`;
  const visibleEnrollment=personVisible('e.employee_id',sessionDay('s'),'s.legal_entity_id','$3');
  const courses=(await tx.query(`SELECT c.id,c.code,c.name,c.category,c.std_hours,c.is_statutory,
    c.valid_months,c.note,c.is_active,
    (SELECT count(*)::int FROM training_session s WHERE s.course_id=c.id AND s.legal_entity_id=$1 AND ${inYear}) AS sessions,
    (SELECT count(*)::int FROM training_enrollment e JOIN training_session s ON s.id=e.session_id
      WHERE s.course_id=c.id AND s.legal_entity_id=$1 AND ${inYear} AND e.status='completed' AND ${visibleEnrollment}) AS completed
    FROM training_course c ORDER BY c.is_statutory DESC,c.category,c.name`,[entityId,y,userId])).rows;
  const sessions=(await tx.query(`SELECT s.id,s.course_id,c.name AS course_name,c.category,c.std_hours,
    s.starts_at,s.ends_at,s.hours,s.trainer,s.place,s.capacity,s.status,
    to_char(s.starts_at AT TIME ZONE app_tz(),'HH24:MI') AS start_hm,
    to_char(s.starts_at AT TIME ZONE app_tz(),'YYYY-MM-DD') AS start_day,
    (SELECT count(*)::int FROM training_enrollment e WHERE e.session_id=s.id AND e.status<>'cancelled' AND ${visibleEnrollment}) AS enrolled,
    (SELECT count(*)::int FROM training_enrollment e WHERE e.session_id=s.id AND e.status='completed' AND ${visibleEnrollment}) AS completed
    FROM training_session s JOIN training_course c ON c.id=s.course_id
    WHERE s.legal_entity_id=$1 AND ${inYear} ORDER BY s.starts_at DESC`,[entityId,y,userId])).rows;
  const need=Number((await tx.query(`SELECT COALESCE(value_num,0) n FROM fn_policy_effective('TRAINING_MIN_HOURS_YEAR',NULL,$1)`,[`${y}-12-31`])).rows[0]?.n||0);
  const people=(await tx.query(`WITH visible_training AS (
    SELECT e.* FROM training_enrollment e JOIN training_session s ON s.id=e.session_id
    WHERE s.legal_entity_id=$1 AND ${inYear} AND e.status='completed' AND ${visibleEnrollment}
  ) SELECT DISTINCT em.person_id,pe.full_name,
    (SELECT n.no FROM employee_no n WHERE n.assigned_person_id=pe.id AND n.retired_at IS NULL ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
    COALESCE((SELECT sum(v.attended_hours) FROM visible_training v WHERE v.employee_id=em.person_id),0) AS hours,
    (SELECT count(*)::int FROM visible_training v WHERE v.employee_id=em.person_id) AS courses
    FROM employment em JOIN person pe ON pe.id=em.person_id
    WHERE em.legal_entity_id=$1 AND daterange(em.hire_date,em.leave_date,'[]') @> make_date($2::int,12,31)
    AND ${personVisible('em.person_id','make_date($2::int,12,31)','em.legal_entity_id','$3')}
    ORDER BY hours DESC,pe.full_name`,[entityId,y,userId])).rows;
  const gap=need>0?people.filter(p=>Number(p.hours)<need).map(p=>({employee_id:p.person_id,person_name:p.full_name,employee_no:p.employee_no,
    got_hours:p.hours,need_hours:need,gap_hours:need-Number(p.hours)})):[];
  return {year:y,entity:entityId,need_hours:need,canWrite,courses,sessions,gap,people,
    scope_notice:'仅统计所选主体及培训日期在授权范围的人员；共享课程目录不代表可查看其他主体培训记录。',
    kpi:{courses:courses.length,statutory:courses.filter(c=>c.is_statutory).length,sessions:sessions.length,
      planned:sessions.filter(s=>s.status==='planned').length,enrolled:sessions.reduce((a,s)=>a+Number(s.enrolled),0),
      completed:sessions.reduce((a,s)=>a+Number(s.completed),0),gapPeople:gap.length,
      okRate:need>0&&people.length?Math.round((people.length-gap.length)/people.length*100):null}};
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
  await requireEntity(tx,userId,entityId,'write');
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
  const list = (Array.isArray(employeeIds) ? employeeIds : [employeeIds]).map(Number);
  if (!list.length||list.some(v=>!isId(v))) throw bizErr('E_ARG_INVALID', '请明确有效人员编号（person.id）');
  await sessionFor(tx,userId,sessionId);
  // Check the whole request before the first enrollment is written.
  for(const emp of list)await requirePersonAtSession(tx,userId,emp,sessionId);

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
  const target=(await tx.query('SELECT session_id,employee_id FROM training_enrollment WHERE id=$1',[enrollId])).rows[0];
  if(!target)throw bizErr('E_TR_NOT_FOUND','报名记录不存在或不在授权范围');
  await sessionFor(tx,userId,Number(target.session_id));
  await requirePersonAtSession(tx,userId,Number(target.employee_id),Number(target.session_id));
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

/** 逐场次日期判断范围，不能由当前雇佣授权贯通无权历史。 */
export async function detail(tx,{userId,personId,year}) {
  await requireSession(tx,{userId,resource:RESOURCES.read,action:'read'});
  if(!isId(personId))throw bizErr('E_ARG_INVALID','person 必须是正整数');
  const y=await businessYear(tx,year);
  // A visible employee with no enrollment still has a valid empty detail. Check
  // relevant employment/assignment boundary dates rather than only today.
  const allowed=(await tx.query(`WITH boundary AS (
    SELECT e.legal_entity_id,greatest(e.hire_date,make_date($2::int,1,1)) AS d FROM employment e
    WHERE e.person_id=$1 AND daterange(e.hire_date,e.leave_date,'[]') && daterange(make_date($2::int,1,1),make_date($2::int,12,31),'[]')
    UNION SELECT e.legal_entity_id,greatest(e.hire_date,a.valid_from,make_date($2::int,1,1)) FROM employment e
    JOIN employee_org_assignment a ON a.employee_id=e.person_id AND a.dim_code='cost_org'
    WHERE e.person_id=$1 AND daterange(e.hire_date,e.leave_date,'[]') && daterange(a.valid_from,a.valid_to,'[]')
      AND daterange(a.valid_from,a.valid_to,'[]') && daterange(make_date($2::int,1,1),make_date($2::int,12,31),'[]')
  ) SELECT EXISTS(SELECT 1 FROM boundary b WHERE b.d<=make_date($2::int,12,31)
    AND ${personVisible('$1::bigint','b.d','b.legal_entity_id','$3')}) ok`,[personId,y,userId])).rows[0].ok;
  if(!allowed)throw bizErr('E_OUT_OF_SCOPE','人员在指定年度不在培训授权范围');
  const rows=(await tx.query(`SELECT c.name AS course_name,c.category,c.std_hours,
    s.starts_at,s.hours AS session_hours,s.trainer,e.id AS enroll_id,e.status,e.attended_hours,e.completed_at
    FROM training_enrollment e JOIN training_session s ON s.id=e.session_id JOIN training_course c ON c.id=s.course_id
    WHERE e.employee_id=$1 AND EXTRACT(year FROM s.starts_at AT TIME ZONE app_tz())=$2
      AND ${personVisible('e.employee_id',sessionDay('s'),'s.legal_entity_id','$3')}
    ORDER BY s.starts_at DESC`,[personId,y,userId])).rows;
  return {person:personId,year:y,rows,hours:rows.filter(r=>r.status==='completed').reduce((sum,r)=>sum+Number(r.attended_hours),0)};
}
