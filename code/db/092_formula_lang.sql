-- ============================================================================
-- 092_formula_lang.sql · 工资公式语言（函数库 + 条件 + 折算）
-- ----------------------------------------------------------------------------
-- 089 只做到"四则运算 + 变量替换"，离客户嘴里的"公式要能配"差得远：
-- 真实工资表里一定有 **条件**（满 3 个月才发全勤）、**折算**（按出勤天数比例）、
-- **取整**（四舍五入到分/元）、**封顶保底**（补贴不超过 500）。
--
-- 这一版把公式做成一门**受限的小语言**：
--
--   表达式  := 数字 | 变量 | 函数调用 | 表达式 运算符 表达式 | ( 表达式 )
--   运算符  := + - * / 与比较 > < >= <= = <> ，以及 AND / OR / NOT
--   变量    := 已登记的工资项代码 | MONTHLY | COMMISSION | PRESENT_DAYS |
--              WORK_DAYS | LEAVE_DAYS | SI_BASE | TAX_THRESHOLD
--   函数    := round/ceil/floor/abs/sqrt/power/mod/min/max/greatest/least/coalesce
--              + if(条件,真值,假值) + prorata(金额,实际,应出) + max0(x) + min0(x)
--
-- 三条安全线（少了任何一条，这套东西就等于给数据库开了个 eval）：
--   ① 字符白名单：只允许数字、字母、下划线、运算符、括号、逗号、空格。
--      引号/分号/反斜杠一律拒。
--   ② 注释符 **显式拒绝** `--` 与 `/*`：`-` 是合法运算符，所以 `1--2` 是合法算式，
--      而 PostgreSQL 会把它当注释 —— 公式静默变成 `1`，这是最阴的一种错。
--   ③ 变量必须在 p_vars 里、函数必须在白名单里。未知函数不放过（
--      否则 `pg_sleep(60)` 会被当成一个"函数"跑起来）。
--
-- ★ 求值仍然是"编译成 SQL 表达式再 EXECUTE"，不是 eval 任意文本：
--   编译发生在白名单校验之后，且只做四件事（if→CASE、prorata→乘除、
--   max0/min0→GREATEST/LEAST、变量→数字）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 函数库（前端据此出"可用函数"面板，不另抄一份说明）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_formula_funcs()
RETURNS TABLE (code varchar, args varchar, category varchar, descr varchar, example varchar)
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  VALUES
    ('if',        'if(条件, 真值, 假值)', '逻辑', '条件成立取真值，否则取假值', 'if(MONTHLY >= 10000, 500, 200)'),
    ('round',     'round(x[, 小数位])',   '取整', '四舍五入，默认到整数', 'round(BASE/21.75*2, 2)'),
    ('ceil',      'ceil(x)',             '取整', '向上取整', 'ceil(PRESENT_DAYS/2)'),
    ('floor',     'floor(x)',            '取整', '向下取整', 'floor(MONTHLY/1000)'),
    ('abs',       'abs(x)',              '数学', '绝对值', 'abs(LEAVE_DAYS)'),
    ('sqrt',      'sqrt(x)',             '数学', '平方根', 'sqrt(MONTHLY)'),
    ('power',     'power(x, y)',         '数学', 'x 的 y 次方', 'power(1.05, 2)'),
    ('mod',       'mod(x, y)',           '数学', 'x 除以 y 的余数', 'mod(PRESENT_DAYS, 7)'),
    ('min',       'min(a, b)',           '数学', '两数取小', 'min(COMMISSION, 5000)'),
    ('max',       'max(a, b)',           '数学', '两数取大', 'max(COMMISSION, 0)'),
    ('greatest',  'greatest(a, b, ...)', '数学', '多个数取最大', 'greatest(BASE, 3000)'),
    ('least',     'least(a, b, ...)',    '数学', '多个数取最小', 'least(COMMISSION, 8000)'),
    ('coalesce',  'coalesce(a, b, ...)', '逻辑', '取第一个非空值', 'coalesce(COMMISSION, 0)'),
    ('max0',      'max0(x)',             '封顶', '小于 0 按 0（扣款封底）', 'max0(BASE - 5000)'),
    ('min0',      'min0(x)',             '封顶', '大于 0 按 0（负数封顶）', 'min0(COMMISSION)'),
    ('prorata',   'prorata(金额, 实际, 应出)', '折算', '按比例折算：金额×实际/应出', 'prorata(600, PRESENT_DAYS, WORK_DAYS)')
$$;

COMMENT ON FUNCTION fn_formula_funcs IS
  '公式可用函数清单（含签名、分类、示例）。前端只读这一份，不另抄说明 —— '
  '抄出来的第二份一定会在加函数时被忘掉。';

-- ---------------------------------------------------------------------------
-- 2. 校验：字符、注释符、函数名、变量名、括号
-- ---------------------------------------------------------------------------
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
                            'LEAVE_DAYS','SI_BASE','TAX_THRESHOLD'];
BEGIN
  IF p_formula IS NULL OR btrim(p_formula) = '' THEN
    RAISE EXCEPTION 'E_FORMULA_EMPTY: 公式不能为空';
  END IF;

  -- ① 注释符先拒：`-` 是合法运算符，`1--2` 会变成注释，公式静默变 1
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

  -- ② 标识符：紧跟着 '(' 的是函数（必须在白名单），其余是变量（必须已登记）
  FOR m IN
    SELECT DISTINCT (regexp_matches(p_formula, '[A-Za-z_][A-Za-z0-9_]*', 'g'))[1]
  LOOP
    -- AND / OR / NOT 是运算符，不是项也不是函数
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

  -- ③ 关键字不能当变量用（AND/OR/NOT 是运算符，不是项）
  IF p_formula ~* '\m(and|or|not)\M' THEN
    v_vars := v_vars;
  END IF;

  RETURN v_vars;
END;
$$;

COMMENT ON FUNCTION fn_formula_check IS
  '公式校验：注释符、字符白名单、括号配平、函数白名单、变量已登记。'
  '返回引用的变量列表；任何一项不过就抛 E_FORMULA_*（导入时用 fn_formula_try 取文本）。';

-- ---------------------------------------------------------------------------
-- 3. 按顶层逗号切参数
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_formula_split(p_args text)
RETURNS text[]
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_out text[] := ARRAY[]::text[];
  v_depth int := 0; v_cur text := ''; i int := 1; ch text;
BEGIN
  WHILE i <= length(p_args) LOOP
    ch := substr(p_args, i, 1);
    IF ch = '(' THEN v_depth := v_depth + 1;
    ELSIF ch = ')' THEN v_depth := v_depth - 1;
    END IF;
    IF ch = ',' AND v_depth = 0 THEN
      v_out := v_out || btrim(v_cur); v_cur := '';
    ELSE
      v_cur := v_cur || ch;
    END IF;
    i := i + 1;
  END LOOP;
  IF btrim(v_cur) <> '' THEN v_out := v_out || btrim(v_cur); END IF;
  RETURN v_out;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. 编译：if → CASE、prorata → 乘除、max0/min0 → GREATEST/LEAST
-- ---------------------------------------------------------------------------
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
          v_out := v_out || '(CASE WHEN (' || public.fn_formula_rewrite(v_args[3]) || ') = 0'
                          || ' THEN (' || public.fn_formula_rewrite(v_args[1]) || ')'
                          || ' ELSE (' || public.fn_formula_rewrite(v_args[1]) || ')'
                          || ' * (' || public.fn_formula_rewrite(v_args[2]) || ')'
                          || ' / (' || public.fn_formula_rewrite(v_args[3]) || ') END)';
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

COMMENT ON FUNCTION fn_formula_rewrite IS
  '把 if/prorata/max0/min0 编译成 SQL 能算的形式（CASE / 乘除 / GREATEST / LEAST）。'
  'prorata 的应出为 0 时按不折算处理 —— 除零会让整条工资变 NULL，而 NULL 会被下游当成 0。';

-- ---------------------------------------------------------------------------
-- 5. 求值
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_formula_eval(p_formula varchar, p_vars jsonb)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_expr text;
  k text; v numeric; v_out numeric;
BEGIN
  PERFORM public.fn_formula_check(p_formula, p_vars);

  v_expr := public.fn_formula_rewrite(p_formula);

  FOR k IN SELECT jsonb_object_keys(p_vars) LOOP
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
  '公式求值：白名单校验 → 编译（if/prorata/max0/min0）→ 变量替换 → 动态 SQL。'
  '缺变量按 0；除零在 prorata 里已处理，其余除零会变成 E_FORMULA_EVAL。';

-- ---------------------------------------------------------------------------
-- 6. 判据组
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.FL','公式语言：函数白名单、注释符拒绝、if/prorata 编译、除零不产生 NULL',
   'PAYROLL','ALGORITHM','fn_formula_rewrite','public','salary_item','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
