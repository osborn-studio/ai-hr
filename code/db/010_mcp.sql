-- ============================================================================
-- 010_mcp.sql · AI 开放层的两阶段写（04 §5.6）
-- ----------------------------------------------------------------------------
-- 一个命题：**"建议 AI 先调一次 dry-run"不是安全措施，AI 会跳过建议。**
-- 把"必须先预览"变成服务端拒绝无 plan 的执行，才是真的强制。
--
-- 另两条同源：
--   ① args_digest 保证"预览的和执行的是同一次操作"——
--      防止 AI 预览 10 条、执行 1000 条。
--   ② 影响面超阈值直接转人工，不是提示。提示会被忽略，拒绝不会。
-- ============================================================================

CREATE TABLE sys_mcp_plan (
  plan_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name        varchar(96) NOT NULL,
  args_digest      bytea       NOT NULL,
  diff_json        jsonb       NOT NULL,
  affected_count   int         NOT NULL,
  -- ★ 时长，不是时点。存 expires_at 会让"改策略"变成"改写历史计划"。
  plan_ttl_seconds int         NOT NULL DEFAULT 300,
  created_at       timestamptz NOT NULL DEFAULT now(),
  used_at          timestamptz,
  used_by          varchar(64),
  CONSTRAINT ck_mp_ttl CHECK (plan_ttl_seconds BETWEEN 30 AND 900),
  CONSTRAINT ck_mp_used CHECK ((used_at IS NULL) = (used_by IS NULL))
);

CREATE TABLE sys_mcp_audit (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  called_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  tool_name varchar(96) NOT NULL,
  actor     varchar(64) NOT NULL,
  shift_run boolean NOT NULL,          -- false = 读取，true = 写入
  affected  int
);

-- ---------------------------------------------------------------------------
-- 执行守卫：五条，任何一条不过就拒
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_mcp_execute(
  p_plan_id uuid, p_tool varchar, p_digest bytea, p_actor varchar,
  p_dry_run boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v public.sys_mcp_plan%ROWTYPE; v_threshold int := 50;
BEGIN
  -- ① 必须有 plan：没有就是"跳过预览直接写"
  SELECT * INTO v FROM public.sys_mcp_plan WHERE plan_id = p_plan_id;
  IF v.plan_id IS NULL THEN
    RAISE EXCEPTION 'E_MCP_NO_PLAN: 无 plan 的写操作被拒（必须先 dryRun）';
  END IF;

  -- ② 工具一致
  IF v.tool_name <> p_tool THEN
    RAISE EXCEPTION 'E_MCP_TOOL_MISMATCH: plan 属于 %，本次调用 %', v.tool_name, p_tool;
  END IF;

  -- ③ 参数摘要一致：预览的与执行的是同一次操作
  IF v.args_digest <> p_digest THEN
    RAISE EXCEPTION 'E_MCP_ARGS_CHANGED: 参数与预览时不一致（预览 % 条，执行另一批）',
      v.affected_count;
  END IF;

  -- ④ 未过期（时长在读取时算，没有第二个时点列）
  IF clock_timestamp() >= v.created_at + make_interval(secs => v.plan_ttl_seconds) THEN
    RAISE EXCEPTION 'E_MCP_PLAN_EXPIRED: plan 已过期（ttl=% 秒）', v.plan_ttl_seconds;
  END IF;

  -- ⑤ 未使用过：一个 plan 只能执行一次
  IF v.used_at IS NOT NULL THEN
    RAISE EXCEPTION 'E_MCP_PLAN_USED: plan 已于 % 被 % 使用过', v.used_at, v.used_by;
  END IF;

  -- ⑥ 影响面超阈值 → 转人工（拒绝，不是提示）
  IF v.affected_count > v_threshold THEN
    RAISE EXCEPTION 'E_MCP_OVER_THRESHOLD: 影响 % 人超过阈值 %，请到网页端由人操作',
      v.affected_count, v_threshold;
  END IF;

  IF NOT p_dry_run THEN
    UPDATE public.sys_mcp_plan SET used_at = clock_timestamp(), used_by = p_actor
     WHERE plan_id = p_plan_id;
    INSERT INTO public.sys_mcp_audit(tool_name, actor, shift_run, affected)
    VALUES (p_tool, p_actor, true, v.affected_count);
  END IF;
END;
$$;
