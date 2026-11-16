-- ============================================================================
-- 077_scope_today.sql · 行闸的"今天"也必须是业务时区
-- ----------------------------------------------------------------------------
-- 071 把 fn_role_can / v_punch_today / fn_account_create 的"今天"改成了 app_today()，
-- 但漏了**最要紧的那一处**：app_begin_scope 里的
--
--     v_as_of := COALESCE(p_fact_from, current_date);
--
-- 它是整条行闸的起点 —— fn_scope_rules(p_user, v_as_of) 用它去算有效权限。
-- 会话时区是 UTC（db.mjs 里固定成 UTC，为的是日期不差一天），
-- 服务器在北京时间 11-15 06:xx 时，这里得到的是 **11-14**，
-- 而账号的授权 effective_from = app_today() = 11-15 → "还没生效" → 范围 0 行。
--
-- 症状（真实发生过，不是推演）：
--   新帐套里老板登录，花名册 **0 人**、考勤 **0 行**、报表全 0；
--   而 psql 里手敲同样的语句一切正常（psql 会话时区是本地 +08:00）。
--   于是排查会一路跑到"数据范围配错了"上去，而配置是对的。
--
-- ★ 教训：凡"取今天"的地方，一律 app_today()。071 只改了三个函数就以为改完了，
--   而 app_begin_scope 不在那三个里面 —— 它是"漏了最要紧那个"的典型。
-- ============================================================================

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
  v_as_of := COALESCE(p_fact_from, public.app_today());

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

COMMENT ON FUNCTION app_begin_scope IS
  '灌四维临时表。日界用 app_today()（业务时区），不是 current_date（会话时区）——'
  '否则 UTC 会话下"今天配的权限"在行闸里还没生效，表现为整个账号看不到任何数据。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ST','行闸起点用业务时区：UTC 会话下 app_begin_scope 也能灌出范围',
   'PERM','ALGORITHM','app_begin_scope','public','sys_user_role','FUNCTION',
   'team-lead','2027-03-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
