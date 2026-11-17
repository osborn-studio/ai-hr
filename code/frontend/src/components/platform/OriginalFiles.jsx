import React,{useEffect,useRef,useState}from'react';
import{Button,Notice}from'../UI.jsx';
import{saveBase64}from'../BusinessShared.jsx';

const MIME={pdf:'application/pdf',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',txt:'text/plain',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const fileBody=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('文件读取失败，请重新选择原件'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});

export function OriginalList({api,refs=[],onRemove,disabled=false}){
 const[rows,setRows]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),key=JSON.stringify(refs);
 useEffect(()=>{let active=true;setRows([]);setError('');if(!refs.length||!api)return()=>{active=false;};Promise.all(refs.map(file_ref=>api.request('/api/v2/query/system.file.read',{method:'POST',body:{file_ref}}))).then(r=>{if(active)setRows(r);},e=>{if(active)setError(e.message);});return()=>{active=false;};},[api,key]);
 const download=async file_ref=>{setBusy(true);setError('');try{saveBase64(await api.request('/api/v2/query/system.file.read',{method:'POST',body:{file_ref,download:true}}));}catch(e){setRows([]);setError(e.message);}finally{setBusy(false);}};
 return<div className="original-files">{refs.length===0?<small>尚未添加原件</small>:rows.length===0&&!error?<small>正在核验原件权限…</small>:rows.map(r=><div className="pending-command" key={r.file_ref}><div><b>{r.filename}</b><small>{Math.ceil(r.byte_length/1024)} KB · SHA256 {r.sha256.slice(0,12)}…</small></div><Button disabled={disabled||busy} onClick={()=>download(r.file_ref)}>下载原件</Button>{onRemove&&<Button disabled={disabled||busy} onClick={()=>onRemove(r.file_ref)}>移出本次申请</Button>}</div>)}{error&&<Notice tone="danger">{error}</Notice>}</div>;
}

export function OriginalField({api,commands,formId,companyId,field,refs=[],onChange,enabled=false,readOnly=false}){
 const[error,setError]=useState(''),[busy,setBusy]=useState(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const upload=async event=>{const selected=Array.from(event.target.files||[]);event.target.value='';setError('');if(!selected.length)return;if(selected.length+refs.length>10){setError('每个附件字段最多10份不同原件');return;}setBusy(true);let next=[...refs];try{for(const file of selected){if(!file.size||file.size>8*1024*1024)throw new Error('每份原件须大于0且不超过8MB');const mime=MIME[file.name.split('.').pop()?.toLowerCase()];if(!mime)throw new Error('支持PDF、PNG、JPEG、文本、Word或Excel原件');const response=await commands.run('system.file.upload',{form_id:formId,company_id:companyId||null,field_key:field.key,filename:file.name,mime,content_base64:await fileBody(file)});if(!response){setError('本次上传尚未确认，请先核对待核办理，原件引用未添加');break;}const ref=response.result?.file_ref;if(!ref)throw new Error('服务端未返回有效原件引用，请核对原操作');if(!next.includes(ref))next.push(ref);if(alive.current)onChange(next);}}catch(e){if(alive.current)setError(e.message);}finally{if(alive.current)setBusy(false);}};
 return<div className="original-field">{enabled&&!readOnly?<><input aria-label={'上传'+field.label} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt,.docx,.xlsx" disabled={busy||commands?.busy||refs.length>=10} onChange={upload}/><small>单份最多8MB，每项最多10份。移出本次申请不会删除原件或已提交的历史证据。</small></>:<small>{readOnly?'已上传的原件按当前权限核验。':'附件存储尚未就绪；正式申请须启用原件服务。'}</small>}<OriginalList api={api} refs={refs} disabled={busy||commands?.busy} onRemove={enabled&&!readOnly?ref=>onChange(refs.filter(r=>r!==ref)):undefined}/>{error&&<Notice tone="danger">{error}</Notice>}</div>;
}
