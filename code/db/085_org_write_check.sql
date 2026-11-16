-- ============================================================================
-- 085_org_write_check.sql · 组织写入接口的判据组登记
-- ----------------------------------------------------------------------------
-- 组织页从这一版起有「＋ 新增部门」这个入口（POST /api/org）。这件事有三条
-- 会咬人的地方，而它们都要有判据组可写结论：
--
--   ① 建出来的部门必须落在**当前帐套自己的库**里（一帐套一库，不是靠过滤）；
--   ② 父层级非法（部门下面挂区域）必须**有名字地拒**，不能 500、更不能默默建；
--   ③ 没有建帐权限的身份要 403 —— "能看这棵树"不等于"能改这棵树"。
--
-- 组必须先登记再写结论（084 已经踩过一次：未登记的组 fn_chk_record 会报错，
-- 而那个错恰恰是对的——一个没登记过的结论，覆盖率页上没地方放）。
-- ============================================================================

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-OG','组织写入接口：建部门落当前库、父层级非法有名字地拒、无权身份 403',
   'ORG','ACL','fn_org_add','public','org_unit','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;

COMMENT ON TABLE org_unit IS
  '组织单元（部门可嵌套）。每个帐套一个库，所以"各自帐套的组织架构"是物理隔离的结果，'
  '不是靠 org_id 过滤出来的 —— 建部门（fn_org_add）只会写进当前库。';
