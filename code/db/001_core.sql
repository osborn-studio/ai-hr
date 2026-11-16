-- ============================================================================
-- 001_core.sql · 权限求值核心（T01.0 依赖占位 + T01.2 三轴求值的数据库层）
-- ----------------------------------------------------------------------------
-- 目标数据库：PostgreSQL 16（设计基准）。开发期用 PGlite = PostgreSQL 18.6 WASM。
-- 执行：见 code/test/run.mjs（一条命令建库 + 跑断言）。
--
-- 本文件是 04_技术架构与MCP设计.md 的可执行子集：
--   表   sys_perm_dim / sys_perm_resource / sys_data_scope / sys_data_scope_rule
--        sys_user_role / sys_permission_deny / org_unit
--   函数 app_init_session() / app_begin_scope()
--
-- 与文档的两处差异，都是「文档写不出来、跑一次才发现」的：
--   ① 文档的 app_begin_scope 结尾写作 `END $$ LANGUAGE plpgsql;`，
--      而 LANGUAGE 在 AS $$ 之前已声明 → 42601 conflicting or redundant options，
--      函数按原文建不出来。已改为 `END;` + `$$;`。
--   ② 文档只写了 app_begin_scope 里 TRUNCATE 四张临时表，
--      没写这四张表由谁创建。TRUNCATE 一个不存在的表在运行时才炸，
--      而那时连接已经建立、请求已经进入 → 表现为「一上线就全炸」。
--      补 app_init_session()，由连接取用时调用。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. 会话初始化：建四张临时表（幂等）
-- ---------------------------------------------------------------------------
-- ★ 建临时表**不写 pg_temp. 前缀**（真 PG 16 上会报 schema "pg_temp" does not exist）：
--   临时 schema 的别名是在「本会话第一次建临时对象」之后才存在的，
--   而 `CREATE TEMP TABLE pg_temp.x` 正好是那第一次 —— 于是它自己把别名用在了
--   别名还没存在的时候。写裸表名即可，PostgreSQL 会自动落到本会话的临时 schema；
--   之后所有 `pg_temp.tmp_scope_*` 的引用都成立。
--   这条差异是**真 PG 才会暴露**的：PGlite（18.6）上 pg_temp 前缀能建，一直没红。
--
-- ★ 为什么用 IF NOT EXISTS 而不是「在迁移里建一次」：
--   临时表是会话级的，迁移那个会话结束后就没了。任何「在迁移脚本里建 TEMP TABLE」
--   的写法，在下一个连接上都不存在，而函数里只有 TRUNCATE —— 症状是首个请求报
--   `relation "pg_temp.tmp_scope_org" does not exist`，看起来像权限问题。
CREATE OR REPLACE FUNCTION app_init_session() RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS tmp_scope_org (
    dim_code varchar(24) NOT NULL,
    org_id   bigint      NOT NULL
  ) ON COMMIT PRESERVE ROWS;

  CREATE TEMP TABLE IF NOT EXISTS tmp_scope_entity (
    dim_code  varchar(24) NOT NULL,
    entity_id bigint      NOT NULL
  ) ON COMMIT PRESERVE ROWS;

  CREATE TEMP TABLE IF NOT EXISTS tmp_scope_emp (
    dim_code varchar(24) NOT NULL,
    emp_id   bigint      NOT NULL
  ) ON COMMIT PRESERVE ROWS;

  CREATE TEMP TABLE IF NOT EXISTS tmp_scope_deny (
    dim_code  varchar(24) NOT NULL,
    org_id    bigint,
    entity_id bigint,
    emp_id    bigint,
    CONSTRAINT ck_tsd_one CHECK (num_nonnulls(org_id, entity_id, emp_id) = 1)
  ) ON COMMIT PRESERVE ROWS;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. 维度词表：kind 是分支依据，不是标签
-- ---------------------------------------------------------------------------
CREATE TABLE sys_perm_dim (
  code      varchar(24) PRIMARY KEY,
  kind      varchar(8)  NOT NULL,
  label     varchar(64) NOT NULL,
  is_active boolean     NOT NULL DEFAULT true,
  -- ★ 值域用 CHECK 只是兜底；真正的守卫在 app_begin_scope 开头：
  --   任何 kind 越界都要 RAISE，不能靠 CASE ... ELSE 静默落进某条分支。
  CONSTRAINT ck_spd_kind CHECK (kind IN ('org', 'entity', 'person'))
);

COMMENT ON COLUMN sys_perm_dim.kind IS
  '分支依据。新增 kind 必须同时改 app_begin_scope 的分支，否则函数开头的守卫会 RAISE。';

-- ---------------------------------------------------------------------------
-- 2. 资源登记：未登记 = 拒绝（默认放行是权限系统唯一不可接受的默认值）
-- ---------------------------------------------------------------------------
CREATE TABLE sys_perm_resource (
  resource_code  varchar(64) PRIMARY KEY,
  label          varchar(128) NOT NULL,
  temporal_basis varchar(16)  NOT NULL DEFAULT 'CURRENT',
  is_active      boolean      NOT NULL DEFAULT true,
  CONSTRAINT ck_spr_temporal CHECK (temporal_basis IN ('CURRENT', 'FACT_SNAPSHOT'))
);

COMMENT ON COLUMN sys_perm_resource.temporal_basis IS
  'FACT_SNAPSHOT 的资源必须显式传 p_fact_from；不传抛 E_FACT_DATE_REQUIRED，不许静默按当前判定。';

-- ---------------------------------------------------------------------------
-- 3. 具名范围 + 范围内的维度规则
-- ---------------------------------------------------------------------------
CREATE TABLE sys_data_scope (
  id         bigint PRIMARY KEY,
  name       varchar(64) NOT NULL,
  -- ★ combinator 按 scope 配，不按维度配。
  --   同一 scope 内混用会在 SQL 里变成 A AND B OR C → 一个 union 维度吞掉整段条件。
  combinator varchar(16) NOT NULL DEFAULT 'intersection',
  CONSTRAINT ck_sds_comb CHECK (combinator IN ('intersection', 'union'))
);

CREATE TABLE sys_data_scope_rule (
  data_scope_id bigint      NOT NULL REFERENCES sys_data_scope(id) ON DELETE CASCADE,
  dimension     varchar(24) NOT NULL REFERENCES sys_perm_dim(code),
  value_type    varchar(16) NOT NULL,
  value_ids     bigint[],
  PRIMARY KEY (data_scope_id, dimension),
  CONSTRAINT ck_sdsr_vtype CHECK (value_type IN
    ('all', 'none', 'self', 'person', 'node_subtree', 'nodes'))
);

-- ---------------------------------------------------------------------------
-- 4. 组织（本文件只建最小列，完整定义见 04 §3.2）
-- ---------------------------------------------------------------------------
CREATE TABLE org_unit (
  id        bigint PRIMARY KEY,
  parent_id bigint REFERENCES org_unit(id),
  name      varchar(64) NOT NULL,
  -- ★ path 用 text 且以 '.' 分段，供 node_subtree 的 LIKE 前缀匹配。
  --   用 ltgt/闭包表的写法在这里不必要：组织树深度个位数，LIKE 足够且可索引。
  path      text NOT NULL
);
CREATE INDEX ix_org_path ON org_unit(path text_pattern_ops);

-- ---------------------------------------------------------------------------
-- 5. 授权（第三张时态表）：时间性只有一套
-- ---------------------------------------------------------------------------
CREATE TABLE sys_user_role (
  id             bigint PRIMARY KEY,
  user_id        bigint NOT NULL,
  role_id        bigint NOT NULL,
  data_scope_id  bigint NOT NULL REFERENCES sys_data_scope(id),
  perm_version   int    NOT NULL DEFAULT 1,
  granted_by     bigint,
  granted_at     timestamptz,
  grant_kind     varchar(24) NOT NULL DEFAULT 'ROLE',
  readonly_only  boolean     NOT NULL DEFAULT false,
  grant_reason   varchar(500),
  effective_from date    NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,                       -- ★ 右开：这是「失效的第一天」，NULL = 至今
  superseded_by  bigint,
  CONSTRAINT ck_ur_span_nonempty
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- 值域：显式列出。缺这一条时，拼错的 grant_kind 会落进下面那条的「无匹配」而通过。
  CONSTRAINT ck_ur_kind_known
    CHECK (grant_kind IN ('ROLE', 'HANDOVER_READONLY', 'TEMP_ACT_AS')),
  -- ★ 受限授权的上限。全析取，不用 CASE ... ELSE：
  --   CHECK 里 NULL 是通过，ELSE true 会让下一个新 kind 静默无上限。
  --   7 / 90 写死不做参数：参数可改 = 给历史授权发赦免。
  CONSTRAINT ck_ur_kind_span CHECK (
        (grant_kind = 'ROLE')
     OR (grant_kind = 'TEMP_ACT_AS'
         AND effective_to IS NOT NULL AND effective_to <= effective_from + 7)
     OR (grant_kind = 'HANDOVER_READONLY'
         AND effective_to IS NOT NULL AND effective_to <= effective_from + 90)
  )
);

-- 同一 (user, role, scope, kind) 不得区间重叠；历史行不删，靠部分谓词排除
ALTER TABLE sys_user_role ADD CONSTRAINT ex_ur_no_overlap
  EXCLUDE USING gist (
    user_id       WITH =,
    role_id       WITH =,
    data_scope_id WITH =,
    grant_kind    WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  ) WHERE (superseded_by IS NULL);

-- ---------------------------------------------------------------------------
-- 6. deny：独立集合，压过一切 allow
-- ---------------------------------------------------------------------------
CREATE TABLE sys_permission_deny (
  id         bigint PRIMARY KEY,
  role_id    bigint NOT NULL,
  dimension  varchar(24) NOT NULL REFERENCES sys_perm_dim(code),
  value_ids  bigint[] NOT NULL,
  field_path varchar(64),          -- NULL = 行级；非空 = 字段级，由 resolve_field_policy 另判
  revoked_at timestamptz
);

COMMENT ON TABLE sys_permission_deny IS
  'deny 与 allow 必须同源（都从 p_user 派生）。任何「由调用方提供角色集合」的写法，等于把最严的约束交给最松的输入。';

-- ---------------------------------------------------------------------------
-- 7. 入口函数（唯一实现）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_begin_scope(
  p_user     bigint,
  p_resource varchar,
  p_fact_from date                 -- ★ 无默认值：断言要求 pronargdefaults = 0
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''               -- 空，不是 pg_catalog, public；因此 temp 表一律写 pg_temp.
AS $$
DECLARE v_temporal varchar(16); v_as_of date; v_unsupported text; r record;
BEGIN
  TRUNCATE pg_temp.tmp_scope_org;   TRUNCATE pg_temp.tmp_scope_entity;
  TRUNCATE pg_temp.tmp_scope_emp;   TRUNCATE pg_temp.tmp_scope_deny;

  SELECT temporal_basis INTO v_temporal FROM public.sys_perm_resource
   WHERE resource_code = p_resource AND is_active;
  IF v_temporal IS NULL THEN
    RAISE EXCEPTION 'E_RESOURCE_UNREGISTERED: 资源 % 未在 sys_perm_resource 登记', p_resource;
  END IF;
  IF v_temporal = 'FACT_SNAPSHOT' AND p_fact_from IS NULL THEN
    RAISE EXCEPTION 'E_FACT_DATE_REQUIRED: 资源 % 按事实时点判定，必须传 p_fact_from', p_resource;
  END IF;
  v_as_of := COALESCE(p_fact_from, current_date);

  -- 维度支持性守卫：kind 越界必须炸，不许静默落进某条分支
  SELECT string_agg(DISTINCT d.code, ',') INTO v_unsupported
    FROM public.sys_perm_dim d
   WHERE d.kind NOT IN ('org','entity','person');
  IF v_unsupported IS NOT NULL THEN
    RAISE EXCEPTION 'E_PERM_DIM_UNSUPPORTED: 维度 % 的 kind 无对应分支', v_unsupported;
  END IF;

  -- ① allow 面：按 kind 分支（不按 dimension 字面量 → 新增维度不用改函数）
  -- ★ 读的是「有效权限」而不是「直接授权」：组织继承也在内（见 020）。
  --   这一层如果仍直接读 sys_user_role，组织授权就只是登记了一条记录，
  --   而不会真的改变任何一次查询的结果——那种"接了线但没通电"最难发现。
  FOR r IN
    SELECT * FROM public.fn_scope_rules(p_user, v_as_of)
  LOOP
    IF r.kind = 'entity' THEN
      INSERT INTO pg_temp.tmp_scope_entity(dim_code, entity_id)
      SELECT r.dimension, x FROM unnest(r.value_ids) x;
    ELSIF r.kind = 'org' THEN
      IF r.value_type = 'node_subtree' THEN
        INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
        SELECT r.dimension, o.id FROM public.org_unit o
         WHERE EXISTS (SELECT 1 FROM public.org_unit p
                        WHERE p.id = ANY(r.value_ids) AND o.path LIKE p.path || '%');
      ELSE
        INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
        SELECT r.dimension, x FROM unnest(r.value_ids) x;
      END IF;
    ELSIF r.kind = 'person' THEN
      INSERT INTO pg_temp.tmp_scope_emp(dim_code, emp_id)
      SELECT r.dimension, x FROM unnest(r.value_ids) x;
    ELSE
      RAISE EXCEPTION 'E_PERM_DIM_UNSUPPORTED: 维度 % kind=%', r.dimension, r.kind;
    END IF;
  END LOOP;

  -- ② deny 面：与 allow 面同源，五个 kind 全覆盖
  INSERT INTO pg_temp.tmp_scope_deny(dim_code, org_id, entity_id, emp_id)
  SELECT d.dimension,
         CASE dm.kind WHEN 'org'    THEN x END,
         CASE dm.kind WHEN 'entity' THEN x END,
         CASE dm.kind WHEN 'person' THEN x END
    FROM public.sys_permission_deny d
    JOIN public.fn_deny_roles(p_user, v_as_of) ur ON ur.role_id = d.role_id
    JOIN public.sys_perm_dim  dm ON dm.code   = d.dimension
    CROSS JOIN LATERAL unnest(d.value_ids) x
   WHERE d.field_path IS NULL
     AND d.revoked_at IS NULL;
END;
$$;
