import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBrokerClient, createDomainPort, DOMAIN_PROTOCOL } from '../app/domain-port.mjs';
import { withTx } from '../app/db.mjs';
import { cloudConfiguration } from '../app/cloud-server.mjs';

test('cloud requires an explicit persistent data choice, rejects physical multi-library and production WASM', () => {
  assert.throws(() => cloudConfiguration({}), /显式配置/);
  assert.equal(cloudConfiguration({ DATABASE_URL: 'postgres://example.invalid/test' }).mode, 'postgres');
  assert.throws(() => cloudConfiguration({ TYHR_DATA_MODE: 'postgres' }), /DATABASE_URL/);
  assert.throws(() => cloudConfiguration({ TYHR_DATA_MODE: 'pglite_demo', NODE_ENV: 'production' }), /隔离演示/);
  assert.throws(() => cloudConfiguration({ TYHR_DATA_MODE: 'pglite_demo', CONTROL_URL: 'postgres://example.invalid/test' }), /逻辑帐套/);
  assert.throws(() => cloudConfiguration({ TYHR_DATA_MODE: 'broker', DATABASE_URL: 'postgres://example.invalid/test' }), /同时配置/);
});

test('domain registry binds identity, action kind and caller transaction; no arbitrary SQL endpoint', async () => {
  const tx = { marker: 'same-connection' };
  let called = 0;
  const port = createDomainPort({ operations: {
    'sample.read': { kind: 'query', run: async (actualTx, input, context) => { called++; assert.equal(actualTx, tx); return { actor: context.userId, value: input.value }; } },
    'sample.write': { kind: 'command', run: async (_, input, context) => ({ operation: context.operationId, value: input.value }) },
  }});
  assert.deepEqual(await port.queryView('sample.read', { value: 5 }, { userId: 12 }, { tx }), { actor: 12, value: 5 });
  for (const field of ['userId', 'actor_id', 'roles', 'grants', 'sessionToken']) {
    await assert.rejects(port.queryView('sample.read', { [field]: 99 }, { userId: 12 }, { tx }), { code: 'E_PORT_ACTOR_OVERRIDE' });
  }
  await assert.rejects(port.queryView('sql.query', { sql: 'select secret' }, { userId: 12 }, { tx }), { code: 'E_OPERATION_NOT_FOUND' });
  await assert.rejects(port.queryView('sample.write', {}, { userId: 12 }, { tx }), { code: 'E_OPERATION_NOT_FOUND' });
  await assert.rejects(port.queryView('sample.read', {}, { userId: 0 }, { tx }), { code: 'E_PORT_IDENTITY' });
  await assert.rejects(port.executeCommand('sample.write', {}, { userId: 12 }, { tx }), { code: 'E_IDEMPOTENCY_REQUIRED' });
  assert.deepEqual(await port.executeCommand('sample.write', { value: 2 }, { userId: 12 }, { tx, operationId: 'stable-0001' }), { operation: 'stable-0001', value: 2 });
  assert.equal(called, 1);
});

test('PostgreSQL session initialization failures release the checked-out connection', async () => {
  let released = 0;
  let began = false;
  const db = { driver: 'pg', _checkout: async () => ({
    query: async sql => { if (sql.includes('app_init_session')) throw new Error('session initialization failure'); if (sql === 'BEGIN') began = true; },
    release: () => released++,
  }) };
  await assert.rejects(withTx(db, async () => 1), /session initialization/);
  assert.equal(released, 1);
  assert.equal(began, false);
});

test('domain failure rolls back before release, commit is never sent', async () => {
  const calls = [];
  const db = { driver: 'pg', _checkout: async () => ({ query: async sql => { calls.push(sql); return { rows: [] }; }, release: () => calls.push('release') }) };
  await assert.rejects(withTx(db, async tx => { await tx.query('write-A'); throw new Error('reject B'); }), /reject B/);
  assert.deepEqual(calls, ['SELECT app_init_session()', 'BEGIN', 'write-A', 'ROLLBACK', 'release']);
});

const caps = { protocol: DOMAIN_PROTOCOL, atomic_commands: true, session_identity: true, scoped_authorization: true, idempotency: true, decimal_strings: true };
async function fakeBroker(t, handler, options = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-only-service-key-1234') { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/capabilities') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(options.capabilities || caps)); }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks).toString()); requests.push(envelope);
    await handler(req, res, envelope);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const broker = createBrokerClient({ capabilitiesUrl: base+'/capabilities', queryUrl: base+'/query', commandUrl: base+'/command', token: 'test-only-service-key-1234', timeoutMs: options.timeoutMs || 1000 });
  return { broker, requests };
}

test('broker contract preserves precise decimal and stable command receipt', async t => {
  const { broker, requests } = await fakeBroker(t, async (req, res, envelope) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { amount: envelope.input.amount }, ...(req.url === '/command' ? { receipt: { atomic: true, operation_id: envelope.operation_id } } : {}) }));
  });
  await broker.initialize();
  const result = await broker.call('command', 'payroll.test', { amount: '9007199254740993.01' }, { userId: 7 }, 'stable-payment-0001');
  assert.equal(result.amount, '9007199254740993.01');
  assert.equal(requests[0].operation_id, 'stable-payment-0001');
  assert.equal(requests[0].context.userId, 7);
  assert.equal(requests[0].protocol, DOMAIN_PROTOCOL);
});

test('non-atomic provider is rejected before any command', async t => {
  const { broker, requests } = await fakeBroker(t, () => {}, { capabilities: { ...caps, atomic_commands: false } });
  await assert.rejects(broker.initialize(), { code: 'E_BROKER_CAPABILITY' });
  await assert.rejects(broker.call('command', 'leave.submit', {}, {}, 'stable-request-001'), { code: 'E_BROKER_NOT_READY' });
  assert.equal(requests.length, 0);
});

test('missing or mismatched command receipt remains unknown, never success or automatic retry', async t => {
  const { broker, requests } = await fakeBroker(t, async (_, res) => res.end(JSON.stringify({ result: { status: 'posted' }, receipt: { atomic: true, operation_id: 'another-operation' } })));
  await broker.initialize();
  await assert.rejects(broker.call('command', 'payroll.confirm', {}, { userId: 7 }, 'original-operation'), { code: 'E_BROKER_EXECUTION_UNKNOWN' });
  assert.equal(requests.length, 1);
});

test('broker timeout yields unknown write and no automatic second write', async t => {
  const { broker, requests } = await fakeBroker(t, async () => {}, { timeoutMs: 50 });
  await broker.initialize();
  await assert.rejects(broker.call('command', 'payroll.confirm', {}, { userId: 7 }, 'stable-slow-command'), { code: 'E_BROKER_EXECUTION_UNKNOWN' });
  assert.equal(requests.length, 1);
});

test('broker requires secure endpoints and credentials outside URLs', () => {
  const values = { capabilitiesUrl: 'https://provider.invalid/cap', queryUrl: 'https://provider.invalid/read', commandUrl: 'https://provider.invalid/write', token: 'test-only-service-key-1234' };
  assert.throws(() => createBrokerClient({ ...values, queryUrl: 'http://provider.invalid/read' }), { code: 'E_BROKER_CONFIG' });
  assert.throws(() => createBrokerClient({ ...values, queryUrl: 'https://user:secret@provider.invalid/read' }), { code: 'E_BROKER_CONFIG' });
  assert.throws(() => createBrokerClient({ ...values, token: '' }), { code: 'E_BROKER_CONFIG' });
});
