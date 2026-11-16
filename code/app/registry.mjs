// ============================================================================
// app/registry.mjs · 多帐套路由：一个帐套一个库，请求按 token 前缀选库
// ----------------------------------------------------------------------------
// 069 把建帐做成了"开库"（物理隔离）。但建完之后还有个更基本的问题：
//
//   **同一台服务怎么同时服务多个帐套？**
//
// 换 DATABASE_URL 起第二个进程也能用，但那样"切帐套"就是运维动作，
// 客户要的是登录时选一下。所以这一层做三件事：
//
//   ① 控制库只回答"有哪些帐套、各自连哪个库"（sys_ledger.db_name）
//   ② 每个帐套的库按需打开并缓存（同一个 db_name 只开一次池）
//   ③ token 带上帐套前缀（`<code>.<token>`），于是**不需要查库就知道该去哪查**
//
// 为什么前缀而不是"会话表里存帐套"：会话表在每个帐套自己的库里。
// 要在查会话之前知道去哪个库查，就只能让 token 自己说。
// 而 token 前缀是公开信息（帐套编码本来就写在登录页上），
// 真正的凭据仍是后面那段 128 位随机串 —— 且它在别的库里查不到，
// 所以"拿 A 帐套的 token 打 B 帐套"会得到 401 而不是别人的数据。
//
// ★ 一条边界：前缀必须**服务端校验**。客户端塞一个不存在的帐套前缀，
//   这里要拒绝（E_LEDGER_UNKNOWN），而不是回落到默认库 ——
//   回落会让"打错帐套"变成"看到另一个帐套的数据"，那是最坏的一种错。
// ============================================================================
import { createDb } from './db.mjs';
import { bizErr } from './errors.mjs';

/** 把控制库连接串换成某个库的连接串（只改 path，其他原样保留）。 */
export function urlForDb(controlUrl, dbName) {
  const u = new URL(controlUrl);
  u.pathname = '/' + dbName;
  return u.toString();
}

/** 帐套编码是否可用作 token 前缀：只允许字母数字与 - _ （不能有点，点分隔前缀）。 */
const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function createLedgerRegistry({ controlUrl, control: shared, ttlMs = 5000 }) {
  // 复用调用方已经打开的控制库连接：同一个 URL 开两个池，只会让
  // "哪个池看到的是旧数据"变成一个多出来的排查方向。
  const control = shared || createDb({ url: controlUrl });
  /** @type {Map<string, Promise<any>>} dbName → db（同一个库只开一次池） */
  const pools = new Map();
  let cache = null;      // { at, rows }
  let inflight = null;   // 避免同一瞬间并发打控制库

  const load = async (force = false) => {
    if (!force && cache && Date.now() - cache.at < ttlMs) return cache.rows;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const rows = (await control.query(
          `SELECT code, name, db_name, is_default, status
             FROM sys_ledger WHERE db_name IS NOT NULL ORDER BY is_default DESC, id`)).rows;
        cache = { at: Date.now(), rows };
        return rows;
      } finally { inflight = null; }
    })();
    return inflight;
  };

  const find = async (code) => {
    if (!CODE_RE.test(String(code || ''))) {
      throw bizErr('E_LEDGER_UNKNOWN', `帐套编码不合法：${code}`);
    }
    const rows = await load(true);     // 查找**总是**读最新的：建帐之后要立刻能用
    const hit = rows.find((r) => r.code === code);
    if (!hit) throw bizErr('E_LEDGER_UNKNOWN', `帐套 ${code} 不存在（或还没建库）`);
    return hit;
  };

  const dbFor = async (code) => {
    const row = await find(code);
    if (!pools.has(row.db_name)) {
      pools.set(row.db_name, createDb({ url: urlForDb(controlUrl, row.db_name) }));
    }
    return pools.get(row.db_name);
  };

  return {
    control,
    /** 控制库里的帐套清单（给登录页与建帐页用；**不含** db_name —— 库名不外泄） */
    list: async () => (await load(true)).map((r) => ({
      code: r.code, name: r.name, is_default: r.is_default, status: r.status,
    })),
    defaultCode: async () => {
      const rows = await load(true);
      const d = rows.find((r) => r.is_default) || rows[0];
      return d ? d.code : null;
    },
    codeOf: (bearer) => {
      const t = String(bearer || '');
      const i = t.indexOf('.');
      if (i <= 0) return null;
      const code = t.slice(0, i);
      return CODE_RE.test(code) ? code : null;
    },
    dbFor,
    invalidate: () => { cache = null; },
    close: async () => {
      for (const p of pools.values()) {
        try { await (await p).close(); } catch { /* 关不掉也不阻塞退出 */ }
      }
      await control.close();
    },
  };
}
