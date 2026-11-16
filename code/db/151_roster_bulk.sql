-- ============================================================================
-- 151_roster_bulk.sql · 排班的批量动作：复制粘贴 / Excel 导入 / 导出
-- ----------------------------------------------------------------------------
-- 钉钉高级排班把"排班"做成一件事之后，真正让人每天省时间的是这三个动作：
--
--   ① **复制粘贴**：「上周怎么排的，这周一样」—— 固定班表门店的常态。
--   ② **Excel 导入**：「一百个人的班已经在这张表里了」—— 新店开业、大促。
--   ③ **导出**：先把表导出去填，填完再导回来（产品模板：部门 | 用户ID | 工号 |
--      姓名 | 日期列）。
--
-- ★ 三个动作各有一条必须先钉住的判断，写在这里是因为它们都有代价：
--
--   · **复制不能覆盖目标日**。目标日已有任何排班 → 整天跳过、不复制一半。
--     排班被静默覆盖之后，页面那格只剩新班，看不出原来的东西没了 ——
--     而"少了一段班"要到工资发下来才发现。宁可让人看见「目标日已有排班」，
--     自己先清掉再复制。
--
--   · **复制不带确认状态**。确认单全部重建为 not_started：新的一天要重新确认，
--     把上周的「门店已确认」抄到这周，等于替门店签了它没看过的字。
--
--   · **导入必须部分成功**。导 100 行、3 行错，97 行要进去，错的逐条报行号。
--     整批回滚会让人对着一千行找那 3 行 —— 那比不做导入更费时间。
--     所以每一行是一个子事务（PL/pgSQL 的 BEGIN…EXCEPTION），坏行回滚自己，
--     不动已经成功的行。
--
-- ★ 一件不做：导出不做"临时班次的时段合并"。临时班次（shift_id IS NULL，148 的
--   划线）一段一行，导出时 shift_code 写 `临时班次` —— 产品模板明确"临时班次
--   不支持导入"，所以导出要能让人一眼看出来：这些行原样导回去会被拒（E_ROW_SHIFT），
--   而不是被悄悄当成某个固定班次排上。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 复制一天到另一天
-- ---------------------------------------------------------------------------
-- copied / skipped 都按**天**计（一天最多 1）。段数、排休天数写进 note ——
-- 调用方拿 copied 就知道"复制成功几天"，不用再数段。
CREATE OR REPLACE FUNCTION fn_roster_copy(
  p_employee bigint,
  p_from     date,
  p_to       date,
  p_by       varchar
) RETURNS TABLE (copied int, skipped int, note text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_src_n      int;
  v_seg_n      int;
  v_min        int;
  v_store      bigint;
  v_has        boolean;
  v_blk        record;
  v_copied     int := 0;
  v_seg_copied int := 0;
  v_rest_n     int := 0;
  v_sched      record;
  v_seg        record;
  v_new_sched  bigint;
  v_new_seg    bigint;
  v_ls         timestamp;
  v_le         timestamp;
  v_ns         timestamp;
  v_ne         timestamp;
  v_start_ts   timestamptz;
  v_end_ts     timestamptz;
  v_overlap    boolean := false;
  v_slot_code  varchar(16);
  v_slot_store bigint;
  v_note       text;
BEGIN
  IF p_employee IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 人、源日期、目标日期都不能为空';
  END IF;
  IF p_to = p_from THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 源日期与目标日期是同一天（%），复制没有目标', p_from;
  END IF;

  -- 源日：有几条排班、几段、共多少分钟（规则校验要按目标日的累计算）
  SELECT count(*)::int INTO v_src_n
    FROM public.schedule s
   WHERE s.employee_id = p_employee AND s.work_date = p_from;

  IF v_src_n = 0 THEN
    copied := 0; skipped := 1;
    note := format('源日 %s 没有排班，没有可复制的', p_from);
    RETURN NEXT; RETURN;
  END IF;

  SELECT COALESCE(sum(ROUND(EXTRACT(epoch FROM (sg.end_at - sg.start_at)) / 60)), 0)::int,
         count(sg.id)::int,
         min(s.store_id)
    INTO v_min, v_seg_n, v_store
    FROM public.schedule s
    LEFT JOIN public.schedule_segment sg ON sg.schedule_id = s.id
   WHERE s.employee_id = p_employee AND s.work_date = p_from;

  -- ★ 目标日已有排班（段或排休都算）→ 整天跳过。
  --   只拦"有段"是不对的：目标日排了休息、再复制一堆班上去，roster_slot 被
  --   覆盖成上班，而休息这条排班还留在 schedule 里 —— 两张表各说一套。
  SELECT EXISTS (SELECT 1 FROM public.schedule s
                  WHERE s.employee_id = p_employee AND s.work_date = p_to)
    INTO v_has;
  IF v_has THEN
    copied := 0; skipped := 1;
    note := format('目标日 %s 已有排班，整条不复制（要覆盖请先清掉目标日）', p_to);
    RETURN NEXT; RETURN;
  END IF;

  -- 复制前问规则（149 的同一份实现）：目标日那一刻的日/周/月上限、连续排班。
  -- 源日只有排休（0 分钟）时也会走一遍，规则里 max=0 的"不许排"照样能拦。
  SELECT * INTO v_blk
    FROM public.fn_roster_check(p_employee, p_to, v_store, v_min) LIMIT 1;
  IF v_blk.kind = 'block' THEN
    copied := 0; skipped := 1;
    note := format('规则不允许复制到 %s：%s（%s）', p_to, v_blk.message, v_blk.rule_code);
    RETURN NEXT; RETURN;
  END IF;

  FOR v_sched IN
    SELECT s.id, s.shift_id, s.store_id
      FROM public.schedule s
     WHERE s.employee_id = p_employee AND s.work_date = p_from
     ORDER BY s.id
  LOOP
    INSERT INTO public.schedule(employee_id, work_date, shift_id, store_id)
    VALUES (p_employee, p_to, v_sched.shift_id, v_sched.store_id)
    RETURNING id INTO v_new_sched;
    v_copied := v_copied + 1;

    FOR v_seg IN
      SELECT sg.seq, sg.store_id, sg.start_at, sg.end_at
        FROM public.schedule_segment sg
       WHERE sg.schedule_id = v_sched.id
       ORDER BY sg.seq
    LOOP
      -- ★ 保留的是"相对排班日的时刻"，不是"把时间戳加一天"：
      --   跨零点的闭店班 17:00–次日 01:00，两段都要落在正确的那一天。
      v_ls := (v_seg.start_at AT TIME ZONE public.app_tz());
      v_le := (v_seg.end_at   AT TIME ZONE public.app_tz());
      v_ns := (p_to + (v_ls::date - p_from)) + v_ls::time;
      v_ne := (p_to + (v_le::date - p_from)) + v_le::time;
      v_start_ts := v_ns AT TIME ZONE public.app_tz();
      v_end_ts   := v_ne AT TIME ZONE public.app_tz();

      -- 目标日的**前后一天**也要看：昨天 20:00 起的夜班与今天复制出来的早班
      -- 重叠时，两段工时会被算两遍（145 的同一条判断，复制这条路同样要守）。
      IF EXISTS (
        SELECT 1
          FROM public.schedule s2
          JOIN public.schedule_segment sg2 ON sg2.schedule_id = s2.id
         WHERE s2.employee_id = p_employee
           AND s2.work_date BETWEEN p_to - 1 AND p_to + 1
           AND s2.work_date <> p_to
           AND tstzrange(sg2.start_at, sg2.end_at, '[)') && tstzrange(v_start_ts, v_end_ts, '[)')
      ) THEN
        v_overlap := true;
        EXIT;
      END IF;

      INSERT INTO public.schedule_segment(schedule_id, seq, store_id, start_at, end_at)
      VALUES (v_new_sched, v_seg.seq, v_seg.store_id, v_start_ts, v_end_ts)
      RETURNING id INTO v_new_seg;

      -- 段与确认单同生；**状态不带过来** —— 新的一天要重新确认
      INSERT INTO public.confirm_sheet(segment_id, status) VALUES (v_new_seg, 'not_started');
      v_seg_copied := v_seg_copied + 1;
    END LOOP;

    IF v_overlap THEN EXIT; END IF;

    -- 没有段 = 排休（REST 班次）。它也是排班，复制时保留 ——
    -- 周复制把休息日丢掉，下一周就变成"人人连上七天"。
    IF NOT EXISTS (SELECT 1 FROM public.schedule_segment sg
                    WHERE sg.schedule_id = v_sched.id) THEN
      v_rest_n := v_rest_n + 1;
    END IF;
  END LOOP;

  -- 相邻日重叠：把刚插进去的东西整条撤掉（目标日原本是空的，删了就是原样）
  IF v_overlap THEN
    DELETE FROM public.schedule s
     WHERE s.employee_id = p_employee AND s.work_date = p_to;
    copied := 0; skipped := 1;
    note := format('目标日 %s 与相邻日已有班次重叠（同一时段两段 = 两倍工时），未复制', p_to);
    RETURN NEXT; RETURN;
  END IF;

  -- roster_slot 镜像（四个算薪读者看它）：从源日抄过来；源日没有就按第一条排班推。
  SELECT r.shift_code, r.store_id INTO v_slot_code, v_slot_store
    FROM public.roster_slot r
   WHERE r.employee_id = p_employee AND r.work_date = p_from;

  IF v_slot_store IS NULL THEN
    SELECT s.store_id INTO v_slot_store
      FROM public.schedule s
     WHERE s.employee_id = p_employee AND s.work_date = p_from
     ORDER BY s.id LIMIT 1;
    SELECT sd.code INTO v_slot_code
      FROM public.schedule s
      JOIN public.shift_def sd ON sd.shift_id = s.shift_id
     WHERE s.employee_id = p_employee AND s.work_date = p_from
     ORDER BY s.id LIMIT 1;
  END IF;

  IF v_slot_store IS NOT NULL THEN
    INSERT INTO public.roster_slot(employee_id, store_id, work_date, shift_code, updated_by)
    VALUES (p_employee, v_slot_store, p_to, v_slot_code, COALESCE(p_by, 'system'))
    ON CONFLICT (employee_id, work_date) DO UPDATE
      SET store_id = EXCLUDED.store_id,
          shift_code = EXCLUDED.shift_code,
          updated_by = EXCLUDED.updated_by,
          updated_at = now();
  END IF;

  copied := 1; skipped := 0;
  v_note := format('复制到 %s：%s 条排班、%s 段（起止时刻与班次身份保留）',
                   p_to, v_copied, v_seg_copied);
  IF v_seg_copied > 0 THEN
    v_note := v_note || '，确认单已重建 not_started';
  END IF;
  IF v_rest_n > 0 THEN
    v_note := v_note || format('；含排休 %s 天', v_rest_n);
  END IF;
  IF v_seg_n = 0 THEN
    v_note := v_note || '；源日没有段（全部是排休）';
  END IF;
  note := v_note;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_roster_copy IS
  '把某人 p_from 这一天的排班原样复制到 p_to（151，保留起止时刻、跨零点、班次身份与排休）。'
  '目标日已有任何排班 → 整天跳过（copied=0, skipped=1）；规则不允许 → 跳过并写明原因；'
  '与相邻日已有段重叠 → 整天不复制。确认单一律重建为 not_started（不抄确认状态）。'
  'copied / skipped 都按天计（一天 1）。';

-- ---------------------------------------------------------------------------
-- 2. 复制一整周
-- ---------------------------------------------------------------------------
-- 逐天调上面那个函数，**不另写一份逻辑**：周复制与日复制一旦分家，
-- "跳过的那几天为什么不一样"就会变成两个地方各说一套。
CREATE OR REPLACE FUNCTION fn_roster_copy_week(
  p_employee   bigint,
  p_src_monday date,
  p_dst_monday date,
  p_by         varchar
) RETURNS TABLE (copied int, skipped int, note text)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_copied  int := 0;
  v_skipped int := 0;
  v_notes   text := '';
  v_day     int;
  v_r       record;
BEGIN
  IF p_employee IS NULL OR p_src_monday IS NULL OR p_dst_monday IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 人、源周起始日、目标周起始日都不能为空';
  END IF;
  IF p_src_monday = p_dst_monday THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 源周与目标周是同一天（%），复制没有目标', p_src_monday;
  END IF;

  FOR v_day IN 0..6 LOOP
    SELECT * INTO v_r
      FROM public.fn_roster_copy(p_employee,
                                 p_src_monday + v_day,
                                 p_dst_monday + v_day,
                                 p_by) LIMIT 1;
    v_copied  := v_copied  + COALESCE(v_r.copied, 0);
    v_skipped := v_skipped + COALESCE(v_r.skipped, 0);
    IF COALESCE(v_r.skipped, 0) > 0 THEN
      v_notes := v_notes
              || CASE WHEN v_notes = '' THEN '' ELSE '；' END
              || (p_dst_monday + v_day)::text || '：' || v_r.note;
    END IF;
  END LOOP;

  copied := v_copied;
  skipped := v_skipped;
  note := format('复制 %s 天到 %s 起的一周（跳过 %s 天）%s',
                 v_copied, p_dst_monday, v_skipped,
                 CASE WHEN v_notes = '' THEN '' ELSE '：' || v_notes END);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_roster_copy_week IS
  '把 p_src_monday 起的一周逐天复制到 p_dst_monday 起的一周（151）。'
  '每一天都走 fn_roster_copy —— 周复制与日复制只有一份判断。'
  'copied / skipped 按天累计，跳过的那几天连同原因写进 note。';

-- ---------------------------------------------------------------------------
-- 3. Excel 导入（服务层解析，库里只收结构化行）
-- ---------------------------------------------------------------------------
-- p_rows: [{"employee_no":"E0001","date":"2026-11-20","shift":"EARLY"}, …]
--   shift = shift_def.code，或「清空」（删掉那天全部排班）
--
-- ★ 部分成功：每行一个子事务。坏行回滚自己，不动已经成功的行 ——
--   整批回滚会让人对着一千行找那 3 行，那比不做导入更费时间。
-- ★ 门店从人的组织归属推（cost_org 优先，其次 attendance_org），不由表里给：
--   产品模板没有"门店"列，而排班必须挂在某家店上。推不出来就报这一行，
--   不编一个 0 号店 —— 0 号店不存在，插进去要到算薪才发现。
CREATE OR REPLACE FUNCTION fn_roster_import(
  p_rows jsonb,
  p_by   varchar
) RETURNS TABLE (ok int, fail int, errors jsonb)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_el      record;
  v_row     int;
  v_no      varchar;
  v_date_s  varchar;
  v_shift   varchar;
  v_code    varchar;
  v_person  bigint;
  v_date    date;
  v_store   bigint;
  v_err     text;
  v_ecode   varchar;
  v_ok      int := 0;
  v_fail    int := 0;
  v_errors  jsonb := '[]'::jsonb;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'E_ARG_INVALID: rows 必须是数组（服务层解析出来的对象数组）';
  END IF;

  FOR v_el IN
    SELECT e.value, e.ordinality::int AS rn
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY e(value, ordinality)
  LOOP
    v_row    := v_el.rn;
    v_no     := btrim(COALESCE(v_el.value->>'employee_no', ''));
    v_date_s := btrim(COALESCE(v_el.value->>'date', ''));
    v_shift  := btrim(COALESCE(v_el.value->>'shift', ''));
    v_err    := NULL;

    -- ① 工号 → 人（与 089/093 导入框架同一个判据：retired_at IS NULL）
    IF v_no = '' THEN
      v_errors := v_errors || jsonb_build_object(
        'row', v_row, 'code', 'E_ROW_PERSON', 'message', '这一行没有工号');
      v_fail := v_fail + 1;
      CONTINUE;
    END IF;

    SELECT n.assigned_person_id INTO v_person
      FROM public.employee_no n
     WHERE n.no = v_no AND n.retired_at IS NULL
     LIMIT 1;

    IF v_person IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'row', v_row, 'code', 'E_ROW_PERSON', 'message', format('工号 %s 不存在', v_no));
      v_fail := v_fail + 1;
      CONTINUE;
    END IF;

    -- ② 日期
    BEGIN
      v_date := v_date_s::date;
    EXCEPTION WHEN others THEN
      v_err := format('日期「%s」不合法（要 YYYY-MM-DD 且真实存在）', v_date_s);
    END;
    IF v_err IS NOT NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'row', v_row, 'code', 'E_ROW_DATE', 'message', v_err);
      v_fail := v_fail + 1;
      CONTINUE;
    END IF;

    -- ③ 「清空」= 删掉那天（走 fn_roster_clear，锁定/已确认照样拒）
    IF v_shift = '清空' THEN
      BEGIN
        PERFORM public.fn_roster_clear(v_person, v_date, NULL, COALESCE(p_by, 'system'));
      EXCEPTION WHEN others THEN
        -- 那天本来就没排班：清空一个空的日子不是错误，整列「清空」是常态
        IF SQLERRM NOT LIKE 'E_ROSTER_BAD_STATE:%' THEN
          v_err := SQLERRM;
        END IF;
      END;
      IF v_err IS NOT NULL THEN
        v_errors := v_errors || jsonb_build_object(
          'row', v_row, 'code', 'E_ROW_LOCKED', 'message', v_err);
        v_fail := v_fail + 1;
      ELSE
        v_ok := v_ok + 1;
      END IF;
      CONTINUE;
    END IF;

    -- ④ 班次（临时班次没有 code，导不进来 —— 产品模板明确不支持）
    SELECT sd.code INTO v_code
      FROM public.shift_def sd
     WHERE upper(sd.code) = upper(v_shift)
     LIMIT 1;
    IF v_code IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'row', v_row, 'code', 'E_ROW_SHIFT',
        'message', format('班次「%s」不存在%s', v_shift,
                          CASE WHEN v_shift = '临时班次'
                               THEN '（临时班次不支持导入，请用划线排班）' ELSE '' END));
      v_fail := v_fail + 1;
      CONTINUE;
    END IF;

    -- ⑤ 门店：人的组织归属（cost_org 优先），当天有效
    SELECT a.org_id INTO v_store
      FROM public.employee_org_assignment a
     WHERE a.employee_id = v_person
       AND a.dim_code IN ('cost_org', 'attendance_org')
       AND daterange(a.valid_from, a.valid_to, '[]') @> v_date
     ORDER BY (a.dim_code = 'cost_org') DESC, a.valid_from DESC
     LIMIT 1;
    IF v_store IS NULL THEN
      v_errors := v_errors || jsonb_build_object(
        'row', v_row, 'code', 'E_ROW_STORE',
        'message', format('工号 %s 在 %s 没有组织归属，无法确定排到哪家店', v_no, v_date));
      v_fail := v_fail + 1;
      CONTINUE;
    END IF;

    -- ⑥ 落库：146 的入口本身会拒重叠 / 锁定 / 规则超限，这里只翻译成行错误
    v_err := NULL;
    BEGIN
      PERFORM public.fn_roster_assign(v_person, v_date, v_code, v_store,
                                      'Excel 批量导入', COALESCE(p_by, 'system'));
    EXCEPTION WHEN others THEN
      v_err := SQLERRM;
    END;

    IF v_err IS NULL THEN
      v_ok := v_ok + 1;
    ELSE
      v_ecode := CASE
        WHEN v_err LIKE 'E_ROSTER_OVERLAP:%'      THEN 'E_ROW_OVERLAP'
        WHEN v_err LIKE 'E_ROSTER_LOCKED:%'       THEN 'E_ROW_LOCKED'
        WHEN v_err LIKE 'E_ROSTER_CONFIRMED:%'    THEN 'E_ROW_LOCKED'
        WHEN v_err LIKE 'E_ROSTER_NO_EMPLOYEE:%'  THEN 'E_ROW_PERSON'
        WHEN v_err LIKE 'E_ROSTER_CROSS_REASON:%' THEN 'E_ROW_STORE'
        ELSE 'E_ROW_RULE'
      END;
      v_errors := v_errors || jsonb_build_object(
        'row', v_row, 'code', v_ecode, 'message', v_err);
      v_fail := v_fail + 1;
    END IF;
  END LOOP;

  ok := v_ok; fail := v_fail; errors := v_errors;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION fn_roster_import IS
  '按行导入排班（151）：employee_no + date + shift（班次码或「清空」）。'
  '**部分成功** —— 每行一个子事务，坏行只回滚自己并把 row / code / message 记进 errors；'
  '找不到工号 E_ROW_PERSON（与 089/093 导入框架一致），日期 E_ROW_DATE，'
  '班次 E_ROW_SHIFT，无组织归属 E_ROW_STORE，重叠 E_ROW_OVERLAP，锁定/已确认 E_ROW_LOCKED，'
  '规则超限 E_ROW_RULE。门店按人的 cost_org（其次 attendance_org）当天归属推。';

-- ---------------------------------------------------------------------------
-- 4. 导出（长表，由服务层转宽表）
-- ---------------------------------------------------------------------------
-- 产品模板是宽表（部门 | 用户ID | 工号 | 姓名 | 日期列），但库里按段出**长表**：
-- 一天多段在宽表里要拼单元格，拼法（换行？逗号？）由服务层定，SQL 不猜。
-- 临时班次（shift_id IS NULL）写 `临时班次` —— 导回去会被 E_ROW_SHIFT 拒，
-- 这正是要让人看见的。
CREATE OR REPLACE FUNCTION fn_roster_export(
  p_store bigint,
  p_from  date,
  p_days  int
) RETURNS TABLE (
  dept        text,
  user_id     varchar,
  employee_no varchar,
  person_name varchar,
  work_date   date,
  shift_code  varchar,
  start_hm    varchar,
  end_hm      varchar
)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_store IS NULL OR p_from IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 门店与起始日期必填';
  END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 31 THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 天数取 1..31（收到 %）', p_days;
  END IF;

  RETURN QUERY
  SELECT COALESCE(o.name, '')::text,
         -- 用户ID：有账号用登录名（与钉钉的 userid 同位置），没有账号用 person.id
         COALESCE((SELECT a.login FROM public.sys_account a
                    WHERE a.person_id = pe.id AND a.status = 'active'
                    ORDER BY a.id LIMIT 1), pe.id::text)::varchar,
         COALESCE((SELECT n.no FROM public.employee_no n
                    WHERE n.assigned_person_id = pe.id AND n.retired_at IS NULL
                    ORDER BY n.assigned_at DESC LIMIT 1), '')::varchar,
         pe.full_name::varchar,
         sc.work_date,
         (CASE WHEN sc.shift_id IS NULL THEN '临时班次'
               ELSE COALESCE(sd.code, '临时班次') END)::varchar,
         -- 排休没有段：左右两列留空，班次列写 REST —— 宽表里填「休息」
         to_char(sg.start_at AT TIME ZONE public.app_tz(), 'HH24:MI')::varchar,
         to_char(sg.end_at   AT TIME ZONE public.app_tz(), 'HH24:MI')::varchar
    FROM public.schedule sc
    JOIN public.person pe ON pe.id = sc.employee_id
    LEFT JOIN public.shift_def sd ON sd.shift_id = sc.shift_id
    LEFT JOIN public.org_unit o ON o.id = sc.store_id
    LEFT JOIN public.schedule_segment sg ON sg.schedule_id = sc.id
   WHERE sc.store_id = p_store
     AND sc.work_date >= p_from
     AND sc.work_date <  p_from + p_days
   ORDER BY o.name, pe.id, sc.work_date, sg.seq;
END;
$$;

COMMENT ON FUNCTION fn_roster_export IS
  '导出某店一段日期的排班（151）为**长表**：一行一段，排休一行、时段为空。'
  '列顺序照产品模板（部门 / 用户ID / 工号 / 姓名 / 日期 / 班次 / 起 / 止），'
  '由服务层 pivot 成宽表。临时班次（148 划线）的 shift_code 写「临时班次」——'
  '它导不回去，导出要让人一眼看见。';

-- ---------------------------------------------------------------------------
-- 5. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RB',
   '排班批量：复制不覆盖目标日、不带确认状态；导入部分成功且错行带行号；导出认得出临时班次',
   'ATTENDANCE','ALGORITHM','fn_roster_copy','public','schedule','TABLE',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
