// ============================================================================
// app/services/leave.mjs · 请假：一条做完整的业务流
// ----------------------------------------------------------------------------
// 这三个函数是"服务层"的全部内容，它们刻意很薄，因为**规矩在库里**。
// 这一层只负责四件数据库管不了的事：
//
//   ① 事务边界：一次请求一个事务（见 db.mjs —— 临时表是会话的）
//   ② 身份换算：登录账号 → 员工。这两个在真实系统里**不是同一个实体**
//   ③ 顺序：先灌权限，再读数据。反了就会绕过行闸
//   ④ 失败要说清楚：抛出去的是业务码，由 errors.mjs 映射成 HTTP
//
// 不属于这一层的：额度校验、状态机、自审拦截、勾稽。
// 那些都在库里的函数和触发器上，因为服务层可以被绕过，而库不会。
// ============================================================================

/**
 * 账号 → 员工。
 * ★ 这一步不能省成 `p_employee = userId`。
 *   在真实系统里，"谁在登录"（sys_user）与"谁在被算钱"（person/employment）
 *   是两个实体：一个人可以登录了但还没入职，也可以离职了仍要查历史。
 *   把它写成隐式相等，会在第一个"离职后仍保留查询权限"的账号上出错，
 *   而那种错看起来像权限问题。
 */
export async function resolveEmployee(tx, userId, { allowFallback = true } = {}) {
  // ★★ 账号 id 与人员 id **不是一回事**。
  //   原来这里直接 `WHERE em.person_id = userId`，靠的是"种子里 account.id 恰好
  //   等于 person.id"这个巧合。钉钉同步进来的帐套（admin 没有人员，id 就错开一格）
  //   立刻出事：示例员工（账号 6 / 人员 5）打开工资条、打卡、请假，
  //   全部落到**下一个人**头上 —— 而且页面不报错，只是"数不对"。
  //
  // ★★★ 2026-11-16 补一条更狠的：**"账号没挂人员"时不要退回 uid**（至少钱相关不要）。
  //   实测：集团人事（账号 4，person_id 为 NULL）打开「我的工资表」，
  //   因为退回 uid，页面显示的是**人员 4（另一个人）的月薪与工资条**，
  //   而签收按钮点下去报 E_NO_EMPLOYEE —— 同一屏上两个答案。
  //   所以加 `allowFallback`：打卡/请假这类"没有人员就是没数据"的路径保留退回（兼容
  //   测试与内部调用）；**钱相关的路径传 false**，"我是谁"答不出就明说答不出。
  const r = await tx.query(
    `SELECT em.id, em.person_id
       FROM employment em
      WHERE em.person_id = COALESCE(
              (SELECT a.person_id FROM sys_account a WHERE a.id = $1), $1)
        AND daterange(em.hire_date, em.leave_date, '[]') @> app_today()
      LIMIT 1`, [userId]);
  if (!allowFallback) {
    const own = (await tx.query(
      `SELECT a.person_id FROM sys_account a WHERE a.id = $1`, [userId])).rows[0];
    if (!own || own.person_id === null) {
      const e = new Error('E_NO_EMPLOYMENT: 这个账号没有绑定人员（它是管理账号，不对应任何员工），'
        + '所以没有"我的工资表"；要看别人的请用工资条列表或按人查看');
      e.code = 'P0001';
      throw e;
    }
  }
  if (r.rows.length === 0) {
    const e = new Error('E_NO_EMPLOYMENT: 该账号没有对应的在职记录（账号未挂人员，或人员已离职）');
    e.code = 'P0001';
    throw e;
  }
  return { employmentId: Number(r.rows[0].id), personId: Number(r.rows[0].person_id) };
}

// 资源码导出：W0 用它和 sys_perm_resource 做差集。
// 写死成模块私有字符串，就不会有人在新增服务时想起「这里还有一个码」。
export const RESOURCES = { request: 'leave_request' };
const RES = RESOURCES.request;

/**
 * 申请请假：灌权限 → 建单 → 冻结额度，同一事务。
 * 中间任何一步失败，整单回滚 —— 不会留下"单据在、额度没冻"的半成品。
 */
export async function applyLeave(tx, { userId, typeId, qty, from, to }) {
  const emp = await resolveEmployee(tx, userId);

  // ★ 顺序不能反：先灌权限，再碰业务数据。
  //   反了的话，业务查询跑在上一份（或空）的临时表上 —— 而结果不报错。
  await tx.query('SELECT app_begin_scope($1,$2,$3)', [userId, RES, null]);

  const r = await tx.query(
    'SELECT fn_leave_apply($1,$2,$3,$4::date,$5::date) id',
    [emp.personId, typeId, qty, from, to]);

  return { requestId: Number(r.rows[0].id), employeeId: emp.personId, status: 'pending' };
}

/** 审批：身份进去，自审在库里被拒 */
export async function decideLeave(tx, { userId, requestId, approve }) {
  const emp = await resolveEmployee(tx, userId);
  await tx.query('SELECT app_begin_scope($1,$2,$3)', [userId, RES, null]);
  await tx.query('SELECT fn_leave_decide_by($1,$2,$3)', [requestId, approve, emp.personId]);
  return { requestId, status: approve ? 'approved' : 'rejected' };
}

/** 额度四态（只读，不需要事务，但仍要灌权限才能保证口径一致） */
export async function getBalance(tx, { userId }) {
  const emp = await resolveEmployee(tx, userId);
  await tx.query('SELECT app_begin_scope($1,$2,$3)', [userId, RES, null]);
  const r = await tx.query(
    `SELECT l.leave_type_id, t.code, t.name,
            l.granted, l.frozen, l.used, l.expired, l.forfeited, l.available
       FROM v_leave_balance l JOIN leave_type t ON t.id = l.leave_type_id
      WHERE l.employee_id = $1 ORDER BY l.leave_type_id`, [emp.personId]);
  return r.rows;
}
