-- ===========================================================================
-- 044_check_group_am.sql · 登记限流组（AM）
-- ===========================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-AM','限流：按账号计写操作，超限即拒且不自我放大','SECURITY','ACL',
   'fn_rate_ok','public','app_request_log','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
