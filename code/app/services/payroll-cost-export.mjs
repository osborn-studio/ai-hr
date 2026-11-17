import { bad } from './platform-core.mjs';
import { bossCosts } from './payroll-source.mjs';
import { csv } from '../csv.mjs';
import { writeXlsx, XLSX_CONTENT_TYPE } from '../xlsx-write.mjs';

const labels={period:'归属月',company_name:'公司／门店',label:'来源批次',economic_component:'成本事项',currency:'币种',amount:'成本金额',source_ref:'来源依据',cost_review_reason:'待核与计入口径说明'};

export async function exportCosts(t,{userId,input}){
 if(input.format&&!['xlsx','csv'].includes(input.format))bad('成本导出格式须为xlsx或csv');
 // Export is projected afresh under one export grant for each record. A read
 // grant never supplies fields or supplier amounts for a separate export grant.
 const report=await bossCosts(t,{userId,input,action:'export',allRows:true});
 const columns=Object.entries(labels).map(([key,label])=>({key,label}));
 const rows=report.rows.map(row=>Object.fromEntries(columns.filter(({key})=>Object.hasOwn(row,key)).map(({key})=>[key,key==='period'?String(row[key] instanceof Date?row[key].toISOString():row[key]).slice(0,7):row[key]??''])));
 const isCsv=input.format==='csv',content=isCsv?Buffer.from(csv({columns,rows}),'utf8'):writeXlsx({sheetName:'人力成本明细',columns,rows});
 return{filename:`ty-hr-cost-${input.period||'scope'}.${isCsv?'csv':'xlsx'}`,mime:isCsv?'text/csv;charset=utf-8':XLSX_CONTENT_TYPE,content_base64:content.toString('base64'),row_count:rows.length,by_currency:report.by_currency,totals_complete:report.totals_complete,scope:'all_currently_export_authorized_rows',basis:'confirmed_native_payroll_and_current_posted_supplier_targets',foreign_exchange_applied:false,payment_instruction:false,exact_text_money_columns:['amount']};
}
