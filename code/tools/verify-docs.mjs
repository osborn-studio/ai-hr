// ============================================================================
// tools/verify-docs.mjs · 文档里的数字必须与真实库对得上
// ----------------------------------------------------------------------------
// 这个仓库有一条规矩：「断言条数不许手抄」。可是 README 顶部的状态表里
// 仍然写着「276 条」「52 个迁移」这种数字 —— 它们是手抄的，也一定会漂。
//
// 漂的方式很具体，也很常见：加了两条断言，改 README 时漏了一处，于是
// 「数据库 276 条」与「合计 424 条」互相矛盾，而两个数字都在同一张表里。
// 读者不会去核对，他只会记住其中一个。
//
// 所以这里做一件事：**从真实来源数一遍，再和 README 里写的比**。
//   · 迁移 / 表 / 函数 / 触发器 / 判据组 → 直接查库与目录
//   · 断言条数 → 跑一遍两套测试，取它们自己打的那一行
//
// 用法：
//   node tools/verify-docs.mjs            # 报差异，不退出（人看）
//   node tools/verify-docs.mjs --strict   # 有差异就 exit 1（CI 用）
//   node tools/verify-docs.mjs --fast     # 只比库对象数，**不跑测试**
//
// ★ 为什么要 --fast：断言条数必须靠"真跑五套"才知道，而五套连跑在内存小的机器上
//   会被 OOM kill（exit 137）。--fast 跳过这一步，只核对迁移/表/函数/触发器/判据组 ——
//   那是查库就能得到的部分。宁可少核几项，也不要一个"跑不动所以没人跑"的工具。
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDb } from '../app/db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DB = join(ROOT, 'db');

const strict = process.argv.includes('--strict');
const fast = process.argv.includes('--fast');

// ---------------------------------------------------------------------------
// 1. 真实数字
// ---------------------------------------------------------------------------
const db = await createDb({});
for (const m of readdirSync(DB).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()) {
  await db.exec(readFileSync(join(DB, m), 'utf8'));
}
const one = async (sql) => Number((await db.query(sql)).rows[0].n);

const actual = {
  migrations: readdirSync(DB).filter((f) => /^\d{3}_.*\.sql$/.test(f)).length,
  tables: await one(`SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`),
  // 与 README 一致的口径：fn_* 与 app_* 两类业务函数
  funcs: await one(`SELECT count(*)::int n FROM pg_proc p
                      JOIN pg_namespace nm ON nm.oid = p.pronamespace
                     WHERE nm.nspname='public'
                       AND (p.proname LIKE 'fn\\_%' OR p.proname LIKE 'app\\_%')`),
  triggers: await one(`SELECT count(*)::int n FROM pg_trigger WHERE NOT tgisinternal`),
  checks: await one(`SELECT count(*)::int n FROM sys_check_registry`),
};
await db.close();

// ---------------------------------------------------------------------------
// 2. 断言条数：跑一遍，取它们自己打的那一行（不靠人抄）
// ---------------------------------------------------------------------------
const runAndCount = (file, re) => {
  const out = execFileSync('node', [join(ROOT, 'test', file)], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  });
  const m = out.match(re);
  return m ? Number(m[1]) : NaN;
};
if (fast) {
  console.log('（--fast：跳过断言条数核对，只比库对象数）');
} else {
actual.dbAssertions = runAndCount('run.mjs', /断言 (\d+) 条 · 通过/);
actual.apiAssertions = runAndCount('api.test.mjs', /断言 (\d+) 条 · 通过/);
// 持久化 / 备份 / 契约三套也跑一遍：合计行是**算**出来的，不是抄的
actual.persistAssertions = runAndCount('persist.test.mjs', /断言 (\d+) 条 · 通过/);
actual.backupAssertions = runAndCount('backup.test.mjs', /断言 (\d+) 条 · 通过/);
// 界面冒烟：没有 Chrome 的机器上它跳过并打"跳过"，这里取到 NaN → 与文档不一致，
// 于是"没跑"会以差异的形式露出来，而不是安静地算成通过。
actual.uiAssertions = runAndCount('ui.test.mjs', /界面冒烟 · 断言 (\d+) 条 · 通过/);
// ★ 端到端验收也是断言，也要进合计 —— 不进去的话"合计 943"会漏掉
//   整整 30 条最贴近真实使用的检查，而那正是最该被看见的部分。
actual.lifeAssertions = runAndCount('lifecycle.mjs', /断言 (\d+) 条 · 通过/);
actual.orgAssertions = runAndCount('multi-org.mjs', /断言 (\d+) 条 · 通过/);
actual.permAssertions = runAndCount('perm-matrix.mjs', /断言 (\d+) 条 · 通过/);
// 打包（171）：一次出全套时的文件数/文件名/掩码口径。进合计的理由与前几套相同 ——
// 不进去的话，"合计"会少掉整整一套最贴近月底发薪动作的检查。
actual.packAssertions = runAndCount('pack.mjs', /断言 (\d+) 条 · 通过/);

const contractOut = execFileSync('node', [join(ROOT, 'test', 'db-contract.test.mjs')],
  { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const cm = contractOut.match(/断言 (\d+) 条（执行 (\d+)）· 通过 (\d+) · 失败 (\d+)(?: · 跳过 (\d+))?/);
const contractAll = cm ? Number(cm[1]) : NaN;
const contractPass = cm ? Number(cm[3]) : NaN;
const contractSkip = cm && cm[5] ? Number(cm[5]) : 0;

// 合计：七套相加
const ui = Number.isFinite(actual.uiAssertions) ? actual.uiAssertions : 0;
const life = Number.isFinite(actual.lifeAssertions) ? actual.lifeAssertions : 0;
const org = Number.isFinite(actual.orgAssertions) ? actual.orgAssertions : 0;
const perm = Number.isFinite(actual.permAssertions) ? actual.permAssertions : 0;
const pack = Number.isFinite(actual.packAssertions) ? actual.packAssertions : 0;
actual.totalAssertions = actual.dbAssertions + actual.apiAssertions
  + actual.persistAssertions + actual.backupAssertions + contractAll + ui + life + org + perm + pack;
actual.totalPassed = actual.dbAssertions + actual.apiAssertions
  + actual.persistAssertions + actual.backupAssertions + contractPass + ui + life + org + perm + pack;
actual.totalSkipped = contractSkip;
}

// ---------------------------------------------------------------------------
// 3. README 里写的数字
// ---------------------------------------------------------------------------
const readme = readFileSync(join(ROOT, '..', 'docs', 'runtime', 'verification-baseline.md'), 'utf8');
const claimed = {
  // **52 个迁移 · 76 张表 · 145 个业务函数（…）· 25 个触发器**
  migrations: Number((readme.match(/\*\*(\d+) 个迁移/) || [])[1]),
  tables: Number((readme.match(/\d+ 个迁移 · (\d+) 张表/) || [])[1]),
  funcs: Number((readme.match(/(\d+) 个业务函数/) || [])[1]),
  triggers: Number((readme.match(/(\d+) 个触发器/) || [])[1]),
  checks: Number((readme.match(/(\d+) 个判据组/) || [])[1]),
  dbAssertions: Number((readme.match(/可执行断言 · 数据库 \| \*\*(\d+) 条/) || [])[1]),
  apiAssertions: Number((readme.match(/可执行断言 · 接口 \| \*\*(\d+) 条/) || [])[1]),
  persistAssertions: Number((readme.match(/可执行断言 · 持久化 \| \*\*(\d+) 条/) || [])[1]),
  backupAssertions: Number((readme.match(/可执行断言 · 备份 \| \*\*(\d+) 条/) || [])[1]),
  uiAssertions: Number((readme.match(/可执行断言 · 界面 \| \*\*(\d+) 条/) || [])[1]),
  lifeAssertions: Number((readme.match(/可执行断言 · 全生命周期 \| \*\*(\d+) 条/) || [])[1]),
  orgAssertions: Number((readme.match(/可执行断言 · 多门店多法人 \| \*\*(\d+) 条/) || [])[1]),
  permAssertions: Number((readme.match(/可执行断言 · 权限矩阵 \| \*\*(\d+) 条/) || [])[1]),
  packAssertions: Number((readme.match(/可执行断言 · 工资单打包 \| \*\*(\d+) 条/) || [])[1]),
  totalAssertions: Number((readme.match(/`(\d+)\/(\d+) 通过`/) || [])[2]),
  totalPassed: Number((readme.match(/`(\d+)\/(\d+) 通过`/) || [])[1]),
};

const LABEL = {
  migrations: '迁移', tables: '表', funcs: '业务函数', triggers: '触发器',
  checks: '判据组', dbAssertions: '数据库断言', apiAssertions: '接口断言',
  persistAssertions: '持久化断言', backupAssertions: '备份断言', uiAssertions: '界面断言',
  lifeAssertions: '全生命周期', orgAssertions: '多门店多法人', permAssertions: '权限矩阵',
  packAssertions: '工资单打包',
  totalAssertions: '断言合计', totalPassed: '其中通过', totalSkipped: '其中跳过',
};

let bad = 0;
console.log('');
console.log('项            真实    文档    结果');
console.log('─'.repeat(46));
for (const k of Object.keys(actual)) {
  if (k === 'totalSkipped') continue;   // 文档里不单独写这个数（写在括号里）
  const a = actual[k], c = claimed[k];
  const ok = Number.isFinite(a) && Number.isFinite(c) && a === c;
  if (!ok) bad++;
  console.log(
    `${LABEL[k].padEnd(12)} ${String(a).padStart(6)} ${String(Number.isFinite(c) ? c : '(缺)').padStart(6)}    ${ok ? 'ok' : '不一致'}`);
}
console.log('');

if (bad) {
  console.log(`${bad} 项数字与文档不一致。改 README 时漏了一处 —— 这正是"手抄数字"的必经之路。`);
  process.exit(strict ? 1 : 0);
}
console.log('文档数字与真实库一致。');
