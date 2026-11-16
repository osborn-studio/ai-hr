// ============================================================================
// app/services/payslip-print.mjs · 分门店可打印工资单
// ----------------------------------------------------------------------------
// 这一层解决的事：财务每月把工资单按门店打印出来、发到店、让员工签收。
// 现状是"导出 CSV → 在 Excel 里按部门筛 N 次 → 手工套一张模板"，
// 三个后果都很实在：
//   ① 模板发到店长手里，等于把别的门店的薪资一起发出去（漏删一行就泄露）；
//   ② 表头（公司名/期间）是手填常量，换月漏改一处就印错期间；
//   ③ 一人一块的版式靠手动分页符，调一次人就要重插上百个断点。
//
// ★ 四条设计取舍：
//
//   ① **按成本组织（门店）分组，由库出数、不由前端筛。**
//      前端筛意味着把全公司的人先发到浏览器再挑出来 —— 那和"发一份全公司
//      模板给店长"没有区别，只是把泄露点从文件挪到了网络响应里。
//
//   ② **收入/扣款靠金额正负号分，不新增"方向"列（暂时）。**
//      009 只有 amount，没 direction。加列要动 v_payslip_consistency
//      （全项目唯一的对账基准），属于 L3，得单开一轮。
//      在那之前：amount > 0 归收入、< 0 归扣款、= 0 单独列"零项"
//      （零项不是噪音：它说明这一期确实算了这一项，只是金额为 0）。
//
//   ③ **打印页在服务端渲染，不用前端拼。**
//      工资单要能"离线留存"（财务归档、劳动仲裁时举证）。前端拼的页面
//      依赖 JS 与接口活着；服务端出的 HTML 存下来就是一张能打印的凭证。
//
//   ④ **不带银行账号、不带身份证号。**
//      打印件会贴在店里、会被拍照转发。这两样东西对"签收"没有作用，
//      对"被整包拖走"作用很大（见 140 的同一条处置）。
//
// ★★ 171 补的一道闸（这是本文件最要紧的一段注释）：
//   上面四条都是"页面长什么样"，而**"谁能看到哪些行、哪个字段、哪个法人"一条都没写** ——
//   于是 71ce396 那次权限矩阵验收之后，这个入口上仍然留着三个洞，形态与刚被审计
//   抓出的四处越权完全一样：`requireSession` 起手、SQL 里没有任何 scope 过滤、
//   net_amount 直接原样进 HTML、批次挂的法人根本没看。A 店 HR 打开打印页，
//   看到的是全集团的钱。
//
//   补的方式是"往同一个函数里加"，不是"给打包入口另写一份"：
//     ① 行闸  `p.employee_id IN (SELECT employee_id FROM fn_scope_people(...))`
//              —— 170 立的规矩：那是行闸的**唯一表达式**，不许再手抄 EXISTS。
//              取"期末"那一天，与门店归属同一口径（补打上月单，印的是上月所在的店）。
//     ② 法人  `requireOrg(payroll_legal_entity)` —— 算与看是两件事（PM6b），
//              看的那一侧也要按同一个维度收口。被拒时整批不出数，不静默降级。
//     ③ 掩码  `fn_field_action(payslip, net_amount, scene)` —— 场景由调用方给：
//              页面是 list、导出（含打包 zip）是 export。**掩码只在这里做一次**，
//              单份打印与批量打包因此不可能给出两个答案。
//
//   ★ 规矩：以后任何"整批出数"的入口（新的导出、新的打印、AI 工具），
//     都必须走 sheet()，不许自己拼一条 SELECT。理由不是代码复用，
//     是**权限口径只能有一处**：两份口径必然不同步，而不同步的那一天，
//     是在审计报告里发现的。
// ============================================================================
import { requireOrg, requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
// ★ 发薪期末的表达式从这里取，不在这条 SQL 里手写一遍：
//   原来"期末"在这里、工资条列表里没有日期、发放清单里是今天 —— 三份口径。
//   同一批数据被三个入口读，三个人名对不上时没人知道该信哪一份。
import { periodEndSql } from './payroll-period.mjs';

export const RESOURCES = { read: 'payroll_run' };

const isId = (v) => Number.isInteger(v) && v > 0;
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * 一张打印单的数据：按门店分组的人 + 每人的项目明细。
 * @param {number} runId  pay_run.id
 * @param {number|null} orgId 只出这个门店（含子树）；null = 全部分组
 * @param {'list'|'export'} scene 字段掩码的场景。页面 list、导出/打包 export
 */
export async function sheet(tx, { userId, runId, orgId = null, scene = 'list' }) {
  await requireSession(tx, { userId, resource: RESOURCES.read, action: 'read' });
  if (!isId(runId)) throw bizErr('E_ARG_INVALID', 'run 必须是正整数（批次 id）');
  if (orgId !== null && orgId !== undefined && !isId(Number(orgId))) {
    throw bizErr('E_ARG_INVALID', 'org 必须是正整数（成本组织 id）');
  }
  const org = orgId === null || orgId === undefined ? null : Number(orgId);

  const run = (await tx.query(
    `SELECT r.id, r.period, r.status, r.legal_entity_id, r.calc_version, r.sealed_at,
            l.name AS entity_name, l.stamp_name AS entity_stamp
       FROM pay_run r
       LEFT JOIN legal_entity l ON l.id = r.legal_entity_id
      WHERE r.id = $1`, [runId])).rows[0];
  if (!run) throw bizErr('E_PAYRUN_NOT_FOUND', `发薪批次 ${runId} 不存在`);

  // ★ 法人闸：这一批的**发薪主体**在不在我的范围里。
  //   原来的注释说"算与看是两件事，看的那一侧也要收口"是针对 /api/payslip 的
  //   （PM6b），打印走的是另一个入口 —— 同一个洞换个入口就复现了：
  //   集团HR 只授了法人 1，却能把法人 2 的工资单打出来。
  //   用 requireOrg 而不是手写 EXISTS：维度有 org / entity 两种 kind，
  //   落两张临时表，按维度名硬编码的那一天就是新增维度的那一天。
  await requireOrg(tx, {
    userId, resource: RESOURCES.read, orgId: Number(run.legal_entity_id),
    dim: 'payroll_legal_entity', action: 'read',
  });

  // ★ 字段闸：工资条字段属于**工资条**（payslip）这个资源，不是发薪批次
  //   （payroll_run）—— 拿错资源码去问，结果永远是 masked（问错了对象）。
  //   ★ 求值在循环外：它只与身份/资源/字段/场景有关，与哪一行无关。
  const netAction = (await tx.query(
    'SELECT fn_field_action($1,$2,$3,$4) a',
    [userId, 'payslip', 'net_amount', scene === 'export' ? 'export' : 'list'])).rows[0].a;
  const maskNet = netAction !== 'visible';

  // 门店与岗位都按**发薪期末**取归属，不按"今天"：
  // 补打上个月的单，若按今天取，调到别的店的人会印成新门店 —— 而这张纸
  // 是给上个月的钱签字的。
  // ★ 行闸与归属用**同一个日期表达式**：两个人看同一份单，不可能一个按期末、
  //   一个按今天，于是"人在这张单上、但不在我范围内"这种半截状态不存在。
  const people = (await tx.query(
    `SELECT p.id AS payslip_id, p.employee_id, p.gross_amount, p.net_amount,
            pe.full_name,
            (SELECT n.no FROM employee_no n
              WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
              ORDER BY n.assigned_at DESC LIMIT 1) AS employee_no,
            (SELECT a.org_id FROM employee_org_assignment a
              WHERE a.employee_id = pe.id AND a.dim_code = 'cost_org'
                AND daterange(a.valid_from, a.valid_to, '[]') @> ${periodEndSql('$2')}
              ORDER BY a.valid_from DESC LIMIT 1) AS org_id,
            (SELECT o.name FROM employee_org_assignment a
               JOIN org_unit o ON o.id = a.org_id
              WHERE a.employee_id = pe.id AND a.dim_code = 'cost_org'
                AND daterange(a.valid_from, a.valid_to, '[]') @> ${periodEndSql('$2')}
              ORDER BY a.valid_from DESC LIMIT 1) AS org_name
       FROM payslip p
       JOIN person pe ON pe.id = p.employee_id
      WHERE p.pay_run_id = $1
        AND p.employee_id IN (
              SELECT employee_id FROM fn_scope_people(${periodEndSql('$2')}))
      ORDER BY org_name NULLS LAST, employee_no NULLS LAST, pe.full_name`,
    [runId, run.period])).rows;

  const items = (await tx.query(
    `SELECT pi.payslip_id, pi.item_code, si.name, pi.amount, pi.is_provisional
       FROM payslip_item pi
       JOIN salary_item si ON si.code = pi.item_code
       JOIN payslip p ON p.id = pi.payslip_id
      WHERE p.pay_run_id = $1
      ORDER BY si.code`, [runId])).rows;

  const bySlip = new Map();
  for (const it of items) {
    if (!bySlip.has(it.payslip_id)) bySlip.set(it.payslip_id, []);
    bySlip.get(it.payslip_id).push({
      code: it.item_code, name: it.name,
      amount: Number(it.amount),
      // 正负号分方向（见文件头 ②）。0 单独一类，不当成噪音丢掉。
      side: Number(it.amount) > 0 ? 'up' : (Number(it.amount) < 0 ? 'down' : 'zero'),
      provisional: it.is_provisional === true,
    });
  }

  const filtered = org === null ? people : people.filter((x) => Number(x.org_id) === org);

  const rows = filtered.map((p) => {
    const list = bySlip.get(p.payslip_id) || [];
    return {
      payslip_id: Number(p.payslip_id),
      employee_id: Number(p.employee_id),
      employee_no: p.employee_no,
      full_name: p.full_name,
      org_id: p.org_id === null ? null : Number(p.org_id),
      org_name: p.org_name || '未归店',
      gross: num(p.gross_amount),
      // ★ 掩码给 null，不给 0：0 会被读成"这个人实发 0 元"，而真相是"你看不到"。
      //   打印页把 null 印成「—」（见 html 里的 moneyOr），不是 0.00。
      net: maskNet ? null : num(p.net_amount),
      net_action: netAction,
      up: list.filter((x) => x.side === 'up'),
      down: list.filter((x) => x.side === 'down'),
      zero: list.filter((x) => x.side === 'zero'),
    };
  });

  // 按门店分组（保持 SQL 的排序：门店 → 工号 → 姓名）
  const groups = [];
  const index = new Map();
  for (const r of rows) {
    const key = r.org_id === null ? 'null' : String(r.org_id);
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push({
        org_id: r.org_id, org_name: r.org_name, people: [],
        gross: 0, net: 0,
      });
    }
    const g = groups[index.get(key)];
    g.people.push(r);
    g.gross += Number(r.gross || 0);
    // ★ 合计也随掩码走：一个人被掩就整组合计为 null。
    //   掩了明细却给出合计，等于把总数漏出去（140 的 paylist 同一条处置）。
    g.net = (r.net === null || g.net === null) ? null : g.net + Number(r.net);
  }

  return {
    run: {
      id: Number(run.id), period: run.period, status: run.status,
      legal_entity_id: Number(run.legal_entity_id),
      // ★ 甲方主体名从**主档**来，不从调用方参数来（见 html 的注释）
      entity_name: run.entity_name,
      entity_stamp: run.entity_stamp,
      calc_version: Number(run.calc_version),
      sealed_at: run.sealed_at,
    },
    org_id: org,
    groups,
    totals: {
      people: rows.length,
      stores: groups.length,
      gross: Math.round(groups.reduce((a, g) => a + g.gross, 0) * 100) / 100,
      net: groups.some((g) => g.net === null)
        ? null
        : Math.round(groups.reduce((a, g) => a + Number(g.net || 0), 0) * 100) / 100,
    },
    // 出了一次字段判定，就把它写出去：前端才知道该画「—」还是数值，
    // 断言也才有东西可查（而不是靠 SQL 去猜"这个 null 是掩码还是缺数据"）。
    fields: { net_amount: netAction },
  };
}

// ---------------------------------------------------------------------------
// 打印页（服务端渲染）
// ---------------------------------------------------------------------------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v || 0).toLocaleString('zh-CN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// ★ 被掩码的金额印成「—」，**不是 0.00**。
//   `Number(null || 0)` 会得到 0，于是"你看不到实发"会被印成"这个月实发 0 元" ——
//   一张写着 0 元的工资单拿给员工签字，是要出事的（003 的同一句话：
//   0 会被读成真值，null 才是"看不到"）。
const moneyOr = (v, dash = '—') => (v === null || v === undefined ? dash : money(v));

/**
 * 生成可打印 HTML。
 * @param {object} d      sheet() 的返回值
 * @param {object} opts   { perPage: 1|2, company: '公司名' }
 *   ★ company 由调用方给：本仓还没有 legal_entity 主档（只有裸 id），
 *     在那之前打印件上的公司名只能是"法人 #1"或调用方显式传的名字。
 *     这不是排版问题 —— 一张盖了自己公司章的工资单写错主体，是要重开的。
 */
export function html(d, { perPage = 1, company = null } = {}) {
  const per = Number(perPage) === 2 ? 2 : 1;
  // ★★ 顺序是**主档 → 调用方 → 编号兜底**，不能反。
  //   多门店多法人验收（test/multi-org.mjs MO7）抓到过：原来只认调用方参数，
  //   而前端传的是帐套名 —— 集团下两家公司共用一个帐套时，两份工资单表头
  //   是同一个字符串，**分不出是哪家主体发的钱**。
  //   打印件是签收与举证材料，主体不明就要重开。
  const comp = d.run.entity_stamp || d.run.entity_name
    || company || `法人 #${d.run.legal_entity_id}`;
  const slips = [];
  for (const g of d.groups) {
    for (const p of g.people) slips.push({ g, p });
  }

  const one = ({ g, p }, idx) => {
    // ★ 扣款项显示**绝对值**：列头已经写了"扣款项目"，再写 −500.00 会被读成
    //   "又扣了一次"，而工资单是给员工看的东西。合计用的是带符号的原值，
    //   只在显示这一层取绝对值 —— 口径不动，只改呈现。
    const line = (x) => `<tr><td>${esc(x.name)}${x.provisional
      ? '<span class="prov">待确认</span>' : ''}</td>
      <td class="num">${money(Math.abs(x.amount))}</td></tr>`;
    return `<section class="slip">
      <header>
        <div class="co">${esc(comp)}</div>
        <div class="ti">工资单</div>
        <div class="pd">${esc(d.run.period)} · ${esc(g.org_name)}</div>
      </header>
      <div class="who">
        <span>工号 <b>${esc(p.employee_no || '—')}</b></span>
        <span>姓名 <b>${esc(p.full_name)}</b></span>
        <span>门店 <b>${esc(g.org_name)}</b></span>
        <span>期间 <b>${esc(d.run.period)}</b></span>
      </div>
      <div class="cols">
        <div>
          <h4>应发项目</h4>
          <table>${p.up.length ? p.up.map(line).join('')
            : '<tr><td class="sub">（无）</td><td></td></tr>'}</table>
        </div>
        <div>
          <h4>扣款项目</h4>
          <table>${p.down.length ? p.down.map(line).join('')
            : '<tr><td class="sub">（无）</td><td></td></tr>'}</table>
          ${p.zero.length ? `<div class="zero">本期为 0 的项目：${
            p.zero.map((x) => esc(x.name)).join('、')}</div>` : ''}
        </div>
      </div>
      <div class="sum">
        <span>应发合计 <b>${money(p.gross)}</b></span>
        <span class="net">实发合计 <b>${moneyOr(p.net)}</b></span>
      </div>
      <footer>
        <span class="sign">员工签收：</span>
        <span class="date">日期：　　年　　月　　日</span>
        <span class="stamp">（公司盖章）</span>
      </footer>
      <div class="pg">第 ${idx + 1} / ${slips.length} 张</div>
    </section>`;
  };

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>工资单 ${esc(d.run.period)}</title>
<style>
  :root { --ink:#111; --line:#c9ccd1; --sub:#666; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
         color:var(--ink); background:#f4f5f7; }
  .bar { position:sticky; top:0; z-index:9; display:flex; gap:12px; align-items:center;
         padding:10px 16px; background:#fff; border-bottom:1px solid var(--line); }
  .bar b { font-size:14px; }
  .bar .sub { color:var(--sub); font-size:12px; }
  .bar button { margin-left:auto; padding:6px 14px; border:1px solid var(--line);
                border-radius:6px; background:#fff; cursor:pointer; font-size:13px; }
  .sheet { padding:16px; }
  .slip { background:#fff; border:1px solid var(--line); border-radius:6px;
          padding:14px 16px 10px; margin:0 auto 14px; max-width:760px; position:relative; }
  .slip header { display:flex; align-items:baseline; gap:10px;
                 border-bottom:2px solid var(--ink); padding-bottom:6px; }
  .slip .co { font-weight:700; font-size:14px; }
  .slip .ti { font-size:16px; font-weight:700; letter-spacing:2px; }
  .slip .pd { margin-left:auto; color:var(--sub); font-size:12px; }
  .who { display:flex; flex-wrap:wrap; gap:8px 22px; padding:8px 0;
         border-bottom:1px dashed var(--line); font-size:12px; color:var(--sub); }
  .who b { color:var(--ink); font-weight:600; }
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:16px; padding-top:8px; }
  .cols h4 { margin:0 0 4px; font-size:12px; color:var(--sub); font-weight:600; }
  .cols table { width:100%; border-collapse:collapse; }
  .cols td { padding:2px 0; border-bottom:1px dotted var(--line); font-size:12px; }
  .cols td.num { text-align:right; white-space:nowrap; }
  .cols .sub { color:var(--sub); }
  .prov { display:inline-block; margin-left:4px; padding:0 4px; font-size:10px;
          border:1px solid #d9a300; border-radius:3px; color:#8a6a00; }
  .zero { margin-top:6px; font-size:11px; color:var(--sub); }
  .sum { display:flex; gap:28px; justify-content:flex-end; padding:8px 0 6px;
         border-top:1px solid var(--line); margin-top:8px; font-size:13px; }
  .sum .net b { font-size:16px; }
  .slip footer { display:flex; gap:24px; align-items:flex-end; padding-top:10px;
                 border-top:1px dashed var(--line); font-size:12px; color:var(--sub); }
  .slip footer .sign { min-width:220px; border-bottom:1px solid var(--ink);
                       padding-bottom:16px; }
  .slip footer .date { min-width:160px; }
  .slip footer .stamp { margin-left:auto; padding-right:8px; color:#aaa; }
  /* 页码原来是 absolute 定在右下角，正好压在"（公司盖章）"上 ——
     改成正常文档流里的右对齐一行，两张单并排时也不会打架。 */
  .pg { text-align:right; font-size:10px; color:#aaa; padding-top:2px; }
  @page { size:A4; margin:12mm 10mm; }
  @media print {
    body { background:#fff; }
    .bar { display:none; }
    .sheet { padding:0; }
    .slip { border:none; border-radius:0; box-shadow:none; margin:0; max-width:none;
            padding:0 0 8px; page-break-after:always; break-after:page; }
    .slip:last-child { page-break-after:auto; }
    /* 一人一页时每张独占；两人一页时中间加一条剪切线，便于裁开分发 */
    ${per === 1 ? '' : `.slip:nth-child(even) { margin-bottom:0; border-bottom:1px dashed #999;
       padding-bottom:14px; }
       .slip:nth-child(odd) { padding-top:14px; }`}
  }
</style></head>
<body>
  <div class="bar">
    <b>工资单 · ${esc(d.run.period)}</b>
    <span class="sub">${d.totals.stores} 个门店 / ${d.totals.people} 人 ·
      应发 ${money(d.totals.gross)} · 实发 ${moneyOr(d.totals.net)} ·
      每页 ${per} 人${d.totals.net === null
        ? ' ·（实发金额未获授权，显示为「—」；这是字段权限，不是数据为空）' : ''}</span>
    <button onclick="window.print()">打印 / 存 PDF</button>
  </div>
  <div class="sheet">${slips.map(one).join('')}</div>
</body></html>`;
}
