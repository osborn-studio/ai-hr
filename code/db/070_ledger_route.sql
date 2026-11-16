-- ============================================================================
-- 070_ledger_route.sql · 多帐套路由：资源码 + 判据组（逻辑在 app/registry.mjs）
-- ----------------------------------------------------------------------------
-- 069 把"建帐 = 开库"做通了，070 补两件配套的事：
--
--   ① `ledger` 资源码：开库是**最危险的一个写动作**（它在数据库服务器上建库、
--      跑迁移、建管理员）。默认只给 admin 与帐套管理员 ——
--      不能因为"HR 能加门店"就顺手让他能开一个新公司。
--   ② 判据组 SUITE.RT：路由的三条性质（token 带帐套前缀、跨帐套被拒、
--      不存在的帐套不回落到默认库）。断言在 test/multi-ledger.test.mjs。
--
-- ★ 为什么路由逻辑不放在库里：它要读控制库、要按库名开连接池 ——
--   那是进程的事。库里能做的只有"登记哪个帐套连哪个库"（069 已做）。
-- ============================================================================

INSERT INTO sys_perm_resource(resource_code, label, temporal_basis) VALUES
  ('ledger', '帐套（开库/启用）', 'CURRENT')
ON CONFLICT (resource_code) DO NOTHING;

-- 只有这两个岗位能开库。其余岗位连"看清单"都走登录页的公开接口（只有编码与名称）。
INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
SELECT r.id, 'ledger', true, true FROM sys_role r
 WHERE r.code IN ('admin','acct_admin')
ON CONFLICT DO NOTHING;

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RT','多帐套路由：token 带帐套前缀、跨帐套被拒、不存在不回落到默认库',
   'ORG','ACL','fn_ledger_register','public','sys_ledger','FUNCTION',
   'team-lead','2027-03-31',
   'node test/multi-ledger.test.mjs',
   'SELECT count(*) FROM sys_ledger WHERE db_name IS NOT NULL')
ON CONFLICT (check_code) DO NOTHING;
