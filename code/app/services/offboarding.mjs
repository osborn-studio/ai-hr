// ============================================================================
// app/services/offboarding.mjs · 离职交接（165）
// ----------------------------------------------------------------------------
// 这一层只做编排：列、开单、生效、交接清单、离职证明、竞业限制。
// **法定判断全在库里**（fn_exit_check / fn_exit_open / fn_exit_apply /
// fn_exit_certificate）—— 这里再判一遍"最后一天能不能早于入职日"，
// 就有两个地方会漂，而漂的那一次是**把离职日写到入职前**。
//
// ★ 三条边界（与 contract.mjs 同一套）：
//   ① block（做不了）→ 直接拒，不落库；warn（有风险）→ 照办，但把话带回去。
//      把预警做成硬拦，人会去线下办 —— 那样连"这张单存在"都查不到。
//   ② 离职证明的正文由库里生成：函数里**没有"原因"这个变量**，
//      所以接口无论怎么传都写不出原因。这不是自觉，是结构。
//   ③ 没有"改已办结离职单"的接口。要改就取消重开 ——
//      与合同封存、工资条封账同一条规矩：办结的是一个事实，不是一份草稿。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'employment_manage', write: 'employment_manage' };

const isId = (v) => Number.isInteger(v) && v > 0;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const str = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

const KINDS = ['resign', 'terminate', 'retire', 'contract_end'];
const CATS = ['asset', 'document', 'account', 'work'];
const NC_STATUS = ['none', 'agreed', 'waived'];

/** 交接清单 + 汇总。一处算，六个接口共用，省得"总数"在页面上与库里不一致。 */
async function handoverOf(tx, exitId) {
  const rows = (await tx.query(
    `SELECT id, item, category, is_returned,
            returned_at, to_char(returned_at, 'YYYY-MM-DD HH24:MI') AS returned_text,
            note,
            (category IN ('asset','document','account')) AS is_key
       FROM exit_handover_item
      WHERE exit_id = $1
      ORDER BY category, id`, [exitId])).rows;
  const key = rows.filter((r) => r.is_key);
  return {
    rows: rows.map((r) => ({ ...r, id: Number(r.id) })),
    summary: {
      total: rows.length,
      returned: rows.filter((r) => r.is_returned).length,
      open: rows.filter((r) => !r.is_returned).length,
      // ★ 只有关键项没归还才叫"交接没做完"：在办事项本来就要跟到下一个人手上
      key_open: key.filter((r) => !r.is_returned).length,
    },
  };
}

/**
 * 离职单清单。
 * ★ 每条带上"交接进度"与"还剩几天到最后工作日"（负数=已经过了那一天）。
 *   这两个数在页面上必须直接可读 —— 让前端拿日期自己减，跨时区就会差一天。
 */
export async function list(tx, { userId, employeeId = null, status = null }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });  // ★ 行闸（170）：这四个读接口原来 requireSession 之后就直查全表，
  //   于是 A 店 HR 打开页面看到的是全集团的人（权限矩阵 PM8 抓到）。
  //   人员范围一律以「花名册口径」为准：先按 employee_roster 重建 scope，
  //   再用 fn_scope_people() 过滤 —— 那是行闸的唯一表达式，不要手抄 EXISTS。
  await tx.query('SELECT app_begin_scope($1,$2,$3)',
    [userId, 'employee_roster', null]);

  if (employeeId !== null && !isId(Number(employeeId))) {
    throw bizErr('E_EXIT_ARG', 'employee 必须是正整数（person.id）');
  }
  const rows = (await tx.query(
    `SELECT x.id, x.code, x.employee_id, p.full_name AS person_name,
            x.kind, x.apply_date::text AS apply_date,
            x.last_work_date::text AS last_work_date, x.reason,
            x.handover_to, hp.full_name AS handover_name,
            x.status, x.approved_by, x.done_at::text AS done_at,
            (x.last_work_date - CURRENT_DATE) AS days_left,
            (SELECT e.hire_date::text FROM employment e
              WHERE e.person_id = x.employee_id AND e.hire_date <= x.last_work_date
              ORDER BY e.hire_date DESC LIMIT 1) AS hire_date,
            (SELECT count(*)::int FROM exit_handover_item h WHERE h.exit_id = x.id) AS items,
            (SELECT count(*)::int FROM exit_handover_item h
              WHERE h.exit_id = x.id AND h.is_returned) AS returned,
            (SELECT count(*)::int FROM exit_handover_item h
              WHERE h.exit_id = x.id AND NOT h.is_returned
                AND h.category IN ('asset','document','account')) AS key_open,
            (SELECT n.status FROM non_compete n WHERE n.exit_id = x.id) AS nc_status,
            (SELECT n.months FROM non_compete n WHERE n.exit_id = x.id) AS nc_months
       FROM employee_exit x
       LEFT JOIN person p  ON p.id  = x.employee_id
       LEFT JOIN person hp ON hp.id = x.handover_to
      WHERE ($1::bigint IS NULL OR x.employee_id = $1)
        AND x.employee_id IN (SELECT employee_id FROM fn_scope_people())
        AND ($2::text IS NULL OR x.status = $2)
      ORDER BY x.last_work_date DESC, x.id DESC
      LIMIT 200`, [employeeId === null ? null : Number(employeeId), status])).rows;

  return {
    rows: rows.map((r) => ({
      ...r,
      id: Number(r.id),
      employee_id: Number(r.employee_id),
      handover_to: r.handover_to === null ? null : Number(r.handover_to),
      days_left: r.days_left === null ? null : Number(r.days_left),
      items: Number(r.items),
      returned: Number(r.returned),
      key_open: Number(r.key_open),
      nc_months: r.nc_months === null ? null : Number(r.nc_months),
    })),
    kpi: {
      total: rows.length,
      pending: rows.filter((r) => r.status === 'draft' || r.status === 'approved').length,
      done: rows.filter((r) => r.status === 'done').length,
      // 关键项还没还完的单：这是"人走了东西没回来"的实际敞口
      handover_open: rows.filter((r) => Number(r.key_open) > 0).length,
      // 已经到了最后工作日却还没办结：当天社保、门禁、工资都还在按在职算
      overdue: rows.filter((r) => r.status !== 'done' && r.status !== 'cancelled'
        && r.days_left !== null && Number(r.days_left) <= 0).length,
    },
  };
}

/**
 * 开离职单。
 * ★ 先校验再落库：block 直接抛（不留下半张单），warn 随结果带回去。
 */
export async function open(tx, { userId, employeeId, kind, applyDate, lastWorkDate,
  reason, handoverTo = null }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(employeeId))) throw bizErr('E_EXIT_ARG', 'employee 必须是正整数（person.id）');
  if (!KINDS.includes(String(kind))) {
    throw bizErr('E_EXIT_ARG', `离职类型只能是 ${KINDS.join(' / ')}`);
  }
  if (!isDate(applyDate) || !isDate(lastWorkDate)) {
    throw bizErr('E_EXIT_ARG', '提出日与最后工作日都必须写成 YYYY-MM-DD');
  }
  if (String(reason || '').trim().length < 4) {
    throw bizErr('E_EXIT_ARG', '离职原因至少 4 个字 —— 只留一个日期，三个月后没人答得出"他为什么走"');
  }
  if (handoverTo !== null && !isId(Number(handoverTo))) {
    throw bizErr('E_EXIT_ARG', 'handover 必须是正整数（交接人的 person.id）');
  }

  const checks = (await tx.query(
    `SELECT * FROM fn_exit_check($1,$2::date,NULL)`,
    [Number(employeeId), lastWorkDate])).rows;
  const blocks = checks.filter((c) => c.level === 'block');
  if (blocks.length) {
    throw bizErr('E_EXIT_BLOCKED', blocks.map((b) => b.message).join('；'));
  }

  const id = Number((await tx.query(
    `SELECT fn_exit_open($1,$2,$3::date,$4::date,$5,$6,$7) i`,
    [Number(employeeId), String(kind), applyDate, lastWorkDate,
      String(reason).trim(), handoverTo === null ? null : Number(handoverTo),
      String(userId)])).rows[0].i);
  const row = (await tx.query(
    `SELECT code, status FROM employee_exit WHERE id = $1`, [id])).rows[0];

  return {
    id, code: row.code, status: row.status,
    warnings: checks.filter((c) => c.level === 'warn').map((c) => c.message),
    _log: { exit: id, employee: Number(employeeId), kind },
  };
}

/**
 * 生效：写 leave_date、终止在履行的合同、归属段收口、单据转 done。
 * ★ 返回三张表各改了几行。归零是正常结果（本来就没有合同/归属的人），
 *   所以**不拿行数当判据** —— 判据是 leave_date 变了没有。
 */
export async function apply(tx, { userId, id }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(id))) throw bizErr('E_EXIT_ARG', 'id 必须是正整数');
  const r = (await tx.query(`SELECT * FROM fn_exit_apply($1,$2)`, [id, String(userId)])).rows[0];
  const row = (await tx.query(
    `SELECT code, status, last_work_date::text AS last_work_date,
            to_char(done_at, 'YYYY-MM-DD HH24:MI') AS done_at
       FROM employee_exit WHERE id = $1`,
    [id])).rows[0];
  return {
    id: Number(r.exit_id),
    code: row.code,
    status: row.status,
    last_work_date: row.last_work_date,
    done_at: row.done_at,
    affected: {
      employment: Number(r.employment_rows),
      contract: Number(r.contract_rows),
      assignment: Number(r.assignment_rows),
    },
    _log: { exit: id, action: 'apply' },
  };
}

/**
 * 交接清单：一次提交整份清单（页面上的勾选框就是这样用的）。
 *
 * ★ 语义是**同步**，不是追加：
 *   · 传上来的条目按 (exit_id, item) 落库，已有则更新（含归还状态）；
 *   · 没传上来的条目**不删** —— 已经归还过的记录是"当时收回了什么"的证据，
 *     删掉之后只剩一句"好像是还了"。
 * ★ items 省略 = 只读，不写。
 */
export async function handover(tx, { userId, id, items = null }) {
  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(id))) throw bizErr('E_EXIT_ARG', 'id 必须是正整数');
  const ex = (await tx.query(
    `SELECT id, status FROM employee_exit WHERE id = $1`, [id])).rows[0];
  if (!ex) throw bizErr('E_EXIT_NOT_FOUND', `离职单 ${id} 不存在`);
  if (ex.status === 'cancelled') {
    throw bizErr('E_EXIT_CANCELLED', `离职单 ${id} 已取消 —— 交接清单不能再改`);
  }

  if (items !== null) {
    if (!Array.isArray(items)) throw bizErr('E_EXIT_ARG', 'items 必须是数组');
    if (items.length > 200) throw bizErr('E_EXIT_ARG', '一次最多提交 200 条交接项');
    for (const raw of items) {
      const item = String(raw?.item ?? '').trim();
      const cat = String(raw?.category || 'asset').trim();
      if (!item) throw bizErr('E_EXIT_ARG', '每一条交接项都要有名称（哪一件东西）');
      if (item.length > 120) throw bizErr('E_EXIT_ARG', `交接项名称过长（≤120 字）：${item.slice(0, 20)}…`);
      if (!CATS.includes(cat)) {
        throw bizErr('E_EXIT_ARG', `交接项类别只能是 ${CATS.join(' / ')}`);
      }
      await tx.query(
        `INSERT INTO exit_handover_item AS h
           (exit_id, item, category, is_returned, returned_at, note)
         VALUES ($1,$2,$3,$4, CASE WHEN $4 THEN now() END, $5)
         ON CONFLICT (exit_id, item) DO UPDATE
            SET category    = EXCLUDED.category,
                is_returned = EXCLUDED.is_returned,
                -- ★ 已经归还过就保留第一次的时刻：反复勾选不该把"什么时候收的"改掉
                returned_at = CASE WHEN EXCLUDED.is_returned
                                   THEN COALESCE(h.returned_at, now()) ELSE NULL END,
                note        = COALESCE(EXCLUDED.note, h.note)`,
        [Number(id), item, cat, raw?.isReturned === true, str(raw?.note)]);
    }
  }

  const h = await handoverOf(tx, Number(id));
  return { id: Number(id), status: ex.status, ...h,
    _log: { exit: Number(id), action: 'handover', items: h.rows.length } };
}

/** 离职证明（只给已办结的单出）。正文由 fn_exit_certificate 生成，这里不改一个字。 */
export async function certificate(tx, { userId, id }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(Number(id))) throw bizErr('E_EXIT_ARG', 'id 必须是正整数');
  const body = (await tx.query(`SELECT fn_exit_certificate($1) b`, [id])).rows[0].b;
  const row = (await tx.query(
    `SELECT code, employee_id, last_work_date::text AS last_work_date
       FROM employee_exit WHERE id = $1`,
    [id])).rows[0];
  return {
    id: Number(id),
    code: row.code,
    employee_id: Number(row.employee_id),
    last_work_date: row.last_work_date,
    body,
    chars: String(body).length,
  };
}

/**
 * 竞业限制：约定 / 明确放弃 / 明确没约定。
 *
 * ★ 三态而不是布尔：
 *   none   = 当时明确没约定（也要留一行，否则事后说不清谈没谈）
 *   agreed = 约定了（库里要求范围/期限/补偿/起止齐全，且期限 ≤ 24 个月）
 *   waived = 约定了但公司放弃要求履行
 * ★ 没约定就**不能**事后补加：事后加的限制没有对价，员工可以不履行。
 *   要加只能走 agreed，且必须同时给补偿标准 —— 库里的 CHECK 会挡住半份约定。
 *
 * @param data  省略 = 只读；给了 = 写（status/scope/months/monthlyPay/startDate）
 */
export async function nonCompete(tx, { userId, id = null, employeeId = null, data = null }) {
  if (data === null) {
    await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
    if (id === null && employeeId === null) {
      throw bizErr('E_NC_ARG', '查询竞业限制要给 exit 或 employee');
    }
    const rows = (await tx.query(
      `SELECT n.id, n.employee_id, n.exit_id, n.scope, n.months, n.monthly_pay,
              n.start_date::text AS start_date, n.end_date::text AS end_date, n.status,
              (n.end_date - CURRENT_DATE) AS days_left,
              (SELECT p.full_name FROM person p WHERE p.id = n.employee_id) AS person_name
         FROM non_compete n
        WHERE ($1::bigint IS NULL OR n.exit_id = $1)
          AND ($2::bigint IS NULL OR n.employee_id = $2)
        ORDER BY n.id DESC LIMIT 50`,
      [id === null ? null : Number(id),
        employeeId === null ? null : Number(employeeId)])).rows;
    return {
      rows: rows.map((r) => ({
        ...r,
        id: Number(r.id),
        employee_id: Number(r.employee_id),
        exit_id: r.exit_id === null ? null : Number(r.exit_id),
        months: r.months === null ? null : Number(r.months),
        monthly_pay: num(r.monthly_pay),
        days_left: r.days_left === null ? null : Number(r.days_left),
      })),
    };
  }

  await requireSession(tx, { userId, resource: RESOURCES.write, action: 'write' });
  if (!isId(Number(id))) throw bizErr('E_NC_ARG', 'id 必须是离职单（exit）id');
  const ex = (await tx.query(
    `SELECT id, employee_id, status FROM employee_exit WHERE id = $1`, [id])).rows[0];
  if (!ex) throw bizErr('E_NC_NO_EXIT', `离职单 ${id} 不存在`);

  const status = String(data.status || 'none').trim();
  if (!NC_STATUS.includes(status)) {
    throw bizErr('E_NC_ARG', `竞业状态只能是 ${NC_STATUS.join(' / ')}`);
  }

  let scope = null, months = null, pay = null, start = null;
  if (status === 'agreed') {
    scope = str(data.scope);
    months = num(data.months);
    pay = num(data.monthlyPay);
    start = str(data.startDate);
    if (!scope || scope.length < 2) {
      throw bizErr('E_NC_NOT_AGREED', '约定了竞业限制就要写清范围（地域/业务/岗位）—— '
        + '范围不明等于没约定，员工可以主张不受限制');
    }
    if (!Number.isInteger(months) || months < 1 || months > 24) {
      throw bizErr('E_NC_MONTHS', '竞业期限是 1~24 个月（《劳动合同法》第二十四条：不得超过二年）');
    }
    if (!pay || pay <= 0) {
      throw bizErr('E_NC_NOT_AGREED', '约定了竞业限制就必须给补偿标准（月补偿金额 > 0）—— '
        + '没有补偿的竞业条款，员工可以不履行');
    }
    if (!isDate(start)) {
      throw bizErr('E_NC_NOT_AGREED', '约定了竞业限制就要给起始日（YYYY-MM-DD）');
    }
  }

  const r = (await tx.query(
    `INSERT INTO non_compete AS n
       (employee_id, exit_id, scope, months, monthly_pay, start_date, end_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6::date,
             CASE WHEN $6::date IS NULL OR $4::int IS NULL THEN NULL
                  ELSE ($6::date + make_interval(months => $4::int))::date END,
             $7,$8)
     ON CONFLICT (exit_id) DO UPDATE
        SET scope = EXCLUDED.scope, months = EXCLUDED.months,
            monthly_pay = EXCLUDED.monthly_pay, start_date = EXCLUDED.start_date,
            end_date = EXCLUDED.end_date, status = EXCLUDED.status
     RETURNING id, employee_id, exit_id, scope, months, monthly_pay,
               start_date::text AS start_date, end_date::text AS end_date, status`,
    [Number(ex.employee_id), Number(id), scope, months, pay, start, status,
      String(userId)])).rows[0];

  return {
    id: Number(r.id),
    employee_id: Number(r.employee_id),
    exit_id: Number(r.exit_id),
    scope: r.scope,
    months: r.months === null ? null : Number(r.months),
    monthly_pay: num(r.monthly_pay),
    start_date: r.start_date,
    end_date: r.end_date,
    status: r.status,
    _log: { exit: Number(id), nonCompete: Number(r.id), status },
  };
}
