-- ============================================================================
-- 081_tz_no_date_filter.sql · 时区制度值不按日期过滤（彻底破环）
-- ----------------------------------------------------------------------------
-- 080 把 app_tz 改成"取最新一条，日期上限 = GREATEST(UTC今天, 会话今天)"，
-- 实测仍不生效：会话时区是 UTC（db.mjs 里固定），所以两个"今天"都是 11-14，
-- 而发布时 effective_from 用的是 app_today() = 11-15（+08:00）→ 仍被过滤掉。
--
-- 根本问题是**这一项不该有日期维度**：
--   "系统现在按哪个时钟算今天"是一个开关，不是一条有生效期的历史政策。
--   给它加日期，就必然会问"用哪天的今天来判断生效"—— 而那正是它要回答的问题。
--
-- 所以：只按 effective_from 排序取最新，**不加日期条件**。
--
-- 不追溯这一点不受影响：时区只决定"从现在起算哪天"；已经归到某天的事实
-- （考勤日、工资条、封账期）不会因为改时区而搬家 —— 它们落在表里时就已经
-- 带着具体日期了。这一条写在 policy_def 的名字里。
-- ============================================================================

CREATE OR REPLACE FUNCTION app_tz() RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_guc text; v_pol text;
BEGIN
  v_guc := NULLIF(current_setting('app.biz_tz', true), '');
  IF v_guc IS NOT NULL THEN RETURN v_guc; END IF;

  BEGIN
    -- ★ 不加 effective_from <= 任何日期：这一项没有"未来生效"的概念，
    --   加了就形成自引用（用今天查"今天由谁决定"）。
    SELECT pv.value_text INTO v_pol
      FROM public.policy_value pv
     WHERE pv.policy_code = 'BIZ_TIMEZONE'
     ORDER BY pv.effective_from DESC, pv.id DESC
     LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_pol := NULL;
  END;

  IF v_pol IS NOT NULL AND length(btrim(v_pol)) > 0 THEN RETURN btrim(v_pol); END IF;
  RETURN 'Asia/Shanghai';
END;
$$;

COMMENT ON FUNCTION app_tz IS
  '业务时区：GUC app.biz_tz > 制度项 BIZ_TIMEZONE（最新一条，立即生效）> Asia/Shanghai。'
  '★ 该制度项**不按日期过滤** —— 它没有"未来生效"的语义，按今天过滤会自引用。';

-- 判据：改时区立刻改变"今天"，且不追溯已落库的事实
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.TZC','时区制度值立即生效（不按日期过滤）：改 UTC 当天就变，历史日期不搬家',
   'SECURITY','ALGORITHM','app_tz','public','policy_value','FUNCTION',
   'team-lead','2027-03-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
