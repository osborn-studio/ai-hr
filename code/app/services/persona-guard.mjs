// Operator identities are stored in the database. Query parameters and UI
// labels never change a user's role, employee binding or allowed actions.
import { bizErr } from '../errors.mjs';
import { requireSession } from './guard.mjs';
import { inStationScope } from './scope.mjs';

export async function personaFor(tx,userId) {
  if((await tx.query("SELECT to_regclass('public.ty_operator_binding') IS NOT NULL ok")).rows[0].ok){
    const operator=(await tx.query(`SELECT b.*,a.person_id AS legacy_person_id
      FROM ty_operator_binding b JOIN sys_account a ON a.id=b.account_id
      WHERE b.account_id=$1 AND b.status='active' AND a.status='active'`,[userId])).rows[0];
    if(operator)return operator;
  }
  if(!(await tx.query("SELECT to_regclass('public.ty_test_account_profile') IS NOT NULL ok")).rows[0].ok)return null;
  return (await tx.query(`SELECT p.*,a.person_id AS legacy_person_id
    FROM ty_test_account_profile p JOIN sys_account a ON a.id=p.account_id
    WHERE p.account_id=$1`,[userId])).rows[0]||null;
}

// The older endpoints combine coarse resource and data scopes independently.
// Accounts configured with complete native grants use the versioned endpoints,
// whose guards keep action, company, person and fields in the same grant.
export async function authorizeManagedLegacyRequest(tx,{userId,pathname}) {
  if(pathname.startsWith('/api/me')||pathname.startsWith('/api/v2/'))return;
  if(!(await tx.query("SELECT to_regclass('public.ty_auth_managed') IS NOT NULL ok")).rows[0].ok)return;
  const managed=(await tx.query(`SELECT EXISTS(SELECT 1 FROM ty_auth_managed WHERE account_id=$1)
    OR EXISTS(SELECT 1 FROM ty_access_grant WHERE account_id=$1 AND platform_source_key IS NOT NULL)ok`,[userId])).rows[0].ok;
  if(managed)throw bizErr('E_TY_FORBIDDEN','当前账号已使用完整授权，请通过新版业务入口操作；此接口尚未支持同一授权内的字段和数据范围');
}
const denied=message=>{throw bizErr('E_RESOURCE_FORBIDDEN',message);};
const staff=new Set(['store_staff','station_staff','outsourced_staff']);
const store=new Set([...staff,'store_manager']);
const selfPaths=new Set(['/api/outsource/my','/api/time/my','/api/customer-payroll/my','/api/training/my','/api/exam/my-board']);
const selfExam=new Set(['/api/exam/paper','/api/exam/start','/api/exam/submit','/api/exam/result','/api/exam/ledger','/api/exam/tasks','/api/exam/window','/api/exam/review','/api/exam/event']);

export async function authorizePersonaRequest(tx,{userId,pathname,method}) {
  const p=await personaFor(tx,userId);if(!p)return;
  const read=method==='GET'||method==='HEAD';
  const personal=pathname.startsWith('/api/me');
  if(['group_hr_director','company_hr_director'].includes(p.profile_code)&&(/^\/api\/(ledger|policy|access|accounts|admin|mcp|health|checks|coverage)(?:\/|$)/.test(pathname)||(!read&&/^\/api\/roles(?:\/|$)/.test(pathname))))denied('HR总监管理授权集团或公司业务；系统级账号、帐库和全局制度由配置管理员维护');
  if(p.profile_code==='outsourced_staff'&&/^\/api\/(customer-payroll|customer-performance|payslip|salary|payroll|leave|training\/manage|settlement)(?:\/|$)/.test(pathname))denied('外包服务人员只使用本人派驻、考勤、培训与沟通；企业直营薪酬和外包账单不开放');
  if(['vendor_contact','outsource_hr'].includes(p.profile_code)&&!personal&&pathname!=='/api/foundation/bootstrap'&&!pathname.startsWith('/api/outsource/'))denied('此外包账号仅开放授权的供应商服务与沟通门户');
  if(p.profile_code==='demo'||personal||selfPaths.has(pathname))return;
  if(p.profile_code==='boss'&&!read&&!pathname.startsWith('/api/hk-tools/'))denied('老板账号为业务只读，不能修改业务或系统授权');
  if(p.profile_code==='config_admin') {
    const config=/^\/api\/(foundation(?:\/|$)|ledger(?:\/|$)|policy(?:\/|$)|roles(?:\/|$)|access(?:\/|$)|accounts(?:\/|$)|admin(?:\/|$)|health(?:\/|$)|checks(?:\/|$)|coverage(?:\/|$))/;
    if(!config.test(pathname)||/^\/api\/foundation\/(demo-seed|test-seed|import|bridge)(?:\/|$)/.test(pathname)||(!read&&/^\/api\/foundation\/(people|employments|assignments|external-identities)(?:\/|$)/.test(pathname)))denied('admin仅用于系统与基础配置，业务操作请使用对应岗位账号');
  }
  if(store.has(p.profile_code)&&(/^\/api\/(customer-payroll|customer-performance|salary|payroll|hr|offboarding|severance|settlement)(?:\/|$)/.test(pathname)))denied('门店账号通过个人工资入口查看本人，不能读取整批薪酬或其他人的奖金');
  if(staff.has(p.profile_code)) {
    const basic=pathname==='/api/foundation/bootstrap'||/^\/api\/foundation\/people\/\d+\/timeline$/.test(pathname);
    const selfLeave=new Set(['/api/leave/balance','/api/leave/apply','/api/leave/types']);
    const allowed=pathname==='/api/outsource/threads'||/^\/api\/outsource\/threads\/\d+\/messages$/.test(pathname)||pathname==='/api/time/export.csv'||basic||selfExam.has(pathname)||selfLeave.has(pathname)||pathname==='/api/payslip'||pathname.startsWith('/api/approval/my')||pathname.startsWith('/api/approval/mine');
    if(!allowed)denied('普通员工账号仅提供本人资料、工资、假期和学习自助功能');
  }
}

export async function accountPerson(tx,userId) {
  const p=await personaFor(tx,userId);
  const account=(await tx.query('SELECT person_id FROM sys_account WHERE id=$1 AND status=\'active\'',[userId])).rows[0];
  if(!account?.person_id)denied('账号未绑定有效员工');
  if(p&&(!p.person_id||!p.legacy_person_id||String(p.legacy_person_id)!==String(account.person_id)))denied('账号员工绑定不一致');
  if(p) {
    const mapped=(await tx.query('SELECT legacy_person_id FROM ty_person WHERE id=$1',[p.person_id])).rows[0];
    if(!mapped||String(mapped.legacy_person_id)!==String(account.person_id))denied('账号员工绑定不一致');
  }
  return Number(account.person_id);
}

export async function trainingPersonAccess(tx,{userId,personId,action='read',on=null}) {
  const manage=!!(await tx.query('SELECT fn_role_can($1,\'training_manage\',$2) ok',[userId,action])).rows[0].ok;
  if(manage) {
    await requireSession(tx,{userId,resource:'training_manage',action});
    if(!await personaFor(tx,userId))return {self:false};
    const visible=(await tx.query(`SELECT EXISTS(SELECT 1 FROM person pe WHERE pe.id=$1
      AND ${inStationScope('pe.id','$2','$3::date')}) ok`,[personId,userId,on])).rows[0].ok;
    if(!visible)denied('人员不在当前学习管理范围');
    return {self:false};
  }
  await requireSession(tx,{userId,resource:'training_self',action});
  if(Number(personId)!==await accountPerson(tx,userId))denied('只能操作本人的学习记录');
  return {self:true};
}

export async function trainingAttemptAccess(tx,{userId,attemptId,action='read'}) {
  const row=(await tx.query('SELECT employee_id,(started_at AT TIME ZONE app_tz())::date AS on FROM exam_attempt WHERE id=$1',[attemptId])).rows[0];
  if(!row)throw bizErr('E_EXAM_NO_ATTEMPT','答卷不存在或不在授权范围');
  await trainingPersonAccess(tx,{userId,personId:Number(row.employee_id),action,on:row.on});
}

export async function trainingPaperAccess(tx,{userId,action='read'}) {
  const manage=!!(await tx.query('SELECT fn_role_can($1,\'training_manage\',$2) ok',[userId,action])).rows[0].ok;
  await requireSession(tx,{userId,resource:manage?'training_manage':'training_self',action});
  if(!manage)await accountPerson(tx,userId);
}
