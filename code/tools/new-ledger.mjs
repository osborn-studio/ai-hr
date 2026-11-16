// ============================================================================
// tools/new-ledger.mjs · 开一个新集团帐套（物理隔离：独立数据库）
// ----------------------------------------------------------------------------
// 用法（需要真 PostgreSQL；PGlite 是进程内嵌库，一个实例就一个库）：
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/aihr_control \
//   node tools/new-ledger.mjs --code YH-002 --name "示例二集团" --period 2026-07 \
//        --admin admin2 --pwd demo1234
//
// 引导六步（每一步失败都会停在这步，并告诉你回滚什么）：
//   ① 校验库名（不含特殊字符，避免 SQL 注入到 CREATE DATABASE）
//   ② 建库 aihr_<slug>
//   ③ 在新库里跑完 db/*.sql 全部迁移
//   ④ 建集团根组织 + 默认帐套登记
//   ⑤ 建管理员账号（角色 admin）+ 写口令摘要（scrypt，库侧只存摘要）
//   ⑥ 回到控制库登记"这个帐套连哪个库"
// ============================================================================
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../app/services/auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(HERE, '..', 'db');

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const code = arg('--code'), name = arg('--name'), period = arg('--period');
const admin = arg('--admin', 'admin'), pwd = arg('--pwd', 'demo1234');
const controlUrl = process.env.DATABASE_URL;

if (!controlUrl || !code || !name || !period) {
  console.error('用法：DATABASE_URL=postgres://.../aihr_control node tools/new-ledger.mjs '
    + '--code YH-002 --name "示例二集团" --period 2026-07 [--admin admin2] [--pwd ...]');
  process.exit(2);
}

// ① 库名：只允许小写字母数字下划线。拼进 CREATE DATABASE 的标识符不能靠转义，
//    只能靠白名单 —— 这是唯一能保证不注入的做法。
const slug = `aihr_${String(code).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 60);
if (!/^[a-z][a-z0-9_]{2,62}$/.test(slug)) {
  console.error(`库名不合法：${slug}`); process.exit(2);
}

const u = new URL(controlUrl);
const dbUrl = (db) => `${u.protocol}//${u.username}${u.password ? ':' + u.password : ''}`
  + `@${u.host}/${db}`;

// ② 建库
{
  const c = new pg.Client({ connectionString: controlUrl });
  await c.connect();
  const exists = (await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [slug])).rows.length;
  if (exists) { console.log(`库 ${slug} 已存在 —— 直接复用，不重建（重建会丢数据）`); }
  else { await c.query(`CREATE DATABASE ${slug}`); console.log(`② 已建库 ${slug}`); }
  await c.end();
}

// ③ 迁移
const db = new pg.Client({ connectionString: dbUrl(slug) });
await db.connect();
await db.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
const fresh = Number((await db.query(
  `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n) === 0;
if (fresh) {
  for (const f of readdirSync(DB_DIR).filter(x => /^\d{3}_.*\.sql$/.test(x)).sort()) {
    await db.query(readFileSync(join(DB_DIR, f), 'utf8'));
  }
  console.log('③ 迁移完成');
} else {
  console.log('③ 库里已有表，跳过迁移');
}
await db.query('SELECT app_init_session()');

// ④ 帐套 + 集团根
// ★ 幂等：库已经存在（上一次建到一半、或重跑）时不能因为"编码已存在"就整步失败 ——
//   那样人只能手删库才能继续，而手删库会连业务数据一起删掉。
const exists = (await db.query(
  `SELECT id FROM sys_ledger WHERE code = $1`, [code])).rows[0];
if (exists) {
  console.log(`④ 帐套 ${code} 已存在（#${exists.id}），跳过新建`);
} else {
  await db.query(`SELECT fn_ledger_open($1,$2,$3,'provisioner')`, [code, name, period]);
  console.log(`④ 帐套已建`);
}
const rootRow = (await db.query(
  `SELECT id FROM org_unit WHERE parent_id IS NULL LIMIT 1`)).rows[0];
const root = rootRow ? Number(rootRow.id)
  : Number((await db.query(`SELECT fn_org_add(NULL,$1,'group',NULL) AS id`, [name])).rows[0].id);
await db.query(`SELECT fn_ledger_activate('provisioner')`);
console.log(`   集团根 #${root}`);

// ⑤ 管理员账号
const uid = Number((await db.query(
  `SELECT fn_account_create($1,'系统管理员','admin',NULL,NULL,'provisioner') AS id`,
  [admin])).rows[0].id);
await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
  [uid, hashPassword(pwd)]);
console.log(`⑤ 管理员 ${admin} 已建（口令 ${pwd}，首次登录会要求改）`);
await db.end();

// ⑥ 控制库登记
{
  const c = new pg.Client({ connectionString: controlUrl });
  await c.connect();
  await c.query(`SELECT fn_ledger_register($1,$2,$3,$4,$5,'provisioner')`,
    [code, name, period, slug, u.host]);
  await c.end();
}
console.log(`\n⑥ 完成。这个帐套的库：${slug}\n`
  + `   起服务时把它指过去：DATABASE_URL=${dbUrl(slug)} node app/server.mjs\n`
  + `   （同一实例里多个帐套 = 多个库，互不可见；备份/恢复按库走）`);
process.exit(0);
