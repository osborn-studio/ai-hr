// ============================================================================
// perm-matrix.mjs · 权限矩阵验收：同一份数据，五个角色各拉一遍
// ----------------------------------------------------------------------------
// 为什么单独一个文件：`api.test.mjs` 的 M 组只验了 7 条（无 token 401、四维全空
// 0 行、集团/门店可见性、工资条掩码、会话不残留），而接口已经从 20 个长到 60+。
// 新接口大多没有"换个角色看"的断言 —— 这类洞的形态是：功能全对、演示全绿，
// 上线审计一拉就出问题。
//
// 这个文件不重复 M1–M7，只做一件 M 组没做的事：**把接口 × 角色铺成一张表**，
// 每一格都记录 status 与行数，然后在表上钉 7 组性质（PM1–PM7）+ 2 组补充性质。
//
// ★ 判定口径（与项目既有规矩一致）：
//   ① "拒"（403）与 "空"（200 + 0 行）都是安全答案，两者可以混着出现 ——
//      岗位层（064 sys_role_resource）拦的是"这类事"，行闸（四维临时表）拦的是
//      "哪些行"。一个账号可能过得了岗位层却什么都看不到（user 3 的 payslip）。
//      不安全的是**第三种答案：200 且带业务数据**。
//   ② 字段掩码只掩码不报错（003）：HTTP 仍 200，值变 null。所以"看不到某个字段"
//      不该表现为 403。
//   ③ 导出必须与页面同口径（003 的 scene 维）：page 掩了、导出没掩 = 洞，因为
//      导出的文件会被随手转发。
//
// ★ 这个文件是**验收者**：不改 app/ 下任何代码。发现缺陷照实红，在报告里点名。
// ============================================================================
import { createApp } from '../app/server.mjs';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok: !!ok, note });

// ★ 这个 env 必须在 createApp 之前设（登录路由读进程环境），与 api.test.mjs 同。
process.env.TRUST_PROXY = '1';
const { server, db } = await createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 口令与角色 id 都来自 app/server.mjs 的种子（1 集团HR / 2 A店HR / 3 无授权 /
// 4 组织继承 / 5 临时口令）。这里不写死角色 id，需要时从库里查。
const PWD = 'demo1234';

const loginAs = async (u, pwd = PWD) => {
  const r = await fetch(`${BASE}/login?user=${u}&pwd=${encodeURIComponent(pwd)}`, { method: 'POST' });
  return { status: r.status, body: await r.json() };
};
const get = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return { status: r.status, body: null, text: await r.text(), ct };
  return { status: r.status, body: await r.json(), text: null, ct };
};
const postJson = async (path, token, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
};

// ============================================================================
// 0. 夹具
// ----------------------------------------------------------------------------
// ★ 种子只覆盖"两店各一个人 + 两条工资条"。花名册、工资条、考勤异常之外的
//   六个接口在纯种子下**全是 0 行** —— 那时"每个角色都看不到"是因为库里没有数据，
//   不是因为权限对。那种矩阵看起来全绿，实际什么都没验。
//   所以这里按业务键造最小夹具：emp1 → A店(10)，emp2 → B店(11)，emp3 → C店(12)
//   且**属于第二个法人**（PM6 要的跨法人一格）。
// ★ 夹具只写数据，不写权限配置：sys_user_role / sys_org_grant / sys_field_permission
//   一行都不动 —— 动了就是在"改被验收对象"。
// ============================================================================
const fixtures = [];
const fx = async (label, sql, params) => {
  try {
    await db.query(sql, params);
    fixtures.push(label);
    return true;
  } catch (e) {
    fixtures.push(`${label} ✗ ${String(e.message).split('\n')[0]}`);
    return false;
  }
};
const resync = async (t) => {
  await db.query(`SELECT setval(pg_get_serial_sequence('${t}','id'),
                               GREATEST((SELECT COALESCE(max(id),1) FROM ${t}),1))`);
};

await fx('legal_entity 1/2（法人主档）', `
  INSERT INTO legal_entity(id,name,credit_code,address,legal_rep,stamp_name) VALUES
    (1,'示例餐饮（上海）有限公司','91310000MA1K000001','上海市黄浦区示例路 1 号','甲','示例餐饮（上海）有限公司'),
    (2,'示例餐饮（苏州）有限公司','91320500MA1K000002','苏州市工业园区示例路 2 号','乙','示例餐饮（苏州）有限公司')
  ON CONFLICT (id) DO NOTHING`);

await fx('person 3（王五，第三个法人的人）', `INSERT INTO person(id,full_name) VALUES (3,'王五')
  ON CONFLICT (id) DO NOTHING`);
await fx('employee_no E0003', `SELECT fn_assign_employee_no(3,'E0003')`);
await fx('employment 3（legal_entity=2）', `INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
  VALUES (3,3,2,'2026-01-01') ON CONFLICT (id) DO NOTHING`);

await fx('考勤组织归属 emp1→10 / emp2→11 / emp3→12（种子只给了 cost_org）', `
  INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from) VALUES
    (1,'attendance_org',10,'2026-01-01'),
    (2,'attendance_org',11,'2026-01-01'),
    (3,'attendance_org',12,'2026-01-01')`);
await fx('成本组织归属 emp3→12', `INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
  VALUES (3,'cost_org',12,'2026-01-01')`);

await fx('手机号档案 person1（证明"null 是掩码，不是缺数据"）', `
  INSERT INTO person_profile(person_id,profile_type,profile_value)
  VALUES (1,'mobile','13800001111')`);

await fx('合同 2 份（emp1→A店 / emp2→B店）', `
  INSERT INTO employment_contract(employee_id,legal_entity_id,contract_no,kind,start_date,end_date,
    job_title,workplace,employee_address,wage_amount,status) VALUES
    (1,1,'HT-A-001','fixed','2026-01-01','2027-12-31','店员','A店','上海市示例路 1 号',8000,'draft'),
    (2,1,'HT-B-001','fixed','2026-01-01','2027-12-31','店员','B店','上海市示例路 2 号',9000,'draft')`);

await fx('社保参保 2 行（emp1 / emp2，上海 pension）', `
  INSERT INTO si_enrollment(employee_id,city,item,start_period,base_amount,rate_employee,rate_employer,
    source,created_by) VALUES
    (1,'上海','pension','2026-01',8000,0.0800,0.1600,'hire','fixture'),
    (2,'上海','pension','2026-01',9000,0.0800,0.1600,'hire','fixture')`);

await fx('考勤异常 2 行（emp1 3-02 迟到 / emp2 3-03 迟到）', `
  INSERT INTO att_exception(employee_id,work_date,kind,minutes,source,status) VALUES
    (1,'2026-03-02','late',10,'manual','open'),
    (2,'2026-03-03','late',15,'manual','open')`);

await fx('离职单 2 张（emp1 / emp2 各一张 draft）', `
  INSERT INTO employee_exit(code,employee_id,kind,apply_date,last_work_date,reason,status,created_by)
  VALUES ('EX-A-001',1,'resign','2026-03-01','2026-03-31','个人原因','draft','fixture'),
         ('EX-B-001',2,'resign','2026-03-02','2026-03-31','个人原因','draft','fixture')`);

// PM6：第二个法人的发薪批次与工资条。emp3 挂在 C店(12)，落在集团HR 的 cost_org 子树里，
// 但**不在**任何角色的 payroll_legal_entity 范围里（种子只给了 [1]）——
// 这正是"跨法人"这一格：行看得到（cost_org），钱不该算（payroll_legal_entity）。
await fx('pay_run 2（2026-03 / legal_entity=2）', `
  INSERT INTO pay_run(id,period,legal_entity_id,status) VALUES (2,'2026-03',2,'draft')
  ON CONFLICT (id) DO NOTHING`);
await fx('attendance_daily_store emp3→C店12（工资条行闸取 store_id）', `
  INSERT INTO attendance_daily_store(employee_id,store_id,work_date,shift_start_at,shift_end_at,
    span_hours,on_duty_hours,off_duty_hours,break_on_duty_hours,in_attendance_hours,work_hours,
    snap_on_duty_break_basis)
  VALUES (3,12,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance')`);
await fx('payslip（emp3 / run 2 / 应发 7000 实发 5500）', `
  INSERT INTO payslip(pay_run_id,employee_id,gross_amount,net_amount,si_employee,tax_amount)
  VALUES (2,3,7000,5500,900,600)`);
await fx('payslip_item（emp3 / run 2，明细自洽）', `
  INSERT INTO payslip_item(payslip_id,item_code,amount)
  SELECT p.id, v.code, v.amt FROM payslip p,
         (VALUES ('BASE',7000),('SI_EMPLOYEE',-900),('IIT',-600)) AS v(code,amt)
   WHERE p.pay_run_id = 2 AND p.employee_id = 3`);

await resync('person'); await resync('employment'); await resync('pay_run');

// 申报表（141）只对**已封账**的批次出数，而种子批次是 draft —— 纯种子下
// /api/declare 对所有人都是 200 + blocked=E_DECLARE_NOT_SEALED + 0 行。
// 那会让矩阵里这一行看起来"谁都看不到"，而真相是"库里没有可申报的批次"。
// ★ 不走 fn_pay_run_seal：它会被 E_SEAL_CHAIN_STALE 拦住（种子的累计是演示数）。
//   这里直接把状态置为 sealed，等于"确认按现状封账"，只改数据、不改判据。
await fx('pay_run 1 置 sealed（否则申报表 blocked，矩阵这一行永远 0 行）',
  `UPDATE pay_run SET status='sealed', sealed_at=now(), sealed_by='fixture'
    WHERE id=1 AND status='draft'`);

const fxFail = fixtures.filter((x) => x.includes('✗'));
rec('FX', '夹具全部建成（建不成的夹具会让矩阵"看起来绿"而其实什么都没验）',
  fxFail.length === 0, fxFail.join(' | '));

// ============================================================================
// 1. 角色与接口
// ============================================================================
const ROLES = [
  { u: 1, name: '集团HR', pwd: PWD, want: '全范围：两店（夹具后三店）都应看得到' },
  { u: 2, name: 'A店HR', pwd: PWD, want: 'sys_data_scope 200，cost_org 只有 10' },
  { u: 3, name: '无授权', pwd: PWD, want: '有岗位（店员 17）、四维全空' },
  { u: 4, name: '门店HR(继承)', pwd: PWD, want: '权限全部来自 org 10 → 华东区 30 的 org_grant' },
  { u: 5, name: '临时口令', pwd: 'temp1234', want: '登录成功但必须先改密' },
];

const EP = [
  { k: 'employees', path: '/api/employees?as_of=2026-03-01', kind: 'json', res: 'employee_roster' },
  { k: 'payslip', path: '/api/payslip', kind: 'json', res: 'payslip' },
  // ★ 这个格子是补的（2026-11 审计）：原来矩阵只测 /api/payslip（自己的工资条），
  //   而 **/api/payroll/slips（某批次的全员工资条）是另一个入口** —— 那条 SQL
  //   当时一道 scope 过滤都没有，A店HR 只要知道 run id 就能看到该批次全部人。
  //   洞换个入口就复现，而换入口的洞不会被上一版的矩阵覆盖。
  { k: 'payroll/slips', path: '/api/payroll/slips?run=1', kind: 'json', res: 'payslip' },
  { k: 'paylist.csv', path: '/api/payroll/paylist.csv?run=1', kind: 'csv', res: 'payroll_run' },
  { k: 'declare', path: '/api/declare?period=2026-03&entity=1', kind: 'declare', res: 'payroll_run' },
  { k: 'si/enrollments', path: '/api/si/enrollments', kind: 'json', res: 'payroll_run' },
  { k: 'hr/contracts', path: '/api/hr/contracts', kind: 'json', res: 'employee_roster' },
  { k: 'perf', path: '/api/perf', kind: 'perf', res: 'perf_cycle' },
  { k: 'att/exceptions', path: '/api/att/exceptions?period=2026-03', kind: 'json', res: 'attendance_daily' },
  { k: 'hr/exit/list', path: '/api/hr/exit/list', kind: 'json', res: 'employee_roster' },
];

const ok2xx = (s) => s >= 200 && s < 300;

// 一格的"行数"。null = 这一格没有行这个概念（拒了 / 报错）。
function rowsOf(kind, r) {
  if (!ok2xx(r.status)) return null;
  const b = r.body || {};
  if (kind === 'csv') {
    const t = (r.text || '').replace(/^\uFEFF/, '');
    if (!t) return 0;
    const lines = t.split('\n').filter((x) => x !== '');
    return Math.max(lines.length - 2, 0);      // 去掉表头与合计行
  }
  if (kind === 'perf') return Array.isArray(b.results) ? b.results.length : null;
  if (kind === 'declare') return b.blocked ? 0 : (b.iit?.rows?.length ?? 0);
  // ★ 有的接口包 {rows:…}（payslip / contracts），有的直接返回裸数组
  //   （att/exceptions 就是）。只认 body.rows 会把"200 且 0 行"读成"没有行概念"，
  //   而 PM1 靠的正是这个 0 —— 读错的后果是一条真实的绿被记成红。
  if (Array.isArray(b)) return b.length;
  return Array.isArray(b.rows) ? b.rows.length : null;
}

const grid = {};          // grid[ep][user] = { status, rows, body, text }
const tokens = {};

for (const r of ROLES) {
  const l = await loginAs(r.u, r.pwd);
  r.loginStatus = l.status;
  r.token = l.body?.token || null;
  r.loginBody = l.body;
  if (r.token) tokens[r.u] = r.token;
}
for (const e of EP) {
  grid[e.k] = {};
  for (const r of ROLES) {
    if (!r.token) { grid[e.k][r.u] = { status: 0, rows: null, body: null }; continue; }
    let res;
    try { res = await get(e.path, r.token); }
    catch (err) { res = { status: 0, body: { error: String(err.message) } }; }
    grid[e.k][r.u] = { status: res.status, rows: rowsOf(e.kind, res), body: res.body, text: res.text };
  }
}
const C = (k, u) => grid[k][u];
const fmt = (c) => (c.status === 0 ? 'ERR' : `${c.status}/${c.rows === null ? '—' : c.rows}`);

// ---------------------------------------------------------------------------
// 矩阵表：接口 × 角色 → status/行数
// ---------------------------------------------------------------------------
const w = (s) => [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(n - w(s), 0));

{
  const cols = [22, ...ROLES.map(() => 13)];
  console.log('\n权限矩阵（每格 = HTTP status / 行数；— 表示该格没有行概念）');
  console.log('─'.repeat(cols.reduce((a, b) => a + b, 0)));
  console.log(pad('接口', cols[0]) + ROLES.map((r, i) => pad(r.name, cols[i + 1])).join(''));
  console.log('─'.repeat(cols.reduce((a, b) => a + b, 0)));
  for (const e of EP) {
    console.log(pad(e.k, cols[0]) + ROLES.map((r, i) => pad(fmt(C(e.k, r.u)), cols[i + 1])).join(''));
  }
  console.log('─'.repeat(cols.reduce((a, b) => a + b, 0)));
}

// ============================================================================
// 2. PM1 · 无授权账号：九格都不许有业务数据
// ============================================================================
{
  const cells = EP.map((e) => ({ k: e.k, c: C(e.k, 3) }));
  // 安全 = 拒（403）或 空（200 + 0 行）。★ 200 且 rows>0 是唯一的越权形态。
  const bad = cells.filter(({ c }) => !(c.status === 403 || (c.status === 200 && c.rows === 0)));
  const err5 = cells.filter(({ c }) => c.status >= 500 || c.status === 0);
  rec('PM1', '无授权账号（user3，店员岗位 + 四维全空）拉 10 个读接口：每格只能是 403 或 200+0 行，'
    + '且不得 5xx —— "拒"与"空"混着出现是安全的（岗位层与行闸是两层）',
    bad.length === 0 && err5.length === 0,
    cells.map(({ k, c }) => `${k}=${fmt(c)}`).join(' '));
}

// ============================================================================
// 3. PM2 · A店HR 的花名册必须收窄，且每行 org_id 就是 10
// ============================================================================
const R1 = C('employees', 1).body?.rows || [];
const R2 = C('employees', 2).body?.rows || [];
{
  const orgOk = R2.length > 0 && R2.every((x) => Number(x.org_id) === 10);
  rec('PM2', `A店HR 花名册行数（${R2.length}）必须小于集团HR（${R1.length}），且每行 org_id=10`,
    C('employees', 2).status === 200 && R2.length < R1.length && orgOk,
    `集团HR=${C('employees', 1).status}/${R1.length} A店HR=${C('employees', 2).status}/${R2.length} `
    + `A店HR 的 org_id=${[...new Set(R2.map((x) => Number(x.org_id)))].join(',') || '(空)'} `
    + `集团HR 的 org_id=${[...new Set(R1.map((x) => Number(x.org_id)))].join(',')}`);
}

// ============================================================================
// 4. PM3 · 同一行、字段级差异
// ----------------------------------------------------------------------------
// ★ "同一行"要能证：两个角色拿到的必须是被同一个 employee_id 标识的那条记录。
//   否则"集团HR 有值、A店HR 为 null"也可能只是两个人。
// ============================================================================
const one2 = R2.find((x) => Number(x.employee_id) === 1);
const one1 = R1.find((x) => Number(x.employee_id) === 1);
{
  const sameRow = !!one1 && !!one2 && one1.employee_no === one2.employee_no
    && one1.full_name === one2.full_name && Number(one1.org_id) === Number(one2.org_id);
  const okA = one1?.national_id === '310101199001011234' && one1?._actions?.national_id === 'visible';
  const okB = one2?.national_id === null && one2?._actions?.national_id === 'masked';
  rec('PM3', '字段掩码（national_id）：集团HR 拿原值 + action=visible；A店HR 同一行拿 null + action=masked'
    + '（HTTP 仍 200 —— 只掩码不报错）',
    sameRow && okA && okB,
    `同一行=${sameRow ? `emp#${one1?.employee_id}/${one1?.employee_no}` : '未能对齐'} `
    + `集团HR=${one1?.national_id ?? 'null'}/${one1?._actions?.national_id} `
    + `A店HR=${one2?.national_id ?? 'null'}/${one2?._actions?.national_id}`);
}
{
  // ★ 这一条照实说：种子**没有** mobile 的字段策略行（sys_field_permission 里只有
  //   national_id），003 的规矩是"无配置 = masked（fail-closed）"，所以集团HR 也是 null。
  //   那不是越权，是配置空缺 —— 但要能被看见，而不是被写成"集团HR 有值"。
  const dbMobile = (await db.query(
    `SELECT profile_value FROM person_profile WHERE person_id=1 AND profile_type='mobile'`)).rows[0]?.profile_value;
  rec('PM3b', '字段掩码（mobile）：A店HR 为 null 且 masked；库里确实有值（证明 null 来自策略，'
    + '不是数据缺失）。★ 集团HR 同样为 null —— 种子没有 mobile 的策略行，fail-closed',
    dbMobile === '13800001111' && !!one2 && one2.mobile === null
      && one2._actions?.mobile === 'masked' && one1?.mobile === null,
    `库里=138****1111 A店HR=${one2?.mobile ?? 'null'}/${one2?._actions?.mobile} `
    + `集团HR=${one1?.mobile ?? 'null'}/${one1?._actions?.mobile}`);
}

// ============================================================================
// 5. PM4 · 导出与页面掩码一致（最容易被漏的一类：页面掩了、导出忘了）
// ============================================================================
const csv2 = (C('paylist.csv', 2).text || '').replace(/^\uFEFF/, '');
const csv1 = (C('paylist.csv', 1).text || '').replace(/^\uFEFF/, '');
{
  // 页面上 net_amount 为 null 的人 = 被掩码的人。导出的"实发"列对他们不许是真值。
  const maskedEmps = (C('payslip', 2).body?.rows || []).filter((x) => x.net_amount === null)
    .map((x) => Number(x.employee_id));
  const trueNet = (await db.query(
    `SELECT p.employee_id, p.net_amount::text AS net
       FROM payslip p WHERE p.employee_id = ANY($1::bigint[])`, [maskedEmps])).rows;
  const leaked = trueNet.filter((r) => csv2.includes(Number(r.net).toFixed(2)));
  rec('PM4a', '导出与页面同口径：/api/payroll/paylist.csv 里不得出现"A店HR 页面上 net_amount 为 null"'
    + '那些人的实发真值',
    maskedEmps.length > 0 && leaked.length === 0,
    `页面掩码的人=${maskedEmps.join(',') || '(无)'} 导出泄漏=${leaked.map((r) => `emp${r.employee_id}:${Number(r.net).toFixed(2)}`).join(',') || '无'} `
    + `CSV 行数=${C('paylist.csv', 2).rows} 页面行数=${(C('payslip', 2).body?.rows || []).length}`);
}
{
  // 导出的**行**也不能比页面多：A店HR 页面上 1 人，导出里 2 人 = 多看到了一个人。
  // ★ 口径要对齐：导出只含 run=1 的人，页面含所有批次的工资条（emp3 在 run 2）。
  //   所以比较的是"页面 ∩ 本批次"的人数，而不是两个总数 —— 直接比总行数会得出
  //   "集团HR 导出 2 < 页面 3"，那是我的口径错，不是系统的洞。
  const runIds = (await db.query(
    `SELECT DISTINCT employee_id::int AS id FROM payslip WHERE pay_run_id = 1
      ORDER BY 1`)).rows.map((r) => r.id);
  const pick = (u) => {
    const page = new Set((C('payslip', u).body?.rows || []).map((x) => Number(x.employee_id)));
    return runIds.filter((id) => page.has(id));
  };
  const exp1 = pick(1), exp2 = pick(2);
  rec('PM4b', '导出行数不得超过"该角色页面 ∩ 本批次"的人数（导出不能比页面多看到人）',
    C('paylist.csv', 2).rows === exp2.length && C('paylist.csv', 1).rows === exp1.length,
    `批次内=${runIds.join(',')}；A店HR 导出=${C('paylist.csv', 2).rows} 行 / 应=${exp2.length} 行`
    + `（页面 ∩ 本批次=${exp2.join(',') || '空'}）；集团HR 导出=${C('paylist.csv', 1).rows} 行 / 应=${exp1.length} 行`);
}

// ============================================================================
// 6. PM5 · 越权写：三个写接口对无授权账号都必须是 403
// ----------------------------------------------------------------------------
// 不是 500（那是服务故障）、不是 200（那是真写进去了）、也不是 428（那是别人的约束）。
// ============================================================================
{
  const w1 = await postJson('/api/payroll/run?period=2026-04&entity=1', tokens[3], {});
  const w2 = await postJson('/api/hr/contract', tokens[3], {
    employeeId: 1, legalEntityId: 1, kind: 'fixed', startDate: '2026-01-01',
    endDate: '2027-12-31', jobTitle: '店员', workplace: 'A店',
    employeeAddress: '上海市示例路 1 号', wageAmount: 8000,
  });
  const w3 = await postJson('/api/hr/exit/open', tokens[3], {
    employeeId: 1, kind: 'resign', applyDate: '2026-03-01',
    lastWorkDate: '2026-03-31', reason: '越权写测试',
  });
  const ws = [
    ['/api/payroll/run', w1], ['/api/hr/contract', w2], ['/api/hr/exit/open', w3],
  ];
  rec('PM5', '越权写：无授权账号对 payroll/run、hr/contract、hr/exit/open 各发一次 POST，'
    + '都必须 403（不是 500、不是 200）',
    ws.every(([, r]) => r.status === 403),
    ws.map(([p, r]) => `${p}=${r.status}/${r.body?.error ?? '-'}`).join(' '));
}

// ============================================================================
// 7. PM6 · 跨法人：只能算自己法人的薪
// ----------------------------------------------------------------------------
// 种子里所有 employment 都是 legal_entity 1，所以这一条**必须造夹具**（见上，
// 已造 legal_entity 2 + employment 3 + pay_run 2 + payslip 3）。
// 四维里 payroll_legal_entity 两个角色都只被授了 [1]。
// ============================================================================
{
  const d1 = await get('/api/declare?period=2026-03&entity=1', tokens[1]);
  const d2 = await get('/api/declare?period=2026-03&entity=2', tokens[1]);
  const d2b = await get('/api/declare?period=2026-03&entity=2', tokens[2]);
  const run2 = await postJson('/api/payroll/run?period=2026-05&entity=2', tokens[1], {});
  rec('PM6a', '跨法人拦截：集团HR 看法人 1 的申报表 200、法人 2 的 403(E_OUT_OF_SCOPE)；'
    + 'A店HR 看法人 2 也 403；集团HR 对法人 2 发起算薪 403',
    d1.status === 200 && d2.status === 403 && d2b.status === 403 && run2.status === 403
      && d2.body?.error === 'E_OUT_OF_SCOPE' && run2.body?.error === 'E_OUT_OF_SCOPE',
    `declare e1=${d1.status} e2=${d2.status}/${d2.body?.error} `
    + `(A店HR e2=${d2b.status}/${d2b.body?.error}) payroll/run e2=${run2.status}/${run2.body?.error}`);
}
{
  // 反过来的一句：行闸只按 cost_org 过滤，那 emp3（法人 2、C店 12）会不会顺着
  // cost_org 子树漏进工资条？"算不了"不等于"看不到" —— 但工资条本身就是钱的明细。
  const leak1 = (C('payslip', 1).body?.rows || []).filter((x) => Number(x.employee_id) === 3);
  const leak2 = (C('payslip', 2).body?.rows || []).filter((x) => Number(x.employee_id) === 3);
  rec('PM6b', '跨法人：法人 2 的员工（emp3）的工资条不得出现在法人 1 的账号视野里'
    + '（/api/payslip 的行闸只按 cost_org，不发薪法人）',
    leak1.length === 0 && leak2.length === 0,
    `集团HR 看到 emp3 的工资条 ${leak1.length} 行`
    + (leak1.length ? `（净额=${leak1[0].net_amount ?? 'null'}/${leak1[0]._net_amount_action}）` : '')
    + `，A店HR ${leak2.length} 行；`
    + `集团HR payslip 共 ${(C('payslip', 1).body?.rows || []).length} 行 `
    + `(employee_id=${(C('payslip', 1).body?.rows || []).map((x) => x.employee_id).join(',')})`);
}

// ============================================================================
// 7b. PM6c · 批次工资条的法人闸：A店HR 打法人 2 的批次 → 403（不是 200 空）
// ----------------------------------------------------------------------------
// ★ 这条是补的（2026-11 审计），钉的是"同一个洞的另一半"：
//   · 门店行闸挡的是"你在不在这个店"；
//   · 法人闸挡的是"这个人的钱是不是**你这条线**发的"。
//   A店HR 受权管 A 店，但 A 店里可能有人挂在别的法人发薪 —— 他该看到人，
//   不该看到那个人的工资条。/api/payroll/slips 原来只有前者，后者一格没有。
// ★ 判据是 **403**，不是"行数少一点"。静默少行是最难查的形态：
//   页面上少一行，人会以为"这个人本来没有工资条"，而真相是"你没权看"。
//   所以 200+0 行在这里**不算通过** —— 只有 E_OUT_OF_SCOPE 才算。
// ★ 集团HR 对法人 2 也是 403：她的 payroll_legal_entity 只授了 [1]，
//   "授了什么看什么"，与 PM6a 的申报表同一口径。
// ============================================================================
{
  const r1 = await get('/api/payroll/slips?run=2', tokens[1]);
  const r2 = await get('/api/payroll/slips?run=2', tokens[2]);
  const r3 = await get('/api/payroll/slips?run=1', tokens[2]);
  rec('PM6c', '批次工资条（run=2 挂在法人 2）：A店HR 与集团HR 都 403(E_OUT_OF_SCOPE)；'
    + '同一账号打 run=1（法人 1）仍是 200 —— 法人闸挡的是主体，不是把人全挡掉',
    r1.status === 403 && r1.body?.error === 'E_OUT_OF_SCOPE'
    && r2.status === 403 && r2.body?.error === 'E_OUT_OF_SCOPE'
    && r3.status === 200,
    `run=2 集团HR=${r1.status}/${r1.body?.error} A店HR=${r2.status}/${r2.body?.error}；`
    + `run=1 A店HR=${r3.status}（${(r3.body?.rows || []).length} 行）`);
}

// ============================================================================
// 7d. PM6d · 店长看本店工资条：200 + 实发掩码（不是 403，也不是明文）
// ----------------------------------------------------------------------------
// ★ 钉的是"矩阵漏了一行"这类缺陷：063 的 sys_role_resource 给 store_mgr(16)
//   配了考勤/请假/花名册/报表/绩效/审批，**唯独没有 payslip** —— 而 063 的规矩是
//   "未登记即拒绝"，于是店长打开工资条那屏拿到的是 403，不是"实发打码"。
//   演示时尤其糟：观众看到 403 只会觉得系统坏了。
// ★ 这一条同时钉两件事，而且**必须同时**，否则修法会偏：
//   ① 资源给了 → 不能是 403；
//   ② 掩码还在 → net_amount 必须是 null（003 的兜底是 masked，"无配置 = 掩码"）。
//   只钉①会把"顺手给了字段可见"放过去；只钉②则 403 也算过（403 时也没有 net）。
// ★ 再补一条 can_write=false：补权限时最容易顺手写成 can_write=true，
//   而"能改员工签过字的工资条"比看不到严重得多。
// ★ 账号走 fn_account_create（064）：店长的数据范围就是"这个门店 + 整棵子树"，
//   行闸那一半本来就对，本组不验它（验它的是 PM8b 的"⊆ 花名册"）。
// ============================================================================
{
  const { hashPassword } = await import('../app/services/auth.mjs');
  // ★ 手工造账号，不走 fn_account_create：那个函数建的是 **sys_account**（id 由
  //   IDENTITY 从 1 起），而本仓的"用户"其实是 sys_user_credential 里的裸 id
  //   （种子里 1..5）。两边 id 空间不同源，直接用它拿到的是 2 号 —— 撞上 A店HR
  //   的口令行，登录成的会是别人。用一个没人占的号段把"这个人是谁"钉死。
  const MG = 9101;
  await db.query(`INSERT INTO sys_data_scope(id,name,combinator)
                  VALUES ($1,'账号:pm_store_mgr','intersection')`, [MG]);
  await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                    ($1,'cost_org','node_subtree',ARRAY[10]::bigint[]),
                    ($1,'attendance_org','node_subtree',ARRAY[10]::bigint[]),
                    ($1,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
                    ($1,'si_entity','nodes',ARRAY[1]::bigint[])`, [MG]);
  await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,
                                            grant_kind,grant_reason,effective_from)
                  VALUES ($1,$1,16,$1,'ROLE','perm-matrix PM6d：店长只到本店',current_date)`, [MG]);
  await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
    [MG, hashPassword(PWD)]);
  // ★ 180 起要"绑人"：非 HR 只能看自己那一行，而"自己"= sys_account.person_id。
  //   绑 person 1（张三，A店 10 号店，run 1 里有他的工资条）。
  //   ★ id 必须等于登录用的 user id（fn_my_person 就是按这个查的），而
  //     sys_account.id 是 GENERATED ALWAYS AS IDENTITY —— 所以用 OVERRIDING SYSTEM VALUE。
  await db.query(`INSERT INTO sys_account(id, login, display_name, person_id)
                  OVERRIDING SYSTEM VALUE VALUES ($1,'pm_store_mgr','店长样例',1)`, [MG]);
  const l = await loginAs(MG);
  const tok = l.body?.token || null;

  const own = await get('/api/payslip', tok);                    // 自取工资条那屏
  const batch = await get('/api/payroll/slips?run=1', tok);      // 批次明细（本店）
  const ownRows = own.body?.rows || [];
  const bRows = batch.body?.rows || [];
  const canWrite = (await db.query(
    `SELECT fn_role_can($1,'payslip','write') w`, [MG])).rows[0].w;

  // ★ 180（需求变更）：他**只该看到自己那一行**，不再是"本店 11 行"。
  //   这不是放宽，是收紧 —— 原来的判据是"行数 > 0 且都在本店"，
  //   现在必须是"恰好 1 行，且那个人就是我"。
  const ownOk = own.status === 200 && ownRows.length === 1
    && Number(ownRows[0].employee_id) === 1
    && ownRows.every((x) => x.net_amount === null && x._net_amount_action === 'masked');
  const batchOk = batch.status === 200 && bRows.length === 1
    && Number(bRows[0].employee_id) === 1
    && bRows.every((x) => x.net_amount === null);

  rec('PM6d', '店长（store_mgr，范围=本店 10，绑人=张三）打开工资条：'
    + '/api/payslip 与 /api/payroll/slips 都 200，**只有自己那 1 行**，'
    + 'net_amount 为 null（掩码还在）；且 can_write=false（补权限不能顺手给写）'
    + '★ 180 需求变更："本店全部"→"只有自己"，这是收紧不是放宽',
    ownOk && batchOk && canWrite === false,
    `登录=${l.status} /api/payslip=${own.status}（${ownRows.length} 行，`
    + `emp=${ownRows.map((x) => x.employee_id).join(',') || '—'}，`
    + `net=${ownRows.map((x) => x.net_amount === null ? 'null' : '明文').join(',') || '—'}）`
    + ` /api/payroll/slips=${batch.status}（${bRows.length} 行 emp=${bRows.map((x) => x.employee_id).join(',')}）`
    + ` can_write=${canWrite}`);
}

// ============================================================================
// 7e. PM6e · 店员（最低岗位）同样只看到自己 —— "所有人"里也包含他
// ----------------------------------------------------------------------------
// ★ 为什么单独钉一条：店长那条测的是"有行闸、有掩码"的岗位，而店员是最容易被漏的
//   （17 号角色只有 payslip 读 + 自己的考勤/请假）。用户说的是"**所有人**自己只能
//   看自己的"，那这一侧也必须钉。
// ★ 店员样例绑 person 2（李四，B店 11），run 1 里 emp1/emp2 都有工资条：
//   如果人员闸失效，他会看到 2 行（A店那行是因为…… 不，他压根看不到 B店以外），
//   更关键的是**不能**看到 11 行的"全店"。
// ============================================================================
{
  const { hashPassword } = await import('../app/services/auth.mjs');
  const SA = 9104;   // 9102 被 PM10（老板）占了
  await db.query(`INSERT INTO sys_data_scope(id,name,combinator)
                  VALUES ($1,'账号:pm_store_staff','intersection')`, [SA]);
  await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                    ($1,'cost_org','node_subtree',ARRAY[11]::bigint[]),
                    ($1,'attendance_org','node_subtree',ARRAY[11]::bigint[]),
                    ($1,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
                    ($1,'si_entity','nodes',ARRAY[1]::bigint[])`, [SA]);
  await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,
                                            grant_kind,grant_reason,effective_from)
                  VALUES ($1,$1,17,$1,'ROLE','perm-matrix PM6e：店员只看自己',current_date)`, [SA]);
  await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
    [SA, hashPassword(PWD)]);
  await db.query(`INSERT INTO sys_account(id, login, display_name, person_id)
                  OVERRIDING SYSTEM VALUE VALUES ($1,'pm_store_staff','店员样例',2)`, [SA]);
  const l = await loginAs(SA);
  const tok = l.body?.token || null;
  const r = await get('/api/payroll/slips?run=1', tok);
  const rows = r.body?.rows || [];
  rec('PM6e', '店员（store_staff，B店 11，绑人=李四）看批次工资条：200 且**只有自己 1 行**'
    + '（emp=2），不是全店 —— "所有人只看自己"对最低岗位同样成立',
    r.status === 200 && rows.length === 1 && Number(rows[0].employee_id) === 2,
    `${r.status} / ${rows.length} 行 emp=${rows.map((x) => x.employee_id).join(',') || '—'}`);
}

// ============================================================================
// 7f. PM6f · 没绑人的账号：0 行，而不是 403
// ----------------------------------------------------------------------------
// "你没有工资条"与"你没权限"是两件事：
//   · 403 会让人去查权限配置（而权限是对的）；
//   · 0 行才是真相：这个账号背后没有人。
// ★ 系统账号（admin 类）就是这种形态 —— 它们不该有"自己的工资条"。
// ============================================================================
{
  const { hashPassword } = await import('../app/services/auth.mjs');
  const NP = 9105;
  await db.query(`INSERT INTO sys_data_scope(id,name,combinator)
                  VALUES ($1,'账号:pm_noperson','intersection')`, [NP]);
  await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                    ($1,'cost_org','node_subtree',ARRAY[10]::bigint[]),
                    ($1,'payroll_legal_entity','nodes',ARRAY[1]::bigint[])`, [NP]);
  // 同一个 store_mgr 角色（有 payslip 读），但**不建 sys_account 行** = 没绑人
  await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,
                                            grant_kind,grant_reason,effective_from)
                  VALUES ($1,$1,16,$1,'ROLE','perm-matrix PM6f：账号未绑人',current_date)`, [NP]);
  await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
    [NP, hashPassword(PWD)]);
  const l = await loginAs(NP);
  const tok = l.body?.token || null;
  const r = await get('/api/payroll/slips?run=1', tok);
  const rows = r.body?.rows || [];
  rec('PM6f', '账号没绑人（有 payslip 读权限，但 sys_account 无人）：'
    + '/api/payroll/slips 返回 200 + **0 行**，不是 403 —— '
    + '"你没有工资条"和"你没权限"是两件事（fn_my_person 为 NULL）',
    r.status === 200 && rows.length === 0,
    `${r.status} / ${rows.length} 行${r.body?.error ? ' error=' + r.body.error : ''}`);
}

// ============================================================================
// 8. PM7 · 会话不残留：先用集团HR 灌满，紧接着用无授权账号拉同一个接口
// ----------------------------------------------------------------------------
// 判据：与"该账号单独拉"逐字一致（status + 行数）。★ M7 只验过花名册，
// 这里验三个：花名册（employee_roster）、工资条（payslip）、考勤异常（attendance_daily）。
// ============================================================================
{
  const probes = [
    { k: 'payslip', who: 3 },
    { k: 'att/exceptions', who: 3 },
    { k: 'employees', who: 2 },   // 换一个"200 但行数不同"的格子：1 行 vs 3 行
  ];
  const detail = [];
  let allOk = true;
  for (const { k, who } of probes) {
    const solo = { status: C(k, who).status, rows: C(k, who).rows };
    const ep = EP.find((e) => e.k === k);
    await get(ep.path, tokens[1]);             // 集团HR 先灌满
    const after = await get(ep.path, tokens[who]);
    const cmp = { status: after.status, rows: rowsOf(ep.kind, after) };
    const same = solo.status === cmp.status && solo.rows === cmp.rows;
    if (!same) allOk = false;
    detail.push(`${k}→user${who}: 单独 ${solo.status}/${solo.rows} vs 紧随集团HR ${cmp.status}/${cmp.rows}`);
  }
  rec('PM7', '会话不残留：集团HR 拉完紧接另一个角色拉同一接口，结果必须与"单独拉"一致'
    + '（三个接口：payslip / att/exceptions / employees）',
    allOk, detail.join(' '));
}

// ============================================================================
// 9. PM8 · 行闸一致性：凡是"按人"给数据的接口，看到的人必须 ⊆ 花名册
// ----------------------------------------------------------------------------
// ★ 这是 people.mjs 文件头自己立的规矩："另开一条看人的判据，就会出现
//   '花名册看得到、点进去看不到考勤'"。反过来的漂移是：某接口压根没走行闸，
//   于是花名册 1 人、它给你 3 人。本组就是量这一点。
// ★ declare 不参与：它是**按法人**出的申报表，行闸维度是 payroll_legal_entity
//   （A店HR 被授了法人 1，所以整张表可见是设计如此，不是漂移）。
// ============================================================================
{
  const allowed = new Set(R2.map((x) => Number(x.employee_id)));
  const perEmp = [
    { k: 'payslip', pick: (b) => (b.rows || []).map((x) => Number(x.employee_id)) },
    // ★ 批次工资条（/api/payroll/slips）必须一起进这张表：它原来根本没走行闸，
    //   于是"知道 run id 就能看到该批全部人"；而它在矩阵里没有格子，
    //   所以 14 条断言全绿也没发现。
    { k: 'payroll/slips', pick: (b) => (b.rows || []).map((x) => Number(x.employee_id)) },
    { k: 'si/enrollments', pick: (b) => (b.rows || []).map((x) => Number(x.employee_id)) },
    { k: 'hr/contracts', pick: (b) => (b.rows || []).map((x) => Number(x.employee_id)) },
    { k: 'att/exceptions', pick: (b) => (b.rows || []).map((x) => Number(x.employee_id)) },
    { k: 'hr/exit/list', pick: (b) => (b.rows || []).map((x) => Number(x.employee_id)) },
    { k: 'perf', pick: (b) => (b.results || []).map((x) => Number(x.employee_id)) },
  ];
  const extra = [];
  for (const { k, pick } of perEmp) {
    const c = C(k, 2);
    if (c.status !== 200) continue;            // 403 的格子不参与（没有行可看）
    const people = [...new Set(pick(c.body || {}))];
    const out = people.filter((id) => !allowed.has(id));
    if (out.length) extra.push(`${k}=${out.length} 人越界(${out.join(',')})`);
  }
  rec('PM8', `行闸一致性：A店HR 在 200 的接口上看到的每个人，都必须在他的花名册里`
    + `（花名册=${[...allowed].join(',') || '空'}）；越界即"这个接口没走行闸"`,
    extra.length === 0,
    extra.length ? extra.join(' ') : '六个接口全部 ⊆ 花名册');
}

// ============================================================================
// 9b. PM8b · 批次工资条（/api/payroll/slips）的行闸
// ----------------------------------------------------------------------------
// ★ 这条是补的（2026-11 审计），专门钉"同一个数据、两个入口"这件事：
//   /api/payslip 是自己那一行的工资条，PM6b 一直在测它；
//   /api/payroll/slips 是"某个批次里所有人"的工资条 —— 另一条 SQL、另一个入口，
//   而它的 WHERE 当时只有 pay_run_id，没有 scope 过滤。
//   于是：知道 run id 的 A店HR 能看到该批次全部人（跨门店、跨法人），
//   而矩阵里**没有这个格子**，14 条断言全绿。
// ★ 判据不是"行数少于集团HR"，是"看到的人必须都在他的花名册里"（同 PM8 的规矩）：
//   拿总数去比会在换夹具时变成假绿/假红。
// ============================================================================
{
  const allowed2 = new Set(R2.map((x) => Number(x.employee_id)));
  const rows2 = (C('payroll/slips', 2).body?.rows || []).map((x) => Number(x.employee_id));
  const rows1 = (C('payroll/slips', 1).body?.rows || []).map((x) => Number(x.employee_id));
  const leak = rows2.filter((id) => !allowed2.has(id));
  rec('PM8b', '批次工资条（/api/payroll/slips?run=1）：A店HR 看到的每个人都在他的花名册里，'
    + '集团HR 看得到整批 —— 该接口原来没有行闸，知道 run id 就能看到该批全部人',
    leak.length === 0 && rows1.length > 0 && rows2.length > 0 && rows1.length >= rows2.length,
    `集团HR=${rows1.length} 行(${rows1.join(',')})；A店HR=${rows2.length} 行(${rows2.join(',')})；`
    + `花名册=${[...allowed2].join(',') || '空'}；越界=${leak.join(',') || '无'}`);
}

// ============================================================================
// 10. PM9 · 临时口令：约束拦在"请求"这一层，不是拦在登录
// ----------------------------------------------------------------------------
// app/server.mjs:766 —— 登录照常发 token，之后除 /api/me/password 外一律 428。
// 这条要写进断言里，否则下一个人会把"登录成功"当成"约束没生效"。
// ============================================================================
{
  const l5 = ROLES.find((r) => r.u === 5);
  const cells = EP.map((e) => C(e.k, 5));
  const all428 = cells.every((c) => c.status === 428);
  const codes = new Set(cells.map((c) => c.body?.error));
  rec('PM9', '临时口令账号（user5）：登录 200 且拿到 token，但除改密外每个接口都 428 '
    + 'E_PWD_CHANGE_REQUIRED —— 约束实现为"请求级拦截"（server.mjs:766），不是登录即拒',
    l5.loginStatus === 200 && !!l5.token && all428 && codes.size === 1
      && codes.has('E_PWD_CHANGE_REQUIRED'),
    `login=${l5.loginStatus} token=${l5.token ? '有' : '无'} `
    + `9 接口=${cells.map((c) => c.status).join(',')} error=${[...codes].join(',')}`);
}

// ============================================================================
// 11. PM2b · 组织继承链：user4 的数据面必须与 A店HR 同形
// ----------------------------------------------------------------------------
// user4 在 sys_user_role 里**一行都没有**，权限全部来自 sys_user_org(4→10) +
// sys_org_grant(30→role2/scope200)。若继承链断了，这一格会变成 0 行。
// ============================================================================
{
  const r4 = C('employees', 4).body?.rows || [];
  const same = r4.length === R2.length
    && r4.every((x) => Number(x.org_id) === 10)
    && r4.some((x) => Number(x.employee_id) === 1)
    && r4.find((x) => Number(x.employee_id) === 1)?.national_id === null;
  rec('PM2b', '组织继承（user4：A店 → 华东区被授权）：花名册与 A店HR 同形 —— 同样 1 行、'
    + 'org_id=10、身份证同样被掩码（字段策略只看直接角色，继承来的角色不给字段放宽）',
    C('employees', 4).status === 200 && same,
    `user4=${C('employees', 4).status}/${r4.length} 行 A店HR=${R2.length} 行 `
    + `user4 的 employee_id=${r4.map((x) => x.employee_id).join(',')} `
    + `身份证=${r4.find((x) => Number(x.employee_id) === 1)?.national_id ?? 'null'}`);
}

// ============================================================================
// 12. PM10 · 老板只读：写全拒、读全通
// ----------------------------------------------------------------------------
// ★ 三处说法原来是打架的：063 的描述写"全局只读"，073 用 CROSS JOIN 把老板改成
//   "业务全权"，seed-chain 的注释写"老板点算薪应该被拒"。最后生效的是 073，
//   所以第三条一直是空话。
// ★ 真实形态不是"老板算不了薪"，而是**他被拒的理由是错的**：实测他点算薪拿到
//   409「批次已封账」—— 拦他的是封账闸，不是权限。换一期没封账的他就真算了。
//   所以这一条的写侧判据必须匹配 `E_RESOURCE_FORBIDDEN`，**不能只判 `!== 200`**：
//   只判"不是 200"的话，409 会被记成绿 —— 而 409 恰恰是那个假象。
// ★ 读侧同样要钉：只收写不收读。否则下一个人为了"让算薪 403"顺手把读也砍了，
//   老板变成"什么都看不到"，而他该看到全部（只读不是无权）。
//   三处读：工资条（payslip）、组织树（employee_roster）、报表（report）。
// ★ 账号手工造，理由同 PM6d（sys_account 与 sys_user_credential 两个 id 空间不同源）。
//   范围给全集团（根组织 001 的整棵子树），这样"读不到"只可能是权限问题，不是范围问题。
// ============================================================================
{
  const { hashPassword } = await import('../app/services/auth.mjs');
  const BOSS = 9102;
  await db.query(`INSERT INTO sys_data_scope(id,name,combinator)
                  VALUES ($1,'账号:pm_boss','intersection')`, [BOSS]);
  await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                    ($1,'cost_org','node_subtree',ARRAY[1]::bigint[]),
                    ($1,'attendance_org','node_subtree',ARRAY[1]::bigint[]),
                    ($1,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
                    ($1,'si_entity','nodes',ARRAY[1]::bigint[])`, [BOSS]);
  await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,
                                            grant_kind,grant_reason,effective_from)
                  VALUES ($1,$1,(SELECT id FROM sys_role WHERE code='boss'),$1,
                          'ROLE','perm-matrix PM10：老板只读',current_date)`, [BOSS]);
  await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
    [BOSS, hashPassword(PWD)]);
  const l = await loginAs(BOSS);
  const tk = l.body?.token || null;

  const wRun = await postJson('/api/payroll/run?period=2026-03&entity=1', tk, {});
  const rSlip = await get('/api/payroll/slips?run=1', tk);
  const rOrg = await get('/api/org/tree', tk);
  const rRep = await get('/api/report?period=2026-03&org=30', tk);

  // 写侧：必须是权限拒（不是封账 409、也不是 200）
  const writeDenied = wRun.status === 403 && wRun.body?.error === 'E_RESOURCE_FORBIDDEN';
  // 读侧：三个都要通，且读到的行不是空（空也可能意味着 scope 没灌上）
  const readOk = rSlip.status === 200 && (rSlip.body?.rows || []).length > 0
    && rOrg.status === 200 && Array.isArray(rOrg.body?.rows) && rOrg.body.rows.length > 0
    && rRep.status === 200;

  rec('PM10', '老板只读：写全拒、读全通 —— 点算薪 403/E_RESOURCE_FORBIDDEN'
    + '（不是 409「批次已封账」那个假象、也不是 200），'
    + '而工资条/组织树/报表仍然 200',
    writeDenied && readOk,
    `登录=${l.status} 算薪=${wRun.status}/${wRun.body?.error} `
    + `工资条=${rSlip.status}（${(rSlip.body?.rows || []).length} 行）`
    + ` 组织树=${rOrg.status}（${(rOrg.body?.rows || []).length} 节点）`
    + ` 报表=${rRep.status}`);
}

// ============================================================================
// 汇总
// ---------------------------------------------------------------------------
// 11. PM11 · 授权的生效日必须用**系统日**（sys_today，UTC），不是业务日（app_today）
// ---------------------------------------------------------------------------
// 这条是实测抓出来的，不是推的：2026-11-16 00:55（业务日已跨天、UTC 还是 11-15）
// 跑 station-scope，档口长账号全 403 —— 因为夹具把 effective_from 写成了 app_today()，
// 而 fn_role_can 用 sys_today() 判，于是"刚授的权"落在"明天"。
//
// ★ 症状最难查的地方：**谁都没改权限**。只有那 8 小时窗口里新写的授权会失效，
//   过了 08:00 自己就好了 —— 表现成"偶发"。
// ★ 所以判据不看"两个钟今天是否同一天"（那会随跑测试的时刻变红变绿），
//   而是直接钉住**判定依据是系统日**：sys_today() 授的立刻生效、sys_today()+1 的不生效。
{
  const U2 = 9301;
  const { hashPassword } = await import('../app/services/auth.mjs');
  await db.query(`INSERT INTO sys_data_scope(id,name,combinator) VALUES ($1,'账号:pm11','intersection')`,[U2]);
  await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                    ($1,'cost_org','node_subtree',ARRAY[10]::bigint[])`,[U2]);
  await db.query(`INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)`,
    [U2, hashPassword('demo1234')]);
  const can = async () => Boolean((await db.query(
    `SELECT fn_role_can($1,'employee_roster','read') v`,[U2])).rows[0].v);
  const setFrom = async (expr) => {
    await db.query(`DELETE FROM sys_user_role WHERE user_id=$1`,[U2]);
    await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,grant_kind,
                                              grant_reason,effective_from)
                    VALUES ($1,$1,2,$1,'ROLE','PM11',${expr})`,[U2]);
    return can();
  };
  const todaySys = await setFrom('sys_today()');
  const tomorrow  = await setFrom('sys_today() + 1');
  const todayBiz  = await setFrom('app_today()');
  const twoClocks = (await db.query(
    'SELECT app_today() a, sys_today() s')).rows[0];
  const sameDay = String(twoClocks.a).slice(0,10) === String(twoClocks.s).slice(0,10);
  // ★ 只在"业务日已跨天、UTC 还没跨"的 8 小时窗口里，app_today() 授的才会失效。
  //   所以这里不能写死 `todayBiz === true` —— 那会让这条断言随跑测试的时刻变红变绿
  //   （而"随时辰变红的断言"最后一定会被改成 `|| true`）。
  //   正确判据：判定只认系统日 ⇒ 窗口外两写法等价、窗口内 app_today 的必须不生效。
  rec('PM11','授权生效日按**系统日**判：sys_today() 授的立刻生效、sys_today()+1 的不生效；'
    + '窗口内（业务日已跨天、UTC 未跨天）用 app_today() 授的会落成"明天生效"——'
    + '症状是刚给的权限不生效、第二天自己好了，而谁都没改过权限',
      todaySys === true && tomorrow === false && todayBiz === sameDay,
      `系统日=${String(twoClocks.s).slice(0,10)} 业务日=${String(twoClocks.a).slice(0,10)}`
      + `（${sameDay ? '同日，两写法等价' : '跨天窗口内，app_today 授的应当不生效'}）`
      + ` sys_today授=${todaySys} sys_today+1授=${tomorrow} app_today授=${todayBiz}`);
}

// ============================================================================
server.close();

const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;

console.log(`\n夹具（${fixtures.length} 项）：`);
for (const f of fixtures) console.log(`  · ${f}`);

console.log('\n断言：');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}`);
  if (r.note) console.log(`      [${r.note}]`);
}

if (fail) {
  console.log('\n失败项（按接口点名）：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.id}  ${r.note}`);
}

console.log(`\n权限矩阵 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
