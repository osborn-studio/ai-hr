// Additive, opt-in restaurant learning scenarios. No migration or identity creation.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createDb,withTx} from '../app/db.mjs';
import {q,one,same,authorization} from '../app/services/platform-core.mjs';
import {humanIsPerson,sameHuman} from '../app/services/human-identity.mjs';
import {dispatchCommand} from '../app/services/learning-native.mjs';
export const VERSION='TY-LEARNING-RICH-202611-V1';
const fail=m=>{throw new Error(m);};
const topics=[
 ['SERVICE','高峰服务与顾客沟通','service','需求复述与过敏提示','上菜节奏与客诉升级','复述并记录顾客需求','未经确认自行变更'],
 ['KITCHEN','档口出品与交接规范','kitchen','备料批次与温控核对','出品复核与交班记录','核对批次和温度后交接','只凭口头说明交班'],
 ['CLEAN','环境清洁与消毒实操','hygiene','分区工具与消毒配比','清洁验收与异常留痕','按区域使用专用工具','所有区域混用工具'],
 ['LEADER','店长带教与班组协作','leadership','高峰分工与岗位补位','带教反馈与复盘','明确分工并保留交接记录','直接跳过交班核对'],
 ['HKTEAM','香港门店服务与安全沟通','service','繁忙时段需求确认','员工协作及应急报告','确认需求后联系当班负责人','隐瞒异常避免报告'],
 ['ONBOARD','新员工入职与岗位适应','onboarding','个人防护与岗位须知','请假调班及学习入口','按流程提交申请并关注结果','绕过审批直接换班']
];
async function snapshot(t,g){const rows={};for(const table of ['ty_person','ty_employment','ty_test_account_profile','ty_operator_binding','ty_pay_batch'])rows[table]=await q(t,`SELECT * FROM ${table} WHERE group_id=$1 ORDER BY ${table==='ty_test_account_profile'||table==='ty_operator_binding'?'account_id':'id'}`,[g]);rows.credentials=await q(t,'SELECT c.* FROM sys_user_credential c JOIN ty_test_account_profile p ON p.account_id=c.user_id WHERE p.group_id=$1 ORDER BY c.user_id',[g]);return createHash('sha256').update(JSON.stringify(rows)).digest('hex');}
export async function seedLearningRichDemo(db,{confirmSynthetic=false}={}){
 if(confirmSynthetic!==true)fail('须明确confirmSynthetic');
 return withTx(db,async t=>{
  const group=await one(t,"SELECT * FROM ty_group WHERE code='TY-TEST' FOR UPDATE");if(!group)fail('缺少TY-TEST');
  const proof=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed' AND entity_kind='test_workspace' AND entity_id=$1 ORDER BY id DESC LIMIT 1",[group.id]);
  const size=await one(t,'SELECT (SELECT count(*) FROM ty_person WHERE group_id=$1)::int people,(SELECT count(*) FROM ty_test_account_profile WHERE group_id=$1)::int accounts',[group.id]);
  if(!proof?.after_data?.synthetic||!proof.after_data.complete||size.people!==62||size.accounts!==77)fail('仅接受既有62人77账号隔离演示帐套');
  const prev=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed' AND entity_kind='rich_learning_demo' AND entity_id=$1 AND after_data->>'version'=$2 ORDER BY id DESC LIMIT 1",[group.id,VERSION]);if(prev?.after_data.complete)return {...prev.after_data,replayed:true};
  if(!(await one(t,"SELECT EXISTS(SELECT 1 FROM ty_audit WHERE entity_kind='native_learning_demo' AND entity_id=$1 AND after_data->>'complete'='true') ok",[group.id])).ok)fail('先执行既有原生培训考试场景');
  const before=await snapshot(t,group.id), actors=await q(t,`SELECT a.id,a.login,a.display_name,COALESCE(b.person_id,p.person_id)person_id,COALESCE(b.profile_code,p.profile_code)profile_code FROM sys_account a JOIN ty_test_account_profile p ON p.account_id=a.id LEFT JOIN ty_operator_binding b ON b.account_id=a.id WHERE p.group_id=$1 AND a.status='active' AND (b.account_id IS NULL OR b.status='active') ORDER BY a.id`,[group.id]);
  const demo=actors.find(a=>a.login==='demo'),hr=actors.find(a=>a.login==='group_hr_director');if(!demo||!hr)fail('缺少既有演示及集团HR账号');
  const crew=[...actors.filter(a=>a.profile_code==='trainer'),hr,...actors.filter(a=>['company_hr_director','hr_manager'].includes(a.profile_code)),demo];
  const choose=async(p,avoid=[],resource='learning_manage',action='approve',fields=[])=>{for(const a of crew){if(await humanIsPerson(t,a.id,group.id,p.person_id))continue;let blocked=false;for(const x of avoid)if(await sameHuman(t,a.id,x.id))blocked=true;if(blocked)continue;if((await authorization(t,{userId:a.id,resource,action,groupId:group.id,companyId:p.company_id,personId:p.person_id,fields})).allowed)return a;}fail('缺少独立复核账号');};
  const call=async(op,input,key,actor=demo)=>{try{return await dispatchCommand(t,{userId:actor.id,operation:'learning.'+op,operationId:VERSION+':'+key,input:{group_id:group.id,...input}});}catch(e){throw Object.assign(new Error(key+': '+e.message),{code:e.code,where:e.where});}};
  const people=await q(t,`SELECT DISTINCT ON(e.person_id)e.id employment_id,e.person_id,e.company_id,p.person_number,p.full_name,loc.region_code FROM ty_employment e JOIN ty_person p ON p.id=e.person_id CROSS JOIN LATERAL fn_ty_company_locale(e.company_id)loc WHERE e.group_id=$1 AND e.status<>'cancelled' AND e.hire_date<=app_today() AND(e.leave_date IS NULL OR e.leave_date>=app_today()) ORDER BY e.person_id,e.hire_date DESC,e.id DESC`,[group.id]);
  const students=[];for(const p of people){for(const a of actors.filter(a=>same(a.person_id,p.person_id)&&['store_staff','station_staff','store_manager','outsourced_staff'].includes(a.profile_code))){if((await authorization(t,{userId:a.id,resource:'learning_self',action:'submit',groupId:group.id,companyId:p.company_id,personId:p.person_id,fields:['tasks']})).allowed){students.push({p,actor:a});break;}}}
  if(students.length<8)fail('需至少8位既有当前员工账号');
  const now=(await one(t,'SELECT clock_timestamp()now')).now,stamp=new Date(now).getTime(),today=new Date(stamp).toISOString().slice(0,10),end=new Date(stamp+45*86400000).toISOString().slice(0,10),scenes=[],created={courses:0,plans:0,questions:0,papers:0,exams:0,assignments:0,attendance:0,grades:0,attempts:0};
  for(const [index,topic] of topics.entries()){
   const [code,name,category,chapter1,chapter2,right,wrong]=topic,key='RICH-'+code;
   const course=(await call('course.save',{code:key,name,category,minimum_minutes:'45',chapters:[{key:'BASIC',title:chapter1,kind:'text',content:`${chapter1}：操作前核对岗位清单，明确当班负责人、所需记录和异常升级入口。每次操作保留时间、人员与处理经过。`,required:true},{key:'PRACTICE',title:chapter2,kind:'text',content:`${chapter2}：结合门店实际场景演练，先确认情况再进行交接，及时反馈问题并跟踪处理结果。`,required:true}]},key+'-COURSE')).course;created.courses++;
   await call('course.publish',{id:course.id,expected_revision:course.revision},key+'-COURSE-PUBLISH',hr);
   const plan=(await call('plan.save',{code:key+'-202611',name:'11月'+name+'专项提升',course_id:course.id,starts_on:today,ends_on:end,required_minutes:'45',required_exam:true},key+'-PLAN')).plan;created.plans++;
   await call('plan.publish',{id:plan.id,expected_revision:plan.revision},key+'-PLAN-PUBLISH',hr);
   const session=(await call('session.save',{plan_id:plan.id,name:name+'现场带教',starts_at:new Date(stamp-7200000).toISOString(),ends_at:new Date(stamp-3600000).toISOString(),trainer_id:crew[0].id,location:index===4?'铜锣湾门店培训区':'品牌培训中心与门店带教区',required:false},key+'-SESSION')).session;
   const questions=[];for(let j=0;j<4;j++){
    const item=(await call('question.save',{code:key+'-Q'+j,name:name+'·'+(j+1),kind:'single',category,difficulty:j<2?'normal':'advanced',prompt:[`关于${chapter1}，以下哪项正确？`,`关于${chapter2}，应采取哪项措施？`,'发现操作或服务异常，应先如何处理？','交班时如何保证后续处理可追溯？'][j],options:[{id:'A',label:j<2?right:j===2?'及时报告并记录异常':'核对事项并保留交接记录'},{id:'B',label:wrong},{id:'C',label:'不核对直接沿用上次记录'}],answer:'A',points:'25',grading:{partial_multi:false},rubric:'依据岗位操作和异常报告标准评分。'},key+'-Q'+j)).question;await call('question.publish',{id:item.id,expected_revision:item.revision},key+'-QP'+j,hr);questions.push(item);created.questions++;
   }
   const paper=(await call('paper.save',{code:key+'-PAPER',name:name+'考核试卷',selection:{question_ids:questions.map(x=>x.id)},pass_percentage:'75',shuffle:true},key+'-PAPER')).paper;created.papers++;await call('paper.publish',{id:paper.id,expected_revision:paper.revision},key+'-PAPER-PUBLISH',hr);
   const eligible=index===4?students.filter(s=>s.p.region_code==='HK'):students;
   const selected=Array.from({length:Math.min(12,eligible.length)},(_,i)=>eligible[(i+index*3)%eligible.length]);
   const chooseAcross=async(avoid,action,fields)=>{for(const candidate of crew){let ok=true;for(const person of selected){if(await humanIsPerson(t,candidate.id,group.id,person.p.person_id)||!(await authorization(t,{userId:candidate.id,resource:'learning_grade',action,groupId:group.id,companyId:person.p.company_id,personId:person.p.person_id,fields})).allowed){ok=false;break;}}for(const x of avoid)if(await sameHuman(t,candidate.id,x.id))ok=false;if(ok)return candidate;}fail('缺少覆盖全部参训门店的独立阅卷复核人员');};
   const grader=await chooseAcross(selected.map(s=>s.actor),'write',['answers']);
   const reviewer=await chooseAcross([grader,...selected.map(s=>s.actor)],'approve',['answers','scores']);
   const exam=(await call('exam.save',{paper_id:paper.id,plan_id:plan.id,name:name+'岗位考核',opens_at:new Date(stamp-60000).toISOString(),closes_at:new Date(stamp+30*86400000).toISOString(),duration_minutes:30,maximum_attempts:2,grader_id:grader.id,reviewer_id:reviewer.id,answer_policy:'never',result_policy:'highest'},key+'-EXAM')).exam;created.exams++;await call('exam.publish',{id:exam.id,expected_revision:exam.revision},key+'-EXAM-PUBLISH',hr);
   for(const [n,s] of selected.entries()){
    const {p,actor}=s,a=(await call('assignment.create',{plan_id:plan.id,employment_id:p.employment_id,requirement_key:key+'-202611',mandatory:n%4!==0,max_attempts:2},key+'-ASSIGN-'+p.person_id)).assignment;created.assignments++;
    await call('exam.assign',{exam_id:exam.id,requirement_id:a.requirement_id},key+'-EXAM-ASSIGN-'+a.id);
    if(n%4!==0){const state=n%6===1?'absent':n%6===2?'late':'present',attendance=(await call('attendance.submit',{assignment_id:a.id,session_id:session.id,attendance_state:state,check_in:state==='absent'?undefined:new Date(stamp-(state==='late'?6300000:7200000)).toISOString(),check_out:state==='absent'?undefined:new Date(stamp-3600000).toISOString(),source_ref:name+'门店带教签到表·'+p.person_number},key+'-ATTEND-'+a.id)).attendance;created.attendance++;await call('attendance.verify',{id:attendance.id,expected_revision:attendance.revision,reason:'对照讲师签到与现场带教记录，核定本次到场情况。'},key+'-AV-'+a.id,await choose(p,[demo]));}
    if(n%4===0){scenes.push({key:key+'-READY-'+p.person_number,route:'my/learning',person_number:p.person_number,account_id:actor.id,plan_id:plan.id,exam_id:exam.id,assignment_id:a.id,state:'assigned'});continue;}
    const attempt=(await call('attempt.start',{exam_id:exam.id,requirement_id:a.requirement_id},key+'-START-'+a.id,actor)).attempt;created.attempts++;
    const saved=(await call('attempt.answer',{id:attempt.id,expected_answer_revision:0,answers:Object.fromEntries(questions.map((x,j)=>[x.id,n%5===1&&j>0?'B':'A']))},key+'-ANSWER-'+a.id,actor)).attempt;
    if(n%4===1){scenes.push({key:key+'-OPEN-'+p.person_number,route:'my/learning',person_number:p.person_number,account_id:actor.id,attempt_id:attempt.id,state:'open_saved'});continue;}
    await call('attempt.submit',{id:saved.id,confirmed_answer_revision:saved.answer_revision},key+'-SUBMIT-'+a.id,actor);
    const grade=(await call('grade.propose',{attempt_id:saved.id,marks:{},reason:'按岗位考核冻结题目答案逐题核算客观成绩。'},key+'-GRADE-'+a.id,grader)).grade;created.grades++;
    if(n%4===2){scenes.push({key:key+'-REVIEW-'+p.person_number,route:'learning/grading',person_number:p.person_number,account_id:reviewer.id,grade_id:grade.id,state:'proposed'});continue;}
    await call('grade.approve',{id:grade.id,expected_revision:grade.revision,reason:'独立核对试卷与作答，确认本次岗位考核成绩。'},key+'-APPROVE-'+a.id,reviewer);
    await call('grade.publish',{id:grade.id},key+'-PUBLISH-'+a.id);
    scenes.push({key:key+'-PUBLISHED-'+p.person_number,route:'my/learning',person_number:p.person_number,account_id:actor.id,grade_id:grade.id,state:grade.passed?'published_passed':'published_failed'});
   }
  }
  if(await snapshot(t,group.id)!==before)fail('禁止改动既有人员账号凭据雇佣工资');
  const out={version:VERSION,complete:true,synthetic:true,group_id:group.id,created,scenes,created_people:0,created_accounts:0,changed_passwords:0,payroll_adoptions:0,external_calls:0,source_fingerprint:before};
  await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'seed','rich_learning_demo',$2,$3::jsonb)",[demo.id,group.id,JSON.stringify(out)]);return out;
 });
}
if(process.argv[1]&&pathToFileURL(realpathSync(process.argv[1])).href===import.meta.url){if(!process.argv.includes('--confirm-synthetic'))fail('必须明确 --confirm-synthetic');if(!process.env.DATABASE_URL&&!process.env.PGLITE_DATA_DIR)fail('必须显式指定持久隔离演示数据库');const db=await createDb({url:process.env.DATABASE_URL||undefined,dataDir:process.env.PGLITE_DATA_DIR});try{const out=await seedLearningRichDemo(db,{confirmSynthetic:true});const i=process.argv.indexOf('--scene-index');if(i>=0){const p=resolve(process.argv[i+1]);await mkdir(dirname(p),{recursive:true,mode:0o700});await writeFile(p,JSON.stringify(out,null,2)+'\n',{mode:0o600,flag:'wx'});}console.log(JSON.stringify({version:VERSION,replayed:!!out.replayed,created:out.created,scenes:out.scenes.length,external_calls:0}));}finally{await db.close();}}
