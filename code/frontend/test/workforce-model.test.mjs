import test from'node:test';import assert from'node:assert/strict';
import{workforceInput,newWorkforceValues}from'../src/workforce-model.mjs';
test('service allocations and fees keep exact decimals and large identifiers',()=>{
 const x=workforceInput('payment.create',{payable_id:'9007199254740993',bank_profile_id:'9007199254740995',allocations:[{bill_line_id:'9007199254740997',amount:'123456789012345.67',__selected:{bank:'private'}}],evidence_ref:'已核对原付款用途'});
 assert.equal(x.payable_id,'9007199254740993');assert.equal(x.allocations[0].amount,'123456789012345.67');assert.equal(x.allocations[0].bill_line_id,'9007199254740997');assert.ok(!JSON.stringify(x).includes('private'));
});
test('monthly native source does not submit stale external delivery or an invented zero',()=>{
 const x=workforceInput('acceptance.create',{engagement_id:'12',source_kind:'native_time',source_root_id:'17',through_date:'2026-10-31',work_date:'2026-10-01',metric:'service_days',unit:'day',service_key:'old-file',allocations:[]});
 assert.equal(x.source_root_id,'17');assert.ok(!('metric'in x));assert.ok(!('accepted_quantity'in x));assert.ok(!('work_date'in x));
});
test('independent review preserves revision and explicit false with no copied bank details',()=>{
 const v=newWorkforceValues('profile.review',{id:'80',revision:2,bank:{account_number:'should-not-copy'},amount:'99'},{});v.approve='false';v.review_ref='收款户名与合同主体不一致';const x=workforceInput('profile.review',v);
 assert.equal(x.approve,false);assert.equal(x.expected_revision,2);assert.deepEqual(Object.keys(x).sort(),['approve','expected_revision','id','review_ref']);assert.throws(()=>workforceInput('profile.review',{id:'80',approve:true}),/当前版本/);
});
test('file input uses original bytes metadata and a namespace owner without retaining File objects',()=>{
 const x=workforceInput('file.upload',{owner_kind:'vendor_profile',owner_id:'18',content_base64:{file:{name:'收款确认.txt',type:'text/plain'},content:'b3JpZ2luYWw='},visibility:'internal'});
 assert.equal(x.content_base64,'b3JpZ2luYWw=');assert.equal(x.filename,'收款确认.txt');assert.equal(x.mime,'text/plain');assert.ok(!('file'in x));
});
test('changing service source retains a right-open period and monthly date is explicit',()=>{
 const x=workforceInput('instruction.create',{mandate_id:'12',period:'2026-10',pay_subject_key:'PAY-HK-1',currency:'HKD',amount:'0.10',evidence_ref:'已核净工资'});
 assert.equal(x.period,'2026-10-01');assert.equal(x.amount,'0.10');const r=workforceInput('personal_receipt.create',{occurred_at:'2026-11-17T16:30'});assert.equal(r.occurred_at,'2026-11-17T16:30:00+08:00');
});
