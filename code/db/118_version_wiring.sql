-- ============================================================================
-- 118_version_wiring.sql · 版本自动留：生成/调整/导入/确认/重开各写一版
-- ----------------------------------------------------------------------------
-- 115 建了 att_period_version 和写入函数，但**没有任何地方调它** ——
-- 那等于给了一本账本，却没规定"什么时候记一笔"，最后一定是空的。
--
-- 这一版把五个动作全部接上，各自标 source：
--
--   build    汇总生成（月报从日报得出来的那一步）
--   manual   HR 手调某个字段
--   import   Excel 导入覆盖
--   confirm  HR 确认（**发薪争议时看的就是这一版**）
--   reopen   重开改数之前，先把"确认过的样子"存下来
--
-- 外加两个能力：
--   fn_att_period_version_restore  把某一版写回去（"回到上一版"）
--   fn_att_period_version_diff     两版对比（谁、哪个字段、从多少变到多少）
--
-- ★ 为什么版本要自动写而不是"提供按钮"：
--   需要版本的那一刻，永远是"已经出问题了"的时候。那时人不会记得去点按钮。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 恢复到某一版
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_att_period_version_restore(
  p_version bigint, p_reason varchar, p_by varchar)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v public.att_period_version%ROWTYPE;
  it jsonb;
  v_n int := 0;
BEGIN
  IF length(btrim(COALESCE(p_reason,''))) < 4 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 恢复必须写原因（至少 4 个字）';
  END IF;

  SELECT * INTO v FROM public.att_period_version WHERE id = p_version;
  IF v.id IS NULL THEN RAISE EXCEPTION 'E_NOT_FOUND: 版本 % 不存在', p_version; END IF;

  IF EXISTS (SELECT 1 FROM public.att_period_report x
              WHERE x.period = v.period AND x.legal_entity_id = v.legal_entity_id
                AND x.status = 'confirmed') THEN
    RAISE EXCEPTION 'E_ATT_REPORT_CONFIRMED: % 的月报已确认，恢复前请先重开', v.period;
  END IF;

  FOR it IN SELECT * FROM jsonb_array_elements(v.snapshot)
  LOOP
    UPDATE public.att_period_report SET
      work_days = (it->>'work_days')::numeric,
      calendar_days = (it->>'calendar_days')::numeric,
      roster_days = (it->>'roster_days')::numeric,
      present_days = (it->>'present_days')::numeric,
      leave_days = (it->>'leave_days')::numeric,
      personal_leave_days = (it->>'personal_leave_days')::numeric,
      absent_days = (it->>'absent_days')::numeric,
      work_hours = (it->>'work_hours')::numeric,
      ot_hours = (it->>'ot_hours')::numeric,
      updated_at = now()
     WHERE period = v.period AND person_id = (it->>'person_id')::bigint
       AND legal_entity_id = v.legal_entity_id
       AND status = 'draft';
    v_n := v_n + 1;
  END LOOP;

  -- 恢复本身也留一版：否则"恢复过"这件事会从历史里消失
  PERFORM public.fn_att_period_version_write(v.period, v.legal_entity_id, 'manual', p_by,
            '恢复到 v' || v.version_no || '：' || left(btrim(p_reason), 120));
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION fn_att_period_version_restore IS
  '把某一版月报写回去（只改 draft 行；已确认的期拒绝）。恢复本身也留一版。';

-- ---------------------------------------------------------------------------
-- 2. 两版对比
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_att_period_version_diff(p_v1 bigint, p_v2 bigint)
RETURNS TABLE (person_id bigint, field_name varchar, v1 numeric, v2 numeric)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE a public.att_period_version%ROWTYPE; b public.att_period_version%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.att_period_version WHERE id = p_v1;
  SELECT * INTO b FROM public.att_period_version WHERE id = p_v2;
  IF a.id IS NULL OR b.id IS NULL THEN
    RAISE EXCEPTION 'E_NOT_FOUND: 版本不存在';
  END IF;
  IF a.period <> b.period OR a.legal_entity_id <> b.legal_entity_id THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 只能对比同一期间的版本';
  END IF;

  RETURN QUERY
  WITH x AS (
    SELECT (e->>'person_id')::bigint pid,
           e->>'work_days' wd, e->>'present_days' pd, e->>'leave_days' ld,
           e->>'personal_leave_days' pld, e->>'absent_days' ad,
           e->>'work_hours' wh, e->>'ot_hours' oh
      FROM jsonb_array_elements(a.snapshot) e
  ), y AS (
    SELECT (e->>'person_id')::bigint pid,
           e->>'work_days' wd, e->>'present_days' pd, e->>'leave_days' ld,
           e->>'personal_leave_days' pld, e->>'absent_days' ad,
           e->>'work_hours' wh, e->>'ot_hours' oh
      FROM jsonb_array_elements(b.snapshot) e
  )
  -- f.name 来自 VALUES 是 text，RETURNS TABLE 声明的是 varchar：显式转，
  -- 否则 RETURN QUERY 会报 build_attrmap_by_position（列类型不匹配，报错里看不到哪个字段）
  SELECT COALESCE(x.pid, y.pid)::bigint, f.name::varchar, f.a, f.b
    FROM x FULL JOIN y ON y.pid = x.pid
    CROSS JOIN LATERAL (VALUES
      ('work_days',          (x.wd)::numeric,  (y.wd)::numeric),
      ('present_days',       (x.pd)::numeric,  (y.pd)::numeric),
      ('leave_days',         (x.ld)::numeric,  (y.ld)::numeric),
      ('personal_leave_days',(x.pld)::numeric, (y.pld)::numeric),
      ('absent_days',        (x.ad)::numeric,  (y.ad)::numeric),
      ('work_hours',         (x.wh)::numeric,  (y.wh)::numeric),
      ('ot_hours',           (x.oh)::numeric,  (y.oh)::numeric)
    ) AS f(name, a, b)
   WHERE f.a IS DISTINCT FROM f.b
   ORDER BY 1, 2;
END;
$$;

COMMENT ON FUNCTION fn_att_period_version_diff IS
  '对比两版月报：哪些人、哪个字段、从多少变到多少。只返回真正变了的行。';

CREATE OR REPLACE FUNCTION fn_att_period_build(
  p_period varchar, p_entity bigint, p_by varchar)
RETURNS TABLE (built int, skipped_confirmed int, people int)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_end date;
  e record;
  a record;
  v_personal numeric(6,2);
  v_absent numeric(6,2);
  r record;
BEGIN
  IF p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM（收到 %）', p_period;
  END IF;
  v_end := (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date;

  built := 0; skipped_confirmed := 0; people := 0;

  FOR e IN
    SELECT em.person_id, em.legal_entity_id
      FROM public.employment em
     WHERE em.legal_entity_id = p_entity
       AND daterange(em.hire_date, em.leave_date, '[]') @> v_end
     ORDER BY em.person_id
  LOOP
    people := people + 1;

    SELECT * INTO r FROM public.att_period_report x
     WHERE x.period = p_period AND x.person_id = e.person_id;

    -- ★ 已确认的不动。"再汇总一次"不该能改掉 HR 已经认可的数字 ——
    --   那正是"最终数字"与"汇总"的区别。要改必须显式 reopen。
    IF r.id IS NOT NULL AND r.status = 'confirmed' THEN
      skipped_confirmed := skipped_confirmed + 1;
      CONTINUE;
    END IF;

    SELECT * INTO a FROM public.fn_att_person_period(e.person_id, p_period);
    SELECT COALESCE(public.fn_leave_approved_days(e.person_id, p_period, 'PERSONAL'), 0)
      INTO v_personal;
    -- 旷工 = 应出勤 − 实出勤 − 请假（不小于 0）。这只是**生成时的估算**，
    -- HR 可以改：现实里"没来"常被更正成"调休"或"外出办事"。
    v_absent := GREATEST(a.work_days - a.present_days - a.leave_days, 0);

    INSERT INTO public.att_period_report AS t
      (period, person_id, legal_entity_id, work_days, calendar_days, roster_days,
       present_days, leave_days, personal_leave_days, absent_days,
       work_hours, ot_hours, workdays_source, status, note, built_at, updated_at)
    VALUES
      (p_period, e.person_id, e.legal_entity_id, a.work_days, a.calendar_days, a.roster_days,
       a.present_days, a.leave_days, v_personal, v_absent,
       a.work_hours, a.ot_hours, a.workdays_source, 'draft', NULL, now(), now())
    ON CONFLICT (period, person_id) DO UPDATE
      SET work_days = EXCLUDED.work_days,
          calendar_days = EXCLUDED.calendar_days,
          roster_days = EXCLUDED.roster_days,
          present_days = EXCLUDED.present_days,
          leave_days = EXCLUDED.leave_days,
          -- ★ 事假不覆盖：它可能已被 HR 调过。汇总口径的事假在 fn_leave_approved_days 里，
          --   这里只在该行还是"全 0 新建"时写入（见下面的条件）
          personal_leave_days = CASE WHEN t.updated_at = t.built_at
                                     THEN EXCLUDED.personal_leave_days
                                     ELSE t.personal_leave_days END,
          absent_days = EXCLUDED.absent_days,
          work_hours = EXCLUDED.work_hours,
          ot_hours = EXCLUDED.ot_hours,
          workdays_source = EXCLUDED.workdays_source,
          updated_at = now()
    WHERE t.status = 'draft';

    built := built + 1;
  END LOOP;

  -- ★ 生成完自动留一版：HR 说"我上周看过一版，跟现在不一样"，这就是那一版。
  --   靠人记得手动点"存版本"，等于没有版本。
  IF built > 0 THEN
    PERFORM public.fn_att_period_version_write(p_period, p_entity, 'build', p_by,
              '汇总生成 ' || built || ' 人');
  END IF;

  RETURN NEXT;
END;
$$;

;

CREATE OR REPLACE FUNCTION fn_att_period_set(
  p_report bigint, p_field varchar, p_value numeric, p_reason varchar, p_by varchar)
RETURNS numeric
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r public.att_period_report%ROWTYPE;
  v_before numeric(10,2);
  v_reason varchar(200) := btrim(COALESCE(p_reason, ''));
BEGIN
  SELECT * INTO r FROM public.att_period_report WHERE id = p_report FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'E_ATT_REPORT_NOT_FOUND: %', p_report; END IF;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'E_ATT_REPORT_CONFIRMED: 月报已确认（%），要改请先重开并写明原因', r.period;
  END IF;
  IF length(v_reason) < 4 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 调整必须写原因（至少 4 个字）—— 改了没理由等于没留痕';
  END IF;
  IF p_value IS NULL OR p_value < 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 值不能为空或负数';
  END IF;

  -- ★ 白名单写死，不用动态 SQL：动态列名是 SQL 注入最经典的那扇门，
  --   而这里只有 9 个字段，逐个列出来成本远低于"以后某天有人拼错一个变量"。
  IF    p_field = 'work_days'           THEN v_before := r.work_days;
  ELSIF p_field = 'present_days'        THEN v_before := r.present_days;
  ELSIF p_field = 'leave_days'          THEN v_before := r.leave_days;
  ELSIF p_field = 'personal_leave_days' THEN v_before := r.personal_leave_days;
  ELSIF p_field = 'absent_days'         THEN v_before := r.absent_days;
  ELSIF p_field = 'work_hours'          THEN v_before := r.work_hours;
  ELSIF p_field = 'ot_hours'            THEN v_before := r.ot_hours;
  ELSE
    RAISE EXCEPTION 'E_ATT_FIELD: 不能调整字段「%」（可调：work_days/present_days/'
                    'leave_days/personal_leave_days/absent_days/work_hours/ot_hours）', p_field;
  END IF;

  -- 应出勤是折算分母，不能改成 0
  IF p_field = 'work_days' AND p_value <= 0 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 应出勤必须大于 0（它是折算的分母）';
  END IF;

  IF p_field = 'work_days' THEN
    UPDATE public.att_period_report SET work_days = p_value, updated_at = now() WHERE id = p_report;
  ELSIF p_field = 'present_days' THEN
    UPDATE public.att_period_report SET present_days = p_value, updated_at = now() WHERE id = p_report;
  ELSIF p_field = 'leave_days' THEN
    UPDATE public.att_period_report SET leave_days = p_value, updated_at = now() WHERE id = p_report;
  ELSIF p_field = 'personal_leave_days' THEN
    UPDATE public.att_period_report SET personal_leave_days = p_value, updated_at = now() WHERE id = p_report;
  ELSIF p_field = 'absent_days' THEN
    UPDATE public.att_period_report SET absent_days = p_value, updated_at = now() WHERE id = p_report;
  ELSIF p_field = 'work_hours' THEN
    UPDATE public.att_period_report SET work_hours = p_value, updated_at = now() WHERE id = p_report;
  ELSIF p_field = 'ot_hours' THEN
    UPDATE public.att_period_report SET ot_hours = p_value, updated_at = now() WHERE id = p_report;
  END IF;

  -- 改了就留痕（一次调整一条，不合并：合并会把"改了三次"写成一次）
  INSERT INTO public.att_period_adjust(report_id, field_name, before_value, after_value,
                                      reason, adjusted_by)
  VALUES (p_report, p_field, v_before, p_value, v_reason, p_by);

  -- 每次调整留一版。会比较多（每人每字段一次），但这正是"可追溯"的代价：
  -- 合并版本会让"改了三次"变成"改了一次"，而 HR 复盘时最需要知道的就是改了几次。
  PERFORM public.fn_att_period_version_write(r.period, r.legal_entity_id, 'manual', p_by,
            p_field || ' ' || COALESCE(v_before::text,'-') || ' → ' || p_value::text);

  RETURN p_value;
END;
$$;

;

CREATE OR REPLACE FUNCTION fn_att_period_confirm(
  p_period varchar, p_entity bigint, p_by varchar)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_n int;
BEGIN
  UPDATE public.att_period_report
     SET status = 'confirmed', confirmed_by = p_by, confirmed_at = now(), updated_at = now()
   WHERE period = p_period AND legal_entity_id = p_entity AND status = 'draft';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    -- 区分"没有月报"与"都已经确认了"：两者的处置完全不同
    IF EXISTS (SELECT 1 FROM public.att_period_report
                WHERE period = p_period AND legal_entity_id = p_entity) THEN
      RAISE EXCEPTION 'E_ATT_ALREADY_CONFIRMED: % 的月报已全部确认', p_period;
    END IF;
    RAISE EXCEPTION 'E_ATT_NO_REPORT: % 还没有月报，先点"生成"', p_period;
  END IF;

  -- 确认这一版单独标 source='confirm'：发薪争议时，要看的就是"HR 点头的那一版"
  PERFORM public.fn_att_period_version_write(p_period, p_entity, 'confirm', p_by,
            '确认 ' || v_n || ' 人');
  RETURN v_n;
END;
$$;

;

CREATE OR REPLACE FUNCTION fn_att_period_reopen(
  p_period varchar, p_entity bigint, p_reason varchar, p_by varchar)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_n int; r record;
BEGIN
  IF length(btrim(COALESCE(p_reason,''))) < 4 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 重开必须写原因（至少 4 个字）—— 它会把已认可的数字变成待改';
  END IF;

  -- 重开前先看这一期有没有已算出的工资条：有的话必须提醒，
  -- 因为"确认后重开再改"意味着"已经按旧数字发出的钱"与库里的数不一致了。
  IF EXISTS (SELECT 1 FROM public.payslip p JOIN public.pay_run pr ON pr.id = p.pay_run_id
              WHERE pr.period = p_period AND pr.kind = 'monthly') THEN
    RAISE EXCEPTION 'E_ATT_HAS_PAYSLIP: % 已经有工资条，重开会造成"发出去的钱"与"库里的数"不一致；'
                    '请先作废该期工资批次再重开', p_period;
  END IF;

  FOR r IN SELECT id FROM public.att_period_report
            WHERE period = p_period AND legal_entity_id = p_entity AND status = 'confirmed'
  LOOP
    -- 重开本身也留一条痕迹：字段记 '__reopen__'，原因就是 HR 写的理由
    INSERT INTO public.att_period_adjust(report_id, field_name, before_value, after_value,
                                        reason, adjusted_by)
    VALUES (r.id, '__reopen__', NULL, NULL, btrim(p_reason), p_by);
  END LOOP;

  UPDATE public.att_period_report
     SET status = 'draft', confirmed_by = NULL, confirmed_at = NULL, updated_at = now()
   WHERE period = p_period AND legal_entity_id = p_entity AND status = 'confirmed';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- 重开也留一版：这一版的意义是"确认过的样子在这里，之后改了什么可以比"
  IF v_n > 0 THEN
    PERFORM public.fn_att_period_version_write(p_period, p_entity, 'reopen', p_by,
              left(btrim(p_reason), 150));
  END IF;
  RETURN v_n;
END;
$$;

;

CREATE OR REPLACE FUNCTION fn_att_period_import_apply(
  p_batch bigint, p_period varchar, p_entity bigint, p_by varchar)
RETURNS TABLE (applied int, skipped int, failed int)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  b public.att_import_batch%ROWTYPE;
  rw record;
  rep record;
  v_applied int := 0; v_skipped int := 0; v_failed int := 0;
  v_err text;
BEGIN
  SELECT * INTO b FROM public.att_import_batch WHERE id = p_batch FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'E_NOT_FOUND: 导入批次 % 不存在', p_batch; END IF;
  IF b.kind <> 'monthly' THEN
    RAISE EXCEPTION 'E_IMPORT_KIND: 批次 % 是 % 导入，不能用月报应用', p_batch, b.kind;
  END IF;
  IF b.status = 'applied' THEN
    RAISE EXCEPTION 'E_ALREADY_APPLIED: 批次 % 已经应用过（重复应用会把"导入"变成"再导一次"）', p_batch;
  END IF;
  IF b.period <> p_period THEN
    RAISE EXCEPTION 'E_IMPORT_PERIOD: 批次期间 % 与目标期间 % 不一致', b.period, p_period;
  END IF;

  -- 期初就把"已确认"的整体拦下：只拦一半会让这一期一半新一半旧
  IF EXISTS (SELECT 1 FROM public.att_period_report x
              WHERE x.period = p_period AND x.legal_entity_id = p_entity
                AND x.status = 'confirmed') THEN
    RAISE EXCEPTION 'E_ATT_REPORT_CONFIRMED: % 的月报已确认，导入覆盖前请先重开', p_period;
  END IF;

  FOR rw IN SELECT * FROM public.att_import_row WHERE batch_id = p_batch AND ok ORDER BY row_no
  LOOP
    BEGIN
      SELECT * INTO rep FROM public.att_period_report x
       WHERE x.period = p_period AND x.person_id = (rw.payload->>'person_id')::bigint
       FOR UPDATE;
      IF rep.id IS NULL THEN
        v_skipped := v_skipped + 1;    -- 校验阶段已认定"没这一期月报"，这里不该发生
        CONTINUE;
      END IF;

      -- 缺的 key 不动：Excel 里留空 = 这一列不改，而不是"改成 0"
      UPDATE public.att_period_report SET
        work_days           = COALESCE((rw.payload->>'work_days')::numeric, work_days),
        present_days        = COALESCE((rw.payload->>'present_days')::numeric, present_days),
        leave_days          = COALESCE((rw.payload->>'leave_days')::numeric, leave_days),
        personal_leave_days = COALESCE((rw.payload->>'personal_leave_days')::numeric,
                                       personal_leave_days),
        absent_days         = COALESCE((rw.payload->>'absent_days')::numeric, absent_days),
        work_hours          = COALESCE((rw.payload->>'work_hours')::numeric, work_hours),
        ot_hours            = COALESCE((rw.payload->>'ot_hours')::numeric, ot_hours),
        updated_at          = now()
       WHERE id = rep.id;

      v_applied := v_applied + 1;
    EXCEPTION WHEN others THEN
      v_failed := v_failed + 1;
      v_err := SQLERRM;
      UPDATE public.att_import_row SET ok = false, error = left(v_err, 500) WHERE id = rw.id;
    END;
  END LOOP;

  UPDATE public.att_import_batch
     SET status = 'applied', applied_at = now(),
         row_ok = v_applied, row_fail = b.row_fail + v_failed
   WHERE id = p_batch;

  -- 导入覆盖后留一版：导入是"一次改几十人"，最需要能对比改前改后
  IF v_applied > 0 THEN
    PERFORM public.fn_att_period_version_write(p_period, p_entity, 'import', p_by,
              '导入覆盖 ' || v_applied || ' 人（批次 #' || p_batch || '）');
  END IF;

  applied := v_applied; skipped := v_skipped; failed := v_failed;
  RETURN NEXT;
END;
$$;

;
