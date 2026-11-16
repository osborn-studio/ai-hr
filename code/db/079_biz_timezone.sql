-- ============================================================================
-- 079_biz_timezone.sql · 业务时区做成帐套级制度项
-- ----------------------------------------------------------------------------
-- 071 把"今天"收成了 app_today()，但时区本身还写死在函数里（Asia/Shanghai）。
-- 而真实情况里它不是一个常量：
--
--   · 集团总部在上海、门店在香港/新加坡 —— 同一套系统，两个时区；
--   · 服务器/容器经常是 UTC，而"业务日"按客户所在地算；
--   · 演示环境跑在海外网络，与客户的当地日期可能差一天（这次就撞上了：
--     我这边是 UTC 11-14，客户在国内已经是 11-15 早上）。
--
-- 所以时区必须是**配置**，优先级三层（越具体越优先）：
--   ① 会话级 GUC `app.biz_tz`（测试与单次脚本用，SET LOCAL 不会漏出去）
--   ② 制度项 `BIZ_TIMEZONE`（客户配置，有生效日、有留痕）
--   ③ 兜底 'Asia/Shanghai'（不变更既有行为）
--
-- ★ 为什么不做成"每部门一个时区"：那要让 app_today() 带组织参数，而行闸、
--   打卡、算薪、报表全都要改签名 —— 而"一个集团跨两个时区且要求按部门算日子"
--   是极少数。真遇到时，那是另一件事（多帐套 + 各自的 BIZ_TIMEZONE），
--   而不是把日界变成每行一个值。
-- ============================================================================

INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit) VALUES
  ('BIZ_TIMEZONE', '业务时区（决定"今天"是哪天）', 'security', 'text', false, 'group', NULL)
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
SELECT 'BIZ_TIMEZONE', DATE '2026-01-01', 'Asia/Shanghai', 'system',
       '默认：中国标准时间（与 071 的写死值相同，不改变既有行为）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_value WHERE policy_code = 'BIZ_TIMEZONE');

CREATE OR REPLACE FUNCTION app_tz() RETURNS text
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_guc text; v_pol text;
BEGIN
  -- ① 会话级（测试与一次性脚本用）
  v_guc := NULLIF(current_setting('app.biz_tz', true), '');
  IF v_guc IS NOT NULL THEN RETURN v_guc; END IF;

  -- ② 制度项（客户配置）。读集团根的组织值；取不到就退 ③。
  BEGIN
    SELECT value_text INTO v_pol
      FROM public.fn_policy_effective('BIZ_TIMEZONE',
             COALESCE((SELECT id FROM public.org_unit WHERE parent_id IS NULL LIMIT 1), 1),
             (now() AT TIME ZONE 'UTC')::date);
  EXCEPTION WHEN OTHERS THEN
    v_pol := NULL;   -- 制度还没建（空库跑迁移时）不能因此让所有查询炸
  END;
  IF v_pol IS NOT NULL AND length(btrim(v_pol)) > 0 THEN RETURN btrim(v_pol); END IF;

  RETURN 'Asia/Shanghai';
END;
$$;

COMMENT ON FUNCTION app_tz IS
  '业务时区。优先级：GUC app.biz_tz > 制度项 BIZ_TIMEZONE > Asia/Shanghai。'
  '改它等于改"今天"是哪天，所以它是制度项（有生效日、有留痕），不是环境变量。';

-- 时区名写错必须在**发布时**就炸，而不是等到某天算薪时炸
CREATE OR REPLACE FUNCTION fn_biz_timezone_check(p_tz text) RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = btrim(p_tz)) THEN
    RAISE EXCEPTION 'E_TZ_UNKNOWN: 时区 % 不在 tzdata 里（例：Asia/Shanghai / Asia/Hong_Kong）', p_tz;
  END IF;
END;
$$;

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.TZB','业务时区是配置项：GUC > 制度项 > 默认；时区名写错在发布时就拒',
   'SECURITY','ALGORITHM','app_tz','public','policy_value','FUNCTION',
   'team-lead','2027-03-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
