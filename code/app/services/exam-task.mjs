// ============================================================================
// app/services/exam-task.mjs · 考试任务层 / 错题回顾 / 成绩聚合 / 切屏证据（157）
// ----------------------------------------------------------------------------
// 这一层只做四件事，每件都对应一个"页面上真的有人问"的问题：
//
//   谁能考、什么时候能考   → openTask / tasksFor / checkWindow
//   我错在哪               → review
//   这家店考得怎么样、谁没考 → stat / missing
//   这场有没有人可疑        → logEvent / cheat / flagged
//
// ★ 判据一条都不在这里：时间窗、交卷后才能看答案、及格率分母、交卷后不许补记，
//   全在库里（fn_exam_task_check / fn_exam_review / fn_exam_stat /
//   fn_exam_cheat_guard）。这里再判一次就有两处会漂，而漂的那天没人会去核对。
//
// ★ review() 是这套接口里**唯一**会把标准答案送到浏览器的地方。
//   它不是"成绩单"，是"错题回顾"：交卷前不调它（库里也会拒），
//   交卷后才调 —— 这两件事在同一个函数上，靠的是 attempt.submitted_at 一个判据。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'employee_roster', write: 'employee_roster' };

// 与库里的 ck_ecl_kind 同一份清单。库里是最后一道，这里是为了给调用方一个
// 说得清的参数错（E_ARG_INVALID）而不是一个 23514。
const CHEAT_KINDS = ['blur', 'hidden', 'paste', 'screenshot'];
const DETAIL_MAX = 120;

const isId = (v) => Number.isInteger(v) && v > 0;
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * 时间参数：接受 ISO 串或 Date，统一成 ISO 给 SQL 的 ::timestamptz。
 * ★ 必须先在这里挡住非法值：直接丢给 SQL 会得到 22007（invalid datetime format），
 *   而那个 SQLSTATE 会落进 500 —— "时间写错了"被报成"服务坏了"。
 */
function ts(v, label, { required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) {
      throw bizErr('E_ARG_INVALID',
        `${label}必填（ISO 时间，如 2026-11-16T09:00:00+08:00）`);
    }
    return null;
  }
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw bizErr('E_ARG_INVALID', `${label}不是合法时间（收到「${v}」）`);
  return new Date(t).toISOString();
}

/** 组织参数：'' 与 undefined 都当"不限"（= 全公司），其余必须是正整数 */
function orgArg(v, label = 'org') {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isId(n)) throw bizErr('E_ARG_INVALID', `${label} 必须是正整数（org_unit.id）`);
  return n;
}

/**
 * 开一个考试任务（批次）。
 * @param {number} paperId
 * @param {string} name      批次名，页面上靠它分辨"A店本周"与"B店下周"
 * @param {number|null} orgId  null = 全公司
 * @param {string} openAt     不给 = 现在
 * @param {string} closeAt    必填
 * @param {boolean} required  默认 true
 */
export async function openTask(tx, { userId, paperId, name, orgId, openAt, closeAt, required }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(paperId))) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数（试卷 id）');
  const org = orgArg(orgId);
  const nm = String(name || '').trim();
  if (!nm || nm.length > 96) throw bizErr('E_ARG_INVALID', '任务名称必填且不超过 96 字');

  const id = Number((await tx.query(
    `SELECT fn_exam_task_open($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7) i`,
    [Number(paperId), nm, org,
      ts(openAt, '开始时间'),
      ts(closeAt, '关闭时间', { required: true }),
      required !== false, String(userId)])).rows[0].i);

  const t = (await tx.query(
    `SELECT id, paper_id, name, org_id, open_at, close_at, is_required, created_by, created_at
       FROM exam_task WHERE id = $1`, [id])).rows[0];
  return { ...t, _log: { task: id, paper: Number(paperId), org } };
}

/**
 * 某人某天该考什么（含"这一批交没交、考了多少"）。
 * ★ done 是"这个窗口里交过卷"，不是"及格" —— 页面要显示"考了 62 分（不及格）"，
 *   而不是把一次不及格显示成"未考"。
 */
export async function tasksFor(tx, { userId, personId, on }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(personId))) throw bizErr('E_ARG_INVALID', 'person 必须是正整数');
  if (on !== null && on !== undefined && on !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(on))) {
    throw bizErr('E_ARG_INVALID', '日期写 YYYY-MM-DD');
  }

  const rows = (await tx.query(
    `SELECT * FROM fn_exam_task_for($1,$2::date)`,
    [Number(personId), on ? String(on) : null])).rows;

  return {
    person: Number(personId),
    on: on || null,
    tasks: rows.map((r) => ({
      task_id: Number(r.task_id),
      paper_id: Number(r.paper_id),
      paper_name: r.paper_name,
      open_at: r.open_at,
      close_at: r.close_at,
      is_required: r.is_required,
      done: r.done,
      score: num(r.score),
    })),
    pending: rows.filter((r) => !r.done).length,
  };
}

/**
 * 开考前的窗口检查。不在窗口内 → E_EXAM_TASK_CLOSED（库里 raise）。
 * ★ 这道闸的另一半在 exam_attempt 的 BEFORE INSERT（157 第 8 节），
 *   所以即使调用方忘了调这个，fn_exam_start 也发不出卷。
 */
export async function checkWindow(tx, { userId, paperId, at }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(paperId))) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');
  const t = ts(at, '检查时刻');
  await tx.query(`SELECT fn_exam_task_check($1,$2::timestamptz)`, [Number(paperId), t]);
  return { paper_id: Number(paperId), at: t, open: true };
}

/**
 * 错题回顾：每题的我选的 / 正确答案 / 得几分。
 * ★ 未交卷 → E_EXAM_NOT_SUBMITTED（库里判）。这一屏有 answer，
 *   交卷前不能被调通 —— 否则等于把卷子送出去。
 */
export async function review(tx, { userId, attemptId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(attemptId))) throw bizErr('E_ARG_INVALID', 'attempt 必须是正整数');

  const rows = (await tx.query(`SELECT * FROM fn_exam_review($1)`,
    [Number(attemptId)])).rows;

  const a = (await tx.query(
    `SELECT a.id, a.paper_id, p.name AS paper_name, p.pass_score,
            a.employee_id, a.started_at, a.submitted_at, a.score, a.passed,
            a.late_seconds
       FROM exam_attempt a JOIN exam_paper p ON p.id = a.paper_id
      WHERE a.id = $1`, [Number(attemptId)])).rows[0];

  const items = rows.map((r) => ({
    seq: Number(r.seq),
    stem: r.stem,
    options: r.options,
    picked: r.picked,
    answer: r.answer,
    right: r.is_right,
    score: num(r.score),   // 本题满分
    got: num(r.got),       // 本题实得
  }));

  return {
    attempt_id: Number(attemptId),
    paper_id: Number(a.paper_id),
    paper_name: a.paper_name,
    employee_id: Number(a.employee_id),
    started_at: a.started_at,
    submitted_at: a.submitted_at,
    score: num(a.score),
    pass_score: num(a.pass_score),
    passed: a.passed,
    late_seconds: a.late_seconds,
    rows: items,
    wrong: items.filter((r) => !r.right),
    kpi: {
      questions: items.length,
      right: items.filter((r) => r.right).length,
      wrong: items.filter((r) => !r.right).length,
    },
  };
}

/**
 * 成绩分布。rows[0] 是 'all'，后面五个分数段（0 人的段也在）。
 * ★ pass_rate 的分母是已交卷人数 —— 与"应考人数"无关，后者在 missing()。
 */
export async function stat(tx, { userId, paperId, orgId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(paperId))) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');
  const org = orgArg(orgId);

  const rows = (await tx.query(`SELECT * FROM fn_exam_stat($1,$2)`,
    [Number(paperId), org])).rows;

  const buckets = rows.map((r) => ({
    bucket: r.bucket,
    person_count: Number(r.person_count),
    avg_score: num(r.avg_score),
    pass_count: Number(r.pass_count),
    pass_rate: num(r.pass_rate),
  }));

  return {
    paper_id: Number(paperId), org_id: org,
    buckets,
    summary: buckets.find((b) => b.bucket === 'all') || null,
  };
}

/** 该考没考的人（催考清单）。没有已开考的任务时返回空 —— 见 fn_exam_missing 的注释。 */
export async function missing(tx, { userId, paperId, orgId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(paperId))) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');
  const org = orgArg(orgId);

  return (await tx.query(`SELECT * FROM fn_exam_missing($1,$2)`,
    [Number(paperId), org])).rows
    .map((r) => ({
      person_id: Number(r.person_id),
      person_name: r.person_name,
      employee_no: r.employee_no,
      attempts: Number(r.attempts),
    }));
}

/**
 * 记一条切屏事件。**一次一行，只记时间点**。
 * @param {'blur'|'hidden'|'paste'|'screenshot'} kind
 * ★ 时间由库端 clock_timestamp() 给（INSERT 不传 event_at），不收客户端的时间：
 *   改本地时间就能伪造"我当时没切屏"；而同一事务里连记三条也要能看出先后。
 * ★ 已交卷的答卷不能补记（库里 E_EXAM_SUBMITTED）—— 补记等于事后栽赃。
 */
export async function logEvent(tx, { userId, attemptId, kind, detail }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(attemptId))) throw bizErr('E_ARG_INVALID', 'attempt 必须是正整数');
  const k = String(kind || '').trim();
  if (!CHEAT_KINDS.includes(k)) {
    throw bizErr('E_ARG_INVALID', `kind 只能是 ${CHEAT_KINDS.join(' / ')}（收到「${kind}」）`);
  }
  // 截断而不是报错：这条字段是给人看的线索，长度超了不该让"记一条事件"失败
  const d = String(detail || '').trim().slice(0, DETAIL_MAX) || null;

  const r = (await tx.query(
    `INSERT INTO exam_cheat_log(attempt_id, kind, detail)
     VALUES ($1,$2,$3) RETURNING id, event_at`, [Number(attemptId), k, d])).rows[0];

  return {
    id: Number(r.id), attempt_id: Number(attemptId), kind: k, detail: d,
    event_at: r.event_at,
    _log: { attempt: Number(attemptId), kind: k },
  };
}

/** 某份答卷的全部事件（监考页，交卷前后都能看） */
export async function cheat(tx, { userId, attemptId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(attemptId))) throw bizErr('E_ARG_INVALID', 'attempt 必须是正整数');

  const rows = (await tx.query(`SELECT * FROM fn_exam_cheat($1)`,
    [Number(attemptId)])).rows;
  return {
    attempt_id: Number(attemptId),
    events: rows.map((r) => ({
      event_at: r.event_at, kind: r.kind, detail: r.detail,
    })),
  };
}

/** 这张卷哪些答卷可疑（按事件数降序） */
export async function flagged(tx, { userId, paperId }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(paperId))) throw bizErr('E_ARG_INVALID', 'paper 必须是正整数');

  return (await tx.query(`SELECT * FROM fn_exam_flagged($1)`,
    [Number(paperId)])).rows
    .map((r) => ({
      person_name: r.person_name,
      attempt_id: Number(r.attempt_id),
      events: Number(r.events),
      first_at: r.first_at,
      last_at: r.last_at,
    }));
}
