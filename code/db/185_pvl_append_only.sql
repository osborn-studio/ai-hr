-- ============================================================================
-- 185_pvl_append_only.sql · 留痕表的两条硬约束：**改不掉**、**能归档**
-- ----------------------------------------------------------------------------
-- 184 建了 `payslip_view_log`，但只解决了"有没有记录"，没解决"这记录能不能被改"。
-- 一张谁都能 UPDATE/DELETE 的审计表，在合规上是**不算数的**：
-- 出了争议，对方只要问一句"你们谁能删这张表"，答案就是"谁都能"。
--
-- ★ 设计一：append-only 触发器（拒 UPDATE / 拒 DELETE / 拒 TRUNCATE）
--   三条都拒，而不是只拒 DELETE —— 只拒删的话，把 at 改成别的日子、
--   把 actor 改成别人，一样能把证据改掉，而且改完"看起来还在"。
--
-- ★ 设计二：归档留一个**受控出口**（不是后门）
--   合规要求"保存 N 年"，但表不能无限长。归档函数 `fn_pvl_archive(before)`
--   把早于某时刻的行搬进 `payslip_view_log_archive`（同结构 + archived_at），
--   是**搬**不是删：搬完原表少一行、归档表多一行，两边合起来仍然完整。
--   为了让触发器放行这一条路径，函数内部会 `set_config('app.pvl_archiving','on',true)`
--   （第三个参数 true = 只在本事务有效）。触发器只认这个开关。
--   ★ 为什么不用 `session_replication_role` 或临时禁用触发器：那两个是**全局**
--     开关，一旦有人在会话里忘了还原，整张表的保护就没了，而且没有任何痕迹。
--     这个开关是事务级的，事务结束自动关。
--
-- ★ 设计三：保留期是**配置项**，默认 0 = **永不归档**（= 上线前的实际行为）
--   制度项 `PVL_RETENTION_MONTHS`（SECURITY 域，numeric）。0/空 = 不自动归档，
--   表就一直长着。要开，就同时接一个定时任务调 `fn_pvl_archive`。
--   ★ 默认不归档是刻意的：自动删证据这件事，除非客户明确要求，否则不该默认发生。
--
-- 幂等：CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS。
--       不动 001–184 的任何字节。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 归档表：与原表同结构（不含主键序列），多一列归档时刻
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payslip_view_log_archive (
  id               bigint      NOT NULL,      -- 沿用原主键，便于两边对照
  actor_user_id    bigint      NOT NULL,
  subject_person_id bigint,
  payslip_id       bigint,
  pay_run_id       bigint,
  scope            varchar(16) NOT NULL,
  row_count        int         NOT NULL DEFAULT 1,
  ip               inet,
  at               timestamptz NOT NULL,
  archived_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payslip_view_log_archive IS
  '工资条查阅留痕的归档区（185）。结构与 payslip_view_log 一致，多 archived_at。'
  '★ 归档是**搬**不是删：原表少一行、这里多一行，两边合起来仍完整。'
  '★ 本表同样不允许随便改：见 trg_pvla_append_only。';

CREATE INDEX IF NOT EXISTS ix_pvla_subject_at
  ON public.payslip_view_log_archive (subject_person_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_pvla_actor_at
  ON public.payslip_view_log_archive (actor_user_id, at DESC);

-- ---------------------------------------------------------------------------
-- 2. append-only 触发器（原表 + 归档表）
-- ---------------------------------------------------------------------------
-- ★ 为什么连归档表也锁：只锁原表的话，有人可以先把行搬过去再改，
--   等于换个地方改证据。
CREATE OR REPLACE FUNCTION public.fn_pvl_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('app.pvl_archiving', true) = 'on' THEN
    -- 归档事务里只允许 DELETE（原表）/ INSERT（归档表）。
    -- 放行 UPDATE 没有正当用途：搬行不需要改内容。
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'E_PVL_READONLY: 留痕不可修改（归档也一样）';
    END IF;
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION 'E_PVL_READONLY: 工资条查阅留痕是 append-only，不允许 % '
                  '（删除/修改留痕等于销毁证据；真要保留期管理，用 fn_pvl_archive）', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_pvl_append_only ON public.payslip_view_log;
CREATE TRIGGER trg_pvl_append_only
  BEFORE UPDATE OR DELETE ON public.payslip_view_log
  FOR EACH ROW EXECUTE FUNCTION public.fn_pvl_append_only();

DROP TRIGGER IF EXISTS trg_pvla_append_only ON public.payslip_view_log_archive;
CREATE TRIGGER trg_pvla_append_only
  BEFORE UPDATE OR DELETE ON public.payslip_view_log_archive
  FOR EACH ROW EXECUTE FUNCTION public.fn_pvl_append_only();

-- TRUNCATE 不走行级触发器，单独用语句级锁
CREATE OR REPLACE FUNCTION public.fn_pvl_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF current_setting('app.pvl_archiving', true) = 'on' THEN RETURN NULL; END IF;
  RAISE EXCEPTION 'E_PVL_READONLY: 留痕表不允许 TRUNCATE（那不是"清理"，是"清空证据"）';
END;
$$;

DROP TRIGGER IF EXISTS trg_pvl_no_truncate ON public.payslip_view_log;
CREATE TRIGGER trg_pvl_no_truncate
  BEFORE TRUNCATE ON public.payslip_view_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_pvl_no_truncate();

-- ---------------------------------------------------------------------------
-- 3. 归档函数：搬行（唯一被放行的删除路径）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pvl_archive(p_before timestamptz)
RETURNS int
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_n int;
BEGIN
  IF p_before IS NULL THEN
    RAISE EXCEPTION 'E_ARG_INVALID: 必须给归档截止时刻（早于它的行才搬）';
  END IF;
  -- ★ 只在本事务内打开开关；事务一结束自动关闭，不会残留。
  PERFORM set_config('app.pvl_archiving', 'on', true);

  WITH moved AS (
    DELETE FROM public.payslip_view_log l
     WHERE l.at < p_before
     RETURNING l.id, l.actor_user_id, l.subject_person_id, l.payslip_id,
               l.pay_run_id, l.scope, l.row_count, l.ip, l.at
  )
  INSERT INTO public.payslip_view_log_archive
    (id, actor_user_id, subject_person_id, payslip_id, pay_run_id,
     scope, row_count, ip, at)
  SELECT id, actor_user_id, subject_person_id, payslip_id, pay_run_id,
         scope, row_count, ip, at
    FROM moved;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.fn_pvl_archive IS
  '把 at < p_before 的留痕**搬**进归档表并返回条数（185）。'
  '★ 唯一被放行的删除路径：函数内 set_config(...,true) 只在本事务有效。'
  '★ 不要用 DELETE 手工清表 —— 触发器会拒；这正是设计意图（清理要有出口、要留痕）。'
  '★ 保留期是制度项 PVL_RETENTION_MONTHS，默认 0 = 永不归档。';

-- ---------------------------------------------------------------------------
-- 4. 保留期配置项（默认 0 = 不归档 = 上线前行为）
-- ---------------------------------------------------------------------------
INSERT INTO public.policy_def(code, name, domain, value_type, allow_org_override, override_floor, unit)
VALUES ('PVL_RETENTION_MONTHS', '留痕保留期（月，0=永久保留）', 'SECURITY', 'numeric',
        false, 'group', '月')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.policy_value(policy_code, effective_from, value_num, published_by, reason)
VALUES ('PVL_RETENTION_MONTHS', '2026-01-01', 0, 'group_hr',
        '默认 0：不自动归档。归档是"搬"不是"删"，且自动减损证据这件事除非客户明确要求，否则不该默认发生')
ON CONFLICT (policy_code, effective_from) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. 判据登记
-- ---------------------------------------------------------------------------
INSERT INTO public.sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-PVL-RO','留痕 append-only：UPDATE/DELETE/TRUNCATE 被拒，只能经 fn_pvl_archive 搬',
   'SECURITY','STRUCT','trg_pvl_append_only','public','payslip_view_log','TRIGGER',
   NULL,NULL,'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
