-- ============================================================================
-- 170_scope_people.sql · 统一的人员范围函数（cost_org 行闸）
-- ----------------------------------------------------------------------------
-- 权限矩阵验收（test/perm-matrix.mjs PM8/PM4b）抓到：有四个接口
-- （社保台账、合同、离职单、绩效）和发放清单导出，**requareSession 起手、SQL 里
-- 没有任何 scope 过滤**。于是 A 店 HR 打开这些页面，看到的是全集团的人。
--
-- 这不是"某个接口忘了写"，而是"没有一处可复用的行闸表达式" —— 每加一个读接口
-- 就要手抄一遍 EXISTS (tmp_scope_org ...)，抄漏一个就是一个越权面，
-- 而抄漏不会报错，只会让某个角色的列表里多几个人。
--
-- ★ 这个函数把那段抄写固定成一处：给我当前会话允许看的人。
--   - 只看 cost_org（门店）维度：人与门店的关系是"他在哪家店"，与发薪法人无关；
--   - 归属按 p_as_of 当天生效的那一段（历史人员也能查到，传那天的日期）；
--   - 没有 scope 时返回 0 行（fail-closed）—— 空范围**不能**被读成"全部"。
--
-- ★ 调用前提：该请求已经 app_begin_scope 过（requireSession / prepareRead 会做）。
--   若那个资源的 scope 规则里没有 cost_org 维度，tmp_scope_org 就是空的，
--   本函数返回 0 行 —— 那时要做的是补权限配置，不是在这里放宽。
-- ============================================================================

-- ★ 必须是 plpgsql，不能是 LANGUAGE sql：SQL 函数体在**创建时**就解析，
--   而 pg_temp.tmp_scope_org 只在 app_begin_scope 之后才存在 →
--   建函数当场报 "relation pg_temp.tmp_scope_org does not exist"。
--   plpgsql 的 RETURN QUERY 是**运行时**解析，调用时 scope 已经建好了。
CREATE OR REPLACE FUNCTION public.fn_scope_people(p_as_of date DEFAULT NULL)
RETURNS TABLE (employee_id bigint)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  -- ① 有门店归属、且门店在我范围内的人
  SELECT DISTINCT a.employee_id
    FROM public.employee_org_assignment a
   WHERE a.dim_code = 'cost_org'
     AND daterange(a.valid_from, a.valid_to, '[]')
         @> COALESCE(p_as_of, public.app_today())
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                  WHERE s.dim_code = 'cost_org' AND s.org_id = a.org_id)
     AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                      WHERE d.dim_code = 'cost_org' AND d.org_id = a.org_id)
  UNION
  -- ② **还没分配门店的人**（新入职、待分派）：只有能看到集团根的人才看得到。
  --    ★ 这条不是放宽，是把口径说清：没归属的人不属于任何门店，
  --      所以门店 HR 看不到他是对的；但让他在**所有人**的列表里都消失也不对 ——
  --      "刚入职还没分店"是新员工最常见的状态，消失意味着他的合同、社保、
  --      离职单在企业里根本不存在，而这类漏人不会有任何报错。
  SELECT p.id
    FROM public.person p
   WHERE NOT EXISTS (SELECT 1 FROM public.employee_org_assignment a2
                      WHERE a2.employee_id = p.id AND a2.dim_code = 'cost_org'
                        AND daterange(a2.valid_from, a2.valid_to, '[]')
                            @> COALESCE(p_as_of, public.app_today()))
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s2
                   JOIN public.org_unit o2 ON o2.id = s2.org_id
                  WHERE s2.dim_code = 'cost_org' AND o2.path = '001');
END;
$$;

COMMENT ON FUNCTION fn_scope_people IS
  '当前会话允许看的员工（按 cost_org 归属，p_as_of 当天生效那一段）。'
  '★ 没有 scope 时返回 0 行（fail-closed）—— 空范围不能读成"全部"。'
  '★ 这是"行闸"的唯一表达式：新加读接口时用它，别手抄 EXISTS。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.SCOPE-P',
   '人员行闸唯一表达式：社保台账/合同/离职单/绩效/发放清单导出 都按它收口，'
   'A 店 HR 在这些接口上看到的每个人都在他的花名册里',
   'ORG','ACL','fn_scope_people','public','employee_org_assignment','FUNCTION',
   'team-lead','2027-06-30','node test/perm-matrix.mjs','node test/perm-matrix.mjs')
ON CONFLICT (check_code) DO NOTHING;
