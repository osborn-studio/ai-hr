import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../app/server.mjs';
import { createCloudApiExtension } from '../app/cloud-api.mjs';
import { attachFrontend } from '../app/frontend-static.mjs';
import { hashPassword } from '../app/services/auth.mjs';

if(process.env.DATABASE_URL&&!/^\/tyhr_verify_[a-f0-9]{16}$/.test(new URL(process.env.DATABASE_URL).pathname))throw Error('Only an owned empty verification database is permitted');
const app=await createApp({apiExtension:createCloudApiExtension(),skipDemoSeed:true,nativeOnly:true});
const directory=await mkdtemp(join(tmpdir(),'tyhr-native-boundary-'));
let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name);};
try{
 await app.db.query("INSERT INTO sys_account(id,login,display_name)OVERRIDING SYSTEM VALUE VALUES(9200,'native_boundary_hr','熊予安')");
 await app.db.query("INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from)VALUES(9200,10,1,'2020-01-01')");
 const password=randomBytes(22).toString('base64url');await app.db.query('SELECT fn_credential_set($1,$2)',[9200,hashPassword(password)]);
 check('fixture is a coarse full-role account without native managed grant',!(await app.db.query('SELECT EXISTS(SELECT 1 FROM ty_auth_managed WHERE account_id=9200)ok')).rows[0].ok);
 await writeFile(join(directory,'index.html'),'<!doctype html><title>天意人力资源系统</title><main>Current React entry</main>');
 attachFrontend(app.server,directory);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+app.server.address().port;
 const request=async(path,{method='GET',input,token}={})=>{const response=await fetch(origin+path,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(input?{'content-type':'application/json'}:{})},...(input?{body:JSON.stringify(input)}:{})});return{status:response.status,text:await response.text()};};
 const home=await request('/');check('standard frontend remains the current single-process entry',home.status===200&&home.text.includes('Current React entry'));
 for(const path of['/workspace','/workspace.html','/workspace.mjs','/customer-workbench.mjs','/organization-view.mjs','/api/ledgers']){
  const r=await request(path);check('historical public entry is closed: '+path,r.status===404&&!r.text.includes('Current React entry'));
 }
 check('liveness remains available without a session',(await request('/livez')).status===200);
 check('readiness remains available without a session',(await request('/readyz')).status===200);
 check('unified directory still requires authentication',(await request('/api/foundation/bootstrap')).status===401);
 const login=await request('/login',{method:'POST',input:{login:'native_boundary_hr',password}});check('named password login still issues an authenticated session',login.status===200&&!!JSON.parse(login.text).token);const token=JSON.parse(login.text).token;
 const before=(await app.db.query('SELECT count(*)::int n FROM ty_group')).rows[0].n;
 for(const[path,method,input]of[
  ['/api/foundation/groups','POST',{code:'NO_NATIVE',name:'禁止旧接口建集团'}],
  ['/api/customer-payroll/batches','GET'],['/api/hr/contracts','GET'],['/api/time/export.csv','GET'],
  ['/api/approval/decision','POST',{id:1,status:'approved'}],['/api/mcp/execute','POST',{tool:'write'}],['/api/mealice','GET'],
 ]){const r=await request(path,{method,input,token});check('coarse role cannot enter historical business path: '+path,r.status===404&&JSON.parse(r.text).error==='E_NATIVE_API_REQUIRED');}
 check('retired foundation write did not mutate native organization',(await app.db.query('SELECT count(*)::int n FROM ty_group')).rows[0].n===before);
 for(const path of['/api/me','/api/me/capabilities','/api/me/sessions'])check('exact personal endpoint remains available: '+path,(await request(path,{token})).status===200);
 const alias=await request('/api/foundation/bootstrap',{token});check('directory alias uses the current projected foundation service',alias.status===200&&Array.isArray(JSON.parse(alias.text).people));
 const native=await request('/api/v2/query/foundation.bootstrap',{token,method:'POST',input:{}});check('typed query stays available under native current authorization',native.status===200&&Array.isArray(JSON.parse(native.text).companies));
 const logout=await request('/api/me/logout',{token,method:'POST',input:{}});check('personal logout revokes the actual session',logout.status===200&&(await request('/api/me',{token})).status===401);
 console.log(JSON.stringify({suite:'cloud-native-api-boundary',driver:app.db.driver,checks,passed:checks,historical_business_writes:0,external_calls:0}));
}finally{if(app.server.listening)await new Promise(r=>{app.server.closeAllConnections();app.server.close(r);});await app.db.close();await rm(directory,{recursive:true,force:true});}
