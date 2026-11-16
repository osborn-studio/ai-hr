import { accessFor } from './foundation.mjs';
import { bizErr } from '../errors.mjs';
export const RESOURCES=['payroll_run','payroll_slips_read_all'];
async function company(tx,userId,companyId){
  const id=Number(companyId);if(!Number.isSafeInteger(id)||id<=0)throw bizErr('E_TY_ARGUMENT','请选择香港经营公司');
  const caps=(await tx.query("SELECT fn_role_can($1,'payroll_run','read') p,fn_role_can($1,'payroll_slips_read_all','read') a",[userId])).rows[0];
  if(!caps?.p||!caps?.a)throw bizErr('E_TY_FORBIDDEN','需要薪酬岗位权限');
  const a=await accessFor(tx,userId),c=(await tx.query('SELECT c.*,l.region_code,l.currency_code FROM ty_company c CROSS JOIN LATERAL fn_ty_company_locale(c.id) l WHERE c.id=$1',[id])).rows[0];
  if(!c||!a.row({...c,company_id:c.id}))throw bizErr('E_TY_NOT_FOUND','公司不在授权范围');
  if(c.region_code!=='HK'||c.currency_code!=='HKD')throw bizErr('E_TY_ARGUMENT','此核验工具仅适用于已配置为香港及港元的公司');
  return c;
}
export async function calculate(tx,{userId,kind,input}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw bizErr('E_TY_ARGUMENT','请提交核验参数');
  const c=await company(tx,userId,input.company_id);
  const fn=kind==='continuous-contract'?'fn_ty_hk_hours_condition':kind==='average-daily-wage'?'fn_ty_hk_average_daily_wage':null;
  if(!fn)throw bizErr('E_TY_NOT_FOUND','香港核验工具不存在');
  const result=(await tx.query(`SELECT ${fn}($1::jsonb) result`,[JSON.stringify(input)])).rows[0].result;
  return {company:{id:c.id,name:c.name,region_code:c.region_code,currency_code:c.currency_code},...result};
}
