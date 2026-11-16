-- ============================================================================
-- 158_perf_scorer.sql · 绩效结果：谁打的分 / 改分台账 / 强制分布补 0 人档
-- ----------------------------------------------------------------------------
-- 026 建了 perf_result，051 补了打分入口。这一版补的是**打分这件事本身的痕迹**，
-- 以及一条把"没人"和"没这一档"分开的报告。
--
-- 两个真缺陷：
--
-- ① **`perf_result` 没有评分人。**
--    fn_perf_score 收了 p_by，函数体里一次都没用。于是：
--      · 页面上答不出"这个分是谁给的"；
--      · 改分之后也答不出"上一版是谁给的"——因为上一版根本不存在。
--    绩效分数是要拿去定系数、定钱的东西，**它必须有一个签字的人**。
--
-- ② **改分是静默覆盖。**
--    `ON CONFLICT ... DO UPDATE SET score = EXCLUDED.score` —— 78 改成 88，
--    旧值就没了。而"这个分被改过"本身就是一个需要能回答的事实：
--    它决定了复盘时看的是原始判断，还是被协调过的结果。
--
-- 三条决定，都写在下面各节开头，这里先说最要紧的一条：
--
-- ★ **台账由触发器写，不由服务层写。**
--   服务层写意味着"绕过服务层就没有日志"，而绩效分数恰恰是有人最想绕过
--   服务层去改的东西（封存前的最后一天、发钱前的最后一个人）。
--   放在 BEFORE UPDATE 里，任何一条 UPDATE 语句都躲不开它 ——
--   包括 psql、包括将来的另一个服务、包括忘了调函数的那个新接口。
--
-- ★ 一个**刻意不做**的事：不给存量行补 scored_by。
--   补出来的人名一定是编的（"system" / "migration"），而编出来的签字
--   比空白更坏：它把一个"不知道谁评的"伪装成"有人负责"。查询里它就显示 NULL，
--   一眼能看出"这条是旧数据"。
--
-- ★ 另一个刻意不做的事：**不拦改分**，只留痕。
--   026 已经把"封存后不许改"做成了硬拦（那是钱发出去之后的事）；
--   封存前的改分是正常流程（复核、校准会），拦了只会让人去绕开系统。
--   要拦的是"改了没人知道"，不是"改了"。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. perf_result 加列：签字（scored_by / scored_at）与版本（version）
-- ---------------------------------------------------------------------------
-- ★ 不加 `scored_at` 与 `score` 同生同灭的 CHECK：存量数据（026 时代与种子
--   直接 INSERT 的那些行）没有 scored_at，加上去整表过不去。
--   改成"新写入必须两列都填"的触发器，见第 2 节 —— 存量的豁免要**写明白**，
--   而不是把约束降级成一句注释。
ALTER TABLE perf_result ADD COLUMN IF NOT EXISTS scored_by varchar(64);
ALTER TABLE perf_result ADD COLUMN IF NOT EXISTS scored_at timestamptz;
-- 版本：1 = 第一次评；每改一次 +1。由触发器维护，不由调用方传。
ALTER TABLE perf_result ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;

COMMENT ON COLUMN perf_result.scored_by IS
  '最后一版分数的评分人（账号 id，文本形，与 sealed_by 同一种存法）。'
  '存量行为 NULL —— 那是"不知道谁评的"，不是"系统评的"。';
COMMENT ON COLUMN perf_result.scored_at IS
  '最后一版分数的打分时刻。与 scored_by 同时写，见 trg_pr_scorer。';
COMMENT ON COLUMN perf_result.version IS
  '分数版本：1 = 首评，每改一次 +1（由 trg_pr_log 维护）。'
  '页面上的"改过 N 次"就是 version - 1，与台账条数对得上。';

-- ---------------------------------------------------------------------------
-- 2. 有分就得有人：改分只能从打分入口进来，且必须重新签字
-- ---------------------------------------------------------------------------
-- 三条规则，为什么是这三条而不是"一律非空"：
--
--   ① **改分只能从打分入口进来**（UPDATE 且分数变了）。
--      这是本文件要防的那件事：绕过 fn_perf_score 直接 UPDATE 一行分数。
--      只判"两列非空"不够 —— 直接 UPDATE 会**继承旧值**，于是台账上
--      写着"上一版的人又改了一次"，而真正改的人没留下任何痕迹：
--      那是一条由数据库自己伪造的签名，比没有签名坏得多。
--
--      判据是会话里的一次性标记：fn_perf_score / fn_perf_exclude 在写之前
--      `set_config('aihr.perf_scoring','1',true)`，写完清掉。改分时标记不在
--      → 不是从入口来的 → 拒。
--      （为什么不用"scored_at 有没有刷新"来判断：两次打分可能落在同一个
--      微秒里 —— 本仓的测试就是这么打的 —— 于是第二次会被自己的判据误拒。
--      时间戳能说明"什么时候"，说明不了"从哪来"。）
--
--      代价说清楚：这只挡得住"手滑 / 顺手改 SQL"，挡不住刻意连标记一起伪造的
--      人。要挡住那个，得收掉表的 UPDATE 权限 —— 那是权限模型的事。
--
--   ② **只写一半 = 拒**（只有 scored_by 没有 scored_at，或反过来），
--      以及改分时两列仍为空（入口被调用但没传人）。半行签字是无意义的：
--      它看起来像有人负责，却说不出什么时候。
--
--   ③ **两列都为空 = 放行**（只在 INSERT 上）。
--      这一条是给**存量路径**留的：026 的种子、测试夹具、历史数据导入
--      都是"直接 INSERT 一行有分数的结果"。一律非空会让本仓的
--      app/server.mjs 种子在建库时就炸，而那条路不许改（也不该改：
--      它要证明的是"系统能从零建起来"）。
--      代价是看得见的：这类行在查询里 scored_by 明确为 NULL，
--      页面上就是"未记录评分人"，不会伪装成有人签过字。
CREATE OR REPLACE FUNCTION fn_pr_scorer_required() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.score IS NULL THEN
    RETURN NEW;                       -- 排除/未评：没有分，也就没有评分人
  END IF;

  -- ② 半行签字
  IF (NEW.scored_by IS NULL) <> (NEW.scored_at IS NULL) THEN
    RAISE EXCEPTION 'E_PERF_NO_SCORER: 分数 % 只写了 % —— scored_by 与 scored_at 必须一起写',
      NEW.score,
      CASE WHEN NEW.scored_by IS NULL THEN 'scored_at' ELSE 'scored_by' END;
  END IF;

  -- ① 改分只能从打分入口进来
  IF TG_OP = 'UPDATE' AND NEW.score IS DISTINCT FROM OLD.score THEN
    IF coalesce(current_setting('aihr.perf_scoring', true), '') <> '1' THEN
      RAISE EXCEPTION 'E_PERF_NO_SCORER: 改分（% → %）不是从打分入口来的 —— '
        '直接 UPDATE 改分会继承上一版的签字，台账上就变成"上一个人改的"；'
        '请走 fn_perf_score', OLD.score, NEW.score;
    END IF;
    IF NEW.scored_by IS NULL OR NEW.scored_at IS NULL THEN
      RAISE EXCEPTION 'E_PERF_NO_SCORER: 改分（% → %）没有写评分人与时间 —— '
        '没人签字的改分不该进库', OLD.score, NEW.score;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION fn_pr_scorer_required IS
  '改分只能从 fn_perf_score / fn_perf_exclude 进来（会话标记 aihr.perf_scoring），'
  '且必须重新签字；只写一半直接拒；INSERT 时两列全空放行（存量/种子路径，'
  '那种行在报表上显示"未记录评分人"，不编名字）。';

DROP TRIGGER IF EXISTS trg_pr_scorer ON perf_result;
CREATE TRIGGER trg_pr_scorer
  BEFORE INSERT OR UPDATE ON perf_result
  FOR EACH ROW EXECUTE FUNCTION fn_pr_scorer_required();

-- ---------------------------------------------------------------------------
-- 3. 改分台账 perf_result_log（append-only）
-- ---------------------------------------------------------------------------
-- 一行 = 一次改分。`version` 与 perf_result.version 同一把尺子：
-- 日志里的 version 一定是 2 起（1 是首评，没有"改"，所以没有日志）。
--
-- ★ 唯一键 (cycle_id, employee_id, version) 不是装饰：
--   它保证"改过 N 次"这件事不会有两个答案（台账条数 / version - 1），
--   也挡住并发两次改分写出两个同版本的行 —— 那两个行会让"哪一版是真的"
--   重新变成一个问题。
CREATE TABLE IF NOT EXISTS perf_result_log (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cycle_id    bigint      NOT NULL REFERENCES perf_cycle(id),
  employee_id bigint      NOT NULL,
  version     int         NOT NULL,
  old_score   numeric(5,2),
  new_score   numeric(5,2),
  old_grade   varchar(8),
  new_grade   varchar(8),
  -- 改分那一刻的备注（改分时若没写备注，记的是这一版留下的那条）
  note        varchar(200),
  changed_by  varchar(64),
  changed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uk_prl UNIQUE (cycle_id, employee_id, version),
  -- version 1 是首评，首评没有"改"，所以台账里不该出现 1
  CONSTRAINT ck_prl_version CHECK (version >= 2),
  -- 没有变化的"改分"不是台账行：那会让台账变长而信息量为零
  CONSTRAINT ck_prl_change CHECK (
    old_score IS DISTINCT FROM new_score OR old_grade IS DISTINCT FROM new_grade)
);

COMMENT ON TABLE perf_result_log IS
  '绩效改分台账：一行一次改分，只增不改。由 trg_pr_log 自动写 —— '
  '不由服务层写，因为服务层可以被绕过，而绩效分是最想被绕过的那一类数。';

-- 只增不改：UPDATE / DELETE 一律拒（与 032 的审批日志、041 的例外日志同一形态）
CREATE OR REPLACE FUNCTION fn_prl_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'E_PERF_LOG_APPEND_ONLY: 绩效改分台账只增不改（% 被拒）—— '
    '改台账等于改历史，要更正请再记一版', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_prl_append_only ON perf_result_log;
CREATE TRIGGER trg_prl_append_only
  BEFORE UPDATE OR DELETE ON perf_result_log
  FOR EACH ROW EXECUTE FUNCTION fn_prl_append_only();

-- ---------------------------------------------------------------------------
-- 4. 改分时自动记账 + 版本 +1
-- ---------------------------------------------------------------------------
-- ★ 为什么不是"函数里调一句 insert"：见文件头。这里的位置保证了
--   任何一条 UPDATE perf_result 都躲不开 —— 包括直接写 SQL 的那种。
--
-- ★ changed_by 的取值顺序：这一版写的评分人 → 上一版的人 → 数据库账号。
--   最后那个兜底不是"另一个署名"，它字面就是 current_user（psql 里是 postgres）：
--   报表上看到它就等于"这一版不是从打分入口改的"，这比留空更有用。
--
-- ★ 触发器顺序：trg_pr_frozen（026）在字母序上排在本触发器之前，
--   所以封存后的改分先在 026 那里被拒，**不会留下一条"改了但没生效"的台账**。
CREATE OR REPLACE FUNCTION fn_pr_log_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_by varchar(64);
BEGIN
  -- 分数与档位都没变（封存固化 factor、补备注、数据修补）→ 不是改分，不记账
  IF NEW.score IS NOT DISTINCT FROM OLD.score
     AND NEW.grade IS NOT DISTINCT FROM OLD.grade THEN
    RETURN NEW;
  END IF;

  v_by := COALESCE(NULLIF(btrim(NEW.scored_by), ''),
                   NULLIF(btrim(OLD.scored_by), ''),
                   current_user);

  NEW.version := COALESCE(OLD.version, 1) + 1;

  INSERT INTO public.perf_result_log(
    cycle_id, employee_id, version,
    old_score, new_score, old_grade, new_grade,
    note, changed_by, changed_at)
  VALUES (OLD.cycle_id, OLD.employee_id, NEW.version,
          OLD.score, NEW.score, OLD.grade, NEW.grade,
          NEW.note, v_by, clock_timestamp());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pr_log ON perf_result;
CREATE TRIGGER trg_pr_log
  BEFORE UPDATE ON perf_result
  FOR EACH ROW EXECUTE FUNCTION fn_pr_log_change();

-- ---------------------------------------------------------------------------
-- 5. 打分 / 排除：从 050 原文复制，只加 scored_by / scored_at / version
-- ----------------------------------------------------------------------------
-- ★ 下面两个函数是 050_perf_scoring.sql 的**原文复制**，只动了这几行：
--     · fn_perf_score   INSERT 的列与值：+ scored_by / scored_at / version
--     · fn_perf_score   ON CONFLICT 的 SET：+ scored_by / scored_at
--     · fn_perf_score   写之前 / 之后：入口标记 aihr.perf_scoring 置位与清位
--     · fn_perf_exclude INSERT 的值：+ scored_by / scored_at
--     · fn_perf_exclude ON CONFLICT 的 SET：+ scored_by / scored_at
--     · fn_perf_exclude 写之前 / 之后：同上两行标记
--   其余一字未动 —— 包括那句看起来多余的
--   `WHERE state <> 'excluded' OR state = 'excluded'`。它确实等价于恒真，
--   但它不是这一版要改的东西，顺手"清理"会让 diff 看不出真正的改动在哪。
--
-- ★ version 在 INSERT 里显式写 1、在 UPDATE 里**不写**：
--   改了分由 trg_pr_log 加 1。两处都加就会加两次。
--
-- ★ 写之前置一个会话标记 `aihr.perf_scoring`：trg_pr_scorer 用它判断
--   "这次改分是不是从入口来的"。没有这个标记，直接 UPDATE 一行分数
--   会继承上一版的签字，台账上就变成"上一个人改的"（见第 2 节）。
--   标记是事务局部的，函数返回即失效；函数里抛错时事务本身也回滚。
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

  -- 入口标记：只在这一句 UPDATE/INSERT 期间有效（trg_pr_scorer 读它）
  PERFORM set_config('aihr.perf_scoring', '1', true);

  INSERT INTO public.perf_result(
           cycle_id, employee_id, state, score, grade, note,
           scored_by, scored_at, version)
  VALUES (p_cycle, p_employee, 'scored', p_score, v_grade, nullif(btrim(p_note), ''),
          nullif(btrim(p_by), ''), clock_timestamp(), 1)
  ON CONFLICT (cycle_id, employee_id) DO UPDATE
     SET state = 'scored', score = EXCLUDED.score, grade = EXCLUDED.grade,
         note = EXCLUDED.note,
         scored_by = EXCLUDED.scored_by, scored_at = EXCLUDED.scored_at
   WHERE public.perf_result.state <> 'excluded'
      OR public.perf_result.state = 'excluded';   -- 排除之后仍可改回"已评"

  PERFORM set_config('aihr.perf_scoring', '', true);

  -- ★ 回传 factor 只是**预告**，不是写入：factor 由 fn_perf_seal 固化，
  --   提前写会让 ck_pr_factor_pre 之外的路径也产生值 —— 那正是
  --   "系数在分数之前就定了"的形态。这里 RETURN 的 factor 只用于界面提示。
  RETURN QUERY SELECT v_grade, v_factor;
END;
$$;

COMMENT ON FUNCTION fn_perf_score IS
  '打分即定档（分数 → 档位），系数**不写**（由 fn_perf_seal 固化）。'
  '封存后调用会得到有名字的 E_PERF_SEALED，而不是触发器给的"不能改"。'
  '158 起同时写 scored_by / scored_at；改分由 trg_pr_log 记台账并 version+1。';

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

  -- ★ 排除也是一种判断，也要有人签字：scored_by 记的是"判他不参与"的人。
  --   这一行没有分数，所以在台账里它是 88 → NULL 那一条 —— 「谁把他划掉的」
  --   与「谁把分改回来的」同样要能回答。
  -- 入口标记：只在这一句 INSERT/UPDATE 期间有效（trg_pr_scorer 读它）
  PERFORM set_config('aihr.perf_scoring', '1', true);

  INSERT INTO public.perf_result(
           cycle_id, employee_id, state, score, grade, note,
           scored_by, scored_at, version)
  VALUES (p_cycle, p_employee, 'excluded', NULL, NULL, btrim(p_note),
          nullif(btrim(p_by), ''), clock_timestamp(), 1)
  ON CONFLICT (cycle_id, employee_id) DO UPDATE
     SET state = 'excluded', score = NULL, grade = NULL, note = EXCLUDED.note,
         scored_by = EXCLUDED.scored_by, scored_at = EXCLUDED.scored_at;

  PERFORM set_config('aihr.perf_scoring', '', true);
END;
$$;

COMMENT ON FUNCTION fn_perf_exclude IS
  '不参与考核，必须写原因。158 起同时记 scored_by / scored_at —— '
  '排除也是一种判断，同样要能回答"是谁判的"。';

-- ---------------------------------------------------------------------------
-- 6. 查询：本期结果（带评分人与改过几次）/ 某个人的改分史
-- ---------------------------------------------------------------------------
-- ★ changed_count 从台账数（不是我猜的 version-1）：两个数应当相等，
--   不相等本身就是信息（有人动过表 / 台账被截断），页面上看见差异才会有人查。
--   version 由触发器维护、changed_count 由台账行数算 —— 两条独立来源，
--   刚好互为对照。
CREATE OR REPLACE FUNCTION fn_perf_result_of(p_cycle bigint)
RETURNS TABLE (
  employee_id     bigint,
  full_name       varchar(64),
  state           varchar(16),
  score           numeric(5,2),
  grade           varchar(8),
  note            varchar(200),
  scored_by       varchar(64),
  scored_by_name  varchar(64),
  scored_at       timestamptz,
  version         int,
  changed_count   int
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT r.employee_id,
         p.full_name,
         r.state, r.score, r.grade, r.note,
         r.scored_by,
         -- 名字取不到就回 id 原文：回 NULL 会让"账号被删"与"没评分人"同形
         COALESCE(NULLIF(a.display_name, ''), r.scored_by) AS scored_by_name,
         r.scored_at,
         COALESCE(r.version, 1) AS version,
         (SELECT count(*)::int FROM public.perf_result_log l
           WHERE l.cycle_id = r.cycle_id AND l.employee_id = r.employee_id) AS changed_count
    FROM public.perf_result r
    LEFT JOIN public.person p ON p.id = r.employee_id
    LEFT JOIN public.sys_account a ON a.id::text = btrim(r.scored_by)
   WHERE r.cycle_id = p_cycle
   ORDER BY r.employee_id;
$$;

COMMENT ON FUNCTION fn_perf_result_of IS
  '某一期的全部结果，带评分人（scored_by / scored_by_name / scored_at）与'
  '改过几次（version / changed_count）。存量行的 scored_by 为 NULL —— '
  '显示"未记录评分人"，不编一个名字。';

CREATE OR REPLACE FUNCTION fn_perf_history(p_cycle bigint, p_person bigint)
RETURNS TABLE (
  version         int,
  old_score       numeric(5,2),
  new_score       numeric(5,2),
  note            varchar(200),
  changed_by_name varchar(64),
  changed_at      timestamptz
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT l.version, l.old_score, l.new_score, l.note,
         COALESCE(NULLIF(a.display_name, ''), l.changed_by) AS changed_by_name,
         l.changed_at
    FROM public.perf_result_log l
    LEFT JOIN public.sys_account a ON a.id::text = btrim(l.changed_by)
   WHERE l.cycle_id = p_cycle AND l.employee_id = p_person
   ORDER BY l.version DESC;
$$;

COMMENT ON FUNCTION fn_perf_history IS
  '一个人的改分史（按版本倒序，最新一版在上）。'
  'new_score 为 NULL 的那一条是"被排除"—— 88 → NULL 与 88 → 92 是两件事，'
  '在这张表里一眼能分开。';

-- ---------------------------------------------------------------------------
-- 7. 强制分布：从档位出发，0 人档也出行
-- ---------------------------------------------------------------------------
-- 原来的写法从 perf_result 出发 GROUP BY grade：方案 5 档只用了 3 档时只出 3 行，
-- 于是「A 档没人」与「方案里没有 A 档」在报表上完全同形 —— 而这两件事的处置相反：
-- 前者是执行没到位（该有人去谈），后者是方案没配（不用管）。
--
-- 改成从 perf_grade 出发 LEFT JOIN 统计：
--   · 每一档都出行，n = 0 也出；
--   · pct 在 total = 0 时为 NULL（没有分母），不是 0；
--   · target_pct 原样带出（NULL = 这一档不参与强制分布）。
--
-- ★ 仍然只报不拦（026 ④）。这一版没有改那个决定，只是把"没人"这件事
--   从"看不见"变成"看得见"。
CREATE OR REPLACE FUNCTION fn_perf_distribution(p_cycle bigint)
RETURNS TABLE (grade varchar(8), n int, pct numeric, target_pct numeric, over_by numeric)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH c AS (
    SELECT COALESCE(pc.scheme_id, public.fn_perf_scheme_asof(pc.period_to)) AS scheme_id
      FROM public.perf_cycle pc
     WHERE pc.id = p_cycle
  ), t AS (
    SELECT count(*)::numeric AS total
      FROM public.perf_result r
     WHERE r.cycle_id = p_cycle AND r.state = 'scored'
  ), d AS (
    SELECT r.grade, count(*)::int AS n
      FROM public.perf_result r
     WHERE r.cycle_id = p_cycle AND r.state = 'scored'
     GROUP BY r.grade
  )
  SELECT g.grade,
         COALESCE(d.n, 0) AS n,
         round(100.0 * COALESCE(d.n, 0) / NULLIF((SELECT total FROM t), 0), 2) AS pct,
         g.target_pct,
         round(100.0 * COALESCE(d.n, 0) / NULLIF((SELECT total FROM t), 0) - g.target_pct, 2)
           AS over_by
    FROM c
    JOIN public.perf_grade g ON g.scheme_id = c.scheme_id
    LEFT JOIN d ON d.grade = g.grade
   ORDER BY g.min_score DESC, g.grade;
$$;

COMMENT ON FUNCTION fn_perf_distribution IS
  '每档都出行（n = 0 也出）：「A 档没人」与「方案里没有 A 档」不再同形。'
  'pct 在 total = 0 时为 NULL（没有分母），target_pct 为 NULL = 不参与强制分布。'
  '只报不拦 —— 拦的后果是有人去调分，而调过的分与真分在表里同形。';

-- ---------------------------------------------------------------------------
-- 6. 判据登记
-- ---------------------------------------------------------------------------
-- ★ 158 交上来时漏了这一段：库里的行为对了，但覆盖率页上这一层永远停在
--   never_run —— 等于"做了但没人知道它被验过"。补在这里，不另开文件：
--   判据与它守的对象放同一份迁移，将来改这一层时不会漏掉对应判据。
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.PERFS',
   '绩效结果的痕迹：打分必须带评分人、改分由触发器写台账（绕过服务层也躲不开）、'
   '台账只增不改、强制分布每档都出行（"这一档没人"与"方案没这一档"不同形）',
   'ORG','ALGORITHM','fn_pr_scorer_required','public','perf_result','TABLE',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-PERFS',
   '绩效痕迹接进接口：结果清单带评分人与改过几次、一个人的改分史、每档都出行的分布',
   'ORG','ACL','fn_perf_result_of','public','perf_result_log','TABLE',
   'team-lead','2027-06-30','node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
