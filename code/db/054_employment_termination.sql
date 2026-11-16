-- ============================================================================
-- 054_employment_termination.sql · 离职：第七个「表在、门没有」
-- ----------------------------------------------------------------------------
-- `employment.leave_date` 从 007 就在，注释里甚至写着"离职日当天仍算在职"。
-- 但它**没有写入路径**：只能靠种子写，或者直接 UPDATE。
--
-- 这是这个仓库的第七次同一个形态。而离职这一件比前六次都更危险，因为它有**连带**：
--
--   ① 人走了，`employee_org_assignment` 还挂着 → 花名册里看不到他，
--      但"这个门店有多少人"的归属口径还数着他。**两处都自洽，加起来错。**
--   ② 离职**没有原因** → `leave_date` 只有日期。而"为什么走"是 HR 一定会问的，
--      答不出来时人会去翻微信，然后凭印象写报告。
--   ③ 离职可以**重复办** → 第二次把日期改掉，而第一次那天发过的工资不会跟着变。
--
-- 三条对应的做法：
--   · 离职 = 一个函数：写 leave_date + 结束归属区间 + 落一条离职记录，**同一事务**
--   · 离职原因与日期进 `employment_termination`（只增不改）
--   · 已离职再办 → 有名字的拒绝，不是静默覆盖
--
-- 刻意**不动**的三件事：
--   · 历史考勤与工资条：那是已经发生的事实，离职不改变它
--   · 未封账的考勤：封账是门店的动作，不是人的动作
--   · 假期额度：剩余年假怎么结算（折现 / 作废 / 结转）是薪酬政策，
--     不是"离职"这个动作能替客户决定的 —— 见 042 那条同样的取舍
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 离职记录（只增不改）：日期之外还要留下"为什么"与"谁办的"
-- ---------------------------------------------------------------------------
CREATE TABLE employment_termination (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employment_id bigint      NOT NULL REFERENCES employment(id),
  leave_date    date        NOT NULL,
  reason        varchar(200) NOT NULL,
  created_by    varchar(64) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 同一段任职只能离职一次：重复办会把日期改掉，而那天发过的钱不会跟着变
  CONSTRAINT uk_et_once UNIQUE (employment_id),
  CONSTRAINT ck_et_reason CHECK (length(btrim(reason)) >= 4)
);

CREATE OR REPLACE FUNCTION fn_et_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'E_ET_NO_DELETE: 离职记录不可删（删掉之后"他为什么走"就只剩传闻）';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'E_ET_NO_UPDATE: 离职记录只增不改';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_et_append_only
  BEFORE UPDATE OR DELETE ON employment_termination
  FOR EACH ROW EXECUTE FUNCTION fn_et_append_only();

COMMENT ON TABLE employment_termination IS
  '离职记录：日期 + 原因 + 谁办的，只增不改。'
  'leave_date 只有日期，而"为什么走"是 HR 一定会问的那一句。';

-- ---------------------------------------------------------------------------
-- 2. 办离职：三件事必须同一事务
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
DECLARE e public.employment%ROWTYPE; v_id bigint;
BEGIN
  IF p_leave_date IS NULL THEN
    RAISE EXCEPTION 'E_TERM_NO_DATE: 离职日必填（"今天"在跨月那一天会变成另一天）';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'E_TERM_NO_REASON: 离职必须写原因（至少 4 个字）；'
      '只留一个日期，三个月后没人答得出"他为什么走"';
  END IF;

  -- 取这个人**当前这一段**任职：已离职的那段不能被当成"在职"再办一次
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

  -- ① 任职结束。★ 用 '[]' 闭区间：离职日当天仍然算在职（007 的规矩）
  UPDATE public.employment SET leave_date = p_leave_date WHERE id = e.id;

  -- ② 归属区间一并结束 —— 不结束就会留下"人走了、归属还挂着"。
  --    花名册按任职过滤所以看不见他，但"这个店几个人"的口径会数着他，
  --    而两个数都自洽。这类错只有对着两张表看才会发现。
  UPDATE public.employee_org_assignment
     SET valid_to = p_leave_date
   WHERE employee_id = p_person AND valid_to IS NULL;

  -- ③ 留一条"为什么走"
  INSERT INTO public.employment_termination(employment_id, leave_date, reason, created_by)
  VALUES (e.id, p_leave_date, btrim(p_reason), p_by)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_emp_terminate IS
  '办离职：结束任职 + 结束归属 + 落离职记录，同一事务。'
  '不结束归属会留下"人走了、归属还挂着"——两处各自自洽，加起来错。';

-- ---------------------------------------------------------------------------
-- 3. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.TR','离职：结束任职+归属、只办一次、留原因、不动历史','INTEGRATION','ALGORITHM',
   'fn_emp_terminate','public','employment','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-TR','离职接口侧','INTEGRATION','ALGORITHM',
   'employment_termination','public','employment_termination','TABLE','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
