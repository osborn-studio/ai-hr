// Username login extends the existing credential and lockout transaction paths.
// Fixtures are fictional and created only in an isolated disposable app database.
import assert from 'node:assert/strict';
import {createApp} from '../app/server.mjs';
import {hashPassword} from '../app/services/auth.mjs';
import {canOpenRoute} from '../app/workspace-permissions.mjs';
const {db,server}=await createApp();let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('PASS '+name);};
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
async function post(body,path='/login'){
  const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}
async function get(path,token){const r=await fetch(base+path,{headers:token?{authorization:`Bearer ${token}`}:{}});return{status:r.status,body:await r.json()};}
const password='SyntheticLogin2026';
try{
  await db.query(`INSERT INTO sys_account(id,login,display_name,status) OVERRIDING SYSTEM VALUE
    VALUES(3100,'login_test_full','虚构登录全权测试','active'),(3101,'login_test_reader','虚构登录只读测试','active'),(3102,'login_test_disabled','虚构停用账号','disabled')`);
  await db.query("INSERT INTO sys_role(id,code,name) VALUES(3101,'login_test_read_role','虚构登录只读角色')");
  await db.query("INSERT INTO sys_role_resource(role_id,resource_code,can_read,can_write) VALUES(3101,'payslip',true,false)");
  for(const [user,role] of [[3100,10],[3101,3101]])await db.query(`INSERT INTO sys_user_role(user_id,role_id,data_scope_id,effective_from,grant_kind,grant_reason)
    VALUES($1,$2,(SELECT min(id) FROM sys_data_scope),'2020-01-01','ROLE','独立虚构登录测试')`,[user,role]);
  for(const user of [3100,3101,3102])await db.query('SELECT fn_credential_set($1,$2)',[user,hashPassword(password)]);
  const named=await post({login:'login_test_full',password});check('JSON账号名登录成功',named.status===200&&typeof named.body.token==='string');
  const me=await get('/api/me',named.body.token);check('账号名映射到真实会话账号',me.status===200&&Number(me.body.id)===3100&&me.body.login==='login_test_full');
  const byId=await post({login:'3100',password});check('JSON账号框也接受旧账号编号',byId.status===200);
  const legacy=await fetch(base+`/login?user=3100&pwd=${password}`,{method:'POST'});check('旧编号query登录保持可用',legacy.status===200);
  const absent=await post({login:'login_test_missing',password}),wrong=await post({login:'login_test_full',password:'WrongSynthetic2026'});
  check('不存在与口令错误均为统一401',absent.status===401&&wrong.status===401&&absent.body.error==='E_AUTH_BAD_CREDENTIAL'&&wrong.body.error===absent.body.error);
  check('不存在与口令错误不泄露不同提示',absent.body.message===wrong.body.message);
  check('名称中的SQL片段不改变认证结果',(await post({login:"' OR 1=1 --",password})).status===401);
  check('停用账号不能用名称登录',(await post({login:'login_test_disabled',password})).status===401);
  check('停用账号不能绕过名称改用旧编号登录',(await fetch(base+`/login?user=3102&pwd=${password}`,{method:'POST'})).status===401);
  check('结构化登录拒绝空账号',(await post({login:'',password})).status===400);
  check('结构化登录拒绝非字符串口令',(await post({login:'login_test_full',password:{value:password}})).status===400);
  check('结构化登录拒绝损坏JSON',(await post('{broken')).status===400);
  check('能力查询要求真实会话',(await get('/api/me/capabilities')).status===401);
  const full=await get('/api/me/capabilities',named.body.token);check('能力来自真实岗位资源授权',full.status===200&&full.body.resources.ledger.can_write&&full.body.resources.payroll_run.can_write);
  check('未绑定员工的功能账号不伪造本人身份',full.body.has_person===false);
  const reader=await post({login:'login_test_reader',password}),caps=await get('/api/me/capabilities',reader.body.token);
  check('只读账号只收到本人有效资源权限',caps.status===200&&caps.body.resources.payslip.can_read&&!caps.body.resources.payslip.can_write&&!caps.body.resources.ledger.can_write);
  const logout=await fetch(base+'/api/me/logout',{method:'POST',headers:{authorization:`Bearer ${reader.body.token}`}});
  check('退出只吊销当前已认证会话',logout.status===200&&(await logout.json()).revoked===true);
  check('退出后原令牌不能继续读取身份',(await get('/api/me',reader.body.token)).status===401);
  await db.query('SELECT fn_credential_set($1,$2)',[3100,hashPassword(password)]);
  for(let i=0;i<5;i++)await post({login:'login_test_full',password:'WrongSynthetic'+i});
  check('名称登录沿用五次失败锁定',(await post({login:'login_test_full',password})).status===423);
  const legacyLocked=await fetch(base+`/login?user=3100&pwd=${password}`,{method:'POST'});check('名称与编号登录共用同一锁定状态',legacyLocked.status===423);
  const cap=(profile,resources,person=false)=>({profile_code:profile,resources:Object.fromEntries(resources.map(([code,write=false])=>[code,{can_read:true,can_write:write}])),has_person:person});
  const admin=cap('config_admin',[['ledger',true]]);
  check('配置admin有组织和授权菜单',canOpenRoute('companies',admin)&&canOpenRoute('grants',admin));
  check('配置admin没有人员工资绩效和业务初始化菜单',!canOpenRoute('people',admin)&&!canOpenRoute('customer-payroll',admin)&&!canOpenRoute('customer-performance',admin)&&!canOpenRoute('foundation-import',admin)&&!canOpenRoute('foundation-bridge',admin));
  const boss=cap('boss',[['people_read_all'],['employee_roster'],['payroll_run'],['payroll_slips_read_all'],['perf_cycle'],['report'],['ledger']]);
  check('老板拥有业务查看菜单而没有系统授权菜单',canOpenRoute('customer-payroll',boss)&&canOpenRoute('customer-performance',boss)&&!canOpenRoute('grants',boss));
  const employee=cap('station_staff',[['people_self'],['training_self',true],['payslip'],['leave_request',true]],true);
  check('档口员工有本人档案工资学习和假期菜单',canOpenRoute('people',employee)&&canOpenRoute('my-payroll',employee)&&canOpenRoute('my-training',employee)&&canOpenRoute('my-leave',employee));
  check('档口员工不出现管理培训整批薪酬菜单',!canOpenRoute('legacy-training',employee)&&!canOpenRoute('customer-payroll',employee)&&!canOpenRoute('customer-performance',employee));
  check('没有资源权限即使带角色标签也不开放业务',!canOpenRoute('customer-payroll',cap('demo',[])));
  console.log(`账号名登录与菜单 · ${checks} 条通过 · 驱动 ${db.driver}`);
}finally{await new Promise(r=>server.close(r));await db.close();}
