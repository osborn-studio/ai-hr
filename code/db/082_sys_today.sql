-- ============================================================================
-- 082_sys_today.sql · 授权用"系统日"，业务用"业务日"（两种"今天"必须分开）
-- ----------------------------------------------------------------------------
-- 实测：把业务时区从 +08:00 改成 UTC 之后，老板突然没有权限了。
--
--   改时区 → app_today() 从 11-15 变成 11-14
--   而授权行 effective_from = 11-15（今天授的权，按当时的业务日记的）
--   → daterange(11-15, NULL, '[)') @> 11-14 = false → "这条授权明天才生效"
--
-- 根因是**把两种"今天"混成一个**：
--
--   ① **业务日**：考勤属于哪天、算薪哪一期、报表口径 → 必须按客户所在地（可配时区）
--   ② **系统日**：谁在哪天被授权、会话签发 → 必须**稳定且与时区无关**
--
-- 授权是系统管理动作，不是业务单据。"今天给他开了权限"这件事不该因为
-- 后来把时区从上海改成 UTC 就变成"明天才生效"。
--
-- 所以新增 sys_today()（固定 UTC），授权体系全线改用它；业务链路继续用 app_today()。
-- 两者都只有一个实现，只是回答的问题不同。
--
-- ★ 顺带修一个数据：已有授权里"因为时区差被记成明天"的行，前移到系统今天。
--   理由写在这里：那些行的**意图**是"立即生效"，记成明天是时区造成的假象。
-- ============================================================================

CREATE OR REPLACE FUNCTION sys_today() RETURNS date
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  -- 固定 UTC：授权的生效日是一个**系统事实**，不随客户时区变化。
  SELECT (now() AT TIME ZONE 'UTC')::date;
$$;

COMMENT ON FUNCTION sys_today IS
  '系统日（UTC）。用于授权生效日、会话等系统事实 —— 它们不该随业务时区变化。'
  '业务日请用 app_today()（可配时区）。两个函数回答的是不同问题，不能合成一个。';

-- 已有授权：把"时区造成的明天"前移到系统今天（意图是立即生效）
UPDATE sys_user_role
   SET effective_from = public.sys_today()
 WHERE effective_from > public.sys_today();

UPDATE sys_org_grant
   SET effective_from = public.sys_today()
 WHERE effective_from > public.sys_today();

-- 权限判据改用系统日
CREATE OR REPLACE FUNCTION fn_role_can(
  p_user     bigint,
  p_resource varchar,
  p_action   varchar DEFAULT 'read'
) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_ok boolean; v_readonly boolean; v_day date := public.sys_today();
BEGIN
  IF p_action NOT IN ('read','write') THEN
    RAISE EXCEPTION 'E_ROLE_ACTION: 动作只能是 read / write（收到 %）', p_action;
  END IF;

  IF EXISTS (SELECT 1 FROM public.fn_effective_roles(p_user, v_day) e
               JOIN public.sys_role r ON r.id = e.role_id
              WHERE r.is_super AND r.is_active)
  THEN RETURN true; END IF;

  SELECT bool_or(rr.can_read OR (p_action = 'write' AND rr.can_write))
    INTO v_ok
    FROM public.fn_effective_roles(p_user, v_day) e
    JOIN public.sys_role r ON r.id = e.role_id AND r.is_active
    JOIN public.sys_role_resource rr
      ON rr.role_id = e.role_id AND rr.resource_code = p_resource
   WHERE CASE p_action WHEN 'read' THEN rr.can_read ELSE rr.can_write END;

  -- 代理：窗口按**时间戳**判（不是日期），所以与时区无关
  IF NOT COALESCE(v_ok, false) THEN
    SELECT bool_or(rr.can_read OR (p_action = 'write' AND rr.can_write))
      INTO v_ok
      FROM public.sys_acting_grant g
      JOIN public.sys_role r ON r.id = g.role_id AND r.is_active
      JOIN public.sys_role_resource rr
        ON rr.role_id = g.role_id AND rr.resource_code = p_resource
     WHERE g.agent_user = p_user
       AND g.revoked_at IS NULL
       AND now() >= g.valid_from AND now() < g.valid_to
       AND CASE p_action WHEN 'read' THEN rr.can_read ELSE rr.can_write END;
  END IF;

  IF p_action = 'write' THEN
    SELECT true INTO v_readonly
      FROM public.fn_effective_roles(p_user, v_day) e
      JOIN public.sys_user_role ur
        ON ur.user_id = p_user AND ur.role_id = e.role_id AND ur.readonly_only
     LIMIT 1;
    IF COALESCE(v_readonly, false) THEN RETURN false; END IF;
  END IF;

  RETURN COALESCE(v_ok, false);
END;
$$;

-- 行闸起点也用系统日：它查的是**授权规则**（fn_scope_rules），不是业务数据。
-- 业务快照仍由 p_fact_from 显式传入，不受影响。
CREATE OR REPLACE FUNCTION app_begin_scope(
  p_user     bigint,
  p_resource varchar,
  p_fact_from date                 -- ★ 无默认值：断言要求 pronargdefaults = 0
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''               -- 空，不是 pg_catalog, public；因此 temp 表一律写 pg_temp.
AS $$
DECLARE v_temporal varchar(16); v_as_of date; v_unsupported text; r record;
BEGIN
  TRUNCATE pg_temp.tmp_scope_org;   TRUNCATE pg_temp.tmp_scope_entity;
  TRUNCATE pg_temp.tmp_scope_emp;   TRUNCATE pg_temp.tmp_scope_deny;

  SELECT temporal_basis INTO v_temporal FROM public.sys_perm_resource
   WHERE resource_code = p_resource AND is_active;
  IF v_temporal IS NULL THEN
    RAISE EXCEPTION 'E_RESOURCE_UNREGISTERED: 资源 % 未在 sys_perm_resource 登记', p_resource;
  END IF;
  IF v_temporal = 'FACT_SNAPSHOT' AND p_fact_from IS NULL THEN
    RAISE EXCEPTION 'E_FACT_DATE_REQUIRED: 资源 % 按事实时点判定，必须传 p_fact_from', p_resource;
  END IF;
  -- ★ 业务时区的"今天"，不是会话时区的今天（077）。
  --   会话时区是 UTC 时，早上 8 点前这里是**昨天**，而授权生效日是 app_today() →
  --   于是"今天刚配的权限"在行闸里还没生效，结果是"这个账号什么都看不到"。
  --   这个错在多帐套真库上表现为：新帐套的老板/主管登录后花名册 0 人、考勤 0 行，
  --   而库里明明有 31 个人 —— 排查方向会一路跑到数据范围配置上去。
  -- ★ 用**系统日**（082）：这里只用来查"谁的授权命中这些规则"。
  --   用业务日会让"改时区"把当天授的权变成未来生效 —— 实测过，整站 403。
  v_as_of := COALESCE(p_fact_from, public.sys_today());

  -- 维度支持性守卫：kind 越界必须炸，不许静默落进某条分支
  SELECT string_agg(DISTINCT d.code, ',') INTO v_unsupported
    FROM public.sys_perm_dim d
   WHERE d.kind NOT IN ('org','entity','person');
  IF v_unsupported IS NOT NULL THEN
    RAISE EXCEPTION 'E_PERM_DIM_UNSUPPORTED: 维度 % 的 kind 无对应分支', v_unsupported;
  END IF;

  -- ① allow 面：按 kind 分支（不按 dimension 字面量 → 新增维度不用改函数）
  -- ★ 读的是「有效权限」而不是「直接授权」：组织继承也在内（见 020）。
  --   这一层如果仍直接读 sys_user_role，组织授权就只是登记了一条记录，
  --   而不会真的改变任何一次查询的结果——那种"接了线但没通电"最难发现。
  FOR r IN
    SELECT * FROM public.fn_scope_rules(p_user, v_as_of)
  LOOP
    IF r.kind = 'entity' THEN
      INSERT INTO pg_temp.tmp_scope_entity(dim_code, entity_id)
      SELECT r.dimension, x FROM unnest(r.value_ids) x;
    ELSIF r.kind = 'org' THEN
      IF r.value_type = 'node_subtree' THEN
        INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
        SELECT r.dimension, o.id FROM public.org_unit o
         WHERE EXISTS (SELECT 1 FROM public.org_unit p
                        WHERE p.id = ANY(r.value_ids) AND o.path LIKE p.path || '%');
      ELSE
        INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
        SELECT r.dimension, x FROM unnest(r.value_ids) x;
      END IF;
    ELSIF r.kind = 'person' THEN
      INSERT INTO pg_temp.tmp_scope_emp(dim_code, emp_id)
      SELECT r.dimension, x FROM unnest(r.value_ids) x;
    ELSE
      RAISE EXCEPTION 'E_PERM_DIM_UNSUPPORTED: 维度 % kind=%', r.dimension, r.kind;
    END IF;
  END LOOP;

  -- ② deny 面：与 allow 面同源，五个 kind 全覆盖
  INSERT INTO pg_temp.tmp_scope_deny(dim_code, org_id, entity_id, emp_id)
  SELECT d.dimension,
         CASE dm.kind WHEN 'org'    THEN x END,
         CASE dm.kind WHEN 'entity' THEN x END,
         CASE dm.kind WHEN 'person' THEN x END
    FROM public.sys_permission_deny d
    JOIN public.fn_deny_roles(p_user, v_as_of) ur ON ur.role_id = d.role_id
    JOIN public.sys_perm_dim  dm ON dm.code   = d.dimension
    CROSS JOIN LATERAL unnest(d.value_ids) x
   WHERE d.field_path IS NULL
     AND d.revoked_at IS NULL;
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

  -- ★ 生效日用**系统日**（082）：授权是系统管理动作，不该因为业务时区调整
  --   而变成"明天才生效"。业务日只影响考勤算哪天，不影响"谁有权限"。
  INSERT INTO public.sys_user_role(user_id, role_id, data_scope_id, grant_kind, grant_reason, effective_from)
  VALUES (v_uid, v_role.id, v_scope, 'ROLE', '建帐创建：' || p_by, public.sys_today());
  RETURN v_uid;
END;
$$;

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.SD','系统日与业务日分开：改时区不影响授权是否生效，但影响考勤算哪天',
   'PERM','ALGORITHM','sys_today','public','sys_user_role','FUNCTION',
   'team-lead','2027-03-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
