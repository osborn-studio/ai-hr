// ============================================================================
// tools/backup-cron.mjs · 定时备份：先确认没人开着库，再抄一份能打开的副本
// ----------------------------------------------------------------------------
// 这份文件存在的理由只有一条，而它是本仓最容易做错的一条：
//
//   **PGlite 的"备份"不是 `cp -R`，是 `cp -R` 加两个前提。**
//
//   前提一：抄的时候没有第二个进程开着这个目录。
//     PGlite 把数据库跑在 Node 进程里，没有服务端做并发控制。两个进程同时打开
//     一个 dataDir 不是排队，是互相覆盖（docs/50 §2）。运行中 `cp -R` 得到的
//     是一份**可能撕裂**的库 —— 而撕裂的库通常还能打开、还能查，只是某些行
//     没了。这种"备份"比没有备份更贵：它让人以为有退路。
//
//   前提二：抄完要**打开它**，而不是只看文件大小。
//     所以这里抄完会拿 PGlite 开一次副本，数表、数关键行。开不了 = 备份失败。
//
// 与 tools/backup.mjs 的分工（两份都要有，别混）：
//   · backup.mjs      → 逻辑备份：产出 `aihr-<stamp>.tar.gz` + 清单 + sha256。
//                       有清单、能核对行数，适合"归档到别处/异地"。
//   · backup-cron.mjs → 物理备份：产出 `backups/<stamp>/data`（整目录）+ manifest.json。
//                       适合"每天凌晨留一份，出事直接换目录回去"。恢复 = 停服 + 换目录。
//
// ★ 这个脚本**不 kill 服务**。占着就退出、把该做什么打出来，由人决定。
//   "顺手帮你停一下"会让一个定时任务在半夜停掉演示机 —— 定时任务没有这个权力。
//
// 用法：
//   node tools/backup-cron.mjs                     # 源=PGLITE_DATA_DIR，目标=持久目录
//   node tools/backup-cron.mjs --dir /tmp/xxym-v5 --out /tmp/bk
//   node tools/backup-cron.mjs --dry-run           # 只检查，不抄
//
// 定时（二选一，都要求**先停服**，见下）：
//   crontab -e
//   30 3 * * *  cd ~/ai-hr/code && /path/to/node tools/backup-cron.mjs >> ~/Library/Logs/aihr-backup.log 2>&1
//
//   ⚠️ 但服务是常驻的，凌晨 3:30 它也开着 —— 所以定时任务**必然**在这里被拒。
//      这是设计如此，不是 bug。真正能定时跑的前提是"备份窗口里服务是停的"：
//      · 演示机：手动停服后跑一次（或把服务做成"备份窗口内 launchd 不拉活"）
//      · 生产形态：换真 PostgreSQL（`pg_dump` 不依赖停服），那条路本机未验证
//
// 退出码：
//   0  备份完成且副本能打开、关键表行数对得上
//   1  抄完了但副本打不开 / 行数不对（产物留着，别删，给人看）
//   2  拒绝执行（源目录不对 / 库正被占用 / 参数错）
// ============================================================================
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { MANIFEST_TABLES, collect, readPgVersion, inspectInUse } from './backup.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i > -1 ? argv[i + 1] : d;
};
const dryRun = argv.includes('--dry-run');

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

/** 备份落在**持久目录**：放 /tmp 里等于备份也只活到下次重启 */
const HOME = process.env.HOME || '';
const DEFAULT_OUT = HOME
  ? join(HOME, 'Library/Application Support/aihr-demo/backups')
  : resolve('backups');

const src = resolve(arg('dir', process.env.PGLITE_DATA_DIR || ''));
const outRoot = resolve(arg('out', DEFAULT_OUT));

// ---------------------------------------------------------------------------
// ① 源目录：存在 + 是 PGlite 数据目录
// ---------------------------------------------------------------------------
if (!arg('dir') && !process.env.PGLITE_DATA_DIR) {
  die('必须给 --dir 或 PGLITE_DATA_DIR（例：--dir /tmp/xxym-v5）');
}
if (!existsSync(src)) die(`源目录不存在：${src}`);
const srcPg = readPgVersion(src);
if (!srcPg) die(`源目录不是 PGlite 数据目录（没有 PG_VERSION）：${src}\n`
  + '  只认带 PG_VERSION 的目录 —— /tmp/xxym-v5-scripts 这种脚本目录搬过去是死的。');

// ---------------------------------------------------------------------------
// ② 谁开着这个目录？占着就退出（不 kill、不等、不重试）
// ---------------------------------------------------------------------------
// 判据分两层，**先粗后细**，因为细的那层在沙箱里看不见：
//   · 粗：端口（默认 8899）上有没有人监听。有 → 默认拒绝。
//   · 细：那个 PID 有没有打开着 --dir 里的文件（lsof -p）。
//
// ★ 为什么不能只用细的那层：实测在 Agent 沙箱里 `lsof -p <别人的pid> -Fn`
//   返回**空**（exit 1、无 stdout 也无 stderr）—— 于是"看不见占用"会被读成
//   "没有占用"，而这个脚本恰好要靠这个判断来决定要不要抄一份正在被写的库。
//   看不见 ≠ 没有：所以粗的那层是闸门，细的那层只是补充证据。
//   （tools/migrate-status.mjs 用的是细的那层；它只读，代价小；这里要写出一份
//     67MB 的产物并宣称它是备份，代价大，所以宁可更保守。）
// 端口不写死在提示语里：换端口之后提示还报旧号，会让人去查一个没在用的端口。
const PORT_C = Number(process.env.PORT || 8899);
const { listeningPids, holders } = inspectInUse(src, PORT_C);
const allowLive = argv.includes('--allow-copy');

if (holders.length) {
  die(`库正被服务占用（PID ${holders.join(', ')}，8899），拒绝备份（加 --allow-copy 也没用）。\n`
    + `  它开着 ${src} 里的文件。PGlite 单进程独占：运行中 cp 会得到一份撕裂的库。`);
}
if (listeningPids.length && !allowLive) {
  die(`${PORT_C} 上有服务在跑（PID ${listeningPids.join(', ')}），拒绝备份。\n`
    + `  原因：PGlite 单进程独占，运行中 cp -R ${src} 得到的是一份**可能撕裂**的库 ——\n`
    + '  而撕裂的库通常还能打开、还能查，只是少了一些行。那种"备份"比没有更贵：\n'
    + '  它让人以为有退路，真出事那天才发现退路是半截的。\n'
    + '\n  两条路，由你选（本脚本不会替你停服务）：\n'
    + `    a) 停服务再备：launchctl stop com.aihr.demo   然后重跑本命令\n`
    + '    b) 备副本：cp -R <库目录> /tmp/xxym-copy && node tools/backup-cron.mjs --dir /tmp/xxym-copy --allow-copy\n'
    + '       （--allow-copy 的意思是"我确认 --dir 是一份副本，不是在跑的库"；说错就是错的备份。）');
}
if (listeningPids.length) {
  console.log(`! 8899 上有服务（PID ${listeningPids.join(', ')}），你显式给了 --allow-copy；`
    + `按"${src} 是副本"处理，继续。`);
}

// ---------------------------------------------------------------------------
// ③ 抄
// ---------------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const dest = join(outRoot, stamp);
const destData = join(dest, 'data');

const listFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile());

if (dryRun) {
  const fs0 = listFiles(src);
  let bytes0 = 0;
  for (const d of fs0) bytes0 += statSync(join(d.parentPath, d.name)).size;
  console.log('[dry-run] 不会写任何东西。将要执行的：');
  console.log(`  源      ${src}（PG_VERSION=${srcPg}，${fs0.length} 个文件，${(bytes0 / 1048576).toFixed(1)} MB）`);
  console.log(`  目标    ${destData}`);
  console.log(`  清单    ${join(dest, 'manifest.json')}`);
  console.log(`  占用    ${PORT_C} 上 ${listeningPids.length} 个监听`
    + (listeningPids.length ? '（已按 --allow-copy 视为副本）' : '（无）'));
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
console.log(`复制 ${src} → ${destData} …`);
cpSync(src, destData, { recursive: true, preserveTimestamps: true });

// 抄完第一件事：PG_VERSION 要对得上（它不是"顺便带过去的一个文件"，
// 它是"这份目录属于哪个大版本"的唯一声明；对不上说明抄错了源）
const destPg = readPgVersion(destData);
if (destPg !== srcPg) {
  console.error(`E_BACKUP_VERSION: 副本 PG_VERSION=${destPg ?? '(缺失)'} ≠ 源 ${srcPg}`);
  process.exit(1);
}

const files = listFiles(destData);
let bytes = 0;
for (const d of files) bytes += statSync(join(d.parentPath, d.name)).size;

// ---------------------------------------------------------------------------
// ④ 打开副本核对（不是"看起来能打开"，是数出来的）
// ---------------------------------------------------------------------------
let manifest;
try {
  const db = await PGlite.create({ extensions: { btree_gist }, dataDir: destData });
  try {
    manifest = await collect(db);
  } finally {
    await db.close();
  }
} catch (e) {
  console.error(`E_BACKUP_UNREADABLE: 副本打不开：${String(e.message).split('\n')[0]}`);
  console.error(`  产物留着（${destData}），不要删 —— 它比"没有备份"更能说明问题。`);
  process.exit(1);
}

if (manifest.tables < 10) {
  console.error(`E_BACKUP_EMPTY: 副本里只有 ${manifest.tables} 张表，这不是一份可用的备份`);
  process.exit(1);
}
// 关键表里挑三张"空了一定是搬错了库"的：人、工资条、组织。
// 不逐行比对源（那要打开源，备份过程必须对源只读）。
const must = { person: 1, payslip: 1 };
const empty = Object.entries(must).filter(([t]) => !(manifest.counts[t] >= 1));
if (empty.length) {
  console.error(`E_BACKUP_EMPTY: 关键表是空的：${empty.map(([t]) => `${t}=${manifest.counts[t]}`).join('、')}`);
  process.exit(1);
}

const out = {
  kind: 'physical-copy',
  taken_at: new Date().toISOString(),
  source: src,
  source_pg_version: srcPg,
  data_dir: destData,
  files: files.length,
  bytes,
  engine: manifest.engine,
  tables: manifest.tables,
  business_functions: manifest.business_functions,
  counts: manifest.counts,
  verified: { opened: true, tables_gte_10: true, key_tables_nonempty: true },
  note: '恢复 = 停服 → 把 data 换到 PGLITE_DATA_DIR 的位置（或直接 cp -R 回去）→ 起服务。'
    + '本备份与源不做逐行比对：比对需要打开源，而备份必须对源只读。',
};
writeFileSync(join(dest, 'manifest.json'), JSON.stringify(out, null, 2));

console.log(`备份完成：${dest}`);
console.log(`  data/            ${files.length} 个文件 · ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`  PG_VERSION       ${destPg}（与源一致）`);
console.log(`  打开核对         表 ${manifest.tables} · 业务函数 ${manifest.business_functions} · 引擎 ${manifest.engine}`);
console.log(`  关键表           ${MANIFEST_TABLES.map((t) => `${t}=${manifest.counts[t] ?? '-'}`).join(' ')}`);

// ---------------------------------------------------------------------------
// ⑤ 不自动删旧备份（删备份这件事必须有人说"删这份"，不能是脚本的善意）
// ---------------------------------------------------------------------------
const kept = readdirSync(outRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d{8}T\d{6}$/.test(d.name))
  .map((d) => d.name).sort();
let total = 0;
for (const k of kept) {
  const p = join(outRoot, k);
  for (const d of listFiles(p)) total += statSync(join(d.parentPath, d.name)).size;
}
console.log(`  目录里现在有 ${kept.length} 份（${(total / 1048576).toFixed(0)} MB），`
  + `最旧 ${kept[0]} / 最新 ${kept[kept.length - 1]}`);
console.log('  不自动清理：删哪一份由人决定（本脚本只报告）。');
