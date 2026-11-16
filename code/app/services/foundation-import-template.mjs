import { writeXlsx } from '../xlsx-write.mjs';
export function rosterTemplate(){
  const headers={B:'编号',C:'就业状态',D:'中文姓名',I:'部门',J:'入职日期',K:'职位',L:'用工类型',AA:'离职日期',AN:'是否2次入职',AO:'首次入职日期'};
  const columns=Array.from({length:41},(_,i)=>{let n=i+1,s='';for(;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return{key:s,label:i===0?'纯虚构花名册示例，请替换或删除示例行':''};});
  return writeXlsx({sheetName:'花名册',columns,rows:[headers,{B:'TEST0001',C:'在职',D:'虚构员工甲',I:'虚构星河店',J:'2026-01-01',K:'服务员',L:'FT',AN:'否'}]});
}
