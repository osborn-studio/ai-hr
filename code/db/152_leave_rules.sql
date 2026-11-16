-- ============================================================================
-- 152_leave_rules.sql · 假种的三条"发放与申请"规则（对齐 Excel 高级版专有项）
-- ----------------------------------------------------------------------------
-- 这一版只做三件事，全部是 Excel 里写明、而系统里原来没有的：
--
--   ① 年假"按月平均发放"：每年一次性发 10 天，员工 1 月就想休完 ——
--      现实里 HR 要的是"每月 0.83 天，休到哪个月算到哪个月"。
--      原文：「每年，按月平均每月发放，根据最小步长向下/向上取整」。
--   ② 每次最大请假时长：不限的话有人一次报 30 天事假，审批人只能靠常识拦。
--   ③ 证明门槛：病假超过 4 小时必须有病假条 —— 这是"事后能不能追"的关键，
--      而系统原来只存了一个天数，连"他有没有交证明"都答不出来。
--
-- ★★ 这一版最容易写错、也是 HR 对账时第一个发现的地方：**尾差**。
--    10 天 ÷ 12 = 0.8333，按 0.5 步长向下取整 = 0.5，12 个月 = 6 天，
--    凭空少 4 天。少给不会有人投诉，会一直错到员工离职算年假折现那天。
--    所以取整**只取在每月额度上**，差额**全补到 12 月**：
--      1–11 月各 0.5 天，12 月 = 10 − 11 × 0.5 = 4.5 天。
--    下面的函数把这条写成了硬约束：任何口径下 12 条 grant 的合计 == 总额。
--    （向上取整会超发，超发时同样回落向下取整 —— 宁可最后一个月多一点，
--      也不能让"12 个月加起来不等于总额"。）
--
-- ★ 不改 fn_leave_apply：它是请假的核心路径，013 / 042 重建过两次，
--   上面挂着一堆断言。新的两条校验走 fn_leave_request_check，
--   由服务层在提交**之前**调用 —— 这样"核心路径"与"新规则"各自可独立验。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 假种：三个规则各一组列（默认值 = 上线前的行为）
-- ---------------------------------------------------------------------------
-- grant_mode=once 是上线前的行为：每年一条整额授予。
-- 默认值必须等于旧行为，否则升级当天所有人的年假台账会被重排。
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS grant_mode varchar(16) NOT NULL DEFAULT 'once';
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS round_step numeric(4,2) NOT NULL DEFAULT 0.5;
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS round_dir  varchar(8)  NOT NULL DEFAULT 'half';

-- NULL = 不限 / 不需要证明。★ 不能用 0 表示"不限"：
--   0 在业务上读作"一次也不能请"，而 "0 小时" 与 "不限" 的界面文案完全不同。
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS max_hours_per_request numeric(8,2);
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS proof_after_hours     numeric(8,2);

ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS ck_lt_grant_mode;
ALTER TABLE leave_type ADD CONSTRAINT ck_lt_grant_mode
  CHECK (grant_mode IN ('once','monthly'));

ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS ck_lt_round_dir;
ALTER TABLE leave_type ADD CONSTRAINT ck_lt_round_dir
  CHECK (round_dir IN ('up','down','half'));

-- 步长必须 > 0：0 会让 fn_leave_grant_monthly 里除零（numeric 除零不是 NULL，是报错）；
-- 上限 10 天是常识边界 —— 一个"每月 10 天步长"的年假已经等于不按月发了。
ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS ck_lt_round_step;
ALTER TABLE leave_type ADD CONSTRAINT ck_lt_round_step
  CHECK (round_step > 0 AND round_step <= 10);

ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS ck_lt_max_hours;
ALTER TABLE leave_type ADD CONSTRAINT ck_lt_max_hours
  CHECK (max_hours_per_request IS NULL OR max_hours_per_request > 0);

ALTER TABLE leave_type DROP CONSTRAINT IF EXISTS ck_lt_proof_after;
ALTER TABLE leave_type ADD CONSTRAINT ck_lt_proof_after
  CHECK (proof_after_hours IS NULL OR proof_after_hours > 0);

COMMENT ON COLUMN leave_type.grant_mode IS
  '发放方式：once 一次性（默认，上线前行为）/ monthly 按月平均（每 12 个月各一条授予）。';
COMMENT ON COLUMN leave_type.round_step IS
  '按月发放时的最小步长（天），默认 0.5。取整只作用在**每月额度**上，尾差补 12 月。';
COMMENT ON COLUMN leave_type.round_dir IS
  '按月发放时的取整方向：up 向上 / down 向下 / half 四舍五入（默认）。';
COMMENT ON COLUMN leave_type.max_hours_per_request IS
  '单次请假最长小时数，NULL = 不限。单位是**小时**（10 天 = 8 小时/天 × 10）。';
COMMENT ON COLUMN leave_type.proof_after_hours IS
  '单次请假超过这个小时数必须提交证明（病假条等），NULL = 不需要。';

-- ---------------------------------------------------------------------------
-- 2. 台账要能被"认出来"：按月发放的行必须可识别、可重跑
-- ---------------------------------------------------------------------------
-- ★ 幂等靠 reason 前缀识别（下文 fn_leave_grant_monthly 先删再插）。
--   没有这一列的话，同一年跑两次会得到 24 条 grant，余额翻倍 ——
--   而余额翻倍在页面上看起来只是"这个人年假挺多"。
ALTER TABLE leave_grant ADD COLUMN IF NOT EXISTS reason varchar(120);

COMMENT ON COLUMN leave_grant.reason IS
  '这条授予是哪来的：手工 / 按月发放 yyyy 年 / 结转。按月发放用前缀「按月发放」识别以便重跑时先删。';

-- 请假单上的证明说明（**不存文件**）：附件进文件系统，单据上只留
-- "交了张什么证明"，这样工资条、台账、审计都不会因为附件丢失而失去依据。
ALTER TABLE leave_request ADD COLUMN IF NOT EXISTS proof_note varchar(200);

COMMENT ON COLUMN leave_request.proof_note IS
  '证明说明/附件名（不存文件本身）。病假等超过 proof_after_hours 时必填。';

-- ---------------------------------------------------------------------------
-- 3. 取整工具：步长 + 方向
-- ---------------------------------------------------------------------------
-- 单独一个函数的原因：发放、试算、界面预览要用**同一套**取整，
-- 各写一遍 round/floor 迟早出现"页面预览 0.83、实际发 0.5"。
CREATE OR REPLACE FUNCTION fn_leave_round_step(p_val numeric, p_step numeric, p_dir varchar)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT round(
           CASE COALESCE(lower(btrim(p_dir)), 'half')
             WHEN 'up'   THEN ceil (COALESCE(p_val, 0) / s) * s
             WHEN 'down' THEN floor(COALESCE(p_val, 0) / s) * s
             ELSE             round(COALESCE(p_val, 0) / s) * s
           END, 2)
    FROM (SELECT GREATEST(COALESCE(p_step, 0.5), 0.01) AS s) x;
$$;

COMMENT ON FUNCTION fn_leave_round_step IS
  '按最小步长取整：up 向上 / down 向下 / half 四舍五入。步长 <=0 时按 0.5 兜底（除零会报错，不是 NULL）。';

-- ---------------------------------------------------------------------------
-- 4. 按月平均发放
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_leave_grant_monthly(
  p_person bigint,
  p_type   bigint,
  p_year   int,
  p_total  numeric DEFAULT NULL,
  p_by     varchar DEFAULT 'system'
) RETURNS numeric
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  t         public.leave_type%ROWTYPE;
  v_monthly numeric(10,4);
  v_qty     numeric(8,2);
  v_dec     numeric(8,2);
  v_total   numeric(10,2);
  v_reason  varchar(120);
  v_m       int;
  v_del     int := 0;
BEGIN
  IF p_year IS NULL OR p_year < 1990 OR p_year > 2100 THEN
    RAISE EXCEPTION 'E_LEAVE_YEAR: 年度 % 不合理（应在 1990–2100 之间）', p_year;
  END IF;

  SELECT * INTO t FROM public.leave_type WHERE id = p_type;
  IF t.id IS NULL THEN
    RAISE EXCEPTION 'E_LEAVE_TYPE_NOT_FOUND: 假种 % 不存在', p_type;
  END IF;

  -- 总额：不给就按档位表（年假按累计工龄）。非年假没有档位可查，必须传。
  v_total := p_total;
  IF v_total IS NULL THEN
    IF t.code = 'ANNUAL' THEN
      v_total := public.fn_annual_leave_days(p_person, make_date(p_year, 1, 1));
    ELSE
      RAISE EXCEPTION 'E_LEAVE_GRANT_NO_TOTAL: 「%」没有档位表，按月发放必须给全年总额', t.name;
    END IF;
  END IF;

  IF COALESCE(v_total, 0) <= 0 THEN
    RAISE EXCEPTION 'E_LEAVE_GRANT_NO_TOTAL: 「%」% 年的全年总额是 %，没有可发放的额度',
      t.name, p_year, v_total;
  END IF;

  -- 每月额度 = 总额 ÷ 12，按最小步长取整
  v_monthly := round(v_total / 12.0, 4);
  v_qty     := public.fn_leave_round_step(v_monthly, t.round_step, t.round_dir);

  -- ★ 向上取整会超发：0.83 按 0.5 步长向上 = 1.0，12 个月 = 12 天 > 10 天。
  --   超发时回落向下取整（宁可最后一个月多一点，也不能让 12 个月加起来不等于总额）。
  IF v_qty * 12 > v_total THEN
    v_qty := public.fn_leave_round_step(v_monthly, t.round_step, 'down');
  END IF;

  -- ★ 尾差全补 12 月：1–11 月各 v_qty，12 月 = 总额 − 11 × v_qty。
  --   例：10 天、步长 0.5、向下 → 每月 0.5，12 月 = 10 − 5.5 = 4.5。
  v_dec := v_total - v_qty * 11;
  IF v_dec < 0 THEN         -- 兜底：11 个月已经超了总额（只可能来自异常步长）
    v_qty := 0;
    v_dec := v_total;
  END IF;

  v_reason := left('按月发放 ' || p_year || ' 年：每月 ' || v_qty || ' 天，'
                   || '尾差补 12 月（' || COALESCE(p_by, 'system') || '）', 120);

  -- ★ 幂等：先删掉本函数**上一次**为同年同假种生成的 grant。
  --   只按 reason 前缀删，不碰手工授予与结转 —— 手工那 3 天不能因为重跑一次就消失。
  DELETE FROM public.leave_grant
   WHERE employee_id = p_person
     AND leave_type_id = p_type
     AND COALESCE(leave_year, EXTRACT(year FROM valid_from)::int) = p_year
     AND reason LIKE '按月发放%';
  GET DIAGNOSTICS v_del = ROW_COUNT;

  -- 每月一条；v_qty = 0 的月份不落行（ck_lg_qty 要求 qty > 0，
  -- 而且"0 天"的授予行只会让余额页多 11 行噪音）。
  IF v_qty > 0 THEN
    FOR v_m IN 1..11 LOOP
      INSERT INTO public.leave_grant(employee_id, leave_type_id, qty, valid_from, leave_year, reason)
      VALUES (p_person, p_type, v_qty, make_date(p_year, v_m, 1), p_year, v_reason);
    END LOOP;
  END IF;

  IF v_dec > 0 THEN
    INSERT INTO public.leave_grant(employee_id, leave_type_id, qty, valid_from, leave_year, reason)
    VALUES (p_person, p_type, v_dec, make_date(p_year, 12, 1), p_year, v_reason);
  END IF;

  -- 返回**实际落账的合计**（== 总额）。返回 p_total 会让"取整取错了"
  -- 这件事被返回值掩掉，而调用方只会拿返回值去显示。
  RETURN v_qty * 11 + v_dec;
END;
$$;

COMMENT ON FUNCTION fn_leave_grant_monthly IS
  '按月平均发放：把全年总额拆成 12 条 leave_grant（每月 1 日生效）。'
  '取整只作用在每月额度上，尾差全部补到 12 月 —— 12 条合计恒等于总额。'
  'p_total 为 NULL 时按 annual_leave_tier 查（仅年假）。'
  '幂等：重跑先删同员工/同假种/同年度里 reason 以「按月发放」开头的行。';

-- ---------------------------------------------------------------------------
-- 5. 申请前校验：最大时长 + 证明门槛
-- ---------------------------------------------------------------------------
-- ★ 为什么单独一个函数、而不是塞进 fn_leave_apply：
--   ① fn_leave_apply 是核心路径（013 / 042 重建过两次），改它要重跑一片断言；
--   ② 这两条是**假种配置**决定的，配置一改就该生效，不该跟核心流程绑死；
--   ③ 校验要在"冻结额度"之前跑：先冻后拒会留下 released 行，
--      而 released 行会被审计问"为什么这个人有 12 条被释放的冻结"。
--
-- ★ 单位：p_hours 是**小时**（配置项也叫 max_hours_per_request）。
--   leave_request.qty 是**天**（138 定下的），所以服务层负责 天 × 8 换算后再进来。
--   两个单位在这里混着传是这一版最容易出的错，所以参数名直接写死 _hours。
--
-- p_proof_note 是可选的第 6 个参数（默认 NULL）：单据还没建时由界面传进来；
-- 单据已建（补交证明后再校验一次）时，调用方传 null 也会被当作"没有证明"。
CREATE OR REPLACE FUNCTION fn_leave_request_check(
  p_person     bigint,
  p_type       bigint,
  p_from       date,
  p_to         date,
  p_hours      numeric,
  p_proof_note varchar DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  t       public.leave_type%ROWTYPE;
  v_hours numeric(8,2);
  v_proof varchar(200);
BEGIN
  SELECT * INTO t FROM public.leave_type WHERE id = p_type;
  IF t.id IS NULL THEN
    RAISE EXCEPTION 'E_LEAVE_TYPE_NOT_FOUND: 假种 % 不存在', p_type;
  END IF;
  IF NOT t.is_active THEN
    RAISE EXCEPTION 'E_LEAVE_TYPE_INACTIVE: 「%」已停用，不能再新增请假', t.name;
  END IF;

  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'E_LEAVE_DATE_RANGE: 请假区间不对（% → %）', p_from, p_to;
  END IF;

  v_hours := COALESCE(p_hours, 0);
  IF v_hours <= 0 THEN
    RAISE EXCEPTION 'E_LEAVE_HOURS_INVALID: 请假时长必须是正数（收到 %）', p_hours;
  END IF;

  -- ① 单次最大时长
  IF t.max_hours_per_request IS NOT NULL AND v_hours > t.max_hours_per_request THEN
    RAISE EXCEPTION 'E_LEAVE_MAX_HOURS: 「%」单次最多 % 小时，本次申请 % 小时；'
      '要请更长的假请拆成多张单（拆单是审批口径，不是系统限制）',
      t.name, t.max_hours_per_request, v_hours;
  END IF;

  -- ② 证明门槛
  v_proof := NULLIF(btrim(COALESCE(p_proof_note, '')), '');
  IF t.proof_after_hours IS NOT NULL AND v_hours > t.proof_after_hours AND v_proof IS NULL THEN
    RAISE EXCEPTION 'E_LEAVE_PROOF_REQUIRED: 「%」单次超过 % 小时必须提交证明'
      '（病假条、诊断证明等），本次申请 % 小时',
      t.name, t.proof_after_hours, v_hours;
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_leave_request_check IS
  '请假提交前校验：① 超 max_hours_per_request → E_LEAVE_MAX_HOURS；'
  '② 超 proof_after_hours 但没有 proof_note → E_LEAVE_PROOF_REQUIRED。'
  '不改 fn_leave_apply —— 核心路径上挂着既有断言，新规则由服务层在此拦。'
  'p_hours 是**小时**；leave_request.qty 是**天**，换算在服务层（天 × 8）。';

-- ---------------------------------------------------------------------------
-- 6. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.LVR','假种规则：按月发放 12 条合计等于总额、超时长拒、超门槛无证明拒',
   'ATTENDANCE','ALGORITHM','fn_leave_grant_monthly','public','leave_grant','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-LVR','假种规则接进界面：三项规则读得到、改得动、按月发放返回 12 个月明细',
   'ATTENDANCE','ACL','leave_type','public','leave_type','TABLE',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
