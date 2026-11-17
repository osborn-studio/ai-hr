import{q,same,requireAccess,currentOperator}from'./platform-core.mjs';
const providers=new Set(['dingtalk','feishu','wecom']);
const permitted=async fn=>{try{await fn();return true;}catch(error){if(error.code==='E_TY_FORBIDDEN'||/^E_TY_FORBIDDEN:/.test(error.message))return false;throw error;}};
// Read-only local configuration projection. No counts, credentials, remote calls
// or implicit authority derived from notification/profile membership.
export async function ssoPreflight(t,{userId,connectionIds=[],references}){
 const items=[];if(!connectionIds.length)return{authorized:false,items};
 const connections=await q(t,'SELECT id,group_id,company_id,provider,name,status,(secret_cipher IS NOT NULL)secret_configured FROM ty_integration_connection WHERE id=ANY($1::bigint[])ORDER BY id',[connectionIds]);
 for(const c of connections){
  if(!providers.has(c.provider)||!await permitted(()=>requireAccess(t,userId,'integration_manage','write',{...c,fields:['config','capabilities']}))||!await permitted(()=>requireAccess(t,userId,'integration_manage','read',{...c,fields:['name','status','config','capabilities','secret_configured']})))continue;
  const approvedProfiles=(references?.profiles||[]).filter(p=>same(p.connection_id,c.id)&&p.status==='approved'&&p.current===true);let currentBinding=false;
  if(approvedProfiles.length)for(const binding of await q(t,"SELECT b.account_id,b.identity_id,i.person_id,p.group_id,p.company_id FROM ty_sso_operator_binding b JOIN ty_sso_profile p ON p.id=b.profile_id JOIN ty_ix_identity i ON i.id=b.identity_id WHERE b.profile_id=ANY($1::bigint[])AND fn_ty_sso_binding_current(b.id)",[approvedProfiles.map(p=>p.id)])){
   if(!(references?.identities||[]).some(i=>same(i.id,binding.identity_id))||!(references?.operators||[]).some(o=>same(o.id,binding.account_id)))continue;
   if(!await permitted(()=>requireAccess(t,userId,'integration_manage','read',{...binding,fields:['external_id','local_id','sources','status']})))continue;
   const operator=await currentOperator(t,binding.account_id);if(operator&&await permitted(()=>requireAccess(t,userId,'integration_manage','read',{...operator,fields:['local_id','status']}))){currentBinding=true;break;}
  }
  const stages={connection_enabled:c.status==='active',credentials_configured:c.secret_configured===true,internal_application_approved:(references?.runtime_profiles||[]).some(r=>same(r.connection_id,c.id)&&r.application_type==='internal'&&r.status==='approved'),visible_person_identity_approved:(references?.identities||[]).some(i=>same(i.connection_id,c.id)),visible_account_binding_current:currentBinding};
  items.push({connection_id:c.id,name:c.name,provider:c.provider,stages,all_visible_checks_ready:Object.values(stages).every(v=>v===true)});
 }
 return{authorized:items.length>0,scope:'current_authorized_local_configuration',network_checked:false,items};
}
