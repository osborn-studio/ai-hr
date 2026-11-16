-- ============================================================================
-- 135_severance_pre2008.sql · 2008 年前入职的人：补偿要分两段算
-- ----------------------------------------------------------------------------
-- 134 把所有人的补偿都按《劳动合同法》第 47 条算。这对 2008-01-01 之后入职的人
-- 是对的，对之前入职的人**会少算** —— 而他们恰好是工龄最长、最可能去仲裁的那批人。
--
-- 依据：
--   《劳动合同法》第 97 条第 3 款：
--     "本法施行之日存续的劳动合同在本法施行后解除或者终止，依照本法第四十六条
--      规定应当支付经济补偿的，经济补偿年限自本法施行之日起计算；本法施行前
--      按照当时有关规定，用人单位应当向劳动者支付经济补偿的，按照当时有关规定执行。"
--   → 分两段：2008-01-01 前按老办法，之后按新法，各自算完相加。
--
--   老办法：《违反和解除劳动合同的经济补偿办法》（劳部发〔1994〕481 号）
--     第 5 条（协商一致）、第 6 条（不能胜任）：每满一年一个月，**最多不超过十二个月**；
--     第 7 条（经济性裁员）、第 9 条（医疗期满）：每满一年一个月，条文未设上限；
--     第 11 条：月平均工资 = 解除前十二个月的平均工资（与新法同口径）。
--     老办法**没有**"三倍社平封顶"这一条 —— 那是 2008 年新法才有的。
--
-- ★★ 两段的三处差别，少一处就是算错钱：
--
--   ① **前段不封顶。** 老办法没有三倍社平的概念。把前段也按三倍封顶，
--      高薪老员工的补偿会凭空少一大截。
--   ② **后段才封 12 年。** 新法 47 条的"年限最高十二年"只对被三倍封顶的人适用；
--      没被封顶的人根本不受这个限制（134 已经这么做了，这里保持）。
--   ③ **前段的 12 个月上限按情形分。** 老办法第 5/6 条有、第 7/9 条没有。
--      这一条各地执行差异很大，所以做成制度项 `SEVERANCE_OLD_CAP_MONTHS`：
--      默认 0（不设上限）—— 多付不少付，且少付是会被追的。
--
-- ★ 年限进位：老办法原文只说"每满一年"，没说余月怎么办。实务上普遍按
--   半年进位（与新法一致），这样两段的解释口径统一、不打架。
--   制度项 `SEVERANCE_OLD_ROUND`：half（默认，半年进位）/ year（严格满一年）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 制度项
-- ---------------------------------------------------------------------------
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES
  ('SEVERANCE_OLD_ROUND',     '2008 年前补偿年限怎么进位', 'PAYROLL', 'enum',    false, 'group', ''),
  ('SEVERANCE_OLD_CAP_MONTHS','2008 年前补偿最多几个月',   'PAYROLL', 'numeric', false, 'group', '月')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('SEVERANCE_OLD_ROUND', '2026-01-01', 'half', 'group_hr',
        '默认半年进位：与新法口径一致，两段解释不打架；老办法原文未细说余月')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
VALUES ('SEVERANCE_OLD_CAP_MONTHS', '2026-01-01', 0, 'group_hr',
        '默认 0=不设上限：老办法第 5/6 条有 12 个月上限、第 7/9 条没有，各地执行差异大；'
        '多付不少付，客户可按当地口径设置')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. 老办法的年限进位
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_severance_n_old(p_months int, p_days_rest int, p_mode varchar)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_years int;
  v_rest  int;
BEGIN
  IF p_months IS NULL OR p_months < 0 THEN RETURN 0; END IF;
  v_years := p_months / 12;
  v_rest  := p_months % 12;

  IF COALESCE(p_mode,'half') = 'year' THEN
    -- 严格按"每满一年"：不满一年不计（老办法原文的字面读法）
    RETURN v_years;
  END IF;

  -- half：与 47 条同一套进位（满年 1、余≥6 个月 1、余 1–5 或零头 0.5）
  IF v_rest >= 6 THEN RETURN v_years + 1; END IF;
  IF v_rest > 0 OR COALESCE(p_days_rest,0) > 0 THEN RETURN v_years + 0.5; END IF;
  RETURN v_years;
END;
$$;

COMMENT ON FUNCTION fn_severance_n_old IS
  '2008 年前那段年限进位。half=半年进位（默认，与新法一致）/ year=严格满一年。'
  '老办法原文只说"每满一年"，余月怎么办各地做法不同，所以做成可配。';

-- ---------------------------------------------------------------------------
-- 3. 结算单补列
-- ---------------------------------------------------------------------------
ALTER TABLE severance_settlement ADD COLUMN IF NOT EXISTS pre2008_months  int NOT NULL DEFAULT 0;
ALTER TABLE severance_settlement ADD COLUMN IF NOT EXISTS n_old           numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE severance_settlement ADD COLUMN IF NOT EXISTS old_wage        numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE severance_settlement ADD COLUMN IF NOT EXISTS severance_old   numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE severance_settlement ADD COLUMN IF NOT EXISTS post2008_months int NOT NULL DEFAULT 0;
ALTER TABLE severance_settlement ADD COLUMN IF NOT EXISTS n_new           numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE severance_settlement ADD COLUMN IF NOT EXISTS severance_new   numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN severance_settlement.severance_old IS
  '2008-01-01 前那段：按老办法算，不受三倍社平封顶（135）。';
COMMENT ON COLUMN severance_settlement.severance_new IS
  '2008-01-01 后那段：按 47 条算，封顶时年限最多 12 年（135）。';

-- ---------------------------------------------------------------------------
-- 4. 重出 fn_severance_calc（返回列变了，必须先 DROP）
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_severance_calc(bigint,date,varchar,varchar,boolean);

CREATE FUNCTION fn_severance_calc(
  p_employment bigint, p_leave date, p_reason varchar, p_city varchar DEFAULT '上海',
  p_notice boolean DEFAULT false
) RETURNS TABLE(
  service_months int, service_days_rest int, n_months numeric, raw_n numeric,
  avg_wage numeric, cap_applied boolean, cap_years_applied boolean, base_wage numeric,
  severance numeric, notice numeric, annual_leave numeric,
  exempt numeric, taxable numeric, tax numeric, total numeric, net numeric,
  cap_multiple numeric, local_avg numeric,
  split boolean,                                -- 是否分段（2008 前入职）
  pre2008_months int, n_old numeric, old_wage numeric, severance_old numeric,
  post2008_months int, n_new numeric, severance_new numeric
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  c_cut    date := '2008-01-01';
  e        public.employment%ROWTYPE;
  r        public.severance_reason%ROWTYPE;
  iv       interval;
  v_m      int;
  v_d      int;
  v_avg    numeric(12,2);
  v_local  numeric(12,2);
  v_cap    numeric(12,2);
  v_cap_app boolean := false;
  v_cap_y   boolean := false;
  v_n       numeric(5,2);
  v_sev     numeric(12,2);
  v_al      numeric(12,2) := 0;
  v_tx      record;
  -- 分段
  v_split   boolean := false;
  v_pre_m   int := 0;
  v_pre_d   int := 0;
  v_post_m  int := 0;
  v_post_d  int := 0;
  v_n_old   numeric(5,2) := 0;
  v_n_new   numeric(5,2) := 0;
  v_old_w   numeric(12,2) := 0;
  v_new_w   numeric(12,2) := 0;
  v_sev_old numeric(12,2) := 0;
  v_sev_new numeric(12,2) := 0;
  v_round   varchar(8);
  v_old_cap numeric(6,2) := 0;
  iv2       interval;
BEGIN
  SELECT * INTO e FROM public.employment WHERE id = p_employment;
  IF e.id IS NULL THEN RAISE EXCEPTION 'E_SEV_NO_EMP: 没有这条任职记录（id=%）', p_employment; END IF;
  IF p_leave < e.hire_date THEN
    RAISE EXCEPTION 'E_SEV_BEFORE_HIRE: 离职日 % 早于入职日 %', p_leave, e.hire_date;
  END IF;

  SELECT * INTO r FROM public.severance_reason WHERE code = p_reason;
  IF r.code IS NULL THEN RAISE EXCEPTION 'E_SEV_REASON: 不认识离职情形 %', p_reason; END IF;

  iv := age(p_leave, e.hire_date);
  v_m := (EXTRACT(year FROM iv)::int * 12) + EXTRACT(month FROM iv)::int;
  v_d := EXTRACT(day FROM iv)::int;
  service_months := v_m;
  service_days_rest := v_d;

  v_avg := public.fn_severance_avg_wage(e.person_id, p_leave);
  avg_wage := v_avg;

  SELECT w.monthly INTO v_local
    FROM public.local_avg_wage w
   WHERE w.city = p_city AND w.wage_year <= EXTRACT(year FROM p_leave)::int
   ORDER BY w.wage_year DESC LIMIT 1;
  IF v_local IS NULL THEN
    RAISE EXCEPTION 'E_SEV_NO_AVG_WAGE: % 没有职工月平均工资数据，算不出三倍封顶', p_city;
  END IF;
  local_avg := v_local;
  cap_multiple := 3.0;
  v_cap := round(v_local * 3, 2);

  IF e.hire_date < c_cut THEN
    -- ================= 分段：2008 前按老办法、之后按新法 =================
    v_split := true;

    iv2 := age(LEAST(p_leave, c_cut - 1), e.hire_date);
    v_pre_m := GREATEST((EXTRACT(year FROM iv2)::int * 12) + EXTRACT(month FROM iv2)::int, 0);
    v_pre_d := GREATEST(EXTRACT(day FROM iv2)::int, 0);

    IF p_leave > c_cut - 1 THEN
      iv2 := age(p_leave, c_cut);
      v_post_m := GREATEST((EXTRACT(year FROM iv2)::int * 12) + EXTRACT(month FROM iv2)::int, 0);
      v_post_d := GREATEST(EXTRACT(day FROM iv2)::int, 0);
    END IF;

    SELECT COALESCE(value_text,'half') INTO v_round
      FROM public.fn_policy_effective('SEVERANCE_OLD_ROUND', NULL, p_leave);
    SELECT COALESCE(value_num,0) INTO v_old_cap
      FROM public.fn_policy_effective('SEVERANCE_OLD_CAP_MONTHS', NULL, p_leave);

    v_n_old := public.fn_severance_n_old(v_pre_m, v_pre_d, v_round);
    IF v_old_cap > 0 THEN
      v_n_old := LEAST(v_n_old, v_old_cap);
    END IF;
    v_old_w := v_avg;                       -- ★ 前段不封顶（老办法没有三倍社平）
    v_sev_old := round(v_old_w * v_n_old, 2);

    v_n_new := public.fn_severance_n(v_post_m, v_post_d);
    v_new_w := v_avg;
    IF v_avg > v_cap THEN
      v_new_w := v_cap;
      v_cap_app := true;
      IF v_n_new > 12 THEN
        v_n_new := 12;
        v_cap_y := true;
      END IF;
    END IF;
    v_sev_new := round(v_new_w * v_n_new, 2);

    -- 情形倍数作用在总年限上（0N 情形两段都不给；2N 两段都翻倍）
    v_n_old := v_n_old * r.n_multiple;
    v_n_new := v_n_new * r.n_multiple;
    v_sev_old := round(v_sev_old * r.n_multiple, 2);
    v_sev_new := round(v_sev_new * r.n_multiple, 2);

    n_months := v_n_old + v_n_new;
    raw_n := public.fn_severance_n_old(v_pre_m, v_pre_d, v_round)
             + public.fn_severance_n(v_post_m, v_post_d);
    base_wage := v_new_w;                   -- 展示用：取封顶后的那个（后段才是新法口径）
    v_sev := v_sev_old + v_sev_new;
  ELSE
    -- ================= 2008 后入职：只有新法一段 =================
    v_n := public.fn_severance_n(v_m, v_d) * r.n_multiple;
    raw_n := public.fn_severance_n(v_m, v_d);
    v_new_w := v_avg;
    IF v_avg > v_cap THEN
      v_new_w := v_cap;
      v_cap_app := true;
      IF v_n > 12 THEN
        v_n := 12;
        v_cap_y := true;
      END IF;
    END IF;
    base_wage := v_new_w;
    v_n_new := v_n;
    v_sev_new := round(v_new_w * v_n, 2);
    v_sev := v_sev_new;
    n_months := v_n;
  END IF;

  cap_applied := v_cap_app;
  cap_years_applied := v_cap_y;
  severance := v_sev;

  notice := CASE WHEN p_notice AND r.notice_pay THEN round(base_wage, 2) ELSE 0 END;

  SELECT COALESCE(SUM(x.amount), 0) INTO v_al
    FROM public.leave_cashout x
   WHERE x.employee_id = e.person_id
     AND x.leave_year = EXTRACT(year FROM p_leave)::int
     AND x.status IN ('pending','paid');
  annual_leave := v_al;

  SELECT * INTO v_tx FROM public.fn_severance_tax(v_sev, p_city, EXTRACT(year FROM p_leave)::int);
  exempt := v_tx.exempt;
  taxable := v_tx.taxable;
  tax := v_tx.tax;

  total := round(v_sev + notice + v_al, 2);
  net := round(v_sev - v_tx.tax + notice + v_al, 2);

  split := v_split;
  pre2008_months := v_pre_m;
  n_old := v_n_old;
  old_wage := v_old_w;
  severance_old := v_sev_old;
  post2008_months := v_post_m;
  n_new := v_n_new;
  severance_new := v_sev_new;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_severance_calc IS
  '离职结算试算。2008-01-01 后入职：47 条一段算（封顶时年限封 12）。'
  '2008 前入职：分两段 —— 前段按老办法（不封顶、12 个月上限由制度项决定），'
  '后段按 47 条（封顶且年限封 12），各自算完相加。';

-- ---------------------------------------------------------------------------
-- 5. 落单函数接上分段列（其余与 134 逐字一致）
-- ---------------------------------------------------------------------------
-- 从 134 原样抽出再改 INSERT 的列清单 —— 不重打，避免抄错别的行。
CREATE OR REPLACE FUNCTION fn_severance_create(
  p_employment bigint, p_leave date, p_reason varchar, p_city varchar,
  p_note varchar, p_by varchar DEFAULT 'system', p_notice boolean DEFAULT false
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  c  record;
  e  public.employment%ROWTYPE;
  v_id bigint;
BEGIN
  IF p_note IS NULL OR length(btrim(p_note)) < 4 THEN
    RAISE EXCEPTION 'E_SEV_NO_NOTE: 结算单要写说明（至少 4 个字）；'
      '三个月后没人答得出"为什么按 N 而不是 N+1 结"';
  END IF;

  SELECT * INTO e FROM public.employment WHERE id = p_employment;
  IF e.id IS NULL THEN RAISE EXCEPTION 'E_SEV_NO_EMP: 没有这条任职记录（id=%）', p_employment; END IF;

  SELECT * INTO c FROM public.fn_severance_calc(p_employment, p_leave, p_reason, p_city, p_notice);

  INSERT INTO public.severance_settlement(
    employment_id, person_id, leave_date, reason_code, city,
    service_months, service_days_rest, n_months, avg_wage,
    cap_multiple, cap_applied, cap_years_applied, base_wage,
    severance_amount, notice_amount, annual_leave_amount,
    tax_exempt_amount, taxable_amount, tax_amount,
    total_amount, net_amount, status, note, created_by,
    pre2008_months, n_old, old_wage, severance_old,
    post2008_months, n_new, severance_new)
  VALUES (
    p_employment, e.person_id, p_leave, p_reason, p_city,
    c.service_months, c.service_days_rest, c.n_months, c.avg_wage,
    c.cap_multiple, c.cap_applied, c.cap_years_applied, c.base_wage,
    c.severance, c.notice, c.annual_leave,
    c.exempt, c.taxable, c.tax,
    c.total, c.net, 'draft', btrim(p_note), p_by,
    c.pre2008_months, c.n_old, c.old_wage, c.severance_old,
    c.post2008_months, c.n_new, c.severance_new)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_severance_create IS
  '落一张离职结算单（draft）。金额全部来自 fn_severance_calc，这里不重算。';

