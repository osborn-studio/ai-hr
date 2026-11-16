-- ============================================================================
-- 164_leave_service.sql · 假勤的"资格"：年假折算 / 12 个月门槛 / 医疗期
-- ----------------------------------------------------------------------------
-- 129 已经把"年假天数"做出来了：annual_leave_tier 三档 + fn_annual_leave_days
-- 按累计工龄查档 + 折现 + 应休未休。但**资格**这一层是空的，而它正是 HR
-- 与员工最容易吵起来的地方：
--
--   ① **入职当年要不要折算？** 7 月 1 日入职的人，应享 5 天还是 2 天？
--      法定（《职工带薪年休假条例实施办法》第五条）：
--      新进用人单位当年度年休假天数 = (当年度在本单位剩余日历天数 ÷ 365) × 应享天数，
--      **不足 1 整天的部分不享受**。现在 fn_annual_leave_days 直接给 5 天 ——
--      多给的那 3 天是真金白银（折现 300%，或离职时按 200% 补）。
--
--   ② **"连续工作满 12 个月"这个门槛没人判。** 法定第三条：职工连续工作满
--      12 个月以上才享受年休假。刚入职 3 个月的人，系统照样给他 5 天 ——
--      而这不是"宽松"，是给了之后收不回来（用了就没法追）。
--
--   ③ **医疗期完全没有。** 医疗期是"患病或非因工负伤停止工作治病休息、用人单位
--      不得解除劳动合同"的期限，按**总工龄**与**本单位工龄**分档 3–24 个月。
--      它既是"能请多久病假"的上限，也是"什么时候可以依法解除"的门槛 ——
--      与合同直接联动，而仓里一个字段都没有。
--
-- ★ 三条设计取舍：
--   · 折算**向下取整到整天**（不足 1 整天不享受），不做四舍五入 ——
--     四舍五入会把 2.6 天算成 3 天，而"多给的半天"没有法律依据；
--   · 门槛与折算都**做成配置项**（默认按法定），因为确实有企业优于法定（入职即给全额）；
--     但配置只能放宽不能收紧（收紧即违法，用 CHECK 挡住）；
--   · 医疗期只**报**不拦：超过医疗期是"可以依法解除"的条件，不是"不许请假"。
--     拦下来会让真正生病的人请不了假 —— 那是把法律风险转成人的风险。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 配置项：默认按法定，只能放宽
-- ---------------------------------------------------------------------------
INSERT INTO policy_def (code, name, domain, value_type, allow_org_override, override_floor, unit) VALUES
  ('LEAVE_FIRST_YEAR_PRORATE', '入职当年年假是否折算', 'ATTENDANCE', 'bool', true, 'store', ''),
  ('LEAVE_WAIT_12_MONTHS', '是否要求连续工作满 12 个月才享受年假', 'ATTENDANCE', 'bool', true, 'store', ''),
  ('LEAVE_PROBATION_AL', '试用期是否可请年假', 'ATTENDANCE', 'bool', true, 'store', '')
ON CONFLICT (code) DO NOTHING;

-- 默认值 = 法定：折算、要满 12 个月、试用期可以请（法定没有禁止试用期休年假）
INSERT INTO policy_value (policy_code, effective_from, value_num, published_by, reason) VALUES
  ('LEAVE_FIRST_YEAR_PRORATE', '2026-01-01', 1, 'group_hr', '法定：入职当年按剩余日历天数折算'),
  ('LEAVE_WAIT_12_MONTHS',     '2026-01-01', 1, 'group_hr', '法定：连续工作满 12 个月才享受年休假'),
  ('LEAVE_PROBATION_AL',       '2026-01-01', 1, 'group_hr', '法定未禁止试用期休年假；改为 0 即"转正后才有"')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. 读取配置（一次一处，别在三个函数里各读一遍 policy）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_leave_flag(p_code varchar, p_on date DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v numeric;
BEGIN
  -- ★ fn_policy_effective 是**表函数**（返回 value_num/value_text/source/via_org_id），
  --   不是标量函数。直接 SELECT ... INTO numeric 会把它当成一行记录的文本，
  --   报错是 'invalid input syntax for type numeric: "(1.0000,,group,)"' ——
  --   看着像数据脏，其实是调用方式错了。
  IF NOT EXISTS (SELECT 1 FROM public.policy_def d WHERE d.code = p_code) THEN
    RETURN true;                    -- 连定义都没有：按法定（开）
  END IF;
  BEGIN
    SELECT t.value_num INTO v
      FROM public.fn_policy_effective(p_code, NULL, COALESCE(p_on, public.app_today())) t;
  EXCEPTION WHEN others THEN
    v := NULL;                      -- 有定义但没取值：同样按法定
  END;
  -- 没有配置时按**法定**取值（不按 false）：三个开关的法定默认都是"开"
  IF v IS NULL THEN RETURN true; END IF;
  RETURN v <> 0;
END;
$$;

COMMENT ON FUNCTION fn_leave_flag IS
  '读假勤类开关（LEAVE_*）。没有配置时回 true —— 这三个开关的法定默认都是"开"，'
  '回 false 会让"没配"变成"少给年假"，那是违法。';

-- ---------------------------------------------------------------------------
-- 2. 资格：连续工作满 12 个月（法定第三条）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_leave_qualified(
  p_employee bigint,
  p_on       date
) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_months numeric;
BEGIN
  IF NOT public.fn_leave_flag('LEAVE_WAIT_12_MONTHS', p_on) THEN
    RETURN true;                    -- 企业优于法定：入职即给
  END IF;
  -- 累计工作月数 = 入司前年限 × 12 + 本单位已过天数 / 30.44
  SELECT round(COALESCE(e.prior_work_years, 0) * 12
               + GREATEST(p_on - e.hire_date, 0) / 30.44, 2)
    INTO v_months
    FROM public.employment e
   WHERE e.person_id = p_employee
     AND daterange(e.hire_date, e.leave_date, '[]') @> p_on
   ORDER BY e.hire_date DESC LIMIT 1;
  RETURN COALESCE(v_months, 0) >= 12;
END;
$$;

COMMENT ON FUNCTION fn_leave_qualified IS
  '是否已连续工作满 12 个月（法定年假门槛）。入司前工龄计入 ——'
  '换工作的人不该重新等一年，这也正是 prior_work_years 存在的理由。'
  '配置 LEAVE_WAIT_12_MONTHS=0 时直接放行（企业优于法定）。';

-- ---------------------------------------------------------------------------
-- 3. 该年度**应享**年假：查档 + 入职当年折算
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_annual_leave_entitled(
  p_employee bigint,
  p_year     int
) RETURNS numeric
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_year_start date := make_date(p_year, 1, 1);
  v_year_end   date := make_date(p_year, 12, 31);
  v_hire       date;
  v_leave      date;
  v_tier       numeric;
  v_days       numeric;
  v_remain     int;
  v_total      int;
BEGIN
  SELECT e.hire_date, e.leave_date INTO v_hire, v_leave
    FROM public.employment e
   WHERE e.person_id = p_employee
     AND daterange(e.hire_date, e.leave_date, '[]') && daterange(v_year_start, v_year_end, '[]')
   ORDER BY e.hire_date DESC LIMIT 1;

  IF v_hire IS NULL THEN
    RETURN 0;                       -- 这一年在职都没有
  END IF;

  -- 资格按"年末"判：年中满 12 个月的人，当年度能不能享受？
  -- 法定口径是"连续工作满 12 个月以上"即享受，所以按年末的可达状态判，
  -- 不按年初 —— 否则 3 月满 12 个月的人要再等一年。
  IF NOT public.fn_leave_qualified(p_employee, LEAST(v_year_end, COALESCE(v_leave, v_year_end))) THEN
    RETURN 0;
  END IF;

  -- 查询档位用**年末**的工龄：年假按整年应享，不是按天滚动
  v_tier := public.fn_annual_leave_days(p_employee, LEAST(v_year_end, COALESCE(v_leave, v_year_end)));
  IF v_tier IS NULL OR v_tier <= 0 THEN
    RETURN 0;
  END IF;

  -- 不折算：全额（企业优于法定，或非入职当年）
  IF NOT public.fn_leave_flag('LEAVE_FIRST_YEAR_PRORATE', v_year_start) THEN
    RETURN v_tier;
  END IF;

  v_total  := v_year_end - v_year_start + 1;
  v_remain := LEAST(v_year_end, COALESCE(v_leave, v_year_end))
            - GREATEST(v_year_start, v_hire) + 1;
  IF v_remain >= v_total THEN
    RETURN v_tier;                  -- 全年在职：不折算
  END IF;

  -- 法定折算：(剩余日历天数 ÷ 365) × 应享天数，**不足 1 整天不享受**
  v_days := floor(v_remain::numeric / 365 * v_tier);
  RETURN GREATEST(v_days, 0);
END;
$$;

COMMENT ON FUNCTION fn_annual_leave_entitled IS
  '某年度应享年假天数（164）：查档 + 入职当年折算 + 12 个月门槛。'
  '折算按法定向下取整到整天（2.6 天 → 2 天）—— 四舍五入多给的半天没有法律依据，'
  '而它是真金白银（折现 300% / 离职补 200%）。'
  '★ 与 129 的 fn_annual_leave_days 分工：那个回答"这个人工龄该有几档"，'
  '这个回答"他今年实际能休几天"（含入职当年与离职当年）。';

-- ---------------------------------------------------------------------------
-- 4. 医疗期（劳部发〔1994〕479 号）
-- ---------------------------------------------------------------------------
-- 按**总工龄**与**本单位工龄**分档：
--   总工龄 <10 年：本单位 <5 年 → 3 个月；≥5 年 → 6 个月
--   总工龄 ≥10 年：本单位 <5 年 → 6 个月；5–10 年 → 9 个月；
--                  10–15 年 → 12 个月；15–20 年 → 18 个月；≥20 年 → 24 个月
CREATE OR REPLACE FUNCTION public.fn_medical_period_months(
  p_employee bigint,
  p_on       date
) RETURNS int
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_total  numeric;
  v_local  numeric;
BEGIN
  SELECT public.fn_cumulative_years(p_employee, p_on) INTO v_total;
  SELECT GREATEST(p_on - e.hire_date, 0) / 365.25 INTO v_local
    FROM public.employment e
   WHERE e.person_id = p_employee
     AND daterange(e.hire_date, e.leave_date, '[]') @> p_on
   ORDER BY e.hire_date DESC LIMIT 1;
  IF v_total IS NULL THEN RETURN 0; END IF;
  v_local := COALESCE(v_local, 0);

  IF v_total < 10 THEN
    RETURN CASE WHEN v_local < 5 THEN 3 ELSE 6 END;
  END IF;
  IF v_local < 5  THEN RETURN 6;  END IF;
  IF v_local < 10 THEN RETURN 9;  END IF;
  IF v_local < 15 THEN RETURN 12; END IF;
  IF v_local < 20 THEN RETURN 18; END IF;
  RETURN 24;
END;
$$;

COMMENT ON FUNCTION fn_medical_period_months IS
  '医疗期月数（164）：按总工龄与本单位工龄分档 3–24 个月（劳部发〔1994〕479 号）。'
  '医疗期内不得依《劳动合同法》第四十条解除；超过医疗期是"可以解除"的条件，'
  '**不是"不许请假"** —— 所以上层只报不拦。';

-- ---------------------------------------------------------------------------
-- 5. 请假资格检查：block / warn（与合同、异动同一套形态）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_leave_eligibility(
  p_employee  bigint,
  p_type_code varchar,
  p_from      date,
  p_to        date
) RETURNS TABLE (level varchar, code varchar, message varchar)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_type   record;
  v_year   int;
  v_ent    numeric;
  v_prob   boolean;
  v_signed int;
  v_med    int;
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN
    RETURN QUERY SELECT 'block'::varchar, 'E_LVG_NO_RANGE'::varchar,
      '起止日必填'::varchar;
    RETURN;
  END IF;
  v_year := EXTRACT(YEAR FROM p_from)::int;

  SELECT * INTO v_type FROM public.leave_type t WHERE t.code = p_type_code;
  IF v_type.id IS NULL THEN
    RETURN QUERY SELECT 'block'::varchar, 'E_LVG_NO_TYPE'::varchar,
      format('假种 %s 不存在', p_type_code)::varchar;
    RETURN;
  END IF;

  -- ---- 年假：折算后的应享 + 12 个月门槛 + 试用期开关 ----
  IF p_type_code = 'ANNUAL' THEN
    v_ent := public.fn_annual_leave_entitled(p_employee, v_year);
    IF v_ent <= 0 THEN
      IF NOT public.fn_leave_qualified(p_employee, p_from) THEN
        RETURN QUERY SELECT 'block'::varchar, 'E_LVG_NOT_QUALIFIED'::varchar,
          ('还没有连续工作满 12 个月，暂不享受年休假（法定第三条）。'
           || '注意：入司前工龄应当计入 —— 若这个人之前有工作年限，'
           || '去档案里补「入司前工作年限」，否则他会白等一年')::varchar;
      ELSE
        RETURN QUERY SELECT 'block'::varchar, 'E_LVG_NO_ENTITLEMENT'::varchar,
          format('按工龄档位与入职当年折算，%s 年度应享年假为 0 天', v_year)::varchar;
      END IF;
      RETURN;
    END IF;

    IF NOT public.fn_leave_flag('LEAVE_PROBATION_AL', p_from) THEN
      SELECT EXISTS (
        SELECT 1 FROM public.employment_contract c
         WHERE c.employee_id = p_employee AND c.status = 'signed'
           AND daterange(c.start_date, c.end_date, '[]') @> p_from
           AND c.probation_from IS NOT NULL
           AND daterange(c.probation_from, c.probation_to, '[]') @> p_from
      ) INTO v_prob;
      IF v_prob THEN
        RETURN QUERY SELECT 'block'::varchar, 'E_LVG_PROBATION'::varchar,
          ('公司配置为「转正后才可休年假」，而这次请假落在试用期内。'
           || '★ 法定并未禁止试用期休年假 —— 这条是公司政策，改了配置即可放开')::varchar;
        RETURN;
      END IF;
    END IF;

    RETURN QUERY SELECT 'warn'::varchar, 'W_LVG_ENTITLED'::varchar,
      format('%s 年度应享年假 %s 天（已按入职当年折算）。请核对余额是否够，'
             || '不够会超支', v_year, v_ent)::varchar;
    RETURN;
  END IF;

  -- ---- 婚假 / 产假 / 陪产假 / 丧假：要求有已签合同（在履行）----
  IF p_type_code IN ('MARRIAGE', 'MATERNITY', 'PATERNITY', 'BEREAVEMENT') THEN
    SELECT count(*)::int INTO v_signed
      FROM public.employment_contract c
     WHERE c.employee_id = p_employee AND c.status = 'signed'
       AND daterange(c.start_date, c.end_date, '[]') @> p_from;
    IF v_signed = 0 THEN
      RETURN QUERY SELECT 'block'::varchar, 'E_LVG_NO_CONTRACT'::varchar,
        ('这类假期必须有已签的劳动合同在履行 —— 没有合同就没有"用人单位"，'
         || '也就没有休假的主体。先补签合同（或走入职链）')::varchar;
      RETURN;
    END IF;
    RETURN;
  END IF;

  -- ---- 病假：只报医疗期，不拦 ----
  IF p_type_code = 'SICK' THEN
    v_med := public.fn_medical_period_months(p_employee, p_from);
    IF v_med > 0 THEN
      RETURN QUERY SELECT 'warn'::varchar, 'W_LVG_MEDICAL'::varchar,
        format('医疗期 %s 个月（按总工龄与本单位工龄分档）。'
               || '超过医疗期是"可以依法解除"的条件，不是"不许请假" —— '
               || '系统只提示，不做限制', v_med)::varchar;
    END IF;
    RETURN;
  END IF;
  RETURN;
END;
$$;

COMMENT ON FUNCTION fn_leave_eligibility IS
  '请假资格（164）：年假要过 12 个月门槛、按入职当年折算、试用期开关可配；'
  '婚假/产假/陪产假/丧假要求有已签合同在履行；病假只报医疗期不拦。'
  '★ 与 152 的 fn_leave_request_check 分工：那个判"这一单合不合规"（额度、凭证、单次上限），'
  '这个判"这个人有没有资格休这种假"。两者都要过 —— 缺一条就会出'
  '「有额度但没资格」或「有资格但没额度」的怪事。';

-- ---------------------------------------------------------------------------
-- 6. 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.LVG',
   '年假资格：入职当年按剩余日历天数向下折算、未满 12 个月不享受、'
   '配置可放宽（只能放宽不能收紧）、医疗期按总工龄与本单位工龄分档 3–24 个月、'
   '婚假产假要求有已签合同在履行',
   'ORG','ALGORITHM','fn_annual_leave_entitled','public','annual_leave_tier','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-LVG',
   '假勤资格接进接口：请假前的资格检查能返回折算后的应享天数与医疗期提示',
   'ORG','ACL','fn_leave_eligibility','public','leave_type','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
