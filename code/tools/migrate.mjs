// ============================================================================
// tools/migrate.mjs · 增量迁移（schema_migration 账本）
// ----------------------------------------------------------------------------
// 到 073 为止，迁移只有两种跑法：空库全跑（new-ledger）或"人肉记住跑到哪"。
// 后者必然出问题 —— 而它的表现是 `column does not exist`，看起来像代码写错。
//
// 这个脚本补上那张一直缺的表：schema_migration(file, sha256, applied_at)。
//
//   DATABASE_URL=... node tools/migrate.mjs            # 跑到最新
//   DATABASE_URL=... node tools/migrate.mjs --dry-run   # 只说要跑哪些
//
// ★ 对一个"已经有表但没有账本"的老库（本轮之前建的），它不假装从零开始：
//   把 001..070 标成 legacy（applied_at 用建表时间附近），只跑之后的。
//   这个判断写在这里而不是"猜"，因为跑错一遍 CREATE TABLE 会直接炸在第一个迁移上。
// ============================================================================
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../app/db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', 'db');
const dryRun = process.argv.includes('--dry-run');
// --adopt：把"报已存在"的迁移当作**已应用**（账本后加的老库要用它）。
// ★ 必须显式开：默认把 duplicate 当成功，会把"迁移只跑了一半"这种错盖掉。
const adopt = process.argv.includes('--adopt');
// 账本出现之前的那一批（新建这个仓库时的迁移集合）
// aihr_demo 这个库是同步脚本在空库上跑完全部迁移建的（那时已经有 072），
// 而账本是现在才加的 —— 所以 legacy 截到 072。
const LEGACY_UP_TO = '072';

const url = process.env.DATABASE_URL;
if (!url) { console.error('必须给 DATABASE_URL'); process.exit(2); }

const db = await createDb({ url });
await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');

const files = readdirSync(DB_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
const sha = (f) => createHash('sha256').update(readFileSync(join(DB_DIR, f))).digest('hex');

await db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migration (
    file       varchar(128) PRIMARY KEY,
    sha256     char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    note       varchar(200)
  )`);

const done = new Map((await db.query('SELECT file, sha256 FROM schema_migration')).rows.map((r) => [r.file, r.sha256.trim()]));

// 老库（有表、没账本）：把 legacy 批次记为已应用，不重跑
if (done.size === 0) {
  const hasTables = Number((await db.query(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n) > 0;
  if (hasTables) {
    const legacy = files.filter((f) => f <= LEGACY_UP_TO + '_zzz');
    if (!dryRun) {
      for (const f of legacy) {
        await db.query(
          `INSERT INTO schema_migration(file, sha256, note) VALUES ($1,$2,'legacy：账本建立前已应用')
           ON CONFLICT (file) DO NOTHING`, [f, sha(f)]);
      }
    }
    console.log(`· 老库：把 ${legacy.length} 个迁移标为 legacy（不重跑）`);
    for (const f of legacy) done.set(f, sha(f));
  }
}

let applied = 0, skipped = 0, changed = 0;
for (const f of files) {
  const h = sha(f);
  if (done.has(f)) {
    if (done.get(f) !== h) {
      // ★ 已应用的迁移被改过：**不重跑**（重跑会改结构，而结构已经带着数据），
      //   但要说出来 —— 否则"文件里的 schema"与"库里的 schema"从此不一致，
      //   而下一个接手的人会按文件去理解库。
      console.log(`! ${f}：文件已变更（库里的哈希不同）。不重跑；如确需变更请新增迁移。`);
      changed += 1;
    } else skipped += 1;
    continue;
  }
  if (dryRun) { console.log(`+ ${f}（待应用）`); applied += 1; continue; }
  try {
    await db.exec(readFileSync(join(DB_DIR, f), 'utf8'));
    await db.query('INSERT INTO schema_migration(file, sha256) VALUES ($1,$2)', [f, h]);
    console.log(`+ ${f}`);
    applied += 1;
  } catch (e) {
    const dup = ['42P07', '42710', '42P16', '23505'].includes(e.code)
      || /already exists/i.test(String(e.message));
    if (adopt && dup) {
      await db.query(
        `INSERT INTO schema_migration(file, sha256, note) VALUES ($1,$2,'adopt：对象已存在，判为已应用')
         ON CONFLICT (file) DO NOTHING`, [f, h]);
      console.log(`~ ${f}（已存在，adopt 记账）`);
      applied += 1;
      continue;
    }
    console.error(`\n✗ ${f} 失败：${String(e.message).split('\n')[0]}`);
    console.error('  已应用的迁移不回滚（它们已经提交），修好这一条再跑一次即可续上。');
    process.exit(1);
  }
}

console.log(`\n迁移：应用 ${applied} · 跳过 ${skipped}${changed ? ` · 文件变更 ${changed}` : ''}`
  + (dryRun ? '（dry-run，未写库）' : ''));
await db.close();
process.exit(0);
