-- ============================================================================
-- 180_payslip_own_rows_only.sql · 非 HR 只能看**自己那一行**工资条
-- ----------------------------------------------------------------------------
-- 用户原话："所有人自己只能看自己的，除了 hr 专职人员。"
--
-- 现状（改之前）：
--   u7  店长 /api/payroll/slips?run=1 → 200，**11 行（本店全部）**
--   u67 店员 /api/payroll/slips?run=1 → 200，**11 行（本店全部）**
--   u7  /api/payslip                  → 200，33 行（本店所有人 × 3 期）
-- 行闸（170）只回答"这家店你能不能看"，它从来没有回答"这**个人**你该不该看"。
-- 对一个门店岗位来说，那正好是两件事：本店的人他都该看到（排班、请假、花名册），
-- 但**薪资明细**是"这个人自己"的东西 —— 店长没有理由看下属的工资条。
--
-- ★ 为什么另立一个资源码，而不是按角色名判断：
--   177 立的规矩 —— 角色名不会因为权限被回收而自动失效（176 收掉老板写权限之后，
--   121 里那串角色名就静默变成空话）。所以这里判的是**能力**：
--   有 `payroll_slips_read_all` = 能看他人薪资；没有 = 只看自己。
--   以后新增一个角色，只要授这一条即可，不用改代码；忘授的后果是"只看自己"（fail-closed）。
--
-- ★ 授权面按"原有能力"推导，而不是手抄一份名单：
--   凡是**现在就能读 `payslip`** 的角色，除了店长 / 店员，都视为 HR 专职人员。
--   这样这条迁移不依赖 063 那张表的当前内容，也不会漏掉 legacy 角色
--   （测试种子里的集团HR/门店HR 就是 legacy_*，漏掉它们会让既有断言莫名其妙地红）。
--
-- ★ hr_ops 要顺带补 `payslip` 读：
--   063 的矩阵里 hr_ops 是"招聘/入职/绩效，不碰算薪"，**连 payslip 读都没有**。
--   而需求把 hr_ops 列进"能看他人"的那一侧 —— 只授 read_all 是不够的：
--   岗位层（assertRole）先拦，连这一行都进不来。所以这里补 read（不给 write）。
--   ★ 这是一次**放宽**（人事专员从此看得到工资条），不是修 bug；写在文件里备案。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 新资源码：能不能看"他人"的工资条
-- ---------------------------------------------------------------------------
INSERT INTO sys_perm_resource (resource_code, label, temporal_basis)
VALUES ('payroll_slips_read_all', '工资条：查看他人（非本人）的行', 'CURRENT')
ON CONFLICT (resource_code) DO NOTHING;

COMMENT ON TABLE sys_perm_resource IS
  '资源码字典。payroll_slips_read_all = 能看**他人**的工资条；'
  '没有这一条的角色，工资条接口只返回他自己那一行（180）。'
  '★ 它与 payslip（能不能进这个模块）是两层：能进模块 ≠ 能看别人。';

-- ---------------------------------------------------------------------------
-- 2. hr_ops 补 payslip 读（不给写）
-- ---------------------------------------------------------------------------
INSERT INTO sys_role_resource (role_id, resource_code, can_read, can_write)
SELECT r.id, 'payslip', true, false FROM sys_role r WHERE r.code = 'hr_ops'
ON CONFLICT (role_id, resource_code) DO UPDATE SET can_read = true;
-- ★ 只动 can_read：工资条是发下去让人签字确认的凭证，能改它等于能改签过字的数。

-- ---------------------------------------------------------------------------
-- 3. 授权面：原来能读 payslip 的角色，除店长/店员外都能看他人
-- ---------------------------------------------------------------------------
-- ★ 排除店长(store_mgr)与店员(store_staff)：这两个正是需求要收的对象。
--   店长仍然保留 `payslip` 读（175 给的）—— 他要能看到**自己**那一行。
INSERT INTO sys_role_resource (role_id, resource_code, can_read, can_write)
SELECT rr.role_id, 'payroll_slips_read_all', true, false
  FROM sys_role_resource rr
 WHERE rr.resource_code = 'payslip' AND rr.can_read
   AND rr.role_id NOT IN (SELECT id FROM sys_role
                           WHERE code IN ('store_mgr','store_staff'))
ON CONFLICT (role_id, resource_code) DO UPDATE SET can_read = true;

-- ---------------------------------------------------------------------------
-- 4. 「我是谁」：账号 → 人员
-- ---------------------------------------------------------------------------
-- ★ 账号 id 与人员 id **不是一回事**（leave.mjs 那段注释踩过：钉钉同步进来的帐套
--   让"账号 id 恰好等于人员 id"这个巧合失效，示例员工打开工资条落到下一个人头上）。
-- ★ 这里**故意不退回**"把 userId 当人员 id"：那是 leave.mjs 为了兼容测试与内部调用
--   留的口子，而工资条是钱 —— 认不出"我是谁"时正确的结果是**空列表**
--   （"你没有工资条"），不是"猜一个人然后把他的工资条给他看"。
CREATE OR REPLACE FUNCTION public.fn_my_person(p_user bigint)
RETURNS bigint
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT a.person_id FROM public.sys_account a WHERE a.id = p_user;
$$;

COMMENT ON FUNCTION fn_my_person IS
  '当前账号绑定的人员（sys_account.person_id）。没绑人 → NULL。'
  '★ 不退回"把账号 id 当人员 id"：认不出我是谁时，工资条应该返回空列表，'
  '而不是猜一个人把他的工资条给我看。';

-- ---------------------------------------------------------------------------
-- 5. 判据登记：不新增一行
-- ---------------------------------------------------------------------------
-- 由 test/perm-matrix.mjs 的 **PM6d / PM6e / PM6f** 钉住（店长与店员只看到自己那一行、
-- HR 类看全量、没绑人的账号返回 0 行而不是 403），按 id 前缀归组进 SUITE.PM。
