import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createBrokerClient, createDomainPort, portError } from './domain-port.mjs';
import { createFrontendHandler, FRONTEND_HEADERS } from './frontend-static.mjs';
import { domainOperations,operationBodyLimit } from './cloud-api.mjs';
import { toHttp } from './errors.mjs';

const json = (res, status, body) => { res.writeHead(status, { ...FRONTEND_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
async function body(req,limit=1024*1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw portError('E_BODY_TOO_LARGE', '请求超过允许大小', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw portError('E_TY_ARGUMENT', '请求须为JSON对象', 422); }
}
function readRoute(url) {
  const query = Object.fromEntries(url.searchParams);
  const aliases = {
    '/api/foundation/bootstrap': 'foundation.bootstrap',
    '/api/customer-payroll/batches': 'payroll.batches',
    '/api/customer-payroll/rules': 'payroll.rules',
    '/api/customer-performance/cycles': 'performance.cycles',
  };
  if (aliases[url.pathname]) return { name: aliases[url.pathname], input: query };
  const person = /^\/api\/foundation\/people\/(\d+)\/timeline$/.exec(url.pathname);
  if (person) return { name: 'foundation.timeline', input: { ...query, person_id: person[1] } };
  const payroll = /^\/api\/customer-payroll\/batches\/(\d+)\/report$/.exec(url.pathname);
  if (payroll) return { name: 'payroll.report', input: { ...query, batch_id: payroll[1] } };
  const perf = /^\/api\/customer-performance\/cycles\/(\d+)\/report$/.exec(url.pathname);
  if (perf) return { name: 'performance.report', input: { ...query, cycle_id: perf[1] } };
  return null;
}

// No PG connection, raw SQL endpoint, child process or hidden in-memory database
// is created in broker mode. The external adapter owns authenticated sessions.
export async function createBrokerApp(config, { broker: suppliedBroker } = {}) {
  const broker = suppliedBroker || createBrokerClient({
    capabilitiesUrl: process.env.TYHR_BROKER_CAPABILITIES_URL,
    queryUrl: process.env.TYHR_BROKER_QUERY_URL,
    commandUrl: process.env.TYHR_BROKER_COMMAND_URL,
    token: process.env.TYHR_BROKER_TOKEN,
    timeoutMs: Number(process.env.TYHR_BROKER_TIMEOUT_MS || 10000),
  });
  await broker.initialize();
  const port = createDomainPort({ broker, operations: domainOperations() });
  const serve = createFrontendHandler(config.frontendDir);
  // Bounded local login burst protection; provider must also enforce account
  // rate limits. Addresses are taken from the socket, not untrusted proxy text.
  const loginAttempts = new Map();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if(url.pathname.startsWith('/auth/sso/'))return url.pathname==='/auth/sso/entrypoints'&&req.method==='GET'?json(res,200,{entries:[]}):json(res,503,{error:'E_SSO_BACKEND_REQUIRED',message:'企业平台登录需由Broker服务端提供身份验证和事务处理器'});
      if(/^\/api\/integrations\/callback\//.test(url.pathname))return json(res,503,{error:'E_CALLBACK_BACKEND_REQUIRED',message:'请将签名回调接入Broker服务端事务处理器'});
      if (url.pathname === '/livez') return json(res, 200, { status: 'alive', mode: 'broker' });
      if (url.pathname === '/readyz') { await broker.initialize(); return json(res, 200, { status: 'ready', mode: 'broker', protocol: 'tyhr-domain-port/1' }); }
      if (await serve(req, res)) return;
      if (url.pathname === '/login' && req.method === 'POST') {
        const address = req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        for (const [key, entry] of loginAttempts) if (now - entry.start > 15 * 60 * 1000) loginAttempts.delete(key);
        if (loginAttempts.size > 10000 && !loginAttempts.has(address)) throw portError('E_RATE_LIMITED', '登录繁忙，请稍后重试', 429);
        const entry = loginAttempts.get(address) || { start: now, count: 0 }; entry.count++; loginAttempts.set(address, entry);
        if (entry.count > 30) throw portError('E_RATE_LIMITED', '登录尝试过于频繁', 429);
        const input = await body(req);
        if (typeof input.login !== 'string' || typeof input.password !== 'string' || input.login.length > 160 || input.password.length > 1024) throw portError('E_TY_ARGUMENT', '请输入有效账号和密码', 422);
        return json(res, 200, await broker.call('command', 'auth.login', { login: input.login, password: input.password }, { source: address }, req.headers['idempotency-key'] || randomUUID()));
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!token || token.length > 4096) throw portError('E_UNAUTHENTICATED', '请先登录', 401);
      const session = await broker.call('query', 'auth.session', {}, { sessionToken: token });
      if (session.status !== 'ok' || !Number.isSafeInteger(session.userId) || session.userId < 1) throw portError('E_UNAUTHENTICATED', '登录已失效，请重新登录', 401);
      const context = { userId: session.userId, sessionToken: token };
      if (session.mustChange && !['/api/me/password', '/api/me/logout'].includes(url.pathname)) throw portError('E_PWD_CHANGE_REQUIRED', '请先修改初始口令', 428);
      if (url.pathname === '/api/me' && req.method === 'GET') return json(res, 200, await broker.call('query', 'auth.me', {}, context));
      if (url.pathname === '/api/me/capabilities' && req.method === 'GET') return json(res, 200, await broker.call('query', 'auth.capabilities', {}, context));
      if (url.pathname === '/api/me/logout' && req.method === 'POST') return json(res, 200, await broker.call('command', 'auth.logout', {}, context, req.headers['idempotency-key'] || randomUUID()));
      if (url.pathname === '/api/me/password' && req.method === 'POST') return json(res, 200, await broker.call('command', 'auth.password', await body(req), context, req.headers['idempotency-key'] || randomUUID()));
      const match = /^\/api\/v2\/(query|command)\/([a-z][a-z0-9._-]{1,100})$/.exec(url.pathname);
      if (match && req.method === 'POST') {
        const input = await body(req,operationBodyLimit(match[1],match[2]));
        const result = match[1] === 'query'
          ? await port.queryView(match[2], input, context)
          : await port.executeCommand(match[2], input, context, { operationId: req.headers['idempotency-key'] || input.client_operation_id });
        return json(res, 200, result);
      }
      const mapped = req.method === 'GET' ? readRoute(url) : null;
      if (mapped) return json(res, 200, await port.queryView(mapped.name, mapped.input, context));
      return json(res, 404, { error: 'E_OPERATION_NOT_FOUND', message: '当前云端适配器尚未开放此操作' });
    } catch (error) {
      const out = toHttp(error);
      if (!res.headersSent) json(res, out.status, out.body);
      else res.end();
    }
  });
  return { server, broker, db: null };
}
