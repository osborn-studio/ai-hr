-- ============================================================================
-- 111_workdays_calendar.sql · 应出勤按实际工作日算（一般 22 天），不再固定 21.75
-- ----------------------------------------------------------------------------
-- 原来 WORK_DAYS（应出勤）恒等于制度 PAY_DAYS_PER_MONTH = 21.75。
-- 后果：一个门店员工 11 月该上 21 天班，用
--   prorata(600, PRESENT_DAYS, WORK_DAYS)
-- 折算时却除以 21.75 —— 分母是个"平均月"，不是他这个月要来的天数。
-- 排班做了 217 格，算薪也看不见它。
--
-- ★ 这里有两个数，长得像，含义完全不同，不能混：
--
--   WORK_DAYS      应出勤：**这个月**该上几天班。随月份变（20~23 天，常见 22）。
--                  来源：有排班按排班；没排班按日历工作日（周一~周五，扣法定假、加调休）。
--   PAY_DAYS_PER_MONTH  月计薪天数 21.75：法定折算口径，(365−104)/12，
--                  用于**日薪**折算（事假扣款、加班基数），不随月份变。
--
-- 所以这一版：
--   · WORK_DAYS 改成按实际工作日；
--   · 事假扣款的分母**保持 21.75**（法定口径，改了就是不合规）；
--   · 两者分开写清楚，并在断言里各钉一条，防止以后有人"顺手统一"成一个数。
--
-- 口径做成配置项（拿不准的事不写死）：
--   PAY_WORKDAYS_SOURCE = 'calendar'(默认) | 'roster' | 'policy'
--     calendar  当月日历工作日（周一~周五，扣法定假、加调休上班）—— 一般 22 天
--     roster    本期排班天数（非休息班）；没排班时退回 calendar
--     policy    制度 PAY_DAYS_PER_MONTH（= 21.75，迁移前的行为，可回退）
-- ★ 默认值从"21.75"改成"日历工作日"是**行为变更**，不是兼容升级：
--   下期算薪起，按出勤折算类的项会按当月的真实天数算（11 月 21 天、12 月 23 天）。
--   历史工资条不动（明细已固化）。要回到原口径，改制度项为 policy 即可。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 法定节假日/调休表
-- ---------------------------------------------------------------------------
-- 应出勤要"扣法定假、加调休上班"，就得有一张表说清哪天是什么。
-- 不写死在函数里：每年公告都不同，写死等于明年一定错。
CREATE TABLE IF NOT EXISTS legal_holiday (
  holiday_date date PRIMARY KEY,
  name         varchar(32) NOT NULL,
  -- is_workday = true 表示"这天虽然是周末但要上班"（调休）；false = 法定假日（放假）
  is_workday   boolean NOT NULL DEFAULT false,
  note         varchar(200)
);

COMMENT ON TABLE legal_holiday IS
  '法定节假日与调休。应出勤 = 日历工作日 − 法定假 + 调休上班。'
  '★ 只预置了公历可确定的假日（元旦/清明/劳动/国庆）；春节、端午、中秋是农历，'
  '  必须按当年国务院公告维护 —— 没维护的那几个月，应出勤会把法定假算成工作日（偏高 1~3 天）。'
  '  这不是"忘了"，是不替客户猜政策：猜错一天，全公司那一天的钱都错。';

INSERT INTO legal_holiday(holiday_date, name, is_workday, note) VALUES
  ('2026-01-01','元旦',      false, '公历固定'),
  ('2026-04-05','清明节',    false, '节气，公历可定（2026 为周日，不影响工作日数）'),
  ('2026-05-01','劳动节',    false, '公历固定'),
  ('2026-10-01','国庆节',    false, '公历固定'),
  ('2026-10-02','国庆节',    false, '公历固定'),
  ('2026-10-03','国庆节',    false, '公历固定')
ON CONFLICT (holiday_date) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. 日历工作日
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_calendar_workdays(p_from date, p_to date)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT count(*)::numeric
    FROM generate_series(p_from, p_to, interval '1 day') AS g
    LEFT JOIN public.legal_holiday h ON h.holiday_date = g::date
   WHERE CASE
           WHEN h.holiday_date IS NULL THEN extract(isodow FROM g) < 6   -- 普通日：周一~周五
           WHEN h.is_workday THEN true                                    -- 调休上班（周末也算）
           ELSE false                                                     -- 法定假日（含周末，算放假日）
         END;
$$;

COMMENT ON FUNCTION fn_calendar_workdays IS
  '区间内的应出勤天数：周一~周五，扣法定假日，加调休上班。'
  '一般 20~23 天（常见 22）。与月计薪天数 21.75 是两个概念，别互相替代。';

-- ---------------------------------------------------------------------------
-- 3. 制度项：应出勤口径来源
-- ---------------------------------------------------------------------------
-- policy_value 有外键指 policy_def，所以先登记"有这么一项制度"，再给值。
-- 登记与取值分开，是为了让"这项制度存在但还没定值"成为合法状态 ——
-- 没定值时 fn_policy_effective 返回空，调用方按默认兜底。
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor)
VALUES ('PAY_WORKDAYS_SOURCE',
        '应出勤天数口径（当月日历工作日 / 排班天数 / 月计薪天数）',
        'PAYROLL', 'enum', true, 'store')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('PAY_WORKDAYS_SOURCE', '2026-01-01', 'calendar', 'system',
        '应出勤取当月日历工作日（默认）/ roster=排班天数 / policy=月计薪天数21.75（旧口径）')
ON CONFLICT (policy_code, effective_from)
  DO UPDATE SET value_text = 'calendar';

-- ---------------------------------------------------------------------------
-- 4. 考勤口径：加 calendar_days / roster_days / workdays_source
-- ---------------------------------------------------------------------------
-- ★ 返回类型加了列，CREATE OR REPLACE 不行（42P13），必须先 DROP。
DROP FUNCTION IF EXISTS fn_att_person_period(bigint, varchar);

CREATE OR REPLACE FUNCTION fn_att_person_period(p_person bigint, p_period varchar)
RETURNS TABLE (present_days numeric, work_days numeric, leave_days numeric,
               work_hours numeric, ot_hours numeric,
               calendar_days numeric, roster_days numeric, workdays_source varchar)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_start date := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end   date;
  v_std_h numeric(6,2);
  v_src   varchar(16);
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM（收到 %）', p_period;
  END IF;
  v_end := (v_start + interval '1 month - 1 day')::date;

  SELECT COALESCE(value_num, 8) INTO v_std_h
    FROM public.fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, v_end);

  -- ① 出勤：考勤人日（封账后的口径）
  -- ★ 必须给表起别名：RETURNS TABLE 的列名（present_days/work_hours/…）
  --   在函数体里就是变量，与表列同名会得到 "column reference is ambiguous"。
  SELECT COALESCE(count(DISTINCT a.work_date), 0)::numeric,
         COALESCE(sum(a.work_hours), 0)::numeric,
         COALESCE(sum(GREATEST(a.work_hours - v_std_h, 0)), 0)::numeric
    INTO present_days, work_hours, ot_hours
    FROM public.attendance_daily_store a
   WHERE a.employee_id = p_person AND a.work_date BETWEEN v_start AND v_end
     AND a.work_hours > 0;

  -- ② 回退：还没封账时用打卡去重天数（不是主口径，只是别让公式变成 0）
  IF present_days = 0 THEN
    SELECT count(DISTINCT (p.punch_at AT TIME ZONE public.app_tz())::date)::numeric
      INTO present_days
      FROM public.punch p
     WHERE p.employee_id = p_person
       AND (p.punch_at AT TIME ZONE public.app_tz())::date BETWEEN v_start AND v_end;
    IF present_days IS NULL THEN present_days := 0; END IF;
  END IF;

  -- ③ 日历工作日（当月该来的天数，一般 22）
  calendar_days := public.fn_calendar_workdays(v_start, v_end);

  -- ④ 排班天数：非休息班才算"该来"。休息班是"这天就是休"，不是"该来但没来"；
  --    班次为空（格子在、班次没定）也不算 —— 未定的班不是应出勤。
  SELECT COALESCE(count(*), 0)::numeric INTO roster_days
    FROM public.roster_slot rs
    JOIN public.shift_def sd ON sd.code = rs.shift_code
   WHERE rs.employee_id = p_person
     AND rs.work_date BETWEEN v_start AND v_end
     AND NOT sd.is_rest;

  -- ⑤ 应出勤：看制度开关
  SELECT COALESCE(value_text, 'calendar') INTO v_src
    FROM public.fn_policy_effective('PAY_WORKDAYS_SOURCE', NULL, v_end);

  IF v_src = 'policy' THEN
    SELECT COALESCE(value_num, 21.75) INTO work_days
      FROM public.fn_policy_effective('PAY_DAYS_PER_MONTH', NULL, v_end);
    workdays_source := 'policy';
  ELSIF v_src = 'roster' AND roster_days > 0 THEN
    work_days := roster_days;
    workdays_source := 'roster';
  ELSE
    -- calendar，以及"选了 roster 但本期一天没排"：都用日历工作日。
    -- ★ 后者不是降级，是必须：应出勤 0 会让 prorata 除零、日薪变成无穷大。
    --   **"没排班"不等于"应出勤 0 天"**。
    work_days := calendar_days;
    workdays_source := 'calendar';
  END IF;

  -- ⑥ 请假：各假种已批准天数之和（复用同一口径函数，不另写一遍）
  SELECT COALESCE(sum(public.fn_leave_approved_days(p_person, p_period, t.code)), 0)::numeric
    INTO leave_days
    FROM public.leave_type t;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_att_person_period IS
  '某人某期的考勤口径：出勤/应出勤/请假/工时/加班/日历工作日/排班天数/应出勤来源。'
  '应出勤由 PAY_WORKDAYS_SOURCE 决定：calendar(默认,当月实际工作日)/roster(排班)/policy(21.75)。'
  '出勤优先取封账后人日，无则退回打卡去重天数。';

-- ---------------------------------------------------------------------------
-- 5. 事假扣款：分母是**月计薪天数**，不是应出勤
-- ---------------------------------------------------------------------------
-- 两件事：
--   ① 分母保持 21.75（法定折算口径）。改成"当月工作日"会让同一个员工
--      在 2 月（20 天）和 12 月（23 天）请同一天假扣出不同的钱，那不合规。
--   ② 顺手修一个日期口径的错：原来用 app_today() 取制度，
--      于是补一条"今天起生效"的制度，去算三个月前的工资会用到新制度 ——
--      而制度之所以带 effective_from，就是为了不让这件事发生。
CREATE OR REPLACE FUNCTION fn_leave_deduction(p_employee bigint, p_period varchar)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(round(
           public.fn_leave_approved_days(p_employee, p_period, 'PERSONAL')
           * (SELECT s.monthly_amount
                   / GREATEST((SELECT COALESCE(value_num, 21.75)
                                 FROM public.fn_policy_effective(
                                      'PAY_DAYS_PER_MONTH', NULL,
                                      (to_date(p_period || '-01','YYYY-MM-DD')
                                       + interval '1 month - 1 day')::date)), 1)
                FROM public.salary_standard s
                JOIN public.employment e ON e.id = s.employment_id
               WHERE e.person_id = p_employee
               ORDER BY s.effective_from DESC LIMIT 1), 2), 0);
$$;

COMMENT ON FUNCTION fn_leave_deduction IS
  '事假扣款 = 天数 × 日薪。日薪 = 月薪标准 ÷ 月计薪天数（PAY_DAYS_PER_MONTH，默认 21.75）。'
  '★ 分母用月计薪天数、不用应出勤：同一天假在不同月份扣不同的钱不合规。'
  '应出勤（fn_att_person_period.work_days）只用于按出勤折算类的项，两者不要混。'
  '制度按**本期期末**取，不按 app_today()：制度带生效日就是为了不追溯。';

-- ---------------------------------------------------------------------------
-- 6. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RSD','应出勤口径：日历工作日/排班/制度三档，扣款分母仍 21.75',
   'PAYROLL','ACL','fn_calendar_workdays','public','legal_holiday','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
