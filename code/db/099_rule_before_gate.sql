-- ============================================================================
-- 099_rule_before_gate.sql · before 规则移到算薪之前（由服务层当门）
-- ----------------------------------------------------------------------------
-- 098 把 before 规则放在 fn_payroll_calc 里，命中就 RAISE。问题不在判据，
-- 在**留痕**：RAISE 让整个事务回滚，刚写下的 salary_rule_hit 一起消失 ——
-- 结果是"拦住了，但没有任何痕迹"，而"为什么这个人没算出来"就只剩一句
-- E_RULE_BLOCK，连是哪条规则都没留下。
--
-- 与 AG11（写路径失败留痕在事务外）同一条规矩：**拒绝的记录必须活得比拒绝久**。
--
-- 所以 before 规则改为在算薪之前由服务层统一预跑：
--   有 block → 写留痕、不算薪、把 blocked 列表返回给调用方；
--   无 block → 正常算。
-- after 规则仍留在函数里（它不拦，只留痕）。
-- ============================================================================

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
      v_vars := (SELECT COALESCE(jsonb_object_agg(code, 0), '{}'::jsonb)
                   FROM public.salary_item WHERE is_active)
                || jsonb_build_object(
                     'MONTHLY', v_base,
                     'COMMISSION', v_comm,
                     -- ★ 出勤天数暂未接入（没有"某人某期出勤天数"这个函数），
                     --   给 0 而不是给一个猜出来的数：公式写 PRESENT_DAYS 的人
                     --   会看到 0 并来问，而看到"看起来合理"的 21 天就不会问了。
                     'PRESENT_DAYS', 0,
                     'WORK_DAYS', 0)
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

    SELECT rate_employee INTO v_rate FROM public.si_policy
     WHERE city='上海' AND item='pension' AND effective_from <= v_period_end
     ORDER BY effective_from DESC LIMIT 1;
    IF v_rate IS NULL THEN
      RAISE EXCEPTION 'E_SI_POLICY_MISSING: 上海 养老保险 在 % 之前没有生效的政策', v_period_end;
    END IF;
    v_si_base := public.fn_si_base('上海','pension', v_base, v_period_end);
    v_si := round(v_si_base * v_rate, 2);

    v_taxable := GREATEST(v_gross - v_si - v_threshold, 0);

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
                               si_employee, tax_amount, cum_taxable, leave_deduct)
    VALUES (p_run, e.person_id, v_gross, v_net, v_si, v_tax, v_cum_prev + v_taxable, v_leave)
    ON CONFLICT (pay_run_id, employee_id) DO UPDATE
      SET gross_amount=EXCLUDED.gross_amount, net_amount=EXCLUDED.net_amount,
          si_employee=EXCLUDED.si_employee, tax_amount=EXCLUDED.tax_amount,
          cum_taxable=EXCLUDED.cum_taxable, leave_deduct=EXCLUDED.leave_deduct
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
    IF v_si <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'SI_EMPLOYEE', -v_si);
    END IF;
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
