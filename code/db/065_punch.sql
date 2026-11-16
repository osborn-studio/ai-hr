-- ============================================================================
-- 065_punch.sql · 打卡：只写原始事件，不算工时
-- ----------------------------------------------------------------------------
-- 参照钉钉的最小可用集：一个按钮、上班/下班、定位、当天状态。
-- 但**不照抄它的数据模型** —— 本系统的工时口径只有一条链路
-- （排班 → 休息扣除 → attendance_daily_store → v_att_effective → 算薪），
-- 打卡如果自己算一遍工时，就会出现"打卡页 8 小时、报表 7 小时"。
--
-- 五条硬规矩（每一条都对应一种真实事故）：
--
--   ① **时间是服务器时间**。客户端时间只作参考另存 —— 否则改手机时间就能改工时。
--   ② **重复打卡不产生第二条"有效"记录**。一天一对 in/out：取最早 in、最晚 out，
--      但**原始行全部保留**。中午外出吃个饭不该变成加班。
--   ③ **围栏外允许打卡但标记**。拒绝会让外勤/信号差的人打不上，
--      然后他们会互相代打 —— 那是更坏的结果。
--   ④ **忘打卡走补卡单**（审批），不直接插 punch。补卡不留痕，等于谁都能改历史。
--   ⑤ **只增不改**。打卡记录不接受 UPDATE/DELETE。
-- ============================================================================

CREATE TABLE punch (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id bigint      NOT NULL REFERENCES person(id),
  -- 服务器时间：唯一可信的时间。客户端时间在 client_at 里，只作证据
  punch_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  client_at   timestamptz,
  kind        varchar(8)  NOT NULL,
  source      varchar(16) NOT NULL DEFAULT 'app',
  store_id    bigint      REFERENCES org_unit(id),
  lat         numeric(9,6),
  lng         numeric(9,6),
  distance_m  int,
  device_id   varchar(64),
  -- 外部系统主键（钉钉/飞书）：幂等键。现在用不到，但列要先在 —— 
  -- 后加列意味着"上线那天就要改表"，而改表比留一列空着贵得多。
  ext_id      varchar(128),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_pu_kind   CHECK (kind IN ('in','out')),
  CONSTRAINT ck_pu_source CHECK (source IN ('app','web','device','dingtalk','feishu')),
  CONSTRAINT ck_pu_geo    CHECK ((lat IS NULL) = (lng IS NULL))
);

-- 同一外部记录只落一次（重跑同步不翻倍）
CREATE UNIQUE INDEX uk_pu_ext ON punch (source, ext_id) WHERE ext_id IS NOT NULL;
-- ★ 不能建成 (employee_id, (punch_at::date))：timestamptz→date 依赖会话时区，
--   不是 IMMUTABLE，PG 直接拒（functions in index expression must be marked IMMUTABLE）。
--   这个错读起来像"加个函数标记"，实际是"这个索引的语义本身不成立"——
--   同一条打卡在不同时区属于哪一天，本来就不该由索引说了算。
CREATE INDEX ix_pu_emp_at ON punch (employee_id, punch_at DESC);

COMMENT ON TABLE punch IS
  '打卡原始事件。只增不改：它同时是"证据"与"审计"。'
  '工时不由这张表算 —— 它只回答"几点几分在哪按了一下"。';

-- ---------------------------------------------------------------------------
-- 打卡规则：按门店，集团可下发
-- ---------------------------------------------------------------------------
CREATE TABLE punch_rule (
  store_id    bigint PRIMARY KEY REFERENCES org_unit(id),
  radius_m    int     NOT NULL DEFAULT 300,
  require_gps boolean NOT NULL DEFAULT true,
  allow_web   boolean NOT NULL DEFAULT true,
  CONSTRAINT ck_pr_radius CHECK (radius_m BETWEEN 50 AND 5000)
);

-- 只增不改
CREATE OR REPLACE FUNCTION fn_punch_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'E_PUNCH_APPEND_ONLY: 打卡记录不可改也不可删（它是证据）';
END;
$$;

CREATE TRIGGER trg_punch_append_only
  BEFORE UPDATE OR DELETE ON punch
  FOR EACH ROW EXECUTE FUNCTION fn_punch_append_only();

-- ---------------------------------------------------------------------------
-- 打卡：服务端时间 + 门店解析 + 围栏距离
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
       AND daterange(a.valid_from, a.valid_to, '[]') @> current_date
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

COMMENT ON FUNCTION fn_punch IS
  '打卡：服务器时间 + 门店解析 + 围栏距离。围栏外**照常记录**并标记 outside —— '
  '拒绝打卡会让外勤打不上，然后他们互相代打，那比"标记异常"坏得多。';

-- ---------------------------------------------------------------------------
-- 当天状态（打卡页首屏要的那三个数）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_punch_today AS
SELECT p.employee_id,
       p.punch_at::date AS work_date,
       min(p.punch_at) FILTER (WHERE p.kind = 'in')  AS first_in,
       max(p.punch_at) FILTER (WHERE p.kind = 'out') AS last_out,
       count(*)::int                                  AS punch_count,
       bool_or(p.distance_m > 300)                     AS any_outside
  FROM punch p
 WHERE p.punch_at::date = current_date
 GROUP BY p.employee_id, p.punch_at::date;

-- ---------------------------------------------------------------------------
-- 资源登记 + 岗位授权
-- ---------------------------------------------------------------------------
INSERT INTO sys_perm_resource(resource_code, label, temporal_basis) VALUES
  ('punch', '打卡', 'CURRENT')
ON CONFLICT (resource_code) DO NOTHING;

INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
SELECT r.id, 'punch', true, true
  FROM sys_role r
 WHERE r.code IN ('legacy_group_hr','legacy_store_hr','legacy_role_4',
                  'admin','acct_admin','group_hr','payroll_spec','hr_ops','store_mgr','store_staff')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 门店坐标（围栏判定要用；没有就先空着，NULL 表示"不算距离"，不是 0 米）
-- ---------------------------------------------------------------------------
ALTER TABLE org_unit ADD COLUMN IF NOT EXISTS lat numeric(9,6);
ALTER TABLE org_unit ADD COLUMN IF NOT EXISTS lng numeric(9,6);

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.PU','打卡：服务端时间、只增不改、围栏外标记、当天状态',
   'ATTENDANCE','ALGORITHM',
   'fn_punch','public','punch','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-PU','打卡接口：原始事件不合并、围栏标记、无员工身份不静默',
   'ATTENDANCE','ALGORITHM',
   'fn_punch','public','punch','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
