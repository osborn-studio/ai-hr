-- ============================================================================
-- 125_holiday_type.sql · 区分"法定节假日"与"调休放假"（300% vs 200%）
-- ----------------------------------------------------------------------------
-- 111 建 legal_holiday 时只有一个 is_workday 布尔，把两件不同的事混成一件：
--
--   ① **法定节假日**（11 天：元旦 1、春节 3、清明 1、劳动 1、端午 1、中秋 1、国庆 3）
--      —— 带薪，上班按 300%；
--   ② **调休放假**（为了凑长假，把周末或工作日调过来休）
--      —— 是"休息日"，上班按 200%。
--
-- 混在一起的后果：国庆 7 天假里，只有 10/1–10/3 是 300%，
-- 10/4–10/7 是 200%。全按 300% 算会多付近一倍，全按 200% 算是少付（违法）。
--
-- 所以加一列 holiday_type：
--   legal    法定节假日（带薪，加班 300%）
--   rest     调休放假（休息日，加班 200%）
--   workday  调休上班（周末要来上班，正常工作日）
--
-- 数据来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（2025-11-04）
--   元旦  1/1(四)–1/3(六) 放假；1/4(日) 上班
--   春节  2/15(日)–2/23(一) 放假；2/14(六)、2/28(六) 上班
--   清明  4/4(六)–4/6(一) 放假
--   劳动  5/1(五)–5/5(二) 放假；5/9(六) 上班
--   端午  6/19(五)–6/21(日) 放假
--   中秋  9/25(五)–9/27(日) 放假
--   国庆  10/1(四)–10/7(三) 放假；9/20(日)、10/10(六) 上班
--
-- ★ 这份安排每年 11 月才公布，写死在迁移里只覆盖 2026。
--   所以同时给一个维护入口（接口 + 页面），客户自己灌下一年 ——
--   系统不该因为"新的一年没有假期数据"就把应出勤算错，但它也没法替你猜政策。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 加类型列
-- ---------------------------------------------------------------------------
ALTER TABLE legal_holiday ADD COLUMN IF NOT EXISTS holiday_type varchar(12);

UPDATE legal_holiday SET holiday_type = CASE WHEN is_workday THEN 'workday' ELSE 'legal' END
 WHERE holiday_type IS NULL;

ALTER TABLE legal_holiday ALTER COLUMN holiday_type SET NOT NULL;
ALTER TABLE legal_holiday ALTER COLUMN holiday_type SET DEFAULT 'legal';

ALTER TABLE legal_holiday DROP CONSTRAINT IF EXISTS ck_lh_type;
ALTER TABLE legal_holiday ADD CONSTRAINT ck_lh_type
  CHECK (holiday_type IN ('legal','rest','workday'));

COMMENT ON COLUMN legal_holiday.holiday_type IS
  'legal=法定节假日（带薪，加班 300%）/ rest=调休放假（休息日，200%）'
  '/ workday=调休上班（周末上班，正常工作日）。'
  '★ 把 rest 和 legal 混成一个是错的：国庆 7 天里只有 10/1–10/3 是 300%。';

-- ---------------------------------------------------------------------------
-- 2. 按官方通知重灌 2026（覆盖旧的粗糙数据）
-- ---------------------------------------------------------------------------
DELETE FROM legal_holiday WHERE holiday_date BETWEEN '2026-01-01' AND '2026-12-31';

INSERT INTO legal_holiday(holiday_date, name, is_workday, holiday_type, note) VALUES
  -- 元旦：1/1 法定；1/2–1/3 调休放假；1/4 周日上班
  ('2026-01-01','元旦',            false, 'legal',   '法定节假日（1 天）'),
  ('2026-01-02','元旦调休',        false, 'rest',    '调休放假'),
  ('2026-01-03','元旦调休',        false, 'rest',    '周末'),
  ('2026-01-04','元旦调休上班',    true,  'workday', '周日上班'),

  -- 春节：2/17–2/19 法定（正月初一至初三）；其余调休/周末；2/14、2/28 上班
  ('2026-02-14','春节调休上班',    true,  'workday', '周六上班'),
  ('2026-02-15','春节假期',        false, 'rest',    '腊月廿八'),
  ('2026-02-16','春节假期',        false, 'rest',    '腊月廿九'),
  ('2026-02-17','春节（正月初一）', false, 'legal',   '法定节假日（3 天之一）'),
  ('2026-02-18','春节（正月初二）', false, 'legal',   '法定节假日（3 天之一）'),
  ('2026-02-19','春节（正月初三）', false, 'legal',   '法定节假日（3 天之一）'),
  ('2026-02-20','春节假期',        false, 'rest',    '调休'),
  ('2026-02-21','春节假期',        false, 'rest',    '周末'),
  ('2026-02-22','春节假期',        false, 'rest',    '周末'),
  ('2026-02-23','春节假期',        false, 'rest',    '调休'),
  ('2026-02-28','春节调休上班',    true,  'workday', '周六上班'),

  -- 清明：4/5 法定（周日）；4/4 周六、4/6 周一调休
  ('2026-04-04','清明假期',        false, 'rest',    '周六'),
  ('2026-04-05','清明节',          false, 'legal',   '法定节假日（1 天）'),
  ('2026-04-06','清明调休',        false, 'rest',    '调休'),

  -- 劳动节：5/1 法定；5/2–5/5 调休/周末；5/9 周六上班
  ('2026-05-01','劳动节',          false, 'legal',   '法定节假日（1 天）'),
  ('2026-05-02','劳动节假期',      false, 'rest',    '周末'),
  ('2026-05-03','劳动节假期',      false, 'rest',    '周末'),
  ('2026-05-04','劳动节调休',      false, 'rest',    '调休'),
  ('2026-05-05','劳动节调休',      false, 'rest',    '调休'),
  ('2026-05-09','劳动节调休上班',  true,  'workday', '周六上班'),

  -- 端午：6/19 法定；6/20–6/21 周末
  ('2026-06-19','端午节',          false, 'legal',   '法定节假日（1 天）'),
  ('2026-06-20','端午假期',        false, 'rest',    '周末'),
  ('2026-06-21','端午假期',        false, 'rest',    '周末'),

  -- 中秋：9/25 法定；9/26–9/27 周末
  ('2026-09-25','中秋节',          false, 'legal',   '法定节假日（1 天）'),
  ('2026-09-26','中秋假期',        false, 'rest',    '周末'),
  ('2026-09-27','中秋假期',        false, 'rest',    '周末'),

  -- 国庆：10/1–10/3 法定；10/4–10/7 调休/周末；9/20、10/10 上班
  ('2026-09-20','国庆调休上班',    true,  'workday', '周日上班'),
  ('2026-10-01','国庆节',          false, 'legal',   '法定节假日（3 天之一）'),
  ('2026-10-02','国庆节',          false, 'legal',   '法定节假日（3 天之一）'),
  ('2026-10-03','国庆节',          false, 'legal',   '法定节假日（3 天之一）'),
  ('2026-10-04','国庆假期',        false, 'rest',    '周末'),
  ('2026-10-05','国庆假期',        false, 'rest',    '调休'),
  ('2026-10-06','国庆假期',        false, 'rest',    '调休'),
  ('2026-10-07','国庆假期',        false, 'rest',    '调休'),
  ('2026-10-10','国庆调休上班',    true,  'workday', '周六上班');

-- ---------------------------------------------------------------------------
-- 3. 三个判定函数改为按 holiday_type 判
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_is_legal_holiday(p_date date)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.legal_holiday h
                  WHERE h.holiday_date = p_date AND h.holiday_type = 'legal');
$$;

COMMENT ON FUNCTION fn_is_legal_holiday IS
  '这天是不是**法定节假日**（11 天，加班 300%）。调休放假（rest）不算 —— 那是 200%。';

CREATE OR REPLACE FUNCTION fn_calendar_workdays(p_from date, p_to date)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT count(*)::numeric
    FROM generate_series(p_from, p_to, interval '1 day') AS g
    LEFT JOIN public.legal_holiday h ON h.holiday_date = g::date
   WHERE CASE
           WHEN h.holiday_type = 'workday' THEN true                    -- 调休上班
           WHEN h.holiday_type IN ('legal','rest') THEN false           -- 法定假 / 调休放假
           ELSE extract(isodow FROM g) < 6                              -- 普通日：周一~周五
         END;
$$;

COMMENT ON FUNCTION fn_calendar_workdays IS
  '区间内的应出勤天数：周一~周五，扣法定假与调休放假，加调休上班。'
  '2026 年参考：1 月 20 天（元旦 3 天假 + 1/4 上班）、2 月 16 天（春节 9 天假 + 两个周六上班）、'
  '10 月 21 天（国庆 7 天假 + 9/20 与 10/10 上班）。';

CREATE OR REPLACE FUNCTION fn_is_rest_day(p_date date, p_person bigint)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT CASE
    -- ① 调休上班：周末也要上班，不是休息日
    WHEN EXISTS (SELECT 1 FROM public.legal_holiday h
                  WHERE h.holiday_date = p_date AND h.holiday_type = 'workday') THEN false
    -- ② 法定节假日：上班是 300%，不能当"休息日 200%"处理
    WHEN EXISTS (SELECT 1 FROM public.legal_holiday h
                  WHERE h.holiday_date = p_date AND h.holiday_type = 'legal') THEN false
    -- ③ 调休放假：就是休息日（200%）
    WHEN EXISTS (SELECT 1 FROM public.legal_holiday h
                  WHERE h.holiday_date = p_date AND h.holiday_type = 'rest') THEN true
    -- ④ 排班说了算：有人排了休息班，这天就是他的休息日
    WHEN EXISTS (SELECT 1 FROM public.roster_slot rs
                   JOIN public.shift_def sd ON sd.code = rs.shift_code
                  WHERE rs.employee_id = p_person AND rs.work_date = p_date
                    AND sd.is_rest) THEN true
    -- ⑤ 没排班时按周末判
    ELSE extract(isodow FROM p_date) >= 6
  END;
$$;

COMMENT ON FUNCTION fn_is_rest_day IS
  '这天对某人是不是休息日：调休上班→否；法定节假日→否（那是 300%，不是 200%）；'
  '调休放假→是；排了休息班→是；否则看周末。排班优先于周末。';

-- ---------------------------------------------------------------------------
-- 4. 维护入口：按年查/改/删
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_holiday_upsert(
  p_date date, p_name varchar, p_type varchar, p_note varchar DEFAULT NULL)
RETURNS date
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_type NOT IN ('legal','rest','workday') THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 类型只能是 legal / rest / workday';
  END IF;
  IF length(btrim(COALESCE(p_name,''))) < 2 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 名称至少 2 个字（界面上要看得懂）';
  END IF;
  INSERT INTO public.legal_holiday(holiday_date, name, is_workday, holiday_type, note)
  VALUES (p_date, p_name, p_type = 'workday', p_type, p_note)
  ON CONFLICT (holiday_date) DO UPDATE
    SET name = EXCLUDED.name, is_workday = EXCLUDED.is_workday,
        holiday_type = EXCLUDED.holiday_type, note = EXCLUDED.note;
  RETURN p_date;
END;
$$;

COMMENT ON FUNCTION fn_holiday_upsert IS
  '新增/修改一天的节假日类型。is_workday 由 type 推出（workday=true），不单独传 —— '
  '两个字段表达同一件事，迟早会打架。';

CREATE OR REPLACE FUNCTION fn_holiday_year(p_year int)
RETURNS TABLE (holiday_date date, name varchar, holiday_type varchar, note varchar,
               is_legal boolean, dow int)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT h.holiday_date, h.name::varchar, h.holiday_type, h.note::varchar,
         h.holiday_type = 'legal',
         extract(isodow FROM h.holiday_date)::int
    FROM public.legal_holiday h
   WHERE extract(year FROM h.holiday_date) = p_year
   ORDER BY h.holiday_date;
$$;

COMMENT ON FUNCTION fn_holiday_year IS
  '某一年的节假日安排（含法定/调休放假/调休上班），界面据此渲染日历。';

-- ---------------------------------------------------------------------------
-- 5. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.HOL','节假日三型：法定 11 天/调休放假 200%/调休上班计入应出勤，应出勤随之变化',
   'ATTENDANCE','ALGORITHM','fn_calendar_workdays','public','legal_holiday','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
