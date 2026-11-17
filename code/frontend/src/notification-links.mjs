// A notification key identifies an item; the server still authorizes its source
// for the current session. Login never accepts a caller-supplied external URL.
export function notificationRoute(value=''){
 if(typeof value!=='string')return null;
 const route=value.replace(/^#/,'').replace(/^\/+/,''),match=/^my\/(tasks|alerts)\/notice\/([a-f0-9]{32})$/.exec(route);
 return match?{view:match[1],key:match[2],route}:null;
}
export const notificationLoginRoute=hash=>notificationRoute(hash)?.route||'work';
export const notificationLoginPath=hash=>{const route=notificationRoute(hash);return route?'/#'+route.route:'/';};
