import assert from'node:assert/strict';
import{spawnSync}from'node:child_process';
import{mkdtemp,readFile,stat,rm}from'node:fs/promises';
import{tmpdir}from'node:os';import{join}from'node:path';
import{fileURLToPath}from'node:url';
import{createDb}from'../app/db.mjs';
if(!process.env.DATABASE_URL||!/^\/tyhr_verify_[a-f0-9]{16}$/.test(new URL(process.env.DATABASE_URL).pathname))throw Error('Only a runner-owned random empty PostgreSQL is permitted');
const dir=await mkdtemp(join(tmpdir(),'tyhr-init-current-'));let db,checks=0;const check=(label,ok)=>{assert.ok(ok,label);checks++;console.log('PASS '+label);};
try{
 const env={...process.env,TYHR_RUNTIME_DIR:dir};for(const key of['TYHR_ADMIN_PASSWORD','SEED_SKIP','PGLITE_DATA_DIR','CONTROL_URL'])delete env[key];
 const execute=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../tools/init-workspace.mjs',import.meta.url))],{env,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 const first=execute();check('explicit administrator initialization succeeds without legacy seed flag',first.status===0);
 const file=join(dir,'workspace-access.json'),access=JSON.parse(await readFile(file,'utf8'));check('initial credential is written only to the private local file',access.login==='tyhr_admin'&&typeof access.password==='string'&&access.password.length>=8&&(await stat(file)).mode%512===384&&!first.stdout.includes(access.password)&&!first.stderr.includes(access.password));
 db=await createDb({url:process.env.DATABASE_URL});const facts=async()=>(await db.query("SELECT(SELECT count(*)FROM ty_group)::int groups,(SELECT count(*)FROM ty_person)::int people,(SELECT count(*)FROM ty_test_account_profile)::int demonstration_accounts,(SELECT count(*)FROM ty_pay_batch)::int wage_batches")).rows[0];
 check('first production initialization creates no demonstration group person profile or wages',Object.values(await facts()).every(n=>n===0));
 const before=(await db.query('SELECT*FROM sys_user_credential WHERE user_id=$1',[access.account_id])).rows[0];check('initialized administrator has an actual credential',!!before);
 const second=execute();check('repeat initialization succeeds without resetting credentials',second.status===0&&second.stdout.includes('保留现有管理员账号'));
 const after=(await db.query('SELECT*FROM sys_user_credential WHERE user_id=$1',[access.account_id])).rows[0];check('repeat initialization preserves the exact stored credential',JSON.stringify(before)===JSON.stringify(after));
 check('repeat initialization still creates no demonstration business records',Object.values(await facts()).every(n=>n===0));
 console.log(JSON.stringify({suite:'explicit-empty-production-initialization',driver:db.driver,checks,passed:checks,external_calls:0,implicit_demonstration_records:0}));
}finally{await db?.close();await rm(dir,{recursive:true,force:true});}
