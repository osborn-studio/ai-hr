-- ============================================================================
-- 071_biz_today.sql · "今天"只能有一个答案（业务时区）
-- ----------------------------------------------------------------------------
-- 多帐套真库测试撞出来一个真问题，而它不是多帐套的问题：
--
--   新开帐套里，管理员账号刚建好，登录成功，紧接着每个写请求都是
--   **403 E_RESOURCE_FORBIDDEN**。
--
-- 原因：fn_account_create 给授权写 effective_from = current_date，
-- 而库会话时区固定为 UTC（db.mjs 这么做是为了日期不差一天）。
-- 服务器在北京时间 11-15 06:08 建帐 → UTC 那边还是 11-14 →
-- 授权生效日是 11-15，而权限判据用的 current_date 是 11-14 →
-- "授权明天才生效"，于是刚建的账号什么都干不了。
--
-- 这个错的形状很坏：它把"时区差 8 小时"变成了"新账号没权限"，
-- 而运维会去查角色矩阵、去查数据范围 —— 那两处都是对的。
--
-- 修法不是把某处改成 UTC 或 +08:00，而是**把"今天"收成一个函数**：
--   app_today() = 业务时区（默认 Asia/Shanghai，可用 GUC app.biz_tz 覆盖）里的今天
--
-- 于是"授权生效日"与"权限判据"用的是同一个日期，无论会话时区是什么。
-- 顺带把打卡的日界也收进来：早上 8 点前在 UTC 里属于前一天，
-- 而"今天打没打卡"必须按员工所在时区回答。
--
-- ★ 为什么不用 current_date：它取的是**会话时区**的今天，而会话时区是
--   部署细节（UTC 最省事、日期算术也最不容易出错）。业务日期不能由部署细节决定。
-- ============================================================================

CREATE OR REPLACE FUNCTION app_tz() RETURNS text
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(NULLIF(current_setting('app.biz_tz', true), ''), 'Asia/Shanghai');
$$;

CREATE OR REPLACE FUNCTION app_today() RETURNS date
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT (now() AT TIME ZONE public.app_tz())::date;
$$;

COMMENT ON FUNCTION app_today IS
  '业务时区里的今天。授权生效日、打卡日界、算薪默认期间都必须用它，'
  '不要用 current_date —— 那取的是会话时区，而会话时区是部署细节。';

-- ---------------------------------------------------------------------------
-- 权限判据：063 的 fn_role_can 把 current_date 换成 app_today()
-- （fn_effective_roles 本身不取今天，它收 p_on —— 不用改）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_role_can(
  p_user     bigint,
  p_resource varchar,
  p_action   varchar DEFAULT 'read'      -- read | write
) RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v_ok boolean; v_readonly boolean; v_today date := public.app_today();
BEGIN
  IF p_action NOT IN ('read','write') THEN
    RAISE EXCEPTION 'E_ROLE_ACTION: 动作只能是 read / write（收到 %）', p_action;
  END IF;

  -- 超级角色：直接放行（它是唯一能改授权的人）
  IF EXISTS (SELECT 1 FROM public.fn_effective_roles(p_user, v_today) e
               JOIN public.sys_role r ON r.id = e.role_id
              WHERE r.is_super AND r.is_active)
  THEN RETURN true; END IF;

  SELECT bool_or(rr.can_read OR (p_action = 'write' AND rr.can_write))
    INTO v_ok
    FROM public.fn_effective_roles(p_user, v_today) e
    JOIN public.sys_role r ON r.id = e.role_id AND r.is_active
    JOIN public.sys_role_resource rr
      ON rr.role_id = e.role_id AND rr.resource_code = p_resource
   WHERE CASE p_action
           WHEN 'read'  THEN rr.can_read
           ELSE rr.can_write
         END;

  -- 临时只读授权（代班/审计）压掉写：两个"只读"来源叠加，不是二选一
  IF p_action = 'write' THEN
    SELECT true INTO v_readonly
      FROM public.fn_effective_roles(p_user, v_today) e
      JOIN public.sys_user_role ur
        ON ur.user_id = p_user AND ur.role_id = e.role_id AND ur.readonly_only
     LIMIT 1;
    IF COALESCE(v_readonly, false) THEN RETURN false; END IF;
  END IF;

  RETURN COALESCE(v_ok, false);        -- 未登记 = 拒绝
END;
$$;

-- ---------------------------------------------------------------------------
-- 打卡当天：日界按业务时区（列与 065 完全一致，只改 WHERE 与 work_date 的算法）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_punch_today AS
SELECT p.employee_id,
       (p.punch_at AT TIME ZONE public.app_tz())::date AS work_date,
       min(p.punch_at) FILTER (WHERE p.kind = 'in')  AS first_in,
       max(p.punch_at) FILTER (WHERE p.kind = 'out') AS last_out,
       count(*)::int                                  AS punch_count,
       bool_or(p.distance_m > 300)                     AS any_outside
  FROM punch p
 WHERE (p.punch_at AT TIME ZONE public.app_tz())::date = public.app_today()
 GROUP BY p.employee_id, (p.punch_at AT TIME ZONE public.app_tz())::date;

COMMENT ON VIEW v_punch_today IS
  '打卡页的今天：按业务时区取日界。用 punch_at::date 会在 UTC 会话里把'
  '早上 8 点前的打卡算到前一天 —— 而那时员工正要上班。';

-- ---------------------------------------------------------------------------
-- 建账号：授权生效日与权限判据用同一个"今天"
-- ---------------------------------------------------------------------------
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

  -- ★ 生效日必须是 app_today()：用 current_date 的话，在 UTC 会话里
  --   刚建的账号"明天才生效"，于是登录成功、下一步全 403。
  INSERT INTO public.sys_user_role(user_id, role_id, data_scope_id, grant_kind, grant_reason, effective_from)
  VALUES (v_uid, v_role.id, v_scope, 'ROLE', '建帐创建：' || p_by, public.app_today());
  RETURN v_uid;
END;
$$;

-- ---------------------------------------------------------------------------
-- 打卡落库：找"当前有效的考勤组织"也按业务时区
-- （否则凌晨上班的人会挂到前一天的店）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_punch(
  p_employee  bigint,
  p_kind      varchar,
  p_store     bigint DEFAULT NULL,     -- 客户端声称的门店（可空：靠默认门店兜底）
  p_lat       numeric DEFAULT NULL,
  p_lng       numeric DEFAULT NULL,
  p_client_at timestamptz DEFAULT NULL,
  p_device    varchar DEFAULT NULL,
  p_source    varchar DEFAULT 'app'
) RETURNS TABLE (punch_id bigint, punched_at timestamptz, at_store bigint,
                 dist_m int, is_outside boolean)
-- ★ 输出列不能叫 `id` / `punch_at`：它们与 punch 表的列同名，而 RETURNING 子句里
--   名字会优先解析到 OUT 参数 → `column reference "id" is ambiguous`。
--   这个错只在**函数体里同时有 INSERT ... RETURNING** 时出现，读起来像"表定义有问题"。
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_store bigint; v_rule public.punch_rule%ROWTYPE; v_lat0 numeric; v_lng0 numeric;
  v_dist int; v_id bigint; v_at timestamptz;
BEGIN
  IF p_kind NOT IN ('in','out') THEN
    RAISE EXCEPTION 'E_PUNCH_KIND: 打卡类型只能是 in / out（收到 %）', p_kind;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.person WHERE id = p_employee) THEN
    RAISE EXCEPTION 'E_PUNCH_NO_EMPLOYEE: 员工 % 不存在', p_employee;
  END IF;

  -- 门店：客户端给的那个，否则取当前有效的考勤组织（唯一口径，与行闸同源）
  v_store := p_store;
  IF v_store IS NULL THEN
    SELECT a.org_id INTO v_store
      FROM public.employee_org_assignment a
     WHERE a.employee_id = p_employee AND a.dim_code = 'attendance_org'
       AND daterange(a.valid_from, a.valid_to, '[]') @> public.app_today()
     ORDER BY a.valid_from DESC LIMIT 1;
  END IF;

  SELECT * INTO v_rule FROM public.punch_rule WHERE store_id = v_store;

  -- 距离：门店中心坐标没配时不计算（NULL ≠ 0 米）。配了才算，算了才判围栏。
  IF p_lat IS NOT NULL AND v_store IS NOT NULL THEN
    SELECT o.lat, o.lng INTO v_lat0, v_lng0 FROM public.org_unit o WHERE o.id = v_store;
    IF v_lat0 IS NOT NULL THEN
      -- 粗略平面换算（300 米量级够用）：纬度 1 度 ≈ 111320 米
      v_dist := round(sqrt(
        power((p_lat - v_lat0) * 111320, 2) +
        power((p_lng - v_lng0) * 111320 * cos(radians(v_lat0)), 2)))::int;
    END IF;
  END IF;

  INSERT INTO public.punch(employee_id, kind, source, store_id, lat, lng, distance_m,
                           client_at, device_id)
  VALUES (p_employee, p_kind, COALESCE(p_source,'app'), v_store, p_lat, p_lng, v_dist,
          p_client_at, p_device)
  RETURNING id, punch_at INTO v_id, v_at;

  RETURN QUERY SELECT v_id, v_at, v_store, v_dist,
    COALESCE(v_dist > COALESCE(v_rule.radius_m, 300), false);
END;
$$;
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.TZ','今天只有一个答案：授权生效日、权限判据、打卡日界都用业务时区 app_today()',
   'PERM','ALGORITHM','app_today','public','sys_user_role','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','SELECT count(*) FROM pg_proc')
ON CONFLICT (check_code) DO NOTHING;
