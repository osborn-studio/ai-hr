-- ============================================================================
-- 058_login_throttle.sql · 按**来源**限流登录：口令锁定的另一面
-- ----------------------------------------------------------------------------
-- 035 做了"同一账号错 5 次就锁"。它挡住的是**猜一个账号的口令**，
-- 而它挡不住另外两件事，且第二件是它自己造出来的：
--
--   ① **撞库**：拿一份泄露的"邮箱+口令"表，对几千个账号各试一次。
--      每个账号只错一次 → 永远锁不住，永远不被记录。
--   ② **拿锁定当拒绝服务**：盯着某个人的账号连错 5 次，他就登不进来。
--      这件事不需要知道他的口令，一个脚本就能做。
--
-- 两件事的共同点：**特征都在"来源"上，不在"账号"上**。
-- 所以这一层补的不是"再锁一次账号"，而是按来源计数：
--
--   · 同一来源在窗口内失败太多 → 这个来源的所有登录尝试直接 429
--   · **被限的尝试不写日志**（与 043 同一条：写了就是自我放大）
--   · 成功的登录**不清零**（否则攻击者只要有一个自己的合法账号就能无限续命）
--
-- 一个必须写明的边界：来源取自 `remoteAddress`，而它在反代后面恒等于代理地址。
-- 所以只有在**代理确实会覆盖** `X-Forwarded-For` 时才打开 TRUST_PROXY（见 server.mjs）。
-- 打开而代理不覆盖，等于让攻击者自己选来源 —— 比不做更坏。
--
-- 默认 30 次 / 15 分钟：一个办公室共用一个出口 IP，正常手误到不了；
-- 而撞库脚本一分钟就能过百。阈值是配置项，客户可以自己调。
-- ============================================================================

INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('RATE_LOGIN_FAIL_PER_15M', '同一来源 15 分钟内登录失败上限', 'SECURITY', 'numeric',
        false, 'group', '次/15分钟')
ON CONFLICT (code) DO NOTHING;
INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
VALUES ('RATE_LOGIN_FAIL_PER_15M', '2026-01-01', 30, 'group_hr',
        '默认 30 次/15 分钟：办公室共用出口的正常手误到不了，撞库脚本一分钟就过百')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. 尝试台账
-- ---------------------------------------------------------------------------
CREATE TABLE login_attempt (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 来源：IP（反代后为 XFF 首跳）。不存到 street 级，够用来分组就行
  source  varchar(64) NOT NULL,
  account varchar(64) NOT NULL,
  ok      boolean     NOT NULL,
  at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_la_source_at ON login_attempt (source, at DESC);

COMMENT ON TABLE login_attempt IS
  '登录尝试台账：来源 + 账号 + 成败 + 时间。'
  '只在"未被告警拦下"的尝试上写一行 —— 被限的尝试不写，否则拒绝一次多一条记录，'
  '越拒绝越接近上限。';

-- ---------------------------------------------------------------------------
-- 2. 记账
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_login_record(p_source varchar, p_account varchar, p_ok boolean)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.login_attempt(source, account, ok)
  VALUES (left(p_source, 64), left(p_account, 64), p_ok);

  -- 顺手清理：只在**成功**时做，失败路径不做（失败路径越忙，越不该加写放大）。
  -- 30 天前的尝试对"还剩几次可试"没有意义，留着只是让表慢慢变大。
  IF p_ok THEN
    DELETE FROM public.login_attempt WHERE at < now() - interval '30 days';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 判：这个来源还能不能试
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_login_throttled(p_source varchar, p_window_seconds int DEFAULT 900)
RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_max numeric; v_n int;
BEGIN
  SELECT value_num INTO v_max
    FROM public.fn_policy_effective('RATE_LOGIN_FAIL_PER_15M', 1, current_date);
  IF v_max IS NULL OR v_max <= 0 THEN
    RAISE EXCEPTION 'E_POLICY_INVALID: RATE_LOGIN_FAIL_PER_15M 必须是正数（收到 %）', v_max;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.login_attempt a
   WHERE a.source = left(p_source, 64)
     AND NOT a.ok
     AND a.at > clock_timestamp() - make_interval(secs => p_window_seconds);

  RETURN v_n >= v_max;
END;
$$;

COMMENT ON FUNCTION fn_login_throttled IS
  '按来源统计窗口内的失败次数。只数 failures：成功不清零 —— '
  '清的话，攻击者拿一个自己的账号登一次就能继续试别人。';

-- 给运维/审计看：哪些来源正在被撞
CREATE VIEW v_login_fail_by_source AS
  SELECT source,
         count(*)::int                                              AS fails,
         count(*) FILTER (WHERE at > now() - interval '15 minutes')::int AS last_15m,
         min(at) AS first_at,
         max(at) AS last_at
    FROM login_attempt
   WHERE NOT ok
   GROUP BY source
   ORDER BY 3 DESC;

-- ---------------------------------------------------------------------------
-- 4. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.LG','登录按来源限流：撞库与「拿锁定做拒绝服务」都被挡，且被限的尝试不记账',
   'SECURITY','ACL',
   'fn_login_throttled','public','login_attempt','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-LG','登录接口：同一来源失败到上限 → 429，另一个来源不受影响',
   'SECURITY','ACL',
   'fn_login_throttled','public','login_attempt','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
