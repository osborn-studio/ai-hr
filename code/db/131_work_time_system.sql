-- ============================================================================
-- 131_work_time_system.sql · 综合计算工时制：超时不看每天，看周期总数
-- ----------------------------------------------------------------------------
-- 到 130 为止，加班只有一套算法：**逐日**判。每天超过 8 小时算平日加班，
-- 休息日上班全算加班，法定节假日全算 300%。
--
-- 这套算法对标准工时是对的，对综合计算工时是**错的**，而且错在两头：
--
--   ① 淡季某天干 10 小时 → 标准算法当天就给 150%，但按周期总工时可能根本没超
--      → 多付；
--   ② 旺季连续 20 天每天 9 小时 → 标准算法每天只算 1 小时（合计 20 小时），
--      而周期总工时可能已经超了 40 小时 → **少付**。
--
-- 依据：
--   《劳动法》第 39 条：企业因生产特点不能实行第 36、38 条规定的，
--     经劳动行政部门批准，可以实行其他工作和休息办法。
--   《关于企业实行不定时工作制和综合计算工时工作制的审批办法》
--     （劳部发〔1994〕503 号）第 5 条：分别以周、月、季、年为周期综合计算工作时间，
--     其平均日工作时间和平均周工作时间应与法定标准工作时间基本相同。
--   《工资支付暂行规定》第 13 条：综合计算工时超过法定标准工作时间的部分，
--     按 150% 支付；法定休假日安排工作的，按 300% 支付。
--
-- ★ 三条最容易做错的地方，都在这里钉住：
--
--   ① **休息日不单独给 200%。** 综合工时的核心是"总工时"，休息日上班也计入总数；
--      超了才按 150%。这与标准工时里"休息日 200%"是两种制度，不能混。
--      但各地口径不完全一致 —— 所以做成配置项 `PAY_COMP_RESTDAY`，
--      默认 include（= 法定口径：计入总数），需要单独给的改 separate。
--
--   ② **法定节假日永远 300%，且不计入总数。** 那天已经单独按 300% 付过，
--      再算进总工时会让周期法定工时被"虚增"一次，等于重复。
--      也正因为如此，法定节假日**每月照付**，不用等周期末。
--
--   ③ **周期末才结算。** 人事 1 月不知道一季度超没超。所以非结算月只出
--      法定节假日那部分，超时工时到季末（年末）一次结。代价很实在：
--      那一个月 gross 会突然变高，个税可能跳档 —— 这是综合工时的固有特性，
--      不是 bug；页面要把"本期结算"标出来，否则财务会以为算错了。
--
-- ★ 周期法定工时用**日历工作日 × 每日标准工时**，不用固定 166.64：
--   166.64 是 20.83 天×8 的平均值，而实际每个月的应出勤天数不同（20–23 天），
--   用平均值会让"这个月本来就没超"变成"超了 3 小时"。
--   这与 111 的应出勤口径同源（已扣法定假、加调休上班）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 工时制度与备案
-- ---------------------------------------------------------------------------
ALTER TABLE employment ADD COLUMN IF NOT EXISTS work_time_system varchar(20);
ALTER TABLE employment ADD COLUMN IF NOT EXISTS comp_approved_until date;

ALTER TABLE employment DROP CONSTRAINT IF EXISTS ck_emp_wts;
ALTER TABLE employment ADD CONSTRAINT ck_emp_wts
  CHECK (work_time_system IS NULL OR
         work_time_system IN ('standard','comp_month','comp_quarter','comp_year','flexible'));

COMMENT ON COLUMN employment.work_time_system IS
  '工时制度：NULL/standard 标准工时（默认=上线前行为）/ comp_month 月综合 / '
  'comp_quarter 季综合 / comp_year 年综合 / flexible 不定时（131）。';
COMMENT ON COLUMN employment.comp_approved_until IS
  '综合工时/不定时的劳动行政部门审批备案有效期。过期不影响算薪，但页面会提示 —— '
  '没有备案就按综合工时算，本身是违法用工。';

-- ---------------------------------------------------------------------------
-- 2. 制度项：综合工时下休息日怎么算
-- ---------------------------------------------------------------------------
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('PAY_COMP_RESTDAY', '综合工时下休息日上班怎么算', 'PAYROLL', 'enum', false, 'group', '')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('PAY_COMP_RESTDAY', '2026-01-01', 'include', 'group_hr',
        '默认=法定口径：休息日上班计入周期总工时，超了才按 150%，不单独给 200%')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. 周期边界
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_comp_period(p_person bigint, p_period varchar)
RETURNS TABLE(sys varchar, from_date date, to_date date, settle_period varchar, months int)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_sys varchar(20);
  v_y int;
  v_m int;
  v_q int;
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM（收到 %）', p_period;
  END IF;
  v_y := left(p_period, 4)::int;
  v_m := right(p_period, 2)::int;

  -- 期间末那天仍在职的那条任职决定制度（月中换制度的，按月末那天算）
  SELECT COALESCE(e.work_time_system, 'standard') INTO v_sys
    FROM public.employment e
   WHERE e.person_id = p_person
     AND daterange(e.hire_date, e.leave_date, '[]') @> (to_date(p_period||'-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
   ORDER BY e.hire_date DESC LIMIT 1;

  v_sys := COALESCE(v_sys, 'standard');
  sys := v_sys;

  IF v_sys = 'comp_quarter' THEN
    v_q := (v_m - 1) / 3 + 1;
    from_date := make_date(v_y, (v_q - 1) * 3 + 1, 1);
    to_date   := (from_date + interval '3 months - 1 day')::date;
    settle_period := to_char(from_date + interval '2 months', 'YYYY-MM');
    months := 3;
  ELSIF v_sys = 'comp_year' THEN
    from_date := make_date(v_y, 1, 1);
    to_date   := make_date(v_y, 12, 31);
    settle_period := v_y || '-12';
    months := 12;
  ELSE
    -- comp_month 与 standard 都按月；standard 走老算法，这里的边界只用于展示
    from_date := make_date(v_y, v_m, 1);
    to_date   := (from_date + interval '1 month - 1 day')::date;
    settle_period := p_period;
    months := 1;
  END IF;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_comp_period IS
  '某人某期所属的综合工时周期：月/季/年的起止与结算月。standard 也返回当月边界，便于统一展示。';

-- ---------------------------------------------------------------------------
-- 4. 周期口径的加班：超时工时 = 周期实际 − 周期法定
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_comp_ot_split(p_person bigint, p_period varchar)
RETURNS TABLE(weekday_ot numeric, restday_ot numeric, holiday_ot numeric,
              restday_paid numeric, restday_rested numeric)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  cp        record;
  v_std_h   numeric(6,2);
  v_work_d  int;
  v_sys_h   numeric(8,2);
  v_actual  numeric(8,2) := 0;   -- 计入周期的实际工时（已排除法定节假日）
  v_holiday numeric(8,2) := 0;   -- 法定节假日工时（单独 300%）
  v_rest    numeric(8,2) := 0;   -- 其中落在休息日的工时
  v_ot      numeric(8,2) := 0;
  v_mode    varchar(16) := 'include';
  v_settle  boolean := false;
  v_left    date;
BEGIN
  SELECT * INTO cp FROM public.fn_comp_period(p_person, p_period);

  SELECT COALESCE(value_num, 8) INTO v_std_h
    FROM public.fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, cp.to_date);
  SELECT COALESCE(value_text,'include') INTO v_mode
    FROM public.fn_policy_effective('PAY_COMP_RESTDAY', NULL, cp.to_date);

  -- 周期法定工时 = 期间工作日数 × 每日标准工时（不含法定节假日与休息日）
  SELECT count(*) INTO v_work_d
    FROM generate_series(cp.from_date, cp.to_date, interval '1 day') g
   WHERE NOT public.fn_is_rest_day(g::date, p_person)
     AND NOT public.fn_is_legal_holiday(g::date);
  v_sys_h := round(v_work_d * v_std_h, 2);

  SELECT COALESCE(sum(a.work_hours) FILTER (WHERE NOT public.fn_is_legal_holiday(a.work_date)), 0),
         COALESCE(sum(a.work_hours) FILTER (WHERE public.fn_is_legal_holiday(a.work_date)), 0),
         COALESCE(sum(a.work_hours) FILTER (
           WHERE public.fn_is_rest_day(a.work_date, p_person)
             AND NOT public.fn_is_legal_holiday(a.work_date)), 0)
    INTO v_actual, v_holiday, v_rest
    FROM public.attendance_daily_store a
   WHERE a.employee_id = p_person
     AND a.work_date BETWEEN cp.from_date AND cp.to_date
     AND a.work_hours > 0;

  -- separate：休息日那部分从总数里拿出去，单独按 200%（部分地区口径）
  IF v_mode = 'separate' THEN
    v_actual := GREATEST(v_actual - v_rest, 0);
  END IF;

  v_ot := GREATEST(v_actual - v_sys_h, 0);

  -- 结算：周期最后一个月，或员工在周期内离职（离职时按已过部分结，不留到明年）
  SELECT max(e.leave_date) INTO v_left
    FROM public.employment e
   WHERE e.person_id = p_person AND e.leave_date IS NOT NULL
     AND e.leave_date BETWEEN cp.from_date AND cp.to_date;

  v_settle := (p_period = cp.settle_period) OR (v_left IS NOT NULL AND to_char(v_left,'YYYY-MM') = p_period);

  weekday_ot := 0; restday_ot := 0; holiday_ot := 0; restday_paid := 0; restday_rested := 0;

  -- ★ 法定节假日每月照付，不等周期末：那天已经过去了，钱就该当月给。
  holiday_ot := v_holiday;

  IF NOT v_settle THEN
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_mode = 'separate' THEN
    weekday_ot   := v_ot;
    restday_ot   := v_rest;
    restday_paid := v_rest;
  ELSE
    -- include：休息日工时已在 v_actual 里，超时部分统一按 150%，不再单独给 200%
    weekday_ot   := v_ot;
    restday_ot   := 0;
    restday_paid := 0;
  END IF;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_comp_ot_split IS
  '综合计算工时下的加班拆分：超时 = 周期实际工时 − 周期法定工时（工作日×标准工时），按 150%；'
  '法定节假日单列 300% 且不计入总数；休息日是否单独给 200% 由 PAY_COMP_RESTDAY 决定。'
  '非结算月只出法定节假日那部分 —— 超时要等周期末才知道。';

-- 给界面看"周期跑到哪了"：累计工时 / 法定工时 / 超时 / 是否结算月
CREATE OR REPLACE FUNCTION fn_att_comp_status(p_person bigint, p_period varchar)
RETURNS TABLE(sys varchar, from_date date, to_date date, settle_period varchar,
              std_hours numeric, actual_hours numeric, holiday_hours numeric,
              rest_hours numeric, ot_hours numeric, is_settle boolean,
              approved_until date, approved_ok boolean)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  cp record;
  v_std_h numeric(6,2);
  v_work_d int;
  v_appr date;
  s record;
BEGIN
  SELECT * INTO cp FROM public.fn_comp_period(p_person, p_period);

  SELECT e.comp_approved_until INTO v_appr
    FROM public.employment e
   WHERE e.person_id = p_person AND e.leave_date IS NULL
   ORDER BY e.hire_date DESC LIMIT 1;

  SELECT COALESCE(value_num, 8) INTO v_std_h
    FROM public.fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, cp.to_date);

  SELECT count(*) INTO v_work_d
    FROM generate_series(cp.from_date, cp.to_date, interval '1 day') g
   WHERE NOT public.fn_is_rest_day(g::date, p_person)
     AND NOT public.fn_is_legal_holiday(g::date);

  SELECT * INTO s FROM public.fn_comp_ot_split(p_person, p_period);

  sys := cp.sys; from_date := cp.from_date; to_date := cp.to_date;
  settle_period := cp.settle_period;
  std_hours := round(v_work_d * v_std_h, 2);
  holiday_hours := COALESCE(s.holiday_ot, 0);

  SELECT COALESCE(sum(a.work_hours) FILTER (WHERE NOT public.fn_is_legal_holiday(a.work_date)), 0),
         COALESCE(sum(a.work_hours) FILTER (
           WHERE public.fn_is_rest_day(a.work_date, p_person)
             AND NOT public.fn_is_legal_holiday(a.work_date)), 0)
    INTO actual_hours, rest_hours
    FROM public.attendance_daily_store a
   WHERE a.employee_id = p_person
     AND a.work_date BETWEEN cp.from_date AND cp.to_date
     AND a.work_hours > 0;

  ot_hours := GREATEST(actual_hours - std_hours, 0);
  is_settle := (p_period = cp.settle_period);
  approved_until := v_appr;
  approved_ok := (v_appr IS NOT NULL AND v_appr >= cp.to_date);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_att_comp_status IS
  '综合工时进度：周期起止、法定工时、实际工时、超时、是否结算月、备案是否覆盖周期末。'
  'approved_ok=false 不影响算薪，但页面要提示 —— 没有备案的"综合工时"本身是违法用工。';

-- ---------------------------------------------------------------------------
-- 5. fn_att_ot_split 接上制度分派（并修一处旧 bug）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_att_ot_split(p_person bigint, p_period varchar)
RETURNS TABLE (weekday_ot numeric, restday_ot numeric, holiday_ot numeric,
               restday_paid numeric, restday_rested numeric)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_start date;
  v_end date;
  v_std_h numeric(6,2);
  v_mode varchar(16) := 'pay';
  v_rested numeric(6,2) := 0;
  v_sys varchar(20);
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM（收到 %）', p_period;
  END IF;

  -- ★ 综合工时走另一套算法（131）：超时看周期总数，不看每天。
  --   在这里分派而不是在算薪里分派：算薪只认"这一期该付多少加班工时"，
  --   至于这个数是逐日算出来的还是周期算出来的，不该让它知道。
  SELECT COALESCE(e.work_time_system,'standard') INTO v_sys
    FROM public.employment e
   WHERE e.person_id = p_person
     AND daterange(e.hire_date, e.leave_date, '[]')
         @> (to_date(p_period||'-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
   ORDER BY e.hire_date DESC LIMIT 1;

  IF COALESCE(v_sys,'standard') IN ('comp_month','comp_quarter','comp_year') THEN
    RETURN QUERY SELECT * FROM public.fn_comp_ot_split(p_person, p_period);
    RETURN;
  END IF;

  -- flexible（不定时）：不按小时算加班。法定节假日仍按 300%（部分地区口径），
  -- 平日与休息日不另付 —— 这里只保留法定那一档，避免被算成"每天超 8 小时"。
  v_start := to_date(p_period || '-01','YYYY-MM-DD');
  v_end   := (v_start + interval '1 month - 1 day')::date;

  SELECT COALESCE(value_num, 8) INTO v_std_h
    FROM public.fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, v_end);

  IF COALESCE(v_sys,'standard') = 'flexible' THEN
    RETURN QUERY
      SELECT 0::numeric, 0::numeric,
             COALESCE(sum(CASE WHEN public.fn_is_legal_holiday(a.work_date)
                               THEN a.work_hours ELSE 0 END), 0)::numeric,
             0::numeric, 0::numeric
        FROM public.attendance_daily_store a
       WHERE a.employee_id = p_person
         AND a.work_date BETWEEN v_start AND v_end
         AND a.work_hours > 0;
    RETURN;
  END IF;

  SELECT
    -- ★ 这里多了一个 AND NOT is_legal_holiday：
    --   法定节假日当天上班 10 小时，原来会同时算进"平日加班 2 小时"和
    --   "法定节假日 10 小时"，也就是那 2 小时被付了 300% 又付了 150%。
    --   断言 HOL3 只测了 8 小时（正好 0 差额），所以一直没暴露。
    COALESCE(sum(CASE WHEN NOT public.fn_is_rest_day(a.work_date, a.employee_id)
                       AND NOT public.fn_is_legal_holiday(a.work_date) THEN
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

  SELECT COALESCE(sum(x.hours), 0) INTO v_rested
    FROM public.ot_comp_rest x
   WHERE x.person_id = p_person
     AND x.ot_date BETWEEN v_start AND v_end
     AND x.status IN ('planned','used');

  SELECT COALESCE(value_text,'pay') INTO v_mode
    FROM public.fn_policy_effective('PAY_OT_COMP_REST', NULL, v_end);

  restday_rested := v_rested;
  IF v_mode = 'deduct' THEN
    restday_paid := GREATEST(restday_ot - v_rested, 0);
  ELSE
    restday_paid := restday_ot;
  END IF;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_att_ot_split IS
  '某人某期的加班工时：平日 / 休息日 / 法定节假日，另给"休息日应付"与"已补休"。'
  'standard 逐日算；comp_month/quarter/year 走 fn_comp_ot_split（周期总数）；'
  'flexible 只保留法定节假日 300%。';

-- ---------------------------------------------------------------------------
-- 6. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.WTS','综合工时制：超时看周期总数、休息日不单独给 200%、法定节假日不进总数',
   'PAYROLL','ALGORITHM','fn_comp_ot_split','public','employment','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-WTS','工时制度接进接口与界面：改制度要 HR 主管以上、周期进度看得见',
   'PAYROLL','ACL','fn_att_comp_status','public','employment','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
