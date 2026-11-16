-- ============================================================================
-- 171_payroll_pack.sql · 判据登记：按门店批量打包工资单
-- ----------------------------------------------------------------------------
-- 这个任务没有 DDL（不动表、不动函数）—— 它加的是一个**读接口**与一个 zip 写出器。
-- 但没有 DDL 不等于没有结构要说清：两条判据在这里登记，理由和 170 一样：
-- **判据写了但不登记，等于没写**（覆盖率页读不到它，下一轮审计就少一条）。
--
-- ★ 为什么这个任务需要判据：打包是"整批出数"的入口，而 71ce396 刚被抓出的
--   四处越权里有两处正是"换了个出口、掩码与行闸就没了"（页面掩了、CSV 明文；
--   页面 1 人、导出 2 行）。同一个形态的第三个出口就是这次的 zip ——
--   所以它必须有一条**钉住"同口径"的判据**，而不是靠下次审计再发现一遍。
--
-- 两条的分工：
--   ① SUITE.ZIP      包本身的形状：文件数 = 门店数、文件名带期间与门店名、
--                    不含非法字符、包能解、解出来的单与单份打印同源。
--                    它守的是"财务拿到包能直接发货"这件事，
--                    而失败形态不是报错，是**少一家店 / 文件名乱码**。
--   ② SUITE.API-ZIP  权限口径：包里不许有本店以外的人（行闸 fn_scope_people），
--                    看不到实发的人包里那份必须是 null（字段掩码 fn_field_action，
--                    场景 export）。它守的是 71ce396 那一类越权。
--
-- ★ guard 怎么填才不撒谎：
--   ① 的文件数判据有真的结构依托 —— payslip 的
--      UNIQUE (pay_run_id, employee_id)（同一人同一批次只能一张工资条），
--      于是"按门店分组"不会因为重复行凭空多出一家店。所以它指向那个约束，
--      状态是 ok（不是债）。
--   ② 的行闸依托是 fn_scope_people()，与 170 的 SUITE.SCOPE-P 指向同一处、
--      同样的 guard_kind 写法：解析器只认 CONSTRAINT/TRIGGER/INDEX，
--      函数不在其中，因此它在 v_chk_guard_unbacked 里显示为 guard_missing ——
--      这与 170 的既有状态一致，是**已知且登记在案**的表示法限制，
--      不是新欠的债。真要修，改的是解析器（给 FUNCTION/VIEW 加分支），
--      那是另一轮的事，不在这个任务里偷偷扩枚举。
-- ============================================================================

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ZIP',
   '工资单打包：包内文件数 = 该期间有工资条的门店数（空门店不出文件），'
   '文件名带期间与门店名且不含 / \ : * ? " < > |',
   'PAYROLL','ALGORITHM',
   'payslip_pay_run_id_employee_id_key','public','payslip','CONSTRAINT',
   'team-lead','2027-06-30','node test/pack.mjs','node test/pack.mjs')
ON CONFLICT (check_code) DO NOTHING;

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-ZIP',
   '打包不成为权限绕过的口子：包里只有本店的人（fn_scope_people 行闸）、'
   '看不到实发的人包里那份也是 null（fn_field_action 场景 export）',
   'PERM','ACL',
   'fn_scope_people','public','employee_org_assignment','FUNCTION',
   'team-lead','2027-06-30','node test/pack.mjs','node test/pack.mjs')
ON CONFLICT (check_code) DO NOTHING;
