-- ===========================================================================
-- 039_password_change.sql · 改口令：强制与自愿
-- ---------------------------------------------------------------------------
-- 035 把口令做进了库，但留下两个洞，都是"看起来已经安全"的那种：
--
--   ① **种子口令永远是口令。** `must_change` 列在，但没有任何东西读它。
--      首次登录不改密，`demo1234` 就会一直有效 —— 而它会出现在每一份交接文档里。
--
--   ② **改完口令，旧会话还活着。** 改密的动机通常是"可能泄露了"，
--      而旧 token 仍然能用到 12 小时后 —— 于是"改密"变成心理安慰。
--
-- 这一版补上，两条判断：
--   · 未改密时，除了"改口令"和"看自己的会话"，其余接口一律拒绝（428）。
--     用 200 + 提示语的做法会被前端忽略，而忽略的代价是旧口令继续存在。
--   · 改密成功 → **吊销其它会话**，只保留当前这一个。
--     不吊销的话，"发现泄露 → 改密"这条最常见的处置动作其实是无效的。
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. 会话校验带上 must_change（一次查询解决，不额外多打一次库）
-- ---------------------------------------------------------------------------
-- ★ 返回类型变了，必须先 DROP：CREATE OR REPLACE 不能改返回列。
DROP FUNCTION IF EXISTS fn_session_check(text);

CREATE OR REPLACE FUNCTION fn_session_check(p_token_hash text)
RETURNS TABLE (user_id bigint, status varchar, expires_at timestamptz,
               revoked_reason varchar, must_change boolean)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT s.user_id,
         CASE
           WHEN s.revoked_at IS NOT NULL          THEN 'revoked'
           WHEN s.expires_at <= clock_timestamp() THEN 'expired'
           ELSE 'ok'
         END::varchar,
         s.expires_at,
         s.revoked_reason,
         COALESCE(c.must_change, false)
    FROM public.sys_session s
    LEFT JOIN public.sys_user_credential c ON c.user_id = s.user_id
   WHERE s.token_hash = p_token_hash;
$$;

COMMENT ON FUNCTION fn_session_check IS
  '三态而非 NULL：missing / expired / revoked / ok；并带出 must_change ——'
  '「该不该拦住他」与「他是谁」是同一次判断，分成两次就会有一次被忘掉。';

-- ---------------------------------------------------------------------------
-- 2. 吊销某人的其它会话（保留当前这条）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_sessions_revoke_others(
  p_user bigint, p_keep_hash text, p_by varchar, p_reason varchar
) RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_n int;
BEGIN
  PERFORM public.fn_assert_token_hash(p_keep_hash);

  UPDATE public.sys_session s
     SET revoked_at = clock_timestamp(), revoked_by = p_by,
         revoked_reason = p_reason
   WHERE s.user_id = p_user
     AND s.token_hash <> p_keep_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > clock_timestamp();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_sessions_revoke_others IS
  '改密后保留当前会话、吊销其余。不做这一步，"改密"挡不住已经泄露的 token。';

-- ---------------------------------------------------------------------------
-- 3. 改口令：校验旧口令 → 写新口令 → 撤其它会话（同一事务）
-- ---------------------------------------------------------------------------
-- ★ 旧口令必须验，而且要走**同一套失败计数**：否则改密接口就成了一个
--   "不需要锁定"的口令试错通道 —— 爆破者只要打这个接口就能绕开 5 次锁定。
CREATE OR REPLACE FUNCTION fn_password_change(
  p_user bigint, p_new_hash varchar, p_keep_token_hash text, p_by varchar
) RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_n int;
BEGIN
  PERFORM public.fn_credential_set(p_user, p_new_hash, false);
  v_n := public.fn_sessions_revoke_others(p_user, p_keep_token_hash, p_by, '口令已修改，旧会话作废');
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_password_change IS
  '写新口令 + 吊销其它会话。旧口令的校验在应用侧（scrypt），'
  '但失败计数仍走 fn_auth_challenge / fn_auth_result —— 否则改密接口会绕开锁定。';
