// ============================================================================
// app/services/payroll.mjs · 算薪：发起 / 明细 / 勾稽
// ----------------------------------------------------------------------------
// 这个文件修的是一个**会留垃圾**的 bug，不是重构。
//
// 原来 /api/payroll/run 的顺序是：
//
//   INSERT pay_run ...            ← 先建批次
//   SELECT fn_payroll_calc(...)   ← 再算，门禁可能在第一步之后就拒绝
//   catch → 409
//
// 两条语句各自自动提交，所以被门禁拒绝时，**那个 pay_run 留在库里了**：
// 一个 draft 状态的空批次。它的害处不是占空间，是下一次同期间算薪会
// `SELECT id FROM pay_run WHERE period=..` 查到它、复用它的 calc_version，
// 于是一个"从未算过"的批次看起来像"算过了、只是没数"。
//
// 现在：建批次 + 算薪 + 汇总在**一个事务**里。门禁拒绝 → 整批不存在。
// ============================================================================
import { requireOrg, requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
// ★ 发薪期末的日期表达式只有一处（见该文件头）：打印页、工资条列表、发放清单
//   必须用同一个日期判"这批人算不算在我范围内"，否则补打上月单时会漏人/多人，
//   而三条路各自都"看起来对"。
import { periodEndSql } from './payroll-period.mjs';

export const RESOURCES = { run: 'payroll_run', slip: 'payslip' };

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 发起算薪。
 * ★ 这里不自己算任何数，只调 fn_payroll_calc。钱的算法只有一份，放在库里；
 *   接口层多写一行算术，就多一处与库里不一致的地方，而两处不一致时
 *   永远没人知道该信哪一处。
 */
export async function runPayroll(tx, { userId, period, entityId }) {
  if (!PERIOD_RE.test(String(period || ''))) throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM');
  if (!Number.isInteger(entityId) || entityId <= 0) throw bizErr('E_ARG_INVALID', 'entity 必须是正整数');

  // 发薪的维度是 payroll_legal_entity，不是 cost_org ——
  // 选错维度会变成"在 A 店范围内的人都能算 B 法人的薪"，而两边都查得到数据。
  await requireOrg(tx, { userId, resource: RESOURCES.run, orgId: entityId, dim: 'payroll_legal_entity', action: 'write' });

  let run = (await tx.query(
    'SELECT id, status FROM pay_run WHERE period=$1 AND legal_entity_id=$2 ORDER BY id LIMIT 1',
    [period, entityId])).rows[0];

  if (!run) {
    run = (await tx.query(
      'INSERT INTO pay_run(period, legal_entity_id) VALUES ($1,$2) RETURNING id, status',
      [period, entityId])).rows[0];
  }

  // ── before 规则：算薪之前先过门 ────────────────────────────────────────
  // ★ 137 起这段计算搬进库里（fn_payroll_gate），这里只负责"留痕 + 汇总"。
  //   原来这段在 JS 里拼变量，而预演也要求报"谁会被拦"—— 两处各自拼一遍，
  //   一定会漂成"预演说行、真算被拦"。变量的口径（项先给 0 再覆盖月薪/提成）
  //   现在只有一个出处。
  // ★ 为什么拦截不在 fn_payroll_calc 里：拦截要 RAISE，而 RAISE 会连"命中留痕"
  //   一起回滚，结果是"拦了但没痕迹"。所以门在这里，留痕也在事务里（不拦就提交）。
  //   规则自身写错按 block 处理 —— 坏规则不能放行。
  const gate = (await tx.query(
    `SELECT person_id, rule_code, rule_action, rule_message, amount
       FROM fn_payroll_gate($1,$2)`, [period, entityId])).rows;

  const blocked = [];
  for (const h of gate) {
    await tx.query(
      `INSERT INTO salary_rule_hit(run_id, person_id, rule_code, stage, action, message, amount)
       VALUES ($1,$2,$3,'before',$4,$5,$6)`,
      [run.id, h.person_id, h.rule_code, h.rule_action, h.rule_message, h.amount]);
    if (h.rule_action === 'block') {
      blocked.push({ person_id: Number(h.person_id), rule: h.rule_code, message: h.rule_message });
    }
  }

  if (blocked.length) {
    // 不抛错：抛错会把上面那些留痕一起回滚。返回"被挡住的名单"，调用方据此处理。
    return { run_id: Number(run.id), period, calculated: 0, slips: 0,
             gross_total: 0, net_total: 0, blocked };
  }

  // 门禁（考勤未封账 / 绩效未封存）在库里，抛出来就是业务码，由 errors.mjs 映射。
  // 抛错 → 整事务回滚 → 上面那条 INSERT 一起消失。
  const n = (await tx.query('SELECT fn_payroll_calc($1) n', [run.id])).rows[0].n;

  const s = (await tx.query(
    `SELECT count(*)::int n, COALESCE(sum(gross_amount),0) g, COALESCE(sum(net_amount),0) net
       FROM payslip WHERE pay_run_id=$1`, [run.id])).rows[0];

  return { run_id: Number(run.id), period, calculated: Number(n),
           slips: s.n, gross_total: s.g, net_total: s.net, blocked: [] };
}

/**
 * 年终奖批次：单独一个 pay_run（kind='bonus'），单独计税。
 * ★ 不并进月度批次：合并会把当月累计预扣顶到高档，之后每个月都多扣税。
 */
export async function runBonus(tx, { userId, year, entityId }) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw bizErr('E_ARG_INVALID', 'year 不合理');
  await requireOrg(tx, { userId, resource: RESOURCES.run, orgId: entityId,
    dim: 'payroll_legal_entity', action: 'write' });

  const period = `${y}-12`;
  let run = (await tx.query(
    `SELECT id, status FROM pay_run
      WHERE period=$1 AND legal_entity_id=$2 AND kind='bonus' ORDER BY id LIMIT 1`,
    [period, entityId])).rows[0];
  if (!run) {
    run = (await tx.query(
      `INSERT INTO pay_run(period, legal_entity_id, kind) VALUES ($1,$2,'bonus')
       RETURNING id, status`, [period, entityId])).rows[0];
  }

  const n = (await tx.query('SELECT fn_payroll_bonus_calc($1) n', [run.id])).rows[0].n;
  const s = (await tx.query(
    `SELECT count(*)::int n, COALESCE(sum(gross_amount),0) g,
            COALESCE(sum(tax_amount),0) t, COALESCE(sum(net_amount),0) net
       FROM payslip WHERE pay_run_id=$1`, [run.id])).rows[0];
  return { run_id: Number(run.id), period, kind: 'bonus', calculated: Number(n),
           slips: s.n, gross_total: s.g, tax_total: s.t, net_total: s.net };
}

export async function listRuns(tx) {
  // ★ 带上 legal_entity_id 与法人名：一个月两个法人就有两个批次，
  //   列表上不写法人就分不清"这个 2026-08 是哪家公司的" ——
  //   而且两行的期间完全一样，看起来像重复数据。
  return (await tx.query(
    `SELECT pr.id, pr.period, pr.status, pr.calc_version, pr.sealed_at,
            pr.legal_entity_id,
            COALESCE(le.name, '法人 #' || pr.legal_entity_id) AS entity_name,
            count(p.id)::int slips,
            COALESCE(sum(p.net_amount),0) net_total
       FROM pay_run pr
       LEFT JOIN payslip p ON p.pay_run_id = pr.id
       LEFT JOIN legal_entity le ON le.id = pr.legal_entity_id
      GROUP BY pr.id, pr.period, pr.status, pr.calc_version, pr.sealed_at,
               pr.legal_entity_id, le.name
      ORDER BY pr.period DESC, pr.id DESC`)).rows;
}

/**
 * 发薪主体列表（供界面选择）。
 * ★ 为什么不用 contract.entities：它要「合同」的读权限，而算薪专员没有 ——
 *   于是界面上拿到空列表，表现为"法人下拉是空的"。这里只要求发薪读权限。
 */
export async function entitiesForPayroll(tx, { userId }) {
  await requireSession(tx, { userId, resource: RESOURCES.run, action: 'read' });
  // ★ 两个来源合并：法人主档（名字、统一社会信用代码、盖章全称都在这）
  //   与"已经有批次但主档还没登记"的那些 id。
  //   ★ 为什么不只用主档：实测演示库里 legal_entity 是**空**的
  //     （回填只在迁移时跑，而批次是后来灌数据才有的），
  //     于是界面上法人下拉是空的 —— 而算薪明明能跑。
  //   合并后两种情况都能选；名字缺失时写"法人 #N（待补全）"，**不编造**一个看起来像真的主体名。
  const rows = (await tx.query(
    `SELECT id, name, COALESCE(stamp_name, name) AS stamp_name, is_active, false AS placeholder
       FROM legal_entity
      UNION ALL
     SELECT DISTINCT pr.legal_entity_id AS id,
            '法人 #' || pr.legal_entity_id || '（待补全）' AS name,
            NULL AS stamp_name, true AS is_active, true AS placeholder
       FROM pay_run pr
      WHERE NOT EXISTS (SELECT 1 FROM legal_entity le WHERE le.id = pr.legal_entity_id)
      ORDER BY is_active DESC, id`)).rows;
  return {
    rows: rows.map((r) => ({ ...r, id: Number(r.id) })),
    // 这些主体签出来的合同/工资单表头是无效的，界面要提一句
    incomplete: rows.filter((r) => r.placeholder).length,
  };
}

/**
 * 工资条明细 + 逐字段掩码。
 *
 * ★ 权限求值必须**在循环外**。fn_field_action(user, resource, field, scene)
 *   只与身份/资源/字段/场景有关，与哪一行无关。原来把它写在 for 里，
 *   于是 20 张工资条 × 2 个字段 = 40 次查询求同一个答案。
 *   这类"求值提到循环外"不是性能优化，是**语义修正**：
 *   写在循环里会让人以为"每一行的权限可能不同"，而它不会。
 */
export async function listSlips(tx, { userId, runId }) {
  if (!Number.isInteger(runId) || runId <= 0) throw bizErr('E_ARG_INVALID', 'run 必须是正整数');

  await requireSession(tx, { userId, resource: RESOURCES.slip });

  // ★ 行闸：这条 SQL 原来只有 `WHERE p.pay_run_id=$1`，**没有任何 scope 过滤**。
  //   后果不是报错，是越权：任何能打开工资条列表的角色，只要知道 run id
  //   就能看到该批次**全部人**的工资条 —— 跨门店、跨法人。
  //   权限矩阵 Pm6b 测的是 /api/payslip（另一个入口），所以 14 条断言全绿
  //   也没碰到这里：洞换个入口就复现，而换个入口的洞不会被上一轮的断言覆盖。
  //   现在用 fn_scope_people（170：那是行闸的唯一表达式，不许手抄 EXISTS
  //   tmp_scope_org）—— 花名册、合同、离职单、发放清单收口在同一个函数上。
  //
  // ★ 日期取**发薪期末**，与打印页、发放清单同一个表达式（payroll-period.mjs）。
  //   口径必须是期末：补打上月单时按今天判"人在不在我范围内"，被调走的人会
  //   凭空消失、刚调进来的人会凭空多出来，而工资条列表与打印页会给出两份
  //   人数不同的单子 —— 两份都不会报错。
  const run = (await tx.query(
    'SELECT period, legal_entity_id FROM pay_run WHERE id=$1', [runId])).rows[0];
  // 批次不存在时返回空列表，**不改 404**。
  // ★ 两处契约不同不是不一致，是用途不同：本接口的调用方是列表页，列表页对
  //   "这个批次还没有条"与"批次不存在"的处理一致（都显示空）；打印页是单个动作，
  //   必须区分，所以那边抛 E_PAYRUN_NOT_FOUND。别来"统一"这里，会把列表页的
  //   空态变成一张错误页。
  if (!run) return [];

  // ★ 法人闸：门店行闸回答"你在不在这个店"，这一条回答"这个人的钱是不是
  //   **你这条线**发的"。A 店 HR 受权管 A 店，而 A 店里可能有人挂在 B 法人发薪 ——
  //   他该看到这个人，不该看到这个人的工资条。
  //   ★ 写法照打印页（payslip-print.mjs 的 requireOrg）与 /api/payslip，
  //     不另发明一套判断：维度名从 sys_perm_dim 取 kind，新增维度不用改这里。
  //   ★ 被拒是 **403**，不是"少几行"。静默少行是最难查的形态 —— 人会以为
  //     "这个人本来就没有工资条"，而真相是"你没权看"。
  await requireOrg(tx, {
    userId, resource: RESOURCES.slip, orgId: Number(run.legal_entity_id),
    dim: 'payroll_legal_entity', action: 'read',
  });

  const fields = ['net_amount', 'si_employee'];
  const act = {};
  for (const f of fields) {
    act[f] = (await tx.query('SELECT fn_field_action($1,$2,$3,$4) a',
      [userId, RESOURCES.slip, f, 'detail'])).rows[0].a;
  }

  // ★★ 第四道闸（180）：**人员闸** —— 你该不该看"这**个人**"的工资条。
  //   前三道闸回答的是别的问题：行闸=哪个店、法人闸=哪条发薪线、掩码=哪个字段。
  //   而"店长能不能看下属的工资条"它们都没回答 —— 于是店长拿到本店 11 行。
  //   用户的原话是："所有人自己只能看自己的，除了 hr 专职人员。"
  //   ★ 判据是**能力**不是角色名（177 立的规矩）：有 payroll_slips_read_all
  //     就能看他人；没有就只看自己。新增角色只需授权，不用改代码；
  //     忘授的后果是"只看自己"（fail-closed），而不是意外看到全店。
  //   ★ 与行闸/法人闸是**叠加**不是替代：他看自己那一行时，仍然要过组织范围
  //     （万一他已经不在本店了，那这一行本来就不该出现在这个店的视图里）。
  const seeAll = (await tx.query('SELECT fn_role_can($1,$2,$3) o',
    [userId, 'payroll_slips_read_all', 'read'])).rows[0].o === true;
  // 认不出"我是谁" → 空列表，**不是报错**："你没有工资条"与"查询失败"是两件事。
  // ★ 这里不退回"把 userId 当人员 id"（leave.mjs 为兼容测试留的那个口子）：
  //   工资条是钱，猜一个人然后把他的工资条给我看，是最坏的一种"能跑"。
  const selfId = seeAll ? null
    : (await tx.query('SELECT fn_my_person($1) p', [userId])).rows[0].p;
  if (!seeAll && selfId === null) return [];

  // ★ 带上姓名与工号：界面上原来只有 employee_id（1、2、3），
  //   而"这行是谁"是 HR 看这张表的第一件事 —— 让他去花名册按 id 反查，等于没做。
  const slips = (await tx.query(
    `SELECT p.id, p.employee_id, pe.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            p.gross_amount, p.net_amount, p.si_employee, p.tax_amount, p.leave_deduct
       FROM payslip p LEFT JOIN person pe ON pe.id = p.employee_id
      WHERE p.pay_run_id=$1
        AND p.employee_id IN (SELECT employee_id FROM fn_scope_people(${periodEndSql('$2')}))
        AND ($3::bigint IS NULL OR p.employee_id = $3)
      ORDER BY p.id`, [runId, run.period, selfId])).rows;

  const items = (await tx.query(
    `SELECT payslip_id, item_code, amount FROM payslip_item
      WHERE payslip_id = ANY($1::bigint[]) ORDER BY payslip_id, item_code`,
    [slips.map(s => s.id)])).rows;

  const bySlip = new Map();
  for (const it of items) {
    if (!bySlip.has(String(it.payslip_id))) bySlip.set(String(it.payslip_id), []);
    bySlip.get(String(it.payslip_id)).push({ item_code: it.item_code, amount: it.amount });
  }

  const mask = (v, action) => (v === null || action === 'visible' ? v : null);

  return slips.map(s => ({
    id: s.id,
    employee_id: s.employee_id,
    // ★ 这两列 SQL 早就取了，但 map 里漏了 —— 于是接口只回 id，
    //   注释写的"带上姓名与工号"没生效，而"这行是谁"是 HR 看这张表的第一件事。
    //   多门店多法人验收里发现的（它只能按 id 反查姓名）。
    full_name: s.full_name,
    employee_no: s.employee_no,
    gross_amount: s.gross_amount,
    net_amount: mask(s.net_amount, act.net_amount),
    si_employee: mask(s.si_employee, act.si_employee),
    // 掩码后的值给 null 而不是 0：0 会被读成"这个人实发 0 元"，
    // 而真相是"你看不到"。action 一起回传，前端才能决定渲染 *** 还是 —。
    _actions: act,
    items: bySlip.get(String(s.id)) || [],
  }));
}

/** 勾稽：必须为空。暴露成接口，因为"没人看"是这类判据的唯一失败方式。 */
export async function consistency(tx) {
  const rows = (await tx.query('SELECT * FROM v_payslip_consistency')).rows;
  return { rows, ok: rows.length === 0 };
}
