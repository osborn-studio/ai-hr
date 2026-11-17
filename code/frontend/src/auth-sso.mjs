export const ssoProviderNames={dingtalk:'钉钉',feishu:'飞书',wecom:'企业微信'};
export function ssoRelayTicket(hash){
 if(!hash.startsWith('#sso='))return null;
 const q=new URLSearchParams(hash.slice(1));if(q.getAll('sso').length!==1||[...q.keys()].some(x=>x!=='sso'))throw new Error('平台登录结果无效，请重新登录。');
 const ticket=q.get('sso');if(!/^[A-Za-z0-9_-]{20,256}$/.test(ticket))throw new Error('平台登录结果无效，请重新登录。');return ticket;
}
export function ssoReturnRoute(path,origin){
 const u=new URL(path||'/',origin);if(u.origin!==origin||u.pathname!=='/'||u.username||u.password||u.search)throw new Error('平台登录返回入口无效。');
 const route=u.hash.slice(1).replace(/^\/+/, '');if(route&&!/^[a-z][a-z0-9/_-]*$/.test(route))throw new Error('平台登录返回入口无效。');return route||'work';
}
export function ssoMode(entry,userAgent=''){
 const inApp={wecom:/wxwork|wework/i,dingtalk:/dingtalk/i,feishu:/feishu|lark/i}[entry.provider]?.test(userAgent);
 return inApp&&entry.modes?.includes('in_app')?'in_app':entry.modes?.includes('web')?'web':null;
}
export function ssoAuthorizationURL(value,provider){
 const u=new URL(value),hosts={wecom:['login.work.weixin.qq.com','open.weixin.qq.com'],dingtalk:['login.dingtalk.com'],feishu:['accounts.feishu.cn','open.feishu.cn']}[provider]||[];
 const fixedWecomFragment=provider==='wecom'&&u.hostname==='open.weixin.qq.com'&&u.pathname==='/connect/oauth2/authorize'&&u.hash==='#wechat_redirect';
 if(u.protocol!=='https:'||u.username||u.password||u.hash&&!fixedWecomFragment||!hosts.includes(u.hostname)||u.port)throw new Error('平台授权入口无效，请联系管理员。');return u.toString();
}
