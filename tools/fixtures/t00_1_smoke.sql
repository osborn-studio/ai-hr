-- ============================================================================
-- tools/fixtures/t00_1_smoke.sql
-- T00.1 空库建一遍 · 冒烟
-- ----------------------------------------------------------------------------
-- 【状态】未执行（executed = 0）。本机无 PostgreSQL，psql / postgres 均不存在。
--         本文件不含任何"已验证"字样，任何人无权在此写"已验证"。
-- 【用法】psql -v ON_ERROR_STOP=1 -f tools/fixtures/t00_1_smoke.sql
--         读结果：SELECT * FROM t00.v_t00_line ORDER BY fixture;
-- ----------------------------------------------------------------------------
-- 相对 research-shift 提交稿的三处修正（均为致命或使报告失效）：
--   ① 顶层 PERFORM 改为 SELECT。
--      PERFORM 是 PL/pgSQL 专用语句，在 psql 顶层是语法错——原稿 18 处全在 DO 块外，
--      第一处即中止，一条 fixture 都跑不到。
--   ② ②造的 expect 由 'ok' 改为 'fail'。
--      四件套里 ② 的通过条件就是"断言变红"。原稿写 'ok' 而 p_ok 恒 false，
--      于是 got='fail' 与 expect='ok' 不符 → v_t00_line.ok 对六条全部为 false，
--      报告变成六条全红，等于没有报告。
--   ③ 补 B-e-REAL 一行。
--      原稿 B-e 的 ② 在"真实 schema 缺 snap_on_duty_break_basis"时反而记 pass，
--      整条 fixture 绿——而真实缺陷仍在。这与本仓 §I65.6「假绿」同形：
--      fixture 证明的是"我能造出这个违规"，不是"库里没有这个违规"。
--      故独立一行，单独报真实 schema 的存在性。
-- ----------------------------------------------------------------------------
-- 规则（写死在本文件里，不进报告）：
--   四件套  ① 建（正例，须绿） ② 造违规（须红） ③ 修复后（须绿） ④ 阴性对照（须红）
--   修只许改数据。
--   判据：被断言对象的定义在 ①②③ 三步必须字节级相同 —— 见 t00.v_t00_art_drift，须为空。
--         有行 = 修动了断言或被断言对象 = 该条作废（不是"通过"）。
--         B-c / B-d 的 ③ 是 DDL（移除入侵者），被断言对象未被触碰，故仍由该判据兑现。
--   断言钉到具体表达式，不钉"约束存在"。
--         建不起来是好消息；建起来了但建错了才是要测的那件事。
--   批次  A 随 PG 版本变 → 按 server_version_num 门控；门控外记 not_applicable，不记 skip
--         （写成 skip 之后它会永远 skip，见 02g §I67.6）
--         B 随本仓 DDL 变 → 每次构建都跑
--   阴性对照常驻 SELECT 1=0，期望 fail。它绿了，说明 t00_rec 自己坏了。
-- ============================================================================

-- 权威清单 = a–f（派单原单），本文件六条与之逐一对应，不多不少：
--   a RENAME 后视图指向        → A-a
--   b LIMIT NULL = LIMIT ALL   → A-b
--   c app_begin_scope 重载数   → B-c
--   d chk_ads_span 唯一 + round → B-d
--   e chk_ads_sum 依赖 snap 列 → B-e（形态层）+ B-e-REAL（真实 schema，单列）
--   f ex_eoa_no_overlap 用 '[]' → B-f
-- 【不在本文件】F1b（空壳函数探针抛 E_RESOURCE_UNREGISTERED）属 T01.2 验收，不属 T00.1 冒烟；
--   F4（CREATE OR REPLACE VIEW 缩列报错）是 PG 行为，但不在 a–f 清单内。
--   两套清单曾被我合成一套，此处分开写死，防止再次混入。
--
-- 不变式（写进注释，不改代码）：每个 DO 块里 PERFORM t00.t00_rec(...) 必须是该块的
--   **最后一句**。因为全局 off 之后，块内若在记录之后再抛错，那一行会留着 pass 而
--   错误被吞。记录放最后 ⇒ 中途死必然缺行 ⇒ 由末尾 MISSING 兜底接住。

\set ON_ERROR_STOP off
SET client_min_messages = notice;

DROP SCHEMA IF EXISTS t00 CASCADE;
CREATE SCHEMA t00;
SET search_path = t00, public;

-- ============================================================================
-- 骨架
-- ============================================================================
CREATE TABLE t00_report(
  fixture text NOT NULL,
  step    text NOT NULL CHECK (step IN ('①建','②违规','③修复后','④阴性对照')),
  expect  text NOT NULL CHECK (expect IN ('ok','fail','not_applicable')),
  got     text NOT NULL CHECK (got    IN ('pass','fail','not_applicable')),
  note    text,
  PRIMARY KEY (fixture, step)
);

CREATE TABLE t00_art(
  fixture  text NOT NULL,
  step     text NOT NULL,
  artifact text NOT NULL,
  PRIMARY KEY (fixture, step)
);

CREATE OR REPLACE FUNCTION t00.t00_rec(
  p_fx text, p_step text, p_expect text, p_ok boolean, p_note text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $rec$
BEGIN
  INSERT INTO t00.t00_report(fixture, step, expect, got, note)
  VALUES (p_fx, p_step, p_expect,
          CASE WHEN p_expect = 'not_applicable' THEN 'not_applicable'
               WHEN coalesce(p_ok, false)      THEN 'pass'
               ELSE 'fail' END, p_note)
  ON CONFLICT (fixture, step) DO UPDATE
    SET expect = EXCLUDED.expect, got = EXCLUDED.got, note = EXCLUDED.note;
END $rec$;

CREATE OR REPLACE FUNCTION t00.t00_art_rec(p_fx text, p_step text, p_art text)
RETURNS void LANGUAGE plpgsql AS $art$
BEGIN
  INSERT INTO t00.t00_art(fixture, step, artifact) VALUES (p_fx, p_step, p_art)
  ON CONFLICT (fixture, step) DO UPDATE SET artifact = EXCLUDED.artifact;
END $art$;

CREATE VIEW v_t00_result AS
SELECT fixture, step, expect, got, note,
       (expect = 'not_applicable' AND got = 'not_applicable')
    OR (expect = 'ok'             AND got = 'pass')
    OR (expect = 'fail'           AND got = 'fail') AS ok
  FROM t00_report;

-- 报告口径：每条一行，一行里四个结果。不加总计。
CREATE VIEW v_t00_line AS
SELECT fixture,
       string_agg(step || '=' || got, ' / '
                  ORDER BY array_position(ARRAY['①建','②违规','③修复后','④阴性对照'], step)) AS four,
       bool_and(coalesce(ok, false)) AS ok
  FROM t00_result GROUP BY fixture;

-- 规则"修只许改数据"的判据。
-- ★ 豁免必须显式化，不能靠"没调 t00_art_rec 所以不进视图"来隐含。
--   隐式的豁免集合 = 所有忘了记 art 的地方，它与"设计上无需记 art"完全同形，
--   两者都静默通过。写出来之后，"忘了记"才会红（MISSING_ART）。
CREATE TABLE t00_drift_exempt(fixture text PRIMARY KEY, reason text NOT NULL);
INSERT INTO t00_drift_exempt VALUES
  ('B-e-REAL', '只有 ①，无 ②③ 可漂移步骤');

CREATE VIEW v_t00_art_drift AS
SELECT r.fixture,
       coalesce(a.n, 0)          AS art_rows,
       coalesce(a.distinct_artifacts, 0) AS distinct_artifacts,
       CASE WHEN coalesce(a.n, 0) = 0 AND e.fixture IS NULL     THEN 'MISSING_ART'
            WHEN coalesce(a.n, 0) = 0 AND e.fixture IS NOT NULL  THEN 'EXEMPT'
            WHEN a.distinct_artifacts <> 1                       THEN 'DRIFT'
            ELSE 'OK' END AS state,
       e.reason AS exempt_reason
  FROM (SELECT DISTINCT fixture FROM t00_report) r
  LEFT JOIN (SELECT fixture, count(*) AS n, count(DISTINCT artifact) AS distinct_artifacts
               FROM t00_art GROUP BY fixture) a ON a.fixture = r.fixture
  LEFT JOIN t00_drift_exempt e ON e.fixture = r.fixture;

-- ============================================================================
-- A 批 · 随 PG 版本变
-- ============================================================================
SELECT (current_setting('server_version_num')::int >= 100000)::int AS a_ok \gset
\if :a_ok

-- ----------------------------------------------------------------------------
-- A-a  RENAME 之后视图指向
-- 断言：视图定义文本由 oid 派生，不是存储副本。存的副本会过期，视图不会。
-- 造违规：ALTER TABLE RENAME 后，副本仍写着旧表名。
-- 修：只 UPDATE 副本表（数据），不碰视图。
-- 被断言对象：视图对表的依赖边（pg_depend.objid/refobjid）—— 三步必须相同。
-- ----------------------------------------------------------------------------
CREATE TABLE t_a(id int PRIMARY KEY);
INSERT INTO t_a VALUES (1),(2);
CREATE VIEW   v_a AS SELECT id FROM t_a;

CREATE TABLE t_a_registry(view_name text PRIMARY KEY, def_text text NOT NULL);
INSERT INTO t_a_registry VALUES ('v_a', pg_get_viewdef('t00.v_a'::regclass, true));

CREATE OR REPLACE FUNCTION t00.t00_edge_a() RETURNS text LANGUAGE sql STABLE AS $e$
  SELECT coalesce(string_agg(d.objid::text || '/' || d.refobjid::text || '/' || d.refclassid::text,
                             ',' ORDER BY d.objid, d.refobjid), 'none')
    FROM pg_depend d
   WHERE d.objid = 't00.v_a'::regclass
     AND d.classid = 'pg_rewrite'::regclass
     AND d.refclassid = 'pg_class'::regclass;
$e$;

-- ① 建
SELECT t00.t00_art_rec('A-a','①建', t00.t00_edge_a());
DO $d$ BEGIN
  PERFORM t00.t00_rec('A-a','①建','ok',
    (SELECT def_text FROM t00.t_a_registry) = pg_get_viewdef('t00.v_a'::regclass, true)
    AND t00.t00_edge_a() <> 'none',
    '副本与 catalog 一致');
END $d$;

-- ② 造违规（改名后副本过期）
ALTER TABLE t00.t_a RENAME TO t_a_v2;
SELECT t00.t00_art_rec('A-a','②违规', t00.t00_edge_a());
DO $d$ BEGIN
  PERFORM t00.t00_rec('A-a','②违规','fail',
    (SELECT def_text FROM t00.t_a_registry) = pg_get_viewdef('t00.v_a'::regclass, true),
    '副本: ' || (SELECT left(def_text, 40) FROM t00.t_a_registry));
END $d$;

-- ③ 修复后（只改数据）
UPDATE t00.t_a_registry SET def_text = pg_get_viewdef('t00.v_a'::regclass, true);
SELECT t00.t00_art_rec('A-a','③修复后', t00.t00_edge_a());
DO $d$ BEGIN
  PERFORM t00.t00_rec('A-a','③修复后','ok',
    (SELECT def_text FROM t00.t_a_registry) = pg_get_viewdef('t00.v_a'::regclass, true),
    '只 UPDATE 了副本表');
END $d$;

-- ④ 阴性对照
DO $d$ BEGIN PERFORM t00.t00_rec('A-a','④阴性对照','fail',(SELECT 1=0)); END $d$;

-- ----------------------------------------------------------------------------
-- A-b  LIMIT NULL 等价 LIMIT ALL
-- 断言：同一个 NULL 放在 LIMIT 位置安全（等于 ALL），放在比较位置会把集合吃空。
-- 造违规：参数置 NULL。LIMIT 视图仍 5 行，比较视图变 0 行。
-- 修：UPDATE 参数（数据），两视图回到 5 行。
-- 被断言对象：两个视图的定义文本 —— 三步必须相同。
-- ----------------------------------------------------------------------------
CREATE TABLE t_b(x int);
INSERT INTO t_b SELECT generate_series(1,5);
CREATE TABLE t_b_knob(v int);
INSERT INTO t_b_knob VALUES (1000);

CREATE VIEW v_b_limit AS SELECT * FROM t_b LIMIT (SELECT v FROM t_b_knob);
CREATE VIEW v_b_cmp   AS SELECT * FROM t_b WHERE x < (SELECT v FROM t_b_knob);

CREATE OR REPLACE FUNCTION t00.t00_art_b() RETURNS text LANGUAGE sql STABLE AS $e$
  SELECT pg_get_viewdef('t00.v_b_limit'::regclass, true)
      || E'\n---\n' || pg_get_viewdef('t00.v_b_cmp'::regclass, true);
$e$;

-- ① 建
SELECT t00.t00_art_rec('A-b','①建', t00.t00_art_b());
DO $d$ BEGIN
  PERFORM t00.t00_rec('A-b','①建','ok',
    (SELECT count(*) FROM t00.v_b_limit) = 5 AND (SELECT count(*) FROM t00.v_b_cmp) = 5,
    'limit=' || (SELECT count(*) FROM t00.v_b_limit)
      || ' cmp=' || (SELECT count(*) FROM t00.v_b_cmp));
END $d$;

-- ② 造违规
UPDATE t00.t_b_knob SET v = NULL;
SELECT t00.t00_art_rec('A-b','②违规', t00.t00_art_b());
DO $d$ BEGIN
  PERFORM t00.t00_rec('A-b','②违规','fail',
    (SELECT count(*) FROM t00.v_b_limit) = 5 AND (SELECT count(*) FROM t00.v_b_cmp) = 5,
    'limit=' || (SELECT count(*) FROM t00.v_b_limit) || '(NULL 安全) cmp='
      || (SELECT count(*) FROM t00.v_b_cmp) || '(NULL 吃空)');
END $d$;

-- ③ 修复后（只改数据）
UPDATE t00.t_b_knob SET v = 2147483647;
SELECT t00.t00_art_rec('A-b','③修复后', t00.t00_art_b());
DO $d$ BEGIN
  PERFORM t00.t00_rec('A-b','③修复后','ok',
    (SELECT count(*) FROM t00.v_b_limit) = 5 AND (SELECT count(*) FROM t00.v_b_cmp) = 5,
    'limit=' || (SELECT count(*) FROM t00.v_b_limit)
      || ' cmp=' || (SELECT count(*) FROM t00.v_b_cmp));
END $d$;

-- ④ 阴性对照
DO $d$ BEGIN PERFORM t00.t00_rec('A-b','④阴性对照','fail',(SELECT 1=0)); END $d$;

\else

DO $d$ BEGIN
  PERFORM t00.t00_rec('A-a','①建','not_applicable',true,'server_version_num < 100000');
  PERFORM t00.t00_rec('A-a','②违规','not_applicable',true,'server_version_num < 100000');
  PERFORM t00.t00_rec('A-a','③修复后','not_applicable',true,'server_version_num < 100000');
  PERFORM t00.t00_rec('A-a','④阴性对照','fail',(SELECT 1=0));
  PERFORM t00.t00_rec('A-b','①建','not_applicable',true,'server_version_num < 100000');
  PERFORM t00.t00_rec('A-b','②违规','not_applicable',true,'server_version_num < 100000');
  PERFORM t00.t00_rec('A-b','③修复后','not_applicable',true,'server_version_num < 100000');
  PERFORM t00.t00_rec('A-b','④阴性对照','fail',(SELECT 1=0));
END $d$;

\endif

-- ============================================================================
-- B 批 · 随本仓 DDL 变，每次构建都跑
-- ============================================================================

-- ----------------------------------------------------------------------------
-- B-c  app_begin_scope 重载数 = 1
-- 断言：同名函数在该 schema 内重载数 = 1；真实 schema 内也须 = 1（不存在即红）。
-- 造违规：加一个不同签名的同名函数 → 重载数 2。
-- 修：DROP 入侵的那个（被断言函数未被触碰）。
-- 被断言对象：pg_get_functiondef('t00.app_begin_scope(text)')。
-- ----------------------------------------------------------------------------
CREATE FUNCTION t00.app_begin_scope(p_note text) RETURNS text LANGUAGE sql AS $f$
  SELECT p_note
$f$;

CREATE OR REPLACE FUNCTION t00.t00_real_overload() RETURNS int LANGUAGE sql STABLE AS $e$
  SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'app_begin_scope'
     AND n.nspname NOT IN ('t00','pg_catalog','information_schema');
$e$;

-- ① 建
SELECT t00.t00_art_rec('B-c','①建', pg_get_functiondef('t00.app_begin_scope(text)'::regprocedure));
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-c','①建','ok',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'app_begin_scope' AND n.nspname = 't00') = 1
    AND t00.t00_real_overload() = 1,
    '真实 schema 重载数: ' || t00.t00_real_overload());
END $d$;

-- ② 造违规
CREATE FUNCTION t00.app_begin_scope(p_n int) RETURNS int LANGUAGE sql AS $f$ SELECT p_n $f$;
SELECT t00.t00_art_rec('B-c','②违规', pg_get_functiondef('t00.app_begin_scope(text)'::regprocedure));
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-c','②违规','fail',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'app_begin_scope' AND n.nspname = 't00') = 1,
    '重载数: ' || (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE p.proname = 'app_begin_scope' AND n.nspname = 't00'));
END $d$;

-- ③ 修复后（DDL：移除入侵者；被断言函数未变）
DROP FUNCTION t00.app_begin_scope(int);
SELECT t00.t00_art_rec('B-c','③修复后', pg_get_functiondef('t00.app_begin_scope(text)'::regprocedure));
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-c','③修复后','ok',
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'app_begin_scope' AND n.nspname = 't00') = 1,
    '重载数: ' || (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE p.proname = 'app_begin_scope' AND n.nspname = 't00'));
END $d$;

-- ④ 阴性对照
DO $d$ BEGIN PERFORM t00.t00_rec('B-c','④阴性对照','fail',(SELECT 1=0)); END $d$;

-- ----------------------------------------------------------------------------
-- B-d  chk_ads_span 唯一，且定义里是 round 而非 abs
-- 断言（三条同时）：
--   a) schema 内名为 chk_ads_span 的约束数 = 1
--   b) constraintdef 里 grep 到 round( 且 grep 不到 abs(
--   c) 同一张表再加一条同名约束必须报 42710（duplicate_object）
-- 造违规：第二张表上再挂一条同名约束（PG 允许同名跨表）→ a) 变 2。
-- 修：DROP 第二张表上那条（被断言的那条未变）。
-- 被断言对象：t_d 上 chk_ads_span 的 constraintdef。
-- ----------------------------------------------------------------------------
CREATE TABLE t_d(
  span_start timestamptz NOT NULL,
  span_end   timestamptz NOT NULL,
  span_hours numeric(6,2),
  CONSTRAINT chk_ads_span CHECK (
    span_hours = round(EXTRACT(EPOCH FROM (span_end - span_start)) / 3600.0, 2)
  )
);

CREATE TABLE t_d_probe(got text);
DO $d$
DECLARE v text;
BEGIN
  BEGIN
    -- 同一表上重名约束必须被拒（42710）
    ALTER TABLE t00.t_d ADD CONSTRAINT chk_ads_span CHECK (span_end >= span_start);
    v := 'accepted';
  EXCEPTION WHEN duplicate_object THEN v := SQLSTATE;
  END;
  INSERT INTO t00.t_d_probe VALUES (v);
END $d$;

CREATE OR REPLACE FUNCTION t00.t00_def_d() RETURNS text LANGUAGE sql STABLE AS $e$
  SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
   WHERE c.conrelid = 't00.t_d'::regclass AND c.conname = 'chk_ads_span';
$e$;

-- ① 建
SELECT t00.t00_art_rec('B-d','①建', t00.t00_def_d());
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-d','①建','ok',
    (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = 'chk_ads_span' AND n.nspname = 't00') = 1
    AND t00.t00_def_d() ~ 'round\('
    AND t00.t00_def_d() !~ '\mabs\M'
    AND (SELECT got FROM t00.t_d_probe) = '42710',
    'def=' || t00.t00_def_d() || ' dup=' || (SELECT got FROM t00.t_d_probe));
END $d$;

-- ② 造违规（改成 abs 版，形态合法但语义丢）
CREATE TABLE t_d2(
  span_start timestamptz NOT NULL,
  span_end   timestamptz NOT NULL,
  span_hours numeric(6,2),
  CONSTRAINT chk_ads_span CHECK (
    abs(span_hours - EXTRACT(EPOCH FROM (span_end - span_start)) / 3600.0) < 0.01
  )
);
SELECT t00.t00_art_rec('B-d','②违规', t00.t00_def_d());
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-d','②违规','fail',
    (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = 'chk_ads_span' AND n.nspname = 't00') = 1,
    '同名约束数: ' || (SELECT count(*)::text FROM pg_constraint c
                        JOIN pg_namespace n ON n.oid = c.connamespace
                       WHERE c.conname = 'chk_ads_span' AND n.nspname = 't00')
    || '; t_d2 定义: ' ||
       (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
         WHERE c.conrelid = 't00.t_d2'::regclass AND c.conname = 'chk_ads_span'));
END $d$;

-- ③ 修复后（DDL：移除入侵者；被断言的那条未变）
ALTER TABLE t00.t_d2 DROP CONSTRAINT chk_ads_span;
SELECT t00.t00_art_rec('B-d','③修复后', t00.t00_def_d());
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-d','③修复后','ok',
    (SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = 'chk_ads_span' AND n.nspname = 't00') = 1
    AND t00.t00_def_d() ~ 'round\(',
    'def=' || t00.t00_def_d());
END $d$;

-- ④ 阴性对照
DO $d$ BEGIN PERFORM t00.t00_rec('B-d','④阴性对照','fail',(SELECT 1=0)); END $d$;

-- ----------------------------------------------------------------------------
-- B-e  chk_ads_sum 依赖 snap_on_duty_break_basis（形态层）
-- 断言（三条同时）：
--   a) 该列存在
--   b) 约束 def 里 grep 到 round( 且 grep 不到 abs(
--   c) 同一组 grep 对"故意写成 abs() 的版本"必须报警 —— 证明它能分辨"建错了"
-- 造违规：在 t_e_wrong 上建 abs 版（形态合法但语义错）。
-- 修：在 t_e_fixed 上按正确形态重建，证明同一断言可转绿。
-- 被断言对象：t_e 上 chk_ads_sum 的 constraintdef（三步未变）。
-- ----------------------------------------------------------------------------
CREATE TABLE t_e(
  employee_id int NOT NULL,
  work_date   date NOT NULL,
  snap_on_duty_break_basis numeric(6,2),
  duty_minutes int NOT NULL,
  CONSTRAINT chk_ads_sum CHECK (duty_minutes >= round(snap_on_duty_break_basis)::int)
);
CREATE TABLE t_e_wrong(
  employee_id int NOT NULL,
  work_date   date NOT NULL,
  snap_on_duty_break_basis numeric(6,2),
  duty_minutes int NOT NULL,
  CONSTRAINT chk_ads_sum CHECK (duty_minutes >= abs(snap_on_duty_break_basis)::int)
);

CREATE OR REPLACE FUNCTION t00.t00_def_e() RETURNS text LANGUAGE sql STABLE AS $e$
  SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
   WHERE c.conrelid = 't00.t_e'::regclass AND c.conname = 'chk_ads_sum';
$e$;

-- ① 建（含"grep 能不能分辨"的自检）
SELECT t00.t00_art_rec('B-e','①建', t00.t00_def_e());
DO $d$
DECLARE w text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO w FROM pg_constraint c
   WHERE c.conrelid = 't00.t_e_wrong'::regclass AND c.conname = 'chk_ads_sum';
  PERFORM t00.t00_rec('B-e','①建','ok',
    (SELECT count(*) FROM pg_attribute a
      WHERE a.attrelid = 't00.t_e'::regclass
        AND a.attname = 'snap_on_duty_break_basis'
        AND a.attnum > 0 AND NOT a.attisdropped) = 1
    AND t00.t00_def_e() ~ 'round\('
    AND t00.t00_def_e() !~ '\mabs\M'
    AND w ~ '\mabs\M',
    'def=' || t00.t00_def_e() || ' | abs版被识别=' || (w ~ '\mabs\M')::text);
END $d$;

-- ② 造违规（形态层的违规：abs 版建得起来）
SELECT t00.t00_art_rec('B-e','②违规', t00.t00_def_e());
DO $d$
DECLARE w text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO w FROM pg_constraint c
   WHERE c.conrelid = 't00.t_e_wrong'::regclass AND c.conname = 'chk_ads_sum';
  -- 通过条件：abs 版建成了（说明"建得起来但建错了"是真实存在的形态）
  PERFORM t00.t00_rec('B-e','②违规','ok', w ~ '\mabs\M', 'abs 版已建成: ' || coalesce(w,'(无)'));
END $d$;

-- ③ 修复后（按正确形态重建到 t_e_fixed）
CREATE TABLE t_e_fixed(
  employee_id int NOT NULL,
  work_date   date NOT NULL,
  snap_on_duty_break_basis numeric(6,2),
  duty_minutes int NOT NULL,
  CONSTRAINT chk_ads_sum CHECK (duty_minutes >= round(snap_on_duty_break_basis)::int)
);
SELECT t00.t00_art_rec('B-e','③修复后', t00.t00_def_e());
DO $d$
DECLARE f text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO f FROM pg_constraint c
   WHERE c.conrelid = 't00.t_e_fixed'::regclass AND c.conname = 'chk_ads_sum';
  PERFORM t00.t00_rec('B-e','③修复后','ok', f ~ 'round\(' AND f !~ '\mabs\M',
    't_e_fixed: ' || coalesce(f,'(无)'));
END $d$;

-- ④ 阴性对照
DO $d$ BEGIN PERFORM t00.t00_rec('B-e','④阴性对照','fail',(SELECT 1=0)); END $d$;

-- ----------------------------------------------------------------------------
-- B-e-REAL  真实 schema 是否存在 snap_on_duty_break_basis
-- 独立一行，因为 B-e 证明的是"我能造出这个违规"，不是"库里没有这个违规"。
-- 合成一条 = 假绿（02g §I65.6）：fixture 全绿而真实缺陷仍在。
-- 截至 2026-11-14，04 里该列 0 处，即未落。**这条现在就该红，红是对的。**
-- 禁止写成 skip —— 写成 skip 之后它会永远 skip。
-- ----------------------------------------------------------------------------
DO $d$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_attribute a
    JOIN pg_class c     ON c.oid = a.attrelid
    JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE a.attname = 'snap_on_duty_break_basis'
     AND a.attnum > 0 AND NOT a.attisdropped
     AND s.nspname NOT IN ('t00','pg_catalog','information_schema');
  PERFORM t00.t00_rec('B-e-REAL','①建','ok', n >= 1,
    '真实 schema 中该列出现 ' || n || ' 处（期望 ≥1）；0 处即红，修在 04 的 DDL（02g §I61 裁决）');
END $d$;

-- ----------------------------------------------------------------------------
-- B-f  employee_org_assignment.ex_eoa_no_overlap 用 '[]' 而非 COALESCE infinity
-- 断言（两条同时）：
--   a) constraintdef 里 grep 到 daterange(..., '[]') 且 grep 不到 infinity
--   b) 跨过闭区间边界的写入被拒 —— 03-31 结束的段与 03-31 开始的段必须相交
-- 造违规：写入 03-31 开始的新段。闭区间下被拒、表仍 1 行 → "2 行"不成立 → 红。
--         若约束误写 '[)'，它会写进去 → ② 反而绿，这就是报警。
-- 修：写入 04-01 开始的不重叠段（数据），表 2 行 → 绿。
-- 被断言对象：ex_eoa_no_overlap 的 constraintdef（三步未变）。
-- 依赖：btree_gist（employee_id 上的 = 需要 gist 支持）。
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TABLE t_f(
  employee_id int  NOT NULL,
  start_date  date NOT NULL,
  end_date    date NOT NULL,
  CONSTRAINT ex_eoa_no_overlap EXCLUDE USING gist (
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
);
INSERT INTO t_f VALUES (1,'2026-01-01','2026-03-31');

CREATE OR REPLACE FUNCTION t00.t00_def_f() RETURNS text LANGUAGE sql STABLE AS $e$
  SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
   WHERE c.conrelid = 't00.t_f'::regclass AND c.conname = 'ex_eoa_no_overlap';
$e$;

-- ① 建
SELECT t00.t00_art_rec('B-f','①建', t00.t00_def_f());
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-f','①建','ok',
    t00.t00_def_f() ~ 'daterange\([^)]*''\[\]'''
    AND t00.t00_def_f() !~* 'infinity'
    AND (SELECT count(*) FROM t00.t_f) = 1,
    'def=' || t00.t00_def_f());
END $d$;

-- ② 造违规（跨过闭区间边界）
CREATE TABLE t_f_probe(got text);
DO $d$
BEGIN
  BEGIN
    INSERT INTO t00.t_f VALUES (1,'2026-03-31','2026-05-31');
    INSERT INTO t00.t_f_probe VALUES ('accepted');
  EXCEPTION WHEN exclusion_violation THEN
    INSERT INTO t00.t_f_probe VALUES (SQLSTATE);
  END;
END $d$;
SELECT t00.t00_art_rec('B-f','②违规', t00.t00_def_f());
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-f','②违规','fail',
    (SELECT count(*) FROM t00.t_f) = 2,
    '边界写入结果: ' || (SELECT got FROM t00.t_f_probe)
      || '; 行数=' || (SELECT count(*) FROM t00.t_f)
      || '; 被拒=闭区间生效');
END $d$;

-- ③ 修复后（只改数据：改成不重叠的段）
INSERT INTO t_f VALUES (1,'2026-04-01','2026-06-30');
SELECT t00.t00_art_rec('B-f','③修复后', t00.t00_def_f());
DO $d$ BEGIN
  PERFORM t00.t00_rec('B-f','③修复后','ok',
    (SELECT count(*) FROM t00.t_f) = 2
    AND t00.t00_def_f() ~ 'daterange\([^)]*''\[\]''',
    '行数=' || (SELECT count(*) FROM t00.t_f));
END $d$;

-- ④ 阴性对照
DO $d$ BEGIN PERFORM t00.t00_rec('B-f','④阴性对照','fail',(SELECT 1=0)); END $d$;

-- ============================================================================
-- 出口
-- ============================================================================
-- 1) 每条一行，四个结果在同一行。不加总计。
--    （加总会让读者以为 24 条各自独立，而其中 6 条只证明"库能建起来"。）
SELECT fixture, four, ok FROM t00.v_t00_line ORDER BY fixture;

-- 2) 三类异常分列，须返回 0 行。分类是因为修法不同：
--    MISSING = 那一步没跑（中途死了，不是"不适用"）
--    WRONG   = 跑了但结论不对（真红）
--    DRIFT   = 修动了断言或被断言对象（该条作废，不是通过）
--    期望表写死 6×4=24 行，不动态算——动态算等于"跑到哪算哪"，中途死了也自洽。
WITH expected(fixture, step) AS (VALUES
  ('A-a','①建'),('A-a','②违规'),('A-a','③修复后'),('A-a','④阴性对照'),
  ('A-b','①建'),('A-b','②违规'),('A-b','③修复后'),('A-b','④阴性对照'),
  ('B-c','①建'),('B-c','②违规'),('B-c','③修复后'),('B-c','④阴性对照'),
  ('B-d','①建'),('B-d','②违规'),('B-d','③修复后'),('B-d','④阴性对照'),
  ('B-e','①建'),('B-e','②违规'),('B-e','③修复后'),('B-e','④阴性对照'),
  ('B-f','①建'),('B-f','②违规'),('B-f','③修复后'),('B-f','④阴性对照'),
  ('B-e-REAL','①建')
),
missing AS (
  SELECT e.fixture, e.step FROM expected e
    LEFT JOIN t00.t00_report r USING (fixture, step)
   WHERE r.fixture IS NULL
),
wrong AS (
  SELECT r.fixture, r.step, r.got, r.note FROM t00.t00_report r
   WHERE NOT ( (r.expect = 'not_applicable' AND r.got = 'not_applicable')
            OR (r.expect = 'ok'             AND r.got = 'pass')
            OR (r.expect = 'fail'           AND r.got = 'fail') )
)
SELECT 'MISSING' AS kind, fixture, step, NULL::text AS got, NULL::text AS note FROM missing
UNION ALL
SELECT 'WRONG', fixture, step, got, note FROM wrong
UNION ALL
SELECT 'DRIFT', d.fixture, d.state::text, NULL,
       'art_rows=' || d.art_rows || ' distinct=' || d.distinct_artifacts
       || coalesce(' 豁免理由: ' || d.exempt_reason, '')
  FROM t00.v_t00_art_drift d
 WHERE d.state IN ('DRIFT', 'MISSING_ART')
ORDER BY 1, 2, 3;

-- 3) 阴性对照单独显式一行，不并入上面两张表。
--    期望 false；若为 true，全表绿都不可信（说明 t00_rec 自己坏了）。
SELECT 1 = 0 AS negative_control_must_be_false;

-- 4) 错误断言分两类，别混（这是本文件唯一一处"断法不同"）：
--    系统错误   → 断 SQLSTATE 相等（42710 duplicate_object / 23P01 exclusion_violation）
--    应用 RAISE → SQLSTATE 恒为 P0001，断不出区别，必须断 MESSAGE_TEXT 含错误码 token
--    两类都把 SQLSTATE 与 MESSAGE_TEXT 原文记进 note：
--      SQLSTATE 不随 PG 版本改措辞；message 会。
