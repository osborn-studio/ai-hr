import test from'node:test';import assert from'node:assert/strict';
import{currentLeaveRequestFields,leaveSourceMinutes,timeLeaveSourceInput,timeLeaveSourceRows,leaveRequestStateLabels,timeLeaveClassLabels}from'../src/components/roster/time-leave-source-model.mjs';
test('daily source uses exact report and line without client scope expansion',()=>{
 assert.deepEqual(timeLeaveSourceInput({report_id:7,id:9,employment_id:4,work_date:'2026-10-31',group_id:1,company_id:999},{id:8},true),{report_id:'7',line_id:'9',work_date:'2026-10-31',self:true});
});
test('monthly aggregate narrows to employment and does not invent a line',()=>{
 assert.deepEqual(timeLeaveSourceInput({employment_id:4},{id:8}),{report_id:'8',employment_id:'4'});
});
test('original baseline or missing line identity cannot issue broad source query',()=>{
 assert.equal(timeLeaveSourceInput({id:9}),null);assert.equal(timeLeaveSourceInput({},{id:8}),null);
});
test('unknown minutes are distinct from an actual zero',()=>{
 assert.equal(leaveSourceMinutes(null),'待核分钟');assert.equal(leaveSourceMinutes(undefined),'待核分钟');assert.equal(leaveSourceMinutes(0),'0 分钟');assert.equal(leaveSourceMinutes(-1),'待核分钟');
});
test('request detail exposes only current safe display fields',()=>{
 const rows=currentLeaveRequestFields({id:9,status:'taken',quantity:'0.5',unit:'day',facts:{diagnosis:'不应显示'},evidence_ref:'秘密原件',medical_file_id:18,salary:8000,approved_by:77,account_id:2});
 assert.deepEqual(rows.map(x=>x.key),['id','status','quantity']);assert.equal(rows[2].value,'0.5 天');assert.doesNotMatch(JSON.stringify(rows),/秘密|诊断|不应显示|8000/);
});
test('unreturned unit is never inferred as an eight-hour day',()=>{
 assert.equal(currentLeaveRequestFields({quantity:'30'})[0].value,'30');assert.deepEqual(currentLeaveRequestFields(null),[]);
});
test('approved status never presents as actual taken',()=>{
 assert.equal(timeLeaveClassLabels.mixed,'分段分类');assert.equal(leaveRequestStateLabels.approved,'已批准，未核定已休');assert.equal(leaveRequestStateLabels.taken,'已核定实际已休');
});
test('empty or restricted source rows preserve absence without making a fact',()=>{
 assert.deepEqual(timeLeaveSourceRows(null),[]);assert.deepEqual(timeLeaveSourceRows({rows:[{line_id:1,sources:[]}]}),[]);const rows=timeLeaveSourceRows({rows:[{line_id:1,restricted:true,sources:[]}]});assert.equal(rows.length,1);assert.equal(rows[0].source,null);assert.equal(rows[0].row.restricted,true);
});
