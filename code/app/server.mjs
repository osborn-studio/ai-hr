import * as outsourcing from './services/outsourcing.mjs';
import {personaFor as outsourcePersona} from './services/persona-guard.mjs';
import * as organizationPlanning from './services/organization.mjs';
import * as advancedTime from './services/advanced-time.mjs';
// ============================================================================
// server.mjs · 最小垂直切片
// ----------------------------------------------------------------------------
// 目的不是"做一个 HR 系统"，是**证明这套架构能连起来**：
//
//   HTTP 请求 → 会话校验 → app_begin_scope 灌四维临时表
//            → 带行闸的 SQL（每维一个 EXISTS + deny 用 NOT EXISTS）
//            → 字段权限求值 → 掩码 → JSON 响应
//
// 这条链路走通了，才说明前面 12 个迁移不是一堆各自合格的零件。
//
// 刻意简化（都写在这里，不藏着）：
//   · 会话用内存 Map，不落库 —— 生产必须换成 sys_session + 可吊销
//   · 没有 TLS / 没有限流 / 没有 CSRF —— 这是切片，不是服务
//   · 没有 HTTP 框架 —— 用 node:http，减少依赖面，便于审阅
// ============================================================================
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { withTx, createDb } from './db.mjs';
import * as foundationBridge from './services/foundation-bridge.mjs';
import { toHttp, bizErr } from './errors.mjs';
import * as leave from './services/leave.mjs';
import * as attendance from './services/attendance.mjs';
import * as payroll from './services/payroll.mjs';
import * as payrollPreview from './services/payroll-preview.mjs';
import * as signoff from './services/signoff.mjs';
import * as payout from './services/payout.mjs';
import * as recruit from './services/recruit.mjs';
import * as perf from './services/perf.mjs';
import * as headcount from './services/headcount.mjs';
import * as salaryImport from './services/salary-import.mjs';
import * as attImport from './services/att-import.mjs';
import { resolveEmployee } from './services/leave.mjs';   // 账号→员工：全系统只有这一份换算
import * as settlement from './services/settlement.mjs';
import * as session from './services/session.mjs';
import * as approval from './services/approval.mjs';
import * as mcp from './services/mcp.mjs';
import * as people from './services/people.mjs';
import * as report from './services/report.mjs';
import * as reportTrend from './services/report-trend.mjs';
import * as punch from './services/punch.mjs';
import * as leaveCashout from './services/leave-cashout.mjs';
import * as leaveRules from './services/leave-rules.mjs';
import * as leaveBoard from './services/leave-board.mjs';
import * as workTime from './services/work-time.mjs';
import * as siDeclare from './services/si-declare.mjs';
import * as declare from './services/declare.mjs';
import * as training from './services/training.mjs';
import * as rosterRule from './services/roster-rule.mjs';
import * as rosterTeam from './services/roster-team.mjs';
import * as rosterBulk from './services/roster-bulk.mjs';
import * as dispatch from './services/dispatch.mjs';
import * as rosterReport from './services/roster-report.mjs';
import * as rosterSwap from './services/roster-swap.mjs';
import * as exam from './services/exam.mjs';
import * as payslipPrint from './services/payslip-print.mjs';
// 171：按门店批量打包。它**不自己取数**，只调 payslipPrint.sheet() 拿数据 ——
// 行闸与掩码因此只有一处（见 services/payslip-pack.mjs 文件头 ②）。
import * as payslipPack from './services/payslip-pack.mjs';
import * as contract from './services/contract.mjs';
import * as offboarding from './services/offboarding.mjs';
import * as siLedger from './services/si-ledger.mjs';
import * as recruitFlow from './services/recruit-flow.mjs';
import * as attException from './services/att-exception.mjs';
import * as examTask from './services/exam-task.mjs';
import * as perfScorer from './services/perf-scorer.mjs';
import * as perfMetric from './services/perf-metric.mjs';
import * as rosterWrite from './services/roster-write.mjs';
// 182：档口范围。只为一件事 —— 把"我落在哪个档口 / 为什么落不上"放进响应。
// 行闸不在这层做（在库里行闸函数 fn_scope_people_station）。
import * as scope from './services/scope.mjs';
import * as severance from './services/severance.mjs';
import * as payslipDiff from './services/payslip-diff.mjs';
// 184：工资条查阅留痕。写入只有一处（recordView），所有出口都调它 ——
// 留痕判据（看自己不记、批量一行、独立事务、失败不挡读）只在一个文件里。
import * as payslipView from './services/payslip-view.mjs';
import * as payslipAck from './services/payslip-ack.mjs';
import * as complianceHk from './services/compliance-hk.mjs';
import * as payslipAckRevoke from './services/payslip-ack-revoke.mjs';
import * as recruitGap from './services/recruit-gap.mjs';
import * as acting from './services/acting.mjs';
import { csv as toCsv, CSV_HEADERS } from './csv.mjs';
// xlsx 写出：与 csv.mjs 并列的另一个"导出格式"，不是另一份取数逻辑 ——
// 两个格式拿的是同一个服务函数的返回值（掩码只有一处，见 csv.mjs 文件头）。
import { writeXlsx, XLSX_HEADERS } from './xlsx-write.mjs';
// 下载头（含中文文件名的 RFC 5987 编码）：xlsx 与 pdf 两个出口共用一份写法。
import { contentDisposition } from './download.mjs';
// HTML → PDF：调本机 Chrome 的 --print-to-pdf。没有 Chrome 时抛 E_PDF_NO_CHROME（→501），
// 不自己画 PDF（理由见该文件头）。
import { htmlToPdf } from './pdf.mjs';
// ★ 别名不能叫 auth：请求处理里已经有一个 `const auth = <bearer token>`。
//   同名会让模块引用在 handler 作用域里被 TDZ 覆盖，报 "Cannot access 'auth' before initialization" ——
//   而它看起来像导入顺序问题，实际是变量遮蔽。
import * as authn from './services/auth.mjs';
import * as foundation from './services/foundation.mjs';
import * as foundationImporter from './services/foundation-import.mjs';
import { rosterTemplate } from './services/foundation-import-template.mjs';
import * as testWorkspace from './services/test-workspace.mjs';
import * as hkTools from './services/hk-tools.mjs';
import * as customerPayroll from './services/customer-payroll.mjs';
import * as customerPerformance from './services/customer-performance.mjs';
import { authorizePersonaRequest, authorizeManagedLegacyRequest, personaFor } from './services/persona-guard.mjs';
import * as employeeSelf from './services/employee-self.mjs';
import { prepareRead, requireOrg, requireSession } from './services/guard.mjs';
import { createLedgerRegistry } from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★ 每次请求重读 index.html：改一行样式就要重启服务的话，调界面会变成
//   "改一次、猜一次"（而且截到的是上一版，看起来像改动没生效）。
//   文件 200KB，读一次的代价远小于重启与误判。
const uiHtml = () => readFileSync(join(HERE, 'index.html'), 'utf8');
const DB = join(HERE, '..', 'db');
// 迁移清单**只有一个来源：db/ 目录本身**（按文件名排序）。
// ★ 原来这里手抄了一串文件名，test/run.mjs 里另有一串 —— 加新迁移时漏改一处，
//   两套测试用的就不是同一个库，而"哪一个不对"没有断言能回答。
const MIGRATIONS = readdirSync(DB).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

// ---------------------------------------------------------------------------
// 迁移核对：**只检测、不执行**
// ---------------------------------------------------------------------------
// 为什么需要它：迁移只在**空库**上跑（见 createApp 里那句 `if (fresh)`），于是
// "已经用起来的库"永远停在建库那天的版本上。本轮这件事咬了三次
// （174 / 178 / 179），而每次的表现都是**"代码没生效"**，不是"迁移没跑"：
//   · 174：/api/org/tree 直接 500（42883：函数不存在）—— 像接口写错了；
//   · 178：可招还是负的 —— 像算式没改；
//   · 179：第 6 次请求还是慢 180 倍 —— 像修复无效。
// 三个现象都不指向"迁移"，所以每次都要有人从头查一遍。
//
// ★ 为什么**只检测、不自动跑**（刻意如此，别顺手改成自动）：
//   旧版本的 PGlite 数据目录没有 schema_migration 账本。
//   新空库会逐文件记录SHA256；对没有可信账本的存量库，不能猜
//   "它停在哪个版本"；一旦猜成"db/ 里全部已应用"，一个缺 174/178/179 的旧库
//   就会被**永久钉成最新** —— 问题从"迁移没跑"升级成"**永远不知道它没跑**"。
//   一句话：**一个错误的账本比没有账本更危险** —— 没有账本时人还会怀疑，
//   有了假账本连怀疑都没了。
//   真要做自动前滚，前提是先有一次**显式对账**（人确认这个库停在哪一版），
//   之后再靠账本自动前滚、失败即停。
//
// 输出只在日志里，**不写库、不动任何断言、不改迁移顺序**。
async function warnPendingMigrations(db) {
  const brief = (list) => list.map((f) => f.slice(0, 3)).join(' ');
  try {
    const hasLedger = Number((await db.query(
      `SELECT count(*)::int n FROM pg_tables
        WHERE schemaname='public' AND tablename='schema_migration'`)).rows[0].n) > 0;

    if (!hasLedger) {
      // ★ "无法核对"不等于"没问题" —— 这种情况只能告诉人怎么自查。
      console.warn('⚠ 迁移无法核对：这个库没有 schema_migration 账本'
        + `（旧版本建库未记账；db/ 现有 ${MIGRATIONS.length} 个迁移）。`);
      console.warn(`  最近三个：${MIGRATIONS.slice(-3).join(' ')}。`
        + '这个库是从旧版本用起来的 —— **重启不会自动追平**新迁移。');
      // ★ 给出可直接执行的下一步，而不是"手工 psql"这种在 PGlite 上根本做不到的话：
      //   这两条命令是配套的（一个只读对账、一个明确指定号前滚），别只给一半。
      console.warn('  对账（只读，不写库）：PGLITE_DATA_DIR=<这个库> node tools/migrate-status.mjs');
      console.warn('  前滚（先停服务，必须显式写号）：PGLITE_DATA_DIR=<这个库> node tools/migrate-apply.mjs --only <编号,...>');
      console.warn('  为什么不自动追平：这个库没有账本，"缺哪几条"只能靠指纹推，'
        + '猜错会把旧库永久钉成最新 —— 错误的账本比没有账本更危险（docs/48 §13.6）。');
      console.warn("  自查某条是否生效（例：179）：SELECT position('force_custom_plan' in prosrc) > 0"
        + " AS has179 FROM pg_proc WHERE proname='app_init_session';");
      return;
    }

    const applied = new Set((await db.query('SELECT file FROM schema_migration')).rows
      .map((r) => String(r.file).trim()));
    const missing = MIGRATIONS.filter((f) => !applied.has(f));
    if (missing.length) {
      console.warn(`⚠ 迁移未应用：${brief(missing)} —— 这个库是从旧版本用起来的，`
        + '重启不会自动追平；先备份，再用 tools/migrate-checked.mjs --only <编号,...> 显式前滚');
    }
  } catch (e) {
    // ★ 检测本身绝不许挡住启动：它只是提示，不是闸门。
    console.warn(`⚠ 迁移检测失败（不影响启动）：${String(e.message).split('\n')[0]}`);
  }
}

// 来源 IP（工资条留痕用，184）：判据与登录限流**同一条** ——
// 只有代理确实会覆盖 X-Forwarded-For 时才信它，否则攻击者可以自己选来源。
// 取不到就 NULL，不编一个 'unknown' 塞进 inet 列（那会变成一条 22P02）。
const reqIp = (req) => {
  const xff = process.env.TRUST_PROXY === '1'
    ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return xff || req.socket?.remoteAddress || null;
};

export async function createApp({ apiExtension = null, skipDemoSeed = false, nativeOnly = false } = {}) {
  // ★ 数据目录：默认在内存里（每次启动都是干净库，适合演示与测试）。
  //   设了 PGLITE_DATA_DIR 就持久化到磁盘 —— 否则**重启即丢整个库**，
  //   而那比"会话丢"严重得多：丢的是全部考勤与工资条。
  //   设了 DATABASE_URL 就用真 PostgreSQL（连接池）—— 那条路本机未验证。
  const dataDir = process.env.PGLITE_DATA_DIR || undefined;
  // ★ 多帐套模式下 baseDb 就是**控制库**：它不装业务数据，只装帐套登记。
  //   单库模式下仍是原来的那一个库（PGlite 或 DATABASE_URL）。
  const baseDb = process.env.CONTROL_URL
    ? await createDb({ url: process.env.CONTROL_URL })
    : await createDb({ dataDir, url: process.env.DATABASE_URL || undefined });

  // ★ 多帐套（物理隔离）。设了 CONTROL_URL 就进"一个帐套一个库"模式：
  //   控制库只登记"有哪些帐套、各自连哪个库"，业务请求按 token 前缀选库。
  //   没设就还是原来的单库模式 —— 所有既有行为与断言不受影响。
  const registry = process.env.CONTROL_URL
    ? createLedgerRegistry({ controlUrl: process.env.CONTROL_URL, control: baseDb })
    : null;

  // 请求级"当前库"：用 ALS 传，不靠参数一层层往下传（那要改几十处签名，
  // 而漏传一处就变成"这条 SQL 打在控制库上"—— 症状是查不到表）。
  const reqCtx = new AsyncLocalStorage();
  const activeDb = () => reqCtx.getStore()?.db || baseDb;

  // 路由代理：单库时每个方法都直接落到 baseDb，多帐套时落到当前请求的库。
  const db = {
    get driver() { return activeDb().driver; },
    query: (sql, params) => activeDb().query(sql, params),
    exec: (sql) => activeDb().exec(sql),
    initSession: () => activeDb().initSession(),
    _checkout: () => activeDb()._checkout(),
    // ★ 这两个是 withTx 在 PGlite 分支上用的（排队 + 那条唯一连接）。
    //   代理**必须**一并转发：少转发一个，症状是登录直接 500 ——
    //   而错误是 `db._lock is not a function`，读起来像"漏了个 import"。
    _lock: (fn) => activeDb()._lock(fn),
    get _unsafeConn() { return activeDb()._unsafeConn; },
    close: () => baseDb.close(),
    get raw() { return baseDb.raw; },
  };

  // 已存在迁移过的库不再重跑：迁移里有 CREATE TABLE，重跑会炸。
  // 用核心表识别空库；仅空库建立迁移账本，不猜测存量库历史。
  const fresh = (await db.query(
    `SELECT count(*)::int n FROM pg_tables
      WHERE schemaname='public' AND tablename='sys_perm_dim'`)).rows[0].n === 0;
  await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
  // ★ 迁移只在空库上跑。上了真 PG 之后，**迁移应该由部署步骤跑**，
  //   而不是每次起服务顺手建表 —— 多副本同时启动就会撞在一起。
  //   切片保留这个便利，但要写出来：它是便利，不是设计。
  if (fresh) {
    // Only a genuinely empty database may establish a complete migration ledger.
    // Never infer or adopt migration history for an existing customer database.
    await db.exec(`CREATE TABLE schema_migration (
      file varchar(128) PRIMARY KEY, sha256 char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), note varchar(200))`);
    for (const m of MIGRATIONS) {
      const sql = readFileSync(join(DB, m), 'utf8');
      // A single exec keeps BEGIN/schema/ledger/COMMIT on one connection.
      // withTx requires app_init_session(), which early migrations create.
      const hash = createHash('sha256').update(sql).digest('hex');
      const fileLiteral = m.replaceAll("'", "''");
      await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migration(file,sha256,note)
        VALUES('${fileLiteral}','${hash}','fresh database initialization');\nCOMMIT;`);
    }
  }
  // ★ 不是空库 → 只**检测**有没有该跑而没跑的迁移，打一行警告。
  //   为什么不自动跑，见 warnPendingMigrations 的注释：错误的账本比没有账本更危险。
  else await warnPendingMigrations(db);

  // 每个连接都要建临时表 —— 这是 app_init_session 存在的理由。
  // 池化驱动由 db.mjs 在取连接时逐条做（WeakSet 记已初始化的连接）。
  await db.initSession();

  // 会话有效期。★ 必须在 if (fresh) 之外：写在里面会被块级作用域关住，
  //   于是登录路径拿到 "SESSION_TTL is not defined" —— 一个看起来像漏了 import 的错。
  const SESSION_TTL = '12 hours';

  // ★ 种子只在空库时灌：持久化之后重启再灌一遍会撞主键，
  //   而那个报错看起来像"数据被改坏了"。
  // ★ SEED_SKIP=1：只跑迁移、不灌演示种子。
  //   建帐（065）与连锁演示数据（tools/seed-chain.mjs）走自己的入口 ——
  //   否则"开一个新客户"永远等于"抄一遍内置演示数据"。
  // ★ 控制库永远不灌演示种子：它的职责只有"登记有哪些帐套"。
  //   往控制库里灌 10 家店与 20 个人，会让"这套系统的业务数据在哪"变成一个
  //   没人能一句话回答的问题。
  const skipSeed = skipDemoSeed || process.env.SEED_SKIP === '1' || !!process.env.CONTROL_URL;
  if (fresh && skipSeed) {
    await db.exec(`INSERT INTO sys_data_scope(id,name,combinator) VALUES (1,'全集团','intersection')`);
  } else if (fresh) {
  // ---- 种子：维度 / 资源 / 范围 / 授权 / 数据 ----
  await db.exec(`
    -- 064 起四维词表也在迁移里登记（它属于 schema 事实）→ 种子必须幂等
    INSERT INTO sys_perm_dim(code,kind,label) VALUES
      ('cost_org','org','成本组织'),
      ('attendance_org','org','考勤组织'),
      ('payroll_legal_entity','entity','发薪法人'),
      ('si_entity','entity','参保主体')
    ON CONFLICT (code) DO NOTHING;
    -- ★ 这三个资源码 064 起也在迁移里登记（资源码是 schema 事实，不是演示数据）。
    --   种子这里保留 ON CONFLICT：**种子必须能在"已经迁完的库"上重跑**，
    --   否则每加一个迁移就要同步改种子，而漏改的表现是 23505 而不是"少了什么"。
    INSERT INTO sys_perm_resource(resource_code,label,temporal_basis) VALUES
      ('attendance_daily','考勤人日','CURRENT'),
      ('payslip','工资条','CURRENT'),
      ('leave_request','请假单','CURRENT')
    ON CONFLICT (resource_code) DO NOTHING;
    INSERT INTO sys_data_scope(id,name,combinator) VALUES (100,'集团HR','intersection'),(200,'A店HR','intersection');
    INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
      -- 集团HR = 整棵树（node_subtree）。写成枚举 10,11 的话，它做不了
      -- 华东区/新店上的任何操作 —— 而"集团"这个身份本来就是这个意思。
      (100,'cost_org','node_subtree',ARRAY[1]::bigint[]),
      -- 考勤组织仍只给两家店：两个维度**刻意不同源**，
      -- 这样"四维各自独立"这件事才有被看见的机会（同源时看不出来）。
      (100,'attendance_org','nodes',ARRAY[10,11]::bigint[]),
      (100,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
      (100,'si_entity','nodes',ARRAY[1]::bigint[]),
      (200,'cost_org','nodes',ARRAY[10]::bigint[]),
      (200,'attendance_org','nodes',ARRAY[10]::bigint[]),
      (200,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
      (200,'si_entity','nodes',ARRAY[1]::bigint[]);
    -- user 1: 集团HR；user 2: A店HR；user 3: 无任何授权
    -- ★ user 3 也要有**角色**，只是没有数据范围：064 之后"没角色"= 403（岗位不许），
    --   而这里要演示的是"岗位允许、范围为空 → 200 + 0 行"。两者不是一件事，
    --   混成一样的话，"看不到"到底是没职责还是没范围就分不清了。
    INSERT INTO sys_data_scope(id,name,combinator) VALUES (300,'无范围','intersection');
    -- ★ 5 个演示账号都要有角色：064 之后"没角色"= 403，
    --   而 3/5 号演示的是"岗位允许、范围为空 → 200 + 0 行"，不是"连岗位都没有"。
    INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,effective_from) VALUES
      (1,1,1,100,'2026-01-01'),(2,2,2,200,'2026-01-01'),
      (3,3,17,300,'2026-01-01'),(5,5,17,300,'2026-01-01');
    -- ★ user 4 刻意**不给**直接授权：它演示的是"组织继承"（020）。
    --   给它补一条直接角色，X 组那条"来源 = org"的断言就会变成 direct@null ——
    --   而那不是"权限配错了"，是"演示账号被我改坏了"。

    -- 字段权限：net_amount 在 user1 可见、user2 掩码
    -- ★ 导出/打包（scene=export）是**独立一档**（003）：不配就是 fail-closed masked。
    --   这里给它和 list 一样的档位 —— 不是"顺手放宽"，而是：
    --   171 的批量打包走的就是 export 档，全都不配的话，财务打出来的每张单
    --   实发都是「—」，那不是"更安全"，是"这个功能没法用"。
    --   生产上这一档要按岗位另配（导出文件会被转发到微信群）。
    INSERT INTO sys_field_permission(id,role_id,resource,field_path,scene,action) VALUES
      (1,1,'payslip','net_amount','list','visible'),
      (2,2,'payslip','net_amount','list','masked'),
      (3,1,'payslip','net_amount','detail','visible'),
      (4,2,'payslip','net_amount','detail','masked'),
      (5,1,'payslip','net_amount','export','visible'),
      (6,2,'payslip','net_amount','export','masked');
    -- 考勤数据：A店(10) 与 B店(11) 各一条
    INSERT INTO attendance_daily_store(id,employee_id,store_id,work_date,shift_start_at,shift_end_at,
      span_hours,on_duty_hours,off_duty_hours,break_on_duty_hours,in_attendance_hours,work_hours,snap_on_duty_break_basis)
    VALUES
      (1,1,10,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance'),
      (2,2,11,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance');
    -- 工资条
    -- ★ 不再写显式 id：pay_run.id / payslip.id 都是 IDENTITY，
    --   显式写会让序列停在 1，而"序列停在 1"不会立刻报错 ——
    --   它等到**第一次真正自增**时才 23505，届时报的是"主键冲突"，
    --   真因是种子写死了 id。所以这里按业务键（period / employee_id）回查。
    INSERT INTO pay_run(period,legal_entity_id,status) VALUES ('2026-03',1,'draft');
    -- 两个工资条必须自洽（明细之和 = 应发 − 社保 − 个税；实发一致），
    -- 否则 v_payslip_consistency 会（正确地）把它们抓出来。
    INSERT INTO payslip(pay_run_id,employee_id,gross_amount,net_amount,si_employee,tax_amount)
    SELECT pr.id, v.emp, v.g, v.n, v.si, v.tax
      FROM pay_run pr,
           (VALUES (1,8000,6500,1000,500),(2,9000,7000,1200,800)) AS v(emp,g,n,si,tax)
     WHERE pr.period='2026-03' AND pr.legal_entity_id=1;
    INSERT INTO payslip_item(payslip_id,item_code,amount)
    SELECT p.id, v.code, v.amt
      FROM payslip p,
           (VALUES (1,'BASE',8000),(1,'SI_EMPLOYEE',-1000),(1,'IIT',-500),
                   (2,'BASE',9000),(2,'SI_EMPLOYEE',-1200),(2,'IIT',-800)) AS v(emp,code,amt)
     WHERE p.employee_id = v.emp;
    -- 培训：两门课、两场（一场讲满 8h，一场只讲了 4h）
    -- ★ 走 fn_training_enroll / fn_training_attend，不直接 INSERT ——
    --   结业判据只有一份实现，种子没有第二次机会写错（同工号那条的做法）。
    INSERT INTO training_course(code,name,category,std_hours,is_statutory,valid_months,note) VALUES
      ('SAFE-01','安全生产再培训','safety',8,true,12,'每年一次，监管会查'),
      ('ONB-01','新员工入职培训','onboarding',4,false,NULL,'员工手册、安全告知、岗位职责');
    INSERT INTO training_session(course_id,legal_entity_id,starts_at,ends_at,hours,trainer,place,capacity,status,created_by)
    SELECT c.id,1,'2026-02-10T09:00:00+08','2026-02-10T17:00:00+08',8,'张老师','A店培训室',20,'done','group_hr'
      FROM training_course c WHERE c.code='SAFE-01';
    INSERT INTO training_session(course_id,legal_entity_id,starts_at,ends_at,hours,trainer,place,capacity,status,created_by)
    SELECT c.id,1,'2026-03-05T14:00:00+08','2026-03-05T18:00:00+08',4,'李主管','A店培训室',20,'done','group_hr'
      FROM training_course c WHERE c.code='ONB-01';
    -- 张三两场都学完（12 学时）；李四安全培训只到 4 小时（不结业）+ 入职培训学完
    SELECT fn_training_enroll(
      (SELECT s.id FROM training_session s JOIN training_course c ON c.id=s.course_id
        WHERE c.code='SAFE-01'), 1, 'group_hr');
    SELECT fn_training_attend(
      (SELECT e.id FROM training_enrollment e JOIN training_session s ON s.id=e.session_id
         JOIN training_course c ON c.id=s.course_id
        WHERE c.code='SAFE-01' AND e.employee_id=1), NULL, 'group_hr');
    SELECT fn_training_enroll(
      (SELECT s.id FROM training_session s JOIN training_course c ON c.id=s.course_id
        WHERE c.code='ONB-01'), 1, 'group_hr');
    SELECT fn_training_attend(
      (SELECT e.id FROM training_enrollment e JOIN training_session s ON s.id=e.session_id
         JOIN training_course c ON c.id=s.course_id
        WHERE c.code='ONB-01' AND e.employee_id=1), NULL, 'group_hr');
    SELECT fn_training_enroll(
      (SELECT s.id FROM training_session s JOIN training_course c ON c.id=s.course_id
        WHERE c.code='SAFE-01'), 2, 'group_hr');
    SELECT fn_training_attend(
      (SELECT e.id FROM training_enrollment e JOIN training_session s ON s.id=e.session_id
         JOIN training_course c ON c.id=s.course_id
        WHERE c.code='SAFE-01' AND e.employee_id=2), 4, 'group_hr');
        -- 考试：入职培训一张 3 题卷（单选/判断/多选各一），张三考过（100 分）
    -- ★ 走 fn_exam_start / fn_exam_submit，不直接 INSERT exam_answer ——
    --   判分只有一份实现（库里），种子不另算一遍。
    INSERT INTO exam_paper(course_id, code, name, pass_score, duration_min, max_attempts)
    SELECT id,'ONB-EXAM','入职培训结业考',60,30,3 FROM training_course WHERE code='ONB-01';
    INSERT INTO exam_question(paper_id, seq, kind, stem, options, answer, score)
    SELECT p.id, v.seq, v.kind, v.stem, v.options::jsonb, v.answer, v.score
      FROM exam_paper p,
           (VALUES
             (1,'single','员工请假流程，正确的是哪一步？',
              '[{"k":"A","t":"先不来上班，事后补个微信"},{"k":"B","t":"提前在系统提交，由主管审批"},{"k":"C","t":"让同事代填一张纸"}]'::text,'B',40::numeric),
             (2,'judge','发现燃气泄漏，应先关闭总阀再开窗通风。',
              '[{"k":"A","t":"对"},{"k":"B","t":"错"}]','A',30),
             (3,'multi','以下哪些情形必须佩戴防护用品？（多选）',
              '[{"k":"A","t":"使用清洁剂"},{"k":"B","t":"油炸作业"},{"k":"C","t":"前台收银"}]','A,B',30)
           ) AS v(seq,kind,stem,options,answer,score)
     WHERE p.code='ONB-EXAM';
    DO $seed_exam$
    DECLARE
      v_paper bigint;
      v_a     bigint;
      v_q1    bigint;
      v_q2    bigint;
      v_q3    bigint;
    BEGIN
      SELECT id INTO v_paper FROM exam_paper WHERE code='ONB-EXAM';
      SELECT id INTO v_q1 FROM exam_question WHERE paper_id=v_paper AND seq=1;
      SELECT id INTO v_q2 FROM exam_question WHERE paper_id=v_paper AND seq=2;
      SELECT id INTO v_q3 FROM exam_question WHERE paper_id=v_paper AND seq=3;
      v_a := fn_exam_start(v_paper, 1, NULL);
      PERFORM fn_exam_submit(v_a, jsonb_build_array(
        jsonb_build_object('q', v_q1, 'picked', 'B'),
        jsonb_build_object('q', v_q2, 'picked', 'A'),
        jsonb_build_object('q', v_q3, 'picked', 'A,B')));
    END $seed_exam$;

    -- 社保政策与个税参数：算薪的输入，不存在就没有一次薪算得对
    INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,rate_employee,rate_employer) VALUES
      (1,'上海','pension','2026-01-01',5975,31014,0.08,0.16);
    INSERT INTO tax_param(year,threshold) VALUES (2026,5000) ON CONFLICT DO NOTHING;

    -- 外包：一对账就出差异的样例。差异只用来演示，不会被"顺手结掉"。
    -- 组织树 + 组织级授权：用户 4 不在 sys_user_role 里，
    -- 它的权限**全部**来自「挂在 A店 → A店所属区域被授权」这条继承链。
    INSERT INTO org_unit(id,parent_id,name,path) VALUES
      (1,NULL,'集团','001'),(30,1,'华东区','001.030'),
      (10,30,'A店','001.030.010'),(11,30,'B店','001.030.011');
    INSERT INTO sys_user_org(user_id,org_id,effective_from) VALUES (4,10,'2026-01-01');
    INSERT INTO sys_org_grant(org_id,role_id,data_scope_id,effective_from,granted_by,reason)
      VALUES (30,2,200,'2026-01-01','group_hr','集团统一：华东区各店 HR 同一套权限');

    -- 集团制度 + 门店覆盖
    INSERT INTO policy_def(code,name,domain,value_type,allow_org_override,override_floor,unit) VALUES
      ('BREAK_DEDUCT','在岗休息是否从工时扣除','ATTENDANCE','bool',true,'store',''),
      ('CLOSE_DAY','考勤封账日','ATTENDANCE','numeric',false,'group','日'),
      ('SHIFT_TOL','排班弹性','ATTENDANCE','numeric',true,'region','分');
    INSERT INTO policy_value(policy_code,effective_from,value_num,published_by,reason) VALUES
      ('BREAK_DEDUCT','2026-01-01',1,'group_hr','集团统一：扣除在岗休息'),
      ('BREAK_DEDUCT','2026-07-01',0,'group_hr','7 月起不扣'),
      ('CLOSE_DAY','2026-01-01',5,'group_hr','每月 5 日封账'),
      ('SHIFT_TOL','2026-01-01',30,'group_hr','区域可调，默认 30');
    INSERT INTO policy_override(org_id,policy_code,effective_from,value_num,reason,approved_by)
      VALUES (10,'BREAK_DEDUCT','2026-01-01',0,'A店为高档店，休息计入工时','area_hr');

    -- 编制：逐级下分（集团→区域→门店），默认口径
    INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from) VALUES
      (1,'cost_org',10,'2026-01-01'),(2,'cost_org',11,'2026-01-01');
    INSERT INTO headcount_budget(org_id,period,version,quota,set_by,reason) VALUES
      (1,'2026-03',1,30,'board','集团总编 30 个'),
      (30,'2026-03',1,20,'group_hr','集团批给华东区 20 个'),
      (10,'2026-03',1,12,'area_hr','A店 12 个'),
      (11,'2026-03',1,5, 'area_hr','B店 5 个');

    -- 招聘：C店 3 个编，已入职 0，开了 2 个名额的需求并发出 1 个 offer
    INSERT INTO org_unit(id,parent_id,name,path) VALUES (12,30,'C店','001.030.012');
    INSERT INTO headcount_budget(org_id,period,version,quota,set_by,reason)
      VALUES (12,'2026-03',1,3,'area_hr','C店 3 个编');
    INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
      VALUES (12,'店员',2,'2026-03-01','旺季补人','store_mgr');
    SELECT fn_offer_issue(
      (SELECT id FROM requisition WHERE org_id=12 LIMIT 1),
      'CAND-001','候选人甲','店员',7000,'2026-12-31'::date,'2026-03-05'::date,'hr','首批发 offer');

    -- 绩效：5 月周期，尚在评（未封存 -> 系数为空 -> 若此时算薪会被门禁拒绝）
    INSERT INTO perf_scheme(id,version,name,effective_from) VALUES (1,1,'2026 版绩效方案','2026-01-01');
    INSERT INTO perf_grade(scheme_id,grade,min_score,max_score,factor,target_pct) VALUES
      (1,'A',90,100,1.5000,20),(1,'B',75,89.99,1.0000,70),(1,'C',0,74.99,0.5000,10);
    INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status) VALUES
      (1,'Q2-2026','2026 二季度','2026-04-01','2026-06-30','2026-06','open');
    INSERT INTO perf_result(cycle_id,employee_id,state,score,grade) VALUES
      (1,1,'scored',95,'A'),(1,2,'scored',80,'B');
    INSERT INTO perf_result(cycle_id,employee_id,state,note) VALUES
      (1,3,'excluded','入职未满一个考核期');

    INSERT INTO supplier(id,code,name) VALUES (1,'S001','甲劳务服务');
    INSERT INTO outsourced_worker(id,supplier_id,full_name,worker_code,valid_from) VALUES
      (1,1,'外包甲一','W001','2026-01-01'),(2,1,'外包甲二','W002','2026-01-01');
    INSERT INTO supplier_rate(supplier_id,effective_from,unit_price) VALUES (1,'2026-01-01',30.0000);
    INSERT INTO outsourced_timesheet(worker_id,work_date,hours,confirmed_by) VALUES
      (1,'2026-03-01',8,'店长'),(1,'2026-03-02',8,'店长'),(2,'2026-03-01',6,'店长');
    INSERT INTO supplier_timesheet(worker_id,work_date,hours,submitted_by) VALUES
      (1,'2026-03-01',8,'jia'),(2,'2026-03-01',5,'jia');
    INSERT INTO person(id,full_name) VALUES (1,'张三'),(2,'李四');
    -- 工号：种子里的两个人是"上线前就在册"的员工，与真实上线一样先补号再开工。
    -- 走 fn_assign_employee_no（而不是直接 INSERT）：编号规则与"不得改分配"的判据
    -- 只有一份实现，种子没有第二套机会写错。
    SELECT fn_assign_employee_no(1,'E0001');
    SELECT fn_assign_employee_no(2,'E0002');
    -- 任职 + 月薪标准：事假扣款的日薪从这里取（不读工资条）
    -- 档案：身份证是**虚构**的（品牌与个人信息脱敏）；它的用途是让"字段掩码"有东西可掩
    INSERT INTO person_profile(person_id,profile_type,profile_value) VALUES
      (1,'national_id','310101199001011234'),
      (2,'national_id','310101199202029876');

    INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
      (1,1,1,'2026-01-01'),
      (2,2,1,'2026-01-01');   -- 审批人：与申请人不是同一个人（自审会被库拒）
    INSERT INTO salary_standard(employment_id,monthly_amount,effective_from) VALUES (1,8000,'2026-01-01');
    -- 请假流：事假扣钱、年假不扣
    -- ★ 假种由迁移 126 预置（ANNUAL/SICK/PERSONAL…），种子不再插 —— 写死 id 会撞主键。
    --   这里只按 code 补额度，id 跟着走。
    INSERT INTO leave_grant(employee_id, leave_type_id, qty, valid_from)
    SELECT 1, t.id, v.qty, '2026-01-01'::date
      FROM (VALUES ('PERSONAL', 10), ('ANNUAL', 5)) AS v(code, qty)
      JOIN leave_type t ON t.code = v.code;

    -- 审批模板：请假一步（角色 2 = 门店HR）。第 1 步解析出 user2（直接授权）
    -- 与 user4（组织继承：授在华东区），申请人自己会被剔除。
    -- 口令：四个账号统一 demo1234（切片用）。摘要由 scrypt 现算，
    -- 库里永远不存明文 —— 这一段是唯一"知道口令"的地方，而它只在建库时跑一次。
    -- ★ 种子口令是**演示数据**，不是后门：任何正确部署都该把它换掉。
    -- 例外：一条在期内、一条已逾期（逾期那条要能在清单里被看见，而不是"记得去查"）
    SELECT fn_exception_open('HC_OVER','org_unit',11,'B店旺季临时多招两人','店长乙',10);
    INSERT INTO exception_registry(kind_code,subject_type,subject_id,reason,owner,created_at,expires_at)
    VALUES ('SETTLE_TOL','settlement',1,'供应商口径差异容忍','财务丙',
            now() - interval '12 days', now() - interval '5 days');

    INSERT INTO approval_template(code,name) VALUES ('LEAVE','请假单');
    INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
    VALUES ((SELECT id FROM approval_template WHERE code='LEAVE'),1,'published','2026-01-01',
            '{"steps":[{"seq":1,"mode":"any","resolvers":[{"kind":"role","role_id":2}]}]}'::jsonb,
            '2026-01-01');
  

    -- 当地职工月平均工资（134）：三倍封顶与补偿金免税额度都按它算。
    -- 由社保上限 ÷ 3 反推一个初值，标"待核对" —— 客户上线第一天就有数可用，
    -- 而不会被误当成官方数据。每年由统计局公布，界面上可改。
    INSERT INTO local_avg_wage(city, wage_year, monthly, note)
    SELECT DISTINCT ON (p.city) p.city,
           EXTRACT(year FROM p.effective_from)::int - 1,
           round(p.base_ceiling / 3, 2),
           '由社保基数上限 ÷ 3 推算，待按统计局公布核对'
      FROM si_policy p WHERE p.base_ceiling > 0
     ORDER BY p.city, p.effective_from DESC
    ON CONFLICT (city, wage_year) DO NOTHING;`);

  // ★ 会话已经落库（030_session.sql）。原来这里是一个 `new Map()`：
  //   重启即全员掉线、无法吊销、也回答不了"这个 token 现在还能不能用"。
  //   现在这里不持有任何会话状态 —— 这一层不该有状态。
  // ★ 显式 id 播种 + BY DEFAULT AS IDENTITY ⇒ **序列不前进**，
  //   第一次自动插入就撞主键（person 这张表这次就撞了）。
  //   与其一张表一张表地记，不如扫一遍 information_schema 全部对齐。
  if (fresh) {
    const ids = (await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public' AND is_identity='YES'`)).rows;
    for (const { table_name, column_name } of ids) {
      await db.query(
        `SELECT setval(pg_get_serial_sequence($1,$2),
                       GREATEST((SELECT COALESCE(max(${column_name}),1) FROM ${table_name}), 1))`,
        [table_name, column_name]);
    }
  }

  // 口令：库里只存 scrypt 派生值。种子口令只在此处出现一次（建库时）。
  for (const u of [1, 2, 3, 4]) {
    await db.query('SELECT fn_credential_set($1,$2)', [u, authn.hashPassword('demo1234')]);
  }
  // user 5：口令是临时口令，必须先改（演示"首次登录强制改密"）
  await db.query('SELECT fn_credential_set($1,$2,$3)', [5, authn.hashPassword('temp1234'), true]);
  }

  // ★ 请求级留痕写在**事务之外**：写在里面的话，失败会随 ROLLBACK 一起消失，
  //   而失败的尝试正是它存在的理由。
  //   日志本身失败时写 stderr —— 那是这条链上最后一条不会失效的通道。
  const logReq = async (actor, action, subject, ok, errCode, detail) => {
    try {
      await db.query('SELECT fn_req_log($1,$2,$3,$4,$5,$6)',
        [String(actor), action, subject, ok, errCode || null,
         detail ? JSON.stringify(detail) : null]);
    } catch (e) {
      console.error('[req-log]', action, errCode, String(e.message).split('\n')[0]);
    }
  };

  // 行闸 SQL 已收进各 service（attendance/payroll/…），这里不再留第二份。
  // ★ 原来这里有一份 scopedSql，只服务 /api/attendance；一旦别的路由也想用，
  //   就会复制一份 —— 两份行闸 SQL 意味着"改了一处没改另一处"的必然性。

  // ---- 安全响应头：一处写，所有响应都带上 ----
  // ★ CSRF 在这套设计里**不成立**，而这不该只是我的口头结论：
  //   凭据走 `Authorization: Bearer`，不是 Cookie。浏览器不会自动带上它，
  //   第三方页面也就无法"借"用户的身份发请求。
  //   代价是 token 存在 JS 里（能被 XSS 读到），所以真正要守的是 XSS ——
  //   下面这条 CSP 就是那个代价的对价。
  // ★ 两套头，不是一个。
  //   接口（JSON / CSV）**不需要任何脚本能力**，所以它的 CSP 是 script-src 'none' ——
  //   比原来那条 'unsafe-inline' 更紧，而且是逐路由可证的。
  //   界面是唯一需要执行脚本的响应，它拿一个**每次请求都换**的 nonce（见下面 HTML 路由）。
  //   nonce 换一次的价值：注入进页面的 <script> 标签没有当次 nonce 就不执行，
  //   而注入者拿不到下一次的 nonce。
  const SEC_HEADERS = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy':
      "default-src 'none'; script-src 'none'; style-src 'none'; "
      + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "
      + "frame-ancestors 'none'",
  };

  // 界面：脚本带 nonce（每次请求换），样式只留 'unsafe-inline'。
  // ★ 这里踩过一次坑：原来写 `style-src 'nonce-x' 'unsafe-inline'`，
  //   看起来"两个都允许"，实际按 CSP3 **nonce 存在时 'unsafe-inline' 被忽略** ——
  //   于是所有 style="..." 属性被拦。症状很隐蔽：页面不是一片白，而是
  //   "滑块不滑、头像没颜色、进度条永远满格"，看起来只是"有点素"。
  //   style 块仍留 nonce 只是为了兼容既有模板；属性级放行靠 'unsafe-inline'。
  //   CSS 注入的危害与脚本注入不是一个量级，这是一条**写明的取舍**。
  const htmlHeaders = (nonce) => ({
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; `
      + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; "
      + "frame-ancestors 'none'",
  });

  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS });
    res.end(s);
  };

  // ★ 写路径只走这一个出口。它替每条路由做同样四件事，顺序也固定：
  //   ① 一个事务（灌权限与写必须在同一连接）
  //   ② 业务码 → HTTP（映射只在 errors.mjs 一处）
  //   ③ 留痕（在事务**外**，否则失败会随 ROLLBACK 一起消失）
  //   ④ 失败不吞原始 message（500 只回 ref）
  //   有了它，"某条写路径忘了留痕/忘了事务"就不会再靠人去数。
  // ★ `send` 是给"响应体不是 JSON"的写路径用的（导出 CSV）：它也要事务、
  //   也要业务码映射、也要留痕，只是最后一步不写 JSON。没有这个出口，
  //   导出会再抄一份 try/catch —— 而抄出来的那份必然少一件（通常是留痕）。
  const runWrite = async (res, { actor, action, subject, fn, send }) => {
    // ★ 限流在**事务之前**判：让它成为一个纯读判断，撞上限时一行都写不进去。
    //   被限的请求**不写日志**（写了就是自我放大：拒绝一次多一条日志 → 更接近上限）。
    //   代价是请求留痕里看不到"被限了多少次" —— 用 v_rate_usage 看用量来补。
    const allowed = (await db.query('SELECT fn_rate_ok($1) o', [String(actor)])).rows[0].o;
    if (!allowed) {
      return json(res, 429, {
        error: 'E_RATE_LIMITED',
        message: '操作过于频繁，请稍后再试（每分钟写操作上限见制度 RATE_WRITE_PER_MIN）',
      });
    }
    try {
      const out = await withTx(db, (tx) => fn(tx));
      await logReq(actor, action, subject ?? null, true, null, out?._log ?? null);
      if (send) return send(res, out);
      return json(res, 200, strip(out));
    } catch (e) {
      const m = toHttp(e);
      await logReq(actor, action, subject ?? null, false, m.body.error, null);
      if (m.status >= 500) console.error('[500]', action, String(e.message).split('\n')[0]);
      return json(res, m.status, m.body);
    }
  };

  // 读请求体：只给"上传文件"这一条路用（其余写接口都在 query 里）。
  // 上限 8MB —— 一份几千行的工资表远小于它，而放开上限等于给自己留一个内存炸弹。
  const readBody = (req, limit = 8 * 1024 * 1024) => new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(bizErr('E_BODY_TOO_LARGE', '文件超过 8MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });

  // 读路径：也走事务，理由与写相同（临时表是会话的），只是不写日志。
  const runRead = async (res, fn, beforeSend = null) => {
    const out = await withTx(db, (tx) => fn(tx));
    // Read-side audit runs in its own transaction after the read commits, but
    // finishes before the HTTP response so clients can immediately inspect it.
    if (beforeSend) await beforeSend(out);
    return json(res, 200, strip(out));
  };

  /**
   * 工资条查阅留痕（184）的**唯一写入出口**：单独一个事务 + 吞错。
   *
   * ★ 为什么单独开事务，而不是在读事务里顺手 INSERT：
   *   读事务可能因为后面某个字段求值失败而 ROLLBACK，日志会跟着消失 ——
   *   而"这个人确实看过了"是已经发生的事实，不该因为一次 500 被抹掉。
   * ★ 为什么吞错：留痕是旁路。写失败（表被改名 / 权限被收 / 磁盘满）时，
   *   已经取到的工资条必须照常返回 200 —— "取证失败"不能升级成"业务不可用"。
   *   代价如实写在明处：写失败时这条日志就丢了，只剩服务端一行警告。
   * ★ 事务边界只在 server（AG14）：服务层收到 tx，不知道怎么开事务。
   *   所以"怎么开事务"写在这里，"记什么"写在 services/payslip-view.mjs。
   */
  const logPayslipView = async (arg) => {
    try {
      await withTx(db, (tx) => payslipView.recordView(tx, arg));
    } catch (e) {
      console.warn('[payslip-view-log] 写入失败（读请求不受影响）：',
        String(e.message).split('\n')[0]);
    }
  };

  /**
   * 品牌线白名单（172）。
   *
   * ★ 为什么不认识的直接拒、而不是让库函数降级：
   *   `fn_station_choices` 的条件是 `brand_line IN ('common', <传入值>)`，
   *   传错名字不会报错 —— 它会静默退化成"只有 common 那几条"，返回一份
   *   **看起来完全正常**的清单。运营以为选的是某条专线，铺下去才发现少了烧腊档，
   *   而铺错之后要 close 再重开，历史编制还留在库里。
   *   前端传的是 `STATION_BRANDS` 自己维护的那份，不会踩；会踩的恰恰是
   *   MCP / curl / 以后的导入 —— 那些是**没人盯着屏幕**的入口。
   */
  const assertBrandLine = async (tx, brand) => {
    const v = String(brand || '').trim() || 'common';
    const known = (await tx.query(
      `SELECT DISTINCT brand_line b FROM station ORDER BY 1`)).rows.map((r) => r.b);
    if (!known.includes(v)) {
      throw bizErr('E_ARG_INVALID', `brand_line「${v}」不在词表里，可选：${known.join(' / ')}`);
    }
    return v;
  };

  /**
   * 把排他约束（SQLSTATE 23P01）翻成人话 —— 只给门店档口用。
   *
   * ★ 为什么必须翻：23P01 落到 toHttp 的兜底映射是
   *   `{"error":"EXCLUSION_VIOLATION","sqlstate":"23P01"}` —— 把 Postgres 的
   *   约束名原样吐给客户端，没有业务码、没有 message，前端只能当"系统错误"。
   *   而它其实是一条**很常见的业务拒绝**：想改起始日的人一定会撞上
   *   （回溯开通 / 同一天点第二次但日期不同 / 脚本批量铺）。
   *
   * ★ 为什么不在库里抛业务码：约束是**唯一的判据**（任何入口都拦得住），
   *   在上面盖一个函数去抛 E_ 码，就把"谁说了算"从约束搬到了那个函数 ——
   *   而函数是会被绕过的（MCP、批量导入、手工 INSERT）。所以拦还是约束拦，
   *   这里只负责**把拒绝翻译成一句能照着做的话**。
   */
  /** 档口名字（错误信息用）。取不到就退回 id —— 但不要退回空串。 */
  const stationLabel = async (tx, stationId) => {
    const r = (await tx.query(`SELECT name FROM station WHERE id = $1`, [stationId])).rows[0];
    return `「${r ? r.name : stationId}」`;
  };

  const rethrowStationOverlap = (e, label, on) => {
    if (e && e.code === '23P01') {
      throw bizErr('E_STN_OVERLAP',
        `档口${label}在 ${on} 与已有的一段开通时间重叠 —— `
        + '要改起始日，请先把原来那段「关闭」到目标日期的前一天，再重新开通');
    }
    throw e;
  };

  /**
   * (门店, 档口) → 那一期有效的 store_station.id（172）。
   *
   * ★ 为什么不是一条 WHERE store_id=? AND station_id=? 就够：
   *   档口是**区间实体**（关了还能再开，`ex_ss_no_overlap` 只禁止同一时点重叠）。
   *   所以"这家店的炉灶档"在库里可能是两行 —— 2019 年那次和 2024 年这次。
   *   配编制与关档必须落到**具体那一段**，否则会把编制配到三年前那次开档上，
   *   而那件事不会报错：新档口的缺岗一直是满的，老的编制一直没人看。
   */
  const resolveStoreStation = async (tx, store, station, on) => {
    const r = (await tx.query(
      `SELECT id FROM store_station
        WHERE store_id = $1 AND station_id = $2
          AND daterange(opened_at, closed_at, '[]') @> $3::date
        ORDER BY opened_at DESC LIMIT 1`, [store, station, on])).rows[0];
    if (!r) {
      throw bizErr('E_STN_NOT_FOUND',
        `门店 ${store} 在 ${on} 没有这个档口（station ${station}）—— 先在「档口配置」里开通它`);
    }
    return Number(r.id);
  };

  // `_log` 是给留痕用的上下文，不进响应体
  const strip = (o) => {
    if (!o || typeof o !== 'object' || !('_log' in o)) return o;
    const { _log, ...rest } = o;
    return rest;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if(apiExtension?.public&&await apiExtension.public({req,res,url,db,readBody}))return;
      // The standard cloud frontend is attached before this handler. Historical
      // standalone assets remain available only through the explicit old entry.
      if(nativeOnly&&!url.pathname.startsWith('/api/')&&!['/login','/livez','/readyz'].includes(url.pathname))return json(res,404,{error:'E_NATIVE_API_REQUIRED',message:'请使用当前工作台入口'});

      // ★ 多帐套：先按 token 前缀选库，再让**整个请求**跑在那个库上。
      //   必须放在最前面 —— 会话表在帐套库里，选错库连"你是谁"都查不出来。
      //   前缀是公开信息（帐套编码写在登录页上），真正的凭据是后面那段随机串；
      //   而那段串在别的库里查不到，所以"拿 A 的 token 打 B"会得到 401。
      if (registry) {
        const b0 = (req.headers.authorization || '').replace('Bearer ', '').trim();
        const code0 = registry.codeOf(b0);
        if (code0) {
          try {
            reqCtx.enterWith({ db: await registry.dbFor(code0) });
          } catch (e) {
            // 不存在的帐套前缀 → 直接拒。**不回落到默认库** ——
            // 回落会让"打错帐套"变成"看到另一个帐套的数据"，那是最坏的一种错。
            const m = toHttp(e);
            return json(res, m.status, m.body);
          }
        }
      }

      // New workspace entry; legacy root remains stable for existing integrations/tests.
      if (req.method === 'GET' && ['/workspace','/workspace.html','/workspace.mjs','/workspace.css','/workspace-permissions.mjs','/employee-self-ui.mjs','/customer-workbench.mjs','/foundation-import-ui.mjs','/organization-view.mjs','/hk-tools-ui.mjs','/scope-tree.mjs','/organization-planning.mjs','/advanced-time-ui.mjs','/legacy-theme.css','/outsourcing-ui.mjs'].includes(url.pathname)) {
        const file = url.pathname === '/workspace' ? 'workspace.html' : url.pathname.slice(1);
        if (file.endsWith('.html')) {
          const nonce = randomBytes(16).toString('base64');
          const html = readFileSync(join(HERE,file),'utf8').replace(/<script\b/g,`<script nonce="${nonce}"`);
          const headers = htmlHeaders(nonce);
          headers['content-security-policy'] = headers['content-security-policy'].replace("style-src 'unsafe-inline'","style-src 'self' 'unsafe-inline'") + "; frame-src 'self'";
          res.writeHead(200, {'content-type':'text/html; charset=utf-8',...headers});
          return res.end(html);
        }
        res.writeHead(200,{'content-type':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8',...SEC_HEADERS});
        return res.end(readFileSync(join(HERE,file),'utf8'));
      }

      // 单页界面。静态、零构建、零依赖 —— 让"权限不同结果不同"能被看见。
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        // nonce 必须**每次请求新生成**：固定 nonce 等于没有 nonce（它会被读出来复用）
        const nonce = randomBytes(16).toString('base64');
        const html = uiHtml()
          .replace('<script>', `<script nonce="${nonce}">`)
          .replace('<style>', `<style nonce="${nonce}">`);
        const headers = htmlHeaders(nonce);
        if (url.searchParams.get('embed') === '1') {
          headers['x-frame-options'] = 'SAMEORIGIN';
          headers['content-security-policy'] = headers['content-security-policy'].replace("frame-ancestors 'none'","frame-ancestors 'self'");
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
        return res.end(html);
      }

      // ---- 探针：免认证，且**只说"能不能干活"** ----
      // ★ 探针为什么要免认证：K8s/Docker 的探针不会带 token。
      //   要凭据的探针等于"永远 unhealthy" —— 于是它会被删掉，
      //   然后服务挂了没人知道。Dockerfile 里当初刻意没写 HEALTHCHECK，
      //   理由就是"别加一个假的"；正确做法是**补一个不需要认证的端点**。
      //
      // ★ 探针为什么不能说太多：它是最容易被外部扫到的地址。
      //   表名、连接串、迁移版本对外部没有用处，对攻击者很有用。
      if (req.method === 'GET' && url.pathname === '/livez') {
        // 只证明"进程还在跑、事件循环没卡住"。不查库：库挂了不该重启这个进程。
        return json(res, 200, { ok: true, uptime_s: Math.round(process.uptime()) });
      }

      if (req.method === 'GET' && url.pathname === '/readyz') {
        // 证明"能干活"：查一次库。查不动就 503 —— 让反代/编排器把流量挪走，
        // 而不是继续往一个已经不能读写的实例上派活。
        try {
          const t0 = Date.now();
          const db_ = (await db.query('SELECT 1 AS one')).rows[0];
          const ms = Date.now() - t0;
          // 只回三个数：库通不通、延迟、当前库里有多少判据组（一个业务无关的规模感）。
          // 不回版本号与表名：那些对外部没有用处。
          const checks = Number((await db.query(
            'SELECT count(*)::int n FROM sys_check_registry')).rows[0].n);
          return json(res, 200, { ok: db_?.one === 1, db_ms: ms, checks_known: checks });
        } catch (e) {
          // ★ 错误细节不外送：探针的响应体是最容易被扫的。
          console.error('[readyz]', String(e.message).split('\n')[0]);
          return json(res, 503, { ok: false });
        }
      }

      // ---- 帐套清单：登录前要能看到"有哪些帐套可选" ----
      // 只回编码与名称，**不回库名** —— 库名是内部拓扑，登录页不需要它。
      if (url.pathname === '/api/ledgers') {
        if(nativeOnly)return json(res,404,{error:'E_NATIVE_API_REQUIRED',message:'请在当前工作台选择授权范围'});
        if (!registry) {
          return json(res, 200, {
            multi: false,
            ledgers: [{ code: 'default', name: '默认帐套', is_default: true }],
          });
        }
        return json(res, 200, { multi: true, ledgers: await registry.list() });
      }

      if (req.method === 'POST' && url.pathname === '/login') {
        const namedLogin = String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
        let loginInput = null;
        if (namedLogin) {
          try { loginInput = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); }
          catch { return json(res, 400, { error: 'E_ARG_INVALID', message: '登录内容不是有效JSON' }); }
          if (!loginInput || Array.isArray(loginInput) || typeof loginInput !== 'object'
              || typeof loginInput.login !== 'string' || !loginInput.login.trim() || loginInput.login.length > 128
              || typeof loginInput.password !== 'string' || loginInput.password.length > 1024) {
            return json(res, 400, { error: 'E_ARG_INVALID', message: '请填写账号和口令' });
          }
        }
        let uid = namedLogin ? 0 : Number(url.searchParams.get('user'));
        const pwd = namedLogin ? loginInput.password : url.searchParams.get('pwd');
        const loginName = namedLogin ? loginInput.login.trim() : String(uid);
        if (!namedLogin && (!Number.isSafeInteger(uid) || uid <= 0)) return json(res, 400, { error: 'E_ARG_INVALID' });

        // ★ 多帐套：登录先选帐套（用友那套）。没传就用默认帐套 ——
        //   单帐套客户永远不会看到这个参数，而多帐套客户不选就等于"进错公司"。
        let loginDb = db;
        let ledgerCode = null;
        if (registry) {
          try {
            ledgerCode = (namedLogin && typeof loginInput.ledger === 'string' ? loginInput.ledger : null) || url.searchParams.get('ledger') || await registry.defaultCode();
            if (!ledgerCode) {
              return json(res, 409, { error: 'E_LEDGER_NONE', message: '实例里还没有任何帐套' });
            }
            loginDb = await registry.dbFor(ledgerCode);
            reqCtx.enterWith({ db: loginDb });
          } catch (e) {
            const m = toHttp(e);
            return json(res, m.status, m.body);
          }
        }

        // 来源：默认取 socket 地址；只有**代理确实会覆盖 XFF** 时才信那个头。
        // ★ 不做这个前提判断就信 XFF，等于让攻击者自己选来源 —— 比不限流更坏。
        const xff = process.env.TRUST_PROXY === '1'
          ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
        const source = xff || req.socket.remoteAddress || 'unknown';

        // ★ 来源限流在**任何账号判断之前**：撞库的特征是"一个来源试很多账号"，
        //   所以它在看到处理哪个账号之前就该被挡住。被限的尝试**不记账**。
        try {
          const blocked = (await loginDb.query('SELECT fn_login_throttled($1) b', [source])).rows[0].b;
          if (blocked) {
            return json(res, 429, {
              error: 'E_LOGIN_THROTTLED',
              message: '同一来源失败次数过多，请 15 分钟后再试（阈值见制度 RATE_LOGIN_FAIL_PER_15M）',
            });
          }
        } catch (e) {
          // 计数读不动时**放行**还是拒绝？这里选放行：
          // 读不动通常意味着库有问题，而那时谁也登不进来 —— 把门再焊死没有意义。
          console.error('[login-throttle]', String(e.message).split('\n')[0]);
        }

        // Resolve names only after source throttling. Numeric query login stays
        // compatible; JSON first accepts the exact configured name, then an ID.
        if (namedLogin) {
          const account = (await loginDb.query(`SELECT id FROM sys_account
            WHERE status='active' AND (login=$1 OR (id::text=$1 AND $1 ~ '^[0-9]+$'))
            ORDER BY CASE WHEN login=$1 THEN 0 ELSE 1 END LIMIT 1`, [loginName])).rows[0];
          uid = account ? Number(account.id) : 0;
        }

        // ★ 认证与会话在同一个事务里：锁的是同一行口令记录。
        //   分成两个事务，两次并发登录就会各读一次旧计数（爆破的经典缺口）。
        let res0;
        try {
          // ① 入账事务：认证结论与失败计数必须**先提交**（否则回滚会把计数抹掉）
          res0 = await withTx(loginDb, async tx => {
            const account=(await tx.query('SELECT status FROM sys_account WHERE id=$1',[uid])).rows[0];
            if(account&&account.status!=='active')throw bizErr('E_AUTH_BAD_CREDENTIAL','账号或口令不正确');
            return authn.authenticate(tx,{userId:uid,password:pwd});
          });
        } catch (e) {
          const m = toHttp(e);
          // ★ 异常路径也要记一条"来源上的失败"：账号被锁时 authenticate 会直接抛，
          //   不记的话"换个账号继续试"永远不会让来源计数上涨 —— 而撞库正是这么做的。
          //   这条记录的失败本身不吞掉原错误（库坏了的话，记不进去也不该掩盖原因）。
          try {
            await withTx(loginDb, (tx) => tx.query('SELECT fn_login_record($1,$2,$3)',
              [source, String(uid), false]));
          } catch { /* 记账失败不改变对调用方的答复 */ }
          await logReq(uid, 'auth.login', `user:${uid}`, false, m.body.error, null);
          return json(res, m.status, namedLogin && m.body.error === 'E_AUTH_BAD_CREDENTIAL'
            ? { error: 'E_AUTH_BAD_CREDENTIAL', message: '账号或口令不正确' } : m.body);
        }

        // ② 结论出来之后再抛：这样"错了一次"已经落库，而错误码仍然准确
        if (res0.status !== 'ok') {
          const code = res0.status === 'locked' ? 'E_AUTH_LOCKED' : 'E_AUTH_BAD_CREDENTIAL';
          const msg = res0.status === 'locked'
            ? `口令错误次数过多，账号锁定至 ${res0.lockedUntil}`
            : namedLogin ? '账号或口令不正确' : `账号或口令不正确（还可以再试 ${Math.max(0, 5 - res0.failedCount)} 次）`;
          await withTx(loginDb, (tx) => tx.query('SELECT fn_login_record($1,$2,$3)',
            [source, String(uid), false]));
          await logReq(uid, 'auth.login', `user:${uid}`, false, code, null);
          return json(res, code === 'E_AUTH_LOCKED' ? 423 : 401, { error: code, message: msg });
        }

        const out = await withTx(loginDb, (tx) => session.issue(tx, { userId: uid, ttl: SESSION_TTL }));
        // 成功也记一条（不参与限流计数，但"谁从哪个来源登进来过"要留得下）
        await withTx(loginDb, (tx) => tx.query('SELECT fn_login_record($1,$2,$3)',
          [source, String(uid), true]));
        await logReq(uid, 'auth.login', `user:${uid}`, true, null, null);
        // ★ 多帐套下 token 必须带帐套前缀：会话存在帐套库里，
        //   而"去哪个库查会话"这件事只能在查会话之前就知道。
        const tok = ledgerCode ? `${ledgerCode}.${out.token}` : out.token;
        return json(res, 200, {
          token: tok, expires_at: out.expires_at, ledger: ledgerCode || undefined,
        });
      }

      // ---- 会话校验：库里三态（ok / expired / revoked），不是一个布尔 ----
      // ★ 同时认第二个头名 `x-aihr-token`：某些网关（平台分享链接、企业反代）
      //   会把 Authorization 整个丢掉，而症状是"登录返回 200，紧接着每个请求都 401"
      //   —— 排查起来像会话没存住，其实是头没到应用。前端两个头一起带，任一到即通过。
      let auth = (req.headers.authorization || req.headers['x-aihr-token'] || '').replace('Bearer ', '').trim();
      if (!auth) return json(res, 401, { error: 'E_UNAUTHENTICATED' });
      // ★ 多帐套：token 形如 `<帐套编码>.<随机串>`。查会话只能用后半段 ——
      //   库里存的是随机串的摘要，带前缀永远查不到，而症状是
      //   "登录返回 200，紧接着每个请求都 401"。
      if (registry && auth.includes('.')) auth = auth.slice(auth.indexOf('.') + 1);

      const sess = await session.check(db, auth);
      if (sess.status === 'missing') return json(res, 401, { error: 'E_UNAUTHENTICATED' });
      if (sess.status !== 'ok') {
        // 过期与吊销**分别回不同的码**：前端处置不同（一个重新登录，一个去问管理员）
        return json(res, 401, {
          error: sess.status === 'expired' ? 'E_SESSION_EXPIRED' : 'E_SESSION_REVOKED',
          revoked_reason: sess.revokedReason,
        });
      }
      const uid = sess.userId;

      // ★ 该改口令的用户，除"改口令"外一律拦住。
      //   用 200 + 提示语的做法会被前端忽略，而忽略的代价是旧口令继续存在。
      if (sess.mustChange && !['/api/me/password','/api/me/logout'].includes(url.pathname)) {
        return json(res, 428, {
          error: 'E_PWD_CHANGE_REQUIRED',
          message: '该账号必须先修改口令（POST /api/me/password）',
        });
      }

      // Versioned domains perform their own current action/scope/field guards.
      // Their trusted actor is derived above, never from request JSON.
      if (apiExtension && (url.pathname.startsWith('/api/v2/') || req.method==='GET'&&url.pathname==='/api/foundation/bootstrap')) {
        if (await apiExtension({ req, res, url, userId: uid, db, readBody, runRead, runWrite })) return;
      }

      if(nativeOnly){
        const personalRead=req.method==='GET'&&['/api/me','/api/me/capabilities','/api/me/sessions','/api/me/roles'].includes(url.pathname);
        const personalWrite=req.method==='POST'&&['/api/me/password','/api/me/logout','/api/me/sessions/revoke'].includes(url.pathname);
        if(!personalRead&&!personalWrite)return json(res,404,{error:'E_NATIVE_API_REQUIRED',message:'请使用当前工作台的业务接口'});
      }

      // Persona restrictions are resolved from the authenticated database account.
      await withTx(db,tx=>authorizeManagedLegacyRequest(tx,{userId:uid,pathname:url.pathname}));
      await withTx(db,tx=>authorizePersonaRequest(tx,{userId:uid,pathname:url.pathname,method:req.method}));

      if(url.pathname.startsWith('/api/hk-tools/')&&req.method==='POST'){
        let input;try{input=JSON.parse((await readBody(req,1024*1024)).toString('utf8'));}
        catch(e){if(e.code)throw e;throw bizErr('E_TY_ARGUMENT','请求内容不是有效JSON');}
        const kind=url.pathname.slice('/api/hk-tools/'.length);
        return await runWrite(res,{actor:uid,action:'hk_tools.calculate',subject:`company:${input.company_id}`,fn:tx=>hkTools.calculate(tx,{userId:uid,kind,input})});
      }

      if(req.method==='GET'&&['/api/customer-payroll/my','/api/training/my','/api/exam/my-board'].includes(url.pathname)){
        const allowed=url.pathname==='/api/training/my'?new Set(['year']):new Set();
        if([...url.searchParams.keys()].some(key=>!allowed.has(key)))throw bizErr('E_TY_ARGUMENT','自助查询按当前登录身份显示，请勿传入人员或范围参数');
        if(url.pathname==='/api/customer-payroll/my')return await runRead(res,tx=>employeeSelf.payroll(tx,{userId:uid}));
        if(url.pathname==='/api/training/my')return await runRead(res,tx=>training.myTraining(tx,{userId:uid,year:url.searchParams.get('year')}));
        return await runRead(res,tx=>exam.myBoard(tx,{userId:uid}));
      }

      if (url.pathname.startsWith('/api/customer-payroll/') || url.pathname.startsWith('/api/customer-performance/')) {
        const pay=url.pathname.startsWith('/api/customer-payroll/');
        const parts=url.pathname.slice((pay?'/api/customer-payroll/':'/api/customer-performance/').length).split('/').filter(Boolean);
        const scope={userId:uid,groupId:url.searchParams.get('group_id'),ledgerId:url.searchParams.get('ledger_id'),companyId:url.searchParams.get('company_id')};
        const args={...scope,batchId:parts[1],cycleId:parts[1]};
        const sendFile=(out,type,filename)=>{
          res.writeHead(200,{'content-type':type,...SEC_HEADERS,...(filename?{'content-disposition':contentDisposition(filename)}:{})});
          return res.end(out);
        };
        if(req.method==='GET') {
          if(pay&&parts[0]==='batches'&&parts.length===1)return await runRead(res,tx=>customerPayroll.listBatches(tx,scope));
          if(pay&&parts[0]==='rules')return await runRead(res,tx=>customerPayroll.listRuleSets(tx,scope));
          if(pay&&parts[0]==='rule-catalog')return await runRead(res,async tx=>{await customerPayroll.listRuleSets(tx,scope);return customerPayroll.ruleCatalog();});
          if(pay&&parts[0]==='input-template.csv'){
            await withTx(db,tx=>customerPayroll.listRuleSets(tx,scope));
            return sendFile(customerPayroll.inputTemplate().csv,'text/csv; charset=utf-8','payroll-input-template.csv');
          }
          if(pay&&parts[0]==='input-template')return await runRead(res,async tx=>{await customerPayroll.listRuleSets(tx,scope);return customerPayroll.inputTemplate();});
          if(pay&&parts[0]==='input-schema')return await runRead(res,async tx=>{await customerPayroll.listRuleSets(tx,scope);return customerPayroll.inputSchema();});
          if(pay&&parts[0]==='batches'&&parts[2]==='report')return await runRead(res,tx=>customerPayroll.report(tx,args));
          if(pay&&parts[0]==='batches'&&parts[2]==='export.csv')return sendFile(await withTx(db,tx=>customerPayroll.exportCsv(tx,args)),'text/csv; charset=utf-8',`payroll-${Number(parts[1])}.csv`);
          if(pay&&parts[0]==='batches'&&parts[2]==='print.html'){
            const html=await withTx(db,tx=>customerPayroll.printHtml(tx,args));
            res.writeHead(200,{'content-type':'text/html; charset=utf-8',...SEC_HEADERS,
              'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});return res.end(html);
          }
          if(!pay&&parts[0]==='cycles'&&parts.length===1)return await runRead(res,tx=>customerPerformance.listCycles(tx,scope));
          if(!pay&&parts[0]==='cycles'&&parts[2]==='report')return await runRead(res,tx=>customerPerformance.report(tx,args));
          if(!pay&&parts[0]==='cycles'&&parts[2]==='payroll-candidates')return await runRead(res,tx=>customerPerformance.getPayrollCandidates(tx,args));
          if(!pay&&parts[0]==='cycles'&&parts[2]==='export.csv'){
            const out=await withTx(db,tx=>customerPerformance.exportReport(tx,args));return sendFile(out.content,'text/csv; charset=utf-8',out.filename);
          }
        }
        if(['POST','PUT'].includes(req.method)) {
          let input;
          try{input=JSON.parse((await readBody(req,12*1024*1024)).toString('utf8'));}
          catch(e){if(e.code)throw e;throw bizErr('E_TY_ARGUMENT','请求内容不是有效JSON');}
          let fn=null;
          if(pay) {
            if(parts[0]==='import-preview'&&req.method==='POST')fn=tx=>customerPayroll.importPreview(tx,{userId:uid,input});
            if(parts[0]==='batches'&&parts.length===1&&req.method==='POST')fn=tx=>customerPayroll.createBatch(tx,{userId:uid,input});
            if(parts[0]==='rules'&&req.method==='POST')fn=tx=>customerPayroll.saveRuleSet(tx,{userId:uid,input});
            if(parts[0]==='rows'&&parts[2]==='mapping'&&req.method==='PUT')fn=tx=>customerPayroll.mapRow(tx,{userId:uid,rowId:parts[1],input});
            if(parts[0]==='rows'&&parts[2]==='inputs'&&req.method==='PUT')fn=tx=>customerPayroll.editRowInputs(tx,{userId:uid,rowId:parts[1],input});
            if(parts[0]==='batches'&&parts[2]==='locale'&&req.method==='PUT')fn=tx=>customerPayroll.setBatchLocale(tx,{...args,input});
            if(parts[0]==='batches'&&req.method==='POST') {
              if(parts[2]==='validate')fn=tx=>customerPayroll.validateBatch(tx,args);
              if(parts[2]==='confirm')fn=tx=>customerPayroll.confirmBatch(tx,args);
              if(parts[2]==='calculate')fn=tx=>customerPayroll.calculateBatch(tx,{...args,input});
              if(parts[2]==='performance')fn=tx=>customerPayroll.applyPerformanceCandidates(tx,{...args,input});
            }
          } else {
            if(parts[0]==='cycles'&&parts.length===1&&req.method==='POST')fn=tx=>customerPerformance.createCycle(tx,{userId:uid,input});
            if(parts[0]==='cycles'&&parts[2]==='scheme'&&req.method==='PUT')fn=tx=>customerPerformance.saveScheme(tx,{...args,input});
            if(parts[0]==='cycles'&&parts[2]==='inputs'&&req.method==='PUT')fn=tx=>customerPerformance.saveInputs(tx,{...args,input});
            if(parts[0]==='cycles'&&parts[2]==='locale'&&req.method==='PUT')fn=tx=>customerPerformance.setCycleLocale(tx,{...args,input});
            if(parts[0]==='cycles'&&parts[2]==='import-preview'&&req.method==='POST')fn=tx=>customerPerformance.importPreview(tx,{...args,input});
            if(parts[0]==='cycles'&&parts[2]==='calculate'&&req.method==='POST')fn=tx=>customerPerformance.calculate(tx,args);
            if(parts[0]==='cycles'&&parts[2]==='confirm'&&req.method==='POST')fn=tx=>customerPerformance.confirm(tx,{...args,input});
            if(parts[0]==='cycles'&&parts[2]==='payroll-candidates'&&req.method==='POST')fn=tx=>customerPerformance.getPayrollCandidates(tx,args);
          }
          if(fn)return await runWrite(res,{actor:uid,action:pay?'customer.payroll':'customer.performance',subject:`${parts[0]}:${parts[1]||'new'}`,fn});
        }
        return json(res,404,{error:'E_TY_NOT_FOUND',message:'业务入口不存在'});
      }

      if(url.pathname.startsWith('/api/outsource/')){
        const parts=url.pathname.split('/').filter(Boolean),actor=await withTx(db,t=>outsourcePersona(t,uid));
        const personal=['store_staff','station_staff','outsourced_staff'].includes(actor?.profile_code);
        const args={userId:uid,groupId:url.searchParams.get('group_id'),companyId:url.searchParams.get('company_id'),ledgerId:url.searchParams.get('ledger_id'),self:url.pathname==='/api/outsource/my'};
        if(req.method==='GET'&&['/api/outsource/board','/api/outsource/my'].includes(url.pathname))return await runRead(res,t=>outsourcing.board(t,args));
        if(req.method==='GET'&&parts[2]==='bills'&&parts.length===4)return await runRead(res,t=>outsourcing.billDetail(t,{userId:uid,id:parts[3]}));
        if(req.method==='GET'&&parts[2]==='bills'&&parts[4]==='print'){const content=await withTx(db,t=>outsourcing.printBill(t,{userId:uid,id:parts[3]}));res.writeHead(200,{'content-type':'text/html; charset=utf-8',...htmlHeaders(randomBytes(16).toString('base64'))});return res.end(content);}
        if(req.method==='GET'&&parts[2]==='bills'&&parts[4]==='export.csv'){const content=await withTx(db,t=>outsourcing.exportBill(t,{userId:uid,id:parts[3]}));res.writeHead(200,{...CSV_HEADERS,...SEC_HEADERS,'content-disposition':contentDisposition('supplier-statement.csv')});return res.end(content);}
        if(['POST','PUT'].includes(req.method)){
          let input;try{input=JSON.parse((await readBody(req)).toString('utf8'));}catch(e){if(e.code)throw e;throw bizErr('E_TY_ARGUMENT','Invalid JSON');}
          let fn;
          if(parts[2]==='suppliers')fn=t=>outsourcing.saveSupplier(t,{userId:uid,id:parts[3]||null,input});
          if(parts[2]==='engagements')fn=t=>outsourcing.saveEngagement(t,{userId:uid,id:parts[3]||null,input});
          if(parts[2]==='contracts')fn=t=>outsourcing.saveContract(t,{userId:uid,id:parts[3]||null,input});
          if(parts[2]==='threads'&&parts.length===3)fn=t=>outsourcing.createThread(t,{userId:uid,input,self:personal});
          if(parts[2]==='threads'&&parts[4]==='messages')fn=t=>outsourcing.postMessage(t,{userId:uid,id:parts[3],input,self:personal});
          if(parts[2]==='threads'&&parts[4]==='resolve')fn=t=>outsourcing.resolveThread(t,{userId:uid,id:parts[3],input});
          if(parts[2]==='bills'&&parts.length===3)fn=t=>outsourcing.createBill(t,{userId:uid,input});
          if(parts[2]==='bills'&&parts[4]==='lines')fn=t=>outsourcing.saveBillLine(t,{userId:uid,billId:parts[3],id:parts[5]||null,input});
          if(parts[2]==='bills'&&parts[4]==='generate')fn=t=>outsourcing.generateBill(t,{userId:uid,id:parts[3]});
          if(parts[2]==='bills'&&parts[4]==='decide')fn=t=>outsourcing.decideBill(t,{userId:uid,id:parts[3],input});
          if(fn)return await runWrite(res,{actor:uid,action:'outsource.'+parts[2],subject:parts[3]||String(input.contract_id||input.group_id),fn});
        }
        return json(res,404,{error:'E_TY_NOT_FOUND'});
      }
      if(url.pathname==='/api/organization/headcount'){
        if(req.method==='GET')return await runRead(res,tx=>organizationPlanning.plans(tx,{userId:uid,groupId:url.searchParams.get('group_id'),period:url.searchParams.get('period')||'2026-11',asOf:url.searchParams.get('as_of')}));
        if(req.method==='PUT'){const input=JSON.parse((await readBody(req)).toString('utf8'));return await runWrite(res,{actor:uid,action:'organization.headcount',subject:String(input.company_id),fn:tx=>organizationPlanning.savePlan(tx,{userId:uid,input})});}
      }
      if(url.pathname.startsWith('/api/time/')){
        const args={userId:uid,groupId:url.searchParams.get('group_id'),period:url.searchParams.get('period')||'2026-10',ledgerId:url.searchParams.get('ledger_id'),companyId:url.searchParams.get('company_id'),self:url.pathname==='/api/time/my'||url.searchParams.get('self')==='true'};
        if(req.method==='GET'&&['/api/time/report','/api/time/my'].includes(url.pathname))return await runRead(res,tx=>advancedTime.report(tx,args));
        if(req.method==='GET'&&url.pathname==='/api/time/export.csv'){const content=await withTx(db,tx=>advancedTime.exportReport(tx,{...args,kind:url.searchParams.get('kind')}));res.writeHead(200,{...CSV_HEADERS,...SEC_HEADERS,'content-disposition':contentDisposition('tyhr-attendance.csv')});return res.end(content);}
        if(['POST','PUT'].includes(req.method)){
          let input;try{input=JSON.parse((await readBody(req)).toString('utf8'));}catch(e){if(e.code)throw e;throw bizErr('E_TY_ARGUMENT','Invalid JSON');}
          const parts=url.pathname.split('/').filter(Boolean);let fn;
          if(parts[2]==='changes'&&parts.length===3&&req.method==='POST')fn=tx=>advancedTime.createChange(tx,{userId:uid,input});
          if(parts[2]==='changes'&&parts[4]==='decide'&&req.method==='POST')fn=tx=>advancedTime.decideChange(tx,{userId:uid,id:parts[3],input});
          if(parts[2]==='corrections'&&req.method==='POST')fn=tx=>advancedTime.correctPunch(tx,{userId:uid,input});
          if(parts[2]==='close'&&req.method==='POST')fn=tx=>advancedTime.closePeriod(tx,{userId:uid,input});
          if(parts[2]==='shifts'&&parts.length===4&&req.method==='PUT')fn=tx=>advancedTime.saveShift(tx,{userId:uid,id:parts[3],input});
          if(fn)return await runWrite(res,{actor:uid,action:'time.'+parts[2],subject:parts[3]||String(input.period),fn});
        }
        return json(res,404,{error:'E_TY_NOT_FOUND'});
      }
      if (url.pathname.startsWith('/api/foundation/')) {
        const parts = url.pathname.slice('/api/foundation/'.length).split('/').filter(Boolean);
        if(parts[0]==='test-seed'&&parts.length===1&&req.method==='POST'){
          let input;try{input=JSON.parse((await readBody(req)).toString('utf8'));}
          catch(e){if(e.code)throw e;throw bizErr('E_TY_ARGUMENT','请求内容不是有效JSON');}
          return await runWrite(res,{actor:uid,action:'foundation.test_seed',subject:'fully_synthetic',
            fn:tx=>testWorkspace.seed(tx,{userId:uid,input})});
        }
        if(parts[0]==='import'&&parts[1]==='template.xlsx'&&req.method==='GET'){
          res.writeHead(200,{...XLSX_HEADERS,...SEC_HEADERS,'content-disposition':contentDisposition('roster-synthetic-template.xlsx')});return res.end(rosterTemplate());
        }
        if(parts[0]==='import'&&['preview','commit'].includes(parts[1])&&req.method==='POST'){
          let input;try{input=JSON.parse((await readBody(req,5*1024*1024)).toString('utf8'));}
          catch(e){if(e.code)throw e;throw bizErr('E_TY_ARGUMENT','请求内容不是有效JSON');}
          return await runWrite(res,{actor:uid,action:`foundation.import_${parts[1]}`,subject:String(input.ledger_id),
            fn:tx=>foundationImporter[parts[1]](tx,{userId:uid,input})});
        }
        if (parts[0] === 'bridge' && parts[1] === 'status' && req.method === 'GET') {
          return await runRead(res, tx => foundationBridge.status(tx,{userId:uid,companyId:url.searchParams.get('company_id')}));
        }
        if (parts[0] === 'bridge' && ['preview','commit','entities'].includes(parts[1]) && req.method === 'POST') {
          let input;
          try { input=JSON.parse((await readBody(req,1024*1024)).toString('utf8')); }
          catch(e) {if(e.code) throw e;throw bizErr('E_TY_ARGUMENT','请求内容不是有效JSON');}
          if(parts[1]==='preview') return await runRead(res,tx=>foundationBridge.preview(tx,{userId:uid,input}));
          if(parts[1]==='entities')return await runWrite(res,{actor:uid,action:'foundation.create_legal_entity',subject:String(input.company_id),
            fn:tx=>foundationBridge.createLegalEntity(tx,{userId:uid,input})});
          return await runWrite(res,{actor:uid,action:'foundation.bridge',subject:String(input.company_id),
            fn:tx=>foundationBridge.commit(tx,{userId:uid,input})});
        }
        if (req.method === 'GET' && parts[0] === 'bootstrap') {
          return await runRead(res, tx => foundation.bootstrap(tx, {userId:uid,
            groupId:url.searchParams.get('group_id'),ledgerId:url.searchParams.get('ledger_id'),companyId:url.searchParams.get('company_id')}));
        }
        if (req.method === 'GET' && parts[0] === 'people' && parts[2] === 'timeline') {
          return await runRead(res, tx => foundation.timeline(tx,{userId:uid,personId:parts[1]}));
        }
        if (req.method === 'POST' && parts[0] === 'demo-seed') {
          return await runWrite(res,{actor:uid,action:'foundation.demo_seed',subject:'synthetic',fn:tx=>foundation.seedDemo(tx,{userId:uid})});
        }
        if (req.method === 'POST' && parts[2] === 'deactivate') {
          return await runWrite(res,{actor:uid,action:'foundation.deactivate',subject:`${parts[0]}:${parts[1]}`,
            fn:tx=>foundation.deactivate(tx,{userId:uid,collection:parts[0],id:parts[1]})});
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          if ((req.method === 'POST' && parts.length !== 1) || (req.method === 'PUT' && parts.length !== 2)) return json(res,404,{error:'E_TY_NOT_FOUND'});
          let input;
          try {input=JSON.parse((await readBody(req,1024*1024)).toString('utf8'));}
          catch(e) {if(e.code) throw e; throw bizErr('E_TY_ARGUMENT','请求内容不是有效JSON');}
          return await runWrite(res,{actor:uid,action:`foundation.${req.method==='POST'?'create':'update'}`,subject:`${parts[0]}:${parts[1]||'new'}`,
            fn:tx=>foundation.save(tx,{userId:uid,collection:parts[0],id:parts[1]||null,input})});
        }
        return json(res,405,{error:'E_TY_METHOD',message:'不支持硬删除；请使用停用、结束日期或授权有效期'});
      }

      // 心跳：失败不影响本次请求（它只是"最后活跃时间"这个附加信息）
      session.touch(db, auth)
        .catch((e) => console.error('[session-touch]', String(e.message).split('\n')[0]));

      if (url.pathname === '/api/attendance') {
        // ★ 一次请求一次灌表：不灌就是"用上一次的权限"
        return await runRead(res, async (tx) => ({
          rows: await attendance.listDaily(tx, { userId: uid }),
          // 182：空列表与"你还没被编到档口"必须长得不一样
          station_scope: await scope.stationScope(tx, { userId: uid }),
        }));
      }

      if (url.pathname === '/api/payslip') {
        // ★ 留痕（184）：这一屏对 HR 是"全量列表"，对别人是"自己那一行"。
        //   persons 直接取返回行的 employee_id，recordView 内部判"是不是只有自己"，
        //   所以这里不需要先知道 seeAll —— 判据只在一处（payslip-view.mjs）。
        let viewArg = null;
        const sent = await runRead(res, async (tx) => {
          await prepareRead(tx, { userId: uid, resource: 'payslip' });
          // ★ 字段权限在循环外求一次。它只与身份/资源/字段/场景有关，与哪一行无关；
          //   写在 for 里会让人以为"每行权限可能不同"，而它不会。
          const act = (await tx.query(`SELECT fn_field_action($1,$2,$3,$4) a`,
            [uid, 'payslip', 'net_amount', 'list'])).rows[0].a;
          // ★ 两道闸都得有：cost_org（门店）+ payroll_legal_entity（发薪法人）。
          //   权限矩阵验收（PM6b）抓到过：原来只有 cost_org，于是
          //   "算不了法人 2 的薪"的人**看得到法人 2 的薪**（净额还是 visible）——
          //   算与看是两件事，而看的那一侧也要按同一个维度收口。
          // ★★ 第三道：人员闸（180）。这条接口虽然叫"我的工资条"，但它原来按
          //   **组织范围**出数 —— 店长打开它拿到的是本店全部 33 行（3 期 × 11 人）。
          //   用户的要求是"所有人自己只能看自己的，除了 hr 专职人员"，所以判据与
          //   /api/payroll/slips 的第四道闸同源：有 payroll_slips_read_all 才看全量，
          //   否则只出自己那一行。认不出"我是谁"→ 空列表（不是报错）。
          const seeAll = (await tx.query('SELECT fn_role_can($1,$2,$3) o',
            [uid, 'payroll_slips_read_all', 'read'])).rows[0].o === true;
          const selfId = seeAll ? null
            : (await tx.query('SELECT fn_my_person($1) p', [uid])).rows[0].p;
          if (!seeAll && selfId === null) {
            return { rows: [], _actions: { net_amount: act } };
          }
          const r = await tx.query(`SELECT x.id, x.employee_id, x.gross_amount, x.net_amount
                                      FROM payslip x
                                     WHERE EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                                                    WHERE s.dim_code='cost_org'
                                                      AND s.org_id = (SELECT store_id FROM attendance_daily_store a
                                                                       WHERE a.employee_id = x.employee_id LIMIT 1))
                                       AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_entity e
                                                    WHERE e.dim_code = 'payroll_legal_entity'
                                                      AND e.entity_id = (SELECT r2.legal_entity_id
                                                                           FROM pay_run r2
                                                                          WHERE r2.id = x.pay_run_id))
                                       AND ($1::bigint IS NULL OR x.employee_id = $1)
                                     ORDER BY x.id`, [selfId]);
          // ★ 只掩码不报错。HTTP 仍然 200 —— 看不到某个字段不是错误。
          const out = {
            rows: r.rows.map((row) => ({
              id: row.id,
              employee_id: row.employee_id,
              gross_amount: row.gross_amount,
              net_amount: act === 'visible' ? row.net_amount : null,
              _net_amount_action: act,
            })),
          };
          // 一屏可能跨多个批次（多期），所以 pay_run_id 留 NULL；
          // scope 用 list，row_count 是这一次真实的返回行数。
          viewArg = { scope: 'list', persons: out.rows.map((x) => x.employee_id) };
          return out;
        }, () => viewArg && logPayslipView({ actor: uid, ip: reqIp(req), ...viewArg }));
        return sent;
      }

      // ---- 工资条查阅留痕（184）----
      // ★ 这一条接口本身**不留痕**：查日志不是看工资条，否则查一次多一条，
      //   查日志的人会把日志刷成自己的操作记录。
      // ★ 权限在服务里（payslip-view.mjs listViews）：
      //   有 payroll_slips_read_all 可查任何人；没有就只能查"自己被谁看过"。
      if (url.pathname === '/api/payslip/views') {
        const person = url.searchParams.get('person');
        return await runRead(res, (tx) => payslipView.listViews(tx, {
          userId: uid,
          personId: person === null || person === '' ? null : Number(person),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          limit: url.searchParams.get('limit'),
        }));
      }


      // ---- 香港合规两张台账（191/192）：证照到期与 MPF 缺失 ----
      // ★ 只读、只回答"谁该办什么"，与算薪无耦合（两张表注释里都写死了）。
      if (url.pathname === '/api/hr/documents/expiring') {
        const days = Number(url.searchParams.get('days') || 90);
        return await runRead(res, (tx) => complianceHk.expiringDocuments(tx, { userId: uid, days }));
      }
      if (url.pathname === '/api/hr/mpf/missing') {
        return await runRead(res, (tx) => complianceHk.mpfMissing(tx, { userId: uid }));
      }

      // ---- 发薪主体（法人）列表：界面上要能选，不能写死 entity=1 ----
      if (url.pathname === '/api/payroll/entities') {
        return await runRead(res, (tx) => payroll.entitiesForPayroll(tx, { userId: uid }));
      }

      // ---- 工资条签收（186）----
      // ★ 与留痕是两个问题：留痕是"谁看过"（取证），签收是"我认不认这张数"（闭环）。
      //   本人签收的 employee_id **从会话推**，不从参数取 —— 参数能改，
      //   而"代签"在合规上是最不该因为一个参数就发生的事。
      if (req.method === 'POST' && url.pathname === '/api/payslip/ack') {
        const slip = url.searchParams.get('slip');
        const run = url.searchParams.get('run');
        return await runWrite(res, {
          actor: uid, action: 'payslip.ack',
          subject: `slip:${slip || `run:${run}`}`,
          fn: (tx) => payslipAck.ackSelf(tx, {
            userId: uid,
            slipId: slip === null || slip === '' ? null : Number(slip),
            runId: run === null || run === '' ? null : Number(run),
            ip: reqIp(req),
          }),
        });
      }

      // 代录纸质回执：需要 payroll_run 写权限，记 acked_by
      if (req.method === 'POST' && url.pathname === '/api/payslip/ack/paper') {
        const slip = Number(url.searchParams.get('slip'));
        const method = url.searchParams.get('method') || 'paper';
        const note = url.searchParams.get('note');
        return await runWrite(res, {
          actor: uid, action: 'payslip.ack.paper', subject: `slip:${slip}`,
          fn: (tx) => payslipAck.ackOnBehalf(tx, {
            userId: uid, slipId: slip, method, note, ip: reqIp(req),
          }),
        });
      }

      // 撤回签收（187）：不能 UPDATE 原回执（那等于"他从没签过"），要新增一条撤回记录
      if (req.method === 'POST' && url.pathname === '/api/payslip/ack/revoke') {
        const slip = Number(url.searchParams.get('slip'));
        const reason = url.searchParams.get('reason');
        return await runWrite(res, {
          actor: uid, action: 'payslip.ack.revoke', subject: `slip:${slip}`,
          fn: (tx) => payslipAckRevoke.revoke(tx, {
            userId: uid, slipId: slip, reason,
          }),
        });
      }

      // 撤回记录：HR 看"谁撤过谁的、为什么"
      if (url.pathname === '/api/payslip/ack/revokes') {
        const run = url.searchParams.get('run');
        return await runRead(res, (tx) => payslipAckRevoke.listRevokes(tx, {
          userId: uid, runId: run === null || run === '' ? null : Number(run),
        }));
      }

      // 缺岗 → 招聘需求（188）：按档口×岗位开，幂等
      if (req.method === 'POST' && url.pathname === '/api/recruit/gap-to-requisition') {
        const store = Number(url.searchParams.get('store'));
        const period = url.searchParams.get('period');
        return await runWrite(res, {
          actor: uid, action: 'recruit.from_gap', subject: `store:${store}@${period}`,
          fn: (tx) => recruitGap.gapToRequisition(tx, {
            userId: uid, storeId: store, period,
          }),
        });
      }

      // 某门店各档口用了几个外包（189）。★ 只回答"用了几个"，不进编制/到岗。
      if (url.pathname === '/api/org/stations/outsourced') {
        const store = Number(url.searchParams.get('store'));
        const on = url.searchParams.get('on');
        return await runRead(res, async (tx) => {
          await prepareRead(tx, { userId: uid, resource: 'employee_roster' });
          const rows = (await tx.query(
            `SELECT * FROM fn_station_outsourced($1::bigint, COALESCE($2::date, app_today()))`,
            [store, on])).rows;
          return { store, on: on || null, rows };
        });
      }

      // 签收进度：员工只看自己那一行；有 payroll_slips_read_all 的看整批 + 未签名单
      if (url.pathname === '/api/payslip/acks') {
        const run = url.searchParams.get('run');
        return await runRead(res, (tx) => payslipAck.viewAcks(tx, {
          userId: uid, runId: run === null || run === '' ? null : Number(run),
        }));
      }

      // ---- 请假流：申请（服务层 + 事务）----
      // ★ 员工身份从会话取，不从参数取。参数可被改，会话不能。
      if (req.method === 'POST' && url.pathname === '/api/leave/apply') {
        const p = {
          userId: uid,
          typeId: Number(url.searchParams.get('type')),
          qty: Number(url.searchParams.get('qty')),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
        };
        return await runWrite(res, {
          actor: uid, action: 'leave.apply', subject: null,
          fn: async (tx) => {
            const out = await leave.applyLeave(tx, p);
            return { request_id: out.requestId, status: out.status,
                     _log: { qty: p.qty, from: p.from, to: p.to } };
          },
        });
      }

      // ---- 请假流：审批 ----
      if (req.method === 'POST' && url.pathname === '/api/leave/decide') {
        const p = {
          userId: uid,
          requestId: Number(url.searchParams.get('id')),
          approve: url.searchParams.get('approve') === '1',
        };
        return await runWrite(res, {
          actor: uid, action: 'leave.decide', subject: `request:${p.requestId}`,
          fn: async (tx) => {
            const out = await leave.decideLeave(tx, p);
            return { request_id: out.requestId, status: out.status, _log: { approve: p.approve } };
          },
        });
      }

      // ---- 额度四态 ----
      if (url.pathname === '/api/leave/balance') {
        return await runRead(res, async (tx) => ({ rows: await leave.getBalance(tx, { userId: uid }) }));
      }

      // ---- 接缝自检：必须为空 ----
      if (url.pathname === '/api/leave/inconsistent') {
        const r = await db.query('SELECT kind, request_id FROM v_leave_inconsistent');
        return json(res, 200, { rows: r.rows, ok: r.rows.length === 0 });
      }

      // ---- 工资条里的请假扣款 ----
      if (url.pathname === '/api/payslip/leave-deduction') {
        const period = url.searchParams.get('period');
        const r = await db.query('SELECT fn_leave_deduction($1,$2) v', [uid, period]);
        return json(res, 200, { period, deduction: r.rows[0].v });
      }

      // ---- 封账：权限走同一套行闸，不另开"管理员接口" ----
      if (req.method === 'POST' && url.pathname === '/api/attendance/close') {
        const store = Number(url.searchParams.get('store'));
        const period = url.searchParams.get('period');
        return await runWrite(res, {
          actor: uid, action: 'attendance.close', subject: `store:${store}@${period}`,
          fn: (tx) => attendance.closePeriod(tx, { userId: uid, storeId: store, period }),
        });
      }

      // ---- 补账：封账后唯一的修正通道 ----
      if (req.method === 'POST' && url.pathname === '/api/attendance/adjust') {
        const p = {
          userId: uid,
          employeeId: Number(url.searchParams.get('employee')),
          storeId: Number(url.searchParams.get('store')),
          workDate: url.searchParams.get('date'),
          delta: Number(url.searchParams.get('delta')),
          period: url.searchParams.get('period'),
          reason: url.searchParams.get('reason') || '',
        };
        return await runWrite(res, {
          actor: uid, action: 'attendance.adjust', subject: `store:${p.storeId}`,
          fn: (tx) => attendance.adjust(tx, p),
        });
      }

      if (url.pathname === '/api/attendance/adjustments') {
        const period = url.searchParams.get('period');
        return await runRead(res, async (tx) => ({
          rows: await attendance.adjustments(tx, { userId: uid, period }),
        }));
      }

      // ---- 未封账清单：算薪门禁读它；这里暴露成接口，因为"看不见才是问题" ----
      if (url.pathname === '/api/attendance/unclosed') {
        const period = url.searchParams.get('period');
        return await runRead(res, (tx) => attendance.unclosed(tx, { period }));
      }

      // ---- 算薪：发起 / 查看 ----
      // ★ 这里不自己算任何数，只调 fn_payroll_calc（见 services/payroll.mjs）。
      if (req.method === 'POST' && url.pathname === '/api/payroll/run') {
        const period = url.searchParams.get('period');
        const entity = Number(url.searchParams.get('entity') || 1);
        return await runWrite(res, {
          actor: uid, action: 'payroll.run', subject: `run:${period}/e${entity}`,
          fn: (tx) => payroll.runPayroll(tx, { userId: uid, period, entityId: entity }),
        });
      }

      // ---- 发放回单（140）----
      if (url.pathname === '/api/payroll/paylist') {
        const run = Number(url.searchParams.get('run'));
        return await runRead(res, (tx) => payout.paylist(tx, { userId: uid, runId: run }));
      }

      // ---- 人事合同（160）：填报 → 校验 → 签署存快照 → 打印 ----
      // ★ 没有"改已签合同"的接口：变更就签一份新的（prev_id 串链），
      //   历史那份留着 —— 与工资条封账、绩效封存同一条规矩。
      if (url.pathname === '/api/hr/contracts') {
        return await runRead(res, (tx) => contract.list(tx, {
          userId: uid,
          employeeId: url.searchParams.get('employee') ? Number(url.searchParams.get('employee')) : null,
          status: url.searchParams.get('status') || null,
        }));
      }

      // 法人主档写入（160 建表、160/165 都要读它，但一直没有写入路径 ——
      // 于是"招聘走到入职"的人在系统里签不出一份合同：甲方三要素全空）
      if (req.method === 'POST' && url.pathname === '/api/hr/entity') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.entity.save', subject: `entity:${q.id}`,
          fn: (tx) => contract.saveEntity(tx, {
            userId: uid, id: q.id, name: q.name, creditCode: q.creditCode,
            address: q.address, legalRep: q.legalRep, stampName: q.stampName,
            bankName: q.bankName, bankAccount: q.bankAccount }),
        });
      }

      // 人员证件/手机写入（007 的 person_profile）—— 招聘→入职链上缺的第二块：
      // 入职链能建人，但没人能录证件号，而合同渲染要求"乙方证件号"非空。
      if (req.method === 'POST' && url.pathname === '/api/hr/profile') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.profile.save', subject: `emp:${q.employeeId}`,
          fn: (tx) => people.saveProfile(tx, {
            userId: uid, employeeId: Number(q.employeeId),
            nationalId: q.nationalId, mobile: q.mobile, verified: q.verified !== false }),
        });
      }

      if (url.pathname === '/api/hr/entities') {
        return await runRead(res, (tx) => contract.entities(tx, { userId: uid }));
      }

      if (url.pathname === '/api/hr/contract/unsigned') {
        return await runRead(res, (tx) => contract.unsigned(tx, { userId: uid }));
      }

      // ★ 必须判 method：下面还有一条 POST /api/hr/contract（填报）走同一个 pathname。
      //   只写 pathname 的话，这个读分支会把填报请求吃掉 —— 返回的是
      //   "id 必须是正整数"（因为填报请求的 URL 上没有 id），而写路由变成死代码。
      //   /api/exam/paper 犯过一模一样的错。
      if (req.method === 'GET' && url.pathname === '/api/hr/contract') {
        return await runRead(res, (tx) => contract.get(tx, {
          userId: uid, id: Number(url.searchParams.get('id')) }));
      }

      if (url.pathname === '/api/hr/contract/render') {
        return await runRead(res, (tx) => contract.render(tx, {
          userId: uid, id: Number(url.searchParams.get('id')) }));
      }

      if (req.method === 'POST' && url.pathname === '/api/hr/contract') {
        const body = await readBody(req);
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { p = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.contract.save',
          subject: `emp:${p.employeeId}/no:${p.contractNo || 'auto'}`,
          fn: (tx) => contract.save(tx, { userId: uid, data: p }),
        });
      }

      // ---- 员工异动（163）：调岗 / 转店 / 用工类型 ----
      // ★ 异动是**一条单据**，不是一个 UPDATE：单据里存新旧值与原因，
      //   事后能回答"什么时候变成的"；直接改档案只能回答"现在是什么"。
      if (url.pathname === '/api/hr/changes') {
        return await runRead(res, (tx) => contract.changes(tx, {
          userId: uid,
          employeeId: url.searchParams.get('employee') ? Number(url.searchParams.get('employee')) : null,
          status: url.searchParams.get('status') || null,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/hr/change') {
        const body = await readBody(req);
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { p = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.change.open',
          subject: `emp:${p.employeeId}/kind:${p.kind}`,
          fn: (tx) => contract.changeOpen(tx, {
            userId: uid,
            employeeId: p.employeeId,
            kind: p.kind,
            effectiveDate: p.effectiveDate,
            reason: p.reason,
            next: p.next || {},
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/hr/change/apply') {
        const id = Number(url.searchParams.get('id'));
        return await runWrite(res, {
          actor: uid, action: 'hr.change.apply', subject: `change:${id}`,
          fn: (tx) => contract.changeApply(tx, { userId: uid, id }),
        });
      }

      // 入职一条链（162）：offer → 人 → 任职 → 工号 → 合同草稿。
      // ★ 走请求体：入职参数十来个，塞 URL 会被截断；而且截断后看起来像"参数错"。
      if (req.method === 'POST' && url.pathname === '/api/hr/onboard') {
        const body = await readBody(req);
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { p = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.onboard',
          subject: `offer:${p.offer}/entity:${p.legalEntityId || p.legal_entity_id}`,
          fn: (tx) => contract.onboardFull(tx, {
            userId: uid,
            offerId: p.offer ?? p.offerId,
            personId: p.person ?? p.personId ?? null,
            hireDate: p.hireDate ?? p.hire_date,
            legalEntityId: p.legalEntityId ?? p.legal_entity_id,
            contract: p.contract || {},
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/hr/contract/sign') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'hr.contract.sign', subject: `contract:${q.get('id')}`,
          fn: (tx) => contract.sign(tx, {
            userId: uid, id: Number(q.get('id')), signedBy: q.get('by') || null }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/hr/contract/renew') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'hr.contract.renew', subject: `contract:${q.get('id')}`,
          fn: (tx) => contract.renew(tx, {
            userId: uid, id: Number(q.get('id')),
            startDate: q.get('start') || null, endDate: q.get('end') || null,
            kind: q.get('kind') || null }),
        });
      }

      // 合同打印页：服务端渲染，存下来就是能盖章的凭证。
      // 已签的用**快照**（模板后来改了也不影响这一份），未签的现场渲染。
      if (url.pathname === '/api/hr/contract.html') {
        try {
          const id = Number(url.searchParams.get('id'));
          const c = await withTx(db, (tx) => contract.get(tx, { userId: uid, id }));
          const bodyText = c.body_snapshot
            || (await withTx(db, (tx) => contract.render(tx, { userId: uid, id }))).body;
          const body = contract.html(c, bodyText);
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(body, 'utf8'),
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex',
            ...SEC_HEADERS,
          });
          return res.end(body);
        } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
      }

      // ================================================================
      // 离职交接（165）
      // ================================================================
      if (url.pathname === '/api/hr/exit/list') {
        return await runRead(res, (tx) => offboarding.list(tx, {
          userId: uid,
          employeeId: url.searchParams.get('employee') ? Number(url.searchParams.get('employee')) : null,
          status: url.searchParams.get('status') || null,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/hr/exit/open') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.exit.open', subject: `emp:${q.employeeId}`,
          fn: (tx) => offboarding.open(tx, {
            userId: uid, employeeId: q.employeeId, kind: q.kind,
            applyDate: q.applyDate, lastWorkDate: q.lastWorkDate,
            reason: q.reason, handoverTo: q.handoverTo ?? null,
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/hr/exit/apply') {
        const id = Number(url.searchParams.get('id'));
        return await runWrite(res, {
          actor: uid, action: 'hr.exit.apply', subject: `exit:${id}`,
          fn: (tx) => offboarding.apply(tx, { userId: uid, id }),
        });
      }

      if (url.pathname === '/api/hr/exit/handover') {
        const id = Number(url.searchParams.get('id'));
        if (req.method === 'GET') {
          return await runRead(res, (tx) => offboarding.handover(tx, { userId: uid, id, items: null }));
        }
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.exit.handover', subject: `exit:${id}`,
          fn: (tx) => offboarding.handover(tx, { userId: uid, id, items: q.items || q }),
        });
      }

      if (url.pathname === '/api/hr/exit/certificate') {
        return await runRead(res, (tx) => offboarding.certificate(tx, {
          userId: uid, id: Number(url.searchParams.get('id')) }));
      }

      if (url.pathname === '/api/hr/non-compete') {
        if (req.method === 'GET') {
          return await runRead(res, (tx) => offboarding.nonCompete(tx, {
            userId: uid,
            id: url.searchParams.get('exit') ? Number(url.searchParams.get('exit')) : null,
            employeeId: url.searchParams.get('employee') ? Number(url.searchParams.get('employee')) : null,
            data: null,
          }));
        }
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'hr.noncompete', subject: `exit:${q.exitId}`,
          fn: (tx) => offboarding.nonCompete(tx, {
            userId: uid, id: q.exitId ? Number(q.exitId) : null,
            employeeId: q.employeeId ? Number(q.employeeId) : null, data: q,
          }),
        });
      }

      // ================================================================
      // 社保参保台账（166）
      // ★ 与 /api/si/declare（申报表）分开：那条是"报给税务/社保的表"，
      //   这条是"我们自己的参保台账" —— 报出去的表错了要更正申报，
      //   台账错了要更正的是钱。
      // ================================================================
      if (url.pathname === '/api/si/enrollments') {
        return await runRead(res, (tx) => siLedger.enrollments(tx, {
          userId: uid,
          employeeId: url.searchParams.get('employee') ? Number(url.searchParams.get('employee')) : null,
          city: url.searchParams.get('city') || null,
          period: url.searchParams.get('period') || null,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/si/enroll') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'si.enroll', subject: `emp:${q.employeeId}/${q.city}`,
          fn: (tx) => siLedger.enroll(tx, {
            userId: uid, employeeId: q.employeeId, city: q.city,
            items: q.items || [], fromPeriod: q.fromPeriod,
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/si/stop') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'si.stop', subject: `emp:${q.employeeId}/${q.city}`,
          fn: (tx) => siLedger.stop(tx, {
            userId: uid, employeeId: q.employeeId, city: q.city, endPeriod: q.endPeriod }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/si/base') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'si.base.adjust', subject: `emp:${q.employeeId}/${q.effectivePeriod}`,
          fn: (tx) => siLedger.adjustBase(tx, {
            userId: uid, employeeId: q.employeeId, city: q.city,
            effectivePeriod: q.effectivePeriod, newBase: q.newBase, reason: q.reason }),
        });
      }

      if (url.pathname === '/api/si/month') {
        return await runRead(res, (tx) => siLedger.month(tx, {
          userId: uid,
          employeeId: Number(url.searchParams.get('employee')),
          period: url.searchParams.get('period'),
        }));
      }

      if (url.pathname === '/api/si/reconcile') {
        return await runRead(res, (tx) => siLedger.reconcile(tx, {
          userId: uid, period: url.searchParams.get('period') }));
      }

      // ================================================================
      // 招聘后半段（167）：面试 / 背调 / 录用审批
      // ★ 面试挂在 requisition + candidate_key 上，不挂 offer：
      //   发 offer 必然写薪资（offer_version 只增不改），
      //   而"招 1 个人面 8 个"不该先写下 8 份承诺。
      // ================================================================
      if (url.pathname === '/api/recruit/interview') {
        if (req.method === 'GET') {
          return await runRead(res, (tx) => recruitFlow.rounds(tx, {
            userId: uid,
            requisitionId: Number(url.searchParams.get('rq')),
            candidateKey: url.searchParams.get('candidate') || null,
          }));
        }
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'recruit.interview.add', subject: `rq:${q.rq}/${q.candidateKey}`,
          fn: (tx) => recruitFlow.addRound(tx, {
            userId: uid, requisitionId: q.rq, candidateKey: q.candidateKey,
            candidateName: q.candidateName, roundNo: q.roundNo, interviewer: q.interviewer,
            scheduledAt: q.scheduledAt, method: q.method, score: q.score,
            conclusion: q.conclusion, comment: q.comment,
          }),
        });
      }

      if (url.pathname === '/api/recruit/bg') {
        if (req.method === 'GET') {
          return await runRead(res, (tx) => recruitFlow.bgChecks(tx, {
            userId: uid, candidateKey: url.searchParams.get('candidate') }));
        }
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'recruit.bg.add', subject: `cand:${q.candidateKey}/${q.kind}`,
          fn: (tx) => recruitFlow.addBgCheck(tx, {
            userId: uid, candidateKey: q.candidateKey, kind: q.kind,
            consentAt: q.consentAt ?? null, checkedAt: q.checkedAt ?? null,
            result: q.result ?? null, detail: q.detail ?? null, checkedBy: q.checkedBy ?? null,
          }),
        });
      }

      if (url.pathname === '/api/recruit/approval') {
        if (req.method === 'GET') {
          return await runRead(res, (tx) => recruitFlow.approvals(tx, {
            userId: uid, offerId: Number(url.searchParams.get('offer')) }));
        }
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'recruit.offer.approve', subject: `offer:${q.offer}/${q.step}`,
          fn: (tx) => recruitFlow.approve(tx, {
            userId: uid, offerId: q.offer, step: q.step, decision: q.decision,
            approver: q.approver ?? null, note: q.note ?? null,
          }),
        });
      }

      if (url.pathname === '/api/recruit/candidate') {
        return await runRead(res, (tx) => recruitFlow.candidateHistory(tx, {
          userId: uid, candidateKey: url.searchParams.get('key') }));
      }

      // ================================================================
      // 考勤异常与补卡（168）
      // ================================================================
      if (req.method === 'POST' && url.pathname === '/api/att/scan') {
        const period = url.searchParams.get('period');
        return await runWrite(res, {
          actor: uid, action: 'att.scan', subject: `period:${period}`,
          fn: (tx) => attException.scan(tx, { userId: uid, period,
            graceMin: Number(url.searchParams.get('grace') || 5) }),
        });
      }

      if (url.pathname === '/api/att/exceptions') {
        return await runRead(res, (tx) => attException.exceptions(tx, {
          userId: uid, period: url.searchParams.get('period'),
          kind: url.searchParams.get('kind') || null,
          status: url.searchParams.get('status') || null,
          employeeId: url.searchParams.get('employee') ? Number(url.searchParams.get('employee')) : null,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/att/punch-fix') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'att.punch_fix.open', subject: `emp:${q.employeeId}/${q.workDate}`,
          fn: (tx) => attException.punchFixOpen(tx, {
            userId: uid, employeeId: q.employeeId, workDate: q.workDate,
            fixType: q.fixType, fixTime: q.fixTime, reason: q.reason }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/punch-fix/apply') {
        const id = Number(url.searchParams.get('id'));
        return await runWrite(res, {
          actor: uid, action: 'att.punch_fix.apply', subject: `fix:${id}`,
          fn: (tx) => attException.punchFixApply(tx, { userId: uid, fixId: id }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/exception/close') {
        const body = await readBody(req);
        let q = {}; try { q = JSON.parse(body || '{}'); } catch { q = {}; }
        return await runWrite(res, {
          actor: uid, action: 'att.exception.close', subject: `ex:${q.exceptionId}`,
          fn: (tx) => attException.close(tx, {
            userId: uid, exceptionId: q.exceptionId, action: q.action, note: q.note ?? null }),
        });
      }

      if (url.pathname === '/api/att/dup-punch') {
        return await runRead(res, (tx) => attException.dupPunch(tx, {
          userId: uid, period: url.searchParams.get('period') }));
      }

      // ---- 分门店可打印工资单 ----
      // ★ 数据由库出、按成本组织分组，**不由前端筛**：前端筛等于把全公司的人先发到
      //   浏览器再挑出来，和"把全公司模板发给店长"没有区别，只是把泄露点从文件
      //   挪到了网络响应里。
      if (url.pathname === '/api/payroll/print') {
        // ★ 留痕（184）：打印是"工资条要落到纸上"的动作，签字的凭证从哪来 ——
        //   看着的是同一批人的钱。persons 从 sheet() 的分组里取，不另查一次。
        let viewArg = null;
        const sent = await runRead(res, async (tx) => {
          const d = await payslipPrint.sheet(tx, {
            userId: uid,
            runId: Number(url.searchParams.get('run')),
            orgId: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null,
          });
          viewArg = {
            scope: 'print',
            persons: d.groups.flatMap((g) => g.people.map((p) => p.employee_id)),
            payRunId: d.run?.id ?? null,
          };
          return d;
        }, () => viewArg && logPayslipView({ actor: uid, ip: reqIp(req), ...viewArg }));
        return sent;
      }

      // 打印页：**服务端渲染**的 HTML，前端 fetch 成 blob 再开新窗口。
      // ★ 不走 URL 带 token 的裸链接：token 落在 URL 里会进浏览器历史、
      //   进代理日志、进别人转发的那条消息里。工资单是给人签字的凭证，
      //   拿到链接就该能打开，这是不能接受的。
      if (url.pathname === '/api/payroll/print.html') {
        try {
          const d = await withTx(db, (tx) => payslipPrint.sheet(tx, {
            userId: uid,
            runId: Number(url.searchParams.get('run')),
            orgId: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null,
          }));
          // ★ 留痕（184）：与 /api/payroll/print 同一批人、同一个 scope ——
          //   两个入口（JSON 数据 + 服务端渲染的 HTML）都要记，因为真正打印的是这一条。
          await logPayslipView({
            actor: uid, scope: 'print',
            persons: d.groups.flatMap((g) => g.people.map((p) => p.employee_id)),
            payRunId: d.run?.id ?? null, ip: reqIp(req),
          });
          const body = payslipPrint.html(d, {
            perPage: Number(url.searchParams.get('per')) === 2 ? 2 : 1,
            company: url.searchParams.get('company') || null,
          });
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(body, 'utf8'),
            // 工资单不许被中间层缓存，也不许被搜索索引
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex',
            ...SEC_HEADERS,
          });
          return res.end(body);
        } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
      }

      // ---- 服务端生成 PDF（同一份打印 HTML）----
      // ★ 复用 payslipPrint.html()，**不复制第二份模板**：复制出来的那天起，
      //   "屏幕上打印看到的"和"服务端生成的 PDF"就是两张不同的纸，
      //   而签收凭证出现两个版本时，没人能说清该以哪一份为准。
      // ★ 渲染用本机 Chrome 的 --print-to-pdf（理由与局限见 app/pdf.mjs 文件头）。
      //   目标机器没有 Chrome → 501 + 一句人话，不假装成功、也不返回坏文件。
      // ★ 参数 store 与 org 同义（都是成本组织/门店 id）：store 是业务说法，
      //   org 是既有打印页的参数名。两个都收，免得同一个筛选项有两个名字。
      if (url.pathname === '/api/payroll/print.pdf') {
        try {
          const runId = Number(url.searchParams.get('run'));
          const orgRaw = url.searchParams.get('store') ?? url.searchParams.get('org');
          const orgId = orgRaw === null || orgRaw === '' ? null : Number(orgRaw);
          // 取数（含行闸/法人闸/掩码）在事务里，渲染在事务外 ——
          // 起一个 Chrome 要一两秒，不该把库连接攥在手里等它。
          const d = await withTx(db, (tx) => payslipPrint.sheet(tx, {
            userId: uid, runId, orgId,
          }));
          const html = payslipPrint.html(d, {
            perPage: Number(url.searchParams.get('per')) === 2 ? 2 : 1,
          });
          const pdf = await htmlToPdf(html);
          // ★ 留痕（184）放在**生成成功之后**：501/500 的请求没有任何数据离开系统，
          //   记一条"看过"是不真实的。CSV/打印页也是"先产出再记"同一个顺序。
          await logPayslipView({
            actor: uid, scope: 'print',
            persons: d.groups.flatMap((g) => g.people.map((p) => p.employee_id)),
            payRunId: d.run?.id ?? null, ip: reqIp(req),
          });
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': pdf.length,
            // 工资单落成文件后更不该被缓存/索引：一份能被中间层留存的 PDF
            // 等于把全店薪资钉在了某个代理磁盘上。
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex',
            'content-disposition': contentDisposition(
              `payslip_run${runId}.pdf`, `工资单_${d.run?.period ?? runId}.pdf`),
            ...SEC_HEADERS,
          });
          return res.end(pdf);
        } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
      }

      // ---- 按门店批量打包工资单（171）----
      // 财务月底的真实动作是"一次出全套"：十家店点十次，再手工把十个窗口另存成
      // 十个文件、再自己打包 —— 中间点错一次就是把这家店的薪资发给那家店的店长。
      // 这个入口把这一整段收成一次请求：一个 zip，一个门店一个文件。
      // ★ 参数是 period（不是 run）：要的是"这一期的全套"，而一期可能有多个
      //   法人批次（连锁常见）；哪些批次归我，由服务内部的 sheet() 判，不由参数判。
      // ★ 权限面**一条都不在这里写**：行闸与掩码全在 sheet() 里，
      //   这里只负责把 zip 发出去（71ce396 的四处越权都是"在路由层顺手取数"）。
      if (url.pathname === '/api/payroll/payslip-pack') {
        const period = url.searchParams.get('period');
        const per = Number(url.searchParams.get('per')) === 2 ? 2 : 1;
        try {
          const out = await withTx(db, (tx) => payslipPack.pack(tx, {
            userId: uid, period, perPage: per,
          }));
          // ★ 留痕（184）：一次出全套是最该记的一条 —— 一个 zip 里是十几家店的钱。
          //   ★ 这一条**给不出人员 id 清单**（pack 只回每店人数），所以 persons=null、
          //     只记 row_count=人数。代价在表注释与报告里如实写了：
          //     批量日志答不出"我在不在那一批里"。
          await logPayslipView({
            actor: uid, scope: 'export', persons: null,
            rowCount: out.people, payRunId: out.files?.[0]?.run_id ?? null,
            ip: reqIp(req),
          });
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': out.zip.length,
            // 工资单不许被中间层缓存、不许被搜索索引。
            // 文件名给两种写法：ASCII 那份给老浏览器，filename* 才是中文名。
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex',
            'content-disposition':
              `attachment; filename="payslips-${out.period}.zip"; `
              + `filename*=UTF-8''${encodeURIComponent(`工资单_${out.period}.zip`)}`,
            // 包里到底几张单、几个人：运维 curl -I 就能核对，不用先下载
            'x-pack-files': String(out.stores),
            'x-pack-people': String(out.people),
            ...SEC_HEADERS,
          });
          return res.end(out.zip);
        } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
      }

      // 发放清单 CSV：给财务在网银里逐笔核对。★ 不含银行账号（账号不进 HR 库）
      // ★ format=xlsx：同一份数换一个容器（CSV 在中文 Windows 上要过编码/分隔符的劫）。
      //   取数、掩码、留痕**全部与 CSV 分支同一处** —— 分支只负责"怎么装"，
      //   所以不存在"导 Excel 就不掩码 / 就不留痕"的口子。
      if (url.pathname === '/api/payroll/paylist.csv') {
        const runId = Number(url.searchParams.get('run'));
        const wantXlsx = (url.searchParams.get('format') || '').toLowerCase() === 'xlsx';
        try {
          // ★ 导出走 export 场景：与页面（list）分开取字段权限
          const d = await withTx(db, (tx) => payout.paylist(tx, {
            userId: uid, runId, scene: 'export' }));
          // ★ 留痕（184）：发放清单是**全批人的应发/实发**，比单张工资条更敏感。
          //   这里同样只有人数（paylist 回的是工号/姓名，不回 person.id），
          //   所以按"给了 row_count 的批量导出"记一条。
          await logPayslipView({
            actor: uid, scope: 'export', persons: null,
            rowCount: d.rows.length, payRunId: runId, ip: reqIp(req),
          });
          if (wantXlsx) {
            // 列与 CSV 一一对应；金额走数值单元格（写文本的话 Excel 里求和为 0）。
            // ★ 合计行照 CSV 保留：财务不用自己按计算器，而按计算器的地方
            //   正是容易差一分的地方。它不算"数据行"——留痕的 row_count 记人数。
            const buf = writeXlsx({
              sheetName: '发放清单',
              columns: [
                { key: 'employee_no', label: '工号' },
                { key: 'full_name', label: '姓名' },
                { key: 'org_name', label: '部门' },
                { key: 'gross_amount', label: '应发', numeric: true, decimals: 2, width: 14 },
                { key: 'net_amount', label: '实发', numeric: true, decimals: 2, width: 14 },
              ],
              rows: [
                ...d.rows.map((r) => ({
                  employee_no: r.employee_no,
                  full_name: r.full_name,
                  org_name: r.org_name,
                  gross_amount: r.gross_amount,
                  net_amount: r.net_amount,
                })),
                { employee_no: '', full_name: '', org_name: '合计', gross_amount: null, net_amount: d.total },
              ],
            });
            res.writeHead(200, {
              ...XLSX_HEADERS, ...SEC_HEADERS,
              'content-length': buf.length,
              'content-disposition': contentDisposition(
                `paylist_run${runId}.xlsx`, `发放清单_${runId}.xlsx`),
            });
            return res.end(buf);
          }
          const q = (v) => {
            const t = v === null || v === undefined ? '' : String(v);
            return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
          };
          // ★ 用 paylist() 返回的（已按字段权限掩码的）值，不重读库。
          //   直接在导出里 `Number(net_amount).toFixed(2)` 是权限矩阵验收
          //   抓到的那个洞：页面掩了、CSV 明文，而导出会被随手转发。
          const lines = ['工号,姓名,部门,应发,实发'];
          for (const r of d.rows) {
            lines.push([r.employee_no, r.full_name, r.org_name,
              r.gross_amount === null ? '' : Number(r.gross_amount).toFixed(2),
              r.net_amount === null ? '' : Number(r.net_amount).toFixed(2)].map(q).join(','));
          }
          // 合计行带上，财务不用自己按计算器 —— 而按计算器的地方正是容易差一分的地方。
          // 合计被掩时（看得到明细才算得出合计）留空，不留 0.00。
          lines.push(['', '', '合计',
            d.total === null ? '' : '',
            d.total === null ? '' : Number(d.total).toFixed(2)].map(q).join(','));
          const text = '\uFEFF' + lines.join('\n');
          res.writeHead(200, {
            ...CSV_HEADERS, ...SEC_HEADERS,
            'content-length': Buffer.byteLength(text, 'utf8'),
            'content-disposition': `attachment; filename="paylist_run${runId}.csv"`,
          });
          return res.end(text);
        } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/pay') {
        const run = Number(url.searchParams.get('run'));
        const method = url.searchParams.get('method') || 'bank';
        const ref = url.searchParams.get('ref') || null;
        const total = url.searchParams.get('total');
        return await runWrite(res, {
          actor: uid, action: 'payroll.pay', subject: `run:${run}`,
          fn: (tx) => payout.pay(tx, { userId: uid, runId: run, method, ref, total }),
        });
      }

      // ---- 工资表会签与封账（139）----
      if (url.pathname === '/api/payroll/signoff') {
        const run = Number(url.searchParams.get('run'));
        return await runRead(res, (tx) => signoff.status(tx, { userId: uid, runId: run }));
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/signoff/start') {
        const run = Number(url.searchParams.get('run'));
        // users 形如 cashier:1,finance:2,biz:3 —— 界面按角色选人
        const users = {};
        for (const pair of url.searchParams.getAll('user')) {
          const i = pair.indexOf(':');
          if (i > 0) users[pair.slice(0, i)] = Number(pair.slice(i + 1));
        }
        return await runWrite(res, {
          actor: uid, action: 'payroll.signoff.start', subject: `run:${run}`,
          fn: (tx) => signoff.start(tx, { userId: uid, runId: run, users }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/signoff/decide') {
        const id = Number(url.searchParams.get('id'));
        const ok = url.searchParams.get('ok') !== '0';
        const note = url.searchParams.get('note') || null;
        return await runWrite(res, {
          actor: uid, action: ok ? 'payroll.signoff.approve' : 'payroll.signoff.object',
          subject: `signoff:${id}`,
          fn: (tx) => signoff.decide(tx, { userId: uid, id, ok, note }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/seal') {
        const run = Number(url.searchParams.get('run'));
        // accept=1：已知"本期累计与前期对不上"，仍然确认按现状封账（要留痕）
        const acceptStale = url.searchParams.get('accept') === '1';
        return await runWrite(res, {
          actor: uid, action: acceptStale ? 'payroll.seal.accept_stale' : 'payroll.seal',
          subject: `run:${run}`,
          fn: (tx) => signoff.seal(tx, { userId: uid, runId: run, acceptStale }),
        });
      }

      // ---- 算薪预演（137）：改参数之前先看影响面 ----
      // ★ GET 与 POST 都收：界面用 POST（覆盖参数是结构化的），命令行/脚本用 GET 好写。
      //   两条都只是读（库里跑完就回滚），所以都走 runRead，不进审计日志 ——
      //   "我预览了 20 次"不该埋掉真正的改动记录。
      if (url.pathname === '/api/payroll/preview') {
        const period = url.searchParams.get('period');
        const entity = Number(url.searchParams.get('entity') || 1);
        let overrides = {};
        if (req.method === 'POST') {
          let buf = null;
          try { buf = await readBody(req, 64 * 1024); } catch (e) {
            const m = toHttp(e);
            return json(res, m.status, m.body);
          }
          if (buf && buf.length) {
            try { overrides = JSON.parse(buf.toString('utf8')); } catch {
              return json(res, 400, { error: 'E_ARG_INVALID', message: '覆盖参数不是合法 JSON' });
            }
          }
        } else {
          const sp = url.searchParams;
          for (const k of ['salary_pct', 'salary_add', 'si_base_pct']) {
            if (sp.get(k) !== null) overrides[k] = sp.get(k);
          }
          // policy 可重复：policy=PAY_OT_AUTO:on&policy=PAY_DAYS_PER_MONTH:30
          for (const raw of sp.getAll('policy')) {
            const i = raw.indexOf(':');
            if (i <= 0) {
              return json(res, 400, {
                error: 'E_ARG_INVALID', message: `policy 要写成 CODE:值（收到 ${raw}）` });
            }
            overrides.policy = overrides.policy || {};
            overrides.policy[raw.slice(0, i)] = raw.slice(i + 1);
          }
        }
        return await runRead(res, (tx) => payrollPreview.preview(tx, {
          userId: uid, period, entityId: entity, overrides }));
      }

      if (url.pathname === '/api/payroll/runs') {
        return await runRead(res, async (tx) => ({ rows: await payroll.listRuns(tx) }));
      }

      if (url.pathname === '/api/payroll/slips') {
        const runId = Number(url.searchParams.get('run'));
        // ★ 留痕（184）：非 HR 这条接口只会返回他自己那一行，recordView 会判出来
        //   而不写日志（"看自己"不留痕）；HR 返回整批，写 1 条 row_count=N。
        let viewArg = null;
        const sent = await runRead(res, async (tx) => {
          const rows = await payroll.listSlips(tx, { userId: uid, runId });
          viewArg = { scope: 'list', persons: rows.map((x) => x.employee_id), payRunId: runId };
          return { rows };
        }, () => viewArg && logPayslipView({ actor: uid, ip: reqIp(req), ...viewArg }));
        return sent;
      }

      // ---- 导出：CSV ----
      // ★ 导出是最容易漏掩码的地方：列表页掩了，导出忘了，而导出的文件会被转发。
      //   这里的做法不是"再掩一次"，而是**复用同一个 listSlips** ——
      //   掩码只有一份实现，导出只是换了个输出格式。
      if (url.pathname === '/api/payslip/export.csv') {
        const runId = Number(url.searchParams.get('run'));
        // ★ format=xlsx：同一份 listSlips 返回值换个容器。掩码与留痕都在下面这段里，
        //   分支只决定"怎么装"，不决定"给什么"（见 AV2 那条断言的用意）。
        const wantXlsx = (url.searchParams.get('format') || '').toLowerCase() === 'xlsx';
        try {
          const rows = await withTx(db, (tx) => payroll.listSlips(tx, { userId: uid, runId }));
          // ★ 留痕（184）：导出是"数据离开系统"的那一步，最该记 ——
          //   而且它复用的就是 listSlips，所以 persons 与页面看到的是同一批人。
          await logPayslipView({
            actor: uid, scope: 'export', persons: rows.map((x) => x.employee_id),
            payRunId: runId, ip: reqIp(req),
          });
          if (wantXlsx) {
            // 列与 CSV 完全一致（含 id / employee_id）：两份格式对不上时，
            // 对账的人会以为是数据错了，而不是"这一列只在 CSV 里有"。
            // ★ 被掩码的金额写**空单元格**（不带 <v>），不是 0 —— 见 xlsx-write 的 cellXml。
            const buf = writeXlsx({
              sheetName: '工资条明细',
              columns: [
                { key: 'id', label: 'id', numeric: true, width: 10 },
                { key: 'employee_id', label: 'employee_id', numeric: true, width: 14 },
                { key: 'gross_amount', label: 'gross_amount', numeric: true, decimals: 2, width: 16 },
                { key: 'net_amount', label: 'net_amount', numeric: true, decimals: 2, width: 16 },
                { key: 'si_employee', label: 'si_employee', numeric: true, decimals: 2, width: 14 },
              ],
              rows,
            });
            res.writeHead(200, {
              ...XLSX_HEADERS, ...SEC_HEADERS,
              'content-length': buf.length,
              'content-disposition': contentDisposition(
                `payslip_run${runId}.xlsx`, `工资条明细_${runId}.xlsx`),
            });
            return res.end(buf);
          }
          // 被掩码的字段导出成空列，不是 0，也不写 "***"：
          // CSV 会被程序读，0 会被当成真实金额，"***" 会让整列变成字符串。
          // （numCell 对 null/非数字一律给空 —— 判断只有那一处。）
          const text = toCsv({
            columns: [
              { key: 'id', label: 'id', numeric: true },
              { key: 'employee_id', label: 'employee_id', numeric: true },
              { key: 'gross_amount', label: 'gross_amount', numeric: true },
              { key: 'net_amount', label: 'net_amount', numeric: true },
              { key: 'si_employee', label: 'si_employee', numeric: true },
            ],
            rows,
          });
          res.writeHead(200, {
            ...CSV_HEADERS, ...SEC_HEADERS,
            'content-length': Buffer.byteLength(text, 'utf8'),
            'content-disposition': `attachment; filename="payslip_run${runId}.csv"`,
          });
          return res.end(text);
        } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
      }

      // 勾稽：必须为空。暴露成接口，因为"没人看"是这类判据的唯一失败方式。
      if (url.pathname === '/api/payroll/consistency') {
        return await runRead(res, (tx) => payroll.consistency(tx));
      }

      // ---- 自检：把覆盖率从"只在终端里"变成"能被看" ----
      // ★ 这个接口不跑任何断言。它只读登记表——跑是 CI 的事，看是这里的事。
      //   两者混在一起会出现"为了看一眼就顺手跑一遍"，而跑一遍会改结论。
      if (url.pathname === '/api/health') {
        const asOf = url.searchParams.get('as_of') || '2026-11-14';
        const summary = (await db.query(
          'SELECT bucket, n FROM fn_chk_summary($1::date)', [asOf])).rows;
        const rows = (await db.query(
          `SELECT check_code, domain, kind, bucket, last_outcome, last_run_at
             FROM fn_chk_coverage($1::date) ORDER BY bucket, check_code`, [asOf])).rows;
        // 请求失败清单：行级审计答不了"没有改到任何行的请求"，
        // 而那一类恰恰最容易藏着越权探测。
        const reqs = (await db.query(
          `SELECT actor, action, ok, error_code, at FROM app_request_log
            ORDER BY at DESC LIMIT 20`)).rows;
        const fails = (await db.query(
          `SELECT action, count(*)::int n FROM app_request_log
            WHERE NOT ok AND at > clock_timestamp() - interval '1 hour'
            GROUP BY action ORDER BY 2 DESC`)).rows;
        return json(res, 200, { as_of: asOf, summary, rows, requests: reqs, failures: fails });
      }

      // ---- 外包结算：两份数的对账 ----
      if (url.pathname === '/api/settlement') {
        const period = url.searchParams.get('period') || '2026-03';
        return await runRead(res, async (tx) => ({ period, rows: await settlement.list(tx, { period }) }));
      }

      if (url.pathname === '/api/settlement/diff') {
        const sup = Number(url.searchParams.get('supplier') || 1);
        const period = url.searchParams.get('period') || '2026-03';
        return await runRead(res, async (tx) => ({
          rows: await settlement.diff(tx, { supplierId: sup, period }),
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/settlement/build') {
        const sup = Number(url.searchParams.get('supplier') || 1);
        const period = url.searchParams.get('period') || '2026-03';
        return await runWrite(res, {
          actor: uid, action: 'settlement.build', subject: `supplier:${sup}@${period}`,
          fn: (tx) => settlement.build(tx, { userId: uid, supplierId: sup, period }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/settlement/confirm') {
        const id = Number(url.searchParams.get('id'));
        // ★ 确认人取自会话，不再硬编码 'cai_wu'。
        //   写死一个"操作人"会让留痕看起来齐全，而它记录的不是真实的人。
        return await runWrite(res, {
          actor: uid, action: 'settlement.confirm', subject: `settlement:${id}`,
          fn: (tx) => settlement.confirm(tx, { userId: uid, settlementId: id }),
        });
      }

      // ---- 我的权限：每条都要能回答"它从哪来" ----
      // ---- 开放层（MCP）：目录 / 预览 / 执行 ----
      // ★ 这里是"AI 改数据"的唯一入口。没有它，两阶段写就只是库里的一个函数，
      //   而所有客户端都会绕过它直接 UPDATE。
      if (url.pathname === '/api/mcp/tools') {
        return json(res, 200, { tools: mcp.listTools() });
      }

      // 只读：不建 plan，但仍走服务函数（掩码/行闸只有一份）并落审计。
      // ★ 用 GET 而不是 POST：只读工具不该产生"写"的语义，
      //   否则它会被限流、被算进写次数，读多写少的形态就看不出来了。
      if (url.pathname === '/api/mcp/read') {
        const toolName = url.searchParams.get('tool');
        const args = Object.fromEntries(url.searchParams.entries());
        delete args.tool;
        return await runRead(res, (tx) => mcp.read(tx, {
          toolName, args, actor: String(uid), actorId: uid,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/mcp/plan') {
        const toolName = url.searchParams.get('tool');
        const args = Object.fromEntries(url.searchParams.entries());
        delete args.tool;
        return await runWrite(res, {
          actor: uid, action: 'mcp.plan', subject: toolName,
          fn: (tx) => mcp.plan(tx, { toolName, args, actor: String(uid) }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/mcp/execute') {
        const planId = url.searchParams.get('plan');
        const toolName = url.searchParams.get('tool');
        const args = Object.fromEntries(url.searchParams.entries());
        delete args.plan; delete args.tool;
        return await runWrite(res, {
          actor: uid, action: 'mcp.execute', subject: `plan:${planId}`,
          fn: (tx) => mcp.execute(tx, {
            planId, toolName, args, actor: String(uid), actorId: uid,
          }),
        });
      }

      if (url.pathname === '/api/mcp/audit') {
        return await runRead(res, async (tx) => ({
          rows: await mcp.recentAudit(tx, {}),
          usage: await mcp.usage(tx),
        }));
      }

      // ---- 改口令：验旧 → 写新 → 撤其它会话 ----
      if (req.method === 'POST' && url.pathname === '/api/me/password') {
        // @no-runWrite: 失败计数必须先提交再抛错（同 /login）。走 runWrite 会把
        // "又错了一次"随回滚抹掉，于是改密接口成了不需要锁定的口令试错通道。
        let passwordInput = null;
        if (String(req.headers['content-type'] || '').includes('application/json')) {
          try { passwordInput = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); }
          catch { throw bizErr('E_TY_ARGUMENT', '改密请求须为JSON对象'); }
          if (!passwordInput || typeof passwordInput !== 'object' || Array.isArray(passwordInput)) throw bizErr('E_TY_ARGUMENT', '改密请求须为JSON对象');
        }
        // JSON avoids credentials in URLs; query parameters are retained only
        // for the existing client compatibility path during migration.
        const oldPwd = passwordInput ? (passwordInput.oldPassword ?? passwordInput.old) : url.searchParams.get('old');
        const newPwd = passwordInput ? (passwordInput.newPassword ?? passwordInput.new) : url.searchParams.get('new');
        let out;
        try {
          out = await withTx(db, (tx) => authn.changePassword(tx,
            { userId: uid, oldPassword: oldPwd, newPassword: newPwd, keepToken: auth }));
        } catch (e) {
          const m = toHttp(e);
          await logReq(uid, 'auth.password', `user:${uid}`, false, m.body.error, null);
          return json(res, m.status, m.body);
        }
        if (!out.ok) {
          const code = out.status === 'locked' ? 'E_AUTH_LOCKED' : 'E_AUTH_BAD_CREDENTIAL';
          await logReq(uid, 'auth.password', `user:${uid}`, false, code, null);
          return json(res, code === 'E_AUTH_LOCKED' ? 423 : 401, { error: code });
        }
        await logReq(uid, 'auth.password', `user:${uid}`, true, null,
                     { revoked_others: out.revokedOthers });
        return json(res, 200, { changed: true, revoked_others: out.revokedOthers });
      }

      // ---- 办离职：结束任职 + 结束归属 + 留原因（三件事在库里同一个函数）----
      if (req.method === 'POST' && url.pathname === '/api/employee/terminate') {
        const p = {
          userId: uid,
          employeeId: Number(url.searchParams.get('id')),
          leaveDate: url.searchParams.get('date'),
          reason: url.searchParams.get('reason') || '',
        };
        return await runWrite(res, {
          actor: uid, action: 'employee.terminate', subject: `employee:${p.employeeId}`,
          fn: (tx) => people.terminate(tx, p),
        });
      }

      // ---- 单人详情：点得进去才叫名单 ----
      if (url.pathname === '/api/employee') {
        const employeeId = Number(url.searchParams.get('id'));
        const asOf = url.searchParams.get('as_of');
        return await runRead(res, (tx) => people.detail(tx, { userId: uid, employeeId, asOf }));
      }

      // ---- 员工花名册：第一个"能看人"的出口 ----
      // ★ as_of 必传：不给默认值。默认"今天"会让同一个链接在不同日期给出不同答案，
      //   而报表口径必须能复现。
      if (url.pathname === '/api/employees') {
        const asOf = url.searchParams.get('as_of');
        return await runRead(res, async (tx) => {
          const rows = await people.roster(tx, { userId: uid, asOf });
          return { as_of: asOf, rows, count: rows.length,
            // 182：`count: 0` 有两种意思 —— "这家店没人" 与 "你还没被编到档口"。
            // state 是它们唯一的区别；没开能力位的角色这里恒为 off（看全店）。
            station_scope: await scope.stationScope(tx, { userId: uid, asOf }) };
        });
      }

      // ---- 工作台：「今天我要做什么」 ----
      // ★ 这个接口不做任何新的计算：四个数分别来自四个已有服务的**同一个函数**。
      //   首页自己写一遍 count，就会出现"首页说 3、点进去 4"这种两个都像对的差 ——
      //   与看板层同一条规矩（看板不许自己 sum）。
      if (url.pathname === '/api/home') {
        // ★ 默认期间取**业务当天所在月**，不写死 '2026-03'。
        //   原来写死的那个值让工作台永远显示一个已经过去半年的月份，
        //   而它的数字全都对 —— 那种"对但过期"最难发现。
        const periodParam = url.searchParams.get('period');
        return await runRead(res, async (tx) => {
          const period = periodParam
            || (await tx.query(`SELECT to_char(app_today(),'YYYY-MM') p`)).rows[0].p;
          // ★ 待办/抄送是「审批」资源的读；帐套管理员这类角色没有它。
          //   一个 403 不该把整个工作台打成"请求失败"——那样页面看起来像服务挂了。
          //   所以这两块单独兜：拿不到就标 blocked，其余四块照常给。
          let todos = null; let ccs = null; const blocked = [];
          try {
            todos = await approval.myTasks(tx, { userId: uid });
            ccs = await approval.myCc(tx, { userId: uid });
          } catch (e) {
            if (String(e.message).includes('E_RESOURCE_FORBIDDEN')) blocked.push('approval');
            else throw e;
          }
          const overdue = (await tx.query('SELECT id FROM v_exception_overdue')).rows;
          const unclosed = (await tx.query('SELECT store_id FROM fn_att_unclosed($1)', [period])).rows;
          // ★ 三件事一起修：
          //   ① 日期不写死 2026-11-14 —— 那让覆盖率永远算在半年多以前；
          //   ② `bucket <> 'pass'` 把 **unknown（从没跑过）** 也算成"未通过"，
          //      于是首页常驻一条"195 条判据未通过"，看起来像全线崩溃；
          //      没跑过 ≠ 失败，这两件事必须分开。
          //   ③ 只把 red/yellow 计入"异常"，unknown 单独给一个数。
          const cov = (await tx.query(
            `SELECT check_code, bucket FROM fn_chk_coverage(app_today())`)).rows;
          const notPass = cov.filter((x) => x.bucket === 'red' || x.bucket === 'yellow');
          const unknown = cov.filter((x) => x.bucket === 'unknown').length;
          return {
            period,
            // 只回数字与最少上下文；点进去才是明细
            todos: todos ? todos.length : null,
            ccs: ccs ? ccs.length : null,
            blocked,
            overdue_exceptions: overdue.length,
            unclosed_stores: unclosed.length,
            checks_not_pass: notPass.length,
            checks_unknown: unknown,
            // 只给前几个：首页是"该不该点进去"，不是"读一遍清单"
            checks_not_pass_sample: notPass.slice(0, 4)
              .map((x) => `${x.check_code}:${x.bucket}`),
          };
        });
      }

      // ---- 审批：发起 / 待办 / 审批一步 / 轨迹 ----
      if (req.method === 'POST' && url.pathname === '/api/approval/start') {
        const bizType = url.searchParams.get('biz_type');
        const bizId = Number(url.searchParams.get('biz_id'));
        const on = url.searchParams.get('on');
        return await runWrite(res, {
          actor: uid, action: 'approval.start', subject: `${bizType}:${bizId}`,
          fn: (tx) => approval.start(tx, { userId: uid, bizType, bizId, on }),
        });
      }

      if (url.pathname === '/api/approval/tasks') {
        return await runRead(res, async (tx) => ({ rows: await approval.myTasks(tx, { userId: uid }) }));
      }

      if (req.method === 'POST' && url.pathname === '/api/approval/act') {
        const instanceId = Number(url.searchParams.get('instance'));
        const approve = url.searchParams.get('approve') === '1';
        return await runWrite(res, {
          actor: uid, action: 'approval.act', subject: `instance:${instanceId}`,
          fn: (tx) => approval.act(tx, { userId: uid, instanceId, approve }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/approval/transfer') {
        const taskId = Number(url.searchParams.get('task'));
        const toUser = Number(url.searchParams.get('to'));
        const reason = url.searchParams.get('reason') || '';
        return await runWrite(res, {
          actor: uid, action: 'approval.transfer', subject: `task:${taskId}`,
          fn: (tx) => approval.transfer(tx, { userId: uid, taskId, toUser, reason }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/approval/delegate') {
        const p = {
          userId: uid,
          toUser: Number(url.searchParams.get('to')),
          fromDate: url.searchParams.get('from_date'),
          toDate: url.searchParams.get('to_date'),
          reason: url.searchParams.get('reason') || '',
        };
        return await runWrite(res, {
          actor: uid, action: 'approval.delegate', subject: `to:${p.toUser}`,
          fn: (tx) => approval.setDelegate(tx, p),
        });
      }

      if (url.pathname === '/api/approval/delegates') {
        return await runRead(res, async (tx) => ({ rows: await approval.myDelegates(tx, { userId: uid }) }));
      }

      if (req.method === 'POST' && url.pathname === '/api/approval/addsign') {
        const p = {
          userId: uid,
          taskId: Number(url.searchParams.get('task')),
          toUser: Number(url.searchParams.get('to')),
          reason: url.searchParams.get('reason') || '',
        };
        return await runWrite(res, {
          actor: uid, action: 'approval.addsign', subject: `task:${p.taskId}`,
          fn: (tx) => approval.addSign(tx, p),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/approval/cc') {
        const p = {
          userId: uid,
          instanceId: Number(url.searchParams.get('instance')),
          toUser: Number(url.searchParams.get('to')),
        };
        return await runWrite(res, {
          actor: uid, action: 'approval.cc', subject: `instance:${p.instanceId}`,
          fn: (tx) => approval.addCc(tx, p),
        });
      }

      if (url.pathname === '/api/approval/cc') {
        const all = url.searchParams.get('all') === '1';
        return await runRead(res, async (tx) => ({
          rows: await approval.myCc(tx, { userId: uid, all }),
          all,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/approval/cc/seen') {
        const ccId = Number(url.searchParams.get('id'));
        return await runWrite(res, {
          actor: uid, action: 'approval.cc.seen', subject: `cc:${ccId}`,
          fn: (tx) => approval.markCcSeen(tx, { userId: uid, ccId }),
        });
      }

      if (url.pathname === '/api/approval/trace') {
        const instanceId = Number(url.searchParams.get('instance'));
        return await runRead(res, (tx) => approval.trace(tx, { userId: uid, instanceId }));
      }

      // ---- 例外：必须有退出条件，到期必须看得见 ----
      if (url.pathname === '/api/exceptions') {
        return await runRead(res, async (tx) => ({
          overdue: (await tx.query('SELECT * FROM v_exception_overdue')).rows,
          active: (await tx.query(
            `SELECT id, kind_code, kind_name, severity, subject_type, subject_id,
                    owner, expires_at FROM v_exception_active ORDER BY expires_at`)).rows,
          kinds: (await tx.query(
            'SELECT code, name, default_ttl_days, max_ttl_days, severity FROM sys_exception_kind ORDER BY code')).rows,
        }));
      }

      // ---- 我的会话：在哪几台设备上；以及"退出其它设备" ----
      if (url.pathname === '/api/me/sessions') {
        return await runRead(res, async (tx) => ({
          rows: await session.listActive(tx, { userId: uid }),
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/me/sessions/revoke') {
        const id = Number(url.searchParams.get('id'));
        const reason = url.searchParams.get('reason') || '';
        return await runWrite(res, {
          actor: uid, action: 'session.revoke', subject: `session:${id}`,
          fn: (tx) => session.revokeMine(tx, { userId: uid, sessionId: id, reason }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/me/logout') {
        return await runWrite(res, {actor:uid,action:'session.logout',subject:'current session',
          fn:tx=>session.revoke(tx,{token:auth,by:String(uid),reason:'用户主动退出当前工作台'})});
      }

      if (req.method === 'GET' && url.pathname === '/api/me/capabilities') {
        return await runRead(res, async tx => {
          const rows=(await tx.query(`SELECT resource_code,
            fn_role_can($1,resource_code,'read') AS can_read,
            fn_role_can($1,resource_code,'write') AS can_write
            FROM sys_perm_resource ORDER BY resource_code`,[uid])).rows;
          const profile=await personaFor(tx,uid);
          if((await tx.query("SELECT to_regclass('public.ty_auth_managed') IS NOT NULL ok")).rows[0].ok&&(await(await import('./services/platform-adapters.mjs')).isManagedAccount(tx,uid))){
            const native=await import('./services/platform-core.mjs');
            const nativeResources=new Set((await tx.query('SELECT DISTINCT resource FROM ty_auth_managed WHERE account_id=$1',[uid])).rows.map(r=>r.resource));
            const groups=(await tx.query('SELECT DISTINCT group_id FROM ty_access_grant WHERE account_id=$1 UNION SELECT $2::bigint WHERE $2::bigint IS NOT NULL',[uid,profile?.group_id||null])).rows;
            const targets=(await tx.query('SELECT id,group_id FROM ty_company WHERE group_id=ANY($1::bigint[])',[groups.map(g=>g.group_id)])).rows;
            for(const r of rows){const possible=r.can_read||r.can_write||nativeResources.has(r.resource_code);r.can_read=false;r.can_write=false;if(!possible)continue;for(const g of groups){for(const company of [null,...targets.filter(c=>String(c.group_id)===String(g.group_id)).map(c=>c.id)]){
              const base={userId:uid,resource:r.resource_code,groupId:g.group_id,companyId:company,personId:profile?.person_id};
              if(!r.can_read)r.can_read=(await native.authorization(tx,{...base,action:'read'})).allowed;
              if(!r.can_write)r.can_write=(await native.authorization(tx,{...base,action:'write'})).allowed;
              if(r.can_read&&r.can_write)break;
            }if(r.can_read&&r.can_write)break;}}
          }
          // The current native binding is authoritative. A newly onboarded person
          // need not acquire an unrelated legacy record to open self-service.
          const person=profile?!!(profile.person_id&&profile.group_id&&(await tx.query('SELECT EXISTS(SELECT 1 FROM ty_person WHERE id=$1 AND group_id=$2)ok',[profile.person_id,profile.group_id])).rows[0].ok):!!(await tx.query('SELECT EXISTS(SELECT 1 FROM sys_account a JOIN person p ON p.id=a.person_id WHERE a.id=$1 AND a.status=\'active\')ok',[uid])).rows[0].ok;
          return {resources:Object.fromEntries(rows.map(r=>[r.resource_code,{can_read:r.can_read,can_write:r.can_write}])),
            profile_code:profile?.profile_code||null,has_person:!!person,has_outsource:profile?.profile_code==='outsourced_staff'||(profile?.person_id&&(await tx.query("SELECT to_regclass('public.ty_outsource_engagement')IS NOT NULL ok")).rows[0].ok?!!(await tx.query('SELECT EXISTS(SELECT 1 FROM ty_outsource_engagement WHERE person_id=$1)ok',[profile.person_id])).rows[0].ok:false)};
        });
      }

      // ---- 我是谁：正式界面右上角要显示"姓名 · 岗位"，而不是 user id ----
      if (url.pathname === '/api/me') {
        const row = (await db.query(
          `SELECT a.id, a.login, a.display_name AS name, a.person_id,
                  (SELECT string_agg(r.name, ' / ' ORDER BY r.code)
                     FROM fn_effective_roles(a.id, app_today()) e
                     JOIN sys_role r ON r.id = e.role_id AND r.is_active) AS role,
                  (SELECT string_agg(DISTINCT r.code, ',' ORDER BY r.code)
                     FROM fn_effective_roles(a.id, app_today()) e
                     JOIN sys_role r ON r.id = e.role_id AND r.is_active) AS role_codes,
                  (SELECT o.name FROM employee_org_assignment a2
                     JOIN org_unit o ON o.id = a2.org_id
                    WHERE a2.employee_id = a.person_id AND a2.dim_code = 'attendance_org'
                      AND daterange(a2.valid_from, a2.valid_to, '[]') @> app_today()
                    LIMIT 1) AS org,
                  (SELECT name FROM sys_ledger WHERE is_default LIMIT 1) AS ledger,
                  -- 组织页的「＋ 新增部门」要据此显隐：组织结构是帐套级结构，
                  -- 只有能改建帐的人才能动它。按钮在、点了 403，比不显示更糟。
                  fn_role_can(a.id,'ledger','write') AS can_org_write,
                  app_today() AS today, app_tz() AS tz
             FROM sys_account a WHERE a.id = $1`, [uid])).rows[0];
        // today 用**业务时区**（app_today），前端拿它做各页默认日期 ——
        // 前端本地时区可能是 UTC，用 new Date() 会在 0–8 点之间差一天。
        if (row && row.today instanceof Date) row.today = row.today.toISOString().slice(0, 10);
        return json(res, 200, row || { id: uid });
      }

      if (url.pathname === '/api/me/roles') {
        // ★ 原来这里默认写死 '2026-11-14'（演示残留）：于是**今天**新授的岗位
        //   在这个页面上看不到 —— 页面显示"没有任何有效权限"，而人其实有。
        //   默认值改成"业务时区的今天"，由 SQL 算（app_today），不在这里猜。
        const asOf = url.searchParams.get('as_of') || null;
        const r = await db.query(
          // ★ 带上角色名与范围名：界面上显示 #18 / #10 是给开发看的，
          //   业务看到的是"副店长 / 测试上海门店"。
          `SELECT er.role_id, r.code AS role_code, r.name AS role_name,
                  er.data_scope_id, ds.name AS scope_name,
                  er.source, er.via_org_id,
                  o.name AS via_org_name, o.path AS via_org_path
             FROM fn_effective_roles($1, COALESCE($2::date, app_today())) er
             LEFT JOIN sys_role r ON r.id = er.role_id
             LEFT JOIN sys_data_scope ds ON ds.id = er.data_scope_id
             LEFT JOIN org_unit o ON o.id = er.via_org_id
            ORDER BY r.code, er.source`, [uid, asOf]);
        const orgs = (await db.query(
          `SELECT o.id, o.name, c.depth FROM fn_user_org_chain($1, COALESCE($2::date, app_today())) c
             JOIN org_unit o ON o.id = c.org_id ORDER BY c.depth DESC`, [uid, asOf])).rows;
        const today = (await db.query('SELECT app_today() d')).rows[0].d;
        return json(res, 200, {
          as_of: asOf || (today instanceof Date ? today.toISOString().slice(0, 10) : String(today)),
          user_id: uid, roles: r.rows, org_chain: orgs,
        });
      }

      // ---- 制度：集团值 vs 本单位值 ----
      // 视角取「当前身份所属的最深组织」；没有挂组织就按集团看。
      if (url.pathname === '/api/policy') {
        // ★ 默认日期用业务时区的今天（原来写死 2026-03-05：新帐套上全是旧值）
        const asOf = url.searchParams.get('as_of')
          || (await db.query('SELECT app_today() d')).rows[0].d.toISOString().slice(0, 10);
        const orgRow = (await db.query(
          `SELECT org_id FROM fn_user_org_chain($1, COALESCE($2::date, app_today())) ORDER BY depth DESC LIMIT 1`,
          [uid, asOf])).rows[0];
        const orgId = orgRow ? Number(orgRow.org_id) : 1;

        const defs = (await db.query(`SELECT code,name,unit,value_type,allow_org_override,override_floor
                                        FROM policy_def ORDER BY code`)).rows;
        const out = [];
        for (const d of defs) {
          try {
            const eff = (await db.query(
              `SELECT value_num, value_text, source, via_org_id
                 FROM fn_policy_effective($1,$2,$3::date)`, [d.code, orgId, asOf])).rows[0];
            const grp = (await db.query(
              `SELECT value_num, value_text FROM policy_value WHERE policy_code=$1 AND effective_from <= $2::date
                ORDER BY effective_from DESC LIMIT 1`, [d.code, asOf])).rows[0];
            // ★ 数值型与文本/枚举型是两种值：只回 value_num 的话，
            //   HEADCOUNT_MODE / LEAVE_APPROVAL 这些 enum 项在页面上永远是空白 ——
            //   而"空白"会被读成"没配"，实际是"配了但没显示"。
            out.push({ ...d,
                       value: eff.value_num !== null ? eff.value_num : eff.value_text,
                       value_kind: eff.value_num !== null ? 'num' : 'text',
                       source: eff.source,
                       group_value: grp ? (grp.value_num !== null ? grp.value_num : grp.value_text) : null });
          } catch (e) {
            out.push({ ...d, value: null, source: 'no_value', error: String(e.message).split('\n')[0] });
          }
        }
        return json(res, 200, { as_of: asOf, org_id: orgId, rows: out });
      }

      // ---- 编制：额度 / 已下分 / 占编 三个数同屏 ----
      if (url.pathname === '/api/headcount') {
        const period = url.searchParams.get('period') || '2026-03';
        return await runRead(res, (tx) => headcount.view(tx, { userId: uid, period }));
      }

      // ---- 编制：下达 / 调整（追加版本，不就地改）----
      if (req.method === 'POST' && url.pathname === '/api/headcount/set') {
        const orgId = Number(url.searchParams.get('org'));
        const period = url.searchParams.get('period');
        const quota = Number(url.searchParams.get('quota'));
        const reason = url.searchParams.get('reason') || '';
        return await runWrite(res, {
          actor: uid, action: 'headcount.set', subject: `org:${orgId}@${period}`,
          fn: (tx) => headcount.setBudget(tx, { userId: uid, orgId, period, quota, reason }),
        });
      }

      // ---- 在线开库：一个帐套一个库（069/070）----------------------------
      // 真正的开库动作交给 tools/new-ledger.mjs（**不复制一份逻辑**）：
      // 建库、跑迁移、建根组织、建管理员 —— 那六步只该有一处实现，
      // 否则"命令行能开、界面开的库少了某步"这种事故永远不会被发现。
      if (req.method === 'POST' && url.pathname === '/api/ledger/provision') {
        // @no-runWrite: 开库要十几秒（建库 + 跑 70 个迁移），不能一直占着一个
        //   事务连接；权限另用一个短事务判完就放掉，结果由 logReq 单独留痕。
        if (!registry) {
          return json(res, 409, {
            error: 'E_LEDGER_SINGLE',
            message: '当前是单库模式（未设 CONTROL_URL），不能在线开库；用 tools/new-ledger.mjs',
          });
        }
        const p = {
          code: (url.searchParams.get('code') || '').trim(),
          name: (url.searchParams.get('name') || '').trim(),
          period: (url.searchParams.get('period') || '').trim(),
          admin: (url.searchParams.get('admin') || 'admin').trim(),
          pwd: url.searchParams.get('pwd') || 'demo1234',
        };
        // 权限先在一个**短事务**里判：开库要十几秒，不能一直占着连接
        try {
          await withTx(db, (tx) => requireSession(tx, {
            userId: uid, resource: 'ledger', action: 'write',
          }));
        } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }

        const out = await provisionLedger(p);
        registry.invalidate();
        await logReq(uid, 'ledger.provision', `ledger:${p.code}`, out.ok, out.ok ? null : 'E_LEDGER_PROVISION',
                     { steps: out.steps.length });
        return json(res, out.ok ? 200 : 500, out);
      }

      // ---- 建帐：帐套 / 组织 / 账号（065）-------------------------------
      // 三条都是"结构性"写入：建帐只写帐套、组织、账号与制度，不灌业务数据。
      if (url.pathname === '/api/ledger') {
        const list = (await db.query(
          `SELECT l.id, l.code, l.name, l.start_period, l.status, l.is_default, l.activated_at,
                  (SELECT count(*)::int FROM org_unit o WHERE o.ledger_id = l.id) orgs,
                  (SELECT count(*)::int FROM sys_account a WHERE a.ledger_id = l.id) accounts
             FROM sys_ledger l ORDER BY l.is_default DESC, l.id`)).rows;
        return json(res, 200, { ledgers: list, ledger: list.find(x => x.is_default) || list[0] || null });
      }

      if (req.method === 'POST' && url.pathname === '/api/ledger/open') {
        const p = { code: url.searchParams.get('code'), name: url.searchParams.get('name'),
                    period: url.searchParams.get('period') };
        return await runWrite(res, {
          actor: uid, action: 'ledger.open', subject: `ledger:${p.code}`,
          fn: async (tx) => {
            // ★ 建帐是结构性写入：只给 admin / 帐套管理员（070）。
            //   不能因为"HR 能加门店"就顺手让他能开一个新公司。
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            return { id: Number((await tx.query(
              'SELECT fn_ledger_open($1,$2,$3,$4) id',
              [p.code, p.name, p.period, String(uid)])).rows[0].id) };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/ledger/activate') {
        return await runWrite(res, {
          actor: uid, action: 'ledger.activate', subject: 'ledger',
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            await tx.query('SELECT fn_ledger_activate($1)', [String(uid)]);
            return { activated: true };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/org') {
        const p = { parent: url.searchParams.get('parent') ? Number(url.searchParams.get('parent')) : null,
                    name: url.searchParams.get('name'), kind: url.searchParams.get('kind') || 'store' };
        return await runWrite(res, {
          actor: uid, action: 'org.add', subject: `org:${p.name}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            return { id: Number((await tx.query(
              'SELECT fn_org_add($1,$2,$3) id', [p.parent, p.name, p.kind])).rows[0].id) };
          },
        });
      }

      // ---- 组织维护：改名 / 移动 / 停用 ----
      // ★ 三个都要求 ledger 写权限：组织结构是**帐套级**结构，改它比改人更重。
      //   判据全在库函数里（086），路由这里只做参数搬运 —— 判据只有一处实现。
      if (req.method === 'POST' && url.pathname === '/api/org/rename') {
        const p = { org: Number(url.searchParams.get('org')), name: url.searchParams.get('name') || '' };
        return await runWrite(res, {
          actor: uid, action: 'org.rename', subject: `org:${p.org}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            const name = (await tx.query('SELECT fn_org_rename($1,$2) n', [p.org, p.name])).rows[0].n;
            return { id: p.org, name, _log: { name } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/org/move') {
        const p = { org: Number(url.searchParams.get('org')),
                    parent: Number(url.searchParams.get('parent')) };
        return await runWrite(res, {
          actor: uid, action: 'org.move', subject: `org:${p.org}->${p.parent}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            const path = (await tx.query('SELECT fn_org_move($1,$2) p', [p.org, p.parent])).rows[0].p;
            return { id: p.org, parent_id: p.parent, path, _log: { from_to: `${p.org}->${p.parent}`, path } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/org/active') {
        const p = { org: Number(url.searchParams.get('org')),
                    active: url.searchParams.get('active') !== '0' };
        return await runWrite(res, {
          actor: uid, action: p.active ? 'org.enable' : 'org.disable', subject: `org:${p.org}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            const active = (await tx.query('SELECT fn_org_set_active($1,$2) a',
              [p.org, p.active])).rows[0].a;
            return { id: p.org, is_active: active, _log: { active } };
          },
        });
      }

      // ---- 门店档口（172）：开通 / 预置 / 关档 / 配编制 ----
      // ★ 四条都用 `headcount` 写权限，**不另立资源码**，也不复用 `ledger`：
      //   档口是编制的载体 —— 配档口这件事和 /api/headcount/set 是同一档
      //   （"这家店这几个岗各要几个人"）。
      //   不用 `ledger`（建帐）有两个理由：① 建部门是**帐套级**动作，档口只在
      //   一家店内部换分法，两者不是一个量级；② 实测演示帐套里 group_hr /
      //   store_hr 都没有 ledger 写（那是建帐管理员的事），用了它，
      //   真正要配档口的人反而配不了，而"配不了"看起来像"功能没做"。
      // ★ 四条都必须再过 requireOrg(… dim:'cost_org', action:'write')：
      //   岗位层管"这类事能不能做"，行闸管"这一家店能不能动" ——
      //   A 店 HR 能配自己店的档口，拿别家店的 id 要 403。只查岗位不查行闸，
      //   越权写会成功，而成功的表现是"另一家店的编制被改了"，没有任何一处报错。
      if (req.method === 'POST' && url.pathname === '/api/org/station/enable') {
        const p = { store: Number(url.searchParams.get('store') || 0),
                    station: Number(url.searchParams.get('station') || 0),
                    from: url.searchParams.get('from') || null,
                    seq: url.searchParams.get('seq') ? Number(url.searchParams.get('seq')) : null };
        return await runWrite(res, {
          actor: uid, action: 'station.enable', subject: `store:${p.store}/station:${p.station}`,
          fn: async (tx) => {
            if (!p.store || !p.station) {
              throw bizErr('E_ARG_INVALID', 'store 与 station 都必须给（门店 id / 档口 id）');
            }
            await requireOrg(tx, { userId: uid, resource: 'headcount', orgId: p.store,
                                   dim: 'cost_org', action: 'write' });
            // 起始日先落到具体值：一句 SQL 里用 COALESCE 看不出"到底用了哪天"，
            // 而错误信息要带这个日期，两者必须是同一个值。
            const from = p.from
              || (await tx.query(`SELECT to_char(app_today(),'YYYY-MM-DD') d`)).rows[0].d;
            // 名字先取出来：错误信息里出现裸 id（"档口 5"）是同一个毛病的一半 ——
            // 说清楚是哪个档口，人才知道去关哪一段。
            const label = await stationLabel(tx, p.station);
            let id;
            try {
              id = Number((await tx.query(
                `SELECT fn_store_station_enable($1,$2,$3::date,$4) id`,
                [p.store, p.station, from, p.seq])).rows[0].id);
            } catch (e) {
              // 回溯开通 / 改起始日会撞 ex_ss_no_overlap（23P01）—— 翻成人话再抛
              rethrowStationOverlap(e, label, String(from).slice(0, 10));
            }
            // ★ 幂等命中要说出来。fn_store_station_enable 在"该日期已落在既有区间内"
            //   时直接返回原 id —— 日期改了也不生效、也不报错。走查看到的正是这个：
            //   `enable(from=2026-07-01)` 拿回 6 月 1 日那段，接口 200，人事以为改成功了。
            //   **一个没生效的操作看起来成功**，比报错更难查（现场只会说"我改了没反应"）。
            //   所以把"实际生效的起始日"回给前端，和请求的不一致就是 idempotent。
            const seg = (await tx.query(
              `SELECT to_char(opened_at,'YYYY-MM-DD') d FROM store_station WHERE id = $1`,
              [id])).rows[0];
            const actual = seg ? String(seg.d).slice(0, 10) : null;
            const want = String(from).slice(0, 10);
            return { id, store_id: p.store, station_id: p.station,
                     from: actual, requested_from: want,
                     idempotent: actual != null && actual !== want,
                     _log: { from, actual, seq: p.seq } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/org/station/preset') {
        const p = { store: Number(url.searchParams.get('store') || 0),
                    brand: url.searchParams.get('brand_line') || 'common',
                    from: url.searchParams.get('from') || null };
        return await runWrite(res, {
          actor: uid, action: 'station.preset', subject: `store:${p.store}/brand:${p.brand}`,
          fn: async (tx) => {
            if (!p.store) throw bizErr('E_ARG_INVALID', 'store 必须给（门店 id）');
            await requireOrg(tx, { userId: uid, resource: 'headcount', orgId: p.store,
                                   dim: 'cost_org', action: 'write' });
            // 品牌线不认识就拒 —— 静默降级成 common 会"少铺几个档口"而不报错
            p.brand = await assertBrandLine(tx, p.brand);
            // ★ 预置**只开档口、不定编**：定编要一个一个岗位配（一个档口几个岗、
            //   每个岗几个编，是店型决定的，替客户猜会猜出"每家店都 8 个档口"）。
            const n = Number((await tx.query(
              `SELECT fn_store_station_preset($1,$2,COALESCE($3::date, app_today())) n`,
              [p.store, p.brand, p.from])).rows[0].n);
            return { store_id: p.store, brand_line: p.brand, enabled: n,
                     _log: { brand: p.brand, enabled: n } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/org/station/close') {
        const p = { store: Number(url.searchParams.get('store') || 0),
                    station: Number(url.searchParams.get('station') || 0),
                    to: url.searchParams.get('to') || null };
        return await runWrite(res, {
          actor: uid, action: 'station.close', subject: `store:${p.store}/station:${p.station}`,
          fn: async (tx) => {
            if (!p.store || !p.station) {
              throw bizErr('E_ARG_INVALID', 'store 与 station 都必须给（门店 id / 档口 id）');
            }
            await requireOrg(tx, { userId: uid, resource: 'headcount', orgId: p.store,
                                   dim: 'cost_org', action: 'write' });
            const to = p.to
              || (await tx.query(`SELECT to_char(app_today(),'YYYY-MM-DD') d`)).rows[0].d;
            const ssId = await resolveStoreStation(tx, p.store, p.station, to);
            // 判据在库里（还有人在岗就拒），路由只搬参数 —— E_STN_IN_USE 会带名字回去
            const label = await stationLabel(tx, p.station);
            try {
              await tx.query(`SELECT fn_store_station_close($1,$2::date)`, [ssId, to]);
            } catch (e) {
              // 把结束日往后推、越过后来重开的那一段，同样会撞 23P01
              rethrowStationOverlap(e, label, String(to).slice(0, 10));
            }
            return { store_station_id: ssId, store_id: p.store, station_id: p.station,
                     closed_at: String(to).slice(0, 10), _log: { to } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/org/station/position') {
        const p = { store: Number(url.searchParams.get('store') || 0),
                    station: Number(url.searchParams.get('station') || 0),
                    position: Number(url.searchParams.get('position') || 0),
                    month: (url.searchParams.get('month') || '').trim(),
                    headcount: Number(url.searchParams.get('headcount')),
                    reason: (url.searchParams.get('reason') || '档口定编').trim() };
        return await runWrite(res, {
          actor: uid, action: 'station.position',
          subject: `store:${p.store}/station:${p.station}/pos:${p.position}@${p.month}`,
          fn: async (tx) => {
            if (!p.store || !p.station || !p.position) {
              throw bizErr('E_ARG_INVALID', 'store / station / position 三个都必须给');
            }
            if (!Number.isInteger(p.headcount) || p.headcount < 0) {
              throw bizErr('E_ARG_INVALID', 'headcount 必须是非负整数（0 = 这个岗不要人，与"未定编"不同）');
            }
            // ★ 配编制是改编制，所以资源码用 headcount（与 /api/headcount/set 同档）；
            //   行闸仍按这家店 —— 有集团编制权不等于能改别家店的档口。
            await requireOrg(tx, { userId: uid, resource: 'headcount', orgId: p.store,
                                   dim: 'cost_org', action: 'write' });
            const month = p.month
              || (await tx.query(`SELECT to_char(app_today(),'YYYY-MM') m`)).rows[0].m;
            const ssId = await resolveStoreStation(tx, p.store, p.station, `${month}-01`);
            const ver = (await tx.query('SELECT fn_sp_set($1,$2,$3,$4,$5,$6) v',
              [ssId, p.position, month, p.headcount, String(uid), p.reason])).rows[0].v;
            // 回读三个数：走 fn_station_fill（唯一口径），页面拿到的就是它会显示的值
            const back = (await tx.query(
              `SELECT station_quota, station_slots, station_gap
                 FROM fn_station_fill($1::bigint,
                        (date_trunc('month', $2::date) + interval '1 month - 1 day')::date)
                WHERE store_station_id = $3`, [p.store, `${month}-01`, ssId])).rows[0] || {};
            return { store_station_id: ssId, period: month, version: Number(ver),
                     headcount: p.headcount,
                     station_quota: back.station_quota, station_slots: back.station_slots,
                     station_gap: back.station_gap,
                     _log: { position: p.position, headcount: p.headcount, reason: p.reason } };
          },
        });
      }

      // ---- 岗位：建档 / 任职 / 撤任 / 停用 ----
      // 与组织同一档权限：岗位是"组织怎么分工"的一部分，不是某个人的属性。
      if (req.method === 'POST' && url.pathname === '/api/position') {
        const p = {
          code: (url.searchParams.get('code') || '').trim(),
          name: (url.searchParams.get('name') || '').trim(),
          org: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null,
          level: Number(url.searchParams.get('level') || 2),
          outsourced: url.searchParams.get('outsourced') === '1',
          desc: url.searchParams.get('desc') || null,
        };
        return await runWrite(res, {
          actor: uid, action: 'position.upsert', subject: `position:${p.code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            const id = Number((await tx.query(
              'SELECT fn_position_upsert($1,$2,$3,$4,$5,$6) id',
              [p.code, p.name, p.org, p.level, p.outsourced, p.desc])).rows[0].id);
            return { id, code: p.code, _log: { name: p.name, org: p.org } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/position/assign') {
        const p = { person: Number(url.searchParams.get('person')),
                    position: Number(url.searchParams.get('position')),
                    from: url.searchParams.get('from') || null };
        return await runWrite(res, {
          actor: uid, action: 'position.assign', subject: `position:${p.position}/p${p.person}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            const id = Number((await tx.query(
              `SELECT fn_position_assign($1,$2,COALESCE($3::date, app_today()),$4) id`,
              [p.person, p.position, p.from, String(uid)])).rows[0].id);
            return { id, _log: { person: p.person, position: p.position } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/position/end') {
        const p = { person: Number(url.searchParams.get('person')),
                    position: Number(url.searchParams.get('position')),
                    on: url.searchParams.get('on') || null };
        return await runWrite(res, {
          actor: uid, action: 'position.end', subject: `position:${p.position}/p${p.person}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            await tx.query('SELECT fn_position_end($1,$2,COALESCE($3::date, app_today()))',
              [p.person, p.position, p.on]);
            return { ok: true, _log: { person: p.person, position: p.position, on: p.on } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/position/active') {
        const p = { position: Number(url.searchParams.get('position')),
                    active: url.searchParams.get('active') !== '0' };
        return await runWrite(res, {
          actor: uid, action: p.active ? 'position.enable' : 'position.disable',
          subject: `position:${p.position}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            const active = (await tx.query('SELECT fn_position_active($1,$2) a',
              [p.position, p.active])).rows[0].a;
            return { id: p.position, is_active: active, _log: { active } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/account') {
        const p = { login: url.searchParams.get('login'), display: url.searchParams.get('display'),
                    role: url.searchParams.get('role'),
                    org: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null,
                    pwd: url.searchParams.get('pwd') || 'demo1234' };
        return await runWrite(res, {
          actor: uid, action: 'account.create', subject: `account:${p.login}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            const id = Number((await tx.query(
              'SELECT fn_account_create($1,$2,$3,$4,NULL,$5) id',
              [p.login, p.display, p.role, p.org, String(uid)])).rows[0].id);
            // 口令摘要只能在应用层算（库侧只存摘要）——与登录同一份 scrypt 参数
            await tx.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
              [id, authn.hashPassword(p.pwd)]);
            return { id };
          },
        });
      }

      // ---- 排班看板：一周网格（人 × 日 × 班次颜色）----
      // ★ 这条读的是 067 的 roster_slot 看板层（名字随 145 改为 fn_roster_slot_week：
      //   它**不参与算薪**）。读"计划 → 段 → 确认单"那条链路的是下面的
      //   /api/roster/week —— 两者数据源不同，把它们的名字分开是 145 做的第一件事。
      if (url.pathname === '/api/roster') {
        // store=0 / 不传 → NULL = 全员（fn_roster_slot_week 支持）
        const storeId = Number(url.searchParams.get('store') || 0) || null;
        const from = url.searchParams.get('from')
          || (await db.query('SELECT app_today() d')).rows[0].d.toISOString().slice(0, 10);
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'roster' });
          const shifts = (await tx.query(
            `SELECT code, name, color, is_rest FROM shift_def ORDER BY start_time`)).rows;
          const rows = (await tx.query(
            `SELECT * FROM fn_roster_slot_week($1::bigint,$2::date)`, [storeId, from])).rows;
          return { store_id: storeId, from, shifts, rows };
        });
      }

      // ---- 排班：划线刷班（一次一片，全成或全不成）----
      if (req.method === 'POST' && url.pathname === '/api/roster/paint') {
        const p = {
          storeId: Number(url.searchParams.get('store')),
          dates: String(url.searchParams.get('dates') || '').split(',').filter(Boolean),
          employees: String(url.searchParams.get('employees') || '').split(',').filter(Boolean).map(Number),
          shift: url.searchParams.get('shift') || null,
        };
        return await runWrite(res, {
          actor: uid, action: 'roster.paint', subject: `store:${p.storeId}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'roster', action: 'write' });
            const n = (await tx.query('SELECT fn_roster_paint($1,$2::date[],$3::bigint[],$4,$5) n',
              [p.storeId, p.dates, p.employees, p.shift, String(uid)])).rows[0].n;
            return { painted: Number(n) };
          },
        });
      }

      // ---- 排班写入（145）：排 → 推 → 确认 → 锁 ----
      // ★ 四个动作一个都不能跳：确认只收 pushed，锁定只收 store_confirmed，
      //   所以"直接锁"这条路在库里就不存在。
      if (req.method === 'GET' && url.pathname === '/api/roster/week') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterWrite.week(tx, {
          userId: uid, storeId: Number(q.get('store')), from: q.get('from'),
          days: q.get('days'),
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/assign') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.assign',
          subject: `person:${q.get('employee')}@${q.get('date')}`,
          fn: (tx) => rosterWrite.assign(tx, {
            userId: uid, employeeId: Number(q.get('employee')), date: q.get('date'),
            shift: q.get('shift'), storeId: Number(q.get('store')), reason: q.get('reason'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/clear') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.clear',
          subject: `person:${q.get('employee')}@${q.get('date')}`,
          fn: (tx) => rosterWrite.clear(tx, {
            userId: uid, employeeId: Number(q.get('employee')), date: q.get('date'),
            shift: q.get('shift'),
          }),
        });
      }

      // ---- 借调 / 人员调度（153）----
      // 核心机制：审批通过时写一条"带有效期的 attendance_org 归属"，
      // 而不是每天跑作业搬归属 —— 到期自然失效，不会漏跑、不会重复搬。
      if (req.method === 'GET' && url.pathname === '/api/roster/dispatch') {
        const q = url.searchParams;
        return await runRead(res, (tx) => dispatch.list(tx, {
          userId: uid, orgId: Number(q.get('org')) || null,
          employeeId: Number(q.get('employee')) || null,
          status: q.get('status') || null, period: q.get('period') || null }));
      }

      if (req.method === 'GET' && url.pathname === '/api/roster/dispatch/active') {
        const q = url.searchParams;
        return await runRead(res, (tx) => dispatch.active(tx, {
          userId: uid, employeeId: Number(q.get('employee')), on: q.get('on') }));
      }

      if (req.method === 'GET' && url.pathname === '/api/roster/dispatch/cost') {
        const q = url.searchParams;
        return await runRead(res, (tx) => dispatch.cost(tx, {
          userId: uid, fromOrg: Number(q.get('from_org')), period: q.get('period') }));
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/dispatch/create') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.dispatch.create',
          subject: `person:${q.get('employee')}->org:${q.get('to_org')}`,
          fn: (tx) => dispatch.create(tx, {
            userId: uid, employeeId: Number(q.get('employee')),
            toOrg: Number(q.get('to_org')), from: q.get('from'), to: q.get('to'),
            reason: q.get('reason') }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/dispatch/approve') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.dispatch.approve', subject: `dispatch:${q.get('id')}`,
          fn: (tx) => dispatch.approve(tx, {
            userId: uid, id: Number(q.get('id')), ok: q.get('ok') === '1',
            note: q.get('note') }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/dispatch/end') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.dispatch.end', subject: `dispatch:${q.get('id')}`,
          fn: (tx) => dispatch.end(tx, {
            userId: uid, id: Number(q.get('id')), on: q.get('on') }),
        });
      }

      // ---- 换班审批（154）：自换 / 互换 / 代班 / 被代班 ----
      // ★ 对方确认（agreed）之后主管才批（approved），批完才动排班 ——
      //   一人点两下就换班，等于没人负责。
      if (req.method === 'GET' && url.pathname === '/api/roster/swap') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterSwap.list(tx, {
          userId: uid, status: q.get('status') || null, kind: q.get('kind') || null,
          person: Number(q.get('person')) || null,
          from: q.get('from') || null, to: q.get('to') || null }));
      }

      if (req.method === 'GET' && url.pathname === '/api/roster/swap/log') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterSwap.log(tx, {
          userId: uid, person: Number(q.get('person')) || null,
          from: q.get('from') || null, to: q.get('to') || null }));
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/swap/create') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.swap.create', subject: `person:${q.get('from_person')}`,
          fn: (tx) => rosterSwap.create(tx, {
            userId: uid, kind: q.get('kind') || 'self',
            fromPerson: Number(q.get('from_person')),
            toPerson: q.get('to_person') ? Number(q.get('to_person')) : null,
            fromDate: q.get('from_date'), fromSeg: q.get('from_seg') || null,
            toDate: q.get('to_date') || null, toSeg: q.get('to_seg') || null,
            toShift: q.get('to_shift') || null, reason: q.get('reason') }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/swap/agree') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.swap.agree', subject: `swap:${q.get('id')}`,
          fn: (tx) => rosterSwap.agree(tx, { userId: uid, id: Number(q.get('id')) }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/swap/decide') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.swap.decide', subject: `swap:${q.get('id')}`,
          fn: (tx) => rosterSwap.decide(tx, {
            userId: uid, id: Number(q.get('id')), ok: q.get('ok') === '1',
            note: q.get('note') }),
        });
      }

      // ---- 排班统计（155）----
      if (url.pathname === '/api/roster/stat/rate') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterReport.rate(tx, {
          userId: uid, orgId: Number(q.get('org') || 10), from: q.get('from'),
          days: q.get('days') }));
      }

      if (url.pathname === '/api/roster/stat/heat') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterReport.heat(tx, {
          userId: uid, orgId: Number(q.get('org') || 10), from: q.get('from'),
          days: q.get('days') }));
      }

      if (url.pathname === '/api/roster/stat/hours') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterReport.hours(tx, {
          userId: uid, orgId: Number(q.get('org') || 10), from: q.get('from'),
          days: q.get('days') }));
      }

      // ---- 批量：复制 / 导入 / 导出（151）----
      // ★ 导入是"部分成功"：100 行里 3 行错，97 行要进去、错的逐条报。
      //   整批回滚会让人对着一千行去找那 3 行。
      if (req.method === 'POST' && url.pathname === '/api/roster/copy') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.copy',
          subject: `person:${q.get('employee')}@${q.get('to')}`,
          fn: (tx) => rosterBulk.copy(tx, {
            userId: uid, employeeId: Number(q.get('employee')),
            from: q.get('from'), to: q.get('to') }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/copy-week') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.copy.week',
          subject: `person:${q.get('employee')}@${q.get('dst')}`,
          fn: (tx) => rosterBulk.copyWeek(tx, {
            userId: uid, employeeId: Number(q.get('employee')),
            srcMonday: q.get('src'), dstMonday: q.get('dst') }),
        });
      }

      if (url.pathname === '/api/roster/export') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterBulk.exportRows(tx, {
          userId: uid, storeId: Number(q.get('store')), from: q.get('from'),
          days: q.get('days') }));
      }

      // 导入走**请求体**而不是 query：几百行 JSON 塞进 URL 会被长度上限截断，
      // 而截断后的 JSON 解析失败会变成"一行都没导入"，看起来像权限或格式问题。
      if (req.method === 'POST' && url.pathname === '/api/roster/import') {
        let buf;
        try { buf = await readBody(req); } catch (e) {
          const m = toHttp(e); return json(res, m.status, m.body);
        }
        let rows;
        try {
          const body = JSON.parse(buf.toString('utf8') || 'null');
          rows = Array.isArray(body) ? body : body && body.rows;
        } catch (e) {
          return json(res, 400, { error: 'E_ARG_INVALID', message: '请求体要是 JSON：{rows:[…]}' });
        }
        return await runWrite(res, {
          actor: uid, action: 'roster.import',
          subject: `rows:${Array.isArray(rows) ? rows.length : 0}`,
          fn: (tx) => rosterBulk.importRows(tx, { userId: uid, rows }),
        });
      }

      // ---- 班组排班 / 周期排班（150）----
      // ★ 六条动作一个都不含"猜"：班组是"给一组人排同一天同一个班"，
      //   周期是"按模板循环铺一段"，两者的部分成功都必须回给页面（skipped）。
      if (req.method === 'GET' && url.pathname === '/api/roster/team') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterTeam.teams(tx, {
          userId: uid, orgId: q.get('org'),
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/team/create') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.team.create', subject: `org:${q.get('org')}`,
          fn: (tx) => rosterTeam.createTeam(tx, {
            userId: uid, name: q.get('name'), orgId: q.get('org'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/team/add') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.team.add', subject: `team:${q.get('team')}`,
          fn: (tx) => rosterTeam.addMembers(tx, {
            userId: uid, teamId: q.get('team'), employeeIds: q.get('employee'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/team/assign') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.team.assign',
          subject: `team:${q.get('team')}@${q.get('date')}`,
          fn: (tx) => rosterTeam.assignTeam(tx, {
            userId: uid, teamId: q.get('team'), date: q.get('date'),
            shift: q.get('shift'), storeId: q.get('store'),
          }),
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/roster/cycle') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterTeam.cycles(tx, {
          userId: uid, orgId: q.get('org'),
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/cycle/set') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.cycle.set', subject: `cycle:${q.get('id') || 'new'}`,
          fn: (tx) => rosterTeam.setCycle(tx, {
            userId: uid, id: q.get('id'), name: q.get('name'), orgId: q.get('org'),
            pattern: q.get('pattern'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/cycle/apply') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.cycle.apply',
          subject: `person:${q.get('employee')}@${q.get('from')}~${q.get('to')}`,
          fn: (tx) => rosterTeam.applyCycle(tx, {
            userId: uid, cycleId: q.get('cycle'), employeeId: q.get('employee'),
            from: q.get('from'), to: q.get('to'), storeId: q.get('store'),
          }),
        });
      }

      // ---- 排班规则（149）----
      if (url.pathname === '/api/roster/rule') {
        const orgId = Number(url.searchParams.get('org') || 10);
        return await runRead(res, (tx) => rosterRule.current(tx, { userId: uid, orgId }));
      }

      if (url.pathname === '/api/roster/rule/check') {
        const q = url.searchParams;
        return await runRead(res, (tx) => rosterRule.check(tx, {
          userId: uid, employeeId: Number(q.get('employee')), date: q.get('date'),
          orgId: Number(q.get('org') || 10), minutes: q.get('minutes'),
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/rule/set') {
        const q = url.searchParams;
        const patch = {
          name: q.get('name'),
          max_min_workday: q.get('max_min_workday'),
          max_min_restday: q.get('max_min_restday'),
          max_min_holiday: q.get('max_min_holiday'),
          max_min_week: q.get('max_min_week'),
          max_min_month: q.get('max_min_month'),
          max_consecutive_days: q.get('max_consecutive_days'),
          min_rest_days_month: q.get('min_rest_days_month'),
          warn_daily_hours: q.get('warn_daily_hours'),
          can_edit_past: q.get('can_edit_past') === '1',
          publish_mode: q.get('publish_mode'),
          remind_enabled: q.get('remind_enabled') === '1',
          remind_before_days: q.get('remind_before_days'),
          remind_scope: q.get('remind_scope'),
        };
        return await runWrite(res, {
          actor: uid, action: 'roster.rule.set', subject: `org:${q.get('org')}`,
          fn: (tx) => rosterRule.set(tx, {
            userId: uid, orgId: Number(q.get('org') || 10), patch }),
        });
      }

      // ---- 划线排班（148）：上到几点就划到几点 ----
      if (req.method === 'POST' && url.pathname === '/api/roster/line') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.line',
          subject: `person:${q.get('employee')}@${q.get('date')}`,
          fn: (tx) => rosterWrite.line(tx, {
            userId: uid, employeeId: Number(q.get('employee')), date: q.get('date'),
            from: q.get('from'), to: q.get('to'), storeId: Number(q.get('store')),
            breakMin: q.get('break'), reason: q.get('reason'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/push') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.push', subject: `store:${q.get('store')}@${q.get('period')}`,
          fn: (tx) => rosterWrite.push(tx, {
            userId: uid, storeId: Number(q.get('store')), period: q.get('period'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/confirm') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.confirm', subject: `store:${q.get('store')}@${q.get('period')}`,
          fn: (tx) => rosterWrite.confirm(tx, {
            userId: uid, storeId: Number(q.get('store')), period: q.get('period'),
            ok: q.get('ok'), note: q.get('note'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/roster/lock') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'roster.lock', subject: `store:${q.get('store')}@${q.get('period')}`,
          fn: (tx) => rosterWrite.lock(tx, {
            userId: uid, storeId: Number(q.get('store')), period: q.get('period'),
          }),
        });
      }

      // ---- 制度发布：改一项制度值（立即生效、有留痕、不追溯历史）----
      // ★ 不是通用"改任意制度项"的开关：只允许 SYSTEM_POLICIES 白名单里的项，
      //   其余项（算薪口径、编制比例）该走各自的业务入口，否则会出现
      //   "绕过业务校验直接改配置"的后门。
      if (req.method === 'POST' && url.pathname === '/api/policy/publish') {
        const code = String(url.searchParams.get('code') || '');
        const value = String(url.searchParams.get('value') || '').trim();
        const reason = String(url.searchParams.get('reason') || '').trim();
        const SYSTEM_POLICIES = ['BIZ_TIMEZONE', 'PWD_MIN_LEN', 'PWD_NEED_MIX'];
        if (!SYSTEM_POLICIES.includes(code)) {
          return json(res, 403, {
            error: 'E_POLICY_NOT_SYSTEM',
            message: `制度项 ${code} 不在系统级白名单里（只能改 ${SYSTEM_POLICIES.join(' / ')}）`,
          });
        }
        if (reason.length < 4) {
          return json(res, 400, { error: 'E_ARG_INVALID', message: '必须写原因（至少 4 个字）' });
        }
        return await runWrite(res, {
          actor: uid, action: 'policy.publish', subject: `${code}=${value}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'ledger', action: 'write' });
            if (code === 'BIZ_TIMEZONE') {
              // 时区名写错在这里就拒，而不是等到某天算薪
              await tx.query('SELECT fn_biz_timezone_check($1)', [value]);
            }
            const numeric = /^-?\d+(\.\d+)?$/.test(value);
            // ★ 时区**只保留一条**：它没有"历史版本"的意义（不存在"上个月的时区"），
            //   而保留多行会踩自引用 —— 发布时 effective_from 用 app_today()，
            //   而 app_today() 又依赖当前时区：改 UTC 的过程中它会变成另一天，
            //   于是"切回"写进了另一行，最新一条仍是 UTC，看起来像"改不回去"。
            if (code === 'BIZ_TIMEZONE') {
              await tx.query(`DELETE FROM policy_value WHERE policy_code = 'BIZ_TIMEZONE'`);
            }
            await tx.query(
              `INSERT INTO policy_value(policy_code, effective_from, value_num, value_text,
                                        published_by, reason)
               VALUES ($1, app_today(), $2, $3, $4, $5)
               ON CONFLICT (policy_code, effective_from) DO UPDATE
                  SET value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text,
                      published_by = EXCLUDED.published_by, reason = EXCLUDED.reason`,
              [code, numeric ? Number(value) : null, numeric ? null : value, String(uid), reason]);
            const now = (await tx.query(
              `SELECT app_tz() tz, app_today() d`)).rows[0];
            return {
              code, value,
              tz: now.tz,
              today: now.d instanceof Date ? now.d.toISOString().slice(0, 10) : String(now.d),
            };
          },
        });
      }

      // ---- 组织架构：部门树（含人数、类型、上级）----
      // 界面上"组织"这一页要能看见真实结构：集团 → 区域 → 部门（可嵌套）。
      //
      // ★ 172 加了两件事，都是**加字段**、不改既有字段的含义：
      //   ① `?on=` 可选（默认业务今日）。加它的原因不是"功能"，是**可测**：
      //      编制是月粒度的，不传日期就只能断言"今天"，而演示数据与工资期间
      //      通常不在今天 —— 那种断言最后一定会被改成"跳过"。
      //   ② 三个档口字段（stations / station_gap / station_unset）。门店节点上
      //      显示"档口 5 · 缺 3"，点开看明细走 /api/org/stations。
      if (url.pathname === '/api/org/tree') {
        const onRaw = url.searchParams.get('on');
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'employee_roster' });
          // 日期先解析成字符串再进 SQL：让所有子查询与 fn_station_fill 用**同一个**值，
          // 而不是各自调一次 app_today()（跨零点会得到两个日期，而那种差一天
          // 在页面上表现为"档口缺 1 人，点开明细没有缺岗行"）。
          const on = onRaw
            || (await tx.query(`SELECT to_char(app_today(),'YYYY-MM-DD') d`)).rows[0].d;
          // ★ 这条 SQL 原来对**每个节点**各算一遍 headcount / subtree / 档口，
          //   60 店时 11.4 秒。现在三样都改成"一次算完再按节点取"：
          //     · headcount / subtree：先把人按 org 聚合（direct），再沿 path 滚（roll）。
          //       subtree 用"各节点去重人数之和"而不是"子树里去重"—— 两者相等，
          //       因为 ex_eoa_no_overlap 保证一个人同一维度同时只有一段有效归属。
          //     · 档口：一次 fn_station_fill_all(on)，在 JS 里按 store_id 分组。
          //   实测 3448ms → 约 100ms（另加档口全量 308ms）。
          const rows = (await tx.query(
            `WITH RECURSIVE t AS (
               SELECT o.id, o.parent_id, o.name, o.kind, o.path, o.is_active,
                      0 AS depth
                 FROM org_unit o WHERE o.parent_id IS NULL
               UNION ALL
               SELECT c.id, c.parent_id, c.name, c.kind, c.path, c.is_active, t.depth + 1
                 FROM org_unit c JOIN t ON c.parent_id = t.id
             ),
             direct AS (
               -- cnt 给"直属人数"（沿用 count(*)），dis 给 subtree（去重）
               SELECT a.org_id, count(*)::int AS cnt,
                      count(DISTINCT a.employee_id)::int AS dis
                 FROM employee_org_assignment a
                 JOIN employment e ON e.person_id = a.employee_id
                                  AND daterange(e.hire_date, e.leave_date, '[]') @> $1::date
                WHERE a.dim_code = 'attendance_org'
                  AND daterange(a.valid_from, a.valid_to, '[]') @> $1::date
                GROUP BY a.org_id
             ),
             roll AS (
               SELECT t.id, COALESCE(sum(d.dis), 0)::int AS subtree
                 FROM t
                 JOIN org_unit sub ON sub.path LIKE t.path || '%'
                 LEFT JOIN direct d ON d.org_id = sub.id
                GROUP BY t.id
             )
             SELECT t.id, t.parent_id, t.name, t.kind, t.depth, t.is_active,
                    COALESCE(d0.cnt, 0)::int AS headcount,
                    r.subtree
               FROM t
               LEFT JOIN direct d0 ON d0.org_id = t.id
               JOIN roll r ON r.id = t.id
               ORDER BY t.path`, [on])).rows;

          // 档口三数：**一次**取回全部门店的明细（174 的 fn_station_fill_all），
          // 再按 store_id 聚合。原来是对 60 个门店各调一次 fn_station_fill（8.3 秒）。
          // 聚合规则必须与"逐店调再相加"完全一致 —— 尤其 gap 只在 > 0 时计入，
          // 且**没有档口**时上游给 null（不是 0），见下面 nStation 那三行。
          const fillAll = (await tx.query(
            `SELECT store_id, store_station_id, headcount, gap, station_quota,
                    station_quota_status
               FROM public.fn_station_fill_all($1::date)`, [on])).rows;
          const stAgg = new Map();
          for (const f of fillAll) {
            const sid = Number(f.store_id);
            let a = stAgg.get(sid);
            if (!a) { a = { ss: new Set(), gap: 0, unset: new Set(), carried: new Set() }; stAgg.set(sid, a); }
            const ssId = Number(f.store_station_id);
            // 一个档口可能有多行（每岗一行）—— 档口数按 store_station 去重，
            // 不能数行数（否则"一个档口两个岗"会把它算成两个档口）
            if (!a.ss.has(ssId)) {
              a.ss.add(ssId);
              if (f.headcount == null) a.unset.add(ssId);
              // 181：本期没配、沿用更早一期的档口要单独计数 —— 树上"未定编 0"
              // 与"没人在管编制"是两件事，沿用月里后者会被前者盖住。
              if (f.station_quota_status === 'carried'
                  || f.station_quota_status === 'mixed') a.carried.add(ssId);
            }
            if (f.gap != null && Number(f.gap) > 0) a.gap += Number(f.gap);
          }

          // 编制：本期（业务月）的额度。缺编 = 编制 - 在编（负数 = 超编）。
          // ★ 走 `fn_hc_quota_effective`，不自己查 headcount_budget：
          //   183 起编制是**沿用**的（本期没定编 → 取最近一个更早的期），
          //   而"沿用"这件事只能从 status 看出来。自己查表会得到"没定编就是空"，
          //   于是同一页上"档口编沿用 9"与"门店编 空"并排出现 —— 看着像数据丢了。
          //   ★ 状态与出处必须一起带出去（quota_status / quota_carried_from）：
          //     只给数不给出处，等于把上期预算静默当成本期预算。
          const period = String(on).slice(0, 7);
          const quota = new Map((await tx.query(
            `SELECT o.id AS org_id, e.status, e.quota, e.carried_from
               FROM org_unit o,
                    LATERAL public.fn_hc_quota_effective(o.id, $1) e`,
            [period])).rows.map((r) => [Number(r.org_id), {
              quota: r.quota == null ? null : Number(r.quota),
              status: r.status,
              carried_from: r.carried_from,
            }]));

          // fn_station_fill 的 `gap` 只算缺口（>0），这里保留 null 语义：
          // 没有档口 → null（不是 0），有档口且不缺 → 0。
          // 谁有下级：有下级的组织，人长在**子树**里，编制却是"下辖之和"，
          // 于是"编制 − 直属在编"会把整个下辖的编都报成缺口
          // （集团 388 编、直属 0 人 → 报缺 388，而真实缺口是 14）。
          // ★ 只数**启用**的下级：全部下级都停用的部门，人只能挂在自己身上，
          //   那它就是叶子，该按直属比。
          const parents = new Set(rows
            .filter((r) => r.parent_id != null && r.is_active !== false)
            .map((r) => Number(r.parent_id)));
          const withQuota = rows.map((r) => {
            const qe = quota.get(Number(r.id)) || { quota: null, status: 'unset', carried_from: null };
            const q = qe.quota;
            const hasKids = parents.has(Number(r.id));
            const a = stAgg.get(Number(r.id));
            const nStation = a ? a.ss.size : 0;
            return {
              ...r,
              // ★ 字段顺序刻意与 174 之前保持一致（stations/station_gap/station_unset
              //   在 quota/gap 之前）。值一样、顺序不一样，JSON 就不再逐字节相同 ——
              //   而"优化前后 diff 为空"是这次的验收方式，别让顺序把它弄脏。
              stations: nStation,
              // 没有档口 → null（不是 0），与 /api/org/stations 的 store.gap 同口径。
              // 有档口且都不缺 → 0。这两件事必须不同形（ST12a / ST12b 两面钉住）。
              station_gap: nStation > 0 ? a.gap : null,
              station_unset: nStation > 0 ? a.unset.size : null,
              // 181：「沿用上期」的档口数。与 station_unset 并列给 —— 漏配的月份
              // 在树上就不会长得跟配过的月份一样。
              station_carried: nStation > 0 ? a.carried.size : null,
              quota: q,
              // 183：这个编是本期定的（set）、沿用更早一期（carried）、还是从来没有过（unset）。
              // ★ 必须紧跟在 quota 后面给 —— 沿用之后，"这期没定编"只能从这里看出来；
              //   把这两个字段删掉，页面就会把上期预算当成这期预算显示，而它看起来完全正常。
              quota_status: qe.status,
              quota_carried_from: qe.carried_from,
              // ★ 有下级 → 比**含下级**（subtree）；叶子 → 比直属。
              //   subtree 本身已经包含自己（`sub.path LIKE t.path||'%'` 命中 t 自己），
              //   所以叶子这两个数相等，分支只是为了让"集团 388 编 / 直属 0 人 / 缺 14"
              //   这一行在页面上算得通。
              gap: q === null ? null
                : q - Number(hasKids ? r.subtree : r.headcount),
              has_kids: hasKids,
            };
          });
          return {
            rows: withQuota,
            period,
            on,
            today: (await tx.query('SELECT app_today() d')).rows[0].d,
          };
        });
      }

      // ---- 档口词表：某品牌线可选哪些档口（172）----
      // 铺档口的下拉列表用它 —— 天妇罗专门店的候选里不该出现烧腊档。
      // 读口径与组织页同一个资源码（employee_roster）：能看这棵树就能看有哪些档口可选。
      if (url.pathname === '/api/org/station/choices') {
        const brandRaw = url.searchParams.get('brand_line') || 'common';
        return await runRead(res, async (tx) => {
          await prepareRead(tx, { userId: uid, resource: 'employee_roster' });
          const brand = await assertBrandLine(tx, brandRaw);
          const rows = (await tx.query(
            `SELECT * FROM fn_station_choices($1)`, [brand])).rows;
          return { brand_line: brand, rows };
        });
      }

      // ---- 组织架构：某门店的档口与缺岗明细（172）----
      // 三个数（编制 / 到岗 / 缺岗）与缺岗明细**一次取齐**。
      // ★ 不拆成"档口清单"和"缺岗明细"两个接口：拆开就有两处口径，
      //   而两处口径迟早不同步 —— 那时页面会把"编制 8、到岗 8、缺 1"
      //   并排显示，每个数单独看都对。
      if (url.pathname === '/api/org/stations') {
        const store = Number(url.searchParams.get('store') || 0);
        const detail = url.searchParams.get('detail') === '1';
        const onRaw = url.searchParams.get('on');
        if (!store) throw bizErr('E_STATION_NO_STORE', '必须给 store（门店的 org_unit.id）');
        return await runRead(res, async (tx) => {
          // ★ 行闸：能看这棵树 ≠ 能看别家店的编制。
          //   requireOrg 两层都过（岗位层 fn_role_can + 行闸 tmp_scope_org），
          //   传别家店的 id 会 403。**不能只 requireSession 了事** ——
          //   那样门店 HR 换个 id 就能看别家的缺岗，而返回的是一份正常清单，
          //   看不出任何异常（170 记下的四个接口就是这个形态）。
          await requireOrg(tx, { userId: uid, resource: 'employee_roster', orgId: store });
          const org = (await tx.query(
            `SELECT id, name, kind FROM org_unit WHERE id = $1`, [store])).rows[0];
          if (!org) throw bizErr('E_STATION_NO_STORE', `组织 ${store} 不存在`);
          // ★ 顺序要紧：先判范围（上面，403）再判存在（404）最后判类型（400）。
          //   反过来，越权的人能靠"400 还是 404"把 org_unit 的 id 空间探一遍。
          // ★ 非部门节点没有档口这件事 —— 区域/集团返回一份空清单看起来像
          //   "这个区域没配档口"，而事实是"档口这个概念只在门店里有"。
          //   现在只有前端自觉不调；MCP / 导出接进来之后，空清单会被当成结论读走。
          if (org.kind !== 'dept') {
            throw bizErr('E_STN_NOT_STORE',
              `组织 ${org.id}（${org.name}）的类型是 ${org.kind} —— 档口只挂在部门（门店）下`);
          }

          const on = onRaw
            || (await tx.query(`SELECT to_char(app_today(),'YYYY-MM-DD') d`)).rows[0].d;
          const rows = (await tx.query(
            `SELECT * FROM public.fn_station_fill($1::bigint, $2::date)`, [store, on])).rows;

          // 日期列在 PGlite 里回来是 Date 对象，String(d).slice(0,10) 会得到
          // "Sun Mar 01 2026" 而不是 "2026-03-01"（multi-org.mjs 记过这个坑）。
          const day = (v) => (v == null ? null
            : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));
          const num = (v) => (v == null ? null : Number(v));

          const stations = [];
          const byId = new Map();
          for (const r of rows) {
            const id = Number(r.store_station_id);
            if (!byId.has(id)) {
              const s = {
                store_station_id: id,
                station_id: Number(r.station_id),
                station_code: r.station_code,
                station_name: r.station_name,
                line_code: r.line_code,
                seq: Number(r.station_seq),
                quota: num(r.station_quota),
                // ★ 181：「定了就一直用」—— 这一期没重新配时，编制沿用自更早一期。
                //   沿用本身是对的，但它有个副作用：**漏配的月份与配过的月份同形**。
                //   所以状态必须分开给（set / carried / mixed / unset），页面才能写
                //   "沿用 2026-06 的定编"。压成一个 quota 数字 = 把"没配"这件事藏起来。
                quota_status: r.station_quota_status || 'unset',
                carried_from: r.station_carried_from || null,   // 仅 carried 有值
                slots_filled: Number(r.station_slots),   // 岗次：一人两岗算两次
                holders: Number(r.station_holders),      // 人头：一人两岗算一次
                gap: num(r.station_gap),
                positions: [],
              };
              byId.set(id, s);
              stations.push(s);
            }
            if (r.position_id != null) {
              byId.get(id).positions.push({
                position_id: Number(r.position_id),
                position_code: r.position_code,
                position_name: r.position_name,
                level: Number(r.position_level),
                headcount: num(r.headcount),
                holders: Number(r.holders),
                gap: num(r.gap),
                gap_since: day(r.gap_since),
                days_open: num(r.days_open),
                holder_names: r.holder_names || '',
                // 岗位级三态（181）：mixed 档口里逐岗看才知道哪些是沿用的
                quota_status: r.quota_status || 'unset',
                carried_from: r.carried_from || null,
              });
            }
          }
          // ★ 「这个岗位上期在哪个档口」——重组是允许的（见 docs/48 §14），
          //   但**允许**和**看得懂**是两件事：7 月把「天妇罗师傅」从「天妇罗台」
          //   挪到「收银档」之后，任何人翻到那一屏第一反应都是"数据错"。
          //   事实本来就在库里（station_position 按期 append-only），
          //   只是**能被 API 读到的事实才算演示里可用的证据** —— 写在文档里的 SQL
          //   是"可查"，不是"可答"。
          //   一店一次查询（不是一岗一次），且只取"最近一个更早的期次"，
          //   因为期次可能不连续（演示库里只有 06 与 11 两期）。
          if (detail && stations.length) {
            const moved = (await tx.query(
              `WITH latest AS (
                 SELECT sp.position_id, sp.period, ss.station_id
                   FROM station_position sp
                   JOIN store_station ss ON ss.id = sp.store_station_id
                  WHERE ss.store_id = $1 AND sp.period <= $2
                    AND sp.version = (SELECT max(x.version) FROM station_position x
                                       WHERE x.store_station_id = sp.store_station_id
                                         AND x.position_id = sp.position_id
                                         AND x.period = sp.period)
               ),
               cur AS (SELECT position_id, station_id FROM latest WHERE period = $2),
               prev AS (
                 SELECT DISTINCT ON (position_id) position_id, period, station_id
                   FROM latest WHERE period < $2
                  ORDER BY position_id, period DESC
               )
               SELECT p.position_id, p.period AS prev_period,
                      st.name AS prev_station_name
                 FROM prev p
                 JOIN cur c ON c.position_id = p.position_id
                 JOIN station st ON st.id = p.station_id
                WHERE p.station_id <> c.station_id`,
              [store, String(on).slice(0, 7)])).rows;
            const movedBy = new Map(moved.map((m) => [Number(m.position_id), m]));
            for (const s of stations) {
              for (const p of (s.positions || [])) {
                const m = movedBy.get(p.position_id);
                if (m) {
                  p.prev_period = String(m.prev_period);
                  p.prev_station_name = m.prev_station_name;
                }
              }
            }
          }
          for (const s of stations) {
            if (!detail) delete s.positions;
          }

          // 外包工时：**不进**上面任何一个数字（不占编、不算到岗）。
          // 外包没有 person_position，硬算等于给外包编一个假身份（019:64-67）；
          // 而且不做 FTE 折算 —— 折算要"标准月工时"，全系统工时口径只有
          // schedule_segment 一处（150:25-26），再开一个是第二条算薪口径。
          const ext = (await tx.query(
            `SELECT COALESCE(sum(t.hours), 0)::numeric AS hours,
                    count(DISTINCT t.worker_id)::int AS workers
               FROM supplier_timesheet t
               JOIN outsourced_assignment oa ON oa.worker_id = t.worker_id
              WHERE oa.store_id = $1
                AND daterange(oa.valid_from, oa.valid_to, '[]') @> t.work_date
                AND t.work_date >= (date_trunc('month', $2::date))::date
                AND t.work_date <  (date_trunc('month', $2::date) + interval '1 month')::date`,
            [store, on])).rows[0] || { hours: 0, workers: 0 };

          const h = rows[0] || {};
          // 一家档口都没配的店：fn_station_fill 返回 0 行，门店编与人头就带不出来。
          // 这条分支只在"还没铺档口"时走，但要给数 —— 否则页面显示"门店编 —"，
          // 而它其实有编，只是还没分到档口。
          let bare = null;
          if (rows.length === 0) {
            bare = (await tx.query(
              `SELECT public.fn_hc_quota($1::bigint, to_char($2::date,'YYYY-MM')) AS quota,
                      (SELECT count(DISTINCT a.employee_id)::int
                         FROM employee_org_assignment a
                         JOIN employment e ON e.person_id = a.employee_id
                                           AND daterange(e.hire_date, e.leave_date, '[]') @> $2::date
                        WHERE a.dim_code = 'cost_org'
                          AND daterange(a.valid_from, a.valid_to, '[]') @> $2::date
                          AND a.org_id = $1) AS heads`,
              [store, on])).rows[0] || {};
          }
          // ★ 181：`stations_configured` 不能再按 `quota !== null` 数。
          //   沿用的档口 quota 也有值 —— 那样数等于把"这个月忘了配"从计数里抹掉，
          //   于是"未定编 0"在读代码的人眼里表示"都配了"，而事实可能是"沿用了半年"。
          //   三个计数各自对应一种状态，不合并（合并就是把沿用的副作用还回去）。
          const unsetCnt = stations.filter((s) => s.quota_status === 'unset').length;
          const carriedCnt = stations.filter((s) => s.quota_status === 'carried').length;
          const mixedCnt = stations.filter((s) => s.quota_status === 'mixed').length;
          const setCnt = stations.length - unsetCnt - carriedCnt - mixedCnt;
          // ★ 一个档口都没有 → 缺岗是 **null**，不是 0。
          //   对空集合求和恒为 0，于是"这家店压根没配档口"与"配了档口但刚好满编"
          //   长得一模一样 —— 而 `gap: 0` 会被导出/报表/MCP 读成"编制刚好够"。
          //   这正是 172 登记的 SUITE.ST-GAP 要防的那件事（SQL 层本来是对的，
          //   是这一句聚合把它摊平了）。与 /api/org/tree 的 station_gap 同口径。
          //
          //   station_quota 保持 0（不改成 null）：它是对空集合求**和**，
          //   0 是正确答案，且 "unallocated = 门店编 − 0" 正好推出"全都没分下去"。
          //   两个字段一个改 null 一个留 0 不是不一致 —— 一个是**判断**（缺不缺人），
          //   一个是**求和**。判断在没有对象时无意义，求和在空集合上有确定答案。
          const gapTotal = stations.length === 0 ? null
            : stations.filter((s) => s.gap !== null && s.gap > 0)
              .reduce((a, s) => a + s.gap, 0);
          const storeQuota = num(h.store_quota != null ? h.store_quota : bare?.quota);
          return {
            store: {
              id: Number(org.id), name: org.name, kind: org.kind,
              // 门店编沿用 fn_hc_quota（022 的唯一实现），**不是** Σ档口编 ——
              // 两者差出来的就是还没分到档口的编（店长/副店长这类不进档口的岗）
              quota: storeQuota,
              // 门店到岗是**人头**（cost_org 口径），档口到岗是**岗次**。
              // 一人两岗时 Σ档口岗次 > 门店人头，这不是算错（083:152-153）。
              headcount: num(h.store_heads != null ? h.store_heads : bare?.heads),
              // 门店编 − Σ已定编档口编，**单位是编（岗次），不是人**。
              // ★ 名字里带 quota 就是为了堵这个误读：有人会把它答成
              //   "没分到档口的人"（那是 headcount − holders，另一件事）。
              //   一家档口都没配时它就是门店编全部（还没往下分）。
              quota_unallocated: storeQuota === null
                ? null
                : (h.store_unallocated != null ? Number(h.store_unallocated) : storeQuota),
              station_count: stations.length,
              station_quota: stations.reduce((a, s) => a + (s.quota || 0), 0),
              slots_filled: stations.reduce((a, s) => a + s.slots_filled, 0),
              holders: stations.reduce((a, s) => a + s.holders, 0),
              gap: gapTotal,
              // 本期真配过（全部岗位都是 set）
              stations_configured: setCnt,
              // 沿用：整个档口一个岗都没本期配过（carried） / 一部分配了一部分沿用（mixed）
              stations_carried: carriedCnt,
              stations_mixed: mixedCnt,
              // 从来没有配过（连可沿用的都没有）—— 与"配了但缺 0"不同形
              stations_unset: unsetCnt,
            },
            extern: { hours: Number(ext.hours || 0), workers: Number(ext.workers || 0) },
            stations,
            on,
            period: String(on).slice(0, 7),
          };
        });
      }

      // ---- 我的工资表：结构 + 制度 + 提成 + 报销 + 最近一期工资条 ----
      // ★ 一次取回：工资表是"一个人一份"，分四次往返会让页面出现
      //   "结构已到、工资条还在转"的半截状态，而半截的数最容易被当成结论。
      if (url.pathname === '/api/salary/plan') {
        const wantPerson = Number(url.searchParams.get('person') || 0);
        const period = url.searchParams.get('period') || null;
        let viewArg = null;
        const sent = await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payslip' });
          // ★ 账号 id ≠ 人员 id（admin 这类无人员的账号会把两者错开一格）。
          //   "我是谁"必须走 resolveEmployee —— 全系统只有这一份换算，
          //   在这里另写一遍 `person = uid` 会让工资表查到**下一个人**身上，
          //   而它看起来只是"数据没配上"。
          // ★ 钱相关：不允许“账号没挂人员就退回 uid”——那会让管理账号看到别人的工资表。
          //   实测：集团人事（account 4 / person NULL）打开「我的工资表」看到的是员工 4 的月薪，
          //   而同一页的签收按钮点下去报 E_NO_EMPLOYEE —— 一屏两个答案。
          const me = await resolveEmployee(tx, uid, { allowFallback: false }).catch(() => null);
          const person = wantPerson || (me ? Number(me.personId) : 0);
          if (!person) throw bizErr('E_NO_EMPLOYEE', '当前账号没有对应的人员记录，看不到工资表');
          // 看自己随时可以；看别人要有薪酬读权限（能看工资条 ≠ 能看所有人的结构）
          if (!me || person !== Number(me.personId)) {
            const ok = (await tx.query(`SELECT fn_role_can($1,'payroll_run','read') o`, [uid])).rows[0].o;
            if (!ok) throw bizErr('E_RESOURCE_FORBIDDEN', '看别人的工资表需要薪酬读权限');
          }
          const on = period
            ? (await tx.query(`SELECT (to_date($1||'-01','YYYY-MM-DD') + interval '1 month - 1 day')::date d`,
                [period])).rows[0].d
            : (await tx.query('SELECT app_today() d')).rows[0].d;
          const emp = (await tx.query(
            `SELECT e.id, e.person_id, e.legal_entity_id
               FROM employment e
              WHERE e.person_id = $1
                AND daterange(e.hire_date, e.leave_date, '[]') @> $2::date
              ORDER BY e.hire_date DESC LIMIT 1`, [person, on])).rows[0];
          if (!emp) return { person, period, employment: null, items: [], message: '这个人在本期没有在职记录' };

          const std = (await tx.query(
            `SELECT monthly_amount, effective_from FROM salary_standard
              WHERE employment_id = $1 AND effective_from <= $2::date
              ORDER BY effective_from DESC LIMIT 1`, [emp.id, on])).rows[0] || null;
          const items = (await tx.query(
            `SELECT item_code, name, amount FROM fn_salary_structure_of($1,$2::date)`,
            [emp.id, on])).rows;
          const pol = async (code) => (await tx.query(
            `SELECT value_num, value_text FROM fn_policy_effective($1, NULL, $2::date)`,
            [code, on])).rows[0] || null;
          const pWork = await pol('PAY_WORK_HOURS_DAY');
          const pDays = await pol('PAY_DAYS_PER_MONTH');
          const pHol  = await pol('PAY_LEGAL_HOLIDAY');

          const periodOf = period || (await tx.query('SELECT app_today() d')).rows[0].d.toISOString().slice(0, 7);
          const comm = (await tx.query(`SELECT fn_commission_amount($1,$2) a`,
            [person, periodOf])).rows[0].a;
          const exp = (await tx.query(`SELECT fn_expense_amount($1,$2) a`,
            [person, periodOf])).rows[0].a;
          const expRows = (await tx.query(
            `SELECT id, period, category, amount, note, status FROM expense_claim
              WHERE person_id = $1 AND period = $2 ORDER BY id DESC`, [person, periodOf])).rows;
          const commRows = (await tx.query(
            `SELECT id, period, amount, basis, status FROM commission_record
              WHERE person_id = $1 AND period = $2 ORDER BY id DESC`, [person, periodOf])).rows;

          // 最近一张已算出的工资条（不限期间：没算过就是 null，不是空壳）
          const slip = (await tx.query(
            `SELECT p.id, pr.period, p.gross_amount, p.si_employee, p.tax_amount, p.net_amount
               FROM payslip p JOIN pay_run pr ON pr.id = p.pay_run_id
              -- ★ 只看月度条：年终奖是单独一批（kind='bonus'），
              --   混进来会让"我的工资表"在 12 月显示成一张奖金条。
              WHERE p.employee_id = $1 AND pr.kind = 'monthly'
                AND pr.status IN ('sealed','paid','draft')
              ORDER BY pr.period DESC LIMIT 1`, [person])).rows[0] || null;
          if (slip) {
            slip.items = (await tx.query(
              `SELECT i.item_code, COALESCE(si.name, i.item_code) AS name, i.amount
                 FROM payslip_item i
                 LEFT JOIN salary_item si ON si.code = i.item_code
                WHERE i.payslip_id = $1
                ORDER BY (i.item_code='BASE') DESC, i.item_code`, [slip.id])).rows;
          }
          const out = {
            person, period: periodOf, employment_id: emp.id,
            monthly_amount: std?.monthly_amount ?? null,
            effective_from: std?.effective_from ?? null,
            work_hours_day: pWork?.value_num ?? null,
            days_per_month: pDays?.value_num ?? null,
            legal_holiday: pHol?.value_text ?? null,
            items, commission: comm, commission_rows: commRows,
            expense: exp, expense_rows: expRows,
            payslip: slip,
          };
          // ★ 留痕（184）：这是"**点开某一个人**看他的工资条"的入口 ——
          //   subject 用请求里的 person（不是自报的 uid），payslip_id 用真正返回的那张。
          //   看自己时 recordView 会发现 subject == fn_my_person(uid) 并跳过。
          if (slip) {
            viewArg = { scope: 'single', subject: person, payslipId: slip.id, rowCount: 1 };
          }
          return out;
        }, () => viewArg && logPayslipView({ actor: uid, ip: reqIp(req), ...viewArg }));
        return sent;
      }

      // ---- 法定节假日维护：每年 11 月国务院公布，客户自己灌下一年 ----
      // 权限同薪酬政策：改一天的类型，整月的应出勤与加班费都会变。
      if (url.pathname === '/api/att/holidays') {
        const year = Number(url.searchParams.get('year') || new Date().getFullYear());
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'read' });
          const canWrite = (await tx.query(
            `SELECT fn_role_can($1,'payroll_policy','write') o`, [uid])).rows[0].o;
          const rows = (await tx.query(`SELECT * FROM fn_holiday_year($1)`, [year])).rows;
          const legal = rows.filter(r => r.holiday_type === 'legal').length;
          // 缺口检查（130）：页面顶部那条状态条就是它，不用自己拼规则
          const gaps = (await tx.query(`SELECT level, code, hint FROM fn_holiday_year_check($1)`,
            [year])).rows;
          // 覆盖表：今年 + 明年。明年没数据这件事必须在**今年**就看见，
          // 等到 1 月算薪才发现，那个月的应出勤已经算错了。
          const coverage = (await tx.query(`SELECT * FROM fn_holiday_coverage($1,2)`,
            [year])).rows;
          return { year, rows, canWrite, legalCount: legal, gaps, coverage };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/holidays/skeleton') {
        const year = Number(url.searchParams.get('year'));
        return await runWrite(res, {
          actor: uid, action: 'att.holiday.skeleton', subject: `year:${year}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            if (!Number.isInteger(year) || year < 2000 || year > 2100) {
              throw bizErr('E_ARG_INVALID', 'year 要写 2027 这样的年份');
            }
            const n = Number((await tx.query(`SELECT fn_holiday_skeleton($1,$2) n`,
              [year, String(uid)])).rows[0].n);
            return { year, created: n, _log: { year, created: n } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/holidays/confirm') {
        const year = Number(url.searchParams.get('year'));
        return await runWrite(res, {
          actor: uid, action: 'att.holiday.confirm', subject: `year:${year}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            const n = Number((await tx.query(`SELECT fn_holiday_confirm($1,$2) n`,
              [year, String(uid)])).rows[0].n);
            return { year, confirmed: n, _log: { year, confirmed: n } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/holiday') {
        const date = String(url.searchParams.get('date') || '');
        const name = String(url.searchParams.get('name') || '').trim();
        const type = String(url.searchParams.get('type') || 'legal');
        const note = url.searchParams.get('note') || null;
        return await runWrite(res, {
          actor: uid, action: 'att.holiday.upsert', subject: `holiday:${date}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              throw bizErr('E_ARG_INVALID', '日期要写 2026-10-01 这样');
            }
            await tx.query(`SELECT fn_holiday_upsert($1::date,$2,$3,$4)`,
              [date, name, type, note]);
            return { date, name, holiday_type: type, _log: { type } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/holiday/delete') {
        const date = String(url.searchParams.get('date') || '');
        return await runWrite(res, {
          actor: uid, action: 'att.holiday.delete', subject: `holiday:${date}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            const n = (await tx.query(
              `DELETE FROM legal_holiday WHERE holiday_date = $1::date RETURNING holiday_date`,
              [date])).rowCount;
            if (!n) throw bizErr('E_NOT_FOUND', `${date} 本来就没有登记`);
            return { date, _log: { date } };
          },
        });
      }

      // 批量粘贴：每行「日期,名称,类型」。比做一整套导入批次轻，且够用（一年 30 行）。
      if (req.method === 'POST' && url.pathname === '/api/att/holiday/bulk') {
        let text = '';
        try {
          const buf = await readBody(req, 1024 * 1024);
          text = buf.toString('utf8');
        } catch (e) {
          const m = toHttp(e); return json(res, m.status, m.body);
        }
        return await runWrite(res, {
          actor: uid, action: 'att.holiday.bulk', subject: 'holiday:bulk',
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
            if (!lines.length) throw bizErr('E_IMPORT_EMPTY', '没有内容');
            const rows = []; let ok = 0, fail = 0;
            for (const [i, line] of lines.entries()) {
              const [d, name, type] = line.split(/[,，\t]/).map(x => (x || '').trim());
              if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || !name) {
                rows.push({ row_no: i + 1, ok: false, error: '格式应为：日期,名称,类型' });
                fail += 1; continue;
              }
              try {
                await tx.query(`SELECT fn_holiday_upsert($1::date,$2,$3,$4)`,
                  [d, name, type || 'legal', '批量导入']);
                rows.push({ row_no: i + 1, ok: true, error: null, payload: { d, name, type: type || 'legal' } });
                ok += 1;
              } catch (e) {
                rows.push({ row_no: i + 1, ok: false, error: String(e.message).split('\n')[0] });
                fail += 1;
              }
            }
            return { total: lines.length, ok, fail, rows, _log: { ok, fail } };
          },
        });
      }

      // ---- 假种：官方预置 + 公司自定义 ----
      // 权限与薪酬政策同档：带薪比例直接决定扣多少钱。
      if (url.pathname === '/api/leave/types') {
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'leave_request', action: 'read' });
          const canWrite = (await tx.query(
            `SELECT fn_role_can($1,'payroll_policy','write') o`, [uid])).rows[0].o;
          const rows = (await tx.query(
            `SELECT id, code, name, expire_policy, is_system, pay_ratio, is_active, note
               FROM leave_type ORDER BY is_system DESC, id`)).rows;
          return { rows, canWrite };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/type') {
        const p = {
          code: String(url.searchParams.get('code') || '').trim().toUpperCase(),
          name: String(url.searchParams.get('name') || '').trim(),
          ratio: url.searchParams.get('ratio'),
          expiry: url.searchParams.get('expiry') || 'void',
          note: url.searchParams.get('note') || null,
        };
        return await runWrite(res, {
          actor: uid, action: 'leave.type.upsert', subject: `lt:${p.code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(p.code)) {
              throw bizErr('E_ARG_INVALID', '代码要 2–24 位大写字母/数字/下划线，字母开头');
            }
            if (p.name.length < 2) throw bizErr('E_ARG_INVALID', '名称至少 2 个字');
            const ratio = p.ratio === '' || p.ratio === null ? null : Number(p.ratio);
            if (ratio !== null && !(ratio >= 0 && ratio <= 1)) {
              throw bizErr('E_ARG_INVALID', '带薪比例要在 0–1 之间（1=全薪，0=全扣）');
            }
            const existing = (await tx.query(
              `SELECT id, is_system FROM leave_type WHERE code = $1`, [p.code])).rows[0];
            if (existing?.is_system) {
              // 官方假种：可以改比例与说明，但不许改代码（已在触发器层挡）
              await tx.query(
                `UPDATE leave_type SET name=$2, pay_ratio=$3, expire_policy=$4, note=$5
                  WHERE code=$1`, [p.code, p.name, ratio, p.expiry, p.note]);
              return { code: p.code, is_system: true, _log: { ratio } };
            }
            if (existing) {
              await tx.query(
                `UPDATE leave_type SET name=$2, pay_ratio=$3, expire_policy=$4, note=$5
                  WHERE code=$1`, [p.code, p.name, ratio, p.expiry, p.note]);
            } else {
              await tx.query(
                `INSERT INTO leave_type(id, code, name, expire_policy, is_system, pay_ratio, note)
                 SELECT COALESCE((SELECT max(id) FROM leave_type),0)+1,$1,$2,$3,false,$4,$5`,
                [p.code, p.name, p.expiry, ratio, p.note]);
            }
            return { code: p.code, is_system: false, _log: { ratio } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/type/active') {
        const code = String(url.searchParams.get('code') || '');
        const active = url.searchParams.get('active') !== '0';
        return await runWrite(res, {
          actor: uid, action: active ? 'leave.type.enable' : 'leave.type.disable',
          subject: `lt:${code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            const n = (await tx.query(
              `UPDATE leave_type SET is_active=$2 WHERE code=$1 RETURNING code`,
              [code, active])).rowCount;
            if (!n) throw bizErr('E_NOT_FOUND', `假种 ${code} 不存在`);
            return { code, is_active: active, _log: { active } };
          },
        });
      }

      // ---- 薪酬政策：默认按法定，界面可改（需 HR 主管以上）----
      // ★ 为什么单开一组接口而不是让客户去改 SQL：
      //   这些数（21.75、加班倍数、病假比例、最低工资）每一个都直接改变所有人的工资。
      //   所以要"能改 + 留痕 + 权限 + 看得见法定默认值"四件一起给。
      //   只有金额口径能改，算法不能改 —— 那是代码，不是政策。
      if (url.pathname === '/api/payroll/policy') {
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          const canWrite = (await tx.query(
            `SELECT fn_role_can($1,'payroll_policy','write') o`, [uid])).rows[0].o;
          const policies = (await tx.query(
            `SELECT d.code, d.name, d.value_type, d.unit,
                    (SELECT v.value_num FROM fn_policy_effective(d.code, NULL, app_today()) v) AS num,
                    (SELECT v.value_text FROM fn_policy_effective(d.code, NULL, app_today()) v) AS txt,
                    -- fn_policy_effective 不回生效日，所以直接查 policy_value 取最新一条
                    (SELECT pv.effective_from FROM policy_value pv
                      WHERE pv.policy_code = d.code AND pv.effective_from <= app_today()
                      ORDER BY pv.effective_from DESC LIMIT 1) AS since
               FROM policy_def d
              WHERE d.code LIKE 'PAY%'
              ORDER BY d.code`)).rows;
          const tiers = (await tx.query(
            `SELECT years_from, rate, note FROM sick_pay_tier ORDER BY years_from`)).rows;
          const wages = (await tx.query(
            `SELECT city, effective_from, monthly, note FROM min_wage
              ORDER BY city, effective_from DESC`)).rows;
          return { policies, tiers, wages, canWrite };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/policy') {
        const code = String(url.searchParams.get('code') || '');
        const value = String(url.searchParams.get('value') || '').trim();
        const reason = String(url.searchParams.get('reason') || '').trim();
        return await runWrite(res, {
          actor: uid, action: 'payroll.policy.set', subject: `${code}=${value}`,
          fn: async (tx) => {
            // ★ HR 主管以上才能改：店长改一个加班倍数，全公司下个月都按它算
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            if (!/^PAY_/.test(code)) {
              throw bizErr('E_ARG_INVALID', '这里只改 PAY_ 开头的薪酬政策项');
            }
            if (reason.length < 4) {
              throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）—— 改这个数会改变所有人下个月的工资');
            }
            const def = (await tx.query(
              `SELECT value_type FROM policy_def WHERE code = $1`, [code])).rows[0];
            if (!def) throw bizErr('E_NOT_FOUND', `没有这个政策项 ${code}`);

            const today = (await tx.query('SELECT app_today() d')).rows[0].d;
            const isNum = def.value_type === 'numeric';
            if (isNum && !/^-?\d+(\.\d+)?$/.test(value)) {
              throw bizErr('E_ARG_INVALID', `${code} 需要一个数字`);
            }
            // 加班倍数有触发器兜底（法定下限），这里给更早、更好读的提示
            if (code === 'PAY_OT_RATE_WEEKDAY' && Number(value) < 1.5) {
              throw bizErr('E_OT_RATE_LOW', '平日加班倍数不得低于 1.5（法定）');
            }
            if (code === 'PAY_OT_RATE_RESTDAY' && Number(value) < 2) {
              throw bizErr('E_OT_RATE_LOW', '休息日加班倍数不得低于 2.0（法定）');
            }
            if (code === 'PAY_OT_RATE_HOLIDAY' && Number(value) < 3) {
              throw bizErr('E_OT_RATE_LOW', '法定节假日加班倍数不得低于 3.0（法定）');
            }

            await tx.query(
              `INSERT INTO policy_value(policy_code, effective_from, value_num, value_text,
                                        published_by, reason)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (policy_code, effective_from) DO UPDATE
                 SET value_num = EXCLUDED.value_num, value_text = EXCLUDED.value_text,
                     published_by = EXCLUDED.published_by, reason = EXCLUDED.reason`,
              [code, today, isNum ? Number(value) : null, isNum ? null : value,
               String(uid), reason]);
            return { code, value, effective_from: today, _log: { code, value, reason } };
          },
        });
      }

      // 病假档位：只能"改比例"，不能删档（删了低工龄的人就没档可用）
      // ---- 工资条环比（136）：说清"这个月为什么少了 300" ----
      if (url.pathname === '/api/payslip/diff') {
        const personId = Number(url.searchParams.get('person'));
        const period = String(url.searchParams.get('period') || '');
        const base = url.searchParams.get('base') || null;
        const sent = await runRead(res, (tx) => payslipDiff.diff(tx, {
          userId: uid, personId, period, base }), () => logPayslipView({
          actor: uid, scope: 'single', subject: personId, rowCount: 1, ip: reqIp(req),
        }));
        // ★ 留痕（184）：环比看的是**同一个人两期**的逐项差异，subject 就是他本人。
        //   这里没有具体 payslip_id（函数只回差异行），所以 payslip_id 留 NULL，
        //   row_count=1 表示"看了一个人的一份工资条"。
        return sent;
      }

      // ---- 离职结算（134）：经济补偿金 + 代通知金 + 年假折现，单独计税 ----
      // ★ 必须判 method：POST /api/severance 是"落单"，同路径。
      //   只写 pathname 会让落单请求被 GET 分支接住，返回一份清单（200 但没有 id），
      //   下游再拿 undefined 去确认 —— 报的是一个跟根因无关的参数错。
      if (req.method === 'GET' && url.pathname === '/api/severance') {
        return await runRead(res, (tx) => severance.overview(tx, { userId: uid }));
      }

      if (url.pathname === '/api/severance/quote') {
        const employmentId = Number(url.searchParams.get('employment'));
        const leaveDate = String(url.searchParams.get('leave') || '');
        const reasonCode = url.searchParams.get('reason') || 'mutual';
        const notice = url.searchParams.get('notice') === '1';
        return await runRead(res, (tx) => severance.quote(tx, {
          userId: uid, employmentId, leaveDate, reasonCode, notice }));
      }

      if (req.method === 'POST' && url.pathname === '/api/severance') {
        const employmentId = Number(url.searchParams.get('employment'));
        const leaveDate = String(url.searchParams.get('leave') || '');
        const reasonCode = url.searchParams.get('reason') || 'mutual';
        const note = String(url.searchParams.get('note') || '');
        const notice = url.searchParams.get('notice') === '1';
        return await runWrite(res, {
          actor: uid, action: 'severance.create', subject: `employment:${employmentId}`,
          fn: (tx) => severance.create(tx, {
            userId: uid, employmentId, leaveDate, reasonCode, note, notice }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/severance/confirm') {
        const id = Number(url.searchParams.get('id'));
        return await runWrite(res, {
          actor: uid, action: 'severance.confirm', subject: `severance:${id}`,
          fn: (tx) => severance.confirm(tx, { userId: uid, id }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/severance/void') {
        const id = Number(url.searchParams.get('id'));
        const why = String(url.searchParams.get('why') || '');
        return await runWrite(res, {
          actor: uid, action: 'severance.void', subject: `severance:${id}`,
          fn: (tx) => severance.voidOne(tx, { userId: uid, id, why }),
        });
      }

      // ---- 考试（147）：题库 → 组卷 → 答卷 → 判分 ----
      // ★ 判分在库里（fn_exam_submit）。前端只传"我选了什么"，传分数也不看 ——
      //   否则"及格线"就成了一个前端变量。
      if (url.pathname === '/api/exam') {
        return await runRead(res, (tx) => exam.board(tx, { userId: uid }));
      }

      // ★ 必须判 method：下面还有一条 POST /api/exam/paper（建卷）走同一个 pathname。
      //   只写 pathname 的话，先匹配的读分支会把建卷请求吃掉 ——
      //   返回的是"paper 必须是正整数"（paperId=NaN），而写路由变成死代码。
      //   这类错在演示里不出现，因为演示只点"看"，不点"建"。
      if (req.method === 'GET' && url.pathname === '/api/exam/paper') {
        const paperId = Number(url.searchParams.get('paper'));
        return await runRead(res, (tx) => exam.paper(tx, { userId: uid, paperId }));
      }

      if (url.pathname === '/api/exam/attempts') {
        const paperId = Number(url.searchParams.get('paper'));
        return await runRead(res, (tx) => exam.attempts(tx, { userId: uid, paperId }));
      }

      if (url.pathname === '/api/exam/result') {
        const attemptId = Number(url.searchParams.get('attempt'));
        return await runRead(res, (tx) => exam.result(tx, { userId: uid, attemptId }));
      }

      // 考试台账（156）：开考**之前**就要能回答"他还剩几次"。
      // ★ 放在 /api/exam/paper 之后、POST /api/exam/paper 之前，
      //   靠 method + 路径双重区分，避免又被写路由吃掉。
      if (req.method === 'GET' && url.pathname === '/api/exam/ledger') {
        const paperId = Number(url.searchParams.get('paper'));
        const employeeId = Number(url.searchParams.get('employee'));
        return await runRead(res, (tx) => exam.ledger(tx, {
          userId: uid, paperId, employeeId }));
      }

      // ---- 考试任务层 / 错题回顾 / 成绩聚合 / 切屏证据（157）----
      // ★ 时间窗的闸在 exam_attempt 的 BEFORE INSERT 里，不在这一层 ——
      //   页面不调 /window 也发不出窗口外的卷。这里只是让人先看见"现在能不能考"。
      if (req.method === 'GET' && url.pathname === '/api/exam/tasks') {
        return await runRead(res, (tx) => examTask.tasksFor(tx, {
          userId: uid,
          personId: Number(url.searchParams.get('person')),
          on: url.searchParams.get('on') || null,
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/exam/task') {
        const body = await readBody(req);
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { p = {}; }
        return await runWrite(res, {
          actor: uid, action: 'exam.task.open',
          subject: `paper:${p.paper}/org:${p.org ?? 'all'}`,
          fn: (tx) => examTask.openTask(tx, {
            userId: uid, paperId: Number(p.paper), name: p.name,
            orgId: p.org ?? null, openAt: p.open ?? null, closeAt: p.close ?? null,
            required: p.required,
          }),
        });
      }

      if (url.pathname === '/api/exam/window') {
        return await runRead(res, (tx) => examTask.checkWindow(tx, {
          userId: uid,
          paperId: Number(url.searchParams.get('paper')),
          at: url.searchParams.get('at') || null,
        }));
      }

      if (url.pathname === '/api/exam/review') {
        return await runRead(res, (tx) => examTask.review(tx, {
          userId: uid, attemptId: Number(url.searchParams.get('attempt')) }));
      }

      if (url.pathname === '/api/exam/stat') {
        return await runRead(res, (tx) => examTask.stat(tx, {
          userId: uid,
          paperId: Number(url.searchParams.get('paper')),
          orgId: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null,
        }));
      }

      if (url.pathname === '/api/exam/missing') {
        return await runRead(res, (tx) => examTask.missing(tx, {
          userId: uid,
          paperId: Number(url.searchParams.get('paper')),
          orgId: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null,
        }));
      }

      // 切屏事件：一次一条，只增不改（库里 append-only）。
      // ★ 不提供"删掉这条"的接口 —— 那正是要留的证据。
      if (req.method === 'POST' && url.pathname === '/api/exam/event') {
        const body = await readBody(req);
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { p = {}; }
        return await runWrite(res, {
          actor: uid, action: 'exam.event.log',
          subject: `attempt:${p.attempt}`,
          fn: (tx) => examTask.logEvent(tx, {
            userId: uid, attemptId: Number(p.attempt),
            kind: p.kind, detail: p.detail ?? null,
          }),
        });
      }

      if (url.pathname === '/api/exam/cheat') {
        return await runRead(res, (tx) => examTask.cheat(tx, {
          userId: uid, attemptId: Number(url.searchParams.get('attempt')) }));
      }

      if (url.pathname === '/api/exam/flagged') {
        return await runRead(res, (tx) => examTask.flagged(tx, {
          userId: uid, paperId: Number(url.searchParams.get('paper')) }));
      }

      if (req.method === 'POST' && url.pathname === '/api/exam/paper') {
        const q = url.searchParams;
        let qs = [];
        try { qs = JSON.parse(q.get('questions') || '[]'); } catch { qs = []; }
        return await runWrite(res, {
          actor: uid, action: 'exam.paper.create', subject: `paper:${q.get('code')}`,
          fn: (tx) => exam.createPaper(tx, {
            userId: uid, courseId: Number(q.get('course')), code: q.get('code'),
            name: q.get('name'), passScore: q.get('pass'), isActive: q.get('active') !== '0',
            note: q.get('note'), questions: qs,
            durationMin: q.get('duration'), maxAttempts: q.get('attempts'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/exam/start') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'exam.start',
          subject: `paper:${q.get('paper')}/person:${q.get('employee')}`,
          fn: (tx) => exam.start(tx, {
            userId: uid, paperId: Number(q.get('paper')),
            employeeId: Number(q.get('employee')),
            sessionId: q.get('session') ? Number(q.get('session')) : null,
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/exam/submit') {
        const q = url.searchParams;
        let ans = [];
        try { ans = JSON.parse(q.get('answers') || '[]'); } catch { ans = []; }
        return await runWrite(res, {
          actor: uid, action: 'exam.submit', subject: `attempt:${q.get('attempt')}`,
          fn: (tx) => exam.submit(tx, {
            userId: uid, attemptId: Number(q.get('attempt')), answers: ans }),
        });
      }

      // ---- 培训学习（144）----
      // ★ 没有"点通过"这个接口：结业由学时判定（fn_training_attend）。
      //   开一个人工通过的口子，这个字段迟早全是"通过"。
      if (req.method === 'GET' && url.pathname === '/api/training/entities') {
        return await runRead(res, tx => training.entities(tx,{userId:uid}));
      }

      if (url.pathname === '/api/training') {
        const entity = Number(url.searchParams.get('entity') || 1);
        const year = Number(url.searchParams.get('year') || 0) || null;
        return await runRead(res, (tx) => training.board(tx, { userId: uid, entityId: entity, year }));
      }

      if (url.pathname === '/api/training/person') {
        const person = Number(url.searchParams.get('person'));
        const year = Number(url.searchParams.get('year') || 0) || null;
        return await runRead(res, (tx) => training.detail(tx, { userId: uid, personId: person, year }));
      }

      if (req.method === 'POST' && url.pathname === '/api/training/course') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'training.course.create', subject: `course:${q.get('code')}`,
          fn: (tx) => training.createCourse(tx, {
            userId: uid, code: q.get('code'), name: q.get('name'), category: q.get('category'),
            stdHours: q.get('hours'), statutory: q.get('statutory') === '1',
            validMonths: q.get('valid_months') || null, note: q.get('note'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/training/session') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'training.session.create',
          subject: `course:${q.get('course')}@${q.get('date')}`,
          fn: (tx) => training.createSession(tx, {
            userId: uid, courseId: Number(q.get('course')), entityId: Number(q.get('entity') || 1),
            date: q.get('date'), fromTime: q.get('from'), toTime: q.get('to'),
            hours: q.get('hours'), trainer: q.get('trainer'), place: q.get('place'),
            capacity: q.get('capacity') || null,
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/training/enroll') {
        const q = url.searchParams;
        const emps = (q.get('employee') || '').split(',').map(Number);
        return await runWrite(res, {
          actor: uid, action: 'training.enroll', subject: `session:${q.get('session')}`,
          fn: (tx) => training.enroll(tx, {
            userId: uid, sessionId: Number(q.get('session')), employeeIds: emps }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/training/attend') {
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'training.attend', subject: `enroll:${q.get('enroll')}`,
          fn: (tx) => training.attend(tx, {
            userId: uid, enrollId: Number(q.get('enroll')), hours: q.get('hours') }),
        });
      }

      // ---- 申报表（141）：个税扣缴申报表 + 社保费申报表 ----
      // 读只要 payroll_run 读；**导出要 payroll_run 写** —— 这两张表带着完整
      // 身份证号与全员工资，是这套系统里最该限制"往外带"的东西。
      if (url.pathname === '/api/declare') {
        const period = url.searchParams.get('period') || null;
        const entity = Number(url.searchParams.get('entity') || 1);
        return await runRead(res, (tx) => declare.board(tx, { userId: uid, entityId: entity, period }));
      }

      if (url.pathname === '/api/declare/iit.csv') {
        const period = url.searchParams.get('period') || null;
        const entity = Number(url.searchParams.get('entity') || 1);
        return await runWrite(res, {
          actor: uid, action: 'declare.export.iit', subject: `entity:${entity}@${period || 'latest'}`,
          fn: (tx) => declare.exportIit(tx, { userId: uid, entityId: entity, period }),
          send: (r, out) => {
            r.writeHead(200, {
              ...CSV_HEADERS, ...SEC_HEADERS,
              'content-length': Buffer.byteLength(out.text, 'utf8'),
              'content-disposition': `attachment; filename="${out.filename}"`,
            });
            r.end(out.text);
          },
        });
      }

      if (url.pathname === '/api/declare/si.csv') {
        const period = url.searchParams.get('period') || null;
        const entity = Number(url.searchParams.get('entity') || 1);
        return await runWrite(res, {
          actor: uid, action: 'declare.export.si', subject: `entity:${entity}@${period || 'latest'}`,
          fn: (tx) => declare.exportSi(tx, { userId: uid, entityId: entity, period }),
          send: (r, out) => {
            r.writeHead(200, {
              ...CSV_HEADERS, ...SEC_HEADERS,
              'content-length': Buffer.byteLength(out.text, 'utf8'),
              'content-disposition': `attachment; filename="${out.filename}"`,
            });
            r.end(out.text);
          },
        });
      }

      if (url.pathname === '/api/declare/exports') {
        return await runRead(res, (tx) => declare.recent(tx, { userId: uid }));
      }

      // ---- 社保申报基数（133）----
      if (url.pathname === '/api/si/declare') {
        const year = Number(url.searchParams.get('year') || 0) || null;
        const city = url.searchParams.get('city') || null;
        return await runRead(res, (tx) => siDeclare.overview(tx, { userId: uid, year, city }));
      }

      if (req.method === 'POST' && url.pathname === '/api/si/declare/build') {
        const year = Number(url.searchParams.get('year'));
        const city = url.searchParams.get('city') || '上海';
        const effectiveFrom = url.searchParams.get('from') || null;
        return await runWrite(res, {
          actor: uid, action: 'si.declare.build', subject: `year:${year}`,
          fn: (tx) => siDeclare.build(tx, { userId: uid, year, city, effectiveFrom }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/si/declare/set') {
        const employeeId = Number(url.searchParams.get('employee'));
        const year = Number(url.searchParams.get('year'));
        const city = url.searchParams.get('city') || '上海';
        const base = Number(url.searchParams.get('base'));
        const why = String(url.searchParams.get('why') || '');
        return await runWrite(res, {
          actor: uid, action: 'si.declare.set', subject: `person:${employeeId}/y${year}`,
          fn: (tx) => siDeclare.setOne(tx, {
            userId: uid, employeeId, year, city, base, why }),
        });
      }

      // ---- 工时制度（131）：综合工时 / 不定时 ----
      if (url.pathname === '/api/work-time') {
        const period = url.searchParams.get('period');
        return await runRead(res, (tx) => workTime.overview(tx, { userId: uid, period }));
      }

      if (req.method === 'POST' && url.pathname === '/api/work-time/set') {
        const employmentId = Number(url.searchParams.get('employment'));
        const sys = String(url.searchParams.get('sys') || '');
        const approvedUntil = String(url.searchParams.get('approved_until') || '') || null;
        const reason = String(url.searchParams.get('reason') || '');
        return await runWrite(res, {
          actor: uid, action: 'employment.work_time.set', subject: `employment:${employmentId}`,
          fn: (tx) => workTime.setWorkTime(tx, {
            userId: uid, employmentId, sys, approvedUntil, reason }),
        });
      }

      // ---- 假期额度与请假单（假期域）----
      // 读要 leave_request read；审批复用已有的 /api/leave/decide（自审在库里被拒）。
      if (url.pathname === '/api/leave/types-board') {
        return await runRead(res, (tx) => leaveBoard.types(tx, { userId: uid }));
      }

      if (url.pathname === '/api/leave/board') {
        const typeId = Number(url.searchParams.get('type'));
        return await runRead(res, (tx) => leaveBoard.board(tx, { userId: uid, typeId }));
      }

      if (url.pathname === '/api/leave/requests') {
        const days = Number(url.searchParams.get('days') || 90);
        return await runRead(res, (tx) => leaveBoard.requests(tx, { userId: uid, days }));
      }

      // ---- 假种规则（152）：按月发放 / 单次最大时长 / 证明门槛 ----
      // 请假资格（164）：与"额度够不够"分开问 —— 两者都不通过时，
      // 页面要说清是"没资格"还是"没额度"，否则 HR 只能猜。
      if (url.pathname === '/api/leave/eligibility') {
        const q = url.searchParams;
        return await runRead(res, (tx) => leaveRules.eligibility(tx, {
          userId: uid,
          employeeId: Number(q.get('employee')),
          typeCode: q.get('type'),
          from: q.get('from'),
          to: q.get('to'),
        }));
      }

      if (url.pathname === '/api/leave/rules') {
        return await runRead(res, (tx) => leaveRules.types(tx, { userId: uid }));
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/rules/set') {
        const typeId = Number(url.searchParams.get('type'));
        const has = (k) => url.searchParams.has(k);
        const optNum = (k) => (url.searchParams.get(k) === '' ? null : Number(url.searchParams.get(k)));
        return await runWrite(res, {
          actor: uid, action: 'leave.rule.set', subject: `leave_type:${typeId}`,
          fn: (tx) => leaveRules.setRule(tx, {
            userId: uid, typeId,
            // ★ "没传" = 不改（undefined）；"传空" = 取消限制（null）。混了就会把
            //   "一次也不能请" 静默改成 "随便请"，所以用 has() 而不是 get() ?? 默认值。
            grantMode: has('grant_mode') ? String(url.searchParams.get('grant_mode')) : undefined,
            roundStep: has('round_step') ? Number(url.searchParams.get('round_step')) : undefined,
            roundDir: has('round_dir') ? String(url.searchParams.get('round_dir')) : undefined,
            maxHours: has('max_hours') ? optNum('max_hours') : undefined,
            proofAfterHours: has('proof_after') ? optNum('proof_after') : undefined,
            reason: String(url.searchParams.get('reason') || ''),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/rules/grant-monthly') {
        const employeeId = Number(url.searchParams.get('employee'));
        const typeId = Number(url.searchParams.get('type'));
        const year = Number(url.searchParams.get('year'));
        const total = url.searchParams.get('total');
        return await runWrite(res, {
          actor: uid, action: 'leave.grant.monthly', subject: `person:${employeeId}/${year}`,
          fn: (tx) => leaveRules.grantMonthly(tx, {
            userId: uid, employeeId, typeId, year,
            total: total === null || total === '' ? null : Number(total),
          }),
        });
      }

      if (url.pathname === '/api/leave/rules/check') {
        const employeeId = Number(url.searchParams.get('employee'));
        const typeId = Number(url.searchParams.get('type'));
        const h = url.searchParams.get('hours');
        const d = url.searchParams.get('days');
        return await runRead(res, (tx) => leaveRules.checkRequest(tx, {
          userId: uid, employeeId, typeId,
          from: String(url.searchParams.get('from') || ''),
          to: String(url.searchParams.get('to') || ''),
          hours: h === null || h === '' ? undefined : Number(h),
          days: d === null || d === '' ? undefined : Number(d),
          proofNote: url.searchParams.get('proof_note'),
        }));
      }

      // ---- 未休年假折现（129）----
      // ★ 读要 payroll_run，写只给 payroll_policy（boss / hr_ops）：
      //   折现是发钱，店长与薪酬专员不该有这个按钮。
      if (url.pathname === '/api/leave/cashout' && req.method === 'GET') {
        const year = url.searchParams.get('year');
        return await runRead(res, (tx) => leaveCashout.overview(tx, { userId: uid, year }));
      }

      if (url.pathname === '/api/leave/cashout/quote') {
        const employeeId = Number(url.searchParams.get('employee'));
        const on = url.searchParams.get('on') || null;
        return await runRead(res, (tx) =>
          leaveCashout.quote(tx, { userId: uid, employeeId, on }));
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/cashout') {
        const employeeId = Number(url.searchParams.get('employee'));
        const on = url.searchParams.get('on') || null;
        const period = String(url.searchParams.get('period') || '');
        const reason = String(url.searchParams.get('reason') || '');
        return await runWrite(res, {
          actor: uid, action: 'leave.cashout.create', subject: `person:${employeeId}/${period}`,
          fn: (tx) => leaveCashout.create(tx, { userId: uid, employeeId, on, period, reason }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/cashout/void') {
        const id = Number(url.searchParams.get('id'));
        const why = String(url.searchParams.get('why') || '');
        return await runWrite(res, {
          actor: uid, action: 'leave.cashout.void', subject: `cashout:${id}`,
          fn: (tx) => leaveCashout.voidOne(tx, { userId: uid, id, why }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/carry-policy') {
        const policy = String(url.searchParams.get('policy') || '');
        const deadline = String(url.searchParams.get('deadline') || '03-31');
        const reason = String(url.searchParams.get('reason') || '');
        return await runWrite(res, {
          actor: uid, action: 'leave.carry.set', subject: `carry:${policy}`,
          fn: (tx) => leaveCashout.setCarry(tx, { userId: uid, policy, deadline, reason }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/cashout/policy') {
        const mode = String(url.searchParams.get('mode') || '');
        const reason = String(url.searchParams.get('reason') || '');
        return await runWrite(res, {
          actor: uid, action: 'leave.cashout.policy', subject: `mode:${mode}`,
          fn: (tx) => leaveCashout.setPolicy(tx, { userId: uid, mode, reason }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/leave/annual-tier') {
        const yearsFrom = Number(url.searchParams.get('years'));
        const days = Number(url.searchParams.get('days'));
        const reason = String(url.searchParams.get('reason') || '');
        return await runWrite(res, {
          actor: uid, action: 'leave.tier.set', subject: `annual-tier:${yearsFrom}y`,
          fn: (tx) => leaveCashout.setTier(tx, { userId: uid, yearsFrom, days, reason }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/sick-tier') {
        const years = Number(url.searchParams.get('years'));
        const rate = Number(url.searchParams.get('rate'));
        const reason = String(url.searchParams.get('reason') || '').trim();
        return await runWrite(res, {
          actor: uid, action: 'payroll.sick_tier.set', subject: `sick:${years}y`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            if (reason.length < 4) throw bizErr('E_ARG_INVALID', '必须写原因（至少 4 个字）');
            if (!(rate >= 0.6 && rate <= 1)) {
              throw bizErr('E_ARG_INVALID', '病假工资比例必须在 60%–100% 之间（法定下限 60%）');
            }
            await tx.query(
              `UPDATE sick_pay_tier SET rate = $2, note = COALESCE(note,'') || ' | ' || $3
                WHERE years_from = $1`, [years, rate, left(reason, 60)]);
            return { years_from: years, rate, _log: { rate } };
          },
        });
      }

      // 最低工资：新增一条（带生效日，不覆盖历史）
      if (req.method === 'POST' && url.pathname === '/api/payroll/min-wage') {
        const city = String(url.searchParams.get('city') || '上海').trim();
        const from = String(url.searchParams.get('from') || '');
        const monthly = Number(url.searchParams.get('monthly'));
        const reason = String(url.searchParams.get('reason') || '').trim();
        return await runWrite(res, {
          actor: uid, action: 'payroll.min_wage.set', subject: `${city}@${from}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_policy', action: 'write' });
            if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
              throw bizErr('E_ARG_INVALID', '生效日要写 2026-07-01 这样');
            }
            if (!(monthly > 0)) throw bizErr('E_ARG_INVALID', '最低工资必须大于 0');
            await tx.query(
              `INSERT INTO min_wage(city, effective_from, monthly, note)
               VALUES ($1,$2::date,$3,$4)
               ON CONFLICT (city, effective_from) DO UPDATE
                 SET monthly = EXCLUDED.monthly, note = EXCLUDED.note`,
              [city, from, monthly, reason]);
            return { city, from, monthly, _log: { monthly } };
          },
        });
      }

      // ---- 考勤报表：月报（生成/调整/提交/审批/版本）+ 日报 + 加班三档 ----
      // ★ 薪资只认 confirmed 的月报（114 起 fn_att_person_period 优先读它），
      //   所以这一组接口的权限按**薪酬写**收 —— 它决定的其实是下个月发多少钱。
      if (url.pathname === '/api/att/report') {
        const period = url.searchParams.get('period') || null;
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'read' });
          const p0 = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))
            ? period : (await tx.query(`SELECT to_char(app_today(),'YYYY-MM') p`)).rows[0].p;

          const rows = (await tx.query(
            `SELECT r.id, r.person_id, p.full_name, o.name AS dept_name,
                    r.work_days, r.calendar_days, r.roster_days,
                    r.present_days, r.leave_days, r.personal_leave_days, r.absent_days,
                    r.work_hours, r.ot_hours, r.workdays_source,
                    r.status, r.submitted_by, r.submitted_at,
                    r.approver_person_id, ap.full_name AS approver_name,
                    r.confirmed_by, r.confirmed_at, r.rejected_reason,
                    fn_att_ot_split(r.person_id, r.period) AS ot,
                    fn_pay_basis(r.person_id, r.period) AS pay_basis
               FROM att_period_report r
               JOIN person p ON p.id = r.person_id
               LEFT JOIN person ap ON ap.id = r.approver_person_id
               LEFT JOIN LATERAL (
                 SELECT ou.name FROM employee_org_assignment a
                   JOIN org_unit ou ON ou.id = a.org_id
                  WHERE a.employee_id = r.person_id AND a.dim_code IN ('attendance_org','cost_org')
                    AND daterange(a.valid_from, a.valid_to, '[]') @>
                        (to_date(r.period||'-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
                  ORDER BY (a.dim_code = 'attendance_org') DESC, a.valid_from DESC
                  LIMIT 1) o ON true
              WHERE r.period = $1
              ORDER BY p.full_name`, [p0])).rows;

          const vers = (await tx.query(
            `SELECT id, version_no, source, row_count, digest, note, created_by, created_at
               FROM att_period_version WHERE period = $1
              ORDER BY version_no DESC LIMIT 30`, [p0])).rows;

          const closed = (await tx.query(
            `SELECT count(*)::int n FROM attendance_close
              WHERE period = $1 AND status = 'closed'`, [p0])).rows[0].n;

          return { period: p0, rows, versions: vers, closed_stores: closed };
        });
      }

      // 日报明细（点开某人看每天到底怎么算的）
      if (url.pathname === '/api/att/daily') {
        const period = url.searchParams.get('period');
        const person = Number(url.searchParams.get('person') || 0);
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'read' });
          const rows = (await tx.query(
            `SELECT a.work_date, a.work_hours, a.span_hours, a.in_attendance_hours,
                    rs.shift_code, sd.name AS shift_name, sd.is_rest,
                    fn_is_rest_day(a.work_date, a.employee_id) AS is_rest,
                    fn_is_legal_holiday(a.work_date) AS is_holiday,
                    (SELECT count(*)::int FROM att_daily_adjust x
                      WHERE x.employee_id = a.employee_id AND x.work_date = a.work_date) AS adjusts
               FROM attendance_daily_store a
               LEFT JOIN roster_slot rs ON rs.employee_id = a.employee_id AND rs.work_date = a.work_date
               LEFT JOIN shift_def sd ON sd.code = rs.shift_code
              WHERE a.employee_id = $1 AND to_char(a.work_date,'YYYY-MM') = $2
              ORDER BY a.work_date`, [person, period])).rows;
          const ot = (await tx.query(`SELECT * FROM fn_att_ot_split($1,$2)`,
            [person, period])).rows[0];
          return { person, period, rows, ot };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/report/build') {
        const period = url.searchParams.get('period');
        const entity = Number(url.searchParams.get('entity') || 1);
        return await runWrite(res, {
          actor: uid, action: 'att.report.build', subject: `att:${period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'att_report_approve', action: 'write' });
            return { ...(await tx.query(`SELECT * FROM fn_att_period_build($1,$2,$3)`,
              [period, entity, String(uid)])).rows[0], _log: { period } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/report/set') {
        const p = { report: Number(url.searchParams.get('report')),
                    field: url.searchParams.get('field'),
                    value: Number(url.searchParams.get('value')),
                    reason: url.searchParams.get('reason') || '' };
        return await runWrite(res, {
          actor: uid, action: 'att.report.set', subject: `att:${p.report}/${p.field}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'write' });
            const v = (await tx.query(`SELECT fn_att_period_set($1,$2,$3,$4,$5) v`,
              [p.report, p.field, p.value, p.reason, String(uid)])).rows[0].v;
            return { value: v, _log: { field: p.field, value: p.value } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/report/submit') {
        const period = url.searchParams.get('period');
        const entity = Number(url.searchParams.get('entity') || 1);
        const approver = url.searchParams.get('approver');
        return await runWrite(res, {
          actor: uid, action: 'att.report.submit', subject: `att:${period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'att_report_approve', action: 'write' });
            // 审批人比较的是**人员 id**，所以这里要把"谁在操作"换算成人员
            const me = await resolveEmployee(tx, uid).catch(() => null);
            const byPerson = me ? String(me.personId) : String(uid);
            const n = (await tx.query(`SELECT fn_att_period_submit($1,$2,$3,$4) n`,
              [period, entity, byPerson, approver ? Number(approver) : null])).rows[0].n;
            return { submitted: n, _log: { period } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/report/approve') {
        const period = url.searchParams.get('period');
        const entity = Number(url.searchParams.get('entity') || 1);
        const approve = url.searchParams.get('approve') !== '0';
        const reason = url.searchParams.get('reason') || '';
        return await runWrite(res, {
          actor: uid, action: approve ? 'att.report.approve' : 'att.report.reject',
          subject: `att:${period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'att_report_approve', action: 'write' });
            const me = await resolveEmployee(tx, uid).catch(() => null);
            const byPerson = me ? String(me.personId) : String(uid);
            const n = (await tx.query(`SELECT fn_att_period_approve($1,$2,$3,$4,$5) n`,
              [period, entity, byPerson, approve, reason])).rows[0].n;
            return { approved: n, _log: { approve, reason } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/report/reopen') {
        const period = url.searchParams.get('period');
        const entity = Number(url.searchParams.get('entity') || 1);
        const reason = url.searchParams.get('reason') || '';
        return await runWrite(res, {
          actor: uid, action: 'att.report.reopen', subject: `att:${period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'att_report_approve', action: 'write' });
            const n = (await tx.query(`SELECT fn_att_period_reopen($1,$2,$3,$4) n`,
              [period, entity, reason, String(uid)])).rows[0].n;
            return { reopened: n, _log: { reason } };
          },
        });
      }

      if (url.pathname === '/api/att/report/diff') {
        const v1 = Number(url.searchParams.get('v1'));
        const v2 = Number(url.searchParams.get('v2'));
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'read' });
          return { rows: (await tx.query(`SELECT * FROM fn_att_period_version_diff($1,$2)`,
            [v1, v2])).rows };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/daily/set') {
        const p = { person: Number(url.searchParams.get('person')),
                    date: url.searchParams.get('date'),
                    hours: Number(url.searchParams.get('hours')),
                    reason: url.searchParams.get('reason') || '' };
        return await runWrite(res, {
          actor: uid, action: 'att.daily.set', subject: `att:${p.person}@${p.date}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'write' });
            const v = (await tx.query(`SELECT fn_att_daily_set($1,$2::date,$3,$4,$5) v`,
              [p.person, p.date, p.hours, p.reason, String(uid)])).rows[0].v;
            return { hours: v, _log: { date: p.date, hours: p.hours } };
          },
        });
      }

      // 导入：kind=daily|monthly；原始请求体上传（只有一个文件，没有别的字段）
      if (req.method === 'POST' && url.pathname === '/api/att/import') {
        const kind = url.searchParams.get('kind') === 'daily' ? 'daily' : 'monthly';
        const period = url.searchParams.get('period');
        const filename = (url.searchParams.get('filename') || 'upload.csv').slice(0, 200);
        let buf;
        try { buf = await readBody(req); } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
        if (!buf || buf.length === 0) {
          return json(res, 400, { error: 'E_IMPORT_EMPTY', message: '文件是空的' });
        }
        return await runWrite(res, {
          actor: uid, action: `att.import.${kind}`, subject: `file:${filename}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'write' });
            const parsed = kind === 'daily'
              ? await attImport.parseDaily(tx, { buffer: buf, filename })
              : await attImport.parseMonthly(tx, { buffer: buf, filename });
            const saved = await attImport.saveBatch(tx, {
              kind, period, filename, rows: parsed.rows, userId: uid });
            return { ...saved, kind, filename, rows: parsed.rows,
                     _log: { kind, ok: saved.ok, fail: saved.fail } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/att/import/apply') {
        const batch = Number(url.searchParams.get('batch'));
        const period = url.searchParams.get('period');
        const entity = Number(url.searchParams.get('entity') || 1);
        return await runWrite(res, {
          actor: uid, action: 'att.import.apply', subject: `batch:${batch}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'attendance_daily', action: 'write' });
            const b = (await tx.query(`SELECT kind FROM att_import_batch WHERE id=$1`,
              [batch])).rows[0];
            if (!b) throw bizErr('E_NOT_FOUND', `导入批次 ${batch} 不存在`);
            const out = b.kind === 'daily'
              ? (await tx.query(`SELECT * FROM fn_att_daily_import_apply($1,$2)`,
                  [batch, String(uid)])).rows[0]
              : (await tx.query(`SELECT * FROM fn_att_period_import_apply($1,$2,$3,$4)`,
                  [batch, period, entity, String(uid)])).rows[0];
            return { ...out, _log: { batch } };
          },
        });
      }

      // ---- 工资调整单：列表 / 建单 / 应用 / 作废 ----
      if (url.pathname === '/api/salary/adjustments') {
        const period = url.searchParams.get('period') || null;
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          const p0 = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))
            ? period : (await tx.query(`SELECT to_char(app_today(),'YYYY-MM') p`)).rows[0].p;
          const from = `${p0}-01`;
          // 每人当前月薪与结构 + 本期调整单（一张人可能有多张，取最新一张）
          const rows = (await tx.query(
            `SELECT p.id AS person_id, p.full_name, e.id AS employment_id,
                    COALESCE((SELECT s.monthly_amount FROM salary_standard s
                               WHERE s.employment_id = e.id AND s.effective_from <= $2::date
                               ORDER BY s.effective_from DESC LIMIT 1), 0) AS monthly,
                    COALESCE((SELECT jsonb_agg(jsonb_build_object('item_code', f.item_code,
                                                                 'name', f.name, 'amount', f.amount)
                                               ORDER BY f.item_code)
                                FROM fn_salary_structure_of(e.id, $2::date) f), '[]'::jsonb) AS items,
                    a.code AS adj_code, a.status AS adj_status, a.after_monthly, a.delta,
                    a.source AS adj_source, a.reason AS adj_reason
               FROM employment e
               JOIN person p ON p.id = e.person_id
               LEFT JOIN LATERAL (SELECT x.code, x.status, x.after_monthly, x.delta, x.source, x.reason
                                    FROM salary_adjustment x
                                   WHERE x.person_id = p.id AND x.period = $1
                                   ORDER BY x.id DESC LIMIT 1) a ON true
              -- ★ 在职判断用**期末**：月中入职的人（11-14 入职）在 11-01 还不存在，
              --   但他的 11 月薪资是要调的。调整本身仍在期间首日生效。
              -- ★ 用 $2::date 的算术而不是 to_date($2,...)：同一个参数在别处已经
              --   被推断成 date，再交给 to_date(date, text) 会报"函数不存在"。
              WHERE daterange(e.hire_date, e.leave_date, '[]')
                    @> ($2::date + interval '1 month - 1 day')::date
              ORDER BY p.full_name`, [p0, from])).rows;
          const history = (await tx.query(
            `SELECT code, period, person_id, before_monthly, after_monthly, delta, source,
                    reason, status, created_at, applied_at
               FROM salary_adjustment ORDER BY id DESC LIMIT 50`)).rows;
          return { period: p0, rows, history };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/salary/adjustment') {
        const person = Number(url.searchParams.get('person'));
        const period = url.searchParams.get('period');
        const reason = url.searchParams.get('reason') || '';
        let items = [];
        try { items = JSON.parse(url.searchParams.get('items') || '[]'); } catch { items = []; }
        return await runWrite(res, {
          actor: uid, action: 'salary.adjust.create', subject: `person:${person}@${period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const code = (await tx.query(
              `SELECT fn_salary_adjust_create($1,$2,$3::jsonb,$4,'manual',$5) c`,
              [person, period, JSON.stringify(items), reason, String(uid)])).rows[0].c;
            return { code, _log: { person, period, items: items.length } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/salary/adjustment/apply') {
        const code = url.searchParams.get('code');
        return await runWrite(res, {
          actor: uid, action: 'salary.adjust.apply', subject: `adjust:${code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const amt = (await tx.query(`SELECT fn_salary_adjust_apply($1,$2) a`,
              [code, String(uid)])).rows[0].a;
            return { code, monthly: amt, _log: { code } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/salary/adjustment/cancel') {
        const code = url.searchParams.get('code');
        return await runWrite(res, {
          actor: uid, action: 'salary.adjust.cancel', subject: `adjust:${code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const n = (await tx.query(
              `UPDATE salary_adjustment SET status='cancelled'
                WHERE code=$1 AND status='draft' RETURNING code`, [code])).rowCount;
            if (!n) throw bizErr('E_ADJ_NOT_DRAFT', `调整单 ${code} 不是草稿，不能作废`);
            return { code, status: 'cancelled', _log: { code } };
          },
        });
      }

      // ---- 计算规则（钩子）：算薪前拦截 / 算薪后告警 ----
      if (url.pathname === '/api/salary/rules') {
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          const rules = (await tx.query(
            `SELECT code, name, stage, formula, action, message, is_active, sort_order
               FROM salary_rule ORDER BY sort_order, code`)).rows;
          const hits = (await tx.query(
            `SELECT rule_code, stage, action, message, person_id, hit_at
               FROM salary_rule_hit ORDER BY id DESC LIMIT 20`)).rows;
          return { rules, hits };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/salary/rule') {
        const p = {
          code: (url.searchParams.get('code') || '').trim().toUpperCase(),
          name: (url.searchParams.get('name') || '').trim(),
          stage: url.searchParams.get('stage') === 'after' ? 'after' : 'before',
          action: url.searchParams.get('action') === 'block' ? 'block' : 'warn',
          formula: (url.searchParams.get('formula') || '').trim(),
          message: (url.searchParams.get('message') || '').trim(),
          order: Number(url.searchParams.get('order') || 100),
        };
        return await runWrite(res, {
          actor: uid, action: 'salary.rule.upsert', subject: `rule:${p.code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(p.code)) {
              throw bizErr('E_ITEM_CODE', '规则代码必须是 2–24 位大写字母/数字/下划线');
            }
            if (p.message.length < 4) throw bizErr('E_ARG_INVALID', '提示语至少 4 个字（拦人要说得清为什么）');
            const allow = {};
            for (const r of (await tx.query(`SELECT code FROM salary_item`)).rows) allow[r.code] = true;
            const bad = (await tx.query(`SELECT fn_formula_script_try($1,$2::jsonb) e`,
              [p.formula, JSON.stringify(allow)])).rows[0].e;
            if (bad) throw bizErr('E_FORMULA', String(bad).split('\n')[0]);
            await tx.query(
              `INSERT INTO salary_rule(code,name,stage,action,formula,message,sort_order,created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
               ON CONFLICT (code) DO UPDATE
                 SET name=EXCLUDED.name, stage=EXCLUDED.stage, action=EXCLUDED.action,
                     formula=EXCLUDED.formula, message=EXCLUDED.message,
                     sort_order=EXCLUDED.sort_order`,
              [p.code, p.name, p.stage, p.action, p.formula, p.message, p.order, String(uid)]);
            return { code: p.code, _log: { stage: p.stage, action: p.action } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/salary/rule/active') {
        const code = url.searchParams.get('code');
        const active = url.searchParams.get('active') !== '0';
        return await runWrite(res, {
          actor: uid, action: active ? 'salary.rule.enable' : 'salary.rule.disable',
          subject: `rule:${code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const n = (await tx.query(
              `UPDATE salary_rule SET is_active=$2 WHERE code=$1 RETURNING code`,
              [code, active])).rowCount;
            if (!n) throw bizErr('E_NOT_FOUND', `规则 ${code} 不存在`);
            return { code, is_active: active, _log: { active } };
          },
        });
      }

      // ---- 工资项目：列表（含函数库）----
      if (url.pathname === '/api/salary/items') {
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          const rows = (await tx.query(
            `SELECT code, name, item_kind, formula, sort_order, is_active, note
               FROM salary_item ORDER BY sort_order, code`)).rows;
          const funcs = (await tx.query(`SELECT * FROM fn_formula_funcs()`)).rows;
          // 变量清单 = 所有工资项代码 + 内置变量。前端据此出"可用变量"，
          // 不另抄一份 —— 抄的那份会在加项目时忘掉更新。
          return { rows, funcs };
        });
      }

      // ---- 工资项目：新建 / 改（code 是主键，改金额口径不能改 code）----
      if (req.method === 'POST' && url.pathname === '/api/salary/item') {
        const p = {
          code: (url.searchParams.get('code') || '').trim().toUpperCase(),
          name: (url.searchParams.get('name') || '').trim(),
          kind: url.searchParams.get('kind') || '',
          formula: (url.searchParams.get('formula') || '').trim(),
          order: Number(url.searchParams.get('order') || 100),
          note: url.searchParams.get('note') || null,
        };
        return await runWrite(res, {
          actor: uid, action: 'salary.item.upsert', subject: `item:${p.code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(p.code)) {
              throw bizErr('E_ITEM_CODE', '代码必须是 2–24 位大写字母/数字/下划线，且以字母开头');
            }
            if (p.name.length < 2) throw bizErr('E_ITEM_NAME', '项目名称至少 2 个字');

            const itemKind = p.formula ? 'formula'
              : (['fixed', 'variable', 'statistic'].includes(p.kind) ? p.kind : 'fixed');

            if (p.formula) {
              // 公式校验（含编译）走库函数：唯一来源，界面与导入用同一套规则
              const allow = {};
              for (const r of (await tx.query(`SELECT code FROM salary_item`)).rows) allow[r.code] = true;
              allow[p.code] = true;
              const bad = (await tx.query(`SELECT fn_formula_try($1,$2::jsonb) e`,
                [p.formula, JSON.stringify(allow)])).rows[0].e;
              if (bad) throw bizErr('E_FORMULA', String(bad).split('\n')[0]);
            }

            await tx.query(
              `INSERT INTO salary_item(code, name, item_kind, formula, sort_order, is_active, note)
               VALUES ($1,$2,$3,$4,$5,true,$6)
               ON CONFLICT (code) DO UPDATE
                 SET name = EXCLUDED.name, item_kind = EXCLUDED.item_kind,
                     formula = EXCLUDED.formula, sort_order = EXCLUDED.sort_order,
                     note = EXCLUDED.note`,
              [p.code, p.name, itemKind, p.formula || null, p.order, p.note]);
            return { code: p.code, item_kind: itemKind, _log: { name: p.name, formula: p.formula } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/salary/item/active') {
        const code = url.searchParams.get('code');
        const active = url.searchParams.get('active') !== '0';
        return await runWrite(res, {
          actor: uid, action: active ? 'salary.item.enable' : 'salary.item.disable',
          subject: `item:${code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const n = (await tx.query(
              `UPDATE salary_item SET is_active=$2 WHERE code=$1 RETURNING code`,
              [code, active])).rowCount;
            if (!n) throw bizErr('E_NOT_FOUND', `工资项 ${code} 不存在`);
            return { code, is_active: active, _log: { active } };
          },
        });
      }

      // ---- 公式试算：给一组变量，立刻看到结果或错误 ----
      // @no-runWrite: 试算是只读的（不落库），用 POST 只是因为公式可能很长、放不进 URL
      //   之外的语义 —— 它不该出现在"写路由"的统计里。
      // 这是"配公式"最需要的一步：不试算就只能等算薪那天才知道写错没有。
      if (req.method === 'POST' && url.pathname === '/api/salary/formula/preview') {
        // @no-runWrite: 试算是**只读**的，不落库；用 POST 只是因为公式可能很长。
        //   注释放这里（条件之后）是必须的：扫描器按 `req.method === 'POST'` 切段，
        //   写在条件之前的注释会被切进上一段，等于没写。
        const formula = url.searchParams.get('formula') || '';
        let vars = {};
        try { vars = JSON.parse(url.searchParams.get('vars') || '{}'); } catch { vars = {}; }
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          const allow = {};
          for (const r of (await tx.query(`SELECT code FROM salary_item`)).rows) allow[r.code] = true;
          const bad = (await tx.query(`SELECT fn_formula_try($1,$2::jsonb) e`,
            [formula, JSON.stringify(allow)])).rows[0].e;
          if (bad) return { ok: false, error: String(bad).split('\n')[0] };
          const out = (await tx.query(`SELECT fn_formula_eval($1,$2::jsonb) v`,
            [formula, JSON.stringify(vars)])).rows[0].v;
          return { ok: true, value: out, formula, vars };
        });
      }

      // ---- 提成规则：列表 / 建规则 / 销售额 / 按规则算 ----
      if (url.pathname === '/api/commission/rules') {
        const period = url.searchParams.get('period');
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          const rules = (await tx.query(
            `SELECT r.id, r.code, r.name, r.scope_org, o.name AS org_name,
                    r.scope_position, po.name AS position_name, r.is_active, r.sort_order,
                    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'from_amount', t.from_amount, 'to_amount', t.to_amount,
                                'rate', t.rate) ORDER BY t.from_amount)
                              FROM commission_rule_tier t WHERE t.rule_id = r.id), '[]'::jsonb) AS tiers
               FROM commission_rule r
               LEFT JOIN org_unit o ON o.id = r.scope_org
               LEFT JOIN position po ON po.id = r.scope_position
              ORDER BY r.sort_order, r.code`)).rows;
          const basis = period ? (await tx.query(
            `SELECT b.person_id, p.full_name, b.period, b.sales_amount,
                    fn_commission_calc(b.person_id, b.period) AS commission
               FROM commission_basis b JOIN person p ON p.id = b.person_id
              WHERE b.period = $1 ORDER BY p.full_name`, [period])).rows : [];
          return { rules, basis };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/commission/rule') {
        const p = {
          code: (url.searchParams.get('code') || '').trim().toUpperCase(),
          name: (url.searchParams.get('name') || '').trim(),
          org: url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null,
          position: url.searchParams.get('position') ? Number(url.searchParams.get('position')) : null,
          tiers: url.searchParams.get('tiers') || '[]',
        };
        return await runWrite(res, {
          actor: uid, action: 'commission.rule.upsert', subject: `rule:${p.code}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!/^[A-Z][A-Z0-9_]{1,23}$/.test(p.code)) {
              throw bizErr('E_ITEM_CODE', '规则代码必须是 2–24 位大写字母/数字/下划线');
            }
            let tiers = [];
            try { tiers = JSON.parse(p.tiers); } catch { tiers = []; }
            if (!Array.isArray(tiers) || !tiers.length) {
              throw bizErr('E_ARG_INVALID', '至少给一段阶梯');
            }
            const id = Number((await tx.query(
              `INSERT INTO commission_rule(code,name,scope_org,scope_position,created_by)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (code) DO UPDATE
                 SET name=EXCLUDED.name, scope_org=EXCLUDED.scope_org,
                     scope_position=EXCLUDED.scope_position, is_active=true
               RETURNING id`,
              [p.code, p.name || p.code, p.org, p.position, String(uid)])).rows[0].id);
            await tx.query(`DELETE FROM commission_rule_tier WHERE rule_id=$1`, [id]);
            for (const t of tiers) {
              await tx.query(
                `INSERT INTO commission_rule_tier(rule_id, from_amount, to_amount, rate)
                 VALUES ($1,$2,$3,$4)`,
                [id, Number(t.from_amount) || 0,
                 t.to_amount === null || t.to_amount === undefined || t.to_amount === ''
                   ? null : Number(t.to_amount),
                 Number(t.rate) || 0]);
            }
            return { id, code: p.code, tiers: tiers.length, _log: { code: p.code } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/commission/basis') {
        const p = { person: Number(url.searchParams.get('person')),
                    period: url.searchParams.get('period'),
                    amount: Number(url.searchParams.get('amount')),
                    note: url.searchParams.get('note') || null };
        return await runWrite(res, {
          actor: uid, action: 'commission.basis', subject: `person:${p.person}@${p.period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!(p.amount >= 0)) throw bizErr('E_ARG_INVALID', '销售额必须是非负数');
            await tx.query(
              `INSERT INTO commission_basis(person_id,period,sales_amount,note,updated_by)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (person_id, period) DO UPDATE
                 SET sales_amount=EXCLUDED.sales_amount, note=EXCLUDED.note,
                     updated_by=EXCLUDED.updated_by, updated_at=now()`,
              [p.person, p.period, p.amount, p.note, String(uid)]);
            const amt = (await tx.query(`SELECT fn_commission_calc($1,$2) a`,
              [p.person, p.period])).rows[0].a;
            return { person_id: p.person, period: p.period, sales: p.amount, commission: amt,
                     _log: { amount: p.amount } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/commission/apply') {
        const period = url.searchParams.get('period');
        return await runWrite(res, {
          actor: uid, action: 'commission.apply', subject: `period:${period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const people = (await tx.query(
              `SELECT person_id FROM commission_basis WHERE period = $1`, [period])).rows;
            const out = [];
            for (const x of people) {
              const amt = (await tx.query(`SELECT fn_commission_apply($1,$2,$3) a`,
                [x.person_id, period, String(uid)])).rows[0].a;
              out.push({ person_id: Number(x.person_id), commission: amt });
            }
            return { period, applied: out.filter(x => Number(x.commission) > 0).length,
                     rows: out, _log: { period, n: out.length } };
          },
        });
      }

      // ---- 年终奖：录入 / 单独计税批次 ----
      // ★ 必须限定 GET：不限定的话 POST 会先落进这个分支，表现为
      //   "录入成功但列表没变"——因为请求其实去查了一次列表。
      if (req.method === 'GET' && url.pathname === '/api/payroll/bonus') {
        const year = Number(url.searchParams.get('year') || new Date().getFullYear());
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          const rows = (await tx.query(
            `SELECT ab.id, ab.person_id, p.full_name, ab.year, ab.amount, ab.note,
                    fn_iit_bonus(ab.amount) AS tax, ab.amount - fn_iit_bonus(ab.amount) AS net
               FROM annual_bonus ab JOIN person p ON p.id = ab.person_id
              WHERE ab.year = $1 ORDER BY p.full_name`, [year])).rows;
          return { year, rows };
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/bonus') {
        const p = { person: Number(url.searchParams.get('person')),
                    year: Number(url.searchParams.get('year')),
                    amount: Number(url.searchParams.get('amount')),
                    note: url.searchParams.get('note') || null };
        return await runWrite(res, {
          actor: uid, action: 'payroll.bonus.set', subject: `person:${p.person}@${p.year}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!(p.amount > 0)) throw bizErr('E_ARG_INVALID', '年终奖金额必须大于 0');
            await tx.query(
              `INSERT INTO annual_bonus(person_id, year, amount, note, created_by)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (person_id, year) DO UPDATE
                 SET amount = EXCLUDED.amount, note = EXCLUDED.note`,
              [p.person, p.year, p.amount, p.note, String(uid)]);
            return { person_id: p.person, year: p.year, amount: p.amount,
                     tax: (await tx.query(`SELECT fn_iit_bonus($1) t`, [p.amount])).rows[0].t,
                     _log: { amount: p.amount } };
          },
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/payroll/bonus/run') {
        const year = Number(url.searchParams.get('year'));
        const entity = Number(url.searchParams.get('entity') || 1);
        return await runWrite(res, {
          actor: uid, action: 'payroll.bonus.run', subject: `bonus:${year}/e${entity}`,
          fn: (tx) => payroll.runBonus(tx, { userId: uid, year, entityId: entity }),
        });
      }

      // ---- 工资表导入：项目与公式 / 每人金额 ----
      // ★ 上传走**原始请求体**（application/octet-stream），不走 multipart：
      //   multipart 要自己拆边界，而这里只有一个文件、没有别的字段。
      if (req.method === 'POST' && url.pathname === '/api/salary/import') {
        const kind = url.searchParams.get('kind') === 'data' ? 'data' : 'items';
        const filename = (url.searchParams.get('filename') || 'upload.csv').slice(0, 200);
        const period = url.searchParams.get('period');
        let buf;
        try { buf = await readBody(req); } catch (e) {
          const m = toHttp(e);
          return json(res, m.status, m.body);
        }
        if (!buf || buf.length === 0) {
          return json(res, 400, { error: 'E_IMPORT_EMPTY', message: '文件是空的' });
        }
        return await runWrite(res, {
          actor: uid, action: `salary.import.${kind}`, subject: `file:${filename}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const out = kind === 'data'
              ? await salaryImport.importData(tx, { buffer: buf, filename, period, userId: uid })
              : await salaryImport.importItems(tx, { buffer: buf, filename, userId: uid });
            return {
              batch_id: out.batchId, kind, filename,
              total: out.total, ok: out.ok, fail: out.fail,
              rows: out.rows,
              _log: { kind, file: filename, ok: out.ok, fail: out.fail },
            };
          },
        });
      }

      if (url.pathname === '/api/salary/import' && req.method === 'GET') {
        const batch = Number(url.searchParams.get('batch'));
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'read' });
          return await salaryImport.getBatch(tx, batch);
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/salary/import/apply') {
        const batch = Number(url.searchParams.get('batch'));
        const period = url.searchParams.get('period') || null;
        return await runWrite(res, {
          actor: uid, action: 'salary.import.apply', subject: `batch:${batch}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const out = await salaryImport.applyDataBatch(tx, { batchId: batch, period, userId: uid });
            return { ...out, _log: { batch, applied: out.applied } };
          },
        });
      }

      // ---- 设置工资结构（拆分，不改总额）----
      if (req.method === 'POST' && url.pathname === '/api/salary/structure') {
        const employment = Number(url.searchParams.get('employment'));
        const from = url.searchParams.get('from') || null;
        let items = [];
        try { items = JSON.parse(url.searchParams.get('items') || '[]'); } catch { items = []; }
        return await runWrite(res, {
          actor: uid, action: 'salary.structure', subject: `employment:${employment}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            const total = (await tx.query(
              `SELECT fn_salary_structure_set($1, COALESCE($2::date, app_today()), $3::jsonb, $4) t`,
              [employment, from, JSON.stringify(items), String(uid)])).rows[0].t;
            return { employment_id: employment, total, _log: { items: items.length, total } };
          },
        });
      }

      // ---- 提成录入（计入工资）----
      if (req.method === 'POST' && url.pathname === '/api/commission') {
        const p = { person: Number(url.searchParams.get('person')),
                    period: url.searchParams.get('period'),
                    amount: Number(url.searchParams.get('amount')),
                    basis: url.searchParams.get('basis') || null };
        return await runWrite(res, {
          actor: uid, action: 'commission.add', subject: `person:${p.person}@${p.period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!(p.amount >= 0)) throw bizErr('E_ARG_INVALID', 'amount 必须是非负数');
            const id = Number((await tx.query(
              `INSERT INTO commission_record(person_id,period,amount,basis,status,created_by)
               VALUES ($1,$2,$3,$4,'approved',$5) RETURNING id`,
              [p.person, p.period, p.amount, p.basis, String(uid)])).rows[0].id);
            return { id, _log: { person: p.person, amount: p.amount } };
          },
        });
      }

      // ---- 报销录入（不计税、不进工资条）----
      if (req.method === 'POST' && url.pathname === '/api/expense') {
        const p = { person: Number(url.searchParams.get('person')),
                    period: url.searchParams.get('period'),
                    category: url.searchParams.get('category') || '其他',
                    amount: Number(url.searchParams.get('amount')),
                    note: url.searchParams.get('note') || null };
        return await runWrite(res, {
          actor: uid, action: 'expense.add', subject: `person:${p.person}@${p.period}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!(p.amount > 0)) throw bizErr('E_ARG_INVALID', 'amount 必须大于 0');
            const id = Number((await tx.query(
              `INSERT INTO expense_claim(person_id,period,category,amount,note,status,created_by)
               VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING id`,
              [p.person, p.period, p.category, p.amount, p.note, String(uid)])).rows[0].id);
            return { id, status: 'pending', _log: { person: p.person, amount: p.amount } };
          },
        });
      }

      // ---- 报销审批（pending → approved / rejected / paid）----
      if (req.method === 'POST' && url.pathname === '/api/expense/status') {
        const id = Number(url.searchParams.get('id'));
        const status = url.searchParams.get('status') || '';
        return await runWrite(res, {
          actor: uid, action: 'expense.status', subject: `expense:${id}`,
          fn: async (tx) => {
            await requireSession(tx, { userId: uid, resource: 'payroll_run', action: 'write' });
            if (!['approved', 'rejected', 'paid'].includes(status)) {
              throw bizErr('E_ARG_INVALID', 'status 只能是 approved / rejected / paid');
            }
            // ★ 状态一改就要留人：报销是最容易出事的一类单（金额小、频次高），
            //   "谁批的"必须查得到 —— 否则财务只能问人，而人会记错。
            const n = (await tx.query(
              `UPDATE expense_claim
                  SET status = $2, approved_by = $3, approved_at = now()
                WHERE id = $1 RETURNING id`, [id, status, String(uid)])).rowCount;
            if (!n) throw bizErr('E_NOT_FOUND', `报销单 ${id} 不存在`);
            return { id, status, approved_by: String(uid), _log: { status } };
          },
        });
      }

      // ---- 岗位清单（组织页"按岗位"视图）----
      if (url.pathname === '/api/positions') {
        const org = url.searchParams.get('org') ? Number(url.searchParams.get('org')) : null;
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'employee_roster' });
          const rows = (await tx.query(
            `SELECT * FROM fn_position_list($1::bigint, app_today())`, [org])).rows;
          return { rows, today: (await tx.query('SELECT app_today() d')).rows[0].d };
        });
      }

      // ---- 某个部门的人员（组织页点节点要看"都是谁"）----
      if (url.pathname === '/api/org/members') {
        const org = Number(url.searchParams.get('org'));
        return await runRead(res, async (tx) => {
          await requireSession(tx, { userId: uid, resource: 'employee_roster' });
          const orgRow = (await tx.query(
            `SELECT id, name, kind, path FROM org_unit WHERE id = $1`, [org])).rows[0];
          if (!orgRow) return { org: null, rows: [] };
          const rows = (await tx.query(
            `SELECT p.id, p.full_name, n.no AS employee_no, e.hire_date,
                    (SELECT string_agg(r.name, ' / ' ORDER BY r.code)
                       FROM fn_effective_roles(a2.id, sys_today()) er
                       JOIN sys_role r ON r.id = er.role_id
                      WHERE a2.person_id = p.id AND a2.id IS NOT NULL) AS role_names,
                    EXISTS (SELECT 1 FROM ext_person_map m
                             WHERE m.person_id = p.id AND m.system_code = 'dingtalk') AS from_dingtalk
               FROM employee_org_assignment a
               JOIN employment e ON e.person_id = a.employee_id
               JOIN person p ON p.id = a.employee_id
               LEFT JOIN employee_no n ON n.assigned_person_id = p.id AND n.retired_at IS NULL
               LEFT JOIN LATERAL (SELECT id FROM sys_account WHERE person_id = p.id LIMIT 1) a2 ON true
              WHERE a.org_id = $1 AND a.dim_code = 'attendance_org' AND a.valid_to IS NULL
                AND daterange(e.hire_date, e.leave_date, '[]') @> app_today()
              ORDER BY p.full_name`, [org])).rows;
          const q = (await tx.query(
            `SELECT fn_hc_quota($1, to_char(app_today(),'YYYY-MM')) q`, [org])).rows[0].q;
          return {
            org: orgRow, rows,
            quota: q === null ? null : Number(q),
            headcount: rows.length,
          };
        });
      }

      // ---- 副职代理：主管把自己的某个角色在**一段时间内**交给副手 ----
      if (url.pathname === '/api/acting') {
        return await runRead(res, (tx) => acting.mine(tx, { userId: uid }));
      }
      if (req.method === 'POST' && url.pathname === '/api/acting/grant') {
        const p = {
          userId: uid,
          agent: url.searchParams.get('agent'),
          role: url.searchParams.get('role') || 'store_mgr',
          days: url.searchParams.get('days') || 7,
          reason: url.searchParams.get('reason'),
        };
        return await runWrite(res, {
          actor: uid, action: 'acting.grant', subject: `agent:${p.agent}`,
          fn: (tx) => acting.grant(tx, p),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/acting/revoke') {
        const id = Number(url.searchParams.get('id'));
        return await runWrite(res, {
          actor: uid, action: 'acting.revoke', subject: `acting:${id}`,
          fn: (tx) => acting.revoke(tx, { userId: uid, id }),
        });
      }

      // ---- 打卡：服务端时间 + 门店围栏（参照钉钉的最小可用集）----
      if (req.method === 'POST' && url.pathname === '/api/punch') {
        const p = {
          userId: uid,
          kind: url.searchParams.get('kind') || 'in',
          storeId: url.searchParams.get('store') ? Number(url.searchParams.get('store')) : null,
          lat: url.searchParams.get('lat') ? Number(url.searchParams.get('lat')) : null,
          lng: url.searchParams.get('lng') ? Number(url.searchParams.get('lng')) : null,
          device: url.searchParams.get('device'),
        };
        return await runWrite(res, {
          actor: uid, action: 'punch.' + p.kind, subject: `store:${p.storeId ?? '-'}`,
          fn: (tx) => punch.punch(tx, p),
        });
      }

      // ---- 打卡流水：他打完卡要能看见"同步过来了没有" ----
      if (url.pathname === '/api/punch/log') {
        const date = url.searchParams.get('date')
          || (await db.query('SELECT app_today() d')).rows[0].d.toISOString().slice(0, 10);
        return await runRead(res, (tx) => punch.log(tx, { userId: uid, date }));
      }

      if (url.pathname === '/api/punch/today') {
        return await runRead(res, (tx) => punch.today(tx, { userId: uid }));
      }

      // ---- 报表：面板 + 三路径交叉核对 ----
      // ★ 这一段原来直接 db.query，**没灌权限、也没判 org** ——
      //   于是任何登录账号把 org 改一下就能读别的店的工资总额。
      //   报表按 p_org 算数，函数自己不带行闸，所以这道门只能在服务层。
      if (url.pathname === '/api/report') {
        const period = url.searchParams.get('period') || '2026-03';
        const orgId = Number(url.searchParams.get('org') || 30);
        return await runRead(res, (tx) => report.panel(tx, { userId: uid, orgId, period }));
      }

      // ---- 报表趋势：多期（逐月）同一块面板，页面只画线，不重算 ----
      // ★ 与 /api/report 同一道门：org 必须在范围内（requireOrg 在服务层）。
      //   趋势比单期更敏感 —— 一条曲线能看出规模、季节性、有没有裁过员。
      if (url.pathname === '/api/report/trend') {
        const orgId = Number(url.searchParams.get('org') || 30);
        const from = url.searchParams.get('from') || '2026-01';
        const to = url.searchParams.get('to') || '2026-06';
        return await runRead(res, (tx) => reportTrend.trend(tx, { userId: uid, orgId, from, to }));
      }

      // ---- 报表导出：与页面同一个函数，写留痕，最后才换格式 ----
      if (url.pathname === '/api/report/export.csv') {
        const period = url.searchParams.get('period') || '2026-03';
        const orgId = Number(url.searchParams.get('org') || 30);
        return await runWrite(res, {
          actor: uid, action: 'report.export', subject: `org:${orgId}@${period}`,
          fn: (tx) => report.exportCsv(tx, { userId: uid, orgId, period }),
          send: (r, out) => {
            r.writeHead(200, {
              ...CSV_HEADERS, ...SEC_HEADERS,
              'content-length': Buffer.byteLength(out.text, 'utf8'),
              'content-disposition': `attachment; filename="${out.filename}"`,
            });
            r.end(out.text);
          },
        });
      }

      // ---- 导出留痕：谁在往外带数据 ----
      if (url.pathname === '/api/report/export/log') {
        return await runRead(res, (tx) => report.recentExports(tx, { userId: uid }));
      }

      // ---- 看板：先异常、再总量 ----
      if (url.pathname === '/api/dashboard') {
        const period = url.searchParams.get('period') || '2026-03';
        return await runRead(res, (tx) => report.dashboard(tx, { userId: uid, period }));
      }

      // ---- 招聘：需求 / offer / 还能发几个 ----
      if (url.pathname === '/api/recruit') {
        const asOf = url.searchParams.get('as_of') || '2026-03-05';
        return await runRead(res, (tx) => recruit.board(tx, { userId: uid, asOf }));
      }

      // ---- 招聘：开需求（原来没有入口，只有种子 SQL 能开）----
      if (req.method === 'POST' && url.pathname === '/api/recruit/requisition') {
        const p = {
          userId: uid,
          orgId: Number(url.searchParams.get('org')),
          position: url.searchParams.get('position'),
          headcount: Number(url.searchParams.get('headcount')),
          openedAt: url.searchParams.get('opened_at'),
          reason: url.searchParams.get('reason'),
        };
        return await runWrite(res, {
          actor: uid, action: 'recruit.requisition', subject: `org:${p.orgId}`,
          fn: (tx) => recruit.openRequisition(tx, p),
        });
      }

      // ---- 招聘：发 offer ----
      // ---- 入职：招聘漏斗的末端（offer → 任职 + 归属 + 月薪）----
      if (req.method === 'POST' && url.pathname === '/api/recruit/hire') {
        const p = {
          userId: uid,
          offerId: Number(url.searchParams.get('offer')),
          hireDate: url.searchParams.get('date'),
          entityId: Number(url.searchParams.get('entity') || 1),
          personId: url.searchParams.get('person') ? Number(url.searchParams.get('person')) : null,
        };
        return await runWrite(res, {
          actor: uid, action: 'recruit.hire', subject: `offer:${p.offerId}`,
          fn: (tx) => recruit.hire(tx, p),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/recruit/offer') {
        const p = {
          userId: uid,
          requisitionId: Number(url.searchParams.get('rq')),
          candidateKey: url.searchParams.get('key'),
          candidateName: url.searchParams.get('name'),
          position: url.searchParams.get('position'),
          amount: Number(url.searchParams.get('amount')),
          validUntil: url.searchParams.get('valid_until'),
          on: url.searchParams.get('on'),
          reason: url.searchParams.get('reason'),
        };
        return await runWrite(res, {
          actor: uid, action: 'recruit.offer', subject: `rq:${p.requisitionId}`,
          fn: (tx) => recruit.issueOffer(tx, p),
        });
      }

      // ---- 绩效：周期 / 结果 / 封存 ----
      if (url.pathname === '/api/perf') {
        return await runRead(res, (tx) => perf.view(tx, { userId: uid }));
      }

      if (req.method === 'POST' && url.pathname === '/api/perf/score') {
        const p = {
          userId: uid,
          cycleId: Number(url.searchParams.get('cycle')),
          employeeId: Number(url.searchParams.get('employee')),
          scoreValue: url.searchParams.get('score'),
          note: url.searchParams.get('note') || null,
        };
        return await runWrite(res, {
          actor: uid, action: 'perf.score', subject: `cycle:${p.cycleId}/emp:${p.employeeId}`,
          fn: (tx) => perf.score(tx, p),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/perf/exclude') {
        const p = {
          userId: uid,
          cycleId: Number(url.searchParams.get('cycle')),
          employeeId: Number(url.searchParams.get('employee')),
          note: url.searchParams.get('note') || '',
        };
        return await runWrite(res, {
          actor: uid, action: 'perf.exclude', subject: `cycle:${p.cycleId}/emp:${p.employeeId}`,
          fn: (tx) => perf.exclude(tx, p),
        });
      }

      if (url.pathname === '/api/perf/pending') {
        const cycleId = Number(url.searchParams.get('cycle'));
        return await runRead(res, async (tx) => ({
          rows: await perf.pending(tx, { userId: uid, cycleId }),
        }));
      }

      if (req.method === 'POST' && url.pathname === '/api/perf/seal') {
        const id = Number(url.searchParams.get('cycle'));
        return await runWrite(res, {
          actor: uid, action: 'perf.seal', subject: `cycle:${id}`,
          fn: (tx) => perf.seal(tx, { userId: uid, cycleId: id }),
        });
      }

      if (url.pathname === '/api/perf/distribution') {
        const id = Number(url.searchParams.get('cycle'));
        return await runRead(res, async (tx) => ({
          rows: await perf.distribution(tx, { userId: uid, cycleId: id }) }));
      }

      // ---- 绩效结果的痕迹：谁打的分 / 改分台账 / 每档都出行（158）----
      // ★ 路径是 /dist 不是 /distribution：上面那条是**裸数组**，
      //   这条是 {cycle_id, rows, kpi}。同名会让前端按同一个形状解，然后 quietly 空白。
      if (url.pathname === '/api/perf/results') {
        const id = Number(url.searchParams.get('cycle'));
        return await runRead(res, (tx) => perfScorer.results(tx, { userId: uid, cycleId: id }));
      }

      if (url.pathname === '/api/perf/history') {
        const id = Number(url.searchParams.get('cycle'));
        const emp = Number(url.searchParams.get('employee'));
        return await runRead(res, (tx) => perfScorer.history(tx, {
          userId: uid, cycleId: id, employeeId: emp }));
      }

      if (url.pathname === '/api/perf/dist') {
        const id = Number(url.searchParams.get('cycle'));
        return await runRead(res, (tx) => perfScorer.distribution(tx, { userId: uid, cycleId: id }));
      }

      // ---- 绩效指标库 / 考核项 / 逐项得分 / 加权汇总（159）----
      // ★ 加权、封顶、折分一律在库里（fn_perf_item_score / fn_perf_total）。
      //   前端再算一遍，页面上的分数与 perf_result_item.score 迟早会不一样，
      //   而那时候没人分得清哪个是对的。
      if (url.pathname === '/api/perf/metrics') {
        const all = url.searchParams.get('all') === '1';
        return await runRead(res, (tx) => perfMetric.metrics(tx, { userId: uid, onlyActive: !all }));
      }

      if (req.method === 'GET' && url.pathname === '/api/perf/items') {
        const schemeId = Number(url.searchParams.get('scheme'));
        return await runRead(res, (tx) => perfMetric.items(tx, { userId: uid, schemeId }));
      }

      if (req.method === 'POST' && url.pathname === '/api/perf/items') {
        // 考核项是数组，走请求体：几个方案的考核项一起塞进 URL 会被截断，
        // 截断后解析失败看起来像"参数错"，而真正的问题是长度。
        const body = await readBody(req);
        let list = [];
        try { list = JSON.parse(body || '[]'); } catch { list = []; }
        return await runWrite(res, {
          actor: uid, action: 'perf.items.set',
          subject: `scheme:${url.searchParams.get('scheme')}`,
          fn: (tx) => perfMetric.setItems(tx, {
            userId: uid, schemeId: Number(url.searchParams.get('scheme')), items: list }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/perf/item-score') {
        const body = await readBody(req);
        let p = {};
        try { p = JSON.parse(body || '{}'); } catch { p = {}; }
        const q = url.searchParams;
        return await runWrite(res, {
          actor: uid, action: 'perf.item.score',
          subject: `result:${q.get('result')}/item:${q.get('item')}`,
          fn: (tx) => perfMetric.scoreItem(tx, {
            userId: uid,
            resultId: Number(q.get('result')),
            itemId: Number(q.get('item')),
            actual: p.actual ?? q.get('actual'),
            note: p.note ?? q.get('note'),
          }),
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/perf/total') {
        const resultId = Number(url.searchParams.get('result'));
        return await runWrite(res, {
          actor: uid, action: 'perf.total', subject: `result:${resultId}`,
          fn: (tx) => perfMetric.total(tx, { userId: uid, resultId }),
        });
      }

      if (url.pathname === '/api/perf/check') {
        const schemeId = Number(url.searchParams.get('scheme'));
        return await runRead(res, (tx) => perfMetric.check(tx, { userId: uid, schemeId }));
      }

      return json(res, 404, { error: 'E_NOT_FOUND' });
    } catch (e) {
      // ★ 统一映射，不在这里各写各的。
      //   原来这里是 500 + e.message，两个后果：
      //   ① 业务拒绝（额度不够）看起来像服务故障；
      //   ② e.message 常带表名与约束名，直接吐给前端等于把 schema 送出去。
      const m = toHttp(e);
      if (m.status >= 500) console.error('[500]', m.body.ref, String(e.message).split('\n')[0]);
      return json(res, m.status, m.body);
    }
  });

  return { db, control: registry ? registry.control : null, registry, server };
}

/**
 * 开一个新帐套的库：spawn tools/new-ledger.mjs，把它的六步原样回给调用方。
 * ★ 用子进程而不是在这里 require 那些步骤：迁移要连**另一个库**、
 *   还要 CREATE DATABASE（需要建库权限），这些放进请求进程里做会污染连接池，
 *   也会让"正在跑的这套服务"跟着拥有建库权限。
 */
function provisionLedger({ code, name, period, admin, pwd }) {
  return new Promise((resolve) => {
    const script = join(HERE, '..', 'tools', 'new-ledger.mjs');
    const args = [script, '--code', code, '--name', name, '--period', period,
                  '--admin', admin, '--pwd', pwd];
    const child = spawn(process.execPath, args, {
      cwd: join(HERE, '..'),
      env: { ...process.env, DATABASE_URL: process.env.CONTROL_URL },
    });
    const steps = [];
    let err = '';
    const onLine = (buf) => {
      for (const line of String(buf).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/^(①|②|③|④|⑤|⑥|[0-9] ?①)/.test(t) || t.startsWith('库 ')) steps.push(t);
        else if (/^(用法|库名不合法|error|Error)/i.test(t)) err += t + '\n';
        else steps.push(t);
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', (b) => { err += String(b); onLine(b); });
    child.on('close', (code0) => {
      resolve({
        ok: code0 === 0, exit_code: code0,
        code, steps: steps.slice(0, 40),
        error: code0 === 0 ? undefined : (err.split('\n').filter(Boolean).slice(-3).join(' | ') || `退出码 ${code0}`),
      });
    });
  });
}

// 直接用 node app/server.mjs 启动
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { server } = await createApp();
  const port = Number(process.env.PORT || 8787);
  // ★ 默认只绑回环：绑 0.0.0.0 而没有 TLS/反代，等于把"能登录就能改工资"暴露到网络上。
  //   容器里必须显式设 HOST=0.0.0.0，并且放在反代之后。
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`listening on ${host}:${port}`));
}
