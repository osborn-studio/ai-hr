import assert from'node:assert/strict';
import{resolve}from'node:path';
import{mkdtempSync,rmSync}from'node:fs';
import{build}from'vite';
const base=resolve(import.meta.dirname,'..'),output=mkdtempSync(resolve(base,'.lifecycle-target-'));
try{
await build({root:resolve(base,'frontend'),configFile:false,build:{lib:{entry:resolve(base,'frontend/src/components/integration/LifecycleReminderTarget.jsx'),formats:['es'],fileName:()=> 'target.mjs'},outDir:output,emptyOutDir:true,rollupOptions:{external:['react','react-dom']}}});
const{reminderSourceDisplay:display}=await import(resolve(output,'target.mjs'));let passed=0;const check=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
check('contract projection never displays salary private text or unknown attributes',()=>{const r=display({code:'LD-12',title:'门店服务岗位劳动合同',salary:'18000',content:'隐私正文',raw:'未授权内容',status:'signed'},'contract_expiry','Asia/Shanghai');assert.deepEqual(r.map(v=>v.key),['code','title','status']);assert.equal(r.at(-1).value,'已签署');});
check('legal subject name takes precedence over id without fabricating omitted values',()=>assert.deepEqual(display({legal_subject_name:'香香鱼米静安店',legal_entity_company_id:5300},'contract_expiry').map(v=>v.key),['legal_subject_name']));
check('certificate number accepts only explicitly masked value',()=>{const r=display({issuer:'静安健康服务中心',number_masked:'CN-****-5302',number_text:'CN-HEALTH-5302',document_number:'secret'},'certificate_expiry');assert.deepEqual(r.map(v=>v.key),['issuer','number_masked']);});
check('unknown and unauthorized source shapes do not expose their keys',()=>{assert.deepEqual(display({salary:9000,content:{secret:1}},'unknown'),[]);assert.deepEqual(display(null,'certificate_expiry'),[]);});
check('absent source values remain omitted rather than being labelled missing',()=>assert.deepEqual(display({title:undefined,code:null,starts_on:'',ends_on:'2026-11-24'},'contract_expiry').map(v=>v.key),['ends_on']));
check('stay projection distinguishes exact timestamps and discards unrelated rent and room records',()=>{const r=display({house_name:'静安员工公寓',starts_at:'2026-11-17T00:00:00Z',rent:700,occupants:[{name:'另一员工'}]},'dorm_stay_expiry','Asia/Hong_Kong');assert.deepEqual(r.map(v=>v.key),['house_name','starts_at']);assert.ok(r[1].value.includes('08:00'));});
check('lease date projection includes lawful evidence and excludes payment details',()=>assert.deepEqual(display({house_name:'尖沙咀员工公寓',starts_on:'2026-11-01',ends_on:'2027-10-31',status:'withdrawn',version:2,evidence_ref:'日期核对表',bank:'secret'},'dorm_lease_expiry').map(v=>v.key),['house_name','starts_on','ends_on','status','version','evidence_ref']));
check('occupied and ended original stay states remain explicit',()=>{assert.equal(display({state:'occupied'},'dorm_stay_expiry')[0].value,'实际在住');assert.equal(display({state:'ended'},'dorm_stay_expiry')[0].value,'已结束');});
console.log(JSON.stringify({suite:'lifecycle-reminder-ui-model236',passed}));

}finally{rmSync(output,{recursive:true,force:true});}
