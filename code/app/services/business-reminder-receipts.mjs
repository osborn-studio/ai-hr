import{one,q,id,hash,conflict,requireAccess}from'./platform-core.mjs';
import{encryptSource}from'./integration-vault.mjs';
import{reminderContext,REMINDER_FIELDS}from'./business-reminders.mjs';
import{feishuReadObservations,receiptTimestamp}from'./notification-receipt-provider.mjs';
export async function receiptQueryIntent(t,job){
 const delivery=await one(t,'SELECT * FROM ty_br_delivery WHERE id=$1',[job.delivery_id]);if(!delivery||!delivery.job_id||!delivery.remote_id||delivery.acceptance_state!=='provider_accepted')conflict('回执查询须对应实际已受理消息');
 await requireAccess(t,job.requested_by,'integration_manage','sync',{...delivery,fields:REMINDER_FIELDS});const ctx=await reminderContext(t,delivery,{requireAction:false}),transport=await one(t,'SELECT * FROM ty_ix_job WHERE id=$1',[delivery.job_id]);const receipt=await one(t,"SELECT * FROM ty_ix_delivery_receipt WHERE id=$1 AND job_id=$2 AND outcome='confirmed'AND remote_id=$3",[delivery.transport_receipt_id,transport.id,delivery.remote_id]);if(!receipt)conflict('平台消息编号缺少225真实响应事实');return{...ctx,delivery,job:{...transport,completed_at:receipt.created_at}};
}
export async function appendReceiptObservations(t,{connection,observations,deliveryId=null,envelopeId=null,receiptJobId=null,proofKind='authenticated_query'}){
 const result=[];for(const value of observations){
  const key=value.source_key??'query:'+receiptJobId+':'+hash({remote:value.remote_id,recipient:value.recipient_external_id,kind:value.kind,reported_at:value.reported_at,raw:value.raw}),payloadHash=hash(value.raw),old=await one(t,'SELECT * FROM ty_br_observation WHERE connection_id=$1 AND source_key=$2',[connection.id,key]);if(old){if(old.payload_hash!==payloadHash)conflict('同一回执来源键的内容不一致');result.push(old);continue;}
  const raw=envelopeId?{source_envelope_id:envelopeId,payload_hash:payloadHash,event_id:value.raw?.header?.event_id,remote_id:value.remote_id,recipient_external_id:value.recipient_external_id,kind:value.kind,reported_at:value.reported_at}:value.raw,seal=encryptSource(raw,'business-reminder-receipt:'+connection.id+':'+key);
  const o=await one(t,'INSERT INTO ty_br_observation(connection_id,envelope_id,receipt_job_id,source_key,proof_kind,provider,remote_id,recipient_external_id,kind,reported_at,payload_hash,payload_cipher,payload_iv,payload_tag)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)RETURNING *',[connection.id,envelopeId,receiptJobId,key,proofKind,connection.provider,value.remote_id,value.recipient_external_id,value.kind,value.reported_at,payloadHash,seal.payload_cipher,seal.payload_iv,seal.payload_tag]);
  await applyReceiptObservation(t,o,{deliveryId});result.push(o);
 }return result;
}
export async function applyReceiptObservation(t,o,{deliveryId=null}={}){
 const candidates=await q(t,"SELECT d.*,j.remote_id transport_remote_id,z.created_at transport_completed_at FROM ty_br_delivery d JOIN ty_ix_job j ON j.id=d.job_id JOIN ty_ix_delivery_receipt z ON z.id=d.transport_receipt_id AND z.job_id=j.id AND z.outcome='confirmed' WHERE d.connection_id=$1 AND z.remote_id=$2 AND d.recipient_external_id=$3 AND($4::bigint IS NULL OR d.id=$4)FOR UPDATE OF d",[o.connection_id,o.remote_id,o.recipient_external_id,deliveryId]);
 if(candidates.length!==1)return{unmatched:true};const d=candidates[0];
 await t.query('SAVEPOINT notification_receipt_authority');try{
  await reminderContext(t,d,{requireAction:false});
  if(o.reported_at)receiptTimestamp(String(new Date(o.reported_at).valueOf()),{earliest:new Date(d.transport_completed_at).valueOf()});
  await t.query('RELEASE SAVEPOINT notification_receipt_authority');
 }catch(e){await t.query('ROLLBACK TO SAVEPOINT notification_receipt_authority');await t.query('RELEASE SAVEPOINT notification_receipt_authority');await t.query("UPDATE ty_br_observation SET state='blocked',error_code='E_NOTIFICATION_RECEIPT_AUTHORITY'WHERE id=$1",[o.id]);return{blocked:true};}
 // Reading implies delivery, but neither225 acceptance nor an unread report
 // claims delivery to a device. Late unread/empty results never erase a read.
 await t.query("UPDATE ty_br_delivery SET remote_id=$2,acceptance_state='provider_accepted',read_state=CASE WHEN $3='read'THEN'provider_reported_read'WHEN read_state='provider_reported_read'THEN read_state WHEN $3='unread'THEN'provider_reported_unread'ELSE read_state END,delivery_state=CASE WHEN $3='read'THEN'implied_by_read'ELSE delivery_state END,platform_result=CASE WHEN read_state='provider_reported_read'THEN'read'ELSE $3 END,reported_read_at=CASE WHEN $3='read'AND $4::timestamptz IS NOT NULL THEN greatest(coalesce(reported_read_at,$4::timestamptz),$4::timestamptz)ELSE reported_read_at END,observed_read_at=CASE WHEN $3='read'THEN coalesce(observed_read_at,clock_timestamp())ELSE observed_read_at END,revision=revision+1 WHERE id=$1",[d.id,o.remote_id,o.kind,o.reported_at]);
 await t.query("UPDATE ty_br_observation SET delivery_id=$2,state='applied',error_code=NULL,applied_at=now()WHERE id=$1",[o.id,d.id]);return{applied:true,delivery_id:d.id};
}
export async function matchPendingReceipts(t,{limit=50}={}){let applied=0;for(const o of await q(t,"SELECT * FROM ty_br_observation WHERE state='unmatched'AND created_at>clock_timestamp()-interval'7 days'ORDER BY last_checked_at NULLS FIRST,id LIMIT $1 FOR UPDATE SKIP LOCKED",[limit])){await t.query('UPDATE ty_br_observation SET last_checked_at=clock_timestamp()WHERE id=$1',[o.id]);if((await applyReceiptObservation(t,o)).applied)applied++;}return{applied};}
//225 supplies verified/decrypted payload and the committed-in-this-transaction
// raw envelope. No public typed command accepts trusted callback objects.
export async function receiveBusinessReminderReceipt(t,{connection,profile,envelopeId,payload}){
 if(connection.provider!=='feishu'||payload?.header?.event_type!=='im.message.message_read_v1')return{supported:false};
 if(!(await one(t,"SELECT to_regclass('public.ty_br_rule')IS NOT NULL ok")).ok)return{supported:false};
 if(!await one(t,"SELECT 1 FROM ty_br_rule WHERE connection_id=$1 AND profile_id=$2 AND status='approved'",[connection.id,profile.id]))return{supported:false};
 const observations=feishuReadObservations(payload,{connection,profile}),saved=await appendReceiptObservations(t,{connection,observations,envelopeId,proofKind:'verified_callback'});return{supported:true,received:saved.length,native_approval_changed:false};
}
