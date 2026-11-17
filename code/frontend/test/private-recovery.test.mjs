import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createPrivateCommandJournal,createMigratingPrivateCommandJournal} from '../src/private-commands.mjs';
const storage=()=>{const m=new Map();return{getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v),all:()=>[...m.values()].join('')};};
test('a committed original operation can be checked after reload without sending its private material again',async()=>{
 const s=storage(),requests=[],body={answers:[{question_id:1,value:'fictional-private-answer'}],expected_revision:4};
 const api={request:async(path,args)=>{requests.push({path,...args});if(path.includes('/command/'))throw new Error('lost response');return{operation:args.body.operation,operation_id:args.body.operation_id,status:'completed',business_effect_verified:false};}};
 const first=createPrivateCommandJournal({api,userId:1,namespace:'exam',storage:s,cryptoImpl:webcrypto,uuid:()=> 'private-original-uuid'});
 await assert.rejects(()=>first.execute('learning.answer.save',body));assert.ok(!s.all().includes('fictional-private-answer'));
 const reloaded=createPrivateCommandJournal({api,userId:1,namespace:'exam',storage:s,cryptoImpl:webcrypto});
 const r=await reloaded.reconcile('private-original-uuid');assert.equal(r.confirmed,true);assert.equal(r.business_effect_verified,false);assert.equal(reloaded.pending().length,0);
 assert.equal(requests.filter(x=>x.path.includes('/command/')).length,1);assert.deepEqual(requests.at(-1).body,{operation:'learning.answer.save',operation_id:'private-original-uuid'});
});
test('unknown or mismatched status never discards the original ID',async()=>{
 const s=storage();let status='unknown';const api={request:async(path,args)=>{if(path.includes('/command/'))throw new Error('timeout');return{operation:args.body.operation,operation_id:status==='mismatch'?'wrong':args.body.operation_id,status:status==='mismatch'?'completed':status};}};
 const journal=createPrivateCommandJournal({api,userId:2,namespace:'form',storage:s,cryptoImpl:webcrypto,uuid:()=> 'unknown-original-uuid'});
 await assert.rejects(()=>journal.execute('system.instance.submit',{values:{medical:'fictional-sensitive-detail'}}));
 assert.equal((await journal.reconcile('unknown-original-uuid')).confirmed,false);assert.equal(journal.pending()[0].id,'unknown-original-uuid');
 status='mismatch';await assert.rejects(()=>journal.reconcile('unknown-original-uuid'),/不匹配/);assert.equal(journal.pending()[0].id,'unknown-original-uuid');
});
test('upgrading an old personal-form journal preserves its ID and removes both plaintext body and old plaintext fingerprint',async()=>{
 const s=storage(),body={form_id:4,values:{medical:'fictional-private-material'}};s.setItem('tyhr.pending.commands.3',JSON.stringify([{id:'legacy-original-id',operation:'system.instance.submit',input:body,fingerprint:JSON.stringify(body),outcome:'unknown',hadUnknown:true}]));
 const requests=[],api={request:async(path,args)=>{requests.push(args);return{accepted:true};}};
 const journal=createMigratingPrivateCommandJournal({api,userId:3,namespace:'portal',legacyPrefix:'system.instance.',storage:s,cryptoImpl:webcrypto});await journal.ready;
 assert.ok(!s.all().includes('fictional-private-material'));assert.equal(journal.pending()[0].id,'legacy-original-id');assert.equal(journal.pending()[0].canRetry,false);
 await journal.execute('system.instance.submit',body);assert.equal(requests[0].headers['Idempotency-Key'],'legacy-original-id');
});
