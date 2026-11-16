-- ===========================================================================
-- 036_check_group_at.sql · 登记认证组（AT）
-- ===========================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-AT','认证：口令派生/失败计数/锁定/重置','SECURITY','ACL',
   'fn_auth_challenge','public','sys_user_credential','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
