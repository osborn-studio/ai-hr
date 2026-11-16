// ============================================================================
// test/station-scope.mjs · 档口范围（182）：厨师长只看自己档口的人
// ----------------------------------------------------------------------------
// 需求原话："要不要让厨师长只看到自己档口的人（现在是能看到整家店）？"
//          → "现在就做"。
//
// 这个文件**只验一件事，但从四个方向验**：能力位到底有没有真的改变结果。
//   ① 开：行数变少（且少的正好是别的档口的人）；
//   ② 关：**立刻**回到全店（证明开关接着线，不是只登记了一行权限）；
//   ③ 认不出档口（跨两档口 / 没授岗）：0 行 —— **不是**全店；
//   ④ 三个读面（花名册 / 考勤 / 排班）是**同一批人**。
//
// ★ 为什么必须在测试里显式做"关掉"这一步（②）：
//   权限类改动最常见的假绿是"给某角色加了能力位 → 断言通过 → 而定语其实没生效"。
//   如果新逻辑写成"没能力位时也不变"，那么开/关都通过的断言根本区分不出这两种实现；
//   只有"关掉之后回到 6 个人"这一条，才能证明那行 DELETE 真的把行为改回去了。
//
// ★ 为什么 ③ 是本次的核心：认不出档口时退回 fn_scope_people 只差一个 IF，
//   而它跑起来不报错、行数还"看起来合理"（整店 6 个人）。这种退回一旦上线，
//   表现为"某个厨师长忽然能看到整店"，且没有任何日志。
//
// ★ 判据口径沿用 perm-matrix：「拒」(403) 与「空」(200 + 0 行) 都是安全答案；
//   **不安全的是 200 且带业务数据**。所以 ③ 只认"0 行"，不要求 403。
// ============================================================================
import { createApp } from '../app/server.mjs';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok: !!ok, note });
const err = (e) => String(e && e.message ? e.message : e).split('\n')[0];

// ★ 这个 env 必须在 createApp 之前设（登录路由读进程环境），与 api.test.mjs 同。
process.env.TRUST_PROXY = '1';
const { server, db } = await createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const PWD = 'demo1234';
const login = async (u) => {
  const r = await fetch(`${BASE}/login?user=${u}&pwd=${encodeURIComponent(PWD)}`, { method: 'POST' });
  return (await r.json()).token || null;
};
const getJson = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const ids = (rows) => rows.map((r) => Number(r.employee_id)).sort((a, b) => a - b);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
// 两个日期口径都要配编制，**这不是为了让断言好看**：
//   花名册/排班按 as_of / from（业务月）判档口，考勤按"今天"判（它没有日期参数）。
//   编制是月粒度的（172），所以两个月份都要有档口编 —— 否则"今天"那个月
//   找不到编制 → 认不出档口 → 0 行，而那不是被测逻辑的错。
const ON = '2026-03-31';          // 花名册的 as_of
const FROM = '2026-03-01';        // 排班周的起点
const CUR = (await one('SELECT to_char(app_today(),\'YYYY-MM\') m')).m;
const PERIOD = '2026-03';

// 档口（172 的词表里就有 WOK / GARNISH，不另造）
const stn = async (code) => Number((await one(
  'SELECT id FROM station WHERE code = $1', [code])).id);
const S_WOK = await stn('WOK');
const S_GARN = await stn('GARNISH');

// 岗位（集团级词表，org 留空）
const mkPos = async (code, name) => Number((await one(
  'SELECT fn_position_upsert($1,$2,NULL::bigint,2::smallint,false,NULL::varchar) id',
  [code, name])).id);
const P_WOK = await mkPos('SC_WOK', '头灶');
const P_GARN = await mkPos('SC_GARN', '打荷');

// A 店(10) 两个档口（走 fn_store_station_enable，判据才验得到）
const ss = async (store, station, from = '2026-01-01') => Number((await one(
  'SELECT fn_store_station_enable($1,$2,$3::date) id', [store, station, from])).id);
const A_WOK = await ss(10, S_WOK);
const A_GARN = await ss(10, S_GARN);

// 编制：炉灶 3、打荷 2（Σ=5 ≤ A 店门店编 12）。两个月各配一份。
const setSp = (ssId, pos, period, hc) => db.query(
  'SELECT fn_sp_set($1,$2,$3,$4,\'hr\',$5)', [ssId, pos, period, hc, '档口定编']);
for (const p of [PERIOD, CUR]) {
  await setSp(A_WOK, P_WOK, p, 3);
  await setSp(A_GARN, P_GARN, p, 2);
}

// 人：张三(1) 是种子里 A 店的人，**故意不给授岗**（他就是"门店里但不在任何档口"的那个人）
await db.query(`INSERT INTO person(id, full_name) VALUES
  (201,'甲一'),(202,'乙二'),(203,'丙三'),(204,'丁四'),(205,'戊五')`);
await db.query(`INSERT INTO employment(id, person_id, legal_entity_id, hire_date) VALUES
  (201,201,1,'2026-01-01'),(202,202,1,'2026-01-01'),(203,203,1,'2026-01-01'),
  (204,204,1,'2026-01-01'),(205,205,1,'2026-01-01')`);
// 两个维度都挂：花名册只认 cost_org，考勤的两个 EXISTS 要 attendance_org
await db.query(`INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from) VALUES
  (201,'cost_org',10,'2026-01-01'),(201,'attendance_org',10,'2026-01-01'),
  (202,'cost_org',10,'2026-01-01'),(202,'attendance_org',10,'2026-01-01'),
  (203,'cost_org',10,'2026-01-01'),(203,'attendance_org',10,'2026-01-01'),
  (204,'cost_org',10,'2026-01-01'),(204,'attendance_org',10,'2026-01-01'),
  (205,'cost_org',10,'2026-01-01'),(205,'attendance_org',10,'2026-01-01')`);

// 授岗：炉灶=甲/乙/丙（丙就是被测的那个档口长），打荷=丁/戊
const assign = (person, pos) => db.query(
  `INSERT INTO person_position(person_id, position_id, valid_from) VALUES ($1,$2,'2026-01-01')`,
  [person, pos]);
for (const p of [201, 202, 203]) await assign(p, P_WOK);
for (const p of [204, 205]) await assign(p, P_GARN);

// 考勤行（列表本身就是"人 × 日"，行闸落在这个 employee_id 上）
await db.query(`INSERT INTO attendance_daily_store
  (id, employee_id, store_id, work_date, shift_start_at, shift_end_at,
   span_hours, on_duty_hours, off_duty_hours, break_on_duty_hours,
   in_attendance_hours, work_hours, snap_on_duty_break_basis) VALUES
  (98201,201,10,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance'),
  (98202,202,10,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance'),
  (98203,203,10,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance'),
  (98204,204,10,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance'),
  (98205,205,10,'2026-03-01','2026-03-01T08:00:00Z','2026-03-01T16:00:00Z',8,8,0,1,7,6,'allowance')`);

// 排班行（周表的"格子"由 schedule 出；行标题 people 另查一次 —— 两处都要被收窄）
await db.query(`INSERT INTO schedule(id, employee_id, work_date, shift_id, store_id)
  SELECT 98200 + v.emp, v.emp, '2026-03-01'::date,
         (SELECT shift_id FROM shift_def WHERE code='EARLY'), 10
    FROM (VALUES (201),(202),(203),(204),(205)) AS v(emp)`);

// 档口长账号：角色 19 = station_chef（182 建的），范围 = A 店，绑人 = 丙三(203)
// ★ 写 19 不写 18：18 号已经被 store_deputy 占了。第一次写这个文件时用的是 18，
//   于是"角色没建出来"被 ON CONFLICT 静默吃掉，症状只是"档口长永远看到整店"。
const { hashPassword } = await import('../app/services/auth.mjs');
const CHEF = 9201;
await db.query(`INSERT INTO sys_data_scope(id,name,combinator)
                VALUES ($1,'账号:sts_chef','intersection')`, [CHEF]);
await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                  ($1,'cost_org','node_subtree',ARRAY[10]::bigint[]),
                  ($1,'attendance_org','node_subtree',ARRAY[10]::bigint[]),
                  ($1,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
                  ($1,'si_entity','nodes',ARRAY[1]::bigint[])`, [CHEF]);
await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,
                                          grant_kind,grant_reason,effective_from)
                VALUES ($1,$1,19,$1,'ROLE','station-scope 验收：档口长',sys_today())`, [CHEF]);
await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
  [CHEF, hashPassword(PWD)]);
await db.query(`INSERT INTO sys_account(id, login, display_name, person_id)
                OVERRIDING SYSTEM VALUE VALUES ($1,'sts_chef','丙三（档口长）',203)`, [CHEF]);

// 第二个档口长账号：**不授岗**（他是"配了能力位、但还没被编到档口"的那个人）
const NOBODY = 9202;
await db.query(`INSERT INTO sys_data_scope(id,name,combinator)
                VALUES ($1,'账号:sts_nobody','intersection')`, [NOBODY]);
await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                  ($1,'cost_org','node_subtree',ARRAY[10]::bigint[]),
                  ($1,'attendance_org','node_subtree',ARRAY[10]::bigint[]),
                  ($1,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
                  ($1,'si_entity','nodes',ARRAY[1]::bigint[])`, [NOBODY]);
await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,
                                          grant_kind,grant_reason,effective_from)
                VALUES ($1,$1,19,$1,'ROLE','station-scope 验收：没授岗的档口长',sys_today())`,
  [NOBODY]);
await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
  [NOBODY, hashPassword(PWD)]);
await db.query(`INSERT INTO sys_account(id, login, display_name, person_id)
                OVERRIDING SYSTEM VALUE VALUES ($1,'sts_nobody','戊五（无授岗）',205)`, [NOBODY]);

const tGroup = await login('1');   // 集团 HR
const tStore = await login('2');   // A 店 HR（legacy_store_hr，范围=本店）
const tChef = await login(CHEF);
const tNobody = await login(NOBODY);
if (!tGroup || !tStore || !tChef || !tNobody) {
  console.error('登录失败', { tGroup: !!tGroup, tStore: !!tStore, tChef: !!tChef, tNobody: !!tNobody });
  process.exit(1);
}

const rosterOf = async (tok, asOf = ON) => {
  const r = await getJson(`/api/employees?as_of=${asOf}`, tok);
  return { ...r, ids: ids(r.body?.rows || []), state: r.body?.station_scope?.state };
};
const attOf = async (tok) => {
  const r = await getJson('/api/attendance', tok);
  return { ...r, ids: ids(r.body?.rows || []), state: r.body?.station_scope?.state };
};
const weekOf = async (tok, store = 10, from = FROM) => {
  const r = await getJson(`/api/roster/week?store=${store}&from=${from}&days=7`, tok);
  return { ...r, ids: ids(r.body?.people || []),
           rowIds: ids(r.body?.rows || []), state: r.body?.station_scope?.state };
};

// 全店基线（A 店 HR，没有能力位）
const baseRoster = await rosterOf(tStore);
const baseAtt = await attOf(tStore);
const baseWeek = await weekOf(tStore);
const STORE_ALL = [1, 201, 202, 203, 204, 205];       // 张三 + 5 人
const WOK = [201, 202, 203];                          // 炉灶档
const GARN = [204, 205];                              // 打荷档

// ---------------------------------------------------------------------------
// STS0 · 没开能力位的人：三个读面与本改动之前**完全一样**
// ---------------------------------------------------------------------------
// 这条先钉住"没接线的地方没被改坏"。它同时也是 STS2（关掉回全店）的对照数。
rec('STS0', 'A 店 HR（无 people_station_scope）三面照旧：花名册 6 人、考勤 6 行、'
  + '排班行标题 6 人、排班格子 5 行；三面的 station_scope.state 都是 off',
  baseRoster.status === 200 && same(baseRoster.ids, STORE_ALL)
  && baseRoster.state === 'off' && baseAtt.state === 'off' && baseWeek.state === 'off'
  && baseAtt.ids.length === 6 && same(baseWeek.ids, STORE_ALL) && baseWeek.rowIds.length === 5,
  `花名册=${baseRoster.ids.join(',')}(${baseRoster.state}) `
  + `考勤=${baseAtt.ids.join(',')}(${baseAtt.state}) `
  + `排班人=${baseWeek.ids.join(',')} 格子=${baseWeek.rowIds.join(',')}(${baseWeek.state})`);

// ---------------------------------------------------------------------------
// STS1 · 开能力位：只剩本档口的人
// ---------------------------------------------------------------------------
const chefRoster = await rosterOf(tChef);
const chefAtt = await attOf(tChef);
const chefWeek = await weekOf(tChef);
rec('STS1a', '档口长（丙三，授岗=炉灶档头灶）打开花名册：只剩炉灶档 3 人'
  + '（甲/乙/丙），张三（本店但不在任何档口）与打荷档 2 人都看不到；state=ok 并带出档口名',
  chefRoster.status === 200 && same(chefRoster.ids, WOK) && chefRoster.state === 'ok'
  && chefRoster.body?.station_scope?.station_code === 'WOK'
  && chefRoster.body?.station_scope?.station_name === '炉灶档',
  `status=${chefRoster.status} rows=${chefRoster.ids.join(',')} `
  + `state=${chefRoster.state} 档口=${chefRoster.body?.station_scope?.station_name}`);
rec('STS1b', '同一角色在考勤上也只剩这 3 人（行数 6→3：少的是张三的 1 行与打荷档的 2 行）',
  chefAtt.status === 200 && same(chefAtt.ids, WOK) && chefAtt.state === 'ok',
  `status=${chefAtt.status} rows=${chefAtt.ids.join(',')} state=${chefAtt.state}`);
rec('STS1c', '同一角色在排班周表上：行标题 6→3、格子 5→3 —— '
  + '**两处同时收窄**（只收一处会出现"标题列着整店的人、格子只有本档口的班"）',
  chefWeek.status === 200 && same(chefWeek.ids, WOK) && chefWeek.rowIds.length === 3
  && chefWeek.state === 'ok',
  `status=${chefWeek.status} 人=${chefWeek.ids.join(',')} 格子=${chefWeek.rowIds.join(',')}`);
rec('STS1d', '三个读面是**同一批人**（花名册 ∩ 考勤 ∩ 排班 = 炉灶档 3 人，且三面集合相同）',
  same(chefRoster.ids, chefAtt.ids) && same(chefRoster.ids, chefWeek.ids),
  `花名册=${chefRoster.ids.join(',')} 考勤=${chefAtt.ids.join(',')} 排班=${chefWeek.ids.join(',')}`);

// ---------------------------------------------------------------------------
// STS2 · ★ 反例：关掉能力位 → 立刻回到全店
// ---------------------------------------------------------------------------
// 这一条证明"开关真的接线"：如果新逻辑是"没有能力位时也不变"之外的实现
// （比如把档口写进了数据范围、或者干脆恒收窄），关掉之后就不会回到 6 人。
{
  await db.query(`DELETE FROM sys_role_resource
                   WHERE role_id = (SELECT id FROM sys_role WHERE code='station_chef') AND resource_code = 'people_station_scope'`);
  const off = await rosterOf(tChef);
  const offWeek = await weekOf(tChef);
  const offState = (await one(
    'SELECT state FROM fn_station_scope($1,$2::date)', [CHEF, ON])).state;

  rec('STS2', '★ 反例：把 people_station_scope 从「档口长」角色上删掉 → 下一次请求'
    + '**立刻**回到全店 6 人（不改代码、不重启、不用重新登录）；'
    + 'fn_station_scope 也回到 off',
    off.status === 200 && same(off.ids, STORE_ALL) && off.state === 'off'
    && same(offWeek.ids, STORE_ALL) && offState === 'off',
    `花名册=${off.ids.join(',')}(${off.state}) 排班人=${offWeek.ids.join(',')} `
    + `fn_station_scope=${offState}`);

  // 还原开关，后面的断言才能继续验"开着"的行为
  await db.query(`INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
                  VALUES ((SELECT id FROM sys_role WHERE code='station_chef'),
                          'people_station_scope',true,false)
                  ON CONFLICT (role_id, resource_code) DO NOTHING`);
  const back = await rosterOf(tChef);
  rec('STS2b', '再开回来 → 又只剩炉灶档 3 人（开关是双向的，不是一次性的）',
    same(back.ids, WOK) && back.state === 'ok',
    `花名册=${back.ids.join(',')}(${back.state})`);
}

// ---------------------------------------------------------------------------
// STS3 · ★ 安全失败：认不出档口 → 0 行，**不是**全店
// ---------------------------------------------------------------------------
{
  // ① 跨档口：给丙三再加一个打荷岗（一人两岗、跨两个档口 —— 172 §6 的常态）
  await db.query(`INSERT INTO person_position(person_id, position_id, valid_from)
                  VALUES (203,$1,'2026-01-01')`, [P_GARN]);
  const amb = await rosterOf(tChef);
  const ambWeek = await weekOf(tChef);
  rec('STS3a', '★ 一人兼两岗跨两个档口 → state=ambiguous，花名册/排班都是 **0 行**；'
    + '既不是 3（随便挑一个档口）也不是 6（退回全店）',
    amb.status === 200 && amb.ids.length === 0 && amb.state === 'ambiguous'
    && ambWeek.ids.length === 0 && ambWeek.state === 'ambiguous',
    `花名册=${amb.ids.length} 行(${amb.state}) 排班人=${ambWeek.ids.length}(${ambWeek.state})`);

  // 还原（撤掉那条打荷岗）
  await db.query(`DELETE FROM person_position
                   WHERE person_id = 203 AND position_id = $1`, [P_GARN]);

  // ② 没授岗：账号绑了戊五(205)，但 205 在打荷档……为了让"没授岗"真的是没授岗，
  //    这里改绑一个**本店但没授岗**的人：张三(1)。
  await db.query(`UPDATE sys_account SET person_id = 1 WHERE id = $1`, [NOBODY]);
  const none = await rosterOf(tNobody);
  const noneAtt = await attOf(tNobody);

  // ★ 同一份账号在**关掉能力位**之后必须能回到全店 —— 否则"0 行"到底是
  //   "安全失败"还是"这个人本来就没权限"就分不清了。这是 ③ 的对照。
  await db.query(`DELETE FROM sys_role_resource
                   WHERE role_id = (SELECT id FROM sys_role WHERE code='station_chef') AND resource_code = 'people_station_scope'`);
  const noneOff = await rosterOf(tNobody);

  rec('STS3b', '★ 配了能力位但推不出档口（绑的人没有授岗）→ state=no_station、**0 行**；'
    + '同一账号关掉能力位后能拿到全店 6 人（证明 0 行是收窄的结果，不是没权限）',
    none.status === 200 && none.ids.length === 0 && none.state === 'no_station'
    && noneAtt.ids.length === 0
    && same(noneOff.ids, STORE_ALL) && noneOff.state === 'off',
    `开=${none.ids.length} 行(${none.state}) 考勤=${noneAtt.ids.length} `
    + `关=${noneOff.ids.length} 行(${noneOff.state})`);

  // 还原开关与绑定
  await db.query(`INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
                  VALUES ((SELECT id FROM sys_role WHERE code='station_chef'),
                          'people_station_scope',true,false)
                  ON CONFLICT (role_id, resource_code) DO NOTHING`);
  await db.query(`UPDATE sys_account SET person_id = 205 WHERE id = $1`, [NOBODY]);
}

// ---------------------------------------------------------------------------
// STS4 · 集团 HR / 薪酬专员 / 总经理不受影响
// ---------------------------------------------------------------------------
// 他们本来就该看全：这三位没有 people_station_scope，走的是 fn_scope_people 那一支。
// ★ 同时钉住一个**坑**：fn_role_can 对超级角色恒真（063:117-121）。
//   若 fn_station_scope 不显式排除 super，超级管理员会被这套"收窄"能力悄悄上锁 ——
//   他从来没被授过这条权限。这里用 fn_station_scope 直接验。
{
  const g = await rosterOf(tGroup);
  const gAtt = await attOf(tGroup);
  const superState = (await one(
    `SELECT state FROM fn_station_scope(
       (SELECT user_id FROM sys_user_role ur JOIN sys_role r ON r.id = ur.role_id
         WHERE r.is_super LIMIT 1), $1::date)`, [ON])).state;

  rec('STS4', '集团 HR 打开花名册：state=off，仍然看得到全集团的人'
    + '（含张三与打荷档的丁四 —— 他们都不在同一个"档口"里）；考勤同样 off',
    g.status === 200 && g.state === 'off' && g.ids.includes(204) && g.ids.includes(203)
    && gAtt.state === 'off',
    `花名册=${g.ids.length} 人(${g.state}) 考勤=${gAtt.ids.length} 行(${gAtt.state})`);
  rec('STS4b', '超级角色即便**没被授** people_station_scope 也判 off'
    + '（fn_role_can 对 super 恒真 → 收窄型能力位必须显式排除 super，否则等于给管理员上锁）',
    superState === 'off' || superState === undefined,
    `fn_station_scope(super)=${superState ?? '（本库没有 super 账号，跳过）'}`);
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
