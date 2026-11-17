import React,{useEffect,useState}from'react';
import{Badge,Button,EmptyState,ErrorState,Loading,Notice,Tabs,useRemote}from'../UI.jsx';
import'./LifecycleReminderTarget.css';
const types={contract_expiry:'合同到期',certificate_expiry:'证照到期',dorm_stay_expiry:'入住期限',dorm_lease_expiry:'房源租约到期'},dateRules={contract_inclusive_end:'截至当日有效',certificate_first_invalid:'失效首日',stay_exclusive_end:'入住结束时点，不含该时点',lease_inclusive_end:'租约截止日，含当日'};
const stateLabels={occupied:'实际在住',ended:'已结束',open:'提醒有效',superseded:'历史依据已更新',resolved:'原事项已处理',blocked:'待核对',signed:'已签署',active:'有效',effective:'已生效',terminated:'已终止',expired:'已到期',verified:'已核定',withdrawn:'日期来源已停止',rejected:'已驳回',pending:'待审批',approved:'已核准',draft:'草稿',closed:'已结束',cancelled:'已取消',not_reported:'平台未报告阅读状态',provider_reported_read:'平台报告已读',provider_reported_unread:'平台报告未读'};
const own=(v,k)=>v&&Object.hasOwn(v,k),present=(v,k)=>own(v,k)&&v[k]!==null&&v[k]!==undefined&&v[k]!=='';
function day(v,tz){if(/^\d{4}-\d{2}-\d{2}$/.test(String(v)))return String(v);const d=new Date(v);return Number.isNaN(+d)?'待核日期':new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:tz||'Asia/Shanghai'}).format(d);}
function stamp(v,tz){const d=new Date(v);return Number.isNaN(+d)?'待核时间':new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'short',timeZone:tz||'Asia/Shanghai'}).format(d);}
// Each original domain has a strict display list. Unknown fields, plaintext
// certificate numbers, salary data and private contract bodies are never rendered.
const allowed={
 contract_expiry:[['code','合同编号'],['title','合同名称'],['status','合同状态','state'],['legal_subject_name','签约主体'],['legal_entity_company_id','签约主体编号'],['starts_on','合同起始日','day'],['ends_on','合同截止日（含当天）','day'],['signed_on','签署日期','day']],
 certificate_expiry:[['type_name','证照类型'],['issuer','颁发机构'],['number_masked','证照编号（已遮盖）'],['valid_from','有效起日','day'],['valid_to','失效首日','day'],['state','证照状态','state']],
 dorm_stay_expiry:[['house_name','宿舍房源'],['room_name','房间'],['bed_code','床位'],['starts_at','入住开始时间','time'],['ends_at','入住结束时间（不含）','time'],['state','入住状态','state']],
 dorm_lease_expiry:[['house_name','宿舍房源'],['starts_on','租约起始日','day'],['ends_on','租约截止日（含当天）','day'],['status','日期来源状态','state'],['version','日期版本'],['evidence_ref','日期依据']]
};
export function reminderSourceDisplay(source,kind,timezone){const value=source&&typeof source==='object'&&!Array.isArray(source)?source:{};return(allowed[kind]||[]).filter(([key])=>present(value,key)&&!(key==='legal_entity_company_id'&&present(value,'legal_subject_name'))).map(([key,label,format])=>({key,label,value:format==='day'?day(value[key],timezone):format==='time'?stamp(value[key],timezone):format==='state'?stateLabels[value[key]]||'待核对':String(value[key])}));}
export default function LifecycleReminderTarget({api,session,scopeKey,noticeKey,noticeId,target,onClose}){
 const[tab,setTab]=useState('overview'),[verification,setVerification]=useState(0),key=JSON.stringify([session?.me?.id,scopeKey,noticeKey,noticeId,target?.notice?.id]);
 const remote=useRemote(signal=>{if(target&&!verification)return Promise.resolve(null);const id=target?.notice?.id||noticeId;if(!!noticeKey===!!id&&!target)return Promise.reject(new Error('请选择确切的到期提醒'));return api.request('/api/v2/query/integration.reminders.target',{method:'POST',body:target?{notice_id:id}:noticeKey?{public_key:noticeKey}:{notice_id:id},signal});},JSON.stringify([key,verification])),needsRemote=!target||verification>0,value=needsRemote?remote.data:target,n=value?.notice;
 useEffect(()=>{setTab('overview');setVerification(0);},[key]);
 const verify=()=>setVerification(v=>v+1),changeTab=value=>{setTab(value);if(value==='source')verify();};
 if(needsRemote&&remote.loading)return<Loading/>;
 if(needsRemote&&remote.error)return<ErrorState error={remote.error} retry={remote.reload}/>;
 if(!n||value?.kind!=='business_reminder')return<EmptyState title="当前没有可查看的到期提醒"/>;
 const fields=reminderSourceDisplay(value.source_details,n.kind,n.timezone),type=types[n.kind]||n.category||'到期提醒';
 return<section className="lr-target"><div className="lr-target-heading"><div><p className="lr-target-kicker">到期提醒</p><h2>{type}</h2></div><div className="lr-target-actions"><Button onClick={verify}>重新核对当前资料</Button>{onClose&&<Button onClick={onClose}>返回提醒列表</Button>}</div></div>{n.source_current===false?<Notice tone="warning">此提醒的历史依据已变化，旧周期停止。原业务资料仍按当前权限显示。</Notice>:<Notice>请核对当前原业务资料，并在相应业务中办理续签、换证或住宿事项。</Notice>}<Tabs label="到期提醒详情分区" value={tab} onChange={changeTab} items={[{id:'overview',label:'提醒概况'},{id:'source',label:'原业务当前资料'}]}/>{tab==='overview'?<><dl className="lr-target-fields"><dt>提醒事项</dt><dd>{type}</dd>{present(n,'due_on')&&<><dt>到期 / 失效日期</dt><dd><strong>{day(n.due_on,n.timezone)}</strong></dd></>}{present(n,'date_semantics')&&<><dt>日期口径</dt><dd>{dateRules[n.date_semantics]||'待核对'}</dd></>}{present(n,'timezone')&&<><dt>日期时区</dt><dd>{n.timezone==='Asia/Hong_Kong'?'中国香港':n.timezone==='Asia/Shanghai'?'中国内地':n.timezone}</dd></>}{present(n,'state')&&<><dt>提醒状态</dt><dd><Badge>{stateLabels[n.state]||'待核对'}</Badge></dd></>}{present(value,'external_read_state')&&<><dt>平台阅读状态</dt><dd>{stateLabels[value.external_read_state]||'平台未报告阅读状态'}</dd></>}</dl><Notice>平台阅读回执、站内阅读与业务办理分别记录。阅读此提醒不会自动完成审批、续签或住宿处理。</Notice></>:fields.length?<dl className="lr-target-fields">{fields.map(f=><React.Fragment key={f.key}><dt>{f.label}</dt><dd>{f.value}</dd></React.Fragment>)}</dl>:<EmptyState title="当前没有可展示的原业务字段"/>}</section>;
}
