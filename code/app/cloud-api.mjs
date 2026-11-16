import { createDomainPort } from './domain-port.mjs';
import * as foundation from './services/foundation.mjs';
import * as payroll from './services/customer-payroll.mjs';
import * as performance from './services/customer-performance.mjs';

const scope = input => ({ groupId: input.group_id, ledgerId: input.ledger_id, companyId: input.company_id });
const runScoped = fn => (tx, input, context) => fn(tx, { ...scope(input), ...input, userId: context.userId });
const leave = name => async (tx, input, context) => {
  const service = await import('./services/advanced-leave.mjs');
  if (typeof service[name] !== 'function') throw new Error('E_OPERATION_NOT_AVAILABLE: 该假期动作尚未开放');
  return service[name](tx, {
    ...input, input: input.input ?? input, userId: context.userId,
    accountId: input.accountId ?? input.account_id,
    groupId: input.groupId ?? input.group_id, ledgerId: input.ledgerId ?? input.ledger_id,
    companyId: input.companyId ?? input.company_id,
    operationId: context.operationId, commandKey: context.operationId ?? input.commandKey,
  });
};
export function domainOperations() {
  const query = run => ({ kind: 'query', run });
  const command = run => ({ kind: 'command', run });
  return {
    'foundation.bootstrap': query(runScoped(foundation.bootstrap)),
    'foundation.timeline': query((tx, i, c) => foundation.timeline(tx, { userId: c.userId, personId: i.person_id })),
    'payroll.batches': query(runScoped(payroll.listBatches)),
    'payroll.rules': query(runScoped(payroll.listRuleSets)),
    'payroll.report': query((tx, i, c) => payroll.report(tx, { ...scope(i), userId: c.userId, batchId: i.batch_id })),
    'performance.cycles': query(runScoped(performance.listCycles)),
    'performance.report': query((tx, i, c) => performance.report(tx, { ...scope(i), userId: c.userId, cycleId: i.cycle_id })),
    'leave.workspace': query(leave('queryWorkspace')),
    'leave.balance': query(leave('balance')),
    'leave.adjustment.preview': command(leave('previewAdjustment')),
    'leave.scheme.create': command(leave('createScheme')),
    'leave.scheme.publish': command(leave('publishScheme')),
    'leave.relationship.verify': command(leave('verifyRelationship')),
    'leave.entitlement.grant': command(leave('grantCumulative')),
    'leave.request.submit': command(leave('submitRequest')),
    'leave.request.decide': command(leave('decideRequest')),
    'leave.request.settle': command(leave('settleRequest')),
    'leave.request.cancel': command(leave('cancelRequest')),
    'leave.adjustment.apply': command(leave('applyAdjustment')),
    'leave.import': command(leave('importEntitlements')),
    'leave.expire': command(leave('expireLots')),
    'leave.payroll.candidate': command(leave('createPayrollCandidate')),
    'leave.payroll.adopt': command(leave('adoptPayrollCandidate')),
  };
}

export function createCloudApiExtension() {
  return async function extend({ req, res, url, userId, db, readBody, runRead, runWrite }) {
    const match = /^\/api\/v2\/(query|command)\/([a-z][a-z0-9._-]{1,100})$/.exec(url.pathname);
    if (!match) return false;
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'E_PORT_ARGUMENT', message: '请使用POST提交结构化参数' }));
      return true;
    }
    let input;
    try { input = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); }
    catch { throw new Error('E_TY_ARGUMENT: 请求内容不是有效JSON对象'); }
    const [ , kind, name ] = match;
    const port = createDomainPort({ db, operations: domainOperations() });
    const context = { userId: Number(userId) };
    if (kind === 'query') await runRead(res, tx => port.queryView(name, input, context, { tx }));
    else await runWrite(res, { actor: userId, action: `v2.${name}`, subject: input?.employment_id ? `employment:${input.employment_id}` : null,
      fn: tx => port.executeCommand(name, input, context, { tx, operationId: req.headers['idempotency-key'] || input?.client_operation_id }) });
    return true;
  };
}
