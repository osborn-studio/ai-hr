-- ============================================================================
-- 136_payslip_diff.sql · 工资条环比：说清"这个月为什么少了 300"
-- ----------------------------------------------------------------------------
-- 这是 HR 被问得最多的一句话，而现在的答案只有"你自己看明细"。
-- 明细能看出每一项是多少，看不出**哪一项变了** —— 人要在十几行里逐行比对。
--
-- 这一版做两件事：
--   ① `fn_payslip_diff`：逐项对比本月与上月，标出 changed / added / removed；
--   ② `fn_payslip_explain`：把"为什么变"翻译成人话 ——
--      出勤天数变了、加班工时变了、调薪、社保调基、个税跳档、一次性项。
--
-- ★ 为什么解释要单独一个函数，而不是在前端拼：
--   前端拼解释只能看工资条自己（逐项差额），看不出"因为 7 月调基"这种跨表原因。
--   而"为什么"恰恰是员工问的那件事。差额是现象，归因才是答案。
--
-- ★ 归因只给**能对上账**的原因，不做猜测性的推断：
--   每一句都带具体数字（21 天 → 20 天、基数 8000 → 9500），
--   说不清的那部分就老实说"以下项目变化，原因需人工核对"，不硬编一个理由。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 逐项对比
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_payslip_diff(
  p_person bigint, p_period varchar, p_base varchar DEFAULT NULL
) RETURNS TABLE(
  item_code varchar, item_name varchar, prev_amount numeric, cur_amount numeric,
  diff numeric, kind varchar
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
-- ★ OUT 参数名与查询里的列名同名（item_code / kind / diff），PL/pgSQL 会优先当变量，
--   报 "column reference is ambiguous"。这句让列优先 —— 本函数里所有列引用都已用表别名限定，
--   是安全的；而重命名 OUT 会改掉接口契约。
DECLARE
  v_base varchar(7);
  v_cur  bigint;
  v_prev bigint;
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM（收到 %）', p_period;
  END IF;

  v_base := COALESCE(p_base,
    to_char((to_date(p_period || '-01','YYYY-MM-DD') - interval '1 month'), 'YYYY-MM'));

  SELECT p.id INTO v_cur
    FROM public.payslip p JOIN public.pay_run r ON r.id = p.pay_run_id
   WHERE p.employee_id = p_person AND r.period = p_period
   ORDER BY p.id DESC LIMIT 1;

  SELECT p.id INTO v_prev
    FROM public.payslip p JOIN public.pay_run r ON r.id = p.pay_run_id
   WHERE p.employee_id = p_person AND r.period = v_base
   ORDER BY p.id DESC LIMIT 1;

  -- 本月没有工资条：没有可比的基准，返回空（由 explain 给出说明）
  IF v_cur IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH c AS (
    SELECT i.item_code, SUM(i.amount) AS amt
      FROM public.payslip_item i WHERE i.payslip_id = v_cur GROUP BY 1
  ), pv AS (
    SELECT i.item_code, SUM(i.amount) AS amt
      FROM public.payslip_item i WHERE i.payslip_id = v_prev GROUP BY 1
  ), a AS (
    SELECT item_code FROM c UNION SELECT item_code FROM pv
  )
  SELECT a.item_code::varchar,
         COALESCE(si.name, a.item_code)::varchar,
         COALESCE(pv.amt, 0)::numeric,
         COALESCE(c.amt, 0)::numeric,
         (COALESCE(c.amt, 0) - COALESCE(pv.amt, 0))::numeric,
         (CASE WHEN pv.amt IS NULL THEN 'added'
               WHEN c.amt IS NULL THEN 'removed'
               WHEN c.amt <> pv.amt THEN 'changed'
               ELSE 'same' END)::varchar
    FROM a
    LEFT JOIN c  ON c.item_code  = a.item_code
    LEFT JOIN pv ON pv.item_code = a.item_code
    LEFT JOIN public.salary_item si ON si.code = a.item_code
   ORDER BY COALESCE(si.sort_order, 999), a.item_code;
END;
$$;

COMMENT ON FUNCTION fn_payslip_diff IS
  '本月与上月工资条逐项对比。kind: changed 变动 / added 本月新增 / removed 本月消失 / same 不变。'
  '按月默认比上月，也可以指定基准月（比如和调薪前那个月比）。';

-- ---------------------------------------------------------------------------
-- 2. 归因：把差额翻译成人话
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_payslip_explain(
  p_person bigint, p_period varchar, p_base varchar DEFAULT NULL
) RETURNS TABLE(seq int, code varchar, msg varchar)
LANGUAGE plpgsql
-- ★ 列名不能叫 text：它是类型名，引用时 PL/pgSQL 会解析成类型而不是列。
AS $$
#variable_conflict use_column
DECLARE
  v_base   varchar(7);
  v_cur    public.payslip%ROWTYPE;
  v_prev   public.payslip%ROWTYPE;
  v_n      int := 0;
  v_a      record;
  v_b      record;
  v_amt    numeric;
  v_t      record;
BEGIN
  v_base := COALESCE(p_base,
    to_char((to_date(p_period || '-01','YYYY-MM-DD') - interval '1 month'), 'YYYY-MM'));

  SELECT p.* INTO v_cur FROM public.payslip p
    JOIN public.pay_run r ON r.id = p.pay_run_id
   WHERE p.employee_id = p_person AND r.period = p_period
   ORDER BY p.id DESC LIMIT 1;
  IF v_cur.id IS NULL THEN
    RETURN QUERY SELECT 1, 'NO_PAYSLIP'::varchar,
      format('%s 没有这个人的工资条（未算薪，或当月不在职）', p_period)::varchar;
    RETURN;
  END IF;

  SELECT p.* INTO v_prev FROM public.payslip p
    JOIN public.pay_run r ON r.id = p.pay_run_id
   WHERE p.employee_id = p_person AND r.period = v_base
   ORDER BY p.id DESC LIMIT 1;
  IF v_prev.id IS NULL THEN
    RETURN QUERY SELECT 1, 'NO_BASE'::varchar,
      format('上一个月（%s）没有工资条，无法环比 —— 可能是新入职、上月未算薪，或当月才转正', v_base)::varchar;
    RETURN;
  END IF;

  -- ① 应发合计变了多少（这是员工最先看到的那个数）
  v_n := v_n + 1;
  RETURN QUERY SELECT v_n, 'GROSS'::varchar,
    format('应发合计 %s → %s（%s%s）',
           v_prev.gross_amount, v_cur.gross_amount,
           CASE WHEN v_cur.gross_amount >= v_prev.gross_amount THEN '+' ELSE '' END,
           v_cur.gross_amount - v_prev.gross_amount)::varchar;

  -- ② 出勤：从考勤月报取（HR 确认过的那份才是算薪口径）
  SELECT r.work_days, r.present_days, r.leave_days, r.absent_days, r.work_hours
    INTO v_a FROM public.att_period_report r
   WHERE r.person_id = p_person AND r.period = v_base AND r.status = 'confirmed';
  SELECT r.work_days, r.present_days, r.leave_days, r.absent_days, r.work_hours
    INTO v_b FROM public.att_period_report r
   WHERE r.person_id = p_person AND r.period = p_period AND r.status = 'confirmed';

  IF v_a.present_days IS NOT NULL AND v_b.present_days IS NOT NULL
     AND v_a.present_days <> v_b.present_days THEN
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'ATTENDANCE'::varchar,
      format('出勤天数 %s → %s 天（请假 %s → %s，旷工 %s → %s）',
             v_a.present_days, v_b.present_days, v_a.leave_days, v_b.leave_days,
             v_a.absent_days, v_b.absent_days)::varchar;
  END IF;

  -- ③ 加班工时：三档分开看，别混成一个总数
  SELECT * INTO v_a FROM public.fn_att_ot_split(p_person, v_base);
  SELECT * INTO v_b FROM public.fn_att_ot_split(p_person, p_period);
  IF COALESCE(v_a.weekday_ot,0) <> COALESCE(v_b.weekday_ot,0)
     OR COALESCE(v_a.restday_paid,0) <> COALESCE(v_b.restday_paid,0)
     OR COALESCE(v_a.holiday_ot,0) <> COALESCE(v_b.holiday_ot,0) THEN
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'OVERTIME'::varchar,
      format('加班工时变了：平日 %s→%s、休息日 %s→%s、法定节假日 %s→%s 小时',
             v_a.weekday_ot, v_b.weekday_ot, v_a.restday_paid, v_b.restday_paid,
             v_a.holiday_ot, v_b.holiday_ot)::varchar;
  END IF;

  -- ④ 调薪：月薪标准在本月或上月有新的生效记录
  IF EXISTS (SELECT 1 FROM public.salary_standard s
               JOIN public.employment e ON e.id = s.employment_id
              WHERE e.person_id = p_person
                AND s.effective_from > to_date(v_base || '-01','YYYY-MM-DD')
                AND s.effective_from <= to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day') THEN
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'BASE_CHANGE'::varchar,
      format('本月有新生效的月薪标准（%s 起）：底薪会按新标准算',
             (SELECT max(s.effective_from) FROM public.salary_standard s
                JOIN public.employment e ON e.id = s.employment_id
               WHERE e.person_id = p_person
                 AND s.effective_from <= to_date(p_period || '-01','YYYY-MM-DD')
                        + interval '1 month - 1 day'))::varchar;
  END IF;

  -- ⑤ 社保调基：申报基数在本月生效
  IF EXISTS (SELECT 1 FROM public.si_base_declare d
              WHERE d.employee_id = p_person
                AND d.effective_from > to_date(v_base || '-01','YYYY-MM-DD')
                AND d.effective_from <= to_date(p_period || '-01','YYYY-MM-DD')
                       + interval '1 month - 1 day') THEN
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'SI_BASE'::varchar,
      format('社保申报基数在本月生效：%s（上年度月平均 %s）—— 社保扣款因此变化',
             (SELECT d.base_amount FROM public.si_base_declare d
               WHERE d.employee_id = p_person
                 AND d.effective_from <= to_date(p_period || '-01','YYYY-MM-DD')
                        + interval '1 month - 1 day'
               ORDER BY d.effective_from DESC LIMIT 1),
             (SELECT d.monthly_avg FROM public.si_base_declare d
               WHERE d.employee_id = p_person
                 AND d.effective_from <= to_date(p_period || '-01','YYYY-MM-DD')
                        + interval '1 month - 1 day'
               ORDER BY d.effective_from DESC LIMIT 1))::varchar;
  END IF;

  -- ⑥ 一次性项：出现或消失（年假折现 / 年终奖 / 离职补偿）
  FOR v_t IN
    SELECT d.item_code, d.item_name, d.prev_amount, d.cur_amount, d.kind
      FROM public.fn_payslip_diff(p_person, p_period, v_base) d
     WHERE d.kind IN ('added','removed')
       AND d.item_code IN ('AL_CASHOUT','ANNUAL_BONUS','SEVERANCE','OT_PAY')
  LOOP
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'ONE_OFF'::varchar,
      format('%s%s：%s 元（不是每月都有的项）',
             v_t.item_name,
             CASE WHEN v_t.kind = 'added' THEN ' 本月出现' ELSE ' 本月消失' END,
             CASE WHEN v_t.kind = 'added' THEN v_t.cur_amount ELSE v_t.prev_amount END)::varchar;
  END LOOP;

  -- ⑦ 提成变了
  SELECT COALESCE(SUM(i.amount),0) INTO v_amt
    FROM public.payslip_item i
   WHERE i.payslip_id = v_cur.id AND i.item_code = 'COMMISSION';
  IF v_amt <> 0 THEN
    SELECT COALESCE(SUM(i.amount),0) INTO v_amt
      FROM public.payslip_item i
     WHERE i.payslip_id = v_prev.id AND i.item_code = 'COMMISSION';
    IF v_amt <> (SELECT COALESCE(SUM(i.amount),0) FROM public.payslip_item i
                  WHERE i.payslip_id = v_cur.id AND i.item_code = 'COMMISSION') THEN
      v_n := v_n + 1;
      RETURN QUERY SELECT v_n, 'COMMISSION'::varchar,
        format('销售提成从上月 %s 变为本月 %s', v_amt,
               (SELECT COALESCE(SUM(i.amount),0) FROM public.payslip_item i
                 WHERE i.payslip_id = v_cur.id AND i.item_code = 'COMMISSION'))::varchar;
    END IF;
  END IF;

  -- ⑧ 个税：累计预扣跳档（这是"应发没变、实发却少了"最常被问到的一种）
  IF v_cur.tax_amount <> v_prev.tax_amount THEN
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'IIT'::varchar,
      format('个税 %s → %s（累计预扣：累计应税 %s → %s，年度累计计税会随月份往上升档）',
             v_prev.tax_amount, v_cur.tax_amount,
             v_prev.cum_taxable, v_cur.cum_taxable)::varchar;
  END IF;

  -- ⑨ 说不清的部分：只报"还有哪些项变了"，不硬编原因
  IF EXISTS (SELECT 1 FROM public.fn_payslip_diff(p_person, p_period, v_base) d
              WHERE d.kind = 'changed'
                AND d.item_code NOT IN ('BASE','LEAVE_DEDUCT','OT_PAY','COMMISSION',
                                        'IIT','AL_CASHOUT','ANNUAL_BONUS','SEVERANCE',
                                        'PERF_BONUS','SI_PENSION','SI_MEDICAL',
                                        'SI_UNEMPLOYMENT','SI_HOUSING_FUND','SI_EMPLOYEE')) THEN
    v_n := v_n + 1;
    RETURN QUERY SELECT v_n, 'OTHER'::varchar,
      ('其余项目也有变动，逐项见对比表；上面列的是能对上账的原因，'
       '剩下的需要人工核对（比如手工调整、一次性补贴）')::varchar;
  END IF;

  RETURN;
END;
$$;

COMMENT ON FUNCTION fn_payslip_explain IS
  '环比归因：应发变化、出勤、加班、调薪、社保调基、一次性项、提成、个税跳档。'
  '每一句都带具体数字；对不上账的部分老实说"需要人工核对"，不硬编理由。';

-- ---------------------------------------------------------------------------
-- 3. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.DIFF','工资条环比：逐项标出变动、归因能对上账、上月没工资条时说清为什么',
   'PAYROLL','ALGORITHM','fn_payslip_diff','public','payslip_item','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-DIF','环比接进接口与界面：工资条页能直接看到与上月的差异',
   'PAYROLL','ACL','fn_payslip_explain','public','payslip','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
