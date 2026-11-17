// Deadline processing performs no network calls. A published exam is the
// persisted authorization intent; its creator's current authority is rechecked
// on every seal. Revocation blocks execution and emits one reassignment notice.
import{withTx}from'../db.mjs';import{dispatchCommand}from'../services/learning-native.mjs';
export async function learningDeadlineTick(db,{limit=100}={}){if(!(await db.query("SELECT to_regclass('public.ty_lr_attempt')IS NOT NULL ok")).rows[0].ok)return{available:false,sealed:0,blocked:0};const candidates=(await db.query("SELECT a.id,a.group_id,a.deadline_revision,e.created_by FROM ty_lr_attempt a JOIN ty_lr_exam e ON e.id=a.exam_id WHERE a.status='in_progress'AND a.deadline_at<=clock_timestamp()ORDER BY a.deadline_at,a.id LIMIT $1",[Math.min(100,Math.max(1,limit))])).rows;let sealed=0,blocked=0;for(const a of candidates){try{await withTx(db,t=>dispatchCommand(t,{userId:a.created_by,operation:'learning.attempt.seal',operationId:`LR-DEADLINE:${a.id}:${a.deadline_revision}`,input:{group_id:a.group_id,id:a.id,deadline_revision:a.deadline_revision}}));sealed++;}catch(e){blocked++;await withTx(db,t=>t.query("INSERT INTO ty_platform_outbox(group_id,event_key,event_type,payload)VALUES($1,$2,'LearningDeadlineNeedsReview',$3::jsonb)ON CONFLICT DO NOTHING",[a.group_id,`learning:deadline:${a.id}:${a.deadline_revision}:blocked`,JSON.stringify({attempt_id:a.id,deadline_revision:a.deadline_revision,reason_code:e.code??'E_LEARNING_DEADLINE',domain_applied:false})]));}}return{available:true,sealed,blocked};}
export function startLearningDeadlineWorker(db,{intervalMs=5000,onError=()=>{}}={}){
 let stopped=false,pending=null;
 const tick=()=>{if(stopped||pending)return pending??Promise.resolve();pending=(async()=>{try{await learningDeadlineTick(db);}catch(e){await onError(e);}finally{pending=null;}})();return pending;};
 const timer=setInterval(()=>{void tick().catch(()=>{});},Math.max(1000,intervalMs));timer.unref?.();void tick().catch(()=>{});
 // Existing callers may stop synchronously; shutdown can await this same batch
 // before closing PostgreSQL. No subsequent interval may start a new batch.
 return()=>{stopped=true;clearInterval(timer);return pending??Promise.resolve();};
}
