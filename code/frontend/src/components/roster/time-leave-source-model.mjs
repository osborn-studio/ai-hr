const present=(v,k)=>v&&Object.hasOwn(v,k)&&v[k]!==undefined&&v[k]!==null&&v[k]!=='';
export const timeLeaveModeLabels={automatic:'按实际已休自动核对',inherited:'沿用来源版本',manual:'人工核定保留',historical:'历史版本保留'};
export const timeLeaveClassLabels={paid:'带薪假核勤分类',unpaid:'无薪假核勤分类',mixed:'分段分类',unknown:'待遇分类待核',baseline_retained:'保留原核勤基线'};
export const leaveRequestStateLabels={pending:'待审批',approved:'已批准，未核定已休',taken:'已核定实际已休',cancelled:'已取消',rejected:'已驳回'};
export function timeLeaveSourceInput(row={},report={},self=false){
 const reportId=row.report_id??report.id;if(!reportId)return null;
 const input={report_id:String(reportId)};
 if(row.line_id??row.id)input.line_id=String(row.line_id??row.id);
 else if(row.employment_id)input.employment_id=String(row.employment_id);
 else return null;
 if(present(row,'work_date'))input.work_date=String(row.work_date).slice(0,10);
 if(self)input.self=true;
 return input;
}
export function timeLeaveSourceRows(dto){return(Array.isArray(dto?.rows)?dto.rows:[]).flatMap((row,index)=>{
 const sources=Array.isArray(row.sources)?row.sources:[];
 return(sources.length?sources:row.restricted?[null]:[]).map((source,n)=>({id:String(row.line_id??row.line_key??index)+':'+n,row,source}));
});}
export function leaveSourceMinutes(value){return value===null||value===undefined||value===''?'待核分钟':Number.isFinite(Number(value))&&Number(value)>=0?String(value)+' 分钟':'待核分钟';}
export function leaveSourceStamp(value){if(value===null||value===undefined||value==='')return'';const d=new Date(value);return Number.isNaN(+d)?'待核时间':new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);}
export function currentLeaveRequestFields(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return[];
 const fields=[['id','申请编号'],['status','当前状态','status'],['starts_at','申请开始（内地 / 香港时间）','time'],['ends_at','申请结束（内地 / 香港时间）','time'],['quantity','核定数量','quantity'],['created_at','建立时间（内地 / 香港时间）','time']];
 return fields.filter(([key])=>present(value,key)).map(([key,label,format])=>({key,label,value:format==='status'?leaveRequestStateLabels[value[key]]||'待核对':format==='time'?leaveSourceStamp(value[key]):format==='quantity'?String(value[key])+(value.unit==='minute'?' 分钟':value.unit==='day'?' 天':''):String(value[key])}));
}
