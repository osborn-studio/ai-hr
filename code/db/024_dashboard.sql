-- ============================================================================
-- 024_dashboard.sql · 看板层：先异常、再总量、最后明细
-- ----------------------------------------------------------------------------
-- 看板不是"把指标排一排"。指标排一排的结果是：二十个数字，没有一个告诉你
-- 今天该做什么。所以这一层的顺序是有讲究的：
--
--   ① 异常（今天要处理的事）—— 先看这里，看完可以关掉页面
--   ② 总量（规模与趋势）—— 决定要不要往下看
--   ③ 明细（点进去）—— 只有前两层出了问题才需要
--
-- 两条硬判据，缺一条这个看板就会变成装饰：
--
-- ★ **异常清单必须每一类都出行，哪怕是 0。**
--   只列有问题的仪表盘，在"全部正常"与"根本没检查"之间没有区别——
--   两者都是一片空白。而空白是看板上最容易被读成"没事"的东西。
--
-- ★ **看板不许自己再算一遍指标。**
--   看板里写 sum(work_hours) 很自然，但那会立刻产生第二份实现：
--   看板说 1,240 小时、报表说 1,238 小时，两个都"看起来对"，
--   而核对它们需要有人同时打开两个页面并起疑心。
--   所以这里一律调 023 的函数，不写聚合。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ① 异常清单：期望集合硬编码，实际值 LEFT JOIN
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_dash_exceptions(p_period varchar)
RETURNS TABLE (kind varchar(32), severity varchar(8), label varchar(64),
               n int, drill varchar(120))
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH exp(kind, severity, label, drill) AS (VALUES
    ('HC_OVER',            'high',   '超编',          '编制页 → 超编组织'),
    ('HC_UNCOVERED',       'medium', '未配编制',      '编制页 → 未配编制组织'),
    ('ATT_UNCLOSED',       'high',   '考勤未封账',    '封账页 → 未封账门店'),
    ('SETTLE_DISPUTED',    'high',   '结算有差异',    '外包结算 → 差异明细'),
    ('PAYSLIP_INCONSIST',  'high',   '工资条勾稽不一致','算薪页 → 勾稽结果'),
    ('LEAVE_INCONSIST',    'medium', '请假单据与额度不同步','请假流 → 接缝自检'),
    ('CONFIRM_MISSING',    'high',   '段缺确认单',    '排班段 → 缺确认单'),
    ('POLICY_ORPHAN',      'medium', '越权政策覆盖',  '制度页 → 失效覆盖'),
    ('CHK_NEVER_RUN',      'medium', '判据从未运行',  '自检页 → never_run')
  ),
  act AS (
    SELECT 'HC_OVER'           AS kind, (SELECT count(*)::int FROM public.fn_hc_over(p_period)) AS n
    UNION ALL SELECT 'HC_UNCOVERED',      (SELECT count(*)::int FROM public.fn_hc_uncovered(p_period))
    UNION ALL SELECT 'ATT_UNCLOSED',      (SELECT count(*)::int FROM public.fn_att_unclosed(p_period))
    UNION ALL SELECT 'SETTLE_DISPUTED',   (SELECT count(*)::int FROM public.settlement
                                            WHERE period = p_period AND status = 'disputed')
    UNION ALL SELECT 'PAYSLIP_INCONSIST', (SELECT count(*)::int FROM public.v_payslip_consistency)
    UNION ALL SELECT 'LEAVE_INCONSIST',   (SELECT count(*)::int FROM public.v_leave_inconsistent)
    UNION ALL SELECT 'CONFIRM_MISSING',   (SELECT count(*)::int FROM public.v_segment_missing_sheet)
    UNION ALL SELECT 'POLICY_ORPHAN',     (SELECT count(*)::int FROM public.fn_policy_orphan_overrides())
    UNION ALL SELECT 'CHK_NEVER_RUN',     (SELECT count(*)::int FROM public.fn_chk_coverage(
                                             ((p_period || '-01')::date + interval '1 month - 1 day')::date)
                                            WHERE bucket = 'never_run')
  )
  SELECT e.kind, e.severity, e.label, COALESCE(a.n, 0), e.drill
    FROM exp e LEFT JOIN act a ON a.kind = e.kind
   ORDER BY CASE e.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
            COALESCE(a.n, 0) DESC, e.kind;
$$;

COMMENT ON FUNCTION fn_dash_exceptions IS
  '期望集合硬编码、实际值 LEFT JOIN —— 于是"0 条"也出行。'
  '只列非零项的仪表盘，在"全部正常"与"根本没检查"之间没有区别，而两者都是一片空白。';

-- 一行汇总：有几类真的有问题
CREATE OR REPLACE FUNCTION fn_dash_alert_count(p_period varchar)
RETURNS int
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT count(*)::int FROM public.fn_dash_exceptions(p_period) e WHERE e.n > 0;
$$;

-- ---------------------------------------------------------------------------
-- ② 门店日报：一天的数
-- ---------------------------------------------------------------------------
-- 每一个数都调已有实现，不在这里写聚合。
CREATE OR REPLACE FUNCTION fn_dash_store_daily(p_store bigint, p_date date)
RETURNS TABLE (metric varchar(32), label varchar(64), value numeric, unit varchar(16),
               anomaly boolean, note varchar(96))
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT 'ATT_HEAD'::varchar(32), '出勤人数'::varchar(64),
         (SELECT count(DISTINCT a.employee_id)::numeric
            FROM public.attendance_daily_store a
           WHERE a.store_id = p_store AND a.work_date = p_date),
         '人'::varchar(16), false, NULL::varchar(96)
  UNION ALL
  SELECT 'WORK_HOURS', '计薪工时',
         public.fn_rpt_hours_between(p_store, p_date, p_date),
         '小时', false, NULL
  UNION ALL
  SELECT 'LEAVE_HEAD', '请假人数',
         (SELECT count(DISTINCT lr.employee_id)::numeric
            FROM public.leave_request lr
           WHERE lr.status = 'approved'
             AND p_date BETWEEN lr.date_from AND lr.date_to),
         '人', false, NULL
  UNION ALL
  SELECT 'SEG_UNCONFIRMED', '未确认段',
         (SELECT count(*)::numeric FROM public.confirm_sheet c
            JOIN public.schedule_segment s ON s.id = c.segment_id
           WHERE s.store_id = p_store AND c.status <> 'locked'),
         '段',
         -- ★ 异常标记不是"值大就红"。这里的语义是"这一天已经过去了、
         --   却还有段没确认"——而"今天还没到确认时间"是正常的。
         (SELECT count(*) > 0 FROM public.confirm_sheet c
            JOIN public.schedule_segment s ON s.id = c.segment_id
           WHERE s.store_id = p_store AND c.status <> 'locked' AND p_date < current_date),
         NULL
  UNION ALL
  SELECT 'SEG_MISSING', '缺确认单的段',
         (SELECT count(*)::numeric FROM public.schedule_segment s
           WHERE s.store_id = p_store AND s.start_at::date = p_date
             AND NOT EXISTS (SELECT 1 FROM public.confirm_sheet c WHERE c.segment_id = s.id)),
         '段',
         (SELECT count(*) > 0 FROM public.schedule_segment s
           WHERE s.store_id = p_store AND s.start_at::date = p_date
             AND NOT EXISTS (SELECT 1 FROM public.confirm_sheet c WHERE c.segment_id = s.id)),
         '段表有行 = 它该有确认单；没有就是缺陷，不是"未排班"'::varchar(96);
$$;

-- ---------------------------------------------------------------------------
-- ③ 集团看板：按区域汇总，全部调 023 的指标
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_dash_group(p_period varchar)
RETURNS TABLE (org_id bigint, name varchar, headcount numeric, hours numeric,
               gross numeric, quota int, hireable int, alerts int)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT o.id, o.name,
         public.fn_rpt_headcount(o.id, p_period, 'end'),
         public.fn_rpt_hours(o.id, p_period),
         public.fn_rpt_payroll(o.id, p_period, 'gross_amount'),
         COALESCE(public.fn_hc_quota(o.id, p_period), 0),
         COALESCE(public.fn_hc_hireable(o.id, p_period), 0),
         (SELECT count(*)::int FROM public.fn_hc_over(p_period) x WHERE x.org_id = o.id)
    FROM public.org_unit o
   WHERE o.is_active AND o.parent_id = (SELECT id FROM public.org_unit WHERE parent_id IS NULL LIMIT 1)
   ORDER BY o.path;
$$;

COMMENT ON FUNCTION fn_dash_group IS
  '区域级的六个量，全部来自 023 的指标函数。看板里再写一遍 sum(work_hours)，'
  '就会立刻出现"看板 1240、报表 1238"这种两个都像对的差，'
  '而核对它需要有人同时打开两个页面并起疑心。';
