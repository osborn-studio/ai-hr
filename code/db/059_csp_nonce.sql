-- ============================================================================
-- 059_csp_nonce.sql · 收掉 script-src 'unsafe-inline'（只登记判据，不改数据结构）
-- ----------------------------------------------------------------------------
-- 到 058 为止，界面的 CSP 一直是：
--
--   script-src 'unsafe-inline'
--
-- 而 README 里把它写成"已知的让步"。让步的理由是真的：界面是单文件、脚本内联。
-- 但**让步不等于必须一直让**：内联脚本用 nonce 就够，不需要把脚本拆成文件。
--   · 每次请求生成一个新 nonce，注入 <script nonce="...">，同时写进 CSP；
--   · 注入者拿不到下一次的 nonce，所以注入的 <script> 不会执行。
--
-- 这一轮同时把**接口**的 CSP 收到 script-src 'none'：JSON / CSV 响应不需要
-- 任何脚本能力，而它们原来跟着界面一起吃 'unsafe-inline'。
-- 一个响应类型对应一份能力，这件事之前是"顺手共用一套头"。
--
-- style-src 仍留 'unsafe-inline'：页面里有 27 处 style="..." 属性，
-- CSP3 要求用 'unsafe-hashes' 逐条列举，成本远大于收益（CSS 注入与脚本注入
-- 不是一个量级）。这一条**写明的取舍**，不是遗漏。
--
-- 本迁移没有表/函数改动 —— 它只是把判据登记进登记表。
-- 为什么还要占一个迁移号：本仓的规矩是"新增断言组必须登记"，
-- 而登记只能发生在迁移里（否则新库上没有这一行）。没有登记的组，
-- 跑完的结论写不进去，覆盖率报告上它是"从未运行"。
-- ============================================================================

INSERT INTO sys_check_registry
  (check_code, name, domain, kind, guard_object, guard_schema, guard_table, guard_kind,
   guard_debt_owner, guard_debt_due, runner, assertion_sql) VALUES
  ('SUITE.API-NH','CSP：界面用每次请求新生成的 nonce，接口不给任何脚本能力',
   'SECURITY','ACL',
   -- guard_object 与 guard_kind 同生同灭（ck_scr_guard）：这一条没有"结构"要守，
   -- 守的是响应头 —— 所以两者都给 NULL，债由 owner+due 认领。
   NULL,NULL,NULL,NULL,'team-lead','2027-03-31',
   'node test/api.test.mjs','node test/api.test.mjs')
ON CONFLICT (check_code) DO NOTHING;
