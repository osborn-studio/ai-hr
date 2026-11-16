-- ===========================================================================
-- 137 · 算薪预演（改参数之前先看影响面）
-- ===========================================================================
-- 要解决的问题很具体：HR 在调津贴、调社保基数、改制度项之前，没人知道这一改
-- 会让工资总额变多少、谁变化最大。现在只能"改了再算一遍，算完看结果"——
-- 而算完之后工资条就已经落账了，想反悔得重算，重算又动了历史。
--
-- 所以预演必须满足两条，缺一条就没人敢用：
--   ① 数要对：用**真的算薪函数**跑，不能另写一套近似算法（两套算法一定漂）；
--   ② 零痕迹：跑完之后库里不能多一行、不能少一行，也不能改任何金额。
--
-- 第 ② 条用 PL/pgSQL 的块级异常实现：把整段计算放进 BEGIN ... EXCEPTION 块，
-- 数取完之后主动 RAISE 一个哨兵异常，块的回滚把这段里所有写入撤销（隐式
-- SAVEPOINT），而**局部变量的值不会被回滚** —— 结果就这么带出来了。
--
-- 为什么不用 SAVEPOINT 再 ROLLBACK TO：那样要么得让调用方参与事务控制
-- （服务层拿到的是连接，回滚就把审计留痕一起滚了），要么得显式 RELEASE，
-- 而 release 之后就没法回滚了。哨兵异常是纯函数内的、对调用方无感的做法。
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. before 规则门：把"服务层那 30 行 JS"搬进库里，成为唯一出处
-- ---------------------------------------------------------------------------
-- 预演也要报"这批人里有 N 条 before 规则会拦住算薪"，否则会出现
-- "预演说没问题、真算被拦" 的分裂。而如果预演自己再拼一遍变量，那就是
-- 两套逻辑各自漂 —— 所以提成函数，服务层改成调它。
CREATE OR REPLACE FUNCTION fn_payroll_gate(p_period varchar, p_entity bigint)
-- ★ 输出列不能叫 action / message（097 记过这个坑），用 rule_ 前缀。
RETURNS TABLE (person_id bigint, rule_code varchar, rule_action varchar,
               rule_message varchar, amount numeric)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_end   date;
  v_items jsonb;
  pe      record;
  h       record;
BEGIN
  v_end := (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;

  -- 变量铺全：所有已启用工资项 = 0，再用这个人实际的月薪、提成、考勤覆盖。
  -- 与 fn_payroll_calc 里的变量口径一致（那里也是"项先给 0 再覆盖"）。
  SELECT COALESCE(jsonb_object_agg(code, 0), '{}'::jsonb) INTO v_items
    FROM public.salary_item WHERE is_active;

  FOR pe IN
    SELECT em.person_id,
           COALESCE((SELECT s.monthly_amount FROM public.salary_standard s
                      WHERE s.employment_id = em.id AND s.effective_from <= v_end
                      ORDER BY s.effective_from DESC LIMIT 1), 0) AS base
      FROM public.employment em
     WHERE em.legal_entity_id = p_entity
       AND daterange(em.hire_date, em.leave_date, '[]') @> v_end
  LOOP
    FOR h IN
      SELECT * FROM public.fn_salary_rule_run('before',
        v_items || jsonb_build_object(
          'MONTHLY', pe.base, 'GROSS', pe.base, 'NET', pe.base,
          'COMMISSION', public.fn_commission_amount(pe.person_id, p_period),
          'PRESENT_DAYS', 0, 'WORK_DAYS', 0, 'LEAVE_DAYS', 0,
          'SI_BASE', pe.base, 'TAX_THRESHOLD', 5000))
    LOOP
      person_id    := pe.person_id;
      rule_code    := h.rule_code;
      rule_action  := h.rule_action;
      rule_message := h.rule_message;
      amount       := h.amount;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION fn_payroll_gate IS
  '算薪前的 before 规则门：返回本期所有命中（含 warn 与 block）。'
  '服务层与预演都调它 —— 分头实现会让"预演说行、真算被拦"。';

-- ---------------------------------------------------------------------------
-- 2. 预演主体
-- ---------------------------------------------------------------------------
-- p_overrides 支持的键（都可省）：
--   salary_pct   月薪标准整体 ×(1+pct/100)     例：5 表示全员上调 5%
--   salary_add   每人月薪 + 固定额             例：300
--   si_base_pct  已申报社保基数整体 ×(1+pct/100)
--   policy       {"PAY_OT_AUTO":"on"}           制度项改为该值（本期起生效）
--
-- 返回：
--   base / after / delta（gross·net·si·tax 四个总额）
--   movers  变动最大的 10 人（净额），每人带"主因那一项"
--   negative_net  实发为负的人（这是"参数改坏了"最直接的信号）
--   blocked before 规则会拦住的人
--   no_effect  改动对本期完全没有影响（明确说出来，不让页面显示一排 0 让人猜）
CREATE OR REPLACE FUNCTION fn_payroll_preview(
  p_period  varchar,
  p_entity  bigint,
  p_overrides jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_end    date;
  v_run    bigint;
  v_status varchar(16);
  v_tag    text;

  v_pct    numeric(8,4) := 0;
  v_add    numeric(12,2) := 0;
  v_sipct  numeric(8,4) := 0;
  v_policy jsonb := '{}'::jsonb;
  v_applied jsonb := '[]'::jsonb;

  v_base_pp    jsonb;
  v_base_items jsonb;
  v_base_sum   jsonb;
  v_after_sum  jsonb;
  v_movers     jsonb;
  v_neg        jsonb;
  v_blocked    jsonb;
  v_head       int := 0;
  v_out        jsonb;

  k text;
  v text;
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_ARG_INVALID: period 必须是 YYYY-MM（收到 %）', p_period;
  END IF;
  IF p_entity IS NULL OR p_entity <= 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: entity 必须是正整数';
  END IF;

  v_end := (to_date(p_period || '-01', 'YYYY-MM-DD') + interval '1 month - 1 day')::date;

  -- 封账后不能预演：算薪函数会拒，预演也不该给出一个"其实算不出来"的数。
  SELECT id, status INTO v_run, v_status
    FROM public.pay_run
   WHERE period = p_period AND legal_entity_id = p_entity AND kind = 'monthly'
   ORDER BY id LIMIT 1;
  IF v_run IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'E_PAY_PREVIEW_SEALED: % 的批次已封账（%），不能预演；'
      '要预演请先重开批次', p_period, v_status;
  END IF;

  v_pct    := COALESCE((p_overrides->>'salary_pct')::numeric, 0);
  v_add    := COALESCE((p_overrides->>'salary_add')::numeric, 0);
  v_sipct  := COALESCE((p_overrides->>'si_base_pct')::numeric, 0);
  v_policy := COALESCE(p_overrides->'policy', '{}'::jsonb);

  v_tag := 'PREVIEW_ROLLBACK_' || md5(random()::text || clock_timestamp()::text);

  -- ★ 从这里往下全在块内：块结束时（不管正常还是异常）都会回滚到块入口。
  --   连"批次没有就建一个"也放在块内 —— 放在块外就会留下一条 pay_run。
  BEGIN
    IF v_run IS NULL THEN
      INSERT INTO public.pay_run(period, legal_entity_id)
      VALUES (p_period, p_entity) RETURNING id INTO v_run;
    END IF;

    -- ---- ① 基线：按当前配置真的算一遍 ----
    PERFORM public.fn_payroll_calc(v_run);

    SELECT COALESCE(jsonb_object_agg(employee_id, jsonb_build_object(
             'gross', gross_amount, 'net', net_amount,
             'si', si_employee, 'tax', tax_amount)), '{}'::jsonb),
           count(*)
      INTO v_base_pp, v_head
      FROM public.payslip WHERE pay_run_id = v_run;

    SELECT COALESCE(jsonb_object_agg(employee_id, items), '{}'::jsonb) INTO v_base_items
      FROM (SELECT p.employee_id, jsonb_object_agg(i.item_code, i.amount) AS items
              FROM public.payslip p JOIN public.payslip_item i ON i.payslip_id = p.id
             WHERE p.pay_run_id = v_run
             GROUP BY p.employee_id) t;

    SELECT jsonb_build_object(
             'gross', COALESCE(sum(gross_amount), 0),
             'net',   COALESCE(sum(net_amount), 0),
             'si',    COALESCE(sum(si_employee), 0),
             'tax',   COALESCE(sum(tax_amount), 0))
      INTO v_base_sum
      FROM public.payslip WHERE pay_run_id = v_run;

    -- ---- ② 应用覆盖 ----
    -- 只改"算薪会用到的那一条"月薪标准（每个任职取 effective_from 最大且 <= 期末），
    -- 改全部历史行会把过去月份的工资一起改掉 —— 那就不再是"预演本月"了。
    IF v_pct <> 0 OR v_add <> 0 THEN
      UPDATE public.salary_standard s
         SET monthly_amount = GREATEST(round(s.monthly_amount * (1 + v_pct / 100) + v_add, 2), 0)
       WHERE s.id IN (
         SELECT DISTINCT ON (x.employment_id) x.id
           FROM public.salary_standard x
          WHERE x.effective_from <= v_end
          ORDER BY x.employment_id, x.effective_from DESC);
      v_applied := v_applied || to_jsonb(format('月薪标准：%s%s%s',
        CASE WHEN v_pct <> 0 THEN v_pct || '%' ELSE '' END,
        CASE WHEN v_pct <> 0 AND v_add <> 0 THEN ' 且 ' ELSE '' END,
        CASE WHEN v_add <> 0 THEN v_add || ' 元' ELSE '' END));
    END IF;

    IF v_sipct <> 0 THEN
      UPDATE public.si_base_declare d
         SET base_amount = round(d.base_amount * (1 + v_sipct / 100), 2)
       WHERE d.effective_from <= v_end
         AND d.employee_id IN (SELECT em.person_id FROM public.employment em
                                WHERE em.legal_entity_id = p_entity);
      v_applied := v_applied || to_jsonb(format('社保申报基数：%s%%', v_sipct));
    END IF;

    FOR k, v IN SELECT key, value #>> '{}' FROM jsonb_each(v_policy) LOOP
      -- 制度项的生效日放在本期 1 号：只影响本期及以后，不动历史月份。
      INSERT INTO public.policy_value(policy_code, effective_from, value_num, value_text,
                                      published_by, reason)
      VALUES (k,
              date_trunc('month', v_end)::date,
              CASE WHEN v ~ '^-?\d+(\.\d+)?$' THEN v::numeric ELSE NULL END,
              CASE WHEN v ~ '^-?\d+(\.\d+)?$' THEN NULL ELSE v END,
              'preview', '算薪预演（不落库）')
      ON CONFLICT (policy_code, effective_from) DO UPDATE
        SET value_num  = EXCLUDED.value_num,
            value_text = EXCLUDED.value_text,
            published_by = EXCLUDED.published_by,
            reason = EXCLUDED.reason;
      v_applied := v_applied || to_jsonb(format('制度项 %s = %s', k, v));
    END LOOP;

    -- ---- ③ 按新配置再算一遍 ----
    PERFORM public.fn_payroll_calc(v_run);

    SELECT jsonb_build_object(
             'gross', COALESCE(sum(gross_amount), 0),
             'net',   COALESCE(sum(net_amount), 0),
             'si',    COALESCE(sum(si_employee), 0),
             'tax',   COALESCE(sum(tax_amount), 0))
      INTO v_after_sum
      FROM public.payslip WHERE pay_run_id = v_run;

    -- ---- ④ 变动最大的人（带"主因那一项"） ----
    -- 主因用 payslip_item 的逐项差额算：不给这个，HR 只知道"他少了 320"，
    -- 还得自己点开两张工资条对 —— 而这段对话在电话里进行。
    -- ★ 括号位置：abs(x->>'delta_net')::numeric 会把 ::numeric 作用在 abs() 的结果上，
    --   而 abs(text) 不存在 —— 报错是 "function abs(text) does not exist"，
    --   看起来像 abs 用错了，实际是类型转换写在了外面。
    SELECT COALESCE(jsonb_agg(x ORDER BY abs((x->>'delta_net')::numeric) DESC), '[]'::jsonb)
      INTO v_movers
      FROM (
        SELECT jsonb_build_object(
                 'person_id', p.employee_id,
                 'name', pe.full_name,
                 'gross_before', (v_base_pp->(p.employee_id::text)->>'gross')::numeric,
                 'gross_after',  p.gross_amount,
                 'net_before',   (v_base_pp->(p.employee_id::text)->>'net')::numeric,
                 'net_after',    p.net_amount,
                 'delta_net',    p.net_amount - (v_base_pp->(p.employee_id::text)->>'net')::numeric,
                 'top_item',     ti.code,
                 'top_delta',    ti.d) AS x
          FROM public.payslip p
          JOIN public.person pe ON pe.id = p.employee_id
          LEFT JOIN LATERAL (
            SELECT i.item_code AS code,
                   round(i.amount - COALESCE((v_base_items->(p.employee_id::text)->>i.item_code)::numeric, 0), 2) AS d
              FROM public.payslip_item i
             WHERE i.payslip_id = p.id
             ORDER BY abs(i.amount - COALESCE((v_base_items->(p.employee_id::text)->>i.item_code)::numeric, 0)) DESC
             LIMIT 1) ti ON true
         WHERE p.pay_run_id = v_run
           AND p.net_amount <> (v_base_pp->(p.employee_id::text)->>'net')::numeric
         ORDER BY abs(p.net_amount - (v_base_pp->(p.employee_id::text)->>'net')::numeric) DESC
         LIMIT 10) t;

    -- ---- ⑤ 实发为负：参数改坏了最直接的信号 ----
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'person_id', p.employee_id, 'name', pe.full_name,
             'net_after', p.net_amount, 'gross_after', p.gross_amount)
             ORDER BY p.net_amount), '[]'::jsonb)
      INTO v_neg
      FROM public.payslip p JOIN public.person pe ON pe.id = p.employee_id
     WHERE p.pay_run_id = v_run AND p.net_amount < 0;

    -- ---- ⑥ before 规则门（按新配置）----
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'person_id', g.person_id, 'rule', g.rule_code, 'message', g.rule_message)
             ORDER BY g.person_id), '[]'::jsonb)
      INTO v_blocked
      FROM public.fn_payroll_gate(p_period, p_entity) g
     WHERE g.rule_action = 'block';

    v_out := jsonb_build_object(
      'period', p_period,
      'entity_id', p_entity,
      'headcount', v_head,
      'overrides', COALESCE(p_overrides, '{}'::jsonb),
      'applied', v_applied,
      'base', v_base_sum,
      'after', v_after_sum,
      'delta', jsonb_build_object(
        'gross', (v_after_sum->>'gross')::numeric - (v_base_sum->>'gross')::numeric,
        'net',   (v_after_sum->>'net')::numeric   - (v_base_sum->>'net')::numeric,
        'si',    (v_after_sum->>'si')::numeric    - (v_base_sum->>'si')::numeric,
        'tax',   (v_after_sum->>'tax')::numeric   - (v_base_sum->>'tax')::numeric),
      'movers', v_movers,
      'negative_net', v_neg,
      'blocked', v_blocked,
      -- 没有任何变化时明确说出来。让页面显示一排 0 而不解释，使用者会怀疑"是不是没算"
      'no_effect', jsonb_array_length(v_applied) = 0
                   OR ((v_after_sum->>'gross')::numeric = (v_base_sum->>'gross')::numeric
                       AND (v_after_sum->>'net')::numeric = (v_base_sum->>'net')::numeric));

    -- ★ 哨兵：数已经取到变量里了（局部变量不随回滚丢失），主动抛一个"认得出的错"，
    --   让块把它撤销。下面 catch 里只吞这一条，别的错照常往上抛。
    RAISE EXCEPTION '%', v_tag;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> v_tag THEN
      RAISE;      -- 考勤未封账、绩效未封存、没人生成工资条……原样抛出，预演不掩盖
    END IF;
  END;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION fn_payroll_preview IS
  '算薪预演：按覆盖参数真算两遍（基线 / 改后），返回总额差异、Top 变动人与主因、实发为负的人。'
  '整段在 EXCEPTION 块内执行并主动抛哨兵异常撤销 —— 预演不留任何痕迹，连批次也不会多出来。';

-- ---------------------------------------------------------------------------
-- 3. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.PPV','算薪预演：真算两遍给出影响面，且零痕迹（批次/工资条/明细/制度项全不留）',
   'PAYROLL','ALGORITHM','fn_payroll_preview','public','payslip','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-PPV','预演接进界面：改薪/改基数/改制度项三路覆盖都能看出影响',
   'PAYROLL','ACL','fn_payroll_gate','public','pay_run','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
