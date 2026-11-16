-- ============================================================================
-- 179_plan_cache_mode.sql · 每条连接强制按实际参数规划（不然第 6 次请求慢 180 倍）
-- ----------------------------------------------------------------------------
-- 现象（这一条是本轮最难查的，因为它**不报错、不占内存、单次跑都对**）：
--
--   /api/org/tree 前 5 次 168-230ms，**第 6 次起 31s**（另一次跑到 266s），
--   第 7、8 次照样 31s；而请求仍然 200、行数仍然 67 —— 数据是对的。
--   从浏览器/curl 看（15s 超时）就是"服务挂了"，于是最初被当成 OOM/WASM 泄漏。
--
-- 根因：PostgreSQL 的**通用计划**。
--   同一语句的计划缓存被执行 5 次之后，`plan_cache_mode=auto`（默认）会让它
--   改用"通用计划"——参数值不参与规划。org/tree 那条 SQL（$1 = 日期，
--   60 店 + 档口 + LATERAL）的通用计划选了个灾难性的连接方式：168ms → 31s。
--   ★ 阈值就是 5：第 6 次开始慢。这个数字属于 PG，不是我们的代码。
--
-- 排除过程（三条实验，都做过，写在这里以免下一个人重走）：
--   ① `app_begin_scope` 连跑 12 次：0-3ms，rss 811MB 一动不动 → 不是它；
--   ② 内存：第 6 次那两次 rss 反而从 389MB 降到 347MB，heap 平 ~20MB，
--      最大表 256kB，`VACUUM (ANALYZE)` 1.4s 无效 → 不是内存、不是表规模；
--   ③ 计数器是**按语句**的：先打 6 次便宜接口（/api/me/roles 全程 2-3ms）
--      再打 tree，tree 依旧"1-5 快、第 6 慢" → 不是"每请求累积"这类全局量。
--   决定性证据：会话里 `SET plan_cache_mode = force_custom_plan` 之后，
--      下一次请求立刻回到 197/196/194ms 并稳定 —— 这是因果，不是相关。
--
-- ★ 为什么是**全局**选 custom，而不是给某条 SQL 打补丁：
--   本仓的语句都是"参数少、结果小、执行快"的短查询（最慢的接口也在百毫秒级），
--   重规划一次约 1ms —— 拿 1ms 换"任何一条语句都不会掉进灾难性通用计划"，
--   这笔账在任何一条查询上都划算。反过来（默认 auto）的代价是不可预期的：
--   哪条语句在第 6 次崩掉，取决于它的数据分布，只有跑到了才知道。
--   ★ 这不是性能调优，是把一个"第 N 次才坏"的不确定性换成确定的 1ms。
--
-- ★ 将来若真有一条语句"参数多、执行久、通用计划更好"：
--   给它自己 `SET LOCAL plan_cache_mode = force_generic_plan`（或在那个函数上
--   挂 `SET plan_cache_mode = force_generic_plan`），**不要**撤掉这里的全局开关 ——
--   撤掉等于把其余所有语句重新暴露回"第 6 次可能慢 180 倍"。
--
-- ★ 为什么 `set_config(..., false)` 的第三个参数必须是 false：
--   `is_local=true` 只在本事务内有效，提交/回滚就没了。而这里是在
--   **每条连接第一次取用时**执行的（db.mjs: PGlite 单连接 `:73/:84`，
--   真 PG 池 `:128/:166`），它跑在事务之外；用 true 的话，池化连接上的设置
--   会在第一个事务结束时静默消失 —— 又回到 auto，而且**没有任何报错**。
--   这一条有断言钉住（test/db-contract.test.mjs 的 D8：跨提交、跨回滚仍在，
--   并且证明 is_local=true 确实不跨事务）。
-- ============================================================================

CREATE OR REPLACE FUNCTION app_init_session() RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- ---- 四张临时表（001 原文，一个字没改；它们与会话同生共死）----
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

  -- ---- 每会话一次：按实际参数规划，永不使用通用计划 ----
  -- ★ false = 会话级（不是事务级）。第三个参数改成 true 的后果见文件头最后一段。
  PERFORM set_config('plan_cache_mode', 'force_custom_plan', false);
END;
$$;

COMMENT ON FUNCTION app_init_session IS
  '每条连接第一次取用时执行：建四张权限临时表 + 关掉"通用计划"。'
  '★ plan_cache_mode=force_custom_plan（179）：默认的 auto 会在同一语句第 6 次'
  '执行时切通用计划，而 org/tree 的通用计划慢 180 倍（168ms → 31s），'
  '表现成"第 6 次请求服务挂了"，实际仍是 200、数据也对。'
  '★ 若某条语句确实通用计划更好，给那一条单独 force_generic_plan，不要撤这个全局开关。'
  '★ set_config 第三个参数必须是 false（会话级）：init 跑在事务之外，'
  'true 会让池化连接在第一个事务结束时静默失效。';
