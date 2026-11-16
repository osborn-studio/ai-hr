// ============================================================================
// tools/seed-demo-flow.mjs · 把演示库推到"有数可看"：封考勤 → 算薪 → 会签 → 封账 × 3 期
// ----------------------------------------------------------------------------
// 用法（**必须在 seed-chain.mjs 之后跑**，它只补业务链路，不建组织与人）：
//
//   # ① 空库建帐（另一个同事的脚本）
//   PGLITE_DATA_DIR=/tmp/demo node tools/seed-chain.mjs
//   # ② 本脚本：喂业务流水
//   PGLITE_DATA_DIR=/tmp/demo node tools/seed-demo-flow.mjs
//   # ③ 起服务看页面（★ 注意 SEED_SKIP=1：库已有数据，别再灌一遍种子）
//   SEED_SKIP=1 PGLITE_DATA_DIR=/tmp/demo node app/server.mjs
//
// 真库上一样能用：把 PGLITE_DATA_DIR 换成 DATABASE_URL=postgres://...
//
// 可选环境变量：
//   FLOW_PERIODS=2026-06,2026-07,2026-08   要跑哪几期（默认就是这三个）
//   FLOW_BASE_PERIOD=2026-06               基准月：唯一有考勤明细的那个月（见文件头 ①）
//   FLOW_ENTITY=1                          发薪法人 id（默认 1，seed-chain 只造了这一个）
//
// ----------------------------------------------------------------------------
// 为什么需要这个脚本
// ----------------------------------------------------------------------------
// seed-chain 只建了**主数据**：60 家店 / 364 人 / 账号 / 归属 / 编制 / 两天考勤。
// 它一行工资都没算，于是演示时这几屏是空的：工资条、发放回单、申报表、报表、
// 工资单打印、批量打包 —— 只能演组织架构和权限，太薄。
//
// 而"补工资条"不能直接 INSERT payslip：那样跳到库里能演、一点算薪就露馅，
// 而且演示"未封账不许算薪"这条门禁时，得先有一份**真的没封账的考勤**。
// 所以这里按系统真实的顺序走一遍，**每一步都过门禁**（门禁不是提示，是拒）：
//
//   ① 封考勤   attendance.unclosed(period) 列出"有考勤但未封账"的门店，
//              逐店 attendance.closePeriod(store, period)（会做摘要校验）
//   ② 算薪     payroll.runPayroll({period, entityId})
//              —— 未封账时它会抛 E_ATT_NOT_CLOSED，这正是要演示的那一条
//   ③ 会签     signoff.start → 逐行 signoff.decide（库里只允许签自己那行）
//   ④ 封账     signoff.seal → fn_pay_run_seal（会签没签完、前期未封、累计过期都会拒）
//
// 跑三期（6/7/8 月）而不是一期：**累计预扣要靠多期才看得出东西**。
// 只有一个月时，"累计应纳税所得额"永远等于当月，申报表上的累计列看不出含义。
//
// ----------------------------------------------------------------------------
// 三件必须交代的事（不交代后面会有人踩）
// ----------------------------------------------------------------------------
// ① **7/8 月的人日照 6 月平移**。
//    seed-chain 只在 2026-06-01..03 造了考勤明细。7/8 月没有考勤的话：
//      · "封考勤"这一步是空跑（没有未封账门店），演示不出那条门禁；
//      · 8 名兼职按工时计薪，工时 0 → 应发 0，工资单上一排 0 元。
//    所以本脚本把那几天的班次整月平移（同一个门店、同一个人、同样的五列物理量），
//    只用 INSERT ... SELECT，不重写任何业务逻辑。平移到**已封账的月份会被触发器拦住**
//    （fn_ads_frozen：封账后不可增删改考勤）—— 这正是它该有的行为，脚本按月份顺序跑。
//
// ② **社保政策与个税参数要自己补**。
//    seed-chain 不建 si_policy，而算薪**强依赖**它（缺养老会抛 E_SI_POLICY_MISSING）。
//    这里按上海 2026 的近似费率补四条：养老 8% / 医疗 2% / 失业 0.5% / 公积金 7%，
//    缴费基数上下限 5975–31014。★ 费率是**演示值**，真实客户按当年社保局公布的重录。
//    个税减除费用 5000（tax_param 2026，迁移已建；缺了算薪会 COALESCE 成 5000，不会错）。
//
// ③ **兼职的实发可能是负数，这不是算错**。
//    种子只给了 2–3 天考勤，而社保按**整月**申报基数缴（社保按申报口径，不按出勤），
//    于是按工时计薪的兼职会出现"应发 337、社保 478"。脚本会在末尾把这类人**数出来**，
//    演示时要么说清这一点，要么把 seed-chain 的考勤补满整月（那是它的事，不是这里偷偷改）。
//
// ④ **字段权限要补，否则工资条看起来还是"空的"**。
//    seed-chain 没写 sys_field_permission，而 003 的规矩是"无配置 = masked"，
//    于是实发与社保两列对**所有人**都是 null —— 屏幕上和"没有工资条"长得一样。
//    这里给 老板 / 集团人事 / 薪酬专员 三个角色开 list·detail·export 三档，
//    **刻意不给店长与店员**：掩码本身要能演（店长看本店工资条，实发是「—」）。
//
// ----------------------------------------------------------------------------
// 幂等（演示库要重灌好几轮，脚本必须能重复跑）
// ----------------------------------------------------------------------------
//   · 已封账的期：整段跳过，只打印"已封账（跳过）"；
//   · 已封账的门店：fn_att_unclosed 不会列它，所以不会被重复封；
//   · 平移考勤：NOT EXISTS 守卫（这张表没有 (人,日) 唯一约束，只能自己挡）；
//   · 社保政策：NOT EXISTS 守卫 (city,item,effective_from)。
//
// ★ 不做的事：不改 seed-chain、不改 db/ 迁移、不改 app/ 业务代码、
//   不提交、不 push。全部通过 import 复用 app/services/* 与 app/db.mjs。
// ============================================================================
import { createDb, withTx } from '../app/db.mjs';
import * as attendance from '../app/services/attendance.mjs';
import * as payroll from '../app/services/payroll.mjs';
import * as signoff from '../app/services/signoff.mjs';
import * as payslipPrint from '../app/services/payslip-print.mjs';
import * as declare from '../app/services/declare.mjs';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
// ★ BASE_PERIOD 是"唯一有考勤明细的那个月"：后两个月的人日靠它平移。
//   它必须与 seed-chain 的业务月一致（那边的 PERIOD = 2026-06）。
//   一旦那边改了业务月，这里就会"平移 0 条、封考勤 0 店" —— 那不会报错，
//   只会让"未封账不许算薪"这条门禁演不出来，所以下面有一条显式告警 + 环境变量可覆盖。
const BASE_PERIOD = process.env.FLOW_BASE_PERIOD || '2026-06';
const PERIODS = (process.env.FLOW_PERIODS || '2026-06,2026-07,2026-08')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ENTITY_ID = Number(process.env.FLOW_ENTITY || 1);
const ACTOR_LOGINS = ['payroll', 'demo', 'admin'];   // 按优先级挑一个能算薪 + 能封考勤的账号

const money = (v) => Number(v || 0).toLocaleString('zh-CN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const line = (ch = '─', n = 74) => ch.repeat(n);
// 中文是双宽字符：按 String.length 对齐会让表头和数据错开两格
const w = (s) => [...String(s)]
  .reduce((a, ch) => a + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
const padR = (s, n) => String(s) + ' '.repeat(Math.max(n - w(s), 0));
const padL = (s, n) => ' '.repeat(Math.max(n - w(s), 0)) + String(s);

// ---------------------------------------------------------------------------
// 社保政策（演示费率）+ 个税参数
// ---------------------------------------------------------------------------
// ★ si_policy.id 没有生成方式（012 的列就是 `id bigint PRIMARY KEY`），
//   所以 id 得自己给：取 max(id)+1 逐行插入，不用固定号段（固定号段会和别的种子撞）。
const SI_POLICY = [
  // item,           员工比例, 单位比例, 说明
  ['pension',        0.0800, 0.1600],
  ['medical',        0.0200, 0.0950],
  ['unemployment',   0.0050, 0.0050],
  ['housing_fund',   0.0700, 0.0700],
];
const SI_FLOOR = 5975;
const SI_CEILING = 31014;

async function ensureSiPolicy(db) {
  let inserted = 0;
  for (const [item, emp, employer] of SI_POLICY) {
    // ★ 用 RETURNING 1 数插入条数，不看驱动返回的 rowsAffected / rowCount ——
    //   两个驱动字段名不同（PGlite 与 pg），而这个脚本两边都要能跑。
    // ★ $1 必须显式 `::text`：同一个参数既做插入值（item 是 varchar(24)）
    //   又做比较（p.item = $1），不写转换时 PG 会报
    //   42P08 "text versus character varying" —— 而它看起来像"表结构有问题"。
    const r = await db.query(
      `INSERT INTO si_policy(id, city, item, effective_from, base_floor, base_ceiling,
                             rate_employee, rate_employer)
       SELECT (SELECT COALESCE(max(id), 0) + 1 FROM si_policy),
              '上海', $1::text, '2026-01-01'::date, $2, $3, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM si_policy p
                           WHERE p.city = '上海' AND p.item = $1::text
                             AND p.effective_from = '2026-01-01'::date)
       RETURNING 1`,
      [item, SI_FLOOR, SI_CEILING, emp, employer]);
    inserted += r.rows.length;
  }
  // 个税减除费用：迁移已建 2026 行，这里只是"缺了补上"（缺了算薪会按 5000 兜底）
  await db.query(
    `INSERT INTO tax_param(year, threshold) VALUES (2026, 5000)
     ON CONFLICT (year) DO NOTHING`);
  return inserted;
}

// ---------------------------------------------------------------------------
// 考勤平移：把基准月的班次整月复制到目标月（只为让后两个月有数可看）
// ---------------------------------------------------------------------------
/**
 * @param {object} db
 * @param {string} period 目标月
 * @returns {Promise<number>} 新增人日数
 */
async function copyAttendanceFromBase(db, period) {
  if (period === BASE_PERIOD) return 0;
  const offset = monthsBetween(BASE_PERIOD, period);
  if (offset <= 0) return 0;
  const r = await db.query(
    `INSERT INTO attendance_daily_store(
       employee_id, store_id, work_date, shift_start_at, shift_end_at,
       span_hours, on_duty_hours, off_duty_hours, break_on_duty_hours,
       in_attendance_hours, work_hours, snap_on_duty_break_basis)
     SELECT a.employee_id, a.store_id,
            (a.work_date + ($2 || ' month')::interval)::date,
            a.shift_start_at + ($2 || ' month')::interval,
            a.shift_end_at   + ($2 || ' month')::interval,
            a.span_hours, a.on_duty_hours, a.off_duty_hours, a.break_on_duty_hours,
            a.in_attendance_hours, a.work_hours, a.snap_on_duty_break_basis
       FROM attendance_daily_store a
      WHERE to_char(a.work_date, 'YYYY-MM') = $1
        AND NOT EXISTS (
              SELECT 1 FROM attendance_daily_store b
               WHERE b.employee_id = a.employee_id
                 AND b.work_date = (a.work_date + ($2 || ' month')::interval)::date)
     RETURNING 1`,
    [BASE_PERIOD, String(offset)]);
  return r.rows.length;
}

/** 这个月的考勤封过账没有（封过就不许再往里插人日：fn_ads_frozen 会拒） */
async function isAttendanceClosed(db, period) {
  const rows = (await db.query(
    `SELECT 1 FROM attendance_close
      WHERE period = $1 AND status = 'closed' LIMIT 1`, [period])).rows;
  return rows.length > 0;
}

/** 'YYYY-MM' 相差几个月（b - a）。写成纯函数，避免 to_date 的时区坑。 */
function monthsBetween(a, b) {
  const [ay, am] = String(a).split('-').map(Number);
  const [by, bm] = String(b).split('-').map(Number);
  return (by * 12 + bm) - (ay * 12 + am);
}

// ---------------------------------------------------------------------------
// 字段权限：让"该看到实发的人"看得到（这是演示数据，不是放宽判据）
// ---------------------------------------------------------------------------
// ★ 为什么必须补：seed-chain 没有写 sys_field_permission，而 003 的规矩是
//   **无配置 = masked（fail-closed）**。于是工资条页上实发与社保两列对**所有人**
//   都是 null —— 页面看起来像"没有数"，而真相是"没人被授权"。
//   这和"没有工资条"是两件完全不同的事，但屏幕上长得一样。
//
// ★ 只给四个角色，且**刻意不给店长/店员**：掩码这件事本身要能演
//   （店长看本店工资条、实发是「—」；老板/HR 看得到）。这正是 003 的"只掩码不报错"。
//   scene 三个都给：页面 list、详单 detail、导出/打包 export。
//   ★ admin 为什么在这张名单里：它是演示入口（一登录就要能看全貌）。
//     生产上「系统管理员看不看得到业务数据」应按最小授权收紧，不该照抄这份种子。
const FIELD_GRANTS = {
  roles: ['admin', 'boss', 'group_hr', 'payroll_spec'],
  fields: ['net_amount', 'si_employee'],
  scenes: ['list', 'detail', 'export'],
};
// ★ 店长 / 店员：用户的口径是「实发默认遮住、点开才显示」——**这不是"拿不到"**，
//   而是前端默认渲染 `••••`、点击才展开。既然要在前端显示，后端就必须**把字段放出来**，
//   否则前端拿到的永远是 null，怎么点都点不出数（"一边放一边没放"就是这么来的）。
//   · 只放 net_amount（实发）；si_employee（社保明细）不放开 —— 店长/店员不需要它。
//   · **export 不放开**：导出的文件会被转发、会被存盘，"默认遮住"在文件里不存在，
//     所以打包/导出口径保持掩码。
//   · 与 app/services/payroll.mjs 的掩码白名单是一对：那里若按须掩字段列表走，
//     这边授权才生效；两边必须同改（只改一边 = 掩着或裸着）。
const FIELD_GRANTS_LIMITED = {
  roles: ['store_mgr', 'store_staff'],
  fields: ['net_amount'],
  scenes: ['list', 'detail'],
};

async function ensureFieldPolicy(db) {
  // ★ sys_field_permission.id 也没有生成方式（003 的列就是 bigint PRIMARY KEY），
  //   所以 id 用 "max(id) + row_number()" 现算。
  // ★ 字段名与场景改为**参数化**（$2 / $3）：原来硬编码 VALUES ('net_amount'),('si_employee')，
  //   于是 FIELD_GRANTS.fields 改了也不生效 —— 那种"常量摆着、SQL 不读"最容易骗人。
  let n = 0;
  for (const set of [FIELD_GRANTS, FIELD_GRANTS_LIMITED]) {
    const r = await db.query(
      `INSERT INTO sys_field_permission(id, role_id, resource, field_path, scene, action)
       SELECT (SELECT COALESCE(max(id), 0) FROM sys_field_permission) + row_number() OVER (),
              r.id, 'payslip', f, s, 'visible'
         FROM sys_role r
         CROSS JOIN unnest($2::text[]) AS f
         CROSS JOIN unnest($3::text[]) AS s
        WHERE r.code = ANY($1::text[])
       ON CONFLICT (role_id, resource, field_path, scene) DO NOTHING
       RETURNING 1`,
      [set.roles, set.fields, set.scenes]);
    n += r.rows.length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 挑一个能干活的账号
// ---------------------------------------------------------------------------
/**
 * ★ 为什么不写死账号 id：seed-chain 的账号 id 是 IDENTITY，重灌库就变。
 * ★ 为什么要在这里先判权限：算薪/封考勤都要过岗位层（064）。
 *   等走到一半才 403，报出来的是"某个门店不许操作"——像数据问题，其实是账号选错了。
 */
async function pickActor(db) {
  const rows = (await db.query(
    `SELECT id, login FROM sys_account WHERE login = ANY($1::text[])`,
    [ACTOR_LOGINS])).rows;
  const byLogin = new Map(rows.map((r) => [String(r.login), Number(r.id)]));
  const tried = [];
  for (const login of ACTOR_LOGINS) {
    const uid = byLogin.get(login);
    if (!uid) { tried.push(`${login}(不存在)`); continue; }
    const ok = (await db.query(
      `SELECT fn_role_can($1,'payroll_run','write')     pay_w,
              fn_role_can($1,'attendance_daily','write') att_w`,
      [uid])).rows[0];
    if (ok.pay_w && ok.att_w) return { uid, login };
    tried.push(`${login}(#${uid} 算薪=${ok.pay_w} 封考勤=${ok.att_w})`);
  }
  throw new Error(`没有可用的操作账号：${tried.join('、')}。`
    + '需要同时有 payroll_run 与 attendance_daily 的写权限（seed-chain 的 payroll 账号有）。');
}

// ---------------------------------------------------------------------------
// ① 封考勤
// ---------------------------------------------------------------------------
async function closeAttendance(db, { userId, period }) {
  const before = await withTx(db, (tx) => attendance.unclosed(tx, { period }));
  if (before.all_closed) return { unclosed: 0, closed: 0, failed: [], unverified: [] };

  const failed = [];
  const unverified = [];
  let closed = 0;
  for (const row of before.rows) {
    const storeId = Number(row.store_id);
    try {
      const out = await withTx(db, (tx) => attendance.closePeriod(tx, { userId, storeId, period }));
      closed += 1;
      // verified=false 说明"封账过程中数据在动"（摘要在同一事务里对不上）
      if (out && out.verified === false) unverified.push(storeId);
    } catch (e) {
      failed.push({ storeId, why: String(e.message).split('\n')[0] });
    }
  }
  return { unclosed: before.rows.length, closed, failed, unverified };
}

// ---------------------------------------------------------------------------
// ② 算薪
// ---------------------------------------------------------------------------
async function runPayrollOne(db, { userId, period, entityId }) {
  return withTx(db, (tx) => payroll.runPayroll(tx, { userId, period, entityId }));
}

// ---------------------------------------------------------------------------
// ③ 会签：发起 + 逐行签
// ---------------------------------------------------------------------------
/**
 * ★ 三个会签角色都签给同一个账号（薪酬考勤专员）。
 *   不是为了省事，而是演示库里只有 4 个集团账号，其中**只有 payroll_spec 同时具备**
 *   「payroll_run 写」与"能看到工资表"——老板是只读、人事没有算薪权。
 *   让没权限的人出现在会签行里，等于让人选了却签不了（点了 403，像系统坏了）。
 *   ★ 真实客户应当一个角色一个账号；这一条写在这里，是为了它不会被悄悄"优化"掉。
 */
async function doSignoff(db, { userId, runId }) {
  const roles = (await db.query(
    `SELECT code FROM pay_signoff_role WHERE is_active ORDER BY seq, code`)).rows;
  if (roles.length === 0) return { started: 0, signed: 0 };

  const users = Object.fromEntries(roles.map((r) => [r.code, userId]));
  const started = await withTx(db, (tx) => signoff.start(tx, { userId, runId, users }));

  const st = await withTx(db, (tx) => signoff.status(tx, { userId, runId }));
  const pending = (st.rows || []).filter((r) => r.status === 'pending');
  let signed = 0;
  for (const row of pending) {
    await withTx(db, (tx) => signoff.decide(tx, { userId, id: Number(row.id), ok: true }));
    signed += 1;
  }
  return { started: Number(started.created ?? started.rows ?? pending.length), signed };
}

// ---------------------------------------------------------------------------
// ④ 封账（默认拒"累计过期"，确认后放行 —— 与页面上那个勾选框同一个语义）
// ---------------------------------------------------------------------------
async function doSeal(db, { userId, runId }) {
  try {
    return await withTx(db, (tx) => signoff.seal(tx, { userId, runId, acceptStale: false }));
  } catch (e) {
    const msg = String(e.message || '');
    if (!/E_SEAL_CHAIN_STALE/.test(msg)) throw e;
    // 历史累计与当前前期数据对不上：演示库里这可能是夹具差异，
    // 明确"按现状封账"（真实客户应先去查是谁的累计不一致）。
    warn(`    ! 批次 #${runId} 有人的累计与前期对不上，按现状封账（acceptStale）`);
    return withTx(db, (tx) => signoff.seal(tx, { userId, runId, acceptStale: true }));
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const db = await createDb({
  dataDir: process.env.PGLITE_DATA_DIR || undefined,
  url: process.env.DATABASE_URL || undefined,
});
await db.initSession();

// 前置自检：这个库是不是 seed-chain 灌过的
const pre = (await db.query(
  `SELECT (SELECT count(*)::int FROM person)   persons,
          (SELECT count(*)::int FROM org_unit) orgs,
          (SELECT count(*)::int FROM payslip)  slips,
          (SELECT count(*)::int FROM pay_run)  runs`)).rows[0];
if (!pre.persons) {
  console.error('这个库里没有人员 —— 先跑 seed-chain.mjs 建帐，再跑本脚本。');
  await db.close();
  process.exit(2);
}

const actor = await pickActor(db);

// 基准月自检：没有考勤人日 = 平移不出东西、封考勤也空跑（见 BASE_PERIOD 的注释）
const baseAtt = (await db.query(
  `SELECT count(*)::int n FROM attendance_daily_store
    WHERE to_char(work_date, 'YYYY-MM') = $1`, [BASE_PERIOD])).rows[0].n;
if (!baseAtt) {
  warn(`! ${BASE_PERIOD} 没有任何考勤人日 —— seed-chain 的业务月可能已经改了。`
    + '设 FLOW_BASE_PERIOD=<有考勤的那个月> 再跑，否则后两个月的"封考勤"是空跑。');
}
log(line('═'));
log(`演示数据链路：${PERIODS.join(' / ')} · 法人 ${ENTITY_ID} · 操作账号 ${actor.login}(#${actor.uid})`);
log(`库现状：${pre.orgs} 个组织 · ${pre.persons} 人 · 已有 ${pre.runs} 个批次 / ${pre.slips} 张工资条`);
log(line('═'));

const siInserted = await ensureSiPolicy(db);
log(`社保政策（上海，演示费率 ${SI_POLICY.map((x) => `${x[0]} ${(x[1] * 100).toFixed(1)}%`).join(' · ')}）`
  + `：新增 ${siInserted} 条`);

// 字段权限：不补的话工资条的实发/社保对所有人都是 null（003 的 fail-closed），
// 页面看起来像"没有数" —— 见 ensureFieldPolicy 的注释
const fpInserted = await ensureFieldPolicy(db);
log(`字段权限（payslip.net_amount / si_employee → ${FIELD_GRANTS.roles.join(' / ')} 可见；`
  + `店长与店员保持掩码）：新增 ${fpInserted} 条`);
log('');

const summary = [];

for (const period of PERIODS) {
  log(line());
  log(`── ${period} ${line('-', Math.max(2, 70 - period.length))}`);

  // 批次现状：已封账就整段跳过（幂等）
  const existing = (await db.query(
    `SELECT id, status FROM pay_run
      WHERE period = $1 AND legal_entity_id = $2 AND kind = 'monthly'
      ORDER BY id DESC LIMIT 1`, [period, ENTITY_ID])).rows[0];
  if (existing && existing.status !== 'draft') {
    log(`   批次 #${existing.id} 已是 ${existing.status} —— 整期跳过（幂等）`);
    summary.push({ period, runId: Number(existing.id), status: existing.status, skipped: true });
    continue;
  }

  // ① 考勤：先把这一期的人日补齐，再封账
  //   ★ 已经封过账的月不再平移：那会把行插进冻结期，被 fn_ads_frozen 直接拒 ——
  //     而"封账后不能改考勤"本来就是这条链要演示的东西，不该被脚本绕过去。
  if (await isAttendanceClosed(db, period)) {
    log('   考勤平移：本月已封账，不再补人日（封账后不许改考勤）');
  } else {
    const copied = await copyAttendanceFromBase(db, period);
    if (copied) log(`   考勤平移：从 ${BASE_PERIOD} 复制 ${copied} 条人日到 ${period}（演示数据，见文件头 ①）`);
  }

  const att = await closeAttendance(db, { userId: actor.uid, period });
  if (att.unclosed === 0) {
    log('   封考勤：本期没有"有考勤但未封账"的门店（已封或本就无考勤）');
  } else {
    log(`   封考勤：未封账 ${att.unclosed} 店 → 已封 ${att.closed} 店`
      + (att.unverified.length ? ` · 摘要校验不一致 ${att.unverified.length} 店` : ' · 摘要校验全部一致'));
    if (att.failed.length) {
      warn(`   ! 封账失败 ${att.failed.length} 店：`
        + att.failed.slice(0, 5).map((f) => `店${f.storeId}:${f.why}`).join(' | '));
    }
  }

  // ② 算薪（门禁在库里：未封账会在这里抛 E_ATT_NOT_CLOSED）
  let run;
  try {
    run = await runPayrollOne(db, { userId: actor.uid, period, entityId: ENTITY_ID });
  } catch (e) {
    warn(`   ✗ 算薪被拒：${String(e.message).split('\n')[0]}`);
    warn('     —— 这不是脚本坏了，是门禁在工作（未封账 / 无政策 / 绩效未封存）。');
    summary.push({ period, error: String(e.message).split('\n')[0] });
    continue;
  }
  if (run.blocked && run.blocked.length) {
    warn(`   ✗ 算薪被 before 规则拦下 ${run.blocked.length} 人：`
      + run.blocked.slice(0, 3).map((b) => `${b.rule}`).join(','));
    summary.push({ period, runId: Number(run.run_id), error: 'blocked' });
    continue;
  }
  if (!run.slips) {
    warn(`   ✗ 本期算出 0 张工资条（批次 #${run.run_id}）—— 检查在职区间/月薪标准`);
    summary.push({ period, runId: Number(run.run_id), error: 'empty' });
    continue;
  }
  log(`   算薪：${run.slips} 人 · 应发 ${money(run.gross_total)} · 实发 ${money(run.net_total)}`
    + ` · 批次 #${run.run_id}`);

  // ③ 会签（尽力而为：制度项 PAY_SIGNOFF_REQUIRED 默认 off，所以封账不依赖它；
  //    但页面上的会签卡要有数据可看，且"发起过就必须签完"才是这条路的意义）
  try {
    const sg = await doSignoff(db, { userId: actor.uid, runId: Number(run.run_id) });
    log(`   会签：发起 ${sg.started} 行 · 已签 ${sg.signed} 行`);
  } catch (e) {
    warn(`   ! 会签跳过：${String(e.message).split('\n')[0]}（不影响封账：制度项默认不强制）`);
  }

  // ④ 封账
  try {
    const sealed = await doSeal(db, { userId: actor.uid, runId: Number(run.run_id) });
    log(`   封账：${sealed.status} · ${sealed.sealed_by}`);
    summary.push({ period, runId: Number(run.run_id), status: sealed.status, slips: run.slips });
  } catch (e) {
    warn(`   ✗ 封账被拒：${String(e.message).split('\n')[0]}`);
    summary.push({ period, runId: Number(run.run_id), error: String(e.message).split('\n')[0] });
  }
  log('');
}

// ---------------------------------------------------------------------------
// 收尾自检：把"演示时会被问到的四件事"当场量出来
// ---------------------------------------------------------------------------
log(line('═'));
log('验收：批次 / 工资条 / 打印分组 / 申报表');
log(line('═'));
log(padR('期别', 9) + '  ' + padL('批次', 5) + '  ' + padR('状态', 8) + '  '
  + padL('人数', 5) + '  ' + padL('应发合计', 14) + '  ' + padL('实发合计', 14) + '  '
  + padL('打印分组', 8));

const rows = (await db.query(
  `SELECT pr.id, pr.period, pr.status,
          count(p.id)::int slips,
          COALESCE(sum(p.gross_amount), 0) gross,
          COALESCE(sum(p.net_amount), 0)   net
     FROM pay_run pr LEFT JOIN payslip p ON p.pay_run_id = pr.id
    WHERE pr.period = ANY($1::text[]) AND pr.legal_entity_id = $2
    GROUP BY pr.id, pr.period, pr.status
    ORDER BY pr.period`, [PERIODS, ENTITY_ID])).rows;

let printOk = 0;
for (const r of rows) {
  // 打印分组：走的是接口用的同一个函数（sheet），分组非空才算"打印页有东西"
  let groups = 0;
  try {
    const d = await withTx(db, (tx) => payslipPrint.sheet(tx, {
      userId: actor.uid, runId: Number(r.id), orgId: null }));
    groups = (d.groups || []).length;
  } catch (e) {
    groups = -1;   // -1 = 这一期取不出来（权限或批次状态）
  }
  if (groups > 0) printOk += 1;
  log(padR(r.period, 9) + '  ' + padL(r.id, 5) + '  ' + padR(r.status, 8) + '  '
    + padL(r.slips, 5) + '  ' + padL(money(r.gross), 14) + '  ' + padL(money(r.net), 14) + '  '
    + padL(groups, 8));
}

// 申报表：按（法人, 期别）看有没有数 —— 它只对**已封账**的批次出数
const sealedPeriods = rows.filter((r) => r.status === 'sealed').map((r) => r.period);
for (const period of sealedPeriods) {
  try {
    const b = await withTx(db, (tx) => declare.board(tx, {
      userId: actor.uid, entityId: ENTITY_ID, period }));
    // ★ 用 persons（人数）而不是 rows.length：社保表是一人一险种一行，
    //   数行数会把"364 人"报成"1456 行"，看起来像多报了人。
    const iit = b.iit ? Number(b.iit.persons ?? (b.iit.rows || []).length) : 0;
    const si = b.si ? Number(b.si.persons ?? (b.si.rows || []).length) : 0;
    log(`申报表 ${period}：个税 ${iit} 人 · 社保 ${si} 人`
      + (b.blocked ? ` · 未出数原因=${b.blocked}` : ''));
  } catch (e) {
    warn(`申报表 ${period} 取数失败：${String(e.message).split('\n')[0]}`);
  }
}

// 实发为负的人：兼职"只上了 3 天班、社保却按整月缴"就会这样（见文件头 ③）
const neg = (await db.query(
  `SELECT count(*)::int n FROM payslip p JOIN pay_run pr ON pr.id = p.pay_run_id
    WHERE pr.period = ANY($1::text[]) AND pr.legal_entity_id = $2 AND p.net_amount < 0`,
  [PERIODS, ENTITY_ID])).rows[0].n;
if (neg) {
  log('');
  warn(`! 实发为负 ${neg} 张（几乎肯定是兼职：种子只有 3 天考勤，社保按整月缴）。`
    + '演示时把这一点说清，或把 seed-chain 的考勤补满整月。');
}

log('');
const done = summary.filter((s) => s.status === 'sealed').length;
log(`完成：${done}/${PERIODS.length} 期已封账 · 打印分组非空 ${printOk}/${rows.length} 期`);
log(`下一步：SEED_SKIP=1 PGLITE_DATA_DIR=${process.env.PGLITE_DATA_DIR || '<同前>'} node app/server.mjs`);
await db.close();
process.exit(0);
