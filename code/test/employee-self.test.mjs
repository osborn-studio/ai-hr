// Self-service wages must use the authenticated identity and confirmed rows.
import assert from 'node:assert/strict';
import {createApp} from '../app/server.mjs';
import {withTx} from '../app/db.mjs';
import {seed} from '../app/services/test-workspace.mjs';
import {hashPassword} from '../app/services/auth.mjs';
import {issue} from '../app/services/session.mjs';
import {payroll} from '../app/services/employee-self.mjs';

process.env.SEED_SKIP='1';
const {db,server}=await createApp();let n=0;
const check=(label,value)=>{assert.ok(value,label);n++;console.log('PASS '+label);};
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
try{
  await db.query("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES(1000,'self_test_admin','虚构自助测试管理员')");
  const scope=(await q("INSERT INTO sys_data_scope(id,name,combinator) SELECT coalesce(max(id),0)+1,'虚构启动范围','intersection' FROM sys_data_scope RETURNING id"))[0].id;
  await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason) VALUES(1000,10,$1,current_date,'ROLE','synthetic test')",[scope]);
  const receipt=await withTx(db,tx=>seed(tx,{userId:1000,input:{confirm_synthetic:true}}));
  const persons=await q('SELECT p.*,e.company_id FROM ty_person p JOIN ty_employment e ON e.person_id=p.id AND e.status=\'active\' ORDER BY p.id LIMIT 2');
  for(const [i,p] of persons.entries()){
    const uid=2000+i;
    await db.query('INSERT INTO sys_account(id,login,display_name,person_id) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)',[uid,`self_test_${i}`,p.full_name,p.legacy_person_id]);
    await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason) VALUES($1,17,$2,'2026-01-01','ROLE','synthetic self only')",[uid,receipt.ids.legacy.scope_id]);
    await db.query("INSERT INTO ty_test_account_profile(account_id,group_id,person_id,company_id,profile_code,seed_version) VALUES($1,$2,$3,$4,'store_staff','SELF-TEST')",[uid,p.group_id,p.id,p.company_id]);
    await db.query('SELECT fn_credential_set($1,$2)',[uid,hashPassword('SyntheticSelf2026!')]);
  }
  const first=await withTx(db,tx=>payroll(tx,{userId:2000}));
  const second=await withTx(db,tx=>payroll(tx,{userId:2001}));
  check('每个员工只取得一张已确认的十一月工资',first.rows.length===1&&second.rows.length===1&&first.rows[0].period==='2026-11');
  check('本人身份来自账号绑定而不是请求参数',first.rows[0].person_number===persons[0].person_number&&second.rows[0].person_number===persons[1].person_number);
  check('跨地区人员保留本人港元工资',first.rows[0].region_code==='HK'&&first.rows[0].currency==='HKD');
  check('不包含未核验历史和十二月草稿',first.rows.every(r=>r.period!=='2026-10'&&r.period!=='2026-12'));
  check('金额和明细保留而来源及其他人资料不返回',first.rows[0].totals.net_pay&&first.rows[0].items.length>0&&!JSON.stringify(first).includes('source_data')&&!JSON.stringify(first).includes('input_overrides')&&!JSON.stringify(first).includes(persons[1].person_number));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const token=(await withTx(db,tx=>issue(tx,{userId:2000}))).token;
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=path=>fetch(base+path,{headers:{authorization:`Bearer ${token}`}});
  const response=await get('/api/customer-payroll/my');
  check('本人入口在HTTP层可用且只返回本人',response.status===200&&(await response.json()).rows[0].person_number===persons[0].person_number);
  for(const query of ['person_id=2','employee_id=2','company_id=2','period=2026-12']){
    check('拒绝自助入口的外部范围 '+query,(await get('/api/customer-payroll/my?'+query)).status===422);
  }
  const anonymous=await fetch(base+'/api/customer-payroll/my');check('未登录不能读取工资',anonymous.status===401);
  await db.query('DELETE FROM sys_user_role WHERE user_id=2000');
  await assert.rejects(()=>withTx(db,tx=>payroll(tx,{userId:2000})),/E_TY_FORBIDDEN/);n++;console.log('PASS 失去工资读权限后立即拒绝');
  await db.query('DELETE FROM ty_test_account_profile WHERE account_id=2001');
  check('缺少明确账号与人员映射时不猜测身份',(await withTx(db,tx=>payroll(tx,{userId:2001}))).rows.length===0);
  console.log(`员工本人工资 · ${n} 条通过 · 驱动 ${db.driver}`);
}finally{if(server.listening)await new Promise(resolve=>server.close(resolve));await db.close();}
