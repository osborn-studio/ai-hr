import React,{useState}from'react';
import LifecycleReminderTarget from'./LifecycleReminderTarget.jsx';
import{Button,ErrorState,Loading,Notice,PageHeading,Tabs,useRemote}from'../UI.jsx';
import{usePrivateCommands,PrivateCommandFeedback}from'../BusinessShared.jsx';
import{InstanceContent,InstanceTimeline}from'../platform/PlatformShared.jsx';
import{TaskDecision}from'../../pages/System.jsx';
export default function NotificationLanding({api,session,scopeKey,notify,noticeKey,onClose}){
 const[tab,setTab]=useState('content'),[deciding,setDeciding]=useState(false),remote=useRemote(signal=>api.request('/api/v2/query/integration.notifications.target',{method:'POST',body:{public_key:noticeKey},signal}),JSON.stringify([session.me.id,noticeKey,scopeKey]));
 const commands=usePrivateCommands({api,session,namespace:'workflow-notification',notify,onCompleted:()=>{setDeciding(false);remote.reload();}}),target=remote.data,instance=target?.instance,scope=instance?{group_id:instance.group_id,company_id:instance.company_id||''}:{};
 if(remote.loading)return<Loading>正在核对当前账号与通知事项</Loading>;if(remote.error)return<ErrorState error={remote.error} retry={remote.reload}/>;if(target?.kind==='business_reminder')return<LifecycleReminderTarget {...{api,session,scopeKey,target,onClose}}/>;if(!instance)return<Notice>未返回当前有权的事项资料。</Notice>;
 return<div className="notification-landing"><PageHeading eyebrow="YOUR WORK ITEM" title={instance.title||'通知事项'} description={target.category==='task'?'请核对原单后按当前授权办理。消息已读不会自动审批或使业务生效。':'按当前授权查看此项抄送或审批结果。业务是否生效以原单为准。'} actions={<Button onClick={()=>onClose?.()}>返回工作台</Button>}/>
 <section className="panel"><div className="padded"><PrivateCommandFeedback commands={commands}/>{target.external_read_state==='provider_reported_read'&&<Notice>平台已报告消息已读；原单仍按自身审批和办理状态推进。</Notice>}</div>
 {deciding&&target.task?<TaskDecision task={target.task} {...{api,scope,scopeKey,commands}} onClose={()=>{setDeciding(false);remote.reload();}}/>:<><Tabs value={tab} onChange={setTab} items={[{id:'content',label:'申请内容'},{id:'history',label:'审批轨迹'}]}/>{tab==='history'?<InstanceTimeline instance={instance}/>:<div className="padded"><InstanceContent api={api} instance={instance}/><div className="modal-actions"><Button onClick={()=>onClose?.()}>关闭</Button>{target.task?.actions?.length>0?<Button variant="primary" onClick={()=>setDeciding(true)}>核对并办理此任务</Button>:<Notice>当前事项可查看；没有本账号可办的任务动作。</Notice>}</div></div>}</>}
 </section></div>;
}
