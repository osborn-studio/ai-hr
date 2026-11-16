// ============================================================================
// app/services/session.mjs · 会话：签发 / 校验 / 吊销
// ----------------------------------------------------------------------------
// 这一层只做三件事，而三件都是**库做不了或不该做**的：
//
//   ① 生成 token（用 CSPRNG，不是 Math.random）
//   ② 算摘要（PGlite 没有 pgcrypto 的 sha256；摘要算法在应用侧更合适，
//      因为将来换 argon2/bcrypt 时不该动 DDL）
//   ③ 把"三态"翻译成"这次请求该怎么办"
//
// 库那一侧负责的是判据：过期比较、吊销留痕、身份三件套不可改、不可延长。
// 那些放在库里，因为服务层可以被绕过（运维脚本、MCP 工具、另一个客户端）。
// ============================================================================
import crypto from 'node:crypto';
import { bizErr } from '../errors.mjs';

/** 最小 token 长度。16 字符以下穷举成本低到没有意义。 */
const MIN_LEN = 16;

/** 生成 token：128 位随机 + 时间前缀（便于在日志里分辨，不含任何身份信息）。 */
export function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** 摘要。库里存的是它，不是 token 本身。 */
export const hashToken = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');

export async function issue(tx, { userId, ttl = '12 hours' }) {
  const token = newToken();
  if (token.length < MIN_LEN) throw bizErr('E_SESSION_WEAK', `token 太短（${token.length}）`);
  const exp = (await tx.query('SELECT fn_session_issue($1,$2,$3) e',
    [userId, hashToken(token), ttl])).rows[0].e;
  // ★ 明文只在这一刻出现在响应里，之后库里查不到它。
  //   所以"用户把 token 丢了"只能重新登录 —— 系统不提供"再给我看一眼"。
  return { token, expires_at: exp };
}

/**
 * 校验：返回 { status, userId, revokedReason }。
 * ★ 不抛错。401 的三种原因在 HTTP 上是同一类，在**处置**上是三件事：
 *   没 token → 前端引导登录；过期 → 重新登录；被吊销 → 去问管理员。
 */
export async function check(db, token) {
  if (!token) return { status: 'missing' };
  const r = (await db.query('SELECT * FROM fn_session_check($1)', [hashToken(token)])).rows[0];
  if (!r) return { status: 'missing' };
  return {
    status: r.status,
    userId: r.user_id === null ? null : Number(r.user_id),
    revokedReason: r.revoked_reason || null,
    mustChange: !!r.must_change,
  };
}

export async function revoke(tx, { token, by, reason }) {
  if (!reason || String(reason).trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '吊销必须写原因（至少 4 个字）');
  }
  await tx.query('SELECT fn_session_revoke($1,$2,$3)',
    [hashToken(token), String(by), String(reason).trim()]);
  return { revoked: true };
}

/** 心跳：只在 60 秒没更新时才写，避免每个请求一次写放大 */
export async function touch(db, token) {
  await db.query('SELECT fn_session_touch($1)', [hashToken(token)]);
}

/** 退出某台设备：「我吊销我自己的」——别人的会话连查都查不到 */
export async function revokeMine(tx, { userId, sessionId, reason }) {
  if (!Number.isInteger(sessionId) || sessionId <= 0) throw bizErr('E_ARG_INVALID', 'id 必须是正整数');
  if (!reason || String(reason).trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '吊销必须写原因（至少 4 个字）');
  }
  await tx.query('SELECT fn_session_revoke_id($1,$2,$3,$4)',
    [sessionId, userId, String(userId), String(reason).trim()]);
  return { revoked: true, id: sessionId };
}

/** 某个账号当前的活跃会话（"他现在在哪几台设备上"） */
export async function listActive(tx, { userId }) {
  return (await tx.query(
    `SELECT id, user_id, issued_at, expires_at, last_seen_at
       FROM v_session_active WHERE ($1::bigint IS NULL OR user_id = $1)
      ORDER BY issued_at DESC`, [userId ?? null])).rows;
}
