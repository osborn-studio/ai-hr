-- ============================================================================
-- 189_outsourced_station.sql · 外包归属到档口（**只用来数人，绝不进编制**）
-- ----------------------------------------------------------------------------
-- 现状（改之前）：`outsourced_assignment` 只到门店（019:72-79）：一个外包人员
-- 在某家门店、某段时间。于是"这家店的洗碗档用了几个外包"答不出来 ——
-- 而门店层的外包工时汇总（server.mjs 的 ext 查询）已经回答了"这家店一共多少"。
--
-- 本文件只做两件事：
--   ① 给派工加一列可空的 `store_station_id`（NULL = 只到门店、没细分到档口）；
--   ② 给一个只读函数 `fn_station_outsourced(门店, 某天)`：某店的每个档口
--      在某一天有几个外包在派工期内。
--
-- ----------------------------------------------------------------------------
-- ★★ 这一列**只回答"这个档口用了几个外包"，绝不进编制/到岗的任何计算 ★★
-- ----------------------------------------------------------------------------
-- 依据（三条，缺一条都不能得出这个结论）：
--   · 019:64-67：outsourced_worker **刻意没有 person_id** —— 一旦与内部自然人同表，
--     个税/社保/工资条/编制的每一个"按 person"的清单都会自动包含他们，
--     而排除要靠每处查询记得加条件（加对 12 处，第 13 处会忘）。
--   · 172:85-90：外包不占编、不算到岗；fn_sp_guard 还**拒绝**把外包岗配进档口编制
--     （E_SP_OUTSOURCED，172:316-319）。
--   · 172:76-79：档口数的是**岗次**、门店数的是**人头**；外包没有岗次概念
--     （他没有 person_position），硬塞进"到岗岗次"等于给外包编一个假身份。
--
-- 所以：
--   ✗ 不许把 fn_station_outsourced 的结果加到 fn_station_fill 的 holders / slots
--   ✗ 不许用它在 fn_hc_* 里抵编（"缺 3 个，有 2 个外包，所以只缺 1"是错的：
--     外包的合同不在我方，业务上他随时可以被供应商换走）
--   ✗ 不许把它折算成 FTE 再进编制（折算需要"标准月工时"，全系统工时口径只有
--     schedule_segment 一处，150:25-26 —— 开第二个就是第二条算薪口径）
--   ✓ 只用于展示与运营判断："这个档口补了外包，是不是可以晚点招人"。
-- 测试里钉了反例：插入外包派工前后，fn_station_fill 的每一行（含 gap）**逐字相同**。
--
-- ★ 还有一个已知的、刻意的"数不平"：只到门店（store_station_id 为 NULL）的派工
--   **不会**出现在任何档口的计数里。于是
--       Σ 各档口外包人数 ≤ 这家店的外包总人数
--   而且差额就是"还没细分到档口"的那部分。这是诚实的：系统不替人猜
--   "这个洗碗的外包到底站哪个档口"。要数平就先补归属，不是让函数去平均分。
--
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS
--       / ON CONFLICT DO NOTHING。不动 001–188 的任何字节。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 派工归属到档口
-- ---------------------------------------------------------------------------
ALTER TABLE public.outsourced_assignment
  ADD COLUMN IF NOT EXISTS store_station_id bigint;

COMMENT ON COLUMN public.outsourced_assignment.store_station_id IS
  '外包派工落在哪个档口（189，store_station.id）。★ 可空：NULL = 只到门店、没细分到档口，'
  '那种派工不会被算进任何档口（Σ档口 ≤ 门店总数，差额就是它）。'
  '★★ 这一列只回答"这个档口用了几个外包"，**绝不进编制/到岗的任何计算**：'
  '外包没有 person_id（019:64-67）、不占编、不算到岗（172:85-90）。'
  '把它加进 holders/gap 等于给外包编一个假身份，而"缺 3 个有 2 个外包所以只缺 1"是错的 —— '
  '外包的合同不在我方，随时可被供应商换走。';

CREATE INDEX IF NOT EXISTS ix_oa_station ON public.outsourced_assignment (store_station_id)
  WHERE store_station_id IS NOT NULL;

-- 档口必须属于这家店。不判的话会出现"派工写的是 B 店、档口是 A 店洗碗档"，
-- 于是 A 店的洗碗档外面站着一个人，而 B 店的成本里也算了这个人 ——
-- 两处都不报错，两处都错。
CREATE OR REPLACE FUNCTION public.fn_oa_station_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_store bigint;
BEGIN
  IF NEW.store_station_id IS NULL THEN RETURN NEW; END IF;

  SELECT ss.store_id INTO v_store
    FROM public.store_station ss WHERE ss.id = NEW.store_station_id;
  IF v_store IS NULL THEN
    RAISE EXCEPTION 'E_STN_NOT_FOUND: 门店档口 % 不存在', NEW.store_station_id;
  END IF;
  IF v_store <> NEW.store_id THEN
    RAISE EXCEPTION 'E_STN_OS_STORE: 派工门店 % 与档口 % 所属门店 % 不一致 —— '
                    '档口外包人数会串店（两边的数都错，且都不报错）',
      NEW.store_id, NEW.store_station_id, v_store;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oa_station_store ON public.outsourced_assignment;
CREATE TRIGGER trg_oa_station_store
  BEFORE INSERT OR UPDATE OF store_station_id, store_id ON public.outsourced_assignment
  FOR EACH ROW EXECUTE FUNCTION public.fn_oa_station_guard();

-- ---------------------------------------------------------------------------
-- 2. 某门店某档口的外包人数（只读）
-- ---------------------------------------------------------------------------
-- 粒度 = 当期有效的门店档口（0 人的档口也给一行：页面要能显示"这个档口没用外包"，
-- 而不是让它整行消失 —— 与 fn_station_fill 给未定编档口留一行是同一条理由）。
-- 人数去重到 worker_id：同一人在同一档口踩两段派工（改过合同期）只算 1 人。
CREATE OR REPLACE FUNCTION public.fn_station_outsourced(
  p_store bigint,
  p_on    date DEFAULT NULL
) RETURNS TABLE (
  store_station_id bigint,
  station_id       bigint,
  station_code     varchar,
  station_name     varchar,
  seq              int,
  workers          int
)
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT ss.id,
         st.id,
         st.code::varchar,
         st.name::varchar,
         COALESCE(ss.seq, st.seq),
         COALESCE(o.n, 0)::int
    FROM public.store_station ss
    JOIN public.station st ON st.id = ss.station_id
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT oa.worker_id) AS n
        FROM public.outsourced_assignment oa
       WHERE oa.store_station_id = ss.id
         AND oa.store_id = p_store          -- 双保险：触发器已保证一致，这里不靠它
         AND daterange(oa.valid_from, oa.valid_to, '[]') @> COALESCE(p_on, public.app_today())
    ) o ON true
   WHERE ss.store_id = p_store
     AND daterange(ss.opened_at, ss.closed_at, '[]') @> COALESCE(p_on, public.app_today())
   ORDER BY COALESCE(ss.seq, st.seq), st.code;
$$;

COMMENT ON FUNCTION fn_station_outsourced IS
  '某门店每个档口在某天的外包人数（189）。只读，给展示用。'
  '★ 结果**不得**进编制/到岗：外包无 person_id、不占编、不算到岗（019:64-67 / 172:85-90）。'
  '★ 只到门店的派工（store_station_id 为空）不在任何档口行里：Σ档口 ≤ 门店总数。'
  '★ 0 人的档口也给一行（"这个档口没用外包"必须看得见，不能整行消失）。';

-- ---------------------------------------------------------------------------
-- 3. 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO public.sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.ST-OS',
   '外包归属档口：可查到档口外包人数、派工门店与档口所属门店必须一致、'
   '★ 加了外包派工之后档口到岗数与编制缺口逐字不变（外包不进编制/到岗）',
   'ORG','STRUCT','trg_oa_station_store','public','outsourced_assignment','TRIGGER',
   NULL,NULL,'node test/extra1.mjs','node test/extra1.mjs')
ON CONFLICT (check_code) DO NOTHING;
