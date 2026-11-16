-- ============================================================================
-- 003_field_policy.sql · 字段级权限（T01.3）
-- ----------------------------------------------------------------------------
-- 核心命题：**只掩码，不报错。**
--
-- 为什么：报错本身泄露信息 —— "这里有个字段存在，而且敏感"。
-- 掩码返回的是"这里有个值，你看不到"（允许泄露）；
-- 报错返回的是"这里有个你无权访问的东西"（多泄露一层）。
--
-- 另一个被低估的点：**报错会让调用方写 try/catch，而 catch 里通常填默认值。**
-- 一个被 catch 掉的 403 变成 0 元，看起来像"这个人工资是 0"。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 策略表：四态 action × 四出口 scene
-- ---------------------------------------------------------------------------
-- ★ 为什么必须有 scene 这一维：导出必须比列表更严。
--   只有 "字段 × 角色" 两维时，导出和列表共用一个档 —— 而导出的文件会被
--   发到微信群里，列表不会。缺 scene 就上线 = 导出口等于列表口。
CREATE TABLE sys_field_permission (
  id         bigint PRIMARY KEY,
  role_id    bigint NOT NULL,
  resource   varchar(64) NOT NULL,
  field_path varchar(64) NOT NULL,
  scene      varchar(16) NOT NULL,          -- list | detail | export | mcp
  action     varchar(16) NOT NULL,          -- visible | masked | editable | required
  is_ceiling boolean     NOT NULL DEFAULT false,  -- 上限行：下游不得放宽
  reason     varchar(256),
  CONSTRAINT ck_sfp_scene  CHECK (scene  IN ('list','detail','export','mcp')),
  CONSTRAINT ck_sfp_action CHECK (action IN ('visible','masked','editable','required')),
  UNIQUE (role_id, resource, field_path, scene)
);

COMMENT ON COLUMN sys_field_permission.is_ceiling IS
  '上限行：即使别的角色给了 visible，也不得放宽。没有它，"某角色特批"会静默吃掉"这个字段整体不可见"。';

-- ---------------------------------------------------------------------------
-- 2. 求值：多角色取最严，无配置fail-closed
-- ---------------------------------------------------------------------------
-- ★ 三条规则，每条都有对应断言：
--   ① 无配置 → masked（**不是 visible**）。fail-closed：新字段上线不会因为
--      "忘了配"而默认可见。
--   ② 多角色取最严：masked 压过 visible。
--   ③ is_ceiling 行一旦是 masked，任何非 ceiling 的 visible 都不得覆盖它。
CREATE OR REPLACE FUNCTION fn_field_action(
  p_user bigint, p_resource varchar, p_field varchar, p_scene varchar
) RETURNS varchar
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  WITH my_roles AS (
    SELECT ur.role_id
      FROM public.sys_user_role ur
     WHERE ur.user_id = p_user
       AND ur.superseded_by IS NULL
       AND daterange(ur.effective_from, ur.effective_to, '[)') @> current_date
  ), pol AS (
    SELECT fp.action, fp.is_ceiling
      FROM public.sys_field_permission fp
      JOIN my_roles r ON r.role_id = fp.role_id
     WHERE fp.resource = p_resource
       AND fp.field_path = p_field
       AND fp.scene = p_scene
  )
  SELECT COALESCE(
    -- ③ 上限行优先：存在 masked 的上限行时，直接 locked
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE is_ceiling AND action = 'masked')
         THEN 'masked' END,
    -- ② 多角色取最严
    CASE WHEN EXISTS (SELECT 1 FROM pol WHERE action = 'masked') THEN 'masked' END,
    -- ① 其余按"最强授权"取值，但仍以 masked 为默认
    (SELECT action FROM pol WHERE NOT (is_ceiling AND action = 'masked') LIMIT 1),
    'masked'                       -- ★ 无配置 = 掩码，不是可见
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. 掩码应用：返回 NULL / 掩码串，**永不抛错**
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_apply_mask(p_value text, p_action varchar)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_action IN ('visible','editable','required') THEN p_value
    ELSE NULL            -- masked：返回 NULL，由展示层渲染 *** 或 —
  END;
$$;

COMMENT ON FUNCTION fn_apply_mask IS
  '永不抛错。数值字段被掩码返回 NULL 而不是 0 —— 报表上 0 会被读成"这个人工资是 0"，而真相是"你看不到"。';

-- ---------------------------------------------------------------------------
-- 4. 演示表（T01.3 的验收对象）
-- ---------------------------------------------------------------------------
CREATE TABLE employee_demo (
  id          bigint PRIMARY KEY,
  name        varchar(64) NOT NULL,
  id_card_no  varchar(32),
  net_amount  numeric(12,2)
);
