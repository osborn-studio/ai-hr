-- ============================================================================
-- 068_multi_ledger.sql · 允许建**多个集团帐套**（档案级多帐套）
-- ----------------------------------------------------------------------------
-- 064 的 fn_ledger_open 写着"一份库只放一份帐套"。那条当时是对的：
-- 真做多帐套要在**每张业务表**上加 tenant 维度，那是一次大改。
-- 但"不允许建第二个"过头了 —— 一家代账公司/一个集团的多套帐（不同法人、
-- 不同城市）本来就要能在一个实例里建起来。
--
-- 所以这一轮把口径改成两段式，并把边界写死：
--
--   ✅ **档案级多帐套**（现在就有）：sys_ledger 多行；org_unit 与 sys_account
--      带 ledger_id；组织树、账号、角色、范围都是按帐套独立的。
--   ⏳ **业务数据级多帐套**（还没做）：考勤、工资条、审批、结算这些表
--      还没有 ledger_id。也就是说：**两个帐套共用同一批业务表**。
--      这意味着现在能"建多个帐套并各自配组织与账号"，但**不能**让两个帐套
--      同时产生业务数据 —— 那会让 5 号店的考勤算进 6 号店的报表。
--
-- 这条限制登记为债（SUITE.MT），到期前必须补完，否则不允许对外宣称"支持多帐套"。
-- ============================================================================

-- 1) 帐套可以有多个
ALTER TABLE sys_ledger ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uk_ledger_one_default ON sys_ledger (is_default) WHERE is_default;

CREATE OR REPLACE FUNCTION fn_ledger_open(
  p_code varchar, p_name varchar, p_start_period varchar, p_by varchar
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_id bigint;
BEGIN
  IF p_start_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_LEDGER_PERIOD: 启用期间必须是 YYYY-MM，收到 %', p_start_period;
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) < 2 THEN
    RAISE EXCEPTION 'E_LEDGER_NAME: 帐套名称至少 2 个字';
  END IF;

  INSERT INTO public.sys_ledger(code, name, start_period, created_by, is_default)
  VALUES (btrim(p_code), btrim(p_name), p_start_period, p_by,
          NOT EXISTS (SELECT 1 FROM public.sys_ledger))    -- 第一个自动成为默认
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_ledger_open IS
  '开一个集团帐套（可多个）。第一个自动为默认帐套。'
  '注意：业务表还没有 ledger_id —— 多帐套目前只到"档案 + 组织 + 账号"这一层。';

-- 2) 组织与账号归属到帐套
ALTER TABLE org_unit    ADD COLUMN IF NOT EXISTS ledger_id bigint REFERENCES sys_ledger(id);
ALTER TABLE sys_account ADD COLUMN IF NOT EXISTS ledger_id bigint REFERENCES sys_ledger(id);

-- 已有数据回填到默认帐套（没有帐套就留空，等建帐时再挂）
UPDATE org_unit SET ledger_id = (SELECT id FROM sys_ledger WHERE is_default LIMIT 1)
 WHERE ledger_id IS NULL AND EXISTS (SELECT 1 FROM sys_ledger);
UPDATE sys_account SET ledger_id = (SELECT id FROM sys_ledger WHERE is_default LIMIT 1)
 WHERE ledger_id IS NULL AND EXISTS (SELECT 1 FROM sys_ledger);

-- 3) 加组织/账号时带帐套（默认取默认帐套，不破坏既有调用）
CREATE OR REPLACE FUNCTION fn_org_add(
  p_parent bigint, p_name varchar, p_kind varchar, p_ledger bigint DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_parent public.org_unit%ROWTYPE; v_depth int; v_seq int; v_path varchar(200);
  v_id bigint; v_ledger bigint;
BEGIN
  v_ledger := COALESCE(p_ledger, (SELECT id FROM public.sys_ledger WHERE is_default LIMIT 1));

  IF p_kind NOT IN ('group','region','store') THEN
    RAISE EXCEPTION 'E_ORG_KIND: 组织类型只能是 group / region / store（收到 %）', p_kind;
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) < 2 THEN
    RAISE EXCEPTION 'E_ORG_NAME: 组织名称至少 2 个字';
  END IF;

  IF p_parent IS NULL THEN
    IF p_kind <> 'group' THEN RAISE EXCEPTION 'E_ORG_ROOT: 根组织只能是 group（集团）'; END IF;
    IF EXISTS (SELECT 1 FROM public.org_unit
                WHERE parent_id IS NULL AND ledger_id IS NOT DISTINCT FROM v_ledger) THEN
      RAISE EXCEPTION 'E_ORG_ROOT_EXISTS: 这个帐套已经有集团根组织了';
    END IF;
    -- 多个帐套并存时 path 不能都从 001 起（否则互相串），按帐套分前缀
    v_path := CASE WHEN v_ledger IS NULL THEN '001'
                   ELSE v_ledger::text END;
  ELSE
    SELECT * INTO v_parent FROM public.org_unit WHERE id = p_parent;
    IF v_parent.id IS NULL THEN RAISE EXCEPTION 'E_ORG_NO_PARENT: 上级组织 % 不存在', p_parent; END IF;
    v_ledger := COALESCE(v_ledger, v_parent.ledger_id);
    v_depth := array_length(string_to_array(v_parent.path, '.'), 1);
    IF (v_depth = 1 AND p_kind <> 'region') OR (v_depth = 2 AND p_kind <> 'store') OR v_depth >= 3 THEN
      RAISE EXCEPTION 'E_ORG_DEPTH: 上级（第 % 层）下面只能挂 %', v_depth,
        CASE v_depth WHEN 1 THEN 'region' WHEN 2 THEN 'store' ELSE '（没有下一层）' END;
    END IF;
    SELECT COALESCE(max((substring(path from '([0-9]+)$'))::int), 0) + 1 INTO v_seq
      FROM public.org_unit WHERE parent_id = p_parent;
    v_path := v_parent.path || '.' || lpad(v_seq::text, 3, '0');
  END IF;

  INSERT INTO public.org_unit(parent_id, name, path, ledger_id)
  VALUES (p_parent, btrim(p_name), v_path, v_ledger)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION fn_account_create(
  p_login varchar, p_display varchar, p_role varchar, p_org bigint,
  p_person bigint DEFAULT NULL, p_by varchar DEFAULT 'system'
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_role public.sys_role%ROWTYPE; v_scope bigint; v_uid bigint; v_ledger bigint;
BEGIN
  SELECT * INTO v_role FROM public.sys_role WHERE code = p_role AND is_active;
  IF v_role.id IS NULL THEN RAISE EXCEPTION 'E_ACCOUNT_ROLE: 角色 % 不存在', p_role; END IF;

  v_ledger := (SELECT id FROM public.sys_ledger WHERE is_default LIMIT 1);

  INSERT INTO public.sys_account(login, display_name, person_id, ledger_id)
  VALUES (btrim(p_login), btrim(p_display), p_person, v_ledger)
  RETURNING id INTO v_uid;

  IF p_org IS NULL THEN
    SELECT id INTO p_org FROM public.org_unit
     WHERE parent_id IS NULL AND ledger_id IS NOT DISTINCT FROM v_ledger LIMIT 1;
    IF p_org IS NULL THEN RAISE EXCEPTION 'E_LEDGER_NO_ORG: 还没有集团根组织 —— 先加组织再加账号'; END IF;
  END IF;

  INSERT INTO public.sys_data_scope(name, combinator) VALUES ('账号:' || p_login, 'intersection')
  RETURNING id INTO v_scope;
  INSERT INTO public.sys_data_scope_rule(data_scope_id, dimension, value_type, value_ids)
    SELECT v_scope, 'cost_org', 'node_subtree', ARRAY[p_org]::bigint[]
    UNION ALL SELECT v_scope, 'attendance_org', 'node_subtree', ARRAY[p_org]::bigint[]
    UNION ALL SELECT v_scope, 'payroll_legal_entity', 'nodes', ARRAY[1]::bigint[]
    UNION ALL SELECT v_scope, 'si_entity', 'nodes', ARRAY[1]::bigint[];

  INSERT INTO public.sys_user_role(user_id, role_id, data_scope_id, grant_kind, grant_reason, effective_from)
  VALUES (v_uid, v_role.id, v_scope, 'ROLE', '建帐创建：' || p_by, current_date);
  RETURN v_uid;
END;
$$;

CREATE OR REPLACE FUNCTION fn_ledger_list()
RETURNS TABLE (id bigint, code varchar, name varchar, start_period varchar, status varchar,
               is_default boolean, orgs int, accounts int)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT l.id, l.code, l.name, l.start_period, l.status, l.is_default,
         (SELECT count(*)::int FROM public.org_unit o WHERE o.ledger_id = l.id),
         (SELECT count(*)::int FROM public.sys_account a WHERE a.ledger_id = l.id)
    FROM public.sys_ledger l ORDER BY l.is_default DESC, l.id;
$$;

INSERT INTO sys_check_registry
  (check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,
   guard_debt_owner,guard_debt_due,runner,assertion_sql) VALUES
  ('SUITE.MT','多帐套：可建多个集团帐套，但业务表尚未按 ledger 分区（登记的债）',
   'ORG','STRUCT','sys_ledger','public','sys_ledger','TABLE','team-lead','2027-03-31',
   'node test/run.mjs','SELECT count(*) FROM sys_ledger')
ON CONFLICT DO NOTHING;
