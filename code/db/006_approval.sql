-- ============================================================================
-- 006_approval.sql · 审批引擎（T01.5）
-- ----------------------------------------------------------------------------
-- 两条不可让的东西：
--   ① **发布即冻结**：已发布版本的定义不可改，改只能发新版本。
--      这样"这张单当时按什么规则批的"永远可查。
--   ② **在途锁定**：实例的 template_version_id 一旦写入不可改。
--      改了之后，历史审批记录的含义会跟着变。
--
-- 为什么必须在数据库层：应用层拦得住应用，拦不住"能连库的人"。
-- 而"能连库的人"恰恰是最可能为了救火去改模板的人。
-- ============================================================================

CREATE TABLE approval_template (
  id   bigint PRIMARY KEY,
  code varchar(32) NOT NULL UNIQUE,
  name varchar(128) NOT NULL
);

CREATE TABLE approval_template_version (
  id           bigint PRIMARY KEY,
  template_id  bigint NOT NULL REFERENCES approval_template(id),
  version_no   int    NOT NULL,
  status       varchar(16) NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  published_by bigint,
  definition   jsonb NOT NULL,             -- 节点、条件、审批人解析规则
  UNIQUE (template_id, version_no),
  CONSTRAINT ck_atv_status CHECK (status IN ('draft','published','retired')),
  -- ★ 写的时候差点锁死自己：写成 (status='published') = (published_at IS NOT NULL)
  --   会让 retired 版本（曾发布过、published_at 有值）永远存不进去。
  --   正确的等价关系是「非草稿 ⇔ 有发布时间」。
  CONSTRAINT ck_atv_pub    CHECK ((status <> 'draft') = (published_at IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- 冻结触发器：三条都拒
-- ---------------------------------------------------------------------------
-- ★ 第三条（状态回退）是最容易漏的一条：
--   "把 published 改回 draft，再改 definition" —— 每一步都是合法的 UPDATE，
--   只是走了一条弱路径。只防"直接改 definition"的触发器拦不住它。
CREATE OR REPLACE FUNCTION fn_atv_freeze() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.status = 'published' THEN
    IF NEW.definition IS DISTINCT FROM OLD.definition THEN
      RAISE EXCEPTION 'E_VERSION_FROZEN: 已发布版本 % 的定义不可修改，请发布新版本', OLD.id;
    END IF;
    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'E_STATUS_REGRESS: 已发布版本不能退回 draft（只能 retired）';
    END IF;
    IF NEW.version_no <> OLD.version_no OR NEW.template_id <> OLD.template_id THEN
      RAISE EXCEPTION 'E_VERSION_KEY_IMMUTABLE: 版本键不可修改';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_atv_freeze BEFORE UPDATE ON approval_template_version
  FOR EACH ROW EXECUTE FUNCTION fn_atv_freeze();

-- ---------------------------------------------------------------------------
-- 实例与任务
-- ---------------------------------------------------------------------------
CREATE TABLE approval_instance (
  id                  bigint PRIMARY KEY,
  template_version_id bigint NOT NULL REFERENCES approval_template_version(id),
  biz_type            varchar(32) NOT NULL,
  biz_id              bigint NOT NULL,
  status              varchar(16) NOT NULL DEFAULT 'running',
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  CONSTRAINT ck_ai_status CHECK (status IN ('running','approved','rejected','cancelled'))
);

-- ★ 在途锁定：模板版本一旦落在这张单上，不许改。
--   改了之后，"这张单按什么规则批的"就查不到了，而记录看起来完整。
CREATE OR REPLACE FUNCTION fn_ai_version_locked() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.template_version_id <> OLD.template_version_id THEN
    RAISE EXCEPTION 'E_VERSION_LOCKED: 在途单据的模板版本不可改（% → %）',
      OLD.template_version_id, NEW.template_version_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ai_version_locked BEFORE UPDATE ON approval_instance
  FOR EACH ROW EXECUTE FUNCTION fn_ai_version_locked();

CREATE TABLE approval_task (
  id          bigint PRIMARY KEY,
  instance_id bigint NOT NULL REFERENCES approval_instance(id) ON DELETE CASCADE,
  seq         int    NOT NULL,
  approver_id bigint,
  act_kind    varchar(16) NOT NULL DEFAULT 'approve',  -- approve|countersign|transfer|addsign
  parent_task_id bigint,
  status      varchar(16) NOT NULL DEFAULT 'pending',
  acted_at    timestamptz,
  UNIQUE (instance_id, seq),
  CONSTRAINT ck_at_status CHECK (status IN ('pending','approved','rejected','skipped'))
);

-- ---------------------------------------------------------------------------
-- 无 approve_* 工具：产品承诺要被数出来，不是要被相信
-- ---------------------------------------------------------------------------
-- 本仓的开放层（04 §5.3）承诺「101 个工具里没有一个审批工具」。
-- 这条承诺在数据库层的可查形态是：不存在任何以 approve_ 开头的函数。
-- 真正的守卫在 MCP 工具清单里，这里只提供一个不依赖文档的近似判据。
COMMENT ON TABLE approval_task IS
  '产品承诺：开放层不存在 approve_* 工具。审批权是人的责任，不可委托 AI。';
