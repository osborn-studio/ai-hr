-- ============================================================================
-- 102_att_period_vars.sql · 出勤天数真正接进工资公式
-- ----------------------------------------------------------------------------
-- 097 把 formula 里的 PRESENT_DAYS / WORK_DAYS / LEAVE_DAYS 固定成 0，
-- 并在注释里写明"暂未接入"。那是有意的（给 0 比猜一个数诚实），但公式因此
-- 是**残的**：`prorata(600, PRESENT_DAYS, WORK_DAYS)` 永远算成 600，
-- `if(PRESENT_DAYS >= 21, ...)` 永远不成立。
--
-- 这一版把它接上，口径写清楚：
--
--   PRESENT_DAYS  出勤天数：考勤人日里有工作小时的天数（封账后的口径）。
--                 没有封账数据时退回**打卡去重天数** —— 只在"还没封账但已经
--                 算了薪"这种不该发生的情形下才会用到，所以不算主要口径。
--   WORK_DAYS     应出勤天数：制度 PAY_DAYS_PER_MONTH（默认 21.75）
--   LEAVE_DAYS    请假天数：各假种已批准天数之和（与事假扣款同一个来源）
--   WORK_HOURS    实际工时合计
--   OT_HOURS      加班小时（超过每日标准工时的部分，按制度 PAY_WORK_HOURS_DAY）
--
-- ★ 为什么不在公式里让客户自己写"多少天"：
--   天数一旦可以通过参数传，就会有人传一个"看起来对"的数，
--   而工资与考勤从此有两个口径。天数只能来自考勤，不能来自公式。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_att_person_period(p_person bigint, p_period varchar)
RETURNS TABLE (present_days numeric, work_days numeric, leave_days numeric,
               work_hours numeric, ot_hours numeric)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_start date := to_date(p_period || '-01', 'YYYY-MM-DD');
  v_end   date;
  v_std_h numeric(6,2);
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

  -- ③ 应出勤：制度（与事假扣款的"月计薪天数"是同一项）
  SELECT COALESCE(value_num, 21.75) INTO work_days
    FROM public.fn_policy_effective('PAY_DAYS_PER_MONTH', NULL, v_end);

  -- ④ 请假：各假种已批准天数之和（复用同一口径函数，不另写一遍）
  SELECT COALESCE(sum(public.fn_leave_approved_days(p_person, p_period, t.code)), 0)::numeric
    INTO leave_days
    FROM public.leave_type t;

  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_att_person_period IS
  '某人某期的考勤口径：出勤天数/应出勤/请假/工时/加班。'
  '出勤优先取封账后的人日；没有封账数据时退回打卡去重天数（不是主口径）。';

-- ---------------------------------------------------------------------------
-- 内置变量补两个（工时与加班）
-- ---------------------------------------------------------------------------
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
                            'GROSS','NET','SI_EMPLOYEE','IIT','LEAVE_DEDUCT','PERF_BONUS',
                            'WORK_HOURS','OT_HOURS'];
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
    IF lower(m) IN ('and', 'or', 'not') THEN CONTINUE; END IF;
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

-- 探测变量同步补全（否则试算时报 column "ot_hours" does not exist）
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
                   'GROSS',1,'NET',1,'SI_EMPLOYEE',1,'IIT',1,
                   'LEAVE_DEDUCT',1,'PERF_BONUS',1,'WORK_HOURS',1,'OT_HOURS',1)) AS k(key));
$$;

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.AP','考勤口径进工资：出勤/应出勤/请假/工时/加班 五个数同源，公式可用',
   'ATTENDANCE','ALGORITHM','fn_att_person_period','public','attendance_daily_store','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
