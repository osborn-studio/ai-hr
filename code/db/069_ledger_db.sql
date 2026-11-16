-- ============================================================================
-- 069_ledger_db.sql · 帐套 = 独立数据库（物理隔离，用友那套）
-- ----------------------------------------------------------------------------
-- 068 走的是"同一库里多帐套"，业务表共用 —— 那条路要么不隔离，要么得在几十张表
-- 上加 tenant 列。**改成物理隔离之后，这些顾虑全部消失**：
--
--   一个集团帐套 = 一个独立 PostgreSQL 数据库
--     · 组织、人员、考勤、工资、审批、账号，全在它自己的库里
--     · 两套帐套之间不存在"查错库"的可能，因为连接串都不一样
--     · 备份/恢复/迁移也是按库走（现有 tools/backup.mjs 直接可用）
--
-- 这一个库（控制库）只记"有哪些帐套、各自连哪个库"。
-- 建帐的完整引导在 tools/new-ledger.mjs：
--   开库 → 跑 069 之前的全部迁移 → 建集团根 → 建管理员账号 → 记入控制库。
--
-- ★ 一条必须说清的事：控制库里的 sys_ledger 只有一行"登记信息"，
--   它不存业务数据；**业务数据的权威副本在被开的那个库里**。
--   这条写下来，是因为"两边都有一张 sys_ledger"很容易让人以为要双向同步。
-- ============================================================================

-- ★ 068 用 CREATE OR REPLACE 加了第 4 个参数（带默认值），于是库里同时存在
--   fn_org_add(3 参) 与 fn_org_add(4 参) → 3 参调用报 "is not unique"。
--   带默认值的新参数**必须**先 DROP 旧签名，否则不是替换而是并存。
DROP FUNCTION IF EXISTS fn_org_add(bigint, varchar, varchar);

ALTER TABLE sys_ledger ADD COLUMN IF NOT EXISTS db_name varchar(64);
ALTER TABLE sys_ledger ADD COLUMN IF NOT EXISTS db_host varchar(128);
ALTER TABLE sys_ledger ADD COLUMN IF NOT EXISTS provisioned_at timestamptz;

COMMENT ON COLUMN sys_ledger.db_name IS
  '这个帐套对应的**独立数据库名**。业务数据在那个库里，控制库只登记。';

-- 登记一个新帐套（由 provisioning 脚本调用；库里已有的就更新连接信息）
CREATE OR REPLACE FUNCTION fn_ledger_register(
  p_code varchar, p_name varchar, p_period varchar, p_db varchar,
  p_host varchar DEFAULT NULL, p_by varchar DEFAULT 'provisioner'
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_id bigint;
BEGIN
  IF p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_LEDGER_PERIOD: 启用期间必须是 YYYY-MM，收到 %', p_period;
  END IF;
  IF p_db IS NULL OR p_db !~ '^[a-z][a-z0-9_]{2,62}$' THEN
    RAISE EXCEPTION 'E_LEDGER_DBNAME: 库名必须小写字母开头、仅小写字母数字下划线（收到 %）', p_db;
  END IF;

  INSERT INTO public.sys_ledger(code, name, start_period, created_by, db_name, db_host,
                                status, activated_at, is_default)
  VALUES (btrim(p_code), btrim(p_name), p_period, p_by, p_db, p_host,
          'active', now(), NOT EXISTS (SELECT 1 FROM public.sys_ledger))
  ON CONFLICT (code) DO UPDATE
     SET name = EXCLUDED.name, db_name = EXCLUDED.db_name, db_host = EXCLUDED.db_host,
         provisioned_at = now()
  RETURNING id INTO v_id;

  UPDATE public.sys_ledger SET provisioned_at = now() WHERE id = v_id;
  RETURN v_id;
END;
$$;

INSERT INTO sys_check_registry
  (check_code,name,domain,kind,guard_object,guard_schema,guard_table,guard_kind,
   guard_debt_owner,guard_debt_due,runner,assertion_sql) VALUES
  ('SUITE.MT2','物理隔离：一个帐套一个库，控制库只登记（不再需要 tenant 列）',
   'ORG','STRUCT','fn_ledger_register','public','sys_ledger','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','SELECT count(*) FROM sys_ledger WHERE db_name IS NOT NULL')
ON CONFLICT DO NOTHING;
