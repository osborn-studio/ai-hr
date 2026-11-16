-- ============================================================================
-- 095_import_check.sql · 导入与工资项接口的判据组登记
-- ----------------------------------------------------------------------------
-- 组必须先登记再写结论：fn_chk_record 对未登记的组会报错，而那个报错
-- 恰恰是对的 —— 一个没登记过的结论，覆盖率页上没地方放。
-- ============================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-SX','工资项与导入接口：逐行结论、找不到工号要点名、试算、代码校验',
   'PAYROLL','ACL','fn_formula_try','public','salary_import_row','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
