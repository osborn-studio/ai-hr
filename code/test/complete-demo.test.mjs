// Full normal factory on an owned empty PostgreSQL. Historical demos are never
// accepted as test targets, even when initialization is explicitly requested.
import assert from'node:assert/strict';
import{randomBytes,createHash}from'node:crypto';
import{mkdtemp,readFile,readdir,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';
import{createCompleteDemo}from'../tools/seed-complete-demo.mjs';import{createDb}from'../app/db.mjs';
if(!process.env.DATABASE_URL||!/^\/tyhr_verify_[a-f0-9]{16}$/.test(new URL(process.env.DATABASE_URL).pathname))throw Error('Only a runner-owned random empty verification database is permitted');
const migrationDir=new URL('../db/',import.meta.url),files=(await readdir(migrationDir)).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort(),expected=new Map();
for(const[index,file]of files.entries()){assert.equal(Number(file.slice(0,3)),index+1,'one continuous migration list');expected.set(file,createHash('sha256').update(await readFile(new URL(file,migrationDir))).digest('hex'));}
const directory=await mkdtemp(join(tmpdir(),'tyhr-complete-current-')),password=randomBytes(22).toString('base64url');
process.env.TYHR_DEMO_OWNED_EMPTY='1';process.env.TYHR_INTEGRATION_VAULT_KEY=randomBytes(32).toString('base64');process.env.TYHR_DATA_VAULT_KEY=randomBytes(32).toString('base64');process.env.TYHR_PAYROLL_SCRIPT_SANDBOX='quickjs-wasm-v1';process.env.TYHR_ESIGN_ALLOW_LIVE='0';let db;
try{
 const result=await createCompleteDemo({confirmSynthetic:true,outputDirectory:directory,password});
 assert.equal(result.version,'TY-NATURAL-RESTAURANT-V5');assert.equal(result.complete,true);assert.equal(result.migrations,files.length);assert.equal(result.people,62);assert.equal(result.accounts,77);assert.equal(result.stores,20);
 db=await createDb({url:process.env.DATABASE_URL});const ledger=(await db.query('SELECT file,sha256 FROM schema_migration ORDER BY file')).rows;assert.equal(ledger.length,expected.size);for(const row of ledger)assert.equal(row.sha256.trim(),expected.get(row.file));
 const scene=async name=>JSON.parse(await readFile(join(directory,name),'utf8')),time=await scene('time-workflow-scenes.json'),notices=await scene('workflow-notification-scenes.json'),recruiting=await scene('recruiting-scenes.json'),esign=await scene('esign-scenes.json');
 assert.equal(time.complete,true);assert.equal(time.scenes.length,7);assert.equal(notices.complete,true);assert.equal(notices.scenes.length,5);assert.equal(notices.changed_permissions,0);assert.equal(recruiting.complete,true);assert.equal(recruiting.scenes.length,11);assert.equal(esign.complete,true);assert.equal(esign.scenes.length,11);assert.equal(esign.provider_flows,0);assert.equal(esign.provider_verified_signatures,0);assert.equal(esign.changed_existing_contracts,0);assert.equal(esign.changed_structured_terms,0);
 assert.equal(Number((await db.query('SELECT count(*)n FROM ty_es_intent WHERE remote_flow_id IS NOT NULL OR signed_file_id IS NOT NULL OR receipt_cipher IS NOT NULL')).rows[0].n),0,'demo signing data stays before any external signature or verification');
 for(const filename of await readdir(directory))assert.ok(!(await readFile(join(directory,filename),'utf8')).includes(password),'indices never contain initial credentials');
 const count=async()=>(await db.query('SELECT(SELECT count(*)FROM ty_person)::int people,(SELECT count(*)FROM ty_workflow_instance)::int instances,(SELECT count(*)FROM ty_hr_contract)::int contracts,(SELECT count(*)FROM ty_rc_root)::int recruiting')).rows[0],before=await count();
 await assert.rejects(()=>createCompleteDemo({confirmSynthetic:true,outputDirectory:directory,password}),/不是空库/);assert.deepEqual(await count(),before);
 assert.deepEqual((await readdir(migrationDir)).filter(n=>/^\d{3}_.*\.sql$/.test(n)).sort(),files,'migration list remains the same throughout verification');
 console.log(JSON.stringify({suite:'complete-demo-current',migrations:files.length,ledger_hashes_verified:true,people:62,accounts:77,stores:20,additional_scenes:34,repeat_existing_database_rejected:true,credentials_in_indices:false,external_calls:0}));
}finally{await db?.close();await rm(directory,{recursive:true,force:true});}
