-- ===========================================================================
-- 042_leave_approval_mode.sql · 「请假要不要多步审批」是客户的口径，不是我的
-- ---------------------------------------------------------------------------
-- 到 041 为止，请假有两条审批路径：
--
--   单签  `/api/leave/decide`  →  `fn_leave_decide_by`（一个人点一下）
--   多步  `/api/approval/*`    →  引擎（模板 / 会签 / 转签）
--
-- 两条路同时存在，是这一整套代码里最明显的一处「同一个决定有两种实现」。
-- 但我**不该替客户选**：三个人小店要单签，三百人连锁必须多步；
-- 而"哪种假别必须多步"是管理决定，不是技术默认。
--
-- 所以做成**配置项**，默认值 = 上线前的实际行为（单签），
-- 并且**按业务日期取值**（与模板版本同一条规矩：补录旧单按当时的规矩办）。
--
-- ★ 这一条也是「配置项必须真的接线」的样板：AL 组用 6 月/7 月两张单做反例，
--   证明改配置之后**行为真的变了**，而不是只登记了一条记录。
-- ===========================================================================

INSERT INTO policy_def(code,name,domain,value_type,allow_org_override,override_floor,unit) VALUES
  ('LEAVE_APPROVAL','请假审批方式（单签 / 多步）','LEAVE','enum',false,'group','')
ON CONFLICT (code) DO NOTHING;

-- 三个版本，按日期切换：1 月起单签（默认）→ 6 月起多步 → 7 月又回单签。
-- 三个版本在演示里都有用：同一套代码，靠日期就能走到不同分支。
INSERT INTO policy_value(policy_code,effective_from,value_text,published_by,reason) VALUES
  ('LEAVE_APPROVAL','2026-01-01','single','group_hr','默认单签：与上线前的实际行为一致'),
  ('LEAVE_APPROVAL','2026-06-01','multi', 'group_hr','6 月起请假必须走多步审批（演示/试点）'),
  ('LEAVE_APPROVAL','2026-07-01','single','group_hr','试点结束，回到单签')
ON CONFLICT (policy_code,effective_from) DO NOTHING;

CREATE OR REPLACE FUNCTION fn_leave_approval_mode(p_on date)
RETURNS varchar
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE v varchar;
BEGIN
  SELECT value_text INTO v
    FROM public.fn_policy_effective('LEAVE_APPROVAL', 1, p_on);

  -- ★ 值域必须显式判。配置项写错一个字母，行为会静默落进 ELSE 分支，
  --   而"落进 ELSE"在那一天看起来完全正常。
  IF v IS NULL OR v NOT IN ('single','multi') THEN
    RAISE EXCEPTION 'E_POLICY_INVALID: LEAVE_APPROVAL 只能是 single / multi（收到 %）', v;
  END IF;
  RETURN v;
END;
$$;

COMMENT ON FUNCTION fn_leave_approval_mode IS
  '按业务日期取请假审批方式。默认 single（与上线前行为一致）；'
  'multi 时申请会自动开一个审批实例，且单签入口被拒。';

-- ---------------------------------------------------------------------------
-- 申请：multi 模式下**同一事务内**开审批实例
-- ---------------------------------------------------------------------------
-- ★ 放在这里而不是服务层，是因为"申请"这件事一旦留下单据，就必须已经决定
--   "谁来审"。放在服务层的话，运维脚本 / MCP 工具 / 另一个客户端申请出来的单
--   会是一张**没人审**的单 —— 而它看起来和正常单一样。
CREATE OR REPLACE FUNCTION fn_leave_apply(
  p_employee bigint, p_type bigint, p_qty numeric,
  p_from date, p_to date
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO public.leave_request(employee_id, leave_type_id, qty, date_from, date_to)
  VALUES (p_employee, p_type, p_qty, p_from, p_to)
  RETURNING id INTO v_id;

  PERFORM public.fn_leave_freeze(p_employee, p_type, p_qty, v_id);

  IF public.fn_leave_approval_mode(p_from) = 'multi' THEN
    -- 失败会抛（无模板 / 无人可审），整个申请回滚 —— 不留"单据在、没人审"
    PERFORM public.fn_appr_start('LEAVE', 'leave', v_id, p_from);
  END IF;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 单签入口：multi 模式下必须拒绝，并指向正确的入口
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_leave_decide_by(
  p_request bigint, p_approve boolean, p_approver bigint
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_owner bigint; v_status varchar(16); v_from date;
BEGIN
  SELECT employee_id, status, date_from INTO v_owner, v_status, v_from
    FROM public.leave_request WHERE id = p_request FOR UPDATE;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'E_LEAVE_NO_REQUEST: 请假单 % 不存在', p_request;
  END IF;

  -- ★ 该走多步的单，不许从单签入口批准。允许的话，多步审批就只是一个
  --   "可选流程"—— 而绕开它的那条路更短，人一定会走那条。
  IF public.fn_leave_approval_mode(v_from) = 'multi' THEN
    RAISE EXCEPTION 'E_LEAVE_USE_APPROVAL: 本单按制度需走多步审批，请使用审批接口（/api/approval/*）';
  END IF;

  IF v_owner = p_approver THEN
    RAISE EXCEPTION 'E_LEAVE_SELF_APPROVE: 请假单 % 的申请人不能自己审批', p_request;
  END IF;

  PERFORM public.fn_leave_decide(p_request, p_approve);
END;
$$;

COMMENT ON FUNCTION fn_leave_decide_by IS
  '带审批人身份的决定入口。multi 模式下直接拒绝（E_LEAVE_USE_APPROVAL）——'
  '否则多步审批只是"可选流程"，而绕开它的路更短。';

-- ---------------------------------------------------------------------------
-- 引擎回写：不能再走 _by（那条路现在会拒绝）
-- ---------------------------------------------------------------------------
-- ★ 引擎已经把申请人从审批人集合里剔除过（032），所以这里直接调用 base 版本。
--   这不是"绕过校验"，是**两条路各有各的守卫**：单签守卫在人这一侧，
--   多步守卫在实例这一侧。
CREATE OR REPLACE FUNCTION fn_appr_sync_biz(
  p_biz_type varchar, p_biz_id bigint, p_approve boolean, p_by bigint
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_biz_type = 'leave' THEN
    PERFORM public.fn_leave_decide(p_biz_id, p_approve);
  ELSE
    RAISE EXCEPTION 'E_APPR_NO_BIZ_SYNC: 业务类型 % 还没有回写实现', p_biz_type;
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_appr_sync_biz IS
  '审批结果 → 业务单据的唯一回写点。走 fn_leave_decide（不走 _by）：'
  '申请人的剔除在启动时已经做过，这里是"引擎内"的推进，不是"人"在批。';

-- 断言组登记
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.AL','请假审批方式：配置项真的接线（改配置⇒行为变）','INTEGRATION','ALGORITHM',
   NULL,NULL,NULL,NULL,'team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-AL','请假审批方式：接口侧同一条反例','INTEGRATION','ALGORITHM',
   NULL,NULL,NULL,NULL,'team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
