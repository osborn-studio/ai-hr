-- ============================================================================
-- 048_approval_addsign_cc.sql · 加签与抄送：把「谁还要看」和「谁还要签」分开
-- ----------------------------------------------------------------------------
-- 041 做了转签（换人），045 做了代理（代签）。还差两件事，而它们经常被混成一件：
--
--   加签：**还要有人签**。它改变审批能否推进 —— 所以它是「决定」。
--   抄送：**还要有人知道**。它不改变任何结论 —— 所以它是「通知」。
--
-- 混成一件事的后果很具体：抄送的人被算进"这一步有几个待办"，
-- 于是流程永远差一个人；或者反过来，需要签的人只被通知了一声，单据就过了。
-- 所以这里是**两张表、两条路径**，没有 "cc=true" 这种开关。
--
-- 加签的四条判据（都是"不加就会错"的）：
--   ① 只能加在**当前步**：加到已结束的步骤，那次会签已经算过了，加了也不再生效。
--   ② 只能加在**还没人动过**的步骤：本步一旦有人通过/驳回，结算条件已经成立，
--      此时加签等于改历史（而且"或签"下剩余待办已被 skipped，加了也推进不了）。
--   ③ 不能加**申请人**：自审的另一个入口，与 032 在启动时剔除申请人同一条理由。
--   ④ 必须写**理由**：加签是"我临时改变了谁能决定这件事"，事后要答得出为什么。
--
-- 一条刻意的取舍：加签**不校验**加签人的角色。
-- 加签这个动作的语义就是"临时指定一个人来签，不管他平时的角色"。
-- 校验角色等于禁止加签 —— 因为能被加签的人，通常正是没有那个角色的人。
-- 但**加签人不能是申请人**（③），且必须写理由（④），这两条不放松。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 抄送：一张只读的表，不参与任何推进计算
-- ---------------------------------------------------------------------------
CREATE TABLE approval_cc (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instance_id bigint NOT NULL REFERENCES approval_instance(id),
  user_id     bigint NOT NULL,
  added_by    bigint NOT NULL,
  added_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at     timestamptz,
  -- ★ 同一个人对同一张单只抄一次：抄送是通知，重复通知没有意义，
  --   而它会让"抄送了几个人"这个数虚高。
  CONSTRAINT uk_ac_one UNIQUE (instance_id, user_id)
);

CREATE INDEX ix_ac_user ON approval_cc(user_id) WHERE seen_at IS NULL;

COMMENT ON TABLE approval_cc IS
  '抄送：只通知、不参与推进。刻意与 approval_task 分开 —— '
  '混成一张表，抄送的人会被算进"这一步还剩几个待办"，流程就永远差一个人。';

-- ---------------------------------------------------------------------------
-- 2. 加签：往当前步插一个**必须签**的待办
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_appr_addsign(
  p_task_id bigint, p_user bigint, p_by bigint, p_reason varchar
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  t public.approval_task%ROWTYPE;
  v_st varchar(16); v_biz_type varchar; v_biz_id bigint;
  v_cur int; v_app bigint; v_new bigint;
BEGIN
  SELECT * INTO t FROM public.approval_task WHERE id = p_task_id FOR UPDATE;
  IF t.id IS NULL THEN
    RAISE EXCEPTION 'E_APPR_NO_TASK: 任务 % 不存在', p_task_id;
  END IF;

  SELECT status, biz_type, biz_id INTO v_st, v_biz_type, v_biz_id
    FROM public.approval_instance WHERE id = t.instance_id FOR UPDATE;
  IF v_st <> 'running' THEN
    RAISE EXCEPTION 'E_APPR_FINISHED: 实例 % 已 %，不能再加签', t.instance_id, v_st;
  END IF;

  -- ① 只能加在当前步
  SELECT min(seq) INTO v_cur FROM public.approval_task
   WHERE instance_id = t.instance_id AND status = 'pending';
  IF v_cur IS DISTINCT FROM t.seq THEN
    RAISE EXCEPTION 'E_APPR_NOT_CURRENT_STEP: 只能给当前步（第 % 步）加签，本次是第 % 步',
      v_cur, t.seq;
  END IF;

  -- ② 本步还没人动过
  IF EXISTS (SELECT 1 FROM public.approval_task
              WHERE instance_id = t.instance_id AND seq = t.seq AND status <> 'pending') THEN
    RAISE EXCEPTION 'E_APPR_ADDSIGN_CLOSED: 第 % 步已经有人处理过，'
      '此时加签不改变结论（或签下剩余待办已 skip），要改结论请驳回后重提', t.seq;
  END IF;

  -- ④ 必须写理由
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'E_APPR_ADDSIGN_NO_REASON: 加签必须写原因（至少 4 个字）';
  END IF;

  -- ③ 不能加申请人
  v_app := public.fn_appr_biz_applicant(v_biz_type, v_biz_id);
  IF p_user = v_app THEN
    RAISE EXCEPTION 'E_APPR_ADDSIGN_APPLICANT: % 是申请人，不能加签给申请人（自审）', p_user;
  END IF;

  IF EXISTS (SELECT 1 FROM public.approval_task
              WHERE instance_id = t.instance_id AND seq = t.seq AND approver_id = p_user) THEN
    RAISE EXCEPTION 'E_APPR_ADDSIGN_DUPLICATE: % 已经是第 % 步的审批人', p_user, t.seq;
  END IF;

  -- ★ act_kind 固定 'countersign'：加签的语义就是"他必须签"。
  --   写成 'approve' 的话，或签步骤里谁先点都算完 —— 那等于加了个寂寞。
  INSERT INTO public.approval_task(instance_id, seq, approver_id, act_kind)
  VALUES (t.instance_id, t.seq, p_user, 'countersign')
  RETURNING id INTO v_new;

  INSERT INTO public.approval_task_log(task_id, action, from_user, to_user, by_user, reason)
  VALUES (t.id, 'addsign', t.approver_id, p_user, p_by, btrim(p_reason));

  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION fn_appr_addsign IS
  '给**当前未结算的步**加一个必须签的审批人。加签改变结论，抄送不改变 —— '
  '所以它落 approval_task（act_kind=countersign），不是 approval_cc。';

-- ---------------------------------------------------------------------------
-- 3. 抄送：幂等（重复抄送同一个人不报错，也不多一行）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_appr_cc_add(
  p_instance bigint, p_user bigint, p_by bigint
) RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_st varchar(16);
BEGIN
  SELECT status INTO v_st FROM public.approval_instance WHERE id = p_instance;
  IF v_st IS NULL THEN
    RAISE EXCEPTION 'E_APPR_NO_INSTANCE: 审批实例 % 不存在', p_instance;
  END IF;

  INSERT INTO public.approval_cc(instance_id, user_id, added_by)
  VALUES (p_instance, p_user, p_by)
  ON CONFLICT (instance_id, user_id) DO NOTHING;

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION fn_appr_cc_add IS
  '抄送（幂等）。抄送不参与推进 —— 抄送的人在 approval_cc 里，不在 approval_task 里。';

-- ---------------------------------------------------------------------------
-- 4. 我的抄送（只留未读的，读过的从"要看"里消失但记录还在）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_my_cc AS
SELECT c.id, c.instance_id, c.user_id, c.added_at, c.seen_at,
       a.biz_type, a.biz_id, a.status AS instance_status, a.started_at
  FROM approval_cc c
  JOIN approval_instance a ON a.id = c.instance_id;

COMMENT ON VIEW v_my_cc IS
  '抄送清单。按 user_id 过滤由调用方做 —— 视图不猜"你是谁"。';

CREATE OR REPLACE FUNCTION fn_appr_cc_seen(p_cc_id bigint, p_user bigint)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_owner bigint;
BEGIN
  SELECT user_id INTO v_owner FROM public.approval_cc WHERE id = p_cc_id FOR UPDATE;
  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'E_APPR_CC_NOT_FOUND: 抄送 % 不存在', p_cc_id;
  END IF;
  -- ★ 只能标记自己那一条。不带 user 条件的"标记已读"，一定会在某个客户端
  --   被传成别人的 id —— 于是别人的抄送被清空，而没人知道为什么。
  IF v_owner <> p_user THEN
    RAISE EXCEPTION 'E_OUT_OF_SCOPE: 抄送 % 不属于用户 %', p_cc_id, p_user;
  END IF;
  UPDATE public.approval_cc SET seen_at = clock_timestamp()
   WHERE id = p_cc_id AND seen_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.AP','加签与抄送：改变结论 vs 只通知','INTEGRATION','ALGORITHM',
   'fn_appr_addsign','public','approval_task','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-AP','加签与抄送的接口侧','INTEGRATION','ALGORITHM',
   'fn_appr_cc_add','public','approval_cc','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
