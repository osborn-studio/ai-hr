import{q,one,bad,deny,same,groupFor,authorization,currentOperator}from'./platform-core.mjs';
import * as foundation from './foundation.mjs';

export async function isManagedAccount(t,userId){if(!(await one(t,"SELECT to_regclass('public.ty_auth_managed') IS NOT NULL ok"))?.ok)return false;return!!(await one(t,`SELECT EXISTS(SELECT 1 FROM ty_auth_managed WHERE account_id=$1)OR EXISTS(SELECT 1 FROM ty_access_grant WHERE account_id=$1 AND platform_source_key IS NOT NULL)ok`,[userId])).ok;}
export async function guardCoarseAdapter(t,userId){if(await isManagedAccount(t,userId))deny('此业务查询正在接入完整授权；当前账号请使用支持完整授权的业务页面');}
export async function bootstrap(t,{userId,groupId,ledgerId,companyId}){
 if(!await isManagedAccount(t,userId))return foundation.bootstrap(t,{userId,groupId,ledgerId,companyId});
 const g=await groupFor(t,userId,groupId),operator=await currentOperator(t,userId),group=g.id;
 const companies=(await q(t,'SELECT id,group_id,ledger_id,brand_id,code,name,company_kind,org_level,parent_company_id,status FROM ty_company WHERE group_id=$1 AND status=\'active\'ORDER BY id',[group])).filter(c=>g.access.row({...c,company_id:c.id})&&(!companyId||same(c.id,companyId)||same(c.parent_company_id,companyId))&&(!ledgerId||same(c.ledger_id,ledgerId)));
 const ids=companies.map(c=>c.id),brands=await q(t,'SELECT id,group_id,code,name,region_code,currency_code,status FROM ty_brand WHERE group_id=$1 AND id=ANY($2::bigint[])',[group,[...new Set(companies.map(c=>c.brand_id).filter(Boolean))]]);
 const ledgers=await q(t,'SELECT id,group_id,brand_id,scope_mode,code,name,region_code,currency_code,parent_ledger_id,status FROM ty_ledger WHERE group_id=$1 AND id=ANY($2::bigint[])',[group,[...new Set(companies.map(c=>c.ledger_id))]]);
 const departments=await q(t,'SELECT id,company_id,parent_department_id,code,name,status FROM ty_department WHERE company_id=ANY($1::bigint[])',[ids]);
 // These are directory labels for authorized pickers. No employment, contact,
 // salary, identity document, account list or history is smuggled via bootstrap.
 const people=[];for(const p of await q(t,'SELECT id,person_number,full_name,status FROM ty_person WHERE group_id=$1 ORDER BY person_number',[group])){
  const employments=await q(t,"SELECT company_id FROM ty_employment WHERE person_id=$1 AND company_id=ANY($2::bigint[])AND status<>'cancelled'",[p.id,ids]);
  for(const company of [operator.company_id,...employments.map(e=>e.company_id)].filter(Boolean)){
   const allowed=await authorization(t,{userId,resource:'employee_roster',action:'read',groupId:group,companyId:company,personId:p.id,fields:['full_name','person_number']});
   const config=await authorization(t,{userId,resource:'system_configuration',action:'read',groupId:group,companyId:company});
   if(allowed.allowed||config.allowed){people.push(p);break;}
  }
 }
 const groups=await q(t,'SELECT id,code,name,status FROM ty_group WHERE id=$1',[group]);
 return{groups,brands,ledgers,companies,departments,work_areas:[],jobs:[],grades:[],positions:[],people,employments:[],assignments:[],grants:[],accounts:[],external_identities:[],context:{group_id:group,ledger_id:ledgerId||null,company_id:companyId||null},capabilities:{can_write:false,can_manage_access:false,can_create_group:false,can_write_shared:false,directory_only:true},counts:{groups:1,ledgers:ledgers.length,companies:companies.length,people:people.length,employments:0},legacy:{available:false}};
}
