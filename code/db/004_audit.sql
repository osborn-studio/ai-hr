-- ============================================================================
-- 004_audit.sql · 审计（T01.4）
-- ----------------------------------------------------------------------------
-- 一个命题：**记录点必须在数据库，不能在应用层。**
--
-- 理由不是"更可靠"，是**结构性的**：如果记录器是应用里的一个函数，
-- 那么"停用记录器"这个动作本身就记不到 —— 因为记录器已经被停了。
-- 凡审计由被审计者自己写，审计对"停用自己"必然失明。
-- 补法只有两条：心跳，或把记录点前移。这里选后者。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 审计表：append-only
-- ---------------------------------------------------------------------------
-- ★ 主键用 GENERATED ALWAYS AS IDENTITY，不用 bigserial。
--   serial 的序列在 `pg_dump --schema-only` 后从 1 重新开始，
--   于是"同一个 id 指向另一条记录"——比 id 缺失更坏，因为它是静默的。
CREATE TABLE sys_audit_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT clock_timestamp(),  -- 判定型：同一事务内也要递进
  -- ★ session_user 而不是 current_user：
  --   current_user 是"生效角色"（SET ROLE 后会变），
  --   session_user 是"实际登录的人"。审审计要看后者。
  session_user_name text NOT NULL,
  table_name    text NOT NULL,
  op            char(1) NOT NULL,
  row_pk        text,
  old_row       jsonb,
  new_row       jsonb,
  CONSTRAINT ck_sal_op CHECK (op IN ('I','U','D'))
);
CREATE INDEX ix_sal_time ON sys_audit_log(occurred_at DESC);
CREATE INDEX ix_sal_table ON sys_audit_log(table_name, occurred_at DESC);

COMMENT ON TABLE sys_audit_log IS
  'append-only。没有任何 UPDATE/DELETE 路径，撤销也不删行——撤销本身是另一条记录。';

-- ---------------------------------------------------------------------------
-- 2. 记录触发器
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_audit_row() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_pk text;
BEGIN
  v_pk := CASE TG_OP
            WHEN 'DELETE' THEN (to_jsonb(OLD) ->> 'id')
            ELSE (to_jsonb(NEW) ->> 'id')
          END;
  INSERT INTO public.sys_audit_log(
    session_user_name, table_name, op, row_pk, old_row, new_row)
  VALUES (
    session_user, TG_TABLE_NAME, left(TG_OP, 1), v_pk,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END);
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER trg_audit_employee_demo
  AFTER INSERT OR UPDATE OR DELETE ON employee_demo
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- ---------------------------------------------------------------------------
-- 3. 权限收紧：应用角色只能写和读，不能删、不能改、不能 TRUNCATE
-- ---------------------------------------------------------------------------
-- ★ TRUNCATE 必须单独 REVOKE。它不触发 ON DELETE 触发器，也不走行级权限，
--   只测 DELETE 是这类功能的固定漏洞。
-- ★ 但 REVOKE 对**表的 owner** 零效果（返回成功、什么都不做）。
--   所以 owner 必须在别处（NOLOGIN 的 role_migration），不能靠 REVOKE 防它。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
  END IF;
END $$;

GRANT SELECT, INSERT ON sys_audit_log TO app_role;
REVOKE UPDATE, DELETE, TRUNCATE ON sys_audit_log FROM app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON employee_demo TO app_role;
GRANT USAGE ON SCHEMA public TO app_role;
