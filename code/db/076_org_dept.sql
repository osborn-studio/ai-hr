-- ============================================================================
-- 076_org_dept.sql · 组织层级通用化：门店 → 部门（可嵌套）
-- ----------------------------------------------------------------------------
-- 之前的层级是 集团 → 区域 → 门店，且**门店下不能再挂**。
-- 那条规则是为连锁餐饮写的，但它把"部门"这件事排除了：
-- 一家公司有 人事行政部 / 财务部 / 实施部，部门下面还有 前端组 / 后端组。
--
-- 改成：集团 → 区域 → 部门（部门可多级）。"门店"只是部门名的一种 ——
-- 连锁餐饮把部门起名叫"XX门店"，制造业叫"一车间"，医院叫"门诊部"。
--
-- 三条规则（比"深度 = 3"更稳，因为它讲的是**父子类型**）：
--   ① 根只能是 group，且一个帐套只有一个根
--   ② group / region 下可挂 region 或 dept
--   ③ dept 下只能挂 dept（部门再分部门是常态；再冒出"区域"就不是部门树了）
-- 另加一条防呆：最多 6 层 —— 不是业务限制，是拦住"把树建歪了"的那种数据。
--
-- ★ 历史数据：kind='store' 全部转成 'dept'。**不是加个别名** ——
--   两个值并存的话，每处判断都要写两遍，而漏写一处的表现是"这个部门不显示"。
-- ============================================================================

-- 1) kind 这一列原来**根本不存在**
-- ----------------------------------------------------------------------------
-- ★ 真问题：001 的 org_unit 只有 parent_id/name/path，层级全靠 path 深度隐含表达。
--   于是"这个是门店还是部门"只能靠"它是不是第 3 层"猜 —— 而一旦允许部门嵌套，
--   猜法立刻失效（第 4 层到底是子部门还是建错的区域？没人答得出）。
--   加一列，把类型写成事实；历史行按当前 path 深度回填（那是当时唯一的信息源）。
ALTER TABLE org_unit ADD COLUMN IF NOT EXISTS kind varchar(16);

UPDATE org_unit SET kind = CASE
    WHEN parent_id IS NULL THEN 'group'
    WHEN array_length(string_to_array(path, '.'), 1) = 2 THEN 'region'
    ELSE 'dept'
  END
 WHERE kind IS NULL;

ALTER TABLE org_unit ALTER COLUMN kind SET NOT NULL;
ALTER TABLE org_unit DROP CONSTRAINT IF EXISTS ck_ou_kind;
UPDATE org_unit SET kind = 'dept' WHERE kind = 'store';
ALTER TABLE org_unit ADD CONSTRAINT ck_ou_kind
  CHECK (kind IN ('group','region','dept'));
ALTER TABLE org_unit ALTER COLUMN kind SET DEFAULT 'dept';

COMMENT ON COLUMN org_unit.kind IS
  'group=集团 / region=区域 / dept=部门（可嵌套）。"门店"是部门名的一种，不是单独的类型。';

-- 2) 加组织：按父子类型判，不按深度判
CREATE OR REPLACE FUNCTION fn_org_add(
  p_parent bigint, p_name varchar, p_kind varchar, p_ledger bigint DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_parent public.org_unit%ROWTYPE; v_depth int; v_seq int; v_path varchar(200);
  v_id bigint; v_ledger bigint; v_kind varchar(16) := p_kind;
BEGIN
  -- 兼容旧调用：'store' 一律当 'dept'（062 之前的脚本还这么传）
  IF v_kind = 'store' THEN v_kind := 'dept'; END IF;

  v_ledger := COALESCE(p_ledger, (SELECT id FROM public.sys_ledger WHERE is_default LIMIT 1));

  IF v_kind NOT IN ('group','region','dept') THEN
    RAISE EXCEPTION 'E_ORG_KIND: 组织类型只能是 group / region / dept（收到 %）', p_kind;
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) < 2 THEN
    RAISE EXCEPTION 'E_ORG_NAME: 组织名称至少 2 个字';
  END IF;

  IF p_parent IS NULL THEN
    IF v_kind <> 'group' THEN RAISE EXCEPTION 'E_ORG_ROOT: 根组织只能是 group（集团）'; END IF;
    IF EXISTS (SELECT 1 FROM public.org_unit
                WHERE parent_id IS NULL AND ledger_id IS NOT DISTINCT FROM v_ledger) THEN
      RAISE EXCEPTION 'E_ORG_ROOT_EXISTS: 这个帐套已经有集团根组织了';
    END IF;
    v_path := CASE WHEN v_ledger IS NULL THEN '001' ELSE v_ledger::text END;
  ELSE
    SELECT * INTO v_parent FROM public.org_unit WHERE id = p_parent;
    IF v_parent.id IS NULL THEN RAISE EXCEPTION 'E_ORG_NO_PARENT: 上级组织 % 不存在', p_parent; END IF;
    v_ledger := COALESCE(v_ledger, v_parent.ledger_id);

    -- ① group / region 下可挂 region 或 dept；dept 下只能挂 dept
    IF v_parent.kind = 'dept' AND v_kind <> 'dept' THEN
      RAISE EXCEPTION 'E_ORG_DEPTH: 部门下面只能再挂部门（收到 %）', v_kind;
    END IF;
    IF v_kind = 'group' AND v_parent.kind IS NOT NULL THEN
      RAISE EXCEPTION 'E_ORG_DEPTH: 集团只能作为根，不能挂在「%」下面', v_parent.name;
    END IF;

    v_depth := array_length(string_to_array(v_parent.path, '.'), 1) + 1;
    -- ② 防呆：最多 6 层（不是业务限制，是拦住建歪的树）
    IF v_depth > 6 THEN
      RAISE EXCEPTION 'E_ORG_DEPTH: 组织层级最多 6 层（当前要建第 % 层）', v_depth;
    END IF;

    SELECT COALESCE(max((substring(path from '([0-9]+)$'))::int), 0) + 1 INTO v_seq
      FROM public.org_unit WHERE parent_id = p_parent;
    v_path := v_parent.path || '.' || lpad(v_seq::text, 3, '0');
  END IF;

  INSERT INTO public.org_unit(parent_id, name, path, ledger_id, kind)
  VALUES (p_parent, btrim(p_name), v_path, v_ledger, v_kind)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 3) 岗位名换成通用说法（code 不动：它是给授权与断言的标识）
UPDATE sys_role SET name = '部门主管',
       description = '本部门考勤、请假审批、本部门人员查看、排班与绩效'
 WHERE code = 'store_mgr';
UPDATE sys_role SET name = '副主管',
       description = '本部门日常：排班、考勤、请假初审；主管不在时由主管设定"代理"临时获得主管权限'
 WHERE code = 'store_deputy';
UPDATE sys_role SET name = '部门员工', description = '只看自己：工资条、额度、打卡、请假'
 WHERE code = 'store_staff';

-- 4) 判据组
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.OG','组织层级通用：部门可嵌套、部门下只能挂部门、集团不能挂人下、最多 6 层',
   'ORG','STRUCT','fn_org_add','public','org_unit','FUNCTION',
   'team-lead','2027-03-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
