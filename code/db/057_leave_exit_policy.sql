-- ============================================================================
-- 057_leave_exit_policy.sql · 离职时的剩余年假：做成配置项，默认什么都不做
-- ----------------------------------------------------------------------------
-- 054 那句"刻意不做"是对的：剩余年假怎么处理（作废 / 折现 / 结转）是**薪酬政策**，
-- 不是"离职"这个动作能替客户决定的。十个客户有九种口径，
-- 而写死一种的那一天，另一家客户的第一件事就是要求改它。
--
-- 但"不做"与"没得选"是两件事。客户问"我离职的人还剩 3 天年假怎么办"时，
-- 答案是"系统不管"——这不是专业回答。所以把它做成配置项，规矩照旧：
--
--   ① **默认值 = 上线前的实际行为**：`none`，额度一分不动。
--      默认值不许改变既有账，否则升级当天所有离职记录都会变。
--   ② **只允许集团定**（allow_org_override = false）：
--      同一个集团里两家店对"剩余年假"给不同答案，会让集团报表无法解释。
--   ③ **改配置 ⇒ 行为真的跟着变**，并且有反例断言（LT 组）。
--   ④ 边界写清楚：不追溯（已离职的人不会因为改政策而重算）、
--      不产生负数、不碰历史考勤与工资条。
--
-- **折现（payout）刻意不做**，理由不是"难"，是它压根不在这一个动作里：
-- 折现要单价（按基本工资还是按上月实发）、要不要计税、要不要计入社保基数、
-- 在下个月工资条里出一行还是单独一张单 —— 五个问题每一个都能让财务和 HR 吵起来。
-- 那是薪酬政策链上的另一件事（与 011 的 expire_policy='payout' 同一族），
-- 不该塞进"办离职"这个动作里假装解决了。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 制度项：离职时剩余年假怎么处理
-- ---------------------------------------------------------------------------
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('LEAVE_TERM_HANDLING', '离职时剩余年假怎么处理', 'LEAVE', 'enum', false, 'group', '')
ON CONFLICT (code) DO NOTHING;

-- 默认值 = 今天的行为：什么都不做
INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('LEAVE_TERM_HANDLING', '2026-01-01', 'none', 'group_hr',
        '默认=上线前的行为：额度一分不动，客户要作废再自己改')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. 台账补一个状态：forfeited（作废）
-- ---------------------------------------------------------------------------
-- ★ 为什么是"补一个状态"而不是"删掉那几条授予"：
--   删掉之后，"他曾经有 5 天"这段历史就不存在了，而它是一份事实。
--   作废是**发生过的事**，要在台账上留一行；否则对账时只能看到"少了 5 天"。
ALTER TABLE leave_usage DROP CONSTRAINT ck_lu_state;
ALTER TABLE leave_usage ADD CONSTRAINT ck_lu_state
  CHECK (state IN ('frozen','used','released','forfeited'));

COMMENT ON COLUMN leave_usage.state IS
  'frozen 冻结 / used 已用 / released 释放 / forfeited 离职作废（057）。'
  '作废不删授予行：删掉之后"他曾经有 5 天"就不是事实了。';

-- 四态变五态：available 要减掉作废，否则作废之后额度还能被申请。
-- ★ 必须 DROP 再建：CREATE OR REPLACE VIEW 只允许在**末尾追加**列，
--   在中间插一列会报 42P16（cannot change name of view column "available" to "forfeited"）
--   —— 那个报错读起来像"改错了名字"，实际是"列序变了"。
DROP VIEW IF EXISTS v_leave_balance;
CREATE VIEW v_leave_balance AS
WITH g AS (
  SELECT employee_id, leave_type_id,
         SUM(qty) FILTER (WHERE valid_to IS NULL OR valid_to >= current_date) AS granted,
         SUM(qty) FILTER (WHERE valid_to IS NOT NULL AND valid_to <  current_date) AS expired
    FROM leave_grant GROUP BY employee_id, leave_type_id
), u AS (
  SELECT employee_id, leave_type_id,
         SUM(qty) FILTER (WHERE state = 'frozen')    AS frozen,
         SUM(qty) FILTER (WHERE state = 'used')      AS used,
         SUM(qty) FILTER (WHERE state = 'forfeited') AS forfeited
    FROM leave_usage GROUP BY employee_id, leave_type_id
)
SELECT COALESCE(g.employee_id, u.employee_id)       AS employee_id,
       COALESCE(g.leave_type_id, u.leave_type_id)   AS leave_type_id,
       COALESCE(g.granted, 0)                        AS granted,
       COALESCE(g.expired, 0)                        AS expired,
       COALESCE(u.frozen, 0)                         AS frozen,
       COALESCE(u.used, 0)                           AS used,
       COALESCE(u.forfeited, 0)                      AS forfeited,
       COALESCE(g.granted, 0) - COALESCE(u.frozen, 0) - COALESCE(u.used, 0)
                              - COALESCE(u.forfeited, 0) AS available
  FROM g FULL JOIN u
    ON u.employee_id = g.employee_id AND u.leave_type_id = g.leave_type_id;

COMMENT ON VIEW v_leave_balance IS
  'available 由台账派生，不落列。存列的话申请/审批/到期/作废四处各自更新它，必然漂。';

-- ---------------------------------------------------------------------------
-- 3. 结算：按制度项决定动不动，动就在台账上留一行
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_leave_close_on_exit(p_employee bigint, p_on date)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_org   bigint;
  v_mode  varchar(16);
  v_rows  int := 0;
  r       record;
BEGIN
  -- 归属取**离职日当天仍有效**的那一条（归属区间是 '[]' 闭区间，所以还在）
  SELECT a.org_id INTO v_org
    FROM public.employee_org_assignment a
   WHERE a.employee_id = p_employee AND a.dim_code = 'cost_org'
     AND daterange(a.valid_from, a.valid_to, '[]') @> p_on
   ORDER BY a.valid_from DESC LIMIT 1;

  -- 没有任何归属时用集团值：制度项本身是集团定的，读不到才是问题
  IF v_org IS NULL THEN
    SELECT id INTO v_org FROM public.org_unit WHERE parent_id IS NULL LIMIT 1;
  END IF;

  SELECT value_text INTO v_mode
    FROM public.fn_policy_effective('LEAVE_TERM_HANDLING', v_org, p_on);

  IF v_mode IS NULL OR v_mode = 'none' THEN
    RETURN 0;                       -- 默认：额度一分不动（= 054 的行为）
  END IF;

  IF v_mode <> 'forfeit' THEN
    RAISE EXCEPTION 'E_LEAVE_TERM_MODE: 制度项 LEAVE_TERM_HANDLING 的取值 % 不认识'
      '（只支持 none / forfeit）', v_mode;
  END IF;

  -- ★ 还有待批的假时不许结算：那几张单还会改"剩余"，
  --   先结算再批假，余额会变成负数，而负数在页面上看起来像"系统算错了"。
  IF EXISTS (SELECT 1 FROM public.leave_usage
              WHERE employee_id = p_employee AND state = 'frozen') THEN
    RAISE EXCEPTION 'E_LEAVE_PENDING_ON_EXIT: 员工 % 还有待批的请假，'
      '先处理掉再办离职（否则结算完再批假，余额会变成负数）', p_employee;
  END IF;

  FOR r IN
    SELECT b.leave_type_id, b.available
      FROM public.v_leave_balance b
     WHERE b.employee_id = p_employee AND b.available > 0
  LOOP
    INSERT INTO public.leave_usage(employee_id, leave_type_id, qty, state, request_id)
    VALUES (p_employee, r.leave_type_id, r.available, 'forfeited', NULL);
    v_rows := v_rows + 1;
  END LOOP;

  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION fn_leave_close_on_exit IS
  '离职时按制度项 LEAVE_TERM_HANDLING 处理剩余额度：none 不动 / forfeit 核销。'
  '默认 none —— 配置项的默认值必须等于上线前的行为，否则升级当天所有离职都会变。'
  '有 frozen 单据时直接拒：先结算再批假会让余额变负。';

-- ---------------------------------------------------------------------------
-- 4. 离职函数接上这一步（054 的其余三步不动）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_emp_terminate(
  p_person     bigint,
  p_leave_date date,
  p_reason     varchar,
  p_by         varchar
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE e public.employment%ROWTYPE; v_id bigint; v_lv int;
BEGIN
  IF p_leave_date IS NULL THEN
    RAISE EXCEPTION 'E_TERM_NO_DATE: 离职日必填（"今天"在跨月那一天会变成另一天）';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'E_TERM_NO_REASON: 离职必须写原因（至少 4 个字）；'
      '只留一个日期，三个月后没人答得出"他为什么走"';
  END IF;

  SELECT * INTO e FROM public.employment
   WHERE person_id = p_person AND leave_date IS NULL
   ORDER BY hire_date DESC LIMIT 1
   FOR UPDATE;

  IF e.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.employment WHERE person_id = p_person) THEN
      RAISE EXCEPTION 'E_TERM_ALREADY_LEFT: 员工 % 的任职已经结束（再办一次会把日期改掉，'
        '而那天发过的工资不会跟着变）', p_person;
    END IF;
    RAISE EXCEPTION 'E_TERM_NO_EMPLOYMENT: 员工 % 没有任何任职记录', p_person;
  END IF;

  IF p_leave_date < e.hire_date THEN
    RAISE EXCEPTION 'E_TERM_BEFORE_HIRE: 离职日 % 早于入职日 %', p_leave_date, e.hire_date;
  END IF;

  -- ① 额度结算放在**结束归属之前**：结算要按归属找到成本组织，
  --    而下一步就会把归属区间的 valid_to 设成离职日（'[]' 闭区间虽然仍含当天，
  --    但"先结算再动归属"不依赖这个细节，少一处将来会被改坏的前提）。
  v_lv := public.fn_leave_close_on_exit(p_person, p_leave_date);

  -- ② 任职结束。★ 用 '[]' 闭区间：离职日当天仍然算在职（007 的规矩）
  UPDATE public.employment SET leave_date = p_leave_date WHERE id = e.id;

  -- ③ 归属区间一并结束 —— 不结束就会留下"人走了、归属还挂着"。
  UPDATE public.employee_org_assignment
     SET valid_to = p_leave_date
   WHERE employee_id = p_person AND valid_to IS NULL;

  -- ④ 留一条"为什么走"
  INSERT INTO public.employment_termination(employment_id, leave_date, reason, created_by)
  VALUES (e.id, p_leave_date, btrim(p_reason), p_by)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.LT','离职时剩余年假：配置项默认不动、改配置真的跟着变、有待批请假先拒',
   'PAYROLL','ACL',
   'fn_leave_close_on_exit','public','leave_usage','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-LP','配置项真的接进界面：制度页读得到 LEAVE_TERM_HANDLING',
   'PAYROLL','ACL',
   'fn_policy_effective','public','policy_def','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
