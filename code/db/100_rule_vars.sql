-- ============================================================================
-- 100_rule_vars.sql · 规则能看见算薪结果（GROSS / NET / SI / IIT）
-- ----------------------------------------------------------------------------
-- 092 的内置变量只有输入侧（MONTHLY / COMMISSION / PRESENT_DAYS …）。
-- 但**规则**要判断的恰恰是结果侧："应发超过 5 万要复核""实发为 0 要检查结构"。
-- 没有 GROSS / NET，规则就只能写一些无关痛痒的条件 —— 等于这个功能没接上。
--
-- 这几个变量在 before 阶段是**预估**（还没算细项）、在 after 阶段是**实际值**。
-- 所以规则的 stage 选择本身就有语义：before 拦"可能要出事"，after 查"确实出了事"。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_formula_check(p_formula varchar, p_allow jsonb DEFAULT NULL)
RETURNS varchar[]
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_vars varchar[] := ARRAY[]::varchar[];
  m text;
  v_funcs text[] := ARRAY['if','round','ceil','floor','abs','sqrt','power','mod',
                          'min','max','greatest','least','coalesce','max0','min0','prorata'];
  v_builtin text[] := ARRAY['MONTHLY','COMMISSION','PRESENT_DAYS','WORK_DAYS',
                            'LEAVE_DAYS','SI_BASE','TAX_THRESHOLD',
                            -- 结果侧：规则的判断对象
                            'GROSS','NET','SI_EMPLOYEE','IIT','LEAVE_DEDUCT','PERF_BONUS'];
BEGIN
  IF p_formula IS NULL OR btrim(p_formula) = '' THEN
    RAISE EXCEPTION 'E_FORMULA_EMPTY: 公式不能为空';
  END IF;

  IF p_formula LIKE '%--%' OR p_formula LIKE '%/*%' OR p_formula LIKE '%*/%' THEN
    RAISE EXCEPTION 'E_FORMULA_CHAR: 公式里不能出现 -- 或 /* */（注释符会把后面的算式吞掉）';
  END IF;

  IF p_formula !~ '^[0-9A-Za-z_+\-*/().,<>!=[:space:]]+$' THEN
    RAISE EXCEPTION 'E_FORMULA_CHAR: 公式里只能有数字、项目代码、函数、运算符号与括号（收到：%）', p_formula;
  END IF;

  IF (length(p_formula) - length(replace(p_formula, '(', '')))
     <> (length(p_formula) - length(replace(p_formula, ')', ''))) THEN
    RAISE EXCEPTION 'E_FORMULA_PAREN: 括号不配平（%）', p_formula;
  END IF;

  FOR m IN
    SELECT DISTINCT (regexp_matches(p_formula, '[A-Za-z_][A-Za-z0-9_]*', 'g'))[1]
  LOOP
    IF lower(m) IN ('and', 'or', 'not') THEN
      CONTINUE;
    END IF;
    IF p_formula ~* ('\m' || m || '\M\s*\(') THEN
      IF NOT (m = ANY (v_funcs)) THEN
        RAISE EXCEPTION 'E_FORMULA_FUNC: 没有这个函数「%」（可用函数见 fn_formula_funcs）', m;
      END IF;
      CONTINUE;
    END IF;
    IF m = ANY (v_builtin) THEN
      v_vars := v_vars || m::varchar;
      CONTINUE;
    END IF;
    IF p_allow IS NOT NULL AND p_allow ? m THEN
      v_vars := v_vars || m::varchar;
      CONTINUE;
    END IF;
    RAISE EXCEPTION 'E_FORMULA_VAR: 公式里用了没登记的项「%」', m;
  END LOOP;

  RETURN v_vars;
END;
$$;

COMMENT ON FUNCTION fn_formula_check IS
  '公式校验：注释符、字符白名单、括号配平、函数白名单、变量已登记。'
  '内置变量含输入侧（MONTHLY/COMMISSION/PRESENT_DAYS…）与结果侧（GROSS/NET/SI_EMPLOYEE/IIT）。';
