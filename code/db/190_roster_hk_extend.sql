-- ============================================================================
-- 190_roster_hk_extend.sql · 花名册再扩：英文名 / job_title / 时薪 / 法定假余额 / 418·468
-- ----------------------------------------------------------------------------
-- 045 的能力盘点把这一条挂在待办上：「花名册再扩：英文名 / job_title /
-- 法定假余额 / 418·468 / 时薪」，并注明「法定假余额与 418/468 不只是加列，
-- 要先定台账口径」。这一版分开处理，**四种字段四种做法**，不图省事写成一样：
--
--   ① 英文名（english_name）—— 纯加列。
--      香港门店的花名册同时有「中文姓名」与「英文全称（Surname + Given Name）」
--      （docs/42 §2.1 的 D 列与 AL 列），排班表、考勤机导出、MPF 表格用的都是英文名。
--      没有这一列时，HR 只能把它塞进 full_name 或备注，而 full_name 一改，
--      历史单据上的名字就跟着变 —— 名字是要对得上证件的东西，不能当自由文本改。
--
--   ② 岗位名称（job_title）—— 加列，但**必须和 position 档案划清界线**。
--      ★ 这是本迁移最容易被下一个人用错的地方：
--        · `person_position` / `position`（017/019 建的那套）是**档案**：
--          有编码、有有效期、能授岗、进编制与档口判定、是外键；
--        · `person.job_title` 是**自由文本**：门店花名册 K 列「职位」原样录进来
--          （docs/42：服務員 / 服務料理員 / 指導員 / 支配人 … 11 个值，且带
--          "AM兼支配人"这种一人两岗的写法）。
--        两者不是一件事：把 job_title 当外键用，会在"门店写了个词表里没有的
--        写法"那天直接插不进去；把 position 当自由文本用，编制与档口就判不出来。
--        所以 job_title 上**不加任何外键、不做枚举校验**（词表由门店自己演化）。
--
--   ③ 时薪（employment.hourly_rate）—— 加列，但**只用于展示与非全日制场景**。
--      ★ 算薪仍然走 salary_standard（009/087 那套），这里一个字节都不改。
--        同一个人的工资若有两个来源（salary_standard 与 hourly_rate），
--        迟早会出现"花名册显示 78，工资条按时薪 85 算"，而两张表各自都自洽。
--        月薪人员的 hourly_rate 是 **NULL，不是 0** —— 0 会在页面上显示成
--        "时薪 0 元"，而它真实的含义是"这个人不计时薪"。
--
--   ④ 法定假余额 —— **不加列，复用已有台账**。
--      仓库里早就有完整的假期台账：leave_type / leave_grant / leave_usage /
--      leave_cashout + 四态视图 v_leave_balance（011 建、057 与 129 重建）。
--      再建一张 leave_balance 表就是第二套余额口径，两套一漂，症状是
--      "某人法定假少了半天"，而三张表看起来都正常（011 文件头已经写过这条）。
--      所以本迁移只做两件事：**补一个法定假假种** + 提供一个按日期取余额的函数，
--      花名册直接 join 出来。
--      ★ 为什么另写 fn_leave_available_at 而不直接用 v_leave_balance：
--        那个视图里用的是 current_date（011 起的实现），而花名册是 as_of 查询。
--        视图不带参数，只能另出一个 as-of 版本；**口径必须与视图逐项一致**
--        （granted / frozen / used / forfeited / cashed 五项，见 129 的视图定义），
--        改一处就要改另一处 —— 测试里有一条"函数结果 == 视图结果"的断言钉住它。
--      ★ 算不出来（这个人从来没被授予过该假种）→ 返回 NULL，**不返回 0**。
--        "余额 0 天"和"没维护过额度"在页面上必须长得不一样：
--        前者是权利已用完，后者是台账还没建 —— 处理方式完全不同。
--
--   ⑤ 418 / 468 —— **不实现，不发明公式**。
--      docs/42 §六.2 的原话：门店表 AU 列名是「法定假日（全職、**468 滿足人員**）」，
--      批注里写「2026.3.2 开始满足468」；但「本包只见『468』，未见『418』」。
--      docs/44 的核对表也写明：468「**仅出现列名**，全表无 468/418 计算式 →
--      判定逻辑未能确定（靠人工判断）」、418「未出现 → 未能确定」。
--      即：客户资料里只有结论、没有判定过程。连续 4 周每周 ≥18 小时是通行理解，
--      但"哪 4 周、以什么时点起算、跨月怎么切、休息日算不算工时"全都没有依据。
--      写一个看起来对的公式，会让"某人不满足 468"从一句人工判断变成一个
--      没人能复核的红色标记 —— 那比空着更危险。
--      所以：花名册给一列 continuous_employment，**恒为 NULL**，含义是"未判定"，
--      并在这里写死：等 HR 确认口径（四个问题：起算点 / 周切分 / 工时口径 / 离职段）
--      之后再实现。**不要**在服务层用任何别的字段拼一个近似值填进这一列。
--
-- ★ 幂等：ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS / CREATE TABLE IF NOT EXISTS
--   / DROP FUNCTION + CREATE FUNCTION（返回类型变了，161 踩过这个坑）。
--   不动 001–186 的任何字节。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 英文名 / 岗位名称（自由文本，不是 position 档案）
-- ---------------------------------------------------------------------------
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS english_name varchar(64);
ALTER TABLE public.person ADD COLUMN IF NOT EXISTS job_title    varchar(64);

COMMENT ON COLUMN public.person.english_name IS
  '英文名（190）。香港门店的排班表 / 考勤机导出 / MPF 表格用英文名，中文名对不上。'
  '★ 与 full_name 分开存：名字要对得上证件，不能当自由文本覆盖 —— '
  '把英文名塞进 full_name，改一次名字，历史单据上的名字就跟着变。';

COMMENT ON COLUMN public.person.job_title IS
  '岗位名称的**自由文本**（190）：门店花名册「职位」列原样录入（如 服務員 / 指導員 / '
  '「AM兼支配人」）。'
  '★★ 与 position 档案**不是一回事**，不可互相当外键/词表用：'
  'person_position + position（017/019）有编码、有效期、可授岗、进编制与档口判定；'
  '这一列只是"他名片上印的岗位"。'
  '所以这里**不加外键、不做枚举校验** —— 门店写了一个词表里没有的写法时，'
  '整条花名册导入不该因此失败。';

-- ---------------------------------------------------------------------------
-- 2. 时薪（只用于展示与非全日制场景，不改算薪）
-- ---------------------------------------------------------------------------
ALTER TABLE public.employment ADD COLUMN IF NOT EXISTS hourly_rate numeric(10,2);

ALTER TABLE public.employment DROP CONSTRAINT IF EXISTS ck_emp_hourly_rate;
ALTER TABLE public.employment ADD CONSTRAINT ck_emp_hourly_rate
  CHECK (hourly_rate IS NULL OR hourly_rate >= 0);

COMMENT ON COLUMN public.employment.hourly_rate IS
  '时薪（190）。**可空**：月薪人员为 NULL，不是 0（0 会在页面上读成"时薪 0 元"）。'
  '★★ 只用于展示与"非全日制"场景，**不改算薪**：算薪仍走 salary_standard（009/087）。'
  '同一个人的工资若有两个来源（salary_standard 与 hourly_rate），迟早会出现'
  '"花名册显示 78、工资条按时薪 85 算"，而两张表各自都自洽 —— 那种错没有人会报。';

-- ---------------------------------------------------------------------------
-- 3. 法定假假种（香港）：台账复用 leave_grant / leave_usage，不建新表
-- ---------------------------------------------------------------------------
-- ★ leave_type.id 不是 identity（126 踩过）：逐条取 max(id)+1 插入。
--   为什么这一条要在这里加：香港门店的「法定假日」既不是年假（ANNUAL，按工龄
--   阶梯发放、可折现），也不是调休（COMP_TIME）。挂在 ANNUAL 上会让
--   年假余额与法定假余额互相吃掉 —— 而它们在香港是两项独立的法定权利。
DO $$
DECLARE v_id bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.leave_type WHERE code = 'STATUTORY_HOLIDAY') THEN
    SELECT COALESCE(max(id), 0) + 1 INTO v_id FROM public.leave_type;
    INSERT INTO public.leave_type(id, code, name, expire_policy, pay_ratio, is_active, note)
    VALUES (v_id, 'STATUTORY_HOLIDAY', '法定假日（香港）', 'void', 1.000, true,
            '香港《雇佣条例》法定假日。带薪；天数随法例调整，由 HR 在额度台账里维护，不写死。');
  END IF;
END $$;

COMMENT ON TABLE public.leave_type IS
  '假种字典。190 起含 STATUTORY_HOLIDAY（香港法定假日）—— 与 ANNUAL 分开：'
  '香港的法定假日与有薪年假是两项独立权利，挂在一个假种上会互相吃掉余额。';

-- ---------------------------------------------------------------------------
-- 4. 按日期取余额（v_leave_balance 的 as-of 版本，口径逐项对齐 129 的视图）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_leave_available_at(
  p_employee bigint,
  p_type     bigint,
  p_on       date
) RETURNS numeric
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH g AS (
    SELECT SUM(qty) FILTER (WHERE valid_to IS NULL OR valid_to >= p_on) AS granted,
           count(*)                                                     AS grants
      FROM public.leave_grant
     WHERE employee_id = p_employee AND leave_type_id = p_type
  ), u AS (
    SELECT SUM(qty) FILTER (WHERE state = 'frozen')    AS frozen,
           SUM(qty) FILTER (WHERE state = 'used')      AS used,
           SUM(qty) FILTER (WHERE state = 'forfeited') AS forfeited
      FROM public.leave_usage
     WHERE employee_id = p_employee AND leave_type_id = p_type
  ), c AS (
    -- 折现按"结算月"落在 p_on 之前的那些单扣减：leave_cashout 没有生效日，
    -- settle_period 是它唯一能对齐到时间轴上的字段。
    SELECT SUM(days) AS cashed
      FROM public.leave_cashout
     WHERE employee_id = p_employee AND leave_type_id = p_type
       AND status <> 'void'
       AND settle_period <= to_char(p_on, 'YYYY-MM')
  )
  SELECT CASE
           -- ★ 从没授予过 → NULL（"没维护过额度"），不是 0（"权利已用完"）
           WHEN COALESCE(g.grants, 0) = 0 THEN NULL
           ELSE COALESCE(g.granted, 0)
                - COALESCE(u.frozen, 0) - COALESCE(u.used, 0)
                - COALESCE(u.forfeited, 0) - COALESCE(c.cashed, 0)
         END
    FROM g, u, c;
$$;

COMMENT ON FUNCTION fn_leave_available_at IS
  '某个假种在 p_on 那天的可用余额（190）。与 v_leave_balance 逐项同口径'
  '（granted − frozen − used − forfeited − cashed），区别只有两点：'
  '① 带 p_on（视图绑的是 current_date，花名册要能复现上个月的余额）；'
  '② 没有任何授予记录时返回 **NULL**，不是 0 —— "没维护过额度"与"已用完"'
  '   在页面上必须长得不一样，处理方式也不同。'
  '★ 改这里的口径必须同步改 v_leave_balance（129 的版本），反之亦然。';

-- ---------------------------------------------------------------------------
-- 5. 花名册扩列（返回类型变了 → DROP 再建，161 的套路）
-- ---------------------------------------------------------------------------
-- ★ 原有列**一个都不改名、不改顺序**，新列一律追加在最后：
--   下游（people.mjs / leave-board / 报表）按名取值，但改顺序会让
--   `SELECT *` 的位置取值在某些脚本里静默错列。
DROP FUNCTION IF EXISTS fn_emp_roster(date);

CREATE FUNCTION fn_emp_roster(p_as_of date)
RETURNS TABLE (
  -- ---- 原有 9 列（061）----
  employee_id   bigint,
  employee_no   varchar,
  full_name     varchar,
  org_id        bigint,
  org_name      varchar,
  hire_date     date,
  leave_date    date,
  leaving_soon  boolean,
  national_id   varchar,
  -- ---- 061 之后追加（161）----
  mobile        varchar,
  birth_date    date,
  gender        varchar,
  contract_id   bigint,
  contract_no   varchar,
  contract_kind varchar,
  contract_start date,
  contract_end  date,
  probation_status varchar,
  probation_to  date,
  employment_kind varchar,
  emergency_name  varchar,
  emergency_phone varchar,
  emergency_relation varchar,
  -- ---- 190 追加 ----
  english_name  varchar,
  job_title     varchar,
  hourly_rate   numeric,        -- NULL = 月薪人员 / 未录，不是 0
  -- 法定假日（香港）与年假的余额：按 p_as_of 从台账取，NULL = 没维护过
  stat_holiday_available numeric,
  annual_leave_available numeric,
  -- ★ 418/468 连续雇佣判定：**本仓未实现**，恒为 NULL = "未判定"。
  --   NULL 不代表"不满足"；判定口径见文件头 ⑤，等 HR 确认后在这里实现。
  continuous_employment varchar
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, n.no, p.full_name, a.org_id, o.name,
         e.hire_date, e.leave_date,
         (e.leave_date IS NOT NULL AND e.leave_date > p_as_of) AS leaving_soon,
         pf.profile_value::varchar,
         mb.profile_value::varchar AS mobile,
         COALESCE(public.fn_id_birth(pf.profile_value), ex.birth_date) AS birth_date,
         COALESCE(public.fn_id_gender(pf.profile_value), ex.gender)::varchar AS gender,
         c.id, c.contract_no::varchar, c.kind::varchar, c.start_date, c.end_date,
         (CASE
           WHEN c.id IS NULL THEN 'none'
           WHEN c.probation_from IS NOT NULL
                AND c.probation_from <= p_as_of
                AND c.probation_to   >= p_as_of THEN 'probation'
           ELSE 'regular'
         END)::varchar AS probation_status,
         c.probation_to,
         c.kind::varchar AS employment_kind,
         ex.emergency_name::varchar, ex.emergency_phone::varchar,
         ex.emergency_relation::varchar,
         -- ---- 190 ----
         p.english_name::varchar,
         p.job_title::varchar,
         e.hourly_rate,
         -- ★ 余额用 as_of 取（不是 current_date）：这是本函数唯一能复现历史的原因。
         --   假种 id 走 fn_leave_type_id（126 踩过"写死数字，重灌库后指向别的假种"）。
         public.fn_leave_available_at(
           p.id, public.fn_leave_type_id('STATUTORY_HOLIDAY'), p_as_of),
         public.fn_leave_available_at(
           p.id, public.fn_leave_type_id('ANNUAL'), p_as_of),
         -- 418/468：未实现，恒 NULL（见文件头 ⑤）。**不要**在这里拼近似值。
         NULL::varchar
    FROM public.person p
    JOIN public.employment e ON e.person_id = p.id
    -- ★★ 四处 LATERAL + LIMIT 1 全部保留：**花名册一个人只能一行**。
    --   190 新增的两个余额走标量函数（每人每假种一行结果），不会复制人；
    --   证照 / MPF 刻意**不 join 进花名册**（一个人多本证照就会翻行，
    --   而"员工总数"是各报表的分母）。要证照到期清单用 fn_documents_expiring。
    JOIN LATERAL (
      SELECT a.org_id
        FROM public.employee_org_assignment a
       WHERE a.employee_id = p.id AND a.dim_code = 'cost_org'
         AND daterange(a.valid_from, a.valid_to, '[]') @> p_as_of
       ORDER BY a.valid_from DESC, a.org_id
       LIMIT 1
    ) a ON true
    JOIN public.org_unit o ON o.id = a.org_id
    LEFT JOIN LATERAL (
      SELECT n.no FROM public.employee_no n
       WHERE n.assigned_person_id = p.id AND n.retired_at IS NULL
       ORDER BY n.assigned_at DESC, n.no DESC LIMIT 1
    ) n ON true
    LEFT JOIN LATERAL (
      SELECT pf.profile_value FROM public.person_profile pf
       WHERE pf.person_id = p.id AND pf.profile_type = 'national_id'
       ORDER BY (pf.verified_by IS NOT NULL) DESC, pf.id DESC LIMIT 1
    ) pf ON true
    LEFT JOIN LATERAL (
      SELECT mb.profile_value FROM public.person_profile mb
       WHERE mb.person_id = p.id AND mb.profile_type = 'mobile'
       ORDER BY (mb.verified_by IS NOT NULL) DESC, mb.id DESC LIMIT 1
    ) mb ON true
    LEFT JOIN public.employee_extra ex ON ex.employee_id = p.id
    LEFT JOIN LATERAL (
      SELECT c2.id, c2.contract_no, c2.kind, c2.start_date, c2.end_date,
             c2.probation_from, c2.probation_to
        FROM public.employment_contract c2
       WHERE c2.employee_id = p.id
         AND c2.status = 'signed'
         AND daterange(c2.start_date, c2.end_date, '[]') @> p_as_of
       ORDER BY c2.start_date DESC, c2.id DESC
       LIMIT 1
    ) c ON true
   WHERE daterange(e.hire_date, e.leave_date, '[]') @> p_as_of
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                  WHERE s.dim_code = 'cost_org' AND s.org_id = a.org_id)
     AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                      WHERE d.dim_code = 'cost_org' AND d.org_id = a.org_id)
   ORDER BY o.path, p.id;
END;
$$;

COMMENT ON FUNCTION fn_emp_roster IS
  '员工花名册（按 cost_org 行闸）。在离职按 p_as_of 判，不用"当前"。'
  '工号取当前有效那一个；没有就是 NULL（不编"待分配"）。'
  '161：手机、生日/性别（身份证派生优先）、合同四列、试用期状态、用工类型、紧急联系人。'
  '190：english_name / job_title（自由文本，非 position 档案）/ hourly_rate'
  '（NULL=月薪，不是 0）/ 法定假日与年假余额（按 p_as_of 从台账取，'
  'NULL=没维护过额度）/ continuous_employment（**418·468 未实现，恒 NULL=未判定**）。'
  '★★ 证照与 MPF 刻意不进本函数：一个人多本证照会把行数放大，'
  '而员工总数是各报表的分母。到期清单用 fn_documents_expiring。';

-- ---------------------------------------------------------------------------
-- 6. 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RSE2',
   '花名册再扩（190）：job_title 是自由文本不是 position 外键；hourly_rate 为空返回 '
   'NULL 不是 0；法定假/年假余额按 as_of 从既有台账取；418·468 未实现恒为 NULL；'
   '加列后花名册行数不变',
   'ORG','ALGORITHM','fn_emp_roster','public','leave_grant','FUNCTION',
   'team-lead','2027-06-30','node test/extra2.mjs','node test/extra2.mjs'),
  ('SUITE.RSE2-418',
   '418/468 连续雇佣判定未实现（docs/42、docs/44 只有列名、无计算式）：'
   'continuous_employment 恒为 NULL = 未判定，待 HR 确认口径',
   'ORG','DATA_QUALITY','fn_emp_roster','public','person','FUNCTION',
   'team-lead','2027-03-31','node test/extra2.mjs','node test/extra2.mjs')
ON CONFLICT (check_code) DO NOTHING;
