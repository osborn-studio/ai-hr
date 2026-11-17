import { withTx } from '../db.mjs';
import { one } from '../services/platform-core.mjs';
import { processJob } from '../services/payroll-scripts.mjs';

export async function payrollScriptTick(db) {
  // One current task, one short bounded WASM evaluation. Reauthorise its
  // original operator now; no service-account or old-grant fallback.
  const candidate=await one(db,"SELECT j.id,j.revision,j.created_by FROM ty_ps_job j WHERE j.state='queued'ORDER BY j.id LIMIT 1");
  if(!candidate)return{idle:true};
  try{return await withTx(db,t=>processJob(t,{userId:candidate.created_by,operationId:'PS-WORKER-JOB-'+candidate.id,input:{id:candidate.id,expected_revision:candidate.revision}}));}
  catch(error){
    await withTx(db,async t=>{const current=await one(t,'SELECT * FROM ty_ps_job WHERE id=$1 FOR UPDATE',[candidate.id]);if(current?.state==='queued')await t.query("UPDATE ty_ps_job SET state='blocked',revision=revision+1,processed_by=$2,processed_at=now(),reason=$3 WHERE id=$1",[current.id,candidate.created_by,error.code||'E_SCRIPT_PREVIEW_BLOCKED']);});
    return{job_id:candidate.id,state:'blocked',reason:error.code||'E_SCRIPT_PREVIEW_BLOCKED'};
  }
}
export function startPayrollScriptWorker(db,{intervalMs=3000}={}){
 let stopped=false,pending=null;
 const tick=()=>{if(stopped||pending)return pending;pending=payrollScriptTick(db).catch(()=>({state:'worker_error'})).finally(()=>{pending=null;});return pending;};
 const timer=setInterval(tick,Math.max(1000,intervalMs));timer.unref?.();
 const stop=async()=>{stopped=true;clearInterval(timer);await pending;};stop.tick=tick;return stop;
}
