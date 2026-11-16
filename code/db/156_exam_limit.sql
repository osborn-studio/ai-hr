-- ============================================================================
-- 156_exam_limit.sql · 考试的两个闸：限时、限次
-- ----------------------------------------------------------------------------
-- 147 把考试做出来了（判分在库、交卷不可改、答案不下发），但漏了两件——
-- 而这两件恰好决定"及格"这两个字有没有意义：
--
--   ① **次数没有上限**：不及格就一直重考，直到蒙过。而这张成绩是要给监管看的
--      （食品安全培训、特种作业复审），能刷分的及格线等于没有及格线。
--   ② **没有限时**：一道题想多久想多久，考的是"有没有空"，不是"会不会"。
--
-- 酷学院那套产品的原文口径是：答题倒计时 + 超时自动交卷 + 可配"允许考几次"，
-- 用完锁死。这一版按这个补，但有一处**刻意不同**：
--
-- ★ **超时不作废，只记录。**
--   到点自动判 0 分（或直接作废）看着很严，实际后果是"网断了、人去了趟洗手间"
--   这类事全都要人工申诉。而超时的本质是"这场考试的时限到了"，不是"这个人作弊"。
--   所以：超时仍然判分、仍然算一次机会，但 `late_seconds` 记下来，
--   由人决定这次算不算。**判据留给能负责的人，不留给定时器。**
--
-- ★ 次数用哪种口径：**只数已交卷的**。
--   开了没交（断线、走开）不该吃掉一次机会 —— 否则"网络不好"会变成"没资格考"。
--   但同一人同卷的**未交卷答卷不得超过 1 份**（147 已经是幂等的），
--   所以不会出现"攒 10 份没交的卷"。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 卷子上加两个数
-- ---------------------------------------------------------------------------
ALTER TABLE public.exam_paper ADD COLUMN IF NOT EXISTS duration_min int;
ALTER TABLE public.exam_paper ADD COLUMN IF NOT EXISTS max_attempts int;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ep_duration') THEN
    ALTER TABLE public.exam_paper ADD CONSTRAINT ck_ep_duration
      CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 600);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ck_ep_attempts') THEN
    ALTER TABLE public.exam_paper ADD CONSTRAINT ck_ep_attempts
      CHECK (max_attempts IS NULL OR max_attempts BETWEEN 1 AND 20);
  END IF;
END $$;

COMMENT ON COLUMN public.exam_paper.duration_min IS
  '限时（分钟）。NULL = 不限时。超时**不作废**：仍然判分，但 late_seconds 会被记下来。';
COMMENT ON COLUMN public.exam_paper.max_attempts IS
  '允许考几次。NULL = 不限。**只数已交卷的** —— 开了没交不该吃掉一次机会。';

-- 答卷上记超时与尝试序号（序号让"第几次考"能直接看，不用 count）
ALTER TABLE public.exam_attempt ADD COLUMN IF NOT EXISTS deadline_at timestamptz;
ALTER TABLE public.exam_attempt ADD COLUMN IF NOT EXISTS late_seconds int;

COMMENT ON COLUMN public.exam_attempt.deadline_at IS
  '本份卷的截止时刻（= started_at + duration_min）。库端算，不由前端倒计时决定 ——'
  '否则改本地时间就能多考半小时。';
COMMENT ON COLUMN public.exam_attempt.late_seconds IS
  '超时秒数。NULL = 没超时或没限时；> 0 = 超了多久。判分照常，算不算由人定。';

-- ---------------------------------------------------------------------------
-- 2. 开考：算截止时刻 + 卡次数
-- ---------------------------------------------------------------------------
-- 用触发器而不是改 fn_exam_start：147 那个函数里有"同人同卷已有未交则幂等返回"
-- 的分支，整段重抄一遍容易把那个分支抄掉。这里只在 INSERT 的瞬间补两个动作。
CREATE OR REPLACE FUNCTION fn_exam_attempt_prepare() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  p        record;
  v_done   int;
BEGIN
  SELECT * INTO p FROM public.exam_paper WHERE id = NEW.paper_id;
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'E_EXAM_NO_PAPER: 试卷 % 不存在', NEW.paper_id;
  END IF;

  -- 次数：只数已交卷的
  IF p.max_attempts IS NOT NULL THEN
    SELECT count(*)::int INTO v_done
      FROM public.exam_attempt a
     WHERE a.paper_id = NEW.paper_id
       AND a.employee_id = NEW.employee_id
       AND a.submitted_at IS NOT NULL;
    IF v_done >= p.max_attempts THEN
      RAISE EXCEPTION 'E_EXAM_NO_ATTEMPT_LEFT: 《%》只能考 % 次，已经考过 % 次（已用完）',
        p.name, p.max_attempts, v_done;
    END IF;
  END IF;

  -- 截止时刻：库端算，前端只负责显示
  IF p.duration_min IS NOT NULL AND NEW.deadline_at IS NULL THEN
    NEW.deadline_at := COALESCE(NEW.started_at, now()) + make_interval(mins => p.duration_min);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_exam_attempt_prepare IS
  '开考时补两件事：算截止时刻、卡次数（只数已交卷的）。'
  '不改 fn_exam_start 是为了不碰它里面"同人同卷未交则幂等"的分支。';

DROP TRIGGER IF EXISTS trg_exam_attempt_prepare ON public.exam_attempt;
CREATE TRIGGER trg_exam_attempt_prepare
  BEFORE INSERT ON public.exam_attempt
  FOR EACH ROW EXECUTE FUNCTION fn_exam_attempt_prepare();

-- ---------------------------------------------------------------------------
-- 3. 交卷：记超时，但不拦
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_exam_attempt_stamp_late() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.submitted_at IS NOT NULL AND OLD.submitted_at IS NULL
     AND NEW.deadline_at IS NOT NULL THEN
    NEW.late_seconds := GREATEST(
      ROUND(EXTRACT(epoch FROM (NEW.submitted_at - NEW.deadline_at)))::int, 0);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_exam_attempt_late ON public.exam_attempt;
CREATE TRIGGER trg_exam_attempt_late
  BEFORE UPDATE ON public.exam_attempt
  FOR EACH ROW EXECUTE FUNCTION fn_exam_attempt_stamp_late();

COMMENT ON FUNCTION fn_exam_attempt_stamp_late IS
  '交卷时记超时秒数。**不拦**：超时仍然判分、仍然算一次机会 ——'
  '作废的后果是"网断了"这类事全要人工申诉，而超时的本质是时限到了，不是作弊。';

-- ---------------------------------------------------------------------------
-- 4. 一个人的考试台账（页面要能回答"他还剩几次、上次考了多少"）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_exam_ledger(p_paper bigint, p_employee bigint)
RETURNS TABLE (
  paper_id bigint, paper_name varchar(96), pass_score numeric, max_attempts int,
  used int, left_attempts int, best_score numeric, passed boolean,
  last_submitted timestamptz, last_late_seconds int
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT p.id, p.name, p.pass_score, p.max_attempts,
         (SELECT count(*)::int FROM public.exam_attempt a
           WHERE a.paper_id = p.id AND a.employee_id = p_employee
             AND a.submitted_at IS NOT NULL) AS used,
         CASE WHEN p.max_attempts IS NULL THEN NULL
              ELSE GREATEST(p.max_attempts
                - (SELECT count(*)::int FROM public.exam_attempt a
                    WHERE a.paper_id = p.id AND a.employee_id = p_employee
                      AND a.submitted_at IS NOT NULL), 0) END AS left_attempts,
         (SELECT max(a.score) FROM public.exam_attempt a
           WHERE a.paper_id = p.id AND a.employee_id = p_employee
             AND a.submitted_at IS NOT NULL) AS best_score,
         EXISTS (SELECT 1 FROM public.exam_attempt a
                  WHERE a.paper_id = p.id AND a.employee_id = p_employee AND a.passed) AS passed,
         (SELECT max(a.submitted_at) FROM public.exam_attempt a
           WHERE a.paper_id = p.id AND a.employee_id = p_employee) AS last_submitted,
         (SELECT a.late_seconds FROM public.exam_attempt a
           WHERE a.paper_id = p.id AND a.employee_id = p_employee
             AND a.submitted_at IS NOT NULL
           ORDER BY a.submitted_at DESC LIMIT 1) AS last_late_seconds
    FROM public.exam_paper p
   WHERE p.id = p_paper;
$$;

COMMENT ON FUNCTION fn_exam_ledger IS
  '某人某卷的考试台账：已用几次 / 还剩几次 / 最高分 / 是否已通过 / 上次交卷与超时。'
  '"还剩几次"是页面要直接显示的数 —— 让人考到一半才发现没机会了，比不让他考更糟。';

-- ---------------------------------------------------------------------------
-- 5. 判据组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.EXAML','考试限次与限时：次数只用已交卷的算、用完锁死、超时只记不拦',
   'ORG','ALGORITHM','fn_exam_attempt_prepare','public','exam_attempt','TABLE',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-EXAML','考试限次与限时的接口接线：台账能先查、开考回报截止时刻与第几次',
   'ORG','ALGORITHM','fn_exam_ledger','public','exam_attempt','TABLE',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
