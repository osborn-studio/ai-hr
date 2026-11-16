// ============================================================================
// app/services/report.mjs · 报表：页面与导出**同一个数**
// ----------------------------------------------------------------------------
// 这个文件存在的唯一理由，是让"导出的那一份"与"页面上的那一份"
// 只可能是同一个函数返回的同一个结果。
//
// 如果导出另写一句 `SELECT sum(...)`，两份数会先一致、后分叉 ——
// 分叉发生在某次加过滤条件只改了一处的时候，而那时两边都"看起来对"。
// 023 的整套设计（一个指标一份实现 + 三路径交叉核对）就是为这件事，
// 导出不能成为绕过它的后门。
//
// 另一件事：**报表读也要过行闸**。
// 报表函数按 p_org 算数，本身不带行闸；如果接口不判"这个 org 在不在你的范围内"，
// 那么任何登录账号换个 org 参数就能读别的店的工资总额。
// 这类问题在演示里永远不出现 —— 演示总是用权限最大的那个账号。
// ============================================================================
import { requireOrg, requireSession } from './guard.mjs';
import { bizErr } from '../errors.mjs';
import { csv, sha256Hex } from '../csv.mjs';

export const RESOURCES = { report: 'report' };
const RES = RESOURCES.report;

const PERIOD = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

function assertPeriod(period) {
  // ★ 期间写错时，报表函数会返回一排 0，而不是报错。
  //   所以格式必须在**进入 SQL 之前**挡住，否则"2026-3"会得到一份真看得过去的 0。
  if (!PERIOD.test(String(period || ''))) {
    throw bizErr('E_ARG_INVALID', 'period 必须是 YYYY-MM（如 2026-03）');
  }
}

/** 面板 + 三路径核对 + "这一期有没有数据" */
export async function panel(tx, { userId, orgId, period }) {
  if (!Number.isInteger(orgId) || orgId <= 0) throw bizErr('E_ARG_INVALID', 'org 必须是正整数');
  assertPeriod(period);

  // 报表按成本组织口径汇总（人数 / 工时 / 薪酬都归到组织上），所以用 cost_org 维。
  await requireOrg(tx, { userId, resource: RES, orgId, dim: 'cost_org' });

  const p = (await tx.query('SELECT * FROM fn_rpt_panel($1,$2)', [orgId, period])).rows;
  const c = (await tx.query('SELECT * FROM fn_rpt_crosscheck($1)', [period])).rows;
  const has = (await tx.query('SELECT fn_rpt_has_data($1) h', [period])).rows[0].h;
  return { period, org_id: orgId, has_data: has, panel: p, crosscheck: c };
}

/**
 * 看板：异常清单 + 区域汇总。
 * ★ 用 requireSession 而不是 requireOrg：看板没有"一个对象"，它列的是**你范围里的**
 *   所有区域；对象级判断由 fn_dash_group 内部的行闸做（056）。这里只负责灌权限 ——
 *   不灌的话，那几句 SQL 读的是空临时表，于是看板会安静地变成一张空表。
 */
export async function dashboard(tx, { userId, period }) {
  assertPeriod(period);
  await requireSession(tx, { userId, resource: RES });
  const ex = (await tx.query('SELECT * FROM fn_dash_exceptions($1)', [period])).rows;
  const grp = (await tx.query('SELECT * FROM fn_dash_group($1)', [period])).rows;
  const alerts = (await tx.query('SELECT fn_dash_alert_count($1) n', [period])).rows[0].n;
  return { period, alerts: Number(alerts), exceptions: ex, groups: grp };
}

/**
 * 导出：与 panel() 同源，写一条留痕，返回**即将发送的那串字节**。
 * ★ 摘要算在最终字符串上（含 BOM），而不是算在行数组上 ——
 *   校验的人拿到的是文件，比对的也必须是文件。
 */
export async function exportCsv(tx, { userId, orgId, period, now = new Date() }) {
  const data = await panel(tx, { userId, orgId, period });

  // 两段：指标面板 + 交叉核对。
  // CSV 没有多 sheet，而核对结果必须跟着文件走 —— 否则文件离开系统之后，
  // 收到的人无法自证"这份数是三条路径算出来一致的"。
  const panelCsv = csv({
    columns: [
      { key: 'metric', label: '指标编码' },
      { key: 'name', label: '指标' },
      { key: 'value', label: '值', numeric: true },
      { key: 'unit', label: '单位' },
      { key: 'basis', label: '时点基准' },
      { key: 'registered', label: '口径已登记' },
    ],
    rows: data.panel.map((x) => ({ ...x, registered: x.registered ? '是' : '否' })),
  }).slice(1); // 去掉 BOM，拼完再统一加

  const crossCsv = csv({
    columns: [
      { key: 'metric', label: '指标编码' },
      { key: 'path_a', label: 'A 子树', numeric: true },
      { key: 'path_b', label: 'B 分组', numeric: true },
      { key: 'path_c', label: 'C 明细', numeric: true },
      { key: 'ok', label: '一致' },
    ],
    rows: data.crosscheck.map((x) => ({ ...x, ok: x.ok ? '是' : '否' })),
  }).slice(1);

  const head = [
    `# 组织 ${orgId} · 期间 ${period} · ${data.has_data ? '有数据' : '该期无数据（下面的 0 不是 0，是没有数据）'}`,
    '',
    '',
  ].join('\r\n');

  const text = '\uFEFF' + head + panelCsv + '\r\n' + crossCsv;
  const sha = sha256Hex(text);
  const bytes = Buffer.byteLength(text, 'utf8');

  // 留痕与读取在同一个事务：要么"导出成功且留了痕"，要么什么都没发生。
  await tx.query('SELECT fn_report_export_log($1,$2,$3,$4,$5,$6)', [
    String(userId), orgId, period, data.panel.length, bytes, sha,
  ]);

  return {
    text, sha, bytes, row_count: data.panel.length,
    filename: `report_org${orgId}_${period}.csv`,
    _log: { period, org_id: orgId, rows: data.panel.length, bytes, sha256: sha },
  };
}

/** 最近导出（审计用）：只读，按当前账号自己的记录也给不出来，所以按资源判权限 */
export async function recentExports(tx, { userId }) {
  // 导出留痕没有组织维度（一条记录对应"某人导了某组织的一期"），
  // 所以灌权限即可；判断"你能不能看看板/报表"在各自的入口。真实项目这里
  // 应该只给 HRD 与审计角色看，那属于角色授权（020），不属于这一层。
  await requireSession(tx, { userId, resource: RES });
  return (await tx.query(
    `SELECT id, exported_by, org_id, period, row_count, bytes,
            left(content_sha256, 12) AS sha12, exported_at
       FROM public.report_export ORDER BY id DESC LIMIT 20`)).rows;
}
