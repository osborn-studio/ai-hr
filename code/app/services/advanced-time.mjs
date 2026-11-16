import {bizErr} from '../errors.mjs';
import {accessFor,bootstrap,ledgerDescendants,companyDescendants} from './foundation.mjs';
import {personaFor} from './persona-guard.mjs';
import {csv} from '../csv.mjs';
const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
const same=(a,b)=>String(a)===String(b);
export const RESOURCES=['attendance_daily','roster','punch','payroll_run'];
const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
const deny=()=>{throw bizErr('E_TY_FORBIDDEN','缺少考勤排班权限或不在授权公司范围');};
const date=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
export async function timeAccess(t,{userId,write=false,self=false}){
 const a=await accessFor(t,userId),p=await personaFor(t,userId);
 if(self&&!p?.person_id)deny();
 if(self&&p?.person_id)return{a,p,selfPerson:p.person_id};
 if(!(await q(t,'SELECT fn_role_can($1,$2,$3) ok',[userId,'attendance_daily',write?'write':'read']))[0]?.ok)deny();
 if(['config_admin','store_staff','station_staff'].includes(p?.profile_code))deny();
 return {a,p,selfPerson:null};
}
export async function periodContext(t,{userId,groupId,period='2026-10',ledgerId,companyId,self=false,write=false}){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))bad('请选择有效月份');
 const access=await timeAccess(t,{userId,self,write});if(!access.a.group(groupId))deny();
 const p=(await q(t,'SELECT * FROM ty_roster_period WHERE group_id=$1 AND period=$2::date',[groupId,period+'-01']))[0];
 if(!p)return{...access,period:null,rows:[],segments:[],changes:[]};
 const cs=await q(t,'SELECT c.*,c.id company_id FROM ty_company c WHERE group_id=$1',[groupId]);
 const lids=await ledgerDescendants(t,ledgerId),cids=await companyDescendants(t,companyId);
 const visible=cs.filter(c=>access.a.row(c,write)&&(!ledgerId||lids.includes(String(c.ledger_id)))&&(!companyId||cids.includes(String(c.id))));
 const ids=visible.map(c=>String(c.id));
 const allDays=await q(t,'SELECT * FROM v_ty_attendance_day WHERE period_id=$1 ORDER BY work_date,person_number',[p.id]);
 const allSegments=await q(t,`SELECT s.*,to_char(s.start_at,'YYYY-MM-DD HH24:MI:SS') start_at,to_char(s.end_at,'YYYY-MM-DD HH24:MI:SS') end_at,to_char(s.actual_in,'YYYY-MM-DD HH24:MI:SS') actual_in,to_char(s.actual_out,'YYYY-MM-DD HH24:MI:SS') actual_out,c.name work_company_name,d.name department_name,w.name work_area_name FROM v_ty_time_segment s JOIN ty_company c ON c.id=s.work_company_id JOIN ty_department d ON d.id=s.department_id LEFT JOIN ty_work_area w ON w.id=s.work_area_id WHERE period_id=$1 ORDER BY s.work_date,s.person_id,s.start_at`,[p.id]);
 // A receiving store sees only its own borrowed segments, never the person's other shifts.
 const segments=allSegments.filter(s=>(!access.selfPerson||same(s.person_id,access.selfPerson))&&(access.selfPerson||ids.includes(String(s.work_company_id))));
 const borrowed=new Set(segments.map(s=>String(s.day_id)));
 const days=allDays.filter(d=>(!access.selfPerson||same(d.person_id,access.selfPerson))&&(ids.includes(String(d.home_company_id))||borrowed.has(String(d.id))));
 const visibleDays=days.map(d=>{if(ids.includes(String(d.home_company_id))||access.selfPerson)return d;const ss=segments.filter(s=>same(s.day_id,d.id));return{...d,receiving_store_only:true,segments:ss.length,planned_minutes:ss.filter(s=>!s.overtime).reduce((n,s)=>n+s.planned_minutes,0),actual_minutes:ss.reduce((n,s)=>n+s.actual_minutes,0),worked_minutes:ss.filter(s=>!s.overtime).reduce((n,s)=>n+s.credited_minutes,0),overtime_minutes:ss.filter(s=>s.overtime).reduce((n,s)=>n+s.credited_minutes,0),leave_minutes:0,paid_leave_minutes:0,unpaid_leave_minutes:0,late_minutes:ss.reduce((n,s)=>n+s.late_minutes,0),early_minutes:ss.reduce((n,s)=>n+s.early_minutes,0),missing_punches:ss.reduce((n,s)=>n+s.missing,0),corrected_segments:ss.filter(s=>s.corrected).length,support_segments:ss.length,unworked_minutes:ss.filter(s=>!s.overtime&&!s.leave_kind).reduce((n,s)=>n+s.planned_minutes-s.credited_minutes,0)};});
 const segmentIds=new Set(segments.map(s=>String(s.id)));
 const changes=(await q(t,'SELECT * FROM ty_roster_change WHERE period_id=$1 ORDER BY id DESC',[p.id])).filter(c=>c.patches.every(x=>segmentIds.has(String(x.segment_id))));
 return{...access,period:p,rows:visibleDays,segments,changes,company_ids:ids,complete:visibleDays.length===allDays.length};
}
const sum=(rows,k)=>rows.reduce((n,r)=>n+Number(r[k]||0),0);
export function monthly(rows){
 const map=new Map();for(const r of rows){const key=[r.person_id,r.employment_id,r.receiving_store_only?'receiving':'employer'].join(':');if(!map.has(key))map.set(key,{person_id:r.person_id,employment_id:r.employment_id,person_number:r.person_number,full_name:r.full_name,home_company_id:r.home_company_id,home_company_name:r.home_company_name,region_code:r.region_code,currency_code:r.currency_code,receiving_store_only:!!r.receiving_store_only,calendar_days:0,work_days:0,rest_days:0,leave_days:0,planned_minutes:0,actual_minutes:0,worked_minutes:0,overtime_minutes:0,leave_minutes:0,paid_leave_minutes:0,unpaid_leave_minutes:0,late_minutes:0,early_minutes:0,missing_punches:0,corrected_segments:0,support_segments:0,unworked_minutes:0});const o=map.get(key);o.calendar_days++;o.work_days+=r.day_kind==='work'?1:0;o.rest_days+=r.day_kind==='rest'?1:0;o.leave_days+=r.leave_minutes>0?1:0;for(const k of ['planned_minutes','actual_minutes','worked_minutes','overtime_minutes','leave_minutes','paid_leave_minutes','unpaid_leave_minutes','late_minutes','early_minutes','missing_punches','corrected_segments','support_segments','unworked_minutes'])o[k]+=Number(r[k]);}return[...map.values()].sort((a,b)=>a.person_number.localeCompare(b.person_number));
}
export async function report(t,args){
 const ctx=await periodContext(t,args),{period,rows,segments,changes}=ctx;
 const corrections=segments.length?await q(t,`SELECT c.*,to_char(c.corrected_at,'YYYY-MM-DD HH24:MI:SS') corrected_at FROM ty_time_correction c WHERE segment_id=ANY($1::bigint[]) ORDER BY id`,[segments.map(s=>s.id)]):[];
 const months=monthly(rows);
 let payroll=[];
 if(!ctx.selfPerson&&(await q(t,"SELECT fn_role_can($1,'payroll_slips_read_all','read') ok",[args.userId]))[0].ok&&period){
  payroll=(await q(t,`SELECT r.id row_id,r.person_id,r.company_id,r.employment_id,r.result_data,b.id batch_id,b.label,b.currency,b.region_code,b.status,p.person_number,p.full_name,c.name company_name FROM ty_time_payroll_link l JOIN ty_payroll_batch b ON b.id=l.batch_id JOIN ty_payroll_row r ON r.batch_id=b.id JOIN ty_person p ON p.id=r.person_id JOIN ty_company c ON c.id=r.company_id WHERE l.period_id=$1 ORDER BY b.region_code,p.person_number`,[period.id])).filter(r=>ctx.company_ids.includes(String(r.company_id)));
 }
 const shifts=await q(t,'SELECT * FROM ty_shift_definition WHERE group_id=$1 ORDER BY id',[args.groupId]);
 return{period,rows,segments,changes,corrections,monthly:months,payroll,shifts,can_manage_shifts:ctx.a.shared(args.groupId,true)&&(await q(t,"SELECT fn_role_can($1,'attendance_daily','write') ok",[args.userId]))[0].ok,can_write:!!period&&period.status!=='closed'&&(await q(t,"SELECT fn_role_can($1,'attendance_daily','write') ok",[args.userId]))[0].ok&&!ctx.selfPerson,summary:{people:new Set(rows.map(r=>String(r.person_id))).size,person_days:rows.length,segments:segments.length,planned_minutes:sum(rows,'planned_minutes'),worked_minutes:sum(rows,'worked_minutes'),overtime_minutes:sum(rows,'overtime_minutes'),missing_punches:sum(rows,'missing_punches'),late_minutes:sum(rows,'late_minutes'),early_minutes:sum(rows,'early_minutes'),support_segments:sum(rows,'support_segments'),corrected_segments:sum(rows,'corrected_segments')},notice:'全虚构演示；原雇主与实际工作门店分别记录。工时以分钟保存，按班段截取计薪工时。接收门店只见本店支援班段；货币分别统计。',rules:{timezone:'Asia/Shanghai / Asia/Hong_Kong (+08:00)',grace_minutes:0,late_rounding:'按实际分钟',overtime:'独立加班班段，以已记录实际工时为限',leave:'年假和假日示例全薪；病假示例80%；事假示例无薪；可配置，非客户正式政策',cn:'合成基本工资、假勤扣款、加班、津贴、社保公积金与个税测试参数',hk:'合成月薪或时薪、假期工资、加班、津贴、MPF；不套用内地社保个税'}};
}
export async function createChange(t,{userId,input}){
 const ctx=await periodContext(t,{userId,groupId:input.group_id,period:input.period,write:true});if(!ctx.period||ctx.period.status==='closed')bad('此月份没有可维护的排班');
 if(!['shift_swap','secondment','cross_brand_support'].includes(input.kind)||!Array.isArray(input.patches)||!input.patches.length||input.patches.length>50||typeof input.reason!=='string'||input.reason.trim().length<4)bad('请填写变更类型、班段和至少四字原因');
 const allowed=new Set(ctx.segments.map(s=>String(s.id)));for(const p of input.patches){if(!allowed.has(String(p.segment_id)))deny();if(p.work_company_id&&!ctx.company_ids.includes(String(p.work_company_id)))deny();}
 const row=(await q(t,'INSERT INTO ty_roster_change(period_id,kind,reason,patches,created_by)VALUES($1,$2,$3,$4::jsonb,$5)RETURNING *',[ctx.period.id,input.kind,input.reason,JSON.stringify(input.patches),userId]))[0];return{row};
}
export async function decideChange(t,{userId,id,input}){
 const a=await timeAccess(t,{userId,write:true});const c=(await q(t,'SELECT c.*,p.group_id,to_char(p.period,\'YYYY-MM\') period FROM ty_roster_change c JOIN ty_roster_period p ON p.id=c.period_id WHERE c.id=$1',[id]))[0];if(!c)deny();
 const ctx=await periodContext(t,{userId,groupId:c.group_id,period:c.period,write:true}),ids=new Set(ctx.segments.map(s=>String(s.id)));
 for(const p of c.patches)if(!ids.has(String(p.segment_id))||(p.work_company_id&&!ctx.company_ids.includes(String(p.work_company_id))))deny();
 if(typeof input.approve!=='boolean')bad('请明确通过或拒绝');
 const status=(await q(t,'SELECT fn_ty_roster_decide($1,$2,$3,$4) status',[id,userId,input.approve,input.note||'']))[0].status;return{id,status};
}
export async function correctPunch(t,{userId,input}){
 const ctx=await periodContext(t,{userId,groupId:input.group_id,period:input.period,write:true});if(!ctx.segments.some(s=>same(s.id,input.segment_id)))deny();
 if(!['in','out'].includes(input.direction)||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(input.corrected_at||''))bad('请填写补卡方向和完整日期时间');
 const row=(await q(t,'INSERT INTO ty_time_correction(segment_id,direction,corrected_at,reason,reviewed_by)VALUES($1,$2,$3::timestamp,$4,$5)RETURNING *',[input.segment_id,input.direction,input.corrected_at,input.reason,userId]))[0];return{row};
}
export async function closePeriod(t,{userId,input}){
 const ctx=await periodContext(t,{userId,groupId:input.group_id,period:input.period,write:true});if(!ctx.period||!ctx.complete||!ctx.a.shared(input.group_id,true))deny();
 if(input.confirm!==true)bad('请明确确认整月封存');
 const p=(await q(t,"UPDATE ty_roster_period SET status='closed',closed_by=$2,closed_at=clock_timestamp() WHERE id=$1 RETURNING *",[ctx.period.id,userId]))[0];return{period:p};
}
export async function exportReport(t,args){const r=await report(t,args),month=args.kind==='monthly';return csv({columns:[{key:'person_number',label:'永久工号'},{key:'full_name',label:'姓名'},{key:'home_company_name',label:'原雇主'},{key:month?'calendar_days':'work_date',label:month?'日历天数':'日期',numeric:month},...['planned_minutes','worked_minutes','actual_minutes','overtime_minutes','leave_minutes','late_minutes','early_minutes','missing_punches','corrected_segments','support_segments'].map((k,i)=>({key:k,label:['应出勤分钟','计薪在岗分钟','实际打卡分钟','加班分钟','请假分钟','迟到分钟','早退分钟','缺卡数','补卡班段数','支援班段数'][i],numeric:true}))],rows:(month?r.monthly:r.rows).map(x=>({...x,work_date:x.work_date?date(x.work_date):undefined}))});}

export async function saveShift(t,{userId,id,input}){const {a}=await timeAccess(t,{userId,write:true});const r=(await q(t,'SELECT * FROM ty_shift_definition WHERE id=$1',[id]))[0];if(!r||!a.shared(r.group_id,true))deny();if(!/^#[0-9a-fA-F]{6}$/.test(input.color||'')||typeof input.name!=='string'||!input.name.trim()||input.name.length>80)bad('班次名称必填，颜色须为六位十六进制');const row=(await q(t,'UPDATE ty_shift_definition SET name=$2,color=$3,updated_by=$4 WHERE id=$1 RETURNING *',[id,input.name.trim(),input.color,userId]))[0];await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,before_data,after_data)VALUES($1,'shift_style','shift',$2,$3::jsonb,$4::jsonb)",[userId,id,JSON.stringify(r),JSON.stringify(row)]);return{row};}
