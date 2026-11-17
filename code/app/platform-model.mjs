import{compareDecimal}from'./leave-calculations.mjs';

const TYPES=new Set(['start','approval','condition','notify','end']);
const FIELD_TYPES=new Set(['text','number','money','date','person','company','select','file']);
export function validateGraph(graph){
 const issues=[];if(!graph||!Array.isArray(graph.nodes)||graph.nodes.length<3||graph.nodes.length>128)return{valid:false,issues:['流程需要3至128个节点']};
 if(graph.notification_policy!==undefined&&(!graph.notification_policy||typeof graph.notification_policy!=='object'||Array.isArray(graph.notification_policy)||typeof graph.notification_policy.applicant_on_result!=='boolean'))issues.push('申请人结果通知须为明确开关');
 const map=new Map();for(const n of graph.nodes){if(!n||typeof n!=='object'){issues.push('节点必须为对象');continue;}if(typeof n.id!=='string'||!/^\w[\w.-]{0,79}$/.test(n.id)||map.has(n.id))issues.push('节点编号无效或重复');else map.set(n.id,n);if(!TYPES.has(n.type))issues.push(`节点${n.id}类型无效`);
  if(n.type==='approval'&&(!['any','all'].includes(n.mode||'any')||!(Array.isArray(n.approver_ids)&&n.approver_ids.length||Array.isArray(n.role_codes)&&n.role_codes.length)))issues.push(`审批节点${n.id}须有有效模式和审批人来源`);
  if(n.type==='notify'){for(const key of ['recipient_ids','approver_ids'])if(n[key]!==undefined&&(!Array.isArray(n[key])||n[key].length>1000||n[key].some(x=>!Number.isSafeInteger(Number(x))||Number(x)<1)))issues.push(`抄送节点${n.id}接收人员无效`);for(const key of ['recipient_role_codes','role_codes'])if(n[key]!==undefined&&(!Array.isArray(n[key])||n[key].length>1000||n[key].some(x=>typeof x!=='string'||!x.trim())))issues.push(`抄送节点${n.id}接收角色无效`);if(n.include_applicant!==undefined&&typeof n.include_applicant!=='boolean')issues.push(`抄送节点${n.id}申请人通知设置须为明确开关`);}
  if(n.type==='condition'){if(!Array.isArray(n.branches)||n.branches.length<2||n.branches.filter(b=>b.else===true).length!==1)issues.push(`条件节点${n.id}须有条件和唯一默认分支`);else for(const b of n.branches){if(!b.else&&(!b.when||typeof b.when.field!=='string'||!['eq','ne','gt','gte','lt','lte','in','contains','empty'].includes(b.when.op)))issues.push(`条件节点${n.id}表达式无效`);}}
 }
 const starts=graph.nodes.filter(n=>n?.type==='start');if(starts.length!==1)issues.push('流程必须恰有一个开始节点');if(!graph.nodes.some(n=>n?.type==='end'))issues.push('流程必须有结束节点');
 const edges=n=>n.type==='end'?[]:n.type==='condition'?(n.branches||[]).map(b=>b.next):[n.next];
 for(const n of graph.nodes){if(!n||!map.has(n.id))continue;for(const next of edges(n)){if(!next||!map.has(next))issues.push(`节点${n.id}连接目标不存在`);}if(n.type==='end'&&n.next)issues.push('结束节点不能继续连线');}
 const visiting=new Set(),visited=new Set();function walk(key){if(visiting.has(key)){issues.push('流程存在循环');return;}if(visited.has(key)||!map.has(key))return;visiting.add(key);for(const next of edges(map.get(key)))walk(next);visiting.delete(key);visited.add(key);}
 if(starts.length===1)walk(starts[0].id);if(visited.size!==map.size)issues.push('流程含不可到达节点');
 return{valid:issues.length===0,issues:[...new Set(issues)]};
}
export function valueAt(values,key){if(Object.hasOwn(values,key))return values[key];return key.split('.').reduce((v,k)=>v&&typeof v==='object'?v[k]:undefined,values);}
export function conditionMatches(expression,values){
 const value=valueAt(values,expression.field),other=expression.value;
 if(expression.op==='empty')return value===undefined||value===null||value==='';
 if(value===undefined||value===null||value==='')throw new Error(`E_TY_ARGUMENT: 缺少流程条件字段${expression.field}，不能默认跳过`);
 if(expression.op==='eq')return String(value)===String(other);if(expression.op==='ne')return String(value)!==String(other);
 if(expression.op==='in')return Array.isArray(other)&&other.some(x=>String(x)===String(value));
 if(expression.op==='contains')return typeof value==='string'&&value.includes(String(other));
 let result;try{result=compareDecimal(value,other);}catch{throw new Error(`E_TY_ARGUMENT: 条件${expression.field}需要有效数字`);}
 return{gt:result>0,gte:result>=0,lt:result<0,lte:result<=0}[expression.op]===true;
}
export function nextNode(node,values){if(node.type==='end')return null;if(node.type!=='condition')return node.next;const selected=node.branches.find(b=>!b.else&&conditionMatches(b.when,values))||node.branches.find(b=>b.else);if(!selected)throw new Error('E_TY_ARGUMENT: 条件分支无匹配路径');return selected.next;}
export function validateSchema(schema){
 const issues=[];if(!schema||!Array.isArray(schema.fields)||schema.fields.length<1||schema.fields.length>200)return{valid:false,issues:['表单需要1至200个字段']};
 const seen=new Set();for(const f of schema.fields){if(!f||typeof f!=='object'){issues.push('字段必须为对象');continue;}if(typeof f.key!=='string'||!/^[a-zA-Z][a-zA-Z0-9_.]{0,79}$/.test(f.key)||seen.has(f.key)||['userId','actor','actor_id','approvedBy'].includes(f.key))issues.push('字段编号无效、重复或占用系统身份名');seen.add(f.key);if(!FIELD_TYPES.has(f.type))issues.push(`字段${f.key}类型无效`);if(typeof f.label!=='string'||!f.label.trim())issues.push(`字段${f.key}缺少名称`);if(f.type==='select'&&(!Array.isArray(f.options)||!f.options.length))issues.push(`选择字段${f.key}没有选项`);if(!['normal','restricted'].includes(f.sensitivity||'normal'))issues.push(`字段${f.key}敏感类型未登记`);}
 return{valid:issues.length===0,issues:[...new Set(issues)]};
}
export function validateValues(schema,values){
 const issues=[],out={};if(!values||typeof values!=='object'||Array.isArray(values))return{valid:false,issues:['表单内容须为对象'],values:{}};
 const keys=new Set(schema.fields.map(f=>f.key));if(Object.keys(values).some(k=>!keys.has(k)))issues.push('提交包含表单版本未声明字段');
 for(const f of schema.fields){let v=valueAt(values,f.key);if(v===undefined||v===null||v===''){if(f.required)issues.push(`${f.label}必填`);continue;}
  if(['text','select','date','money'].includes(f.type)&&typeof v!=='string')issues.push(`${f.label}须为文本格式`);
  if(f.type==='text'&&String(v).length>10000)issues.push(`${f.label}过长`);
  if(['number','money'].includes(f.type)){try{compareDecimal(v,'0');if(f.type==='money'&&!/^-?\d+(\.\d{1,4})?$/.test(String(v)))throw new Error();}catch{issues.push(`${f.label}数字或精度无效`);}}
  if(f.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(String(v))||!Number.isFinite(Date.parse(v+'T00:00:00Z'))||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v))issues.push(`${f.label}日期无效`);
  if(['person','company'].includes(f.type)&&(!Number.isSafeInteger(Number(v))||Number(v)<1))issues.push(`${f.label}关联无效`);
  if(f.type==='select'&&!f.options.some(o=>String(typeof o==='object'?o.value:o)===String(v)))issues.push(`${f.label}不在可选范围`);
  if(f.type==='file'&&(!Array.isArray(v)||f.required&&!v.length||v.length>10||v.some(x=>typeof x!=='string'||!/^pf:[0-9a-f-]{36}$/.test(x))))issues.push(`${f.label}须为已上传原件引用列表`);
  out[f.key]=v;
 }return{valid:issues.length===0,issues,values:out};
}
export function projectValues(schema,values,{own=false,restricted=false,allowedFields=null}={}){return Object.fromEntries(schema.fields.filter(f=>own||((f.sensitivity!=='restricted'||restricted)&&(!allowedFields||allowedFields.includes('*')||allowedFields.includes(f.key)))).filter(f=>Object.hasOwn(values,f.key)).map(f=>[f.key,values[f.key]]));}
