-- ============================================================================
-- 188_hc_gap_to_requisition.sql · 缺岗 → 一键开招聘需求
-- ----------------------------------------------------------------------------
-- 现状（改之前）：
--   · 172 的档口三数已经能回答"这个档口这个岗位缺几个"（fn_station_fill）；
--   · 025 的 requisition 只能挂在门店上，`position` 是一列 **varchar(64)**
--     （025:34），不是岗位外键。
-- 于是"炉灶档缺 3 个灶头 → 开 3 个招聘需求"这件事做不到：
--   ① 需求不知道自己是哪个**岗位**的（只有一串文字），发 offer 时无法与
--      position 对上，也就无法回答"招进来占的是不是那个缺的编"；
--   ② 不知道缺岗发生在**哪家店**（org_id 是需求挂靠的组织，语义上等于门店，
--      但历史数据与"缺岗门店"不是同一个概念，混用后无法追溯）。
-- 本文件补两列 + 一个函数，把"缺几名 → 开几条需求"流水化。
--
-- ----------------------------------------------------------------------------
-- ★ 判断缺岗用哪个口径（先写清，再写代码）
-- ----------------------------------------------------------------------------
-- 用**档口口径**：`fn_station_fill(门店, 期末日).gap`，即
--     缺岗 = 该 (档口, 岗位) 当期**档口编 − 到岗（岗次）**
-- 依据 docs/48 §15.3 与 172:69-79：
--   · 门店级口径是"含下级、可招用直属"（178 之后 fn_hc_hireable 的直属支），
--     回答的是"这家店还能招几个"；
--   · 档口级口径是"这个档口的这个岗位缺几个"，回答的是"缺在哪儿"。
--   开招聘需求要的是**后者**：门店可招 5 个 ≠ 炉灶档缺 3 个灶头 + 砧板档缺 2 个。
--   用门店口径生成需求会丢掉"招什么岗"，而那正是本函数存在的原因。
--   ⇒ 到岗沿用 fn_station_fill 的表达式（在编 + 在职 + cost_org 落本店 +
--     当期任职在这个岗位），不另写一份 —— 两份口径必然漂。
--   ⇒ **外包不参与这个式子**（189 同一句话）：外包不占编、不算到岗。
--   ⇒ 未定编的档口（headcount 为 NULL）不产生需求：NULL 不是"缺 0"，也不是"缺全部"，
--     它是"还没定编" —— 定编是人做的决定，系统不替人补。
--
-- ★ 时点：期末日，不是 app_today()
--   编制是月粒度的（172），"3 月缺几个"必须按 3 月 31 日的档口实例与编制判，
--   用今天会得到"用现在的编制去修 3 月的缺口"，两个时点混在一个数里。
--   于是 opened_at 也写期末日 —— 需求是"为这一期缺的岗"开的，与判定同一时点，
--   而不是"我点这个按钮的那天"（那会让同一批缺口在不同日子开出不同的单）。
--
-- ★ 幂等：同一 (门店, 岗位, 期间) 已有**未关闭**的需求就不重复开
--   识别键是 (org_id, position_id, to_char(opened_at,'YYYY-MM'))，只认 position_id 非空的行。
--   · 为什么用 opened_at 的月份当"期间"：requisition 没有 period 列，而本函数
--     生成的单 opened_at 就是期末日（同月），于是月份就是这个需求的期间；
--   · 为什么只认 position_id：历史/手工需求只有文字岗位（position_id 为空），
--     把文字映射回岗位只能靠岗位名字符串，而 position.name 没有唯一约束
--     （083 只约束 code）—— 猜错的后果是"以为开过了，其实没开"，或者反过来
--     重复开。所以本函数**只对认得出的岗位去重**，认不出的（position_id 空）
--     一律当成另一条需求，并原样留在列表里让人自己看。
--
-- ★ 为什么"缺 3 个却只开了 2 个"不会发生（也不会被静默截断）
--   需求的写入判据在 025 的 trg_rq_guard：名额不得超过该门店的「还能发」，
--   而「还能发」= 额度 − 已下分 − 已入职 − 已发 offer。它与档口缺口**不同源**：
--   会出现"档口缺 3 个、门店还能发 1 个"（店长/副店长这类不进档口的岗占着编）。
--   本函数不把 3 改成 1（那会把一个错数变成一张合法单据），而是**这一行跳过**，
--   把库里那句拒绝原样带回（E_RQ_OVER_HEADCOUNT）。
--   一句话：宁可这一行没开，也不要开一张发不出 offer 的需求。
--
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING。
--       不动 001–187 的任何字节。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 需求挂上岗位与缺岗门店
-- ---------------------------------------------------------------------------
-- 两列都可空：历史数据与手工录入只有文字岗位（025:34），强制非空会让
-- 已有数据无法通过校验，而"给历史数据编一个岗位"是无据可依的。
ALTER TABLE public.requisition ADD COLUMN IF NOT EXISTS position_id bigint;
ALTER TABLE public.requisition ADD COLUMN IF NOT EXISTS store_id    bigint;

COMMENT ON COLUMN public.requisition.position_id IS
  '需求的岗位（position.id，188）。★ 可空：旧数据与手工录入只有文字岗位（025:34 的 position 列）。'
  '有这一列才能回答"这个需求招进来占的是不是那个缺的岗位"；'
  '为空时只当作一条"文字岗位"的需求，不参与缺岗去重（理由见 188 文件头）。';

COMMENT ON COLUMN public.requisition.store_id IS
  '缺岗发生在哪家门店（org_unit.id，188）。★ 可空：旧数据没有这个概念。'
  '★ 与 org_id 不是同义词：org_id 是"这条需求挂在哪个组织上"（025 判据要求叶子），'
  '  store_id 是"这个缺口出现在哪家店"。目前两者取值相同，但语义不同 —— '
  '合并成一列，将来"区域代招"或"门店间调人"就没有落脚点。';

CREATE INDEX IF NOT EXISTS ix_rq_pos ON public.requisition (store_id, position_id, status)
  WHERE position_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. 缺岗 → 招聘需求
-- ---------------------------------------------------------------------------
-- 返回每一行（= 每个缺岗的"档口×岗位"）的处置结果，不只是计数：
--   opened 的一行带 requisition_id；skipped 的一行带原因。
-- ★ 为什么不只返回"开了几条"：跳过的那几条恰恰是最需要人看的
--   （已有需求 / 门店还能发不够 / 岗位已停用…），只给一个数字等于让人去猜。
CREATE OR REPLACE FUNCTION public.fn_hc_gap_to_requisition(
  p_store  bigint,
  p_period varchar,
  p_by     varchar
) RETURNS TABLE (
  store_station_id bigint,
  station_code     varchar,
  station_name     varchar,
  position_id      bigint,
  position_name    varchar,
  need             int,
  requisition_id   bigint,
  state            varchar,   -- opened / skipped
  reason           text       -- skipped 时是原因；opened 时为 NULL
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_on    date;
  v_kind  varchar(16);
  r       record;
BEGIN
  IF p_period IS NULL OR p_period !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_SP_PERIOD: 期间格式必须是 YYYY-MM（收到 %）', p_period;
  END IF;

  SELECT o.kind INTO v_kind FROM public.org_unit o WHERE o.id = p_store;
  IF v_kind IS NULL OR v_kind <> 'dept' THEN
    RAISE EXCEPTION 'E_STN_NO_STORE: 门店 % 不存在（或不是部门节点）', p_store;
  END IF;

  -- 期末日：与 fn_station_fill / fn_store_station_quota 同一个时点口径
  v_on := (to_date(p_period || '-01','YYYY-MM-DD') + interval '1 month - 1 day')::date;

  FOR r IN
    SELECT f.store_station_id, f.station_code, f.station_name,
           f.position_id, f.position_name, f.gap
      FROM public.fn_station_fill(p_store, v_on) f
     WHERE f.position_id IS NOT NULL   -- 未定编的档口只有 position_id = NULL 那一行
       AND f.gap > 0                   -- NULL（未定编）与 0（不缺）都不开需求
     ORDER BY f.station_seq, f.station_code, f.position_level, f.position_name
  LOOP
    store_station_id := r.store_station_id;
    station_code     := r.station_code::varchar;
    station_name     := r.station_name::varchar;
    position_id      := r.position_id;
    position_name    := r.position_name::varchar;
    need             := r.gap;
    requisition_id   := NULL;
    state            := 'skipped';
    reason           := NULL;

    IF EXISTS (
      SELECT 1 FROM public.requisition q
       WHERE q.org_id = p_store
         AND q.status = 'open'
         AND q.position_id = r.position_id
         AND to_char(q.opened_at,'YYYY-MM') = p_period)
    THEN
      reason := '同一门店的这个岗位本期已有未关闭的需求（不重复开）';
    ELSIF NOT EXISTS (SELECT 1 FROM public.position p
                       WHERE p.id = r.position_id AND p.is_active) THEN
      reason := '岗位已停用，不再为它开需求';
    ELSE
      -- ★ 子事务：025 的 trg_rq_guard 可能拒（名额超「还能发」）或别的判据拒。
      --   一条拒不许把整批回滚 —— 那会让"3 个缺岗里 2 个能开"变成"一个都开不了"，
      --   而操作员看到的是一个没有信息量的失败。
      BEGIN
        INSERT INTO public.requisition
          (org_id, position, headcount, opened_at, reason, created_by, position_id, store_id)
        VALUES
          (p_store, r.position_name, r.gap, v_on,
           format('档口缺岗自动开需求：%s 的%s缺 %s 人（%s 期末口径）',
                  r.station_name, r.position_name, r.gap, p_period),
           COALESCE(NULLIF(btrim(p_by), ''), 'system'), r.position_id, p_store)
        RETURNING id INTO requisition_id;
        state  := 'opened';
        reason := NULL;
      EXCEPTION WHEN OTHERS THEN
        requisition_id := NULL;
        state  := 'skipped';
        -- 原样带回库里的拒绝（形如 "E_RQ_OVER_HEADCOUNT: …"）：
        -- 改写成人话会丢掉"是名额不够还是岗位不对"的区别。
        reason := SQLERRM;
      END;
    END IF;

    RETURN NEXT;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION fn_hc_gap_to_requisition IS
  '按档口缺岗开招聘需求（188）：每个"档口×岗位"缺几名就开一条 headcount=缺口的需求。'
  '★ 缺岗口径 = fn_station_fill 的 gap（档口编 − 到岗，岗次），期末日判定；'
  '  不是门店可招口径（那回答"还能招几个"，不回答"缺在哪个岗"）。'
  '★ 幂等键 = (门店, 岗位, 期间) 且只认 status=open、position_id 非空的需求。'
  '★ 门店「还能发」不够时不把名额改小，而是这一行 skipped 并把库里的拒绝原样带回 ——'
  '  开一张发不出 offer 的需求比少开一条更糟。'
  '★ 未定编的档口不产生需求（NULL 不是 0）。';

-- ---------------------------------------------------------------------------
-- 3. 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO public.sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RQ-GAP',
   '缺岗转招聘需求：按档口编−到岗（不是门店可招）判缺、期末日口径、'
   '同(门店,岗位,期间)不重复开、名额不够时跳过而不是改小、未定编不产生需求',
   'ORG','ALGORITHM','fn_hc_gap_to_requisition','public','requisition','FUNCTION',
   NULL,NULL,'node test/extra1.mjs','node test/extra1.mjs')
ON CONFLICT (check_code) DO NOTHING;
