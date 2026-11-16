-- ============================================================================
-- 093_formula_try_compile.sql · 导入时的公式校验要连"编译"一起做
-- ----------------------------------------------------------------------------
-- 091 的 fn_formula_try 只跑 fn_formula_check（字符/变量/括号），
-- 但**参数个数**是在 fn_formula_rewrite（编译）阶段才查的。
-- 于是 `if(1,2)` 在导入时"通过"，直到真正算薪那天才炸 ——
-- 而那天算不出来的是整批人的工资。
--
-- 所以校验要包含编译：导入阶段就把 if/prorata/min/max 的参数个数、嵌套写法查完。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_formula_try(p_formula varchar, p_allow jsonb DEFAULT NULL)
RETURNS varchar
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  PERFORM public.fn_formula_check(p_formula, p_allow);
  -- 编译一遍：参数个数只有到这一步才看得出来（if 必须 3 个、min/max 至少 2 个）
  PERFORM public.fn_formula_rewrite(p_formula);
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END;
$$;

COMMENT ON FUNCTION fn_formula_try IS
  '不抛错的公式校验（含编译）：通过返回 NULL，否则返回错误文本。'
  '导入必须用它 —— 事务里一条语句失败会让整个事务 abort。';
