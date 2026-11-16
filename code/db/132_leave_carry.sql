-- ============================================================================
-- 132_leave_carry.sql · 往年结转的年假：先说清"还算不算"，再算钱
-- ----------------------------------------------------------------------------
-- 129 的折现只算**当年度**：往年剩下的额度挂在台账上（`available` 里看得见），
-- 但折现函数看不见它 —— 于是出现一个很难解释的状态：
--
--   员工 2026 年剩 5 天、2027 年又剩 5 天，台账显示"可用 10 天"，
--   折现却只给 2027 年的 5 天。那 5 天既没休、也没折、也没作废，
--   在账上永远是"欠着的"—— 而没有任何报表会把它列出来。
--
-- 根因：`leave_grant` 只有有效期区间，没有"归属年度"。没有归属，
-- 就无法回答"这 5 天是哪一年的、还在不在有效期内"。
--
-- 这一版加三件事：
--   ① **归属年度**：`leave_grant.leave_year`（默认取 valid_from 的年份，不改既有数据）；
--   ② **结转政策**（制度项）：默认 `void` = 法定口径「一般不跨年度安排」，
--      往年余额**不折现**（与 129 的行为完全一致）；`carry_1y` = 允许结转一年；
--   ③ **结转截止日**：`carry_1y` 下，往年额度必须在次年 3/31 前休完，过期不再折。
--
-- ★ 为什么默认 void：法定是"一般不跨年"，跨年是例外且要单位批准。
--   默认值必须等于上线前的行为 —— 129 上线时只折当年，所以这里也只看当年。
--
-- ★ 已休天数怎么分到年度：**FIFO**，先用最早年度的额度。
--   这不是技术选择 —— 结转额度有截止日，"先用旧的"是唯一能让它在截止日前被用掉的分法。
--   反过来（先用当年）会让结转额度永远用不掉，然后每年 3/31 准时作废，
--   看起来像"公司每年吃掉员工几天假"。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 归属年度
-- ---------------------------------------------------------------------------
ALTER TABLE leave_grant ADD COLUMN IF NOT EXISTS leave_year int;
ALTER TABLE leave_grant ADD COLUMN IF NOT EXISTS carried_from int;

UPDATE leave_grant SET leave_year = EXTRACT(year FROM valid_from)::int WHERE leave_year IS NULL;

ALTER TABLE leave_grant DROP CONSTRAINT IF EXISTS ck_lg_year;
ALTER TABLE leave_grant ADD CONSTRAINT ck_lg_year
  CHECK (leave_year IS NULL OR (leave_year BETWEEN 1990 AND 2100));

CREATE INDEX IF NOT EXISTS ix_lg_year ON leave_grant (employee_id, leave_type_id, leave_year);

COMMENT ON COLUMN leave_grant.leave_year IS
  '额度归属年度（132）。没有它就无法回答"这 5 天是哪一年的、过没过结转截止日"。'
  '默认取 valid_from 的年份，回填既有数据。';
COMMENT ON COLUMN leave_grant.carried_from IS
  '从哪一年结转来的（NULL = 当年新授予）。';

-- ---------------------------------------------------------------------------
-- 2. 结转政策
-- ---------------------------------------------------------------------------
INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('LEAVE_CARRY_POLICY', '往年剩余年假怎么处理', 'LEAVE', 'enum', false, 'group', '')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('LEAVE_CARRY_POLICY', '2026-01-01', 'void', 'group_hr',
        '默认=法定口径（条例第 5 条：一般不跨年度安排）：往年余额不折现')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

INSERT INTO policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('LEAVE_CARRY_DEADLINE', '结转额度最晚休到哪天', 'LEAVE', 'text', false, 'group', '')
ON CONFLICT (code) DO NOTHING;

INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
VALUES ('LEAVE_CARRY_DEADLINE', '2026-01-01', '03-31', 'group_hr',
        '结转一年时，次年 3 月 31 日前必须休完；过期不再折现')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. 按年度的应休未休（重写 129 的版本）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_annual_leave_unused(p_employee bigint, p_on date)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_year    int := EXTRACT(year FROM p_on)::int;
  v_policy  varchar(16);
  v_carry   int := 0;
  v_dl_mm   int := 3;
  v_dl_dd   int := 31;
  v_dl      varchar(8);
  v_ent     numeric(6,2);
  v_elapsed int;
  v_prorata numeric(8,2);
  v_taken   numeric(8,2) := 0;   -- 到 p_on 为止累计已休
  v_c_used  numeric(8,2) := 0;   -- 其中被往年额度吸收的
  v_c_left  numeric(8,2) := 0;   -- 往年还剩（可折的）
  v_c_cash  numeric(8,2) := 0;   -- 往年已折现
  v_t_cash  numeric(8,2) := 0;   -- 当年已折现
  v_used_t  numeric(8,2);
  v_unused  numeric(8,2);
  v_total   numeric(8,2);
  v_avail   numeric(8,2);
  v_type    bigint := public.fn_leave_type_id('ANNUAL');
BEGIN
  SELECT COALESCE(value_text,'void') INTO v_policy
    FROM public.fn_policy_effective('LEAVE_CARRY_POLICY', NULL, p_on);
  v_carry := CASE WHEN v_policy = 'void' THEN 0 ELSE 1 END;

  SELECT COALESCE(value_text,'03-31') INTO v_dl
    FROM public.fn_policy_effective('LEAVE_CARRY_DEADLINE', NULL, p_on);
  IF v_dl ~ '^\d{2}-\d{2}$' THEN
    v_dl_mm := left(v_dl, 2)::int;
    v_dl_dd := right(v_dl, 2)::int;
  END IF;

  -- 到 p_on 为止累计已休（不分年度，后面按 FIFO 分摊）
  SELECT COALESCE(SUM(lr.qty), 0) INTO v_taken
    FROM public.leave_request lr
    JOIN public.leave_type lt ON lt.id = lr.leave_type_id
   WHERE lr.employee_id = p_employee AND lt.code = 'ANNUAL'
     AND lr.status = 'approved'
     AND lr.date_from <= p_on;

  -- 往年额度：**总是**要算"吸收了多少已休"，因为往年休的假是从往年额度里出的；
  -- 而"可折多少"才受结转政策与截止日限制。第一版把整块放进 IF v_carry > 0，
  -- 结果默认 void 时吸收量恒为 0，2026 年休的 2 天被扣到了 2027 年头上（ALC9 从 7 变 5）。
  BEGIN
    WITH g AS (
      SELECT COALESCE(lg.leave_year, EXTRACT(year FROM lg.valid_from)::int) y,
             SUM(lg.qty) qty
        FROM public.leave_grant lg
       WHERE lg.employee_id = p_employee AND lg.leave_type_id = v_type
       GROUP BY 1
    ), f AS (
      SELECT y, qty,
             COALESCE(SUM(qty) OVER (ORDER BY y ROWS BETWEEN UNBOUNDED PRECEDING
                                     AND 1 PRECEDING), 0) AS before
        FROM g
    ), a AS (
      SELECT f.y, f.qty,
             -- FIFO：这 5 天里有多少被"累计已休"吃掉了
             LEAST(f.qty, GREATEST(v_taken - f.before, 0)) AS used_y
        FROM f
       WHERE f.y < v_year
    )
    SELECT
      -- 可折的部分：受结转政策与截止日限制
      COALESCE(SUM(CASE WHEN a.y >= v_year - v_carry
                         AND p_on <= make_date(a.y + 1, v_dl_mm, v_dl_dd)
                        THEN GREATEST(a.qty - a.used_y, 0) ELSE 0 END), 0),
      -- ★ 吸收量要对**所有**往年额度算，不受结转政策影响：
      --   2026 年休的那 2 天是从 2026 年的额度里出的，不该扣 2027 年的折算。
      --   第一版把这两件事写在一个 WHERE 里，ALC9 立刻从 7 天变成 5 天。
      COALESCE(SUM(a.used_y), 0)
      INTO v_c_left, v_c_used
      FROM a;
  END;

  -- 往年已折现的部分要从往年余额里扣掉（同一年折过的不会再折）
  SELECT COALESCE(SUM(c.days), 0) INTO v_c_cash
    FROM public.leave_cashout c
   WHERE c.employee_id = p_employee AND c.leave_year < v_year AND c.status <> 'void';

  v_c_left := GREATEST(v_c_left - v_c_cash, 0);

  -- 当年：按工龄折算，扣掉"往年没吸收掉的已休"与当年已折现
  v_ent     := public.fn_annual_leave_days(p_employee, p_on);
  v_elapsed := p_on - make_date(v_year, 1, 1) + 1;
  v_prorata := round(v_ent * v_elapsed / 365.0, 4);

  SELECT COALESCE(SUM(c.days), 0) INTO v_t_cash
    FROM public.leave_cashout c
   WHERE c.employee_id = p_employee AND c.leave_year = v_year AND c.status <> 'void';

  v_used_t := GREATEST(v_taken - v_c_used, 0);
  v_unused := GREATEST(floor(v_prorata - v_used_t - v_t_cash), 0);

  v_total := v_c_left + v_unused;

  -- 授予额度封顶（与 129 同一条规矩）：没给过额度的人不该折出现金
  SELECT b.available INTO v_avail
    FROM public.v_leave_balance b
   WHERE b.employee_id = p_employee AND b.leave_type_id = v_type;
  IF v_avail IS NOT NULL THEN
    v_total := LEAST(v_total, GREATEST(v_avail, 0));
  END IF;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION fn_annual_leave_unused IS
  '应休未休天数（按年度）= 往年结转（仅 carry 政策开着且未过截止日）+ 当年折算。'
  '已休按 FIFO 先扣最早年度 —— 结转额度有截止日，"先用旧的"才让它在过期前被用掉。'
  '当年仍是 floor(应享×已过天/365 − 已休 − 已折现)，不足 1 天不付（第 12 条）。'
  '默认 LEAVE_CARRY_POLICY=void，只算当年 —— 与 129 的行为一致。';

-- ---------------------------------------------------------------------------
-- 4. 按年度拆开看（界面用）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_annual_leave_breakdown(p_employee bigint, p_on date)
RETURNS TABLE(leave_year int, granted numeric, used numeric, cashed numeric,
              remaining numeric, state varchar)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_year   int := EXTRACT(year FROM p_on)::int;
  v_policy varchar(16);
  v_carry  int := 0;
  v_dl     varchar(8);
  v_dl_mm  int := 3;
  v_dl_dd  int := 31;
  v_taken  numeric(8,2) := 0;
  v_type   bigint := public.fn_leave_type_id('ANNUAL');
BEGIN
  SELECT COALESCE(value_text,'void') INTO v_policy
    FROM public.fn_policy_effective('LEAVE_CARRY_POLICY', NULL, p_on);
  v_carry := CASE WHEN v_policy = 'void' THEN 0 ELSE 1 END;

  SELECT COALESCE(value_text,'03-31') INTO v_dl
    FROM public.fn_policy_effective('LEAVE_CARRY_DEADLINE', NULL, p_on);
  IF v_dl ~ '^\d{2}-\d{2}$' THEN
    v_dl_mm := left(v_dl, 2)::int;
    v_dl_dd := right(v_dl, 2)::int;
  END IF;

  SELECT COALESCE(SUM(lr.qty), 0) INTO v_taken
    FROM public.leave_request lr
    JOIN public.leave_type lt ON lt.id = lr.leave_type_id
   WHERE lr.employee_id = p_employee AND lt.code = 'ANNUAL'
     AND lr.status = 'approved' AND lr.date_from <= p_on;

  RETURN QUERY
  WITH g AS (
    SELECT COALESCE(lg.leave_year, EXTRACT(year FROM lg.valid_from)::int) y,
           SUM(lg.qty) qty
      FROM public.leave_grant lg
     WHERE lg.employee_id = p_employee AND lg.leave_type_id = v_type
     GROUP BY 1
  ), f AS (
    SELECT y, qty,
           COALESCE(SUM(qty) OVER (ORDER BY y ROWS BETWEEN UNBOUNDED PRECEDING
                                   AND 1 PRECEDING), 0) AS before
      FROM g
  ), d AS (
    SELECT f.y, f.qty,
           LEAST(f.qty, GREATEST(v_taken - f.before, 0)) AS used_y,
           COALESCE((SELECT SUM(c.days) FROM public.leave_cashout c
                      WHERE c.employee_id = p_employee AND c.leave_year = f.y
                        AND c.status <> 'void'), 0) AS cashed_y
      FROM f
     WHERE f.y <= v_year
  )
  -- ★ 每一列都显式 cast：CASE 里的字符串字面量会被推成 text，而 RETURNS TABLE 写的是
  --   varchar —— 报错是 "structure of query does not match function result type"，
  --   读起来像列数不对（130 的 hint 也栽在同一个地方）。
  SELECT d.y::int,
         d.qty::numeric,
         d.used_y::numeric,
         d.cashed_y::numeric,
         GREATEST(d.qty - d.used_y - d.cashed_y, 0)::numeric,
         (CASE WHEN d.y = v_year THEN 'current'
               WHEN v_carry = 0 THEN 'not_carried'
               WHEN p_on > make_date(d.y + 1, v_dl_mm, v_dl_dd) THEN 'expired'
               ELSE 'carried' END)::varchar
    FROM d
   ORDER BY d.y;
END;
$$;

COMMENT ON FUNCTION fn_annual_leave_breakdown IS
  '按年度拆开年假额度：授予 / 已用（FIFO 分摊）/ 已折现 / 剩余 / 状态。'
  'state: current 当年 / carried 结转中 / expired 已过结转截止日 / not_carried 政策不结转。';

-- ---------------------------------------------------------------------------
-- 5. 结转截止日到了：把过期的往年额度作废（要留痕，所以是显式动作）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_leave_carry_expire(p_employee bigint, p_on date)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows int := 0;
  r record;
BEGIN
  FOR r IN
    SELECT b.leave_year, b.remaining
      FROM public.fn_annual_leave_breakdown(p_employee, p_on) b
     WHERE b.state = 'expired' AND b.remaining > 0
  LOOP
    INSERT INTO public.leave_usage(employee_id, leave_type_id, qty, state, request_id)
    VALUES (p_employee, public.fn_leave_type_id('ANNUAL'), r.remaining, 'forfeited', NULL);
    v_rows := v_rows + 1;
  END LOOP;
  RETURN v_rows;
END;
$$;

COMMENT ON FUNCTION fn_leave_carry_expire IS
  '把过了结转截止日的往年年假余额作废（留 forfeited 行，不删授予）。'
  '★ 余额视图的 available 不吃掉"未结转"的部分，所以作废之后 available 会真的减少 —— '
  '否则每年 3/31 之后"可用天数"看起来没变，实际早就不能用了。';

-- ---------------------------------------------------------------------------
-- 6. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.CARRY','往年结转：默认不结转、结转有截止日、已休按 FIFO 先扣旧额度',
   'PAYROLL','ALGORITHM','fn_annual_leave_unused','public','leave_grant','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-CARRY','结转政策接进接口：页面读得到、改得动、试算带年度拆解',
   'PAYROLL','ACL','fn_annual_leave_breakdown','public','leave_grant','FUNCTION',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
