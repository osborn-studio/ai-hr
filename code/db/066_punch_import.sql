-- ============================================================================
-- 066_punch_import.sql · 考勤机文件导入：先预览，再落库；错了不整批失败
-- ----------------------------------------------------------------------------
-- 客户手上一定有考勤机导出的文件（Excel/CSV）。人工录入不现实，
-- 而直接"整批导入或整批回滚"也不行：一个工号写错就全军覆没，
-- 然后人会去手工改 Excel 再导一遍，越改越乱。
--
-- 三条判断：
--   ① **先预览后落库**（p_dry）：先看"哪些行会进、哪些行跳过、为什么"，
--      再确认。直接落库的导入，第一件事就是导错一个月的数。
--   ② **逐行判定，不整批回滚**：匹配不到人的行**跳过并记原因**，其余照进。
--   ③ **幂等键 = 工号+时间+方向**：同一份文件导两次不会翻倍。
--      而考勤机文件通常没有唯一编号，"文件行号"换一份导出就变了。
--
-- 刻意不做：不导入"考勤结果"（工时）。考勤机的结算口径与本系统不同
-- （更期、用膳扣除、跨零点），只进原始打卡，工时仍由唯一链路折算。
-- ============================================================================

CREATE TABLE punch_import_batch (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file_name   varchar(200),
  total_rows  int NOT NULL,
  ok_rows     int NOT NULL,
  skip_rows   int NOT NULL,
  dup_rows    int NOT NULL,
  imported_by varchar(64) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_pib_n CHECK (total_rows = ok_rows + skip_rows + dup_rows)
);

COMMENT ON TABLE punch_import_batch IS
  '导入批次：总行数 = 成功 + 跳过 + 重复。等式不成立就说明统计写错了 —— '
  '"导了 500 行进来 480 行"没有批次记录时永远查不出少的那 20 行去哪了。';

CREATE OR REPLACE FUNCTION fn_punch_import(
  p_rows jsonb,                    -- [{emp_no, at, kind}] 三列，够用且是共同子集
  p_by   varchar,
  p_dry  boolean DEFAULT true,
  p_file varchar DEFAULT NULL
) RETURNS TABLE (row_no int, status varchar(8), reason varchar(40), employee_id bigint,
                 punch_id bigint, batch_id bigint)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r record; v_emp bigint; v_pid bigint; v_batch bigint;
  v_total int; v_ok int := 0; v_skip int := 0; v_dup int := 0; i int := 0;
BEGIN
  v_total := COALESCE(jsonb_array_length(p_rows), 0);
  IF v_total = 0 THEN
    RAISE EXCEPTION 'E_IMPORT_EMPTY: 文件里没有可导入的行';
  END IF;

  IF NOT p_dry THEN
    -- ★ 先落一行"全 0"的批次，循环结束后再回填计数。
    --   直接写 total_rows=未知、ok=0 会撞 ck_pib_n（总数 = 成功+跳过+重复），
    --   而那条约束是对的 —— 它保证"少掉的行"不会被悄悄忘掉。
    INSERT INTO public.punch_import_batch(file_name, total_rows, ok_rows, skip_rows, dup_rows, imported_by)
    VALUES (p_file, 0, 0, 0, 0, p_by) RETURNING id INTO v_batch;
  END IF;

  FOR r IN SELECT value AS j, ordinality AS n FROM jsonb_array_elements(p_rows) WITH ORDINALITY LOOP
    i := r.n;
    v_emp := NULL; v_pid := NULL;

    -- 工号匹配：匹配不到**不建人**。自动建人会造出一堆"未命名员工"，
    -- 而它们会随机出现在花名册和报表里，且没有人能解释它们从哪来。
    SELECT n.assigned_person_id INTO v_emp
      FROM public.employee_no n
     WHERE n.no = btrim(r.j->>'emp_no') AND n.retired_at IS NULL
     LIMIT 1;

    IF v_emp IS NULL THEN
      v_skip := v_skip + 1;
      RETURN QUERY SELECT i, 'skip'::varchar(8), 'employee_not_found'::varchar(40),
                          NULL::bigint, NULL::bigint, v_batch;
      CONTINUE;
    END IF;

    IF (r.j->>'kind') NOT IN ('in','out') OR (r.j->>'at') IS NULL THEN
      v_skip := v_skip + 1;
      RETURN QUERY SELECT i, 'skip'::varchar(8), 'bad_row'::varchar(40),
                          v_emp, NULL::bigint, v_batch;
      CONTINUE;
    END IF;

    -- 幂等键：工号 + 时间 + 方向。同一份文件重复导入不翻倍。
    IF EXISTS (SELECT 1 FROM public.punch p
                WHERE p.source = 'device'
                  AND p.ext_id = (r.j->>'emp_no') || '|' || (r.j->>'at') || '|' || (r.j->>'kind')) THEN
      v_dup := v_dup + 1;
      RETURN QUERY SELECT i, 'dup'::varchar(8), 'already_imported'::varchar(40),
                          v_emp, NULL::bigint, v_batch;
      CONTINUE;
    END IF;

    IF p_dry THEN
      v_ok := v_ok + 1;
      RETURN QUERY SELECT i, 'ok'::varchar(8), NULL::varchar(40), v_emp, NULL::bigint, NULL::bigint;
    ELSE
      INSERT INTO public.punch(employee_id, kind, source, punch_at, client_at, ext_id)
      VALUES (v_emp, r.j->>'kind', 'device', (r.j->>'at')::timestamptz, (r.j->>'at')::timestamptz,
              (r.j->>'emp_no') || '|' || (r.j->>'at') || '|' || (r.j->>'kind'))
      RETURNING id INTO v_pid;
      v_ok := v_ok + 1;
      RETURN QUERY SELECT i, 'ok'::varchar(8), NULL::varchar(40), v_emp, v_pid, v_batch;
    END IF;
  END LOOP;

  IF NOT p_dry THEN
    UPDATE public.punch_import_batch
       SET total_rows = v_total, ok_rows = v_ok, skip_rows = v_skip, dup_rows = v_dup
     WHERE id = v_batch;
  END IF;
END;
$$;

COMMENT ON FUNCTION fn_punch_import IS
  '考勤机文件导入：默认 p_dry=true 只预览。逐行判定、跳过的行带原因、'
  '幂等键 = 工号|时间|方向。只进原始打卡，不进工时 —— 工时口径只有一条链路。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.IM','考勤文件导入：预览不落库、错行不整批失败、重复导入不翻倍',
   'ATTENDANCE','ALGORITHM',
   'fn_punch_import','public','punch_import_batch','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
