import assert from'node:assert/strict';
import{createApp}from'../app/server.mjs';
import{withTx}from'../app/db.mjs';
import*as flow from'../app/services/platform-workflow.mjs';
import*as leave from'../app/services/advanced-leave.mjs';
import{prepareLeaveRosterFixture}from'./leave-roster-source.test.mjs';
const app=await createApp({skipDemoSeed:true,nativeOnly:true}),db=app.db;
let passed=0,seq=0;
const check=(name,value)=>{assert.ok(value,name);passed++;console.log('PASS '+name);};
const no=async(name,fn)=>{await assert.rejects(fn,/排班已变化|来源已变化/);passed++;console.log('PASS '+name);};
const one=async(s,p=[])=>(await db.query(s,p)).rows[0];
try{
 const f=await prepareLeaveRosterFixture(db);
 const run=(fn,input,userId=f.author,extra={})=>withTx(db,t=>fn(t,{userId,input,operationId:'LR-WORKFLOW-'+(++seq),...extra}));
 let plan=(await f.native('time.plan.create',{company_id:f.company_id,label:'请假审批统一来源'})).plan;
 for(const d of['20','21'])plan=(await f.native('time.segment.save',{plan_id:plan.id,expected_plan_revision:plan.revision,employment_id:f.employment_id,work_date:'2026-10-'+d,start_at:`2026-10-${d}T09:00:00+08:00`,end_at:`2026-10-${d}T17:00:00+08:00`,work_company_id:f.company_id,department_id:23700,label:'后厨工作班',color:'#2455cc',breaks:[],overtime:false})).plan;
 plan=(await f.native('time.plan.publish',{id:plan.id,expected_revision:plan.revision,reason:'两日工作班已独立复核'},f.reviewer)).plan;
 const graph={nodes:[{id:'start',type:'start',next:'hr'},{id:'hr',type:'approval',label:'请假独立审核',approver_ids:[f.reviewer],mode:'all',next:'end'},{id:'end',type:'end'}]};
 const wf=(await run(flow.saveDefinition,{group_id:f.group_id,code:'LR-WORKFLOW',name:'请假审核',business_type:'leave_request',graph},f.author,{kind:'workflow'})).workflow;
 await run(flow.publishDefinition,{id:wf.id,expected_revision:wf.revision},f.reviewer,{kind:'workflow'});
 const form=(await run(flow.saveDefinition,{group_id:f.group_id,code:'LR-REQUEST',name:'请假申请',business_type:'leave_request',workflow_id:wf.id,schema:{fields:[{key:'request_id',label:'原请假单',type:'number',required:true}]}},f.author,{kind:'form'})).form;
 await run(flow.publishDefinition,{id:form.id,expected_revision:form.revision},f.reviewer,{kind:'form'});
 const submit=async d=>{
  const request=(await f.run(leave.submitRequest,{account_id:f.account_id,scheme_id:f.scheme.id,employment_id:f.employment_id,request_key:'LR-WORKFLOW-'+d,starts_at:`2026-10-${d}T10:00:00+08:00`,ends_at:`2026-10-${d}T11:00:00+08:00`})).request;
  const instance=(await run(flow.submitInstance,{form_id:form.id,company_id:f.company_id,subject_id:request.id,title:'后厨请假申请',values:{request_id:request.id}})).instance;
  return{request,instance,task:await one('SELECT * FROM ty_workflow_task WHERE instance_id=$1',[instance.id])};
 };
 const revise=async d=>{
  let next=(await f.native('time.plan.create',{company_id:f.company_id,label:'调整'+d+'日班次',source_plan_id:plan.id})).plan;
  const segment=await one("SELECT * FROM ty_time_plan_segment WHERE plan_id=$1 AND work_date=$2 AND state='active'",[next.id,'2026-10-'+d]);
  next=(await f.native('time.segment.save',{id:segment.id,expected_revision:segment.revision,plan_id:next.id,expected_plan_revision:next.revision,employment_id:f.employment_id,work_date:'2026-10-'+d,start_at:`2026-10-${d}T11:00:00+08:00`,end_at:`2026-10-${d}T19:00:00+08:00`,work_company_id:f.company_id,department_id:23700,label:'调整后厨工作班',color:'#2455cc',breaks:[],overtime:false})).plan;
  plan=(await f.native('time.plan.publish',{id:next.id,expected_revision:next.revision,reason:'当前版本修改已独立核准'},f.reviewer)).plan;
 };
 const first=await submit('20');await revise('20');
 await no('workflow approval rechecks changed published roster before task decision',()=>run(flow.decideInstance,{task_id:first.task.id,expected_revision:first.task.revision,approve:true,reason:'核对原申请'},f.reviewer));
 check('failed approval keeps original pending request and held allocation', (await one('SELECT status FROM ty_leave_request WHERE id=$1',[first.request.id])).status==='pending'&&(await one("SELECT count(*)::int n FROM ty_leave_allocation WHERE request_id=$1 AND state='held'",[first.request.id])).n>0);
 await run(flow.decideInstance,{task_id:first.task.id,expected_revision:first.task.revision,approve:false,reason:'班表已变，驳回后重新核量'},f.reviewer);
 check('rejection of stale source still releases held entitlement',(await one('SELECT status FROM ty_leave_request WHERE id=$1',[first.request.id])).status==='rejected'&&(await one("SELECT count(*)::int n FROM ty_leave_allocation WHERE request_id=$1 AND state='held'",[first.request.id])).n===0);
 const second=await submit('21'),approved=await run(flow.decideInstance,{task_id:second.task.id,expected_revision:second.task.revision,approve:true,reason:'当前班表与请假净分钟一致'},f.reviewer);
 await run(flow.executeInstance,{instance_id:second.instance.id,expected_revision:approved.instance.revision});
 check('workflow execution allocates the exact frozen sixty minutes without marking taken',(await one('SELECT status,quantity FROM ty_leave_request WHERE id=$1',[second.request.id])).status==='approved'&&(await one("SELECT sum(quantity)::text n FROM ty_leave_allocation WHERE request_id=$1 AND state='allocated'",[second.request.id])).n==='60.0000');
 await revise('21');
 await no('settlement refuses changed source after workflow approval',()=>withTx(db,t=>leave.settleRequest(t,{userId:f.author,id:second.request.id,evidenceRef:'实际休假核对'})));
 await withTx(db,t=>leave.cancelRequest(t,{userId:f.author,id:second.request.id,reason:'班次改变后撤销原额度占用'}));
 check('HR can cancel stale approved leave and release original allocation',(await one('SELECT status FROM ty_leave_request WHERE id=$1',[second.request.id])).status==='cancelled'&&(await one("SELECT count(*)::int n FROM ty_leave_allocation WHERE request_id=$1 AND state='allocated'",[second.request.id])).n===0);
 console.log(JSON.stringify({suite:'leave-roster-workflow237',driver:db.driver,passed,external_calls:0}));
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await db.close();}
