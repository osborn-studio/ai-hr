// ============================================================================
// app/services/payout.mjs · 发放回单（140）
// ----------------------------------------------------------------------------
// 封账说"这批数定了"，发放说"钱到员工账上了"。两件事之间可能隔几天，
// 也可能因为退票重来 —— 所以分开记。
//
// ★ 不存员工银行账号：账号留在网银与代发系统里。HR 库里留一份完整账号，
//   是最容易被整库拖走的东西，而它对算薪没有作用。
//   这里导出的是"给财务在网银里逐笔核对"的清单（工号/姓名/部门/实发）。
// ============================================================================
import { requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
// ★ 发薪期末的日期表达式只有一处（见该文件头）。本文件原来两处都按"今天"：
//   org_name 取 app_today()、fn_scope_people() 不传日期 = 今天 —— 于是补打
//   上月单时，CSV 印的是**本月**的门店，而"这批人算不算在我范围内"也按今天判，
//   可能漏人或多人，两条路都"看起来对"。打印页按期末，三个入口必须是同一个日期。
import { periodEndSql } from './payroll-period.mjs';

export const RESOURCES = { run: 'payroll_run' };

const isId = (v) => Number.isInteger(v) && v > 0;
const METHODS = ['bank', 'cash', 'manual'];

/** 登记发放。total 传了就必须与实发合计一致（差 1 分都拒）。 */
export async function pay(tx, { userId, runId, method, ref, total }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'write' });
  if (!isId(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数（批次 id）');
  const m = String(method || '').trim();
  if (!METHODS.includes(m)) {
    throw bizErr('E_PAY_METHOD', `发放方式只能是 bank（银行代发）/ cash（现金）/ manual（手工）`);
  }
  // 空字符串要变成 null：库里用 NULL 表示"没有流水号"，空串会让对账查询漏掉
  const r = String(ref ?? '').trim() || null;
  const t = total === null || total === undefined || total === '' ? null : Number(total);
  if (t !== null && !Number.isFinite(t)) throw bizErr('E_ARG_INVALID', '回单总额必须是数字');

  await tx.query(`SELECT fn_pay_run_pay($1,$2,$3,$4,$5)`,
    [runId, String(userId), m, r, t]);

  const row = (await tx.query(
    `SELECT status, paid_at, paid_by, pay_method, pay_ref FROM pay_run WHERE id=$1`,
    [runId])).rows[0];
  return {
    run_id: runId, status: row.status, paid_at: row.paid_at,
    paid_by: row.paid_by, method: row.pay_method, ref: row.pay_ref,
    _log: { run: runId, method: m, ref: r, total: t },
  };
}

/**
 * 发放清单（给财务在网银里逐笔核对，也是 140 那张截图的表格）。
 * 只读到工资条这一层：实发、工号、姓名、部门。没有银行账号。
 */
export async function paylist(tx, { userId, runId, scene = 'list' }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'read' });
  if (!isId(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数');

  // ★ 字段权限：这个函数同时喂**页面**和**CSV 导出**，所以掩码只能做在这里。
  //   权限矩阵验收（test/perm-matrix.mjs PM4a）抓到过：页面上实发是 null，
  //   导出的 CSV 里却是 6500.00 明文 —— 而导出文件会被随手转发，
  //   "页面上掩了、导出忘了掩"是最容易被漏的一类。
  //   字段属于**工资条**（payslip），不是发放回单（payroll_run）：
  //   拿发放回单的资源码去问工资条字段，结果永远是 masked（问错了对象）。
  // ★ 场景由调用方给：页面看是 list，导出是 export。
  //   两次都取 export 会连页面一起掩（页面本来有 list 授权）；
  //   两次都取 list 则导出跟着放行（那正是被审计抓的那个洞）。
  //   权限表本来就是分场景配的，这里要用同一个维度去问。
  const act = (await tx.query(
    'SELECT fn_field_action($1,$2,$3,$4) a',
    [userId, 'payslip', 'net_amount', scene === 'export' ? 'export' : 'list'])).rows[0].a;

  // ★ 日期口径统一到**发薪期末**（原来这里是 app_today() + 默认今天，两处都不对）。
  //   补打上月单时按今天取，CSV 会印出"本月所在门店"，而"这批人算不算在我范围内"
  //   也按今天判 —— 7 月调到 B 店的人在 6 月的清单上消失，或反过来多出来一个人，
  //   而这两种错都不报错，只有把清单和打印单的人名逐个对才看得出来。
  //   表达式与打印页、工资条列表共用同一处（payroll-period.mjs）。
  const run = (await tx.query(
    'SELECT period FROM pay_run WHERE id=$1', [runId])).rows[0];
  // 批次不存在时期间为 null：下面一条也匹配不到人（payslip 有外键指回 pay_run），
  // 返回空清单 —— 与原来的行为一致，不额外造一个错误。
  const period = run ? run.period : null;

  // ★ 行闸：发放清单要按门店收口。原来只做了岗位层（payroll_run 的 read），
  //   SQL 里一道过滤都没有 —— 权限矩阵验收（PM4b）抓到 A 店 HR 导出 2 行，
  //   而页面上只有 1 人。
  //   ★ 先按花名册资源重建 scope：payroll_run 的 scope 规则只有发薪法人维度，
  //     用它判"哪个门店"会得到空集（然后所有人都看不到）。人员范围一律以
  //     employee_roster 的口径为准。
  await tx.query('SELECT app_begin_scope($1,$2,$3)',
    [userId, 'employee_roster', null]);
  const rows = (await tx.query(
    `SELECT p.employee_id, pe.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            (SELECT o.name FROM employee_org_assignment a
               JOIN org_unit o ON o.id = a.org_id
              WHERE a.employee_id = pe.id AND a.dim_code = 'cost_org'
                AND daterange(a.valid_from, a.valid_to, '[]') @> ${periodEndSql('$2')}
              ORDER BY a.valid_from DESC LIMIT 1) AS org_name,
            p.gross_amount, p.net_amount
       FROM payslip p JOIN person pe ON pe.id = p.employee_id
      WHERE p.pay_run_id = $1
        AND p.employee_id IN (SELECT employee_id FROM fn_scope_people(${periodEndSql('$2')}))
      ORDER BY org_name NULLS LAST, employee_no NULLS LAST, pe.full_name`,
    [runId, period])).rows;

  const masked = rows.map((r) => ({
    ...r,
    // 掩码返回 null 而不是 0：0 会被读成"这个人实发 0 元"，
    // 而真相是"你看不到"。action 一起回传，前端才知道该画 — 还是 ***。
    net_amount: act === 'visible' ? r.net_amount : null,
    _net_amount_action: act,
  }));
  // 合计也只在能看到时才给：掩了明细却给出合计，等于把总数漏出去
  const sum = act === 'visible'
    ? rows.reduce((a, x) => a + Number(x.net_amount), 0) : null;
  return { rows: masked, count: rows.length, total: sum, _actions: { net_amount: act } };
}
