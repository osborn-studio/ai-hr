-- ===========================================================================
-- 140 · 发放回单：钱出去了，系统得知道
-- ===========================================================================
-- 139 之前，pay_run 的生命周期是 draft → sealed，然后**就没有下一步了**：
--   · ck_pr_status 允许 'paid'，但库、接口、界面都没有任何路径能置成 paid；
--   · 于是"这个月的工资发了没有"这个问题，系统答不出来 ——
--     只能靠人去翻银行流水和微信记录。
--
-- 这不是少一个字段，是少一个**事实**：封账（sealed）说的是"这批数定了"，
-- 发放（paid）说的是"钱已经到员工账上了"。两件事之间可能隔好几天，
-- 中间还可能因为银行退票重发 —— 合成一个状态就再也分不开。
--
-- 这一版只做三件事：
--   ① 记录发放（时间 / 操作人 / 方式 / 银行流水号）；
--   ② 回单总额与工资条实发合计对不上时**直接拒**（发错总额是最贵的错）；
--   ③ 导出一份实发清单给财务在网银里逐笔核对。
--
-- ★ 刻意不做：不存银行账号。账号留在网银与代发系统里，HR 系统不留一份
--   完整账号库 —— 那是最容易被整库拖走的东西，而它对算薪没有任何作用。
-- ===========================================================================

ALTER TABLE pay_run ADD COLUMN IF NOT EXISTS paid_at   timestamptz;
ALTER TABLE pay_run ADD COLUMN IF NOT EXISTS paid_by   varchar(64);
ALTER TABLE pay_run ADD COLUMN IF NOT EXISTS pay_method varchar(16);
ALTER TABLE pay_run ADD COLUMN IF NOT EXISTS pay_ref    varchar(64);

-- 与 ck_pr_sealed 同一条规矩：状态与时刻同生同灭。
-- 没有这条，会出现"paid 但没有发放时间"——那就是"发过了但不知道什么时候发的"。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pr_paid') THEN
    -- ★ 右边必须是 IS NOT NULL：写成 IS NULL 就变成"draft 也算违反"
    --   （false = true → false），加约束的那一刻整张表都过不去。
    --   与 ck_pr_sealed 的写法对照记：`(status='draft') = (sealed_at IS NULL)`。
    ALTER TABLE pay_run ADD CONSTRAINT ck_pr_paid
      CHECK ((status = 'paid') = (paid_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_pr_method') THEN
    ALTER TABLE pay_run ADD CONSTRAINT ck_pr_method
      CHECK (pay_method IS NULL OR pay_method IN ('bank','cash','manual'));
  END IF;
END $$;

COMMENT ON COLUMN pay_run.paid_at IS
  '实际发放时间。与 status=''paid'' 同生同灭：封账说"数定了"，发放说"钱到了"，两件事分开记。';
COMMENT ON COLUMN pay_run.pay_ref IS
  '银行流水号/代发批次号（对账时唯一的锚点）。不存员工银行账号 —— 账号留在网银里。';

-- ---------------------------------------------------------------------------
-- 登记发放
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_pay_run_pay(
  p_run bigint, p_by text, p_method varchar, p_ref text DEFAULT NULL,
  p_total numeric DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r       record;
  v_sum   numeric(14,2);
  v_n     int;
BEGIN
  SELECT * INTO r FROM public.pay_run WHERE id = p_run FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'E_RUN_NOT_FOUND: %', p_run; END IF;

  IF r.status = 'paid' THEN
    RAISE EXCEPTION 'E_RUN_ALREADY_PAID: 批次 % 已于 % 标记发放（%），不能重复登记',
      p_run, to_char(r.paid_at, 'YYYY-MM-DD HH24:MI'), COALESCE(r.pay_ref, '无流水号');
  END IF;
  IF r.status <> 'sealed' THEN
    RAISE EXCEPTION 'E_RUN_NOT_SEALED: 批次 % 还是 % 状态，先封账再登记发放 —— '
      '没封账就发钱，等于按一份还会变的数发', p_run, r.status;
  END IF;
  IF COALESCE(p_method, '') NOT IN ('bank', 'cash', 'manual') THEN
    RAISE EXCEPTION 'E_PAY_METHOD: 发放方式只能是 bank / cash / manual（收到 %）', p_method;
  END IF;

  SELECT COALESCE(sum(net_amount), 0), count(*) INTO v_sum, v_n
    FROM public.payslip WHERE pay_run_id = p_run;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'E_PAY_EMPTY: 批次 % 没有工资条', p_run;
  END IF;

  -- ★ 回单总额与工资表实发合计不一致 → 拒。
  --   这是发薪里最贵的一种错：差的钱会落到某个人头上，而没人会主动说自己多收了。
  --   容差 1 分（银行按分入账），超过就一定是有一边错了。
  IF p_total IS NOT NULL AND abs(p_total - v_sum) > 0.01 THEN
    RAISE EXCEPTION 'E_PAY_TOTAL_MISMATCH: 回单总额 % 与工资表实发合计 % 不一致（差 %）——'
      '先查清哪一边错了，不要先把状态改成已发',
      round(p_total, 2), v_sum, round(p_total - v_sum, 2);
  END IF;

  UPDATE public.pay_run
     SET status = 'paid', paid_at = clock_timestamp(), paid_by = p_by,
         pay_method = p_method, pay_ref = NULLIF(btrim(COALESCE(p_ref, '')), '')
   WHERE id = p_run;
END;
$$;

COMMENT ON FUNCTION fn_pay_run_pay IS
  '登记发放：只允许 sealed → paid，记时间/操作人/方式/流水号；'
  '回单总额与实发合计不一致时拒（发错总额是发薪里最贵的错）。不存员工银行账号。';

-- ---------------------------------------------------------------------------
-- 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.PAYR','发放回单：只有封账后才能登记、不能重复登记、回单总额与实发合计不一致就拒',
   'PAYROLL','ALGORITHM','fn_pay_run_pay','public','pay_run','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-PAYR','发放接进界面：登记回单后状态变 paid、实发清单能导出',
   'PAYROLL','ACL','fn_pay_run_pay','public','pay_run','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
