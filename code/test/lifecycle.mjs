// ============================================================================
// test/lifecycle.mjs · 全生命周期端到端：招聘 → 入职 → 异动 → 离职
// ----------------------------------------------------------------------------
// 为什么需要这一份：现有的 603 条库断言、281 条接口断言都是**分模块**的，
// 各自全绿。但"合同起始日是不是等于入职日""社保起缴月是不是等于入职月"
// "离职之后花名册还看不看得见这个人"——这类**跨模块对账**没有任何断言守着。
// 它们错了不报错，只会出现"系统里看着都对，一到报税/稽核/仲裁就对不上"。
//
// 所以这个文件只做两件事：
//   ① 让一个虚构员工从"招聘"走到"离职"，每一步都走接口（夹具除外）；
//   ② 把跨模块的两个数摆在一起对，对不上就红，并在 note 里写清是哪两个数。
//
// ★ 三条自我约束：
//   ① **业务动作只走接口**，不直接 INSERT 业务表。直接写库能造出一份"对的"
//      数据，但那证明的是"我会写 SQL"，不是"系统能跑通"。
//   ② **夹具可以写库**：编制/需求/offer 若接口缺参数、身份证档案与入司前工龄
//      若根本没有写入入口 —— 这些是"数据从哪来"的问题，不是"流程通不通"的问题。
//      每一处夹具都在注释里说明为什么绕，绕过了哪一环。
//   ③ **对不上就照实红**，不改宽判据、不改期望值去迁就实现。
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

// 日期统一成 YYYY-MM-DD：库里出来的是 date/ISO，字符串比较会差一个时区
const day = (v) => (v === null || v === undefined ? null : new Date(String(v)).toISOString().slice(0, 10));
const ym = (v) => (v ? String(day(v)).slice(0, 7) : null);
// 生效日前一天：期望值也由时间轴算出来，不在断言里再写一遍字面量
const dayBefore = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const E = (x) => encodeURIComponent(x);

// ---------------------------------------------------------------------------
// 时间轴：一处定义，后面全部引用 —— 断言里再手写一遍日期就等于有两个真值
// ---------------------------------------------------------------------------
const HIRE = '2026-05-06';          // 入职日（5 月，用来验"入职当年折算"）
const CHANGE_ON = '2026-07-01';     // 转店生效日（5 月看旧店、7 月看新店）
const LAST_WORK = '2026-09-30';     // 最后工作日
const APPLY_OUT = '2026-09-10';     // 提出离职日
const OLD_ORG = 10;                 // A店
const NEW_ORG = 11;                 // B店
const ENTITY = 1;                   // 甲方主体
const CKEY = 'idhash-lc-2026-周验一'; // 候选人标识（不可逆键的占位）
const DKEY = 'idhash-lc-2026-落选者';

const t1 = await login(1);          // 集团 HR

// ===========================================================================
// S1 · 编制 → 需求（接口）
// ---------------------------------------------------------------------------
// 编制是月版本的，需求开在 2026-04，所以 4 月这一期要有额度 —— 这是夹具，
// 与"编制怎么来"无关（真实里走 /api/headcount/set，但那个接口不写 period 版本）。
// ===========================================================================
await db.query(
  `INSERT INTO headcount_budget(org_id,period,version,quota,set_by,reason)
   VALUES ($1,'2026-04',
     (SELECT COALESCE(max(version),0)+1 FROM headcount_budget WHERE org_id=$1 AND period='2026-04'),
     12,'hr','生命周期验收：A店 4 月编制（夹具）')`, [OLD_ORG]);

const rqRes = await post(`/api/recruit/requisition?org=${OLD_ORG}&position=${E('门店主管')}`
  + `&headcount=1&opened_at=2026-04-10&reason=${E('生命周期验收：补一名主管')}`, t1);
const RQ = Number(rqRes.body && rqRes.body.requisition_id);
rec('S1', 'POST /api/recruit/requisition 在 A店 开一条需求（名额 1）',
  rqRes.status === 200 && RQ > 0,
  `${rqRes.status} rq=${RQ} org=${OLD_ORG} 名额=${rqRes.body && rqRes.body.headcount}${rqRes.body.error ? ' ' + rqRes.body.error : ''}`);

// ===========================================================================
// S2 · offer（接口）：岗位与月薪只在这里填一次
// ===========================================================================
const offerRes = await post(`/api/recruit/offer?rq=${RQ}&key=${E(CKEY)}&name=${E('周验一')}`
  + `&position=${E('门店主管')}&amount=9000&valid_until=2026-12-31&on=2026-04-12&reason=${E('生命周期验收：首版 offer')}`, t1);
const OFFER = Number(offerRes.body && offerRes.body.offer_id);
const board = await get('/api/recruit?as_of=2026-04-12', t1);
const boardOffer = ((board.body || {}).offers || []).find((x) => Number(x.id) === OFFER) || {};
rec('S2', 'POST /api/recruit/offer 发出 offer（岗位 门店主管 / 月薪 9000），看板能查到它',
  offerRes.status === 200 && OFFER > 0 && Number(boardOffer.amount) === 9000,
  `${offerRes.status} offer=${OFFER} 看板金额=${boardOffer.amount} 状态=${boardOffer.status}${offerRes.body.error ? ' ' + offerRes.body.error : ''}`);

// ===========================================================================
// S3 · 三轮面试（接口）：前两轮 pass；淘汰必须带 ≥10 字评语
// ---------------------------------------------------------------------------
// ★ 这里同时验两件事：主候选人（周验一）三轮全过，走到 offer 之后；
//   另一个候选人（落选者）第三轮淘汰 —— 先试一次 4 字评语（应被拒），
//   再按规矩写足评语记下来。淘汰的评语规则不是摆设：半年后要能答"当时为什么"。
// ===========================================================================
const round = (key, name, no, concl, comment, when) => postJson('/api/recruit/interview', t1, {
  rq: RQ, candidateKey: key, candidateName: name, roundNo: no,
  interviewer: '李主管', scheduledAt: when, method: 'onsite',
  score: concl === 'reject' ? 45 : 82, conclusion: concl, comment,
});
const iv1 = await round(CKEY, '周验一', 1, 'pass', '沟通清楚，有两年门店带班经验', '2026-04-15 10:00');
const iv2 = await round(CKEY, '周验一', 2, 'pass', '排班与盘点思路清晰，可上手', '2026-04-18 14:00');
const iv3 = await round(CKEY, '周验一', 3, 'pass', '区域经理面：价值观与岗位匹配', '2026-04-22 10:00');
const dp1 = await round(DKEY, '落选者', 1, 'pass', '基本条件符合', '2026-04-15 11:00');
const dp2 = await round(DKEY, '落选者', 2, 'pass', '业务能力尚可', '2026-04-18 15:00');
const dBad = await round(DKEY, '落选者', 3, 'reject', '不合适', '2026-04-22 11:00'); // 4 字：应被拒
const dOk = await round(DKEY, '落选者', 3, 'reject',
  '三轮下来带店经验不足，且无法接受排班强度，本轮不通过', '2026-04-22 11:00');
const ivList = await get(`/api/recruit/interview?rq=${RQ}&candidate=${E(CKEY)}`, t1);
rec('S3', '三轮面试走接口记全（前两轮 pass、第三轮 pass）；另一候选人第三轮淘汰：'
  + '4 字评语被拒、写足评语才落库',
  iv1.status === 200 && iv2.status === 200 && iv3.status === 200
  && dp1.status === 200 && dp2.status === 200
  && dBad.status === 400 && dOk.status === 200
  && ((ivList.body || {}).rows || []).length === 3,
  `主候选 3 轮=${((ivList.body || {}).rows || []).length} 淘汰短评语=${dBad.status}/`
  + `${(dBad.body.error || '').slice(0, 24)} 淘汰合规评语=${dOk.status}`);

// ===========================================================================
// S4 · 背调（接口）：先无授权（应 409 E_BG_NO_CONSENT），再带 consentAt 记 clear
// ===========================================================================
const bgNo = await postJson('/api/recruit/bg', t1, { candidateKey: CKEY, kind: 'employment' });
const bgOk = await postJson('/api/recruit/bg', t1, {
  candidateKey: CKEY, kind: 'employment',
  consentAt: '2026-04-10 09:00', checkedAt: '2026-04-13 10:00', result: 'clear',
});
const bgList = await get(`/api/recruit/bg?candidate=${E(CKEY)}`, t1);
const bgRow = (((bgList.body || {}).rows) || []).find((x) => x.kind === 'employment' && x.consent_at) || {};
rec('S4', 'POST /api/recruit/bg：没有书面授权 → 409 E_BG_NO_CONSENT；带 consentAt 才记下 clear',
  bgNo.status === 409 && /E_BG_NO_CONSENT/.test(String(bgNo.body.error))
  && bgOk.status === 200 && bgRow.has_consent === true && bgRow.result === 'clear',
  `无授权=${bgNo.status}/${(bgNo.body.error || '').slice(0, 20)} 有授权=${bgOk.status} `
  + `授权=${bgRow.has_consent} 结论=${bgRow.result}`);

// ===========================================================================
// S5 · 三步审批（接口）：hc / budget / hr_head 都 approved → issuable
// ===========================================================================
const ap1 = await postJson('/api/recruit/approval', t1, { offer: OFFER, step: 'hc', decision: 'approved' });
const ap2 = await postJson('/api/recruit/approval', t1, { offer: OFFER, step: 'budget', decision: 'approved' });
const ap3 = await postJson('/api/recruit/approval', t1, { offer: OFFER, step: 'hr_head', decision: 'approved' });
const apList = await get(`/api/recruit/approval?offer=${OFFER}`, t1);
rec('S5', '三步审批走接口签完（hc → budget → hr_head），GET 的 issuable 变 true',
  ap1.status === 200 && ap2.status === 200 && ap3.status === 200
  && ap3.body.issuable === true && apList.body.issuable === true
  && (apList.body.missing_steps || []).length === 0,
  `${ap1.status}/${ap2.status}/${ap3.status} issuable=${apList.body.issuable} `
  + `缺步=${JSON.stringify(apList.body.missing_steps || [])}`);

// ===========================================================================
// S6 · 入职 + 合同草稿（接口）
// ===========================================================================
const onboard = await postJson('/api/hr/onboard', t1, {
  offer: OFFER, hireDate: HIRE, legalEntityId: ENTITY,
  contract: { employee_address: '上海市黄浦区示例路 88 号 501 室' },
});
const PERSON = Number(onboard.body && onboard.body.person_id);
const CT1 = Number(onboard.body && onboard.body.contract_id);
const CT1_NO = onboard.body && onboard.body.contract_no;
const c1 = CT1 ? (await get(`/api/hr/contract?id=${CT1}`, t1)).body : {};
rec('S6', 'POST /api/hr/onboard 一次完成"人 + 任职 + 工号 + 合同草稿"',
  onboard.status === 200 && PERSON > 0 && CT1 > 0 && /^HT/.test(String(CT1_NO))
  && onboard.body.contract_status === 'draft',
  `${onboard.status} person=${PERSON} 合同=${CT1_NO} 状态=${onboard.body && onboard.body.contract_status} `
  + `提醒=${((onboard.body || {}).warnings || []).length}${onboard.body.error ? ' ' + onboard.body.error : ''}`);

// ===========================================================================
// LC1 · 合同 ← offer 只填一次：起始日 = 入职日；岗位/月薪 = offer 最新版
// ---------------------------------------------------------------------------
// 这一条是整条链上最容易"看起来对"的地方：入职日、岗位、月薪各填一遍，
// 三个数必然有一天不一样，而不一致时按合同执行（往往就是更低的那个）。
// ===========================================================================
{
  // offer 最新版（读 offer_version 是为了看"源头那个数"，不是业务动作）
  const ov = (await rows(`SELECT version, position, monthly_amount FROM offer_version
                           WHERE offer_id=$1 ORDER BY version DESC LIMIT 1`, [OFFER]))[0] || {};
  rec('LC1', '合同 start_date == 入职日；合同 job_title/wage_amount == offer 最新版的 position/monthly_amount',
    day(c1.start_date) === HIRE
    && c1.job_title === ov.position
    && Number(c1.wage_amount) === Number(ov.monthly_amount),
    `合同起=${day(c1.start_date)} 入职=${HIRE}；合同岗位=${c1.job_title} / offer最新v${ov.version}=${ov.position}；`
    + `合同工资=${c1.wage_amount} / offer=${ov.monthly_amount}`);
}

// ===========================================================================
// G1 · 缺口取证：入职链跑完，合同**签不了**
// ---------------------------------------------------------------------------
// fn_contract_render 要求甲乙方关键字段齐全（甲方名称/地址/信用代码/法定代表人、
// 乙方电话/证件号）。而这条链上：
//   · 甲方：legal_entity 里**连 id=1 这一行都没有**（160 的回填只在迁移那一刻
//     扫 employment / pay_run，而种子数据是迁移之后才灌的），于是
//     /api/hr/entities 返回空；而**整个仓库没有写 legal_entity 的接口**；
//   · 乙方：身份证与手机存在 person_profile，而**没有任何接口能写 person_profile**，
//     招聘链（offer / 面试 / 背调）也不落这两样。
// 于是"招聘走到入职"的人在系统里签不出一份合同 —— 这一步不报"缺功能"，
// 报的是"这些关键字段是空的"。这里把它取下来当证据，再补夹具继续。
// ===========================================================================
const signBlind = await post(`/api/hr/contract/sign?id=${CT1}`, t1);
rec('G1', '缺口取证：入职链跑完直接签合同 → 422 E_CT_FIELD_MISSING（甲方主档里没有这一行、'
  + '乙方电话/证件号无写入入口）。这不是参数错，是"这条链补不齐合同要素"',
  signBlind.status === 422 && /E_CT_FIELD_MISSING/.test(String(signBlind.body.error)),
  `${signBlind.status} ${String(signBlind.body.message || signBlind.body.error || '').slice(0, 80)}`);

// —— 夹具（数据来源，不是流程）：补全甲方主档 + 乙方身份证/手机 ——
// ★ 甲方主档这一行**根本不存在**：160 的回填只在迁移时扫 employment / pay_run，
//   而种子数据是迁移之后才灌的 —— 所以 /api/hr/entities 是空的，
//   合同上甲方四项永远为空。这里按 id=1 补一行（真实部署该由主档维护入口补，
//   而那个入口不存在，见 G1）。
await db.query(`INSERT INTO legal_entity (id,name,stamp_name,credit_code,address,legal_rep,is_active)
                VALUES ($1,'示例零售（上海）有限公司','示例零售（上海）有限公司',
                        '91310000MA1FL8XX9K','上海市黄浦区示例路 88 号','王示例',true)
                ON CONFLICT (id) DO UPDATE
                  SET name=EXCLUDED.name, stamp_name=EXCLUDED.stamp_name,
                      credit_code=EXCLUDED.credit_code, address=EXCLUDED.address,
                      legal_rep=EXCLUDED.legal_rep`, [ENTITY]);
await db.query(`INSERT INTO person_profile(person_id,profile_type,profile_value) VALUES
                  ($1,'national_id','310101199505054321'), ($1,'mobile','13800001234')`, [PERSON]);

// ===========================================================================
// S7 · 签合同（接口）
// ===========================================================================
const sign1 = await post(`/api/hr/contract/sign?id=${CT1}`, t1);
rec('S7', 'POST /api/hr/contract/sign 签署首份合同（存正文快照，状态转 signed）',
  sign1.status === 200 && sign1.body.status === 'signed' && Number(sign1.body.body_length) > 0,
  `${sign1.status} 状态=${sign1.body && sign1.body.status} 快照=${sign1.body && sign1.body.body_length} 字`
  + `${sign1.body.message ? ' 原因=' + String(sign1.body.message).slice(0, 60) : ''}`);

// ===========================================================================
// LC3 · 花名册看得见"试用期"与"合同号"
// ---------------------------------------------------------------------------
// 花名册的合同字段是**实时派生**的（161）。派生链断掉的表现不是报错，
// 而是名单上所有人都显示"没有合同 / 不在试用期"—— 每年续签季才会被发现。
// ===========================================================================
{
  const r = await get(`/api/employees?as_of=${HIRE}`, t1);
  const me = (((r.body || {}).rows) || []).find((x) => Number(x.employee_id) === PERSON) || {};
  rec('LC3', '签合同后花名册（as_of=入职日）里 probation_status=probation，contract_no 是刚签那份',
    r.status === 200 && me.probation_status === 'probation' && me.contract_no === CT1_NO,
    `行=${(((r.body || {}).rows) || []).length} 找到=${me.employee_id || '无'} `
    + `试用期=${me.probation_status} 合同=${me.contract_no}（期望 ${CT1_NO}） 门店=${me.org_name}`);
}

// ===========================================================================
// S8 · 社保参保（接口）：起缴月 = 入职月
// ===========================================================================
const si = await postJson('/api/si/enroll', t1, {
  employeeId: PERSON, city: '上海', items: [{ item: 'pension', base_amount: 8000 }], fromPeriod: '2026-05',
});
const siList = await get(`/api/si/enrollments?employee=${PERSON}`, t1);
const siRow = (((siList.body || {}).rows) || []).find((x) => x.item === 'pension') || {};
rec('S8', 'POST /api/si/enroll 在上海参保（养老，基数 8000），起缴月 2026-05',
  si.status === 200 && Number(si.body.inserted) >= 1 && siRow.start_period === '2026-05'
  && Number(siRow.base_amount) === 8000,
  `${si.status} 新增=${si.body && si.body.inserted} 台账起缴月=${siRow.start_period} 基数=${siRow.base_amount}`);

// ===========================================================================
// G2 · 参保入参：别名可用、未知键必拒（修完之后）
// ---------------------------------------------------------------------------
// 这条原来是"缺口取证"：items 传 {base:6000}，fn_si_enroll 只认 base_amount，
// 那个键被忽略、基数回落到月薪 8000，而 inserted 仍是 1、没有任何提示。
// 修完（服务层给 base 别名 + 未知键拒绝）之后，它要改成验两件事：
//   ① 别名真的生效（传 6000 就落 6000）；
//   ② 真的写错的键（baseMoney）**必须报错** —— 静默取另一个值比报错严重得多。
// ===========================================================================
{
  const alias = await postJson('/api/si/enroll', t1, {
    employeeId: 1, city: '上海', items: [{ item: 'pension', base: 6000 }], fromPeriod: '2026-05',
  });
  const list1 = await get('/api/si/enrollments?employee=1', t1);
  const row1 = (((list1.body || {}).rows) || [])
    .filter((x) => x.item === 'pension' && String(x.start_period).slice(0, 7) === '2026-05')[0] || {};
  const typo = await postJson('/api/si/enroll', t1, {
    employeeId: 1, city: '上海', items: [{ item: 'pension', baseMoney: 6000 }], fromPeriod: '2026-06',
  });
  rec('G2', '参保入参：`base` 是 `base_amount` 的别名（传 6000 台账就落 6000，'
    + '不再静默回落到月薪 8000）；而写错的键（baseMoney）**直接报错**并点名是哪一项哪个字段。'
    + '★ 静默取另一个值比报错严重得多：基数悄悄换了，少缴多缴都补不回来',
    alias.status === 200 && Number(row1.base_amount) === 6000
    && typo.status === 422 && /E_SIL_BAD_ARG/.test(String(typo.body.error))
    && /baseMoney/.test(String(typo.body.message || '')),
    `别名=${alias.status} 台账基数=${row1.base_amount} `
    + `错键=${typo.status}/${String(typo.body.message || '').slice(0, 34)}`);
}

// ===========================================================================
// LC2 · 社保起缴月 == 入职日的年月
// ===========================================================================
rec('LC2', '社保参保段 start_period == 入职日的年月',
  ym(siRow.start_period) === ym(HIRE),
  `起缴月=${siRow.start_period} 入职年月=${ym(HIRE)}（社保台账与任职表对账）`);

// ===========================================================================
// S9 · 请假资格（接口）：入职当年的应享天数要折算
// ---------------------------------------------------------------------------
// ★ 缺口（夹具）：入职链没有"入司前工作年限"的入口 —— offer / fn_onboard_full /
//   /api/hr/onboard 都没有这个字段，而年假资格的第一道门槛就是它
//   （fn_leave_qualified：累计工作月数 ≥ 12）。不补这一列，新入职的人永远
//   被判"未满 12 个月"、应享 0 天 —— 这是**真缺口**，不是测试问题。
//   这里用 SQL 补档案值（不是造流程数据），并在报告里单列。
// ===========================================================================
await db.query('UPDATE employment SET prior_work_years = 3 WHERE person_id = $1', [PERSON]);
const elig = await get(`/api/leave/eligibility?employee=${PERSON}&type=ANNUAL`
  + '&from=2026-06-01&to=2026-06-02', t1);
// 期望：档位 5 天（累计工龄 <10 年）× 当年剩余 240 天 / 365，向下取整 = 3 天
rec('S9', 'GET /api/leave/eligibility：入职当年按剩余日历天数折算年假（5 天档 × 240/365 → 3 天）',
  elig.status === 200 && elig.body.ok === true && elig.body.qualified === true
  && Number(elig.body.entitled_days) === 3,
  `${elig.status} 应享=${elig.body && elig.body.entitled_days} 天 资格=${elig.body && elig.body.qualified} `
  + `累计工龄=${elig.body && elig.body.service_years} 年 提示=${((elig.body && elig.warns) || []).length}`);

// ===========================================================================
// S10 · 异动（接口）：开单 → 生效，生成变更协议（draft，不替人签）
// ===========================================================================
const chg = await postJson('/api/hr/change', t1, {
  employeeId: PERSON, kind: 'transfer_store', effectiveDate: CHANGE_ON,
  reason: 'B店新店开业，骨干随店调配', next: { org_id: NEW_ORG, workplace: 'B店' },
});
const CHG = Number(chg.body && chg.body.id);
const chgApply = await post(`/api/hr/change/apply?id=${CHG}`, t1);
const CT2 = Number(chgApply.body && chgApply.body.contract_id);
const CT2_NO = chgApply.body && chgApply.body.contract_no;
rec('S10', 'POST /api/hr/change 开单 → POST /api/hr/change/apply 生效，拿到以 BG 开头的变更协议号，状态仍 draft',
  chg.status === 200 && CHG > 0 && chgApply.status === 200
  && /^BG/.test(String(CT2_NO)) && chgApply.body.contract_status === 'draft',
  `${chg.status} 单=${CHG} ${chgApply.status} 协议=${CT2_NO} 状态=${chgApply.body && chgApply.body.contract_status}`);

// ===========================================================================
// LC4 · 归属按生效日切段；变更协议此时还没签
// ---------------------------------------------------------------------------
// 5 月查到旧店、7 月查到新店 —— 这不是"改了一个字段"，是"两段各说各的历史"。
// 只 UPDATE 现值的话，5 月的工资重算会按新门店归集，且改不回来。
// ===========================================================================
{
  const before = await get(`/api/employees?as_of=2026-05-31`, t1);
  const after = await get(`/api/employees?as_of=2026-07-31`, t1);
  const rowMay = (((before.body || {}).rows) || []).find((x) => Number(x.employee_id) === PERSON) || {};
  const rowJul = (((after.body || {}).rows) || []).find((x) => Number(x.employee_id) === PERSON) || {};
  const chgList = await get(`/api/hr/changes?employee=${PERSON}`, t1);
  const chgRow = (((chgList.body || {}).rows) || [])[0] || {};
  rec('LC4', '异动生效后：花名册 5 月看到旧门店、7 月看到新门店（按生效日切段）；变更协议此刻仍是 draft',
    Number(rowMay.org_id) === OLD_ORG && Number(rowJul.org_id) === NEW_ORG
    && chgRow.new_contract_status === 'draft',
    `5月=${rowMay.org_name}(${rowMay.org_id}) 7月=${rowJul.org_name}(${rowJul.org_id}) `
    + `协议状态=${chgRow.new_contract_status} 台账未签协议=${(chgList.body.kpi || {}).unsigned}`);
}

// ===========================================================================
// S11 · 签变更协议（接口）—— ★ 这一步在本仓实现下是**签不下来的**
// ---------------------------------------------------------------------------
// 失败点不在接口，在库：签署时 163 的触发器 fn_ec_close_prev 把原合同的
// end_date 截到生效日前一天（2026-06-30），而原合同的试用期止是 2026-08-06，
// 于是撞上 160 的 ck_ec_prob_in（试用期必须落在合同期内）→ 整条 UPDATE 回滚，
// 接口回 422 CHECK_VIOLATION（没有业务码、没有消息，用户看不到能改什么）。
// 两个数摆在一起：probation_to=2026-08-06  vs  截断后 end_date=2026-06-30。
//
// ★ 我判断是**触发器漏了一步**（或这条 CHECK 该豁免"已被变更截断的历史合同"）：
//   试用期随合同终止而终止是常态，而阻塞发生在"签署"这个动作上 ——
//   HR 在页面上没有任何自救路径（只能手改库）。这里不改判据、不放宽，
//   照实红；下面的 G3 把这个原因单独钉成一条。
// ===========================================================================
const sign2 = await post(`/api/hr/contract/sign?id=${CT2}`, t1);
rec('S11', 'POST /api/hr/contract/sign 签署变更协议（试用期内转店）',
  sign2.status === 200 && sign2.body.status === 'signed',
  `${sign2.status} 状态=${sign2.body && sign2.body.status} 快照=${sign2.body && sign2.body.body_length} 字`
  + (sign2.status === 200 ? '' : ` 原因=${JSON.stringify(sign2.body).slice(0, 100)}`));

// ===========================================================================
// G3 · 试用期内转店的两侧都对（修完 169 之后）
// ---------------------------------------------------------------------------
// 这里原来钉的是"截断撞 ck_ec_prob_in，所以 S11 签不下来"——那是对的取证，
// 但修完之后它就变成了"记录旧 bug"，必须改成验修复本身。
// ★ 两个方向都要验，缺一条就会退化成"把 CHECK 放宽了事"：
//   ① 裸 UPDATE 把试用期跨出合同 → 仍然被 CHECK 拒（守门没被放宽）；
//   ② 走签署路径 → 原合同试用期收口到终止日、新协议继承到同一个 probation_to，
//      总试用期长度不变（不是"重新约定一次"）。
// ===========================================================================
{
  await db.query(`INSERT INTO employment_contract
    (employee_id,legal_entity_id,contract_no,kind,start_date,end_date,
     probation_from,probation_to,job_title,workplace,employee_address,
     wage_amount,template_id,status,sign_date,body_snapshot)
    SELECT employee_id,legal_entity_id,'TMP-LC-PROBE',kind,start_date,'2027-05-06'::date,
           -- ★ 试用期显式写成"原样"（05-06~08-06），不能从 CT1 复制：
           --   CT1 在 S11 签署时已被触发器收口到 06-30，复制过来就不越界了，
           --   "裸改被拒"那条会变成假绿（我第一版就是这么错的）。
           '2026-05-06'::date,'2026-08-06'::date,job_title,workplace,employee_address,
           wage_amount,template_id,'signed',CURRENT_DATE,'probe'
      FROM employment_contract WHERE id=$1`, [CT1]);
  let cst = '';
  try {
    await db.query(`UPDATE employment_contract SET end_date='2026-06-30'
                     WHERE contract_no='TMP-LC-PROBE'`);
  } catch (e) { cst = e.constraint || e.code || 'unknown'; }
  await db.query(`DELETE FROM employment_contract WHERE contract_no='TMP-LC-PROBE'`);

  // ② 修复后的实际形态：原合同试用期被收口、新协议继承剩余试用期
  const pair = (await db.query(
    `SELECT c1.probation_from pf1, c1.probation_to pt1, c1.end_date e1,
            c2.probation_from pf2, c2.probation_to pt2, c2.start_date s2
       FROM employment_contract c1
       JOIN employment_contract c2 ON c2.prev_id = c1.id
      WHERE c1.id = $1`, [CT1])).rows[0];
  // ★ 第 4 次踩同一个坑：date 列回来是 Date 对象，String(d).slice(0,10) 得到
  //   "Tue Jun 30" 而不是 "2026-06-30"。断言里凡是比日期，都必须先过这层。
  const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10)
    : (v === null || v === undefined ? null : String(v).slice(0, 10)));

  rec('G3', '试用期内转店的两侧都对：① 裸 UPDATE 把试用期跨出合同 → 仍被 ck_ec_prob_in 拒'
    + '（守门没被放宽，绕过触发器改库依然不行）；② 走签署路径：原合同试用期收口到'
    + '终止日 2026-06-30、变更协议从生效日起继续到**同一个** probation_to 2026-08-06 ——'
    + '总试用期仍是 2026-05-06~08-06 三个月，没有"重新约定一次"',
    cst === 'ck_ec_prob_in'
    && ymd(pair.pt1) === '2026-06-30'
    && ymd(pair.pf2) === ymd(pair.s2) && ymd(pair.pt2) === '2026-08-06',
    `裸改=${cst} 原合同试用=${ymd(pair.pf1)}~${ymd(pair.pt1)} 止于合同 ${ymd(pair.e1)} `
    + `新协议试用=${ymd(pair.pf2)}~${ymd(pair.pt2)}`);
}

// ===========================================================================
// LC5 · 签了协议，原合同才被截断到生效日前一天；两份合同不重叠
// ---------------------------------------------------------------------------
// 截断必须发生在**签署那一刻**（163 的触发器）：建单就截断的话，
// "协议还在抽屉里"的这段时间里这个人没有生效合同 —— 花名册显示未签合同，
// 财务报表与社保申报跟着一起认错。
// ===========================================================================
{
  const ctList = await get(`/api/hr/contracts?employee=${PERSON}`, t1);
  const all = (ctList.body && ctList.body.rows) || [];
  const oldOne = all.find((x) => Number(x.id) === CT1) || {};
  const newOne = all.find((x) => Number(x.id) === CT2) || {};
  const oldEnd = day(oldOne.end_date);
  const newStart = day(newOne.start_date);
  const overlap = oldEnd !== null && newStart !== null && oldEnd >= newStart;
  rec('LC5', '签协议后原合同 end_date == 生效日前一天，两份合同期间不重叠',
    oldEnd === dayBefore(CHANGE_ON) && newStart === CHANGE_ON && !overlap
    && oldOne.status === 'signed' && newOne.status === 'signed',
    `原合同 ${oldOne.contract_no} ${day(oldOne.start_date)}~${oldEnd} 状态=${oldOne.status}；`
    + `协议 ${newOne.contract_no} ${newStart}~${day(newOne.end_date)} 状态=${newOne.status}；`
    + `重叠=${overlap ? '是' : '否'}`);
}

// ===========================================================================
// S12 · 离职（接口）：开单 → 交接 → 生效 → 离职证明
// ---------------------------------------------------------------------------
// 离职证明显式要求身份证档案（fn_exit_certificate：证件号空着就不出证明 ——
// 空栏的证明在下家单位用不了）。这条档案在 G1 之前就用夹具补过了，
// 因为"没有写 person_profile 的接口"是同一个缺口。
// ===========================================================================
const exOpen = await postJson('/api/hr/exit/open', t1, {
  employeeId: PERSON, kind: 'resign', applyDate: APPLY_OUT, lastWorkDate: LAST_WORK,
  reason: '个人发展原因提出离职', handoverTo: 1,
});
const EXIT = Number(exOpen.body && exOpen.body.id);
const exHand = await postJson(`/api/hr/exit/handover?id=${EXIT}`, t1, {
  items: [
    { item: '员工工牌 A-0913', category: 'asset', isReturned: true },
    { item: 'B店收银备用金 500 元', category: 'account', isReturned: true },
  ],
});
const exApply = await post(`/api/hr/exit/apply?id=${EXIT}`, t1);
const cert = await get(`/api/hr/exit/certificate?id=${EXIT}`, t1);
rec('S12', '离职走完接口：开单 → 两条交接项均已归还 → 生效（employment/合同/归属各自动了）→ 出离职证明',
  exOpen.status === 200 && EXIT > 0 && exHand.status === 200
  && exHand.body.summary.total === 2 && exHand.body.summary.key_open === 0
  && exApply.status === 200 && exApply.body.status === 'done'
  && Number(exApply.body.affected.employment) === 1
  && Number(exApply.body.affected.contract) === 1
  && cert.status === 200 && String(cert.body.body || '').length > 80,
  `${exOpen.status}/单 ${EXIT}；交接 ${exHand.body.summary && exHand.body.summary.returned}/`
  + `${exHand.body.summary && exHand.body.summary.total} 已还 未还关键项=${exHand.body.summary && exHand.body.summary.key_open}；`
  + `生效=${exApply.status} 影响=任职${exApply.body.affected && exApply.body.affected.employment}/`
  + `合同${exApply.body.affected && exApply.body.affected.contract}/`
  + `归属${exApply.body.affected && exApply.body.affected.assignment}；`
  + `证明=${cert.status} ${cert.body.chars} 字`);

// ===========================================================================
// LC6 · 离职生效后，四张表必须同时"认这个人走了"
// ---------------------------------------------------------------------------
// 任何一张漏了都不报错：employment 还在 → 工资照发；合同还是 signed →
// 续签提醒里还有他；归属段没关 → "这家店几个人"的口径里还有他；
// 花名册还看得见 → 门店以为人还在。
// ===========================================================================
{
  const detail = await get(`/api/employee?id=${PERSON}&as_of=${LAST_WORK}`, t1);
  const emp = (((detail.body || {}).employments) || [])[0] || {};
  const asg = (((detail.body || {}).assignments) || []).find((x) => Number(x.org_id) === NEW_ORG) || {};
  const ctList = await get(`/api/hr/contracts?employee=${PERSON}`, t1);
  const all = ((ctList.body || {}).rows) || [];
  // "在履行"= 期间覆盖离职日的那一份（draft 不算：没签字就不是在履行）
  const covering = all.filter((x) => {
    const s = day(x.start_date);
    const e = day(x.end_date) || '9999-12-31';
    return s <= LAST_WORK && LAST_WORK <= e && x.status !== 'draft';
  });
  const terminated = covering.filter((x) => x.status === 'terminated'
    && day(x.terminate_at) === LAST_WORK);
  const stillSigned = covering.filter((x) => x.status === 'signed');
  const after = await get('/api/employees?as_of=2026-10-01', t1);
  const stillThere = (((after.body || {}).rows) || []).filter((x) => Number(x.employee_id) === PERSON);
  rec('LC6', '离职生效后：leave_date == 最后工作日；覆盖离职日的合同已 terminated（终止日=最后工作日、'
    + '没有"还在履行"的）；归属段收口到最后工作日；花名册在离职次日查不到这个人',
    day(emp.leave_date) === LAST_WORK
    && terminated.length === 1 && stillSigned.length === 0
    && day(asg.valid_to) === LAST_WORK
    && stillThere.length === 0,
    `leave_date=${day(emp.leave_date)}（期望 ${LAST_WORK}）；在履行合同=${terminated.map((x) => x.contract_no).join(',')} `
    + `终止日=${terminated.map((x) => day(x.terminate_at)).join(',')} 仍 signed=${stillSigned.length}；`
    + `归属 ${asg.org_name} valid_to=${day(asg.valid_to)}；次日名册命中=${stillThere.length} 行`);
}

// ===========================================================================
// LC7 · 离职证明只写四要素 + 年限，写不出原因/评价/竞业
// ---------------------------------------------------------------------------
// 不是"记得别写"：生成函数里根本没有"原因"这个变量。多写一句，
// 下家会追问，员工可以主张名誉侵权 —— 而公司还拿不出证据。
// ===========================================================================
{
  const body = String(cert.body.body || '');
  const has = (s) => body.includes(s);
  const banned = ['原因', '评价', '竞业'];
  const leak = banned.filter((w) => has(w));
  rec('LC7', '离职证明正文含姓名/证件号/岗位/入职日/离职日/工作年限，且不含"原因""评价""竞业"',
    has('周验一') && has('310101199505054321')
    && has('门店主管') && has(`入职日期：${HIRE}`) && has(`离职日期：${LAST_WORK}`)
    && has('本单位工作年限：4 个月') && leak.length === 0,
    `姓名=${has('周验一')} 证件号=${has('310101199505054321')} 岗位=${has('门店主管')} `
    + `入职日=${has(`入职日期：${HIRE}`)} 离职日=${has(`离职日期：${LAST_WORK}`)} `
    + `年限=${(body.match(/本单位工作年限：([^\n]*)/) || [])[1]} 禁词命中=${JSON.stringify(leak)}`);
}

// ===========================================================================
// LC8 · 这个人的账：一眼能核对
// ---------------------------------------------------------------------------
// 把八条链上的关键值打印成一行，人肉也能对 —— 数字对不上时不用再去点七个页面。
// ===========================================================================
{
  const ctList = await get(`/api/hr/contracts?employee=${PERSON}`, t1);
  const all = ((ctList.body || {}).rows) || [];
  const spans = all
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)))
    .map((x) => `${x.contract_no}[${day(x.start_date)}~${day(x.end_date) || '无固定'} ${x.status}]`);
  const chgList = await get(`/api/hr/changes?employee=${PERSON}`, t1);
  const chgCount = (((chgList.body || {}).rows) || []).filter((x) => x.status === 'applied').length;
  const detail = await get(`/api/employee?id=${PERSON}&as_of=${LAST_WORK}`, t1);
  const emp = (((detail.body || {}).employments) || [])[0] || {};
  const acct = `入职=${HIRE} · 合同=${spans.join(' → ')} · 社保起缴月=${siRow.start_period}`
    + ` · 应享年假=${elig.body.entitled_days}天 · 异动=${chgCount}次(${CHANGE_ON} 转 B店)`
    + ` · 离职=${day(emp.leave_date)} · 工号/门店链完`;
  rec('LC8', '整条链的人账打印一行（入职日 / 合同号与起止 / 社保起缴月 / 应享年假 / 异动次数 / 离职日）',
    spans.length === 2 && chgCount === 1 && day(emp.leave_date) === LAST_WORK && !!(siRow.start_period),
    acct);
}

// ===========================================================================
// 收口
// ===========================================================================
server.close();
const pass = results.filter((r) => r.ok).length;
console.log(`\n全生命周期 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}${r.note ? `\n          [${r.note}]` : ''}`);
}
console.log('');
process.exit(pass === results.length ? 0 : 1);
