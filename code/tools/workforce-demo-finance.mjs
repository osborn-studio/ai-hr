// Internal demonstration only. Unknown payments remain held, without bank success evidence.
export async function addServiceFinanceScene(t,{run,w,bill,profile,reviewer,portal,index,scene}){
 if(index>1)return null;
 if(index===1){
  await run('bill.confirm',{id:bill.id,expected_revision:bill.revision+2,accept:false,vendor_ref:'请核对收尾服务是否在原价目覆盖范围，当前暂不确认'},portal);
  scene('BILL-DISPUTE-'+w.region_code,w,{bill_id:bill.id},'供应商提出计价差异，当前未形成新应付或实际付款',portal.login);
  return '供应商对收尾服务计价提出差异，账单保持争议；没有付款';
 }
 await run('bill.confirm',{id:bill.id,expected_revision:bill.revision+2,accept:true,vendor_ref:'已核对本门店已核服务班次与价目'},portal);
 await run('bill.post',{id:bill.id,expected_revision:bill.revision+3,reason:'双方对账后按当前累计目标登记应付'},reviewer);
 const ap=(await t.query('SELECT p.* FROM ty_wf_payable p JOIN ty_wf_bill_root r ON r.id=p.root_id WHERE r.current_version_id=$1',[bill.id])).rows[0];
 const line=(await t.query('SELECT id FROM ty_wf_bill_line WHERE version_id=$1',[bill.id])).rows[0];
 const payment=await run('payment.create',{payable_id:ap.id,bank_profile_id:profile.id,allocations:[{bill_line_id:line.id,amount:'50.00'}],evidence_ref:'演示帐套服务付款申请；未向银行发送'});
 await run('payment.review',{id:payment.id,expected_revision:1,approve:true,review_ref:'核对服务应付、收款版本与本次付款用途'},reviewer);
 await run('payment.export',{id:payment.id,expected_revision:2,reason:'演示帐套生成付款底稿，不向银行发送'});
 await run('payment.result',{id:payment.id,expected_revision:3,state:'unknown',provider_namespace:'DEMO-LOCAL-NO-BANK',source_key:'NOV-SERVICE-UNKNOWN-'+w.person_number,evidence_ref:'内部演示场景，保留未知占款；未获银行成功或未执行证据'});
 scene('PAYMENT-UNKNOWN-'+w.region_code,w,{payable_id:ap.id,payment_id:payment.id,amount:'50.00',currency:w.currency_code,employee_paid:false},'结果未知保留占款；剩余可付与目标分别展示');
 return '供应商已确认并形成应付；本次50元付款结果未知，保持占款，未记实付';
}
