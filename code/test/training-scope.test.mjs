// Disposable synthetic application; never run against the preview database.
import assert from 'node:assert/strict';
import {createApp} from '../app/server.mjs';
import {withTx} from '../app/db.mjs';
import * as training from '../app/services/training.mjs';

const {db,server}=await createApp();let checks=0;
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const q=async(s,p=[]) => (await db.query(s,p)).rows;
const run=(fn,args,userId=1)=>withTx(db,t=>fn(t,{userId,...args}));
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name);};
const reject=async(name,fn,pattern=/E_OUT_OF_SCOPE/)=>{await assert.rejects(fn,pattern);checks++;console.log('PASS '+name);};
try{
  await db.query("INSERT INTO legal_entity(id,name) VALUES(1,'虚构甲主体'),(2,'虚构乙主体') ON CONFLICT(id) DO NOTHING");
  await db.query("INSERT INTO person(id,full_name) VALUES(9101,'虚构跨店学员'),(9102,'虚构异主体学员')");
  await db.query("INSERT INTO employment(person_id,legal_entity_id,hire_date) VALUES(9101,1,'2026-01-01'),(9102,2,'2026-01-01')");
  await db.query(`INSERT INTO employee_org_assignment(employee_id,dim_code,org_id,valid_from,valid_to) VALUES
    (9101,'cost_org',11,'2026-01-01','2026-06-30'),(9101,'cost_org',10,'2026-07-01',NULL),
    (9102,'cost_org',10,'2026-01-01',NULL)`);
  const course=await run(training.createCourse,{code:'SCOPE-SYNTHETIC',name:'虚构范围演练',category:'skill',stdHours:2,statutory:false});
  const makeSession=(date,entityId=1)=>run(training.createSession,{courseId:course.id,entityId,date,fromTime:'09:00',toTime:'11:00',hours:2,trainer:'虚构讲师',capacity:20});
  const june=await makeSession('2026-06-01'),aug=await makeSession('2026-08-01');
  const enrolled=await run(training.enroll,{sessionId:june.id,employeeIds:[1,2,9101]});
  for(const id of enrolled.enrolled)await run(training.attend,{enrollId:id,hours:2});
  const august=await run(training.enroll,{sessionId:aug.id,employeeIds:[9101]});
  await run(training.attend,{enrollId:august.enrolled[0],hours:2});
  // Explicit full-scope test administrator; only its own synthetic scope.
  await db.query("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES(9100,'training_scope_admin','虚构全域培训管理员')");
  await db.query("INSERT INTO sys_data_scope(id,name,combinator) VALUES(9100,'虚构培训双主体','intersection')");
  for(const [dim,values] of [['cost_org',[10,11]],['attendance_org',[10,11]],['payroll_legal_entity',[1,2]],['si_entity',[1,2]]])
    await db.query("INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES(9100,$1,'nodes',$2::bigint[])",[dim,values]);
  await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason) VALUES(9100,10,9100,'2026-01-01','ROLE','synthetic training scope regression')");
  const outside=await run(training.createSession,{courseId:course.id,entityId:2,date:'2026-07-01',hours:2},9100);
  const other=await run(training.enroll,{sessionId:outside.id,employeeIds:[9102]},9100);
  await run(training.attend,{enrollId:other.enrolled[0],hours:2},9100);
  const choices=await run(training.entities,{},2);
  check('花名册角色可列主体且不要求薪酬岗位',choices.rows.some(r=>Number(r.id)===1)&&!choices.rows.some(r=>Number(r.id)===2));
  await db.query("INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES(9103,'training_scope_empty','虚构空范围培训账号')");
  await db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason) VALUES(9103,2,300,'2026-01-01','ROLE','synthetic empty training scope')");
  check('空范围主体列表不被解释成全部',(await run(training.entities,{},9103)).rows.length===0);
  const login=await fetch(base+'/login?user=2&pwd=demo1234',{method:'POST'}),token=(await login.json()).token;
  const http=await fetch(base+'/api/training/entities',{headers:{authorization:`Bearer ${token}`}}),httpBody=await http.json();
  check('主体选择器HTTP返回授权rows及name',http.status===200&&httpBody.rows.length===choices.rows.length&&httpBody.rows.every(r=>r.id&&r.name));
  await reject('不能指定其他主体读取培训看板',()=>run(training.board,{entityId:2,year:2026},2));
  const narrow=await run(training.board,{entityId:1,year:2026},2),full=await run(training.board,{entityId:1,year:2026});
  check('门店看板人员不含其他门店和其他主体',narrow.people.every(p=>![2,9102].includes(Number(p.person_id)))&&narrow.people.some(p=>Number(p.person_id)===9101));
  check('共享主体场次仅统计可见人员报名结业',Number(narrow.sessions.find(s=>Number(s.id)===june.id).enrolled)===1&&Number(narrow.sessions.find(s=>Number(s.id)===june.id).completed)===1&&Number(full.sessions.find(s=>Number(s.id)===june.id).enrolled)===3);
  const narrowCourse=narrow.courses.find(c=>Number(c.id)===course.id),fullCourse=full.courses.find(c=>Number(c.id)===course.id);
  check('课程统计限定所选主体及可见人员',Number(narrowCourse.sessions)===2&&Number(narrowCourse.completed)===2&&Number(fullCourse.completed)===4);
  check('年度人员累计不包含其调店前无权培训',Number(narrow.people.find(p=>Number(p.person_id)===9101).hours)===2);
  const detail=await run(training.detail,{personId:9101,year:2026},2);
  check('详情逐场日期收窄且学时同口径',detail.rows.length===1&&detail.hours===2&&detail.rows[0].course_name==='虚构范围演练');
  const fullDetail=await run(training.detail,{personId:9101,year:2026});
  check('合法集团HR可查看完整有权历史',fullDetail.rows.length===2&&fullDetail.hours===4);
  await reject('不能按person编号读取其他店培训',()=>run(training.detail,{personId:2,year:2026},2));
  await reject('同店但其他用工主体的人员也拒绝',()=>run(training.detail,{personId:9102,year:2026},2));
  await reject('开培训场次必须有主体范围',()=>run(training.createSession,{courseId:course.id,entityId:2,date:'2026-09-01',hours:2},2));
  const own=await run(training.createSession,{courseId:course.id,entityId:1,date:'2026-09-01',hours:2},2);
  check('原合法门店HR可在授权主体开场次',own.id>0);
  await reject('批量报名含其他店人员时整批拒绝',()=>run(training.enroll,{sessionId:own.id,employeeIds:[1,2]},2));
  check('混入越权人员不会先写入有权人员',(await q('SELECT id FROM training_enrollment WHERE session_id=$1',[own.id])).length===0);
  await reject('不能给授权主体场次报其他主体员工',()=>run(training.enroll,{sessionId:own.id,employeeIds:[9102]},2));
  await reject('其他主体场次不能报名',()=>run(training.enroll,{sessionId:outside.id,employeeIds:[1]},2));
  const ownEnrollment=await run(training.enroll,{sessionId:own.id,employeeIds:[1]},2);
  const attended=await run(training.attend,{enrollId:ownEnrollment.enrolled[0],hours:1},2);
  check('合法报名和记到场保留业务学时规则',attended.status==='attended'&&Number(attended.attended_hours)===1&&Number(attended.missing_hours)===1);
  await reject('不能修改其他门店已报名到场',()=>run(training.attend,{enrollId:enrolled.enrolled[1],hours:1},2));
  await reject('不能修改其他主体到场',()=>run(training.attend,{enrollId:other.enrolled[0],hours:1},2));
  await reject('没有岗位写权限仍不能开场次',()=>run(training.createSession,{courseId:course.id,entityId:1,date:'2026-09-02',hours:2},3),/E_RESOURCE_FORBIDDEN/);
  const empty=await run(training.detail,{personId:9102,year:2027},9100);
  check('有权人员无该年度记录仍返回明确零学时',empty.rows.length===0&&empty.hours===0);
  await db.query("INSERT INTO sys_permission_deny(id,role_id,dimension,value_ids) VALUES(9100,10,'payroll_legal_entity',ARRAY[2]::bigint[])");
  check('主体列表保留显式deny优先',(await run(training.entities,{},9100)).rows.every(r=>Number(r.id)!==2));
  await reject('显式主体deny不能由其他allow绕过',()=>run(training.board,{entityId:2,year:2026},9100));
  console.log(`培训范围 · ${checks} 条通过 · 驱动 ${db.driver}`);
}finally{await new Promise(r=>server.close(r));await db.close();}
