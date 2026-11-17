// Server-only source for service acceptance. Receiving reports are work-location
// views of the same employer quantity, never a second service obligation.
import{q,one,id,same,bad,deny,missing,hash,requireAccess,currentOperator}from'./platform-core.mjs';
import{accessFor}from'./foundation.mjs';
const day=v=>v instanceof Date?new Date(v.getTime()+8*3600000).toISOString().slice(0,10):String(v).slice(0,10);
const max=(a,b)=>a>b?a:b,min=(a,b)=>a<b?a:b;
const fields=['worked_minutes','overtime_minutes','source_ref','company_id'];
const periodEnd=p=>new Date(Date.UTC(Number(p.slice(0,4)),Number(p.slice(5,7)),0)).toISOString().slice(0,10);

// The shared database check also detects a taken leave changing underneath an
// unchanged report head. Earlier migration fixtures do not have this check.
export async function isServiceTimeReportCurrent(t,reportId,employmentId){
 const installed=await one(t,"SELECT to_regprocedure('public.fn_ty_time_leave_current(bigint,bigint)')IS NOT NULL installed");
 if(!installed?.installed)return true;
 return(await one(t,'SELECT fn_ty_time_leave_current($1::bigint,$2::bigint)current',[reportId,employmentId]))?.current===true;
}

export async function getServiceQuantitySource(t,{userId,employerRootId,throughDate}){
 const operator=await currentOperator(t,userId);if(!operator||operator.status!=='active'||operator.profile_code==='config_admin'||(await accessFor(t,userId)).selfOnly)deny('服务量来源须有当前HR核勤读取权限');
 const root=await one(t,`SELECT h.*,to_char(h.period,'YYYY-MM-DD')period,to_char(e.hire_date,'YYYY-MM-DD')hire_date,to_char(e.leave_date,'YYYY-MM-DD')leave_date,e.status employment_status,e.company_id home_company_id,e.group_id employment_group_id,e.person_id employment_person_id FROM ty_time_report_root h JOIN ty_employment e ON e.id=h.employment_id WHERE h.id=$1`,[id(employerRootId)]);if(!root)missing();if(!same(root.group_id,root.employment_group_id)||!same(root.person_id,root.employment_person_id))deny('核勤根与实际人员身份不符');if(root.perspective!=='employer'||!same(root.owner_company_id,root.home_company_id))bad('仅雇主核勤根可作为服务总量；接收店视图不另增服务量');
 const period=day(root.period).slice(0,7),from=max(period+'-01',day(root.hire_date)),fullTo=min(periodEnd(period),root.leave_date?day(root.leave_date):periodEnd(period));let to=fullTo;if(throughDate!==undefined){const today=day((await one(t,"SELECT(clock_timestamp()AT TIME ZONE 'Asia/Shanghai')::date business_date")).business_date);if(typeof throughDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(throughDate)||!Number.isFinite(Date.parse(throughDate+'T00:00Z'))||new Date(throughDate+'T00:00Z').toISOString().slice(0,10)!==throughDate||throughDate<from||throughDate>fullTo||throughDate>today)bad('计量截止日须在实际在职区间及已发生日期内');to=throughDate;}if(from>to||root.employment_status==='cancelled')bad('实际工作关系不覆盖所选期间');
 const scope={group_id:root.group_id,company_id:root.home_company_id,person_id:root.person_id};
 const departments=await q(t,"SELECT DISTINCT department_id FROM ty_position_assignment WHERE employment_id=$1 AND status<>'cancelled'AND valid_from<=$3::date AND(valid_to IS NULL OR valid_to>$2::date)",[root.employment_id,from,to]);
 for(const d of departments.length?departments:[{}])await requireAccess(t,userId,'attendance_daily','read',{...scope,department_id:d.department_id,fields});
 const report=root.current_report_id?await one(t,`SELECT r.*,to_char(r.period,'YYYY-MM-DD')period FROM ty_time_report_version r WHERE r.id=$1`,[root.current_report_id]):null;
 const result={status:'pending',employer_root_id:root.id,group_id:root.group_id,person_id:root.person_id,employment_id:root.employment_id,home_company_id:root.home_company_id,period,current_report_id:root.current_report_id,head_revision:root.head_revision,coverage_from:from,coverage_to:to,quantity_through_date:throughDate??null,interval_bounds:'closed',source_unit:'minute',worked_minutes:null,overtime_minutes:null,total_service_minutes:null,location_status:'allocation_required',allocations:[],source_fact_keys:[],pending_reasons:[]};
 if(!report||report.status!=='confirmed'){result.pending_reasons.push('EMPLOYER_REPORT_NOT_CONFIRMED');result.source_hash=hash({root,report,through_date:throughDate??null,coverage_from:from,coverage_to:to});return result;}
 if(!await one(t,'SELECT 1 FROM ty_time_report_scope WHERE report_id=$1 AND root_id=$2',[report.id,root.id]))bad('当前核勤版本未冻结该雇主根');
 if(!await isServiceTimeReportCurrent(t,report.id,root.employment_id)){result.pending_reasons.push('EMPLOYER_REPORT_LEAVE_RECONCILIATION_REQUIRED');result.source_hash=hash({root,report,through_date:throughDate??null,coverage_from:from,coverage_to:to,leave_source_current:false});return result;}
 const lines=await q(t,`SELECT l.*,to_char(l.work_date,'YYYY-MM-DD')work_date FROM ty_time_report_line l WHERE report_id=$1 AND employment_id=$2 AND NOT receiving_store_only AND home_company_id=$3 AND scope_company_id=$3 AND(work_date IS NULL OR work_date BETWEEN $4::date AND $5::date)ORDER BY l.work_date NULLS LAST,l.id`,[report.id,root.employment_id,root.home_company_id,from,to]);
 const days=Math.round((Date.parse(to+'T00:00Z')-Date.parse(from+'T00:00Z'))/86400000)+1;
 const coverage=report.grain==='daily'?lines.length===days&&new Set(lines.map(r=>day(r.work_date))).size===days&&lines.every(r=>r.work_date&&day(r.work_date)>=from&&day(r.work_date)<=to):to===fullTo&&lines.length===1&&lines[0].work_date===null&&Number(lines[0].calendar_days)===days;
 if(!coverage)result.pending_reasons.push('EMPLOYMENT_COVERAGE_UNVERIFIED');
 const known=lines.length>0&&lines.every(r=>r.worked_minutes!==null&&r.worked_minutes!==undefined&&r.overtime_minutes!==null&&r.overtime_minutes!==undefined);
 if(!known)result.pending_reasons.push('WORKED_OR_OVERTIME_MINUTES_UNKNOWN');
 const adjusted=!!await one(t,'SELECT 1 FROM ty_time_report_adjustment WHERE report_id=$1 AND line_id=ANY($2::bigint[])',[report.id,lines.map(r=>r.id)]);
 let exactLocations=coverage&&known&&report.grain==='daily'&&!report.source_report_id&&!adjusted;const allocations=[],lineage=[];
 for(const line of lines){const stores=new Set(),facts=[];
  for(const ref of new Set(line.source_segment_ids||[])){
   const value=String(ref),match=/^(?:(base|plan):)?([0-9]+)$/.exec(value);if(!match){exactLocations=false;continue;}
   const kind=match[1]||'base',segment=kind==='plan'?await one(t,'SELECT s.*,p.group_id FROM ty_time_plan_segment s JOIN ty_time_plan_version p ON p.id=s.plan_id WHERE s.id=$1',[match[2]]):await one(t,`SELECT s.*,to_char(s.start_at,'YYYY-MM-DD"T"HH24:MI:SS.US')||'+08:00'start_at,to_char(s.end_at,'YYYY-MM-DD"T"HH24:MI:SS.US')||'+08:00'end_at,p.group_id FROM v_ty_time_segment s JOIN ty_roster_period p ON p.id=s.period_id WHERE s.id=$1`,[match[2]]);
   if(!segment){exactLocations=false;continue;}if(!same(segment.group_id,root.group_id)||!same(segment.employment_id,root.employment_id)||!same(segment.person_id,root.person_id))deny('核勤班段血缘不属于实际人员或工作关系');
   await requireAccess(t,userId,'attendance_daily','read',{...scope,company_id:segment.work_company_id,department_id:segment.department_id,fields});
   const fact='time:'+hash({employment_id:root.employment_id,work_date:day(segment.work_date),start_at:new Date(segment.start_at).toISOString(),end_at:new Date(segment.end_at).toISOString(),work_company_id:segment.work_company_id,source:segment.source_ref||kind+':'+segment.id});facts.push(fact);lineage.push({reference:kind+':'+segment.id,fact,work_company_id:segment.work_company_id,work_date:day(segment.work_date)});stores.add(String(segment.work_company_id));
  }
  if(line.worked_minutes===null||line.overtime_minutes===null)continue;
  const regular=BigInt(line.worked_minutes),overtime=BigInt(line.overtime_minutes),total=regular+overtime;if(total===0n)continue;
  if(stores.size!==1||facts.length===0||!line.work_date){exactLocations=false;continue;}
  allocations.push({work_company_id:[...stores][0],coverage_from:day(line.work_date),coverage_to:day(line.work_date),interval_bounds:'closed',worked_minutes:regular.toString(),overtime_minutes:overtime.toString(),total_service_minutes:total.toString(),source_unit:'minute',source_fact_keys:[...new Set(facts)]});
 }
 result.source_fact_keys=[...new Set(lineage.map(r=>r.fact))];if(!result.source_fact_keys.length)result.source_fact_keys=['employer-month:'+root.group_id+':'+root.employment_id+':'+period];
 result.source_hash=hash({root_id:root.id,current_report_id:root.current_report_id,head_revision:root.head_revision,coverage_from:from,coverage_to:to,through_date:throughDate??null,report:report.id,lines,lineage});
 if(coverage&&known){result.status='verified';result.worked_minutes=lines.reduce((n,r)=>n+BigInt(r.worked_minutes),0n).toString();result.overtime_minutes=lines.reduce((n,r)=>n+BigInt(r.overtime_minutes),0n).toString();result.total_service_minutes=(BigInt(result.worked_minutes)+BigInt(result.overtime_minutes)).toString();}
 if(exactLocations&&allocations.reduce((n,r)=>n+BigInt(r.total_service_minutes),0n)===BigInt(result.total_service_minutes||'0')){result.allocations=allocations;result.location_status=new Set(allocations.map(r=>r.work_company_id)).size<=1?'verified_single_location':'verified_allocations';}else if(result.status==='verified')result.pending_reasons.push('WORK_LOCATION_ALLOCATION_REQUIRES_REVIEW');
 return result;
}
