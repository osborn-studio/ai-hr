// ============================================================================
// tools/assign-roles.mjs · 按姓名分配岗位（含副职代理演示）
// ----------------------------------------------------------------------------
// 这是"上线第一天"要做的事：钉钉同步过来的人全是 store_staff（店员），
// 而真实企业里老板、店长、副店长、人事、薪酬各是不同岗位。
//
//   DATABASE_URL=postgres://.../aihr_demo node tools/assign-roles.mjs
//
// 规矩：
//   · **追加而不是替换**数据范围：新角色沿用这个人原来的数据范围（哪家店），
//     否则一换岗位他就看不到自己店了 —— 而那种错会被当成"权限没配上"。
//   · 换岗**不是删**：旧授权写 superseded_by 失效，历史可追。
//   · admin 不给人：它是"系统的"账号（用户原话），业务角色另给。
//   · 副店长的代理**由店长设定**（脚本里模拟店长操作），并写明起止 ——
//     这条就是 073 的用法示范，不是硬编码的权限。
// ============================================================================
import { createDb, withTx } from '../app/db.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('必须给 DATABASE_URL'); process.exit(2); }

// 姓名 → 角色（可以多个）。改这张表就能换人，不用改代码。
const PLAN = [
  { name: '示例员工', roles: ['boss'],        note: '老板：业务全权' },
  { name: '杨继勇', roles: ['store_mgr'],   note: '店长' },
  { name: '陈斌',   roles: ['store_deputy'], note: '副店长（主管不在时代理店长）', acting: 'store_mgr' },
  { name: '周杰',   roles: ['hr_ops'],      note: '人事主管' },
  { name: '闫妍',   roles: ['payroll_spec', 'hr_ops'], note: '薪酬/考勤/排班/招聘/绩效' },
];

const db = await createDb({ url });
await db.initSession();

const say = (...a) => console.log(...a);
const roleId = async (code) => {
  const r = (await db.query(`SELECT id FROM sys_role WHERE code=$1`, [code])).rows[0];
  if (!r) throw new Error(`角色 ${code} 不存在`);
  return Number(r.id);
};
const accountOf = async (name) => (await db.query(
  `SELECT a.id, a.login, a.display_name, m.person_id
     FROM sys_account a
     LEFT JOIN ext_person_map m ON m.account_id = a.id AND m.system_code='dingtalk'
    WHERE a.display_name = $1 ORDER BY a.id LIMIT 1`, [name])).rows[0];

const applied = [];
for (const p of PLAN) {
  const acc = await accountOf(p.name);
  if (!acc) { say(`✗ ${p.name}：库里没有这个账号（钉钉同步没覆盖到？）`); continue; }

  await withTx(db, async (tx) => {
    // 数据范围：沿用这个账号已有的 scope 行，但把**规则**指向他现在的部门 ——
    // 同步会把人的归属改到真实部门，若 scope 还指着旧门店，换了岗就看不到自己部门。
    const scope = (await tx.query(
      `SELECT data_scope_id FROM sys_user_role WHERE user_id=$1 ORDER BY id DESC LIMIT 1`,
      [acc.id])).rows[0]?.data_scope_id
      ?? (await tx.query(`SELECT id FROM sys_data_scope ORDER BY id LIMIT 1`)).rows[0]?.id;

    // ★ 老板的范围是**集团根**，不是他自己的部门：
    //   boss 要能看全公司；按部门给会让老板只看到人事行政部那 1 个人。
    const isBoss = p.roles.includes('boss');
    const org = isBoss
      ? (await tx.query(`SELECT id FROM org_unit WHERE parent_id IS NULL ORDER BY id LIMIT 1`)).rows[0]?.id
      : (await tx.query(
          `SELECT org_id FROM employee_org_assignment
            WHERE employee_id=$1 AND dim_code='attendance_org' AND valid_to IS NULL
            ORDER BY valid_from DESC LIMIT 1`, [acc.person_id])).rows[0]?.org_id;
    if (org) {
      await tx.query(
        `UPDATE sys_data_scope_rule SET value_ids = ARRAY[$2]::bigint[]
          WHERE data_scope_id=$1 AND dimension IN ('cost_org','attendance_org')`, [scope, org]);
    }

    // 旧授权失效。★ 分两种情况，因为"失效"不等于"删"：
    //   ① 从今天才生效的（同步时刚建的）→ 直接删：它一天都没生效过，
    //      留一行 [今天, 今天) 的空区间会撞 ck_ur_span_nonempty ——
    //      而那条约束是对的（空区间在 SQL 里既包含又排除，没人说得清）。
    //   ② 已经在生效的 → 写 superseded_by 并让它在**今天结束**：
    //      不是"昨天结束"，否则换岗那一天他会两头都没有。
    const ROLES = `('store_staff','store_deputy','store_mgr','hr_ops','payroll_spec','boss','group_hr')`;
    await tx.query(
      `DELETE FROM sys_user_role
        WHERE user_id=$1 AND superseded_by IS NULL
          AND effective_from >= app_today()
          AND role_id IN (SELECT id FROM sys_role WHERE code IN ${ROLES})`, [acc.id]);
    await tx.query(
      `UPDATE sys_user_role SET superseded_by = -1, effective_to = app_today()
        WHERE user_id=$1 AND superseded_by IS NULL
          AND effective_from < app_today()
          AND role_id IN (SELECT id FROM sys_role WHERE code IN ${ROLES})`, [acc.id]);

    // ★ 生效日用 `sys_today()`（UTC 系统日），**不是** `app_today()`（业务日）。
  //   082 已经把这件事定死了：授权是系统动作，不随业务时区变化。
  //   写成 app_today() 的后果实测过：凌晨 00:00–08:00（业务日已跨天、UTC 还没跨）
  //   新授的权会落成"明天生效" —— 表现为**刚给的权限不生效、第二天自己好了**，
  //   而日志里什么都没有。station-scope 那套夹具就是这么被抓出来的。
  for (const code of p.roles) {
      const rid = await roleId(code);
      await tx.query(
        `INSERT INTO sys_user_role(user_id, role_id, data_scope_id, grant_kind, grant_reason, effective_from)
         VALUES ($1,$2,$3,'ROLE',$4, public.sys_today())`,
        [acc.id, rid, scope, `岗位分配：${p.note}`]);
    }
  });
  applied.push({ ...p, account: acc });
  say(`✓ ${p.name.padEnd(4)} → ${p.roles.join(' + ')}  （登录名 ${acc.login}）`);
}

// ---------------------------------------------------------------------------
// 副店长：由店长设定"代理"，有起止时间（这里给 7 天，演示用）
// ---------------------------------------------------------------------------
const dep = applied.find((x) => x.acting);
if (dep) {
  const boss = applied.find((x) => x.roles.includes('store_mgr'));
  if (boss) {
    try {
      const id = (await db.query(
        `SELECT fn_acting_grant_set($1,$2,$3, now(), now() + interval '7 days', $1, $4) id`,
        [boss.account.id, dep.account.id, dep.acting, `${boss.name}外出：${dep.name}代管门店`])).rows[0].id;
      say(`\n✓ 代理 #${id}：${boss.name} → ${dep.name}（代理「店长」，7 天，由主管本人设定）`);
    } catch (e) {
      // ★ 重复设定会被 074 的排他约束拒（23P01）。这在重跑脚本时是正常的，
      //   不该看起来像失败 —— 但也**不能**静默当成功：要把"已有一条"说出来。
      const dup = /ex_ag_no_overlap|conflicting key/i.test(String(e.message));
      say(dup ? `\n· 代理已存在（杨继勇 → 陈斌，生效中），跳过重复设定`
              : `\n· 代理由 ${boss.name} 设定失败：${String(e.message).split('\n')[0]}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 汇总：每个账号最终能干什么（用判据回答，不是读配置猜）
// ---------------------------------------------------------------------------
say('\n角色与能力（fn_role_can 回答）');
const rows = (await db.query(
  `SELECT a.id, a.display_name, string_agg(r.code, ' + ' ORDER BY r.code) roles
     FROM sys_account a
     LEFT JOIN fn_effective_roles(a.id, app_today()) e ON true
     LEFT JOIN sys_role r ON r.id = e.role_id
    GROUP BY a.id, a.display_name ORDER BY a.id`)).rows;
const probe = ['payroll_run', 'payslip', 'attendance_daily', 'roster', 'perf_cycle', 'headcount', 'employee_roster'];
say('  账号'.padEnd(12) + '角色'.padEnd(26) + probe.map((x) => x.slice(0, 6).padEnd(7)).join(''));
for (const r of rows) {
  if (!r.roles) continue;                    // 没角色的账号（如 admin 之外的）跳过
  const cells = [];
  for (const res of probe) {
    const c = (await db.query(`SELECT fn_role_can($1,$2,'write') c`, [r.id, res])).rows[0].c;
    cells.push((c ? '写' : '·').padEnd(7));
  }
  say(`  ${String(r.display_name).padEnd(10)}${String(r.roles).padEnd(24)}${cells.join('')}`);
}

await db.close();
process.exit(0);
