-- ============================================================================
-- 146_rpt_trend.sql · 多期趋势：把"这一期"的快照按期间铺开
-- ----------------------------------------------------------------------------
-- README 里登记的缺口：「报表只有单期 —— 面板是"这一期"的快照（as_of 已贯穿
-- 到底层），趋势/环比没有实现。」这一版补上。
--
-- 而补它的时候，唯一必须守住的东西是：**趋势不是第三份口径**。
--
-- 023 的纪律是"一个指标一份实现"。最容易破坏它的地方恰恰是趋势：
-- 逐期算数看起来像一句"按月份分组再 sum"，写起来比调函数顺手得多，
-- 于是一不留神就在旁边另写了一套聚合 —— 从写下那一刻起就有两份实现了。
-- 它们会先一致、后分叉（分叉发生在某次只给一处加过滤条件的时候），
-- 而分叉时两边都"看起来对"，没有任何一处会报错，只会有人说
-- "为什么趋势图上的三月和报表上的三月不一样"。
--
-- 所以本函数**逐期调用 fn_rpt_panel**，把那一期面板上的字段原样取下来；
-- 不重算、不重写过滤条件、不重排时点基准。代价是慢一点
-- （每期一次面板 = 每期 7 个指标，其中日均人数要逐日数），
-- 换来的是"趋势上的 2026-03 与面板上的 2026-03 必然是同一个数"。
-- 这一条由 RT1 逐期核对，是本文件存在的意义。
--
-- 面板里没有的两列（社保 / 个税）只能从工资条取，见下面 side 段的说明：
-- 它们复用的是 fn_rpt_payroll 的**归属子句本身**，而不是"另写一个总和"。
--
-- 趋势上还有三件必须显式的事，缺一件，折线图就会画出不存在的事实：
--   ① **没有数据的月份也要出行**（值 0 + has_data=false）。缺行会被折线
--      连成"这个月掉到 0、下个月又起来"，而那两段斜坡一天也没发生过。
--   ② **NULL 与 0 不同形**：环比算不出（第一期 / 上月无数据 / 上月为 0）
--      是 NULL，持平才是 0。把"算不出"写成 0，图上就凭空多一次暴跌暴涨。
--   ③ 期间必须校验：格式、起止顺序、跨度上限。期间写错时报表函数不报错，
--      它只会安静地返回一排 0 —— 而那排 0 会被当成事实引用（055 的第一条）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 趋势：一个组织、一个期间区间，逐月一行
-- ---------------------------------------------------------------------------
-- ★ 返回类型里 period 是 varchar(7) 而不是 date：
--   报表上的"期间"是 `2026-03` 这个字面量，不是某一天。用 date 会让调用方
--   在展示时再格式化一次，而格式化点一多，就会出现"同一期两种写法"。
-- ★ headcount 用**期末**口径（与面板 HC_END 一致）。期初/日均是另外两个量，
--   想换口径要换列名，不能靠改实现悄悄换 —— 那正是 023 不给 basis 默认值的原因。
CREATE OR REPLACE FUNCTION fn_rpt_trend(p_org bigint, p_from varchar, p_to varchar)
RETURNS TABLE (
  period        varchar(7),
  headcount     int,
  gross         numeric,
  net           numeric,
  si_employee   numeric,
  tax           numeric,
  work_hours    numeric,
  ot_hours      numeric,
  has_data      boolean,
  gross_mom     numeric,
  gross_mom_pct numeric
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  v_from date;
  v_to   date;
  v_n    int;
BEGIN
  -- ① 格式。必须在进 SQL 之前挡住：'2026-3' 在下面会被拼成 '2026-3-01'，
  --    而那个字符串在 PG 里**能**被解析成 3 月 1 日 —— 于是"写错"与"写对"
  --    在结果上同形，差别只在别人怎么看。
  IF p_from IS NULL OR p_from !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_RPT_PERIOD: 起始期间必须是 YYYY-MM，收到 %',
      COALESCE(p_from, 'NULL');
  END IF;
  IF p_to IS NULL OR p_to !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_RPT_PERIOD: 结束期间必须是 YYYY-MM，收到 %',
      COALESCE(p_to, 'NULL');
  END IF;

  v_from := (p_from || '-01')::date;
  v_to   := (p_to   || '-01')::date;

  -- ② 起止写反。不报错的话 generate_series 返回空集，于是"参数写反了"
  --    看起来像"这段时间没有数据"——两张完全不同的诊断，同一个外观。
  IF v_from > v_to THEN
    RAISE EXCEPTION 'E_RPT_RANGE: 起止写反（from=% 晚于 to=%）', p_from, p_to;
  END IF;

  -- ③ 跨度。上限 36 是**产品约束**，不是性能调优：
  --    趋势图的横轴超过 36 个月就不再是趋势，而是一条噪声带；
  --    同时每期一次面板，36 期已经是一次可以等的量。
  v_n := (date_part('year',  v_to)::int  - date_part('year',  v_from)::int) * 12
       + (date_part('month', v_to)::int  - date_part('month', v_from)::int) + 1;
  IF v_n > 36 THEN
    RAISE EXCEPTION 'E_RPT_TOO_LONG: 期间跨度 % 个月，上限 36 个月', v_n;
  END IF;

  RETURN QUERY
  WITH per AS (
    SELECT to_char(g, 'YYYY-MM') AS per
      FROM pg_catalog.generate_series(v_from, v_to, interval '1 month') g
  ),
  -- ---------------------------------------------------------------------
  -- 面板：每期只调一次
  -- ---------------------------------------------------------------------
  -- ★ 写成"每期调四次面板"（一个指标一次）在结果上等价，但会让同一期被算四遍，
  --   而四遍之间任何一点差异（并发写入、函数内的非确定性）都会变成
  --   同一行里两个格子对不上。一次调用 + 条件聚合，把"同一期"钉在一次计算上。
  cell AS (
    SELECT per.per,
           max(pan.value) FILTER (WHERE pan.metric = 'HC_END')        AS headcount,
           max(pan.value) FILTER (WHERE pan.metric = 'PAYROLL_GROSS') AS gross,
           max(pan.value) FILTER (WHERE pan.metric = 'PAYROLL_NET')   AS net,
           max(pan.value) FILTER (WHERE pan.metric = 'WORK_HOURS')    AS work_hours
      FROM per
      CROSS JOIN LATERAL public.fn_rpt_panel(p_org, per.per) pan
     GROUP BY per.per
  ),
  -- ---------------------------------------------------------------------
  -- 社保 / 个税：面板没有这两行，只能从工资条取
  -- ---------------------------------------------------------------------
  -- ★ 这里的 WHERE 子句是 fn_rpt_payroll（023）那条归属子句的**同一句**，
  --   只把取的数字从 gross/net 换成 si_employee/tax_amount。
  --   为什么必须照抄而不是"另写一个更方便的写法"：工资条按「人归属的成本组织」
  --   汇总，跨法人借调时会与「发薪法人」给出不同的数。这条口径一旦在两处分叉，
  --   趋势图上的社保与旁边的应发就不再来自同一批人，而两张图各自都自洽。
  --   023 改口径时这里必须同步；RT1 里 `net = gross − 社保 − 个税`
  --   那一条等式就是它的守卫（工资条本身满足这个恒等式，两条口径一分开，
  --   这个等式先在跨组织的那一行破掉）。
  side AS (
    SELECT c.per, s.si, s.tax
      FROM cell c
      CROSS JOIN LATERAL (
        SELECT round(COALESCE(sum(p.si_employee), 0), 2) AS si,
               round(COALESCE(sum(p.tax_amount),  0), 2) AS tax
          FROM public.payslip p
          JOIN public.pay_run r ON r.id = p.pay_run_id
         WHERE r.period = c.per
           AND EXISTS (
             SELECT 1 FROM public.employee_org_assignment a
               JOIN public.org_unit o ON o.id = a.org_id
              WHERE a.employee_id = p.employee_id
                AND a.dim_code = 'cost_org'
                AND daterange(a.valid_from, a.valid_to, '[]') @>
                    (to_date(c.per || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
                AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org))
      ) s
  ),
  -- ---------------------------------------------------------------------
  -- 加班工时：只有一处——考勤月报（114）
  -- ---------------------------------------------------------------------
  -- ★ draft 也计入。加班是**已经发生的事实**，确认只决定它能不能进工资，
  --   不决定它有没有发生；只算 confirmed 会让"还没确认的那个月"显示成 0 加班，
  --   而 0 加班与"没确认"在图上同形 —— 这正是本文件要避免的那种同形。
  ot AS (
    SELECT c.per, x.ot_hours
      FROM cell c
      CROSS JOIN LATERAL (
        SELECT round(COALESCE(sum(r.ot_hours), 0), 2) AS ot_hours
          FROM public.att_period_report r
         WHERE r.period = c.per
           AND EXISTS (
             SELECT 1 FROM public.employee_org_assignment a
               JOIN public.org_unit o ON o.id = a.org_id
              WHERE a.employee_id = r.person_id
                AND a.dim_code = 'cost_org'
                AND daterange(a.valid_from, a.valid_to, '[]') @>
                    (to_date(c.per || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
                AND o.path LIKE (SELECT path || '%' FROM public.org_unit WHERE id = p_org))
      ) x
  ),
  joined AS (
    -- has_data 取 055 的 fn_rpt_has_data：它回答的是"这一期到底有没有人算过"
    -- （考勤 / 工资批次 / 编制额度三者有其一即 true），不是"这个组织有没有数"。
    -- ★ 值为 0 而 has_data=false 时**不把值改成别的**：人数可以是 0 而
    --   这一期确实算过（有人离职），也可以不为 0 而这一期从没算过考勤
    --   （人还在编，只是没导考勤）。把两者压成一个数就是本文件要防的事。
    SELECT c.per,
           COALESCE(c.headcount, 0)::int AS headcount,
           COALESCE(c.gross, 0)          AS gross,
           COALESCE(c.net, 0)            AS net,
           s.si                          AS si_employee,
           s.tax                         AS tax,
           COALESCE(c.work_hours, 0)     AS work_hours,
           o.ot_hours                    AS ot_hours,
           public.fn_rpt_has_data(c.per) AS has_data
      FROM cell c
      JOIN side s ON s.per = c.per
      JOIN ot   o ON o.per = c.per
  )
  SELECT j.per::varchar(7) AS period,
         j.headcount, j.gross, j.net, j.si_employee, j.tax, j.work_hours, j.ot_hours,
         j.has_data,
         -- 环比：本月 − 上月。
         -- NULL 的三种情形都是"算不出"，不能写成 0：
         --   第一期（没有上月）、上月没有数据、本月没有数据。
         -- ★ 本月没数据时不给 −上月 那个数：那会被读成"掉到 0"，
         --   而实际上这个月根本没有被计算过。
         CASE WHEN j.has_data
               AND lag(j.has_data) OVER (ORDER BY j.per) IS TRUE
              THEN round(j.gross - lag(j.gross) OVER (ORDER BY j.per), 2)
              ELSE NULL END AS gross_mom,
         -- 百分比：分母是上月应发。上月为 0 或 NULL 时无定义（除零），给 NULL。
         -- 0 表示持平，NULL 表示算不出 —— 这两个在图上必须不同形。
         CASE WHEN j.has_data
               AND lag(j.has_data) OVER (ORDER BY j.per) IS TRUE
               AND COALESCE(lag(j.gross) OVER (ORDER BY j.per), 0) <> 0
              THEN round((j.gross - lag(j.gross) OVER (ORDER BY j.per))
                         / lag(j.gross) OVER (ORDER BY j.per) * 100, 2)
              ELSE NULL END AS gross_mom_pct
    FROM joined j
   ORDER BY j.per;
END;
$$;

COMMENT ON FUNCTION fn_rpt_trend IS
  '多期趋势：逐期调用 fn_rpt_panel，不另写聚合 —— 另写一句 sum 就是第三份口径，'
  '两边会先一致、后分叉，而分叉时都"看起来对"。'
  '没有数据的月份也出行（值 0 + has_data=false）；环比算不出是 NULL，持平是 0。';

-- ---------------------------------------------------------------------------
-- 判据登记
-- ---------------------------------------------------------------------------
-- ★ domain 只能是 ATTENDANCE/PAYROLL/PERM/ORG/SECURITY/INTEGRATION（ck_scr_domain）。
--   写别的不是"这一条不生效"，而是**整条迁移失败** —— 于是这一版加的所有东西
--   （含上面这个函数）一起不存在，而报错指向的是一个约束名。
-- ★ 判据码不与 SUITE.RP（导出，055）/ SUITE.RPT-* 的其他条目撞号：
--   SUITE.RPT-TREND 是本仓第一条"报表趋势"判据。
-- ★ 接口侧那条码必须写成 SUITE.API-RTA —— api.test.mjs 末尾是按 id 前缀
--   （RTA1/RTA2 → RTA）**拼**出登记码再去写的，拼不上的时候 fn_chk_record
--   会以 E_CHK_UNREGISTERED 拒写，而那个异常在收口循环里没有 catch，
--   整个接口册当场挂掉。名字不是自由发挥的地方。
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RPT-TREND',
   '多期趋势：逐期复用 fn_rpt_panel（不另写聚合）、空月出行、NULL≠0、期间校验',
   'ORG','ALGORITHM',
   'fn_rpt_trend','public','org_unit','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-RTA',
   '报表趋势接口：逐月 rows 与 kpi、越权 403、期间写错 400（不是一排 0）',
   'SECURITY','ACL',
   'fn_rpt_trend','public','report_export','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
