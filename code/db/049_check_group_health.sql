-- ============================================================================
-- 049_check_group_health.sql · 登记探针组（H）
-- ----------------------------------------------------------------------------
-- 判据：探针**必须能不带凭据访问**，而且不能顺带泄露 schema。
--
-- 这两条都是被真实事故逼出来的：
--   ① 探针要 token → 在 K8s/Docker 里永远是 unhealthy。于是健康检查被删掉，
--      然后"服务挂了没人知道"。Dockerfile 里当初刻意不写 HEALTHCHECK，
--      理由就是"别加一个假的"，而正确做法是补一个不需要认证的端点。
--   ② 探针返回太多 → 它是最容易被外部扫到的端点。表名、连接串、迁移版本
--      这类信息对外部没有任何用处，对攻击者很有用。
-- ============================================================================
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-H','探针：/livez 与 /readyz（免认证、不泄露 schema）','INTEGRATION','ACL',
   NULL,NULL,NULL,NULL,'team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
