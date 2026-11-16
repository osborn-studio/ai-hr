-- ============================================================================
-- 169_fix_change_probation.sql · 修试用期内转店签不下变更协议
-- ----------------------------------------------------------------------------
-- 全生命周期验收（test/lifecycle.mjs）跑出来的真缺陷：
--
--   LC5 红 —— 原合同仍是 2026-05-06~2029-05-06、变更协议永远停在 draft。
--   根因：签署协议时 fn_ec_close_prev 把原合同 end_date 截到生效日前一天
--   （2026-06-30），而原合同的 probation_to 是 2026-08-06 —— 撞 160 的
--   ck_ec_prob_in（试用期必须落在合同期内），整条 UPDATE 回滚。
--   页面上没有任何自救路径，只能手改库。
--
-- ★ 数据没错，错在两处：
--
--   ① **触发器漏了"试用期跟着合同一起结束"。**
--      合同提前终止后，它自己的试用期不可能继续存在 —— 这不是篡改历史：
--      事实就是"这份合同在 6-30 结束了，它的试用期也在 6-30 结束"。
--      所以截断 end_date 时必须同步把 probation_to 收口；
--      若 probation_from 已经晚于新的 end_date，这一对试用期整体置空（成对约束）。
--
--   ② **变更协议不该把试用期抹成 NULL。**
--      163 里我写的是"变更协议不带试用期（同一单位只能约定一次）"——
--      那句话对"续签"成立，对"试用期内转店"是错的：
--      试用期是**劳动关系**上的一段，不是某一份合同独有的。
--      转店之后员工还在试用期内，新合同应当**继承剩余试用期**（到同一个
--      probation_to），而不是"转店即转正"。
--      法定约束没破：总试用期仍是 05-06~08-06 三个月，没有"重新约定一次"。
--
-- ★ 为什么另开一个迁移而不是改 163：
--   163 已经提交并推送，改它会让"同一份迁移在两个提交里内容不同" ——
--   那正是这个仓库一直在防的事（迁移是事实，不是草稿）。
--   与 157 重定义 156 的函数同一个做法：新文件覆盖旧定义，并在文件头写清为什么。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 截断上一份合同时，试用期跟着收口
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_ec_close_prev() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_end date;
BEGIN
  IF NEW.prev_id IS NULL OR NEW.status <> 'signed'
     OR (OLD.status IS NOT DISTINCT FROM 'signed') THEN
    RETURN NEW;
  END IF;

  v_end := NEW.start_date - 1;

  UPDATE public.employment_contract
     SET end_date = v_end,
         -- ★ 试用期不能跨出合同（ck_ec_prob_in）。合同被截断，试用期跟着结束。
         --   ★ 同一个列只能赋值一次（PG 报 "multiple assignments to same column"），
         --   所以"整对置空"和"收口到终止日"必须写在同一个 CASE 里。
         --   SET 里引用的 probation_from 是**旧值**，顺序不影响判定。
         probation_to = CASE
           WHEN probation_from IS NOT NULL AND probation_from > v_end THEN NULL
           WHEN probation_to IS NOT NULL AND probation_to > v_end THEN v_end
           ELSE probation_to END,
         probation_from = CASE
           WHEN probation_from IS NULL THEN NULL
           WHEN probation_from > v_end THEN NULL
           ELSE probation_from END
   WHERE id = NEW.prev_id
     AND (end_date IS NULL OR end_date > v_end
          OR probation_to IS NOT NULL AND probation_to > v_end);

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_ec_close_prev IS
  '变更/续签协议签署后，把上一份合同截到本份起始日前一天 —— 两份不能同时在履行。'
  '★ 169 起同步收口 probation_to：合同提前终止，它自己的试用期不可能继续存在；'
  '不收口的后果是撞 ck_ec_prob_in，整条 UPDATE 回滚，协议永远签不下来。';

-- ---------------------------------------------------------------------------
-- 2. 变更协议继承剩余试用期（不再一律抹成 NULL）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_change_apply(
  p_change bigint,
  p_by     varchar DEFAULT 'system'
) RETURNS TABLE (change_id bigint, contract_id bigint, contract_no varchar, seg_from date)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  g       record;
  c       record;
  v_tpl   bigint;
  v_no    varchar(48);
  v_seq   int;
  v_cid   bigint;
  v_pf    date;
  v_pt    date;
BEGIN
  SELECT * INTO g FROM public.employee_change WHERE id = p_change FOR UPDATE;
  IF g.id IS NULL THEN
    RAISE EXCEPTION 'E_CHG_NOT_FOUND: 异动单 % 不存在', p_change;
  END IF;
  IF g.status = 'applied' THEN
    RAISE EXCEPTION 'E_CHG_APPLIED: 异动单 % 已于 % 生效，不能重复生效', g.code, g.applied_at;
  END IF;

  SELECT * INTO c FROM public.employment_contract c2
   WHERE c2.employee_id = g.employee_id AND c2.status = 'signed'
     AND daterange(c2.start_date, c2.end_date, '[]') @> g.effective_date
   ORDER BY c2.start_date DESC LIMIT 1;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'E_CHG_NO_CONTRACT: 生效日 % 这个人没有已签合同在履行', g.effective_date;
  END IF;

  -- ---- 1. 归属：旧段截断到生效日前一天，新段从生效日开（不改现值）----
  IF g.new_org_id IS NOT NULL AND g.new_org_id IS DISTINCT FROM g.old_org_id THEN
    UPDATE public.employee_org_assignment a
       SET valid_to = g.effective_date - 1
     WHERE a.employee_id = g.employee_id AND a.dim_code = 'cost_org'
       AND a.valid_to IS NULL
       AND a.valid_from < g.effective_date;
    INSERT INTO public.employee_org_assignment
      (employee_id, dim_code, org_id, valid_from)
    VALUES (g.employee_id, 'cost_org', g.new_org_id, g.effective_date);
  END IF;

  -- ---- 2. 试用期：剩余部分跟着人走（见文件头 ②）----
  --   原合同试用期还没走完 → 新合同从生效日起继续到同一个 probation_to。
  --   这不是"再约定一次试用期"：总时长没变，只是被合同变更切成了两段。
  IF c.probation_to IS NOT NULL AND c.probation_to >= g.effective_date THEN
    v_pf := g.effective_date;
    v_pt := c.probation_to;
  ELSE
    v_pf := NULL;
    v_pt := NULL;
  END IF;

  -- ---- 3. 书面变更：生成新合同，prev_id 指向原合同（不改原合同）----
  SELECT t.id INTO v_tpl FROM public.contract_template t
   WHERE t.kind = c.kind AND t.is_active ORDER BY t.version DESC, t.id LIMIT 1;

  SELECT count(*)::int INTO v_seq FROM public.employment_contract c3
   WHERE c3.legal_entity_id = c.legal_entity_id
     AND c3.start_date >= date_trunc('year', g.effective_date);
  v_no := 'BG' || lpad(c.legal_entity_id::text,
                       GREATEST(2, length(c.legal_entity_id::text)), '0') || '-'
          || to_char(g.effective_date, 'YYYY') || '-'
          || lpad((v_seq + 1)::text, 4, '0');

  INSERT INTO public.employment_contract
    (employee_id, legal_entity_id, contract_no, kind, start_date, end_date,
     probation_from, probation_to, job_title, workplace, employee_address,
     hours_system, wage_amount, wage_unit, pay_day, template_id, status, prev_id)
  VALUES (g.employee_id, c.legal_entity_id, v_no, c.kind, g.effective_date, c.end_date,
     v_pf, v_pt,
     COALESCE(g.new_job_title, c.job_title),
     COALESCE(g.new_workplace, c.workplace),
     c.employee_address,
     COALESCE(g.new_hours_system, c.hours_system),
     c.wage_amount, c.wage_unit, c.pay_day, v_tpl, 'draft', c.id)
  RETURNING id INTO v_cid;

  UPDATE public.employee_change
     SET status = 'applied', applied_at = now(), contract_id = v_cid,
         approved_by = COALESCE(approved_by, p_by)
   WHERE id = p_change;

  RETURN QUERY SELECT p_change, v_cid, v_no::varchar, g.effective_date;
END;
$$;

COMMENT ON FUNCTION fn_change_apply IS
  '异动生效（163 起，169 修试用期）：按生效日切归属段、生成变更协议（prev_id 串链、draft）、'
  '原合同在协议**签署时**才截断（不建单即截断）。'
  '★ 169 起：试用期未走完的，新合同继承剩余试用期（到同一个 probation_to）——'
  '163 里一律置 NULL 等于"转店即转正"，而试用期是劳动关系上的一段，不是某份合同独有的。';

-- ---------------------------------------------------------------------------
-- 3. 判据：补一条钉住"试用期内异动"的完整闭环
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.CHG-PROB',
   '试用期内异动：原合同截断时试用期跟着收口、新协议继承剩余试用期（到同一个 probation_to）、'
   '两份合同期间不重叠、总试用期长度不变（不是"重新约定一次"）',
   'ORG','ALGORITHM','fn_ec_close_prev','public','employment_contract','TABLE',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
