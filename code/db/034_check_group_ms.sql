-- ===========================================================================
-- 034_check_group_ms.sql · 登记开放层接口组（MS）
-- ===========================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-MS','开放层：两阶段写（预览/摘要/一次性/阈值）','SECURITY','ACL',
   'fn_mcp_execute','public','sys_mcp_plan','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
