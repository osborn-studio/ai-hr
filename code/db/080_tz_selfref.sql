-- ============================================================================
-- 080_tz_selfref.sql · 时区配置的自引用：先破环，再谈生效
-- ----------------------------------------------------------------------------
-- 079 的 app_tz() 是这样读制度项的：
--
--     SELECT value_text FROM fn_policy_effective('BIZ_TIMEZONE', 1, (now() AT TIME ZONE 'UTC')::date)
--
-- 看起来没问题，实测却"改了不生效"：
--   发布时 policy_value.effective_from = app_today() = 2026-11-15（+08:00 的今天），
--   而 app_tz 拿去查的日期是 UTC 今天 = 2026-11-14 →
--   "这条还没有生效" → 回落到默认 Asia/Shanghai → 页面显示"改成功了"，实际没变。
--
-- 这是**自引用**：app_today() 需要 app_tz()，而 app_tz() 又需要一个"今天"。
-- 破环的办法不是把日期调对（调哪边都错），而是**这一项不需要按日期查**：
--
--   BIZ_TIMEZONE 是"系统现在按哪个时钟"，它必须**立刻**对所有人生效 ——
--   不然就会出现"改了时区，但新的'今天'要等到明天才生效"这种循环定义。
--
-- 所以：取"已经发布的最新一条"，日期上限用 GREATEST(UTC 今天, 会话今天) 兜住
-- "发布日按业务时区算、而 UTC 还没到那天"的边界。历史不追溯：时区只影响
-- "从现在起算哪天"，已经归到某天的事实（考勤、工资条）不会因为改时区而搬家。
-- ============================================================================

CREATE OR REPLACE FUNCTION app_tz() RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_guc text; v_pol text;
BEGIN
  -- ① 会话级（测试与一次性脚本用；SET LOCAL 不会漏到别的连接）
  v_guc := NULLIF(current_setting('app.biz_tz', true), '');
  IF v_guc IS NOT NULL THEN RETURN v_guc; END IF;

  -- ② 制度项：取最新发布的一条，**不按业务日期过滤**（那会自引用）
  BEGIN
    SELECT pv.value_text INTO v_pol
      FROM public.policy_value pv
     WHERE pv.policy_code = 'BIZ_TIMEZONE'
       AND pv.effective_from <= GREATEST((now() AT TIME ZONE 'UTC')::date, current_date)
     ORDER BY pv.effective_from DESC, pv.id DESC
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_pol := NULL;   -- 空库跑迁移时表可能还没有
  END;

  IF v_pol IS NOT NULL AND length(btrim(v_pol)) > 0 THEN RETURN btrim(v_pol); END IF;

  RETURN 'Asia/Shanghai';   -- ③ 兜底：与 071 的写死值相同
END;
$$;

COMMENT ON FUNCTION app_tz IS
  '业务时区。优先级：GUC app.biz_tz > 制度项 BIZ_TIMEZONE（最新一条，立即生效）> Asia/Shanghai。'
  '★ 不按业务日期过滤制度值：app_today() 依赖本函数，按"今天"查会形成自引用，'
  '表现为"发布成功但改了不生效"。';

-- 时区这一项的语义就是"立即生效、不追溯"，在制度定义上写清楚
UPDATE policy_def
   SET name = '业务时区（决定"今天"是哪天；改了立即生效，不追溯历史）'
 WHERE code = 'BIZ_TIMEZONE';
