// ============================================================================
// run.mjs · 权限核心的可执行验收
// ----------------------------------------------------------------------------
// 引擎：PGlite = PostgreSQL 18.6 编译成 WASM。**不是模拟器**，是真 PG。
// 运行：node ai-hr/code/test/run.mjs
//
// 注意版本差：设计基准是 PG 16，本机是 18.6。每条断言结果都带版本号，
// 因为它只证明「在 18.6 上成立」——换 16 要重跑，不能把结论直接搬过去。
// ============================================================================
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, '..', 'db');

const results = [];
function rec(id, what, ok, note = '') {
  results.push({ id, what, ok, note });
}

// ★ 驱动可换：设了 DATABASE_URL 就打到**真 PostgreSQL**，否则用 PGlite。
//   换驱动是这条判据本身的最后一块：`app/db.mjs` 的双驱动只在 app 层跑过，
//   而 300 多条库断言一直只在 WASM 版上验过 —— "同一个引擎"是同一个引擎的两个构建，
//   但构建差异（contrib、权限、locale、并行）会以"某条断言只在一个构建上成立"出现。
//   ★ 真库上必须 `PG_POOL_MAX=1`：整套断言默认"一次会话"，池化会把临时表
//   分到不同连接上（那正是 AE5 那个洞）。
const USE_PG = !!process.env.DATABASE_URL;
// ★ 两条路都走**同一个封装**（app/db.mjs 的 createDb）：V2/V3 那两条断言要用
//   withTx（= 一个事务一条连接），而 withTx 只认这个封装。
//   原来 PGlite 分支直接用裸 PGlite 实例，于是那两条在 PGlite 上"从来没跑对过"——
//   一跑就是 `db._lock is not a function`，只是因为真库分支先被写出来才暴露。
const { createDb: createDb2, withTx } = await import('../app/db.mjs');
const db = await createDb2({ url: process.env.DATABASE_URL || undefined });

await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
if (USE_PG) {
  // 空库才建：迁移里有 CREATE TABLE，重跑会炸；而炸出来的报错看起来像迁移写错了。
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'`)).rows[0].n);
  if (n > 0) {
    console.error(`\n[真库] public schema 里已经有 ${n} 张表。请指向一个空库：\n`
      + `  createdb aihr_test && DATABASE_URL=postgres://.../aihr_test PG_POOL_MAX=1 node test/run.mjs\n`);
    process.exit(2);
  }
}
const ver = (await db.query("select current_setting('server_version_num') as v")).rows[0].v;

// ---------- 建库 ----------
// ★ 迁移清单**只有一个来源：db/ 目录本身**。
//   原来这里手抄了 001..027 一串文件名，而 server.mjs 里有另一串 ——
//   加 028 时只改了一处，于是两套测试用的库不是同一个库。
//   两份清单必然不同步，且不同步的那一次没有任何断言会红。
const MIGRATIONS = readdirSync(DB).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
for (const m of MIGRATIONS) await db.exec(readFileSync(join(DB, m), 'utf8'));
// ★ 真库上要**在建完之后**显式初始化会话：app_init_session 是 001 建出来的，
//   建之前调它只会得到 "function does not exist"。PGlite 那条路在 createDb 里
//   已经 catch 过这一次，池化那条路必须自己来。
if (USE_PG) await db.initSession();

// ---------- 种子数据 ----------
await db.exec(`
INSERT INTO sys_perm_dim(code, kind, label) VALUES
  ('cost_org',            'org',    '成本组织'),
  ('attendance_org',      'org',    '考勤组织'),
  ('payroll_legal_entity','entity', '发薪法人'),
  ('si_entity',           'entity', '参保主体')
ON CONFLICT (code) DO NOTHING;

-- ★ ON CONFLICT 不能省：064 起 attendance_daily 也在迁移里登记了
--   （资源码是 schema 事实），种子在"既跑过迁移又跑种子"的库上会撞主键。
INSERT INTO sys_perm_resource(resource_code, label, temporal_basis) VALUES
  ('attendance_daily', '考勤人日', 'CURRENT'),
  ('salary_snapshot',  '工资快照', 'FACT_SNAPSHOT')
ON CONFLICT (resource_code) DO NOTHING;

INSERT INTO org_unit(id, parent_id, name, path) VALUES
  (1,  NULL, '集团',  '001'),
  (10, 1,    'A店',   '001.010'),
  (11, 1,    'B店',   '001.011'),
  (20, 1,    'C店',   '001.020');

INSERT INTO sys_data_scope(id, name, combinator) VALUES
  (100, '集团HR', 'intersection'),
  (200, 'A店HR',  'intersection');

INSERT INTO sys_data_scope_rule(data_scope_id, dimension, value_type, value_ids) VALUES
  (100, 'cost_org',             'nodes', ARRAY[10,11,20]::bigint[]),
  (100, 'attendance_org',       'nodes', ARRAY[10,11,20]::bigint[]),
  (100, 'payroll_legal_entity', 'nodes', ARRAY[1]::bigint[]),
  (100, 'si_entity',            'nodes', ARRAY[1]::bigint[]),
  (200, 'cost_org',             'node_subtree', ARRAY[10]::bigint[]),
  (200, 'attendance_org',       'nodes', ARRAY[10]::bigint[]),
  (200, 'payroll_legal_entity', 'nodes', ARRAY[1]::bigint[]),
  (200, 'si_entity',            'nodes', ARRAY[1]::bigint[]);

INSERT INTO sys_user_role(id, user_id, role_id, data_scope_id, effective_from) VALUES
  (1, 1, 1, 100, '2026-01-01'),
  (2, 2, 2, 200, '2026-01-01'),
  (3, 4, 4, 200, '2026-01-01');

-- user 3 没有任何授予；user 4 有授予但命中 deny
INSERT INTO sys_permission_deny(id, role_id, dimension, value_ids) VALUES
  (1, 4, 'cost_org', ARRAY[10]::bigint[]);

CREATE TABLE t_guard(a int, CONSTRAINT chk_t_guard CHECK (a > 0));

CREATE TABLE salary_line(
  id bigint PRIMARY KEY, payroll_legal_entity_id bigint, si_entity_id bigint,
  cost_org_id bigint, attendance_org_id bigint, amount numeric(12,2));

INSERT INTO salary_line VALUES
  (1, 1, 1, 10, 10, 8000),
  (2, 1, 1, 11, 11, 9000),
  (3, 1, 1, 20, 20, 7000);
`);

// 业务 SQL 的统一写法：每维度一个 EXISTS + deny 用 NOT EXISTS
const SCOPED = (t) => `
  SELECT count(*)::int AS n FROM ${t} x
   WHERE EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                  WHERE s.dim_code='cost_org' AND s.org_id = x.cost_org_id)
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                  WHERE s.dim_code='attendance_org' AND s.org_id = x.attendance_org_id)
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_entity s
                  WHERE s.dim_code='payroll_legal_entity' AND s.entity_id = x.payroll_legal_entity_id)
     AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_entity s
                  WHERE s.dim_code='si_entity' AND s.entity_id = x.si_entity_id)
     AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_deny d
                      WHERE d.dim_code='cost_org' AND d.org_id = x.cost_org_id)`;

async function scopeCount(user, fact = null) {
  await db.query('SELECT app_begin_scope($1,$2,$3)', [user, 'attendance_daily', fact]);
  return (await db.query(SCOPED('salary_line'))).rows[0].n;
}
async function expectErr(fn, code, id, what) {
  try { await fn(); rec(id, what, false, '期望抛错，实际未抛'); }
  catch (e) {
    const ok = String(e.message).includes(code);
    rec(id, what, ok, ok ? `SQLSTATE ${e.code}` : `期望含 ${code}，实际: ${String(e.message).split('\n')[0]}`);
  }
}

// ---------- A0 未初始化会话 → 临时表不存在 → TRUNCATE 报 3F000 ----------
// ★ 这条断言存在的理由：文档只写了 app_begin_scope 里 TRUNCATE 四张临时表，
//   从没说它们由谁创建。不初始化时，第一个请求就死在 TRUNCATE 上，
//   而错误码 3F000（invalid_schema_name）看起来像 schema 权限问题，不像"少建一张表"。
{
  // ★ 真库上必须**另开一条裸连接**：`app/db.mjs` 的池化路径现在对每次取用都做
  //   app_init_session（那个洞的修法），所以用 db.query 永远造不出"没初始化过"的
  //   会话 —— 这条断言会在真库上假失败（"未初始化却成功了"）。
  //   用一条不经过封装的 Client，才真的是一条新会话。
  let ok = false, note = '';
  const tryBare = async (run) => {
    try {
      await run();
      note = '未初始化却成功了 —— 说明临时表在别处被建，或 TRUNCATE 被跳过';
    } catch (e) { ok = e.code === '3F000'; note = `${e.code} on TRUNCATE pg_temp.*`; }
  };
  if (USE_PG) {
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await tryBare(() => c.query('SELECT app_begin_scope(1,$1,$2)', ['attendance_daily', null]));
    await c.end();
    note += '（裸连接）';
  } else {
    await tryBare(() => db.query('SELECT app_begin_scope(1,$1,$2)', ['attendance_daily', null]));
  }
  rec('A0', '未调 app_init_session 时，入口函数报 3F000（证明临时表必须由会话建）', ok, note);
}

// ---------- 会话初始化 ----------
await db.query('SELECT app_init_session()');

// ---------- A1 入口函数五条件 ----------
{
  const r = (await db.query(`
    SELECT count(*)::int AS only_one,
           bool_and(n.nspname='public') AS in_public,
           bool_and(p.pronargdefaults=0) AS no_default,
           bool_and(p.prosecdef=false)   AS not_definer,
           bool_and(p.prosrc ~ 'RAISE[^;]*E_RESOURCE_UNREGISTERED'
                AND p.prosrc ~ 'RAISE[^;]*E_FACT_DATE_REQUIRED') AS body_intact
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE p.proname='app_begin_scope'`)).rows[0];
  rec('A1', '入口函数：唯一 / public / 无默认值 / 非 definer / 双拒绝码',
      r.only_one === 1 && r.in_public && r.no_default && r.not_definer && r.body_intact,
      JSON.stringify(r));
}

// ---------- A2 未登记资源必须抛 ----------
await expectErr(() => db.query('SELECT app_begin_scope(1,$1,$2)', ['zz_unregistered', null]),
  'E_RESOURCE_UNREGISTERED', 'A2', '未登记资源 → E_RESOURCE_UNREGISTERED（默认拒绝）');

// ---------- A2b 阳性对照：同一函数换成已登记资源不得抛 ----------
try {
  await db.query('SELECT app_begin_scope(1,$1,$2)', ['attendance_daily', null]);
  rec('A2b', '阳性对照：已登记资源不抛（证明 A2 不是「函数永远抛」）', true);
} catch (e) { rec('A2b', '阳性对照', false, String(e.message).split('\n')[0]); }

// ---------- A3 四维全空 = 无权限（不是全部权限） ----------
{
  const n = await scopeCount(3);
  rec('A3', '四维全空 → 0 行（不是全表）', n === 0, `实际 ${n} 行`);
}

// ---------- A4 FACT_SNAPSHOT 缺日期必须抛 ----------
await expectErr(() => db.query('SELECT app_begin_scope(1,$1,$2)', ['salary_snapshot', null]),
  'E_FACT_DATE_REQUIRED', 'A4', 'FACT_SNAPSHOT 不传 p_fact_from → E_FACT_DATE_REQUIRED');

// ---------- A5 集团 HR 看全，A店 HR 收窄 ----------
{
  const n1 = await scopeCount(1);
  const n2 = await scopeCount(2);
  rec('A5', 'intersection：集团HR 3 行 / A店HR 1 行', n1 === 3 && n2 === 1, `集团=${n1} A店=${n2}`);
}

// ---------- A6 deny 压过 allow ----------
{
  const n = await scopeCount(4);
  const allowed = (await db.query(`SELECT count(*)::int AS n FROM pg_temp.tmp_scope_org WHERE dim_code='cost_org'`)).rows[0].n;
  rec('A6', 'deny 命中 → 0 行，且 allow 集合未被删（仍 1 行）', n === 0 && allowed === 1,
      `可见=${n} allow行=${allowed}`);
}

// ---------- A7 维度 kind 越界：两道防线 ----------
await expectErr(() => db.exec(`INSERT INTO sys_perm_dim(code,kind,label) VALUES ('bad_dim2','region','越界')`),
  'ck_spd_kind', 'A7a', 'kind 越界被 CHECK 拒绝（第一道）');
{
  // 再验函数层守卫：临时放宽 CHECK，插入越界行后调用函数
  await db.exec(`ALTER TABLE sys_perm_dim DROP CONSTRAINT ck_spd_kind`);
  await db.exec(`INSERT INTO sys_perm_dim(code,kind,label) VALUES ('bad_dim3','region','越界')`);
  await expectErr(() => db.query('SELECT app_begin_scope(1,$1,$2)', ['attendance_daily', null]),
    'E_PERM_DIM_UNSUPPORTED', 'A7b', 'kind 越界绕过 CHECK 后，函数守卫仍 RAISE');
  await db.exec(`DELETE FROM sys_perm_dim WHERE code='bad_dim3'`);
  await db.exec(`ALTER TABLE sys_perm_dim ADD CONSTRAINT ck_spd_kind CHECK (kind IN ('org','entity','person'))`);
}

// ---------- A8 受限授权上限（今天补的 ck_ur_kind_span） ----------
{
  let ok = false, note = '';
  try {
    await db.exec(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,grant_kind,effective_from,effective_to)
                   VALUES (90, 9, 9, 100, 'TEMP_ACT_AS', '2026-01-01', '2026-01-09')`);
    note = '8 天被接受 —— 上限没生效';
  } catch (e) { ok = String(e.message).includes('ck_ur_kind_span'); note = e.code; }
  rec('A8', 'TEMP_ACT_AS 8 天被拒（上限 7 天）', ok, note);
}
{
  let ok = false, note = '';
  try {
    await db.exec(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,grant_kind,effective_from,effective_to)
                   VALUES (91, 9, 9, 100, 'TEMP_ACT_AS', '2026-01-01', '2026-01-08')`);
    ok = true; note = '恰好 7 天被接受';
  } catch (e) { note = e.code + ' ' + String(e.message).split('\n')[0]; }
  rec('A8b', 'TEMP_ACT_AS 恰好 7 天被接受（边界内侧）', ok, note);
}
{
  let ok = false, note = '';
  try {
    await db.exec(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,grant_kind,effective_from,effective_to)
                   VALUES (92, 9, 9, 100, 'HANDOVER_READONLY', '2026-01-01', '2026-04-02')`);
    note = '91 天被接受';
  } catch (e) { ok = String(e.message).includes('ck_ur_kind_span'); note = e.code; }
  rec('A8c', 'HANDOVER_READONLY 91 天被拒（上限 90 天）', ok, note);
}
{
  let ok = false, note = '';
  try {
    await db.exec(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,grant_kind,effective_from,effective_to)
                   VALUES (93, 9, 9, 100, 'ROLE', '2026-01-01', NULL)`);
    ok = true; note = 'ROLE 无上限，接受';
  } catch (e) { note = String(e.message).split('\n')[0]; }
  rec('A8d', 'ROLE 无期限被接受（上限只约束受限 kind）', ok, note);
}

// ---------- A9 区间重叠被拒（EXCLUDE + btree_gist） ----------
{
  let ok = false, note = '';
  try {
    await db.exec(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,grant_kind,effective_from,effective_to)
                   VALUES (94, 1, 1, 100, 'ROLE', '2026-06-01', '2026-12-31')`);
    note = '重叠被接受';
  } catch (e) { ok = e.code === '23P01'; note = e.code; }
  rec('A9', '同一(user,role,scope,kind) 区间重叠 → 23P01', ok, note);
}

// ---------- A10 阴性对照 ----------
{
  const r = (await db.query('SELECT 1 = 0 AS must_be_false')).rows[0].must_be_false;
  rec('A10', '常驻阴性对照 SELECT 1=0 必须为 false', r === false, String(r));
}

// ===========================================================================
// B 组 · 检查登记表（002）
// ===========================================================================
const REG = `INSERT INTO sys_check_registry
  (check_code,name,domain,kind,runner,assertion_sql,guard_object,guard_schema,guard_table,
   guard_kind,guard_debt_owner,guard_debt_due,expected_object,waived_reason,waived_period,
   waived_by,verdict,verdict_due,verdict_owner,required_since)
  VALUES ($1,$2,'PERM','ACL','f','sql',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'2026-01-01')`;

// B1 豁免两件（缺审批人）必须被拒
await expectErr(() => db.query(REG,
  ['B1','n','chk_t_guard','public','t_guard','CONSTRAINT',null,null,null,
   '理由','[2026-01-01,2026-02-01)',null,'green',null,null]),
  'ck_scr_waive', 'B1', '豁免只填理由+期间、缺 waived_by → 被拒（三列同生同灭）');

// B2 三件齐 → 接受
{
  let ok = false, note = '';
  try {
    await db.query(REG, ['B2','n','chk_t_guard','public','t_guard','CONSTRAINT',null,null,null,
      '理由','[2026-01-01,2026-02-01)','zhang','green',null,null]);
    ok = true; note = '三列齐全接受';
  } catch (e) { note = e.code + ' ' + String(e.message).split('\n')[0]; }
  rec('B2', '豁免三件齐 → 接受', ok, note);
}

// B3 到期由时间自己完成：期间内 waived，期间外回到真实 verdict
{
  const inP  = (await db.query("SELECT effective_verdict v FROM fn_chk_effective('2026-01-15'::date) WHERE check_code='B2'")).rows[0]?.v;
  const outP = (await db.query("SELECT effective_verdict v FROM fn_chk_effective('2026-03-01'::date) WHERE check_code='B2'")).rows[0]?.v;
  rec('B3', '豁免期内=waived、期外回 green（无巡检、无写回）', inP === 'waived' && outP === 'green',
      `期内=${inP} 期外=${outP}`);
}

// B4 SOD：豁免人 = 承诺修的人 → 被拒
await expectErr(() => db.query(REG,
  ['B4','n','chk_t_guard','public','t_guard','CONSTRAINT',null,null,null,
   '理由','[2026-01-01,2026-02-01)','same_guy','yellow','2026-02-01','same_guy']),
  'ck_scr_waive_sod', 'B4', 'waived_by = verdict_owner → 被拒（自己给自己发豁免）');

// B5 guard_kind 与解析结果不一致 → guard_kind_mismatch
{
  await db.query(REG, ['B5','n','chk_t_guard','public','t_guard','TRIGGER',null,null,null,
    null,null,null,'green',null,null]);
  const st = (await db.query("SELECT guard_state, resolved_kind FROM v_chk_guard_unbacked WHERE check_code='B5'")).rows[0];
  rec('B5', '声明 TRIGGER 实际是 CONSTRAINT → guard_kind_mismatch',
      st.guard_state === 'guard_kind_mismatch', `state=${st.guard_state} 解析=${st.resolved_kind}`);
}

// B6 guard_object 指向不存在的对象 → guard_missing（第三档 fail，不是 not_applicable）
{
  await db.query(REG, ['B6','n','chk_no_such','public','t_guard','CONSTRAINT',null,null,null,
    null,null,null,'green',null,null]);
  const st = (await db.query("SELECT guard_state FROM v_chk_guard_unbacked WHERE check_code='B6'")).rows[0];
  rec('B6', 'guard 指向不存在的约束 → guard_missing（fail，不是 not_applicable）',
      st.guard_state === 'guard_missing', `state=${st.guard_state}`);
}

// B7 没建的对象走债分支：无 owner/due → 被拒；有 → 接受（不扩 guard_kind 枚举）
await expectErr(() => db.query(REG,
  ['B7a','n',null,null,null,null,null,null,'sys_exception_kind',
   null,null,null,'green',null,null]),
  'ck_scr_debt', 'B7a', 'guard_object 为空且无 owner/due → 被拒');
{
  let ok = false, note = '';
  try {
    await db.query(REG, ['B7b','n',null,null,null,null,'wang','2026-06-30','sys_exception_kind',
      null,null,null,'green',null,null]);
    ok = true; note = '走债分支，expected_object 记将来要建什么';
  } catch (e) { note = e.code + ' ' + String(e.message).split('\n')[0]; }
  rec('B7b', '「还没建的东西」走 ck_scr_debt 分支，不扩 guard_kind 枚举', ok, note);
}

// B8 覆盖面：waived 单独成桶，且分母仍是 enabled 全量
{
  // ★ 不写显式 id。写了它，IDENTITY 的序列不会前进，
  //   下一次自动插入就撞主键——这个坑本仓已经踩过五次（见 Q14）。
  await db.exec(`INSERT INTO sys_check_run(check_code, outcome) VALUES
    ('B5','pass'),('B6','fail'),('B7b','pass')`);
  const rows = (await db.query(`
    SELECT bucket, count(*)::int n FROM fn_chk_coverage('2026-01-15'::date) GROUP BY bucket ORDER BY bucket`)).rows;
  const m = Object.fromEntries(rows.map(r => [r.bucket, r.n]));
  const total = (await db.query(`SELECT count(*)::int n FROM fn_chk_coverage('2026-01-15'::date)`)).rows[0].n;
  const enabled = (await db.query(`SELECT count(*)::int n FROM sys_check_registry WHERE enabled`)).rows[0].n;
  rec('B8', '覆盖率四桶分开、waived 独立、分母= enabled 全量不减',
      m.waived >= 1 && total === enabled,
      `桶=${JSON.stringify(m)} 合计=${total} enabled=${enabled}`);
}


// ===========================================================================
// C 组 · 字段权限（003）：只掩码不报错
// ===========================================================================
await db.exec(`
INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,effective_from) VALUES
  (10,5,1,100,'2026-01-01'),
  (11,5,4,100,'2026-01-01'),
  (12,6,4,100,'2026-01-01'),
  (13,6,5,100,'2026-01-01');

INSERT INTO sys_field_permission(id,role_id,resource,field_path,scene,action,is_ceiling) VALUES
  (1,1,'employment','net_amount','detail','visible',false),
  (2,4,'employment','net_amount','detail','masked', false),
  (3,4,'employment','id_card_no','detail','masked', true),
  (4,5,'employment','id_card_no','detail','visible',false);
`);

const act = async (u,f,sc) =>
  (await db.query('SELECT fn_field_action($1,$2,$3,$4) a',[u,'employment',f,sc])).rows[0].a;

{ const a = await act(1,'net_amount','detail');
  rec('C1','有权 detail → visible', a==='visible', a); }

{ const a = await act(1,'net_amount','export');
  rec('C2','未配置的 scene(fail-closed) → masked，不是 visible', a==='masked', a); }

{ const a = await act(5,'net_amount','detail');
  const b = await act(6,'id_card_no','detail');
  rec('C3','多角色取最严 visible+masked → masked', a==='masked', a);
  rec('C4','is_ceiling masked 不被非 ceiling 的 visible 覆盖', b==='masked', b); }

{ // 掩码永不抛错，且数值掩码返回 NULL 而不是 0
  let ok=false, note='';
  try {
    const r = (await db.query("SELECT fn_apply_mask('8000.00','masked') v, fn_apply_mask('8000.00','visible') w")).rows[0];
    ok = r.v === null && r.w === '8000.00';
    note = `masked=${r.v} visible=${r.w}`;
  } catch(e){ note = '抛错了: '+e.code; }
  rec('C5','掩码返回 NULL 不返回 0，且永不抛错', ok, note); }

// ===========================================================================
// D 组 · 审计（004）：记录点在库里，且没有 DELETE 路径
// ===========================================================================
{ await db.exec(`INSERT INTO employee_demo VALUES (1,'张三','310101199001011234',8000)`);
  const r = (await db.query(`SELECT count(*)::int n, min(session_user_name) su FROM sys_audit_log`)).rows[0];
  rec('D1','INSERT → 审计 +1 且记录 session_user', r.n===1 && !!r.su, `n=${r.n} su=${r.su}`); }

{ await db.exec(`UPDATE employee_demo SET net_amount = 9000 WHERE id = 1`);
  const r = (await db.query(`SELECT old_row->>'net_amount' o, new_row->>'net_amount' n
                               FROM sys_audit_log WHERE op='U'`)).rows[0];
  rec('D2','UPDATE 记录 old/new 两个值', r?.o==='8000.00' && r?.n==='9000.00', `${r?.o} → ${r?.n}`); }

{ // app_role 无 DELETE 权限
  await db.exec('SET ROLE app_role');
  let code='';
  try { await db.exec('DELETE FROM sys_audit_log'); } catch(e){ code=e.code; }
  await db.exec('RESET ROLE');
  rec('D3','app_role DELETE 审计表 → 42501', code==='42501', code||'未被拒'); }

{ // TRUNCATE 必须单独测：它不触发触发器、不走行级权限
  await db.exec('SET ROLE app_role');
  let code='';
  try { await db.exec('TRUNCATE sys_audit_log'); } catch(e){ code=e.code; }
  await db.exec('RESET ROLE');
  rec('D4','app_role TRUNCATE 审计表 → 42501（DELETE 测不出来）', code==='42501', code||'未被拒'); }

{ const r = (await db.query(`
    SELECT has_table_privilege('app_role','sys_audit_log','UPDATE') u,
           has_table_privilege('app_role','sys_audit_log','DELETE') d,
           has_table_privilege('app_role','sys_audit_log','TRUNCATE') t,
           has_table_privilege('app_role','sys_audit_log','INSERT') i`)).rows[0];
  rec('D5','权限位：UPDATE/DELETE/TRUNCATE 全 false，INSERT true',
      r.u===false && r.d===false && r.t===false && r.i===true, JSON.stringify(r)); }


// ===========================================================================
// E 组 · 考勤人日（005）：钱在这里
// ===========================================================================
// 一行合法数据：08:00–16:00 = 8h；在岗 8h，在岗休息 1h，计出勤 7h，allowance 口径 work=6h
const ADS = `INSERT INTO attendance_daily_store
  (id,employee_id,store_id,work_date,shift_start_at,shift_end_at,
   span_hours,on_duty_hours,off_duty_hours,break_on_duty_hours,in_attendance_hours,work_hours,
   snap_on_duty_break_basis)
  VALUES ($1,$2,10,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
const T0 = '2026-03-01T08:00:00Z', T1 = '2026-03-01T16:00:00Z';

{ let ok=false, note='';
  try {
    await db.query(ADS,[1,101,'2026-03-01',T0,T1,8,8,0,1,7,6,'allowance']);
    ok=true; note='allowance 口径 work=in_att-break 接受';
  } catch(e){ note=e.code+' '+String(e.message).split('\n')[0]; }
  rec('E1','合法人日（allowance：work = 7-1 = 6）→ 接受', ok, note); }

await expectErr(() => db.query(ADS,[2,102,'2026-03-01',T0,T1,7.5,8,0,1,7,6,'allowance']),
  'chk_ads_span','E2','span_hours 与真实时刻差不符 → chk_ads_span');

await expectErr(() => db.query(ADS,[3,103,'2026-03-02',T0,T1,8,8,0,1,7,6,'hourly']),
  'chk_ads_sum','E3','hourly 口径下 work 必须 = in_att（写 6 被拒）');

await expectErr(() => db.query(ADS,[4,104,'2026-03-03',T0,T1,8,8,0,1,7,7,'allowance']),
  'chk_ads_sum','E4','allowance 口径下 work 必须 = in_att-break（写 7 被拒）—— 两支真的是两支');

await expectErr(() => db.query(ADS,[5,105,'2026-03-04',T0,T1,8,8,0,-1,7,8,'allowance']),
  'chk_ads_nonneg','E5','break = -1（负休息）→ chk_ads_nonneg');
{ const c = (await db.query(`SELECT count(*)::int n FROM pg_constraint
    WHERE conrelid='attendance_daily_store'::regclass AND conname='chk_ads_off'`)).rows[0].n;
  rec('E5b','chk_ads_off 存在（in_att <= span 的独立锚）', c===1, `n=${c}`); }

await expectErr(() => db.query(ADS,[6,101,'2026-03-01',T0,T1,8,8,0,1,7,6,'allowance']),
  'ex_ads_no_overlap','E6','同一人同一天第二行 → 23P01');

// break=0 让 chk_ads_sum 通过（7-0=7），于是**只剩值域那条违规** ——
// 一条断言只让一条约束红，否则测出来的红可能来自另一条（E7a 首跑就踩了这个）。
await expectErr(() => db.query(ADS,[7,107,'2026-03-05',T0,T1,8,8,0,0,7,7,'fourth']),
  'ck_ads_snap_odb','E7a','第四种口径值被值域 CHECK 拒绝（且只违反这一条）');

{ // ★ E7b 演示 04 自己警告过的静默失效：
  //   值域 CHECK 只强制"你要改一处"，不强制"你要改全"。
  await db.exec(`ALTER TABLE attendance_daily_store DROP CONSTRAINT ck_ads_snap_odb`);
  await db.exec(`ALTER TABLE attendance_daily_store ADD CONSTRAINT ck_ads_snap_odb
                 CHECK (snap_on_duty_break_basis IN ('allowance','hourly','none','fourth'))`);
  let silent=false, note='';
  try {
    // 第四种取值 + break=0 → 落进 "<> 'hourly'" 那一支，work = 7-0 = 7 → 通过
    await db.query(ADS,[8,108,'2026-03-06',T0,T1,8,8,0,0,7,7,'fourth']);
    silent=true; note='第四种取值 + break=0 静默通过（口径已错，无任何报警）';
  } catch(e){ note=e.code; }
  rec('E7b','新增取值被值域放行后，chk_ads_sum 静默按 <>hourly 口径接受（已知薄弱点）',
      silent, note);
  await db.exec(`DELETE FROM attendance_daily_store WHERE id=8`);
  await db.exec(`ALTER TABLE attendance_daily_store DROP CONSTRAINT ck_ads_snap_odb`);
  await db.exec(`ALTER TABLE attendance_daily_store ADD CONSTRAINT ck_ads_snap_odb
                 CHECK (snap_on_duty_break_basis IN ('allowance','hourly','none'))`);
}


// ===========================================================================
// F 组 · 审批引擎（006 + 032）：发布即冻结 + 在途锁定
// ---------------------------------------------------------------------------
// ★ 这一组原来用显式 id 播种（approval_template(id,...) VALUES (1,...)）。
//   032 给这四张表补了 IDENTITY（因为现在由 fn_appr_start 插入），
//   所以这里改成"插入后回查 id"——显式 id 会让序列停在 1，
//   而序列停在 1 不会立刻报错，它等到第一次自增才 23505。
// ===========================================================================
const DEF1 = JSON.stringify({
  steps: [{ seq: 1, mode: 'any', resolvers: [{ kind: 'user', user_id: 7 }] }],
});
await db.exec(`INSERT INTO approval_template(code,name) VALUES ('LEAVE','请假单')`);
const tplLeave = (await db.query(
  `SELECT id FROM approval_template WHERE code = 'LEAVE'`)).rows[0].id;
const v1 = (await db.query(
  `INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
   VALUES ($1,1,'published','2026-01-01',$2::jsonb,'2026-01-01') RETURNING id`,
  [tplLeave, DEF1])).rows[0].id;
const inst1 = (await db.query(
  `INSERT INTO approval_instance(template_version_id,biz_type,biz_id)
   VALUES ($1,'leave',100) RETURNING id`, [v1])).rows[0].id;
await db.query(
  `INSERT INTO approval_task(instance_id,seq,approver_id) VALUES ($1,1,7)`, [inst1]);

{ // F1 走完一张单
  await db.query(`UPDATE approval_task SET status='approved', acted_at=now()
                   WHERE instance_id=$1`, [inst1]);
  await db.query(`UPDATE approval_instance SET status='approved', finished_at=now()
                   WHERE id=$1`, [inst1]);
  const st = (await db.query(`SELECT status FROM approval_instance WHERE id=$1`, [inst1])).rows[0].status;
  rec('F1','发起 → 审批 → 完成', st==='approved', st); }

await expectErr(() => db.query(`UPDATE approval_template_version
    SET definition='{"steps":[{"seq":1,"resolvers":[{"kind":"user","user_id":9}]}]}'::jsonb
    WHERE id=$1`, [v1]),
  'E_VERSION_FROZEN','F2','直接改已发布版本 definition → 数据库拒绝（不是应用层）');

{ // F3 发 v2，在途单据仍锁 v1
  const v2 = (await db.query(
    `INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
     VALUES ($1,2,'published','2026-02-01',$2::jsonb,'2026-02-01') RETURNING id`,
    [tplLeave, JSON.stringify({steps:[
      {seq:1,mode:'any',resolvers:[{kind:'user',user_id:7}]},
      {seq:2,mode:'any',resolvers:[{kind:'user',user_id:8}]}]})])).rows[0].id;
  const v = Number((await db.query(
    `SELECT template_version_id v FROM approval_instance WHERE id=$1`, [inst1])).rows[0].v);
  rec('F3','发布 v2 后在途单据仍指向 v1', v === Number(v1), `v=${v} v1=${v1}`); }

await expectErr(() => db.query(`UPDATE approval_template_version SET status='draft' WHERE id=$1`, [v1]),
  'E_STATUS_REGRESS','F4','status 回退 published→draft → 拒绝（最易漏的绕过路径）');

await expectErr(() => db.query(`UPDATE approval_instance SET template_version_id=2 WHERE id=$1`, [inst1]),
  'E_VERSION_LOCKED','F6','改在途单据的模板版本 → 拒绝');

{ // F7 retired 版本必须能存（曾差点把它锁死）
  let ok=false, note='';
  try {
    await db.query(`UPDATE approval_template_version SET status='retired' WHERE id=$1`, [v1]);
    ok=true; note='retired 保留 published_at，接受';
  } catch(e){ note=e.code+' '+String(e.message).split('\n')[0]; }
  rec('F7','已发布版本可转 retired（published_at 保留）', ok, note); }

{ // F5 产品承诺可数：不存在 approve_* 函数
  const n = (await db.query(`SELECT count(*)::int n FROM pg_proc WHERE proname LIKE 'approve\\_%'`)).rows[0].n;
  rec('F5','数据库层无 approve_* 函数（开放层零审批工具的可查近似）', n===0, `n=${n}`); }

// ===========================================================================
// G 组 · 人员 / 任职 / 编号（007）
// ===========================================================================
await db.exec(`
INSERT INTO person(id,full_name) VALUES (1,'张三'),(2,'李四');
-- 张三：A 店离职后再入职 B 店（两段任职，两个法人）
INSERT INTO employment(id,person_id,legal_entity_id,hire_date,leave_date) VALUES
  (1,1,1,'2026-01-01','2026-03-31'),
  (2,1,2,'2026-07-01',NULL),
  (3,2,1,'2026-02-01',NULL);
`);

{ // G2 离职日当天算在职
  const onLeave = (await db.query(`SELECT fn_is_active(1,'2026-03-31'::date) v`)).rows[0].v;
  const after   = (await db.query(`SELECT fn_is_active(1,'2026-04-01'::date) v`)).rows[0].v;
  rec('G2','离职日当天算在职（\u0027[]\u0027）、次日不在职', onLeave===true && after===false,
      `离职日=${onLeave} 次日=${after}`); }

{ // G1 一人两段任职不串：两段各自独立，互不覆盖
  const a = (await db.query(`SELECT fn_is_active(1,'2026-02-01'::date) v`)).rows[0].v;
  const mid = (await db.query(`SELECT fn_is_active(1,'2026-05-01'::date) v`)).rows[0].v;  // 空档期
  rec('G1','一人两段任职：第一段在、空档期不在、第二段在',
      a===true && mid===false, `段1=${a} 空档=${mid}`); }

{ // G3 未核实可重复，核实后唯一
  await db.exec(`INSERT INTO person_profile(id,person_id,profile_type,profile_value) VALUES
    (1,1,'national_id','310101199001011234'),
    (2,2,'national_id','310101199001011234')`);
  const dupOk = (await db.query(`SELECT count(*)::int n FROM person_profile`)).rows[0].n;
  let blocked=false, note='';
  try {
    await db.exec(`UPDATE person_profile SET verified_by=9, verified_at=now() WHERE id=1`);
    await db.exec(`UPDATE person_profile SET verified_by=9, verified_at=now() WHERE id=2`);
    note='两条都核实成功 —— 唯一索引没生效';
  } catch(e){ blocked=true; note=e.code; }
  rec('G3','同一身份证：未核实可重复（两人填错同号），核实第二条被唯一索引拒',
      dupOk===2 && blocked, `未核实=${dupOk} 核实冲突=${note}`); }

{ // G4 编号永不复用
  await db.query(`SELECT fn_assign_employee_no(1,'E0001')`);
  let blocked=false, note='';
  try { await db.query(`SELECT fn_assign_employee_no(2,'E0001')`); note='被改分配给另一个人'; }
  catch(e){ blocked = String(e.message).includes('E_EMPLOYEE_NO_REUSED'); note=e.code; }
  rec('G4','编号已被 person1 占用 → 改分配 person2 被拒（永不复用）', blocked, note); }

{ // G4b 同一个人再入职：沿用原编号
  let ok=false, note='';
  try {
    await db.exec(`UPDATE employee_no SET retired_at=now() WHERE no='E0001'`);
    await db.query(`SELECT fn_assign_employee_no(1,'E0001')`);
    const r = (await db.query(`SELECT retired_at FROM employee_no WHERE no='E0001'`)).rows[0];
    ok = r.retired_at === null; note='同人再入职清除退休标记';
  } catch(e){ note=e.code; }
  rec('G4b','离职再入职沿用原编号（编号绑人不绑任职）', ok, note); }

await expectErr(() => db.exec(`INSERT INTO employment_segment(id,employment_id,seq,valid_from,valid_to)
    VALUES (1,1,1,'2026-01-01','2026-02-28'),(2,1,2,'2026-02-01','2026-03-31')`),
  'ex_seg_no_overlap','G5','任职分段区间重叠 → 23P01');

await expectErr(() => db.exec(`INSERT INTO employment_segment(id,employment_id,seq,valid_from,valid_to)
    VALUES (3,1,9,'2024-01-01','2024-02-01'),(4,1,9,'2024-03-01','2024-04-01')`),
  'employment_segment_employment_id_seq_key','G6','同任职内 seq 重复被拒（UNIQUE(employment_id,seq)）');


// ===========================================================================
// H 组 · 段级确认（008）：三态 + 零状态派生
// ===========================================================================
await db.exec(`
INSERT INTO schedule(id,employee_id,work_date,shift_id,store_id) VALUES
  (1,1,'2026-03-01',1,10),(2,1,'2026-03-02',1,10),
  (3,1,'2026-03-03',1,10),(4,1,'2026-03-04',1,10);
INSERT INTO schedule_segment(id,schedule_id,seq,store_id,start_at,end_at) VALUES
  (1,1,1,10,'2026-03-01T08:00:00Z','2026-03-01T16:00:00Z'),
  (2,2,1,10,'2026-03-02T08:00:00Z','2026-03-02T16:00:00Z'),
  (3,3,1,10,'2026-03-03T08:00:00Z','2026-03-03T16:00:00Z'),
  (4,4,1,10,'2026-03-04T08:00:00Z','2026-03-04T16:00:00Z');
-- 段1：人工确认；段2：超时默认；段3：未确认；段4：故意不建确认单（= 缺陷）
INSERT INTO confirm_sheet(id,segment_id,status,source,auto_confirmed_at,confirm_due_at,confirm_owner_id,confirmed_by) VALUES
  (1,1,'locked','manual',NULL,'2026-03-01T20:00:00Z',7,7),
  (2,2,'locked','timeout_auto','2026-03-02T20:00:00Z','2026-03-02T20:00:00Z',7,NULL),
  (3,3,'pushed',NULL,NULL,'2026-03-03T20:00:00Z',7,NULL);
`);

{ const rows = (await db.query(`SELECT segment_id, biz_state FROM v_segment_confirm ORDER BY segment_id`)).rows;
  const m = Object.fromEntries(rows.map(r=>[r.segment_id, r.biz_state]));
  rec('H1','三态可区分：已确认 / 默认确认 / 未确认',
      m[1]==='confirmed' && m[2]==='default_confirmed' && m[3]==='unconfirmed',
      JSON.stringify(m)); }

{ const rows = (await db.query(`SELECT segment_id FROM v_segment_missing_sheet ORDER BY 1`)).rows.map(r=>r.segment_id);
  rec('H2','零状态是派生的：段4 无确认单 → missing_sheet（表里没有第四个状态值）',
      rows.length===1 && rows[0]===4, `命中=${JSON.stringify(rows)}`); }

{ // 未排班（段表无行）不应出现在 missing_sheet 里 —— 两者不同形正是目的
  const n = (await db.query(`SELECT count(*)::int n FROM v_segment_confirm`)).rows[0].n;
  rec('H3','视图只覆盖"段存在"的集合：未排班不产生行，也不会被误报为缺失',
      n===4, `行数=${n}（=段数 4）`); }

// ★ 第二次踩同一个坑：这条数据要**只**违反 ck_cs_source_consistent。
//   due/owner 必须补齐，否则会先撞 ck_cs_default_has_owner，
//   报出来的红指向另一条约束，测的就不是想测的那件事。
await expectErr(() => db.exec(`INSERT INTO confirm_sheet(id,segment_id,status,source,auto_confirmed_at,confirm_due_at,confirm_owner_id,confirmed_by)
    VALUES (10,2,'locked','timeout_auto',now(),now(),7,99)`),
  'ck_cs_source_consistent','H4','timeout_auto 却填了 confirmed_by → 拒（系统动作不许写进人字段）');

await expectErr(() => db.exec(`INSERT INTO confirm_sheet(id,segment_id,status,source,auto_confirmed_at)
    VALUES (11,1,'locked','timeout_auto',now())`),
  'ck_cs_default_has_owner','H5','默认确认缺 due/owner → 拒（必须能答"本该由谁、何时"）');

{ // 默认确认在报表上的"可解释性"：能不能读出本该由谁确认
  const r = (await db.query(`SELECT confirm_owner_id, confirm_due_at IS NOT NULL has_due
                               FROM v_segment_confirm WHERE segment_id=2`)).rows[0];
  rec('H6','默认确认可解释：能读出本该由谁确认、何时到期',
      r.confirm_owner_id===7 && r.has_due===true, JSON.stringify(r)); }


// ===========================================================================
// I 组 · 算薪冻结（009）
// ===========================================================================
await db.exec(`
INSERT INTO salary_item(code,name,item_kind) VALUES
  ('BASE','基本工资','fixed'),('OT','加班费','variable'),('ADJ','调整项','variable')
  ON CONFLICT (code) DO NOTHING;
INSERT INTO pay_run(id,period,legal_entity_id,status) VALUES (1,'2026-03',1,'draft');
INSERT INTO payslip(id,pay_run_id,employee_id,gross_amount,net_amount) VALUES (1,1,1,8000,6500);
INSERT INTO payslip_item(id,payslip_id,item_code,amount) VALUES (1,1,'BASE',8000);
`);

{ // I1 草稿期可改
  let ok=false, note='';
  try { await db.exec(`UPDATE payslip_item SET amount=8200 WHERE id=1`);
        await db.exec(`UPDATE payslip SET gross_amount=8200 WHERE id=1`);
        ok=true; note='draft 期可改'; }
  catch(e){ note=e.code+' '+String(e.message).split('\n')[0]; }
  rec('I1','草稿批次可改工资条', ok, note); }

{ // I5 待确认项：可算、不阻塞、有效期 ≤ 1 期
  let ok1=false, ok2=false, note='';
  try {
    await db.exec(`INSERT INTO payslip_item(id,payslip_id,item_code,amount,is_provisional,provisional_until_period)
                   VALUES (2,1,'ADJ',300,true,'2026-04')`);
    // 加了明细就要让应发/实发跟着走，否则勾稽视图会（正确地）把它抓出来
    await db.exec(`UPDATE payslip SET gross_amount=8500, net_amount=8500 WHERE id=1`);
    ok1=true;
  } catch(e){ note='期内被拒: '+e.code; }
  try {
    await db.exec(`INSERT INTO payslip_item(id,payslip_id,item_code,amount,is_provisional,provisional_until_period)
                   VALUES (3,1,'ADJ',300,true,'2026-06')`);
    note += ' 超期被接受';
  } catch(e){ ok2 = String(e.message).includes('E_PROVISIONAL_TOO_LONG'); }
  rec('I5','待确认项可算（不阻塞），但有效期不得超过 1 个发薪期', ok1 && ok2, note||'期内接受/超期拒绝'); }

// 封账
await db.exec(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=1`);

await expectErr(() => db.exec(`UPDATE payslip SET net_amount=9999 WHERE id=1`),
  'E_PAYSLIP_FROZEN','I2','封账后改工资条 → 数据库拒绝（不是应用层）');

await expectErr(() => db.exec(`UPDATE payslip_item SET amount=1 WHERE id=1`),
  'E_PAYSLIP_FROZEN','I3','封账后改工资明细 → 拒绝');

await expectErr(() => db.exec(`UPDATE pay_run SET status='draft', sealed_at=NULL WHERE id=1`),
  'E_PAYRUN_REOPEN','I4','封账批次回 draft（真正的绕过路径）→ 拒绝');

await expectErr(() => db.exec(`INSERT INTO payslip(id,pay_run_id,employee_id) VALUES (2,1,1)`),
  'payslip_pay_run_id_employee_id_key','I6','同一批次同一人第二张工资条 → 唯一键拒绝');


// ===========================================================================
// J 组 · MCP 两阶段写（010）
// ===========================================================================
await db.exec(`
INSERT INTO sys_mcp_plan(plan_id,tool_name,args_digest,diff_json,affected_count,plan_ttl_seconds)
VALUES ('11111111-1111-1111-1111-111111111111','schedule_batch_assign',
        decode('deadbeef','hex'),'{"diff":[]}',10,300);
INSERT INTO sys_mcp_plan(plan_id,tool_name,args_digest,diff_json,affected_count,plan_ttl_seconds)
VALUES ('22222222-2222-2222-2222-222222222222','schedule_batch_assign',
        decode('deadbeef','hex'),'{"diff":[]}',100,300);
INSERT INTO sys_mcp_plan(plan_id,tool_name,args_digest,diff_json,affected_count,plan_ttl_seconds,created_at)
VALUES ('33333333-3333-3333-3333-333333333333','schedule_batch_assign',
        decode('deadbeef','hex'),'{"diff":[]}',10,300, now() - interval '1 hour');
`);

await expectErr(() => db.query(`SELECT fn_mcp_execute(gen_random_uuid(),'schedule_batch_assign',decode('deadbeef','hex'),'ai-1')`),
  'E_MCP_NO_PLAN','J1','无 plan 的写操作 → 拒（"建议先 dryRun"不是安全措施）');

{ let ok=false, note='';
  try { await db.query(`SELECT fn_mcp_execute('11111111-1111-1111-1111-111111111111','schedule_batch_assign',decode('deadbeef','hex'),'ai-1')`);
        ok=true; note='plan 校验通过并落 used_at'; }
  catch(e){ note=e.code+' '+String(e.message).split('\n')[0]; }
  rec('J1b','有效 plan + 摘要一致 + 未超阈值 → 执行成功', ok, note); }

await expectErr(() => db.query(`SELECT fn_mcp_execute('11111111-1111-1111-1111-111111111111','schedule_batch_assign',decode('deadbeef','hex'),'ai-1')`),
  'E_MCP_PLAN_USED','J2','同一 plan 执行第二次 → 拒（一个 plan 只能执行一次）');

await expectErr(() => db.query(`SELECT fn_mcp_execute('22222222-2222-2222-2222-222222222222','schedule_batch_assign',decode('cafebabe','hex'),'ai-1')`),
  'E_MCP_ARGS_CHANGED','J3','参数摘要与预览不一致 → 拒（防预览 10 条、执行 1000 条）');

await expectErr(() => db.query(`SELECT fn_mcp_execute('22222222-2222-2222-2222-222222222222','schedule_batch_assign',decode('deadbeef','hex'),'ai-1')`),
  'E_MCP_OVER_THRESHOLD','J4','影响 100 人 > 阈值 50 → 拒（转人工，不是提示）');

await expectErr(() => db.query(`SELECT fn_mcp_execute('33333333-3333-3333-3333-333333333333','schedule_batch_assign',decode('deadbeef','hex'),'ai-1')`),
  'E_MCP_PLAN_EXPIRED','J5','超过 ttl 的 plan → 拒（时长在读取时算，没有第二个时点列）');

{ const n = (await db.query(`SELECT count(*)::int n FROM sys_mcp_audit WHERE shift_run`)).rows[0].n;
  rec('J6','每次写执行落一条审计', n===1, `n=${n}`); }


// ===========================================================================
// K 组 · 假期额度四态（011）
// ===========================================================================
// ★ 不再写死 id：126 迁移已经建了法定假种（ANNUAL=1, SICK=2, PERSONAL=3 …），
//   写死 (1,'ANNUAL') 会撞主键 —— 和之前"账号 id 与种子 user 撞"是同一类坑。
//   这里只补测试专用的 COMP，其余按 code 取。
await db.exec(`
INSERT INTO leave_type(id,code,name,expire_policy)
SELECT COALESCE((SELECT max(id) FROM leave_type),0)+1,'COMP','调休','void'
 WHERE NOT EXISTS (SELECT 1 FROM leave_type WHERE code='COMP');
`);
const LT = Object.fromEntries(
  (await db.query(`SELECT code,id FROM leave_type`)).rows.map(r => [r.code, Number(r.id)]));
await db.query(`INSERT INTO leave_grant(id,employee_id,leave_type_id,qty,valid_from)
                VALUES (1,1,$1,10,'2026-01-01')`, [LT.ANNUAL]);

const bal = async (u,t) => (await db.query(
  `SELECT granted,frozen,used,expired,available FROM v_leave_balance
    WHERE employee_id=$1 AND leave_type_id=$2`,[u,t])).rows[0];

{ const r = await bal(1, LT.ANNUAL);
  rec('K1','授予 10 → available 10（余额由台账派生，不落列）',
      Number(r.available)===10, JSON.stringify(r)); }

{ await db.query(`SELECT fn_leave_freeze(1,1,3,900)`);
  const r = await bal(1, LT.ANNUAL);
  rec('K2','冻结 3 → frozen 3 / available 7', Number(r.frozen)===3 && Number(r.available)===7,
      JSON.stringify(r)); }

await expectErr(() => db.query(`SELECT fn_leave_freeze(1,1,8,901)`),
  'E_LEAVE_OVER_QUOTA','K3','申请 8 > 可用 7 → 拒（不允许负余额）');

{ await db.query(`SELECT fn_leave_approve(900)`);
  const r = await bal(1, LT.ANNUAL);
  rec('K4','批准：frozen→used，available 不变（7）',
      Number(r.frozen)===0 && Number(r.used)===3 && Number(r.available)===7, JSON.stringify(r)); }

{ // K6 驳回释放：重新冻结 2 后驳回
  await db.query(`SELECT fn_leave_freeze(1,1,2,902)`);
  await db.query(`SELECT fn_leave_reject(902)`);
  const r = await bal(1, LT.ANNUAL);
  rec('K5','驳回：released 不占用可用额度', Number(r.available)===7, JSON.stringify(r)); }

{ // K7 到期：另授 5 但已过期 → 计入 expired，不进 available
  await db.query(`INSERT INTO leave_grant(id,employee_id,leave_type_id,qty,valid_from,valid_to)
                  VALUES (2,1,$1,5,'2025-01-01','2025-12-31')`, [LT.COMP]);
  const r = await bal(1, LT.COMP);
  rec('K6','过期授予计入 expired、不并入 available（按类型策略 void 作废）',
      Number(r.expired)===5 && Number(r.available)===0, JSON.stringify(r)); }

{ // K8 调休策略是业务选，不是技术选
  const rows = (await db.query(`SELECT code,expire_policy FROM leave_type ORDER BY id`)).rows;
  // ★ 不再要求"只有 2 个假种"：126 灌了法定假种（年假/病假/事假…）。
  //   这条测的是"策略可配且落成列"，不是"表里有几行"。
  rec('K8','到期策略可配（void/payout），且落成列不是散在代码里',
      rows.length >= 2 && rows.every(r=>['void','payout'].includes(r.expire_policy))
      && rows.some(r=>r.expire_policy==='payout') && rows.some(r=>r.expire_policy==='void'),
      `${rows.length} 个假种（payout ${rows.filter(r=>r.expire_policy==='payout').length} 个）`); }


// ===========================================================================
// AI 组 · 审批流跑起来（032）：多步 / 会签 / 一票否决 / 按日期选版本
// ---------------------------------------------------------------------------
// 006 的三张表在这之前**没有任何东西往里写**。F 组证明了冻结判据，
// 但没有证明"一张单真的能被三步走完"，也没有证明"没人可审时会拒绝而不是自动通过"。
// ===========================================================================
await db.exec(`
  INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
  VALUES (1,'cost_org',10,'2026-01-01')
  ON CONFLICT DO NOTHING;
  INSERT INTO approval_template(code,name) VALUES ('LEAVE2','请假审批（多步）')
  ON CONFLICT (code) DO NOTHING;
  INSERT INTO sys_user_org(user_id,org_id,effective_from) VALUES (77,10,'2026-01-01')
  ON CONFLICT DO NOTHING;
  INSERT INTO sys_org_grant(org_id,role_id,data_scope_id,effective_from,granted_by,reason)
  VALUES (1,77,100,'2026-01-01','group_hr','集团把审批角色授给集团层，各店的人继承')
  ON CONFLICT DO NOTHING;
`);
const tplLeave2 = (await db.query(
  `SELECT id FROM approval_template WHERE code='LEAVE2'`)).rows[0].id;

const DEF_V1 = JSON.stringify({ steps: [
  { seq: 1, mode: 'any', resolvers: [{ kind: 'role', role_id: 2 }] },
]});
const DEF_V2 = JSON.stringify({ steps: [
  { seq: 1, mode: 'any', resolvers: [{ kind: 'role', role_id: 2 }] },
  { seq: 2, mode: 'all', resolvers: [{ kind:'user', user_id: 4 }, { kind:'user', user_id: 5 }] },
]});
const lv1 = (await db.query(
  `INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
   VALUES ($1,1,'published','2026-01-01',$2::jsonb,'2026-01-01') RETURNING id`,
  [tplLeave2, DEF_V1])).rows[0].id;
const lv2 = (await db.query(
  `INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
   VALUES ($1,2,'published','2026-03-01',$2::jsonb,'2026-03-01') RETURNING id`,
  [tplLeave2, DEF_V2])).rows[0].id;

const applyLeave = async (qty, from, to) => (await db.query(
  `SELECT fn_leave_apply(1,1,$1,$2::date,$3::date) id`, [qty, from, to])).rows[0].id;
const startAppr = async (bizId, on) => (await db.query(
  `SELECT fn_appr_start('LEAVE2','leave',$1,$2::date) id`, [bizId, on])).rows[0].id;
const approve = async (inst, user, ok) => (await db.query(
  `SELECT fn_appr_act($1,$2,$3,NULL) r`, [inst, user, ok])).rows[0].r;
const stepsOf = async (inst) => (await db.query(
  `SELECT seq, count(*)::int n FROM approval_task WHERE instance_id=$1 GROUP BY seq ORDER BY seq`,
  [inst])).rows;

{ // AI1 按业务日期选版本：2 月的单走 v1（1 步），一步批完即 approved
  const rid = await applyLeave(1, '2026-02-10', '2026-02-10');
  const inst = await startAppr(rid, '2026-02-10');
  const ver = (await db.query(`SELECT template_version_id v FROM approval_instance WHERE id=$1`, [inst])).rows[0].v;
  const r = await approve(inst, 2, true);
  const st = (await db.query(`SELECT status FROM leave_request WHERE id=$1`, [rid])).rows[0].status;
  rec('AI1','2 月的单用 v1（1 步）：批一次即 approved，业务单据同步 approved',
      Number(ver) === Number(lv1) && r === 'approved' && st === 'approved',
      `v=${ver}/${lv1} act=${r} leave=${st}`); }

{ // AI2 3 月的单走 v2（2 步），第 2 步会签：两人都同意才推进
  const rid = await applyLeave(1, '2026-03-02', '2026-03-02');
  const inst = await startAppr(rid, '2026-03-02');
  const ver = (await db.query(`SELECT template_version_id v FROM approval_instance WHERE id=$1`, [inst])).rows[0].v;
  const r1 = await approve(inst, 2, true);
  const s2 = await stepsOf(inst);
  const r2 = await approve(inst, 4, true);      // 会签第一人
  const r3 = await approve(inst, 5, true);      // 会签第二人
  const st = (await db.query(`SELECT status FROM leave_request WHERE id=$1`, [rid])).rows[0].status;
  rec('AI2','3 月的单用 v2：第 1 步过 → 生成第 2 步 2 个会签任务 → 两人齐了才 approved',
      Number(ver) === Number(lv2) && r1==='running' && s2.length===2 && s2[1].n===2
      && r2==='running' && r3==='approved' && st==='approved',
      `v=${ver} r=${r1}/${r2}/${r3} 步=${JSON.stringify(s2)} leave=${st}`); }

{ // AI3 跳步/非本人：user 1 去处理 user 2 的待办
  const rid = await applyLeave(1, '2026-03-04', '2026-03-04');
  const inst = await startAppr(rid, '2026-03-04');
  let msg = '';
  try { await approve(inst, 1, true); } catch (e) { msg = e.message; }
  rec('AI3','不是自己的待办 → 拒（E_APPR_NOT_YOURS），不是"谁点都算"',
      msg.includes('E_APPR_NOT_YOURS'), String(msg).split('\n')[0].slice(0,40)); }

{ // AI4 剔除申请人后没人可审 → 明确失败，绝不自动通过
  await db.exec(`INSERT INTO approval_template(code,name) VALUES ('SELFONLY','只有申请人')`);
  const t = (await db.query(`SELECT id FROM approval_template WHERE code='SELFONLY'`)).rows[0].id;
  await db.query(
    `INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
     VALUES ($1,1,'published','2026-01-01',$2::jsonb,'2026-01-01')`,
    [t, JSON.stringify({steps:[{seq:1,resolvers:[{kind:'user',user_id:1}]}]})]);
  const rid = await applyLeave(1, '2026-03-06', '2026-03-06');
  let msg = '';
  try {
    await db.query(`SELECT fn_appr_start('SELFONLY','leave',$1,'2026-03-06'::date)`, [rid]);
  } catch (e) { msg = e.message; }
  const insts = (await db.query(
    `SELECT count(*)::int n FROM approval_instance WHERE biz_id=$1`, [rid])).rows[0].n;
  rec('AI4','审批人只有申请人 → 拒（E_APPROVAL_NO_APPROVER），且不留半个实例',
      msg.includes('E_APPROVAL_NO_APPROVER') && Number(insts) === 0,
      `${String(msg).split('\n')[0].slice(0,34)} 实例=${insts}`); }

{ // AI5 一票否决：拒绝 → 实例 rejected、单据 rejected、额度释放
  const before = Number((await bal(1, LT.ANNUAL)).available);
  const rid = await applyLeave(1, '2026-03-09', '2026-03-09');
  const afterFreeze = Number((await bal(1, LT.ANNUAL)).available);
  const inst = await startAppr(rid, '2026-03-09');
  const r = await approve(inst, 2, false);
  const st = (await db.query(`SELECT status FROM leave_request WHERE id=$1`, [rid])).rows[0].status;
  const afterReject = Number((await bal(1, LT.ANNUAL)).available);
  rec('AI5','一人拒绝即否决：实例 rejected、单据 rejected、额度回到申请前',
      r==='rejected' && st==='rejected' && afterReject===before && afterFreeze===before-1,
      `act=${r} leave=${st} 额度 ${before}→${afterFreeze}→${afterReject}`); }

{ // AI6 定义结构在**发布时**就校验：seq 跳号不许发布
  await db.exec(`INSERT INTO approval_template(code,name) VALUES ('BADSEQ','跳号流程')`);
  const t = (await db.query(`SELECT id FROM approval_template WHERE code='BADSEQ'`)).rows[0].id;
  let msg = '';
  try {
    await db.query(
      `INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
       VALUES ($1,1,'published','2026-01-01',$2::jsonb,'2026-01-01')`,
      [t, JSON.stringify({steps:[{seq:1,resolvers:[{kind:'user',user_id:2}]},
                                 {seq:3,resolvers:[{kind:'user',user_id:4}]}]})]);
  } catch (e) { msg = e.message; }
  rec('AI6','发布时校验定义：seq 必须从 1 连续 → 跳号被拒（E_APPR_DEF_INVALID）',
      msg.includes('E_APPR_DEF_INVALID'), String(msg).split('\n')[0].slice(0,40)); }

{ // AI7 组织授权解析：授在集团(1) 的角色，挂在 A店(10) 的人也算审批人
  const rows = (await db.query(
    `SELECT user_id, source FROM fn_appr_resolve_role(77, 10, '2026-03-01'::date)`)).rows;
  const u9 = rows.find(r => Number(r.user_id) === 77);
  rec('AI7','组织授权沿祖先链解析到人：授在集团 → A店的人继承（source=org）',
      !!u9 && u9.source === 'org', JSON.stringify(rows.map(r=>`${r.user_id}:${r.source}`))); }

// ===========================================================================
// AJ 组 · 例外必须有退出条件（037）
// ---------------------------------------------------------------------------
// 这套系统里出现过几次「临时放开」。它们的共同点是：允许例外，但必须带
// 「什么时候结束」。没有退出条件的例外不是例外，是改了规矩而没人说。
// ===========================================================================
{ // AJ1 期限为 0 / 负数 → 拒（"永久例外"这个说法本身自相矛盾）
  let msg = '';
  try { await db.query(`SELECT fn_exception_open('HC_OVER','org_unit',10,'旺季临时放行','店长',0)`); }
  catch (e) { msg = e.message; }
  rec('AJ1','期限为 0 → 拒（E_EX_TTL）；没有到期时间的例外不许存在',
      msg.includes('E_EX_TTL'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AJ2 超过类型上限 → 拒（不是"截断到上限"，那会让人以为批了 5 年）
  let msg = '';
  try { await db.query(`SELECT fn_exception_open('CHK_WAIVE','payslip',1,'豁免一次','财务',90)`); }
  catch (e) { msg = e.message; }
  rec('AJ2','超过类型上限（CHK_WAIVE 最多 30 天，要 90 天）→ 拒，而不是静默截断',
      msg.includes('E_EX_TTL_TOO_LONG'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AJ3 无责任人 → 拒
  let msg = '';
  try { await db.query(`SELECT fn_exception_open('HC_OVER','org_unit',10,'旺季临时放行',NULL,10)`); }
  catch (e) { msg = e.message; }
  rec('AJ3','没有责任人的例外 → 拒（没人认领的例外没人会去关）',
      msg.includes('E_EX_NO_OWNER'), String(msg).split('\n')[0].slice(0, 40)); }

const exId = (await db.query(
  `SELECT fn_exception_open('HC_OVER','org_unit',10,'旺季临时放行','店长甲',10) id`)).rows[0].id;

{ // AJ4 关闭必须写操作人；只写时间不写人 → 拒
  let msg = '';
  try {
    await db.query(`UPDATE exception_registry SET closed_at=clock_timestamp() WHERE id=$1`, [exId]);
  } catch (e) { msg = e.message; }
  rec('AJ4','只写关闭时间、不写人 → 拒（ck_ex_close：三列同生同灭）',
      msg !== '', msg.split('\n')[0].slice(0, 40)); }

{ // AJ5 删除 → 拒（删行会让「这里曾经有过一个例外」消失）
  let msg = '';
  try { await db.query(`DELETE FROM exception_registry WHERE id=$1`, [exId]); }
  catch (e) { msg = e.message; }
  rec('AJ5','删除例外 → 拒（E_EX_NO_DELETE）；只能关闭，关闭留下人、时间与原因',
      msg.includes('E_EX_NO_DELETE'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AJ6 到期必须看得见；关闭后从清单消失，但那一行还在
  const od = (await db.query(
    `INSERT INTO exception_registry(kind_code,subject_type,subject_id,reason,owner,created_at,expires_at)
     VALUES ('SETTLE_TOL','settlement',1,'对方口径差异容忍','财务乙',
             now() - interval '10 days', now() - interval '3 days')
     RETURNING id`)).rows[0].id;
  const hit = (await db.query('SELECT * FROM v_exception_overdue WHERE id=$1', [od])).rows[0];
  await db.query(`SELECT fn_exception_close($1,'财务乙','对方补齐差异，恢复正常对账')`, [od]);
  const gone = (await db.query('SELECT * FROM v_exception_overdue WHERE id=$1', [od])).rows.length;
  const kept = (await db.query('SELECT count(*)::int n FROM exception_registry WHERE id=$1', [od])).rows[0].n;
  rec('AJ6','到期未关闭 → 出现在到期清单（带逾期天数）；关闭后从清单消失，而那一行仍在（可复盘）',
      !!hit && Number(hit.overdue_days) >= 2 && gone === 0 && Number(kept) === 1,
      `逾期 ${hit?.overdue_days} 天；关闭后清单 ${gone} 条，记录仍在=${kept}`); }

// ===========================================================================
// AK 组 · 转签（041）：审批人不在时唯一合法的出路
// ---------------------------------------------------------------------------
// 审批人在启动时解析成行（032），于是必然遇到"他自己不在"。
// 三条路只有一条对：改行（没痕迹）、重提（前面白批）、转签（留痕）。
// ===========================================================================
// 转签组会连开好几张单：先补一笔授予（追加授予是正规机制，不是绕过额度）
// 显式 id：这张表的序列由 syncSeq 同步过，无 id 插入会撞已有主键
await db.query(`INSERT INTO leave_grant(id,employee_id,leave_type_id,qty,valid_from)
                VALUES (9001,1,1,20,'2026-01-01')`);

const taskOf = async (inst, seq) => (await db.query(
  `SELECT * FROM approval_task WHERE instance_id=$1 AND seq=$2 ORDER BY id LIMIT 1`,
  [inst, seq])).rows[0];

{ // AK1 转签成功：审批人变了、日志一条、原审批人不再能处理
  const rid = await applyLeave(1, '2026-07-01', '2026-07-01');
  const inst = await startAppr(rid, '2026-07-01');
  const t1 = await taskOf(inst, 1);
  await db.query('SELECT fn_appr_transfer($1,$2,$3,$4)', [t1.id, 9, t1.approver_id, '审批人休假，转给同事']);
  const t2 = await taskOf(inst, 1);
  const log = (await db.query(
    'SELECT * FROM approval_task_log WHERE task_id=$1', [t1.id])).rows;

  let oldErr = '';
  try { await approve(inst, Number(t1.approver_id), true); }
  catch (e) { oldErr = e.message; }

  rec('AK1','转签：审批人换成新的人、留一条日志、原审批人立刻无权处理',
      Number(t2.approver_id) === 9 && log.length === 1
      && Number(log[0].from_user) === Number(t1.approver_id) && Number(log[0].to_user) === 9
      && oldErr.includes('E_APPR_NOT_YOURS'),
      `approver ${t1.approver_id}→${t2.approver_id} 日志=${log.length} 原审批人=${String(oldErr).split('\n')[0].slice(0,24)}`); }

{ // AK2 转给申请人 → 拒（那是自审的另一个入口）
  const rid = await applyLeave(1, '2026-07-03', '2026-07-03');
  const inst = await startAppr(rid, '2026-07-03');
  const t1 = await taskOf(inst, 1);
  let msg = '';
  try { await db.query('SELECT fn_appr_transfer($1,1,$2,$3)', [t1.id, t1.approver_id, '转给申请人试试']); }
  catch (e) { msg = e.message; }
  rec('AK2','转给申请人 → 拒（E_APPR_TRANSFER_TO_APPLICANT）；否则"启动时剔除申请人"就白写了',
      msg.includes('E_APPR_TRANSFER_TO_APPLICANT'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AK3 转给自己 → 拒；理由太短 → 拒
  const rid = await applyLeave(1, '2026-07-05', '2026-07-05');
  const inst = await startAppr(rid, '2026-07-05');
  const t1 = await taskOf(inst, 1);
  let self = '', shortR = '';
  try { await db.query('SELECT fn_appr_transfer($1,$2,$2,$3)', [t1.id, t1.approver_id, '转给自己玩']); }
  catch (e) { self = e.message; }
  try { await db.query('SELECT fn_appr_transfer($1,9,$2,$3)', [t1.id, t1.approver_id, '忙']); }
  catch (e) { shortR = e.message; }
  rec('AK3','转给自己 → 拒；原因不足 4 字 → 拒（转签必须说明"为什么是他"）',
      self.includes('E_APPR_TRANSFER_SELF') && shortR.includes('E_APPR_TRANSFER_NO_REASON'),
      `${self ? 'self✓' : 'self✗'} ${shortR ? 'reason✓' : 'reason✗'}`); }

{ // AK5 转给"这一步已经在等他审的人" → 有名字的拒绝（不是 23505）
  await db.exec(`INSERT INTO approval_template(code,name) VALUES ('DUP2','两人同一步')`);
  const t = (await db.query(`SELECT id FROM approval_template WHERE code='DUP2'`)).rows[0].id;
  await db.query(
    `INSERT INTO approval_template_version(template_id,version_no,status,published_at,definition,effective_from)
     VALUES ($1,1,'published','2026-01-01',$2::jsonb,'2026-01-01')`,
    [t, JSON.stringify({steps:[{seq:1,mode:'any',
      resolvers:[{kind:'user',user_id:2},{kind:'user',user_id:9}]}]})]);
  const rid = await applyLeave(1, '2026-07-07', '2026-07-07');
  const inst = (await db.query(
    `SELECT fn_appr_start('DUP2','leave',$1,'2026-07-07'::date) id`, [rid])).rows[0].id;
  const tsk = (await db.query(
    `SELECT * FROM approval_task WHERE instance_id=$1 AND approver_id=2`, [inst])).rows[0];
  let msg = '';
  try { await db.query('SELECT fn_appr_transfer($1,9,$2,$3)', [tsk.id, 2, '转给同一步的人试试']); }
  catch (e) { msg = e.message; }
  rec('AK5','转给同一步已有的审批人 → 拒（E_APPR_TRANSFER_DUPLICATE，而不是 23505 冲突）',
      msg.includes('E_APPR_TRANSFER_DUPLICATE'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AK4 日志只增不改
  const log = (await db.query('SELECT * FROM approval_task_log ORDER BY id LIMIT 1')).rows[0];
  let msg = '';
  try { await db.query(`UPDATE approval_task_log SET reason='改个理由' WHERE id=$1`, [log.id]); }
  catch (e) { msg = e.message; }
  rec('AK4','审批操作日志只增不改（E_APPR_LOG_APPEND_ONLY）；改日志＝改审批历史',
      msg.includes('E_APPR_LOG_APPEND_ONLY'), String(msg).split('\n')[0].slice(0, 40)); }

// ===========================================================================
// AL 组 · 请假审批方式：配置项真的接线（042）
// ---------------------------------------------------------------------------
// 「请假要不要多步」是客户的口径，不是技术的默认。做成配置项之后，
// 最要紧的不是"登记了一条记录"，而是**改配置 ⇒ 行为真的跟着变**。
// 这一组用 6 月 / 7 月两张单做反例。
// ===========================================================================
{ // AL1 6 月（multi）：申请时**同一事务内**就开了审批实例
  const rid = await applyLeave(1, '2026-06-10', '2026-06-10');
  const inst = (await db.query(
    `SELECT id, status FROM approval_instance WHERE biz_type='leave' AND biz_id=$1`, [rid])).rows;
  rec('AL1','multi 下申请即开实例（不是"申请完再有人记得去发起"）',
      inst.length === 1 && inst[0].status === 'running',
      `实例 ${inst.length} 个 ${inst.map(x => x.status)}`); }

{ // AL2 multi 下走单签入口 → 有名字的拒绝
  const rid = (await db.query(
    `SELECT id FROM leave_request ORDER BY id DESC LIMIT 1`)).rows[0].id;
  let msg = '';
  try { await db.query('SELECT fn_leave_decide_by($1,true,99)', [rid]); }
  catch (e) { msg = e.message; }
  rec('AL2','multi 下从单签入口批准 → 拒（E_LEAVE_USE_APPROVAL，并指向 /api/approval/*）',
      msg.includes('E_LEAVE_USE_APPROVAL'), String(msg).split('\n')[0].slice(0, 46)); }

{ // AL3 同一张单走引擎 → 两步走完，单据 approved（业务真的跟着变）
  const rid = (await db.query(
    `SELECT id FROM leave_request ORDER BY id DESC LIMIT 1`)).rows[0].id;
  const inst = (await db.query(
    `SELECT id FROM approval_instance WHERE biz_id=$1`, [rid])).rows[0].id;
  // ★ 不能先数好步数再逐个批：下一步的任务是**上一步批完才生成**的，
  //   预先数出来的步数永远是 1（AI2 里那条会签断言踩的是同一件事的反面）。
  let rounds = 0, last = 'running';
  while (last === 'running' && rounds < 8) {
    const cur = (await db.query(
      `SELECT approver_id FROM approval_task
        WHERE instance_id=$1 AND status='pending'
        ORDER BY seq, id LIMIT 1`, [inst])).rows[0];
    if (!cur) break;
    last = (await db.query('SELECT fn_appr_act($1,$2,true,NULL) r',
      [inst, cur.approver_id])).rows[0].r;
    rounds++;
  }
  const st = (await db.query(`SELECT status FROM leave_request WHERE id=$1`, [rid])).rows[0].status;
  rec('AL3','multi 下走引擎：逐级批完，单据 approved（回写只在一处，状态不会两套）',
      st === 'approved' && last === 'approved', `单据=${st} 轮次=${rounds} 末态=${last}`); }

{ // AL4 7 月（single）：不建实例，且单签入口照常可用
  const rid = await applyLeave(1, '2026-07-15', '2026-07-15');
  const inst = (await db.query(
    `SELECT count(*)::int n FROM approval_instance WHERE biz_id=$1`, [rid])).rows[0].n;
  await db.query('SELECT fn_leave_decide_by($1,true,99)', [rid]);
  const st = (await db.query(`SELECT status FROM leave_request WHERE id=$1`, [rid])).rows[0].status;
  rec('AL4','改回 single（7 月）后：不建实例、单签照常可用 —— 配置真的接线了，不是只登记',
      Number(inst) === 0 && st === 'approved', `实例=${inst} 单据=${st}`); }

// ===========================================================================
// AN 组 · 代理（045）：人不在，责任还在
// ---------------------------------------------------------------------------
// 转签解决"这一单怎么办"；代理解决"我下周整周不在"。
// 关键判断：代批不改变责任人 —— 待办仍挂原审批人，代理人只是被授权动手。
// ===========================================================================
{ // AN1 代理期内：代理人能推进，且任务归属**没变**（记录里还是原审批人）
  const rid = await applyLeave(1, '2026-07-20', '2026-07-20');
  const inst = await startAppr(rid, '2026-07-20');
  const t1 = await taskOf(inst, 1);
  const owner = Number(t1.approver_id);

  await db.query(`SELECT fn_delegate_add($1,$2,'2026-07-18'::date,'2026-07-25'::date,$3,$4)`,
    [owner, 88, '休假一周，由同事代审', 'hr']);

  const r = await db.query('SELECT fn_appr_act($1,$2,true,NULL) r', [inst, 88]).then(x => x.rows[0].r);
  const after = (await db.query(
    `SELECT approver_id, status FROM approval_task WHERE id=$1`, [t1.id])).rows[0];
  const log = (await db.query(
    `SELECT action, by_user FROM approval_task_log WHERE task_id=$1 AND action='act_by_delegate'`,
    [t1.id])).rows;

  rec('AN1','代理期内代理人可推进；任务仍挂原审批人（责任不变），并留"谁按的手"',
      Number(after.approver_id) === owner && after.status === 'approved'
      && log.length === 1 && Number(log[0].by_user) === 88,
      `归属 ${after.approver_id}（原 ${owner}）状态=${after.status} 代批留痕=${log.length}`); }

{ // AN2 代理期外：同一个人再代批 → 拒
  const rid = await applyLeave(1, '2026-08-10', '2026-08-10');
  const inst = await startAppr(rid, '2026-08-10');
  const t1 = await taskOf(inst, 1);
  let msg = '';
  try { await db.query('SELECT fn_appr_act($1,$2,true,NULL)', [inst, 88]); }
  catch (e) { msg = e.message; }
  rec('AN2','代理期外代批 → 拒（E_APPR_NOT_YOURS）；代理是按业务日期判的，不是按今天',
      msg.includes('E_APPR_NOT_YOURS'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AN3 代理自己 → 拒；区间重叠 → 拒（排斥约束）
  let selfMsg = '', overMsg = '';
  try { await db.query(`SELECT fn_delegate_add(9,9,'2026-09-01'::date,'2026-09-05'::date,'自己代理自己','hr')`); }
  catch (e) { selfMsg = e.message; }
  try {
    await db.query(`SELECT fn_delegate_add($1,77,'2026-07-20'::date,'2026-07-22'::date,'同期再找一个代理','hr')`,
      [Number((await db.query(
        `SELECT from_user FROM approval_delegate ORDER BY id LIMIT 1`)).rows[0].from_user)]);
  } catch (e) { overMsg = e.message; }
  rec('AN3','代理自己 → 拒；同一人代理区间重叠 → 拒（否则"现在谁在代理"有两个答案）',
      selfMsg.includes('E_DELEGATE_SELF') && overMsg.includes('ex_ad_no_overlap'),
      `${selfMsg ? 'self✓' : 'self✗'} ${overMsg ? 'overlap✓' : 'overlap✗'}`); }

{ // AN4 代理期上限 90 天：超了拒（与 HANDOVER_READONLY 同一条判断）
  let msg = '';
  try { await db.query(`SELECT fn_delegate_add(5,6,'2026-01-01'::date,'2026-12-31'::date,'给一整年','hr')`); }
  catch (e) { msg = e.message; }
  rec('AN4','代理期超过 90 天 → 拒（"先给一年"最后都会变成永久）',
      msg.includes('E_DELEGATE_TOO_LONG'), String(msg).split('\n')[0].slice(0, 40)); }

// ===========================================================================
// AP 组 · 加签与抄送（048）：改变结论 vs 只通知
// ---------------------------------------------------------------------------
// 这两件事经常被混成一个 "cc=true" 开关，后果很具体：
// 抄送的人被算进"这一步还剩几个待办"，流程永远差一个人；
// 或者需要签的人只被通知了一声，单据就过了。
// ===========================================================================
await db.query(`INSERT INTO leave_grant(id,employee_id,leave_type_id,qty,valid_from)
                VALUES (9002,1,1,20,'2026-01-01')`);

{ // AP1 加签后这一步必须等新签人（原本是或签，一人通过就该走）
  const rid = await applyLeave(1, '2026-09-01', '2026-09-01');
  const inst = await startAppr(rid, '2026-09-01');
  const t2x = (await db.query(
    `SELECT * FROM approval_task WHERE instance_id=$1 AND approver_id=2`, [inst])).rows[0];

  await db.query('SELECT fn_appr_addsign($1,9,$2,$3)',
    [t2x.id, 2, '这笔涉及跨店借调，请运营总监一起看']);

  const r1 = await approve(inst, 2, true);          // 原或签人通过
  const pend = (await db.query(
    `SELECT approver_id, act_kind FROM approval_task
      WHERE instance_id=$1 AND seq=1 AND status='pending' ORDER BY approver_id`, [inst])).rows;
  const r2 = await approve(inst, 9, true);          // 加签的人通过

  rec('AP1','加签后本步**不会**因为或签人点了就推进（act_kind=countersign），加签人签完才走',
      r1 === 'running' && pend.length === 1 && Number(pend[0].approver_id) === 9
      && pend[0].act_kind === 'countersign' && r2 === 'running',
      `原签人通过后=${r1} 待签=${JSON.stringify(pend.map(x=>`${x.approver_id}:${x.act_kind}`))} 加签人签完=${r2}`); }

{ // AP2 加签给申请人 → 拒
  const rid = await applyLeave(1, '2026-09-03', '2026-09-03');
  const inst = await startAppr(rid, '2026-09-03');
  const tk = (await db.query(
    `SELECT * FROM approval_task WHERE instance_id=$1 ORDER BY id LIMIT 1`, [inst])).rows[0];
  let msg = '';
  try { await db.query('SELECT fn_appr_addsign($1,1,$2,$3)', [tk.id, tk.approver_id, '加给申请人试试']); }
  catch (e) { msg = e.message; }
  rec('AP2','加签给申请人 → 拒（E_APPR_ADDSIGN_APPLICANT）；自审的入口不能从后门补回来',
      msg.includes('E_APPR_ADDSIGN_APPLICANT'), String(msg).split('\n')[0].slice(0, 44)); }

{ // AP3 重复加签同一个人 → 有名字的拒绝（而不是 23505）
  const rid = await applyLeave(1, '2026-09-05', '2026-09-05');
  const inst = await startAppr(rid, '2026-09-05');
  const tk = (await db.query(
    `SELECT * FROM approval_task WHERE instance_id=$1 ORDER BY id LIMIT 1`, [inst])).rows[0];
  await db.query('SELECT fn_appr_addsign($1,9,$2,$3)', [tk.id, tk.approver_id, '请运营总监一起看']);
  let msg = '';
  try { await db.query('SELECT fn_appr_addsign($1,9,$2,$3)', [tk.id, tk.approver_id, '再加一次看看']); }
  catch (e) { msg = e.message; }
  rec('AP3','重复加签同一个人 → 拒（E_APPR_ADDSIGN_DUPLICATE，不是 23505 冲突）',
      msg.includes('E_APPR_ADDSIGN_DUPLICATE'), String(msg).split('\n')[0].slice(0, 44)); }

{ // AP4 已经有人处理过的步骤不能加签（结算条件已成立）
  const rid = await applyLeave(1, '2026-09-07', '2026-09-07');
  const inst = await startAppr(rid, '2026-09-07');
  await approve(inst, 2, true);                     // 第 1 步先被或签人通过
  const tk1 = (await db.query(
    `SELECT * FROM approval_task WHERE instance_id=$1 AND seq=1 ORDER BY id LIMIT 1`, [inst])).rows[0];
  let msg = '';
  try { await db.query('SELECT fn_appr_addsign($1,9,$2,$3)', [tk1.id, 2, '事后补一个签名']); }
  catch (e) { msg = e.message; }
  rec('AP4','第 1 步已被通过后再加签 → 拒（E_APPR_NOT_CURRENT_STEP / E_APPR_ADDSIGN_CLOSED）；加签不能改历史',
      msg.includes('E_APPR_NOT_CURRENT_STEP') || msg.includes('E_APPR_ADDSIGN_CLOSED'),
      String(msg).split('\n')[0].slice(0, 50)); }

{ // AP5 加签与抄送都留痕，且**不改** approver_id（责任人还是原来那几个人）
  const log = (await db.query(
    `SELECT action, from_user, to_user, by_user, reason FROM approval_task_log
      WHERE action='addsign' ORDER BY id LIMIT 1`)).rows[0];
  rec('AP5','加签留痕四件套（谁加、加给谁、谁操作的、为什么）',
      !!log && Number(log.to_user) === 9 && Number(log.by_user) !== 9
      && String(log.reason).length >= 4,
      log ? `${log.from_user}→${log.to_user} by ${log.by_user}` : '无记录'); }

{ // AP6 抄送幂等：同一个 instance+user 只有一行，且不产生待办
  const rid = await applyLeave(1, '2026-09-09', '2026-09-09');
  const inst = await startAppr(rid, '2026-09-09');
  const before = Number((await db.query(
    `SELECT count(*)::int n FROM approval_task WHERE instance_id=$1`, [inst])).rows[0].n);
  const a = (await db.query('SELECT fn_appr_cc_add($1,7,$2) r', [inst, 2])).rows[0].r;
  const b = (await db.query('SELECT fn_appr_cc_add($1,7,$2) r', [inst, 2])).rows[0].r;
  const ccN = Number((await db.query(
    `SELECT count(*)::int n FROM approval_cc WHERE instance_id=$1`, [inst])).rows[0].n);
  const after = Number((await db.query(
    `SELECT count(*)::int n FROM approval_task WHERE instance_id=$1`, [inst])).rows[0].n);
  rec('AP6','抄送幂等（两次只一行），且**不产生待办**（抄送的人不在 approval_task 里）',
      a === true && b === false && ccN === 1 && after === before,
      `第一次=${a} 第二次=${b} 抄送行=${ccN} 待办 ${before}→${after}`); }

{ // AP7 抄送不能代替审批：抄送的人去 act → 拒
  const rid = (await db.query(
    `SELECT id FROM leave_request ORDER BY id DESC LIMIT 1`)).rows[0].id;
  const inst = (await db.query(
    `SELECT id FROM approval_instance WHERE biz_id=$1 ORDER BY id DESC LIMIT 1`, [rid])).rows[0].id;
  let msg = '';
  try { await approve(inst, 7, true); } catch (e) { msg = e.message; }
  rec('AP7','抄送的人去审批 → 拒（E_APPR_NOT_YOURS）；"知道了"不等于"同意了"',
      msg.includes('E_APPR_NOT_YOURS'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AP8 标记已读只能标自己的
  const cc = (await db.query(
    `SELECT id, user_id FROM approval_cc ORDER BY id DESC LIMIT 1`)).rows[0];
  let msg = '';
  try { await db.query('SELECT fn_appr_cc_seen($1,$2)', [cc.id, Number(cc.user_id) + 1]); }
  catch (e) { msg = e.message; }
  await db.query('SELECT fn_appr_cc_seen($1,$2)', [cc.id, cc.user_id]);
  const seen = (await db.query(
    'SELECT seen_at FROM approval_cc WHERE id=$1', [cc.id])).rows[0].seen_at;
  rec('AP8','标记已读只能标自己那一条（别人的 → 403），标完 seen_at 有值',
      msg.includes('E_OUT_OF_SCOPE') && seen !== null, `${String(msg).split('\n')[0].slice(0, 30)} 已读=${seen !== null}`); }

// ===========================================================================
// L 组 · 社保基数与个税累计预扣（012）
// ===========================================================================
await db.exec(`
INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,rate_employee,rate_employer) VALUES
  (1,'上海','pension','2026-01-01',5975,31014,0.08,0.16),
  (2,'上海','pension','2026-07-01',6200,32000,0.08,0.16);
`);

const base = async (w,on) =>
  Number((await db.query(`SELECT fn_si_base('上海','pension',$1,$2::date) v`,[w,on])).rows[0].v);

{ const lo = await base(3000,'2026-03-01');
  const hi = await base(50000,'2026-03-01');
  const mid= await base(10000,'2026-03-01');
  rec('L1','社保基数夹逼：低于下限按下限、高于上限按上限、区间内原值',
      lo===5975 && hi===31014 && mid===10000, `低=${lo} 高=${hi} 中=${mid}`); }

{ const before = await base(50000,'2026-03-01');
  const after  = await base(50000,'2026-08-01');
  rec('L2','政策按 effective_from 版本化：7 月前后上限不同（改政策不追溯）',
      before===31014 && after===32000, `3月=${before} 8月=${after}`); }

{ const t = Number((await db.query(`SELECT fn_iit_cumulative(30000) v`)).rows[0].v);
  rec('L3','累计预扣：累计应纳税 30000 → 税额 900（3% 档）', t===900, t); }

{ const t = Number((await db.query(`SELECT fn_iit_month(40000, 900) v`)).rows[0].v);
  rec('L4','本月应预扣 = 累计税额(1480) − 已预扣(900) = 580', t===580, t); }

{ // 档位衔接：36000 与 36000.01 的税额必须连续（速算扣除额正确）
  const a = Number((await db.query(`SELECT fn_iit_cumulative(36000) v`)).rows[0].v);
  const b = Number((await db.query(`SELECT fn_iit_cumulative(36000.01) v`)).rows[0].v);
  rec('L5','档位衔接连续（速算扣除额正确，不会出现跨档跳变）',
      Math.abs(b-a) < 0.01, `36000→${a} 36000.01→${b}`); }

{ // 已预扣超过累计税额时，本月不得为负（不退税，退税走汇算）
  const t = Number((await db.query(`SELECT fn_iit_month(10000, 500) v`)).rows[0].v);
  rec('L6','已预扣 > 累计税额 → 本月为 0，不出负数', t===0, t); }


// ===========================================================================
// O 组 · 调动与四条归属线（014）
// ===========================================================================
// ★ 种子用显式 id，而表用 BY DEFAULT AS IDENTITY —— 序列不会因为显式插入而前进。
//   不同步的直接后果：下一次自动插入撞已有主键，报 duplicate key。
//   这在"测试用固定 id、生产用自增"的项目里是必踩的坑。
// 显式 id 播种 + BY DEFAULT AS IDENTITY ⇒ 序列不前进。
// 凡"用固定 id 播种"的表都要在这里同步，否则下一次自动插入撞主键。
async function syncSeq() {
  // ★ 原来这里是手写的一张表清单。加 person 那次就是"想起来才加"的典型：
  //   换成扫 information_schema，一张表一张表地记这种事从此不用再做。
  const ids = (await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND is_identity='YES'`)).rows;
  for (const { table_name, column_name } of ids) {
    await db.query(
      `SELECT setval(pg_get_serial_sequence($1,$2),
                     GREATEST((SELECT COALESCE(max(${column_name}),1) FROM ${table_name}), 1))`,
      [table_name, column_name]);
  }
}
await syncSeq();

await db.exec(`
INSERT INTO person(id,full_name) VALUES (3,'王五');
INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES (30,3,1,'2026-01-01');
INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from) VALUES
  (3,'cost_org',10,'2026-01-01'),
  (3,'attendance_org',10,'2026-01-01');
INSERT INTO transfer_order(id,employee_id,effective_date,new_cost_org_id,new_attendance_org_id)
  VALUES (1,3,'2026-06-01',11,11);
`);

const attr = async (emp,on) => Object.fromEntries(
  (await db.query('SELECT dim_code, value_id FROM fn_attr_asof($1,$2::date)',[emp,on])).rows
    .map(r=>[r.dim_code, Number(r.value_id)]));

{ const a = await attr(3,'2026-03-01');
  rec('O1','调动前：成本/考勤组织=10，发薪法人=1（四条线各自独立成账）',
      a.cost_org===10 && a.attendance_org===10 && a.payroll_legal_entity===1, JSON.stringify(a)); }

await db.query(`SELECT fn_transfer_apply(1)`);

{ const before = await attr(3,'2026-05-31');
  const on     = await attr(3,'2026-06-01');
  rec('O2','同集团调动：成本/考勤组织改 11，**发薪法人不变**（跟合同走）',
      before.cost_org===10 && on.cost_org===11 && on.attendance_org===11
      && on.payroll_legal_entity===1,
      `前一天=${JSON.stringify(before)} 当天=${JSON.stringify(on)}`); }

{ const hist = await attr(3,'2026-07-15');
  rec('O3','归属类区间 \u0027[]\u0027：生效日当天起就是新归属（不是次日）',
      hist.cost_org===11, `2026-07-15 cost_org=${hist.cost_org}`); }

{ const old = await attr(3,'2026-02-10');
  rec('O4','历史查询仍取旧归属（不是"改了之后所有历史都跟着变"）',
      old.cost_org===10, `2026-02-10 cost_org=${old.cost_org}`); }

await expectErr(() => db.exec(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from,valid_to)
    VALUES (3,'cost_org',20,'2026-06-01','2026-12-31')`),
  'ex_eoa_no_overlap','O5','同一维度区间重叠 → 23P01（排斥约束按 dim 分开，不是按 employee）');

{ // 转签主体：唯一会动发薪法人的动作，且它动的是"新开一段任职"
  await db.exec(`INSERT INTO transfer_order(id,employee_id,effective_date,new_legal_entity_id)
                 VALUES (2,3,'2026-09-01',2)`);
  await db.query(`SELECT fn_transfer_apply(2)`);
  const emps = (await db.query(`SELECT id, legal_entity_id, hire_date, leave_date
                                  FROM employment WHERE person_id=3 ORDER BY hire_date`)).rows;
  const ple = await attr(3,'2026-09-15');
  const dstr = v => v==null ? null : (v instanceof Date ? v.toISOString().slice(0,10) : String(v).slice(0,10));
  rec('O6','转签主体：新开一段任职（两条任职），发薪法人随之变',
      emps.length===2 && dstr(emps[0].leave_date)==='2026-08-31'
      && Number(emps[1].legal_entity_id)===2 && ple.payroll_legal_entity===2,
      `任职段=${emps.map(e=>e.legal_entity_id+':'+dstr(e.leave_date))}`); }

{ // 拒重复执行
  let blocked=false, note='';
  try { await db.query(`SELECT fn_transfer_apply(1)`); note='重复执行成功了'; }
  catch(e){ blocked = String(e.message).includes('E_TRANSFER_ALREADY'); note=e.code; }
  rec('O7','调动单重复执行 → 拒绝', blocked, note); }


// ===========================================================================
// P 组 · 算薪全流程（015）：走真钱
// ===========================================================================
await db.exec(`
INSERT INTO person(id,full_name) VALUES (10,'赵六');
INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES (40,10,1,'2026-01-01');
INSERT INTO salary_standard(employment_id,monthly_amount,effective_from) VALUES (40,8000,'2026-01-01');
-- 2 天已批准事假（只认 approved）
INSERT INTO leave_type(id,code,name,expire_policy) VALUES (3,'PERSONAL','事假','void')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO leave_request(employee_id,leave_type_id,qty,date_from,date_to,status,decided_at)
  VALUES (10, 3, 2, '2026-04-10', '2026-04-11', 'approved', now());
INSERT INTO pay_run(id,period,legal_entity_id,status) VALUES (2,'2026-04',1,'draft');
-- 让自增序列跟上显式 id
SELECT setval(pg_get_serial_sequence('employment','id'),
              GREATEST((SELECT max(id) FROM employment),1));
`);

const n = Number((await db.query(`SELECT fn_payroll_calc(2) n`)).rows[0].n);
const slip = (await db.query(`SELECT * FROM payslip WHERE pay_run_id=2 AND employee_id=10`)).rows[0];

{ rec('P1','算薪生成 1 张工资条', n===1 && !!slip, `生成=${n}`); }

{ const gross = Number(slip?.gross_amount), leave = Number(slip?.leave_deduct);
  rec('P2','应发 = 月薪 8000 − 事假扣款 735.63 = 7264.37（只认 approved 的天数）',
      Math.abs(gross-7264.37)<0.02 && Math.abs(leave-735.63)<0.02,
      `gross=${gross} leave=${leave}`); }

{ const si = Number(slip?.si_employee);
  rec('P3','社保 = 夹逼后基数 8000 × 8% = 640（基数不因请假而变）',
      Math.abs(si-640)<0.02, `si=${si}`); }

{ const taxable = Number(slip?.cum_taxable);
  rec('P4','应纳税所得 = 7264.37 − 640 − 5000 = 1624.37（社保在税前扣）',
      Math.abs(taxable-1624.37)<0.02, `taxable=${taxable}`); }

{ const tax = Number(slip?.tax_amount), net = Number(slip?.net_amount);
  rec('P5','个税 = 1624.37×3% = 48.73；实发 = 7264.37 − 640 − 48.73 = 6575.64',
      Math.abs(tax-48.73)<0.02 && Math.abs(net-6575.64)<0.02, `tax=${tax} net=${net}`); }

{ const rows = (await db.query(`SELECT * FROM v_payslip_consistency`)).rows;
  rec('P6','勾稽视图为空：明细项之和 = 应发−社保−个税，实发一致，应发非负',
      rows.length===0, JSON.stringify(rows.slice(0,2))); }

{ const items = (await db.query(`SELECT item_code, amount FROM payslip_item
                                  WHERE payslip_id=$1 ORDER BY item_code`,[slip.id])).rows;
  rec('P7','每个数可追来源（BASE / LEAVE_DEDUCT / SI_EMPLOYEE / IIT 四行）',
      items.length===4 && items.some(i=>i.item_code==='BASE')
      && items.some(i=>i.item_code==='LEAVE_DEDUCT'),
      items.map(i=>`${i.item_code}=${i.amount}`).join(' ')); }

{ await db.exec(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=2`);
  let blocked=false, note='';
  try { await db.query(`SELECT fn_payroll_calc(2)`); note='封账后仍可重算'; }
  catch(e){ blocked = String(e.message).includes('E_RUN_SEALED'); note=e.code; }
  rec('P8','封账后不可重算 → 拒绝', blocked, note); }


// ===========================================================================
// Q 组 · 考勤封账 → 算薪的时间边界（016）
// ===========================================================================
const T0b='2026-05-06T08:00:00Z', T1b='2026-05-06T16:00:00Z';
const ADS2 = `INSERT INTO attendance_daily_store
  (id,employee_id,store_id,work_date,shift_start_at,shift_end_at,
   span_hours,on_duty_hours,off_duty_hours,break_on_duty_hours,in_attendance_hours,work_hours,
   snap_on_duty_break_basis)
  VALUES ($1,$2,60,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;

await db.query(ADS2,[900,10,'2026-05-06',T0b,T1b,8,8,0,1,7,6,'allowance']);
await db.exec(`INSERT INTO pay_run(id,period,legal_entity_id,status) VALUES (3,'2026-05',1,'draft')`);

{ // Q1 未封账 → 算薪被拒，且清单要点名是哪家店
  let blocked=false, msg='';
  try { await db.query(`SELECT fn_payroll_calc(3)`); msg='未封账却算成功了'; }
  catch(e){ msg=String(e.message); blocked = msg.includes('E_ATT_NOT_CLOSED') && msg.includes('60'); }
  rec('Q1','有考勤但未封账 → 算薪被拒且点名门店（不是"按未封账数据先算着"）',
      blocked, msg.split('\n')[0].slice(0,70)); }

// 封账
await db.query(`SELECT fn_att_close(60,'2026-05','hr_zhang')`);

{ const c = (await db.query(`SELECT status,snap_rows,snap_hours,snap_digest FROM attendance_close
                              WHERE store_id=60 AND period='2026-05'`)).rows[0];
  rec('Q2','封账冻结了一个可复核的数（行数/工时/摘要三样都在）',
      c?.status==='closed' && Number(c.snap_rows)===1 && Number(c.snap_hours)===6 && !!c.snap_digest,
      `rows=${c?.snap_rows} hours=${c?.snap_hours} digest=${String(c?.snap_digest).slice(0,8)}`); }

{ const n = Number((await db.query(`SELECT fn_payroll_calc(3) n`)).rows[0].n);
  const p = (await db.query(`SELECT net_amount FROM payslip WHERE pay_run_id=3`)).rows[0];
  rec('Q3','封账后算薪通过（1 张工资条）', n===1 && !!p, `生成=${n} net=${p?.net_amount}`); }

await expectErr(() => db.query(ADS2,[901,10,'2026-05-07',T0b,T1b,8,8,0,1,7,6,'allowance']),
  'E_ATT_CLOSED','Q4','封账后 INSERT 考勤 → 拒');

await expectErr(() => db.exec(`UPDATE attendance_daily_store SET work_hours=6 WHERE id=900`),
  'E_ATT_CLOSED','Q5','封账后 UPDATE 考勤 → 拒');

await expectErr(() => db.exec(`DELETE FROM attendance_daily_store WHERE id=900`),
  'E_ATT_CLOSED','Q6','封账后 DELETE 考勤 → 拒（只测 UPDATE 是固定漏洞）');

await expectErr(() => db.exec(`UPDATE attendance_close SET status='open' WHERE store_id=60 AND period='2026-05'`),
  'E_ATT_REOPEN','Q7','封账改回 open → 拒（每一步都是合法 UPDATE）');

await expectErr(() => db.exec(`DELETE FROM attendance_close WHERE store_id=60 AND period='2026-05'`),
  'E_ATT_CLOSE_ROW_DELETED','Q8','删掉封账行 → 拒（删一行＝解封，且不留痕迹）');

{ const rows = (await db.query(`SELECT * FROM fn_att_verify(60,'2026-05')`)).rows;
  rec('Q9','摘要校验为空：封账后没有任何写穿过', rows.length===0, JSON.stringify(rows)); }

{ // ★ Q10 —— 整个快照摘要机制存在的理由：触发器可以被关掉
  await db.exec(`ALTER TABLE attendance_daily_store DISABLE TRIGGER trg_ads_frozen`);
  await db.exec(`UPDATE attendance_daily_store SET in_attendance_hours=7.5, work_hours=6.5 WHERE id=900`);
  const bad = (await db.query(`SELECT * FROM fn_att_verify(60,'2026-05')`)).rows;
  // 还原后再使能，否则后续断言会因残留而结论不同
  await db.exec(`UPDATE attendance_daily_store SET in_attendance_hours=7, work_hours=6 WHERE id=900`);
  await db.exec(`ALTER TABLE attendance_daily_store ENABLE TRIGGER trg_ads_frozen`);
  const ok = (await db.query(`SELECT * FROM fn_att_verify(60,'2026-05')`)).rows;
  rec('Q10','关掉触发器改数据 → 摘要抓得到；还原后校验回空（拦不住的也查得出）',
      bad.length===1 && ok.length===0,
      `绕过时命中=${bad.length} 还原后=${ok.length}`); }

await expectErr(() => db.exec(`INSERT INTO attendance_adjustment
    (employee_id,store_id,work_date,hours_delta,apply_period,reason,created_by)
    VALUES (10,60,'2026-05-06',0.5,'2026-05','门店漏记半小时','hr_zhang')`),
  'ck_aa_forward','Q11a','补账不许落回原期间（往前就是改历史换了个名字）');

{ let ok=false, note='';
  try {
    await db.exec(`INSERT INTO attendance_adjustment
      (employee_id,store_id,work_date,hours_delta,apply_period,reason,created_by)
      VALUES (10,60,'2026-05-06',0.5,'2026-06','门店漏记半小时','hr_zhang')`);
    ok=true; note='补到下一期，结构上无法追溯';
  } catch(e){ note=e.code+' '+String(e.message).split('\n')[0]; }
  rec('Q11b','补账落到下一期 → 接受（唯一合法的修正通道）', ok, note); }

await expectErr(() => db.exec(`INSERT INTO attendance_adjustment
    (employee_id,store_id,work_date,hours_delta,apply_period,reason,created_by)
    VALUES (10,60,'2026-05-06',0.5,'2026-06','   x   ','hr_zhang')`),
  'ck_aa_reason','Q12','补账理由空白 → 拒（空格能通过 NOT NULL）');

await expectErr(() => db.query(`SELECT fn_att_close(61,'2026-05','hr_zhang')`),
  'E_ATT_CLOSE_EMPTY','Q13','封一个没有考勤的期间 → 拒（否则日后填数据只能解封）');

{ // Q14 机器判据：**会被函数 INSERT 的表**，主键必须有生成方式（这条错犯过五次）
  //
  //   判据收窄过一次：起初写成「凡单列 bigint 主键叫 id 就必须 IDENTITY」，
  //   扫出 19 张表——而没有一张真被函数插过，全是字典表与种子表
  //   （si_policy / leave_type / sys_data_scope 的 id 是业务码，强制自增反而错）。
  //   判据写宽与写窄的失效方向不同：写宽会被当成噪音关掉，写窄会漏。
  //   这里选窄，并把分母（候选集大小）一起报出来。
  //
  //   已知局限：靠 prosrc 文本匹配找 INSERT，动态 SQL 拼出来的插入看不见。
  //   所以它是静态补漏，运行期的证据是 E 组到 P 组那些真插入。
  const cand = (await db.query(`
    SELECT c.relname, a.attidentity
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='id' AND NOT a.attisdropped
      JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary AND i.indnatts=1
     WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace
       AND a.attnum = i.indkey[0] AND a.atttypid='int8'::regtype
       AND EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.prosrc ~ ('INSERT INTO (public\\.)?' || c.relname || '\\M'))
     ORDER BY 1`)).rows;
  const bad14 = cand.filter(r => r.attidentity === '');
  rec('Q14','会被函数 INSERT 的表，主键都有生成方式（缺则报 not-null，报错指向 id 不像表设计问题）',
      bad14.length === 0,
      `候选 ${cand.length} 张，缺 IDENTITY ${bad14.length} 张${bad14.length ? '：' + bad14.map(r=>r.relname).join(',') : ''}`); }

{ // Q15 分母非空 —— 否则 Q14 是"没扫到任何表"式的假绿
  const n = (await db.query(`
    SELECT count(*)::int n FROM pg_class c
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='id' AND NOT a.attisdropped
      JOIN pg_index i ON i.indrelid=c.oid AND i.indisprimary AND i.indnatts=1
     WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace
       AND a.attnum = i.indkey[0] AND a.atttypid='int8'::regtype`)).rows[0].n;
  rec('Q15','Q14 的分母非空（扫到了带 bigint 主键的表，不是"0 张所以通过"）',
      n > 0, `候选总表 ${n} 张`); }


// ===========================================================================
// R 组 · 组织树版本切片（017）
// ===========================================================================
// 在既有 org_unit 上演进，不另造一棵树：
//   2026-01  集团1 → 华东区30 → A店10 / B店11；C店20 直属
//   2026-09  上海大区31、华南区32 从华东区拆出，A店改挂31、B店改挂32
await db.exec(`
INSERT INTO org_unit(id,parent_id,name,path) VALUES (30,1,'华东区','001.030');
UPDATE org_unit SET parent_id=30, path='001.030.010' WHERE id=10;
UPDATE org_unit SET parent_id=30, path='001.030.011' WHERE id=11;

INSERT INTO org_version(id,version_no,effective_date,status,note)
  VALUES (1,1,'2026-01-01','draft','初始');
INSERT INTO org_unit_snapshot(version_id,unit_id,parent_id,name,path) VALUES
  (1,1,NULL,'集团','001'),(1,30,1,'华东区','001.030'),
  (1,10,30,'A店','001.030.010'),(1,11,30,'B店','001.030.011'),
  (1,20,1,'C店','001.020');
SELECT fn_org_publish(1);

-- 2026-09 重组
INSERT INTO org_unit(id,parent_id,name,path) VALUES
  (31,30,'上海大区','001.030.031'),(32,1,'华南区','001.032');
UPDATE org_unit SET parent_id=31, path='001.030.031.010' WHERE id=10;
UPDATE org_unit SET parent_id=32, path='001.032.011' WHERE id=11;

INSERT INTO org_version(id,version_no,effective_date,status,note)
  VALUES (2,2,'2026-09-01','draft','华东区拆出上海大区，B店划归华南');
INSERT INTO org_unit_snapshot(version_id,unit_id,parent_id,name,path) VALUES
  (2,1,NULL,'集团','001'),(2,30,1,'华东区','001.030'),
  (2,31,30,'上海大区','001.030.031'),(2,32,1,'华南区','001.032'),
  (2,10,31,'A店','001.030.031.010'),(2,11,32,'B店','001.032.011'),
  (2,20,1,'C店','001.020');
SELECT fn_org_publish(2);
`);

const anc = async (unit,on) => (await db.query(
  'SELECT unit_id,depth FROM fn_org_ancestors($1,$2::date) ORDER BY depth DESC',[unit,on])).rows
  .map(r=>Number(r.unit_id));

{ const c = await anc(10,'2026-03-01');
  rec('R1','2026-03 时点：A店 的祖先链是 10 → 30(华东区) → 1(集团)',
      JSON.stringify(c)===JSON.stringify([10,30,1]), JSON.stringify(c)); }

{ const before = await anc(10,'2026-08-31');
  const after  = await anc(10,'2026-09-01');
  rec('R2','重组后 A店 改挂 31(上海大区)，生效日当天即变（版本按 effective_date 切）',
      JSON.stringify(before)===JSON.stringify([10,30,1])
      && JSON.stringify(after)===JSON.stringify([10,31,30,1]),
      `8/31=${JSON.stringify(before)} 9/1=${JSON.stringify(after)}`); }

{ // R3 —— 这一条是整组的核心
  const now = await anc(10,'2026-03-01');
  rec('R3','**改完树之后查 2026-03，答案仍是 30**（历史不是被维护的，是没被改写的）',
      JSON.stringify(now)===JSON.stringify([10,30,1]), JSON.stringify(now)); }

{ let blocked=false, note='';
  try { await anc(10,'2025-06-01'); note='静默返回了某个版本'; }
  catch(e){ blocked = String(e.message).includes('E_ORG_NO_VERSION'); note=e.code; }
  rec('R4','早于第一个版本的时点 → 报"不可判"，不静默用当前值顶替', blocked, note); }

await expectErr(() => db.exec(`INSERT INTO org_unit_snapshot(version_id,unit_id,parent_id,name,path)
    VALUES (1,999,30,'新店','001.030.999')`),
  'E_ORG_SNAPSHOT_FROZEN','R5','已发布版本的快照不可增（历史只能新增版本，不能补写）');

await expectErr(() => db.exec(`UPDATE org_unit_snapshot SET parent_id=1
    WHERE version_id=1 AND unit_id=10`),
  'E_ORG_SNAPSHOT_FROZEN','R6','已发布版本的快照不可改');

await expectErr(() => db.exec(`UPDATE org_version SET effective_date='2026-02-01' WHERE id=1`),
  'E_ORG_DATE_FROZEN','R7','已发布版本的生效日不可改（改它＝把过去整体换一版，报表不报错只换数）');

{ // R8 最新版必须覆盖现行树：v3 故意漏掉 C店
  await db.exec(`
    INSERT INTO org_version(id,version_no,effective_date,status,note)
      VALUES (3,3,'2027-01-01','draft','下一次调整');
    INSERT INTO org_unit_snapshot(version_id,unit_id,parent_id,name,path)
      SELECT 3, unit_id, parent_id, name, path FROM org_unit_snapshot
       WHERE version_id=2 AND unit_id<>20;`);
  let blocked=false, note='';
  try { await db.query(`SELECT fn_org_publish(3)`); note='漏了店铺也发布成功'; }
  catch(e){ blocked = String(e.message).includes('E_ORG_VERSION_INCOMPLETE')
            && String(e.message).includes('20'); note=e.code; }
  rec('R8','发布最新版时现行树里有节点缺失 → 拒并点名（否则新店在组织树里不存在）',
      blocked, note);
  await db.exec(`INSERT INTO org_unit_snapshot(version_id,unit_id,parent_id,name,path)
                 VALUES (3,20,1,'C店','001.020')`);
  await db.query(`SELECT fn_org_publish(3)`);
  const st = (await db.query(`SELECT status FROM org_version WHERE id=3`)).rows[0].status;
  rec('R9','补齐后发布成功（发布是整棵树的一次性动作，不是逐节点开开关）', st==='published', st); }


// ===========================================================================
// T 组 · 验收体系自证：本次结果写进登记表，再从覆盖率读回来
// ===========================================================================
// 002 建完登记表之后，fn_chk_coverage 的结论一直是 never_run ——
// 因为从来没有东西往里写过。一个从不上报的报表，与没有报表在效果上相同。
const snapshot = results.slice();          // 先拍下 A–R 的结果，别把自己算进去
const byGroup = {};
for (const r of snapshot) {
  const g = (String(r.id).match(/^[A-Z]+/) || ['?'])[0];
  (byGroup[g] ||= []).push(r);
}

const recorded = [];
const recFail = [];
for (const [g, rs] of Object.entries(byGroup)) {
  const code = `SUITE.${g}`;
  const fails = rs.filter(r => !r.ok).length;
  try {
    await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
      [code, fails === 0 ? 'pass' : 'fail', fails, null]);
    recorded.push({ code, group: g, n: rs.length, fails });
  } catch(e) { recFail.push(`${g}:${e.code || e.message}`); }
}

{ const all = Object.keys(byGroup).sort();
  const done = recorded.map(x => x.group).sort();
  const missing = all.filter(g => !done.includes(g));
  // 记录失败不能静默：吞掉异常等于"这条判据的结论消失了，而报告仍然完整"
  rec('T1','本次每一组都写进了登记表（未登记的组留不下结论，写入失败也不许吞）',
      missing.length === 0 && recFail.length === 0,
      `组 ${all.length} 个，已记 ${done.length}`
      + (missing.length ? '，缺 ' + missing.join(',') : '')
      + (recFail.length ? '，写入失败 ' + recFail.join(',') : '')); }

{ // ★ 这一条是接线的**唯一目的**：覆盖率不再是空的
  const rows = (await db.query(
    `SELECT check_code, bucket FROM fn_chk_coverage('2026-11-14'::date)
      WHERE check_code = ANY($1)`, [recorded.map(x => x.code)])).rows;
  const never = rows.filter(r => r.bucket === 'never_run').length;
  const pass  = rows.filter(r => r.bucket === 'pass').length;
  const notPass = rows.filter(r => r.bucket !== 'pass').map(r => `${r.check_code}:${r.bucket}`);
  rec('T2','覆盖率对这些组不再是 never_run，且全部落在 pass',
      never === 0 && pass === rows.length && rows.length === new Set(recorded.map(x=>x.code)).size,
      `pass=${pass} never_run=${never} 共=${rows.length} 非pass=${notPass.join(',') || '无'}`); }

{ // 一条从上一次跑到现在都没动过的判据，报表上必须能看出来
  const r = (await db.query(
    `SELECT max(run_at) t FROM sys_check_run`)).rows[0].t;
  rec('T3','运行记录带判定型时间戳（能回答"上次是什么时候跑的"）', !!r, String(r).slice(0,24)); }

{ // T4 未登记的判据不许留痕
  let blocked = false, note = '';
  try { await db.query(`SELECT fn_chk_record('SUITE.ZZ','pass')`); note = '未登记也写进去了'; }
  catch(e){ blocked = String(e.message).includes('E_CHK_UNREGISTERED'); note = e.code; }
  rec('T4','未登记的判据 → 拒绝记录（否则会留下没人读的结论）', blocked, note); }

{ // T5 记 skipped 会被"黄必须有人认领"拦住 —— 这是两条约束的交叉，不是我刻意造的
  let blocked = false, note = '';
  try { await db.query(`SELECT fn_chk_record('SUITE.A','skipped')`); note = 'skipped 静默记成了某色'; }
  catch(e){ blocked = String(e.message).includes('ck_scr_yellow'); note = e.code; }
  rec('T5','记 skipped 需先有人认领（ck_scr_yellow）：否则"没跑"会被记成一个中性色',
      blocked, note); }

{ // T6 四桶分开报，不给单一百分比
  const rows = (await db.query(`SELECT bucket, n FROM fn_chk_summary('2026-11-14'::date)`)).rows;
  rec('T6','覆盖率按桶报（不给"通过率 95%"这种把没跑过与失败折在一起的数）',
      Array.isArray(rows) && rows.length >= 1, JSON.stringify(rows)); }


// ===========================================================================
// V 组 · 外包协同：供应商受限账号 + 双方对账（019）
// ===========================================================================
await db.exec(`
INSERT INTO supplier(id,code,name) VALUES (1,'S001','甲劳务'),(2,'S002','乙劳务');
INSERT INTO outsourced_worker(id,supplier_id,full_name,worker_code,valid_from) VALUES
  (1,1,'外包甲一','W001','2026-01-01'),
  (2,1,'外包甲二','W002','2026-01-01'),
  (3,2,'外包乙一','W003','2026-01-01');
INSERT INTO supplier_rate(supplier_id,effective_from,unit_price) VALUES
  (1,'2026-01-01',30.0000),(1,'2026-06-01',35.0000);
-- 我方记录：w1 两天、w2 一天
INSERT INTO outsourced_timesheet(worker_id,work_date,hours,confirmed_by) VALUES
  (1,'2026-04-01',8,'店长王'),(1,'2026-04-02',8,'店长王'),(2,'2026-04-01',6,'店长王');
-- 对方记录：w1 只报了 4/1；w2 报 5（与我方 6 不一致）；w3 报了 4（我方没记）
INSERT INTO supplier_timesheet(worker_id,work_date,hours,submitted_by) VALUES
  (1,'2026-04-01',8,'jia_chen'),(2,'2026-04-01',5,'jia_chen'),(3,'2026-04-01',4,'yi_li');
`);

{ // V1 结构性排除：外包人员根本不是 person
  const c = (await db.query(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name='outsourced_worker' AND column_name='person_id'`)).rows[0].n;
  rec('V1','outsourced_worker 没有 person_id（排除是默认，包含才需显式写）', c===0,
      c===0 ? '无 person_id 列' : '有 person_id，外包工会自动进个税名单'); }

// ★ 角色是**集群级**的，不是库级的：重建库不会把它清掉，于是第二次跑就
//   `role "sup_portal" already exists`。这条错只在真 PG 上出现（PGlite 每次都是新实例）。
await db.exec(`
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sup_portal') THEN
    CREATE ROLE sup_portal NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO sup_portal;
GRANT SELECT ON outsourced_worker, supplier_timesheet TO sup_portal;
`);

// ★ SET ROLE 与 SET app.supplier_id 都是**会话级**的，必须落在同一条连接上。
//   池化驱动下 `db.query` 每次可能换连接 —— 所以这两段走 withTx（一个事务 = 一条连接）。
//   PGlite 上"每次都是那条唯一连接"，这个约束看不出来；真库上不包起来就会随机串。
{ // V2 RLS：换成一个非超级用户角色才测得出来
  const pick = (sid) => withTx(db, async (tx) => {
    await tx.query('SET ROLE sup_portal');
    await tx.query(`SET app.supplier_id = '${sid}'`);
    const rows = (await tx.query(
      `SELECT worker_id FROM supplier_timesheet ORDER BY worker_id`)).rows;
    await tx.query('RESET ROLE');
    return rows.map(r => Number(r.worker_id));
  });
  const mine = await pick(1);
  const other = await pick(2);
  rec('V2','供应商账号只看自己的工时（RLS，不靠每个查询记得加 WHERE）',
      JSON.stringify(mine)===JSON.stringify([1,2]) && JSON.stringify(other)===JSON.stringify([3]),
      `甲看到=${JSON.stringify(mine)} 乙看到=${JSON.stringify(other)}`); }

{ // V3 没设会话变量 → 0 行（fail-closed），不是全表
  const n = await withTx(db, async (tx) => {
    await tx.query('SET ROLE sup_portal');
    await tx.query('RESET app.supplier_id');
    const r = (await tx.query(`SELECT count(*)::int n FROM supplier_timesheet`)).rows[0].n;
    await tx.query('RESET ROLE');
    return Number(r);
  });
  rec('V3','未设 app.supplier_id → 0 行（fail-closed，不是全表）', n===0, `行数=${n}`); }

{ // V4 差异只有三种形态，处置方向各不相同
  const rows = (await db.query(`SELECT kind, ours, theirs FROM fn_supplier_diff(1,'2026-04') ORDER BY kind`)).rows;
  const kinds = rows.map(r=>r.kind);
  rec('V4','差异三种形态分开报：only_ours / only_theirs / hours_differ（不压成一个差数）',
      kinds.includes('only_ours') && kinds.includes('hours_differ')
      && !kinds.includes('only_theirs'), JSON.stringify(rows)); }

const sid = Number((await db.query(`SELECT fn_settle_build(1,'2026-04') id`)).rows[0].id);
{ const s = (await db.query(`SELECT * FROM settlement WHERE id=$1`,[sid])).rows[0];
  rec('V5','两份数各自保留：我方 22h/660 元、对方 13h/390 元（不取平均也不取小）',
      Number(s.our_hours)===22 && Number(s.their_hours)===13
      && Number(s.our_amount)===660 && Number(s.their_amount)===390
      && s.status==='disputed' && s.diff_count===2,
      `我方 ${s.our_hours}h/${s.our_amount} 对方 ${s.their_hours}h/${s.their_amount} 差异 ${s.diff_count} 条`); }

await expectErr(() => db.query(`SELECT fn_settle_confirm($1,'cai_wu')`,[sid]),
  'E_SETTLE_HAS_DIFF','V6','有差异的单不可确认（差异不会被"顺手结掉"）');

{ // V7 双方补齐 → 一致 → 可确认
  await db.exec(`UPDATE supplier_timesheet SET hours=6 WHERE worker_id=2 AND work_date='2026-04-01'`);
  await db.exec(`INSERT INTO supplier_timesheet(worker_id,work_date,hours,submitted_by)
                 VALUES (1,'2026-04-02',8,'jia_chen')`);
  const id2 = Number((await db.query(`SELECT fn_settle_build(1,'2026-04') id`)).rows[0].id);
  const s = (await db.query(`SELECT status,our_hours,their_hours,diff_count FROM settlement WHERE id=$1`,[id2])).rows[0];
  await db.query(`SELECT fn_settle_confirm($1,'cai_wu')`,[id2]);
  const s2 = (await db.query(`SELECT status FROM settlement WHERE id=$1`,[id2])).rows[0].status;
  rec('V7','双方补齐后一致（diff=0）→ 转 submitted → 可确认 → confirmed',
      s.status==='submitted' && Number(s.diff_count)===0
      && Number(s.our_hours)===Number(s.their_hours) && s2==='confirmed',
      `${s.status}(${s.our_hours}/${s.their_hours}) → ${s2}`); }

await expectErr(() => db.exec(`UPDATE settlement SET our_amount=1 WHERE supplier_id=1 AND period='2026-04'`),
  'E_SETTLE_AMOUNT_FROZEN','V8','已确认的结算单金额不可改');

await expectErr(() => db.exec(`UPDATE settlement SET status='draft', confirmed_at=NULL
    WHERE supplier_id=1 AND period='2026-04'`),
  'E_SETTLE_REOPEN','V9','已确认的结算单不可退回 draft（真正的绕过路径）');

{ // V10 改价不追溯：4 月用 30，7 月用 35
  const apr = Number((await db.query(`SELECT fn_supplier_rate(1,'2026-04-15'::date) v`)).rows[0].v);
  const jul = Number((await db.query(`SELECT fn_supplier_rate(1,'2026-07-15'::date) v`)).rows[0].v);
  rec('V10','单价按生效日版本：4 月 30 元、7 月 35 元（改价不追溯已经算过的月份）',
      apr===30 && jul===35, `4月=${apr} 7月=${jul}`); }

{ // V11 缺单价必须有名字地失败，而不是算出 0
  let blocked=false, note='';
  try { await db.query(`SELECT fn_supplier_rate(2,'2026-04-15'::date)`); note='返回了某个值'; }
  catch(e){ blocked = String(e.message).includes('E_SUPPLIER_RATE_MISSING'); note=e.code; }
  rec('V11','缺单价 → 有名字地失败（算成 0 会让对账单看起来"金额为零"，而那是另一件事）',
      blocked, note); }

{ // V12 工资条里不会出现外包人员（结构性：他们不在 person 里）
  const n = (await db.query(
    `SELECT count(*)::int n FROM payslip p
      WHERE NOT EXISTS (SELECT 1 FROM person WHERE id = p.employee_id)`)).rows[0].n;
  rec('V12','工资条里没有不存在的自然人（外包工不会顺带进个税与工资条）', n===0, `孤立 ${n} 条`); }


// ===========================================================================
// W 组 · 组织级授权（020）：集团统一管理
// ===========================================================================
// 树形（R 组之后的现行树）：1 集团 → 30 华东区 → 31 上海大区 → 10 A店
//                           1 集团 → 32 华南区 → 11 B店
await db.exec(`
INSERT INTO sys_user_org(user_id,org_id,effective_from) VALUES
  (70,10,'2026-01-01'),   -- 挂在 A店
  (71,30,'2026-01-01'),   -- 挂在 华东区
  (72,10,'2026-01-01');   -- 挂在 A店，用于"到期失效"

-- 角色2/范围200 授给「华东区」：A店的人应当继承
INSERT INTO sys_org_grant(org_id,role_id,data_scope_id,effective_from,granted_by,reason)
  VALUES (30,2,200,'2026-01-01','group_hr','集团统一：华东区各店 HR 统一权限');
-- 角色3/范围100 授给「A店」：华东区的人不应当获得（继承不反向）
INSERT INTO sys_org_grant(org_id,role_id,data_scope_id,effective_from,granted_by,reason)
  VALUES (10,3,100,'2026-01-01','area_hr','A店单店特殊权限');
`);

const eff = async (u,on) => (await db.query(
  `SELECT role_id, data_scope_id, source, via_org_id
     FROM fn_effective_roles($1,$2::date) ORDER BY role_id, source`,[u,on])).rows
  .map(r=>({role:Number(r.role_id), scope:Number(r.data_scope_id), src:r.source, via:r.via_org_id===null?null:Number(r.via_org_id)}));

{ const rows = await eff(70,'2026-03-01');
  rec('W1','组织授权向上继承：授在华东区(30)，A店(10)的人获得',
      rows.some(r=>r.role===2 && r.src==='org' && r.via===30),
      JSON.stringify(rows)); }

{ const rows = await eff(71,'2026-03-01');
  rec('W2','**不反向继承**：授在 A店(10)，华东区(30)的人不获得',
      !rows.some(r=>r.role===3),
      JSON.stringify(rows.map(r=>r.role))); }

{ const rows = await eff(70,'2026-03-01');
  rec('W3','来源可查：每条权限带 direct / org + 是哪个组织给的（审计要回答"他为什么有"）',
      rows.every(r=>r.src==='direct' || (r.src==='org' && r.via!==null))
      && rows.some(r=>r.src==='org' && r.via===30),
      rows.map(r=>`${r.role}:${r.src}${r.via?'@'+r.via:''}`).join(' ')); }

{ // W4 到期自动失效：靠时点派生，不靠任何写回
  await db.exec(`INSERT INTO sys_org_grant(org_id,role_id,data_scope_id,effective_from,effective_to,granted_by,reason)
                 VALUES (30,5,100,'2026-01-01','2026-05-01','group_hr','临时支援：四月前')`);
  const inside  = await eff(72,'2026-04-30');
  const outside = await eff(72,'2026-05-01');
  rec('W4','组织授权到期即失效（区间右开，靠时点派生，不靠定时任务改状态）',
      inside.some(r=>r.role===5) && !outside.some(r=>r.role===5),
      `4/30=${inside.some(r=>r.role===5)} 5/1=${outside.some(r=>r.role===5)}`); }

{ // W5 撤销是显式事实，不是删行
  await db.exec(`UPDATE sys_org_grant SET revoked_at=clock_timestamp()
                 WHERE org_id=10 AND role_id=3`);
  const rows = await eff(70,'2026-03-01');
  rec('W5','撤销后立即失效，且撤销事实留在表里（删行会让"这里曾有过授权"消失）',
      !rows.some(r=>r.role===3),
      rows.map(r=>r.role).join(',')); }

{ // W6 组织停用：授权失效 + 影响面必须报得出来
  await db.exec(`UPDATE org_unit SET is_active=false WHERE id=30`);
  const rows = await eff(70,'2026-03-01');
  const imp = (await db.query(`SELECT * FROM fn_org_grant_impact(30)`)).rows[0];
  await db.exec(`UPDATE org_unit SET is_active=true WHERE id=30`);
  rec('W6','组织停用 → 其名下授权失效，且停用前能报出影响面（授权数与账号数）',
      !rows.some(r=>r.role===2) && Number(imp.grant_count) >= 1
      && Number(imp.user_count) >= 2 && (imp.role_ids||[]).length >= 1,
      `停用后角色=${rows.map(r=>r.role).join(',')||'无'} 影响授权=${imp.grant_count} 账号=${imp.user_count}`); }

{ // W7 行闸通电：组织授权真的改变了一次查询的结果
  await db.query(`SELECT app_begin_scope($1,$2,$3)`, [70, 'attendance_daily', '2026-03-05']);
  const orgs = (await db.query(
    `SELECT org_id FROM pg_temp.tmp_scope_org WHERE dim_code='cost_org' ORDER BY 1`)).rows
    .map(r=>Number(r.org_id));
  const hit = (await db.query(
    `SELECT count(*)::int n FROM attendance_daily_store a
      WHERE EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                     WHERE s.dim_code='cost_org' AND s.org_id = a.store_id)`)).rows[0].n;
  rec('W7','组织授权真的灌进了行闸（不只是登记一条记录）',
      orgs.includes(10) && hit >= 1,
      `cost_org=${JSON.stringify(orgs)} 可见考勤=${hit} 行`); }

{ // W8 同一角色既直接授又从组织继承
  //   判据不是"总共灌了几行"（那取决于这条角色配了几个维度），
  //   而是「**加一条直接授权，灌进去的行数不变**」——变多说明去重没生效，
  //   而虚高的分母会让人以为"这个人的范围很大"。
  await db.query(`SELECT app_begin_scope($1,$2,$3)`, [70,'attendance_daily','2026-03-05']);
  const before = (await db.query(
    `SELECT count(*)::int n FROM pg_temp.tmp_scope_org`)).rows[0].n;

  await db.exec(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,effective_from)
                 VALUES (70,70,2,200,'2026-01-01')`);
  const rows = await eff(70,'2026-03-01');
  const dual = rows.filter(r=>r.role===2);
  await db.query(`SELECT app_begin_scope($1,$2,$3)`, [70,'attendance_daily','2026-03-05']);
  const after = (await db.query(
    `SELECT count(*)::int n FROM pg_temp.tmp_scope_org`)).rows[0].n;

  rec('W8','同一角色两条来源都留着（解释得清），而灌入行数不变（分母不虚高）',
      dual.length===2 && after===before,
      `来源 ${dual.map(r=>r.src).join('+')} 灌入 ${before}→${after} 行`);
  await db.exec(`DELETE FROM sys_user_role WHERE id=70`); }

{ // W9 空白理由不行：一次给几十人开权限，"为什么"是唯一能复查的东西
  await expectErr(() => db.exec(`INSERT INTO sys_org_grant(org_id,role_id,data_scope_id,effective_from,granted_by,reason)
      VALUES (30,1,100,'2026-01-01','x','  ')`),
    'ck_sog_reason','W9','组织授权理由空白 → 拒（空格能通过 NOT NULL）'); }


// ===========================================================================
// Y 组 · 集团制度下发与门店覆盖（021）
// ===========================================================================
await db.exec(`
INSERT INTO policy_def(code,name,domain,value_type,allow_org_override,override_floor,unit) VALUES
  ('BREAK_DEDUCT','在岗休息是否从工时中扣除','ATTENDANCE','bool',   true, 'store',''),
  ('CLOSE_DAY',   '考勤封账日','ATTENDANCE','numeric', false,'group','日'),
  ('SHIFT_TOL',   '排班弹性（分钟）','ATTENDANCE','numeric', true, 'region','分');

INSERT INTO policy_value(policy_code,effective_from,value_num,value_text,published_by,reason) VALUES
  ('BREAK_DEDUCT','2026-01-01',1,NULL,'group_hr','集团统一：在岗休息扣除'),
  ('BREAK_DEDUCT','2026-07-01',0,NULL,'group_hr','集团改口径：7 月起不扣在岗休息'),
  ('CLOSE_DAY',   '2026-01-01',5,NULL,'group_hr','每月 5 日封账'),
  ('SHIFT_TOL',   '2026-01-01',30,NULL,'group_hr','区域可调，默认 30 分钟');

-- A店(10) 自行决定不扣在岗休息
INSERT INTO policy_override(org_id,policy_code,effective_from,value_num,reason,approved_by)
  VALUES (10,'BREAK_DEDUCT','2026-01-01',0,'A店为高档店，休息计入工时','area_hr_wang');
`);

const pol = async (code,org,on) => (await db.query(
  `SELECT value_num, value_text, source, via_org_id FROM fn_policy_effective($1,$2,$3::date)`,
  [code,org,on])).rows[0];

{ const g = await pol('BREAK_DEDUCT',11,'2026-03-01');
  rec('Y1','未覆盖的单位用集团值（source=group）',
      g && Number(g.value_num)===1 && g.source==='group', JSON.stringify(g)); }

{ const a = await pol('BREAK_DEDUCT',10,'2026-03-01');
  rec('Y2','A店自行覆盖 → 取门店值，来源可查（org@10）',
      a && Number(a.value_num)===0 && a.source==='org' && Number(a.via_org_id)===10,
      JSON.stringify(a)); }

{ const b = await pol('BREAK_DEDUCT',11,'2026-03-01');
  rec('Y3','A店的覆盖不影响 B店（覆盖只沿自己的祖先链生效，不横向传染）',
      Number(b.value_num)===1, `B店=${b.value_num}`); }

{ const b = await pol('BREAK_DEDUCT',11,'2026-08-01');
  const a = await pol('BREAK_DEDUCT',10,'2026-08-01');
  rec('Y4','集团 7 月改值：未覆盖的单位立即跟随，已覆盖的不动',
      Number(b.value_num)===0 && Number(a.value_num)===0 && b.source==='group' && a.source==='org',
      `B店=${b.value_num}(${b.source}) A店=${a.value_num}(${a.source})`); }

{ await db.exec(`UPDATE policy_override SET effective_to='2026-06-01'
                 WHERE org_id=10 AND policy_code='BREAK_DEDUCT'`);
  const after = await pol('BREAK_DEDUCT',10,'2026-07-01');
  rec('Y5','覆盖到期 → 自动回落集团值（靠时点派生，不靠定时任务）',
      after.source==='group', `${after.source}=${after.value_num}`);
  await db.exec(`UPDATE policy_override SET effective_to=NULL
                 WHERE org_id=10 AND policy_code='BREAK_DEDUCT'`); }

await expectErr(() => db.exec(`INSERT INTO policy_override(org_id,policy_code,effective_from,value_num,reason,approved_by)
    VALUES (11,'BREAK_DEDUCT','2026-02-01',1,'   ','x')`),
  'ck_po_reason','Y6','覆盖理由空白 → 拒（一次覆盖就是一条管理决定，理由不能是空格）');

{ // Y7 集团把某项改成"不许覆盖"→ 存量覆盖变成"存在但不生效"，必须能列出来
  const before = (await db.query(`SELECT * FROM fn_policy_orphan_overrides()`)).rows;
  await db.exec(`UPDATE policy_def SET allow_org_override=false, override_floor='group'
                 WHERE code='BREAK_DEDUCT'`);
  const after = (await db.query(`SELECT policy_code, org_id, why FROM fn_policy_orphan_overrides()`)).rows;
  const eff = await pol('BREAK_DEDUCT',10,'2026-03-01');
  await db.exec(`UPDATE policy_def SET allow_org_override=true, override_floor='store'
                 WHERE code='BREAK_DEDUCT'`);
  rec('Y7','集团改"不许覆盖"后，存量覆盖**存在但不生效**且被单列出来（否则开关一开旧值同时复活）',
      before.length===0 && after.length===1 && Number(after[0].org_id)===10
      && String(after[0].why).includes('不允许覆盖') && eff.source==='group',
      `改前 ${before.length} 条 / 改后 ${after.length} 条（${after[0]?.why}）`); }

{ // Y8 覆盖层级：floor='region' 时门店不能自己定
  await db.exec(`INSERT INTO policy_override(org_id,policy_code,effective_from,value_num,reason,approved_by)
                 VALUES (10,'SHIFT_TOL','2026-01-01',60,'门店自行放宽到 60 分钟','store_mgr')`);
  const store = await pol('SHIFT_TOL',10,'2026-03-01');
  await db.exec(`INSERT INTO policy_override(org_id,policy_code,effective_from,value_num,reason,approved_by)
                 VALUES (30,'SHIFT_TOL','2026-01-01',45,'区域统一放宽到 45 分钟','area_hr')`);
  const area = await pol('SHIFT_TOL',10,'2026-03-01');
  const orphan = (await db.query(`SELECT * FROM fn_policy_orphan_overrides()
                                   WHERE policy_code='SHIFT_TOL'`)).rows;
  rec('Y8','覆盖层级：floor=region 时门店覆盖不生效，区域覆盖生效，且门店那条被列为越权',
      store.source==='group' && area.source==='org' && Number(area.value_num)===45
      && orphan.length===1 && Number(orphan[0].org_id)===10,
      `门店=${store.source} 区域生效=${area.value_num} 越权 ${orphan.length} 条`); }

{ const imp = (await db.query(`SELECT * FROM fn_policy_impact('BREAK_DEDUCT','2026-08-01')`)).rows[0];
  rec('Y9','集团改值前能报出影响面：跟随 N 个 / 已覆盖 M 个（两个数都要）',
      Number(imp.total_orgs) > 0 && Number(imp.following) > 0 && Number(imp.overridden) > 0,
      `共 ${imp.total_orgs}，跟随 ${imp.following}，已覆盖 ${imp.overridden}`); }

{ // Y10 没有集团值 → 报错，不是返回 NULL 让下游按零算
  await db.exec(`INSERT INTO policy_def(code,name,domain,value_type) VALUES
                 ('NEW_ITEM','新增项未发布','PERM','numeric')`);
  let blocked=false, note='';
  try { await pol('NEW_ITEM',10,'2026-03-01'); note='返回了某值'; }
  catch(e){ blocked = String(e.message).includes('E_POLICY_NO_VALUE'); note=e.code; }
  rec('Y10','制度项没有集团值 → 有名字地失败（返回 NULL 会让下游按零算出一堆数）',
      blocked, note); }

{ // Y11 制度接到口径上：集团值决定新行的默认口径
  const basisB = (await db.query(`SELECT fn_att_default_basis(11,'2026-03-05'::date) b`)).rows[0].b;
  const basisA = (await db.query(`SELECT fn_att_default_basis(10,'2026-03-05'::date) b`)).rows[0].b;
  const basisB2 = (await db.query(`SELECT fn_att_default_basis(11,'2026-08-05'::date) b`)).rows[0].b;
  rec('Y11','制度决定口径：集团扣休息 → B店 allowance；A店覆盖不扣 → hourly；7 月起集团改值 → B店也 hourly',
      basisB==='allowance' && basisA==='hourly' && basisB2==='hourly',
      `B店3月=${basisB} A店=${basisA} B店8月=${basisB2}`); }

{ // Y12 已写入的行不因制度变更而改变 —— snap 列是事实，不是缓存
  const before = (await db.query(
    `SELECT snap_on_duty_break_basis b, work_hours FROM attendance_daily_store ORDER BY id LIMIT 1`)).rows[0];
  // 改制度要连 floor 一起改：ck_pd_floor_gate 不允许「不许覆盖 + floor=store」这种半状态
  await db.exec(`UPDATE policy_def SET allow_org_override=false, override_floor='group'
                 WHERE code='BREAK_DEDUCT'`);
  const after = (await db.query(
    `SELECT snap_on_duty_break_basis b, work_hours FROM attendance_daily_store ORDER BY id LIMIT 1`)).rows[0];
  await db.exec(`UPDATE policy_def SET allow_org_override=true, override_floor='store'
                 WHERE code='BREAK_DEDUCT'`);
  rec('Y12','制度变更**不改变已写入的行**（口径是快照事实，不是读取时现算的缓存）',
      before.b === after.b && Number(before.work_hours) === Number(after.work_hours),
      `${before.b}/${before.work_hours}h 变更后 ${after.b}/${after.work_hours}h`); }


// ===========================================================================
// Z 组 · 编制与人力预算（022）
// ===========================================================================
await db.exec(`
INSERT INTO org_unit(id,parent_id,name,path) VALUES
  (40,1,'西南区','001.040'),
  (41,40,'C店','001.040.041'),(42,40,'D店','001.040.042'),(43,40,'E店','001.040.043');
`);
const P = '2026-02';
await db.query(`SELECT fn_hc_set(40,$1,10,'group_hr','集团批给西南区 10 个编')`,[P]);
await db.query(`SELECT fn_hc_set(41,$1,6,'area_hr','C店 6 个')`,[P]);
await db.query(`SELECT fn_hc_set(42,$1,3,'area_hr','D店 3 个')`,[P]);

await expectErr(() => db.query(`SELECT fn_hc_set(42,$1,5,'area_hr','D店要 5 个')`,[P]),
  'E_HC_OVER_ALLOCATED','Z1','子项之和超过父项额度 → 拒（下分是分配，不是复制）');

{ const av = (await db.query(`SELECT fn_hc_available(40,$1) v`,[P])).rows[0].v;
  const al = (await db.query(`SELECT fn_hc_allocated(40,$1) v`,[P])).rows[0].v;
  rec('Z2','父项剩余可下分 = 10 − 已下分 9 = 1（三层账面自洽）',
      Number(av)===1 && Number(al)===9, `已下分=${al} 剩余=${av}`); }

await db.exec(`
INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from) VALUES
  (80,'cost_org',41,'2026-02-01'),(81,'cost_org',41,'2026-02-01');
`);
{ const u41 = (await db.query(`SELECT fn_hc_used(41,$1) v`,[P])).rows[0].v;
  const u40 = (await db.query(`SELECT fn_hc_used(40,$1) v`,[P])).rows[0].v;
  rec('Z3','占编由归属派生：C店 2 人，西南区 2 人（子树汇总，不落列）',
      Number(u41)===2 && Number(u40)===2, `C店=${u41} 西南区=${u40}`); }

{ const col = (await db.query(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name='headcount_budget' AND column_name IN ('used','occupancy')`)).rows[0].n;
  rec('Z4','额度表里没有 used 列（存了它就会被入职/离职/调动三条路径各改一次，必然漂）',
      col===0, `命中 ${col} 列`); }

{ await db.query(`SELECT fn_hc_set(41,$1,1,'area_hr','C店缩编到 1 个')`,[P]);
  const q = (await db.query(`SELECT fn_hc_quota(41,$1) v`,[P])).rows[0].v;
  const hist = (await db.query(
    `SELECT version, quota FROM headcount_budget WHERE org_id=41 AND period=$1 ORDER BY version`,[P])).rows;
  rec('Z5','调编走追加版本：现额度 1，历史版本仍在（上个月额度是多少查得出来）',
      Number(q)===1 && hist.length===2 && Number(hist[0].quota)===6,
      hist.map(h=>`v${h.version}=${h.quota}`).join(' ')); }

{ const over = (await db.query(`SELECT org_id, quota, used, over_by FROM fn_hc_over($1)`,[P])).rows;
  rec('Z6','超编清单：C店 1 个编占了 2 人（超 1），且必须能单独列出来',
      over.length===1 && Number(over[0].org_id)===41 && Number(over[0].over_by)===1,
      JSON.stringify(over)); }

await expectErr(() => db.exec(`UPDATE headcount_budget SET quota=99 WHERE org_id=41 AND period='2026-02'`),
  'E_HC_APPEND_ONLY','Z7','就地改额度 → 拒（改了它，上个月超编的事实会随着额度调高而消失）');

await expectErr(() => db.exec(`DELETE FROM headcount_budget WHERE org_id=41 AND period='2026-02'`),
  'E_HC_APPEND_ONLY','Z8','删额度版本 → 拒');

{ // Z9 没编却有在职：忘了下编，永远不超编，而报表一片绿
  await db.exec(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
                 VALUES (82,'cost_org',43,'2026-02-01')`);
  const rows = (await db.query(`SELECT org_id, used FROM fn_hc_uncovered($1)`,[P])).rows;
  const ids = rows.map(r=>Number(r.org_id));
  // 这一组跑下来才发现：集团(1)/区域(30,31)/门店(10) 都有在职却都没配额——
  // 真实系统里"只有少数几个组织配了编"是常态，所以这条清单通常不止一行。
  rec('Z9','没配额度的组织被单独列出（否则"忘了下编"与"编制充足"同形）',
      ids.includes(43) && rows.length >= 1,
      `命中 ${rows.length} 个组织：${ids.join(',')}`); }

{ // Z10 超编处置：require_approval 时允许，但必须留痕
  //    此刻 C店 额度 1、已占 2 —— 再插一个人就是真超编。
  let ok=false, note='';
  try {
    await db.exec(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
                   VALUES (84,'cost_org',41,'2026-02-01')`);
    ok=true; note='超编被放行';
  } catch(e){ note=e.code+' '+String(e.message).slice(0,40); }
  const log = (await db.query(
    `SELECT employee_id, quota, used_at_insert, basis FROM headcount_over_log
      WHERE org_id=41 AND period=$1`,[P])).rows;
  rec('Z10','超编走审批通道时放行但留痕（谁、依据什么、插入那一刻的占用）',
      ok && log.length===1 && Number(log[0].employee_id)===84 && Number(log[0].used_at_insert)===2,
      `${note} 留痕=${JSON.stringify(log)}`); }

{ // Z11 把口径改成 reject 之后，同样的写入被拒
  await db.exec(`INSERT INTO policy_override(org_id,policy_code,effective_from,value_text,reason,approved_by)
                 VALUES (41,'HEADCOUNT_OVER','2026-01-01','reject','C店缩编期，一律不批超编','area_hr')`);
  let blocked=false, note='';
  try {
    await db.exec(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
                   VALUES (83,'cost_org',41,'2026-02-01')`);
    note='reject 模式下仍然插入成功';
  } catch(e){ blocked = String(e.message).includes('E_HC_FULL'); note=e.code; }
  rec('Z11','口径改成 reject 后，同样的超编写入被拒（口径是配置项，不是写死的策略）',
      blocked, note);
  await db.exec(`DELETE FROM policy_override WHERE org_id=41 AND policy_code='HEADCOUNT_OVER'`); }

{ // Z12 集团池模式：子组织不应有自己的额度
  await db.exec(`INSERT INTO policy_value(policy_code,effective_from,value_text,published_by,reason)
                 VALUES ('HEADCOUNT_MODE','2026-03-01','group_pool','group_hr','三月起集团一个池子')`);
  // 池模式下额度只在集团这一层
  await db.query(`SELECT fn_hc_set(1,'2026-03',500,'group_hr','集团总池 500 个')`);
  let blocked=false, note='';
  try { await db.query(`SELECT fn_hc_set(41,'2026-03',6,'area_hr','C店想要 6 个')`); note='池模式下仍设了下级额度'; }
  catch(e){ blocked = String(e.message).includes('E_HC_NOT_CASCADED'); note=e.code; }
  const gq = (await db.query(`SELECT fn_hc_quota(1,'2026-03') v`)).rows[0].v;
  rec('Z12','group_pool 模式下额度只在集团层，给下级下编 → 拒（两套口径同时跑，双方互不知情）',
      blocked && Number(gq)===500, `集团=${gq} 下级=${note}`); }

{ // Z13 「可下分」与「可招」是两个数，混用会让门店以为还有 12 个编
  const h40 = (await db.query(`SELECT fn_hc_hireable(40,$1) v`,[P])).rows[0].v;
  const h41 = (await db.query(`SELECT fn_hc_hireable(41,$1) v`,[P])).rows[0].v;
  const a41 = (await db.query(`SELECT fn_hc_available(41,$1) v`,[P])).rows[0].v;
  // ★ 178 之后父节点的口径变了：西南区 10 − 已下分 4（C店 1 + D店 3）
  //   − **直属**已占 0（没人直接挂在区域上）= 6。
  //   改之前是 10 − 4 − 子树已占 4 = 2 —— 那个 2 是**错的**：子树那 4 个人
  //   已经在"已下分 4"里被扣过一次了，再扣一次就是双重扣减。
  // ★ 两个数仍然不是一回事，只是要在**叶子**上才看得出来：
  //   C店 可下分 1（1 − 没有下级），但可招 −2（1 − 0 − 直属已占 3，超编）。
  rec('Z13','「可下分」与「可招」是两个数：C店可下分 1，但可招 −2（已超编）；'
    + '父节点按**直属**占编算（10 − 已下分 4 − 直属 0 = 6，不是拿子树 4 再扣一遍）',
      Number(h40)===6 && Number(h41)===-2 && Number(a41)===1,
      `西南区可招=${h40} C店可下分=${a41} C店可招=${h41}`); }

{ // Z14 三层「可招」都非负，且缺岗/满编两个方向都对（178）
  // ★ 为什么这条必须在"编制补齐"的树上验：父节点为负正是这条缺陷的形态，
  //   而它只在**编已经补齐**时才会暴露成"负数"（补不齐时所有人都是负的，
  //   看起来像"编制不够"）。
  // 用独立期别 2026-01 + 独立组织 47/48/49：不与 P（2026-02）那套额度、
  // 也不与后面几组（2026-03 池模式 / 2026-04）互相污染。
  // ★ 归属只覆盖 1 月（valid_to 设了），否则这 17 个人会一路算进 2026-02
  //   的占编里，把 Z6 的"超编清单只有 1 行"顶掉。
  const HP = '2026-01';
  await db.query(`INSERT INTO org_unit(id,parent_id,name,path) VALUES
                    (47,1,'华南区','001.047'),
                    (48,47,'F店','001.047.048'),
                    (49,47,'G店','001.047.049')`);
  await db.query(`SELECT fn_hc_set(1,$1,20,'group_hr','集团批 20 个')`,[HP]);
  await db.query(`SELECT fn_hc_set(47,$1,20,'area_hr','华南区 20 个')`,[HP]);
  await db.query(`SELECT fn_hc_set(48,$1,8,'area_hr','F店 8 个')`,[HP]);
  await db.query(`SELECT fn_hc_set(49,$1,12,'area_hr','G店 12 个')`,[HP]);
  // F店 5 人（缺 3）、G店 12 人（满编）
  const body = [...Array.from({length: 5}, (_, i) => `(${8701 + i},'cost_org',48,'2026-01-01','2026-01-31')`),
                ...Array.from({length: 12}, (_, i) => `(${8711 + i},'cost_org',49,'2026-01-01','2026-01-31')`)];
  await db.exec(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from,valid_to)
                 VALUES ${body.join(',')}`);
  const hc = async (org) => Number((await db.query(
    `SELECT fn_hc_hireable($1,$2) v`, [org, HP])).rows[0].v);
  const [g, area, f, gg] = [await hc(1), await hc(47), await hc(48), await hc(49)];
  rec('Z14','三层「可招」都 ≥ 0：集团 20−20−0=0、华南区 20−20−0=0、'
    + 'F店 8−0−5=3（缺岗 3）、G店 12−0−12=0（满编）；'
    + '★ 缺岗为正、满编为 0 —— 这个数回到"还能招几个"的意思',
      g === 0 && area === 0 && f === 3 && gg === 0 && g >= 0 && area >= 0 && f >= 0 && gg >= 0,
      `集团=${g} 区域=${area} F店=${f}（期望 3） G店=${gg}（期望 0）`); }


// 183 的三条断言共用这个期别：它晚于 Z14 定的 2026-01，且演示/夹具里没人给它定过编。
const HQ2 = '2026-05';

{ // Z15 编制沿用：本期没定编 → 取最近一个更早的期，且**必须能看出是沿用**（183）
  // 复用 Z14 的三个组织与 2026-01 的额度，查一个从没定过编的 2026-05（见上方 HQ2）。
  const eff = async (org) => (await db.query(
    `SELECT * FROM fn_hc_quota_effective($1,$2)`, [org, HQ2])).rows[0];
  const [g, area, f] = [await eff(1), await eff(47), await eff(48)];
  const qf = (await db.query(`SELECT fn_hc_quota(48,$1)::text q`, [HQ2])).rows[0].q;
  // ★ 三层沿用的出处**不一样**，这正好是这条最有价值的地方：
  //   集团在 2026-03 被别的夹具定过 500，所以沿用 2026-03；华南/F店 最近一次是 2026-01。
  //   若实现写成"取最早一期"或"取全局最近"，这三个数会同时错 —— 所以分别断言。
  rec('Z15','编制沿用取的是**最近一个更早的期**，不是最早一期：集团 carried_from=2026-03（500），'
    + '华南与 F店 carried_from=2026-01（20 / 8）；fn_hc_quota 与 effective.quota 一致。'
    + '★ 只给数不给 status，「这期没定编」就再也看不出来',
      g.status === 'carried' && g.carried_from === '2026-03' && Number(g.quota) === 500
      && area.status === 'carried' && area.carried_from === '2026-01' && Number(area.quota) === 20
      && f.status === 'carried' && f.carried_from === '2026-01'
      && Number(f.quota) === 8 && Number(qf) === 8,
      `集团=${g.status}/${g.carried_from}/${g.quota} 华南=${area.status}/${area.carried_from}/${area.quota} `
      + `F店=${f.status}/${f.carried_from}/${f.quota} fn_hc_quota(48)=${qf}`); }

{ // Z16 从来没定过编 → unset 且额度 NULL（**不是 0，也不能被沿用成某个数**）（183）
  // 新建 50 号店（华南区下），一期编制都不给它。
  await db.query(`INSERT INTO org_unit(id,parent_id,name,path) VALUES (50,47,'H店','001.047.050')`);
  const e2 = (await db.query(`SELECT * FROM fn_hc_quota_effective(50,$1)`, [HQ2])).rows[0];
  const q2 = (await db.query(`SELECT fn_hc_quota(50,$1)::text q`, [HQ2])).rows[0].q;
  const hv = (await db.query(`SELECT fn_hc_hireable(50,$1)::text h`, [HQ2])).rows[0].h;
  rec('Z16','从没定过编的店：status=unset、quota 与 fn_hc_quota 都是 NULL（不是 0），'
    + '可招按 0 额度算（0 是"定了但一个编都不给"，NULL 是"还没定"，两者处置不同）',
      e2.status === 'unset' && e2.quota === null && q2 === null && Number(hv) === 0,
      `status=${e2.status} quota=${e2.quota} fn_hc_quota=${q2} hireable=${hv}`); }

{ // Z17 沿用不能把"已下分/可下分"算歪：父节点沿用后，三个数仍自洽（183）
  // 集团 20 = 已下分 20（华南区沿用 20）→ 可下分 0；华南区 20 → 已下分 20（F8+G12）= 0。
  const av = async (org) => Number((await db.query(
    `SELECT fn_hc_available($1,$2) v`, [org, HQ2])).rows[0].v);
  const al = async (org) => Number((await db.query(
    `SELECT fn_hc_allocated($1,$2) v`, [org, HQ2])).rows[0].v);
  const [a1, l1, a47, l47] = [await av(1), await al(1), await av(47), await al(47)];
  const q1 = Number((await db.query(`SELECT fn_hc_quota(1,$1) v`, [HQ2])).rows[0].v);
  const q47 = Number((await db.query(`SELECT fn_hc_quota(47,$1) v`, [HQ2])).rows[0].v);
  rec('Z17','沿用之后三个数仍自洽：可下分 == 编 − 已分（集团 500−30=470、华南 20−20=0）。'
    + '★ "一处实现、下游跟着走"的验收点：若谁把 fn_hc_quota 改回精确匹配，'
    + '编会变 NULL、可下分变负数，而页面只是"数变了"，不会报错',
      a1 === q1 - l1 && a1 === 470 && l1 === 30
      && a47 === q47 - l47 && a47 === 0 && l47 === 20,
      `集团 编=${q1} 可下分=${a1} 已分=${l1}；华南区 编=${q47} 可下分=${a47} 已分=${l47}`); }

// ===========================================================================
// AA 组 · 报表层（023）：唯一实现 / 口径显式 / 三路径交叉核对
// ===========================================================================
// 补一个门店组织：Q 组的考勤行挂在 store 60 上，而 60 原先不在组织树里。
// 这正是"明细指向一个不在树里的组织"——它在单条路径上看不出来，
// 只表现为"两个报表对不上"，所以必须先补进树里。
await db.exec(`INSERT INTO org_unit(id,parent_id,name,path) VALUES (60,1,'E店','001.060')`);

{ // AA1 三路径必须相等（工时）
  const rows = (await db.query(`SELECT * FROM fn_rpt_crosscheck('2026-03')`)).rows;
  const hours = rows.find(r=>r.metric==='WORK_HOURS');
  rec('AA1','工时三路径同值：子树一次算 = 叶子分别算再相加 = 明细直接求和',
      !!hours && hours.ok === true,
      `A=${hours?.path_a} B=${hours?.path_b} C=${hours?.path_c}`); }

{ // AA2 人数三路径也必须相等（跨组织口径）
  const rows = (await db.query(`SELECT * FROM fn_rpt_crosscheck('2026-02')`)).rows;
  const hc = rows.find(r=>r.metric==='HC_END');
  rec('AA2','人数三路径同值（含"按组织分组不漏行、不重复计数"）',
      !!hc && hc.ok === true, `A=${hc?.path_a} B=${hc?.path_b} C=${hc?.path_c}`); }

{ // AA3 人数必须声明基准，没有默认值
  let blocked=false, note='';
  try { await db.query(`SELECT fn_rpt_headcount(40,'2026-02',NULL)`); note='NULL 被当成某个默认基准'; }
  catch(e){ blocked = String(e.message).includes('E_RPT_BASIS_REQUIRED'); note=e.code; }
  rec('AA3','人数不声明基准 → 报错（"期初/期末/日均"三个都是合法答案，混用才是错的）',
      blocked, note); }

{ // AA4 三个基准在有人月中入职时确实不同 —— 证明它们是三个不同的量
  await db.exec(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
                 VALUES (90,'cost_org',42,'2026-02-15')`);
  const b = Number((await db.query(`SELECT fn_rpt_headcount(40,'2026-02','begin') v`)).rows[0].v);
  const e = Number((await db.query(`SELECT fn_rpt_headcount(40,'2026-02','end') v`)).rows[0].v);
  const a = Number((await db.query(`SELECT fn_rpt_headcount(40,'2026-02','avg_daily') v`)).rows[0].v);
  rec('AA4','月中入职一人：期初 / 日均 / 期末 三个数互不相同（不是同一个量换了个名字）',
      e === b + 1 && a > b && a < e,
      `期初=${b} 日均=${a} 期末=${e}`); }

{ // AA5 面板里每个指标都必须登记过口径
  const un = (await db.query(`SELECT metric FROM fn_rpt_unregistered('2026-02')`)).rows;
  rec('AA5','面板里没有未登记的指标（未登记＝没人写过它的口径，却和别人同一个字体）',
      un.length === 0, `未登记 ${un.length} 个${un.length ? '：' + un.map(x=>x.metric).join(',') : ''}`); }

{ // AA6 每个指标的口径三要素齐全
  const bad = (await db.query(
    `SELECT code FROM report_metric
      WHERE length(btrim(denominator)) < 1 OR length(btrim(numerator)) < 4`)).rows;
  rec('AA6','指标口径三要素齐全（分子/分母/基准；"不需要分母"也要写 "—"）',
      bad.length === 0, bad.length ? bad.map(x=>x.code).join(',') : '0 个缺口径'); }

{ // AA7 空期间：指标仍出行，值为 0；省略行会让"0"与"没有这个组织"同形
  const rows = (await db.query(`SELECT metric, value FROM fn_rpt_panel(60,'2026-01')`)).rows;
  const hours = rows.find(r=>r.metric==='WORK_HOURS');
  rec('AA7','空期间仍出 7 行且值为 0（省略行会让"这个月是 0"与"这里没有这个组织"同形）',
      rows.length === 7 && Number(hours.value) === 0,
      `行数=${rows.length} 工时=${hours.value}`); }

{ // AA8 可复现：报表函数里不许出现 current_date / now()
  const bad = (await db.query(
    `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'fn_rpt\\_%'
        AND (p.prosrc ~ 'current_date' OR p.prosrc ~ '\\mnow\\(')`)).rows;
  rec('AA8','报表函数不含 current_date / now()（含了的话"上个月的报表"永远复现不出来）',
      bad.length === 0, bad.length ? bad.map(x=>x.proname).join(',') : '0 处时钟');
  }

{ // AA9 同一总量在两条业务路径上也要一致：工时（考勤） vs 工资条上的应发人数
  const a = Number((await db.query(`SELECT fn_rpt_headcount(1,'2026-02','end') v`)).rows[0].v);
  const b = Number((await db.query(`SELECT count(DISTINCT employee_id)::numeric v
    FROM employee_org_assignment WHERE dim_code='cost_org'
     AND daterange(valid_from, valid_to, '[]') @> '2026-02-28'::date`)).rows[0].v);
  rec('AA9','根组织口径与全表明细口径一致（子树前缀匹配没有漏掉新挂的组织）',
      a === b, `树汇总=${a} 明细=${b}`); }


// ===========================================================================
// AB 组 · 看板层（024）：先异常 / 指标同源 / 分组不漏
// ===========================================================================
{ // AB1 异常清单：期望集合硬编码，0 也要出行
  const rows = (await db.query(`SELECT kind, n FROM fn_dash_exceptions('2026-02')`)).rows;
  const kinds = rows.map(r=>r.kind).sort();
  const expect = ['ATT_UNCLOSED','CHK_NEVER_RUN','CONFIRM_MISSING','HC_OVER','HC_UNCOVERED',
                  'LEAVE_INCONSIST','PAYSLIP_INCONSIST','POLICY_ORPHAN','SETTLE_DISPUTED'];
  rec('AB1','异常清单 9 类全部出行（含 0）——只列非零项的仪表盘，"全部正常"与"没检查"同形',
      JSON.stringify(kinds)===JSON.stringify(expect), `返回 ${rows.length} 类`); }

{ // AB2 每类的数必须与明细一致，不能是"另一处算出来的"
  const ex = (await db.query(`SELECT n FROM fn_dash_exceptions('2026-02') WHERE kind='HC_OVER'`)).rows[0];
  const det = (await db.query(`SELECT count(*)::int n FROM fn_hc_over('2026-02')`)).rows[0];
  const ex2 = (await db.query(`SELECT n FROM fn_dash_exceptions('2026-02') WHERE kind='HC_UNCOVERED'`)).rows[0];
  const det2 = (await db.query(`SELECT count(*)::int n FROM fn_hc_uncovered('2026-02')`)).rows[0];
  rec('AB2','看板的数与明细行数一致（看板不自己再算一遍）',
      Number(ex.n)===Number(det.n) && Number(ex2.n)===Number(det2.n) && Number(det.n)>0,
      `超编 ${ex.n}/${det.n} 未配编 ${ex2.n}/${det2.n}`); }

{ // AB3 工时口径同源：月报 == 逐日相加
  const m = Number((await db.query(`SELECT fn_rpt_hours(30,'2026-03') v`)).rows[0].v);
  const d = Number((await db.query(
    `SELECT COALESCE(sum(fn_rpt_hours_between(30, g::date, g::date)),0) v
       FROM generate_series('2026-03-01'::date,'2026-03-31'::date, interval '1 day') g`)).rows[0].v);
  rec('AB3','日报逐日相加 == 月报（同一个月报与日报共用一份实现，不是两处各算）',
      m === d && m > 0, `月报=${m} 逐日合计=${d}`); }

{ // AB4 集团看板：各区之和 == 集团总（子树分区不漏不重）
  // ★ 这一条测的是**分区**，不是权限（权限在 DS 组）。056 之后 fn_dash_group
  //   会按行闸出行，所以先把"整棵树可见"直接灌进临时表 ——
  //   否则这条断言的结论取决于前面哪一组的临时表还留着，而那种依赖
  //   在换一台机器、换一个执行顺序时就会翻，且翻的时候看起来像"分区算错了"。
  await db.exec(`TRUNCATE pg_temp.tmp_scope_org; TRUNCATE pg_temp.tmp_scope_deny;`);
  await db.query(`INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
                  SELECT 'cost_org', id FROM public.org_unit WHERE is_active`);
  const rows = (await db.query(`SELECT * FROM fn_dash_group('2026-02')`)).rows;
  const sumHc = rows.reduce((a,x)=>a+Number(x.headcount),0);
  const rootHc = Number((await db.query(`SELECT fn_rpt_headcount(1,'2026-02','end') v`)).rows[0].v);
  const sumHours = rows.reduce((a,x)=>a+Number(x.hours),0);
  const rootHours = Number((await db.query(`SELECT fn_rpt_hours(1,'2026-02') v`)).rows[0].v);
  rec('AB4','看板各区之和 == 集团总（人数与工时两条都要对）',
      sumHc === rootHc && sumHours === rootHours && rows.length >= 2,
      `${rows.length} 个区域，人数 ${sumHc}/${rootHc}，工时 ${sumHours}/${rootHours}`); }

{ // AB5 门店日报的工时与报表同一实现
  const daily = (await db.query(`SELECT value FROM fn_dash_store_daily(10,'2026-03-01') WHERE metric='WORK_HOURS'`)).rows[0];
  const direct = (await db.query(`SELECT fn_rpt_hours_between(10,'2026-03-01','2026-03-01') v`)).rows[0];
  rec('AB5','门店日报的工时 = 报表同一函数同一天的值（同源，不是巧合相等）',
      Number(daily.value) === Number(direct.v),
      `日报=${daily.value} 报表=${direct.v}`); }

{ // AB6 缺确认单是缺陷，不是"未排班"——两者在日报上必须不同形
  // 用 03-04：H 组给 1/2/3 号段建了确认单，4 号段**故意没建**——那正是"缺陷"样本
  const rows = (await db.query(`SELECT metric, value, anomaly FROM fn_dash_store_daily(10,'2026-03-04')`)).rows;
  const missing = rows.find(r=>r.metric==='SEG_MISSING');
  const okDay = (await db.query(`SELECT metric, value FROM fn_dash_store_daily(10,'2026-03-01')`)).rows
    .find(r=>r.metric==='SEG_MISSING');
  rec('AB6','门店日报里「缺确认单的段」单独成行（有单的日子是 0，缺单的日子是缺陷）',
      !!missing && Number(missing.value) > 0 && missing.anomaly === true
      && !!okDay && Number(okDay.value) === 0,
      `03-04 缺单=${missing?.value}(anomaly=${missing?.anomaly}) 03-01 缺单=${okDay?.value}`); }

{ // AB7 汇总数 = 非零类数（"有几类真的有问题"）
  const ex = (await db.query(`SELECT * FROM fn_dash_exceptions('2026-02')`)).rows;
  const ac = Number((await db.query(`SELECT fn_dash_alert_count('2026-02') v`)).rows[0].v);
  rec('AB7','告警类数 = 异常清单里 n>0 的类数（不是把 9 类都算成告警）',
      ac === ex.filter(x=>Number(x.n)>0).length && ac > 0,
      `告警 ${ac} 类 / 共 9 类`); }


// ===========================================================================
// AC 组 · 招聘（025）：需求 → offer → 入职
// ===========================================================================
// D店(42) 额度 3、已入职 1（员工 90），所以还能发 2 个 offer
const ON = '2026-04-05';
{ const can = Number((await db.query(`SELECT fn_hc_can_offer(42,$1::date) v`,[ON])).rows[0].v);
  rec('AC0','还能发 offer = 额度 3 − 已下分 0 − 已入职 1 − 已发 0 = 2',
      can === 2, `can_offer=${can}`); }

await expectErr(() => db.exec(`INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
    VALUES (42,'店员',3,'2026-04-01','旺季补人','store_mgr')`),
  'E_RQ_OVER_HEADCOUNT','AC1','开 3 个名额但只能发 2 个 → 拒（名额不得超过还能发）');

const rq = Number((await db.exec(`INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
    VALUES (42,'店员',2,'2026-04-01','旺季补人','store_mgr') RETURNING id`)).rows?.[0]?.id
  ?? (await db.query(`SELECT id FROM requisition WHERE org_id=42 ORDER BY id DESC LIMIT 1`)).rows[0].id);
{ rec('AC1b','名额 2 == 还能发 2 → 通过', !!rq, `需求 #${rq}`); }

const o1 = Number((await db.query(
  `SELECT fn_offer_issue($1,'CAND-A','候选人甲','店员',7000,'2026-04-30'::date,$2::date,'hr','首批发 offer') id`,
  [rq, ON])).rows[0].id);
const o2 = Number((await db.query(
  `SELECT fn_offer_issue($1,'CAND-B','候选人乙','店员',7000,'2026-04-20'::date,$2::date,'hr','首批发 offer') id`,
  [rq, ON])).rows[0].id);

await expectErr(() => db.query(
  `SELECT fn_offer_issue($1,'CAND-C','候选人丙','店员',7000,'2026-04-30'::date,$2::date,'hr','再补一个')`,
  [rq, ON]),
  'E_OFFER_OVER_RQ','AC2','第三个 offer 超过需求名额 2 → 拒');

{ const off = Number((await db.query(`SELECT fn_hc_offered(42,$1::date) v`,[ON])).rows[0].v);
  const can = Number((await db.query(`SELECT fn_hc_can_offer(42,$1::date) v`,[ON])).rows[0].v);
  rec('AC3','两个有效 offer 计入占用：offered=2、还能发=0（不是等入职才算）',
      off === 2 && can === 0, `offered=${off} can_offer=${can}`); }

{ // AC4 过期靠时点派生，不改状态、不跑定时任务
  const at5  = Number((await db.query(`SELECT fn_hc_offered(42,'2026-04-05'::date) v`)).rows[0].v);
  const at25 = Number((await db.query(`SELECT fn_hc_offered(42,'2026-04-25'::date) v`)).rows[0].v);
  const st   = (await db.query(`SELECT status FROM offer WHERE id=$1`,[o2])).rows[0].status;
  rec('AC4','offer 过期自动释放（4/5 是 2 个，4/25 只剩 1 个），而状态栏仍是 pending',
      at5 === 2 && at25 === 1 && st === 'pending',
      `4/5=${at5} 4/25=${at25} 状态=${st}`); }

{ // AC5 同一候选人两个有效 offer —— 用一张新的需求，否则先撞名额检查
  await db.exec(`
    INSERT INTO org_unit(id,parent_id,name,path) VALUES (44,40,'F店','001.040.044');
    INSERT INTO headcount_budget(org_id,period,version,quota,set_by,reason)
      VALUES (44,'2026-04',1,5,'area_hr','F店 5 个');
    INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
      VALUES (44,'店员',5,'2026-04-01','新店筹备','area_hr');`);
  const rq2 = Number((await db.query(
    `SELECT id FROM requisition WHERE org_id=44 ORDER BY id DESC LIMIT 1`)).rows[0].id);
  await db.query(`SELECT fn_offer_issue($1,'CAND-X','候选人某','店员',7000,'2026-06-30'::date,$2::date,'hr','首批发 offer')`,
    [rq2, ON]);
  await expectErr(() => db.query(
    `SELECT fn_offer_issue($1,'CAND-X','候选人某','店员',7000,'2026-06-30'::date,$2::date,'hr','重复发了一次 offer')`,
    [rq2, ON]),
    'uk_offer_live_candidate','AC5','同一候选人不得同时持有两个有效 offer（用姓名判断不出是不是同一个人）'); }

{ // AC6 改条款 = 追加版本
  await db.query(`SELECT fn_offer_revise($1,'高级店员',7500,'2026-05-15'::date,'hr','候选人要求调薪')`,[o1]);
  const vs = (await db.query(`SELECT version, monthly_amount FROM offer_version
                               WHERE offer_id=$1 ORDER BY version`,[o1])).rows;
  rec('AC6','改薪资走追加版本：v1=7000 仍在，v2=7500 生效（两份承诺都能查到）',
      vs.length === 2 && Number(vs[0].monthly_amount) === 7000
      && Number(vs[1].monthly_amount) === 7500,
      vs.map(v=>`v${v.version}=${v.monthly_amount}`).join(' ')); }

await expectErr(() => db.exec(`UPDATE offer_version SET monthly_amount=1 WHERE offer_id=${o1}`),
  'E_OFFER_APPEND_ONLY','AC7','改 offer 版本行 → 拒（纸上那份不能悄悄变）');

{ // AC8 过期入职
  await db.exec(`INSERT INTO person(id,full_name) VALUES (95,'候选人乙'),(96,'候选人甲')`);
  let blocked=false, note='';
  try { await db.query(`SELECT fn_offer_onboard($1,95,'2026-04-25'::date,1,'hr')`,[o2]); note='过期 offer 也能入职'; }
  catch(e){ blocked = String(e.message).includes('E_OFFER_EXPIRED'); note=e.code; }
  rec('AC8','用过期 offer 入职 → 拒（有效期是承诺的一部分）', blocked, note); }

{ // AC9 入职：三个字段一字不差地落下去
  const emp = Number((await db.query(
    `SELECT fn_offer_onboard($1,96,'2026-04-10'::date,1,'hr') id`,[o1])).rows[0].id);
  const sal = (await db.query(
    `SELECT monthly_amount FROM salary_standard WHERE employment_id=$1`,[emp])).rows[0];
  const asg = (await db.query(
    `SELECT org_id FROM employee_org_assignment
      WHERE employee_id=96 AND dim_code='cost_org'`)).rows[0];
  const st  = (await db.query(`SELECT status, onboard_person FROM offer WHERE id=$1`,[o1])).rows[0];
  rec('AC9','入职按 offer 最后版本落三样：任职 / 成本组织 42 / 月薪 7500（承诺的三个面）',
      Number(sal?.monthly_amount) === 7500 && Number(asg?.org_id) === 42
      && st.status === 'onboarded' && Number(st.onboard_person) === 96,
      `薪=${sal?.monthly_amount} 组织=${asg?.org_id} 状态=${st.status}`); }

await expectErr(() => db.exec(`UPDATE offer SET status='pending', onboard_person=NULL WHERE id=${o1}`),
  'E_OFFER_ONBOARDED','AC10','已入职 offer 状态回退 → 拒（回退＝这个编可以再招一次）');

{ // AC11 入职占用落进 headcount：used 从 1 变 2
  const used = Number((await db.query(`SELECT fn_hc_used(42,'2026-04') v`)).rows[0].v);
  rec('AC11','入职后占编 +1（编制侧的 used 与招聘侧的 offer 是同一个池子的两个通道）',
      used === 2, `D店 2026-04 占编=${used}`);
  }

{ // AC12 需求只能挂叶子组织
  let blocked=false, note='';
  try {
    await db.exec(`INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
                   VALUES (40,'区域专员',1,'2026-04-01','区域直属','area_hr')`);
    note='区域也能开需求';
  } catch(e){ blocked = String(e.message).includes('E_RQ_NOT_LEAF'); note=e.code; }
  rec('AC12','需求挂在有下级的组织上 → 拒（给区域发 offer，"占哪个门店的编"答不出来）',
      blocked, note); }


// ===========================================================================
// AD 组 · 绩效（026）：封存才进算薪 / 系数固化 / 未考核显式
// ===========================================================================
// 先把 2026-03 的考勤封账：算薪有两道门（考勤封账、绩效封存），
// 顺序上考勤在前——没封账的考勤先用不上"绩效未封存"这条判据。
await db.query(`SELECT fn_att_close(10,'2026-03','hr_head')`);

await db.exec(`
INSERT INTO perf_scheme(id,version,name,effective_from) VALUES (1,1,'2026 版绩效方案','2026-01-01');
INSERT INTO perf_grade(scheme_id,grade,min_score,max_score,factor,target_pct) VALUES
  (1,'A',90,100,1.5000,20),(1,'B',75,89.99,1.0000,70),(1,'C',0,74.99,0.5000,10);

-- ★ 143 起，封账序列不许回头改：2026-03/04/05 都已经封账，再在这几期上算薪
--   会让已封账的下游累计失真，库会直接拒。所以绩效这条链的**发薪期挪到 2026-08**
--   （考核期仍是一季度，钱在 8 月发 —— 真实里"绩效奖金延后发"就是这样）。
INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status) VALUES
  (1,'Q1-2026','2026 一季度','2026-01-01','2026-03-31','2026-08','open');

INSERT INTO perf_result(cycle_id,employee_id,state,score,grade) VALUES
  (1,10,'scored',95,'A'),
  (1,3, 'scored',60,'C');
INSERT INTO perf_result(cycle_id,employee_id,state,note) VALUES
  (1,2,'excluded','2 月入职未满考核期');
`);

{ // AD1 未封存不许算薪
  await db.exec(`INSERT INTO pay_run(id,period,legal_entity_id,calc_version,status) VALUES (10,'2026-08',1,1,'draft')`);
  let blocked=false, note='';
  try { await db.query(`SELECT fn_payroll_calc(10)`); note='未封存也算出薪了'; }
  catch(e){ blocked = String(e.message).includes('E_PERF_NOT_SEALED'); note=e.code; }
  rec('AD1','绩效周期未封存 → 算薪被拒（否则按一份还会变的分发钱）', blocked, note); }

{ // AD9 未封存时系数是 NULL 而不是 0
  const f = (await db.query(`SELECT fn_perf_factor(10,'2026-08') v`)).rows[0].v;
  rec('AD2','未封存时系数为 NULL 而不是 0（0 会让"还没封"与"系数 0"同形）',
      f === null, `factor=${f}`); }

{ // AD3 封存：系数按周期结束日生效的方案固化
  const n = Number((await db.query(`SELECT fn_perf_seal(1,'hr_head') n`)).rows[0].n);
  const rows = (await db.query(
    `SELECT employee_id, score, grade, factor FROM perf_result WHERE cycle_id=1 ORDER BY employee_id`)).rows;
  const p10 = rows.find(r=>Number(r.employee_id)===10);
  const p2  = rows.find(r=>Number(r.employee_id)===2);
  rec('AD3','封存固化系数：95 分 → A → 1.5；未考核者 factor 仍为 NULL',
      n === 2 && Number(p10.factor) === 1.5 && p2.factor === null,
      `封存 ${n} 行；person10 factor=${p10.factor}；person2 factor=${p2.factor}`); }

await expectErr(() => db.exec(`UPDATE perf_result SET score=99 WHERE cycle_id=1 AND employee_id=10`),
  'E_PERF_SEALED','AD4','封存后改分 → 拒（"算完再调分"是绩效季的常态，而工资已发）');

await expectErr(() => db.exec(`DELETE FROM perf_result WHERE cycle_id=1 AND employee_id=2`),
  'E_PERF_SEALED','AD5','封存后删行 → 拒');

{ // AD6 改方案不改历史：新增 v2，A 档系数 2.0，但已封存的仍是 1.5
  await db.exec(`
    INSERT INTO perf_scheme(id,version,name,effective_from) VALUES (2,2,'2026 修订版','2026-04-01');
    INSERT INTO perf_grade(scheme_id,grade,min_score,max_score,factor,target_pct) VALUES
      (2,'A',90,100,2.0000,20),(2,'B',75,89.99,1.2000,70),(2,'C',0,74.99,0.6000,10);`);
  const sealed = (await db.query(
    `SELECT factor FROM perf_result WHERE cycle_id=1 AND employee_id=10`)).rows[0].factor;
  const newScheme = (await db.query(
    `SELECT factor FROM perf_grade WHERE scheme_id=2 AND grade='A'`)).rows[0].factor;
  rec('AD6','改方案不改历史：已封存仍是 1.5，而新方案 A 档已是 2.0（系数是当时的事实）',
      Number(sealed) === 1.5 && Number(newScheme) === 2.0,
      `已封存=${sealed} 新方案=${newScheme}`); }

{ // AD7 封存后算薪通过，绩效工资进工资条
  const n = Number((await db.query(`SELECT fn_payroll_calc(10) n`)).rows[0].n);
  const sl = (await db.query(`SELECT id, gross_amount FROM payslip WHERE pay_run_id=10`)).rows[0];
  const item = (await db.query(
    `SELECT amount FROM payslip_item WHERE payslip_id=$1 AND item_code='PERF_BONUS'`,[sl.id])).rows[0];
  // 月薪 8000 × 1.5 = 12000 绩效，应发 = 8000 + 12000 = 20000
  rec('AD7','封存后算薪通过：绩效 8000×1.5=12000，应发 20000，且明细有 PERF_BONUS 行',
      n >= 1 && Number(sl.gross_amount) === 20000 && Number(item?.amount) === 12000,
      `应发=${sl?.gross_amount} 绩效=${item?.amount}`); }

await expectErr(() => db.exec(`UPDATE perf_cycle SET status='open', sealed_at=NULL WHERE id=1`),
  'E_PERF_REOPEN','AD8','解封 → 拒（解封后算过的工资与绩效对不上）');

await expectErr(() => db.exec(`INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status)
    VALUES (2,'Q1-dup','重复喂同一个发薪期','2026-01-01','2026-03-31','2026-08','open')`),
  'perf_cycle_pay_period_key','AD9','同一发薪期挂两个绩效周期 → 拒（两次算薪会读到不同版本）');

await expectErr(() => db.query(`SELECT fn_perf_grade_of(1,120)`),
  'E_PERF_SCORE_OUT_OF_RANGE','AD10','分数落在档位之外 → 报错，不"兜底到最近那一档"');

await expectErr(() => db.exec(`INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status)
    VALUES (3,'Q2-2026','二季度','2026-04-01','2026-06-30','2026-06','open') ;
  INSERT INTO perf_result(cycle_id,employee_id,state,note) VALUES (3,5,'excluded','  ')`),
  'ck_pr_excluded','AD11','未考核但原因空白 → 拒（空格能通过 NOT NULL）');

{ // AD12 强制分布只报不拦
  const dist = (await db.query(`SELECT grade, n, pct, target_pct, over_by FROM fn_perf_distribution(1)`)).rows;
  const a = dist.find(d=>d.grade==='A');
  const c = dist.find(d=>d.grade==='C');
  rec('AD12','强制分布可查：A 档 50% 超目标 20%，C 档 50% 超目标 10%（只报不拦，调分才是不报的后果）',
      !!a && Number(a.over_by) > 0 && !!c && Number(c.over_by) > 0,
      dist.map(d=>`${d.grade}:${d.pct}%(目标${d.target_pct}%,超${d.over_by})`).join(' ')); }

// ===========================================================================
// AQ 组 · 绩效打分（051）：把「表在、门没有」补上
// ---------------------------------------------------------------------------
// 026 把四张表和封存都写好了，可是没有任何东西往 perf_result 里写 ——
// 封存只能在空表上跑，fn_perf_factor 永远返回 NULL，工资条绩效那栏永远是 0。
// 而这个失败特别安静：0 看起来像"这个月没有绩效"。
// ===========================================================================
await db.exec(`
  INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status) VALUES
    (2,'M-2026-04','2026 四月','2026-04-01','2026-04-30','2026-04','open'),
    (3,'M-2026-05','2026 五月','2026-05-01','2026-05-31','2026-05','open'),
    (4,'M-2026-06','2026 六月','2026-06-01','2026-06-30','2026-06','open');
`);

{ // AQ1 打分即定档：95 → A 档；factor **不写**（封存时才固化）
  // ★ 这里的 2.0 不是硬编码的期望值，而是"按**周期结束日**生效的那一版方案"算出来的：
  //   v1（2026-01 生效）A 档系数 1.5，v2（2026-04 生效）A 档 2.0。
  //   4 月的周期拿到 2.0，才说明取的是 v2 而不是 v1 —— 与 fn_perf_seal 同一条口径。
  const r = (await db.query(`SELECT * FROM fn_perf_score(2,2,95,'季度目标达成','hr')`)).rows[0];
  const expect = (await db.query(
    `SELECT g.factor FROM perf_grade g
      WHERE g.scheme_id = fn_perf_scheme_asof('2026-04-30'::date) AND g.grade = 'A'`)).rows[0];
  const row = (await db.query(
    `SELECT state, score, grade, factor FROM perf_result WHERE cycle_id=2 AND employee_id=2`)).rows[0];
  rec('AQ1','打分即定档（95→A，取 4 月生效的 v2 方案＝2.0 而非 v1 的 1.5），且 factor 列仍为 NULL',
      r.grade === 'A' && Number(r.factor) === Number(expect.factor) && row.state === 'scored'
      && Number(row.score) === 95 && row.factor === null,
      `grade=${r.grade} 预告=${r.factor}（v2 A=${expect.factor}）库里 factor=${row.factor}`); }

{ // AQ2 分数越界
  let msg = '';
  try { await db.query(`SELECT fn_perf_score(2,2,101,'超范围','hr')`); } catch (e) { msg = e.message; }
  rec('AQ2','分数越界（101）→ 拒（E_PERF_SCORE_OUT_OF_RANGE），不是存个 101 等封存时炸',
      msg.includes('E_PERF_SCORE_OUT_OF_RANGE'), String(msg).split('\n')[0].slice(0, 40)); }

{ // AQ3 周期内不在职的人不该有绩效结果（张三 4-6 月无任职）
  let msg = '';
  try { await db.query(`SELECT fn_perf_score(2,1,80,'不在职也评一下','hr')`); } catch (e) { msg = e.message; }
  rec('AQ3','周期内没有任职的人 → 拒（E_PERF_NOT_EMPLOYED）；绩效名单要能解释"为什么没有他"',
      msg.includes('E_PERF_NOT_EMPLOYED'), String(msg).split('\n')[0].slice(0, 46)); }

{ // AQ4 未封存可改分：同一人同一周期只有一行，且档位跟着变
  await db.query(`SELECT fn_perf_score(2,2,88,'复核后调整为 88','hr')`);
  const rows = (await db.query(
    `SELECT score, grade FROM perf_result WHERE cycle_id=2 AND employee_id=2`)).rows;
  rec('AQ4','未封存可改分：仍只有一行，分数 88 且档位从 A 变 B（改分不是插入第二行）',
      rows.length === 1 && Number(rows[0].score) === 88 && rows[0].grade === 'B',
      `${rows.length} 行 ${rows[0]?.score}/${rows[0]?.grade}`); }

{ // AQ5 排除必须写原因
  let short = '', ok = '';
  try { await db.query(`SELECT fn_perf_exclude(3,2,'新来','hr')`); } catch (e) { short = e.message; }
  await db.query(`SELECT fn_perf_exclude(3,2,'5 月整月借调，不参与考核','hr')`);
  const row = (await db.query(
    `SELECT state, score, grade, note FROM perf_result WHERE cycle_id=3 AND employee_id=2`)).rows[0];
  rec('AQ5','排除必须写原因（太短 → E_PERF_EXCLUDE_REASON）；合法排除后 score/grade 必须为空',
      short.includes('E_PERF_EXCLUDE_REASON') && row.state === 'excluded'
      && row.score === null && row.grade === null && String(row.note).length >= 4,
      `${short ? '短原因✓' : '短原因✗'} 状态=${row?.state} 分=${row?.score}`); }

{ // AQ6 封存 → 系数固化 → payroll 读的正是这个函数
  const n = (await db.query(`SELECT fn_perf_seal(2,'hr_head') n`)).rows[0].n;
  const f = (await db.query(`SELECT fn_perf_factor(2,'2026-04') f`)).rows[0].f;
  const col = (await db.query(
    `SELECT factor FROM perf_result WHERE cycle_id=2 AND employee_id=2`)).rows[0].factor;
  const bFactor = (await db.query(
    `SELECT g.factor FROM perf_grade g
      WHERE g.scheme_id = fn_perf_scheme_asof('2026-04-30'::date) AND g.grade = 'B'`)).rows[0].factor;
  rec('AQ6','封存后系数被固化（88 分 → B 档），fn_perf_factor 读得到 —— 算薪取的就是它',
      Number(n) === 1 && Number(f) === Number(bFactor) && Number(col) === Number(bFactor),
      `固化 ${n} 行 factor=${f}（B=${bFactor}）库里=${col}`); }

{ // AQ7 方案有缺口 → 定不了档就不许存（比越界更常见、更晚被发现）
  await db.exec(`INSERT INTO perf_scheme(id,version,name,effective_from) VALUES (4,4,'2026-06 修订（有缺口）','2026-06-01')`);
  await db.exec(`INSERT INTO perf_grade(scheme_id,grade,min_score,max_score,factor,target_pct) VALUES
    (4,'A',90,100,2.0000,20),(4,'C',0,59.99,0.5000,10)`);
  let msg = '';
  try { await db.query(`SELECT fn_perf_score(4,2,70,'落在方案缺口里','hr')`); } catch (e) { msg = e.message; }
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM perf_result WHERE cycle_id=4`)).rows[0].n);
  rec('AQ7','方案有缺口（60–89 落不到档）→ 拒（E_PERF_NO_GRADE）且不留半行',
      msg.includes('E_PERF_NO_GRADE') && n === 0, `${String(msg).split('\n')[0].slice(0, 40)} 行数=${n}`); }

{ // AQ8 封存后打分 → 有名字的拒绝（不是触发器的"不能改"）
  let msg = '';
  try { await db.query(`SELECT fn_perf_score(1,10,90,'封存后补分','hr')`); } catch (e) { msg = e.message; }
  rec('AQ8','封存后打分 → 拒（E_PERF_SEALED，带上封存人与时间）—— 改分就是改已发的钱',
      msg.includes('E_PERF_SEALED'), String(msg).split('\n')[0].slice(0, 44)); }

{ // AQ9 「还差谁」：只看 perf_result 的界面永远答不出这件事
  const rows = (await db.query(
    `SELECT employee_id, bucket FROM v_perf_pending WHERE cycle_id=1 ORDER BY employee_id`)).rows;
  const b = rows.map(r => `${r.employee_id}:${r.bucket}`);
  rec('AQ9','v_perf_pending 按「周期 × 在职」展开：张三 bucket=missing、李四 excluded（还差谁看得见）',
      b.includes('1:missing') && b.includes('2:excluded'), b.join(' ')); }

// ===========================================================================
// AS 组 · 补账（052）：封账后唯一修正通道
// ---------------------------------------------------------------------------
// 016 把三条约束写得很细，但没有任何东西往里写 —— 报表也读不到它。
// 第五次同一个形态：对象存在但没有写入路径，等于没做。
// ===========================================================================
const baseRow = (await db.query(
  `SELECT employee_id, store_id, work_date, work_hours FROM attendance_daily_store
    WHERE store_id=10 AND work_date < '2026-04-01' ORDER BY work_date, employee_id LIMIT 1`)).rows[0];
const baseDay = baseRow.work_date.toISOString
  ? baseRow.work_date.toISOString().slice(0, 10)
  : String(baseRow.work_date).slice(0, 10);

{ // AS1 未封账的期间不许走补账（没封账就直接改原记录）
  let msg = '';
  try {
    await db.query(`SELECT fn_att_adjust($1,11,$2,1,'2026-04','先补一笔试试','hr')`,
      [baseRow.employee_id, baseDay]);
  } catch (e) { msg = e.message; }
  rec('AS1','未封账期间补账 → 拒（E_ATT_ADJ_NOT_CLOSED）：没封账时原记录还能改，两条路改同一个数会让报表变成两次',
      msg.includes('E_ATT_ADJ_NOT_CLOSED'), String(msg).split('\n')[0].slice(0, 46)); }

{ // AS2 只能往后
  let msg = '';
  try {
    await db.query(`SELECT fn_att_adjust($1,10,$2,1,'2026-02','往前调一下','hr')`,
      [baseRow.employee_id, baseDay]);
  } catch (e) { msg = e.message; }
  rec('AS2','补账期间早于工作日所属月 → 拒（E_ATT_ADJ_NOT_FORWARD）：往前调不是补账，是改历史',
      msg.includes('E_ATT_ADJ_NOT_FORWARD'), String(msg).split('\n')[0].slice(0, 50)); }

{ // AS3 理由太短
  let msg = '';
  try {
    await db.query(`SELECT fn_att_adjust($1,10,$2,1,'2026-04','忙','hr')`,
      [baseRow.employee_id, baseDay]);
  } catch (e) { msg = e.message; }
  rec('AS3','补账理由太短 → 拒（E_ATT_ADJ_REASON）', msg.includes('E_ATT_ADJ_REASON'),
      String(msg).split('\n')[0].slice(0, 40)); }

{ // AS4 正常补账：原记录不变、报表增加（这才是"接线"）
  const before = Number((await db.query('SELECT fn_rpt_hours(10,$1) h', ['2026-03'])).rows[0].h);
  const id = (await db.query(`SELECT fn_att_adjust($1,10,$2,2,'2026-04','夜班漏记两小时','hr') i`,
    [baseRow.employee_id, baseDay])).rows[0].i;
  const after = Number((await db.query('SELECT fn_rpt_hours(10,$1) h', ['2026-03'])).rows[0].h);
  const raw = Number((await db.query(
    `SELECT work_hours FROM attendance_daily_store WHERE employee_id=$1 AND store_id=10 AND work_date=$2::date`,
    [baseRow.employee_id, baseDay])).rows[0].work_hours);
  rec('AS4','补账另起一笔：原记录 work_hours 不变，而报表工时 +2（报表读 v_att_effective）',
      !!id && Math.abs(after - before - 2) < 0.001 && Math.abs(raw - Number(baseRow.work_hours)) < 0.001,
      `报表 ${before}→${after}，原记录 ${baseRow.work_hours}→${raw}`); }

{ // AS5 补账不进封账快照：verify 仍为空（快照要是"封账那天看到的数"）
  const v = (await db.query('SELECT * FROM fn_att_verify(10,$1)', ['2026-03'])).rows;
  rec('AS5','补账不影响封账快照（fn_att_verify 仍为空）：快照必须保持"封账那天我们看到的数"',
      v.length === 0, `差异 ${v.length} 条`); }

{ // AS6 补账可以指向原记录里没有的那一天（漏记），且要能出现在有效工时里
  const missDay = '2026-03-15';
  await db.query(`SELECT fn_att_adjust($1,10,$2,8,'2026-04','整日漏记，补一笔','hr')`,
    [baseRow.employee_id, missDay]);
  const row = (await db.query(
    `SELECT work_hours, from_adjust_only FROM v_att_effective
      WHERE employee_id=$1 AND store_id=10 AND work_date=$2::date`,
    [baseRow.employee_id, missDay])).rows[0];
  rec('AS6','补账能补"原记录没有的那一天"（漏记）：有效工时 8 小时、标记 from_adjust_only',
      !!row && Number(row.work_hours) === 8 && row.from_adjust_only === true,
      JSON.stringify(row)); }

// ===========================================================================
// HI 组 · 入职（052）：offer → 在职，三处同源
// ---------------------------------------------------------------------------
// 025 的 fn_offer_onboard 有断言但没接口 —— 招聘漏斗的末端在界面上是断的。
// 而补这一层必然要写 fn_person_create，于是撞上第六次"主键没有生成方式"：
// person.id 一直是显式插的，函数一插就 23502。
// 这次是 Q14 抓到的（不是运行时炸），上面那次红就是证据。
// ===========================================================================
// ★ 再对齐一次序列：syncSeq（上面那次）之后又播种了 person 3/10/95/96。
//   序列停在 3，而 3 已存在 —— 第一次自动插入就是 duplicate key。
//   这正是"显式 id 播种"的固定收尾动作，播种完就要对齐，而不是开头对齐一次。
await syncSeq();

// 不新发 offer：R 组种子里的那几份正好覆盖"可入职 / 已入职 / 已过期"三种状态。
// （新发 offer 会撞编制约束 —— 而编制是真实约束，不该为了测入职去改它。）
const liveOffer = (await db.query(
  `SELECT o.id, o.candidate_name FROM offer o
     JOIN offer_version v ON v.offer_id = o.id
    WHERE o.status = 'pending'
    ORDER BY v.valid_until DESC LIMIT 1`)).rows[0];

{ // AT2-1 入职：三处（任职/归属/月薪）同源，且不带 person 时按候选人姓名建档
  const r = (await db.query(`SELECT * FROM fn_hire_from_offer($1,NULL,'2026-04-10'::date,1,'hr')`,
    [liveOffer.id])).rows[0];
  const emp = (await db.query(
    `SELECT person_id, hire_date FROM employment WHERE id=$1`, [r.employment_id])).rows[0];
  const sal = (await db.query(
    `SELECT monthly_amount FROM salary_standard WHERE employment_id=$1`, [r.employment_id])).rows[0];
  const asg = (await db.query(
    `SELECT org_id FROM employee_org_assignment WHERE employee_id=$1 AND dim_code='cost_org'`,
    [r.person_id])).rows[0];
  const p = (await db.query(`SELECT full_name FROM person WHERE id=$1`, [r.person_id])).rows[0];
  const st = (await db.query(`SELECT status, onboard_person FROM offer WHERE id=$1`,
    [liveOffer.id])).rows[0];

  rec('HI1','入职三处同源（任职+归属+月薪都来自 offer 版本），且按候选人姓名建档、offer 转 onboarded',
      Number(emp.person_id) === Number(r.person_id) && Number(sal.monthly_amount) === 7000
      && !!asg && p?.full_name === liveOffer.candidate_name
      && st.status === 'onboarded' && Number(st.onboard_person) === Number(r.person_id),
      `emp=${r.employment_id} 姓名=${p?.full_name} 月薪=${sal?.monthly_amount} 归属=${asg?.org_id} offer=${st.status}`); }

{ // AT2-2 重复入职
  let msg = '';
  try { await db.query(`SELECT * FROM fn_hire_from_offer($1,NULL,'2026-04-11'::date,1,'hr')`, [liveOffer.id]); }
  catch (e) { msg = e.message; }
  rec('HI2','同一份 offer 再入职 → 拒（E_OFFER_NOT_LIVE）；否则同一个编可以招两次',
      msg.includes('E_OFFER_NOT_LIVE'), String(msg).split('\n')[0].slice(0, 42)); }

{ // AT2-3 过期 offer
  const expired = (await db.query(
    `SELECT o.id FROM offer o JOIN offer_version v ON v.offer_id=o.id
      WHERE o.status = 'pending' AND v.valid_until < '2026-06-01'
      ORDER BY v.valid_until LIMIT 1`)).rows[0];
  let msg = '';
  if (expired) {
    try { await db.query(`SELECT * FROM fn_hire_from_offer($1,NULL,'2026-06-01'::date,1,'hr')`, [expired.id]); }
    catch (e) { msg = e.message; }
  }
  rec('HI3','过期 offer 入职 → 拒（E_OFFER_EXPIRED，带有效期与入职日）',
      msg.includes('E_OFFER_EXPIRED'), String(msg).split('\n')[0].slice(0, 46) || '没有过期的 pending offer'); }

// ===========================================================================
// RO 组 · 花名册（053）：第一个"能看人"的出口
// ---------------------------------------------------------------------------
// person / employment / employee_org_assignment 三张表一直在，却没有一个读出口。
// 这是「表在、门没有」的另一半：前五次是没有写入路径，这次是没有读取路径，
// 而它的失败形态不是错，是"这个系统看起来没有员工"。
// ===========================================================================
const roster = async (user, asOf) => {
  await db.query('SELECT app_begin_scope($1,$2,$3)', [user, 'employee_roster', null]);
  return (await db.query('SELECT * FROM fn_emp_roster($1::date)', [asOf])).rows;
};

{ // RO1 行闸两头都要非空：集团有、无授权空
  const all = await roster(1, '2026-03-15');
  const none = await roster(3, '2026-03-15');
  rec('RO1','花名册走同一套行闸：集团看得到（≥2 人）、无授权 0 行（不是"看到了但没权限"）',
      all.length >= 2 && none.length === 0,
      `集团 ${all.length} / 无授权 ${none.length}`); }

{ // RO2 deny 压过 grant —— 换一个读接口，不需要重新实现 deny
  const narrow = await roster(4, '2026-03-15');
  const deny = (await db.query(
    `SELECT org_id FROM pg_temp.tmp_scope_deny WHERE dim_code='cost_org'`)).rows;
  rec('RO2','花名册与考勤共用同一套 deny：user 4 有 org 的授权、但该组织在 deny 里 → 0 行',
      narrow.length === 0 && deny.length >= 1,
      `deny=${JSON.stringify(deny.map(d => Number(d.org_id)))} 名单 ${narrow.length} 行`); }

{ // RO3 时点：不给"当前在职"，as_of 早于任何入职就是空名单
  const early = await roster(1, '2025-12-31');
  rec('RO3','截至日期早于所有人入职 → 0 行（"当前在职"这种说法在跨月那天会变成另一个答案）',
      early.length === 0, `2025-12-31 → ${early.length} 人`); }

{ // RO4 名单 = 那时在职的人，不是"所有有过记录的人"
  const mar = await roster(1, '2026-03-15');
  const may = await roster(1, '2026-05-15');
  const zhangMar = mar.find(r => Number(r.employee_id) === 1);
  const zhangMay = may.find(r => Number(r.employee_id) === 1);
  rec('RO4','张三 3 月在名单、5 月不在（两段任职之间）—— 名单按任职区间过滤，不混进"归属还挂着"的人',
      !!zhangMar && !zhangMay,
      `3月=${zhangMar ? '在' : '不在'} 5月=${zhangMay ? '在' : '不在'}`); }

{ // RO5 字段值本身不被函数改：national_id 的原值在库里，掩码是展示层的事
  const raw = (await db.query(
    `SELECT profile_value FROM person_profile WHERE person_id=1 AND profile_type='national_id'`)).rows[0];
  rec('RO5','掩码不影响库里的原值（掩码是展示层判断，不是把数据改掉）',
      !!raw && String(raw.profile_value).length >= 15,
      `${String(raw?.profile_value).slice(0, 6)}…（${String(raw?.profile_value).length} 位）`); }

// ===========================================================================
// TR 组 · 离职（054）：第七个「表在、门没有」
// ---------------------------------------------------------------------------
// employment.leave_date 从 007 就在，却没有写入路径。而离职有**连带**：
// 只写 leave_date 不结束归属，就会留下"人走了、归属还挂着"——
// 花名册按任职过滤看不见他，但"这个店几个人"的口径还数着他。两处各自自洽，加起来错。
// ===========================================================================
const beforeSlips = Number((await db.query(
  'SELECT count(*)::int n FROM payslip WHERE employee_id=1')).rows[0].n);
const beforeDays = Number((await db.query(
  'SELECT count(*)::int n FROM attendance_daily_store WHERE employee_id=1')).rows[0].n);
const curHire = (await db.query(
  `SELECT hire_date FROM employment WHERE person_id=1 AND leave_date IS NULL
    ORDER BY hire_date DESC LIMIT 1`)).rows[0];

{ // TR1 离职：结束任职 + 结束归属 + 留一条记录（三件事同一事务）
  const id = (await db.query(`SELECT fn_emp_terminate(1,'2026-09-30','个人原因离职','hr') id`)).rows[0].id;
  const emp = (await db.query(
    `SELECT leave_date FROM employment WHERE person_id=1 AND leave_date IS NOT NULL
      ORDER BY hire_date DESC LIMIT 1`)).rows[0];
  const asg = (await db.query(
    `SELECT count(*)::int n FROM employee_org_assignment
      WHERE employee_id=1 AND valid_to IS NULL`)).rows[0].n;
  const rec1 = (await db.query(
    'SELECT leave_date, reason FROM employment_termination WHERE id=$1', [id])).rows[0];
  rec('TR1','离职三件事同一事务：任职结束、归属区间一并结束（不留悬空）、留一条原因',
      !!id && !!emp && asg === 0 && !!rec1
      // ★ date 列在 PGlite 里是 Date 对象：String(d) 得到的是 "Wed Sep 30 2026…"，
      //   不是 ISO。比日期一律走 toISOString().slice(0,10) —— 这条坑踩过一次。
      && new Date(rec1.leave_date).toISOString().slice(0, 10) === '2026-09-30',
      `记录=${id} 归属未结束=${asg} 原因="${rec1?.reason}"`); }

{ // TR2 名单：离职次日起不再有他
  await db.query('SELECT app_begin_scope($1,$2,$3)', [1, 'employee_roster', null]);
  const after = (await db.query(`SELECT * FROM fn_emp_roster('2026-10-01'::date)`)).rows;
  const onDay = (await db.query(`SELECT * FROM fn_emp_roster('2026-09-30'::date)`)).rows;
  rec('TR2','离职日当天仍在名单（闭区间），次日起不在 —— 差一天就是一天的钱',
      onDay.some(r => Number(r.employee_id) === 1) && !after.some(r => Number(r.employee_id) === 1),
      `9-30 在=${onDay.some(r => Number(r.employee_id) === 1)} 10-1 在=${after.some(r => Number(r.employee_id) === 1)}`); }

{ // TR3 重复离职
  let msg = '';
  try { await db.query(`SELECT fn_emp_terminate(1,'2026-10-31','再办一次试试','hr')`); }
  catch (e) { msg = e.message; }
  rec('TR3','已离职再办 → 拒（E_TERM_ALREADY_LEFT）；重复办会把日期改掉，而那天发过的钱不会跟着变',
      msg.includes('E_TERM_ALREADY_LEFT'), String(msg).split('\n')[0].slice(0, 44)); }

{ // TR4 离职日早于入职日
  let msg = '';
  try { await db.query(`SELECT fn_emp_terminate(2,'2025-12-01','早于入职的离职日','hr')`); }
  catch (e) { msg = e.message; }
  rec('TR4','离职日早于入职日 → 拒（E_TERM_BEFORE_HIRE）', msg.includes('E_TERM_BEFORE_HIRE'),
      String(msg).split('\n')[0].slice(0, 46)); }

{ // TR5 原因太短
  let msg = '';
  try { await db.query(`SELECT fn_emp_terminate(2,'2026-06-30','走','hr')`); }
  catch (e) { msg = e.message; }
  rec('TR5','离职原因太短 → 拒（E_TERM_NO_REASON）；只留日期，三个月后没人答得出"为什么走"',
      msg.includes('E_TERM_NO_REASON'), String(msg).split('\n')[0].slice(0, 40)); }

{ // TR6 离职不动历史：考勤与工资条条数都不变
  const s1 = Number((await db.query(
    'SELECT count(*)::int n FROM payslip WHERE employee_id=1')).rows[0].n);
  const d1 = Number((await db.query(
    'SELECT count(*)::int n FROM attendance_daily_store WHERE employee_id=1')).rows[0].n);
  rec('TR6','离职不改历史：考勤与工资条条数不变（那是已经发生的事实，离职不改变它）',
      s1 === beforeSlips && d1 === beforeDays, `工资条 ${beforeSlips}→${s1} 考勤 ${beforeDays}→${d1}`); }

{ // TR7 离职记录只增不改
  const id = (await db.query('SELECT id FROM employment_termination ORDER BY id LIMIT 1')).rows[0].id;
  let up = '', del = '';
  try { await db.query(`UPDATE employment_termination SET reason='换个说法' WHERE id=$1`, [id]); }
  catch (e) { up = e.message; }
  try { await db.query(`DELETE FROM employment_termination WHERE id=$1`, [id]); }
  catch (e) { del = e.message; }
  rec('TR7','离职记录只增不改（改/删都被拒）；删掉之后"他为什么走"就只剩传闻',
      up.includes('E_ET_NO_UPDATE') && del.includes('E_ET_NO_DELETE'),
      `${up ? '改✓' : '改✗'} ${del ? '删✓' : '删✗'}`); }

// ===========================================================================
// RP 组 · 导出留痕（055）：谁把哪一期带走了
// ---------------------------------------------------------------------------
// 导出是 HR 数据离开系统的唯一出口，而它原来的状态是：**没有留痕**。
// 这一组证明四件事：0 行不许导、没摘要不许导、写进去能被审计视角看到、
// 写进去之后改不了也删不了。
// ===========================================================================
{ let msg = '';
  try { await db.query(`SELECT fn_report_export_log('hr',30,'2026-03',0,10,repeat('a',64))`); }
  catch (e) { msg = e.message; }
  rec('RP1','0 行的导出 → 拒（E_EXPORT_EMPTY）；空文件会让收到的人以为"这个月没数据"',
      msg.includes('E_EXPORT_EMPTY'), String(msg).split('\n')[0].slice(0, 44)); }

{ let msg = '';
  try { await db.query(`SELECT fn_report_export_log('hr',30,'2026-03',7,100,NULL)`); }
  catch (e) { msg = e.message; }
  rec('RP2','没有内容摘要 → 拒（E_EXPORT_NO_DIGEST）；没有摘要就无法证明文件没被改过',
      msg.includes('E_EXPORT_NO_DIGEST'), String(msg).split('\n')[0].slice(0, 44)); }

const reId = (await db.query(
  `SELECT fn_report_export_log('hr',30,'2026-03',7,1234,repeat('a',64)) id`)).rows[0].id;

{ const v = (await db.query(`SELECT exported_by, times, rows_total FROM v_report_export_daily`)).rows;
  rec('RP3','写一条 → 审计视角给出"谁、几次、共几行"（不是只有一张流水表）',
      Number(reId) > 0 && v.length === 1 && v[0].exported_by === 'hr'
      && Number(v[0].times) === 1 && Number(v[0].rows_total) === 7,
      v.map(x => `${x.exported_by}:${x.times}次/${x.rows_total}行`).join(' ')); }

{ let up = '', del = '';
  try { await db.query(`UPDATE report_export SET row_count=999 WHERE id=$1`, [reId]); }
  catch (e) { up = e.message; }
  try { await db.query(`DELETE FROM report_export WHERE id=$1`, [reId]); }
  catch (e) { del = e.message; }
  rec('RP4','留痕只增不改（改/删都被拒）；改了行数或摘要，它就不再证明任何事',
      up.includes('E_RE_NO_UPDATE') && del.includes('E_RE_NO_DELETE'),
      `${up ? '改✓' : '改✗'} ${del ? '删✓' : '删✗'}`); }

{ const t = (await db.query(`SELECT fn_rpt_has_data('2026-03') h`)).rows[0].h;
  const f = (await db.query(`SELECT fn_rpt_has_data('2019-01') h`)).rows[0].h;
  let bad = '';
  try { await db.query(`SELECT fn_rpt_has_data('2026-3')`); } catch (e) { bad = e.message; }
  rec('RP5','"这一期有没有数据"能回答：2026-03 有、2019-01 没有、写错格式直接拒',
      t === true && f === false && bad.includes('E_PERIOD_INVALID'),
      `2026-03=${t} 2019-01=${f} 2026-3=${bad ? '拒' : '没拒'}`); }

// ===========================================================================
// DS 组 · 看板按范围出行（056）
// ---------------------------------------------------------------------------
// 024 的 fn_dash_group 列的是"根下面每个区域"，不看权限。A 店 HR 打开看板
// 看到的是华东区的总人数、总工时、工资总额 —— 泄的不是一行，是一个区域的规模。
// 这一组证明：集团 HR 看区域、门店 HR 看自己、没范围的人看空。
// ===========================================================================
// ★ 这里**不硬编码"集团HR 看到 1 行区域"**：前面的组织版本测试把 A店/B店
//   挪到了新的父节点，授权集合也跟着变了。写死期望值的断言会在改组织结构那天
//   变成"测试坏了"，而它其实是**替实现背书**。所以改用三条性质：
//     ① 出行的每一行，其整棵子树都在范围内（不泄露）；
//     ② 范围内的每个组织，都能被某个出行行覆盖（不漏）；
//     ③ 没有范围 → 0 行（不是集团数）。
{ await db.query(`SELECT app_begin_scope(1,'report',NULL)`);
  const g = (await db.query(`SELECT * FROM fn_dash_group('2026-03')`)).rows;
  const partial = Number((await db.query(`
    SELECT count(*)::int n FROM public.fn_dash_group('2026-03') g
     WHERE EXISTS (SELECT 1 FROM public.org_unit c
                    WHERE c.is_active AND c.path LIKE (SELECT path FROM public.org_unit WHERE id = g.org_id) || '%'
                      AND NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                                       WHERE s.dim_code='cost_org' AND s.org_id = c.id))`)).rows[0].n);
  rec('DS1','出行组织的子树**整棵**在范围内（不是"能看见就出行"）：部分可见的区域给不出数',
      g.length >= 1 && partial === 0,
      `${g.length} 行，部分可见 ${partial} 行`); }

{ const missing = Number((await db.query(`
    SELECT count(*)::int n FROM public.org_unit o
     WHERE o.is_active
       AND EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s WHERE s.dim_code='cost_org' AND s.org_id = o.id)
       AND NOT EXISTS (SELECT 1 FROM public.fn_dash_group('2026-03') g
                        WHERE o.path LIKE (SELECT path FROM public.org_unit WHERE id = g.org_id) || '%')`)).rows[0].n);
  rec('DS2','范围内的每个组织都被某个出行行覆盖（不漏）：只做"过滤"会漏掉整片区域',
      missing === 0, `漏 ${missing} 个`); }

{ await db.query(`SELECT app_begin_scope(2,'report',NULL)`);
  const g = (await db.query(`SELECT * FROM fn_dash_group('2026-03')`)).rows;
  const out = Number((await db.query(`
    SELECT count(*)::int n FROM public.fn_dash_group('2026-03') g
     WHERE NOT EXISTS (SELECT 1 FROM pg_temp.tmp_scope_org s
                        WHERE s.dim_code='cost_org' AND s.org_id = g.org_id)`)).rows[0].n);
  rec('DS3','A店HR：出行的都是自己范围内的组织（区域那种"整棵不可见"的行不出行）',
      g.length >= 1 && out === 0, g.map(x => `${x.org_id}:${x.name}`).join(' ')); }

{ await db.query(`SELECT app_begin_scope(3,'report',NULL)`);
  const g = (await db.query(`SELECT * FROM fn_dash_group('2026-03')`)).rows;
  rec('DS4','四维全空账号 → 0 行（不是集团数）；空白必须能被界面读成"你还没有范围"',
      g.length === 0, `${g.length} 行`); }

// ===========================================================================
// LT 组 · 离职时剩余年假：配置项（057）
// ---------------------------------------------------------------------------
// 054 说"剩余年假怎么结算是薪酬政策，不替客户决定"——那是对的，但"不做"与
// "没得选"是两件事。057 把它做成制度项，默认 none（= 上线前的行为）。
// 这一组的三条骨架，正是"拿不准的口径做成配置项"的四步：
//   ① 默认不动  ② 改配置真的跟着变  ③ 反例（改回去就不动）  ④ 边界写清楚
// ===========================================================================
const mkLeaver = async (name) => {
  const pid = (await db.query(`SELECT fn_person_create($1) id`, [name])).rows[0].id;
  await db.query(`INSERT INTO employment(person_id, legal_entity_id, hire_date)
                  VALUES ($1, 1, '2026-01-01')`, [pid]);
  await db.query(`INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from)
                  VALUES ($1, 'cost_org', 10, '2026-01-01')`, [pid]);
  await db.query(`INSERT INTO leave_grant(employee_id, leave_type_id, qty, valid_from)
                  VALUES ($1, 2, 5, '2026-01-01')`, [pid]);   // 年假 5 小时
  return Number(pid);
};
const annualLeft = async (pid) => Number((await db.query(
  `SELECT available FROM v_leave_balance WHERE employee_id=$1 AND leave_type_id=2`,
  [pid])).rows[0]?.available);

const LTA = await mkLeaver('离职测试甲');   // 默认政策下离职
const LTB = await mkLeaver('离职测试乙');   // 改成 forfeit 后离职
const LTC = await mkLeaver('离职测试丙');   // 改回 none 后离职

{ // ① 默认：政策项已登记，值为 none，且离职不动额度
  const pol = (await db.query(
    `SELECT value_text FROM fn_policy_effective('LEAVE_TERM_HANDLING', 10, '2026-06-30')`)).rows[0];
  await db.query(`SELECT fn_emp_terminate($1,'2026-06-30','默认政策下的离职','hr')`, [LTA]);
  const left = await annualLeft(LTA);
  rec('LT1','默认政策 none：离职后额度一分不动（配置项的默认值必须等于上线前的行为）',
      pol?.value_text === 'none' && left === 5,
      `政策=${pol?.value_text} 剩余年假=${left}`); }

{ // ② 改配置 ⇒ 行为真的跟着变
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
                  VALUES ('LEAVE_TERM_HANDLING','2026-07-01','forfeit','group_hr',
                          '集团决定：离职时剩余年假作废')`);
  await db.query(`SELECT fn_emp_terminate($1,'2026-07-31','作废政策下的离职','hr')`, [LTB]);
  const left = await annualLeft(LTB);
  const row = (await db.query(
    `SELECT qty, state FROM leave_usage WHERE employee_id=$1 AND state='forfeited'`,
    [LTB])).rows[0];
  rec('LT2','把制度项改成 forfeit → 余 5 小时被核销成 0，台账上留一行 forfeited（不是删授予行）',
      left === 0 && Number(row?.qty) === 5,
      `剩余=${left} 作废行=${row ? row.qty : '无'}`); }

{ // ③ 反例：改回去就不动 —— 证明读的是配置，不是写死的分支
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
                  VALUES ('LEAVE_TERM_HANDLING','2026-08-01','none','group_hr',
                          '集团改回：先不处理，等薪酬政策定')`);
  await db.query(`SELECT fn_emp_terminate($1,'2026-08-31','改回默认后的离职','hr')`, [LTC]);
  const left = await annualLeft(LTC);
  rec('LT3','把制度项改回 none → 下一个人离职额度不动（读的是配置，不是写死的分支）',
      left === 5, `剩余=${left}`); }

{ // ④ 边界：还有待批的假时，结算会让余额变负 —— 先拒，别猜
  const ltd = await mkLeaver('离职测试丁');
  await db.query(`INSERT INTO leave_usage(employee_id, leave_type_id, qty, state)
                  VALUES ($1, 2, 1, 'frozen')`, [ltd]);
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
                  VALUES ('LEAVE_TERM_HANDLING','2026-09-01','forfeit','group_hr',
                          '再试一次作废：看有待批单据时会不会拒')`);
  let msg = '';
  try { await db.query(`SELECT fn_emp_terminate($1,'2026-09-30','有待批假还要离职','hr')`, [ltd]); }
  catch (e) { msg = e.message; }
  const stillHired = (await db.query(
    `SELECT count(*)::int n FROM employment WHERE person_id=$1 AND leave_date IS NULL`, [ltd])).rows[0].n;
  rec('LT4','有待批请假 → 拒（E_LEAVE_PENDING_ON_EXIT）；先结算再批假，余额会变成负数，而负数在页面上像"算错了"',
      msg.includes('E_LEAVE_PENDING_ON_EXIT') && Number(stillHired) === 1,
      String(msg).split('\n')[0].slice(0, 44)); }

{ // ⑤ 五态自洽：每条余额都等于 授予 − 冻结 − 已用 − 作废，且没有负数
  const bad = (await db.query(
    `SELECT count(*)::int n FROM v_leave_balance
      WHERE available <> granted - frozen - used - forfeited OR available < 0`)).rows[0].n;
  rec('LT5','五态自洽：available = granted − frozen − used − forfeited，且没有负数',
      Number(bad) === 0, `${bad} 条不自洽`); }

// ===========================================================================
// LG 组 · 登录按来源限流（058）
// ---------------------------------------------------------------------------
// 035 的"同一账号错 5 次就锁"挡不住两件事：撞库（每个账号只错一次），
// 以及"拿锁定做拒绝服务"（盯着一个人连错 5 次）。两者的特征都在**来源**上。
// ===========================================================================
{ for (let i = 0; i < 30; i++) {
    await db.query(`SELECT fn_login_record('10.0.0.9', $1, false)`, [`user${i}`]);
  }
  const a = (await db.query(`SELECT fn_login_throttled('10.0.0.9') b`)).rows[0].b;
  const b = (await db.query(`SELECT fn_login_throttled('10.0.0.10') b`)).rows[0].b;
  rec('LG1','同一来源 30 次失败后被限；另一个来源不受影响（撞库的特征在来源上，不在账号上）',
      a === true && b === false, `A=${a} B=${b}`); }

{ await db.query(`SELECT fn_login_record('10.0.0.9', '1', true)`);   // 这个来源上有人登录成功了
  const a = (await db.query(`SELECT fn_login_throttled('10.0.0.9') b`)).rows[0].b;
  rec('LG2','成功不清零：登进来一次不能把失败计数洗掉（否则有一个自己的账号就能无限续命）',
      a === true, `仍被限=${a}`); }

{ const w0 = (await db.query(`SELECT fn_login_throttled('10.0.0.9', 0) b`)).rows[0].b;
  rec('LG3','窗口外不算：窗口取 0 秒时该来源不算被限（阈值是"最近 N 秒内"的话，不是总数）',
      w0 === false, `窗口0s=${w0}`); }

{ await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
                  VALUES ('RATE_LOGIN_FAIL_PER_15M','2026-11-01',3,'group_hr','压测：把阈值临时调到 3')`);
  for (let i = 0; i < 3; i++) {
    await db.query(`SELECT fn_login_record('10.0.0.11', 'vip', false)`);
  }
  const t = (await db.query(`SELECT fn_login_throttled('10.0.0.11') b`)).rows[0].b;
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
                  VALUES ('RATE_LOGIN_FAIL_PER_15M', (current_date + 1)::date, 30,
                          'group_hr', '压测结束，恢复 30')`);
  // 恢复值是**从明天起**生效的（制度带生效日，不追溯）—— 所以今天仍按 3 判，
  // 明天才回到 30。这一条既证明"阈值是配置项"，也证明"改了不追溯"。
  const today = (await db.query(
    `SELECT value_num FROM fn_policy_effective('RATE_LOGIN_FAIL_PER_15M', 1, current_date)`)).rows[0].value_num;
  const tomorrow = (await db.query(
    `SELECT value_num FROM fn_policy_effective('RATE_LOGIN_FAIL_PER_15M', 1, current_date + 1)`)).rows[0].value_num;
  rec('LG4','阈值是配置项且不追溯：今天按 3 判（错 3 次就被限），明天起回到 30',
      t === true && Number(today) === 3 && Number(tomorrow) === 30,
      `阈值3时=${t} 今天=${today} 明天=${tomorrow}`); }

{ const v = (await db.query(
    `SELECT source, fails FROM v_login_fail_by_source WHERE source='10.0.0.9'`)).rows[0];
  rec('LG5','审计视角看得见"哪个来源在被撞"：按来源聚失败次数',
      !!v && Number(v.fails) === 30, v ? `${v.source} 失败 ${v.fails} 次` : '没有记录'); }

// ===========================================================================
// NO 组 · 工号（061）：能分配、能看见、永不复用
// ---------------------------------------------------------------------------
// 007 写了 employee_no 与 fn_assign_employee_no，但**入职不分配**、
// **名单不显示**。规矩对，链断在两头 —— 这一组把两头都接上。
// ===========================================================================
await db.exec(`
  INSERT INTO org_unit(id,parent_id,name,path) VALUES (45,40,'G店','001.040.045');
  INSERT INTO headcount_budget(org_id,period,version,quota,set_by,reason)
    VALUES (45,'2026-05',1,5,'area_hr','G店 5 个');
  INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
    VALUES (45,'店员',5,'2026-05-01','工号测试','area_hr');`);
const rqNo = Number((await db.query(
  `SELECT id FROM requisition WHERE org_id=45 ORDER BY id DESC LIMIT 1`)).rows[0].id);

const hireOne = async (key, name) => {
  const off = (await db.query(
    `SELECT fn_offer_issue($1,$2,$3,'店员',6000,'2026-12-31'::date,'2026-05-01'::date,'hr','工号测试') id`,
    [rqNo, key, name])).rows[0].id;
  return (await db.query(
    `SELECT * FROM fn_hire_from_offer($1,NULL,'2026-05-10'::date,1,'hr')`, [off])).rows[0];
};

const h1 = await hireOne('CAND-N1', '工号甲');
const no1 = (await db.query(
  `SELECT no, retired_at FROM employee_no WHERE assigned_person_id=$1`, [h1.person_id])).rows;

{ rec('NO1','入职即分配工号（前缀 + 补零到 4 位），一个人只有一行',
      no1.length === 1 && /^E[0-9]{4}$/.test(no1[0].no) && no1[0].retired_at === null,
      no1.map(x => `${x.no}${x.retired_at ? '(退休)' : ''}`).join(' ')); }

let h2;   // NO2 里入职的人，NO3 还要用 —— 写在块里会变成块级作用域
{ // 永不复用：把人退休掉，下一个人拿到的是 max+1，而不是那个空出来的号
  await db.query(`UPDATE employee_no SET retired_at = now() WHERE assigned_person_id=$1`, [h1.person_id]);
  h2 = await hireOne('CAND-N2', '工号乙');
  const no2 = (await db.query(
    `SELECT no FROM employee_no WHERE assigned_person_id=$1`, [h2.person_id])).rows[0].no;
  rec('NO2','永不复用：退休一个人的号之后，下一个入职者拿 max+1（不是把空出来的号再发一次）',
      Number(no2.slice(1)) === Number(no1[0].no.slice(1)) + 1,
      `${no1[0].no}(退休) → ${no2}`); }

{ // 花名册带出工号，且与台账一致（分配了要看得见）
  // 这一条测的是"工号有没有带出来"，不是权限（权限在 RO 组）——
  // 所以自己灌一份全量范围，不依赖前面哪一组留下的临时表。
  await db.exec(`TRUNCATE pg_temp.tmp_scope_org; TRUNCATE pg_temp.tmp_scope_deny;`);
  await db.query(`INSERT INTO pg_temp.tmp_scope_org(dim_code, org_id)
                  SELECT 'cost_org', id FROM public.org_unit WHERE is_active`);
  const r = (await db.query(
    `SELECT employee_id, employee_no FROM fn_emp_roster('2026-05-20'::date)`)).rows;
  const mine = r.find(x => Number(x.employee_id) === Number(h2.person_id));
  rec('NO3','花名册带出工号：入职的人在名单上就有号（写了没人看，与不存在区别不大）',
      !!mine && /^E[0-9]{4}$/.test(mine.employee_no || ''), mine ? mine.employee_no : '名单上没有他'); }

{ // 规则是配置项：改前缀，下一个号跟着改（反例在下一行：改回去又回原规则）
  await db.query(`INSERT INTO policy_value(policy_code,effective_from,value_text,published_by,reason)
                  VALUES ('EMP_NO_PREFIX', current_date, 'H', 'group_hr', '压测：换前缀看工号规则是否接线')`);
  const nxt = (await db.query(`SELECT fn_next_employee_no() no`)).rows[0].no;
  await db.query(`INSERT INTO policy_value(policy_code,effective_from,value_text,published_by,reason)
                  VALUES ('EMP_NO_PREFIX', current_date + 1, 'E', 'group_hr', '压测结束，明天起恢复 E')`);
  rec('NO4','工号规则是配置项：前缀改成 H 之后下一个号就是 H0001 起的流水（不是写死的 E）',
      /^H[0-9]{4}$/.test(nxt), nxt); }

// ===========================================================================
// IM 组 · 考勤机文件导入（066）：先预览、错行不整批失败、重复不翻倍
// ===========================================================================
const rows = JSON.stringify([
  { emp_no: 'E0001', at: '2026-06-01T09:00:00+08:00', kind: 'in' },
  { emp_no: 'E0002', at: '2026-06-01T18:05:00+08:00', kind: 'out' },
  { emp_no: 'NOPE-9', at: '2026-06-01T09:00:00+08:00', kind: 'in' },
]);
const punchCount = async () => Number((await db.query('SELECT count(*)::int n FROM punch')).rows[0].n);

{ const before = await punchCount();
  const dry = (await db.query(`SELECT * FROM fn_punch_import($1::jsonb,'hr',true,'a.csv')`, [rows])).rows;
  const after = await punchCount();
  rec('IM1','预览（dry）不落库：两行可进、一行跳过，punch 一行未增',
      after === before && dry.filter(r=>r.status==='ok').length === 2
      && dry.filter(r=>r.status==='skip').length === 1,
      `ok=${dry.filter(r=>r.status==='ok').length} skip=${dry.filter(r=>r.status==='skip').length} 行数 ${before}→${after}`); }

{ const before = await punchCount();
  const out = (await db.query(`SELECT * FROM fn_punch_import($1::jsonb,'hr',false,'a.csv')`, [rows])).rows;
  const after = await punchCount();
  const b = (await db.query(`SELECT total_rows,ok_rows,skip_rows,dup_rows FROM punch_import_batch ORDER BY id DESC LIMIT 1`)).rows[0];
  rec('IM2','错行不整批失败：工号不存在的那行跳过并记原因，其余两行照进（批次表 3=2+1+0）',
      after === before + 2 && Number(b.total_rows) === 3 && Number(b.ok_rows) === 2
      && Number(b.skip_rows) === 1,
      `行数 ${before}→${after} 批次 ${b.total_rows}=${b.ok_rows}+${b.skip_rows}+${b.dup_rows}`); }

{ const before = await punchCount();
  const again = (await db.query(`SELECT * FROM fn_punch_import($1::jsonb,'hr',false,'a.csv')`, [rows])).rows;
  const after = await punchCount();
  rec('IM3','幂等：同一份文件再导一次 → 全是 dup，punch 不增加（人工反复导入是常态）',
      after === before && again.filter(r=>r.status==='dup').length === 2,
      `dup=${again.filter(r=>r.status==='dup').length} 行数 ${before}→${after}`); }

// ===========================================================================
// TZ 组 · "今天"只有一个答案（071）
// ---------------------------------------------------------------------------
// 多帐套真库测试撞出来的：新帐套里管理员刚建好，登录成功，紧接着全 403。
// 原因是授权生效日写的是 current_date（会话时区 UTC = 11-14），
// 而权限判据算出的"今天"是 11-15 —— 差一天，授权"明天才生效"。
// 这一组把那条路径钉死，并且**故意把会话时区改成非业务时区**来测。
// ===========================================================================
{ // ★ SET 必须走 exec：PGlite 与 pg 的 query 都不接受一次多条语句
  //   （报 "cannot insert multiple commands into a prepared statement"）。
  await db.exec(`SET TIME ZONE 'UTC'`);
  const r = (await db.query(`SELECT app_today() d, current_date c, app_tz() tz`)).rows[0];
  rec('TZ1','会话时区是 UTC 时，app_today() 仍给业务时区（+08:00）的今天',
      r.tz === 'Asia/Shanghai'
      && r.d.toISOString().slice(0, 10) === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
      `app_today=${r.d.toISOString().slice(0,10)} current_date=${r.c.toISOString().slice(0,10)} tz=${r.tz}`);
}

{ // 边界：把业务时区改成 UTC-11，app_today 必须跟着变（证明读的是配置，不是写死 +08:00）
  await db.exec(`SET app.biz_tz = 'Pacific/Midway'`);
  const a = (await db.query(`SELECT app_today() d, app_tz() tz`)).rows[0];
  await db.exec(`RESET app.biz_tz`);
  const b = (await db.query(`SELECT app_today() d`)).rows[0];
  const expect = new Date(Date.now() - 11 * 3600e3).toISOString().slice(0, 10);
  rec('TZ2','业务时区是配置项：改成 UTC-11 之后 app_today() 跟着变，改回来又回 +08:00',
      a.tz === 'Pacific/Midway' && a.d.toISOString().slice(0, 10) === expect
      && b.d.toISOString().slice(0, 10) === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10),
      `-11=${a.d.toISOString().slice(0,10)} 恢复=${b.d.toISOString().slice(0,10)}`);
}

{ // 真正的那个洞：UTC 会话下建的账号，立刻能用（不是"明天才生效"）
  await db.exec(`SET TIME ZONE 'UTC'`);
  const uid = Number((await db.query(
    `SELECT fn_account_create('tzprobe','时区探针','group_hr',NULL,NULL,'tz') id`)).rows[0].id);
  const can = (await db.query(`SELECT fn_role_can($1,'payslip','read') c`, [uid])).rows[0].c;
  rec('TZ3','UTC 会话下新建的账号**立刻**有权限（授权生效日与判据同一个"今天"）',
      can === true, `账号 #${uid} 可读工资条=${can}`);
}

// ===========================================================================
// AC 组 · 副职代理（073）：主管设定、有起止、到期自动失效、不能代理出超管
// ---------------------------------------------------------------------------
// "副店长在店长不在时有店长权限" —— 这句话里"不在"是时间，"有"是权限。
// 所以它不是岗位（岗位没有时间），是一条**有窗口的授权**。
// 这一组逐条证明那四条规矩，特别是"到期自动失效**不靠定时任务**"：
// 如果靠定时任务，任务没跑就会一直代理着，而那个错不会有任何人报。
// ===========================================================================
await db.exec(`TRUNCATE pg_temp.tmp_scope_org; TRUNCATE pg_temp.tmp_scope_deny;`);

// ★ 账号 id 必须与前面种子的 user_id（1..4）错开：
//   否则新建的"副店长"恰好拿到 id=4，而 4 号在种子里已经被授了 legacy_role_4
//   （全资源可写），于是 AC1 会看到"副店长也能改编制" —— 那是**测试自己的污染**，
//   不是代理功能的问题。把序列推到 1000 再建，这条断言才在测它声称要测的东西。
await db.query(`SELECT setval(pg_get_serial_sequence('sys_account','id'),
                             GREATEST(COALESCE((SELECT max(id) FROM sys_account),0),1000), true)`);

// 造两个账号：主管（店长角色）与副手（副店长角色）
const mkUser = async (login, roleCode) => Number((await db.query(
  `SELECT fn_account_create($1,$1,$2,NULL,NULL,'ac') id`, [login, roleCode])).rows[0].id);
const uBoss  = await mkUser('ac_boss', 'store_mgr');
const uDep   = await mkUser('ac_dep', 'store_deputy');
const uOther = await mkUser('ac_other', 'store_staff');

{ // ★ 选 perf_cycle 而不是 headcount：店长可写绩效、副店长不可写 ——
  //   这正是"副的默认不是正的"那条边界；用 headcount 测不出来，因为**店长也没有**。
  const w = (await db.query(`SELECT fn_role_can($1,'perf_cycle','write') c`, [uDep])).rows[0].c;
  const r2 = (await db.query(`SELECT fn_role_can($1,'headcount','read') c`, [uDep])).rows[0].c;
  const roles = (await db.query(
    `SELECT string_agg(r.code, ',') c FROM fn_effective_roles($1, app_today()) e
       JOIN sys_role r ON r.id = e.role_id`, [uDep])).rows[0].c;
  rec('AC1','副店长**平时**没有店长权限（副的默认不是正的：编制调整不给、终审不给）',
      w === false && r2 === true,
      `副店长 perf写=${w} headcount读=${r2} 角色=${roles}`); }

{ const id = (await db.query(
    `SELECT fn_acting_grant_set($1,$2,'store_mgr',
       now() - interval '1 hour', now() + interval '7 days', $1, '店长出差，副手顶班') id`,
    [uBoss, uDep])).rows[0].id;
  const can = (await db.query(`SELECT fn_role_can($1,'perf_cycle','write') c`, [uDep])).rows[0].c;
  const vis = (await db.query(`SELECT count(*)::int n FROM v_acting_active WHERE id=$1`, [id])).rows[0].n;
  rec('AC2','窗口内：副店长拿到店长的写权限（绩效），且审计视角看得见这条代理',
      can === true && Number(vis) === 1, `写权限=${can} 生效中=${vis}`); }

{ // 到期自动失效：把同一条代理的窗口改成"昨天就结束了"
  await db.query(`UPDATE sys_acting_grant SET valid_from = now() - interval '10 days',
                   valid_to = now() - interval '9 days' WHERE principal_user=$1`, [uBoss]);
  const can = (await db.query(`SELECT fn_role_can($1,'perf_cycle','write') c`, [uDep])).rows[0].c;
  const vis = (await db.query(`SELECT count(*)::int n FROM v_acting_active WHERE agent_user=$1`, [uDep])).rows[0].n;
  rec('AC3','窗口外：同一账号立刻失去权限（靠时间窗判断，**不靠定时任务**）',
      can === false && Number(vis) === 0, `写权限=${can} 生效中=${vis}`);
  await db.query(`UPDATE sys_acting_grant SET valid_from = now() - interval '1 hour',
                   valid_to = now() + interval '7 days' WHERE principal_user=$1`, [uBoss]); }

{ let msg = '';
  try { await db.query(`SELECT fn_acting_grant_set($1,$2,'store_mgr', now(), now() + interval '1 day', $2, '我自己给自己开')`,
    [uBoss, uOther]); } catch (e) { msg = e.message; }
  rec('AC4','不是主管本人（也不是超管）→ 拒（E_ACTING_NOT_PRINCIPAL）：副手不能自己开代理',
      msg.includes('E_ACTING_NOT_PRINCIPAL'), String(msg).split('\n')[0].slice(0, 46)); }

{ let msg = '';
  try { await db.query(`SELECT fn_acting_grant_set($1,$2,'admin', now(), now() + interval '1 day', $1, '顺手把超管也给他')`,
    [uBoss, uDep]); } catch (e) { msg = e.message; }
  rec('AC5','想代理出自己没有的角色 / 超管 → 拒（权限提升防线：副手永远摸不到 admin）',
      msg.includes('E_ACTING_ROLE_NOT_HELD') || msg.includes('E_ACTING_SUPER'),
      String(msg).split('\n')[0].slice(0, 50)); }

{ // 重复设定同一对代理 → 被排他约束拒（074）：重复点"设定"不该变成两条授权
  let msg = '';
  try {
    await db.query(`SELECT fn_acting_grant_set($1,$2,'store_mgr',
      now() + interval '1 day', now() + interval '2 days', $1, '再设一次（应当被拒）')`,
      [uBoss, uDep]);
  } catch (e) { msg = e.message; }
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM v_acting_active WHERE agent_user=$1`, [uDep])).rows[0].n);
  rec('AC8','同一对（主管→副手）的有效代理区间不得重叠（并发点两次也只会有一条）',
      /ex_ag_no_overlap|conflicting key/i.test(msg) && n === 1,
      `${/overlap|conflicting/i.test(msg) ? '拒' : '未拒'} 生效中=${n}`); }

{ const id = (await db.query(
    `SELECT id FROM sys_acting_grant WHERE agent_user=$1 AND revoked_at IS NULL LIMIT 1`, [uDep])).rows[0].id;
  await db.query(`SELECT fn_acting_grant_revoke($1,$2)`, [id, uBoss]);
  const can = (await db.query(`SELECT fn_role_can($1,'perf_cycle','write') c`, [uDep])).rows[0].c;
  const row = (await db.query(`SELECT revoked_at, revoked_by FROM sys_acting_grant WHERE id=$1`, [id])).rows[0];
  rec('AC6','撤销即失效，且留痕不删行（revoked_by 记着是谁撤的）',
      can === false && row.revoked_at !== null && Number(row.revoked_by) === uBoss,
      `写权限=${can} 撤销人=${row.revoked_by}`); }

{ // 老板：全局**只读**（所有资源可读、零可写），但不是 admin（系统层）
  // ★ 176 起这条从"业务全权"改成"只读"：063 的描述一直是"不改数"，而 073 用
  //   CROSS JOIN 把写权限一次给全了（它晚于 063，所以 063 那句话一直是空话）。
  //   危害不是"老板算不了薪"，而是**他被拒的理由是错的** —— 实测他点算薪拿到
  //   409「批次已封账」，拦他的是封账闸不是权限；换一期没封账的他就真算了。
  // ★ 先幂等重放 176 里那条语句：前置组会改授权（只读/字段掩码那些用例），
  //   断言"迁移语句保证的结果"才不受执行顺序影响 —— 否则这条会时红时绿。
  await db.query(`INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
                  SELECT r.id, res.resource_code, true, false
                    FROM sys_role r CROSS JOIN sys_perm_resource res WHERE r.code='boss'
                  ON CONFLICT (role_id, resource_code) DO UPDATE
                     SET can_read = true, can_write = false`);
  const cov = (await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE rr.can_read)::int readable,
            count(*) FILTER (WHERE rr.can_write)::int writable
       FROM sys_perm_resource res
       LEFT JOIN sys_role r ON r.code='boss'
       LEFT JOIN sys_role_resource rr ON rr.role_id=r.id AND rr.resource_code=res.resource_code`)).rows[0];
  const superBoss = (await db.query(`SELECT is_super FROM sys_role WHERE code='boss'`)).rows[0].is_super;
  rec('AC7','老板 = 全业务**可读、零可写**，但**不是** super（系统层仍归 admin：两个能区分开）',
      Number(cov.readable) === Number(cov.total) && Number(cov.writable) === 0
      && superBoss === false,
      `${cov.readable}/${cov.total} 可读，${cov.writable}/${cov.total} 可写，is_super=${superBoss}`); }

// ===========================================================================
// ST 组 · 行闸起点用业务时区（077）
// ---------------------------------------------------------------------------
// 这一条是从"真库上老板登录看到 0 人"里长出来的。它的可贵之处是：
// 库里数据全在、权限配置全对、psql 里手敲全对 —— 只有**UTC 会话**下是 0 行。
// 所以断言必须显式把会话时区压成 UTC 再验，否则在 +08:00 的机器上永远绿。
// ===========================================================================
{ await db.exec(`SET TIME ZONE 'UTC'`);
  // 用刚建的那个账号（它今天被授权），在 UTC 会话下灌范围
  const uid = Number((await db.query(
    `SELECT id FROM sys_account WHERE login='tzprobe' ORDER BY id DESC LIMIT 1`)).rows[0]?.id || 0);
  await db.query(`SELECT app_begin_scope($1,'payslip',NULL)`, [uid]);
  const n = Number((await db.query('SELECT count(*)::int n FROM pg_temp.tmp_scope_org')).rows[0].n);
  rec('ST1','UTC 会话下 app_begin_scope 仍灌得出范围（不是 0 行）',
      n > 0, `账号 #${uid} 灌出 ${n} 个组织`);
}

{ // 反例：把授权挪到"昨天之前就已生效"，再用 071 之前的口径对照 —— 证明差异来自日界
  const rows = (await db.query(
    `SELECT count(*)::int n FROM fn_effective_roles(
        (SELECT id FROM sys_account WHERE login='tzprobe' ORDER BY id DESC LIMIT 1), app_today())`)).rows[0].n;
  rec('ST2','同一账号用 app_today() 有角色（说明"0 行"不是没授权，是日界选错了）',
      rows > 0, `有效角色 ${rows} 条`);
}

// ===========================================================================
// TZB 组 · 业务时区是配置项（079）
// ---------------------------------------------------------------------------
// "服务器在 UTC、客户在 +08:00" 不是网络问题，是"用谁的时钟算业务日"的问题。
// 这一组证明三层优先级真的成立，而且时区名写错时**发布那一刻**就拒，
// 不是等到某天算薪才发现"这个月的天数不对"。
// ===========================================================================
{ const t0 = (await db.query('SELECT app_tz() t')).rows[0].t;
  rec('TZB1','默认业务时区 = Asia/Shanghai（与 071 的写死值一致，不改变既有行为）',
      t0 === 'Asia/Shanghai', t0); }

{ // GUC 优先：单次脚本/测试可以临时按别的时区跑
  await db.exec(`SET app.biz_tz = 'Asia/Hong_Kong'`);
  const t1 = (await db.query('SELECT app_tz() t, app_today() d')).rows[0];
  await db.exec(`RESET app.biz_tz`);
  const t2 = (await db.query('SELECT app_tz() t')).rows[0].t;
  rec('TZB2','会话级 GUC 压过制度项（SET LOCAL 不会漏到别的连接）',
      t1.t === 'Asia/Hong_Kong' && t2 === 'Asia/Shanghai', `${t1.t} → 复位后 ${t2}`); }

{ // 立即生效：时区不是"明天生效的政策"，是"现在按哪个时钟"
  // ★ 断言原来测的是"明天起按 UTC"，而 081 之后这一项**没有明天**的概念 ——
  //   给它加"生效日"就会自引用（用今天判断"今天由谁决定"）。
  // 与发布接口同一套逻辑：这一项只保留一条（否则切回时会写进另一天，见 081 注释）
  await db.query(`DELETE FROM policy_value WHERE policy_code = 'BIZ_TIMEZONE'`);
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
                  VALUES ('BIZ_TIMEZONE', app_today(), 'UTC', 'group_hr', '切到 UTC 看今天变不变')`);
  const t1 = (await db.query('SELECT app_tz() t')).rows[0].t;
  await db.query(`DELETE FROM policy_value WHERE policy_code = 'BIZ_TIMEZONE'`);
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
                  VALUES ('BIZ_TIMEZONE', app_today(), 'Asia/Shanghai', 'group_hr', '切回中国时区')`);
  const t2 = (await db.query('SELECT app_tz() t')).rows[0].t;
  rec('TZB3','时区改了**当场**生效（不等明天）：UTC → Asia/Shanghai 立即切换',
      t1 === 'UTC' && t2 === 'Asia/Shanghai', `${t1} → ${t2}`);
}

{ // 不追溯：已落库的打卡日期不因为改时区而搬家
  const before = (await db.query(
    `SELECT count(*)::int n FROM punch WHERE (punch_at AT TIME ZONE 'Asia/Shanghai')::date = DATE '2026-11-15'`)).rows[0].n;
  await db.query(`DELETE FROM policy_value WHERE policy_code = 'BIZ_TIMEZONE'`);
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
                  VALUES ('BIZ_TIMEZONE', app_today(), 'UTC', 'group_hr', '再切一次验证历史不搬家')`);
  const after = (await db.query(
    `SELECT count(*)::int n FROM punch WHERE (punch_at AT TIME ZONE 'Asia/Shanghai')::date = DATE '2026-11-15'`)).rows[0].n;
  await db.query(`DELETE FROM policy_value WHERE policy_code = 'BIZ_TIMEZONE'`);
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_text, published_by, reason)
                  VALUES ('BIZ_TIMEZONE', app_today(), 'Asia/Shanghai', 'group_hr', '验证完切回')`);
  rec('TZB5','改时区不追溯：已经落库的打卡日期不搬家（它落表时就带着具体日期）',
      before === after, `${before} → ${after}`);
}

{ // 写错时区名必须在发布时就拒
  let msg = '';
  try { await db.query(`SELECT fn_biz_timezone_check('Asia/Shanghia')`); } catch (e) { msg = e.message; }
  // ★ void 函数不返回 NULL：`IS NULL` 恒为 false，会把"正确时区"误判成"被拒"。
  //   要用"抛没抛错"来判断。
  let okMsg = '';
  try { await db.query(`SELECT fn_biz_timezone_check('Asia/Hong_Kong')`); }
  catch (e) { okMsg = e.message; }
  rec('TZB4','时区名写错在发布时就拒（打错一个字母在算薪时才发现，代价是这个月的账）',
      msg.includes('E_TZ_UNKNOWN') && okMsg === '',
      `打错=${msg ? '拒' : '未拒'} / 正确时区=${okMsg === '' ? '过' : '拒'}`);
}

// ===========================================================================
// PS 组 · 岗位（083）：一人可多岗、同岗不重叠、岗位不自动授权
// ---------------------------------------------------------------------------
// 岗位与权限角色是两件事。这一组守的是那条边界：**设了岗位不该等于给了权限**。
// 如果哪天有人图省事把"岗位 → 角色"硬连起来，PS3 会红 —— 那正是它存在的理由。
// ===========================================================================
const posOrg = (await db.query(`SELECT id FROM org_unit WHERE parent_id IS NULL LIMIT 1`)).rows[0].id;
const p1 = Number((await db.query(`SELECT fn_position_upsert('T_MGR','测试主管',$1::bigint,1::smallint,false,'测试') id`,
  [posOrg])).rows[0].id);
const p2 = Number((await db.query(`SELECT fn_position_upsert('T_STAFF','测试专员',$1::bigint,2::smallint,false,'测试') id`,
  [posOrg])).rows[0].id);
const tPerson = Number((await db.query(`SELECT fn_person_create('岗位测试甲') id`)).rows[0].id);
await db.query(`INSERT INTO employment(person_id, legal_entity_id, hire_date)
                VALUES ($1,1,app_today())`, [tPerson]);

{ // 一人两岗：两条都有效
  await db.query(`SELECT fn_position_assign($1,$2,app_today(),'test')`, [tPerson, p1]);
  await db.query(`SELECT fn_position_assign($1,$2,app_today(),'test')`, [tPerson, p2]);
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM person_position
      WHERE person_id=$1 AND daterange(valid_from, valid_to, '[]') @> app_today()`, [tPerson])).rows[0].n);
  rec('PS1','一人可多岗：同一人在两个岗位上各有一条有效任职（不是只留一个）',
      n === 2, `${n} 条有效任职`);
}

{ // 同一岗位重复任职 → 被排他约束拒
  let msg = '';
  try {
    await db.query(`INSERT INTO person_position(person_id, position_id, valid_from)
                    VALUES ($1,$2,app_today())`, [tPerson, p1]);
  } catch (e) { msg = e.message; }
  rec('PS2','同一人同一岗位不得有重叠任职（重复点"任职"不会变成两条）',
      /ex_pp_no_overlap|conflicting key/i.test(msg), msg ? '拒' : '未拒');
}

{ // 岗位不自动授权：授了"测试主管"这个岗位，权限一点没变
  const before = (await db.query(`SELECT fn_role_can($1,'payslip','read') c`, [tPerson])).rows[0].c;
  rec('PS3','岗位不自动授权限：有岗位 ≠ 有角色（设岗是一次组织动作，不是提权）',
      before === false, `读工资条=${before}`);
}

{ // 部门视角的岗位清单：含在岗人数与人名
  const rows = (await db.query(
    `SELECT * FROM fn_position_list(NULL, app_today()) WHERE code IN ('T_MGR','T_STAFF')`)).rows;
  const staff = rows.find(r => r.code === 'T_STAFF');
  rec('PS4','岗位清单给得出"在岗几人、谁在岗"（组织页按岗位看的就是这份）',
      rows.length === 2 && Number(staff?.holders) === 1
      && String(staff?.holder_names || '').includes('岗位测试甲'),
      rows.map(r => `${r.name}:${r.holders}`).join(' '));
}

// ===========================================================================
// SL 组 · 工资表：结构拆分 / 提成计税 / 报销不进工资条
// ---------------------------------------------------------------------------
// 用 P 组的同一份任职（employment 40 / person 10 / 月薪 8000），
// 但另开一期（2026-07）——不去动 2026-04 那张已经立住的工资条。
// ===========================================================================
const ST_EMP = 40, ST_PERSON = 10, ST_PERIOD = '2026-07';

{ // 结构合计 ≠ 月薪总额 → 拒。不做"按比例缩放"：缩了用户以为设的是 8000，发出来却是别的数
  let msg = '';
  try {
    await db.query(`SELECT fn_salary_structure_set($1,$2,$3::jsonb)`,
      [ST_EMP, '2026-07-01', JSON.stringify([{ item_code: 'BASE', amount: 7000 }])]);
  } catch (e) { msg = e.message; }
  rec('SL1', '工资结构各项之和 ≠ 月薪总额 → E_SS_SUM（不按比例缩放）',
      /E_SS_SUM/.test(msg), msg.split('\n')[0].slice(0, 60));
}

{ // 把"算出来的"项（个税）拆进结构 → 拒
  const pid = (await db.query(`SELECT id FROM position WHERE code='T_STAFF'`)).rows[0]?.id;
  void pid;
  let msg = '';
  try {
    await db.query(`SELECT fn_salary_structure_set($1,$2,$3::jsonb)`,
      [ST_EMP, '2026-07-01', JSON.stringify([
        { item_code: 'BASE', amount: 7000 }, { item_code: 'IIT', amount: 1000 }])]);
  } catch (e) { msg = e.message; }
  rec('SL2', '只允许拆固定项：把个税（算出来的）拆进结构 → E_SS_ITEM',
      /E_SS_ITEM/.test(msg), msg.split('\n')[0].slice(0, 60));
}

{ // 正确的结构：6000 + 1500 + 500 = 8000
  const total = Number((await db.query(`SELECT fn_salary_structure_set($1,$2,$3::jsonb) t`,
    [ST_EMP, '2026-07-01', JSON.stringify([
      { item_code: 'BASE', amount: 6000 },
      { item_code: 'POST_ALLOW', amount: 1500 },
      { item_code: 'MEAL', amount: 500 }])])).rows[0].t);
  const rows = (await db.query(
    `SELECT * FROM fn_salary_structure_of($1, '2026-07-31'::date)`, [ST_EMP])).rows;
  rec('SL3', '工资结构：基本 6000 + 岗位津贴 1500 + 餐补 500 = 月薪 8000（合计对得上才让存）',
      Math.abs(total - 8000) < 0.005 && rows.length === 3
      && Math.abs(rows.reduce((a, r) => a + Number(r.amount), 0) - 8000) < 0.005,
      `合计=${total} 行=${rows.map(r => r.item_code).join('+')}`);
}

// 开一期新批次
const stRun = Number((await db.query(
  `INSERT INTO pay_run(period,legal_entity_id,status) VALUES ($1,1,'draft') RETURNING id`,
  [ST_PERIOD])).rows[0].id);
await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
const stSlip = async () => (await db.query(
  `SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`, [stRun, ST_PERSON])).rows[0];
const stItems = async () => (await db.query(
  `SELECT item_code, amount FROM payslip_item
    WHERE payslip_id = (SELECT id FROM payslip WHERE pay_run_id=$1 AND employee_id=$2)
    ORDER BY item_code`, [stRun, ST_PERSON])).rows;

{ // 明细按结构拆，且拆完总额不变
  const items = await stItems();
  const base = items.find(x => x.item_code === 'BASE');
  // 社保从 105 起是分险种的（SI_PENSION/SI_MEDICAL/…），排除要按前缀
  const sum = items.filter(x => !/^(SI_|IIT|LEAVE_DEDUCT)/.test(x.item_code))
    .reduce((a, x) => a + Number(x.amount), 0);
  const slip = await stSlip();
  rec('SL4', '工资条按结构拆成多行，拆完应发仍是 8000（拆分不改金额）',
      items.length === 5 && Math.abs(Number(base?.amount) - 6000) < 0.005
      && Math.abs(sum - 8000) < 0.005 && Math.abs(Number(slip.gross_amount) - 8000) < 0.005,
      items.map(x => `${x.item_code}=${x.amount}`).join(' '));
}

{ // 勾稽视图必须仍然为空：拆分之后"明细和 = 应发 − 社保 − 个税"还得成立
  const bad = (await db.query(`SELECT count(*)::int n FROM v_payslip_consistency`)).rows[0].n;
  rec('SL5', '拆明细之后勾稽仍成立（v_payslip_consistency 为空）', bad === 0, `不一致 ${bad} 条`);
}

{ // 提成：计入应发、参与计税、单独一行
  const before = await stSlip();
  await db.query(`INSERT INTO commission_record(person_id, period, amount, basis, status, created_by)
                  VALUES ($1,$2,2000,'7月销售提成（3 单）','approved','test')`, [ST_PERSON, ST_PERIOD]);
  await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
  const after = await stSlip();
  const items = await stItems();
  const comm = items.find(x => x.item_code === 'COMMISSION');
  rec('SL6', '提成计入应发并计税：应发 +2000、明细多一行 COMMISSION、个税跟着涨',
      Math.abs(Number(after.gross_amount) - Number(before.gross_amount) - 2000) < 0.005
      && Math.abs(Number(comm?.amount) - 2000) < 0.005
      && Number(after.tax_amount) > Number(before.tax_amount),
      `应发 ${before.gross_amount}→${after.gross_amount} 税 ${before.tax_amount}→${after.tax_amount}`);
}

{ // 报销：不进应发、不进明细
  const before = await stSlip();
  // 110 起：有结论就必须有结论人（approved_by），否则 ck_ec_trace 会拒
  await db.query(`INSERT INTO expense_claim(person_id, period, category, amount, status, created_by, approved_by, approved_at)
                  VALUES ($1,$2,'差旅',300,'approved','test','test',now())`, [ST_PERSON, ST_PERIOD]);
  await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
  const after = await stSlip();
  const items = await stItems();
  rec('SL7', '报销不是工资：不进应发、不计税、不进工资条明细',
      Math.abs(Number(after.gross_amount) - Number(before.gross_amount)) < 0.005
      && !items.some(x => /EXPENSE/.test(x.item_code))
      && Math.abs(Number((await db.query(
           `SELECT fn_expense_amount($1,$2) a`, [ST_PERSON, ST_PERIOD])).rows[0].a) - 300) < 0.005,
      `应发 ${before.gross_amount}→${after.gross_amount} 报销另计=300`);
}

{ // 月计薪天数改成 20 → 事假扣款真的跟着变（改配置行为就变，不是只登记）
  // ★ 制度必须插在**期间内**（2026-04-01），不能插在 app_today()：
  //   fn_leave_deduction 从 111 起按本期期末取制度（原来的 app_today() 是错的 ——
  //   补一条"今天起生效"的制度，去算三个月前的工资会用上新制度，
  //   而制度带 effective_from 就是为了不让这件事发生）。
  const anchor = '2026-04-01';
  await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
                  VALUES ('PAY_DAYS_PER_MONTH',$1,20,'test','反例：验证制度改了扣款真的跟着变')
                  ON CONFLICT (policy_code, effective_from) DO UPDATE SET value_num = 20`,
    [anchor]);
  const at20 = Number((await db.query(`SELECT fn_leave_deduction($1,'2026-04') d`,
    [ST_PERSON])).rows[0].d);
  await db.query(`UPDATE policy_value SET value_num = 21.75
                   WHERE policy_code='PAY_DAYS_PER_MONTH' AND effective_from = $1`, [anchor]);
  const back = Number((await db.query(`SELECT fn_leave_deduction($1,'2026-04') d`,
    [ST_PERSON])).rows[0].d);
  rec('SL8', '月计薪天数改成 20 → 2 天事假扣款 800（原 21.75 → 735.63），改回即复原',
      Math.abs(at20 - 800) < 0.02 && Math.abs(back - 735.63) < 0.02,
      `20天=${at20} 21.75天=${back}`);
}

// ===========================================================================
// SL 组（续）· 工资公式语言：条件、折算、封顶、白名单、注释符
// ===========================================================================
const fEval = async (f, vars = {}) => Number((await db.query(
  `SELECT fn_formula_eval($1,$2::jsonb) v`, [f, JSON.stringify(vars)])).rows[0].v);
const fTry = async (f) => (await db.query(
  `SELECT fn_formula_try($1,'{}'::jsonb) e`, [f])).rows[0].e;

{ // if：条件成立走真值
  const a = await fEval('if(MONTHLY >= 10000, 500, 200)', { MONTHLY: 13000 });
  const b = await fEval('if(MONTHLY >= 20000, 500, 200)', { MONTHLY: 13000 });
  rec('SL9', 'if(条件,真值,假值)：13000 走 500，门槛 20000 时走 200',
      a === 500 && b === 200, `${a} / ${b}`);
}

{ // prorata：按出勤折算；应出为 0 时不折算（除零会让整条工资变 NULL）
  const a = await fEval('prorata(600, 15, 21.75)');
  const b = await fEval('prorata(600, 15, 0)');
  rec('SL10', 'prorata(金额,实际,应出) 折算；应出为 0 时不折算而不是 NULL',
      Math.abs(a - 413.79) < 0.02 && b === 600, `${a} / 应出0=${b}`);
}

{ // 注释符必须拒：`-` 是合法运算符，1--2 会被 PG 当注释，公式静默变 1
  const e1 = await fTry('1--2');
  const e2 = await fTry('/* x */ 1');
  rec('SL11', '注释符 -- 与 /* */ 被拒（否则公式静默被吞掉一半）',
      /E_FORMULA_CHAR/.test(String(e1)) && /E_FORMULA_CHAR/.test(String(e2)),
      String(e1).slice(0, 40));
}

{ // 未知函数必须拒：pg_sleep(60) 不能当成"函数"跑起来
  const e = await fTry('pg_sleep(60)');
  const e2 = await fTry('BASE;DROP TABLE x');
  rec('SL12', '未知函数与分号注入都被拒（pg_sleep / ; 不是"表达式"）',
      /E_FORMULA_FUNC/.test(String(e)) && /E_FORMULA_CHAR/.test(String(e2)),
      String(e).slice(0, 40));
}

{ // min/max 是聚合函数，必须编译成 LEAST/GREATEST
  const a = await fEval('min(COMMISSION, 5000)', { COMMISSION: 8000 });
  const b = await fEval('max(COMMISSION, 5000)', { COMMISSION: 1000 });
  rec('SL13', 'min/max 编译成 LEAST/GREATEST（PG 的 min 是聚合函数，两参会报错）',
      a === 5000 && b === 5000, `${a} / ${b}`);
}

{ // 公式项参与算薪：加一项 FULL_TEST = POST_ALLOW*0.1，应发应 +300
  await db.query(`INSERT INTO salary_item(code,name,item_kind,formula,sort_order)
                  VALUES ('FULL_TEST','全勤测试','formula','POST_ALLOW*0.1',50)
                  ON CONFLICT (code) DO UPDATE SET formula=EXCLUDED.formula, is_active=true`);
  const before = Number((await db.query(
    `SELECT gross_amount g FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
    [stRun, ST_PERSON])).rows[0].g);
  await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
  const after = Number((await db.query(
    `SELECT gross_amount g FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
    [stRun, ST_PERSON])).rows[0].g);
  const line = (await db.query(
    `SELECT amount FROM payslip_item WHERE item_code='FULL_TEST'
       AND payslip_id=(SELECT id FROM payslip WHERE pay_run_id=$1 AND employee_id=$2)`,
    [stRun, ST_PERSON])).rows[0];
  // 这个人的岗位津贴是 1500（ST3 设的结构），所以 FULL_TEST = 1500×0.1 = 150
  rec('SL14', '公式项参与算薪：应发 +150（岗位津贴×10%），工资条上多一行（公式项是加项）',
      Math.abs(after - before - 150) < 0.02 && Math.abs(Number(line?.amount) - 150) < 0.02,
      `应发 ${before}→${after} 明细=${line?.amount}`);
  await db.query(`UPDATE salary_item SET is_active=false WHERE code='FULL_TEST'`);
  await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
}

// ===========================================================================
// SL 组（续）· 脚本公式与计算规则
// ===========================================================================
{ // 多行脚本：中间变量 + 条件 + return
  const v = Number((await db.query(
    `SELECT fn_formula_script_eval($1,$2::jsonb) v`,
    [`d = PRESENT_DAYS
full = if(d >= 21, 1, 0)
bonus = POST_ALLOW * 0.1
return bonus * full`,
     JSON.stringify({ PRESENT_DAYS: 21, POST_ALLOW: 3000 })])).rows[0].v);
  rec('SL15', '多行脚本：中间变量 + if + return（3000×10%×1 = 300）',
      Math.abs(v - 300) < 0.02, String(v));
}

{ // 没有结果必须报错，不能静默给 0
  let msg = '';
  try {
    await db.query(`SELECT fn_formula_script_eval($1,'{}'::jsonb)`,
      ['a = 1\nb = 2']);
  } catch (e) { msg = e.message; }
  rec('SL16', '脚本没给结果 → E_SCRIPT_NO_RESULT（不静默返回 0）',
      /E_SCRIPT_NO_RESULT/.test(msg), msg.split('\n')[0].slice(0, 50));
}

{ // 中间变量不能与已登记项目同名（否则"读项"和"写变量"混成一个名字）
  const e = (await db.query(`SELECT fn_formula_script_try($1,'{"BASE":1}'::jsonb) e`,
    ['BASE = 1\nreturn BASE'])).rows[0].e;
  rec('SL17', '中间变量与工资项同名 → 拒（读项与写变量不能共用一个名字）',
      /E_SCRIPT_NAME/.test(String(e)), String(e).slice(0, 50));
}

{ // before 规则：命中返回 block 项；规则自身写错也返回 block（坏规则不放行）
  await db.query(`INSERT INTO salary_rule(code,name,stage,formula,action,message,created_by,sort_order)
                  VALUES ('T_BLOCK','测试拦截','before','if(GROSS > 1000, 1, 0)','block',
                          '应发超过 1000 需要人工复核','test',10)
                  ON CONFLICT (code) DO UPDATE SET is_active = true, formula = EXCLUDED.formula`);
  const hit = (await db.query(
    `SELECT * FROM fn_salary_rule_run('before','{"GROSS":5000}'::jsonb)`)).rows;
  const pass = (await db.query(
    `SELECT * FROM fn_salary_rule_run('before','{"GROSS":500}'::jsonb)`)).rows;

  await db.query(`UPDATE salary_rule SET formula='NOSUCHFUNC(1)' WHERE code='T_BLOCK'`);
  const broke = (await db.query(
    `SELECT * FROM fn_salary_rule_run('before','{"GROSS":500}'::jsonb)`)).rows;

  await db.query(`UPDATE salary_rule SET is_active=false WHERE code='T_BLOCK'`);
  rec('SL18', '规则命中给出 block 项；不命中不返回；规则自身写错也按 block（坏规则不放行）',
      hit.length === 1 && hit[0].rule_action === 'block' && pass.length === 0
      && broke.length === 1 && broke[0].rule_action === 'block',
      `命中=${hit.length} 未命中=${pass.length} 坏规则=${broke[0]?.rule_action}`);
}

{ // after warn 规则：命中给 warn 项（不是 block），算薪照常完成
  await db.query(`INSERT INTO salary_rule(code,name,stage,formula,action,message,created_by,sort_order)
                  VALUES ('T_WARN','测试告警','after','if(NET > 0, 1, 0)','warn',
                          '实发大于 0 仅作提示','test',20)
                  ON CONFLICT (code) DO UPDATE SET is_active = true, formula = EXCLUDED.formula`);
  const hits = (await db.query(
    `SELECT * FROM fn_salary_rule_run('after','{"NET":11751.20}'::jsonb)`)).rows
    .filter(h => h.rule_code === 'T_WARN');
  const n = Number((await db.query(`SELECT fn_payroll_calc($1) n`, [stRun])).rows[0].n);
  await db.query(`UPDATE salary_rule SET is_active=false WHERE code='T_WARN'`);
  rec('SL19', 'after+warn 规则命中给 warn（不拦），算薪照常完成',
      hits.length === 1 && hits[0].rule_action === 'warn' && n > 0,
      `命中=${hits.length} 动作=${hits[0]?.rule_action} 算薪人数=${n}`);
}

// ===========================================================================
// ATV 组 · 考勤口径进工资（102/103）
// ===========================================================================
{
  // 造一天考勤人日：10:00–19:00，在岗 9 小时（其中 0 休息），按 hourly 口径 work=在岗
  await db.query(`INSERT INTO attendance_daily_store
      (employee_id, store_id, work_date, shift_start_at, shift_end_at,
       span_hours, on_duty_hours, off_duty_hours, break_on_duty_hours,
       in_attendance_hours, work_hours, snap_on_duty_break_basis)
    VALUES ($1, 1, '2026-06-02'::date,
            '2026-06-02 10:00+08'::timestamptz, '2026-06-02 19:00+08'::timestamptz,
            9, 9, 0, 0, 9, 9, 'hourly')
    ON CONFLICT DO NOTHING`, [ST_PERSON]);

  const a = (await db.query(`SELECT * FROM fn_att_person_period($1,'2026-06')`,
    [ST_PERSON])).rows[0];
  // 应出勤 = 当月日历工作日：2026-06 有 22 个周一至周五，扣掉端午 6/19（周五）→ 21 天。
  // （125 之前没灌端午，所以这里曾是 22 —— 这个数字变化本身就是"节假日数据生效了"的证据）
  rec('ATV1', '出勤口径：出勤 1 天、工时 9h、加班 1h、应出勤=6 月日历工作日 21 天（扣端午）',
      Number(a.present_days) === 1 && Number(a.work_hours) === 9
      && Number(a.ot_hours) === 1 && Number(a.work_days) === 21
      && a.workdays_source === 'calendar',
      `出勤=${a.present_days} 工时=${a.work_hours} 加班=${a.ot_hours} `
      + `应出=${a.work_days}(${a.workdays_source})`);
}

{
  // 请假天数与事假扣款同源（person 10 在 2026-04 有 2 天已批准事假）
  const a = (await db.query(`SELECT * FROM fn_att_person_period($1,'2026-04')`,
    [ST_PERSON])).rows[0];
  rec('ATV2', '请假天数与事假扣款同一来源（2026-04 的 2 天事假）',
      Math.abs(Number(a.leave_days) - 2) < 0.01, `请假=${a.leave_days} 天`);
}

{
  // 公式里用真实出勤天数：prorata(600, PRESENT_DAYS, WORK_DAYS) 不再恒等于 600
  const v = Number((await db.query(
    // ★ 变量名必须显式大写：jsonb 的 key 是大小写敏感的，
    //   直接把 to_jsonb(record) 传进去得到的是 present_days，公式里写的是 PRESENT_DAYS。
    `SELECT fn_formula_eval('prorata(600, PRESENT_DAYS, WORK_DAYS)',
       (SELECT jsonb_build_object('PRESENT_DAYS', a.present_days,
                                  'WORK_DAYS', a.work_days)
          FROM fn_att_person_period($1,'2026-06') a)) v`,
    [ST_PERSON])).rows[0].v);
  rec('ATV3', '公式里 PRESENT_DAYS/WORK_DAYS 是真值：600×1/21 = 28.57（不再恒等 600）',
      Math.abs(v - 28.57) < 0.05, String(v));
}

// ===========================================================================
// SI 组 · 多险种社保与专项附加扣除（104/105）
// ===========================================================================
{ // 加医疗 2% + 失业 0.5% + 公积金 7% 三条政策后，算薪要按险种拆行
  // ★ si_policy.id 不是 identity（老表），每条都要显式给 id；
  //   三条写进一条语句会算出同一个 max(id) → 主键冲突。
  for (const [item, emp, er] of [['medical', 0.02, 0.095], ['unemployment', 0.005, 0.005],
                                  ['housing_fund', 0.07, 0.07]]) {
    await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                      rate_employee,rate_employer)
                    SELECT COALESCE(max(id),0)+1,'上海',$1,'2026-01-01',7384,36921,$2,$3
                      FROM si_policy
                    ON CONFLICT DO NOTHING`, [item, emp, er]);
  }
  await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
  const slip = (await db.query(
    `SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`, [stRun, ST_PERSON])).rows[0];
  const lines = (await db.query(
    `SELECT item_code, amount FROM payslip_item
      WHERE payslip_id=$1 AND item_code LIKE 'SI_%' ORDER BY item_code`, [slip.id])).rows;
  const sumIns = lines.reduce((a, x) => a + Math.abs(Number(x.amount)), 0);
  rec('SI1', '多险种：养老/医疗/失业/公积金各一行明细，合计等于 si_employee',
      lines.length === 4 && Math.abs(sumIns - Number(slip.si_employee)) < 0.02
      && Math.abs(Number(slip.si_employee) - (8000 * (0.08 + 0.02 + 0.005 + 0.07))) < 0.02,
      `明细分项=${lines.map(x => x.item_code.replace('SI_', '')).join('+')} 合计=${slip.si_employee}`);
}

{ // 专项附加扣除：只减计税基数（应发与实发的变化必须只来自个税）
  const before = (await db.query(
    `SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`, [stRun, ST_PERSON])).rows[0];
  await db.query(`INSERT INTO tax_deduction(person_id, kind, monthly_amount, valid_from, note)
                  VALUES ($1,'child_edu',2000,'2026-01-01','测试：子女教育')`,
    [ST_PERSON]);
  await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
  const after = (await db.query(
    `SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`, [stRun, ST_PERSON])).rows[0];
  await db.query(`DELETE FROM tax_deduction WHERE person_id=$1 AND kind='child_edu'`, [ST_PERSON]);

  rec('SI2', '专项附加扣除只减计税基数：应发不变、个税下降、扣了 2000 的扣除额',
      Math.abs(Number(after.gross_amount) - Number(before.gross_amount)) < 0.005
      && Number(after.tax_amount) < Number(before.tax_amount)
      && Math.abs(Number(after.special_deduction) - 2000) < 0.005,
      `应发 ${before.gross_amount}→${after.gross_amount} 税 ${before.tax_amount}→${after.tax_amount}`);
}

{ // 养老政策缺失必须报错（其余险种缺省可以跳过，养老不行）
  await db.query(`DELETE FROM si_policy WHERE item='pension' AND city='上海'`);
  let msg = '';
  try { await db.query(`SELECT fn_payroll_calc($1)`, [stRun]); }
  catch (e) { msg = e.message; }
  await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                    rate_employee,rate_employer)
                  SELECT COALESCE(max(id),0)+1,'上海','pension','2026-01-01',7384,36921,0.08,0.16
                    FROM si_policy`);
  await db.query(`SELECT fn_payroll_calc($1)`, [stRun]);
  rec('SI3', '养老政策缺失 → E_SI_POLICY_MISSING（缺其他险种可以跳过，养老不行）',
      /E_SI_POLICY_MISSING/.test(msg), msg.split('\n')[0].slice(0, 60));
}

// ===========================================================================
// SAL 组 · 工资调整单（106/107）
// ===========================================================================
{ // 建单：before/after 快照 + 差额；只允许拆固定项
  const before = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=$1
      ORDER BY effective_from DESC LIMIT 1`, [ST_EMP])).rows[0].m);
  const code = (await db.query(
    `SELECT fn_salary_adjust_create($1,'2026-08',$2::jsonb,'测试调薪，验证快照','manual','test') c`,
    [ST_PERSON, JSON.stringify([
      { item_code: 'BASE', amount: 6500 }, { item_code: 'POST_ALLOW', amount: 1500 },
      { item_code: 'MEAL', amount: 500 }])])).rows[0].c;
  const a = (await db.query(`SELECT * FROM salary_adjustment WHERE code=$1`, [code])).rows[0];

  let badMsg = '';
  try {
    await db.query(`SELECT fn_salary_adjust_create($1,'2026-08',$2::jsonb,'测试：拆个税','manual','test')`,
      [ST_PERSON, JSON.stringify([{ item_code: 'IIT', amount: 100 }])]);
  } catch (e) { badMsg = e.message; }

  rec('SAL1', '调整单留 before/after 快照与差额；只能拆固定项（个税不行）',
      Number(a.before_monthly) === before && Number(a.after_monthly) === 8500
      && Number(a.delta) === 8500 - before && a.status === 'draft'
      && JSON.stringify(a.before_items).includes('BASE') && /E_SS_ITEM/.test(badMsg),
      `before=${a.before_monthly} after=${a.after_monthly} delta=${a.delta} status=${a.status} `
      + `items=${JSON.stringify(a.before_items).slice(0, 60)} bad=${String(badMsg).slice(0, 40)}`);
}

{ // 应用：写月薪与结构；再应用同一张必须被拒（历史解释不能被改）
  const code = (await db.query(
    `SELECT code FROM salary_adjustment WHERE period='2026-08' AND person_id=$1
      ORDER BY id DESC LIMIT 1`, [ST_PERSON])).rows[0].code;
  const amt = Number((await db.query(`SELECT fn_salary_adjust_apply($1,'test') a`, [code])).rows[0].a);
  const std = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=$1
      AND effective_from='2026-08-01'::date`, [ST_EMP])).rows[0].m);
  const items = (await db.query(`SELECT * FROM fn_salary_structure_of($1,'2026-08-31'::date)`,
    [ST_EMP])).rows;

  let again = '';
  try { await db.query(`SELECT fn_salary_adjust_apply($1,'test')`, [code]); }
  catch (e) { again = e.message; }

  rec('SAL2', '应用后月薪/结构同步生效；同一张单再应用被拒（E_ADJ_NOT_DRAFT）',
      amt === 8500 && std === 8500
      && Math.abs(items.reduce((x, y) => x + Number(y.amount), 0) - 8500) < 0.01
      && /E_ADJ_NOT_DRAFT/.test(again),
      `月薪=${std} 结构=${items.length} 项 再应用=${again.split(':')[0]}`);
}

{ // 期间口径：08 月的调整不会被 07 月读到（月末在职判断，月初生效）
  const july = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=$1
      AND effective_from='2026-07-01'::date`, [ST_EMP])).rows[0]?.m ?? 0);
  rec('SAL3', '调整只影响本期及以后：2026-07 的月薪标准没有被 08 月的调整改掉',
      july !== 8500, `07月=${july} 08月=8500`);
}

// ===========================================================================
// AB 组 · 年终奖单独计税（108）
// ===========================================================================
{ // 24000 ÷ 12 = 2000 → 3% → 720
  const tax = Number((await db.query(`SELECT fn_iit_bonus(24000) t`)).rows[0].t);
  rec('AB1', '年终奖计税：24000÷12=2000 落在 3% 档 → 税 720（不是按月度累计）',
      Math.abs(tax - 720) < 0.01, String(tax));
}

{ // 36000 ÷ 12 = 3000（仍 3%）；36001 ÷ 12 = 3000.08 → 10%，税额跳档
  const a = Number((await db.query(`SELECT fn_iit_bonus(36000) t`)).rows[0].t);
  const b = Number((await db.query(`SELECT fn_iit_bonus(36001) t`)).rows[0].t);
  rec('AB2', '临界点：36000 → 1080（3%）；36001 → 3390.1（10% 跳档，多 1 元多缴 2310）',
      Math.abs(a - 1080) < 0.01 && Math.abs(b - 3390.1) < 0.01, `${a} / ${b}`);
}

{ // 单独批次：社保为 0、明细两行、勾稽仍成立、月度批次不受影响
  await db.query(`INSERT INTO annual_bonus(person_id, year, amount, note, created_by)
                  VALUES ($1, 2026, 24000, '测试年终奖', 'test')
                  ON CONFLICT (person_id, year) DO UPDATE SET amount = EXCLUDED.amount`,
    [ST_PERSON]);
  const runId = Number((await db.query(
    `INSERT INTO pay_run(period, legal_entity_id, kind) VALUES ('2026-12',1,'bonus') RETURNING id`
  )).rows[0].id);
  const n = Number((await db.query(`SELECT fn_payroll_bonus_calc($1) n`, [runId])).rows[0].n);
  const slip = (await db.query(
    `SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`, [runId, ST_PERSON])).rows[0];
  const items = (await db.query(
    `SELECT item_code, amount FROM payslip_item WHERE payslip_id=$1 ORDER BY item_code`,
    [slip.id])).rows;
  const bad = Number((await db.query(`SELECT count(*)::int n FROM v_payslip_consistency`)).rows[0].n);

  rec('AB3', '年终奖单独成条：应发=奖金、社保 0、税=奖金税、明细两行、勾稽仍空',
      n === 1 && Number(slip.gross_amount) === 24000 && Number(slip.si_employee) === 0
      && Math.abs(Number(slip.tax_amount) - 720) < 0.01
      && Math.abs(Number(slip.net_amount) - 23280) < 0.01
      && items.length === 2 && bad === 0,
      `应发=${slip.gross_amount} 社保=${slip.si_employee} 税=${slip.tax_amount} 实发=${slip.net_amount} 明细=${items.length}`);
}

{ // 一年一人一次：再录一条会覆盖而不是新增（否则"一年发两次"就不能按全年一次性算）
  await db.query(`INSERT INTO annual_bonus(person_id, year, amount, note, created_by)
                  VALUES ($1, 2026, 30000, '覆盖', 'test')
                  ON CONFLICT (person_id, year) DO UPDATE SET amount = EXCLUDED.amount`,
    [ST_PERSON]);
  const cnt = Number((await db.query(
    `SELECT count(*)::int n FROM annual_bonus WHERE person_id=$1 AND year=2026`,
    [ST_PERSON])).rows[0].n);
  rec('AB4', '一年一人只能有一条年终奖（重复录入是覆盖，不是新增）', cnt === 1, `${cnt} 条`);
}

// ===========================================================================
// CM 组 · 提成规则（109）
// ===========================================================================
{ // 阶梯累进：0–10000 3%，10000–50000 5%，50000+ 8%
  // 销售额 60000 → 10000×3% + 40000×5% + 10000×8% = 300+2000+800 = 3100
  const ruleId = Number((await db.query(
    `INSERT INTO commission_rule(code,name,created_by) VALUES ('T_RULE','测试提成规则','test')
     ON CONFLICT (code) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id);
  await db.query(`DELETE FROM commission_rule_tier WHERE rule_id=$1`, [ruleId]);
  await db.query(`INSERT INTO commission_rule_tier(rule_id,from_amount,to_amount,rate) VALUES
                    ($1,0,10000,0.03), ($1,10000,50000,0.05), ($1,50000,NULL,0.08)`, [ruleId]);
  await db.query(`INSERT INTO commission_basis(person_id,period,sales_amount)
                  VALUES ($1,'2026-09',60000)
                  ON CONFLICT (person_id,period) DO UPDATE SET sales_amount=EXCLUDED.sales_amount`,
    [ST_PERSON]);
  const amt = Number((await db.query(`SELECT fn_commission_calc($1,'2026-09') a`,
    [ST_PERSON])).rows[0].a);
  rec('CM1', '阶梯累进：销售额 60000 → 300+2000+800 = 3100（不是 60000×8%=4800）',
      Math.abs(amt - 3100) < 0.02, String(amt));
}

{ // 同一层多条启用规则 → 拒（不能让系统自己挑一个）
  await db.query(`INSERT INTO commission_rule(code,name,created_by) VALUES
                    ('T_RULE2','第二条全局规则','test') ON CONFLICT (code) DO UPDATE SET is_active=true`);
  let msg = '';
  try { await db.query(`SELECT fn_commission_calc($1,'2026-09')`, [ST_PERSON]); }
  catch (e) { msg = e.message; }
  await db.query(`UPDATE commission_rule SET is_active=false WHERE code='T_RULE2'`);
  rec('CM2', '同层多条启用规则 → E_COMM_RULE_AMBIGUOUS（口径不能由系统替你选）',
      /E_COMM_RULE_AMBIGUOUS/.test(msg), msg.split('\n')[0].slice(0, 60));
}

{ // 落账：覆盖同期那条 approved，不是新增（两条会让算薪加两遍）
  const first = Number((await db.query(`SELECT fn_commission_apply($1,'2026-09','test') a`,
    [ST_PERSON])).rows[0].a);
  const second = Number((await db.query(`SELECT fn_commission_apply($1,'2026-09','test') a`,
    [ST_PERSON])).rows[0].a);
  const cnt = Number((await db.query(
    `SELECT count(*)::int n FROM commission_record
      WHERE person_id=$1 AND period='2026-09' AND status='approved'`, [ST_PERSON])).rows[0].n);
  rec('CM3', '提成落账：重复应用覆盖同期那一条（不会变成两条、算薪不会加两遍）',
      first === 3100 && second === 3100 && cnt === 1, `金额=${second} 记录=${cnt} 条`);
}

// ===========================================================================
// EX 组 · 报销留痕（110）
// ===========================================================================
{ // 有结论就必须有结论人：直接插一条 approved 但不带人 → 约束拒
  let msg = '';
  try {
    await db.query(`INSERT INTO expense_claim(person_id,period,category,amount,status,created_by)
                    VALUES ($1,'2026-10','办公',100,'approved','test')`, [ST_PERSON]);
  } catch (e) { msg = e.message; }
  rec('EX1', '报销有结论就必须有结论人（approved 不带 approved_by → 约束拒）',
      /ck_ec_trace/.test(msg), msg ? '拒' : '未拒');
}

{ // pending 不许带结论人：带了说明"还没批却说批了"
  let msg = '';
  try {
    await db.query(`INSERT INTO expense_claim(person_id,period,category,amount,status,created_by,approved_by)
                    VALUES ($1,'2026-10','办公',100,'pending','test','someone')`, [ST_PERSON]);
  } catch (e) { msg = e.message; }
  rec('EX2', 'pending 不许带结论人（还没批却说批了，是两处口径打架）',
      /ck_ec_trace/.test(msg), msg ? '拒' : '未拒');
}

// ===========================================================================
// ATT 组 · 考勤月报：HR 确认过的最终数字，薪资只认它（114/115）
// ---------------------------------------------------------------------------
// 这一组测的是"流程"而不是"公式"：生成 → 调 → 确认 → 薪资读到的是调后的数。
// 用 ST_EMP 的入职月（该月没算过薪，所以重开不会被工资条挡住）。
// ===========================================================================
const attPeriod = (await db.query(
  `SELECT to_char(hire_date,'YYYY-MM') p FROM employment WHERE id = 40`)).rows[0].p;

{ // 生成：期末在职的人都有一行，draft，应出勤 = 日历工作日
  const b = (await db.query(`SELECT * FROM fn_att_period_build($1,1,'test')`,
    [attPeriod])).rows[0];
  const r = (await db.query(`SELECT * FROM att_period_report
                              WHERE period=$1 AND person_id=$2`, [attPeriod, ST_PERSON])).rows[0];
  const cal = Number((await db.query(
    `SELECT fn_calendar_workdays(to_date($1||'-01','YYYY-MM-DD'),
       (to_date($1||'-01','YYYY-MM-DD') + interval '1 month - 1 day')::date) d`,
    [attPeriod])).rows[0].d);
  rec('ATT1', '生成月报：期末在职的人各一行、draft、应出勤=当月日历工作日',
      Number(b.people) >= 1 && r && r.status === 'draft'
      && Number(r.work_days) === cal && Number(r.calendar_days) === cal,
      `人=${b.people} 应出勤=${r?.work_days} 日历=${cal}`);
}

{ // 调整：值变了，留痕一条，改前改后都在
  await db.query(`SELECT fn_att_period_set(
    (SELECT id FROM att_period_report WHERE period=$1 AND person_id=$2),
    'work_days', 20, '公司统一放假两天，日历算多了', 'hr')`, [attPeriod, ST_PERSON]);
  const r = (await db.query(`SELECT * FROM att_period_report
                              WHERE period=$1 AND person_id=$2`, [attPeriod, ST_PERSON])).rows[0];
  const a = (await db.query(`SELECT * FROM att_period_adjust
                              WHERE report_id=$1 AND field_name='work_days'`, [r.id])).rows[0];
  rec('ATT2', 'HR 调应出勤：值改了、留痕一条（改前改后与原因都在）',
      Number(r.work_days) === 20 && a && Number(a.before_value) !== 20
      && Number(a.after_value) === 20 && /统一放假/.test(a.reason),
      `应出勤=${r.work_days} 改前=${a?.before_value}`);
}

{ // 无原因 → 拒；字段不在白名单 → 拒
  const rid = (await db.query(`SELECT id FROM att_period_report
                                WHERE period=$1 AND person_id=$2`, [attPeriod, ST_PERSON])).rows[0].id;
  let e1 = '', e2 = '';
  try { await db.query(`SELECT fn_att_period_set($1,'present_days',21,'  ','hr')`, [rid]); }
  catch (e) { e1 = e.message; }
  try { await db.query(`SELECT fn_att_period_set($1,'status',1,'想直接把状态改成确认','hr')`, [rid]); }
  catch (e) { e2 = e.message; }
  rec('ATT3', '调整必须写原因；只能调白名单字段（想改 status 走确认流程）',
      /E_ARG_INVALID/.test(e1) && /E_ATT_FIELD/.test(e2),
      `${String(e1).slice(0,24)} / ${String(e2).slice(0,24)}`);
}

{ // 提交审批 → 自己不能批自己 → 非指定审批人不能批 → 审批人批了才生效
  const n = Number((await db.query(`SELECT fn_att_period_submit($1,1,'7',3) n`,
    [attPeriod])).rows[0].n);
  const pend = (await db.query(`SELECT status, approver_person_id FROM att_period_report
                                 WHERE period=$1 AND person_id=$2`,
    [attPeriod, ST_PERSON])).rows[0];

  let selfMsg = '', otherMsg = '';
  try { await db.query(`SELECT fn_att_period_approve($1,1,'7',true,'我自己批一下')`, [attPeriod]); }
  catch (e) { selfMsg = e.message; }
  try { await db.query(`SELECT fn_att_period_approve($1,1,'9',true,'路过顺手批一下')`, [attPeriod]); }
  catch (e) { otherMsg = e.message; }

  rec('ATT4', '提交后变 pending 且审批人被固定；提交人自己批被拒、非审批人批被拒',
      n >= 1 && pend.status === 'pending' && Number(pend.approver_person_id) === 3
      && /E_ATT_SELF_APPROVE/.test(selfMsg) && /E_ATT_NOT_APPROVER/.test(otherMsg),
      `提交=${n} 状态=${pend.status} 审批人=${pend.approver_person_id} `
      + `自批=${String(selfMsg).slice(0,24)} 非审批人=${String(otherMsg).slice(0,24)}`);
}

{ // 审批人批准 → 生效；薪资从此只认这一版
  const n = Number((await db.query(`SELECT fn_att_period_approve($1,1,'3',true,'同意') n`,
    [attPeriod])).rows[0].n);
  const r = (await db.query(`SELECT * FROM att_period_report
                              WHERE period=$1 AND person_id=$2`, [attPeriod, ST_PERSON])).rows[0];
  const p = (await db.query(`SELECT * FROM fn_att_person_period($1,$2)`,
    [ST_PERSON, attPeriod])).rows[0];
  rec('ATT5', '主管批准后生效：薪资读到确认数字（应出勤 20）且来源标 report',
      n >= 1 && r.status === 'confirmed' && Number(p.work_days) === 20
      && p.workdays_source === 'report',
      `批准 ${n} 人 应出勤=${p.work_days} 来源=${p.workdays_source}`);
}

{ // 确认后：build 跳过、调整被拒
  const b = (await db.query(`SELECT * FROM fn_att_period_build($1,1,'test')`,
    [attPeriod])).rows[0];
  let msg = '';
  try {
    await db.query(`SELECT fn_att_period_set(
      (SELECT id FROM att_period_report WHERE period=$1 AND person_id=$2),
      'work_days', 22, '想覆盖已确认的数字试试', 'hr')`, [attPeriod, ST_PERSON]);
  } catch (e) { msg = e.message; }
  const r = (await db.query(`SELECT work_days FROM att_period_report
                              WHERE period=$1 AND person_id=$2`, [attPeriod, ST_PERSON])).rows[0];
  rec('ATT6', '已确认的月报：再生成不会改它（计入跳过）、直接调被拒',
      Number(b.skipped_confirmed) >= 1 && /E_ATT_REPORT_CONFIRMED/.test(msg)
      && Number(r.work_days) === 20,
      `跳过=${b.skipped_confirmed} 应出勤仍=${r.work_days}`);
}

{ // 版本：写两版，digest 相同；改一版后 digest 变
  const v1 = Number((await db.query(`SELECT fn_att_period_version_write($1,1,'build','test','初版') v`,
    [attPeriod])).rows[0].v);
  const v2 = Number((await db.query(`SELECT fn_att_period_version_write($1,1,'confirm','test','确认') v`,
    [attPeriod])).rows[0].v);
  const d1 = (await db.query(`SELECT digest FROM att_period_version WHERE version_no=$1 AND period=$2`,
    [v1, attPeriod])).rows[0].digest;
  const d2 = (await db.query(`SELECT digest FROM att_period_version WHERE version_no=$1 AND period=$2`,
    [v2, attPeriod])).rows[0].digest;
  const cnt = Number((await db.query(`SELECT count(*)::int n FROM att_period_version WHERE period=$1`,
    [attPeriod])).rows[0].n);
  rec('ATT6', '多版本：同一批数字两版摘要相同；版本号递增、行数记在版本上',
      v2 === v1 + 1 && d1 === d2 && cnt >= 2,
      `v${v1}/v${v2} 摘要同=${d1 === d2} 版本数=${cnt}`);
}

{ // 重开：回 draft + 留一条 __reopen__ 痕迹
  const n = Number((await db.query(`SELECT fn_att_period_reopen($1,1,'HR 复核后发现漏调一天','hr') n`,
    [attPeriod])).rows[0].n);
  const r = (await db.query(`SELECT status FROM att_period_report
                              WHERE period=$1 AND person_id=$2`, [attPeriod, ST_PERSON])).rows[0];
  const rp = Number((await db.query(
    `SELECT count(*)::int n FROM att_period_adjust a
       JOIN att_period_report x ON x.id = a.report_id
      WHERE x.period=$1 AND a.field_name='__reopen__'`, [attPeriod])).rows[0].n);
  rec('ATT13', '重开要写原因：状态回 draft，并留下 __reopen__ 痕迹',
      n >= 1 && r.status === 'draft' && rp >= 1, `重开 ${n} 人 痕迹=${rp} 条`);
}

{ // 无原因不许重开
  let msg = '';
  try { await db.query(`SELECT fn_att_period_reopen($1,1,'  ','hr')`, [attPeriod]); }
  catch (e) { msg = e.message; }
  rec('ATT8', '重开不写原因 → 拒（它会把已认可的数字变成待改）',
      /E_ARG_INVALID/.test(msg), String(msg).slice(0, 40));
}

{ // 月报导入：只给 work_hours，其余列不动；重复应用被拒
  const rid = (await db.query(`SELECT id, work_days, present_days FROM att_period_report
                                WHERE period=$1 AND person_id=$2`, [attPeriod, ST_PERSON])).rows[0];
  const batchId = Number((await db.query(
    `INSERT INTO att_import_batch(kind,period,filename,row_total,row_ok,created_by)
     VALUES ('monthly',$1,'att.csv',1,1,'hr') RETURNING id`, [attPeriod])).rows[0].id);
  await db.query(`INSERT INTO att_import_row(batch_id,row_no,ok,payload)
                  VALUES ($1,1,true,$2::jsonb)`,
    [batchId, JSON.stringify({ person_id: ST_PERSON, work_hours: 168 })]);
  const ap = (await db.query(`SELECT * FROM fn_att_period_import_apply($1,$2,1,'hr')`,
    [batchId, attPeriod])).rows[0];
  const after = (await db.query(`SELECT work_days, present_days, work_hours
                                   FROM att_period_report WHERE id=$1`, [rid.id])).rows[0];

  let again = '';
  try { await db.query(`SELECT fn_att_period_import_apply($1,$2,1,'hr')`, [batchId, attPeriod]); }
  catch (e) { again = e.message; }

  rec('ATT9', '导入覆盖只改给了值的列（工时变了，应出勤/出勤没被清零）；重复应用被拒',
      Number(ap.applied) === 1 && Number(after.work_hours) === 168
      && Number(after.work_days) === Number(rid.work_days)
      && Number(after.present_days) === Number(rid.present_days)
      && /E_ALREADY_APPLIED/.test(again),
      `工时=${after.work_hours} 应出勤=${after.work_days} 再应用=${String(again).slice(0,20)}`);
}

{ // 日报调整：改工时联动在岗时长，并留痕
  const before = (await db.query(`SELECT work_hours, in_attendance_hours
                                    FROM attendance_daily_store
                                   WHERE employee_id=$1 AND work_date='2026-06-02'`,
    [ST_PERSON])).rows[0];
  await db.query(`SELECT fn_att_daily_set($1,'2026-06-02',8,'漏打卡，按排班补成 8 小时','hr')`,
    [ST_PERSON]);
  const after = (await db.query(`SELECT work_hours, in_attendance_hours
                                   FROM attendance_daily_store
                                  WHERE employee_id=$1 AND work_date='2026-06-02'`,
    [ST_PERSON])).rows[0];
  const adj = (await db.query(
    `SELECT * FROM att_daily_adjust WHERE employee_id=$1 AND work_date='2026-06-02'
      ORDER BY id DESC LIMIT 1`, [ST_PERSON])).rows[0];
  rec('ATT10', '日报调整：工时 9→8 且在岗时长跟着改；留痕记了改前改后与原因',
      Number(before.work_hours) === 9 && Number(after.work_hours) === 8
      && Number(after.in_attendance_hours) === 8
      && adj && Number(adj.before_value) === 9 && Number(adj.after_value) === 8,
      `工时 ${before.work_hours}→${after.work_hours} 在岗=${after.in_attendance_hours}`);
}

{ // 没有当天人日 → 拒（不顺手新建一条"他来了"）
  let msg = '';
  try { await db.query(`SELECT fn_att_daily_set($1,'2026-06-03',8,'这天没有记录，想直接补一条','hr')`,
    [ST_PERSON]); }
  catch (e) { msg = e.message; }
  rec('ATT11', '没有当天人日时拒绝新建（要补请走补勤/导入，别替门店决定他来了）',
      /E_ATT_NO_ROW/.test(msg), String(msg).slice(0, 40));
}

{ // 封账后改日报 → 拒（与触发器同一条规矩，但提示要说清走哪条路）
  await db.query(`INSERT INTO attendance_close(store_id, period, status, closed_at, closed_by,
                    snap_rows, snap_hours, snap_digest)
                  VALUES (1,'2026-06','closed', now(), 'hr', 1, 8, 'test-digest')
                  ON CONFLICT (store_id, period) DO NOTHING`);
  let msg = '';
  try { await db.query(`SELECT fn_att_daily_set($1,'2026-06-02',7,'封账后还想改改看','hr')`,
    [ST_PERSON]); }
  catch (e) { msg = e.message; }
  rec('ATT12', '封账后改日报 → 拒，并指明"封账后的修正请走补账"',
      /E_ATT_CLOSED/.test(msg) && /补账/.test(msg), String(msg).slice(0, 52));
}

// ===========================================================================
// ATT（续）· 月报驱动薪资 + 版本自动留（114–118）
// BASIS 组 · 两种计薪基础：按人天 / 按工时（117）
// ---------------------------------------------------------------------------
// 造一个干净的期间（2026-09）：10 天 × 8 小时人日，封账，月报确认，
// 然后分别用 day / hour 两种计薪基础算同一个人 —— 看两笔钱差在哪。
// ===========================================================================
const B_PERIOD = '2026-09';

await db.query(`DELETE FROM attendance_daily_store WHERE work_date >= '2026-09-01'
                 AND work_date <= '2026-09-30'`);
await db.query(`INSERT INTO attendance_daily_store
    (employee_id, store_id, work_date, shift_start_at, shift_end_at,
     span_hours, on_duty_hours, off_duty_hours, break_on_duty_hours,
     in_attendance_hours, work_hours, snap_on_duty_break_basis)
  SELECT $1, 1, ('2026-09-01'::date + (n - 1)),
         ('2026-09-01 09:00+08'::timestamptz + ((n - 1) || ' day')::interval),
         ('2026-09-01 17:00+08'::timestamptz + ((n - 1) || ' day')::interval),
         8, 8, 0, 0, 8, 8, 'hourly'
    FROM generate_series(1, 10) n`, [ST_PERSON]);
await db.query(`INSERT INTO attendance_close(store_id, period, status, closed_at, closed_by,
                  snap_rows, snap_hours, snap_digest)
                VALUES (1,'2026-09','closed', now(), 'hr', 10, 80, 'test-sep')
                ON CONFLICT (store_id, period) DO NOTHING`);

{ // 月报：生成 → 手调事假 2 天 → 确认；扣款跟着确认后的数字走
  await db.query(`SELECT fn_att_period_build($1,1,'hr')`, [B_PERIOD]);
  const rid = (await db.query(`SELECT id FROM att_period_report
                                WHERE period=$1 AND person_id=$2`, [B_PERIOD, ST_PERSON])).rows[0].id;
  await db.query(`SELECT fn_att_period_set($1,'personal_leave_days',2,
                   '员工提交了 2 天事假单，系统未及时审批，HR 手工计入','hr')`, [rid]);
  await db.query(`SELECT fn_att_period_submit($1,1,'7',4)`, [B_PERIOD]);
  const n = Number((await db.query(`SELECT fn_att_period_approve($1,1,'4',true,'同意') n`,
    [B_PERIOD])).rows[0].n);
  const vn = (await db.query(
    `SELECT source, count(*)::int n FROM att_period_version WHERE period=$1
      GROUP BY source ORDER BY source`, [B_PERIOD])).rows;
  const srcs = vn.map(x => x.source);
  rec('ATT13', '月报走完 生成→手调→提交→审批：四个动作各自自动留了一版',
      n >= 1 && srcs.includes('build') && srcs.includes('manual')
      && srcs.includes('submit') && srcs.includes('approve'),
      `批准 ${n} 人 版本来源=${srcs.join('/')}`);
}

// 这个月的真实月薪与提成（SAL 组调过薪、CM 组录过提成，别写死 8000）
const B_MONTHLY = Number((await db.query(
  `SELECT monthly_amount m FROM salary_standard WHERE employment_id=40
    AND effective_from <= '2026-09-30' ORDER BY effective_from DESC LIMIT 1`)).rows[0].m);
const B_COMM = Number((await db.query(`SELECT fn_commission_amount($1,$2) a`,
  [ST_PERSON, '2026-09'])).rows[0].a);

{ // day 模式：底薪 = 月薪，事假按 2 天扣（日薪 = 月薪 ÷ 21.75）
  const runId = Number((await db.query(
    `INSERT INTO pay_run(period, legal_entity_id, kind) VALUES ($1,1,'monthly') RETURNING id`,
    [B_PERIOD])).rows[0].id);
  await db.query(`SELECT fn_payroll_calc($1)`, [runId]);
  const slip = (await db.query(`SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
    [runId, ST_PERSON])).rows[0];
  const ld = (await db.query(`SELECT amount FROM payslip_item
                               WHERE payslip_id=$1 AND item_code='LEAVE_DEDUCT'`, [slip.id])).rows[0];
  const expectLeave = Math.round(B_MONTHLY / 21.75 * 2 * 100) / 100;
  rec('ATT14', '按人天：底薪=月薪，事假 2 天按日薪扣（数字来自 HR 确认的月报）',
      Math.abs(Number(slip.gross_amount) - (B_MONTHLY - expectLeave + B_COMM)) < 0.03
      && Math.abs(Number(ld?.amount) + expectLeave) < 0.03,
      `月薪=${B_MONTHLY} 应发=${slip.gross_amount} 事假扣=${ld?.amount} 期望=${expectLeave}`);
}

{ // hour 模式：底薪 = 时薪 × 80 小时；不再扣事假；社保仍按月薪
  await db.query(`UPDATE employment SET pay_basis='hour' WHERE id=40`);
  const basis = (await db.query(`SELECT fn_pay_basis($1,$2) b`, [ST_PERSON, B_PERIOD])).rows[0].b;
  const runId = Number((await db.query(
    `SELECT id FROM pay_run WHERE period=$1 AND legal_entity_id=1 AND kind='monthly'`,
    [B_PERIOD])).rows[0].id);
  await db.query(`SELECT fn_payroll_calc($1)`, [runId]);
  const slip = (await db.query(`SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
    [runId, ST_PERSON])).rows[0];
  const items = (await db.query(`SELECT item_code, amount FROM payslip_item
                                  WHERE payslip_id=$1 ORDER BY item_code`, [slip.id])).rows;
  const hourly = B_MONTHLY / 21.75 / 8;                 // 时薪（法定折算口径）
  const expect = Math.round(hourly * 80 * 100) / 100 + B_COMM;
  const hasLeave = items.some(x => x.item_code === 'LEAVE_DEDUCT');

  rec('BASIS1', '按工时：底薪 = 时薪(月薪÷21.75÷8) × 实际 80 小时（提成照加）',
      basis === 'hour' && Math.abs(Number(slip.gross_amount) - expect) < 0.02,
      `模式=${basis} 应发=${slip.gross_amount} 期望=${expect}`);

  rec('BASIS2', '按工时不再扣事假（缺勤已在工时里，再扣就是扣两次）',
      !hasLeave, `有 LEAVE_DEDUCT 行=${hasLeave}`);

  const expectSi = Math.round(B_MONTHLY * 0.175 * 100) / 100;   // 养老8+医疗2+失业0.5+公积金7
  rec('BASIS3', '按工时的社保仍按**月薪标准**（不随工时少缴：少缴是欠缴）',
      Math.abs(Number(slip.si_employee) - expectSi) < 0.03,
      `五险一金=${slip.si_employee} 期望=${expectSi}（月薪 ${B_MONTHLY} × 17.5%）`);

  const bad = Number((await db.query(`SELECT count(*)::int n FROM v_payslip_consistency`)).rows[0].n);
  rec('BASIS4', '按工时下结构明细同比例缩放，勾稽仍成立（明细和 = 应发 − 社保 − 个税）',
      bad === 0, `勾稽不一致 ${bad} 条`);
}

{ // 个人设置优先于公司制度：写完再清掉
  await db.query(`UPDATE policy_value SET value_text='hour'
                   WHERE policy_code='PAY_BASIS' AND effective_from='2026-01-01'`);
  await db.query(`UPDATE employment SET pay_basis=NULL WHERE id=40`);
  const fromPolicy = (await db.query(`SELECT fn_pay_basis($1,$2) b`, [ST_PERSON, B_PERIOD])).rows[0].b;
  await db.query(`UPDATE employment SET pay_basis='day' WHERE id=40`);
  const fromPerson = (await db.query(`SELECT fn_pay_basis($1,$2) b`, [ST_PERSON, B_PERIOD])).rows[0].b;
  await db.query(`UPDATE employment SET pay_basis=NULL WHERE id=40`);
  await db.query(`UPDATE policy_value SET value_text='day'
                   WHERE policy_code='PAY_BASIS' AND effective_from='2026-01-01'`);
  const after = (await db.query(`SELECT fn_pay_basis($1,$2) b`, [ST_PERSON, B_PERIOD])).rows[0].b;
  rec('BASIS5', '计薪基础三层：个人 hour 覆盖公司 hour；清掉个人后跟公司；再改回 day 即恢复',
      fromPolicy === 'hour' && fromPerson === 'day' && after === 'day',
      `公司hour→${fromPolicy} 个人day→${fromPerson} 默认→${after}`);
}

{ // 版本对比：两版之间差异能被指出来（哪个字段从多少到多少）
  const vs = (await db.query(`SELECT id, version_no FROM att_period_version
                               WHERE period=$1 ORDER BY version_no`, [B_PERIOD])).rows;
  const diff = vs.length >= 2
    ? (await db.query(`SELECT * FROM fn_att_period_version_diff($1,$2)`,
        [vs[0].id, vs[vs.length - 1].id])).rows
    : [];
  rec('ATT15', '版本对比：能指出哪个字段从多少变到多少（不是只能看摘要不同）',
      diff.some(x => x.field_name === 'personal_leave_days'),
      `差异 ${diff.length} 处`);
}

// ===========================================================================
// ATT（续）· 审批的三种边界：没人可批 / 驳回 / 部门负责人解析（119）
// ===========================================================================
const A_PERIOD = '2026-10';

{ // 没有部门负责人也没有 HR 主管 → 提交直接拒，不允许"没人批就自动过"
  await db.query(`SELECT fn_att_period_build($1,1,'hr')`, [A_PERIOD]);
  let msg = '';
  try { await db.query(`SELECT fn_att_period_submit($1,1,'7')`, [A_PERIOD]); }
  catch (e) { msg = e.message; }
  const st = (await db.query(`SELECT DISTINCT status FROM att_period_report
                               WHERE period=$1`, [A_PERIOD])).rows.map(x => x.status);
  rec('ATT17', '找不到审批人 → 整批拒（E_ATT_NO_APPROVER），不落成"待审批"',
      /E_ATT_NO_APPROVER/.test(msg) && st.every(x => x === 'draft'),
      `${String(msg).slice(0,34)} 状态=${st.join('/')}`);
}

{ // 部门负责人解析：设了店长就落到店长，不跳到 HR
  await db.query(`INSERT INTO org_unit(id, name, path, kind) VALUES (9001,'测试门店','/9001','dept')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`UPDATE org_unit SET leader_person_id = 3 WHERE id = 9001`);
  await db.query(`DELETE FROM employee_org_assignment
                   WHERE employee_id=$1 AND dim_code='attendance_org'`, [ST_PERSON]);
  await db.query(`INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from)
                  VALUES ($1,'attendance_org',9001,'2026-01-01')`, [ST_PERSON]);
  const who = Number((await db.query(`SELECT fn_att_approver($1,$2) p`,
    [ST_PERSON, A_PERIOD])).rows[0].p);
  rec('ATT18', '审批人解析：设了部门负责人就落到他（不是直接跳 HR）', who === 3, `审批人=${who}`);
}

{ // ★ 兜底链不能指向一个**不能批**的人（177；176 把老板收成只读之后暴露出来的死路）
  // 121 的兜底链最后一级是「hr_ops → payroll_spec → boss」，判据写的是**角色名**。
  // 176 把老板的写权限全部收回之后，那一级就变成了一句空话：解析到一个永远
  // 批不了的角色，而报出来的是 403「你没有权限」—— 排查的人会去查权限配置，
  // 不会想到"兜底链指向了一个只读角色"。单子就挂死在那儿。
  // ★ 判据应当写"这个角色能不能批"（att_report_approve 的写权限，审批接口查的就是它），
  //   而不是"角色叫什么" —— 角色名不会因为权限被回收而自动失效。
  // 构造：老板账号**绑了人**（⑤ 才可能解析到他）+ 没有任何部门归属/岗位的人。
  const P_NO = 8601, P_BOSS = 8602, P_HR = 8603;
  await db.query(`INSERT INTO person(id, full_name) VALUES
                    ($1,'无审批人样例'),($2,'老板样例'),($3,'HR样例')
                  ON CONFLICT (id) DO NOTHING`, [P_NO, P_BOSS, P_HR]);
  const aBoss = Number((await db.query(
    `SELECT fn_account_create($1,$2,'boss',NULL,$3,'att') id`,
    ['att_boss_acc', '老板样例', P_BOSS])).rows[0].id);
  const bossWrite = (await db.query(
    `SELECT fn_role_can($1,'att_report_approve','write') w`, [aBoss])).rows[0].w;
  const nobody = (await db.query(
    `SELECT fn_att_approver($1,$2) p`, [P_NO, A_PERIOD])).rows[0].p;
  // 再补一个 hr_ops：兜底链必须还能正常工作 —— 它证明筛的是"能不能批"，
  // 不是"把所有人都筛掉了"（那种"修法"会让审批永远找不到人）。
  const aHr = Number((await db.query(
    `SELECT fn_account_create($1,$2,'hr_ops',NULL,$3,'att') id`,
    ['att_hr_acc', 'HR样例', P_HR])).rows[0].id);
  const someHr = (await db.query(
    `SELECT fn_att_approver($1,$2) p`, [P_NO, A_PERIOD])).rows[0].p;
  // 收尾：这两个账号不留给后面的组（"兜底链解析"这件事在别的组还会被问到）
  await db.query(`UPDATE sys_account SET status='disabled' WHERE id = ANY($1::bigint[])`,
    [[aBoss, aHr]]);
  rec('ATT21', '审批人兜底链不能指向一个**不能批**的人：一个 HR 账号都没有、'
    + '只有一个（绑了人的）老板账号时，fn_att_approver 返回 **NULL**（旧代码返回老板的 id，'
    + '于是审批指派给一个只读角色、单子挂死在"你没有权限"上）；补一个 hr_ops 后立刻解析到他',
    nobody === null && bossWrite === false && Number(someHr) === P_HR,
    `老板可批=${bossWrite} 只有老板时审批人=${nobody ?? 'NULL'} `
    + `补 HR 后审批人=${Number(someHr) || 'NULL'}（期望 ${P_HR}）`);
}

{ // 指定的审批人驳回 → 回 draft、记原因，薪资不再读这份月报
  const approver = Number((await db.query(`SELECT fn_att_approver($1,$2) p`,
    [ST_PERSON, A_PERIOD])).rows[0].p);
  await db.query(`SELECT fn_att_period_submit($1,1,'7',$2)`, [A_PERIOD, approver]);
  const n = Number((await db.query(`SELECT fn_att_period_approve($1,1,$2,false,
                    '10 月有 3 个人漏打卡，门店还没补，退回重做') n`,
    [A_PERIOD, String(approver)])).rows[0].n);
  const r = (await db.query(`SELECT status, rejected_reason FROM att_period_report
                              WHERE period=$1 AND person_id=$2`, [A_PERIOD, ST_PERSON])).rows[0];
  const p = (await db.query(`SELECT workdays_source FROM fn_att_person_period($1,$2)`,
    [ST_PERSON, A_PERIOD])).rows[0];
  rec('ATT19', '驳回：回 draft、记下原因，薪资侧立刻退回实时汇总（不能拿被驳回的表发钱）',
      n >= 1 && r.status === 'draft' && /漏打卡/.test(r.rejected_reason)
      && p.workdays_source !== 'report',
      `状态=${r.status} 原因=${String(r.rejected_reason).slice(0,20)} 薪资来源=${p.workdays_source}`);
}

// ===========================================================================
// OT 组 · 加班费三档（120）
// ---------------------------------------------------------------------------
// 2026-11 造三天：平日 10h（加班 2h）、周六 8h（休息日）、一个临时设为法定假日的 8h。
// ===========================================================================
const O_PERIOD = '2026-11';
{
  await db.query(`INSERT INTO legal_holiday(holiday_date, name, is_workday)
                  VALUES ('2026-11-11','测试用假日', false) ON CONFLICT DO NOTHING`);
  const mk = async (d, startH, hours) => {
    await db.query(`INSERT INTO attendance_daily_store
        (employee_id, store_id, work_date, shift_start_at, shift_end_at,
         span_hours, on_duty_hours, off_duty_hours, break_on_duty_hours,
         in_attendance_hours, work_hours, snap_on_duty_break_basis)
      VALUES ($1, 1, $2::date,
              ($2::date + ($3::int::text || ' hour')::interval) AT TIME ZONE 'Asia/Shanghai',
              ($2::date + (($3::int + $4::int)::text || ' hour')::interval) AT TIME ZONE 'Asia/Shanghai',
              $4::numeric, $4::numeric, 0, 0, $4::numeric, $4::numeric, 'hourly')`,
      [ST_PERSON, d, startH, hours]);
  };
  await mk('2026-11-02', 9, 10);   // 周一：平日延长 2h
  await mk('2026-11-07', 9, 8);    // 周六：休息日 8h
  await mk('2026-11-11', 9, 8);    // 法定节假日 8h

  await db.query(`INSERT INTO attendance_close(store_id, period, status, closed_at, closed_by,
                    snap_rows, snap_hours, snap_digest)
                  VALUES (1,'2026-11','closed', now(), 'hr', 3, 26, 'test-nov')
                  ON CONFLICT (store_id, period) DO NOTHING`);

  const o = (await db.query(`SELECT * FROM fn_att_ot_split($1,$2)`, [ST_PERSON, O_PERIOD])).rows[0];
  rec('OT1', '加班三档拆分：平日延长 2h / 休息日 8h / 法定节假日 8h（不是混成一个总数）',
      Number(o.weekday_ot) === 2 && Number(o.restday_ot) === 8 && Number(o.holiday_ot) === 8,
      `平日=${o.weekday_ot} 休息日=${o.restday_ot} 法定=${o.holiday_ot}`);
}

{ // 倍数低于法定下限 → 拒（少付是违法）
  let msg = '';
  try {
    await db.query(`INSERT INTO policy_value(policy_code, effective_from, value_num, published_by, reason)
                    VALUES ('PAY_OT_RATE_WEEKDAY','2026-12-01',1.2,'hr','换算一下想省点钱')`);
  } catch (e) { msg = e.message; }
  rec('OT2', '加班倍数低于法定下限（平日 1.2 < 1.5）→ 拒（少付是违法，多付只是成本）',
      /E_OT_RATE_LOW/.test(msg), String(msg).slice(0, 46));
}

{ // 开启自动算：三档 × 1.5/2/3
  await db.query(`UPDATE policy_value SET value_text='on'
                   WHERE policy_code='PAY_OT_AUTO' AND effective_from='2026-01-01'`);
  const runId = Number((await db.query(
    `INSERT INTO pay_run(period, legal_entity_id, kind) VALUES ($1,1,'monthly') RETURNING id`,
    [O_PERIOD])).rows[0].id);
  await db.query(`SELECT fn_payroll_calc($1)`, [runId]);
  const slip = (await db.query(`SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
    [runId, ST_PERSON])).rows[0];
  const ot = (await db.query(`SELECT amount FROM payslip_item
                               WHERE payslip_id=$1 AND item_code='OT_PAY'`, [slip.id])).rows[0];
  const monthly = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=40
      AND effective_from <= '2026-11-30' ORDER BY effective_from DESC LIMIT 1`)).rows[0].m);
  const hourly = monthly / 21.75 / 8;
  const expect = Math.round(hourly * (2 * 1.5 + 8 * 2 + 8 * 3) * 100) / 100;
  rec('OT3', '按人天：加班费 = 时薪 × (2×1.5 + 8×2 + 8×3)，工资条上单独一行',
      Math.abs(Number(ot?.amount) - expect) < 0.03,
      `加班费=${ot?.amount} 期望=${expect}（时薪=${hourly.toFixed(4)}）`);
}

{ // 按工时模式：1 倍已含在"时薪×工时"里，加班只补差额（0.5/1/2）
  await db.query(`UPDATE employment SET pay_basis='hour' WHERE id=40`);
  const runId = Number((await db.query(
    `SELECT id FROM pay_run WHERE period=$1 AND legal_entity_id=1 AND kind='monthly'`,
    [O_PERIOD])).rows[0].id);
  await db.query(`SELECT fn_payroll_calc($1)`, [runId]);
  const slip = (await db.query(`SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
    [runId, ST_PERSON])).rows[0];
  const ot = (await db.query(`SELECT amount FROM payslip_item
                               WHERE payslip_id=$1 AND item_code='OT_PAY'`, [slip.id])).rows[0];
  const monthly = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=40
      AND effective_from <= '2026-11-30' ORDER BY effective_from DESC LIMIT 1`)).rows[0].m);
  const hourly = monthly / 21.75 / 8;
  const expect = Math.round(hourly * (2 * 0.5 + 8 * 1 + 8 * 2) * 100) / 100;
  rec('OT4', '按工时：加班只补差额（0.5/1/2 倍），不重复给已含在工时里的 1 倍',
      Math.abs(Number(ot?.amount) - expect) < 0.03,
      `加班费=${ot?.amount} 期望=${expect}`);
  await db.query(`UPDATE employment SET pay_basis=NULL WHERE id=40`);
}

{ // 关闭 → 不自动算（工时仍给公式，客户可自己算）
  await db.query(`UPDATE policy_value SET value_text='off'
                   WHERE policy_code='PAY_OT_AUTO' AND effective_from='2026-01-01'`);
  const runId = Number((await db.query(
    `SELECT id FROM pay_run WHERE period=$1 AND legal_entity_id=1 AND kind='monthly'`,
    [O_PERIOD])).rows[0].id);
  await db.query(`SELECT fn_payroll_calc($1)`, [runId]);
  const slip = (await db.query(`SELECT * FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
    [runId, ST_PERSON])).rows[0];
  const n = Number((await db.query(`SELECT count(*)::int n FROM payslip_item
                                     WHERE payslip_id=$1 AND item_code='OT_PAY'`,
    [slip.id])).rows[0].n);
  const v = Number((await db.query(`SELECT fn_formula_eval('HOURLY_RATE * (OT_WEEKDAY*1.5)',
                    (SELECT jsonb_build_object('HOURLY_RATE',1,'OT_WEEKDAY',2))) v`)).rows[0].v);
  rec('OT5', '关闭自动算：工资条没有 OT_PAY 行；但三档工时仍可被公式引用（客户可自算）',
      n === 0 && v === 3, `OT_PAY 行=${n} 公式试算=${v}`);
}

// ===========================================================================
// ATT（续）· 调整出勤后旷工要跟着冲减（124）
// ===========================================================================
const C_PERIOD = '2026-12';
{
  await db.query(`SELECT fn_att_period_build($1,1,'hr')`, [C_PERIOD]);
  const rid = (await db.query(`SELECT id FROM att_period_report
                                WHERE period=$1 AND person_id=$2`, [C_PERIOD, ST_PERSON])).rows[0].id;
  const before = (await db.query(`SELECT work_days, absent_days FROM att_period_report WHERE id=$1`,
    [rid])).rows[0];
  await db.query(`SELECT fn_att_period_set($1,'present_days',20,
                   '整月漏打卡，按考勤机导出记录补录出勤','hr')`, [rid]);
  const after = (await db.query(`SELECT work_days, present_days, absent_days
                                   FROM att_period_report WHERE id=$1`, [rid])).rows[0];
  const auto = (await db.query(`SELECT * FROM att_period_adjust
                                 WHERE report_id=$1 AND field_name='absent_days'
                                   AND reason LIKE '__auto__%'`, [rid])).rows[0];
  rec('ATT20', '调整出勤后旷工自动冲减（出勤 20 → 旷工 = 应出勤 − 20），并单独留 __auto__ 痕迹',
      Number(after.absent_days) === Number(before.work_days) - 20
      && auto && Number(auto.after_value) === Number(after.absent_days),
      `应出勤=${before.work_days} 旷工 ${before.absent_days}→${after.absent_days}`);
}

// ===========================================================================
// HOL 组 · 节假日三型：法定 11 天 / 调休放假 200% / 调休上班计入应出勤（125）
// ===========================================================================
{
  // ★ 排除 OT 组自己造的那一天（2026-11-11「测试用假日」）：
  //   断言要测的是"官方安排有几条"，不能被测数据自己抬高。
  const legal = Number((await db.query(
    `SELECT count(*)::int n FROM legal_holiday
      WHERE holiday_type='legal' AND extract(year FROM holiday_date)=2026
        AND name <> '测试用假日'`)).rows[0].n);
  const oct = Number((await db.query(
    `SELECT fn_calendar_workdays('2026-10-01','2026-10-31') d`)).rows[0].d);
  const feb = Number((await db.query(
    `SELECT fn_calendar_workdays('2026-02-01','2026-02-28') d`)).rows[0].d);
  rec('HOL1', '2026 法定节假日共 11 天；10 月应出勤 18 天、2 月 16 天（按国务院通知算出来的）',
      legal === 11 && oct === 18 && feb === 16,
      `法定=${legal}天 10月=${oct}天 2月=${feb}天`);
}

{ // 同一个"放假"里，300% 与 200% 必须分开
  const legalDay = (await db.query(`SELECT fn_is_legal_holiday('2026-10-01') a,
                                           fn_is_rest_day('2026-10-01', 10) b`)).rows[0];
  const restDay = (await db.query(`SELECT fn_is_legal_holiday('2026-10-05') a,
                                          fn_is_rest_day('2026-10-05', 10) b`)).rows[0];
  const workDay = (await db.query(`SELECT fn_is_rest_day('2026-10-10', 10) b`)).rows[0];
  rec('HOL2', '国庆 10/1 是法定（300%）、10/5 是调休放假（200%）、10/10 是调休上班（不休息）',
      legalDay.a === true && legalDay.b === false
      && restDay.a === false && restDay.b === true
      && workDay.b === false,
      `10/1 法定=${legalDay.a} 休息=${legalDay.b} / 10/5 法定=${restDay.a} 休息=${restDay.b}`);
}

{ // 加班拆分按三型走：同一个人国庆法定日与调休放假日各上 8 小时
  await db.query(`DELETE FROM attendance_daily_store WHERE work_date IN ('2026-10-01','2026-10-05')`);
  for (const d of ['2026-10-01', '2026-10-05']) {
    await db.query(`INSERT INTO attendance_daily_store
        (employee_id, store_id, work_date, shift_start_at, shift_end_at,
         span_hours, on_duty_hours, off_duty_hours, break_on_duty_hours,
         in_attendance_hours, work_hours, snap_on_duty_break_basis)
      VALUES ($1,1,$2::date,
              ($2::date + interval '9 hour') AT TIME ZONE 'Asia/Shanghai',
              ($2::date + interval '17 hour') AT TIME ZONE 'Asia/Shanghai',
              8,8,0,0,8,8,'hourly')`, [ST_PERSON, d]);
  }
  const o = (await db.query(`SELECT * FROM fn_att_ot_split($1,'2026-10')`,
    [ST_PERSON])).rows[0];
  rec('HOL3', '加班拆分：法定日 8h 进 holiday_ot（300%）、调休放假日 8h 进 restday_ot（200%）',
      Number(o.holiday_ot) === 8 && Number(o.restday_ot) === 8,
      `法定=${o.holiday_ot}h 休息日=${o.restday_ot}h 平日=${o.weekday_ot}h`);
}

{ // 反例：把 10/5 从"调休放假"改成"调休上班"，应出勤真的 +1
  await db.query(`SELECT fn_holiday_upsert('2026-10-05','测试改成上班','workday','反例')`);
  const after = Number((await db.query(
    `SELECT fn_calendar_workdays('2026-10-01','2026-10-31') d`)).rows[0].d);
  await db.query(`SELECT fn_holiday_upsert('2026-10-05','国庆假期','rest','调休')`);
  const back = Number((await db.query(
    `SELECT fn_calendar_workdays('2026-10-01','2026-10-31') d`)).rows[0].d);
  rec('HOL4', '改节假日类型 → 应出勤真的跟着变（18→19→18），不是只登记不生效',
      after === 19 && back === 18, `改后=${after} 改回=${back}`);
}

// ===========================================================================
// SICK 组 · 病假工资（126）
// ---------------------------------------------------------------------------
// 工龄按"期末 − 入职日"折算，比例取不超过工龄的最高档；下限是最低工资 80%。
// ===========================================================================
const SICK_ID = (await db.query(`SELECT id FROM leave_type WHERE code='SICK'`)).rows[0].id;

{
  await db.query(`INSERT INTO leave_request(employee_id, leave_type_id, qty, date_from, date_to,
                    status, decided_at)
                  VALUES ($1,$2,2,'2026-08-03','2026-08-04','approved', now())`,
    [ST_PERSON, SICK_ID]);
  const sick = Number((await db.query(`SELECT fn_sick_pay($1,'2026-08') s`,
    [ST_PERSON])).rows[0].s);
  const monthly = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=40
      AND effective_from <= '2026-08-31' ORDER BY effective_from DESC LIMIT 1`)).rows[0].m);
  // 工龄不满 2 年 → 60%
  const expect = Math.round(monthly / 21.75 * 0.6 * 2 * 100) / 100;
  rec('SICK1', '病假 2 天、工龄不满 2 年 → 日薪 × 60% × 2（不是按事假全扣）',
      Math.abs(sick - expect) < 0.03, `病假工资=${sick} 期望=${expect}`);
}

{ // 比例改成 0.5 → 拒（法定最低档 60%，低于它就是违法）
  let msg = '';
  try {
    await db.query(`UPDATE sick_pay_tier SET rate = 0.5 WHERE years_from = 0`);
  } catch (e) { msg = e.message; }
  rec('SICK2', '病假比例低于 60% → 拒（ck_spt_rate；违法的事不留给界面去灵活）',
      /ck_spt_rate/.test(msg), String(msg).slice(0, 40));
}

{ // 把最低工资调到很高 → 病假工资被下限顶起来
  await db.query(`INSERT INTO min_wage(city, effective_from, monthly, note)
                  VALUES ('上海','2026-06-01',20000,'测试：验证下限生效')
                  ON CONFLICT (city, effective_from) DO UPDATE SET monthly = 20000`);
  const withFloor = Number((await db.query(`SELECT fn_sick_pay($1,'2026-08') s`,
    [ST_PERSON])).rows[0].s);
  await db.query(`DELETE FROM min_wage WHERE city='上海' AND effective_from='2026-06-01'`);
  const floorPerDay = 20000 * 0.8 / 21.75;
  const expectFloor = Math.round(floorPerDay * 2 * 100) / 100;
  rec('SICK3', '病假工资不低于"最低工资 × 80% ÷ 21.75"× 天数（下限顶起来）',
      Math.abs(withFloor - expectFloor) < 0.05,
      `按下限=${withFloor} 期望=${expectFloor}`);
}

{ // 事假全扣、病假只扣"日薪 − 病假工资"
  const sd = Number((await db.query(
    `SELECT fn_leave_deduction($1,'2026-08') d`, [ST_PERSON])).rows[0].d);
  const sick = Number((await db.query(`SELECT fn_sick_pay($1,'2026-08') s`,
    [ST_PERSON])).rows[0].s);
  const monthly = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=40
      AND effective_from <= '2026-08-31' ORDER BY effective_from DESC LIMIT 1`)).rows[0].m);
  const expect = Math.round((monthly / 21.75 * 2 - sick) * 100) / 100;
  rec('SICK4', '病假扣款 = 日薪×天数 − 病假工资（只扣差额，不是全扣）',
      Math.abs(sd - expect) < 0.05, `扣款=${sd} 期望=${expect}`);
}

{ // 权限：薪酬政策只给 HR 主管
  // ★ 176 起老板也**没有**写权限了（老板只读：全资源可读、零可写）——
  //   126 当时把 payroll_policy 给了 boss + hr_ops，理由是"改倍数/比例属于制度"。
  //   但制度也是"改数"：一个加班倍数改错，全公司下个月都按它算。老板看得到
  //   （can_read 还在），签字由 hr_ops 落库。
  const roles = (await db.query(
    `SELECT r.code FROM sys_role_resource rr JOIN sys_role r ON r.id = rr.role_id
      WHERE rr.resource_code='payroll_policy' AND rr.can_write
      ORDER BY r.code`)).rows.map(x => x.code);
  const readers = (await db.query(
    `SELECT r.code FROM sys_role_resource rr JOIN sys_role r ON r.id = rr.role_id
      WHERE rr.resource_code='payroll_policy' AND rr.can_read
      ORDER BY r.code`)).rows.map(x => x.code);
  rec('SICK5', '薪酬政策维护权限只给 hr_ops（店长/薪酬专员/老板都不能改倍数与比例；'
    + '老板仍**看得到**这张表 —— 只读不是无权）',
      roles.includes('hr_ops') && !roles.includes('boss')
      && !roles.includes('store_mgr') && !roles.includes('payroll_spec')
      && readers.includes('boss'),
      `可写角色=${roles.join(',')}；可读含老板=${readers.includes('boss')}`);
}

// ===========================================================================
// LVT 组 · 假种：官方预置不可删（与上面的 LT 组不重名）、自定义可加、带薪比例自动参与扣款（127）
// ===========================================================================
{
  const sys = (await db.query(
    `SELECT code, pay_ratio, note FROM leave_type WHERE is_system ORDER BY code`)).rows;
  const annual = sys.find(x => x.code === 'ANNUAL');
  const sick = sys.find(x => x.code === 'SICK');
  const personal = sys.find(x => x.code === 'PERSONAL');
  rec('LVT1', '官方 7 个假种预置好：年假 100%、事假 0%、病假按工龄（比例为 NULL）',
      sys.length === 7 && Number(annual?.pay_ratio) === 1
      && Number(personal?.pay_ratio) === 0 && sick?.pay_ratio === null,
      `官方=${sys.length}个 年假=${annual?.pay_ratio} 事假=${personal?.pay_ratio} 病假=${sick?.pay_ratio}`);
}

{ // 官方假种不可删、code 不可改
  let del = '', ren = '';
  try { await db.query(`DELETE FROM leave_type WHERE code='ANNUAL'`); } catch (e) { del = e.message; }
  try { await db.query(`UPDATE leave_type SET code='ANNUAL_X' WHERE code='ANNUAL'`); }
  catch (e) { ren = e.message; }
  rec('LVT2', '官方假种不能删、代码不能改（删了历史请假单指向空白，改 code 算钱静默失配）',
      /E_LEAVE_TYPE_SYSTEM/.test(del) && /E_LEAVE_TYPE_SYSTEM/.test(ren),
      `${String(del).slice(0, 20)} / ${String(ren).slice(0, 20)}`);
}

{ // 自定义假种：公司自己加一个"哺乳假"，全薪，不扣钱
  await db.query(`INSERT INTO leave_type(id, code, name, expire_policy, is_system, pay_ratio, note)
                  SELECT COALESCE((SELECT max(id) FROM leave_type),0)+1,
                         'NURSING','哺乳假','void', false, 1.000, '公司自定义：每天 1 小时，全薪'
                   WHERE NOT EXISTS (SELECT 1 FROM leave_type WHERE code='NURSING')`);
  const rows = (await db.query(
    `SELECT code, is_system, pay_ratio FROM leave_type WHERE code='NURSING'`)).rows[0];
  rec('LVT3', '公司可以自己加假种（哺乳假）：非 system、比例 1.0 = 全薪不扣',
      rows && rows.is_system === false && Number(rows.pay_ratio) === 1,
      `system=${rows?.is_system} 比例=${rows?.pay_ratio}`);
}

{ // 自定义假种的扣款：改成 0 比例就全扣，证明它真的参与计算（不是只登记）
  const mk = async (ratio) => {
    await db.query(`UPDATE leave_type SET pay_ratio=$1 WHERE code='NURSING'`, [ratio]);
    const ltId = (await db.query(`SELECT id FROM leave_type WHERE code='NURSING'`)).rows[0].id;
    await db.query(`DELETE FROM leave_request WHERE employee_id=$1 AND leave_type_id=$2`,
      [ST_PERSON, ltId]);
    await db.query(`INSERT INTO leave_request(employee_id, leave_type_id, qty, date_from, date_to,
                      status, decided_at)
                    VALUES ($1,$2,1,'2026-08-10','2026-08-10','approved', now())`,
      [ST_PERSON, ltId]);
    return Number((await db.query(`SELECT fn_leave_deduction($1,'2026-08') d`,
      [ST_PERSON])).rows[0].d);
  };
  const full = await mk(1);      // 全薪：这条假不扣钱
  const zero = await mk(0);      // 全扣：多扣一天日薪
  const monthly = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=40
      AND effective_from <= '2026-08-31' ORDER BY effective_from DESC LIMIT 1`)).rows[0].m);
  const oneDay = Math.round(monthly / 21.75 * 100) / 100;
  rec('LVT4', '自定义假种的带薪比例真的参与扣款：1.0 不扣、0 全扣一天（差一天日薪）',
      Math.abs(zero - full - oneDay) < 0.05,
      `全薪=${full} 全扣=${zero} 差=${(zero - full).toFixed(2)} 期望=${oneDay}`);
  // 清掉测试用的请假，别影响后面的断言
  const ltId = (await db.query(`SELECT id FROM leave_type WHERE code='NURSING'`)).rows[0].id;
  await db.query(`DELETE FROM leave_request WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, ltId]);
}

// ===========================================================================
// OTCR 组 · 补休抵扣（128）：只有休息日能抵，法定与平日只能给钱
// ---------------------------------------------------------------------------
// 复用 OT 组造的 2026-11 三天：11-02(周一10h) / 11-07(周六8h) / 11-11(法定8h)
// ===========================================================================
{
  // 法定节假日与平日都不许补休 —— 法条措辞不同，59 条只对休息日给了补休这个选项
  let holidayMsg = '', weekdayMsg = '';
  try {
    await db.query(`SELECT fn_ot_comp_register($1,'2026-11-11',8,NULL,'法定那天想补休','hr')`,
      [ST_PERSON]);
  } catch (e) { holidayMsg = e.message; }
  try {
    await db.query(`SELECT fn_ot_comp_register($1,'2026-11-02',8,NULL,'平日想补休','hr')`,
      [ST_PERSON]);
  } catch (e) { weekdayMsg = e.message; }
  rec('OTCR1', '法定节假日加班不能补休（必须 300%）、平日延长不能补休（必须 150%）',
      /E_OT_COMP_ILLEGAL/.test(holidayMsg) && /E_OT_COMP_ILLEGAL/.test(weekdayMsg),
      `${String(holidayMsg).slice(0,22)} / ${String(weekdayMsg).slice(0,22)}`);
}

{ // 休息日可以：8 小时里补 4 小时
  const id = Number((await db.query(
    `SELECT fn_ot_comp_register($1,'2026-11-07',4,'2026-11-09','周六加班半天，周一补休','hr') i`,
    [ST_PERSON])).rows[0].i);
  // 再补 8 小时就超过那天的 8 小时加班
  let over = '';
  try {
    await db.query(`SELECT fn_ot_comp_register($1,'2026-11-07',8,'2026-11-10','再多补一天','hr')`,
      [ST_PERSON]);
  } catch (e) { over = e.message; }
  rec('OTCR2', '休息日可登记补休；超过那天实际加班工时 → 拒（E_OT_COMP_OVER）',
      id > 0 && /E_OT_COMP_OVER/.test(over), `补休单=${id} 超额=${String(over).slice(0,30)}`);
}

{ // deduct 模式：应付 200% 的工时 = 8 − 4 = 4；pay 模式仍按 8
  const pay = (await db.query(`SELECT * FROM fn_att_ot_split($1,'2026-11')`, [ST_PERSON])).rows[0];
  await db.query(`UPDATE policy_value SET value_text='deduct'
                   WHERE policy_code='PAY_OT_COMP_REST' AND effective_from='2026-01-01'`);
  const ded = (await db.query(`SELECT * FROM fn_att_ot_split($1,'2026-11')`, [ST_PERSON])).rows[0];
  rec('OTCR3', 'pay 模式按 8h 付 200%；deduct 模式扣掉补休 4h，只按 4h 付',
      Number(pay.restday_ot) === 8 && Number(pay.restday_paid) === 8
      && Number(ded.restday_ot) === 8 && Number(ded.restday_paid) === 4
      && Number(ded.restday_rested) === 4,
      `pay=${pay.restday_paid} deduct=${ded.restday_paid} 已补休=${ded.restday_rested}`);
}

{ // 算薪金额跟着变：少付 4 小时 × 2 倍 = 8 个时薪
  await db.query(`UPDATE policy_value SET value_text='on'
                   WHERE policy_code='PAY_OT_AUTO' AND effective_from='2026-01-01'`);
  const runId = Number((await db.query(
    `SELECT id FROM pay_run WHERE period='2026-11' AND legal_entity_id=1 AND kind='monthly'`,
  )).rows[0].id);
  const otOf = async () => {
    await db.query(`SELECT fn_payroll_calc($1)`, [runId]);
    const slip = (await db.query(`SELECT id FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
      [runId, ST_PERSON])).rows[0];
    return Number((await db.query(`SELECT amount FROM payslip_item
                                    WHERE payslip_id=$1 AND item_code='OT_PAY'`,
      [slip.id])).rows[0]?.amount ?? 0);
  };
  const withDeduct = await otOf();
  await db.query(`UPDATE policy_value SET value_text='pay'
                   WHERE policy_code='PAY_OT_COMP_REST' AND effective_from='2026-01-01'`);
  const withoutDeduct = await otOf();
  const monthly = Number((await db.query(
    `SELECT monthly_amount m FROM salary_standard WHERE employment_id=40
      AND effective_from <= '2026-11-30' ORDER BY effective_from DESC LIMIT 1`)).rows[0].m);
  const diff = Math.round(monthly / 21.75 / 8 * 4 * 2 * 100) / 100;   // 4h × 2 倍
  rec('OTCR4', '补休抵扣真的少付：差额 = 4 小时 × 2 倍时薪（不是只改个标记）',
      Math.abs(withoutDeduct - withDeduct - diff) < 0.05,
      `有补休=${withDeduct} 无补休=${withoutDeduct} 差=${(withoutDeduct - withDeduct).toFixed(2)} 期望=${diff}`);
  await db.query(`UPDATE policy_value SET value_text='off'
                   WHERE policy_code='PAY_OT_AUTO' AND effective_from='2026-01-01'`);
}


// ===========================================================================
// HOLY 组 · 节假日年度维护（130）：缺口要看得见，骨架只给公历
// ---------------------------------------------------------------------------
// 130 之前，客户 12 月算明年 1 月的薪时，元旦会被当成工作日 ——
// 那天上班按 150% 给（该给 300%），少付且没有任何报错。
// 这一组钉的是"系统会自己说出哪里缺"，不是"客户记得去补"。
// ===========================================================================
{
  const check = async (y) => (await db.query(
    `SELECT level, code, hint FROM fn_holiday_year_check($1)`, [y])).rows;
  const codes = async (y) => (await check(y)).map(r => r.code);

  { // HOLY1 整年没数据 → error（不是 warn：这个错会直接少付钱）
    const r = await check(2027);
    rec('HOLY1', '2027 年一条数据都没有 → 直接报 error（应出勤会按纯周末算）',
      r.length === 1 && r[0].level === 'error' && r[0].code === 'HOL_NO_DATA',
      `${r.length} 条 / ${r[0]?.level} ${r[0]?.code}`);
  }

  { // HOLY2 骨架只给公历固定的 5 天，全部待确认
    const n = Number((await db.query(`SELECT fn_holiday_skeleton(2027,'hr') n`)).rows[0].n);
    const rows = (await db.query(
      `SELECT holiday_date::text d, holiday_type t, is_confirmed c, source s
         FROM legal_holiday WHERE EXTRACT(year FROM holiday_date)=2027 ORDER BY holiday_date`)).rows;
    rec('HOLY2', '骨架只生成元旦/劳动/国庆（公历固定）5 天，全部标"待确认"',
      n === 5 && rows.length === 5 && rows.every(r => !r.c) && rows.every(r => r.s === 'skeleton')
      && !rows.some(r => /春节|端午|中秋/.test(r.d)),
      `生成=${n} 条 ${rows.map(r => r.d.slice(5)).join(',')}`);
  }

  { // HOLY3 骨架幂等：再跑一次不新增（人已经填过的不覆盖）
    const n2 = Number((await db.query(`SELECT fn_holiday_skeleton(2027,'hr') n`)).rows[0].n);
    rec('HOLY3', '骨架可重复执行：已存在的日期不覆盖、不重复插入', n2 === 0, `第二次生成=${n2}`);
  }

  { // HOLY4 待确认会被报出来；确认之后不再报
    const before = await codes(2027);
    const n = Number((await db.query(`SELECT fn_holiday_confirm(2027,'hr') n`)).rows[0].n);
    const after = await codes(2027);
    rec('HOLY4', '"待确认"是个状态：生成后报 HOL_UNCONFIRMED，确认后不再报',
      before.includes('HOL_UNCONFIRMED') && n === 5 && !after.includes('HOL_UNCONFIRMED'),
      `确认前=${before.join('/')} 确认=${n} 条 之后=${after.join('/') || '无'}`);
  }

  { // HOLY5 法定天数与制度值不符要报（骨架只有 5 天，制度是 11 天）
    const c = await codes(2027);
    rec('HOLY5', '法定天数 5 ≠ 制度 11 天 → 报 HOL_LEGAL_COUNT（漏录农历节日）',
      c.includes('HOL_LEGAL_COUNT'), c.join('/') || '无');
  }

  { // HOLY6 调休上班填在工作日 → 报（应出勤会多加一天）
    // 2027-01-05 是周二，标成"调休上班"就是错的
    await db.query(`INSERT INTO legal_holiday(holiday_date,name,is_workday,holiday_type,
                      is_confirmed,source) VALUES ('2027-01-05','错标的调休',true,'workday',true,'manual')`);
    const r = await check(2027);
    const bad = r.find(x => x.code === 'HOL_MAKEUP_WEEKDAY');
    rec('HOLY6', '调休上班填在周二 → 报 HOL_MAKEUP_WEEKDAY（那天本来就是工作日）',
      !!bad, bad ? bad.hint.slice(0, 46) : '没报');
    await db.query(`DELETE FROM legal_holiday WHERE holiday_date='2027-01-05'`);
  }

  { // HOLY7 有调休放假却没有调休上班 → 报
    await db.query(`INSERT INTO legal_holiday(holiday_date,name,is_workday,holiday_type,
                      is_confirmed,source) VALUES ('2027-01-02','元旦调休','false','rest',true,'manual')`);
    const r = await codes(2027);
    rec('HOLY7', '有调休放假但没有任何调休上班 → 报 HOL_NO_MAKEUP（长假要挪周末）',
      r.includes('HOL_NO_MAKEUP'), r.join('/'));
  }

  { // HOLY8 覆盖表：2026 ok、2027 待补/已确认但天数不够
    const cov = (await db.query(`SELECT * FROM fn_holiday_coverage(2026,2)`)).rows;
    const y26 = cov.find(x => Number(x.year) === 2026);
    const y27 = cov.find(x => Number(x.year) === 2027);
    // 2026 的法定天数用 >=11：前面的 HOL 组会往里插"测试用假日"，
    // 写死 ==11 会让这条断言变成"有没有人插过测试数据"，而不是"覆盖表对不对"。
    rec('HOLY8', '覆盖表一眼看出哪年没数据：2026 已齐（>=11 天），2027 只有骨架 5 天',
      Number(y26.legal_days) >= 11 && y26.state === 'ok' && Number(y27.legal_days) === 5,
      `2026 legal=${y26.legal_days} ${y26.state} / 2027 legal=${y27.legal_days} ${y27.state}`);
  }

  // 收尾：把 2027 的骨架清掉，别把"半成品数据"留给后面的组
  await db.query(`DELETE FROM legal_holiday WHERE EXTRACT(year FROM holiday_date) = 2027`);
}

// ===========================================================================
// WTS 组 · 综合计算工时制（131）：超时看周期总数，不看每天
// ---------------------------------------------------------------------------
// 同一份考勤，标准工时与综合工时给出**不同**的加班小时，而且两个方向都会错：
//   · 淡季某天干 10 小时 → 标准算法当天就给 150%，但周期总工时可能没超（多付）；
//   · 旺季连续每天 9 小时 → 标准算法只算每天超出的 1 小时（少付）。
// 这一组用 2027-Q1 三个月的考勤把两种算法摆在同一个季度里比。
// ===========================================================================
{
  const ADS3 = `INSERT INTO attendance_daily_store
    (employee_id, store_id, work_date, shift_start_at, shift_end_at,
     span_hours, on_duty_hours, off_duty_hours, break_on_duty_hours,
     in_attendance_hours, work_hours, snap_on_duty_break_basis)
    VALUES ($1, 1, $2::date,
            (($2::date + time '09:00') AT TIME ZONE 'Asia/Shanghai'),
            (($2::date + time '09:00') AT TIME ZONE 'Asia/Shanghai') + ($3::numeric * interval '1 hour'),
            $3::numeric, $3::numeric, 0, 0, $3::numeric, $3::numeric, 'hourly')`;
  // ★ span_hours 必须等于 shift_end − shift_start（chk_ads_span），
  //   所以结束时刻按实际工时往后推，不能写死 18:00 —— 写死的话干 10 小时会撞约束。

  const seed = async (dates, hours) => {
    for (const d of dates) await db.query(ADS3, [ST_PERSON, d, hours]);
  };
  const split = async (period) => (await db.query(
    `SELECT * FROM fn_att_ot_split($1,$2)`, [ST_PERSON, period])).rows[0];

  await db.query(`DELETE FROM attendance_daily_store
                   WHERE employee_id=$1 AND work_date BETWEEN '2027-01-01' AND '2027-03-31'`,
    [ST_PERSON]);
  await db.query(`DELETE FROM legal_holiday WHERE holiday_date BETWEEN '2027-01-01' AND '2027-03-31'`);
  await db.query(`UPDATE employment SET work_time_system='comp_quarter',
                   comp_approved_until='2027-12-31' WHERE id=$1`, [ST_EMP]);

  // 2027-01：只上 15 天，每天 10 小时 → 150h，而 1 月法定 21 天×8=168h（没超）
  const jan = [];
  for (let d = 1; jan.length < 15 && d <= 31; d++) {
    const dt = `2027-01-${String(d).padStart(2, '0')}`;
    const dow = new Date(dt + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) jan.push(dt);
  }
  await seed(jan, 10);

  { // WTS1 周期边界
    const cp = (await db.query(
      `SELECT sys, from_date::text f, to_date::text t, settle_period
         FROM fn_comp_period($1,'2027-02')`, [ST_PERSON])).rows[0];
    rec('WTS1', '季度综合工时的周期边界：Q1 = 1/1–3/31，结算月是 3 月',
      cp.sys === 'comp_quarter' && cp.f === '2027-01-01' && cp.t === '2027-03-31'
      && cp.settle_period === '2027-03',
      `${cp.sys} ${cp.f}~${cp.t} → ${cp.settle_period}`);
  }

  { // WTS2 淡季：单日超 8 小时，但周期总数没超 → 不付
    const r = await split('2027-01');
    rec('WTS2', '淡季每天 10 小时但周期总工时没超 → 综合工时给 0（标准算法会给 30 小时）',
      Number(r.weekday_ot) === 0 && Number(r.restday_ot) === 0,
      `15 天×10h=${jan.length * 10}h < 168h → 平日加班=${r.weekday_ot}`);
  }

  { // WTS3 非结算月：2 月累计也不出超时（要等季末）
    const feb = [], wk = [];
    for (let d = 1; d <= 28; d++) {
      const dt = `2027-02-${String(d).padStart(2, '0')}`;
      const dow = new Date(dt + 'T00:00:00Z').getUTCDay();
      if (dow !== 0 && dow !== 6) feb.push(dt); else if (wk.length < 2) wk.push(dt);
    }
    await seed(feb, 8);
    await seed(wk, 8);
    const r = await split('2027-02');
    rec('WTS3', '2 月不是结算月：累计工时先攒着，这一期不出超时',
      Number(r.weekday_ot) === 0 && Number(r.restday_ot) === 0,
      `2 月 ${feb.length} 个工作日 + 2 个周六 → 平日=${r.weekday_ot} 休息日=${r.restday_ot}`);
  }

  { // WTS4 季末结算
    const mar = [];
    for (let d = 1; d <= 31; d++) {
      const dt = `2027-03-${String(d).padStart(2, '0')}`;
      const dow = new Date(dt + 'T00:00:00Z').getUTCDay();
      if (dow !== 0 && dow !== 6) mar.push(dt);
    }
    await seed(mar, 10);
    const r = await split('2027-03');
    const st = (await db.query(`SELECT * FROM fn_att_comp_status($1,'2027-03')`, [ST_PERSON])).rows[0];
    rec('WTS4', '季末一次结算：季度实际工时 − 季度法定工时，超出部分按 150%',
      Number(r.weekday_ot) === 44 && st.is_settle === true && Number(st.ot_hours) === 44,
      `实际=${st.actual_hours}h 法定=${st.std_hours}h 超时=${st.ot_hours}h → 平日=${r.weekday_ot} 休息日=${r.restday_ot}`);
  }

  { // WTS5 休息日不单独 200%
    const r = await split('2027-03');
    rec('WTS5', '综合工时下休息日上班不单独给 200%：计入总数，超了统一按 150%',
      Number(r.restday_ot) === 0 && Number(r.restday_paid) === 0,
      `休息日=${r.restday_ot} 应付=${r.restday_paid}（2 月那两个周六的 16 小时已并入总数）`);
  }

  { // WTS6 separate 模式
    await db.query(`UPDATE policy_value SET value_text='separate'
                     WHERE policy_code='PAY_COMP_RESTDAY'`);
    const r = await split('2027-03');
    await db.query(`UPDATE policy_value SET value_text='include'
                     WHERE policy_code='PAY_COMP_RESTDAY'`);
    rec('WTS6', '改口径 → separate 模式把休息日工时拿出来单算 200%，超时相应减少',
      Number(r.weekday_ot) === 28 && Number(r.restday_ot) === 16 && Number(r.restday_paid) === 16,
      `平日=${r.weekday_ot} 休息日=${r.restday_ot}（include 时是 44/0）`);
  }

  { // WTS7 法定节假日单独 300%，不进总数
    const before = await split('2027-03');
    await db.query(`INSERT INTO legal_holiday(holiday_date,name,is_workday,holiday_type,is_confirmed,source)
                    VALUES ('2027-03-08','测试法定假','false','legal',true,'manual')`);
    const after = await split('2027-03');
    // ★ 期望不是"超时不变"：法定日那 10 小时从实际工时里拿出去（按 300% 单独付），
    //   而法定工时那边只减少 1 天（8 小时），所以净减少 2 小时 —— 这正是那 2 小时
    //   超出标准工时的部分，它跟着 300% 一起付了，不该再进 150% 的池子。
    const drop = Number(before.weekday_ot) - Number(after.weekday_ot);
    rec('WTS7', '法定节假日单独 300% 且不计入总数：那天多干的 2 小时不再进 150% 的池子',
      Number(after.holiday_ot) === 10 && drop === 2,
      `法定小时=${after.holiday_ot}（那天 10h 全按 300%）平日 ${before.weekday_ot}→${after.weekday_ot}（净减 ${drop}）`);
    await db.query(`DELETE FROM legal_holiday WHERE holiday_date='2027-03-08'`);
  }

  { // WTS8 修掉的老 bug：法定日上班 13 小时，那 5 小时不再算两遍
    // 清空整月再只留那一天：否则 3 月每天 10 小时的既有数据会让"平日=44"
    await db.query(`DELETE FROM attendance_daily_store
                     WHERE employee_id=$1 AND work_date BETWEEN '2027-03-01' AND '2027-03-31'`,
      [ST_PERSON]);
    await db.query(`UPDATE employment SET work_time_system=NULL WHERE id=$1`, [ST_EMP]);
    await db.query(`INSERT INTO legal_holiday(holiday_date,name,is_workday,holiday_type,is_confirmed,source)
                    VALUES ('2027-03-08','测试法定假','false','legal',true,'manual')`);
    await seed(['2027-03-08'], 13);
    const r = await split('2027-03');
    rec('WTS8', '法定日上班 13 小时：5 小时超出部分不再同时算平日（原来会被付 300%+150%）',
      Number(r.holiday_ot) === 13 && Number(r.weekday_ot) === 0,
      `法定=${r.holiday_ot} 平日=${r.weekday_ot}（修前平日会是 5）`);
    await db.query(`DELETE FROM legal_holiday WHERE holiday_date='2027-03-08'`);
  }

  { // WTS9 不定时
    await db.query(`UPDATE employment SET work_time_system='flexible', comp_approved_until='2027-12-31'
                     WHERE id=$1`, [ST_EMP]);
    await db.query(`DELETE FROM attendance_daily_store
                     WHERE employee_id=$1 AND work_date BETWEEN '2027-01-01' AND '2027-03-31'`,
      [ST_PERSON]);
    await seed(['2027-03-08', '2027-03-09'], 12);
    await db.query(`INSERT INTO legal_holiday(holiday_date,name,is_workday,holiday_type,is_confirmed,source)
                    VALUES ('2027-03-08','测试法定假','false','legal',true,'manual')`);
    const r = await split('2027-03');
    const st = (await db.query(`SELECT * FROM fn_att_comp_status($1,'2027-03')`, [ST_PERSON])).rows[0];
    rec('WTS9', '不定时工作制：平日不按小时算加班，法定节假日仍 300%',
      Number(r.weekday_ot) === 0 && Number(r.restday_ot) === 0 && Number(r.holiday_ot) === 12,
      `平日=${r.weekday_ot} 法定=${r.holiday_ot} 备案=${String(st.approved_until).slice(0,10)} ok=${st.approved_ok}`);
  }

  // 收尾：清考勤与节假日，把工时制度改回空
  await db.query(`DELETE FROM legal_holiday WHERE holiday_date BETWEEN '2027-01-01' AND '2027-03-31'`);
  await db.query(`DELETE FROM attendance_daily_store
                   WHERE employee_id=$1 AND work_date BETWEEN '2027-01-01' AND '2027-03-31'`, [ST_PERSON]);
  await db.query(`UPDATE employment SET work_time_system=NULL, comp_approved_until=NULL WHERE id=$1`, [ST_EMP]);
}

// ===========================================================================
// SPL 组 · 2008 年前入职的补偿分段（135）
// ---------------------------------------------------------------------------
// 第 97 条：2008-01-01 前按老办法、之后按新法，两段各自算完相加。
// 差别只有三处，但每一处都直接改金额：
//   ① 前段不封顶（老办法没有"三倍社平"这个概念）；
//   ② 后段才封 12 年；
//   ③ 前段的 12 个月上限按情形分（第 5/6 条有、第 7/9 条没有），做成制度项。
// 低薪时"分段"与"不分段"数学上等价 —— 这正是 SPL2 要证明的：没引入偏差。
// ===========================================================================
{
  // 社平工资：库测试不走 server 种子，这里自己补（SEV 组也会补，但它在后面跑）
  await db.query(`INSERT INTO local_avg_wage(city,wage_year,monthly,note)
                  VALUES ('上海',2026,10338,'测试：当地职工月平均工资')
                  ON CONFLICT (city,wage_year) DO NOTHING`);
  const cap = Number((await db.query(
    `SELECT (monthly*3) c FROM local_avg_wage WHERE city='上海'
      ORDER BY wage_year DESC LIMIT 1`)).rows[0].c);
  // 本组自己的离职日（SEV 组的 leave37 是块级变量，这里拿不到）
  const hire0 = (await db.query(
    `SELECT hire_date::text h FROM employment WHERE id=$1`, [ST_EMP])).rows[0].h;
  const leave0 = (await db.query(
    `SELECT ($1::date + interval '3 years 7 months')::date::text d`, [hire0])).rows[0].d;

  // 临时员工：2000-01-01 入职（跨 2008 分界），没有工资条 → 回退月薪标准
  await db.query(`INSERT INTO person(id, full_name) VALUES (9902,'测试老员工')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id, person_id, legal_entity_id, hire_date)
                  VALUES (9902, 9902, 1, '2000-01-01') ON CONFLICT (id) DO NOTHING`);
  await db.query(`UPDATE employment SET hire_date='2000-01-01' WHERE id=9902`);
  await db.query(`DELETE FROM salary_standard WHERE employment_id=9902`);
  await db.query(`INSERT INTO salary_standard(employment_id, monthly_amount, effective_from)
                  VALUES (9902, 8000, '2026-01-01')`);

  { // SPL1 2008 后入职不分段
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc($1,$2::date,'mutual','上海',false)`,
      [ST_EMP, leave0])).rows[0];
    rec('SPL1', '2008-01-01 之后入职 → 不分段（split=false，走 47 条一套算法）',
      c.split === false && Number(c.pre2008_months) === 0,
      `分段=${c.split} 前段月数=${c.pre2008_months}`);
  }

  { // SPL2 低薪：分段与不分段等价
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc(9902,'2026-07-01','mutual','上海',false)`)).rows[0];
    const totalN = Number(c.n_old) + Number(c.n_new);
    rec('SPL2', '低薪时分段与不分段等价：前段 8 年 + 后段 19 年 = 总 27（没有凭空多算或少算）',
      c.split === true && Number(c.n_old) === 8 && Number(c.n_new) === 19
      && Math.abs(totalN - Number(c.n_months)) < 0.001
      && Math.abs(Number(c.severance) - 8000 * 27) < 0.01,
      `前段 N=${c.n_old}（${c.pre2008_months} 月）后段 N=${c.n_new}（${c.post2008_months} 月）`
      + ` 合计 ${c.severance}`);
  }

  { // SPL3 高薪：前段不封顶，这就是"少算"的那部分
    await db.query(`UPDATE salary_standard SET monthly_amount=50000 WHERE employment_id=9902`);
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc(9902,'2026-07-01','mutual','上海',false)`)).rows[0];
    // 前段：8 × 50000 = 400000（不封顶）；后段：19 年但要封 12 年 → 12 × 31014
    const expOld = 8 * 50000;
    const expNew = 12 * cap;
    rec('SPL3', '高薪时前段不封顶：8 年 × 50000 + 19 年 × 三倍社平，而不是全按 12 年封顶',
      Math.abs(Number(c.severance_old) - expOld) < 0.01
      && Math.abs(Number(c.severance_new) - expNew) < 0.01
      && Math.abs(Number(c.severance) - (expOld + expNew)) < 0.01
      && Number(c.severance) > 12 * cap,
      `前段=${c.severance_old}（不封顶）后段=${c.severance_new}（×三倍 ${cap}）`
      + ` 合计=${c.severance}；全按新法封顶只有 ${12 * cap}`);
    await db.query(`UPDATE salary_standard SET monthly_amount=8000 WHERE employment_id=9902`);
  }

  { // SPL4 老办法的 12 个月上限（按情形，制度项控制）
    await db.query(`UPDATE employment SET hire_date='1990-01-01' WHERE id=9902`);
    const before = (await db.query(
      `SELECT * FROM fn_severance_calc(9902,'2026-07-01','mutual','上海',false)`)).rows[0];
    await db.query(`UPDATE policy_value SET value_num=12
                     WHERE policy_code='SEVERANCE_OLD_CAP_MONTHS'`);
    const after = (await db.query(
      `SELECT * FROM fn_severance_calc(9902,'2026-07-01','mutual','上海',false)`)).rows[0];
    await db.query(`UPDATE policy_value SET value_num=0
                     WHERE policy_code='SEVERANCE_OLD_CAP_MONTHS'`);
    rec('SPL4', '老办法的 12 个月上限做成制度项：默认 0 不设，设 12 后前段真的被截',
      Number(before.n_old) === 18 && Number(after.n_old) === 12,
      `1990 入职：默认前段 N=${before.n_old}，设上限 12 后 N=${after.n_old}`);
    await db.query(`UPDATE employment SET hire_date='2000-01-01' WHERE id=9902`);
  }

  { // SPL5 老办法进位口径可切
    await db.query(`UPDATE employment SET hire_date='2000-07-01' WHERE id=9902`);
    const half = (await db.query(
      `SELECT * FROM fn_severance_calc(9902,'2026-07-01','mutual','上海',false)`)).rows[0];
    await db.query(`UPDATE policy_value SET value_text='year'
                     WHERE policy_code='SEVERANCE_OLD_ROUND'`);
    const year = (await db.query(
      `SELECT * FROM fn_severance_calc(9902,'2026-07-01','mutual','上海',false)`)).rows[0];
    await db.query(`UPDATE policy_value SET value_text='half'
                     WHERE policy_code='SEVERANCE_OLD_ROUND'`);
    // 2000-07 到 2007-12-31 = 7 年 5 个月 30 天 → half 进位 7.5、year 只算 7
    rec('SPL5', '老办法进位口径可切：2000-07 入职 → half 进位 7.5 年、year 严格只算 7 年',
      Number(half.n_old) === 7.5 && Number(year.n_old) === 7,
      `half=${half.n_old} year=${year.n_old}`);
  }

  // 收尾
  await db.query(`UPDATE policy_value SET value_num=0 WHERE policy_code='SEVERANCE_OLD_CAP_MONTHS'`);
  await db.query(`UPDATE policy_value SET value_text='half' WHERE policy_code='SEVERANCE_OLD_ROUND'`);
  await db.query(`DELETE FROM severance_settlement WHERE employment_id=9902`);
  await db.query(`DELETE FROM salary_standard WHERE employment_id=9902`);
  await db.query(`DELETE FROM employment WHERE id=9902`);
  await db.query(`DELETE FROM person WHERE id=9902`);
}

// ===========================================================================
// SEV 组 · 离职结算（134）：年限半年进位 / 三倍封顶 / 补偿金单独计税
// ---------------------------------------------------------------------------
// 这是离职时最大的一笔钱，也是错一次就上仲裁的一笔。
// 三个最容易错的地方：年限怎么进位、高薪怎么封顶、补偿金怎么计税。
// ===========================================================================
{
  // 社平工资（三倍封顶与免税额度都按它）：库测试不走 server 的种子块，这里自己给一条。
  // 真实环境由统计局公布，界面上手工录 —— 这个数不该猜。
  await db.query(`DELETE FROM local_avg_wage`);
  await db.query(`INSERT INTO local_avg_wage(city,wage_year,monthly,note)
                  VALUES ('上海',2026,10338,'测试：当地职工月平均工资')`);

  const nOf = async (m, d) => Number((await db.query(
    `SELECT fn_severance_n($1,$2) n`, [m, d])).rows[0].n);

  { // SEV1 年限进位（第 47 条）
    const a = await nOf(43, 0);   // 3 年 7 个月
    const b = await nOf(41, 0);   // 3 年 5 个月
    const c = await nOf(36, 0);   // 3 年整
    const d = await nOf(5, 0);    // 5 个月
    const e = await nOf(36, 10);  // 3 年零 10 天
    const f = await nOf(42, 0);   // 3 年 6 个月
    rec('SEV1', '年限进位：满年一个月、余 6 个月按一年、余 1–5 个月或零头按半个月',
      a === 4 && b === 3.5 && c === 3 && d === 0.5 && e === 3.5 && f === 4,
      `3y7m=${a} 3y5m=${b} 3y=${c} 5m=${d} 3y10d=${e} 3y6m=${f}`);
  }

  const hire = (await db.query(
    `SELECT hire_date::text h FROM employment WHERE id=$1`, [ST_EMP])).rows[0].h;
  const leave37 = (await db.query(
    `SELECT ($1::date + interval '3 years 7 months')::date::text d`, [hire])).rows[0].d;
  const avgQ = async () => Number((await db.query(
    `SELECT fn_severance_avg_wage($1,$2::date) a`, [ST_PERSON, leave37])).rows[0].a);

  { // SEV2 正常情形：N × 月工资
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc($1,$2::date,'mutual','上海',false)`,
      [ST_EMP, leave37])).rows[0];
    const avg = await avgQ();
    rec('SEV2', '协商一致解除：N=4，补偿金 = 4 × 前 12 个月平均工资',
      Number(c.service_months) === 43 && Number(c.n_months) === 4
      && Math.abs(Number(c.avg_wage) - avg) < 0.01
      && Math.abs(Number(c.severance) - avg * 4) < 0.01,
      `月数=${c.service_months} N=${c.n_months} 月均=${c.avg_wage} 补偿金=${c.severance}`);
  }

  // 高薪场景用一位"没有工资条"的临时员工：fn_severance_avg_wage 会回退月薪标准，
  // 这样能干净地触发三倍封顶（改既有工资条会被"封账后不可改"的触发器拦住）。
  await db.query(`INSERT INTO person(id, full_name) VALUES (9901,'测试高薪')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id, person_id, legal_entity_id, hire_date)
                  VALUES (9901, 9901, 1, '2010-01-01') ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO salary_standard(employment_id, monthly_amount, effective_from)
                  VALUES (9901, 50000, '2026-01-01')`);

  { // SEV3 三倍封顶
    const cap = Number((await db.query(
      `SELECT (monthly*3) c FROM local_avg_wage WHERE city='上海'
        ORDER BY wage_year DESC LIMIT 1`)).rows[0].c);
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc(9901,'2026-07-01','mutual','上海',false)`)).rows[0];
    rec('SEV3', '月工资高于三倍社平 → 按三倍计，且结算单上标记"已封顶"',
      c.cap_applied === true && Math.abs(Number(c.base_wage) - cap) < 0.01
      && Math.abs(Number(c.severance) - cap * Number(c.n_months)) < 0.01,
      `月均=${c.avg_wage} 三倍=${cap} 用于计算=${c.base_wage} N=${c.n_months} 补偿金=${c.severance}`);
  }

  { // SEV4 封顶后年限最高 12 年（2010 入职、2026 离职 = 16 年）
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc(9901,'2026-07-01','mutual','上海',false)`)).rows[0];
    rec('SEV4', '封顶同时年限封 12 年（高薪 + 16 年工龄 → 实际按 12 个月算）',
      Number(c.n_months) === 12 && c.cap_years_applied === true
      && Number(c.service_months) >= 190,
      `工作月数=${c.service_months}（本该 16 年）N=${c.n_months} 年限封顶=${c.cap_years_applied}`);
  }

  { // SEV5 违法解除 2N
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc($1,$2::date,'illegal','上海',false)`,
      [ST_EMP, leave37])).rows[0];
    const one = (await db.query(
      `SELECT * FROM fn_severance_calc($1,$2::date,'mutual','上海',false)`,
      [ST_EMP, leave37])).rows[0];
    rec('SEV5', '违法解除按 2N（第 87 条）：金额正好是 N 的两倍',
      Number(c.n_months) === 8 && Math.abs(Number(c.severance) - Number(one.severance) * 2) < 0.01,
      `2N=${c.n_months} 金额=${c.severance} vs N=${one.severance}`);
  }

  { // SEV6 代通知金：只有"无过失性辞退"且未提前 30 天
    const withN = (await db.query(
      `SELECT * FROM fn_severance_calc($1,$2::date,'employer_no_fault','上海',true)`,
      [ST_EMP, leave37])).rows[0];
    const without = (await db.query(
      `SELECT * FROM fn_severance_calc($1,$2::date,'mutual','上海',true)`,
      [ST_EMP, leave37])).rows[0];
    rec('SEV6', '代通知金只给第 40 条的情形：无过失性辞退有、协商一致没有',
      Number(withN.notice) > 0 && Number(without.notice) === 0,
      `无过失=${withN.notice} 协商一致=${without.notice}`);
  }

  { // SEV7 个税：3 倍社平以内免征
    const c = (await db.query(
      `SELECT * FROM fn_severance_calc($1,$2::date,'mutual','上海',false)`,
      [ST_EMP, leave37])).rows[0];
    const cap = Number((await db.query(
      `SELECT (monthly*3) c FROM local_avg_wage WHERE city='上海'
        ORDER BY wage_year DESC LIMIT 1`)).rows[0].c);
    rec('SEV7', '补偿金个税：3 倍社平（' + cap + '）以内免征，本例应缴 0',
      Math.abs(Number(c.exempt) - cap) < 0.01 && Number(c.taxable) === 0
      && Number(c.tax) === 0,
      `免税额=${c.exempt} 应税=${c.taxable} 税=${c.tax}`);
  }

  { // SEV8 超免税额的部分单独计税（不并入综合所得）
    const t = (await db.query(
      `SELECT * FROM fn_severance_tax(500000,'上海',2026)`)).rows[0];
    const expectTax = Number((await db.query(
      `SELECT fn_iit_cumulative($1) t`, [Number(t.taxable)])).rows[0].t);
    rec('SEV8', '超免税额的部分单独适用综合所得税率表（不乘 12、不与工资合并）',
      Number(t.taxable) > 0 && Math.abs(Number(t.tax) - expectTax) < 0.01,
      `应税=${t.taxable} 税=${t.tax}（按年表=${expectTax}）`);
  }

  { // SEV9 落单 / 确认 / 确认后不能作废
    const id = Number((await db.query(
      `SELECT fn_severance_create($1,$2::date,'mutual','上海','协商一致解除，双方签字确认','hr') i`,
      [ST_EMP, leave37])).rows[0].i);
    const dup = await db.query(
      `SELECT fn_severance_create($1,$2::date,'mutual','上海','再落一张试试','hr') i`,
      [ST_EMP, leave37]).catch(e => e);
    await db.query(`SELECT fn_severance_confirm($1,'boss')`, [id]);
    let msg = '';
    try { await db.query(`SELECT fn_severance_void($1,'想作废这张单试试','hr')`, [id]); }
    catch (e) { msg = e.message; }
    rec('SEV9', '同一段任职只能一张结算单；确认之后不能作废（钱发了只能红冲）',
      id > 0 && String(dup.message || '').includes('uk_ss_once')
      && /E_SEV_CONFIRMED/.test(msg),
      `单号=${id} 重复=${String(dup.message || '').slice(0, 22)} 作废=${String(msg).slice(0, 20)}`);
    await db.query(`DELETE FROM severance_settlement WHERE id=$1`, [id]);
  }

  // 收尾：清掉临时高薪员工
  await db.query(`DELETE FROM salary_standard WHERE employment_id=9901`);
  await db.query(`DELETE FROM employment WHERE id=9901`);
  await db.query(`DELETE FROM person WHERE id=9901`);
}

// ===========================================================================
// SID 组 · 社保申报基数（133）：按上年度月平均，一年只定一次
// ---------------------------------------------------------------------------
// 133 之前基数是"每月按当月月薪标准算一次"。两个后果：
//   · 某人 9 月涨薪，9 月基数当场跟着涨 —— 而社保局收到的是 7 月申报的那个数；
//   · "月薪标准"不等于"上年度月平均工资"（后者含奖金/津贴/加班），少缴要补滞纳金。
// ===========================================================================
{
  await db.query(`DELETE FROM si_base_declare`);
  const pol = (await db.query(
    `SELECT base_floor f, base_ceiling c FROM si_policy
      WHERE city='上海' AND effective_from <= '2027-07-01'
      ORDER BY effective_from DESC LIMIT 1`)).rows[0];

  { // SID1 没有申报记录 → 回退月薪标准（既有行为不变）
    const a = Number((await db.query(
      `SELECT fn_si_base_eff($1,'上海','pension',8000,'2027-08-31') b`, [ST_PERSON])).rows[0].b);
    const b = Number((await db.query(
      `SELECT fn_si_base('上海','pension',8000,'2027-08-31') b`)).rows[0].b);
    rec('SID1', '没有申报记录时回退月薪标准（既有的历史月份重算结果不变）',
      a === b, `eff=${a} 直接夹逼=${b}（下限 ${pol.f} 上限 ${pol.c}）`);
  }

  { // SID2 生成申报基数 = 上年度月平均，夹上下限
    const n = Number((await db.query(
      `SELECT fn_si_declare_build(2027,'上海','2027-07-01','hr') n`)).rows[0].n);
    const d = (await db.query(
      `SELECT monthly_avg::numeric a, base_amount::numeric b, months_counted c
         FROM si_base_declare WHERE employee_id=$1 AND declare_year=2027`, [ST_PERSON])).rows[0];
    const avg = Number((await db.query(
      `SELECT round(avg(p.gross_amount),2) a, count(*) c
         FROM payslip p JOIN pay_run pr ON pr.id=p.pay_run_id
        WHERE p.employee_id=$1 AND pr.period BETWEEN '2026-01' AND '2026-12'
          AND pr.status IN ('sealed','paid') AND pr.kind='monthly'`, [ST_PERSON])).rows[0].a);
    const exp = Math.min(Math.max(avg, Number(pol.f)), Number(pol.c));
    rec('SID2', '申报基数 = 上年度应发月平均，再夹到当地上下限之间',
      n > 0 && Math.abs(Number(d.a) - avg) < 0.01 && Math.abs(Number(d.b) - exp) < 0.01,
      `月平均=${d.a}（独立算=${avg}）申报基数=${d.b}（期望 ${exp}）月数=${d.c}`);
  }

  { // SID3 一年只定一次：月薪翻倍，基数不动
    const before = Number((await db.query(
      `SELECT fn_si_base_eff($1,'上海','pension',8000,'2027-08-31') b`, [ST_PERSON])).rows[0].b);
    const after = Number((await db.query(
      `SELECT fn_si_base_eff($1,'上海','pension',30000,'2027-08-31') b`, [ST_PERSON])).rows[0].b);
    rec('SID3', '一年只定一次：月薪从 8000 涨到 30000，申报基数不动（这才是社保局看到的数）',
      before === after, `月薪 8000→${before} / 月薪 30000→${after}`);
  }

  { // SID4 申报基数超出当期上下限 → 再夹一次
    // 2027-06-30 之前生效的是旧政策；这里只验"夹逼仍然生效"
    const b = Number((await db.query(
      `SELECT fn_si_base_eff($1,'上海','pension',1,'2027-08-31') b`, [ST_PERSON])).rows[0].b);
    rec('SID4', '申报基数再按当期上下限夹一次（去年报的数今年可能已越界）',
      b >= Number(pol.f) && b <= Number(pol.c), `结果=${b} 区间=${pol.f}~${pol.c}`);
  }

  { // SID5 手工改不被重跑冲掉
    await db.query(`SELECT fn_si_declare_set($1,2027,12000,'上海','该员工上年度有一次性奖金，按实际申报','hr')`,
      [ST_PERSON]);
    await db.query(`SELECT fn_si_declare_build(2027,'上海','2027-07-01','hr')`);
    const d = (await db.query(
      `SELECT base_amount::numeric b, source FROM si_base_declare
        WHERE employee_id=$1 AND declare_year=2027`, [ST_PERSON])).rows[0];
    rec('SID5', '手工改过的基数不会被"重新生成"冲掉（否则没人再敢手工改）',
      Number(d.b) === 12000 && d.source === 'manual', `基数=${d.b} 来源=${d.source}`);
  }

  { // SID6 算薪函数真的调了它（接线证据，不是只建了张表）
    const wired = (await db.query(
      `SELECT prosrc LIKE '%fn_si_base_eff%' w FROM pg_proc WHERE proname='fn_payroll_calc'`
    )).rows[0].w;
    const usedNow = Number((await db.query(
      `SELECT fn_si_base_eff($1,'上海','pension',8000,'2027-08-31') b`, [ST_PERSON])).rows[0].b);
    rec('SID6', '算薪主过程真的走申报基数（源码里有调用 + 取数已经是 12000）',
      wired === true && usedNow === 12000, `接线=${wired} 取数=${usedNow}`);
  }

  { // SID7 手工改超范围 → 拒
    let msg = '';
    try {
      await db.query(`SELECT fn_si_declare_set($1,2027,99999,'上海','想报个天价','hr')`, [ST_PERSON]);
    } catch (e) { msg = e.message; }
    rec('SID7', '手工把基数改到上限之外 → 拒（E_SI_BASE_RANGE，不是静默夹掉）',
      /E_SI_BASE_RANGE/.test(msg), String(msg).slice(0, 44));
  }

  { // SID8 上年度没发过薪的人不生成（新入职的等下一个年度）
    const n = Number((await db.query(
      `SELECT fn_si_declare_build(2027,'上海','2027-07-01','hr') n`)).rows[0].n);
    const total = Number((await db.query(
      `SELECT count(*)::int c FROM si_base_declare WHERE declare_year=2027`)).rows[0].c);
    const emps = Number((await db.query(
      `SELECT count(*)::int c FROM employment WHERE leave_date IS NULL`)).rows[0].c);
    rec('SID8', '只给"上年度发过薪"的人生成：上年度没工资条的人不出现（总数 ≤ 在职人数）',
      total <= emps, `在职 ${emps} 人 · 生成 ${total} 条（本次新增/更新 ${n}）`);
  }

  await db.query(`DELETE FROM si_base_declare`);
}

// ===========================================================================
// CARRY 组 · 往年结转（132）：默认不结转、结转有截止日、已休按 FIFO 先扣旧的
// ---------------------------------------------------------------------------
// 129 只算当年，往年余额在台账上"看得见但折不了"—— 那 5 天既没休也没折也没作废，
// 在账上永远欠着，而没有任何报表会列出来。132 加了归属年度之后才说得清。
// ===========================================================================
{
  const ANNUAL2 = (await db.query(`SELECT fn_leave_type_id('ANNUAL') x`)).rows[0].x;
  const setCarry = (pol, dl = '03-31') => db.query(
    `UPDATE policy_value SET value_text=$1 WHERE policy_code='LEAVE_CARRY_POLICY'`, [pol])
    .then(() => db.query(
      `UPDATE policy_value SET value_text=$1 WHERE policy_code='LEAVE_CARRY_DEADLINE'`, [dl]));
  const unusedOn = async (d) => Number((await db.query(
    `SELECT fn_annual_leave_unused($1,$2::date) u`, [ST_PERSON, d])).rows[0].u);

  // 清场：把 ST_PERSON 的年假台账重置成"2026 授 10 天、休 7 天；2027 授 15 天"
  await db.query(`DELETE FROM leave_cashout WHERE employee_id=$1`, [ST_PERSON]);
  await db.query(`DELETE FROM leave_usage WHERE employee_id=$1`, [ST_PERSON]);
  await db.query(`DELETE FROM leave_request WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, ANNUAL2]);
  await db.query(`DELETE FROM leave_grant WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, ANNUAL2]);
  await db.query(`INSERT INTO leave_grant(employee_id,leave_type_id,qty,valid_from,valid_to,leave_year)
                  VALUES ($1,$2,10,'2026-01-01','2026-12-31',2026),
                         ($1,$2,15,'2027-01-01','2027-12-31',2027)`, [ST_PERSON, ANNUAL2]);
  await db.query(`INSERT INTO leave_request(employee_id,leave_type_id,qty,date_from,date_to,
                   status,decided_at) VALUES ($1,$2,7,'2026-05-06','2026-05-12','approved',now())`,
    [ST_PERSON, ANNUAL2]);
  await db.query(`UPDATE employment SET prior_work_years=20 WHERE id=$1`, [ST_EMP]);

  { // CARRY1 默认 void：往年 3 天不参与
    await setCarry('void');
    const u = await unusedOn('2027-03-31');
    rec('CARRY1', '默认 void（法定：一般不跨年）→ 往年剩的 3 天不折现，只算当年',
      u === 3, `2027-03-31 未休=${u} 天（只有当年 15×90/365=3.7→3）`);
  }

  { // CARRY2 改 carry_1y：往年 3 天计入
    await setCarry('carry_1y');
    const u = await unusedOn('2027-03-31');
    rec('CARRY2', '改 carry_1y → 往年剩的 3 天真的计入（配置接线了，不是只登记）',
      u === 6, `往年 3 + 当年 3 = ${u} 天`);
  }

  { // CARRY3 过截止日：照样不计（结转有有效期）
    const u = await unusedOn('2027-06-30');
    rec('CARRY3', '过了结转截止日（次年 3/31）→ 往年那 3 天不再计入，只剩当年',
      u === 7, `2027-06-30 未休=${u} 天（当年 15×181/365=7.4→7）`);
  }

  { // CARRY4 FIFO：已休先扣最早年度
    await db.query(`UPDATE leave_grant SET qty=5 WHERE employee_id=$1 AND leave_type_id=$2
                     AND leave_year=2026`, [ST_PERSON, ANNUAL2]);
    const b = (await db.query(
      `SELECT leave_year, granted, used, remaining, state
         FROM fn_annual_leave_breakdown($1,'2027-03-31') ORDER BY leave_year`,
      [ST_PERSON])).rows;
    const y26 = b.find(x => Number(x.leave_year) === 2026);
    const y27 = b.find(x => Number(x.leave_year) === 2027);
    rec('CARRY4', '已休按 FIFO 先扣最早年度：2026 授 5 天、休 7 天 → 2026 吃满 5，剩 2 记到 2027',
      Number(y26.used) === 5 && Number(y27.used) === 2 && Number(y26.remaining) === 0,
      `2026 used=${y26.used}/rem=${y26.remaining} · 2027 used=${y27.used}`);
  }

  { // CARRY5 breakdown 的年度状态
    await setCarry('void');
    const b0 = (await db.query(
      `SELECT leave_year, state FROM fn_annual_leave_breakdown($1,'2027-03-31')
        ORDER BY leave_year`, [ST_PERSON])).rows;
    await setCarry('carry_1y');
    const b1 = (await db.query(
      `SELECT leave_year, state FROM fn_annual_leave_breakdown($1,'2027-03-31')
        ORDER BY leave_year`, [ST_PERSON])).rows;
    const b2 = (await db.query(
      `SELECT leave_year, state FROM fn_annual_leave_breakdown($1,'2027-06-30')
        ORDER BY leave_year`, [ST_PERSON])).rows;
    rec('CARRY5', '年度状态跟着政策变：not_carried / carried / expired 三种都出得来',
      b0[0].state === 'not_carried' && b1[0].state === 'carried' && b2[0].state === 'expired',
      `${b0[0].state} → ${b1[0].state} → ${b2[0].state}`);
  }

  { // CARRY6 折现真的多给（往年额度可折）
    await db.query(`UPDATE leave_grant SET qty=10 WHERE employee_id=$1 AND leave_type_id=$2
                     AND leave_year=2026`, [ST_PERSON, ANNUAL2]);
    await setCarry('void');
    await db.query(`UPDATE policy_value SET value_text='extra_200'
                     WHERE policy_code='LEAVE_ANNUAL_CASHOUT'`);
    const q0 = (await db.query(`SELECT * FROM fn_annual_leave_quote($1,'2027-03-31')`,
      [ST_PERSON])).rows[0];
    await setCarry('carry_1y');
    const q1 = (await db.query(`SELECT * FROM fn_annual_leave_quote($1,'2027-03-31')`,
      [ST_PERSON])).rows[0];
    rec('CARRY6', '口径开了结转 → 折现试算的天数与金额都变多（不是只改个显示）',
      Number(q1.days) === Number(q0.days) + 3 && Number(q1.amount) > Number(q0.amount),
      `void=${q0.days}天 ${q0.amount}元 / carry_1y=${q1.days}天 ${q1.amount}元`);
    await db.query(`UPDATE policy_value SET value_text='off'
                     WHERE policy_code='LEAVE_ANNUAL_CASHOUT'`);
  }

  { // CARRY7 过期作废留痕
    await setCarry('carry_1y');
    const before = Number((await db.query(
      `SELECT COALESCE(SUM(qty),0) q FROM leave_usage
        WHERE employee_id=$1 AND state='forfeited'`, [ST_PERSON])).rows[0].q);
    const n = Number((await db.query(`SELECT fn_leave_carry_expire($1,'2027-06-30') n`,
      [ST_PERSON])).rows[0].n);
    const after = Number((await db.query(
      `SELECT COALESCE(SUM(qty),0) q FROM leave_usage
        WHERE employee_id=$1 AND state='forfeited'`, [ST_PERSON])).rows[0].q);
    rec('CARRY7', '过了截止日作废往年余额：留 forfeited 行（不删授予），金额对得上',
      n === 1 && after - before === 3, `作废 ${n} 个年度 · forfeited ${before}→${after} 天`);
  }

  // 收尾：恢复默认口径，清掉本组造的数据
  await setCarry('void');
  await db.query(`DELETE FROM leave_cashout WHERE employee_id=$1`, [ST_PERSON]);
  await db.query(`DELETE FROM leave_usage WHERE employee_id=$1`, [ST_PERSON]);
  await db.query(`DELETE FROM leave_request WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, ANNUAL2]);
  await db.query(`DELETE FROM leave_grant WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, ANNUAL2]);
  await db.query(`UPDATE employment SET prior_work_years=0 WHERE id=$1`, [ST_EMP]);
}

// ===========================================================================
// ALC 组 · 未休年假折现（129）
// ---------------------------------------------------------------------------
// 法条里最容易算错的一处：300% **含**正常工资，所以在职折现只能再补 200%。
// 按 300% 全额再发一遍 = 付了 400%，多付一倍，且没人会发现（多付不投诉）。
// 第二处：折算"不足 1 整天不支付"必须 floor，用 round 会多付。
// ===========================================================================
{
  const ANNUAL = (await db.query(`SELECT fn_leave_type_id('ANNUAL') x`)).rows[0].x;
  const setPrior = v => db.query(`UPDATE employment SET prior_work_years=$2 WHERE id=$1`,
    [ST_EMP, Math.max(0, Math.round(v * 10) / 10)]);
  const daysOf = async (on = '2026-07-01') => Number((await db.query(
    `SELECT fn_annual_leave_days($1,$2::date) d`, [ST_PERSON, on])).rows[0].d);
  const setCash = v => db.query(`UPDATE policy_value SET value_text=$1
                                  WHERE policy_code='LEAVE_ANNUAL_CASHOUT'
                                    AND effective_from='2026-01-01'`, [v]);

  // 清场：只清本组会用到的年假单据，别动别的组已经立住的夹具
  await db.query(`DELETE FROM leave_cashout WHERE employee_id=$1`, [ST_PERSON]);
  await db.query(`DELETE FROM leave_usage WHERE employee_id=$1 AND state='frozen'`, [ST_PERSON]);
  await db.query(`DELETE FROM leave_request WHERE employee_id=$1
                   AND (status='pending' OR leave_type_id=$2)`, [ST_PERSON, ANNUAL]);
  await setPrior(0);

  { // AL1 天数按累计工龄取档
    const u = Number((await db.query(
      `SELECT fn_cumulative_years($1,'2026-07-01') u`, [ST_PERSON])).rows[0].u);
    const dA = await daysOf();
    const expA = u >= 20 ? 15 : (u >= 10 ? 10 : 5);
    await setPrior(10.6 - u); const dB = await daysOf();
    await setPrior(20.6 - u); const dC = await daysOf();
    rec('ALC1', '年假天数按累计工龄取档（5/10/15），入司前年限真的算进去',
      dA === expA && dB === 10 && dC === 15,
      `本单位${u}年→${dA}天 / 累计调 10.6年→${dB}天 / 20.6年→${dC}天`);
  }

  { // AL2 法定下限
    let msg = '';
    try { await db.query(`INSERT INTO annual_leave_tier(years_from,days) VALUES (30,3)`); }
    catch (e) { msg = e.message; }
    rec('ALC2', '档位低于法定下限 → 拒（满 20 年只给 3 天，而法定 15 天）',
      /ck_alt_legal/.test(msg), String(msg).slice(0, 40));
  }

  { // AL3 折算 floor
    // 累计 20.6 年 → 全年应享 15 天；2026-07-01 已过 182 天 → 15×182/365 = 7.479
    await db.query(`INSERT INTO leave_grant(employee_id,leave_type_id,qty,valid_from,valid_to)
                    VALUES ($1,$2,30,'2026-01-01','2026-12-31')`, [ST_PERSON, ANNUAL]);
    const raw = Number((await db.query(
      `SELECT fn_annual_leave_unused($1,'2026-07-01') d`, [ST_PERSON])).rows[0].d);
    await db.query(`INSERT INTO leave_request(employee_id,leave_type_id,qty,date_from,date_to,
                     status,decided_at) VALUES ($1,$2,2,'2026-03-02','2026-03-03',
                     'approved', now())`, [ST_PERSON, ANNUAL]);
    const after = Number((await db.query(
      `SELECT fn_annual_leave_unused($1,'2026-07-01') d`, [ST_PERSON])).rows[0].d);
    rec('ALC3', '折算不足 1 整天不支付：15×182/365=7.479 → 7 天（floor 不是 round）',
      raw === 7 && after === 5,
      `折算=${raw}（round 会是 7.479→7 但 0.9 会变 1）/ 已休 2 天后=${after}`);
  }

  { // AL4 只补 200%
    await setCash('extra_200');
    const id = Number((await db.query(
      `SELECT fn_annual_leave_cashout($1,'2026-07-01','2026-08','年假折现（在职）','hr') i`,
      [ST_PERSON])).rows[0].i);
    const c = (await db.query(`SELECT * FROM leave_cashout WHERE id=$1`, [id])).rows[0];
    const exp = Math.round(Number(c.daily_wage) * Number(c.days) * 2 * 100) / 100;
    rec('ALC4', '在职折现只补 200%（300% 已含照发的工资，按 3 倍发就多付一倍）',
      Number(c.rate) === 2 && Number(c.days) === 5 && Math.abs(Number(c.amount) - exp) < 0.01,
      `天数=${c.days} 费率=${c.rate} 日薪=${c.daily_wage} 金额=${c.amount} 验算=${exp}`);

    // AL5 改成一次性 300%：金额正好 1.5 倍
    await db.query(`SELECT fn_annual_leave_cashout_void($1,'改成一次性 300% 口径','hr')`, [id]);
    await setCash('total_300');
    const id2 = Number((await db.query(
      `SELECT fn_annual_leave_cashout($1,'2026-07-01','2026-08','年假折现（一次性）','hr') i`,
      [ST_PERSON])).rows[0].i);
    const c2 = (await db.query(`SELECT * FROM leave_cashout WHERE id=$1`, [id2])).rows[0];
    rec('ALC5', '改口径 → total_300 的金额正好是 extra_200 的 1.5 倍（作废后额度自动加回）',
      Number(c2.rate) === 3 && Number(c2.days) === 5
      && Math.abs(Number(c2.amount) / Number(c.amount) - 1.5) < 0.001,
      `200%=${c.amount} 300%=${c2.amount} 倍数=${(Number(c2.amount) / Number(c.amount)).toFixed(3)}`);

    // AL6 默认 off → 拒
    await db.query(`SELECT fn_annual_leave_cashout_void($1,'本组测试结束','hr')`, [id2]);
    await setCash('off');
    let msg = '';
    try {
      await db.query(`SELECT fn_annual_leave_cashout($1,'2026-07-01','2026-08','不该折的','hr')`,
        [ST_PERSON]);
    } catch (e) { msg = e.message; }
    rec('ALC6', '制度项默认 off → 拒绝登记，一分不折（默认值=上线前行为）',
      /E_ALC_OFF/.test(msg), String(msg).slice(0, 34));
  }

  { // AL7 算薪落账 + 重算幂等
    const runId = Number((await db.query(
      `SELECT id FROM pay_run WHERE period='2026-11' AND legal_entity_id=1 AND kind='monthly'`
    )).rows[0].id);
    const snap = async () => {
      await db.query(`SELECT fn_payroll_calc($1)`, [runId]);
      const g = Number((await db.query(
        `SELECT gross_amount g FROM payslip WHERE pay_run_id=$1 AND employee_id=$2`,
        [runId, ST_PERSON])).rows[0].g);
      const a = (await db.query(
        `SELECT pi.amount a FROM payslip_item pi JOIN payslip p ON p.id=pi.payslip_id
          WHERE p.pay_run_id=$1 AND p.employee_id=$2 AND pi.item_code='AL_CASHOUT'`,
        [runId, ST_PERSON])).rows[0];
      return { gross: g, al: a ? Number(a.a) : 0 };
    };
    await setCash('extra_200');
    const before = await snap();                        // 没有折现单
    const cid = Number((await db.query(
      `SELECT fn_annual_leave_cashout($1,'2026-11-30','2026-11','离职前折现 2026 年假','hr') i`,
      [ST_PERSON])).rows[0].i);
    const after1 = await snap();
    const after2 = await snap();                        // 重算：不能把已落账的单弄丢
    const st = (await db.query(`SELECT status FROM leave_cashout WHERE id=$1`, [cid])).rows[0].status;
    rec('ALC7', '登记后算薪真的多这笔钱、出一行 AL_CASHOUT；重算不会把它弄丢',
      after1.al > 0
      && Math.abs(after1.gross - before.gross - after1.al) < 0.02
      && Math.abs(after2.gross - after1.gross) < 0.02
      && st === 'paid',
      `原=${before.gross} 后=${after1.gross} AL=${after1.al} 重算=${after2.gross} 单据=${st}`);
  }

  { // AL8 余额同步 + 已折的不会被再折一次
    const b = (await db.query(
      `SELECT cashed, available FROM v_leave_balance
        WHERE employee_id=$1 AND leave_type_id=$2`, [ST_PERSON, ANNUAL])).rows[0];
    // 到 12/31 全年 15 天应享，已折 11 天、已休 2 天 → 只剩 2 天（不是 15 天）
    const q = (await db.query(
      `SELECT * FROM fn_annual_leave_quote($1,'2026-12-31')`, [ST_PERSON])).rows[0];
    let msg = '';
    try {
      await db.query(
        `SELECT fn_annual_leave_cashout($1,'2026-12-31','2026-12','再折一次试试','hr')`,
        [ST_PERSON]);
    } catch (e) { msg = e.message; }
    rec('ALC8', '已折现的额度同步扣掉（不会折第二遍）；同年再登记 → 提示先作废',
      Number(b.cashed) === 11 && Number(q.days) === 2 && /E_ALC_EXISTS/.test(msg),
      `台账已折=${b.cashed} 可用=${b.available} 试算剩余=${q.days}天 再登=${String(msg).slice(0, 20)}`);
  }

  { // AL9 离职结算：cashout 模式自动登记，落在离职当月
    // 逐行全改：policy_value 可能有多条生效日，只改 2026-01-01 那行不一定被取到
    await db.query(`UPDATE policy_value SET value_text='cashout'
                     WHERE policy_code='LEAVE_TERM_HANDLING'`);
    const termMode = (await db.query(
      `SELECT value_text v FROM fn_policy_effective('LEAVE_TERM_HANDLING', NULL, '2027-06-30')`
    )).rows[0]?.v;
    await db.query(`INSERT INTO leave_grant(employee_id,leave_type_id,qty,valid_from,valid_to)
                    VALUES ($1,$2,5,'2027-01-01','2027-12-31')`, [ST_PERSON, ANNUAL]);
    let msg = '';
    try {
      await db.query(`SELECT fn_emp_terminate($1,'2027-06-30','测试：离职结算折现','hr')`,
        [ST_PERSON]);
    } catch (e) { msg = e.message; }
    const c = (await db.query(
      `SELECT leave_year, settle_period, days, rate, status FROM leave_cashout
        WHERE employee_id=$1 AND leave_year=2027`, [ST_PERSON])).rows[0];
    const left = (await db.query(
      `SELECT COUNT(*) n FROM v_leave_balance WHERE employee_id=$1 AND available > 0`,
      [ST_PERSON])).rows[0].n;
    rec('ALC9', '离职按 cashout 结算：自动登记折现、落在离职当月、不留悬挂额度',
      !msg && c && c.settle_period === '2027-06' && Number(c.rate) === 2
      && Number(c.days) === 7 && Number(left) === 0,
      msg ? String(msg).slice(0, 50)
          : (c ? `${c.settle_period} ${c.days}天 ×${c.rate} 状态=${c.status} 剩余悬挂=${left}`
               : `未产生单据 离职制度=${termMode} 剩余悬挂=${left}`));
  }
}

// ===========================================================================
// DIF 组 · 工资条环比（136）：说清"这个月为什么少了 300"
// ---------------------------------------------------------------------------
// 明细能看出每一项是多少，看不出哪一项变了 —— 人要在十几行里逐行比对。
// 这一组钉两件事：逐项差异算得对、归因（为什么）能对上账。
// ===========================================================================
{
  const periods = (await db.query(
    `SELECT pr.period::text p FROM payslip sp JOIN pay_run pr ON pr.id = sp.pay_run_id
      WHERE sp.employee_id = $1 ORDER BY pr.period`, [ST_PERSON])).rows.map(r => r.p);
  const cur = periods[periods.length - 1];
  const base = periods.length >= 2 ? periods[periods.length - 2] : null;

  { // DIF1 逐项对比
    const d = (await db.query(
      `SELECT * FROM fn_payslip_diff($1,$2,$3)`, [ST_PERSON, cur, base])).rows;
    const changed = d.filter(x => x.kind === 'changed');
    // ★ 明细里含扣款项（社保 / 个税，金额是负的），而 gross 是**扣之前**的应发。
    //   直接在全部明细上求和，会差出社保与个税 —— 第一版就是这么写错的。
    // ★ 扣款项不止社保和个税：年终奖还有单独一行 BONUS_TAX（108）。
    //   第一版只排除了 SI_* 与 IIT，差出的正好是那 720 元年奖个税。
    const DEDUCT = new Set(['IIT', 'BONUS_TAX']);
    const sumDiff = d
      .filter(x => !/^SI_/.test(x.item_code) && !DEDUCT.has(x.item_code))
      .reduce((a, x) => a + Number(x.diff), 0);
    const slips = (await db.query(
      `SELECT p.gross_amount g, pr.period::text per
         FROM payslip p JOIN pay_run pr ON pr.id=p.pay_run_id
        WHERE p.employee_id=$1 AND pr.period IN ($2,$3) ORDER BY pr.period`,
      [ST_PERSON, base, cur])).rows;
    const dGross = slips.length === 2
      ? Number(slips[1].g) - Number(slips[0].g) : null;
    rec('DIF1', '逐项对比：应发项的差额合计 = 两个月应发之差（明细与汇总对得上）',
      d.length > 0 && dGross !== null && Math.abs(sumDiff - dGross) < 0.02,
      `${base} → ${cur}：${d.length} 项（变动 ${changed.length}）；应发项差额 ${sumDiff.toFixed(2)} vs 应发差 ${dGross.toFixed(2)}`);
  }

  { // DIF2 上月没有工资条 → 说清为什么，而不是给一堆 added
    const miss = (await db.query(
      `SELECT * FROM fn_payslip_explain($1,'2026-11','2026-10')`, [ST_PERSON])).rows;
    rec('DIF2', '基准月没有工资条 → 直接说"无法环比"，而不是把每一项都标成新增',
      miss.length === 1 && miss[0].code === 'NO_BASE',
      miss[0]?.msg?.slice(0, 46) || '无返回');
  }

  { // DIF3 应发变化的归因带具体数字
    const e = (await db.query(
      `SELECT * FROM fn_payslip_explain($1,$2,$3)`, [ST_PERSON, cur, base])).rows;
    const g = e.find(x => x.code === 'GROSS');
    rec('DIF3', '归因第一句就是应发合计的变化，带两个具体数字与差额',
      !!g && /\d/.test(g.msg) && /应发合计/.test(g.msg),
      g ? g.msg : '没有 GROSS 行');
  }

  { // DIF4 一次性项被单独点出来（不是混在"某项变了"里）
    const e = (await db.query(
      `SELECT * FROM fn_payslip_explain($1,$2,$3)`, [ST_PERSON, cur, base])).rows;
    const one = e.find(x => x.code === 'ONE_OFF');
    const hasCash = (await db.query(
      `SELECT count(*)::int n FROM payslip_item i JOIN payslip p ON p.id=i.payslip_id
        JOIN pay_run pr ON pr.id=p.pay_run_id
       WHERE p.employee_id=$1 AND pr.period=$2 AND i.item_code='AL_CASHOUT'`,
      [ST_PERSON, cur])).rows[0].n > 0;
    // 本月有年假折现时，必须出现 ONE_OFF 行；没有时这条不适用（用 true 兜）
    rec('DIF4', '一次性项（年假折现/年终奖）被单独点出来 —— 这是"不是每月都有"的那部分',
      hasCash ? !!one : true,
      hasCash ? (one ? one.msg.slice(0, 48) : '缺 ONE_OFF') : '本月没有一次性项，跳过');
  }

  { // DIF5 归因顺序稳定（前端要按 seq 排）
    const e = (await db.query(
      `SELECT seq FROM fn_payslip_explain($1,$2,$3) ORDER BY seq`, [ST_PERSON, cur, base])).rows;
    const okSeq = e.every((x, i) => Number(x.seq) === i + 1);
    rec('DIF5', '归因按 seq 连续编号（前端直接按序展示，不用自己猜顺序）',
      e.length > 0 && okSeq, `${e.length} 条，seq 连续=${okSeq}`);
  }
}

// ===========================================================================
// SIG 组 · 工资表会签（139）
// ---------------------------------------------------------------------------
// 会签最容易变成走过场：谁点一下都算通过、异议只写"有问题"、
// 没签完照样能封账。三条都不是"功能缺失"，而是"功能还在但已经没用"。
// ===========================================================================
{
  const accounts = (await db.query(
    `SELECT id, display_name FROM sys_account ORDER BY id LIMIT 3`)).rows;
  const A1 = Number(accounts[0].id), A2 = Number(accounts[1].id), A3 = Number(accounts[2].id);

  // 造一批工资条齐备的草稿批次（不动真实批次：后面几组还要用）
  const mkRun = async (period) => {
    // ★ 清场要先把已封账的批次打回 draft：payslip 上有"封账后不可改"的触发器，
    //   直接 DELETE 会撞 E_PAYSLIP_FROZEN（这次就是 SIG1 封完账、SIG2 造批时撞的）。
    //   FK 又要求先删工资条才能删批次，所以只能按这个顺序。
    await db.query(`UPDATE pay_run SET status='draft', sealed_at=NULL, sealed_by=NULL
                     WHERE period=$1 AND legal_entity_id=1`, [period]);
    await db.query(`DELETE FROM pay_run_signoff WHERE pay_run_id IN
                     (SELECT id FROM pay_run WHERE period=$1 AND legal_entity_id=1)`, [period]);
    await db.query(`DELETE FROM payslip WHERE pay_run_id IN
                     (SELECT id FROM pay_run WHERE period=$1 AND legal_entity_id=1)`, [period]);
    await db.query(`DELETE FROM pay_run WHERE period=$1 AND legal_entity_id=1`, [period]);
    const id = Number((await db.query(
      `INSERT INTO pay_run(period, legal_entity_id) VALUES ($1,1) RETURNING id`, [period])).rows[0].id);
    await db.query(`INSERT INTO payslip(pay_run_id, employee_id, gross_amount, net_amount,
                     si_employee, tax_amount, cum_taxable, leave_deduct, special_deduction)
                   VALUES ($1,1,8000,6500,1000,500,8000,0,0)`, [id]);
    return id;
  };
  const setReq = (v) => db.query(
    `UPDATE policy_value SET value_text=$1 WHERE policy_code='PAY_SIGNOFF_REQUIRED'`, [v]);
  const statusOf = async (run) => (await db.query(
    `SELECT role_code, status, can_seal FROM fn_signoff_status($1) ORDER BY seq`, [run])).rows;

  // ★ 不在这里清场：封账是不可逆的（E_PAYRUN_REOPEN 拦着回 draft），
  //   清不掉已封账的批次。测试库每次都是新建的，所以这两期（2027-09/10）
  //   由本组独占，跑完留着也不影响别的组 —— 比"想办法删掉"更诚实。

  { // SIG1 默认不强制：没发起也能封账（不改变上线前行为）
    const run = await mkRun('2027-09');
    await setReq('off');
    let msg = '';
    // ★ 143：手工造的工资条累计与公式对不上，封账默认被 E_SEAL_CHAIN_STALE 拦。
    //   这一组验的是"制度没开时也能封账 + 记下谁封的"，不是累计本身 → 显式确认。
    try { await db.query(`SELECT fn_pay_run_seal($1,'hr',true)`, [run]); }
    catch (e) { msg = e.message; }
    const st = (await db.query(`SELECT status, sealed_by FROM pay_run WHERE id=$1`, [run])).rows[0];
    rec('SIG1', '制度默认 off → 不发起会签也能封账，且 sealed_by 记下是谁封的',
      !msg && st.status === 'sealed' && st.sealed_by === 'hr',
      `${st.status} sealed_by=${st.sealed_by}${msg ? ' / ' + msg : ''}`);
  }

  const run = await mkRun('2027-10');
  await setReq('on');

  { // SIG2 强制但没发起
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_seal($1,'hr')`, [run]); }
    catch (e) { msg = e.message; }
    rec('SIG2', '制度打开会签 → 没发起就封账被拒（E_SIGNOFF_NOT_STARTED）',
      /E_SIGNOFF_NOT_STARTED/.test(msg), String(msg).slice(0, 44));
  }

  { // SIG3 发起：三个角色各一行，都要指定人
    const n = Number((await db.query(
      `SELECT fn_signoff_start($1,'hr',$2::jsonb) n`,
      [run, JSON.stringify({ cashier: A1, finance: A2, biz: A3 })])).rows[0].n);
    const rows = await statusOf(run);
    rec('SIG3', '发起会签 → 三个角色各一行、都指向指定账号，此刻还不能封账',
      n === 3 && rows.length === 3 && rows.every(x => x.status === 'pending')
      && rows.every(x => x.can_seal === false),
      `${n} 行：${rows.map(x => x.role_code + '=' + x.status).join(' ')}`);
  }

  { // SIG4 未签完不能封账，且报出是谁没签
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_seal($1,'hr')`, [run]); }
    catch (e) { msg = e.message; }
    rec('SIG4', '还有未签的行 → 封账被拒，并列出是哪个角色没签',
      /E_SIGNOFF_PENDING/.test(msg) && /出纳/.test(msg),
      String(msg).slice(0, 60));
  }

  const rowOf = async (role) => Number((await db.query(
    `SELECT id FROM pay_run_signoff WHERE pay_run_id=$1 AND role_code=$2`, [run, role])).rows[0].id);

  { // SIG5 代签被拒
    const id = await rowOf('cashier');
    let msg = '';
    try { await db.query(`SELECT fn_signoff_decide($1,$2,true,'代签一下')`, [id, A2]); }
    catch (e) { msg = e.message; }
    rec('SIG5', '只能签自己那一行：别人的行代签被拒（E_SIGNOFF_NOT_YOURS）',
      /E_SIGNOFF_NOT_YOURS/.test(msg), String(msg).slice(0, 46));
  }

  { // SIG6 异议必须写原因
    const id = await rowOf('finance');
    let msg = '';
    try { await db.query(`SELECT fn_signoff_decide($1,$2,false,'有问题')`, [id, A2]); }
    catch (e) { msg = e.message; }
    rec('SIG6', '提异议不写清原因 → 拒（只说"有问题"，发起人无从修改）',
      /E_SIGNOFF_NO_NOTE/.test(msg), String(msg).slice(0, 46));
  }

  { // SIG7 异议 → 封账仍被拒；改数后重新发起，已签的保留、未签的回 pending
    const finId = await rowOf('finance');
    await db.query(`SELECT fn_signoff_decide($1,$2,false,'12 月提成少算了 1200 元')`, [finId, A2]);
    const before = await statusOf(run);
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_seal($1,'hr')`, [run]); }
    catch (e) { msg = e.message; }

    // 出纳先签过（模拟"签了的不会因为重发起丢掉"）
    const cashId = await rowOf('cashier');
    await db.query(`SELECT fn_signoff_decide($1,$2,true,'金额核对无误')`, [cashId, A1]);
    await db.query(`SELECT fn_signoff_start($1,'hr',$2::jsonb)`,
      [run, JSON.stringify({ cashier: A1, finance: A2, biz: A3 })]);
    const after = await statusOf(run);
    const cash = after.find(x => x.role_code === 'cashier');
    const fin = after.find(x => x.role_code === 'finance');
    rec('SIG7', '有异议即封不了账；重新发起后已签的保持已签、异议行回到待签',
      /E_SIGNOFF_PENDING/.test(msg) && before.some(x => x.status === 'objected')
      && cash.status === 'approved' && fin.status === 'pending',
      `异议后封账=${/E_SIGNOFF_PENDING/.test(msg)} 重发后 出纳=${cash.status} 财务=${fin.status}`);
  }

  { // SIG8 全部签完 → 封账成功
    for (const role of ['finance', 'biz']) {
      const id = await rowOf(role);
      const acc = role === 'finance' ? A2 : A3;
      await db.query(`SELECT fn_signoff_decide($1,$2,true,'同意')`, [id, acc]);
    }
    const st = await statusOf(run);
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_seal($1,'boss',true)`, [run]); }
    catch (e) { msg = e.message; }
    const sealed = (await db.query(`SELECT status, sealed_by FROM pay_run WHERE id=$1`, [run])).rows[0];
    rec('SIG8', '三人签完 → 封账成功；状态页的 can_seal 与封账门禁是同一个判据',
      !msg && sealed.status === 'sealed' && sealed.sealed_by === 'boss'
      && st.every(x => x.can_seal === true),
      `${st.map(x => x.role_code + '=' + x.status).join(' ')} → ${sealed.status}/${sealed.sealed_by}`);
  }

  // 收尾只恢复制度项：两期测试批次已封账，按设计删不掉（工资条冻结）。
  // 留着的代价只是测试库里多两条 2027-09/10 的批次，换掉的是"绝不绕过冻结约束"。
  await setReq('off');
}

// ===========================================================================
// PAYR 组 · 发放回单（140）
// ---------------------------------------------------------------------------
// 140 之前 pay_run 只能到 sealed —— "工资发了没有"系统答不出来，
// 而 ck_pr_status 里的 'paid' 是个永远到不了的状态。这一组把它走通，
// 并且钉住那条最贵的判断：回单总额与实发合计不一致时不许登记。
// ===========================================================================
{
  // ★ 143 起封账要过"累计链条"门禁：本年此前若有 draft 批次就不能封本期。
  //   2027 年里 09/10 是别的断言留下的 draft，所以在 2027-11 封账会被（正确地）拒。
  //   这一组验的是"发放"，与期间无关 —— 换到一个干净的年度，不去动别人的数据。
  const P = '2028-03';
  await db.query(`DELETE FROM payslip WHERE pay_run_id IN
                   (SELECT id FROM pay_run WHERE period=$1 AND legal_entity_id=1)`, [P]);
  await db.query(`DELETE FROM pay_run WHERE period=$1 AND legal_entity_id=1`, [P]);
  const run = Number((await db.query(
    `INSERT INTO pay_run(period, legal_entity_id) VALUES ($1,1) RETURNING id`, [P])).rows[0].id);
  await db.query(`INSERT INTO payslip(pay_run_id, employee_id, gross_amount, net_amount,
                   si_employee, tax_amount, cum_taxable, leave_deduct, special_deduction)
                 VALUES ($1,1,8000,6500,1000,500,8000,0,0)`, [run]);

  const payOf = async () => (await db.query(
    `SELECT status, paid_at, paid_by, pay_method, pay_ref FROM pay_run WHERE id=$1`, [run])).rows[0];

  { // PAYR1 没封账不能登记
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_pay($1,'hr','bank','流水 001',6500)`, [run]); }
    catch (e) { msg = e.message; }
    rec('PAYR1', '没封账就登记发放 → 拒（没封账就发钱，等于按一份还会变的数发）',
      /E_RUN_NOT_SEALED/.test(msg), String(msg).slice(0, 46));
  }

  // ★ 143：封账时若"累计对不上当前前期"会默认拒（E_SEAL_CHAIN_STALE），
  //   要显式确认才放行。这一组的工资条是手工造的（不是为了验累计），
  //   所以第三个参数传 true —— 等于"知道它对不上，确认按现状封"。
  await db.query(`SELECT fn_pay_run_seal($1,'hr',true)`, [run]);

  { // PAYR2 方式乱填
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_pay($1,'hr','支付宝','',6500)`, [run]); }
    catch (e) { msg = e.message; }
    rec('PAYR2', '发放方式只认 bank / cash / manual（乱填被拒，不会静默存进去）',
      /E_PAY_METHOD/.test(msg), String(msg).slice(0, 46));
  }

  { // PAYR3 回单总额与实发合计不一致 → 拒
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_pay($1,'hr','bank','流水 002',6000)`, [run]); }
    catch (e) { msg = e.message; }
    const st = (await payOf()).status;
    rec('PAYR3', '回单总额 6000 ≠ 实发合计 6500 → 拒，且状态仍是 sealed（不会"记了但数错了"）',
      /E_PAY_TOTAL_MISMATCH/.test(msg) && st === 'sealed', String(msg).slice(0, 52));
  }

  { // PAYR4 正确登记
    await db.query(`SELECT fn_pay_run_pay($1,'cashier_li','bank','代发批次 202711-03',6500)`, [run]);
    const p = await payOf();
    rec('PAYR4', '登记发放：状态 paid、记下时间/操作人/方式/流水号（对账只有一个锚点）',
      p.status === 'paid' && p.paid_at !== null && p.paid_by === 'cashier_li'
      && p.pay_method === 'bank' && p.pay_ref === '代发批次 202711-03',
      `${p.status} ${String(p.paid_at).slice(0, 16)} ${p.paid_by} ${p.pay_method} ${p.pay_ref}`);
  }

  { // PAYR5 重复登记
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_pay($1,'hr','bank','又一次',6500)`, [run]); }
    catch (e) { msg = e.message; }
    rec('PAYR5', '重复登记发放 → 拒（钱只发一次，状态也要只改一次）',
      /E_RUN_ALREADY_PAID/.test(msg), String(msg).slice(0, 46));
  }

  { // PAYR6 约束：paid 与 paid_at 同生同灭
    let msg = '';
    try {
      await db.query(`UPDATE pay_run SET paid_at=NULL WHERE id=$1`, [run]);
    } catch (e) { msg = e.message; }
    rec('PAYR6', 'ck_pr_paid：已发放却没有发放时间 → 约束直接拒（不能"发过但不知何时"）',
      /ck_pr_paid/.test(msg), String(msg).slice(0, 46));
  }
}

// ===========================================================================
// LVU 组 · 假期额度的单位口径（138）
// ---------------------------------------------------------------------------
// 报错里把"天"写成"小时"，不是文案问题：HR 会去按 8 小时/天折算，
// 而系统里的 10 天就是 10 天 —— 一句话说错单位，整套数都不可信。
// ===========================================================================
{
  const AN = (await db.query(`SELECT fn_leave_type_id('ANNUAL') x`)).rows[0].x;
  // 清掉这个人的年假额度，制造"可用 0"
  await db.query(`DELETE FROM leave_usage WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, AN]);
  await db.query(`DELETE FROM leave_grant WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, AN]);
  // ★ 可用不一定是 0：前面几组可能留下已折现（cashed）或已用，负数也是合法状态。
  //   所以断言"文案格式 + 数字与视图一致"，不写死 0 —— 写死会变成
  //   "前面几组有没有留垃圾数据"，而不是"单位对不对"。
  const avail = String((await db.query(
    `SELECT COALESCE(available,0) a FROM v_leave_balance
      WHERE employee_id=$1 AND leave_type_id=$2`, [ST_PERSON, AN])).rows[0].a);
  let msg = '';
  try {
    await db.query(`SELECT fn_leave_apply($1,$2,3,'2028-01-04'::date,'2028-01-06'::date)`,
      [ST_PERSON, AN]);
  } catch (e) { msg = e.message; }
  const shown = (msg.match(/可用\s*(-?[\d.]+)\s*天/) || [])[1];
  rec('LVU1', '额度不足的报错说"天"并带假种名（说"小时"会让 HR 按 8 小时/天去折算）',
    shown !== undefined && Number(shown) === Number(avail)
    && /年假/.test(msg) && !/小时/.test(msg),
    String(msg).slice(0, 60));
  await db.query(`DELETE FROM leave_usage WHERE employee_id=$1 AND leave_type_id=$2`,
    [ST_PERSON, AN]);
}

// ===========================================================================
// PPV 组 · 算薪预演（137）：真算两遍给影响面，且一行都不许留
// ---------------------------------------------------------------------------
// 预演最怕的不是算错，而是"我只点了预览，工资条却变了"—— 一旦发生过一次，
// 就再没人敢点。所以这一组里"零痕迹"的断言比"数对不对"更重要。
// ===========================================================================
{
  const E1 = 1;
  // ★ 期间写死，不"猜最近一个 draft"。
  //   猜的写法曾经对，是因为那时候别的组只造 2026 年的批次；一旦某个组把数据
  //   挪到别的年份（143 把绩效链挪到 2026-08、发放链挪到 2028-03），
  //   这里就会静默漂到 2027-10 —— 而 PPV6 的申报基数参数写死 2026 年度，
  //   于是"低薪 + 按上限申报"这个人根本没进预演，看起来像功能坏了。
  //   预演本身与哪一期无关，固定一期反而让"零痕迹"那条更可复现。
  const P = '2027-11';

  // 预演前的全库计数（预演后必须一模一样）
  const snap = async () => ({
    run: Number((await db.query(`SELECT count(*)::int n FROM pay_run`)).rows[0].n),
    slip: Number((await db.query(`SELECT count(*)::int n FROM payslip`)).rows[0].n),
    item: Number((await db.query(`SELECT count(*)::int n FROM payslip_item`)).rows[0].n),
    pol: Number((await db.query(`SELECT count(*)::int n FROM policy_value`)).rows[0].n),
    amt: Number((await db.query(`SELECT COALESCE(sum(gross_amount),0) s FROM payslip`)).rows[0].s),
  });
  const before = await snap();

  const pv0 = (await db.query(
    `SELECT fn_payroll_preview($1,$2,'{}'::jsonb) p`, [P, E1])).rows[0].p;

  const after = await snap();

  { // PPV1 零痕迹
    rec('PPV1', '预演零痕迹：批次/工资条/明细/制度项的条数与金额，跑完一模一样',
      before.run === after.run && before.slip === after.slip
      && before.item === after.item && before.pol === after.pol
      && Math.abs(before.amt - after.amt) < 0.01,
      `批次 ${before.run}→${after.run} 工资条 ${before.slip}→${after.slip} `
      + `明细 ${before.item}→${after.item} 制度项 ${before.pol}→${after.pol}`);
  }

  { // PPV2 无覆盖 → 差异必须为 0
    rec('PPV2', '不给覆盖参数：改前改后总额完全一致，并明确标 no_effect',
      Number(pv0.delta.gross) === 0 && Number(pv0.delta.net) === 0
      && pv0.no_effect === true,
      `${pv0.headcount} 人 应发差=${pv0.delta.gross} 实发差=${pv0.delta.net} no_effect=${pv0.no_effect}`);
  }

  { // PPV3 全员调薪 5% → 应发总额按比例涨，且每个人都在 movers 里能查到主因
    const pv1 = (await db.query(
      `SELECT fn_payroll_preview($1,$2,'{"salary_pct":5}'::jsonb) p`, [P, E1])).rows[0].p;
    const g0 = Number(pv1.base.gross), g1 = Number(pv1.after.gross);
    // 应发里含加班费/提成等不随月薪变的部分，所以涨幅 ≤ 5%，但不该是 0
    const ratio = g0 > 0 ? (g1 - g0) / g0 : 0;
    const mv = (pv1.movers || [])[0] || null;
    rec('PPV3', '全员调薪 5%：应发总额真的涨（0 < 涨幅 ≤ 5%），变动第一名带主因项',
      g1 > g0 && ratio > 0 && ratio <= 0.0501
      && mv && Number(mv.delta_net) !== 0 && mv.top_item,
      `应发 ${g0}→${g1}（+${(ratio * 100).toFixed(2)}%）`
      + (mv ? `；第一名 ${mv.name} Δ实发=${mv.delta_net} 主因=${mv.top_item}(${mv.top_delta})` : '；无变动人'));
  }

  { // PPV4 改制度项真的接线（不是只认 salary_pct 一路）
    const pv2 = (await db.query(
      `SELECT fn_payroll_preview($1,$2,'{"policy":{"PAY_DAYS_PER_MONTH":30}}'::jsonb) p`,
      [P, E1])).rows[0].p;
    const applied = (pv2.applied || []).some(x => /PAY_DAYS_PER_MONTH/.test(x));
    rec('PPV4', '改制度项（月计薪天数 21.75→30）也走同一条预演：applied 里有记录',
      applied, (pv2.applied || []).join(' / ') || '无');
  }

  { // PPV5 制度项覆盖不会被留下来（预演里插的 policy_value 必须撤销）
    const pol = Number((await db.query(
      `SELECT count(*)::int n FROM policy_value WHERE published_by='preview'`)).rows[0].n);
    rec('PPV5', '预演插的制度项不留痕（published_by=preview 的行数必须为 0）',
      pol === 0, `残留 ${pol} 行`);
  }

  { // PPV6 实发为负要被抓出来
    // 造一个"低薪 + 高申报基数"的人：应发 2000，社保按上限缴 → 实发必为负
    await db.query(`INSERT INTO person(id, full_name) VALUES (9904,'临时低薪')
                    ON CONFLICT (id) DO NOTHING`);
    await db.query(`INSERT INTO employment(id, person_id, legal_entity_id, hire_date)
                    VALUES (9904, 9904, $1, '2025-01-01') ON CONFLICT (id) DO NOTHING`, [E1]);
    await db.query(`UPDATE employment SET legal_entity_id=$1, leave_date=NULL WHERE id=9904`, [E1]);
    await db.query(`DELETE FROM salary_standard WHERE employment_id=9904`);
    await db.query(`INSERT INTO salary_standard(employment_id, monthly_amount, effective_from)
                    VALUES (9904, 2000, '2025-01-01')`);
    const ceil = Number((await db.query(
      `SELECT base_ceiling c FROM si_policy WHERE city='上海'
        ORDER BY effective_from DESC LIMIT 1`)).rows[0].c);
    await db.query(`DELETE FROM si_base_declare WHERE employee_id=9904`);
    // 年度与生效日跟随 P —— 与算薪取基数时"生效日在一年内"的判据对齐
    await db.query(`INSERT INTO si_base_declare(employee_id, city, declare_year,
                     monthly_avg, base_amount, months_counted, effective_from, reason, source)
                    VALUES (9904,'上海',$2::int,$1,$1,12,make_date($2::int,1,1),
                            '预演测试：按上限申报','manual')`,
      [ceil, P.slice(0, 4)]);
    const pv3 = (await db.query(
      `SELECT fn_payroll_preview($1,$2,'{}'::jsonb) p`, [P, E1])).rows[0].p;
    const hit = (pv3.negative_net || []).find(x => Number(x.person_id) === 9904);
    rec('PPV6', '实发为负的人被单独列出来（低薪 + 按上限申报社保 → 扣款超过应发）',
      !!hit && Number(hit.net_after) < 0,
      hit ? `${hit.name} 应发=${hit.gross_after} 实发=${hit.net_after}` : '没抓到');
    await db.query(`DELETE FROM si_base_declare WHERE employee_id=9904`);
    await db.query(`DELETE FROM salary_standard WHERE employment_id=9904`);
    await db.query(`DELETE FROM employment WHERE id=9904`);
    await db.query(`DELETE FROM person WHERE id=9904`);
  }

  { // PPV7 已封账的批次 → 明确拒绝（不给出一个"其实算不出来"的数）
    await db.query(`INSERT INTO pay_run(period, legal_entity_id, status, sealed_at)
                    VALUES ('2019-01', $1, 'sealed', now())
                    ON CONFLICT (period, legal_entity_id, calc_version, kind) DO NOTHING`, [E1]);
    let msg = '';
    try {
      await db.query(`SELECT fn_payroll_preview('2019-01',$1,'{}'::jsonb)`, [E1]);
    } catch (e) { msg = e.message; }
    await db.query(`DELETE FROM pay_run WHERE period='2019-01' AND legal_entity_id=$1`, [E1]);
    rec('PPV7', '封账后不能预演：直接说"已封账，要预演先重开"（不给假数）',
      /E_PAY_PREVIEW_SEALED/.test(msg), String(msg).slice(0, 46));
  }
}

// ===========================================================================
// DECL 组 · 申报表（141）：个税扣缴申报表 + 社保费申报表
// ---------------------------------------------------------------------------
// 这两张表是"钱离开系统"之后的下一步 —— 报出去就要更正申报，所以三条必须验：
//   · **只从封账批次出**：draft 的数明天还会变；
//   · **金额与工资条同源**：申报表算 3200、工资条扣 3180 的话，员工只记住低的那个；
//   · **0 与"没登记"分得开**：工伤个人额是真 0，缺明细行是"不知道"。
//
// ★ 用独立法人 999。累计预扣是按**扣缴义务人**累计的，而"本年已申报月数"
//   是算法人本年已封账的月份数 —— 混在法人 1 里，别的断言多封一期，
//   这里的减除费用就会跟着变，测试之间互相踩。
// ===========================================================================
{
  const ENT = 999;
  const M1 = '2026-09', M2 = '2026-10', DRAFT = '2026-11';

  // 险种补齐：测试库的 si_policy 只有养老，申报表要按险种出，工伤/生育只有单位缴
  await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                    rate_employee,rate_employer) VALUES
    (9901,'上海','medical','2026-07-01',6200,32000,0.02,0.095),
    (9902,'上海','unemploy','2026-07-01',6200,32000,0.005,0.005),
    (9903,'上海','injury','2026-07-01',6200,32000,0,0.0026),
    (9904,'上海','maternity','2026-07-01',6200,32000,0,0.01),
    (9905,'上海','housing_fund','2026-07-01',2690,36921,0.07,0.07)
    ON CONFLICT (city,item,effective_from) DO NOTHING`);

  await db.query(`INSERT INTO person(id,full_name) VALUES (9950,'申报甲'),(9951,'申报乙')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (9950,9950,$1,'2026-01-01'),(9951,9951,$1,'2026-01-01')
                  ON CONFLICT (id) DO NOTHING`, [ENT]);
  await db.query(`DELETE FROM salary_standard WHERE employment_id IN (9950,9951)`);
  await db.query(`INSERT INTO salary_standard(employment_id,monthly_amount,effective_from) VALUES
                    (9950,20000,'2026-01-01'),(9951,9000,'2026-01-01')`);

  const mkRun = async (period, kind, status) => Number((await db.query(
    `INSERT INTO pay_run(period,legal_entity_id,kind,status,sealed_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [period, ENT, kind, status, status === 'draft' ? null : new Date()])).rows[0].id);

  // 工资条：分险种明细行（甲）/ 只有 SI_EMPLOYEE 合计行（乙 = 104 之前的历史结构）
  const mkSlip = async (run, emp, gross, si, tax, cumTaxable, add, itemLines) => {
    const id = Number((await db.query(
      `INSERT INTO payslip(pay_run_id,employee_id,gross_amount,net_amount,si_employee,
                           tax_amount,cum_taxable,special_deduction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [run, emp, gross, gross - si - tax, si, tax, cumTaxable, add])).rows[0].id);
    await db.query(`INSERT INTO payslip_item(payslip_id,item_code,amount)
                    VALUES ($1,'BASE',$2)`, [id, gross]);
    for (const [code, amt] of itemLines) {
      await db.query(`INSERT INTO payslip_item(payslip_id,item_code,amount)
                      VALUES ($1,$2,$3)`, [id, code, amt]);
    }
    await db.query(`INSERT INTO payslip_item(payslip_id,item_code,amount)
                    VALUES ($1,'IIT',$2)`, [id, -tax]);
    return id;
  };

  // 甲的社保按基数 × 费率：20000 × (8% + 2% + 0.5% + 7%) = 3500
  const FULL = [['SI_PENSION', -1600], ['SI_MEDICAL', -400],
                ['SI_UNEMPLOYMENT', -100], ['SI_HOUSING_FUND', -1400]];

  const r9 = await mkRun(M1, 'monthly', 'draft');
  // 9500 = 20000 − 3500 − 5000 − 2000；累计 9500 → 税额 285（3%）
  await mkSlip(r9, 9950, 20000, 3500, 285, 9500, 2000, FULL);
  await mkSlip(r9, 9951, 9000, 1575, 42.75, 1425, 1000, [['SI_EMPLOYEE', -1575]]);
  await db.query(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=$1`, [r9]);

  const r10 = await mkRun(M2, 'monthly', 'draft');
  await mkSlip(r10, 9950, 20000, 3500, 285, 19000, 2000, FULL);
  await mkSlip(r10, 9951, 9000, 1575, 42.75, 2850, 1000, [['SI_EMPLOYEE', -1575]]);
  await db.query(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=$1`, [r10]);

  const rDraft = await mkRun(DRAFT, 'monthly', 'draft');
  await mkSlip(rDraft, 9950, 20000, 3500, 285, 28500, 2000, FULL);

  { // DECL1 未封账 → 拒（不是"出一份看起来对的表"）
    let msg = '';
    try { await db.query(`SELECT * FROM fn_declare_iit($1,$2)`, [ENT, DRAFT]); }
    catch (e) { msg = e.message; }
    rec('DECL1', '未封账的期间 → E_DECLARE_NOT_SEALED（报出去就要更正申报，所以只从封账批次出）',
      /E_DECLARE_NOT_SEALED/.test(msg), String(msg).split('\n')[0].slice(0, 52));
  }

  { // DECL2 没算过薪 → 另一种错（"去算薪"与"去封账"是两件事）
    let msg = '';
    try { await db.query(`SELECT * FROM fn_declare_iit($1,'2025-01')`, [ENT]); }
    catch (e) { msg = e.message; }
    rec('DECL2', '这一期根本没有批次 → E_DECLARE_NO_RUN（与"没封账"分开报，处理动作不同）',
      /E_DECLARE_NO_RUN/.test(msg), String(msg).split('\n')[0].slice(0, 52));
  }

  { // DECL3 金额与工资条同源
    const d = (await db.query(
      `SELECT i.income, i.deduct_special, i.tax_now, i.cum_taxable
         FROM fn_declare_iit($1,$2) i WHERE i.person_name='申报甲'`, [ENT, M2])).rows[0];
    const s = (await db.query(
      `SELECT p.gross_amount, p.si_employee, p.tax_amount, p.cum_taxable
         FROM payslip p JOIN person pe ON pe.id=p.employee_id
        WHERE p.pay_run_id=$1 AND pe.full_name='申报甲'`, [r10])).rows[0];
    rec('DECL3', '申报表的收入/专项扣除/税额/累计应纳税所得额与工资条逐项相等（不另算一遍税）',
      Number(d.income) === Number(s.gross_amount)
      && Number(d.deduct_special) === Number(s.si_employee)
      && Number(d.tax_now) === Number(s.tax_amount)
      && Number(d.cum_taxable) === Number(s.cum_taxable),
      `收入=${d.income}/${s.gross_amount} 税额=${d.tax_now}/${s.tax_amount}`);
  }

  { // DECL4 减除费用 = 5000 × 本年已封账月数
    const d = (await db.query(
      `SELECT i.deduct_std, i.cum_deduct_std, i.months_counted, i.filed_months
         FROM fn_declare_iit($1,$2) i WHERE i.person_name='申报甲'`, [ENT, M2])).rows[0];
    rec('DECL4', '减除费用 = 5000 × 本年已封账月数（两个月 → 累计 10000，月份清单可查）',
      Number(d.deduct_std) === 5000 && Number(d.cum_deduct_std) === 10000
      && Number(d.months_counted) === 2 && String(d.filed_months) === '2026-09,2026-10',
      `本月=${d.deduct_std} 累计=${d.cum_deduct_std} 月份=${d.filed_months}`);
  }

  { // DECL5 数据自洽时应补退 = 0，且没有勾稽差
    const d = (await db.query(
      `SELECT i.should_pay, i.cum_tax, i.cum_paid, i.remark
         FROM fn_declare_iit($1,$2) i WHERE i.person_name='申报甲'`, [ENT, M2])).rows[0];
    rec('DECL5', '累计预扣自洽时应补(退)税额 = 0，且不出现勾稽差（两处对不上才该出现）',
      Math.abs(Number(d.should_pay)) < 0.005
      && !String(d.remark || '').includes('勾稽差'),
      `应补退=${d.should_pay} 累计应扣=${d.cum_tax} 累计已缴=${d.cum_paid} 备注=${d.remark || '—'}`);
  }

  { // DECL6 个人额：真 0 与"没登记"必须分得开
    const rows = (await db.query(
      `SELECT d.person_name, d.item, d.emp_amount, d.er_amount, d.total_amount, d.remark
         FROM fn_declare_si($1,$2) d
        WHERE d.item IN ('pension','injury') ORDER BY d.person_name, d.item`,
      [ENT, M2])).rows;
    const injJia = rows.find(r => r.person_name === '申报甲' && r.item === 'injury');
    const penYi = rows.find(r => r.person_name === '申报乙' && r.item === 'pension');
    rec('DECL6', '工伤个人额是 0（真的不缴）；乙只有 SI_EMPLOYEE 合计行 → 个人额 NULL + 点名（不是 0）',
      injJia && Number(injJia.emp_amount) === 0 && Number(injJia.er_amount) > 0
      && penYi && penYi.emp_amount === null
      && String(penYi.remark).includes('工资条无该险种明细行'),
      `工伤个人=${injJia && injJia.emp_amount} 单位=${injJia && injJia.er_amount}；`
      + `乙养老个人=${penYi && penYi.emp_amount}`);
  }

  { // DECL7 单位额 = 基数 × 单位费率，且汇总与明细自洽
    const sum = (await db.query(
      `SELECT s.item, s.person_count, s.base_sum, s.er_sum, s.emp_missing
         FROM fn_declare_si_sum($1,$2) s WHERE s.item='pension'`, [ENT, M2])).rows[0];
    const det = (await db.query(
      `SELECT sum(d.er_amount) e, count(*) FILTER (WHERE d.base_amount IS NOT NULL)::int n
         FROM fn_declare_si($1,$2) d WHERE d.item='pension'`, [ENT, M2])).rows[0];
    // 20000×16% + 9000×16%（两段费率相同）= 4640
    rec('DECL7', '单位应缴 = 缴费基数 × 单位费率（20000+9000 的 16% = 4640），汇总与明细一致',
      Number(sum.er_sum) === Number(det.e) && Math.abs(Number(sum.er_sum) - 4640) < 0.01
      && Number(sum.person_count) === 2 && Number(sum.emp_missing) === 1,
      `汇总单位=${sum.er_sum} 明细合计=${det.e} 人数=${sum.person_count} 个人未登记=${sum.emp_missing}`);
  }

  { // DECL8 费率改过但没重封账 → 个人额与基数对不上，必须点名
    await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                      rate_employee,rate_employer)
                    VALUES (9906,'上海','pension',$1,6200,32000,0.081,0.16)
                    ON CONFLICT (city,item,effective_from) DO NOTHING`, [M2 + '-01']);
    const d = (await db.query(
      `SELECT d.emp_amount, d.remark FROM fn_declare_si($1,$2) d
        WHERE d.person_name='申报甲' AND d.item='pension'`, [ENT, M2])).rows[0];
    rec('DECL8', '费率改过但没重新封账 → 个人额与"基数×费率"对不上 → 备注点名（不静默取一个）',
      String(d.remark).includes('个人额与基数重算差'), String(d.remark).slice(0, 60));
    await db.query(`DELETE FROM si_policy WHERE id=9906`);
  }

  { // DECL9 跨年不进累计
    const r25 = await mkRun('2025-12', 'monthly', 'draft');
    await mkSlip(r25, 9950, 50000, 3500, 9000, 41500, 2000, FULL);
    await db.query(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=$1`, [r25]);
    const d = (await db.query(
      `SELECT i.cum_income, i.months_counted FROM fn_declare_iit($1,$2) i
        WHERE i.person_name='申报甲'`, [ENT, M2])).rows[0];
    rec('DECL9', '上一年度（2025-12）的工资条不进 2026 累计（累计预扣按年清零）',
      Number(d.cum_income) === 40000 && Number(d.months_counted) === 2,
      `累计收入=${d.cum_income} 月数=${d.months_counted}`);
  }

  { // DECL10 年终奖不进工资薪金表（但能找到那个批次，不静默丢）
    const rB = await mkRun(M2, 'bonus', 'draft');
    await mkSlip(rB, 9950, 30000, 0, 2890, 19000, 0, []);
    await db.query(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=$1`, [rB]);
    const n = (await db.query(
      `SELECT count(*)::int n FROM fn_declare_iit($1,$2)`, [ENT, M2])).rows[0].n;
    const br = Number((await db.query(
      `SELECT fn_declare_run($1,$2,'bonus') r`, [ENT, M2])).rows[0].r);
    rec('DECL10', '年终奖批次不进"工资薪金"申报表（它按全年一次性奖金单独申报），但批次查得到',
      n === 2 && br === rB, `工资薪金行数=${n} 年终奖批次=${br}`);
  }

  { // DECL11 导出留痕只增不改
    const id = Number((await db.query(
      `SELECT fn_declare_log('iit',$1,$2,$3,2,2,1024,$4,570,'hr') i`,
      [ENT, M2, r10, 'a'.repeat(64)])).rows[0].i);
    let up = '', del = '';
    try { await db.query(`UPDATE tax_declare_export SET bytes=1 WHERE id=$1`, [id]); }
    catch (e) { up = e.message; }
    try { await db.query(`DELETE FROM tax_declare_export WHERE id=$1`, [id]); }
    catch (e) { del = e.message; }
    rec('DECL11', '申报表导出留痕：能写，不能改、不能删（改了摘要它就不再证明任何事）',
      id > 0 && /E_TDE_NO_UPDATE/.test(up) && /E_TDE_NO_DELETE/.test(del),
      `id=${id} 改=${/E_TDE_NO_UPDATE/.test(up)} 删=${/E_TDE_NO_DELETE/.test(del)}`);
  }

  { // DECL12 接线：界面/服务调的是这四个函数，不是另写一段 SQL
    const n = Number((await db.query(
      `SELECT count(*)::int n FROM pg_proc
        WHERE proname IN ('fn_declare_iit','fn_declare_si','fn_declare_si_sum','fn_declare_run')`)).rows[0].n);
    rec('DECL12', '四个申报函数都在库里（个税 / 社保明细 / 社保汇总 / 选批次）', n === 4, `找到 ${n} 个`);
  }

  { // DECL13 封账不可逆：连"清掉测试数据"都做不到
    let msg = '';
    try { await db.query(`DELETE FROM payslip WHERE pay_run_id=$1`, [r9]); }
    catch (e) { msg = e.message; }
    rec('DECL13', '封账批次的工资条删不掉（E_PAYSLIP_FROZEN）—— 测试数据也清不掉，这正是设计',
      /E_PAYSLIP_FROZEN/.test(msg), String(msg).split('\n')[0].slice(0, 46));
  }

  // 收尾：封账不可逆，这一组造出来的批次**留在库里**（法人 999，跑完随库丢弃）。
  // 只清得掉险种政策 —— 它没有引用关系，留着会污染后面重跑同一进程的断言。
  // 人员与任职也留着：工资条只存 employee_id、不挂外键，删了人反而让留着的工资条
  // 查不出姓名，看起来像数据坏了。
  await db.query(`DELETE FROM si_policy WHERE id BETWEEN 9901 AND 9906`);
}

// ===========================================================================
// SIV 组 · 险种键归一（142）：同一个东西不能有两个名字
// ---------------------------------------------------------------------------
// 141 的申报表第一次跑真实数据就抓到：si_policy.item 写成 `unemploy` 时，
// 算薪照扣钱（按比例算，不看名字），但工资条**没有失业险这一行**
// （算薪里的 CASE 只认 `unemployment`）。钱扣了、行没写，而且不报错。
//
// 所以这一组验的是"入口归一"，不是"出口兼容三种拼写"：
// 出口兼容漏一处就又回到那个 bug，而入口只有一处。
// ===========================================================================
{
  { // SIV1 别名 → 规范键（就是害人的那一条）
    await db.query(`DELETE FROM si_policy WHERE city='上海' AND item IN ('unemploy','unemployment')
                      AND effective_from='2026-03-01'`);
    // ★ 显式给 id：142 补了 IDENTITY，但测试里别处仍在写显式 id，
    //   序列不会跟着推进 —— 用默认值就会撞。与既有写法保持一致。
    await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                      rate_employee,rate_employer)
                    VALUES ((SELECT COALESCE(max(id),0)+1 FROM si_policy),
                            '上海','unemploy','2026-03-01',5975,31014,0.005,0.005)
                    ON CONFLICT (city,item,effective_from) DO NOTHING`);
    const r = (await db.query(
      `SELECT item, public.fn_si_item_code(item) AS code FROM si_policy
        WHERE city='上海' AND effective_from='2026-03-01'`)).rows[0];
    rec('SIV1', '录 `unemploy` 落库成 `unemployment`，且能对上工资项 SI_UNEMPLOYMENT'
      + '（正是"钱扣了、行没写"那个 bug 的判据）',
      r && r.item === 'unemployment' && r.code === 'SI_UNEMPLOYMENT',
      `落库=${r && r.item} 工资项=${r && r.code}`);
    await db.query(`DELETE FROM si_policy WHERE city='上海' AND effective_from='2026-03-01'`);
  }

  { // SIV2 另外两种常见叫法
    await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                      rate_employee,rate_employer)
                    SELECT (SELECT COALESCE(max(id),0) FROM si_policy)+v.n,
                           '上海',v.item,'2026-03-01',v.f,v.c,v.e,v.r
                      FROM (VALUES (1,'housing',2690,36921,0.07,0.07),
                                   (2,'endowment',5975,31014,0.08,0.16),
                                   (3,'medicare',5975,31014,0.02,0.095)) AS v(n,item,f,c,e,r)
                    ON CONFLICT (city,item,effective_from) DO NOTHING`);
    const items = (await db.query(
      `SELECT item FROM si_policy WHERE city='上海' AND effective_from='2026-03-01'
        ORDER BY item`)).rows.map(x => x.item);
    rec('SIV2', 'housing → housing_fund、endowment → pension、medicare → medical（别名一律落成规范键）',
      items.join(',') === 'housing_fund,medical,pension', items.join(','));
    await db.query(`DELETE FROM si_policy WHERE city='上海' AND effective_from='2026-03-01'`);
  }

  { // SIV3 认不出的键不猜
    await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                      rate_employee,rate_employer)
                    VALUES ((SELECT COALESCE(max(id),0)+1 FROM si_policy),
                            '上海','long_term_care','2026-03-01',5975,31014,0.001,0.001)`);
    const it = (await db.query(
      `SELECT item FROM si_policy WHERE city='上海' AND effective_from='2026-03-01'`)).rows[0].item;
    rec('SIV3', '认不出的险种键原样保留（不猜、不丢）—— 猜错会把它并进别的险种',
      it === 'long_term_care', `落库=${it}`);
    await db.query(`DELETE FROM si_policy WHERE city='上海' AND effective_from='2026-03-01'`);
  }

  { // SIV4 存量已改正：库里不该再有别名
    const n = Number((await db.query(
      `SELECT count(*)::int n FROM si_policy WHERE item <> public.fn_si_item_canon(item)`)).rows[0].n);
    rec('SIV4', '存量数据已改正：si_policy 里不再有别名键（否则历史月份的申报表会缺险种）',
      n === 0, `别名 ${n} 条`);
  }

  { // SIV5 空键直接拒（录的时候漏了，比"落一个空险种"好）
    let msg = '';
    try {
      await db.query(`INSERT INTO si_policy(id,city,item,effective_from,base_floor,base_ceiling,
                        rate_employee,rate_employer)
                      VALUES ((SELECT COALESCE(max(id),0)+1 FROM si_policy),
                              '上海','  ','2026-03-01',5975,31014,0.01,0.01)`);
    } catch (e) { msg = e.message; }
    rec('SIV5', '险种键为空 → E_SI_ITEM_EMPTY（不留一个"没有名字的险种"在库里）',
      /E_SI_ITEM_EMPTY/.test(msg), String(msg).split('\n')[0].slice(0, 44));
  }
}

// ===========================================================================
// CHAIN 组 · 累计预扣的链条（143）：先算哪期都行、封账自前向后、封完不许动上游
// ---------------------------------------------------------------------------
// 个税是累计预扣：本月税 = 累计应纳税额 − 已预扣。所以"这个月"依赖"前面每个月"，
// 而 143 之前只读**已封账**的前期 —— 顺序一错（先算 2 月后算 1 月），2 月就永久
// 少一个月，少缴要补税加滞纳金、多缴要等汇算清缴才退。
//
// 143 的修法不是"提醒人按顺序来"，是把顺序这件事从人身上拿掉：算薪读累计不分状态
// （draft 也读），约束改由封账门禁承担（自前向后）+ 重算后验（会让下游失真就回滚）。
// 这一组验的正是这三条，外加跨法人、年终奖、同期 v1/v2 三个"不该混进累计"的口子。
//
// ★ 用独立法人 998（跨法人那条用 997），期间 2027-01..03。累计预扣按**扣缴义务人**
//   累计，混进别组的法人，别人的封账批次会让这里的累计多一个月 —— 测试互相踩。
// ★ 减除费用按 5000 造数，同时给 tax_param 插一条 2027=5000：fn_payroll_calc 从
//   tax_param 读，fn_payrun_chain 缺省 5000 —— 两边口径得是同一个数，否则 stale 判据
//   会误报（"过期"是提示，误报几次就没人看了）。组末删掉这条参数。
//
// ★ 造数只用 INSERT + `UPDATE pay_run SET status='sealed'`，**不走 fn_pay_run_seal**
//   造背景数据：门禁拦的正是它，用它造数就造不出"前期 draft + 本期已封"这类错位状态
//   （而错位状态恰恰是这一组要验的东西）。
// ===========================================================================
{
  const ENT = 998, ENT2 = 997;
  const M1 = '2027-01', M2 = '2027-02', M3 = '2027-03';
  const A = 9980, B = 9981;            // 人：甲 10000 / 乙 8000
  const NAME_A = '链条甲';

  await db.query(`INSERT INTO tax_param(year,threshold) VALUES (2027,5000)
                  ON CONFLICT (year) DO NOTHING`);

  await db.query(`INSERT INTO person(id,full_name) VALUES ($1,$2),($3,'链条乙')
                  ON CONFLICT (id) DO NOTHING`, [A, NAME_A, B]);
  // 甲在法人 998 与法人 997 各有一份任职：跨法人那条（CHAIN6）要有真实的"两头发薪"
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (9980,$1,$3,'2027-01-01'),(9981,$2,$3,'2027-01-01'),(9970,$1,$4,'2027-01-01')
                  ON CONFLICT (id) DO NOTHING`, [A, B, ENT, ENT2]);
  await db.query(`DELETE FROM salary_standard WHERE employment_id IN (9980,9981,9970)`);
  await db.query(`INSERT INTO salary_standard(employment_id,monthly_amount,effective_from) VALUES
                    (9980,10000,'2027-01-01'),(9981,8000,'2027-01-01'),(9970,99999,'2027-01-01')`);

  // 每月减除费用：造数口径与 fn_payrun_chain 的缺省、fn_payroll_calc 读的 tax_param 一致
  const THR = 5000;

  // 社保个人部分：**照算薪引擎的取数方式**从库里取（按险种取最新一条政策、逐项四舍五入
  // 再相加），不在这里写死 8%。写死的话造出来的工资条与引擎口径不一致，CHAIN5 里
  // "下游失真"就会来自 si 对不上、而不是"上游改过" —— 那条件断就没验到门禁本身。
  const siOf = async (emp, gross) => Number((await db.query(
    `SELECT COALESCE(sum(round(
              public.fn_si_base_eff($1,'上海',p.item,$2,'2027-01-31'::date) * p.rate_employee, 2)), 0) s
       FROM (SELECT DISTINCT ON (item) item, rate_employee
               FROM si_policy
              WHERE city='上海' AND effective_from <= '2027-01-31' AND rate_employee > 0
              ORDER BY item, effective_from DESC) p`, [emp, gross])).rows[0].s);

  const mkRun = async (period, kind, status, ver = 1) => Number((await db.query(
    `INSERT INTO pay_run(period,legal_entity_id,kind,status,calc_version,sealed_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [period, ENT, kind, status, ver, status === 'draft' ? null : new Date()])).rows[0].id);

  const sealRun = (id) =>
    db.query(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=$1`, [id]);

  // 封账门禁在 143 里是两条：①本期之前还有 draft → 拒；②本期的累计与当前前期对不上
  // （stale）→ 默认拒，要人明确勾选"确认按现状封账"（p_accept_stale）才放行。
  // CHAIN3/CHAIN8 验的是①（顺序），所以这里带"确认"去封；②的语义在 CHAIN4 里单看
  // （chain 的 stale_count 与 can_seal 是分开的两个回答：过期只是提示，能不能封另说）。
  // ★ 参数个数从库里读：143 在评审中给这条门禁加了签字参数，测试跟着库走，
  //   不假设签名停在哪一版（少一个参数时会打到旧的两参版本上）。
  const sealConfirm = async (run) => {
    const nargs = Number((await db.query(
      `SELECT pronargs::int n FROM pg_proc WHERE proname='fn_pay_run_seal'`)).rows[0].n);
    return db.query(`SELECT fn_pay_run_seal($1,'hr'${nargs >= 3 ? ',true' : ''})`, [run]);
  };

  // 一张工资条：本月税 = fn_iit_cumulative(累计应纳税所得额) − 前期已扣（累计预扣本身）。
  // 税在库里算，不在 JS 里重写一遍税率表 —— 断言要验的是链条，不是我的算术。
  const mkSlip = async (run, emp, gross, si, cum, paidPrev) => {
    const tax = (await db.query(
      `SELECT GREATEST(round(public.fn_iit_cumulative($1) - $2, 2), 0) t`,
      [cum, paidPrev])).rows[0].t;
    const id = Number((await db.query(
      `INSERT INTO payslip(pay_run_id,employee_id,gross_amount,net_amount,si_employee,
                           tax_amount,cum_taxable,special_deduction)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0) RETURNING id`,
      [run, emp, gross, Number(gross) - Number(si) - Number(tax), si, tax, cum])).rows[0].id);
    await db.query(`INSERT INTO payslip_item(payslip_id,item_code,amount) VALUES
                      ($1,'BASE',$2),($1,'IIT',$3)`, [id, gross, -Number(tax)]);
    return id;
  };

  // ---------------- ① 顺序颠倒：先封 2 月，后补 1 月 ----------------
  // 2 月的累计按"1 月已存在"算（= 两个月的应纳税所得额相加）—— 这就是 143 之后
  // draft 也读的效果。造数顺序与期间顺序相反，正是为了证明"顺序已经不影响结果"。
  const siA = await siOf(A, 10000), siB = await siOf(B, 8000);
  const tA = 10000 - siA - THR;          // 甲每月应纳税所得额（应发 − 社保 − 5000）
  const tB = 8000 - siB - THR;

  const r2 = await mkRun(M2, 'monthly', 'draft');
  await mkSlip(r2, A, 10000, siA, 2 * tA, (await db.query(
    `SELECT public.fn_iit_cumulative($1) t`, [tA])).rows[0].t);
  await mkSlip(r2, B, 8000, siB, 2 * tB, (await db.query(
    `SELECT public.fn_iit_cumulative($1) t`, [tB])).rows[0].t);
  await sealRun(r2);

  const r1 = await mkRun(M1, 'monthly', 'draft');
  await mkSlip(r1, A, 10000, siA, tA, 0);
  await mkSlip(r1, B, 8000, siB, tB, 0);
  await sealRun(r1);

  { // CHAIN1
    const d = (await db.query(
      `SELECT i.cum_income, i.cum_taxable, i.cum_tax, i.cum_paid, i.should_pay, i.months_counted
         FROM fn_declare_iit($1,$2) i WHERE i.person_name=$3`, [ENT, M2, NAME_A])).rows[0];
    rec('CHAIN1', '先封 2027-02、后补 2027-01：2 月申报表的累计收入仍是 1+2 月 = 20000'
      + '（顺序颠倒也算对 —— 这是 143 的全部目的；旧实现只读已封账的前期，'
      + '2 月算的时候 1 月是 draft，累计会永久少一个月，而 2 月一封账就改不了）',
      Number(d.cum_income) === 20000 && Number(d.cum_taxable) === 2 * tA
      && Number(d.months_counted) === 2 && Math.abs(Number(d.should_pay)) < 0.005,
      `累计收入=${d.cum_income} 累计应纳税所得额=${d.cum_taxable}（应=${2 * tA}）`
      + ` 累计应扣=${d.cum_tax} 累计已缴=${d.cum_paid} 应补退=${d.should_pay}`
      + ` 月数=${d.months_counted}`);
  }

  // ---------------- ② 下游已封账：重算上游不许把下游改坏 ----------------
  { // CHAIN5 把 1 月的月薪从 1 万改成 2 万再重算 1 月 → 2 月的累计跟着失真 → 整体回滚
    const v2 = await mkRun(M1, 'monthly', 'draft', 2);   // 1 月再算一版（draft）
    await db.query(`UPDATE salary_standard SET monthly_amount=20000
                     WHERE employment_id=9980 AND effective_from='2027-01-01'`);
    let msg = '';
    try { await db.query(`SELECT fn_payroll_calc($1)`, [v2]); }
    catch (e) { msg = e.message; }
    await db.query(`UPDATE salary_standard SET monthly_amount=10000
                     WHERE employment_id=9980 AND effective_from='2027-01-01'`);
    // 后验的语义是"重算之后下游必须仍然对得上"，所以拦下来时**这一版一个字都不许留**：
    // 同事务内 RAISE 把上面所有写入一起撤销。落下的工资条条数就是这条回滚的判据。
    const left = Number((await db.query(
      `SELECT count(*)::int n FROM payslip WHERE pay_run_id=$1`, [v2])).rows[0].n);
    await db.query(`DELETE FROM payslip WHERE pay_run_id=$1`, [v2]);
    await db.query(`DELETE FROM pay_run WHERE id=$1 AND status='draft'`, [v2]);
    rec('CHAIN5', '月薪 1 万改 2 万后重算 2027-01：2027-02 已封账会随之失真 → '
      + 'E_PAYROLL_DOWNSTREAM_SEALED，且这一版一条工资条都没留下（同事务整体回滚）'
      + '—— 封账的数改不了，要补发的钱走调整单',
      /E_PAYROLL_DOWNSTREAM_SEALED/.test(msg) && left === 0,
      `${String(msg).split('\n')[0].slice(0, 96)}；落下的工资条=${left} 条`);
  }

  // ---------------- ③ 跨法人不混累计 ----------------
  { // CHAIN6
    const r997 = Number((await db.query(
      `INSERT INTO pay_run(period,legal_entity_id,kind,status,sealed_at)
       VALUES ($1,$2,'monthly','sealed',now()) RETURNING id`, [M1, ENT2])).rows[0].id);
    await mkSlip(r997, A, 99999, 0, 0, 0);   // 显眼的金额：混进来一眼能看出
    const d = (await db.query(
      `SELECT i.cum_income FROM fn_declare_iit($1,$2) i WHERE i.person_name=$3`,
      [ENT, M1, NAME_A])).rows[0];
    rec('CHAIN6', '同一个人 9980 在法人 997 也有一张 2027-01 工资条（应发 99999）：'
      + '法人 998 的累计收入仍是 10000 —— 累计预扣按扣缴义务人分别累计，'
      + '混算是把两家公司的所得加在一起（多缴）',
      Number(d.cum_income) === 10000,
      `法人 998 累计收入=${d.cum_income}（997 那张 99999 不该进来）`);
  }

  // ---------------- ④ 年终奖不进工资薪金累计 ----------------
  { // CHAIN7
    const rB = await mkRun(M1, 'bonus', 'draft');
    await mkSlip(rB, A, 50000, 0, 50000, 0);
    await sealRun(rB);
    const d = (await db.query(
      `SELECT i.cum_income FROM fn_declare_iit($1,$2) i WHERE i.person_name=$3`,
      [ENT, M1, NAME_A])).rows[0];
    rec('CHAIN7', '2027-01 再加一个 5 万年终奖批次（已封账）：工资薪金累计收入仍是 10000'
      + '—— 年终奖按全年一次性奖金单独计税，它的应纳税所得额进了综合所得累计就是多缴',
      Number(d.cum_income) === 10000,
      `累计收入=${d.cum_income}（年终奖批次另计，不进这张表）`);
  }

  // ---------------- ⑤ 封账门禁：前期是 draft 就不许封本期 ----------------
  const r3 = await mkRun(M3, 'monthly', 'draft');
  await mkSlip(r3, A, 10000, siA, 3 * tA, (await db.query(
    `SELECT public.fn_iit_cumulative($1) t`, [2 * tA])).rows[0].t);
  await mkSlip(r3, B, 8000, siB, 3 * tB, (await db.query(
    `SELECT public.fn_iit_cumulative($1) t`, [2 * tB])).rows[0].t);

  { // CHAIN2 让 2027-02 留一个 draft 版本（同期的第二版，故意不封）→ 封 03 被拒
    const blocker = await mkRun(M2, 'monthly', 'draft', 2);
    let msg = '';
    try { await db.query(`SELECT fn_pay_run_seal($1,'hr')`, [r3]); }
    catch (e) { msg = e.message; }
    const st = (await db.query(`SELECT status FROM pay_run WHERE id=$1`, [r3])).rows[0].status;
    await db.query(`DELETE FROM pay_run WHERE id=$1 AND status='draft'`, [blocker]);
    rec('CHAIN2', '2027-02 还留着一个 draft 版本 → 封 2027-03 被拒 E_SEAL_UPSTREAM_DRAFT，'
      + '且 03 仍是 draft —— 封账必须自前向后：前期没定稿，本期的累计就建立在一份'
      + '还会变的数上（这一条人不用记，系统会拦）',
      /E_SEAL_UPSTREAM_DRAFT/.test(msg) && st === 'draft',
      `${String(msg).split('\n')[0].slice(0, 54)}；03 状态=${st}`);
  }

  { // CHAIN3 上游都封了 → 同一个批次能封（门禁拦的是顺序，不是"永远封不了"）
    let msg = '';
    try { await sealConfirm(r3); }
    catch (e) { msg = e.message; }
    const st = (await db.query(`SELECT status FROM pay_run WHERE id=$1`, [r3])).rows[0].status;
    rec('CHAIN3', '上游（2027-01/02）都封了之后，同一个 2027-03 批次能封成功 —— '
      + '门禁拦的是顺序，不是"封不了账"（拦完不给人路走，人就会去直接改库）。'
      + '封的时候勾了"确认按现状封账"：本条验的是顺序那条门禁，stale 那条在 CHAIN4 里看',
      msg === '' && st === 'sealed',
      `状态=${st}${msg ? '；报错=' + String(msg).split('\n')[0].slice(0, 40) : '（未抛错）'}`);
  }

  { // CHAIN4 链条状态六列：页面显示与门禁共用同一个判据
    const v2 = await mkRun(M2, 'monthly', 'draft', 2);
    await mkSlip(v2, A, 12000, await siOf(A, 12000), tA, 0);   // 故意留一个"上游改过"的过期累计
    const c = (await db.query(
      `SELECT upstream_draft, downstream_sealed, stale_count, stale_names, can_seal, reason
         FROM fn_payrun_chain($1)`, [v2])).rows[0];
    // ★ can_seal 必须与 fn_pay_run_seal 的**默认行为**一致（评审第 1 条）：
    //   门禁默认对 stale 抛错，所以这里有 1 人过期时 can_seal 必须是 false ——
    //   否则页面给一个绿的按钮，点下去 409。reason 里同时给出"确认才可封"的出路。
    const why = String(c.reason || '');
    rec('CHAIN4', 'fn_payrun_chain 六列各答各的：上游已全封（空）、下游 2027-03 已封、'
      + '1 人累计过期且点了名、can_seal=false（与门禁默认一致，不是绿的按钮点下去报红）、'
      + 'reason 说清"确认才可封"',
      c.upstream_draft === null && String(c.downstream_sealed) === M3
      && Number(c.stale_count) === 1 && String(c.stale_names) === NAME_A
      && c.can_seal === false && why.includes(NAME_A) && why.includes('确认'),
      `上游=${c.upstream_draft ?? '空'} 下游=${c.downstream_sealed} `
      + `过期=${c.stale_count}人/${c.stale_names} 可封=${c.can_seal} 理由=${why.slice(0, 40)}`);
    await db.query(`DELETE FROM payslip WHERE pay_run_id=$1`, [v2]);
    await db.query(`DELETE FROM pay_run WHERE id=$1 AND status='draft'`, [v2]);
  }

  { // CHAIN10 「默认拒 + 确认放行」这条路自己也要有断言（评审第 7 条）
    // ★ 一个门禁最容易被写坏的地方是**默认分支**：CHAIN3/CHAIN8 都带"确认"去封，
    //   如果哪天默认分支的 RAISE 被误删，那几条仍然全绿 —— 而"过期却悄悄封掉"
    //   是最贵的一种静默失败。
    // ★ 用一个**独立的期**（2027-04）：这一条会把它封账，若塞在 02 上会把
    //   "02 的最新版本"改掉，CHAIN8 的期望值（10000+12000+10000）就跟着变。
    const v3 = await mkRun('2027-04', 'monthly', 'draft', 1);
    await mkSlip(v3, A, 13000, await siOf(A, 13000), tA, 0);   // 累计与前期对不上 → stale
    let msg1 = '';
    try { await db.query(`SELECT fn_pay_run_seal($1,'hr')`, [v3]); }
    catch (e) { msg1 = e.message; }
    const st1 = (await db.query(`SELECT status FROM pay_run WHERE id=$1`, [v3])).rows[0].status;
    let msg2 = '';
    try { await db.query(`SELECT fn_pay_run_seal($1,'hr',true)`, [v3]); }
    catch (e) { msg2 = e.message; }
    const st2 = (await db.query(`SELECT status, sealed_by FROM pay_run WHERE id=$1`, [v3])).rows[0];
    rec('CHAIN10', '默认拒、确认才放行：不勾选 → E_SEAL_CHAIN_STALE 且仍是 draft；'
      + '勾选（第三参数 true）→ 封账成功并记下是谁封的',
      /E_SEAL_CHAIN_STALE/.test(msg1) && st1 === 'draft'
      && msg2 === '' && st2.status === 'sealed' && st2.sealed_by === 'hr',
      `默认=${String(msg1).slice(0, 30)} 状态=${st1}；确认后=${st2.status}/${st2.sealed_by}`);
  }

  { // CHAIN8 同一期 v1/v2 都封账 → 累计取最新版本算一次，不重复计
    const v2 = await mkRun(M3, 'monthly', 'draft', 2);
    const si12 = await siOf(A, 12000);
    await mkSlip(v2, A, 12000, si12, 2 * tA + (12000 - si12 - THR),
      (await db.query(`SELECT public.fn_iit_cumulative($1) t`, [2 * tA])).rows[0].t);
    let msg = '';
    try { await sealConfirm(v2); }
    catch (e) { msg = e.message; }
    const n = Number((await db.query(
      `SELECT count(*)::int n FROM pay_run WHERE legal_entity_id=$1 AND period=$2
         AND kind='monthly' AND status IN ('sealed','paid')`, [ENT, M3])).rows[0].n);
    const d = (await db.query(
      `SELECT i.cum_income FROM fn_declare_iit($1,$2) i WHERE i.person_name=$3`,
      [ENT, M3, NAME_A])).rows[0];
    rec('CHAIN8', '同一期 v1/v2 两个批次都封账：累计收入仍是 10000+12000+10000=32000'
      + '（按期取最新版本算一次；直接 SUM 会翻成 42000，而这是报给税务局的数）',
      n === 2 && msg === '' && Number(d.cum_income) === 32000,
      `2027-03 已封版本=${n} 个；累计收入=${d.cum_income}（重复计会是 42000）`);
  }

  { // CHAIN9 三期等额：累计是"累计值"，不能把各期的 cum 再 SUM 一遍
    // ★ 这条钉的是一个**从 133 就在的真 bug**：payslip.cum_taxable 存的是
    //   "本年截至本期的累计"，而算薪时用 SUM(cum_taxable) 取上游 ——
    //   第 3 期起会重复累加。只算 1、2 期看不出来（上游只有一条），
    //   到第 3 期才开始偏，而偏出来的数"看起来完全合理"。
    //   用真算（fn_payroll_calc）而不是手造，才验得到这条链。
    const ENT9 = 996, NAME9 = '链测丙';
    await db.query(`INSERT INTO person(id,full_name) VALUES (9960,$1) ON CONFLICT (id) DO NOTHING`, [NAME9]);
    await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                    VALUES (9960,9960,$1,'2027-01-01') ON CONFLICT (id) DO NOTHING`, [ENT9]);
    await db.query(`DELETE FROM salary_standard WHERE employment_id=9960`);
    await db.query(`INSERT INTO salary_standard(employment_id,monthly_amount,effective_from)
                    VALUES (9960,10000,'2027-01-01')`);
    // 10000 − 社保 800 − 减除 5000 = 4200 / 月
    const cum = [];
    for (const pp of ['2027-01', '2027-02', '2027-03']) {
      const rid = Number((await db.query(
        `INSERT INTO pay_run(period,legal_entity_id) VALUES ($1,$2) RETURNING id`,
        [pp, ENT9])).rows[0].id);
      await db.query(`SELECT fn_payroll_calc($1)`, [rid]);
      cum.push(Number((await db.query(
        `SELECT cum_taxable FROM payslip WHERE pay_run_id=$1`, [rid])).rows[0].cum_taxable));
      await db.query(`UPDATE pay_run SET status='sealed', sealed_at=now() WHERE id=$1`, [rid]);
    }
    // ★ 断言写成"等差数列"而不是写死金额：每期应发、社保、险种都是环境决定的，
    //   写死数字等于把"这个库配了几个险种"也钉进断言 —— 那是另一件事。
    //   第 1 期上游为空，所以 cum[0] 就是当期应纳税所得额，后面每期加一份。
    //   SUM 旧写法下第 3 期会是 cum[0]+cum[1]+cum[2]_当期 = 1+2+1 = 4 份。
    const per = cum[0];
    rec('CHAIN9', '三期等额：累计应纳税所得额是 1、2、3 份（SUM 旧写法第 3 期会算成 4 份）',
      per > 0 && cum[1] === per * 2 && cum[2] === per * 3,
      `${cum.join(' → ')}（每期 ${per}）`);
  }

  // 收尾：封账不可逆（E_PAYSLIP_FROZEN），这一组造出来的**封账批次留在库里**
  // （法人 997/998，跑完随库丢弃）—— 与 DECL 组同一个做法。
  // 人员与任职也留着：工资条只存 employee_id、不挂外键，删了人反而让留着的工资条
  // 查不出姓名，看起来像数据坏了。能删的只有临时件：上面几版 draft 已删，
  // 这里删掉 2027 的减除费用参数 —— 它没有引用关系，留着会让后来人以为
  // 2027 的减除费用是"配过的"（chain 缺省就是 5000）。
  await db.query(`DELETE FROM tax_param WHERE year=2027`);
}

// ===========================================================================
// TR 组 · 培训学习（144）：学时是到场记录，不是填报数字
// ---------------------------------------------------------------------------
// 这一层是一条四步链：课程（标准学时）→ 场次（谁讲、哪天、几学时）→
// 报名/出勤 → 结业（学时够了才算完）。每一步都有一种"抄近路"的走法：
//   · 教室坐不下就多塞一个人（容量）；
//   · "我学了 8 小时"直接填（出勤学时）；
//   · 结业记录事后改一下（冻结）。
// 八条断言验的主要不是"记得进去"，是"这几条近路为什么走不通"。
//
// ★ 用独立法人 995：年度学时是**按人按年**汇总的，混在法人 1 里，
//   别的组多记一条 completed，这里的合计就跟着变 —— 测试之间互相踩。
//   人员沿用 9950/9951（DECL 组已建好；一人可在多法人并行任职），
//   但**任职 id 另给 19950/19951**：9950/9951 那两个 id 已经占给法人 999 了，
//   同一条任职不能挂两家法人。
// ★ 编号用 TRN1..TRN8，不用 TR1..TR8：TR1..TR7 已经被离职组（007）占了，
//   两条 `PASS TR1` 打在同一个屏幕上，出事时看不出红的是哪一条。
// ===========================================================================
{
  const ENT = 995;

  await db.query(`INSERT INTO person(id,full_name) VALUES (9950,'培训甲'),(9951,'培训乙')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (19950,9950,$1,'2026-01-01'),(19951,9951,$1,'2026-01-01')
                  ON CONFLICT (id) DO NOTHING`, [ENT]);

  // 课程 A：标准 8 学时（结业门槛 8）；课程 B：标准 4 学时。
  // ★ B 故意短：TR5 要留一条 completed 在库里，而留 4 学时的那条，
  //   9950 的年度合计就是 4 —— TR7 才有"差 4 学时"这种真正的缺口可看。
  const mkCourse = async (code, name, std, cat) => Number((await db.query(
    `INSERT INTO training_course(code,name,category,std_hours) VALUES ($1,$2,$3,$4)
     ON CONFLICT (code) DO UPDATE SET std_hours=EXCLUDED.std_hours
     RETURNING id`, [code, name, cat, std])).rows[0].id);
  const cA = await mkCourse('TRC995A', '岗前安全培训', 8, 'safety');
  const cB = await mkCourse('TRC995B', '消防器材实操', 4, 'skill');

  const mkSession = async (course, starts, hours, capacity, status = 'planned') =>
    Number((await db.query(
      `INSERT INTO training_session(course_id,legal_entity_id,starts_at,ends_at,hours,capacity,status)
       VALUES ($1,$2,$3::timestamptz, $3::timestamptz + make_interval(hours => $4::int),
               $4, $5::int, $6)
       RETURNING id`, [course, ENT, starts, hours, capacity, status])).rows[0].id);

  const s1 = await mkSession(cA, '2026-03-10 09:00+08', 8, null);   // TR1
  const s2 = await mkSession(cA, '2026-03-20 09:00+08', 8, 1);      // TR2 容量 1
  const s3 = await mkSession(cA, '2026-04-10 09:00+08', 8, null);   // TR3
  const s4 = await mkSession(cB, '2026-05-10 09:00+08', 4, null);   // TR5
  const s5 = await mkSession(cA, '2025-06-10 09:00+08', 8, null);   // TR6 跨年
  const s6 = await mkSession(cA, '2026-06-10 09:00+08', 8, null, 'cancelled'); // TR8
  const s7 = await mkSession(cA, '2026-07-10 09:00+08', 8, null);   // TR6 attended
  const s8 = await mkSession(cA, '2026-08-10 09:00+08', 4, null);   // TR4 本场只给 4h

  const enroll = async (sess, emp) => Number((await db.query(
    `SELECT fn_training_enroll($1,$2,'hr') AS id`, [sess, emp])).rows[0].id);
  const attend = async (en, hours) => (await db.query(
    `SELECT fn_training_attend($1,$2,'hr') AS s`, [en, hours])).rows[0].s;
  const rowOf = async (en) => (await db.query(
    `SELECT status, attended_hours, completed_at FROM training_enrollment WHERE id=$1`,
    [en])).rows[0];

  { // TR1 报名落 invited；同一场同一人再报被拒（唯一约束藏在函数里的那一步）
    const en1 = await enroll(s1, 9950);
    const st1 = (await rowOf(en1)).status;
    let msg = '';
    try { await db.query(`SELECT fn_training_enroll($1,$2,'hr')`, [s1, 9950]); }
    catch (e) { msg = e.message; }
    rec('TRN1', '报名成功落成 invited；同一场同一人再报 → E_TR_DUP（这个人已经在这场里了，'
      + '不能被派两次）',
      st1 === 'invited' && /E_TR_DUP/.test(msg),
      `status=${st1} 再报=${String(msg).split('\n')[0].slice(0, 34)}`);
  }

  { // TR2 容量满即拒，而且要说清"满到什么程度"
    await enroll(s2, 9950);
    let msg = '';
    try { await db.query(`SELECT fn_training_enroll($1,$2,'hr')`, [s2, 9951]); }
    catch (e) { msg = e.message; }
    rec('TRN2', '容量 1 的场次报第 2 个人 → E_TR_CAPACITY，且报错写清"已满（1 / 1）"'
      + '（不自动扩容：座位数是人定的，系统悄悄加一个等于替现场做决定）',
      /E_TR_CAPACITY/.test(msg) && /已满（1 \/ 1）/.test(msg),
      String(msg).split('\n')[0].slice(0, 56));
  }

  { // TR3 4h < 课程标准 8h → 不结业；补到 8h → 结业
    const en3 = await enroll(s3, 9951);
    const r4 = await attend(en3, 4);
    const a = await rowOf(en3);
    const r8 = await attend(en3, 8);
    const b = await rowOf(en3);
    rec('TRN3', '记 4h 而课程标准 8h → 返回 attended、completed_at 仍是空（没学完就是不结业）；'
      + '再记到 8h → completed 且 completed_at 有值',
      r4 === 'attended' && a.status === 'attended' && a.completed_at === null
      && r8 === 'completed' && b.status === 'completed' && b.completed_at !== null,
      `4h=${r4}/${a.completed_at === null ? '未结业' : '已结业'}；8h=${r8}/${b.status}`);
  }

  { // TR4 记的学时不能超过本场给的学时 —— 多记就是伪造记录
    const en4 = await enroll(s8, 9951);
    let msg = '';
    try { await attend(en4, 8); } catch (e) { msg = e.message; }
    rec('TRN4', '本场只给 4 学时却记 8 学时 → E_TR_HOURS（多记学时是伪造培训记录）',
      /E_TR_HOURS/.test(msg) && /伪造培训记录/.test(msg),
      String(msg).split('\n')[0].slice(0, 60));
  }

  { // TR5 结业之后不可改、不可删（已经当证据用出去了）
    const en5 = await enroll(s4, 9950);
    const done = await attend(en5, 4);
    let up = '', del = '';
    try {
      await db.query(`UPDATE training_enrollment SET attended_hours=8 WHERE id=$1`, [en5]);
    } catch (e) { up = e.message; }
    try { await db.query(`DELETE FROM training_enrollment WHERE id=$1`, [en5]); }
    catch (e) { del = e.message; }
    const still = (await rowOf(en5)).attended_hours;
    rec('TRN5', '已结业后改学时 → E_TR_COMPLETED、删除同样被拒（要纠正走"补一场"，不改历史）',
      done === 'completed' && /E_TR_COMPLETED/.test(up) && /E_TR_COMPLETED/.test(del)
      && Number(still) === 4,
      `结业=${done} 改=${/E_TR_COMPLETED/.test(up)} 删=${/E_TR_COMPLETED/.test(del)} 学时仍=${still}`);
  }

  { // TR6 年度学时只认 completed，且按场次所在年归集
    await attend(await enroll(s5, 9950), 8);     // 2025 年结业 8h
    await attend(await enroll(s7, 9950), 4);     // 2026 年到场 4h，但没学完
    const h26 = Number((await db.query(
      `SELECT fn_training_hours(9950, 2026) h`)).rows[0].h);
    const h25 = Number((await db.query(
      `SELECT fn_training_hours(9950, 2025) h`)).rows[0].h);
    rec('TRN6', '年度学时只算已结业的：9950 在 2026 有 4h 结业 + 4h 到场未结业 → 合计 4（不是 8）；'
      + '2025 年那条 8h 不进 2026 → 2026 仍是 4，2025 是 8',
      h26 === 4 && h25 === 8, `2026=${h26} 2025=${h25}（把 attended 也算进去会是 8）`);
  }

  { // TR7 缺口清单：制度没开就不列人；开了按"应修 − 已结业"算
    const n0 = Number((await db.query(
      `SELECT count(*)::int n FROM fn_training_gap($1, 2026)`, [ENT])).rows[0].n);
    await db.query(`UPDATE policy_value SET value_num=8
                     WHERE policy_code='TRAINING_MIN_HOURS_YEAR' AND effective_from='2026-01-01'`);
    const rows = (await db.query(
      `SELECT g.employee_id, g.got_hours, g.need_hours, g.gap_hours
         FROM fn_training_gap($1, 2026) g ORDER BY g.employee_id`, [ENT])).rows;
    // ★ 收尾改回 0：这一项是全集团共用的，留着 8 会让后面任何按制度项算的地方跟着变
    await db.query(`UPDATE policy_value SET value_num=0
                     WHERE policy_code='TRAINING_MIN_HOURS_YEAR' AND effective_from='2026-01-01'`);
    const jia = rows.find(r => Number(r.employee_id) === 9950);
    const allFit = rows.length > 0 && rows.every(r =>
      Math.abs(Number(r.gap_hours) - Math.max(Number(r.need_hours) - Number(r.got_hours), 0)) < 0.005);
    const back0 = Number((await db.query(
      `SELECT count(*)::int n FROM fn_training_gap($1, 2026)`, [ENT])).rows[0].n);
    rec('TRN7', '年度最低学时 = 0（默认）时缺口清单 0 行（一个"人人都差 0 学时"的清单没人看）；'
      + '改成 8 后逐行 gap = 8 − 已结业学时（甲只有 4 → 差 4）；改回 0 又回到 0 行',
      n0 === 0 && jia && Number(jia.got_hours) === 4 && Number(jia.gap_hours) === 4
      && allFit && back0 === 0,
      `开前=${n0} 行；开后=${rows.length} 行，甲 got=${jia && jia.got_hours} `
      + `gap=${jia && jia.gap_hours}；改回=${back0} 行`);
  }

  { // TR8 已取消的场次不能报名；场次写错要报"不存在"，不是"已取消"
    let closed = '', none = '';
    try { await db.query(`SELECT fn_training_enroll($1,$2,'hr')`, [s6, 9951]); }
    catch (e) { closed = e.message; }
    try { await db.query(`SELECT fn_training_enroll(999999999,$1,'hr')`, [9951]); }
    catch (e) { none = e.message; }
    rec('TRN8', '场次已取消 → E_TR_SESSION_CLOSED；场次不存在 → E_TR_NO_SESSION'
      + '（两种错分开报：一个该去改场次，一个是单号打错了）',
      /E_TR_SESSION_CLOSED/.test(closed) && /E_TR_NO_SESSION/.test(none),
      `取消=${String(closed).split('\n')[0].slice(0, 30)}；不存在=${/E_TR_NO_SESSION/.test(none)}`);
  }

  // 收尾：能删的都删 —— 报名行（invited / attended）删得掉，场次随即删得掉。
  // ★ 但 TR3/TR5/TR6 造出来的 completed 行**留在库里**（E_TR_COMPLETED 拦着 DELETE），
  //   与 DECL 组同一个做法：这些行就是它们自己的证据，删不掉正是设计。
  //   留下的行都挂在法人 995 的场次上，跑完随库丢弃。
  await db.query(`DELETE FROM training_enrollment WHERE session_id IN (${[s1, s2, s7, s8].join(',')})`);
  await db.query(`DELETE FROM training_session WHERE id IN (${[s1, s2, s6, s7, s8].join(',')})`);
}

// ===========================================================================
// RV 组 · 排班写入（145）：062 那条"表在、门没有"的债
// ---------------------------------------------------------------------------
// 这一段要证明的不是"函数能插数据"，而是四件会直接影响钱与签字的事：
//
//   ① **建段就建确认单**。062 的债之所以是 P0：`CONFIRM_MISSING` 数的
//      `v_segment_missing_sheet` 由段表派生，而段表只能靠种子写 → 这条异常
//      永远返回它该有的那几个数，**永远不会因为"新排的班漏了单"而升高**。
//      一条永远不变的异常，比没有这一项更坏：它看起来在工作。
//   ② **重叠 / 锁定 / 门店已确认的班改不动**。同一时段两段 = 两倍工时；
//      锁定的意思是"门店签过了"。
//   ③ **空表不许推、不认可必须写意见、有争议不许锁** —— 这三条都是
//      "让签字有意义"的前置条件。
//   ④ **跨店支援要写原因**。这是一次承诺，不是顺手一排。
//
// 数据用员工 1（成本组织 10）、员工 2、门店 10/11/20，期间 2026-12 —— 不撞既有数据。
// ===========================================================================
const RV_STORE = 10;
const RV_PERIOD = '2026-12';

// 造一个"本店店长"账号：确认人要有东西可解，锁定时也才记得下是谁锁的。
// 走 fn_account_create（064/082 的唯一建账号入口），角色与数据范围一次落。
const rvMgr = Number((await db.query(
  `SELECT fn_account_create('rv_mgr','排班店长','store_mgr',$1,NULL,'rv') id`,
  [RV_STORE])).rows[0].id);

// 员工 1 / 2 的成本组织都归到 A 店：RV1 要验"重叠"、RV2 起要验排班本身，
// 不能先被跨店原因拦住。
// ★ 先删再插：employee_org_assignment 上有 (employee, dim) 的区间排斥约束，
//   叠一段同维度的区间会 23P01 —— 而那个报错看起来像"排班坏了"。
//   （员工 1 的归属被离职组（TR1）结束过，所以这里必须重铺一段。）
for (const emp of [1, 2]) {
  await db.query(`DELETE FROM employee_org_assignment
                   WHERE employee_id = $1 AND dim_code = 'cost_org'`, [emp]);
  await db.query(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
                  VALUES ($1,'cost_org',$2,'2026-01-01')`, [emp, RV_STORE]);
}

const rvAssign = async (emp, d, shift, store = RV_STORE, reason = null) => Number((await db.query(
  `SELECT fn_roster_assign($1,$2::date,$3,$4,$5,'rv') id`,
  [emp, d, shift, store, reason])).rows[0].id);

// 段 + 确认单一起读：这两个必须同生（"有段没单"在 008 里是缺陷，不是一个状态）
const rvSegs = async (sched) => (await db.query(
  `SELECT sg.id, cs.id AS sheet_id, cs.status,
          to_char(sg.start_at AT TIME ZONE app_tz(),'MM-DD HH24:MI') AS s,
          to_char(sg.end_at   AT TIME ZONE app_tz(),'MM-DD HH24:MI') AS e
     FROM schedule_segment sg
     LEFT JOIN confirm_sheet cs ON cs.segment_id = sg.id
    WHERE sg.schedule_id = $1 ORDER BY sg.seq`, [sched])).rows;

const rvSheetsIn = async (store, period) => (await db.query(
  `SELECT cs.id, cs.status, cs.confirm_due_at, cs.confirm_owner_id,
          to_char(sc.work_date,'MM-DD') AS d
     FROM confirm_sheet cs
     JOIN schedule_segment sg ON sg.id = cs.segment_id
     JOIN schedule sc ON sc.id = sg.schedule_id
    WHERE sg.store_id = $1
      AND sc.work_date >= ($2 || '-01')::date
      AND sc.work_date <  (($2 || '-01')::date + interval '1 month')
    ORDER BY sc.work_date, sg.seq`, [store, period])).rows;

{ // RV0 三张表的主键都要有生成方式（第十一次同一个坑）
  //   没有它，排一个班一插就是 23502，而报错指着 id —— 看起来像数据缺失。
  const r = (await db.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND is_identity = 'YES'
        AND table_name IN ('schedule','schedule_segment','confirm_sheet')
      ORDER BY table_name`)).rows.map(x => x.table_name);
  rec('RV0', 'schedule / schedule_segment / confirm_sheet 的主键都有生成方式'
    + '（没有它，排一个班一插就是 23502，而报错指向 id，看起来像数据缺失）',
    r.length === 3, `有 identity 的表：${r.join(',') || '无'}`);
}

{ // RV1 邻日跨夜段撞今天的早班 → 拒
  //   ★ 直接 INSERT（模拟"别的系统写进来的段"）：这一条要验的正是
  //     "库里已有重叠段时，新排的班不能装看不见"。
  //   ★ 只看当天会漏掉这一段：它 20:00 起、次日 10:00 才结束。
  const sid = Number((await db.query(
    `INSERT INTO schedule(employee_id,work_date,shift_id,store_id)
     VALUES (2,'2026-11-05',(SELECT shift_id FROM shift_def WHERE code='CLOSE'),$1)
     RETURNING id`, [RV_STORE])).rows[0].id);
  await db.query(
    `INSERT INTO schedule_segment(schedule_id,seq,store_id,start_at,end_at)
     VALUES ($1,1,$2,
             ('2026-11-05 20:00'::timestamp AT TIME ZONE app_tz()),
             ('2026-11-06 10:00'::timestamp AT TIME ZONE app_tz()))`, [sid, RV_STORE]);
  let msg = '';
  try { await rvAssign(2, '2026-11-06', 'EARLY'); } catch (e) { msg = e.message; }
  rec('RV1', '邻日 20:00→次日 10:00 的段 vs 今天 08:00 的早班 → E_ROSTER_OVERLAP'
    + '（只看当天会漏掉跨零点那一段；两段并存 = 两倍工时）',
    /E_ROSTER_OVERLAP/.test(msg), String(msg).split('\n')[0].slice(0, 46));
}

{ // RV2 休息班：只建 schedule，不建段 —— "休息"不是一段工时
  const sid = await rvAssign(1, '2026-12-01', 'REST');
  const segs = await rvSegs(sid);
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM schedule WHERE employee_id = 1 AND work_date = '2026-12-01'`
  )).rows[0].n);
  rec('RV2', '休息班：schedule 一条、段 0 条、确认单 0 条'
    + '（"休息"不是一段工时，也就不该有确认单）',
    n === 1 && segs.length === 0, `schedule=${n} 段=${segs.length}`);
}

{ // RV3 段与确认单同生；跨零点的下班落到次日
  const a = await rvAssign(1, '2026-12-02', 'EARLY');
  const b = await rvAssign(1, '2026-12-03', 'CLOSE');
  const sa = await rvSegs(a), sb = await rvSegs(b);
  const miss = Number((await db.query(
    `SELECT count(*)::int n FROM schedule_segment sg
      WHERE sg.schedule_id IN (${a},${b})
        AND NOT EXISTS (SELECT 1 FROM confirm_sheet c WHERE c.segment_id = sg.id)`
  )).rows[0].n);
  rec('RV3', 'EARLY 落成 08:00-16:00；CLOSE 17:00 的下班落到次日 01:00（跨零点）；'
    + '两段各自带一条 not_started 确认单 —— 缺单的段 = 0（062 那条债的判据从这里开始不再是假绿）',
    sa.length === 1 && sa[0].s === '12-02 08:00' && sa[0].e === '12-02 16:00'
    && sa[0].status === 'not_started'
    && sb.length === 1 && sb[0].s === '12-03 17:00' && sb[0].e === '12-04 01:00'
    && sb[0].status === 'not_started' && miss === 0,
    `早班=${sa.map(x => `${x.s}~${x.e}/${x.status}`).join()} `
    + `闭店=${sb.map(x => `${x.s}~${x.e}`).join()} 缺单=${miss}`);
}

{ // RV4 推送：not_started → pushed，写上"几号前签"与"该谁签"
  await rvAssign(1, '2026-12-05', 'EARLY');
  await rvAssign(1, '2026-12-06', 'EARLY');
  await rvAssign(1, '2026-12-07', 'LATE');
  await rvAssign(1, '2026-12-08', 'MID');
  const n = Number((await db.query(
    `SELECT fn_roster_push($1,$2,'rv') n`, [RV_STORE, RV_PERIOD])).rows[0].n);
  const rows = await rvSheetsIn(RV_STORE, RV_PERIOD);
  const allPushed = rows.length > 0 && rows.every(x => x.status === 'pushed');
  const hasDue = rows.every(x => x.confirm_due_at !== null);
  const owner = Number(rows[0]?.confirm_owner_id);
  rec('RV4', '推送：6 条 not_started → pushed，写下到期日与该店店长账号'
    + '（推的时候就要说清"谁、几号前签"，否则超时了没人可问）',
    n === 6 && rows.length === 6 && allPushed && hasDue && owner === rvMgr,
    `推=${n} 单=${rows.length} 全pushed=${allPushed} 有到期=${hasDue} `
    + `确认人=${owner}/店长=${rvMgr}`);
}

{ // RV5 不认可却没写意见 → 拒；写了认可才转
  let noNote = '';
  try {
    await db.query(`SELECT fn_roster_confirm($1,$2,false,'   ','rv')`, [RV_STORE, RV_PERIOD]);
  } catch (e) { noNote = e.message; }
  const n = Number((await db.query(
    `SELECT fn_roster_confirm($1,$2,true,NULL,'rv') n`, [RV_STORE, RV_PERIOD])).rows[0].n);
  const rows = await rvSheetsIn(RV_STORE, RV_PERIOD);
  const st = [...new Set(rows.map(x => x.status))];
  rec('RV5', '不认可却没写意见 → E_ROSTER_NO_NOTE（没有意见的争议，排班的人不知道该改哪里）；'
    + '点了"认可"→ 6 条转 store_confirmed',
    /E_ROSTER_NO_NOTE/.test(noNote) && n === 6
    && rows.length === 6 && st.length === 1 && st[0] === 'store_confirmed',
    `无意见被拒=${/E_ROSTER_NO_NOTE/.test(noNote)} 确认=${n} 状态=${st.join('/')}`);
}

{ // RV6 争议要留下来：只推新增的两条，只把这两条标 disputed，意见落库
  await rvAssign(1, '2026-12-09', 'EARLY');
  await rvAssign(1, '2026-12-10', 'LATE');
  const pushed = Number((await db.query(
    `SELECT fn_roster_push($1,$2,'rv') n`, [RV_STORE, RV_PERIOD])).rows[0].n);
  const n = Number((await db.query(
    `SELECT fn_roster_confirm($1,$2,false,$3,'rv') n`,
    [RV_STORE, RV_PERIOD, '12-09 与 12-10 门店盘点，早班要改到 12 点以后'])).rows[0].n);
  const rows = await rvSheetsIn(RV_STORE, RV_PERIOD);
  const dis = rows.filter(x => x.status === 'disputed');
  const note = (await db.query(
    `SELECT dispute_note FROM confirm_sheet WHERE id = $1`, [dis[0]?.id || 0])).rows[0]?.dispute_note;
  rec('RV6', '只推新增的 2 条、只把这 2 条标成 disputed（已确认的 6 条不动），'
    + '意见落库（争议必须留下"为什么不行"）',
    pushed === 2 && n === 2 && dis.length === 2
    && rows.filter(x => x.status === 'store_confirmed').length === 6
    && /盘点/.test(String(note)),
    `推=${pushed} 争议=${n} 已确认=${rows.filter(x => x.status === 'store_confirmed').length} `
    + `意见=${String(note || '').slice(0, 18)}`);
}

{ // RV7 有争议不许锁；处理完才能锁
  let msg = '';
  try { await db.query(`SELECT fn_roster_lock($1,$2,'rv_mgr')`, [RV_STORE, RV_PERIOD]); }
  catch (e) { msg = e.message; }
  const after = await rvSheetsIn(RV_STORE, RV_PERIOD);
  const noneLocked = after.every(x => x.status !== 'locked');

  // 争议的出口是"清掉那一段 → 重排 → 重新推送"，不是把 disputed 硬改成已确认。
  // ★ 必须先清再排：145 里同一天换班是**拒绝**（E_ROSTER_OVERLAP），不是静默替换 ——
  //   静默替换会让人以为加了第二个班、实际覆盖了第一个，而页面上看不出来。
  //   清除走 fn_roster_clear（显式撤销，locked/store_confirmed 照样拒），
  //   不是裸 DELETE：撤销也是一种改，得和排班守同一条规矩。
  await db.query(`SELECT fn_roster_clear($1,$2::date,$3,'rv')`, [1, '2026-12-09', 'EARLY']);
  await db.query(`SELECT fn_roster_clear($1,$2::date,$3,'rv')`, [1, '2026-12-10', 'LATE']);
  await rvAssign(1, '2026-12-09', 'MID');
  await rvAssign(1, '2026-12-10', 'EARLY');
  await db.query(`SELECT fn_roster_push($1,$2,'rv')`, [RV_STORE, RV_PERIOD]);
  const ok = Number((await db.query(
    `SELECT fn_roster_confirm($1,$2,true,NULL,'rv') n`, [RV_STORE, RV_PERIOD])).rows[0].n);
  const locked = Number((await db.query(
    `SELECT fn_roster_lock($1,$2,'rv_mgr') n`, [RV_STORE, RV_PERIOD])).rows[0].n);
  const biz = Number((await db.query(
    `SELECT count(*)::int n FROM v_segment_confirm v
       JOIN schedule_segment sg ON sg.id = v.segment_id
       JOIN schedule sc ON sc.id = sg.schedule_id
      WHERE v.store_id = $1 AND v.biz_state = 'confirmed'
        AND sc.work_date >= '2026-12-01' AND sc.work_date < '2027-01-01'`,
    [RV_STORE])).rows[0].n);

  rec('RV7', '有 2 条争议时锁定被拒（报错点名 2 条）且一条都没锁上；改成中班/早班重推再确认后 '
    + '8 条全部锁上、报表上是"已确认"（source=manual，不是超时默认确认）',
    /E_ROSTER_BAD_STATE/.test(msg) && /2 条争议/.test(msg) && noneLocked
    && ok === 2 && locked === 8 && biz === 8,
    `拒=${/E_ROSTER_BAD_STATE/.test(msg)} 拒时锁上=${!noneLocked} `
    + `再确认=${ok} 锁=${locked} 报表已确认=${biz}`);
}

{ // RV8 锁定后既不能改、也不能撤（"锁"的全部意义）
  let msg = '';
  try { await rvAssign(1, '2026-12-05', 'LATE'); } catch (e) { msg = e.message; }
  let clearMsg = '';
  try {
    await db.query(`SELECT fn_roster_clear($1,'2026-12-05','EARLY','rv')`, [1]);
  } catch (e) { clearMsg = e.message; }
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM schedule WHERE employee_id = 1 AND work_date = '2026-12-05'`
  )).rows[0].n);
  const shift = (await db.query(
    `SELECT sd.code FROM schedule sc JOIN shift_def sd ON sd.shift_id = sc.shift_id
      WHERE sc.employee_id = 1 AND sc.work_date = '2026-12-05'`)).rows[0]?.code;
  rec('RV8', '锁定后改班 → E_ROSTER_LOCKED，撤销同样被拒（撤销也是一种改）；'
    + '且 12-05 仍是原来那一条 EARLY（拒得干净：不留半改的段、也不留两条）',
    /E_ROSTER_LOCKED/.test(msg) && /E_ROSTER_LOCKED/.test(clearMsg)
    && n === 1 && shift === 'EARLY',
    `改=${String(msg).split('\n')[0].slice(0, 26)} 撤=${/E_ROSTER_LOCKED/.test(clearMsg)} `
    + `行=${n} 班次=${shift}`);
}

{ // RV9 周视图：带确认状态；没排班的那天不出现
  const rows = (await db.query(
    `SELECT employee_id, person_name, employee_no, to_char(work_date,'YYYY-MM-DD') AS d,
            shift_code, shift_name, color, start_at, end_at, is_rest, confirm_status,
            seg_store_id
       FROM fn_roster_week($1,'2026-12-01',7)
      ORDER BY work_date, employee_id`, [RV_STORE])).rows;
  const d1 = rows.find(x => x.d === '2026-12-01');
  const d4 = rows.filter(x => x.d === '2026-12-04');
  const d5 = rows.find(x => x.d === '2026-12-05');
  rec('RV9', '周视图：12-05 那格带 confirm_status=locked，人/工号/班次/颜色齐全；'
    + '12-01 是休息（is_rest、无起止）；12-04 没排班 → 不出现'
    + '（稀疏行：没排班 ≠ 排了休息）',
    !!d5 && d5.confirm_status === 'locked' && d5.shift_code === 'EARLY'
    && !!d5.person_name && !!d5.employee_no && !!d5.color && Number(d5.seg_store_id) === RV_STORE
    && !!d1 && d1.is_rest === true && d1.start_at === null
    && d4.length === 0,
    `12-05=${d5?.confirm_status}/${d5?.shift_code}/${d5?.employee_no} `
    + `12-01=rest:${d1?.is_rest} 12-04行=${d4.length}`);
}

{ // RV10 推一份空表 → 拒（放在往门店 11 排班之前，否则它就不是空的了）
  let msg = '';
  try { await db.query(`SELECT fn_roster_push($1,$2,'rv')`, [11, RV_PERIOD]); }
  catch (e) { msg = e.message; }
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM confirm_sheet cs
       JOIN schedule_segment sg ON sg.id = cs.segment_id
      WHERE sg.store_id = 11`)).rows[0].n);
  rec('RV10', '门店 11 在 2026-12 一条确认单都没有 → E_ROSTER_EMPTY，且没有凭空造出单'
    + '（推一份空周表给门店，等于让人签一张没内容的字：签了之后"这周没问题"是假的）',
    /E_ROSTER_EMPTY/.test(msg) && n === 0,
    `拒=${/E_ROSTER_EMPTY/.test(msg)} 门店11单数=${n}`);
}

{ // RV11 跨店支援要写原因
  let msg = '';
  try { await rvAssign(1, '2026-12-12', 'EARLY', 11); } catch (e) { msg = e.message; }
  const okId = await rvAssign(1, '2026-12-12', 'EARLY', 11, '临时支援 B 店盘点两天');
  const segStore = (await db.query(
    `SELECT sg.store_id FROM schedule_segment sg WHERE sg.schedule_id = $1`,
    [okId])).rows[0]?.store_id;
  rec('RV11', '跨店（成本组织 10 → 门店 11）没有原因 → E_ROSTER_CROSS_REASON；'
    + '写了原因才排得上，且段落在借入的那家店（签字的是收人的店）',
    /E_ROSTER_CROSS_REASON/.test(msg) && okId > 0 && Number(segStore) === 11,
    `拒=${/E_ROSTER_CROSS_REASON/.test(msg)} 排上=${okId} 段店=${segStore}`);
}

{ // RV12 确认人：最近的店长赢；一个店长都没有时是 NULL，不编一个人出来
  //   ★ 库里除了本店的 rv_mgr，还有一个挂"整棵树"的店长（AC 组造的 ac_boss）。
  //     两个都覆盖 A 店时，该签这张表的是**范围更具体**的那个，
  //     所以这里断的是 rv_mgr 而不是"随便一个店长"。
  const owner10 = Number((await db.query(
    `SELECT max(cs.confirm_owner_id) o FROM confirm_sheet cs
       JOIN public.schedule_segment sg ON sg.id = cs.segment_id
       JOIN public.schedule sc ON sc.id = sg.schedule_id
      WHERE sg.store_id = $1 AND sc.work_date >= '2026-12-01'
        AND sc.work_date < '2027-01-01'`, [RV_STORE])).rows[0].o);

  // 再把店长角色整个摘掉（含那条集团范围的），验"取不到 = NULL"。
  // ★ 只摘角色授权，不删账号：这里要验的是"没有店长"这件事，
  //   而不是"账号不存在"。RV 组跑在最后，不影响其它断言。
  await db.query(`DELETE FROM sys_user_role
                   WHERE role_id = (SELECT id FROM sys_role WHERE code = 'store_mgr')`);

  const sid = await rvAssign(1, '2026-12-13', 'MID', 20, 'C 店新店开业支援三天');
  const n = Number((await db.query(
    `SELECT fn_roster_push($1,$2,'rv') n`, [20, RV_PERIOD])).rows[0].n);
  const row = (await db.query(
    `SELECT cs.confirm_owner_id, cs.confirm_due_at FROM confirm_sheet cs
       JOIN schedule_segment sg ON sg.id = cs.segment_id
      WHERE sg.schedule_id = $1`, [sid])).rows[0];
  rec('RV12', '确认人解析：A 店有两个店长覆盖时取范围更具体的那一个（不是 id 最小的）；'
    + '把店长授权摘掉后 C 店 → confirm_owner_id 为 NULL，到期日仍写（没人签不等于不用签）',
    owner10 === rvMgr && n === 1 && !!row
    && row.confirm_owner_id === null && row.confirm_due_at !== null,
    `A店 owner=${owner10}/本店店长=${rvMgr} C店 owner=${row?.confirm_owner_id} `
    + `有到期=${!!row?.confirm_due_at}`);
}

{ // RV13 排一个不存在的人 → 拒（否则会造出一条"没有主"的段，谁也不报错）
  let msg = '';
  try { await db.query(`SELECT fn_roster_assign(999999,'2027-05-06','EARLY',$1,NULL,'hr')`, [RV_STORE]); }
  catch (e) { msg = e.message; }
  rec('RV13', '排一个库里没有的人 → E_ROSTER_NO_EMPLOYEE（没有这条，随便传个 id 就能造出'
    + '"不存在的人"的段，页面上看不见、考勤算薪也碰不到它）',
    /E_ROSTER_NO_EMPLOYEE/.test(msg), String(msg).split('\n')[0].slice(0, 50));
}

// ★ 这一组在文件末尾才跑（T 组的收口在它之前），所以结论自己记一笔 ——
//   不记的话 SUITE.RV 会永远停在 never_run，覆盖率页上看不出它跑过。
{
  const rs = results.filter(r => /^RV/.test(String(r.id)));
  const fails = rs.filter(r => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.RV', fails === 0 ? 'pass' : 'fail', fails, null]);
}


// ===========================================================================
// RT 组 · 多期趋势（146）：逐期同源 / 空月出行 / 环比 NULL≠0 / 期间校验
// ===========================================================================
// 这一组要证明的不是"趋势能算出来"（能算出来太容易了），而是
// **趋势没有变成第三份口径**。
//
// 另写一套聚合（按月份分组再 sum）与面板引用同一批表，写错的概率并不低，
// 而且错的方式都很安静：漏一个 daterange 的闭区间、把期末归属写成期初、
// 少 join 一次 org 子树。这些错在单条路径上完全看不出来，
// 只在"趋势图上的三月 ≠ 报表上的三月"时出现 —— 而那通常发生在有人已经
// 拿着图开完会之后。
//
// RT1 就是这条守卫：逐期拿 fn_rpt_panel 的值与趋势行比，一个字段一个字段比。
// ★ 期间与组织都是"库里已经有数"的那一段，不是假设：
//   2027-09 / 2027-10 在 A 店（成本组织 10）有真实工资条（应发 8000、社保 1000、个税 500），
//   所以 RT1 的"社保/个税与应发同源"那一条**真的被跑到**；
//   换成一段社保全是 0 的月份，这条断言会绿得毫无意义（0 == 0 不证明任何事）。
//   另一个原因：2026 年那几个月的工资条里有一条是手插的（net 与 gross − 社保 − 个税
//   对不上），用它去核恒等式只会得到一条与口径无关的红。
const RT_ORG = 10;
const RT_FROM = '2027-07';
const RT_TO = '2027-12';
const rtRows = (await db.query('SELECT * FROM fn_rpt_trend($1,$2,$3)',
  [RT_ORG, RT_FROM, RT_TO])).rows;

{ // RT1 逐期同源：趋势的每一格都等于那一期面板上同一个指标的 value
  const bad = [];
  let idChecked = 0;
  for (const r of rtRows) {
    const pan = (await db.query(
      `SELECT metric, value FROM fn_rpt_panel($1,$2)
        WHERE metric IN ('HC_END','PAYROLL_GROSS','PAYROLL_NET','WORK_HOURS')`,
      [RT_ORG, r.period])).rows;
    const pan1 = (m) => Number((pan.find(x => x.metric === m) || { value: 0 }).value);
    const pairs = [
      ['人数', r.headcount, pan1('HC_END')],
      ['应发', r.gross, pan1('PAYROLL_GROSS')],
      ['实发', r.net, pan1('PAYROLL_NET')],
      ['工时', r.work_hours, pan1('WORK_HOURS')],
    ];
    for (const [name, a, b] of pairs) {
      if (Number(a) !== b) bad.push(`${r.period} ${name} 趋势=${a} 面板=${b}`);
    }
    // 工资条自带的不变量：net = gross − 社保 − 个税（015 的约束）。
    // ★ 它在这里是"社保/个税与应发抽自同一批人"的证据：两条归属口径一旦分开，
    //   跨组织的那一行会先破这个等式 —— 而它破的时候，两个数各自都仍然是"对的"。
    const net = Number(r.net);
    const calc = Math.round((Number(r.gross) - Number(r.si_employee) - Number(r.tax)) * 100) / 100;
    if (Number(r.si_employee) !== 0 || Number(r.tax) !== 0) {
      if (net !== calc) bad.push(`${r.period} 恒等式 实发=${net} 应发−社保−个税=${calc}`);
      idChecked++;
    }
  }
  rec('RT1','趋势逐期 == 各期单算 fn_rpt_panel 的值（同源，不是另写一套 sum）；'
    + '社保/个税与应发满足 net = gross − 社保 − 个税（抽自同一批工资条）',
    bad.length === 0 && rtRows.length === 6,
    bad.length ? bad.slice(0, 3).join(' / ')
      : `${rtRows.length} 期逐字段一致，其中 ${idChecked} 期有社保/个税可核恒等式`);
}

{ // RT2 没有数据的月份也要出行（值 0 + has_data=false），区间内也不许缺行
  const empty = (await db.query(
    `SELECT to_char(g,'YYYY-MM') p
       FROM generate_series('2018-01-01'::date, '2030-12-01'::date, interval '1 month') g
      WHERE NOT fn_rpt_has_data(to_char(g,'YYYY-MM'))
        AND fn_rpt_headcount($1, to_char(g,'YYYY-MM'), 'end') = 0
      ORDER BY g LIMIT 1`, [RT_ORG])).rows[0].p;
  const one = (await db.query('SELECT * FROM fn_rpt_trend($1,$2,$2)', [RT_ORG, empty])).rows;
  const cols = ['headcount','gross','net','si_employee','tax','work_hours','ot_hours'];
  const zero = one.length === 1 && one[0].has_data === false
    && cols.every(k => Number(one[0][k]) === 0);
  // 区间要连续：窗口内几个月必须正好几行，一期不多一期不少
  const [fy, fm] = RT_FROM.split('-').map(Number);
  const want = rtRows.map((_, i) => {
    const m = fm + i;
    return `${fy + Math.floor((m - 1) / 12)}-${String(((m - 1) % 12) + 1).padStart(2, '0')}`;
  });
  const got = rtRows.map(x => x.period);
  const cont = JSON.stringify(got) === JSON.stringify(want);
  rec('RT2','没有数据的月份也出行（has_data=false、值为 0）—— 缺行会被折线连成'
    + '"这个月掉到 0 又起来"，而那两段斜坡一天也没发生过',
    zero && cont,
    zero ? `空月 ${empty} 一行、7 列全 0；区间 ${got.length} 期连续` : `空月 ${empty} 行数=${one.length} 值=${JSON.stringify(one.map(x => cols.map(k => x[k])))}`);
}

{ // RT3 环比：本月 − 上月；第一期是 NULL（不是 0）
  const bad = [];
  let checked = 0;
  if (rtRows[0].gross_mom !== null) bad.push(`第一期 gross_mom=${rtRows[0].gross_mom}（应为 NULL）`);
  for (let i = 1; i < rtRows.length; i++) {
    const cur = rtRows[i], prev = rtRows[i - 1];
    const both = cur.has_data === true && prev.has_data === true;
    if (!both) {
      if (cur.gross_mom !== null || cur.gross_mom_pct !== null) {
        bad.push(`${cur.period} 算不出却给了 ${cur.gross_mom}/${cur.gross_mom_pct}（应为 NULL，0 是"持平"）`);
      }
      continue;
    }
    // 差额只要两个月都算过就成立，上月为 0 时差额就是本月全额（不是"算不出"）；
    // 只有**百分比**在上月为 0 时才无定义 —— 除零，给 NULL。
    const want = Math.round((Number(cur.gross) - Number(prev.gross)) * 100) / 100;
    if (Number(cur.gross_mom) !== want) bad.push(`${cur.period} mom=${cur.gross_mom} 应=${want}`);
    if (Number(prev.gross) === 0) {
      if (cur.gross_mom_pct !== null) bad.push(`${cur.period} 上月为 0 却给了百分比 ${cur.gross_mom_pct}`);
    } else {
      const wantPct = Math.round((want / Number(prev.gross)) * 10000) / 100;
      if (Number(cur.gross_mom_pct) !== wantPct) bad.push(`${cur.period} mom%=${cur.gross_mom_pct} 应=${wantPct}`);
    }
    checked++;
  }
  rec('RT3','环比 = 本月 − 上月；第一期是 NULL（不是 0）—— NULL 表示"算不出"，0 表示"持平"，'
    + '把前者写成 0 会在图上凭空多一次暴跌后暴涨',
    bad.length === 0 && checked > 0,
    bad.length ? bad.slice(0, 3).join(' / ') : `第一期 NULL，${checked} 个真实环比逐一对上`);
}

{ // RT4 期间校验：起止写反 / 跨度超上限 / 36 期正好可以
  let range = '', long = '';
  try { await db.query('SELECT * FROM fn_rpt_trend($1,$2,$3)', [RT_ORG, '2026-06', '2026-01']); }
  catch (e) { range = String(e.message); }
  try { await db.query('SELECT * FROM fn_rpt_trend($1,$2,$3)', [RT_ORG, '2024-01', '2027-01']); }
  catch (e) { long = String(e.message); }
  // 写反若被静默放过，generate_series 返回空集 ——"参数写反了"与"这段没数据"同形
  const ok36 = Number((await db.query(
    'SELECT count(*)::int n FROM fn_rpt_trend($1,$2,$3)', [RT_ORG, '2024-01', '2026-12'])).rows[0].n);
  rec('RT4','期间校验：起止写反 → E_RPT_RANGE；跨度 > 36 期 → E_RPT_TOO_LONG（36 期正好放行）',
    /E_RPT_RANGE/.test(range) && /E_RPT_TOO_LONG/.test(long) && ok36 === 36,
    `写反=${/E_RPT_RANGE/.test(range)} 37期=${/E_RPT_TOO_LONG/.test(long)} 36期行数=${ok36}`);
}

// ★ 与 RV 组同理：这一组在 T 组的快照之后才跑，结论得自己记一笔。
{
  const rs = results.filter(r => /^RT\d/.test(String(r.id)));
  const fails = rs.filter(r => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.RPT-TREND', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ===========================================================================
// EXAM 组 · 培训考试（147）：判分在库里 / 交卷即封 / 答案不下发 / 结业需及格
// ---------------------------------------------------------------------------
// 144 的结业只看学时，"坐在教室里"被当成"会了"。147 补的是考试成绩，四条取舍：
//   · 判分从 exam_question.answer 算，接口不收分数（改一个参数就能及格）；
//   · 多选必须完全一致 —— 给部分分等于"全勾上"就能攒到及格线；
//   · 卷面（fn_exam_paper_for）没有 answer 列，否则 F12 就看到答案；
//   · 交卷之后不可改、不可重交，因为这份分数要拿去应付检查。
//
// ★ 用独立法人 994、人员 9930/9931（任职 19930/19931）：这门课配了启用中的试卷，
//   会把 fn_training_attend 的结业判据一起改掉；混进 TR 组那门课里，学时结论跟着漂。
// ★ 编号用 EXAM1..EXAM4，不用 EX1..EX4：收口块按 id 前缀分组，EX 会落到
//   SUITE.EX（报销留痕那一组），而 fn_chk_record 对未登记判据是直接 RAISE。
// ★ 这一组跑在 T 组快照之后（同 RV/RT），结论自己记一笔。
// ===========================================================================
{
  const ENT = 994;
  await db.query(`INSERT INTO person(id,full_name) VALUES (9930,'考试甲'),(9931,'考试乙')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (19930,9930,$1,'2026-01-01'),(19931,9931,$1,'2026-01-01')
                  ON CONFLICT (id) DO NOTHING`, [ENT]);

  // 课程标准 8 学时：EXAM4 要看的是"学时够了但没考过"那一支
  const course = Number((await db.query(
    `INSERT INTO training_course(code,name,category,std_hours)
     VALUES ('EXC994A','岗前安全考试课','safety',8)
     ON CONFLICT (code) DO UPDATE SET std_hours=EXCLUDED.std_hours RETURNING id`)).rows[0].id);

  // 卷子：单选 40 + 判断 30 + 多选 30 = 100，及格 60
  const paper = Number((await db.query(
    `INSERT INTO exam_paper(course_id,code,name,pass_score)
     VALUES ($1,'EXP994A','岗前安全结业考',60)
     ON CONFLICT (code) DO UPDATE SET pass_score=EXCLUDED.pass_score RETURNING id`, [course])).rows[0].id);

  // ★ 多选给 4 个选项、答案只有 A,B：把 4 个全勾上是最省事的蒙分手法，
  //   它必须得 0（这正是"不给部分分"要挡的那件事）。
  await db.query(
    `INSERT INTO exam_question(paper_id,seq,kind,stem,options,answer,score) VALUES
       ($1,1,'single','发现燃气泄漏，第一步做什么？',
        '[{"k":"A","t":"先打电话汇报"},{"k":"B","t":"关总阀再开窗"},{"k":"C","t":"点火确认"}]',
        'B',40),
       ($1,2,'judge','使用灭火器前要先拔掉保险销。','[]','A',30),
       ($1,3,'multi','油炸作业必须穿戴哪些？（多选）',
        '[{"k":"A","t":"围裙"},{"k":"B","t":"防烫手套"},{"k":"C","t":"耳机"},{"k":"D","t":"拖鞋"}]',
        'A,B',30)
     ON CONFLICT (paper_id,seq) DO NOTHING`, [paper]);

  const qid = async (seq) => Number((await db.query(
    `SELECT id FROM exam_question WHERE paper_id=$1 AND seq=$2`, [paper, seq])).rows[0].id);
  const q1 = await qid(1), q2 = await qid(2), q3 = await qid(3);
  const start = async (emp) => Number((await db.query(
    `SELECT fn_exam_start($1,$2) i`, [paper, emp])).rows[0].i);
  const submit = async (att, ans) => (await db.query(
    `SELECT * FROM fn_exam_submit($1,$2::jsonb)`, [att, JSON.stringify(ans)])).rows[0];

  let a1, a2;
  { // EXAM1 分数由库里按 answer 算出来，前端只交"我选了什么"
    a1 = await start(9930);
    const r1 = await submit(a1, [
      { q: q1, picked: 'B' }, { q: q2, picked: 'A' }, { q: q3, picked: 'B,A' }]);
    a2 = await start(9931);
    const r2 = await submit(a2, [
      { q: q1, picked: 'C' }, { q: q2, picked: 'A' }, { q: q3, picked: 'A' }]);
    const m = (await db.query(
      `SELECT score FROM exam_answer WHERE attempt_id=$1 AND question_id=$2`, [a2, q3])).rows[0];
    rec('EXAM1', '判分在库里：全对 = 100 / 及格（多选写成 "B,A" 也认 —— 顺序不该是考生的事）；'
      + '另一人单选答错、多选只选一半 → 30 分 / 不及格，且多选那一题是 0 分'
      + '（选一半给部分分，等于把选项全勾上就能攒到及格线）',
      Number(r1.score) === 100 && r1.passed === true && Number(r1.right_count) === 3
      && Number(r2.score) === 30 && r2.passed === false && Number(m.score) === 0,
      `全对=${r1.score}/${r1.passed} 另一半=${r2.score}/${r2.passed} 多选得分=${m.score}`);
  }

  { // EXAM2 交卷之后这份卷就是证据：改答案、再交、删掉，三条路都封死
    let upd = '', resub = '', del = '';
    try {
      await db.query(`UPDATE exam_answer SET picked='A' WHERE attempt_id=$1 AND question_id=$2`,
        [a1, q1]);
    } catch (e) { upd = e.message; }
    try { await submit(a1, [{ q: q1, picked: 'A' }]); } catch (e) { resub = e.message; }
    try { await db.query(`DELETE FROM exam_attempt WHERE id=$1`, [a1]); } catch (e) { del = e.message; }

    // 阳性对照：那次 UPDATE 不只是"报了个错"，而是一条都没落进去
    const still = (await db.query(
      `SELECT picked FROM exam_answer WHERE attempt_id=$1 AND question_id=$2`,
      [a1, q1])).rows[0].picked;

    rec('EXAM2', '已交卷的答卷：改答题记录 / 再交一次 / 删掉整份 → 全部 E_EXAM_SUBMITTED，'
      + '并且那条 UPDATE 真的没落进去（分数已经作为证据用出去了，不能再变）',
      /E_EXAM_SUBMITTED/.test(upd) && /E_EXAM_SUBMITTED/.test(resub)
      && /E_EXAM_SUBMITTED/.test(del) && still === 'B',
      `改=${/E_EXAM_SUBMITTED/.test(upd)} 重交=${/E_EXAM_SUBMITTED/.test(resub)} `
      + `删=${/E_EXAM_SUBMITTED/.test(del)} 答案仍是=${still}`);
  }

  { // EXAM3 卷子是离开服务端的唯一形状，它里面不能有答案
    const row = (await db.query(`SELECT * FROM fn_exam_paper_for($1) LIMIT 1`, [paper])).rows[0];
    const keys = Object.keys(row || {});
    const sig = (await db.query(
      `SELECT pg_get_function_result(p.oid) t FROM pg_proc p
        WHERE p.proname = 'fn_exam_paper_for'`)).rows[0].t;
    rec('EXAM3', '卷面 fn_exam_paper_for 返回的列里没有 answer，函数签名里也没有 —— '
      + '答案随卷下发到浏览器，考生按 F12 就能看到，而"监考"在线上做不到',
      keys.length > 0 && !keys.some((k) => /answer/i.test(k))
      && !/answer/i.test(String(sig)),
      `列=${keys.join(',')}`);
  }

  { // EXAM4 学时够 ≠ 学完：课程有启用中的试卷时，还差一份及格成绩
    const sess = Number((await db.query(
      `INSERT INTO training_session(course_id,legal_entity_id,starts_at,ends_at,hours,status)
       VALUES ($1,$2,'2026-09-10 09:00+08','2026-09-10 17:00+08',8,'planned')
       RETURNING id`, [course, ENT])).rows[0].id);
    const en = Number((await db.query(
      `SELECT fn_training_enroll($1,$2,'hr') id`, [sess, 9931])).rows[0].id);

    let msg = '';
    try { await db.query(`SELECT fn_training_attend($1,8,'hr')`, [en]); }
    catch (e) { msg = e.message; }
    const mid = (await db.query(
      `SELECT status FROM training_enrollment WHERE id=$1`, [en])).rows[0].status;

    // 补考过了再记一次到场：这一门课才算学完
    const a3 = await start(9931);
    const r3 = await submit(a3, [
      { q: q1, picked: 'B' }, { q: q2, picked: 'A' }, { q: q3, picked: 'A,B' }]);
    const after = (await db.query(
      `SELECT fn_training_attend($1,8,'hr') s`, [en])).rows[0].s;

    rec('EXAM4', '课程有启用中的试卷：学时够（8 / 8）但没及格 → E_TR_EXAM_REQUIRED，'
      + '报名记录不落成 completed（一条"去了但没考过"的记录将来会被当成结业证据）；'
      + '考过之后再记一次到场 → completed',
      /E_TR_EXAM_REQUIRED/.test(msg) && mid !== 'completed'
      && Number(r3.score) === 100 && r3.passed === true && after === 'completed',
      `没考=${String(msg).split('\n')[0].slice(0, 30) || '没拦住'} 状态=${mid} `
      + `补考=${r3.score} 考后=${after}`);
  }

  { // EXAM5 交了卷面上不存在的选项 → 当场说清；整份被拒，不留半份答案
    //   ★ 静默算 0 会让"我明明答了却 0 分"变成无解的谜：考生以为系统坏了，
    //     运维去翻卷子，而真正的问题在前端多勾了一个选项。
    //   ★ "半份不落库"靠的是**单条语句的原子性**，不是代码顺序：选项存在性校验在
    //     逐题判分的循环里，跑到第 2 题时第 1 题那条 exam_answer 已经 INSERT 了。
    //     哪天有人为了"逐题反馈"把它拆成多次调用，这个性质会**静默消失** ——
    //     表现是考生重交时撞 uk_exa_once，而不是一条报错。这条断言就是那道闸。
    const a4 = await start(9930);
    let msg = '';
    try { await submit(a4, [{ q: q1, picked: 'B' }, { q: q2, picked: 'C' }]); }
    catch (e) { msg = e.message; }
    const left = (await db.query(
      `SELECT (SELECT count(*)::int FROM exam_answer WHERE attempt_id=$1) n,
              (SELECT submitted_at FROM exam_attempt WHERE id=$1) sub`, [a4])).rows[0];
    rec('EXAM5', '2 选项的判断题交了 C → E_EXAM_BAD_ANSWER 且点名第几题（不静默算 0）；'
      + '整份被拒：一条答题记录都没落库（靠的是单条语句的原子性，拆成多次调用就会静默消失），'
      + '这份卷仍是未交状态 —— 被拒之后能重交同一份，不用再发一张卷'
      + '（"他到底考了几次"是要报出去的数，发新卷会把它弄脏）',
      /E_EXAM_BAD_ANSWER/.test(msg) && Number(left.n) === 0 && left.sub === null,
      `${String(msg).split('\n')[0].slice(0, 34)} 落库=${left.n} 行 已交=${left.sub !== null}`);
  }
}

// ★ 同 RV/RT：这一组在 T 组的快照之后才跑，结论自己记一笔
//   （不记的话 SUITE.EXAM 永远停在 never_run，覆盖率页上看不出它跑过）。
{
  const rs = results.filter((r) => /^EXAM/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.EXAM', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ===========================================================================
// EXAML 组 · 考试的限时与限次（156）：没这两件事，"及格"两个字就没意义
// ---------------------------------------------------------------------------
// 147 的考试能判分、能封卷，但：
//   · 次数没上限 —— 不及格就一直考，直到蒙过。这张成绩是要给监管看的
//     （食品安全培训、特种作业复审），能刷分的及格线等于没有及格线。
//   · 没限时 —— 一道题想多久想多久，考的是"有没有空"，不是"会不会"。
// 156 补这两个闸，但有一处**刻意与酷学院不同**，这一组就是钉住它：
//   ★ 超时**不作废，只记录**。作废的后果是"网断了、人去了趟洗手间"全要人工申诉，
//     而超时的本质是"时限到了"，不是"这个人作弊"。判分照常、机会照算，
//     late_seconds 记下来由人决定。
//   ★ 次数**只数已交卷的**。开了没交（断线、走开）不该吃掉一次机会。
// ===========================================================================
{
  const ENT2 = 994;
  await db.query(`INSERT INTO person(id,full_name) VALUES (9932,'限次甲'),(9933,'限次乙')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (19932,9932,$1,'2026-01-01'),(19933,9933,$1,'2026-01-01')
                  ON CONFLICT (id) DO NOTHING`, [ENT2]);

  // 独立课程：不挂到 EXAM 那门课上，否则 EXAM4 的"学时够了但没考过"会多一张启用卷
  const c2 = Number((await db.query(
    `INSERT INTO training_course(code,name,category,std_hours)
     VALUES ('EXC994B','限次限时演示课','safety',4)
     ON CONFLICT (code) DO UPDATE SET std_hours=EXCLUDED.std_hours RETURNING id`)).rows[0].id);

  // 限时 30 分钟 + 只能考 1 次：一条规则都不宽松，正是"补考要人批"的那种卷
  const p2 = Number((await db.query(
    `INSERT INTO exam_paper(course_id,code,name,pass_score,duration_min,max_attempts)
     VALUES ($1,'EXPL994A','限次限时卷',60,30,1)
     ON CONFLICT (code) DO UPDATE SET duration_min=EXCLUDED.duration_min,
       max_attempts=EXCLUDED.max_attempts RETURNING id`, [c2])).rows[0].id);
  // 对照组：不限时（duration_min 为空）的卷，deadline 必须留空而不是"随便给个数"
  const p3 = Number((await db.query(
    `INSERT INTO exam_paper(course_id,code,name,pass_score)
     VALUES ($1,'EXPL994B','不限时卷',60)
     ON CONFLICT (code) DO UPDATE SET pass_score=EXCLUDED.pass_score RETURNING id`, [c2])).rows[0].id);

  await db.query(
    `INSERT INTO exam_question(paper_id,seq,kind,stem,options,answer,score) VALUES
       ($1,1,'judge','明火作业前要清空周边可燃物。','[]','A',100),
       ($2,1,'judge','明火作业前要清空周边可燃物。','[]','A',100)
     ON CONFLICT (paper_id,seq) DO NOTHING`, [p2, p3]);

  const q2 = Number((await db.query(
    `SELECT id FROM exam_question WHERE paper_id=$1 AND seq=1`, [p2])).rows[0].id);
  const start2 = async (pp, emp) => Number((await db.query(
    `SELECT fn_exam_start($1,$2) i`, [pp, emp])).rows[0].i);

  let attA;
  { // EXAML1 截止时刻由库端算：前端倒计时只是显示，改本地时间不该多考半小时
    attA = await start2(p2, 9932);
    const d = (await db.query(
      `SELECT deadline_at,
              EXTRACT(epoch FROM (deadline_at - started_at))::int span
         FROM exam_attempt WHERE id=$1`, [attA])).rows[0];
    const attB = await start2(p3, 9933);
    const d2 = (await db.query(
      `SELECT deadline_at FROM exam_attempt WHERE id=$1`, [attB])).rows[0].deadline_at;

    rec('EXAML1', '限时卷开考即算出截止时刻，且距开始正好 30 分钟（差 1 分 1 秒都算错：'
      + '这个数是倒计时的唯一依据，算偏了每一场考试的时限都跟着偏）；'
      + '不限时的卷 deadline 留空，不拿"9999-12-31"之类的假值占位'
      + '（假值迟早被当成真值算进去）',
      d.deadline_at !== null && Number(d.span) === 1800 && d2 === null,
      `限时卷=${d.deadline_at ? '有' : '无'} 跨度=${d.span}s 不限时卷=${d2 === null ? '空' : '有'}`);
  }

  { // EXAML2 次数只数已交卷的：开了没交不该吃掉机会；交过卷就锁死
    const again = await start2(p2, 9932);      // 还没交，再开一次
    const same = again === attA;               // 幂等：不多发一张卷
    await db.query(
      `SELECT * FROM fn_exam_submit($1,$2::jsonb)`,
      [attA, JSON.stringify([{ q: q2, picked: 'A' }])]);

    let msg = '';
    try { await start2(p2, 9932); } catch (e) { msg = e.message; }

    // 阳性对照：另一个人（一次都没考）在同一张 max_attempts=1 的卷上仍能开考 ——
    // 否则"被拦"可能只是"这张卷谁都开不了"，断言就假通过了
    let okOther = true;
    try { await start2(p2, 9933); } catch (e) { okOther = false; }

    rec('EXAML2', 'max_attempts=1：开过两次没交仍是同一份卷（不攒未交卷），'
      + '交卷后再开 → E_EXAM_NO_ATTEMPT_LEFT；另一个人照样能开考'
      + '（证明拦住的是"这一个人用完了次数"，不是"这张卷坏了"）',
      same && /E_EXAM_NO_ATTEMPT_LEFT/.test(msg) && okOther,
      `同卷=${same} 用完后=${String(msg).split('\n')[0].slice(0, 26) || '没拦住'} `
      + `别人可开=${okOther}`);
  }

  { // EXAML3 超时：记下来，但不拦；分数照算、机会照算
    //   把截止时刻往前拨 5 分钟 → 等于考了 35 分钟才交（卷子限时 30 分钟）。
    //   不拨 started_at：本断言要验的是"交卷那一刻的判定"，不是"补录历史"。
    const att = await start2(p3, 9932);
    const q3 = Number((await db.query(
      `SELECT id FROM exam_question WHERE paper_id=$1 AND seq=1`, [p3])).rows[0].id);
    await db.query(
      `UPDATE exam_attempt SET deadline_at = now() - interval '5 minutes' WHERE id=$1`, [att]);
    const r = (await db.query(
      `SELECT * FROM fn_exam_submit($1,$2::jsonb)`,
      [att, JSON.stringify([{ q: q3, picked: 'A' }])])).rows[0];
    const st = (await db.query(
      `SELECT late_seconds, submitted_at, score, passed FROM exam_attempt WHERE id=$1`,
      [att])).rows[0];

    rec('EXAML3', '超时交卷仍然判分、仍然判及格、仍然算一次机会，只把 late_seconds 记下来'
      + '（≈300 秒）；**不作废** —— 作废的后果是"网断了""去了趟洗手间"全要人工申诉，'
      + '而超时的本质是时限到了，不是作弊。算不算这次，留给能负责的人',
      Number(r.score) === 100 && r.passed === true
      && Number(st.late_seconds) >= 240 && Number(st.late_seconds) <= 420,
      `分数=${r.score}/${r.passed} 迟到=${st.late_seconds}s`);
  }

  { // EXAML4 台账：页面要能直接回答"他还剩几次、上次考了多少、有没有超时"
    //   ★ 让人考到一半才发现没机会了，比一开始就不让他考更糟。
    const L = (await db.query(
      `SELECT * FROM fn_exam_ledger($1,9932)`, [p2])).rows[0];
    const L2 = (await db.query(
      `SELECT * FROM fn_exam_ledger($1,9933)`, [p2])).rows[0];
    rec('EXAML4', 'fn_exam_ledger：考满的人 used=1 / left=0 / 最高分与是否通过都给出；'
      + '一次没考的人 left=1；没考过的人 best_score 是空而不是 0'
      + '（0 分是"考了没得分"，空是"没考"，这两件事在页面上不能长一样）',
      Number(L.used) === 1 && Number(L.left_attempts) === 0
      && Number(L.best_score) === 100 && L.passed === true
      && Number(L2.used) === 0 && Number(L2.left_attempts) === 1 && L2.best_score === null,
      `考满=${L.used}/${L.left_attempts}/${L.best_score} `
      + `没考=${L2.used}/${L2.left_attempts}/${L2.best_score}`);
  }
}

{
  const rs = results.filter((r) => /^EXAML/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.EXAML', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ===========================================================================
// EXAMT 组 · 考试任务层（157）：按组织/时间窗分批、错题回顾、成绩分布、切屏证据
// ---------------------------------------------------------------------------
// 147/156 之后，考试在"一次考试"这个粒度上是对的。放到连锁客户那里差四件：
//   ① 一张卷只能整体开考 —— 缺"批次"这一层（题库→试题→试卷→**考试任务**）；
//   ② 交卷后看不见自己错哪了（147 为了防作弊连交卷后也不给答案）；
//   ③ 店长只看到"及格率 60%"，看不出是题太难还是有人不会；
//   ④ "切屏 3 次"是个聚合值，解释不了"哪 3 次、几几点"。
// ★ 本组的核心不是"这四个功能有没有"，而是两条边界：
//   · **没有任务的卷要放行**（任务层是可选批次层，加了它不等于旧卷全部停摆）；
//   · **时间窗闸在 exam_attempt 的 BEFORE INSERT 里**，所以不调 fn_exam_task_check
//     也发不出窗口外的卷 —— 闸要靠人记得调，就等于没有闸。
// ===========================================================================
{
  const ENT3 = 994;
  await db.query(`INSERT INTO person(id,full_name) VALUES (9934,'批次甲'),(9935,'批次乙')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (19934,9934,$1,'2026-01-01'),(19935,9935,$1,'2026-01-01')
                  ON CONFLICT (id) DO NOTHING`, [ENT3]);
  // 门店归属：甲在 A 店（10）、乙在 B 店（11）—— 用来验"各自只看到自己那批"
  await db.query(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
                  VALUES (9934,'cost_org',10,'2026-01-01'),(9935,'cost_org',11,'2026-01-01')
                  ON CONFLICT DO NOTHING`);

  const c3 = Number((await db.query(
    `INSERT INTO training_course(code,name,category,std_hours)
     VALUES ('EXC994C','批次考试演示课','safety',4)
     ON CONFLICT (code) DO UPDATE SET std_hours=EXCLUDED.std_hours RETURNING id`)).rows[0].id);
  const mk = async (code, name) => Number((await db.query(
    `INSERT INTO exam_paper(course_id,code,name,pass_score)
     VALUES ($1,$2,$3,60) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name
     RETURNING id`, [c3, code, name])).rows[0].id);
  const pFree = await mk('EXPL994C', '没有任务的卷');
  const pWin = await mk('EXPL994D', '有窗口的卷');
  for (const pp of [pFree, pWin]) {
    await db.query(
      `INSERT INTO exam_question(paper_id,seq,kind,stem,options,answer,score)
       VALUES ($1,1,'judge','动火前要清场。','[]','A',100)
       ON CONFLICT (paper_id,seq) DO NOTHING`, [pp]);
  }
  const qOf = async (pp) => Number((await db.query(
    `SELECT id FROM exam_question WHERE paper_id=$1 AND seq=1`, [pp])).rows[0].id);
  const TODAY = (await db.query(`SELECT app_today() d`)).rows[0].d;
  const startP = async (pp, emp) => Number((await db.query(
    `SELECT fn_exam_start($1,$2) i`, [pp, emp])).rows[0].i);

  { // EXAMT1 没有任务的卷放行；有任务但不在窗口内 → 开考被拒（触发器拦，不靠调用方）
    const free = await startP(pFree, 9934);     // 阳性对照：老行为必须还在

    // 先把窗口放在**昨天**：今天开考必须被拒
    await db.query(`SELECT fn_exam_task_open($1,'昨天那一批',$2,
        ((app_today() - 1) + time '08:00')::timestamp AT TIME ZONE app_tz(),
        ((app_today() - 1) + time '09:30')::timestamp AT TIME ZONE app_tz(), true, 'hr')`, [pWin, null]);
    let msg = '';
    try { await startP(pWin, 9934); } catch (e) { msg = e.message; }
    const n = Number((await db.query(
      `SELECT count(*)::int n FROM exam_attempt WHERE paper_id=$1`, [pWin])).rows[0].n);

    // 再开一个**今天**的窗口：立刻就能开考（同一张卷两批，互不干扰）
    await db.query(`SELECT fn_exam_task_open($1,'今天这一批',$2,
        (app_today() + time '00:00')::timestamp AT TIME ZONE app_tz(),
        (app_today() + time '23:59')::timestamp AT TIME ZONE app_tz(), true, 'hr')`, [pWin, null]);
    const open = await startP(pWin, 9934);

    rec('EXAMT1', '没有任务的老卷照样能开考（任务层是**可选**的批次层 —— 改成"没任务就拒"，'
      + '147 那套和升级当天的存量数据会全部停摆）；有任务但不在任何窗口内 → '
      + 'E_EXAM_TASK_CLOSED 且一份答卷都没落下（这道闸在 exam_attempt 的 BEFORE INSERT 里，'
      + '不靠调用方记得先 check）；补一个今天的窗口后立刻能开考 —— 同一张卷多批互不干扰',
      free > 0 && /E_EXAM_TASK_CLOSED/.test(msg) && n === 0 && open > 0,
      `空卷开考=${free > 0} 窗口外=${String(msg).split('\n')[0].slice(0, 30) || '没拦住'} `
      + `落库=${n} 行 补窗口后=${open > 0}`);
  }

  { // EXAMT2 分批：各自只看到自己那批；done 只认**这个窗口内**交过卷
    await db.query(`SELECT fn_exam_task_open($1,'A店本周',$2,
        (app_today() + time '00:00')::timestamp AT TIME ZONE app_tz(),
        (app_today() + time '23:59')::timestamp AT TIME ZONE app_tz(), true, 'hr')`, [pWin, 10]);
    // 甲先把"今天这一批"那份交了 —— done 的口径要能区分"这个窗口交过"与"这张卷考过"
    const qA = await qOf(pWin);
    const openA = Number((await db.query(
      `SELECT id FROM exam_attempt WHERE paper_id=$1 AND employee_id=9934
        AND submitted_at IS NULL ORDER BY id DESC LIMIT 1`, [pWin])).rows[0].id);
    await db.query(`SELECT * FROM fn_exam_submit($1,$2::jsonb)`,
      [openA, JSON.stringify([{ q: qA, picked: 'A' }])]);

    const forA = (await db.query(
      `SELECT * FROM fn_exam_task_for(9934, $1::date)`, [TODAY])).rows;
    const forB = (await db.query(
      `SELECT * FROM fn_exam_task_for(9935, $1::date)`, [TODAY])).rows;

    // ★ 明天再开一批：甲今天已经交过这张卷，但明天那批仍然"未完成"。
    //   不这么验，就只能靠"两个窗口不重叠"这种巧合 —— 而窗口是可以重叠的
    //   （同一天上午一场、下午一场），重叠时一条交卷同时满足两批才是对的。
    const TOMORROW = (await db.query(`SELECT app_today() + 1 d`)).rows[0].d;
    await db.query(`SELECT fn_exam_task_open($1,'明天那一批',$2,
        ((app_today() + 1) + time '00:00')::timestamp AT TIME ZONE app_tz(),
        ((app_today() + 1) + time '23:59')::timestamp AT TIME ZONE app_tz(), true, 'hr')`, [pWin, null]);
    const forTomorrow = (await db.query(
      `SELECT * FROM fn_exam_task_for(9934, $1::date)`, [TOMORROW])).rows;

    rec('EXAMT2', '同一张卷按门店分批：甲（A 店）看到"全公司 + A店"两批，乙（B 店）只看到全公司那批'
      + '—— 归属按当天 cost_org 匹配，A 店那批不能出现在 B 店人的待考清单里；'
      + 'done 的口径是**这个窗口内**交过卷：甲交了今天这批 → 今天两批都 done'
      + '（窗口重叠时一条交卷满足两批是对的），乙没交 → 未完成；'
      + '而甲今天交过的那张卷，对"明天那一批"仍然是未完成'
      + '（把"这张卷他考过"当 done，B 店一开批，上个月在 A 店考过的人会立刻显示"已完成"）',
      forA.length === 2 && forB.length === 1
      // 甲今天两批都算完成：两个窗口都覆盖今天，一条交卷同时满足两批是**对的** ——
      // 真要区分只能靠窗口不重叠，而不是靠"只认第一个任务"。
      && forA.every((r) => r.done === true)
      && forB.every((r) => r.done === false)
      && forTomorrow.length === 1 && forTomorrow[0].done === false,
      `甲看到=${forA.length} 批（done=${forA.map((r) => r.done).join('/')}） `
      + `乙看到=${forB.length} 批（done=${forB.map((r) => r.done).join('/')}） `
      + `明天批=${forTomorrow.length} 批 done=${forTomorrow[0] && forTomorrow[0].done}`);
  }

  { // EXAMT3 错题回顾：交卷前不给（那等于送卷），交卷后逐题给答案与对错
    const pid = pWin;
    const qid = await qOf(pid);
    // 另开一份没交的卷：review 必须拒
    const openAtt = await startP(pid, 9935);
    let msg = '';
    try { await db.query(`SELECT * FROM fn_exam_review($1)`, [openAtt]); }
    catch (e) { msg = e.message; }

    // 已交卷那份（甲在 EXAMT2 里交的）
    const subAtt = Number((await db.query(
      `SELECT id FROM exam_attempt WHERE paper_id=$1 AND employee_id=9934
        AND submitted_at IS NOT NULL ORDER BY id DESC LIMIT 1`, [pid])).rows[0].id);
    const rev = (await db.query(`SELECT * FROM fn_exam_review($1)`, [subAtt])).rows;

    rec('EXAMT3', '未交卷调 fn_exam_review → E_EXAM_NOT_SUBMITTED（交卷前给答案等于把卷子送出去）；'
      + '交卷后逐题给我选的 / 正确答案 / 对错 / 得分 —— "交卷前不给是防作弊，'
      + '交卷后给是让他知道错哪了"，这两件事必须分开',
      /E_EXAM_NOT_SUBMITTED/.test(msg) && rev.length === 1
      && rev[0].answer === 'A' && rev[0].is_right === true && Number(rev[0].got) === 100,
      `未交=${String(msg).split('\n')[0].slice(0, 26) || '没拦住'} 题数=${rev.length} `
      + `对错=${rev[0] && rev[0].is_right}`);
  }

  { // EXAMT4 六段固定出行 + 缺考名单：及格率的分母是已交卷人数
    const stat = (await db.query(`SELECT * FROM fn_exam_stat($1)`, [pWin])).rows;
    const all = stat.find((r) => r.bucket === 'all');
    const bands = stat.filter((r) => r.bucket !== 'all');
    const miss = (await db.query(`SELECT * FROM fn_exam_missing($1)`, [pWin])).rows;
    rec('EXAMT4', 'fn_exam_stat 固定出 6 行（all + 90-100/80-89/70-79/60-69/<60），'
      + '0 人的段也出行 —— 少一行等于让页面去猜"这段没人"还是"这段没查"；'
      + '一人一行取最高分；pass_rate 的分母是**已交卷人数**（不是应考人数，'
      + '否则及格率就变成考勤率）；fn_exam_missing 把"有任务但没交卷"的人列出来',
      stat.length === 6 && Number(all.person_count) === 1
      && Number(all.pass_count) === 1 && Number(all.pass_rate) === 1
      && bands.length === 5
      && Number(bands.find((r) => r.bucket === '90-100').person_count) === 1
      // 甲在上面的"全公司"批里交过、A 店那批没交 → 仍然上榜，但 attempts=1；
      // 乙一次没交 → attempts=0。"考过别的批次"与"从来没考"必须能分开看。
      && miss.some((m) => Number(m.person_id) === 9934 && Number(m.attempts) === 1)
      && miss.some((m) => Number(m.person_id) === 9935 && Number(m.attempts) === 0),
      `6行=${stat.length === 6} 已考=${all.person_count} 过=${all.pass_count} `
      + `率=${all.pass_rate} 缺考=${miss.length} 人 `
      + `甲(考过别批)=${(miss.find((m) => Number(m.person_id) === 9934) || {}).attempts} `
      + `乙(从没考)=${(miss.find((m) => Number(m.person_id) === 9935) || {}).attempts}`);
  }

  { // EXAMT5 切屏证据：一次一条、带时间点、只增不改；交卷后不许补记
    const subAtt = Number((await db.query(
      `SELECT id FROM exam_attempt WHERE paper_id=$1 AND employee_id=9934
        ORDER BY id DESC LIMIT 1`, [pWin])).rows[0].id);
    // 已交卷 → 补记必须被拒（事后补一条"他没切屏"或"他切了 9 次"都是伪造证据）
    let late = '';
    try {
      await db.query(`INSERT INTO exam_cheat_log(attempt_id,kind,detail)
                      VALUES ($1,'blur','交卷后补记')`, [subAtt]);
    } catch (e) { late = e.message; }

    // 换一份没交的卷：记 2 条，能按时间点查出来
    const att2 = Number((await db.query(
      `SELECT id FROM exam_attempt WHERE paper_id=$1 AND employee_id=9935
        AND submitted_at IS NULL ORDER BY id DESC LIMIT 1`, [pWin])).rows[0].id);
    await db.query(`INSERT INTO exam_cheat_log(attempt_id,kind,detail) VALUES
      ($1,'blur','切走 12 秒'),($1,'paste','粘贴题干')`, [att2]);
    const ev = (await db.query(`SELECT * FROM fn_exam_cheat($1)`, [att2])).rows;
    // 只增不改：改一条、删一条都拒
    let upd = '', del = '';
    try { await db.query(`UPDATE exam_cheat_log SET detail='改了' WHERE attempt_id=$1`, [att2]); }
    catch (e) { upd = e.message; }
    try { await db.query(`DELETE FROM exam_cheat_log WHERE attempt_id=$1`, [att2]); }
    catch (e) { del = e.message; }
    const still = Number((await db.query(
      `SELECT count(*)::int n FROM exam_cheat_log WHERE attempt_id=$1`, [att2])).rows[0].n);
    const flagged = (await db.query(`SELECT * FROM fn_exam_flagged($1)`, [pWin])).rows;

    rec('EXAMT5', '切屏一次一条、带时间点（"切屏 3 次"解释不了"哪 3 次、几点、在答第几题"，'
      + '而争论发生时能回答的只有时间点）；已交卷的答卷不许补记（事后补一条'
      + '"他没切屏"或"他切了 9 次"都是伪造证据）；改与删都被 E_EXAM_CHEAT_APPEND_ONLY 拒，'
      + '两条事件仍在；fn_exam_flagged 能把"有事件的答卷"挑出来给监考看',
      /E_EXAM_CHEAT_APPEND_ONLY|E_EXAM_SUBMITTED/.test(late)
      && ev.length === 2 && ev.every((r) => r.event_at !== null)
      && /E_EXAM_CHEAT_APPEND_ONLY/.test(upd) && /E_EXAM_CHEAT_APPEND_ONLY/.test(del)
      && still === 2 && flagged.length === 1 && Number(flagged[0].events) === 2,
      `补记=${String(late).split('\n')[0].slice(0, 22) || '没拦住'} 事件=${ev.length} `
      + `改=${/APPEND/.test(upd)} 删=${/APPEND/.test(del)} 仍在=${still} 上榜=${flagged.length}`);
  }
}

{
  const rs = results.filter((r) => /^EXAMT/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.EXAMT', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ===========================================================================
// PERFS 组 · 绩效结果上的痕迹（158）：谁打的分 / 改分台账 / 每档都出行
// ---------------------------------------------------------------------------
// 026 有 perf_result、051 有打分入口，但 `fn_perf_score` 收了 p_by 一次都没用 ——
// 于是页面上答不出"这个分是谁给的"，改分之后也答不出"上一版是谁给的"
// （上一版根本不存在，`ON CONFLICT DO UPDATE SET score = EXCLUDED.score`）。
// 绩效分是拿去定系数、定钱的东西，**它必须有一个签字的人**。
//
// 三条取舍，本组钉的是这三条的**反面**：
//   · 不是"一律非空"：存量行留 NULL，报表上显示"未记录评分人"，不编名字；
//   · 不是"不许改分"：封存前的改分是正常流程（复核、校准会），拦了只会让人绕开系统；
//   · 要拦的是"改了没人知道"，所以台账由**触发器**写 —— 绕过服务层也躲不开。
// ===========================================================================
{
  await db.query(`INSERT INTO person(id,full_name) VALUES (9940,'绩效甲')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                  VALUES (19940,9940,994,'2030-01-01') ON CONFLICT (id) DO NOTHING`);
  // 2030 年的方案与周期：与 AQ 组用的 2026 那几期完全隔开，
  // 免得"封存/缺口"这些状态互相影响（AQ6 会把 cycle 2 封掉）。
  await db.query(`INSERT INTO perf_scheme(id,version,name,effective_from)
                  VALUES (90,90,'2030 版绩效方案（加权）','2030-01-01')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO perf_grade(scheme_id,grade,min_score,max_score,factor,target_pct)
                  VALUES (90,'A',90,100,2.0000,20),(90,'B',80,89.99,1.5000,30),
                         (90,'C',70,79.99,1.0000,40),(90,'D',0,69.99,0.5000,10)
                  ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status)
                  VALUES (90,'M-2030-01','2030 一月','2030-01-01','2030-01-31','2030-01','open')
                  ON CONFLICT (id) DO NOTHING`);
}

{ // PERFS1 首评必须签字：scored_by / scored_at 一起写，version 从 1 起
  await db.query(`SELECT * FROM fn_perf_score(90,9940,96,'一月目标达成','hr')`);
  const r = (await db.query(
    `SELECT * FROM fn_perf_result_of(90)`)).rows.find((x) => Number(x.employee_id) === 9940);
  rec('PERFS1', '首评落两列签字（scored_by=hr、scored_at 有值）与 version=1；'
    + 'changed_count=0 —— 而 051 那版 p_by 传了被丢弃，页面上答不出"这个分是谁给的"，'
    + '绩效分是要拿去定系数定钱的东西，它必须有一个签字的人',
    r && r.scored_by === 'hr' && r.scored_at !== null
    && Number(r.version) === 1 && Number(r.changed_count) === 0 && Number(r.score) === 96,
    `签字=${r && r.scored_by} 版本=${r && r.version} 改过=${r && r.changed_count}`);
}

{ // PERFS2 改分留痕：版本+1、台账一行、上一版的人和分都还在
  await db.query(`SELECT * FROM fn_perf_score(90,9940,92,'复核后校准','hr_head')`);
  const r = (await db.query(
    `SELECT * FROM fn_perf_result_of(90)`)).rows.find((x) => Number(x.employee_id) === 9940);
  const h = (await db.query(`SELECT * FROM fn_perf_history(90,9940)`)).rows;
  rec('PERFS2', '改分（96 → 92）后 version=2、changed_count=1，台账里留着一行'
    + '"96 → 92 / 谁改的 / 什么时候" —— 051 是 ON CONFLICT DO UPDATE 静默覆盖，'
    + '78 改成 88 旧值就没了，而"这个分被改过"本身就是一个要能回答的事实'
    + '（复盘时看的是原始判断，还是被协调过的结果）',
    r && Number(r.version) === 2 && Number(r.changed_count) === 1
    && Number(r.score) === 92 && h.length === 1
    && Number(h[0].old_score) === 96 && Number(h[0].new_score) === 92,
    `版本=${r && r.version} 改过=${r && r.changed_count} 台账=${h.length} 行 `
    + `${h[0] && `${h[0].old_score}→${h[0].new_score}`}`);
}

{ // PERFS3 绕过入口直接改分 → 拒；台账只增不改
  let upd = '', del = '', logUpd = '';
  try { await db.query(`UPDATE perf_result SET score=99 WHERE cycle_id=90 AND employee_id=9940`); }
  catch (e) { upd = e.message; }
  try { await db.query(`UPDATE perf_result_log SET new_score=99 WHERE cycle_id=90`); }
  catch (e) { logUpd = e.message; }
  try { await db.query(`DELETE FROM perf_result_log WHERE cycle_id=90`); }
  catch (e) { del = e.message; }
  const still = (await db.query(
    `SELECT score FROM perf_result WHERE cycle_id=90 AND employee_id=9940`)).rows[0].score;
  const nLog = Number((await db.query(
    `SELECT count(*)::int n FROM perf_result_log WHERE cycle_id=90`)).rows[0].n);

  rec('PERFS3', '直接 UPDATE 改分（没走 fn_perf_score）→ E_PERF_NO_SCORER 且分数仍是 92：'
    + '让直接改分"继承上一版签字"，台账上就变成"上一个人改的"——'
    + '那是数据库自己伪造的签名，比没有签名坏得多；台账的改与删都被 '
    + 'E_PERF_LOG_APPEND_ONLY 拒，原行仍在（绩效分是最想被绕过服务层去改的那一类数）',
    /E_PERF_NO_SCORER/.test(upd) && /E_PERF_LOG_APPEND_ONLY/.test(logUpd)
    && /E_PERF_LOG_APPEND_ONLY/.test(del) && Number(still) === 92 && nLog === 1,
    `改分=${/NO_SCORER/.test(upd)} 改台账=${/APPEND/.test(logUpd)} `
    + `删台账=${/APPEND/.test(del)} 分数=${still} 台账=${nLog} 行`);
}

{ // PERFS4 强制分布：每档都出行，"这一档没人"与"方案没这一档"不同形
  const rows = (await db.query(`SELECT * FROM fn_perf_distribution(90)`)).rows;
  const a = rows.find((r) => r.grade === 'A');
  const d = rows.find((r) => r.grade === 'D');
  rec('PERFS4', 'fn_perf_distribution 把方案里的每一档都列出来（4 档 4 行），A 档 n=1、'
    + 'D 档 n=0 且 pct=0 —— 只出有人的档，报表上"这一档一个人都没有"与'
    + '"方案里没有这一档"就长得一样了：前者要有人去谈（执行没到位），后者不用管',
    rows.length === 4 && Number(a.n) === 1 && Number(d.n) === 0
    && Number(d.pct) === 0 && Number(a.target_pct) === 20,
    `行数=${rows.length} A=${a && `${a.n}人/${a.pct}%`} D=${d && `${d.n}人/${d.pct}%`}`);
}

{
  const rs = results.filter((r) => /^PERFS/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.PERFS', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ===========================================================================
// AX 组 · 绩效指标库与加权总分（159）：把"一个 0–100 的总分"拆成真实口径
// ---------------------------------------------------------------------------
// 到现在为止，绩效只能打一个总分。门店的真实形态是
// 营业额 40% + 客诉 20% + 卫生 20% + 出勤 20% —— 而"92 分"这个数解释不了
// 哪一项拖了后腿，也让店长没法就具体那一项去谈。
//
// 三条折分口径（本组钉的就是这三条，**别处不许再算一遍**）：
//   · direction=up  → LEAST(actual/target, 1.5) × 100（超额封顶 150）
//   · direction=down→ target/actual × 100 且**不给超额加分**（零客诉已经是满分，
//                     再给 150 会让它把一个季度的营业额缺口抹平）
//   · 目标值 NULL   → 录入值直接当分（行为价值观 / 加减分项）
// 以及两条"存的时候就校验"：权重合计必须 = 1、同一指标不能在一个方案里出现两次
// （重复会让 0.2 变成两行各 0.2，汇总时实际权重悄悄翻倍）。
// ===========================================================================
{
  await db.query(
    `INSERT INTO perf_metric(code,name,kind,unit,direction,score_min,score_max) VALUES
       ('AX-REV','营业额','quant','元','up',0,150),
       ('AX-CMP','客诉次数','quant','次','down',0,150),
       ('AX-HYG','卫生检查','behavior',NULL,'up',0,100),
       ('AX-ATT','出勤','behavior',NULL,'up',0,100)
     ON CONFLICT (code) DO NOTHING`);
}

{ // AX1 权重和与重复指标：存的时候就拒，不等汇总时才发现
  let sum = '', dup = '';
  try {
    await db.query(`SELECT fn_perf_item_set(90, $1::jsonb, 'hr')`, [JSON.stringify([
      { metric_code: 'AX-REV', weight: 0.4, target_value: 1000000 },
      { metric_code: 'AX-CMP', weight: 0.2, target_value: 2 },
      { metric_code: 'AX-HYG', weight: 0.2 }])]);
  } catch (e) { sum = e.message; }
  try {
    await db.query(`SELECT fn_perf_item_set(90, $1::jsonb, 'hr')`, [JSON.stringify([
      { metric_code: 'AX-REV', weight: 0.5, target_value: 1000000 },
      { metric_code: 'AX-REV', weight: 0.5, target_value: 1000000 }])]);
  } catch (e) { dup = e.message; }
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM perf_item WHERE scheme_id=90`)).rows[0].n);
  rec('AX1', '权重合计 0.8 → E_PERF_WEIGHT_SUM（差 0.2 写进报错），同一指标出现两次 → '
    + 'E_PERF_DUP_METRIC；两次都一行没写进去（先校验后写，不留半套考核项）—— '
    + '存的时候不校验，等到汇总才发现加起来 0.95，那时已经有人按"评过了"在沟通了',
    /E_PERF_WEIGHT_SUM/.test(sum) && /E_PERF_DUP_METRIC/.test(dup) && n === 0,
    `权重和=${String(sum).split('\n')[0].slice(0, 26) || '没拦住'} `
    + `重复=${/DUP/.test(dup)} 落库=${n} 项`);
}

// 正式口径：营业额 40% + 客诉 20% + 卫生 20% + 出勤 20%
const AX_ITEMS = [
  { metric_code: 'AX-REV', weight: 0.4, target_value: 1000000 },
  { metric_code: 'AX-CMP', weight: 0.2, target_value: 2 },
  { metric_code: 'AX-HYG', weight: 0.2 },
  { metric_code: 'AX-ATT', weight: 0.2 },
];
await db.query(`SELECT fn_perf_item_set(90, $1::jsonb, 'hr')`, [JSON.stringify(AX_ITEMS)]);
const itemOf = async (code) => Number((await db.query(
  `SELECT i.id FROM perf_item i JOIN perf_metric m ON m.id=i.metric_id
    WHERE i.scheme_id=90 AND m.code=$1`, [code])).rows[0].id);
const axResult = Number((await db.query(
  `SELECT id FROM perf_result WHERE cycle_id=90 AND employee_id=9940`)).rows[0].id);
const scoreItem = async (code, actual, note) => Number((await db.query(
  `SELECT fn_perf_item_score($1,$2,$3,$4) s`,
  [axResult, await itemOf(code), actual, note || null])).rows[0].s);

{ // AX2 三个方向的折分口径
  const rev = await scoreItem('AX-REV', 950000);   // 95% → 95
  const cmp0 = await scoreItem('AX-CMP', 0);       // 零客诉 → 100，不是 150
  const cmp4 = await scoreItem('AX-CMP', 4);       // 目标 2 实际 4 → 50
  const hyg = await scoreItem('AX-HYG', 90);       // 无目标 → 录入值直接当分
  rec('AX2', '营业额 95 万 / 目标 100 万 → 95 分（up 按比例折）；客诉目标 2 次：'
    + '零客诉 → 100（不是 150 —— 零客诉已经满分，再给超额分会让它抹平营业额缺口）、'
    + '4 次 → 50（down 按 target/actual）；卫生没有目标值 → 录入 90 直接当 90 分'
    + '（行为价值观没法按比例折）',
    rev === 95 && cmp0 === 100 && cmp4 === 50 && hyg === 90,
    `营业额=${rev} 客诉0=${cmp0} 客诉4=${cmp4} 卫生=${hyg}`);
}

{ // AX3 超额封顶 150；而**越界**（公式项/加减分项超出 score_max）必须写说明
  //   ★ 两件事别混：up 指标的折分里已经 LEAST(...,1.5)，所以它最多 150 —— 不会越界。
  //     真会越界的是公式项与加减分项（公式算出多少就是多少）。
  const revCap = await scoreItem('AX-REV', 2000000);   // 2 倍目标 → 封顶 150，不是 200
  await scoreItem('AX-REV', 950000);                   // 复原，后面的汇总要用干净数

  await db.query(`UPDATE perf_item SET formula='ACTUAL' WHERE id=$1`, [await itemOf('AX-HYG')]);
  let noNote = '';
  try { await scoreItem('AX-HYG', 120); } catch (e) { noNote = e.message; }
  const withNote = await scoreItem('AX-HYG', 120, '卫生检查含一次专项整改，按满分记');
  await db.query(`UPDATE perf_item SET formula=NULL WHERE id=$1`, [await itemOf('AX-HYG')]);
  await scoreItem('AX-HYG', 90);                       // 回到 90 分

  rec('AX3', '营业额做到 2 倍目标 → 折分封顶 150（不是 200）：up 指标的超额有上限，'
    + '否则一个店的营业额能把整个季度抹平；而**公式项**算出 120 分、越过该指标的'
    + '上限 100 → 没写说明时 E_PERF_SCORE_RANGE，写满 4 字说明后放行（仍记 120）——'
    + '业务上确实有特批，但特批必须留下"为什么"，否则复盘时只有一个突兀的高分',
    revCap === 150 && /E_PERF_SCORE_RANGE/.test(noNote) && withNote === 120,
    `2倍目标=${revCap} 无说明=${String(noNote).split('\n')[0].slice(0, 26) || '没拦住'} `
    + `有说明=${withNote}`);
}

{ // AX4 加权汇总：缺项按 0 计（不重新归一），补齐后回写总分与档位
  await scoreItem('AX-HYG', 90);
  const t3 = Number((await db.query(`SELECT fn_perf_total($1,'hr') s`, [axResult])).rows[0].s);
  const r3 = (await db.query(
    `SELECT score, grade, version FROM perf_result WHERE id=$1`, [axResult])).rows[0];

  await scoreItem('AX-ATT', 95);
  const t4 = Number((await db.query(`SELECT fn_perf_total($1,'hr') s`, [axResult])).rows[0].s);
  const r4 = (await db.query(
    `SELECT score, grade, version FROM perf_result WHERE id=$1`, [axResult])).rows[0];
  const wsum = Number((await db.query(
    `SELECT sum(weight) s FROM perf_item WHERE scheme_id=90`)).rows[0].s);

  rec('AX4', '只打 3 项时加权和 = 0.4×95 + 0.2×50 + 0.2×90 = 66（缺的出勤按 **0** 计，'
    + '不按剩下 3 项重新归一 —— 归一化会让"少打一项"变成"分数被抬高"）；'
    + '补齐出勤 95 后 = 85、档位回到 B（80–89.99），且回写穿过 fn_perf_score：'
    + 'score / grade / version 三列一起变，不是直接 UPDATE',
    Math.abs(wsum - 1) < 0.001 && t3 === 66 && Number(r3.score) === 66
    && t4 === 85 && Number(r4.score) === 85 && r4.grade === 'B'
    && Number(r4.version) > Number(r3.version),
    `权重和=${wsum} 三项=${t3}（库里 ${r3.score}/${r3.grade}） `
    + `四项=${t4}（${r4.score}/${r4.grade}） 版本 ${r3.version}→${r4.version}`);
}

{
  const rs = results.filter((r) => /^AX/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.AX', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ===========================================================================
// CTR 组 · 人事合同（160）：填关键项 → 校验 → 生成标准格式
// ---------------------------------------------------------------------------
// 合同是人事的地基：没有它，"入职"只是一个日期，答不出"到哪天为止"。
// 而它最容易出的错不是排版，是**生成了一份违法或无效的合同**：
//   · 试用期超上限（该条款无效，已履行的按转正后工资补差）；
//   · 合同期不满 3 个月却约了试用期 / 同一人同一主体约第二次；
//   · 无固定期限填了终止日（那样它在法律上就是固定期限）。
// 这些必须在库里判 —— 靠"填表的人记得"，等于没有。
// ===========================================================================
{
  await db.query(`INSERT INTO person(id,full_name) VALUES (9970,'合同甲'),(9971,'合同乙')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (19970,9970,994,'2026-01-01'),(19971,9971,994,'2026-01-01')
                  ON CONFLICT (id) DO NOTHING`);
  // 甲有证件与手机（能渲染）；乙故意什么都不填（验"关键字段缺失"）
  await db.query(`INSERT INTO person_profile(person_id,profile_type,profile_value)
                  VALUES (9970,'national_id','310101199001010011'),
                         (9970,'mobile','13800000001')
                  ON CONFLICT DO NOTHING`);
  // ★ 用 upsert 而不是 UPDATE：160 的回填只覆盖"迁移那一刻已存在"的 entity，
  //   而测试的种子是在迁移之后才插的 —— UPDATE 会静默影响 0 行，
  //   然后渲染时以"甲方名称为空"的形式报错，看起来像渲染函数写错了。
  await db.query(`INSERT INTO legal_entity
                    (id,name,credit_code,address,legal_rep,stamp_name)
                  VALUES (994,'演示餐饮有限公司','91310000MA1FL0000X',
                          '上海市示例路 1 号','示例代表人','演示餐饮有限公司')
                  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,
                    credit_code=EXCLUDED.credit_code, address=EXCLUDED.address,
                    legal_rep=EXCLUDED.legal_rep, stamp_name=EXCLUDED.stamp_name`);

  const tpl = async (kind) => Number((await db.query(
    `SELECT id FROM contract_template WHERE kind=$1 AND is_active ORDER BY id LIMIT 1`,
    [kind])).rows[0].id);
  const mk = async (over) => {
    const d = {
      emp: 9970, kind: 'fixed', start: '2026-01-01', end: '2028-01-01',
      pf: null, pt: null, tpl: await tpl('fixed'), ...over,
    };
    return Number((await db.query(
      `INSERT INTO employment_contract
         (employee_id, legal_entity_id, contract_no, kind, start_date, end_date,
          probation_from, probation_to, job_title, workplace, employee_address,
          hours_system, wage_amount, wage_unit, pay_day, template_id, status)
       VALUES ($1,994,$2,$3,$4::date,$5::date,$6::date,$7::date,'店员','示例路店',
               '上海市示例路 2 号','standard',6000,'month',15,$8,'draft')
       RETURNING id`,
      [d.emp, over.no || `CT${Math.random().toString(36).slice(2, 9)}`,
        d.kind, d.start, d.end, d.pf, d.pt, d.tpl])).rows[0].id);
  };
  const check = async (emp, kind, start, end, pf, pt) => (await db.query(
    `SELECT * FROM fn_contract_check($1,994,$2,$3::date,$4::date,$5::date,$6::date,NULL)`,
    [emp, kind, start, end, pf, pt])).rows;

  { // CTR1 试用期上限按合同期分档（法定四档）
    const q = async (kind, s2, e2) => Number((await db.query(
      `SELECT fn_contract_probation_max($1,$2::date,$3::date) m`, [kind, s2, e2])).rows[0].m);
    const m2 = await q('fixed', '2026-01-01', '2026-03-01');   // 2 个月 → 不得约定
    const m6 = await q('fixed', '2026-01-01', '2026-06-01');   // 5 个月 → 1 个月
    const m18 = await q('fixed', '2026-01-01', '2027-07-01');  // 1 年半 → 2 个月
    const m36 = await q('fixed', '2026-01-01', '2029-01-01');  // 3 年 → 6 个月
    const mOpen = await q('open', '2026-01-01', null);
    const mTask = await q('task', '2026-01-01', '2026-06-01');
    rec('CTR1', '法定试用期上限按合同期分档：不满 3 个月=0（不得约定）、3 个月~1 年=1、'
      + '1~3 年=2、3 年以上及无固定期限=6；以完成一定工作任务为期限=0。'
      + '这个数只在库里算一处 —— 模板里写死"试用期 3 个月"，遇到 1 年期合同就是违法条款',
      m2 === 0 && m6 === 1 && m18 === 2 && m36 === 6 && mOpen === 6 && mTask === 0,
      `2月=${m2} 5月=${m6} 18月=${m18} 36月=${m36} 无固定=${mOpen} 任务型=${mTask}`);
  }

  { // CTR2 超限不许存：2 年期合同约 3 个月试用期 → block；改成 2 个月 → 通过
    const bad = await check(9970, 'fixed', '2026-01-01', '2028-01-01',
      '2026-01-01', '2026-04-01');
    const ok2 = await check(9970, 'fixed', '2026-01-01', '2028-01-01',
      '2026-01-01', '2026-03-01');
    const badBlock = bad.filter((x) => x.level === 'block');
    rec('CTR2', '2 年期合同约 3 个月试用期 → block（E_CT_PROB_TOO_LONG，上限 2 个月），'
      + '改成 2 个月 → 无 block。★ 试用期超限是**违法条款**不是"不规范"：'
      + '后果是该条款无效 + 已履行期间按转正后工资补差，所以必须拦在存之前',
      badBlock.some((x) => x.code === 'E_CT_PROB_TOO_LONG')
      && ok2.filter((x) => x.level === 'block').length === 0,
      `3个月=${badBlock.map((x) => x.code).join(',') || '没拦住'} `
      + `2个月=${ok2.filter((x) => x.level === 'block').length} block`);
  }

  { // CTR3 不该有试用期的类型 + 无固定期限填终止日
    const pt = await check(9970, 'parttime', '2026-01-01', '2026-12-31',
      '2026-01-01', '2026-02-01');
    let openEnd = '';
    try {
      await db.query(
        `INSERT INTO employment_contract
           (employee_id,legal_entity_id,contract_no,kind,start_date,end_date,
            job_title,workplace,employee_address,wage_amount,status)
         VALUES (9970,994,'CT-OPEN-BAD','open','2026-01-01','2027-01-01',
                 '店员','示例路店','上海市示例路 2 号',6000,'draft')`);
    } catch (e) { openEnd = e.message; }
    rec('CTR3', '非全日制约试用期 → block（E_CT_PROB_NOT_ALLOWED）；'
      + '无固定期限填了终止日 → 库里直接拒（ck_ec_open_end，不是应用层 if —— '
      + '导入、后台脚本、将来的新接口都绕不过去）。'
      + '★ "无固定期限 + 终止日"在纸面上看着更"完整"，但它在法律上就是固定期限',
      pt.some((x) => x.code === 'E_CT_PROB_NOT_ALLOWED')
      && /ck_ec_open_end|E_CT_OPEN_HAS_END/.test(openEnd),
      `非全日制=${pt.map((x) => x.code).join(',') || '没拦住'} `
      + `无固定期限带终止日=${/ck_ec_open_end|E_CT_OPEN_HAS_END/.test(openEnd) ? '拒了' : '放过'}`);
  }

  { // CTR4 关键字段缺失 → 不许渲染（不静默留 {{}}）
    const id = await mk({ emp: 9971, no: 'CT-NOID-1' });   // 乙没有证件号
    let miss = '';
    try { await db.query(`SELECT fn_contract_render($1)`, [id]); } catch (e) { miss = e.message; }
    // 补上档案后能渲染，且正文里没有残留占位符
    await db.query(`INSERT INTO person_profile(person_id,profile_type,profile_value)
                    VALUES (9971,'national_id','310101199202020022'),
                           (9971,'mobile','13800000002') ON CONFLICT DO NOTHING`);
    const body = (await db.query(`SELECT fn_contract_render($1) t`, [id])).rows[0].t;
    rec('CTR4', '乙方证件号为空时渲染直接拒（E_CT_FIELD_MISSING，并点名缺哪个字段）；'
      + '补齐档案后渲染出正文，且正文里**没有残留的 {{占位符}}**。'
      + '★ 不静默留空的后果：会印出一张写着 {{乙方证件号}} 的合同去盖章，'
      + '双方都以为"系统会填"',
      /E_CT_FIELD_MISSING/.test(miss) && /乙方证件号/.test(miss)
      && /演示餐饮有限公司/.test(body) && !/\{\{/.test(body)
      && /固定期限/.test(body) && /试用期/.test(body),
      `缺字段=${String(miss).split('\n')[0].slice(0, 34) || '没拦住'} `
      + `渲染 ${body ? body.length : 0} 字 残留占位符=${/\{\{/.test(body)}`);
  }

  { // CTR5 签署存快照：模板后来改了，已签的那一份不变
    const id = await mk({ emp: 9970, no: 'CT-SNAP-1', pf: '2026-01-01', pt: '2026-03-01' });
    const snap = (await db.query(`SELECT fn_contract_render($1) t`, [id])).rows[0].t;
    await db.query(
      `UPDATE employment_contract
          SET status='signed', sign_date='2026-01-01', signed_by='hr', body_snapshot=$2
        WHERE id=$1`, [id, snap]);
    // 改模板正文（模拟"公司 2027 年修订了合同模板"）
    const tid = (await db.query(
      `SELECT template_id FROM employment_contract WHERE id=$1`, [id])).rows[0].template_id;
    await db.query(`UPDATE contract_template SET body = body || E'\n\n[2027 修订] 新增竞业限制条款'
                     WHERE id=$1`, [tid]);
    const after = (await db.query(
      `SELECT body_snapshot FROM employment_contract WHERE id=$1`, [id])).rows[0].body_snapshot;
    rec('CTR5', '签署时把正文存成快照：之后模板加了"竞业限制"条款，'
      + '这份 2026 年签的合同**正文一个字没变**（body_snapshot 不跟模板走）。'
      + '★ 存"模板引用"的做法会让历史合同悄悄变成新条款 —— '
      + '而合同恰恰是"当时双方签的是什么"的证据',
      after === snap && !/2027 修订/.test(after),
      `快照一致=${after === snap} 快照长度=${after ? after.length : 0} `
      + `含新条款=${/2027 修订/.test(after)}`);
  }
}

{
  const rs = results.filter((r) => /^CTR/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.CTR', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ===========================================================================
// RSE 组 · 花名册扩列（161）：合同回写到人身上
// ---------------------------------------------------------------------------
// 061 的花名册只有 9 列。拿去对一份真实门店花名册，缺的是每天要用的东西：
// 合同到哪天、在不在试用期、手机号、紧急联系人。而合同签完不回写，
// 名单上就看不出"这个人还有 20 天到期"。
//
// ★ 关键是**派生而不冗余**：合同起止与试用期状态实时从 employment_contract 读。
//   存一份副本的话，它和合同表不同步的那天，名单上会出现"合同已过期但显示在职"。
// ===========================================================================
{
  await db.query(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
                  VALUES (9970,'cost_org',10,'2026-01-01'),(9971,'cost_org',10,'2026-01-01')
                  ON CONFLICT DO NOTHING`);
  const roster = async (asOf) => {
    await db.query('SELECT app_begin_scope($1,$2,$3)', [1, 'employee_roster', null]);
    return (await db.query('SELECT * FROM fn_emp_roster($1::date)', [asOf])).rows;
  };
  const pick = (rows, id) => rows.find((r) => Number(r.employee_id) === id);
  // ★ date 列回来是 Date 对象：String(d).slice(0,10) 会得到 "Thu Jan 01"
  //   （这个坑今天已经踩了三次：工资单、合同、这里）。
  const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10)
    : (v === null || v === undefined ? null : String(v).slice(0, 10)));

  { // RSE1 合同起止与试用期状态回写到名单
    const rows = await roster('2026-02-01');
    const a = pick(rows, 9970);
    rec('RSE1', '签了合同的人在花名册上带着合同编号/起止/试用期状态：'
      + '2026-02-01 落在试用期（01-01~03-01）→ probation，并且 contract_no 是那一份。'
      + '★ 这些字段是**实时从合同表派生**的，不是冗余存一份 —— '
      + '存副本的那天，名单上会出现"合同已过期但显示在职"的人',
      a && a.contract_no === 'CT-SNAP-1' && a.probation_status === 'probation'
      && ymd(a.contract_end) === '2028-01-01'
      && a.employment_kind === 'fixed',
      `${a && a.contract_no} ${a && ymd(a.contract_start)}~`
      + `${a && ymd(a.contract_end)} ${a && a.probation_status}`);
  }

  { // RSE2 同一个函数、换个日期，试用期状态跟着变
    const may = await roster('2026-05-01');
    const a = pick(may, 9970);
    rec('RSE2', '同一个 fn_emp_roster 换 as_of 日期：2026-05-01 已过试用期 → regular，'
      + '合同编号仍是那一份。★ 状态按 as_of 判而不是"今天" —— '
      + '同一个查询在跨月那天给出另一个答案，报表口径就没法复现',
      a && a.probation_status === 'regular' && a.contract_no === 'CT-SNAP-1',
      `2026-05-01=${a && a.probation_status}`);
  }

  { // RSE3 没有生效合同的人 → none，不冒充全职
    const rows = await roster('2026-02-01');
    const b = pick(rows, 9971);
    rec('RSE3', '只建过草稿、没签的人 → probation_status=none、contract_id 为空、'
      + 'employment_kind 为空（**不拿"在职"冒充"全职"**）。'
      + '这三个空值正好是"该给他签合同了"的名单来源',
      b && b.probation_status === 'none' && b.contract_id === null
      && b.employment_kind === null,
      `状态=${b && b.probation_status} 合同=${b && b.contract_id} `
      + `用工类型=${b && b.employment_kind}`);
  }

  { // RSE4 档案补充只改给了的字段 + 身份证派生生日性别
    await db.query(`SELECT fn_extra_set(9970, '{"education":"本科","residence":"上海市示例路 3 号"}'::jsonb, 'hr')`);
    await db.query(`SELECT fn_extra_set(9970, '{"emergency_name":"张父","emergency_phone":"13900000000","emergency_relation":"父亲"}'::jsonb, 'hr')`);
    const ex = (await db.query(
      `SELECT * FROM employee_extra WHERE employee_id=9970`)).rows[0];
    const rows = await roster('2026-02-01');
    const a = pick(rows, 9970);
    rec('RSE4', '档案补充第二次只给了紧急联系人 → 学历与居住地址**没被清空**'
      + '（整行覆盖会让"只改紧急联系人"顺手把学历清掉，而清空不报错）；'
      + '生日与性别从身份证派生（1990-01-01 / 男），名单上直接可读；'
      + '★ 派生优先、手填兜底 —— 两个来源都存一份，办社保时用哪个都会被退回',
      ex.education === '本科' && ex.emergency_name === '张父'
      && ex.emergency_relation === '父亲'
      && a && ymd(a.birth_date) === '1990-01-01'
      && a.gender === '男' && a.emergency_name === '张父',
      `学历=${ex && ex.education} 紧急=${ex && ex.emergency_name} `
      + `生日=${a && ymd(a.birth_date)} 性别=${a && a.gender}`);
  }
}

{ // RSE5 一个人只能一行 —— 多条身份证档案不许复制人
  //   ★ 这条是补的：截图时发现张三在名单上出现两行，还带两个不同的身份证号。
  //     根因是 fn_emp_roster 里 person_profile 是普通 LEFT JOIN，而 007 明确允许
  //     "未核实号码可被多条记录同时携带"（两个人填错同一个号，比一人两档更常见）。
  //     于是一个人多一张档案，名单上就多一行 —— 而"员工总数"是要报出去的数，
  //     也是各报表的分母，翻倍不会报错。
  //   ★ 归属那边不用测：014 的排他约束 ex_eoa_no_overlap 已经让"同人重叠归属"
  //     插不进去，所以复制人的实际来源只有档案与工号。
  await db.query(`INSERT INTO person_profile(person_id,profile_type,profile_value)
                  VALUES (9970,'national_id','310101199001019999') ON CONFLICT DO NOTHING`);
  await db.query('SELECT app_begin_scope($1,$2,$3)', [1, 'employee_roster', null]);
  const rows = (await db.query(
    'SELECT * FROM fn_emp_roster($1::date)', ['2026-02-01'])).rows;
  const mine = rows.filter((r) => Number(r.employee_id) === 9970);
  const ids = new Set(rows.map((r) => Number(r.employee_id)));
  const diag = (await db.query(
    `SELECT (SELECT count(*)::int FROM employment WHERE person_id=9970) emp,
            (SELECT count(*)::int FROM person_profile WHERE person_id=9970 AND profile_type='national_id') nid,
            (SELECT count(*)::int FROM employee_org_assignment WHERE employee_id=9970 AND dim_code='cost_org') asg,
            (SELECT count(*)::int FROM employee_no WHERE assigned_person_id=9970 AND retired_at IS NULL) no,
            (SELECT count(*)::int FROM employee_extra WHERE employee_id=9970) ex`)).rows[0];
  rec('RSE5', '给一个人加第二条身份证档案后，花名册里**仍然只有一行**，'
    + '且取的是"已核实优先、否则最新"的那一张；全体也没有重复的 employee_id。'
    + '★ 普通 LEFT JOIN 会复制人：名单上出现 2 行甚至 4 行，"员工总数"跟着翻倍',
    mine.length === 1 && ids.size === rows.length,
    `该人行数=${mine.length} 名单 ${rows.length} 行 / ${ids.size} 人 `
    + `诊断 emp=${diag.emp} 证件=${diag.nid} 归属=${diag.asg} 工号=${diag.no} 档案=${diag.ex}`);
}

// ===========================================================================
// HIREC 组 · 入职一条链（162）：offer 的岗位与薪资带进合同，只填一次
// ---------------------------------------------------------------------------
// 061 做完了 offer→人→任职→工号，160 做出了合同，但两者没连起来 ——
// 入职之后要另开一页填合同，而合同上最要紧的三样（岗位、月薪、入职日）
// 刚刚在 offer 里填过一遍。
// 填两遍的后果不是麻烦，是**两个数会不一样**：offer 6500 / 合同 6000，
// 争议时以合同为准，员工少 500。而且这错不会报错，两份文件各自都"说得通"。
// ===========================================================================
{
  // 先给 42 号组织补一版编制：AC 组已经把名额用满了，
  // 而编制是真实约束（编造"随便开一个需求"会让 AC 组那几条断言失去意义）。
  await db.query(`INSERT INTO headcount_budget(org_id,period,version,quota,set_by,reason)
                  VALUES (42,'2026-07',
                    (SELECT COALESCE(max(version),0)+1 FROM headcount_budget
                      WHERE org_id=42 AND period='2026-07'),20,'hr','入职链：追加名额')`);
  // ★ RETURNING 在这里拿不到（PGlite 对带触发器的 INSERT 不总回行），
  //   改用 max(id) 取刚插的那一条 —— 测试库里没有并发，这个取法是确定的。
  await db.query(`INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
     VALUES (42,'门店店员',1,'2026-07-01','新店开业','hr')`);
  const rq = Number((await db.query(
    `SELECT max(id) m FROM requisition`)).rows[0].m);
  await db.query(`INSERT INTO offer(requisition_id,candidate_key,candidate_name,org_id,status)
     VALUES ($1,'idhash-9970','入职链甲',42,'pending')`, [rq]);
  const off = Number((await db.query(`SELECT max(id) m FROM offer`)).rows[0].m);
  await db.query(
    `INSERT INTO offer_version(offer_id,version,position,monthly_amount,valid_until,
                               created_by,reason)
     VALUES ($1,1,'门店店员',6800,'2026-12-31','hr','首版报价：按编制内名额开出')`, [off]);

  const hire = async (extra) => (await db.query(
    `SELECT * FROM fn_onboard_full($1,NULL,$2::date,994,$3::jsonb,'hr')`,
    [off, '2026-07-01', JSON.stringify({
      employee_address: '上海市示例路 9 号 501 室', ...extra })])).rows[0];

  let hired = null;
  { // HIREC1 岗位与月薪从 offer 带进合同
    const r = await hire({});
    hired = r;
    const c = (await db.query(
      `SELECT * FROM employment_contract WHERE id=$1`, [r.contract_id])).rows[0];
    rec('HIREC1', '一次调用完成"入职 + 合同草稿"：岗位与月薪**从 offer 最新版带出来**'
      + '（门店店员 / 6800），入职日与合同起始日一致，且合同挂在同一个人身上。'
      + '★ 这三样如果各填一遍，必然有不一致的那一天 —— 而不一致按合同执行，'
      + '往往就是更低的那个数',
      c && c.job_title === '门店店员' && Number(c.wage_amount) === 6800
      && c.kind === 'fixed' && Number(c.employee_id) === Number(r.person_id)
      && Number(c.legal_entity_id) === 994
      && c.start_date.toISOString().slice(0, 10) === '2026-07-01',
      `岗位=${c && c.job_title} 工资=${c && c.wage_amount} `
      + `起始=${c && c.start_date.toISOString().slice(0, 10)} 合同号=${r.contract_no}`);
  }

  { // HIREC2 合同是草稿，不自动签（用 HIREC1 返回的 contract_id，别靠编号去猜）
    const r = hired;
    const c = (await db.query(
      `SELECT status, sign_date, body_snapshot FROM employment_contract WHERE id=$1`,
      [r.contract_id])).rows[0];
    // employment_contract 的列叫 employee_id（存的是 person.id，与 144/147 同口径）
    const person = (await db.query(
      `SELECT employee_id FROM employment_contract WHERE id=$1`, [r.contract_id])).rows[0].employee_id;
    // ★ 这里直接查"有没有已签合同"，不再绕花名册：花名册那半条由 RSE 组覆盖，
    //   而这条要回答的是"入职链有没有替人签下去"。
    const signed = Number((await db.query(
      `SELECT count(*)::int n FROM employment_contract
        WHERE employee_id=$1 AND status='signed'`, [person])).rows[0].n);
    rec('HIREC2', '生成的是**草稿**（status=draft、sign_date 为空、没有正文快照），'
      + '这个人身上一份**已签**合同都没有 —— 系统替人"签"下去是最坏的一种自动化：'
      + '它会把"还没谈拢"记录成"已经签了"，而合同恰恰是"双方签了什么"的证据',
      c.status === 'draft' && c.sign_date === null && c.body_snapshot === null
      && signed === 0,
      `状态=${c.status} 签署日=${c.sign_date} 已签合同=${signed} 份`);
  }

  { // HIREC3 试用期超限 → 整条回滚（人不留下）
    await db.query(`INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
       VALUES (42,'门店店员',1,'2026-07-01','新店开业','hr')`);
    const rq2 = Number((await db.query(
      `SELECT max(id) m FROM requisition`)).rows[0].m);
    await db.query(`INSERT INTO offer(requisition_id,candidate_key,candidate_name,org_id,status)
       VALUES ($1,'idhash-9971','入职链乙',42,'pending')`, [rq2]);
    const off2 = Number((await db.query(`SELECT max(id) m FROM offer`)).rows[0].m);
    await db.query(
      `INSERT INTO offer_version(offer_id,version,position,monthly_amount,valid_until,
                                 created_by,reason)
       VALUES ($1,1,'门店店员',6500,'2026-12-31','hr','首版报价：按编制内名额开出')`, [off2]);

    let msg = '';
    try {
      await db.query(`SELECT * FROM fn_onboard_full($1,NULL,'2026-07-01'::date,994,$2::jsonb,'hr')`,
        [off2, JSON.stringify({ employee_address: '上海市示例路 9 号 502 室',
          end_date: '2028-07-01', probation_to: '2027-01-01' })]);
    } catch (e) { msg = e.message; }
    const left = (await db.query(
      `SELECT (SELECT count(*)::int FROM person WHERE full_name='入职链乙') p,
              (SELECT count(*)::int FROM employment_contract WHERE employee_id IN
                 (SELECT id FROM person WHERE full_name='入职链乙')) c`)).rows[0];
    rec('HIREC3', '2 年期合同却要 6 个月试用期（法定上限 2 个月）→ E_CT_BLOCKED，'
      + '并且**整条回滚**：人没有留下、合同也没有留下。'
      + '★ 部分成功最坏：人入职了但合同没生成，名单上会出现一个"无合同在岗"的人，'
      + '而这个状态正是双倍工资风险的起点',
      /E_CT_BLOCKED/.test(msg) && Number(left.p) === 0 && Number(left.c) === 0,
      `拒=${/E_CT_BLOCKED/.test(msg)} 留下人=${left.p} 留下合同=${left.c}`);
  }
}

// ===========================================================================
// CHG 组 · 员工异动（163）：调岗/转店 → 落一份书面变更协议
// ---------------------------------------------------------------------------
// 这是合同签完之后最常发生的事，也是断得最厉害的一段：系统里改了档案，
// 合同上还是老岗位老门店。而《劳动合同法》第三十五条要求变更**采用书面形式** ——
// "在系统里改一下"不等于变更完成。
// ★ 三条要钉住的性质：
//   · 按生效日**切段**，不改历史（否则上月补算工资会按新门店算）；
//   · 变更**另出一份合同**（prev_id 串链），不改原合同（原合同是证据）；
//   · 原合同终止日改到生效日前一天 —— 两份不能同时在履行。
// ===========================================================================
{
  const emp = 9970;             // 合同甲：signed 合同 2026-01-01~2028-01-01，挂在 10
  const openChange = async (kind, date, pnew) => Number((await db.query(
    `SELECT fn_change_open($1,$2,$3::date,$4,$5::jsonb,'hr') i`,
    [emp, kind, date, '商圈调整：门店合并，人员随店走', JSON.stringify(pnew)])).rows[0].i);
  const applyChange = async (id) => (await db.query(
    `SELECT * FROM fn_change_apply($1,'hr')`, [id])).rows[0];

  let applied = null, appliedChangeId = null;
  { // CHG1 转店：归属旧段截断、新段从生效日开
    const id = await openChange('transfer_store', '2026-06-01', { org_id: 11 });
    appliedChangeId = id;
    applied = await applyChange(id);
    const segs = (await db.query(
      `SELECT org_id, valid_from, valid_to FROM employee_org_assignment
        WHERE employee_id=$1 AND dim_code='cost_org' ORDER BY valid_from`, [emp])).rows;
    const roster = async (asOf) => {
      await db.query('SELECT app_begin_scope($1,$2,$3)', [1, 'employee_roster', null]);
      return (await db.query('SELECT * FROM fn_emp_roster($1::date)', [asOf])).rows
        .find((x) => Number(x.employee_id) === emp);
    };
    const may = await roster('2026-05-01');
    const jul = await roster('2026-07-01');
    rec('CHG1', '转店按生效日切段：旧归属截到 2026-05-31、新归属从 2026-06-01 起，'
      + '所以花名册 5 月看到的是原门店、7 月看到的是新门店 —— '
      + '★ 直接 UPDATE 现值会让上个月补算的工资按新门店算，而那个错改不回来',
      segs.length === 2
      && Number(segs[0].org_id) === 10
      && segs[0].valid_to.toISOString().slice(0, 10) === '2026-05-31'
      && Number(segs[1].org_id) === 11
      && segs[1].valid_from.toISOString().slice(0, 10) === '2026-06-01'
      && may && Number(may.org_id) === 10
      && jul && Number(jul.org_id) === 11,
      `段数=${segs.length} 5月=${may && may.org_id} 7月=${jul && jul.org_id} `
      + `旧段至=${segs[0] && segs[0].valid_to.toISOString().slice(0, 10)}`);
  }

  { // CHG2 变更另出一份合同（prev_id 串链、草稿、不带试用期）
    const newC = (await db.query(
      `SELECT * FROM employment_contract WHERE id=$1`, [applied.contract_id])).rows[0];
    const oldC = (await db.query(
      `SELECT * FROM employment_contract WHERE id=$1`, [newC.prev_id])).rows[0];
    rec('CHG2', '变更**另出一份合同**（编号以 BG 开头、prev_id 指回原合同），状态是 draft、'
      + '不带试用期（同一单位只能约定一次）—— 面签后这份才生效；'
      + '原合同的岗位一个字没改（原合同是"当时双方签了什么"的证据，改它就是销毁证据）',
      /^BG/.test(newC.contract_no) && Number(newC.prev_id) === Number(oldC.id)
      && newC.status === 'draft' && newC.probation_from === null
      && newC.job_title === oldC.job_title
      && newC.start_date.toISOString().slice(0, 10) === '2026-06-01',
      `新=${newC.contract_no}/${newC.status} prev=${newC.prev_id} `
      + `起始=${newC.start_date.toISOString().slice(0, 10)} 试用期=${newC.probation_from}`);
  }

  { // CHG3 协议未签 → 原合同仍在履行；签了之后才截断（且两份不重叠）
    const newC = (await db.query(
      `SELECT * FROM employment_contract WHERE id=$1`, [applied.contract_id])).rows[0];
    const oldC = (await db.query(
      `SELECT * FROM employment_contract WHERE id=$1`, [newC.prev_id])).rows[0];
    // 阶段一：建单并生效、但协议还是草稿 —— 原合同**没有被截断**
    const beforeSign = oldC.end_date.toISOString().slice(0, 10);
    // 阶段二：协议签署 → 触发器把原合同截到生效日前一天
    // 签一份变更协议：status 非 draft 时 ck_ec_snapshot 要求有正文快照
    // （正常路径走 contract.sign，那里会先渲染再落快照；这里直接模拟签署）
    await db.query(
      `UPDATE employment_contract
          SET status='signed', sign_date='2026-06-01', signed_by='hr',
              body_snapshot='劳动合同变更协议（测试）'
        WHERE id=$1`, [newC.id]);
    const oldAfter = (await db.query(
      `SELECT end_date FROM employment_contract WHERE id=$1`, [oldC.id])).rows[0];
    const overlap = Number((await db.query(
      `SELECT count(*)::int n FROM employment_contract a
         JOIN employment_contract b ON b.id = $2
        WHERE a.id = $1
          AND daterange(a.start_date, a.end_date, '[]')
              && daterange(b.start_date, b.end_date, '[]')`,
      [oldC.id, newC.id])).rows[0].n);
    rec('CHG3', '变更协议**签署之后**才把原合同截到 2026-05-31（生效日前一天），'
      + '两份合同期间不重叠。★ 建单就截断是错的：协议可能在抽屉里躺两周，'
      + '而原合同已经被切掉 —— 那段日子里这个人"无生效合同"，'
      + '花名册、社保申报、算薪都会认错',
      beforeSign === '2028-01-01'
      && oldAfter.end_date.toISOString().slice(0, 10) === '2026-05-31'
      && overlap === 0,
      `签前原合同止=${beforeSign} 签后=${oldAfter.end_date.toISOString().slice(0, 10)} `
      + `重叠=${overlap}`);
  }

  { // CHG4 三种拒：没合同 / 生效日就是合同起始日 / 重复生效
    const noC = (await db.query(
      `SELECT * FROM fn_change_check(9971,'position','2026-06-01'::date,NULL)`)).rows
      .filter((x) => x.level === 'block').map((x) => x.code);
    const before = (await db.query(
      `SELECT * FROM fn_change_check(9970,'position','2026-01-01'::date,NULL)`)).rows
      .filter((x) => x.level === 'block').map((x) => x.code);
    let again = '';
    try { await db.query(`SELECT * FROM fn_change_apply($1,'hr')`, [appliedChangeId]); }
    catch (e) { again = e.message; }
    rec('CHG4', '三种"看起来只是改个档案"的操作都要拒：只有草稿合同的人 → '
      + 'E_CHG_NO_CONTRACT（没有合同就没有"变更"）；生效日正好等于合同起始日 → '
      + 'E_CHG_BEFORE_START（那是签合同，不是变更）；同一张单子重复生效 → E_CHG_APPLIED。'
      + '放过去，就变成一次**未经书面协商**的变更',
      noC.includes('E_CHG_NO_CONTRACT') && before.includes('E_CHG_BEFORE_START')
      && /E_CHG_APPLIED/.test(again),
      `没合同=${noC.join(',') || '没拦住'} `
      + `起始日当天=${before.join(',') || '没拦住'} `
      + `重复生效=${/E_CHG_APPLIED/.test(again)}`);
  }

  { // CHG5 转用工类型：从什么变成什么必须写得出来（173）
    // ★ 这一条补的是一个"不报错但记不下来"的洞：163 允许 kind='employment_type'，
    //   而 employee_change 没有用工类型的新旧列 —— 发起一次"转非全日制"，
    //   协议上写不出"从全职改成兼职"，而那是争议时最要紧的一句话。
    //   此时 9970 在履行的合同是 CHG1 那份变更协议（fixed，2026-06-01~2028-01-01）。
    const before = (await db.query(
      `SELECT id, kind FROM employment_contract
        WHERE employee_id=$1 AND status='signed'
          AND daterange(start_date, end_date, '[]') @> '2026-08-01'::date`,
      [emp])).rows[0];
    const id = await openChange('employment_type', '2026-08-01', { employment_kind: 'parttime' });
    const chg = (await db.query(
      `SELECT employment_kind_from, employment_kind_to FROM employee_change WHERE id=$1`,
      [id])).rows[0];
    const ap = await applyChange(id);
    const nc = (await db.query(
      `SELECT kind, end_date, prev_id FROM employment_contract WHERE id=$1`,
      [ap.contract_id])).rows[0];
    const oc = (await db.query(`SELECT kind FROM employment_contract WHERE id=$1`,
      [before.id])).rows[0];
    rec('CHG5', '转用工类型记下"从什么变成什么"：异动单存 固定期限 → 非全日制，'
      + '变更协议的 kind 变成非全日制（协议正文的"合同类型"一行读的就是它），'
      + '而原合同的 kind 一个字没改 —— 原合同是"当时签的是什么"的证据',
      chg.employment_kind_from === before.kind && chg.employment_kind_to === 'parttime'
      && nc.kind === 'parttime' && Number(nc.prev_id) === Number(before.id)
      && oc.kind === before.kind,
      `异动=${chg.employment_kind_from}→${chg.employment_kind_to} `
      + `协议=${nc.kind}(prev=${nc.prev_id}) 原合同=${oc.kind}`);
  }
}

// ===========================================================================
// LVG 组 · 假勤资格（164）：入职当年折算 / 12 个月门槛 / 医疗期
// ---------------------------------------------------------------------------
// 129 已经有"按工龄查档"的年假天数，缺的是**资格**：
//   · 7 月 1 日入职的人，应享 5 天还是 2 天？（法定按剩余日历天数折算，不足 1 天不享受）
//   · 刚入职 3 个月的人有没有资格？（法定要求连续工作满 12 个月）
//   · 病假能请多久、什么时候可以依法解除？（医疗期 3–24 个月，仓里一个字段都没有）
// 这三样都直接影响钱与合规，而它们都不会报错 —— 只会"多给了收不回来"。
// ===========================================================================
{
  await db.query(`INSERT INTO person(id,full_name) VALUES
                    (9984,'折算甲'),(9985,'门槛乙'),(9986,'医疗丙'),(9987,'医疗丁')
                  ON CONFLICT (id) DO NOTHING`);
  // 甲：累计工龄 3 年（满 1 年，档位 5 天），本年 7/1 入职 → 折算
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date,prior_work_years)
                  VALUES (19984,9984,994,'2026-07-01',3) ON CONFLICT (id) DO NOTHING`);
  // 乙：入司前 0 年，2026-01-01 入职 → 到年末 11.96 个月，不满 12 个月
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date,prior_work_years)
                  VALUES (19985,9985,994,'2026-01-01',0) ON CONFLICT (id) DO NOTHING`);
  // 丙：总工龄 6 年、本单位 2 年 → 医疗期 3 个月
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date,prior_work_years)
                  VALUES (19986,9986,994,'2024-01-01',4) ON CONFLICT (id) DO NOTHING`);
  // 丁：总工龄 22 年、本单位 21 年 → 医疗期 24 个月
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date,prior_work_years)
                  VALUES (19987,9987,994,'2005-01-01',1) ON CONFLICT (id) DO NOTHING`);

  const ent = async (emp, y) => Number((await db.query(
    `SELECT fn_annual_leave_entitled($1,$2) d`, [emp, y])).rows[0].d);

  { // LVG1 入职当年按剩余日历天数折算，向下取整到整天
    const days = await ent(9984, 2026);
    const full = await ent(9984, 2027);
    const diag = (await db.query(
      `SELECT fn_cumulative_years(9984,'2027-12-31'::date) cy,
              fn_annual_leave_days(9984,'2027-12-31'::date) tier,
              fn_leave_qualified(9984,'2027-12-31'::date) q`)).rows[0];
    rec('LVG1', '7 月 1 日入职、累计工龄 3 年（档位 5 天）的人：2026 年应享 **2 天**'
      + '（剩余 184 天 ÷ 365 × 5 = 2.52，不足 1 整天不享受 → 2），2027 年全年 5 天。'
      + '★ 不折算就是多给 3 天，而多给的那 3 天是真金白银（折现 300%、离职补 200%），'
      + '且给出去了收不回来',
      days === 2 && full === 5,
      `2026=${days} 天 2027=${full} 天（诊断 工龄=${diag.cy} 档位=${diag.tier} 资格=${diag.q}）`);
  }

  { // LVG2 未满 12 个月 → 0 天；满 12 个月 → 全额
    const short = await ent(9985, 2026);   // 1/1 入职，年末 11.96 个月
    await db.query(`UPDATE employment SET hire_date='2025-06-01' WHERE id=19985`);
    const ok = await ent(9985, 2026);      // 已满 19 个月
    rec('LVG2', '连续工作未满 12 个月 → 应享 0 天（法定第三条的门槛）；'
      + '把入职日往前挪到满 12 个月后 → 5 天。'
      + '★ 系统原先对入职 3 个月的人照样给 5 天，那不是宽松 —— '
      + '是给了之后追不回来（休了、折现了、离职补了）',
      short === 0 && ok === 5,
      `未满=${short} 天 已满=${ok} 天`);
  }

  { // LVG3 医疗期按总工龄与本单位工龄分档
    const m1 = Number((await db.query(
      `SELECT fn_medical_period_months(9986,'2026-06-01'::date) m`)).rows[0].m);
    const m2 = Number((await db.query(
      `SELECT fn_medical_period_months(9987,'2026-06-01'::date) m`)).rows[0].m);
    rec('LVG3', '医疗期分档：总工龄 6 年 / 本单位 2 年 → **3 个月**；'
      + '总工龄 22 年 / 本单位 21 年 → **24 个月**。'
      + '★ 医疗期内不得依第四十条解除，超过医疗期才是"可以解除"的条件 —— '
      + '所以下面那条只报不拦',
      m1 === 3 && m2 === 24,
      `短工龄=${m1} 个月 长工龄=${m2} 个月`);
  }

  { // LVG4 配置真的生效：关掉折算与门槛，结果跟着变
    // ★ 关开关要 UPDATE 现有那条值，不能插一条新的：uk_pv(policy_code,effective_from)
    //   会让 INSERT ... ON CONFLICT DO NOTHING 静默跳过，开关看起来"改了"其实没改。
    await db.query(`UPDATE policy_value SET value_num=0
                     WHERE policy_code='LEAVE_FIRST_YEAR_PRORATE'
                       AND effective_from='2026-01-01'`);
    await db.query(`UPDATE policy_value SET value_num=0
                     WHERE policy_code='LEAVE_WAIT_12_MONTHS'
                       AND effective_from='2026-01-01'`);
    const noProrate = await ent(9984, 2026);      // 甲：不折算 → 5
    await db.query(`UPDATE employment SET hire_date='2026-01-01' WHERE id=19985`);
    const noWait = await ent(9985, 2026);         // 乙：不等门槛 → 5（不折算的话全年 5）
    // 复原，避免影响后面的断言
    await db.query(`UPDATE policy_value SET value_num=1
                     WHERE policy_code IN ('LEAVE_FIRST_YEAR_PRORATE','LEAVE_WAIT_12_MONTHS')
                       AND effective_from='2026-01-01'`);
    rec('LVG4', '两个开关都是**配置项**且真的接进了判据：把「入职当年折算」关掉 → '
      + '甲从 2 天变 5 天；把「等 12 个月」关掉 → 乙从 0 天变 5 天。'
      + '★ 法定只要求"不得低于"：企业可以更宽松（入职即给全额），'
      + '所以做成开关而不是写死；但默认值必须是法定，且只能放宽不能收紧',
      noProrate === 5 && noWait === 5,
      `关折算=${noProrate} 关门槛=${noWait}`);
  }
}

// ===========================================================================
// XA 组 · 四块并行交付的库层守门（165 离职 / 166 社保台账 / 167 招聘 / 168 考勤异常）
// ---------------------------------------------------------------------------
// 四路的探针各自 19/9/21/20 条全绿，但探针在 /tmp，不在 CI 里 ——
// 换个机器就没有了。这里各挑**最容易被改坏**的一条搬进来守着。
// ===========================================================================
{
  // 四块各自的人：社保台账要"真实在职"（enroll 会查到职与月薪标准），
  // 补卡要能落到人日上，面试只要一个候选人标识（不必在职）
  await db.query(`INSERT INTO person(id,full_name) VALUES
                    (9991,'社保台账甲'),(9992,'补卡甲')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                    (19991,9991,994,'2026-01-01'),(19992,9992,994,'2026-01-01')
                  ON CONFLICT (id) DO NOTHING`);
  // 社保基数：没有申报基数就取月薪标准 —— 两个都没有时 fn_si_enroll 直接拒，
  // 因为"基数算不出"比"按 0 缴"安全（按 0 缴，员工医保当月起就不生效）
  await db.query(`INSERT INTO salary_standard(employment_id,monthly_amount,effective_from)
                  VALUES (19991,8000,'2026-01-01') ON CONFLICT DO NOTHING`);
  { // XA1 离职：同一人不能有两张未完成的离职单
    const id = Number((await db.query(
      `SELECT fn_exit_open(9970,'resign','2026-08-01'::date,'2026-08-31'::date,
              '个人原因离职，已面谈',NULL,'hr') i`)).rows[0].i);
    let dup = '';
    try {
      await db.query(
        `SELECT fn_exit_open(9970,'resign','2026-08-02'::date,'2026-08-31'::date,
                '又提了一次，理由写长一点',NULL,'hr')`);
    } catch (e) { dup = e.message; }
    rec('XA1', '同一人已有未完成的离职单时再开一张 → E_EXIT_DUP_OPEN。'
      + '★ 两张同时在途的离职单，最后工作日可能不同 —— 而它是社保停缴月、'
      + '最后一份工资、经济补偿年限的共同起点，两个值只能有一个是对的',
      id > 0 && /E_EXIT_DUP_OPEN/.test(dup),
      `开单=${id} 重复=${/E_EXIT_DUP_OPEN/.test(dup)}`);
  }

  { // XA2 社保：同一人同一城市同一险种的期间不得重叠（排他约束）
    const ok = Number((await db.query(
      `SELECT fn_si_enroll(9991,'上海',$1::jsonb,'2026-01','hr') i`,
      [JSON.stringify([{ item: 'pension', base: 8000 }])])).rows[0].i ?? 0);
    let dup = '';
    try {
      await db.query(`SELECT fn_si_enroll(9991,'上海',$1::jsonb,'2026-03','hr')`,
        [JSON.stringify([{ item: 'pension', base: 8000 }])]);
    } catch (e) { dup = e.message; }
    rec('XA2', '同一个人、同一城市、同一险种，在已参保的期间再参一次 → 被排他约束拒。'
      + '★ 允许重叠的后果是"这个月交了两份"，而申报表按段求和会把这个数报出去 ——'
      + '多缴退不回来，少缴要滞纳金',
      /ex_si_enroll|conflicting key|E_SIL/.test(dup),
      `首次=${ok} 重复=${String(dup).split('\n')[0].slice(0, 40) || '没拦住'}`);
  }

  { // XA3 招聘：淘汰必须写评语（≥10 字）
    await db.query(`INSERT INTO person(id,full_name) VALUES (9993,'面试候选')
                    ON CONFLICT (id) DO NOTHING`);
    const rq = Number((await db.query(`SELECT max(id) m FROM requisition`)).rows[0].m);
    let short = '';
    try {
      await db.query(`SELECT fn_interview_add($1,'hash-xa3','面试候选',1,'面试官A',
              '2026-06-01 10:00+08','video',60,'reject','不合适')`, [rq]);
    } catch (e) { short = e.message; }
    const okId = Number((await db.query(
      `SELECT fn_interview_add($1,'hash-xa3','面试候选',1,'面试官A',
              '2026-06-02 10:00+08','video',55,'reject',
              '岗位要求的冷库作业经验不足，且通勤单程两小时') i`, [rq])).rows[0].i);
    rec('XA3', '面试结论填"淘汰"但评语不到 10 字 → 被 CHECK 拒；写清楚原因后能落库。'
      + '★ 淘汰不写理由，三个月后没人答得出"当时为什么说他不行" —— '
      + '而这个答案既是复盘依据，也是被质疑时的唯一凭据',
      /ck_ir_reject_note|E_RCI/.test(short) && okId > 0,
      `短评语=${String(short).split('\n')[0].slice(0, 36) || '没拦住'} 落库=${okId}`);
  }

  { // XA4 考勤：补卡单未审批不许写进考勤
    await db.query(
      `SELECT fn_punch_fix_open(9992,'2026-06-03'::date,'in',
              '2026-06-03 09:00+08','地铁故障，到店后补登记','hr')`);
    // ★ 取 max(id) 而不是 RETURNING/标量返回：这个函数是 RETURNS void 的
    //   （补卡单的 id 对调用方没意义），直接当 bigint 取会拿到 undefined → NaN
    const fx = Number((await db.query(
      `SELECT max(id) m FROM punch_fix WHERE employee_id=9992`)).rows[0].m);
    let early = '';
    try { await db.query(`SELECT fn_punch_fix_apply($1,'hr')`, [fx]); }
    catch (e) { early = e.message; }
    rec('XA4', '补卡单还是"待审批"就写进考勤 → E_PFX_NOT_APPROVED。'
      + '★ 补卡是考勤造假的高发口（代人打卡）：先写进考勤再补审批，'
      + '等于让"改数"发生在"有人同意"之前，事后看不出谁批的',
      fx > 0 && /E_PFX_NOT_APPROVED/.test(early),
      `补卡单=${fx} 未批先写=${/E_PFX_NOT_APPROVED/.test(early)}`);
  }
}

{
  for (const [g, code] of [['XA', 'SUITE.EXIT'], ['XA', 'SUITE.SIL'],
    ['XA', 'SUITE.RCI'], ['XA', 'SUITE.ATX']]) void g;
  const rs = results.filter((r) => /^XA/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  // 四条分属四个判据组，各自记一笔（未登记会 RAISE，所以必须先登记齐）
  for (const c of ['SUITE.EXIT', 'SUITE.SIL', 'SUITE.RCI', 'SUITE.ATX']) {
    await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
      [c, fails === 0 ? 'pass' : 'fail', fails, null]);
  }
}
{
  const rs = results.filter((r) => /^LVG/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.LVG', fails === 0 ? 'pass' : 'fail', fails, null]);
}
{
  const rs = results.filter((r) => /^CHG/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.CHG', fails === 0 ? 'pass' : 'fail', fails, null]);
}

{
  const rs = results.filter((r) => /^RSE/.test(String(r.id)));
  const fails = rs.filter((r) => !r.ok).length;
  await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
    ['SUITE.RSE', fails === 0 ? 'pass' : 'fail', fails, null]);
}

// ---------- 输出 ----------
const pass = results.filter(r => r.ok).length;
// 横幅必须如实说驱动：同一条断言在 PGlite 与真 PG 上的结论不是一件事。
const DRIVER = USE_PG ? '真 PostgreSQL' : 'PGlite/WASM';
console.log(`\nPostgreSQL ${ver} (${DRIVER}) · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
for (const r of results) {
  const tag = r.ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${r.id.padEnd(4)} ${r.what}${r.note ? `   [${r.note}]` : ''}`);
}
console.log('');
process.exit(results.every(r => r.ok) ? 0 : 1);
