import assert from'node:assert/strict';
import{createDb,withTx}from'../app/db.mjs';
import{runWorkflowNotificationTests}from'./workflow-notifications.test.mjs';
import{queryWorkspace}from'../app/services/platform.mjs';
const db=await createDb({url:process.env.DATABASE_URL||undefined});let checks=0;
const check=(name,ok)=>{assert.ok(ok,name);checks++;console.log('PASS '+name);};
try{
 const f=await runWorkflowNotificationTests({db,installSchema:true});
 await db.exec("INSERT INTO sys_account(id,login,display_name)OVERRIDING SYSTEM VALUE VALUES(5110,'notice_service_member','周知衡'),(5111,'notice_other_company','陈之南');INSERT INTO ty_company(id,group_id,ledger_id,code,name)SELECT 5111,group_id,ledger_id,'NOTICE-SOUTH','香香鱼米徐汇店'FROM ty_company WHERE id=5100;INSERT INTO ty_test_account_profile(account_id,group_id,company_id,profile_code,seed_version)VALUES(5110,5100,5100,'outsourced_staff','NOTICE-OPTIONS'),(5111,5100,5111,'outsourced_staff','NOTICE-OPTIONS');");
 const read=(view,userId=f.actors.author)=>withTx(db,t=>queryWorkspace(t,{userId,input:{kind:'permissions',view,group_id:f.group_id,company_id:f.company_id,q:'',page:1,page_size:100}}));
 const approve=await read('options'),notify=await read('notification_options');
 check('outsourced member is available for scoped notification selection without becoming an approval candidate',!approve.rows.some(r=>String(r.id)==='5110')&&notify.rows.some(r=>String(r.id)==='5110'&&r.eligible_for_notification===true&&r.eligible_for_approval===false));
 check('recipient directory does not expose a member from a different selected company',!notify.rows.some(r=>String(r.id)==='5111'));
 check('configuration-only identity is never a business notice recipient',!notify.rows.some(r=>String(r.id)===String(f.actors.config)));
 check('recipient candidates expose only directory metadata',Object.keys(notify.rows.find(r=>String(r.id)==='5110')).every(k=>['id','display_name','company_name','role_labels','eligible_for_approval','eligible_for_notification'].includes(k)));
 await db.query("INSERT INTO ty_auth_managed(account_id,group_id,resource)VALUES($1,$2,'workflow_manage'),($1,$2,'system_configuration')ON CONFLICT DO NOTHING",[f.actors.applicant,f.group_id]);
 await assert.rejects(()=>read('notification_options',f.actors.applicant));checks++;console.log('PASS an employee without design or configuration authority cannot enumerate the workflow recipient directory');
 await db.query("UPDATE sys_account SET status='disabled'WHERE id=5110");
 check('disabled members disappear from notification selection before count and paging',!(await read('notification_options')).rows.some(r=>String(r.id)==='5110'));
 await db.query('UPDATE ty_operator_binding SET company_id=5111,revision=revision+1 WHERE account_id=$1',[f.actors.applicant]);
 const portal=(view,company)=>withTx(db,t=>queryWorkspace(t,{userId:f.actors.applicant,input:{kind:'portal',view,group_id:f.group_id,...(company?{company_id:company}:{}),page:1,page_size:100}}));
 check('all-authorized portal keeps readable original-store applications after current operator store changes',(await portal('requests')).rows.some(r=>String(r.id)===String(f.instances.approved.id)));
 check('all-authorized notices retain original-store source access without extending any grant',(await portal('alerts')).rows.some(r=>String(r.instance_id)===String(f.instances.approved.id)));
 check('explicit current-store selection still filters original-store applications',!(await portal('requests',5111)).rows.some(r=>String(r.id)===String(f.instances.approved.id)));
 console.log(JSON.stringify({suite:'workflow-notification-options',driver:db.driver,checks,passed:checks,base_notification_checks:f.passed,external_calls:0}));
}finally{await db.close();}
