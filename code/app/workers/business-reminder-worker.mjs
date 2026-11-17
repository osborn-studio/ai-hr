import{randomUUID}from'node:crypto';import{withTx}from'../db.mjs';import{one}from'../services/platform-core.mjs';
import{scanReminderRules,synchronizeReminderTransport}from'../services/business-reminders.mjs';
import{receiptQueryIntent,appendReceiptObservations,matchPendingReceipts}from'../services/business-reminder-receipts.mjs';
import{queryNotificationReceipt}from'../services/notification-receipt-provider.mjs';
import{readConnectionCredentials,scrubError}from'../services/integration-vault.mjs';
const clear='lease_token=NULL,lease_until=NULL';
export async function claimBusinessReminderReceipt(db){return withTx(db,async t=>{
 const j=await one(t,"SELECT * FROM ty_br_receipt_job WHERE state='queued'OR(state='leased'AND lease_until<=clock_timestamp())ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");if(!j)return null;
 let intent;try{intent=await receiptQueryIntent(t,j);}catch{await t.query("UPDATE ty_br_receipt_job SET state='blocked',"+clear+",error_code='E_NOTIFICATION_RECEIPT_AUTHORITY',revision=revision+1 WHERE id=$1",[j.id]);return{blocked:true,id:j.id};}
 const receiptJob=await one(t,"UPDATE ty_br_receipt_job SET state='leased',lease_token=$2,lease_until=clock_timestamp()+interval'2 minutes',attempts=attempts+1,revision=revision+1 WHERE id=$1 RETURNING *",[j.id,randomUUID()]);return{receiptJob,...intent};
});}
export async function finishBusinessReminderReceipt(db,claim,{result,error}={}){return withTx(db,async t=>{
 const j=await one(t,'SELECT * FROM ty_br_receipt_job WHERE id=$1 FOR UPDATE',[claim.receiptJob.id]);if(!j||j.state!=='leased'||j.lease_token!==claim.receiptJob.lease_token||new Date(j.lease_until)<=new Date())return{stale_lease:true,id:claim.receiptJob.id};
 if(error){const e=scrubError(error);await t.query("UPDATE ty_br_receipt_job SET state='failed',"+clear+",error_code=$2,revision=revision+1 WHERE id=$1",[j.id,e.code]);return{id:j.id,state:'failed',error_code:e.code};}
 let ctx;try{ctx=await receiptQueryIntent(t,j);}catch{await t.query("UPDATE ty_br_receipt_job SET state='blocked',"+clear+",error_code='E_NOTIFICATION_RECEIPT_AUTHORITY_CHANGED',revision=revision+1 WHERE id=$1",[j.id]);return{id:j.id,state:'blocked'};}
 await t.query('SAVEPOINT notification_query_result');try{const saved=await appendReceiptObservations(t,{connection:ctx.connection,observations:result.observations,deliveryId:ctx.delivery.id,receiptJobId:j.id});await t.query('RELEASE SAVEPOINT notification_query_result');
  await t.query('UPDATE ty_br_delivery SET last_polled_at=now(),revision=revision+1 WHERE id=$1',[ctx.delivery.id]);await t.query("UPDATE ty_br_receipt_job SET state='completed',"+clear+",result=$2::jsonb,completed_at=now(),revision=revision+1 WHERE id=$1",[j.id,JSON.stringify({observations:saved.length,response_hash:result.response_hash,native_approval_changed:false,local_read_changed:false})]);return{id:j.id,state:'completed',observations:saved.length};
 }catch(e){await t.query('ROLLBACK TO SAVEPOINT notification_query_result');await t.query('RELEASE SAVEPOINT notification_query_result');await t.query("UPDATE ty_br_receipt_job SET state='blocked',"+clear+",error_code='E_NOTIFICATION_RECEIPT_SOURCE',revision=revision+1 WHERE id=$1",[j.id]);return{id:j.id,state:'blocked'};}
});}
export async function businessReminderTick(db,{fetchImpl}={}){
 if(!(await one(db,"SELECT to_regclass('public.ty_br_rule')IS NOT NULL ok")).ok)return{available:false};
 const dispatch=await withTx(db,async t=>{const a=await scanReminderRules(t),b=await synchronizeReminderTransport(t),c=await matchPendingReceipts(t);return{...a,...b,...c};}),claim=await claimBusinessReminderReceipt(db);if(!claim)return{...dispatch,idle:true};if(claim.blocked)return{...dispatch,...claim};
 try{const credentials=readConnectionCredentials(claim.connection),result=await queryNotificationReceipt({...claim,credentials,fetchImpl});return{...dispatch,...await finishBusinessReminderReceipt(db,claim,{result})};}catch(error){return{...dispatch,...await finishBusinessReminderReceipt(db,claim,{error})};}
}
export function startBusinessReminderWorker(db,{intervalMs=30000,onError=()=>{},...options}={}){let stopped=false,pending=null,timer;const run=()=>{if(stopped||pending)return;pending=(async()=>{try{await businessReminderTick(db,options);}catch(e){onError({code:scrubError(e).code});}finally{pending=null;if(!stopped){timer=setTimeout(run,Math.max(1000,intervalMs));timer.unref?.();}}})();};run();return async()=>{stopped=true;clearTimeout(timer);await pending;};}
