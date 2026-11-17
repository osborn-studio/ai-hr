import{randomBytes}from'node:crypto';
import*as h from'./hr-common.mjs';
import*as files from'./hr-files.mjs';
import{companyDescendants}from'./foundation.mjs';
import{sameHuman,humanIsPerson}from'./human-identity.mjs';
import{encryptSource,decryptSource}from'./integration-vault.mjs';
import{externalId}from'./esign-provider.mjs';
const safeError=e=>e.code==='E_TY_FORBIDDEN'||String(e.message).startsWith('E_TY_FORBIDDEN');
export const ESIGN_COMMANDS=['profile.save','profile.approve','party.save','party.approve','configuration.disable','intent.propose','intent.approve','intent.start','intent.poll','intent.reconcile','intent.accept'];
export const shapes={
 'profile.save':['group_id','company_id','code','name','environment','app_id','app_secret','evidence_ref'],
 'profile.approve':['id','expected_revision','review_ref'],
 'party.save':['profile_id','kind','company_id','person_id','external_id','transactor_id','valid_from','valid_to','evidence_ref'],
 'party.approve':['id','expected_revision','review_ref'],
 'configuration.disable':['kind','id','expected_revision','reason'],
 'intent.propose':['contract_id','expected_revision','profile_id','person_party_id','company_party_id','source_file_id','positions','evidence_ref'],
 'intent.approve':['id','expected_revision','review_ref'],
 'intent.start':['id','expected_revision','evidence_ref'],
 'intent.poll':['id','expected_revision'],
 'intent.reconcile':['id','expected_revision','remote_flow_id','evidence_ref'],
 'intent.accept':['id','expected_revision','review_ref']};
const current=async(t,kind,k)=>(await h.one(t,'SELECT fn_ty_es_'+kind+'_current($1) ok',[k])).ok;
const cryptoContext=(kind,id)=>'esign:'+kind+':'+id;
export function openCredentials(p){return JSON.parse(decryptSource(p.credential_cipher,cryptoContext('profile',p.id)).toString());}
export function sealReceipt(intent,receipt){return encryptSource(Buffer.from(JSON.stringify(receipt)),cryptoContext('receipt',intent.id));}
async function get(t,table,key,lock=false){const r=await h.one(t,'SELECT*FROM '+table+' WHERE id=$1'+(lock?' FOR UPDATE':''),[h.id(key)]);if(!r)h.missing();return r;}
export const getProfile=(t,id,lock=false)=>get(t,'ty_es_profile',id,lock);
export const getIntent=(t,id,lock=false)=>get(t,'ty_es_intent',id,lock);
const getParty=(t,id,lock=false)=>get(t,'ty_es_party',id,lock);
async function manage(t,userId,row,action,fields){await h.actor(t,userId,row.group_id);return h.requireAccess(t,userId,'integration_manage',action,{...row,fields});}
async function independent(t,user,row,author=row.created_by){if(await sameHuman(t,user,author)||row.person_id&&await humanIsPerson(t,user,row.group_id,row.person_id))h.deny('电子签事项须独立且非受益人员核定');}
async function fits(t,profile,company){if(profile.company_id&&!(await companyDescendants(t,profile.company_id)).map(String).includes(String(company)))h.deny('合同不在该电子签连接的公司范围');}
export async function contractContext(t,contractId,userId,action='read',fieldsNeeded=['sources']){
 const c=await get(t,'ty_hr_contract',contractId);const ctx={...await files.contextForEmployment(t,c.employment_id),...c};await h.actor(t,userId,c.group_id);const resource=await files.resourceFor(t,userId,ctx,'hr_contract');if(action!=='read'&&resource==='hr_self')h.deny('电子签外发及核定须由有权人事操作人员办理');await files.decision(t,userId,resource,action,ctx,fieldsNeeded);return ctx;
}
export async function authorizeIntent(t,userId,intent,action='read',content=false){
 const c=await contractContext(t,intent.contract_id,userId,action,['sources','attachments']);
 const source=await files.assertOwnedFile(t,{userId,fileId:intent.source_file_id,ownerKind:'contract',ownerId:c.id,content});await files.decision(t,userId,source.fileResource,'read',{...c,...source.file,department_id:c.department_id},source.fileResource==='hr_self'?['attachments.filename','attachments.sha256']:['filename','sha256']);if(intent.signed_file_id)await files.assertOwnedFile(t,{userId,fileId:intent.signed_file_id,ownerKind:'contract',ownerId:c.id,content});
 return c;
}
export async function readCurrentIntent(t,intent,{userId,action='write',content=true}={}){
 const c=await authorizeIntent(t,userId,intent,action,content),p=await getProfile(t,intent.profile_id),ps=await getParty(t,intent.person_party_id),co=await getParty(t,intent.company_party_id);
 if(c.status!=='draft'||c.revision!==intent.contract_revision||c.source_hash!==intent.contract_hash||!await current(t,'profile',p.id)||p.revision!==intent.profile_revision||!await current(t,'party',ps.id)||ps.revision!==intent.person_party_revision||!await current(t,'party',co.id)||co.revision!==intent.company_party_revision)h.conflict('合同、电子签连接或已核主体已有变化，请重新核定');
 await fits(t,p,c.company_id);const legal=await h.one(t,'SELECT*FROM fn_ty_hr_verified_legal_subject($1,$2)',[c.employment_id,c.starts_on]);if(!legal||!h.same(legal.legal_entity_company_id,c.legal_entity_company_id))h.conflict('合同真实雇主须已按有效日期核定');
 return{contract:c,profile:p,person:ps,organization:co};
}
const safeProfile=p=>({id:p.id,group_id:p.group_id,company_id:p.company_id,code:p.code,name:p.name,version:p.version,environment:p.environment,status:p.status,revision:p.revision,created_by:p.created_by,approved_by:p.approved_by,credential_configured:!!p.credential_cipher});
const safeParty=p=>({id:p.id,profile_id:p.profile_id,group_id:p.group_id,company_id:p.company_id,person_id:p.person_id,kind:p.kind,external_id:p.external_id,transactor_id:p.transactor_id,valid_from:p.valid_from,valid_to:p.valid_to,status:p.status,revision:p.revision,created_by:p.created_by,approved_by:p.approved_by});
const safeIntent=r=>({id:r.id,group_id:r.group_id,company_id:r.company_id,person_id:r.person_id,contract_id:r.contract_id,contract_revision:r.contract_revision,profile_id:r.profile_id,person_party_id:r.person_party_id,company_party_id:r.company_party_id,source_file_id:r.source_file_id,filename:r.filename,source_sha256:r.source_sha256,contract_code:r.contract_code,positions:r.positions,status:r.status,revision:r.revision,remote_file_id:r.remote_file_id,remote_flow_id:r.remote_flow_id,remote_status:r.remote_status,remote_checked_at:r.remote_checked_at,signed_file_id:r.signed_file_id,signed_sha256:r.signed_sha256,signed_on:r.signed_on?h.day(r.signed_on):null,verification_summary:r.verification_summary,created_by:r.created_by,approved_by:r.approved_by,started_by:r.started_by,accepted_by:r.accepted_by,accepted_at:r.accepted_at});
function positions(value){h.obj(value);if(Object.keys(value).sort().join(',')!=='employee,employer')h.bad('必须分别设置员工与雇主签署区');for(const p of Object.values(value)){h.obj(p);if(Object.keys(p).sort().join(',')!=='page,size,x,y'||!Number.isInteger(p.page)||p.page<1||p.page>500||!Number.isFinite(p.x)||p.x<0||p.x>20000||!Number.isFinite(p.y)||p.y<0||p.y>20000||!Number.isInteger(p.size)||p.size<30||p.size>400)h.bad('签署区页码、位置与尺寸无效');}return value;}
export async function enqueueJob(t,intent,step,userId,remoteClaim=null){return h.one(t,'INSERT INTO ty_es_job(intent_id,step,requested_by,expected_revision,remote_claim_id)VALUES($1,$2,$3,$4,$5)RETURNING id,step,state',[intent.id,step,userId,intent.revision,remoteClaim]);}
export async function dispatchCommand(t,{userId,input,operationId,operation}){
 const op=operation.replace(/^integration\.esign\./,'');if(!ESIGN_COMMANDS.includes(op))h.bad('未登记电子签操作');files.shape(input,shapes[op]);
 let scope;if(op==='profile.save')scope={...await h.actor(t,userId,input.group_id),company_id:input.company_id? h.id(input.company_id):null};
 else if(op.startsWith('profile.'))scope=await getProfile(t,input.id);
 else if(op==='party.save')scope=await getProfile(t,input.profile_id);
 else if(op==='party.approve')scope=await getParty(t,input.id);
 else if(op==='configuration.disable')scope=await get(t,input.kind==='profile'?'ty_es_profile':input.kind==='party'?'ty_es_party':h.bad('配置类型无效'),input.id);
 else if(op==='intent.propose')scope=await contractContext(t,input.contract_id,userId,'write',['sources','attachments']);
 else scope=await getIntent(t,input.id);
 if(!op.startsWith('intent.'))await manage(t,userId,scope,op.endsWith('approve')?'approve':'write',op.startsWith('party.')?['external_id','local_id','sources','status']:['config','capabilities','status']);
 else await authorizeIntent(t,userId,scope.contract_id?scope:{contract_id:scope.id,source_file_id:input.source_file_id},op.endsWith('approve')||op.endsWith('accept')||op.endsWith('reconcile')?'approve':'write',true);
 return h.command(t,{userId,groupId:scope.group_id,operation:'integration.esign.'+op,operationId,input,execute:async()=>{
  if(op==='profile.save'){
   if(input.company_id)await h.company(t,input.company_id,scope.group_id);if(!['sandbox','production'].includes(input.environment))h.bad('请选择官方沙箱或生产环境');
   const code=h.text(input.code,'连接编码',1,60),key=(await h.one(t,"SELECT nextval(pg_get_serial_sequence('ty_es_profile','id'))id")).id;
   const appId=externalId(input.app_id),secret=h.text(input.app_secret,'应用密钥',8,500),cipher=encryptSource(Buffer.from(JSON.stringify({app_id:appId,app_secret:secret})),cryptoContext('profile',key));
   await t.query('SELECT id FROM ty_group WHERE id=$1 FOR UPDATE',[scope.group_id]);const p=await h.one(t,"INSERT INTO ty_es_profile(id,group_id,company_id,code,name,version,environment,app_id,credential_cipher,evidence_ref,created_by)VALUES($1,$2,$3,$4,$5,(SELECT coalesce(max(version),0)+1 FROM ty_es_profile WHERE group_id=$2 AND code=$4),$6,$7,$8::jsonb,$9,$10)RETURNING*",[key,scope.group_id,scope.company_id,code,h.text(input.name,'连接名称',1,100),input.environment,appId,JSON.stringify(cipher),h.text(input.evidence_ref,'接口准入与密钥来源依据',4),userId]);return{profile:safeProfile(p)};
  }
  if(op==='profile.approve'||op==='party.approve'){
   const kind=op.split('.')[0],r=await get(t,kind==='profile'?'ty_es_profile':'ty_es_party',input.id,true);h.revision(r,input.expected_revision);if(r.status!=='draft')h.conflict('仅可核准待复核版本');await independent(t,userId,r);h.text(input.review_ref,'独立核对依据',4);if(kind==='party'&&!await current(t,'profile',r.profile_id))h.conflict('主体映射依赖的连接不是当前已核版本');const n=await h.one(t,'UPDATE ty_es_'+kind+" SET status='approved',revision=revision+1,approved_by=$2,approved_at=now()WHERE id=$1 RETURNING*",[r.id,userId]);return{[kind]:kind==='profile'?safeProfile(n):safeParty(n)};
  }
  if(op==='configuration.disable'){const table=input.kind==='profile'?'ty_es_profile':'ty_es_party',r=await get(t,table,input.id,true);h.revision(r,input.expected_revision);if(r.status==='disabled')h.conflict('配置已停用');h.text(input.reason,'停用原因',4);await t.query('UPDATE '+table+" SET status='disabled',revision=revision+1 WHERE id=$1",[r.id]);return{kind:input.kind,id:r.id,status:'disabled'};}
  if(op==='party.save'){
   const p=await getProfile(t,input.profile_id);if(!await current(t,'profile',p.id))h.conflict('请选择当前已核连接');const kind=input.kind;if(!['person','company'].includes(kind))h.bad('主体类型无效');let personId=null,companyId=input.company_id?h.id(input.company_id):null;
   if(companyId){await h.company(t,companyId,p.group_id);await fits(t,p,companyId);}if(kind==='person'){personId=h.id(input.person_id);await h.bestPersonProjection(t,{userId,personId,resource:'hr_people',keys:['full_name','person_number']});if(companyId&&!await h.one(t,'SELECT 1 FROM ty_employment WHERE person_id=$1 AND company_id=$2 AND group_id=$3',[personId,companyId,p.group_id]))h.bad('人员与映射公司没有明确雇佣关系');}else{if(!companyId||input.person_id)h.bad('机构映射必须明确本地法律雇主公司');await h.requireAccess(t,userId,'hr_contract','read',{group_id:p.group_id,company_id:companyId,fields:['legal_entity_company_id']});}
   const from=h.date(input.valid_from),to=input.valid_to?h.date(input.valid_to):null,transactor=kind==='company'?externalId(input.transactor_id):null;if(kind==='person'&&input.transactor_id)h.bad('员工本人映射不能传企业经办人');
   const r=await h.one(t,'INSERT INTO ty_es_party(profile_id,group_id,company_id,person_id,kind,local_key,external_id,transactor_id,valid_from,valid_to,evidence_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)RETURNING*',[p.id,p.group_id,companyId,personId,kind,kind+':'+(personId||companyId),externalId(input.external_id),transactor,from,to,h.text(input.evidence_ref,'实名主体与经办人核对依据',4),userId]);return{party:safeParty(r)};
  }
  if(op==='intent.propose'){
   const c=await contractContext(t,input.contract_id,userId,'write',['sources','attachments']);h.revision(c,input.expected_revision);if(c.status!=='draft')h.conflict('只有当前待签合同可建立外发意图');const p=await getProfile(t,input.profile_id),ps=await getParty(t,input.person_party_id),co=await getParty(t,input.company_party_id);await manage(t,userId,p,'read',['config','capabilities']);await fits(t,p,c.company_id);if(!await current(t,'profile',p.id)||!await current(t,'party',ps.id)||!await current(t,'party',co.id)||!h.same(ps.profile_id,p.id)||!h.same(co.profile_id,p.id)||!h.same(ps.person_id,c.person_id)||!h.same(co.company_id,c.legal_entity_company_id))h.bad('请选择同连接当前已核员工和真实雇主对照');
   const {file}=await files.assertOwnedFile(t,{userId,fileId:input.source_file_id,ownerKind:'contract',ownerId:c.id,content:true});if(file.mime!=='application/pdf'||file.filename.length>100||/[\\/:*"<>|？]/u.test(file.filename))h.bad('电子签需使用文件名规范的合同PDF原件');
   const key=randomBytes(16).toString('hex'),r=await h.one(t,"INSERT INTO ty_es_intent(intent_key,group_id,company_id,person_id,contract_id,contract_revision,contract_hash,profile_id,profile_revision,person_party_id,person_party_revision,company_party_id,company_party_revision,source_file_id,source_sha256,filename,contract_code,flow_title,positions,evidence_ref,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21)RETURNING*",[key,c.group_id,c.company_id,c.person_id,c.id,c.revision,c.source_hash,p.id,p.revision,ps.id,ps.revision,co.id,co.revision,file.id,file.sha256,file.filename,c.code,'TYHR-'+key,JSON.stringify(positions(input.positions)),h.text(input.evidence_ref,'待签原件与签署区核对依据',4),userId]);return{intent:safeIntent(r)};
  }
  const r=await getIntent(t,input.id,true);h.revision(r,input.expected_revision);const data=await readCurrentIntent(t,r,{userId,action:op==='intent.approve'||op==='intent.accept'||op==='intent.reconcile'?'approve':'write'});h.text(input.review_ref||input.evidence_ref||'主动核验','核对依据',4);
  if(op==='intent.approve'){
   if(r.status!=='draft')h.conflict('仅可核准待复核外发意图');await independent(t,userId,r);await manage(t,userId,data.profile,'sync',['config','capabilities']);const n=await h.one(t,"UPDATE ty_es_intent SET status='approved',approved_by=$2,approved_at=now(),revision=revision+1 WHERE id=$1 RETURNING*",[r.id,userId]);return{intent:safeIntent(n),job:await enqueueJob(t,n,'upload',userId)};
  }
  if(op==='intent.start'){
   if(r.status!=='external_draft'||r.remote_status!==0)h.conflict('须先核验已创建的外部草稿，再明确开启签署');await independent(t,userId,r);await manage(t,userId,data.profile,'sync',['config','capabilities']);await t.query('UPDATE ty_es_intent SET started_by=$2,revision=revision+1 WHERE id=$1',[r.id,userId]);return{job:await enqueueJob(t,{...r,revision:r.revision+1},'start',userId)};
  }
  if(op==='intent.poll'){
   if(!r.remote_flow_id||!['external_draft','signing','completed','unknown'].includes(r.status))h.conflict('当前事项没有可安全回读的已知流程');return{job:await enqueueJob(t,r,'poll',userId)};
  }
  if(op==='intent.reconcile'){
   if(r.status!=='unknown'||!r.remote_file_id||r.remote_flow_id)h.conflict('仅创建结果未知且文件已明确的流程可提交已知外部编号对账');await independent(t,userId,r);await manage(t,userId,data.profile,'sync',['sources','capabilities']);return{job:await enqueueJob(t,r,'reconcile',userId,externalId(input.remote_flow_id))};
  }
  if(op==='intent.accept'){
   if(r.status!=='completed'||!r.signed_file_id||new Date(r.remote_checked_at).valueOf()<Date.now()-10*60000)h.conflict('须先完成签署事实、原件SHA与签名有效性核验');await independent(t,userId,r);await independent(t,userId,r,data.contract.created_by);const n=await h.one(t,"UPDATE ty_es_intent SET status='accepted',accepted_by=$2,accepted_at=now(),accept_ref=$3,revision=revision+1 WHERE id=$1 RETURNING*",[r.id,userId,h.text(input.review_ref,'签署原件与证据独立核定依据',4)]);return{intent:safeIntent(n),native_sign_input:{id:r.contract_id,expected_revision:r.contract_revision,signed_on:r.signed_on?h.day(r.signed_on):null,evidence_file_id:r.signed_file_id,verification_ref:'电子签核验事项 #'+r.id+'；'+input.review_ref},native_contract_unchanged:true,structured_terms_unchanged:true};
  }
 }});
}
export async function workspace(t,{userId,input={}}){
 files.shape(input,['group_id','company_id','contract_id','profile_id','view','q','page','page_size']);const actor=await h.actor(t,userId,input.group_id),group=actor.group_id,view=input.view||'intents';if(!['profiles','parties','intents','references'].includes(view))h.bad('电子签视图无效');const companies=input.company_id?(await companyDescendants(t,h.id(input.company_id))).map(String):null,rows=[];const within=r=>h.same(r.group_id,group)&&(!companies||r.company_id&&companies.includes(String(r.company_id)));const permitted=async f=>{try{await f();return true;}catch(e){if(safeError(e))return false;throw e;}};
 const refs={profiles:[],parties:[],contracts:[],files:[],companies:[],people:[]};let canConfigure=false;try{await manage(t,userId,{group_id:group,company_id:input.company_id||null},'write',['config','capabilities','status']);canConfigure=true;}catch(e){if(!safeError(e))throw e;}
 if(view==='profiles'||view==='parties'||view==='references'){
  for(const p of await h.q(t,'SELECT*FROM ty_es_profile WHERE group_id=$1 ORDER BY id DESC',[group]))if(within(p)&&await permitted(()=>manage(t,userId,p,'read',['config','status']))){const dto={...safeProfile(p),current:await current(t,'profile',p.id)};if(view==='profiles')rows.push({...dto,allowed_actions:{approve:p.status==='draft'&&!await sameHuman(t,userId,p.created_by)&&await permitted(()=>manage(t,userId,p,'approve',['config','capabilities','status'])),disable:p.status!=='disabled'&&await permitted(()=>manage(t,userId,p,'write',['config','capabilities','status']))}});if(dto.current)refs.profiles.push(dto);}
  if(view!=='profiles')for(const b of await h.q(t,'SELECT*FROM ty_es_party WHERE group_id=$1 AND($2::bigint IS NULL OR profile_id=$2)ORDER BY id DESC',[group,input.profile_id||null]))if(within(b)&&await permitted(()=>manage(t,userId,b,'read',['external_id','local_id','sources','status']))){const dto={...safeParty(b),current:await current(t,'party',b.id)};if(view==='parties')rows.push({...dto,allowed_actions:{approve:b.status==='draft'&&!await sameHuman(t,userId,b.created_by)&&!(b.person_id&&await humanIsPerson(t,userId,group,b.person_id))&&await permitted(()=>manage(t,userId,b,'approve',['external_id','local_id','sources','status'])),disable:b.status!=='disabled'&&await permitted(()=>manage(t,userId,b,'write',['config','capabilities','status']))}});if(dto.current)refs.parties.push(dto);}
 }
 if(view==='intents')for(const r of await h.q(t,'SELECT*FROM ty_es_intent WHERE group_id=$1 AND($2::bigint IS NULL OR contract_id=$2)ORDER BY id DESC',[group,input.contract_id||null]))if(within(r)&&await permitted(()=>authorizeIntent(t,userId,r,'read'))){const native=await contractContext(t,r.contract_id,userId),dto={...safeIntent(r),native_contract_status:native.status},write=await permitted(()=>authorizeIntent(t,userId,r,'write',true)),approve=await permitted(()=>authorizeIntent(t,userId,r,'approve',true)),independentActor=!await sameHuman(t,userId,r.created_by)&&!await humanIsPerson(t,userId,group,r.person_id);dto.allowed_actions={approve:approve&&independentActor&&r.status==='draft',start:write&&independentActor&&r.status==='external_draft',poll:write&&!!r.remote_flow_id&&['external_draft','signing','completed','unknown'].includes(r.status),reconcile:approve&&independentActor&&r.status==='unknown'&&!!r.remote_file_id&&!r.remote_flow_id,accept:approve&&independentActor&&r.status==='completed',download:!!r.signed_file_id&&await permitted(()=>authorizeIntent(t,userId,r,'read',true)),native_sign:r.status==='accepted'&&approve&&native.status==='draft'};dto.jobs=await h.q(t,'SELECT id,step,state,error_code,created_at,finished_at FROM ty_es_job WHERE intent_id=$1 ORDER BY id DESC LIMIT 20',[r.id]);rows.push(dto);}
 if(view==='references'){
  if(canConfigure)for(const c of await h.q(t,'SELECT id,id company_id,group_id,name,legal_name FROM ty_company WHERE group_id=$1 ORDER BY id',[group]))if(within(c)&&await permitted(()=>manage(t,userId,c,'write',['external_id','local_id','sources','status'])))refs.companies.push(c);
  if(canConfigure)for(const p of await h.q(t,'SELECT id FROM ty_person WHERE group_id=$1 ORDER BY id',[group]))try{const pr=await h.bestPersonProjection(t,{userId,personId:p.id,resource:'hr_people',keys:['full_name','person_number']});refs.people.push({id:p.id,...Object.fromEntries(pr.allowed.map(k=>[k,pr.person[k]]))});}catch(e){if(!safeError(e))throw e;}
  if(input.contract_id){const c=await contractContext(t,input.contract_id,userId,'write',['sources','attachments']);if(!within(c))h.deny();refs.contracts.push({id:c.id,code:c.code,title:c.title,revision:c.revision,person_id:c.person_id,company_id:c.company_id,legal_entity_company_id:c.legal_entity_company_id,status:c.status,can_propose_esign:c.status==='draft'&&!await h.one(t,"SELECT 1 FROM ty_es_intent WHERE contract_id=$1 AND status<>'blocked'",[c.id])});const fl=await files.queryWorkspace(t,{userId,input:{group_id:group,owner_kind:'contract',owner_id:c.id,page_size:100}});refs.files=fl.rows.filter(f=>f.mime==='application/pdf'&&f.allowed_actions.includes('file.download'));}
 }
 return{...h.paging(h.search(rows,input.q,['name','code','external_id','contract_code','status','remote_flow_id']),input),capabilities:{can_configure:canConfigure},...(view==='references'?{references:refs}:{}),metadata:{provider:'esign_v3',external_connections_verified:false,callbacks_supported:false,completion_is_native_activation:false}};
}
export async function receiptDownload(t,{userId,input}){files.shape(input,['id']);const r=await getIntent(t,input.id);await authorizeIntent(t,userId,r,'read',true);if(!r.receipt_cipher)h.conflict('签署核验回执尚未归档');const bytes=decryptSource(r.receipt_cipher,cryptoContext('receipt',r.id));await h.audit(t,userId,r.group_id,'esign.receipt.download','esign_intent',r.id);return{filename:'电子签核验回执-'+r.id+'.json',mime:'application/json',content_base64:bytes.toString('base64')};}
// This guard is also called by native manual-sign/approval submission paths.
// Unrelated paper originals retain the existing native signing rules.
export async function assertNativeEvidence(t,{contract,input}){
 if(!(await h.one(t,"SELECT to_regclass('public.ty_es_intent')IS NOT NULL ok")).ok)return{external:false};
 const fileId=h.id(input.evidence_file_id),references=await h.q(t,'SELECT*FROM ty_es_intent WHERE source_file_id=$1 OR signed_file_id=$1',[fileId]);if(!references.length)return{external:false};
 if(references.some(r=>h.same(r.source_file_id,fileId)))h.conflict('电子签待签原件不能作为手工签后原件登记，请选择本次已核签后材料');
 const r=references.find(r=>h.same(r.signed_file_id,fileId)&&h.same(r.contract_id,contract.id)&&r.status==='accepted'),file=await h.one(t,'SELECT*FROM ty_hr_file_asset WHERE id=$1',[fileId]);
 if(!r||r.contract_revision!==contract.revision||r.contract_hash!==contract.source_hash||!h.same(r.group_id,contract.group_id)||!h.same(r.company_id,contract.company_id)||!h.same(r.person_id,contract.person_id)||h.day(r.signed_on)!==h.date(input.signed_on)||!file||file.owner_kind!=='contract'||!h.same(file.owner_id,contract.id)||file.sha256!==r.signed_sha256)h.conflict('电子签后材料须已由HR核定并对应当前合同正文、版本及主体；修改后的合同须重新收集对应签署材料');
 return{external:true,intent_id:r.id};
}
