-- ============================================================================
-- 107_adjust_midmonth.sql · 调整单的在职判断改用期末
-- ----------------------------------------------------------------------------
-- 106 用"期间首日"判断在职，于是**月中入职的人调不了薪**：
-- 11-14 入职的人在 11-01 还不存在，而他的 11 月工资恰好最需要调。
-- 算薪用的是期末（daterange @> 期末），这里必须一致，否则
-- "调不了薪"会看起来像"这个人没有在职记录"。
-- 生效日仍是期间首日 —— 两件事，别混。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_salary_adjust_create(
  p_person bigint, p_period varchar, p_after_items jsonb,
  p_reason varchar, p_source varchar DEFAULT 'manual', p_by varchar DEFAULT 'system'
) RETURNS varchar
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_emp bigint;
  v_from date;
  v_before_monthly numeric(12,2);
  v_before_items jsonb;
  v_after_total numeric(12,2);
  v_bad text;
  v_seq int;
  v_code varchar(32);
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 调整原因至少 4 个字';
  END IF;

  v_from := to_date(p_period || '-01', 'YYYY-MM-DD');

  -- ★ 在职判断用**期末**，不是期首：11-14 入职的人在 11-01 还不存在，
  --   但他的 11 月工资要调。调整本身仍从期间首日生效（与工资表 effective_from 一致）。
  SELECT e.id INTO v_emp
    FROM public.employment e
   WHERE e.person_id = p_person
     AND daterange(e.hire_date, e.leave_date, '[]')
         @> (v_from + interval '1 month - 1 day')::date
   ORDER BY e.hire_date DESC LIMIT 1;
  IF v_emp IS NULL THEN
    RAISE EXCEPTION 'E_NO_EMPLOYMENT: 人员 % 在 % 没有在职记录', p_person, p_period;
  END IF;

  -- 只允许拆固定项：把"算出来的"（个税/社保）写进结构，会让政策变成约定
  SELECT string_agg(DISTINCT x->>'item_code', '、') INTO v_bad
    FROM jsonb_array_elements(p_after_items) x
    LEFT JOIN public.salary_item si ON si.code = (x->>'item_code')
   WHERE si.code IS NULL OR si.item_kind <> 'fixed';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'E_SS_ITEM: 调整单只能填固定工资项（收到：%）', v_bad;
  END IF;

  SELECT COALESCE(sum((x->>'amount')::numeric), 0) INTO v_after_total
    FROM jsonb_array_elements(p_after_items) x;
  IF v_after_total <= 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 调整后合计必须大于 0';
  END IF;

  -- 变更前快照
  SELECT COALESCE((SELECT s.monthly_amount FROM public.salary_standard s
                    WHERE s.employment_id = v_emp AND s.effective_from <= v_from
                    ORDER BY s.effective_from DESC LIMIT 1), 0) INTO v_before_monthly;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('item_code', f.item_code, 'amount', f.amount)), '[]'::jsonb)
    INTO v_before_items
    FROM public.fn_salary_structure_of(v_emp, v_from) f;

  SELECT count(*) + 1 INTO v_seq FROM public.salary_adjustment WHERE period = p_period;
  v_code := 'ADJ-' || replace(p_period, '-', '') || '-' || lpad(v_seq::text, 4, '0');

  INSERT INTO public.salary_adjustment(
    code, period, person_id, employment_id, before_monthly, after_monthly,
    before_items, after_items, delta, source, reason, created_by)
  VALUES (v_code, p_period, p_person, v_emp, v_before_monthly, v_after_total,
          v_before_items, p_after_items, v_after_total - v_before_monthly,
          COALESCE(p_source, 'manual'), btrim(p_reason), p_by);
  RETURN v_code;
END;
$$;

;

COMMENT ON FUNCTION fn_salary_adjust_create IS
  '建工资调整单（draft）：快照 before/after、算差额、生成单号。'
  '在职判断用期末（月中入职也能调），生效日仍是期间首日。';
