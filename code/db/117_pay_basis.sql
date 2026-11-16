-- ============================================================================
-- 117_pay_basis.sql · 两种计薪基础：按人天 / 按工时
-- ----------------------------------------------------------------------------
-- 企业单位的计薪基础不只一种：
--   · 月薪制（按人天）：应发 = 月薪标准，缺勤按天扣 21.75 分之几日薪
--   · 小时制（按工时）：应发 = 时薪 × 实际工时，缺勤已经体现在工时里
-- 连锁餐饮两种人都在一起：店长月薪、店员小时工。所以它必须是**可配**的，
-- 而且能按人配（同一家公司两种并存），不是全公司一刀切。
--
-- 配置三层（越具体越优先）：
--   employment.pay_basis      个人（小时工就设这个）—— 空 = 跟下一层
--   policy PAY_BASIS          公司级默认（day = 上线前行为）
--
-- ★ 两种模式最关键的一条（也是唯一容易写错的一条）：
--   **按工时模式下不再另扣事假。** 缺勤已经从工时里扣掉了，事假扣款再扣一次
--   就是扣两次，而员工只会看到"这个月少了好几百"却查不出为什么。
--   所以 hour 模式 v_leave := 0，工资条上不会有 LEAVE_DEDUCT 那一行。
--
-- 折算口径（两种模式共用，不随月份变）：
--   日薪 = 月薪 ÷ 21.75（PAY_DAYS_PER_MONTH，月计薪天数）
--   时薪 = 月薪 ÷ (21.75 × 8)      —— 这是法定折算，不是"当月工作日"
-- 应出勤（WORK_DAYS，一般 22）用于判断满勤/折算比例，不当日薪分母 ——
-- 否则 2 月（20 天）与 12 月（23 天）请同一天假扣的钱不一样，那不合规。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 个人级计薪基础
-- ---------------------------------------------------------------------------
ALTER TABLE employment ADD COLUMN IF NOT EXISTS pay_basis varchar(8);

COMMENT ON COLUMN employment.pay_basis IS
  '计薪基础：day=按人天 / hour=按工时 / 空=跟公司制度 PAY_BASIS。'
  '小时工设 hour，其余留空即可。';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_emp_pay_basis') THEN
    ALTER TABLE employment ADD CONSTRAINT ck_emp_pay_basis
      CHECK (pay_basis IS NULL OR pay_basis IN ('day','hour'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. 公司级默认
-- ---------------------------------------------------------------------------
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor)
VALUES ('PAY_BASIS', '计薪基础（按人天 21.75 折算 / 按工时 时薪×实际工时）',
        'PAYROLL', 'enum', true, 'store')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('PAY_BASIS', '2026-01-01', 'day', 'system',
        '默认按人天（= 上线前行为）。小时工请在人员上单独设为 hour')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. 解析某人某期的计薪基础
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_pay_basis(p_person bigint, p_period varchar)
RETURNS varchar
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
           (SELECT e.pay_basis FROM public.employment e
             WHERE e.person_id = p_person
               AND daterange(e.hire_date, e.leave_date, '[]') @>
                   (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
             ORDER BY e.hire_date DESC LIMIT 1),
           (SELECT v.value_text FROM public.fn_policy_effective(
                      'PAY_BASIS', NULL,
                      (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date) v),
           'day');
$$;

COMMENT ON FUNCTION fn_pay_basis IS
  '某人某期的计薪基础：个人设置优先，其次公司制度，最后默认 day。'
  '按期间**期末**解析：月中改成小时工，从当月算薪起生效。';

-- ---------------------------------------------------------------------------
-- 4. 事假扣款：按工时模式返回 0（缺勤已在工时里）
-- ---------------------------------------------------------------------------
-- ★ 这里返回 0 不是"不算"，是"不重复算"。工资条上不会出现 LEAVE_DEDUCT 行，
--   而事假天数仍然在 LEAVE_DAYS 变量里，公式与规则都看得到。
CREATE OR REPLACE FUNCTION fn_leave_deduction(p_employee bigint, p_period varchar)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN public.fn_pay_basis(p_employee, p_period) = 'hour' THEN 0
    ELSE COALESCE(round(
           COALESCE(
             (SELECT r.personal_leave_days FROM public.att_period_report r
               WHERE r.period = p_period AND r.person_id = p_employee
                 AND r.status = 'confirmed'),
             public.fn_leave_approved_days(p_employee, p_period, 'PERSONAL'))
           * (SELECT s.monthly_amount
                   / GREATEST((SELECT COALESCE(value_num, 21.75)
                                 FROM public.fn_policy_effective(
                                      'PAY_DAYS_PER_MONTH', NULL,
                                      (to_date(p_period || '-01','YYYY-MM-DD')
                                       + interval '1 month - 1 day')::date)), 1)
                FROM public.salary_standard s
                JOIN public.employment e ON e.id = s.employment_id
               WHERE e.person_id = p_employee
               ORDER BY s.effective_from DESC LIMIT 1), 2), 0)
  END;
$$;

COMMENT ON FUNCTION fn_leave_deduction IS
  '事假扣款。day 模式 = 天数 × (月薪 ÷ 21.75)，天数优先取 HR 确认的月报；'
  'hour 模式 = 0：按工时计薪时缺勤已体现在工时里，再扣就是扣两次。';

-- ---------------------------------------------------------------------------
-- 5. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.BASIS','计薪基础：按人天/按工时两种模式，按人不按公司一刀切，工时模式不重复扣事假',
   'PAYROLL','ALGORITHM','fn_pay_basis','public','employment','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;

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
                            -- 结果侧：规则的判断对象
                            'GROSS','NET','SI_EMPLOYEE','IIT','LEAVE_DEDUCT','PERF_BONUS',
                            -- 计薪基础（117）：日薪/时薪/是否按工时/折算系数
                            'DAILY_RATE','HOURLY_RATE','PAY_BASIS_HOUR','HOUR_FACTOR'];
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
                   'DAILY_RATE',1,'HOURLY_RATE',1,'PAY_BASIS_HOUR',1,'HOUR_FACTOR',1,
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
  -- 计薪基础（117）：day=按人天 / hour=按工时
  v_monthly numeric(12,2);
  v_basis   varchar(8);
  v_days    numeric(6,2);
  v_std_h   numeric(6,2);
  v_daily   numeric(14,4);
  v_hourly  numeric(14,4);
  v_factor  numeric(10,6);
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

  -- 折算分母：月计薪天数（法定折算口径）与每日标准工时，两者都不随月份变
  SELECT COALESCE(value_num, 21.75) INTO v_days
    FROM public.fn_policy_effective('PAY_DAYS_PER_MONTH', NULL, v_period_end);
  SELECT COALESCE(value_num, 8) INTO v_std_h
    FROM public.fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, v_period_end);

  FOR e IN
    SELECT em.id AS employment_id, em.person_id, em.legal_entity_id
      FROM public.employment em
     WHERE em.legal_entity_id = r.legal_entity_id
       AND daterange(em.hire_date, em.leave_date, '[]') @> v_period_end
  LOOP
    SELECT s.monthly_amount INTO v_monthly
      FROM public.salary_standard s
     WHERE s.employment_id = e.employment_id AND s.effective_from <= v_period_end
     ORDER BY s.effective_from DESC LIMIT 1;
    IF v_monthly IS NULL THEN CONTINUE; END IF;

    -- 考勤口径先取：计薪基础要用实际工时（原来是在公式循环里反复取，白查 N 次）
    v_att := public.fn_att_person_period(e.person_id, r.period);

    -- ★ 两种计薪基础（117）：
    --   day  按人天：应发底薪 = 月薪标准，缺勤按天扣（事假扣款单独一行）
    --   hour 按工时：应发底薪 = 时薪 × 实际工时。
    --        ★ 这时**不再另扣事假** —— 缺勤已经体现在工时里了，再扣一次就是扣两次。
    --        这是两种模式最容易写错的地方，也是客户对不上账时最先怀疑的地方。
    -- 折算单价：日薪 / 时薪都用**月计薪天数 21.75**（法定折算口径），
    -- 不用应出勤（22）—— 否则 2 月（20 天）与 12 月（23 天）时薪不一样，
    -- 同一个人同样的工时拿到不同的钱。应出勤只用于"满勤判断/折算比例"。
    v_daily  := round(v_monthly / GREATEST(v_days, 1), 4);
    v_hourly := round(v_monthly / GREATEST(v_days * v_std_h, 1), 4);

    v_basis := public.fn_pay_basis(e.person_id, r.period);
    IF v_basis = 'hour' THEN
      -- 应发 = 时薪 × 实际工时（时薪 = 月薪 ÷ 21.75 ÷ 8）
      v_base := round(v_hourly * v_att.work_hours, 2);
      v_leave := 0;
    ELSE
      v_base := v_monthly;
      v_leave := public.fn_leave_deduction(e.person_id, r.period);
    END IF;

    -- 结构按实际应发/月薪标准缩放：按工时模式下工时少，结构各项同比例缩，
    -- 否则明细合计会大于应发（勾稽报错），或 BASE 变成负数。
    v_factor := CASE WHEN v_monthly > 0 THEN v_base / v_monthly ELSE 1 END;

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
      -- 考勤口径（102/114）：出勤/应出勤/请假/工时/加班 同源；周期内只取一次。
      -- 不允许从参数传天数：一旦能传，工资与考勤就会有两个口径。
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
                     'ROSTER_DAYS', v_att.roster_days,
                     -- 计薪基础（117）：写公式时不用自己拿月薪除，也避免各人各写一遍
                     'DAILY_RATE', v_daily,
                     'HOURLY_RATE', v_hourly,
                     'PAY_BASIS_HOUR', CASE WHEN v_basis = 'hour' THEN 1 ELSE 0 END,
                     'HOUR_FACTOR', v_factor)
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
      -- ★ 社保基数用**月薪标准**，不用本月实际应发：
      --   社保按申报口径缴，工时少的月份不该少缴（少缴是欠缴，会被追）。
      --   day 模式下 v_monthly 与 v_base 本来就相等，所以这条改动不改变既有结果。
      v_si_one := round(public.fn_si_base('上海', si.item, v_monthly, v_period_end) * si.rate_employee, 2);
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

    -- 明细按 v_factor 缩放（day 模式 factor=1，等于原样）。
    -- ★ 先 round 到分再求和：不 round 的话 BASE = v_base − 全精度和，
    --   会出现 6000.0001 这种"明细加起来差一分"的行。
    SELECT count(*), COALESCE(sum(round(amount * v_factor, 2)), 0) INTO v_struct_n, v_fixed_other
      FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s
     WHERE s.item_code <> 'BASE';

    IF v_struct_n > 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount)
      SELECT v_slip, s.item_code, round(s.amount * v_factor, 2)
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
