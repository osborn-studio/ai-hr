-- ============================================================================
-- 174_station_fill_set.sql · 档口三数一次算全部门店（172 的性能）
-- ----------------------------------------------------------------------------
-- 现场：60 店 / 374 人的库上，`/api/org/tree` 要 **11.4 秒**（13.7KB 的响应）。
-- 10 店时是秒开 —— 这说明它不是"某个查询慢"，是 **O(门店数) × 每店一次** 的累加。
--
-- 分段实测（同一台机、同一个库、每段 3 次取最好）：
--
--   递归树 + 基础列                                1 ms
--   + headcount 直属（逐节点子查询）                34 ms
--   + subtree 含下级（逐节点 LIKE 全表）          1786 ms   ← 也是逐节点算
--   逐店调 fn_station_fill（60 次）              8337 ms   ← 主凶
--   整条 tree（现状 SQL，一次执行）               3448 ms
--
-- 两处都是"每个节点各算一遍"，而它们算的东西**本来就该一次算完**：
-- 60 家店的档口明细不是 60 个互不相干的问题，是同一张表按 store_id 分组的
-- 同一个问题。所以：
--
--   ① 本文件把 fn_station_fill 的**函数体**改写成"一次算全部门店"，
--      并拆成三件：
--        fn_station_fill_core(store, on)  —— 唯一的实现，store 传 NULL = 全部门店
--        fn_station_fill(store, on)       —— 单店（**签名与返回列一个没变**，只是变薄）
--        fn_station_fill_all(on)          —— 全部门店，多一列 store_id
--      ★ 为什么单店版不另写一份：口径只有一处实现，是 172 全部判据的前提。
--        两个函数各写一份"看起来一样"的 join，迟早有一天不一样 ——
--        而不一样的那天，页面上两个数各自都算得通。
--   ② 组织树的 subtree 改成"先按 org 聚合、再沿 path 滚"，与档口无关，但它
--      占了剩下那一半时间（见 175_subtree_rollup.sql 的说明——本文件只动档口）。
--
-- ★ 值必须逐字节不变：本文件只改**计算路径**，不改任何聚合口径。
--   验收方式是"优化前后把同一份 /api/org/tree 响应存下来 diff"，
--   加 `test/station.mjs` 的 ST15（单店切片 == 全量切片，逐列比）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 唯一实现：一次算全部门店（p_store 传 NULL 就是全部）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_station_fill_core(p_store bigint, p_on date)
RETURNS TABLE (
  store_id           bigint,
  store_station_id   bigint,
  station_id         bigint,
  station_code       varchar,
  station_name       varchar,
  line_code          varchar,
  station_seq        int,
  position_id        bigint,
  position_code      varchar,
  position_name      varchar,
  position_level     smallint,
  headcount          int,
  holders            int,
  gap                int,
  gap_since          date,
  days_open          int,
  holder_names       text,
  station_quota      int,
  station_slots      int,
  station_holders    int,
  station_gap        int,
  store_quota        int,
  store_heads        int,
  store_unallocated  int,
  station_count      int
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_on     date        := COALESCE(p_on, public.app_today());
  v_period varchar(7)  := to_char(COALESCE(p_on, public.app_today()), 'YYYY-MM');
BEGIN
  RETURN QUERY
  WITH ss AS (
    -- 当期有效的档口（区间语义：关了再开的两个实例各归各的期间）。
    -- ★ 这一句是本文件唯一"多出来"的东西：p_store 可空，空则全部门店。
    SELECT s.id, s.store_id, s.station_id, s.seq AS ss_seq
      FROM public.store_station s
     WHERE (p_store IS NULL OR s.store_id = p_store)
       AND daterange(s.opened_at, s.closed_at, '[]') @> v_on
  ),
  -- 兼职口径是**按门店**解析的（policy 可被区域覆盖），所以不能提到循环外。
  -- 60 次 fn_policy_effective 是几毫秒的量级，比它带来的"口径按店正确"便宜。
  part AS (
    SELECT DISTINCT ss.store_id,
           COALESCE((SELECT v.value_text
                       FROM public.fn_policy_effective('HC_STATION_PARTTIME', ss.store_id, v_on) v),
                    'occupy')::varchar(16) AS mode
      FROM ss
  ),
  meta AS (
    SELECT ss.id AS store_station_id, ss.store_id, st.id AS station_id, st.code, st.name,
           st.line_code, COALESCE(ss.ss_seq, st.seq) AS seq
      FROM ss JOIN public.station st ON st.id = ss.station_id
  ),
  -- 当期编制：每个 (档口,岗位) 取该期最大版本（版本语义只有这一处实现）
  sp AS (
    SELECT DISTINCT ON (x.store_station_id, x.position_id)
           x.store_station_id, x.position_id, x.headcount
      FROM public.station_position x
      JOIN ss ON ss.id = x.store_station_id
     WHERE x.period = v_period
     ORDER BY x.store_station_id, x.position_id, x.version DESC
  ),
  -- 明细骨架：有定编的档口按岗位展开；一个岗都没定编的档口给一行 position_id = NULL。
  -- ★ 后者是「未定编」这个状态能出现在页面上的唯一来源。
  spx AS (
    SELECT sp.store_station_id, sp.position_id, sp.headcount, true AS configured
      FROM sp
    UNION ALL
    SELECT ss.id, NULL::bigint, NULL::int, false
      FROM ss
     WHERE NOT EXISTS (SELECT 1 FROM sp WHERE sp.store_station_id = ss.id)
  ),
  -- 到岗的人（人级，后面按岗位 / 档口 / 门店三级滚）
  fillp AS (
    SELECT DISTINCT spx.store_station_id, spx.position_id, pp.person_id, pe.full_name, ss.store_id
      FROM spx
      JOIN ss ON ss.id = spx.store_station_id
      JOIN public.person_position pp ON pp.position_id = spx.position_id
                                    AND daterange(pp.valid_from, pp.valid_to, '[]') @> v_on
      JOIN public.employment e ON e.person_id = pp.person_id
                              AND daterange(e.hire_date, e.leave_date, '[]') @> v_on
      JOIN public.employee_org_assignment a ON a.employee_id = pp.person_id
                                           AND a.dim_code = 'cost_org'
                                           AND daterange(a.valid_from, a.valid_to, '[]') @> v_on
                                            -- ★ 等值，不用 path LIKE：跨店支援天天发生，
                                            --   LIKE 会把"人在这家店、成本在那家店"的支援人员串进来
                                           AND a.org_id = ss.store_id
      JOIN public.person pe ON pe.id = pp.person_id
      JOIN part pt ON pt.store_id = ss.store_id
     WHERE spx.configured
       -- 兼职排除口径（policy）：只在显式选了 exclude 时才生效
       AND (pt.mode <> 'exclude'
            OR public.fn_pay_basis(pp.person_id, v_period) <> 'hour')
  ),
  fill AS (
    SELECT f.store_station_id, f.position_id,
           count(DISTINCT f.person_id)::int AS holders,
           string_agg(DISTINCT f.full_name, '、') AS names
      FROM fillp f
     GROUP BY 1, 2
  ),
  -- ★ 档口人头**先单独聚合**，不要写在 st_agg 里做相关子查询。
  --   原来那一版是 `(SELECT count(DISTINCT f2.person_id) FROM fillp f2 WHERE …)`，
  --   单店调用时它只跑几次（155ms，看不出来）；一次算 60 家店时，
  --   CTE 被内联进相关子查询 → 每个档口重算一遍 fillp，2.6 秒全耗在这里。
  --   这类"单店没事、多店爆炸"的写法是本文件存在的理由，改的时候别再写回相关子查询。
  st_heads AS (
    SELECT f.store_station_id, count(DISTINCT f.person_id)::int AS heads
      FROM fillp f
     GROUP BY f.store_station_id
  ),
  st_agg AS (
    -- 档口到岗：岗次 = Σ 各岗位人数；人头 = 档口内去重（一人两岗只算一次）
    SELECT spx.store_station_id,
           sum(CASE WHEN spx.configured THEN COALESCE(f.holders, 0) ELSE 0 END)::int AS slots
      FROM spx
      LEFT JOIN fill f ON f.store_station_id = spx.store_station_id
                      AND f.position_id = spx.position_id
     GROUP BY spx.store_station_id
  ),
  st_q AS (
    SELECT spx.store_station_id,
           CASE WHEN bool_or(spx.configured)
                THEN COALESCE(sum(spx.headcount) FILTER (WHERE spx.configured), 0)::int
           END AS quota
      FROM spx
     GROUP BY spx.store_station_id
  ),
  -- 以下三张全部改成**按门店分组**（原来是一家店一个标量，现在是一批店一批行）
  store_q AS (
    SELECT DISTINCT ss.store_id, public.fn_hc_quota(ss.store_id, v_period) AS quota
      FROM ss
  ),
  -- 门店到岗（人头）。与档口到岗同一个维度（cost_org）、同一个在职判定 ——
  -- 否则"门店 10 人 / 档口 11 岗次"里那 1 个差会被读成算错。
  -- ★ 这与 /api/org/tree 的"在编"不是一个问题：那边按 attendance_org
  --   （谁在这家店打卡），这边按 cost_org（人算在哪家店的成本）。
  store_heads AS (
    SELECT a.org_id AS store_id, count(DISTINCT a.employee_id)::int AS n
      FROM public.employee_org_assignment a
      JOIN public.employment e ON e.person_id = a.employee_id
                              AND daterange(e.hire_date, e.leave_date, '[]') @> v_on
      JOIN part pt ON pt.store_id = a.org_id
     WHERE a.dim_code = 'cost_org'
       AND daterange(a.valid_from, a.valid_to, '[]') @> v_on
       AND (pt.mode <> 'exclude'
            OR public.fn_pay_basis(a.employee_id, v_period) <> 'hour')
     GROUP BY a.org_id
  ),
  alloc AS (
    SELECT ss.store_id,
           COALESCE(sum(q.quota), 0)::int AS allocated,
           count(*)::int AS n
      FROM st_q q JOIN ss ON ss.id = q.store_station_id
     GROUP BY ss.store_id
  ),
  -- ★ gap_since 先**筛出真正缺人的行**再算，不要写成 `LEFT JOIN LATERAL (… ) ON true`
  --   里面带 WHERE：那个写法在单店调用时只多跑几次（155ms 里看不出来），
  --   一次算 60 家店时函数被逐行求值 261 次 → 3.5 秒，占整条查询的 98%。
  --   实测：把这一段摘掉，3.58s → 0.09s。缺口行只有 14 个，14 次调用是 0.18s。
  gaps AS (
    SELECT m.store_station_id, spx.position_id,
           public.fn_sp_gap_since(m.store_station_id, spx.position_id, v_on) AS since
      FROM meta m
      JOIN spx ON spx.store_station_id = m.store_station_id
      LEFT JOIN fill f ON f.store_station_id = spx.store_station_id
                      AND f.position_id = spx.position_id
     WHERE spx.configured
       AND spx.headcount - COALESCE(f.holders, 0) > 0
  )
  SELECT m.store_id,
         m.store_station_id, m.station_id, m.code, m.name, m.line_code, m.seq,
         spx.position_id, p.code, p.name, p.level,
         spx.headcount,
         COALESCE(f.holders, 0)::int AS holders,
         CASE WHEN spx.configured THEN spx.headcount - COALESCE(f.holders, 0) END AS gap,
         g.since AS gap_since,
         CASE WHEN g.since IS NOT NULL THEN v_on - g.since END AS days_open,
         f.names,
         q.quota AS station_quota,
         COALESCE(a.slots, 0)::int AS station_slots,
         COALESCE(ah.heads, 0)::int AS station_holders,
         CASE WHEN q.quota IS NOT NULL THEN q.quota - COALESCE(a.slots, 0) END AS station_gap,
         sq.quota AS store_quota,
         sh.n AS store_heads,
         CASE WHEN sq.quota IS NOT NULL THEN sq.quota - al.allocated END AS store_unallocated,
         al.n AS station_count
    FROM meta m
    JOIN spx ON spx.store_station_id = m.store_station_id
    LEFT JOIN public.position p ON p.id = spx.position_id
    LEFT JOIN fill f ON f.store_station_id = spx.store_station_id
                    AND f.position_id = spx.position_id
    LEFT JOIN st_agg a ON a.store_station_id = m.store_station_id
    LEFT JOIN st_heads ah ON ah.store_station_id = m.store_station_id
    LEFT JOIN st_q q ON q.store_station_id = m.store_station_id
    LEFT JOIN store_q sq ON sq.store_id = m.store_id
    LEFT JOIN store_heads sh ON sh.store_id = m.store_id
    LEFT JOIN alloc al ON al.store_id = m.store_id
    -- 缺口行才带 gap_since（其余行是 NULL，与 172 的行为一致）
    LEFT JOIN gaps g ON g.store_station_id = m.store_station_id
                    AND g.position_id = spx.position_id
   ORDER BY m.store_id, m.seq, m.code, p.level, p.name;
END;
$$;

COMMENT ON FUNCTION fn_station_fill_core IS
  '档口三数的唯一实现（174）。p_store 传 NULL = 一次算全部门店（多一列 store_id）。'
  '★ 单店版 fn_station_fill 与全量版 fn_station_fill_all 都是它的薄封装 —— '
  '口径只有这一处，两个入口不可能算出两个数。';

-- ---------------------------------------------------------------------------
-- 2. 单店版：签名与返回列**一个都没变**，只是变薄
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_station_fill(p_store bigint, p_on date DEFAULT NULL)
RETURNS TABLE (
  store_station_id   bigint,
  station_id         bigint,
  station_code       varchar,
  station_name       varchar,
  line_code          varchar,
  station_seq        int,
  position_id        bigint,
  position_code      varchar,
  position_name      varchar,
  position_level     smallint,
  headcount          int,
  holders            int,
  gap                int,
  gap_since          date,
  days_open          int,
  holder_names       text,
  station_quota      int,
  station_slots      int,
  station_holders    int,
  station_gap        int,
  store_quota        int,
  store_heads        int,
  store_unallocated  int,
  station_count      int
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT c.store_station_id, c.station_id, c.station_code, c.station_name,
         c.line_code, c.station_seq,
         c.position_id, c.position_code, c.position_name, c.position_level,
         c.headcount, c.holders, c.gap, c.gap_since, c.days_open, c.holder_names,
         c.station_quota, c.station_slots, c.station_holders, c.station_gap,
         c.store_quota, c.store_heads, c.store_unallocated, c.station_count
    FROM public.fn_station_fill_core(p_store, p_on) c
   -- 顺序是按"店内展示顺序"排的：档口 seq → 档口编码 → 岗位级别 → 岗位名。
   -- ★ 写成显式 ORDER BY 而不是"依赖 core 的顺序"：中间隔了一层函数，
   --   顺序不是 SQL 保证，而页面上的行序是给人看的。
   ORDER BY c.station_seq, c.station_code, c.position_level, c.position_name;
$$;

-- ---------------------------------------------------------------------------
-- 3. 全量版：组织树用这一条，一次拿回全部门店
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_station_fill_all(p_on date DEFAULT NULL)
RETURNS TABLE (
  store_id           bigint,
  store_station_id   bigint,
  station_id         bigint,
  station_code       varchar,
  station_name       varchar,
  line_code          varchar,
  station_seq        int,
  position_id        bigint,
  position_code      varchar,
  position_name      varchar,
  position_level     smallint,
  headcount          int,
  holders            int,
  gap                int,
  gap_since          date,
  days_open          int,
  holder_names       text,
  station_quota      int,
  station_slots      int,
  station_holders    int,
  station_gap        int,
  store_quota        int,
  store_heads        int,
  store_unallocated  int,
  station_count      int
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT * FROM public.fn_station_fill_core(NULL::bigint, p_on);
$$;

COMMENT ON FUNCTION fn_station_fill_all IS
  '全部门店的档口明细（174）。组织树用它一次取回，再按 store_id 聚合 —— '
  '原来是对 60 个门店各调一次 fn_station_fill，光这一项 8.3 秒。'
  '★ 聚合规则必须与"逐店调用再相加"完全一致：station_gap 在**没有档口**时是 NULL（不是 0），'
  '这一点由 test/station.mjs 的 ST12a/ST12b 两面钉住。';
