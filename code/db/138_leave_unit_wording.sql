-- ===========================================================================
-- 138 · 假期的单位口径：额度说的是"天"，不是"小时"
-- ===========================================================================
-- 起因：申请事假被拒时，报的是
--   E_LEAVE_OVER_QUOTA: 可用 0 小时，申请 1 小时
-- 而全系统的假期额度都按**天**记：leave_grant.qty = 10（天）、
-- 工资条上的事假扣款 = 日薪 × 天数、界面上写"可用 3 天"。
--
-- 这个错不是"文案不好看"：
--   · HR 看到"小时"会以为系统按小时记假，于是去算 8 小时/天，对不上账；
--   · 员工看到"可用 0 小时"会以为"我还有 0.5 天，为什么不能请半天"——
--     而实际是把 10 天记成了 10 小时，真正的额度早就被读错了。
-- 一句话说错单位，会让人怀疑整套数。
--
-- ★ 不改 011：迁移一旦发布只新增。函数体从 011 原样抄过来，只改这一行文案。
--   （抄的时候要确认之后没有迁移重建过它 —— 011 之后确实没有重建 fn_leave_freeze，
--     只有 013 / 042 重建过 fn_leave_apply。）
CREATE OR REPLACE FUNCTION fn_leave_freeze(
  p_employee bigint, p_type bigint, p_qty numeric, p_request bigint
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_avail numeric;
BEGIN
  PERFORM 1 FROM public.leave_grant
   WHERE employee_id = p_employee AND leave_type_id = p_type FOR UPDATE;

  SELECT COALESCE(available, 0) INTO v_avail
    FROM public.v_leave_balance
   WHERE employee_id = p_employee AND leave_type_id = p_type;

  IF p_qty > COALESCE(v_avail, 0) THEN
    -- 单位写"天"，并且把假种名字带上：同一个员工可能同时请年假与事假，
    -- 只说"额度不足"不说是哪种，人会去查错那一栏。
    RAISE EXCEPTION 'E_LEAVE_OVER_QUOTA: % 额度不足 —— 可用 % 天，申请 % 天',
      (SELECT name FROM public.leave_type WHERE id = p_type),
      COALESCE(v_avail, 0), p_qty;
  END IF;

  INSERT INTO public.leave_usage(employee_id, leave_type_id, qty, state, request_id)
  VALUES (p_employee, p_type, p_qty, 'frozen', p_request);
END;
$$;

COMMENT ON FUNCTION fn_leave_freeze IS
  '提交请假时冻结额度。额度单位是**天**（与 leave_grant.qty、日薪扣款一致），'
  '报错文案必须说天 —— 说小时会让人以为系统按小时记假。';

-- ---------------------------------------------------------------------------
-- 判据组登记：假期域的两个页面
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.LVU','假期额度的单位口径：报错说"天"、带假种名，且数字与余额视图一致',
   'ATTENDANCE','ALGORITHM','fn_leave_freeze','public','leave_request','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-LB','假期额度与请假单：按花名册行闸、没额度的人也列出来、待审不受时间窗限制',
   'ATTENDANCE','ACL','v_leave_balance','public','leave_request','VIEW',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
