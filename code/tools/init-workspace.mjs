// Explicit local initialization: no customer imports or implicit password changes.
import { createApp } from '../app/server.mjs';
import { withTx } from '../app/db.mjs';
import { hashPassword } from '../app/services/auth.mjs';
import { seedDemo } from '../app/services/foundation.mjs';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
if (!process.env.PGLITE_DATA_DIR && !process.env.DATABASE_URL) throw new Error('请明确指定 PGLITE_DATA_DIR 或 DATABASE_URL');
const { db, server } = await createApp();
try {
  let password = process.env.TYHR_ADMIN_PASSWORD;
  let created = false;
  const account = await withTx(db, async tx => {
    const old = (await tx.query("SELECT * FROM sys_account WHERE login='tyhr_admin'")).rows[0];
    if (old) {
      if (password) await tx.query('SELECT fn_credential_set($1,$2)', [old.id,hashPassword(password)]);
      return old;
    }
    password ||= randomBytes(12).toString('base64url');
    const n = (await tx.query(`SELECT greatest(1000,
      coalesce((SELECT max(id)+1 FROM sys_account),0),
      coalesce((SELECT max(user_id)+1 FROM sys_user_credential),0),
      coalesce((SELECT max(user_id)+1 FROM sys_user_role),0)) id`)).rows[0].id;
    const a = (await tx.query("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES($1,'tyhr_admin','天意基础管理员') RETURNING *",[n])).rows[0];
    const scope = (await tx.query('SELECT id FROM sys_data_scope ORDER BY id LIMIT 1')).rows[0];
    if(!scope) throw new Error('缺少基础授权范围，初始化未提交');
    await tx.query(`INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)
      VALUES($1,10,$2,current_date,'ROLE','本地显式初始化管理员')`,[a.id,scope.id]);
    await tx.query('SELECT fn_credential_set($1,$2)',[a.id,hashPassword(password)]);
    await tx.query("SELECT setval(pg_get_serial_sequence('sys_account','id'),(SELECT max(id) FROM sys_account))");
    created=true;return a;
  });
  if(process.argv.includes('--demo')) {
    const result=await withTx(db, tx=>seedDemo(tx,{userId:account.id}));
    console.log(result.message || '虚构基础演示已存在，未重复创建');
  }
  if(password) {
    const dir=resolve(process.env.TYHR_RUNTIME_DIR || '../.runtime');
    await mkdir(dir,{recursive:true,mode:0o700});
    const file=resolve(dir,'workspace-access.json');
    await writeFile(file,JSON.stringify({account_id:account.id,login:account.login,password,local_development_only:true},null,2),{mode:0o600});
    console.log(`账号 ${account.id}，本地访问资料已保存：${file}`);
  } else console.log(`保留现有管理员账号 ${account.id} 及原口令`);
  console.log(created?'初始化完成':'初始化检查完成');
} finally {server.close();await db.close();}
