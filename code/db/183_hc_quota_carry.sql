-- ============================================================================
-- 183_hc_quota_carry.sql · 门店编（组织编制）"定了就一直用"，但**必须标出来**
-- ----------------------------------------------------------------------------
-- 用户口径（原话，先后两次，这是需求不是建议）：
--   ① 档口定编："定了就一直用，要改的时候才动"        → 181（已做）
--   ② 门店编："**也沿用，但要标出来**"                → 本文件
--
-- 为什么这条比 181 危险得多：
--   `fn_hc_quota` 不是展示字段。它进 `fn_hc_allocated`（已下分）、`fn_hc_available`
--   （可下分）、`fn_hc_hireable`（可招）、`fn_hc_over`（超编）、`fn_hc_uncovered`
--   （未覆盖）、`fn_hc_slack`（余量），还进编制下达与招聘校验。
--   181 改的是"档口这一层"，本文件改的是**所有层**：一个算错，全公司每个数都错。
--
-- ★ 所以这次的安全阀是**状态字段**，不是沿用本身
--   沿用一旦生效，"这一期根本没定编"这件事就再也无法从数字上看出来 ——
--   页面上它和"定过编、数与上期相同"长得一模一样。因此：
--     · `fn_hc_quota_effective` 必须把 set / carried / unset 与 `carried_from` 交出来；
--     · 显示层（/api/org/tree、/api/headcount）必须把它们带出去；
--     · **谁把状态字段从响应里删掉，这个改动就变成了"静默把上期预算当成这期预算"**
--       —— 那是错的方向，比不改更坏。
--
-- ★ 与 181 同一条规矩：沿用发生在**读时**，`headcount_budget` 一行不动
--   回填会把"哪一期真的定过编"永久抹掉（这张表是 append-only 的版本表，
--   回填等于给每一期编一个"谁在什么时候为什么定的"——**编出来的出处比没有出处更坏**）。
--
-- ★ 一条必须守住的边界：**从来没有定过 → 仍是 NULL**
--   沿用只在"该节点有过更早一期的编制"时发生。若某个节点（例如新开的店）
--   从来没定过编，必须保持 `unset` + quota NULL，**不能因为上级/兄弟节点有数就变成某个值**。
--   否则"没预算"这件事会被永久掩盖，而这正是 022 全篇在防的那类"看起来正常"。
--
-- ★ 一个必须说清的行为变化（有意为之，不是副作用）
--   编制下达与招聘校验从此对"未来月份"有数了：7 月没定编时，可招 = 沿用 6 月的额度 − 已下分 − 直属已占。
--   这是"定了就一直用"的直接后果。**但它也意味着"这月没批预算"不再自动等于"招不了人"** ——
--   所以上面那个状态字段是这段语义的唯一出口，页面必须显示"沿用 2026-06"。
--
-- 实现顺序（一处实现，下游跟着走）：
--   fn_hc_quota_effective  ← 唯一实现（set/carried/unset + carried_from）
--   fn_hc_quota           ← 改成读它（签名与返回类型不变，仍 int）
--   fn_hc_allocated / available / hireable / over / uncovered / slack  **一行不改**
--
-- 幂等：CREATE OR REPLACE 两个函数；不建表、不加列、不动数据。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 唯一实现：某节点某期的**生效编制** + 它是哪来的
-- ---------------------------------------------------------------------------
-- 三态：
--   set      本期有 headcount_budget 行（取版本号最大的那条，与 022 一致）
--   carried  本期没有，沿用 < 本期的**最近一期**（同期间仍取最大版本）
--   unset    从来没有过 —— quota 为 NULL，**不是 0**
CREATE OR REPLACE FUNCTION public.fn_hc_quota_effective(p_org bigint, p_period varchar)
RETURNS TABLE (status varchar, quota int, period varchar, carried_from varchar)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN c.period IS NOT NULL THEN 'set'
              WHEN p.period IS NOT NULL THEN 'carried'
              ELSE 'unset' END::varchar AS status,
         COALESCE(c.quota, p.quota)::int  AS quota,
         COALESCE(c.period, p.period)::varchar AS period,
         (CASE WHEN c.period IS NULL THEN p.period END)::varchar AS carried_from
    FROM (SELECT 1) dummy
    LEFT JOIN LATERAL (
      SELECT b.period, b.quota
        FROM public.headcount_budget b
       WHERE b.org_id = p_org AND b.period = p_period
       ORDER BY b.version DESC
       LIMIT 1) c ON true
    LEFT JOIN LATERAL (
      SELECT b.period, b.quota
        FROM public.headcount_budget b
       WHERE b.org_id = p_org AND b.period < p_period
       ORDER BY b.period DESC, b.version DESC
       LIMIT 1) p ON true;
$$;

COMMENT ON FUNCTION public.fn_hc_quota_effective IS
  '某节点某期的生效编制 + 出处：status=set(本期定过)/carried(沿用 carried_from 期)/unset(从未定过，quota 为 NULL 而不是 0)。'
  '★ 183 起这是编制沿用的唯一实现；fn_hc_quota 只是它的 quota 列。'
  '★ 状态字段不是装饰：沿用以后"这期没定编"只能从 status 看出来，删掉它就等于把上期预算静默当成本期预算。';

-- ---------------------------------------------------------------------------
-- 2. fn_hc_quota 改成读它（签名、返回类型、版本语义全部不变）
-- ---------------------------------------------------------------------------
-- 下游一个都不改：allocated / available / hireable / over / uncovered / slack
-- 都通过它取额度，因此自动与"沿用"一致 —— 这正是"一处实现"的价值。
CREATE OR REPLACE FUNCTION public.fn_hc_quota(p_org bigint, p_period varchar)
RETURNS int
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT e.quota FROM public.fn_hc_quota_effective(p_org, p_period) e;
$$;

COMMENT ON FUNCTION public.fn_hc_quota IS
  '某节点某期的编制额度（int）。183 起**沿用**：本期没定编时取最近一个更早的期。'
  '★ 想知道"这期到底定没定"，用 fn_hc_quota_effective 的 status，不要用本函数 —— '
  '它只给数，给不出出处（这是有意分工：数值口径保持简单，出处单独问）。'
  '★ 从来没定过 → NULL（不是 0）：0 是"定了但一个编都不给"，NULL 是"还没定"，两者处置完全不同。';
