-- ============================================================================
-- 181_station_quota_carry.sql · 档口定编"定了就一直用"（读时沿用，**不回填**）
-- ----------------------------------------------------------------------------
-- 用户口径（原话，这是需求不是建议）：
--   问："门店的档口定编，是每个月都要重新确认一次，还是定了就一直用、要改的时候才动？"
--   答：**"定了就一直用"**。
--
-- 现状（181 之前）：`station_position` 是 (档口 × 岗位 × 月 × 版本) 的 append-only 表，
-- 而 172 的 `fn_station_fill_core` 取编制是**当期精确匹配**（`x.period = v_period`）：
-- 只有真配过的那几期（演示库是 2026-06 与跑脚本当天所在月）有数，切到任何别的月份，
-- 档口编就是 NULL、缺岗也是 NULL，页面上显示成"未定编"。
--
-- ★ 这里有两个错，必须同时修，只修一个会让另一个更难发现：
--   ① **该沿用的没沿用** —— 7 月明明沿用了 6 月的定编，页面说"未定编"；
--   ② **沿用了也看不出来** —— 一旦读时沿用，"忘了配的月份"和"配过的月份"在页面上
--      长得一模一样（都是"编制 5、缺岗 0"）。用户原话是"定了就一直延续"，
--      而延续的副作用正是这一条：**漏配再也看不见了**。
--      所以沿用必须带出处（`carried_from`），否则这个改动只是把 NULL 换成数字，
--      把"没配"这件事彻底藏起来 —— 那比现状更坏。
--
-- ----------------------------------------------------------------------------
-- 为什么在**函数层**沿用，不回填数据行
-- ----------------------------------------------------------------------------
-- ✗ 错法一：把 2026-06 的行克隆到 07~12 月（写 6 份 station_position）
--   ① 这张表是 append-only（`trg_sp_append_only`），一旦回填，"哪一期真的配过"
--      就**永久丢失** —— 后面没有人能分清"7 月是配的 5 个编"还是"7 月沿用了 6 月"，
--      而这两件事在考核上完全不是一回事（一个是动作，一个是没有动作）。
--   ② 回填的行有 `set_by` / `reason`，为了让它们合法，得给它们编一个"谁在什么时候
--      为什么定的编"——**编出来的出处比没有出处更坏**（它会让人以为自己查到了依据）。
--   ③ 回填是一次性的：下个月还得再来一次，也就是说"每个月都要重新确认一次"这个
--      用户明确否掉的做法，换个名字又回来了。
-- ✗ 错法二：加一列 `carried_from` 存到 station_position 上
--   它就不是"这条数据是什么"，而是"查询时怎么解读"了 —— 同一条 06 月的行，
--   在 06 月查询是 set、在 08 月查询是 carried。把查询结果落进被查的表，
--   等于让"当前这一期"这个概念进入事实表。同理否决快照表。
-- ✓ 本文件：`CREATE OR REPLACE` 两个读函数 + 重写 172/174 的三数函数，
--      `station_position` **一行不动**（验收方式就是 `count(*)` 前后不变，见 test/station.mjs ST21d）。
--
-- ----------------------------------------------------------------------------
-- 沿用的单位是"门店 × 岗位"，不是"档口 × 岗位"
-- ----------------------------------------------------------------------------
-- 这一条是写的时候差点写错、后来被 ST19 的夹具抓住的：改组（把「头灶」从炉灶档
-- 挪到打荷档）只在新档口**写一行**，旧档口那一行不会有人去删（append-only，也不该删）。
-- 于是：
--   · 按 (档口,岗位) 找"≤ 当期最近一期" → 炉灶档 头灶 沿用 06 月的 3 个编，
--     打荷档 头灶 本期又配了 3 个 → **同一个岗位在两个档口各编一份**；
--   · `trg_sp_guard` 的「同店内一个岗位只能属一个档口」只校验**同一期**，
--     跨期改组它是放行的（那是允许的），所以这一路**不会报错**，
--     只会让门店档口编合计凭空多出 3 个 —— 而那 3 个会一路算进"缺岗"。
-- 所以判定顺序是：先在本店范围内找这个岗位**最近一次**定编落在哪个档口，
-- 落在别处 → 旧档口不算沿用（返回 `moved`，让调用方知道"它搬走了"）。
--
-- ----------------------------------------------------------------------------
-- 三种状态（第四种 moved 只出现在单点查询里）
-- ----------------------------------------------------------------------------
--   set      本期真配过（station_position 里有本期行）
--   carried  本期没配，沿用自 X 期 —— 返回里带 `carried_from = X`
--   unset    从来没有配过（连可沿用的都没有）—— headcount 为 NULL，**不是 0**
--   moved    (仅单点查询) 这个岗位在本店最近一次定编不在这个档口（改组搬走了）
--            ★ 为什么单点查询要有第四态：把它压成 unset 是错的（"从来没配过"是假话），
--              压成 carried 更错（会把搬走的岗位在旧档口再编一份）。三数函数里
--              不会出现 moved —— 它按门店×岗位解析，搬走的岗位就不在旧档口那一行里了。
--
-- ★ 幂等：函数一律 `CREATE OR REPLACE`；但 `fn_station_fill*` 的**返回列变了**
--   （多四列），PostgreSQL 不允许 CREATE OR REPLACE 改返回类型，所以先
--   `DROP FUNCTION IF EXISTS` 再建 —— 这也是幂等的（重复执行结果一样）。
--   依据 docs/48 §13.6 教训一：判据是"能不能到存量库"，不是"文件神圣"。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 单点查询：这个 (档口,岗位) 在某一期**到底编几个、从哪来**
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_station_quota_effective(
  p_store_station bigint, p_position bigint, p_period varchar
) RETURNS TABLE (
  status       varchar(8),   -- set | carried | unset | moved
  headcount    int,          -- set/carried 有值；unset/moved 为 NULL（不是 0）
  period       varchar(7),   -- 这份编制**原本**是哪一期定的
  carried_from varchar(7),   -- 仅 carried：沿用自哪一期（= period）
  version      int,
  moved_to     bigint        -- 仅 moved：这个岗位现在挂在哪个档口（station.id）
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_store    bigint;
  v_station  bigint;
  v_own_ss   bigint;
  v_own_st   bigint;
  v_period   varchar(7);
  v_hc       int;
  v_ver      int;
BEGIN
  SELECT ss.store_id, ss.station_id INTO v_store, v_station
    FROM public.store_station ss WHERE ss.id = p_store_station;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'E_SP_NO_STATION: 门店档口 % 不存在', p_store_station;
  END IF;
  IF p_period IS NULL OR p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_SP_PERIOD: 期间格式必须是 YYYY-MM（收到 %）', p_period;
  END IF;

  -- ① 本店范围内，这个岗位"≤ 当期最近一次定编"落在哪里（期次可以跳空）
  SELECT x.store_station_id, x.period, x.headcount, x.version
    INTO v_own_ss, v_period, v_hc, v_ver
    FROM public.station_position x
    JOIN public.store_station s2 ON s2.id = x.store_station_id
   WHERE s2.store_id = v_store
     AND x.position_id = p_position
     AND x.period <= p_period
   ORDER BY x.period DESC, x.version DESC
   LIMIT 1;

  IF v_own_ss IS NULL THEN
    RETURN QUERY SELECT 'unset'::varchar(8), NULL::int, NULL::varchar(7),
                        NULL::varchar(7), NULL::int, NULL::bigint;
    RETURN;
  END IF;

  -- ② 落点不是这个档口 → 改组搬走了。旧档口不能沿用（否则两边各编一份）
  SELECT s2.station_id INTO v_own_st FROM public.store_station s2 WHERE s2.id = v_own_ss;
  IF v_own_st IS DISTINCT FROM v_station THEN
    RETURN QUERY SELECT 'moved'::varchar(8), NULL::int, v_period,
                        NULL::varchar(7), v_ver, v_own_st;
    RETURN;
  END IF;

  -- ③ 本期有行 → set；否则 carried（period 就是被沿用的那一期）
  IF v_period = p_period THEN
    RETURN QUERY SELECT 'set'::varchar(8), v_hc, v_period, NULL::varchar(7), v_ver, NULL::bigint;
  ELSE
    RETURN QUERY SELECT 'carried'::varchar(8), v_hc, v_period, v_period, v_ver, NULL::bigint;
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_station_quota_effective(bigint, bigint, varchar) IS
  '档口定编的**生效值**（181）：本期配了就是 set；本期没配就沿用"≤ 当期最近一期"'
  '（carried，带 carried_from）；从没配过是 unset（headcount NULL，不是 0）。'
  '★ 沿用的单位是"门店 × 岗位"：改组之后旧档口返回 moved，不能沿用 —— '
  '按档口找会双计，而双计不报错。★ 只读：不回填 station_position 一行。';

-- 按 (门店, 档口, 岗位, 期间) 查同一个问题：调用方手里通常只有 station.id，
-- 没有 store_station.id（那个 id 是"这家店这个档口的某一段区间"）。
-- ★ 它只是把参数换成 store_station.id 再转调上面那一个 —— 口径不许有第二份实现。
CREATE OR REPLACE FUNCTION fn_station_quota_effective(
  p_store bigint, p_station bigint, p_position bigint, p_period varchar
) RETURNS TABLE (
  store_station_id bigint,
  status           varchar(8),
  headcount        int,
  period           varchar(7),
  carried_from     varchar(7),
  version          int,
  moved_to         bigint
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_ss bigint;
BEGIN
  IF p_period IS NULL OR p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_SP_PERIOD: 期间格式必须是 YYYY-MM（收到 %）', p_period;
  END IF;

  -- 这一期期末仍然开着的那一段；没有就用 opened_at ≤ 期末 的最近一段
  -- （档口已经关了也要能回答"它最后一期编了几个"，而不是抛错）
  SELECT ss.id INTO v_ss
    FROM public.store_station ss
   WHERE ss.store_id = p_store AND ss.station_id = p_station
     AND ss.opened_at <= (to_date(p_period || '-01','YYYY-MM-DD')
                          + interval '1 month - 1 day')::date
   ORDER BY (daterange(ss.opened_at, ss.closed_at, '[]') @>
             (to_date(p_period || '-01','YYYY-MM-DD')
              + interval '1 month - 1 day')::date) DESC,
            ss.opened_at DESC
   LIMIT 1;
  IF v_ss IS NULL THEN
    RAISE EXCEPTION 'E_STN_NOT_FOUND: 门店 % 没有档口 %（或它在 % 之前从未开过）',
      p_store, p_station, p_period;
  END IF;

  RETURN QUERY
  SELECT v_ss, e.status, e.headcount, e.period, e.carried_from, e.version, e.moved_to
    FROM public.fn_station_quota_effective(v_ss, p_position, p_period) e;
END;
$$;

COMMENT ON FUNCTION fn_station_quota_effective(bigint, bigint, bigint, varchar) IS
  '同上，参数换成 (门店, 档口, 岗位, 期间)。★ 只是把 station.id 解析成当期那一段 '
  'store_station.id 再转调，口径只有一处实现。';

-- ---------------------------------------------------------------------------
-- 2. 三数函数：编制改成"生效值"，并把 set/carried/unset 带出来
-- ---------------------------------------------------------------------------
-- ★ 为什么必须改 fn_station_fill* 而不是"另开一个沿用接口"：
--   页面上的编制、缺岗、门店"还没分到档口"三处都从这一份结果滚出来。
--   另开一个接口就有了两条取数路径，而两条路径给的编制不同时，
--   缺岗会按其中一条算、门店未分编按另一条算 —— 同一屏两个数各自都算得通。
--   （174 已经把"口径只有一处实现"写成了这个文件的前提，沿用同一规矩。）
--
-- ★ 返回列**追加在最后**四列（不是插在中间）：`fn_station_fill_all` 是
--   `SELECT *`，插在中间会让所有按位置读列的地方静默错位。
DROP FUNCTION IF EXISTS public.fn_station_fill_core(bigint, date);
DROP FUNCTION IF EXISTS public.fn_station_fill(bigint, date);
DROP FUNCTION IF EXISTS public.fn_station_fill_all(date);

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
  station_count      int,
  -- ↓ 181 追加：三种状态分开给，不压成一个数
  quota_status         varchar(8),   -- 岗位级：set | carried | unset
  carried_from         varchar(7),   -- 岗位级：沿用自哪一期（仅 carried）
  station_quota_status varchar(8),   -- 档口级：set | carried | mixed | unset
  station_carried_from varchar(7)    -- 档口级：仅当整档口都沿用同一期才有值
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
  -- ★ "定了就一直用"（181）：每个 (门店, 岗位) 取 **≤ 当期** 的最近一期最大版本。
  --   ① 期次可以跳空（06 之后直接 11 也算）：ORDER BY period DESC 天然跳过空期；
  --   ② 分组键是 (门店, 岗位) 而**不是** (档口, 岗位)：改组之后旧档口
  --      那一行还留在库里（append-only），按档口分组会把搬走的岗位再沿用一次，
  --      同一个岗位两个档口各编一份 —— 不报错，只让合计凭空变大；
  --   ③ JOIN ss 只保留"当期仍开着"的档口：关掉的档口不参与当期任何一个数。
  sp AS (
    SELECT DISTINCT ON (ss.store_id, x.position_id)
           ss.store_id,
           x.store_station_id,
           x.position_id,
           x.headcount,
           x.period,
           x.version
      FROM public.station_position x
      JOIN ss ON ss.id = x.store_station_id
     WHERE x.period <= v_period
     ORDER BY ss.store_id, x.position_id, x.period DESC, x.version DESC
  ),
  -- 明细骨架：有生效编制的档口按岗位展开；一个岗都没有的档口给一行 position_id = NULL。
  -- ★ 后者是「未定编」这个状态能出现在页面上的唯一来源。
  spx AS (
    SELECT sp.store_station_id, sp.position_id, sp.headcount,
           true AS configured,
           CASE WHEN sp.period = v_period THEN 'set' ELSE 'carried' END::varchar(8) AS quota_status,
           CASE WHEN sp.period = v_period THEN NULL ELSE sp.period END::varchar(7) AS carried_from
      FROM sp
    UNION ALL
    SELECT ss.id, NULL::bigint, NULL::int, false,
           'unset'::varchar(8), NULL::varchar(7)
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
  -- ★ 档口人头**先单独聚合**，不要写在 st_agg 里做相关子查询（174 实测 2.6 秒）
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
           END AS quota,
           -- 档口级三态（181）。mixed = 一部分本期配了、一部分沿用（改组或逐岗调整的
           -- 过渡月）。★ 不把它压成 carried：那会在页面上写成"沿用 06 月的定编"，
           -- 而实际上有岗位是本期真配的 —— 看的人会以为整档口都没动。
           CASE WHEN NOT bool_or(spx.configured) THEN 'unset'
                WHEN bool_and(spx.quota_status = 'set') THEN 'set'
                WHEN bool_and(spx.quota_status = 'carried')
                 AND count(DISTINCT spx.carried_from) = 1 THEN 'carried'
                ELSE 'mixed' END::varchar(8) AS status,
           -- 整档口都沿用同一期时才给期次（mixed/多个出处时给 NULL，明细里逐岗看）
           CASE WHEN bool_and(spx.quota_status = 'carried')
                 AND count(DISTINCT spx.carried_from) = 1
                THEN max(spx.carried_from) END::varchar(7) AS carried_from
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
  -- ★ gap_since 先**筛出真正缺人的行**再算（174 实测：写在 LATERAL 里 60 店 3.5 秒）
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
         al.n AS station_count,
         spx.quota_status,
         spx.carried_from,
         q.status AS station_quota_status,
         q.carried_from AS station_carried_from
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
    -- 缺口行才带 gap_since（其余行是 NULL，与 172/174 的行为一致）
    LEFT JOIN gaps g ON g.store_station_id = m.store_station_id
                    AND g.position_id = spx.position_id
   ORDER BY m.store_id, m.seq, m.code, p.level, p.name;
END;
$$;

COMMENT ON FUNCTION fn_station_fill_core IS
  '档口三数的唯一实现（174；181 起编制改为**生效值**）。p_store 传 NULL = 一次算全部门店。'
  '★ 编制取"≤ 当期最近一期"（定了就一直用），并把 set / carried(+carried_from) / unset '
  '三种状态分开返回 —— 沿用必须看得出出处，否则"漏配的月份"与"配过的月份"在页面上同形。'
  '★ 单店版 fn_station_fill 与全量版 fn_station_fill_all 都是它的薄封装。';

-- ---------------------------------------------------------------------------
-- 3. 单店版 / 全量版：同样追加四列（签名变了，所以是 DROP 后重建）
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
  station_count      int,
  quota_status         varchar(8),
  carried_from         varchar(7),
  station_quota_status varchar(8),
  station_carried_from varchar(7)
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT c.store_station_id, c.station_id, c.station_code, c.station_name,
         c.line_code, c.station_seq,
         c.position_id, c.position_code, c.position_name, c.position_level,
         c.headcount, c.holders, c.gap, c.gap_since, c.days_open, c.holder_names,
         c.station_quota, c.station_slots, c.station_holders, c.station_gap,
         c.store_quota, c.store_heads, c.store_unallocated, c.station_count,
         c.quota_status, c.carried_from,
         c.station_quota_status, c.station_carried_from
    FROM public.fn_station_fill_core(p_store, p_on) c
   -- 顺序是按"店内展示顺序"排的：档口 seq → 档口编码 → 岗位级别 → 岗位名。
   -- ★ 写成显式 ORDER BY 而不是"依赖 core 的顺序"：中间隔了一层函数，
   --   顺序不是 SQL 保证，而页面上的行序是给人看的。
   ORDER BY c.station_seq, c.station_code, c.position_level, c.position_name;
$$;

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
  station_count      int,
  quota_status         varchar(8),
  carried_from         varchar(7),
  station_quota_status varchar(8),
  station_carried_from varchar(7)
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT * FROM public.fn_station_fill_core(NULL::bigint, p_on);
$$;

COMMENT ON FUNCTION fn_station_fill_all IS
  '全部门店的档口明细（174）。组织树用它一次取回，再按 store_id 聚合。'
  '181 起每行多带 quota_status / carried_from（岗位级）与 station_quota_status / '
  'station_carried_from（档口级），四列追加在最后（SELECT * 依赖列序）。';

-- ---------------------------------------------------------------------------
-- 4. 守卫口径同步：Σ档口编也必须按"生效值"算
-- ---------------------------------------------------------------------------
-- 不改这一处会出现一个**只在跨期编辑时**出现的洞：
--   7 月没配（沿用 6 月 5 个编），现在给 7 月的某个岗位调编。
--   守卫按"7 月自己的行"求和 → 只看到正在写的这一行（比如 2），
--   于是 `2 ≤ 门店编 12` 通过；可页面按生效值算出来是 5 - 旧 + 2 = 7。
--   只要门店编小一点（比如 6），这一次写入就会把 7 月顶成 7 > 6 ——
--   而写入的那一刻，守卫说"合规"，页面说"超编"。两边都不报错。
-- ★ 与 172:257-267 同一条理由（"守卫口径与页面口径必须是同一个数"），
--   只是那个坑是"关档口后算不算"，这个坑是"沿用算不算"。
CREATE OR REPLACE FUNCTION fn_store_station_quota(p_store bigint, p_period varchar)
RETURNS int
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH open_ss AS (
    -- ★ 先筛"期末还开着"的档口，再找最近一期 —— 顺序反过来（先找最近一期、再按
    --   开档状态过滤）会让"最近一期落在已关档口"的岗位**整条消失**，而
    --   fn_station_fill_core 是"没关的档口里找最近一期"（会回退到更早那一期）。
    --   两条口径一前一后差一个岗位，就是守卫放行、页面超编的那类不一致。
    SELECT ss.id, ss.store_id
      FROM public.store_station ss
     WHERE ss.store_id = p_store
       AND daterange(ss.opened_at, ss.closed_at, '[]') @>
           (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
  ),
  latest AS (
    -- 每个 (门店, 岗位) 取 ≤ 当期最近一期（与 fn_station_fill_core 的 sp 同一条规则）
    SELECT DISTINCT ON (o.store_id, x.position_id)
           o.store_id, x.store_station_id, x.position_id, x.headcount
      FROM public.station_position x
      JOIN open_ss o ON o.id = x.store_station_id
     WHERE x.period <= p_period
     ORDER BY o.store_id, x.position_id, x.period DESC, x.version DESC
  )
  SELECT COALESCE(sum(l.headcount), 0)::int FROM latest l;
$$;

COMMENT ON FUNCTION fn_store_station_quota IS
  '门店当期 Σ 档口编（岗次，181 起按生效值算）。★ 必须按 (门店,岗位) 各自取'
  '"≤ 当期最近一期"再求和：按 (档口,岗位) 取会把改组搬走的岗位在旧档口再算一次。'
  '★ 与页面（fn_station_fill 的 station_quota）必须是同一个数，否则守卫放行的写入'
  '会让页面显示超编。';

-- `fn_sp_guard` 里被替换掉的那一行：v_old 原来是"本期已有行的最大 headcount"，
-- 现在必须是"本期生效值"（含沿用）。不换的话，把沿用的编制调小时会算错：
--   allocated 里已经含了这个岗位沿用的 3，而 v_old 只查到本期 0 → 3 - 0 + 新值 → 虚高。
CREATE OR REPLACE FUNCTION fn_sp_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_store      bigint;
  v_out        boolean;
  v_pos_name   varchar(64);
  v_other      bigint;
  v_store_q    int;
  v_allocated  int;
  v_old        int;
  v_st_name    varchar(64);
BEGIN
  SELECT ss.store_id INTO v_store FROM public.store_station ss WHERE ss.id = NEW.store_station_id;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'E_SP_NO_STATION: 门店档口 % 不存在', NEW.store_station_id;
  END IF;

  SELECT p.is_outsourced, p.name INTO v_out, v_pos_name
    FROM public.position p WHERE p.id = NEW.position_id;

  -- ① 外包岗不进档口编制（外包按工时结算，混进来会让"编 3 / 到岗 3"里站着两个外包）
  IF v_out THEN
    RAISE EXCEPTION 'E_SP_OUTSOURCED: 岗位「%」是外包岗，不占内部编制（外包按工时另行统计）',
      v_pos_name;
  END IF;

  -- ② 同一家店内，一个岗位只能属于一个档口（只看**同一期**：跨期改组是允许的）
  SELECT ss2.id INTO v_other
    FROM public.station_position sp2
    JOIN public.store_station ss2 ON ss2.id = sp2.store_station_id
   WHERE ss2.store_id = v_store
     AND sp2.position_id = NEW.position_id
     AND sp2.period = NEW.period
     AND sp2.store_station_id <> NEW.store_station_id
   LIMIT 1;
  IF v_other IS NOT NULL THEN
    SELECT st.name INTO v_st_name
      FROM public.store_station ss3 JOIN public.station st ON st.id = ss3.station_id
     WHERE ss3.id = v_other;
    RAISE EXCEPTION 'E_SP_CROSS_STATION: 岗位「%」在本店 % 已属于档口「%」，'
      '同一家店内一个岗位只能属一个档口（否则到岗人数没有唯一归属）',
      v_pos_name, NEW.period, v_st_name;
  END IF;

  -- ③ Σ档口编 ≤ 门店编（门店没定编时不拦 —— 没额度就没有判据）
  v_store_q := public.fn_hc_quota(v_store, NEW.period);
  IF v_store_q IS NOT NULL THEN
    v_allocated := public.fn_store_station_quota(v_store, NEW.period);
    -- ★ 181：v_old 取**生效值**（本期已有行，或沿用自更早一期的那一份）。
    --   取"本期最大 headcount"会在沿用月里把沿用的那份漏掉，于是
    --   `allocated - 0 + 新值` 把沿用的编多算一次 —— 调小编制反而算出超编。
    SELECT COALESCE(e.headcount, 0) INTO v_old
      FROM public.fn_station_quota_effective(NEW.store_station_id, NEW.position_id, NEW.period) e;
    IF v_allocated - v_old + NEW.headcount > v_store_q THEN
      RAISE EXCEPTION 'E_SP_OVER_STORE: 门店编 % 个，档口已分 % 个，本次要 % 个（超出 %）',
        v_store_q, v_allocated - v_old, NEW.headcount,
        (v_allocated - v_old + NEW.headcount - v_store_q);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_sp_guard IS
  '档口定编的三条写入判据（172）：外包岗不占编 / 同店同期一个岗位只属一个档口 / '
  'Σ档口编 ≤ 门店编。★ 181 起 Σ 与 v_old 都按**生效值**（含沿用）算 —— '
  '否则在沿用月里调低编制会被误判成超编。';

-- ---------------------------------------------------------------------------
-- 5. 判据登记
-- ---------------------------------------------------------------------------
-- 与 172 / 174 同一写法（FUNCTION 类在 v_chk_guard_unbacked 里显示为 guard_missing，
-- 那是解析器的已知表示法限制，已在 172:875-877 登记在案）。
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ST-CARRY',
   -- ★ name 是 varchar(128)：写超了会炸在 22001，而报错里没有"是登记表那行太长"（167:485 记过）。
   '档口定编沿用：本期没配就沿用≤当期最近一期（carried 带 carried_from）；从没配过是 unset（NULL 不是 0）；'
   '沿用只在读时发生、不回填；改组搬走的岗位旧档口不沿用（否则两处各编一份且不报错）',
   'ORG','ALGORITHM','fn_station_quota_effective','public','station_position','FUNCTION',
   'team-lead','2027-09-30','node test/station.mjs','node test/station.mjs')
ON CONFLICT (check_code) DO NOTHING;
