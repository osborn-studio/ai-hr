// ============================================================================
// test/station.mjs · 门店 → 档口 → 岗位 → 编制（172）验收
// ----------------------------------------------------------------------------
// 为什么单独一个文件：`run.mjs` 的 SUITE.OG 验的是"部门能不能嵌套"，
// `api.test.mjs` 的 HC 组验的是"组织级编制够不够"。档口验的是第三件事：
// **门店内部按档口分工之后，编制 / 到岗 / 缺岗 三个数还对不对得上**。
//
// 失败形态与前两者都不同，而且都不报错：
//   ① 一家店的档口配了两套 → 同一个人被两个档口各算一次到岗，缺岗被低估；
//   ② 门店编 12、档口编加起来 14 → "门店满编"和"档口缺人"同时成立；
//   ③ 未定编被渲染成"缺 0" → "这个档口还没定编"看起来像"刚好够"；
//   ④ 一人兼两岗，页面把档口岗次之和当人头，算出"6 个档口 12 人，门店才 10 人"。
//
// ★ 六组必须钉住的性质（对应交付清单）：
//   ST1 编制 = 各档口编制之和，且 Σ档口编 ≤ 门店编（超了就拒，不是静默）
//   ST2 到岗 = 在编 + 在职 + 归属到这家店 + 当期在这个岗位上
//   ST3 缺岗 = 编制 − 到岗，明细能指到"哪个岗位缺几个、缺了多久"
//   ST4 **门店数人头、档口数岗次** —— 跨档口兼任的人在岗次上被数两次，在人头上没有
//   ST5 外包不占编不算到岗；兼职默认占编，区域可以改成不占
//   ST6 不同门店配不同档口 → 两边结果不同；没配档口的店是"没有"，不是"缺 N"
//   另加：档口不能挂区域、append-only、关档口前必须先撤人、品牌线筛选、
//   行闸（别家店的档口看不到）。
//
// ★ 本文件自带夹具（与 multi-org.mjs 同法）：组织 / 人 / 任职 / 归属 / 岗位
//   没有"多档口"场景下的写入入口，这属于"数据从哪来"，不是"流程通不通"。
//   编制与档口配置全部走 fn_sp_set / fn_store_station_enable（真函数，不是 INSERT）
//   —— 那样才验得到判据；只有"造人"是直接写库。
//
// ★ 日期一律显式传：编制是月粒度的，不传日期就只能断言"今天"，
//   而演示数据与工资期间通常不在今天 —— 那种断言最后一定会被改成"跳过"。
// ============================================================================
import { createApp } from '../app/server.mjs';
import { readFileSync } from 'node:fs';

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

const fixtures = [];
const note = (s) => fixtures.push(s);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------
const ON = '2026-03-31';          // 查询日（业务月 2026-03，种子里就有编制）
const PERIOD = '2026-03';

// 岗位（集团级词表，org 留空 —— "头灶"不属于任何一家店）
const mkPos = async (code, name, outsourced = false) => Number((await one(
  `SELECT fn_position_upsert($1,$2,NULL::bigint,2::smallint,$3,NULL::varchar) id`,
  [code, name, outsourced])).id);
const POS_WOK = await mkPos('T_WOK', '头灶');
const POS_GARN = await mkPos('T_GARN', '打荷');
const POS_CUT = await mkPos('T_CUT', '头砧');
const POS_OUT = await mkPos('T_OUT', '外包洗碗', true);
note(`岗位：头灶(${POS_WOK}) 打荷(${POS_GARN}) 头砧(${POS_CUT}) 外包洗碗(${POS_OUT}, is_outsourced)`);

// 人：张三(1) 是种子里就在 A 店的，另造 3 个
await db.query(`INSERT INTO person(id, full_name) VALUES
  (101,'赵一'),(102,'钱二'),(103,'孙三'),(104,'周四')`);
await db.query(`INSERT INTO employment(id, person_id, legal_entity_id, hire_date, pay_basis) VALUES
  (101,101,1,'2026-01-01',NULL),
  (102,102,1,'2026-01-01',NULL),
  (103,103,1,'2026-01-01','hour'),    -- 兼职 / 小时工
  (104,104,1,'2026-01-01',NULL)`);
await db.query(`INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from) VALUES
  (101,'cost_org',10,'2026-01-01'),(101,'attendance_org',10,'2026-01-01'),
  (102,'cost_org',10,'2026-01-01'),(102,'attendance_org',10,'2026-01-01'),
  (103,'cost_org',10,'2026-01-01'),(103,'attendance_org',10,'2026-01-01'),
  (104,'cost_org',11,'2026-01-01'),(104,'attendance_org',11,'2026-01-01')`);
note('人：A店=张三(1)/赵一(101)/钱二(102)/孙三(103,小时工)；B店=李四(2)/周四(104)');

const stationId = async (code) => Number((await one(
  `SELECT id FROM station WHERE code = $1`, [code])).id);
const S_WOK = await stationId('WOK');
const S_GARN = await stationId('GARNISH');
const S_CUT = await stationId('CUT');
const S_ROAST = await stationId('ROAST');
const S_FLOOR = await stationId('FLOOR');
note(`档口词表：炉灶(${S_WOK}) 打荷(${S_GARN}) 砧板(${S_CUT}) 烧腊(${S_ROAST}) 前厅(${S_FLOOR})`);

// A 店(10)：炉灶档 + 打荷档（**两个档口**），B 店(11)：只有炉灶档，C 店(12)：不配
const ss = async (store, station, from = '2026-01-01') => Number((await one(
  `SELECT fn_store_station_enable($1,$2,$3::date) id`, [store, station, from])).id);
const A_WOK = await ss(10, S_WOK);
const A_GARN = await ss(10, S_GARN);
const B_WOK = await ss(11, S_WOK);

// 档口定编（走 fn_sp_set，判据才验得到）
const setSp = (ssId, pos, hc, reason = '开业定编') => db.query(
  `SELECT fn_sp_set($1,$2,$3,$4,'hr',$5)`, [ssId, pos, PERIOD, hc, reason]);
await setSp(A_WOK, POS_WOK, 3);      // 炉灶档：头灶 3 个编
await setSp(A_GARN, POS_GARN, 2);    // 打荷档：打荷 2 个编（张三、赵一 兼）
await setSp(B_WOK, POS_WOK, 2, 'B店两家灶');   // B 店：头灶 2 个编
note(`定编：A店 炉灶3+打荷2=5（门店编 12）；B店 炉灶2（门店编 5）`);

// 授岗：张三(1) 头灶 + 打荷（**一人两岗、跨两个档口**）
const assign = (person, pos, from = '2026-03-01', to = null) => db.query(
  `INSERT INTO person_position(person_id, position_id, valid_from, valid_to)
   VALUES ($1,$2,$3::date,$4::date)`, [person, pos, from, to]);
await assign(1, POS_WOK);
await assign(1, POS_GARN);
await assign(101, POS_GARN);
await assign(101, POS_WOK);
await assign(103, POS_WOK);          // 小时工也站头灶
await assign(2, POS_WOK);            // 李四在 B 店
await assign(104, POS_WOK, '2026-03-01', '2026-03-10');   // 周四 3-10 离职
note('授岗：张三兼头灶+打荷；孙三(小时工)头灶；周四 3-10 离职');

const t1 = await login('1');     // 集团 HR：cost_org 整棵子树
const t2 = await login('2');     // A 店 HR：cost_org 只有 org 10
if (!t1 || !t2) { console.error('登录失败'); process.exit(1); }

const apiSt = (store, tok = t1, extra = '&detail=1') =>
  getJson(`/api/org/stations?store=${store}&on=${ON}${extra}`, tok);
const call2 = async (path, tok, method = 'POST') => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${tok}` } });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : null };
};

// ---------------------------------------------------------------------------
// ST1 · 编制 = Σ档口编，且 Σ档口编 ≤ 门店编
// ---------------------------------------------------------------------------
{
  const r = await apiSt(10);
  const d = r.body || {};
  const sumPos = (d.stations || []).reduce((a, s) =>
    a + (s.positions || []).reduce((b, p) => b + (p.headcount || 0), 0), 0);
  rec('ST1a', '档口编 = 明细里各岗位编制之和（炉灶 3 + 打荷 1 = 4），'
    + '与接口的 station_quota 同一个数（不另算一遍）',
    r.status === 200 && d.store.station_quota === 5 && sumPos === 5,
    `status=${r.status} station_quota=${d.store?.station_quota} 手工求和=${sumPos}`);
}
{
  // 门店编 12，已分 4。再要 9 个 → 13 > 12，必须拒
  let msg = '';
  try {
    await setSp(A_GARN, POS_CUT, 9, '故意超门店编');
  } catch (e) { msg = err(e); }
  const now = Number((await one(
    `SELECT fn_store_station_quota(10,$1) v`, [PERIOD])).v);
  rec('ST1b', 'Σ档口编 > 门店编 → 有名字地拒（E_SP_OVER_STORE），'
    + '且库里没有留下这半条配置',
    /^E_SP_OVER_STORE/.test(msg) && now === 5,
    `err=${msg.slice(0, 40)} 之后 Σ档口编=${now}`);
}
{
  // 门店没定编时不拦（与 022:265-278 同一条规矩），但要能被看见
  const r = await apiSt(12);
  rec('ST1c', '没配档口的门店返回 0 个档口（不是报错、也不是"缺 N"），'
    + '门店编仍然读得到（C店种子编 3）',
    r.status === 200 && (r.body.stations || []).length === 0
      && r.body.store.station_count === 0 && r.body.store.quota === 3,
    `status=${r.status} 档口=${r.body?.stations?.length} 门店编=${r.body?.store?.quota}`);
}

// ---------------------------------------------------------------------------
// ST2 · 到岗 = 在编 + 在职 + 归属这家店 + 当期在这个岗位上
// ---------------------------------------------------------------------------
{
  const r = await apiSt(10);
  const st = (r.body.stations || []).find((x) => x.station_code === 'WOK');
  const p = (st.positions || []).find((x) => x.position_code === 'T_WOK');
  rec('ST2a', '炉灶档·头灶 到岗 3（张三/赵一/孙三），编制 3，缺岗 0',
    r.status === 200 && p.holders === 3 && p.headcount === 3 && p.gap === 0,
    `holders=${p?.holders} hc=${p?.headcount} gap=${p?.gap}`);
  rec('ST2b', '到岗明细带得出是谁（同名岗位多人时名字全在）',
    /张三/.test(p.holder_names) && /赵一/.test(p.holder_names) && /孙三/.test(p.holder_names),
    `names=${p?.holder_names}`);
}
{
  // 归属不在本店的人不算：把赵一的 cost_org 改到 B 店，A 店头灶应当掉 1
  await db.query(
    `UPDATE employee_org_assignment SET valid_to = '2026-03-15'
      WHERE employee_id = 101 AND dim_code = 'cost_org'`);
  await db.query(
    `INSERT INTO employee_org_assignment(employee_id, dim_code, org_id, valid_from)
     VALUES (101,'cost_org',11,'2026-03-16')`);
  const r = await apiSt(10);
  const p = (r.body.stations || []).find((x) => x.station_code === 'WOK')
    .positions.find((x) => x.position_code === 'T_WOK');
  rec('ST2c', '人调走了就不算本店到岗（cost_org 按当天生效的那一段判断）：'
    + '赵一 3-16 起成本归 B 店 → A 店头灶 3→2，缺岗 0→1',
    p.holders === 2 && p.gap === 1,
    `holders=${p.holders} gap=${p.gap}`);
  // 还原
  await db.query(`DELETE FROM employee_org_assignment
                   WHERE employee_id = 101 AND dim_code = 'cost_org' AND org_id = 11`);
  await db.query(`UPDATE employee_org_assignment SET valid_to = NULL
                   WHERE employee_id = 101 AND dim_code = 'cost_org' AND org_id = 10`);
}
{
  // 离职的人不算：周四 3-10 离职，B 店头灶在 3-31 只剩李四
  const r = await apiSt(11);
  const p = (r.body.stations || [])[0].positions.find((x) => x.position_code === 'T_WOK');
  rec('ST2d', '离职的人不算到岗（离职日当天仍算在职，次日起不算）：'
    + 'B店头灶 编 2、3-31 到岗 1',
    p.holders === 1 && p.headcount === 2,
    `holders=${p.holders} hc=${p.headcount}`);
}

// ---------------------------------------------------------------------------
// ST3 · 缺岗 = 编制 − 到岗，明细指到岗位，且"缺了多久"是算出来的
// ---------------------------------------------------------------------------
{
  const r = await apiSt(11);
  const p = (r.body.stations || [])[0].positions.find((x) => x.position_code === 'T_WOK');
  // 断点：编制 03-01 生效、周四 valid_to=03-10 → 03-11 起只剩 1 人 < 编 2
  rec('ST3a', '缺岗起始日 = 最后一次"到岗≥编制"之后的下一个断点（3-11），'
    + '不是"最后一个断点 + 1 天"（那样会得到 3-02）',
    p.gap === 1 && String(p.gap_since).slice(0, 10) === '2026-03-11' && p.days_open === 20,
    `gap=${p.gap} since=${p.gap_since} days=${p.days_open}`);
  rec('ST3b', '门店级缺岗 = 各档口缺岗之和（岗次），B店 1',
    r.body.store.gap === 1 && r.body.store.slots_filled === 1,
    `门店缺=${r.body.store.gap} 岗次=${r.body.store.slots_filled}`);
}
{
  // 从没配满过：编制 3、实际就 3 个人但其中一小时工被排除后 → 另一种成因
  const r = await apiSt(10);
  const st = (r.body.stations || []).find((x) => x.station_code === 'WOK');
  rec('ST3c', '缺口明细能指到"哪个岗位缺几个"：炉灶档下按岗位逐行给出 编/到岗/缺',
    st.positions.length >= 1 && st.positions.every((x) =>
      x.headcount !== undefined && x.holders !== undefined && 'gap' in x),
    `岗位行=${st.positions.map((x) => `${x.position_name} ${x.holders}/${x.headcount}/${x.gap}`).join(' ')}`);
}
{
  // 未定编：开一个烧腊档但一个岗都不定编
  await ss(10, S_ROAST);
  const r = await apiSt(10);
  const st = (r.body.stations || []).find((x) => x.station_code === 'ROAST');
  rec('ST3d', '「未定编」不是「缺 0」：烧腊档没定编 → quota / gap 都是 null，'
    + '而且它出现在列表里（不是整条消失）',
    !!st && st.quota === null && st.gap === null && st.positions.length === 0,
    st ? `quota=${st.quota} gap=${st.gap} 岗位数=${st.positions.length}` : '烧腊档整条不见了');
  rec('ST3e', '未定编的档口单独计数（stations_unset），不进缺岗合计',
    r.body.store.stations_unset === 1 && r.body.store.gap === 0,
    `unset=${r.body.store.stations_unset} 缺岗合计=${r.body.store.gap}`);
}

// ---------------------------------------------------------------------------
// ST4 · 门店数人头、档口数岗次 —— 跨档口兼任的人在岗次上被数两次
// ---------------------------------------------------------------------------
{
  const r = await apiSt(10);
  const d = r.body;
  const wok = d.stations.find((x) => x.station_code === 'WOK');
  const garn = d.stations.find((x) => x.station_code === 'GARNISH');
  // 张三与赵一各自在炉灶档 + 打荷档各算 1 个岗次：
  //   Σ档口岗次 = 头灶 3 + 打荷 2 = 5；A 店人头 = 4（张三/赵一/孙三/钱二）
  rec('ST4a', '一人两岗：Σ档口岗次(3+2=5) > 门店人头(4) —— 这两个数**不能相减**',
    d.store.slots_filled === 5 && d.store.headcount === 4,
    `岗次=${d.store.slots_filled} 门店人头=${d.store.headcount}`);
  rec('ST4b', '单个档口内部：岗次与人头可以相等（张三只在这个档口兼一次时不重复算）',
    wok.slots_filled === 3 && wok.holders === 3,
    `炉灶 岗次=${wok.slots_filled} 人头=${wok.holders}`);
  rec('ST4c', '张三同时出现在炉灶档与打荷档的在岗名单里（这是真实的，不是重复统计）；'
    + '档口内两个岗位各有名单，档口之间的重叠只在岗次上体现',
    /张三/.test(wok.positions.find((x) => x.position_code === 'T_WOK').holder_names)
    && /张三/.test(garn.positions.find((x) => x.position_code === 'T_GARN').holder_names),
    `炉灶头灶=${wok.positions[0].holder_names} 打荷=${garn.positions[0].holder_names}`);
  rec('ST4d', '门店"已分到档口"+"还没分到档口" = 门店编（5 + 7 = 12），'
    + '三级数字自洽',
    d.store.station_quota === 5
      && d.store.quota_unallocated === d.store.quota - d.store.station_quota,
    `已分=${d.store.station_quota} 未分编=${d.store.quota_unallocated} 门店编=${d.store.quota}`);
}

// ---------------------------------------------------------------------------
// ST5 · 外包不占编；兼职默认占编，区域可以改
// ---------------------------------------------------------------------------
{
  let msg = '';
  try { await setSp(A_GARN, POS_OUT, 1, '外包岗配进档口'); } catch (e) { msg = err(e); }
  const n = Number((await one(
    `SELECT count(*)::int n FROM station_position WHERE position_id = $1`, [POS_OUT])).n);
  rec('ST5a', '外包岗不能配进档口编制（E_SP_OUTSOURCED）：'
    + '编的是内部人头预算，外包按工时结算 —— 混在一张表上会出现"编制 3/到岗 3"里有 2 个外包',
    /^E_SP_OUTSOURCED/.test(msg) && n === 0, `err=${msg.slice(0, 36)} 落库行数=${n}`);
}
{
  const before = (await apiSt(10)).body.stations
    .find((x) => x.station_code === 'WOK').positions[0].holders;
  // 区域（org 30）把口径改成"小时工不占编"（floor=region，单店改不了）
  await db.query(
    `INSERT INTO policy_override(org_id, policy_code, effective_from, value_text, reason, approved_by)
     VALUES (30,'HC_STATION_PARTTIME','2026-03-01','exclude','小时工走工时结算','area_hr')`);
  const after = (await apiSt(10)).body.stations
    .find((x) => x.station_code === 'WOK').positions[0];
  rec('ST5b', '兼职默认占编（3 人）；区域改成 exclude 后小时工既不占编也不计到岗（2 人）'
    + ' —— 两件事必须同进同出，只排除一边会出现"到岗 > 编制"',
    before === 3 && after.holders === 2 && after.headcount === 3 && after.gap === 1,
    `改前到岗=${before} 改后=${after.holders}/${after.headcount} 缺=${after.gap}`);
  await db.query(`DELETE FROM policy_override WHERE policy_code = 'HC_STATION_PARTTIME'`);
}

// ---------------------------------------------------------------------------
// ST6 · 不同门店配不同档口 → 两边结果不同；没配的是"没有"，不是"缺 N"
// ---------------------------------------------------------------------------
{
  const a = (await apiSt(10)).body;
  const b = (await apiSt(11)).body;
  const c = (await apiSt(12)).body;
  rec('ST6a', 'A店 3 个档口（炉灶/打荷/烧腊）、B店 1 个（炉灶）、C店 0 个 —— '
    + '"不同门店配不同数量的档口"真的成立',
    a.store.station_count === 3 && b.store.station_count === 1 && c.store.station_count === 0,
    `A=${a.store.station_count} B=${b.store.station_count} C=${c.store.station_count}`);
  rec('ST6b', '同一份数据下两家店的数不同（A 缺 0、B 缺 1），'
    + '说明不是同一个数被复制了两遍',
    a.store.gap === 0 && b.store.gap === 1,
    `A缺=${a.store.gap} B缺=${b.store.gap}`);
  rec('ST6c', '没配档口的店：stations 是空数组、缺岗是 **null**（不是 0，见 ST12）、'
    + '门店编照常读得到（否则页面显示"没定编"而其实定了）；'
    + '"还没分到档口"的单位是**编**，等于门店编全部',
    Array.isArray(c.stations) && c.stations.length === 0
      && c.store.gap === null && c.store.quota === 3 && c.store.quota_unallocated === 3,
    `stations=${c.stations?.length} 缺=${c.store.gap} 门店编=${c.store.quota} 未分编=${c.store.quota_unallocated}`);
}

// ---------------------------------------------------------------------------
// 判据面：档口不能挂区域 / 同店岗位不跨档口 / append-only / 关档口要先撤人
// ---------------------------------------------------------------------------
{
  let msg = '';
  // ★ 演示种子建 org_unit 时没写 kind，全部落到 DEFAULT 'dept'（076 的回填跑在种子之前），
  //   所以"区域 30"在这里其实是 dept。要让这条判据有意义，先把集团根显式改成 group。
  await db.query(`UPDATE org_unit SET kind = 'group' WHERE id = 1`);
  try { await ss(1, S_CUT); } catch (e) { msg = err(e); }
  rec('ST7a', '档口只能挂在部门（门店是部门名的一种）下：挂到集团根上有名字地拒（E_STN_NOT_STORE）',
    /^E_STN_NOT_STORE/.test(msg), `err=${msg.slice(0, 44)}`);
}
{
  let msg = '';
  try { await setSp(A_GARN, POS_WOK, 1, '头灶再挂一个档口'); } catch (e) { msg = err(e); }
  rec('ST7b', '同一家店内一个岗位只能属一个档口（E_SP_CROSS_STATION）：'
    + '否则到岗人数有两个答案，两个档口各算一次',
    /^E_SP_CROSS_STATION/.test(msg), `err=${msg.slice(0, 44)}`);
}
{
  let msg = '';
  try {
    await db.query(`UPDATE station_position SET headcount = 99`);   // 无 WHERE：全表
  } catch (e) { msg = err(e); }
  const still = (await apiSt(10)).body.store.station_quota;
  rec('ST7c', '档口编制只增不改：UPDATE 被触发器拒（E_SP_APPEND_ONLY），'
    + '"上个月编了几个"不会因为调编而消失',
    /^E_SP_APPEND_ONLY/.test(msg) && still === 5, `err=${msg.slice(0, 36)} 之后合计=${still}`);
}
{
  let msg = '';
  try { await db.query(`SELECT fn_store_station_close($1,'2026-03-31')`, [A_GARN]); }
  catch (e) { msg = err(e); }
  rec('ST7d', '关档口前必须先撤人：还有人在岗 → E_STN_IN_USE（与 086 停用部门同一条规矩）',
    /^E_STN_IN_USE/.test(msg), `err=${msg.slice(0, 44)}`);
}

// ---------------------------------------------------------------------------
// 品牌线筛选：专门店不该在候选里看见烧腊档
// ---------------------------------------------------------------------------
{
  const codes = (n) => q(`SELECT code FROM fn_station_choices($1) ORDER BY code`, [n])
    .then((rs) => rs.map((r) => r.code));
  const ct = await codes('cantonese');
  const tp = await codes('tempura');
  rec('ST8a', '粤菜线可选里有烧腊档、点心白案档、打荷档',
    ['ROAST', 'DIMSUM', 'GARNISH'].every((c) => ct.includes(c)), `粤菜=${ct.join(',')}`);
  rec('ST8b', '天妇罗专门店的可选里**没有**烧腊 / 点心 / 打荷，只有通用档 + 炸物台 + 天妇罗台',
    !tp.includes('ROAST') && !tp.includes('DIMSUM') && !tp.includes('GARNISH')
      && tp.includes('FRY') && tp.includes('TEMPURA') && tp.includes('FLOOR'),
    `tempura=${tp.join(',')}`);
}

// ---------------------------------------------------------------------------
// 接口面：行闸 / 组织树字段 / 权限
// ---------------------------------------------------------------------------
{
  const bad = await apiSt(11, t2);      // A 店 HR 去看 B 店
  rec('ST9a', '行闸：A店HR 拿别家店的 id 查档口 → 403（不是 200 + 空清单）。'
    + '空清单会被读成"这家店没配档口"，而事实是"不该你看"',
    bad.status === 403, `status=${bad.status} err=${bad.body?.error}`);
  const own = await apiSt(10, t2);
  rec('ST9b', '同一身份查自己店 → 200，数字与集团 HR 看到的一致（行闸只挡越界，不改口径）',
    own.status === 200 && own.body.store.station_count === 3,
    `status=${own.status} 档口=${own.body?.store?.station_count}`);

  // user 3 = 有角色、零数据范围（perm-matrix 里"岗位允许、范围为空"的那个身份）。
  // 它必须 403 而不是 200+空：空清单是一个结论，403 是一个拒绝。
  const t3 = await login('3');
  const none = await apiSt(10, t3);
  rec('ST9d', '数据范围为空的身份 → 403（不是 200 + 空清单）。'
    + 'fail-closed 在这里必须表现为"拒绝"，不是"这家店没有档口"',
    none.status === 403, `status=${none.status} err=${none.body?.error}`);
}
{
  const noStore = await getJson(`/api/org/stations?on=${ON}`, t1);
  rec('ST9c', '不传 store → 400（有名字地拒，不是 500）',
    noStore.status === 400 && /^E_STATION_NO_STORE/.test(String(noStore.body?.error)),
    `${noStore.status} ${noStore.body?.error}`);
}
{
  const t = await getJson(`/api/org/tree?on=${ON}`, t1);
  const a = (t.body.rows || []).find((x) => Number(x.id) === 10);
  const region = (t.body.rows || []).find((x) => Number(x.id) === 30);
  rec('ST10a', '组织树的部门节点带档口三数：A店 档口 3、未定编 1',
    t.status === 200 && a.stations === 3 && a.station_unset === 1,
    `A店 stations=${a?.stations} unset=${a?.station_unset} 岗缺=${a?.station_gap}`);
  rec('ST10b', '区域/集团没有档口 → station_gap 是 null（不是 0）；'
    + '0 会被读成"区域不缺人"，而事实是"这个层级没有档口这件事"',
    region && region.stations === 0 && region.station_gap === null,
    `区域 stations=${region?.stations} gap=${region?.station_gap}`);
  rec('ST10c', '树上的编制按 ?on= 那一期算（2026-03），不是按"今天" —— '
    + '不传日期时行为与 172 之前完全一致',
    t.body.period === '2026-03' && Number(a.quota) === 12,
    `period=${t.body.period} A店编=${a?.quota}`);
}

// ---------------------------------------------------------------------------
// ST11 · 关档之后：两处"Σ档口编"必须给同一个数
// ---------------------------------------------------------------------------
// 这个坑是写 172 时自己踩出来的：fn_store_station_quota（守卫用它判"超门店编"）
// 原来不带"期末还开着"这个条件，于是 3-15 关掉一个档口之后，
// 守卫仍按 5 算、页面按 3 算 —— "还没分到档口"在同一屏上算出两个数，
// 而两个数都对得上自己的算式。差 2 个编不会报错，只会让下一次调编算错。
{
  const FLOOR = await stationId('FLOOR');
  const ssF = await ss(10, FLOOR);
  await setSp(ssF, POS_CUT, 1, '前厅档配一个头砧（夹具）');

  const before = Number((await one(
    `SELECT fn_store_station_quota(10,$1) v`, [PERIOD])).v);
  const beforeSum = (await apiSt(10)).body.stations
    .reduce((a, s) => a + (s.quota || 0), 0);
  rec('ST11a', '开着的档口：守卫口径与页面口径是同一个数（5 + 前厅 1 = 6）',
    before === 6 && beforeSum === 6, `守卫=${before} 页面=${beforeSum}`);

  // 3-15 关掉前厅档（那个档口一个人都没有，所以关得掉）
  await db.query(`SELECT fn_store_station_close($1,'2026-03-15')`, [ssF]);

  const after = Number((await one(
    `SELECT fn_store_station_quota(10,$1) v`, [PERIOD])).v);
  const d = (await apiSt(10)).body;
  const afterSum = d.stations.reduce((a, s) => a + (s.quota || 0), 0);
  rec('ST11b', '关档之后两处仍然一致（3-31 已不含它，都是 5）—— '
    + '带不带"期末还开着"这个条件是两个口径，而它们不会互相报错',
    after === 5 && afterSum === 5 && after === afterSum,
    `守卫=${after} 页面=${afterSum} 未分到档口=${d.store.unallocated}`);

  // 期末之前的那一天：档口还在，编制也还在（关档是加 end 日期，不是删数据）
  const pastRows = (await getJson(`/api/org/stations?store=10&on=2026-03-10&detail=1`, t1)).body;
  const hasFloor = (pastRows.stations || []).some((s) => s.station_code === 'FLOOR');
  const floorQ = (pastRows.stations || []).find((s) => s.station_code === 'FLOOR')?.quota;
  rec('ST11c', '关档是加一条结束日期，不是删数据：3-10 那天那个档口还在、编制还是 1；'
    + '已配的 station_position 一行没动',
    hasFloor && floorQ === 1,
    `3-10 有前厅档=${hasFloor} 编制=${floorQ}`);
  const rows = Number((await one(
    `SELECT count(*)::int n FROM station_position sp
      JOIN store_station ss ON ss.id = sp.store_station_id
     WHERE ss.id = $1`, [ssF])).n);
  rec('ST11d', '关档之后那个档口的编制行仍然在库里（只增不改：关档不改历史编制）',
    rows === 1, `编制行数=${rows}`);
}

// ---------------------------------------------------------------------------
// ST12 · 同一件事，两个接口不能给两个答案：没档口 → gap 是 null，不是 0
// ---------------------------------------------------------------------------
// 这条是走查（walk）在自己那边读出来的：SQL 层（fn_station_fill）返回的是 NULL，
// 是接口的聚合把空集合求和成了 0。前端当时因为 `!d.stations.length` 提前 return
// 所以页面上看不出来 —— 但导出 / 报表 / MCP 拿到 gap:0 会读成"编制刚好够"，
// 而这正是 172 登记的 SUITE.ST-GAP 要防的那件事。
//
// ★ 为什么不删掉这条断言、只改代码：不钉住的话，下一个人会觉得
//   "对空数组求和得 0 更简单" 又改回去，而改回去不会有任何测试变红。
{
  const t = await getJson(`/api/org/tree?on=${ON}`, t1);
  const rowC = (t.body.rows || []).find((x) => Number(x.id) === 12);
  const apiC = (await apiSt(12)).body;
  const apiA = (await apiSt(10)).body;
  rec('ST12a', '没配档口的店：/api/org/tree 的 station_gap 与 /api/org/stations 的 gap '
    + '**必须都是 null**（两个接口对同一件事给两个答案是更坏的错）',
    !!rowC && rowC.station_gap === null && apiC.store.gap === null,
    `C店 tree=${rowC && rowC.station_gap} api=${apiC.store.gap}`);
  rec('ST12b', '配了档口且都满编的店，gap 是 **0** 而不是 null —— '
    + '"有档口且不缺"与"压根没有档口"必须不同形，否则页面上两者都长成"不缺人"',
    apiA.store.gap === 0,
    `A店 gap=${apiA.store.gap}（档口 ${apiA.store.station_count} 个，未定编 ${apiA.store.stations_unset} 个）`);
  rec('ST12c', '"还没分到档口"的单位是**编**不是人：它是 门店编 − Σ已定编档口编，'
    + '字段名带 quota 就是为了堵这个误读（有人会答成"没分到档口的人"）',
    apiA.store.quota_unallocated === apiA.store.quota - apiA.store.station_quota,
    `已分编=${apiA.store.station_quota} 未分编=${apiA.store.quota_unallocated} 门店编=${apiA.store.quota}`);
}

// ---------------------------------------------------------------------------
// ST13 · 品牌线写错要拒，不能静默退化成 common
// ---------------------------------------------------------------------------
// `fn_station_choices` 的条件是 brand_line IN ('common', <传入值>)：
// 传错名字不报错，只会返回"只有 common 那几条"—— 一份**看起来完全正常**的清单。
// 运营以为选的是某条专线，铺下去才发现少了烧腊档，而铺错之后要 close 再重开。
{
  const bad = await getJson('/api/org/station/choices?brand_line=nonsense', t1);
  const ok = await getJson('/api/org/station/choices?brand_line=tempura', t1);
  rec('ST13', '品牌线不认识 → 400 并列出可选值（不是 200 + 悄悄降级成 common）：'
    + '静默降级的后果是"少铺了几个档口"看起来像铺成功了',
    bad.status === 400 && /^E_ARG_INVALID/.test(String(bad.body?.error))
      && /common/.test(String(bad.body?.message)) && ok.status === 200,
    `${bad.status} ${String(bad.body?.error).slice(0, 40)} | tempura=${ok.status}`);
}

// ---------------------------------------------------------------------------
// ST14 · 非部门节点不给算档口
// ---------------------------------------------------------------------------
// 返回一份空清单，看起来像"这个区域没配档口"，而事实是"档口这个概念只在门店里有"。
// ST7a 已经把集团根改成了 group，这里直接拿它试。
{
  const region = await getJson(`/api/org/stations?store=1&on=${ON}`, t1);
  rec('ST14', '集团 / 区域节点不给算档口 → 422 E_STN_NOT_STORE（与 172 触发器同一个码）：'
    + '空清单会被下游当成"这个区域没有档口"，尤其以后接了 MCP 工具之后',
    region.status === 422 && /^E_STN_NOT_STORE/.test(String(region.body?.error)),
    `${region.status} ${String(region.body?.error).slice(0, 46)}`);
}

// ---------------------------------------------------------------------------
// ST15 · 两个入口必须是一个口径：单店切片 == 全量切片（174 的前提）
// ---------------------------------------------------------------------------
// 174 把三数函数拆成 core（唯一实现）+ 两个薄封装：
//   fn_station_fill(store, on)   —— 单店，给 /api/org/stations 与这整套断言用
//   fn_station_fill_all(on)      —— 全量，给 /api/org/tree 一次取回 60 家店
// 拆的理由是性能（逐店调用 60 次要 8.3 秒），但**风险**也在这里：
// 两个入口一旦各写一份 join，迟早有一天算出的数不一样 ——
// 而不一样的那天，组织树和门店详情页会各显示一个数，两个都"算得通"。
// 所以这条比对必须存在：它不是在测性能，是在钉"只有一个实现"。
{
  const j = (v) => JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x));
  const single = await q(`SELECT * FROM public.fn_station_fill(10, $1::date)`, [ON]);
  const whole = (await q(`SELECT * FROM public.fn_station_fill_all($1::date) WHERE store_id = 10`, [ON]))
    .map(({ store_id, ...rest }) => rest);
  const same = single.length === whole.length && single.length > 0
    && single.every((r, i) => j(r) === j(whole[i]));
  rec('ST15', 'fn_station_fill(store) 与 fn_station_fill_all() 的单店切片**逐行逐列相同**'
    + '（含行序）—— 174 拆了两个入口，但口径只能有一份',
    same, `单店 ${single.length} 行 / 全量切片 ${whole.length} 行`
      + (same ? '' : `，首个不同行：${j(single[0]) !== j(whole[0]) ? '0' : '其它'}`));

  // 顺带钉住"档口数按 store_station 去重，不是数明细行"：
  // 一个档口挂两个岗位时，明细是 2 行、档口仍是 1 个。
  const dup = (await q(`SELECT count(*)::int n FROM public.fn_station_fill(10,$1::date)`, [ON]))[0].n;
  const distinctSs = (await q(
    `SELECT count(DISTINCT store_station_id)::int n FROM public.fn_station_fill(10,$1::date)`, [ON]))[0].n;
  const treeRow = (await getJson(`/api/org/tree?on=${ON}`, t1)).body.rows.find((x) => Number(x.id) === 10);
  rec('ST15b', '组织树上的 stations 数的是**档口**（store_station 去重），不是明细行数 —— '
    + '一个档口两个岗时两者会差一倍，而树和门店详情页必须给同一个数',
    treeRow.stations === distinctSs && distinctSs > 0,
    `树=${treeRow.stations} 去重档口=${distinctSs} 明细行=${dup}`);
}

// ---------------------------------------------------------------------------
// ST16 · 排他约束撞了要有人话，不能把 Postgres 的约束名吐给用户
// ---------------------------------------------------------------------------
// 走查实测（8788）：回溯开通撞 ex_ss_no_overlap，接口回的是
//   {"error":"EXCLUSION_VIOLATION","sqlstate":"23P01"}
// —— 没有业务码、没有 message，前端只能当"系统错误"。
// 而它其实是条很常见的业务拒绝：想改起始日的人一定会撞上。
//
// ★ 断言直接匹配错误码字符串：这条要钉死的就是"约束名不许外泄"，
//   只看 status 409 是钉不住的（EXCLUSION_VIOLATION 也是 409）。
{
  const WOK = await stationId('WOK');
  const r = await call2(`/api/org/station/enable?store=10&station=${WOK}&from=2025-06-01`, t1);
  const err = String(r.body && r.body.error || '');
  const raw = JSON.stringify(r.body || {});
  rec('ST16', '回溯开通撞上已有时间段 → 409 **E_STN_OVERLAP** 且带"该怎么做"；'
    + '不许把 EXCLUSION_VIOLATION / 23P01 原样回给客户端',
    r.status === 409 && err === 'E_STN_OVERLAP'
      && !/EXCLUSION_VIOLATION|23P01|ex_ss_no_overlap/.test(raw)
      && /重叠/.test(String(r.body && r.body.message || '')),
    `${r.status} ${raw.slice(0, 100)}`);
}

// ---------------------------------------------------------------------------
// ST17 · 超编是"超编 N"，不是"缺岗 −1"
// ---------------------------------------------------------------------------
// 编制调小、人还在岗 → station_gap 是负数。汇总只累加 > 0（那是"缺的总量"），
// 所以总数没错；但明细里把 −1 写成"缺岗 −1"是句错话 —— 缺口不会是负的，
// 负的是**另一个状态**（超编）。前端那一栏必须分开写。
{
  // 打荷档：2 人在岗，把编制改成 0 → 超编 2
  await setSp(A_GARN, POS_GARN, 0, '把编制调零（夹具体验）');
  const d = (await apiSt(10)).body;
  const garn = (d.stations || []).find((x) => x.station_code === 'GARNISH');
  rec('ST17a', '编制 0 / 在岗 2 → 档口 gap = −2（接口照实给负数，不夹成 0）',
    !!garn && garn.quota === 0 && garn.slots_filled === 2 && garn.gap === -2,
    garn ? `编=${garn.quota} 岗次=${garn.slots_filled} gap=${garn.gap}` : '打荷档不见了');

  // 前端那一栏的文案（源码扫描，与 W13/W14 同法：DOM 层点不了，就钉源码）
  const html = readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
  const cell = (html.match(/const gapCell = \(g\) =>[\s\S]{0,420}?;/) || [''])[0];
  rec('ST17b', '档口"缺岗"那一栏有**超编**分支（不是"缺岗 −1"），且正负都带单位 —— '
    + '负数不是错数据，是另一个状态，必须不同形',
    /超编 \$\{-g\}/.test(cell) && /缺岗 \$\{g\}/.test(cell),
    cell ? cell.replace(/\s+/g, ' ').slice(0, 150) : '没找到 gapCell');
}

// ---------------------------------------------------------------------------
// ST18 · 有下级比"含下级"，叶子比"直属" —— 缺编这一栏必须算得通
// ---------------------------------------------------------------------------
// 现象（60 店库）：组织页集团行显示「缺 388」、城市行「缺 148」。
// 根因是 gap = 额度 − **直属**在编：集团/城市的额度是"下辖之和"，
// 而直属在编是 0 人 → 差多少编就报缺多少。
//
// ★ 这条和 ST12a/12b 是同一类：数字必须自己算得通。
//   集团 388 编、直属 0 人、缺 14 —— 读者拿 388−0 得到 388，跟 14 对不上，
//   于是他会怀疑整张表。所以：**有下级就按含下级比，并在标签上写清比的是哪个数**。
{
  const t = await getJson(`/api/org/tree?on=${ON}`, t1);
  const byId = new Map((t.body.rows || []).map((r) => [Number(r.id), r]));
  const g = byId.get(30);      // 华东区：有下级，额度 20 = 12 + 5 + 3
  const a = byId.get(10);      // A 店：叶子
  const kids = [byId.get(10), byId.get(11), byId.get(12)];

  rec('ST18a', 'has_kids 标得对：区域 true、门店 false（页面靠它决定比哪个数）',
    !!g && g.has_kids === true && !!a && a.has_kids === false,
    `区域 has_kids=${g && g.has_kids} 门店 has_kids=${a && a.has_kids}`);

  rec('ST18b', '有下级的组织：缺编 = 编制 − **含下级**（不是 − 直属）',
    !!g && g.quota !== null && g.gap === g.quota - g.subtree,
    g ? `编制 ${g.quota} − 含下级 ${g.subtree} = ${g.gap}（直属只有 ${g.headcount}）` : '区域节点不见了');

  // 这条是"别改回用直属"的钉子：若改回去，区域会报成"缺一整个下辖的数"
  rec('ST18c', '区域这一行**不能**是"编制 − 直属"：直属 0 人会把它报成缺 ${g.quota}',
    !!g && g.headcount === 0 && g.gap !== g.quota - g.headcount,
    g ? `按直属算会得 ${g.quota - g.headcount}，实际给 ${g.gap}` : '');

  rec('ST18d', '叶子节点行为不变：缺编 = 编制 − 在编（含下级就等于在编）',
    !!a && a.subtree === a.headcount && a.gap === a.quota - a.headcount,
    a ? `含下级 ${a.subtree} = 在编 ${a.headcount}，编制 ${a.quota} → 缺 ${a.gap}` : 'A店不见了');

  // ★ 这条就是"集团那 14 与 5 家缺岗店之和 14 是不是同一个数"的可自动化版本：
  //   父额度 = 子额度之和时，父缺口必须 = 子缺口之和。不成立说明还有人长在父级自己身上。
  const qSum = kids.reduce((x, r) => x + (r.quota || 0), 0);
  const gSum = kids.reduce((x, r) => x + (r.gap || 0), 0);
  rec('ST18e', '父额度 = Σ子额度 时，父缺口 = Σ子缺口（三级数字自洽的那条，换成"有下级"口径后仍然成立）',
    !!g && g.quota === qSum && g.gap === gSum,
    g ? `父编 ${g.quota} vs Σ子编 ${qSum}；父缺 ${g.gap} vs Σ子缺 ${gSum}` : '');

  // ★ 一般式（ST18e 只是它在"没留机动编"时的特例）：
  //     父缺 = Σ子缺 +（父编 − Σ子编）
  //   v5 里上级留了 8 个"机动编"（没下分给门店、也没人），于是
  //     集团 22 = Σ门店 14 + 8、深圳 7 = Σ门店 6 + 1
  //   两个数都成立、都对。写这条是因为 ST18e 的前提（父编=Σ子编）在留机动编的库里
  //   **不成立**，而那时"父缺 ≠ Σ子缺"会被误读成口径错 —— 差的那部分正是未下分的编。
  //   ★ 机动编 ≠ 缺岗：缺岗是"有编没人"，机动是"有编、故意空着、还没分下去"。
  const unalloc = (g && g.quota != null) ? g.quota - qSum : null;
  rec('ST18f', '一般式：父缺 = Σ子缺 +（父编 − Σ子编）—— 留机动编时这条也成立',
    !!g && g.gap === gSum + unalloc,
    g ? `父缺 ${g.gap} = Σ子缺 ${gSum} + 未下分 ${unalloc}（父编 ${g.quota} − Σ子编 ${qSum}）` : '');

  // 真正会走到"机动编"分支的是**集团**（它的额度大于下辖区域之和）。
  // 上面那条在 A 店那种"刚好吃满"的节点上，未下分恒为 0，等于只验了特例。
  const top = byId.get(1);
  const topKids = (t.body.rows || []).filter((x) => Number(x.parent_id) === 1);
  if (top && top.quota != null && topKids.length) {
    const kq = topKids.reduce((a, r) => a + (r.quota || 0), 0);
    const kg = topKids.reduce((a, r) => a + (r.gap || 0), 0);
    const rest = top.quota - kq;
    rec('ST18g', '集团这一层才是"留了机动编"的真实形态：父缺 = Σ子缺 + 机动，'
      + '而"父缺 ≠ Σ子缺"不是口径错 —— 差的就是还没下分的编',
      top.gap === kg + rest,
      `集团 编 ${top.quota} / 缺 ${top.gap}；Σ子编 ${kq} / Σ子缺 ${kg}；机动 ${rest}`
        + (rest ? '（这一支真的非 0，验到了）' : '（本夹具无机动，只验了等式）'));
  }
}

// ---------------------------------------------------------------------------
// ST19 · 跨期改属：允许，但必须能被 **API** 读到（不是只在库里查得到）
// ---------------------------------------------------------------------------
// 走查的实测环境只能走 HTTP（他那边打 67M 库会 Aborted），所以"写进文档的 SQL"
// 对验收等于不存在。这条断言的措辞就按这个来：**能被 API 读到的事实才算证据**。
//
// 夹具：把 A 店的头灶岗在 2026-02 挂到打荷档（同店同期不许双挂，跨期允许），
// 于是 2026-03 一查，头灶就带着"上月由打荷档改属"的痕迹。
{
  await db.query(
    `INSERT INTO station_position(store_station_id,position_id,period,version,headcount,set_by,reason)
     VALUES ($1,$2,'2026-02',1,1,'hr','夹具体验：上月挂在打荷档')`,
    [A_GARN, POS_WOK]);

  const d = (await apiSt(10)).body;
  const wok = (d.stations || []).find((x) => x.station_code === 'WOK');
  const p = wok && (wok.positions || []).find((x) => x.position_code === 'T_WOK');
  rec('ST19a', 'detail=1 里带得出「上一期属于哪个档口」：头灶 ←2026-02 由打荷档改属',
    !!p && p.prev_period === '2026-02' && p.prev_station_name === '打荷档',
    p ? `prev=${p.prev_period}/${p.prev_station_name}` : '头灶行不见了');

  const allPos = (d.stations || []).flatMap((x) => x.positions || []);
  const withPrev = allPos.filter((x) => x.prev_station_name);
  rec('ST19b', '只有搬过家的那一行带这个字段（不是给每一行都挂一个空串 —— '
    + '空串会被读成"改属过但不知道从哪来"）',
    allPos.length >= 2 && withPrev.length === 1 && withPrev[0].position_code === 'T_WOK',
    `岗位 ${allPos.length} 个，带改属痕迹 ${withPrev.length} 个（${withPrev.map((x) => x.position_code).join(',')}）`);

  const noDetail = (await apiSt(10, t1, '')).body;
  const anyPos = (noDetail.stations || []).some((x) => 'positions' in x);
  rec('ST19c', 'detail 不带时连 positions 都不返回（痕迹只在明细里，别把一店的岗位表塞进树）',
    noDetail.stations.length > 0 && !anyPos,
    `stations=${noDetail.stations.length} 带 positions=${anyPos}`);
}

// ---------------------------------------------------------------------------
// ST20 · 幂等命中必须说出来（一个"没生效的操作看起来成功"比报错更难查）
// ---------------------------------------------------------------------------
// 走查实测：从既有区间内部再 enable 一个更晚的日期 → 200，拿回**原来那段**的 id，
// 起始日没变、也不报错。人事会以为"我把起始日改到 7 月 1 日了"。
// 现在接口把"实际生效的起始日"回给前端，与请求不一致就打 idempotent 标记。
{
  const WOK = await stationId('WOK');
  const r = await call2(`/api/org/station/enable?store=10&station=${WOK}&from=2026-03-20`, t1);
  rec('ST20a', '区间内部再 enable → 200 且标记 idempotent，并把**实际生效**的起始日回出来'
    + '（不是把请求的那天原样回显 —— 那是谎报）',
    r.status === 200 && r.body.idempotent === true
      && r.body.requested_from === '2026-03-20' && r.body.from === '2026-01-01',
    `from=${r.body && r.body.from} requested=${r.body && r.body.requested_from} idempotent=${r.body && r.body.idempotent}`);

  const first = await call2(`/api/org/station/enable?store=10&station=${WOK}&from=2026-01-01`, t1);
  rec('ST20b', '正好命中既有起始日 → 不算 idempotent（这是真的"就是这天开的"）',
    first.status === 200 && first.body.idempotent === false && first.body.from === '2026-01-01',
    `from=${first.body && first.body.from} idempotent=${first.body && first.body.idempotent}`);
}

// ---------------------------------------------------------------------------
// ST21 · 「定了就一直用」：沿用在读时生效，而且**看得出是沿用**（181）
// ---------------------------------------------------------------------------
// 用户口径："定了就一直用、要改的时候才动"。
// ★ 每一条都同时看两件事：**数字**（headcount）和**状态**（set / carried / unset）。
//   只断言数字的话，"沿用 06 月的 3 个"和"本期真配 3 个"在测试里长得一模一样 ——
//   而那正是沿用带来的副作用：**忘了配的月份看起来和有配的月份一样**。
//   三态里只要有一个被压平（比如把 carried 渲染成 set），这条测试必须红。
{
  const eff = (ssId, pos, period) => one(
    `SELECT * FROM fn_station_quota_effective($1::bigint,$2::bigint,$3::varchar)`,
    [ssId, pos, period]);
  const eff4 = (store, station, pos, period) => one(
    `SELECT * FROM fn_station_quota_effective($1::bigint,$2::bigint,$3::bigint,$4::varchar)`,
    [store, station, pos, period]);

  // 夹具里 station_position 只有 2026-03 这一期（另加 ST19 补的 2026-02 一行）
  const s = await eff(A_WOK, POS_WOK, PERIOD);
  rec('ST21a', '本期真配过 → set，carried_from 为空（沿用与"本期配的"必须能分开）',
    s.status === 'set' && Number(s.headcount) === 3 && s.carried_from == null,
    `status=${s.status} hc=${s.headcount} carried_from=${s.carried_from}`);

  const c = await eff(A_WOK, POS_WOK, '2026-04');
  rec('ST21b', '本期没配 → carried，且带出 carried_from=2026-03（数字沿用 3）',
    c.status === 'carried' && Number(c.headcount) === 3 && c.carried_from === PERIOD,
    `status=${c.status} hc=${c.headcount} carried_from=${c.carried_from}`);

  const u = await eff(A_WOK, POS_WOK, '2026-01');
  rec('ST21c', '早于最早一期 → unset，headcount 是 NULL 不是 0（"没配"≠"编 0 个"）',
    u.status === 'unset' && u.headcount == null && u.carried_from == null,
    `status=${u.status} hc=${u.headcount}`);

  // 4 参版只是把 station.id 解析成当期那一段 store_station.id 再转调 —— 答案必须一样
  const v = await eff4(10, S_WOK, POS_WOK, '2026-04');
  rec('ST21d', '(门店,档口,岗位,期间) 与 (门店档口,岗位,期间) 给同一份答案、同一个代号 —— '
    + '口径只有一处实现，两个入口不能各算一套',
    v.status === 'carried' && v.carried_from === PERIOD
      && Number(v.headcount) === Number(c.headcount)
      && Number(v.store_station_id) === A_WOK,
    `4参 status=${v.status} hc=${v.headcount} ss=${v.store_station_id}（3参 ss=${A_WOK}）`);

  // 接口：切到"没配过"的月份，编制有了，而且带出处；同一屏的未配档口仍是 unset
  const apr = (await getJson(`/api/org/stations?store=10&on=2026-04-15&detail=1`, t1)).body || {};
  const wokApr = (apr.stations || []).find((x) => x.station_code === 'WOK');
  const roastApr = (apr.stations || []).find((x) => x.station_code === 'ROAST');
  const wokPosApr = wokApr && (wokApr.positions || []).find((x) => x.position_code === 'T_WOK');
  rec('ST21e', '接口切到 2026-04（真没配的月份）：炉灶档编 3 且 quota_status=carried / '
    + 'carried_from=2026-03；同一屏的烧腊档是 unset（quota 为 null）—— 三态在一屏里分得开',
    !!wokApr && wokApr.quota === 3 && wokApr.quota_status === 'carried'
      && wokApr.carried_from === PERIOD
      && !!roastApr && roastApr.quota === null && roastApr.quota_status === 'unset',
    `炉灶 ${wokApr && wokApr.quota}/${wokApr && wokApr.quota_status}/${wokApr && wokApr.carried_from}；`
    + `烧腊 ${roastApr && roastApr.quota}/${roastApr && roastApr.quota_status}`);

  rec('ST21f', '岗位级也带状态（档口 mixed 时逐岗才看得出哪些是沿用的）：'
    + '炉灶档·头灶 carried_from=2026-03',
    !!wokPosApr && wokPosApr.quota_status === 'carried' && wokPosApr.carried_from === PERIOD,
    wokPosApr ? `岗位 ${wokPosApr.quota_status}/${wokPosApr.carried_from}` : '头灶行不见了');

  // 沿用月的"守卫口径 = 页面口径"（172 ST11 那条规矩，换成沿用场景）
  const guardApr = Number((await one(
    `SELECT fn_store_station_quota(10,'2026-04') v`)).v);
  const pageApr = (apr.stations || []).reduce((a, x) => a + (x.quota || 0), 0);
  rec('ST21g', '沿用月里守卫与页面是同一个数（守卫若只按"本期自己的行"求和会得 0，'
    + '于是调编会放行一个实际超编的写入，而两边都不报错）',
    // ★ 不写死 5：前面的 ST17 把打荷档调成了 0 编，这里只钉"两个口径相等"这件事，
    //   数字写死会让这条断言在别人调整夹具时变成噪声（而它要防的是"两边不同"）。
    guardApr === pageApr && guardApr > 0,
    `守卫=${guardApr} 页面=${pageApr}`);

  // 改组：搬走的岗位旧档口不能沿用（否则同一岗位两个档口各编一份，且不报错）
  // ST19 把「头灶」在 2026-02 挂到了打荷档，2026-03 又回到炉灶档。
  const moved = await eff(A_WOK, POS_WOK, '2026-02');
  const atGarn = await eff(A_GARN, POS_WOK, '2026-02');
  const feb = (await getJson(`/api/org/stations?store=10&on=2026-02-15&detail=1`, t1)).body || {};
  const wokFeb = (feb.stations || []).flatMap((x) => x.positions || [])
    .filter((x) => x.position_code === 'T_WOK');
  rec('ST21h', '改组搬走的岗位：旧档口是 **moved**（不是 carried、也不是 unset），新档口是 set；'
    + '落到页面上只算 1 份（按档口沿用会两边各编一份 —— 不报错，只让合计凭空变大）',
    moved.status === 'moved' && Number(moved.moved_to) === S_GARN
      && atGarn.status === 'set' && Number(atGarn.headcount) === 1
      && wokFeb.length === 1 && Number(wokFeb[0].headcount) === 1,
    `旧档口=${moved.status}/→${moved.moved_to} 新档口=${atGarn.status}/${atGarn.headcount} `
    + `页面头灶行=${wokFeb.length}`);

  // ★ 回填不存在：沿用只发生在读时
  const n0 = Number((await one(`SELECT count(*)::int n FROM station_position`)).n);
  await eff(A_WOK, POS_WOK, '2026-07');
  await eff(A_WOK, POS_WOK, '2026-10');
  await getJson(`/api/org/stations?store=10&on=2026-07-15&detail=1`, t1);
  await getJson(`/api/org/tree?on=2026-10-15`, t1);
  const n1 = Number((await one(`SELECT count(*)::int n FROM station_position`)).n);
  rec('ST21i', '沿用**没有回填**：连查 07 / 10 两个月之后 station_position 行数一个没多'
    + '（回填会把"哪一期真的配过"永久抹掉，而且下个月还得再回填一次）',
    n1 === n0, `查前 ${n0} 行 / 查后 ${n1} 行`);
}

// ---------------------------------------------------------------------------
// ST22 · 两条取数路径必须同答案：三数函数 vs 单点查询（181）
// ---------------------------------------------------------------------------
// 为什么必须钉：`fn_station_fill_core` 为了性能把"最近一期"放在一条 SQL 里算，
// `fn_station_quota_effective` 是给调用方单点问的。两个实现**看起来一样**，
// 而"看起来一样"正是 174 开头否掉的东西 —— 不一样的那天，页面按一个数、
// 守卫按另一个数，各自都算得通。这里逐行比。
{
  const d = (await getJson(`/api/org/stations?store=10&on=2026-04-15&detail=1`, t1)).body || {};
  const bad = [];
  let n = 0;
  for (const st of (d.stations || [])) {
    for (const p of (st.positions || [])) {
      n += 1;
      const e = await one(
        `SELECT * FROM fn_station_quota_effective($1::bigint,$2::bigint,$3::bigint,$4::varchar)`,
        [10, st.station_id, p.position_id, '2026-04']);
      if (Number(e.headcount) !== Number(p.headcount)
          || String(e.status) !== String(p.quota_status)) {
        bad.push(`${st.station_code}/${p.position_code}: 页面 ${p.headcount}/${p.quota_status}`
          + ` vs 函数 ${e.headcount}/${e.status}`);
      }
    }
  }
  rec('ST22', '三数函数的每一行与单点函数同答案（数字 + 状态都比）',
    n > 0 && bad.length === 0, bad.length ? bad.join(' | ') : `${n} 行全部一致`);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;

console.log(`\n夹具（${fixtures.length} 项）：`);
for (const f of fixtures) console.log(`  · ${f}`);
console.log('\n断言：');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}`);
  if (r.note) console.log(`      [${r.note}]`);
}
if (fail > 0) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.id}  ${r.note}`);
}
console.log(`\n门店档口与编制 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${fail}\n`);
await db.close();
process.exit(fail === 0 ? 0 : 1);
