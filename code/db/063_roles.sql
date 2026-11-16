-- ============================================================================
-- 063_roles.sql · 角色：权限模型缺的那一层（"能不能做这件事"）
-- ----------------------------------------------------------------------------
-- 到 063 为止，这套系统的权限只回答了三个问题：
--
--   ① **能看到哪些行**（四维行闸 + 数据范围 + deny）—— 很强
--   ② **哪些字段能看**（字段策略 + 掩码）—— 很强
--   ③ **能操作哪个组织**（020 的组织级授权）—— 有
--
-- 但少了最上面那一层：**这个人这个岗位上，允不允许碰这类资源**。
-- 于是"店员能不能算薪"这个问题的答案，取决于你有没有给他 payroll_legal_entity
-- 的范围 —— 而范围是"数据边界"，不是"职责边界"。把两者混为一谈的后果很具体：
-- 给一个店员配上"某门店"的数据范围（很自然的操作），他就自动拥有了
-- 算薪、封账、编制下达的全部能力。**没有一条断言会红**，因为每一层都"配对了"。
--
-- 这一层补的就是它：`sys_role`（角色）+ `sys_role_resource`（角色能碰哪些资源）。
-- 三条设计判断：
--
--   A. **角色是岗位，不是数据范围**。同一个 `store_mgr` 角色在 10 家店是 10 份
--      数据范围（由 sys_data_scope / 020 决定），但只有一份资源授权。
--      两者分开，才不会"给一个店长加范围"就顺手给了他算薪权。
--
--   B. **未登记 = 拒绝**。与资源码未登记同一个规矩：sys_perm_resource 里有的资源，
--      某个角色没有 sys_role_resource 行 → 该角色读不了。默认放行是权限系统
--      唯一不可接受的默认值。
--      ★ 但**已有角色必须显式补登记**（见下面第 4 节），否则升级当天所有人 403。
--
--   C. **can_read / can_write 分开**。老板与店长看得到，但不该能改；
--      只给一个布尔，就只能二选一：要么看不了，要么能改。
--
-- 与 `readonly_only` 的关系（001 的 sys_user_role.readonly_only）：
--   那是**临时授权**上的只读（代班、审计期），短期、可撤销；
--   这里是**岗位**上的只读（老板就该只读）。两者是"叠加"关系，不是替代。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 先把三个"基础资源"补登记进迁移（它们原来只在 server.mjs 的种子里）
-- ---------------------------------------------------------------------------
-- ★ 这是一个真实缺陷的修法：`attendance_daily` / `payslip` / `leave_request`
--   三个资源码从 001 起就只在**种子**里登记。于是"只跑迁移"的库（比如
--   测试里手工建库、或未来的部署脚本）里它们根本不存在 —— 而 064 的角色矩阵
--   要引用它们，就在 FK 上炸。炸出来的信息是 Key (resource_code)=(leave_request)
--   is not present，看起来像矩阵写错了码，其实是"这张表从没被谁补全过"。
--   资源码属于 schema 事实，不属于演示数据 —— 它必须在迁移里。
INSERT INTO sys_perm_resource(resource_code, label, temporal_basis) VALUES
  ('attendance_daily', '考勤人日', 'CURRENT'),
  ('payslip',          '工资条',   'CURRENT'),
  ('leave_request',    '请假单',   'CURRENT'),
  -- ★ 审批从 047 起**复用**了 'requisition' 这个资源码（当时的理由是"审批本身
  --   不新增数据域"）。加上岗位层之后这个复用变成了洞：能看招聘需求的人
  --   自动等于能审批，而"店员要能看自己的待办"就要给他招聘需求授权。
  --   现在单独登记：审批是审批，招聘是招聘。
  ('approval',         '审批',     'CURRENT')
ON CONFLICT (resource_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. 角色档案
-- ---------------------------------------------------------------------------
CREATE TABLE sys_role (
  id          bigint PRIMARY KEY,
  code        varchar(32) NOT NULL UNIQUE,
  name        varchar(48) NOT NULL,
  -- 超级角色：不受资源授权约束（只有一个：admin）。
  -- ★ 为什么必须有：谁来给 admin 授权？没有这一档，"配置权限的人"自己也会被锁在门外。
  is_super    boolean     NOT NULL DEFAULT false,
  description varchar(200),
  is_active   boolean     NOT NULL DEFAULT true,
  CONSTRAINT ck_sr_super_name CHECK (NOT is_super OR code = 'admin')
);

COMMENT ON COLUMN sys_role.is_super IS
  '超级角色不受 sys_role_resource 约束。只允许 admin 一行为 true（CHECK 守着）——'
  '"再开一个超级角色"必须是改约束，而不是加一行数据。';

INSERT INTO sys_role(id, code, name, description) VALUES
  (1, 'legacy_group_hr', '集团HR（历史角色）', '001 的种子角色，保留以兼容既有授权'),
  (2, 'legacy_store_hr', '门店HR（历史角色）', '001 的种子角色，保留以兼容既有授权'),
  -- ★ 4 号是审批模板里引用的角色（AI/AP 组的 fixture）。它没有档案行的话，
  --   fn_role_can 恒 false → 那批"按角色解析审批人"的断言会静默换人。
  --   给历史角色留位置，比改 fixture 安全：fixture 改了，测的就不是原来那件事了。
  (4, 'legacy_role_4',  '历史角色 4',    '审批模板引用的角色，保留以兼容既有 fixture')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. 角色 → 资源（读 / 写 分开）
-- ---------------------------------------------------------------------------
CREATE TABLE sys_role_resource (
  role_id       bigint      NOT NULL REFERENCES sys_role(id),
  resource_code varchar(64) NOT NULL REFERENCES sys_perm_resource(resource_code),
  can_read      boolean     NOT NULL DEFAULT false,
  can_write     boolean     NOT NULL DEFAULT false,
  -- 写必然蕴含读：允许写却读不到，会出现"改得动但看不见"的鬼状态
  CONSTRAINT ck_srr_write_implies_read CHECK (NOT can_write OR can_read),
  PRIMARY KEY (role_id, resource_code)
);

COMMENT ON TABLE sys_role_resource IS
  '角色能碰哪些资源。未登记 = 拒绝（与资源码未登记同一规矩）。'
  'can_write 蕴含 can_read —— 允许写却读不到，会造出"改得动但看不见"的状态。';

-- ---------------------------------------------------------------------------
-- 3. 判：这个账号能不能对这类资源做这件事
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_role_can(
  p_user     bigint,
  p_resource varchar,
  p_action   varchar DEFAULT 'read'      -- read | write
) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_ok boolean; v_readonly boolean;
BEGIN
  IF p_action NOT IN ('read','write') THEN
    RAISE EXCEPTION 'E_ROLE_ACTION: 动作只能是 read / write（收到 %）', p_action;
  END IF;

  -- ★ 角色来自**两处**：直接授权（sys_user_role）与组织继承（sys_org_grant）。
  --   只查前一处的话，020 那套"集团把权限授给组织"的账号会全班 403 ——
  --   而它们的授权是真的（数据范围也对），只是不在 sys_user_role 里。
  --   fn_effective_roles 就是这两处的并集，直接用它，不另写一遍。
  -- 超级角色：直接放行（它是唯一能改授权的人）
  IF EXISTS (SELECT 1 FROM public.fn_effective_roles(p_user, current_date) e
               JOIN public.sys_role r ON r.id = e.role_id
              WHERE r.is_super AND r.is_active)
  THEN RETURN true; END IF;

  SELECT bool_or(rr.can_read OR (p_action = 'write' AND rr.can_write))
    INTO v_ok
    FROM public.fn_effective_roles(p_user, current_date) e
    JOIN public.sys_role r ON r.id = e.role_id AND r.is_active
    JOIN public.sys_role_resource rr
      ON rr.role_id = e.role_id AND rr.resource_code = p_resource
   WHERE CASE p_action
           WHEN 'read'  THEN rr.can_read
           ELSE rr.can_write
         END;

  -- 临时只读授权（代班/审计）压掉写：两个"只读"来源叠加，不是二选一
  IF p_action = 'write' THEN
    SELECT true INTO v_readonly
      FROM public.fn_effective_roles(p_user, current_date) e
      JOIN public.sys_user_role ur
        ON ur.user_id = p_user AND ur.role_id = e.role_id AND ur.readonly_only
     LIMIT 1;
    IF COALESCE(v_readonly, false) THEN RETURN false; END IF;
  END IF;

  RETURN COALESCE(v_ok, false);        -- 未登记 = 拒绝
END;
$$;

COMMENT ON FUNCTION fn_role_can IS
  '岗位层面的资源授权（read / write）。未登记即拒绝。'
  '与四维行闸是两层：行闸管"哪些行"，这一层管"这类事"。'
  '两层都过才放行 —— 只有行闸时，给一个店员配上门店范围就等于给了他算薪权。';

-- ---------------------------------------------------------------------------
-- 4. 已有角色补登记（保持升级前的行为）
-- ---------------------------------------------------------------------------
-- ★ 这一步是"未登记即拒绝"的代价：升级前所有角色都能碰所有资源，
--   升级后必须把这份既有事实**显式写成数据**，否则升级当天所有人 403。
--   admin（超级）不需要行。
INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
SELECT r.id, res.resource_code, true, true
  FROM sys_role r CROSS JOIN sys_perm_resource res
 WHERE r.code IN ('legacy_group_hr','legacy_store_hr','legacy_role_4')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. 连锁餐饮的岗位矩阵（8 个角色）
-- ---------------------------------------------------------------------------
INSERT INTO sys_role(id, code, name, is_super, description) VALUES
  (10, 'admin',        '系统管理员',        true,  '唯一超级角色：管角色授权与系统参数'),
  (11, 'acct_admin',   '帐套管理员',        false, '建帐、组织与人员主数据、制度发布'),
  (12, 'boss',         '老板',              false, '全局只读：看板/报表/编制，不改数'),
  (13, 'group_hr',     '集团人事负责人',    false, '人事全模块（入职/离职/调动/花名册）'),
  (14, 'payroll_spec', '集团薪酬考勤专员',  false, '算薪/考勤封账/补账/结算，不看人事档案敏感字段'),
  (15, 'hr_ops',       '集团人事专员',      false, '招聘/入职/绩效日常业务'),
  (16, 'store_mgr',    '店长',              false, '本店考勤、请假审批、本店人员查看'),
  (17, 'store_staff',  '店员',              false, '只看自己：工资条、额度、请假')
ON CONFLICT (id) DO NOTHING;

-- 资源授权矩阵。逐条写，不写"全部"——"全部"会在新增资源的那天自动扩大范围，
-- 而扩大范围这件事必须有人明确同意。
INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write) VALUES
  -- 帐套管理员：组织、人员、制度、编制；**不含**工资条与算薪
  (11,'employee_roster',true,true),(11,'headcount',true,true),
  (11,'leave_request',true,true),(11,'requisition',true,true),
  (11,'attendance_daily',true,false),(11,'report',true,false),(11,'perf_cycle',true,true),
  -- 老板：全部只读（含工资条：老板要看人工成本；明细到人的薪资由字段掩码再挡一层）
  (12,'employee_roster',true,false),(12,'headcount',true,false),
  (12,'report',true,false),(12,'attendance_daily',true,false),
  (12,'payroll_run',true,false),(12,'payslip',true,false),
  (12,'settlement',true,false),(12,'perf_cycle',true,false),(12,'requisition',true,false),
  -- 集团人事负责人
  (13,'employee_roster',true,true),(13,'leave_request',true,true),
  (13,'requisition',true,true),(13,'perf_cycle',true,true),
  (13,'headcount',true,true),(13,'attendance_daily',true,true),
  (13,'report',true,false),(13,'payslip',true,false),
  -- 薪酬考勤专员：算薪/考勤/结算；人事档案只读
  (14,'payroll_run',true,true),(14,'payslip',true,true),
  (14,'attendance_daily',true,true),(14,'settlement',true,true),
  (14,'employee_roster',true,false),(14,'report',true,false),(14,'leave_request',true,false),
  -- 人事专员（日常+绩效）：招聘/入职/绩效；不碰算薪
  (15,'requisition',true,true),(15,'employee_roster',true,true),
  (15,'perf_cycle',true,true),(15,'leave_request',true,true),
  (15,'attendance_daily',true,false),(15,'headcount',true,false),(15,'report',true,false),
  -- 店长：本店考勤、请假审批、看本店人；不能算薪、不能改编制
  (16,'attendance_daily',true,true),(16,'leave_request',true,true),
  (16,'employee_roster',true,false),(16,'report',true,false),(16,'perf_cycle',true,true),
  -- 店员：只看自己那几样 + 自己的待办（审批要有，否则"待我审批"是空的）
  (17,'payslip',true,false),(17,'leave_request',true,true),
  (17,'attendance_daily',true,false),(17,'approval',true,true),
  -- 参与审批的岗位
  (13,'approval',true,true),(15,'approval',true,true),(16,'approval',true,true),
  -- 老板与薪酬专员看得到审批进度，但不该替人签字
  (12,'approval',true,false),(14,'approval',true,false)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RC','角色粒度：未登记即拒绝、写蕴含读、临时只读压写、超级角色唯一',
   'PERM','ACL',
   'fn_role_can','public','sys_role_resource','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
