-- ============================================================================
-- 062_schedule_debt.sql · 登记一条债：排班表没有写入路径（第八次「表在、门没有」）
-- ----------------------------------------------------------------------------
-- 008 建了 `schedule` / `schedule_segment` / `confirm_sheet` 三张表，还写了
-- 一整段关于"三态 vs 两态""零状态要派生"的论证 —— 但那三张表**没有任何写入路径**：
-- 只能靠种子插，或者直接 SQL。
--
-- 后果不是"少一个功能"，是**一条判据变成了假绿**：
--
--   看板的异常项 `CONFIRM_MISSING`（段缺确认单）数的是
--   `v_segment_missing_sheet`，而它由 `schedule_segment` LEFT JOIN 确认单派生。
--   段表只能靠种子写入 → 真实使用中段表永远是那几行 → 这条异常永远返回它该有的
--   那几个数，**永远不会因为"新排的班漏了确认单"而升高**。
--   一条永远不变的异常项，比没有这一项更坏：它看起来在工作。
--
-- 为什么这一轮**不做**，而不是"顺手补上"：
--   排班不是一张表的事。要做对，至少要回答四个问题，而每一个都是业务决定：
--     ① 班次（shift）主数据从哪来？现在 `schedule.shift_id` 连外键都没有。
--     ② 一段班拆几段、跨店支援怎么算（`schedule_segment.store_id` 与排班店不同）。
--     ③ 确认单的"本该谁确认、何时到期"由谁给（`confirm_owner_id` / `confirm_due_at`）。
--     ④ "超时自动确认"需要一个定时任务 —— 而本仓**没有任何调度器**，
--        把它写成"打开页面时顺带算一下"，就会变成"谁登录谁触发"，那不是定时。
--   这四个问题里 ③④ 会改动 008 已经定下的语义，不适合在收尾阶段猜着做。
--
-- 所以这条债**有名字、有主人、有到期日**，并且在自检页上显示为 never_run ——
-- 让"这块没做完"是可见的，而不是藏在注释里。
-- ============================================================================

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.SCH',
   '排班没有写入路径：schedule / schedule_segment / confirm_sheet 只能靠种子（CONFIRM_MISSING 因此恒为假绿）',
   'ATTENDANCE','STRUCT',
   'schedule','public','schedule','TABLE','team-lead','2027-03-31',
   'node test/run.mjs',
   -- 这条"判据"现在只能回答"表里有几行"，它**不证明排班能用** ——
   -- 而这正是债的内容：等写入路径补上，这里换成"计划 → 段 → 确认单"的断言。
   'SELECT count(*) FROM public.schedule')
ON CONFLICT (check_code) DO NOTHING;
