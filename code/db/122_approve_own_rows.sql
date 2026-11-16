-- ============================================================================
-- 122_approve_own_rows.sql · 审批只处理"分配给我的"那些行
-- ----------------------------------------------------------------------------
-- 119 的 fn_att_period_approve 是"整期一把批"：遍历所有 pending 行，
-- 只要有一个不是你批的，整个操作抛 E_ATT_NOT_APPROVER。
--
-- 上线第一次真跑就撞上了：31 人的月报里，30 人归周杰（hr_ops）、
-- 1 人归闫妍（周杰自己那一行不能由自己批，顺位落到下一个 HR）。
-- 于是周杰点"通过"直接被拒 —— 而界面上他明明看到 30 条写着"待 周杰 审批"。
--
-- 这不是小毛病：多门店/多部门时，审批人天然不是同一个人。
-- 一个"全批或全不批"的动作在这种结构下永远用不了。
--
-- 修法：
--   · 只处理 approver_person_id = 我 的行；
--   · 一行都不是我的 → 再区分"没有待审批"（E_ATT_NOT_PENDING）
--     与"有但你不在名单里"（E_ATT_NOT_APPROVER）—— 两者的处置完全不同；
--   · 仍然不允许自己批自己（提交人 ≠ 审批人）；
--   · 版本说明写清"批准 N 人，另有 M 人待别人批"，免得以为全批完了。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_att_period_approve(
  p_period varchar, p_entity bigint, p_by varchar, p_approve boolean, p_reason varchar)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r record;
  v_n int := 0;
  v_mine int := 0;
  v_pending int := 0;
  v_reason varchar(200) := btrim(COALESCE(p_reason, ''));
BEGIN
  IF p_approve IS FALSE AND length(v_reason) < 4 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 驳回必须写原因（至少 4 个字）';
  END IF;

  SELECT count(*)::int,
         count(*) FILTER (WHERE approver_person_id::text = p_by)::int
    INTO v_pending, v_mine
    FROM public.att_period_report
   WHERE period = p_period AND legal_entity_id = p_entity AND status = 'pending';

  IF v_pending = 0 THEN
    RAISE EXCEPTION 'E_ATT_NOT_PENDING: % 没有待审批的月报（先"提交"，再批）', p_period;
  END IF;

  -- ★ 先判"自己批自己"，再判"有没有分配给我"：
  --   提交人点"通过"时，两种提示都成立，但"你提交的单子不能自己批"才是他真正需要知道的那句。
  --   反过来先说"没有分配给你的"，会让人以为是配置问题，去改审批人 —— 改完还是不能批。
  IF EXISTS (SELECT 1 FROM public.att_period_report
              WHERE period = p_period AND legal_entity_id = p_entity
                AND status = 'pending' AND submitted_by = p_by) THEN
    RAISE EXCEPTION 'E_ATT_SELF_APPROVE: 提交人不能审批自己提交的月报（% 期间）', p_period;
  END IF;

  IF v_mine = 0 THEN
    RAISE EXCEPTION 'E_ATT_NOT_APPROVER: % 有 % 人待审批，但没有分配给你的（你是 %）',
      p_period, v_pending, p_by;
  END IF;

  FOR r IN SELECT id, person_id, submitted_by, approver_person_id
             FROM public.att_period_report
            WHERE period = p_period AND legal_entity_id = p_entity
              AND status = 'pending' AND approver_person_id::text = p_by
  LOOP
    -- ★ 自己不能批自己：改了数的人不该同时是"同意这个数"的人。
    --   这一条写在库里而不是界面上 —— 界面上藏按钮挡不住直接调接口。
    IF r.submitted_by = p_by THEN
      RAISE EXCEPTION 'E_ATT_SELF_APPROVE: 提交人不能审批自己提交的月报（% 人）', r.person_id;
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

  PERFORM public.fn_att_period_version_write(p_period, p_entity,
            CASE WHEN p_approve THEN 'approve' ELSE 'reject' END, p_by,
            CASE WHEN p_approve
                 THEN '审批通过 ' || v_n || ' 人' ||
                      CASE WHEN v_pending > v_n THEN '（另有 ' || (v_pending - v_n) || ' 人待别人批）'
                           ELSE '' END
                 ELSE '驳回 ' || v_n || ' 人：' || left(v_reason, 130) END);
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_att_period_approve IS
  '审批月报（只处理分配给我的行）：通过则 pending → confirmed，驳回回 draft 并记原因。'
  '自己不批自己；一行都不是我的 → E_ATT_NOT_APPROVER；没有待审批 → E_ATT_NOT_PENDING。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ATT5','多人审批：只批分配给我的、别人那部分保持待批、批完提示还剩几人',
   'ATTENDANCE','ACL','fn_att_period_approve','public','att_period_report','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
