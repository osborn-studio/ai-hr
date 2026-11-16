// Browser contract checks use a local synthetic REST fixture, never an app DB.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
if (!existsSync(resolve(dist, 'index.html'))) throw new Error('先运行npm run build');
const artifacts = fileURLToPath(new URL('../test-artifacts/', import.meta.url)); await mkdir(artifacts, { recursive: true });
const requests = []; let confirmed = false; let scenario = 'hr'; let failBatches = false; let changed = false; let leaveUncertain = true; const leaveCommands = new Map();
const ids = { group: '10', brandA: '101', brandB: '102', ledgerA: '201', ledgerB: '202', root: '1000', companyA: '1001', companyB: '1002', storeA: '1101', storeB: '1201' };
const companies = [
  { id: ids.root, group_id: '10', name: '全虚构测试集团', org_level: 'group', company_kind: 'headquarters', ledger_id: '200' },
  { id: ids.companyA, group_id: '10', name: '虚构甲品牌公司', brand_id: ids.brandA, org_level: 'brand', parent_company_id: ids.root, company_kind: 'headquarters', ledger_id: ids.ledgerA },
  { id: ids.companyB, group_id: '10', name: '虚构乙品牌公司', brand_id: ids.brandB, org_level: 'brand', parent_company_id: ids.root, company_kind: 'headquarters', ledger_id: ids.ledgerB },
  { id: ids.storeA, group_id: '10', name: '虚构甲一店', brand_id: ids.brandA, org_level: 'store', parent_company_id: ids.companyA, company_kind: 'store', ledger_id: ids.ledgerA },
  { id: ids.storeB, group_id: '10', name: '虚构乙一店', brand_id: ids.brandB, org_level: 'store', parent_company_id: ids.companyB, company_kind: 'store', ledger_id: ids.ledgerB },
];
const people = [{ id: '301', group_id: '10', full_name: '岑清沅', person_number: 'TEST-301', status: 'active' }, { id: '302', group_id: '10', full_name: '冉知禾', person_number: 'TEST-302', status: 'active' }];
const employments = [{ id: '401', person_id: '301', company_id: ids.storeA, hire_date: '2026-10-01T00:00:00.000Z', status: 'active', employment_type: 'full_time' }, { id: '402', person_id: '301', company_id: ids.storeB, hire_date: '2026-11-01T00:00:00.000Z', status: 'active', employment_type: 'part_time' }, { id: '403', person_id: '302', company_id: ids.storeA, hire_date: '2026-09-01', leave_date: '2026-10-31', status: 'ended' }];
const rule = { id: '901', name: '全虚构月薪规则', currency: 'CNY', region: 'CN', status: 'approved', rules: [{ code: 'base', name: '基本工资', kind: 'earning', formula: { var: 'base_pay' } }] };
function capabilities() {
  const r = { people_read_all: { can_read: true }, employee_roster: { can_read: true }, people_self: { can_read: true }, ledger: { can_read: true, can_write: true }, payroll_run: { can_read: true, can_write: true }, payroll_slips_read_all: { can_read: true }, attendance_daily: { can_read: true }, advanced_leave_manage: { can_read: true, can_write: true }, advanced_leave_config: { can_read: true, can_write: true }, advanced_leave_self: { can_read: true, can_write: true }, leave_request: { can_read: true }, perf_cycle: { can_read: true } };
  return { profile_code: scenario === 'employee' ? 'store_staff' : 'group_hr_director', resources: r, has_person: true };
}
function descendants(id) { return companies.filter(c => String(c.id) === id || String(c.parent_company_id) === id).map(c => c.id); }
function bootstrap(url) {
  const company = url.searchParams.get('company_id'), ledger = url.searchParams.get('ledger_id');
  const shown = employments.filter(e => (!company || descendants(company).includes(e.company_id)) && (!ledger || companies.find(c => c.id === e.company_id).ledger_id === ledger));
  return { groups: [{ id: '10', name: '全虚构测试集团' }], brands: [{ id: ids.brandA, group_id: '10', name: '虚构甲品牌' }, { id: ids.brandB, group_id: '10', name: '虚构乙品牌' }], companies,
    ledgers: [{ id: '200', group_id: '10', name: '集团帐', scope_mode: 'group' }, { id: ids.ledgerA, group_id: '10', brand_id: ids.brandA, name: '甲品牌帐', scope_mode: 'brand', parent_ledger_id: '200' }, { id: ids.ledgerB, group_id: '10', brand_id: ids.brandB, name: '乙品牌帐', scope_mode: 'brand', parent_ledger_id: '200' }],
    people, employments: shown, departments: [{ id: '501', company_id: ids.storeA, name: '厨房', code: 'KITCHEN' }], assignments: [{ id: '601', employment_id: '401', company_id: ids.storeA, department_id: '501', position_id: '701', valid_from: '2026-10-01', is_primary: true }], positions: [{ id: '701', company_id: ids.storeA, department_id: '501', name: '厨师', code: 'COOK' }], jobs: [], grades: [], counts: { people: people.length, companies: companies.length }, context: { group_id: '10', ledger_id: ledger || null, company_id: company || null }, capabilities: { can_write: true } };
}
const batch = () => ({ id: '1', label: '全虚构10月工资', period: '2026-10', currency: 'CNY', region_code: 'CN', status: confirmed ? 'confirmed' : 'draft', kind: 'calculated', ruleset_id: '901', row_count: 25, scope_complete: true });
const salaryRows = () => Array.from({ length: 25 }, (_, i) => ({ id: String(800 + i), full_name: i === 0 ? '岑清沅' : `全虚构人员${i}`, person_number: `TEST-${i}`, person_id: i === 0 ? '301' : null, company_id: ids.storeA, company_name: '虚构甲一店', source_key: `fixture-${i}`, source_data: { source_totals: { net_pay: '1000.05' } }, validation: { ok: true, issues: [] }, effective_inputs: { base_pay: '1000.05' }, result: { totals: { net_pay: '1000.05' }, items: [{ code: 'base', name: '基本工资', kind: 'earning', amount: '1000.05' }] } }));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture.local'); let body = '';
  for await (const chunk of req) body += chunk;
  requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), method: req.method, authorization: req.headers.authorization, idempotency: req.headers['idempotency-key'], body: body ? JSON.parse(body) : undefined });
  const json = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/login') return json({ token: 'fixture-session' });
  if (url.pathname.startsWith('/api/')) {
    if (req.headers.authorization !== 'Bearer fixture-session') return json({ error: 'E_UNAUTHENTICATED' }, 401);
    if (url.pathname === '/api/me/password') { changed = true; return json({changed:true}); }
    if (url.pathname === '/api/me' && scenario === 'must-change' && !changed) return json({error:'E_PWD_CHANGE_REQUIRED',message:'请先更新密码'},428);
    if (url.pathname === '/api/me') return json({ id:'1', name: '全虚构HR', login: 'fixture-user', role: '测试角色', today: '2026-11-17', tz: 'Asia/Shanghai' });
    if (url.pathname === '/api/me/capabilities') return json(capabilities());
    if (url.pathname === '/api/me/logout') return json({ revoked: true });
    if (url.pathname === '/api/v2/query/leave.workspace') {
      const input = body ? JSON.parse(body) : {};
      const capabilities = { can_configure: true, can_manage: true, can_approve: true, can_self: true, can_payroll: false };
      const schemes = [{ id: '10012', code: 'annual', name: '香港虚构年假政策', status: 'published', unit: 'day', jurisdiction: 'HK', version: 1 }, { id: '10011', code: 'annual', name: '虚构年假政策', status: 'published', unit: 'day', jurisdiction: 'CN', version: 1 }];
      if (input.account_id) return json({ account: { id: '10001', code: 'annual', unit: 'day', revision: 1, group_id: '10', person_id: '301', relationship_id: '11001', jurisdiction: 'CN', employments: [employments[0]] }, totals: { available: '5.0000', held: '0', allocated: '0', taken: '0' }, lots: [{ id: '12001', stable_key: 'TEST-LEAVE-1', entitlement_year: 2026, valid_from: '2026-01-01', granted: '5.0000', available: '5.0000', expiry_state: 'active' }], requests: [...leaveCommands.values()].map(r=>r.request), schemes, capabilities, adjustments: [], payroll_obligations: [] });
      const allAccounts = Array.from({ length: 25 }, (_, i) => ({ id: String(10001 + i), full_name: i === 0 ? '岑清沅' : `虚构假期人员${i}`, person_number: i === 0 ? 'TEST-301' : `TEST-L${i}`, code: 'annual', unit: 'day', jurisdiction: 'CN', company_name: '虚构甲一店', available: '5.0000', held: '0', allocated: '0', taken: '0' }));
      const allRelationships = allAccounts.map((a, i) => ({ id: String(11001 + i), full_name: a.full_name, person_number: a.person_number, jurisdiction: 'CN', valid_from: '2026-01-01' }));
      const rows = (input.view === 'relationships' ? allRelationships : allAccounts).filter(a => !input.q || `${a.full_name} ${a.person_number}`.includes(input.q));
      const size = input.pageSize || 10, page = Math.max(1, Math.min(input.page || 1, Math.ceil(rows.length / size) || 1));
      const shown = rows.slice((page - 1) * size, page * size);
      return json(input.view === 'relationships' ? { accounts: [], relationships: shown, relationship_total: rows.length, relationship_page: page, relationship_page_size: size, schemes, capabilities, requests: [], total: 0 } : { accounts: shown, schemes, capabilities, requests: [], page, page_size: size, total: rows.length });
    }
    if (url.pathname === '/api/v2/command/leave.request.submit') {
      const input = JSON.parse(body), key = req.headers['idempotency-key'];
      if (!leaveCommands.has(key)) leaveCommands.set(key, { request: { id: '13001', starts_at: input.starts_at, ends_at: input.ends_at, quantity: '1.0000', status: 'pending', created_by: '1' } });
      if (leaveUncertain) { leaveUncertain = false; return json({ error: 'E_TEST_UNKNOWN', message: '全虚构未知结果测试' }, 503); }
      return json(leaveCommands.get(key));
    }
    if (url.pathname === '/api/foundation/bootstrap') return json(bootstrap(url));
    if (url.pathname === '/api/foundation/people/301/timeline') return json({ person: people[0], employments: employments.filter(e => e.person_id === '301').map(e => ({ ...e, company_name: companies.find(c => c.id === e.company_id).name, assignments: [] })) });
    if (url.pathname === '/api/customer-payroll/batches') return failBatches ? json({ error: 'E_TEST_DENIED', message: '全虚构权限异常测试' }, 403) : json({ batches: [batch()] });
    if (url.pathname === '/api/customer-payroll/rules') return json({ rulesets: [rule] });
    if (url.pathname.endsWith('/report')) return json({ batch: batch(), rows: salaryRows(), summary: { net_pay: '25001.25', employee_contribution: '0.00' }, scope_complete: true, notice: '全虚构接口测试资料' });
    if (url.pathname.endsWith('/confirm')) { confirmed = true; return json({ batch: batch(), ok: true }); }
    if (url.pathname.endsWith('/calculate') || url.pathname.endsWith('/validate')) return json({ ok: true, checks: [] });
    if (url.pathname.endsWith('/export.csv')) { res.writeHead(200, { 'content-type': 'text/csv' }); return res.end('fixture,amount\nTEST,1000.05\n'); }
    return json({ error: 'E_FIXTURE_ROUTE_MISSING' }, 404);
  }
  const file = url.pathname.startsWith('/assets/') ? resolve(dist, '.' + url.pathname) : resolve(dist, 'index.html');
  if (!file.startsWith(dist)) { res.writeHead(404); return res.end(); }
  try { const data = await readFile(file); res.writeHead(200, { 'content-type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(file)] || 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.CHROME_BIN || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', chromium.executablePath()].find(existsSync);
if (!executablePath) { server.close(); throw new Error('缺少可用的隔离无头Chrome/Chromium，不将界面测试标记通过'); }
const browser = await chromium.launch({ executablePath, headless: true }); const checks = []; const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin); await page.getByLabel('账号', { exact: true }).fill('fixture-user'); await page.getByLabel('密码', { exact: true }).fill('fixture-secret'); await page.getByRole('button', { name: '进入工作台' }).click();
  await page.getByRole('heading', { name: /工作从这里开始/ }).waitFor(); checks.push('named login, identity, capabilities and authorized bootstrap');
  assert.equal(requests.find(r => r.path === '/login').body.login, 'fixture-user'); assert.ok(requests.filter(r => r.path.startsWith('/api/')).every(r => r.authorization === 'Bearer fixture-session'));
  await page.screenshot({ path: resolve(artifacts, 'pc-workspace.png'), fullPage: true });
  await page.getByRole('button', { name: '查找功能与页面' }).click(); await page.getByLabel('全局功能搜索').fill('花名册'); await page.getByRole('button', { name: /人事花名册.*打开/ }).click();
  await page.getByRole('heading', { name: '人事花名册', exact: true }).waitFor(); await page.getByRole('button', { name: /岑清沅.*TEST-301/ }).click();
  await page.getByRole('heading', { name: '员工全貌' }).waitFor(); await page.getByRole('heading', { name: '虚构甲一店' }).waitFor(); await page.getByRole('heading', { name: '虚构乙一店' }).waitFor(); checks.push('global functional search, roster and permanent-person cross-brand timeline');
  await page.getByLabel('选择品牌').selectOption(ids.brandA); await page.getByLabel('选择门店').selectOption(ids.storeA);
  await page.waitForFunction(() => document.querySelector('[aria-label="选择门店"]').value === '1101');
  assert.ok(requests.some(r => r.path === '/api/foundation/bootstrap' && r.query.company_id === ids.companyA)); assert.ok(requests.some(r => r.path === '/api/foundation/bootstrap' && r.query.company_id === ids.storeA)); checks.push('brand and store resolve to real server-side scope parameters');
  await page.getByLabel('选择品牌').selectOption(''); await page.waitForTimeout(80); await page.evaluate(() => location.hash = 'payroll');
  await page.getByRole('button', { name: '进入核算 →' }).click(); await page.getByRole('heading', { name: '全虚构10月工资' }).waitFor();
  assert.equal(await page.locator('table tbody tr').count(), 10); await page.getByRole('button', { name: '下一页', exact: true }).click(); assert.equal(await page.locator('table tbody tr').count(), 10);
  await page.getByRole('searchbox').fill('全虚构人员24'); assert.equal(await page.locator('table tbody tr').count(), 1); await page.getByRole('searchbox').fill(''); checks.push('loaded authorized table paging and whole-set fuzzy search');
  await page.getByRole('button', { name: '按规则试算' }).click(); await page.getByRole('button', { name: '开始试算' }).click(); await page.getByRole('heading', { name: '全虚构10月工资' }).waitFor();
  await page.getByRole('button', { name: '复核并确认' }).click(); assert.equal(await page.getByRole('button', { name: '确认并锁定', exact: true }).isDisabled(), true); await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '确认并锁定', exact: true }).click();
  await page.getByText('已确认', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '按规则试算' }).isDisabled(), true); checks.push('real calculate/confirm HTTP calls, explicit acknowledgment and confirmed-state controls');
  await page.screenshot({ path: resolve(artifacts, 'pc-payroll.png'), fullPage: true });
  await page.evaluate(() => location.hash = 'attendance/daily'); await page.getByRole('heading', { name: '页面接入开发中' }).waitFor(); checks.push('unimplemented feature explicitly unavailable, no fabricated results');
  await page.evaluate(() => location.hash = 'attendance/leave'); await page.getByRole('heading', { name: '假期台账', exact: true }).waitFor();
  assert.equal(await page.locator('main table').count(), 1); assert.equal(await page.locator('main table tbody tr').count(), 10); await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.getByText('虚构假期人员10 · 虚构年假政策', { exact: true }).waitFor();
  assert.ok(requests.some(r => r.path.endsWith('/leave.workspace') && r.body.view === 'accounts' && r.body.page === 2 && r.body.pageSize === 10));
  await page.getByRole('button', { name: '实际关系', exact: true }).click(); await page.getByRole('heading', { name: '已核实实际关系' }).waitFor(); await page.getByRole('cell', { name: '岑清沅', exact: true }).waitFor(); assert.equal(await page.locator('main table').count(), 1); assert.equal(await page.locator('main table tbody tr').count(), 10);
  await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.getByRole('cell', { name: '虚构假期人员10', exact: true }).waitFor();
  await page.getByRole('searchbox', { name: '搜索假期人员' }).fill('TEST-L24'); await page.getByRole('button', { name: '搜索', exact: true }).click(); await page.getByRole('cell', { name: 'TEST-L24', exact: true }).waitFor(); assert.equal(await page.locator('main table tbody tr').count(), 1);
  assert.ok(requests.some(r => r.path.endsWith('/leave.workspace') && r.body.view === 'relationships' && r.body.page === 2)); assert.ok(requests.some(r => r.body?.view === 'relationships' && r.body.q === 'TEST-L24' && r.body.page === 1));
  await page.getByRole('searchbox', { name: '搜索假期人员' }).fill(''); await page.getByRole('button', { name: '搜索', exact: true }).click(); await page.getByRole('button', { name: '假期账户', exact: true }).click(); await page.getByText('岑清沅 · 虚构年假政策', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(artifacts, 'pc-leave-tabs.png'), fullPage: true }); checks.push('leave account/relationship tabs show one table, both page and search on server');
  await page.getByRole('button', { name: '进入台账 →' }).first().click();
  await page.getByRole('button', { name: '发起请假', exact: true }).click(); await page.getByLabel('适用政策', { exact: true }).selectOption('10011'); await page.getByLabel('本次办理公司关系', { exact: true }).selectOption('401'); await page.getByLabel('开始时间（内地 / 香港时间）').fill('2026-11-20T09:00'); await page.getByLabel('结束时间（内地 / 香港时间）').fill('2026-11-20T17:00'); await page.getByRole('button', { name: '提交申请', exact: true }).click();
  await page.getByText(/全虚构未知结果测试/).first().waitFor(); await page.getByRole('button', { name: '提交申请', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const submissions = requests.filter(r => r.path === '/api/v2/command/leave.request.submit'); assert.equal(submissions.length, 2); assert.ok(submissions[0].idempotency); assert.equal(submissions[0].idempotency, submissions[1].idempotency); assert.deepEqual(submissions[0].body, submissions[1].body); checks.push('leave authorized account/form and uncertain-command retry keep identical UUID and payload');
  failBatches = true; await page.evaluate(() => location.hash = 'payroll'); await page.getByRole('heading', { name: '暂无访问权限' }).waitFor(); await page.getByText('全虚构权限异常测试', { exact: true }).waitFor(); failBatches = false; checks.push('business 403 code/message and retry state');
  assert.equal(await page.locator('iframe').count(), 0); checks.push('React workspace contains no legacy iframe');
  await page.getByRole('button', { name: '退出登录' }).click(); await page.getByRole('heading', { name: '登录天意工作台' }).waitFor(); assert.ok(requests.some(r => r.path === '/api/me/logout' && r.method === 'POST')); checks.push('server logout and local session clear');
  scenario = 'employee'; const employee = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true }); employee.on('pageerror', e => errors.push(e.message));
  await employee.goto(origin); await employee.getByLabel('账号', { exact: true }).fill('fixture-user'); await employee.getByLabel('密码', { exact: true }).fill('fixture-secret'); await employee.getByRole('button', { name: '进入工作台' }).click(); await employee.getByRole('heading', { name: /工作从这里开始/ }).waitFor();
  const assertMobileClosed = async target => { await target.locator('.sidebar').waitFor({ state: 'hidden' }); assert.equal(await target.getByRole('button', { name: '打开业务导航' }).getAttribute('aria-expanded'), 'false'); const rect = await target.locator('.workspace-main').boundingBox(); assert.equal(rect.x, 0); assert.equal(Math.round(rect.width), 390); assert.equal(await target.evaluate(() => document.documentElement.scrollWidth > innerWidth), false); };
  await assertMobileClosed(employee); await employee.screenshot({ path: resolve(artifacts, 'mobile-workspace.png'), fullPage: true }); checks.push('fresh mobile login hides drawer visually and from focus/reading order, content full width');
  await employee.getByRole('button', { name: '打开业务导航' }).click(); await employee.getByRole('navigation', { name: '业务导航' }).waitFor(); assert.equal(await employee.getByRole('button', { name: '薪酬管理', exact: true }).count(), 0); await employee.getByRole('button', { name: '关闭业务导航', exact: true }).click(); await assertMobileClosed(employee);
  await employee.getByRole('button', { name: '打开业务导航' }).click(); await employee.getByRole('button', { name: '我的工作台', exact: true }).click(); await assertMobileClosed(employee);
  await employee.getByRole('button', { name: '打开业务导航' }).click(); await employee.setViewportSize({ width: 1440, height: 1050 }); await employee.setViewportSize({ width: 390, height: 844 }); await assertMobileClosed(employee); await employee.screenshot({ path: resolve(artifacts, 'mobile-after-resize.png'), fullPage: true });
  await employee.getByRole('button', { name: '打开业务导航' }).click(); await employee.getByRole('button', { name: '关闭导航遮罩', exact: true }).click({ position: { x: 380, y: 500 } }); await assertMobileClosed(employee); checks.push('drawer explicit close, same-route choice, backdrop, desktop-to-mobile resize all close reliably');
  await employee.evaluate(() => location.hash = 'payroll'); await employee.getByRole('heading', { name: '暂无访问权限' }).waitFor(); checks.push('mobile drawer, no horizontal overflow, restricted role and direct-route denial');
  scenario = 'must-change'; const initial = await browser.newPage({ viewport:{width:1000,height:900} }); initial.on('pageerror',e=>errors.push(e.message)); await initial.goto(origin); await initial.getByLabel('账号',{exact:true}).fill('fixture-user'); await initial.getByLabel('密码',{exact:true}).fill('fixture-secret'); await initial.getByRole('button',{name:'进入工作台'}).click(); await initial.getByRole('heading',{name:'请先更新登录密码'}).waitFor(); await initial.getByLabel('当前密码',{exact:true}).fill('fixture-secret'); await initial.getByLabel('新密码',{exact:true}).fill('fixture-new-secret'); await initial.getByLabel('确认新密码',{exact:true}).fill('fixture-new-secret'); await initial.getByRole('button',{name:'更新密码并继续'}).click(); await initial.getByRole('heading',{name:/工作从这里开始/}).waitFor(); const changedRequest=requests.find(r=>r.path==='/api/me/password'); assert.equal(changedRequest.method,'POST'); assert.equal(Object.keys(changedRequest.query).length,0); assert.ok(changedRequest.body.newPassword); checks.push('428 initial-password change uses JSON body and resumes same-session workspace');
  assert.deepEqual(errors, []); checks.push('no uncaught browser exceptions');
  await readFile(resolve(dist, 'index.html')); console.log(JSON.stringify({ status: 'passed', scope: 'synthetic REST browser contract, not live app/DB acceptance', checks: checks.length, results: checks, artifacts }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
