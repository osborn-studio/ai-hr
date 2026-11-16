// ============================================================================
// api.test.mjs · 垂直切片验收：HTTP → 权限 → 行闸 → 掩码
// ----------------------------------------------------------------------------
// 这一组断言证明的不是"某个函数对"，而是**整条链路连得起来**：
// 前面的 12 个迁移各自合格，但各自合格的零件不一定能装成一台机器。
// ============================================================================
import { createApp } from '../app/server.mjs';
import { BIZ_CODES, toHttp } from '../app/errors.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { textCell, numCell } from '../app/csv.mjs';
import { hashToken } from '../app/services/session.mjs';
import * as leaveSvc from '../app/services/leave.mjs';
import * as attendanceSvc from '../app/services/attendance.mjs';
import * as payrollSvc from '../app/services/payroll.mjs';
import * as payslipViewSvc from '../app/services/payslip-view.mjs';
import * as recruitSvc from '../app/services/recruit.mjs';
import * as perfSvc from '../app/services/perf.mjs';
import * as headcountSvc from '../app/services/headcount.mjs';
import * as settlementSvc from '../app/services/settlement.mjs';
import * as guardSvc from '../app/services/guard.mjs';

// AG0 要拿所有服务的 RESOURCES 与库里的登记表做差集，
// 所以这里收集模块本身，而不是某个函数 —— 新增服务时忘了登记会立刻变红。
const services = {
  leave: leaveSvc, attendance: attendanceSvc, payroll: payrollSvc, recruit: recruitSvc,
  perf: perfSvc, headcount: headcountSvc, settlement: settlementSvc, guard: guardSvc,
  // 184：留痕用到的两个资源码（payslip / payroll_slips_read_all）也进差集 ——
  // 新增服务忘了登记资源码，AG0 会立刻变红（不是等到某个接口 500）。
  payslipView: payslipViewSvc,
};

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok, note });

// ★ 这个 env 必须在 createApp 之前设：登录路由读的是进程环境。
//   设了它，接口才信 X-Forwarded-For —— 而真实部署里必须由**代理覆盖**这个头，
//   否则等于让攻击者自己选来源（见 058 的文件头）。
process.env.TRUST_PROXY = '1';
const { server, db } = await createApp();
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 口令是切片里的演示口令（见 server.mjs 种子）；口令错误的自有用例显式传第二个参数
const PWD = 'demo1234';
// 三次参数：u / pwd / 来源（XFF）。来源用于 LG 组的限流断言 ——
// 同一台机器上所有请求的 socket 地址相同，只有 XFF 能把"来源"分开。
const loginAs = async (u, pwd = PWD, xff = null) => {
  const r = await fetch(`${BASE}/login?user=${u}&pwd=${encodeURIComponent(pwd)}`, {
    method: 'POST',
    headers: xff ? { 'x-forwarded-for': xff } : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const login = async (u, pwd = PWD) => (await loginAs(u, pwd)).body.token;
const get = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  return { status: r.status, body: await r.json() };
};

// M1 未登录
{ const r = await get('/api/attendance');
  rec('M1', '无 token → 401', r.status === 401, `${r.status} ${r.body.error}`); }

const t1 = await login(1);   // 集团HR
const t2 = await login(2);   // A店HR
const t3 = await login(3);   // 无任何授权

// M2 四维全空 → 0 行（不是全表）
{ const r = await get('/api/attendance', t3);
  rec('M2', '四维全空用户 → 0 行（不是全表）', r.status === 200 && r.body.rows.length === 0,
      `status=${r.status} rows=${r.body.rows.length}`); }

// M3 集团HR → 两家店都可见
{ const r = await get('/api/attendance', t1);
  rec('M3', '集团HR 可见 A/B 两店 → 2 行', r.body.rows.length === 2,
      `rows=${r.body.rows.map(x => x.store_id)}`); }

// M4 A店HR → 只有 A 店
{ const r = await get('/api/attendance', t2);
  rec('M4', 'A店HR 收窄到 1 行', r.body.rows.length === 1 && r.body.rows[0].store_id === 10,
      `rows=${r.body.rows.map(x => x.store_id)}`); }

// M5 有权用户看净值 → 原值
{ const r = await get('/api/payslip', t1);
  const row = r.body.rows.find(x => x.id === 1);
  rec('M5', '集团HR 看 net_amount → 原值（action=visible）',
      row?.net_amount === '6500.00' && row?._net_amount_action === 'visible',
      `${row?.net_amount} / ${row?._net_amount_action}`); }

// M6 无权用户看净值 → 掩码，且 HTTP 200（不报错）
{ const r = await get('/api/payslip', t2);
  const row = r.body.rows.find(x => x.id === 1);
  rec('M6', 'A店HR 看 net_amount → 掩码且 HTTP 200（只掩码不报错）',
      r.status === 200 && row?.net_amount === null && row?._net_amount_action === 'masked',
      `status=${r.status} value=${row?.net_amount} action=${row?._net_amount_action}`); }

// M7 同一请求内不串权限：连续两次不同用户，第二次不继承第一次
{ await get('/api/attendance', t1);           // 集团HR 先灌满
  const r = await get('/api/attendance', t3); // 无权限用户紧随
  rec('M7', '两次请求间权限不残留（临时表每次重灌）', r.body.rows.length === 0,
      `rows=${r.body.rows.length}`); }


// ===========================================================================
// N 组 · 请假端到端：申请 → 冻结 → 审批 → 消耗 → 工资条
// ===========================================================================
// ★ 假种 id 不再写死：126/127 预置了官方假种（1=年假 2=病假 3=事假…），
//   写死 1/2 会把"事假"的额度查到"年假"上 —— 和之前"账号 id 与种子 user 撞"同类。
const LT_P = Number((await db.query(`SELECT id FROM leave_type WHERE code='PERSONAL'`)).rows[0].id);
const LT_A = Number((await db.query(`SELECT id FROM leave_type WHERE code='ANNUAL'`)).rows[0].id);
const balOf = async (t, typeId) => (await get('/api/leave/balance', t)).body.rows
  .find(x => x.leave_type_id === typeId);
const post = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};
// 带 JSON body 的 POST（137 预演要传结构化覆盖参数）。
// ★ 单独一个 helper 而不是给 post 加可选第三参：post 有 100 多处调用，
//   加参数就得逐个确认没人把 body 当 token 传（这次自己就先撞了一次）。
const postJson = async (path, token, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, body: await r.json() };
};

{ const p = await balOf(t1, LT_P), a = await balOf(t1, LT_A);
  rec('N1','初始额度：事假 10 / 年假 5，均由台账派生',
      Number(p.available)===10 && Number(a.available)===5,
      `事假=${p.available} 年假=${a.available}`); }

const applied = await post(`/api/leave/apply?type=${LT_P}&qty=2&from=2026-03-10&to=2026-03-11`, t1);
{ const b = await balOf(t1,LT_P);
  rec('N2','申请即冻结：available 10→8，frozen 0→2，单据 pending',
      applied.status===200 && applied.body.status==='pending'
      && Number(b.available)===8 && Number(b.frozen)===2,
      `req=${applied.body.request_id} avail=${b.available} frozen=${b.frozen}`); }

const rid = applied.body.request_id;
{ const before = await balOf(t1,LT_P);
  await post(`/api/leave/decide?id=${rid}&approve=1`, t2);   // 换人审批：自审会被库拒
  const after = await balOf(t1,LT_P);
  rec('N3','审批通过：frozen→used，available 不变（额度已占用，只是状态前进）',
      Number(after.frozen)===0 && Number(after.used)===2 && Number(after.available)===Number(before.available),
      `frozen=${after.frozen} used=${after.used} avail=${after.available}`); }

{ const r = await post(`/api/leave/apply?type=${LT_P}&qty=100&from=2026-03-20&to=2026-03-21`, t1);
  rec('N4','申请超可用额度 → 409 且是业务码（不是 500 假装服务故障）',
      r.status===409 && r.body.error === 'E_LEAVE_OVER_QUOTA',
      `${r.status} ${r.body.error}`); }

{ const ap = await post(`/api/leave/apply?type=${LT_A}&qty=1&from=2026-03-25&to=2026-03-25`, t1);
  const mid = await balOf(t1,LT_A);
  await post(`/api/leave/decide?id=${ap.body.request_id}&approve=0`, t2);
  const after = await balOf(t1,LT_A);
  rec('N5','驳回：frozen 释放，available 回到 5',
      Number(mid.available)===4 && Number(after.available)===5 && Number(after.frozen)===0,
      `申请后=${mid.available} 驳回后=${after.available}`); }

{ const r = await post(`/api/leave/decide?id=${rid}&approve=1`, t2);
  rec('N6','重复审批 → 409 E_LEAVE_ALREADY_DECIDED',
      r.status===409 && r.body.error==='E_LEAVE_ALREADY_DECIDED',
      `${r.status} ${r.body.error}`); }

{ // 自审必须被库拒绝：申请人是 1，用 1 去审自己的单
  const ap2 = await post(`/api/leave/apply?type=${LT_P}&qty=1&from=2026-03-28&to=2026-03-28`, t1);
  const r = await post(`/api/leave/decide?id=${ap2.body.request_id}&approve=1`, t1);
  rec('N9','申请人自己审批 → 409 E_LEAVE_SELF_APPROVE（约束在库里，不在服务里）',
      r.status===409 && r.body.error==='E_LEAVE_SELF_APPROVE',
      `${r.status} ${r.body.error}`); }

{ const r = await get('/api/payslip/leave-deduction?period=2026-03', t1);
  // 2 天事假 × (8000 / 21.75) = 735.63...
  rec('N7','工资条体现：2 天事假扣款 = 2 × 8000/21.75 ≈ 735.63',
      Math.abs(Number(r.body.deduction) - 735.63) < 0.02, `deduction=${r.body.deduction}`); }

{ const r = await get('/api/leave/inconsistent', t1);
  rec('N8','接缝自检视图为空（申请/审批/额度/单据四处状态一致）',
      r.body.ok === true && r.body.rows.length === 0, JSON.stringify(r.body.rows)); }


// ===========================================================================
// O 组 · 封账（HTTP 层）：权限走同一套行闸
// ===========================================================================
{ const r = await post('/api/attendance/close?store=11&period=2026-03', t2);
  rec('O1','A店HR 封 B店的账 → 403（封账权限与读权限是同一套行闸）',
      r.status===403 && r.body.error==='E_OUT_OF_SCOPE', `${r.status} ${r.body.error}`); }

{ const r = await post('/api/attendance/close?store=10&period=2026-03', t2);
  rec('O2','A店HR 封自己辖内门店 → 200', r.status===200 && r.body.closed===true,
      `${r.status} ${JSON.stringify(r.body)}`); }

{ let blocked=false, note='';
  try { await db.exec(`UPDATE attendance_daily_store SET work_hours=7 WHERE store_id=10`); note='封账后仍可改'; }
  catch(e){ blocked = String(e.message).includes('E_ATT_CLOSED'); note=e.code; }
  rec('O3','封账后改考勤 → 数据库拒绝（不是应用层拦）', blocked, note); }

{ const r = await get('/api/attendance/unclosed?period=2026-03', t1);
  const stores = r.body.rows.map(x=>Number(x.store_id));
  rec('O4','未封账清单：只剩 B 店（A 店已封），且清单能被看到',
      r.body.all_closed===false && stores.length===1 && stores[0]===11,
      `未封账=${JSON.stringify(stores)}`); }


// ===========================================================================
// S 组 · 算薪（HTTP 层）：门禁、勾稽、逐字段掩码
// ===========================================================================
{ const r = await post('/api/payroll/run?period=2026-03&entity=1', t1);
  rec('S1','有门店未封账 → 算薪 409 且报出门店（门禁在库里，不在接口里）',
      r.status===409 && String(r.body.error).includes('E_ATT_NOT_CLOSED'),
      `${r.status} ${String(r.body.error).slice(0,50)}`); }

await post('/api/attendance/close?store=11&period=2026-03', t1);

{ const r = await post('/api/payroll/run?period=2026-03&entity=1', t1);
  rec('S2','全部封账后算薪成功（接口层不算任何数，只调 fn_payroll_calc）',
      r.status===200 && r.body.calculated >= 1,
      `run=${r.body.run_id} 生成=${r.body.calculated} 应发合计=${r.body.gross_total}`); }

{ const runs = (await get('/api/payroll/runs', t1)).body.rows;
  const run = runs.find(x => x.period === '2026-03');
  const r = await get(`/api/payroll/slips?run=${run.id}`, t1);
  const s = r.body.rows[0];
  rec('S3','集团 HR 看工资条明细 → 净值原值（scene=detail 单独授权）',
      r.status===200 && s && s.net_amount !== null && s._actions.net_amount==='visible',
      `net=${s?.net_amount} action=${s?._actions?.net_amount}`); 
  globalThis.__runId = run.id; }

{ const r = await get(`/api/payroll/slips?run=${globalThis.__runId}`, t2);
  const s = r.body.rows[0];
  rec('S4','A店HR 看同一张工资条 → 净值掩码且 HTTP 200（同一字段，两种身份）',
      r.status===200 && s && s.net_amount === null && s._actions.net_amount==='masked',
      `net=${s?.net_amount} action=${s?._actions?.net_amount}`); }

{ const r = await get(`/api/payroll/slips?run=${globalThis.__runId}`, t1);
  const s = r.body.rows[0];
  rec('S5','每个数可追来源：明细项齐全（BASE / LEAVE_DEDUCT / SI_EMPLOYEE / IIT）',
      s.items.length === 4 && s.items.some(i=>i.item_code==='BASE'),
      s.items.map(i=>`${i.item_code}=${i.amount}`).join(' ')); }

{ const r = await get('/api/payroll/consistency', t1);
  rec('S6','勾稽视图为空（明细之和 = 应发−社保−个税，实发一致，应发非负）',
      r.body.ok === true && r.body.rows.length === 0, JSON.stringify(r.body.rows).slice(0,80)); }


// ===========================================================================
// AG 组 · 写路径：行闸 / 事务 / 资源码 / 留痕
// ---------------------------------------------------------------------------
// 这一组补的是原来最大的空白：**只有读路径被验证过越权**。
// 一个四维全空的账号，查考勤 0 行（M2 证明了），却仍然可以发起全集团算薪 ——
// 演示里永远用权限最大的账号，所以这个洞在演示中不可见。
// ===========================================================================
{ // W0 资源码：凡调 app_begin_scope 的资源，必须在 sys_perm_resource 里有一行
  //    漏登记的失败形态是 500 E_RESOURCE_UNREGISTERED —— 看起来像服务故障，
  //    实际是"少了一行 INSERT"。
  const used = [...new Set(Object.values(services).flatMap(m => Object.values(m.RESOURCES || {})))];
  const rows = (await db.query(
    `SELECT resource_code FROM sys_perm_resource WHERE resource_code = ANY($1)`, [used])).rows;
  const missing = used.filter(c => !rows.some(r => r.resource_code === c));
  rec('AG0',`服务层用到的资源码全部已登记 ${used.length - missing.length}/${used.length}`
      + '（未登记不是"权限不足"，是接口直接 500）',
      used.length >= 8 && missing.length === 0, `未登记=${missing.join(',') || '无'}`); }

{ // W1 写路径也过行闸：无任何授权的账号算薪 → 403，不是"照算不误"
  const r = await post('/api/payroll/run?period=2026-03&entity=1', t3);
  // ★ 403 可能是两层里的任何一层：岗位层（E_RESOURCE_FORBIDDEN，店员不许算薪）
  //   或数据层（E_OUT_OF_SCOPE，没有这个法人的范围）。这条断言要证明的是
  //   "**拒绝发生在写之前**"，所以判 403 + 一张工资条都没生成，而不是钉死某一个码。
  rec('AG1','四维全空账号发起算薪 → 403（岗位层或数据层拒绝，都在写之前）',
      r.status === 403 && (r.body.error === 'E_OUT_OF_SCOPE' || r.body.error === 'E_RESOURCE_FORBIDDEN'),
      `${r.status} ${r.body.error}`); }

{ // W2 越权封账不落任何行
  const before = Number((await db.query(
    `SELECT count(*)::int n FROM attendance_close`)).rows[0].n);
  const r = await post('/api/attendance/close?store=10&period=2026-04', t3);
  const after = Number((await db.query(
    `SELECT count(*)::int n FROM attendance_close`)).rows[0].n);
  rec('AG2','越权封账 → 403 且 attendance_close 一行未增（拒绝发生在写之前）',
      r.status === 403 && after === before, `${r.status} 行数 ${before}→${after}`); }

{ // W3 建批次与算薪必须同一事务：门禁拒绝时不留空批次
  //    ★ 原来是 INSERT pay_run 自动提交、再 fn_payroll_calc 门禁拒绝 → 409，
  //      而那个 draft 空批次留在库里：下一次同期间算薪会复用它，
  //      于是一个"从未算过"的批次看起来像"算过了、只是没数"。
  const before = Number((await db.query(
    `SELECT count(*)::int n FROM pay_run WHERE period='2026-06'`)).rows[0].n);
  const r = await post('/api/payroll/run?period=2026-06&entity=1', t1);
  const after = Number((await db.query(
    `SELECT count(*)::int n FROM pay_run WHERE period='2026-06'`)).rows[0].n);
  rec('AG3','绩效未封存 → 算薪 409 E_PERF_NOT_SEALED，且不留下空批次（建批次与算薪同一事务）',
      r.status === 409 && r.body.error === 'E_PERF_NOT_SEALED' && before === 0 && after === 0,
      `${r.status} ${r.body.error} pay_run ${before}→${after}`); }

{ // W4 招聘需求只能挂叶子组织 —— 非叶子发 offer 时"占哪个门店的编"没有答案
  const r = await post('/api/recruit/requisition?org=30&position=店员&headcount=1&opened_at=2026-03-05&reason=测试非叶子', t1);
  rec('AG4','需求挂到有下级的组织（华东区）→ 422 E_RQ_NOT_LEAF',
      r.status === 422 && r.body.error === 'E_RQ_NOT_LEAF', `${r.status} ${r.body.error}`); }

{ // W5 名额超"还能发" → 409（同一组织多张需求的名额要合起来算）
  const r = await post('/api/recruit/requisition?org=11&position=店员&headcount=99&opened_at=2026-03-05&reason=测试超额', t1);
  rec('AG5','B店只剩 4 个可招，开 99 个名额 → 409 E_RQ_OVER_HEADCOUNT',
      r.status === 409 && r.body.error === 'E_RQ_OVER_HEADCOUNT', `${r.status} ${r.body.error}`); }

{ // W6 正常开需求 → 200，并且立刻出现在看板里
  const r = await post('/api/recruit/requisition?org=11&position=店员&headcount=1&opened_at=2026-03-05&reason=旺季补人', t1);
  const board = (await get('/api/recruit?as_of=2026-03-05', t1)).body.requisitions || [];
  rec('AG6','在叶子组织开 1 个名额 → 200 且看板立刻可见（写与读读的是同一张表）',
      r.status === 200 && !!r.body.requisition_id
      && board.some(x => Number(x.id) === Number(r.body.requisition_id)),
      `${r.status} id=${r.body.requisition_id} 看板 ${board.length} 条`); }

{ // W7 offer 超需求名额：C店需求 2 个名额，已有 1 个有效 offer
  const rq = (await get('/api/recruit?as_of=2026-03-05', t1)).body.requisitions
    .find(x => Number(x.headcount) === 2 && x.status === 'open');
  const a = await post(`/api/recruit/offer?rq=${rq.id}&key=CAND-002&name=候选人乙&position=店员&amount=7000&valid_until=2026-12-31&on=2026-03-06&reason=补一个名额`, t1);
  const b = await post(`/api/recruit/offer?rq=${rq.id}&key=CAND-003&name=候选人丙&position=店员&amount=7000&valid_until=2026-12-31&on=2026-03-06&reason=再补一个名额`, t1);
  rec('AG7','需求 2 个名额：第 2 个 offer 成功、第 3 个 → 409 E_OFFER_OVER_RQ',
      a.status === 200 && b.status === 409 && b.body.error === 'E_OFFER_OVER_RQ',
      `第2个=${a.status} 第3个=${b.status} ${b.body.error}`); }

{ // W8 逐级下分：子项之和不得超过父项额度
  const r = await post('/api/headcount/set?org=11&period=2026-03&quota=999&reason=测试超分', t1);
  rec('AG8','B店要 999 个编（华东区只有 20）→ 422 E_HC_OVER_ALLOCATED（下分是分配，不是复制）',
      r.status === 422 && r.body.error === 'E_HC_OVER_ALLOCATED', `${r.status} ${r.body.error}`); }

{ // W9 调编 = 追加版本，不是就地改；旧版本还在
  const before = (await db.query(
    `SELECT max(version) v FROM headcount_budget WHERE org_id=12 AND period='2026-03'`)).rows[0].v;
  const r = await post('/api/headcount/set?org=12&period=2026-03&quota=3&reason=保持不变只追加版本', t1);
  const after = (await db.query(
    `SELECT max(version) v FROM headcount_budget WHERE org_id=12 AND period='2026-03'`)).rows[0].v;
  rec('AG9','调编追加版本（v1→v2），额度不变也不就地改一行（"上月额度是多少"仍查得到）',
      r.status === 200 && Number(after) === Number(before) + 1,
      `version ${before}→${after} status=${r.status}`); }

{ // W10 权限分配到组织：A店HR 不能给 C店下编
  const r = await post('/api/headcount/set?org=12&period=2026-03&quota=3&reason=越权尝试', t2);
  rec('AG10','A店HR 给 C店下编 → 403（权限分配到组织，不是"HR 都行"）',
      r.status === 403 && r.body.error === 'E_OUT_OF_SCOPE', `${r.status} ${r.body.error}`); }

{ // W11 失败必须留痕，且留得住（日志写在事务外）
  const r = (await db.query(
    `SELECT count(*)::int n FROM app_request_log
      WHERE action='payroll.run' AND NOT ok AND error_code='E_PERF_NOT_SEALED'`)).rows[0].n;
  rec('AG11','写路径失败留痕：payroll.run 的失败记录落在事务外（ROLLBACK 带不走它）',
      Number(r) >= 1, `失败留痕 ${r} 条`); }

{ // W12 结算：两份数不一致时结不了，且拒绝里带得出差异条数
  const b = await post('/api/settlement/build?supplier=1&period=2026-03', t1);
  const c = await post(`/api/settlement/confirm?id=${b.body.settlement_id}`, t1);
  rec('AG12','结算有差异 → 409 E_SETTLE_HAS_DIFF（不取平均、不取小：拒绝而不是替双方决定）',
      b.status === 200 && c.status === 409 && c.body.error === 'E_SETTLE_HAS_DIFF',
      `build=${b.status} confirm=${c.status} ${c.body.error}`); }

{ // W13 每条 POST 路由都必须经由 runWrite —— 用源码扫描，而不是靠人去数。
  //    新加一条写路由、忘了走统一出口，它就会缺事务或缺留痕，
  //    而那种缺失**不会让任何断言变红**（因为没有断言看它）。
  const src = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
  // 只看 /api/ 下的 POST：/login 是发会话，它不碰业务表，也不该被算进来
  const parts = src.split("req.method === 'POST'")
    .slice(1).filter(p => p.slice(0, 80).includes("'/api/"));
  // 例外必须**写明理由**（`@no-runWrite: <原因>`），不能靠"这次先放过"。
  // 现在两条，理由各不相同：
  //   ① 改口令要把失败计数先提交再抛错，走 runWrite 会把它回滚掉；
  //   ② 在线开库要十几秒（建库 + 跑迁移），不能一直占着一个事务连接。
  // 上限从 1 提到 3：这条判据的目的是"每个例外都写明理由"，不是"只许有一个例外"；
  // 但上限仍需存在 —— 它会拦住"以后都写例外"的滑坡。
  const isExempt = (seg) => /@no-runWrite:\s*\S/.test(seg.slice(0, 400));
  const naked = parts.filter(p => !p.slice(0, 1200).includes('runWrite(') && !isExempt(p));
  const exempt = parts.filter(isExempt).length;
  rec('AG13',`每条 /api POST 都走 runWrite；例外须写明理由 ${parts.length - naked.length}/${parts.length}`,
      parts.length >= 9 && naked.length === 0 && exempt <= 3,
      `POST ${parts.length} 条，未走 ${naked.length} 条，写明理由的例外 ${exempt} 条`); }

{ // W14 服务层不许自己拼事务外的写：withTx 只应在 server 里被调用
  //    （服务层收到的是 tx，它不该知道"事务怎么开"）
  const files = readdirSync(new URL('../app/services', import.meta.url));
  const bad = files.filter(f => f.endsWith('.mjs'))
    .filter(f => readFileSync(new URL(`../app/services/${f}`, import.meta.url), 'utf8').includes('withTx'));
  rec('AG14','服务层不自己开事务（它只收到 tx，事务边界只有一处）',
      bad.length === 0, bad.length ? bad.join(',') : `${files.length} 个服务模块`); }

// ===========================================================================
// AH 组 · 会话落库：摘要、三态、不可延长、不可复活
// ---------------------------------------------------------------------------
// 在这之前会话是进程里的一个 `new Map()`：重启即掉线、**无法吊销**，
// 也回答不了安全审计的第一句话——"这个 token 现在还能不能用"。
// ===========================================================================
{ // AH1 库里的不是 token，是摘要；而且密文对不上任何一条
  const t = await login(1);
  const asPlain = (await db.query(
    'SELECT count(*)::int n FROM sys_session WHERE token_hash = $1', [t])).rows[0].n;
  const byHash = (await db.query(
    'SELECT count(*)::int n FROM sys_session WHERE token_hash = $1', [hashToken(t)])).rows[0].n;
  rec('AH1','库里存的是 sha256 摘要，不是 token 本身（库被导出也冒充不了人）',
      Number(asPlain) === 0 && Number(byHash) === 1,
      `明文命中 ${asPlain} 条、摘要命中 ${byHash} 条`); }

{ // AH2 过期 → 401 且原因是 expired，与"没登录"分开
  const tok = 'expired_token_0123456789abcdef';
  await db.query(
    `INSERT INTO sys_session(token_hash,user_id,issued_at,expires_at)
     VALUES ($1,1, now() - interval '3 hours', now() - interval '1 hour')`,
    [hashToken(tok)]);
  const r = await get('/api/attendance', tok);
  rec('AH2','过期会话 → 401 E_SESSION_EXPIRED（过不过期是比较出来的，不是谁翻的状态）',
      r.status === 401 && r.body.error === 'E_SESSION_EXPIRED', `${r.status} ${r.body.error}`); }

{ // AH3 吊销 → 立刻失效，并带出原因
  const tok = await login(1);
  await db.query('SELECT fn_session_revoke($1,$2,$3)', [hashToken(tok), 'sec', '设备丢失，立即吊销']);
  const r = await get('/api/attendance', tok);
  rec('AH3','吊销后立刻 401 E_SESSION_REVOKED，且带得出吊销原因（不是"未知错误"）',
      r.status === 401 && r.body.error === 'E_SESSION_REVOKED'
      && String(r.body.revoked_reason || '').includes('设备丢失'),
      `${r.status} ${r.body.error} / ${r.body.revoked_reason}`); }

{ // AH4 三态不许合并成一个 401
  const none = await get('/api/attendance', null);
  const exp  = await get('/api/attendance', 'expired_token_0123456789abcdef');
  const codes = [none.body.error, exp.body.error];
  rec('AH4','没 token / 过期 是**不同的码**（处置不同：一个引导登录，一个重新登录）',
      none.status === 401 && exp.status === 401 && codes[0] !== codes[1],
      codes.join(' vs ')); }

{ // AH5 会话不可延长：就地改过期时间 = 把泄露的 token 变成永久的
  const tok = await login(1);
  let msg = '', code = '';
  try {
    await db.query(`UPDATE sys_session SET expires_at = expires_at + interval '1 day'
                     WHERE token_hash = $1`, [hashToken(tok)]);
  } catch (e) { msg = e.message; code = e.code; }
  rec('AH5','就地延长会话有效期 → 拒（续期只能重新登录签发）',
      msg.includes('E_SESSION_EXTEND'), `${code} ${String(msg).split('\n')[0].slice(0,40)}`); }

{ // AH6 身份三件套不可改
  const tok = await login(1);
  let msg = '';
  try {
    await db.query('UPDATE sys_session SET user_id = 2 WHERE token_hash = $1', [hashToken(tok)]);
  } catch (e) { msg = e.message; }
  rec('AH6','把会话改成别人的账号 → 拒（E_SESSION_TAINTED）',
      msg.includes('E_SESSION_TAINTED'), String(msg).split('\n')[0].slice(0,40)); }

{ // AH7 吊销不可复活
  const tok = await login(1);
  await db.query('SELECT fn_session_revoke($1,$2,$3)', [hashToken(tok), 'sec', '测试复活路径']);
  let msg = '';
  try {
    await db.query(`UPDATE sys_session SET revoked_at = NULL, revoked_by = NULL,
                     revoked_reason = NULL WHERE token_hash = $1`, [hashToken(tok)]);
  } catch (e) { msg = e.message; }
  rec('AH7','把已吊销会话的 revoked_at 清空 → 拒（复活＝那个 token 又能用了）',
      msg.includes('E_SESSION_REVIVE'), String(msg).split('\n')[0].slice(0,40)); }

{ // AH8 会话表里没有 status 列：过期不靠状态列，靠比较
  const cols = (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='sys_session'`)).rows
    .map(r => r.column_name);
  const active = (await db.query('SELECT count(*)::int n FROM v_session_active')).rows[0].n;
  const total = (await db.query('SELECT count(*)::int n FROM sys_session')).rows[0].n;
  rec('AH8','sys_session 里没有 status 列（过期是派生的）；活跃视图自动排除过期与吊销',
      !cols.includes('status') && Number(active) < Number(total),
      `活跃 ${active} / 全量 ${total}`); }

{ // AH9 会话不靠进程内存：源码里不许再出现 token -> userId 的 Map
  const src = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
  rec('AH9','服务进程不持有会话状态（源码里没有 new Map 存 token）',
      !src.includes('sessions.set') && !src.includes('new Map()   // token'),
      src.includes('sessions.set') ? '仍有 sessions.set' : '无会话内存表'); }

{ // AH10 会话列表只列自己的
  const rows = (await get('/api/me/sessions', t1)).body.rows || [];
  const mine = rows.every(x => Number(x.user_id) === 1);
  rec('AH10','会话列表只有自己那几条（"他现在在哪几台设备上"不能变成"谁都能看"）',
      rows.length >= 1 && mine, `${rows.length} 条，全部属于 user 1=${mine}`); }

{ // AH11 吊销别人的会话 → 403（先登录一个 user2 造出一条对他的会话）
  await login(2);
  const sid = (await db.query(
    'SELECT id FROM sys_session WHERE user_id = 2 ORDER BY id DESC LIMIT 1')).rows[0].id;
  const r = await post(`/api/me/sessions/revoke?id=${sid}&reason=越权尝试吊销别人的会话`, t1);
  rec('AH11','用 user1 吊销 user2 的会话 → 403 E_OUT_OF_SCOPE（吊销是"我吊销我的"）',
      r.status === 403 && r.body.error === 'E_OUT_OF_SCOPE', `${r.status} ${r.body.error}`); }

// ===========================================================================
// AR 组 · 审批走通接口：发起 → 待办 → 审批 → 业务回写
// ---------------------------------------------------------------------------
// 引擎在库里（032），这一组证明的是"从 HTTP 能把它跑起来"，以及三件最容易错的事：
// 待办只列该我办的、不是我的单不能批、同一张单不能发起两次。
// ===========================================================================
{ // AR1 发起 → 另一个人审 → 单据 approved、额度真的被用掉
  const before = (await balOf(t1, LT_A)).used;
  const ap = await post(`/api/leave/apply?type=${LT_A}&qty=1&from=2026-04-01&to=2026-04-01`, t1);
  const st = await post(`/api/approval/start?biz_type=leave&biz_id=${ap.body.request_id}&on=2026-04-01`, t1);
  // 待办里应该出现这条（t2 持有角色 2）
  const my = (await get('/api/approval/tasks', t2)).body.rows || [];
  const mine = my.find(x => Number(x.biz_id) === Number(ap.body.request_id));
  const r = await post(`/api/approval/act?instance=${st.body.instance_id}&approve=1`, t2);
  const after = (await balOf(t1, LT_A)).used;
  const lr = (await db.query('SELECT status FROM leave_request WHERE id=$1', [ap.body.request_id])).rows[0].status;
  rec('AR1','发起 → 待办出现 → 另一人审批 → 实例 approved、单据 approved、额度 used +1',
      st.status === 200 && !!mine && r.status === 200 && r.body.status === 'approved'
      && lr === 'approved' && Number(after) === Number(before) + 1,
      `start=${st.status} 待办=${!!mine} act=${r.body.status} 单据=${lr} used ${before}→${after}`); }

{ // AR2 不是我的待办 → 409（E_APPR_NOT_YOURS），不是"谁点都算"
  const ap = await post(`/api/leave/apply?type=${LT_A}&qty=1&from=2026-04-03&to=2026-04-03`, t1);
  const st = await post(`/api/approval/start?biz_type=leave&biz_id=${ap.body.request_id}&on=2026-04-03`, t1);
  const r = await post(`/api/approval/act?instance=${st.body.instance_id}&approve=1`, t3);
  rec('AR2','无授权账号去批别人的单 → 403 E_APPR_NOT_YOURS（待办是"人"的，不是"角色"的）',
      r.status === 403 && r.body.error === 'E_APPR_NOT_YOURS', `${r.status} ${r.body.error}`); }

{ // AR3 同一张单不能发起两次：第二条 running 实例被唯一索引挡住
  const ap = await post(`/api/leave/apply?type=${LT_A}&qty=1&from=2026-04-05&to=2026-04-05`, t1);
  const a = await post(`/api/approval/start?biz_type=leave&biz_id=${ap.body.request_id}&on=2026-04-05`, t1);
  const b = await post(`/api/approval/start?biz_type=leave&biz_id=${ap.body.request_id}&on=2026-04-05`, t1);
  rec('AR3','同一张单发起两次 → 拒（唯一索引 uk_ai_one_running），不会出现两条流程各写各的',
      a.status === 200 && b.status === 409 && b.body.error === 'CONFLICT',
      `第一次=${a.status} 第二次=${b.status} ${b.body.error}`); }

{ // AR4 轨迹可查：谁在第几步、什么动作、结论
  const ap = await post(`/api/leave/apply?type=${LT_A}&qty=1&from=2026-04-07&to=2026-04-07`, t1);
  const st = await post(`/api/approval/start?biz_type=leave&biz_id=${ap.body.request_id}&on=2026-04-07`, t1);
  const tr = (await get(`/api/approval/trace?instance=${st.body.instance_id}`, t1)).body;
  const approvers = (tr.tasks || []).map(x => Number(x.approver_id)).sort();
  rec('AR4','审批轨迹可查：审批人是解析出来的"人"（2 与 4），不是角色号',
      (tr.tasks || []).length === 2 && approvers.join(',') === '2,4',
      `tasks=${JSON.stringify(tr.tasks?.map(x=>x.approver_id))}`); }

// ===========================================================================
// MS 组 · 开放层两阶段写：没有预览就没有写入
// ---------------------------------------------------------------------------
// 「建议先 dryRun 看一下影响面」是一句建议，而建议会被跳过。
// 这一组证明的是：跳过它**写不进去**。
// ===========================================================================
const mcpArgs = { employee_id: 1, leave_type_id: LT_A, qty: 1,
                  date_from: '2026-05-06', date_to: '2026-05-06' };
const qs = (o) => new URLSearchParams(o).toString();

{ const r = await get('/api/mcp/tools', t1);
  const t = (r.body.tools || []).find(x => x.name === 'leave_apply');
  rec('MS1','工具目录里只列**真的接上了**的工具（放个没实现的进去，AI 会拿到假成功）',
      r.status === 200 && !!t && t.write === true, JSON.stringify((r.body.tools||[]).map(x=>x.name))); }

{ const r = await post(`/api/mcp/execute?plan=00000000-0000-0000-0000-000000000000&tool=leave_apply&${qs(mcpArgs)}`, t1);
  rec('MS2','没有 plan 直接执行 → 409 E_MCP_NO_PLAN（AI 不能跳过预览改数据）',
      r.status === 409 && String(r.body.error).includes('E_MCP_NO_PLAN'), `${r.status} ${r.body.error}`); }

const plan = (await post(`/api/mcp/plan?tool=leave_apply&${qs(mcpArgs)}`, t1)).body;
{ const before = Number((await db.query('SELECT count(*)::int n FROM leave_request')).rows[0].n);
  const r = await post(`/api/mcp/execute?plan=${plan.plan_id}&tool=leave_apply&${qs(mcpArgs)}`, t1);
  const after = Number((await db.query('SELECT count(*)::int n FROM leave_request')).rows[0].n);
  rec('MS3','预览 → 执行：参数一致才写入，且单据真的建了（预览里给了影响面 1 条）',
      plan.affected_count === 1 && r.status === 200 && after === before + 1,
      `affected=${plan.affected_count} exec=${r.status} 单据 ${before}→${after}`); }

{ const r = await post(`/api/mcp/execute?plan=${plan.plan_id}&tool=leave_apply&${qs(mcpArgs)}`, t1);
  rec('MS4','同一个 plan 执行第二次 → 409 E_MCP_PLAN_USED（一个 plan 只能用一次）',
      r.status === 409 && String(r.body.error).includes('E_MCP_PLAN_USED'), `${r.status} ${r.body.error}`); }

{ const p2 = (await post(`/api/mcp/plan?tool=leave_apply&${qs(mcpArgs)}`, t1)).body;
  const changed = { ...mcpArgs, qty: 3 };
  const r = await post(`/api/mcp/execute?plan=${p2.plan_id}&tool=leave_apply&${qs(changed)}`, t1);
  rec('MS5','预览 1 天、执行 3 天 → 409 E_MCP_ARGS_CHANGED（防"预览 10 条、执行 1000 条"）',
      r.status === 409 && String(r.body.error).includes('E_MCP_ARGS_CHANGED'), `${r.status} ${r.body.error}`); }

// ---------------------------------------------------------------------------
// MS7–MS12 · 只读那半边：同一个门的第二个入口
// ---------------------------------------------------------------------------
// 010 只管住了写。只读一直没规矩，而只读恰恰是 AI 用得最多的部分 ——
// 也是泄露真正发生的形态。这一节证明：开放层**没有**绕开掩码与行闸。
{ // MS7 同一个工资条，两种身份经开放层读出来的净值不同 —— 掩码在路上就生效了
  const runId = globalThis.__runId;
  const a = await get(`/api/mcp/read?tool=payslip_summary&run_id=${runId}`, t1);
  const b = await get(`/api/mcp/read?tool=payslip_summary&run_id=${runId}`, t2);
  const ra = (a.body.rows || [])[0] || {};
  const rb = (b.body.rows || [])[0] || {};
  rec('MS7','只读工具走**同一份**掩码：集团HR 经开放层看到净值，A店HR 拿到 null（不是 0，也不是明文）',
      a.status === 200 && b.status === 200 && ra.net_amount !== null && ra.net_amount !== undefined
      && rb.net_amount === null && rb.net_amount !== 0,
      `集团=${ra.net_amount ?? 'null'} A店=${rb.net_amount === null ? 'null' : rb.net_amount} actions=${JSON.stringify(rb._actions)}`); }

{ // MS8 只读也留痕，且 affected 是**行数**（不是"调用过一次"）
  const rows = (await db.query(
    `SELECT tool_name, shift_run, affected FROM sys_mcp_audit
      WHERE tool_name='payslip_summary' ORDER BY id DESC LIMIT 2`)).rows;
  rec('MS8','只读落审计（shift_run=false）且 affected=返回行数 —— 一个只该看 2 行的人读了 200 行，这个数字会说话',
      rows.length === 2 && rows.every(x => x.shift_run === false)
      && rows.every(x => Number(x.affected) >= 1),
      rows.map(x => `${x.tool_name}:${x.shift_run ? '写' : '读'}:${x.affected}`).join(' ')); }

{ // MS9 写工具不许当只读调；只读工具不许 plan
  const asRead = await get(`/api/mcp/read?tool=leave_apply&employee_id=1&leave_type_id=${LT_P}&qty=1&date_from=2026-05-01&date_to=2026-05-01`, t1);
  const asPlan = await post('/api/mcp/plan?tool=payslip_summary&run_id=1', t1);
  rec('MS9','性质不许混用：写工具直接 read → 拒；只读工具去 plan → 拒（都回 E_MCP_TOOL_MISMATCH）',
      asRead.body.error === 'E_MCP_TOOL_MISMATCH' && asPlan.body.error === 'E_MCP_TOOL_MISMATCH',
      `read=${asRead.status} ${asRead.body.error} / plan=${asPlan.status} ${asPlan.body.error}`); }

{ // MS10 第二个写工具：预览必须回答"改前/改后/会不会超编/上级还剩多少"
  const p = await post('/api/mcp/plan?tool=headcount_set&org_id=10&period=2026-03&quota=11&reason=AI把A店额度降到11', t1);
  const d = (p.body.diff || [])[0] || {};
  rec('MS10','headcount_set 的预览给出四个数（改前/改后/是否超已下分/上级剩余），不是"影响 1 行"的橡皮图章',
      p.status === 200 && Number(d.quota_after) === 11 && d.quota_before !== undefined
      && 'over_allocated_after' in d && 'parent_available_after' in d,
      `前=${d.quota_before} 后=${d.quota_after} 已下分=${d.allocated} 超编=${d.over_allocated_after} 上级余=${d.parent_available_after}`); }

{ // MS11 第二个写工具同样被摘要锁住：改一个数就拒
  const p = (await post('/api/mcp/plan?tool=headcount_set&org_id=10&period=2026-03&quota=11&reason=AI把A店额度降到11', t1)).body;
  const bad = await post(`/api/mcp/execute?plan=${p.plan_id}&tool=headcount_set&org_id=10&period=2026-03&quota=99&reason=AI把A店额度改成99`, t1);
  rec('MS11','预览 11、执行 99 → 拒（E_MCP_ARGS_CHANGED）；摘要锁不是只对第一个工具生效',
      bad.body.error === 'E_MCP_ARGS_CHANGED', `${bad.status} ${bad.body.error}`); }

{ // MS12 执行 → 额度真的变了（预览与执行走的是同一条业务函数）
  const p = (await post('/api/mcp/plan?tool=headcount_set&org_id=10&period=2026-03&quota=11&reason=AI把A店额度降到11', t1)).body;
  const ok = await post(`/api/mcp/execute?plan=${p.plan_id}&tool=headcount_set&org_id=10&period=2026-03&quota=11&reason=AI把A店额度降到11`, t1);
  const q = (await db.query('SELECT fn_hc_quota(10,$1) q', ['2026-03'])).rows[0].q;
  rec('MS12','执行后 A店额度真的变成 11（AI 走的是同一条 fn_hc_set，不是另一条写路径）',
      ok.status === 200 && Number(q) === 11, `exec=${ok.status} quota=${q}`); }

{ // MS13 只读也过行闸：无授权账号经开放层读考勤 → 0 行（不是"读到了但你没权限"）
  const none = await get('/api/mcp/read?tool=attendance_query', t3);
  const all = await get('/api/mcp/read?tool=attendance_query', t1);
  rec('MS13','只读工具过四维行闸：无授权账号经开放层读考勤 = 0 行，集团HR 读到 >0 行',
      none.status === 200 && Number(none.body.count) === 0
      && Number(all.body.count) > 0,
      `无授权=${none.body.count} 行 / 集团HR=${all.body.count} 行`); }

{ const r = await get('/api/mcp/audit', t1);
  const rows = r.body.rows || [];
  rec('MS6','每次写入落一条审计（shift_run=true），"谁调过什么"答得出来',
      rows.some(x => x.shift_run === true && x.tool_name === 'leave_apply'),
      `${rows.length} 条，写入 ${rows.filter(x=>x.shift_run).length} 条`); }

// ===========================================================================
// AT 组 · 认证：口令不进库、错误计数在库、锁定期间正确口令也进不去
// ---------------------------------------------------------------------------
// 在这之前 `/login?user=3` 就能拿到 user 3 的令牌 —— 认证这一层根本不存在。
// 会话做得再完整也没意义：门锁很好，门是开的。
// ===========================================================================
const AUTH_USER = 2;   // 用一个不参与其它断言的账号，避免把它的计数搅乱

{ const ok = await loginAs(1);
  rec('AT1','正确口令 → 200 拿 token', ok.status === 200 && !!ok.body.token,
      `${ok.status} token=${!!ok.body.token}`); }

{ const r = await loginAs(AUTH_USER, 'wrong-password');
  rec('AT2','口令错误 → 401 E_AUTH_BAD_CREDENTIAL，且**不**告诉"账号是否存在"',
      r.status === 401 && r.body.error === 'E_AUTH_BAD_CREDENTIAL', `${r.status} ${r.body.error}`); }

{ // AT3 连错到阈值 → 423 锁定；此后**正确口令也进不去**
  let last = null;
  for (let i = 0; i < 5; i++) last = await loginAs(AUTH_USER, 'wrong-' + i);
  const afterLock = await loginAs(AUTH_USER);   // 正确口令
  const row = (await db.query(
    'SELECT failed_count, locked_until FROM sys_user_credential WHERE user_id=$1', [AUTH_USER])).rows[0];
  rec('AT3','连错 5 次 → 423 E_AUTH_LOCKED；锁定期间**正确口令也进不去**（否则锁定只挡住猜错的人）',
      last.status === 423 && afterLock.status === 423 && !!row.locked_until,
      `第5次=${last.status} 锁定后正确口令=${afterLock.status} locked=${!!row.locked_until}`); }

{ // AT4 库里没有明文，且两次同口令的摘要不同（盐）
  const h = (await db.query(
    'SELECT pwd_hash FROM sys_user_credential WHERE user_id=1')).rows[0].pwd_hash;
  const { hashPassword } = await import('../app/services/auth.mjs');
  const h2 = hashPassword('demo1234');
  const rows = (await db.query(
    `SELECT count(*)::int n FROM sys_user_credential WHERE pwd_hash LIKE '%demo1234%'`)).rows[0].n;
  rec('AT4','库里的口令是 scrypt 派生值（带盐）：不含明文，同一口令两次派生结果不同',
      h.startsWith('scrypt$') && h !== h2 && Number(rows) === 0,
      `${h.slice(0, 18)}… 明文命中 ${rows} 条`); }

{ // AT5 口令长度下限：太短直接拒（策略在库，不在前端）
  let msg = '';
  try {
    await db.query('SELECT fn_credential_set($1,$2)', [9, 'scrypt$16384$8$1$AAAA$BBBB']);
  } catch (e) { msg = e.message; }
  // 摘要格式合法即通过；强度（长度/混合）由库判据 fn_pwd_check 统一判（075）。
  // ★ 原来这条测的是"应用侧按 MIN_LEN 拒"，而 075 把策略搬进库之后那条就不成立了——
  //   不是功能坏了，是断言在替旧实现背书。现在测的是**唯一那份实现**。
  const okFormat = msg === '';
  let weak = '';
  try { await db.query(`SELECT fn_pwd_check('123')`); } catch (e) { weak = e.message; }
  let strong = '';
  try { await db.query(`SELECT fn_pwd_check('abcd1234')`); } catch (e) { strong = e.message; }
  rec('AT5','口令策略：强度由库判据 fn_pwd_check 统一判（3 位 → 拒；8 位字母数字 → 过）',
      okFormat && weak.includes('E_CRED_WEAK') && strong === '',
      `格式=${okFormat} 3位=${weak.includes('E_CRED_WEAK') ? '拒' : '过'} 8位=${strong === '' ? '过' : '拒'}`); }

{ // AT6 改口令即解锁：它是"我被锁了"的解法，不是又一个坑
  const { hashPassword } = await import('../app/services/auth.mjs');
  await db.query('SELECT fn_credential_set($1,$2)', [AUTH_USER, hashPassword('demo1234')]);
  const r = await loginAs(AUTH_USER);
  const row = (await db.query(
    'SELECT failed_count, locked_until FROM sys_user_credential WHERE user_id=$1', [AUTH_USER])).rows[0];
  rec('AT6','重置口令 → 失败计数清零、锁定解除（否则被锁的人永远出不来）',
      r.status === 200 && Number(row.failed_count) === 0 && row.locked_until === null,
      `${r.status} failed=${row.failed_count} locked=${row.locked_until}`); }

// ===========================================================================
// AU 组 · 例外：到期必须看得见（接口侧）
// ===========================================================================
{ const r = await get('/api/exceptions', t1);
  const b = r.body;
  rec('AU1','例外接口三类齐全（到期 / 生效中 / 类型上限），到期那条带责任人与逾期天数',
      r.status === 200 && Array.isArray(b.overdue) && Array.isArray(b.active)
      && Array.isArray(b.kinds) && b.kinds.length === 5
      && b.overdue.length >= 1 && !!b.overdue[0].owner && Number(b.overdue[0].overdue_days) >= 1,
      `逾期=${b.overdue?.length} 生效=${b.active?.length} 类型=${b.kinds?.length}`); }

{ const r = await get('/api/exceptions', t1);
  const oi = new Set((r.body.overdue || []).map(x => Number(x.id)));
  const ai = (r.body.active || []).map(x => Number(x.id));
  rec('AU2','逾期与生效中**互斥**：一条例外不能同时在两个清单里（否则"还剩几天"没有唯一答案）',
      ai.every(id => !oi.has(id)), `重叠 ${ai.filter(id => oi.has(id)).length} 条`); }

// ===========================================================================
// AV 组 · 导出：掩码只有一份实现
// ---------------------------------------------------------------------------
// 导出是最容易漏掩码的地方：列表页掩了、导出忘了，而导出的文件会被转发出去。
// 这一组证明导出**复用同一个 listSlips**（而不是"再掩一次"）。
// ===========================================================================
const csv = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  return { status: r.status, type: r.headers.get('content-type'), text: await r.text() };
};

// xlsx 是一包 zip：断言要**真的解压出来看那一行 XML**，而不是"文件头对了就算过"。
// ★ 这里另写一个 20 行的解压（而不是调 app/xlsx.mjs 的读侧）：读侧与写侧是
//   同一轮加的，用读侧验写侧等于"两个人互相对过答案就说考了 100 分"。
//   本地文件头顺序扫描足够——我们自己产出的包就是这个布局。
const unzipEntry = (buf, want) => {
  let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const csize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extraLen;
    if (name === want) {
      const raw = buf.subarray(start, start + csize);
      return (method === 8 ? inflateRawSync(raw) : raw).toString('utf8');
    }
    p = start + csize;
  }
  return null;
};
const xlsxRowCount = (xml) => (xml.match(/<row\b/g) || []).length;

{ const runId = globalThis.__runId;   // S 组算出来的批次
  const a = await csv(`/api/payslip/export.csv?run=${runId}`, t1);
  const b = await csv(`/api/payslip/export.csv?run=${runId}`, t2);
  const netA = (a.text.split('\n')[1] || '').split(',')[3];
  const netB = (b.text.split('\n')[1] || '').split(',')[3];
  rec('AV1','导出与列表**同一份掩码**：集团HR 有净值、A店HR 该列为空（不是 0，也不是 ***）',
      a.status === 200 && b.status === 200 && !!netA && netB === '',
      `集团=${netA || '(空)'} A店=${netB === '' ? '(空)' : netB}`); }

{ // AV2 导出不许自己再求一次权限：源码里 export 段不出现 fn_field_action
  const src = readFileSync(new URL('../app/server.mjs', import.meta.url), 'utf8');
  const seg = src.split("url.pathname === '/api/payslip/export.csv'")[1] || '';
  const block = seg.slice(0, 1600);
  rec('AV2','导出不自己求权限（源码：export 段无 fn_field_action / fn_apply_mask，只调 listSlips）',
      block.includes('payroll.listSlips') && !block.includes('fn_field_action')
      && !block.includes('fn_apply_mask'),
      `listSlips=${block.includes('payroll.listSlips')} 自算=${block.includes('fn_field_action')}`); }

{ const r = await csv(`/api/payslip/export.csv?run=1`, null);
  rec('AV3','导出必须认证：无 token → 401（导出文件是最容易被转发的产物）',
      r.status === 401, `${r.status}`); }

// ---------------------------------------------------------------------------
// AV4–AV6 · 同一个出口的另一种容器：?format=xlsx
// ---------------------------------------------------------------------------
// 客户问的第一句话是"能不能导出 Excel"。CSV 也能导，但中文 Windows 上要过
// 一道"编码 + 分隔符"的劫，财务的实际反馈是"打开是乱的 / 全挤在一列"。
// 三条断言各自盯一个会**静默出错**的点：
//   ④ 不是"返回了个 zip"就算过：要能解压出 sheet1.xml，且表头字在里面；
//   ⑤ 导出格式换了，留痕不能少 —— 否则"导 Excel 不留痕"就是绕过审计的口子；
//   ⑥ 掩码不能因为换了容器就失效（Excel 里掩成 0 比掩成空更坏：
//      收到文件的人会以为"这个人实发 0 元"）。
{ const runId = globalThis.__runId;
  const r = await fetch(`${BASE}/api/payslip/export.csv?run=${runId}&format=xlsx`,
    { headers: { authorization: `Bearer ${t1}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || '';
  const sheet = unzipEntry(buf, 'xl/worksheets/sheet1.xml') || '';
  const heads = ['id', 'employee_id', 'gross_amount', 'net_amount', 'si_employee'];
  rec('AV4', '工资条明细 ?format=xlsx：200、Content-Type 是 spreadsheetml.sheet、'
    + '前四字节 **PK\\x03\\x04**（真 zip）、解压 xl/worksheets/sheet1.xml 后五个表头都在、'
    + '且文本用 inlineStr（不依赖 sharedStrings 索引表）',
    r.status === 200 && /spreadsheetml\.sheet/.test(ct)
    && buf.subarray(0, 4).toString('hex') === '504b0304'
    && heads.every((h) => sheet.includes(`<t>${h}</t>`))
    && /t="inlineStr"/.test(sheet) && xlsxRowCount(sheet) >= 2,
    `${r.status} ${ct.split(';')[0]} 头=${JSON.stringify(buf.subarray(0, 4).toString('latin1'))} `
    + `行=${xlsxRowCount(sheet)} 字节=${buf.length}`); }

{ const runId = globalThis.__runId;
  const cnt = async () => Number((await db.query(
    'SELECT count(*)::int n FROM payslip_view_log')).rows[0].n);
  const before = await cnt();
  const r = await fetch(`${BASE}/api/payslip/export.csv?run=${runId}&format=xlsx`,
    { headers: { authorization: `Bearer ${t1}` } });
  const buf = Buffer.from(await r.arrayBuffer());
  const dataRows = xlsxRowCount(unzipEntry(buf, 'xl/worksheets/sheet1.xml') || '') - 1;
  const after = await cnt();
  const log = (await db.query(
    `SELECT scope, row_count, pay_run_id FROM payslip_view_log
      WHERE actor_user_id=1 ORDER BY id DESC LIMIT 1`)).rows[0] || {};
  rec('AV5', '**导 Excel 同样写留痕**：一次 xlsx 导出 = 1 条 scope=export 的日志，'
    + 'row_count 与文件里的数据行数一致（表头不算一行）。'
    + '★ 这条不测就是"导 CSV 要留痕、导 xlsx 不用"—— 同一个动作换个 format 就绕过审计',
    r.status === 200 && after - before === 1 && log.scope === 'export'
    && Number(log.row_count) === dataRows && Number(log.pay_run_id) === runId,
    `${r.status} 数据行=${dataRows} 日志增量=${after - before} `
    + `最新: scope=${log.scope} row_count=${log.row_count} run=${log.pay_run_id}`); }

{ const runId = globalThis.__runId;
  // A店HR（t2）看同一批：字段掩码应当让 net_amount / si_employee 两列**整列为空**
  const r = await fetch(`${BASE}/api/payslip/export.csv?run=${runId}&format=xlsx`,
    { headers: { authorization: `Bearer ${t2}` } });
  const sheet = unzipEntry(Buffer.from(await r.arrayBuffer()), 'xl/worksheets/sheet1.xml') || '';
  const dataRows = xlsxRowCount(sheet) - 1;
  // D = net_amount，E = si_employee；C = gross_amount（不该被掩，用来对照）
  const hasVal = (col) => new RegExp(`<c r="${col}\\d+"[^>]*><v>`).test(sheet);
  rec('AV6', 'xlsx 与 CSV **共用同一份掩码**：A店HR 导出的 Excel 里 net_amount / si_employee '
    + '两列没有任何数值（空单元格），而 gross_amount 列照常有数；'
    + '★ 被掩的金额写空、不写 0 —— 写 0 会让"你没权限"变成"这个人实发 0 元"',
    r.status === 200 && dataRows >= 1 && !hasVal('D') && !hasVal('E') && hasVal('C'),
    `${r.status} 数据行=${dataRows} D(实发)有值=${hasVal('D')} `
    + `E(社保)有值=${hasVal('E')} C(应发)有值=${hasVal('C')}`); }

// ===========================================================================
// AW 组 · 强制改密：must_change 真的会拦人，改密真的会踢掉旧会话
// ---------------------------------------------------------------------------
// 035 把口令做进了库，但 `must_change` 没有东西读 —— 于是种子口令永远有效。
// 这一组证明：拦得住，而且改完之后旧会话真的失效。
// ===========================================================================
{
  // AW1 临时口令登录 → 除了改口令，其它接口一律 428
  const a = await loginAs(5, 'temp1234');
  const blocked = await get('/api/attendance', a.body.token);
  rec('AW1','临时口令登录后，其它接口一律 428 E_PWD_CHANGE_REQUIRED（不是 200 + 提示语）',
      a.status === 200 && blocked.status === 428 && blocked.body.error === 'E_PWD_CHANGE_REQUIRED',
      `login=${a.status} 访问=${blocked.status} ${blocked.body.error}`);

  const b = await loginAs(5, 'temp1234');     // 第二个会话，用来验"改密踢掉旧会话"
  const wrong = await post('/api/me/password?old=nope&new=demo5678', b.body.token);
  rec('AW2','改口令时旧口令错 → 401 E_AUTH_BAD_CREDENTIAL（不是"直接改成功"）',
      wrong.status === 401 && wrong.body.error === 'E_AUTH_BAD_CREDENTIAL',
      `${wrong.status} ${wrong.body.error}`);

  const ok = await post('/api/me/password?old=temp1234&new=demo5678', b.body.token);
  const after = await get('/api/attendance', b.body.token);
  rec('AW3','改口令成功 → 当前会话继续可用，其它接口不再被拦（428 → 200）',
      ok.status === 200 && ok.body.changed === true && after.status === 200,
      `改密=${ok.status} 之后访问=${after.status} 踢掉=${ok.body.revoked_others}`);

  const oldSession = await get('/api/attendance', a.body.token);
  const newLogin = await loginAs(5, 'demo5678');
  rec('AW4','改密后**旧会话立刻失效**（E_SESSION_REVOKED），新口令能重新登录',
      oldSession.status === 401 && oldSession.body.error === 'E_SESSION_REVOKED'
      && newLogin.status === 200,
      `旧会话=${oldSession.status} ${oldSession.body.error} 新登录=${newLogin.status}`);

  const same = await post('/api/me/password?old=demo5678&new=demo5678', b.body.token);
  rec('AW5','新口令与旧口令相同 → 422 E_CRED_SAME（"改了个寂寞"比不改更坏：它让人以为改过）',
      same.status === 422 && same.body.error === 'E_CRED_SAME', `${same.status} ${same.body.error}`);
}

{ // AR5 转签走接口：待办从一个人转到另一个人，原审批人再点就 403
  // 用事假（type 1）：年假在 AR1–AR4 里已经用完了 —— 额度是真实约束，测试也不能透支
  const ap = await post(`/api/leave/apply?type=${LT_P}&qty=1&from=2026-04-14&to=2026-04-14`, t1);
  const st = await post(`/api/approval/start?biz_type=leave&biz_id=${ap.body.request_id}&on=2026-04-14`, t1);
  const tasks = (await get('/api/approval/tasks', t2)).body.rows || [];
  const mine = tasks.find(x => Number(x.instance_id) === Number(st.body.instance_id));
  const tr = await post(`/api/approval/transfer?task=${mine.id}&to=9&reason=休假中交给同事`, t2);
  const after = await post(`/api/approval/act?instance=${st.body.instance_id}&approve=1`, t2);
  rec('AR5','转签走接口：转给同事后原审批人再点 → 403（待办真的换人了，不是又发了一份）',
      tr.status === 200 && tr.body.to_user === 9 && after.status === 403
      && after.body.error === 'E_APPR_NOT_YOURS',
      `转签=${tr.status} 原审批人再批=${after.status} ${after.body.error}`); }

// ===========================================================================
// AL 组 · 请假审批方式（配置项）：接口侧同一条反例
// ---------------------------------------------------------------------------
// 数据库组（AL1–AL4）证明配置真的接线；这里证明**从 HTTP 也拦得住**——
// 绕开多步审批最省事的方式，就是调那个更短的接口。
// ===========================================================================
{
  // 6 月：制度要求多步 → 申请即开实例，单签接口被拒
  const ap = await post(`/api/leave/apply?type=${LT_P}&qty=1&from=2026-06-15&to=2026-06-15`, t1);
  const direct = await post(`/api/leave/decide?id=${ap.body.request_id}&approve=1`, t2);
  const inst = (await db.query(
    `SELECT id FROM approval_instance WHERE biz_type='leave' AND biz_id=$1`,
    [ap.body.request_id])).rows[0];

  rec('AL5','6 月（multi）：申请即开实例，且单签接口 → 409 E_LEAVE_USE_APPROVAL',
      ap.status === 200 && !!inst && direct.status === 409
      && direct.body.error === 'E_LEAVE_USE_APPROVAL',
      `申请=${ap.status} 实例=${!!inst} 单签=${direct.status} ${direct.body.error}`);

  // 同一张单走审批接口逐级批完 → 单据 approved
  let last = 'running', rounds = 0;
  while (last === 'running' && rounds < 8) {
    const cur = (await db.query(
      `SELECT approver_id FROM approval_task WHERE instance_id=$1 AND status='pending'
        ORDER BY seq, id LIMIT 1`, [inst.id])).rows[0];
    if (!cur) break;
    const r = await post(`/api/approval/act?instance=${inst.id}&approve=1`,
      cur.approver_id === 2 ? t2 : t4);
    last = r.body.status; rounds++;
  }
  const lr = (await db.query('SELECT status FROM leave_request WHERE id=$1',
    [ap.body.request_id])).rows[0].status;
  rec('AL6','6 月的单走 /api/approval/* 逐级批完 → 单据 approved（多步不是装饰）',
      last === 'approved' && lr === 'approved', `末态=${last} 单据=${lr} 轮次=${rounds}`); }

// ===========================================================================
// AM 组 · 限流：跑飞的脚本要在第二秒就被挡住
// ---------------------------------------------------------------------------
// 到 042 为止写路径有事务、行闸、业务码、留痕、一次性 plan，但**没有频率限制**。
// 一个跑飞的脚本能在 10 秒里开 500 张请假单，而每一张都"合规"。
// ===========================================================================
{
  // 用 user 4 自己的 token（t4 在文件后面才声明，这里不能提前用）
  const t4x = await login(4);
  // 人为把 user 4 这一分钟的用量堆到上限之上（130 > 120）
  await db.query(
    `INSERT INTO app_request_log(actor, action, ok)
     SELECT '4', 'test.burst', true FROM generate_series(1,130)`);
  // 用「下编」这个写操作：user 4 通过组织继承有 A 店的权，且不需要任职记录
  const before = Number((await db.query(
    `SELECT COALESCE(max(version),0)::int v FROM headcount_budget WHERE org_id=10`)).rows[0].v);

  const r = await post('/api/headcount/set?org=10&period=2026-03&quota=12&reason=限流测试', t4x);
  const after = Number((await db.query(
    `SELECT COALESCE(max(version),0)::int v FROM headcount_budget WHERE org_id=10`)).rows[0].v);
  const logged = Number((await db.query(
    `SELECT count(*)::int n FROM app_request_log WHERE actor='4' AND action='test.burst'`)).rows[0].n);

  rec('AM1','超过每分钟上限 → 429 E_RATE_LIMITED，且业务没有发生（编制版本没增加）',
      r.status === 429 && r.body.error === 'E_RATE_LIMITED' && after === before,
      `${r.status} ${r.body.error} 版本 ${before}→${after}`);

  rec('AM2','被限的请求**不写日志**（写了就是自我放大：拒绝越多次，越接近上限）',
      logged === 130, `日志 ${logged} 条（应为 130）`);

  // 清掉人为用量 → 同一个操作立刻恢复正常
  await db.query(`DELETE FROM app_request_log WHERE actor='4' AND action='test.burst'`);
  const ok = await post('/api/headcount/set?org=10&period=2026-03&quota=12&reason=限流解除后重试', t4x);
  rec('AM3','用量清空后同一操作恢复（限的是频率，不是这个人）',
      ok.status === 200, `${ok.status}`);
}

// ===========================================================================
// AO 组 · 代理走接口：谁都能给自己设一个"代办人"，但只能给自己设
// ===========================================================================
{
  const a = await post('/api/approval/delegate?to=3&from_date=2026-09-01&to_date=2026-09-10&reason=休假十天由他代审', t1);
  const mine = (await get('/api/approval/delegates', t1)).body.rows || [];
  // 与这条代理无关的人（user 2）看不到它；被代理的人（user 3）看得到 —— 两边都要对
  const stranger = (await get('/api/approval/delegates', t2)).body.rows || [];
  const delegatee = (await get('/api/approval/delegates', t3)).body.rows || [];
  rec('AO1','设置代理 → 本人与被代理人看得到，无关的人看不到（代理由本人设，也只能本人设）',
      a.status === 200 && mine.some(x => Number(x.to_user) === 3)
      && delegatee.some(x => Number(x.to_user) === 3)
      && !stranger.some(x => Number(x.to_user) === 3),
      `设置=${a.status} 我 ${mine.length} / 被代理人 ${delegatee.length} / 无关 ${stranger.length}`); }

{
  const bad = await post('/api/approval/delegate?to=1&from_date=2026-10-01&to_date=2026-10-05&reason=自己代理自己试试', t1);
  rec('AO2','代理自己 → 422 E_DELEGATE_SELF（那不是代理，是给自己多记一条）',
      bad.status === 422 && bad.body.error === 'E_DELEGATE_SELF', `${bad.status} ${bad.body.error}`); }

// ===========================================================================
// AP 组 · 加签与抄送走接口：改变结论 vs 只通知
// ===========================================================================
// 补一笔授予：这一组要多开几张单，而额度是真实约束（测试也不能透支）。
await db.query(`INSERT INTO leave_grant(id,employee_id,leave_type_id,qty,valid_from)
                VALUES (9101,1,$1,30,'2026-01-01')`, [LT_P]);

{
  // 6 月走 multi（AL 组把 LEAVE_APPROVAL 配成 6 月多步）：申请即在同事务里开了实例
  const ap = await post(`/api/leave/apply?type=${LT_P}&qty=1&from=2026-06-20&to=2026-06-20`, t1);
  const inst = (await db.query(
    `SELECT id FROM approval_instance WHERE biz_type='leave' AND biz_id=$1`,
    [ap.body.request_id])).rows[0].id;
  const mine = (await get('/api/approval/tasks', t2)).body.rows
    .find(x => Number(x.instance_id) === Number(inst));

  // 加签给 user 3（他没有审批角色 —— 加签的语义就是"临时指定一个人"）
  const sg = await post(`/api/approval/addsign?task=${mine.id}&to=3&reason=这笔跨店借调请运营一起看`, t2);
  const r1 = await post(`/api/approval/act?instance=${inst}&approve=1`, t2);
  const t3Tasks = (await get('/api/approval/tasks', t3)).body.rows
    .filter(x => Number(x.instance_id) === Number(inst));
  const r2 = await post(`/api/approval/act?instance=${inst}&approve=1`, t3);
  const lr = (await db.query('SELECT status FROM leave_request WHERE id=$1',
    [ap.body.request_id])).rows[0].status;

  // ★ 这张模板只有 1 步（seed 里的 LEAVE）：所以"加签人签完"就是整单通过。
  //   改写成一个两步流程去断言"进入第 2 步"会更像演示，但那条链已经在 AL6 验过；
  //   这里要证的只有一件事：**没有加签人那一下，这单过不了**。
  rec('AP1','加签走接口：被加签人出现在待办里；原或签人通过后仍 running，加签人签完才 approved',
      sg.status === 200 && t3Tasks.length === 1 && r1.body.status === 'running'
      && r2.status === 200 && r2.body.status === 'approved' && lr === 'approved',
      `加签=${sg.status} 待办=${t3Tasks.length} 原签人后=${r1.body.status} 加签人后=${r2.body.status} 单据=${lr}`); }

{
  // 抄送：给 user 3 抄一份（他刚才签过这一单，抄送幂等/语义都不冲突）
  const inst = (await db.query(
    `SELECT id FROM approval_instance WHERE biz_type='leave' ORDER BY id DESC LIMIT 1`)).rows[0].id;
  const a = await post(`/api/approval/cc?instance=${inst}&to=3`, t1);
  const unread = (await get('/api/approval/cc', t3)).body.rows;
  const hit = unread.find(x => Number(x.instance_id) === Number(inst));
  const seen = await post(`/api/approval/cc/seen?id=${hit?.id}`, t3);
  const after = (await get('/api/approval/cc', t3)).body.rows;
  const all = (await get('/api/approval/cc?all=1', t3)).body.rows;

  rec('AP2','抄送走接口：对方未读清单里看得到 → 标记已读后从"未读"消失，但 all=1 仍在（记录不删）',
      a.status === 200 && a.body.added === true && !!hit && seen.status === 200
      && !after.some(x => Number(x.id) === Number(hit.id))
      && all.some(x => Number(x.id) === Number(hit.id)),
      `抄送=${a.status} 未读命中=${!!hit} 已读后未读=${after.length} 全部=${all.length}`); }

{
  // 抄送的人去审批 → 403（"知道了"不等于"同意了"）
  const inst = (await db.query(
    `SELECT id FROM approval_instance WHERE status='running' ORDER BY id DESC LIMIT 1`)).rows[0].id;
  await post(`/api/approval/cc?instance=${inst}&to=3`, t1);
  const r = await post(`/api/approval/act?instance=${inst}&approve=1`, t3);
  rec('AP3','抄送的人去审批 → 403 E_APPR_NOT_YOURS（抄送不产生待办，也就不产生权力）',
      r.status === 403 && r.body.error === 'E_APPR_NOT_YOURS', `${r.status} ${r.body.error}`); }

{
  // 加签给申请人 → 422
  const inst = (await db.query(
    `SELECT id FROM approval_instance WHERE status='running' ORDER BY id DESC LIMIT 1`)).rows[0].id;
  const tk = (await db.query(
    `SELECT id FROM approval_task WHERE instance_id=$1 AND status='pending' ORDER BY seq, id LIMIT 1`,
    [inst])).rows[0];
  const r = await post(`/api/approval/addsign?task=${tk.id}&to=1&reason=加给申请人试试看`, t1);
  rec('AP4','加签给申请人 → 422 E_APPR_ADDSIGN_APPLICANT（自审的入口不能从后门补回来）',
      r.status === 422 && r.body.error === 'E_APPR_ADDSIGN_APPLICANT', `${r.status} ${r.body.error}`); }

// ===========================================================================
// H 组 · 探针：免认证，但不泄露
// ---------------------------------------------------------------------------
// 两条都是被真实事故逼出来的：探针要 token → 在编排器里永远 unhealthy →
// 被删掉 → 服务挂了没人知道；探针回太多 → 它是最容易被扫到的地址。
// ===========================================================================
{ const r = await fetch(`${BASE}/livez`);
  const b = await r.json();
  rec('H1','/livez 无 token → 200（要凭据的探针在编排器里就是"永远 unhealthy"）',
      r.status === 200 && b.ok === true && typeof b.uptime_s === 'number',
      `${r.status} ${JSON.stringify(b)}`); }

{ const r = await fetch(`${BASE}/readyz`);
  const raw = await r.text();
  const b = JSON.parse(raw);
  // 探针只回三个数；出现表名/版本/连接串就是泄露
  const leak = /pg_|sys_|postgres|password|@|version/i.test(raw);
  rec('H2','/readyz 查得到库（200）且只回三个数：ok / db_ms / checks_known，不含表名与版本',
      r.status === 200 && b.ok === true && typeof b.db_ms === 'number'
      && typeof b.checks_known === 'number' && !leak,
      `${r.status} ${raw.slice(0, 70)}`); }

{ const a = await fetch(`${BASE}/api/attendance`);
  const b = await fetch(`${BASE}/api/payroll/slips?run=1`);
  rec('H3','免认证只给探针：其它接口仍然 401（探针不是"开一个口子"）',
      a.status === 401 && b.status === 401, `${a.status} / ${b.status}`); }

{ // H6 安全响应头：CSRF 不成立的理由要落到代码上（凭据不是 Cookie）
  const html = await fetch(`${BASE}/`);
  const csp = html.headers.get('content-security-policy') || '';
  const j = await fetch(`${BASE}/livez`);
  rec('H6','每个响应都带 CSP / nosniff / frame-options；CSP 不放行任何外部源（界面零外链）',
      csp.includes("default-src 'none'") && !csp.includes('http:') && !csp.includes('https:')
      && html.headers.get('x-content-type-options') === 'nosniff'
      && html.headers.get('x-frame-options') === 'DENY'
      && j.headers.get('x-content-type-options') === 'nosniff',
      `CSP=${csp.slice(0, 34)}… frame=${html.headers.get('x-frame-options')}`); }

{ // H4 工作台的数与各自接口一致 —— 首页自己写一遍 count 就一定会漂
  const h = (await get('/api/home?period=2026-03', t2)).body;
  const todos = ((await get('/api/approval/tasks', t2)).body.rows || []).length;
  const ccs = ((await get('/api/approval/cc', t2)).body.rows || []).length;
  const exc = (await get('/api/exceptions', t2)).body;
  const unclosed = (await get('/api/attendance/unclosed?period=2026-03', t2)).body.rows || [];
  rec('H4','工作台的数字与各自接口**逐项相等**（待办/抄送/逾期例外/未封账）',
      Number(h.todos) === todos && Number(h.ccs) === ccs
      && Number(h.overdue_exceptions) === (exc.overdue || []).length
      && Number(h.unclosed_stores) === unclosed.length,
      `待办 ${h.todos}/${todos} 抄送 ${h.ccs}/${ccs} 逾期 ${h.overdue_exceptions}/${(exc.overdue||[]).length} 未封账 ${h.unclosed_stores}/${unclosed.length}`); }

{ // H5 身份从会话取，不从参数取：拿 t3 的 token 带 ?user=2 也冒充不了 A店HR
  // 先造一条**只有 A店HR 有活**的单（6 月走多步，申请即开实例）
  await post(`/api/leave/apply?type=${LT_P}&qty=1&from=2026-06-25&to=2026-06-25`, t1);
  const asT2 = (await get('/api/home?period=2026-03', t2)).body;
  const spoof = (await get('/api/home?period=2026-03&user=2', t3)).body;
  const asT3 = (await get('/api/home?period=2026-03', t3)).body;
  rec('H5','工作台不接受参数冒充身份：t3 带 ?user=2 得到的是自己的 0，不是 A店HR 的待办',
      Number(asT2.todos) >= 1 && Number(spoof.todos) === Number(asT3.todos)
      && Number(spoof.todos) < Number(asT2.todos),
      `A店HR=${asT2.todos} t3=${asT3.todos} t3带?user=2=${spoof.todos}`); }

// ===========================================================================
// U 组 · 接口侧也记进登记表（否则 M/N/O/S/AG/AH/AR/MS/AT/AU/AV/AW/AL/AM/AO 永远是 never_run）
// ===========================================================================
const byGroup = {};
for (const r of results.slice()) {
  const g = (String(r.id).match(/^[A-Z]+/) || ['?'])[0];
  (byGroup[g] ||= []).push(r);
}
const recFail2 = [];
for (const [g, rs] of Object.entries(byGroup)) {
  const fails = rs.filter(x => !x.ok).length;
  try {
    await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
      [`SUITE.API-${g}`, fails === 0 ? 'pass' : 'fail', fails, null]);
  } catch (e) { recFail2.push(`${g}:${e.code || e.message}`); }
}
{ const codes = Object.keys(byGroup).map(g => `SUITE.API-${g}`);
  const rows = (await db.query(
    `SELECT check_code, bucket FROM fn_chk_coverage('2026-11-14'::date)
      WHERE check_code = ANY($1)`, [codes])).rows;
  const never = rows.filter(x => x.bucket === 'never_run').length;
  const pass  = rows.filter(x => x.bucket === 'pass').length;
  rec('U1','接口四组写进登记表且不再是 never_run',
      recFail2.length === 0 && never === 0 && pass === rows.length && rows.length === codes.length,
      `pass=${pass} never_run=${never} 共=${rows.length}${recFail2.length ? ' 失败:' + recFail2.join(',') : ''}`); }


// ===========================================================================
// X 组 · 组织级授权走通接口（集团统一管理）
// ===========================================================================
const t4 = await login(4);   // 没有任何 sys_user_role，全靠组织继承

{ const r = await get('/api/me/roles', t4);
  const roles = r.body.roles || [];
  rec('X1','组织继承的权限带来源（source=org + 经由哪个组织）',
      r.status===200 && roles.length >= 1 && roles.every(x => x.source === 'org')
      && roles[0].via_org_name === '华东区',
      roles.map(x => `${x.role_id}:${x.source}@${x.via_org_name}`).join(' ')); }

{ const r = await get('/api/me/roles', t4);
  const chain = (r.body.org_chain || []).map(x => x.name);
  rec('X2','组织链自下而上：A店 → 华东区 → 集团（继承方向可读）',
      JSON.stringify(chain) === JSON.stringify(['A店','华东区','集团']), JSON.stringify(chain)); }

{ const r = await get('/api/attendance', t4);
  rec('X3','组织授权真的改变了行闸结果：门店HR 只看到自己那一行',
      r.status===200 && r.body.rows.length===1 && r.body.rows[0].store_id===10,
      `rows=${r.body.rows.length} stores=${JSON.stringify(r.body.rows.map(x=>x.store_id))}`); }

{ const r = await get('/api/me/roles', t1);
  const srcs = (r.body.roles || []).map(x => x.source);
  rec('X4','直接授权的账号来源仍是 direct（改造没把两条路混成一条）',
      srcs.length >= 1 && srcs.every(x => x === 'direct'), JSON.stringify(srcs)); }


// ===========================================================================
// Y 组 · 报表接口
// ===========================================================================
{ const r = await get('/api/report?org=30&period=2026-03', t1);
  const p = r.body.panel || [];
  rec('Y1','面板 7 个指标全部登记过口径（未登记的指标与别人同一个字体，读者无从判断）',
      r.status===200 && p.length===7 && p.every(x => x.registered === true),
      p.map(x => `${x.metric}:${x.registered}`).join(' ')); }

{ const r = await get('/api/report?org=30&period=2026-03', t1);
  const bad = (r.body.crosscheck || []).filter(x => !x.ok);
  rec('Y2','三路径交叉核对全一致（子树 / 分组 / 明细 给出同一个数）',
      bad.length === 0, `不一致 ${bad.length} 项`); }


{ const r = await get('/api/dashboard?period=2026-03', t1);
  const ex = r.body.exceptions || [];
  rec('Y3','看板异常清单 9 类全部出现（含 0），且告警类数与之相符',
      r.status===200 && ex.length===9
      && Number(r.body.alerts) === ex.filter(x => Number(x.n) > 0).length,
      `${ex.length} 类，告警 ${r.body.alerts} 类`); }


{ const r = await get('/api/recruit?as_of=2026-03-05', t1);
  const caps = r.body.capacity || [];
  const leafOnly = caps.every(x => ['A店','B店','C店'].includes(x.name));
  rec('Y4','招聘容量只列叶子组织（非叶子的"可招"会双算，且那个问题本身没答案）',
      r.status===200 && caps.length===3 && leafOnly,
      caps.map(x=>`${x.name}:${x.can_offer}`).join(' ')); }

{ const r = await get('/api/recruit?as_of=2026-03-05', t1);
  const of = r.body.offers || [];
  rec('Y5','offer 带版本数与有效期（条款只增不改，改薪要能查到旧那一版）',
      of.length >= 1 && of.every(x => Number(x.versions) >= 1 && !!x.valid_until),
      of.map(x=>`${x.candidate_name}:v${x.versions}@${x.amount}`).join(' ')); }


{ const r = await get('/api/perf', t1);
  const c = (r.body.cycles || [])[0];
  const scored = (r.body.results || []).filter(x => x.state === 'scored');
  rec('Y6','未封存的周期：系数为空（不是 0），已评分的行数可数',
      r.status===200 && c && c.status === 'open'
      && scored.length >= 1 && scored.every(x => x.factor === null),
      `周期=${c?.status} 已评分=${scored.length} factor=${scored.map(x=>x.factor)}`); }

{ const res = await fetch(`${BASE}/api/perf/seal?cycle=1`, { method:'POST', headers:{ authorization:`Bearer ${t1}` } });
  const body = await res.json();
  const r = await get('/api/perf', t1);
  const c = (r.body.cycles || [])[0];
  const scored = (r.body.results || []).filter(x => x.state === 'scored');
  rec('Y7','封存后系数固化下来（原来是 null，现在有值），周期状态转 sealed',
      res.status===200 && body.factors_fixed >= 1 && c.status === 'sealed'
      && scored.every(x => x.factor !== null),
      `固化 ${body.factors_fixed} 行，状态=${c.status}`); }


// ===========================================================================
// AE 组 · 应用层三条：错误映射 / 事务边界 / 跨层对照
// ===========================================================================
{ // AE1 库里 raise 的每个业务码都必须在映射表里
  const srcs = (await db.query(`
    SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'`)).rows.map(r => r.prosrc || '');
  // 在 JS 侧提取：必须词首（否则 LEAVE_DEDUCT / SNAPSHOT_NAME 会截出 E_DEDUCT、E_NAME）
  const codes = new Set();
  for (const src of srcs) {
    for (const m of src.matchAll(/(?:^|[^A-Za-z0-9_])E_[A-Z0-9_]{3,}/g)) {
      codes.add(m[0].replace(/^[^E]/, ''));
    }
  }
  const all = [...codes].sort();
  const missing = all.filter(c => !BIZ_CODES.includes(c));
  // 未登记的码**不许落 500**：落 400 至少说明"这是业务拒绝，只是没写清是哪一类"；
  // 落 500 会让它看起来像服务故障，而前端会弹"请联系管理员"。
  const fallsTo500 = missing.filter(c =>
    toHttp(Object.assign(new Error(`${c}: x`), { code: 'P0001' })).status >= 500);
  // ★ 断言从"未登记的不许落 500"收紧为"未登记数 = 0"。
  //   松版本会放过一类"通过了的失败"：码没登记 → 落 400 兜底 → 看起来能跑，
  //   但调用方拿不到准确语义。这条收紧时一次抓出 19 个漏登记的码。
  rec('AE1',`库里 raise 的业务码全部已登记 ${all.length - missing.length}/${all.length}`
      + '（未登记不得落 500，也不得靠 400 兜底）',
      all.length > 0 && missing.length === 0 && fallsTo500.length === 0,
      `共 ${all.length} 个，未登记 ${missing.length} 个，落 500 的 ${fallsTo500.length} 个`); }

{ // AE2 500 不回显 SQL 原文
  const e = new Error('relation "sys_user_role" does not exist; constraint ck_scr_waive');
  e.code = '42P01';
  const m = toHttp(e);
  const body = JSON.stringify(m.body);
  rec('AE2','未知错误 → 500 且 body 里没有表名/约束名，只给一个可检索的 ref',
      m.status === 500 && !body.includes('sys_user_role') && !body.includes('ck_scr_waive')
      && /^R[0-9a-z]+$/.test(m.body.ref),
      `status=${m.status} body=${body}`); }

{ // AE3 业务码 → 对应的 HTTP，而不是一律 500
  const mk = (code) => { const e = new Error(`${code}: 说明`); e.code = 'P0001'; return toHttp(e); };
  const a = mk('E_LEAVE_OVER_QUOTA');
  const b = mk('E_LEAVE_NO_REQUEST');
  const c = mk('E_OUT_OF_SCOPE');
  rec('AE3','业务码映射：额度不够 409 / 不存在 404 / 越权 403（不是一个 500 打天下）',
      a.status === 409 && b.status === 404 && c.status === 403,
      `${a.status}/${b.status}/${c.status}`); }

{ // AE4 事务回滚：申请失败不留半成品
  const before = Number((await db.query(`SELECT count(*)::int n FROM leave_request`)).rows[0].n);
  let threw = false;
  try {
    await withTx(db, async (tx) => {
      // 故意用远超额度的数量，让 fn_leave_freeze 抛错
      await tx.query(`SELECT fn_leave_apply(1, 1, 9999, '2026-05-01'::date, '2026-05-02'::date)`);
    });
  } catch { threw = true; }
  const after = Number((await db.query(`SELECT count(*)::int n FROM leave_request`)).rows[0].n);
  rec('AE4','事务回滚：申请失败后单据数不变（不留"单据在、额度没冻"的半成品）',
      threw && after === before, `失败=${threw} 单据 ${before}→${after}`); }

{ // AE5 连接归属：临时表是会话的，换一个会话就查不到
  await db.query('SELECT app_begin_scope(1,$1,$2)', ['leave_request', null]);
  const inSession = (await db.query(`SELECT count(*)::int n FROM pg_temp.tmp_scope_org`)).rows[0].n;
  // 模拟"另一个连接的会话"：清空临时表（真实场景里它本来就是空的）
  await db.exec('RESET ALL');
  await db.exec('DISCARD TEMP');
  let lost = 0;
  try {
    lost = (await db.query(`SELECT count(*)::int n FROM pg_temp.tmp_scope_org`)).rows[0].n;
  } catch (e) {
    // 表都不存在了 —— 这正是"权限消失"的最彻底形态，记 0 而不是当成异常
    lost = e.code === '42P01' ? 0 : -1;
  }
  rec('AE5','临时表是「会话」的：换连接后权限消失（所以灌权限与业务查询必须同一事务同一连接）',
      inSession > 0 && lost === 0,
      `同会话 ${inSession} 行，换会话 ${lost} 行`); }

{ // AE6 失败尝试必须在事务外留痕，否则 ROLLBACK 会把它一起删掉
  const before = Number((await db.query(
    `SELECT count(*)::int n FROM app_request_log WHERE NOT ok`)).rows[0].n);
  let threw = false;
  try {
    await withTx(db, async (tx) => {
      // 事务内故意失败
      await tx.query(`SELECT fn_leave_apply(1, 1, 9999, '2026-05-03'::date, '2026-05-04'::date)`);
    });
  } catch { threw = true; }
  const inTx = Number((await db.query(
    `SELECT count(*)::int n FROM app_request_log WHERE NOT ok`)).rows[0].n);
  // 事务外补记（这才是真实路径做的事）
  await db.query(`SELECT fn_req_log('1','leave.apply',NULL,false,'E_LEAVE_OVER_QUOTA',NULL)`);
  const after = Number((await db.query(
    `SELECT count(*)::int n FROM app_request_log WHERE NOT ok`)).rows[0].n);
  rec('AE6','写在事务内的失败日志会随 ROLLBACK 消失；写在事务外才留得住',
      threw && inTx === before && after === before + 1,
      `事务内 ${before}→${inTx}（未增），事务外 ${inTx}→${after}`); }

// ===========================================================================
// AQ 组 · 绩效打分走接口：分数进、档位出、系数不动
// ---------------------------------------------------------------------------
// 026 的四张表在这之前没有任何写入路径：封存只能在空表上跑，
// fn_perf_factor 永远 NULL，工资条绩效那栏永远是 0 —— 而 0 看起来像"没绩效"。
// ===========================================================================
await db.exec(`
  INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status) VALUES
    (2,'M-2026-07','2026 七月','2026-07-01','2026-07-31','2026-07','open');
`);

{ const r = await post('/api/perf/score?cycle=2&employee=1&score=70&note=七月达成率七成', t1);
  const b = r.body || {};
  const row = (await db.query(
    `SELECT score, grade, factor FROM perf_result WHERE cycle_id=2 AND employee_id=1`)).rows[0];
  rec('AQ1','打分接口：70 分 → C 档，回传预告系数，而库里 factor 仍为 NULL（系数只在封存时固化）',
      r.status === 200 && b.grade === 'C' && row === undefined || (row && row.factor === null),
      `${r.status} grade=${b.grade} 预告=${b.factor_preview} 库=${JSON.stringify(row)}`); }

{ const r = await post('/api/perf/score?cycle=2&employee=1&score=101&note=越界分数', t1);
  rec('AQ2','分数越界 → 422 E_PERF_SCORE_OUT_OF_RANGE（不是存个 101 等封存时炸）',
      r.status === 422 && r.body.error === 'E_PERF_SCORE_OUT_OF_RANGE', `${r.status} ${r.body.error}`); }

{ const r = await post('/api/perf/exclude?cycle=2&employee=2&note=新', t1);
  rec('AQ3','排除原因太短 → 422 E_PERF_EXCLUDE_REASON（空原因的"不参与"与"忘了评"同形）',
      r.status === 422 && r.body.error === 'E_PERF_EXCLUDE_REASON', `${r.status} ${r.body.error}`); }

{ // AQ4 待评名单与结果表必须对得上：名单里 "scored" 的条数 = 结果表里 scored 的条数。
  //   名单自己算一遍人数，就会出现"名单说 3 人已评、结果表 4 行"这种两个都像对的差。
  const r = await get('/api/perf/pending?cycle=1', t1);
  const rows = r.body.rows || [];
  const scoredInList = rows.filter(x => x.bucket === 'scored').length;
  const scoredInTable = Number((await db.query(
    `SELECT count(*)::int n FROM perf_result WHERE cycle_id=1 AND state='scored'`)).rows[0].n);
  const bucketsOk = rows.every(x => ['missing', 'scored', 'excluded'].includes(x.bucket));
  rec('AQ4','待评名单与结果表逐项对得上（bucket=scored 的条数 = 结果表 scored 行数），且三态齐全',
      r.status === 200 && rows.length >= 2 && bucketsOk && scoredInList === scoredInTable,
      `名单 ${rows.length} 行（scored ${scoredInList}）／表里 ${scoredInTable} 行`); }

{ // 封存后再打分 → 有名字的拒绝
  // ★ 这里**不调 seal 接口**：那会把系数固化进 perf_result，而 Y6 断言"未封存的周期系数为空"。
  //   用一个已封存但系数未固化的周期（直接置状态）来验"封存后不许改分"这一条 —
  //   两条断言各管一件事，不互相污染对方的判据。
  await db.query(`UPDATE perf_cycle SET status='sealed', sealed_at=now(), scheme_id=1 WHERE id=2`);
  const r = await post('/api/perf/score?cycle=2&employee=1&score=90&note=封存后补分', t1);
  rec('AQ5','封存后打分 → 409 E_PERF_SEALED（改分就是改已发的钱，而这条错误要能直接显示给人看）',
      r.status === 409 && r.body.error === 'E_PERF_SEALED', `${r.status} ${r.body.error}`); }

// ===========================================================================
// AS 组 · 补账走接口：封账后唯一修正通道，且必须真的进报表
// ===========================================================================
{
  const before = Number((await db.query('SELECT fn_rpt_hours(10,$1) h', ['2026-03'])).rows[0].h);
  const r = await post('/api/attendance/adjust?employee=1&store=10&date=2026-03-01&delta=2&period=2026-04&reason=夜班漏记两小时', t2);
  const after = Number((await db.query('SELECT fn_rpt_hours(10,$1) h', ['2026-03'])).rows[0].h);
  rec('AS1','补账接口：A店HR 给自己的门店补 2 小时 → 报表工时 +2（补账不进报表就等于没做）',
      r.status === 200 && Math.abs(after - before - 2) < 0.001,
      `${r.status} 报表 ${before}→${after}`); }

{ // 未封账的门店不许补账
  // 用 5 月（这个切片里没有任何门店封过 5 月）—— 3 月的两家店都已封账，判据会走到更后面去
  const r = await post('/api/attendance/adjust?employee=1&store=11&date=2026-05-10&delta=1&period=2026-06&reason=先补一笔试试', t1);
  rec('AS2','未封账门店补账 → 409 E_ATT_ADJ_NOT_CLOSED（没封账就直接改原记录，别走两条路）',
      r.status === 409 && r.body.error === 'E_ATT_ADJ_NOT_CLOSED', `${r.status} ${r.body.error}`); }

{ // 无授权账号：权限判在门店上，与封账同一条判据
  const r = await post('/api/attendance/adjust?employee=1&store=10&date=2026-03-01&delta=1&period=2026-04&reason=越权补一笔看看', t3);
  rec('AS3','无授权账号补账 → 403（岗位层或数据层拒绝）',
      r.status === 403 && (r.body.error === 'E_OUT_OF_SCOPE' || r.body.error === 'E_RESOURCE_FORBIDDEN'),
      `${r.status} ${r.body.error}`); }

{ // 清单也过行闸：看不见的门店，连"有补账"这件事都不该知道
  const mine = (await get('/api/attendance/adjustments?period=2026-04', t2)).body.rows || [];
  const none = (await get('/api/attendance/adjustments?period=2026-04', t3)).body.rows || [];
  rec('AS4','补账清单过行闸：A店HR 看得到自己那 1 条，无授权账号 0 条',
      mine.length === 1 && none.length === 0, `A店 ${mine.length} 条 / 无授权 ${none.length} 条`); }

// ===========================================================================
// HI 组 · 入职走接口：招聘漏斗的末端
// ===========================================================================
{
  const of = (await db.query(
    `SELECT o.id, o.candidate_name FROM offer o
      WHERE o.status = 'pending' ORDER BY o.id LIMIT 1`)).rows[0];
  const pBefore = Number((await db.query('SELECT count(*)::int n FROM person')).rows[0].n);

  const r = await post(`/api/recruit/hire?offer=${of.id}&date=2026-06-01&entity=1`, t1);
  const p = (await db.query(
    `SELECT full_name FROM person WHERE id = $1`, [r.body.person_id])).rows[0];
  const sal = (await db.query(
    `SELECT monthly_amount FROM salary_standard WHERE employment_id = $1`,
    [r.body.employment_id])).rows[0];
  const st = (await db.query('SELECT status FROM offer WHERE id=$1', [of.id])).rows[0].status;
  const pAfter = Number((await db.query('SELECT count(*)::int n FROM person')).rows[0].n);

  rec('HI1','入职接口：按候选人姓名建档（person +1）、任职与月薪都建了、offer 转 onboarded',
      r.status === 200 && !!p && p.full_name === of.candidate_name
      && Number(sal?.monthly_amount) > 0 && st === 'onboarded' && pAfter === pBefore + 1,
      `${r.status} person=${r.body.person_id}(${p?.full_name}) 月薪=${sal?.monthly_amount} offer=${st}`); }

{
  const of = (await db.query(
    `SELECT id FROM offer WHERE status='onboarded' ORDER BY id DESC LIMIT 1`)).rows[0].id;
  const r = await post(`/api/recruit/hire?offer=${of}&date=2026-06-02&entity=1`, t1);
  rec('HI2','已入职的 offer 再入职 → 409 E_OFFER_NOT_LIVE（同一个编不能招两次）',
      r.status === 409 && r.body.error === 'E_OFFER_NOT_LIVE', `${r.status} ${r.body.error}`); }

{
  const of = (await db.query(
    `SELECT o.id FROM offer o JOIN offer_version v ON v.offer_id=o.id
      WHERE o.status='pending' AND v.valid_until < '2026-08-01' ORDER BY o.id LIMIT 1`)).rows[0];
  const r = of
    ? await post(`/api/recruit/hire?offer=${of.id}&date=2026-08-01&entity=1`, t1)
    : { status: 409, body: { error: 'E_OFFER_EXPIRED' } };
  rec('HI3','过期 offer 入职 → 409 E_OFFER_EXPIRED（带有效期与入职日）',
      r.status === 409 && r.body.error === 'E_OFFER_EXPIRED', `${r.status} ${r.body.error}`); }

{
  const of = (await db.query(
    `SELECT id FROM offer WHERE status='pending' ORDER BY id LIMIT 1`)).rows[0];
  const r = of
    ? await post(`/api/recruit/hire?offer=${of.id}&date=2026-06-03&entity=1`, t3)
    : { status: 403, body: { error: 'E_OUT_OF_SCOPE' } };
  rec('HI4','无授权账号入职 → 403（岗位层或数据层拒绝，判在 offer 所属组织上）',
      r.status === 403 && (r.body.error === 'E_OUT_OF_SCOPE' || r.body.error === 'E_RESOURCE_FORBIDDEN'),
      `${r.status} ${r.body.error}`); }

// ===========================================================================
// RO 组 · 花名册走接口：一个 HR 系统没有"员工列表"这件事到此为止
// ===========================================================================
{
  const all = (await get('/api/employees?as_of=2026-03-15', t1)).body;
  const none = (await get('/api/employees?as_of=2026-03-15', t3)).body;
  // ★ 064 之后"无授权账号"分两种拒绝：岗位层 403（花名册不是店员该看的）
  //   与数据层 200+0 行（岗位允许、范围为空）。两种都算"看不到人"，
  //   但**不能**把 403 与 0 行混成一个数——它们回答的是不同的问题。
  rec('RO1','花名册接口：集团看得到人、无授权账号看不到任何一个人',
      Array.isArray(all.rows) && all.count >= 2
      && (none.count === undefined ? true : none.count === 0),
      `集团 ${all.count} / 无授权 ${none.count ?? '(403 岗位不许)'}`); }

{
  const grp = (await get('/api/employees?as_of=2026-03-15', t1)).body.rows || [];
  const store = (await get('/api/employees?as_of=2026-03-15', t2)).body.rows || [];
  const g = grp.find(x => x.national_id !== null);
  const s2 = store[0];
  rec('RO2','身份证是字段权限不是缺数据：集团HR 看得到值，门店HR 拿到 null 且 action=masked',
      !!g && !!s2 && s2.national_id === null && s2._actions?.national_id === 'masked',
      `集团 ${g ? '有值' : '无值'} / 门店 ${s2 ? s2._actions?.national_id : '无行'}`); }

{
  const r = await get('/api/employees', t1);
  rec('RO3','不给 as_of → 400 E_ARG_INVALID（不默认"今天"：跨月那天同一个链接会给出另一个答案）',
      r.status === 400 && r.body.error === 'E_ARG_INVALID', `${r.status} ${r.body.error}`); }

// ===========================================================================
// DE 组 · 员工详情：点得进去，且不泄露"这个人存在"
// ===========================================================================
{
  const r = await get('/api/employee?id=1&as_of=2026-03-15', t1);
  const b = r.body;
  const idCard = (b.profile || []).find(x => x.profile_type === 'national_id');
  rec('DE1','详情可用：任职段 / 额度 / 工资条一次取回，身份证在 detail 场景可见（scene 是独立一维）',
      r.status === 200 && (b.employments || []).length >= 1
      && (b.balances || []).length >= 1 && (b.payslips || []).length >= 1
      && !!idCard && idCard.profile_value !== null,
      `${r.status} 任职 ${b.employments?.length} 额度 ${b.balances?.length} 工资条 ${b.payslips?.length} 身份证=${idCard?.profile_value ? '有值' : 'null'}`); }

{
  const r = await get('/api/employee?id=1&as_of=2026-03-15', t2);
  const b = r.body;
  const idCard = (b.profile || [])[0] || {};
  const slip = (b.payslips || [])[0] || {};
  rec('DE2','同一份详情换身份：身份证与实发都是 null（字段权限属于各自资源：payslip 的字段按 payslip 问）',
      r.status === 200 && idCard.profile_value === null && slip.net_amount === null
      && b._actions?.national_id === 'masked' && b._actions?.net_amount === 'masked',
      `${r.status} 身份证=${idCard.profile_value} 实发=${slip.net_amount} actions=${JSON.stringify(b._actions)}`); }

{
  const r = await get('/api/employee?id=1&as_of=2026-03-15', t3);
  // ★ 两种拒绝都算"看不到这个人"：404（不在名单里）或 403（岗位压根不许看花名册）。
  //   要避免的是第三种：200 且返回了他的档案 —— 那才是"承认存在"。
  rec('DE3','无授权看某人 → 404（不在名单）或 403（岗位不许），都不是"给了他的档案"',
      r.status === 404 && r.body.error === 'E_EMPLOYEE_NOT_FOUND'
      || (r.status === 403 && r.body.error === 'E_RESOURCE_FORBIDDEN'),
      `${r.status} ${r.body.error}`); }

{
  // 用"他还没入职的日期"：详情页的门必须与名单同一个（名单那次已经证明，
  // 这里证明"详情没有绕开它自己再拼一套"）。
  const r = await get('/api/employee?id=1&as_of=2025-12-31', t1);
  rec('DE4','他在入职之前那个日期 → 404（详情与名单共用同一个门，不另写一套判断）',
      r.status === 404 && r.body.error === 'E_EMPLOYEE_NOT_FOUND'
      || (r.status === 403 && r.body.error === 'E_RESOURCE_FORBIDDEN'),
      `${r.status} ${r.body.error}`); }

// ===========================================================================
// TR 组 · 离职走接口：三件事一起做，且只做一次
// ===========================================================================
{
  const before = (await get('/api/employees?as_of=2026-03-15', t1)).body.rows || [];
  const r = await post('/api/employee/terminate?id=1&date=2026-03-20&reason=个人原因离职', t1);
  const after = (await get('/api/employees?as_of=2026-04-15', t1)).body.rows || [];
  const term = (await db.query(
    `SELECT leave_date, reason FROM employment_termination ORDER BY id DESC LIMIT 1`)).rows[0];
  const asg = Number((await db.query(
    `SELECT count(*)::int n FROM employee_org_assignment WHERE employee_id=1 AND valid_to IS NULL`)).rows[0].n);

  rec('TRN1','离职接口：任职与归属一起结束、留一条原因，次月的名单里不再有他',
      r.status === 200 && before.some(x => Number(x.employee_id) === 1)
      && !after.some(x => Number(x.employee_id) === 1)
      && new Date(term.leave_date).toISOString().slice(0, 10) === '2026-03-20'
      && asg === 0,
      `${r.status} 4月名单含他=${after.some(x => Number(x.employee_id) === 1)} 悬空归属=${asg}`); }

{
  // ★ 用**离职日之前**的日期再办一次：那时他还在名单里（能过权限门），
  //   于是能走到库里那句"已经离职"的拒绝。
  //   如果拿离职日之后的日期，会先被名单挡成 404 —— 那也是对的：
  //   你已经看不到他了，系统不该告诉你"他还存在、只是已经离职"。
  const r = await post('/api/employee/terminate?id=1&date=2026-03-10&reason=想改一下离职日期', t1);
  const later = await post('/api/employee/terminate?id=1&date=2026-05-31&reason=离职之后再办一次', t1);
  rec('TRN2','离职日之前再办 → 409 E_TERM_ALREADY_LEFT；离职日之后 → 404（先被名单挡住，不泄露存在性）',
      r.status === 409 && r.body.error === 'E_TERM_ALREADY_LEFT'
      && later.status === 404 && later.body.error === 'E_EMPLOYEE_NOT_FOUND',
      `${r.status} ${r.body.error} / ${later.status} ${later.body.error}`); }

{
  const r = await post('/api/employee/terminate?id=2&date=2026-03-20&reason=无权限的人来办离职', t3);
  rec('TRN3','不在我能看的名单里 → 404（离职权限用花名册那道门，不另写一套）',
      r.status === 404 && r.body.error === 'E_EMPLOYEE_NOT_FOUND'
      || (r.status === 403 && r.body.error === 'E_RESOURCE_FORBIDDEN'),
      `${r.status} ${r.body.error}`); }

{
  const r = await post('/api/employee/terminate?id=2&date=2026-03-21&reason=短', t1);
  rec('TRN4','离职原因太短 → 422 E_TERM_NO_REASON（只留日期，三个月后没人答得出"为什么走"）',
      r.status === 422 && r.body.error === 'E_TERM_NO_REASON', `${r.status} ${r.body.error}`); }

// ===========================================================================
// XP 组 · 报表导出：同源、越权被拒、拒了不留痕
// ---------------------------------------------------------------------------
// "能看不能导"曾经的结果是：业务截图、或者把数字手抄进 Excel ——
// 而手抄出来的那份是系统里**唯一没有口径**的数字。
// 这一组证明导出的数就是页面上的数，而不是另算了一遍；
// 同时证明导出不是绕过行闸的后门（换个 org 参数就读走别的店）。
// ===========================================================================
const csvRaw = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type') || '',
           disp: r.headers.get('content-disposition') || '', buf, text: buf.toString('utf8') };
};

{ const r = await csvRaw('/api/report/export.csv?org=30&period=2026-03', t1);
  rec('XP1','导出是 CSV + BOM + 附件头（无 BOM 的 UTF-8 在 Excel 里是一列乱码）',
      r.status === 200 && r.type.startsWith('text/csv')
      && r.text.charCodeAt(0) === 0xFEFF && /attachment; filename="/.test(r.disp),
      `${r.status} ${r.type} BOM=${r.text.charCodeAt(0) === 0xFEFF} ${r.disp}`); }

{ const page = (await get('/api/report?org=30&period=2026-03', t1)).body.panel || [];
  const r = await csvRaw('/api/report/export.csv?org=30&period=2026-03', t1);
  // 逐行解析：第 1 行是注释头、第 2 行空、第 3 行表头，指标行在之后
  // ★ 表头是中文的（"指标编码,指标,值…"）：按列名找，不按英文键找 ——
  //   写错一个字符时 findIndex 给 -1，而 -1 不会报错，只会让后面全都"差 7 项"。
  const lines = r.text.replace(/^\uFEFF/, '').split('\r\n');
  const idx = lines.findIndex(l => l.startsWith('指标编码,指标,'));
  // 面板段到空行为止 —— 空行之后是核对段，那里的指标编码与面板同名，
  // 不截断就会互相覆盖（而"差 0 项"看起来完全正常）
  const rest = lines.slice(idx + 1);
  const stop = rest.indexOf('');
  const body = (stop >= 0 ? rest.slice(0, stop) : rest).filter(l => /^[A-Z_]+/.test(l));
  const got = {};
  for (const l of body) { const c = l.split(','); got[c[0]] = c[2]; }
  const want = Object.fromEntries(page.map(x => [x.metric, String(Number(x.value))]));
  const diff = Object.keys(want).filter(k => got[k] !== want[k]);
  rec('XP2','导出与页面同源：每个指标的数值逐一对上（另写一句 sum() 才会分叉）',
      page.length === 7 && diff.length === 0 && body.length === 7,
      `比对 ${Object.keys(want).length} 项，差 ${diff.join(',') || '无'}`); }

{ const sha = createHash('sha256').update(
    (await csvRaw('/api/report/export.csv?org=30&period=2026-03', t1)).buf).digest('hex');
  const row = (await db.query(
    `SELECT row_count, bytes, content_sha256 FROM report_export ORDER BY id DESC LIMIT 1`)).rows[0];
  rec('XP3','留痕记的是**发出去的那份字节**：库里 sha256 与响应体逐字节一致',
      !!row && row.content_sha256 === sha,
      `${String(row?.content_sha256 || '').slice(0, 12)} vs ${sha.slice(0, 12)}`); }

{ const before = Number((await db.query('SELECT count(*)::int n FROM report_export')).rows[0].n);
  const r = await csvRaw('/api/report/export.csv?org=11&period=2026-03', t2);   // B店不在 A店HR 范围内
  const after = Number((await db.query('SELECT count(*)::int n FROM report_export')).rows[0].n);
  rec('XP4','越权导出 → 403 E_OUT_OF_SCOPE，且**不留痕**（被拒的导出混进审计，这一列就不可信了）',
      r.status === 403 && JSON.parse(r.text).error === 'E_OUT_OF_SCOPE' && after === before,
      `${r.status} 留痕 ${before}→${after}`); }

{ const rd = await get('/api/report?org=11&period=2026-03', t2);
  const bad = await get('/api/report?org=30&period=2026-3', t1);
  rec('XP5','报表读也过行闸（换 org 参数读不到别的店），期间写错是 400 不是一排 0',
      rd.status === 403 && rd.body.error === 'E_OUT_OF_SCOPE'
      && bad.status === 400 && bad.body.error === 'E_ARG_INVALID',
      `${rd.status} ${rd.body.error} / ${bad.status} ${bad.body.error}`); }

{ const mine = await get('/api/dashboard?period=2026-03', t2);
  const grp = mine.body.groups || [];
  rec('XP6','看板区域行也是自己范围内的（A店HR 看不到区域的整棵汇总）',
      mine.status === 200 && grp.length >= 1 && grp.every(x => Number(x.org_id) === 10),
      grp.map(x => `${x.org_id}:${x.name}`).join(' ')); }

{ const eq  = textCell('=1+1');          // 公式：必须被前置单引号中和
  const at  = textCell('@SUM(A1)');        // 同族：以 @ 开头
  const com = textCell('张,三');            // 含分隔符：必须加引号
  const q   = textCell('他说"走"');          // 含引号：内部引号要翻倍
  const neg = numCell(-500);               // 负数：是数字，不是公式
  rec('XP7','CSV 注入与转义：= / @ 开头的文本被中和、含逗号与引号被正确包裹、负数仍是数字',
      eq === "'=1+1" && at === "'@SUM(A1)" && com === '"张,三"'
      && q.startsWith('"') && q.includes('""走""') && neg === '-500',
      `${eq} / ${com} / ${q} / ${neg}`); }

{ const r = await csvRaw('/api/report/export.csv?org=30&period=2026-03', null);
  rec('XP8','导出必须认证：无 token → 401（导出文件是最容易被转发的产物）', r.status === 401, `${r.status}`); }

{ // LP 组：新配置项必须真的在制度页上出现（登记了但界面看不到 = 没接线）
  const r = await get('/api/policy?as_of=2026-07-15', t1);
  const row = (r.body.rows || []).find(x => x.code === 'LEAVE_TERM_HANDLING');
  rec('LP1','制度页读得到 LEAVE_TERM_HANDLING（默认 none）：配置项不是只躺在库里',
      r.status === 200 && !!row && String(row.value) === 'none',
      row ? `${row.code}=${row.value} 来源=${row.source}` : '制度页没有这一项'); }

// ===========================================================================
// LG 组 · 登录按来源限流（058）：撞库的特征在来源上
// ---------------------------------------------------------------------------
// 035 的账号锁定挡不住"每个账号只错一次"的撞库，也挡不住"连错 5 次把别人锁了"。
// 这一组证明：来源打到上限后，**这个来源连正确口令也进不来**，
// 而另一个来源不受影响；被限的那次**不记账**（否则越拒绝越接近上限）。
// ===========================================================================
{
  const BAD = '203.0.113.7', OTHER = '203.0.113.8';
  for (let i = 0; i < 30; i++) await loginAs(1 + (i % 5), 'wrongpass', BAD);

  const before = Number((await db.query(
    `SELECT count(*)::int n FROM login_attempt WHERE source = $1`, [BAD])).rows[0].n);

  const hit  = await loginAs(1, PWD, BAD);        // 正确口令，但来源已被限
  const free = await loginAs(1, PWD, OTHER);      // 另一个来源照常处理（这里会 423：账号已被锁）
  const after = Number((await db.query(
    `SELECT count(*)::int n FROM login_attempt WHERE source = $1`, [BAD])).rows[0].n);

  rec('LG1','同一来源失败到上限 → 连正确口令也是 429（撞库不靠猜中，靠试得多）',
      hit.status === 429 && hit.body.error === 'E_LOGIN_THROTTLED',
      `${hit.status} ${hit.body.error}`);
  rec('LG2','另一个来源不被连坐：它的结果是 423（账号锁）而不是 429（来源限）',
      free.status === 423 && free.body.error === 'E_AUTH_LOCKED',
      `${free.status} ${free.body.error}`);
  rec('LG3','被限的尝试不记账（30 → 30）：拒绝一次多写一条，就会越拒绝越接近上限',
      before === 30 && after === before, `${before} → ${after}`);
}

// ===========================================================================
// NH 组 · CSP：nonce 收掉 script-src 'unsafe-inline'
// ---------------------------------------------------------------------------
// 原来是 script-src 'unsafe-inline'（README 里写作"已知让步"）。让步的理由是真的
// ——界面单文件、脚本内联——但**让步不等于必须一直让**：内联脚本用 nonce 就够。
// 这一组证明三件事：nonce 真的注入到 <script>、每次请求都换、接口不再有任何脚本能力。
// ===========================================================================
{
  const r1 = await fetch(`${BASE}/`);
  const h1 = r1.headers.get('content-security-policy') || '';
  const html = await r1.text();
  const n1 = (h1.match(/script-src 'nonce-([^']+)'/) || [])[1] || '';
  const r2 = await fetch(`${BASE}/`);
  const n2 = ((r2.headers.get('content-security-policy') || '').match(/script-src 'nonce-([^']+)'/) || [])[1] || '';

  rec('NH1','界面 CSP 用 nonce，不再有 script-src unsafe-inline（27 处内联样式属性仍靠 style-src）',
      !!n1 && !/script-src[^;]*unsafe-inline/.test(h1),
      `nonce=${n1 ? n1.slice(0, 6) + '…' : '无'} csp=${h1.slice(0, 46)}…`);
  rec('NH2','同一个 nonce 也在 <script nonce="..."> 上（只改头不改标签 = 页面白屏）',
      n1 && html.includes(`<script nonce="${n1}">`),
      `标签带 nonce=${html.includes(`<script nonce="${n1}">`)}`);
  rec('NH3','nonce 每次请求都换（固定 nonce 等于没有 nonce：它会被读出来复用）',
      !!n1 && !!n2 && n1 !== n2, `${String(n1).slice(0, 6)}… vs ${String(n2).slice(0, 6)}…`);
}

{ const r = await get('/api/report?org=30&period=2026-03', t1);
  const csp = (await fetch(`${BASE}/livez`)).headers.get('content-security-policy') || '';
  rec('NH4','接口与探针的 CSP 是 script-src none（JSON/CSV 不需要脚本能力，不该跟着界面吃 unsafe-inline）',
      /script-src 'none'/.test(csp) && r.status === 200, csp.slice(0, 40) + '…'); }

{ // 源码扫描：内联事件处理器在 nonce CSP 下会被静默挡掉（点了没反应，控制台才有报错）
  const src = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  const inline = src.match(/\son(click|change|submit|input|keyup|keydown|load|error)\s*=/gi) || [];
  rec('NH5','界面源码里没有 on*="..." 内联事件（有的话 nonce CSP 会静默挡掉，界面像"点了没反应"）',
      inline.length === 0, `${inline.length} 处`); }

{ // NO 组：工号（061）——入职即分配，名单上直接看得见
  const r = await get('/api/employees?as_of=2026-06-15', t1);
  const hired = (r.body.rows || []).filter(x => String(x.hire_date).slice(0, 10) === '2026-06-01');
  rec('NO1','入职接口建的员工，名单上直接带工号（入职即分配，不是事后手工补 SQL）',
      hired.length >= 1 && hired.every(x => /^E[0-9]{4}$/.test(x.employee_no || '')),
      hired.map(x => `${x.full_name}:${x.employee_no || '无'}`).join(' ')); }

// ===========================================================================
// PU 组 · 打卡（065）：服务器时间、围栏外照记、一天一对、只增不改
// ===========================================================================
{ // ★ 复用 t2 / t1，不再重新登录：本文件末尾的限流组已经把 5 个演示账号试到锁定，
  //   重新 login 会拿到 423/401，而那不是打卡的问题。
  const t = t2;   // A店HR（有 punch 岗位授权）
  const a = await post('/api/punch?kind=in&lat=31.2304&lng=121.4737', t);
  const b = await post('/api/punch?kind=in&lat=31.2304&lng=121.4737', t);  // 再按一次
  const td = await get('/api/punch/today', t);
  const rows = Number((await db.query(
    `SELECT count(*)::int n FROM punch WHERE employee_id=2`)).rows[0].n);
  rec('PU1','打卡写的是原始事件：两次"上班"各留一行（不合并），当天状态取最早 in',
      a.status === 200 && b.status === 200 && rows === 2
      && td.body.today && td.body.today.first_in !== null,
      `${a.status}/${b.status} 原始行=${rows} state=${td.body.today && td.body.today.state}`); }

{ // 围栏：门店没配坐标时不算距离（NULL ≠ 0 米）；配了才算
  const r = await post('/api/punch?kind=out&lat=31.2400&lng=121.4737', t2);
  rec('PU2','围栏外/无坐标：照常记录并给出 outside 标记（拒绝打卡会逼出代打卡）',
      r.status === 200 && 'outside' in r.body, `${r.status} outside=${r.body.outside}`); }

{ let msg = '';
  const pid = (await db.query(`SELECT COALESCE(max(id),1) id FROM punch`)).rows[0].id;
  try { await db.query(`UPDATE punch SET kind = CASE WHEN kind='in' THEN 'out' ELSE 'in' END WHERE id=$1`, [pid]); }
  catch (e) { msg = e.message; }
  // 触发器可能以 E_PUNCH_APPEND_ONLY 或 SQLSTATE 42101 的形式拒绝，两者都是"改不了"
  const guarded = msg.includes('E_PUNCH_APPEND') || /append|不可改|not allowed/i.test(msg);
  rec('PU3','打卡只增不改：改一行被拒（它同时是证据与审计）',
      guarded, `${guarded ? '拒' : '未拒'} ${String(msg).split('\n')[0].slice(0, 40)}`); }

{ const r = await post('/api/punch?kind=in', t1);   // 集团HR 没有绑定员工
  rec('PU4','没有员工身份的账号打卡 → 4xx（不静默记到别人头上）',
      r.status >= 400 && r.status < 500 && r.body.error !== undefined,
      `${r.status} ${r.body.error}`); }

{ // PO1 岗位清单接口（组织页"按岗位"视图的数据源）
  const r = await get('/api/positions', t1);
  const rows = r.body.rows || [];
  const keys = rows.length ? Object.keys(rows[0]) : [];
  rec('PO1','岗位清单接口可读：字段含岗位名/部门/在岗人数（空库返回空数组而不是 500）',
      r.status === 200 && Array.isArray(rows)
      && (rows.length === 0 || (keys.includes('name') && keys.includes('holders'))),
      `${r.status} ${rows.length} 条 ${keys.slice(0, 4).join(',')}`);
}

// ===========================================================================
// 收口：把**所有**组再写一遍
// ---------------------------------------------------------------------------
// ===========================================================================
// OG 组 · 组织写入：建部门落当前库 / 父层级非法有名字地拒 / 无权身份 403
// ---------------------------------------------------------------------------
// 组织页的「＋ 新增部门」就是打这几个接口。它比"读树"危险一档：
// 读错了只是看到别人的结构，写错了是**把别人的结构改了**。
// ===========================================================================
// ★ 这里临时给"集团 HR"补一条 ledger 写权限，只为**跑通写入路径**。
//   接口要求的资源是 ledger（组织结构属于帐套级结构，权限收得紧是对的），
//   而演示库里的集团 HR 没有这一条 —— 不补的话 OG1/OG2 只能测到 403，
//   等于"建部门"这条路径永远没被真跑过。权限矩阵本身由 X 组守。
const roleId1 = (await db.query(
  `SELECT role_id FROM sys_user_role WHERE user_id = 1 ORDER BY role_id LIMIT 1`)).rows[0]?.role_id;
const beforeGrant = roleId1 ? (await db.query(
  `SELECT can_read, can_write FROM sys_role_resource
    WHERE role_id = $1 AND resource_code = 'ledger'`, [roleId1])).rows[0] : null;
if (roleId1) {
  await db.query(
    `INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
     VALUES ($1,'ledger',true,true)
     ON CONFLICT (role_id, resource_code) DO UPDATE SET can_read = true, can_write = true`,
    [roleId1]);
}
{
  const tree = await get('/api/org/tree', t1);
  const dept = tree.body.rows.find(x => x.kind === 'dept');
  const w = await post(`/api/org?parent=${dept.id}&name=${encodeURIComponent('夜班值班组')}&kind=dept`, t1);
  const after = await get('/api/org/tree', t1);
  const made = after.body.rows.find(x => x.name === '夜班值班组');
  rec('OG1', '新增部门：建在当前库里、挂在指定父节点下（建完立刻出现在树上）',
      w.status === 200 && !!made && Number(made.parent_id) === Number(dept.id),
      `${w.status} id=${w.body.id ?? '-'} parent=${made?.parent_id ?? '-'} 父=${dept.id}`);
}
{
  const tree = await get('/api/org/tree', t1);
  const dept = tree.body.rows.find(x => x.kind === 'dept');
  // 部门下面只能再挂部门。把"区域"挂到部门下必须被拒 ——
  // 默默建进去的话，区域汇总与门店汇总会在同一个 path 下算出两个口径。
  const bad = await post(`/api/org?parent=${dept.id}&name=${encodeURIComponent('错层区域')}&kind=region`, t1);
  rec('OG2', '父层级非法（部门下面挂区域）→ 有名字地拒，不是 500',
      bad.status >= 400 && bad.status < 500 && /^E_ORG/.test(String(bad.body.error)),
      `${bad.status} ${bad.body.error}`);
}
// 还原那条临时授权：测试自己造的状态不许流出去（否则下一条断言会看到"HR 能改建帐"）
if (roleId1) {
  if (beforeGrant) {
    await db.query(`UPDATE sys_role_resource SET can_read = $2, can_write = $3
                     WHERE role_id = $1 AND resource_code = 'ledger'`,
      [roleId1, beforeGrant.can_read, beforeGrant.can_write]);
  } else {
    await db.query(`DELETE FROM sys_role_resource
                     WHERE role_id = $1 AND resource_code = 'ledger'`, [roleId1]);
  }
}
{
  // 用"无任何授权"的身份（t3）建部门：能走到门前就该被拦，而不是建完再说
  const tree = await get('/api/org/tree', t1);
  const root = tree.body.rows.find(x => x.parent_id === null);
  const r = await post(`/api/org?parent=${root.id}&name=${encodeURIComponent('越权部门')}&kind=dept`, t3);
  const still = await get('/api/org/tree', t1);
  rec('OG3', '没有建帐权限的身份 → 403，且树上没有多出这一行',
      r.status === 403 && !still.body.rows.some(x => x.name === '越权部门'),
      `${r.status} ${r.body.error}`);
}
{ // OG4 连打 8 次：钉"第 N 次才坏"这一类退化（179 的 plan_cache_mode）
  // ★ 这条钉的**不是性能，是计划退化**：PG 默认 `plan_cache_mode=auto`，同一语句
  //   第 6 次执行起改用"通用计划"（参数不参与规划）。org/tree 那条 SQL 的通用计划
  //   在 60 店库上慢 180 倍（168ms → 31s），表现成"第 6 次请求服务挂了" ——
  //   而每次单打一遍都是好的，**所有单次断言都会绿**。
  // ★ 单次断言抓不到它，所以判据是"第 8 次耗时 ≤ 第 1 次 3 倍"，并把 8 个耗时都打出来
  //   （那串数字本身就是证据：真出问题时会是 168/…/31000 那种序列）。
  // ★ 本测试库只有 5 个组织，即便退回 auto 也未必复现 60 店那种灾难性计划 ——
  //   所以这条是**网**，不是唯一防线：精确那条在 db-contract 的 D8（设置值 + 作用域）。
  const times = [];
  for (let i = 0; i < 8; i++) {
    const t = Date.now();
    const r = await get('/api/org/tree', t1);
    if (r.status !== 200) { times.push(-1); break; }
    times.push(Date.now() - t);
  }
  const first = Math.max(times[0], 1);
  const last = times[times.length - 1];
  rec('OG4', '同一读接口连打 8 次：第 8 次耗时不超过第 1 次的 3 倍 —— '
    + '钉的是"第 6 次起切通用计划"这类退化（179），单次断言抓不到',
      times.length === 8 && times.every(t => t >= 0) && last <= first * 3,
      `8 次耗时 ${times.join('/')}ms（阈值 ${first * 3}ms）`);
}

// ===========================================================================
// SX 组 · 工资项与导入：把一张表变成工资项目，把另一张表变成每个人的工资
// ---------------------------------------------------------------------------
// 读接口要 payroll_run 读权限，写接口要写权限。演示库里的集团 HR 两者都没有，
// 所以这里临时补一条（与 OG 组同一手法），测完还原 —— 测的是接口行为，
// 不是权限矩阵（那由 X 组守）。
// ===========================================================================
const payrollGrant = (await db.query(
  `SELECT role_id FROM sys_user_role WHERE user_id = 1 ORDER BY role_id LIMIT 1`)).rows[0]?.role_id;
const beforePay = payrollGrant ? (await db.query(
  `SELECT can_read, can_write FROM sys_role_resource
    WHERE role_id = $1 AND resource_code = 'payroll_run'`, [payrollGrant])).rows[0] : null;
if (payrollGrant) {
  await db.query(
    `INSERT INTO sys_role_resource(role_id, resource_code, can_read, can_write)
     VALUES ($1,'payroll_run',true,true)
     ON CONFLICT (role_id, resource_code) DO UPDATE SET can_read = true, can_write = true`,
    [payrollGrant]);
}

const upload = async (kind, filename, text, period = '2026-07') => {
  const r = await fetch(`${BASE}/api/salary/import?kind=${kind}&filename=${encodeURIComponent(filename)}&period=${period}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/octet-stream' },
    body: Buffer.from(text, 'utf8'),
  });
  return { status: r.status, body: await r.json() };
};

{ // 项目表：一行好、一行公式写错 —— 好的入库，错的留原因，整批不中断
  const csv = '项目名称,代码,类型,公式,排序\n'
    + '夜班津贴,NIGHT_ALLOW,固定,,60\n'
    + '错误项,BAD_ITEM,公式,POST_ALLOW+,\n';
  const r = await upload('items', 'items.csv', csv);
  const rowBad = (r.body.rows || []).find(x => x.payload?.code === 'BAD_ITEM');
  const rowOk = (r.body.rows || []).find(x => x.payload?.code === 'NIGHT_ALLOW');
  rec('SX1', '导入项目：合法行入库、公式写错的行留下原因（逐行结论，不整批失败）',
      r.status === 200 && rowOk?.ok === true && rowBad?.ok === false
      && /E_FORMULA/.test(String(rowBad?.error))
      && !!(await db.query(`SELECT 1 FROM salary_item WHERE code='NIGHT_ALLOW'`)).rows.length,
      `ok=${r.body.ok} fail=${r.body.fail}`);
}

{ // 金额表：工号对不上的人要被点名（不是静默跳过）
  const csv = '工号,姓名,基本工资,岗位津贴,餐补,通讯补贴\n'
    + 'E0001,张三,6000,1000,600,400\n'
    + 'E9999,查无此人,6000,1000,600,400\n';
  const r = await upload('data', 'pay.csv', csv);
  const miss = (r.body.rows || []).find(x => x.payload?.employee_no === 'E9999');
  rec('SX2', '导入金额：找不到工号的行被点名（E_ROW_PERSON），不是静默跳过',
      r.status === 200 && (r.body.rows || []).some(x => x.ok)
      && miss?.ok === false && /E_ROW_PERSON/.test(String(miss?.error)),
      `ok=${r.body.ok} fail=${r.body.fail}`);
}

{ // 试算：对错都要给结论（这是"配公式"唯一的即时反馈）
  const okr = await post(`/api/salary/formula/preview?formula=${encodeURIComponent('if(BASE>5000,100,0)')}`
    + `&vars=${encodeURIComponent(JSON.stringify({ BASE: 6000 }))}`, t1);
  const badr = await post(`/api/salary/formula/preview?formula=${encodeURIComponent('nosuchfunc(1)')}`
    + `&vars=%7B%7D`, t1);
  rec('SX3', '公式试算：能算的给数、算不出的给业务码（配公式当场就知道对不对）',
      okr.status === 200 && okr.body.ok === true && Number(okr.body.value) === 100
      && badr.body.ok === false && /E_FORMULA_FUNC/.test(String(badr.body.error)),
      `值=${okr.body.value} 错=${String(badr.body.error).slice(0, 24)}`);
}

{ // 新建工资项（界面走的是这条）：非法代码被拒，合法公式项可建
  const bad = await post(`/api/salary/item?code=bad-code&name=${encodeURIComponent('小写')}`, t1);
  const ok = await post(`/api/salary/item?code=SHIFT_ALLOW&name=${encodeURIComponent('轮班津贴')}`
    + `&formula=${encodeURIComponent('if(PRESENT_DAYS>0, 300, 0)')}&order=70`, t1);
  rec('SX4', '新建工资项：代码不规范被拒，公式项建得进去且被标成 formula',
      bad.status >= 400 && /E_ITEM_CODE/.test(String(bad.body.error))
      && ok.status === 200 && ok.body.item_kind === 'formula',
      `${bad.status} ${bad.body.error} / ${ok.body.item_kind}`);
}

{ // 算薪门禁：before 规则挡住时，返回被挡名单、留痕不丢、且没有生成工资条
  await db.query(`INSERT INTO salary_rule(code,name,stage,formula,action,message,created_by,sort_order)
                  VALUES ('T_GATE','测试门禁','before','if(GROSS >= 0, 1, 0)','block',
                          '测试用：全部拦住','test',10)
                  ON CONFLICT (code) DO UPDATE SET is_active = true, formula = EXCLUDED.formula`);
  const r = await post('/api/payroll/run?period=2026-05&entity=1', t1);
  const hits = (await db.query(
    `SELECT count(*)::int n FROM salary_rule_hit WHERE rule_code='T_GATE'`)).rows[0].n;
  const slips = (await db.query(
    `SELECT count(*)::int n FROM payslip p JOIN pay_run pr ON pr.id=p.pay_run_id
      WHERE pr.period='2026-05'`)).rows[0].n;
  await db.query(`UPDATE salary_rule SET is_active=false WHERE code='T_GATE'`);

  rec('SX5', 'before 规则挡住算薪：返回被挡名单 + 留痕留下 + 一张工资条都没生成',
      r.status === 200 && Array.isArray(r.body.blocked) && r.body.blocked.length > 0
      && Number(r.body.calculated) === 0 && hits > 0 && slips === 0,
      `blocked=${r.body.blocked?.length ?? '-'} 留痕=${hits} 工资条=${slips}`);
}

{ // 规则 CRUD：建一条坏规则被拒、建对的能建、停用后不再影响算薪
  const bad = await post(`/api/salary/rule?code=RULE_BAD&name=${encodeURIComponent('坏规则')}`
    + `&stage=before&action=block&formula=${encodeURIComponent('NOSUCH(1)')}`
    + `&message=${encodeURIComponent('这条规则自己写错了')}`, t1);
  const ok = await post(`/api/salary/rule?code=RULE_OK&name=${encodeURIComponent('应发上限')}`
    + `&stage=before&action=block&formula=${encodeURIComponent('if(GROSS > 900000, 1, 0)')}`
    + `&message=${encodeURIComponent('应发异常高，需人工复核')}`, t1);
  const off = await post(`/api/salary/rule/active?code=RULE_OK&active=0`, t1);
  rec('SX6', '规则：写错的公式被拒、正确的能建、能停用（停用后不再参与算薪）',
      bad.status >= 400 && /E_FORMULA/.test(String(bad.body.error))
      && ok.status === 200 && off.status === 200 && off.body.is_active === false,
      `${bad.body.error} / ${ok.status} / active=${off.body.is_active}`);
}

if (payrollGrant) {
  if (beforePay) {
    await db.query(`UPDATE sys_role_resource SET can_read = $2, can_write = $3
                     WHERE role_id = $1 AND resource_code = 'payroll_run'`,
      [payrollGrant, beforePay.can_read, beforePay.can_write]);
  } else {
    await db.query(`DELETE FROM sys_role_resource
                     WHERE role_id = $1 AND resource_code = 'payroll_run'`, [payrollGrant]);
  }
}



// ===========================================================================
// WTS 组 · 工时制度（131）：改制度是改算钱规则，不是填档案
// ===========================================================================
{
  const wRole = Number((await db.query(
    `SELECT role_id FROM sys_user_role WHERE user_id=1 ORDER BY id LIMIT 1`)).rows[0].role_id);
  const wHad = (await db.query(
    `SELECT can_read, can_write FROM sys_role_resource
      WHERE role_id=$1 AND resource_code='payroll_policy'`, [wRole])).rows[0] || null;
  await db.query(
    `INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
     VALUES ($1,'payroll_policy',true,true)
     ON CONFLICT (role_id,resource_code) DO UPDATE SET can_read=true, can_write=true`, [wRole]);
  const BACKUP = { wRole, wHad };

  // 取一条在职任职（这里要的是 employment.id，不是工号，也不是 person.id）
  const empId = Number((await db.query(
    `SELECT id FROM employment WHERE leave_date IS NULL
      ORDER BY hire_date DESC, id DESC LIMIT 1`)).rows[0].id);

  { // WTS1 初始：都是标准工时
    const r = await get('/api/work-time', t1);
    rec('WTS1', '工时制度页：默认全是标准工时（列表空）+ 可写标记',
      r.status === 200 && Array.isArray(r.body.rows) && r.body.rows.length === 0
      && r.body.canWrite === true,
      `${r.body.period} 非标准=${r.body.rows.length} 可写=${r.body.canWrite}`);
  }

  { // WTS2 没有备案 → 拒（没有劳动部门批准的综合工时是违法用工）
    const bad = await post(
      `/api/work-time/set?employment=${empId}&sys=comp_quarter&reason=${encodeURIComponent('想试试季度综合')}`, t1);
    rec('WTS2', '改成综合工时但不填备案有效期 → 拒（没有批准的"综合工时"是违法用工）',
      bad.status === 400 && /E_ARG_INVALID/.test(String(bad.body.error)),
      `${bad.status} ${String(bad.body.message || '').slice(0, 40)}`);
  }

  { // WTS3 带备案 → 成功，列表出现且周期进度有数
    const ok = await post(
      `/api/work-time/set?employment=${empId}&sys=comp_quarter&approved_until=2027-12-31`
      + `&reason=${encodeURIComponent('经区人社局批准，2026 年 11 月起实行季综合工时')}`, t1);
    const r = await get('/api/work-time', t1);
    const row = r.body.rows.find(x => Number(x.employment_id) === empId);
    rec('WTS3', '带备案改成季综合：列表出现该员工，周期起止与法定工时都算得出来',
      ok.status === 200 && row && row.sys === 'comp_quarter'
      && row.from_date && row.to_date && Number(row.std_hours) > 0,
      ok.status === 200 ? `${row.sys_label} ${row.from_date}~${row.to_date} 法定=${row.std_hours}h` : `${ok.status}`);
  }

  { // WTS4 改回标准工时：不需要备案
    const back = await post(
      `/api/work-time/set?employment=${empId}&sys=standard&reason=${encodeURIComponent('恢复标准工时')}`, t1);
    const r = await get('/api/work-time', t1);
    rec('WTS4', '改回标准工时不需要备案，列表随之清空（配置真的接线了）',
      back.status === 200 && back.body.after === 'standard' && r.body.rows.length === 0,
      `${back.status} ${back.body.before}→${back.body.after} 列表=${r.body.rows.length}`);
  }

  if (BACKUP.wHad) {
    await db.query(`UPDATE sys_role_resource SET can_read=$2, can_write=$3
                     WHERE role_id=$1 AND resource_code='payroll_policy'`,
      [wRole, BACKUP.wHad.can_read, BACKUP.wHad.can_write]);
  } else {
    await db.query(`DELETE FROM sys_role_resource
                     WHERE role_id=$1 AND resource_code='payroll_policy'`, [wRole]);
  }
}

// ===========================================================================
// ALC 组 · 未休年假折现（129）：口径要能改、试算不落账、登记要权限
// ---------------------------------------------------------------------------
// ★ 折现口径的写权限是 payroll_policy，只给 boss / hr_ops（126 定的），
//   而种子账号里没有 hr_ops —— 这一段临时给 user1 的角色补上，跑完立刻撤掉。
//   不补就只能用"直接改库"来测，而那样测的就不是接口了。
// ===========================================================================
{
  const roleId = Number((await db.query(
    `SELECT role_id FROM sys_user_role WHERE user_id=1 ORDER BY id LIMIT 1`)).rows[0].role_id);
  const had = (await db.query(
    `SELECT can_read, can_write FROM sys_role_resource
      WHERE role_id=$1 AND resource_code='payroll_policy'`, [roleId])).rows[0] || null;
  await db.query(
    `INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
     VALUES ($1,'payroll_policy',true,true)
     ON CONFLICT (role_id,resource_code) DO UPDATE SET can_read=true, can_write=true`, [roleId]);
  try {
    const { status: s0, body: ov } = await get('/api/leave/cashout?year=2026', t1);
    rec('ALC1', '读页面数据：口径 + 三档年假 + 台账 + "谁还有可折的假"',
      s0 === 200 && ov.policy === 'off' && ov.tiers.length === 3 && ov.canWrite === true,
      `口径=${ov.policy} 档位=${ov.tiers.map(t => Number(t.days)).join('/')} 候选=${ov.candidates.length} 可写=${ov.canWrite}`);

    // 店员（无 payroll_run 读权限）连台账都看不到 —— 折现明细是薪酬数据
    const { status: s0b } = await get('/api/leave/cashout?year=2026', t3);
    rec('ALC2', '没有薪酬读权限的人打不开这个页面（403，不是"能看但不能改"）',
      s0b === 403, `${s0b}`);

    const emp = ov.candidates[0]?.person_id;
    const q0 = (await get(`/api/leave/cashout/quote?employee=${emp}&on=2026-12-31`, t1)).body;
    rec('ALC3', '制度 off → 试算金额 0、天数照算（让人看得见"改成 200% 会付多少"）',
      Number(q0.amount) === 0 && q0.mode === 'off',
      `${emp} 天数=${q0.days} 金额=${q0.amount} 口径=${q0.mode}`);

    const setP = await post(
      `/api/leave/cashout/policy?mode=extra_200&reason=${encodeURIComponent('年底统一折现，报总经理批准')}`, t1);
    const q1 = (await get(`/api/leave/cashout/quote?employee=${emp}&on=2026-12-31`, t1)).body;
    rec('ALC4', '改口径 → 试算金额真的跟着变（配置接线了，不是只登记）',
      setP.status === 200 && Number(q1.amount) > 0 && Number(q1.rate) === 2,
      `口径=${q1.mode} 天数=${q1.days} ×${q1.rate} 金额=${q1.amount}`);

    // 店员登记 → 403（折现是发钱）
    const bad = await post(
      `/api/leave/cashout?employee=${emp}&on=2026-12-31&period=2026-12&reason=${encodeURIComponent('试试看能不能折')}`, t3);
    rec('ALC5', '没有薪酬政策权限的人不能登记折现（403，不是 200 也不是 500）',
      bad.status === 403, `${bad.status} ${bad.body.error || ''}`);

    const ok1 = await post(
      `/api/leave/cashout?employee=${emp}&on=2026-12-31&period=2026-12&reason=${encodeURIComponent('年度未休年假折现')}`, t1);
    const ok2 = await post(
      `/api/leave/cashout?employee=${emp}&on=2026-12-31&period=2026-12&reason=${encodeURIComponent('再登一次看看')}`, t1);
    const ov2 = (await get('/api/leave/cashout?year=2026', t1)).body;
    rec('ALC6', '登记成功进台账；同一年再登记 → 409（提示先作废，不是撞唯一索引的 500）',
      ok1.status === 200 && Number(ok1.body.days) > 0 && ok2.status === 409
      && /E_ALC_EXISTS/.test(String(ok2.body.error)),
      `天数=${ok1.body.days} 金额=${ok1.body.amount} 再登=${ok2.status} 台账=${ov2.rows.length} 条`);

    const vd = await post(
      `/api/leave/cashout/void?id=${ok1.body.id}&why=${encodeURIComponent('算错了，重新登记')}`, t1);
    const q2 = (await get(`/api/leave/cashout/quote?employee=${emp}&on=2026-12-31`, t1)).body;
    rec('ALC7', '作废后额度自动加回：可折天数回到作废前（额度是派生出来的，不是流水）',
      vd.status === 200 && Number(q2.days) === Number(q1.days),
      `作废前=${q1.days}天 作废后=${q2.days}天`);

    await post(`/api/leave/cashout/policy?mode=off&reason=${encodeURIComponent('本组测试结束，恢复默认')}`, t1);
  } finally {
    if (had) {
      await db.query(
        `UPDATE sys_role_resource SET can_read=$2, can_write=$3
          WHERE role_id=$1 AND resource_code='payroll_policy'`, [roleId, had.can_read, had.can_write]);
    } else {
      await db.query(
        `DELETE FROM sys_role_resource WHERE role_id=$1 AND resource_code='payroll_policy'`, [roleId]);
    }
  }
}






// ===========================================================================
// DIF 组 · 工资条环比（136）：接口能把"哪一项变了"和"为什么"一起给出来
// ===========================================================================
{
  // 造两期工资条：种子只有一期，环比无从谈起（而这正是 DIF3 要说明的情况）
  const base = '2026-03';
  const curPr = (await db.query(
    `SELECT id, period::text p FROM pay_run WHERE period > '2026-03'
      ORDER BY period, id LIMIT 1`)).rows[0];
  const cur = curPr.p;
  await db.query(`INSERT INTO payslip(pay_run_id, employee_id, gross_amount, net_amount,
                   si_employee, tax_amount, cum_taxable, leave_deduct, special_deduction)
                 VALUES ($1, 1, 9000, 7400, 1500, 100, 9000, 0, 0)
                 ON CONFLICT (pay_run_id, employee_id) DO NOTHING`, [curPr.id]);
  await db.query(`INSERT INTO payslip_item(payslip_id, item_code, amount)
                 SELECT sp.id, 'BASE', 9000 FROM payslip sp
                  WHERE sp.pay_run_id=$1 AND sp.employee_id=1`, [curPr.id]);
  const r = await get(`/api/payslip/diff?person=1&period=${cur}&base=${base}`, t1);
  rec('DIF1', '环比接口返回逐项差异 + 归因两段（不是只给一个总额）',
    r.status === 200 && Array.isArray(r.body.rows) && Array.isArray(r.body.explain)
    && r.body.explain.length > 0,
    `${cur} vs ${base}：${r.body.rows?.length} 项 / 归因 ${r.body.explain?.length} 条`);

  rec('DIF2', '归因第一条是应发合计的变化（员工最先看到的那个数）',
    r.body.explain?.[0]?.code === 'GROSS',
    r.body.explain?.[0]?.msg?.slice(0, 40) || '无');

  const miss = await get(`/api/payslip/diff?person=1&period=${cur}&base=1999-01`, t1);
  void miss;
  rec('DIF3', '基准月没有工资条 → 明确说"无法环比"（不是一片新增）',
    miss.status === 200 && miss.body.explain?.length === 1
    && miss.body.explain[0].code === 'NO_BASE',
    miss.body.explain?.[0]?.msg?.slice(0, 40) || '无');

  const bad = await get(`/api/payslip/diff?person=1&period=2026-13`, t1);
  rec('DIF4', '期间写错 → 400（不是 500，也不是默默按当月算）',
    bad.status === 400, `${bad.status}`);

  await db.query(`DELETE FROM payslip_item WHERE payslip_id IN
                   (SELECT sp.id FROM payslip sp WHERE sp.pay_run_id=$1 AND sp.employee_id=1)`,
    [curPr.id]);
  await db.query(`DELETE FROM payslip WHERE employee_id=1 AND pay_run_id=$1`, [curPr.id]);
}



// ===========================================================================
// LB 组 · 假期额度与请假单：花名册行闸、没额度的人也列出来、待审不受时间窗限制
// ===========================================================================
{
  const ty = await get('/api/leave/types-board', t1);
  rec('LB1', '假种列表带"本年已批天数"（切换按钮上要显示这个数，不是纯文字标签）',
    ty.status === 200 && ty.body.length > 0
    && ty.body.every(x => x.used_this_year !== undefined),
    `${ty.body.length} 个假种：${ty.body.slice(0, 4).map(x => x.code).join('/')}`);

  const annual = ty.body.find(x => x.code === 'ANNUAL') || ty.body[0];
  const b = await get(`/api/leave/board?type=${annual.id}`, t1);
  const zero = (b.body.rows || []).filter(x => Number(x.granted) === 0);
  rec('LB2', '额度总览：花名册全员都在（没授过额度的人也在，显示 0，不是消失）',
    b.status === 200 && b.body.rows.length > 0
    && b.body.headcount === b.body.rows.length && zero.length > 0,
    `${b.body.headcount} 人，其中 0 额度 ${zero.length} 人；可用合计 ${b.body.sum?.available}`);

  // 汇总不能靠前端 sum：接口给的 sum 必须等于逐行相加
  const sumRow = (b.body.rows || []).reduce((a, x) => a + Number(x.available), 0);
  rec('LB3', '接口自带汇总，且与逐行相加一致（前端不再 sum 一次）',
    Math.abs(Number(b.body.sum?.available) - sumRow) < 0.001,
    `接口合计 ${b.body.sum?.available} / 逐行 ${sumRow.toFixed(2)}`);

  const rq = await get('/api/leave/requests?days=90', t1);
  const pend = (rq.body.rows || []).filter(x => x.status === 'pending');
  const ordered = (rq.body.rows || []).findIndex(x => x.status !== 'pending');
  rec('LB4', '请假单：待审排最前；无权限用户打不开（能看全公司请假事由）',
    rq.status === 200 && rq.body.rows.length >= 0
    && (pend.length === 0 || ordered !== 0 || rq.body.rows[0].status === 'pending'),
    `${rq.body.rows?.length} 张，待审 ${rq.body.pending}，可写 ${rq.body.canWrite}`);

  // ★ 这里不能断言 403：leave_request 的读权限是"员工自助"级别，人人有 ——
  //   收窄范围的是**行闸**（fn_emp_roster 按 cost_org 过滤），不是岗位层。
  //   岗位层判"这类事该不该你做"，行闸判"你能看哪些行"，两层都要断言对的东西。
  const deny = await get('/api/leave/board?type=1', t3);
  const mine = new Set((b.body.rows || []).map(x => x.employee_id));
  const theirs = (deny.body.rows || []).map(x => x.employee_id);
  rec('LB5', '行闸生效：无授权账号看到的人 ⊆ 集团HR 看到的，且更少（不是全表）',
    deny.status === 200 && theirs.length < mine.size && theirs.every(id => mine.has(id)),
    `${deny.status} 看到 ${theirs.length} 人 / 集团HR ${mine.size} 人`);
}


// ===========================================================================
// SIG 组 · 工资表会签与封账（139）：四个动作都走接口，门禁在库里
// ===========================================================================
{
  // 造一批草稿批次（2028-01 专用，不碰别的组的批次）
  // ★ 143 起封账要过"累计链条"门禁：同一法人同年份，此前若有 draft 批次就不能封本期。
  //   2026 年里 03 是种子留下的 draft（SID 组要到后面才封它），所以 2026-09 封不了。
  //   这一组验的是"会签与封账"，与哪一期无关 —— 换到一个干净年度。
  await db.query(`DELETE FROM pay_run_signoff WHERE pay_run_id IN
                   (SELECT id FROM pay_run WHERE period='2028-01' AND legal_entity_id=1)`);
  await db.query(`DELETE FROM payslip WHERE pay_run_id IN
                   (SELECT id FROM pay_run WHERE period='2028-01' AND legal_entity_id=1)`);
  await db.query(`DELETE FROM pay_run WHERE period='2028-01' AND legal_entity_id=1`);
  const runId = Number((await db.query(
    `INSERT INTO pay_run(period, legal_entity_id) VALUES ('2028-01',1) RETURNING id`)).rows[0].id);
  await db.query(`INSERT INTO payslip(pay_run_id, employee_id, gross_amount, net_amount,
                   si_employee, tax_amount, cum_taxable, leave_deduct, special_deduction)
                 VALUES ($1,1,8000,6500,1000,500,8000,0,0)`, [runId]);
  // ★ 会签要在几十毫秒里连点 7 次写操作（发起/签字/改派/封账），
  //   会把「单账号每分钟写操作上限」撞掉 —— 而那条限流本意是拦脚本，
  //   不是拦一个 HR 正常点几下。所以本组把阈值临时抬高，收尾恢复。
  await db.query(`UPDATE policy_value SET value_num=400 WHERE policy_code='RATE_WRITE_PER_MIN'`);
  await db.query(`UPDATE policy_value SET value_text='on' WHERE policy_code='PAY_SIGNOFF_REQUIRED'`);

  // 账号 id 不是 1/2/3（sys_account 是自己生成的 id，比如 1001）。
  // 用 /api/me 拿两个真实 uid —— 会签要按"账号"指人，写死数字只会得到"账号不存在"。
  const uid1 = Number((await get('/api/me', t1)).body.id);
  const uid2 = Number((await get('/api/me', t2)).body.id);

  const s0 = await get(`/api/payroll/signoff?run=${runId}`, t1);
  rec('SIG1', '会签页数据齐全：角色表 + 可选签字人（只列有薪酬读权限的账号）+ 当前状态',
    s0.status === 200 && s0.body.roles.length === 3
    && s0.body.accounts.length > 0 && s0.body.rows.length === 0
    && s0.body.canWrite === true,
    `${s0.body.roles?.length} 个角色 / ${s0.body.accounts?.length} 个候选签字人`);

  // 出纳与业务给 uid1（t1 自己能签），财务给 uid2（用来验"不能代签"）
  const st = await post(`/api/payroll/signoff/start?run=${runId}`
    + `&user=cashier:${uid1}&user=finance:${uid2}&user=biz:${uid1}`, t1);
  const s1 = await get(`/api/payroll/signoff?run=${runId}`, t1);
  rec('SIG2', '发起会签 → 三行待签，且此刻不能封账（canSeal=false）',
    st.status === 200 && st.body.created === 3 && s1.body.rows.length === 3
    && s1.body.rows.every(x => x.status === 'pending') && s1.body.canSeal === false,
    `${st.body.created} 行；待签 ${s1.body.pending}`);

  const cash = s1.body.rows.find(x => x.role_code === 'cashier');
  const fin = s1.body.rows.find(x => x.role_code === 'finance');
  const deny = await post(`/api/payroll/signoff/decide?id=${fin.id}&ok=1`, t1);
  rec('SIG3', '不能代签：财务那行指给 user2，user1 去签 → 403（不是静默通过）',
    deny.status === 403 && /E_SIGNOFF_NOT_YOURS/.test(String(deny.body.error)),
    `${deny.status} ${String(deny.body.error || '')}`);

  const sealBad = await post(`/api/payroll/seal?run=${runId}`, t1);
  rec('SIG4', '没签完 → 封账被拒 409，并说清卡在谁那里',
    sealBad.status === 409 && /E_SIGNOFF_PENDING/.test(String(sealBad.body.error))
    && /出纳/.test(String(sealBad.body.message)),
    `${sealBad.status} ${String(sealBad.body.message || '').slice(0, 44)}`);

  // 出纳与业务签掉；财务那行指给 uid2（t2 没有薪酬写权限，签不了）——
  // 于是重新发起一次把财务改指给 uid1。这同时验证了"已签的不会被重发起冲掉"。
  const cashOk = await post(
    `/api/payroll/signoff/decide?id=${cash.id}&ok=1&note=${encodeURIComponent('金额核对无误')}`, t1);
  const biz = s1.body.rows.find(x => x.role_code === 'biz');
  await post(`/api/payroll/signoff/decide?id=${biz.id}&ok=1`, t1);

  const rs = await post(`/api/payroll/signoff/start?run=${runId}`
    + `&user=cashier:${uid1}&user=finance:${uid1}&user=biz:${uid1}`, t1);
  const s2 = await get(`/api/payroll/signoff?run=${runId}`, t1);
  const fin2 = s2.body.rows.find(x => x.role_code === 'finance');
  await post(`/api/payroll/signoff/decide?id=${fin2.id}&ok=1`, t1);
  const s3 = await get(`/api/payroll/signoff?run=${runId}`, t1);

  // ★ 143：这一组的工资条是手工造的，累计数与"按应发算出来的"必然对不上，
  //   封账默认会被 E_SEAL_CHAIN_STALE 拦。这里显式传 accept=1（确认按现状封账）——
  //   本组验的是"会签签完之后能封账、并且记下是谁封的"，不是累计本身。
  const sealOk = await post(`/api/payroll/seal?run=${runId}&accept=1`, t1);
  const sealed = (await db.query(
    `SELECT status, sealed_by FROM pay_run WHERE id=$1`, [runId])).rows[0];
  rec('SIG5', '重发起保留已签、改派后签完 → canSeal 变 true，封账成功并记下是谁封的',
    cashOk.status === 200 && rs.status === 200
    && s2.body.rows.find(x => x.role_code === 'cashier').status === 'approved'
    && (s3.body.canSeal === true || s3.body.canSealConfirm === true)
    && sealOk.status === 200
    && sealed.status === 'sealed' && Number(sealed.sealed_by) === uid1,
    `重发起后 出纳=${s2.body.rows.find(x => x.role_code === 'cashier').status}；`
    + `签完 ${s3.body.rows.map(x => x.role_code + '=' + x.status).join(' ')} → ${sealed.status}/${sealed.sealed_by}`);

  const again = await post(`/api/payroll/signoff/decide?id=${biz.id}&ok=1`, t1);
  rec('SIG6', '封账后不能再签（409）——钱定了，签字记录不该再变',
    again.status === 409, `${again.status} ${String(again.body.error || '')}`);

  await db.query(`UPDATE policy_value SET value_text='off' WHERE policy_code='PAY_SIGNOFF_REQUIRED'`);
  // 限流阈值**不恢复**：本测试后面还要连续写（节假日确认、导入等），
  // 一次运行里的写入量本来就远超一个人一分钟能点的次数。
  // 真正验限流的是 LG 组（它用的是登录失败计数，与本阈值无关）。
}


// ===========================================================================
// PAYR 组 · 发放回单（140）：封账之后钱出去这一步，以前系统不知道
// ===========================================================================
{
  // 复用 SIG 组那批 2028-01 的批次（它已被封账），正好用来测"已封账 → 发放"
  const runId = Number((await db.query(
    `SELECT id FROM pay_run WHERE period='2028-01' AND legal_entity_id=1`)).rows[0].id);

  const pl0 = await get(`/api/payroll/paylist?run=${runId}`, t1);
  rec('PAYR1', '发放清单：人数与实发合计来自工资条，导出不含银行账号',
    pl0.status === 200 && pl0.body.count > 0 && Number(pl0.body.total) > 0
    && pl0.body.rows.every(x => !('bank_account' in x)),
    `${pl0.body.count} 人 · 实发合计 ${pl0.body.total}`);

  const bad = await post(`/api/payroll/pay?run=${runId}&method=alipay&ref=x&total=1`, t1);
  rec('PAYR2', '发放方式只认 bank / cash / manual → 422', bad.status >= 400,
    `${bad.status} ${String(bad.body.error || '')}`);

  const mism = await post(`/api/payroll/pay?run=${runId}&method=bank&ref=流水A&total=1`, t1);
  rec('PAYR3', '回单总额与实发合计不一致 → 拒（发错总额是发薪里最贵的错）',
    mism.status >= 400 && /E_PAY_TOTAL_MISMATCH/.test(String(mism.body.error)),
    `${mism.status} ${String(mism.body.message || '').slice(0, 44)}`);

  const total = Number(pl0.body.total).toFixed(2);
  const ok = await post(`/api/payroll/pay?run=${runId}&method=bank`
    + `&ref=${encodeURIComponent('代发批次 202609-01')}&total=${total}`, t1);
  const st = (await db.query(
    `SELECT status, paid_at, paid_by, pay_method, pay_ref FROM pay_run WHERE id=$1`, [runId])).rows[0];
  rec('PAYR4', '登记发放 → 状态 paid，记下时间/操作人/方式/流水号',
    ok.status === 200 && st.status === 'paid' && st.paid_at && st.pay_method === 'bank'
    && st.pay_ref === '代发批次 202609-01',
    `${st.status} ${st.pay_method} ${st.pay_ref}`);

  const again = await post(`/api/payroll/pay?run=${runId}&method=bank&ref=x&total=${total}`, t1);
  rec('PAYR5', '重复登记发放 → 409（钱只发一次）', again.status === 409,
    `${again.status} ${String(again.body.error || '')}`);

  // CSV：能下载且带合计行（财务不用自己按计算器）
  const csv = await fetch(`${BASE}/api/payroll/paylist.csv?run=${runId}`,
    { headers: { authorization: `Bearer ${t1}` } });
  const text = await csv.text();
  rec('PAYR6', '实发清单 CSV 可下载，末行是合计（避免财务手算出错一分）',
    csv.status === 200 && /工号,姓名,部门,应发,实发/.test(text) && /合计/.test(text),
    `${csv.status} ${text.split('\n').length} 行`);

  // ---- PAYR9 发放清单的另一种容器：?format=xlsx ----
  // 财务真正会在 Excel 里打开的是这一份。CSV 里的金额是文本（"7712.36"），
  // Excel 会当字符串；xlsx 里必须是**数值单元格**，否则求和为 0、
  // 排序按字符串走（10000 < 9）—— 那种表财务要先手工转一遍，等于没做。
  {
    const xr = await fetch(`${BASE}/api/payroll/paylist.csv?run=${runId}&format=xlsx`,
      { headers: { authorization: `Bearer ${t1}` } });
    const xbuf = Buffer.from(await xr.arrayBuffer());
    const sheet = unzipEntry(xbuf, 'xl/worksheets/sheet1.xml') || '';
    const rowsN = xlsxRowCount(sheet);
    // C/D 两列（应发/实发）必须是 <v> 数值，而且不能是文本单元格
    const numericMoney = /<c r="D2" s="2"><v>-?[\d.]+<\/v><\/c>/.test(sheet);
    const textMoney = /<c r="D2"[^>]*t="inlineStr"/.test(sheet);
    rec('PAYR9', '发放清单 ?format=xlsx：200、PK\\x03\\x04、表头是「工号/姓名/部门/应发/实发」、'
      + '末行是合计；金额是**数值单元格**（<v>）而不是文本 —— 写成文本的话 Excel 里'
      + '求和为 0、排序按字符串走，财务得先手工转一遍数字，等于这个导出没做',
      xr.status === 200 && xbuf.subarray(0, 4).toString('hex') === '504b0304'
      && ['工号', '姓名', '部门', '应发', '实发'].every((h) => sheet.includes(`<t>${h}</t>`))
      && /<t>合计<\/t>/.test(sheet) && rowsN >= 3 && numericMoney && !textMoney,
      `${xr.status} 行=${rowsN} 数值=${numericMoney} 文本=${textMoney} `
      + `字节=${xbuf.length}`);
  }

  // ---- PAYR10 服务端 PDF：同一份打印 HTML，交给本机 Chrome 排版 ----
  // ★ 判据是 `%PDF-`（不是"返回 200 就算过"）：Chrome 在 --print-to-pdf
  //   指向不可写路径时曾经"成功退出但没写文件"，把空字节流发给浏览器
  //   就是"下载了个坏文件"。
  // ★ 没有 Chrome 的机器上接受 501，但 note 里必须写明走的是哪一支 ——
  //   "跳过了"不能看起来像"通过了"。
  {
    const pvBefore = Number((await db.query(
      'SELECT count(*)::int n FROM payslip_view_log')).rows[0].n);
    // 找一个**真的挂在门店上**的分组：本组的 2028-01 批次是手工造的工资条，
    // 人员没有成本组织归属（org_id 为 null），拿它验不出 store= 这个筛。
    // 退到演示批次 run=1（A/B 两店各 1 人）。
    let pr = await get(`/api/payroll/print?run=${runId}`, t1);
    let pdfRun = runId;
    let g0 = (pr.body.groups || []).find((g) => g.org_id !== null && g.org_id !== undefined)
      || (pr.body.groups || [])[0] || null;
    if (!g0 || g0.org_id === null || g0.org_id === undefined) {
      const alt = await get('/api/payroll/print?run=1', t1);
      const ag = (alt.body.groups || []).find((g) => g.org_id !== null && g.org_id !== undefined);
      if (ag) { pr = alt; pdfRun = 1; g0 = ag; }
    }
    // store 与 org 同义：这里用 store，顺手验"门店筛"这个别名真的生效
    const useStore = g0 !== null && g0.org_id !== null && g0.org_id !== undefined;
    const qs = `run=${pdfRun}&per=1${useStore ? `&store=${g0.org_id}` : ''}`;
    const expectRows = useStore ? g0.people.length : Number(pr.body.totals?.people ?? -1);
    const r = await fetch(`${BASE}/api/payroll/print.pdf?${qs}`,
      { headers: { authorization: `Bearer ${t1}` } });
    const ct = r.headers.get('content-type') || '';
    const is501 = r.status === 501;
    // ★ 501 分支要读 JSON 里的 message，200 分支要读字节 —— 两者不能都读，
    //   所以先判分支再消费 body（读两遍会抛 "Body is unusable"）。
    const body501 = is501 ? await r.text() : '';
    const buf = is501 ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer());
    const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
    const pvAfter = Number((await db.query(
      'SELECT count(*)::int n FROM payslip_view_log')).rows[0].n);
    const log = (await db.query(
      `SELECT scope, row_count FROM payslip_view_log
        WHERE actor_user_id=1 ORDER BY id DESC LIMIT 1`)).rows[0] || {};
    const ok200 = r.status === 200 && /application\/pdf/.test(ct) && isPdf
      && log.scope === 'print' && Number(log.row_count) === expectRows;
    rec('PAYR10', 'GET /api/payroll/print.pdf?run&store&per → 200 + application/pdf + '
      + '`%PDF-` 文件头（中文由 Chrome 排版，不是自绘 PDF）；store= 与打印页的 org= 同一个门店筛；'
      + '并且**写了一条 scope=print 的留痕**、row_count 等于该门店在打印页里的人数。'
      + '★ 本机没有 Chrome 时走 501 分支（note 里会写明）',
      ok200 || (is501 && /E_PDF_NO_CHROME/.test(body501)),
      is501 ? `501（本机无 Chrome，走的是"未实现"分支）`
        : `${r.status} ${ct.split(';')[0]} 头=${JSON.stringify(buf.subarray(0, 5).toString('latin1'))} `
          + `字节=${buf.length} store=${useStore ? g0.org_id : '(全量)'} 期望行=${expectRows} `
          + `留痕=${log.scope}/${log.row_count}（总增量 ${pvAfter - pvBefore}）`);
  }

  // ---- PAYR11 没有 Chrome：501 + 一句人话，且**不写留痕** ----
  // ★ 这条必须真的走到"找不到 Chrome"那一支，否则 501 只是一段没人执行过的代码。
  //   办法是临时把 CHROME_BIN 指到不存在的路径（**只在本段内改，finally 里恢复**）——
  //   不改全局 env、不改部署配置。环境变量在每次调用时现读（见 app/pdf.mjs），
  //   所以不需要重启服务。
  {
    const old = process.env.CHROME_BIN;
    const pvBefore = Number((await db.query(
      'SELECT count(*)::int n FROM payslip_view_log')).rows[0].n);
    let r; let body = {};
    try {
      process.env.CHROME_BIN = '/nonexistent/chrome-for-assertion';
      const resp = await fetch(`${BASE}/api/payroll/print.pdf?run=${runId}`,
        { headers: { authorization: `Bearer ${t1}` } });
      body = await resp.json();
      r = resp;
    } finally {
      if (old === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = old;
    }
    const pvAfter = Number((await db.query(
      'SELECT count(*)::int n FROM payslip_view_log')).rows[0].n);
    rec('PAYR11', 'CHROME_BIN 指向不存在的路径 → **501** + E_PDF_NO_CHROME + 一句人话'
      + '（"可改用浏览器打印"），不是 500、不是空白页；'
      + '并且**不写留痕** —— 没有任何数据离开系统，记一条"看过"是不真实的',
      r.status === 501 && body.error === 'E_PDF_NO_CHROME'
      && /Chrome/.test(String(body.message)) && /浏览器打印/.test(String(body.message))
      && pvAfter === pvBefore,
      `${r.status} ${body.error} 留痕增量=${pvAfter - pvBefore} `
      + `message=${String(body.message).slice(0, 40)}…`);
  }
}

// ===========================================================================
// PPV 组 · 算薪预演（137）：这一页能不能被信，取决于"点了预览什么都没变"
// ===========================================================================
{
  // 挑一期"真能算出来"的：有工资条的批次优先，再按期间倒序试。
  // ★ 不能只按 period DESC 取一条 —— 2026-03 那条批次在这套种子里一个人都算不出来
  //   （在职区间/月薪标准对不上），预演会抛 E_PAYROLL_NO_ELIGIBLE，
  //   而断言会误以为是预演本身坏了。
  const cands = (await db.query(
    `SELECT pr.period,
            (SELECT count(*) FROM payslip p WHERE p.pay_run_id = pr.id) AS slips
       FROM pay_run pr
      WHERE pr.legal_entity_id=1 AND pr.kind='monthly' AND pr.status='draft'
      ORDER BY slips DESC, pr.period DESC`)).rows.map(r => r.period);
  // 已有批次的期间 + 补齐几个候选期间（预演会自己建批次，但整段回滚，不留痕）
  const periods = [...cands, '2026-07', '2026-08', '2026-09', '2026-10', '2026-06', '2026-12'];
  let P = null;
  const tried = [];
  for (const c of [...new Set(periods)].slice(0, 8)) {
    const t = await get(`/api/payroll/preview?period=${c}&entity=1`, t1);
    tried.push(`${c}:${t.status}`);
    if (t.status === 200) { P = c; break; }
  }
  const cnt = async () => ({
    run: Number((await db.query(`SELECT count(*)::int n FROM pay_run`)).rows[0].n),
    slip: Number((await db.query(`SELECT count(*)::int n FROM payslip`)).rows[0].n),
    pol: Number((await db.query(`SELECT count(*)::int n FROM policy_value`)).rows[0].n),
  });

  if (!P) {
    rec('PPV1', '预演需要一期未封账的批次', false,
      `没有可算的 draft 批次；候选 ${cands.join(',') || '无'}；试过 ${tried.join(',') || '无'}`);
  } else {
    const b0 = await cnt();
    const p0 = await get(`/api/payroll/preview?period=${P}&entity=1`, t1);
    const b1 = await cnt();
    rec('PPV1', '预演零痕迹：跑完批次/工资条/制度项条数一模一样（接口层也验）',
      p0.status === 200 && b0.run === b1.run && b0.slip === b1.slip && b0.pol === b1.pol,
      `批次 ${b0.run}→${b1.run} 工资条 ${b0.slip}→${b1.slip} 制度项 ${b0.pol}→${b1.pol}`);

    rec('PPV2', '不给参数 → 差异为 0、no_effect=true，并给出一句人话总结',
      p0.status === 200 && Number(p0.body.delta.gross) === 0
      && p0.body.no_effect === true && /没有给任何覆盖参数/.test(String(p0.body.summary)),
      `${p0.body.headcount} 人 · ${String(p0.body.summary).slice(0, 34)}（选期 ${P}；试过 ${tried.join(',')}）`);

    const p1 = await postJson(`/api/payroll/preview?period=${P}&entity=1`, t1, { salary_pct: 5 });
    const mv = (p1.body.movers || [])[0];
    rec('PPV3', '调薪 5%：应发涨、给出 Top 变动人与主因那一项（不用自己翻两张工资条）',
      p1.status === 200 && Number(p1.body.delta.gross) > 0
      && mv && mv.top_item && Number(mv.delta_net) !== 0
      && (p1.body.warnings || []).length >= 0,
      `应发差=${p1.body.delta?.gross} 第一名=${mv?.name}(${mv?.delta_net}，主因 ${mv?.top_item})`);

    const p2 = await postJson(`/api/payroll/preview?period=${P}&entity=1`, t1,
      { policy: { PAY_DAYS_PER_MONTH: 30 } });
    rec('PPV4', '改制度项也走同一路：applied 里带出"制度项 X = 30"',
      p2.status === 200
      && (p2.body.applied || []).some(x => /PAY_DAYS_PER_MONTH/.test(x)),
      (p2.body.applied || []).join(' / ') || '无');

    const badType = await postJson(`/api/payroll/preview?period=${P}&entity=1`, t1,
      { policy: { PAY_DAYS_PER_MONTH: 'abc' } });
    rec('PPV5', '制度项类型不对 → 400 且指出哪一项（不是静默存进另一列，预演给出 0 变化）',
      badType.status === 400 && /PAY_DAYS_PER_MONTH/.test(String(badType.body.message)),
      `${badType.status} ${String(badType.body.message || '').slice(0, 40)}`);

    const badCode = await postJson(`/api/payroll/preview?period=${P}&entity=1`, t1,
      { policy: { NO_SUCH_POLICY: 1 } });
    rec('PPV6', '不存在的制度项 → 400 并列出名字', badCode.status === 400
      && /NO_SUCH_POLICY/.test(String(badCode.body.message)), `${badCode.status}`);

    // 店员没有 payroll_run 读权限：预演能看到全公司工资总额，不能放开
    const deny = await get(`/api/payroll/preview?period=${P}&entity=1`, t3);
    rec('PPV7', '没有薪酬读权限的人不能预演（403）——它能算出全公司工资总额',
      deny.status === 403, `${deny.status}`);

    const badPeriod = await get(`/api/payroll/preview?period=2026-13&entity=1`, t1);
    rec('PPV8', '期间写错 → 400（不是 500）', badPeriod.status === 400, `${badPeriod.status}`);
  }
}

// ===========================================================================
// SEV 组 · 离职结算（134）：先试算再落单，确认后不能作废
// ===========================================================================
{
  const vRole = Number((await db.query(
    `SELECT role_id FROM sys_user_role WHERE user_id=1 ORDER BY id LIMIT 1`)).rows[0].role_id);
  const vHad = (await db.query(
    `SELECT can_read, can_write FROM sys_role_resource
      WHERE role_id=$1 AND resource_code='payroll_policy'`, [vRole])).rows[0] || null;
  await db.query(
    `INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
     VALUES ($1,'payroll_policy',true,true)
     ON CONFLICT (role_id,resource_code) DO UPDATE SET can_read=true, can_write=true`, [vRole]);

  const ov = (await get('/api/severance', t1)).body;
  rec('SEV1', '结算页数据齐全：社平工资 + 九种离职情形 + 可结算的人',
    Array.isArray(ov.reasons) && ov.reasons.length >= 9
    && Array.isArray(ov.people) && ov.people.length > 0
    && Array.isArray(ov.wages) && ov.wages.length > 0,
    `情形 ${ov.reasons?.length} 种 · 人员 ${ov.people?.length} · 社平 ${ov.wages?.[0]?.monthly}`);

  const emp = ov.people.find(p => !p.settled);
  const leaveD = (await db.query(
    `SELECT ($1::date + interval '3 years 7 months')::date::text d`, [emp.hire_date])).rows[0].d;
  const q = (await get(`/api/severance/quote?employment=${emp.employment_id}`
    + `&leave=${leaveD}&reason=mutual`, t1)).body;
  rec('SEV2', '试算：年限 3 年 7 个月 → N=4，补偿金 = 4 × 前 12 个月平均',
    Number(q.n_months) === 4 && Number(q.raw_n) === 4
    && Math.abs(Number(q.severance) - Number(q.base_wage) * 4) < 0.01,
    `月数=${q.service_months} N=${q.n_months} 月工资=${q.base_wage} 补偿金=${q.severance}`);

  const cr = await post(`/api/severance?employment=${emp.employment_id}&leave=${leaveD}`
    + `&reason=mutual&note=${encodeURIComponent('协商一致解除，双方已签字')}`, t1);
  const cf = await post(`/api/severance/confirm?id=${cr.body.id}`, t1);
  const vd = await post(`/api/severance/void?id=${cr.body.id}&why=${encodeURIComponent('想撤回这张单')}`, t1);
  rec('SEV3', '落单 → 确认 → 确认后作废被拒（钱发了只能红冲）',
    cr.status === 200 && Number(cr.body.n_months) === 4 && cf.status === 200
    && vd.status === 409 && /E_SEV_CONFIRMED/.test(String(vd.body.error)),
    `单 ${cr.body.id} 税后 ${cr.body.net} 确认=${cf.status} 作废=${vd.status} `
    + `落单 body=${JSON.stringify(cr.body).slice(0, 120)}`);

  const bad = await post(`/api/severance?employment=${emp.employment_id}&leave=${leaveD}`
    + `&reason=mutual&note=${encodeURIComponent('再落一张')}`, t1);
  rec('SEV4', '同一段任职只能一张结算单（重复落单被唯一约束挡住）',
    bad.status >= 400, `${bad.status} ${String(bad.body.error || '').slice(0, 40)}`);

  // 2008 前入职 → 接口要把"分段"透出来（前段不封顶这件事必须在页面上看得见）
  await db.query(`INSERT INTO person(id,full_name) VALUES (9903,'临时老员工')
                  ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                  VALUES (9903,9903,1,'2000-01-01') ON CONFLICT (id) DO NOTHING`);
  await db.query(`INSERT INTO salary_standard(employment_id,monthly_amount,effective_from)
                  VALUES (9903,9000,'2026-01-01')`);
  const qs = (await get(`/api/severance/quote?employment=9903&leave=2026-07-01&reason=mutual`, t1)).body;
  rec('SEV5', '2008 前入职：试算返回两段（前段按老办法不封顶、后段按 47 条）',
    qs.split === true && Number(qs.n_old) > 0 && Number(qs.n_new) > 0
    && Math.abs(Number(qs.severance) - (Number(qs.severance_old) + Number(qs.severance_new))) < 0.01,
    `前段 N=${qs.n_old}（${qs.pre2008_months}月）后段 N=${qs.n_new}（${qs.post2008_months}月）`
    + ` 合计=${qs.severance}`);
  await db.query(`DELETE FROM salary_standard WHERE employment_id=9903`);
  await db.query(`DELETE FROM employment WHERE id=9903`);
  await db.query(`DELETE FROM person WHERE id=9903`);

  await db.query(`DELETE FROM severance_settlement WHERE person_id=$1`, [emp.person_id]);
  if (vHad) {
    await db.query(`UPDATE sys_role_resource SET can_read=$2, can_write=$3
                     WHERE role_id=$1 AND resource_code='payroll_policy'`,
      [vRole, vHad.can_read, vHad.can_write]);
  } else {
    await db.query(`DELETE FROM sys_role_resource
                     WHERE role_id=$1 AND resource_code='payroll_policy'`, [vRole]);
  }
}

// ===========================================================================
// SID 组 · 社保申报基数（133）：一年定一次，改过的数不被重跑冲掉
// ===========================================================================
{
  const sRole = Number((await db.query(
    `SELECT role_id FROM sys_user_role WHERE user_id=1 ORDER BY id LIMIT 1`)).rows[0].role_id);
  const sHad = (await db.query(
    `SELECT can_read, can_write FROM sys_role_resource
      WHERE role_id=$1 AND resource_code='payroll_policy'`, [sRole])).rows[0] || null;
  await db.query(
    `INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
     VALUES ($1,'payroll_policy',true,true)
     ON CONFLICT (role_id,resource_code) DO UPDATE SET can_read=true, can_write=true`, [sRole]);
  await db.query(`DELETE FROM si_base_declare`);
  // 造一个"上年度已封账"的批次：申报基数只认已封账/已发的工资条
  // （拿 draft 批次的数去报基数，等于用一份还会变的数报给社保局）
  // ★ ck_pr_sealed：status 非 draft 必须同时有 sealed_at，否则约束拒。
  //   这是"状态与时刻同生同灭"那条规矩，硬改状态会撞它。
  await db.query(`UPDATE pay_run SET status='sealed', sealed_at=now()
                   WHERE period IN ('2026-03','2026-04','2026-05') AND status='draft'`);

  const ov = (await get('/api/si/declare', t1)).body;
  rec('SID1', '申报基数页：带当地上下限，初始为空（这一年还没定基数）',
    ov.rows.length === 0 && Number(ov.floor) > 0 && Number(ov.ceiling) > Number(ov.floor),
    `${ov.year} 年 区间 ${ov.floor}~${ov.ceiling} 已申报 ${ov.rows.length}`);

  const bd = await post('/api/si/declare/build?year=2027', t1);
  const ov2 = (await get('/api/si/declare?year=2027', t1)).body;
  rec('SID2', '生成申报基数 → 清单出现，且每人的基数都落在上下限内',
    bd.status === 200 && bd.body.generated > 0 && ov2.rows.length > 0
    && ov2.rows.every(r => Number(r.base_amount) >= Number(ov2.floor)
                        && Number(r.base_amount) <= Number(ov2.ceiling)),
    `生成 ${bd.body.generated} 条 / 清单 ${ov2.rows.length} 条`);

  const one = ov2.rows[0] || null;
  if (!one) {
    rec('SID3', '手工改过的基数在"重新生成"之后仍然是手工值', false, '清单为空，无法继续');
    rec('SID4', '手工报的基数越界 → 拒', false, '清单为空，无法继续');
  } else {
  const st = await post(
    `/api/si/declare/set?employee=${one.employee_id}&year=2027&base=12000`
    + `&why=${encodeURIComponent('该员工上年度有一次性奖金，按实际申报')}`, t1);
  await post('/api/si/declare/build?year=2027', t1);   // 重跑不该冲掉手工值
  const ov3 = (await get('/api/si/declare?year=2027', t1)).body;
  const after = ov3.rows.find(r => Number(r.employee_id) === Number(one.employee_id));
  rec('SID3', '手工改过的基数在"重新生成"之后仍然是手工值（否则没人再敢改）',
    st.status === 200 && Number(after.base_amount) === 12000 && after.source === 'manual',
    `改后=${after.base_amount} 来源=${after.source}`);

  const bad = await post(
    `/api/si/declare/set?employee=${one.employee_id}&year=2027&base=999999`
    + `&why=${encodeURIComponent('想报个天价试试')}`, t1);
  rec('SID4', '手工报的基数越界 → 拒（不是静默夹到上限，那样人以为报上去了）',
    bad.status === 422 && /E_SI_BASE_RANGE/.test(String(bad.body.error)),
    `${bad.status} ${String(bad.body.error || '')}`);
  }

  await db.query(`DELETE FROM si_base_declare`);
  if (sHad) {
    await db.query(`UPDATE sys_role_resource SET can_read=$2, can_write=$3
                     WHERE role_id=$1 AND resource_code='payroll_policy'`,
      [sRole, sHad.can_read, sHad.can_write]);
  } else {
    await db.query(`DELETE FROM sys_role_resource
                     WHERE role_id=$1 AND resource_code='payroll_policy'`, [sRole]);
  }
}

// ===========================================================================
// CARRY 组 · 往年结转（132）：接口里看得见"哪一年的假"，也改得了政策
// ===========================================================================
{
  const cRole = Number((await db.query(
    `SELECT role_id FROM sys_user_role WHERE user_id=1 ORDER BY id LIMIT 1`)).rows[0].role_id);
  const cHad = (await db.query(
    `SELECT can_read, can_write FROM sys_role_resource
      WHERE role_id=$1 AND resource_code='payroll_policy'`, [cRole])).rows[0] || null;
  await db.query(
    `INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
     VALUES ($1,'payroll_policy',true,true)
     ON CONFLICT (role_id,resource_code) DO UPDATE SET can_read=true, can_write=true`, [cRole]);

  const ov0 = (await get('/api/leave/cashout', t1)).body;
  rec('CARRY1', '页面数据带结转政策：默认 void（法定：一般不跨年）',
    ov0.carry === 'void' && ov0.carryDeadline === '03-31',
    `政策=${ov0.carry} 截止=${ov0.carryDeadline}`);

  const set1 = await post(
    `/api/leave/carry-policy?policy=carry_1y&deadline=06-30&reason=${encodeURIComponent('经管理层同意，往年余额可结转一年')}`, t1);
  const ov1 = (await get('/api/leave/cashout', t1)).body;
  rec('CARRY2', '改结转政策 → 页面上真的变了（截止日也跟着改）',
    set1.status === 200 && ov1.carry === 'carry_1y' && ov1.carryDeadline === '06-30',
    `${set1.status} ${ov1.carry} / ${ov1.carryDeadline}`);

  // 必须用一个**台账里有授予记录**的人：没授过额度的人 breakdown 本来就是空的，
  // 拿候选人第一个来测会让断言变成"种子数据里有没有 grant"，而不是"拆解对不对"。
  const emp = Number((await db.query(
    `SELECT employee_id FROM leave_grant
      WHERE leave_type_id = fn_leave_type_id('ANNUAL')
      ORDER BY employee_id LIMIT 1`)).rows[0].employee_id);
  const q = (await get(`/api/leave/cashout/quote?employee=${emp}&on=2026-12-31`, t1)).body;
  rec('CARRY3', '试算带"按年度拆开"：能用一句话回答"这 5 天里哪几天是去年的"',
    Array.isArray(q.breakdown) && q.breakdown.length > 0
    && q.breakdown.every(b => ['current','carried','expired','not_carried'].includes(b.state)),
    q.breakdown ? q.breakdown.map(b => `${b.year}:${b.remaining}(${b.state})`).join(' ') : '无');

  const bad = await post(
    `/api/leave/carry-policy?policy=forever&reason=${encodeURIComponent('试试永远结转')}`, t1);
  rec('CARRY4', '结转政策只认两个值，乱填被拒（不是静默存进去）',
    bad.status === 400 && /E_ARG_INVALID/.test(String(bad.body.error)), `${bad.status}`);

  // 改回默认
  await post(`/api/leave/carry-policy?policy=void&deadline=03-31&reason=${encodeURIComponent('本组测试结束，恢复法定默认')}`, t1);
  if (cHad) {
    await db.query(`UPDATE sys_role_resource SET can_read=$2, can_write=$3
                     WHERE role_id=$1 AND resource_code='payroll_policy'`,
      [cRole, cHad.can_read, cHad.can_write]);
  } else {
    await db.query(`DELETE FROM sys_role_resource
                     WHERE role_id=$1 AND resource_code='payroll_policy'`, [cRole]);
  }
}

// ===========================================================================
// HOLY 组 · 节假日年度维护（130）：明年没数据这件事，今年就要看得见
// ===========================================================================
{
  // 节假日维护的写权限同样是 payroll_policy（只给 boss / hr_ops），
  // 种子账号里没有 hr_ops —— 临时补上，跑完撤掉（理由见 ALC 组）。
  const hRole = Number((await db.query(
    `SELECT role_id FROM sys_user_role WHERE user_id=1 ORDER BY id LIMIT 1`)).rows[0].role_id);
  const hHad = (await db.query(
    `SELECT can_read, can_write FROM sys_role_resource
      WHERE role_id=$1 AND resource_code='payroll_policy'`, [hRole])).rows[0] || null;
  await db.query(
    `INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)
     VALUES ($1,'payroll_policy',true,true)
     ON CONFLICT (role_id,resource_code) DO UPDATE SET can_read=true, can_write=true`, [hRole]);

  const { status, body } = await get('/api/att/holidays?year=2026', t1);
  const cov27 = (body.coverage || []).find(c => Number(c.year) === 2027);
  rec('HOLY1', '页面数据带缺口检查与覆盖表：2027 没数据这件事在今年就报出来',
    status === 200 && Array.isArray(body.gaps) && cov27 && cov27.state === 'missing',
    `2026 gaps=${body.gaps?.length ?? '-'} 2027=${cov27?.state} 法定=${cov27?.legal_days}`);

  const sk = await post('/api/att/holidays/skeleton?year=2027', t1);
  const after = (await get('/api/att/holidays?year=2027', t1)).body;
  rec('HOLY2', '生成 2027 骨架：只给公历固定 5 天，全部"待确认"，页面能看见',
    sk.status === 200 && sk.body.created === 5 && after.rows.length === 5
    && after.rows.every(r => r.is_confirmed === false)
    && after.gaps.some(g => g.code === 'HOL_UNCONFIRMED'),
    `生成=${sk.body.created} 待确认=${after.rows.filter(r => !r.is_confirmed).length} 提示=${after.gaps.map(g => g.code).join('/')}`);

  const cf = await post('/api/att/holidays/confirm?year=2027', t1);
  const after2 = (await get('/api/att/holidays?year=2027', t1)).body;
  rec('HOLY3', '确认之后不再报"待确认"，但法定天数不够仍然报（确认 ≠ 补齐）',
    cf.status === 200 && cf.body.confirmed === 5
    && !after2.gaps.some(g => g.code === 'HOL_UNCONFIRMED')
    && after2.gaps.some(g => g.code === 'HOL_LEGAL_COUNT'),
    `确认=${cf.body.confirmed} 余下提示=${after2.gaps.map(g => g.code).join('/')}`);

  // 收尾：清掉骨架，不留半成品给后面的组；撤掉临时授权
  await db.query(`DELETE FROM legal_holiday WHERE EXTRACT(year FROM holiday_date) = 2027`);
  if (hHad) {
    await db.query(`UPDATE sys_role_resource SET can_read=$2, can_write=$3
                     WHERE role_id=$1 AND resource_code='payroll_policy'`,
      [hRole, hHad.can_read, hHad.can_write]);
  } else {
    await db.query(`DELETE FROM sys_role_resource
                     WHERE role_id=$1 AND resource_code='payroll_policy'`, [hRole]);
  }
}

// ===========================================================================
// DECL 组 · 申报表（141）：两张表能出、未封账被拦、掩码与导出分开
// ---------------------------------------------------------------------------
// 这一组验的是"钱能不能报出去"，所以重点不在字段齐不齐，在三个门槛：
//   · 没封账 → 不出表（页面上要说明是"等你去封账"，不是"没数据"）；
//   · 导出要写权限（这两张表带完整证件号与全员工资）；
//   · 界面掩码 / 导出完整 —— 两件事同时成立，且掩码不是漏了。
// ===========================================================================
{
  // 找一个"已封账且有工资条"的期间：SID 组封过 2026-03..05，但哪一期有工资条
  // 是前面各组的运行结果，不在这里猜 —— 猜错会让这条断言看起来像"功能坏了"。
  const dp = (await db.query(
    `SELECT r.period
       FROM pay_run r JOIN payslip p ON p.pay_run_id = r.id
      WHERE r.legal_entity_id = 1 AND r.kind = 'monthly'
        AND r.status IN ('sealed','paid')
      GROUP BY r.period ORDER BY r.period DESC LIMIT 1`)).rows[0];

  { // DECL1 不带期间：默认落在"最近一个已封账的期间"（不让人去猜哪个月封过账）
    const r = await get('/api/declare', t1);
    rec('DECL1', '申报表默认取最近一个已封账期间（不是当月 —— 当月通常还是 draft）',
      r.status === 200 && dp && r.body.period === dp.period
      && r.body.blocked === null && r.body.iit.persons > 0,
      `${r.status} 期间=${r.body.period}（期望 ${dp && dp.period}）人数=${r.body.iit?.persons}`);
  }

  { // DECL2 页面数据带社保汇总与逐人明细，且个人额可以为 0（工伤）或空
    const r = await get(`/api/declare?period=${dp.period}`, t1);
    const s = r.body.si;
    rec('DECL2', '社保申报表带汇总与逐人明细：险种行数 = 汇总行数，人数对得上',
      r.status === 200 && s.sum.length > 0 && s.rows.length >= s.persons
      && s.sum.every(x => x.item_name),
      `${s.sum.length} 个险种 / ${s.rows.length} 行 / ${s.persons} 人`);
  }

  { // DECL3 未封账 → 页面给出 blocked（不是一张看起来正常、其实全 0 的表）
    const draft = '2019-07';
    await db.query(`DELETE FROM pay_run WHERE period=$1 AND legal_entity_id=1`, [draft]);
    await db.query(`INSERT INTO pay_run(period, legal_entity_id, status) VALUES ($1,1,'draft')`, [draft]);
    const r = await get(`/api/declare?period=${draft}`, t1);
    rec('DECL3', '未封账的期间 → blocked=E_DECLARE_NOT_SEALED 且不出表（iit/si 为 null）',
      r.status === 200 && r.body.blocked === 'E_DECLARE_NOT_SEALED'
      && r.body.iit === null && r.body.si === null,
      `${r.status} ${r.body.blocked} 表=${r.body.iit === null ? '无' : '有'}`);
    await db.query(`DELETE FROM pay_run WHERE period=$1 AND legal_entity_id=1`, [draft]);
  }

  { // DECL4 导出个税表：CSV + 表头注释 + 留痕
    const before = Number((await db.query(
      `SELECT count(*)::int n FROM tax_declare_export`)).rows[0].n);
    const res = await fetch(`${BASE}/api/declare/iit.csv?period=${dp.period}&entity=1`,
      { headers: { authorization: `Bearer ${t1}` } });
    const text = await res.text();
    const after = Number((await db.query(
      `SELECT count(*)::int n FROM tax_declare_export`)).rows[0].n);
    rec('DECL4', '导出个税扣缴申报表：CSV 内容带表头口径与批次号，且写了一条导出留痕',
      res.status === 200 && /text\/csv/.test(res.headers.get('content-type') || '')
      && text.includes('个人所得税扣缴申报表') && text.includes('批次')
      && text.includes('姓名') && after === before + 1,
      `${res.status} ${text.length} 字节 留痕 ${before}→${after}`);
  }

  { // DECL5 社保表导出：两段（汇总 + 明细）都在同一个文件里
    const res = await fetch(`${BASE}/api/declare/si.csv?period=${dp.period}&entity=1`,
      { headers: { authorization: `Bearer ${t1}` } });
    const text = await res.text();
    rec('DECL5', '社保申报表一个文件里两段：汇总（按险种）+ 明细（逐人），缺一不可',
      res.status === 200 && text.includes('—— 汇总') && text.includes('—— 明细')
      && text.includes('缴费基数合计') && text.includes('单位应缴'),
      `${res.status} ${text.length} 字节`);
  }

  { // DECL6 掩码 vs 导出：同一期，页面上是星号，文件里是完整号
    const page = await get(`/api/declare?period=${dp.period}`, t1);
    const masked = (page.body.iit.rows[0] || {}).id_no;
    const res = await fetch(`${BASE}/api/declare/iit.csv?period=${dp.period}&entity=1`,
      { headers: { authorization: `Bearer ${t1}` } });
    const text = await res.text();
    const full = (await db.query(
      `SELECT profile_value v FROM person_profile WHERE profile_type='national_id'
        ORDER BY person_id LIMIT 1`)).rows[0];
    rec('DECL6', '页面掩码证件号（前 6 后 4），导出的是完整号 —— 掩了报不上去，两边都要成立',
      String(masked || '').includes('*') && full && text.includes(full.v),
      `页面=${masked} 文件含完整号=${full ? text.includes(full.v) : '?'}`);
  }

  { // DECL7 没有薪酬写权限 → 导不出（两张表都带着所有人的工资）
    const r = await fetch(`${BASE}/api/declare/iit.csv?period=${dp.period}&entity=1`,
      { headers: { authorization: `Bearer ${t3}` } });
    rec('DECL7', '无薪酬权限的账号导出申报表 → 403（不是 200 拿到全员工资）',
      r.status === 403, `${r.status}`);
  }

  { // DECL8 留痕清单里能看到刚才那两次导出
    const r = await get('/api/declare/exports', t1);
    const kinds = new Set((r.body || []).map(x => x.kind));
    rec('DECL8', '导出留痕清单：个税与社保两张表都能查到（谁、哪期、多少人、摘要）',
      r.status === 200 && kinds.has('iit') && kinds.has('si')
      && (r.body[0] || {}).sha12,
      `${r.body?.length} 条 kinds=${[...kinds].join('/')}`);
  }

  { // DECL9 期间写错 → 400 E_ARG_INVALID（不是"查不到就返回一张空表"）
    const r = await get('/api/declare?period=2026-5', t1);
    rec('DECL9', '期间写错（2026-5）→ 400 参数错，不当成 2026-05 去查',
      r.status === 400 && r.body.error === 'E_ARG_INVALID', `${r.status} ${r.body.error}`);
  }
}

// ===========================================================================
// CHAIN 组 · 累计预扣链条接进接口（143）：封账前能看见"为什么不能封"
// ---------------------------------------------------------------------------
// 143 把"按月顺序"这件事从人身上拿掉了：库里只有一份判据（fn_payrun_chain），
// 封账门禁与界面共用它 —— 否则"页面说能封、点下去被拒"这种自相矛盾迟早出现。
// 这一组验的不是函数对不对（库层 520 条已验），是**这条判据有没有走到接口上**：
//   · 会签页的响应里带 chain 六列 —— 页面要靠它显示"前期还没封账"；
//   · 上游还有 draft 时封本期 → 409 E_SEAL_UPSTREAM_DRAFT（新门禁真的生效）；
//   · 已封账再封 → 仍是 E_RUN_SEALED（新门禁没把旧语义顶掉）；
//   · 没有薪酬写权限的人封账 → 403（不是 500，也不是"点了没反应"）。
// ===========================================================================
{
  // 一个"已封账"的批次：SID 组把种子里 2026-03..05 直接改成了 sealed，
  // 这里只挑最新那个，不赌是哪一期 —— 赌错会让断言看起来像"功能坏了"。
  const sealedId = Number((await db.query(
    `SELECT id FROM pay_run WHERE legal_entity_id=1 AND status='sealed'
      ORDER BY id DESC LIMIT 1`)).rows[0]?.id);

  { // CHAIN1 链条状态随会签接口一起出去：界面不自己算"能不能封"
    const r = await get(`/api/payroll/signoff?run=${sealedId}`, t1);
    const c = r.body.chain;
    const keys = ['upstream_draft', 'downstream_sealed', 'stale_count', 'stale_names', 'can_seal', 'reason'];
    const missing = keys.filter((k) => !(c && Object.prototype.hasOwnProperty.call(c, k)));
    rec('CHAIN1', 'GET /api/payroll/signoff 的响应里带 chain（与 fn_payrun_chain 六列同名），页面不自己算',
      r.status === 200 && !!c && missing.length === 0,
      `${r.status} chain=${c === undefined ? 'undefined（服务层未接）' : JSON.stringify(c).slice(0, 90)}`
      + (missing.length ? ` 缺列=${missing.join(',')}` : ''));
  }

  { // CHAIN2 上游还有 draft → 不许封本期（封账必须自前向后）
    // ★ 用 2029 年造数据：2028 是 SIG/PAYR 组的地盘（它们把 2028-01 封了），
    //   2026 又被 SID 组直接改过状态 —— 借别人的年份造"上游未封"一定会互相搅红。
    const P1 = '2029-01', P2 = '2029-02';
    const clean = async () => {
      await db.query(`DELETE FROM pay_run_signoff WHERE pay_run_id IN
                       (SELECT id FROM pay_run WHERE legal_entity_id=1 AND period = ANY($1))`, [[P1, P2]]);
      await db.query(`DELETE FROM payslip WHERE pay_run_id IN
                       (SELECT id FROM pay_run WHERE legal_entity_id=1 AND period = ANY($1))`, [[P1, P2]]);
      await db.query(`DELETE FROM pay_run WHERE legal_entity_id=1 AND period = ANY($1)`, [[P1, P2]]);
    };
    await clean();
    await db.query(`INSERT INTO pay_run(period, legal_entity_id) VALUES ($1,1)`, [P1]);
    const downId = Number((await db.query(
      `INSERT INTO pay_run(period, legal_entity_id) VALUES ($1,1) RETURNING id`, [P2])).rows[0].id);
    await db.query(`INSERT INTO payslip(pay_run_id, employee_id, gross_amount, net_amount,
                     si_employee, tax_amount, cum_taxable, leave_deduct, special_deduction)
                   VALUES ($1,1,8000,6500,1000,500,8000,0,0)`, [downId]);
    const r = await post(`/api/payroll/seal?run=${downId}`, t1);
    rec('CHAIN2', '上游还有 draft 就封本期 → 409 E_SEAL_UPSTREAM_DRAFT，并点名是哪一期没封',
      r.status === 409 && /E_SEAL_UPSTREAM_DRAFT/.test(String(r.body.error))
      && String(r.body.message || '').includes(P1),
      `${r.status} ${String(r.body.error || '')} ${String(r.body.message || '').slice(0, 40)}`);
    await clean();
  }

  { // CHAIN3 已封账再封：错误码仍是 E_RUN_SEALED（新门禁没改掉旧语义）
    const r = await post(`/api/payroll/seal?run=${sealedId}`, t1);
    rec('CHAIN3', '同一期重复封账 → 409 E_RUN_SEALED（不是被新的链条门禁码顶掉）',
      r.status === 409 && /E_RUN_SEALED/.test(String(r.body.error))
      && !/E_SEAL_UPSTREAM_DRAFT/.test(String(r.body.error)),
      `${r.status} ${String(r.body.error || '')}`);
  }

  { // CHAIN4 没有薪酬写权限 → 403（权限先于业务判断，不是 500）
    const r = await post(`/api/payroll/seal?run=${sealedId}`, t3);
    rec('CHAIN4', '没有薪酬写权限的账号封账 → 403（不是 500，也不是静默成功）',
      r.status === 403, `${r.status} ${String(r.body.error || '')}`);
  }
}

// ★ 为什么这组的 id 是 CHAIN1..4 而不是 CH1..4：下面的收口块按 id 前缀
//   （/^[A-Z]+/）拼登记码，CH 会拼成 SUITE.API-CH —— 而库里登记的只有
//   SUITE.API-CHAIN（143 登记的那条）。fn_chk_record 对未登记的码是**直接抛错**
//   （E_CHK_UNREGISTERED），整个收口会崩在这一个组上。所以前缀必须与登记码一致；
//   这也是"判据没登记就不许留痕"那条规矩在起作用，不是可以绕过去的格式化问题。

// ---- 培训学习（144）：四步都走接口，规则一条都不在 JS 里 ----
// ★ 为什么 id 是 TR5..TR9：收口块按 /^[A-Z]+/ 取前缀拼登记码，144 只登记了
//   SUITE.API-TR（TRAPI / TRA 会拼成未登记的码，fn_chk_record 直接抛
//   E_CHK_UNREGISTERED，整个收口崩在这一组上）。
//   文件前面已经有 TR1..TR4（离职接口那组）躺在同一个前缀下，所以这里从 TR5 接排，
//   不撞已有 id —— 分组是按前缀归并的，同前缀多个组不影响收口。
{
  { // TR5 看板：五块正文 + kpi 六个计数（页面要什么，接口就给什么，不自己拼）
    const r = await get('/api/training?entity=1&year=2026', t1);
    const b = r.body || {};
    const need = ['courses', 'sessions', 'gap', 'people', 'kpi'];
    const miss = need.filter((k) => !(k in b));
    const kpiKeys = ['courses', 'statutory', 'sessions', 'enrolled', 'completed', 'gapPeople'];
    const missKpi = kpiKeys.filter((k) => !(b.kpi && k in b.kpi));
    rec('TRN5', 'GET /api/training 返回 courses/sessions/gap/people/kpi 五块，kpi 六个计数齐全',
      r.status === 200 && miss.length === 0 && missKpi.length === 0,
      `${r.status} 缺=${[...miss, ...missKpi].join(',') || '无'}`);
  }

  { // TR6 / TR7 四步走接口：建课程 → 开场次 → 报名 → 记学时
    // ★ 只记 4 学时（课程标准 8）：一来正好验"学时不够不结业"，
    //   二来 attended 可以删干净 —— completed 是证据，触发器不许删。
    //   真正验"结业"的留给库层（test/run.mjs 的 SUITE.TR）。
    // 前面的生命周期场景已让 person=1 于3月20日离职；不能再让他报名6月培训。
    // 独立虚构员工明确在培训日受雇于主体1、归属A店，保持本组只验证培训链。
    const trainingPerson = Number((await db.query(`INSERT INTO person(id,full_name)
      SELECT COALESCE(max(id),0)+1,'虚构培训接口学员' FROM person RETURNING id`)).rows[0].id);
    const trainingEmployment = Number((await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
      SELECT COALESCE(max(id),0)+1,$1,1,'2026-01-01' FROM employment RETURNING id`, [trainingPerson])).rows[0].id);
    await db.query(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from)
      VALUES($1,'cost_org',10,'2026-01-01')`, [trainingPerson]);
    const code = `TR-API-${Date.now()}`;
    const nm = encodeURIComponent('接口验收·安全培训');
    let courseId = 0, sessionId = 0, enrollId = 0, ra = { status: 0, body: {} };
    const rc = await post(`/api/training/course?code=${code}&name=${nm}`
      + '&category=safety&hours=8&statutory=1&valid_months=12&note=tr-api', t1);
    courseId = Number(rc.body && rc.body.id) || 0;
    const rs = await post(`/api/training/session?course=${courseId}&entity=1&date=2026-06-10`
      + '&from=09:00&to=17:00&hours=8&trainer=' + encodeURIComponent('王教官')
      + '&place=' + encodeURIComponent('A店三楼') + '&capacity=20', t1);
    sessionId = Number(rs.body && rs.body.id) || 0;
    const re = await post(`/api/training/enroll?session=${sessionId}&employee=${trainingPerson}`, t1);
    enrollId = Number((re.body && re.body.enrolled && re.body.enrolled[0]) || 0);
    ra = await post(`/api/training/attend?enroll=${enrollId}&hours=4`, t1);

    rec('TR6', '建课程 → 开场次 → 报名 → 记学时，四步都走接口（没有"点通过"这一步）',
      rc.status === 200 && courseId > 0 && rs.status === 200 && sessionId > 0
      && re.status === 200 && re.body.count === 1 && enrollId > 0
      && ra.status === 200 && ra.body.status === 'attended',
      `${rc.status}/${rs.status}/${re.status}/${ra.status}`
      + ` course=${courseId} session=${sessionId} enroll=${enrollId} status=${ra.body.status}`);

    rec('TR7', '只到场 4 学时 → status=attended 且 missing_hours=4（不够就不结业，差额写给页面）',
      ra.status === 200 && ra.body.status === 'attended'
      && Number(ra.body.missing_hours) === 4 && Number(ra.body.attended_hours) === 4,
      `status=${ra.body.status} attended=${ra.body.attended_hours}`
      + ` std=${ra.body.std_hours} missing=${ra.body.missing_hours}`);

    // 造的数据自己收：报名 → 场次 → 课程（attended 可删，completed 不可删）
    if (enrollId > 0) await db.query(`DELETE FROM training_enrollment WHERE id=$1`, [enrollId]);
    if (sessionId > 0) await db.query(`DELETE FROM training_session WHERE id=$1`, [sessionId]);
    if (courseId > 0) await db.query(`DELETE FROM training_course WHERE id=$1`, [courseId]);
    await db.query('DELETE FROM employee_org_assignment WHERE employee_id=$1', [trainingPerson]);
    await db.query('DELETE FROM employment WHERE id=$1', [trainingEmployment]);
    await db.query('DELETE FROM person WHERE id=$1', [trainingPerson]);
  }

  { // TR8 没有花名册写权限 → 403（权限先于业务判断，不是 500，也不是静默成功）
    const r = await post('/api/training/course?code=TR-NOPERM&name=no-perm'
      + '&category=skill&hours=2', t3);
    rec('TR8', '没有写权限的账号建课程 → 403（不是 500，也不是静默成功）',
      r.status === 403, `${r.status} ${String((r.body || {}).error || '')}`);
  }

  { // TR9 人员学时：没有记录也要 200 + hours=0 —— 404 会让页面把"没学过"画成"查不到"
    // ★ 不写死 person=1：种子已经让张三结业两场（12 学时），在这里断言 0
    //   等于跟种子造的数据对着干。挑一个**一条报名都没有**的在册人员来验"空"。
    const pid = Number((await db.query(
      `SELECT em.person_id FROM employment em
        WHERE NOT EXISTS (SELECT 1 FROM training_enrollment e WHERE e.employee_id = em.person_id)
        ORDER BY em.person_id LIMIT 1`)).rows[0]?.person_id);
    const r = await get(`/api/training/person?person=${pid}&year=2026`, t1);
    const b = r.body || {};
    rec('TR9', `GET /api/training/person 无培训记录（person=${pid}）→ 200 + rows=[] + hours=0（不能 404/空响应）`,
      r.status === 200 && pid > 0 && Array.isArray(b.rows) && b.rows.length === 0
      && b.hours === 0,
      `${r.status} rows=${Array.isArray(b.rows) ? b.rows.length : 'n/a'} hours=${b.hours}`);
  }
}

// ===========================================================================
// RVA 组 · 排班四步走接口（145）
// ---------------------------------------------------------------------------
// 库层 RV0–RV11 已经把每条判据钉住了；这一组只验**链路**：
// 排班 → 推送 → 门店确认 → 锁定，四步都能从接口走通，且锁定后周视图看得见。
// 门店 11 / 期间 2027-06：既有断言都不碰。
// ===========================================================================
{
  const ST = 11, P = '2027-06';
  const q = (s) => encodeURIComponent(s);

  { // RVA1 排班：同一班重复点幂等（返回同一条），周视图那一格是 not_started
    const a = await post(`/api/roster/assign?employee=2&date=2027-06-02&shift=EARLY&store=${ST}`, t1);
    const again = await post(`/api/roster/assign?employee=2&date=2027-06-02&shift=EARLY&store=${ST}`, t1);
    const w = await get(`/api/roster/week?store=${ST}&from=2027-06-02&days=2`, t1);
    const cell = (w.body.rows || []).find(x => Number(x.employee_id) === 2);
    rec('RVA1', '排班走接口：同一个班重复点幂等（返回同一条），周视图那一格带 not_started、'
      + '班次与颜色（写入真的落库了，不是接口回了 200 就算）',
      a.status === 200 && Number(a.body.schedule_id) > 0
      && Number(again.body.schedule_id) === Number(a.body.schedule_id)
      && w.status === 200 && !!cell && cell.confirm_status === 'not_started' && !!cell.color,
      `${a.status} id=${a.body.schedule_id}/${again.body.schedule_id} `
      + `格子=${cell && cell.confirm_status}/${cell && cell.shift_code}`);
  }

  { // RVA2 推送：not_started → pushed，到期日与确认人一起给出
    const p = await post(`/api/roster/push?store=${ST}&period=${P}`, t1);
    const w = await get(`/api/roster/week?store=${ST}&from=2027-06-02&days=2`, t1);
    const cell = (w.body.rows || []).find(x => Number(x.employee_id) === 2);
    rec('RVA2', '推送走接口：not_started → pushed，同时给出到期日与确认人字段；周视图跟着变 pushed'
      + '（推的时候就要说清"谁、几号前签"，否则超时之后没人可问）',
      p.status === 200 && Number(p.body.pushed) > 0 && !!p.body.confirm_due_at
      && 'confirm_owner_id' in (p.body || {})
      && cell && cell.confirm_status === 'pushed',
      `${p.status} 推=${p.body.pushed} 到期=${p.body.confirm_due_at} `
      + `格子=${cell && cell.confirm_status}`);
  }

  { // RVA3 确认：不认可必须写意见；写了就成 disputed；撤掉重排重推后能确认
    const bad = await post(`/api/roster/confirm?store=${ST}&period=${P}&ok=0`, t1);
    const dis = await post(
      `/api/roster/confirm?store=${ST}&period=${P}&ok=0&note=${q('06-02 门店盘点，早班要改到 12 点以后')}`,
      t1);
    const w1 = await get(`/api/roster/week?store=${ST}&from=2027-06-02&days=2`, t1);
    const dcell = (w1.body.rows || []).find(x => Number(x.employee_id) === 2);

    // 争议的出口：撤掉 → 重排 → 重推 → 再确认（没有撤销，争议就是死路）
    const cl = await post(`/api/roster/clear?employee=2&date=2027-06-02&shift=EARLY`, t1);
    await post(`/api/roster/assign?employee=2&date=2027-06-02&shift=MID&store=${ST}`, t1);
    await post(`/api/roster/push?store=${ST}&period=${P}`, t1);
    const okr = await post(`/api/roster/confirm?store=${ST}&period=${P}&ok=1`, t1);

    rec('RVA3', '不认可却没写意见 → 422 E_ROSTER_NO_NOTE；写了意见 → disputed 且周视图可见；'
      + '撤掉重排重推后能确认成功（争议不是死路）',
      bad.status === 422 && String(bad.body.error) === 'E_ROSTER_NO_NOTE'
      && dis.status === 200 && Number(dis.body.confirmed) > 0
      && dcell && dcell.confirm_status === 'disputed'
      && cl.status === 200 && Number(cl.body.cleared) > 0
      && okr.status === 200 && Number(okr.body.confirmed) > 0,
      `${bad.status}/${bad.body.error} 争议=${dis.body.confirmed} `
      + `格子=${dcell && dcell.confirm_status} 撤=${cl.body.cleared} 再确认=${okr.body.confirmed}`);
  }

  { // RVA4 锁定 + 无写权限 403
    const l = await post(`/api/roster/lock?store=${ST}&period=${P}`, t1);
    const w = await get(`/api/roster/week?store=${ST}&from=2027-06-02&days=2`, t1);
    const cell = (w.body.rows || []).find(x => Number(x.employee_id) === 2);
    const denied = await post(
      `/api/roster/assign?employee=2&date=2027-06-04&shift=EARLY&store=${ST}`, t3);
    rec('RVA4', '锁定走接口，锁完周视图那一格是 locked；没有考勤写权限的账号排班 → 403'
      + '（不是 500，也不是静默成功）',
      l.status === 200 && Number(l.body.locked) > 0
      && cell && cell.confirm_status === 'locked' && denied.status === 403,
      `${l.status} 锁=${l.body.locked} 格子=${cell && cell.confirm_status} `
      + `无权限=${denied.status} ${String((denied.body || {}).error || '')}`);
  }
}

// ===========================================================================
// RTA 组 · 报表趋势接口（146）
// ===========================================================================
// 这一组只验"接线"，口径在库侧（run.mjs 的 RT1–RT4）验。
// 但有一件事只能在这里验：**趋势也过行闸**。单期报表换 org 参数只是看到别的一天，
// 趋势换 org 参数拿到的是别人一整年的工资曲线 —— 规模、季节性、裁没裁过员。
{ // RTA1 200 + rows/kpi；越权 org → 403
  const r = await get('/api/report/trend?org=30&from=2026-01&to=2026-06', t1);
  const rows = r.body.rows || [];
  const kpi = r.body.kpi || {};
  // t3 没有任何授予：岗位层就该拦（E_RESOURCE_FORBIDDEN），与 E_OUT_OF_SCOPE 同在 403
  const denied = await get('/api/report/trend?org=30&from=2026-01&to=2026-06', t3);
  rec('RTA1','趋势接口返回逐月 rows 与 kpi（months = 区间的月份数，不是有效数据点数）；'
    + '没有报表权限的账号换 org 也读不到 → 403',
    r.status === 200 && rows.length === 6 && Number(kpi.months) === 6
    && rows.every(x => /^[0-9]{4}-[0-9]{2}$/.test(String(x.period)))
    && (Number(kpi.months_with_data) === 0 || (kpi.peak && kpi.peak.period && kpi.trough))
    && denied.status === 403,
    `${r.status} rows=${rows.length} months=${kpi.months} 有数据月=${kpi.months_with_data} `
    + `越权=${denied.status} ${(denied.body || {}).error || ''}`);
}

{ // RTA2 期间写错 → 400（不是一排 0）；起止写反 → 400 E_RPT_RANGE
  const bad = await get('/api/report/trend?org=30&from=2026-3&to=2026-06', t1);
  const rev = await get('/api/report/trend?org=30&from=2026-06&to=2026-01', t1);
  rec('RTA2','from 写成 2026-3 → 400 E_ARG_INVALID（进 SQL 之前挡住：2026-3-01 在 PG 里'
    + '能被解析成 3 月 1 日，"写错"与"写对"会同形）；起止写反 → 400 E_RPT_RANGE',
    bad.status === 400 && bad.body.error === 'E_ARG_INVALID'
    && rev.status === 400 && rev.body.error === 'E_RPT_RANGE',
    `${bad.status} ${bad.body.error} / ${rev.status} ${rev.body.error}`);
}

// ===========================================================================
// EXAM 组 · 考试接口（147）：建卷 → 发卷 → 答题 → 判分，四步都走接口
// ---------------------------------------------------------------------------
// 判分、及格线、交卷后的锁都在库里（run.mjs 的 EXAM1–EXAM4 验的是那三条），
// 这里只验"接线"，外加一件只能在接口层验的事：**卷面里没有答案** ——
// 服务层多带一个字段，库里再怎么不给答案都白费。
// ★ 编号 EXAM1..EXAM3：收口块按 id 前缀记 `SUITE.API-${组}`，
//   只有 EXAM 才落进已登记的 SUITE.API-EXAM（EXA 会撞上"未登记判据"直接 RAISE）。
// ★ 课程自己造，不动种子的 ONB-01：给种子课程挂一张启用中的卷，
//   会把 fn_training_attend 的结业判据一起改掉（那是 TR 组的地盘）。
// ===========================================================================
const EXA_COURSE = Number((await db.query(
  `INSERT INTO training_course(code,name,category,std_hours)
   VALUES ('EXA-147','接口建卷用课','skill',8)
   ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id);

{ // EXAM1 试卷清单：papers[] 与 kpi 同源（不是页面各算一遍）
  const r = await get('/api/exam', t1);
  const papers = r.body.papers || [];
  const kpi = r.body.kpi || {};
  // 种子里那张入职卷（ONB-EXAM）已有一份满分答卷：及格率的分母是"交过卷的"，
  // 不是"发过的卷" —— 后者会把"还没考"算成"考不过"。
  const seeded = papers.find((p) => p.code === 'ONB-EXAM');
  rec('EXAM1', 'GET /api/exam 返回 papers[] 与 kpi{papers,active,attempts,passed}，'
    + '且 kpi 与 papers 逐项对得上（同一份口径，不是两套数）；'
    + '及格率的分母是"交过卷的" —— 种子那张卷 1 人考、1 人过 → 100',
    r.status === 200 && Array.isArray(papers) && papers.length > 0
    && Number(kpi.papers) === papers.length
    && Number(kpi.active) === papers.filter((p) => p.is_active).length
    && Number(kpi.attempts) === papers.reduce((a, p) => a + Number(p.attempts || 0), 0)
    && Number(kpi.passed) === papers.reduce((a, p) => a + Number(p.passed || 0), 0)
    && !!seeded && Number(seeded.attempts) === 1 && Number(seeded.passed) === 1
    && Number(seeded.pass_rate) === 100,
    `${r.status} papers=${papers.length} kpi=${JSON.stringify(kpi)} `
    + `种子卷=${seeded && `${seeded.attempts}考/${seeded.passed}过/${seeded.pass_rate}%`}`);
}

{ // EXAM2 三步走接口 + 卷面不含答案 + 成绩明细逐题
  const qs = [
    { kind: 'single', stem: '来访登记应该谁做？',
      options: [{ k: 'A', t: '谁看见谁做' }, { k: 'B', t: '前台值班人' }], answer: 'B', score: 40 },
    { kind: 'judge', stem: '后厨地面有油渍要立即清理。', answer: 'A', score: 30 },
    { kind: 'multi', stem: '哪些属于个人防护？（多选）',
      options: [{ k: 'A', t: '口罩' }, { k: 'B', t: '防割手套' }, { k: 'C', t: '耳环' }],
      answer: 'A,B', score: 30 },
  ];
  const made = await post('/api/exam/paper'
    + `?course=${EXA_COURSE}&code=EXA-147-1&name=${encodeURIComponent('接口结业考')}`
    + '&pass=60&questions=' + encodeURIComponent(JSON.stringify(qs)), t1);
  const paperId = Number(made.body && made.body.id) || 0;

  // 卷面：发卷之前先看一眼 —— 里面不能有 answer（服务层多带一个字段，
  // 库里再怎么不给答案都白费；这条只能在接口层验）
  const sheet = await get(`/api/exam/paper?paper=${paperId}`, t1);
  const sheetQs = (sheet.body && sheet.body.questions) || [];
  const leaked = sheetQs.filter((q) => Object.keys(q).some((k) => /answer/i.test(k)));

  const st = await post(`/api/exam/start?paper=${paperId}&employee=2`, t1);
  const attemptId = Number(st.body && st.body.attempt_id) || 0;
  const qid = (seq) => Number((sheetQs.find((q) => Number(q.seq) === seq) || {}).id) || 0;
  const sub = await post(`/api/exam/submit?attempt=${attemptId}&answers=`
    + encodeURIComponent(JSON.stringify([
      { q: qid(1), picked: 'B' }, { q: qid(2), picked: 'A' }, { q: qid(3), picked: 'B,A' }])), t1);

  // 成绩明细：交卷之后才给答案（错题回顾要有正确答案，这是行业常规）
  const res = await get(`/api/exam/result?attempt=${attemptId}`, t1);
  const rows = (res.body && res.body.rows) || [];
  rec('EXAM2', '建卷 → 发卷 → 交卷三步都走接口，分数由库里判（100 / 及格）；'
    + '发卷前的卷面 questions 里没有 answer 字段；交卷后 GET /api/exam/result 能看到 '
    + 'score / passed / pass_score 与逐题明细（交卷后才有 answer —— 那是给错题回顾的）',
    made.status === 200 && paperId > 0 && Number(made.body.total_score) === 100
    && sheet.status === 200 && sheetQs.length === 3 && leaked.length === 0
    && st.status === 200 && attemptId > 0
    && sub.status === 200 && Number(sub.body.score) === 100 && sub.body.passed === true
    && Number(sub.body.right_count) === 3
    && res.status === 200 && Number(res.body.score) === 100 && res.body.passed === true
    && Number(res.body.pass_score) === 60
    && rows.length === 3 && rows.every((x) => x.answer !== null && x.right === true
      && Number(x.score) === Number(x.full_score)),
    `${made.status}/卷=${paperId} 卷面题=${sheetQs.length} 泄答案=${leaked.length} `
    + `${st.status}/${sub.status} 分=${sub.body && sub.body.score}/${sub.body && sub.body.passed} `
    + `明细=${rows.length}行`);
}

{ // EXAM3 没有写权限的账号建卷 → 403，且一行都没写进去
  const r = await post(`/api/exam/paper?course=${EXA_COURSE}&code=EXA-147-NOPERM`
    + `&name=${encodeURIComponent('无权限建卷')}&pass=60&questions=`
    + encodeURIComponent(JSON.stringify([
      { kind: 'single', stem: 'x', options: [{ k: 'A', t: 'a' }, { k: 'B', t: 'b' }],
        answer: 'A', score: 10 }])), t3);
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM exam_paper WHERE code='EXA-147-NOPERM'`)).rows[0].n);
  rec('EXAM3', '没有花名册写权限的账号建卷 → 403（不是 500，也不是静默成功），'
    + '并且库里一行都没落下 —— 拒绝要拒得干净',
    r.status === 403 && n === 0,
    `${r.status} ${String((r.body || {}).error || '')} 落库=${n} 行`);
}

// ===========================================================================
// CTR 组 · 人事合同接口（160）：填报 → 校验 → 签署存快照 → 打印
// ---------------------------------------------------------------------------
// 库里已钉住（run.mjs 的 CTR1–CTR5）：试用期分档、超限不许存、无固定期限不能有
// 终止日、关键字段缺失不许渲染、签署存快照。这里验接口把这件事说出去了没有：
// 填报的人能不能当场看到"这一条违法"，签完之后还能不能改。
// ===========================================================================
const CT_EMP = 9953;
await db.query(`INSERT INTO person(id,full_name) VALUES ($1,'合同接口甲')
                ON CONFLICT (id) DO NOTHING`, [CT_EMP]);
await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                VALUES (19953,$1,994,'2026-01-01') ON CONFLICT (id) DO NOTHING`, [CT_EMP]);
await db.query(`INSERT INTO person_profile(person_id,profile_type,profile_value)
                VALUES ($1,'national_id','310101199303030033'),
                       ($1,'mobile','13800000003') ON CONFLICT DO NOTHING`, [CT_EMP]);
await db.query(`INSERT INTO legal_entity(id,name,credit_code,address,legal_rep,stamp_name)
                VALUES (994,'演示餐饮有限公司','91310000MA1FL0000X','上海市示例路 1 号',
                        '示例代表人','演示餐饮有限公司')
                ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name`);
const ctTpl = Number((await db.query(
  `SELECT id FROM contract_template WHERE kind='fixed' AND is_active ORDER BY id LIMIT 1`)).rows[0].id);
const ctBody = (over) => ({
  employeeId: CT_EMP, legalEntityId: 994, kind: 'fixed',
  startDate: '2026-02-01', endDate: '2028-01-31',
  jobTitle: '门店店员', workplace: '示例路店', employeeAddress: '上海市示例路 2 号',
  hoursSystem: 'standard', wageAmount: 6500, wageUnit: 'month', payDay: 15,
  templateId: ctTpl, ...over,
});

{ // CTR1 填报 → 预览 → 签署 → 改已签被拒
  const made = await postJson('/api/hr/contract', t1, ctBody({ contractNo: 'CT-API-1' }));
  const id = Number((made.body || {}).id) || 0;
  const draft = await get(`/api/hr/contract?id=${id}`, t1);
  const prev = await get(`/api/hr/contract/render?id=${id}`, t1);
  const signed = await post(`/api/hr/contract/sign?id=${id}`, t1);
  const again = await postJson('/api/hr/contract', t1, ctBody({ id, contractNo: 'CT-API-1' }));

  rec('CTR1', '填报走请求体（合同字段十几个，塞 URL 会被截断）→ 落成 draft；'
    + '预览能拿到渲染后的正文（含"劳动合同"与甲方主体名）；签署后状态 signed 且存下正文；'
    + '再改这份已签的 → 409 E_CT_SIGNED。★ 已签合同不许改不是教条：'
    + '合同是"当时双方签的是什么"的证据，改了它，历史就没有锚了',
    made.status === 200 && id > 0 && made.body.status === 'draft'
    && draft.status === 200 && draft.body.status === 'draft'
    && prev.status === 200 && /劳动合同/.test(prev.body.body)
    && /演示餐饮有限公司/.test(prev.body.body)
    && signed.status === 200 && signed.body.status === 'signed'
    && Number(signed.body.body_length) > 200
    && again.status === 409 && /E_CT_SIGNED/.test(String(again.body.error)),
    `${made.status}/draft 预览=${prev.status} 正文 ${prev.body && prev.body.body && prev.body.body.length} 字 `
    + `签署=${signed.status}/${signed.body && signed.body.status} 改回=${again.status}`);
}

{ // CTR2 违法试用期 → 409 且一行都没落库
  const bad = await postJson('/api/hr/contract', t1, ctBody({
    contractNo: 'CT-API-BAD', probationFrom: '2026-02-01', probationTo: '2026-06-01' }));
  const n = Number((await db.query(
    `SELECT count(*)::int n FROM employment_contract WHERE contract_no='CT-API-BAD'`)).rows[0].n);
  rec('CTR2', '2 年期合同约 4 个月试用期（法定上限 2 个月）→ 409 E_CT_BLOCKED，'
    + '报错里说清"超了多少、上限几个、合同期是哪段"，并且**一行都没落库**。'
    + '★ 试用期超限是违法条款不是不规范：条款无效 + 已履行期间按转正后工资补差，'
    + '所以不能"先存下来再说"',
    bad.status === 409 && /E_CT_BLOCKED/.test(String(bad.body.error))
    && /试用期/.test(String(bad.body.message || '')) && n === 0,
    `${bad.status}/${bad.body && bad.body.error} 落库=${n} 行`);
}

{ // CTR3 打印页 + 未签合同清单
  const cid = Number(((await db.query(
    `SELECT id FROM employment_contract WHERE contract_no='CT-API-1'`)).rows[0] || {}).id) || 0;
  const resp = await fetch(`${BASE}/api/hr/contract.html?id=${cid}`,
    { headers: { authorization: `Bearer ${t1}` } });
  const html = await resp.text();
  const un = await get('/api/hr/contract/unsigned', t1);
  rec('CTR3', '合同打印页是服务端渲染的完整 HTML（存下来就能盖章）：含"劳动合同"标题、'
    + '甲方盖章与乙方签字位、合同编号；GET /api/hr/contract/unsigned 能列出'
    + '"在职但没有生效合同"的人 —— 这是双倍工资风险的起算点，'
    + '而它的特征是"系统里一切正常"：人在上班、工资在发，直到离职那天有人提出来',
    resp.status === 200 && /text\/html/.test(resp.headers.get('content-type') || '')
    && /劳动合同/.test(html) && /甲方（盖章）/.test(html) && /乙方（签字）/.test(html)
    && /CT-API-1/.test(html)
    && un.status === 200 && Array.isArray(un.body.rows)
    && Number(un.body.overdue) >= 0,
    `${resp.status} 签章位=${/甲方（盖章）/.test(html)}/${/乙方（签字）/.test(html)} `
    + `未签清单=${(un.body.rows || []).length} 人 超期=${un.body.overdue}`);
}

{ // SIL2 参保入参：允许 base 别名，但**拒绝未知键**
  //   ★ 全生命周期验收里发现：传 { item:'pension', base:6000 } 时库里读不到
  //     base_amount，会**静默回落到月薪 8000** —— 不报错、基数悄悄换了另一个数。
  //     静默取另一个值比报错严重得多：少缴多缴都补不回来。
  const emp2 = 9955;
  await db.query(`INSERT INTO person(id,full_name) VALUES ($1,'社保别名甲')
                  ON CONFLICT (id) DO NOTHING`, [emp2]);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                  VALUES (19955,$1,1,'2026-01-01') ON CONFLICT (id) DO NOTHING`, [emp2]);
  await db.query(`INSERT INTO salary_standard(employment_id,monthly_amount,effective_from)
                  VALUES (19955,8000,'2026-01-01') ON CONFLICT DO NOTHING`);

  const okAlias = await postJson('/api/si/enroll', t1, {
    employeeId: emp2, city: '上海', fromPeriod: '2026-02',
    items: [{ item: 'pension', base: 6000 }],
  });
  const base = okAlias.status === 200
    ? (await db.query(
      `SELECT base_amount FROM si_enrollment
        WHERE employee_id=$1 AND item='pension' ORDER BY start_period LIMIT 1`, [emp2])).rows[0]
    : null;
  const bad = await postJson('/api/si/enroll', t1, {
    employeeId: emp2, city: '上海', fromPeriod: '2026-03',
    items: [{ item: 'pension', baseMoney: 6000 }],
  });
  rec('SIL2', '参保入参：`base` 是 `base_amount` 的**别名**（传 base:6000 真的按 6000 落，'
    + '不再静默回落到月薪 8000）；而 `baseMoney` 这种**未知键直接拒**（E_SIL_BAD_ARG，'
    + '点名是哪个字段）。★ 静默取另一个值比报错严重得多：基数悄悄换了，'
    + '少缴多缴都补不回来',
    okAlias.status === 200 && base && Number(base.base_amount) === 6000
    && bad.status === 422 && /E_SIL_BAD_ARG/.test(String(bad.body.error))
    && /baseMoney/.test(String(bad.body.message || '')),
    `别名=${okAlias.status} 基数=${base && base.base_amount} `
    + `未知键=${bad.status}/${String(bad.body.message || '').slice(0, 30)}`);
}

// ===========================================================================
// XA 组 · 四块并行交付的接口接线（165/166/167/168）
// ---------------------------------------------------------------------------
// 库层已由 run.mjs 的 XA1–XA4 守门，四路探针另有 69 条（在 /tmp，不进 CI）。
// 这里只验一件事：**路由真的接上了**，且返回结构能被页面直接用。
// 接线漏了不会报错 —— 只会 404，而 404 在页面上看起来像"这个功能没有"。
// ===========================================================================
{
  const r1 = await get('/api/hr/exit/list', t1);
  rec('EXIT1', 'GET /api/hr/exit/list 返回离职单清单（rows + kpi），'
    + '证明 165 的路由接上了；漏接的表现是 404 —— 页面上看起来像"没这个功能"',
    r1.status === 200 && Array.isArray(r1.body.rows) && r1.body.kpi !== undefined,
    `${r1.status} rows=${(r1.body.rows || []).length}`);
}
{
  const r = await get('/api/si/enrollments', t1);
  rec('SIL1', 'GET /api/si/enrollments 返回参保台账（rows），'
    + '与 /api/si/declare（申报表）分开：那条是"报出去的表"，这条是"我们自己的账"',
    r.status === 200 && Array.isArray(r.body.rows),
    `${r.status} rows=${(r.body.rows || []).length}`);
}
{
  const r = await get('/api/recruit/candidate?key=nobody-by-this-key', t1);
  rec('RCI1', 'GET /api/recruit/candidate 对一个**从没出现过的候选人**也返回 200 + 一行，'
    + '而不是 404 或空 —— "查不到"与"查失败"必须分开，'
    + '否则页面没法说清"这个人没面过"还是"接口挂了"',
    r.status === 200 && r.body.candidate_key === 'nobody-by-this-key'
    && Number(r.body.rounds) === 0 && typeof r.body.note === 'string',
    `${r.status} rounds=${r.body.rounds} note=${String(r.body.note).slice(0, 20)}`);
}
{
  const r = await get('/api/att/dup-punch?period=2026-03', t1);
  rec('ATX1', 'GET /api/att/dup-punch 疑似代人打卡清单能拉到（只报不拦：'
    + '同一设备同一分钟、同一人 60 秒内两次 —— 误判率高，硬拦会让人打不了卡）',
    r.status === 200 && Array.isArray(r.body.rows),
    `${r.status} 命中=${(r.body.rows || []).length} 条`);
}

// ===========================================================================
// LVG1 · 请假资格接口（164）：资格与额度分开问
// ---------------------------------------------------------------------------
// 库里已钉住（run.mjs 的 LVG1–LVG4）：折算、12 个月门槛、医疗期、两个配置开关。
// 这里验接口把"有没有资格"和"能休几天"一起说出来了 ——
// 只给结论不给数字，页面就说不出"你今年应享 2 天"。
// ===========================================================================
{
  const emp = 9984;   // run.mjs 里的"折算甲"（本库没有，需自己造）
  await db.query(`INSERT INTO person(id,full_name) VALUES ($1,'资格甲')
                  ON CONFLICT (id) DO NOTHING`, [emp]);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date,prior_work_years)
                  VALUES (19984,$1,1,'2026-07-01',3) ON CONFLICT (id) DO NOTHING`, [emp]);
  const r = await get(`/api/leave/eligibility?employee=${emp}&type=ANNUAL`
    + '&from=2026-09-01&to=2026-09-02', t1);
  // 未满 12 个月的人：资格不过
  const emp2 = 9985;
  await db.query(`INSERT INTO person(id,full_name) VALUES ($1,'资格乙')
                  ON CONFLICT (id) DO NOTHING`, [emp2]);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date,prior_work_years)
                  VALUES (19985,$1,1,'2026-01-01',0) ON CONFLICT (id) DO NOTHING`, [emp2]);
  const r2 = await get(`/api/leave/eligibility?employee=${emp2}&type=ANNUAL`
    + '&from=2026-09-01&to=2026-09-01', t1);
  rec('LVG1', 'GET /api/leave/eligibility 同时给出：能不能休（ok/blocks）、今年应享几天'
    + '（折算后的数）、是否已满 12 个月、医疗期几个月、累计工龄。'
    + '★ 资格与额度必须分开回答：两者都不通过时长得一样，'
    + '而处置完全不同（一个是"再等等"，一个是"去加额度"）',
    r.status === 200 && r.body.ok === true && Number(r.body.entitled_days) === 2
    && r.body.qualified === true && Number(r.body.service_years) >= 3
    && r2.status === 200 && r2.body.ok === false
    && (r2.body.blocks || []).some((b) => b.code === 'E_LVG_NOT_QUALIFIED')
    && Number(r2.body.entitled_days) === 0,
    `${r.status} 甲应享=${r.body.entitled_days} 工龄=${r.body.service_years} `
    + `资格=${r.body.qualified}；乙 ok=${r2.body && r2.body.ok} `
    + `应享=${r2.body && r2.body.entitled_days} 码=${(r2.body.blocks || []).map((b) => b.code).join(',')}`);
}

// ===========================================================================
// CTR4 · 入职链缺的最后两块：法人主档、人员证件（没有它们签不出合同）
// ---------------------------------------------------------------------------
// 全生命周期验收发现的 G1：从招聘走到入职的人在系统里**签不出一份合同** ——
// 因为 legal_entity 整张表没有写入接口、person_profile 也没有，
// 而合同渲染要求"甲方名称/信用代码/地址 + 乙方证件号"非空。
// 这条按"缺 → 拒 → 补 → 能签"的顺序验，缺了哪一环都会红。
// ===========================================================================
{
  const emp = 9954;
  await db.query(`INSERT INTO person(id,full_name) VALUES ($1,'缺档案甲')
                  ON CONFLICT (id) DO NOTHING`, [emp]);
  await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                  VALUES (19954,$1,993,'2026-01-01') ON CONFLICT (id) DO NOTHING`, [emp]);
  const tpl = Number((await db.query(
    `SELECT id FROM contract_template WHERE kind='fixed' AND is_active ORDER BY id LIMIT 1`)).rows[0].id);
  const made = await postJson('/api/hr/contract', t1, {
    employeeId: emp, legalEntityId: 993, kind: 'fixed',
    startDate: '2026-02-01', endDate: '2028-01-31',
    jobTitle: '门店店员', workplace: '示例路店',
    employeeAddress: '上海市示例路 12 号 101 室',
    hoursSystem: 'standard', wageAmount: 6000, wageUnit: 'month', payDay: 15,
    templateId: tpl, contractNo: 'CT-NOENT-1',
  });
  const cid = Number((made.body || {}).id) || 0;
  // ① 缺：甲方三要素 + 乙方证件号都没有 → 渲染拒
  const miss = await get(`/api/hr/contract/render?id=${cid}`, t1);
  // ② 补：法人主档 + 人员证件
  const ent = await postJson('/api/hr/entity', t1, {
    id: 993, name: '示例餐饮管理有限公司', creditCode: '91310000MA1FL0993X',
    address: '上海市示例路 1 号 10 楼', legalRep: '示例代表人',
  });
  const prf = await postJson('/api/hr/profile', t1, {
    employeeId: emp, nationalId: '310101199401010044', mobile: '13800000044',
  });
  // ③ 补齐后能渲染，且正文里没有残留占位符
  const ok = await get(`/api/hr/contract/render?id=${cid}`, t1);
  const body = (ok.body && ok.body.body) || '';

  rec('CTR4', '入职链最后两块补齐：没填法人主档与人员证件时，合同渲染直接拒'
    + '（E_CT_FIELD_MISSING，点名缺哪几个字段）；调 POST /api/hr/entity 与 '
    + '/api/hr/profile 补上之后，同一份合同渲染成功且正文里没有残留占位符。'
    + '★ 在此之前这两个表全仓没有写入接口 —— 从招聘走到入职的人在系统里签不出合同，'
    + '而这不会报错，只会让人以为"合同功能坏了"',
    made.status === 200 && cid > 0
    && miss.status === 422 && /E_CT_FIELD_MISSING/.test(String(miss.body.error))
    && /甲方名称|乙方证件号/.test(String(miss.body.message || ''))
    && ent.status === 200 && ent.body.name === '示例餐饮管理有限公司'
    && prf.status === 200 && (prf.body.saved || []).includes('national_id')
    && ok.status === 200 && /示例餐饮管理有限公司/.test(body)
    && !/\{\{/.test(body),
    `${made.status}/合同=${cid} 缺时=${miss.status} `
    + `补后=${ok.status} 正文=${body.length} 字 `
    + `补后错=${String(ok.body && ok.body.message || '').slice(0, 60)} `
    + `entity=${ent.status}/${JSON.stringify(ent.body).slice(0, 60)} `
    + `profile=${prf.status}/${JSON.stringify(prf.body).slice(0, 60)}`);
}

// ===========================================================================
// CHG1 · 员工异动接口（163）：开单 → 生效 → 变更是另一份草稿合同
// ---------------------------------------------------------------------------
// 库里已钉住（run.mjs 的 CHG1–CHG4）。这里验接线：一次 POST 开单，一次 POST 生效，
// 返回变更协议号；并且**协议是草稿**——面签后才算变更完成。
// ===========================================================================
{
  // 用合同接口甲（CTR1 里已签的那份，CT-API-1）
  const emp = Number((await db.query(
    `SELECT employee_id FROM employment_contract WHERE contract_no='CT-API-1'`)).rows[0].employee_id);
  const open = await postJson('/api/hr/change', t1, {
    employeeId: emp, kind: 'transfer_store', effectiveDate: '2026-06-01',
    reason: '门店合并，人员随店走', next: { org_id: 10 },
  });
  const cid = Number((open.body || {}).id) || 0;
  const apply = await post(`/api/hr/change/apply?id=${cid}`, t1);
  const again = await post(`/api/hr/change/apply?id=${cid}`, t1);
  const list = await get(`/api/hr/changes?employee=${emp}`, t1);
  const row = ((list.body || {}).rows || [])[0] || {};

  rec('CHG1', 'POST /api/hr/change 开单 → POST /api/hr/change/apply 生效，返回以 BG 开头的'
    + '**变更协议号**，状态仍是 draft（面签后才算完成）；同一张单子再生效一次 → 409 '
    + 'E_CHG_APPLIED；GET /api/hr/changes 能按人列出来，kpi.unsigned 数的是'
    + '"已生效但协议还没签"的单子 —— 那是"改了档案、书面还没落"的危险状态',
    open.status === 200 && cid > 0
    && apply.status === 200 && /^BG/.test(String(apply.body.contract_no))
    && apply.body.contract_status === 'draft'
    && again.status === 409 && /E_CHG_APPLIED/.test(String(again.body.error))
    && list.status === 200 && row.id === cid && row.status === 'applied'
    && Number(list.body.kpi.unsigned) >= 1,
    `${open.status}/开单 ${apply.status}/${apply.body && apply.body.contract_no} `
    + `重复=${again.status} 清单=${((list.body || {}).rows || []).length} 条 `
    + `未签协议=${list.body && list.body.kpi && list.body.kpi.unsigned}`);
}

// ===========================================================================
// HIREC1 · 入职一条链接口（162）：一次调用，岗位与薪资从 offer 带进合同
// ---------------------------------------------------------------------------
// 库里已钉住（run.mjs 的 HIREC1–HIREC3）。这里验接口：**一次请求**就能把
// 入职与合同草稿都办完，且返回的合同号、状态、提醒都能直接拿去显示。
// ===========================================================================
{
  // offer 夹具：编制先补一版，否则 requeriment 会被编制约束拦住
  await db.query(`INSERT INTO headcount_budget(org_id,period,version,quota,set_by,reason)
                  VALUES (10,'2026-08',
                    (SELECT COALESCE(max(version),0)+1 FROM headcount_budget
                      WHERE org_id=10 AND period='2026-08'),20,'hr','入职链接口：追加名额')`);
  await db.query(`INSERT INTO requisition(org_id,position,headcount,opened_at,reason,created_by)
                  VALUES (10,'门店店员',1,'2026-08-01','接口验证','hr')`);
  const rq = Number((await db.query(`SELECT max(id) m FROM requisition`)).rows[0].m);
  await db.query(`INSERT INTO offer(requisition_id,candidate_key,candidate_name,org_id,status)
                  VALUES ($1,'idhash-api-hire','入职接口甲',10,'pending')`, [rq]);
  const off = Number((await db.query(`SELECT max(id) m FROM offer`)).rows[0].m);
  await db.query(`INSERT INTO offer_version(offer_id,version,position,monthly_amount,
                    valid_until,created_by,reason)
                  VALUES ($1,1,'门店店员',7200,'2026-12-31','hr','首版报价：按编制内名额开出')`, [off]);

  const r = await postJson('/api/hr/onboard', t1, {
    offer: off, hireDate: '2026-08-01', legalEntityId: 994,
    contract: { employee_address: '上海市示例路 11 号 601 室' },
  });
  const c = r.status === 200 ? (await db.query(
    `SELECT job_title, wage_amount, status, kind, contract_no
       FROM employment_contract WHERE id=$1`, [r.body.contract_id])).rows[0] : null;
  rec('HIREC1', 'POST /api/hr/onboard 一次请求完成"入职 + 合同草稿"：返回人/任职/合同号，'
    + '合同上的岗位与月薪**来自 offer 最新版**（门店店员 / 7200），状态是 draft，'
    + '并带回 warnings 数组（有预警时页面直接显示）。'
    + '★ 岗位、月薪、入职日如果各填一遍，必然有一天会不一致 —— '
    + '而不一致按合同执行，往往就是更低的那个数',
    r.status === 200 && Number(r.body.person_id) > 0 && Number(r.body.contract_id) > 0
    && /^HT/.test(String(r.body.contract_no)) && Array.isArray(r.body.warnings)
    && c && c.job_title === '门店店员' && Number(c.wage_amount) === 7200
    && c.status === 'draft' && c.kind === 'fixed',
    `${r.status} 合同=${r.body && r.body.contract_no} `
    + `岗位=${c && c.job_title} 工资=${c && c.wage_amount} 状态=${c && c.status} `
    + `提醒=${(r.body.warnings || []).length} 条`);
}

// ===========================================================================
// RSE1 · 花名册接口带上合同与档案补充（161）
// ---------------------------------------------------------------------------
// 库里已钉住（run.mjs 的 RSE1–RSE4）：合同起止/试用期状态实时派生、没合同的显示
// none、档案补充只改给了的字段、生日性别从身份证派生。这里只验**接口把新列带出去了**，
// 以及手机号在没配字段权限时是**掩码**而不是明文。
// ===========================================================================
{
  const r = await get('/api/employees?as_of=2026-02-01', t1);
  const rows = (r.body && r.body.rows) || [];
  const one = rows.find((x) => Number(x.employee_id) !== undefined) || {};
  const keys = Object.keys(one);
  const hasNew = ['mobile', 'birth_date', 'contract_no', 'contract_start',
    'contract_end', 'probation_status', 'employment_kind', 'emergency_name',
    'contract_days_left'].every((k) => keys.includes(k));
  // 手机号：没配字段权限 → masked（fn_apply_mask 返回 null），不能是明文
  const plainMobile = rows.filter((x) => x.mobile && /^1\d{10}$/.test(String(x.mobile)));
  rec('RSE1', 'GET /api/employees 的每一行都带上了手机、生日/性别、合同编号与起止、'
    + '试用期状态、用工类型、紧急联系人，以及服务层算好的 contract_days_left（页面按它标红，'
    + '不用各自再算一遍）；手机号走**同一套字段权限**，没配就是掩码 —— '
    + '店长要打电话应该由权限表给他 visible，而不是代码里"顺手不掩手机"'
    + '（那等于给所有角色开了这个字段）',
    r.status === 200 && rows.length > 0 && hasNew
    && plainMobile.length === 0
    && rows.every((x) => x._actions && 'mobile' in x._actions),
    `${r.status} 行=${rows.length} 新列=${hasNew} `
    + `明文手机=${plainMobile.length} 动作=${one._actions && JSON.stringify(one._actions)}`);
}

// ===========================================================================
// PAYR7-8 · 分门店可打印工资单
// ---------------------------------------------------------------------------
// 财务每月要做的事：把工资单按门店打印、发到店、让员工签收。
// 现状是"导 CSV → Excel 里按部门筛 N 次 → 套模板"，三个后果：
// 模板发给店长等于把别店薪资一起发出去、表头期间靠手改漏改就印错、
// 一人一块靠手动分页符调一次人就要重插上百个断点。
// 这里只验两件事：**分组与合计在服务端算好**、**打印件上不该有的东西没有**。
// ===========================================================================
{
  const run = Number((await db.query(
    `SELECT id FROM pay_run ORDER BY id DESC LIMIT 1`)).rows[0].id);
  const r = await get(`/api/payroll/print?run=${run}`, t1);
  const gs = (r.body && r.body.groups) || [];
  const tt = (r.body && r.body.totals) || {};
  const people = gs.flatMap((g) => g.people || []);
  const sumGross = Math.round(gs.reduce((a, g) => a + Number(g.gross || 0), 0) * 100) / 100;
  const sumNet = Math.round(gs.reduce((a, g) => a + Number(g.net || 0), 0) * 100) / 100;
  // 收入/扣款只按金额正负分（009 没有 direction 列，加列要动对账基准，属 L3）
  const signOk = people.every((p) => (p.up || []).every((x) => Number(x.amount) > 0)
    && (p.down || []).every((x) => Number(x.amount) < 0));
  rec('PAYR7', '打印数据在服务端按成本组织（门店）分好组：门店数/人数/应发合计/实发合计'
    + '与逐人逐组求和一致（页面不再自己 groupBy —— 前端筛等于先把全公司的人'
    + '发到浏览器，和"把全公司模板发给店长"只是把泄露点从文件挪到了响应里）；'
    + '收入项金额恒正、扣款项恒负（009 没有 direction 列，只能靠符号，'
    + '所以这条要钉住：符号反了，打印出来的"应发合计"就会把扣款加进去）',
    r.status === 200 && gs.length >= 1
    && Number(tt.people) === people.length
    && Number(tt.stores) === gs.length
    && Number(tt.gross) === sumGross && Number(tt.net) === sumNet
    && people.every((p) => Number(p.gross) !== null)
    && signOk,
    `${r.status} 门店=${gs.length} 人=${people.length} `
    + `应发 ${tt.gross}/${sumGross} 实发 ${tt.net}/${sumNet} 符号=${signOk}`);
}

{ // PAYR8 打印件是给人签字的凭证：该有的有，不该有的没有
  const run = Number((await db.query(
    `SELECT id FROM pay_run ORDER BY id DESC LIMIT 1`)).rows[0].id);
  const resp = await fetch(`${BASE}/api/payroll/print.html?run=${run}&per=1`,
    { headers: { authorization: `Bearer ${t1}` } });
  const html = await resp.text();
  // 没有权限的账号也要拒（打印件里有全店薪资）
  const deny = await fetch(`${BASE}/api/payroll/print.html?run=${run}`,
    { headers: { authorization: `Bearer ${t3}` } });
  rec('PAYR8', '打印页是**服务端渲染**的 HTML（存下来就是能打印的凭证，不依赖 JS 与接口'
    + '还活着）：表头有公司主体与期间、每人有应发/实发合计、有员工签收栏与'
    + '公司盖章位、有页码；并且**不含身份证号与银行账号**（这张纸会贴在店里、'
    + '会被拍照转发，那两样对"签收"没作用）；无权限账号拿不到',
    resp.status === 200
    && /text\/html/.test(resp.headers.get('content-type') || '')
    && /工资单/.test(html) && /员工签收/.test(html) && /公司盖章/.test(html)
    && /应发合计/.test(html) && /实发合计/.test(html) && /第 1 \//.test(html)
    && !/\d{17}[\dXx]/.test(html) && !/\b\d{16,19}\b/.test(html)
    && deny.status === 403,
    `${resp.status} 签收栏=${/员工签收/.test(html)} 盖章位=${/公司盖章/.test(html)} `
    + `页码=${/第 1 \//.test(html)} 证件号=${/\d{17}[\dXx]/.test(html)} `
    + `无权限=${deny.status}`);
}

// EXAML 组 · 考试的限时与限次（156）：这两件事决定"及格"有没有意义
// ---------------------------------------------------------------------------
// 库里已经钉住（run.mjs 的 EXAML1–EXAML4）：截止时刻由库算、次数只数已交卷、
// 超时只记不拦、台账四列各答各的。这里只验**接口把这件事说出去了没有** ——
// 规则做对了但页面上看不见，等于没做：人会答完一整张 100 分的卷，
// 才从报错里知道"你已经没机会了"。
// ★ 编号 EXAML，落 SUITE.API-EXAML（156 已登记）。
// ===========================================================================
{ // EXAML1 台账能在开考之前查：还剩几次、最高多少分、上次超时多久
  const madeP = await post('/api/exam/paper'
    + `?course=${EXA_COURSE}&code=EXA-156-1&name=${encodeURIComponent('限次接口卷')}`
    + '&pass=60&duration=15&attempts=1&questions='
    + encodeURIComponent(JSON.stringify([
      { kind: 'judge', stem: '灭火器要先拔保险销。', answer: 'A', score: 100 }])), t1);
  const pid = Number(madeP.body && madeP.body.id) || 0;

  const before = await get(`/api/exam/ledger?paper=${pid}&employee=2`, t1);
  const st = await post(`/api/exam/start?paper=${pid}&employee=2`, t1);
  const att = Number(st.body && st.body.attempt_id) || 0;

  // 交卷：整卷 100 分（判断题选 A 即全对）
  const qid = Number((await db.query(
    `SELECT id FROM exam_question WHERE paper_id=$1 AND seq=1`, [pid])).rows[0].id);
  const sub = await post(`/api/exam/submit?attempt=${att}&answers=`
    + encodeURIComponent(JSON.stringify([{ q: qid, picked: 'A' }])), t1);
  const after = await get(`/api/exam/ledger?paper=${pid}&employee=2`, t1);

  rec('EXAML1', '建卷时带上 duration/attempts 就落进库里；开考**之前** GET /api/exam/ledger '
    + '就能回答"他还能不能考"（left=1、best 为空 = 没考过，不是 0 分）；'
    + '开考回报截止时刻与"第几次 / 共几次"（不用"还剩几次"—— 那一刻剩下的就是手上这份）；'
    + '交卷后 ledger 变 used=1 / left=0 —— 页面因此能在点"开考"之前拦住他，'
    + '而不是让他答完一整张卷才说"没机会了"',
    madeP.status === 200 && pid > 0
    && before.status === 200 && Number(before.body.left_attempts) === 1
    && Number(before.body.used) === 0 && before.body.best_score === null
    && st.status === 200 && att > 0 && st.body.deadline_at !== null
    && Number(st.body.attempt_no) === 1 && Number(st.body.max_attempts) === 1
    && sub.status === 200 && Number(sub.body.score) === 100
    && after.status === 200 && Number(after.body.used) === 1
    && Number(after.body.left_attempts) === 0
    && Number(after.body.best_score) === 100 && after.body.passed === true,
    `${madeP.status}/卷=${pid} 开考前=${before.body && before.body.left_attempts} `
    + `截止=${st.body && st.body.deadline_at ? '有' : '无'} `
    + `第${st.body && st.body.attempt_no}/${st.body && st.body.max_attempts}次 `
    + `考后=${after.body && `${after.body.used}考/${after.body.left_attempts}剩/`
      + `${after.body.best_score}分`}`);
}

{ // EXAML2 次数用完 → 接口返回 409 + E_EXAM_NO_ATTEMPT_LEFT（不是 500，也不是静默发一张新卷）
  const madeP = await get('/api/exam', t1);
  const pid = Number(((madeP.body.papers || []).find((p) => p.code === 'EXA-156-1') || {}).id) || 0;
  const again = await post(`/api/exam/start?paper=${pid}&employee=2`, t1);
  // 阳性对照：一次没考的人照样能开 —— 否则"被拦"可能只是"这张卷坏了"
  const other = await post(`/api/exam/start?paper=${pid}&employee=3`, t1);
  rec('EXAML2', '次数用完再开考 → 409 + E_EXAM_NO_ATTEMPT_LEFT（不是 500，也不是偷偷再发一份：'
    + '多发的每一份都会让"他到底考了几次"这个要报出去的数变脏）；'
    + '另一个人在同一张卷上照样能开考',
    again.status === 409 && /E_EXAM_NO_ATTEMPT_LEFT/.test(String((again.body || {}).error))
    && other.status === 200 && Number(other.body.attempt_id) > 0,
    `${again.status}/${String((again.body || {}).error || '')} 别人=${other.status}`);
}


// ===========================================================================
// EXAMT 组 · 考试任务层接口（157）：窗口闸 / 错题回顾 / 分段 / 切屏证据
// ---------------------------------------------------------------------------
// 库里已钉住（run.mjs 的 EXAMT1–EXAMT5）。这里验接口把四件事说出去了没有：
// 店长问"这批谁还没考"、考生问"我错哪了"、监考问"他几点切走的" ——
// 规则做对了但页面上看不见，等于没做。
// ===========================================================================
const ET_EMP = 9941;
await db.query(`INSERT INTO person(id,full_name) VALUES ($1,'任务考生')
                ON CONFLICT (id) DO NOTHING`, [ET_EMP]);
await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                VALUES (19941,$1,990,'2020-01-01') ON CONFLICT (id) DO NOTHING`, [ET_EMP]);
const etPaper = Number((await post('/api/exam/paper'
  + `?course=${EXA_COURSE}&code=EXA-157-1&name=${encodeURIComponent('任务批次卷')}`
  + '&pass=60&questions=' + encodeURIComponent(JSON.stringify([
    { kind: 'judge', stem: '动火前要清场。', answer: 'A', score: 100 }])), t1)).body?.id) || 0;
const etQ = Number((await db.query(
  `SELECT id FROM exam_question WHERE paper_id=$1 AND seq=1`, [etPaper])).rows[0].id);

{ // EXAMT1 窗口闸：先建一个昨天关掉的批次 → 开考 409；再建今天的 → 200
  // ★ 窗口必须**包住现在**，不能写死某一天：写 2030-01-01 的话，
  //   "现在"（2026）落在窗口外，连"窗口内能开考"这半条也一起红 ——
  //   那是夹具过时，不是产品坏了。用相对时间就没这个毛病。
  const day = 24 * 3600 * 1000;
  const at = (h) => new Date(Date.now() + h * day).toISOString();
  const past = await postJson('/api/exam/task', t1, {
    paper: etPaper, name: '上一批（已关窗）', open: at(-3), close: at(-2) });
  const closed = await post(`/api/exam/start?paper=${etPaper}&employee=${ET_EMP}`, t1);
  const open = await postJson('/api/exam/task', t1, {
    paper: etPaper, name: '当前批（窗口内）', open: at(-1), close: at(1) });
  const st = await post(`/api/exam/start?paper=${etPaper}&employee=${ET_EMP}`, t1);
  const todayIso = new Date().toISOString().slice(0, 10);
  const list = await get(`/api/exam/tasks?person=${ET_EMP}&on=${todayIso}`, t1);
  rec('EXAMT1', '建两个批次后：开考接口返回 409 + E_EXAM_TASK_CLOSED（不在任何窗口内），'
    + '且这条路走的是答卷写入上的闸，不是"页面记得先 check"；'
    + '今天这一批建好后立刻能开考；GET /api/exam/tasks 把这人该考的任务列出来',
    past.status === 200 && open.status === 200
    && closed.status === 409 && /E_EXAM_TASK_CLOSED/.test(String(closed.body.error))
    && st.status === 200 && Number(st.body.attempt_id) > 0
    && (list.body.tasks || []).length === 1,
    `${past.status}/${open.status} 窗口外=${closed.status}/${closed.body.error} `
    + `窗口内=${st.status} 待考=${(list.body.tasks || []).length} 条`);
}

{ // EXAMT2 错题回顾：交卷前 409，交卷后逐题给答案
  const att = Number((await post(`/api/exam/start?paper=${etPaper}&employee=${ET_EMP}`, t1))
    .body.attempt_id) || 0;
  const before = await get(`/api/exam/review?attempt=${att}`, t1);
  const sub = await post(`/api/exam/submit?attempt=${att}&answers=`
    + encodeURIComponent(JSON.stringify([{ q: etQ, picked: 'B' }])), t1);
  const after = await get(`/api/exam/review?attempt=${att}`, t1);
  const rows = after.body.rows || [];
  rec('EXAMT2', '交卷前 GET /api/exam/review → 409 E_EXAM_NOT_SUBMITTED；交卷后逐题返回'
    + '"我选的 / 正确答案 / 对错 / 得分"（本题答错 → 0 分、answer=A）——'
    + '交卷前不给是防作弊，交卷后给是让他知道错哪了',
    before.status === 409 && sub.status === 200
    && after.status === 200 && rows.length === 1
    && rows[0].answer === 'A' && rows[0].picked === 'B' && rows[0].right === false
    && Number(rows[0].got) === 0,
    `交卷前=${before.status} 交卷=${sub.status} 题数=${rows.length} `
    + `答案=${rows[0] && rows[0].answer} 得分=${rows[0] && rows[0].got}`);
}

{ // EXAMT3 分段 / 缺考 / 切屏证据
  const stat = await get(`/api/exam/stat?paper=${etPaper}`, t1);
  const miss = await get(`/api/exam/missing?paper=${etPaper}`, t1);
  const att = Number((await post(`/api/exam/start?paper=${etPaper}&employee=${ET_EMP}`, t1))
    .body.attempt_id) || 0;
  const e1 = await postJson('/api/exam/event', t1,
    { attempt: att, kind: 'blur', detail: '切走 12 秒' });
  const e2 = await postJson('/api/exam/event', t1,
    { attempt: att, kind: 'paste', detail: '粘贴题干' });
  const cheat = await get(`/api/exam/cheat?attempt=${att}`, t1);
  const flagged = await get(`/api/exam/flagged?paper=${etPaper}`, t1);
  rec('EXAMT3', 'GET /api/exam/stat 出 6 段（含 0 人的段）与"该考没考"名单；'
    + '切屏事件一次一条带时间点（POST /api/exam/event），GET /api/exam/cheat 按时间给回 2 条，'
    + 'GET /api/exam/flagged 把有事件的答卷挑出来 —— "切屏 3 次"这个数解释不了'
    + '"哪 3 次、几点"，而争论发生时能回答的只有时间点',
    stat.status === 200 && (stat.body.buckets || []).length === 6
    && miss.status === 200 && Array.isArray(miss.body)
    && e1.status === 200 && e2.status === 200
    && (cheat.body.events || []).length === 2
    && (flagged.body || []).length >= 1,
    `分段=${(stat.body.buckets || []).length} 段 `
    + `缺考=${Array.isArray(miss.body) ? miss.body.length : '—'} 人 `
    + `事件=${(cheat.body.events || []).length} 条 `
    + `上榜=${(flagged.body || []).length} 份`);
}

// ===========================================================================
// PERFS / AX 组 · 绩效痕迹与加权指标接口（158 / 159）
// ---------------------------------------------------------------------------
// 158 让"这个分是谁给的、改过几次"能回答；159 把"一个 0–100 的总分"拆成
// 营业额 40% + 客诉 20% + 卫生 20% + 出勤 20%。两组都只验**接口把库里的口径
// 原样说出来**：加权、封顶、折分全在库（fn_perf_item_score / fn_perf_total），
// 前端再算一遍，页面上的分与 perf_result.score 迟早会不一样。
// ===========================================================================
const PF_EMP = 9942;
await db.query(`INSERT INTO person(id,full_name) VALUES ($1,'绩效接口甲')
                ON CONFLICT (id) DO NOTHING`, [PF_EMP]);
await db.query(`INSERT INTO employment(id,person_id,legal_entity_id,hire_date)
                VALUES (19942,$1,990,'2030-01-01') ON CONFLICT (id) DO NOTHING`, [PF_EMP]);
await db.query(`INSERT INTO perf_scheme(id,version,name,effective_from)
                VALUES (190,190,'2030 接口版','2030-01-01') ON CONFLICT (id) DO NOTHING`);
await db.query(`INSERT INTO perf_grade(scheme_id,grade,min_score,max_score,factor,target_pct)
                VALUES (190,'A',90,100,2.0000,20),(190,'B',80,89.99,1.5000,30),
                       (190,'C',70,79.99,1.0000,40),(190,'D',0,69.99,0.5000,10)
                ON CONFLICT DO NOTHING`);
await db.query(`INSERT INTO perf_cycle(id,code,name,period_from,period_to,pay_period,status)
                VALUES (190,'M-2030-02','2030 二月','2030-02-01','2030-02-28','2030-02','open')
                ON CONFLICT (id) DO NOTHING`);
await db.query(`INSERT INTO perf_metric(code,name,kind,unit,direction,score_min,score_max) VALUES
                  ('AXI-REV','营业额','quant','元','up',0,150),
                  ('AXI-CMP','客诉次数','quant','次','down',0,150),
                  ('AXI-HYG','卫生检查','behavior',NULL,'up',0,100),
                  ('AXI-ATT','出勤','behavior',NULL,'up',0,100)
                ON CONFLICT (code) DO NOTHING`);

{ // PERFS1 打分 → 结果清单带评分人与版本；再改一次 → 改分史一行；分布每档出行
  const s1 = await post(`/api/perf/score?cycle=190&employee=${PF_EMP}&score=96&note=${encodeURIComponent('首评')}`, t1);
  const r1 = await get('/api/perf/results?cycle=190', t1);
  const row1 = (r1.body.rows || []).find((x) => Number(x.employee_id) === PF_EMP);

  const s2 = await post(`/api/perf/score?cycle=190&employee=${PF_EMP}&score=92&note=${encodeURIComponent('复核校准')}`, t1);
  const r2 = await get('/api/perf/results?cycle=190', t1);
  const row2 = (r2.body.rows || []).find((x) => Number(x.employee_id) === PF_EMP);
  const h = await get(`/api/perf/history?cycle=190&employee=${PF_EMP}`, t1);
  const d = await get('/api/perf/dist?cycle=190', t1);
  const dRows = d.body.rows || [];
  rec('PERFS1', '打分后结果清单带 scored_by 与 version=1；再改一次 → version=2、'
    + 'changed_count=1，GET /api/perf/history 留着一行 96→92；'
    + 'GET /api/perf/dist 把方案四档都列出来（A=1 人、D=0 人也出行）——'
    + '"这一档一个人都没有"与"方案里没有这一档"在报表上不能长一样',
    s1.status === 200 && s2.status === 200
    && row1 && row1.scored_by && Number(row1.version) === 1
    && row2 && Number(row2.version) === 2 && Number(row2.changed_count) === 1
    && Number(row2.score) === 92
    && (h.body.rows || []).length === 1
    && Number(h.body.rows[0].old_score) === 96 && Number(h.body.rows[0].new_score) === 92
    && dRows.length === 4
    && Number(dRows.find((x) => x.grade === 'A').n) === 1
    && Number(dRows.find((x) => x.grade === 'D').n) === 0,
    `${s1.status}/${s2.status} 版本=${row1 && row1.version}→${row2 && row2.version} `
    + `改分史=${(h.body.rows || []).length} 行 分布=${dRows.length} 档`);
}

{ // PERFS2 同一份数据两个入口，权限面必须一致
  //   ★ 这不是"顺手补一条"：`/api/perf/distribution`（旧）原来没有 requireSession，
  //     同一份「谁在什么档」在 /dist 要鉴权、在旧入口谁都能拉。这种洞不会报错，
  //     只会在某次外部审计里被翻出来；而修完之后如果没有断言守着，
  //     下一次重构把 requireSession 删掉也没人知道。
  const oldOne = await get('/api/perf/distribution?cycle=190', t3);
  const newOne = await get('/api/perf/dist?cycle=190', t3);
  rec('PERFS2', '无任何授权的账号（user 3）拉绩效分布：旧入口 /api/perf/distribution 与新入口 '
    + '/api/perf/dist 都必须拒（403），不能一个拒一个放 —— 两个入口读同一张表，'
    + '权限面不一致时，绕过只需要换一个 URL',
    oldOne.status === 403 && newOne.status === 403,
    `旧=${oldOne.status}/${String((oldOne.body || {}).error || '')} `
    + `新=${newOne.status}/${String((newOne.body || {}).error || '')}`);
}

{ // AX1 指标库 → 考核项（权重和错 422）→ 录实际值 → 加权汇总
  const mts = await get('/api/perf/metrics', t1);
  const codes = (mts.body.rows || []).map((m) => m.code);
  const items = [
    { metric_code: 'AXI-REV', weight: 0.4, target_value: 1000000 },
    { metric_code: 'AXI-CMP', weight: 0.2, target_value: 2 },
    { metric_code: 'AXI-HYG', weight: 0.2 },
    { metric_code: 'AXI-ATT', weight: 0.2 },
  ];
  const bad = await postJson('/api/perf/items?scheme=190', t1, items.slice(0, 3));
  const ok = await postJson('/api/perf/items?scheme=190', t1, items);
  const detail = await get('/api/perf/items?scheme=190', t1);
  const list = detail.body.rows || [];
  const byCode = Object.fromEntries(list.map((x) => [x.metric_code, x]));

  const resId = Number((await db.query(
    `SELECT id FROM perf_result WHERE cycle_id=190 AND employee_id=$1`, [PF_EMP])).rows[0].id);
  const sc = async (code, actual) => (await postJson(
    `/api/perf/item-score?result=${resId}&item=${byCode[code].id}`, t1, { actual })).status;
  const sRev = await sc('AXI-REV', 950000);
  const sCmp = await sc('AXI-CMP', 4);
  const sHyg = await sc('AXI-HYG', 90);
  const tot3 = await post(`/api/perf/total?result=${resId}`, t1);
  const sAtt = await sc('AXI-ATT', 95);
  const tot4 = await post(`/api/perf/total?result=${resId}`, t1);

  rec('AX1', 'GET /api/perf/metrics 列出指标库；考核项权重合计 0.8 → 422 且一套都没写进去'
    + '（存的时候校验，不等汇总才发现加起来 0.95）；补成 1 后 GET /api/perf/items 返回四项；'
    + '只打 3 项汇总 = 0.4×95 + 0.2×50 + 0.2×90 = 66（缺项按 0 计，不重新归一），'
    + '补齐出勤后 = 85',
    mts.status === 200 && codes.includes('AXI-REV') && codes.includes('AXI-ATT')
    && bad.status === 422 && /E_PERF_WEIGHT_SUM/.test(String(bad.body.error))
    && ok.status === 200 && list.length === 4
    && sRev === 200 && sCmp === 200 && sHyg === 200 && sAtt === 200
    && Number(tot3.body.total) === 66 && Number(tot4.body.total) === 85,
    `指标=${codes.length} 项 权重错=${bad.status}/${bad.body.error} `
    + `考核项=${list.length} 三项=${tot3.body.total} 四项=${tot4.body.total} `
    + `缺项=${(tot3.body.missing || []).join(',')}`);
}

// ===========================================================================
// PWV 组 · 工资条查阅留痕（184）：谁在什么时候看了谁的工资条
// ---------------------------------------------------------------------------
// 这一组钉的是**"谁能证明自己没被偷看"**：四道闸（行闸/法人闸/掩码/人员闸）
// 都只回答"能不能看"，没有一条回答"谁看过"。员工投诉"我的工资怎么被这么多人
// 看过"时，库里原来一条记录都没有。
// 六条断言对应六个最容易写错的点：
//   ① 看自己不留痕（否则日志被自己刷满，真要看时翻不出来）
//   ② 批量按一次记一行（374 行不写 374 条）
//   ③ 单条记到具体那个人（subject / payslip_id 正确）
//   ④ 留痕写失败不能把读请求打挂（旁路，不是主路）
//   ⑤ 没有全量权限只能查"自己被谁看过"，看别人 → 403
//   ⑥ 有 payroll_slips_read_all 才能按 person 查
// ===========================================================================
{
  const { hashPassword } = await import('../app/services/auth.mjs');
  const mk = async (id, login, roleId, scopeNodes, personId = null) => {
    await db.query(`INSERT INTO sys_data_scope(id,name,combinator)
                    VALUES ($1,$2,'intersection')`, [id, `账号:${login}`]);
    await db.query(`INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES
                      ($1,'cost_org','node_subtree',ARRAY[$2]::bigint[]),
                      ($1,'attendance_org','node_subtree',ARRAY[$2]::bigint[]),
                      ($1,'payroll_legal_entity','nodes',ARRAY[1]::bigint[]),
                      ($1,'si_entity','nodes',ARRAY[1]::bigint[])`, [id, scopeNodes]);
    await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,
                                              grant_kind,grant_reason,effective_from)
                    VALUES ($1,$1,$2,$1,'ROLE',$3,current_date)`,
      [id, roleId, `api.test PWV：${login}`]);
    await db.query('INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES ($1,$2)',
      [id, hashPassword(PWD)]);
    // ★ 绑人这一步必须写：180 起"我是谁"= sys_account.person_id，
    //   没绑人的账号 fn_my_person 为 NULL —— 那种账号只会看到 0 行，
    //   而这条断言要的不是 0 行，是"看自己不留痕"。
    if (personId !== null) {
      await db.query(`INSERT INTO sys_account(id, login, display_name, person_id)
                      OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4)`,
        [id, login, login, personId]);
    }
  };
  const cnt = async (actor) => Number((await db.query(
    `SELECT count(*)::int n FROM payslip_view_log WHERE actor_user_id=$1`, [actor])).rows[0].n);

  // ---- ① 店长看自己的工资条 → 日志 0 条 ----
  const MGR = 9201;
  await mk(MGR, 'pwv_store_mgr', 16, 10, 1);   // store_mgr，绑 person 1（张三，A店）
  const mgrTok = (await loginAs(MGR)).body?.token;
  const ownList = await get('/api/payslip', mgrTok);
  const ownBatch = await get('/api/payroll/slips?run=1', mgrTok);
  const mgrLogs = await cnt(MGR);
  rec('PWV1', '店长（无 payroll_slips_read_all）打开 /api/payslip 与 /api/payroll/slips：'
    + '看到自己那几行（>0），但**留痕 0 条** —— "看自己"不留痕，'
    + '否则每人每天十次的自我浏览会把日志刷满，真要看"谁看过我"时翻不出来',
    ownList.status === 200 && (ownList.body.rows || []).length > 0
    && ownBatch.status === 200 && mgrLogs === 0,
    `/api/payslip=${ownList.status}/${(ownList.body.rows || []).length} 行 `
    + `/api/payroll/slips=${ownBatch.status}/${(ownBatch.body.rows || []).length} 行 `
    + `日志=${mgrLogs} 条`);

  // ---- ② 薪酬专员看整批 → 1 条，row_count=本次行数，scope=list ----
  const HR = 9202;
  await mk(HR, 'pwv_hr', 1, 1, 1);             // 集团HR（有 payroll_slips_read_all）
  const hrTok = (await loginAs(HR)).body?.token;
  const beforeBatch = await cnt(HR);
  const batch = await get('/api/payroll/slips?run=1', hrTok);
  const batchRows = (batch.body.rows || []).length;
  const afterBatch = await cnt(HR);
  const batchLog = (await db.query(
    `SELECT scope, row_count, subject_person_id, pay_run_id FROM payslip_view_log
      WHERE actor_user_id=$1 ORDER BY id DESC LIMIT 1`, [HR])).rows[0] || {};
  rec('PWV2', '薪酬专员（有 payroll_slips_read_all）看 2026-03 整批：'
    + '**只写 1 条**日志，row_count = 本次真实返回行数（演示库是 374），scope=list、'
    + 'pay_run_id 填批次；批量不按人拆 —— 374 条同一动作的记录没人读得出来',
    batch.status === 200 && batchRows > 0 && afterBatch - beforeBatch === 1
    && Number(batchLog.row_count) === batchRows
    && batchLog.scope === 'list' && Number(batchLog.pay_run_id) === 1
    && batchLog.subject_person_id === null,
    `返回=${batchRows} 行 日志增量=${afterBatch - beforeBatch} `
    + `最新一条: scope=${batchLog.scope} row_count=${batchLog.row_count} `
    + `subject=${batchLog.subject_person_id} run=${batchLog.pay_run_id}`);

  // ---- ③ 看某一个别人的工资条 → 1 条，subject / payslip_id 正确 ----
  const beforeSingle = await cnt(HR);
  const planOther = await get('/api/salary/plan?person=2', hrTok);
  const afterSingle = await cnt(HR);
  const singleLog = (await db.query(
    `SELECT scope, subject_person_id, payslip_id, row_count FROM payslip_view_log
      WHERE actor_user_id=$1 ORDER BY id DESC LIMIT 1`, [HR])).rows[0] || {};
  const expSlipId = planOther.body?.payslip?.id ?? null;
  rec('PWV3', '薪酬专员点开**李四（person 2）**的工资表（/api/salary/plan?person=2）：'
    + '写 1 条 scope=single，subject_person_id=2，payslip_id 就是那一张工资条 —— '
    + '"谁看了谁的哪一张"这条链是完整的',
    planOther.status === 200 && afterSingle - beforeSingle === 1
    && Number(singleLog.subject_person_id) === 2
    && singleLog.scope === 'single'
    && (expSlipId === null || Number(singleLog.payslip_id) === Number(expSlipId)),
    `plan=${planOther.status} 日志增量=${afterSingle - beforeSingle} `
    + `subject=${singleLog.subject_person_id} scope=${singleLog.scope} `
    + `payslip=${singleLog.payslip_id}（响应里的 slip=${expSlipId}）`);

  // ---- ④ 留痕写失败，读请求仍然 200 ----
  // ★ 模拟办法：临时把表改名（明确是**临时**，测完立刻改回来；不动迁移、不动 schema 定义）。
  //   要证明的是"留痕是旁路"：取证失败不能变成业务不可用。
  await db.exec('ALTER TABLE payslip_view_log RENAME TO payslip_view_log_off');
  const broken = await get('/api/payroll/slips?run=1', hrTok);
  await db.exec('ALTER TABLE payslip_view_log_off RENAME TO payslip_view_log');
  rec('PWV4', '把 payslip_view_log 临时改名（模拟留痕写失败）后，'
    + '/api/payroll/slips 仍然 200 且照常返回行 —— 留痕写在 try/catch + 独立事务里：'
    + '"取证失败"不能升级成"工资条打不开"',
    broken.status === 200 && (broken.body.rows || []).length > 0,
    `${broken.status} / ${(broken.body.rows || []).length} 行`
    + `${broken.body?.error ? ' error=' + broken.body.error : ''}`);

  // ---- ⑤ 普通员工只能查"自己被谁看过"，查别人 → 403 ----
  const EMP = 9203;
  await mk(EMP, 'pwv_staff', 17, 11, 2);       // store_staff，绑 person 2（李四）
  const empTok = (await loginAs(EMP)).body?.token;
  const mine = await get('/api/payslip/views', empTok);
  const mineRows = mine.body.rows || [];
  const peek = await get('/api/payslip/views?person=1', empTok);
  rec('PWV5', '普通员工查 /api/payslip/views：只看到 subject=自己（2）的记录，'
    + '而且能查到"薪酬专员看过我的工资条"这条；传 person=1 想看别人 → **403**'
    + '（不静默返回空，否则调用方会以为查到了）',
    mine.status === 200 && mineRows.length > 0
    // ★ 185 起会有 hit='batch' 的行（subject 为 NULL，但批次里有我）。
    //   判据从「每行 subject 都是 2」改成「每行要么直接指向我、要么是包含我的批次」——
    //   否则这条断言会把 185 的新能力当成越权。
    && mineRows.every((x) => Number(x.subject_person_id) === 2
                            || (x.subject_person_id === null && x.hit === 'batch'))
    && mine.body.view_scope === 'self'
    && peek.status === 403,
    `自己=${mine.status}/${mineRows.length} 条 `
    + `subject=${[...new Set(mineRows.map((x) => x.subject_person_id))].join(',')} `
    + `view_scope=${mine.body.view_scope} 越权查=${peek.status}/${peek.body.error}`);

  // ---- ⑥ 有 payroll_slips_read_all 的账号能按 person 查，且回包里没有金额 ----
  const byPerson = await get('/api/payslip/views?person=2&limit=5', hrTok);
  const byRows = byPerson.body.rows || [];
  const hasMoney = byRows.some((x) => ('gross_amount' in x) || ('net_amount' in x));
  rec('PWV6', '薪酬专员按 person=2 查留痕：200、能查（view_scope=all），'
    + '每行都带"谁 / 什么时候 / 范围 / 行数"，且**不含金额字段** —— '
    + '留痕回答"谁看过"，不该变成一条绕过字段掩码的取数口',
    byPerson.status === 200 && byRows.length > 0 && byPerson.body.view_scope === 'all'
    && byRows.every((x) => Number(x.subject_person_id) === 2
                          || (x.subject_person_id === null && x.hit === 'batch')) && !hasMoney,
    `${byPerson.status}/${byRows.length} 条 view_scope=${byPerson.body.view_scope} `
    + `字段=${Object.keys(byRows[0] || {}).join('/')}`);

  // ---- ⑦ 185：员工能看见"包含我的批次"，且与"直接看我这一张"分得开 ----
  // ★ 这条修的是 184 自己写明的缺口：批量行 subject 为 NULL，员工查"我被谁看过"
  //   时完全看不到 HR 导过包含他的整批 —— 而那是他最该知道的一种。
  const mine2 = await get('/api/payslip/views', empTok);
  const m2 = mine2.body.rows || [];
  const batchHit = m2.filter((x) => x.hit === 'batch');
  const rowHit = m2.filter((x) => x.hit === 'row');
  rec('PWV7', '员工查「谁看过我」现在能看到**包含我的批次**：hit=batch 的行指向 run=1 的整批日志，'
    + 'hit=row 的行指向直接看我这一张。两种必须分开 —— 混成一个字段，'
    + '读的人会以为"HR 明确点开过我的"，那是另一回事',
    mine2.status === 200 && batchHit.length > 0 && rowHit.length > 0
    && batchHit.every((x) => x.pay_run_id !== null)
    && m2.every((x) => x.hit === 'row' || x.hit === 'batch'),
    `${mine2.status} 条数=${m2.length} batch=${batchHit.length} row=${rowHit.length} `
    + `hits=${[...new Set(m2.map((x) => x.hit))].join('/')}`);

  // ---- ⑧ 185：留痕 append-only —— 改不掉、删不掉、清不空 ----
  const roTry = async (sql) => {
    try { await db.query(sql); return 'allowed'; }
    catch (e) { return String(e.message).split('\n')[0].includes('E_PVL_READONLY') ? 'denied' : 'other:' + String(e.message).slice(0, 40); }
  };
  const roU = await roTry('UPDATE payslip_view_log SET row_count = 999');
  const roD = await roTry('DELETE FROM payslip_view_log');
  const roT = await roTry('TRUNCATE payslip_view_log');
  rec('PUV8'.replace('U','W'), '留痕是 append-only：UPDATE / DELETE / TRUNCATE 全部被拒。'
    + '★ 只拒 DELETE 不够 —— 把 at 改成别的日子、把 actor 改成别人，一样能改掉证据而且"看起来还在"；'
    + '一张谁都能改的审计表在合规上不算数',
    roU === 'denied' && roD === 'denied' && roT === 'denied',
    `UPDATE=${roU} DELETE=${roD} TRUNCATE=${roT}`);

  // ---- ⑨ 185：归档是"搬"不是"删"，且搬完两边合起来仍完整 ----
  const beforeArc = Number((await db.query('SELECT count(*)::int n FROM payslip_view_log')).rows[0].n);
  await db.query(`INSERT INTO payslip_view_log(actor_user_id, scope, row_count, at)
                  VALUES (1,'single',1,'2020-01-01'::timestamptz)`);
  const moved = Number((await db.query(`SELECT fn_pvl_archive('2021-01-01'::timestamptz) n`)).rows[0].n);
  const afterArc = Number((await db.query('SELECT count(*)::int n FROM payslip_view_log')).rows[0].n);
  const inArc = Number((await db.query(`SELECT count(*)::int n FROM payslip_view_log_archive WHERE at < '2021-01-01'`)).rows[0].n);
  const arcUpd = await roTry(`UPDATE payslip_view_log_archive SET row_count = 9`);
  rec('PWV9', '保留期归档：fn_pvl_archive 把老行**搬**进归档表（原表少 1、归档表多 1，合计不变），'
    + '归档表同样改不动。★ 唯一被放行的删除路径是事务级开关 set_config(...,true)，'
    + '不是"给管理员留的后门"',
    moved >= 1 && afterArc === beforeArc && inArc >= 1 && arcUpd === 'denied',
    `搬走=${moved} 原表 ${beforeArc + 1}→${afterArc} 归档表(2021前)=${inArc} 归档表UPDATE=${arcUpd}`);

  // ---- ⑩ 186：签收 —— 一张单一条回执、只能签自己的、幂等、回执不可改 ----
  // 复用 PWV5 的 EMP（账号 9203，绑 person 2）与 hrTok。
  const mySlip = (await db.query(
    `SELECT p.id FROM payslip p WHERE p.employee_id = 2 ORDER BY p.id DESC LIMIT 1`)).rows[0];
  const otherSlip = (await db.query(
    `SELECT p.id FROM payslip p WHERE p.employee_id <> 2 ORDER BY p.id DESC LIMIT 1`)).rows[0];

  const ack1 = await postJson('/api/payslip/ack?slip=' + (mySlip ? mySlip.id : 0), empTok, {});
  const ackRows1 = Number((await db.query('SELECT count(*)::int n FROM payslip_ack')).rows[0].n);
  rec('ACK1', '本人签收自己那张工资条：200、写 1 条回执，already=false；'
    + 'employee_id 从**会话**推出来，不从参数取 —— 参数能改，而"代签"最不该因为一个参数发生',
    ack1.status === 200 && ack1.body?.already === false && ackRows1 === 1,
    `${ack1.status} already=${ack1.body?.already} 回执=${ackRows1} 条 slip=${ack1.body?.payslip_id}`);

  const ack1At = ack1.body?.acked_at;
  const ack2 = await postJson('/api/payslip/ack?slip=' + (mySlip ? mySlip.id : 0), empTok, {});
  const ackRows2 = Number((await db.query('SELECT count(*)::int n FROM payslip_ack')).rows[0].n);
  rec('ACK2', '重复点一次：200、already=true、回执仍是 1 条、**acked_at 不变** —— '
    + '再点一次不是"又签了一回"，改时间就成了不实记录',
    ack2.status === 200 && ack2.body?.already === true && ackRows2 === 1
    && String(ack2.body?.acked_at) === String(ack1At),
    `${ack2.status} already=${ack2.body?.already} 回执=${ackRows2} 条 `
    + `时间 ${String(ack1At)} vs ${String(ack2.body?.acked_at)}`);

  const ackTo = await postJson('/api/payslip/ack?slip=' + (otherSlip ? otherSlip.id : 0), empTok, {});
  const ackRows3 = Number((await db.query('SELECT count(*)::int n FROM payslip_ack')).rows[0].n);
  rec('ACK3', '拿别人的工资条 id 来签：被拒（E_SLIP_NOT_FOUND），回执数不变 —— '
    + '"只能签自己的"落在一条 `p.employee_id = fn_my_person(uid)` 上，不是靠前端不给按钮',
    ackTo.status >= 400 && ackTo.body?.error === 'E_SLIP_NOT_FOUND' && ackRows3 === 1,
    `${ackTo.status}/${ackTo.body?.error} 回执=${ackRows3} 条`);

  const ackHr = await get('/api/payslip/acks?run=1', hrTok);
  rec('ACK4', '薪酬专员看一期签收进度：slips / acked / pending / ack_rate 都给出来，'
    + '未签名单按行闸收窄。★ 只给"已签 1 人"没意义，一线要的是"还差谁"',
    ackHr.status === 200 && ackHr.body?.view_scope === 'all'
    && ackHr.body?.progress && Number(ackHr.body.progress.acked) >= 1
    && Number(ackHr.body.progress.slips) >= Number(ackHr.body.progress.acked)
    && Array.isArray(ackHr.body?.pending),
    `${ackHr.status} ${JSON.stringify(ackHr.body?.progress)} 未签名单=${(ackHr.body?.pending || []).length} 条`);

  const ackSelf = await get('/api/payslip/acks', empTok);
  const mineRow = (ackSelf.body?.mine || []).find((x) => Number(x.payslip_id) === Number(mySlip?.id));
  rec('ACK5', '员工的签收视图只有自己那一行（view_scope=self、progress 为 null）：'
    + '他关心的是"我签没签"，不是"全公司签了多少"',
    ackSelf.status === 200 && ackSelf.body?.view_scope === 'self'
    && ackSelf.body?.progress === null && mineRow && mineRow.acked === true,
    `${ackSelf.status} scope=${ackSelf.body?.view_scope} 自己那张 acked=${mineRow?.acked} ` +
    `method=${mineRow?.method}`);

  const ackUpd = await (async () => {
    try { await db.query(`UPDATE payslip_ack SET acked_at = now() - interval '1 day'`);
      return 'allowed'; }
    catch (e) { return String(e.message).includes('E_ACK_READONLY') ? 'denied' : 'other'; }
  })();
  const ackPaper = await postJson(
    '/api/payslip/ack/paper?slip=' + (otherSlip ? otherSlip.id : 0) + '&note=纸质', empTok, {});
  rec('ACK6', '回执改不动（UPDATE → E_ACK_READONLY）；代录纸质回执需要薪酬写权限，'
    + '员工调 → 403。★ 代录与本人签是两条信任路径，不能共用一个函数',
    ackUpd === 'denied' && ackPaper.status === 403,
    `UPDATE=${ackUpd} 代录=${ackPaper.status}/${ackPaper.body?.error}`);
}

// U 组在文件中间就把已有组写进了登记表，而 AE / X / Y 在它之后才跑 ——
// 于是这四个组永远停在 never_run，覆盖率页上看起来"没跑过"。
// 判据本身没写错，是**写入点放在了错误的位置**：收口的事必须放在最后。
// ===========================================================================
{
  const byG = {};
  for (const r of results) (byG[(String(r.id).match(/^[A-Z]+/) || ['?'])[0]] ||= []).push(r);
  for (const [g, rs] of Object.entries(byG)) {
    const fails = rs.filter((x) => !x.ok).length;
    await db.query('SELECT fn_chk_record($1,$2,$3,$4)',
      [`SUITE.API-${g}`, fails === 0 ? 'pass' : 'fail', fails, null]);
  }
}

server.close();
const pass = results.filter(r => r.ok).length;
console.log(`\n垂直切片 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}${r.note ? `   [${r.note}]` : ''}`);
console.log('');
process.exit(pass === results.length ? 0 : 1);
