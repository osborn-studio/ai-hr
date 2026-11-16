-- ============================================================================
-- 052_attendance_adjust.sql · 封账后的修正通道：第五个「表在、门没有」
-- ----------------------------------------------------------------------------
-- 016 把 attendance_adjustment 的三条约束写得很细（delta≠0、只能往后、理由非空），
-- 但**没有任何东西往里写**。于是"封账后唯一的修正通道"只存在于表结构里 ——
-- 报表读不到它，人也没法用它。这已经是第五次同一个形态
-- （006 审批 / 010 两阶段写 / 037 例外 / 026 绩效 / 016 补账）。
--
-- 三条判据：
--   ① **只有已封账的期间才允许走补账**。没封账的时候原记录还能改，
--      两条路改同一个数，就会出现"原记录 8 小时、补账又加 2 小时、报表 10 小时"
--      而没人知道 8 与 2 是同一件事的两种写法。
--   ② **补账只能往后**（约束里已有），但函数要给出**名字**：
--      23514 对调用方来说是"违反约束"，而真相是"不能用补账改上个月"。
--   ③ **补账不改原记录**。它是"另起一笔"，因为发薪日已经按当时的数发过钱，
--      而"当时我们以为的"必须还能查出来。
--
-- 接线：报表工时改读 `v_att_effective`（原记录 + 补账合计）。
-- 不接线的话，补账就只是一个"写了但没人看"的表 —— 那比不做更坏，
-- 因为它会让人以为这件事已经管住了。
--
-- 刻意**不**动封账快照：`fn_att_close` 抓的是原表当时的样子，
-- `fn_att_verify` 重算的也是原表。补账进快照会让"封账那天我们看到的数"永远查不到。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 补账入口
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_att_adjust(
  p_employee bigint,
  p_store    bigint,
  p_work_date date,
  p_delta    numeric,
  p_period   varchar,          -- 补到哪个月（必须晚于工作日所属月）
  p_reason   varchar,
  p_by       varchar
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_id bigint; v_month varchar; v_closed boolean;
BEGIN
  IF p_delta IS NULL OR p_delta = 0 THEN
    RAISE EXCEPTION 'E_ATT_ADJ_DELTA: 补账工时为 0 没有意义（要改就改多少写多少）';
  END IF;

  IF p_reason IS NULL OR length(btrim(p_reason)) < 4 THEN
    RAISE EXCEPTION 'E_ATT_ADJ_REASON: 补账必须写原因（至少 4 个字）';
  END IF;

  v_month := to_char(p_work_date, 'YYYY-MM');

  -- ② 只能往后：写成"不等于"就允许往前，而往前就是改历史换了个名字
  IF p_period IS NULL OR p_period <= v_month THEN
    RAISE EXCEPTION 'E_ATT_ADJ_NOT_FORWARD: 补账期间 % 必须晚于工作日所属月 %'
      '（往前调不是补账，是改历史）', p_period, v_month;
  END IF;

  -- ① 只有已封账的期间才需要补账
  SELECT EXISTS (SELECT 1 FROM public.attendance_close c
                  WHERE c.store_id = p_store AND c.period = v_month) INTO v_closed;
  IF NOT v_closed THEN
    RAISE EXCEPTION 'E_ATT_ADJ_NOT_CLOSED: 门店 % 的 % 还没封账 —— 直接改原记录即可，'
      '不必走补账（两条路改同一个数，报表上会变成两次）', p_store, v_month;
  END IF;

  -- 员工必须在该店该日**有账**或**该店当月有账**：补一个谁都不认识的人进来，
  -- 报表会多出一行而没人能解释它从哪来。
  IF NOT EXISTS (SELECT 1 FROM public.attendance_daily_store a
                  WHERE a.employee_id = p_employee AND a.store_id = p_store
                    AND to_char(a.work_date, 'YYYY-MM') = v_month) THEN
    RAISE EXCEPTION 'E_ATT_ADJ_NO_BASE: 员工 % 在门店 % 的 % 没有任何考勤记录，'
      '无从补起（漏记请走补录单）', p_employee, p_store, v_month;
  END IF;

  -- ③ 只插入，不 UPDATE 原记录
  INSERT INTO public.attendance_adjustment
    (employee_id, store_id, work_date, hours_delta, apply_period, reason, created_by)
  VALUES (p_employee, p_store, p_work_date, p_delta, p_period, btrim(p_reason), p_by)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_att_adjust IS
  '封账后的修正通道：另起一笔，不改原记录。只有已封账的期间才允许 —— '
  '没封账时原记录还能改，两条路改同一个数会让报表上出现"同一件事的两种写法"。';

-- ---------------------------------------------------------------------------
-- 2. 有效工时 = 原记录 + 补账合计
-- ---------------------------------------------------------------------------
-- ★ FULL OUTER JOIN：补账可以指向"原记录里没有的那一天"（漏记），
--   而这类行正是补账最常见的用途。用 INNER JOIN 会把它悄悄丢掉。
CREATE OR REPLACE VIEW v_att_effective AS
WITH adj AS (
  SELECT employee_id, store_id, work_date, sum(hours_delta)::numeric(6,2) AS delta
    FROM attendance_adjustment
   GROUP BY employee_id, store_id, work_date
)
SELECT COALESCE(a.employee_id, j.employee_id) AS employee_id,
       COALESCE(a.store_id,    j.store_id)    AS store_id,
       COALESCE(a.work_date,   j.work_date)   AS work_date,
       COALESCE(a.work_hours, 0) + COALESCE(j.delta, 0) AS work_hours,
       (a.id IS NULL)        AS from_adjust_only,
       j.delta               AS adjusted_hours
  FROM attendance_daily_store a
  FULL OUTER JOIN adj j
    ON j.employee_id = a.employee_id
   AND j.store_id    = a.store_id
   AND j.work_date   = a.work_date;

COMMENT ON VIEW v_att_effective IS
  '有效工时：原记录 + 补账合计。报表读这里，封账快照读原表 —— '
  '快照必须保持"封账那天我们看到的数"，否则它就不再是快照。';

-- ---------------------------------------------------------------------------
-- 3. 接线：报表工时改读有效工时
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_rpt_hours_between(p_org bigint, p_from date, p_to date)
RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT round(COALESCE(sum(a.work_hours), 0), 2)
    FROM public.v_att_effective a
    JOIN public.org_unit o ON o.id = a.store_id
   WHERE a.work_date BETWEEN p_from AND p_to
     AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org);
$$;

COMMENT ON FUNCTION fn_rpt_hours_between IS
  '区间工时。读 v_att_effective（含补账）—— 补账不进报表，就等于没做。';

-- ---------------------------------------------------------------------------
-- 4. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.AS','补账：只往已封账期间补、只往后、不改原记录、进报表','INTEGRATION','ALGORITHM',
   'fn_att_adjust','public','attendance_adjustment','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-AS','补账接口侧','INTEGRATION','ALGORITHM',
   'v_att_effective','public','attendance_adjustment','VIEW','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
