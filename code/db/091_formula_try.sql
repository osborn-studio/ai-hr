-- ============================================================================
-- 091_formula_try.sql · 不抛错的公式校验（给导入用）
-- ----------------------------------------------------------------------------
-- 导入是"逐行校验、汇总错误"的场景：一行公式写错，不该让整批导入炸掉，
-- 更不该让后面的行全部失效。
--
-- 但 PostgreSQL 有个硬规矩：**事务里一条语句失败，整个事务就 abort**，
-- 之后所有语句都返回 "current transaction is aborted"。
-- 所以"在服务层 try/catch 一下继续跑"是行不通的 —— 它会把错误收集器
-- 变成第二个错误源，而那个错误看起来像"导入功能坏了"。
--
-- 解法：把校验包进带 EXCEPTION 块的 plpgsql 函数。块内的失败会隐式
-- ROLLBACK 到 savepoint，事务继续可用，错误文本作为**返回值**交出去。
--
-- fn_formula_check 仍然保留（它抛错，适合"必须过否则别继续"的路径，
-- 比如算薪）；导入走 fn_formula_try（拿文本，继续下一行）。
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_formula_try(p_formula varchar, p_allow jsonb DEFAULT NULL)
RETURNS varchar
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  PERFORM public.fn_formula_check(p_formula, p_allow);
  RETURN NULL;                       -- NULL = 通过
EXCEPTION WHEN others THEN
  RETURN SQLERRM;                    -- 错误文本带业务码，服务层原样给 HR 看
END;
$$;

COMMENT ON FUNCTION fn_formula_try IS
  '不抛错的公式校验：通过返回 NULL，否则返回错误文本（含 E_FORMULA_* 业务码）。'
  '导入必须用它 —— 事务里一条语句失败会让整个事务 abort，"catch 一下继续"是行不通的。';

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.FT','导入：公式逐行校验不中断（失败行拿文本，其余行照进）',
   'PAYROLL','ALGORITHM','fn_formula_try','public','salary_import_row','FUNCTION',
   'team-lead','2027-06-30','node test/run.mjs','node test/run.mjs')
ON CONFLICT (check_code) DO NOTHING;
