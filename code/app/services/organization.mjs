import {randomBytes} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import * as foundation from './foundation.mjs';
import {hashPassword} from './auth.mjs';
const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
const same=(a,b)=>String(a)===String(b);
export const RESOURCES=['headcount'];
async function scope(t,userId,write=false){const a=await foundation.accessFor(t,userId);if(!(await q(t,'SELECT fn_role_can($1,\'headcount\',$2) ok',[userId,write?'write':'read']))[0].ok)throw bizErr('E_TY_FORBIDDEN','缺少组织编制权限');return a;}
export async function plans(t,{userId,groupId,period='2026-11',asOf}){
 const a=await scope(t,userId);if(!a.group(groupId))throw bizErr('E_TY_FORBIDDEN','集团不在授权范围');
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))throw bizErr('E_TY_ARGUMENT','请选择有效编制月份');
 const date=asOf||period+'-01';
 const data=await foundation.bootstrap(t,{userId,groupId});
 const all=(await q(t,`SELECT h.*,c.name company_name,c.parent_company_id,c.org_level,d.name department_name,p.name position_name FROM ty_headcount_plan h JOIN ty_company c ON c.id=h.company_id LEFT JOIN ty_department d ON d.id=h.department_id LEFT JOIN ty_company_position p ON p.id=h.position_id WHERE h.group_id=$1 AND h.period=$2::date ORDER BY CASE c.org_level WHEN 'group' THEN 0 WHEN 'brand' THEN 1 ELSE 2 END,c.id,h.department_id NULLS FIRST,h.position_id NULLS FIRST`,[groupId,period+'-01'])).filter(r=>a.row({...r,ledger_id:data.companies.find(c=>same(c.id,r.company_id))?.ledger_id}));
 const active=await q(t,`SELECT a.*,e.person_id,e.employment_type FROM ty_position_assignment a JOIN ty_employment e ON e.id=a.employment_id WHERE a.group_id=$1 AND a.status<>'cancelled' AND e.status<>'cancelled' AND a.is_primary AND a.valid_from<=$2::date AND (a.valid_to IS NULL OR $2::date<a.valid_to) AND e.hire_date<=$2::date AND(e.leave_date IS NULL OR $2::date<=e.leave_date)`,[groupId,date]);
 const descendants=id=>{const ids=[String(id)];for(let i=0;i<ids.length;i++)for(const c of data.companies)if(same(c.parent_company_id,ids[i])&&!ids.includes(String(c.id)))ids.push(String(c.id));return ids;};
 const deptDesc=id=>{const ids=[String(id)];for(let i=0;i<ids.length;i++)for(const d of data.departments)if(same(d.parent_department_id,ids[i])&&!ids.includes(String(d.id)))ids.push(String(d.id));return ids;};
 return {period,as_of:date,can_create:(await q(t,"SELECT fn_role_can($1,'headcount','write') ok",[userId]))[0].ok,rows:all.map(r=>{const ids=descendants(r.company_id),ds=r.department_id?deptDesc(r.department_id):[];const visible=active.filter(x=>ids.includes(String(x.company_id))&&(!r.department_id||ds.includes(String(x.department_id)))&&(!r.position_id||same(x.position_id,r.position_id)));const occupied=new Set(visible.map(x=>String(x.person_id))).size;const outsourced=new Set(visible.filter(x=>x.employment_type==='outsourced').map(x=>String(x.person_id))).size;const direct=new Set(visible.filter(x=>x.employment_type!=='outsourced').map(x=>String(x.person_id))).size;return {...r,occupied,direct_people:direct,outsourced_people:outsourced,vacancies:Math.max(0,r.quota-occupied),overstaffed:Math.max(0,occupied-r.quota),can_write:a.row({...r,ledger_id:data.companies.find(c=>same(c.id,r.company_id))?.ledger_id},true)};}),notice:'组织汇总按不同人员去重；岗位只统计有效主任职，跨公司雇佣可分别占用本公司岗位。'};
}
export async function savePlan(t,{userId,input}){
 const a=await scope(t,userId,true);const c=(await q(t,'SELECT * FROM ty_company WHERE id=$1',[input.company_id]))[0];if(!c||!a.row({...c,company_id:c.id},true))throw bizErr('E_TY_FORBIDDEN','不能修改此公司编制');
 if(!Number.isInteger(Number(input.quota))||Number(input.quota)<0||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period))throw bizErr('E_TY_ARGUMENT','编制为非负整数，月份须有效');
 if(typeof input.reason!=='string'||input.reason.trim().length<4)throw bizErr('E_TY_ARGUMENT','请填写至少四字的核定依据');
 const args=[c.group_id,c.id,input.department_id||null,input.position_id||null,input.period+'-01',Number(input.quota),input.reason.trim(),userId];
 const old=(await q(t,'SELECT id FROM ty_headcount_plan WHERE company_id=$1 AND position_id IS NOT DISTINCT FROM $3::bigint AND ($3::bigint IS NOT NULL OR department_id IS NOT DISTINCT FROM $2::bigint) AND period=$4::date FOR UPDATE',[c.id,args[2],args[3],args[4]]))[0];
 const row=old?(await q(t,'UPDATE ty_headcount_plan SET quota=$1,reason=$2,updated_by=$3,updated_at=clock_timestamp(),department_id=$5 WHERE id=$4 RETURNING *',[args[5],args[6],args[7],old.id,args[2]]))[0]:(await q(t,'INSERT INTO ty_headcount_plan(group_id,company_id,department_id,position_id,period,quota,reason,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',args))[0];
 await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'set_headcount','headcount',$2,$3::jsonb)",[userId,row.id,JSON.stringify(row)]);return {row};
}
export async function upgradeDemo(t,{userId,passwordFactory=()=>randomBytes(12).toString('base64url')}){
 const a=await foundation.accessFor(t,userId);if(!a.admin)throw bizErr('E_TY_FORBIDDEN','需要配置权限');
 const g=(await q(t,"SELECT * FROM ty_group WHERE code='TY-TEST' FOR UPDATE"))[0];if(!g)throw bizErr('E_TY_ARGUMENT','请先建立虚构工作区');
 const add=async(collection,input)=>(await foundation.save(t,{userId,collection,input})).row;
 const hq=(await q(t,"SELECT * FROM ty_company WHERE group_id=$1 AND code='SYN-HQ'",[g.id]))[0];
 if(!(await q(t,"SELECT id FROM ty_department WHERE company_id=$1 AND code='HR'",[hq.id])).length)await add('departments',{company_id:hq.id,code:'HR',name:'\u4eba\u529b\u8d44\u6e90\u90e8'});
 await t.query("UPDATE ty_company SET org_level='group' WHERE id=$1",[hq.id]);
 await t.query("UPDATE ty_ledger SET name='天意集团总帐' WHERE id=$1",[hq.ledger_id]);
 const brands=await q(t,'SELECT * FROM ty_brand WHERE group_id=$1 ORDER BY id',[g.id]);const brandCompanies=[];
 for(const b of brands){const ledger=(await q(t,"SELECT * FROM ty_ledger WHERE brand_id=$1 AND scope_mode='brand' ORDER BY id LIMIT 1",[b.id]))[0];await t.query('UPDATE ty_ledger SET parent_ledger_id=$2 WHERE id=$1',[ledger.id,hq.ledger_id]);
  let co=(await q(t,'SELECT * FROM ty_company WHERE group_id=$1 AND code=$2',[g.id,'ORG-BRAND-'+b.id]))[0];
  if(!co)co=await add('companies',{group_id:g.id,ledger_id:ledger.id,brand_id:b.id,code:'ORG-BRAND-'+b.id,name:b.name+'品牌公司',company_kind:'headquarters',org_level:'brand',parent_company_id:hq.id});
  brandCompanies.push(co);await t.query("UPDATE ty_company SET org_level='store',parent_company_id=$2 WHERE group_id=$1 AND brand_id=$3 AND company_kind='store'",[g.id,co.id,b.id]);
  for(const [code,name] of [['HR','人力资源部'],['OPS','品牌营运部']])if(!(await q(t,'SELECT id FROM ty_department WHERE company_id=$1 AND code=$2',[co.id,code])).length)await add('departments',{company_id:co.id,code,name});
 }
 const nodes=[hq,...brandCompanies,...await q(t,"SELECT * FROM ty_company WHERE group_id=$1 AND org_level='store' ORDER BY id",[g.id])];
 for(const [code,name] of [['HR-DIRECTOR','HR总监'],['HR-MANAGER','HR主管'],['RECRUITER','招聘专员'],['PAYROLL','薪酬专员'],['TRAINER','培训专员'],['HR-STAFF','人事专员']])if(!(await q(t,'SELECT id FROM ty_job WHERE group_id=$1 AND code=$2',[g.id,code])).length)await add('jobs',{group_id:g.id,code,name,job_family:'人力资源'});
 const jobs=await q(t,'SELECT * FROM ty_job WHERE group_id=$1 ORDER BY id',[g.id]);
 // Standard jobs inherit through corresponding group and brand company positions.
 for(const c of [hq,...brandCompanies]){const deps=await q(t,'SELECT * FROM ty_department WHERE company_id=$1 ORDER BY id',[c.id]);for(const j of jobs){const dept=(j.job_family==='\u4eba\u529b\u8d44\u6e90'?deps.find(d=>d.code==='HR'):deps.find(d=>d.code!=='HR'))||deps[0];const existing=(await q(t,'SELECT * FROM ty_company_position WHERE company_id=$1 AND job_id=$2',[c.id,j.id]))[0];if(!existing)await add('positions',{group_id:g.id,company_id:c.id,department_id:dept.id,job_id:j.id,code:'ORG-'+j.code,name:j.name});else if(!same(existing.department_id,dept.id))await addPositionDepartment(t,existing.id,dept.id);}}
 for(const c of nodes.filter(c=>c.id!==hq.id)){const parent=brandCompanies.some(b=>same(b.id,c.id))?hq:brandCompanies.find(b=>same(b.brand_id,c.brand_id));if(parent)await t.query('UPDATE ty_company_position p SET parent_position_id=(SELECT id FROM ty_company_position root WHERE root.company_id=$2 AND root.job_id=p.job_id ORDER BY id LIMIT 1) WHERE p.company_id=$1',[c.id,parent.id]);}
 // One permanent person has historical cross-brand rehire plus a second current store employment.
 const person=(await q(t,'SELECT * FROM ty_person WHERE group_id=$1 ORDER BY id LIMIT 1',[g.id]))[0];
 const cnStore=nodes.find(c=>c.org_level==='store'&&same(c.brand_id,brands[0].id));
 if(!(await q(t,"SELECT id FROM ty_employment WHERE person_id=$1 AND company_id=$2 AND hire_date='2026-11-16'",[person.id,cnStore.id])).length){const e=await add('employments',{group_id:g.id,person_id:person.id,company_id:cnStore.id,employment_type:'PT',hire_date:'2026-11-16',legal_subject_name:'全虚构跨品牌兼职主体'});const pos=(await q(t,'SELECT * FROM ty_company_position WHERE company_id=$1 ORDER BY id LIMIT 1',[cnStore.id]))[0];await add('assignments',{group_id:g.id,company_id:cnStore.id,employment_id:e.id,department_id:pos.department_id,position_id:pos.id,is_primary:true,valid_from:'2026-11-16'});}
 // Budgets, ordered top down; approved results and payroll remain untouched.
 for(const c of nodes){await savePlan(t,{userId,input:{company_id:c.id,period:'2026-11',quota:same(c.id,hq.id)?300:c.org_level==='brand'?120:8,reason:'全虚构组织编制演示'}});const deps=await q(t,'SELECT * FROM ty_department WHERE company_id=$1 ORDER BY id',[c.id]);for(const d of deps){const positions=await q(t,'SELECT * FROM ty_company_position WHERE department_id=$1 ORDER BY id',[d.id]);await savePlan(t,{userId,input:{company_id:c.id,department_id:d.id,period:'2026-11',quota:c.org_level==='brand'?(d.code==='HR'?24:8):same(c.id,hq.id)?24:4,reason:'全虚构部门编制核定'}});for(const p of positions)await savePlan(t,{userId,input:{company_id:c.id,department_id:d.id,position_id:p.id,period:'2026-11',quota:2,reason:'全虚构岗位编制核定'}});}}
 const existing=await q(t,'SELECT a.*,p.profile_code FROM ty_test_account_profile p JOIN sys_account a ON a.id=p.account_id WHERE p.group_id=$1',[g.id]);
 const createdAccounts=[];
 const accountSpecs=[{login:'group_hr_director',name:'天意集团HR总监',profile:'group_hr_director',company:null},...brandCompanies.map((c,i)=>({login:i?'hk_hr_director':'company_hr_director',name:c.name+'HR总监',profile:'company_hr_director',company:c})),{login:'store_hr_director',name:'香香鱼米01店HR总监',profile:'company_hr_director',company:cnStore}];
 for(const spec of accountSpecs){if(existing.some(e=>e.login===spec.login))continue;if((await q(t,'SELECT id FROM sys_account WHERE login=$1',[spec.login])).length)throw bizErr('E_TY_CONFLICT','总监登录名已存在，不能接管');const role=(await q(t,'SELECT id FROM sys_role WHERE code=$1',['ty_'+spec.profile]))[0];const acc=(await q(t,'INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE SELECT greatest(1001,coalesce(max(id),0)+1),$1,$2 FROM sys_account RETURNING *',[spec.login,spec.name]))[0];const password=passwordFactory(spec);await t.query('SELECT fn_credential_set($1,$2,false)',[acc.id,hashPassword(password)]);createdAccounts.push({account_id:acc.id,login:spec.login,password});
  await t.query('INSERT INTO ty_test_account_profile(account_id,group_id,company_id,profile_code,seed_version)VALUES($1,$2,$3,$4,\'TY-ORG-v4\')',[acc.id,g.id,spec.company?.id||null,spec.profile]);
  const allowed=spec.company?nodes.filter(c=>same(c.id,spec.company.id)||same(c.parent_company_id,spec.company.id)):nodes;
  for(const c of allowed)await t.query("INSERT INTO ty_access_grant(account_id,group_id,ledger_id,company_id,can_read,can_write,valid_from)VALUES($1,$2,$3,$4,true,true,'2026-01-01')",[acc.id,g.id,c.ledger_id,c.id]);
  if(!spec.company)await t.query("INSERT INTO ty_access_grant(account_id,group_id,can_read,can_write,valid_from)VALUES($1,$2,true,true,'2026-01-01')",[acc.id,g.id]);
  const bindings=await q(t,'SELECT * FROM ty_legacy_company_binding WHERE company_id=ANY($1::bigint[])',[allowed.map(c=>c.id)]);const sid=(await q(t,"INSERT INTO sys_data_scope(id,name,combinator)SELECT max(id)+1,$1,'intersection' FROM sys_data_scope RETURNING id",[spec.name+'范围']))[0].id;
  for(const [dim,col] of [['cost_org','legacy_org_id'],['attendance_org','legacy_org_id'],['payroll_legal_entity','payroll_legal_entity_id'],['si_entity','si_legal_entity_id']])await t.query("INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids)VALUES($1,$2,'nodes',$3::bigint[])",[sid,dim,[...new Set(bindings.map(b=>b[col]))]]);
  await t.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)VALUES($1,$2,$3,'2026-01-01','ROLE','用户要求三层组织总监虚构演示')",[acc.id,role.id,sid]);
 }
 await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'three_level_upgrade','group',$2,$3::jsonb)",[userId,g.id,JSON.stringify({companies:nodes.length,brand_companies:2,cross_brand_person_id:person.id})]);
 return {group_id:g.id,companies:nodes.length,brand_companies:2,cross_brand_person_id:person.id,director_logins:accountSpecs.map(s=>s.login),created_accounts:createdAccounts};
}

async function addPositionDepartment(t,id,departmentId){const old=(await q(t,'SELECT * FROM ty_company_position WHERE id=$1',[id]))[0],used=(await q(t,'SELECT EXISTS(SELECT 1 FROM ty_position_assignment WHERE position_id=$1)used',[id]))[0].used;if(used){await t.query('INSERT INTO ty_company_position(group_id,company_id,department_id,job_id,grade_id,code,name,parent_position_id)VALUES($1,$2,$3,$4,$5,$6,$7,$8)ON CONFLICT(company_id,code)DO NOTHING',[old.group_id,old.company_id,departmentId,old.job_id,old.grade_id,old.code+'-DEPT-'+departmentId,old.name,old.parent_position_id]);}else await t.query('UPDATE ty_company_position SET department_id=$2 WHERE id=$1',[id,departmentId]);}
