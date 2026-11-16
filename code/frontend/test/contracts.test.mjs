import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, withScope } from '../src/api.mjs';
import { amount, brandScope, currentEmployment, leaveAccountName, pageRows, personRows, visibleNavigation } from '../src/domain.mjs';
import { createCommandJournal } from '../src/commands.mjs';

test('login posts named credentials without user-ID substitution; token stays out of URL', async () => {
  let call;
  const api = createApi({ fetchImpl: async (path, init) => { call = { path, init }; return Response.json({ token: 'synthetic-session' }); } });
  await api.login('test-only-login', 'test-only-secret');
  assert.equal(call.path, '/login'); assert.equal(call.init.method, 'POST');
  assert.deepEqual(JSON.parse(call.init.body), { login: 'test-only-login', password: 'test-only-secret' });
  assert.equal(call.init.headers.authorization, undefined);
});
test('authenticated requests use Bearer and preserve explicit command idempotency keys', async () => {
  let call;
  const api = createApi({ token: 'synthetic-session', fetchImpl: async (path, init) => { call = { path, init }; return Response.json({ ok: true }); } });
  await api.request('/api/v2/command/test-only', { method: 'POST', body: { account_id: '9007199254740993' }, headers: { 'Idempotency-Key': 'stable-command-key' } });
  assert.equal(call.init.headers.authorization, 'Bearer synthetic-session');
  assert.equal(call.init.headers['Idempotency-Key'], 'stable-command-key');
  assert.equal(JSON.parse(call.init.body).account_id, '9007199254740993');
});
test('401 expires the current session, while bad login does not produce a spurious expiry callback', async () => {
  let expired = 0;
  const api = createApi({ onUnauthorized: () => expired++, fetchImpl: async () => Response.json({ error: 'E_SESSION_EXPIRED' }, { status: 401 }) });
  await assert.rejects(api.me(), e => e.status === 401 && e.code === 'E_SESSION_EXPIRED'); assert.equal(expired, 1);
  await assert.rejects(api.login('x', 'x')); assert.equal(expired, 1);
});
test('403 preserves business error and does not clear session', async () => {
  let expired = false;
  const api = createApi({ onUnauthorized: () => expired = true, fetchImpl: async () => Response.json({ error: 'E_TY_FORBIDDEN', message: '授权范围不匹配' }, { status: 403 }) });
  await assert.rejects(api.me(), e => e.message === '授权范围不匹配' && e.code === 'E_TY_FORBIDDEN'); assert.equal(expired, false);
});
test('network and non-JSON failures are explicit, not fabricated empty business results', async () => {
  await assert.rejects(createApi({ fetchImpl: async () => { throw new Error('offline'); } }).me(), e => e.code === 'E_NETWORK');
  await assert.rejects(createApi({ fetchImpl: async () => new Response('<html>wrong target</html>') }).me(), e => e.code === 'E_RESPONSE_FORMAT');
});
test('client refuses foreign origins to keep session tokens on the application origin', async () => {
  const api = createApi({ token: 'x', fetchImpl: () => { throw new Error('must not fetch'); } });
  await assert.rejects(api.request('https://example.invalid/api')); await assert.rejects(api.request('//example.invalid/api'));
});
test('scope uses only supported server filters and keeps IDs exact', () => {
  assert.equal(withScope('/api/foundation/bootstrap', { group_id: '9007199254740993', company_id: '18', brand_id: '7', userId: '99' }), '/api/foundation/bootstrap?group_id=9007199254740993&company_id=18');
});
test('brand choice resolves to actual company/ledger scope, and cannot silently pretend client-only scope', () => {
  const data = { companies: [{ id: '5', brand_id: '8', org_level: 'brand' }], ledgers: [{ id: '6', brand_id: '8', scope_mode: 'brand' }] };
  assert.deepEqual(brandScope(data, '1', '8'), { group_id: '1', brand_id: '8', company_id: '5', ledger_id: '6' });
  assert.throws(() => brandScope(data, '1', '404'), /尚未建立/);
});
test('leave date is inclusive, assignment end is exclusive; ISO dates work on first day', () => {
  assert.equal(currentEmployment({ hire_date: '2026-11-01T00:00:00Z', leave_date: '2026-11-17T00:00:00Z' }, '2026-11-01'), true);
  assert.equal(currentEmployment({ hire_date: '2026-11-01', leave_date: '2026-11-17' }, '2026-11-17'), true);
  assert.equal(currentEmployment({ hire_date: '2026-11-01', leave_date: '2026-11-17' }, '2026-11-18'), false);
});
test('roster follows selected authorized company but keeps permanent person and parallel relationship identities', () => {
  const data = { companies: [{ id: '1', parent_company_id: null, ledger_id: '3' }, { id: '2', parent_company_id: '1', ledger_id: '3' }, { id: '9', ledger_id: '8' }], ledgers: [{ id: '3' }, { id: '8' }], people: [{ id: '100', full_name: '测试假名', person_number: 'P-100' }, { id: '101', full_name: '同名假名', person_number: 'P-101' }], employments: [{ id: '20', person_id: '100', company_id: '2', hire_date: '2026-11-01', status: 'active' }, { id: '21', person_id: '100', company_id: '9', hire_date: '2026-11-01', status: 'active' }, { id: '22', person_id: '101', company_id: '9', hire_date: '2026-11-01', status: 'active' }], assignments: [{ id: '7', employment_id: '20', valid_from: '2026-11-01', valid_to: '2026-11-17', department_id: '4' }] };
  const rows = personRows(data, { company_id: '1' }, '2026-11-17'); assert.equal(rows.length, 1); assert.equal(rows[0].id, '100'); assert.equal(rows[0].relationships.length, 1); assert.equal(rows[0].assignments.length, 0);
  assert.equal(personRows(data, {}, '2026-11-17')[0].relationships.length, 2);
});
test('payroll amount formatting never rounds large values through IEEE floating point', () => {
  assert.equal(amount('9007199254740993.05'), '9,007,199,254,740,993.05'); assert.equal(amount('-0.5'), '-0.50'); assert.equal(amount(null), '—');
});
test('search filters the whole loaded authorized set before paging and clamps after narrowing', () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({ id: i, name: `记录${i}` }));
  assert.equal(pageRows(rows, '', 3, 15).rows.length, 1);
  const found = pageRows(rows, '记录30', 3, 15); assert.equal(found.page, 1); assert.equal(found.rows[0].id, 30); assert.equal(found.total, 1);
});
test('admin and employee navigation cannot obtain payroll from a single menu privilege', () => {
  const resources = { payroll_run: { can_read: true, can_write: true }, payroll_slips_read_all: { can_read: true }, ledger: { can_read: true, can_write: true } };
  assert.equal(visibleNavigation({ profile_code: 'config_admin', resources }).some(g => g.id === 'payroll'), false);
  assert.equal(visibleNavigation({ profile_code: 'store_staff', resources }).some(g => g.id === 'payroll'), false);
  assert.equal(visibleNavigation({ resources: { payroll_run: { can_read: true } } }).some(g => g.id === 'payroll'), false);
});
test('system settings and integration settings remain independent navigation entries', () => {
  const groups = visibleNavigation({ profile_code: 'config_admin', resources: { ledger: { can_write: true } } });
  assert.ok(groups.find(g => g.id === 'system')); assert.ok(groups.find(g => g.id === 'integrations'));
});

function storageFixture() { const entries = new Map(); return { getItem: key => entries.get(key) || null, setItem: (key, value) => entries.set(key, value) }; }
test('unknown command survives reload and retries exact frozen body with original UUID', async () => {
  const storage = storageFixture(); const calls = []; let fail = true;
  const api = { request: async (path, init) => { calls.push({ path, ...init }); if (fail) throw Object.assign(new Error('network uncertain'), { status: 0 }); return { request: { id: '501' } }; } };
  const first = createCommandJournal({ api, storage, userId: '1', uuid: () => 'original-uuid' });
  await assert.rejects(first.execute('leave.request.submit', { account_id: '44', scheme_id: '55' })); assert.equal(first.pending()[0].outcome, 'unknown');
  const resumed = createCommandJournal({ api, storage, userId: '1', uuid: () => { throw new Error('must not regenerate'); } });
  fail = false; await resumed.retry('original-uuid');
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']); assert.deepEqual(calls[0].body, calls[1].body); assert.equal(calls[0].body.request_key, 'original-uuid'); assert.equal(resumed.pending().length, 0);
});
test('editing a failed command does not silently mint another operation ID', async () => {
  const journal = createCommandJournal({ api: { request: async () => { throw new Error('unknown'); } }, storage: storageFixture(), userId: '1', uuid: () => 'same-id' });
  await assert.rejects(journal.execute('leave.entitlement.grant', { total: '5' }));
  await assert.rejects(journal.execute('leave.entitlement.grant', { total: '8' }), /原操作号/); assert.equal(journal.pending().length, 1); assert.equal(journal.pending()[0].input.event_key, 'same-id');
  assert.throws(() => journal.discardRejected('same-id'), /结果未知/);
});
test('storage failure prevents sending a mutation whose retry ID could be lost', async () => {
  let called = false;
  const journal = createCommandJournal({ api: { request: async () => { called = true; } }, storage: { getItem: () => null, setItem: () => { throw new Error('quota'); } }, userId: '1', uuid: () => 'id' });
  await assert.rejects(journal.execute('leave.request.submit', {}), /本次未发送/); assert.equal(called, false);
});
test('only explicitly rejected commands can be deliberately closed after business review', async () => {
  const journal = createCommandJournal({ api: { request: async () => { throw Object.assign(new Error('denied'), { status: 403 }); } }, storage: storageFixture(), userId: '1', uuid: () => 'id' });
  await assert.rejects(journal.execute('leave.scheme.publish', { id: '11' })); assert.equal(journal.pending()[0].outcome, 'rejected'); journal.discardRejected('id'); assert.equal(journal.pending().length, 0);
});
test('incorrect old password preserves current session while an expired password-change session still clears it', async () => {
  let expired = 0; let code = 'E_AUTH_BAD_CREDENTIAL';
  const api = createApi({ onUnauthorized: () => expired++, fetchImpl: async () => Response.json({ error: code }, { status: 401 }) });
  await assert.rejects(api.request('/api/me/password', { method: 'POST', body: { oldPassword: 'fixture', newPassword: 'fixture' } })); assert.equal(expired, 0);
  code = 'E_SESSION_EXPIRED'; await assert.rejects(api.request('/api/me/password', { method: 'POST', body: {} })); assert.equal(expired, 1);
});

test('leave policy name respects jurisdiction and unit, and ambiguous versions use the code', () => {
  const schemes = [{ code: 'annual', name: '内地法定年假', jurisdiction: 'CN', unit: 'day' }, { code: 'annual', name: '香港法定年假', jurisdiction: 'HK', unit: 'day' }, { code: 'annual', name: '香港分钟福利', jurisdiction: 'HK', unit: 'minute' }];
  assert.equal(leaveAccountName({ code: 'annual', jurisdiction: 'HK', unit: 'day' }, schemes), '香港法定年假');
  assert.equal(leaveAccountName({ code: 'annual', jurisdiction: 'HK', unit: 'minute' }, schemes), '香港分钟福利');
  assert.equal(leaveAccountName({ code: 'annual', jurisdiction: 'HK', unit: 'day' }, [...schemes, { code: 'annual', name: '另一版本', jurisdiction: 'HK', unit: 'day' }]), 'annual');
});
