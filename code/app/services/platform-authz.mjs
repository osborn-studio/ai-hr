import {hashPassword}from'./auth.mjs';
import{q,one,same,bad,deny,conflict,missing,id,text,obj,list,revision,groupFor,requireAccess,authorization,command,audit,currentOperator,visibleOperators,newSecret,search,paging}from'./platform-core.mjs';

export const ACTIONS=['read','write','create','update','delete','submit','cancel','approve','publish','execute','export','manage','design','simulate','reset_password','sync'];
async function roleFor(t,roleId,group){const r=await one(t,'SELECT * FROM ty_auth_role WHERE id=$1 AND group_id=$2',[id(roleId),group]);if(!r)missing();return r;}
async function targetOperator(t,operatorId,group){const r=await currentOperator(t,id(operatorId));if(!r||!same(r.group_id,group))missing();return r;}
async function createLegacyRole(t,code,name){await t.query('LOCK TABLE sys_role IN SHARE ROW EXCLUSIVE MODE');return one(t,'INSERT INTO sys_role(id,code,name,description)SELECT coalesce(max(id),0)+1,$1,$2,$3 FROM sys_role RETURNING *',[code,name,'统一完整授权投影，不作为独立配置入口']);}
async function scopeProjection(t,group,company,name){
 await t.query('LOCK TABLE sys_data_scope IN SHARE ROW EXCLUSIVE MODE');
 const s=await one(t,"INSERT INTO sys_data_scope(id,name,combinator)SELECT coalesce(max(id),0)+1,$1,'intersection' FROM sys_data_scope RETURNING id",[name]);
 const bindings=await q(t,`WITH RECURSIVE cs AS(SELECT id FROM ty_company WHERE group_id=$1 AND($2::bigint IS NULL OR id=$2)
 UNION SELECT c.id FROM ty_company c JOIN cs p ON c.parent_company_id=p.id WHERE c.group_id=$1)
 SELECT b.* FROM ty_legacy_company_binding b JOIN cs ON cs.id=b.company_id`,[group,company||null]);
 for(const[dimension,col]of[['cost_org','legacy_org_id'],['attendance_org','legacy_org_id'],['payroll_legal_entity','payroll_legal_entity_id'],['si_entity','si_legal_entity_id']]){
  const ids=[...new Set(bindings.map(b=>b[col]).filter(Boolean).map(String))];
  await t.query('INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids)VALUES($1,$2,$3,$4::bigint[])',[s.id,dimension,ids.length?'nodes':'none',ids]);
 }return s.id;
}
function window(input){const parse=v=>{if(typeof v!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(v)||!Number.isFinite(Date.parse(v)))bad('授权时间须为含时区的ISO时间');return new Date(v);};const from=input.valid_from?parse(input.valid_from):new Date(),to=input.valid_to?parse(input.valid_to):null;if(to&&to<=from)bad('授权有效时间无效');return{from,to};}
function safeProjection(g,{role=false}={}){return g.status!=='revoked'&&g.actions.every(x=>['read','write'].includes(x))&&(!g.actions.includes('write')||g.actions.includes('read'))&&g.fields_allow?.length===1&&g.fields_allow[0]==='*'&&!g.fields_deny?.length&&!g.department_ids?.length&&!g.person_ids?.length&&(!role||!g.company_id&&!g.valid_to&&new Date(g.valid_from)<=new Date());}
async function withdrawProjection(t,legacyId){if(!legacyId)return;await t.query('UPDATE sys_user_role SET superseded_by=id WHERE id=$1 AND superseded_by IS NULL',[legacyId]);}
async function refreshLegacyResource(t,legacyRole,resource,grants,{role=false}={}){const safe=grants.filter(g=>safeProjection(g,{role}));await t.query('INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)VALUES($1,$2,$3,$4)ON CONFLICT(role_id,resource_code)DO UPDATE SET can_read=EXCLUDED.can_read,can_write=EXCLUDED.can_write',[legacyRole,resource,safe.some(g=>g.actions.includes('read')),safe.some(g=>g.actions.includes('write'))]);}
async function membershipProjection(t,{account,group,company,legacyRole,source,validFrom=new Date(),validTo=null,previous=null}){
 const scope=await scopeProjection(t,group,company,`统一授权 ${source}`);
 // Date-only legacy intervals are rounded INWARD, never granting even a partial
 // day before/after an exact native interval. Native pages retain exact instants.
 const span=await one(t,"SELECT CASE WHEN($1::timestamptz AT TIME ZONE app_tz())::time='00:00:00'THEN($1::timestamptz AT TIME ZONE app_tz())::date ELSE($1::timestamptz AT TIME ZONE app_tz())::date+1 END::text AS starts_on,($2::timestamptz AT TIME ZONE app_tz())::date::text AS ends_on,($1::timestamptz AT TIME ZONE app_tz())::date::text AS context_from,CASE WHEN $2::timestamptz IS NULL THEN NULL WHEN($2::timestamptz AT TIME ZONE app_tz())::time='00:00:00'THEN($2::timestamptz AT TIME ZONE app_tz())::date ELSE($2::timestamptz AT TIME ZONE app_tz())::date+1 END::text AS context_to",[validFrom,validTo]);
 const empty=span.ends_on&&span.starts_on>=span.ends_on;
 const row=await one(t,"INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,effective_to,grant_kind,grant_reason)VALUES($1,$2,$3,$4,$5,'ROLE',$6)RETURNING id",[account,legacyRole,scope,span.starts_on,empty?null:span.ends_on,'平台内部可撤销投影；不是独立授权来源']);
 if(previous)await t.query('UPDATE sys_user_role SET superseded_by=$2 WHERE id=$1 AND superseded_by IS NULL',[previous,row.id]);if(empty)await withdrawProjection(t,row.id);
 await t.query("INSERT INTO ty_access_grant(account_id,group_id,company_id,can_read,can_write,valid_from,valid_to,platform_source_key)VALUES($1,$2,$3,true,true,$4,$5,$6)ON CONFLICT(platform_source_key)WHERE platform_source_key IS NOT NULL DO UPDATE SET company_id=EXCLUDED.company_id,can_read=true,can_write=true,valid_from=EXCLUDED.valid_from,valid_to=EXCLUDED.valid_to",[account,group,company||null,span.context_from,span.context_to,source]);
 return{legacy_membership_id:row.id,legacy_scope_id:scope};
}
async function markManaged(t,account,group,resource){await t.query('INSERT INTO ty_auth_managed(account_id,group_id,resource)VALUES($1,$2,$3)ON CONFLICT DO NOTHING',[account,group,resource]);}
async function syncRoleResource(t,roleId,legacyRole,resource){const rows=(await q(t,"SELECT * FROM ty_auth_grant WHERE role_id=$1 AND resource=$2 AND status='active'",[roleId,resource])).filter(r=>safeProjection(r,{role:true}));await t.query('INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)VALUES($1,$2,$3,$4)ON CONFLICT(role_id,resource_code)DO UPDATE SET can_read=EXCLUDED.can_read,can_write=EXCLUDED.can_write',[legacyRole,resource,rows.some(r=>r.actions.includes('read')),rows.some(r=>r.actions.includes('write'))]);}

export async function saveRole(t,{userId,input,operationId}){
 const g=await groupFor(t,userId,input.group_id);await requireAccess(t,userId,'system_configuration','write',{group_id:g.id});
 return command(t,{userId,groupId:g.id,operation:'role.save',operationId,input,execute:async()=>{
  const name=text(input.name,'角色名称',1,100);let r;
  if(input.id){const old=await roleFor(t,input.id,g.id);revision(old,input.expected_revision);r=await one(t,'UPDATE ty_auth_role SET name=$2,status=$3,revision=revision+1 WHERE id=$1 RETURNING *',[old.id,name,input.status==='disabled'?'disabled':'active']);await t.query('UPDATE sys_role SET name=$2,is_active=$3 WHERE id=$1',[r.legacy_role_id,name,r.status==='active']);}
  else{const code=text(input.code,'角色编码',2,60);if(!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(code))bad('角色编码须为字母开头的稳定编码');const legacy=await createLegacyRole(t,`ty.custom.${g.id}.${code}`,name);r=await one(t,'INSERT INTO ty_auth_role(group_id,legacy_role_id,code,name,created_by)VALUES($1,$2,$3,$4,$5)RETURNING *',[g.id,legacy.id,code,name,userId]);}
  await audit(t,userId,g.id,'role.save','role',r.id,{name:r.name,status:r.status});return{role:r};
 }});
}
export async function assignRole(t,{userId,input,operationId}){
 const g=await groupFor(t,userId,input.group_id);await requireAccess(t,userId,'system_configuration','write',{group_id:g.id,company_id:input.company_id});
 const role=await roleFor(t,input.role_id,g.id),account=await targetOperator(t,input.account_id,g.id);if(role.status!=='active'||account.status!=='active')bad('角色和操作人员须为启用状态');if(same(account.id,userId)&&account.profile_code==='config_admin')deny('配置账号不能通过角色分配为自己增加业务权限');
 return command(t,{userId,groupId:g.id,operation:'role.assign',operationId,input,execute:async()=>{
  const company=id(input.company_id,true);if(company&&!await one(t,'SELECT id FROM ty_company WHERE id=$1 AND group_id=$2',[company,g.id]))bad('公司范围不属于集团');
  const{from,to}=window(input);
  const m=await one(t,'INSERT INTO ty_auth_membership(group_id,role_id,account_id,company_id,valid_from,valid_to,created_by)VALUES($1,$2,$3,$4,$5,$6,$7)RETURNING *',[g.id,role.id,account.id,company,from,to,userId]);
  const projected=await membershipProjection(t,{account:account.id,group:g.id,company,legacyRole:role.legacy_role_id,source:`membership:${m.id}`,validFrom:from,validTo:to});
  await t.query('UPDATE ty_auth_membership SET legacy_membership_id=$2,legacy_scope_id=$3 WHERE id=$1',[m.id,projected.legacy_membership_id,projected.legacy_scope_id]);
  for(const r of await q(t,"SELECT DISTINCT resource FROM ty_auth_grant WHERE role_id=$1 AND status='active'",[role.id]))await markManaged(t,account.id,g.id,r.resource);
  await audit(t,userId,g.id,'role.assign','membership',m.id,{account_id:account.id,role_id:role.id,company_id:company});return{membership:{...m,...projected}};
 }});
}
export async function revokeMember(t,{userId,input,operationId}){
 const m=await one(t,'SELECT * FROM ty_auth_membership WHERE id=$1',[id(input.membership_id)]);if(!m)missing();await requireAccess(t,userId,'system_configuration','write',m);
 return command(t,{userId,groupId:m.group_id,operation:'role.revoke_member',operationId,input,execute:async()=>{
  const locked=await one(t,'SELECT * FROM ty_auth_membership WHERE id=$1 FOR UPDATE',[m.id]);revision(locked,input.expected_revision);text(input.reason,'撤销原因',4);
  const row=await one(t,"UPDATE ty_auth_membership SET status='revoked',revision=revision+1 WHERE id=$1 RETURNING *",[m.id]);await withdrawProjection(t,locked.legacy_membership_id);
  await t.query("UPDATE ty_access_grant SET can_read=false,can_write=false WHERE platform_source_key=$1",[`membership:${m.id}`]);
  await audit(t,userId,m.group_id,'role.revoke','membership',m.id,{reason:input.reason,projection_withdrawal:'platform_internal_self_marker',legacy_projection_id:locked.legacy_membership_id,successor_created:false});return{membership:row};
 }});
}
export async function saveGrant(t,{userId,input,operationId}){
 const g=await groupFor(t,userId,input.group_id);await requireAccess(t,userId,'system_configuration','write',{group_id:g.id,company_id:input.company_id});
 const resource=text(input.resource,'功能资源',1,64);if(!await one(t,'SELECT 1 FROM sys_perm_resource WHERE resource_code=$1',[resource]))bad('功能资源未登记');
 const actions=[...new Set(list(input.actions,'功能动作'))];if(!actions.length||actions.some(x=>!ACTIONS.includes(x)))bad('功能动作未登记');
 const company=id(input.company_id,true);if(company&&!await one(t,'SELECT 1 FROM ty_company WHERE id=$1 AND group_id=$2',[company,g.id]))bad('公司范围不属于集团');
 const departments=list(input.department_ids||[]).map(x=>id(x)),people=list(input.person_ids||[]).map(x=>id(x));
 if(departments.length&&Number((await one(t,'SELECT count(*) n FROM ty_department d JOIN ty_company c ON c.id=d.company_id WHERE d.id=ANY($1::bigint[])AND c.group_id=$2',[departments,g.id])).n)!==new Set(departments).size)bad('部门范围不属于集团');
 if(people.length&&Number((await one(t,'SELECT count(*) n FROM ty_person WHERE id=ANY($1::bigint[])AND group_id=$2',[people,g.id])).n)!==new Set(people).size)bad('人员范围不属于集团');
 if(company&&(departments.length||people.length)){const cs=(await q(t,'WITH RECURSIVE c AS(SELECT id FROM ty_company WHERE id=$1 AND group_id=$2 UNION ALL SELECT x.id FROM ty_company x JOIN c ON x.parent_company_id=c.id WHERE x.group_id=$2)SELECT id FROM c',[company,g.id])).map(x=>x.id);if(departments.length&&Number((await one(t,'SELECT count(*) n FROM ty_department WHERE id=ANY($1::bigint[])AND company_id=ANY($2::bigint[])',[departments,cs])).n)!==new Set(departments).size)bad('部门不在授权公司范围');if(people.length&&Number((await one(t,'SELECT count(DISTINCT person_id)n FROM ty_employment WHERE person_id=ANY($1::bigint[])AND company_id=ANY($2::bigint[])AND status<>\'cancelled\'',[people,cs])).n)!==new Set(people).size)bad('人员没有授权公司的有效或历史雇佣');}

 const role=input.subject_type==='role'?await roleFor(t,input.role_id,g.id):null,account=role?null:await targetOperator(t,input.account_id,g.id);
 if(account&&same(account.id,userId)&&account.profile_code==='config_admin'&&!['system_configuration','workflow_manage','integration_manage'].includes(resource))deny('配置账号不能为自己增加业务数据权限');
 const allow=list(input.fields_allow||['*']),disallow=list(input.fields_deny||[]);if([...allow,...disallow].some(f=>typeof f!=='string'||f.length>120))bad('字段编码无效');
 const{from,to}=window(input);text(input.reason,'授权原因',4);
 return command(t,{userId,groupId:g.id,operation:'grant.save',operationId,input,execute:async()=>{
  let row;if(input.id){const old=await one(t,'SELECT * FROM ty_auth_grant WHERE id=$1 AND group_id=$2 FOR UPDATE',[id(input.id),g.id]);if(!old)missing();revision(old,input.expected_revision);await requireAccess(t,userId,'system_configuration','write',old);if(old.status!=='active')bad('已撤销授权不能复活，请另建');if(old.resource!==resource||old.subject_type!==(role?'role':'account')||!same(old.role_id,role?.id??null)||!same(old.account_id,account?.id??null))bad('已有授权的对象和功能不可搬移，请另建');
   row=await one(t,'UPDATE ty_auth_grant SET actions=$2,company_id=$3,department_ids=$4,person_ids=$5,fields_allow=$6,fields_deny=$7,valid_from=$8,valid_to=$9,reason=$10,revision=revision+1,updated_at=now()WHERE id=$1 RETURNING *',[old.id,actions,company,departments,people,allow,disallow,from,to,input.reason]);
  }else row=await one(t,'INSERT INTO ty_auth_grant(group_id,subject_type,account_id,role_id,resource,actions,company_id,department_ids,person_ids,fields_allow,fields_deny,valid_from,valid_to,reason,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)RETURNING *',[g.id,role?'role':'account',account?.id||null,role?.id||null,resource,actions,company,departments,people,allow,disallow,from,to,input.reason,userId]);
  let legacy=role?{id:role.legacy_role_id}:row.legacy_role_id?{id:row.legacy_role_id}:await createLegacyRole(t,`ty.auth.grant.${row.id}`,`完整授权${row.id}`);
  if(role)await syncRoleResource(t,role.id,legacy.id,resource);
  else{const safe=safeProjection(row);await t.query('INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write)VALUES($1,$2,$3,$4)ON CONFLICT(role_id,resource_code)DO UPDATE SET can_read=EXCLUDED.can_read,can_write=EXCLUDED.can_write',[legacy.id,resource,safe&&row.actions.includes('read'),safe&&row.actions.includes('write')]);}
  if(account){const projected=await membershipProjection(t,{account:account.id,group:g.id,company,legacyRole:legacy.id,source:`grant:${row.id}`,validFrom:from,validTo:to,previous:row.legacy_membership_id});await t.query('UPDATE ty_auth_grant SET legacy_role_id=$2,legacy_membership_id=$3,legacy_scope_id=$4 WHERE id=$1',[row.id,legacy.id,projected.legacy_membership_id,projected.legacy_scope_id]);Object.assign(row,{legacy_role_id:legacy.id,...projected});await markManaged(t,account.id,g.id,resource);}
  else for(const m of await q(t,"SELECT account_id FROM ty_auth_membership WHERE role_id=$1 AND status='active'",[role.id]))await markManaged(t,m.account_id,g.id,resource);
  await audit(t,userId,g.id,'grant.save','grant',row.id,{resource,actions,company_id:company,fields_allow:allow,fields_deny:disallow});return{grant:row};
 }});
}
export async function revokeGrant(t,{userId,input,operationId}){
 const r=await one(t,'SELECT * FROM ty_auth_grant WHERE id=$1',[id(input.id)]);if(!r)missing();await requireAccess(t,userId,'system_configuration','write',r);
 return command(t,{userId,groupId:r.group_id,operation:'grant.revoke',operationId,input,execute:async()=>{const locked=await one(t,'SELECT * FROM ty_auth_grant WHERE id=$1 FOR UPDATE',[r.id]);revision(locked,input.expected_revision);text(input.reason,'撤销原因',4);const row=await one(t,"UPDATE ty_auth_grant SET status='revoked',revision=revision+1 WHERE id=$1 RETURNING *",[r.id]);if(r.subject_type==='account'){await withdrawProjection(t,r.legacy_membership_id);await t.query('UPDATE sys_role SET is_active=false WHERE id=$1',[r.legacy_role_id]);await t.query('UPDATE ty_access_grant SET can_read=false,can_write=false WHERE platform_source_key=$1',[`grant:${r.id}`]);}else{const role=await roleFor(t,r.role_id,r.group_id);await syncRoleResource(t,role.id,role.legacy_role_id,r.resource);}await audit(t,userId,r.group_id,'grant.revoke','grant',r.id,{reason:input.reason,projection_withdrawal:r.subject_type==='account'?'platform_internal_self_marker':'resource_projection_recomputed',legacy_projection_id:r.legacy_membership_id,successor_created:false});return{grant:row};}});
}
export async function createOperator(t,{userId,input,operationId}){
 const g=await groupFor(t,userId,input.group_id);await requireAccess(t,userId,'system_configuration','write',{group_id:g.id});
 return command(t,{userId,groupId:g.id,operation:'operator.create',operationId,input,execute:async()=>{
  const login=text(input.login,'账号',2,64),name=text(input.display_name,'姓名',1,64);if(!/^[a-zA-Z0-9_.-]+$/.test(login))bad('账号仅使用字母数字和点横线下划线');
  const person=id(input.person_id,true),company=id(input.company_id,true);const p=person?await one(t,'SELECT legacy_person_id FROM ty_person WHERE id=$1 AND group_id=$2',[person,g.id]):null;if(person&&!p)bad('人员不属于集团');
  await t.query('LOCK TABLE sys_account IN SHARE ROW EXCLUSIVE MODE');
  // Historical explicit IDs may leave an identity sequence behind. Move only
  // forward under the table lock; never overwrite an existing account/password.
  await t.query("SELECT setval(pg_get_serial_sequence('sys_account','id'),greatest(coalesce((SELECT max(id)FROM sys_account),0)+1,nextval(pg_get_serial_sequence('sys_account','id'))),false)");
  const account=await one(t,'INSERT INTO sys_account(login,display_name,person_id)VALUES($1,$2,$3)RETURNING id,login,display_name,status',[login,name,p?.legacy_person_id||null]);
  const profile=input.profile_code||'hr_staff';if(!['config_admin','hr_staff','hr_manager','payroll','recruiter','trainer','store_manager','store_staff','group_hr_director','company_hr_director'].includes(profile))bad('业务身份类型未登记');
  await t.query('INSERT INTO ty_operator_binding(account_id,group_id,company_id,person_id,profile_code,created_by)VALUES($1,$2,$3,$4,$5,$6)',[account.id,g.id,company,person,profile,userId]);
  const password=process.env.TYHR_OPERATOR_INITIAL_PASSWORD||newSecret();await t.query('SELECT fn_credential_set($1,$2,true)',[account.id,hashPassword(password)]);
  await audit(t,userId,g.id,'operator.create','operator',account.id,{login,profile_code:profile});return{operator:{...account,group_id:g.id,profile_code:profile,revision:1},credential_once:password,credential_available:true};
 }});
}
export async function updateOperator(t,{userId,input,operationId}){
 const g=await groupFor(t,userId,input.group_id),old=await targetOperator(t,input.id,g.id);await requireAccess(t,userId,'system_configuration','write',{group_id:g.id});
 if(same(userId,old.id)&&input.status==='disabled')bad('请由另一配置人员停用当前账号');
 return command(t,{userId,groupId:g.id,operation:'operator.update',operationId,input,execute:async()=>{
  await t.query('SELECT id FROM sys_account WHERE id=$1 FOR UPDATE',[old.id]);let binding=await one(t,'SELECT * FROM ty_operator_binding WHERE account_id=$1 FOR UPDATE',[old.id]);
  if(!binding){revision({revision:1},input.expected_revision);binding=await one(t,'INSERT INTO ty_operator_binding(account_id,group_id,company_id,person_id,profile_code,created_by)VALUES($1,$2,$3,$4,$5,$6)RETURNING *',[old.id,g.id,old.company_id||null,old.person_id||null,old.profile_code,userId]);}else revision(binding,input.expected_revision);
  const state=input.status==='disabled'?'disabled':'active';await t.query('UPDATE sys_account SET display_name=$2,status=$3 WHERE id=$1',[old.id,text(input.display_name,'姓名',1,64),state]);
  if(binding)await t.query('UPDATE ty_operator_binding SET status=$2,revision=revision+1,updated_at=now()WHERE account_id=$1',[old.id,state]);
  if(state==='disabled')await t.query("UPDATE sys_session SET revoked_at=now(),revoked_by=$2,revoked_reason='操作人员已停用'WHERE user_id=$1 AND revoked_at IS NULL",[old.id,String(userId)]);
  await audit(t,userId,g.id,'operator.update','operator',old.id,{status:state});return{operator:await currentOperator(t,old.id)};
 }});
}
export async function resetPassword(t,{userId,input,operationId}){
 const g=await groupFor(t,userId,input.group_id),target=await targetOperator(t,input.id,g.id);await requireAccess(t,userId,'system_configuration','reset_password',{group_id:g.id});text(input.reason,'重置原因',4);
 if(same(userId,target.id))bad('本人改密请使用已登录的旧密码校验入口');
 return command(t,{userId,groupId:g.id,operation:'operator.reset_password',operationId,input,execute:async()=>{const password=process.env.TYHR_OPERATOR_INITIAL_PASSWORD||newSecret();await t.query('SELECT fn_credential_set($1,$2,true)',[target.id,hashPassword(password)]);await t.query("UPDATE sys_session SET revoked_at=now(),revoked_by=$2,revoked_reason='配置人员重置凭据'WHERE user_id=$1 AND revoked_at IS NULL",[target.id,String(userId)]);await audit(t,userId,g.id,'operator.reset_password','operator',target.id,{reason:input.reason});return{operator_id:target.id,credential_once:password,credential_available:true};}});
}
export async function simulate(t,{userId,input}){
 const g=await groupFor(t,userId,input.group_id);await requireAccess(t,userId,'system_configuration','simulate',{group_id:g.id});const target=await targetOperator(t,input.account_id,g.id);
 return authorization(t,{userId:target.id,resource:input.resource,action:input.action,groupId:g.id,companyId:input.company_id,departmentId:input.department_id,personId:input.person_id,fields:input.fields||[],at:input.as_of});
}
