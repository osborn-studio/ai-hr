-- ============================================================================
-- 110_expense_trace.sql · 报销审批留痕（谁批的、什么时候）
-- ----------------------------------------------------------------------------
-- expense_claim 原来只有 status，改状态时不记人。后果很具体：
-- 财务问"这笔 3000 的差旅谁批的"，系统答不上来 —— 而报销是**最容易出事**的一类单
-- （金额小、频次高、和实际业务对不上时没人发现）。
--
-- 这一版补两列：approved_by / approved_at。改状态必须写明是谁。
--
-- ★ 为什么不直接接 approval 引擎：
--   审批引擎是通用的（模板 + 版本 + 任务 + 加签/转签/抄送），接它需要先定
--   "报销几级审、多少金额起审、谁审" —— 那是**客户的业务决策**，不是代码能替他定的。
--   在客户定下来之前，先保证"谁批的有记录"，比硬塞一个我猜的流程更负责。
--   （见 docs/22 第 4 节：接引擎需要哪三样东西。）
-- ============================================================================

ALTER TABLE expense_claim
  ADD COLUMN IF NOT EXISTS approved_by varchar(64),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

COMMENT ON COLUMN expense_claim.approved_by IS
  '谁做的状态决定（批/驳/付）。空 = 还没人处理。报销是最容易出事的一类单，必须能追到人。';

-- 有结论就必须有结论人与时间；反之亦然。三条状态里只有 pending 没有结论人。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ec_trace') THEN
    ALTER TABLE expense_claim ADD CONSTRAINT ck_ec_trace CHECK (
      (status = 'pending') = (approved_by IS NULL)
    );
  END IF;
END $$;

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.EX','报销留痕：有结论就必须有结论人与时间；pending 不许带结论人',
   'PAYROLL','ACL','expense_claim','public','expense_claim','TABLE',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
