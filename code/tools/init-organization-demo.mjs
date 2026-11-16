// Explicit local upgrade; passwords remain in the runtime-only account file.
import {readFile,writeFile,rename,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createApp} from '../app/server.mjs';
import {withTx} from '../app/db.mjs';
import {upgradeDemo} from '../app/services/organization.mjs';
import {seedOctober} from '../app/services/advanced-time-demo.mjs';
import {seed as accountMetadata} from '../app/services/test-accounts.mjs';
if(!process.argv.includes('--confirm-synthetic')||(!process.env.DATABASE_URL&&!process.env.PGLITE_DATA_DIR))throw new Error('Explicit persistent database and --confirm-synthetic are required');
const file=resolve(process.env.TYHR_RUNTIME_DIR||'../.runtime','test-accounts.json');
const previous=JSON.parse(await readFile(file,'utf8'));
const {db,server}=await createApp();
try{
 const actor=(await db.query("SELECT id FROM sys_account WHERE login='tyhr_admin' AND status='active'")).rows[0];if(!actor)throw new Error('Missing technical initializer');
 const shared=previous.accounts.find(a=>a.login==='demo')?.password;if(!shared)throw new Error('Local demo password is missing');
 const org=await withTx(db,t=>upgradeDemo(t,{userId:actor.id,passwordFactory:()=>shared}));
 const accounts=await withTx(db,t=>accountMetadata(t,{userId:actor.id,input:{group_id:org.group_id,confirm_synthetic:true,include_work_area_assignments:true}}));
 for(const a of accounts.accounts)a.password=previous.accounts.find(p=>String(p.account_id)===String(a.account_id))?.password||org.created_accounts.find(p=>String(p.account_id)===String(a.account_id))?.password||null;
 if(accounts.accounts.some(a=>!a.password))throw new Error('Some local passwords are missing; account document not replaced');
 const temp=file+'.tmp';await writeFile(temp,JSON.stringify({...accounts,local_test_credentials:true,generated_at:new Date().toISOString()},null,2),{mode:0o600});await chmod(temp,0o600);await rename(temp,file);await chmod(file,0o600);
 const time=await withTx(db,t=>seedOctober(t,{userId:actor.id,input:{confirm_synthetic:true}}));
 console.log(JSON.stringify({group_id:org.group_id,companies:org.companies,director_logins:org.director_logins,total_accounts:accounts.total_accounts,attendance:time}));
}finally{server.close();await db.close();}
