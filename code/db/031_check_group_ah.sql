-- ===========================================================================
-- 031_check_group_ah.sql · 登记会话组（AH）
-- ---------------------------------------------------------------------------
-- 与 029 同一个理由：fn_chk_record 拒绝记录未登记的判据码。
-- 每加一组断言必须先有一行，否则整组结论在覆盖率报告上**不存在**（不是红的）。
-- ===========================================================================

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-AH','会话：摘要存储/三态/不可延长/不可复活','SECURITY','ACL',
   NULL,NULL,NULL,NULL,'team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
