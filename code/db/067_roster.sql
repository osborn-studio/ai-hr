-- ============================================================================
-- 067_roster.sql · 排班看板：拖拉划线、按班次上色
-- ----------------------------------------------------------------------------
-- 008 的 schedule / schedule_segment 是"段级"模型（一段一班、可跨店、带确认单），
-- 它适合算薪与确认，但**不适合排班时的操作手感**：店长要的是"一格一天"，
-- 拖着鼠标刷一片，而不是先建排班再拆段。
--
-- 所以这一层是**看板**，不是第二套工时口径：
--   roster_slot（人 × 日 × 班次）——排班的最小格；写入只到这一层。
--   它将来由作业折算成 schedule_segment（算薪仍读那条老链路），
--   在那之前它只是"这天这人上哪个班"的记录，**不参与工时计算**。
--   这条边界写在表注释里，因为它决定了"算薪出错时该看哪张表"。
-- ============================================================================

CREATE TABLE shift_def (
  code       varchar(16) PRIMARY KEY,
  name       varchar(32) NOT NULL,
  start_time time        NOT NULL,
  end_time   time        NOT NULL,
  -- 颜色是给人看的（区别班次靠颜色，不靠读文字）
  color      varchar(16) NOT NULL,
  is_rest    boolean     NOT NULL DEFAULT false,
  CONSTRAINT ck_sd_span CHECK (is_rest OR end_time > start_time OR end_time < start_time)
);

INSERT INTO shift_def(code,name,start_time,end_time,color,is_rest) VALUES
  ('EARLY','早班','08:00','16:00','#2563eb',false),
  ('MID',  '中班','11:00','19:00','#0ea5e9',false),
  ('LATE', '晚班','15:00','23:00','#7c3aed',false),
  ('CLOSE','闭店','17:00','01:00','#db2777',false),
  ('REST', '休息',  '00:00','00:00','#94a3b8',true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE roster_slot (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id bigint      NOT NULL REFERENCES person(id),
  store_id    bigint      NOT NULL REFERENCES org_unit(id),
  work_date   date        NOT NULL,
  shift_code  varchar(16) REFERENCES shift_def(code),
  updated_by  varchar(64) NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 一格一人一天只有一个班：两班并存等于"同一天两个工时"，而那是拆分不是排班
  CONSTRAINT uk_rs UNIQUE (employee_id, work_date)
);

COMMENT ON TABLE roster_slot IS
  '排班看板的最小格：人 × 日 × 班次。**不参与算薪** —— 工时仍由 '
  'schedule_segment → attendance_daily_store 那条链路算。这张表只回答"这天谁上哪个班"。';

-- 划线写入：一次刷一片，要么全成要么全不成
CREATE OR REPLACE FUNCTION fn_roster_paint(
  p_store bigint, p_dates date[], p_employees bigint[], p_shift varchar, p_by varchar
) RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_n int := 0; d date; e bigint;
BEGIN
  IF p_shift IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shift_def WHERE code = p_shift) THEN
    RAISE EXCEPTION 'E_ROSTER_SHIFT: 班次 % 不存在', p_shift;
  END IF;

  FOREACH d IN ARRAY p_dates LOOP
    FOREACH e IN ARRAY p_employees LOOP
      IF p_shift IS NULL THEN
        DELETE FROM public.roster_slot WHERE employee_id = e AND work_date = d;
        v_n := v_n + 1;
      ELSE
        INSERT INTO public.roster_slot(employee_id, store_id, work_date, shift_code, updated_by)
        VALUES (e, p_store, d, p_shift, p_by)
        ON CONFLICT (employee_id, work_date)
        DO UPDATE SET shift_code = EXCLUDED.shift_code, updated_by = EXCLUDED.updated_by,
                      updated_at = now();
        v_n := v_n + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$$;

/** 一周看板：人（行）× 日期（列）× 班次（颜色） */
CREATE OR REPLACE FUNCTION fn_roster_week(p_store bigint, p_from date)
RETURNS TABLE (employee_id bigint, employee_no varchar, full_name varchar,
               work_date date, shift_code varchar, color varchar, shift_name varchar)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, n.no, p.full_name, g.d::date, s.shift_code, sd.color, sd.name
    FROM generate_series(p_from, p_from + 6, interval '1 day') g(d)
    JOIN public.employment e ON daterange(e.hire_date, e.leave_date, '[]') @> g.d::date
    JOIN public.person p ON p.id = e.person_id
    JOIN public.employee_org_assignment a
      ON a.employee_id = p.id AND a.dim_code = 'attendance_org'
     AND daterange(a.valid_from, a.valid_to, '[]') @> g.d::date AND a.org_id = p_store
    LEFT JOIN public.employee_no n ON n.assigned_person_id = p.id AND n.retired_at IS NULL
    LEFT JOIN public.roster_slot s ON s.employee_id = p.id AND s.work_date = g.d::date
    LEFT JOIN public.shift_def sd ON sd.code = s.shift_code
   ORDER BY p.id, g.d;
END;
$$;

INSERT INTO sys_perm_resource(resource_code, label, temporal_basis) VALUES ('roster','排班','CURRENT')
ON CONFLICT (resource_code) DO NOTHING;
INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
SELECT r.id,'roster',true,true FROM sys_role r
 WHERE r.code IN ('legacy_group_hr','legacy_store_hr','legacy_role_4','admin','acct_admin','group_hr','hr_ops','store_mgr')
ON CONFLICT DO NOTHING;

INSERT INTO sys_check_registry
  (check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,
   guard_debt_owner,guard_debt_due,runner,assertion_sql) VALUES
  ('SUITE.RS','排班看板：一格一人一天、划线一次成型、看板不参与算薪',
   'ATTENDANCE','ALGORITHM','fn_roster_paint','public','roster_slot','FUNCTION',
   'team-lead','2027-03-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT DO NOTHING;
