-- ============================================================================
-- 184_payslip_view_log.sql · 工资条"被谁看过"的留痕
-- ----------------------------------------------------------------------------
-- 现状（改之前）：工资条这条链路上有四道闸（行闸 / 法人闸 / 字段掩码 / 人员闸），
-- 它们回答的都是"**能不能**看"，没有一条回答"**谁看过**"。
-- 员工投诉"我的工资怎么被这么多人看过"时，库里一条记录都没有 —— 答不出来。
-- 工资条是"发下去让人签字确认"的凭证，签字那一侧有 signoff，看的那一侧是空的。
--
-- 本文件只建表与索引，**不做任何写入**。写入在 app/services/payslip-view.mjs
-- 一处实现（recordView），所有出口（列表 / 单条 / 打印 / 导出 / 打包）都调它。
--
-- ★ 设计一：**只记"看了别人的"**，看自己的不记
--   `subject_person_id = fn_my_person(actor)` 的那一次不写行。
--   理由不是省空间，是**可用性**：每个人每天打开自己的工资条十次，日志会被
--   自己刷满，真要看"谁看了我的"的时候翻不出来 —— 一份全是噪音的审计表
--   等于没有审计表。审计要回答的是"**别人**动过我什么"。
--
-- ★ 设计二：**批量按一次记一行**，row_count 记这一次看了几行
--   8 月整批 374 个人不写 374 条。读日志的是人，不是审计程序：
--   一条"张某在 9/3 10:12 看了 2026-08 整批 374 行"是可以读的，
--   374 条只能靠 SQL 聚合才看得出是同一件事 —— 那时要日志做什么。
--   代价（如实写在文件里）：批量行**答不出"我在不在那 374 里"**，
--   要回答那一问必须再加一张"批次 × 人"的桥表；本期不做，见报告。
--
-- ★ 设计三：**不加外键**（payslip / pay_run / person 都不加）
--   历史批次清理时，一条日志不该阻塞批次删除；日志是"事实曾经发生过"的记录，
--   被引用的对象消失以后它仍然成立（那时它反而更重要）。加了 FK 之后，
--   删除历史批次要么失败、要么要级联删日志 —— 两条路都在毁证据。
--   `actor_user_id` 同理：账号注销后，那行日志不该跟着消失。
--   缺失的可见性由 `GET /api/payslip/views` 的 LEFT JOIN 兜（名字取不到就显示 id）。
--
-- ★ 设计四：写入用**独立事务**（在 payslip-view.mjs，不在这里）
--   读事务回滚会把日志一起带走，而"他看过了"这件事不该因为后续报错而消失；
--   反过来，日志写失败也不该让读请求 500。两条都写在那边的注释里。
--
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS。
--       不加列、不改历史数据、不动 001–183。
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payslip_view_log (
  id                bigserial   PRIMARY KEY,
  -- 谁看的（sys_account.id / 会话里的 user id）
  actor_user_id     bigint      NOT NULL,
  -- 看了谁；**批量时为 NULL**（见设计二）。不设 FK（见设计三）
  subject_person_id bigint,
  -- 单条查看时的工资条 id；列表 / 打印 / 导出时为 NULL
  payslip_id        bigint,
  -- 批量查看时的发薪批次；跨批次（/api/payslip 一屏多期）时为 NULL
  pay_run_id        bigint,
  -- 这一条属于哪种动作：single=看某一个人的工资条，list=列表，
  -- print=打印页，export=CSV / zip 打包
  scope             varchar(16) NOT NULL,
  -- 这一次看 / 导出了几行。批量是"一行日志代表 N 行数据"的唯一凭证
  row_count         int         NOT NULL DEFAULT 1,
  ip                inet,
  at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_pvl_scope CHECK (scope IN ('single', 'list', 'print', 'export')),
  -- 行数只能是正数：0 行不算"看过"，写入侧会直接跳过（不写 0 行的日志）
  CONSTRAINT ck_pvl_rows CHECK (row_count > 0)
);

COMMENT ON TABLE public.payslip_view_log IS
  '工资条查阅留痕（184）。只记"看了别人的"：subject_person_id = fn_my_person(actor) 时不写行。'
  '批量按一次记一行，row_count 是这一次看了几行 —— 不写"每人一条"，'
  '因为读日志的是人，374 条同一动作的记录等于没有记录。'
  '★ 不加外键：历史批次/人员被清理后日志仍然成立，删数据不该被日志阻塞、也不该级联删日志。';

COMMENT ON COLUMN public.payslip_view_log.subject_person_id IS
  '被查看的人（person.id）。批量查看（scope<>''single''）时为 NULL —— '
  '批量只记"谁在什么时候看了哪一批共几行"，不摊回每个人。';

COMMENT ON COLUMN public.payslip_view_log.row_count IS
  '这一次请求实际返回的行数。一个批次 374 人 = 1 条日志 + row_count=374。';

-- 三个索引对应三种真实问法：
--   ① 员工问"谁看过我的"          → (subject_person_id, at desc)
--   ② HR 问"某人看过哪些人"        → (actor_user_id, at desc)
--   ③ 财务问"这个批次被导过几次"    → (pay_run_id)
CREATE INDEX IF NOT EXISTS ix_pvl_subject_at
  ON public.payslip_view_log (subject_person_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_pvl_actor_at
  ON public.payslip_view_log (actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_pvl_run
  ON public.payslip_view_log (pay_run_id);

-- ---------------------------------------------------------------------------
-- 判据登记：新开一组 SUITE.API-PWV（六条断言见 test/api.test.mjs 的 PWV 组）
-- ---------------------------------------------------------------------------
-- ★ 必须登记：`fn_chk_record` 对未登记的组号直接 RAISE（"打了没登记的组"）。
--   这不是形式主义 —— 覆盖率页按这张表数"哪些判据还没跑过"，
--   不登记的断言在页面上等于不存在。
-- guard 指向本表的 scope 约束：它才是"写不进非法动作"的那道闸。
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-PWV','工资条查阅留痕：看自己不记 / 批量一行 / 写失败不挡读','SECURITY','ACL',
   'ck_pvl_scope','public','payslip_view_log','CONSTRAINT',
   NULL,NULL,'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
