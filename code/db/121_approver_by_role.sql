-- ============================================================================
-- 121_approver_by_role.sql · 审批人兜底按"角色"找，不只按岗位码
-- ----------------------------------------------------------------------------
-- 119 的 fn_att_approver 第 ④ 步按 position.code IN ('HR_MGR','HR_OPS',…) 找 HR 主管。
-- 但真实帐套里岗位是客户自己起的名字（销售主管/财务主管/实施总监…），
-- 不一定有叫 HR_OPS 的岗位 —— 于是"部门没设负责人"时永远找不到审批人，
-- 提交整批被拒，而原因写着"没有 HR 主管"，实际上有 HR 却没认出来。
--
-- 修法：岗位码（具体到岗）优先，找不到就按**角色**兜底：
--   hr_ops / payroll_spec（人事与薪酬）→ 再退到 boss（小公司就是老板批）。
-- 角色是权限层的概念，客户一定配了（不然登录都进不来），比岗位码可靠。
--
-- ★ 为什么不直接把 boss 放第一位：
--   老板批全公司考勤，等于没有审批。它只能是最后一道兜底。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_att_approver(p_person bigint, p_period varchar)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_end date;
  v_org bigint;
  v_leader bigint;
BEGIN
  v_end := (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date;

  -- ① 这个人期末所在部门（考勤组织优先，其次成本组织）
  SELECT a.org_id INTO v_org
    FROM public.employee_org_assignment a
   WHERE a.employee_id = p_person
     AND a.dim_code IN ('attendance_org','cost_org')
     AND daterange(a.valid_from, a.valid_to, '[]') @> v_end
   ORDER BY (a.dim_code = 'attendance_org') DESC, a.valid_from DESC
   LIMIT 1;

  IF v_org IS NOT NULL THEN
    -- ② 本部门负责人
    SELECT o.leader_person_id INTO v_leader FROM public.org_unit o WHERE o.id = v_org;
    IF v_leader IS NOT NULL AND v_leader <> p_person THEN
      RETURN v_leader;
    END IF;

    -- ③ 沿部门树向上：店长空缺时落到区域，而不是直接跳到 HR
    WITH RECURSIVE up AS (
      SELECT o.id, o.parent_id, o.leader_person_id, 1 AS lvl
        FROM public.org_unit o WHERE o.id = v_org
      UNION ALL
      SELECT p.id, p.parent_id, p.leader_person_id, up.lvl + 1
        FROM public.org_unit p JOIN up ON p.id = up.parent_id
       WHERE up.lvl < 10
    )
    SELECT u.leader_person_id INTO v_leader
      FROM up u
     WHERE u.leader_person_id IS NOT NULL AND u.leader_person_id <> p_person
     ORDER BY u.lvl LIMIT 1;
    IF v_leader IS NOT NULL THEN RETURN v_leader; END IF;
  END IF;

  -- ④ 按岗位码（客户恰好建了 HR 岗位时最精确）
  SELECT pp.person_id INTO v_leader
    FROM public.person_position pp
    JOIN public.position po ON po.id = pp.position_id
   WHERE po.code IN ('HR_MGR','HR_OPS','PAYROLL_MGR','PAYROLL_SPEC')
     AND daterange(pp.valid_from, pp.valid_to, '[]') @> v_end
     AND pp.person_id <> p_person
   ORDER BY pp.valid_from DESC LIMIT 1;
  IF v_leader IS NOT NULL THEN RETURN v_leader; END IF;

  -- ⑤ 按角色兜底：人事/薪酬 → 最后才是老板
  SELECT a.person_id INTO v_leader
    FROM public.sys_account a
    JOIN public.sys_user_role ur ON ur.user_id = a.id
    JOIN public.sys_role r ON r.id = ur.role_id
   WHERE a.status = 'active' AND a.person_id IS NOT NULL
     AND a.person_id <> p_person
     AND r.code IN ('hr_ops','payroll_spec','boss')
   ORDER BY CASE r.code WHEN 'hr_ops' THEN 1 WHEN 'payroll_spec' THEN 2 ELSE 9 END,
            a.person_id
   LIMIT 1;

  RETURN v_leader;   -- 仍为空：调用方必须显式指定，不允许自动通过
END;
$$;

COMMENT ON FUNCTION fn_att_approver IS
  '月报审批人：本部门负责人 → 沿部门树向上 → HR 岗位（按岗位码）→ HR 角色（hr_ops/payroll_spec）'
  '→ 最后才是 boss。都为空时返回 NULL，调用方必须显式指定 —— 不允许"没人批就自动过"。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ATT4','审批人解析：部门负责人 → 上级 → 岗位码 → 角色兜底（boss 最后）',
   'ATTENDANCE','ACL','fn_att_approver','public','sys_account','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
