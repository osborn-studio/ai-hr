-- ============================================================================
-- 123_approve_resource.sql · 审批是一个独立权限，不要求"能改考勤"
-- ----------------------------------------------------------------------------
-- 真跑时撞上的：人事主管（hr_ops）在权限矩阵里对 attendance_daily 只有**读**，
-- 于是月报提交后他点"通过"直接被 403 挡住。而"HR 做月报、主管批"正是客户的流程。
--
-- 两条修法，只有一条是对的：
--   ① 给 hr_ops 开 attendance_daily 写权限 —— 那他既能改数又能批，
--      而"改数的人不能批自己"这条规矩就被权限体系统开了；
--   ② 新开一个资源 `att_report_approve`：能批，不带"能改数"。
--
-- 选 ②。审批与修改本来就该分开：
--   · 能改数的人（门店、薪酬专员）改完提交；
--   · 能批的人看数、批或驳回 —— 他不需要、也不该有改数的权力。
--   把两者捆在一个资源上，等于把"审批"降级成"自己确认一下"。
-- ============================================================================

-- 资源字典的列是 resource_code / label / temporal_basis（没有 domain）
INSERT INTO sys_perm_resource(resource_code, label)
VALUES ('att_report_approve', '考勤月报提交与审批')
ON CONFLICT (resource_code) DO NOTHING;

-- 默认给：人事主管、门店负责人、副店长、薪酬、老板。
-- 与 attendance_daily 的差别只在"写"：读权限本来就有，写权限只用于流程动作。
INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
SELECT r.id, 'att_report_approve', true, true
  FROM sys_role r
 WHERE r.code IN ('boss','hr_ops','store_mgr','store_deputy','payroll_spec')
ON CONFLICT (role_id, resource_code)
  DO UPDATE SET can_read = true, can_write = true;

COMMENT ON TABLE sys_perm_resource IS
  '资源码字典。attendance_daily = 能改考勤数据；att_report_approve = 能提交/审批月报。'
  '两者分开：改数的人不该同时是批数的人，而"能批"不要求"能改"。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ATT6','月报审批权限独立于考勤修改权限（能批不必能改）',
   'ATTENDANCE','ACL','sys_perm_resource','public','sys_role_resource','TABLE',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
