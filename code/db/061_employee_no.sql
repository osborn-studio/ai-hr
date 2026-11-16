-- ============================================================================
-- 061_employee_no.sql · 工号：能分配，但没人分配、也没人看得见
-- ----------------------------------------------------------------------------
-- 007 写了 `employee_no`（编号绑 person、永不复用、永不删除）与
-- `fn_assign_employee_no`（同一编号不得改分配）。规矩是对的，但这条链断在两处：
--
--   ① **入职时不分配**。`fn_hire_from_offer` 建了人、建了任职、建了归属、
--      写了月薪 —— 唯独没有工号。于是"新员工的工号"要靠人手 SQL 补，
--      而补工号这件事，HR 一定会在第一周问。
--   ② **分配了也没人看得见**。花名册与员工详情都不返回工号。
--      一条"写了没人看"的记录，与不存在区别不大。
--
-- 这一层补的就是这两端，并且把编号规则做成**配置项**（前缀与位数）：
-- 编号规则是 HR 政策（有的公司按年份、有的按门店、有的就是流水），
-- 写死一种，另一家客户第一件事就是要求改它。
--
-- 两条不动的规矩（007 已经定下，这里只是照着用）：
--   · **永不复用**：取下一个号时把已退休的号也算进"用过的"里；
--   · **同一个人再入职沿用原号**：人是同一个，工号就该还是那一个。
-- ============================================================================

INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('EMP_NO_PREFIX', '工号前缀', 'ORG', 'text', false, 'group', ''),
       ('EMP_NO_WIDTH',  '工号流水位数', 'ORG', 'numeric', false, 'group', '位')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('EMP_NO_PREFIX', '2026-01-01', 'E', 'group_hr', '默认 E：一个字母 + 流水，够用且好念')
ON CONFLICT (policy_code, effective_from) DO NOTHING;
INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
VALUES ('EMP_NO_WIDTH', '2026-01-01', 4, 'group_hr', '默认 4 位：9999 人以内不用改规则')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1. 下一个工号
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_next_employee_no()
RETURNS varchar
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_prefix varchar(16);
  v_width  int;
  v_max    bigint;
BEGIN
  SELECT value_text INTO v_prefix
    FROM public.fn_policy_effective('EMP_NO_PREFIX', 1, current_date);
  SELECT value_num::int INTO v_width
    FROM public.fn_policy_effective('EMP_NO_WIDTH', 1, current_date);

  IF v_prefix IS NULL OR length(btrim(v_prefix)) = 0 THEN
    RAISE EXCEPTION 'E_EMP_NO_RULE: 工号前缀为空（制度项 EMP_NO_PREFIX）';
  END IF;
  IF v_width IS NULL OR v_width < 1 OR v_width > 12 THEN
    RAISE EXCEPTION 'E_EMP_NO_RULE: 工号位数必须在 1–12 之间（收到 %）', v_width;
  END IF;

  -- ★ 取后缀数字比大小，不按字符串比：字符串里 'E999' > 'E1000'。
  --   而这个错只在跨过 1000 那一刻出现 —— 那时没人会怀疑工号规则。
  -- ★ 已退休的号也算进"用过的"：永不复用，所以取 max 时不过滤 retired_at。
  SELECT COALESCE(max((substring(no from '([0-9]+)$'))::bigint), 0) INTO v_max
    FROM public.employee_no
   WHERE no LIKE v_prefix || '%'
     AND substring(no from '([0-9]+)$') IS NOT NULL;

  RETURN v_prefix || lpad((v_max + 1)::text, v_width, '0');
END;
$$;

COMMENT ON FUNCTION fn_next_employee_no IS
  '下一个工号：前缀 + 补零流水。取 max 时包含已退休的号（永不复用），'
  '且按后缀数字比大小（字符串比较里 E999 > E1000）。';

-- ---------------------------------------------------------------------------
-- 2. 入职时分配（这是链断掉的那一端）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_hire_from_offer(
  p_offer       bigint,
  p_person      bigint,          -- NULL = 按 offer 上的候选人姓名新建
  p_hire_date   date,
  p_legal_entity bigint,
  p_by          varchar
) RETURNS TABLE (person_id bigint, employment_id bigint)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_person bigint; v_emp bigint; v_name varchar(64); v_no varchar(32);
BEGIN
  IF p_hire_date IS NULL THEN
    RAISE EXCEPTION 'E_HIRE_NO_DATE: 入职日必填（"今天"在跨月那一天会变成另一天）';
  END IF;

  SELECT o.candidate_name INTO v_name FROM public.offer o WHERE o.id = p_offer;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'E_OFFER_NOT_FOUND: offer % 不存在', p_offer;
  END IF;

  v_person := COALESCE(p_person, public.fn_person_create(v_name));

  v_emp := public.fn_offer_onboard(p_offer, v_person, p_hire_date, p_legal_entity, p_by);

  -- ★ 工号：同一个人再入职**沿用原号**（人是同一个），第一次入职才取新号。
  --   放在 onboard 之后：先成为员工，再给员工编号 —— 反过来的话，
  --   onboard 失败会留下一个"占了号但没入职"的人，而号是不回收的。
  SELECT n.no INTO v_no
    FROM public.employee_no n
   WHERE n.assigned_person_id = v_person
   ORDER BY n.assigned_at DESC LIMIT 1;

  IF v_no IS NOT NULL THEN
    PERFORM public.fn_assign_employee_no(v_person, v_no);   -- 复用，并清掉退休标记
  ELSE
    PERFORM public.fn_assign_employee_no(v_person, public.fn_next_employee_no());
  END IF;

  RETURN QUERY SELECT v_person, v_emp;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 花名册带出工号（另一端：分配了要看得见）
-- ---------------------------------------------------------------------------
-- ★ 返回类型变了，CREATE OR REPLACE 换不掉 → 必须先 DROP。
--   （42P13 "cannot change return type of existing function"）
DROP FUNCTION IF EXISTS fn_emp_roster(date);

CREATE FUNCTION fn_emp_roster(p_as_of date)
RETURNS TABLE (
  employee_id  bigint,
  employee_no  varchar,     -- 当前有效工号（没有就是 NULL，不编一个）
  full_name    varchar,
  org_id       bigint,
  org_name     varchar,
  hire_date    date,
  leave_date   date,
  leaving_soon boolean,
  national_id  varchar
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, n.no, p.full_name, a.org_id, o.name,
         e.hire_date, e.leave_date,
         (e.leave_date IS NOT NULL AND e.leave_date > p_as_of) AS leaving_soon,
         pf.profile_value
    FROM public.person p
    JOIN public.employment e ON e.person_id = p.id
    JOIN public.employee_org_assignment a
      ON a.employee_id = p.id AND a.dim_code = 'cost_org'
     AND daterange(a.valid_from, a.valid_to, '[]') @> p_as_of
    JOIN public.org_unit o ON o.id = a.org_id
    -- 工号取**当前有效**的那一个（retired_at IS NULL）。没有就 NULL：
    -- 编一个"待分配"塞进去，会让"有工号"与"没工号"在名单上同形。
    LEFT JOIN public.employee_no n
      ON n.assigned_person_id = p.id AND n.retired_at IS NULL
    LEFT JOIN public.person_profile pf
      ON pf.person_id = p.id AND pf.profile_type = 'national_id'
   WHERE daterange(e.hire_date, e.leave_date, '[]') @> p_as_of
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                  WHERE s.dim_code = 'cost_org' AND s.org_id = a.org_id)
     AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                      WHERE d.dim_code = 'cost_org' AND d.org_id = a.org_id)
   ORDER BY o.path, p.id;
END;
$$;

COMMENT ON FUNCTION fn_emp_roster IS
  '员工花名册（按 cost_org 行闸）。在离职按 p_as_of 判，不用"当前" —— '
  '同一个查询在跨月那天会给出另一个答案，而报表口径必须能复现。'
  '工号取当前有效那一个；没有就是 NULL（不编"待分配"）。';

-- ---------------------------------------------------------------------------
-- 4. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.NO','工号：入职自动分配、再入职沿用、永不复用、花名册看得见',
   'ORG','ALGORITHM',
   'fn_next_employee_no','public','employee_no','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-NO','工号接口侧：入职后名单上就有工号',
   'ORG','ALGORITHM',
   'fn_emp_roster','public','employee_no','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
