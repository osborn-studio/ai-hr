// ============================================================================
// test/extra1.mjs · 187 / 188 / 189 的验收：撤回签收 / 缺岗开需求 / 外包归属档口
// ----------------------------------------------------------------------------
// 三件事各有一个**最容易做成假绿**的地方，三个断言都朝那里扎：
//
//   ① 撤回签收：最容易写成 `UPDATE payslip_ack SET revoked=true` ——
//      接口返回 200、进度少 1，看起来全对。所以这里钉的是
//      "撤回后那张**回执还在**、acked_at 没变、而有效签收变 false"。
//      只有"回执仍在 + 有效=false"这一对同时成立，才说明撤回是**新增记录**。
//
//   ② 缺岗开需求：最容易写成"跑一次开一批，跑第二次又开一批" ——
//      而重复开的需求不会报错，只会让人多发几个 offer（那是法律承诺）。
//      所以这里跑两次，断言第二次**一条都不开**、且总行数不变。
//      另外钉一条"名额不够时跳过而不是改小"：缺 5 个但门店还能发 3 个时，
//      函数不能把 3 改成 1 —— 那会把一个错数变成一张合法单据。
//
//   ③ 外包归属档口：最容易的错是"顺手把外包加进到岗" ——
//      页面立刻好看（缺岗少了一个），而外包的合同不在我方。
//      所以这里**整表快照比对** fn_station_fill 加外包前后的每一行
//      （含 holders / gap / gap_since）：一个字都不许变。
//
// 用 createApp() 起自己的库（内存 PGlite，迁移全跑一遍），不碰演示库。
// ============================================================================
import { createApp } from '../app/server.mjs';
import { withTx } from '../app/db.mjs';
import { revoke, listRevokes } from '../app/services/payslip-ack-revoke.mjs';
import { gapToRequisition } from '../app/services/recruit-gap.mjs';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok: !!ok, note });

const { server, db } = await createApp();
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

/** 期望抛错，取业务码（形如 E_XXX） */
const codeOf = async (fn) => {
  try { await fn(); return 'NO_ERROR'; } catch (e) {
    const m = /^(E_[A-Z0-9_]+)/.exec(String(e && e.message ? e.message : e));
    return m ? m[1] : String(e && e.message ? e.message : e).split('\n')[0];
  }
};

const ON = '2026-03-31';       // 期末日：档口编与到岗都按这一天判
const PERIOD = '2026-03';

// ---------------------------------------------------------------------------
// 夹具 A · 工资条与签收回执（用种子里的 2 张单：员工 1 在 A 店、员工 2 在 B 店）
// ---------------------------------------------------------------------------
const RUN = Number((await one(
  `SELECT id FROM pay_run WHERE period = $1 AND legal_entity_id = 1`, [PERIOD])).id);
const slips = await q(
  `SELECT id, employee_id FROM payslip WHERE pay_run_id = $1 ORDER BY employee_id`, [RUN]);
const SLIP1 = Number(slips.find((s) => Number(s.employee_id) === 1).id);   // A 店
const SLIP2 = Number(slips.find((s) => Number(s.employee_id) === 2).id);   // B 店

// 两条回执：直接用 SQL 写（本文件测的是**撤回**；签收路径由 186 的断言负责）
await db.query(
  `INSERT INTO payslip_ack(payslip_id, employee_id, pay_run_id, method, acked_by)
   VALUES ($1,1,$3,'web',1), ($2,2,$3,'web',2)`, [SLIP1, SLIP2, RUN]);
const ACK1 = await one(
  'SELECT id, acked_at::text AS at FROM payslip_ack WHERE payslip_id = $1', [SLIP1]);

// ---------------------------------------------------------------------------
// 夹具 B · 两家店的档口与编制
// ---------------------------------------------------------------------------
const stn = async (code) => Number((await one('SELECT id FROM station WHERE code = $1', [code])).id);
const S_WOK = await stn('WOK');
const S_GARN = await stn('GARNISH');
const S_STEW = await stn('STEWARD');
const S_SEA = await stn('SEA');

const mkPos = async (code, name) => Number((await one(
  'SELECT fn_position_upsert($1,$2,NULL::bigint,2::smallint,false,NULL::varchar) id',
  [code, name])).id);
const P_WOK = await mkPos('X1_WOK', '头灶');
const P_GARN = await mkPos('X1_GARN', '打荷');
const P_STW = await mkPos('X1_STW', '洗碗工');
const P_CLN = await mkPos('X1_CLN', '保洁员');

const ss = async (store, station, from = '2026-01-01') => Number((await one(
  'SELECT fn_store_station_enable($1,$2,$3::date) id', [store, station, from])).id);
const A_WOK = await ss(10, S_WOK);
const A_GARN = await ss(10, S_GARN);
const B_STW = await ss(11, S_STEW);
const B_SEA = await ss(11, S_SEA);        // ★ 故意不定编：验证"未定编不产生需求"

const setSp = (ssId, pos, hc) => db.query(
  `SELECT fn_sp_set($1,$2,$3,$4,'hr',$5)`, [ssId, pos, PERIOD, hc, '档口定编']);

// A 店（10）：炉灶 3 / 打荷 2（门店编 12，种子已给）
await setSp(A_WOK, P_WOK, 3);
await setSp(A_GARN, P_GARN, 2);
// B 店（11）：同一个档口两个岗位 3 + 2（门店编 5，到岗 2 人 → 还能发 3 个）
await setSp(B_STW, P_STW, 3);
await setSp(B_STW, P_CLN, 2);

// 到岗：201 站 A 店炉灶岗（炉灶缺 2、打荷缺 2）；202 站 B 店洗碗岗（B 店缺 3 + 2）
await db.query(`INSERT INTO person(id, full_name) VALUES (201,'甲一'),(202,'乙二')`);
await db.query(`INSERT INTO employment(id, person_id, legal_entity_id, hire_date) VALUES
  (201,201,1,'2026-01-01'),(202,202,1,'2026-01-01')`);
await db.query(`INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from) VALUES
  (201,'cost_org',10,'2026-01-01'),(202,'cost_org',11,'2026-01-01')`);
await db.query(`INSERT INTO person_position(person_id, position_id, valid_from) VALUES
  (201,$1,'2026-01-01')`, [P_WOK]);
await db.query(`INSERT INTO person_position(person_id, position_id, valid_from) VALUES
  (202,$1,'2026-01-01')`, [P_STW]);

const fillRows = async (store = 10) => q(
  'SELECT * FROM fn_station_fill($1,$2::date)', [store, ON]);
const progress = async () => one(
  'SELECT slips, acked, pending FROM v_payslip_ack_progress WHERE pay_run_id = $1', [RUN]);

const base = await progress();        // 两张单都已签

// ===========================================================================
// 一 · 187 撤回签收
// ===========================================================================
const doRevoke = (userId, slipId, reason) => withTx(db, (tx) => revoke(tx, { userId, slipId, reason }));

// RV1 · 撤回成功，且**原回执还在**
{
  const r = await doRevoke(1, SLIP1, '员工点错，撤回重签');
  const still = await one(
    `SELECT count(*)::int AS n, max(acked_at)::text AS at
       FROM payslip_ack WHERE payslip_id = $1`, [SLIP1]);
  rec('RV1', '撤回成功，且 payslip_ack 里那条回执**仍在**（不是删了，acked_at 一个字没变）',
    r.revoke_id > 0 && Number(r.payslip_id) === SLIP1
    && Number(still.n) === 1 && still.at === ACK1.at,
    `revoke=${r.revoke_id} 回执=${still.n} 条 原=${ACK1.at} 现=${still.at}`);
}

// RV2 · 状态函数六个字段
{
  const s = await one(
    `SELECT acked, acked_at::text AS acked_at_text, method, revoked,
            revoked_at::text AS revoked_at_text, revoke_reason
       FROM fn_payslip_ack_state($1)`, [SLIP1]);
  rec('RV2', 'fn_payslip_ack_state：acked=false / revoked=true / acked_at 仍是原签收时间 / '
    + 'method 仍是 web / revoke_reason 是写进去的那句',
    !!s && s.acked === false && s.revoked === true
    && s.acked_at_text === ACK1.at && s.method === 'web'
    && s.revoke_reason === '员工点错，撤回重签' && !!s.revoked_at_text,
    `acked=${s?.acked} revoked=${s?.revoked} method=${s?.method} `
    + `原=${ACK1.at} 现=${s?.acked_at_text} 理由=${s?.revoke_reason}`);
}

// RV3 · 有效签收视图不含它
{
  const eff = Number((await one(
    'SELECT count(*)::int n FROM v_payslip_ack_effective WHERE payslip_id = $1', [SLIP1])).n);
  const all = Number((await one(
    'SELECT count(*)::int n FROM payslip_ack WHERE payslip_id = $1', [SLIP1])).n);
  rec('RV3', 'v_payslip_ack_effective 里没有它（有效签收=0），而 payslip_ack 里仍有 1 条 —— '
    + '两张表分别回答"现在有效吗"与"他签过吗"',
    eff === 0 && all === 1, `有效=${eff} 回执=${all}`);
}

// RV4 · 进度：acked 减 1、pending 加 1
{
  const p = await progress();
  rec('RV4', '签收进度 acked 减 1、pending 加 1（撤回后这张单回到"没人认"）',
    Number(p.acked) === Number(base.acked) - 1 && Number(p.pending) === Number(base.pending) + 1,
    `基线 acked=${base.acked}/pending=${base.pending} → 现 acked=${p.acked}/pending=${p.pending}`);
}

// RV5 · 理由不足：拒绝，且不留记录
{
  const before = Number((await one('SELECT count(*)::int n FROM payslip_ack_revoke')).n);
  const c = await codeOf(() => doRevoke(1, SLIP2, '撤'));
  const after = Number((await one('SELECT count(*)::int n FROM payslip_ack_revoke')).n);
  rec('RV5', '★ 理由不足 4 个字 → E_ACK_REASON（422 档），且一条撤销记录都不落',
    c === 'E_ACK_REASON' && before === after, `${c} 记录 ${before}→${after}`);
}

// RV6 · 重复撤回被拒
{
  const before = Number((await one('SELECT count(*)::int n FROM payslip_ack_revoke')).n);
  const c = await codeOf(() => doRevoke(1, SLIP1, '再撤一次试试'));
  const after = Number((await one('SELECT count(*)::int n FROM payslip_ack_revoke')).n);
  rec('RV6', '★ 同一条回执撤第二次 → E_ACK_ALREADY_REVOKED（409 档），记录仍是 1 条',
    c === 'E_ACK_ALREADY_REVOKED' && before === after, `${c} 记录 ${before}→${after}`);
}

// RV7 · 没有回执的单
{
  const c = await codeOf(() => doRevoke(1, 999999, '这张单根本不存在'));
  rec('RV7', '撤一张没有回执的单 → E_ACK_NOT_FOUND（404：单号错，不是状态冲突）',
    c === 'E_ACK_NOT_FOUND', c);
}

// RV8 · 没有 payroll_run 写权限
{
  const c = await codeOf(() => doRevoke(3, SLIP2, '无权限的账号试试撤回'));
  rec('RV8', '没有 payroll_run 写权限的账号（3 号 = 店员角色）→ E_RESOURCE_FORBIDDEN（403 档）',
    c === 'E_RESOURCE_FORBIDDEN', c);
}

// RV9 · 跨范围（行闸）—— A 店 HR 撤 B 店员工的回执
{
  const c = await codeOf(() => doRevoke(2, SLIP2, '越界撤回别人的回执'));
  rec('RV9', '★ A 店 HR（范围 = 门店 10）撤 B 店员工(2) 的回执 → E_OUT_OF_SCOPE：'
    + '岗位权限不够还不够，行闸按批次期末日的 cost_org 归属再挡一层',
    c === 'E_OUT_OF_SCOPE', c);
}

// RV10 · 集团 HR 撤第二张
{
  const r = await doRevoke(1, SLIP2, '纸质回执录重了，撤回');
  const p = await progress();
  rec('RV10', '集团 HR 撤掉第二张 → 成功；进度 acked 归 0、pending = slips（两张都回到未签）',
    r.revoke_id > 0 && Number(p.acked) === 0 && Number(p.pending) === Number(p.slips),
    `acked=${p.acked} pending=${p.pending} slips=${p.slips}`);
}

// RV11 · 撤销记录自身不可改删
{
  const u = await codeOf(() => db.query(
    'UPDATE payslip_ack_revoke SET reason = $1 WHERE ack_id = $2', ['改一下理由看看', ACK1.id]));
  const d = await codeOf(() => db.query(
    'DELETE FROM payslip_ack_revoke WHERE ack_id = $1', [ACK1.id]));
  rec('RV11', '撤销记录 append-only：UPDATE / DELETE 都被 E_ACKRV_READONLY 拒'
    + '（删掉一条撤回等于"这次撤回没发生过"，而签收已经被它作废了）',
    u === 'E_ACKRV_READONLY' && d === 'E_ACKRV_READONLY', `UPDATE=${u} DELETE=${d}`);
}

// RV12 · 原有回执仍不可改（187 没有为了撤回把 186 的触发器放开）
{
  const c = await codeOf(() => db.query(
    'UPDATE payslip_ack SET acked_at = now() WHERE payslip_id = $1', [SLIP1]));
  rec('RV12', '★ payslip_ack 仍然 append-only（UPDATE 被 E_ACK_READONLY 拒）—— '
    + '撤回**没有**以"放开原回执"为代价', c === 'E_ACK_READONLY', c);
}

// RV13 · listRevokes（集团 HR）
{
  const lst = await withTx(db, (tx) => listRevokes(tx, { userId: 1, runId: RUN }));
  const first = lst.rows.find((x) => x.payslip_id === SLIP1);
  rec('RV13', 'listRevokes(run)：2 条撤回，带理由、经办人名字、员工名字与原签收时间',
    lst.count === 2 && !!first && first.reason === '员工点错，撤回重签'
    && first.revoked_by === 1 && !!first.employee_name && !!first.revoked_by_name,
    `count=${lst.count} 首条=${JSON.stringify(first && {
      reason: first.reason, by: first.revoked_by_name, emp: first.employee_name })}`);
}

// RV14 · listRevokes 也受行闸
{
  const lst = await withTx(db, (tx) => listRevokes(tx, { userId: 2, runId: RUN }));
  rec('RV14', '★ A 店 HR 看撤回记录：只看到本店的 1 条（B 店员工那条被行闸挡掉）',
    lst.count === 1 && lst.rows[0].payslip_id === SLIP1,
    `count=${lst.count} slips=${lst.rows.map((x) => x.payslip_id).join(',')}`);
}

// ===========================================================================
// 二 · 188 缺岗 → 招聘需求
// ===========================================================================
const gap = (store, period = PERIOD) => withTx(db, (tx) => gapToRequisition(tx, {
  userId: 1, storeId: store, period,
}));
const rqCount = async (store) => Number((await one(
  'SELECT count(*)::int n FROM requisition WHERE org_id = $1', [store])).n);

// G1 · 第一次：每个缺岗的"档口×岗位"开一条
{
  const r = await gap(10);
  const rows = await q(
    `SELECT position_id, headcount, store_id, opened_at::text AS opened_at
       FROM requisition WHERE org_id = 10 ORDER BY position_id`);
  const byPos = new Map(rows.map((x) => [Number(x.position_id), x]));
  rec('G1', 'A 店第一次跑：开出 2 条需求（炉灶缺 2、打荷缺 2），'
    + '每条都带 position_id / store_id，opened_at = 期末日（不是今天）',
    r.opened_count === 2 && r.skipped_count === 0
    && Number(byPos.get(P_WOK)?.headcount) === 2
    && Number(byPos.get(P_GARN)?.headcount) === 2
    && Number(byPos.get(P_WOK)?.store_id) === 10
    && String(byPos.get(P_WOK)?.opened_at) === ON,
    `开了 ${r.opened_count} 条：${r.opened.map((x) => `${x.position_name}x${x.need}`).join(' ')}`
    + ` opened_at=${rows[0]?.opened_at}`);
}

// G2 · 第二次：一条都不开（幂等）
{
  const before = await rqCount(10);
  const r = await gap(10);
  const after = await rqCount(10);
  rec('G2', '★ 第二次跑：opened=0 / skipped=2（"本期已有未关闭的需求"），需求总行数不变 —— '
    + '重复开需求不会报错，只会让人多发 offer',
    r.opened_count === 0 && r.skipped_count === 2 && before === after
    && r.skipped.every((x) => /已有未关闭/.test(x.reason || '')),
    `opened=${r.opened_count} skipped=${r.skipped_count} 行数 ${before}→${after} `
    + `原因=${r.skipped[0]?.reason}`);
}

// G3 · 门店"还能发"不够：跳过而不是把名额改小
//   B 店：洗碗档两个岗位各缺 2（共 4），而门店还能发 3（quota 5 − 到岗 2）。
//   ★ 断言与"哪个岗位先开"无关：先开的那个拿 2，后一个被拒 ——
//     关键是**被拒的那个不留任何需求行**（不把 2 改成 1）。
{
  const r = await gap(11);
  const rows = await q(
    'SELECT position_id, headcount FROM requisition WHERE org_id = 11');
  const skippedPos = r.skipped[0]?.position_id;
  const skippedHasRow = rows.some((x) => Number(x.position_id) === skippedPos);
  const openedTotal = rows.reduce((s, x) => s + Number(x.headcount), 0);
  rec('G3', '★ B 店缺 2+2=4 个、门店还能发 3 个：开 1 条、跳过 1 条，跳过的把库里的 '
    + 'E_RQ_OVER_HEADCOUNT 原样带回；**没有**把缺口改小，也不给被拒岗位留需求行',
    r.opened_count === 1 && r.skipped_count === 1
    && r.opened[0].need === 2 && !skippedHasRow
    && rows.length === 1 && openedTotal === 2
    && /E_RQ_OVER_HEADCOUNT/.test(r.skipped[0]?.reason || ''),
    `opened=${r.opened_count}(need=${r.opened[0]?.need}) skipped=${r.skipped_count} `
    + `被拒岗位有需求行=${skippedHasRow} 原因=${String(r.skipped[0]?.reason).slice(0, 60)}`);
}

// G4 · 未定编的档口不产生需求
{
  const fill = await fillRows(11);
  const sea = fill.find((x) => Number(x.station_id) === S_SEA);
  const r = await gap(11);
  const seaReq = Number((await one(
    'SELECT count(*)::int n FROM requisition WHERE org_id = 11 AND position_id IS NULL')).n);
  const hasSeaRow = r.opened.some((x) => x.store_station_id === B_SEA)
    || r.skipped.some((x) => x.store_station_id === B_SEA);
  rec('G4', '未定编的档口（水台档：fn_station_fill 里 position_id = NULL、gap = NULL）'
    + '不产生需求 —— NULL 不是"缺 0"，定编是人做的决定，系统不替人补',
    !!sea && sea.position_id === null && sea.gap === null && !hasSeaRow && seaReq === 0,
    `水台档 position_id=${sea?.position_id} gap=${sea?.gap} 出现在结果里=${hasSeaRow}`);
}

// G5 · 期间格式与权限
//   两层各判一遍：服务层管"参数形状"（E_ARG_INVALID），库函数再兜一次
//   （E_SP_PERIOD）—— 因为 MCP / 手工 SQL 会绕过服务层。
{
  const c1 = await codeOf(() => gap(10, '2026-3'));
  const c1db = await codeOf(() => db.query(
    'SELECT * FROM fn_hc_gap_to_requisition(10,$1,$2)', ['2026-3', '1']));
  const c2 = await codeOf(() => withTx(db, (tx) => gapToRequisition(tx, {
    userId: 2, storeId: 11, period: PERIOD })));   // A 店 HR 对 B 店
  rec('G5', '期间写成 2026-3：服务层 E_ARG_INVALID、库函数 E_SP_PERIOD（两层都挡）；'
    + 'A 店 HR 给 B 店开需求 → E_OUT_OF_SCOPE（服务层行闸与开需求路由同一套）',
    c1 === 'E_ARG_INVALID' && c1db === 'E_SP_PERIOD' && c2 === 'E_OUT_OF_SCOPE',
    `服务层=${c1} 库=${c1db} 跨店=${c2}`);
}

// ===========================================================================
// 三 · 189 外包归属档口（★ 反例：外包不许影响编制/到岗）
// ===========================================================================
const outRows = async (store = 10) => q(
  'SELECT store_station_id, station_code, workers FROM fn_station_outsourced($1,$2::date)',
  [store, ON]);
const snap = async () => JSON.stringify(await fillRows(10));

const FILL_BEFORE = await snap();

await db.query(
  `INSERT INTO outsourced_assignment(worker_id, store_id, valid_from, store_station_id)
   VALUES (1, 10, '2026-03-01', $1)`, [A_WOK]);

// OS1 · 档口外包人数
{
  const rows = await outRows(10);
  const wok = rows.find((x) => Number(x.store_station_id) === A_WOK);
  const garn = rows.find((x) => Number(x.store_station_id) === A_GARN);
  rec('OS1', 'fn_station_outsourced(10)：炉灶档 1 个外包，打荷档 0 个（0 人的档口也给一行 —— '
    + '否则"这个档口没用外包"看不见）',
    !!wok && Number(wok.workers) === 1 && !!garn && Number(garn.workers) === 0
    && rows.length === 2,
    rows.map((x) => `${x.station_code}=${x.workers}`).join(' '));
}

// OS2 · ★ 反例：整表快照不变
{
  const after = await snap();
  rec('OS2', '★ 反例：加了这条外包派工之后，fn_station_fill(10) 的**每一行**（含 holders / gap / '
    + 'gap_since / station_slots）与加之前逐字相同 —— 外包不占编、不算到岗',
    after === FILL_BEFORE,
    after === FILL_BEFORE ? '整表快照完全一致（' + JSON.parse(after).length + ' 行）'
      : '快照变了（外包被算进了编制/到岗）');
}

// OS3 · 跨店归属被拒
{
  const c = await codeOf(() => db.query(
    `INSERT INTO outsourced_assignment(worker_id, store_id, valid_from, store_station_id)
     VALUES (1, 11, '2026-03-01', $1)`, [A_WOK]));
  rec('OS3', '★ 派工写"B 店 + A 店的炉灶档" → E_STN_OS_STORE：不判的话两边数都错，'
    + '而且都不报错', c === 'E_STN_OS_STORE', c);
}

// OS4 · 只到门店的派工不被猜进任何档口
{
  await db.query(
    `INSERT INTO outsourced_assignment(worker_id, store_id, valid_from)
     VALUES (2, 10, '2026-03-01')`);
  const rows = await outRows(10);
  const sum = rows.reduce((s, x) => s + Number(x.workers), 0);
  const storeTotal = Number((await one(
    `SELECT count(DISTINCT worker_id)::int n FROM outsourced_assignment
      WHERE store_id = 10 AND daterange(valid_from, valid_to, '[]') @> $1::date`, [ON])).n);
  rec('OS4', '★ 只到门店（store_station_id 为空）的派工不进任何档口：Σ各档口 1 < 门店总数 2 —— '
    + '差额就是"还没细分到档口"的那部分，系统不替人猜',
    sum === 1 && storeTotal === 2, `Σ档口=${sum} 门店=${storeTotal}`);
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
if (server && server.listening) await new Promise((r) => server.close(r));
await db.close();
process.exit(bad === 0 ? 0 : 1);
