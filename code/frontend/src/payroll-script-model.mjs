export const scriptTabs=[['scripts','代码版本'],['runs','沙箱预演'],['proposals','参数草稿'],['triggers','触发器'],['jobs','触发任务'],['ai','AI需求提案']];
export const scriptStatus={draft:'待独立核准',approved:'已核准',disabled:'已停用',completed:'预演完成',failed:'预演失败',queued:'待预演',blocked:'已阻断',cancelled:'已取消'};
export const scriptOperations={'save':'新建代码版本','approve':'独立启用代码','disable':'停用代码','preview':'沙箱预演','proposal.create':'生成工资参数草稿','profile.approve':'独立核准工资参数','trigger.save':'配置触发器','trigger.approve':'独立启用触发器','trigger.disable':'停用触发器','trigger.enqueue':'排队预演','job.process':'执行触发预演','ai.propose':'AI需求提案'};
export const scriptScope=scope=>Object.fromEntries(['group_id','company_id','ledger_id'].filter(k=>scope?.[k]!=null&&scope[k]!=='').map(k=>[k,String(scope[k])]));
export const scriptArray=v=>Array.isArray(v)?v:[];
export const scriptSame=(a,b)=>String(a)===String(b);
export function parseSpecs(rows,type){const keys=rows.map(row=>String((type==='input'?row.alias:row.key)||'').trim());if(keys.some(k=>!k)||new Set(keys).size!==keys.length)throw Error('每项编码须填写且不能重复');const result={};rows.forEach((row,i)=>{const required=type==='input'?['key','unit']:['unit','minimum','maximum'];if(required.some(k=>typeof row[k]!=='string'||!row[k].trim()))throw Error('请完整填写每项声明的来源、单位和边界');result[keys[i]]=type==='input'?{source:row.source,key:row.key.trim(),unit:row.unit.trim()}:{unit:row.unit.trim(),minimum:row.minimum.trim(),maximum:row.maximum.trim()};});return result;}
export function scriptInput(op,v,row={}){
 if(op==='save')return{company_id:String(v.company_id),code:v.code,name:v.name,system:v.system,valid_from:v.valid_from,valid_to:v.valid_to||undefined,source:v.source,input_spec:parseSpecs(v.inputs,'input'),output_spec:parseSpecs(v.outputs,'output'),evidence_ref:v.evidence_ref};
 if(op==='preview')return{script_id:String(v.script_id),employment_id:String(v.employment_id),period:v.period,report_id:v.report_id?String(v.report_id):undefined,base_profile_id:v.base_profile_id?String(v.base_profile_id):undefined,base_hash:v.base_hash||undefined};
 if(op==='proposal.create')return{run_id:String(row.id),evidence_ref:v.evidence_ref};
 if(op==='profile.approve')return{id:String(row.profile_config_id),expected_revision:row.profile_revision};
 if(op==='trigger.save')return{script_id:String(v.script_id),employment_id:String(v.employment_id),event_kind:v.event_kind,valid_from:v.valid_from,valid_to:v.valid_to||undefined,evidence_ref:v.evidence_ref};
 if(op==='trigger.enqueue')return{trigger_id:String(row.id),period:v.period,event_key:v.event_key||undefined,report_id:v.report_id?String(v.report_id):undefined};
 if(op==='ai.propose')return{company_id:String(v.company_id),purpose:v.purpose||'draft_script',goal:v.goal,run_id:v.run_id?String(v.run_id):undefined};
 return{id:String(row.id),expected_revision:row.revision,...(op.includes('disable')?{reason:v.reason}:{} )};
}
export function previousPayrollMonth(){const d=new Date();d.setDate(1);d.setMonth(d.getMonth()-1);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}
