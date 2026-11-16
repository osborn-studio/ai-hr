-- ============================================================================
-- 113_prorata_numeric.sql · 折算必须走小数除法（整数除法会静默截断）
-- ----------------------------------------------------------------------------
-- 111 把应出勤从 21.75（numeric）改成 22（整数）。看着只是"改了个默认值"，
-- 实际把 prorata 的编译结果从
--     600 * 1 / 21.75  →  27.59   （numeric 除法）
-- 变成
--     600 * 1 / 22     →  27       （PostgreSQL 整数除法，直接截掉小数）
--
-- 而它不会报错、不会变 NULL、勾稽也照样平 —— 只是每个月每个人少几毛到几块。
-- 一个月几百人的公司，这个"几毛"是几千块，且没人能在工资条上看出异常。
--
-- 修法：prorata 编译时把三个操作数都转 numeric。不是给这一处打补丁，
-- 而是让"折算"这件事在任何输入下都走小数 —— 输入是整数还是小数不该影响结果。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_formula_rewrite(p_expr text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_out text := ''; i int := 1; n int := length(p_expr); ch text;
  v_word text; v_depth int; j int; v_inner text; v_args text[]; k2 int;
BEGIN
  WHILE i <= n LOOP
    ch := substr(p_expr, i, 1);

    -- 取出当前处的标识符（如果是一个"函数名("的开头）
    IF ch ~ '[A-Za-z_]' AND (i = 1 OR substr(p_expr, i - 1, 1) !~ '[A-Za-z0-9_]') THEN
      v_word := (regexp_match(substr(p_expr, i), '^[A-Za-z_][A-Za-z0-9_]*'))[1];
      IF substr(p_expr, i + length(v_word), 1) = '('
         AND lower(v_word) IN ('if', 'prorata', 'max0', 'min0', 'min', 'max') THEN
        -- 找匹配的右括号
        v_depth := 1; j := i + length(v_word) + 1;
        WHILE j <= n AND v_depth > 0 LOOP
          ch := substr(p_expr, j, 1);
          IF ch = '(' THEN v_depth := v_depth + 1;
          ELSIF ch = ')' THEN v_depth := v_depth - 1; END IF;
          j := j + 1;
        END LOOP;
        IF v_depth <> 0 THEN RAISE EXCEPTION 'E_FORMULA_PAREN: 函数 % 的括号不配平', v_word; END IF;

        -- 内部区间：[ '(' 之后 , ')' 之前 )，长度 = ')' 位置 − 起点
        v_inner := substr(p_expr, i + length(v_word) + 1,
                          (j - 1) - (i + length(v_word) + 1));
        v_args := public.fn_formula_split(v_inner);

        IF lower(v_word) = 'if' THEN
          IF array_length(v_args, 1) <> 3 THEN
            RAISE EXCEPTION 'E_FORMULA_ARGS: if 需要 3 个参数（条件, 真值, 假值），收到 % 个',
              COALESCE(array_length(v_args, 1), 0);
          END IF;
          v_out := v_out || '(CASE WHEN (' || public.fn_formula_rewrite(v_args[1]) || ')'
                          || ' THEN (' || public.fn_formula_rewrite(v_args[2]) || ')'
                          || ' ELSE (' || public.fn_formula_rewrite(v_args[3]) || ') END)';
        ELSIF lower(v_word) = 'prorata' THEN
          IF array_length(v_args, 1) <> 3 THEN
            RAISE EXCEPTION 'E_FORMULA_ARGS: prorata 需要 3 个参数（金额, 实际, 应出）';
          END IF;
          -- 应出为 0 时按"不折算"处理：否则整条工资会因为除零变成 NULL
          -- ★ 三处 ::numeric 是必须的，不是啰嗦：
          --   PostgreSQL 里 `600*1/22` 是**整数除法**，结果是 27 而不是 27.27。
          --   应出勤从 21.75（numeric）改成 22（整数）之后，所有按出勤折算的项
          --   都被静默向下取整了 —— 一天差几毛钱看不出来，一个月几百人就是几千块。
          v_out := v_out || '(CASE WHEN (' || public.fn_formula_rewrite(v_args[3]) || ')::numeric = 0'
                          || ' THEN (' || public.fn_formula_rewrite(v_args[1]) || ')::numeric'
                          || ' ELSE (' || public.fn_formula_rewrite(v_args[1]) || ')::numeric'
                          || ' * (' || public.fn_formula_rewrite(v_args[2]) || ')::numeric'
                          || ' / (' || public.fn_formula_rewrite(v_args[3]) || ')::numeric END)';
        ELSIF lower(v_word) IN ('min', 'max') THEN
          -- ★ PostgreSQL 的 min/max 是**聚合函数**，`min(a,b)` 会报
          --   "function min(integer, integer) does not exist"。
          --   客户写 min/max 想要的是"两数取小/取大"，所以编译成 LEAST/GREATEST。
          IF array_length(v_args, 1) < 2 THEN
            RAISE EXCEPTION 'E_FORMULA_ARGS: % 至少需要 2 个参数', v_word;
          END IF;
          v_out := v_out || (CASE WHEN lower(v_word) = 'min' THEN 'LEAST(' ELSE 'GREATEST(' END);
          FOR k2 IN 1 .. array_length(v_args, 1) LOOP
            IF k2 > 1 THEN v_out := v_out || ', '; END IF;
            v_out := v_out || public.fn_formula_rewrite(v_args[k2]);
          END LOOP;
          v_out := v_out || ')';
        ELSIF lower(v_word) = 'max0' THEN
          v_out := v_out || 'GREATEST((' || public.fn_formula_rewrite(COALESCE(v_args[1], '0')) || '), 0)';
        ELSE -- min0
          v_out := v_out || 'LEAST((' || public.fn_formula_rewrite(COALESCE(v_args[1], '0')) || '), 0)';
        END IF;

        i := j;
        CONTINUE;
      END IF;
    END IF;

    v_out := v_out || ch;
    i := i + 1;
  END LOOP;
  RETURN v_out;
END;
$$;

;
