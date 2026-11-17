import {createHash,randomBytes} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import {accessFor,companyDescendants} from './foundation.mjs';
import {personaFor} from './persona-guard.mjs';

export const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
export const one=async(t,s,a=[])=>(await q(t,s,a))[0];
export const same=(a,b)=>String(a)===String(b);
export const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
export const deny=(m='当前操作或数据不在授权范围')=>{throw bizErr('E_TY_FORBIDDEN',m);};
export const conflict=m=>{throw bizErr('E_TY_CONFLICT',m);};
export const missing=()=>{throw bizErr('E_TY_NOT_FOUND','记录不存在或不在当前授权范围');};
export function id(v,optional=false){if(optional&&(v===undefined||v===null||v===''))return null;const n=Number(v);if(!Number.isSafeInteger(n)||n<1)bad('请选择有效关联记录');return n;}
export function text(v,name='名称',min=1,max=2000){if(typeof v!=='string'||v.trim().length<min||v.length>max)bad(`${name}必填且长度有效`);return v.trim();}
export function obj(v,name='内容'){if(!v||typeof v!=='object'||Array.isArray(v))bad(`${name}须为对象`);return v;}
export function list(v,name='列表'){if(!Array.isArray(v)||v.length>1000)bad(`${name}须为不超过1000项的数组`);return v;}
export function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
export const hash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export function revision(row,expected){if(Number(expected)!==Number(row.revision))conflict('版本已变化，请刷新后重新核对');}
export const pageOf=i=>({page:Math.max(1,Math.min(100000,Number(i.page)||1)),page_size:Math.max(1,Math.min(100,Number(i.page_size??i.pageSize)||10))});
export function paging(rows,i){const p=pageOf(i),total=rows.length,pages=Math.max(1,Math.ceil(total/p.page_size));p.page=Math.min(p.page,pages);return{rows:rows.slice((p.page-1)*p.page_size,p.page*p.page_size),total,...p};}
export function search(rows,term,keys){const needle=String(term||'').normalize('NFKC').toLocaleLowerCase().trim();if(!needle)return rows;return rows.filter(r=>keys.some(k=>String(r[k]??'').normalize('NFKC').toLocaleLowerCase().includes(needle)));}
export async function groupFor(t,userId,requested){const a=await accessFor(t,userId);const g=requested?id(requested):a.persona?.group_id??a.grants[0]?.group_id;if(!g)bad('请先选择集团');if(!await one(t,'SELECT id FROM ty_group WHERE id=$1',[g]))missing();if(!a.group(g))deny();return{id:Number(g),access:a};}
export async function rowScope(t,userId,row,write=false){const a=await accessFor(t,userId);if(!row?.group_id)missing();let r=row;if(row.company_id){const c=await one(t,'SELECT id,group_id,ledger_id FROM ty_company WHERE id=$1',[row.company_id]);if(!c||!same(c.group_id,row.group_id))missing();r={...row,ledger_id:c.ledger_id};}if(a.platformAdmin&&a.persona?.profile_code!=='group_hr_director')return a;if(row.company_id?!a.row(r,write):!a.shared(row.group_id,write))deny();return a;}

// A matching complete grant supplies action, scope and fields together. Once
// an account/resource is managed here, revocation never falls back to legacy.
export function grantAllowsField(grant,key){if(grant.source==='built_in_baseline')return true;const matches=(pattern,k)=>pattern==='*'||pattern===k||k.startsWith(pattern+'.')||pattern.endsWith('.*')&&(k===pattern.slice(0,-2)||k.startsWith(pattern.slice(0,-1)));return!(grant.fields_deny||[]).some(x=>matches(x,key))&&(grant.fields_allow||[]).some(x=>matches(x,key));}
export async function authorization(t,{userId,resource,action='read',groupId,companyId,departmentId,personId,fields=[],at=null}){
 const a=await accessFor(t,userId),p=a.persona;const group=id(groupId);const account=await one(t,"SELECT id FROM sys_account a WHERE id=$1 AND status='active'AND NOT EXISTS(SELECT 1 FROM ty_operator_binding b WHERE b.account_id=a.id AND b.status<>'active')",[userId]);if(!account)return{allowed:false,denied_reasons:['操作人员已停用'],field_visibility:{}};
 const configResources=new Set(['system_configuration','workflow_manage','integration_manage','advanced_leave_config','ledger','payroll_config','hr_configuration','perf_config','learning_config']);
 if(p?.profile_code==='config_admin'&&!configResources.has(resource))return{allowed:false,denied_reasons:['配置岗位没有业务数据权限'],field_visibility:{}};
 if(p?.profile_code==='boss'&&!['read','export'].includes(action))return{allowed:false,denied_reasons:['当前岗位为只读'],field_visibility:{}};
 const selfResource=['advanced_leave_self','workflow_self','people_dorm_self','people_cert_self','people_goods_self','attendance_self','payroll_self','hr_self','perf_self','learning_self','outsource_self'].includes(resource);
 const selfBound=selfResource&&p?.person_id&&same(p.group_id,group)&&same(p.person_id,personId);
 if(!a.group(group)&&!selfBound)return{allowed:false,denied_reasons:['集团范围不符'],field_visibility:{}};
 if(companyId&&!await one(t,'SELECT 1 FROM ty_company WHERE id=$1 AND group_id=$2',[id(companyId),group])||personId&&!await one(t,'SELECT 1 FROM ty_person WHERE id=$1 AND group_id=$2',[id(personId),group])||departmentId&&!await one(t,'SELECT 1 FROM ty_department d JOIN ty_company c ON c.id=d.company_id WHERE d.id=$1 AND c.group_id=$2',[id(departmentId),group]))return{allowed:false,denied_reasons:['目标记录不属于当前集团'],field_visibility:{}};
 const now=at?new Date(at):new Date();if(!Number.isFinite(+now))bad('模拟时点无效');
 const rows=await q(t,`SELECT g.*,m.company_id member_company_id FROM ty_auth_grant g
 LEFT JOIN ty_auth_membership m ON g.subject_type='role' AND m.role_id=g.role_id AND m.group_id=g.group_id AND m.account_id=$1
 AND m.status='active' AND m.valid_from<=$4 AND(m.valid_to IS NULL OR $4<m.valid_to)
 LEFT JOIN ty_auth_role r ON r.id=g.role_id
 WHERE g.group_id=$2 AND g.resource=$3 AND g.status='active' AND g.valid_from<=$4 AND(g.valid_to IS NULL OR $4<g.valid_to)
 AND((g.subject_type='account'AND g.account_id=$1)OR(g.subject_type='role'AND m.id IS NOT NULL AND r.status='active'))`,[userId,group,resource,now]);
 const managed=!!await one(t,'SELECT 1 FROM ty_auth_managed WHERE account_id=$1 AND group_id=$2 AND resource=$3',[userId,group,resource]);
 const hasNative=!!(await one(t,`SELECT EXISTS(SELECT 1 FROM ty_auth_managed WHERE account_id=$1)OR EXISTS(SELECT 1 FROM ty_access_grant WHERE account_id=$1 AND platform_source_key IS NOT NULL)ok`,[userId])).ok;
 const complete=[];
 for(const g of rows){
  const actions=g.actions||[];const writes=['write','create','update','delete','submit','cancel'];
  if(!actions.includes(action)&&!actions.includes('manage')&&!(actions.includes('write')&&writes.includes(action)))continue;
  if(g.company_id&&(!companyId||!(await companyDescendants(t,g.company_id)).includes(String(companyId))))continue;
  if(g.member_company_id&&(!companyId||!(await companyDescendants(t,g.member_company_id)).includes(String(companyId))))continue;
  if(g.department_ids?.length&&(!departmentId||!g.department_ids.some(x=>same(x,departmentId))))continue;
  if(g.person_ids?.length&&(!personId||!g.person_ids.some(x=>same(x,personId))))continue;
  const visible=f=>!g.fields_deny.includes(f)&&(g.fields_allow.includes('*')||g.fields_allow.includes(f));
  if(fields.length&&!fields.every(visible))continue;
  complete.push({...g,field_visibility:Object.fromEntries(fields.map(f=>[f,visible(f)]))});
 }
 if(complete.length)return{allowed:true,allowing_grants:complete.map(g=>({id:g.id,resource:g.resource,actions:g.actions,company_id:g.company_id,fields_allow:g.fields_allow,fields_deny:g.fields_deny})),field_visibility:Object.fromEntries(fields.map(f=>[f,true])),denied_reasons:[]};
 if(rows.length||managed)return{allowed:false,allowing_grants:[],field_visibility:Object.fromEntries(fields.map(f=>[f,false])),denied_reasons:['没有一条完整授权同时满足动作、范围和字段']};
 // Preserve the verified built-in baseline until explicitly managed. No new
 // company or function permission is inferred from membership labels alone.
 const verb=['read','export'].includes(action)?'read':'write';
 let functional=!!(await one(t,'SELECT fn_role_can($1,$2,$3) ok',[userId,resource,verb]))?.ok;
 if(hasNative)functional=!!(await one(t,`SELECT EXISTS(SELECT 1 FROM fn_effective_roles($1,app_today())e JOIN sys_role r ON r.id=e.role_id
 LEFT JOIN sys_role_resource p ON p.role_id=r.id AND p.resource_code=$2
 WHERE r.is_active AND(r.is_super OR CASE WHEN $3='write'THEN p.can_write ELSE p.can_read END)
 AND NOT EXISTS(SELECT 1 FROM ty_auth_role x WHERE x.legacy_role_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM ty_auth_grant x WHERE x.legacy_role_id=r.id))ok`,[userId,resource,verb]))?.ok;
 let scoped=false;
 if(hasNative){
  const baseGrants=a.grants.filter(x=>!x.platform_source_key&&same(x.group_id,group)&& (verb!=='write'||x.can_write));
  const originalAdmin=a.platformAdmin&&functional&&['config_admin','demo'].includes(p?.profile_code);
  if(!companyId)scoped=originalAdmin||baseGrants.some(x=>!x.company_id&&!x.ledger_id);
  else{const c=await one(t,'SELECT id,ledger_id FROM ty_company WHERE id=$1 AND group_id=$2',[companyId,group]);if(c){for(const x of baseGrants){if(x.company_id&&!(await companyDescendants(t,x.company_id)).includes(String(companyId)))continue;if(x.ledger_id&&!same(x.ledger_id,c.ledger_id))continue;scoped=true;break;}scoped||=originalAdmin;}}
 }
 else
 if(companyId){const c=await one(t,'SELECT id company_id,group_id,ledger_id FROM ty_company WHERE id=$1',[companyId]);scoped=!!c&&same(c.group_id,group)&&a.row(c,verb==='write');}
 else scoped=a.shared(group,verb==='write')||(configResources.has(resource)&&a.platformAdmin);
 if(selfBound)scoped||=!companyId||!!await one(t,"SELECT 1 FROM ty_employment WHERE person_id=$1 AND company_id=$2 AND group_id=$3 AND status<>'cancelled'",[personId,companyId,group]);
 return{allowed:functional&&scoped,allowing_grants:functional&&scoped?[{id:null,source:'built_in_baseline',resource,actions:[action]}]:[],field_visibility:Object.fromEntries(fields.map(f=>[f,functional&&scoped])),denied_reasons:functional&&scoped?[]:['当前功能或数据范围不足']};
}
export async function requireAccess(t,userId,resource,action,scope={}){const group=scope.group_id??scope.groupId;const d=await authorization(t,{userId,resource,action,groupId:group,companyId:scope.company_id??scope.companyId,personId:scope.person_id??scope.personId,departmentId:scope.department_id??scope.departmentId,fields:scope.fields||[]});if(!d.allowed)deny(d.denied_reasons[0]);return d;}
export async function audit(t,userId,group,action,kind,entity,metadata={}){await t.query('INSERT INTO ty_platform_audit(group_id,actor_id,action,entity_type,entity_id,metadata)VALUES($1,$2,$3,$4,$5,$6::jsonb)',[group,userId,action,kind,entity||null,JSON.stringify(metadata)]);}
export async function emit(t,group,key,type,payload){await t.query('INSERT INTO ty_platform_outbox(group_id,event_key,event_type,payload)VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[group,key,type,JSON.stringify(payload)]);}
export async function command(t,{userId,groupId,operation,operationId,input,execute,project=null}){
 text(operationId,'操作编号',8,160);await t.query('SELECT id FROM sys_account WHERE id=$1 FOR UPDATE',[userId]);
 const old=await one(t,'SELECT * FROM ty_platform_command WHERE actor_id=$1 AND operation=$2 AND operation_key=$3',[userId,operation,operationId]);
 if(old){if(!same(old.group_id,groupId)||old.input_hash!==hash(input))conflict('同一操作编号内容已变化');const result={...old.result,replayed:true};return project?project(result):result;}
 const out=await execute();const safe={...out};delete safe.credential_once;safe.credential_available=false;
 await t.query('INSERT INTO ty_platform_command(actor_id,operation,operation_key,group_id,input_hash,result)VALUES($1,$2,$3,$4,$5,$6::jsonb)',[userId,operation,operationId,groupId,hash(input),JSON.stringify(safe)]);
 return project?project(out):out;
}
export async function currentOperator(t,userId){return one(t,`SELECT a.id,a.login,a.display_name,CASE WHEN a.status<>'active' THEN a.status WHEN b.account_id IS NOT NULL AND b.status<>'active' THEN 'disabled' ELSE a.status END status,coalesce(b.revision,1)revision,CASE WHEN b.account_id IS NOT NULL THEN b.profile_code ELSE p.profile_code END profile_code,
 CASE WHEN b.account_id IS NOT NULL THEN b.group_id ELSE p.group_id END group_id,CASE WHEN b.account_id IS NOT NULL THEN b.person_id ELSE p.person_id END person_id,CASE WHEN b.account_id IS NOT NULL THEN b.company_id ELSE p.company_id END company_id
 FROM sys_account a LEFT JOIN ty_operator_binding b ON b.account_id=a.id LEFT JOIN ty_test_account_profile p ON p.account_id=a.id WHERE a.id=$1`,[userId]);}
export async function visibleOperators(t,userId,group,{options=false,companyId=null}={}){
 const a=await accessFor(t,userId);const companies=companyId?await companyDescendants(t,companyId):null;
 const rows=await q(t,`SELECT a.id,a.login,a.display_name,a.status,CASE WHEN b.account_id IS NOT NULL THEN b.profile_code ELSE p.profile_code END profile_code,
 CASE WHEN b.account_id IS NOT NULL THEN b.group_id ELSE p.group_id END group_id,CASE WHEN b.account_id IS NOT NULL THEN b.company_id ELSE p.company_id END company_id,c.name company_name,
 COALESCE(b.revision,1)revision FROM sys_account a LEFT JOIN ty_operator_binding b ON b.account_id=a.id
 LEFT JOIN ty_test_account_profile p ON p.account_id=a.id LEFT JOIN ty_company c ON c.id=CASE WHEN b.account_id IS NOT NULL THEN b.company_id ELSE p.company_id END
 WHERE CASE WHEN b.account_id IS NOT NULL THEN b.group_id ELSE p.group_id END=$1 ORDER BY a.display_name,a.id`,[group]);
 const allowed=[];for(const r of rows){if(companies&&r.company_id&&!companies.includes(String(r.company_id)))continue;if(r.company_id){const c=await one(t,'SELECT ledger_id FROM ty_company WHERE id=$1',[r.company_id]);if(!a.row({...r,ledger_id:c?.ledger_id}))continue;}else if(!a.shared(group)&&!options)continue;
 if(options){const approvalEligible=!['config_admin','vendor_contact','outsource_hr','outsourced_staff'].includes(r.profile_code);if(r.status!=='active'||r.profile_code==='config_admin'||options!=='notifications'&&!approvalEligible)continue;allowed.push({id:r.id,display_name:r.display_name,company_name:r.company_name,role_labels:[r.profile_code],eligible_for_approval:approvalEligible,eligible_for_notification:true});}else allowed.push(r);}
 return allowed;
}
export const newSecret=()=>randomBytes(18).toString('base64url');
