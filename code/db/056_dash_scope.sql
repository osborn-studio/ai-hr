-- ============================================================================
-- 056_dash_scope.sql · 看板按行闸出行：区域那一行的数，是整棵子树的数
-- ----------------------------------------------------------------------------
-- 024 的 fn_dash_group 把"根组织下面的每个区域"列出来，**不看权限**。
-- 接口原来也是直接 db.query —— 两处都不判，于是 A 店 HR 打开看板看到的是
-- 华东区的总人数、总工时、工资总额（含 B 店、C 店）。
--
-- 这类洞有个共同的外观：**演示里永远不出现**，因为演示总是用权限最大的账号。
-- 而它一旦被门店账号看到，泄的不是"某一行"，是一个区域的经营规模。
--
-- 收口有三条，缺一条都不算收完：
--
--   ① 行的可见性：只在**你范围内**的组织出行；
--   ② 数的口径：区域那一行的数是该区域**整棵子树**的汇总 ——
--      所以"部分可见"的区域不能出行：那个数里包含你看不到的店，
--      给出来就是泄露；给一半又会让"区域合计 ≠ 各店之和"，两个都错。
--      因此规则是 **整棵子树都可见才出行**；
--   ③ 不空的空：范围为空时返回 0 行（而不是集团数），并由界面说"你还没有范围"。
--
-- 还有一件事**刻意没做**：异常清单（fn_dash_exceptions）仍是集团口径。
-- 它数的是"全集团有几类异常"，不含明细数值。改成按范围重算要给九类判据
-- 各自加范围参数（其中几类的函数本身还不是按组织分的），
-- 那是一个独立的工作量。**不停在这里不做、也不假装做了**：
-- 下面把它登记成一条有主人、有到期日的债。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_dash_group(p_period varchar)
RETURNS TABLE (org_id bigint, name varchar, headcount numeric, hours numeric,
               gross numeric, quota int, hireable int, alerts int)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH vis AS (
    -- 每个组织：它在用户范围内是否**整棵子树都可见**
    SELECT o.id, o.name, o.parent_id, o.path,
           NOT EXISTS (
             SELECT 1 FROM public.org_unit c
              WHERE c.path LIKE o.path || '%'
                AND NOT (EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                                  WHERE s.dim_code = 'cost_org' AND s.org_id = c.id)
                         AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                                          WHERE d.dim_code = 'cost_org' AND d.org_id = c.id))
           ) AS full
      FROM public.org_unit o
     WHERE o.is_active
  ),
  top AS (
    -- 只留"最上层的那几个"：祖先已经整棵可见时，子节点不再重复出行，
    -- 否则同一个数会在几行里各出现一次（那正是 023 说的"双算"）。
    SELECT v.id, v.name, v.path
      FROM vis v
     WHERE v.full
       -- 集团根本身不出行：它就是全量，而看板的区域行是"往下拆一层"的视角
       -- （页头已经写着集团与期间）。把它也列出来会让各区域之和与它并存，
       -- 于是又多出一处"两个数都像对"的地方。
       AND v.parent_id IS NOT NULL
       -- 祖先（**集团根不算祖先**）已经整棵可见时，子节点不再出行。
       -- 集团根不算，是因为它被上面那条排除了；若把它当祖先，
       -- 全集团可见的账号会一行都出不来（父可见、父的父又是根，两头都落空）。
       AND NOT EXISTS (
         SELECT 1 FROM vis p
          WHERE p.id = v.parent_id
            AND p.full
            AND p.parent_id IS NOT NULL)
  )
  SELECT t.id, t.name::varchar,
         public.fn_rpt_headcount(t.id, p_period, 'end'),
         public.fn_rpt_hours(t.id, p_period),
         public.fn_rpt_payroll(t.id, p_period, 'gross_amount'),
         COALESCE(public.fn_hc_quota(t.id, p_period), 0),
         COALESCE(public.fn_hc_hireable(t.id, p_period), 0),
         (SELECT count(*)::int FROM public.fn_hc_over(p_period) x WHERE x.org_id = t.id)
    FROM top t
   ORDER BY t.path;
END;
$$;

COMMENT ON FUNCTION fn_dash_group IS
  '看板区域行：只列**整棵子树都在范围内**的最上层组织。'
  '部分可见的区域不能出行 —— 它的数是整棵子树的，给出来就泄露了看不到的店，'
  '给一半又会与"各店之和"对不上。';

-- ---------------------------------------------------------------------------
-- 债：异常清单仍是集团口径
-- ---------------------------------------------------------------------------
-- 用登记表把这件事写成一条有名字的债（而不是注释里的一句"以后再说"）：
-- 它会在自检页的 debt 栏里出现，到期没处理就一直红着。
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.DS','看板区域行按 cost_org 行闸出行（异常清单仍为集团口径=已登记的债）',
   'SECURITY','ACL',
   'fn_dash_group','public','org_unit','FUNCTION','team-lead','2027-06-30',
   'node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
