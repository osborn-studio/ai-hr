import {randomBytes} from 'node:crypto';
import {bizErr} from '../errors.mjs';
import * as foundation from './foundation.mjs';
import * as outsourcing from './outsourcing.mjs';
import {hashPassword} from './auth.mjs';
const q=async(t,s,a=[])=>(await t.query(s,a)).rows;
const same=(a,b)=>String(a)===String(b);
const VERSION='TY-OUTSOURCE-v1';
const surname=['周','陈','许','郑','王','顾','陆','程','叶','林','沈','赵','吴','梁','苏','方','唐','徐','江','冯','朱','孟','何','宋','刘','马','姚','杜','黄','曹','孙'];
const given=['嘉禾','知宁','锦安','亦辰','沐言','景和','清越','舒然','承宇','星澄','予安','思远','云舒','明轩','芷晴','若涵','子衡','悦宁','文熙','佳音','向晨','以安','欣然','晓棠','奕川','书瑶','可欣','语桐','雨澄','安禾','知行'];
const functionNames={boss:'林景行',group_hr_director:'熊知衡',company_hr_director:'宋知远',hk_hr_director:'刘和安',store_hr_director:'章知礼',hr_manager:'何仁杰',recruiter:'齐昭宁',payroll:'沈新瑜',trainer:'田沛然',hr_staff:'陆仁和'};
export async function seed(t,{userId,input,passwordFactory=()=>randomBytes(12).toString('base64url')}){
 if(input?.confirm_synthetic!==true)throw bizErr('E_TY_ARGUMENT','必须明确仅创建虚构供应商、人员姓名、合同、账单和消息');
 const a=await foundation.accessFor(t,userId);if(!a.platformAdmin)throw bizErr('E_TY_FORBIDDEN','仅由演示全权限或技术初始化执行');
 const g=(await q(t,"SELECT * FROM ty_group WHERE code='TY-TEST' FOR UPDATE"))[0];if(!g)throw bizErr('E_TY_ARGUMENT','缺少天意集团测试工作区');
 const marker=(await q(t,"SELECT * FROM ty_audit WHERE entity_kind='outsourcing_demo' AND entity_id=$1 AND action='seed'",[g.id]))[0];if(marker)return{...marker.after_data,already_exists:true,created_accounts:[]};
 const people=await q(t,`SELECT p.*,e.id employment_id,e.company_id,e.employment_type,cp.code position_code,j.code job_code FROM ty_person p JOIN ty_employment e ON e.person_id=p.id AND e.status='active' JOIN ty_position_assignment pa ON pa.employment_id=e.id AND pa.is_primary AND pa.status='active' JOIN ty_company_position cp ON cp.id=pa.position_id JOIN ty_job j ON j.id=cp.job_id WHERE p.group_id=$1 ORDER BY p.id,e.hire_date`,[g.id]);
 const unique=[];for(const p of people)if(!unique.some(x=>same(x.id,p.id)))unique.push(p);if(unique.length!==62)throw bizErr('E_TY_CONFLICT','仅处理62人虚构帐套，不导入其他人员');
 for(let i=0;i<unique.length;i++){
  const p=unique[i];const name=surname[i%surname.length]+given[(i*7+Math.floor(i/surname.length)*3)%given.length];
  await t.query('INSERT INTO ty_demo_name_assignment(person_id,full_name,version,assigned_by)VALUES($1,$2,$3,$4)',[p.id,name,VERSION,userId]);
  await foundation.save(t,{userId,collection:'people',id:p.id,input:{full_name:name}});
  if(p.legacy_person_id)await t.query('UPDATE person SET full_name=$2 WHERE id=$1',[p.legacy_person_id,name]);
  await t.query('UPDATE sys_account SET display_name=$2 WHERE id IN(SELECT account_id FROM ty_test_account_profile WHERE person_id=$1)',[p.id,name]);p.full_name=name;
 }
 for(const[login,name]of Object.entries(functionNames))await t.query('UPDATE sys_account SET display_name=$2 WHERE id IN(SELECT p.account_id FROM ty_test_account_profile p JOIN sys_account a ON a.id=p.account_id WHERE p.group_id=$3 AND a.login=$1)',[login,name,g.id]);
 const accounts=[];
 async function account(login,name,profile,role,supplierId=null){
  if((await q(t,'SELECT id FROM sys_account WHERE login=$1',[login])).length)throw bizErr('E_TY_CONFLICT','外包演示登录名已存在，不接管');
  const acc=(await q(t,'INSERT INTO sys_account(id,login,display_name)OVERRIDING SYSTEM VALUE SELECT greatest(1001,coalesce(max(id),0)+1),$1,$2 FROM sys_account RETURNING *',[login,name]))[0];
  const password=passwordFactory({login});await t.query('SELECT fn_credential_set($1,$2,false)',[acc.id,hashPassword(password)]);
  await t.query('INSERT INTO ty_test_account_profile(account_id,group_id,profile_code,seed_version)VALUES($1,$2,$3,$4)',[acc.id,g.id,profile,VERSION]);
  const sid=(await q(t,"INSERT INTO sys_data_scope(id,name,combinator)SELECT max(id)+1,$1,'intersection'FROM sys_data_scope RETURNING id",[name+'外包门户范围']))[0].id;
  for(const dim of ['cost_org','attendance_org','payroll_legal_entity','si_entity'])await t.query("INSERT INTO sys_data_scope_rule(data_scope_id,dimension,value_type,value_ids)VALUES($1,$2,'none','{}')",[sid,dim]);
  await t.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)SELECT $1,id,$2,'2026-01-01','ROLE','全虚构外包演示门户'FROM sys_role WHERE code=$3",[acc.id,sid,role]);
  if(supplierId)await t.query('INSERT INTO ty_outsource_portal_user(account_id,group_id,supplier_id)VALUES($1,$2,$3)',[acc.id,g.id,supplierId]);
  else await t.query("INSERT INTO ty_access_grant(account_id,group_id,can_read,can_write,valid_from)VALUES($1,$2,true,true,'2026-01-01')",[acc.id,g.id]);
  accounts.push({account_id:acc.id,login,password});return acc;
 }
 const coordinator=await account('outsource_hr','许和宁','outsource_hr','ty_outsource_hr');
 const vendors=[],contracts=[],converted=[],agency=[];
 for(const[region,index]of [['CN',0],['HK',1]]){
  const currency=region==='CN'?'CNY':'HKD',name=region==='CN'?'和川人事服务有限公司（演示）':'海岚人事服务有限公司（香港演示）';
  const supplier=(await outsourcing.saveSupplier(t,{userId,input:{group_id:g.id,code:'SYN-VENDOR-'+region,name,region_code:region,currency_code:currency,qualification_status:'verified',qualification_ref:'SYN-QUAL-'+region,qualification_valid_to:'2027-12-31',contacts:[{name:index?'陈协宁':'顾协安',role:'供应商服务经理',phone:'000-0000-0000',email:`vendor-${region.toLowerCase()}@example.invalid`}],billing_title:name,bank_name:'演示银行，不可转账',bank_account_last4:index?'0002':'0001',notes:'内部合成供应商评价：及时率与服务质量仅作测试，不向供应商展示此内部备注'}})).row;
  vendors.push(supplier);const portal=await account(index?'vendor_hk':'vendor_cn',index?'陈协宁':'顾协安','vendor_contact','ty_vendor_contact',supplier.id);
  const companies=(await q(t,"SELECT c.*,loc.region_code FROM ty_company c CROSS JOIN LATERAL fn_ty_company_locale(c.id)loc WHERE c.group_id=$1 AND c.company_kind='store' ORDER BY c.id",[g.id])).filter(c=>c.region_code===region);
  const companyIds=companies.map(c=>c.id);
  const payrollContract=(await outsourcing.saveContract(t,{userId,input:{group_id:g.id,supplier_id:supplier.id,code:'SYN-PAY-AGENCY-'+region,name:`${region}薪酬代发与人事服务演示`,service_kind:'payroll_agency',valid_from:'2026-10-01',valid_to:'2027-12-31',company_ids:companyIds,share_payroll_details:true,pricing:{mode:'per_person',service_fee:index?120:80,currency,tax_fee_mode:'explicit_manual',payment_channel:'银行代发演示'},terms:'原劳动关系保持在各门店公司；仅代发和人事服务。工资资金、个人与单位供款、服务费分别对账。全部为虚构，没有付款或真实开票。'}})).row;contracts.push(payrollContract);
  const serviceContract=(await outsourcing.saveContract(t,{userId,input:{group_id:g.id,supplier_id:supplier.id,code:'SYN-STAFF-'+region,name:`${region}厨房清洁与备餐服务外包演示`,service_kind:'staffing_outsource',valid_from:'2026-11-16',valid_to:'2027-12-31',company_ids:companyIds,pricing:{mode:'accepted_service_hours',unit_price:index?125:48,currency,service_fee_mode:'included',tax_fee_mode:'explicit_manual'},terms:'供应商承担服务人员的雇主职责，门店记录服务场所及验收；与内部直属劳动合同、劳务派遣和工资代发分别建档，不因外包标签推定法律资格。11月16日起的服务另行确认，不使用10月直营工时冒充外包服务。'}})).row;contracts.push(serviceContract);
  const regionPeople=unique.filter(p=>companyIds.some(id=>same(id,p.company_id)));
  const workers=regionPeople.filter(p=>p.job_code==='SYN-CHEF').slice(0,3);
  for(const p of workers){
   const oldAssignments=await q(t,"SELECT * FROM ty_position_assignment WHERE employment_id=$1 AND status='active'ORDER BY is_primary DESC,id",[p.employment_id]);
   await foundation.save(t,{userId,collection:'employments',id:p.employment_id,input:{status:'ended',leave_date:'2026-11-15'}});
   const e=(await foundation.save(t,{userId,collection:'employments',input:{group_id:g.id,person_id:p.id,company_id:p.company_id,employment_type:'outsourced',hire_date:'2026-11-16',legal_subject_name:supplier.name}})).row;
   for(const old of oldAssignments)await foundation.save(t,{userId,collection:'assignments',input:{group_id:g.id,company_id:p.company_id,employment_id:e.id,department_id:old.department_id,position_id:old.position_id,grade_id:old.grade_id,work_area_id:old.work_area_id,is_primary:old.is_primary,valid_from:'2026-11-16'}});
   const en=(await q(t,"INSERT INTO ty_outsource_engagement(contract_id,person_id,company_id,employment_id,valid_from,service_role,legal_employer_name,created_by)VALUES($1,$2,$3,$4,'2026-11-16','厨房清洁与备餐服务人员',$5,$6)RETURNING *",[serviceContract.id,p.id,p.company_id,e.id,supplier.name,userId]))[0];converted.push(en);
   const acc=(await q(t,'UPDATE ty_test_account_profile SET profile_code=\'outsourced_staff\',seed_version=$2 WHERE person_id=$1 RETURNING account_id',[p.id,VERSION]))[0];
   const sid=(await q(t,'SELECT data_scope_id FROM sys_user_role WHERE user_id=$1 ORDER BY id LIMIT 1',[acc.account_id]))[0].data_scope_id;
   await t.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)SELECT $1,id,$2,'2026-11-16','ROLE','外包人员只使用本人服务门户'FROM sys_role WHERE code='ty_outsourced_person'",[acc.account_id,sid]);
   const th=(await outsourcing.createThread(t,{userId,input:{group_id:g.id,contract_id:serviceContract.id,person_id:p.id,category:'onboarding',subject:'服务到岗与健康培训确认',due_date:'2026-11-18',body:'请供应商确认此位服务人员的到岗、培训及服务门店安排。示例消息仅在系统内保存。'}})).thread;
   await outsourcing.postMessage(t,{userId:portal.id,id:th.id,input:{group_id:g.id,body:'已核对服务人员及门店，培训证明将在本事项补充，请HR复核。',visibility:'shared'}});
   await outsourcing.postMessage(t,{userId:acc.account_id,id:th.id,self:true,input:{group_id:g.id,body:'已查看本人服务安排，申请核对下周培训时间。',visibility:'shared'}});
  }
  const payrollPeople=regionPeople.filter(p=>p.job_code==='SYN-SERVICE').slice(0,2);
  for(const p of payrollPeople){const en=(await q(t,"INSERT INTO ty_outsource_engagement(contract_id,person_id,company_id,employment_id,valid_from,service_role,legal_employer_name,created_by)VALUES($1,$2,$3,$4,'2026-10-01','直营员工薪酬代发服务',$5,$6)RETURNING *",[payrollContract.id,p.id,p.company_id,p.employment_id,(await q(t,'SELECT name FROM ty_company WHERE id=$1',[p.company_id]))[0].name,userId]))[0];agency.push(en);}
  const bill=(await outsourcing.createBill(t,{userId,input:{group_id:g.id,contract_id:payrollContract.id,period:'2026-10',note:'10月工资资金与服务费对账，全虚构未付款；税费未推定，另按合同明确。'}})).bill;
  const rows=await q(t,"SELECT r.* FROM ty_time_payroll_link l JOIN ty_payroll_row r ON r.batch_id=l.batch_id WHERE l.region_code=$1 AND r.person_id=ANY($2::bigint[])",[region,payrollPeople.map(p=>p.id)]);
  if(rows.length!==2)throw new Error('Expected two locked October payroll sources for agency billing');
  for(const r of rows){for(const[code,component,label]of [['employee_net','net_pay','员工净薪代发资金'],['employee_contribution','employee_contribution','员工个人供款代缴资金'],['employer_contribution','employer_contribution','企业供款代缴资金'],...(region==='CN'?[['withheld_tax','cn_tax','个人所得税代缴资金']]:[])]){
    const amount=component==='cn_tax'?r.result_data.items.find(i=>i.code==='cn_tax')?.amount:r.result_data.totals[component];
    await outsourcing.saveBillLine(t,{userId,billId:bill.id,input:{company_id:r.company_id,person_id:r.person_id,item_code:code,description:label,quantity:1,unit_price:amount,source_ref:{kind:'payroll',row_id:r.id,batch_id:r.batch_id,component}}});
   }
   await outsourcing.saveBillLine(t,{userId,billId:bill.id,input:{company_id:r.company_id,person_id:r.person_id,item_code:'service_fee',description:'按人按月的人事代发服务费（示例）',quantity:1,unit_price:index?120:80,source_ref:{kind:'contract',contract_id:payrollContract.id}}});
  }
  let current=(await outsourcing.billDetail(t,{userId,id:bill.id})).bill;
  await outsourcing.decideBill(t,{userId,id:bill.id,input:{action:'share',revision:current.revision,note:'HR已核对资金项目与服务费，系统内共享对账'}});
  if(!index){await outsourcing.decideBill(t,{userId:portal.id,id:bill.id,input:{action:'confirm',revision:current.revision,note:'供应商已核对10月全部代发与服务费明细'}});await outsourcing.decideBill(t,{userId,id:bill.id,input:{action:'confirm',revision:current.revision,note:'HR与供应商双向核对一致，示例确认不代表付款'}});}
  else{await outsourcing.decideBill(t,{userId:portal.id,id:bill.id,input:{action:'dispute',revision:current.revision,note:'供应商请HR核对服务费起算日，示例保留争议待办'}});await outsourcing.createThread(t,{userId:portal.id,input:{group_id:g.id,contract_id:payrollContract.id,bill_id:bill.id,category:'billing',subject:'10月服务费起算日差异核对',due_date:'2026-11-20',body:'请HR确认服务费是否按整月还是按服务天数折算，账单保持争议，暂不确认。'}});}
  await outsourcing.createThread(t,{userId,input:{group_id:g.id,contract_id:payrollContract.id,category:'attendance',subject:'下月考勤与工资资料提交提醒',due_date:'2026-11-25',body:'请在约定日期前核对考勤异常与供款资料；不通过本消息传递身份证、银行卡等敏感信息。'}});
 }
 const receipt={synthetic:true,group_id:g.id,version:VERSION,people:62,renamed:62,suppliers:vendors.length,contracts:contracts.length,outsourced_people:converted.length,payroll_agency_people:agency.length,new_function_accounts:accounts.length};
 await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'seed','outsourcing_demo',$2,$3::jsonb)",[userId,g.id,JSON.stringify(receipt)]);
 return{...receipt,created_accounts:accounts};
}
