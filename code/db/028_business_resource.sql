-- ===========================================================================
-- 028_business_resource.sql · 业务资源码登记（写路径的入场券）
-- ---------------------------------------------------------------------------
-- app_begin_scope 的第一个动作不是灌权限，是**查资源码**：
--
--   SELECT temporal_basis FROM sys_perm_resource WHERE resource_code = p_resource
--   IF v_temporal IS NULL THEN RAISE 'E_RESOURCE_UNREGISTERED'
--
-- 也就是说：一个没登记的资源码，会让 `app_begin_scope` 直接炸，
-- 而炸在**每一次**请求上 —— 不是"权限少了一点"，是"这个接口完全不可用"。
--
-- 001 里只登记了三条（考勤人日 / 工资条 / 请假单），因为这三种有读接口。
-- 后来加了算薪、招聘、绩效、编制、结算的**写**路径，它们同样要灌权限
-- （否则写之前的行闸读空临时表），于是也需要资源码。
--
-- ★ 规则：**凡调用 app_begin_scope 的接口，它的资源码必须在这里有一行。**
--   漏登记的失败形态是 500 E_RESOURCE_UNREGISTERED，看起来像服务故障，
--   实际是"少了一行 INSERT"。api.test 的 W0 用 SERVICES.RESOURCES 与这张表做差集。
-- ===========================================================================

INSERT INTO sys_perm_resource(resource_code, label, temporal_basis) VALUES
  ('payroll_run', '算薪批次',   'CURRENT'),
  ('requisition', '招聘需求',   'CURRENT'),
  ('perf_cycle',  '绩效周期',   'CURRENT'),
  ('headcount',   '编制预算',   'CURRENT'),
  ('settlement',  '外包结算',   'CURRENT')
ON CONFLICT (resource_code) DO NOTHING;

COMMENT ON TABLE sys_perm_resource IS
  '资源码登记表。app_begin_scope 会校验它；未登记的码不是"权限不足"，是接口直接不可用。';
