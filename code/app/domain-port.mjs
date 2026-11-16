import { createHash, randomUUID } from 'node:crypto';
import { withTx } from './db.mjs';

export const DOMAIN_PROTOCOL = 'tyhr-domain-port/1';
export function portError(code, message, status = 400) {
  return Object.assign(new Error(`${code}: ${message}`), { code, status });
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function endpoint(value, name) {
  let url;
  try { url = new URL(value); } catch { throw portError('E_BROKER_CONFIG', `${name}未配置有效URL`, 503); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) {
    throw portError('E_BROKER_CONFIG', `${name}必须使用HTTPS或回环测试地址，凭据单独配置`, 503);
  }
  return url.href;
}

// This is an application-owned protocol, not an undocumented vendor API.
// A provider adapter must satisfy its atomic command and session contracts.
export function createBrokerClient({ capabilitiesUrl, queryUrl, commandUrl, token, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const urls = { capabilities: endpoint(capabilitiesUrl, '能力探针'), query: endpoint(queryUrl, '查询地址'), command: endpoint(commandUrl, '命令地址') };
  if (typeof token !== 'string' || token.length < 16) throw portError('E_BROKER_CONFIG', '需配置服务端Broker凭据', 503);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 120000) throw portError('E_BROKER_CONFIG', 'Broker超时配置无效', 503);
  let ready = false;
  async function request(kind, envelope) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(urls[kind], {
        method: kind === 'capabilities' ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(kind === 'capabilities' ? {} : { 'content-type': 'application/json' }) },
        ...(kind === 'capabilities' ? {} : { body: JSON.stringify(envelope) }),
      });
      const raw = await response.text();
      if (raw.length > 4 * 1024 * 1024) throw new Error('response limit');
      let body;
      try { body = JSON.parse(raw); } catch { throw new Error('invalid response'); }
      if (!response.ok) {
        const known = object(body) && object(body.error) && typeof body.error.code === 'string';
        if (known && response.status >= 400 && response.status < 500) throw portError(body.error.code, body.error.message || 'Broker拒绝当前操作', response.status);
        throw new Error('upstream failure');
      }
      if (!object(body)) throw new Error('invalid response');
      return body;
    } catch (error) {
      if (error.status && error.status < 500) throw error;
      if (kind === 'command') throw portError('E_BROKER_EXECUTION_UNKNOWN', '执行结果待核，请按原操作编号对账，勿换编号重试', 503);
      throw portError('E_BROKER_UNAVAILABLE', '数据服务暂不可用，请重试查询', 503);
    } finally { clearTimeout(timer); }
  }
  return {
    mode: 'broker',
    async initialize() {
      const capabilities = await request('capabilities');
      const required = ['atomic_commands', 'session_identity', 'scoped_authorization', 'idempotency', 'decimal_strings'];
      if (capabilities.protocol !== DOMAIN_PROTOCOL || required.some(k => capabilities[k] !== true)) {
        ready = false;
        throw portError('E_BROKER_CAPABILITY', 'Broker缺少事务、会话授权、幂等或精确金额能力', 503);
      }
      ready = true;
      return { protocol: DOMAIN_PROTOCOL, verified_contract: true, vendor_connection_verified: false };
    },
    async call(kind, name, input, context = {}, operationId) {
      if (!ready) throw portError('E_BROKER_NOT_READY', 'Broker能力尚未核验', 503);
      if (!['query', 'command'].includes(kind) || !NAME.test(name) || !object(input) || !object(context)) throw portError('E_PORT_ARGUMENT', '领域请求格式无效');
      if (kind === 'command' && (typeof operationId !== 'string' || operationId.length < 8 || operationId.length > 160)) throw portError('E_IDEMPOTENCY_REQUIRED', '写操作需要稳定操作编号');
      const envelope = { protocol: DOMAIN_PROTOCOL, name, input, context, request_id: randomUUID(), ...(kind === 'command' ? { operation_id: operationId } : {}) };
      const out = await request(kind, envelope);
      if (!Object.hasOwn(out, 'result')) throw portError(kind === 'command' ? 'E_BROKER_EXECUTION_UNKNOWN' : 'E_BROKER_PROTOCOL', '未收到有效领域结果', 503);
      if (kind === 'command' && (!object(out.receipt) || out.receipt.operation_id !== operationId || out.receipt.atomic !== true)) throw portError('E_BROKER_EXECUTION_UNKNOWN', '执行回执不完整，请核对原操作', 503);
      return out.result;
    },
  };
}

// Registry entries execute current domain guards. The port never exposes SQL.
// Passed tx is the route's existing transaction; it must not be nested.
export function createDomainPort({ db, broker, operations = {} } = {}) {
  const definitions = new Map(Object.entries(operations));
  function definition(kind, name, input, context) {
    const op = definitions.get(name);
    if (!op || op.kind !== kind) throw portError('E_OPERATION_NOT_FOUND', '功能不存在或尚未开放', 404);
    if (!object(input) || !object(context) || !Number.isSafeInteger(context.userId) || context.userId < 1) throw portError('E_PORT_IDENTITY', '缺少有效会话身份', 401);
    // Identity is exclusively supplied by the authenticated server context.
    const forbidden = ['userId', 'user_id', 'actor', 'actor_id', 'actorAccountId', 'authenticated_user_id', 'sessionToken', 'roles', 'grants'];
    if (forbidden.some(k => Object.hasOwn(input, k))) throw portError('E_PORT_ACTOR_OVERRIDE', '表单不能替换当前操作者', 403);
    return op;
  }
  async function invoke(kind, name, input, context, { tx, operationId } = {}) {
    const op = definition(kind, name, input, context);
    if (kind === 'command' && (typeof operationId !== 'string' || operationId.length < 8 || operationId.length > 160)) throw portError('E_IDEMPOTENCY_REQUIRED', '请保留本次操作编号');
    const trusted = { ...context, operationId, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex') };
    if (broker) return broker.call(kind, name, input, trusted, operationId);
    if (!db && !tx) throw portError('E_DATA_NOT_CONFIGURED', '未配置持久数据连接', 503);
    if (typeof op.run !== 'function') throw portError('E_OPERATION_NOT_AVAILABLE', '当前数据端口未提供此能力', 503);
    const run = async transaction => {
      if (op.authorize) await op.authorize(transaction, trusted, input);
      // Individual domain commands own their atomic idempotency records.
      return op.run(transaction, input, trusted);
    };
    return tx ? run(tx) : withTx(db, run);
  }
  return {
    mode: broker ? 'broker' : 'postgres_compatible',
    describe: () => [...definitions].map(([name, d]) => ({ name, kind: d.kind })),
    queryView: (name, input, context, options) => invoke('query', name, input, context, options),
    executeCommand: (name, input, context, options) => invoke('command', name, input, context, options),
  };
}
