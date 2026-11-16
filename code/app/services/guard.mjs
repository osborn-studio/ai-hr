// ============================================================================
// app/services/guard.mjs · 写路径的行闸：与读**同一套**判据
// ----------------------------------------------------------------------------
// 这一层的存在理由，是原来那张代码里最危险的空白：
//
//   读路径（/api/attendance）走四维临时表 + 行闸；
//   写路径（算薪 / 封账 / 发 offer / 封绩效）**什么都没查**。
//
// 于是"看不到"不等于"改不了"：一个四维全空的账号，查考勤 0 行，
// 却可以发起一次全集团的算薪。这个洞不会在演示里暴露，因为演示总是用
// 权限最大的那个账号。
//
// 规矩（和封账那条一样）：**写操作判断"你能不能动这个对象"，
// 用的是读用的那四张临时表**。另开一套"写权限"判据，就会有两套范围模型，
// 而它们必然不同步 —— 不同步的那一天，通常是加了一个新维度的时候。
// ============================================================================
import { bizErr } from '../errors.mjs';

/**
 * 灌权限 + 判这一个组织在不在范围内。
 *
 * ★ 顺序不能反：先 app_begin_scope，再判。反了就是拿上一次请求的临时表在判，
 *   而那个结果既不报错也不为空——它只是**别人的范围**。
 *
 * @param dim 维度码。四维里该用哪一个，由对象本身决定，不由调用方随手选：
 *            考勤/门店 → cost_org；发薪 → payroll_legal_entity。
 *            选错的后果是"查得到但改不了"或反过来，两种都很难查。
 */
export async function requireOrg(tx, { userId, resource, orgId, dim = 'cost_org', factFrom = null, action = 'read' }) {
  // ① 岗位层：这个角色允不允许碰这类资源（064）
  await assertRole(tx, { userId, resource, action });
  // ② 数据层：灌四维临时表
  await tx.query('SELECT app_begin_scope($1,$2,$3)', [userId, resource, factFrom]);

  // ★ 维度有两种 kind：org（`cost_org` 这类）落 tmp_scope_org，
  //   entity（`payroll_legal_entity` / `si_entity`）落 tmp_scope_entity ——
  //   **两张表**。只查一张的后果是对另一半维度恒判 403：
  //   集团 HR 明明有发薪法人的范围，却"无权"算自己的薪。
  //   这里按登记表取 kind，不按维度名硬编码（新增维度不用改这里）。
  const kind = (await tx.query(
    'SELECT kind FROM sys_perm_dim WHERE code = $1', [dim])).rows[0]?.kind;
  if (!kind) throw bizErr('E_PERM_DIM_UNSUPPORTED', `维度 ${dim} 未登记`);

  const table = kind === 'org' ? 'pg_temp.tmp_scope_org' : 'pg_temp.tmp_scope_entity';
  const col = kind === 'org' ? 'org_id' : 'entity_id';

  const r = await tx.query(
    `SELECT 1 FROM ${table} s
      WHERE s.dim_code = $1 AND s.${col} = $2
        AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                         WHERE d.dim_code = $1 AND d.${col} IS NOT NULL
                           AND d.${col} = $2)`,
    [dim, orgId]);

  if (r.rows.length === 0) {
    throw bizErr('E_OUT_OF_SCOPE', `无权操作对象 ${orgId}（维度 ${dim}）`);
  }
}

/**
 * 只要"灌了权限"、不判具体对象 —— 给集团级写操作（绩效封存、结算确认）用。
 * ★ 这类对象没有组织维度，但不能因此**完全不灌**：
 *   不灌的话，下一步业务 SQL 里的行闸读的是空临时表，
 *   于是"集团操作"悄悄变成"什么都看不到"，而错误看起来像数据问题。
 */
export async function requireSession(tx, { userId, resource, factFrom = null, action = 'read' }) {
  await assertRole(tx, { userId, resource, action });
  await tx.query('SELECT app_begin_scope($1,$2,$3)', [userId, resource, factFrom]);
}

/**
 * 岗位层判据：能不能碰这类资源（与"能不能看这些行"是两层）。
 * ★ 为什么放在 guard 而不是库里的行闸：行闸回答"哪些行"，
 *   回答不了"这类事该不该由这个岗位做" —— 一个店长有本店的行范围，
 *   不等于他该能算薪。两层都过才放行。
 */
async function assertRole(tx, { userId, resource, action }) {
  const ok = (await tx.query('SELECT fn_role_can($1,$2,$3) o', [userId, resource, action])).rows[0].o;
  if (!ok) {
    throw bizErr('E_RESOURCE_FORBIDDEN',
      `当前角色没有 ${action === 'write' ? '修改' : '查看'}「${resource}」的授权（岗位权限，见 064）`);
  }
}

/** 读：灌权限，不判对象（行闸自己会在 SQL 里过滤） */
export const prepareRead = requireSession;
