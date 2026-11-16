-- ===========================================================================
-- 046_check_group_ao.sql · 登记代理接口组（AO）
-- ===========================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-AO','代理接口：本人设置 / 只看自己的 / 不代自己','INTEGRATION','ACL',
   'ex_ad_no_overlap','public','approval_delegate','CONSTRAINT','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
