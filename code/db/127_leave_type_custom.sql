-- ============================================================================
-- 127_leave_type_custom.sql · 官方假种预置 + 公司自定义假种
-- ----------------------------------------------------------------------------
-- 126 只是把假种**插进去**了，但假种本身还是个"只有名字"的字典：
-- 系统不知道年假带薪、事假不带薪，于是除了事假与病假，其他假种都不参与算钱。
-- 客户加一个"哺乳假"，系统也不知道该扣多少。
--
-- 这一版把假种变成**可配置的计薪对象**：
--
--   is_system   官方预置（7 个），不可删除 —— 删了历史请假单会指向空白
--   pay_ratio   带薪比例：1.0 全额、0 全扣、NULL = 按工龄档位算（病假专用）
--   is_active   停用（不能新增该假种的请假，但历史记录还在）
--   note        说明（界面上写清"这个假怎么算钱"）
--
-- 为什么 pay_ratio 而不是"是否带薪"两种状态：
--   现实里有"半薪病假""80% 工资的工伤假"这类。两态表达不了，而多加一列成本极低。
--
-- 官方预置（默认值，可改但不可删）：
--   年假 100% ｜ 病假 按工龄 ｜ 事假 0% ｜ 婚假 100% ｜ 产假 100% ｜ 丧假 100% ｜ 调休 100%
--
-- ★ 算钱的口径统一到一处：fn_leave_deduction 按假种逐项算，不再只认 PERSONAL/SICK。
--   客户加一个"哺乳假 100%"，它自动就不扣钱，不需要改代码。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 假种加配置列
-- ---------------------------------------------------------------------------
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS is_system  boolean NOT NULL DEFAULT false;
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS pay_ratio  numeric(4,3);
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS is_active  boolean NOT NULL DEFAULT true;
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS note       varchar(200);

ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS ck_lt_ratio;
ALTER TABLE leave_type ADD CONSTRAINT ck_lt_ratio
  CHECK (pay_ratio IS NULL OR (pay_ratio >= 0 AND pay_ratio <= 1));

COMMENT ON COLUMN leave_type.pay_ratio IS
  '带薪比例：1.0=全额、0=全扣、NULL=按工龄档位（病假）。'
  '半薪假（0.5）这类也能表达 —— "是否带薪"两个状态表达不了现实。';
COMMENT ON COLUMN leave_type.is_system IS
  '官方预置假种：不可删除（历史请假单会指向空白），比例可改但要 HR 主管以上。';

-- ---------------------------------------------------------------------------
-- 2. 官方 7 个假种：标 system + 写比例
-- ---------------------------------------------------------------------------
UPDATE leave_type SET is_system = true, note = COALESCE(note, '官方预置') WHERE code IN
  ('ANNUAL','SICK','PERSONAL','MARRIAGE','MATERNITY','BEREAVEMENT','COMP_TIME');

UPDATE leave_type SET pay_ratio = 1.000 WHERE code IN ('ANNUAL','MARRIAGE','MATERNITY','BEREAVEMENT','COMP_TIME');
UPDATE leave_type SET pay_ratio = 0.000 WHERE code = 'PERSONAL';
UPDATE leave_type SET pay_ratio = NULL  WHERE code = 'SICK';   -- 按工龄档位

UPDATE leave_type SET note = '带薪（法定）'                     WHERE code = 'ANNUAL';
UPDATE leave_type SET note = '按连续工龄 60%–100%，且不低于最低工资 80%' WHERE code = 'SICK';
UPDATE leave_type SET note = '无薪（全扣）'                     WHERE code = 'PERSONAL';
UPDATE leave_type SET note = '带薪（法定 3 天，地方可加）'       WHERE code = 'MARRIAGE';
UPDATE leave_type SET note = '带薪；生育津贴由社保支付，工资照发不扣' WHERE code = 'MATERNITY';
UPDATE leave_type SET note = '带薪（法定 1–3 天）'              WHERE code = 'BEREAVEMENT';
UPDATE leave_type SET note = '加班换来的调休，带薪'              WHERE code = 'COMP_TIME';

-- ---------------------------------------------------------------------------
-- 3. 请假扣款：按假种逐项算（不再只认事假与病假）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_leave_deduction(p_employee bigint, p_period varchar)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_basis_total numeric(12,2) := 0;
  v_daily numeric(14,4);
  v_monthly numeric(12,2);
  v_days_policy numeric(6,2);
  t record;
  v_days numeric(6,2);
BEGIN
  -- 按工时计薪：缺勤已体现在工时里，请假不再扣（病假工资另加成加项）
  IF public.fn_pay_basis(p_employee, p_period) = 'hour' THEN
    RETURN 0;
  END IF;

  SELECT s.monthly_amount INTO v_monthly
    FROM public.salary_standard s
    JOIN public.employment e ON e.id = s.employment_id
   WHERE e.person_id = p_employee
     AND s.effective_from <= (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date
   ORDER BY s.effective_from DESC LIMIT 1;
  IF v_monthly IS NULL THEN RETURN 0; END IF;

  v_daily := v_monthly / GREATEST(
    (SELECT COALESCE(value_num, 21.75) FROM public.fn_policy_effective(
       'PAY_DAYS_PER_MONTH', NULL,
       (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date)), 1);

  -- 事假天数优先取 HR 确认过的月报（可以手调），其余假种取请假单汇总
  SELECT COALESCE(r.personal_leave_days,
                  public.fn_leave_approved_days(p_employee, p_period, 'PERSONAL'))
    INTO v_days_policy
    FROM (SELECT 1) dummy
    LEFT JOIN public.att_period_report r
      ON r.period = p_period AND r.person_id = p_employee AND r.status = 'confirmed';

  FOR t IN SELECT code, pay_ratio, is_system FROM public.leave_type WHERE is_active
  LOOP
    IF t.code = 'SICK' THEN
      -- 病假：扣"日薪×天数 − 病假工资"（病假工资按工龄，另有下限）
      v_days := public.fn_leave_approved_days(p_employee, p_period, 'SICK');
      IF v_days > 0 THEN
        v_basis_total := v_basis_total
                       + round(v_daily * v_days, 2)
                       - public.fn_sick_pay(p_employee, p_period);
      END IF;
    ELSIF t.code = 'PERSONAL' THEN
      v_days := COALESCE(v_days_policy, 0);
      v_basis_total := v_basis_total + round(v_daily * v_days * (1 - COALESCE(t.pay_ratio, 0)), 2);
    ELSE
      v_days := public.fn_leave_approved_days(p_employee, p_period, t.code);
      IF v_days > 0 THEN
        v_basis_total := v_basis_total + round(v_daily * v_days * (1 - COALESCE(t.pay_ratio, 0)), 2);
      END IF;
    END IF;
  END LOOP;

  RETURN round(v_basis_total, 2);
END;
$$;

COMMENT ON FUNCTION fn_leave_deduction IS
  '请假扣款（day 模式）= 各假种天数 × 日薪 × (1 − 带薪比例) 之和。'
  '病假例外：扣"日薪−病假工资"（按工龄 60–100%，不低于最低工资 80%）。'
  '★ 客户新增的假种自动参与计算 —— 比例配 1.0 就不扣钱，配 0 就全扣，不需要改代码。'
  'hour 模式返回 0（缺勤已在工时里）。';

-- ---------------------------------------------------------------------------
-- 4. 官方假种的保护：不可删、code 不可改
-- ---------------------------------------------------------------------------
-- 为什么这两条必须写在库里：
--   · 删了官方假种 → 历史请假单指向空白，工资条上"年假 3 天"变成一串 id；
--   · 改 code → 代码里按 'PERSONAL'/'SICK' 算钱的地方全部失配，
--     而失配的表现是"请假不扣钱了"，没人会立刻发现。
CREATE OR REPLACE FUNCTION fn_lt_protect()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_system THEN
    RAISE EXCEPTION 'E_LEAVE_TYPE_SYSTEM: 「%」是官方预置假种，不能删除；'
      '不想用请停用（is_active=false）—— 删了历史请假单会指向空白', OLD.name;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_system AND NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'E_LEAVE_TYPE_SYSTEM: 官方假种的代码不能改（% → %）；'
      '算钱的地方按代码取数，改了会静默失配', OLD.code, NEW.code;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_lt_protect ON leave_type;
CREATE TRIGGER trg_lt_protect BEFORE UPDATE OR DELETE ON leave_type
  FOR EACH ROW EXECUTE FUNCTION fn_lt_protect();

-- ---------------------------------------------------------------------------
-- 5. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.LT','假种：官方 7 个不可删、自定义可加、带薪比例可配且自动参与扣款',
   'ATTENDANCE','ACL','fn_leave_deduction','public','leave_type','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
