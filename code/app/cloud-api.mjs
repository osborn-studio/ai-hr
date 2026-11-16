import { createDomainPort } from './domain-port.mjs';
import * as foundation from './services/foundation.mjs';
import * as payroll from './services/customer-payroll.mjs';
import * as performance from './services/customer-performance.mjs';
import { ACTIONS as PEOPLE_ACTIONS } from './services/people-services.mjs';

const scope = input => ({ groupId: input.group_id, ledgerId: input.ledger_id, companyId: input.company_id });
const runScoped = fn => async (tx, input, context) => {
  await (await import('./services/platform-adapters.mjs')).guardCoarseAdapter(tx,context.userId);
  return fn(tx, { ...scope(input), ...input, userId: context.userId });
};
const legacyRead=fn=>async(tx,input,context)=>{await(await import('./services/platform-adapters.mjs')).guardCoarseAdapter(tx,context.userId);return fn(tx,input,context);};
const system = (name, command=false) => async(tx,input,context)=>{
  const service=await import('./services/platform.mjs');
  if(command)return service.dispatchCommand(tx,{userId:context.userId,input,operationId:context.operationId,operation:name});
  return service[name](tx,{userId:context.userId,input});
};
const lifecycle=name=>async(tx,input,context)=>{
 const service=await import('./services/leave-lifecycle.mjs');const result=await service[name](tx,{...input,input,userId:context.userId,accountId:input.account_id??input.accountId,authorizationId:input.authorization_id??input.authorizationId,approvalReceiptId:input.approval_receipt_id??input.approvalReceiptId,operationId:context.operationId});
 if(typeof service.projectServiceResult!=='function')throw new Error('E_OPERATION_NOT_AVAILABLE: 当前假期生命周期结果尚未完成授权投影');
 return service.projectServiceResult(tx,{userId:context.userId,result});
};
const leave = name => async (tx, input, context) => {
  const service = await import('./services/advanced-leave.mjs');
  if (typeof service[name] !== 'function') throw new Error('E_OPERATION_NOT_AVAILABLE: 该假期动作尚未开放');
  const result=await service[name](tx, {
    ...input, input: input.input ?? input, userId: context.userId,
    accountId: input.accountId ?? input.account_id,
    groupId: input.groupId ?? input.group_id, ledgerId: input.ledgerId ?? input.ledger_id,
    companyId: input.companyId ?? input.company_id,
    operationId: context.operationId, commandKey: context.operationId ?? input.commandKey,
  });
  return service.projectServiceResult(tx,{userId:context.userId,result});
};
export function domainOperations() {
  const query = run => ({ kind: 'query', run });
  const command = run => ({ kind: 'command', run });
  return {
    'foundation.bootstrap': query(async(tx,i,c)=>(await import('./services/platform-adapters.mjs')).bootstrap(tx,{userId:c.userId,...scope(i)})),
    'foundation.timeline': query(legacyRead((tx, i, c) => foundation.timeline(tx, { userId: c.userId, personId: i.person_id }))),
    'payroll.batches': query(runScoped(payroll.listBatches)),
    'payroll.rules': query(runScoped(payroll.listRuleSets)),
    'payroll.report': query(legacyRead((tx, i, c) => payroll.report(tx, { ...scope(i), userId: c.userId, batchId: i.batch_id }))),
    'performance.cycles': query(runScoped(performance.listCycles)),
    'performance.report': query(legacyRead((tx, i, c) => performance.report(tx, { ...scope(i), userId: c.userId, cycleId: i.cycle_id }))),
    'system.workspace':query(system('queryWorkspace')),
    'system.workflow.preview':query(system('previewWorkflow')),
    'system.authorization.simulate':query(system('simulateAuthorization')),
    'system.operation.status':query(system('operationStatus')),
    ...Object.fromEntries(['operator.create','operator.update','operator.reset_password','role.save','role.assign','role.revoke_member','grant.save','grant.revoke','form.save','form.publish','workflow.save','workflow.publish','instance.submit','instance.decide','instance.transfer','instance.delegate','instance.execute','instance.cancel','integration.save','integration.secret','integration.validate','integration.snapshot','integration.mapping'].map(name=>['system.'+name,command(system(name,true))])),
    ...Object.fromEntries(Object.entries(PEOPLE_ACTIONS).flatMap(([module,actions])=>[
      [module+'.workspace',query(async(tx,i,c)=>(await import('./services/people-services.mjs')).queryWorkspace(tx,{userId:c.userId,module,...scope(i),personId:i.person_id,asOf:i.as_of,page:i.page,pageSize:i.page_size,q:i.q}))],
      ...actions.map(action=>[module+'.'+action,command(async(tx,i,c)=>(await import('./services/people-services.mjs')).dispatchCommand(tx,{userId:c.userId,module,action,input:i,operationId:c.operationId}))]),
    ])),
    'leave.lifecycle.workspace':query(lifecycle('workspace')),
    ...Object.fromEntries(Object.entries({'extension':'proposeExtension','carry':'proposeCarry','recurring':'proposeRecurring','advance':'proposeAdvance','overtime-basis':'proposeOvertimeBasis','overtime-allocation':'proposeOvertimeAllocation','comp-cash':'proposeCompCash','advance-repayment':'proposeAdvanceRepayment','cash-qualification':'proposeCashQualification','annual-cash':'proposeAnnualCash','decide':'approveProposal','cancel':'cancelProposal','occurrences':'buildOccurrences','occurrence-submit':'submitOccurrence','exit-advances':'reviewExitAdvances'}).map(([name,method])=>['leave.lifecycle.'+name,command(lifecycle(method))])),
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
    if(req.method==='GET'&&url.pathname==='/api/foundation/bootstrap'){
      const i=Object.fromEntries(url.searchParams);
      await runRead(res,tx=>(import('./services/platform-adapters.mjs')).then(service=>service.bootstrap(tx,{userId,...scope(i)})));
      return true;
    }
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
