-- ============================================================================
-- 177_approver_must_be_able.sql · 审批人兜底链的每一级都必须**真的能批**
-- ----------------------------------------------------------------------------
-- 176 把老板收成只读之后，121 的兜底链最后一个死路暴露出来：
--
--   fn_att_approver 兜底：hr_ops → payroll_spec → **boss**
--   一个「一个 HR 账号都没有」的库里 → 解析到老板 → 老板点审批 → 403。
--
-- ★ 错误的形态不是"老板批不了"（那是产品决定），而是**审批被指派给一个
--   永远批不了的人**：单子挂死在这一步，而报出来的话是"你没有权限" ——
--   排查的人会去查权限配置，不会想到"兜底链指向了一个只读角色"。
--   一个指向死路的兜底，比没有兜底更坏：没有兜底时 119 会显式抛
--   E_ATT_NO_APPROVER「这些人找不到审批人」，有人会去配；
--   有了死路，系统看起来一切正常，只是单子永远不动。
--
-- ★★ 这轮的真正教训（写在这里，因为下一个人会照着这张表加第六级）：
--   **兜底链的每一级都要能真的做事。** 以后加任何 fallback approver，
--   先问一句"这个角色/这个人有 write 吗"。
--   判据也不该写"角色名叫什么"（121 就是这么写的：`r.code IN (...,'boss')`），
--   而该写"它有没有这个动作的权限" —— 角色名不会因为权限被回收而自动失效，
--   于是权限一收紧（176），代码里那串角色名就静默变成了一句空话。
--   这里改用 `att_report_approve` 的 can_write 筛人：审批接口查的就是它
--   （server.mjs 的四处 /api/att/report/* 都是 requireSession(att_report_approve, write)）。
--   角色名与权限从此不会各说各话：老板哪天真的需要批，把那行写权限显式给上即可，
--   本函数不用再改。
--
-- ★ 只改"兜底"那几级，不动"点名"那几级：
--   ① 本期所在部门 ② 部门负责人 ③ 沿部门树向上 —— 这三步是**业务指定**
--   （"这个部门谁负责"是人定的）。点名的人没有账号，是配置问题，要**显式暴露**
--   给那个人（他登录后发现批不了，会去要权限），而不是悄悄换个人来批。
--   ④ 岗位码 ⑤ 角色兜底 是**找一个人来兜底**，找不到能批的就该让给下一级，
--   所以这两级要能力筛选。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_att_approver(p_person bigint, p_period varchar)
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
    -- ② 本部门负责人（业务指定，不换人）
    SELECT o.leader_person_id INTO v_leader FROM public.org_unit o WHERE o.id = v_org;
    IF v_leader IS NOT NULL AND v_leader <> p_person THEN
      RETURN v_leader;
    END IF;

    -- ③ 沿部门树向上：店长空缺时落到区域，而不是直接跳到 HR（业务指定，不换人）
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
  -- ★ 兜底级 → 候选人必须有一个**能批**的账号（判据用 fn_effective_roles，
  --   与 fn_role_can 同一套：直接授权 ∪ 组织继承，不另写一份"谁有角色"）。
  SELECT pp.person_id INTO v_leader
    FROM public.person_position pp
    JOIN public.position po ON po.id = pp.position_id
   WHERE po.code IN ('HR_MGR','HR_OPS','PAYROLL_MGR','PAYROLL_SPEC')
     AND daterange(pp.valid_from, pp.valid_to, '[]') @> v_end
     AND pp.person_id <> p_person
     AND EXISTS (
           SELECT 1 FROM public.sys_account a4
            WHERE a4.status = 'active' AND a4.person_id = pp.person_id
              AND EXISTS (
                    SELECT 1 FROM public.fn_effective_roles(a4.id, public.app_today()) e4
                      JOIN public.sys_role r4 ON r4.id = e4.role_id AND r4.is_active
                      JOIN public.sys_role_resource rr4
                        ON rr4.role_id = r4.id
                       AND rr4.resource_code = 'att_report_approve'
                       AND rr4.can_write))
   ORDER BY pp.valid_from DESC LIMIT 1;
  IF v_leader IS NOT NULL THEN RETURN v_leader; END IF;

  -- ⑤ 按角色兜底：人事/薪酬 → 最后才是老板
  -- ★★ 这一级现在按**能力**筛，不按角色名：老板在 176 之后没有
  --    att_report_approve 的写权限，于是自动出局 —— 而不是"名单里还写着 boss，
  --    解析到他就死在那儿"。角色名留着不影响：真正决定的是 rr.can_write。
  SELECT a5.person_id INTO v_leader
    FROM public.sys_account a5
   WHERE a5.status = 'active' AND a5.person_id IS NOT NULL
     AND a5.person_id <> p_person
     AND EXISTS (
           SELECT 1 FROM public.fn_effective_roles(a5.id, public.app_today()) e5
             JOIN public.sys_role r5 ON r5.id = e5.role_id AND r5.is_active
             JOIN public.sys_role_resource rr5
               ON rr5.role_id = r5.id
              AND rr5.resource_code = 'att_report_approve'
              AND rr5.can_write
            WHERE r5.code IN ('hr_ops','payroll_spec','boss'))
   ORDER BY a5.person_id
   LIMIT 1;

  -- 仍为空：调用方（119 的 fn_att_period_submit）会显式抛
  -- E_ATT_NO_APPROVER「这些人找不到审批人」——**明确失败，不是静默挂死**。
  RETURN v_leader;
END;
$$;

COMMENT ON FUNCTION fn_att_approver IS
  '月报审批人：部门负责人 → 沿部门树向上（点名，不换人）'
  '→ HR 岗位码 / HR 角色兜底（**必须持有 att_report_approve 的写权限**，否则让给下一级）。'
  '都为空时返回 NULL，调用方必须显式指定 —— 不允许"没人批就自动过"。'
  '★ 177 起兜底级按能力筛而不是按角色名：121 把 boss 写进了名单，而 176 把老板'
  '收成只读之后，那一级就变成了一条死路（解析到一个永远批不了的人，'
  '而报出来的是"你没有权限"——最难查的一种）。';

-- 判据名同步：121 登记的名字写着"boss 最后"，那句现在是错的。
UPDATE sys_check_registry
   SET name = '审批人解析：部门负责人 → 上级（点名，不换人）→ 岗位码 / 角色兜底'
              '（兜底级必须**持有 att_report_approve 写权限**；没有 HR 账号的库里'
              '返回 NULL 而不是指向只读的老板 —— 兜底链不能指向一个不能做事的人）'
 WHERE check_code = 'SUITE.ATT4';
