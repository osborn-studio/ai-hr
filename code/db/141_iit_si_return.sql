-- ============================================================================
-- 141_iit_si_return.sql · 申报表：每月要报出去的那两张表
-- ----------------------------------------------------------------------------
-- 到 140 为止，系统能算出每个人的个税与社保，**但报不出去**。
-- 财务每月要做的事是打开电子税务局，把一张《个人所得税扣缴申报表》和一张
-- 《社会保险费申报表》逐格填进去 —— 而格子里的数，得从工资条里一个一个抄。
-- 抄错了当月就得更正申报；抄慢了员工在个税 APP 里看到"未申报"就来问 HR。
--
-- ★ 所以这两张表不是"再加一个导出"，它们是**钱离开系统之后的下一步**。
--   而"离开系统"这件事有三个必须落在库里的理由：
--
--   ① **申报的数必须是已封账的数。** draft 批次的数明天还会变，报出去就要更正。
--      051 之后考勤封账已经卡在算薪前，这里再卡一次：没封账 → 拒绝出表。
--   ② **申报表不能自己另算一遍税。** 若申报表算 3200、工资条扣 3180，
--      员工会按低的那个记住。所以个税表**全部从 payslip 读**（gross / si / tax /
--      cum_taxable / special_deduction），只做汇总与口径展开，不做重新计算。
--   ③ **社保单位部分工资条里没有。** 工资条只扣个人，单位缴的那部分是
--      "公司成本"，没人看所以从来没存。但申报表要它，所以它必须算 ——
--      而算它就等于开了第二个口径。取舍见下面 ②。
--
-- ★ 三条设计取舍：
--
--   ② **单位部分重算，但必须与工资条个人部分对账。** 基数走同一个入口
--      （fn_si_base_eff，与算薪同一个函数），单位额 = 基数 × 单位费率；
--      同时把"按基数重算的个人额"与"工资条里真实扣的个人额"对比，
--      差 > 0.02 就在 remark 里点名。**不静默用其中一个** —— 两边不一致时，
--      申报表用哪个都是错的，正确答案是让人去核。
--
--   ③ **0 与空值必须分开。** 工伤、生育是单位缴、个人不缴，个人额是**真的 0**；
--      而"工资条里找不到这个险种的明细行"是**没登记**，输出 NULL。
--      两者在申报表里含义相反：0 会让人以为"这个人这个险种免缴"，
--      空会让人去查。CSV 里 NULL → 空单元格，0 → 0.00。
--
--   ④ **年终奖不进工资薪金申报表。** 108 之后年终奖是独立批次（kind='bonus'）、
--      单独计税（全年一次性奖金）。它要在"全年一次性奖金"那一栏单独申报，
--      并进综合所得就是多缴，漏报就是少缴。所以本表只取 kind='monthly'，
--      但会把"本期另有年终奖批次"写进表头 —— **不静默丢掉**。
--
-- ★ 两份"不做"：
--   · 不做各地电子税务局的导入模板（一省一样，做了也跟不上）；
--     出的是**标准对账表**，供人抄或转成当地模板。
--   · 不做"参保主体 ≠ 发薪法人"。库里的工资条只挂发薪法人，没有 si_entity
--     这一维；真做要把参保主体落到 employment 上，那是一次数据模型改动，
--     不做半个 —— 半个的结果是申报表按错的法人出，而表看起来是对的。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 险种三件套：工资项编码 / 中文名 / 排序
-- ---------------------------------------------------------------------------
-- 险种名在系统里有两套写法：si_policy.item 是英文键（pension / unemploy…），
-- payslip_item.item_code 是工资项（SI_PENSION…）。同一个东西两个名字，
-- 迟早会有一处写成三套。所以映射**只在这一个函数里写一次**，
-- 算薪、申报表、界面都调它。
CREATE OR REPLACE FUNCTION fn_si_item_code(p_item varchar)
RETURNS varchar
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p_item IN ('pension', 'endowment')      THEN 'SI_PENSION'
           WHEN p_item IN ('medical', 'medicare')       THEN 'SI_MEDICAL'
           WHEN p_item IN ('unemploy', 'unemployment')  THEN 'SI_UNEMPLOYMENT'
           WHEN p_item IN ('housing', 'housing_fund')   THEN 'SI_HOUSING_FUND'
         END::varchar;
$$;

COMMENT ON FUNCTION fn_si_item_code IS
  '险种英文键 → 工资项编码。工伤/生育没有工资项（个人不缴、工资条不出行），返回 NULL。'
  '映射只在这里写一次 —— 两套名字在多处各写一遍，必然有一处写错而两边都不报错。';

CREATE OR REPLACE FUNCTION fn_si_item_name(p_item varchar)
RETURNS varchar
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p_item IN ('pension', 'endowment')      THEN '基本养老保险'
           WHEN p_item IN ('medical', 'medicare')       THEN '基本医疗保险'
           WHEN p_item IN ('unemploy', 'unemployment')  THEN '失业保险'
           WHEN p_item = 'injury'                       THEN '工伤保险'
           WHEN p_item = 'maternity'                     THEN '生育保险'
           WHEN p_item IN ('housing', 'housing_fund')   THEN '住房公积金'
           ELSE p_item
         END::varchar;
$$;

CREATE OR REPLACE FUNCTION fn_si_item_seq(p_item varchar)
RETURNS smallint
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN p_item IN ('pension', 'endowment')      THEN 10
           WHEN p_item IN ('medical', 'medicare')       THEN 20
           WHEN p_item IN ('unemploy', 'unemployment')  THEN 30
           WHEN p_item = 'injury'                       THEN 40
           WHEN p_item = 'maternity'                     THEN 50
           WHEN p_item IN ('housing', 'housing_fund')   THEN 60
           ELSE 90
         END::smallint;
$$;

-- ---------------------------------------------------------------------------
-- 2. 选批次：申报只认已封账
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_declare_run(
  p_entity bigint, p_period varchar, p_kind varchar DEFAULT 'monthly'
) RETURNS bigint
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_run bigint;
  v_st  varchar(16);
BEGIN
  IF p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_DECLARE_PERIOD: 期间要写 2026-03 这样的（收到 %）', p_period;
  END IF;
  IF p_entity IS NULL OR p_entity <= 0 THEN
    RAISE EXCEPTION 'E_DECLARE_ENTITY: 法人必须给一个正整数（收到 %）', p_entity;
  END IF;

  SELECT r.id INTO v_run
    FROM public.pay_run r
   WHERE r.legal_entity_id = p_entity
     AND r.period = p_period
     AND r.kind = p_kind
     AND r.status IN ('sealed', 'paid')
   ORDER BY r.calc_version DESC, r.id DESC
   LIMIT 1;
  IF v_run IS NOT NULL THEN RETURN v_run; END IF;

  SELECT r.status INTO v_st
    FROM public.pay_run r
   WHERE r.legal_entity_id = p_entity
     AND r.period = p_period
     AND r.kind = p_kind
   ORDER BY r.calc_version DESC, r.id DESC
   LIMIT 1;

  IF v_st IS NULL THEN
    RAISE EXCEPTION 'E_DECLARE_NO_RUN: 法人 % 在 % 还没有 % 批次。'
      '申报表要用已算出来并封账的数 —— 先算薪、再封账。',
      p_entity, p_period, CASE p_kind WHEN 'bonus' THEN '年终奖' ELSE '工资' END;
  END IF;

  RAISE EXCEPTION 'E_DECLARE_NOT_SEALED: 法人 % 的 % % 批次还是 % 状态。'
    '未封账的数明天还会变，报出去就要更正申报 —— 所以这张表只从封账批次出。',
    p_entity, p_period, CASE p_kind WHEN 'bonus' THEN '年终奖' ELSE '工资' END, v_st;
END;
$$;

COMMENT ON FUNCTION fn_declare_run IS
  '取某法人某期（默认工资，kind=monthly）用于申报的批次：只认 sealed/paid，取最高 calc_version。'
  '没有批次与没封账分别报不同的错 —— 这两件事的处理方式完全不同（一个去算薪，一个去封账）。';

-- ---------------------------------------------------------------------------
-- 3. 个人所得税扣缴申报表（工资薪金所得，累计预扣口径）
-- ---------------------------------------------------------------------------
-- 列对应《个人所得税扣缴申报表》里工资薪金所得那一段。三处口径说在这里：
--
--   · **减除费用 = 5000 × 本年已申报月数**。月数取"本法人本年已封账的月份数"，
--     不是按 hire_date 数日历月 —— 两者在"月中入职""漏了一个月"时会分叉，
--     而申报表上的累计数必须与真报上去的那几个月的累计数一致。
--   · **累计已缴 = 本年此前各月已封账工资条的 tax_amount 之和（含本月）**。
--     系统里没有"已申报"这个状态（那是税务局那边的状态），所以用"已封账"
--     作为最接近的口径，并在表头写明。有未封账月份时，应补退税额会不为 0 ——
--     那正是"这个月要补申报"的信号，不压成 0。
--   · **免税收入与其他扣除一律 0**。本系统不登记这两项（生育津贴、商业健康险
--     之类），有这类情形的员工要在电子税务局里单独调整。写在表头，不逐行啰嗦。
CREATE OR REPLACE FUNCTION fn_declare_iit(p_entity bigint, p_period varchar)
RETURNS TABLE (
  employee_no        varchar(16),
  person_name        varchar(64),
  id_type            varchar(16),
  id_no              varchar(64),
  id_verified        boolean,
  income             numeric(12,2),     -- 本月收入额（= 工资条应发）
  exempt_income      numeric(12,2),     -- 本月免税收入（系统不登记，恒 0）
  deduct_std         numeric(12,2),     -- 本月减除费用（5000）
  deduct_special     numeric(12,2),     -- 本月专项扣除（三险一金个人部分）
  deduct_extra       numeric(12,2),     -- 本月专项附加扣除
  taxable_now        numeric(14,2),     -- 本月应纳税所得额
  cum_income         numeric(14,2),     -- 累计收入额
  cum_deduct_std     numeric(14,2),     -- 累计减除费用
  cum_deduct_special numeric(14,2),     -- 累计专项扣除
  cum_deduct_extra   numeric(14,2),     -- 累计专项附加扣除
  cum_taxable        numeric(14,2),     -- 累计应纳税所得额（工资条上存的那个）
  cum_tax            numeric(14,2),     -- 累计应纳税额（按年表算）
  cum_paid           numeric(14,2),     -- 累计已缴（含本月）
  tax_now            numeric(12,2),     -- 本月应扣缴税额
  should_pay         numeric(12,2),     -- 应补(退)税额（负数 = 多扣，汇算时退）
  months_counted     int,               -- 本年已申报月数（= 已封账月数）
  filed_months       varchar(200),      -- 已封账月份清单
  remark             varchar
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_run    bigint;
  v_pend   date;
  v_year   int;
  v_thr    numeric(12,2);
  v_months int;
  v_filed  varchar(200);
BEGIN
  v_run  := public.fn_declare_run(p_entity, p_period, 'monthly');
  v_pend := (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;
  v_year := left(p_period, 4)::int;

  SELECT t.threshold INTO v_thr FROM public.tax_param t WHERE t.year = v_year;
  v_thr := COALESCE(v_thr, 5000);

  SELECT count(DISTINCT r.period),
         string_agg(DISTINCT r.period, ',' ORDER BY r.period)
    INTO v_months, v_filed
    FROM public.pay_run r
   WHERE r.legal_entity_id = p_entity
     AND r.kind = 'monthly'
     AND r.status IN ('sealed', 'paid')
     AND left(r.period, 4) = v_year::text
     AND r.period <= p_period;

  RETURN QUERY
  WITH s AS (
    SELECT p.id, p.employee_id, p.gross_amount, p.si_employee, p.tax_amount,
           p.special_deduction, p.cum_taxable
      FROM public.payslip p
     WHERE p.pay_run_id = v_run
  ), cum AS (
    -- 本年累计：同法人、<= 本期、已封账的工资条。跨法人不算在一起 ——
    -- 累计预扣是按**扣缴义务人**累计的，两家公司各扣各的。
    SELECT x.employee_id,
           sum(x.gross_amount)      AS cum_income,
           sum(x.si_employee)       AS cum_si,
           sum(x.special_deduction) AS cum_add,
           sum(x.tax_amount)        AS cum_paid
      FROM public.payslip x
      JOIN public.pay_run r2 ON r2.id = x.pay_run_id
     WHERE r2.legal_entity_id = p_entity
       AND r2.kind = 'monthly'
       AND r2.status IN ('sealed', 'paid')
       AND left(r2.period, 4) = v_year::text
       AND r2.period <= p_period
     GROUP BY x.employee_id
  )
  SELECT
    (SELECT n.no FROM public.employee_no n
      WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
      ORDER BY n.assigned_at DESC LIMIT 1)::varchar(16),
    pe.full_name::varchar(64),
    '居民身份证'::varchar(16),
    idp.profile_value::varchar(64),
    (idp.verified_by IS NOT NULL),
    s.gross_amount,
    0::numeric(12,2),
    v_thr,
    s.si_employee,
    s.special_deduction,
    GREATEST(s.gross_amount - s.si_employee - v_thr - s.special_deduction, 0)::numeric(14,2),
    c.cum_income::numeric(14,2),
    (v_thr * v_months)::numeric(14,2),
    c.cum_si::numeric(14,2),
    c.cum_add::numeric(14,2),
    s.cum_taxable,
    public.fn_iit_cumulative(s.cum_taxable)::numeric(14,2),
    c.cum_paid::numeric(14,2),
    s.tax_amount,
    (public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid)::numeric(12,2),
    v_months,
    v_filed,
    nullif(concat_ws('；',
      CASE WHEN idp.profile_value IS NULL
           THEN '档案未登记身份证号，无法申报' END,
      CASE WHEN idp.profile_value IS NOT NULL AND idp.verified_by IS NULL
           THEN '身份证号未核实' END,
      -- 勾稽：累计应纳税所得额 应当 = 累计收入 − 累计社保 − 累计减除 − 累计附加。
      -- 差出来只有两种原因：某月应纳税所得额为负被截到 0；或者**算这一期的时候
      -- 上一期还没封账**（累计预扣读不到那一期，本月就按"只有这一个月"算了，
      -- 而封账之后改不了，累计会一直少一个月）。第二种更容易发生，所以要点名。
      CASE WHEN abs(s.cum_taxable
                    - (c.cum_income - c.cum_si - v_thr * v_months - c.cum_add)) > 0.02
           THEN '累计勾稽差 ' || round(s.cum_taxable
                    - (c.cum_income - c.cum_si - v_thr * v_months - c.cum_add), 2)::text
                || '（工资条上的累计数与"累计收入−累计各项扣除"对不上：'
                || '通常是算这一期时上一期还没封账，累计就少算了一个月 —— '
                || '也可能某月应纳税所得额为负被截到 0）' END,
      CASE WHEN public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid > 0.02
           THEN '本期应补缴 ' || round(public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid, 2)::text
                || '（本年有未封账月份，累计已缴少了）' END,
      CASE WHEN public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid < -0.02
           THEN '累计多扣 ' || round(c.cum_paid - public.fn_iit_cumulative(s.cum_taxable), 2)::text
                || '（预扣多于应扣，汇算清缴时退）' END
    ), '')::varchar
  FROM s
  JOIN public.person pe ON pe.id = s.employee_id
  JOIN cum c ON c.employee_id = s.employee_id
  LEFT JOIN LATERAL (
    -- 未核实的号也可能有多条（003 允许），取已核实的那条优先
    SELECT pp.profile_value, pp.verified_by
      FROM public.person_profile pp
     WHERE pp.person_id = pe.id AND pp.profile_type = 'national_id'
     ORDER BY (pp.verified_by IS NOT NULL) DESC, pp.id DESC
     LIMIT 1
  ) idp ON true
  ORDER BY 1 NULLS LAST, 2;
END;
$$;

COMMENT ON FUNCTION fn_declare_iit IS
  '个人所得税扣缴申报表（工资薪金所得）。全部金额从已封账的 payslip 读，不重算税。'
  '减除费用 = 5000 × 本年已封账月数；累计已缴 = 本年已封账工资条的 tax_amount 之和（含本月）。'
  '年终奖（kind=bonus）不进本表，要按"全年一次性奖金"单独申报。';

-- ---------------------------------------------------------------------------
-- 4. 社会保险费申报表（逐人逐险种）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_declare_si(p_entity bigint, p_period varchar)
RETURNS TABLE (
  employee_no   varchar(16),
  person_name   varchar(64),
  item          varchar(24),
  item_name     varchar(32),
  base_amount   numeric(12,2),          -- 缴费基数（申报基数优先，无则月薪标准）
  rate_employee numeric(6,4),
  rate_employer numeric(6,4),
  emp_amount    numeric(12,2),          -- 个人应缴（从工资条读；工伤/生育为 0；未登记为 NULL）
  er_amount     numeric(12,2),          -- 单位应缴（按基数重算）
  total_amount  numeric(14,2),          -- 合计（任一项为 NULL 则 NULL，不硬凑）
  remark        varchar
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_run  bigint;
  v_pend date;
BEGIN
  v_run  := public.fn_declare_run(p_entity, p_period, 'monthly');
  v_pend := (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;

  RETURN QUERY
  WITH s AS (
    SELECT p.id AS slip_id, p.employee_id
      FROM public.payslip p
     WHERE p.pay_run_id = v_run
  ), pol0 AS (
    SELECT DISTINCT ON (sp.item) sp.item, sp.rate_employee, sp.rate_employer
      FROM public.si_policy sp
     -- ★ 城市写死'上海'，与算薪主过程（fn_payroll_calc）里那处字面量同源。
     --   两处必须一起改：只改这里，申报表的基数就会与工资条上的扣款对不上。
     --   真做多城市要把"参保城市"落到 employment 上，那是一次数据模型改动。
     WHERE sp.city = '上海' AND sp.effective_from <= v_pend
     ORDER BY sp.item, sp.effective_from DESC
  ), pol AS (
    -- 个人或单位有一方要缴的险种都在表里。工伤/生育只有单位缴 ——
    -- 它们**不出现**在工资条上，但必须出现在申报表上，否则少报单位缴费。
    SELECT * FROM pol0 WHERE rate_employee > 0 OR rate_employer > 0
  ), m AS (
    SELECT s.slip_id, s.employee_id,
           (SELECT ss.monthly_amount
              FROM public.salary_standard ss
             WHERE ss.employment_id = ej.id AND ss.effective_from <= v_pend
             ORDER BY ss.effective_from DESC LIMIT 1) AS wage
      FROM s
      LEFT JOIN LATERAL (
        -- 优先取"期间末仍在职"的那段；月中离职的人退而取最近一段 ——
        -- 不能因为没有在职区间就说"算不出基数"，那会漏报一个真实参保人。
        SELECT em.id
          FROM public.employment em
         WHERE em.person_id = s.employee_id
           AND em.legal_entity_id = p_entity
           AND em.hire_date <= v_pend
         ORDER BY (daterange(em.hire_date, em.leave_date, '[]') @> v_pend) DESC,
                  em.hire_date DESC
         LIMIT 1
      ) ej ON true
  ), row0 AS (
    SELECT m.slip_id, m.employee_id, m.wage, pol.item,
           pol.rate_employee, pol.rate_employer,
           public.fn_si_item_code(pol.item) AS item_code,
           public.fn_si_base_eff(m.employee_id, '上海', pol.item, m.wage, v_pend) AS base,
           (SELECT -pi.amount
              FROM public.payslip_item pi
             WHERE pi.payslip_id = m.slip_id
               AND pi.item_code = public.fn_si_item_code(pol.item)
             ORDER BY pi.id DESC
             LIMIT 1) AS emp_raw
      FROM m CROSS JOIN pol
  )
  SELECT
    (SELECT n.no FROM public.employee_no n
      WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
      ORDER BY n.assigned_at DESC LIMIT 1)::varchar(16),
    pe.full_name::varchar(64),
    r.item::varchar(24),
    public.fn_si_item_name(r.item)::varchar(32),
    r.base::numeric(12,2),
    r.rate_employee,
    r.rate_employer,
    -- 个人不缴的险种是真的 0；工资条里找不到明细行是 NULL（没登记）
    CASE WHEN r.rate_employee = 0 THEN 0::numeric(12,2)
         ELSE r.emp_raw::numeric(12,2) END,
    CASE WHEN r.base IS NULL THEN NULL
         ELSE round(r.base * r.rate_employer, 2)::numeric(12,2) END,
    CASE WHEN r.base IS NULL THEN NULL
         WHEN r.rate_employee > 0 AND r.emp_raw IS NULL THEN NULL
         ELSE round(CASE WHEN r.rate_employee = 0 THEN 0 ELSE r.emp_raw END
                    + round(r.base * r.rate_employer, 2), 2)::numeric(14,2) END,
    nullif(concat_ws('；',
      CASE WHEN r.wage IS NULL
           THEN '没有月薪标准，缴费基数算不出' END,
      CASE WHEN r.rate_employee > 0 AND r.item_code IS NULL
           THEN '工资项未登记（' || r.item || '）' END,
      CASE WHEN r.rate_employee > 0 AND r.item_code IS NOT NULL AND r.emp_raw IS NULL
           THEN '工资条无该险种明细行（历史结构只记 SI_EMPLOYEE 合计）' END,
      -- 对账：按基数重算的个人额 vs 工资条里真扣的个人额
      CASE WHEN r.emp_raw IS NOT NULL AND r.base IS NOT NULL
                AND abs(round(r.base * r.rate_employee, 2) - r.emp_raw) > 0.02
           THEN '个人额与基数重算差 '
                || round(r.emp_raw - round(r.base * r.rate_employee, 2), 2)::text
                || '（基数或费率改过，重算后没重新封账）' END
    ), '')::varchar
  FROM row0 r
  JOIN public.person pe ON pe.id = r.employee_id
  ORDER BY 1 NULLS LAST, 2, public.fn_si_item_seq(r.item);
END;
$$;

COMMENT ON FUNCTION fn_declare_si IS
  '社会保险费申报表（逐人逐险种）。个人额从工资条明细读（工伤/生育为 0，缺明细行为 NULL），'
  '单位额 = 缴费基数 × 单位费率（工资条不存单位部分，只能算，所以带一列对账）。';

-- ---------------------------------------------------------------------------
-- 5. 按险种汇总（申报表上半部分：一行一个险种）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_declare_si_sum(p_entity bigint, p_period varchar)
RETURNS TABLE (
  item        varchar(24),
  item_name   varchar(32),
  seq         smallint,
  person_count int,            -- 有基数的参保人数
  base_sum    numeric(14,2),
  emp_sum     numeric(14,2),   -- 只加"登记过"的个人额（NULL 不进 sum）
  er_sum      numeric(14,2),
  total_sum   numeric(14,2),
  emp_missing int              -- 有基数但个人额没登记的人数（>0 说明这张表还不完整）
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT d.item, d.item_name, public.fn_si_item_seq(d.item)::smallint,
         (count(*) FILTER (WHERE d.base_amount IS NOT NULL))::int,
         sum(d.base_amount)::numeric(14,2),
         sum(d.emp_amount)::numeric(14,2),
         sum(d.er_amount)::numeric(14,2),
         sum(d.total_amount)::numeric(14,2),
         (count(*) FILTER (WHERE d.base_amount IS NOT NULL
                             AND d.emp_amount IS NULL))::int
    FROM public.fn_declare_si(p_entity, p_period) d
   GROUP BY d.item, d.item_name
   ORDER BY public.fn_si_item_seq(d.item), d.item;
$$;

COMMENT ON FUNCTION fn_declare_si_sum IS
  '社保申报表汇总：一行一个险种。emp_missing > 0 表示该险种有人有基数却查不到个人额 —— '
  '这张表还不能报，先去核工资条结构（不是把缺的当 0 加进去）。';

-- ---------------------------------------------------------------------------
-- 6. 申报表导出留痕（只增不改）
-- ---------------------------------------------------------------------------
-- 与 055 的 report_export 同一套理由，但维度不同：那份按组织/期间，
-- 这份按**法人/期间/表种**。不合并成一张表：合并要放开 org_id 的 NOT NULL，
-- 而"导出的报表不知道属于哪个组织"这件事本身就是个洞。
CREATE TABLE IF NOT EXISTS tax_declare_export (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            varchar(8)  NOT NULL,      -- iit | si
  legal_entity_id bigint      NOT NULL,
  period          varchar(7)  NOT NULL,
  pay_run_id      bigint      NOT NULL REFERENCES pay_run(id),
  person_count    int         NOT NULL,
  row_count       int         NOT NULL,
  bytes           int         NOT NULL,
  content_sha256  char(64)    NOT NULL,
  total_amount    numeric(14,2) NOT NULL,
  exported_by     varchar(64) NOT NULL,
  exported_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_tde_kind   CHECK (kind IN ('iit','si')),
  CONSTRAINT ck_tde_period CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_tde_rows   CHECK (row_count > 0 AND person_count > 0),
  CONSTRAINT ck_tde_bytes  CHECK (bytes > 0),
  CONSTRAINT ck_tde_sha    CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE tax_declare_export IS
  '申报表导出留痕（141）：哪个法人、哪一期、哪张表、多少人、多少行、内容 sha256。'
  '比报表留痕更要紧 —— 这张表是要交给税务/社保的，事后要能回答"当时报的是哪一份"。';

CREATE OR REPLACE FUNCTION fn_tde_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'E_TDE_NO_DELETE: 申报表留痕不可删（删了就无法证明当时报的是哪一份）';
  END IF;
  RAISE EXCEPTION 'E_TDE_NO_UPDATE: 申报表留痕只增不改（改了摘要，它就不再证明任何事）';
END;
$$;

DROP TRIGGER IF EXISTS trg_tde_append_only ON tax_declare_export;
CREATE TRIGGER trg_tde_append_only
  BEFORE UPDATE OR DELETE ON tax_declare_export
  FOR EACH ROW EXECUTE FUNCTION fn_tde_append_only();

CREATE OR REPLACE FUNCTION fn_declare_log(
  p_kind varchar, p_entity bigint, p_period varchar, p_run bigint,
  p_persons int, p_rows int, p_bytes int, p_sha varchar,
  p_total numeric, p_by varchar
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.tax_declare_export
    (kind, legal_entity_id, period, pay_run_id, person_count, row_count,
     bytes, content_sha256, total_amount, exported_by)
  VALUES (p_kind, p_entity, p_period, p_run, p_persons, p_rows,
          p_bytes, p_sha::char(64), p_total, p_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_declare_log IS
  '写一条申报表导出留痕。与文件内容同一个事务：要么"导出成功且留了痕"，要么什么都没发生。';

-- ---------------------------------------------------------------------------
-- 7. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.DECL','申报表：只从封账批次出、金额与工资条同源、个人额 0 与"没登记"分得开',
   'PAYROLL','ALGORITHM','fn_declare_run','public','tax_declare_export','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-DECL','申报表接进接口与界面：两张表能出、导出留痕、未封账被拦',
   'PAYROLL','ACL','fn_declare_iit','public','tax_declare_export','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
