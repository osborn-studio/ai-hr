-- ============================================================================
-- 143_iit_chain.sql · 累计预扣不认顺序：先算几月、后算几月都对
-- ----------------------------------------------------------------------------
-- 个人所得税是**累计预扣**：本月应扣 = 按累计应纳税所得额查表得到的累计税额
-- − 已预扣。所以"这个月"的税依赖"前面每个月"。
--
-- 到 142 为止，实现只读**已封账**的前期（见 133 的那段 SELECT）。四个后果：
--
--   ① **顺序一错，永久错。** 先算 2 月、后算 1 月，2 月算的时候 1 月还是 draft，
--      读不到 → 累计少一个月 → 而 2 月一封账就改不了。少缴要补税加滞纳金，
--      多缴要等汇算清缴才退 —— 而那时员工已经换了一家公司。
--   ② **前期改动污染下游。** 1 月封账后又重算（或改月薪），2 月已封账的累计
--      就建立在旧数上，而 2 月改不了。
--   ③ **跨法人混算。** 原 SQL 没有 legal_entity_id 过滤：同一个人在两家发薪法人，
--      两家的所得被加在一起累计 —— 而累计预扣是按**扣缴义务人**分别累计的。
--   ④ **年终奖混进工资薪金。** 原 SQL 没有 kind 过滤：年终奖是单独计税
--      （全年一次性奖金），它的 cum_taxable 进了综合所得累计就是多缴。
--
-- ★ 修法不是"提醒人按顺序来"，是把顺序这件事从人身上拿掉。三条：
--
--   ① **算薪读累计：不分状态、按期取最新版本、限同法人同 kind。**
--      这样"先算哪期都行"—— draft 可以随时重算，算完就是对的。
--
--   ② **封账门禁：前期没封不许封本期；累计对不上当前上游也不许封。**
--      累计是"累计到本期"，前期没定稿，本期的累计就建立在一份还会变的数上。
--      于是封账必须自前向后 —— 而这件事人不用记，系统会拦。
--
--   ③ **重算后验：本期之后若有封账批次，重算不能让它们失真。**
--      改了本期，后面那些期的累计就全部失真，而它们封了改不了。
--      要补发的钱走调整单（另起一笔），不要回头重算已封账序列之前的那几期。
--
--   三条合起来：**顺序自由（draft 随时重算）、封账有向（自前向后）、
--   封完不许动上游。**
--
-- ★ 一件刻意不做的事：**封账时不自动重算**。
--   封账的语义是"确认这份数"。自动重算就变成"重新算一份"，签字的人签的
--   就不是他看过的那份了。所以宁可拒一次、让他点重算，也不替他改数。
--
-- ★★ 存量数据：这次改的是**读法**，但旧数已经写错在表里了。
--
--   133 那条 `SUM(cum_taxable)` 的错，任何算过 **3 期以上**的库都会中：
--   `payslip.cum_taxable` 存的是累计值，把各期再加一遍就是重复累加。
--   本项目自己的演示库就是实例 —— 造到 3 个月时累计开始膨胀（4200/8400/12600
--   被算成 4200/8400/16800）。1、2 期看不出来，所以它藏了很久。
--
--   改造**不自动修存量**，理由与下面那条一样：修它要改已封账的工资条，
--   而那些数已经报过税、发过钱。自动修的代价是让"已报出去的表"和库里的数分叉。
--
--   能做的两件：
--     · **发现**：申报表（141）的"累计勾稽差"会逐行点名；
--       `fn_payrun_chain().stale_count` 也会把它数出来。
--     · **处置**：更正申报，或在下一年度按汇算清缴结果调整。不回填历史。
--   新算出来的数据不会再有这个问题（读法已改，CHAIN9 钉着）。
--
--   一个直接后果要知道：存量膨胀的库上，**任何上游重算都会被下游后验拦住**
--   （下游本来就不自洽），封账也会要求勾选"按现状封账"。这不是门禁坏了，
--   是库里的历史数确实对不上 —— 门禁只是不再让它继续扩散。
--
-- ★ 另一个必须说清的剩余限制：若历史上已经存在"上游 draft + 下游已封账"的
--   错位数据，本次改造**不会自动修**——改已封账的数是禁止的。这种错位会由
--   申报表的"累计勾稽差"点名（141 的 remark 列），处置只能走更正申报。
--   不自动修不是偷懒：自动修的代价是改掉一张已经报出去的工资条。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 链条状态：这一期能不能封、为什么不能封
-- ---------------------------------------------------------------------------
-- 六列回答六个问题。★ 页面与封账门禁共用这一个函数 —— 一个判据只有一份实现，
-- 否则"页面说能封、库里拒了"这种自相矛盾迟早出现。
--   upstream_draft    本年此前还有哪几期没封（有 → 不能封本期）
--   downstream_sealed 本年此后已经封了哪几期（有 → 不能重算本期）
--   stale_count       多少人的累计与**当前**前期数据对不上（默认拦封账，确认后放行）
--   stale_names       这些人是谁（改名要能对得上人，不然只是"有 3 个人"）
--   can_seal          一句话结论：此刻直接点封账会不会过（draft + 前期全封 + 无过期）
--   reason            为什么不能封（直接可以显示给人看的一句中文）
CREATE OR REPLACE FUNCTION fn_payrun_chain(p_run bigint)
RETURNS TABLE (
  upstream_draft    varchar(200),
  downstream_sealed varchar(200),
  stale_count       int,
  stale_names       text,
  can_seal          boolean,
  reason            varchar(400)
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE
  r     record;
  v_thr numeric(12,2);
  v_up  varchar(200);
  v_dn  varchar(200);
  v_n   int := 0;
  v_nm  text;
BEGIN
  SELECT * INTO r FROM public.pay_run WHERE id = p_run;
  IF r.id IS NULL THEN RAISE EXCEPTION 'E_RUN_NOT_FOUND: %', p_run; END IF;

  -- 上游：只认 draft。**没算过**（没有批次）不算未封账 —— 那个月真的没发工资，
  -- 累计自然少一期，这是事实，不是错误。
  SELECT string_agg(u.period, '、' ORDER BY u.period) INTO v_up
    FROM public.pay_run u
   WHERE u.legal_entity_id = r.legal_entity_id
     AND u.kind = r.kind
     AND left(u.period, 4) = left(r.period, 4)
     AND u.period < r.period
     AND u.status = 'draft';

  SELECT string_agg(u.period, '、' ORDER BY u.period) INTO v_dn
    FROM public.pay_run u
   WHERE u.legal_entity_id = r.legal_entity_id
     AND u.kind = r.kind
     AND left(u.period, 4) = left(r.period, 4)
     AND u.period > r.period
     AND u.status IN ('sealed', 'paid');

  SELECT t.threshold INTO v_thr FROM public.tax_param t WHERE t.year = left(r.period, 4)::int;
  v_thr := COALESCE(v_thr, 5000);

  -- 链条新鲜度：拿**当前**上游重算一遍应有的累计应纳税所得额与应扣税额，
  -- 与工资条上存的那两个数比。对不上说明前期在这期算完之后又改过。
  --   · 应累计应纳税所得额 = 上游累计 + max(应发 − 社保 − 减除费用 − 专项附加, 0)
  --     （与 fn_payroll_calc 里 v_taxable 的公式逐字一致，不一致这里就会误报）
  --   · 应扣税额 = fn_iit_cumulative(应累计) − 上游已扣
  WITH raw AS (
    SELECT DISTINCT ON (pr.period, p.employee_id)
           p.employee_id, pr.period, p.cum_taxable, p.tax_amount
      FROM public.payslip p
      JOIN public.pay_run pr ON pr.id = p.pay_run_id
     WHERE pr.legal_entity_id = r.legal_entity_id
       AND pr.kind = r.kind
       AND left(pr.period, 4) = left(r.period, 4)
       AND pr.period < r.period
     ORDER BY pr.period, p.employee_id, pr.calc_version DESC, pr.id DESC
  ), last AS (
    -- 累计值取最近一期那一条；而税额是当期值，要 SUM。两处口径见 fn_payroll_calc。
    SELECT DISTINCT ON (raw.employee_id) raw.employee_id, raw.cum_taxable
      FROM raw ORDER BY raw.employee_id, raw.period DESC
  ), up AS (
    SELECT raw.employee_id, last.cum_taxable AS cum_prev, sum(raw.tax_amount) AS cum_paid
      FROM raw JOIN last ON last.employee_id = raw.employee_id
     GROUP BY raw.employee_id, last.cum_taxable
  ), exp AS (
    SELECT p.employee_id, p.cum_taxable, p.tax_amount,
           COALESCE(up.cum_prev, 0)
             + GREATEST(p.gross_amount - p.si_employee - v_thr - p.special_deduction, 0) AS exp_cum,
           COALESCE(up.cum_paid, 0) AS paid_prev
      FROM public.payslip p
      LEFT JOIN up ON up.employee_id = p.employee_id
     WHERE p.pay_run_id = p_run
  ), bad AS (
    SELECT e.employee_id
      FROM exp e
     WHERE abs(e.exp_cum - e.cum_taxable) > 0.02
        OR abs(GREATEST(public.fn_iit_cumulative(e.exp_cum) - e.paid_prev, 0)
               - e.tax_amount) > 0.02
  )
  -- ★ 截断：varchar(400) 装不下 100 个三字姓名，而 22001（value too long）
  --   不在 SQLSTATE 表里，用户会看到 500 INTERNAL + 一个 ref —— 一个"人太多"
  --   的问题不该长得像服务故障。只列前面几个，后面用"等 N 人"带过。
  SELECT count(*)::int,
         CASE WHEN count(*) > 8
              THEN left(string_agg(pe.full_name, '、' ORDER BY pe.full_name), 200)
                   || ' 等 ' || count(*) || ' 人'
              ELSE string_agg(pe.full_name, '、' ORDER BY pe.full_name)
         END
    INTO v_n, v_nm
    FROM bad b JOIN public.person pe ON pe.id = b.employee_id;

  RETURN QUERY SELECT
    v_up, v_dn, v_n, v_nm,
    -- ★ can_seal 必须与 fn_pay_run_seal 的默认行为**完全一致**：
    --   页面上它决定按钮是不是绿的，而门禁默认会对 stale 抛错。
    --   两者不一致 = "绿的按钮点下去报红"，本文件开头就警告过这种情况。
    --   "需确认才可封"由 reason 表达（页面据此出黄条与勾选框），不体现在 can_seal 上。
    (r.status = 'draft' AND v_up IS NULL AND v_n = 0),
    CASE
      WHEN r.status <> 'draft'
        THEN '批次已是 ' || r.status || ' 状态'
      WHEN v_up IS NOT NULL
        THEN '本期之前的 ' || v_up || ' 还没封账 —— 累计预扣是"累计到本期"，'
             || '前期没定稿，本期的累计就建立在一份还会变的数上'
      WHEN v_n > 0
        THEN v_n || ' 人的累计与当前前期数据对不上（' || COALESCE(v_nm, '')
             || '）—— 建议先重算本期；确认要按现状封账需要明确勾选'
      ELSE NULL
    END::varchar(400);
END;
$$;

COMMENT ON FUNCTION fn_payrun_chain IS
  '累计预扣链条状态（143）：前期是否都封了、下游是否已封、本期的累计是否过期。'
  '六列各回答一个问题，页面与封账门禁共用 —— 一个判据只能有一份实现，'
  '否则"页面说能封、库里拒了"这种自相矛盾迟早出现。';

-- ---------------------------------------------------------------------------
-- 2. 算薪主过程：读累计改口径 + 重算后回验下游
-- ---------------------------------------------------------------------------
-- ★ 这一版是从 133 **原样抽出**函数体再改三处的，不是重打一遍。
--   本仓吃过"从旧版本抄函数"的亏（105 的多险种被静默回退），所以凡是
--   CREATE OR REPLACE 一个大函数，都用抽取 + 定点替换，并且只改注释写明的地方。
CREATE OR REPLACE FUNCTION fn_payroll_calc(p_run bigint)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r public.pay_run%ROWTYPE;
  e record;
  v_period_end date;
  v_base numeric(12,2);
  v_leave numeric(12,2);
  v_si_base numeric(12,2);
  v_si numeric(12,2);
  v_rate numeric(6,4);
  v_gross numeric(12,2);
  v_taxable numeric(14,2);
  v_cum_prev numeric(14,2);
  v_cum_paid_tax numeric(14,2);
  v_tax numeric(12,2);
  v_net numeric(12,2);
  v_threshold numeric(12,2);
  v_slip bigint;
  v_n int := 0;
  v_unclosed text;
  -- 143：重算后回验下游（本期之后的已封账批次必须仍然与新的上游一致）
  v_dn record;
  v_sc int;
  v_sn varchar(400);
  v_perf numeric(12,2);
  v_comm numeric(12,2);
  v_fixed_other numeric(12,2);
  v_struct_n int;
  v_extra jsonb;
  v_extra_sum numeric(12,2);
  v_amt numeric(12,2);
  v_vars jsonb;
  fi record;
  rl record;
  v_att record;
  v_deduct numeric(12,2);
  v_si_lines jsonb;
  si record;
  v_si_item numeric(6,4);
  v_si_one numeric(12,2);
  v_si_code varchar(32);
  -- 计薪基础（117）：day=按人天 / hour=按工时
  v_monthly numeric(12,2);
  v_basis   varchar(8);
  v_days    numeric(6,2);
  v_std_h   numeric(6,2);
  v_daily   numeric(14,4);
  v_hourly  numeric(14,4);
  v_factor  numeric(10,6);
  -- 加班费（120）：三档工时 + 三个倍数 + 是否自动算
  v_ot      record;
  v_ot_pay  numeric(12,2);
  v_al      numeric(12,2);
  v_ot_auto boolean := false;
  v_r_wd    numeric(4,2) := 1.5;
  v_r_rd    numeric(4,2) := 2.0;
  v_r_hd    numeric(4,2) := 3.0;
BEGIN
  SELECT * INTO r FROM public.pay_run WHERE id = p_run FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'E_RUN_NOT_FOUND: %', p_run; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'E_RUN_SEALED: 批次 % 已封账，不可重算', p_run;
  END IF;

  -- 重算幂等：本批次已经落过账的年假折现要先退回 pending。
  --   不退的话第二次算薪读不到 pending 单，那笔钱会静默消失 ——
  --   而"少发"不会有人投诉，会一直错到员工来问。
  --   只退**本批次**工资条关联的单，别的法人的单不能碰。
  UPDATE public.leave_cashout c
     SET status = 'pending', payslip_id = NULL
   WHERE c.status = 'paid'
     AND c.payslip_id IN (SELECT p.id FROM public.payslip p WHERE p.pay_run_id = p_run);

  SELECT string_agg(u.store_id || '(' || u.why || ')', '、') INTO v_unclosed
    FROM public.fn_att_unclosed(r.period) u;
  IF v_unclosed IS NOT NULL THEN
    RAISE EXCEPTION 'E_ATT_NOT_CLOSED: 本期有考勤但未封账的门店：%。'
      '未封账即算薪，等于用一份还会变的数据发钱。', v_unclosed;
  END IF;

  IF EXISTS (SELECT 1 FROM public.perf_cycle c
              WHERE c.pay_period = r.period AND c.status <> 'sealed') THEN
    RAISE EXCEPTION 'E_PERF_NOT_SEALED: % 关联的绩效周期未封存，算薪会按一份还会变的分发钱',
      r.period;
  END IF;

  v_period_end := (to_date(r.period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date;
  SELECT t.threshold INTO v_threshold FROM public.tax_param t WHERE t.year = left(r.period,4)::int;
  -- ★ 143：缺年度参数时按法定 5000，不要留 NULL。
  --   NULL 会让 GREATEST(应发-社保-NULL-附加, 0) 把应纳税所得额算成 0
  --   （PG 的 GREATEST 忽略 NULL），等于一分减除费用都没扣 —— 税被多扣；
  --   而 fn_payrun_chain 的 stale 判据按 5000 算，两边口径不一致就会互相误报。
  v_threshold := COALESCE(v_threshold, 5000);

  -- 折算分母：月计薪天数（法定折算口径）与每日标准工时，两者都不随月份变
  SELECT COALESCE(value_num, 21.75) INTO v_days
    FROM public.fn_policy_effective('PAY_DAYS_PER_MONTH', NULL, v_period_end);
  SELECT COALESCE(value_num, 8) INTO v_std_h
    FROM public.fn_policy_effective('PAY_WORK_HOURS_DAY', NULL, v_period_end);

  -- 加班费制度（120）：倍数法定下限是 1.5 / 2 / 3，企业只能更高不能更低
  SELECT COALESCE(value_text,'off') = 'on' INTO v_ot_auto
    FROM public.fn_policy_effective('PAY_OT_AUTO', NULL, v_period_end);
  SELECT COALESCE(value_num, 1.5) INTO v_r_wd
    FROM public.fn_policy_effective('PAY_OT_RATE_WEEKDAY', NULL, v_period_end);
  SELECT COALESCE(value_num, 2.0) INTO v_r_rd
    FROM public.fn_policy_effective('PAY_OT_RATE_RESTDAY', NULL, v_period_end);
  SELECT COALESCE(value_num, 3.0) INTO v_r_hd
    FROM public.fn_policy_effective('PAY_OT_RATE_HOLIDAY', NULL, v_period_end);

  FOR e IN
    SELECT em.id AS employment_id, em.person_id, em.legal_entity_id
      FROM public.employment em
     WHERE em.legal_entity_id = r.legal_entity_id
       AND daterange(em.hire_date, em.leave_date, '[]') @> v_period_end
  LOOP
    SELECT s.monthly_amount INTO v_monthly
      FROM public.salary_standard s
     WHERE s.employment_id = e.employment_id AND s.effective_from <= v_period_end
     ORDER BY s.effective_from DESC LIMIT 1;
    IF v_monthly IS NULL THEN CONTINUE; END IF;

    -- 考勤口径先取：计薪基础要用实际工时（原来是在公式循环里反复取，白查 N 次）
    v_att := public.fn_att_person_period(e.person_id, r.period);

    -- ★ 两种计薪基础（117）：
    --   day  按人天：应发底薪 = 月薪标准，缺勤按天扣（事假扣款单独一行）
    --   hour 按工时：应发底薪 = 时薪 × 实际工时。
    --        ★ 这时**不再另扣事假** —— 缺勤已经体现在工时里了，再扣一次就是扣两次。
    --        这是两种模式最容易写错的地方，也是客户对不上账时最先怀疑的地方。
    -- 折算单价：日薪 / 时薪都用**月计薪天数 21.75**（法定折算口径），
    -- 不用应出勤（22）—— 否则 2 月（20 天）与 12 月（23 天）时薪不一样，
    -- 同一个人同样的工时拿到不同的钱。应出勤只用于"满勤判断/折算比例"。
    v_daily  := round(v_monthly / GREATEST(v_days, 1), 4);
    v_hourly := round(v_monthly / GREATEST(v_days * v_std_h, 1), 4);

    v_basis := public.fn_pay_basis(e.person_id, r.period);
    IF v_basis = 'hour' THEN
      -- 应发 = 时薪 × 实际工时（时薪 = 月薪 ÷ 21.75 ÷ 8）
      v_base := round(v_hourly * v_att.work_hours, 2);
      v_leave := 0;
    ELSE
      v_base := v_monthly;
      v_leave := public.fn_leave_deduction(e.person_id, r.period);
    END IF;

    -- 结构按实际应发/月薪标准缩放：按工时模式下工时少，结构各项同比例缩，
    -- 否则明细合计会大于应发（勾稽报错），或 BASE 变成负数。
    v_factor := CASE WHEN v_monthly > 0 THEN v_base / v_monthly ELSE 1 END;

    v_perf  := round(v_base * COALESCE(public.fn_perf_factor(e.person_id, r.period), 0), 2);
    v_comm  := public.fn_commission_amount(e.person_id, r.period);

    -- 加班工时三档拆分（120）。不管开不开自动算，三档都要给公式：
    -- 有的客户要按项目/门店另算，有的要"先折成补休"。
    v_ot := public.fn_att_ot_split(e.person_id, r.period);

    -- 公式项：按 sort_order 逐个算，后一个可以引用前一个的结果
    v_extra := '{}'::jsonb;
    v_extra_sum := 0;
    FOR fi IN
      SELECT code, formula FROM public.salary_item
       WHERE is_active AND formula IS NOT NULL AND btrim(formula) <> ''
       ORDER BY sort_order, code
    LOOP
      -- ★ 先把**所有已登记项目**铺成 0，再覆盖实际值。
      --   只传"这个人有的项"会在两种情况下炸掉整批算薪：
      --     ① 新员工还没拆结构（没有任何结构项）；
      --     ② 公式引用了别人有、他没有的项。
      --   而这两种都不是错误 —— 是"这个人这个月没有这一项"。
      -- 考勤口径（102/114）：出勤/应出勤/请假/工时/加班 同源；周期内只取一次。
      -- 不允许从参数传天数：一旦能传，工资与考勤就会有两个口径。
      v_vars := (SELECT COALESCE(jsonb_object_agg(code, 0), '{}'::jsonb)
                   FROM public.salary_item WHERE is_active)
                || jsonb_build_object(
                     'MONTHLY', v_base,
                     'COMMISSION', v_comm,
                     'PRESENT_DAYS', v_att.present_days,
                     'WORK_DAYS', v_att.work_days,
                     'LEAVE_DAYS', v_att.leave_days,
                     'WORK_HOURS', v_att.work_hours,
                     'OT_HOURS', v_att.ot_hours,
                     'CALENDAR_DAYS', v_att.calendar_days,
                     'ROSTER_DAYS', v_att.roster_days,
                     -- 计薪基础（117）：写公式时不用自己拿月薪除，也避免各人各写一遍
                     'DAILY_RATE', v_daily,
                     'HOURLY_RATE', v_hourly,
                     'PAY_BASIS_HOUR', CASE WHEN v_basis = 'hour' THEN 1 ELSE 0 END,
                     'HOUR_FACTOR', v_factor,
                     -- 加班三档（120）：平日延长 / 休息日 / 法定节假日
                     'OT_WEEKDAY', v_ot.weekday_ot,
                     'OT_RESTDAY', v_ot.restday_ot,
                     'OT_HOLIDAY', v_ot.holiday_ot)
                || v_extra
                || COALESCE((SELECT jsonb_object_agg(s.item_code, s.amount)
                               FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s),
                            '{}'::jsonb);
      -- 脚本求值：单行公式与多行脚本走同一个入口（内部按有无换行分流）
      v_amt := public.fn_formula_script_eval(fi.formula, v_vars);
      v_extra := v_extra || jsonb_build_object(fi.code, v_amt);
      v_extra_sum := v_extra_sum + v_amt;
    END LOOP;

    -- ★ 加班费（120）：法定 150% / 200% / 300%。
    --   按工时模式（hour）只补**差额**：1 倍工资已经含在"时薪×工时"里了，
    --   再全额给 1.5 倍等于付了 2.5 倍。这是两种计薪基础混用最容易多付的地方。
    IF v_ot_auto THEN
      -- ★ 休息日那一档用 restday_paid（已扣掉安排补休的小时），不是实际加班工时。
      --   "安排了补休的就不付 200%"是法条原文；平日与法定节假日没有这个选项（见 128）。
      IF v_basis = 'hour' THEN
        v_ot_pay := round(v_hourly * (
          v_ot.weekday_ot   * (v_r_wd - 1) +
          v_ot.restday_paid * (v_r_rd - 1) +
          v_ot.holiday_ot   * (v_r_hd - 1)), 2);
      ELSE
        v_ot_pay := round(v_hourly * (
          v_ot.weekday_ot   * v_r_wd +
          v_ot.restday_paid * v_r_rd +
          v_ot.holiday_ot   * v_r_hd), 2);
      END IF;
    ELSE
      v_ot_pay := 0;
    END IF;

    -- 年假折现（129）：**只读**已登记的 pending 单，不在这里自动算。
    -- 自动算的后果是：改一次制度项，重算历史月份时"应发"就变了，而发出去的工资条不能变。
    SELECT COALESCE(SUM(c.amount), 0) INTO v_al
      FROM public.leave_cashout c
     WHERE c.employee_id = e.person_id
       AND c.settle_period = r.period AND c.status = 'pending';

    v_gross := v_base - v_leave + v_perf + v_comm + v_extra_sum + v_ot_pay + v_al;

    -- ★ before 规则**不在**这里跑：它必须"算之前拦"，而拦截一旦 RAISE，
    --   同事务里写下的命中记录也会跟着回滚 —— 于是"拦了但没有任何痕迹"。
    --   所以 before 规则由服务层在算薪前统一预跑、留痕，再决定是否开算（见 payroll.mjs）。

    -- 社保：按 si_policy 里**配置了**的险种逐个算（不写死养老一项）
    v_si := 0; v_si_lines := '{}'::jsonb;
    FOR si IN
      SELECT DISTINCT ON (item) item, rate_employee
        FROM public.si_policy
       WHERE city = '上海' AND effective_from <= v_period_end
         AND rate_employee > 0
       ORDER BY item, effective_from DESC
    LOOP
      -- ★ 社保基数用**月薪标准**，不用本月实际应发：
      --   社保按申报口径缴，工时少的月份不该少缴（少缴是欠缴，会被追）。
      --   day 模式下 v_monthly 与 v_base 本来就相等，所以这条改动不改变既有结果。
      -- ★ 133：优先用**申报基数**（一年定一次），没有申报才回退月薪标准。
      --   回退分支保证这条改动不改变任何历史月份的社保金额。
      v_si_one := round(public.fn_si_base_eff(e.person_id, '上海', si.item,
                                              v_monthly, v_period_end) * si.rate_employee, 2);
      v_si_code := CASE si.item
                     WHEN 'pension' THEN 'SI_PENSION'
                     WHEN 'medical' THEN 'SI_MEDICAL'
                     WHEN 'unemployment' THEN 'SI_UNEMPLOYMENT'
                     WHEN 'housing_fund' THEN 'SI_HOUSING_FUND'
                     ELSE NULL END;
      v_si := v_si + v_si_one;
      IF v_si_code IS NOT NULL THEN
        v_si_lines := v_si_lines || jsonb_build_object(v_si_code, v_si_one);
      END IF;
    END LOOP;

    -- ★ 养老必须有：缺它是配置漏了，不是"这个地区不缴养老"。
    --   其余险种缺省即跳过（外地户口不缴公积金是合法情形），但工资条上看得见没有。
    IF NOT (v_si_lines ? 'SI_PENSION') THEN
      RAISE EXCEPTION 'E_SI_POLICY_MISSING: 上海 养老保险 在 % 之前没有生效的政策', v_period_end;
    END IF;

    -- 专项附加扣除：只减计税基数，不减应发（它是"税前扣除"不是"扣款"）
    v_deduct := public.fn_tax_deduction(e.person_id, v_period_end);
    v_taxable := GREATEST(v_gross - v_si - v_threshold - v_deduct, 0);

    -- ★ 累计预扣的链条（143）：读**本年此前每一期**，不分封账与否、按期取最新
    --   版本、只读同一法人同一 kind。三条缺一不可：
    --     · 不分状态 —— 否则"先算二期、后算一期"时，二期读不到一期，累计永久
    --       少一个月；而二期一封账就改不了。顺序约束改由封账门禁承担。
    --     · 按期取最新版本 —— 同一期可能存在 v1/v2 两个批次，直接 SUM 会重复计。
    --     · 限法人、限 kind —— 累计预扣按**扣缴义务人**分别累计（跨法人混算等于
    --       把两家公司的所得加在一起）；年终奖是单独计税，它的 cum_taxable
    --       不能进综合所得的累计，进了就是多缴。
    -- ★★ 两个数口径不同，别一起 SUM（143 修的真 bug）：
    --   · `cum_taxable` 是**累计值**（本年截至本期的累计应纳税所得额），
    --     所以要取**最近一期**那一条；SUM 一遍会在第 3 期起重复累加
    --     （1 期 t1、2 期 t1+t2 → SUM = 2·t1+t2，而正确答案是 t1+t2）。
    --     这个错 133 就在：只算第 1、2 期看不出来（那时上游只有一条），
    --     到第 3 期才开始偏，而且偏得"看起来很合理"。
    --   · `tax_amount` 是**当期**税额，不是累计 —— 所以它仍然是 SUM。
    WITH up AS (
      SELECT DISTINCT ON (pr.period)
             pr.period, p.cum_taxable, p.tax_amount
        FROM public.payslip p
        JOIN public.pay_run pr ON pr.id = p.pay_run_id
       WHERE p.employee_id = e.person_id
         AND pr.legal_entity_id = r.legal_entity_id
         AND pr.kind = r.kind
         AND left(pr.period, 4) = left(r.period, 4)
         AND pr.period < r.period
       ORDER BY pr.period, pr.calc_version DESC, pr.id DESC
    )
    SELECT COALESCE((SELECT up.cum_taxable FROM up ORDER BY up.period DESC LIMIT 1), 0),
           COALESCE((SELECT sum(up.tax_amount) FROM up), 0)
      INTO v_cum_prev, v_cum_paid_tax;

    v_tax := public.fn_iit_month(v_cum_prev + v_taxable, v_cum_paid_tax);
    v_net := v_gross - v_si - v_tax;

    -- 算薪**后**规则：此时 gross/net 都有了，可以查"实发为 0""个税异常高"
    v_vars := v_vars || jsonb_build_object(
                'GROSS', v_gross, 'SI_EMPLOYEE', v_si, 'IIT', v_tax, 'NET', v_net);
    FOR rl IN SELECT * FROM public.fn_salary_rule_run('after', v_vars) LOOP
      INSERT INTO public.salary_rule_hit(run_id, person_id, rule_code, stage, action, message, amount)
      VALUES (p_run, e.person_id, rl.rule_code, 'after', rl.rule_action, rl.rule_message, rl.amount);
    END LOOP;

    INSERT INTO public.payslip(pay_run_id, employee_id, gross_amount, net_amount,
                               si_employee, tax_amount, cum_taxable, leave_deduct,
                               special_deduction)
    VALUES (p_run, e.person_id, v_gross, v_net, v_si, v_tax, v_cum_prev + v_taxable, v_leave,
            v_deduct)
    ON CONFLICT (pay_run_id, employee_id) DO UPDATE
      SET gross_amount=EXCLUDED.gross_amount, net_amount=EXCLUDED.net_amount,
          si_employee=EXCLUDED.si_employee, tax_amount=EXCLUDED.tax_amount,
          cum_taxable=EXCLUDED.cum_taxable, leave_deduct=EXCLUDED.leave_deduct,
          special_deduction=EXCLUDED.special_deduction
    RETURNING id INTO v_slip;

    DELETE FROM public.payslip_item WHERE payslip_id = v_slip;

    -- 明细按 v_factor 缩放（day 模式 factor=1，等于原样）。
    -- ★ 先 round 到分再求和：不 round 的话 BASE = v_base − 全精度和，
    --   会出现 6000.0001 这种"明细加起来差一分"的行。
    SELECT count(*), COALESCE(sum(round(amount * v_factor, 2)), 0) INTO v_struct_n, v_fixed_other
      FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s
     WHERE s.item_code <> 'BASE';

    IF v_struct_n > 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount)
      SELECT v_slip, s.item_code, round(s.amount * v_factor, 2)
        FROM public.fn_salary_structure_of(e.employment_id, v_period_end) s
       WHERE s.item_code <> 'BASE';
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip, 'BASE', v_base - v_fixed_other);
    ELSE
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'BASE', v_base);
    END IF;

    IF v_leave <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'LEAVE_DEDUCT', -v_leave);
    END IF;

    IF v_ot_pay <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'OT_PAY', v_ot_pay);
    END IF;
    -- 年假折现：出一行，并把单据标成 paid（同一事务，不会出现"发了钱但单据还挂 pending"）
    IF v_al <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip, 'AL_CASHOUT', v_al);
      UPDATE public.leave_cashout
         SET status = 'paid', payslip_id = v_slip
       WHERE employee_id = e.person_id AND settle_period = r.period AND status = 'pending';
    END IF;
    -- 社保明细：分险种各一行（历史工资条里的 SI_EMPLOYEE 行仍然保留，不动）
    FOR si IN SELECT key AS code, (value)::numeric AS amt FROM jsonb_each_text(v_si_lines) LOOP
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip, si.code, -si.amt);
    END LOOP;
    IF v_tax <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'IIT', -v_tax);
    END IF;
    IF v_perf <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'PERF_BONUS', v_perf);
    END IF;
    IF v_comm <> 0 THEN
      INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
        (v_slip,'COMMISSION', v_comm);
    END IF;

    -- 公式项：逐行入明细，顺序与求值一致（工资条上从上到下就是计算顺序）
    FOR fi IN
      SELECT code FROM public.salary_item
       WHERE is_active AND formula IS NOT NULL AND btrim(formula) <> ''
       ORDER BY sort_order, code
    LOOP
      IF v_extra ? fi.code THEN
        INSERT INTO public.payslip_item(payslip_id, item_code, amount) VALUES
          (v_slip, fi.code, (v_extra->>fi.code)::numeric);
      END IF;
    END LOOP;

    v_n := v_n + 1;
  END LOOP;

  IF v_n = 0 THEN
    RAISE EXCEPTION 'E_PAYROLL_NO_ELIGIBLE: 批次 % 一个人都没算出来（检查月薪标准与在职区间）', p_run;
  END IF;

  -- ★ 下游已封账：**不是"不许重算"，而是"重算之后下游必须仍然对得上"**（143）。
  --
  --   为什么用后验而不是前验：规则的本质是**一致性**，不是顺序。
  --   前验写成"下游有封账就一律不许重算"，会把"重算一遍结果没变"这种
  --   完全无害的动作也拦掉 —— 而那种拦法会让人绕过它（去直接改库）。
  --   后验只拦真正改坏了的情形：改了本期的数、下游的累计跟着失真 → 回滚。
  --   同事务内的 RAISE 会把上面所有写入一起撤销，库里什么都没变。
  --
  --   校验借 fn_payrun_chain：它算的就是"这一期的工资条与当前上游是否一致"，
  --   判据只有一份实现，不在这里重写一遍。
  FOR v_dn IN
    SELECT nx.id, nx.period
      FROM public.pay_run nx
     WHERE nx.legal_entity_id = r.legal_entity_id
       AND nx.kind = r.kind
       AND left(nx.period, 4) = left(r.period, 4)
       AND nx.period > r.period
       AND nx.status IN ('sealed', 'paid')
     ORDER BY nx.period
  LOOP
    SELECT c.stale_count, c.stale_names
      INTO v_sc, v_sn
      FROM public.fn_payrun_chain(v_dn.id) c;
    IF COALESCE(v_sc, 0) > 0 THEN
      -- ★ 文案只说事实，不说归因：下游对不上**可能是这次重算造成的**，
      --   也可能是这个库的历史数据本来就膨胀（见文件头"存量数据"那一段）。
      --   归因写死会在存量库上诬告一次重算 —— 而"报错说错了原因"比不报更坏。
      RAISE EXCEPTION 'E_PAYROLL_DOWNSTREAM_SEALED: % 已封账，但它与当前数据的'
        '累计对不上（%）。封账的数改不了，重算本期也不会让它变对 —— '
        '要修只能走调整单（另起一笔）或更正申报', v_dn.period, COALESCE(v_sn, '');
    END IF;
  END LOOP;

  RETURN v_n;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 封账：加两条链条门禁
-- ---------------------------------------------------------------------------
-- ★ 同样是从 139 原样抽出再插一段：会签那三条一条没动。
-- ★ 参数从 2 个变成 3 个 —— 必须先 DROP 旧签名，否则会留下一个重载：
--   调用方写成两个参数时命中的是**旧函数**（没有这条门禁），而它看起来一样能跑。
DROP FUNCTION IF EXISTS fn_pay_run_seal(bigint, text);

CREATE OR REPLACE FUNCTION fn_pay_run_seal(p_run bigint, p_by text,
                                           p_accept_stale boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r        record;
  v_req    boolean;
  v_total  int;
  v_bad    int;
  v_names  text;
  -- 143：累计链条门禁
  v_up         varchar(200);
  v_stale      int;
  v_stale_names varchar(400);
BEGIN
  SELECT * INTO r FROM public.pay_run WHERE id = p_run FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'E_RUN_NOT_FOUND: %', p_run; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'E_RUN_SEALED: 批次 % 已经是 % 状态', p_run, r.status;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payslip p WHERE p.pay_run_id = p_run) THEN
    RAISE EXCEPTION 'E_SEAL_EMPTY: 批次 % 没有工资条，不能封账', p_run;
  END IF;

  SELECT value_text = 'on' INTO v_req
    FROM public.fn_policy_effective('PAY_SIGNOFF_REQUIRED', NULL, public.app_today());

  SELECT count(*) FILTER (WHERE s.status <> 'void'),
         count(*) FILTER (WHERE s.status IN ('pending','objected'))
    INTO v_total, v_bad
    FROM public.pay_run_signoff s WHERE s.pay_run_id = p_run;

  -- ① 制度强制却没发起 → 拒
  IF COALESCE(v_req, false) AND v_total = 0 THEN
    RAISE EXCEPTION 'E_SIGNOFF_NOT_STARTED: 制度要求封账前完成会签，但批次 % 还没发起会签', p_run;
  END IF;

  -- ② 发起过会签就必须签完（不管制度开没开）。
  --    否则"有异议也能封账"，会签就只是装饰。
  IF v_total > 0 THEN
    IF v_bad > 0 THEN
      -- ★ ORDER BY 必须写在聚合函数里（string_agg(x, '、' ORDER BY ...)）：
      --   写成语句末尾的 ORDER BY 会得到 "column s.seq must appear in the GROUP BY clause"，
      --   而那个错看起来像"我漏了 GROUP BY"，实际是聚合函数自带排序这个语法。
      SELECT string_agg(s.role_name || '（' ||
               CASE s.status WHEN 'objected' THEN '有异议' ELSE '未签' END || '）',
               '、' ORDER BY s.seq)
        INTO v_names
        FROM public.pay_run_signoff s
       WHERE s.pay_run_id = p_run AND s.status IN ('pending','objected');
      RAISE EXCEPTION 'E_SIGNOFF_PENDING: 还有 % 个会签未完成：%。'
        '有异议的先改数，再重新发起会签', v_bad, v_names;
    END IF;
  END IF;

  -- ③ 累计链条（143）：能不能封，看两件事 —— 前期都封了没有；
  --    本期的累计是不是用**当前**的前期数据算出来的。
  --    ★ 判据与 fn_payrun_chain 是同一个：页面上"还不能封"的说法与这里拒绝的理由
  --      必须是同一句，否则人看着绿的按钮点下去报红。
  SELECT c.upstream_draft, c.stale_count, c.stale_names
    INTO v_up, v_stale, v_stale_names
    FROM public.fn_payrun_chain(p_run) c;

  IF v_up IS NOT NULL THEN
    RAISE EXCEPTION 'E_SEAL_UPSTREAM_DRAFT: 本期之前的 % 还没封账。'
      '累计预扣是"累计到本期"，前期没定稿就封本期，本期的累计会永久少一块 —— '
      '先把 % 封了，再回来封本期', v_up, v_up;
  END IF;

  -- ★ "累计已过期"不是一刀切拒绝，而是**要人明确勾选**（143）。
  --   原因：stale 判据拿"应当是多少"去比对工资条上存的值，而手工调整过、
  --   或从旧系统导进来的历史工资条本来就可能与公式对不上 —— 那不是"前期改过"，
  --   是数据来源不同。一刀切拒绝，第一次误伤之后人就会绕过它（去直接改库）；
  --   完全放行，"改了前期、本期照旧封着"就没人管。
  --   所以：默认拒（说清有几个人、建议先重算），确认后放行（p_accept_stale）。
  --   这与"减少员工权益的操作要人签字"是同一条思路 —— 例外要有签字人。
  IF v_stale > 0 AND NOT COALESCE(p_accept_stale, false) THEN
    RAISE EXCEPTION 'E_SEAL_CHAIN_STALE: 有 % 人的累计与当前前期数据对不上（%）。'
      '可能是前期算过之后又改过，也可能是从旧系统导进来的历史数 —— '
      '建议先重算本期；确认要按现状封账，请勾选"确认按现状封账"再提交',
      v_stale, v_stale_names;
  END IF;

  UPDATE public.pay_run
     SET status = 'sealed', sealed_at = clock_timestamp(), sealed_by = p_by
   WHERE id = p_run;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. 个税扣缴申报表：累计按期去重（141 的 cum 改为按期取最新版本）
-- ---------------------------------------------------------------------------
-- 141 上线当天就有一个隐患：同一期若存在两个已封账版本（v1 封了、发现错了
-- 又算 v2 再封），cum 里的 SUM 会把两版都加进去 —— 申报表上的累计翻倍，
-- 而它是要报给税务局的。封账门禁不管这件事（它管的是"顺序"），所以单独修。
CREATE OR REPLACE FUNCTION fn_declare_iit(p_entity bigint, p_period varchar)
RETURNS TABLE (
  employee_no        varchar(16),
  person_name        varchar(64),
  id_type            varchar(16),
  id_no              varchar(64),
  id_verified        boolean,
  income             numeric(12,2),     -- 本月收入额（= 工资条应发）
  exempt_income      numeric(12,2),     -- 本月免税收入（系统不登记，恒 0）
  deduct_std         numeric(12,2),     -- 本月减除费用（5000）
  deduct_special     numeric(12,2),     -- 本月专项扣除（三险一金个人部分）
  deduct_extra       numeric(12,2),     -- 本月专项附加扣除
  taxable_now        numeric(14,2),     -- 本月应纳税所得额
  cum_income         numeric(14,2),     -- 累计收入额
  cum_deduct_std     numeric(14,2),     -- 累计减除费用
  cum_deduct_special numeric(14,2),     -- 累计专项扣除
  cum_deduct_extra   numeric(14,2),     -- 累计专项附加扣除
  cum_taxable        numeric(14,2),     -- 累计应纳税所得额（工资条上存的那个）
  cum_tax            numeric(14,2),     -- 累计应纳税额（按年表算）
  cum_paid           numeric(14,2),     -- 累计已缴（含本月）
  tax_now            numeric(12,2),     -- 本月应扣缴税额
  should_pay         numeric(12,2),     -- 应补(退)税额（负数 = 多扣，汇算时退）
  months_counted     int,               -- 本年已申报月数（= 已封账月数）
  filed_months       varchar(200),      -- 已封账月份清单
  remark             varchar
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_run    bigint;
  v_pend   date;
  v_year   int;
  v_thr    numeric(12,2);
  v_months int;
  v_filed  varchar(200);
BEGIN
  v_run  := public.fn_declare_run(p_entity, p_period, 'monthly');
  v_pend := (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;
  v_year := left(p_period, 4)::int;

  SELECT t.threshold INTO v_thr FROM public.tax_param t WHERE t.year = v_year;
  v_thr := COALESCE(v_thr, 5000);

  SELECT count(DISTINCT r.period),
         string_agg(DISTINCT r.period, ',' ORDER BY r.period)
    INTO v_months, v_filed
    FROM public.pay_run r
   WHERE r.legal_entity_id = p_entity
     AND r.kind = 'monthly'
     AND r.status IN ('sealed', 'paid')
     AND left(r.period, 4) = v_year::text
     AND r.period <= p_period;

  RETURN QUERY
  WITH s AS (
    SELECT p.id, p.employee_id, p.gross_amount, p.si_employee, p.tax_amount,
           p.special_deduction, p.cum_taxable
      FROM public.payslip p
     WHERE p.pay_run_id = v_run
  ), cum AS (
    -- 本年累计：同法人、<= 本期、已封账的工资条。跨法人不算在一起 ——
    -- 累计预扣是按**扣缴义务人**累计的，两家公司各扣各的。
    -- ★ 143：按期取**最新版本**再求和。同一期可能存在 v1（作废前的数）与
    --   v2（重算后的数）两个已封账批次，直接 SUM 会让累计翻倍 ——
    --   而申报表上的累计数是报给税务局的，翻倍就是多缴。
    SELECT y.employee_id,
           sum(y.gross_amount)      AS cum_income,
           sum(y.si_employee)       AS cum_si,
           sum(y.special_deduction) AS cum_add,
           sum(y.tax_amount)        AS cum_paid
      FROM (
        SELECT DISTINCT ON (r2.period, x.employee_id)
               x.employee_id, x.gross_amount, x.si_employee,
               x.special_deduction, x.tax_amount
          FROM public.payslip x
          JOIN public.pay_run r2 ON r2.id = x.pay_run_id
         WHERE r2.legal_entity_id = p_entity
           AND r2.kind = 'monthly'
           AND r2.status IN ('sealed', 'paid')
           AND left(r2.period, 4) = v_year::text
           AND r2.period <= p_period
         ORDER BY r2.period, x.employee_id, r2.calc_version DESC, r2.id DESC
      ) y
     GROUP BY y.employee_id
  )
  SELECT
    (SELECT n.no FROM public.employee_no n
      WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
      ORDER BY n.assigned_at DESC LIMIT 1)::varchar(16),
    pe.full_name::varchar(64),
    '居民身份证'::varchar(16),
    idp.profile_value::varchar(64),
    (idp.verified_by IS NOT NULL),
    s.gross_amount,
    0::numeric(12,2),
    v_thr,
    s.si_employee,
    s.special_deduction,
    GREATEST(s.gross_amount - s.si_employee - v_thr - s.special_deduction, 0)::numeric(14,2),
    c.cum_income::numeric(14,2),
    (v_thr * v_months)::numeric(14,2),
    c.cum_si::numeric(14,2),
    c.cum_add::numeric(14,2),
    s.cum_taxable,
    public.fn_iit_cumulative(s.cum_taxable)::numeric(14,2),
    c.cum_paid::numeric(14,2),
    s.tax_amount,
    (public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid)::numeric(12,2),
    v_months,
    v_filed,
    nullif(concat_ws('；',
      CASE WHEN idp.profile_value IS NULL
           THEN '档案未登记身份证号，无法申报' END,
      CASE WHEN idp.profile_value IS NOT NULL AND idp.verified_by IS NULL
           THEN '身份证号未核实' END,
      -- 勾稽：累计应纳税所得额 应当 = 累计收入 − 累计社保 − 累计减除 − 累计附加。
      -- 差出来只有两种原因：某月应纳税所得额为负被截到 0；或者**算这一期的时候
      -- 上一期还没封账**（累计预扣读不到那一期，本月就按"只有这一个月"算了，
      -- 而封账之后改不了，累计会一直少一个月）。第二种更容易发生，所以要点名。
      CASE WHEN abs(s.cum_taxable
                    - (c.cum_income - c.cum_si - v_thr * v_months - c.cum_add)) > 0.02
           THEN '累计勾稽差 ' || round(s.cum_taxable
                    - (c.cum_income - c.cum_si - v_thr * v_months - c.cum_add), 2)::text
                || '（工资条上的累计数与"累计收入−累计各项扣除"对不上：'
                || '通常是算这一期时上一期还没封账，累计就少算了一个月 —— '
                || '也可能某月应纳税所得额为负被截到 0）' END,
      CASE WHEN public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid > 0.02
           THEN '本期应补缴 ' || round(public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid, 2)::text
                || '（本年有未封账月份，累计已缴少了）' END,
      CASE WHEN public.fn_iit_cumulative(s.cum_taxable) - c.cum_paid < -0.02
           THEN '累计多扣 ' || round(c.cum_paid - public.fn_iit_cumulative(s.cum_taxable), 2)::text
                || '（预扣多于应扣，汇算清缴时退）' END
    ), '')::varchar
  FROM s
  JOIN public.person pe ON pe.id = s.employee_id
  JOIN cum c ON c.employee_id = s.employee_id
  LEFT JOIN LATERAL (
    -- 未核实的号也可能有多条（003 允许），取已核实的那条优先
    SELECT pp.profile_value, pp.verified_by
      FROM public.person_profile pp
     WHERE pp.person_id = pe.id AND pp.profile_type = 'national_id'
     ORDER BY (pp.verified_by IS NOT NULL) DESC, pp.id DESC
     LIMIT 1
  ) idp ON true
  ORDER BY 1 NULLS LAST, 2;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.CHAIN',
   '累计预扣链条：先算哪期都行、封账自前向后、封完不许动上游、跨法人/年终奖不混算',
   'PAYROLL','ALGORITHM','fn_payrun_chain','public','pay_run','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-CHAIN',
   '链条接进界面与接口：封账前能看见"为什么不能封"、重算被拦时说得清原因',
   'PAYROLL','ACL','fn_payrun_chain','public','pay_run','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
