-- ===========================================================================
-- 029_check_group_w.sql · 登记新的断言组（写路径）
-- ---------------------------------------------------------------------------
-- fn_chk_record 会拒绝记录未登记的判据码（E_CHK_UNREGISTERED）：
-- "允许它写，就等于允许跑一条没人知道的检查"。
--
-- 所以每加一组断言，必须先在这里登记一行 —— 否则整组结论写不进登记表，
-- 而覆盖率报告上它只是**不存在**，不是红的。这类"看不见的失败"是这张表
-- 存在的理由，也是它自己最容易犯的错（我这次就是先写断言、跑出来
-- `P0001 E_CHK_UNREGISTERED` 才回头补的登记）。
--
-- 债分支：这一组没有触发器/约束替它挡（行闸在服务层，靠的是"每条写路径都调"），
-- 所以必须写清认领人与到期日，不能借 guard_object 混过去。
-- ===========================================================================

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-AG','写路径：行闸/事务/资源码/留痕/逐级下分','PERM','ACL',
   NULL,NULL,NULL,NULL,'team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
