-- ============================================================================
-- 116_att_reopen_fix.sql · 重开痕迹是"标记行"，没有前后值
-- ----------------------------------------------------------------------------
-- 115 给 att_period_adjust 加了 ck_apa_changed（改前必须不等于改后）。
-- 那条约束对"改数字"是对的，但把"重开"挡在外面：
-- 重开不改变任何数字，它是状态变化（confirmed → draft），before/after 都是 NULL。
--
-- 两种修法：
--   ① 给它编两个假值（1 → 0 表示"从确认变草稿"）；
--   ② 承认这一类记录，让它不受"值必须变"的约束。
--
-- 选 ②：假值会被下一个人当成真值去解释（"1 是什么？"），
-- 而字段名 __reopen__ 已经足够说明它是什么。
-- ============================================================================

ALTER TABLE att_period_adjust DROP CONSTRAINT IF EXISTS ck_apa_changed;

ALTER TABLE att_period_adjust ADD CONSTRAINT ck_apa_changed CHECK (
  -- 重开是状态变化，没有"改前改后"，不受值变化约束
  field_name = '__reopen__'
  OR before_value IS DISTINCT FROM after_value
);

COMMENT ON CONSTRAINT ck_apa_changed ON att_period_adjust IS
  '改数字必须真的变了（before ≠ after）；__reopen__ 是状态痕迹，没有前后值。';
