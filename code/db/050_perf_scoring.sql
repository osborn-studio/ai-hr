-- ============================================================================
-- 051_perf_scoring.sql · 绩效打分：把「表在、门没有」补上
-- ----------------------------------------------------------------------------
-- 026 把方案 / 档位 / 周期 / 结果四张表、封存与系数固化都写好了，
-- 可是**没有任何东西往 perf_result 里写** —— 封存只能在空表上跑，
-- 于是 fn_perf_factor 永远返回 NULL，工资条上的绩效工资永远是 0。
--
-- 这与 006（审批三张表没人写）、010（fn_mcp_execute 没人调）、
-- 037（例外表没人开）是同一个形态：**对象存在但没有写入路径，等于没做**。
-- 而它的失败形态特别安静 —— 工资条上那一栏是 0，看起来像"这个月没有绩效"。
--
-- 四条判据（每条都对着一种"看起来对"的错）：
--   ① 打分必须能定档：分数定了档才定系数。定不了档就别存这一行 ——
--      存了会让封存时才发现，而那时已经有人按"评过了"在沟通。
--   ② 分数必须在方案覆盖范围内：0–100 是常识，但方案是人配的，
--      缺口（60–89 空着）比越界更容易出现，且更晚才被发现。
--   ③ 封存后不许改分：改分就是改已发的钱。触发器拦得住，但要有**名字**。
--   ④ 排除（不参与考核）必须写原因：空原因的"不参与"和"忘了评"同形。
--
-- 一条刻意不做的事：**不做"绩效工资系数"的第二套算法**。
-- 系数只在 fn_perf_seal 里固化为 factor，算薪只读 factor ——
-- 两边各算一次，就会出现"封存时显示 1.1、发钱时按 1.0"这种没人认账的差。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 打分（未封存可改，封存后由触发器拒）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_perf_score(
  p_cycle    bigint,
  p_employee bigint,
  p_score    numeric,
  p_note     varchar,
  p_by       varchar
) RETURNS TABLE (grade varchar(8), factor numeric(6,4))
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  c public.perf_cycle%ROWTYPE;
  v_scheme bigint; v_grade varchar(8); v_factor numeric(6,4);
BEGIN
  SELECT * INTO c FROM public.perf_cycle WHERE id = p_cycle FOR UPDATE;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'E_PERF_NO_CYCLE: 绩效周期 % 不存在', p_cycle;
  END IF;

  -- ③ 封存后不许改分。触发器也会拦（fn_pr_frozen），但这里的错误**有名字**，
  --   而触发器给的是"不能改"——对调用方来说，前者能直接显示给用户。
  IF c.status = 'sealed' THEN
    RAISE EXCEPTION 'E_PERF_SEALED: 周期 % 已封存（% 由 % 封存），分数不可再改',
      c.code, c.sealed_at, c.sealed_by;
  END IF;

  -- 分数是百分制。范围校验放在"定档"之前：先拒掉荒谬值，再谈落在哪一档。
  IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN
    RAISE EXCEPTION 'E_PERF_SCORE_OUT_OF_RANGE: 分数必须在 0–100 之间（收到 %）', p_score;
  END IF;

  -- 在周期内没有任职的人不该有绩效结果：那会让"这个月谁该被考核"说不清
  IF NOT EXISTS (
    SELECT 1 FROM public.employment e
     WHERE e.person_id = p_employee
       AND daterange(e.hire_date, e.leave_date, '[]') && daterange(c.period_from, c.period_to, '[]')
  ) THEN
    RAISE EXCEPTION 'E_PERF_NOT_EMPLOYED: 员工 % 在周期 % 内没有任职（不该出现在考核名单里）',
      p_employee, c.code;
  END IF;

  -- ① 方案取「周期结束日」生效的那一版 —— 与 fn_perf_seal 同一条口径。
  v_scheme := public.fn_perf_scheme_asof(c.period_to);
  IF v_scheme IS NULL THEN
    RAISE EXCEPTION 'E_PERF_NO_SCHEME: 周期结束日 % 没有生效的绩效方案', c.period_to;
  END IF;

  SELECT g.grade, g.factor INTO v_grade, v_factor
    FROM public.perf_grade g
   WHERE g.scheme_id = v_scheme
     AND p_score >= g.min_score AND p_score <= g.max_score
   ORDER BY g.min_score DESC
   LIMIT 1;

  -- ② 定不了档就不存。存了会等到封存时才炸，而那时已经按"评过了"在沟通。
  IF v_grade IS NULL THEN
    RAISE EXCEPTION 'E_PERF_NO_GRADE: 分数 % 在方案 % 里落不到任何档位（方案有缺口）',
      p_score, v_scheme;
  END IF;

  INSERT INTO public.perf_result(cycle_id, employee_id, state, score, grade, note)
  VALUES (p_cycle, p_employee, 'scored', p_score, v_grade, nullif(btrim(p_note), ''))
  ON CONFLICT (cycle_id, employee_id) DO UPDATE
     SET state = 'scored', score = EXCLUDED.score, grade = EXCLUDED.grade,
         note = EXCLUDED.note
   WHERE public.perf_result.state <> 'excluded'
      OR public.perf_result.state = 'excluded';   -- 排除之后仍可改回"已评"

  -- ★ 回传 factor 只是**预告**，不是写入：factor 由 fn_perf_seal 固化，
  --   提前写会让 ck_pr_factor_pre 之外的路径也产生值 —— 那正是
  --   "系数在分数之前就定了"的形态。这里 RETURN 的 factor 只用于界面提示。
  RETURN QUERY SELECT v_grade, v_factor;
END;
$$;

COMMENT ON FUNCTION fn_perf_score IS
  '打分即定档（分数 → 档位），系数**不写**（由 fn_perf_seal 固化）。'
  '封存后调用会得到有名字的 E_PERF_SEALED，而不是触发器给的"不能改"。';

-- ---------------------------------------------------------------------------
-- 2. 排除：不参与考核，必须写原因
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_perf_exclude(
  p_cycle bigint, p_employee bigint, p_note varchar, p_by varchar
) RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE c public.perf_cycle%ROWTYPE;
BEGIN
  IF p_note IS NULL OR length(btrim(p_note)) < 4 THEN
    RAISE EXCEPTION 'E_PERF_EXCLUDE_REASON: 排除必须写原因（至少 4 个字）；'
      '空原因的"不参与"与"忘了评"在报表上同形';
  END IF;

  SELECT * INTO c FROM public.perf_cycle WHERE id = p_cycle FOR UPDATE;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'E_PERF_NO_CYCLE: 绩效周期 % 不存在', p_cycle;
  END IF;
  IF c.status = 'sealed' THEN
    RAISE EXCEPTION 'E_PERF_SEALED: 周期 % 已封存，不能再改名单', c.code;
  END IF;

  INSERT INTO public.perf_result(cycle_id, employee_id, state, score, grade, note)
  VALUES (p_cycle, p_employee, 'excluded', NULL, NULL, btrim(p_note))
  ON CONFLICT (cycle_id, employee_id) DO UPDATE
     SET state = 'excluded', score = NULL, grade = NULL, note = EXCLUDED.note;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 一张能看出"还差谁"的名单
-- ---------------------------------------------------------------------------
-- ★ 这不是"统计"，是**待办**：封存之前要能回答"这个周期还有谁没评"。
--   只显示"已评 N 人"的界面，在 3 人里评了 3 人与 30 人里评了 3 人之间没有区别。
CREATE OR REPLACE VIEW v_perf_pending AS
SELECT c.id AS cycle_id, c.code AS cycle_code, c.status,
       e.person_id AS employee_id,
       p.full_name,
       r.state,
       CASE
         WHEN r.id IS NULL THEN 'missing'
         WHEN r.state = 'excluded' THEN 'excluded'
         ELSE 'scored'
       END AS bucket
  FROM perf_cycle c
  JOIN employment e
    ON daterange(e.hire_date, e.leave_date, '[]')
       && daterange(c.period_from, c.period_to, '[]')
  JOIN person p ON p.id = e.person_id
  LEFT JOIN perf_result r ON r.cycle_id = c.id AND r.employee_id = e.person_id;

COMMENT ON VIEW v_perf_pending IS
  '按"周期 × 周期内在职的人"展开，缺的那些 bucket=missing。'
  '只看 perf_result 的界面永远答不出"还差谁"，而封存正好卡在这件事上。';

-- ---------------------------------------------------------------------------
-- 4. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.AQ','绩效打分：定档/范围/封存后不可改/排除须写原因','INTEGRATION','ALGORITHM',
   'fn_perf_score','public','perf_result','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-AQ','绩效打分接口侧','INTEGRATION','ALGORITHM',
   'v_perf_pending','public','perf_result','VIEW','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
