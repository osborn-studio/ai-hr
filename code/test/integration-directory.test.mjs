import test from'node:test';import assert from'node:assert/strict';import{createServer}from'node:http';
import{normalizeDirectory,pullDirectory}from'../app/services/integration-providers.mjs';
test('DingTalk direct-child response preserves original department and parent identities',()=>{
 const rows=normalizeDirectory('dingtalk',{result:[{dept_id:'9007199254740993',parent_id:1,name:'门店营运部'}]},{entityKind:'department'});
 assert.equal(rows[0].external_id,'9007199254740993');assert.equal(rows[0].normalized.parent_external_id,'1');assert.equal(rows[0].event_kind,'directory_department');assert.equal(rows[0].raw.dept_id,'9007199254740993');
 assert.throws(()=>normalizeDirectory('dingtalk',{result:[{dept_id:9007199254740992,name:'精度已丢失'}]},{entityKind:'department'}));
});
test('actual HTTP direct-child call has its own body and no invented full-tree or termination claim',async()=>{
 const calls=[],server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const url=new URL(req.url,'http://fixture');calls.push({path:url.pathname,body:raw?JSON.parse(raw):null});res.setHeader('content-type','application/json');res.end(JSON.stringify(url.pathname==='/gettoken'?{errcode:0,access_token:'test-ephemeral'}:{errcode:0,result:[{dept_id:7,parent_id:1,name:'香港门店营运部'}]}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const origin='http://127.0.0.1:'+server.address().port,fetchImpl=(url,init)=>{const target=new URL(url);return fetch(origin+target.pathname+target.search,init);},args={connection:{provider:'dingtalk',config:{app_id:'test-app'}},profile:{application_type:'internal',settings:{}},credentials:{app_id:'test-app',app_secret:'not-an-actual-key'},request:{entity_kind:'department',department_id:'1'},fetchImpl,networkMode:'fixture'},out=await pullDirectory(args);
  assert.deepEqual(calls[1],{path:'/topapi/v2/department/listsub',body:{dept_id:'1',language:'zh_CN'}});assert.equal(out.events[0].normalized.name,'香港门店营运部');assert.equal(out.next_cursor,null);assert.equal(out.coverage.directory_scope,'requested_direct_children');assert.equal(out.coverage.absence_is_termination,false);assert.ok(!JSON.stringify(out).includes('test-ephemeral'));
  const before=calls.length;await assert.rejects(()=>pullDirectory({...args,request:{...args.request,cursor:'2'}}));await assert.rejects(()=>pullDirectory({...args,request:{...args.request,entity_kind:'all'}}));assert.equal(calls.length,before);
 }finally{await new Promise(r=>server.close(r));}
});
