// Only this restricted read worker performs external IO; short DB transactions
// recheck current authority before the call and again before sealed ingestion.
import{randomUUID}from'node:crypto';import{withTx}from'../db.mjs';
import{one,hash}from'../services/platform-core.mjs';
import{readRecruitingIntent,ingestRecruitingEvents}from'../services/recruiting-integration.mjs';
import{readConnectionCredentials,scrubError}from'../services/integration-vault.mjs';
import{pullRecruitingApplications}from'../services/recruiting-provider.mjs';
const clear='lease_token=NULL,lease_until=NULL';
export async function claimRecruitingJob(db){return withTx(db,async t=>{
 const j=await one(t,"SELECT * FROM ty_rc_job WHERE state='queued'OR(state='leased'AND lease_until<=clock_timestamp())ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");if(!j)return null;
 let intent;try{intent=await readRecruitingIntent(t,j);}catch{await t.query("UPDATE ty_rc_job SET state='blocked',"+clear+",error_code='E_RECRUIT_CURRENT_AUTHORITY',revision=revision+1 WHERE id=$1",[j.id]);return{blocked:true,id:j.id};}
 await t.query('SELECT id FROM ty_rc_channel WHERE id=$1 FOR UPDATE',[j.channel_id]);if(await one(t,"SELECT 1 FROM ty_rc_job WHERE channel_id=$1 AND id<>$2 AND state='leased'AND lease_until>clock_timestamp()",[j.channel_id,j.id]))return null;
 const job=await one(t,"UPDATE ty_rc_job SET state='leased',lease_token=$2,lease_until=clock_timestamp()+interval'5 minutes',attempts=attempts+1,revision=revision+1 WHERE id=$1 RETURNING *",[j.id,randomUUID()]);return{job,...intent};
});}
export async function finishRecruitingJob(db,claim,{result,error}={}){return withTx(db,async t=>{
 const j=await one(t,'SELECT * FROM ty_rc_job WHERE id=$1 FOR UPDATE',[claim.job.id]);if(!j||j.state!=='leased'||j.lease_token!==claim.job.lease_token||new Date(j.lease_until)<=new Date())return{stale_lease:true,id:claim.job.id};
 if(error){const safe=scrubError(error);await t.query("UPDATE ty_rc_job SET state='failed',"+clear+",error_code=$2,result=$3::jsonb,revision=revision+1 WHERE id=$1",[j.id,safe.code,JSON.stringify({retry_after:safe.retry_after,external_write_performed:false})]);return{id:j.id,state:'failed',error_code:safe.code};}
 let intent;try{intent=await readRecruitingIntent(t,j);}catch{await t.query("UPDATE ty_rc_job SET state='blocked',"+clear+",error_code='E_RECRUIT_AUTHORITY_CHANGED',revision=revision+1 WHERE id=$1",[j.id]);return{id:j.id,state:'blocked'};}
 // If one item is invalid, this page is not partially accepted. The savepoint
 // retains a real failed job result without leaving half a source page behind.
 await t.query('SAVEPOINT recruiting_ingest');let saved;try{saved=await ingestRecruitingEvents(t,{channel:intent.channel,userId:j.created_by,events:result.events,jobId:j.id});await t.query('RELEASE SAVEPOINT recruiting_ingest');}catch(e){await t.query('ROLLBACK TO SAVEPOINT recruiting_ingest');await t.query('RELEASE SAVEPOINT recruiting_ingest');await t.query("UPDATE ty_rc_job SET state='blocked',"+clear+",error_code='E_RECRUIT_SOURCE_CONFLICT',revision=revision+1 WHERE id=$1",[j.id]);return{id:j.id,state:'blocked',source_conflict:true};}
 const receipt={received_count:saved.length,next_cursor:result.next_cursor??null,response_hash:result.response_hash,coverage:result.coverage,external_write_performed:false,candidates_created:0};
 await t.query("UPDATE ty_rc_job SET state='completed',"+clear+",error_code=NULL,result=$2::jsonb,completed_at=now(),revision=revision+1 WHERE id=$1",[j.id,JSON.stringify(receipt)]);return{id:j.id,state:'completed',...receipt};
});}
export async function recruitingTick(db,{fetchImpl}={}){
 if(!(await one(db,"SELECT to_regclass('public.ty_rc_job')IS NOT NULL ok")).ok)return{available:false};
 const claim=await claimRecruitingJob(db);if(!claim)return{idle:true};if(claim.blocked)return claim;
 try{const credentials=readConnectionCredentials(claim.connection),result=await pullRecruitingApplications({...claim,credentials,request:claim.job.request,fetchImpl});return await finishRecruitingJob(db,claim,{result});}catch(error){return finishRecruitingJob(db,claim,{error});}
}
// Optional single-process lifecycle hook. The host awaits stop() before closing
// its DB; a read already in flight still undergoes the finish authority checks.
export function startRecruitingWorker(db,{intervalMs=2000,onError=()=>{}}={}){
 let stopped=false,timer=null,inflight=null;const delay=Math.max(1000,Math.min(60000,intervalMs));
 const schedule=()=>{if(stopped)return;inflight=(async()=>{try{await recruitingTick(db);}catch(error){onError({code:scrubError(error).code});}finally{inflight=null;if(!stopped){timer=setTimeout(schedule,delay);timer.unref?.();}}})();};
 schedule();return async()=>{stopped=true;clearTimeout(timer);await inflight;};
}
