-- ============================================================================
-- 002_check_registry.sql · 验收体系自身的地基（04 §4.5）
-- ----------------------------------------------------------------------------
-- 这张表的作用：把"我们有哪些断言"从脚本里搬进数据库，于是每条断言能自报状态
-- （绿 / 黄 / 红 / 未知 / 已豁免 / 从未跑过），而不是只有"脚本退出码"。
--
-- 本文件含 5 处 04 里已定、但需要真跑才能确认的机制：
--   ① 豁免三件套（waived_reason + waived_period + waived_by），三列同生同灭
--   ② 豁免是派生状态，不落列 —— 到期由时间自己完成，不需要巡检
--   ③ required_since 与业务侧 basis_start_at 分开
--   ④ expected_object 装下"还没建的东西"，不扩 guard_kind 枚举
--   ⑤ guard_kind 从"作者声明"变成"解析输出"
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 对象解析器：guard_kind 不许由作者写，必须由目录给
-- ---------------------------------------------------------------------------
-- ★ 为什么必须有它：FK 只能挡拼写，挡不住"我声明 TRIGGER、实际那是个 CONSTRAINT"。
--   解析器的返回值拿来和列里的值比对，不等即红。
CREATE OR REPLACE FUNCTION fn_resolve_object(
  p_schema varchar, p_table varchar, p_object varchar
) RETURNS varchar
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_object IS NULL THEN NULL
    WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                  WHERE c.conname = p_object
                    AND c.conrelid = pg_catalog.to_regclass(format('%I.%I', p_schema, p_table)))
      THEN 'CONSTRAINT'
    WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgname = p_object
                    AND t.tgrelid = pg_catalog.to_regclass(format('%I.%I', p_schema, p_table)))
      THEN 'TRIGGER'
    WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_class i
                   JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace
                  WHERE i.relname = p_object AND n.nspname = p_schema
                    AND i.relkind IN ('i', 'I'))
      THEN 'INDEX'
    ELSE 'MISSING'
  END;
$$;

-- ---------------------------------------------------------------------------
-- 2. 登记表
-- ---------------------------------------------------------------------------
CREATE TABLE sys_check_registry (
  check_code       varchar(32) PRIMARY KEY,
  name             varchar(128) NOT NULL,
  domain           varchar(24)  NOT NULL,
  kind             varchar(16)  NOT NULL,

  -- ① 它守的是哪条**结构**（空 = 它自己是唯一防线，登记为债）
  guard_object     varchar(96),
  guard_schema     varchar(32),
  guard_table      varchar(64),
  guard_kind       varchar(16),
  guard_debt_owner varchar(64),
  guard_debt_due   date,
  expected_object  varchar(96),            -- 将来要建的对象名；guard_object 为空时有意义

  -- ② 它自己怎么跑
  runner           varchar(96)  NOT NULL,
  assertion_sql    text         NOT NULL,
  mechanism_id     bigint,
  enabled          boolean      NOT NULL DEFAULT true,

  -- ③ 行为判据：一对贴边夹具
  fixture_accept   text,
  fixture_reject   text,
  boundary_unit    numeric(18,8),

  -- ④ 结论状态：四态，不是二态
  verdict          varchar(16) NOT NULL DEFAULT 'unknown',
  verdict_due      date,
  verdict_owner    varchar(64),

  -- ⑤ 豁免三件套（v1.10：原为两件套，缺审批人；waived_until 全仓无消费者）
  waived_reason    varchar(500),
  waived_period    daterange,              -- 右开由值承载，不靠 until 这个名字的约定
  waived_by        varchar(64),

  -- ⑥ 判据自身的时间基准
  required_since   date,                   -- 从哪起开始要求 ≠ 数据从哪起有信息

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,

  CONSTRAINT ck_scr_domain CHECK (domain IN
    ('ATTENDANCE','PAYROLL','PERM','ORG','SECURITY','INTEGRATION')),
  CONSTRAINT ck_scr_kind   CHECK (kind IN
    ('STRUCT','ALGORITHM','RECONCILE','ACL','DATA_QUALITY')),
  CONSTRAINT ck_scr_verdict CHECK (verdict IN
    ('green','yellow','red','unknown')),

  -- 债：没有结构就必须有人认领 + 有到期
  CONSTRAINT ck_scr_debt CHECK (guard_object IS NOT NULL
    OR (guard_debt_owner IS NOT NULL AND guard_debt_due IS NOT NULL)),
  -- 黄：必须有人承诺 + 有到期
  CONSTRAINT ck_scr_yellow CHECK (verdict <> 'yellow'
    OR (verdict_due IS NOT NULL AND verdict_owner IS NOT NULL)),
  -- guard_object 与 guard_kind 同生同灭
  CONSTRAINT ck_scr_guard CHECK ((guard_object IS NULL) = (guard_kind IS NULL)),

  -- ★ 三列同生同灭。不能顺写成 (a = b) = c ——
  --   那的通过集合是「全空」∪「恰好一个非空」，全满反而不通过，
  --   而改完的 DDL 与两列版看起来一模一样，这是它危险的地方。
  CONSTRAINT ck_scr_waive
    CHECK (num_nonnulls(waived_reason, waived_period, waived_by) IN (0, 3)),
  CONSTRAINT ck_scr_waive_period
    CHECK (waived_period IS NULL OR NOT isempty(waived_period)),
  -- ★ "我承诺修"的人不能同时是"我批准先别修"的人。
  --   两人之间是常规 SOD，同一张表的两列之间是这个，更隐蔽。
  CONSTRAINT ck_scr_waive_sod
    CHECK (waived_by IS NULL OR verdict_owner IS NULL OR waived_by <> verdict_owner)
);

-- ---------------------------------------------------------------------------
-- 3. 每次跑的结论单独一行（exercised 由它派生，不新增列）
-- ---------------------------------------------------------------------------
CREATE TABLE sys_check_run (
  id          bigint PRIMARY KEY,
  check_code  varchar(32) NOT NULL REFERENCES sys_check_registry(check_code),
  run_at      timestamptz NOT NULL DEFAULT clock_timestamp(),   -- 判定型时间戳
  outcome     varchar(16),
  hit_count   bigint,
  sample      jsonb,
  duration_ms int,
  CONSTRAINT ck_scr_outcome CHECK (outcome IN ('pass','fail','error','skipped'))
);
CREATE INDEX ix_scr_run_code ON sys_check_run(check_code, run_at DESC);

-- ---------------------------------------------------------------------------
-- 4. 豁免是派生状态，不落列
-- ---------------------------------------------------------------------------
-- ★ 为什么不是巡检：写成 `verdict IN ('green','red') AND waived_until < current_date`
--   会永久红 —— 豁免过期后没有任何东西去改那一行，而三列同生同灭，
--   每次红都要人手工清三列才能安静。一条每次都必须人肉消除的红，最后是被关掉。
-- ★ 为什么不是 VIEW：视图带不了参数，而 as_of 换成 current_date 就失去可复现性
--   （同一个查询跨零点给两个答案，"上个月的覆盖率"永远复现不出来）。
CREATE OR REPLACE FUNCTION fn_chk_effective(p_as_of date)
RETURNS TABLE (check_code varchar(32), verdict varchar(16), effective_verdict varchar(16))
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT r.check_code, r.verdict,
         CASE WHEN r.waived_period @> p_as_of THEN 'waived' ELSE r.verdict END
    FROM public.sys_check_registry r;
$$;

-- ---------------------------------------------------------------------------
-- 5. 执行覆盖面：四行分开，不许合成一个百分比
-- ---------------------------------------------------------------------------
-- ① exercised 且最新 pass  ② exercised 且最新 fail/error
-- ③ never_run（红）        ④ waived（**分母仍是 enabled 全量**，不能靠排除）
--   —— 被 waive 的检查原来从三行里消失，于是每豁免一条通过率涨一格，而没人会因此去查。
-- ★ 这里不能是视图：视图带不了参数，只能写 current_date，
--   于是同一个查询换一天跑出两个答案 —— "上个月的覆盖率"永远复现不出来。
--   这个毛病在 fn_chk_effective 上已经修过一次，视图里不许再犯第二次。
CREATE OR REPLACE FUNCTION fn_chk_coverage(p_as_of date)
RETURNS TABLE (
  check_code varchar(32), domain varchar(24), kind varchar(16),
  last_run_at timestamptz, last_outcome varchar(16),
  waived boolean, exercised boolean, bucket varchar(16)
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT r.check_code, r.domain, r.kind,
         l.run_at,
         COALESCE(l.outcome, 'never_run'),
         (r.waived_period @> p_as_of),
         EXISTS (SELECT 1 FROM public.sys_check_run x
                  WHERE x.check_code = r.check_code AND x.outcome IS NOT NULL),
         CASE WHEN r.waived_period @> p_as_of THEN 'waived'
              WHEN l.outcome IS NULL           THEN 'never_run'
              WHEN l.outcome = 'pass'          THEN 'pass'
              ELSE 'fail' END
    FROM public.sys_check_registry r
    LEFT JOIN LATERAL (
      SELECT run_at, outcome FROM public.sys_check_run c
       WHERE c.check_code = r.check_code ORDER BY run_at DESC LIMIT 1
    ) l ON true
   WHERE r.enabled;
$$;

-- ---------------------------------------------------------------------------
-- 6. guards 前三档（第四档视图做不到，必须真跑夹具）
-- ---------------------------------------------------------------------------
CREATE VIEW v_chk_guard_unbacked AS
SELECT r.check_code, r.domain, r.guard_schema, r.guard_table, r.guard_object,
       r.guard_kind, r.guard_debt_owner, r.guard_debt_due, r.expected_object,
       fn_resolve_object(r.guard_schema, r.guard_table, r.guard_object) AS resolved_kind,
       CASE
         WHEN r.guard_object IS NULL                                     THEN 'debt'
         WHEN pg_catalog.to_regclass(format('%I.%I', r.guard_schema, r.guard_table)) IS NULL
                                                                         THEN 'guard_table_missing'
         WHEN fn_resolve_object(r.guard_schema, r.guard_table, r.guard_object) = 'MISSING'
                                                                         THEN 'guard_missing'
         WHEN fn_resolve_object(r.guard_schema, r.guard_table, r.guard_object) <> r.guard_kind
                                                                         THEN 'guard_kind_mismatch'
         ELSE 'ok'
       END AS guard_state
  FROM sys_check_registry r
 WHERE r.enabled;

COMMENT ON VIEW v_chk_guard_unbacked IS
  '只覆盖 guards 一~三档。第四档（对象在、但 fixture_reject 不再被拒）必须由 runner 在事务里试插后回滚，视图做不到 —— 边界必须写出来，否则"返回零行"会被读成"四档全过"。';
