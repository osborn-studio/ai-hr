import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { companyDescendants } from './foundation.mjs';
import { q, one, same, bad, deny, conflict, missing, id, text, obj, list, canonical, hash, revision, groupFor, requireAccess, authorization, command, audit, emit, currentOperator, search, paging } from './platform-core.mjs';

const PROVIDERS = new Set(['dingtalk', 'feishu', 'wecom', 'device']);
const CONFIG_KEYS = new Set(['organization_id', 'app_id', 'gateway_url', 'adapter_code', 'source_timezone', 'application_type', 'authorized_capabilities']);
const FIELD_KEYS = {
  connections: ['name', 'code', 'status', 'config', 'capabilities', 'connection_state', 'secret_configured'],
  mappings: ['external_id', 'external_name', 'local_id', 'status'],
  jobs: ['kind', 'state', 'summary'],
};
const SAFE_CONNECTION_SQL = `id,group_id,company_id,provider,code,name,status,config,capabilities,connection_state,revision,
 secret_revision,(secret_cipher IS NOT NULL)secret_configured,created_by,updated_at`;
const SECRET_PATTERN = /(^|_)(secret|password|token|credential|authorization|cookie|private_key|encryption_key)s?($|_)/i;
const CREDENTIAL_KEYS = new Set(['app_id', 'app_secret', 'client_id', 'client_secret', 'corp_secret', 'token', 'aes_key', 'device_key', 'username', 'password']);

function assertNoSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_PATTERN.test(key)) bad('秘密须使用独立加密凭据入口，不能保存在配置、快照或备注。');
    if (child && typeof child === 'object') assertNoSecrets(child);
  }
}
function vaultKey() {
  const encoded = process.env.TYHR_INTEGRATION_VAULT_KEY?.trim();
  if (!encoded) bad('尚未配置集成凭据加密密钥，未保存凭据。');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) bad('集成加密密钥须为32字节的标准Base64配置。');
  return key;
}
function connectionProjection(row) {
  return { ...row, secret_masked: row.secret_configured ? '••••（已加密）' : null };
}
function cleanConfig(value) {
  const raw = obj(value || {}, '连接配置'); assertNoSecrets(raw);
  if (Object.keys(raw).some(key => !CONFIG_KEYS.has(key))) bad('连接配置含未支持字段。');
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'authorized_capabilities') {
      const values = list(value, '获准能力声明');
      if (values.some(item => typeof item !== 'string' || item.length > 100)) bad('能力声明格式无效。');
      result[key] = [...new Set(values)]; continue;
    }
    if (typeof value !== 'string' || value.length > 1000) bad('连接配置字段格式无效。');
    result[key] = value.trim();
  }
  if (result.gateway_url) {
    let url; try { url = new URL(result.gateway_url); } catch { bad('网关地址格式无效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) bad('网关只接受无内嵌凭据、查询参数和片段的HTTP/HTTPS地址。');
    result.gateway_url = url.toString();
  }
  if (result.source_timezone) { try { new Intl.DateTimeFormat('en', { timeZone: result.source_timezone }).format(new Date()); } catch { bad('来源时区无效。'); } }
  return result;
}
function configurationIssues(provider, config) {
  const issues = [];
  if (provider === 'device') { if (!config.gateway_url && !config.adapter_code) issues.push('设备须明确已获准的网关或适配器编码。'); }
  else { if (!config.organization_id) issues.push('缺少组织／企业识别。'); if (!config.app_id) issues.push('缺少应用识别。'); }
  return issues;
}
function capabilityDeclaration(row) {
  return {
    source: 'local_configuration_review', network_verified: false,
    declared: row.config.authorized_capabilities || [],
    available: { configuration_review: true, manual_snapshot: true, typed_mapping: true },
    external_read: 'not_verified', external_write: 'not_verified',
    notes: ['仅核对本地配置与声明；未请求外部平台、设备或门禁。', '读打卡、写打卡、审批回传与通知按真实应用类型和授权分别接入。'],
  };
}
async function companyFor(t, companyId, group) {
  if (!companyId) return null;
  const company = await one(t, 'SELECT id,group_id,ledger_id FROM ty_company WHERE id=$1 AND group_id=$2', [id(companyId), group]);
  if (!company) bad('关联公司不属于本集团。'); return company;
}
async function loadConnection(t, connectionId, userId, action, fields = [], locked = false, groupId = null) {
  const row = await one(t, 'SELECT ' + SAFE_CONNECTION_SQL + ' FROM ty_integration_connection WHERE id=$1' + (locked ? ' FOR UPDATE' : ''), [id(connectionId)]);
  if (!row || groupId && !same(row.group_id, groupId)) missing();
  await groupFor(t, userId, row.group_id);
  await requireAccess(t, userId, 'integration_manage', action, { ...row, fields });
  return row;
}
async function hasAccess(t, userId, row, action, fields = []) {
  return (await authorization(t, { userId, resource: 'integration_manage', action, groupId: row.group_id, companyId: row.company_id, fields })).allowed;
}

export async function queryIntegrationWorkspace(t, { userId, input = {} }) {
  const group = await groupFor(t, userId, input.group_id), view = input.view || 'connections';
  if (!['connections', 'mappings', 'jobs'].includes(view)) bad('集成视图未登记。');
  const selectedCompany = id(input.company_id, true); await companyFor(t, selectedCompany, group.id);
  const selected = selectedCompany ? await companyDescendants(t, selectedCompany) : null;
  const candidates = await q(t, 'SELECT ' + SAFE_CONNECTION_SQL + ' FROM ty_integration_connection WHERE group_id=$1 ORDER BY id DESC', [group.id]);
  const visible = [];
  for (const row of candidates) if ((!selected || row.company_id && selected.includes(String(row.company_id))) && await hasAccess(t, userId, row, 'read', FIELD_KEYS[view])) visible.push(row);
  const companies = [];
  for (const row of await q(t, 'SELECT id,group_id,name,parent_company_id FROM ty_company WHERE group_id=$1 ORDER BY id', [group.id])) {
    if (selected && !selected.includes(String(row.id))) continue;
    if (await hasAccess(t, userId, { group_id: group.id, company_id: row.id }, 'read')) companies.push(row);
  }
  const groupRead = await hasAccess(t, userId, { group_id: group.id, company_id: selectedCompany }, 'read');
  if (!groupRead && !companies.length) deny('没有集成设置的当前功能与范围授权。');
  let canManage = await hasAccess(t, userId, { group_id: group.id, company_id: selectedCompany }, 'write');
  if (!canManage) for (const company of companies) if (await hasAccess(t, userId, { group_id: group.id, company_id: company.id }, 'write')) { canManage = true; break; }
  const ids = visible.map(row => row.id); let rows = [];
  if (view === 'connections') rows = visible.map(connectionProjection);
  else if (ids.length && view === 'mappings') {
    rows = (await q(t, `SELECT m.*,c.group_id,c.company_id connection_company_id,
      COALESCE(co.name,d.name,p.full_name) local_name FROM ty_integration_mapping m
      JOIN ty_integration_connection c ON c.id=m.connection_id
      LEFT JOIN ty_company co ON co.id=m.company_id LEFT JOIN ty_department d ON d.id=m.department_id LEFT JOIN ty_person p ON p.id=m.person_id
      WHERE m.connection_id=ANY($1::bigint[]) ORDER BY m.id DESC`, [ids])).map(row => ({ ...row, status: row.state, local_id: row.company_id || row.department_id || row.person_id || null }));
    const allowed = [];
    for (const row of rows) { if (row.local_id) { try { await validateLocalTarget(t, userId, visible.find(c => same(c.id, row.connection_id)), row.local_type, row.local_id, 'read'); } catch (error) { if (error.code === 'E_TY_FORBIDDEN' || error.message?.includes('E_TY_FORBIDDEN') || error.message?.includes('不属于')) continue; throw error; } } allowed.push(row); }
    rows = allowed;
  } else if (ids.length) {
    rows = (await q(t, 'SELECT * FROM ty_integration_job WHERE connection_id=ANY($1::bigint[]) ORDER BY id DESC', [ids])).map(row => {
      const summary = { ...row.summary }; delete summary.snapshot;
      return { ...row, summary, status: row.state, direction: row.kind === 'snapshot' ? 'inbound' : 'configuration', sent_status: 'not_sent', delivery_status: 'not_sent', read_status: 'unknown' };
    });
  }
  if (input.id) rows = rows.filter(row => same(row.id, input.id));
  rows = search(rows, input.q, view === 'connections' ? ['code', 'name', 'provider', 'connection_state'] : view === 'mappings' ? ['external_id', 'external_name', 'local_name', 'local_type', 'state'] : ['kind', 'source_revision', 'state']);
  const result = paging(rows, input), operator = await currentOperator(t, userId);
  return { ...result, [view]: result.rows, current_operator: { id: operator.id, login: operator.login, display_name: operator.display_name, profile_code: operator.profile_code }, companies,
    capabilities: { can_manage_integrations: canManage }, as_of: new Date().toISOString(), unavailable_modules: [],
    resource_catalogue: [{ code: 'integration_manage', label: '集成配置与对照', actions: [{ code: 'read', label: '查看' }, { code: 'write', label: '配置' }, { code: 'sync', label: '采集快照' }], fields: [...new Set(Object.values(FIELD_KEYS).flat())].map(key => ({ key, label: key, sensitivity: 'normal' })) }], fields_catalogue: [],
  };
}

async function validateLocalTarget(t, userId, connection, localType, localId, action = 'write') {
  const targetId = id(localId), allowedTypes = ['company', 'department', 'person']; if (!allowedTypes.includes(localType)) bad('本地映射类型未登记。');
  let target, companyIds = [];
  if (localType === 'company') { target = await companyFor(t, targetId, connection.group_id); companyIds = [target.id]; }
  else if (localType === 'department') { target = await one(t, 'SELECT d.id,d.company_id,c.group_id FROM ty_department d JOIN ty_company c ON c.id=d.company_id WHERE d.id=$1 AND c.group_id=$2', [targetId, connection.group_id]); if (!target) bad('部门不属于本集团。'); companyIds = [target.company_id]; }
  else {
    target = await one(t, 'SELECT id,group_id FROM ty_person WHERE id=$1 AND group_id=$2', [targetId, connection.group_id]); if (!target) bad('人员不属于本集团。');
    companyIds = (await q(t, "SELECT DISTINCT e.company_id FROM ty_employment e WHERE e.person_id=$1 AND e.status<>'cancelled'", [targetId])).map(row => row.company_id);
    if (!companyIds.length && connection.company_id) deny('公司连接只能对照有本公司实际关系依据的人员；不能由通讯录新造雇佣。');
  }
  const descendants = connection.company_id ? await companyDescendants(t, connection.company_id) : null;
  if (descendants) companyIds = companyIds.filter(company => descendants.includes(String(company)));
  if (descendants && !companyIds.length) deny('本地对象超出此连接公司范围。');
  if (!companyIds.length) companyIds = [null];
  let allowed = false;
  for (const companyId of companyIds) if ((await authorization(t, { userId, resource: 'integration_manage', action, groupId: connection.group_id, companyId, personId: localType === 'person' ? targetId : null, departmentId: localType === 'department' ? targetId : null, fields: ['local_id'] })).allowed) { allowed = true; break; }
  if (!allowed) deny('本地映射目标不在当前完整授权范围。');
  return target;
}

export async function dispatchIntegrationCommand(t, { userId, operation, operationId, input = {} }) {
  const name = String(operation || '').replace(/^system\./, '');
  if (!['integration.save', 'integration.secret', 'integration.validate', 'integration.snapshot', 'integration.mapping'].includes(name)) bad('集成操作未登记。');
  obj(input, '集成操作'); if (name !== 'integration.secret') assertNoSecrets(input);
  if (name === 'integration.save') return saveConnection(t, { userId, operationId, input });
  if (name === 'integration.mapping') return saveMapping(t, { userId, operationId, input });
  const initial = await loadConnection(t, input.connection_id, userId, name === 'integration.snapshot' ? 'sync' : 'write', name === 'integration.secret' ? ['config'] : name === 'integration.snapshot' ? ['external_id', 'external_name'] : ['config', 'capabilities'], false, input.group_id);
  if (name === 'integration.secret') return saveCredentials(t, { userId, operationId, input, initial });
  return command(t, { userId, groupId: initial.group_id, operation: name, operationId, input, execute: async () => {
    const connection = await loadConnection(t, initial.id, userId, name === 'integration.snapshot' ? 'sync' : 'write', name === 'integration.snapshot' ? ['external_id', 'external_name'] : ['config', 'capabilities'], true);
    if (name === 'integration.validate') {
      const issues = configurationIssues(connection.provider, cleanConfig(connection.config));
      const state = issues.length || !connection.secret_configured ? 'not_configured' : 'not_verified';
      const capabilities = capabilityDeclaration(connection);
      const row = await one(t, 'UPDATE ty_integration_connection SET capabilities=$2::jsonb,connection_state=$3,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ' + SAFE_CONNECTION_SQL, [connection.id, JSON.stringify(capabilities), state]);
      await audit(t, userId, row.group_id, name, 'integration_connection', row.id, { configuration_valid: !issues.length, issues_count: issues.length, network_verified: false });
      await emit(t, row.group_id, 'integration:review:' + connection.id + ':' + userId + ':' + operationId, 'integration.configuration_reviewed', { connection_id: row.id, network_verified: false });
      return { connection: connectionProjection(row), issues, configuration_valid: !issues.length, network_verified: false, sent: false };
    }
    return ingestSnapshot(t, { userId, operationId, input, connection });
  } });
}

async function saveConnection(t, { userId, operationId, input }) {
  const group = await groupFor(t, userId, input.group_id), company = id(input.company_id, true); await companyFor(t, company, group.id);
  await requireAccess(t, userId, 'integration_manage', 'write', { group_id: group.id, company_id: company, fields: ['name', 'code', 'config', 'status'] });
  if (input.id) await loadConnection(t, input.id, userId, 'write', ['name', 'code', 'config', 'status'], false, group.id);
  const provider = text(input.provider, '连接平台', 1, 32), code = text(input.code, '连接编码', 1, 64), name = text(input.name, '连接名称', 1, 120), config = cleanConfig(input.config || {});
  if (!PROVIDERS.has(provider) || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(code)) bad('连接平台或稳定编码无效。');
  const status = input.status || 'draft'; if (!['draft', 'active', 'disabled'].includes(status)) bad('连接状态须为草稿、启用或停用。');
  if (status === 'active' && configurationIssues(provider, config).length) bad('启用前须补全组织、应用或设备适配依据。');
  return command(t, { userId, groupId: group.id, operation: 'integration.save', operationId, input, execute: async () => {
    let row;
    if (input.id) {
      const old = await loadConnection(t, input.id, userId, 'write', ['name', 'code', 'config', 'status'], true, group.id); revision(old, input.expected_revision);
      if (old.provider !== provider || old.code !== code || !same(old.company_id, company)) bad('已有连接的集团、公司、平台和编码不能搬移，请另建连接。');
      row = await one(t, 'UPDATE ty_integration_connection SET name=$2,status=$3,config=$4::jsonb,capabilities=$5::jsonb,connection_state=$6,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING ' + SAFE_CONNECTION_SQL, [old.id, name, status, JSON.stringify(config), '{}', old.secret_configured ? 'not_verified' : 'not_configured']);
    } else row = await one(t, 'INSERT INTO ty_integration_connection(group_id,company_id,provider,code,name,status,config,created_by)VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING ' + SAFE_CONNECTION_SQL, [group.id, company, provider, code, name, status, JSON.stringify(config), userId]);
    await audit(t, userId, group.id, 'integration.save', 'integration_connection', row.id, { provider, status });
    await emit(t, group.id, 'integration:configuration:' + row.id + ':' + userId + ':' + operationId, 'integration.configuration_changed', { connection_id: row.id });
    return { connection: connectionProjection(row), network_verified: false };
  } });
}

async function saveCredentials(t, { userId, operationId, input, initial }) {
  const credentials = obj(input.credentials, '集成凭据'), entries = Object.entries(credentials);
  if (!entries.length || entries.length > 20 || entries.some(([key, value]) => !CREDENTIAL_KEYS.has(key) || typeof value !== 'string' || !value.trim() || value.length > 4096)) bad('凭据字段或长度无效。');
  const key = vaultKey(), plain = JSON.stringify(canonical(credentials));
  const fingerprint = createHmac('sha256', key).update(String(operationId) + ':' + initial.id + ':' + plain).digest('hex');
  const safeInput = { connection_id: initial.id, credential_fingerprint: fingerprint };
  return command(t, { userId, groupId: initial.group_id, operation: 'integration.secret', operationId, input: safeInput, execute: async () => {
    const connection = await loadConnection(t, initial.id, userId, 'write', ['config'], true), secretRevision = connection.secret_revision + 1;
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(['tyhr-integration-v1', connection.group_id, connection.id, connection.provider, secretRevision].join(':')));
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    await t.query('UPDATE ty_integration_connection SET secret_cipher=$2,secret_iv=$3,secret_tag=$4,secret_revision=$5,connection_state=$6,capabilities=$7::jsonb,revision=revision+1,updated_at=now() WHERE id=$1', [connection.id, encrypted.toString('base64'), iv.toString('base64'), cipher.getAuthTag().toString('base64'), secretRevision, 'not_verified', '{}']);
    await audit(t, userId, connection.group_id, 'integration.secret', 'integration_connection', connection.id, { secret_revision: secretRevision });
    await emit(t, connection.group_id, 'integration:credential:' + connection.id + ':' + userId + ':' + operationId, 'integration.credentials_changed', { connection_id: connection.id, secret_revision: secretRevision });
    return { connection_id: connection.id, secret_configured: true, secret_masked: '••••（已加密）', secret_revision: secretRevision, network_verified: false, credential_available: false };
  } });
}

function normalizeExternal(raw, externalType) {
  obj(raw, '外部对象'); const allowed = externalType === 'department' ? ['id', 'external_id', 'name', 'external_name', 'parent_id'] : ['id', 'external_id', 'name', 'external_name', 'department_ids'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) bad('快照只接受外部稳定编号、名称和部门引用，不采集口令或证件资料。');
  const external_id = text(raw.external_id ?? raw.id, '外部稳定编号', 1, 120), external_name = text(raw.external_name ?? raw.name, '外部名称', 1, 120);
  return { external_id, external_name, external_type: externalType,
    ...(externalType === 'department' && raw.parent_id ? { parent_id: text(raw.parent_id, '上级外部部门编号', 1, 120) } : {}),
    ...(externalType === 'person' ? { department_ids: list(raw.department_ids || [], '外部部门引用').map(value => text(value, '外部部门编号', 1, 120)) } : {}),
  };
}
async function ingestSnapshot(t, { userId, operationId, input, connection }) {
  if (connection.status === 'disabled') bad('连接已停用，不能采集新快照。');
  const source = text(input.source_revision, '来源版本', 1, 160), evidence = text(input.evidence_ref, '来源核定依据', 4, 300);
  const departments = list(input.departments, '部门快照').map(raw => normalizeExternal(raw, 'department')), users = list(input.users, '人员快照').map(raw => normalizeExternal(raw, 'person'));
  const all = [...departments, ...users], keys = new Set();
  for (const row of all) { const key = row.external_type + ':' + row.external_id; if (keys.has(key)) bad('同一快照含重复外部稳定编号。'); keys.add(key); }
  const existing = await q(t, 'SELECT * FROM ty_integration_mapping WHERE connection_id=$1 FOR UPDATE', [connection.id]);
  const knownDepartments = new Set([...departments.map(row => row.external_id), ...existing.filter(row => row.external_type === 'department').map(row => row.external_id)]);
  const parent = new Map(departments.map(row => [row.external_id, row.parent_id]));
  for (const row of departments) {
    if (row.parent_id && !knownDepartments.has(row.parent_id)) bad('外部部门上级尚无来源依据。');
    const seen = new Set(); let current = row.external_id; while (current) { if (seen.has(current)) bad('外部部门快照存在循环。'); seen.add(current); current = parent.get(current); }
  }
  for (const row of users) if (row.department_ids.some(value => !knownDepartments.has(value))) bad('外部人员引用了未知部门。');
  const snapshot = { departments, users }, snapshotHash = hash(snapshot);
  const oldJob = await one(t, "SELECT * FROM ty_integration_job WHERE connection_id=$1 AND source_revision=$2 AND kind='snapshot'", [connection.id, source]);
  if (oldJob) { if (oldJob.summary.snapshot_hash !== snapshotHash) conflict('同一来源版本内容已改变，请提供新版本。'); return { job: { ...oldJob, summary: { ...oldJob.summary, snapshot: undefined } }, already_exists: true, employment_created: false }; }
  let added = 0, changed = 0, preserved = 0;
  for (const row of all) {
    const old = existing.find(value => value.external_type === row.external_type && value.external_id === row.external_id);
    if (!old) { await t.query('INSERT INTO ty_integration_mapping(connection_id,external_type,external_id,external_name,source_revision)VALUES($1,$2,$3,$4,$5)', [connection.id, row.external_type, row.external_id, row.external_name, source]); added++; }
    else {
      const nameChanged = old.external_name !== row.external_name;
      await t.query("UPDATE ty_integration_mapping SET external_name=$2,source_revision=$3,state=CASE WHEN $4 THEN 'review' ELSE state END,revision=revision+1,confirmed_by=CASE WHEN $4 THEN NULL ELSE confirmed_by END,confirmed_at=CASE WHEN $4 THEN NULL ELSE confirmed_at END WHERE id=$1", [old.id, row.external_name, source, nameChanged]);
      if (nameChanged) changed++; else preserved++;
    }
  }
  const summary = { snapshot_hash: snapshotHash, received_departments: departments.length, received_users: users.length, added, changed, preserved, absent_preserved: existing.filter(row => !keys.has(row.external_type + ':' + row.external_id)).length, employment_created: false, network_verified: false, snapshot };
  const job = await one(t, "INSERT INTO ty_integration_job(connection_id,source_revision,kind,state,evidence_ref,summary,created_by)VALUES($1,$2,'snapshot','review',$3,$4::jsonb,$5) RETURNING *", [connection.id, source, evidence, JSON.stringify(summary), userId]);
  await audit(t, userId, connection.group_id, 'integration.snapshot', 'integration_job', job.id, { connection_id: connection.id, added, changed, preserved });
  await emit(t, connection.group_id, 'integration:snapshot:' + connection.id + ':' + source, 'integration.snapshot_review_required', { connection_id: connection.id, job_id: job.id });
  const projectedSummary = { ...summary }; delete projectedSummary.snapshot;
  return { job: { ...job, summary: projectedSummary }, employment_created: false, network_verified: false };
}

async function saveMapping(t, { userId, operationId, input }) {
  const mapping = await one(t, 'SELECT * FROM ty_integration_mapping WHERE id=$1', [id(input.mapping_id)]); if (!mapping) missing();
  const initial = await loadConnection(t, mapping.connection_id, userId, 'write', ['local_id', 'external_id']);
  const reason = text(input.reason, '映射核定原因', 4, 500);
  if (mapping.external_type === 'person' ? input.local_type !== 'person' : !['department', 'company'].includes(input.local_type)) bad('外部人员只能对应永久人员；外部部门只能对应公司或部门。');
  await validateLocalTarget(t, userId, initial, input.local_type, input.local_id);
  return command(t, { userId, groupId: initial.group_id, operation: 'integration.mapping', operationId, input, execute: async () => {
    const connection = await loadConnection(t, initial.id, userId, 'write', ['local_id', 'external_id'], true);
    if (connection.status === 'disabled') bad('连接已停用，不能确认映射。');
    const old = await one(t, 'SELECT * FROM ty_integration_mapping WHERE id=$1 FOR UPDATE', [mapping.id]); revision(old, input.expected_revision);
    await validateLocalTarget(t, userId, connection, input.local_type, input.local_id);
    const target = id(input.local_id);
    const row = await one(t, "UPDATE ty_integration_mapping SET local_type=$2,company_id=$3,department_id=$4,person_id=$5,state='confirmed',confirmed_by=$6,confirmed_at=now(),revision=revision+1 WHERE id=$1 RETURNING *", [old.id, input.local_type, input.local_type === 'company' ? target : null, input.local_type === 'department' ? target : null, input.local_type === 'person' ? target : null, userId]);
    await audit(t, userId, connection.group_id, 'integration.mapping', 'integration_mapping', row.id, { connection_id: connection.id, local_type: input.local_type, local_id: target, reason });
    await emit(t, connection.group_id, 'integration:mapping:' + row.id + ':' + userId + ':' + operationId, 'integration.mapping_confirmed', { mapping_id: row.id, connection_id: connection.id });
    return { mapping: { ...row, status: row.state, local_id: target }, employment_created: false, network_verified: false };
  } });
}
