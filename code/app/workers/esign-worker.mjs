import{randomBytes}from'node:crypto';
import{withTx}from'../db.mjs';
import*as h from'../services/hr-common.mjs';
import*as files from'../services/hr-files.mjs';
import*as service from'../services/esign-integration.mjs';
import{esignClient,sha256,externalId,createFlowPayload,verifyFlow,verifiedEvidence}from'../services/esign-provider.mjs';
// Only this owned worker crosses the network. Business commands never send signatures.
export async function runEsignJob(db,{jobId=null,fetchImpl}={}){
 if(!fetchImpl&&process.env.TYHR_ESIGN_ALLOW_LIVE!=='1')return{state:'not_configured',code:'E_ESIGN_LIVE_DISABLED'};
 const lease=randomBytes(24).toString('hex');let claim,unconfirmedWrite=false;
 const finish=async(fn,checkAuthority=true)=>withTx(db,async t=>{const job=await h.one(t,"SELECT*FROM ty_es_job WHERE id=$1 AND lease_key=$2 AND state='running'AND lease_until>clock_timestamp()FOR UPDATE",[claim.job.id,lease]);if(!job)h.conflict('电子签办理租约已失效');const r=await service.getIntent(t,job.intent_id,true);if(checkAuthority){await service.readCurrentIntent(t,r,{userId:job.requested_by,action:job.step==='reconcile'?'approve':'write'});await service.readCurrentIntent(t,r,{userId:r.approved_by,action:'approve'});}return fn(t,job,r);});
 try{
  claim=await withTx(db,async t=>{
   const expired=await h.q(t,"UPDATE ty_es_job SET state='unknown',error_code='E_ESIGN_LEASE_EXPIRED',finished_at=now(),revision=revision+1 WHERE state='running'AND lease_until<=clock_timestamp()RETURNING intent_id");for(const e of expired)await t.query("UPDATE ty_es_intent SET status='unknown',revision=revision+1 WHERE id=$1 AND status<>'accepted'",[e.intent_id]);
   const job=await h.one(t,"SELECT*FROM ty_es_job WHERE state='queued'AND($1::bigint IS NULL OR id=$1)ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",[jobId]);if(!job)return null;const r=await service.getIntent(t,job.intent_id,true);await t.query("UPDATE ty_es_job SET state='running',lease_key=$2,lease_until=clock_timestamp()+interval'3 minutes',revision=revision+1 WHERE id=$1",[job.id,lease]);return{job,intent:r};
  });
  if(!claim)return{state:'idle'};
  claim={...claim,...await withTx(db,async t=>{const r=await service.getIntent(t,claim.intent.id);h.revision(r,claim.job.expected_revision);const data=await service.readCurrentIntent(t,r,{userId:claim.job.requested_by,action:claim.job.step==='reconcile'?'approve':'write'});await service.readCurrentIntent(t,r,{userId:r.approved_by,action:'approve'});if(await(await import('../services/human-identity.mjs')).sameHuman(t,r.created_by,r.approved_by))h.deny();const download=await files.downloadFile(t,{userId:claim.job.requested_by,input:{file_id:r.source_file_id}}),bytes=Buffer.from(download.content_base64,'base64');if(sha256(bytes)!==r.source_sha256)h.conflict('待签原件完整性不一致');return{...data,bytes,credentials:service.openCredentials(data.profile)};})};
  const client=esignClient({environment:claim.profile.environment,credentials:claim.credentials,...(fetchImpl?{fetchImpl}:{})}),r=claim.intent,j=claim.job,context={intent:r,person:claim.person,organization:claim.organization};let result;
  if(j.step==='upload'){
   if(r.remote_file_id||r.remote_flow_id||r.status!=='approved')h.conflict('外部文件已有事实，不自动重新上传');
   unconfirmedWrite=true;const remote=await client.allocate({content:claim.bytes,name:r.filename}),fileId=externalId(remote?.fileId);
   await finish(async(t,job,x)=>{await service.readCurrentIntent(t,x,{userId:job.requested_by});await t.query('UPDATE ty_es_intent SET remote_file_id=$2,revision=revision+1 WHERE id=$1',[x.id,fileId]);});
   await client.transfer(remote.fileUploadUrl,{method:'PUT',bytes:claim.bytes});const state=await client.file(fileId);if(state.fileId!==fileId||![2,5].includes(state.fileStatus))throw Object.assign(Error('文件上传尚未完成'),{code:'E_ESIGN_FILE_NOT_READY'});
   result=await finish(async(t,job,x)=>{await service.readCurrentIntent(t,x,{userId:job.requested_by});await t.query("UPDATE ty_es_job SET state='succeeded',finished_at=now(),revision=revision+1 WHERE id=$1",[job.id]);const next=await service.enqueueJob(t,x,'create',job.requested_by);return{next_job_id:next.id,already_finished:true};});unconfirmedWrite=false;
  }else if(j.step==='create'){
   if(r.status!=='approved'||!r.remote_file_id||r.remote_flow_id)h.conflict('只有已上传且尚未创建流程的核准意图可发起');
   unconfirmedWrite=true;const flow=await client.create(createFlowPayload({...context,fileId:r.remote_file_id})),flowId=externalId(flow?.signFlowId);
   await finish(async(t,job,x)=>{await service.readCurrentIntent(t,x,{userId:job.requested_by});await t.query('UPDATE ty_es_intent SET remote_flow_id=$2,revision=revision+1 WHERE id=$1',[x.id,flowId]);});unconfirmedWrite=false;
   const detail=await client.detail(flowId);verifyFlow(detail,context);if(detail.signFlowStatus!==0)throw Object.assign(Error('外部创建未保持草稿'),{code:'E_ESIGN_FLOW_MISMATCH'});
   result=await finish(async(t,job,x)=>{await service.readCurrentIntent(t,x,{userId:job.requested_by});await t.query("UPDATE ty_es_intent SET status='external_draft',remote_status=0,remote_checked_at=now(),revision=revision+1 WHERE id=$1",[x.id]);return{remote_state:'draft'};});
  }else if(j.step==='start'){
   if(r.status!=='external_draft'||r.remote_status!==0||!r.remote_flow_id||!r.started_by)h.conflict('须明确开启已核对外部草稿');const before=await client.detail(r.remote_flow_id);verifyFlow(before,context);if(before.signFlowStatus!==0)h.conflict('外部状态已变，先主动核验');unconfirmedWrite=true;await client.start(r.remote_flow_id);
   const detail=await client.detail(r.remote_flow_id);verifyFlow(detail,context);if(![1,2].includes(detail.signFlowStatus))throw Object.assign(Error('外部开启结果未明确'),{code:'E_ESIGN_REMOTE_UNKNOWN'});
   result=await finish(async(t,job,x)=>{await service.readCurrentIntent(t,x,{userId:job.requested_by});await t.query("UPDATE ty_es_intent SET status='signing',remote_status=$2,remote_checked_at=now(),revision=revision+1 WHERE id=$1",[x.id,detail.signFlowStatus]);return{remote_state:'signing'};});unconfirmedWrite=false;
  }else if(j.step==='poll'||j.step==='reconcile'){
   const flowId=j.step==='reconcile'?externalId(j.remote_claim_id):r.remote_flow_id;if(!flowId)h.conflict('缺少明确外部流程，禁止自动重新创建');const detail=await client.detail(flowId),status=verifyFlow(detail,{...context,completed:detail.signFlowStatus===2});
   result=await finish(async(t,job,x)=>{await service.readCurrentIntent(t,x,{userId:job.requested_by,action:j.step==='reconcile'?'approve':'write'});const state=status===0?'external_draft':status===2&&x.signed_file_id?'completed':[1,2].includes(status)?'signing':'blocked';const n=await h.one(t,"UPDATE ty_es_intent SET remote_flow_id=$2,status=$3,remote_status=$4,remote_checked_at=now(),revision=revision+1 WHERE id=$1 RETURNING*",[x.id,flowId,state,status]);if(status===2&&!x.signed_file_id){await t.query("UPDATE ty_es_job SET state='succeeded',finished_at=now(),revision=revision+1 WHERE id=$1",[job.id]);const next=await service.enqueueJob(t,n,'retrieve',job.requested_by);return{remote_state:'completed_evidence_pending',next_job_id:next.id,already_finished:true};}return{remote_state:state};});
  }else if(j.step==='retrieve'){
   if(!r.remote_flow_id||r.remote_status!==2||r.signed_file_id)h.conflict('仅已完成且未归档证据的流程可取签后原件');
   const detail=await client.detail(r.remote_flow_id);verifyFlow(detail,{...context,completed:true});const download=await client.download(r.remote_flow_id);if(download?.files?.length!==1||download.files[0].fileId!==r.remote_file_id)throw Object.assign(Error('原件文件对照不同'),{code:'E_ESIGN_FILE_MISMATCH'});
   const bytes=await client.transfer(download.files[0].downloadUrl),evidence=await client.evidence(r.remote_flow_id),verification=await client.verify(r.remote_flow_id,r.remote_file_id),summary=verifiedEvidence({bytes,download,evidence,verification,intent:r});
   result=await finish(async(t,job,x)=>{await service.readCurrentIntent(t,x,{userId:job.requested_by});await service.readCurrentIntent(t,x,{userId:x.approved_by,action:'approve'});const stored=await files.dispatchCommand(t,{userId:job.requested_by,operation:'file.upload',operationId:'ESIGN:'+x.id+':SIGNED:'+summary.sha256,input:{group_id:x.group_id,owner_kind:'contract',owner_id:x.contract_id,filename:x.filename.replace(/\.pdf$/i,'')+'-已签.pdf',mime:'application/pdf',content_base64:bytes.toString('base64'),sha256:summary.sha256,sensitivity:'restricted'}}),signedOn=new Date(detail.signFlowFinishTime+8*3600000).toISOString().slice(0,10),receipt=service.sealReceipt(x,{provider:'esign_v3',environment:claim.profile.environment,flow_id:r.remote_flow_id,source_file_sha256:r.source_sha256,signed_sha256:summary.sha256,detail,evidence,verification,verified_at:new Date().toISOString(),native_contract_activation:false});await t.query("UPDATE ty_es_intent SET status='completed',signed_file_id=$2,signed_sha256=$3,signed_on=$4,receipt_cipher=$5::jsonb,verification_summary=$6::jsonb,remote_checked_at=now(),revision=revision+1 WHERE id=$1",[x.id,stored.file_id,summary.sha256,signedOn,JSON.stringify(receipt),JSON.stringify(summary)]);return{remote_state:'completed',native_contract_unchanged:true};});
  }
  if(!result?.already_finished)await finish(async(t,job)=>{await t.query("UPDATE ty_es_job SET state='succeeded',finished_at=now(),revision=revision+1 WHERE id=$1",[job.id]);});
  return{job_id:j.id,state:'succeeded',...result};
 }catch(error){
  if(!claim)throw error;
  const code=/^E_[A-Z0-9_]+$/.test(error.code||'')?error.code:'E_ESIGN_BLOCKED',unknown=code==='E_ESIGN_REMOTE_UNKNOWN'||unconfirmedWrite&&code!=='E_ESIGN_PROVIDER_REJECTED';
  await finish(async(t,job,r)=>{await t.query('UPDATE ty_es_job SET state=$2,error_code=$3,finished_at=now(),revision=revision+1 WHERE id=$1',[job.id,unknown?'unknown':'failed',code]);const safeRead=['poll','retrieve','reconcile'].includes(job.step);if(unconfirmedWrite||!safeRead||!unknown)await t.query("UPDATE ty_es_intent SET status=$2,revision=revision+1 WHERE id=$1 AND status<>'accepted'",[r.id,unknown?'unknown':'blocked']);await h.audit(t,job.requested_by,r.group_id,'esign.job.'+(unknown?'unknown':'failed'),'esign_job',job.id,{step:job.step,error_code:code});},false).catch(()=>{});
  return{job_id:claim.job.id,state:unknown?'unknown':'failed',error_code:code};
 }
}
export function startEsignWorker(db,{intervalMs=2000,onError=()=>{},...options}={}){
 let stopped=false,pending=null;
 const tick=()=>{if(stopped||pending)return pending??Promise.resolve();pending=(async()=>{try{await runEsignJob(db,options);}catch(error){await onError(error);}finally{pending=null;}})();return pending;};
 const timer=setInterval(()=>void tick().catch(()=>{}),Math.max(1000,Number(intervalMs)||2000));timer.unref?.();void tick().catch(()=>{});
 return async()=>{stopped=true;clearInterval(timer);await(pending??Promise.resolve());};
}
