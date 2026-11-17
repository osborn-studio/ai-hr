import {useMemo,useState} from 'react';
import{usePrivateCommands}from'../BusinessShared.jsx';
import {useRemote} from '../UI.jsx';
export function useTimeWorkspace({api,input,revision=0}){return useRemote(async signal=>{const value=await api.request('/api/v2/query/time.workspace',{method:'POST',body:input,signal});if(!Array.isArray(value?.rows)||value.total===undefined||!value.capabilities)throw new Error('排班服务未返回有效授权结果，请重新读取。');return value;},JSON.stringify([input,revision]));}
export function useTimeCommands({api,session,onCompleted,notify,self=false}){
 const commands=usePrivateCommands({api,session,namespace:'time',legacyPrefix:'time.',notify,onCompleted});
 const run=async(operation,input,retryId)=>{if(!retryId&&!/^time\.(plan\.(create|publish)|day\.set|segment\.(save|move|copy|delete)|shift\.save|change\.(submit|decide|agree)|punch\.(submit|correction|correction\.decide)|report\.(create|adjust|confirm)|import\.(preview|commit))$/.test(operation))throw new Error('此排班动作未开放。');return commands.run(operation,self&&!retryId?{...input,self:true}:input,retryId);};
 return{...commands,run};
}
export function localInput(value){return String(value||'').slice(0,16).replace(' ','T');}
export function explicitTime(value){return value?localInput(value)+':00+08:00':null;}
export async function base64File(file){if(!file||!/\.xlsx$/i.test(file.name))throw new Error('请选择XLSX文件。');if(file.size>3*1024*1024)throw new Error('一次最多3MB，请拆分后导入。');const data=new Uint8Array(await file.arrayBuffer());let text='';for(let offset=0;offset<data.length;offset+=32768)text+=String.fromCharCode(...data.subarray(offset,offset+32768));return btoa(text);}
export function downloadEncoded(result){if(typeof result?.content_base64!=='string'||!result.filename)throw new Error('服务端未返回完整导出文件。');const binary=atob(result.content_base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:result.mime||'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const link=document.createElement('a');link.href=url;link.download=result.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
