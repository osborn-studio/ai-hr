// Pure database regression: no HTTP, no existing demo database and no personal data.
// The new migration can run independently; legacy compatibility is separately
// covered by the application's complete empty-database migration path.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

// A real PostgreSQL run must actually connect to DATABASE_URL. One connection
// preserves the same sequential query contract as the default WASM driver.
let db;
if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, value => value === null ? null : Number(value));
  pg.types.setTypeParser(1082, value => value === null ? null : new Date(`${value}T00:00:00Z`));
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  db = {
    query: (sql, args) => client.query(sql, args),
    exec: sql => client.query(sql),
    close: () => client.end(),
  };
  console.log('天意组织基础驱动：真实 PostgreSQL / pg.Client');
} else {
  db = await PGlite.create({ extensions: { btree_gist } });
  console.log('天意组织基础驱动：PGlite / WASM');
}
const results = [];
const rec = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await q(sql, args))[0];
const insert = async (table, values) => {
  const keys = Object.keys(values);
  return Number((await one(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(values))).id);
};
const reject = async (name, sql, args, expected) => {
  try { await db.query(sql, args); rec(name, false, 'unexpectedly accepted'); }
  catch (e) { rec(name, expected.includes(e.code), `${e.code} ${String(e.message).split('\n')[0]}`); }
};

try {
  await db.exec(readFileSync(fileURLToPath(new URL('../db/193_tyhr_foundation.sql', import.meta.url)), 'utf8'));
  await db.exec(readFileSync(fileURLToPath(new URL('../db/194_tyhr_foundation_governance.sql', import.meta.url)), 'utf8'));
  const g = await insert('ty_group', { code: 'TEST', name: '测试集团' });
  const other = await insert('ty_group', { code: 'OTHER', name: '另一测试集团' });
  const ba = await insert('ty_brand', { group_id: g, code: 'A', name: '测试甲品牌' });
  const bb = await insert('ty_brand', { group_id: g, code: 'B', name: '测试乙品牌' });
  const bo = await insert('ty_brand', { group_id: other, code: 'O', name: '另一测试品牌' });
  const la = await insert('ty_ledger', { group_id: g, scope_mode: 'group', code: 'GROUP', name: '测试集团帐套' });
  const lb = await insert('ty_ledger', { group_id: g, brand_id: bb, scope_mode: 'brand', code: 'BRAND', name: '测试品牌帐套' });
  const ls = await insert('ty_ledger', { group_id: g, scope_mode: 'store', code: 'STORE', name: '测试门店帐套' });
  const lo = await insert('ty_ledger', { group_id: other, scope_mode: 'group', code: 'OTHER', name: '另一集团帐套' });
  const ca = await insert('ty_company', { group_id: g, ledger_id: la, brand_id: ba, code: 'A', name: '甲经营公司' });
  const cb = await insert('ty_company', { group_id: g, ledger_id: lb, brand_id: bb, code: 'B', name: '乙经营公司' });
  const cs = await insert('ty_company', { group_id: g, ledger_id: ls, code: 'S', name: '独立门店公司' });
  const co = await insert('ty_company', { group_id: other, ledger_id: lo, brand_id: bo, code: 'A', name: '另一集团公司' });
  rec('集团、品牌、集团/品牌/门店三类帐套和公司首次可创建', !!ca && !!cb && !!cs && !!co);
  rec('门店公司无需伪造同名部门', Number((await one('SELECT count(*) n FROM ty_department')).n) === 0);
  await reject('公司不能挂到另一集团帐套', 'INSERT INTO ty_company(group_id,ledger_id,code,name) VALUES($1,$2,\'BAD\',\'错误公司\')', [g, lo], ['23503']);
  await reject('公司不能挂到另一集团品牌', 'INSERT INTO ty_company(group_id,ledger_id,brand_id,code,name) VALUES($1,$2,$3,\'BAD\',\'错误公司\')', [g, la, bo], ['23503']);
  await reject('品牌帐套拒绝另一品牌公司', 'INSERT INTO ty_company(group_id,ledger_id,brand_id,code,name) VALUES($1,$2,$3,\'BAD\',\'错误公司\')', [g, lb, ba], ['23514']);
  await reject('门店帐套拒绝第二家公司', 'INSERT INTO ty_company(group_id,ledger_id,code,name) VALUES($1,$2,\'SECOND\',\'第二公司\')', [g, ls], ['23514']);
  await reject('修改帐套类型不能绕开既有公司品牌约束', 'UPDATE ty_ledger SET scope_mode=\'brand\',brand_id=$1 WHERE id=$2', [bb, la], ['23514']);

  const da = await insert('ty_department', { company_id: ca, code: 'KITCHEN', name: '厨房部门' });
  const da2 = await insert('ty_department', { company_id: ca, parent_department_id: da, code: 'HOT', name: '热厨部门' });
  const dbb = await insert('ty_department', { company_id: cb, code: 'KITCHEN', name: '厨房部门' });
  await reject('部门父级必须属于同一公司', 'INSERT INTO ty_department(company_id,parent_department_id,code,name) VALUES($1,$2,\'BAD\',\'错误部门\')', [ca, dbb], ['23503']);
  await reject('部门调整不能形成间接循环', 'UPDATE ty_department SET parent_department_id=$1 WHERE id=$2', [da2, da], ['23514']);
  const wa = await insert('ty_work_area', { company_id: ca, department_id: da, code: 'WOK', name: '炉灶工作区', mode: 'work_area_in_department' });
  const de = await insert('ty_work_area', { company_id: ca, department_id: da2, code: 'HOT', name: '热厨档口', mode: 'department_extension' });
  rec('部门化档口和部门内工作区两种模式独立可配', !!wa && !!de);
  await reject('档口不能对应另一家公司部门', 'INSERT INTO ty_work_area(company_id,department_id,code,name,mode) VALUES($1,$2,\'BAD\',\'错误档口\',\'work_area_in_department\')', [ca, dbb], ['23503']);
  await reject('同部门不能生成两个部门化档口身份', 'INSERT INTO ty_work_area(company_id,department_id,code,name,mode) VALUES($1,$2,\'DUP\',\'重复档口\',\'department_extension\')', [ca, da2], ['23505']);

  const job = await insert('ty_job', { group_id: g, code: 'CHEF', name: '厨师' });
  const jobOther = await insert('ty_job', { group_id: other, code: 'CHEF', name: '厨师' });
  const grade = await insert('ty_grade', { group_id: g, code: 'L1', name: '一级', level: 1 });
  const pa = await insert('ty_company_position', { group_id: g, company_id: ca, department_id: da, job_id: job, grade_id: grade, code: 'CHEF', name: '甲公司厨师岗位' });
  const pb = await insert('ty_company_position', { group_id: g, company_id: cb, department_id: dbb, job_id: job, grade_id: grade, code: 'CHEF', name: '乙公司厨师岗位' });
  rec('同一标准岗位可由不同公司分别设置岗位', pa !== pb);
  await reject('公司岗位不能关联另一集团标准岗位', 'INSERT INTO ty_company_position(group_id,company_id,department_id,job_id,code,name) VALUES($1,$2,$3,$4,\'BAD\',\'错误岗位\')', [g, ca, da, jobOther], ['23503']);
  await reject('公司岗位不能关联另一家公司部门', 'INSERT INTO ty_company_position(group_id,company_id,department_id,job_id,code,name) VALUES($1,$2,$3,$4,\'BAD\',\'错误岗位\')', [g, ca, dbb, job], ['23503']);

  const person = Number((await one('SELECT fn_ty_create_person($1,$2,$3) id', [g, 'TY000001', '测试人员甲'])).id);
  const person2 = Number((await one('SELECT fn_ty_create_person($1,NULL,$2) id', [g, '测试人员乙'])).id);
  const personOther = Number((await one('SELECT fn_ty_create_person($1,$2,$3) id', [other, 'TY000001', '另一集团测试人员'])).id);
  rec('自动人员编号跳过已分配编号而不复用', (await one('SELECT person_number FROM ty_person WHERE id=$1', [person2])).person_number === 'TY000002');
  rec('不同集团可有相同展示编号但独立人员身份', person !== personOther);
  await reject('永久人员编号不得直接修改', 'UPDATE ty_person SET person_number=\'CHANGED\' WHERE id=$1', [person], ['23514']);
  await reject('人员不能改集团冒充另一身份', 'UPDATE ty_person SET group_id=$1 WHERE id=$2', [other, person], ['23514']);
  await reject('停用仍不能删除人员以复用编号', 'DELETE FROM ty_person WHERE id=$1', [person], ['23514']);
  await reject('同集团人员编号唯一', 'INSERT INTO ty_person(group_id,person_number,full_name) VALUES($1,\'TY000001\',\'错误重复人员\')', [g], ['23505']);
  const ext = await insert('ty_external_identity', { group_id: g, person_id: person, source_system: 'TEST', raw_id_text: '0000000123', review_status: 'verified' });
  rec('外部编号保留前导零且不充当永久身份', (await one('SELECT raw_id_text FROM ty_external_identity WHERE id=$1', [ext])).raw_id_text === '0000000123');
  await reject('报表序号不能核验成正式人员编号', 'INSERT INTO ty_external_identity(group_id,person_id,source_system,raw_id_text,id_kind,review_status) VALUES($1,$2,\'REPORT\',\'1\',\'report_ordinal\',\'verified\')', [g, person], ['23514']);
  await reject('来源身份不能关联另一集团人员', 'INSERT INTO ty_external_identity(group_id,person_id,source_system,raw_id_text) VALUES($1,$2,\'BAD\',\'1\')', [g, personOther], ['23503']);

  const ea = await insert('ty_employment', { group_id: g, person_id: person, company_id: ca, hire_date: '2026-01-01' });
  const ebParallel = await insert('ty_employment', { group_id: g, person_id: person, company_id: cb, hire_date: '2026-01-01', employment_type: 'part_time' });
  const a1 = await insert('ty_position_assignment', { group_id: g, company_id: ca, employment_id: ea, department_id: da, position_id: pa, grade_id: grade, work_area_id: wa, valid_from: '2026-01-01', valid_to: '2026-02-01' });
  const a2 = await insert('ty_position_assignment', { group_id: g, company_id: ca, employment_id: ea, department_id: da, position_id: pa, valid_from: '2026-02-01' });
  const parallel = await insert('ty_position_assignment', { group_id: g, company_id: cb, employment_id: ebParallel, department_id: dbb, position_id: pb, valid_from: '2026-01-01' });
  rec('同雇佣主任职右开区间首尾衔接可生效', !!a1 && !!a2);
  rec('明确并行雇佣可各自有主任职，不被全人互斥误伤', !!parallel);
  await reject('同雇佣主任职不得重叠', 'INSERT INTO ty_position_assignment(group_id,company_id,employment_id,department_id,position_id,valid_from) VALUES($1,$2,$3,$4,$5,\'2026-01-15\')', [g, ca, ea, da, pa], ['23P01']);
  const secondary = await insert('ty_position_assignment', { group_id: g, company_id: ca, employment_id: ea, department_id: da, position_id: pa, is_primary: false, valid_from: '2026-02-01' });
  rec('明确兼任不受同雇佣主任职互斥限制', !!secondary);
  await reject('任职不能借另一公司岗位越过公司边界', 'INSERT INTO ty_position_assignment(group_id,company_id,employment_id,department_id,position_id,valid_from,is_primary) VALUES($1,$2,$3,$4,$5,\'2026-02-01\',false)', [g, ca, ea, dbb, pb], ['23503']);
  await reject('任职不能早于雇佣开始', 'INSERT INTO ty_position_assignment(group_id,company_id,employment_id,department_id,position_id,valid_from,valid_to,is_primary) VALUES($1,$2,$3,$4,$5,\'2025-12-01\',\'2025-12-02\',false)', [g, ca, ea, da, pa], ['23514']);
  await reject('不能直接结束雇佣而留下无限期任职', 'UPDATE ty_employment SET leave_date=\'2026-02-28\',status=\'ended\' WHERE id=$1', [ea], ['23514']);
  await one('SELECT fn_ty_end_employment($1,$2::date)', [ea, '2026-02-28']);
  const earlierAssignment = await one('SELECT valid_to::text d,status FROM ty_position_assignment WHERE id=$1', [a1]);
  rec('结束雇佣会结束早已到期的任职，并保留其原失效日', earlierAssignment.d === '2026-02-01' && earlierAssignment.status === 'ended');
  rec('结束雇佣把任职右开末日设为离职次日', (await one('SELECT valid_to::text d,status FROM ty_position_assignment WHERE id=$1', [a2])).d === '2026-03-01');
  rec('离职当天仍在雇佣区间，次日不在', (await one("SELECT daterange(hire_date,leave_date,'[]') @> '2026-02-28'::date yes, daterange(hire_date,leave_date,'[]') @> '2026-03-01'::date no FROM ty_employment WHERE id=$1", [ea])).yes === true && (await one("SELECT daterange(hire_date,leave_date,'[]') @> '2026-03-01'::date n FROM ty_employment WHERE id=$1", [ea])).n === false);
  await reject('离职后不得添加越过末日的任职', 'INSERT INTO ty_position_assignment(group_id,company_id,employment_id,department_id,position_id,valid_from,is_primary) VALUES($1,$2,$3,$4,$5,\'2026-03-01\',false)', [g, ca, ea, da, pa], ['23514']);
  const rehire = await insert('ty_employment', { group_id: g, person_id: person, company_id: cb, hire_date: '2026-04-01', rehire_link: ea });
  rec('复聘创建新雇佣段并复用集团person_id', rehire !== ea && Number((await one('SELECT person_id FROM ty_employment WHERE id=$1', [rehire])).person_id) === person);
  await reject('复聘链接不能指向另一人经历', 'INSERT INTO ty_employment(group_id,person_id,company_id,hire_date,rehire_link) VALUES($1,$2,$3,\'2026-04-01\',$4)', [g, person2, cb, ea], ['23514']);
  await reject('复聘不能早于上次离职次日', 'INSERT INTO ty_employment(group_id,person_id,company_id,hire_date,rehire_link) VALUES($1,$2,$3,\'2026-02-28\',$4)', [g, person, cb, ea], ['23514']);
  await reject('雇佣不能把另一集团人员挂入本集团公司', 'INSERT INTO ty_employment(group_id,person_id,company_id,hire_date) VALUES($1,$2,$3,\'2026-01-01\')', [g, personOther, ca], ['23503']);
  const timeline = (await one('SELECT fn_ty_person_timeline($1) data', [person])).data;
  rec('内部人员时间线包含跨帐套经历且保留同一人员编号', timeline.person.person_number === 'TY000001' && timeline.employments.length === 3 && new Set(timeline.employments.map(e => e.ledger_id)).size === 2);

  const grant = await insert('ty_access_grant', { account_id: 999, group_id: g, ledger_id: la, company_id: ca, can_read: true, can_write: true, valid_from: '2026-01-01' });
  rec('授权可限定到集团/帐套/公司，账号存在由服务验证', !!grant);
  await reject('授权不能混另一集团帐套', 'INSERT INTO ty_access_grant(account_id,group_id,ledger_id) VALUES(999,$1,$2)', [g, lo], ['23503']);
  await reject('授权不能把公司绑定到错误帐套', 'INSERT INTO ty_access_grant(account_id,group_id,ledger_id,company_id) VALUES(999,$1,$2,$3)', [g, la, cb], ['23503']);
  await reject('授权写权限必须伴随读权限', 'INSERT INTO ty_access_grant(account_id,group_id,can_read,can_write) VALUES(999,$1,false,true)', [g], ['23514']);
  await reject('授权失效日必须晚于生效日', 'INSERT INTO ty_access_grant(account_id,group_id,valid_from,valid_to) VALUES(999,$1,\'2026-02-01\',\'2026-02-01\')', [g], ['23514']);
  await reject('公司身份不能迁入另一集团', 'UPDATE ty_company SET group_id=$1,ledger_id=$2,brand_id=NULL WHERE id=$3', [other,lo,cs], ['23514']);
  await reject('帐套不能迁入另一集团', 'UPDATE ty_ledger SET group_id=$1 WHERE id=$2', [other,ls], ['23514']);
  await reject('部门不能直接改成另一家公司部门', 'UPDATE ty_department SET company_id=$1,parent_department_id=NULL WHERE id=$2', [cb,da2], ['23514']);
  await reject('有历史的雇佣不能改写为另一人员', 'UPDATE ty_employment SET person_id=$1 WHERE id=$2', [person2,ea], ['23514']);
  await reject('雇佣不能直接改写为另一家公司', 'UPDATE ty_employment SET company_id=$1 WHERE id=$2', [ca,rehire], ['23514']);
  await reject('历史离职末日不能与已存在复聘重叠', 'UPDATE ty_employment SET leave_date=\'2026-04-02\' WHERE id=$1', [ea], ['23514']);

  // Governance is enforced at the database boundary, including direct SQL and
  // status reactivation, not just the HTTP deactivate command.
  for (const [table, kind] of [['ty_brand','brands'],['ty_job','jobs'],['ty_grade','grades']]) {
    const isolatedGroup = await insert('ty_group', { code: `DEPENDENCY-${kind}`, name: '停用依赖测试集团' });
    await insert(table, { group_id: isolatedGroup, code: 'ONLY', name: '唯一启用依赖' });
    await reject(`集团不能忽略启用的${kind}依赖停用`, 'SELECT fn_ty_deactivate(\'groups\',$1)', [isolatedGroup], ['23514']);
    await reject(`直接SQL也不能绕过${kind}依赖停用集团`, 'UPDATE ty_group SET status=\'inactive\' WHERE id=$1', [isolatedGroup], ['23514']);
  }
  await reject('直接SQL不能停用仍有启用部门的公司', 'UPDATE ty_company SET status=\'inactive\' WHERE id=$1', [ca], ['23514']);
  const inactiveGroup = await insert('ty_group', { code: 'CLOSED', name: '停用测试集团', status: 'inactive' });
  const inactiveBrand = await insert('ty_brand', { group_id: g, code: 'CLOSED', name: '停用品牌', status: 'inactive' });
  const inactiveLedger = await insert('ty_ledger', { group_id: g, scope_mode: 'group', code: 'CLOSED', name: '停用帐套', status: 'inactive' });
  const inactiveCompany = await insert('ty_company', { group_id: g, ledger_id: la, code: 'CLOSED', name: '停用公司', status: 'inactive' });
  const inactiveDepartment = await insert('ty_department', { company_id: ca, code: 'CLOSED', name: '停用部门', status: 'inactive' });
  const inactiveJob = await insert('ty_job', { group_id: g, code: 'CLOSED', name: '停用标准岗', status: 'inactive' });
  const inactiveGrade = await insert('ty_grade', { group_id: g, code: 'CLOSED', name: '停用职级', status: 'inactive' });
  const inactiveArea = await insert('ty_work_area', { company_id: ca, department_id: da, code: 'CLOSED', name: '停用区域', mode: 'work_area_in_department', status: 'inactive' });
  const inactivePosition = await insert('ty_company_position', { group_id: g, company_id: ca, department_id: da, job_id: job, code: 'CLOSED', name: '停用公司岗', status: 'inactive' });
  const inactivePerson = await insert('ty_person', { group_id: g, person_number: 'INACTIVE', full_name: '停用身份测试', status: 'inactive' });
  await reject('不能在停用集团新增启用品牌', 'INSERT INTO ty_brand(group_id,code,name) VALUES($1,\'NEW\',\'新品牌\')', [inactiveGroup], ['23514']);
  await reject('不能在停用集团新增启用帐套', 'INSERT INTO ty_ledger(group_id,code,name,scope_mode) VALUES($1,\'NEW\',\'新帐套\',\'group\')', [inactiveGroup], ['23514']);
  await reject('启用公司不能引用停用帐套', 'INSERT INTO ty_company(group_id,ledger_id,code,name) VALUES($1,$2,\'NEW-L\',\'新公司\')', [g,inactiveLedger], ['23514']);
  await reject('启用公司不能引用停用品牌', 'INSERT INTO ty_company(group_id,ledger_id,brand_id,code,name) VALUES($1,$2,$3,\'NEW-B\',\'新公司\')', [g,la,inactiveBrand], ['23514']);
  await reject('停用公司不能新增启用部门', 'INSERT INTO ty_department(company_id,code,name) VALUES($1,\'NEW\',\'新部门\')', [inactiveCompany], ['23514']);
  await reject('停用部门不能新增启用子部门', 'INSERT INTO ty_department(company_id,parent_department_id,code,name) VALUES($1,$2,\'NEW\',\'子部门\')', [ca,inactiveDepartment], ['23514']);
  await reject('工作区域不能引用停用部门', 'INSERT INTO ty_work_area(company_id,department_id,code,name,mode) VALUES($1,$2,\'NEW\',\'新区域\',\'work_area_in_department\')', [ca,inactiveDepartment], ['23514']);
  await reject('公司岗位不能引用停用标准岗位', 'INSERT INTO ty_company_position(group_id,company_id,department_id,job_id,code,name) VALUES($1,$2,$3,$4,\'NEW-J\',\'新岗位\')', [g,ca,da,inactiveJob], ['23514']);
  await reject('公司岗位不能引用停用职级', 'INSERT INTO ty_company_position(group_id,company_id,department_id,job_id,grade_id,code,name) VALUES($1,$2,$3,$4,$5,\'NEW-G\',\'新岗位\')', [g,ca,da,job,inactiveGrade], ['23514']);
  await reject('停用人员不能直接新建在职雇佣', 'INSERT INTO ty_employment(group_id,person_id,company_id,hire_date) VALUES($1,$2,$3,\'2026-05-01\')', [g,inactivePerson,ca], ['23514']);
  await reject('停用公司不能直接新建在职雇佣', 'INSERT INTO ty_employment(group_id,person_id,company_id,hire_date) VALUES($1,$2,$3,\'2026-05-01\')', [g,person2,inactiveCompany], ['23514']);
  const liveEmployment = await insert('ty_employment', { group_id:g,person_id:person2,company_id:ca,hire_date:'2026-05-01' });
  await reject('在职任职不能引用停用公司岗位', 'INSERT INTO ty_position_assignment(group_id,company_id,employment_id,department_id,position_id,valid_from) VALUES($1,$2,$3,$4,$5,\'2026-05-01\')', [g,ca,liveEmployment,da,inactivePosition], ['23514']);
  await reject('在职任职不能引用停用工作区域', 'INSERT INTO ty_position_assignment(group_id,company_id,employment_id,department_id,position_id,work_area_id,valid_from) VALUES($1,$2,$3,$4,$5,$6,\'2026-05-01\')', [g,ca,liveEmployment,da,pa,inactiveArea], ['23514']);
  const archivedDepartment = await insert('ty_department', { company_id:inactiveCompany,code:'ARCHIVE',name:'历史部门',status:'inactive' });
  await reject('重新启用子部门同样必须验证父公司启用状态', 'UPDATE ty_department SET status=\'active\' WHERE id=$1', [archivedDepartment], ['23514']);
  const historicEmployment = await insert('ty_employment', { group_id:g,person_id:inactivePerson,company_id:inactiveCompany,hire_date:'2025-01-01',leave_date:'2025-01-31',status:'ended' });
  rec('停用公司及人员仍允许保存已结束的历史雇佣', !!historicEmployment);
  const futureAssignment = await insert('ty_position_assignment', {group_id:g,company_id:ca,employment_id:liveEmployment,department_id:da,position_id:pa,valid_from:'2026-06-01',is_primary:false});
  await one('SELECT fn_ty_end_employment($1,$2::date)', [liveEmployment,'2026-05-31']);
  rec('结束雇佣仍取消未来尚未开始的任职', (await one('SELECT status FROM ty_position_assignment WHERE id=$1',[futureAssignment])).status==='cancelled');
} finally {
  await db.close();
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` [${r.detail}]` : ''}`);
const failed = results.filter(r => !r.ok).length;
console.log(`天意组织基础 · ${results.length} 条 · 通过 ${results.length - failed} · 失败 ${failed}`);
process.exitCode = failed ? 1 : 0;
