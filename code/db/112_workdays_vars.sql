-- ============================================================================
-- 112_workdays_vars.sql · 把"当月该来几天""排了几班"交给公式
-- ----------------------------------------------------------------------------
-- 111 让应出勤（WORK_DAYS）变成当月实际工作日（一般 22），但公式里还是只能看到
-- WORK_DAYS 一个数。而客户真正要写的判断常常是：
--
--   if(PRESENT_DAYS >= CALENDAR_DAYS - 1, ...)   -- 缺 1 天以内算全勤
--   if(WORK_DAYS < CALENDAR_DAYS, ...)           -- 排班比日历少（轮班/短月）
--
-- 所以把这两个数也铺进变量：
--   CALENDAR_DAYS  当月日历工作日（周一~周五，扣法定假、加调休）—— 一般 22
--   ROSTER_DAYS    本期排班天数（非休息班），没排班为 0
--
-- ROSTER_DAYS 为 0 是**有意义的信息**（"这期没排班"），不是缺陷：
-- 公式可以据此区分"没排班"与"排了但没来"，比拿一个 0 去猜要诚实。
--
-- ★ 这里的 fn_payroll_calc 必须从 105（最后一个改它的迁移）复制，不能从 103 ——
--   103 之前的版本没有多险种循环与专项附加扣除，抄错版本会把它们**静默回退**，
--   而症状是"社保少扣了一个险种"，没有任何报错。（本轮真踩了这一次。）
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_formula_check(p_formula varchar, p_allow jsonb DEFAULT NULL)
RETURNS varchar[]
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_vars varchar[] := ARRAY[]::varchar[];
  m text;
  v_funcs text[] := ARRAY['if','round','ceil','floor','abs','sqrt','power','mod',
                          'min','max','greatest','least','coalesce','max0','min0','prorata'];
  v_builtin text[] := ARRAY['MONTHLY','COMMISSION','PRESENT_DAYS','WORK_DAYS',
                            'LEAVE_DAYS','SI_BASE','TAX_THRESHOLD',
                            -- 出勤侧（111）：应出勤已是"当月实际工作日"，
                            -- 把它自己与排班天数也交给公式，才能写
                            -- "本月该来 X 天、实到 Y 天"这类判断
                            'CALENDAR_DAYS','ROSTER_DAYS',
                            -- 结果侧：规则的判断对象
                            'GROSS','NET','SI_EMPLOYEE','IIT','LEAVE_DEDUCT','PERF_BONUS'];
BEGIN
  IF p_formula IS NULL OR btrim(p_formula) = '' THEN
    RAISE EXCEPTION 'E_FORMULA_EMPTY: 公式不能为空';
  END IF;

  IF p_formula LIKE '%--%' OR p_formula LIKE '%/*%' OR p_formula LIKE '%*/%' THEN
    RAISE EXCEPTION 'E_FORMULA_CHAR: 公式里不能出现 -- 或 /* */（注释符会把后面的算式吞掉）';
  END IF;

  IF p_formula !~ '^[0-9A-Za-z_+\-*/().,<>!=[:space:]]+$' THEN
    RAISE EXCEPTION 'E_FORMULA_CHAR: 公式里只能有数字、项目代码、函数、运算符号与括号（收到：%）', p_formula;
  END IF;

  IF (length(p_formula) - length(replace(p_formula, '(', '')))
     <> (length(p_formula) - length(replace(p_formula, ')', ''))) THEN
    RAISE EXCEPTION 'E_FORMULA_PAREN: 括号不配平（%）', p_formula;
  END IF;

  FOR m IN
    SELECT DISTINCT (regexp_matches(p_formula, '[A-Za-z_][A-Za-z0-9_]*', 'g'))[1]
  LOOP
    IF lower(m) IN ('and', 'or', 'not') THEN
      CONTINUE;
    END IF;
    IF p_formula ~* ('\m' || m || '\M\s*\(') THEN
      IF NOT (m = ANY (v_funcs)) THEN
        RAISE EXCEPTION 'E_FORMULA_FUNC: 没有这个函数「%」（可用函数见 fn_formula_funcs）', m;
      END IF;
      CONTINUE;
    END IF;
    IF m = ANY (v_builtin) THEN
      v_vars := v_vars || m::varchar;
      CONTINUE;
    END IF;
    IF p_allow IS NOT NULL AND p_allow ? m THEN
      v_vars := v_vars || m::varchar;
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'E_FORMULA_VAR: 公式里用了没登记的项「%」', m;
  END LOOP;

  RETURN v_vars;
END;
$$;

;

CREATE OR REPLACE FUNCTION fn_formula_probe(p_allow jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT (SELECT COALESCE(jsonb_object_agg(key, 1), '{}'::jsonb)
            FROM jsonb_object_keys(
              COALESCE(p_allow, '{}'::jsonb)
              || jsonb_build_object(
                   'MONTHLY',1,'COMMISSION',1,'PRESENT_DAYS',1,'WORK_DAYS',1,
                   'LEAVE_DAYS',1,'SI_BASE',1,'TAX_THRESHOLD',1,
                   'CALENDAR_DAYS',1,'ROSTER_DAYS',1,
                   'GROSS',1,'NET',1,'SI_EMPLOYEE',1,'IIT',1,
                   'LEAVE_DEDUCT',1,'PERF_BONUS',1)) AS k(key));
$$;

;

CREATE OR REPLACE FUNCTION fn_payroll_calc(p_run bigint)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r public.pay_run%ROWTYPE;
  e record;
  v_period_end date;
  v_base numeric(12,2);
  v_leave numeric(12,2);
  v_si_base numeric(12,2);
  v_si numeric(12,2);
  v_rate numeric(6,4);
  v_gross numeric(12,2);
  v_taxable numeric(14,2);
  v_cum_prev numeric(14,2);
  v_cum_paid_tax numeric(14,2);
  v_tax numeric(12,2);
  v_net numeric(12,2);
  v_threshold numeric(12,2);
  v_slip bigint;
  v_n int := 0;
  v_unclosed text;
  v_perf numeric(12,2);
  v_comm numeric(12,2);
  v_fixed_other numeric(12,2);
  v_struct_n int;
  v_extra jsonb;
  v_extra_sum numeric(12,2);
  v_amt numeric(12,2);
  v_vars jsonb;
  fi record;
  rl record;
  v_att record;
  v_deduct numeric(12,2);
  v_si_lines jsonb;
  si record;
  v_si_item numeric(6,4);
  v_si_one numeric(12,2);
  v_si_code varchar(32);
BEGIN
  SELECT * INTO r FROM public.pay_run WHERE id = p_run FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'E_RUN_NOT_FOUND: %', p_run; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'E_RUN_SEALED: 批次 % 已封账，不可重算', p_run;
  END IF;

  SELECT string_agg(u.store_id || '(' || u.why || ')', '、') INTO v_unclosed
    FROM public.fn_att_unclosed(r.period) u;
  IF v_unclosed IS NOT NULL THEN
    RAISE EXCEPTION 'E_ATT_NOT_CLOSED: 本期有考勤但未封账的门店：%。'
      '未封账即算薪，等于用一份还会变的数据发钱。', v_unclosed;
  END IF;

  IF EXISTS (SELECT 1 FROM public.perf_cycle c
              WHERE c.pay_period = r.period AND c.status <> 'sealed') THEN
    RAISE EXCEPTION 'E_PERF_NOT_SEALED: % 关联的绩效周期未封存，算薪会按一份还会变的分发钱',
      r.period;
  END IF;

  v_period_end := (to_date(r.period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date;
  SELECT threshold INTO v_threshold FROM public.tax_param WHERE year = left(r.period,4)::int;

  FOR e IN
    SELECT em.id AS employment_id, em.person_id, em.legal_entity_id
      FROM public.employment em
     WHERE em.legal_entity_id = r.legal_entity_id
       AND daterange(em.hire_date, em.leave_date, '[]') @> v_period_end
  LOOP
    SELECT s.monthly_amount INTO v_base
      FROM public.salary_standard s
     WHERE s.employment_id = e.employment_id AND s.effective_from <= v_period_end
     ORDER BY s.effective_from DESC LIMIT 1;
    IF v_base IS NULL THEN CONTINUE; END IF;

    v_leave := public.fn_leave_deduction(e.person_id, r.period);
    v_perf  := round(v_base * COALESCE(public.fn_perf_factor(e.person_id, r.period), 0), 2);
    v_comm  := public.fn_commission_amount(e.person_id, r.period);

    -- 公式项：按 sort_order 逐个算，后一个可以引用前一个的结果
    v_extra := '{}'::jsonb;
    v_extra_sum := 0;
    FOR fi IN
      SELECT code, formula FROM public.salary_item
       WHERE is_active AND formula IS NOT NULL AND btrim(formula) <> ''
       ORDER BY sort_order, code
    LOOP
      -- ★ 先把**所有已登记项目**铺成 0，再覆盖实际值。
      --   只传"这个人有的项"会在两种情况下炸掉整批算薪：
      --     ① 新员工还没拆结构（没有任何结构项）；
      --     ② 公式引用了别人有、他没有的项。
      --   而这两种都不是错误 —— 是"这个人这个月没有这一项"。
      -- 考勤口径（102）：出勤/应出勤/请假/工时/加班 五个数同源，
      -- 公式与规则都读这一份 —— 不允许从参数传天数，否则工资与考勤会有两个口径。
      v_att := public.fn_att_person_period(e.person_id, r.period);
      v_vars := (SELECT COALESCE(jsonb_object_agg(code, 0), '{}'::jsonb)
                   FROM public.salary_item WHERE is_active)
                || jsonb_build_object(
                     'MONTHLY', v_base,
                     'COMMISSION', v_comm,
                     'PRESENT_DAYS', v_att.present_days,
                     'WORK_DAYS', v_att.work_days,
                     'LEAVE_DAYS', v_att.leave_days,
                     'WORK_HOURS', v_att.work_hours,
                     'OT_HOURS', v_att.ot_hours,
                     'CALENDAR_DAYS', v_att.calendar_days,
                     'ROSTER_DAYS', v_att.roster_days)
                || v_extra
                || COALESCE((SELECT jsonb_object_agg(s.item_code, s.amount)
                               FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s),
                            '{}'::jsonb);
      -- 脚本求值：单行公式与多行脚本走同一个入口（内部按有无换行分流）
      v_amt := public.fn_formula_script_eval(fi.formula, v_vars);
      v_extra := v_extra || jsonb_build_object(fi.code, v_amt);
      v_extra_sum := v_extra_sum + v_amt;
    END LOOP;

    v_gross := v_base - v_leave + v_perf + v_comm + v_extra_sum;

    -- ★ before 规则**不在**这里跑：它必须"算之前拦"，而拦截一旦 RAISE，
    --   同事务里写下的命中记录也会跟着回滚 —— 于是"拦了但没有任何痕迹"。
    --   所以 before 规则由服务层在算薪前统一预跑、留痕，再决定是否开算（见 payroll.mjs）。

    -- 社保：按 si_policy 里**配置了**的险种逐个算（不写死养老一项）
    v_si := 0; v_si_lines := '{}'::jsonb;
    FOR si IN
      SELECT DISTINCT ON (item) item, rate_employee
        FROM public.si_policy
       WHERE city = '上海' AND effective_from <= v_period_end
         AND rate_employee > 0
       ORDER BY item, effective_from DESC
    LOOP
      v_si_one := round(public.fn_si_base('上海', si.item, v_base, v_period_end) * si.rate_employee, 2);
      v_si_code := CASE si.item
                     WHEN 'pension' THEN 'SI_PENSION'
                     WHEN 'medical' THEN 'SI_MEDICAL'
                     WHEN 'unemployment' THEN 'SI_UNEMPLOYMENT'
                     WHEN 'housing_fund' THEN 'SI_HOUSING_FUND'
                     ELSE NULL END;
      v_si := v_si + v_si_one;
      IF v_si_code IS NOT NULL THEN
        v_si_lines := v_si_lines || jsonb_build_object(v_si_code, v_si_one);
      END IF;
    END LOOP;

    -- ★ 养老必须有：缺它是配置漏了，不是"这个地区不缴养老"。
    --   其余险种缺省即跳过（外地户口不缴公积金是合法情形），但工资条上看得见没有。
    IF NOT (v_si_lines ? 'SI_PENSION') THEN
      RAISE EXCEPTION 'E_SI_POLICY_MISSING: 上海 养老保险 在 % 之前没有生效的政策', v_period_end;
    END IF;

    -- 专项附加扣除：只减计税基数，不减应发（它是"税前扣除"不是"扣款"）
    v_deduct := public.fn_tax_deduction(e.person_id, v_period_end);
    v_taxable := GREATEST(v_gross - v_si - v_threshold - v_deduct, 0);

    SELECT COALESCE(SUM(p.cum_taxable),0), COALESCE(SUM(p.tax_amount),0)
      INTO v_cum_prev, v_cum_paid_tax
      FROM public.payslip p JOIN public.pay_run pr ON pr.id = p.pay_run_id
     WHERE p.employee_id = e.person_id
       AND left(pr.period,4) = left(r.period,4)
       AND pr.period < r.period
       AND pr.status IN ('sealed','paid');

    v_tax := public.fn_iit_month(v_cum_prev + v_taxable, v_cum_paid_tax);
    v_net := v_gross - v_si - v_tax;

    -- 算薪**后**规则：此时 gross/net 都有了，可以查"实发为 0""个税异常高"
    v_vars := v_vars || jsonb_build_object(
                'GROSS', v_gross, 'SI_EMPLOYEE', v_si, 'IIT', v_tax, 'NET', v_net);
    FOR rl IN SELECT * FROM public.fn_salary_rule_run('after', v_vars) LOOP
      INSERT INTO public.salary_rule_hit(run_id, person_id, rule_code, stage, action, message, amount)
      VALUES (p_run, e.person_id, rl.rule_code, 'after', rl.rule_action, rl.rule_message, rl.amount);
    END LOOP;

    INSERT INTO public.payslip(pay_run_id, employee_id, gross_amount, net_amount,
                               si_employee, tax_amount, cum_taxable, leave_deduct,
                               special_deduction)
    VALUES (p_run, e.person_id, v_gross, v_net, v_si, v_tax, v_cum_prev + v_taxable, v_leave,
            v_deduct)
    ON CONFLICT (pay_run_id, employee_id) DO UPDATE
      SET gross_amount=EXCLUDED.gross_amount, net_amount=EXCLUDED.net_amount,
          si_employee=EXCLUDED.si_employee, tax_amount=EXCLUDED.tax_amount,
          cum_taxable=EXCLUDED.cum_taxable, leave_deduct=EXCLUDED.leave_deduct,
          special_deduction=EXCLUDED.special_deduction
    RETURNING id INTO v_slip;

    DELETE FROM public.payslip_item WHERE payslip_id = v_slip;

    SELECT count(*), COALESCE(sum(amount), 0) INTO v_struct_n, v_fixed_other
      FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s
     WHERE s.item_code <> 'BASE';

    IF v_struct_n > 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount)
      SELECT v_slip, s.item_code, s.amount
        FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s
       WHERE s.item_code <> 'BASE';
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip, 'BASE', v_base - v_fixed_other);
    ELSE
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'BASE', v_base);
    END IF;

    IF v_leave <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'LEAVE_DEDUCT', -v_leave);
    END IF;
    -- 社保明细：分险种各一行（历史工资条里的 SI_EMPLOYEE 行仍然保留，不动）
    FOR si IN SELECT key AS code, (value)::numeric AS amt FROM jsonb_each_text(v_si_lines) LOOP
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip, si.code, -si.amt);
    END LOOP;
    IF v_tax <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'IIT', -v_tax);
    END IF;
    IF v_perf <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'PERF_BONUS', v_perf);
    END IF;
    IF v_comm <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'COMMISSION', v_comm);
    END IF;

    -- 公式项：逐行入明细，顺序与求值一致（工资条上从上到下就是计算顺序）
    FOR fi IN
      SELECT code FROM public.salary_item
       WHERE is_active AND formula IS NOT NULL AND btrim(formula) <> ''
       ORDER BY sort_order, code
    LOOP
      IF v_extra ? fi.code THEN
        INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
          (v_slip, fi.code, (v_extra->>fi.code)::numeric);
      END IF;
    END LOOP;

    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'E_PAYROLL_NO_ELIGIBLE: 批次 % 一个人都没算出来（检查月薪标准与在职区间）', p_run;
  END IF;

  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_payroll_calc IS
  '算薪主过程。应发 = 月薪标准 − 事假扣款 + 绩效 + 提成 + 公式项；'
  '实发 = 应发 − 社保 − 个税。报销不进这里（不是工资）。'
  '公式内置变量：MONTHLY / COMMISSION / 已登记项目代码；'
  'PRESENT_DAYS 与 WORK_DAYS 暂固定为 0（出勤天数口径未接入，见 docs/19）。';
