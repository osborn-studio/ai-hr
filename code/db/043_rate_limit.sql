-- ===========================================================================
-- 043_rate_limit.sql · 限流：把「一个人短时间内改一百次」挡住
-- ---------------------------------------------------------------------------
-- 到 042 为止，这套系统的写路径有：事务、行闸、业务码、留痕、幂等（plan 一次性）。
-- 但**没有任何东西限制频率**。后果很具体：
--
--   · 口令锁定（035）可以被用来做拒绝服务：拿别人的账号连错 5 次，他就登不进来。
--   · 一个跑飞的脚本可以在 10 秒里开 500 张请假单，而每一张都"合规"。
--
-- 三条判断：
--
-- ① **限的是"写"，不是"读"。** 读有行闸（看不到就是看不到），而且量级差三个数量级；
--    给读也计数会让每次翻页都写一次库——为了防滥用先把自己压垮。
--
-- ② **账在库里**（`app_request_log` 已经有 `(actor, at)` 索引）。
--    放进程内存的话，重启清零、多实例各算一套 —— 与 035 的失败计数同一个理由。
--
-- ③ **被限的请求不写日志。** 写了就是自我放大：拒绝一次 → 多一条日志 →
--    更接近上限 → 拒绝更多。窗口内的计数必须只反映**真实发生过的请求**。
--
-- 窗口与阈值是配置项（`RATE_WRITE_PER_MIN`），默认 120/分钟：
-- 一个人正常操作远到不了，而脚本一秒钟就能撞上。
-- ===========================================================================

INSERT INTO policy_def(code,name,domain,value_type,allow_org_override,override_floor,unit) VALUES
  ('RATE_WRITE_PER_MIN','单个账号每分钟写操作上限','SECURITY','numeric',false,'group','次/分钟')
ON CONFLICT (code) DO NOTHING;
INSERT INTO policy_value(policy_code,effective_from,value_num,published_by,reason) VALUES
  ('RATE_WRITE_PER_MIN','2026-01-01',120,'group_hr','默认 120/分钟：正常操作到不了，脚本一秒就撞上')
ON CONFLICT (policy_code,effective_from) DO NOTHING;

CREATE OR REPLACE FUNCTION fn_rate_write_per_min(p_on date)
RETURNS int
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v numeric;
BEGIN
  SELECT value_num INTO v FROM public.fn_policy_effective('RATE_WRITE_PER_MIN', 1, p_on);
  IF v IS NULL OR v <= 0 THEN
    RAISE EXCEPTION 'E_POLICY_INVALID: RATE_WRITE_PER_MIN 必须是正数（收到 %）', v;
  END IF;
  RETURN v::int;
END;
$$;

/**
 * 这个账号在最近 p_window_seconds 秒里的写操作是否还在配额内。
 * 只统计**真实发生过的**请求（被限的那次不写日志，见文件头 ③）。
 */
CREATE OR REPLACE FUNCTION fn_rate_ok(p_actor varchar, p_window_seconds int DEFAULT 60)
RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_max int; v_n int;
BEGIN
  v_max := public.fn_rate_write_per_min(current_date);
  SELECT count(*) INTO v_n
    FROM public.app_request_log l
   WHERE l.actor = p_actor
     AND l.at > clock_timestamp() - make_interval(secs => p_window_seconds);
  RETURN v_n < v_max;
END;
$$;

COMMENT ON FUNCTION fn_rate_ok IS
  '按账号统计最近一分钟的写操作数。返回 boolean 而不是抛错：'
  '限流是**应用层**的裁决（要不要 429、要不要记日志），库只提供计数。';

-- 当前用量（给运维看：谁快撞上限了）
CREATE OR REPLACE VIEW v_rate_usage AS
  SELECT actor,
         count(*) FILTER (WHERE at > clock_timestamp() - interval '1 minute')::int AS last_minute,
         count(*)::int AS total
    FROM app_request_log
   GROUP BY actor
   ORDER BY 2 DESC;
