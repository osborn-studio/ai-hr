-- ===========================================================================
-- 040_check_group_aw.sql · 登记强制改密组（AW）
-- ===========================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-AW','强制改密：must_change 拦截 / 改密踢旧会话','SECURITY','ACL',
   'fn_sessions_revoke_others','public','sys_session','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
