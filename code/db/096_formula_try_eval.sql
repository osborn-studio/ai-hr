-- ============================================================================
-- 096_formula_try_eval.sql · 导入校验要真的算一遍
-- ----------------------------------------------------------------------------
-- 093 让导入校验连"编译"一起做，但语法错（`POST_ALLOW+` 少了操作数）只有
-- 到 EXECUTE 那一刻才暴露 —— 于是它能通过导入，直到算薪那天整批人算不出来。
--
-- 修法：用一组全 1 的变量**试算一遍**。这一步把三类错都挡在导入阶段：
--   · 语法不完整（缺操作数、括号位置错）
--   · 除零（1/0）
--   · 结果不是数字（写成了纯比较式）
-- 代价是公式必须"对任何输入都能算出数"，而这正是算薪要求的。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_formula_try(p_formula varchar, p_allow jsonb DEFAULT NULL)
RETURNS varchar
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE v_probe jsonb;
BEGIN
  PERFORM public.fn_formula_check(p_formula, p_allow);
  PERFORM public.fn_formula_rewrite(p_formula);

  -- 试算：所有可引用变量都给 1 —— 只关心"能不能算出数"，不关心算出多少
  v_probe := (SELECT COALESCE(jsonb_object_agg(key, 1), '{}'::jsonb)
                FROM jsonb_object_keys(
                  COALESCE(p_allow, '{}'::jsonb)
                  || jsonb_build_object('MONTHLY',1,'COMMISSION',1,'PRESENT_DAYS',1,
                                        'WORK_DAYS',1,'LEAVE_DAYS',1,'SI_BASE',1,
                                        'TAX_THRESHOLD',1)) AS k(key));
  PERFORM public.fn_formula_eval(p_formula, v_probe);
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END;
$$;

COMMENT ON FUNCTION fn_formula_try IS
  '不抛错的公式校验（字符 → 编译 → 试算）：通过返回 NULL，否则返回错误文本。'
  '试算用全 1 变量，把"语法不完整/除零/结果不是数字"挡在导入阶段。';
