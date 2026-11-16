-- ============================================================================
-- 119_att_approval.sql · 月报生效要审批：HR 提交 → 部门主管（或 HR 主管）批
-- ----------------------------------------------------------------------------
-- 118 之前，月报是 draft 直接点"确认"就变 confirmed —— 也就是**改它的人自己批自己**。
-- 而月报决定的是全公司这个月发多少钱。这条链上少一道门，等于"调整即生效"。
--
-- 现实里的规矩（客户说的）：
--   HR 做完月报 → 提交 → 部门主管批（餐饮门店就是店长）→ 生效 → 传给薪资
--   没有部门主管时，落到 HR 主管。
--
-- 所以这一版：
--   ① 部门有"负责人"（org_unit.leader_person_id）—— 本来就该有，之前缺这一列
--   ② 状态多一档：draft → pending → confirmed（驳回则回 draft）
--   ③ 审批人解析：本部门负责人 → 沿部门树向上找 → HR 主管（hr_ops / payroll 岗位）
--   ④ 不能自己批自己（提交人 ≠ 审批人），这一条写在库里，不靠界面隐藏按钮
--
-- ★ 审批人解析为什么"沿树向上找"：
--   门店店长离职空缺时，应该落到区域负责人，而不是直接跳到 HR 主管 ——
--   离得最近的那一级最知道这个月到底发生了什么。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 部门负责人
-- ---------------------------------------------------------------------------
ALTER TABLE org_unit ADD COLUMN IF NOT EXISTS leader_person_id bigint;

COMMENT ON COLUMN org_unit.leader_person_id IS
  '部门负责人（月报考勤审批人）。门店=店长，部门=部门主管。空则沿上级部门找，再空则落到 HR 主管。';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ou_leader') THEN
    ALTER TABLE org_unit ADD CONSTRAINT fk_ou_leader
      FOREIGN KEY (leader_person_id) REFERENCES person(id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. 月报：加 pending 与提交/审批信息
-- ---------------------------------------------------------------------------
ALTER TABLE att_period_report
  ADD COLUMN IF NOT EXISTS submitted_by varchar(64),
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS approver_person_id bigint,
  ADD COLUMN IF NOT EXISTS rejected_reason varchar(200);

ALTER TABLE att_period_report DROP CONSTRAINT IF EXISTS ck_apr_status;
ALTER TABLE att_period_report ADD CONSTRAINT ck_apr_status
  CHECK (status IN ('draft','pending','confirmed'));

-- 提交后必须有提交人/时间和审批人：否则"待审批"这一格没人认领
ALTER TABLE att_period_report DROP CONSTRAINT IF EXISTS ck_apr_pending;
ALTER TABLE att_period_report ADD CONSTRAINT ck_apr_pending CHECK (
  status <> 'pending'
  OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL)
);

COMMENT ON COLUMN att_period_report.approver_person_id IS
  '这次提交指定的审批人（提交时解析并固定）。之后部门负责人变了也不改这一单 —— '
  '否则"谁批的"会随组织调整而漂移。';

-- ---------------------------------------------------------------------------
-- 3. 版本来源多两档
-- ---------------------------------------------------------------------------
ALTER TABLE att_period_version DROP CONSTRAINT IF EXISTS ck_apv_source;
ALTER TABLE att_period_version ADD CONSTRAINT ck_apv_source
  CHECK (source IN ('build','import','manual','confirm','reopen','submit','approve','reject'));

-- ---------------------------------------------------------------------------
-- 4. 审批人解析
-- ---------------------------------------------------------------------------
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

  -- ① 这个人期末所在部门
  --   维度优先取 attendance_org（考勤组织），没有则退回 cost_org（成本组织）——
  --   两个维度在多数公司指向同一个部门，但只配了一个的帐套也不能因此没人可批。
  SELECT a.org_id INTO v_org
    FROM public.employee_org_assignment a
   WHERE a.employee_id = p_person
     AND a.dim_code IN ('attendance_org','cost_org')
     AND daterange(a.valid_from, a.valid_to, '[]') @> v_end
   ORDER BY (a.dim_code = 'attendance_org') DESC, a.valid_from DESC
   LIMIT 1;

  -- ② 本部门有负责人就用它
  IF v_org IS NOT NULL THEN
    SELECT o.leader_person_id INTO v_leader FROM public.org_unit o WHERE o.id = v_org;
    IF v_leader IS NOT NULL AND v_leader <> p_person THEN
      RETURN v_leader;
    END IF;

    -- ③ 沿部门树向上找：店长空缺时落到区域，而不是直接跳到 HR 主管
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

  -- ④ 落到 HR 主管：有 hr_ops / payroll 类岗位且在职的人
  SELECT pp.person_id INTO v_leader
    FROM public.person_position pp
    JOIN public.position po ON po.id = pp.position_id
   WHERE po.code IN ('HR_MGR','HR_OPS','PAYROLL_MGR','PAYROLL_SPEC')
     AND daterange(pp.valid_from, pp.valid_to, '[]') @> v_end
     AND pp.person_id <> p_person
   ORDER BY pp.valid_from DESC LIMIT 1;

  RETURN v_leader;   -- 仍为空时，调用方要求指定审批人
END;
$$;

COMMENT ON FUNCTION fn_att_approver IS
  '月报审批人：本部门负责人 → 沿部门树向上 → HR 主管（hr/payroll 岗位）。'
  '都为空时返回 NULL，提交方必须显式指定 —— 不允许"没人批就自动通过"。';

-- ---------------------------------------------------------------------------
-- 5. 提交（draft → pending）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_att_period_submit(
  p_period varchar, p_entity bigint, p_by varchar, p_approver bigint DEFAULT NULL)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
-- ★ v_n 必须初始化为 0：plpgsql 里没初始化的 integer 是 NULL，
-- 而 NULL + 1 还是 NULL —— 函数会"更新成功但返回 0"，
-- 调用方看到 0 会以为没提交，实际已经改了状态。
DECLARE v_n int := 0; v_approver bigint; r record; v_missing text;
BEGIN
  -- 全部行都得是 draft：一半 draft 一半 pending 会让"这期提交了没有"说不清
  IF EXISTS (SELECT 1 FROM public.att_period_report
              WHERE period = p_period AND legal_entity_id = p_entity AND status <> 'draft') THEN
    IF EXISTS (SELECT 1 FROM public.att_period_report
                WHERE period = p_period AND legal_entity_id = p_entity AND status = 'pending') THEN
      RAISE EXCEPTION 'E_ATT_ALREADY_PENDING: % 已提交待审批，不要重复提交', p_period;
    END IF;
    RAISE EXCEPTION 'E_ATT_ALREADY_CONFIRMED: % 已确认', p_period;
  END IF;

  FOR r IN SELECT id, person_id FROM public.att_period_report
            WHERE period = p_period AND legal_entity_id = p_entity
  LOOP
    v_approver := COALESCE(p_approver, public.fn_att_approver(r.person_id, p_period));
    IF v_approver IS NULL THEN
      v_missing := COALESCE(v_missing, '') || r.person_id || ' ';
    END IF;
    UPDATE public.att_period_report
       SET status = 'pending', submitted_by = p_by, submitted_at = now(),
           approver_person_id = v_approver, rejected_reason = NULL, updated_at = now()
     WHERE id = r.id;
    v_n := v_n + 1;
  END LOOP;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'E_ATT_NO_APPROVER: 这些人找不到审批人（部门未设负责人且无 HR 主管）：%。'
      '请先设部门负责人，或在提交时指定审批人', v_missing;
  END IF;

  PERFORM public.fn_att_period_version_write(p_period, p_entity, 'submit', p_by,
            '提交审批 ' || v_n || ' 人');
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_att_period_submit IS
  '把一期月报整体提交审批（draft → pending），并固定每行的审批人。'
  '找不到审批人就整批拒 —— 不允许"没人批就自动过"。';

-- ---------------------------------------------------------------------------
-- 6. 审批（pending → confirmed / 驳回回 draft）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_att_period_approve(
  p_period varchar, p_entity bigint, p_by varchar, p_approve boolean, p_reason varchar)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r record;
  v_n int := 0;
  v_reason varchar(200) := btrim(COALESCE(p_reason, ''));
BEGIN
  IF p_approve IS FALSE AND length(v_reason) < 4 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 驳回必须写原因（至少 4 个字）';
  END IF;

  FOR r IN SELECT id, person_id, submitted_by, approver_person_id
             FROM public.att_period_report
            WHERE period = p_period AND legal_entity_id = p_entity AND status = 'pending'
  LOOP
    -- ★ 自己不能批自己：改了数的人不该同时是"同意这个数"的人。
    --   这一条写在库里而不是界面上 —— 界面上藏按钮挡不住直接调接口。
    IF r.submitted_by = p_by THEN
      RAISE EXCEPTION 'E_ATT_SELF_APPROVE: 提交人不能审批自己提交的月报（% 人）', r.person_id;
    END IF;
    IF r.approver_person_id IS NOT NULL AND r.approver_person_id::text <> p_by THEN
      RAISE EXCEPTION 'E_ATT_NOT_APPROVER: 你不是这一单的审批人（指定审批人 %）',
        r.approver_person_id;
    END IF;

    IF p_approve THEN
      UPDATE public.att_period_report
         SET status = 'confirmed', confirmed_by = p_by, confirmed_at = now(),
             rejected_reason = NULL, updated_at = now()
       WHERE id = r.id;
    ELSE
      UPDATE public.att_period_report
         SET status = 'draft', submitted_by = NULL, submitted_at = NULL,
             approver_person_id = NULL, rejected_reason = left(v_reason, 200),
             updated_at = now()
       WHERE id = r.id;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'E_ATT_NOT_PENDING: % 没有待审批的月报（先"提交"，再批）', p_period;
  END IF;

  PERFORM public.fn_att_period_version_write(p_period, p_entity,
            CASE WHEN p_approve THEN 'approve' ELSE 'reject' END, p_by,
            CASE WHEN p_approve THEN '审批通过 ' || v_n || ' 人'
                 ELSE '驳回：' || left(v_reason, 150) END);
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_att_period_approve IS
  '审批月报：通过则 pending → confirmed；驳回则回 draft 并记原因。'
  '提交人不能批自己；只有被指定的审批人能批。两者都在库里判，不靠界面。';

-- ---------------------------------------------------------------------------
-- 7. 老的"直接确认"收口
-- ---------------------------------------------------------------------------
-- 118 之前 fn_att_period_confirm 能把 draft 直接变 confirmed（绕过审批）。
-- 现在它只接受 pending：留这个名字是因为接口与历史脚本还在用，
-- 但语义收窄成"审批通过的落库动作"，不再是一条绕过门的路。
CREATE OR REPLACE FUNCTION fn_att_period_confirm(
  p_period varchar, p_entity bigint, p_by varchar)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.att_period_report
     SET status = 'confirmed', confirmed_by = p_by, confirmed_at = now(), updated_at = now()
   WHERE period = p_period AND legal_entity_id = p_entity AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'E_ATT_NOT_PENDING: % 没有待审批的月报；'
      '现在确认必须走"提交 → 主管审批"（fn_att_period_submit / fn_att_period_approve）', p_period;
  END IF;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_att_period_confirm IS
  '把**待审批**的月报置为已确认。draft 不能直接确认 —— 那等于改数的人自己批自己。';

-- ---------------------------------------------------------------------------
-- 8. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ATT3','月报审批：提交→主管批生效/自己不能批自己/非审批人拒/驳回回草稿',
   'ATTENDANCE','ACL','fn_att_period_approve','public','att_period_report','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
