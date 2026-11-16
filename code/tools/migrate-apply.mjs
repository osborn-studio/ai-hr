// ============================================================================
// tools/migrate-apply.mjs · 把一个**指定**的迁移应用到 PGlite 数据目录（手工前滚）
// ----------------------------------------------------------------------------
// 它存在的原因，是 createApp() 只对**空库**跑迁移：
//   用 PGlite 数据目录跑起来的存量库，重启拿不到任何新号迁移。
//   今晚因此咬了三次（174 / 178 / 179），每次表现都是"代码没生效"而不是"迁移没跑"。
//
// ★ 它**不猜**：必须一个个写出要应用哪几个号（`--only 181,182`）。
//   为什么不自动找"缺哪几条"——这个库没有 schema_migration 账本，
//   "缺"是从指纹推出来的，而指纹只覆盖几条；据此自动前滚，
//   猜错就把旧库永久钉成最新。**错误的账本比没有账本更危险。**
//   要看"停在哪一版"用 tools/migrate-status.mjs（只读）。
//
// ★ 三道闸，缺一不可：
//   ① 占库检查：谁开着这个目录的文件就拒绝（PGlite 单进程独占，不是排队是互相覆盖）；
//   ② 先备份：cp -R 到 `<dir>.bak-<时间戳>`，备份失败就不动库；
//   ③ 一个号一个事务：失败即回滚，不会留下"迁移跑了一半"的库。
//
// ★ 它**不改迁移文件**（已发布的只读）。它只是把文件内容喂给库。
//
// 用法：
//   PGLITE_DATA_DIR=/tmp/xxym-v5 node tools/migrate-apply.mjs --only 181
//   PGLITE_DATA_DIR=/tmp/xxym-v5 node tools/migrate-apply.mjs --only 181,182 --dry-run
//
// 退出码：
//   0  应用成功（或 --dry-run 下检查通过）
//   1  某个迁移执行失败（已回滚，库未变；备份仍在）
//   2  拒绝执行（占库 / 目录不对 / 号不存在 / 没给 --only / 备份失败）
// ============================================================================
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_DIR = join(HERE, '..');
const DB_DIR = join(CODE_DIR, 'db');
const SERVICE_PORT = process.env.PORT || '8899';

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

// ---- 参数 -------------------------------------------------------------------
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const onlyArg = (() => {
  const i = argv.indexOf('--only');
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--only='));
  return eq ? eq.slice('--only='.length) : null;
})();
if (!onlyArg) {
  die('必须用 --only 指定要应用的迁移号（例：--only 181,182）。\n'
    + '  这个工具故意不自动推断"缺哪几条"：没有账本时猜错会把旧库永久钉成最新。\n'
    + '  要只看现状：tools/migrate-status.mjs（只读）。');
}
const wanted = onlyArg.split(',').map((s) => s.trim()).filter(Boolean);

const dataDir = process.env.PGLITE_DATA_DIR;
if (!dataDir) die('必须给 PGLITE_DATA_DIR（真 PG 用 tools/migrate.mjs）');
if (!existsSync(join(dataDir, 'PG_VERSION'))) {
  // ★ 不能"顺手建一个空目录再打开"：PGlite 会把它初始化成空库，
  //   于是"路径拼错"变成"给一个不存在的库跑迁移"。
  die(`这个目录里没有建过库（缺 PG_VERSION）：${dataDir}\n  是不是 PGLITE_DATA_DIR 写错了？`);
}

// ---- ① 占库检查 -------------------------------------------------------------
// 判据是"谁开着这个目录下的文件"，不是"8899 上有人"——
// 端口只是找到那个进程的线索。宁可拒绝，也不能用"我猜没人用"去写一个独占目录。
function lsof(args) {
  try {
    return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e.stdout) return e.stdout;
    if (e.code === 'ENOENT') die('无法检测数据目录的占用情况（没有 lsof）。为免与正在运行的服务撞上同一个库，拒绝继续。');
    return '';
  }
}
const realDir = realpathSync(dataDir);
const under = (p) => p === realDir || p.startsWith(realDir + sep);
const pids = lsof(['-nP', `-iTCP:${SERVICE_PORT}`, '-sTCP:LISTEN'])
  .split('\n').filter((l) => l.trim() && !/^COMMAND/.test(l))
  .map((l) => l.trim().split(/\s+/)[1]).filter(Boolean);
const holders = [];
for (const p of new Set(pids)) {
  const paths = lsof(['-p', String(p), '-Fn']).split('\n')
    .filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
  if (paths.some(under)) holders.push(p);
}
if (holders.length) {
  die(`库里正在被服务占用（PID ${holders.join(', ')}，端口 ${SERVICE_PORT}）。\n`
    + '  先停服务再前滚：同一个 PGlite 目录不允许两个写者（不是排队，是互相覆盖）。');
}

// ---- 解析要应用的迁移文件 ----------------------------------------------------
const all = readdirSync(DB_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const pick = [];
for (const w of wanted) {
  const hit = all.find((f) => f.startsWith(w.padStart(3, '0') + '_'));
  if (!hit) die(`db/ 里没有编号 ${w} 的迁移。现有最大号：${all[all.length - 1]}`);
  pick.push(hit);
}

console.log(`库：${dataDir}`);
console.log(`${dryRun ? '（dry-run，不会写库）' : ''}将按序应用 ${pick.length} 个迁移：`);
for (const f of pick) console.log(`  · ${f}`);

if (dryRun) { console.log('检查通过。去掉 --dry-run 才会真的写。'); process.exit(0); }

// ---- ② 先备份 ---------------------------------------------------------------
// 用**本地时间**做戳：ISOString 是 UTC，备份目录名会和"刚才几点"差 8 小时，
// 夜里排障时最容易把它当成"上一次的备份"。
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
  + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const bak = `${dataDir}.bak-${stamp}`;
try {
  cpSync(realDir, bak, { recursive: true, errorOnExist: true, force: false });
} catch (e) {
  die(`备份失败，未动库：${String(e.message).split('\n')[0]}`);
}
console.log(`已备份到：${bak}`);

// ---- ③ 一个号一个事务 -------------------------------------------------------
const { PGlite } = await import('@electric-sql/pglite');
const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
const db = await PGlite.create({ extensions: { btree_gist }, dataDir: realDir });
let failed = null;
try {
  for (const f of pick) {
    const sql = readFileSync(join(DB_DIR, f), 'utf8');
    try {
      await db.exec('BEGIN');
      await db.exec(sql);
      await db.exec('COMMIT');
      console.log(`  ✓ ${f}`);
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => {});
      failed = { f, msg: String(e.message).split('\n')[0] };
      break;
    }
  }
} finally {
  await db.close();
}

if (failed) {
  console.error(`\n✗ ${failed.f} 执行失败，已回滚：${failed.msg}`);
  console.error(`  库本身没变（事务回滚）；备份仍在 ${bak}，确认后可删。`);
  console.error('  ★ 不要"改一条再跑一次"——迁移文件是只读的；要么修好语句开新号，要么回滚这次前滚。');
  process.exit(1);
}

console.log(`\n✓ 应用完成：${pick.join(', ')}`);
console.log(`★ 下一步请对账确认：PGLITE_DATA_DIR=${dataDir} node tools/migrate-status.mjs`);
console.log('★ 退出码 0 只代表"没有反证"，不代表全对（指纹只覆盖少数几条）。');
