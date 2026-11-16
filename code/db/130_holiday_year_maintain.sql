-- ============================================================================
-- 130_holiday_year_maintain.sql · 节假日年度维护：看得见缺口，才补得上
-- ----------------------------------------------------------------------------
-- 125 把三种类型分开了（legal 300% / rest 200% / workday 上班），也写清了
-- "这份安排每年 11 月才公布，写死只覆盖 2026"。但只留了增删改三个动作，
-- 于是真实场景是这样过的：
--
--   12 月 20 日算明年 1 月的薪 → 应出勤按纯周末算 → 元旦被当成工作日
--   → 那天上班按平日 150% 给（该给 300%）→ 少付，且没有任何报错。
--
-- "能维护"与"知道该维护什么"是两件事。这一版补的是后者：
--
--   ① **看得见缺口**：某年一条数据都没有、法定天数不对、有放假没调休上班、
--      调休上班填在了工作日、还有一批"待确认" —— 五种情况各给一条提示；
--   ② **待确认是个状态**：批量导入与骨架生成的行先标 `is_confirmed=false`，
--      提示"这几条还没对着公告核过"。人填的（单条新增/批量粘贴）直接算确认。
--   ③ **骨架只给能确定的部分**：元旦、劳动节、国庆是公历固定，春节/端午/中秋
--      是农历 —— 系统**不猜农历**（125 已经立过这条规矩，这里不改）。
--
-- ★ 为什么不做"从上年整年复制"：
--   2026 的 2/15 是春节，2027 的春节在 2 月上旬，星期也全变了。
--   复制过来会生成一整套**看起来正常、实际全错**的数据 ——
--   比空着更危险：空着会被缺口检查抓到，错了不会。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 确认状态
-- ---------------------------------------------------------------------------
ALTER TABLE legal_holiday ADD COLUMN IF NOT EXISTS is_confirmed boolean NOT NULL DEFAULT true;
ALTER TABLE legal_holiday ADD COLUMN IF NOT EXISTS source varchar(16) NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN legal_holiday.is_confirmed IS
  '是否已对国务院公告核对过。批量导入/骨架生成先标 false，人改过即 true（130）。';
COMMENT ON COLUMN legal_holiday.source IS
  'manual 手工录入 / import 批量导入 / skeleton 骨架生成（130）。';

-- 制度项：一年法定节假日应该是几天
-- 2025 年修订后全国是 13 天（春节 4、劳动 2），2024 年及以前是 11 天。
-- 默认 11 = 上线前的口径（126 的断言按 11 天写的），客户按当地/当年改。
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('PAY_LEGAL_DAYS_YEAR', '一年法定节假日天数', 'PAYROLL', 'numeric', false, 'group', '天')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
VALUES ('PAY_LEGAL_DAYS_YEAR', '2026-01-01', 11, 'group_hr',
        '默认 11 天 = 上线前口径；2025 年修订后全国为 13 天，客户按当年公告改')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- 页面要看得见"哪几条还没核过"，所以把 is_confirmed / source 一起带出去。
-- ★ 返回类型变了必须 DROP（42P13：cannot change return type of existing function）。
DROP FUNCTION IF EXISTS fn_holiday_year(int);
CREATE FUNCTION fn_holiday_year(p_year int)
RETURNS TABLE (holiday_date date, name varchar, holiday_type varchar, note varchar,
               is_legal boolean, dow int, is_confirmed boolean, source varchar)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT h.holiday_date, h.name::varchar, h.holiday_type, h.note::varchar,
         h.holiday_type = 'legal',
         extract(isodow FROM h.holiday_date)::int,
         h.is_confirmed, h.source
    FROM public.legal_holiday h
   WHERE extract(year FROM h.holiday_date) = p_year
   ORDER BY h.holiday_date;
$$;

COMMENT ON FUNCTION fn_holiday_year IS
  '某一年的节假日安排（含类型、是否已确认、来源）。界面据此渲染日历与"待确认"标记。';

-- ---------------------------------------------------------------------------
-- 2. 缺口检查：五种情况各一条
-- ---------------------------------------------------------------------------
-- ★ 改过返回类型时必须先 DROP：CREATE OR REPLACE 换不掉返回类型（42P13）。
DROP FUNCTION IF EXISTS fn_holiday_year_check(int);
CREATE FUNCTION fn_holiday_year_check(p_year int)
-- hint 用 text 而不是 varchar：format() 返回 text，varchar 不会自动匹配，
-- 报的是 "structure of query does not match function result type" —— 读起来像列数不对。
RETURNS TABLE(level varchar, code varchar, hint text)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_legal   int;
  v_rest    int;
  v_workday int;
  v_unconf  int;
  v_expected numeric;
BEGIN
  SELECT count(*) FILTER (WHERE h.holiday_type = 'legal'),
         count(*) FILTER (WHERE h.holiday_type = 'rest'),
         count(*) FILTER (WHERE h.holiday_type = 'workday'),
         count(*) FILTER (WHERE NOT h.is_confirmed)
    INTO v_legal, v_rest, v_workday, v_unconf
    FROM public.legal_holiday h
   WHERE EXTRACT(year FROM h.holiday_date) = p_year;

  SELECT COALESCE(value_num, 11) INTO v_expected
    FROM public.fn_policy_effective('PAY_LEGAL_DAYS_YEAR', NULL,
         make_date(p_year, 12, 31));

  -- ① 整年没数据：这是最严重的一条 —— 应出勤会把法定假算成工作日
  IF COALESCE(v_legal, 0) + COALESCE(v_rest, 0) + COALESCE(v_workday, 0) = 0 THEN
    RETURN QUERY SELECT 'error'::varchar, 'HOL_NO_DATA'::varchar,
      format('%s 年一条节假日数据都没有：应出勤会按纯周末算，元旦/国庆上班按平日 150%% 给（该给 300%%）', p_year);
    RETURN;
  END IF;

  -- ② 法定天数与制度值不符
  IF v_legal <> v_expected THEN
    RETURN QUERY SELECT 'warn'::varchar, 'HOL_LEGAL_COUNT'::varchar,
      format('%s 年法定节假日 %s 天，制度值是 %s 天（差 %s 天）—— 要么漏录，要么制度项没跟着改',
             p_year, v_legal, v_expected, v_legal - v_expected);
  END IF;

  -- ③ 有调休放假却没有调休上班：长假几乎一定要挪周末
  IF COALESCE(v_rest, 0) > 0 AND COALESCE(v_workday, 0) = 0 THEN
    RETURN QUERY SELECT 'warn'::varchar, 'HOL_NO_MAKEUP'::varchar,
      format('%s 年有 %s 天调休放假，但没有任何"调休上班" —— 那些天不是白给的，通常要挪一个周末', p_year, v_rest);
  END IF;

  -- ④ 调休上班落在工作日：那天本来就是工作日，再标一次会让应出勤多加一天
  RETURN QUERY
    SELECT 'warn'::varchar, 'HOL_MAKEUP_WEEKDAY'::varchar,
           format('%s 的「%s」标成调休上班，但那天是工作日（周%s）—— 应出勤会多加一天',
                  h.holiday_date, h.name, to_char(h.holiday_date, 'ID'))
      FROM public.legal_holiday h
     WHERE EXTRACT(year FROM h.holiday_date) = p_year
       AND h.holiday_type = 'workday'
       AND EXTRACT(isodow FROM h.holiday_date) BETWEEN 1 AND 5;

  -- ⑤ 还有未确认的
  IF v_unconf > 0 THEN
    RETURN QUERY SELECT 'warn'::varchar, 'HOL_UNCONFIRMED'::varchar,
      format('%s 年有 %s 条标记为"待确认"（导入或骨架生成）—— 对着国务院公告核一遍再确认', p_year, v_unconf);
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_holiday_year_check IS
  '某年节假日数据的缺口检查：无数据 / 法定天数不符 / 有放假无调休上班 / 调休上班落在工作日 / 待确认。'
  '只报不拦 —— 数据不全时算薪仍要继续，但要让维护的人看见"这里有一条缝"。';

-- 全年一眼看：哪几年完全没数据（工作台与页面顶部用它）
CREATE OR REPLACE FUNCTION fn_holiday_coverage(p_from_year int, p_years int DEFAULT 2)
RETURNS TABLE(year int, legal_days int, rest_days int, workday_days int,
              unconfirmed int, state varchar)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT y::int AS year,
         COALESCE(count(h.holiday_date) FILTER (WHERE h.holiday_type = 'legal'), 0)::int,
         COALESCE(count(h.holiday_date) FILTER (WHERE h.holiday_type = 'rest'), 0)::int,
         COALESCE(count(h.holiday_date) FILTER (WHERE h.holiday_type = 'workday'), 0)::int,
         COALESCE(count(h.holiday_date) FILTER (WHERE NOT h.is_confirmed), 0)::int,
         CASE WHEN count(h.holiday_date) = 0 THEN 'missing'
              WHEN count(h.holiday_date) FILTER (WHERE h.holiday_type = 'legal') = 0 THEN 'missing'
              WHEN count(h.holiday_date) FILTER (WHERE NOT h.is_confirmed) > 0 THEN 'unconfirmed'
              ELSE 'ok' END
    FROM generate_series(p_from_year, p_from_year + p_years - 1) AS y
    LEFT JOIN public.legal_holiday h ON EXTRACT(year FROM h.holiday_date) = y
   GROUP BY y
   ORDER BY y;
$$;

-- ---------------------------------------------------------------------------
-- 3. 骨架：只生成公历能确定的那几天
-- ---------------------------------------------------------------------------
-- ★ 只给 元旦 / 劳动节 / 国庆，并且整批标 is_confirmed = false。
--   春节、端午、中秋不生成 —— 它们是农历，猜错一天，全公司那一天的钱都错。
CREATE OR REPLACE FUNCTION fn_holiday_skeleton(p_year int, p_by varchar DEFAULT 'system')
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_n int := 0;
  v_row record;
BEGIN
  IF p_year < 2000 OR p_year > 2100 THEN
    RAISE EXCEPTION 'E_HOL_YEAR: 年份 % 不合理（2000–2100）', p_year;
  END IF;

  FOR v_row IN SELECT * FROM (VALUES
      (make_date(p_year, 1, 1),  '元旦',   'legal'),
      (make_date(p_year, 5, 1),  '劳动节', 'legal'),
      (make_date(p_year, 10, 1), '国庆节', 'legal'),
      (make_date(p_year, 10, 2), '国庆节', 'legal'),
      (make_date(p_year, 10, 3), '国庆节', 'legal')
    ) AS t(d, nm, ty)
  LOOP
    -- 已存在的不动（可能是人已经填对了）；只补缺的
    IF NOT EXISTS (SELECT 1 FROM public.legal_holiday h WHERE h.holiday_date = v_row.d) THEN
      INSERT INTO public.legal_holiday(holiday_date, name, is_workday, holiday_type,
                                       is_confirmed, source, note)
      VALUES (v_row.d, v_row.nm, false, v_row.ty, false, 'skeleton',
              '骨架生成：公历固定，仍需按当年公告核对调休');
      v_n := v_n + 1;
    END IF;
  END LOOP;

  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_holiday_skeleton IS
  '生成某年"公历可确定"的法定假日骨架（元旦/劳动节/国庆 3 天），全部标 is_confirmed=false。'
  '春节/端午/中秋按农历，不猜 —— 猜错一天，全公司那一天的钱都错。';

-- 确认：人对着公告核过之后把它标记成已确认
CREATE OR REPLACE FUNCTION fn_holiday_confirm(p_year int, p_by varchar DEFAULT 'system')
RETURNS int
LANGUAGE sql
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.legal_holiday
       SET is_confirmed = true
     WHERE EXTRACT(year FROM holiday_date) = p_year AND NOT is_confirmed
    RETURNING 1
  ) SELECT count(*)::int FROM u;
$$;

COMMENT ON FUNCTION fn_holiday_confirm IS
  '把某年所有"待确认"的节假日标为已确认。确认是人的动作：对着国务院公告核过之后才点。';

-- ---------------------------------------------------------------------------
-- 4. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.HOLY','节假日年度维护：缺口检查真的报出来、骨架只给公历、确认是个状态',
   'PAYROLL','ACL','fn_holiday_year_check','public','legal_holiday','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-HOLY','节假日缺口接进接口：页面数据里带 gaps 与 coverage',
   'PAYROLL','ACL','fn_holiday_coverage','public','legal_holiday','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
