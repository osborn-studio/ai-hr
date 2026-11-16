// Explicitly initializes the fully fictional product test organization.
import { createApp } from '../app/server.mjs';
import { withTx } from '../app/db.mjs';
import { seed } from '../app/services/test-workspace.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
if(!process.argv.includes('--confirm-synthetic'))throw new Error('需明确 --confirm-synthetic；此入口仅创建全虚构测试资料');
if(!process.env.DATABASE_URL&&!process.env.PGLITE_DATA_DIR)throw new Error('请明确指定持久化数据库');
const strategyAt=process.argv.indexOf('--strategy');
const {db,server}=await createApp();
try{
  const account=(await db.query("SELECT id FROM sys_account WHERE login='tyhr_admin' AND status='active'")).rows[0];
  if(!account)throw new Error('请先运行init-workspace.mjs建立本地管理员');
  const receipt=await withTx(db,tx=>seed(tx,{userId:account.id,input:{confirm_synthetic:true,
    ...(strategyAt>=0?{selected_aggregation:process.argv[strategyAt+1]}:{})}}));
  const dir=resolve(process.env.TYHR_RUNTIME_DIR||'../.runtime');await mkdir(dir,{recursive:true,mode:0o700});
  await writeFile(resolve(dir,'test-workspace-receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
  console.log(JSON.stringify({group_id:receipt.group_id,seeded:receipt.seeded,complete:receipt.complete,summary:receipt.summary,selected_aggregation:receipt.selected_aggregation}));
}finally{server.close();await db.close();}
