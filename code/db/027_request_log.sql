-- ============================================================================
-- 027_request_log.sql · 请求级留痕
-- ----------------------------------------------------------------------------
-- 004 的 sys_audit_log 是**行级**的：它回答"这一行业务数据被谁改了"。
-- 但有一类事它答不了：**没有改到任何行的请求**。
--
--   额度不够被拒、越权被封 403、重复审批被挡、plan 过期——
--   这些发生在写入之前，磁盘上什么都没变，于是行级审计一条都不会有。
--
-- 而它们恰恰是最该被看见的：
--   · 同一个人一天试了二十次超额度申请 —— 是流程没讲清，还是有人在探边界？
--   · 某个账号反复触发 403 —— 是权限配错了，还是账号被盗了？
--
-- ★ 一条反直觉的约束：**这一层不能写在业务事务里。**
--   写在事务里，失败时会被 ROLLBACK 一起删掉——
--   而失败的尝试正是它存在的理由。
--   所以它在事务外写：成功失败各记一条，ok 字段区分。
-- ============================================================================

CREATE TABLE app_request_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor      varchar(64) NOT NULL,
  action     varchar(64) NOT NULL,
  subject    varchar(96),
  ok         boolean     NOT NULL,
  error_code varchar(48),
  detail     jsonb
);

CREATE INDEX ix_arl_actor_at ON app_request_log(actor, at DESC);
CREATE INDEX ix_arl_fail     ON app_request_log(at DESC) WHERE NOT ok;

COMMENT ON TABLE app_request_log IS
  '请求级留痕。行级审计（sys_audit_log）答不了"没有改到任何行的请求"，'
  '而那一类恰恰最容易藏着越权探测。本表写在业务事务之外——'
  '写在里面的话，失败时会随 ROLLBACK 一起消失，而失败正是它存在的理由。';

CREATE OR REPLACE FUNCTION fn_req_log(
  p_actor varchar, p_action varchar, p_subject varchar,
  p_ok boolean, p_error varchar DEFAULT NULL, p_detail jsonb DEFAULT NULL
) RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  INSERT INTO public.app_request_log(actor, action, subject, ok, error_code, detail)
  VALUES (p_actor, p_action, p_subject, p_ok, p_error, p_detail);
$$;

-- 越权探测：同一账号在窗口内失败次数
CREATE OR REPLACE FUNCTION fn_req_failures(p_actor varchar, p_minutes int DEFAULT 60)
RETURNS TABLE (action varchar(64), n int, last_at timestamptz)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT action, count(*)::int, max(at)
    FROM public.app_request_log
   WHERE actor = p_actor AND NOT ok AND at > clock_timestamp() - make_interval(mins => p_minutes)
   GROUP BY action
   ORDER BY 2 DESC;
$$;

COMMENT ON FUNCTION fn_req_failures IS
  '按动作分组，不合并成一个总数。'
  '"这个人失败了 20 次"与"这个人某一种操作失败了 20 次"处置完全不同：'
  '前者像账号问题，后者像流程或权限没配好。';

-- ---------------------------------------------------------------------------
-- 附：服务层需要的一条业务约束（放在库里，不放在服务里）
-- ---------------------------------------------------------------------------
-- ★ 申请人不能审批自己的单。
--   这条如果写在服务层，任何绕过服务的路径（运维脚本、MCP 工具、以后的另一个
--   客户端）都不受它约束——而"绕过"这件事在系统变大之后一定会发生。
--   放库里，则所有路径共用。
CREATE OR REPLACE FUNCTION fn_leave_decide_by(
  p_request bigint, p_approve boolean, p_approver bigint
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_owner bigint; v_status varchar(16);
BEGIN
  SELECT employee_id, status INTO v_owner, v_status
    FROM public.leave_request WHERE id = p_request FOR UPDATE;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'E_LEAVE_NO_REQUEST: 请假单 % 不存在', p_request;
  END IF;

  -- ★ 自审必须拒。它和"两个人之间"的 SOD 是同一件事的退化情形：
  --   一个人自己申请、自己批准，流程记录完整、审批人齐全，而没有任何人看过。
  IF v_owner = p_approver THEN
    RAISE EXCEPTION 'E_LEAVE_SELF_APPROVE: 请假单 % 的申请人不能自己审批', p_request;
  END IF;

  PERFORM public.fn_leave_decide(p_request, p_approve);
END;
$$;

COMMENT ON FUNCTION fn_leave_decide_by IS
  '带审批人身份的决定入口。自审在这里被拒——'
  '写在服务层的话，运维脚本、MCP 工具、以后的另一个客户端都可以绕过它。';
