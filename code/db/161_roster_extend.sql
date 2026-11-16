-- ============================================================================
-- 161_roster_extend.sql · 花名册扩列：把"合同"和"档案补充"接进名单
-- ----------------------------------------------------------------------------
-- 061 的花名册只出 9 列（工号/姓名/门店/入职/离职/将离职/身份证）。拿去对一份
-- 真实门店花名册，缺的不是"锦上添花"的字段，是几件**每天都要用**的事：
--
--   · **他签的合同到哪天**（续签提醒、解除时算 N）；
--   · **在不在试用期**（试用期解除与转正后解除，程序与补偿完全不同）；
--   · **手机号**（排班、催考勤、发工资条都要；现在名单上没有）；
--   · **紧急联系人**（门店出事第一时间要打的电话）；
--   · **出生日期/性别**（办社保、公积金、体检、妇女节福利都要）。
--
-- ★ 三条设计取舍：
--
--   ① **合同类字段是"派生"的，不冗余存一份。**
--      花名册的合同起止、试用期状态全部实时从 employment_contract 读 ——
--      签了新合同、续了签、终止了，名单上立刻变。存一份副本的话，
--      它和合同表不同步的那天，名单上会出现一个"已过期但显示在职"的人。
--
--   ② **档案补充单独一张表（employee_extra），不塞进 person。**
--      person 是"人携带的身份事实"（姓名/身份证/手机），换一个雇主仍然存在；
--      紧急联系人、学历、婚姻状况是**雇主要求填的档案**，换雇主就作废。
--      007 的那条判据（"换一个雇主之后它还在不在"）在这里正好用上。
--
--   ③ **出生日期/性别不落库，从身份证派生**（fn_id_birth / fn_id_gender）。
--      存一份再从身份证改一次，就有两个日期会打架；而办社保时用哪个都能被退回。
--      证件不是身份证（护照/港澳台通行证）时派生为 NULL —— 那时让人手填，
--      手填的值进 employee_extra.birth_date（派生优先，缺失才用手填）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 档案补充：一人一行
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_extra (
  employee_id       bigint PRIMARY KEY,           -- person.id
  -- 身份证派生不出来时才用（外籍/护照/通行证），派生优先
  birth_date        date,
  gender            varchar(8),
  education         varchar(16),
  marital_status    varchar(16),
  residence         varchar(200),                 -- 居住地址（合同送达地址另存合同上）
  emergency_name    varchar(64),
  emergency_phone   varchar(32),
  emergency_relation varchar(16),
  note              varchar(200),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_ex_gender CHECK (gender IS NULL OR gender IN ('男','女','其他')),
  CONSTRAINT ck_ex_relation CHECK (emergency_relation IS NULL OR length(btrim(emergency_relation)) > 0)
);

COMMENT ON TABLE public.employee_extra IS
  '档案补充（161）：紧急联系人、学历、婚姻状况、居住地址、派生不出的出生日期/性别。'
  '一人一行。★ 与 person_profile 分开：那边是"人携带的身份事实"（换雇主还在），'
  '这边是"雇主要求填的档案"（换雇主作废）。';
COMMENT ON COLUMN public.employee_extra.emergency_phone IS
  '紧急联系电话。★ 不做格式校验：境内外号码长度差异很大，而"因为格式校验填不进去"'
  '会让这个字段在真实数据里普遍为空 —— 那比格式乱更糟。';

-- ---------------------------------------------------------------------------
-- 2. 从身份证派生出生日期与性别（GB 11643，18 位）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_id_birth(p_id varchar)
RETURNS date
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE v varchar;
BEGIN
  v := upper(btrim(COALESCE(p_id, '')));
  -- 15 位老号：YYMMDD 在 7-12，年份按 19xx 补
  IF v ~ '^[0-9]{15}$' THEN
    RETURN to_date('19' || substring(v from 7 for 6), 'YYYYMMDD');
  END IF;
  -- 18 位：7-14 是 YYYYMMDD
  IF v ~ '^[0-9]{17}[0-9X]$' THEN
    BEGIN
      RETURN to_date(substring(v from 7 for 8), 'YYYYMMDD');
    EXCEPTION WHEN others THEN
      RETURN NULL;                 -- 号码里的日期本身非法（如 20260231）
    END;
  END IF;
  RETURN NULL;                     -- 护照/通行证/空：派生不出来，交给手填
END;
$$;

COMMENT ON FUNCTION fn_id_birth IS
  '从身份证号派生出生日期（18 位取 7-14，15 位老号补 19 前缀）。'
  '非法日期或非身份证 → NULL，**不猜** —— 猜出来的生日会一路进社保申报。';

CREATE OR REPLACE FUNCTION public.fn_id_gender(p_id varchar)
RETURNS varchar
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE v varchar; d int;
BEGIN
  v := upper(btrim(COALESCE(p_id, '')));
  IF v ~ '^[0-9]{17}[0-9X]$' THEN
    d := substring(v from 17 for 1)::int;      -- 第 17 位：奇男偶女
    RETURN CASE WHEN d % 2 = 1 THEN '男' ELSE '女' END;
  END IF;
  IF v ~ '^[0-9]{15}$' THEN
    d := substring(v from 15 for 1)::int;
    RETURN CASE WHEN d % 2 = 1 THEN '男' ELSE '女' END;
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION fn_id_gender IS
  '从身份证号派生性别（第 17 位奇男偶女；15 位老号取第 15 位）。非身份证 → NULL。';

-- ---------------------------------------------------------------------------
-- 3. 花名册扩列（返回类型变了 → 必须先 DROP，061 踩过这个坑）
-- ---------------------------------------------------------------------------
-- ★ 原有 9 列**一个都不改名、不改顺序**：下游（leave-board / people / 报表）
--   都是按名取的，但改顺序会让 `SELECT *` 的位置取值在某些脚本里静默错列。
--   新列一律追加在后面。
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
  -- ---- 061 之后追加 ----
  mobile        varchar,     -- 手机号（未脱敏；脱敏在服务层，见 people.mjs）
  birth_date    date,        -- 派生优先，派生不出才用手填
  gender        varchar,
  -- 合同：全部实时从 employment_contract 读（见文件头 ①）
  contract_id   bigint,
  contract_no   varchar,
  contract_kind varchar,
  contract_start date,
  contract_end  date,
  -- probation=试用期内 / regular=已转正 / none=没有生效合同
  probation_status varchar,
  probation_to  date,
  -- 用工类型：以合同为准，没有合同才是 NULL（不拿"在职"冒充"全职"）
  employment_kind varchar,
  -- 档案补充
  emergency_name  varchar,
  emergency_phone varchar,
  emergency_relation varchar
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, n.no, p.full_name, a.org_id, o.name,
         e.hire_date, e.leave_date,
         (e.leave_date IS NOT NULL AND e.leave_date > p_as_of) AS leaving_soon,
         -- ★ 每一列都显式 ::varchar：CASE / COALESCE 的结果类型是 text，
         --   与 RETURNS TABLE 里声明的 varchar 不匹配时，报错是
         --   "structure of query does not match function result type" ——
         --   它不告诉你是哪一列，只能一列一列试。
         pf.profile_value::varchar,
         mb.profile_value::varchar AS mobile,
         -- 派生优先、手填兜底：身份证能派生的就用手填的会打架
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
         ex.emergency_relation::varchar
    FROM public.person p
    JOIN public.employment e ON e.person_id = p.id
    -- ★★ 四处都改成 LATERAL + LIMIT 1：**花名册一个人只能一行**。
    --   用普通 LEFT JOIN 的话，任一处有多条匹配就复制人 —— 实测踩到过：
    --   一个人有两个身份证档案 + 两条成本组织归属 → 名单上出现 4 行，
    --   而"员工总数"这个数是要报出去的（也出现在各报表的分母里）。
    --   重复行不会报错，只会让所有计数悄悄偏大。
    JOIN LATERAL (
      SELECT a.org_id
        FROM public.employee_org_assignment a
       WHERE a.employee_id = p.id AND a.dim_code = 'cost_org'
         AND daterange(a.valid_from, a.valid_to, '[]') @> p_as_of
       -- 多条归属（跨店兼任）时取**最近生效**的那一条：
       -- 不复制人，也不猜"主店"（猜错了工资会算到另一家店的成本上）
       ORDER BY a.valid_from DESC, a.org_id
       LIMIT 1
    ) a ON true
    JOIN public.org_unit o ON o.id = a.org_id
    -- 工号取**当前有效**的那一个（retired_at IS NULL）。没有就 NULL：
    -- 编一个"待分配"塞进去，会让"有工号"与"没工号"在名单上同形。
    LEFT JOIN LATERAL (
      SELECT n.no FROM public.employee_no n
       WHERE n.assigned_person_id = p.id AND n.retired_at IS NULL
       ORDER BY n.assigned_at DESC, n.no DESC LIMIT 1
    ) n ON true
    -- 身份证/手机：多条档案时**取已核实的**优先，其次取最新的那条
    --   （未核实号码允许重复，见 007：两个人填错同一个号比一人两档更常见）
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
    -- 现行合同：已签 + p_as_of 落在起止内。一人可能在同一天有两份（续签重叠），
    -- 取**起始日最晚**的那一份 —— 那是"现在这份"。
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
  '员工花名册（按 cost_org 行闸）。在离职按 p_as_of 判，不用"当前" —— '
  '同一个查询在跨月那天会给出另一个答案，而报表口径必须能复现。'
  '工号取当前有效那一个；没有就是 NULL（不编"待分配"）。'
  '161 起追加：手机、出生日期/性别（身份证派生优先）、现行合同四列、'
  '试用期状态（probation/regular/none）、用工类型、紧急联系人。'
  '★ 合同类字段是**实时派生**的，不冗余存 —— 存副本会与合同表不同步，'
  '名单上就会出现"合同已过期但显示在职"的人。';

-- ---------------------------------------------------------------------------
-- 4. 档案补充的写入（一人一行，upsert）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_extra_set(
  p_employee bigint,
  p_fields   jsonb,
  p_by       varchar DEFAULT 'system'
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_employee IS NULL OR p_employee <= 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: employee 必须是正整数（person.id）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.person p WHERE p.id = p_employee) THEN
    RAISE EXCEPTION 'E_PERSON_NOT_FOUND: 人 % 不存在', p_employee;
  END IF;

  INSERT INTO public.employee_extra AS x
    (employee_id, birth_date, gender, education, marital_status, residence,
     emergency_name, emergency_phone, emergency_relation, note, updated_at)
  VALUES (
    p_employee,
    NULLIF(p_fields->>'birth_date', '')::date,
    NULLIF(btrim(COALESCE(p_fields->>'gender', '')), ''),
    NULLIF(btrim(COALESCE(p_fields->>'education', '')), ''),
    NULLIF(btrim(COALESCE(p_fields->>'marital_status', '')), ''),
    NULLIF(btrim(COALESCE(p_fields->>'residence', '')), ''),
    NULLIF(btrim(COALESCE(p_fields->>'emergency_name', '')), ''),
    NULLIF(btrim(COALESCE(p_fields->>'emergency_phone', '')), ''),
    NULLIF(btrim(COALESCE(p_fields->>'emergency_relation', '')), ''),
    NULLIF(btrim(COALESCE(p_fields->>'note', '')), ''),
    now())
  ON CONFLICT (employee_id) DO UPDATE SET
    -- ★ 只改"这次给了的字段"：整行覆盖会让"只更新紧急联系人"把学历清空，
    --   而清空不会报错 —— 那是档案里最难查的一类丢数据。
    birth_date       = COALESCE(EXCLUDED.birth_date, x.birth_date),
    gender           = COALESCE(EXCLUDED.gender, x.gender),
    education        = COALESCE(EXCLUDED.education, x.education),
    marital_status   = COALESCE(EXCLUDED.marital_status, x.marital_status),
    residence        = COALESCE(EXCLUDED.residence, x.residence),
    emergency_name   = COALESCE(EXCLUDED.emergency_name, x.emergency_name),
    emergency_phone  = COALESCE(EXCLUDED.emergency_phone, x.emergency_phone),
    emergency_relation = COALESCE(EXCLUDED.emergency_relation, x.emergency_relation),
    note             = COALESCE(EXCLUDED.note, x.note),
    updated_at       = now();
END;
$$;

COMMENT ON FUNCTION fn_extra_set IS
  '写档案补充（161）：一人一行 upsert。**只更新这次给了的字段** —— '
  '整行覆盖会让"只改紧急联系人"顺手把学历清空，而清空不报错。';

-- ---------------------------------------------------------------------------
-- 5. 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RSE',
   '花名册扩列：合同起止与试用期状态实时派生（不冗余存）、没合同的人显示 none 而'
   '不冒充全职、身份证派生生日性别且派生不出时为 NULL、档案补充只改给了的字段',
   'ORG','ALGORITHM','fn_emp_roster','public','employment_contract','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-RSE',
   '花名册接口带上合同与档案补充：分页列表里能读到合同到期与试用期状态',
   'ORG','ACL','fn_emp_roster','public','employee_extra','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
