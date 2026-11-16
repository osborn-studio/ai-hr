-- ===========================================================================
-- 033_check_group_ar.sql · 登记审批接口组（AR）
-- ---------------------------------------------------------------------------
-- 与 029 / 031 同一个理由：fn_chk_record 拒绝记录未登记的判据码。
-- 未登记不是"红色"，是**不存在** —— 这一类失败比失败更难看。
-- ===========================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-AR','审批接口：发起/待办/审批/轨迹','INTEGRATION','ALGORITHM',
   NULL,NULL,NULL,NULL,'team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
