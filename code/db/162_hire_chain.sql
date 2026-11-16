-- ============================================================================
-- 162_hire_chain.sql · 入职一条链：offer → 人 → 任职 → 工号 → 合同草稿
-- ----------------------------------------------------------------------------
-- 现状：061 的 fn_hire_from_offer 已经把"offer → 人 → 任职 → 工号"做完了，
-- 160 也把合同做出来了。但两件事**没有连起来** —— 入职之后要另开一页填合同，
-- 而合同上最要紧的三样（岗位、月薪、入职日）刚刚在 offer 里填过一遍。
--
-- 填两遍的后果不是"麻烦"，是**两个数会不一样**：
--   · offer 上写 6500，合同上手滑填 6000 —— 争议时以合同为准，员工少 500；
--   · offer 上岗位是"店长助理"，合同上写"店员" —— 试用期考核标准跟着变；
--   · 入职日 offer 是 3/1、合同写 3/5 —— 工龄、社保起缴月、试用期起算全差 4 天。
-- 而这些错都不会报错：两份文件各自都"说得通"。
--
-- ★ 三条设计取舍：
--
--   ① **不重写 fn_hire_from_offer，只在它之上编排。**
--      那个函数已经有断言（RO/HI 组）守着，重写一遍等于把那些结论作废。
--      这里做的是"调它，然后接着做下一件事"。
--
--   ② **合同默认是草稿（draft），不自动签。**
--      合同要面签、要盖章，系统替人"签"下去是最坏的一种自动化 ——
--      它会把"还没谈拢"记录成"已经签了"。所以：生成、留草稿、等人点签署。
--
--   ③ **法定校验仍然走 fn_contract_check，这里不判。**
--      默认试用期 3 个月 + 默认合同期 3 年 —— 这两个默认值本身要能过校验；
--      调用方可以覆盖，覆盖错了由 fn_contract_check 拦（block 抛、warn 带出）。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_onboard_full(
  p_offer        bigint,
  p_person       bigint,          -- NULL = 按 offer 上的候选人姓名新建
  p_hire_date    date,
  p_legal_entity bigint,
  p_contract     jsonb DEFAULT '{}'::jsonb,
  p_by           varchar DEFAULT 'system'
) RETURNS TABLE (
  person_id     bigint,
  employment_id bigint,
  contract_id   bigint,
  contract_no   varchar,
  warns         text
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_person  bigint;
  v_emp     bigint;
  v_pos     varchar(64);
  v_wage    numeric(12,2);
  v_kind    varchar(16);
  v_start   date;
  v_end     date;
  v_pf      date;
  v_pt      date;
  v_tpl     bigint;
  v_addr    varchar(200);
  v_place   varchar(96);
  v_no      varchar(48);
  v_seq     int;
  v_cid     bigint;
  v_checks  record;
  v_blocks  text[] := '{}';
  v_warns   text[] := '{}';
BEGIN
  IF p_hire_date IS NULL THEN
    RAISE EXCEPTION 'E_HIRE_NO_DATE: 入职日必填';
  END IF;
  IF p_legal_entity IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 甲方主体必填（合同甲方不能是空的）';
  END IF;

  -- ---- 1. 入职（复用 061，不重写）----
  SELECT f.person_id, f.employment_id INTO v_person, v_emp
    FROM public.fn_hire_from_offer(p_offer, p_person, p_hire_date, p_legal_entity, p_by) f;

  -- ---- 2. 从 offer 最新版带出岗位与月薪 ----
  SELECT ov.position, ov.monthly_amount INTO v_pos, v_wage
    FROM public.offer_version ov
   WHERE ov.offer_id = p_offer
   ORDER BY ov.version DESC
   LIMIT 1;
  IF v_wage IS NULL OR v_wage <= 0 THEN
    RAISE EXCEPTION 'E_CT_NO_WAGE: offer % 没有有效的月薪版本，合同上的工资无从带出', p_offer;
  END IF;

  -- ---- 3. 合同参数：调用方可覆盖，没给就用安全默认 ----
  v_kind  := COALESCE(NULLIF(btrim(COALESCE(p_contract->>'kind', '')), ''), 'fixed');
  v_start := COALESCE(NULLIF(p_contract->>'start_date', '')::date, p_hire_date);
  -- 默认 3 年：与"3 个月试用期"配套（3 年以上才允许 6 个月，3 年整允许 3 个月）
  v_end   := COALESCE(NULLIF(p_contract->>'end_date', '')::date,
                      CASE WHEN v_kind = 'open' THEN NULL ELSE (v_start + interval '3 years')::date END);
  v_pf    := COALESCE(NULLIF(p_contract->>'probation_from', '')::date,
                      CASE WHEN v_kind IN ('fixed','open') THEN v_start END);
  v_pt    := COALESCE(NULLIF(p_contract->>'probation_to', '')::date,
                      CASE WHEN v_kind IN ('fixed','open') THEN (v_start + interval '3 months')::date END);
  v_place := COALESCE(NULLIF(btrim(COALESCE(p_contract->>'workplace', '')), ''),
                      (SELECT o.name FROM public.org_unit o WHERE o.id =
                        (SELECT ov2.org_id FROM public.offer ov2 WHERE ov2.id = p_offer)));
  -- ★ 送达地址**不给默认值**：025 的 offer 里也没有这一列，
  --   而"从别处猜一个地址"比留空更危险 —— 留空会被下面那条 E_CT_FIELD_MISSING 拦住，
  --   猜一个则会印在一份看起来完整的合同上，将来文书送不到还没人知道。
  v_addr  := NULLIF(btrim(COALESCE(p_contract->>'employee_address', '')), '');

  -- 模板：按类型取启用中的那一份
  SELECT t.id INTO v_tpl FROM public.contract_template t
   WHERE t.kind = v_kind AND t.is_active
   ORDER BY t.version DESC, t.id LIMIT 1;
  IF v_tpl IS NULL THEN
    RAISE EXCEPTION 'E_CT_NO_TEMPLATE: 没有适用于「%」的启用中模板', v_kind;
  END IF;

  -- ---- 4. 法定校验（在库里判，见文件头 ③）----
  FOR v_checks IN
    SELECT * FROM public.fn_contract_check(
      v_person, p_legal_entity, v_kind, v_start, v_end, v_pf, v_pt, NULL)
  LOOP
    IF v_checks.level = 'block' THEN
      v_blocks := v_blocks || v_checks.message;
    ELSE
      v_warns := v_warns || v_checks.message;
    END IF;
  END LOOP;
  IF array_length(v_blocks, 1) > 0 THEN
    RAISE EXCEPTION 'E_CT_BLOCKED: %', array_to_string(v_blocks, '；');
  END IF;

  -- 送达地址缺失是硬伤：合同少了送达地址条款，将来文书送不到
  IF v_addr IS NULL THEN
    RAISE EXCEPTION 'E_CT_FIELD_MISSING: 乙方送达地址为空 —— 合同少了这一条，'
      '将来寄出的文书可能被认定未送达';
  END IF;

  -- ---- 5. 合同编号：主体-年份-流水（与 contract.mjs 的规则一致）----
  SELECT count(*)::int INTO v_seq FROM public.employment_contract c
   WHERE c.legal_entity_id = p_legal_entity
     AND c.start_date >= date_trunc('year', v_start);
  -- ★ 用 GREATEST 而不是写死 2：lpad('994', 2, '0') 会**截断**成 '99'，
  --   把主体号吃掉一位，合同号就跟主体对不上了（这个坑一次就中）。
  v_no := 'HT' || lpad(p_legal_entity::text,
                       GREATEST(2, length(p_legal_entity::text)), '0') || '-'
          || to_char(v_start, 'YYYY') || '-' || lpad((v_seq + 1)::text, 4, '0');

  -- ---- 6. 落一份合同草稿（不自动签，见文件头 ②）----
  INSERT INTO public.employment_contract
    (employee_id, legal_entity_id, contract_no, kind, start_date, end_date,
     probation_from, probation_to, job_title, workplace, employee_address,
     hours_system, wage_amount, wage_unit, pay_day, template_id, status)
  VALUES (v_person, p_legal_entity, v_no, v_kind, v_start, v_end,
     v_pf, v_pt, v_pos, v_place, v_addr,
     COALESCE(NULLIF(btrim(COALESCE(p_contract->>'hours_system', '')), ''), 'standard'),
     v_wage,
     COALESCE(NULLIF(btrim(COALESCE(p_contract->>'wage_unit', '')), ''), 'month'),
     COALESCE(NULLIF(p_contract->>'pay_day', '')::int, 15),
     v_tpl, 'draft')
  RETURNING id INTO v_cid;

  RETURN QUERY SELECT v_person, v_emp, v_cid, v_no::varchar,
    CASE WHEN array_length(v_warns, 1) > 0 THEN array_to_string(v_warns, '；') END;
END;
$$;

COMMENT ON FUNCTION fn_onboard_full IS
  '入职一条链（162）：调 fn_hire_from_offer 完成 offer→人→任职→工号，'
  '然后按 offer 最新版的岗位与月薪生成一份**合同草稿**（不自动签）。'
  '★ 岗位/薪资/入职日只填一次 —— 填两遍必然不一致，而不一致不会报错，'
  '只会在争议时按合同（往往是更低的那个数）执行。'
  '法定校验走 fn_contract_check：block 抛、warn 随结果带出。';

-- ---------------------------------------------------------------------------
-- 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.HIREC',
   '入职一条链：offer 的岗位与月薪带进合同（只填一次）、合同默认草稿不自动签、'
   '试用期超限在编排层也拦、送达地址缺失不许生成',
   'ORG','ALGORITHM','fn_onboard_full','public','employment_contract','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-HIREC',
   '入职一条链接进接口：一次调用返回人/任职/合同号，合同仍是草稿待签',
   'ORG','ACL','fn_onboard_full','public','employment','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
