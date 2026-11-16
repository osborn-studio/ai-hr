// ============================================================================
// test/multi-org.mjs · 多门店 + 多法人 横向验收（数据不串 / 权限不串 / 输出不串）
// ----------------------------------------------------------------------------
// lifecycle.mjs 验的是**一个人**的完整链路，但那条链上只有一个法人、一家店。
// 连锁客户的真实形态是：一个集团下多家公司（法人）、多家门店，各自出各自的
// 工资单。这条路上一旦串了，错误形态不是报错，而是
//
//     「B 公司的工资单里出现了 A 公司的人」
//
// —— 不报错、不告警，只在发钱那天被发现，而那时钱已经出去了。
//
// 所以这个文件只做一件事：造两个法人、两家门店、两个人，让两边各自跑完
// 开主档 → 建合同 → 签合同 → 算薪 → 打工资单，然后把该相等的、该互斥的
// 数摆在一起对。
//
// ★ 三条自我约束（与 lifecycle 一致）：
//   ① **业务动作只走接口**：法人主档、证件档案、合同、算薪、打印都走 HTTP。
//   ② **夹具可以写库**：组织树 / 人 / 任职 / 归属 / 月薪标准没有"多法人"
//      场景下的写入入口（招人那条链一个人一条，不适合批量造两家公司的员工），
//      这属于"数据从哪来"，不是"流程通不通"。每一处夹具都注明绕了哪一环。
//   ③ **对不上就照实红**：不改宽判据、不改期望值去迁就实现。
//
// ★ 两个反复踩过的坑，本文件统一过一层：
//   · date 列回来是 Date 对象，`String(d).slice(0,10)` 得到的是 "Tue Jun 30"
//     而不是 "2026-06-30" —— 比日期一律走 day()。
//   · numeric 回来可能是字符串（"8000.00"），比金额一律走 money()（toFixed(2)）。
// ============================================================================
import { createApp } from '../app/server.mjs';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok, note });

process.env.TRUST_PROXY = '1';
const { server, db } = await createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const PWD = 'demo1234';
const login = async (u, pwd = PWD) => {
  const r = await fetch(`${BASE}/login?user=${u}&pwd=${encodeURIComponent(pwd)}`, { method: 'POST' });
  return (await r.json()).token;
};
const get = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};
const post = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};
const postJson = async (path, token, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};
const rows = async (sql, params) => (await db.query(sql, params)).rows;

// 日期 / 金额统一口径（见文件头两条坑）
const day = (v) => (v === null || v === undefined ? null
  : new Date(v instanceof Date ? v.getTime() : String(v)).toISOString().slice(0, 10));
const money = (v) => Number(v || 0).toFixed(2);

// ---------------------------------------------------------------------------
// 三个维度：法人 / 门店 / 人。**一律用没人占过的号段**
// ---------------------------------------------------------------------------
// 动手前查过：901/902 在 test/run.mjs 里只作请假单与考勤行 id 出现，
// 从未作为 legal_entity.id；1201/1202、11201/11202 在 test/ 与 db/ 里一次都没出现。
const ENT_SH = 901; const ENT_SZ = 902;          // 法人
const ORG_SH = 20;  const ORG_SZ = 21;           // 门店（成本组织）
const P_SH = 1201;  const P_SZ = 1202;           // person.id
const EMP_SH = 11201; const EMP_SZ = 11202;      // employment.id
const PERIOD = '2026-11';                        // 期别（本仓没有这一期的考勤/绩效，门禁不会误拦）
const HIRE = '2026-01-01';
const CT_FROM = '2026-02-01'; const CT_TO = '2027-01-31';
const SAL_SH = 8000; const SAL_SZ = 9000;
const SH_NAME = '示例餐饮（上海）';
const SZ_NAME = '示例餐饮（苏州）';
const NAME_SH = '周验沪';   // 甲：A 店（上海），法人 901
const NAME_SZ = '吴验苏';   // 乙：B 店（苏州），法人 902

const t1 = await login(1);   // 集团 HR
const t2 = await login(2);   // A 店 HR（组织授权只覆盖 cost_org 10）

// ===========================================================================
// 准备 1 · 法人主档（接口）
// ---------------------------------------------------------------------------
// 合同甲方读 legal_entity（fn_contract_render）；工资单表头**本来也应当读它**，
// 到底读没读由 MO7 验。不先建这两行，合同渲染出来甲方是"法人 #901"，
// 而一份主体不明的合同是要重开的。
// ===========================================================================
const eSH = await postJson('/api/hr/entity', t1, {
  id: ENT_SH, name: SH_NAME, creditCode: '91310101MA1K0SH001',
  address: '上海市黄浦区示例路 88 号', legalRep: '王示沪', stampName: SH_NAME,
});
const eSZ = await postJson('/api/hr/entity', t1, {
  id: ENT_SZ, name: SZ_NAME, creditCode: '91320505MA1K0SZ002',
  address: '苏州市姑苏区示例路 66 号', legalRep: '王示苏', stampName: SZ_NAME,
});

// ===========================================================================
// 准备 2 · 夹具（写库）：门店 / 人 / 任职 / 归属 / 月薪标准 / 工号
// ---------------------------------------------------------------------------
// 为什么绕：
//   · 组织树：本仓没有"建门店"的 HTTP 入口（组织建树走 fn_org_ensure 等库函数，
//     被 tools/ 与迁移调用），多店场景下没有别的办法造两家店；
//   · 人 / 任职 / 归属 / 月薪：唯一的批量入口是招聘→入职链，而那条链一条 offer
//     只能落一个人、且会把岗位与月薪从 offer 带过来。这里要造的是"两个法人下
//     各一名在册员工"，属于数据来源问题，不是流程问题。
// 门店挂在华东区(30)下，仍在集团(1)的子树里 —— 集团 HR 看得见，A 店 HR 看不见。
// ===========================================================================
await db.query(`INSERT INTO org_unit(id,parent_id,name,path) VALUES
                  ($1,30,$3,'001.030.020'), ($2,30,$4,'001.030.021')`, [ORG_SH, ORG_SZ, 'A店（上海）', 'B店（苏州）']);
await db.query(`INSERT INTO person(id,full_name) VALUES ($1,$3), ($2,$4)`,
  [P_SH, P_SZ, NAME_SH, NAME_SZ]);
await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date) VALUES
                  ($1,$3,$5,$7::date), ($2,$4,$6,$7::date)`,
  [EMP_SH, EMP_SZ, P_SH, P_SZ, ENT_SH, ENT_SZ, HIRE]);
await db.query(`INSERT INTO salary_standard(employment_id,monthly_amount,effective_from) VALUES
                  ($1,$3,$5::date), ($2,$4,$5::date)`,
  [EMP_SH, EMP_SZ, SAL_SH, SAL_SZ, HIRE]);
await db.query(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from) VALUES
                  ($1,'cost_org',$3,$5::date), ($2,'cost_org',$4,$5::date)`,
  [P_SH, P_SZ, ORG_SH, ORG_SZ, HIRE]);
// 工号走库函数（编号规则只有一份实现），不手写 employee_no 行
await db.query(`SELECT fn_assign_employee_no($1,'E1201'), fn_assign_employee_no($2,'E1202')`,
  [P_SH, P_SZ]);

// ===========================================================================
// 准备 3 · 维度授权（夹具，**这一条不改，算薪直接 403**）
// ---------------------------------------------------------------------------
// 算薪的维度是 payroll_legal_entity（见 app/services/payroll.mjs:36-38 与
// requireOrg 调用），不是 cost_org。种子只给集团 HR 登记了 entity 1：
//   sys_data_scope_rule(100,'payroll_legal_entity','nodes',{1})
// 所以 901/902 必须显式加进这个范围，否则 /api/payroll/run 回 403 E_OUT_OF_SCOPE，
// 而那个 403 看起来像"权限配错了"，实际是"新法人没进范围" —— 这正是要验的前置。
// ===========================================================================
await db.query(`UPDATE sys_data_scope_rule SET value_ids = ARRAY[1,$1,$2]::bigint[]
                 WHERE data_scope_id = 100 AND dimension = 'payroll_legal_entity'`,
  [ENT_SH, ENT_SZ]);

// ===========================================================================
// 准备 4 · 证件/手机档案（接口）
// ---------------------------------------------------------------------------
// 合同渲染要求乙方证件号与电话非空（fn_contract_render），否则 422
// E_CT_FIELD_MISSING。这一块现在有入口（/api/hr/profile），所以走接口。
// ===========================================================================
const pfSH = await postJson('/api/hr/profile', t1, {
  employeeId: P_SH, nationalId: '310101199001011201', mobile: '13800001201' });
const pfSZ = await postJson('/api/hr/profile', t1, {
  employeeId: P_SZ, nationalId: '320501199202021202', mobile: '13800001202' });

// ===========================================================================
// 准备 5 · 两份合同（接口）：各自挂各自法人，然后各自签
// ===========================================================================
const mk = (employeeId, legalEntityId, jobTitle, workplace, wageAmount, address) => ({
  employeeId, legalEntityId, kind: 'fixed', startDate: CT_FROM, endDate: CT_TO,
  jobTitle, workplace, employeeAddress: address, wageAmount, payDay: 15,
});
const ctSH = await postJson('/api/hr/contract', t1,
  mk(P_SH, ENT_SH, '门店主管', 'A店（上海）', SAL_SH, '上海市黄浦区示例路 88 号 501 室'));
const ctSZ = await postJson('/api/hr/contract', t1,
  mk(P_SZ, ENT_SZ, '门店主管', 'B店（苏州）', SAL_SZ, '苏州市姑苏区示例路 66 号 302 室'));
const CT_SH = Number(ctSH.body && ctSH.body.id) || 0;
const CT_SZ = Number(ctSZ.body && ctSZ.body.id) || 0;
const signSH = CT_SH ? await post(`/api/hr/contract/sign?id=${CT_SH}`, t1) : { status: 0, body: {} };
const signSZ = CT_SZ ? await post(`/api/hr/contract/sign?id=${CT_SZ}`, t1) : { status: 0, body: {} };

// ===========================================================================
// 两个法人各跑一次算薪（接口）
// ---------------------------------------------------------------------------
// 发薪维度是**法人**：run(901) 只该算 legal_entity_id=901 的任职，run(902) 反之。
// 与"人现在挂在哪家店"无关 —— 门店是成本归集，不是发薪主体。
// 期别选 2026-11：本仓没有这一期的考勤与绩效，两个门禁（未封账 / 绩效未封存）
// 都不会误拦，验的就是法人隔离本身。
// ===========================================================================
const runSH = await post(`/api/payroll/run?period=${PERIOD}&entity=${ENT_SH}`, t1);
const runSZ = await post(`/api/payroll/run?period=${PERIOD}&entity=${ENT_SZ}`, t1);
const R_SH = Number(runSH.body && runSH.body.run_id) || 0;
const R_SZ = Number(runSZ.body && runSZ.body.run_id) || 0;

const slipsOf = async (runId) => (runId
  ? (((await get(`/api/payroll/slips?run=${runId}`, t1)).body || {}).rows || []) : []);
const idsOf = (list) => list.map((x) => Number(x.employee_id)).sort((a, b) => a - b);

// ★ 工资条接口只回 employee_id（姓名/工号在 SQL 里取了但没进响应体），
//   所以 note 里的"这是谁"从库里按 id 反查：断言比的是 id，人看得懂的是名字。
const WHO = new Map((await rows(
  `SELECT p.id, p.full_name,
          (SELECT n.no FROM employee_no n
            WHERE n.assigned_person_id = p.id AND n.retired_at IS NULL
            ORDER BY n.assigned_at DESC LIMIT 1) AS no
     FROM person p WHERE p.id = ANY($1::bigint[])`, [[P_SH, P_SZ]])
).map((r) => [Number(r.id), `${r.no || '-'}:${r.full_name}`]));
const whoOf = (list) => list.map((x) => `${WHO.get(Number(x.employee_id)) || '?'}(${x.employee_id})`)
  .join('、') || '(空)';

// ===========================================================================
// MO1 · 发薪主体隔离（★ 本文件最核心的一条）
// ---------------------------------------------------------------------------
// 串了的形态是「B 公司的批次里有 A 公司的人」：不报错，钱照发。
// 所以这一条同时钉两件事：① pay_run 自己挂的法人是哪一个；② 批次里是谁。
// ===========================================================================
{
  const sSH = await slipsOf(R_SH);
  const sSZ = await slipsOf(R_SZ);
  const runRows = await rows(`SELECT id, legal_entity_id, status FROM pay_run
                               WHERE period=$1 ORDER BY id`, [PERIOD]);
  const entOf = (id) => {
    const r = runRows.find((x) => Number(x.id) === id);
    return r ? Number(r.legal_entity_id) : null;
  };
  const iSH = idsOf(sSH); const iSZ = idsOf(sSZ);
  rec('MO1', `法人 ${ENT_SH} 的 pay_run 只有甲、法人 ${ENT_SZ} 的 pay_run 只有乙（互不包含）`,
    runSH.status === 200 && runSZ.status === 200
    && entOf(R_SH) === ENT_SH && entOf(R_SZ) === ENT_SZ
    && iSH.length === 1 && iSH[0] === P_SH
    && iSZ.length === 1 && iSZ[0] === P_SZ,
    `run ${R_SH}=法人${entOf(R_SH)}[${whoOf(sSH)}] | run ${R_SZ}=法人${entOf(R_SZ)}[${whoOf(sSZ)}]；`
    + `本期批次=${runRows.length} 个；算薪 ${runSH.status}/${runSZ.status}`
    + `${runSH.body && runSH.body.error ? ' ' + runSH.body.error : ''}`);
}

// ===========================================================================
// MO2 · 钱对得上：两个批次的应发/实发合计 == 两条发放清单的合计
// ---------------------------------------------------------------------------
// 批次合计（run.gross_total/net_total）与发放清单（paylist）是两条独立的读路径，
// 前者来自 payslip 汇总、后者按行重算。两边不等说明"发给财务的清单"和
// "系统里记的这批钱"不是同一批 —— 财务照清单打款就会多付或少付。
// 再加一条"901 的合计 == 甲个人应发"：只有一个法人的时候，这两者必须相等。
// ===========================================================================
{
  const sSH = await slipsOf(R_SH);
  const sSZ = await slipsOf(R_SZ);
  const plSH = R_SH ? (await get(`/api/payroll/paylist?run=${R_SH}`, t1)).body : {};
  const plSZ = R_SZ ? (await get(`/api/payroll/paylist?run=${R_SZ}`, t1)).body : {};
  const sumGross = (pl) => (pl.rows || []).reduce((a, x) => a + Number(x.gross_amount), 0);

  const gRun = Number((runSH.body || {}).gross_total || 0) + Number((runSZ.body || {}).gross_total || 0);
  const gList = sumGross(plSH) + sumGross(plSZ);
  const nRun = Number((runSH.body || {}).net_total || 0) + Number((runSZ.body || {}).net_total || 0);
  const nList = Number(plSH.total || 0) + Number(plSZ.total || 0);
  const meSH = sSH.find((x) => Number(x.employee_id) === P_SH) || {};

  rec('MO2', `两个 run 的应发合计之和 == 两条 paylist 的应发之和；实发同理；`
    + `且 901 的合计 == 甲个人应发（${money(meSH.gross_amount)}）`,
    R_SH > 0 && R_SZ > 0
    && money(gRun) === money(gList) && money(nRun) === money(nList)
    && money((runSH.body || {}).gross_total) === money(meSH.gross_amount),
    `应发 run 合计=${money(gRun)} / paylist 合计=${money(gList)}；`
    + `实发 run 合计=${money(nRun)} / paylist 合计=${money(nList)}；`
    + `901 批次应发=${money((runSH.body || {}).gross_total)} / 甲个人应发=${money(meSH.gross_amount)}；`
    + `paylist 行数=${(plSH.rows || []).length}/${(plSZ.rows || []).length}`);
}

// ===========================================================================
// MO3 · 打印数据按门店分组，且只含本批次的店
// ---------------------------------------------------------------------------
// 打印数据由库按 cost_org 分组出（不由前端筛）。901 的批次里只有甲 → 只该有
// A 店(20)；如果出现了 B 店(21)，说明"按门店分组"的输入取错了批次。
// ===========================================================================
{
  const prSH = R_SH ? (await get(`/api/payroll/print?run=${R_SH}`, t1)).body : {};
  const prSZ = R_SZ ? (await get(`/api/payroll/print?run=${R_SZ}`, t1)).body : {};
  const orgs = (pr) => (pr.groups || []).map((g) => Number(g.org_id));
  const tag = (pr) => (pr.groups || []).map((g) => `${g.org_name}(${g.org_id})×${g.people.length}`).join('、') || '(空)';
  const oSH = orgs(prSH); const oSZ = orgs(prSZ);
  rec('MO3', `print(run=${R_SH}) 的 groups 里只有 A 店(${ORG_SH})、没有 B 店(${ORG_SZ})；`
    + `print(run=${R_SZ}) 反之`,
    oSH.length === 1 && oSH[0] === ORG_SH && !oSH.includes(ORG_SZ)
    && oSZ.length === 1 && oSZ[0] === ORG_SZ && !oSZ.includes(ORG_SH),
    `run ${R_SH} 分组=${tag(prSH)} | run ${R_SZ} 分组=${tag(prSZ)}`)
}

// ===========================================================================
// MO4 · 合同主体不串：901 的合同甲方是上海公司，902 的是苏州公司
// ---------------------------------------------------------------------------
// 合同上的甲方是**法律主体**，写错就要重开。这里同时看三处：库里的
// legal_entity_id、渲染正文里的甲方名称、以及"另一家的名字没有出现"。
// 顺便钉合同期限：两份合同都从 CT_FROM 到 CT_TO（日期列回来是 Date，
// 必须过 day() 才是 "2026-02-01"，否则会变成 "Sun Feb 01"）。
// ===========================================================================
{
  const gSH = CT_SH ? (await get(`/api/hr/contract?id=${CT_SH}`, t1)).body : {};
  const gSZ = CT_SZ ? (await get(`/api/hr/contract?id=${CT_SZ}`, t1)).body : {};
  const bSH = CT_SH ? String((await get(`/api/hr/contract/render?id=${CT_SH}`, t1)).body.body || '') : '';
  const bSZ = CT_SZ ? String((await get(`/api/hr/contract/render?id=${CT_SZ}`, t1)).body.body || '') : '';
  const pick = (s) => (s.match(/甲方（用人单位）：([^\n]*)/) || [])[1] || '(未取到甲方行)';
  const span = (g) => `${day(g.start_date)}~${day(g.end_date)}`;
  rec('MO4', '两份合同的 legal_entity_id 分别是 901 / 902，且渲染正文的甲方是各自的'
    + '公司名（各自的正文里不出现另一家的名字）',
    Number(gSH.legal_entity_id) === ENT_SH && Number(gSZ.legal_entity_id) === ENT_SZ
    && day(gSH.start_date) === CT_FROM && day(gSZ.start_date) === CT_FROM
    && day(gSH.end_date) === CT_TO && day(gSZ.end_date) === CT_TO
    && bSH.includes(SH_NAME) && !bSH.includes(SZ_NAME)
    && bSZ.includes(SZ_NAME) && !bSZ.includes(SH_NAME),
    `合同 ${gSH.contract_no}/甲方=${gSH.legal_entity_id}/${gSH.entity_name} 期限=${span(gSH)} 正文甲方≈${pick(bSH)} `
    + `| 合同 ${gSZ.contract_no}/甲方=${gSZ.legal_entity_id}/${gSZ.entity_name} 期限=${span(gSZ)} 正文甲方≈${pick(bSZ)}；`
    + `档案 ${pfSH.status}/${pfSZ.status} 签署 ${signSH.status}/${signSZ.status}；`
    + `主档 ${eSH.status}/${eSZ.status}`);
}

// ===========================================================================
// MO5 · 行闸在库里，不在页面上：A 店 HR 看不到这两家新店的人
// ---------------------------------------------------------------------------
// t2 的数据范围是 cost_org 的 nodes{10}（种子），新店 20/21 都不在内。
// 这里同时查集团 HR：如果集团 HR 也看不到，说明"看不到"是夹具没落库，
// 而不是行闸生效 —— 不先证有，就证明不了没有。
// ===========================================================================
{
  const asOf = `${PERIOD}-15`;
  const g1 = await get(`/api/employees?as_of=${asOf}`, t1);
  const g2 = await get(`/api/employees?as_of=${asOf}`, t2);
  const r1 = ((g1.body || {}).rows || []);
  const r2 = ((g2.body || {}).rows || []);
  const ids1 = r1.map((x) => Number(x.employee_id));
  const ids2 = r2.map((x) => Number(x.employee_id));
  const orgs2 = [...new Set(r2.map((x) => Number(x.org_id)))].sort((a, b) => a - b);
  rec('MO5', `A 店 HR（cost_org 只覆盖 org 10）拉花名册看不到 ${P_SH}/${P_SZ}，`
    + `也看不到 20/21 这两家店（集团 HR 能看到，证明行闸而不是夹具）`,
    g1.status === 200 && g2.status === 200
    && ids1.includes(P_SH) && ids1.includes(P_SZ)
    && !ids2.includes(P_SH) && !ids2.includes(P_SZ)
    && !orgs2.includes(ORG_SH) && !orgs2.includes(ORG_SZ),
    `集团HR ${r1.length} 行（含甲=${ids1.includes(P_SH)} 含乙=${ids1.includes(P_SZ)}）；`
    + `A店HR ${g2.status} ${r2.length} 行，门店=${JSON.stringify(orgs2)}`
    + `（含甲=${ids2.includes(P_SH)} 含乙=${ids2.includes(P_SZ)}）`);
}

// ===========================================================================
// MO7 · 工资单打印件的主体：901 的单子上是上海公司，不该出现苏州公司
// ---------------------------------------------------------------------------
// 这张纸会贴到店里、会被拍照转发，也是仲裁时的举证材料。主体写错就要重开。
// 这里按"财务点打印"的真实形态取（不带 company 参数），HTML 由服务端渲染。
// ===========================================================================
{
  const resp = R_SH ? await fetch(`${BASE}/api/payroll/print.html?run=${R_SH}`,
    { headers: { authorization: `Bearer ${t1}` } }) : null;
  const html = resp ? await resp.text() : '';
  const co = (html.match(/<div class="co">([^<]*)<\/div>/) || [])[1] || '(未取到表头)';

  // 旁证：前端"打印"按钮实际会带上 company=帐套/组织名（见 app/index.html 的
  // ME.ledger || ME.org）。集团下面两个法人共用一个帐套名时，两份打印件的表头
  // 就是同一个字符串 —— 打印出来分不出是哪家公司发的钱。
  const hdr = async (run) => {
    const r = await fetch(`${BASE}/api/payroll/print.html?run=${run}&company=${encodeURIComponent('示例餐饮集团')}`,
      { headers: { authorization: `Bearer ${t1}` } });
    return (await r.text()).match(/<div class="co">([^<]*)<\/div>/)?.[1] || '(未取到)';
  };
  const hSH = R_SH ? await hdr(R_SH) : '(未请求)';
  const hSZ = R_SZ ? await hdr(R_SZ) : '(未请求)';

  rec('MO7', `工资单打印件（print.html?run=${R_SH}）里出现「${SH_NAME}」、不出现「${SZ_NAME}」`,
    !!resp && resp.status === 200 && html.includes(SH_NAME) && !html.includes(SZ_NAME),
    `${resp ? resp.status : '(未请求)'} 表头公司名=${co} 长度=${html.length} 字；`
    + `含上海=${html.includes(SH_NAME)} 含苏州=${html.includes(SZ_NAME)}；`
    + `若按前端形态传公司名：901 表头=${hSH} / 902 表头=${hSZ}` + (hSH === hSZ ? '（两份完全相同）' : ''));
}

// ===========================================================================
// MO6 · 跨店支援不改发薪主体
// ---------------------------------------------------------------------------
// 模拟"甲去 B 店支援"：把他 cost_org 归属改成 21（SQL 夹具），再重跑 901 的算薪。
// 发薪维度是法人不是门店 —— 甲仍在 901 的批次里，且 902 的批次里仍然没有他。
// ★ 这条红了只有一种原因：有人把 payroll_legal_entity 与 cost_org 混用了。
// ===========================================================================
{
  await db.query(`UPDATE employee_org_assignment SET org_id=$1
                   WHERE employee_id=$2 AND dim_code='cost_org'`, [ORG_SZ, P_SH]);
  const rerun = await post(`/api/payroll/run?period=${PERIOD}&entity=${ENT_SH}`, t1);
  const R2 = Number(rerun.body && rerun.body.run_id) || 0;
  const sSH2 = await slipsOf(R2);
  const sSZ2 = await slipsOf(R_SZ);
  const asg = (await rows(`SELECT org_id FROM employee_org_assignment
                            WHERE employee_id=$1 AND dim_code='cost_org'`, [P_SH]))[0] || {};
  rec('MO6', `甲的成本归属改成 B 店(${ORG_SZ}) 后重跑 901 的算薪：甲仍在 901 的批次里，`
    + `902 的批次里仍然没有他（发薪看法人，不看门店）`,
    rerun.status === 200 && R2 > 0 && R2 === R_SH
    && idsOf(sSH2).includes(P_SH) && !idsOf(sSH2).includes(P_SZ)
    && !idsOf(sSZ2).includes(P_SH) && idsOf(sSZ2).includes(P_SZ),
    `重跑 ${rerun.status} run=${R2}（首次 run=${R_SH}）；甲 cost_org 现=${asg.org_id}；`
    + `901 批次=[${whoOf(sSH2)}] 902 批次=[${whoOf(sSZ2)}]`);
}

// ===========================================================================
// 收口
// ===========================================================================
server.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n多门店多法人 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
// ★ MO6 会改夹具（把甲的归属挪到 B 店）并重算，所以它在**最后**执行；
//   打印按编号排 —— 执行顺序与编号顺序不同，是为了不让夹具污染前面几条。
for (const r of [...results].sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}${r.note ? `\n          [${r.note}]` : ''}`);
}
console.log('');
process.exit(pass === results.length ? 0 : 1);
