// Opt-in, local test personas for the independent fictional TY-TEST workspace.
// Passwords are returned once to the local initializer; hashes alone enter SQL.
import {randomBytes} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import {hashPassword} from './auth.mjs';
import * as foundation from './foundation.mjs';

export const RESOURCES=['ledger'];
export const VERSION='TY-ACCOUNTS-v1';
const summaries={group_hr_director:'本集团全部HR、组织编制和跨品牌雇佣历史；不能访问其他集团',company_hr_director:'授权公司及下属门店的HR业务、组织岗位和编制；不读取其他品牌历史',config_admin:'系统参数、组织基础、角色授权与制度；不办理工资或绩效',demo:'全部功能与授权范围',boss:'集团经营、人事与薪酬只读；不能修改业务或授权',hr_manager:'集团人事、招聘、薪酬、绩效和培训；无系统授权配置',recruiter:'招聘需求与招聘流程；人员只读，不算薪',payroll:'工资、薪酬规则和考勤；人员只读，不办理雇佣',trainer:'培训课程、场次及考试；人员只读，不算薪',hr_staff:'基础人事、入离调转；不算薪或修改系统授权',store_manager:'本店人员、考勤排班与请假；只能查看本人薪资',store_staff:'本人资料、请假、考勤与培训；不能看他人工资',station_staff:'本人资料、档口任职、请假、考勤与培训；不能看他人工资'};
const q=async(tx,sql,args=[]) => (await tx.query(sql,args)).rows;
const same=(a,b)=>String(a)===String(b);
const fail=m=>{throw bizErr('E_TY_CONFLICT',m);};
const roleSpecs=[
 {login:'admin',display_name:'系统配置管理员（虚构）',profile_code:'config_admin',role:'ty_demo_config',role_name:'系统配置管理员',scope:'none',write:true},
 {login:'demo',display_name:'全权限演示账号（虚构）',profile_code:'demo',role:'admin',role_name:'全部权限演示',scope:'group',write:true},
 {login:'boss',display_name:'集团老板（虚构）',profile_code:'boss',role:'boss',role_name:'老板·集团只读',scope:'group',write:false},
 {login:'hr_manager',display_name:'HR主管（虚构职能账号）',profile_code:'hr_manager',role:'ty_demo_hr_manager',role_name:'HR主管',scope:'group',write:true},
 {login:'recruiter',display_name:'招聘专员（虚构职能账号）',profile_code:'recruiter',role:'ty_demo_recruiter',role_name:'招聘专员',scope:'group',write:false},
 {login:'payroll',display_name:'薪酬专员（虚构职能账号）',profile_code:'payroll',role:'ty_demo_payroll',role_name:'薪酬专员',scope:'group',write:true},
 {login:'trainer',display_name:'培训专员（虚构职能账号）',profile_code:'trainer',role:'ty_demo_trainer',role_name:'培训专员',scope:'group',write:false},
 {login:'hr_staff',display_name:'普通HR（虚构职能账号）',profile_code:'hr_staff',role:'ty_demo_hr_staff',role_name:'普通HR人员',scope:'group',write:true},
];

async function newScope(tx,name,bindings,mode) {
 const sid=(await q(tx,"INSERT INTO sys_data_scope(id,name,combinator) SELECT coalesce(max(id),0)+1,$1,'intersection' FROM sys_data_scope RETURNING id",[name]))[0].id;
 const values={cost_org:bindings.map(b=>b.legacy_org_id),attendance_org:bindings.map(b=>b.legacy_org_id),
  payroll_legal_entity:bindings.map(b=>b.payroll_legal_entity_id),si_entity:bindings.map(b=>b.si_legal_entity_id)};
 for(const [dim,ids] of Object.entries(values))await tx.query('INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids) VALUES($1,$2,$3,$4::bigint[])',
  [sid,dim,mode==='none'?'none':'nodes',mode==='none'?[]:[...new Set(ids.map(String))]]);
 return sid;
}

async function metadata(tx,groupId) {
 const rows=await q(tx,`SELECT a.id AS account_id,a.login,a.display_name,pf.profile_code,pf.person_id,pf.company_id,pf.work_area_id,
  pe.person_number,pe.full_name,c.name AS company_name,wa.name AS work_area_name,
  c.ledger_id,loc.region_code,loc.currency_code
  FROM ty_test_account_profile pf JOIN sys_account a ON a.id=pf.account_id
  LEFT JOIN ty_person pe ON pe.id=pf.person_id LEFT JOIN ty_company c ON c.id=pf.company_id
  LEFT JOIN ty_work_area wa ON wa.id=pf.work_area_id LEFT JOIN LATERAL fn_ty_company_locale(c.id) loc ON c.id IS NOT NULL
  WHERE pf.group_id=$1 ORDER BY CASE WHEN pf.person_id IS NULL THEN 0 ELSE 1 END,a.id`,[groupId]);
 for(const r of rows) {
  r.role_name=roleSpecs.find(s=>s.profile_code===r.profile_code)?.role_name ||
   (r.profile_code==='group_hr_director'?'集团HR总监':r.profile_code==='company_hr_director'?'公司HR总监':r.profile_code==='store_manager'?'店长':r.profile_code==='station_staff'?'档口人员':r.company_name==='天意集团总部'?'总部员工·自助':'店员');
  r.permission_summary=summaries[r.profile_code]||'';
  if(r.person_id)r.work_areas=(await q(tx,`SELECT DISTINCT w.id,w.name,w.mode FROM ty_position_assignment a JOIN ty_work_area w ON w.id=a.work_area_id
    WHERE a.employment_id IN(SELECT id FROM ty_employment WHERE person_id=$1 AND status='active')
      AND a.status='active' AND a.valid_from<=app_today() AND (a.valid_to IS NULL OR app_today()<a.valid_to) ORDER BY w.id`,[r.person_id]));
  else r.work_areas=[];
  r.permission_summary=summaries[r.profile_code];
 }
 return rows;
}

export async function seed(tx,{userId,input={},passwordFactory=()=>`Ty9!${randomBytes(8).toString('base64url')}`}) {
 if(input.confirm_synthetic!==true)throw bizErr('E_TY_ARGUMENT','请明确confirm_synthetic，仅建立虚构测试账号');
 if(!(await foundation.accessFor(tx,userId)).admin)throw bizErr('E_TY_FORBIDDEN','仅系统配置管理员可以建立测试账号');
 await tx.query('LOCK TABLE ty_test_account_profile IN SHARE ROW EXCLUSIVE MODE');
 const group=(await q(tx,'SELECT * FROM ty_group WHERE id=$1',[Number(input.group_id)]))[0];
 if(!group||group.code!=='TY-TEST')fail('只允许为完整TY-TEST虚构集团建立演示账号');
 const receipt=(await q(tx,"SELECT after_data FROM ty_audit WHERE entity_kind='test_workspace' AND entity_id=$1 AND action='seed' ORDER BY id DESC LIMIT 1",[group.id]))[0]?.after_data;
 if(!receipt?.complete||!receipt.synthetic)fail('必须先建立完整虚构测试帐套');
 const people=await q(tx,`SELECT DISTINCT ON(p.id) p.id,p.person_number,p.full_name,p.legacy_person_id,e.id AS employment_id,e.company_id,e.legacy_employment_id,
  c.name AS company_name,c.company_kind,c.ledger_id,a.id AS assignment_id,a.department_id,a.position_id,a.grade_id,a.work_area_id,j.code AS job_code,
  a.valid_from,a.valid_to
  FROM ty_person p JOIN ty_employment e ON e.person_id=p.id AND e.status='active'
  JOIN ty_company c ON c.id=e.company_id JOIN ty_position_assignment a ON a.employment_id=e.id AND a.is_primary
    AND a.status='active' AND a.valid_from<=app_today() AND (a.valid_to IS NULL OR app_today()<a.valid_to)
  JOIN ty_company_position cp ON cp.id=a.position_id JOIN ty_job j ON j.id=cp.job_id
  WHERE p.group_id=$1 ORDER BY p.id,e.hire_date,e.id`,[group.id]);
 if(people.length!==62||new Set(people.map(p=>String(p.id))).size!==62||people.some(p=>!p.legacy_person_id))fail('当前测试帐套必须有62名已接续的虚构员工及有效主任职');
 const bindings=await q(tx,`SELECT b.*,c.ledger_id FROM ty_legacy_company_binding b JOIN ty_company c ON c.id=b.company_id WHERE c.group_id=$1 ORDER BY c.id`,[group.id]);
 if(bindings.length!==21)fail('请先完成21家测试经营公司的旧业务接续');
 await tx.query('LOCK TABLE sys_account IN SHARE ROW EXCLUSIVE MODE');
 await tx.query('LOCK TABLE sys_data_scope IN SHARE ROW EXCLUSIVE MODE');
 const existingProfiles=await q(tx,'SELECT * FROM ty_test_account_profile WHERE group_id=$1',[group.id]);
 const created=[],scopes=new Map();
 const ensureScope=async spec=>{
  const key=spec.scope==='company'?`company:${spec.company_id}`:spec.scope;
  if(!scopes.has(key))scopes.set(key,await newScope(tx,`TY账号·G${group.id}·${key}`,
   spec.scope==='company'?bindings.filter(b=>same(b.company_id,spec.company_id)):bindings,spec.scope));
  return scopes.get(key);
 };
 const specs=[...roleSpecs,...people.map(p=>({login:p.person_number.toLowerCase(),display_name:p.full_name,person_id:p.id,legacy_person_id:p.legacy_person_id,
  company_id:p.company_id,ledger_id:p.ledger_id,work_area_id:p.work_area_id,
  profile_code:p.company_kind==='store'&&p.job_code==='SYN-MANAGER'?'store_manager':p.job_code==='SYN-CHEF'?'station_staff':'store_staff',
  role:p.company_kind==='store'&&p.job_code==='SYN-MANAGER'?'store_mgr':'store_staff',scope:'company',write:false}))];
 for(const spec of specs) {
  const already=existingProfiles.find(p=>spec.person_id?same(p.person_id,spec.person_id):p.person_id===null&&p.profile_code===spec.profile_code);
  if(already)continue;
  let login=spec.login;
  if((await q(tx,'SELECT id FROM sys_account WHERE login=$1',[login])).length)login=`g${group.id}_${login}`;
  if((await q(tx,'SELECT id FROM sys_account WHERE login=$1',[login])).length)fail(`登录名${login}已被其他账号占用，未覆盖`);
  const role=(await q(tx,'SELECT id FROM sys_role WHERE code=$1 AND is_active',[spec.role]))[0];if(!role)fail(`角色${spec.role}不存在`);
  const accountId=(await q(tx,`SELECT greatest(1001,coalesce((SELECT max(id)+1 FROM sys_account),0),
   coalesce((SELECT max(user_id)+1 FROM sys_user_role),0),coalesce((SELECT max(user_id)+1 FROM sys_user_credential),0)) id`))[0].id;
  await tx.query('INSERT INTO sys_account(id,login,display_name,person_id) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)',[accountId,login,spec.display_name,spec.legacy_person_id||null]);
  await tx.query(`INSERT INTO ty_test_account_profile(account_id,group_id,person_id,company_id,work_area_id,profile_code,seed_version)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[accountId,group.id,spec.person_id||null,spec.company_id||null,spec.work_area_id||null,spec.profile_code,VERSION]);
  const sid=await ensureScope(spec);
  await tx.query(`INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,granted_by,grant_kind,grant_reason)
   VALUES($1,$2,$3,'2026-01-01',$4,'ROLE','仅全虚构TY-TEST账号角色初始化')`,[accountId,role.id,sid,userId]);
  await tx.query(`INSERT INTO ty_access_grant(account_id,group_id,ledger_id,company_id,can_read,can_write,valid_from)
   VALUES($1,$2,$3,$4,true,$5,'2026-01-01')`,[accountId,group.id,spec.scope==='company'?spec.ledger_id:null,spec.scope==='company'?spec.company_id:null,!!spec.write]);
  const password=passwordFactory(spec);if(typeof password!=='string')fail('初始化密码生成失败');
  await tx.query('SELECT fn_pwd_check($1)',[password]);await tx.query('SELECT fn_credential_set($1,$2)',[accountId,hashPassword(password)]);
  created.push({account_id:accountId,password});
 }
 await tx.query("SELECT setval(pg_get_serial_sequence('sys_account','id'),greatest(1,(SELECT max(id) FROM sys_account)))");
 let addedAssignments=0;
 if(input.include_work_area_assignments===true) {
  for(const p of people.filter(p=>p.job_code==='SYN-CHEF')) {
   const area=(await q(tx,"SELECT * FROM ty_work_area WHERE company_id=$1 AND mode='department_extension' ORDER BY id LIMIT 1",[p.company_id]))[0];
   if(!area)continue;
   const exists=(await q(tx,`SELECT id FROM ty_position_assignment WHERE employment_id=$1 AND work_area_id=$2 AND status='active'
    AND valid_from<=app_today() AND (valid_to IS NULL OR app_today()<valid_to)`,[p.employment_id,area.id]))[0];
   if(exists)continue;
   await foundation.save(tx,{userId,collection:'assignments',input:{group_id:group.id,company_id:p.company_id,employment_id:p.employment_id,
    department_id:p.department_id,position_id:p.position_id,grade_id:p.grade_id,work_area_id:area.id,is_primary:false,
    valid_from:(await q(tx,'SELECT app_today()::text d'))[0].d}});addedAssignments++;
  }
 }
 const accounts=await metadata(tx,group.id);
 for(const a of accounts)a.password=created.find(c=>same(c.account_id,a.account_id))?.password??null;
 if(created.length||addedAssignments)await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)
   VALUES($1,'seed_accounts','test_workspace',$2,$3::jsonb)`,[userId,group.id,JSON.stringify({seed_version:VERSION,created_account_ids:created.map(c=>c.account_id),added_secondary_assignments:addedAssignments,total_accounts:accounts.length})]);
 return {synthetic:true,group_id:group.id,seed_version:VERSION,created:created.length,added_secondary_assignments:addedAssignments,
  employee_accounts:accounts.filter(a=>a.person_id).length,function_accounts:accounts.filter(a=>!a.person_id).length,total_accounts:accounts.length,accounts};
}
