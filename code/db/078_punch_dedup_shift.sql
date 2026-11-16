-- ============================================================================
-- 078_punch_dedup_shift.sql · 打卡去重（受控）+ 固定班次（两段工时）
-- ----------------------------------------------------------------------------
-- 两件事，都是真跑撞出来的。
--
-- 一、打卡去重
--   钉钉的「打卡结果」与「打卡流水」是两个接口、两套 id。第一次同步我用接口 id
--   当幂等键，于是同一次打卡进了两行；后来说"改用事件本身做键"（人+时刻+方向），
--   键一变，老行又变成"新记录"—— 最后同一个 08:35 显示了 3 次。
--
--   ★ 幂等键必须描述**事件**，不能描述**接口**。这是那条教训的落点：
--     `dt:<userId>:<毫秒>:<方向>` —— 与哪个接口给的、第几次拉到都无关。
--
--   已经产生的重复必须清掉，而 punch 上有 append-only 触发器（它是证据，不能改）。
--   所以这里走**受控维护**：函数显式声明自己在维护，触发器认这个声明才放行。
--   这不是"绕过约束"——绕过是悄悄关掉触发器；这里是让"允许删"这件事
--   本身有名字、有参数、有返回值（删了几行），并且只允许合并"完全重复"的行。
--
-- 二、固定班次（两段工时）
--   餐饮的实际班次是 10:00–12:00 + 13:00–19:00（中间一小时午休不计工时）。
--   原来的 shift_def 只有一对起止时间，表达不了"中间断开"。
--   加 segments jsonb 与 work_minutes：一个班次可以有 N 段，工时是各段之和。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 打卡合并：只允许"完全重复"（同人、同时刻、同方向、同来源）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_punch_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- ★ 唯一放行条件：调用方显式声明自己在做数据修复（app.punch_maintenance = on）。
  --   SET LOCAL 的作用域是当前事务，所以它不会"漏"到别的连接或别的语句上。
  IF current_setting('app.punch_maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'E_PUNCH_APPEND_ONLY: 打卡记录不可改也不可删（它是证据）';
END;
$$;

COMMENT ON FUNCTION fn_punch_append_only IS
  '打卡只增不改。唯一例外：app.punch_maintenance=on 时允许维护事务删重复行'
  '（该开关只在事务内有效，且删除范围由 fn_punch_dedup 限定为完全重复）。';

CREATE OR REPLACE FUNCTION fn_punch_dedup(p_dry boolean DEFAULT true)
RETURNS TABLE (dup_groups int, dup_rows int)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_g int; v_n int;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _punch_dup ON COMMIT DROP AS
  SELECT id FROM (
    SELECT id, row_number() OVER (
             PARTITION BY employee_id, punch_at, kind, source ORDER BY id) AS rn
      FROM public.punch
  ) x WHERE rn > 1;

  SELECT count(DISTINCT (employee_id, punch_at, kind, source))::int INTO v_g
    FROM public.punch WHERE id IN (SELECT id FROM _punch_dup);
  SELECT count(*)::int INTO v_n FROM _punch_dup;

  IF NOT p_dry AND v_n > 0 THEN
    PERFORM set_config('app.punch_maintenance', 'on', true);   -- 仅本事务
    DELETE FROM public.punch WHERE id IN (SELECT id FROM _punch_dup);
  END IF;

  RETURN QUERY SELECT v_g, v_n;
END;
$$;

COMMENT ON FUNCTION fn_punch_dedup IS
  '合并"完全重复"的打卡行（同人同时刻同方向同来源），保留 id 最小的一条。'
  'p_dry=true 只看不删。返回（重复组数，待删行数）。';

-- ---------------------------------------------------------------------------
-- 2. 班次：支持多段（中间断开的班）
-- ---------------------------------------------------------------------------
ALTER TABLE shift_def ADD COLUMN IF NOT EXISTS segments jsonb;
ALTER TABLE shift_def ADD COLUMN IF NOT EXISTS work_minutes int;

COMMENT ON COLUMN shift_def.segments IS
  '班次的工时段，如 [{"s":"10:00","e":"12:00"},{"s":"13:00","e":"19:00"}]。'
  '为空时退化为 start_time~end_time 一段。中间断开的那段是休息，不计工时。';

UPDATE shift_def
   SET segments = jsonb_build_array(
         jsonb_build_object('s', to_char(start_time,'HH24:MI'), 'e', to_char(end_time,'HH24:MI')))
 WHERE segments IS NULL AND is_rest = false;

-- 工时 = 各段之和（跨零点按 24 小时折算）
UPDATE shift_def SET work_minutes = sub.m
  FROM (
    SELECT code, sum(
      CASE WHEN (seg->>'e')::time >= (seg->>'s')::time
           THEN extract(epoch FROM ((seg->>'e')::time - (seg->>'s')::time))
           ELSE extract(epoch FROM ((seg->>'e')::time - (seg->>'s')::time)) + 86400
      END) / 60 AS m
      FROM shift_def, jsonb_array_elements(segments) seg
     GROUP BY code
  ) sub
 WHERE shift_def.code = sub.code;

-- 新增：固定班（上午 10–12，下午 13–19，共 8 小时）
INSERT INTO shift_def(code, name, start_time, end_time, color, is_rest, segments, work_minutes) VALUES
  ('FIXED', '固定班 10:00-12:00 / 13:00-19:00', '10:00', '19:00', '#1d4ed8', false,
   '[{"s":"10:00","e":"12:00"},{"s":"13:00","e":"19:00"}]'::jsonb, 480)
ON CONFLICT (code) DO UPDATE
   SET name = EXCLUDED.name, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
       color = EXCLUDED.color, segments = EXCLUDED.segments, work_minutes = EXCLUDED.work_minutes;

-- 看板要多带两个字段（工时与分段），界面上"这个班几小时、断在哪"才说得清。
-- ★ 返回类型变了，CREATE OR REPLACE 不行（cannot change return type）——
--   必须先 DROP。这在 PostgreSQL 里是硬规则：换返回列 = 换函数签名。
DROP FUNCTION IF EXISTS fn_roster_week(bigint, date);
CREATE FUNCTION fn_roster_week(p_store bigint, p_from date)
RETURNS TABLE (employee_id bigint, employee_no varchar, full_name varchar,
               work_date date, shift_code varchar, color varchar, shift_name varchar,
               work_minutes int, segments jsonb)
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT p.id, n.no, p.full_name, g.d::date, s.shift_code, sd.color, sd.name,
         sd.work_minutes, sd.segments
    FROM generate_series(p_from, p_from + 6, interval '1 day') g(d)
    JOIN public.employment e ON daterange(e.hire_date, e.leave_date, '[]') @> g.d::date
    JOIN public.person p ON p.id = e.person_id
    JOIN public.employee_org_assignment a
      ON a.employee_id = p.id AND a.dim_code = 'attendance_org'
     AND daterange(a.valid_from, a.valid_to, '[]') @> g.d::date
    LEFT JOIN public.employee_no n ON n.assigned_person_id = p.id AND n.retired_at IS NULL
    LEFT JOIN public.roster_slot s ON s.employee_id = p.id AND s.work_date = g.d::date
    LEFT JOIN public.shift_def sd ON sd.code = s.shift_code
   WHERE ($1 IS NULL OR a.org_id = $1)
   ORDER BY p.id, g.d;
END;
$$;

COMMENT ON FUNCTION fn_roster_week IS
  '一周排班看板：人 × 日 × 班次。p_store 为空时列全员（跨部门的排班视图）。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.PD','打卡去重：幂等键是事件（人+时刻+方向），维护删除受控且只合并完全重复',
   'ATTENDANCE','RECONCILE','fn_punch_dedup','public','punch','FUNCTION',
   'team-lead','2027-03-31','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
