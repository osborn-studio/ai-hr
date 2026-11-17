import{one,q}from'./platform-core.mjs';
// A scoped workflow must identify one actual department. Ambiguous concurrent
// employments require broader authorization; an arbitrary primary row is unsafe.
export async function subjectDepartment(t,{groupId,companyId,personId,asOf=null}){
 if(!groupId||!companyId||!personId)return null;
 const rows=await q(t,`SELECT DISTINCT a.department_id FROM ty_employment e JOIN ty_position_assignment a ON a.employment_id=e.id WHERE e.group_id=$1 AND e.company_id=$2 AND e.person_id=$3 AND e.status<>'cancelled' AND e.hire_date<=coalesce($4::date,app_today())AND(e.leave_date IS NULL OR e.leave_date>=coalesce($4::date,app_today()))AND a.status<>'cancelled' AND a.valid_from<=coalesce($4::date,app_today())AND(a.valid_to IS NULL OR a.valid_to>coalesce($4::date,app_today()))AND a.department_id IS NOT NULL`,[groupId,companyId,personId,asOf]);
 return rows.length===1?rows[0].department_id:null;
}
export async function snapshotScopeAvailable(t){return !!(await one(t,"SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'AND table_name='ty_workflow_instance'AND column_name='department_id')ok")).ok;}
