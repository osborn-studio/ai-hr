// Explicit read-only verification against an already running owned V10 demo.
// Serves a new frontend build privately; never changes its server or database.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const runtimeFile=process.env.TYHR_UI_READONLY_RUNTIME_FILE,source=resolve(import.meta.dirname,'../..');
assert.ok(runtimeFile,'An explicit read-only runtime file is required');
const runtime=JSON.parse(await readFile(runtimeFile,'utf8'));
assert.equal(runtime.synthetic_only,true);assert.equal(runtime.database,'tyhr_cloud_demo_20261117_v10');assert.equal(runtime.prepared_through,238);
const dbUrl=new URL(runtime.database_url);assert.equal(dbUrl.pathname,'/'+runtime.database);assert.ok(['127.0.0.1','localhost','[::1]'].includes(dbUrl.hostname));
const upstream='http://127.0.0.1:'+runtime.port;
const password=process.env.TYHR_OPERATOR_INITIAL_PASSWORD;assert.ok(password,'The credential must be supplied privately through the process environment');
const dist=resolve(process.env.TYHR_TEST_FRONTEND_DIST||resolve(source,'dist'));
const artifacts=resolve(process.env.TYHR_UI_ARTIFACTS||resolve(source,'test-artifacts/published-workflow'));
await mkdir(artifacts,{recursive:true});
const {createDb,withTx}=await import(pathToFileURL(resolve(source,'app/db.mjs'))),{domainOperations}=await import(pathToFileURL(resolve(source,'app/cloud-api.mjs'))),db=await createDb({url:runtime.database_url});
const checks=[],errors=[],commands=[],external=[],queries=[];
const check=(name,valid)=>{assert.ok(valid,name);checks.push(name);};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
let browser;
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/v2/command/')||url.pathname.startsWith('/api/command/')){commands.push(url.pathname);res.writeHead(403);res.end();return;}
  if(url.pathname.startsWith('/api/')||url.pathname==='/login'){
   if(!['GET','HEAD'].includes(req.method)&&url.pathname!=='/login'&&!url.pathname.startsWith('/api/v2/query/')){commands.push(url.pathname);res.writeHead(403);res.end();return;}
   const headers=Object.fromEntries(Object.entries(req.headers).filter(([k])=>!['host','connection','content-length'].includes(k))),parts=[];for await(const part of req)parts.push(part);const raw=Buffer.concat(parts);
   if(url.pathname==='/api/v2/query/system.workspace'){
    const me=await fetch(upstream+'/api/me',{headers:{authorization:req.headers.authorization||''},redirect:'error'});if(!me.ok){res.writeHead(me.status);res.end();return;}const actor=await me.json(),input=JSON.parse(raw.toString()||'{}');
    const result=await withTx(db,async t=>{await t.query('SET TRANSACTION READ ONLY');const state=(await t.query("SELECT current_database() database,current_setting('transaction_read_only') readonly")).rows[0];assert.equal(state.database,runtime.database);assert.equal(state.readonly,'on');return domainOperations()['system.workspace'].run(t,input,{userId:actor.id});});
    queries.push({input,result});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));return;
   }
   const response=await fetch(upstream+url.pathname+url.search,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:raw}:{}),redirect:'error'});res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'});res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  const file=url.pathname.startsWith('/assets/')?resolve(dist,'.'+url.pathname):resolve(dist,'index.html');assert.ok(file.startsWith(dist+'/'));
  const data=await readFile(file);res.writeHead(200,{'content-type':({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)]||'application/octet-stream'});res.end(data);
 }catch(error){errors.push(error.message);res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'UI_READONLY_CHECK',message:error.message}));}
});
try{
 const admin=await withTx(db,async t=>{await t.query('SET TRANSACTION READ ONLY');return(await t.query("SELECT a.login FROM sys_account a JOIN ty_test_account_profile p ON p.account_id=a.id WHERE p.profile_code='config_admin'AND a.status='active'ORDER BY a.id LIMIT 1")).rows[0];});assert.ok(admin?.login);
 const before=await withTx(db,async t=>{await t.query('SET TRANSACTION READ ONLY');return(await t.query('SELECT id,graph FROM ty_workflow_definition ORDER BY id')).rows;});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({channel:'chrome',headless:true});
 for(const[device,viewport]of[['pc',{width:1440,height:1000}],['phone',{width:393,height:852}]]){
  const page=await browser.newPage({viewport});page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'&&/TypeError|NaN|ErrorBoundary|Uncaught/.test(message.text()))errors.push(message.text());});
  await page.route('**/*',route=>{const u=new URL(route.request().url());if(['data:','blob:'].includes(u.protocol)||u.origin===origin)return route.continue();external.push(u.origin);return route.abort();});
  await page.goto(origin);await page.getByLabel('账号',{exact:true}).fill(admin.login);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'进入工作台',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();
  await page.goto(origin+'/#system/access');await page.getByRole('heading',{name:'操作人员',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.loading'));
  const operators=queries.findLast(q=>q.input.kind==='permissions'&&(q.input.view||'operators')==='operators')?.result.rows;assert.ok(operators?.length);
  const bound=operators.filter(row=>row.person_id!=null);check(device+' actual configuration directory returns canonical personnel bindings',bound.length>0);
  const text=await page.locator('main').innerText();check(device+' bound person is rendered rather than marked unbound',bound.every(row=>text.includes(row.person_number||'#'+row.person_id)));
  await page.goto(origin+'/#work');await page.getByRole('heading',{name:'操作人员与权限',exact:true}).waitFor({state:'hidden'});await page.goto(origin+'/#system/workflow');await page.getByRole('button',{name:'查看版本',exact:true}).first().click();await page.getByRole('dialog',{name:'审批流设计',exact:true}).waitFor();await page.locator('svg.workflow-canvas').waitFor();
  const published=queries.findLast(q=>q.input.kind==='workflows'&&q.input.view==='definitions')?.result.rows.find(row=>row.status==='published');assert.ok(published);
  check(device+' uses a genuine published graph with optional names or coordinates omitted',published.graph.nodes.some(node=>!node.label||!Number.isFinite(node.x)||!Number.isFinite(node.y)));
  check(device+' all published nodes draw',await page.locator('.workflow-node').count()===published.graph.nodes.length);
  const drawing=await page.locator('svg.workflow-canvas').evaluate(svg=>({box:svg.getAttribute('viewBox'),labels:[...svg.querySelectorAll('.node-title')].map(x=>x.textContent),attributes:[...svg.querySelectorAll('[transform],path[d]')].map(x=>x.getAttribute('transform')||x.getAttribute('d'))}));
  check(device+' finite SVG dimensions and edges',!drawing.attributes.some(x=>/undefined|NaN/.test(x))&&!/undefined|NaN/.test(drawing.box));check(device+' every node has a readable name',drawing.labels.every(x=>x.trim()&&!/undefined/.test(x)));
  if(device==='pc'){await page.locator('.workflow-node').nth(1).click();check(device+' published node properties stay read only',await page.getByLabel('节点名称',{exact:true}).isDisabled());}else{check(device+' canvas keeps horizontal scrolling for the full published graph',await page.locator('.workflow-canvas-scroll').evaluate(el=>el.scrollWidth>el.clientWidth));}
  await page.screenshot({path:resolve(artifacts,'published-'+device+'.png'),fullPage:false});await page.close();
 }
 const after=await withTx(db,async t=>{await t.query('SET TRANSACTION READ ONLY');return(await t.query('SELECT id,graph FROM ty_workflow_definition ORDER BY id')).rows;});check('authoritative workflow graph bytes are unchanged',hash(before)===hash(after));check('no business commands or external calls',commands.length===0&&external.length===0);if(errors.length)console.error(JSON.stringify({runtime_errors:errors}));check('no runtime or SVG errors',errors.length===0);
 await writeFile(resolve(artifacts,'checks.json'),JSON.stringify({suite:'published-workflow-current-readonly',passed:checks.length,checks,source_commit:runtime.source_commit,actual_database:runtime.database,read_only_transaction:true,business_commands:commands.length,external_calls:external.length,errors},null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:checks.length,read_only_transaction:true,business_commands:0,external_calls:0}));
}finally{await browser?.close();if(server.listening)await new Promise(done=>server.close(done));await db.close();}
