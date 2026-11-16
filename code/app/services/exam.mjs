// ============================================================================
// app/services/exam.mjs · 培训考试（147）
// ----------------------------------------------------------------------------
// 这一层只做五件事：看卷、建卷、发卷、交卷、看成绩。
// 判分、及格线、交卷后的锁、结业联动 —— **全在库里**（fn_exam_submit /
// fn_exam_paper_for / fn_training_attend）。这里不重复一遍规则：
// JS 里再算一次分，就有两个地方会漂，而漂的那天没人会去核对分数。
//
// ★ 一件刻意的设计：**没有"改分数"和"点通过"的接口。**
//   分数由 fn_exam_submit 从 exam_question.answer 算出来。开一个改分的口子，
//   这个分数就不能拿去应付监管检查 —— 而它存在的全部理由就是这个。
//
// ★ 第二件：**卷面结构里没有答案。**
//   paper() 走 fn_exam_paper_for，它没有 answer 列。答案只在交卷之后、
//   看自己那份成绩明细时才随 result() 出去（错题回顾要有正确答案）。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
import { accountPerson,personaFor,trainingPersonAccess,trainingAttemptAccess,trainingPaperAccess } from './persona-guard.mjs';

export const RESOURCES = { read: 'training_manage', write: 'training_manage' };

const KINDS = ['single', 'multi', 'judge'];
const isId = (v) => Number.isInteger(v) && v > 0;
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * 试卷清单：谁在用、几道题、考了多少人、及格率。
 */
export async function board(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });

  const papers = (await tx.query(
    `SELECT p.id, p.code, p.name, p.pass_score, p.is_active, p.note,
            p.duration_min, p.max_attempts,
            c.id AS course_id, c.name AS course_name, c.category, c.std_hours,
            (SELECT count(*)::int FROM exam_question q WHERE q.paper_id = p.id) AS questions,
            (SELECT COALESCE(sum(q.score), 0) FROM exam_question q WHERE q.paper_id = p.id) AS total_score,
            (SELECT count(*)::int FROM exam_attempt a WHERE a.paper_id = p.id AND fn_ty_training_person_visible($1,a.employee_id,(a.started_at AT TIME ZONE app_tz())::date)) AS attempts,
            (SELECT count(*)::int FROM exam_attempt a
              WHERE a.paper_id = p.id AND fn_ty_training_person_visible($1,a.employee_id,(a.started_at AT TIME ZONE app_tz())::date) AND a.passed) AS passed,
            -- 发出去还没交的卷：这个数大说明有人在挂着，不是"考得慢"就是"忘了"
            (SELECT count(*)::int FROM exam_attempt a
              WHERE a.paper_id = p.id AND fn_ty_training_person_visible($1,a.employee_id,(a.started_at AT TIME ZONE app_tz())::date) AND a.submitted_at IS NULL) AS open_attempts,
            -- 超时交的卷：156 只记不拦，所以这个数要能看见，否则"记了没人看"等于没记
            (SELECT count(*)::int FROM exam_attempt a
              WHERE a.paper_id = p.id AND fn_ty_training_person_visible($1,a.employee_id,(a.started_at AT TIME ZONE app_tz())::date) AND COALESCE(a.late_seconds, 0) > 0) AS late_count
       FROM exam_paper p JOIN training_course c ON c.id = p.course_id
      ORDER BY p.is_active DESC, c.name, p.code`,[userId])).rows;

  // 及格率的分母是"交过卷的"，不是"发过的卷"：
  // 把没交的算进去会让及格率看起来低，而那是"还没考"，不是"考不过"。
  return {
    papers: papers.map((p) => ({
      ...p,
      pass_score: num(p.pass_score),
      total_score: num(p.total_score),
      pass_rate: p.attempts
        ? Math.round(Number(p.passed) / Number(p.attempts) * 100) : null,
    })),
    kpi: {
      papers: papers.length,
      active: papers.filter((p) => p.is_active).length,
      attempts: papers.reduce((a, p) => a + Number(p.attempts), 0),
      passed: papers.reduce((a, p) => a + Number(p.passed), 0),
      late: papers.reduce((a, p) => a + Number(p.late_count), 0),
      open: papers.reduce((a, p) => a + Number(p.open_attempts), 0),
    },
  };
}

/**
 * 考试台账：某人某卷还剩几次、最高分、上次超时多久（156）。
 * ★ 这张表的用处只有一个 —— **在开考之前**回答"我还能考吗"。
 *   让人答完 100 分的卷才被告知"你已经没机会了"，比一开始就不让他考更糟。
 */
export async function ledger(tx, { userId, paperId, employeeId }) {
  await trainingPersonAccess(tx,{userId,personId:employeeId,action:'read'});
  if (!isId(paperId)) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');

  const r = (await tx.query(
    `SELECT * FROM fn_exam_ledger($1,$2)`, [paperId, employeeId])).rows[0];
  if (!r) throw bizErr('E_EXAM_NO_PAPER', `试卷 ${paperId} 不存在`);
  return {
    paper_id: r.paper_id, paper_name: r.paper_name,
    pass_score: num(r.pass_score), max_attempts: r.max_attempts ?? null,
    used: Number(r.used), left_attempts: r.left_attempts ?? null,
    best_score: num(r.best_score), passed: r.passed,
    last_submitted: r.last_submitted,
    last_late_seconds: r.last_late_seconds ?? null,
  };
}

/**
 * 建卷：卷子与题目一起写，一个事务里要么都成、要么都不成。
 * @param {Array<{seq?:number,kind:string,stem:string,options?:Array,answer:string,score:number}>} questions
 */
export async function createPaper(tx, { userId, courseId, code, name,
  passScore, isActive, note, questions, durationMin, maxAttempts }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(courseId)) throw bizErr('E_ARG_INVALID', 'course 必须是正整数（课程 id）');
  const c = String(code || '').trim();
  const n = String(name || '').trim();
  if (!c || c.length > 32) throw bizErr('E_ARG_INVALID', '试卷编码必填且不超过 32 字');
  if (!n) throw bizErr('E_ARG_INVALID', '试卷名称必填');
  const ps = Number(passScore);
  if (!Number.isFinite(ps) || ps <= 0) throw bizErr('E_ARG_INVALID', '及格线必须大于 0');
  if (!Array.isArray(questions) || questions.length === 0) {
    // 0 题的卷子判出来是 0 分，看着"没通过"，实际是卷子没建完
    throw bizErr('E_ARG_INVALID', '至少要有 1 道题（0 题的卷子判不出分）');
  }

  const id = Number((await tx.query(
    `INSERT INTO exam_paper(course_id,code,name,pass_score,is_active,note,
                            duration_min,max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [courseId, c, n, ps, isActive !== false, String(note || '').trim() || null,
      // 不传就是"不限时 / 不限次"，不用 0 表示无限 —— 0 分钟是个合法的时限，
      // 混用之后"限时 0"与"不限时"在库里长得一样，而它们的后果差得远。
      Number.isFinite(Number(durationMin)) && Number(durationMin) > 0
        ? Math.trunc(Number(durationMin)) : null,
      Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) > 0
        ? Math.trunc(Number(maxAttempts)) : null],
  )).rows[0].id);

  // 逐题写。seq 不传就按顺序给 —— 顺序是卷面的事实，不能靠调用方记得填。
  let i = 0;
  for (const q of questions) {
    i += 1;
    const kind = String(q?.kind || '').trim();
    if (!KINDS.includes(kind)) {
      throw bizErr('E_ARG_INVALID', `第 ${i} 题的 kind 只能是 ${KINDS.join(' / ')}`);
    }
    const stem = String(q?.stem || '').trim();
    if (!stem) throw bizErr('E_ARG_INVALID', `第 ${i} 题缺题干`);
    const sc = Number(q?.score);
    if (!Number.isFinite(sc) || sc <= 0) {
      throw bizErr('E_ARG_INVALID', `第 ${i} 题的分值必须大于 0`);
    }
    // 答案的**形状**交给库里判（fn_exam_norm / ck_eq_ans 会给 E_EXAM_BAD_ANSWER）：
    // 这里再写一遍校验，就有两个地方判断"什么算合法答案"。
    const options = kind === 'judge' && (!Array.isArray(q?.options) || !q.options.length)
      ? [] : (q?.options ?? []);
    await tx.query(
      `INSERT INTO exam_question(paper_id,seq,kind,stem,options,answer,score)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [id, Number(q?.seq) || i, kind, stem, JSON.stringify(options),
        String(q?.answer ?? ''), sc]);
  }

  return {
    id, code: c, questions: i,
    total_score: num((await tx.query(
      `SELECT sum(score) s FROM exam_question WHERE paper_id = $1`, [id])).rows[0].s),
    _log: { paper: id, code: c, questions: i },
  };
}

/**
 * 卷面：给考生看的那一份。
 * ★ 只有题干/选项/分值，**没有答案** —— 答案随卷下发，这场考试就没有意义了。
 */
export async function paper(tx, { userId, paperId }) {
  await trainingPaperAccess(tx,{userId});
  if (!isId(paperId)) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');

  const rows = (await tx.query(
    `SELECT * FROM fn_exam_paper_for($1)`, [paperId])).rows;
  if (!rows.length) throw bizErr('E_EXAM_NO_PAPER', `试卷 ${paperId} 不存在`);

  const head = rows[0];
  // 限时/限次不在 fn_exam_paper_for 的返回列里（它是"卷面"，管的是题目）。
  // 这两个数是**规则**，所以要单独读一次 —— 顺手把"这道卷的总分"也一起对齐。
  const rule = (await tx.query(
    `SELECT duration_min, max_attempts FROM exam_paper WHERE id = $1`,
    [paperId])).rows[0];

  return {
    id: head.paper_id, code: head.paper_code, name: head.paper_name,
    pass_score: num(head.pass_score),
    duration_min: rule.duration_min ?? null,
    max_attempts: rule.max_attempts ?? null,
    total_score: rows.reduce((a, r) => a + Number(r.score || 0), 0),
    questions: rows.filter((r) => r.question_id).map((r) => ({
      id: r.question_id, seq: r.seq, kind: r.kind, stem: r.stem,
      options: r.options, score: num(r.score),
    })),
  };
}

/** 发卷：返回 attempt id。同一人同一卷已有未交的一份时，返回的仍是那一份。 */
export async function start(tx, { userId, paperId, employeeId, sessionId }) {
  await trainingPersonAccess(tx,{userId,personId:employeeId,action:'write'});
  if (!isId(paperId)) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');
  if (!isId(employeeId)) throw bizErr('E_ARG_INVALID', 'employee 必须是正整数（person.id）');
  if (sessionId !== null && sessionId !== undefined && sessionId !== ''
      && !isId(Number(sessionId))) {
    throw bizErr('E_ARG_INVALID', 'session 必须是正整数（场次 id）');
  }

  if(sessionId&&await personaFor(tx,userId)) {
    const enrollment=(await tx.query(`SELECT 1 FROM training_enrollment e JOIN training_session s ON s.id=e.session_id
      JOIN exam_paper p ON p.course_id=s.course_id WHERE e.session_id=$1 AND e.employee_id=$2 AND p.id=$3 AND e.status<>'cancelled'`,[Number(sessionId),employeeId,paperId])).rows[0];
    if(!enrollment)throw bizErr('E_RESOURCE_FORBIDDEN','场次必须是该员工已报名的对应课程');
  }
  const attemptId = Number((await tx.query(
    `SELECT fn_exam_start($1,$2,$3) i`,
    [paperId, employeeId, sessionId ? Number(sessionId) : null])).rows[0].i);

  const a = (await tx.query(
    `SELECT id, paper_id, employee_id, started_at, submitted_at, deadline_at
       FROM exam_attempt WHERE id = $1`, [attemptId])).rows[0];
  // 剩余次数一起回去：前端要能立刻显示"这是最后一次机会"，
  // 而不是等交完卷才从报错里知道。
  const lg = (await tx.query(
    `SELECT left_attempts, used, best_score, max_attempts FROM fn_exam_ledger($1,$2)`,
    [paperId, employeeId])).rows[0];

  return {
    attempt_id: attemptId, paper_id: paperId, employee_id: employeeId,
    started_at: a.started_at, deadline_at: a.deadline_at ?? null,
    submitted: a.submitted_at !== null,
    // ★ 用"第几次 / 共几次"表述，不用"还剩几次"：
    //   开考那一刻"还剩 1 次"指的就是手上这一份，读起来像还能再考一次。
    attempt_no: lg ? Number(lg.used) + 1 : null,
    max_attempts: lg?.max_attempts ?? null,
    used: lg ? Number(lg.used) : null,
    left_attempts: lg?.left_attempts ?? null,
    best_score: num(lg?.best_score),
    _log: { attempt: attemptId, paper: paperId, person: employeeId },
  };
}

/**
 * 交卷并判分。answers 只要"我选了什么"：
 *   [{ q: <question_id>, picked: 'A' }]  或 picked: 'A,C'（多选）、'A'/'B'（判断）
 * picked 省略 = 没答（0 分）。**不传分数** —— 传了库里也不看。
 * ★ 多选必须完全一致才得分：选一半给 0。给部分分等于让人"全选"攒到及格线。
 */
export async function submit(tx, { userId, attemptId, answers }) {
  await trainingAttemptAccess(tx,{userId,attemptId,action:'write'});
  if (!isId(attemptId)) throw bizErr('E_ARG_INVALID', 'attempt 必须是正整数');
  if (!Array.isArray(answers)) {
    throw bizErr('E_ARG_INVALID', 'answers 要是数组，形如 [{q:1,picked:"A"}]');
  }

  const r = (await tx.query(
    `SELECT * FROM fn_exam_submit($1,$2::jsonb)`,
    [attemptId, JSON.stringify(answers)])).rows[0];

  // 回读每题结果：页面要显示"哪题错了"，而不只是"你没过"
  const detail = (await tx.query(
    `SELECT a.question_id, q.seq, q.kind, a.picked, a.score, q.score AS full_score
       FROM exam_answer a JOIN exam_question q ON q.id = a.question_id
      WHERE a.attempt_id = $1 ORDER BY q.seq`, [attemptId])).rows;

  // 超时只记不拦（156）：这个数交回前端，让人当场看见"这次超了 5 分钟"。
  // 藏在库里等人去查，等于没记 —— 而它存在的意义正是让"算不算"这件事有依据。
  const late = (await tx.query(
    `SELECT late_seconds FROM exam_attempt WHERE id = $1`, [attemptId])).rows[0];

  return {
    attempt_id: attemptId,
    score: num(r.score), passed: r.passed,
    total_score: num(r.total_score),
    right_count: Number(r.right_count), question_count: Number(r.question_count),
    late_seconds: late?.late_seconds ?? null,
    detail: detail.map((d) => ({
      question_id: d.question_id, seq: d.seq, kind: d.kind,
      picked: d.picked, score: num(d.score), full_score: num(d.full_score),
    })),
    _log: { attempt: attemptId, score: num(r.score), passed: r.passed },
  };
}

/**
 * 交卷后的成绩明细（含正确答案）。
 * ★ 只对**已交卷**的答卷开放：没交卷就能看到答案，等于把卷子送出去。
 *   交卷后给答案是为了错题回顾 —— 这是行业常规，也是"考完能学到东西"的唯一方式。
 */
export async function result(tx, { userId, attemptId }) {
  await trainingAttemptAccess(tx,{userId,attemptId,action:'read'});
  if (!isId(attemptId)) throw bizErr('E_ARG_INVALID', 'attempt 必须是正整数');

  const a = (await tx.query(
    `SELECT a.id, a.paper_id, p.name AS paper_name, p.pass_score,
            a.employee_id, a.started_at, a.submitted_at, a.score, a.passed,
            a.deadline_at, a.late_seconds
       FROM exam_attempt a JOIN exam_paper p ON p.id = a.paper_id
      WHERE a.id = $1`, [attemptId])).rows[0];
  if (!a) throw bizErr('E_EXAM_NO_ATTEMPT', `答卷 ${attemptId} 不存在`);
  if (a.submitted_at === null) {
    throw bizErr('E_EXAM_NOT_SUBMITTED', '这份卷还没交，不能看成绩（答案在交卷前不下发）');
  }

  const rows = (await tx.query(
    `SELECT q.id AS question_id, q.seq, q.kind, q.stem, q.options,
            q.answer, q.score AS full_score,
            a.picked, a.score
       FROM exam_question q
       LEFT JOIN exam_answer a ON a.question_id = q.id AND a.attempt_id = $1
      WHERE q.paper_id = $2 ORDER BY q.seq`, [attemptId, a.paper_id])).rows;

  return {
    attempt_id: a.id, paper_id: a.paper_id, paper_name: a.paper_name,
    employee_id: a.employee_id,
    started_at: a.started_at, submitted_at: a.submitted_at,
    score: num(a.score), pass_score: num(a.pass_score), passed: a.passed,
    deadline_at: a.deadline_at ?? null, late_seconds: a.late_seconds ?? null,
    rows: rows.map((r) => ({
      question_id: r.question_id, seq: r.seq, kind: r.kind, stem: r.stem,
      options: r.options, answer: r.answer,
      picked: r.picked, score: num(r.score), full_score: num(r.full_score),
      right: r.picked !== null && r.picked === r.answer,
    })),
  };
}

/** 成绩清单：这张卷谁考了、多少分、过没过。给 HR 对账与导出用。 */
export async function attempts(tx, { userId, paperId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(paperId)) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');

  return (await tx.query(
    `SELECT a.id, a.employee_id, pe.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = a.employee_id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            a.session_id, a.started_at, a.submitted_at,
            a.score, a.passed, a.deadline_at, a.late_seconds
       FROM exam_attempt a
       LEFT JOIN person pe ON pe.id = a.employee_id
      WHERE a.paper_id = $1 AND fn_ty_training_person_visible($2,a.employee_id,(a.started_at AT TIME ZONE app_tz())::date)
      ORDER BY a.submitted_at DESC NULLS FIRST, a.id DESC`, [paperId,userId])).rows
    .map((r) => ({ ...r, score: num(r.score) }));
}

/** Active shared papers; every score and attempt count belongs to the session user. */
export async function myBoard(tx,{userId}) {
  await requireSession(tx,{userId,resource:'training_self',action:'read'});
  const person=await accountPerson(tx,userId);
  const rows=(await tx.query(`SELECT p.id,p.code,p.name,p.pass_score,p.max_attempts,p.duration_min,c.name AS course_name,
    (SELECT count(*)::int FROM exam_attempt a WHERE a.paper_id=p.id AND a.employee_id=$1) AS used,
    (SELECT max(a.score) FROM exam_attempt a WHERE a.paper_id=p.id AND a.employee_id=$1 AND a.submitted_at IS NOT NULL) AS best_score
    FROM exam_paper p JOIN training_course c ON c.id=p.course_id
    WHERE p.is_active AND c.is_active ORDER BY c.name,p.code`,[person])).rows;
  return {person,papers:rows.map(p=>({...p,used:Number(p.used),pass_score:num(p.pass_score),best_score:num(p.best_score),max_attempts:num(p.max_attempts),
    left_attempts:p.max_attempts===null?null:Math.max(0,Number(p.max_attempts)-Number(p.used))}))};
}
