// Explicit synthetic overlay only. No identities, credentials, legal thresholds,
// customer rows, bank instructions or payroll confirmation receipts are created.
import {pathToFileURL}from'node:url';
import{resolve}from'node:path';
import{mkdir,writeFile,rename,chmod}from'node:fs/promises';
import{createDb,withTx}from'../app/db.mjs';
import{accessFor}from'../app/services/foundation.mjs';
import{sameHuman}from'../app/services/human-identity.mjs';
import{dispatchCommand}from'../app/services/people-services.mjs';
export const VERSION='TY-PEOPLE-SERVICES-DEMO-202610-V1';
const q=async(t,s,p=[])=>(await t.query(s,p)).rows,one=async(t,s,p=[])=>(await q(t,s,p))[0];
const same=(a,b)=>String(a)===String(b),fail=m=>{throw new Error(m);};
const marker='10月行政人事登记';
const actorIndex=a=>({account_id:a.id,login:a.login,profile_code:a.profile_code,display_name:a.display_name});
const date=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
const maxDate=(a,b)=>a>b?a:b;
const at=d=>d+'T00:00:00+08:00';
async function counts(t,gid){return one(t,`SELECT
 (SELECT count(*) FROM ty_dorm_house WHERE group_id=$1)::int houses,
 (SELECT count(*) FROM ty_dorm_room WHERE group_id=$1)::int rooms,
 (SELECT count(*) FROM ty_dorm_bed WHERE group_id=$1)::int beds,
 (SELECT count(*) FROM ty_dorm_stay WHERE group_id=$1)::int stays,
 (SELECT count(*) FROM ty_dorm_repair WHERE group_id=$1)::int repairs,
 (SELECT count(*) FROM ty_dorm_bill WHERE group_id=$1)::int bills,
 (SELECT count(*) FROM ty_dorm_charge WHERE group_id=$1)::int charges,
 (SELECT count(*) FROM ty_dorm_settlement s JOIN ty_dorm_charge c ON c.id=s.charge_id WHERE c.group_id=$1)::int settlements,
 (SELECT count(*) FROM ty_cert_type WHERE group_id=$1)::int certificate_types,
 (SELECT count(*) FROM ty_cert_requirement WHERE group_id=$1)::int certificate_requirements,
 (SELECT count(*) FROM ty_cert_holding WHERE group_id=$1)::int holdings,
 (SELECT count(*) FROM ty_cert_custody s JOIN ty_cert_holding h ON h.id=s.holding_id WHERE h.group_id=$1)::int custody,
 (SELECT count(*) FROM ty_cert_recognition WHERE group_id=$1)::int recognitions,
 (SELECT count(*) FROM ty_goods_item WHERE group_id=$1)::int items,
 (SELECT count(*) FROM ty_goods_doc WHERE group_id=$1)::int goods_documents,
 (SELECT count(*) FROM ty_goods_movement m JOIN ty_goods_item i ON i.id=m.item_id WHERE i.group_id=$1)::int stock_movements,
 (SELECT count(*) FROM ty_ps_candidate WHERE group_id=$1)::int source_candidates`,[gid]);}
async function actorsFor(t,gid){
 const candidates=await q(t,`SELECT a.id,a.login,a.display_name,p.profile_code FROM sys_account a JOIN ty_test_account_profile p ON p.account_id=a.id WHERE a.status='active'AND p.group_id=$1 AND p.profile_code IN('demo','group_hr_director','hr_manager') ORDER BY CASE p.profile_code WHEN 'group_hr_director'THEN 0 WHEN 'demo'THEN 1 ELSE 2 END,a.id`,[gid]);
 const actors=[];for(const a of candidates){if(!(await accessFor(t,a.id)).shared(gid,true))continue;let allowed=true;for(const r of['people_dorm_manage','people_dorm_approve','people_dorm_payroll','people_cert_manage','people_cert_verify','people_goods_manage','people_goods_approve'])if(!(await one(t,'SELECT fn_role_can($1,$2,\'write\')ok',[a.id,r])).ok)allowed=false;if(allowed)actors.push(a);}
 const manager=actors[0];let reviewer=null;for(const a of actors.slice(1))if(!await sameHuman(t,manager.id,a.id)){reviewer=a;break;}if(!manager||!reviewer)fail('须有两位既有、不同真实人员且有权的全集团业务/复核人员；工具不扩权');return{manager,reviewer};
}
export async function seedPeopleServicesDemo(db,{confirmSynthetic=false}={}){
 if(confirmSynthetic!==true)fail('必须明确 --confirm-synthetic；仅为TY-TEST演示');
 return withTx(db,async t=>{
  if(!(await one(t,"SELECT to_regclass('public.ty_dorm_house') IS NOT NULL ok")).ok)fail('请先受控应用215；工具不会前滚数据库');
  const group=await one(t,"SELECT * FROM ty_group WHERE code='TY-TEST' FOR UPDATE");if(!group)fail('缺少既有TY-TEST工作区，未新建人员或账号');
  const proof=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed'AND entity_kind='test_workspace'AND entity_id=$1 ORDER BY id DESC LIMIT 1",[group.id]);
  const size=await one(t,'SELECT(SELECT count(*)FROM ty_person WHERE group_id=$1)::int people,(SELECT count(*)FROM ty_test_account_profile WHERE group_id=$1)::int accounts',[group.id]);
  if(!proof?.after_data?.synthetic||!proof.after_data.complete||size.people!==62||size.accounts!==77)fail('只接受已标记的62名既有人员/77个既有测试账号；不补造身份或重置口令');
  const prior=await one(t,"SELECT after_data FROM ty_audit WHERE action='seed'AND entity_kind='people_services_demo'AND entity_id=$1 AND after_data->>'version'=$2 ORDER BY id DESC LIMIT 1",[group.id,VERSION]);
  if(prior?.after_data?.complete)return{...prior.after_data,replayed:true,existing_business_state_preserved:true,counts_now:await counts(t,group.id)};
  const actors=await actorsFor(t,group.id),before=await counts(t,group.id),scenes=[],warnings=[];
  const people=await q(t,`SELECT DISTINCT ON(p.id)p.id person_id,p.person_number,p.full_name,e.id employment_id,e.company_id,e.hire_date,e.leave_date,e.employment_type,c.code company_code,c.name company_name,loc.region_code,loc.currency_code,pf.account_id,pf.profile_code,a.login employee_login FROM ty_person p JOIN ty_employment e ON e.person_id=p.id JOIN ty_company c ON c.id=e.company_id CROSS JOIN LATERAL fn_ty_company_locale(c.id)loc JOIN ty_test_account_profile pf ON pf.person_id=p.id AND pf.group_id=p.group_id JOIN sys_account a ON a.id=pf.account_id AND a.status='active' WHERE p.group_id=$1 AND p.status='active'AND e.status='active'AND e.hire_date<='2026-10-01'AND(e.leave_date IS NULL OR e.leave_date>='2026-12-31')AND c.org_level='store'AND pf.profile_code IN('store_staff','station_staff','store_manager','outsourced_staff') ORDER BY p.id,e.hire_date DESC,e.id,pf.account_id`,[group.id]);
  const outsourced=await q(t,`SELECT DISTINCT ON(p.id)p.id person_id,p.person_number,p.full_name,e.id employment_id,e.company_id,e.hire_date,e.leave_date,e.employment_type,c.code company_code,c.name company_name,loc.region_code,loc.currency_code,pf.account_id,pf.profile_code,a.login employee_login FROM ty_person p JOIN ty_employment e ON e.person_id=p.id JOIN ty_company c ON c.id=e.company_id CROSS JOIN LATERAL fn_ty_company_locale(c.id)loc JOIN ty_test_account_profile pf ON pf.person_id=p.id AND pf.profile_code='outsourced_staff'JOIN sys_account a ON a.id=pf.account_id AND a.status='active'WHERE p.group_id=$1 AND e.status='active'AND e.employment_type='outsourced'AND e.hire_date>'2026-10-01'AND e.hire_date<='2026-11-17'ORDER BY p.id,e.hire_date DESC,e.id`,[group.id]);
  const cn=people.filter(p=>p.region_code==='CN'),hk=people.filter(p=>p.region_code==='HK');if(cn.length<16||hk.length<16)fail('须有两地各至少16名已存在、覆盖演示期间的门店人员；不补造人');
  const companies=await q(t,`SELECT c.*,loc.region_code,loc.currency_code FROM ty_company c CROSS JOIN LATERAL fn_ty_company_locale(c.id)loc WHERE c.group_id=$1 AND c.org_level='store'AND c.status='active' ORDER BY c.code,c.id`,[group.id]);
  const key=s=>VERSION+':'+s;
  const call=async(module,action,input,source,actor=actors.manager)=>(await dispatchCommand(t,{userId:actor.id,module,action,input,operationId:key(module+':'+source)})).row;
  const scene=(sceneKey,module,p,data,expected,actor=actors.manager)=>scenes.push({key:sceneKey,module,route:({dormitory:'services/dormitory',certificates:'people/certificates',goods:'people/items'})[module],person_id:p?.person_id||null,person_number:p?.person_number||null,full_name:p?.full_name||null,employment_id:p?.employment_id||null,company_id:p?.company_id||data.company_id||null,employee_login:p?.employee_login||null,operator:actorIndex(actor),data,expected_initial_state:expected,synthetic_only:true});
  const houses=[],selected=[];
  for(const region of['CN','HK']){
   const pool=region==='CN'?cn:hk,owners=companies.filter(c=>c.region_code===region).slice(0,4);if(owners.length!==4)fail('两地各需四家既有门店作为房源管理主体');
   const names=region==='CN'?['静安康定公寓','徐汇田林公寓','浦东川沙公寓','闵行虹桥公寓']:['湾仔员工宿舍','观塘员工宿舍','沙田员工宿舍','荃湾员工宿舍'];
   for(let n=0;n<4;n++){
    const owner=owners[n],tag=region+'-'+n,house=await call('dormitory','house.create',{company_id:owner.id,source_key:key('HOUSE:'+tag),name:names[n],address:(region==='HK'?['香港湾仔区轩尼诗道片区','香港观塘区牛头角片区','香港沙田区大围片区','香港荃湾区大窝口片区']:['上海市静安区康定路片区','上海市徐汇区田林片区','上海市浦东新区川沙片区','上海市闵行区虹桥片区'])[n],jurisdiction:region},'HOUSE:'+tag),beds=[];
    for(let r=0;r<2;r++){const room=await call('dormitory','room.create',{house_id:house.id,code:'R'+(r+1),name:(r===0?'101':'102')+'室'},'ROOM:'+tag+':'+r);for(let b=0;b<4;b++)beds.push(await call('dormitory','bed.create',{room_id:room.id,code:String(b+1)+'号床'},'BED:'+tag+':'+r+':'+b));}
    const residents=pool.slice(n*4,n*4+4);selected.push(...residents);houses.push({house,owner,beds,residents,tag});scene('HOUSE-'+tag,'dormitory',null,{house_id:house.id,company_id:owner.id,bed_ids:beds.map(x=>x.id)},'active');
    const request=async(p,bed,from,to,suffix)=>call('dormitory','stay.request',{employment_id:p.employment_id,bed_id:bed.id,source_key:key('STAY:'+tag+':'+suffix),starts_at:at(from),ends_at:at(to)},'STAY:'+tag+':'+suffix);
    const approve=async(s,suffix)=>call('dormitory','stay.decide',{id:s.id,approve:true,decision_ref:marker+'；内部入住独立核准'},'STAY-APPROVE:'+tag+':'+suffix,actors.reviewer);
    const checkin=async(s,suffix)=>call('dormitory','stay.checkin',{id:s.id,execution_ref:marker+'；入住交接'},'STAY-IN:'+tag+':'+suffix);
    const a=await request(residents[0],beds[0],'2026-10-01','2026-12-01','A');await approve(a,'A');await checkin(a,'A');
    const transfer=await call('dormitory','stay.transfer',{id:a.id,target_bed_id:beds[4].id,at:at('2026-10-16'),ends_at:at('2026-12-01'),source_key:key('TRANSFER:'+tag),decision_ref:marker+'；内部换宿核准',execution_ref:marker+'；内部换床交接'},'TRANSFER:'+tag,actors.reviewer);scene('STAY-TRANSFER-'+tag,'dormitory',residents[0],{old_stay_id:a.id,stay_id:transfer.id,house_id:house.id},'occupied');
    const b=await request(residents[1],beds[1],'2026-10-01','2026-12-01','B');await approve(b,'B');await checkin(b,'B');const ended=await call('dormitory','stay.checkout',{id:b.id,ends_at:at('2026-10-20'),execution_ref:marker+'；退宿交接'},'STAY-OUT:'+tag);scene('STAY-CHECKED-OUT-'+tag,'dormitory',residents[1],{stay_id:ended.id,house_id:house.id},'ended');
    const c=await request(residents[2],beds[2],'2026-10-12','2026-12-01','C');await approve(c,'C');await checkin(c,'C');scene('STAY-CURRENT-'+tag,'dormitory',residents[2],{stay_id:c.id,house_id:house.id},'occupied');
    const future=await request(residents[3],beds[3],'2026-11-18','2026-11-20','FUTURE');await approve(future,'FUTURE');scene('STAY-FUTURE-'+tag,'dormitory',residents[3],{stay_id:future.id,house_id:house.id},'approved');
    const pending=await request(residents[3],beds[3],'2026-11-20','2026-12-01','PENDING');scene('STAY-PENDING-'+tag,'dormitory',residents[3],{stay_id:pending.id,house_id:house.id},'pending',actors.reviewer);
    if(n===0){const cancelled=await request(residents[1],beds[1],'2026-11-10','2026-11-12','CANCEL');await call('dormitory','stay.cancel',{id:cancelled.id,reason:marker+'；取消预约'},'STAY-CANCEL:'+tag);scene('STAY-CANCELLED-'+region,'dormitory',residents[1],{stay_id:cancelled.id},'cancelled');const rejected=await request(residents[2],beds[6],'2026-10-05','2026-10-06','REJECT');await call('dormitory','stay.decide',{id:rejected.id,approve:false,decision_ref:marker+'；申请理由待补'},'STAY-REJECT:'+tag,actors.reviewer);scene('STAY-REJECTED-'+region,'dormitory',residents[2],{stay_id:rejected.id},'rejected');}
    const repair=await call('dormitory','repair.report',{employment_id:residents[0].employment_id,bed_id:beds[7].id,source_key:key('REPAIR:'+tag),description:marker+'；空床床板检修',blocks_capacity:true},'REPAIR:'+tag);await call('dormitory','repair.progress',{id:repair.id,state:'completed'},'REPAIR-DONE:'+tag);if(n>0)await call('dormitory','repair.accept',{id:repair.id,acceptance_ref:marker+'；检修验收'},'REPAIR-ACCEPT:'+tag,actors.reviewer);scene('REPAIR-'+tag,'dormitory',residents[0],{repair_id:repair.id,bed_id:beds[7].id},n===0?'completed_pending_acceptance':'accepted',actors.reviewer);
   }
  }
  for(const p of outsourced){const h=houses.find(h=>h.owner.region_code===p.region_code);if(!h)continue;const r=await call('dormitory','stay.request',{employment_id:p.employment_id,bed_id:h.beds[6].id,source_key:key('OUTSOURCE-STAY:'+p.person_number),starts_at:at('2026-11-20'),ends_at:at('2026-12-01')},'OUTSOURCE-STAY:'+p.person_number);scene('OUTSOURCE-STAY-'+p.person_number,'dormitory',p,{stay_id:r.id,house_id:h.house.id,payroll_deduction_created:false},'pending_no_client_payroll_deduction');}
  let syntheticCashConfirmations=0;
  for(const {house,owner,residents,tag}of houses){
   for(const fee of['rent','water','electricity']){
    const amount=owner.region_code==='HK'?{rent:'8800.00',water:'200.50',electricity:'300.60'}[fee]:{rent:'4800.00',water:'120.50',electricity:'212.60'}[fee];
    const bill=await call('dormitory','bill.create',{house_id:house.id,source_key:key('BILL:'+tag+':'+fee),period_from:'2026-10-01',period_to:'2026-11-01',fee_kind:fee,currency:owner.currency_code,amount,source_ref:marker+'；10月源金额，不来自客户账单'},'BILL:'+tag+':'+fee);
    const split=await call('dormitory','bill.allocate-weighted',{id:bill.id,enterprise_residual:'0.00',rows:residents.slice(0,3).map((p,i)=>({employment_id:p.employment_id,parent_key:key('CHARGE:'+tag+':'+fee+':'+p.person_number),weight:['30','19','20'][i],target_cap:'999999.00',legal_ref:marker+'；个人最终可收额核定示例，非客户法律适用结论',payroll_allowed:fee==='rent'&&i===0,payroll_limit:fee==='rent'&&i===0?'50.00':'0.00',wage_guard_ref:fee==='rent'&&i===0?marker+'；此人本期人工核定渠道最多50（仅数学示例，非法定阈值；未采用工资）':null}))},'BILL-SPLIT:'+tag+':'+fee);
    await call('dormitory','bill.decide',{id:bill.id,approve:true,decision_ref:marker+'；独立核准权重、金额和范围'},'BILL-APPROVE:'+tag+':'+fee,actors.reviewer);await call('dormitory','bill.post',{id:bill.id,enterprise_residual:'0.00',execution_ref:marker+'；内部账单发布'},'BILL-POST:'+tag+':'+fee);
    const charges=split.charges;scene('BILL-'+tag+'-'+fee,'dormitory',residents[0],{bill_id:bill.id,house_id:house.id,charge_ids:charges.map(c=>c.id),weights:['30','19','20'],source_amount:amount,currency:owner.currency_code},'posted_reviewed_synthetic_weights');
    if(fee==='rent'){
     const reserve=await call('dormitory','payment.reserve',{id:charges[0].id,source_key:key('PAYROLL-RESERVE:'+tag),method:'payroll',amount:'40.00'},'PAYROLL-RESERVE:'+tag);scene('PAYROLL-RESERVED-'+tag,'dormitory',residents[0],{charge_id:charges[0].id,settlement_id:reserve.id,amount:'40.00',currency:owner.currency_code},'reserved_not_payroll_confirmed');
     const self=await call('dormitory','payment.reserve',{id:charges[1].id,source_key:key('SELF-RESERVE:'+tag),method:'self_payment',amount:'20.00'},'SELF-RESERVE:'+tag);scene('SELF-PAY-PENDING-'+tag,'dormitory',residents[1],{charge_id:charges[1].id,settlement_id:self.id},'reserved_receipt_not_verified');
    }else if(fee==='electricity'){
     const s=await call('dormitory','payment.reserve',{id:charges[0].id,source_key:key('RECONCILE:'+tag),method:'self_payment',amount:'12.00'},'RECONCILE:'+tag);await call('dormitory','payment.unknown',{id:s.id,reason:marker+'；内部人工对账异常示例，没有发送外部支付请求'},'RECONCILE-UNKNOWN:'+tag);
     if(tag.endsWith('-1'))await call('dormitory','payment.release',{id:s.id,receipt_ref:marker+'；内部核定该意图未执行，撤回预占；非银行回执'},'RECONCILE-RELEASE:'+tag);
     scene('PAYMENT-RECONCILE-'+tag,'dormitory',residents[0],{charge_id:charges[0].id,settlement_id:s.id},tag.endsWith('-1')?'released_unexecuted':'unknown_internal_reconciliation');
    }else if(tag.endsWith('-0')){
     // These are fictional INTERNAL cash-ledger exercises only. No external
     // bank/payment-system or payroll-confirmation receipt is manufactured.
     const cash=await call('dormitory','payment.reserve',{id:charges[0].id,source_key:key('INTERNAL-CASH:'+tag),method:'self_payment',amount:'10.00'},'INTERNAL-CASH:'+tag);await call('dormitory','payment.confirm',{id:cash.id,receipt_ref:marker+'；内部现金登记复核凭据；没有真实资金，不是银行回执'},'INTERNAL-CASH-CONFIRM:'+tag,actors.reviewer);syntheticCashConfirmations++;
     await call('dormitory','charge.revise',{id:charges[0].id,expected_revision:1,target:'5.00',reason:marker+'；演示费用本身核减，超收不得挂欠费',decision_ref:marker+'；核定可收目标5，非法定统一数值'},'CHARGE-REDUCE:'+tag,actors.reviewer);
     if(owner.region_code==='HK')await call('dormitory','payment.refund',{id:cash.id,source_key:key('INTERNAL-REFUND:'+tag),amount:'5.00',receipt_ref:marker+'；内部现金退款复核，无实际资金及外部回执'},'INTERNAL-REFUND:'+tag,actors.reviewer);
     scene('CASH-FEE-CORRECTION-'+tag,'dormitory',residents[0],{charge_id:charges[0].id,settlement_id:cash.id,old_target:charges[0].target,new_target:'5.00',cash_ledger_only:true,actual_money_moved:'0.00'},owner.region_code==='HK'?'synthetic_cash_refunded':'synthetic_cash_refund_due');
    }
   }
  }
  for(const region of['CN','HK']){const p=(region==='CN'?cn:hk)[0];const benefit=await call('dormitory','benefit.candidate',{employment_id:p.employment_id,parent_key:key('NONCASH:'+region),revision:1,currency:p.currency_code,target:region==='HK'?'300.00':'200.00',source_ref:marker+'；10月非现金住宿待遇待复核参数，不是税额或现金应付',inclusion_key:key('NONCASH-COST:'+region)},'NONCASH:'+region);scene('NONCASH-'+region,'dormitory',p,{candidate_id:benefit.id,cash_payable:false},'candidate_only_not_cash');}

  const types=new Map(),holdings=[],type=async(company,code,name,ownerKind,requirementKind,term='fixed')=>{
   const k=company.id+':'+code;if(types.has(k))return types.get(k);const tpe=await call('certificates','type.create',{company_id:company.id,code:'PSD-'+code,name,owner_kind:ownerKind,jurisdiction:company.region_code,requirement_kind:requirementKind,term_mode:term,rule_ref:marker+'；'+(requirementKind==='pending'?'须按真实经营场景及法域另核，不代表全部门店/人员必需':'企业岗位配置规则，不宣称通用法定资格'),reminder_days:30},'CERT-TYPE:'+k);types.set(k,tpe);return tpe;
  };
  const requirement=async(tp,p,code)=>call('certificates','requirement.create',{type_id:tp.id,...(p?{employment_id:p.employment_id}:{}),source_key:key('REQUIREMENT:'+code),required_from:'2026-10-01',applicability_ref:marker+'；岗位/经营场景适用范围核定'},'REQUIREMENT:'+code);
  const holdingFor=async(tp,p,code,{from='2026-10-01',to='2027-10-01',term='fixed',verify=true,revision=1,supersedes=null}={})=>{
   const h=await call('certificates','holding.submit',{type_id:tp.id,...(p?{employment_id:p.employment_id}:{}),source_key:key('HOLDING:'+code),revision,...(supersedes?{supersedes_id:supersedes}:{}),issuer:tp.jurisdiction==='HK'?'湾仔员工服务中心':'虹桥员工服务中心',number_text:'TY-CERT-'+code+'-'+revision,valid_from:from,valid_to:term==='fixed'?to:null,term_mode:term,evidence_ref:'行政人事证照登记-'+code,evidence_hash:'REGISTER-REF-'+code+'-'+revision},'HOLDING:'+code+':'+revision);
   if(verify)await call('certificates','holding.verify',{id:h.id,verification_ref:marker+'；仅资料项目已核对，原件及适用资格分别管理'},'HOLDING-VERIFY:'+code+':'+revision,actors.reviewer);return h;
  };
  for(const {house,owner,residents,tag}of houses){
   const storeType=await type(owner,'STORE-LICENSE',owner.region_code==='HK'?'食肆牌照（经营场景适用待核）':'食品经营许可（经营场景适用待核）','company','pending');await requirement(storeType,null,'STORE:'+tag);
   const store=await holdingFor(storeType,null,'STORE:'+tag,{to:tag.endsWith('-0')?'2026-11-25':tag.endsWith('-1')?'2026-10-31':'2027-10-01'});holdings.push({holding:store,company:owner});scene('STORE-LICENSE-'+tag,'certificates',null,{company_id:owner.id,holding_id:store.id,type_id:storeType.id,requirement_kind:'pending'},'verified_fictional_fields_applicability_pending');
   if(tag.endsWith('-2')){const loan=await call('certificates','original.borrow',{id:store.id,borrower_person_id:residents[1].person_id,source_key:key('BORROW-RETURNED:'+tag),borrowed_at:'2026-11-01T09:00:00+08:00',due_at:'2026-11-10T18:00:00+08:00'},'BORROW-RETURNED:'+tag);await call('certificates','original.return',{id:loan.id,returned_at:'2026-11-05T17:00:00+08:00',return_ref:marker+'；原件内部归还交接'},'ORIGINAL-RETURN:'+tag);scene('ORIGINAL-RETURNED-'+tag,'certificates',residents[1],{holding_id:store.id,custody_id:loan.id},'returned_original_history_preserved');}
   if(tag.endsWith('-0')){const renewal=await holdingFor(storeType,null,'STORE:'+tag,{from:'2026-11-25',to:'2027-11-25',revision:2,supersedes:store.id});scene('STORE-RENEWAL-'+tag,'certificates',null,{company_id:owner.id,old_holding_id:store.id,holding_id:renewal.id},'future_renewal_original_risk_retained');const borrow=await call('certificates','original.borrow',{id:store.id,borrower_person_id:residents[0].person_id,source_key:key('BORROW:'+tag),borrowed_at:'2026-11-16T09:00:00+08:00',due_at:'2026-11-20T18:00:00+08:00'},'BORROW:'+tag);scene('ORIGINAL-BORROW-'+tag,'certificates',residents[0],{holding_id:store.id,custody_id:borrow.id},'borrowed_fictional_original');}
   if(owner.region_code==='HK'&&tag.endsWith('-2')){const liquor=await type(owner,'LIQUOR-SCENE','酒牌（仅具体售酒场景待核）','company','pending','unknown');await requirement(liquor,null,'LIQUOR:'+tag);const h=await holdingFor(liquor,null,'LIQUOR:'+tag,{term:'unknown',verify:false});scene('HK-LIQUOR-APPLICABILITY','certificates',null,{company_id:owner.id,holding_id:h.id,type_id:liquor.id},'pending_not_universal_requirement');}
   for(let n=0;n<residents.length;n++){
    const p=residents[n],company=companies.find(c=>same(c.id,p.company_id));if(!company)fail('现有人员公司不在门店范围');
    const skill=await type(company,'SKILL','岗位技能培训证明（企业要求）','person','enterprise');await requirement(skill,p,'SKILL:'+p.person_number);const h=await holdingFor(skill,p,'SKILL:'+p.person_number,{to:n===0?'2026-11-25':n===1?'2026-10-31':'2027-10-01'});holdings.push({holding:h,p,company,type:skill});scene('PERSON-SKILL-'+p.person_number,'certificates',p,{holding_id:h.id,type_id:skill.id},n===0?'verified_expiring':n===1?'verified_but_expired':'verified_current');
    if(n===0){const renew=await holdingFor(skill,p,'SKILL:'+p.person_number,{from:'2026-11-25',to:'2027-11-25',revision:2,supersedes:h.id});scene('PERSON-RENEWAL-'+p.person_number,'certificates',p,{old_holding_id:h.id,holding_id:renew.id},'future_verified_renewal');}
    if(n===2){const health=await type(company,'HEALTH',p.region_code==='HK'?'健康情况文件（企业要求示例，非内地年度健康证）':'健康证明（岗位及法定适用待核）','person',p.region_code==='HK'?'enterprise':'pending','unknown');await requirement(health,p,'HEALTH:'+p.person_number);const healthHolding=await holdingFor(health,p,'HEALTH:'+p.person_number,{term:'unknown',verify:false});scene('PERSON-HEALTH-'+p.person_number,'certificates',p,{holding_id:healthHolding.id,type_id:health.id,medical_diagnosis_collected:false},'pending_unknown_term_no_universal_annual_rule');}
   }
  }
  const multi=await one(t,`SELECT p.id person_id,p.person_number,p.full_name FROM ty_person p WHERE p.group_id=$1 AND(SELECT count(*)FROM ty_employment e WHERE e.person_id=p.id AND e.status='active')>1 ORDER BY p.id LIMIT 1`,[group.id]);
  if(multi){const es=await q(t,"SELECT e.* FROM ty_employment e WHERE e.person_id=$1 AND e.status='active'ORDER BY e.hire_date,e.id",[multi.person_id]);const source=holdings.find(x=>x.p&&same(x.p.person_id,multi.person_id));if(source){const target=es.find(e=>!same(e.id,source.p.employment_id)),company=companies.find(c=>same(c.id,target?.company_id));if(target&&company){const tp=await type(company,'SKILL','岗位技能培训证明（企业要求）','person','enterprise'),req=await requirement(tp,{employment_id:target.id},'CROSS-STORE:'+multi.person_number);const recognized=await call('certificates','requirement.recognize',{id:req.id,holding_id:source.holding.id,source_key:key('RECOGNIZE:'+multi.person_number),valid_from:maxDate(date(target.hire_date),'2026-10-01'),valid_to:date(source.holding.valid_to),verification_ref:marker+'；目标岗位独立认可同一人员原证据，不复制证件'},'RECOGNIZE:'+multi.person_number,actors.reviewer);scene('CROSS-STORE-RECOGNITION','certificates',{...source.p,employment_id:target.id,company_id:target.company_id},{recognition_id:recognized.id,source_holding_id:source.holding.id,requirement_id:req.id},'same_evidence_separate_employment_recognition');}}}

  for(const company of companies){
   const members=[...people,...outsourced].filter(p=>same(p.company_id,company.id));if(!members.length)continue;
   const purpose=await call('goods','purpose.create',{company_id:company.id,code:'PSD-UNIFORM',name:'工作服与岗位用品'},'PURPOSE-UNIFORM:'+company.id),welfare=await call('goods','purpose.create',{company_id:company.id,code:'PSD-WELFARE',name:'员工福利用途'},'PURPOSE-WELFARE:'+company.id);
   const item=await call('goods','item.create',{company_id:company.id,code:'PSD-UNIFORM',name:'餐饮工作服套装',specification:'M/L/XL可选',unit:'套',location:'员工用品柜'},'ITEM:'+company.id);
   const doc=async(kind,quantity,suffix,extra={})=>call('goods','document.submit',{item_id:item.id,source_key:key('GOODS:'+company.id+':'+suffix),kind,quantity,occurred_on:'2026-10-15',reason:marker+'；用品办理',...extra},'GOODS:'+company.id+':'+suffix);
   const approve=async(d,suffix,yes=true)=>call('goods','document.decide',{id:d.id,approve:yes,decision_ref:marker+'；内部独立核准'},'GOODS-APPROVE:'+company.id+':'+suffix,actors.reviewer);
   const post=async(d,suffix)=>call('goods','document.post',{id:d.id,execution_ref:marker+'；实物交接，不是付款凭据'},'GOODS-POST:'+company.id+':'+suffix);
   const receipt=await doc('receipt','20','RECEIPT',{currency:company.currency_code,auxiliary_amount:company.region_code==='HK'?'1200.00':'800.00',cost_inclusion_key:key('GOODS-COST:'+company.id)});await approve(receipt,'RECEIPT');await post(receipt,'RECEIPT');
   let firstIssue;
   for(let n=0;n<members.length;n++){const p=members[n],issue=await doc('issue',n===0?'2':'1','ISSUE:'+p.person_number,{employment_id:p.employment_id,occurred_on:maxDate('2026-10-15',date(p.hire_date)),purpose_id:n%2?welfare.id:purpose.id,currency:company.currency_code,auxiliary_amount:company.region_code==='HK'?(n===0?'120.00':'60.00'):(n===0?'80.00':'40.00'),cost_inclusion_key:key('GOODS-COST:'+company.id)});await approve(issue,'ISSUE:'+p.person_number);await post(issue,'ISSUE:'+p.person_number);firstIssue||={issue,p};scene('GOODS-ISSUE-'+p.person_number,'goods',p,{doc_id:issue.id,item_id:item.id,purpose_id:n%2?welfare.id:purpose.id},'posted_personal_history');}
   const ret=await doc('return','1','RETURN',{employment_id:firstIssue.p.employment_id,related_doc_id:firstIssue.issue.id,occurred_on:'2026-10-25',reason:marker+'；关联原领用退回一套'});await approve(ret,'RETURN');await post(ret,'RETURN');scene('GOODS-RETURN-'+company.code,'goods',firstIssue.p,{doc_id:ret.id,original_doc_id:firstIssue.issue.id,item_id:item.id},'posted_original_preserved');
   const empty=await call('goods','item.create',{company_id:company.id,code:'PSD-TRAINING-GIFT',name:'培训纪念礼包',specification:'保温杯与学习手册套装',unit:'份',location:'待采购'},'EMPTY-ITEM:'+company.id);const shortage=await call('goods','document.submit',{item_id:empty.id,purpose_id:welfare.id,employment_id:members[0].employment_id,source_key:key('SHORTAGE:'+company.id),kind:'issue',quantity:'1',occurred_on:'2026-10-28',reason:marker+'；库存为0，待采购后实际办理，未伪造出库'},'SHORTAGE:'+company.id);if(Number(company.id)%2===0)await approve(shortage,'SHORTAGE');scene('GOODS-SHORTAGE-'+company.code,'goods',members[0],{doc_id:shortage.id,item_id:empty.id},Number(company.id)%2===0?'approved_waiting_stock':'pending_no_stock');
   if(houses.some(h=>same(h.owner.id,company.id))){const rejected=await doc('issue','1','REJECTED',{employment_id:members[0].employment_id,purpose_id:purpose.id});await approve(rejected,'REJECTED',false);scene('GOODS-REJECTED-'+company.code,'goods',members[0],{doc_id:rejected.id},'rejected_no_stock_movement');}
  }
  const index={version:VERSION,complete:true,synthetic:true,all_facts_fictional:true,group_id:group.id,base_period:'2026-10',observation_date:'2026-11-17',existing_person_count:size.people,existing_account_count:size.accounts,created_people:0,created_accounts:0,changed_passwords:0,external_receipts:0,payroll_confirmations:0,synthetic_internal_cash_confirmations:syntheticCashConfirmations,actual_money_moved:'0.00',roles:Object.fromEntries(Object.entries(actors).map(([k,a])=>[k,actorIndex(a)])),people:[...people,...outsourced].map(p=>({...p,synthetic_only:true})),scenes,warnings,counts_before:before,counts_after:await counts(t,group.id)};
  index.created_counts=Object.fromEntries(Object.keys(index.counts_after).map(k=>[k,index.counts_after[k]-before[k]]));
  await t.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,after_data)VALUES($1,'seed','people_services_demo',$2,$3::jsonb)",[actors.manager.id,group.id,JSON.stringify(index)]);return{...index,replayed:false};
 });
}
async function main(){
 if(!process.argv.includes('--confirm-synthetic'))fail('必须显式 --confirm-synthetic');if(process.env.CONTROL_URL)fail('拒绝CONTROL_URL；仅用于专用演示副本');if(!!process.env.DATABASE_URL===!!process.env.PGLITE_DATA_DIR)fail('必须且只能指定一个持久DATABASE_URL或PGLITE_DATA_DIR，拒绝默认内存库');
 if(process.env.DATABASE_URL&&decodeURIComponent(new URL(process.env.DATABASE_URL).pathname).replace(/^\//,'')==='tyhr_tianyi_test')fail('禁止连接原演示源库；只使用经授权复制的专用演示副本');
 const arg=process.argv.indexOf('--out');if(arg>=0&&(!process.argv[arg+1]||process.argv[arg+1].startsWith('--')))fail('--out须跟明确的场景索引文件');const db=await createDb({url:process.env.DATABASE_URL||undefined,dataDir:process.env.PGLITE_DATA_DIR||undefined});
 try{const result=await seedPeopleServicesDemo(db,{confirmSynthetic:true}),file=resolve(arg>=0?process.argv[arg+1]:resolve(process.env.TYHR_RUNTIME_DIR||'../.runtime','people-services-demo-scenes.json'));await mkdir(resolve(file,'..'),{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify(result,null,2)+'\n',{mode:0o600});await chmod(file+'.tmp',0o600);await rename(file+'.tmp',file);await chmod(file,0o600);console.log(JSON.stringify({version:VERSION,replayed:result.replayed,created:result.created_counts,scenes:result.scenes.length,people:result.existing_person_count,accounts:result.existing_account_count,passwords_changed:0,external_receipts:0,payroll_confirmations:0,scene_index:file}));}finally{await db.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(e=>{console.error(String(e.message).replace(/postgres(?:ql)?:\/\/\S+/gi,'[已隐藏数据库连接]'));process.exitCode=1;});
