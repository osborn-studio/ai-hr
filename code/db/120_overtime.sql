-- ============================================================================
-- 120_overtime.sql · 加班费三档：150% / 200% / 300%（法定口径）
-- ----------------------------------------------------------------------------
-- 依据（查证过的，不是凭印象）：
--   《劳动法》第 44 条 + 《工资支付暂行规定》（劳部发〔1994〕489 号）：
--     · 平日延长工作时间      不低于 150%
--     · 休息日工作且不能补休  不低于 200%
--     · 法定休假日工作        不低于 300%
--   《关于职工全年月平均工作时间和工资折算问题的通知》（劳社部发〔2008〕3 号）：
--     月计薪天数 21.75 天，小时工资 = 月工资 ÷ 174 小时
--     法定节假日本身**带薪**，折算时不剔除（所以 21.75 而不是 20.83）
--
-- 之前只算了 OT_HOURS 一个总数，没有分档，也就没法算钱 —— 这是硬缺口：
-- 加班费是劳动争议里最容易败诉的一项，且举证责任在用人单位（考勤记录要保存两年）。
--
-- 三档怎么分（用已有的数据，不额外要求客户填什么）：
--   ① legal_holiday 里 is_workday=false 的日期 → 当天全部工时按 300%
--   ② 周末（isodow ≥ 6）或排班标记休息却有人日 → 当天全部工时按 200%
--   ③ 调休上班日（is_workday=true）按平日处理
--   ④ 其余：当日工时 − 标准工时（8）的部分按 150%
--
-- ★ 默认 PAW_OT_AUTO = 'off'：不改变既有工资条（上线前后一分不变）。
--   但它在界面上会亮一条"未启用加班费"的提醒 —— 不合规不能靠"没报错"来掩盖。
--   开启后按上面的倍数自动算，倍数可调（只能调高，法定是下限）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 加班三档工时
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_att_ot_split(p_person bigint, p_period varchar)
RETURNS TABLE (weekday_ot numeric, restday_ot numeric, holiday_ot numeric)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_start date;
  v_end date;
  v_std_h numeric(6,2);
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM（收到 %）', p_period;
  END IF;
  v_start := to_date(p_period || '-01','YYYY-MM-DD');
  v_end   := (v_start + interval '1 month - 1 day')::date;

  SELECT COALESCE(value_num, 8) INTO v_std_h
    FROM public.fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, v_end);

  SELECT
    COALESCE(sum(CASE WHEN NOT public.fn_is_rest_day(a.work_date, a.employee_id) THEN
                        GREATEST(a.work_hours - v_std_h, 0) ELSE 0 END), 0)::numeric,
    COALESCE(sum(CASE WHEN public.fn_is_rest_day(a.work_date, a.employee_id)
                       AND NOT public.fn_is_legal_holiday(a.work_date) THEN
                        a.work_hours ELSE 0 END), 0)::numeric,
    COALESCE(sum(CASE WHEN public.fn_is_legal_holiday(a.work_date) THEN
                        a.work_hours ELSE 0 END), 0)::numeric
    INTO weekday_ot, restday_ot, holiday_ot
    FROM public.attendance_daily_store a
   WHERE a.employee_id = p_person
     AND a.work_date BETWEEN v_start AND v_end
     AND a.work_hours > 0;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_att_ot_split IS
  '某人某期的加班工时三档：平日延长 / 休息日 / 法定节假日。'
  '法定节假日与休息日上班是**全部工时**算加班；平日只算超出标准工时的部分。';

-- ---------------------------------------------------------------------------
-- 2. 两个判定辅助（日历 + 排班）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_is_legal_holiday(p_date date)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  -- legal_holiday 里登记了且不是"调休上班"，就是法定节假日
  SELECT EXISTS (SELECT 1 FROM public.legal_holiday h
                  WHERE h.holiday_date = p_date AND NOT h.is_workday);
$$;

COMMENT ON FUNCTION fn_is_legal_holiday IS
  '这天是不是法定节假日（放假日）。调休上班日（is_workday=true）不算。'
  '★ 表里只预置了公历可确定的假日，农历节日需按当年公告维护 —— 没维护时这里返回 false，'
  '那天的加班会按"平日"算（偏低）。这是数据问题，不是逻辑问题，界面上要提示。';

CREATE OR REPLACE FUNCTION fn_is_rest_day(p_date date, p_person bigint)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT CASE
    -- ① 调休上班日：周末也要上班，不算休息日
    WHEN EXISTS (SELECT 1 FROM public.legal_holiday h
                  WHERE h.holiday_date = p_date AND h.is_workday) THEN false
    -- ② 排班说了算：有人排了休息班，这天就是他的休息日
    WHEN EXISTS (SELECT 1 FROM public.roster_slot rs
                   JOIN public.shift_def sd ON sd.code = rs.shift_code
                  WHERE rs.employee_id = p_person AND rs.work_date = p_date
                    AND sd.is_rest) THEN true
    -- ③ 没排班时按周末判（门店轮班没排到的那天不一定是休息日，所以排班优先）
    ELSE extract(isodow FROM p_date) >= 6
  END;
$$;

COMMENT ON FUNCTION fn_is_rest_day IS
  '这天对某人是不是休息日：调休上班 → 否；排了休息班 → 是；否则看是否周末。'
  '排班优先于周末：门店轮班的"休息日"由班表定，不由日历定。';

-- ---------------------------------------------------------------------------
-- 3. 制度项
-- ---------------------------------------------------------------------------
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor)
VALUES ('PAY_OT_AUTO', '加班费自动计算（off=只出工时不算钱 / on=按法定倍数算）',
        'PAYROLL', 'enum', true, 'store')
ON CONFLICT (code) DO NOTHING;
INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('PAY_OT_AUTO', '2026-01-01', 'off', 'system',
        '默认关闭：不改变上线前的工资条。合规上线前必须改为 on，否则加班费未计')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor)
VALUES ('PAY_OT_RATE_WEEKDAY', '平日加班倍数（法定下限 1.5）', 'PAYROLL','numeric', true,'store'),
       ('PAY_OT_RATE_RESTDAY', '休息日加班倍数（法定下限 2.0）', 'PAYROLL','numeric', true,'store'),
       ('PAY_OT_RATE_HOLIDAY', '法定节假日加班倍数（法定下限 3.0）', 'PAYROLL','numeric', true,'store')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason) VALUES
  ('PAY_OT_RATE_WEEKDAY','2026-01-01',1.5,'system','法定下限，只能调高'),
  ('PAY_OT_RATE_RESTDAY','2026-01-01',2.0,'system','法定下限，只能调高'),
  ('PAY_OT_RATE_HOLIDAY','2026-01-01',3.0,'system','法定下限，只能调高')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- 倍数不许低于法定下限：写低了会少付，而少付是违法（多付只是成本）
CREATE OR REPLACE FUNCTION fn_ot_rate_check()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_floor numeric;
BEGIN
  v_floor := CASE NEW.policy_code
               WHEN 'PAY_OT_RATE_WEEKDAY' THEN 1.5
               WHEN 'PAY_OT_RATE_RESTDAY' THEN 2.0
               WHEN 'PAY_OT_RATE_HOLIDAY' THEN 3.0
               ELSE NULL END;
  IF v_floor IS NOT NULL AND NEW.value_num < v_floor THEN
    RAISE EXCEPTION 'E_OT_RATE_LOW: % 不得低于法定下限 %（少付加班费是违法，多付只是成本）',
      NEW.policy_code, v_floor;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ot_rate_floor ON policy_value;
CREATE TRIGGER trg_ot_rate_floor BEFORE INSERT OR UPDATE ON policy_value
  FOR EACH ROW WHEN (NEW.policy_code IN
    ('PAY_OT_RATE_WEEKDAY','PAY_OT_RATE_RESTDAY','PAY_OT_RATE_HOLIDAY'))
  EXECUTE FUNCTION fn_ot_rate_check();

-- 工资项：加班费（自动算时用它，手工算时也能用公式项覆盖）
INSERT INTO salary_item(code, name, item_kind, sort_order, is_active, note)
VALUES ('OT_PAY','加班费','statistic',45,true,
        '平日延长 150% / 休息日 200% / 法定节假日 300%，由 PAY_OT_AUTO 控制是否自动计算')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.OT','加班费：平日/休息日/法定三档拆分、1.5/2/3 倍计算、工时模式只补差额、倍数不得低于法定',
   'PAYROLL','ALGORITHM','fn_att_ot_split','public','attendance_daily_store','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;

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
  -- 加班费（120）：三档工时 + 三个倍数 + 是否自动算
  v_ot      record;
  v_ot_pay  numeric(12,2);
  v_ot_auto boolean := false;
  v_r_wd    numeric(4,2) := 1.5;
  v_r_rd    numeric(4,2) := 2.0;
  v_r_hd    numeric(4,2) := 3.0;
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

  -- 加班费制度（120）：倍数法定下限是 1.5 / 2 / 3，企业只能更高不能更低
  SELECT COALESCE(value_text,'off') = 'on' INTO v_ot_auto
    FROM public.fn_policy_effective('PAY_OT_AUTO', NULL, v_period_end);
  SELECT COALESCE(value_num, 1.5) INTO v_r_wd
    FROM public.fn_policy_effective('PAY_OT_RATE_WEEKDAY', NULL, v_period_end);
  SELECT COALESCE(value_num, 2.0) INTO v_r_rd
    FROM public.fn_policy_effective('PAY_OT_RATE_RESTDAY', NULL, v_period_end);
  SELECT COALESCE(value_num, 3.0) INTO v_r_hd
    FROM public.fn_policy_effective('PAY_OT_RATE_HOLIDAY', NULL, v_period_end);

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

    -- 加班工时三档拆分（120）。不管开不开自动算，三档都要给公式：
    -- 有的客户要按项目/门店另算，有的要"先折成补休"。
    v_ot := public.fn_att_ot_split(e.person_id, r.period);

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
                     'HOUR_FACTOR', v_factor,
                     -- 加班三档（120）：平日延长 / 休息日 / 法定节假日
                     'OT_WEEKDAY', v_ot.weekday_ot,
                     'OT_RESTDAY', v_ot.restday_ot,
                     'OT_HOLIDAY', v_ot.holiday_ot)
                || v_extra
                || COALESCE((SELECT jsonb_object_agg(s.item_code, s.amount)
                               FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s),
                            '{}'::jsonb);
      -- 脚本求值：单行公式与多行脚本走同一个入口（内部按有无换行分流）
      v_amt := public.fn_formula_script_eval(fi.formula, v_vars);
      v_extra := v_extra || jsonb_build_object(fi.code, v_amt);
      v_extra_sum := v_extra_sum + v_amt;
    END LOOP;

    -- ★ 加班费（120）：法定 150% / 200% / 300%。
    --   按工时模式（hour）只补**差额**：1 倍工资已经含在"时薪×工时"里了，
    --   再全额给 1.5 倍等于付了 2.5 倍。这是两种计薪基础混用最容易多付的地方。
    IF v_ot_auto THEN
      IF v_basis = 'hour' THEN
        v_ot_pay := round(v_hourly * (
          v_ot.weekday_ot  * (v_r_wd - 1) +
          v_ot.restday_ot  * (v_r_rd - 1) +
          v_ot.holiday_ot  * (v_r_hd - 1)), 2);
      ELSE
        v_ot_pay := round(v_hourly * (
          v_ot.weekday_ot  * v_r_wd +
          v_ot.restday_ot  * v_r_rd +
          v_ot.holiday_ot  * v_r_hd), 2);
      END IF;
    ELSE
      v_ot_pay := 0;
    END IF;

    v_gross := v_base - v_leave + v_perf + v_comm + v_extra_sum + v_ot_pay;

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

    IF v_ot_pay <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'OT_PAY', v_ot_pay);
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
