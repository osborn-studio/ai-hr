import{test}from'node:test';import assert from'node:assert/strict';
import{notificationRoute,notificationLoginRoute,notificationLoginPath}from'../src/notification-links.mjs';
import{ssoReturnRoute}from'../src/auth-sso.mjs';
const key='a'.repeat(32);
test('password and platform login preserve a precise notification destination',()=>{
 for(const view of['tasks','alerts']){const route='my/'+view+'/notice/'+key;assert.deepEqual(notificationRoute('#'+route),{view,key,route});assert.equal(notificationLoginRoute('#'+route),route);assert.equal(ssoReturnRoute(notificationLoginPath('#'+route),'https://hr.example'),route);}
});
test('unrecognized, foreign or parameterized destinations stay on the home page',()=>{
 for(const route of['https://outside.invalid/#my/tasks/notice/'+key,'//outside.invalid/#my/tasks/notice/'+key,'#my/tasks/notice/'+key+'?target=other','#my/tasks/notice/'+key+'/extra','#my/tasks/notice/'+key.slice(1),'#my/requests/notice/'+key,'#sso=credential']){assert.equal(notificationRoute(route),null);assert.equal(notificationLoginRoute(route),'work');assert.equal(notificationLoginPath(route),'/');}
});
