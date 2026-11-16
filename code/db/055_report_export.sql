-- ============================================================================
-- 055_report_export.sql · 导出：能看不能导，等于把报表锁在浏览器里
-- ----------------------------------------------------------------------------
-- 报表页从 023 起就能看，但**没有导出**。业务的实际动作不是"看"，是
-- "把这页发给财务/店长"，而那时人会截图、或者把数字手抄进 Excel。
-- 手抄出来的那份表，是这个系统里**唯一没有口径**的数字 ——
-- 它离开系统之后就再也没有人知道它是期末还是日均。
--
-- 导出这一件事有三个必须落在库里的理由（不是"顺手加个按钮"）：
--
--   ① **导出的数必须与页面同源**。另写一句 sum() 就是第三份实现，
--      而 023 的整套设计就是在防这一件事。
--   ② **导出要留痕**。HR 数据是能被转发的东西；"谁在什么时候把
--      哪个组织哪个月导走了多少行"答不出来时，事后无法追。
--   ③ **被拒的导出不能留痕**。审计表里混进"尝试过但没成"的记录，
--      它会和真正的导出一样长，于是这一列不再可信。
--
-- 本迁移只做"留痕与自证"这部分；CSV 的写法（BOM / 转义 / 公式注入）
-- 在 app/csv.mjs —— 那是字符串层面的事，库里没有位置。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 导出留痕（只增不改）
-- ---------------------------------------------------------------------------
CREATE TABLE report_export (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exported_by    varchar(64) NOT NULL,
  org_id         bigint      NOT NULL REFERENCES org_unit(id),
  period         varchar(7)  NOT NULL,
  -- 行数 / 字节数 / 内容摘要：三个数一起才能回答"导出的到底是哪一份"
  -- 只记行数不够 —— 同一期同一组织两次导出可能行数相同而内容不同（口径改过）
  row_count      int         NOT NULL,
  bytes          int         NOT NULL,
  content_sha256 char(64)    NOT NULL,
  exported_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_re_period CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_re_rows   CHECK (row_count > 0),
  CONSTRAINT ck_re_bytes  CHECK (bytes > 0),
  CONSTRAINT ck_re_sha    CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE report_export IS
  '导出留痕：谁 / 哪个组织 / 哪一期 / 多少行 / 内容 sha256。'
  '行数为 0 的导出直接拒绝（见 ck_re_rows）—— 一个空文件被发出去，'
  '收到的人只会认为"这个月没数据"，而真因可能是参数写错。';

CREATE OR REPLACE FUNCTION fn_re_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'E_RE_NO_DELETE: 导出留痕不可删（删掉之后"这份表谁导的"就没有答案了）';
  END IF;
  RAISE EXCEPTION 'E_RE_NO_UPDATE: 导出留痕只增不改（改了摘要，它就不再证明任何事）';
END;
$$;

CREATE TRIGGER trg_re_append_only
  BEFORE UPDATE OR DELETE ON report_export
  FOR EACH ROW EXECUTE FUNCTION fn_re_append_only();

-- ---------------------------------------------------------------------------
-- 2. 写入：一个函数，入参就是"这一份文件"的全部事实
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_report_export_log(
  p_by     varchar,
  p_org    bigint,
  p_period varchar,
  p_rows   int,
  p_bytes  int,
  p_sha    char(64)
) RETURNS bigint
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE v_id bigint;
BEGIN
  IF p_rows IS NULL OR p_rows <= 0 THEN
    RAISE EXCEPTION 'E_EXPORT_EMPTY: 导出了 0 行——空文件比没有文件更危险，'
      '收到的人会认为"这个月没数据"';
  END IF;
  IF p_sha IS NULL OR p_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'E_EXPORT_NO_DIGEST: 导出必须带内容摘要（没有摘要，事后无法证明'
      '"文件没被改过"）';
  END IF;

  INSERT INTO public.report_export(exported_by, org_id, period, row_count, bytes, content_sha256)
  VALUES (p_by, p_org, p_period, p_rows, p_bytes, p_sha)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. 这一期到底有没有数据
-- ---------------------------------------------------------------------------
-- ★ 报表最坏的失败不是算错，是**周期写错时返回一排 0**。
--   0 和"没有数据"在页面上同形，而 0 会被当成事实引用。
--   有了这个函数，接口可以在 has_data=false 时明说"该期无数据"。
CREATE OR REPLACE FUNCTION fn_rpt_has_data(p_period varchar)
RETURNS boolean
LANGUAGE plpgsql STABLE
SET search_path = ''
AS $$
DECLARE d date;
BEGIN
  IF p_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'E_PERIOD_INVALID: 期间必须是 YYYY-MM，收到 %', p_period;
  END IF;
  d := (p_period || '-01')::date;

  RETURN EXISTS (SELECT 1 FROM public.attendance_daily_store
                  WHERE work_date >= d AND work_date < d + interval '1 month')
      OR EXISTS (SELECT 1 FROM public.pay_run WHERE period = p_period)
      OR EXISTS (SELECT 1 FROM public.headcount_budget
                  WHERE period = p_period);
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. 审计视角：谁在往外带数据
-- ---------------------------------------------------------------------------
-- 不是告警（阈值属于制度，见 021 的 policy_def，不在视图里写死），
-- 只是把"同一人同一天导了几次、共几行"摆出来给人看。
CREATE VIEW v_report_export_daily AS
SELECT exported_by,
       exported_at::date          AS export_date,
       count(*)::int              AS times,
       sum(row_count)::int        AS rows_total,
       min(exported_at)           AS first_at,
       max(exported_at)           AS last_at
  FROM report_export
 GROUP BY exported_by, exported_at::date;

COMMENT ON VIEW v_report_export_daily IS
  '导出审计视角。阈值故意不写在这里：多少次算异常是制度，'
  '写死在视图里就变成"技术替客户决定"。';

-- ---------------------------------------------------------------------------
-- 5. 资源登记：导出是独立资源（报表能看，不等于能把整张表带走）
-- ---------------------------------------------------------------------------
-- ★ 未登记的资源在 app_begin_scope 里直接拒绝 —— 默认放行是权限系统
--   唯一不可接受的默认值。登记在这里，而不是靠"反正没人查"。
INSERT INTO sys_perm_resource(resource_code, label, temporal_basis) VALUES
  ('report', '经营报表', 'CURRENT')
ON CONFLICT (resource_code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. 断言组登记
-- ---------------------------------------------------------------------------
INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.RP','导出留痕：只增不改、摘要必填、0 行不许导出','SECURITY','ACL',
   'fn_report_export_log','public','report_export','FUNCTION','team-lead','2027-03-31',
   'node test/run.mjs','node test/run.mjs'),
  ('SUITE.API-XP','报表导出接口：同源、越权被拒、拒了不留痕','SECURITY','ACL',
   'fn_rpt_panel','public','report_export','FUNCTION','team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
