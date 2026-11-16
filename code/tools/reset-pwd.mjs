// ============================================================================
// tools/reset-pwd.mjs · 把所有账号的初始口令设成同一个（上线第一天用一次）
// ----------------------------------------------------------------------------
// 用户要求："所有人初始账号 1234"。
//
//   DATABASE_URL=... node tools/reset-pwd.mjs --pwd 1234 [--only dm]
//
// ★ 三件事必须一起做，只做前两件会留下"旧口令还能用"的口子：
//   ① 换口令摘要（应用层 scrypt，库里只存摘要）
//   ② 踢掉所有旧会话（否则已经登录的人不受影响）
//   ③ 说清楚这是**初始**口令：它写在文档里，等于公开 —— 上线后必须改
//
// ★ 刻意**不**设 must_change：那会让每个人第一次登录先撞 428 改密页，
//   而"所有人先看一遍系统"这件事被一个表单挡在门口。代价写在这里，不藏。
// ============================================================================
import { createDb } from '../app/db.mjs';
import { hashPassword } from '../app/services/auth.mjs';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const pwd = arg('--pwd', '1234');
const url = process.env.DATABASE_URL;
if (!url) { console.error('必须给 DATABASE_URL'); process.exit(2); }

const db = await createDb({ url });
await db.initSession();

const before = (await db.query(
  `SELECT count(*)::int n FROM sys_account a
    WHERE NOT EXISTS (SELECT 1 FROM sys_user_credential c WHERE c.user_id = a.id)`)).rows[0].n;

const rows = (await db.query(`SELECT id, login, display_name FROM sys_account ORDER BY id`)).rows;
const hash = hashPassword(pwd);
let set = 0;
for (const a of rows) {
  await db.query(
    `INSERT INTO sys_user_credential(user_id, pwd_hash, must_change, failed_count, locked_until)
     VALUES ($1,$2,false,0,NULL)
     ON CONFLICT (user_id) DO UPDATE
        SET pwd_hash = EXCLUDED.pwd_hash, must_change = false,
            failed_count = 0, locked_until = NULL`, [a.id, hash]);
  set += 1;
}
// ② 踢掉旧会话：不踢的话，"改了口令"只对新登录生效，老 token 还能用 12 小时
// ★ 吊销必须凑齐三件套（by + reason + at）：030 的触发器会拒"匿名吊销"，
//   而它拒得对 —— 一条只有时间的吊销记录回答不了"是谁把人踢下线的"。
const killed = (await db.query(
  `UPDATE sys_session
      SET revoked_at = now(),
          revoked_by = (SELECT min(id) FROM sys_account),
          revoked_reason = '初始化口令：全部会话失效'
    WHERE revoked_at IS NULL RETURNING id`)).rows.length;

console.log(`口令已重置：${set} 个账号（原先无口令的 ${before} 个）`);
console.log(`已失效会话：${killed} 条`);
console.log(`初始口令：${pwd}  —— 上线后必须逐个改掉（它写在文档里，等于公开）`);
await db.close();
process.exit(0);
