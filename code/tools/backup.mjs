// ============================================================================
// tools/backup.mjs · 备份：一份能核对的文件，不是一句"已经备过了"
// ----------------------------------------------------------------------------
// 落盘（PGLITE_DATA_DIR）解决的是"重启不丢"，**不是"删错了能回去"**。
// 卷坏了、迁移写错了、有人 UPDATE 了一整列 —— 这三种都不是重启问题。
//
// 所以备份要做三件事，缺一件就不算备份：
//   ① 产物：一个自包含的文件（PGlite 的 `dumpDataDir`，gzip）
//   ② 清单：这个文件里**应该有多少**（表数 / 关键表行数 / 迁移数 / sha256）
//   ③ 可核对：恢复之后拿清单去比，而不是"看起来能打开"
//
// ★ 备份时刻的一致性：`dumpDataDir` 在读的时候拍快照。写操作进行中的备份
//   在事务层面是一致的（PG 的 MVCC），但不包含"备份文件写完之后的写入"。
//   要严格一致请停服备份 —— 这句话必须写出来，不能只写"支持热备"。
//
// ★★ 但 PGlite 上"停不停服"不是性能问题，是**安全问题**：
//   数据库跑在 Node 进程里，第二个进程打开同一个 dataDir 不是排队，是互相覆盖
//   （docs/50 §2）。所以这里与 tools/migrate-status.mjs 用同一条判据 ——
//   谁开着这个目录的文件就拒绝谁（`assertNotInUse`）。
//   想对**运行中的库**做备份，两条路，都不在这份文件里：
//     · 物理一份：`node tools/backup-cron.mjs`（先停服，再 `cp -R` + 开副本核对）
//     · 逻辑一份：先 `cp -R` 出副本，再 `PGLITE_DATA_DIR=<副本> node tools/backup.mjs`
//
// 用法：
//   node tools/backup.mjs                      # 读 PGLITE_DATA_DIR，写 ./backups
//   node tools/backup.mjs --out /tmp/backups
//   PGLITE_DATA_DIR=./.data node tools/backup.mjs --out /backups
// ============================================================================
import { writeFileSync, mkdirSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve, sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

/** 清单里要核对的表：选"少一张就是丢了一类事实"的那些，不是全部 74 张 */
export const MANIFEST_TABLES = [
  'person', 'employment', 'attendance_daily_store', 'pay_run', 'payslip',
  'leave_request', 'headcount_budget', 'requisition', 'offer', 'approval_instance',
  'sys_session', 'sys_user_credential', 'exception_registry', 'app_request_log',
];

/** sha256：接受 Buffer / Uint8Array / ArrayBuffer（File/Blob 先取 arrayBuffer） */
export function sha256(data) {
  const buf = data instanceof Uint8Array ? Buffer.from(data)
    : data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data))
    : Buffer.from(data);
  return createHash('sha256').update(buf).digest('hex');
}

/** 采集一份清单（备份前与恢复后都用它，才能拿同一把尺子比） */
export async function collect(db) {
  const q = async (sql, p) => (await db.query(sql, p)).rows[0];

  const tables = (await q(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)).n;
  const migrations = (await q(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace nm ON nm.oid = p.pronamespace
      WHERE nm.nspname='public' AND p.proname LIKE 'fn\\_%'`)).n;

  const counts = {};
  for (const t of MANIFEST_TABLES) {
    // 表可能在某些部署里不存在（例如只装了一部分）——这本身就是信息，记成 null
    try { counts[t] = Number((await q(`SELECT count(*)::int n FROM ${t}`)).n); }
    catch { counts[t] = null; }
  }

  return {
    taken_at: new Date().toISOString(),
    engine: String((await q(`SHOW server_version`)).server_version),
    tables, business_functions: migrations,
    counts,
  };
}

/**
 * 读一个 PGlite 数据目录的 PG_VERSION（文件里就一行，例如 `18`）。
 * 返回 null = 这个目录不是 PGlite 数据目录。
 *
 * ★ 为什么要在开库**之前**先看这个文件：`PGlite.create({ dataDir })` 对
 *   不存在的目录会**新建**一个空库 —— 于是"备份一个写错的路径"会得手，
 *   代价是 (a) 在别人的目录旁边留下一坨垃圾，(b) 产出一份 11MB 的"备份"，
 *   出事那天打开才发现里面什么都没有。看一眼文件比事后看出来便宜得多。
 */
export function readPgVersion(dataDir) {
  if (!dataDir) return null;
  const f = join(dataDir, 'PG_VERSION');
  if (!existsSync(f)) return null;
  return readFileSync(f, 'utf8').trim();
}

function lsof(args) {
  try {
    return execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e.stdout) return e.stdout;                 // lsof 有输出时退出码仍可能非 0
    if (e.code === 'ENOENT') {
      throw new Error('E_NO_LSOF: 这台机器没有 lsof，无法确认库没有被占用；'
        + '宁可备不了，也不要在"猜没人用"的前提下打开一个独占目录');
    }
    return '';
  }
}

/**
 * 拒绝在"库正被服务打开"的时候做任何事。
 *
 * ★ 判据是"谁开着这个目录里的文件"，不是"8899 上有没有人"（与
 *   tools/migrate-status.mjs 同一条判据）：端口只是找到那个进程的线索。
 *   对**副本**做备份是最常用的场景，按端口一律拒绝会让工具在最有用的时候不可用；
 *   真正要防的是"PID x 正开着这个目录"，那用 lsof 的 open files 看得到。
 *
 * @returns {{listeningPids: string[], holders: string[]}}
 */
export function inspectInUse(dataDir, port = Number(process.env.PORT || 8899)) {
  const realDir = realpathSync(dataDir);
  const under = (p) => p === realDir || p.startsWith(realDir + sep);
  const listeningPids = lsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
    .split('\n')
    .filter((l) => l.trim() && !/^COMMAND/.test(l))
    .map((l) => l.trim().split(/\s+/)[1])
    .filter(Boolean);
  const holders = [];
  for (const p of new Set(listeningPids)) {
    const paths = lsof(['-p', String(p), '-Fn'])
      .split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
    if (paths.some(under)) holders.push(p);
  }
  return { listeningPids, holders };
}

export function assertNotInUse(dataDir, port = Number(process.env.PORT || 8899)) {
  const { listeningPids, holders } = inspectInUse(dataDir, port);
  if (holders.length) {
    throw new Error(`E_DB_IN_USE: 库正被服务占用（PID ${holders.join(', ')}，端口 ${port}）。`
      + 'PGlite 单进程独占，运行中打开会与服务互相覆盖 —— 要么先停服务，要么对副本备份');
  }
  return { listeningPids, holders };
}

/** 备份：写一个 .tar.gz + 一个同名 .json 清单 */
export async function backup({ dataDir, outDir, port = Number(process.env.PORT || 8899) }) {
  // ① 先验目录，再开库（顺序不能反，理由见 readPgVersion 的注释）
  let pgVersion = null;
  if (dataDir) {
    pgVersion = readPgVersion(dataDir);
    if (!pgVersion) {
      throw new Error(`E_BACKUP_NOT_PGLITE: ${dataDir} 下没有 PG_VERSION，`
        + '不是 PGlite 数据目录（写错路径会给一个空库备份成功）');
    }
    // ② 再确认没人开着它：热备一份"正在被写"的目录不是备份，是赌运气
    assertNotInUse(dataDir, port);
  }

  const db = await PGlite.create({ extensions: { btree_gist }, dataDir: dataDir || undefined });
  let dump;
  try {
    // 清单必须在 dump **之前**读：先 dump 后读清单的话，
    // 清单里会包含"dump 之后才写进来的行"，恢复后对不上 —— 而那种对不上
    // 看起来像"备份坏了"，实际是清单的时刻取错了。
    const manifest = await collect(db);

    // ★ 空库不算备份成功。没设 PGLITE_DATA_DIR（或指错了目录）时，
    //   PGlite 会安静地创建一个空库：备份"成功"、文件有 4MB、清单全 null。
    //   这种"成功"比失败更贵 —— 出事那天才会发现备的是空库。
    if (manifest.tables < 10) {
      throw new Error(
        `E_BACKUP_EMPTY: 这个库里只有 ${manifest.tables} 张表，看起来是空库或被指错了目录`
        + `（PGLITE_DATA_DIR=${dataDir || '(未设置)'}）`);
    }

    dump = await db.dumpDataDir('gzip');
    const buf = Buffer.from(await dump.arrayBuffer());   // File → 字节，之后一律用字节
    const digest = sha256(buf);

    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const base = join(resolve(outDir), `aihr-${stamp}`);
    writeFileSync(`${base}.tar.gz`, buf);
    writeFileSync(`${base}.json`, JSON.stringify({
      ...manifest,
      data_dir: dataDir ? resolve(dataDir) : null,
      pg_version: pgVersion,
      file: `${stamp}.tar.gz`,
      sha256: digest,
      bytes: dump.size,
    }, null, 2));
    return { file: `${base}.tar.gz`, manifest: `${base}.json`, sha256: digest, bytes: dump.size, counts: manifest.counts };
  } finally {
    await db.close();
  }
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > -1 ? process.argv[i + 1] : d;
  };
  const outDir = arg('out', 'backups');
  let r;
  try {
    r = await backup({ dataDir: process.env.PGLITE_DATA_DIR, outDir });
  } catch (e) {
    console.error(String(e.message).split('\n')[0]);
    process.exit(1);
  }
  console.log(`备份完成：${r.file}`);
  console.log(`  清单：${r.manifest}`);
  console.log(`  来源：${process.env.PGLITE_DATA_DIR || '(内存库，没有 dataDir)'}`);
  console.log(`  大小：${(r.bytes / 1024 / 1024).toFixed(1)} MB · sha256 ${r.sha256.slice(0, 12)}…`);
  console.log(`  关键表行数：${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log('  注意：dumpDataDir 是快照语义，不包含备份完成之后的写入；要严格一致请停服备份。');
}
