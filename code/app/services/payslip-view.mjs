// ============================================================================
// app/services/payslip-view.mjs · 工资条查阅留痕（184）
// ----------------------------------------------------------------------------
// 这个文件只有两件事：**写一条留痕**（recordView）与**读留痕**（listViews）。
// 所有出口（/api/payslip、/api/payroll/slips、打印、打印 HTML、CSV、zip 打包、
// 发放清单、单人工资表、环比）都调 recordView —— 留痕的判据只有一份，
// 不是每个路由各写一遍。
//
// ★ 为什么写入要在**独立事务**里（不是在读事务里顺手 INSERT）
//   读事务可能因为后面某个字段求值失败而 ROLLBACK，日志会跟着消失 ——
//   而"这个人确实看过了"是已经发生的事实，不该因为一次 500 被抹掉。
//   反过来，日志写失败（表被改名、权限被收、磁盘满）也**不能**让读请求 500：
//   留痕是旁路，不是主路。
//   ★ 事务边界不在这里：本文件与其他服务一样只收到 tx（AG14 的规矩：服务层
//     不知道事务怎么开）。"另开一个事务 + try/catch 吞错"的包装在 server.mjs
//     的 logPayslipView —— 它才是唯一有 db 的地方，也只有一个实现。
//   代价写在明处：日志可能丢（写失败时），但读请求永远不受影响 ——
//   这个取舍在合规上是可解释的（"取证失败"不能变成"业务不可用"）。
//
// ★ 为什么"看自己的"不记
//   每个人每天打开自己的工资条十次，日志会被自己刷满，真要看"谁看了我的"
//   时翻不出来。审计要回答的是"**别人**动过我什么"。
//
// ★ 为什么批量只记一行
//   8 月整批 374 人不写 374 条。读日志的是人：一条"某人某时看了 8 月整批 374 行"
//   能读，374 条只能靠聚合才看得出是同一件事。row_count 就是"这次看了几行"。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';

export const RESOURCES = { read: 'payslip', all: 'payroll_slips_read_all' };

const SCOPES = new Set(['single', 'list', 'print', 'export']);
const SCOPE_LABEL = { single: '单条', list: '列表', print: '打印', export: '导出' };

/**
 * 写一条工资条查阅留痕。**判据都在这里**（看自己不记 / 批量一行 / 行数）。
 * 事务由调用方给 —— 服务层只收到 tx（AG14）。"另开事务 + 吞错"的包装在
 * server.mjs 的 logPayslipView，那里才是唯一知道事务怎么开的地方。
 *
 * @param tx          一个事务（由 server 单独为这一条日志开，与读事务不是同一个）
 * @param actor       会话里的 user id
 * @param scope       'single' | 'list' | 'print' | 'export'
 * @param persons     这一次返回的工资条属于哪些人（person.id 数组）
 * @param subject     直接指定"看了谁"（单条路径用；与 persons 二选一）
 * @param payslipId   单条时填
 * @param payRunId    批次时填（跨批次留 NULL）
 * @param rowCount    这一次看了几行（缺省取 persons.length）
 * @param ip          请求来源（由 server 传，只信被代理覆盖的 XFF）
 */
export async function recordView(tx, {
  actor, scope, persons = null, subject = null,
  payslipId = null, payRunId = null, rowCount = null, ip = null,
} = {}) {
  if (!actor) return null;
  if (!SCOPES.has(scope)) {
    // 不认识的范围不写：写进去的是"一条没人知道该怎么读的记录"，比不写更坏。
    throw bizErr('E_ARG_INVALID', `payslip_view_log: 未知 scope「${scope}」`);
  }
  const rows = Number.isInteger(rowCount) ? rowCount
    : (Array.isArray(persons) ? persons.length : 0);
  // 0 行不算"看过"：空列表页也写一条，日志会被"打开→没数据"刷满。
  if (!(rows > 0)) return null;

  // 我自己是谁 —— 账号 id ≠ 人员 id，这里用的与 180 人员闸同一个函数。
  const selfId = (await tx.query('SELECT fn_my_person($1) p', [actor])).rows[0]?.p ?? null;

  const targets = Array.isArray(persons)
    ? persons.map((x) => Number(x))
    : (subject === null || subject === undefined ? null : [Number(subject)]);

  if (targets === null) {
    // 只给了 row_count、给不出人员（zip 打包 / 发放清单：服务只回人数，没有 id 清单）。
    // 这时无法判"是不是只看自己"，按"看了别人的一批"记 —— 这两个入口本来就是
    // 一次出一整批，不是"看自己那一张"的地方。
    // ★ 这是本表已知的一个粗糙边：唯一雇员的自助打包会被记成"看了 N 行别人"。
    //   如实写在注释里，不假装它精确（报告里也列了这一条）。
  } else {
    const others = targets.filter((p) => p !== Number(selfId));
    // ★ 核心：只看自己的人不留痕。
    if (others.length === 0) return null;
    // 单条：subject 填具体那个人；批量：subject 留 NULL，
    // 靠 row_count + pay_run_id 说明"看了哪一批多少行"。
    subject = scope === 'single' ? others[0] : null;
  }

  const r = await tx.query(
    `INSERT INTO payslip_view_log
       (actor_user_id, subject_person_id, payslip_id, pay_run_id, scope, row_count, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7::inet)
     RETURNING id`,
    [actor, subject, scope === 'single' ? payslipId : null,
     payRunId, scope, rows, ip || null]);
  return Number(r.rows[0].id);
}

// ---------------------------------------------------------------------------
// 读留痕
// ---------------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/payslip/views 的实现。
 *
 * ★ 两条权限面，判据是**能力位**（177 立的规矩：不按角色名判）：
 *   · 有 payroll_slips_read_all → 可查任何人；
 *   · 没有 → **只能查"自己被谁看过"**（subject_person_id = fn_my_person(uid)），
 *     并且**不接受** person 参数去看别人（403，不是静默忽略 ——
 *     静默忽略会让调用方以为查到了别人的记录，只是空的）。
 * ★ 返回里**没有金额**：这是留痕，不是工资条。把应发实发带出来，
 *   等于给"能查日志的人"开了一个不经字段掩码的取数口。
 */
export async function listViews(tx, { userId, personId = null, from = null, to = null, limit = 50 }) {
  await requireSession(tx, { userId, resource: RESOURCES.read });

  const seeAll = (await tx.query('SELECT fn_role_can($1,$2,$3) o',
    [userId, RESOURCES.all, 'read'])).rows[0].o === true;
  const selfId = (await tx.query('SELECT fn_my_person($1) p', [userId])).rows[0].p;

  let want = personId === null || personId === undefined || personId === ''
    ? null : Number(personId);
  if (want !== null && (!Number.isInteger(want) || want <= 0)) {
    throw bizErr('E_ARG_INVALID', 'person 必须是正整数（person.id，不是工号）');
  }
  if (!seeAll) {
    if (want !== null && want !== Number(selfId)) {
      throw bizErr('E_RESOURCE_FORBIDDEN',
        '只能查「自己被谁看过」；查别人的查阅记录需要工资条全量权限（payroll_slips_read_all）');
    }
    // 没绑人的账号：自己是谁都不知道 → 0 行（不是 403，也不是全表）
    if (selfId === null) {
      return { rows: [], view_scope: 'self', person: null, limit: clampLimit(limit) };
    }
    want = Number(selfId);
  }

  const f = (v) => (v === null || v === undefined || v === '' ? null : String(v));
  const fromD = f(from);
  const toD = f(to);
  if (fromD !== null && !DATE_RE.test(fromD)) throw bizErr('E_ARG_INVALID', 'from 必须是 YYYY-MM-DD');
  if (toD !== null && !DATE_RE.test(toD)) throw bizErr('E_ARG_INVALID', 'to 必须是 YYYY-MM-DD');
  const lim = clampLimit(limit);

  // ★ 185：批量行原来对个人**完全不可见**（subject 为 NULL），于是员工查"我被谁看过"
  //   会漏掉"HR 导过包含我的整批"—— 那恰恰是最该被知道的一种。
  //   这里用 EXISTS 现算：该批次里有没有我的工资条。**不加桥表**（不为一次查询写 374 行）。
  //   口径说清楚：它回答的是"**这个批次里有你的工资条**"，不是"当时那一刻返回的 374 行
  //   里确实包含你"（当时的行闸范围可能比批次小）。所以返回值里带 `hit` 区分：
  //     hit='row'   → 这条日志直接指向你（subject 就是你）
  //     hit='batch' → 这条日志是一个批次，而该批次里有你的工资条
  //   把两者混成一个字段，读的人会以为"HR 明确点开过我的"—— 那是另一回事。
  const rows = (await tx.query(
    `SELECT l.id, l.at, l.actor_user_id,
            COALESCE(a.display_name, '账号#' || l.actor_user_id) AS actor_name,
            l.subject_person_id, pe.full_name AS subject_name,
            l.payslip_id, l.pay_run_id, l.scope, l.row_count, l.ip,
            CASE WHEN l.subject_person_id IS NOT NULL THEN 'row' ELSE 'batch' END AS hit
       FROM payslip_view_log l
       LEFT JOIN sys_account a ON a.id = l.actor_user_id
       LEFT JOIN person pe ON pe.id = l.subject_person_id
      WHERE (
              $1::bigint IS NULL
              OR l.subject_person_id = $1
              OR (l.subject_person_id IS NULL AND l.pay_run_id IS NOT NULL
                  AND EXISTS (SELECT 1 FROM payslip p
                               WHERE p.pay_run_id = l.pay_run_id AND p.employee_id = $1))
            )
        AND ($2::date IS NULL OR l.at >= $2::date)
        AND ($3::date IS NULL OR l.at < ($3::date + 1))
      ORDER BY l.at DESC, l.id DESC
      LIMIT $4`, [want, fromD, toD, lim])).rows;

  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      actor_user_id: r.actor_user_id === null ? null : Number(r.actor_user_id),
      actor_name: r.actor_name,
      subject_person_id: r.subject_person_id === null ? null : Number(r.subject_person_id),
      subject_name: r.subject_name,
      payslip_id: r.payslip_id === null ? null : Number(r.payslip_id),
      pay_run_id: r.pay_run_id === null ? null : Number(r.pay_run_id),
      scope: r.scope,
      scope_label: SCOPE_LABEL[r.scope] || r.scope,
      row_count: Number(r.row_count),
      ip: r.ip === null ? null : String(r.ip),
      // 'row' = 直接看你这一张；'batch' = 一个批次的日志，而这个批次里有你的工资条
      hit: r.hit,
    })),
    // 前端据此决定标题写"谁看过我的"还是"全公司查阅记录"
    view_scope: seeAll ? 'all' : 'self',
    person: want,
    limit: lim,
  };
}

const clampLimit = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(200, Math.floor(n));
};
