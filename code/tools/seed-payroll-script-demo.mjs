// Reuses the marked TY-TEST identity and approved October wages. Only new
// script versions, sandbox previews and unapproved salary proposals are added.
import {createHash} from 'node:crypto';
import {withTx} from '../app/db.mjs';
import {one,q,authorization,currentOperator} from '../app/services/platform-core.mjs';
import {sameHuman,humanIsPerson} from '../app/services/human-identity.mjs';
import {dispatchCommand} from '../app/services/payroll-scripts.mjs';
export const VERSION='TY-PAYROLL-SCRIPT-DEMO-202610-V1';
const fail=m=>{throw new Error(m);};
async function fingerprint(t,g){const values=[];for(const sql of[
 'SELECT*FROM ty_person WHERE group_id=$1 ORDER BY id',
 'SELECT*FROM ty_employment WHERE group_id=$1 ORDER BY id',
 'SELECT*FROM ty_test_account_profile WHERE group_id=$1 ORDER BY account_id',
 'SELECT c.user_id,c.pwd_hash FROM sys_user_credential c JOIN ty_test_account_profile p ON p.account_id=c.user_id WHERE p.group_id=$1 ORDER BY c.user_id',
 'SELECT*FROM ty_pay_batch WHERE group_id=$1 ORDER BY id',
 'SELECT*FROM ty_pay_row WHERE group_id=$1 ORDER BY id',
 'SELECT i.*FROM ty_pay_item i JOIN ty_pay_row r ON r.id=i.row_id WHERE r.group_id=$1 ORDER BY i.id',
 'SELECT*FROM ty_pay_config WHERE group_id=$1 AND status=\'approved\'ORDER BY id',
 'SELECT*FROM ty_time_report_root WHERE group_id=$1 ORDER BY id',
 'SELECT x.*FROM ty_time_punch x JOIN ty_roster_segment s ON s.id=x.segment_id JOIN ty_roster_day d ON d.id=s.day_id JOIN ty_roster_period p ON p.id=d.period_id WHERE p.group_id=$1 ORDER BY x.id'
])values.push((await t.query(sql,[g])).rows);return createHash('sha256').update(JSON.stringify(values)).digest('hex');}
async function counts(t,g){const r={};for(const[name,table]of Object.entries({scripts:'ty_ps_script',runs:'ty_ps_run',triggers:'ty_ps_trigger',ai:'ty_ps_ai_proposal'}))r[name]=Number((await one(t,'SELECT count(*)n FROM '+table+' WHERE group_id=$1',[g])).n);r.proposals=Number((await one(t,'SELECT count(*)n FROM ty_ps_origin o JOIN ty_ps_run r ON r.id=o.run_id WHERE r.group_id=$1',[g])).n);r.jobs=Number((await one(t,'SELECT count(*)n FROM ty_ps_job j JOIN ty_ps_trigger tr ON tr.id=j.trigger_id WHERE tr.group_id=$1',[g])).n);return r;}
export async function seedPayrollScriptDemo(db,{confirmSynthetic=false}={}){
 if(confirmSynthetic!==true)fail('须明确confirmSynthetic，仅供已标记帐套');
 if(process.env.TYHR_PAYROLL_SCRIPT_SANDBOX!=='quickjs-wasm-v1')fail('须显式启用已核隔离引擎，不允许使用Node代码回退');
 return withTx(db,async t=>{
 const group=await one(t,"SELECT*FROM ty_group WHERE code='TY-TEST'FOR UPDATE");if(!group||!(await one(t,"SELECT to_regclass('public.ty_ps_script')IS NOT NULL ok")).ok)fail('须先完成228迁移及原TY-TEST帐套');
 const proof=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed'AND entity_kind='test_workspace'AND entity_id=$1 ORDER BY id DESC LIMIT 1",[group.id]),size=await one(t,'SELECT(SELECT count(*)FROM ty_person WHERE group_id=$1)::int people,(SELECT count(*)FROM ty_test_account_profile WHERE group_id=$1)::int accounts',[group.id]);
 if(!proof?.after_data?.synthetic||!proof.after_data.complete||size.people!==62||size.accounts!==77)fail('只接受已标记完整62人77账号帐套，不新建身份或扩权');
 const previous=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed'AND entity_kind='native_payroll_script_demo'AND entity_id=$1 AND after_data->>'version'=$2 ORDER BY id DESC LIMIT 1",[group.id,VERSION]);if(previous?.after_data?.complete)return{...previous.after_data,replayed:true,existing_business_state_preserved:true};
 const initial=await counts(t,group.id),before=await fingerprint(t,group.id),actors=[];
 for(const a of await q(t,"SELECT a.id,a.login,a.display_name,p.profile_code FROM sys_account a JOIN ty_test_account_profile p ON p.account_id=a.id WHERE p.group_id=$1 AND a.status='active'AND p.profile_code IN('group_hr_director','demo','hr_manager')ORDER BY CASE p.profile_code WHEN 'group_hr_director'THEN 0 WHEN 'demo'THEN 1 ELSE 2 END,a.id",[group.id])){
  if((await authorization(t,{userId:a.id,resource:'payroll_config',action:'approve',groupId:group.id})).allowed&&(await authorization(t,{userId:a.id,resource:'payroll_sources',action:'write',groupId:group.id})).allowed)actors.push({...a,person_id:(await currentOperator(t,a.id)).person_id});
 }
 const author=actors[0];let reviewer;for(const a of actors.slice(1))if(!await sameHuman(t,author.id,a.id)){reviewer=a;break;}if(!author||!reviewer)fail('须已有相互独立的薪酬操作人员');
 let seq=0;const run=(op,input,actor=author)=>dispatchCommand(t,{userId:actor.id,input:{group_id:group.id,...input},operation:'payroll.script.'+op,operationId:VERSION+':'+ ++seq+':'+op}),scenes=[];
 const staff=await q(t,"SELECT e.*,p.person_number,p.full_name,c.name company_name,loc.region_code,c.org_level,pc.id profile_id,pc.system FROM ty_employment e JOIN ty_person p ON p.id=e.person_id JOIN ty_company c ON c.id=e.company_id CROSS JOIN LATERAL fn_ty_company_locale(c.id)loc JOIN LATERAL(SELECT*FROM ty_pay_config pc WHERE pc.company_id=e.company_id AND pc.employment_id=e.id AND pc.kind='profile'AND pc.status='approved'AND pc.valid_from<='2026-10-01'AND(pc.valid_to IS NULL OR pc.valid_to>='2026-11-01')AND pc.data->'parameters'?'monthly'ORDER BY pc.revision DESC,pc.id DESC LIMIT 1)pc ON true WHERE e.group_id=$1 AND e.hire_date<'2026-11-01'AND(e.leave_date IS NULL OR e.leave_date>='2026-10-01')AND EXISTS(SELECT 1 FROM ty_pay_config rr WHERE rr.employment_id=e.id AND rr.kind='relationship'AND rr.status='approved'AND rr.system=pc.system AND rr.valid_from<='2026-10-01'AND(rr.valid_to IS NULL OR rr.valid_to>='2026-11-01'))ORDER BY CASE c.org_level WHEN 'store'THEN 0 ELSE 1 END,e.id",[group.id]);
 for(const region of['CN','HK']){
  let employee;for(const e of staff.filter(x=>x.region_code===region)){if(await humanIsPerson(t,author.id,group.id,e.person_id)||await humanIsPerson(t,reviewer.id,group.id,e.person_id))continue;
   const root=await one(t,"SELECT h.*FROM ty_time_report_root h JOIN ty_time_report_version v ON v.id=h.current_report_id WHERE h.employment_id=$1 AND h.period='2026-10-01'AND h.owner_company_id=$2 AND h.perspective='employer'AND v.status='confirmed'",[e.id,e.company_id]);if(!root)continue;
   if(region==='HK'){const line=await one(t,'SELECT count(*)n FROM ty_time_report_line WHERE report_id=$1 AND employment_id=$2 AND worked_minutes IS NULL',[root.current_report_id,e.id]);if(Number(line.n)>0)continue;}
   employee={...e,report_id:root.current_report_id};break;
  }
  if(!employee)fail('须有'+region+'当期已核工资、真实关系及完整核勤根，不补零或捏造来源');
  const inputSpec={salary:{source:'profile_parameter',key:'monthly',unit:'currency_amount'},...(region==='HK'?{worked:{source:'time_report',key:'worked_minutes',unit:'minute'}}:{})},body={company_id:employee.company_id,code:'TY_'+region+'_MONTHLY_REVIEW',name:region==='CN'?'门店岗位月薪复核':'香港月薪与工时复核',system:employee.system,source:'input => ({ parameters: { monthly: { value: input.values.salary.value, unit: "currency_amount" } } })',input_spec:inputSpec,output_spec:{monthly:{unit:'currency_amount',minimum:'0',maximum:'1000000'}},valid_from:'2026-10-01',valid_to:'2026-11-01',evidence_ref:'10月门店已核岗位月薪及考勤复核安排，仅生成参数草稿，不自动核准工资或付款。'};
  const script=(await run('save',body)).script;await run('approve',{id:script.id,expected_revision:script.revision},reviewer);
  const completed=(await run('preview',{script_id:script.id,employment_id:employee.id,period:'2026-10',...(region==='HK'?{report_id:employee.report_id}:{})})).run;if(completed.status!=='completed')fail('已核参数隔离预演应完成，不伪造成功：'+completed.error_code);
  const proposal=await run('proposal.create',{run_id:completed.id,evidence_ref:'10月门店工资参数复核，当前仅为待独立核准草稿，不改原确认工资。'});
  scenes.push({key:region+'-REVIEWED-INPUT-DRAFT-PARAMETERS',company_id:employee.company_id,employment_id:employee.id,person_id:employee.person_id,person_number:employee.person_number,full_name:employee.full_name,script_id:script.id,run_id:completed.id,profile_config_id:proposal.proposal.profile_config_id,report_id:completed.report_id,route:'payroll/scripts',expected:'completed preview; proposed profile remains draft; confirmed wages unchanged'});
  const trigger=(await run('trigger.save',{script_id:script.id,employment_id:employee.id,event_kind:'manual',valid_from:'2026-10-01',valid_to:'2026-11-01',evidence_ref:'月末岗位月薪复核由薪酬专员发起，仅排队隔离预演。'})).trigger;await run('trigger.approve',{id:trigger.id,expected_revision:trigger.revision},reviewer);
  const job=(await run('trigger.enqueue',{trigger_id:trigger.id,period:'2026-10',event_key:'OCTOBER-MONTH-END-'+region,report_id:region==='HK'?employee.report_id:undefined})).job;
  if(region==='CN')await run('job.process',{id:job.id,expected_revision:job.revision});
  scenes.push({key:region+'-TRIGGER-PREVIEW',trigger_id:trigger.id,job_id:job.id,route:'payroll/scripts',expected:region==='CN'?'completed sandbox preview only':'queued sandbox preview; no automatic profile approval'});
  await run('ai.propose',{company_id:employee.company_id,purpose:'draft_script',goal:region==='CN'?'保留门店已核月薪参数，说明不同岗位津贴的普通参数边界，送另一名薪酬主管核准。':'解释香港工资档案与当月已核工时的来源；最低工资、强积金与待遇分类保持正常法定计算流程。'});
  const pending=(await run('save',{...body,code:'TY_'+region+'_NEXT_MONTH_DRAFT',name:region==='CN'?'11月岗位工资参数方案':'11月香港岗位工资参数方案',valid_from:'2026-11-01',valid_to:'2026-12-01'})).script;scenes.push({key:region+'-CODE-AWAITING-REVIEW',script_id:pending.id,route:'payroll/scripts',expected:'draft code; cannot execute before independent approval'});
  if(region==='HK'){
   const bounded=(await run('save',{...body,code:'TY_HK_OUTPUT_BOUNDARY',name:'香港月薪参数边界核验',source:'() => ({ parameters: { monthly: { value: "1000001", unit: "currency_amount" } } })'})).script;await run('approve',{id:bounded.id,expected_revision:bounded.revision},reviewer);
   const blocked=(await run('preview',{script_id:bounded.id,employment_id:employee.id,period:'2026-10',report_id:employee.report_id})).run;if(blocked.status!=='failed'||blocked.error_code!=='parameter_above_bound')fail('参数越界须保存失败证据，不能采用');scenes.push({key:'HK-OUTPUT-BOUND-REFUSAL',script_id:bounded.id,run_id:blocked.id,route:'payroll/scripts',expected:'failed parameter_above_bound; no salary profile proposed'});
  }
 }
 if(await fingerprint(t,group.id)!==before)fail('脚本演示不得改人员、账号、口令、已核工资参数、原卡、核勤当前根或确认工资');const after=await counts(t,group.id),result={version:VERSION,synthetic:true,complete:true,group_id:group.id,people:62,accounts:77,created_counts:Object.fromEntries(Object.keys(after).map(k=>[k,after[k]-initial[k]])),scenes,roles:{author:{account_id:author.id,login:author.login,name:author.display_name},reviewer:{account_id:reviewer.id,login:reviewer.login,name:reviewer.display_name}},source_fingerprint:before,created_people:0,created_accounts:0,changed_passwords:0,changed_confirmed_wages:0,approved_salary_profiles:0,bank_requests:0,model_requests:0};
 await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'seed','native_payroll_script_demo',$2,$3::jsonb)",[author.id,group.id,JSON.stringify(result)]);return result;
 });
}
