// End-to-end foundation API tests against an isolated in-memory application.
// Only fictitious fixtures are created; no persistent preview or customer data.
import { createApp } from '../app/server.mjs';
import { hashPassword } from '../app/services/auth.mjs';

const results = [];
const rec = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const app = await createApp();
const { server, db } = app;
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await q(sql, args))[0];
let admin;
async function http(path, { token = admin, method = 'GET', data } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { non_json_response: true }; }
  return { status: response.status, body };
}
function status(name, response, expected, prerequisite = false) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  const ok = allowed.includes(response.status);
  rec(name, ok, `HTTP ${response.status}; expected ${allowed.join('/')}${response.body.error ? `; ${response.body.error}` : ''}`);
  if (!ok && prerequisite) throw new Error(`Prerequisite failed: ${name}`);
  return response.body;
}
async function create(collection, data, name = `创建 ${collection}`) {
  const r = await http(`/api/foundation/${collection}`, { method: 'POST', data });
  const body = status(name, r, [200, 201], true);
  if (!body.row?.id) throw new Error(`Missing returned row: ${collection}`);
  return body.row;
}
async function denyDb(name, sql, args) {
  try { await db.query(sql, args); rec(name, false, 'database unexpectedly accepted mutation'); }
  catch (e) { rec(name, ['23514', '55000', 'P0001'].includes(e.code), `SQLSTATE ${e.code}`); }
}

try {
  // Authentication fixtures use the existing account/credential mechanism.
  const pwd = `TestFoundation${process.pid}9`;
  for (const id of [1000, 1001, 1002, 1003]) {
    await db.query(`INSERT INTO sys_account(id,login,display_name) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3)`,
      [id, `foundation${id}`, `基础测试账号${id}`]);
    await db.query('SELECT fn_credential_set($1,$2)', [id, hashPassword(pwd)]);
  }
  await db.query(`INSERT INTO sys_data_scope(id,name,combinator) VALUES(100,'测试管理员范围','intersection') ON CONFLICT(id) DO NOTHING`);
  await db.query(`INSERT INTO sys_user_role(id,user_id,role_id,data_scope_id,effective_from)
    VALUES(999100,1000,10,100,'2020-01-01')`);
  status('未认证请求不能读新版基础', await http('/api/foundation/bootstrap', { token: null }), 401);
  const tokens = {};
  for (const id of [1000, 1001, 1002, 1003]) {
    const r = await http(`/login?user=${id}&pwd=${encodeURIComponent(pwd)}`, { token: null, method: 'POST' });
    const body = status(`账号 ${id} 通过原认证接口登录`, r, 200, true);
    if (!body.token) throw new Error('Login did not return a session');
    tokens[id] = body.token;
  }
  admin = tokens[1000];
  const initial = status('管理员可读取空基础', await http('/api/foundation/bootstrap'), 200, true);
  rec('旧演示数据没有自动冒充新版公司和集团', initial.groups.length === 0 && initial.companies.length === 0);
  status('无新版授权账号可登录但看到空基础', await http('/api/foundation/bootstrap', { token: tokens[1002] }), 200);
  status('普通账号不得生成示例集团', await http('/api/foundation/demo-seed', { token: tokens[1002], method: 'POST', data: {} }), 403);
  const seeded = status('管理员显式生成虚构示例', await http('/api/foundation/demo-seed', { method: 'POST', data: {} }), 200, true);
  rec('示例首次生成明确标记 seeded', seeded.seeded === true);
  const repeated = status('重复生成示例请求可安全完成', await http('/api/foundation/demo-seed', { method: 'POST', data: {} }), 200, true);
  rec('重复生成示例不覆盖已存在集团', repeated.seeded === false && Number(repeated.group_id) === Number(seeded.group_id));

  const boot = status('管理员读取示例完整组织', await http(`/api/foundation/bootstrap?group_id=${seeded.group_id}`), 200, true);
  const groupId = Number(seeded.group_id);
  const ca = boot.companies.find(c => c.code === 'STORE-A1');
  const cb = boot.companies.find(c => c.code === 'STORE-B1');
  const da = boot.departments.find(d => Number(d.company_id) === Number(ca.id));
  const dbb = boot.departments.find(d => Number(d.company_id) === Number(cb.id));
  const person = boot.people[0];
  rec('示例含双品牌帐套和独立门店公司', boot.ledgers.length === 2 && boot.companies.length === 3 && ca.ledger_id !== cb.ledger_id);
  rec('公司与部门是独立对象，部门归属于公司', !!da && !!dbb && !boot.departments.some(d => d.name === ca.name));

  const g2 = await create('groups', { code: 'TEST-G2', name: '测试第二集团' }, 'API 创建第二集团');
  const b2 = await create('brands', { group_id: g2.id, code: 'B2', name: '测试第二集团品牌' });
  const l2 = await create('ledgers', { group_id: g2.id, brand_id: b2.id, scope_mode: 'brand', code: 'L2', name: '测试第二集团帐套' });
  const c2 = await create('companies', { group_id: g2.id, ledger_id: l2.id, brand_id: b2.id, code: 'C2', name: '测试第二集团公司' });
  status('API 阻止跨集团公司与帐套关系', await http('/api/foundation/companies', { method: 'POST', data: { group_id: groupId, ledger_id: l2.id, code: 'WRONG', name: '错误公司' } }), [409, 422]);
  status('API 阻止跨公司部门父级', await http('/api/foundation/departments', { method: 'POST', data: { company_id: ca.id, parent_department_id: dbb.id, code: 'WRONG', name: '错误部门' } }), [409, 422]);
  const d = await create('departments', { company_id: ca.id, code: 'FRONT', name: '测试前厅部门' });
  const w1 = await create('work-areas', { company_id: ca.id, department_id: d.id, code: 'D-AREA', name: '测试部门化档口', mode: 'department_extension' });
  const w2 = await create('work-areas', { company_id: ca.id, department_id: d.id, code: 'W-AREA', name: '测试工作区域', mode: 'work_area_in_department' });
  rec('API 可保存两种档口模式且始终关联公司内部门', w1.mode === 'department_extension' && w2.mode === 'work_area_in_department' && Number(w1.department_id) === Number(d.id));
  const job = await create('jobs', { group_id: groupId, code: 'TEST-SERVER', name: '测试服务员岗位' });
  const grade = await create('grades', { group_id: groupId, code: 'TEST-L2', name: '测试二级', level: 2 });
  const pos = await create('positions', { group_id: groupId, company_id: ca.id, department_id: d.id, job_id: job.id, grade_id: grade.id, code: 'FRONT-SERVER', name: '测试前厅服务岗' });
  status('API 阻止公司岗位关联别家公司部门', await http('/api/foundation/positions', { method: 'POST', data: { group_id: groupId, company_id: ca.id, department_id: dbb.id, job_id: job.id, code: 'WRONG', name: '错误岗位' } }), [409, 422]);
  const p = await create('people', { group_id: groupId, full_name: '虚构回归人员甲' }, 'API 自动生成集团永久人员号');
  rec('人员永久号返回非空文本', typeof p.person_number === 'string' && p.person_number.length > 0);
  status('API 不允许改写永久人员编号', await http(`/api/foundation/people/${p.id}`, { method: 'PUT', data: { person_number: 'REUSED-NUMBER' } }), [400, 422]);
  const ep = await create('employments', { group_id: groupId, company_id: ca.id, person_id: p.id, hire_date: '2026-01-01', employment_type: 'FT' });
  const as = await create('assignments', { group_id: groupId, company_id: ca.id, employment_id: ep.id, department_id: d.id, position_id: pos.id, grade_id: grade.id, work_area_id: w2.id, valid_from: '2026-01-01', is_primary: true });
  const bounded = await create('assignments', { group_id:groupId,company_id:ca.id,employment_id:ep.id,department_id:d.id,position_id:pos.id,valid_from:'2026-01-05',valid_to:'2026-01-11',is_primary:false }, 'API 创建已经有末日的兼任记录');
  status('API 阻止同雇佣主任职区间重叠', await http('/api/foundation/assignments', { method: 'POST', data: { group_id: groupId, company_id: ca.id, employment_id: ep.id, department_id: d.id, position_id: pos.id, valid_from: '2026-01-02', is_primary: true } }), [409, 422]);
  status('API 结束雇佣并关闭任职', await http(`/api/foundation/employments/${ep.id}`, { method: 'PUT', data: { leave_date: '2026-01-31', status: 'ended' } }), 200, true);
  const closed = status('API 查询已关闭任职历史', await http(`/api/foundation/people/${p.id}/timeline`), 200, true);
  const ended = closed.employments.find(e => Number(e.id) === Number(ep.id));
  rec('离职含末日、任职有效期关闭在次日', String(ended.leave_date).slice(0, 10) === '2026-01-31' && String(ended.assignments.find(a => Number(a.id) === Number(as.id)).valid_to).slice(0, 10) === '2026-02-01');
  const boundedEnded=ended.assignments.find(a=>Number(a.id)===Number(bounded.id));
  rec('API 结束雇佣同时结束已有末日的任职并保留原末日', boundedEnded.status==='ended' && String(boundedEnded.valid_to).slice(0,10)==='2026-01-11');
  status('全部雇佣任职结束后公司岗位可停用', await http(`/api/foundation/positions/${pos.id}/deactivate`, {method:'POST',data:{}}), 200);
  const reh = await create('employments', { group_id: groupId, company_id: cb.id, person_id: p.id, hire_date: '2026-02-01', employment_type: 'FT', rehire_link: ep.id }, 'API 跨帐套复聘复用原人员身份');
  const reTimeline = status('API 展示同人跨帐套完整经历', await http(`/api/foundation/people/${p.id}/timeline`), 200, true);
  rec('复聘新增雇佣段，原编号和旧段保持', reTimeline.person.person_number === p.person_number && reTimeline.employments.length === 2 && Number(reh.person_id) === Number(p.id));

  const privatePerson = await create('people', { group_id: groupId, full_name: '仅乙公司可见虚构人员' });
  await create('employments', { group_id: groupId, company_id: cb.id, person_id: privatePerson.id, hire_date: '2026-02-01' });
  await create('external-identities', { group_id: groupId, person_id: person.id, source_system: 'private-B-only', source_namespace: String(cb.ledger_id), raw_id_text: '0000000999', review_status: 'verified' });
  await create('grants', { account_id: 1001, group_id: groupId, ledger_id: ca.ledger_id, company_id: ca.id, can_read: true, can_write: false, valid_from: '2020-01-01' }, 'API 为普通账号授予甲公司只读');
  const limited = status('甲公司只读账号读取授权范围', await http(`/api/foundation/bootstrap?group_id=${groupId}`, { token: tokens[1001] }), 200, true);
  rec('只读账号看不到乙公司或乙帐套', limited.companies.length === 1 && Number(limited.companies[0].id) === Number(ca.id) && limited.ledgers.length === 1 && Number(limited.ledgers[0].id) === Number(ca.ledger_id));
  rec('只读账号 bootstrap 不泄漏乙专属人员和跨店雇佣段', !limited.people.some(x => Number(x.id) === Number(privatePerson.id)) && limited.employments.every(e => Number(e.company_id) === Number(ca.id)));
  rec('只读账号不泄漏未授权帐套的来源人员编号', !limited.external_identities.some(x => x.source_system === 'private-B-only'));
  rec('只读能力与维护授权能力明确区分', limited.capabilities.can_write === false && limited.capabilities.can_manage_access === false);
  const limitedTimeline = status('甲公司只读可查询其人员的授权历史', await http(`/api/foundation/people/${person.id}/timeline`, { token: tokens[1001] }), 200, true);
  rec('人员时间线只含授权公司经历，不透露隐藏段数量', limitedTimeline.employments.length === 1 && limitedTimeline.employments.every(e => Number(e.company_id) === Number(ca.id)) && !Object.hasOwn(limitedTimeline, 'hidden_count') && !Object.hasOwn(limitedTimeline, 'total_employments'));
  status('乙公司专属人员详情对甲只读返回404', await http(`/api/foundation/people/${privatePerson.id}/timeline`, { token: tokens[1001] }), 404);
  status('只读账号不能改公司名称', await http(`/api/foundation/companies/${ca.id}`, { token: tokens[1001], method: 'PUT', data: { name: '未授权改名' } }), 403);
  status('只读账号不能伪造公司范围写部门', await http('/api/foundation/departments', { token: tokens[1001], method: 'POST', data: { company_id: cb.id, code: 'FORGED', name: '伪造范围' } }), 403);
  status('只读账号不能维护集团共享岗位', await http('/api/foundation/jobs', { token: tokens[1001], method: 'POST', data: { group_id: groupId, code: 'FORGED', name: '伪造共享岗位' } }), 403);
  status('只读账号不能维护授权', await http('/api/foundation/grants', { token: tokens[1001], method: 'POST', data: { account_id: 1001, group_id: groupId, can_read: true, can_write: true } }), 403);
  status('伪造第二集团上下文返回403', await http(`/api/foundation/bootstrap?group_id=${g2.id}`, { token: tokens[1001] }), 403);
  status('伪造乙帐套上下文返回403', await http(`/api/foundation/bootstrap?group_id=${groupId}&ledger_id=${cb.ledger_id}`, { token: tokens[1001] }), 403);
  status('未授权公司筛选返回404', await http(`/api/foundation/bootstrap?group_id=${groupId}&company_id=${cb.id}`, { token: tokens[1001] }), 404);
  await create('grants',{account_id:1003,group_id:groupId,company_id:ca.id,can_read:true,can_write:true,valid_from:'2020-01-01'},'API 配置不指定帐套的甲公司写授权');
  await create('grants',{account_id:1003,group_id:groupId,ledger_id:cb.ledger_id,can_read:true,can_write:false,valid_from:'2020-01-01'},'API 同账号配置乙帐套只读授权');
  const mixedRead=status('混合授权账号可进入乙帐套只读上下文',await http(`/api/foundation/bootstrap?group_id=${groupId}&ledger_id=${cb.ledger_id}`,{token:tokens[1003]}),200,true);
  rec('甲公司写权限不扩大乙帐套的维护UI能力',mixedRead.capabilities.can_write===false && mixedRead.capabilities.can_write_shared===false);
  const mixedWrite=status('混合授权账号可进入甲公司写上下文',await http(`/api/foundation/bootstrap?group_id=${groupId}&ledger_id=${ca.ledger_id}&company_id=${ca.id}`,{token:tokens[1003]}),200,true);
  rec('按实际公司归属保留甲公司合法维护UI能力',mixedWrite.capabilities.can_write===true && mixedWrite.capabilities.can_manage_access===false);
  status('混合授权账号仍不能写只读乙公司',await http(`/api/foundation/companies/${cb.id}`,{token:tokens[1003],method:'PUT',data:{name:'跨范围写入不应成功'}}),403);
  status('未知人员详情返回404', await http('/api/foundation/people/99999999/timeline'), 404);
  status('未知集合返回404', await http('/api/foundation/not-a-collection', { method: 'POST', data: {} }), 404);
  status('不存在的修改对象返回404', await http('/api/foundation/companies/99999999', { method: 'PUT', data: { name: '不存在' } }), 404);
  status('物理删除接口明确禁止', await http(`/api/foundation/companies/${ca.id}`, { method: 'DELETE' }), 405);
  status('有依赖的公司不能直接停用', await http(`/api/foundation/companies/${ca.id}/deactivate`, { method: 'POST', data: {} }), [409, 422]);
  const disposable = await create('departments', { company_id: ca.id, code: 'UNUSED', name: '无引用测试部门' });
  status('无依赖部门可以通过停用接口停用', await http(`/api/foundation/departments/${disposable.id}/deactivate`, { method: 'POST', data: {} }), 200);

  const dormant=await create('people',{group_id:groupId,full_name:'虚构停用状态测试',status:'inactive'},'API 新建人员显式停用状态');
  rec('新建人员不静默忽略请求的停用状态', dormant.status==='inactive');
  status('API 不允许非法人员状态假成功',await http('/api/foundation/people',{method:'POST',data:{group_id:groupId,full_name:'虚构非法状态测试',status:'dormant'}}),[400,422]);
  status('API 停用人员不能新建在职雇佣',await http('/api/foundation/employments',{method:'POST',data:{group_id:groupId,person_id:dormant.id,company_id:ca.id,hire_date:'2026-03-01'}}),[409,422]);
  const closedCompany=await create('companies',{group_id:groupId,ledger_id:ca.ledger_id,brand_id:ca.brand_id,code:'CLOSED-API',name:'虚构停用公司测试'});
  status('API 无依赖公司可以停用',await http(`/api/foundation/companies/${closedCompany.id}/deactivate`,{method:'POST',data:{}}),200);
  status('API 停用后不能再添加启用部门',await http('/api/foundation/departments',{method:'POST',data:{company_id:closedCompany.id,code:'REOPEN',name:'不应创建的启用部门'}}),[409,422]);
  status('API PUT status不能绕过公司依赖检查',await http(`/api/foundation/companies/${ca.id}`,{method:'PUT',data:{status:'inactive'}}),[409,422]);
  const governanceGroup=await create('groups',{code:'GOVERNANCE-API',name:'虚构治理测试集团'});
  const onlyBrand=await create('brands',{group_id:governanceGroup.id,code:'ONLY',name:'唯一启用品牌'});
  status('API PUT停用集团不能忽略启用品牌',await http(`/api/foundation/groups/${governanceGroup.id}`,{method:'PUT',data:{status:'inactive'}}),[409,422]);
  status('API 可先停用无依赖品牌',await http(`/api/foundation/brands/${onlyBrand.id}/deactivate`,{method:'POST',data:{}}),200);
  status('依赖关闭后集团停用成功',await http(`/api/foundation/groups/${governanceGroup.id}/deactivate`,{method:'POST',data:{}}),200);
  status('API 已停用集团不能新增启用岗位',await http('/api/foundation/jobs',{method:'POST',data:{group_id:governanceGroup.id,code:'LATE',name:'不应创建的岗位'}}),[409,422]);
  const audits = await q('SELECT id,actor_id,action FROM ty_audit ORDER BY id');
  rec('新增与修改均留下审计，包含示例和停用动作', audits.some(a => a.action === 'demo_seed') && audits.some(a => a.action === 'create') && audits.some(a => a.action === 'update') && audits.some(a => a.action === 'deactivate') && audits.every(a => Number(a.actor_id) === 1000));
  await denyDb('审计记录不允许修改', "UPDATE ty_audit SET action='tamper' WHERE id=$1", [audits[0].id]);
  await denyDb('审计记录不允许删除', 'DELETE FROM ty_audit WHERE id=$1', [audits[0].id]);
} catch (e) {
  rec('接口集成必要前置步骤完成', false, String(e.message).split('\n')[0]);
} finally {
  await new Promise(resolve => server.close(resolve));
  await db.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` [${r.detail}]` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`天意基础 API · ${results.length} 条 · 通过 ${results.length - failed} · 失败 ${failed}`);
process.exitCode = failed ? 1 : 0;
