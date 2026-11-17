export const enterpriseLoginTabs=[['profiles','登录入口'],['bindings','账号对照']];
export const ssoStatus={draft:'待独立复核',approved:'已核准',disabled:'已停用'};
export const ssoProvider={wecom:'企业微信',dingtalk:'钉钉',feishu:'飞书'};
export const ssoModeName={web:'浏览器登录',in_app:'客户端授权登录'};
export const ssoRoles={config_admin:'系统配置管理员',demo:'全权限演示',group_hr_director:'集团HR总监',company_hr_director:'品牌HR总监',hk_hr_director:'香港品牌HR总监',boss:'老板',payroll:'薪酬专员',hr_staff:'人事专员',hr_manager:'HR主管',recruiter:'招聘专员',trainer:'培训专员',store_manager:'店长',store_staff:'门店员工',hr_director:'HR总监',staff:'员工',employee:'员工',outsource_hr:'外包人事专员',outsourced_staff:'服务人员',vendor_contact:'供应商联系人'};
export const ssoArray=v=>Array.isArray(v)?v:[];
export const ssoSame=(a,b)=>a!=null&&b!=null&&String(a)===String(b);
export const ssoScope=scope=>Object.fromEntries(['group_id','ledger_id','company_id'].filter(k=>scope?.[k]!=null&&scope[k]!=='').map(k=>[k,scope[k]]));
export function supportedSsoModes(connection){const known=['web','in_app'];return Array.isArray(connection?.supported_modes)?known.filter(m=>connection.supported_modes.includes(m)):connection?.provider==='wecom'?known:['web'];}
export const currentSsoProfiles=refs=>ssoArray(refs?.profiles).filter(p=>p.status==='approved'&&p.current===true);
export const runtimeForConnection=(refs,connectionId)=>ssoArray(refs?.runtime_profiles).filter(r=>ssoSame(r.connection_id,connectionId)&&r.status==='approved'&&r.application_type==='internal');
export const identitiesForProfile=(refs,profileId)=>{const p=currentSsoProfiles(refs).find(p=>ssoSame(p.id,profileId));return p?ssoArray(refs?.identities).filter(i=>ssoSame(i.connection_id,p.connection_id)):[];};
export const operatorsForIdentity=(refs,identityId)=>{const i=ssoArray(refs?.identities).find(i=>ssoSame(i.id,identityId));return i?ssoArray(refs?.operators).filter(o=>o.status==='active'&&ssoSame(o.person_id,i.person_id)):[];};
export const operatorLabel=o=>[o.display_name,o.login,ssoRoles[o.profile_code]||'操作账号'].filter(Boolean).join(' · ');
export function resetSsoSelection(values,key,value){const next={...values,[key]:value};if(key==='connection_id'){next.runtime_profile_id='';next.enabled_modes=['web'];}if(key==='profile_id'){next.identity_id='';next.account_id='';}if(key==='identity_id')next.account_id='';return next;}
const requiredId=(value,label)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw Error('请选择'+label);return n;};
const requiredText=(value,label,min=1)=>{const text=String(value??'').trim();if(text.length<min)throw Error(label+'至少填写'+min+'个字');return text;};
export function ssoCommandInput(operation,values,row={},refs={}){
 if(operation==='profile.save'){
  const connection_id=requiredId(values.connection_id,'平台连接'),connection=ssoArray(refs.connections).find(c=>ssoSame(c.id,connection_id)&&c.status==='active');
  if(!connection)throw Error('请选择当前启用的平台连接');const runtime_profile_id=requiredId(values.runtime_profile_id,'已核内部应用');
  if(!runtimeForConnection(refs,connection_id).some(r=>ssoSame(r.id,runtime_profile_id)))throw Error('所选内部应用不属于当前连接或已失效');
  const public_origin=requiredText(values.public_origin,'应用公开源地址');let url;try{url=new URL(public_origin);}catch{throw Error('请填写完整的HTTPS应用源地址');}
  if(url.origin!==public_origin||url.username||url.password||url.pathname!=='/'||url.search||url.hash||url.protocol!=='https:'&&!(values.allow_loopback_http===true&&url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('请填写固定HTTPS源地址；本机HTTP需勾选例外，地址不含路径或末尾斜杠');
  const enabled_modes=ssoArray(values.enabled_modes);if(!enabled_modes.length||new Set(enabled_modes).size!==enabled_modes.length||enabled_modes.some(m=>!supportedSsoModes(connection).includes(m)))throw Error('请选择本平台支持的登录方式');
  return{connection_id,runtime_profile_id,name:requiredText(values.name,'登录入口名称'),public_origin,allow_loopback_http:values.allow_loopback_http===true,enabled_modes:[...enabled_modes]};
 }
 if(operation==='binding.save'){
  const profile_id=requiredId(values.profile_id,'当前已核登录入口');if(!currentSsoProfiles(refs).some(p=>ssoSame(p.id,profile_id)))throw Error('登录入口须已核准且仍有效');
  const identity_id=requiredId(values.identity_id,'平台人员');if(!identitiesForProfile(refs,profile_id).some(i=>ssoSame(i.id,identity_id)))throw Error('平台人员须属于所选入口的同一连接');
  const account_id=requiredId(values.account_id,'明确的操作账号');if(!operatorsForIdentity(refs,identity_id).some(o=>ssoSame(o.id,account_id)))throw Error('操作账号须为该人员已有的活跃账号');
  const valid_from=requiredText(values.valid_from,'生效日期'),valid_to=values.valid_to||null;if(!/^\d{4}-\d{2}-\d{2}$/.test(valid_from)||valid_to&&(!/^\d{4}-\d{2}-\d{2}$/.test(valid_to)||valid_to<=valid_from))throw Error('结束日期须晚于生效日期，结束当天不再适用');
  return{profile_id,identity_id,account_id,valid_from,valid_to,evidence_ref:requiredText(values.evidence_ref,'具体账号选择核对依据',4)};
 }
 const id=requiredId(row.id,'待办理记录'),expected_revision=requiredId(row.revision,'当前记录版本');
 if(operation==='profile.approve'||operation==='binding.approve')return{id,expected_revision,review_ref:requiredText(values.review_ref,'独立复核说明',4)};
 if(operation==='configuration.disable'){if(!['profile','binding'].includes(values.kind))throw Error('停用记录种类无效');return{kind:values.kind,id,expected_revision,reason:requiredText(values.reason,'停用依据',4)};}
 throw Error('未登记的登录设置操作');
}
