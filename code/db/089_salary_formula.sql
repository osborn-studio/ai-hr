-- ============================================================================
-- 089_salary_formula.sql · 工资项目公式 + 导入批次
-- ----------------------------------------------------------------------------
-- 客户给过来的是**一张工资表**：项目名、金额，还有一些是算出来的
-- （提成 = 销售额 × 比例、全勤奖 = 基本工资 × 5%）。要接住这类表，
-- 系统得能存"项目"和"公式"，而不只是几个写死的项。
--
-- 三条边界：
--
--   ① **公式必须能被审计**：存的是文本（varchar），不是编译后的东西 ——
--      客户问"这个 1200 怎么来的"，答案是"岗位津贴 × 20%"，而不是一个黑盒。
--
--   ② **公式求值不能等同于 eval**：PostgreSQL 里没有安全 eval，所以走
--      "白名单字符 + 变量替换 + 动态 SQL"。变量名必须是已登记的项目代码，
--      函数名只放 round/min/max/abs/coalesce 这几个纯函数。
--      不做这层校验的话，一个 `pg_sleep(60)` 就能把算薪拖死。
--
--   ③ **公式项是加项，不改结构**：它加在应发上，不参与"月薪拆分"
--      （拆分只解释固定工资由什么组成）。否则同一笔钱会被拆一次、再算一次。
--
-- 导入只做两件事：把表读成行、把行里的项目与公式登记进来。
-- 真正的应用（生成工资结构 / 写入金额）在服务层，逐行校验、逐行给结论 ——
-- 一行错不该让整批失败，也不该静默跳过。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 工资项：公式与排序
-- ---------------------------------------------------------------------------
ALTER TABLE salary_item
  ADD COLUMN IF NOT EXISTS formula varchar(500),
  ADD COLUMN IF NOT EXISTS sort_order int NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS note varchar(200);

COMMENT ON COLUMN salary_item.formula IS
  '派生项的算式（如 POST_ALLOW*0.2）。空 = 不是派生项。'
  '允许引用：其它已登记项目代码、MONTHLY（月薪标准）、COMMISSION（本期提成合计）、'
  'PRESENT_DAYS（本期出勤天数）。函数只允许 round/min/max/abs/coalesce。';

-- 顺序决定求值次序：后面的公式可以引用前面的结果
UPDATE salary_item SET sort_order = 10 WHERE code = 'BASE';
UPDATE salary_item SET sort_order = 20 WHERE code IN ('POST_ALLOW', 'MEAL', 'COMM');
UPDATE salary_item SET sort_order = 30 WHERE code = 'PERF_BONUS';
UPDATE salary_item SET sort_order = 40 WHERE code = 'COMMISSION';
UPDATE salary_item SET sort_order = 90 WHERE code IN ('LEAVE_DEDUCT', 'SI_EMPLOYEE', 'IIT');

-- ---------------------------------------------------------------------------
-- 2. 公式：校验与求值
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
  v_known text[] := ARRAY['round','min','max','abs','coalesce','greatest','least','ceil','floor'];
BEGIN
  IF p_formula IS NULL OR btrim(p_formula) = '' THEN
    RAISE EXCEPTION 'E_FORMULA_EMPTY: 公式不能为空';
  END IF;

  -- ① 字符白名单。放开了等号/分号/引号，就等于放开了"任意 SQL 片段"。
  IF p_formula !~ '^[0-9A-Za-z_+\-*/().,[:space:]]+$' THEN
    RAISE EXCEPTION 'E_FORMULA_CHAR: 公式里只能有数字、项目代码、运算符号与括号（收到：%）', p_formula;
  END IF;

  -- ② 括号配平：配不平就不用等到 EXECUTE 才炸
  IF (length(p_formula) - length(replace(p_formula, '(', '')))
     <> (length(p_formula) - length(replace(p_formula, ')', ''))) THEN
    RAISE EXCEPTION 'E_FORMULA_PAREN: 括号不配平（%）', p_formula;
  END IF;

  -- ③ 变量名必须已登记（或在内置变量里），函数名走白名单
  -- ★ 必须取 [1]：regexp_matches 返回的是 text[]，直接当标量用会得到 "{POST_ALLOW}"，
  --   于是每个变量都被判成"没登记"，而错误消息里带着花括号 —— 看起来像数据脏。
  FOR m IN
    SELECT DISTINCT (regexp_matches(p_formula, '[A-Za-z_][A-Za-z0-9_]*', 'g'))[1]
  LOOP
    CONTINUE WHEN m = ANY (v_known);
    IF m IN ('MONTHLY','COMMISSION','PRESENT_DAYS','WORK_DAYS') THEN
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
  '公式校验：字符白名单、括号配平、变量必须是已登记项或内置变量（MONTHLY/COMMISSION/PRESENT_DAYS/WORK_DAYS）。'
  '返回公式引用的变量列表（供服务层做"谁来算"的拓扑排序）。';

CREATE OR REPLACE FUNCTION fn_formula_eval(p_formula varchar, p_vars jsonb)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_expr text := p_formula;
  k text; v numeric; v_out numeric;
BEGIN
  PERFORM public.fn_formula_check(p_formula, p_vars);

  -- 逐变量替换（\m \M 是词边界：BASE 不会把 POST_BASE 里的 BASE 换掉）
  FOR k IN SELECT jsonb_object_keys(p_vars) LOOP
    -- 变量缺失或为 NULL 一律按 0：一个没填的项不该让整张工资表算不出来。
    -- 它与"项不存在"是两件事：不存在在 fn_formula_check 就已经拒了。
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
  '公式求值：白名单校验之后，把变量替换成数字，再用动态 SQL 算一次。'
  '缺变量按 0 —— 没填的项不该让整张工资表算不出来。';

-- ---------------------------------------------------------------------------
-- 3. 导入批次（模板 / 数据两种）
-- ---------------------------------------------------------------------------
CREATE TABLE salary_import_batch (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind        varchar(16) NOT NULL,          -- items（项目+公式）| data（每人金额）
  filename    varchar(200) NOT NULL,
  row_total   int NOT NULL DEFAULT 0,
  row_ok      int NOT NULL DEFAULT 0,
  row_fail    int NOT NULL DEFAULT 0,
  status      varchar(16) NOT NULL DEFAULT 'parsed',   -- parsed | applied | failed
  note        varchar(300),
  created_by  varchar(64) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  applied_at  timestamptz,
  CONSTRAINT ck_sib_kind CHECK (kind IN ('items','data')),
  CONSTRAINT ck_sib_status CHECK (status IN ('parsed','applied','failed'))
);

CREATE TABLE salary_import_row (
  id        bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  batch_id  bigint NOT NULL REFERENCES salary_import_batch(id) ON DELETE CASCADE,
  row_no    int NOT NULL,
  payload   jsonb NOT NULL,
  ok        boolean NOT NULL DEFAULT false,
  error     varchar(300),
  UNIQUE (batch_id, row_no)
);

COMMENT ON TABLE salary_import_row IS
  '导入的每一行都留一条：ok=false 的行也留着，并带原因。'
  '"一行错就整批失败"会让 HR 反复改表；"静默跳过"更糟 —— 少一个人不会报错。';

-- 数据导入的应用结果：某人某期某项目的金额（应用后进工资结构）
CREATE TABLE salary_import_value (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  batch_id   bigint NOT NULL REFERENCES salary_import_batch(id) ON DELETE CASCADE,
  person_id  bigint NOT NULL REFERENCES person(id),
  item_code  varchar(32) NOT NULL REFERENCES salary_item(code),
  amount     numeric(12,2) NOT NULL,
  UNIQUE (batch_id, person_id, item_code)
);

-- ---------------------------------------------------------------------------
-- 4. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.FM','工资公式：字符白名单、变量必须已登记、括号配平、缺变量按 0、公式项计入应发',
   'PAYROLL','ALGORITHM','fn_formula_eval','public','salary_item','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
