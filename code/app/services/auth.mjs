// ============================================================================
// app/services/auth.mjs · 认证：口令派生与校验
// ----------------------------------------------------------------------------
// 这一层只做库做不了的那件事：**scrypt 派生**。
// 其余（能不能试、错了几次、锁到什么时候）都在库里的 `fn_auth_challenge` /
// `fn_auth_result` —— 因为那三件事必须"只有一份账"：
//
//   写在应用里 → 重启清零（爆破者只要等一次部署）、多实例各算一套、
//   另一个客户端（脚本、MCP 工具）根本不认这套计数。
//
// ★ 派生参数固定 16384/8/1（约 16MB 内存、几十毫秒）。调大更安全但会拖慢登录，
//   而登录慢到某个程度，人就会开始共用账号 —— 那是更坏的结果。
// ============================================================================
import crypto from 'node:crypto';
import { bizErr } from '../errors.mjs';
import { hashToken } from './session.mjs';

const N = 16384, R = 8, P = 1, KEYLEN = 32;
// ★ 口令强度不再写在这里：075 把它做成了制度项（PWD_MIN_LEN / PWD_NEED_MIX），
//   判据只有一份实现 —— 库里的 fn_pwd_check。应用层调它，不自己写 if。
//   写死在这里的后果是"客户要 4 位初始口令"只能改代码，而那不该是配置的方式。
const PWD_HINT = '（策略见制度项 PWD_MIN_LEN / PWD_NEED_MIX）';

/** 生成派生值：scrypt$N$r$p$salt_b64$hash_b64 */
export function hashPassword(plain) {
  // 这里只做"非空"这一层最粗的拦截；长度与混合要求由 fn_pwd_check 判
  // （它读制度项，所以有生效日、有留痕、可被客户改）。
  if (!plain) throw bizErr('E_CRED_WEAK', `口令不能为空 ${PWD_HINT}`);
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), dk.toString('base64')].join('$');
}

/**
 * 校验：派生参数从库里那一行读，不在代码里写死。
 * ★ 这样将来调参数时，**旧口令仍然能验**（每个用户按自己的参数派生子密钥），
 *   而不是"改一次参数所有人登录失败"。
 */
export function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expect = Buffer.from(hashB64, 'base64');
  let got;
  try {
    got = crypto.scryptSync(String(plain ?? ''), salt, expect.length,
      { N: Number(n), r: Number(r), p: Number(p) });
  } catch {
    return false;
  }
  // 定长比较：普通 === 会在第一个不同字节处返回，泄漏"前缀对了多少"
  return got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

/**
 * 登录：先问库能不能试 → 校验 → 把结果记回库。
 * ★ 三步在同一个事务里：锁的是同一行，所以并发的爆破请求不会各读一次旧计数。
 */
export async function authenticate(tx, { userId, password }) {
  const ch = (await tx.query('SELECT * FROM fn_auth_challenge($1)', [userId])).rows[0];
  const ok = verifyPassword(password, ch.pwd_hash);

  // ★ 入账**不抛异常**（见 035 的注释）：抛了会随事务回滚，失败次数永远停在 1。
  //   结论先落库并提交，再由调用方决定抛什么 —— 顺序反过来，锁定就永远不成立。
  const r = (await tx.query('SELECT * FROM fn_auth_result($1,$2)', [userId, ok])).rows[0];
  return {
    userId,
    mustChange: !!ch.must_change,
    ok,
    status: r.status,                 // ok | bad | locked
    failedCount: Number(r.failed_count),
    lockedUntil: r.locked_until,
  };
}

/**
 * 改口令：验旧 → 写新 → 撤其它会话，同一事务。
 * ★ 旧口令的校验必须走 authenticate（含失败计数），否则这个接口就是
 *   一条绕过 5 次锁定的口令试错通道。
 */
export async function changePassword(tx, { userId, oldPassword, newPassword, keepToken }) {
  // 强度判据在库里（075），这里只负责"新旧不同"这一条业务规则
  await tx.query('SELECT fn_pwd_check($1)', [String(newPassword ?? '')]);
  if (String(oldPassword ?? '') === String(newPassword)) {
    throw bizErr('E_CRED_SAME', '新口令不能与旧口令相同');
  }

  const res = await authenticate(tx, { userId, password: oldPassword });
  if (!res.ok) {
    // 与登录同一套结论：错就是错，锁定就是锁定（计数已入库）
    return { ok: false, status: res.status, failedCount: res.failedCount };
  }

  const revoked = (await tx.query('SELECT fn_password_change($1,$2,$3,$4) n',
    [userId, hashPassword(newPassword), hashToken(keepToken), String(userId)])).rows[0].n;

  return { ok: true, revokedOthers: Number(revoked) };
}
