// Explicit forward migrations for databases initialized with a trusted ledger.
import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDb,withTx } from '../app/db.mjs';
const folder=fileURLToPath(new URL('../db/',import.meta.url));
const files=readdirSync(folder).filter(f=>/^\d{3}_.*\.sql$/.test(f)).sort();
const at=process.argv.indexOf('--only'),chosen=at<0?[]:String(process.argv[at+1]||'').split(',');
const dry=process.argv.includes('--dry-run');
if(!process.env.DATABASE_URL||!chosen.length||chosen.some(x=>!/^\d{3}$/.test(x)))throw new Error('需提供DATABASE_URL与显式迁移编号：--only 195,196,197；备份后执行');
const selected=files.filter(f=>chosen.includes(f.slice(0,3)));
if(selected.length!==new Set(chosen).size)throw new Error('迁移编号不存在或不唯一');
const hash=f=>createHash('sha256').update(readFileSync(folder+f)).digest('hex');
const db=await createDb({url:process.env.DATABASE_URL});
try{
  const ledgerExists=(await db.query("SELECT to_regclass('public.schema_migration') IS NOT NULL ok")).rows[0].ok;
  if(!ledgerExists)throw new Error('缺少可信迁移账本。停止前滚；请先审查现有库，不能猜测或自动接纳历史。');
  const done=new Map((await db.query('SELECT file,sha256 FROM schema_migration')).rows.map(r=>[r.file,r.sha256.trim()]));
  if(!done.size)throw new Error('迁移账本为空，禁止按已有库推断基线');
  for(const [file,digest] of done){if(!files.includes(file)||hash(file)!==digest)throw new Error(`已应用迁移内容不一致：${file}`);}
  const planned=new Set([...done.keys(),...selected]);
  for(const f of selected)for(const previous of files.filter(x=>x<f))if(!planned.has(previous))throw new Error(`迁移顺序不完整，缺少 ${previous}`);
  for(const file of selected){
    if(done.has(file)){console.log(`已核对：${file}`);continue;}
    if(dry){console.log(`待应用：${file}`);continue;}
    await withTx(db,async tx=>{
      await tx.query("SELECT pg_advisory_xact_lock(20261116,195)");
      const existing=(await tx.query('SELECT sha256 FROM schema_migration WHERE file=$1',[file])).rows[0];
      if(existing){if(existing.sha256.trim()!==hash(file))throw new Error('并发迁移哈希不同');return;}
      await tx.exec(readFileSync(folder+file,'utf8'));
      await tx.query('INSERT INTO schema_migration(file,sha256,note) VALUES($1,$2,$3)',[file,hash(file),'explicit checked forward migration']);
    });
    console.log(`已应用：${file}`);
  }
}finally{await db.close();}
