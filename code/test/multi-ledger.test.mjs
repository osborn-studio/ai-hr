// ============================================================================
// test/multi-ledger.test.mjs · 多帐套路由（物理隔离）· RT 组
// ----------------------------------------------------------------------------
// 069 让"建帐 = 开库"能跑，070 + app/registry.mjs 让它能被**同一台服务**服务。
// 这一组证明的就是那三件事，而它们都只有真 PostgreSQL 才跑得出来
// （PGlite 是进程内嵌库，一个实例就一个库 —— 没有第二个库可路由）：
//
//   RT1 控制库能列出两个帐套，且**不回库名**（库名是内部拓扑）
//   RT2 登录带帐套 → token 带前缀（`<code>.<随机串>`）
//   RT3 该 token 在它自己的帐套上能用
//   RT4 把前缀改成另一个帐套 → 401（会话不在那个库里）
//   RT5 不存在的帐套 → 404，且**不回落**到默认库
//   RT6 两个帐套的数据互不可见（A 加的组织不出现在 B）
//   RT7 在线开库（POST /api/ledger/provision）→ 第三个帐套出现且能登录
//
// 没有 PostgreSQL 就**跳过并说出来**（跳过不算通过）。
// ============================================================================
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODE_DIR = join(HERE, '..');
const DB_DIR = join(CODE_DIR, 'db');

const results = [];
let n = 0;
const rec = (id, name, ok, detail) => {
  n += 1;
  results.push({ id, name, ok: !!ok, detail: detail ?? '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? `\n            ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// 前置：一个能建库的 PostgreSQL。没有就跳过（说清楚为什么跳过）
// ---------------------------------------------------------------------------
const BASE = process.env.PG_BASE || 'postgres://postgres@127.0.0.1:5433';
const controlName = 'aihr_mt_control';

const reachable = async () => {
  try {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: `${BASE}/postgres`, connectionTimeoutMillis: 1500 });
    await c.connect();
    await c.end();
    return true;
  } catch { return false; }
};

if (!(await reachable())) {
  console.log(`\n[跳过] 连不上 ${BASE}（多帐套必须有真 PostgreSQL：一个帐套一个库）`);
  console.log('       起库：/tmp/pg16/Postgres.app/Contents/Versions/16/bin/pg_ctl -D /tmp/pgdata16 start');
  console.log('       跳过不计入通过。\n');
  process.exit(0);
}

// ★ `(await import('pg')).default` 就是 pg 模块本身，再取 `.default` 是 undefined ——
//   这个错只在"我照抄了 db.mjs 的写法又加了一层 .default"时出现。
const pgmod = await import('pg');
const pg = pgmod.default ?? pgmod;
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => (v === null ? null : new Date(`${v}T00:00:00Z`)));
const urlFor = (db) => `${BASE}/${db}`;

/** 重建一个空库（先踢掉残留连接，否则 DROP 会被占用挡住）。 */
async function resetDb(name) {
  const c = new pg.Client({ connectionString: `${BASE}/postgres` });
  await c.connect();
  await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                  WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
  await c.query(`DROP DATABASE IF EXISTS ${name}`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}

async function runMigrations(url) {
  const { createDb } = await import('../app/db.mjs');
  const db = await createDb({ url });
  await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
  for (const f of readdirSync(DB_DIR).filter((x) => /^\d{3}_.*\.sql$/.test(x)).sort()) {
    await db.exec(readFileSync(join(DB_DIR, f), 'utf8'));
  }
  await db.initSession();
  await db.close();
}

/** 调 tools/new-ledger.mjs（**不复制那些步骤**：命令行与界面必须同一份实现）。 */
function provision({ code, name, period, admin = 'admin', pwd = 'demo1234' }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(CODE_DIR, 'tools', 'new-ledger.mjs'),
      '--code', code, '--name', name, '--period', period, '--admin', admin, '--pwd', pwd], {
      cwd: CODE_DIR,
      env: { ...process.env, DATABASE_URL: urlFor(controlName) },
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code0) => resolve({ ok: code0 === 0, out }));
  });
}

console.log('\n== 多帐套路由（物理隔离）==\n');

await resetDb(controlName);
await resetDb('aihr_mt_a');
await resetDb('aihr_mt_b');
await resetDb('aihr_mt_c');        // RT7 会开第三个帐套（不重置就会撞"编码已存在"）
await runMigrations(urlFor(controlName));

const A = await provision({ code: 'MT-A', name: '甲集团', period: '2026-06', admin: 'admin' });
const B = await provision({ code: 'MT-B', name: '乙集团', period: '2026-07', admin: 'admin' });
rec('RT0', '开库：两个集团帐套各自建库并跑完迁移',
    A.ok && B.ok,
    `${A.ok ? 'A✓' : 'A✗'} ${B.ok ? 'B✓' : 'B✗'} ${A.ok ? '' : A.out.slice(-160)}`);

process.env.CONTROL_URL = urlFor(controlName);
const { createApp } = await import('../app/server.mjs');
const { server, registry, control } = await createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASEURL = `http://127.0.0.1:${server.address().port}`;

const call = async (path, { token, method = 'GET' } = {}) => {
  const r = await fetch(BASEURL + path, {
    method, headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};
const login = (ledger, user = 1, pwd = 'demo1234') => call(
  `/login?user=${user}&pwd=${encodeURIComponent(pwd)}${ledger ? `&ledger=${encodeURIComponent(ledger)}` : ''}`,
  { method: 'POST' });

// --- RT1 清单
{
  const r = await call('/api/ledgers');
  const codes = (r.body?.ledgers || []).map((x) => x.code);
  const leaks = JSON.stringify(r.body || '').includes('aihr_mt_');
  rec('RT1', '控制库列出两个帐套，且**不回库名**（库名是内部拓扑）',
      r.status === 200 && r.body.multi === true && codes.includes('MT-A') && codes.includes('MT-B')
      && !leaks,
      `codes=${codes.join(',')} 泄露库名=${leaks}`);
}

// --- RT2 / RT3 token 前缀
const ta = await login('MT-A');
const tb = await login('MT-B');
{
  const prefixed = String(ta.body?.token || '');
  const own = await call('/api/ledger', { token: prefixed });   // 任意需要认证的接口
  rec('RT2', '登录带帐套 → token 形如 `<帐套编码>.<随机串>`，并回显 ledger',
      ta.status === 200 && prefixed.startsWith('MT-A.') && ta.body.ledger === 'MT-A',
      `${ta.status} token=${prefixed.slice(0, 12)}… ledger=${ta.body?.ledger}`);
  rec('RT3', '该 token 在自己的帐套上可用（会话在帐套库里，不在控制库）',
      ta.status === 200 && own.status !== 401,
      `login=${ta.status} 后续请求=${own.status}`);
}

// --- RT4 跨帐套
{
  const raw = String(ta.body?.token || '').split('.').slice(1).join('.');
  const forged = await call('/api/ledger', { token: `MT-B.${raw}` });
  rec('RT4', '拿 A 的 token 冒充 B（改前缀）→ 401（会话不在那个库里）',
      forged.status === 401, `${forged.status} ${forged.body?.error}`);
}

// --- RT5 不存在的帐套不回落
{
  const r = await login('MT-NOPE');
  const r2 = await call('/api/ledger', { token: 'MT-NOPE.deadbeefdeadbeef' });
  rec('RT5', '不存在的帐套 → 404 E_LEDGER_UNKNOWN，且**不回落**到默认库',
      r.status === 404 && r.body?.error === 'E_LEDGER_UNKNOWN'
      && r2.status === 404 && r2.body?.error === 'E_LEDGER_UNKNOWN',
      `登录=${r.status} ${r.body?.error} / 请求=${r2.status} ${r2.body?.error}`);
}

// --- RT6 数据隔离
{
  const before = (await call('/api/ledgers')).body;
  // 层级是硬约束：集团 → 区域 → 门店。想直接挂门店会被 E_ORG_DEPTH 拒掉（那是对的）。
  const addR = await call(`/api/org?name=${encodeURIComponent('华南区')}&kind=region`
    + '&parent=1', { token: ta.body.token, method: 'POST' });
  const addS = await call(`/api/org?name=${encodeURIComponent('甲集团一号店')}&kind=store`
    + `&parent=${addR.body?.id}`, { token: ta.body.token, method: 'POST' });
  const listA = (await call('/api/ledger', { token: ta.body.token })).body;
  const listB = (await call('/api/ledger', { token: tb.body.token })).body;
  const orgsA = listA?.ledger?.orgs;
  const orgsB = listB?.ledger?.orgs;
  rec('RT6', 'A 加的「区域 + 门店」不出现在 B（两个库各自独立，不是同一批表加 tenant 列）',
      addR.status === 200 && addS.status === 200
      && Number(orgsA) === 3 && Number(orgsB) === 1,
      `区域=${addR.status} 门店=${addS.status} A组织=${orgsA} B组织=${orgsB} 帐套数=${before.ledgers.length}`);
}

// --- RT7 在线开库（走接口，不是命令行）
{
  const r = await call('/api/ledger/provision?code=MT-C&name='
    + encodeURIComponent('丙集团') + '&period=2026-08',
    { token: ta.body.token, method: 'POST' });
  const list = (await call('/api/ledgers')).body;
  const codes = (list?.ledgers || []).map((x) => x.code);
  const tc = await login('MT-C');
  rec('RT7', '在线开库：接口开出第三个帐套，立刻能登录（不用重启服务）',
      r.status === 200 && codes.includes('MT-C') && tc.status === 200
      && String(tc.body?.token || '').startsWith('MT-C.'),
      `provision=${r.status} codes=${codes.join(',')} 登录=${tc.status}`);
}

// --- 收口：把结论写进登记表（控制库）
{
  const fails = results.filter((x) => !x.ok).length;
  try {
    await control.query('SELECT fn_chk_record($1,$2,$3,$4)',
      ['SUITE.RT', fails === 0 ? 'pass' : 'fail', fails, null]);
  } catch (e) {
    console.log('[chk] 写登记失败（不影响断言结论）：', String(e.message).split('\n')[0]);
  }
}

await registry.close();
server.close();
const pass = results.filter((x) => x.ok).length;
console.log(`\n多帐套 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
process.exit(pass === results.length ? 0 : 1);
