import{createHash}from'node:crypto';
import{readNamedWorkbook,columnName}from'./customer-performance-import.mjs';
import{writeXlsx,XLSX_CONTENT_TYPE}from'../xlsx-write.mjs';
import{hash,bad,text}from'./platform-core.mjs';import{sourceId}from'./recruiting-provider.mjs';
export const recruitingHeaders={external_id:'来源应聘编号',external_talent_id:'来源人才编号',source_version:'源版本',source_at:'源更新时间（含时区）',source_state:'来源状态',full_name:'姓名',mobile:'电话',email:'邮箱'};
export function recruitingTemplate(){const bytes=writeXlsx({sheetName:'招聘来源',columns:Object.entries(recruitingHeaders).map(([key,label])=>({key,label})),rows:[]});return{filename:'天意HR_招聘来源导入模板.xlsx',mime:XLSX_CONTENT_TYPE,content_base64:bytes.toString('base64')};}
function record(value){const at=text(value.source_at,'来源更新时间');if(!/(Z|[+-]\d\d:\d\d)$/.test(at)||!Number.isFinite(Date.parse(at)))bad('来源更新时间须含明确时区');const source_at_ms=String(Date.parse(at));if(!['active','withdrawn'].includes(value.source_state))bad('来源状态须为active或withdrawn');
 const out={external_id:sourceId(value.external_id),external_talent_id:sourceId(value.external_talent_id,'来源人才编号'),source_version:text(value.source_version,'稳定源版本',1,200),source_at_ms,source_state:value.source_state,full_name:text(value.full_name,'姓名',1,100),contact:{}};
 for(const k of['mobile','email'])if(value[k])out.contact[k]=text(value[k],k,1,k==='mobile'?60:254);return out;}
export function parseRecruitingFile(input){
 const filename=text(input.filename,'原件文件名',1,180);if(/[\\/\x00-\x1f\x7f]/.test(filename))bad('原件文件名不能带路径');
 const encoded=input.content_base64;if(typeof encoded!=='string'||encoded.length>4500000)bad('原件最多3MB');const bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>3*1024*1024||bytes.toString('base64')!==encoded)bad('原件须为有效base64');
 const original={bytes,filename,mime:input.mime,sha256:createHash('sha256').update(bytes).digest('hex')};let values=[];
 if(input.mime==='application/pdf'&&filename.toLowerCase().endsWith('.pdf')){
  if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))bad('PDF原件头与格式不符');
  // PDF stays opaque. It is never executed, rendered as HTML or OCR-guessed.
  if(!input.record||typeof input.record!=='object'||Array.isArray(input.record))bad('PDF须人工填写来源编号、版本及候选字段');
  if(Object.keys(input.record).some(k=>!Object.hasOwn(recruitingHeaders,k)))bad('PDF手工核对字段未登记');values=[input.record];
 }else if(input.mime===XLSX_CONTENT_TYPE&&filename.toLowerCase().endsWith('.xlsx')){
  if(input.record)bad('Excel按模板逐行读取，不接受并行覆盖记录');const book=readNamedWorkbook(bytes),sheet=book.sheets.find(s=>s.name==='招聘来源'&&!s.hidden);
  if(!sheet||sheet.max_row>201||sheet.max_column>12||book.formula_count||book.external_relationship_count||book.errors.length)bad('招聘来源须为不超过200行的无公式、无外链模板');
  const columns=new Map();for(let c=1;c<=sheet.max_column;c++){const v=sheet.cells.get(columnName(c)+'1')?.value;if(v==null)continue;if(!Object.values(recruitingHeaders).includes(v)||columns.has(v))bad('招聘来源表头须唯一并使用模板字段');columns.set(v,c);}
  for(const k of['external_id','external_talent_id','source_version','source_at','source_state','full_name'])if(!columns.has(recruitingHeaders[k]))bad('招聘来源缺少必要字段：'+recruitingHeaders[k]);
  for(let r=2;r<=sheet.max_row;r++){const v=Object.fromEntries(Object.entries(recruitingHeaders).map(([key,label])=>[key,columns.has(label)?sheet.cells.get(columnName(columns.get(label))+r)?.value??'':'']));if(Object.values(v).some(x=>x!==''))values.push(v);}
 }else bad('只接受PDF原件或招聘来源XLSX模板');
 if(!values.length)bad('原件没有可核对记录');const seen=new Set();return values.map(v=>{const n=record(v);if(seen.has(n.external_id))bad('同一原件中来源应聘编号重复');seen.add(n.external_id);const raw={record:v,original_sha256:original.sha256};return{...n,source_hash:hash(raw),raw,original};});
}
