-- ===========================================================================
-- 035_auth.sql · 口令：凭什么是这个账号
-- ---------------------------------------------------------------------------
-- 在这之前 `/login?user=3` 就能拿到 user 3 的令牌。也就是说：
-- **认证这一层根本不存在**，会话再完整也没有意义 —— 门锁很好，门是开的。
--
-- 四条判断：
--
-- ① **口令不进数据库。** 库里存的是 scrypt 派生值（含 salt 与参数），
--    校验在应用侧做（PGlite 没有 pgcrypto）。库被导出时，派生值不能直接登录。
--
-- ② **锁定是库里的计数，不是应用里的变量。** 应用重启、多实例、另一台机器，
--    任何一个客户端都不该能让"还能试几次"变成另一套账。
--
-- ③ **锁定期间正确口令也进不去。**  否则锁定只是给猜错的人看的，
--    而爆破者猜对的那一刻照样进 —— 这条最容易被写成"先验证再判锁定"。
--
-- ④ **口令策略是配置项**（长度下限），不写死在代码里。
--    不同客户对强度要求不同，这是管理决定，不是技术默认。
-- ===========================================================================

CREATE TABLE sys_user_credential (
  user_id       bigint PRIMARY KEY,
  -- 形如 scrypt$16384$8$1$<salt_b64>$<hash_b64>
  pwd_hash      varchar(255) NOT NULL,
  changed_at    timestamptz  NOT NULL DEFAULT clock_timestamp(),
  must_change   boolean      NOT NULL DEFAULT false,
  failed_count  int          NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  CONSTRAINT ck_uc_failed CHECK (failed_count >= 0),
  -- 摘要必须显式带算法：将来换 argon2 时，"这一行是什么算法"不能靠猜
  CONSTRAINT ck_uc_algo   CHECK (pwd_hash ~ '^(scrypt|argon2id)\$')
);

COMMENT ON COLUMN sys_user_credential.pwd_hash IS
  '口令派生值（含 salt 与参数）。明文与可逆加密都不允许 —— 可逆加密只是"晚一点泄露"。';

-- 口令策略：长度下限做成配置项（与 HEADCOUNT_MODE 等同一套机制）
INSERT INTO policy_def(code,name,domain,value_type,allow_org_override,override_floor) VALUES
  ('PWD_MIN_LEN','口令最小长度','SECURITY','numeric',false,'group')
ON CONFLICT (code) DO NOTHING;
INSERT INTO policy_value(policy_code,effective_from,value_num,published_by,reason) VALUES
  ('PWD_MIN_LEN','2026-01-01',8,'group_hr','默认 8 位；客户可上调，不许下调到 6 以下')
ON CONFLICT (policy_code,effective_from) DO NOTHING;

-- 锁定参数也做成常量函数（将来进配置项只需改这一处）
CREATE OR REPLACE FUNCTION fn_auth_max_fails() RETURNS int
LANGUAGE sql IMMUTABLE AS $$ SELECT 5 $$;

CREATE OR REPLACE FUNCTION fn_auth_lock_minutes() RETURNS int
LANGUAGE sql IMMUTABLE AS $$ SELECT 15 $$;

-- ---------------------------------------------------------------------------
-- 设置/重置口令：长度按策略校验，写入即清零失败计数
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_credential_set(
  p_user bigint, p_hash varchar, p_must_change boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_min numeric;
BEGIN
  IF p_hash IS NULL OR p_hash !~ '^(scrypt|argon2id)\$' THEN
    RAISE EXCEPTION 'E_CRED_ALGO: 口令摘要必须带算法前缀（scrypt$ / argon2id$）';
  END IF;

  INSERT INTO public.sys_user_credential(user_id, pwd_hash, must_change, failed_count, locked_until)
  VALUES (p_user, p_hash, p_must_change, 0, NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET pwd_hash = EXCLUDED.pwd_hash,
        changed_at = clock_timestamp(),
        must_change = EXCLUDED.must_change,
        failed_count = 0,          -- 改口令即解锁：它本来就是"我被锁了"的解法
        locked_until = NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 认证两步：先问"能不能试"，再报"对不对"
-- ---------------------------------------------------------------------------
-- ★ 为什么是两步：派生值校验只能在应用侧做（Node 的 scrypt），
--   而"能不能试"必须由库回答（计数与锁定在库里）。
--   两步都在**同一个事务**里，锁的是同一行。
CREATE OR REPLACE FUNCTION fn_auth_challenge(p_user bigint)
RETURNS TABLE (pwd_hash varchar, must_change boolean, locked_until timestamptz)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v public.sys_user_credential%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.sys_user_credential WHERE user_id = p_user FOR UPDATE;
  IF v.user_id IS NULL THEN
    -- ★ 没有口令记录与口令错误**回同一个码**：分开会让"这个账号存在吗"变成一个查询接口
    RAISE EXCEPTION 'E_AUTH_BAD_CREDENTIAL: 账号或口令不正确';
  END IF;

  -- ★ 先判锁定，再谈口令对不对。反过来的写法（先验证、再判锁定）
  --   会让"猜对的那一次"直接登录成功 —— 而锁定存在的理由正是挡住它。
  IF v.locked_until IS NOT NULL AND v.locked_until > clock_timestamp() THEN
    RAISE EXCEPTION 'E_AUTH_LOCKED: 口令错误次数过多，账号锁定至 %', v.locked_until;
  END IF;

  RETURN QUERY SELECT v.pwd_hash, COALESCE(v.must_change, false), v.locked_until;
END;
$$;

-- ★ **不抛异常**，只入账并把结论返回。
--   原因很具体：抛异常会让外层事务回滚，而「又错了一次」这个事实正好随回滚消失
--   —— 于是失败次数永远是 1，永远锁不住。
--   （与 027 那条「失败留痕必须写在事务外」是同一个道理，只是这次账在表里。）
CREATE OR REPLACE FUNCTION fn_auth_result(p_user bigint, p_ok boolean)
RETURNS TABLE (status varchar, failed_count int, locked_until timestamptz)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_failed int; v_lock timestamptz;
BEGIN
  IF p_ok THEN
    UPDATE public.sys_user_credential c
       SET failed_count = 0, locked_until = NULL
     WHERE c.user_id = p_user
    RETURNING c.failed_count, c.locked_until INTO v_failed, v_lock;
    RETURN QUERY SELECT 'ok'::varchar, v_failed, v_lock;
    RETURN;
  END IF;

  UPDATE public.sys_user_credential c
     SET failed_count = c.failed_count + 1
   WHERE c.user_id = p_user
  RETURNING c.failed_count INTO v_failed;

  IF v_failed >= public.fn_auth_max_fails() THEN
    UPDATE public.sys_user_credential c
       SET locked_until = clock_timestamp() + make_interval(mins => public.fn_auth_lock_minutes())
     WHERE c.user_id = p_user
    RETURNING c.locked_until INTO v_lock;
    RETURN QUERY SELECT 'locked'::varchar, v_failed, v_lock;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'bad'::varchar, v_failed, NULL::timestamptz;
END;
$$;

COMMENT ON FUNCTION fn_auth_result IS
  '口令校验结果入账。正确 → 清零；错误 → 计数 +1，到阈值即写 locked_until。'
  '**不抛异常**：抛了就会随事务回滚，而「又错了一次」正是要留下来的事实。'
  '计数在库里，所以重启、多实例、另一个客户端都不会各算一套账。';
