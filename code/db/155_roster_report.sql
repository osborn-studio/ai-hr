-- ============================================================================
-- 155_roster_report.sql · 排班报表：排班率 / 班次热力图 / 人员工时
-- ----------------------------------------------------------------------------
-- 这一版补的是**读**：145 有了写入（排 → 段 → 确认单），148 有了划线，
-- 但没有任何一个函数能回答"这一周排满了没有"。
--
-- 产品里对应「排班报表 / 排班率报表」，有三张视图：
--   ① 按天的排班率       —— need / planned / rate / temp
--   ② 按班次的热力图     —— 颜色越深人数越多（行=班次，列=日期）
--   ③ 按员工的工时       —— 一把尺子量"排了"和"上了"
--
-- ★ 三条口径，写在这里是因为它们错了都不会报错，只会给出一个"看起来对"的数：
--
--   1) **"已排"与"已发生"必须分开**。产品原话是"实时掌握已排和已发生工时"。
--      合成一个数就分不清两件完全不同的事：
--        · 排了没上（计划落空：人没来，工时要按旷工/调休处理）
--        · 没排却上了（计划外：临时顶班、跨店支援，钱要付但排班表上看不见）
--      所以 fn_roster_hours 同时给 planned_minutes 与 happened_minutes，
--      **不给"合计工时"** —— 一个合计把这两个问题都盖住了。
--
--   2) **休息不算已排**。只排了休息的人，当天 planned = 0。
--      但**他不是"漏排"**：休息是排过的结论，不是没人排。
--      所以 need − planned 这个差额里混着两种人（排了休 + 完全没排），
--      **不能用它回答"谁漏排"**。要精确回答那个问题，得看 schedule 表有没有行
--      （有行 = 排过，哪怕排的是休息）—— fn_roster_hours 的 planned_minutes = 0
--      只能说明"这天没有工时"，不说明"这天没人管他"。
--      这是这一版**故意不做**的一件事：hardcode 一个"漏排人数"必然把休息算进去，
--      而把休息算成漏排的报表，店长看两次就不看了。
--
--   3) **need = 0 时 rate 返回 NULL，不返回 0**。0 会被页面渲染成"排班率 0%"，
--      而真相是"这天没有在职的人"（新店、全店离职、组织挂错）。
--      这两件事在报表上是相反的结论：一个是排班失败，一个是分母不存在。
--
-- ★ 分子与分母必须来自**同一个集合**：都按"人挂在 p_org 上"取
--   （employment 覆盖当天 × attendance_org 或 cost_org 覆盖当天），
--   **不按 segment.store_id 取**。理由：跨店支援（145 的跨店原因）是真实操作，
--   按门店数段的话，A 店的人去 B 店上班会让 A 店的 planned 少一个、
--   need 不变 —— 排班率被低估，而 B 店反过来会超过 100%。
--   "谁在哪家店上班"是 fn_roster_week 的问题，不是排班率的问题。
--
-- ★ 一个不做的：这里不算"应排天数"（月内应出勤日 × 人数）。
--   那需要日历 + 假期 + 制度项三套口径，而 023/146 的报表链已经有一套；
--   在这里再造一套，两套数字迟早对不上，且对不上的时候没人知道信哪个。
--   本函数的 need 是**当天在职人数**，口径窄而明确。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 三个函数共用的日期区间校验
-- ---------------------------------------------------------------------------
-- ★ 天数上限 31（与 fn_roster_week / fn_roster_export 一致）：
--   这一屏是"周/月"视图，39 天以上不是它的使用场景；
--   放开上限只会在页面上产生一个横轴宽到看不清的热力图。
--   ★ 这个校验在三个函数里各写一遍（不抽公共函数）：
--     抽了之后报错信息会变成"fn_roster_span: ..."，
--     而调用方看到的是哪个接口的参数错，不是哪个内部函数错。
--     p_org 必须存在：不存在的组织算出一片 NULL，看起来像"这家店没人上班"。

-- ---------------------------------------------------------------------------
-- 1. 排班率（按天）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_roster_rate(
  p_org  bigint,
  p_from date,
  p_days int
) RETURNS TABLE (work_date date, need int, planned int, rate numeric, temp int)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_to date;
BEGIN
  IF p_org IS NULL OR p_org <= 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: org 必须是正整数（org_unit.id）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_unit o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'E_ORG_NOT_FOUND: 组织 % 不存在（排班率要有一个真的组织当分母）', p_org;
  END IF;
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: from 必填（YYYY-MM-DD）';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 31 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 天数取 1..31（收到 %）', p_days;
  END IF;
  v_to := p_from + p_days - 1;

  RETURN QUERY
  WITH d AS (
    SELECT g::date AS work_date
      FROM generate_series(p_from, v_to, interval '1 day') g
  ),
  -- 当天在职 × 当天挂在本组织上的人（两个维度都认）。
  -- ★ 两个维度都认不是宽松，是**容错**：真实客户里有的把门店挂在 cost_org、
  --   有的挂在 attendance_org；只认一个会让 half 的门店 need = 0，
  --   于是排班率全年 NULL，看起来像"系统没数据"。
  pop AS (
    SELECT DISTINCT d.work_date, e.person_id
      FROM d
      JOIN public.employment e
        ON daterange(e.hire_date, e.leave_date, '[]') @> d.work_date
     WHERE EXISTS (SELECT 1
                     FROM public.employee_org_assignment a
                    WHERE a.employee_id = e.person_id
                      AND a.org_id = p_org
                      AND a.dim_code IN ('attendance_org', 'cost_org')
                      AND daterange(a.valid_from, a.valid_to, '[]') @> d.work_date)
  ),
  -- need：当天在职人数
  need AS (
    SELECT pop.work_date, count(*)::int AS n FROM pop GROUP BY pop.work_date
  ),
  -- planned：当天**有段**的人数。没有段 = 没排（排了休息的也没有段，145 不给休息建段）
  pl AS (
    SELECT sc.work_date,
           count(DISTINCT sc.employee_id)::int AS planned,
           -- temp：当天**划线**的人数（shift_id IS NULL，148 的划线没有班次身份）
           count(DISTINCT sc.employee_id)
             FILTER (WHERE sc.shift_id IS NULL)::int AS temp
      FROM public.schedule sc
      JOIN public.schedule_segment sg ON sg.schedule_id = sc.id
      JOIN pop ON pop.person_id = sc.employee_id
              AND pop.work_date = sc.work_date
     WHERE sc.work_date BETWEEN p_from AND v_to
     GROUP BY sc.work_date
  )
  SELECT d.work_date,
         COALESCE(need.n, 0),
         COALESCE(pl.planned, 0),
         -- ★ need = 0 → NULL。0 会被读成"排班率 0%"，而真相是"没有分母"。
         CASE WHEN COALESCE(need.n, 0) = 0 THEN NULL
              ELSE round(COALESCE(pl.planned, 0)::numeric / need.n, 4)
         END,
         COALESCE(pl.temp, 0)
    FROM d
    LEFT JOIN need ON need.work_date = d.work_date
    LEFT JOIN pl   ON pl.work_date   = d.work_date
   ORDER BY d.work_date;
END;
$$;

COMMENT ON FUNCTION fn_roster_rate IS
  '排班率（155）：逐日的 在职人数 / 已排人数 / 排班率 / 划线人数。'
  'need = 当天在职且挂在 p_org 上的人数；planned = 当天有段的人数（排休不算，因为休息不是出勤）；'
  'rate = planned / need，**need = 0 时为 NULL**（0 会被读成 0%，而真相是没有分母）；'
  'temp = 当天划线人数。分子分母同一集合（人-组织口径），不按 segment.store_id —— '
  '跨店支援会让按门店数出来的分子超过分母。';

-- ---------------------------------------------------------------------------
-- 2. 按班次的热力图（行=班次，列=日期）
-- ---------------------------------------------------------------------------
-- 产品视频里那张"颜色越深人数越多"的图。两个形状决定：
--
--   · **回完整网格**（每个班次 × 每一天，没有人的格子给 0），
--     不像 fn_roster_week 那样回稀疏行。理由不同：排班表里的空格是"还没排"
--     （不能凭空补），而热力图里的 0 是"这一天这个班没人" —— 那是**信息**，
--     缺格与 0 在热力图上必须是同一个颜色，所以让库里直接给 0，
--     页面不用自己猜"没返回"是什么意思。
--
--   · **划线单占一行 `*TEMP`**（临时班次）。148 之后划线没有班次身份
--     （shift_id IS NULL），把它们的时长混进任何一个真实班次都是在编数字。
--     前缀 `*` 是刻意的：shift_def.code 都是大写业务码，导入的班次码也不会带 `*`，
--     所以前端一眼就能看出"这一行不是班次主数据里的班次"。
--     颜色用 148 里划线的兜底色 #0f766e —— 与周表同一套配色，人才不会看串。
--
-- ★ 排休的班次不出现在行里：它没有段，一行全 0 只会让人以为"有人排了休，
--   只是热力图没画出来"。
CREATE OR REPLACE FUNCTION fn_roster_heat(
  p_org  bigint,
  p_from date,
  p_days int
) RETURNS TABLE (shift_code varchar, shift_name varchar, color varchar,
                 work_date date, person_count int)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_to date;
BEGIN
  IF p_org IS NULL OR p_org <= 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: org 必须是正整数（org_unit.id）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_unit o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'E_ORG_NOT_FOUND: 组织 % 不存在', p_org;
  END IF;
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: from 必填（YYYY-MM-DD）';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 31 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 天数取 1..31（收到 %）', p_days;
  END IF;
  v_to := p_from + p_days - 1;

  RETURN QUERY
  WITH d AS (
    SELECT g::date AS work_date
      FROM generate_series(p_from, v_to, interval '1 day') g
  ),
  pop AS (
    SELECT DISTINCT d.work_date, e.person_id
      FROM d
      JOIN public.employment e
        ON daterange(e.hire_date, e.leave_date, '[]') @> d.work_date
     WHERE EXISTS (SELECT 1
                     FROM public.employee_org_assignment a
                    WHERE a.employee_id = e.person_id
                      AND a.org_id = p_org
                      AND a.dim_code IN ('attendance_org', 'cost_org')
                      AND daterange(a.valid_from, a.valid_to, '[]') @> d.work_date)
  ),
  -- 行：班次主数据（排除休息）+ 一行划线
  sh AS (
    SELECT sd.code, sd.name, sd.color, sd.shift_id,
           row_number() OVER (ORDER BY sd.start_time, sd.code)::int AS ord
      FROM public.shift_def sd
     WHERE NOT sd.is_rest
    UNION ALL
    SELECT '*TEMP'::varchar, '临时班次'::varchar, '#0f766e'::varchar, NULL::bigint, 9999
  ),
  cnt AS (
    SELECT CASE WHEN sc.shift_id IS NULL THEN '*TEMP' ELSE sd.code END AS code,
           sc.work_date,
           count(DISTINCT sc.employee_id)::int AS n
      FROM public.schedule sc
      JOIN public.schedule_segment sg ON sg.schedule_id = sc.id
      JOIN pop ON pop.person_id = sc.employee_id
              AND pop.work_date = sc.work_date
      -- 只用来给固定班次取码与配色；shift_id 为 NULL（划线）时这里是 NULL
      LEFT JOIN public.shift_def sd ON sd.shift_id = sc.shift_id
     WHERE sc.work_date BETWEEN p_from AND v_to
     GROUP BY 1, 2
  )
  SELECT sh.code::varchar, sh.name::varchar, sh.color::varchar,
         d.work_date,
         COALESCE(cnt.n, 0)
    FROM sh
    CROSS JOIN d
    LEFT JOIN cnt ON cnt.code = sh.code AND cnt.work_date = d.work_date
   ORDER BY sh.ord, d.work_date;
END;
$$;

COMMENT ON FUNCTION fn_roster_heat IS
  '班次热力图（155）：行=班次（含一行 *TEMP 临时班次=划线），列=日期，格子=当天该班人数。'
  '★ 回**完整网格**（空格给 0）：热力图里的 0 是信息，缺格与 0 必须是同一个颜色。'
  '只数有段的人（排休不算）；排休的班次整行不出现。';

-- ---------------------------------------------------------------------------
-- 3. 按员工的工时：已排 与 已发生 分两列
-- ---------------------------------------------------------------------------
-- planned_minutes = 排班段时长之和（**毛工时，不扣休息**）：
--   休息是"段间空白"（148：上午 8-12、下午 4-9，中间那 4 小时不在任何段里），
--   它本来就没被算进段时长，所以这里不需要再扣一次 ——
--   再扣一次的人均工时会在有划线的人身上凭空少掉一截。
--
-- happened_minutes 用哪张表？**两张都在，先看哪张有数据**：
--   · attendance_daily_store（人日，005）：唯一能精确落到"这 N 天"的表，
--     每行一天、有 work_hours。**有它就用它**。
--   · att_period_report（月报，114）：HR 确认过的月工时，粒度是**整月**，
--     没有"这 7 天发生了多少"这个数。
--   于是规则写死成两条：
--     ① 这段区间里本组织只要**有人日**，就全部取人日（没记录的人记 0 —— 事实就是没采集到）；
--     ② 一个人日都没有时，**只有区间正好是一整月**才退回月报；
--        区间不是整月就不退 —— 拿整月的工时冒充 7 天，会把"这周上了 4 小时"
--        写成"这周上了 176 小时"，而报表上它看起来完全正常。
--   宁可显示 0（页面即"还没有考勤数据"），也不拿一个粒度和范围都不对的数冒充。
--
-- days = 有段的天数（不是在职天数、不是日历天数）：
--   它是"这个人这周被安排上几天班"的直接答案，排休的天不算。
CREATE OR REPLACE FUNCTION fn_roster_hours(
  p_org  bigint,
  p_from date,
  p_days int
) RETURNS TABLE (employee_id bigint, person_name varchar, employee_no varchar,
                 planned_minutes int, happened_minutes int, days int)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_to    date;
  v_whole boolean;
BEGIN
  IF p_org IS NULL OR p_org <= 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: org 必须是正整数（org_unit.id）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.org_unit o WHERE o.id = p_org) THEN
    RAISE EXCEPTION 'E_ORG_NOT_FOUND: 组织 % 不存在', p_org;
  END IF;
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: from 必填（YYYY-MM-DD）';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 31 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 天数取 1..31（收到 %）', p_days;
  END IF;
  v_to := p_from + p_days - 1;

  -- 只有"正好一整月"才允许退回月报（见上面 ②）
  v_whole := (p_from = (date_trunc('month', p_from))::date
              AND v_to  = (date_trunc('month', p_from) + interval '1 month - 1 day')::date);

  RETURN QUERY
  WITH pop AS (
    SELECT p.id,
           p.full_name::varchar AS person_name,
           (SELECT n.no FROM public.employee_no n
             WHERE n.assigned_person_id = p.id AND n.retired_at IS NULL
             ORDER BY n.assigned_at DESC LIMIT 1)::varchar AS employee_no
      FROM public.person p
     WHERE EXISTS (SELECT 1 FROM public.employment e
                    WHERE e.person_id = p.id
                      AND daterange(e.hire_date, e.leave_date, '[]')
                          && daterange(p_from, v_to, '[]'))
       AND EXISTS (SELECT 1 FROM public.employee_org_assignment a
                    WHERE a.employee_id = p.id
                      AND a.org_id = p_org
                      AND a.dim_code IN ('attendance_org', 'cost_org')
                      AND daterange(a.valid_from, a.valid_to, '[]')
                          && daterange(p_from, v_to, '[]'))
  ),
  -- 这段区间里本组织有没有人日数据（决定 happened 取哪张表）
  obs AS (
    SELECT count(*)::int AS n
      FROM public.attendance_daily_store ads
      JOIN pop ON pop.id = ads.employee_id
     WHERE ads.work_date BETWEEN p_from AND v_to
  ),
  pl AS (
    SELECT sc.employee_id,
           COALESCE(round(SUM(EXTRACT(epoch FROM (sg.end_at - sg.start_at)) / 60))::int, 0)
             AS planned_minutes,
           count(DISTINCT sc.work_date)::int AS days
      FROM public.schedule sc
      JOIN public.schedule_segment sg ON sg.schedule_id = sc.id
     WHERE sc.work_date BETWEEN p_from AND v_to
     GROUP BY sc.employee_id
  ),
  hd AS (
    SELECT ads.employee_id,
           round(SUM(ads.work_hours) * 60)::int AS minutes
      FROM public.attendance_daily_store ads
     WHERE ads.work_date BETWEEN p_from AND v_to
     GROUP BY ads.employee_id
  ),
  hm AS (
    SELECT r.person_id AS employee_id,
           round(SUM(r.work_hours) * 60)::int AS minutes
      FROM public.att_period_report r
     WHERE r.period = to_char(p_from, 'YYYY-MM')
     GROUP BY r.person_id
  )
  SELECT pop.id, pop.person_name, pop.employee_no,
         COALESCE(pl.planned_minutes, 0),
         COALESCE(hd.minutes,
                  CASE WHEN (SELECT n FROM obs) = 0 AND v_whole
                       THEN COALESCE(hm.minutes, 0)
                       ELSE 0 END),
         COALESCE(pl.days, 0)
    FROM pop
    LEFT JOIN pl ON pl.employee_id = pop.id
    LEFT JOIN hd ON hd.employee_id = pop.id
    LEFT JOIN hm ON hm.employee_id = pop.id
   ORDER BY pop.id;
END;
$$;

COMMENT ON FUNCTION fn_roster_hours IS
  '按员工的工时（155）：planned_minutes（排班段毛工时，不扣休息）与'
  'happened_minutes（实际考勤工时）**分两列**，不合并 —— 合并后分不清'
  '"排了没上"和"没排却上了"，而那两件事的处置完全相反。'
  'happened 优先取 attendance_daily_store（唯一能精确落到这 N 天的表）；'
  '本组织在区间内一个人日都没有、且区间正好是一整月时，才退回 att_period_report 的月工时。'
  'days = 有段的天数（排休的天不算）。';
