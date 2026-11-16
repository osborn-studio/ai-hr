import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dispatchIntegrationCommand, queryIntegrationWorkspace } from '../app/services/platform-integration.mjs';

// This suite owns only fictional disposable records and never calls a provider.
// The supplied DB must contain the same 001–214 migrations as the application.
export async function runIntegrationTests({ db }) {
  let passed = 0; const results = [], suffix = randomUUID().slice(0, 8);
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const first = async (sql, args = []) => (await rows(sql, args))[0];
  const tx = async fn => { await db.query('BEGIN'); try { const out = await fn(db); await db.query('COMMIT'); return out; } catch (error) { await db.query('ROLLBACK'); throw error; } };
  const check = (name, condition) => { assert.ok(condition, name); passed++; results.push(name); console.log('PASS ' + name); };
  const reject = async (name, fn, pattern = /E_TY_|范围|集团|加密|凭据|版本|映射|配置|编号|快照|循环|部门/) => { await assert.rejects(fn, pattern); passed++; results.push(name); console.log('PASS ' + name); };
  const savedKey = process.env.TYHR_INTEGRATION_VAULT_KEY;
  try {
    const group = await first('INSERT INTO ty_group(code,name)VALUES($1,$2)RETURNING *', ['INTEGRATION-' + suffix, '全虚构集成核验集团']);
    const foreignGroup = await first('INSERT INTO ty_group(code,name)VALUES($1,$2)RETURNING *', ['OTHER-' + suffix, '全虚构其他集团']);
    const ledger = await first("INSERT INTO ty_ledger(group_id,code,name,scope_mode)VALUES($1,'L','全虚构集团帐','group')RETURNING *", [group.id]);
    const foreignLedger = await first("INSERT INTO ty_ledger(group_id,code,name,scope_mode)VALUES($1,'L','其他虚构帐','group')RETURNING *", [foreignGroup.id]);
    const own = await first("INSERT INTO ty_company(group_id,ledger_id,code,name)VALUES($1,$2,'OWN','全虚构甲店')RETURNING *", [group.id, ledger.id]);
    const other = await first("INSERT INTO ty_company(group_id,ledger_id,code,name)VALUES($1,$2,'OTHER','全虚构乙店')RETURNING *", [group.id, ledger.id]);
    const foreign = await first("INSERT INTO ty_company(group_id,ledger_id,code,name)VALUES($1,$2,'FOREIGN','其他集团虚构店')RETURNING *", [foreignGroup.id, foreignLedger.id]);
    const department = await first("INSERT INTO ty_department(company_id,code,name)VALUES($1,'FRONT','全虚构前厅')RETURNING *", [own.id]);
    const ownPerson = await first("INSERT INTO ty_person(group_id,person_number,full_name)VALUES($1,'FICTION-1','岑清沅')RETURNING *", [group.id]);
    const otherPerson = await first("INSERT INTO ty_person(group_id,person_number,full_name)VALUES($1,'FICTION-2','冉知禾')RETURNING *", [group.id]);
    const foreignPerson = await first("INSERT INTO ty_person(group_id,person_number,full_name)VALUES($1,'FICTION-3','顾沐言')RETURNING *", [foreignGroup.id]);
    await db.query("INSERT INTO ty_employment(group_id,person_id,company_id,hire_date)VALUES($1,$2,$3,'2026-01-01'),($1,$4,$5,'2026-01-01'),($6,$7,$8,'2026-01-01')", [group.id, ownPerson.id, own.id, otherPerson.id, other.id, foreignGroup.id, foreignPerson.id, foreign.id]);
    const admin = await first('INSERT INTO sys_account(login,display_name)VALUES($1,$2)RETURNING *', ['int_admin_' + suffix, '全虚构集成配置员']);
    const limited = await first('INSERT INTO sys_account(login,display_name)VALUES($1,$2)RETURNING *', ['int_local_' + suffix, '全虚构本店配置员']);
    const reader = await first('INSERT INTO sys_account(login,display_name)VALUES($1,$2)RETURNING *', ['int_read_' + suffix, '全虚构只读员']);
    const stranger = await first('INSERT INTO sys_account(login,display_name)VALUES($1,$2)RETURNING *', ['int_other_' + suffix, '其他集团虚构员']);
    const scope = await first("INSERT INTO sys_data_scope(id,name,combinator)SELECT coalesce(max(id),0)+1,'全虚构集成隔离范围','intersection'FROM sys_data_scope RETURNING id");
    await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)VALUES($1,10,$2,'2000-01-01','ROLE','全虚构隔离验证')", [admin.id, scope.id]);
    for (const [account, gid, company, profile] of [[admin, group.id, null, 'demo'], [limited, group.id, own.id, 'hr_manager'], [reader, group.id, own.id, 'hr_manager'], [stranger, foreignGroup.id, foreign.id, 'hr_manager']]) {
      await db.query('INSERT INTO ty_test_account_profile(account_id,group_id,company_id,profile_code,seed_version)VALUES($1,$2,$3,$4,$5)', [account.id, gid, company, profile, 'INTEGRATION-TEST']);
      await db.query("INSERT INTO ty_access_grant(account_id,group_id,company_id,can_read,can_write,valid_from)VALUES($1,$2,$3,true,true,'2000-01-01')", [account.id, gid, company]);
    }
    async function grant(account, gid, company, actions, allow = ['*']) {
      const result = await first("INSERT INTO ty_auth_grant(group_id,subject_type,account_id,resource,actions,company_id,fields_allow,valid_from,reason,created_by)VALUES($1,'account',$2,'integration_manage',$3,$4,$5,'2000-01-01','全虚构完整授权',$6)RETURNING *", [gid, account.id, actions, company, allow, admin.id]);
      await db.query("INSERT INTO ty_auth_managed(account_id,group_id,resource)VALUES($1,$2,'integration_manage')ON CONFLICT DO NOTHING", [account.id, gid]); return result;
    }
    const localGrant = await grant(limited, group.id, own.id, ['read', 'write', 'sync']);
    const readerGrant = await grant(reader, group.id, own.id, ['read']);
    await grant(stranger, foreignGroup.id, foreign.id, ['read', 'write', 'sync']);
    const run = (name, input, actor = admin.id, key = randomUUID()) => tx(t => dispatchIntegrationCommand(t, { userId: actor, operation: 'system.integration.' + name, operationId: key, input }));
    const query = (input = {}, actor = admin.id) => tx(t => queryIntegrationWorkspace(t, { userId: actor, input: { group_id: group.id, ...input } }));
    const connectionInput = { group_id: group.id, company_id: own.id, provider: 'dingtalk', code: 'fixture-dt', name: '全虚构钉钉连接', status: 'active', config: { organization_id: 'fictional-org', app_id: 'fictional-app', source_timezone: 'Asia/Shanghai' } };
    const createKey = randomUUID(), created = await run('save', connectionInput, admin.id, createKey), connection = created.connection;
    check('connection is saved with unverified state and no silent network success', connection.id && connection.connection_state === 'not_configured' && created.network_verified === false);
    const replay = await run('save', connectionInput, admin.id, createKey);
    check('same actor operation key returns the same connection once', replay.replayed === true && String(replay.connection.id) === String(connection.id));
    await reject('changed body under the original operation key conflicts', () => run('save', { ...connectionInput, name: '修改同号内容' }, admin.id, createKey), /内容已变化/);
    await reject('ordinary config cannot hold secret fields recursively', () => run('save', { ...connectionInput, code: 'bad-secret', config: { ...connectionInput.config, app_secret: 'never-store-in-config' } }), /秘密/);
    await reject('gateway URL cannot smuggle credentials or query tokens', () => run('save', { ...connectionInput, code: 'bad-url', config: { ...connectionInput.config, gateway_url: 'https://user:pass@example.invalid/?token=fake' } }), /网关/);
    await reject('activation requires organization and application config', () => run('save', { ...connectionInput, code: 'missing-app', config: { organization_id: 'fictional-org' } }), /启用前/);
    await reject('read-only complete grant cannot modify a connection', () => run('validate', { connection_id: connection.id }, reader.id), /授权|范围/);
    await reject('unrelated group cannot use a known foreign connection ID', () => run('validate', { connection_id: connection.id }, stranger.id), /集团|范围/);
    await reject('company scoped actor cannot create another store connection', () => run('save', { ...connectionInput, code: 'wrong-store', company_id: other.id }, limited.id), /范围|授权/);
    delete process.env.TYHR_INTEGRATION_VAULT_KEY;
    const credentials = { app_id: 'fictional-app', app_secret: 'synthetic-secret-' + randomBytes(24).toString('hex') };
    await reject('missing vault key refuses credential persistence', () => run('secret', { connection_id: connection.id, credentials }), /加密密钥/);
    process.env.TYHR_INTEGRATION_VAULT_KEY = 'invalid-key';
    await reject('malformed vault key refuses persistence', () => run('secret', { connection_id: connection.id, credentials }), /32字节/);
    const key = randomBytes(32); process.env.TYHR_INTEGRATION_VAULT_KEY = key.toString('base64');
    const secretOperation = randomUUID(), secretResult = await run('secret', { connection_id: connection.id, credentials }, limited.id, secretOperation);
    check('first credential receipt is masked and contains no plaintext or ciphertext', secretResult.secret_configured === true && secretResult.credential_available === false && !JSON.stringify(secretResult).includes(credentials.app_secret) && !Object.keys(secretResult).some(k => /cipher|tag|iv/.test(k)));
    const encrypted = await first('SELECT * FROM ty_integration_connection WHERE id=$1', [connection.id]);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.secret_iv, 'base64'), { authTagLength: 16 }); decipher.setAAD(Buffer.from(['tyhr-integration-v1', group.id, connection.id, connection.provider, encrypted.secret_revision].join(':'))); decipher.setAuthTag(Buffer.from(encrypted.secret_tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.secret_cipher, 'base64')), decipher.final()]).toString('utf8');
    check('AES-GCM independently decrypts to the exact credential object', JSON.parse(plain).app_secret === credentials.app_secret && Buffer.from(encrypted.secret_iv, 'base64').length === 12);
    const tampered = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.secret_iv, 'base64')); tampered.setAAD(Buffer.from('wrong-connection-context')); tampered.setAuthTag(Buffer.from(encrypted.secret_tag, 'base64'));
    assert.throws(() => { tampered.update(Buffer.from(encrypted.secret_cipher, 'base64')); tampered.final(); }); check('AAD prevents transplanting ciphertext to another connection context', true);
    const stored = await first("SELECT result,input_hash FROM ty_platform_command WHERE actor_id=$1 AND operation='integration.secret' AND operation_key=$2", [limited.id, secretOperation]);
    const logs = await rows('SELECT metadata FROM ty_platform_audit WHERE group_id=$1', [group.id]), outbox = await rows('SELECT payload FROM ty_platform_outbox WHERE group_id=$1', [group.id]);
    check('persistent receipts audit and outbox do not contain credential material', !JSON.stringify([stored, logs, outbox]).includes(credentials.app_secret) && stored.result.credential_available === false);
    const secretReplay = await run('secret', { connection_id: connection.id, credentials }, limited.id, secretOperation);
    check('credential retry returns masked metadata without another encryption revision', secretReplay.replayed && (await first('SELECT secret_revision FROM ty_integration_connection WHERE id=$1', [connection.id])).secret_revision === 1);
    await reject('credential retry with different secret conflicts', () => run('secret', { connection_id: connection.id, credentials: { ...credentials, app_secret: 'different-synthetic' } }, limited.id, secretOperation), /内容已变化/);
    const validated = await run('validate', { connection_id: connection.id });
    check('capability check is explicitly not verified and not sent', validated.configuration_valid === true && validated.network_verified === false && validated.sent === false && validated.connection.connection_state === 'not_verified');
    const updatedSecret = await run('secret', { connection_id: connection.id, credentials: { ...credentials, app_secret: 'replacement-synthetic' } });
    const encrypted2 = await first('SELECT * FROM ty_integration_connection WHERE id=$1', [connection.id]);
    check('credential replacement creates a fresh IV revision and invalidates verification', updatedSecret.secret_revision === 2 && encrypted2.secret_iv !== encrypted.secret_iv && encrypted2.connection_state === 'not_verified');
    const sharedOperation = randomUUID(); await run('validate', { connection_id: connection.id }, admin.id, sharedOperation); await run('validate', { connection_id: connection.id }, limited.id, sharedOperation);
    check('different actors sharing an operation key each retain their outbox event', Number((await first('SELECT count(*) n FROM ty_platform_outbox WHERE event_key LIKE $1', ['%' + sharedOperation])).n) === 2);
    const ws = await query({ view: 'connections' }, reader.id);
    check('reader gets only authorized connection projection and false manage capability', ws.total === 1 && ws.rows[0].secret_configured && !('secret_cipher' in ws.rows[0]) && ws.capabilities.can_manage_integrations === false);
    await db.query('UPDATE ty_auth_grant SET fields_allow=$2 WHERE id=$1', [readerGrant.id, ['name']]);
    check('field-limited grant cannot leak the whole configuration record', (await query({ view: 'connections' }, reader.id)).total === 0);
    await db.query('UPDATE ty_auth_grant SET fields_allow=$2 WHERE id=$1', [readerGrant.id, ['*']]);
    const baselineEmployments = Number((await first('SELECT count(*) n FROM ty_employment')).n);
    const snapshot = { connection_id: connection.id, source_revision: 'fictional-source-v1', evidence_ref: '全虚构来源核定', departments: [{ id: 'EXT-D1', name: '虚构前厅' }], users: [{ id: 'EXT-U1', name: ownPerson.full_name, department_ids: ['EXT-D1'] }] };
    const snapKey = randomUUID(), snap = await run('snapshot', snapshot, limited.id, snapKey);
    const mappings = await query({ view: 'mappings' }, limited.id);
    check('snapshot creates unmatched review objects without name-based person merge', mappings.total === 2 && mappings.rows.every(row => row.state === 'unmatched' && row.local_id === null));
    check('snapshot keeps employment count unchanged', baselineEmployments === Number((await first('SELECT count(*) n FROM ty_employment')).n) && snap.employment_created === false);
    const snapReplay = await run('snapshot', snapshot, limited.id, snapKey), duplicateSource = await run('snapshot', snapshot, limited.id);
    check('request retry and same source version do not duplicate maps or jobs', snapReplay.replayed === true && duplicateSource.already_exists === true && Number((await first("SELECT count(*) n FROM ty_integration_job WHERE connection_id=$1 AND kind='snapshot'", [connection.id])).n) === 1);
    await reject('changed content under the same source version cannot overwrite history', () => run('snapshot', { ...snapshot, users: [{ id: 'EXT-U1', name: '改过的虚构姓名' }] }, limited.id), /来源版本内容已改变/);
    await reject('external snapshot duplicate IDs are rejected atomically', () => run('snapshot', { ...snapshot, source_revision: 'duplicate', users: [snapshot.users[0], snapshot.users[0]] }, limited.id), /重复/);
    await reject('snapshot cannot contain a cyclic external department tree', () => run('snapshot', { ...snapshot, source_revision: 'cycle', departments: [{ id: 'EXT-X', name: '虚构甲', parent_id: 'EXT-Y' }, { id: 'EXT-Y', name: '虚构乙', parent_id: 'EXT-X' }] }, limited.id), /循环/);
    await reject('snapshot rejects undeclared private data fields', () => run('snapshot', { ...snapshot, source_revision: 'private', users: [{ ...snapshot.users[0], identity_number: 'fictional-not-imported' }] }, limited.id), /不采集/);
    const personMap = mappings.rows.find(row => row.external_type === 'person'), departmentMap = mappings.rows.find(row => row.external_type === 'department');
    await reject('person source cannot be typed as company target', () => run('mapping', { mapping_id: personMap.id, local_type: 'company', local_id: own.id, expected_revision: personMap.revision, reason: '全虚构错误类型' }, limited.id), /只能对应/);
    await reject('same group foreign store person cannot cross the connection company scope', () => run('mapping', { mapping_id: personMap.id, local_type: 'person', local_id: otherPerson.id, expected_revision: personMap.revision, reason: '全虚构跨店拒绝' }, limited.id), /范围/);
    await reject('foreign group person is rejected', () => run('mapping', { mapping_id: personMap.id, local_type: 'person', local_id: foreignPerson.id, expected_revision: personMap.revision, reason: '全虚构跨集团拒绝' }), /不属于/);
    const confirmed = await run('mapping', { mapping_id: personMap.id, local_type: 'person', local_id: ownPerson.id, expected_revision: personMap.revision, reason: '全虚构人工身份核对' }, limited.id);
    check('authorized typed person mapping confirms an existing permanent identity only', confirmed.mapping.state === 'confirmed' && String(confirmed.mapping.person_id) === String(ownPerson.id) && confirmed.employment_created === false);
    await reject('stale mapping revision cannot overwrite a later decision', () => run('mapping', { mapping_id: personMap.id, local_type: 'person', local_id: ownPerson.id, expected_revision: personMap.revision, reason: '全虚构旧版本拒绝' }, limited.id), /版本已变化/);
    const depResult = await run('mapping', { mapping_id: departmentMap.id, local_type: 'department', local_id: department.id, expected_revision: departmentMap.revision, reason: '全虚构部门核对' }, limited.id);
    check('department mapping uses the correct typed target column', String(depResult.mapping.department_id) === String(department.id) && depResult.mapping.company_id === null && depResult.mapping.person_id === null);
    await reject('database rejects changing person source to company target', () => tx(t => t.query("UPDATE ty_integration_mapping SET local_type='company',company_id=$2,person_id=NULL WHERE id=$1", [personMap.id, own.id])), /混作|对照/);
    await reject('database rejects foreign group person even without the service', () => tx(t => t.query('UPDATE ty_integration_mapping SET person_id=$2 WHERE id=$1', [personMap.id, foreignPerson.id])), /集团范围/);
    await reject('database rejects same-group person outside connection company', () => tx(t => t.query('UPDATE ty_integration_mapping SET person_id=$2 WHERE id=$1', [personMap.id, otherPerson.id])), /公司范围/);
    await reject('database rejects changing external source identity', () => tx(t => t.query("UPDATE ty_integration_mapping SET external_id='REPLACED-ID'WHERE id=$1", [personMap.id])), /换绑/);
    await reject('database retains job source summary against direct edits', () => tx(t => t.query("UPDATE ty_integration_job SET summary='{}'::jsonb WHERE id=$1", [snap.job.id])), /不可改写/);
    await reject('database retains integration job against deletion', () => tx(t => t.query('DELETE FROM ty_integration_job WHERE id=$1', [snap.job.id])), /不可改写/);
    await db.query("UPDATE ty_integration_job SET state='completed'WHERE id=$1", [snap.job.id]);
    check('database permits job state progress without rewriting source evidence', (await first('SELECT * FROM ty_integration_job WHERE id=$1', [snap.job.id])).state === 'completed');

    await run('snapshot', { ...snapshot, source_revision: 'fictional-source-v2', users: [{ id: 'EXT-U1', name: '岑清沅改名', department_ids: ['EXT-D1'] }] }, limited.id);
    const changed = await first('SELECT * FROM ty_integration_mapping WHERE id=$1', [personMap.id]);
    check('changed external name requires review and preserves prior target without auto-remapping', changed.state === 'review' && String(changed.person_id) === String(ownPerson.id) && changed.confirmed_by === null);
    await run('snapshot', { ...snapshot, source_revision: 'fictional-source-v3', departments: [], users: [] }, limited.id);
    check('absence from a later snapshot does not delete mapping or imply resignation', !!await first('SELECT id FROM ty_integration_mapping WHERE id=$1', [personMap.id]) && baselineEmployments === Number((await first('SELECT count(*) n FROM ty_employment')).n));
    const jobs = await query({ view: 'jobs' }, limited.id);
    check('job list strips raw snapshot and keeps send/delivery separate', jobs.rows.every(job => !job.summary.snapshot && job.sent_status === 'not_sent' && job.delivery_status === 'not_sent'));
    const firstPage = await query({ view: 'mappings', page_size: 1, page: 2 }, limited.id);
    check('authorized mapping count and paging precede projection', firstPage.total === 2 && firstPage.page === 2 && firstPage.rows.length === 1);
    const searched = await query({ view: 'mappings', q: 'EXT-U1' }, limited.id);
    check('mapping search finds exact external source after authorization', searched.total === 1 && String(searched.rows[0].id) === String(personMap.id));
    await db.query("UPDATE ty_auth_grant SET status='revoked'WHERE id=$1", [localGrant.id]);
    await reject('revoked role cannot recover old masked command receipts by replay', () => run('secret', { connection_id: connection.id, credentials }, limited.id, secretOperation), /授权|范围/);
    await reject('revoked role cannot enumerate integration counts', () => query({ view: 'connections' }, limited.id), /授权|范围/);
    const beforeRollback = Number((await first('SELECT count(*) n FROM ty_integration_connection')).n), rollbackKey = randomUUID();
    await assert.rejects(tx(async t => { await dispatchIntegrationCommand(t, { userId: admin.id, operation: 'integration.save', operationId: rollbackKey, input: { ...connectionInput, code: 'must-rollback' } }); throw new Error('force rollback'); }), /force rollback/);
    check('authority record receipt and outbox roll back together', Number((await first('SELECT count(*) n FROM ty_integration_connection')).n) === beforeRollback && !await first('SELECT 1 FROM ty_platform_command WHERE operation_key=$1', [rollbackKey]) && !await first('SELECT 1 FROM ty_platform_outbox WHERE event_key LIKE $1', ['%' + rollbackKey]));
    return { passed, results, live_provider_calls: 0, synthetic_only: true };
  } finally { if (savedKey === undefined) delete process.env.TYHR_INTEGRATION_VAULT_KEY; else process.env.TYHR_INTEGRATION_VAULT_KEY = savedKey; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const base = process.env.TYHR_BASE_CODE || fileURLToPath(new URL('../../../开发/code/', import.meta.url)), require = createRequire(resolve(base, 'package.json'));
  let db;
  if (process.env.DATABASE_URL) { const { Client } = require('pg'); const client = new Client({ connectionString: process.env.DATABASE_URL }); await client.connect(); db = { query: (sql, args) => client.query(sql, args), exec: sql => client.query(sql), close: () => client.end() }; }
  else { const { PGlite } = require('@electric-sql/pglite'), { btree_gist } = require('@electric-sql/pglite/contrib/btree_gist'); db = await PGlite.create({ extensions: { btree_gist } }); }
  try {
    assert.equal(Number((await db.query("SELECT count(*) n FROM pg_tables WHERE schemaname='public'")).rows[0].n), 0, 'standalone suite requires an empty disposable database');
    await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
    for (const file of readdirSync(resolve(base, 'db')).filter(file => /^\d{3}_.*\.sql$/.test(file)).sort()) await db.exec(readFileSync(resolve(base, 'db', file), 'utf8'));
    if (!readdirSync(resolve(base, 'db')).includes('214_tyhr_platform.sql')) await db.exec(readFileSync(new URL('../db/214_tyhr_platform.sql', import.meta.url), 'utf8'));
    console.log(JSON.stringify({ status: 'passed', driver: process.env.DATABASE_URL ? 'PostgreSQL' : 'isolated PGlite', ...await runIntegrationTests({ db }) }, null, 2));
  } catch (error) { console.error(error.code || error.name, error.message); console.error(String(error.stack || '').split('\n').filter(line => line.includes('integration.test.mjs')).join('\n')); process.exitCode = 1; } finally { await db.close(); }
}
