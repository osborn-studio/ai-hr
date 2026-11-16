// ============================================================================
// tools/migrate-status.mjs · 迁移对账（**只读，绝不应用迁移**）
// ----------------------------------------------------------------------------
// 它回答一个问题，而且只回答这一个：
//
//   「这个库里，哪些迁移能确认已经生效，哪些无法判定？」
//
// 背景：app/server.mjs 的 createApp() 只在**空库**上跑 db/ 下全部迁移，
// 判断"空库"靠的是"有没有 sys_perm_dim 这张表"。于是用 PGlite 数据目录跑起来的
// 存量库**重启拿不到任何新迁移** —— 今晚因此咬了三次（174 / 178 / 179），
// 每一次的表现都是"代码没生效"，不是"迁移没跑"。
//
// ★ 为什么是"对账"而不是"补齐"
//   自动前滚需要一个可信的账本，而这个库**从来没有 schema_migration**
//   （tools/migrate.mjs 只服务 DATABASE_URL）。在没有账本的前提下猜"跑到哪一版"，
//   猜错就把一个旧库永久钉成最新 —— 那比没有账本更危险：没有账本时人还会怀疑。
//   所以这里只给证据，不替人做决定。要前滚，先有人看过这份输出。
//
// ★ 为什么用指纹而不是"跑一遍看报不报错"
//   迁移只读（已发布的一个字节都不能改），重跑不能作为探针；而且大量迁移是
//   CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE，重跑**不报错**等于什么都没测到。
//   指纹反过来：它问"这条迁移一定留下的那个痕迹，现在还在不在"。
//   痕迹在 → 有迹象；痕迹不在 → 反证（这条肯定没生效，或生效后被别的迁移改回去了，
//   两种都要人看）。
//
// ★ 指纹只覆盖少数几条，其余**故意**输出"无法判定"
//   给 180 个迁移逐个写指纹要先读懂 180 份迁移的语义，写错的指纹比没有指纹更危险。
//   "无法判定"是诚实的答案，不是待办。
//
// ★★ 这份输出本身也要能被反证（否则它就成了新的"看起来验过了"）
//   ① 抽一条手工验：拿 `179` 举例，工具报"有迹象"之后，自己再跑一次
//      `SELECT position('force_custom_plan' in prosrc) > 0 FROM pg_proc WHERE proname='app_init_session'`，
//      两个结果必须一致。**工具的结论不能取代那条 SQL。**
//   ② 退出码 0 **不等于全对**：它只说明"没有反证"，不说明"每条都生效" ——
//      175 条"无法判定"里任何一条都可能没跑过，而工具看不见。
//   ③ 想知道工具是不是永远报绿：把某条指纹改成必然为假再跑一次，它必须变"无迹象"。
//      （已在 v5 副本上用 178 做过一次：换成旧口径后 178 那一行转红、退出码 1。）
//
// 用法：
//   PGLITE_DATA_DIR=/path/to/data node tools/migrate-status.mjs
//   PGLITE_DATA_DIR=/path/to/data node tools/migrate-status.mjs --json
//
// 退出码：
//   0  没有反证（全部"有迹象"或"无法判定"）—— **不等于全对**
//   1  出现"无迹象"（有迁移被证伪）
//   2  无法对账（服务占着库 / 目录不存在 / 打不开 / lsof 不可用）
// ============================================================================
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', 'db');
const FP_FILE = join(DB_DIR, 'migration_fingerprints.json');

// 服务占着的端口。写成常量而不是参数：这个仓只有一个默认端口（server.mjs），
// 参数化只会让"忘了传"变成"对着线上库硬开一份副本"。
// 端口可用 PORT 覆盖（本机 8788/8899 之争的教训：写死的端口会在别的服务占了之后
// 变成"工具永远说库被占用"，而那种报错看起来像库坏了）。
const SERVICE_PORT = process.env.PORT || '8899';

const asJson = process.argv.includes('--json');

const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

const dataDir = process.env.PGLITE_DATA_DIR;
if (!dataDir) die('必须给 PGLITE_DATA_DIR（这个工具只针对 PGlite 数据目录；真 PG 用 tools/migrate.mjs）');
if (!existsSync(dataDir)) {
  // ★ 不能"顺手建一个空目录再打开"：PGlite 会把它初始化成一个空库，
  //   然后对账对着一个不存在的库跑 —— 一个拼错的路径会被读成"什么都没生效"。
  die(`数据目录不存在：${dataDir}`);
}

// ---------------------------------------------------------------------------
// 1. 先确认没有服务在用**这个库**
// ---------------------------------------------------------------------------
// PGlite 是**单进程独占**的（数据库就跑在进程里，没有服务端来做并发控制）。
// 两个进程同时打开一个 data 目录不是"排队"，是互相覆盖。所以这里不抢锁、
// 不等锁、不重试：占着就退出，让人先停服务。
//
// ★ 判据是"谁开着这个目录的文件"，不是"8899 上有人"：
//   端口只是找到那个进程的线索。服务跑在 /tmp/A、我要对账 /tmp/B（副本）时，
//   按端口一律拒绝会让这个工具在最有用的场景下无法使用 —— 而它本来就
//   只读，碰不到 A。反过来，真正要防的是"PID x 正开着 B 里的文件"，
//   这一条用 lsof 的 open files 直接看得到（PGlite 会把数据文件一直开着）。
function lsof(args) {
  try {
    return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // lsof 有输出时退出码仍可能非 0；没有输出才是"查不到"。
    if (e.stdout) return e.stdout;
    if (e.code === 'ENOENT') {
      // ★ 查不到 ≠ 没占用。宁可不对账，也不能用"我猜没人用"去开一个独占目录。
      die('无法检测数据目录的占用情况（没有 lsof）。为免与正在运行的服务撞上同一个库，拒绝继续。');
    }
    return '';
  }
}

const realDir = realpathSync(dataDir);
const under = (p) => p === realDir || p.startsWith(realDir + sep);

// 8899 上监听的进程（通常 0 或 1 个）
const listeningPids = lsof(['-nP', `-iTCP:${SERVICE_PORT}`, '-sTCP:LISTEN'])
  .split('\n')
  .filter((l) => l.trim() && !/^COMMAND/.test(l))
  .map((l) => l.trim().split(/\s+/)[1])   // COMMAND PID USER FD …
  .filter(Boolean);

// 谁开着这个目录下的文件（做了全机扫描也不准：别的进程可能用另一个入口打开，
// 而 lsof +D 要 root 且很慢。所以只问"监听 8899 的那个进程"—— 本仓只有它）。
const holders = [];
for (const p of new Set(listeningPids)) {
  const paths = lsof(['-p', String(p), '-Fn'])
    .split('\n')
    .filter((l) => l.startsWith('n/'))
    .map((l) => l.slice(1));
  if (paths.some(under)) holders.push(p);
}

if (holders.length) {
  die(`库里正在被服务占用（PID ${holders.join(', ')}，端口 ${SERVICE_PORT}），请先停服务再对账。\n`
    + `  它开着 ${realDir} 里的文件。PGlite 单进程独占：强行打开会与服务互相覆盖数据，这里不抢锁。`);
}
if (listeningPids.length) {
  // 走 stderr：--json 时 stdout 必须是纯净的 JSON。
  console.error(`· 端口 ${SERVICE_PORT} 上有服务（PID ${listeningPids.join(', ')}），但它没有打开 ${realDir}；继续。`);
}

// ---------------------------------------------------------------------------
// 2. 读指纹表与迁移清单
// ---------------------------------------------------------------------------
const fingerprints = JSON.parse(readFileSync(FP_FILE, 'utf8'));
const migrations = readdirSync(DB_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();

// ---------------------------------------------------------------------------
// 3. 打开库，**在一个只读事务里**跑全部探针
// ---------------------------------------------------------------------------
// PGlite 的打开本身就会写（WAL 恢复、目录元数据），这一点无法从外部关掉；
// 但"我这条语句不会改库"可以用 PG 自己来保证：事务标了 READ ONLY 之后，
// 任何写语句都会直接报 25006，而不是靠"我记得没写 INSERT"。
// 这层保险是给下一个改这个文件的人留的 —— 包括我。
const { PGlite } = await import('@electric-sql/pglite');
let db;
try {
  // 不加载任何 extension：加载 CREATE EXTENSION 就是写库。
  db = await PGlite.create({ dataDir });
} catch (e) {
  die(`打不开这个数据目录：${String(e.message).split('\n')[0]}`);
}

const PROBE = '有迹象';
const NOPE = '无迹象';
const UNKNOWN = '无法判定';
const results = [];

try {
  await db.exec('BEGIN TRANSACTION READ ONLY');

  // ★ 先确认这确实是一个建过库的目录。PGlite.create 会**把一个空目录初始化成空库**，
  //   于是"路径写错到了一个空目录"会得到 180 条"无法判定"、退出码 0 —— 一个假绿。
  //   判据沿用 server.mjs 判断"空库"用的那张表（sys_perm_dim 由 001 建），
  //   同一个概念在仓里只该有一个定义。
  const built = Number((await db.query(
    `SELECT count(*)::int n FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'sys_perm_dim'`)).rows[0].n) > 0;
  if (!built) {
    await db.exec('ROLLBACK');
    die(`这个目录里没有建过库（没有 sys_perm_dim 表，也没有业务表）。\n`
      + '  180 条全是"无法判定"不等于"都没生效" —— 这里根本无库可对。是不是 PGLITE_DATA_DIR 写错了？');
  }
  for (const file of migrations) {
    const num = file.slice(0, 3);
    const fp = fingerprints[num];
    if (!fp || typeof fp.sql !== 'string') {
      // 没有指纹 → 无法判定。不是"没生效"，是"这个工具不知道该怎么看"。
      results.push({ 迁移号: num, 文件: file, 结论: UNKNOWN, 判据: '无指纹（该迁移没有登记可探测的痕迹）' });
      continue;
    }
    let 结论;
    let detail = fp.判据;
    try {
      const r = await db.query(fp.sql);
      if (r.rows.length === 0) {
        // 指纹查的是"某函数/某行的正文"，对象不存在时是一条 0 行 ——
        // 对这几条迁移来说，对象不存在本身就是反证（它们探的都是 001/022 就建好的东西）。
        结论 = NOPE;
        detail += '（探测对象不存在）';
      } else if (r.rows.length > 1) {
        // 重载或跨 schema 同名：说明指纹写得不够窄，不能拿任何一行代表结论。
        结论 = UNKNOWN;
        detail += `（探针返回 ${r.rows.length} 行，判据不唯一）`;
      } else {
        const v = Object.values(r.rows[0])[0];
        if (typeof v === 'boolean') 结论 = v ? PROBE : NOPE;
        else {
          结论 = UNKNOWN;
          detail += `（探针没返回 boolean，而是 ${JSON.stringify(v)}）`;
        }
      }
    } catch (e) {
      // 探针自己报错（表不存在、权限不足）说明不了迁移有没有生效 —— 只能说不确定。
      // ★ 这里故意不降级成"无迹象"：把"我看不清"说成"它没生效"，
      //   下次就没人信"无迹象"这三个字了。
      结论 = UNKNOWN;
      detail += `（探针报错：${String(e.message).split('\n')[0]}）`;
    }
    results.push({ 迁移号: num, 文件: file, 结论, 判据: detail });
  }
  await db.exec('ROLLBACK');
} finally {
  await db.close();
}

// ---------------------------------------------------------------------------
// 4. 输出
// ---------------------------------------------------------------------------
const nOk = results.filter((r) => r.结论 === PROBE).length;
const nBad = results.filter((r) => r.结论 === NOPE).length;
const nUnk = results.filter((r) => r.结论 === UNKNOWN).length;
const code = nBad > 0 ? 1 : 0;

if (asJson) {
  console.log(JSON.stringify({
    dataDir,
    checkedAt: new Date().toISOString(),
    migrations: results,
    summary: { 有迹象: nOk, 无迹象: nBad, 无法判定: nUnk },
    exitCode: code,
  }, null, 2));
} else {
  console.log(`库：${dataDir}（${migrations.length} 个迁移，只读对账）`);
  console.log('');
  for (const r of results) {
    // 用 | 分隔而不是对齐列：中文在终端里不是等宽，padEnd 反而更乱。
    console.log(`${r.迁移号} | ${r.结论} | ${r.判据}`);
  }
  console.log('');
  console.log(`可确认生效 ${nOk} 条 / 无迹象 ${nBad} 条 / 无法判定 ${nUnk} 条`);
  if (nBad > 0) {
    console.log('');
    console.log('⚠ 有迁移被证伪：这些痕迹不在库里，说明它们没生效'
      + '（或生效后被后续迁移改回去了）。两种都要人看，不要自动重跑。');
  }
  if (nUnk > 0) {
    console.log(`注：${nUnk} 条「无法判定」= 这个工具没有对应指纹，不是"没生效"。`);
  }
  console.log('注：退出码 0 只表示没有反证，不表示全部生效。');
}

process.exit(code);
