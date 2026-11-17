import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrontendHandler } from '../app/frontend-static.mjs';
import { createBrokerApp } from '../app/broker-app.mjs';
import { portError } from '../app/domain-port.mjs';

async function buildFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tyhr-build-test-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>天意人力资源系统</title><div id="root"></div><script type="module" src="/assets/app-test.js"></script>');
  await writeFile(join(directory, 'assets/app-test.js'), 'document.getElementById("root").textContent="React build fixture";');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('one Node serves SPA root and immutable assets with a restrictive script policy', async t => {
  const directory = await buildFixture(t);
  const serve = createFrontendHandler(directory);
  const server = createServer(async (req, res) => { if (!await serve(req, res)) { res.writeHead(404); res.end('not a frontend route'); } });
  const url = await listen(t, server);
  const home = await fetch(url+'/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /天意人力资源系统/);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.match(home.headers.get('content-security-policy'), /script-src 'self';/);
  assert.doesNotMatch(home.headers.get('content-security-policy'), /unsafe-eval/);
  const asset = await fetch(url+'/assets/app-test.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(url+'/app/people')).status, 200);
  const head = await fetch(url+'/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('missing assets and API paths never receive successful HTML; build symlinks cannot escape', async t => {
  const directory = await buildFixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'tyhr-outside-test-'));
  await writeFile(join(outside, 'private.txt'), 'private-test-marker');
  await symlink(join(outside, 'private.txt'), join(directory, 'assets/escape.txt'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const serve = createFrontendHandler(directory);
  const server = createServer(async (req, res) => { if (!await serve(req, res)) { res.writeHead(404); res.end('not available'); } });
  const url = await listen(t, server);
  for (const path of ['/api/not-found', '/assets/missing.js', '/assets/escape.txt', '/assets/%5cprivate.txt']) {
    const response = await fetch(url+path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /private-test-marker|<div id="root"/);
  }
});

async function brokerFixture(t) {
  const directory = await buildFixture(t);
  const calls = [];
  const broker = {
    initialize: async () => ({ protocol: 'tyhr-domain-port/1' }),
    call: async (kind, name, input, context, operationId) => {
      calls.push({ kind, name, input, context, operationId });
      if (name === 'auth.login') return { token: 'fixture-session-token', expires_at: '2099-01-01' };
      if (name === 'auth.session') return context.sessionToken === 'fixture-session-token' ? { status: 'ok', userId: 7 } : { status: 'revoked' };
      if (name === 'auth.me') return { id: context.userId, name: '演示测试人员' };
      if (name === 'auth.capabilities') return { profile_code: 'demo', resources: {} };
      if (name === 'foundation.bootstrap') return { groups: [{ id: 1, name: '虚构集团' }], actor: context.userId };
      if (name === 'leave.adjustment.apply') return { adjustment: { id: input.id, status: 'applied' }, operation: operationId };
      if(name==='system.file.upload')return{byte_length:Buffer.from(input.content_base64,'base64').length};
      if (name === 'auth.logout') return { revoked: true };
      throw portError('E_OPERATION_NOT_AVAILABLE', '测试适配器未配置此操作', 503);
    },
  };
  const app = await createBrokerApp({ frontendDir: directory }, { broker });
  return { calls, url: await listen(t, app.server) };
}
const headers = { authorization: 'Bearer fixture-session-token', 'content-type': 'application/json' };

test('broker HTTP mode starts with no local DB and binds current session for real REST queries', async t => {
  const { url, calls } = await brokerFixture(t);
  assert.equal((await fetch(url+'/livez')).status, 200);
  assert.equal((await fetch(url+'/readyz')).status, 200);
  assert.equal((await fetch(url+'/')).status, 200);
  assert.equal((await fetch(url+'/api/foundation/bootstrap')).status, 401);
  const login = await fetch(url+'/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'test-user', password: 'fixture-only' }) });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).token, 'fixture-session-token');
  const response = await fetch(url+'/api/foundation/bootstrap?group_id=1', { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).actor, 7);
  const call = calls.find(c => c.name === 'foundation.bootstrap');
  assert.equal(call.context.userId, 7);
  assert.equal(call.input.group_id, '1');
  assert.equal((await fetch(url+'/api/me', { headers: { authorization: 'Bearer revoked-token' } })).status, 401);
});

test('broker HTTP commands require stable operation IDs and reject client actor substitution', async t => {
  const { url, calls } = await brokerFixture(t);
  const send = (path, input, extra = {}) => fetch(url+path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(input) });
  const path = '/api/v2/command/leave.adjustment.apply';
  assert.equal((await send(path, { id: 10 })).status, 422);
  assert.equal((await send(path, { id: 10, userId: 99 }, { 'idempotency-key': 'stable-test-0001' })).status, 403);
  const response = await send(path, { id: 10 }, { 'idempotency-key': 'stable-test-0001' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).operation, 'stable-test-0001');
  const writes = calls.filter(c => c.name === 'leave.adjustment.apply');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].context.userId, 7);
  const unknown = await send('/api/v2/command/sql.execute', { sql: 'select private' }, { 'idempotency-key': 'stable-test-0002' });
  assert.equal(unknown.status, 404);
  assert.equal(calls.some(c => c.name === 'sql.execute'), false);
});

test('broker capability failure prevents creation of an accepting server', async t => {
  const directory = await buildFixture(t);
  await assert.rejects(createBrokerApp({ frontendDir: directory }, { broker: { initialize: async () => { throw portError('E_BROKER_CAPABILITY', 'missing atomic contract', 503); } } }), { code: 'E_BROKER_CAPABILITY' });
});


test('Broker HTTP accepts the full original upload and keeps smaller ordinary command limits',async t=>{
 const{url,calls}=await brokerFixture(t),bytes=Buffer.alloc(8*1024*1024,65),send=(name,input)=>fetch(url+'/api/v2/command/'+name,{method:'POST',headers:{...headers,'Idempotency-Key':'ORIGINAL-HTTP-BOUNDED-KEY'},body:JSON.stringify(input)});
 const upload=await send('system.file.upload',{content_base64:bytes.toString('base64'),filename:'owned-original.pdf'});assert.equal(upload.status,200);assert.equal((await upload.json()).byte_length,bytes.length);assert.equal(calls.filter(x=>x.name==='system.file.upload').length,1);
 const ordinary=await send('leave.adjustment.apply',{id:10,reason:'x'.repeat(1024*1024)});assert.equal(ordinary.status,413);assert.equal(calls.filter(x=>x.name==='leave.adjustment.apply').length,0);
 const tooLarge=await send('system.file.upload',{content_base64:'x'.repeat(13*1024*1024)});assert.equal(tooLarge.status,413);assert.equal(calls.filter(x=>x.name==='system.file.upload').length,1);
});
test('Broker callback without a local transaction backend never acknowledges a provider event',async t=>{const{url,calls}=await brokerFixture(t),response=await fetch(url+'/api/integrations/callback/1');assert.equal(response.status,503);assert.equal((await response.json()).error,'E_CALLBACK_BACKEND_REQUIRED');assert.equal(calls.length,0);});
