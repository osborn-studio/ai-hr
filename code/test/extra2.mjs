// ============================================================================
// test/extra2.mjs · 190/191/192：花名册再扩 + 证照台账 + MPF 账号
// ----------------------------------------------------------------------------
// 这个文件验的是"**新的列/表真的接上线了**"，不是"对象存在"：
//   E1 新列可写可读（英文名 / job_title / 时薪）
//   E2 时薪为空 → 花名册返回 **null 而不是 0**（"不计时薪"≠"时薪 0 元"）
//   E3 法定假 / 年假余额来自**既有台账**（不是新开一张余额表）：
//      没授予过 = null（没维护），授予后有数，函数与 v_leave_balance 同口径
//   E4 418/468：**未实现**，恒为 null（未判定）—— 不许有近似值
//   E5 证照到期：90 天内的能筛出；已过期的不混进来；离职者的不算
//   E6 MPF 缺失清单：只含在职 ≥60 天且 <65 岁、确实没有账号的人；离职者不算
//   E7 ★ 加这些列/表之后**花名册行数不变**：一个人多本证照、两个 MPF 计划
//      都不许把名单放大（行数就是"员工总数"，也是各报表的分母）
//   E8 job_title 是自由文本，不是 position 外键（写一个词表里没有的写法也要能存）
//   E9 耦合检查：证照/MPF/时薪**没有**被任何算薪函数引用（docs/44 的口径）
//
// ★ 与 station-scope.mjs 同一套写法：createApp 起一个**全新建库**的实例，
//   走 HTTP 验服务层，走 db.query 验库层。
// ============================================================================
import { createApp } from '../app/server.mjs';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok: !!ok, note });
const err = (e) => String(e && e.message ? e.message : e).split('\n')[0];

const { server, db } = await createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

// 登录（种子口令 demo1234；身份 1 = 集团 HR，范围最全）
const login = async (u) => {
  const r = await fetch(`${BASE}/login?user=${u}&pwd=demo1234`, { method: 'POST' });
  return (await r.json()).token || null;
};
const getJson = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};

const TODAY = (await one('SELECT app_today() d')).d;                 // Date 对象
const ymd = (v) => (v === null || v === undefined ? null
  : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));
const T = ymd(TODAY);
const addDays = (n) => { const d = new Date(TODAY.getTime()); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10); };

const roster = async (asOf) => {
  await db.query('SELECT app_begin_scope($1,$2,$3)', [1, 'employee_roster', null]);
  return q('SELECT * FROM fn_emp_roster($1::date)', [asOf]);
};

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
// 201 在岗、无 MPF、证件：签证 +30 天到期（该查到）、护照 +200 天（不该查到）、
//     身份证已过期 -5 天（不该混进"将到期"）
// 202 已离职（离职日已过）→ 证照与 MPF 都不该出现在清单里
// 203 新入职 10 天（<60 天）→ MPF 不该催
// 204 1950 年生（>65 岁）→ MPF 免供
// 205 已有 active MPF 账号 → 不算缺失
await db.query(`INSERT INTO person(id, full_name) VALUES
  (201,'甲一'),(202,'乙二'),(203,'丙三'),(204,'丁四'),(205,'戊五')`);
await db.query(`INSERT INTO employment(id, person_id, legal_entity_id, hire_date, leave_date) VALUES
  (201,201,1,'2026-01-01',NULL),
  (202,202,1,'2025-01-01','2026-06-30'),
  (203,203,1,$1::date,NULL),
  (204,204,1,'2025-01-01',NULL),
  (205,205,1,'2025-01-01',NULL)`, [addDays(-10)]);
await db.query(`INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from) VALUES
  (201,'cost_org',10,'2026-01-01'),(202,'cost_org',10,'2025-01-01'),
  (203,'cost_org',10,$1::date),(204,'cost_org',10,'2025-01-01'),(205,'cost_org',10,'2025-01-01')`,
  [addDays(-10)]);
// 生日：204 是 1950 年（从身份证派生，与花名册同一条口径）
await db.query(`INSERT INTO person_profile(person_id, profile_type, profile_value) VALUES
  (204,'national_id','310101195001011234')`);

// ---------------------------------------------------------------------------
// E1 · 新列可写可读（英文名 / job_title / 时薪）
// ---------------------------------------------------------------------------
await db.query(`UPDATE person SET english_name='Mike Cheung', job_title='AM兼支配人' WHERE id=1`);
await db.query(`UPDATE employment SET hourly_rate=78.50 WHERE id=1`);
{
  const rows = await roster(T);
  const a = rows.find((r) => Number(r.employee_id) === 1);
  rec('E1', 'person.english_name / person.job_title / employment.hourly_rate 写进去之后，'
    + '花名册直接读得到（时薪 78.50，不是字符串也不是分）',
    a && a.english_name === 'Mike Cheung' && a.job_title === 'AM兼支配人'
    && Number(a.hourly_rate) === 78.5,
    `${a && a.english_name} / ${a && a.job_title} / ${a && a.hourly_rate}`);
}

// ---------------------------------------------------------------------------
// E2 · 时薪为空 → null，不是 0
// ---------------------------------------------------------------------------
{
  const rows = await roster(T);
  const b = rows.find((r) => Number(r.employee_id) === 2);
  rec('E2', '月薪人员（没录时薪）的 hourly_rate 是 **null**，不是 0 —— '
    + '0 会在页面上读成"时薪 0 元"，而真实含义是"这个人不计时薪"',
    b && b.hourly_rate === null && b.hourly_rate !== 0,
    `employee 2 hourly_rate=${b && JSON.stringify(b.hourly_rate)} (typeof ${typeof (b && b.hourly_rate)})`);
}

// ---------------------------------------------------------------------------
// E3 · 法定假余额：复用既有台账（leave_grant / leave_usage / v_leave_balance）
// ---------------------------------------------------------------------------
{
  // ★ 用 201 验"从没授予过"：种子里张三(1) 已经有年假额度，"没维护过"验不出来。
  const before = (await roster(T)).find((r) => Number(r.employee_id) === 201);
  const beforeNulls = before
    && before.stat_holiday_available === null && before.annual_leave_available === null;

  // 授予 14 天法定假 + 用掉 2 天（走**已有**的两张台账表，不建新表）
  const typeId = Number((await one(
    `SELECT id FROM leave_type WHERE code = 'STATUTORY_HOLIDAY'`))?.id);
  await db.query(`INSERT INTO leave_grant(employee_id, leave_type_id, qty, valid_from)
                  VALUES (201,$1,14,$2::date)`, [typeId, '2026-01-01']);
  await db.query(`INSERT INTO leave_usage(employee_id, leave_type_id, qty, state)
                  VALUES (201,$1,2,'used')`, [typeId]);

  const after = (await roster(T)).find((r) => Number(r.employee_id) === 201);
  // 同一口径：v_leave_balance 与 fn_leave_available_at 必须给同一个数
  const view = (await one(
    `SELECT available FROM v_leave_balance WHERE employee_id=201 AND leave_type_id=$1`, [typeId]));
  const fn = (await one(
    `SELECT fn_leave_available_at(201,$1,app_today()) v`, [typeId]));
  // 种子里张三(1) 有年假额度：两处（视图 / 函数）必须一致
  const annualId = Number((await one(`SELECT id FROM leave_type WHERE code='ANNUAL'`)).id);
  const annualView = (await one(
    `SELECT available FROM v_leave_balance WHERE employee_id=1 AND leave_type_id=$1`, [annualId]));
  const annualFn = (await one(
    `SELECT fn_leave_available_at(1,$1,app_today()) v`, [annualId]));

  rec('E3', '法定假余额来自**既有台账**：没授予过时是 null（"没维护过额度"，'
    + '不是 0 = "已用完"）；授予 14 天、用掉 2 天后花名册读到 12；'
    + '没授予的假种（年假）仍是 null；且 fn_leave_available_at 与 v_leave_balance 同口径'
    + '（法定假 12=12，年假也两边相等）',
    beforeNulls && after && Number(after.stat_holiday_available) === 12
    && Number(view.available) === 12 && Number(fn.v) === 12
    && after.annual_leave_available === null
    && Number(annualView.available) === Number(annualFn.v),
    `授予前=${before && JSON.stringify(before.stat_holiday_available)} `
    + `授予后=${after && after.stat_holiday_available} 视图=${view && view.available} `
    + `函数=${fn && fn.v} 年假=${after && JSON.stringify(after.annual_leave_available)} `
    + `年假视图/函数=${annualView && annualView.available}/${annualFn && annualFn.v}`);
}

// ---------------------------------------------------------------------------
// E4 · 418/468：未实现，恒为 null
// ---------------------------------------------------------------------------
{
  const rows = await roster(T);
  const allNull = rows.length > 0 && rows.every((r) => r.continuous_employment === null);
  rec('E4', '418/468 连续雇佣判定**未实现**（docs/42 与 docs/44 都只有列名、无计算式）：'
    + '花名册的 continuous_employment 恒为 null = "未判定"。'
    + '★ null 不代表"不满足"，**不要**在服务层用别的字段拼近似值',
    allNull, `花名册 ${rows.length} 行的 continuous_employment 全为 null=${allNull}`);
}

// ---------------------------------------------------------------------------
// E5 · 证照到期（191）：90 天内能筛出，已过期/离职的不混进来
// ---------------------------------------------------------------------------
await db.query(`INSERT INTO person_document(person_id, doc_type, doc_no, issue_date, expiry_date, issuing_country, created_by) VALUES
  (201,'visa','V-201-1','2025-01-01',$1::date,'HK','hr'),
  (201,'passport','P-201-1','2020-01-01',$2::date,'CN','hr'),
  (201,'id_card','ID-201-1','2015-01-01',$3::date,'HK','hr'),
  (202,'visa','V-202-1','2025-01-01',$4::date,'HK','hr')`,
  [addDays(30), addDays(200), addDays(-5), addDays(30)]);
{
  const d90 = await q('SELECT * FROM fn_documents_expiring(90)');
  const mine = d90.filter((r) => Number(r.person_id) === 201);
  const leaver = d90.filter((r) => Number(r.person_id) === 202);
  const d365 = await q('SELECT * FROM fn_documents_expiring(365)');
  const hasPassport = d365.some((r) => r.doc_no === 'P-201-1');

  rec('E5', 'fn_documents_expiring(90) 只筛出 90 天内到期的那一本（签证 +30 天，'
    + 'days_left=30）：护照（+200 天）与已过期 5 天的身份证都不在；'
    + '已离职的乙二（+30 天）也不在（离职者的证件不需要续）；'
    + '放到 365 天时护照才会出现',
    mine.length === 1 && mine[0].doc_no === 'V-201-1' && Number(mine[0].days_left) === 30
    && leaver.length === 0 && !d90.some((r) => r.doc_no === 'ID-201-1') && hasPassport,
    `90天清单=${d90.map((r) => `${r.doc_no}(${r.days_left})`).join(',') || '空'} `
    + `离职者=${leaver.length} 365天含护照=${hasPassport}`);
}

// ---------------------------------------------------------------------------
// E6 · MPF 缺失清单（192）：在职 ≥60 天、<65 岁、确实没有账号
// ---------------------------------------------------------------------------
await db.query(`INSERT INTO mpf_account(person_id, scheme_name, account_no, join_date, status) VALUES
  (205,'示例强积金计划','MPF-205','2025-04-01','active')`);
{
  const miss = await q('SELECT * FROM fn_mpf_missing()');
  const ids = miss.map((r) => Number(r.person_id));
  const has = (x) => ids.includes(x);
  rec('E6', 'fn_mpf_missing()：甲一(201) 在职 ≥60 天、无账号 → 在清单里；'
    + '乙二(202) 已离职 → **不在**；丙三(203) 入职 10 天（<60 天免供）→ 不在；'
    + '丁四(204) 1950 年生（>65 岁免供）→ 不在；戊五(205) 已有 active 账号 → 不在。'
    + '豁免口径照 docs/44 的 CK19–CK20，不是本仓发明的',
    has(201) && !has(202) && !has(203) && !has(204) && !has(205),
    `清单=${ids.join(',') || '空'}`);

  // 重复入职（两段）也不许让同一个人出现两次 —— 清单是要拿去催办的
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  rec('E6b', '缺失清单里同一个人只出现一次（多段任职不会重复催办）', dup.length === 0,
    `重复=${dup.join(',') || '无'}`);
}

// ---------------------------------------------------------------------------
// E7 · ★ 加表之后花名册行数不变（一个人多本证照 / 两个 MPF 计划不许翻行）
// ---------------------------------------------------------------------------
{
  const before = await roster(T);
  const beforeIds = before.map((r) => Number(r.employee_id)).sort((a, b) => a - b);

  // 再给 201 加一本证照 + 第二个 MPF 计划（同一个人、不同计划/不同号）
  await db.query(`INSERT INTO person_document(person_id, doc_type, doc_no, expiry_date)
                  VALUES (201,'passport','P-201-2',$1::date)`, [addDays(50)]);
  await db.query(`INSERT INTO mpf_account(person_id, scheme_name, account_no, status)
                  VALUES (201,'另一个强积金计划','MPF-201-B','active')`);

  const after = await roster(T);
  const afterIds = after.map((r) => Number(r.employee_id)).sort((a, b) => a - b);
  const unique = new Set(afterIds).size === afterIds.length;

  rec('E7', '给同一个人加第二本证照、第二个 MPF 计划之后，花名册**行数与人员集合完全不变**'
    + '（证照/MPF 刻意不 join 进 fn_emp_roster：一个人多本证照会把名单放大，'
    + '而"员工总数"是各报表的分母，放大不会报错）',
    before.length === after.length && unique
    && beforeIds.length === afterIds.length
    && beforeIds.every((v, i) => v === afterIds[i]),
    `之前 ${before.length} 行 / 之后 ${after.length} 行；唯一员工=${new Set(afterIds).size}；`
    + `id 集合一致=${beforeIds.every((v, i) => v === afterIds[i])}`);
}

// ---------------------------------------------------------------------------
// E8 · job_title 是自由文本，不是 position 外键
// ---------------------------------------------------------------------------
{
  const fks = await q(
    `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (con.conkey)
      WHERE con.contype = 'f' AND c.relname = 'person' AND a.attname = 'job_title'`);
  const wrote = await db.query(`UPDATE person SET job_title='门店新叫法（词表外）' WHERE id=2`)
    .then(() => true).catch((e) => err(e));
  rec('E8', 'person.job_title 上**没有外键**：门店写一个词表里没有的岗位名也能存'
    + '（写成外键的话，那人那天整条花名册导入会失败）；它只是"名片上的岗位"，'
    + '与 position 档案（有编码/有效期/授岗/编制）不是一回事',
    fks.length === 0 && wrote === true,
    `外键=${fks.map((f) => f.conname).join(',') || '无'} 写入=${wrote}`);
}

// ---------------------------------------------------------------------------
// E9 · 耦合检查：这三样都不进算薪（docs/44 的口径）
// ---------------------------------------------------------------------------
{
  const { n: nHourly } = await one(
    `SELECT count(*)::int n FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND prosrc ~ 'hourly_rate'
        AND (proname ~ 'pay|salary|payslip|si_|mpf|gross|net')`);
  const { n: nDoc } = await one(
    `SELECT count(*)::int n FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND prosrc ~ 'person_document'
        AND (proname ~ 'pay|salary|payslip|si_|mpf|gross|net')`);
  const { n: nMpf } = await one(
    `SELECT count(*)::int n FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND prosrc ~ 'mpf_account'
        AND proname ~ 'pay|salary|payslip|si_|gross|net'`);
  rec('E9', '时薪 / 证照 / MPF 账号**没有被任何算薪函数引用**（docs/44：这三样与算薪无耦合）。'
    + '接进去的那天，"资料没录全"就会变成"钱算错"，而算错的钱是要补的',
    nHourly === 0 && nDoc === 0 && nMpf === 0,
    `hourly_rate→算薪 ${nHourly} 处 / person_document→算薪 ${nDoc} 处 / mpf_account→算薪 ${nMpf} 处`);
}

// ---------------------------------------------------------------------------
// E10 · 走 HTTP：服务层把空串归一成 null（页面上一格空白 vs "—" 不一样）
// ---------------------------------------------------------------------------
{
  const tk = await login('1');
  await db.query(`UPDATE person SET english_name='' WHERE id=2`);
  const r = await getJson(`/api/employees?as_of=${T}`, tk);
  const b = (r.body?.rows || []).find((x) => Number(x.employee_id) === 2);
  rec('E10', '接口层：英文名存成空串时返回 **null**（不是 ""）—— '
    + '"" 在页面上是空白格、null 是"—"，"没录"必须只有一种表示',
    r.status === 200 && b && b.english_name === null,
    `status=${r.status} english_name=${b && JSON.stringify(b.english_name)}`);
}

// ===========================================================================
// 汇总
// ===========================================================================
let bad = 0;
for (const r of results) {
  if (!r.ok) bad++;
  console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.what}`);
  if (r.note) console.log(`    ${r.note}`);
}
console.log(`\n${results.length - bad}/${results.length} 通过`);
await new Promise((r) => server.close(r));
process.exit(bad === 0 ? 0 : 1);
