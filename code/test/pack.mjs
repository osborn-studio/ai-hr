// ============================================================================
// test/pack.mjs · 按门店批量打包工资单（171）验收
// ----------------------------------------------------------------------------
// 为什么单独一个文件：`api.test.mjs` 的 PAYR7/PAYR8 验的是"一份单长得对不对"，
// 而打包验的是另一件事 —— **一次出全套时，包里到底有哪几张、每张是谁的**。
// 失败形态也完全不同：单份打印错了是"这张纸印错"，打包错了是
// 「这家店的单里夹着那家店的人」或「包里少了一家店」，
// 而这两种都**不会报错**，会在发到店、员工签完字之后才被发现。
//
// ★ 五条必须钉住的性质（对应交付清单里的五条）：
//   PK1 包内文件数 == 该期间有工资条的门店数（空门店不出空文件）
//   PK2 每个文件名含期间与门店名，且不含 / \ : * ? " < > | 与控制字符
//   PK3 解出来的 HTML 与单份接口同源（公司主体、期间、签收栏、合计）
//   PK4 受限角色（A店HR）拿到的包里只有自己范围内的门店
//   PK5 掩码不因"换了个入口"失效（看不到实发的人，包里那份是「—」）
//   另外三条是把"最容易做错的地方"也钉成断言：非法字符门店名、空门店、
//   三个参数/状态错各有业务码（PK6–PK8）。
//
// ★ 本文件自带一个 zip 读侧：**打包件必须能被真正解出来**才算过。
//   写侧（app/zip.mjs）的断言如果只比"我生成了几段字节"，那是自己跟自己对答案；
//   这里按中央目录读回每个文件、校验 CRC（用一段形状不同的 CRC 实现，
//   不是复用 app/zip.mjs 的那个表），再比内容。
// ============================================================================
import { createApp } from '../app/server.mjs';
import { inflateRawSync } from 'node:zlib';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok: !!ok, note });

// ★ 这个 env 必须在 createApp 之前设（登录路由读进程环境），与 api.test.mjs 同。
process.env.TRUST_PROXY = '1';
const { server, db } = await createApp();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const PWD = 'demo1234';
const login = async (u, pwd = PWD) => {
  const r = await fetch(`${BASE}/login?user=${u}&pwd=${encodeURIComponent(pwd)}`, { method: 'POST' });
  return (await r.json()).token || null;
};
const getJson = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : null };
};
const getText = async (path, token) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, text: await r.text() };
};

// ---------------------------------------------------------------------------
// zip 读侧（测试自带，见文件头最后一段）
// ---------------------------------------------------------------------------
const CRC_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** 独立的 CRC32（逐位算，不建表）—— 用来验证写侧的 CRC 是对的 */
function crc32Slow(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 读 zip：返回 Map<文件名, { text, crcOk }>。
 * 只认 store / deflate 两种方式 —— 与写侧一致，不是"通用 unzip"。
 */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录（EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CRC_SIG) throw new Error('中央目录条目损坏');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(offset) !== 0x04034b50) throw new Error(`本地文件头损坏：${name}`);
    const lNameLen = buf.readUInt16LE(offset + 26);
    const lExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
    out.set(name, { text: data.toString('utf8'), crcOk: crc32Slow(data) === crc });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const packOf = async (period, token, per = 1) => {
  const r = await fetch(`${BASE}/api/payroll/payslip-pack?period=${encodeURIComponent(period)}&per=${per}`,
    { headers: { authorization: `Bearer ${token}` } });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('zip')) {
    return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : null, files: null };
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, body: null, buf, files: unzip(buf) };
};

// ---------------------------------------------------------------------------
// 夹具：只写数据，不动权限配置（与 perm-matrix 同一条自我约束）
// ---------------------------------------------------------------------------
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

// 法人主档：打印件表头的"公司主体"从主档来（MO7 的教训），
// 没有它表头会落成"法人 #1" —— 那时 PK3 比的就不是主体，而是兜底串。
await fx('legal_entity 1（工资单表头的公司主体）', `
  INSERT INTO legal_entity(id,name,credit_code,address,legal_rep,stamp_name) VALUES
    (1,'示例餐饮（上海）有限公司','91310000MA1K000001','上海市黄浦区示例路 1 号','甲','示例餐饮（上海）有限公司')
  ON CONFLICT (id) DO NOTHING`);

// ---- 2026-04：两个新门店，一个名字里全是非法字符、一个有编制有人但该期没有工资条 ----
const BAD_ORG_NAME = 'A/B店:"测试"*?<>|\\';
await fx('org 98 D店（本期无人领薪）/ org 99 非法字符门店名', `
  INSERT INTO org_unit(id,parent_id,name,path) VALUES
    (98,30,'D店（本期无人领薪）','001.030.098'),
    (99,30,$1,'001.030.099')
  ON CONFLICT (id) DO NOTHING`, [BAD_ORG_NAME]);
await fx('person 91（非法字符门店，有工资条）/ person 92（D店，无工资条）', `
  INSERT INTO person(id,full_name) VALUES (91,'钱打包'),(92,'孙空店')
  ON CONFLICT (id) DO NOTHING`);
await fx('成本组织归属 91→99 / 92→98（2026-04 期起）', `
  INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from) VALUES
    (91,'cost_org',99,'2026-04-01'), (92,'cost_org',98,'2026-04-01')`);
await fx('pay_run 2026-04（法人 1）', `
  INSERT INTO pay_run(period,legal_entity_id,status) VALUES ('2026-04',1,'draft')
  ON CONFLICT DO NOTHING`);
await fx('payslip（91 / 2026-04 / 应发 6000 实发 5000）', `
  INSERT INTO payslip(pay_run_id,employee_id,gross_amount,net_amount,si_employee,tax_amount)
  SELECT r.id, 91, 6000, 5000, 750, 250 FROM pay_run r
   WHERE r.period='2026-04' AND r.legal_entity_id=1
     AND NOT EXISTS (SELECT 1 FROM payslip p WHERE p.pay_run_id=r.id AND p.employee_id=91)`);
await fx('payslip_item（91 / 2026-04，明细与合计自洽）', `
  INSERT INTO payslip_item(payslip_id,item_code,amount)
  SELECT p.id, v.code, v.amt FROM payslip p
    JOIN pay_run r ON r.id = p.pay_run_id,
       (VALUES ('BASE',6000),('SI_EMPLOYEE',-750),('IIT',-250)) AS v(code,amt)
   WHERE r.period='2026-04' AND p.employee_id=91
     AND NOT EXISTS (SELECT 1 FROM payslip_item x WHERE x.payslip_id=p.id)`);

const fxFail = fixtures.filter((x) => x.includes('✗'));
rec('FX', '夹具全部建成（建不成会让"包里少一家店"看起来像功能正常）',
  fxFail.length === 0, fxFail.join(' | '));

const t1 = await login(1);   // 集团HR：cost_org 子树 1、发薪法人 1
const t2 = await login(2);   // A店HR：cost_org 只有 10
const t3 = await login(3);   // 无任何授权

// 种子批次的 id 用业务键回查，不写死（IDENTITY 的序列不会因为写死 id 而前进）
const RUN_MAR = Number((await db.query(
  `SELECT id FROM pay_run WHERE period='2026-03' AND legal_entity_id=1 ORDER BY id LIMIT 1`)).rows[0]?.id) || 0;

// ===========================================================================
// PK1 · 包内文件数 == 该期间有工资条的门店数
// ---------------------------------------------------------------------------
// 参照物是**单份打印接口**（同一份 sheet() 出的 groups），不是我自己数的门店：
// 拿组织树去数会得出"3 家店"（A/B/C），而 C 店根本没有工资条。
// ===========================================================================
const pk1 = await packOf('2026-03', t1);
const pr1 = await getJson(`/api/payroll/print?run=${RUN_MAR}`, t1);
{
  const groups = (pr1.body && pr1.body.groups) || [];
  const names = pk1.files ? [...pk1.files.keys()] : [];
  const peopleInHtml = names.reduce((a, n) => a + (pk1.files.get(n).text.match(/员工签收/g) || []).length, 0);
  const people = groups.reduce((a, g) => a + (g.people || []).length, 0);
  rec('PK1', '包内文件数 == 该期间有工资条的门店数（与单份打印的 groups 同源），'
    + '且包里每张单对应一个人（空门店不产生空文件）',
    pk1.status === 200 && groups.length === 2 && names.length === groups.length
    && peopleInHtml === people && people === 2
    && pk1.headers.get('x-pack-files') === String(names.length),
    `HTTP=${pk1.status} 门店=${groups.length} 文件=${names.length} `
    + `人数（print=${people} / 包内签收栏=${peopleInHtml}）`
    + ` 包内=${names.join(' | ') || '(空)'}`);
}

// ===========================================================================
// PK2 · 文件名：一眼看出是哪个门店、哪个期间；且不含非法字符
// ===========================================================================
{
  const names = pk1.files ? [...pk1.files.keys()] : [];
  const orgNames = ((pr1.body && pr1.body.groups) || []).map((g) => g.org_name);
  const illegal = names.filter((n) => /[\\/:*?"<>|\u0000-\u001f\u007f]/.test(n));
  const okPeriod = names.every((n) => n.startsWith('2026-03'));
  const okOrg = orgNames.every((o) => names.some((n) => n.includes(o)));
  const okExt = names.every((n) => n.endsWith('.html'));
  const unique = new Set(names).size === names.length;
  rec('PK2', '每个文件名都含期间与门店名、以 .html 结尾、互不重名，'
    + '且不含 / \\ : * ? " < > | 与控制字符（斜杠留着会在解压时变成子目录，'
    + '于是"文件少了一个"却不报错）',
    names.length > 0 && illegal.length === 0 && okPeriod && okOrg && okExt && unique,
    `文件=${names.join(' | ') || '(空)'} 非法字符=${illegal.length} `
    + `期间前缀=${okPeriod} 含门店名=${okOrg} 唯一=${unique}`);
}

// ===========================================================================
// PK3 · 解出来的 HTML 与单份接口同源
// ---------------------------------------------------------------------------
// 三条关键片段：公司主体（主档）、期间、签收栏。再加合计与页码，
// 这三类东西只要有一处不同源，就说明"打包又拼了一套模板"。
// ★ CRC 一并校验：写侧 CRC 写到压缩数据上，macOS 的 unzip 不报错、
//   Windows 资源管理器直接说"文件已损坏" —— 那种错会在财务的电脑上才暴露。
// ===========================================================================
{
  const one = await getText(`/api/payroll/print.html?run=${RUN_MAR}&org=10`, t1);
  const name = pk1.files ? [...pk1.files.keys()].find((n) => n.includes('A店')) : null;
  const inPack = name ? pk1.files.get(name) : null;
  const co = (h) => (String(h).match(/<div class="co">([^<]*)<\/div>/) || [])[1] || '';
  const crcAllOk = pk1.files ? [...pk1.files.values()].every((f) => f.crcOk) : false;
  rec('PK3', '解出来的 HTML 与单份接口同源：公司主体（取法人主档的盖章名）、期间、'
    + '员工签收/公司盖章、应发合计/实发合计 都在；且每个条目的 CRC 与中央目录一致',
    one.status === 200 && !!inPack && crcAllOk
    && co(one.text) === co(inPack.text) && co(inPack.text).length > 0
    && inPack.text.includes('2026-03') && inPack.text.includes('员工签收')
    && inPack.text.includes('公司盖章') && inPack.text.includes('应发合计')
    && inPack.text.includes('实发合计'),
    `单份 HTTP=${one.status} 表头=${co(one.text) || '(空)'} / 包内=${inPack ? co(inPack.text) : '(缺)'} `
    + `CRC 全对=${crcAllOk} A店文件=${name || '(缺)'}`);
}

// ===========================================================================
// PK4 · 受限角色的包里只有自己范围内的门店
// ---------------------------------------------------------------------------
// 这是"打包不能成为权限绕过的口子"的第一条：A 店 HR 的包装里出现 B 店的文件，
// 等于把 B 店的整店薪资交给了他 —— 而他本来连列表都看不到。
// 同时反查一句：B 店的人名与金额也不许出现在包里的任何一份里。
// ===========================================================================
{
  const pk2 = await packOf('2026-03', t2);
  const names = pk2.files ? [...pk2.files.keys()] : [];
  const all = pk2.files ? [...pk2.files.values()].map((f) => f.text).join('\n') : '';
  const bNet = (await db.query(
    `SELECT p.net_amount::text AS net FROM payslip p
       JOIN pay_run r ON r.id = p.pay_run_id
      WHERE r.period='2026-03' AND p.employee_id=2`)).rows[0]?.net;
  const bName = (await db.query(`SELECT full_name FROM person WHERE id=2`)).rows[0]?.full_name;
  rec('PK4', '行闸（fn_scope_people）：A店HR（cost_org 只有 10）拿到的包里只有 A 店一份，'
    + '不含 B 店的文件名，也不含 B 店员工的人名与实发金额',
    pk2.status === 200 && names.length === 1 && names[0].includes('A店')
    && !names.some((n) => n.includes('B店'))
    && !all.includes('B店') && !!bName && !all.includes(bName)
    && !all.includes(Number(bNet).toFixed(2)),
    `HTTP=${pk2.status} 文件=${names.join(' | ') || '(空)'}；`
    + `B店姓名=${bName} 出现在包内=${all.includes(String(bName))}；`
    + `B店实发=${Number(bNet).toFixed(2)} 出现在包内=${all.includes(Number(bNet).toFixed(2))}`);
}

// ===========================================================================
// PK5 · 掩码不因入口而失效
// ---------------------------------------------------------------------------
// 场景是 export（页面是 list）：一个人"看不到实发"这件事，
// 不该因为换了个下载按钮就变可见。★ 同时要证"null 来自策略不是缺数据"：
// 集团HR 那份是数值（export 档配了 visible），A店HR 那份是「—」。
// ===========================================================================
{
  const pkG = await packOf('2026-03', t1);
  const pkA = await packOf('2026-03', t2);
  const htmlOf = (pk, key) => {
    if (!pk.files) return '';
    const n = [...pk.files.keys()].find((x) => x.includes(key));
    return n ? pk.files.get(n).text : '';
  };
  const gA = htmlOf(pkG, 'A店');
  const aA = htmlOf(pkA, 'A店');
  const maskedBar = /实发合计 <b>—<\/b>/.test(aA);
  const moneyBar = /实发合计 <b>6,?500\.00<\/b>/.test(gA);
  const leak = /6,?500\.00/.test(aA);
  rec('PK5', '字段掩码（fn_field_action，场景 export）：看不到实发的人，'
    + '包里那份的实发是「—」而不是 0.00 也不是真值；看得到的人那份是真值',
    !!gA && !!aA && maskedBar && moneyBar && !leak
    && !/实发合计 <b>0\.00<\/b>/.test(aA),
    `集团HR 那份=${(gA.match(/实发合计 <b>([^<]*)<\/b>/) || [])[1] || '(缺)'} `
    + `A店HR 那份=${(aA.match(/实发合计 <b>([^<]*)<\/b>/) || [])[1] || '(缺)'} `
    + `真值泄漏=${leak}`);
}

// ===========================================================================
// PK6 · 三个错各有名字，都不落 500
// ---------------------------------------------------------------------------
// 合成一个码的后果：看到 422 的人会去改参数，看到 409 的人会去算薪，
// 而"这一期没算过薪"和"我的范围里没有门店"该做的事完全不同。
// ===========================================================================
{
  const bad1 = await packOf('2026-13', t1);        // 月份 13
  const bad2 = await packOf('2026-3', t1);         // 不是 YYYY-MM
  const bad3 = await packOf('', t1);               // 没传
  const noRun = await packOf('2025-01', t1);       // 该期间没有批次
  const denied = await packOf('2026-03', t3);      // 无授权
  const codes = [bad1, bad2, bad3, noRun, denied].map((x) => `${x.status}/${x.body?.error}`);
  rec('PK6', '参数与状态错各有业务码：期间格式不对 → 422 E_PACK_PERIOD（三种写法都要拦）、'
    + '该期间没有批次 → 409 E_PACK_NO_RUN、无授权账号 → 403（都不许落 500）',
    bad1.status === 422 && bad1.body?.error === 'E_PACK_PERIOD'
    && bad2.status === 422 && bad2.body?.error === 'E_PACK_PERIOD'
    && bad3.status === 422 && bad3.body?.error === 'E_PACK_PERIOD'
    && noRun.status === 409 && noRun.body?.error === 'E_PACK_NO_RUN'
    && denied.status === 403,
    codes.join(' '));
}

// ===========================================================================
// PK7 · 门店名里有非法字符：文件名字段被清洗，且**不产生子目录**
// ---------------------------------------------------------------------------
// zip 里 `/` 是路径分隔符。留着它，解压后那家店的文件会落进一个子目录，
// 于是"包里少了一份"——不报错、不告警，只有店长来问才知道。
// ===========================================================================
{
  const pk = await packOf('2026-04', t1);
  const names = pk.files ? [...pk.files.keys()] : [];
  const name = names[0] || '';
  rec('PK7', `门店名含非法字符（${BAD_ORG_NAME}）时，文件名被清洗成合法名字、`
    + '仍含期间与门店名、包里文件数不变（斜杠被替换，不会解成子目录）',
    pk.status === 200 && names.length === 1 && name.startsWith('2026-04')
    && !/[\\/:*?"<>|]/.test(name) && name.includes('测试') && name.endsWith('.html'),
    `HTTP=${pk.status} 文件=${name || '(空)'} 文件数=${names.length}`);
}

// ===========================================================================
// PK8 · 空门店不出文件（有编制、有人，但这一期没有工资条）
// ---------------------------------------------------------------------------
// D店(98) 上挂着一个人，而 2026-04 的批次里只有 99 店那个人的工资条。
// 判据必须是"这个店有没有工资条"，不是"组织树里有没有这个店"——
// 后者会给店长发一张"0 人 0 元"的纸，然后他打电话问财务是不是漏发了。
// ===========================================================================
{
  const pk = await packOf('2026-04', t1);
  const names = pk.files ? [...pk.files.keys()] : [];
  const inDb = (await db.query(
    `SELECT count(*)::int n FROM employee_org_assignment a
      WHERE a.dim_code='cost_org' AND a.org_id=98`)).rows[0].n;
  rec('PK8', '空门店不产生空文件：D店(98) 有人（有归属）但该期没有工资条，'
    + '包里只有 99 店那一份（不是两份、更不是一份 0 人单）',
    pk.status === 200 && inDb > 0 && names.length === 1
    && !names.some((n) => n.includes('D店'))
    && pk.headers.get('x-pack-people') === '1',
    `98 店归属人数=${inDb} 包内=${names.join(' | ') || '(空)'} `
    + `x-pack-people=${pk.headers.get('x-pack-people')}`);
}

// ===========================================================================
// 汇总
// ===========================================================================
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
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.id}  ${r.note}`);
}
console.log(`\n工资单打包 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
