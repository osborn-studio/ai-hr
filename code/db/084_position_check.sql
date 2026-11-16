-- ============================================================================
-- 084_position_check.sql · 岗位接口的判据组登记（083 只建了库侧组）
-- ----------------------------------------------------------------------------
-- 083 建了 SUITE.PS（库侧：一人多岗 / 不重叠 / 不自动授权），
-- 但"岗位清单接口"是另一条路径（组织页的数据源），它有自己的一组断言（PO1）。
-- 判据组必须先登记再写结论 —— fn_chk_record 对未登记的组会报错，
-- 而那个错恰恰是对的：一个没登记过的结论，覆盖率页上没地方放。
-- ============================================================================

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-PO','岗位清单接口：字段齐（岗位/部门/在岗）、空库返回空数组而不是 500',
   'ORG','STRUCT','fn_position_list','public','position','FUNCTION',
   'team-lead','2027-03-31','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
