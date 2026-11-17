// Only salted hashes and operation metadata survive reload. Personal details,
// salary configuration and uploaded originals stay in memory for this page.
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export function createPrivateCommandJournal({api,userId,namespace='business',storage,cryptoImpl=globalThis.crypto,uuid=()=>cryptoImpl.randomUUID()}){
 if(storage===undefined){try{storage=globalThis.sessionStorage;}catch{storage=null;}}const key='tyhr.private.commands.'+userId+'.'+namespace,inputs=new Map();let records=[];
 try{const parsed=JSON.parse(storage?.getItem(key)||'[]');if(Array.isArray(parsed))records=parsed.filter(r=>r&&typeof r.id==='string'&&typeof r.operation==='string'&&typeof r.fingerprint==='string').map(({id,operation,fingerprint,createdAt,outcome,hadUnknown})=>({id,operation,fingerprint,createdAt,outcome,hadUnknown:!!hadUnknown}));}catch{}
 const save=()=>{if(!storage)throw new Error('无法保留原操作号，本次未发送资料');storage.setItem(key,JSON.stringify(records));};
 const fingerprint=async(id,operation,body)=>{if(!cryptoImpl?.subtle)throw new Error('当前浏览器连接不支持受控资料操作，请通过本机入口或HTTPS访问');return Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(id+':'+operation+':'+body))),v=>v.toString(16).padStart(2,'0')).join('');};
 const send=async r=>{const body=inputs.get(r.id);if(!body)throw Object.assign(new Error('原资料未保存在浏览器中；请重新选择同一原件或填写同样内容，系统将沿用原操作号'),{operationId:r.id});try{const result=await api.request('/api/v2/command/'+encodeURIComponent(r.operation),{method:'POST',body:JSON.parse(body),headers:{'Idempotency-Key':r.id}});const before=records;records=records.filter(x=>x.id!==r.id);let cleanupPending=false;try{save();inputs.delete(r.id);}catch{records=before;r.outcome='completed';cleanupPending=true;}return{result,operationId:r.id,...(cleanupPending?{metadata_cleanup_pending:true}:{})};}catch(error){const rejected=error.status&&error.status<500;r.hadUnknown=r.hadUnknown||r.outcome==='unknown'||!rejected;r.outcome=r.hadUnknown?'unknown':'rejected';save();error.operationId=r.id;throw error;}};
 return{pending:()=>records.map(r=>({...r,canRetry:inputs.has(r.id)})),async execute(operation,input){const body=JSON.stringify(canonical(input)),existing=records.find(r=>r.operation===operation);if(existing){if(await fingerprint(existing.id,operation,body)!==existing.fingerprint)throw Object.assign(new Error('同类操作仍待核对，请保留原内容处理，不能另建一次'),{operationId:existing.id});inputs.set(existing.id,body);return send(existing);}const id=uuid(),r={id,operation,fingerprint:await fingerprint(id,operation,body),createdAt:new Date().toISOString(),outcome:'pending',hadUnknown:false};records.push(r);try{save();}catch{records=records.filter(x=>x.id!==id);throw new Error('无法保留原操作号，本次未发送资料');}inputs.set(id,body);return send(r);},async retry(id){const r=records.find(x=>x.id===id);if(!r)throw new Error('没有待核的原操作');return send(r);},async reconcile(id){const r=records.find(x=>x.id===id);if(!r)throw new Error('没有待核的原操作');const status=await api.request('/api/v2/query/system.command.status',{method:'POST',body:{operation:r.operation,operation_id:r.id}});if(status.operation!==r.operation||status.operation_id!==r.id)throw new Error('原操作核查回执不匹配，保留原号');if(status.status!=='completed')return{confirmed:false,status:'unknown',operationId:r.id};const before=records;records=records.filter(x=>x.id!==id);try{save();}catch(e){records=before;r.outcome='completed';throw e;}inputs.delete(id);return{confirmed:true,status:'completed',operationId:id,business_effect_verified:false};},discardRejected(id){const r=records.find(x=>x.id===id);if(r?.outcome!=='rejected'||r.hadUnknown)throw new Error('原结果曾经未知，不能按后续拒绝认定从未执行');records=records.filter(x=>x.id!==id);inputs.delete(id);save();}};
}

// Upgrade only the selected business family; preserve every original ID and
// unresolved outcome while removing legacy plaintext request material.
export function createMigratingPrivateCommandJournal(options){
 const {api,userId,namespace,legacyPrefix,cryptoImpl=globalThis.crypto}=options;let storage=options.storage;
 if(storage===undefined){try{storage=globalThis.sessionStorage;}catch{storage=null;}}
 let journal;const ready=(async()=>{
  const oldKey='tyhr.pending.commands.'+userId,newKey='tyhr.private.commands.'+userId+'.'+namespace;
  const legacy=JSON.parse(storage?.getItem(oldKey)||'[]');if(!Array.isArray(legacy))throw new Error('原待核操作记录无效，请先核查');
  const selected=legacy.filter(r=>typeof r?.operation==='string'&&r.operation.startsWith(legacyPrefix));
  if(selected.length){if(!storage||!cryptoImpl?.subtle)throw new Error('当前环境无法安全保留原操作，请通过本机或HTTPS访问');
   const metadata=JSON.parse(storage.getItem(newKey)||'[]');if(!Array.isArray(metadata))throw new Error('原操作元数据无效');
   for(const r of selected){if(typeof r.id!=='string'||!r.input||typeof r.input!=='object')throw new Error('原操作资料不完整，不能丢弃原号');
    const body=JSON.stringify(canonical(r.input)),fingerprint=Array.from(new Uint8Array(await cryptoImpl.subtle.digest('SHA-256',new TextEncoder().encode(r.id+':'+r.operation+':'+body))),v=>v.toString(16).padStart(2,'0')).join('');
    const existing=metadata.find(x=>x.id===r.id);if(existing){if(existing.operation!==r.operation||existing.fingerprint!==fingerprint)throw new Error('原操作的元数据不一致，请先核查');continue;}
    metadata.push({id:r.id,operation:r.operation,fingerprint,createdAt:r.createdAt,outcome:r.outcome||'unknown',hadUnknown:r.hadUnknown||r.outcome!=='rejected'});
   }
   storage.setItem(newKey,JSON.stringify(metadata));storage.setItem(oldKey,JSON.stringify(legacy.filter(r=>!selected.includes(r))));
  }
  journal=createPrivateCommandJournal({...options,storage});return journal;
 })();ready.catch(()=>{});
 return{ready,pending:()=>journal?.pending()||[],execute:async(...a)=>(await ready).execute(...a),retry:async(...a)=>(await ready).retry(...a),reconcile:async(...a)=>(await ready).reconcile(...a),discardRejected:(...a)=>{if(!journal)throw new Error('原操作元数据正在核查');return journal.discardRejected(...a);}};
}
