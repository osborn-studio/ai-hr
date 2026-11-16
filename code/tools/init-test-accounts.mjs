// Credentials stay in the local runtime directory, never stdout or Git.
import {readFile,writeFile,mkdir,chmod,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createApp} from '../app/server.mjs';
import {withTx} from '../app/db.mjs';
import {seed} from '../app/services/test-accounts.mjs';

if(!process.argv.includes('--confirm-synthetic'))throw new Error('必须显式 --confirm-synthetic');
if(!process.env.DATABASE_URL&&!process.env.PGLITE_DATA_DIR)throw new Error('请明确指定持久化数据库');
const {db,server}=await createApp();
try{
 const arg=process.argv.indexOf('--group');
 const group=(await db.query(arg>=0?'SELECT id FROM ty_group WHERE id=$1':"SELECT id FROM ty_group WHERE code='TY-TEST'",arg>=0?[Number(process.argv[arg+1])]:[])).rows[0];
 if(!group)throw new Error('请先初始化TY-TEST虚构工作区');
 const actor=(await db.query("SELECT id FROM sys_account WHERE login='tyhr_admin' AND status='active'")).rows[0];
 if(!actor)throw new Error('缺少本地技术初始化账号');
 const dir=resolve(process.env.TYHR_RUNTIME_DIR||'../.runtime');await mkdir(dir,{recursive:true,mode:0o700});
 const file=resolve(dir,'test-accounts.json');let old=null;
 try{old=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const result=await withTx(db,tx=>seed(tx,{userId:actor.id,input:{group_id:group.id,confirm_synthetic:true,include_work_area_assignments:process.argv.includes('--work-areas')}}));
 for(const a of result.accounts)if(!a.password&&String(old?.group_id)===String(result.group_id))a.password=old?.accounts?.find(o=>String(o.account_id)===String(a.account_id))?.password||null;
 const document={...result,local_test_credentials:true,generated_at:new Date().toISOString()};
 const temp=file+'.tmp';await writeFile(temp,JSON.stringify(document,null,2),{mode:0o600});await chmod(temp,0o600);await rename(temp,file);await chmod(file,0o600);
 console.log(JSON.stringify({group_id:result.group_id,created:result.created,employee_accounts:result.employee_accounts,function_accounts:result.function_accounts,total_accounts:result.total_accounts,
  added_secondary_assignments:result.added_secondary_assignments,credentials_file:file,missing_local_passwords:result.accounts.filter(a=>!a.password).length}));
}finally{server.close();await db.close();}
