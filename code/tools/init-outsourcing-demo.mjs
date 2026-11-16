import {verifyPassword} from '../app/services/auth.mjs';
import {readFile,writeFile,rename,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createApp} from '../app/server.mjs';
import {withTx} from '../app/db.mjs';
import {seed} from '../app/services/outsourcing-demo.mjs';
import {seed as accountMetadata} from '../app/services/test-accounts.mjs';
if(!process.argv.includes('--confirm-synthetic')||(!process.env.DATABASE_URL&&!process.env.PGLITE_DATA_DIR))throw new Error('Explicit persistent database and synthetic confirmation are required');
const file=resolve(process.env.TYHR_RUNTIME_DIR||'../.runtime','test-accounts.json'),previous=JSON.parse(await readFile(file,'utf8'));
const{db,server}=await createApp();
try{
 const actor=(await db.query("SELECT id FROM sys_account WHERE login='tyhr_admin'")).rows[0];if(!actor)throw new Error('Missing technical initializer');
 const shared=previous.accounts.find(a=>a.login==='demo')?.password;if(!shared)throw new Error('Local demo credential is missing');
 const receipt=await withTx(db,t=>seed(t,{userId:actor.id,input:{confirm_synthetic:true},passwordFactory:()=>shared}));
 const metadata=await withTx(db,t=>accountMetadata(t,{userId:actor.id,input:{group_id:receipt.group_id,confirm_synthetic:true,include_work_area_assignments:true}}));
 for(const a of metadata.accounts)a.password=previous.accounts.find(p=>String(p.account_id)===String(a.account_id))?.password||receipt.created_accounts.find(p=>String(p.account_id)===String(a.account_id))?.password||null;
 for(const a of metadata.accounts.filter(a=>!a.password)){const hash=(await db.query('SELECT c.pwd_hash FROM sys_user_credential c JOIN ty_test_account_profile p ON p.account_id=c.user_id WHERE c.user_id=$1 AND p.seed_version=$2',[a.account_id,'TY-OUTSOURCE-v1'])).rows[0]?.pwd_hash;if(hash&&verifyPassword(shared,hash))a.password=shared;}
 if(metadata.accounts.some(a=>!a.password))throw new Error('Missing local credentials; document not overwritten');
 const temp=file+'.tmp';await writeFile(temp,JSON.stringify({...metadata,local_test_credentials:true,generated_at:new Date().toISOString()},null,2),{mode:0o600});await chmod(temp,0o600);await rename(temp,file);await chmod(file,0o600);
 const{created_accounts,...safe}=receipt;console.log(JSON.stringify({...safe,total_accounts:metadata.total_accounts,employee_accounts:metadata.employee_accounts}));
}finally{server.close();await db.close();}
