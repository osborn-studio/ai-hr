import React,{useState}from'react';
import{Button,Modal,Notice,Tabs}from'../UI.jsx';
import{InstanceContent,InstanceTimeline,WorkspaceState,usePlatformWorkspace}from'./PlatformShared.jsx';

export default function SourceWorkflowDialog({api,scope,scopeKey,session,instanceId,onClose}){
 const[tab,setTab]=useState('content'),state=usePlatformWorkspace({api,scope,scopeKey,kind:'portal',view:'detail',id:String(instanceId)});
 return<Modal title={'审批原单 #'+instanceId} wide onClose={onClose}><WorkspaceState state={state}>{workspace=>{
  const instance=workspace.rows?.[0];if(!instance)return<Notice>当前没有可查看的审批原单，请刷新后核对权限。</Notice>;
  const route=String(instance.applicant_id)===String(session.me.id)?'my/requests':'my/tasks';
  return<><Tabs value={tab} onChange={setTab} items={[{id:'content',label:'申请内容'},{id:'history',label:'审批轨迹'}]}/>{tab==='content'?<InstanceContent api={api} instance={instance}/>:<InstanceTimeline instance={instance}/>}<div className="modal-actions"><Button onClick={onClose}>关闭</Button><a className="button primary" href={'#'+route} onClick={onClose}>进入审批工作台</a></div></>;
 }}</WorkspaceState></Modal>;
}
