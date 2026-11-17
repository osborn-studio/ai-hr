import React,{useState}from'react';
import{DataTable,ErrorState,Loading,Modal,Notice,useRemote}from'./UI.jsx';
import{moneyText}from'../payroll-model.mjs';
export default function PayrollCostSource({api,row,onClose}){
 const[page,setPage]=useState(1),[size,setSize]=useState(10),input={group_id:row.group_id,company_id:row.company_id,view:'bill_lines',version_id:row.source_bill_id,page,page_size:size};
 const state=useRemote(signal=>api.request('/api/v2/query/workforce.workspace',{method:'POST',body:input,signal}),JSON.stringify(input));
 return<Modal title="供应商成本原单" wide onClose={onClose}><Notice>按已确认对账版本查看本期费用。付款与托管资金另行记录，金额和明细按当前权限返回。</Notice>{state.loading?<Loading>正在读取原对账明细</Loading>:state.error?<ErrorState error={state.error} retry={state.reload}/>:<DataTable rows={state.data?.rows||[]} columns={[{key:'description',title:'费用说明'},{key:'quantity',title:'数量'},{key:'unit',title:'单位'},{key:'amount',title:'原单金额',numeric:true,render:r=>moneyText(r.amount)},{key:'cost_membership',title:'成本口径',render:r=>({independent:'独立成本',included_in_parent:'父项已含',excluded:'不计成本'})[r.cost_membership]||'待核定'}]} searchable={false} pagination={{page:state.data?.page||page,pageSize:size,total:state.data?.total||0,onPage:setPage,onPageSize:n=>{setSize(n);setPage(1);}}}/>}</Modal>;
}
