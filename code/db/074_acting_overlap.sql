-- ============================================================================
-- 074_acting_overlap.sql · 同一对代理不得重叠（迁移一旦发布就不再改 073）
-- ----------------------------------------------------------------------------
-- 073 发布后，真跑发现：重复执行"设定代理"会插出第二条有效代理，
-- 于是「谁在代理我」显示两条、"副手有两次授权" —— 而两条其实同义。
--
-- 修法是排他约束（区间不重叠），不是"插入前先查"：
--   并发两次点击都能通过"先查"，只有约束能挡住它。同 014 的排他约束一条思路。
--
-- ★ 为什么不直接改 073：迁移是账本（schema_migration 记着文件名与哈希）。
--   改已发布的迁移会让"文件里的 schema"与"库里的 schema"分叉，
--   而下一个接手的人会按文件去理解库。变更一律新增。
-- ============================================================================

-- 先把历史重复清掉（保留最早那条，因为它才是"设定人当时的意思"）
WITH dup AS (
  SELECT id, row_number() OVER (PARTITION BY principal_user, agent_user, role_id
                                ORDER BY valid_from, id) AS rn
    FROM sys_acting_grant
   WHERE revoked_at IS NULL
)
UPDATE sys_acting_grant g
   SET revoked_at = now(),
       reason = left(g.reason || '（重复，074 清理）', 200)
  FROM dup WHERE dup.id = g.id AND dup.rn > 1;

ALTER TABLE sys_acting_grant DROP CONSTRAINT IF EXISTS ex_ag_no_overlap;
ALTER TABLE sys_acting_grant ADD CONSTRAINT ex_ag_no_overlap
  EXCLUDE USING gist (principal_user WITH =, agent_user WITH =, role_id WITH =,
                      tstzrange(valid_from, valid_to) WITH &&)
  WHERE (revoked_at IS NULL);

COMMENT ON CONSTRAINT ex_ag_no_overlap ON sys_acting_grant IS
  '同一（主管，副手，角色）的有效代理时间不得重叠：重复点"设定"不该变成两条授权。';
