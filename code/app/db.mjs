// ============================================================================
// app/db.mjs · 事务边界与连接归属（驱动可换：PGlite / 真 PostgreSQL）
// ----------------------------------------------------------------------------
// 这一层存在的理由只有一条，而它是这套系统里最容易被忽略的那条：
//
//   **`app_begin_scope` 把权限灌进 `pg_temp` 的临时表，而临时表是「会话」的。**
//
// 在单连接上这没问题。一旦上了连接池，就会出现：灌权限用一个连接、
// 业务查询用另一个连接 —— 于是临时表是空的、四维全空、**查到 0 行**。
//
// 这个失败很安静：不报错、不告警，只是"这个人什么都看不到"。
// 而排查方向通常是权限配错了、组织没挂对，没人会想到"两条语句不在同一会话里"。
//
// 所以规矩是：**一次业务请求 = 一个事务 = 一个连接**。
// 灌权限、业务读写、审计留痕，全在同一个 `withTx` 里。
//
// ----------------------------------------------------------------------------
// 两个驱动，一套契约
// ----------------------------------------------------------------------------
//   PGlite（默认）：数据库跑在 Node 进程里，**只有一条连接**。
//     于是"一个事务一个连接"退化成"所有事务排队上同一条连接"。
//     ★ 第一版没有这个排队：`withTx` 直接 `db.exec('BEGIN')`。
//       后果是并发时 A 的 BEGIN 撞上 B 的 BEGIN（PG 只警告不报错），
//       B 的 COMMIT 把 A 的未提交写入一起提交了 —— A 再 ROLLBACK 已经晚了。
//       `test/db-contract.test.mjs` 的 D1 就是这一条：慢事务故意失败，
//       它的那行数据却活了下来。单线程跑测试永远看不见。
//   真 PostgreSQL：`DATABASE_URL` 存在时用 `pg` 连接池，每条连接单独取用，
//     并在**每条连接**第一次使用时执行 `app_init_session()`
//     （临时表是会话的，池里新开一条连接就是空会话 —— 这正是 AE5 那个洞）。
//     这条路本机没有 PG，**未在本机验证**；契约测试（D1–D5）定义了它必须满足什么。
// ============================================================================

/**
 * 单连接驱动需要一个互斥：同一时刻只允许一个事务持有那条连接。
 * 不用锁也不用原子操作 —— 一个 promise 链就够了，而它比任何花活都容易读懂。
 */
function makeMutex() {
  let tail = Promise.resolve();
  return function run(fn) {
    const next = tail.then(fn, fn);
    // 无论成败都不能把链卡死：失败也要让下一个继续
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}

/**
 * 打开一个 Db。
 *   @param {{ dataDir?: string, url?: string }} opt
 *   dataDir → PGlite 落盘目录（不传 = 内存库）；url → 真 PostgreSQL 连接串
 */
export async function createDb({ dataDir, url } = {}) {
  if (url) return createPgDb(url);
  return createPgliteDb(dataDir);
}

// ---------------------------------------------------------------------------
// PGlite：一条连接 + 排队
// ---------------------------------------------------------------------------
async function createPgliteDb(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const raw = await PGlite.create({ extensions: { btree_gist }, dataDir });
  const lock = makeMutex();

  const conn = {
    query: (sql, params) => raw.query(sql, params),
    exec: (sql) => raw.exec(sql),
  };

  // 临时表只建一次：这条连接活到进程结束
  await raw.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
  await raw.query('SELECT app_init_session()').catch(() => { /* 空库时函数还不存在 */ });

  return {
    driver: 'pglite',
    // ★ 单连接上的每一次取用都要排队：不排队的话，一个事务开着的时候，
    //   别人的单语句会**落进这个事务里**（读得到未提交数据，写会被一起回滚）。
    query: (sql, params) => lock(() => conn.query(sql, params)),
    exec: (sql) => lock(() => conn.exec(sql)),
    // 事务内部不再加锁（已经在锁里了），否则自己等自己
    _unsafeConn: conn,
    _lock: lock,
    initSession: () => raw.query('SELECT app_init_session()'),
    close: () => raw.close(),
    raw,
  };
}

// ---------------------------------------------------------------------------
// 真 PostgreSQL：连接池，每条连接单独初始化
// ---------------------------------------------------------------------------
async function createPgDb(url) {
  const pg = await import('pg');
  // PGlite 把 int8 解析成 number，而 pg 默认给字符串。
  // 不统一的话，同一段代码在两个驱动下会得到 `"5" !== 5` —— 这类差异
  // 只会以"某个判断忽然不成立"的形式出现，很难归因到驱动。
  pg.default.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

  // ★ `date` 一律解析成 **UTC 零点**的 Date，与 PGlite 完全一致。
  //   node-postgres 的默认解析器给的是"本地零点"（`new Date(y, m-1, d)`），
  //   而本仓到处用 `d.toISOString().slice(0,10)` 取日期 —— 在 +08:00 下
  //   2026-03-01 的本地零点转 UTC 是 2026-02-28T16:00Z，切片得到 **2026-02-28**。
  //   这个错在 PGlite 上不存在（它按 UTC 造 Date），所以它**只在真库上出现**，
  //   而且报出来的是"门店 10 的 2026-02 还没封账"——看起来像业务数据错了。
  //   顺带说明为什么不用 `SET TIME ZONE 'UTC'` 修：那条只改服务端的输出格式，
  //   而日期的零点是在**客户端**按本地时区造出来的。
  pg.default.types.setTypeParser(1082, (v) => (v === null ? null : new Date(`${v}T00:00:00Z`)));

  const pool = new pg.default.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 10),
  });

  // 每条物理连接只需要初始化一次；用 WeakSet 记，连接被池回收就自然消失
  const inited = new WeakSet();
  async function initOnce(client) {
    if (inited.has(client)) return;
    try {
      // ★ 会话时区固定 UTC，与 PGlite 一致。
      //   不一致的后果不是"显示差 8 小时"，而是**日期差一天**：
      //   node-postgres 把 `date` 解析成"本地时间的零点"，而代码里到处是
      //   `d.toISOString().slice(0,10)` —— 在 +08:00 下，2026-03-01 的本地零点
      //   转成 UTC 是 2026-02-28T16:00Z，切片得到 **2026-02-28**。
      //   PGlite 里那条同样的代码是对的（它按 UTC 造 Date），所以这个错
      //   **只在真库上出现**，而且是"补账说 2 月没封账"这种莫名其妙的报错。
      await client.query("SET TIME ZONE 'UTC'");
      await client.query('SELECT app_init_session()');
      inited.add(client);
    } catch (e) {
      // ★ 空库上这条函数还不存在（001 才建它）。**不要**因此把连接标记成已初始化：
      //   否则建库之后这条连接会被永远当成"初始化过"，而它其实什么都没有。
      //   只吞"函数不存在"，其他错误照抛 —— 吞掉连接错误会让后面每一步都怪到别处。
      if (e.code !== '42883' || !/app_init_session/.test(String(e.message))) throw e;
    }
  }

  // ★ 裸 query 也要走"取连接 + 初始化"：原来这里直接 pool.query，
  //   于是**不属于任何事务的单语句**会落在一条没初始化的连接上 ——
  //   症状是 `schema "pg_temp" does not exist` 或 `3F000`，而它只在
  //   "这条连接是新开的 / 空闲超时被回收之后又开了一条"时出现。
  //   第一次真 PG 上跑测试就撞上了：psql 里手敲一遍全对，脚本跑到第 50 条才炸。
  //   代价是每条裸语句多一次 connect/release（池内是复用，不是新建连接）。
  const withInit = async (fn) => {
    const c = await pool.connect();
    try {
      await initOnce(c);
      return await fn(c);
    } finally {
      c.release();
    }
  };

  return {
    driver: 'pg',
    query: (sql, params) => withInit((c) => c.query(sql, params)),
    exec: (sql) => withInit((c) => c.query(sql)),
    // 取一条连接，用完归还；调用方负责 release
    _checkout: async () => {
      const client = await pool.connect();
      try {
        await initOnce(client);
        return client;
      } catch (error) {
        client.release();
        throw error;
      }
    },
    initSession: async () => {
      const c = await pool.connect();
      try { await c.query('SELECT app_init_session()'); } finally { c.release(); }
    },
    close: () => pool.end(),
    raw: pool,
  };
}

// ---------------------------------------------------------------------------
// 事务：两个驱动共用一段逻辑，差异只在"怎么拿到那条连接"
// ---------------------------------------------------------------------------
/**
 * 在一个事务里执行 fn(tx)。tx 的所有查询保证落在同一个连接上。
 * 抛错即回滚，不留下"单据在、额度没冻"这类半成品。
 */
export async function withTx(db, fn) {
  const run = async (conn, release) => {
    // ★ 临时表必须在 BEGIN **之前**建：`ON COMMIT PRESERVE ROWS` 的临时表
    //   如果是在事务里建的，那次回滚会把它一起删掉，下一条语句就 3F000。
    try {
      await conn.query('BEGIN');
      const tx = {
        query: (sql, params) => conn.query(sql, params),
        exec: (sql) => conn.exec(sql),
      };
      const out = await fn(tx);
      await conn.query('COMMIT');
      return out;
    } catch (e) {
      try { await conn.query('ROLLBACK'); } catch { /* 回滚失败不能盖住原始错误 */ }
      throw e;
    } finally {
      if (release) release();
    }
  };

  if (db.driver === 'pg') {
    const client = await db._checkout();
    // ★ 事务开始**之前**再确保一次会话就绪。
    //   WeakSet 的记忆会骗人：真 PG 上实测到过"标记为已初始化、而临时表已经不在"的连接
    //   （连接被复用时状态不是我们能完全掌握的东西），症状是随机的
    //   `relation "pg_temp.tmp_scope_org" does not exist` —— 15 条路由偶发 500，
    //   而重跑一遍又全绿。临时表是整套行闸的地基，地基不能"通常还在"。
    //   代价是每个事务多一条 SELECT（幂等，IF NOT EXISTS），这是值得付的。
    try {
      await client.query('SELECT app_init_session()');
      return await run(
        { query: (s, p) => client.query(s, p), exec: (s) => client.query(s) },
        null,
      );
    } finally {
      client.release();
    }
  }

  // PGlite：整段事务占住唯一那条连接
  return db._lock(async () => {
    await db.initSession();          // 幂等：空库时静默跳过
    return run(db._unsafeConn, null);
  });
}

/**
 * 会话初始化：保证当前连接有那四张临时表。
 * 单连接驱动在 withTx 里已经做过；这里给"服务启动时先用一下"留个入口。
 */
export async function initSession(db) {
  await db.initSession();
}

/**
 * 取业务日期。所有写路径都显式传日期，不取数据库时钟——
 * 否则"这次为什么被拒"永远复现不出来：同一批数据今天能过、明天过不了，
 * 而拒绝信息里没有日期。
 */
export const businessDate = () => new Date().toISOString().slice(0, 10);
