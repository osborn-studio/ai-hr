-- ============================================================================
-- 075_pwd_policy.sql · 口令强度做成制度项（默认 8 位，客户可调）
-- ----------------------------------------------------------------------------
-- 客户要"所有人初始口令 1234"。而 035 把"至少 8 位"写死在应用层 ——
-- 这不是缺陷，是当时正确的默认值；问题是**它不能改**，于是客户只能改代码。
--
-- 按本仓一贯的口径：拿不准的数值 → 做成制度项（可停用、有生效日、改配置即改行为）。
--   PWD_MIN_LEN   口令最小长度（默认 8 = 上线前的行为）
--   PWD_NEED_MIX  是否要求"字母+数字混合"（默认 true）
--
-- ★ 放宽它不是"安全上让步"这句话可以带过的：4 位数字口令在离线爆破下
--   几秒就破。所以这里同时登记一条债（SUITE.PW），到期要复核是否已经改回强口令。
--   把风险写在库里、有主人、有到期日，比写在聊天记录里强。
-- ============================================================================

INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit) VALUES
  ('PWD_MIN_LEN',  '口令最小长度',       'security', 'numeric', false, 'group', '位'),
  ('PWD_NEED_MIX', '口令需字母与数字混合', 'security', 'bool',    false, 'group', NULL)
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
SELECT 'PWD_MIN_LEN', DATE '2026-01-01', 8, 'system', '默认：至少 8 位（035 的原有行为）'
 WHERE NOT EXISTS (SELECT 1 FROM policy_value WHERE policy_code = 'PWD_MIN_LEN');

-- ★ policy_value 只有 value_num / value_text 两列（021 的设计：值类型由 policy_def 声明，
--   但**存储只有两种**）。布尔就用 value_text 存 'true'/'false' ——
--   加一列 value_bool 会让"同一个值有两条读法"，而两条读法迟早给出两种答案。
INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
SELECT 'PWD_NEED_MIX', DATE '2026-01-01', 'true', 'system', '默认：字母与数字混合'
 WHERE NOT EXISTS (SELECT 1 FROM policy_value WHERE policy_code = 'PWD_NEED_MIX');

-- 口令校验的唯一实现：应用层调它，不自己写 if
CREATE OR REPLACE FUNCTION fn_pwd_check(p_plain varchar)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_min int := 8;
  v_mix boolean := true;
  v_n   numeric;
  v_b   boolean;
BEGIN
  SELECT value_num INTO v_n FROM public.fn_policy_effective('PWD_MIN_LEN', 1, public.app_today());
  IF v_n IS NOT NULL THEN v_min := v_n::int; END IF;
  SELECT (value_text = 'true') INTO v_b
    FROM public.fn_policy_effective('PWD_NEED_MIX', 1, public.app_today());
  IF v_b IS NOT NULL THEN v_mix := v_b; END IF;

  IF p_plain IS NULL OR length(p_plain) < v_min THEN
    RAISE EXCEPTION 'E_CRED_WEAK: 口令至少 % 位（当前策略 PWD_MIN_LEN，可在制度里调整）', v_min;
  END IF;
  IF v_mix AND NOT (p_plain ~ '[A-Za-z]' AND p_plain ~ '[0-9]') THEN
    RAISE EXCEPTION 'E_CRED_WEAK: 口令必须同时包含字母与数字（当前策略 PWD_NEED_MIX）';
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_pwd_check IS
  '口令强度判据：长度与字符混合都读制度项，不在应用层写死。'
  '放宽到 4 位是客户的选择，但那条选择会登记成一条有到期日的债（SUITE.PW）。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.PW','口令强度：默认 8 位；放宽到 4 位是客户配置（复核是否已改回强口令）',
   'SECURITY','ALGORITHM','fn_pwd_check','public','sys_user_credential','FUNCTION',
   'team-lead','2027-01-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
