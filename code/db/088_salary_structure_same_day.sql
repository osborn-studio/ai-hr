-- ============================================================================
-- 088_salary_structure_same_day.sql · 同一天重设工资结构要能覆盖
-- ----------------------------------------------------------------------------
-- 087 的 fn_salary_structure_set 关旧版本时只关 `effective_from < p_from`，
-- 于是"同一天重设"会撞 ex_ssi_no_overlap：
--
--   先按 A 方案拆了一次（effective_from = 11-01），
--   发现拆分比例不对，改成 B 方案再存一次 —— 第二包插不进去。
--
-- 而这是**必然会发生的操作**：拆结构就是在试数字，第一次拆不顺手很正常。
-- 两种情形要分开处理：
--
--   · 同一天重设 → **替换**当天那一版（还没被任何工资条固化成历史口径，
--     工资条的明细是算薪那一刻写进 payslip_item 的，不依赖这一行）；
--   · 跨天调整   → 关旧版（effective_to = p_from - 1），历史不动。
--
-- 这也解释了为什么不是"直接更新当天那一行"：那要逐项 diff（哪些项被删了、
-- 哪些金额变了），而工资结构是一组约定 —— 整组替换比逐项改更难出错。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_salary_structure_set(
  p_employment bigint, p_from date, p_items jsonb, p_by varchar DEFAULT 'system'
) RETURNS numeric
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_total numeric(12,2); v_monthly numeric(12,2); v_bad text;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'E_SS_EMPTY: 工资结构至少要有一项';
  END IF;

  SELECT string_agg(DISTINCT x->>'item_code', '、') INTO v_bad
    FROM jsonb_array_elements(p_items) x
    LEFT JOIN public.salary_item si ON si.code = (x->>'item_code')
   WHERE si.code IS NULL OR si.item_kind <> 'fixed';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'E_SS_ITEM: 只能拆固定工资项，且必须是已登记项（收到：%）', v_bad;
  END IF;

  SELECT COALESCE(sum((x->>'amount')::numeric), 0) INTO v_total
    FROM jsonb_array_elements(p_items) x;
  IF v_total < 0 THEN RAISE EXCEPTION 'E_SS_SUM: 各项不能为负'; END IF;

  SELECT s.monthly_amount INTO v_monthly
    FROM public.salary_standard s
   WHERE s.employment_id = p_employment AND s.effective_from <= p_from
   ORDER BY s.effective_from DESC LIMIT 1;
  IF v_monthly IS NULL THEN
    RAISE EXCEPTION 'E_SS_NO_STANDARD: 这份任职在 % 之前没有月薪标准，先定月薪再拆结构', p_from;
  END IF;

  IF abs(v_total - v_monthly) > 0.005 THEN
    RAISE EXCEPTION 'E_SS_SUM: 各项之和 % 与月薪标准 % 不一致（结构只解释总额由什么组成，不改总额）',
      v_total, v_monthly;
  END IF;

  -- ① 同一天重设 → 整组替换（拆结构本身就是在试数字）
  DELETE FROM public.salary_structure_item
   WHERE employment_id = p_employment AND effective_from = p_from;

  -- ② 跨天调整 → 关旧版，历史不动
  UPDATE public.salary_structure_item
     SET effective_to = p_from - 1
   WHERE employment_id = p_employment AND effective_to IS NULL AND effective_from < p_from;

  INSERT INTO public.salary_structure_item(employment_id, item_code, amount, effective_from, set_by)
  SELECT p_employment, x->>'item_code', (x->>'amount')::numeric, p_from, p_by
    FROM jsonb_array_elements(p_items) x;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION fn_salary_structure_set IS
  '设置工资结构：合计必须等于月薪标准（E_SS_SUM），只允许 fixed 项（E_SS_ITEM）。'
  '同一天重设整组替换，跨天调整关旧版 —— 拆结构是在试数字，同一天反复改是常态。';
