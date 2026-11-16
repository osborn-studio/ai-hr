-- ============================================================================
-- 173_change_employment_kind.sql · 异动单记下"用工类型从什么变成什么"
-- ----------------------------------------------------------------------------
-- 163 允许 kind='employment_type'（转换用工类型），但 employee_change 只有
-- 岗位 / 工作地点 / 归属 / 工时制度四组新旧列 —— **没有用工类型的新旧列**，
-- ck_ecg_has_change 也不把它算作"一次变更"。
--
-- 后果不是报错，是**记不下来**：发起一次"转用工类型"的异动，变更协议上写不出
-- "从全职改成兼职"，而这是事后最要紧的一句话。用工类型决定工时上限、加班基数、
-- 社保口径与解雇保护；争议发生时，"双方协商一致变更过用工类型"只能靠那纸协议证明。
-- 系统里"改一下"和"书面变更"是两件事（163 文件头 ①/③），而这一种变更
-- 连第一件都做不到 —— 字段根本不存在。
--
-- ★ 三条取舍：
--
--   ① **新旧各一列，不塞进 jsonb。**
--      "今年有多少人从全职转兼职"是一道常见的合规问询，要能用一条 SQL 答出来；
--      塞进 jsonb 之后，每个问的人都要自己写一遍 ->> 和类型转换。
--
--   ② **取值域与 employment_contract.kind 完全一致**（160 的 ck_ec_kind）：
--      fixed / open / task / parttime / intern。
--      ★ 用工类型**不是只有"全职/兼职"两个值** —— 把它写成
--      `IN ('fulltime','parttime')` 会让"固定期限 → 无固定期限"、
--      "实习 → 固定期限"这些**合法转换**被 CHECK 挡住，而报错信息只会说
--      "违反 check 约束"，看的人会去怀疑数据，不会想到是约束写窄了。
--
--   ③ **真正的修法不止加列**：只有列而没有写入路径，等于修了一半 ——
--      列永远是 NULL，协议上仍然写不出来。所以这里同时重定义
--      fn_change_open（把新旧值记下来）与 fn_change_apply（把变更后的用工类型
--      落到变更协议的 kind 上）。
--      协议正文里的"合同类型"一行取自 c.kind（160 的 fn_contract_render），
--      所以新合同的 kind 变了，纸上就写得出来 —— 不需要改模板。
--
-- ★ 协议正文目前**只通过「合同类型」一行**体现这次变更（固定期限 → 非全日制）。
--   若客户要求正文里再写一句"自 X 日起用工类型由 A 变更为 B"，那是给 160 的
--   CN-AMEND-01 出新版本模板（模板是排版决定，不是数据决定）——
--   **不要**以为这里漏了。本文件不碰模板。
--
-- ★ 为什么另开一个迁移而不是改 163：
--   迁移是事实，不是草稿（169 文件头同一条）。改已应用的迁移会让
--   schema_migration 里的 sha256 与文件对不上（tools/migrate.mjs 会报"文件已变更"），
--   而"库里是哪个版本"从此没人答得出。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 新旧两列
-- ---------------------------------------------------------------------------
-- ★ IF NOT EXISTS：这个仓的规矩是"从空库到全绿一次建起"，任何一条迁移都要能
--   在一个已经跑过一半的库上重跑而不炸。
ALTER TABLE public.employee_change
  ADD COLUMN IF NOT EXISTS employment_kind_from varchar(16),
  ADD COLUMN IF NOT EXISTS employment_kind_to   varchar(16);

COMMENT ON COLUMN public.employee_change.employment_kind_from IS
  '变更前的用工类型（取自生效日当天在履行的 employment_contract.kind）。'
  '★ 空值有含义：NULL = 这次异动没动用工类型，不是"原来不知道"。';
COMMENT ON COLUMN public.employee_change.employment_kind_to IS
  '变更后的用工类型，写入变更协议的 kind —— 协议正文的"合同类型"一行读的就是它。'
  '★ 取值域与 employment_contract.kind 一致（fixed/open/task/parttime/intern），'
  '不许写窄成"全职/兼职"两个值：那会让合法的类型转换被约束挡住。';

-- ---------------------------------------------------------------------------
-- 2. 取值域约束（与 160 的 ck_ec_kind 同域）
-- ---------------------------------------------------------------------------
-- ★ 写成 DO 块 + IF NOT EXISTS 而不是直接 ADD CONSTRAINT：
--   直接 ADD 在重跑时会报 42710（constraint already exists），
--   而"重跑报错"会让下一个人以为迁移写错了。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_ecg_ek_from'
       AND conrelid = 'public.employee_change'::regclass
  ) THEN
    ALTER TABLE public.employee_change
      ADD CONSTRAINT ck_ecg_ek_from CHECK (
        employment_kind_from IS NULL
        OR employment_kind_from IN ('fixed','open','task','parttime','intern'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_ecg_ek_to'
       AND conrelid = 'public.employee_change'::regclass
  ) THEN
    ALTER TABLE public.employee_change
      ADD CONSTRAINT ck_ecg_ek_to CHECK (
        employment_kind_to IS NULL
        OR employment_kind_to IN ('fixed','open','task','parttime','intern'));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. "至少动了一样东西"要把用工类型也算进来
-- ---------------------------------------------------------------------------
-- ★ 这条判据的用途是"不许开一张没有内容的单据"，所以新增的字段必须一起进条件：
--   否则一次纯粹的"转用工类型"会被自己的完整性约束挡住 ——
--   而那个错（23514）看起来像"数据传错了"，真因是判据没跟上字段。
-- ★ 用 DROP + ADD 而不是 IF NOT EXISTS：约束的定义变窄/变宽**只能**重建，
--   没有 ALTER CONSTRAINT 可走。DROP IF EXISTS 保证重跑幂等。
ALTER TABLE public.employee_change DROP CONSTRAINT IF EXISTS ck_ecg_has_change;
ALTER TABLE public.employee_change ADD CONSTRAINT ck_ecg_has_change CHECK (
     old_job_title IS DISTINCT FROM new_job_title
  OR old_workplace IS DISTINCT FROM new_workplace
  OR old_org_id    IS DISTINCT FROM new_org_id
  OR old_hours_system IS DISTINCT FROM new_hours_system
  OR employment_kind_from IS DISTINCT FROM employment_kind_to);

-- ---------------------------------------------------------------------------
-- 4. 开单：把新旧用工类型记下来（重定义 163 的 fn_change_open）
-- ---------------------------------------------------------------------------
-- ★ 只加了两个 CASE 表达式，其余逐字照 163：
--   旧值从**当前在履行的合同**里取（不让人手填，手填就会填错，而旧值是
--   "变更前是什么"的唯一记录）—— 用工类型的"现值"就是合同 kind，
--   161 的花名册也是这么派生的（c.kind AS employment_kind），两处同源。
CREATE OR REPLACE FUNCTION public.fn_change_open(
  p_employee bigint,
  p_kind     varchar,
  p_date     date,
  p_reason   varchar,
  p_new      jsonb,
  p_by       varchar DEFAULT 'system'
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_c     record;
  v_seqs  record;
  v_code  varchar(32);
  v_id    bigint;
BEGIN
  SELECT * INTO v_c
    FROM public.employment_contract c
   WHERE c.employee_id = p_employee AND c.status = 'signed'
     AND daterange(c.start_date, c.end_date, '[]') @> p_date
   ORDER BY c.start_date DESC LIMIT 1;

  v_code := 'YD' || to_char(p_date, 'YYYYMM') || '-'
    || lpad(((SELECT count(*) FROM public.employee_change g
               WHERE g.effective_date >= date_trunc('month', p_date)) + 1)::text, 4, '0');

  -- 当前归属（转店时填 old/new）
  SELECT a.org_id INTO v_seqs FROM public.employee_org_assignment a
   WHERE a.employee_id = p_employee AND a.dim_code = 'cost_org'
     AND daterange(a.valid_from, a.valid_to, '[]') @> p_date
   ORDER BY a.valid_from DESC LIMIT 1;

  INSERT INTO public.employee_change
    (code, employee_id, kind, effective_date, reason,
     old_job_title, new_job_title, old_workplace, new_workplace,
     old_org_id, new_org_id, old_hours_system, new_hours_system,
     employment_kind_from, employment_kind_to,
     salary_adjust_id, status, created_by)
  VALUES (v_code, p_employee, p_kind, p_date, p_reason,
     CASE WHEN p_new ? 'job_title' THEN v_c.job_title END,
     NULLIF(btrim(COALESCE(p_new->>'job_title','')), ''),
     CASE WHEN p_new ? 'workplace' THEN v_c.workplace END,
     NULLIF(btrim(COALESCE(p_new->>'workplace','')), ''),
     CASE WHEN p_new ? 'org_id' THEN v_seqs.org_id END,
     NULLIF(p_new->>'org_id','')::bigint,
     CASE WHEN p_new ? 'hours_system' THEN v_c.hours_system END,
     NULLIF(btrim(COALESCE(p_new->>'hours_system','')), ''),
     -- ★ 用工类型：旧值是"这份合同现在是什么"，不是调用方传进来的
     CASE WHEN p_new ? 'employment_kind' THEN v_c.kind END,
     NULLIF(btrim(COALESCE(p_new->>'employment_kind','')), ''),
     NULLIF(p_new->>'salary_adjust_id','')::bigint,
     'draft', p_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION fn_change_open IS
  '开一张异动单（163 建，173 加用工类型新旧值）：只存"这次动了的字段"（没传的留 NULL），'
  '旧值从当前在履行的合同与归属里取 —— 让人手填旧值，就会填错，'
  '而旧值是"变更前是什么"的唯一记录。';

-- ---------------------------------------------------------------------------
-- 5. 生效：把变更后的用工类型落到变更协议上（重定义 169 的 fn_change_apply）
-- ---------------------------------------------------------------------------
-- ★ 基线是 **169** 的版本（它修了"试用期内转店签不下协议"），不是 163 的 ——
--   照 163 重写会把 169 的试用期修复整条抹掉，而那个错的表现是
--   "变更协议永远停在 draft"，与用工类型毫无关系，很难联想到是这里。
--
-- ★ 用工类型怎么"生效"：它不是一个可以 UPDATE 的现值列，而是**合同的 kind**
--   （161 的花名册 c.kind AS employment_kind 就是这么派生的）。所以换用工类型
--   = 出一份 kind 已改的变更协议，与"改档案"无关，历史那一份合同一个字不动。
--
-- ★ 160 的 ck_ec_open_end 要求：open（无固定期限）必须无终止日、非 open 必须有。
--   于是换类型时终止日要跟着改：
--     · 转成 open → 终止日置空（这就是无固定期限的意思）；
--     · 从 open 转出 → 原合同没有终止日，**拒**，不替人编一个日期 ——
--       编出来的终止日会原样印在要签字的协议上。
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
  v_kind  varchar(16);
  v_end   date;
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

  -- ---- 1. 归属：旧段截断到生效日前一天，新段从生效日开（不改现值，见 163 文件头 ②）----
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

  -- ---- 2. 试用期：剩余部分跟着人走（169 的修复，逐字保留）----
  IF c.probation_to IS NOT NULL AND c.probation_to >= g.effective_date THEN
    v_pf := g.effective_date;
    v_pt := c.probation_to;
  ELSE
    v_pf := NULL;
    v_pt := NULL;
  END IF;

  -- ---- 3. 用工类型：变更后的协议类型（173）----
  v_kind := COALESCE(g.employment_kind_to, c.kind);
  -- ★ 用已登记的业务码 E_CHG_BLOCKED，**不新造一个码**：
  --   errors.mjs 里没登记的错误码会一路落到 500（AE1 那条断言数的是这个），
  --   而"协议上缺终止日"是业务上要拦的一次变更，不是系统故障。
  IF v_kind <> 'open' AND c.end_date IS NULL THEN
    RAISE EXCEPTION 'E_CHG_BLOCKED: 异动单 % 要把无固定期限改成 %，'
      '必须在协议上约定终止日 —— 系统不替人编日期（编出来会印在要签字的协议上）',
      g.code, v_kind;
  END IF;
  v_end := CASE WHEN v_kind = 'open' THEN NULL ELSE c.end_date END;

  -- ---- 4. 书面变更：生成新合同，prev_id 指向原合同（不改原合同）----
  --   模板按**变更后**的类型取：拿旧类型的模板去套，纸上写的是旧用工类型的条款。
  SELECT t.id INTO v_tpl FROM public.contract_template t
   WHERE t.kind = v_kind AND t.is_active ORDER BY t.version DESC, t.id LIMIT 1;

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
  VALUES (g.employee_id, c.legal_entity_id, v_no, v_kind, g.effective_date, v_end,
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
  '异动生效（163 建、169 修试用期、173 加用工类型）：按生效日切归属段、'
  '生成变更协议（prev_id 串链、draft）、原合同在协议**签署时**才截断。'
  '★ 173 起：employment_kind_to 落到新合同的 kind 上（协议正文的"合同类型"一行读它），'
  '并处理 160 的 ck_ec_open_end（转 open 置空终止日；从 open 转出则拒，不替人编日期）。';

-- ---------------------------------------------------------------------------
-- 6. 判据登记：不新增一行
-- ---------------------------------------------------------------------------
-- ★ 这条改动由 test/run.mjs 的 **CHG5** 钉住（转固定期限 → 非全日制：异动单记下
--   从/到、变更协议的 kind 跟着变、原合同一个字不改）。
--   CHG5 的结论自动记进 **163 那条 SUITE.CHG**（跑分组的判据按 id 前缀归组），
--   所以这里**不**另登记一行 —— 登记一条永远没人跑的行，只会让覆盖率报表上
--   多一条 never_run，而那条 debt 是我自己造的。
