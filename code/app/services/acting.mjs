// ============================================================================
// app/services/acting.mjs · 副职代理（073/074）
// ----------------------------------------------------------------------------
// 三条规矩都在库里（fn_acting_grant_set），这一层只做三件事：
//   ① 把"账号名"翻成 id（界面不该填 id）
//   ② 读：**只返回与我相关的**（我是主管 / 我是副手）——
//      代理关系本身是隐私：谁在替谁顶班，不该全公司可见
//   ③ 把时间窗从"天"翻成 timestamptz（界面按天填，库里存时刻）
// ============================================================================
import { bizErr } from '../errors.mjs';
import { requireSession } from './guard.mjs';

/** 我相关的代理：我交给别人的（as_principal）+ 别人交给我的（as_agent） */
export async function mine(tx, { userId }) {
  await requireSession(tx, { userId, resource: 'punch' });   // 只要认证 + 一个所有人都有的资源
  const rows = (await tx.query(
    `SELECT g.id, g.principal_user, pu.display_name AS principal_name,
            g.agent_user, au.display_name AS agent_name,
            r.code AS role_code, r.name AS role_name,
            g.valid_from, g.valid_to, g.reason, g.revoked_at,
            (g.revoked_at IS NULL AND now() >= g.valid_from AND now() < g.valid_to) AS active
       FROM sys_acting_grant g
       JOIN sys_account pu ON pu.id = g.principal_user
       JOIN sys_account au ON au.id = g.agent_user
       JOIN sys_role r ON r.id = g.role_id
      WHERE g.principal_user = $1 OR g.agent_user = $1
      ORDER BY g.created_at DESC LIMIT 50`, [userId])).rows;
  return {
    as_principal: rows.filter((x) => Number(x.principal_user) === userId),
    as_agent: rows.filter((x) => Number(x.agent_user) === userId),
  };
}

/** 设定：agent 可以是账号 id，也可以是显示名（界面用名字更好填） */
export async function grant(tx, { userId, agent, role, days = 7, reason }) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 1 || d > 90) {
    throw bizErr('E_ARG_INVALID', '代理天数必须在 1–90 之间（再长就是改岗位，走人事流程）');
  }
  if (!reason || String(reason).trim().length < 4) {
    throw bizErr('E_ARG_INVALID', '必须写明代理原因（至少 4 个字）—— 到期回看时它是唯一解释');
  }
  let agentId = Number(agent);
  if (!Number.isInteger(agentId) || agentId <= 0) {
    const r = (await tx.query(
      `SELECT id FROM sys_account WHERE display_name = $1 ORDER BY id LIMIT 1`, [String(agent)])).rows[0];
    if (!r) throw bizErr('E_ACTING_NOT_FOUND', `找不到账号：${agent}`);
    agentId = Number(r.id);
  }
  const id = (await tx.query(
    `SELECT fn_acting_grant_set($1,$2,$3, now(), now() + ($4 || ' days')::interval, $1, $5) id`,
    [userId, agentId, role, String(d), String(reason)])).rows[0].id;
  return { id: Number(id), agent: agentId, role, days: d };
}

export async function revoke(tx, { userId, id }) {
  await tx.query('SELECT fn_acting_grant_revoke($1,$2)', [Number(id), userId]);
  return { revoked: Number(id) };
}
