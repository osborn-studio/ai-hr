-- ============================================================================
-- 008_confirm.sql · 排班段与段级确认（T03）
-- ----------------------------------------------------------------------------
-- 这块是全项目最容易"看起来修过了"的地方，所以三条都必须落成可判据的形状：
--
--   ① **三态，不是两态。** 必须区分「未确认」「已确认」「默认确认（超时自动）」。
--      "默认确认"的事实是**没有任何人真的看过它**，不是"有人确认了"。
--      合并进"已确认"之后，所有人第一眼看到的就是一个绿色的高确认率。
--
--   ② **零状态是派生的，不是表里的第四个值。**
--      "段没生成确认单"（未排班/计划外出勤）在表里根本没有行。
--      要把它做成状态值，就得先给它造一行 —— 而那一行一旦存在，
--      "本来不该有单"与"漏生成单"就在表里同形了。
--
--   ③ **段表有行 = 该有确认单。** 所以"有段行、无确认单"不是一种状态，是一个缺陷。
-- ============================================================================

CREATE TABLE schedule (
  id          bigint PRIMARY KEY,
  employee_id bigint NOT NULL,
  work_date   date   NOT NULL,
  shift_id    bigint NOT NULL,
  store_id    bigint NOT NULL,
  UNIQUE (employee_id, work_date, shift_id)
);

CREATE TABLE schedule_segment (
  id          bigint PRIMARY KEY,
  schedule_id bigint NOT NULL REFERENCES schedule(id) ON DELETE CASCADE,
  seq         int    NOT NULL,
  store_id    bigint NOT NULL,            -- 段所属门店（跨店支援时段与排班店不同）
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  UNIQUE (schedule_id, seq),
  CONSTRAINT ck_ss_range CHECK (end_at > start_at)
);

-- ---------------------------------------------------------------------------
-- 确认单：五态 + 来源标记
-- ---------------------------------------------------------------------------
CREATE TABLE confirm_sheet (
  id                  bigint PRIMARY KEY,
  segment_id          bigint NOT NULL UNIQUE REFERENCES schedule_segment(id) ON DELETE CASCADE,
  status              varchar(16) NOT NULL DEFAULT 'not_started',
  -- ★ 三态里的后两支靠它区分。"默认确认"是"已锁定"这一支的**来源**，
  --   不是第六态 —— 再加一个状态值会让状态机分叉。
  source              varchar(16),
  auto_confirmed_at   timestamptz,
  confirm_due_at      timestamptz,          -- ★ 本该何时确认（"默认确认"必须显示它）
  confirm_owner_id    bigint,               -- ★ 本该由谁确认
  confirmed_by        bigint,               -- 人（manual 时必填；timeout_auto 必须为空）
  basis_start_at      timestamp             -- 这条判据"从哪起有信息"，不是配置
);

ALTER TABLE confirm_sheet ADD CONSTRAINT ck_cs_status
  CHECK (status IN ('not_started','pushed','store_confirmed','locked','disputed'));
ALTER TABLE confirm_sheet ADD CONSTRAINT ck_cs_source
  CHECK (source IS NULL OR source IN ('manual','timeout_auto'));

-- ★ 系统动作不许写进人字段。
--   timeout_auto 却填了 confirmed_by，等于把"系统替你确认"记成"你确认了"。
ALTER TABLE confirm_sheet ADD CONSTRAINT ck_cs_source_consistent CHECK (
     (source = 'timeout_auto' AND confirmed_by IS NULL AND auto_confirmed_at IS NOT NULL)
  OR (source = 'manual'       AND confirmed_by IS NOT NULL AND auto_confirmed_at IS NULL)
  OR (source IS NULL AND confirmed_by IS NULL)
);

-- ★ 默认确认必须能回答"本该由谁、什么时候"。答不出来，这个名字就是把缺失藏起来了：
--   界面上只显示一个中性的"已确认"，而事实上没有任何人看过。
ALTER TABLE confirm_sheet ADD CONSTRAINT ck_cs_default_has_owner CHECK (
     source <> 'timeout_auto'
  OR (confirm_due_at IS NOT NULL AND confirm_owner_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 派生视图：三态 + 零状态
-- ---------------------------------------------------------------------------
-- ★ 驱动集 = 段全量（LEFT JOIN 确认单），所以"无确认单"能被派生出来。
--   若驱动集换成确认单，缺的那部分会静默消失。
CREATE VIEW v_segment_confirm AS
SELECT s.id                AS segment_id,
       s.schedule_id,
       s.store_id,
       cs.id               AS sheet_id,
       cs.status           AS sheet_status,
       cs.source,
       cs.auto_confirmed_at,
       cs.confirm_due_at,
       cs.confirm_owner_id,
       CASE
         -- ③ 零状态：段在、确认单不在 —— 这是**缺陷**，不是一种业务状态
         WHEN cs.id IS NULL                                         THEN 'missing_sheet'
         -- ② 默认确认：已锁定但来源是超时自动
         WHEN cs.status = 'locked' AND cs.source = 'timeout_auto'    THEN 'default_confirmed'
         -- ① 已确认：已锁定且来源是人工
         WHEN cs.status = 'locked' AND cs.source = 'manual'          THEN 'confirmed'
         ELSE 'unconfirmed'
       END AS biz_state
  FROM schedule_segment s
  LEFT JOIN confirm_sheet cs ON cs.segment_id = s.id;

-- ★ "本该有确认单却没生成"必须是红，不是灰。
CREATE VIEW v_segment_missing_sheet AS
SELECT segment_id, schedule_id, store_id
  FROM v_segment_confirm
 WHERE biz_state = 'missing_sheet';

COMMENT ON VIEW v_segment_missing_sheet IS
  '段表有行 = 它该有确认单。所以这张视图返回的行是缺陷，不是"未排班"。'
  '未排班在段表里根本没有行，不会出现在这里 —— 两者不同形正是本设计的目的。';
