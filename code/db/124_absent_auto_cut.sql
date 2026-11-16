-- ============================================================================
-- 124_absent_auto_cut.sql · 调整出勤后，旷工要跟着冲减
-- ----------------------------------------------------------------------------
-- 真跑演示时撞上的：把某人出勤从 1 天调到 21 天（补录漏打卡），
-- 旷工那一列还留着生成时算的 20 天 —— 于是"出勤 21 + 旷工 20 > 应出勤 21"。
-- 它不报错、不越界，只是两个数字互相矛盾；而这张表是要拿去发钱的。
--
-- 修法：调 present_days / leave_days 后，若三者之和超过应出勤，
-- 旷工按平衡值冲减，并单独留一条 __auto__ 痕迹（谁都能看出"这条不是人改的"）。
--
-- ★ 只减不增：把出勤改小不自动抬高旷工 —— 那等于系统替 HR 定性"他没来"。
--   要扣旷工请显式改 absent_days 并写原因。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_att_period_set(
  p_report bigint, p_field varchar, p_value numeric, p_reason varchar, p_by varchar)
RETURNS numeric
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  r public.att_period_report%ROWTYPE;
  v_before numeric(10,2);
  v_new_absent numeric(6,2);
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

  -- ★ 出勤/请假增加后，旷工要跟着冲减。
  --   不冲减就会出现"出勤 21 + 旷工 20 > 应出勤 21"这种自相矛盾的行，
  --   而它不报错 —— 只是数字对不上。HR 拿着这张表发钱，谁也不知道哪个是真的。
  --   只**减不增**：把出勤改小不该自动抬高旷工（那等于系统替 HR 定性"他没来"）。
  IF p_field IN ('present_days','leave_days') THEN
    SELECT * INTO r FROM public.att_period_report WHERE id = p_report;
    IF r.present_days + r.leave_days + r.absent_days > r.work_days THEN
      v_new_absent := GREATEST(r.work_days - r.present_days - r.leave_days, 0);
      IF v_new_absent < r.absent_days THEN
        UPDATE public.att_period_report
           SET absent_days = v_new_absent, updated_at = now() WHERE id = p_report;
        INSERT INTO public.att_period_adjust(report_id, field_name, before_value, after_value,
                                            reason, adjusted_by)
        VALUES (p_report, 'absent_days', r.absent_days, v_new_absent,
                '__auto__ 随出勤/请假调整冲减旷工（' || left(v_reason, 120) || '）', p_by);
      END IF;
    END IF;
  END IF;

  -- 每次调整留一版。会比较多（每人每字段一次），但这正是"可追溯"的代价：
  -- 合并版本会让"改了三次"变成"改了一次"，而 HR 复盘时最需要知道的就是改了几次。
  PERFORM public.fn_att_period_version_write(r.period, r.legal_entity_id, 'manual', p_by,
            p_field || ' ' || COALESCE(v_before::text,'-') || ' → ' || p_value::text);

  RETURN p_value;
END;
$$;

;

;
