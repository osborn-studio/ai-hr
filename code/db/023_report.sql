-- ============================================================================
-- 023_report.sql · 报表层：指标定义唯一、口径必须显式、三路径交叉核对
-- ----------------------------------------------------------------------------
-- 报表层最典型的失败形态不是"算错"，是**同一个指标有三份实现**：
-- 集团看板写一遍、门店日报写一遍、导出再写一遍。三份都"看起来对"，
-- 而它们之间的差没有人核对过——直到某天董事长问"为什么这两个数不一样"，
-- 那时才发现三份里有两份是旧口径，而没有任何一处在报错。
--
-- 所以这一层的三条纪律：
--
-- ① **一个指标只有一份实现**（一个函数）。报表引用它，不重写它。
-- ② **口径必须显式**：比率类指标必须给分母；时点类指标必须给基准
--    （期初 / 期末 / 期内日均——三个都是合法答案，混用就是错的）。
-- ③ **交叉核对**：同一个总量，用三条互不相同的路径算，必须相等。
--    这条是唯一能发现"三份实现已经分叉"的机制。
--
-- 一条现实约束：报表永远比业务表晚。所以每个报表函数都必须接受 as_of，
-- 不接受的话，"上个月的报表"永远复现不出来。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 指标定义：口径三要素（分子 / 分母 / 时点基准）
-- ---------------------------------------------------------------------------
CREATE TABLE report_metric (
  code        varchar(32) PRIMARY KEY,
  name        varchar(96) NOT NULL,
  unit        varchar(16) NOT NULL,
  -- 分子：这个数在数什么。一句话，写给业务看，不写给机器看。
  numerator   varchar(200) NOT NULL,
  -- 分母：比率类必须写；非比率类写 '—' 也要写，因为"空着"和"不需要"同形
  denominator varchar(200) NOT NULL,
  -- 时点基准：期初 / 期末 / 日均 / 不适用
  basis       varchar(24) NOT NULL,
  owner       varchar(64) NOT NULL,
  CONSTRAINT ck_rm_basis CHECK (basis IN ('begin','end','avg_daily','na')),
  CONSTRAINT ck_rm_num   CHECK (length(btrim(numerator)) >= 4),
  CONSTRAINT ck_rm_den   CHECK (length(btrim(denominator)) >= 1)
);

INSERT INTO report_metric(code,name,unit,numerator,denominator,basis,owner) VALUES
  ('HC_END','期末在编人数','人','期末最后一天仍有 cost_org 归属的自然人','—','end','hr'),
  ('HC_AVG','期内日均在编人数','人','期内每日在编人数之和','期内天数','avg_daily','hr'),
  ('HC_QUOTA','编制额度','个','本期生效的编制额度（最大版本）','—','end','hr'),
  ('HC_HIREABLE','可招人数','人','额度 − 已下分 − 已占编','—','end','hr'),
  ('WORK_HOURS','计薪工时','小时','考勤人日上的 work_hours 合计','—','na','attendance'),
  ('PAYROLL_GROSS','应发合计','元','工资条的 gross_amount 合计','—','na','payroll'),
  ('PAYROLL_NET','实发合计','元','工资条的 net_amount 合计','—','na','payroll');

COMMENT ON TABLE report_metric IS
  '指标定义。分母列即使是"不适用"也要写 "—"：空着与不需要在表上同形，'
  '而前者会被读成"这个指标没有分母"，后者是"我还没想清楚"。';

-- ---------------------------------------------------------------------------
-- 指标 ①：在编人数（基准必须显式，没有默认值）
-- ---------------------------------------------------------------------------
-- ★ 这里**故意不给 p_basis 默认值**。给了默认值，调用方就会忘记自己选了哪个，
--   而"期初/期末/日均"三个数在有人进出的月份能差出一二十个百分点。
--   报表上只写一个数而不写基准，等于把一个选择题藏进了一个数字里。
CREATE OR REPLACE FUNCTION fn_rpt_headcount(p_org bigint, p_period varchar, p_basis varchar)
RETURNS numeric
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  d_from date; d_to date; v numeric;
BEGIN
  -- ★ 必须写成 `p_basis IS NULL OR p_basis NOT IN (...)`。
  --   只写 NOT IN 时，传 NULL 会得到 NULL 而不是 true ——
  --   IF NULL 不进入分支，于是**守卫自己被 NULL 绕过去了**，
  --   而它接下来的 ELSE 分支会静默按"日均"算。
  --   这一条是本模块第一次跑就抓到的：断言说"不声明基准要报错"，
  --   实际传 NULL 时返回了一个数。
  IF p_basis IS NULL OR p_basis NOT IN ('begin','end','avg_daily') THEN
    RAISE EXCEPTION 'E_RPT_BASIS_REQUIRED: 人数必须声明基准（begin/end/avg_daily），收到 %',
      COALESCE(p_basis, 'NULL');
  END IF;

  d_from := (p_period || '-01')::date;
  d_to   := (d_from + interval '1 month - 1 day')::date;

  IF p_basis = 'begin' THEN
    SELECT count(DISTINCT a.employee_id) INTO v
      FROM public.employee_org_assignment a
      JOIN public.org_unit o ON o.id = a.org_id
     WHERE a.dim_code='cost_org'
       AND daterange(a.valid_from, a.valid_to, '[]') @> d_from
       AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org);
  ELSIF p_basis = 'end' THEN
    SELECT count(DISTINCT a.employee_id) INTO v
      FROM public.employee_org_assignment a
      JOIN public.org_unit o ON o.id = a.org_id
     WHERE a.dim_code='cost_org'
       AND daterange(a.valid_from, a.valid_to, '[]') @> d_to
       AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org);
  ELSE
    -- 日均：逐日数一遍再平均。贵，但"日均"这三个字只有这一种算法。
    -- 用 (期初+期末)/2 那种近似在这里是错的：月中入职一整天的人，
    -- 两种算法差半个月，而报表上看不出用的是哪种。
    SELECT avg(cnt) INTO v FROM (
      SELECT d::date AS day,
             (SELECT count(DISTINCT a.employee_id)
                FROM public.employee_org_assignment a
                JOIN public.org_unit o ON o.id = a.org_id
               WHERE a.dim_code='cost_org'
                 AND daterange(a.valid_from, a.valid_to, '[]') @> d::date
                 AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org)) AS cnt
        FROM generate_series(d_from, d_to, interval '1 day') d
    ) s;
  END IF;

  RETURN round(COALESCE(v, 0), 2);
END;
$$;

COMMENT ON FUNCTION fn_rpt_headcount IS
  '人数必须声明基准。三个基准都是合法答案，混用才是错的——'
  '而报表只写"在编 120 人"时，读者无法知道那是期初、期末还是日均。';

-- ---------------------------------------------------------------------------
-- 指标 ②：工时（唯一实现，报表只引用不重写）
-- ---------------------------------------------------------------------------
-- ★ 内层按日期区间，外层按自然月——两者共用同一个实现。
--   门店日报要"某一天"，集团看板要"某个月"，如果各写一遍，
--   就会出现"日报加起来不等于月报"这类问题，而两处都自洽。
CREATE OR REPLACE FUNCTION fn_rpt_hours_between(p_org bigint, p_from date, p_to date)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT round(COALESCE(sum(a.work_hours), 0), 2)
    FROM public.attendance_daily_store a
    JOIN public.org_unit o ON o.id = a.store_id
   WHERE a.work_date BETWEEN p_from AND p_to
     AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org);
$$;

CREATE OR REPLACE FUNCTION fn_rpt_hours(p_org bigint, p_period varchar)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT public.fn_rpt_hours_between(
           p_org,
           (p_period || '-01')::date,
           ((p_period || '-01')::date + interval '1 month - 1 day')::date);
$$;

-- ---------------------------------------------------------------------------
-- 指标 ③：应发合计（按人归属的组织汇总，不按发薪法人）
-- ---------------------------------------------------------------------------
-- ★ 这里有个口径决定，必须写出来：工资条按「人归属的成本组织」汇总，
--   而不是按「发薪法人」。两者在跨法人借调时会给出不同的数，
--   而"人力成本落在哪个组织"与"钱从哪个法人出"本来就是两个问题。
CREATE OR REPLACE FUNCTION fn_rpt_payroll(p_org bigint, p_period varchar, p_field varchar)
RETURNS numeric
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v numeric;
BEGIN
  IF p_field NOT IN ('gross_amount','net_amount') THEN
    RAISE EXCEPTION 'E_RPT_FIELD: 未知金额字段 %', p_field;
  END IF;

  -- ★ 这里本来用 format() 拼 %I。写的时候报了
  --   "unrecognized format() type specifier "'" —— 因为模板里的
  --   `LIKE (SELECT path || '%')` 里的那个 % 被 format 当成了格式符，
  --   而报错信息指向 format，问题却在 LIKE。
  --   取值域只有两个，用 CASE 就够：动态 SQL 会把注入面与转义问题一起引进来，
  --   而这里两样都不需要。
  SELECT round(COALESCE(sum(
           CASE WHEN p_field = 'gross_amount' THEN p.gross_amount ELSE p.net_amount END
         ), 0), 2) INTO v
    FROM public.payslip p
    JOIN public.pay_run r ON r.id = p.pay_run_id
   WHERE r.period = p_period
     AND EXISTS (
       SELECT 1 FROM public.employee_org_assignment a
         JOIN public.org_unit o ON o.id = a.org_id
        WHERE a.employee_id = p.employee_id
          AND a.dim_code = 'cost_org'
          AND daterange(a.valid_from, a.valid_to, '[]') @>
              (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
          AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org));

  RETURN COALESCE(v, 0);
END;
$$;

COMMENT ON FUNCTION fn_rpt_payroll IS
  '按「人归属的成本组织」汇总，不按「发薪法人」。两者在跨法人借调时会给出不同的数，'
  '而"人力成本落在哪个组织"与"钱从哪个法人出"本来就是两个问题。';

-- ---------------------------------------------------------------------------
-- 三路径交叉核对
-- ---------------------------------------------------------------------------
-- 同一个总量，三条**互不相同**的算法：
--   A 从根组织一次算（子树前缀匹配）
--   B 把每个叶子组织各算一次再相加（分组合计）
--   C 完全不过组织，直接从明细行加（明细求和）
-- 三者必须相等。差一条，说明某条路径上有过滤条件漏了——
-- 而那种漏在单条路径上看不出来，它只表现为"两个报表对不上"。
CREATE OR REPLACE FUNCTION fn_rpt_crosscheck(p_period varchar)
RETURNS TABLE (metric varchar(32), path_a numeric, path_b numeric, path_c numeric, ok boolean)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH leaves AS (
    SELECT o.id FROM public.org_unit o
     WHERE o.is_active AND NOT EXISTS (SELECT 1 FROM public.org_unit c WHERE c.parent_id = o.id)
  ), roots AS (
    SELECT o.id FROM public.org_unit o
     WHERE o.is_active AND o.parent_id IS NULL
  )
  SELECT 'WORK_HOURS',
         (SELECT COALESCE(sum(public.fn_rpt_hours(r.id, p_period)), 0) FROM roots r),
         (SELECT COALESCE(sum(public.fn_rpt_hours(l.id, p_period)), 0) FROM leaves l),
         (SELECT round(COALESCE(sum(a.work_hours), 0), 2) FROM public.attendance_daily_store a
           WHERE to_char(a.work_date, 'YYYY-MM') = p_period),
         (SELECT COALESCE(sum(public.fn_rpt_hours(r.id, p_period)), 0) FROM roots r)
       = (SELECT COALESCE(sum(public.fn_rpt_hours(l.id, p_period)), 0) FROM leaves l)
       AND (SELECT COALESCE(sum(public.fn_rpt_hours(l.id, p_period)), 0) FROM leaves l)
       = (SELECT round(COALESCE(sum(a.work_hours), 0), 2) FROM public.attendance_daily_store a
           WHERE to_char(a.work_date, 'YYYY-MM') = p_period)
  UNION ALL
  SELECT 'HC_END',
         (SELECT COALESCE(sum(public.fn_rpt_headcount(r.id, p_period, 'end')), 0) FROM roots r),
         (SELECT COALESCE(sum(public.fn_rpt_headcount(l.id, p_period, 'end')), 0) FROM leaves l),
         (SELECT count(DISTINCT employee_id)::numeric FROM public.employee_org_assignment
           WHERE dim_code = 'cost_org'
             AND daterange(valid_from, valid_to, '[]') @>
                 (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date),
         (SELECT COALESCE(sum(public.fn_rpt_headcount(r.id, p_period, 'end')), 0) FROM roots r)
       = (SELECT COALESCE(sum(public.fn_rpt_headcount(l.id, p_period, 'end')), 0) FROM leaves l)
       AND (SELECT COALESCE(sum(public.fn_rpt_headcount(l.id, p_period, 'end')), 0) FROM leaves l)
       = (SELECT count(DISTINCT employee_id)::numeric FROM public.employee_org_assignment
           WHERE dim_code = 'cost_org'
             AND daterange(valid_from, valid_to, '[]') @>
                 (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date);
$$;

COMMENT ON FUNCTION fn_rpt_crosscheck IS
  '三条路径必须同值。A=子树一次算，B=叶子分别算再相加，C=不过组织的明细求和。'
  'B 与 C 相等这一条尤其重要：它证明"按组织分组"没有漏行、也没有重复计数。';

-- ---------------------------------------------------------------------------
-- 面板：一个组织、一个期间，把所有指标一次取齐
-- ---------------------------------------------------------------------------
-- ★ 面板里每一行的 metric 都必须在 report_metric 里登记过。
--   没登记的指标等于"没人写过它的口径"，它会以同样的字体出现在报表上，
--   而读者无从判断它是否与别处一致。
CREATE OR REPLACE FUNCTION fn_rpt_panel(p_org bigint, p_period varchar)
RETURNS TABLE (metric varchar(32), name varchar(96), unit varchar(16),
               value numeric, basis varchar(24), registered boolean)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH v AS (
    SELECT 'HC_END'::varchar(32) AS code, public.fn_rpt_headcount(p_org, p_period, 'end') AS val
    UNION ALL SELECT 'HC_AVG',    public.fn_rpt_headcount(p_org, p_period, 'avg_daily')
    UNION ALL SELECT 'HC_QUOTA',  COALESCE(public.fn_hc_quota(p_org, p_period), 0)::numeric
    UNION ALL SELECT 'HC_HIREABLE', public.fn_hc_hireable(p_org, p_period)::numeric
    UNION ALL SELECT 'WORK_HOURS', public.fn_rpt_hours(p_org, p_period)
    UNION ALL SELECT 'PAYROLL_GROSS', public.fn_rpt_payroll(p_org, p_period, 'gross_amount')
    UNION ALL SELECT 'PAYROLL_NET',   public.fn_rpt_payroll(p_org, p_period, 'net_amount')
  )
  SELECT v.code, COALESCE(m.name, '(未登记)'), COALESCE(m.unit, '—'), v.val,
         COALESCE(m.basis, '—'), (m.code IS NOT NULL)
    FROM v LEFT JOIN public.report_metric m ON m.code = v.code
   ORDER BY v.code;
$$;

-- 未登记指标清单：必须为空
CREATE OR REPLACE FUNCTION fn_rpt_unregistered(p_period varchar)
RETURNS TABLE (metric varchar(32))
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT p.metric FROM public.fn_rpt_panel(1, p_period) p WHERE NOT p.registered;
$$;
