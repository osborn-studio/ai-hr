import React from'react';
import{Button,Notice,PageHeading}from'../UI.jsx';
import{PrivateCommandFeedback,usePrivateCommands}from'../BusinessShared.jsx';
import{HREditor}from'./HREditors.jsx';
import'../../pages/NativePeople.css';
import'./InitialGroupSetup.css';

export default function InitialGroupSetup({api,session,data,notify,onScopeChange,onLogout}){
 const commands=usePrivateCommands({api,session,namespace:'initial-group',notify});
 return<main className="initial-group-setup"><div className="initial-group-brand">天意 HR</div><PageHeading title="建立集团帐" description="先建立集团，再在集团帐下创建品牌公司、门店、部门和岗位。" actions={<Button onClick={onLogout}>退出登录</Button>}/><section className="panel padded"><Notice>当前没有已开通的授权集团。此操作只建立集团、集团帐和集团公司，人员与工资由后续业务配置。</Notice><PrivateCommandFeedback commands={commands}/><HREditor api={api} session={session} data={data} hideClose dialog={{kind:'group'}} organization={{nodes:[]}} commands={commands} onClose={()=>{}} onScopeChange={onScopeChange}/><div className="initial-group-recheck"><span>已提交但尚未看到结果时，先核对已有集团。</span><Button disabled={commands.busy} onClick={()=>onScopeChange({})}>核对已有集团</Button></div></section></main>;
}
