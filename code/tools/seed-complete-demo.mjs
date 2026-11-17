import{seedContractPayrollDemo}from'./seed-contract-payroll-demo.mjs';
import{seedLeavePayrollHongKongDemo}from'./seed-leave-payroll-demo.mjs';
// A reproducible, empty-database-only restaurant scenario. It never rewrites
// an older demonstration, customer data, passwords or closed payroll history.
import{randomUUID}from'node:crypto';import{resolve}from'node:path';import{pathToFileURL}from'node:url';import{mkdir,writeFile,rename}from'node:fs/promises';
import{createDb,withTx}from'../app/db.mjs';import{createApp}from'../app/server.mjs';
import{seed as seedWorkspace}from'../app/services/test-workspace.mjs';import{seed as seedAccounts}from'../app/services/test-accounts.mjs';import{upgradeDemo}from'../app/services/organization.mjs';import{seedOctober}from'../app/services/advanced-time-demo.mjs';import{seed as seedOutsourcing}from'../app/services/outsourcing-demo.mjs';
import{seedPersonalPortalDemo}from'./seed-personal-portal-demo.mjs';import{seedIntegrationDemo}from'./seed-integration-runtime-demo.mjs';
import{seedTimeWorkflowDemo}from'./seed-time-workflow-demo.mjs';import{seedWorkflowNotificationDemo}from'./seed-workflow-notification-demo.mjs';
import{seedWorkflowNotificationsDemo}from'./seed-workflow-notifications-demo.mjs';import{approvedNotificationOrigin}from'../app/services/notification-integration.mjs';
import{seedRecruitingSourcesDemo}from'./seed-recruiting-sources-demo.mjs';import{seedEsignDemo}from'./seed-esign-demo.mjs';
import{seedWorkforceNativeDemo}from'./seed-workforce-native-demo.mjs';import{seedPayrollFinanceDemo}from'./seed-payroll-finance-demo.mjs';import{seedPayrollScriptDemo}from'./seed-payroll-script-demo.mjs';
import{seedAdvancedLeaveDemo}from'./seed-advanced-leave-demo.mjs';import{seedPeopleServicesDemo}from'./seed-people-services-demo.mjs';import{seedTimeV2Demo}from'./seed-time-v2-demo.mjs';import{seedNativeHrDemo}from'./seed-native-hr-demo.mjs';import{seedStandardPayrollDemo}from'./seed-standard-payroll-demo.mjs';import{seedPerformanceDemo}from'./seed-performance-native-demo.mjs';import{seedLearningDemo}from'./seed-learning-native-demo.mjs';

const fail=message=>{throw new Error(message);};
async function privateJson(directory,name,value){await mkdir(directory,{recursive:true,mode:0o700});const path=resolve(directory,name),temp=path+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,path);}

export async function createCompleteDemo({confirmSynthetic=false,outputDirectory,password,notificationOrigin}={}){
 if(confirmSynthetic!==true||process.env.TYHR_DEMO_OWNED_EMPTY!=='1')fail('须明确confirmSynthetic及TYHR_DEMO_OWNED_EMPTY=1，只接受新建空演示数据库');
 if(!process.env.DATABASE_URL||process.env.CONTROL_URL||process.env.PGLITE_DATA_DIR)fail('完整演示只使用明确的专用PostgreSQL空库');
 if(typeof password!=='string'||password.length<5||typeof outputDirectory!=='string'||!outputDirectory.length)fail('须在受控环境提供至少5位初始密码及本地场景输出目录');
 const noticeOrigin=approvedNotificationOrigin(notificationOrigin??process.env.TYHR_NOTIFICATION_DEMO_ORIGIN);
 const preflight=await createDb({url:process.env.DATABASE_URL});try{if(Number((await preflight.query("SELECT count(*)n FROM pg_tables WHERE schemaname='public'")).rows[0].n)!==0)fail('目标数据库不是空库；保留并停止，不覆盖已有资料');}finally{await preflight.close();}
 const app=await createApp({skipDemoSeed:true}),db=app.db,operator=9000;
 try{
  await db.exec("INSERT INTO sys_account(id,login,display_name)OVERRIDING SYSTEM VALUE VALUES(9000,'tyhr_demo_bootstrap','演示帐套初始化');INSERT INTO sys_data_scope(id,name,combinator)VALUES(9000,'演示初始化范围','intersection');INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)VALUES(9000,10,9000,'2026-01-01','ROLE','owned empty synthetic restaurant scenario bootstrap')");
  // This policy belongs only to the newly created demonstration database.
  // No credential or policy in an existing database is accepted or rewritten.
  await db.query("INSERT INTO policy_value(policy_code,effective_from,value_num,published_by,reason)VALUES('PWD_MIN_LEN',app_today(),$1,'demo_bootstrap','演示帐套初始口令策略')",[Math.min(8,password.length)]);
  await db.query("INSERT INTO policy_value(policy_code,effective_from,value_text,published_by,reason)VALUES('PWD_NEED_MIX',app_today(),'false','demo_bootstrap','演示帐套初始口令策略')");
  const phase=async(name,fn)=>{const result=await fn();console.log(JSON.stringify({phase:name,completed:true}));return result;};
  const workspace=await phase('organization_people',()=>withTx(db,t=>seedWorkspace(t,{userId:operator,input:{confirm_synthetic:true}})));
  await phase('accounts',()=>withTx(db,t=>seedAccounts(t,{userId:operator,input:{group_id:workspace.group_id,confirm_synthetic:true,include_work_area_assignments:true},passwordFactory:()=>password})));
  await phase('group_brand_store',()=>withTx(db,t=>upgradeDemo(t,{userId:operator,passwordFactory:()=>password})));
  await phase('october_schedules_and_history',()=>withTx(db,t=>seedOctober(t,{userId:operator,input:{confirm_synthetic:true}})));
  await phase('vendors_and_names',()=>withTx(db,t=>seedOutsourcing(t,{userId:operator,input:{confirm_synthetic:true},passwordFactory:()=>password})));
  // These October facts precede the dated November functional appointments.
  // The ordering preserves the actual employee/store histories and payroll roots.
  const leave=await phase('leave',()=>seedAdvancedLeaveDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'leave-scenes.json',leave);
  const people=await phase('dormitory_certificates_goods',()=>seedPeopleServicesDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'people-services-scenes.json',people);
  const time=await phase('native_time',()=>seedTimeV2Demo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'time-scenes.json',time);
  const dry=await phase('hr_preflight',()=>seedNativeHrDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'hr-dry.json',dry);
  const hr=await phase('native_hr',()=>seedNativeHrDemo(db,{confirmSynthetic:true,apply:true,expectedPlanHash:dry.plan_hash}));await privateJson(outputDirectory,'hr-scenes.json',hr);
  const payroll=await phase('native_payroll',()=>seedStandardPayrollDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'payroll-scenes.json',payroll);
  const performance=await phase('native_performance',()=>seedPerformanceDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'performance-scenes.json',performance);
  const learning=await phase('native_learning',()=>seedLearningDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'learning-scenes.json',learning);
  const personal=await phase('personal_portal',()=>seedPersonalPortalDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'personal-portal-scenes.json',personal);
  const integration=await phase('native_integration',()=>seedIntegrationDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'integration-scenes.json',integration);
  const workforce=await phase('native_workforce',()=>seedWorkforceNativeDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'workforce-scenes.json',workforce);
  const finance=await phase('native_payroll_finance',()=>seedPayrollFinanceDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'payroll-finance-scenes.json',finance);
  const scripts=await phase('native_payroll_scripts',()=>seedPayrollScriptDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'payroll-script-scenes.json',scripts);
  const timeWorkflow=await phase('time_workflow',()=>seedTimeWorkflowDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'time-workflow-scenes.json',timeWorkflow);
  const notifications=await phase('workflow_notifications',()=>seedWorkflowNotificationDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'workflow-notification-scenes.json',notifications);
  const recruiting=await phase('recruiting_sources',()=>seedRecruitingSourcesDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'recruiting-scenes.json',recruiting);
  const esign=await phase('contract_esign',()=>seedEsignDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'esign-scenes.json',esign);
  const notificationDelivery=await phase('workflow_message_delivery_configuration',()=>seedWorkflowNotificationsDemo(db,{confirmSynthetic:true,origin:noticeOrigin}));await privateJson(outputDirectory,'workflow-message-delivery-scenes.json',notificationDelivery);
  const leaveHongKong=await phase('hong_kong_leave_payroll_correction',()=>seedLeavePayrollHongKongDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'leave-payroll-hk-scenes.json',leaveHongKong);
  const contractPayroll=await phase('contract_payroll_mapping',()=>seedContractPayrollDemo(db,{confirmSynthetic:true}));await privateJson(outputDirectory,'contract-payroll-scenes.json',contractPayroll);
  const facts=(await db.query("SELECT json_build_object('people',(SELECT count(*)FROM ty_person),'accounts',(SELECT count(*)FROM ty_test_account_profile),'stores',(SELECT count(*)FROM ty_company WHERE org_level='store'),'migrations',(SELECT count(*)FROM schema_migration))facts")).rows[0].facts;
  if(facts.people!==62||facts.accounts!==77||facts.stores!==20)fail('完整演示身份或门店数量不符合场景设计，未标完成');
  const result={version:'TY-NATURAL-RESTAURANT-V6',synthetic_only:true,demonstration_label:'演示帐套',complete:true,...facts,external_calls:0,real_bank_payments:0,passwords_in_artifacts:false};await privateJson(outputDirectory,'complete-demo-manifest.json',result);return result;
 }finally{await db.close();}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const at=process.argv.indexOf('--scene-directory');if(!process.argv.includes('--confirm-synthetic')||at<0)fail('用法：--confirm-synthetic --scene-directory <本地受控目录>');console.log(JSON.stringify(await createCompleteDemo({confirmSynthetic:true,outputDirectory:resolve(process.argv[at+1]),password:process.env.TYHR_OPERATOR_INITIAL_PASSWORD})));}catch(error){console.error(error.message);process.exitCode=1;}
}
