-- ============================================================================
-- 012_si_tax.sql · 社保公积金 + 个人所得税（累计预扣）
-- ----------------------------------------------------------------------------
-- 两条容易做错的地方：
--   ① **社保基数要夹**：低于下限按下限，高于上限按上限。
--      不夹的话，低薪员工的社保算少、高薪的算多，两边都不合规。
--   ② **个税是累计预扣，不是当月单算。**
--      本月应预扣 = 按累计应纳税所得额查表得到的累计税额 − 已预扣。
--      按当月收入单算，月度看着对，全年总额对不上，而汇算清缴时才暴露。
--
-- 一条时间性安排：政策按 effective_from 版本化，**改政策不追溯历史**。
-- ============================================================================

CREATE TABLE si_policy (
  id            bigint PRIMARY KEY,
  city          varchar(32) NOT NULL,
  item          varchar(24) NOT NULL,        -- pension|medical|unemploy|injury|maternity|housing
  effective_from date NOT NULL,
  base_floor    numeric(12,2) NOT NULL,
  base_ceiling  numeric(12,2) NOT NULL,
  rate_employee numeric(6,4) NOT NULL,
  rate_employer numeric(6,4) NOT NULL,
  UNIQUE (city, item, effective_from),
  CONSTRAINT ck_sp_floor CHECK (base_floor > 0 AND base_ceiling >= base_floor),
  CONSTRAINT ck_sp_rate  CHECK (rate_employee BETWEEN 0 AND 1 AND rate_employer BETWEEN 0 AND 1)
);

-- ★ 基数夹逼：唯一正确的形态是一步算出来，不是"在调用处判断要不要夹"。
CREATE OR REPLACE FUNCTION fn_si_base(
  p_city varchar, p_item varchar, p_wage numeric, p_on date
) RETURNS numeric
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT LEAST(GREATEST(p_wage, p.base_floor), p.base_ceiling)
    FROM public.si_policy p
   WHERE p.city = p_city AND p.item = p_item AND p.effective_from <= p_on
   ORDER BY p.effective_from DESC
   LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- 个税税率表（综合所得，累计预扣）
-- ---------------------------------------------------------------------------
CREATE TABLE tax_bracket (
  level          int PRIMARY KEY,
  cum_start      numeric(14,2) NOT NULL,
  cum_end        numeric(14,2),             -- NULL = 无上限
  rate           numeric(6,4) NOT NULL,
  quick_deduct   numeric(14,2) NOT NULL,
  CONSTRAINT ck_tb_range CHECK (cum_end IS NULL OR cum_end > cum_start)
);

INSERT INTO tax_bracket(level,cum_start,cum_end,rate,quick_deduct) VALUES
  (1,0,36000,0.03,0),
  (2,36000,144000,0.10,2520),
  (3,144000,300000,0.20,16920),
  (4,300000,420000,0.25,31920),
  (5,420000,660000,0.30,52920),
  (6,660000,960000,0.35,85920),
  (7,960000,NULL,0.45,181920);

-- 按累计应纳税所得额算累计税额
CREATE OR REPLACE FUNCTION fn_iit_cumulative(p_cum_taxable numeric)
RETURNS numeric
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT GREATEST(round(p_cum_taxable * b.rate - b.quick_deduct, 2), 0)
    FROM public.tax_bracket b
   WHERE p_cum_taxable >= b.cum_start
     AND (b.cum_end IS NULL OR p_cum_taxable < b.cum_end)
   LIMIT 1;
$$;

-- ★ 本月应预扣 = 累计税额 − 已预扣。这是累计预扣法的全部内容。
CREATE OR REPLACE FUNCTION fn_iit_month(p_cum_taxable numeric, p_paid numeric)
RETURNS numeric
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT GREATEST(
    public.fn_iit_cumulative(p_cum_taxable) - COALESCE(p_paid, 0), 0);
$$;
