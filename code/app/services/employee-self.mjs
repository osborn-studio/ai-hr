// Employee self service never takes an employee identifier from the client.
import {bizErr} from '../errors.mjs';

export const RESOURCES=['payslip'];

export async function payroll(tx,{userId}) {
  const allowed=(await tx.query("SELECT fn_role_can($1,'payslip','read') ok",[userId])).rows[0]?.ok;
  if(!allowed)throw bizErr('E_TY_FORBIDDEN','当前账号没有查看本人工资的权限');
  const rows=(await tx.query(`SELECT b.id AS batch_id,b.period,b.currency,b.region_code,b.confirmed_at,
    c.name AS company_name,p.person_number,p.full_name,r.result_data
    FROM sys_account a
    JOIN ty_person p ON p.legacy_person_id=a.person_id
    JOIN ty_test_account_profile profile ON profile.account_id=a.id
      AND profile.person_id=p.id AND profile.group_id=p.group_id
    JOIN ty_payroll_row r ON r.person_id=p.id AND r.group_id=p.group_id
    JOIN ty_payroll_batch b ON b.id=r.batch_id AND b.group_id=p.group_id
    JOIN ty_company c ON c.id=r.company_id AND c.group_id=p.group_id
    WHERE a.id=$1 AND a.status='active' AND b.status='confirmed'
    ORDER BY b.period DESC,b.id DESC,r.id`,[userId])).rows;
  return {rows:rows.map(({result_data,...row})=>({...row,
    totals:result_data?.totals||{},
    items:(result_data?.items||[]).map(({code,name,kind,amount})=>({code,name,kind,amount})),
  }))};
}
