// ============================================================================
// test/db-contract.test.mjs · 数据访问层的契约（驱动可换，语义不许变）
// ----------------------------------------------------------------------------
// 这一组不是在测业务，是在测 **withTx 承诺了什么**：
//
//   D1  并发两个事务不会互相污染（一个回滚，另一个的提交不该把它带走）
//   D2  回滚不留痕
//   D3  同一事务里的多条语句落在同一会话（临时表看得见；pid 不变）
//   D4  抛错之后连接仍然可用（不卡在"事务中"状态）
//   D5  事务外的单语句**不会插进**别人开着的事务里（读不到未提交数据）
//   D6  池化驱动下并发事务拿到**不同**连接（PGlite 上如实标 SKIP，不装绿）
//   D8  会话级设置跨提交/回滚仍生效（plan_cache_mode=force_custom_plan，179）；
//       并反证 `is_local=true` 确实不跨事务 —— 那个参数是必需的
//
// 为什么要有这一组：`app/db.mjs` 有两个驱动（PGlite / 真 PostgreSQL），
// 而真库这条路本机没有 PG，跑不了。**跑不了的那条路，至少要有一个可判定的契约**，
// 否则"支持连接池"就只是一句话。
//
// D1/D5 是真实缺陷的证据：第一版 `withTx` 直接在单连接上 `BEGIN`，
// 而 PGlite 只有一条连接。慢事务故意失败，它的那行数据却活了下来 ——
// 因为后来那个事务的 COMMIT 把它一起提交了。单线程跑测试永远看不见。
// ============================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, withTx } from '../app/db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, '..', 'db');

const results = [];
function rec(id, name, ok, note = '') {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${note ? `   [${note}]` : ''}`);
}
function skip(id, name, why) {
  results.push({ id, ok: true, skipped: true });
  console.log(`SKIP  ${id}  ${name}   [${why}]`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ 设了 DATABASE_URL 就跑真 PostgreSQL：这一组的**全部价值**在池化那条路上，
//   而 PGlite 上 D6 只能 SKIP（单连接驱动上"拿到不同连接"根本不成立）。
const db = await createDb({ dataDir: undefined, url: process.env.DATABASE_URL || undefined });
rec('D0', `驱动就绪（driver=${db.driver}）`, db.driver === 'pglite' || db.driver === 'pg', db.driver);

// 契约测试也走真实 schema：D3 用的是 app_init_session 建出来的那四张临时表，
// 自己造一张假表就测不到"真实对象在真实会话里的行为"。
// 迁移里有 EXCLUDE USING gist（区间不重叠），依赖 btree_gist。PGlite 在 createDb 里
// 已经装好；真库上这一步属于部署动作，测试自己补。
await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');

if (db.driver === 'pg') {
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n);
  if (n === 0) {
    // ★ 真库上**用 createApp 建库**，而不是只跑迁移：D7 要登录，
    //   而账号是种子给的（种子在 server.mjs 里，不在迁移里）。
    //   只跑迁移的后果是 D7 拿 401 —— 一个看起来像"认证坏了"的假失败。
    const { createApp } = await import('../app/server.mjs');
    const app = await createApp();
    await app.db.close();
  }
} else {
  for (const m of readdirSync(DB).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort()) {
    await db.exec(readFileSync(join(DB, m), 'utf8'));
  }
}

await db.exec('CREATE TABLE IF NOT EXISTS contract_probe (who text, at timestamptz DEFAULT clock_timestamp())');
await db.exec('TRUNCATE contract_probe');

// ---------------------------------------------------------------------------
// D1 并发事务互不污染
// ---------------------------------------------------------------------------
{
  const slow = withTx(db, async (tx) => {
    await tx.query("INSERT INTO contract_probe(who) VALUES ('slow')");
    await sleep(120);
    throw new Error('slow 故意失败');
  }).catch(() => 'rolled-back');

  await sleep(20);                      // 让 slow 先拿到连接
  const fast = withTx(db, async (tx) => {
    await tx.query("INSERT INTO contract_probe(who) VALUES ('fast')");
  });

  await Promise.all([slow, fast]);
  const rows = (await db.query('SELECT who FROM contract_probe ORDER BY who')).rows.map(r => r.who);
  rec('D1', '并发事务互不污染：慢事务回滚后，它的行不该被别人的 COMMIT 带走',
    rows.length === 1 && rows[0] === 'fast', `表里=${JSON.stringify(rows)}（期望只有 fast）`);
}

// ---------------------------------------------------------------------------
// D2 回滚不留痕
// ---------------------------------------------------------------------------
{
  await db.exec('TRUNCATE contract_probe');
  await withTx(db, async (tx) => {
    await tx.query("INSERT INTO contract_probe(who) VALUES ('ghost')");
    throw new Error('回滚');
  }).catch(() => {});
  const n = Number((await db.query('SELECT count(*)::int n FROM contract_probe')).rows[0].n);
  rec('D2', '回滚不留痕', n === 0, `剩 ${n} 行`);
}

// ---------------------------------------------------------------------------
// D3 同一事务 = 同一会话
// ---------------------------------------------------------------------------
{
  const pids = [];
  let tmpRows = -1;
  await withTx(db, async (tx) => {
    pids.push((await tx.query('SELECT pg_backend_pid() p')).rows[0].p);
    // 真实对象：app_init_session 建的四张临时表，在这一刻必须存在且可写
    await tx.query('SELECT app_init_session()');
    await tx.query(`INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id) VALUES ('cost_org', 10)`);
    tmpRows = Number((await tx.query(
      `SELECT count(*)::int n FROM pg_temp.tmp_scope_org WHERE org_id=10`)).rows[0].n);
    await sleep(30);
    pids.push((await tx.query('SELECT pg_backend_pid() p')).rows[0].p);
  });

  rec('D3', '同一事务内的多条语句落在同一会话（pid 不变；临时表可写可读）',
    pids[0] === pids[1] && tmpRows === 1, `pid ${pids.join('→')} 临时表行=${tmpRows}`);
}

// ---------------------------------------------------------------------------
// D4 抛错之后连接仍可用
// ---------------------------------------------------------------------------
{
  await withTx(db, async (tx) => {
    await tx.query('SELECT 1');
    throw new Error('中断');
  }).catch(() => {});
  let ok = false;
  try {
    await withTx(db, async (tx) => {
      await tx.query("INSERT INTO contract_probe(who) VALUES ('after-error')");
    });
    ok = true;
  } catch { ok = false; }
  const n = Number((await db.query(
    "SELECT count(*)::int n FROM contract_probe WHERE who='after-error'")).rows[0].n);
  rec('D4', '抛错之后仍可开启新事务并提交（没卡在"事务中"）', ok && n === 1, `写入=${n} 行`);
}

// ---------------------------------------------------------------------------
// D5 事务外的单语句不插队
// ---------------------------------------------------------------------------
{
  await db.exec('TRUNCATE contract_probe');
  let duringTx = -1;

  const txp = withTx(db, async (tx) => {
    await tx.query("INSERT INTO contract_probe(who) VALUES ('uncommitted')");
    await sleep(120);
    throw new Error('回滚');   // 最终不该留下任何行
  }).catch(() => {});

  await sleep(30);
  // 如果这条单语句插进了别人开着的事务，它就会**读到未提交的 1 行**
  duringTx = Number((await db.query('SELECT count(*)::int n FROM contract_probe')).rows[0].n);
  await txp;

  const after = Number((await db.query('SELECT count(*)::int n FROM contract_probe')).rows[0].n);
  rec('D5', '事务外的单语句不插进别人的事务（读不到未提交数据）',
    duringTx === 0 && after === 0, `事务期间读到=${duringTx} 收尾=${after}`);
}

// ---------------------------------------------------------------------------
// D6 池化驱动：并发事务拿到不同连接
// ---------------------------------------------------------------------------
{
  if (db.driver !== 'pg') {
    skip('D6', '并发事务拿到不同连接（池的意义）', `driver=${db.driver}：单连接驱动上这一条不成立`);
  } else {
    const pids = [];
    const one = withTx(db, async (tx) => {
      pids.push((await tx.query('SELECT pg_backend_pid() p')).rows[0].p);
      await sleep(80);
    });
    const two = withTx(db, async (tx) => {
      pids.push((await tx.query('SELECT pg_backend_pid() p')).rows[0].p);
      await sleep(80);
    });
    await Promise.all([one, two]);
    rec('D6', '并发事务拿到不同连接（否则池只是"顺序执行的另一个名字"）',
      pids.length === 2 && pids[0] !== pids[1], `pid ${pids.join(' / ')}`);
  }
}

// ---------------------------------------------------------------------------
// D7 并发请求：排队不等于死锁，也不等于串数据
// ---------------------------------------------------------------------------
// 上面几条测的是 withTx 的语义。这一条测的是**把它接到 HTTP 上之后**：
// 8 个并发请求、每个都要"灌权限 → 读带行闸的表"。
// 排队实现的典型坏法有两种：死锁（全都卡住）或串权限（读到别人的范围）。
{
  const { createApp } = await import('../app/server.mjs');
  const app = await createApp();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const tok = (await (await fetch(`${base}/login?user=1&pwd=demo1234`, { method: 'POST' })).json()).token;

  const answers = await Promise.all(Array.from({ length: 8 }, async () => {
    const r = await fetch(`${base}/api/attendance?period=2026-03`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    return { status: r.status, body: await r.json() };
  }));

  const okAll = answers.every(a => a.status === 200);
  const counts = new Set(answers.map(a => (a.body.rows || []).length));
  const noEmpty = [...counts].every(c => c > 0);

  rec('D7', '8 个并发请求：全部 200，且行数一致不为 0（不死锁、不串权限、不读到空范围）',
    okAll && counts.size === 1 && noEmpty,
    `状态=${[...new Set(answers.map(a => a.status))].join(',')} 行数=${[...counts].join(',')}`);

  app.server.close();
  await app.db.close();
}

// ---------------------------------------------------------------------------
// D8 会话级设置（179 的 plan_cache_mode）：必须**跨事务**活着
// ---------------------------------------------------------------------------
// 这条钉的不是性能，是"设置的作用域"：
//   `app_init_session()` 里那句 `set_config('plan_cache_mode','force_custom_plan',false)`
//   第三个参数必须是 **false（会话级）**。写成 true（事务级）时，设置会在第一个
//   事务提交时**静默消失** —— 池化连接上就退回 auto，于是又会出现"同一接口
//   第 6 次请求慢 180 倍"（168ms → 31s）那个现象，而且**没有任何报错**。
// ★ 真 PG 上这条同样跑（设了 DATABASE_URL 就走池化路径），所以它也是
//   "池化连接上 init 到底有没有生效"的唯一可判定证据。
// ★ 断言里还**证明**了 is_local=true 确实不跨事务 —— 不这样的话，
//   这条只是在陈述我们写了什么，而不是在证明那个参数是必需的。
{
  const show = async () => (await db.query('SHOW plan_cache_mode')).rows[0].plan_cache_mode;
  const atInit = await show();

  // ① 跨一个**提交**的事务
  await withTx(db, (tx) => tx.query('SELECT 1'));
  const afterCommit = await show();

  // ② 跨一个**回滚**的事务（回滚不该把会话设置带回 auto：它不是在那个事务里设的）
  await withTx(db, async (tx) => { await tx.query('SELECT 1'); throw new Error('D8 故意回滚'); })
    .catch(() => {});
  const afterRollback = await show();

  // ③ 反证：同一个值用 is_local=true 设，出了事务就该失效
  let insideLocal = '';
  await withTx(db, async (tx) => {
    await tx.query(`SELECT set_config('plan_cache_mode','auto',true)`);
    insideLocal = (await tx.query('SHOW plan_cache_mode')).rows[0].plan_cache_mode;
  });
  const afterLocal = await show();

  rec('D8', 'app_init_session 的 plan_cache_mode 是**会话级**：跨提交、跨回滚都还在；'
    + '并且反证 is_local=true 确实不跨事务（那个参数是必需的，不是顺手写的）',
    atInit === 'force_custom_plan'
    && afterCommit === 'force_custom_plan'
    && afterRollback === 'force_custom_plan'
    && insideLocal === 'auto' && afterLocal === 'force_custom_plan',
    `init 后=${atInit} 提交后=${afterCommit} 回滚后=${afterRollback}；`
    + `事务内 is_local=true 设为 ${insideLocal}，出事务=${afterLocal}（应回到 force_custom_plan）`);
}

await db.exec('DROP TABLE IF EXISTS contract_probe');
await db.close();

// ★ 跳过**不算通过**。第一版把 skip 也记成 ok=true，于是
//   "断言 7 条 · 通过 7 · 跳过 1" —— 一个自相矛盾的行，正是这个仓库最反对的那种绿。
const skipped = results.filter(r => r.skipped).length;
const ran = results.filter(r => !r.skipped);
const pass = ran.filter(r => r.ok).length;
const fail = ran.length - pass;
console.log(`\n数据访问层契约 · 断言 ${results.length} 条（执行 ${ran.length}）· 通过 ${pass} · 失败 ${fail}`
  + (skipped ? ` · 跳过 ${skipped}（跳过不算通过）` : ''));
process.exit(fail === 0 ? 0 : 1);
