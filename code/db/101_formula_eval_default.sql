-- ============================================================================
-- 101_formula_eval_default.sql · "缺变量按 0"要真的成立
-- ----------------------------------------------------------------------------
-- 096 的注释写着"缺变量按 0"，但实现只遍历了 p_vars 的 key：
-- 变量在公式里出现、p_vars 里没有 → **不会被替换** → 拼进 SQL 后 PG 报
--   column "gross" does not exist
-- 于是"缺变量按 0"变成了一句空话，而报错看起来像 SQL 写错。
--
-- 修法：按 fn_formula_check 返回的变量清单逐个替换，p_vars 里没有的给 0。
-- 这样三件事同时成立：变量一定被替换、缺的按 0、SQL 里不可能残留标识符。
--
-- 同时把 try/sctipt_try 的探测变量补全（含结果侧 GROSS/NET/SI_EMPLOYEE/IIT）——
-- 少一个就会在导入/试算时报"column does not exist"，而那是我们自己的漏项。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_formula_eval(p_formula varchar, p_vars jsonb)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_expr text;
  v_used varchar[];
  k text; v numeric; v_out numeric;
BEGIN
  v_used := public.fn_formula_check(p_formula, p_vars);   -- 同时完成校验
  v_expr := public.fn_formula_rewrite(p_formula);

  FOREACH k IN ARRAY v_used LOOP
    v := COALESCE((p_vars->>k)::numeric, 0);
    v_expr := regexp_replace(v_expr, '\m' || k || '\M', '(' || v::text || ')', 'g');
  END LOOP;

  BEGIN
    EXECUTE 'SELECT (' || v_expr || ')::numeric' INTO v_out;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'E_FORMULA_EVAL: 公式「%」算不出来（%）', p_formula, SQLERRM;
  END;

  IF v_out IS NULL THEN
    RAISE EXCEPTION 'E_FORMULA_EVAL: 公式「%」算出了 NULL', p_formula;
  END IF;
  RETURN round(v_out, 2);
END;
$$;

COMMENT ON FUNCTION fn_formula_eval IS
  '公式求值：校验 → 编译 → 按"引用的变量清单"逐个替换（缺的按 0）→ 动态 SQL。'
  '按清单替换而不是按 p_vars 的 key：否则公式里有、参数里没有的变量会残留成列名。';

-- 探测变量补全：内置侧 + 结果侧
CREATE OR REPLACE FUNCTION fn_formula_probe(p_allow jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT (SELECT COALESCE(jsonb_object_agg(key, 1), '{}'::jsonb)
            FROM jsonb_object_keys(
              COALESCE(p_allow, '{}'::jsonb)
              || jsonb_build_object(
                   'MONTHLY',1,'COMMISSION',1,'PRESENT_DAYS',1,'WORK_DAYS',1,
                   'LEAVE_DAYS',1,'SI_BASE',1,'TAX_THRESHOLD',1,
                   'GROSS',1,'NET',1,'SI_EMPLOYEE',1,'IIT',1,
                   'LEAVE_DEDUCT',1,'PERF_BONUS',1)) AS k(key));
$$;

COMMENT ON FUNCTION fn_formula_probe IS
  '试算用的探测变量：全部内置变量都给 1。导入与界面试算共用这一份 —— '
  '漏一个变量，就会在试算时报"column does not exist"，而那是我们自己的漏项。';

CREATE OR REPLACE FUNCTION fn_formula_try(p_formula varchar, p_allow jsonb DEFAULT NULL)
RETURNS varchar
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  PERFORM public.fn_formula_check(p_formula, p_allow);
  PERFORM public.fn_formula_rewrite(p_formula);
  PERFORM public.fn_formula_eval(p_formula, public.fn_formula_probe(p_allow));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END;
$$;

CREATE OR REPLACE FUNCTION fn_formula_script_try(p_script text, p_allow jsonb DEFAULT NULL)
RETURNS varchar
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  PERFORM public.fn_formula_script_eval(p_script, public.fn_formula_probe(p_allow));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END;
$$;
