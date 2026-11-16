-- ============================================================================
-- 148_roster_line.sql · 划线排班：上到几点就划到几点
-- ----------------------------------------------------------------------------
-- 145 只做了"从班次主数据里挑一个"（早班/中班/闭店……）。那是**固定班次**的排法，
-- 适合全职员工。而门店真正的排班难点不是这个：
--
--   兼职工、临时工、小时工 ——「今天下午 4 点到 9 点来帮忙」
--   上到几点就划到几点，根本不是哪个"班"。
--
-- 鸿欢的《划线排班软件》（软著 2021SR1077856）做的就是这件事。钉钉高级排班的
-- 产品资料原话是：
--
--   「兼职工/临时工考勤排班 —— 上到几点就划到几点，
--     自动设置排休规则及休息时长，自动设置休息时间后，是否允许排班人修改」
--
-- ★ 所以「划线」不是"在表格上拖着涂格子"（那是排班表的通用手势），
--   而是**时间轴上的任意区间**：起点不定、终点不定、时长不定。
--   145 的 schedule_segment 本来就是"任意时段"的结构（start_at / end_at），
--   只是 145 只从 shift_def 推导它。这一版把入口补上：直接给时段。
--
-- ★ 三条必须钉住的：
--
--   ① **时段不许重叠**（同人同一天）。划两段叠在一起 = 两倍工时，
--      而工资是按工时算的 —— 这不是排班不好看，是多付钱。
--
--   ② **休息时长按规则自动扣，但允许排班人改**。划线往往一划 8 小时，
--      而中间有没有吃饭时间、扣多久，各家不同。默认值进制度项（默认 0 = 不扣），
--      排班人可以显式传一个数覆盖。**扣了要让工资条看得见**（进段的休息分钟数）。
--
--   ③ **不动 145 的班次路径**。固定班次与划线是两条入口、一张表
--      （schedule + schedule_segment），谁都不许绕开段表直接写工时。
--
-- ★ 一件不做：不做"时间轴甘特图"。周视图是"人 × 日期"，横轴是日期不是时刻，
--   在那张表上横着划是"划一段日期"，不是"划一段时间"。真做时间轴要另一张视图
--   （24 小时刻度 × 人），那是下一步的事 —— 现在先用一个"时刻刻度条"面板取时段，
--   交互上仍然是"划"，数据结构上已经是任意区间。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 划线**不需要**班次身份（第一版走过弯路，记在这）
-- ---------------------------------------------------------------------------
-- 第一版给划线插了一条虚拟班次 `LINE`，只为满足 `schedule.shift_id NOT NULL`。
-- 结果它在界面的班次调色板里冒出一个"划线（按时段）"的 chip，点一下会排成
-- 00:00–23:59 的一整天 —— 一个谁都不认识、但看起来能用的班次。
--
-- 正确做法是让 `shift_id` 允许为空：划线没有"班次身份"，它就是一段时间。
-- 见下面 0.5。这里不再插入任何班次。
--
-- （如果某个库里已经有 code='LINE' 的班次，它只是历史残留，不影响判据：
--   fn_roster_line 不再引用它，fn_roster_week 用 COALESCE 兜底显示"划线"。）

-- ---------------------------------------------------------------------------
-- 0.5 让"一天多段"真的成立（008 的唯一键挡着）
-- ---------------------------------------------------------------------------
-- `schedule` 上有 `UNIQUE (employee_id, work_date, shift_id)`，本意是"同一天
-- 同一个班次不能排两次"。这对固定班次是对的，但**划线排班天生要同一天多段**
-- （上午 8-12、下午 4-9），而每一段都挂同一个班次身份 → 第二条直接 23505。
--
-- 而"一天多班次"是产品明写的能力（白皮书 2.2.6），不是可选增强。
--
-- 改法：`shift_id` 允许为空（划线不带班次身份），唯一键改成**部分唯一索引**
-- （只约束"有班次身份的那些行"）。于是：
--   · 固定班次：同一天同一个班次仍然只能排一次 ✓
--   · 划线：可以同一天多段，**重叠由 fn_roster_line 的时段检查保证** ✓
--     （时段重叠才是"两倍工时"，班次相同并不构成问题）
ALTER TABLE public.schedule ALTER COLUMN shift_id DROP NOT NULL;
ALTER TABLE public.schedule
  DROP CONSTRAINT IF EXISTS schedule_employee_id_work_date_shift_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_schedule_shift_once
  ON public.schedule (employee_id, work_date, shift_id)
  WHERE shift_id IS NOT NULL;

COMMENT ON COLUMN public.schedule.shift_id IS
  '固定班次的班次身份（shift_def.shift_id）。**划线排班为 NULL** —— '
  '它的时段在 schedule_segment 里，不在班次主数据里。'
  '部分唯一索引 ux_schedule_shift_once 只约束非空行，所以同一天可以有多段划线。';

-- ---------------------------------------------------------------------------
-- 1. 制度项：休息怎么扣
-- ---------------------------------------------------------------------------
-- 两个数分开：**超过多少小时才扣**、**扣多少分钟**。
-- 默认 6 小时 / 0 分钟 —— "超过 6 小时按规则扣，但默认不扣"是刻意的：
-- 一上线就自动扣掉 60 分钟，会让人当月工资对不上，而他们第一反应是"系统算错"。
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('ROSTER_BREAK_AFTER_H', '划线排班：超过多少小时开始扣休息', 'ATTENDANCE', 'numeric', true, 'store', '小时'),
       ('ROSTER_BREAK_MIN',     '划线排班：扣多少分钟休息',           'ATTENDANCE', 'numeric', true, 'store', '分钟')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
VALUES ('ROSTER_BREAK_AFTER_H', '2026-01-01', 6, 'group_hr', '超过 6 小时才谈休息，短班不扣'),
       ('ROSTER_BREAK_MIN',     '2026-01-01', 0, 'group_hr',
        '默认 0 = 不扣（沿用上线前行为）：一上线就自动扣 60 分钟，当月工资会对不上')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. 划线排班
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_roster_line(
  p_employee bigint,
  p_date     date,
  p_from     time,
  p_to       time,
  p_store    bigint,
  p_break_min int     DEFAULT NULL,    -- NULL = 按制度项算；传值 = 排班人显式覆盖
  p_reason   varchar DEFAULT NULL,
  p_by       varchar DEFAULT 'system'
) RETURNS TABLE (schedule_id bigint, segment_id bigint, minutes int, break_min int, net_minutes int)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_sid     bigint;
  v_seg     bigint;
  v_start   timestamptz;
  v_end     timestamptz;
  v_min     int;
  v_brk     int;
  v_net     int;
  v_cost    bigint;
  v_shift   bigint;
  v_after_h numeric(6,2);
  v_rule    numeric(6,2);
  v_locked  int;
  v_block   record;
BEGIN
  IF p_employee IS NULL OR p_date IS NULL OR p_store IS NULL
     OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'E_ROSTER_LINE_ARGS: 人 / 日期 / 门店 / 起 / 止 都必须给';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.employment em WHERE em.person_id = p_employee) THEN
    RAISE EXCEPTION 'E_ROSTER_NO_EMPLOYEE: 人 % 在库里没有任何任职记录（排班要挂在真人身上）',
      p_employee;
  END IF;

  -- 已锁定的那一期不许再划（与 145 同一条规矩：锁定之后排班不再变）
  SELECT count(*)::int INTO v_locked
    FROM public.schedule s
    JOIN public.schedule_segment sg ON sg.schedule_id = s.id
    JOIN public.confirm_sheet cs   ON cs.segment_id = sg.id
   WHERE s.employee_id = p_employee AND s.work_date = p_date
     AND cs.status = 'locked';
  IF v_locked > 0 THEN
    RAISE EXCEPTION 'E_ROSTER_LOCKED: 人 % 在 % 的排班已锁定，划线前要先把确认退回去',
      p_employee, p_date;
  END IF;

  -- 时段：下班 <= 上班 = 跨零点，落到次日（闭店、夜班都这样）
  v_start := (p_date + p_from) AT TIME ZONE public.app_tz();
  v_end   := (p_date + p_to)   AT TIME ZONE public.app_tz();
  IF v_end <= v_start THEN
    v_end := v_end + interval '1 day';
  END IF;
  v_min := ROUND(EXTRACT(epoch FROM (v_end - v_start)) / 60)::int;

  IF v_min < 15 THEN
    RAISE EXCEPTION 'E_ROSTER_TOO_SHORT: 划出来只有 % 分钟（少于 15 分钟不给排 —— '
      '那不是一段班，是手抖）', v_min;
  END IF;
  IF v_min > 16 * 60 THEN
    RAISE EXCEPTION 'E_ROSTER_TOO_LONG: 划出来 % 小时（单段上限 16 小时；'
      '更长的请拆成两段，否则工时统计与加班判定都会失真）', ROUND(v_min / 60.0, 1);
  END IF;

  -- 重叠：同一天已有的段（跨零点的把邻日也算上，与 145 一致）
  IF EXISTS (
    SELECT 1
      FROM public.schedule s2
      JOIN public.schedule_segment sg2 ON sg2.schedule_id = s2.id
     WHERE s2.employee_id = p_employee
       AND s2.work_date BETWEEN p_date - 1 AND p_date + 1
       AND tstzrange(sg2.start_at, sg2.end_at, '[)') && tstzrange(v_start, v_end, '[)')
  ) THEN
    RAISE EXCEPTION 'E_ROSTER_OVERLAP: 人 % 在 % 有一段与 % ~ % 重叠的排班'
      '（同一时段两段 = 两倍工时，而工资按工时算）',
      p_employee, p_date, p_from, p_to;
  END IF;

  -- 休息：排班人显式给了就按他的，没给按制度项
  SELECT COALESCE(value_num, 6) INTO v_after_h
    FROM public.fn_policy_effective('ROSTER_BREAK_AFTER_H', NULL, p_date);
  SELECT COALESCE(value_num, 0) INTO v_rule
    FROM public.fn_policy_effective('ROSTER_BREAK_MIN', NULL, p_date);

  IF p_break_min IS NOT NULL THEN
    v_brk := GREATEST(p_break_min, 0);
  ELSIF v_min > COALESCE(v_after_h, 6) * 60 THEN
    v_brk := GREATEST(COALESCE(v_rule, 0), 0)::int;
  ELSE
    v_brk := 0;     -- 短班不扣
  END IF;

  IF v_brk >= v_min THEN
    RAISE EXCEPTION 'E_ROSTER_BREAK: 休息 % 分钟不小于划线时长 % 分钟（扣完就不是一段班了）',
      v_brk, v_min;
  END IF;
  v_net := v_min - v_brk;

  -- ★ 规则层（149）：超上限就排不进去。校验只有一份实现（fn_roster_check），
  --   划线、固定班次、周期排班都调它 —— 三处各写一遍必然有一处漏。
  --   预警（kind='warn'）不拦，页面另给黄条。
  SELECT * INTO v_block
    FROM public.fn_roster_check(p_employee, p_date, p_store, v_min) c
   WHERE c.kind = 'block'
   LIMIT 1;
  IF v_block.rule_code IS NOT NULL THEN
    RAISE EXCEPTION 'E_ROSTER_OVERRULE: %（规则 %）', v_block.message, v_block.rule_code;
  END IF;

  -- 建计划（**不挂班次**）+ 段 + 确认单 + roster_slot 镜像（与 145 同一套）
  -- ★ shift_id 为 NULL 是刻意的：划线没有"班次身份"，它就是一段时间。
  --   挂一条虚拟班次也能跑，但那样"按班次统计工时"会把所有划线算成同一个班，
  --   而它们的时长各不相同 —— 统计口径会悄悄错掉。
  INSERT INTO public.schedule(employee_id, work_date, shift_id, store_id)
  VALUES (p_employee, p_date, NULL, p_store)
  RETURNING id INTO v_sid;

  INSERT INTO public.schedule_segment(schedule_id, seq, store_id, start_at, end_at)
  VALUES (v_sid, 1, p_store, v_start, v_end)
  RETURNING id INTO v_seg;

  -- 确认单与段同生（008：段有行 = 该有确认单，不是一种可选状态）
  INSERT INTO public.confirm_sheet(segment_id, status) VALUES (v_seg, 'not_started');

  -- ★ shift_code 写 NULL：划线没有班次身份（这张表 shift_code 有外键到 shift_def，
  --   而 NULL 是合法的）。副作用是 fn_is_rest_day 读到这里不会当成"休息" ——
  --   那是对的：划线是一段工时，不是休息。
  INSERT INTO public.roster_slot(employee_id, store_id, work_date, shift_code, updated_by)
  VALUES (p_employee, p_store, p_date, NULL, p_by)
  ON CONFLICT (employee_id, work_date) DO UPDATE
    SET store_id = EXCLUDED.store_id, shift_code = EXCLUDED.shift_code,
        updated_by = EXCLUDED.updated_by, updated_at = now();

  RETURN QUERY SELECT v_sid, v_seg, v_min, v_brk, v_net;
END;
$$;

COMMENT ON FUNCTION fn_roster_line IS
  '划线排班（148）：给人划一段任意时段（上到几点就划到几点），写 schedule + segment + 确认单。'
  '休息按制度项自动扣、允许排班人显式覆盖；与已有段重叠直接拒（两段重叠 = 两倍工时）。'
  '与 145 的固定班次是两条入口、一张表 —— 谁都不绕开段表直接写工时。';

-- ---------------------------------------------------------------------------
-- 3. 划线的工时汇总（按人按期间，毛/净/休息分开）
-- ---------------------------------------------------------------------------
-- 页面要回答"这个人这周划了多少小时、其中休息多少"。
-- 不把净工时塞进 roster_slot（那张表不参与算薪口径），只在这里现算。
CREATE OR REPLACE FUNCTION fn_roster_line_hours(p_person bigint, p_from date, p_to date)
RETURNS TABLE (gross_minutes int, segments int)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(ROUND(SUM(EXTRACT(epoch FROM (sg.end_at - sg.start_at)) / 60))::int, 0),
         count(*)::int
    FROM public.schedule s
    JOIN public.schedule_segment sg ON sg.schedule_id = s.id
   WHERE s.employee_id = p_person
     AND s.work_date BETWEEN p_from AND p_to
     AND s.shift_id IS NULL;      -- 划线 = 没有班次身份的那些
$$;

COMMENT ON FUNCTION fn_roster_line_hours IS
  '某人一段日期里"划线"的毛工时与段数。只看 LINE 班次 —— '
  '固定班次的工时归考勤，不在这里重复计。';

-- ---------------------------------------------------------------------------
-- 4. 判据组登记
-- ---------------------------------------------------------------------------
-- ★ 判据码前缀 RL（roster line）：SUITE.RL / SUITE.API-RL。
--   别用 SUITE.R（与多帐套那组撞），也别用 SUITE.RV（145 已用）。
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RL','划线排班：任意时段、跨零点、自动扣休息、重叠拒、锁定后不许划',
   'ATTENDANCE','ALGORITHM','fn_roster_line','public','schedule_segment','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-RL','划线接进接口与界面：划一段、看得到时长与休息',
   'ATTENDANCE','ACL','fn_roster_line','public','schedule_segment','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
