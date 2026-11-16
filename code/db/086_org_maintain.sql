-- ============================================================================
-- 086_org_maintain.sql · 组织维护（改名 / 移动 / 停用）+ 岗位停用
-- ----------------------------------------------------------------------------
-- 076 只给了"建"（fn_org_add）。于是组织结构一旦建下去就是**只能加不能改**：
-- 门店改名、部门换上级、门店关门，全都得手工 UPDATE 库。
-- 手工 UPDATE 的问题不是麻烦，是**没有判据**：
--
--   · 改名时同父下重名了没人拦 → 两行同名，报表按名字分组时静默合并；
--   · 移动时把部门移进自己的子树 → path 成环，递归查询直接跑飞；
--   · 停用一个还有在职人员的部门 → 这些人下次查归属是空，工资条上的
--     "成本部门"变成 NULL，而 NULL 会被下游当成"未分配成本"；
--   · 停用一个还有启用子部门的部门 → 树上出现"停用的父 + 启用的子"，
--     子部门的人永远滚不上来。
--
-- 这四条都是"数据前后不一致"，而且都不会报错。所以维护动作必须走函数，
-- 判据写在函数里 —— 与 fn_org_add 同一个来源，不另开一套。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 改名
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_org_rename(p_org bigint, p_name varchar)
RETURNS varchar
LANGUAGE plpgsql
SET search_path = ''
AS $$ 
DECLARE v_row public.org_unit%ROWTYPE; v_name varchar(64) := btrim(p_name);
BEGIN
  SELECT * INTO v_row FROM public.org_unit WHERE id = p_org;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'E_ORG_NOT_FOUND: 组织 % 不存在', p_org; END IF;
  IF v_name IS NULL OR length(v_name) < 2 THEN
    RAISE EXCEPTION 'E_ORG_NAME: 组织名称至少 2 个字';
  END IF;
  IF v_name = v_row.name THEN RETURN v_name; END IF;

  -- 同父下不许重名。允许"已停用的同名"存在（历史门店），但启用中的必须唯一：
  -- 报表按名字分组，两行同名会让两家的数静默加在一起。
  IF EXISTS (SELECT 1 FROM public.org_unit
              WHERE parent_id IS NOT DISTINCT FROM v_row.parent_id
                AND id <> v_row.id AND is_active
                AND btrim(name) = v_name) THEN
    RAISE EXCEPTION 'E_ORG_DUP_NAME: 同一上级下已经有「%」', v_name;
  END IF;

  UPDATE public.org_unit SET name = v_name WHERE id = p_org;
  RETURN v_name;
END;
$$;

COMMENT ON FUNCTION fn_org_rename IS
  '组织改名。path 用的是序号不是名字，所以改名不动 path、不动归属 —— 改名是纯展示变更。';

-- ---------------------------------------------------------------------------
-- 2. 移动（换上级）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_org_move(p_org bigint, p_new_parent bigint)
RETURNS varchar
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_row public.org_unit%ROWTYPE; v_parent public.org_unit%ROWTYPE;
  v_old_path varchar(200); v_new_path varchar(200);
  v_sub_depth int; v_seq int;
BEGIN
  SELECT * INTO v_row FROM public.org_unit WHERE id = p_org;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'E_ORG_NOT_FOUND: 组织 % 不存在', p_org; END IF;
  IF v_row.parent_id IS NULL THEN
    RAISE EXCEPTION 'E_ORG_ROOT: 集团根组织不能移动（它没有上级）';
  END IF;
  IF p_new_parent IS NULL THEN
    RAISE EXCEPTION 'E_ORG_ROOT: 不能把组织移成根（一个帐套只有一个集团根）';
  END IF;
  IF p_new_parent = p_org THEN
    RAISE EXCEPTION 'E_ORG_CYCLE: 不能把组织移到它自己下面';
  END IF;

  SELECT * INTO v_parent FROM public.org_unit WHERE id = p_new_parent;
  IF v_parent.id IS NULL THEN RAISE EXCEPTION 'E_ORG_NO_PARENT: 上级组织 % 不存在', p_new_parent; END IF;
  IF NOT v_parent.is_active THEN
    RAISE EXCEPTION 'E_ORG_PARENT_INACTIVE: 上级「%」已停用，不能往里挂东西', v_parent.name;
  END IF;

  -- ① 防环：新上级不能在自己的子树里。这一条不做的话，递归 CTE 会直接跑死。
  IF v_parent.path = v_row.path OR v_parent.path LIKE v_row.path || '.%' THEN
    RAISE EXCEPTION 'E_ORG_CYCLE: 不能把「%」移到它自己的下级「%」下面',
      v_row.name, v_parent.name;
  END IF;

  -- ② 类型约束与建的时候同一套：部门下面只能挂部门；集团只能是根
  IF v_parent.kind = 'dept' AND v_row.kind <> 'dept' THEN
    RAISE EXCEPTION 'E_ORG_DEPTH: 部门下面只能再挂部门（要把「%」挂到「%」下面）',
      v_row.name, v_parent.name;
  END IF;
  IF v_row.kind = 'group' THEN
    RAISE EXCEPTION 'E_ORG_DEPTH: 集团只能作为根，不能挂到「%」下面', v_parent.name;
  END IF;

  -- ③ 深度：移的是**整棵子树**，要按子树最深的那一层算，不能只算自己
  SELECT max(array_length(string_to_array(path, '.'), 1)) INTO v_sub_depth
    FROM public.org_unit WHERE path = v_row.path OR path LIKE v_row.path || '.%';
  IF v_sub_depth - array_length(string_to_array(v_row.path, '.'), 1)
     + array_length(string_to_array(v_parent.path, '.'), 1) + 1 > 6 THEN
    RAISE EXCEPTION 'E_ORG_DEPTH: 移动后子树最深会到第 % 层（上限 6 层）',
      v_sub_depth - array_length(string_to_array(v_row.path, '.'), 1)
      + array_length(string_to_array(v_parent.path, '.'), 1) + 1;
  END IF;

  -- ④ 同父下重名：与改名同一条规矩
  IF EXISTS (SELECT 1 FROM public.org_unit
              WHERE parent_id = p_new_parent AND id <> p_org AND is_active
                AND btrim(name) = btrim(v_row.name)) THEN
    RAISE EXCEPTION 'E_ORG_DUP_NAME: 「%」下面已经有同名的「%」', v_parent.name, v_row.name;
  END IF;

  -- ⑤ 重算路径：自己 + 所有后代的 path 前缀一起换。
  --    path 是"父路径.序号"，所以只换前缀、保留后缀即可，不用逐层递归。
  SELECT COALESCE(max((substring(path from '([0-9]+)$'))::int), 0) + 1 INTO v_seq
    FROM public.org_unit WHERE parent_id = p_new_parent;
  v_new_path := v_parent.path || '.' || lpad(v_seq::text, 3, '0');
  v_old_path := v_row.path;

  UPDATE public.org_unit
     SET path = v_new_path || substring(path from length(v_old_path) + 1)
   WHERE path = v_old_path OR path LIKE v_old_path || '.%';

  UPDATE public.org_unit SET parent_id = p_new_parent WHERE id = p_org;
  RETURN v_new_path;
END;
$$;

COMMENT ON FUNCTION fn_org_move IS
  '组织换上级：防环、类型约束、整棵子树的深度上限、同父重名四条判据，'
  '并重写子树 path。人员归属（employee_org_assignment）不动 —— 换的是位置不是人。';

-- ---------------------------------------------------------------------------
-- 3. 停用 / 启用
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_org_set_active(p_org bigint, p_active boolean)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_row public.org_unit%ROWTYPE; v_n int; v_kids int;
BEGIN
  SELECT * INTO v_row FROM public.org_unit WHERE id = p_org;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'E_ORG_NOT_FOUND: 组织 % 不存在', p_org; END IF;
  IF v_row.is_active = p_active THEN RETURN p_active; END IF;

  IF NOT p_active THEN
    IF v_row.parent_id IS NULL THEN
      RAISE EXCEPTION 'E_ORG_ROOT: 集团根组织不能停用（整棵树挂在它下面）';
    END IF;

    -- ① 还有**在职人员**挂在这里 → 拒。
    --    停掉之后这些人的"成本部门"会变 NULL，而 NULL 在下游是"未分配"，
    --    不是"这个人没有部门" —— 两种意思混在一列里就再也分不开。
    SELECT count(*)::int INTO v_n
      FROM public.employee_org_assignment a
      JOIN public.employment e ON e.person_id = a.employee_id
     WHERE a.org_id = p_org AND a.dim_code = 'attendance_org' AND a.valid_to IS NULL
       AND daterange(e.hire_date, e.leave_date, '[]') @> public.app_today();
    IF v_n > 0 THEN
      RAISE EXCEPTION 'E_ORG_HAS_PEOPLE: 「%」还有 % 名在职人员，先把人调走或办离职', v_row.name, v_n;
    END IF;

    -- ② 还有**启用中的子部门** → 拒。否则树上出现"停用的父 + 启用的子"，
    --    子部门的人数永远滚不上来，而汇总页只会显示父节点 0 人。
    SELECT count(*)::int INTO v_kids
      FROM public.org_unit WHERE parent_id = p_org AND is_active;
    IF v_kids > 0 THEN
      RAISE EXCEPTION 'E_ORG_HAS_CHILDREN: 「%」下面还有 % 个启用中的下级，先停用下级', v_row.name, v_kids;
    END IF;
  ELSE
    -- ③ 启用要求上级是启用的：否则启用了一个"孤儿"，它在树上不可达。
    IF v_row.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.org_unit WHERE id = v_row.parent_id AND is_active) THEN
      RAISE EXCEPTION 'E_ORG_PARENT_INACTIVE: 上级已停用，先启用上级再启用「%」', v_row.name;
    END IF;
  END IF;

  UPDATE public.org_unit SET is_active = p_active WHERE id = p_org;
  RETURN p_active;
END;
$$;

COMMENT ON FUNCTION fn_org_set_active IS
  '组织停用/启用。停用前两条硬判据：没有在职人员、没有启用中的下级 —— '
  '两条不满足都拒绝并说清还差什么（不是"操作失败"）。';

-- ---------------------------------------------------------------------------
-- 4. 岗位停用 / 启用
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_position_active(p_pos bigint, p_active boolean)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_row public.position%ROWTYPE; v_n int;
BEGIN
  SELECT * INTO v_row FROM public.position WHERE id = p_pos;
  IF v_row.id IS NULL THEN RAISE EXCEPTION 'E_POS_NOT_FOUND: 岗位 % 不存在', p_pos; END IF;
  IF v_row.is_active = p_active THEN RETURN p_active; END IF;

  IF NOT p_active THEN
    SELECT count(*)::int INTO v_n FROM public.person_position
     WHERE position_id = p_pos
       AND daterange(valid_from, valid_to, '[]') @> public.app_today();
    IF v_n > 0 THEN
      RAISE EXCEPTION 'E_POS_HAS_HOLDERS: 「%」还有 % 人在岗，先撤任再停用', v_row.name, v_n;
    END IF;
  END IF;

  UPDATE public.position SET is_active = p_active WHERE id = p_pos;
  RETURN p_active;
END;
$$;

COMMENT ON FUNCTION fn_position_active IS
  '岗位停用：有在岗人员时拒绝（停用后在岗记录会变成"挂在一个不存在的岗位上"）。';

-- ---------------------------------------------------------------------------
-- 5. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.OM','组织维护：改名不重名、移动防环且整树路径重算、停用前无在职人员与启用下级',
   'ORG','STRUCT','fn_org_move','public','org_unit','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
