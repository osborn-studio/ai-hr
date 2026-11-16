// New company/organization domain. Legacy business modules remain independently authorized.
import { bizErr } from '../errors.mjs';
import { personaFor } from './persona-guard.mjs';

const COLLECTIONS = {
  groups: ['ty_group', ['code','name','status']],
  brands: ['ty_brand', ['group_id','code','name','region_code','currency_code','status']],
  ledgers: ['ty_ledger', ['group_id','brand_id','scope_mode','code','name','region_code','currency_code','parent_ledger_id','status']],
  companies: ['ty_company', ['group_id','ledger_id','brand_id','code','name','company_kind','org_level','parent_company_id','legal_name','address','status']],
  departments: ['ty_department', ['company_id','parent_department_id','code','name','status']],
  'work-areas': ['ty_work_area', ['company_id','department_id','mode','code','name','status']],
  jobs: ['ty_job', ['group_id','code','name','job_family','status']],
  grades: ['ty_grade', ['group_id','code','name','level','status']],
  positions: ['ty_company_position', ['group_id','company_id','department_id','job_id','grade_id','parent_position_id','code','name','status']],
  people: ['ty_person', ['group_id','person_number','full_name','status']],
  'external-identities': ['ty_external_identity', ['group_id','person_id','source_system','source_namespace','raw_id_text','id_kind','review_status','valid_from','valid_to']],
  employments: ['ty_employment', ['group_id','person_id','company_id','legal_subject_name','employment_type','hire_date','leave_date','rehire_link','status']],
  assignments: ['ty_position_assignment', ['group_id','company_id','employment_id','department_id','position_id','grade_id','work_area_id','is_primary','valid_from','valid_to','status']],
  grants: ['ty_access_grant', ['account_id','group_id','ledger_id','company_id','can_read','can_write','valid_from','valid_to']],
};
const SHARED = new Set(['brands','ledgers','jobs','grades','people','external-identities']);
const eq = (a,b) => String(a) === String(b);
const deny = (message='当前账号没有该集团、帐套或公司的操作授权') => { throw bizErr('E_TY_FORBIDDEN',message); };
const notFound = () => { throw bizErr('E_TY_NOT_FOUND','记录不存在，或不在你的授权范围内'); };
const bad = message => { throw bizErr('E_TY_ARGUMENT',message); };
export const RESOURCES = ['ledger'];

export async function accessFor(tx, userId) {
  const admin = !!(await tx.query("SELECT fn_role_can($1,'ledger','write') ok",[userId])).rows[0].ok;
  const hasBusinessTimezone=(await tx.query("SELECT to_regprocedure('public.app_tz()') IS NOT NULL ok")).rows[0].ok;
  const timezone=hasBusinessTimezone?(await tx.query('SELECT app_tz() tz')).rows[0].tz:'Asia/Shanghai';
  const grants = (await tx.query(`SELECT * FROM ty_access_grant WHERE account_id=$1 AND can_read
    AND valid_from<=(clock_timestamp() AT TIME ZONE $2)::date
    AND (valid_to IS NULL OR (clock_timestamp() AT TIME ZONE $2)::date<valid_to)`,[userId,timezone])).rows;
  const persona=await personaFor(tx,userId);
  const platformAdmin=admin&&persona?.profile_code!=='group_hr_director';
  const companyTree=(await tx.query(`SELECT c.id,(to_jsonb(c)->>'parent_company_id')::bigint parent_company_id FROM ty_company c`)).rows;
  const ledgerTree=(await tx.query(`SELECT l.id,(to_jsonb(l)->>'parent_ledger_id')::bigint parent_ledger_id FROM ty_ledger l`)).rows;
  const within=(tree,id,root,key)=>{const seen=new Set();while(id&&!seen.has(String(id))){if(eq(id,root))return true;seen.add(String(id));id=tree.find(x=>eq(x.id,id))?.[key];}return false;};
  const selfOnly=!!persona&&['store_staff','station_staff','outsourced_staff'].includes(persona.profile_code);
  return {
    admin, platformAdmin, grants, persona, userId, selfOnly, selfPersonId:selfOnly?persona.person_id:null,
    canEmploymentWrite:!!(await tx.query("SELECT fn_role_can($1,'employment_manage','write') ok",[userId])).rows[0].ok,
    group(gid, write=false) { return platformAdmin || (!write&&persona?.profile_code==='vendor_contact'&&eq(persona.group_id,gid)) || grants.some(g=>eq(g.group_id,gid) && (!write || g.can_write)); },
    shared(gid,write=false) { return platformAdmin || grants.some(g=>eq(g.group_id,gid) && (!write || (g.can_write && !g.ledger_id && !g.company_id))); },
    row(row,write=false) { return platformAdmin || grants.some(g=>eq(g.group_id,row.group_id) && (!write || g.can_write)
      && (!g.ledger_id || within(ledgerTree,row.ledger_id,g.ledger_id,'parent_ledger_id')) && (!g.company_id || within(companyTree,row.company_id ?? row.id,g.company_id,'parent_company_id'))); },
  };
}
async function withContext(tx, collection, row) {
  if (collection==='groups') return {...row,group_id:row.id};
  if (['departments','work-areas'].includes(collection)) {
    const c=(await tx.query('SELECT * FROM ty_company WHERE id=$1',[row.company_id])).rows[0];
    if (!c) bad('请先选择有效的公司');
    return {...row,group_id:c.group_id,ledger_id:c.ledger_id};
  }
  if (row.company_id) {
    const c=(await tx.query('SELECT * FROM ty_company WHERE id=$1',[row.company_id])).rows[0];
    if (!c) bad('请先选择有效的公司');
    if (row.group_id && !eq(row.group_id,c.group_id)) bad('公司与集团不一致');
    return {...row,group_id:c.group_id,ledger_id:c.ledger_id};
  }
  if(collection==='companies') return {...row,company_id:row.id};
  return row;
}
async function check(tx, access, collection, row, write) {
  if(write&&access.persona) {
    if(['groups','brands','ledgers','grants'].includes(collection)&&!['config_admin','demo','group_hr_director'].includes(access.persona.profile_code))deny('集团品牌帐套与授权仅由系统配置岗位维护');
    if(['people','external-identities','employments','assignments'].includes(collection)&&!access.canEmploymentWrite)deny('人员与雇佣业务维护需要人事岗位写权限');
    if(!['people','external-identities','employments','assignments','groups','brands','ledgers','grants'].includes(collection)&&!['config_admin','demo','hr_manager','group_hr_director','company_hr_director'].includes(access.persona.profile_code))deny('组织岗位配置需要系统配置或HR主管授权');
  }

  if(collection==='groups') { if(!access.admin || (!access.platformAdmin&&(!row.id||!access.group(row.id,true)))) deny('只能维护已授权集团'); return; }
  if(collection==='grants') { if(!access.admin||!access.group(row.group_id,true)) deny('只能维护本集团授权'); return; }
  const ctx=await withContext(tx,collection,row);
  if(write&&['people','external-identities'].includes(collection)&&access.persona?.profile_code==='company_hr_director'){
    if(!access.group(ctx.group_id,true))deny();
    const pid=collection==='people'?ctx.id:ctx.person_id;
    if(!pid){if(collection==='external-identities')deny('请关联本公司人员');return ctx;}
    const employments=(await tx.query(`SELECT e.*,c.ledger_id FROM ty_employment e JOIN ty_company c ON c.id=e.company_id WHERE e.person_id=$1 AND e.status<>'cancelled'AND e.hire_date<=app_today()AND(e.leave_date IS NULL OR e.leave_date>=app_today())`,[pid])).rows;
    const pending=(await tx.query(`SELECT EXISTS(SELECT 1 FROM ty_audit a WHERE a.actor_id=$1 AND a.action='create'AND a.entity_kind='people'AND a.entity_id=$2 AND NOT EXISTS(SELECT 1 FROM ty_employment WHERE person_id=$2))ok`,[access.userId,pid])).rows[0].ok;
    if(!pending&&!employments.some(e=>access.row(e,true)))deny('只能维护本公司当前人员或本人新建的待入职档案');return ctx;
  }
  if(SHARED.has(collection)) { if(!access.shared(ctx.group_id,write)) deny('共享主档的维护需要集团级授权'); }
  else if(!access.row(ctx,write)) deny();
  return ctx;
}
function payload(collection, input) {
  if(!input || Array.isArray(input) || typeof input!=='object') bad('请提交对象格式的数据');
  const fields=COLLECTIONS[collection]?.[1]; if(!fields) notFound();
  const out={};
  for(const k of fields) if(Object.hasOwn(input,k)) {
    let v=input[k];
    if(v==='') v=null;
    if(v!==null && (k==='group_id'||k.endsWith('_id')||k==='rehire_link'||k==='level')) {
      if(!Number.isSafeInteger(Number(v)) || (k!=='level' && Number(v)<=0)) bad(`${k}必须是有效整数`);
      v=Number(v);
    } else if(['can_read','can_write','is_primary'].includes(k)) {
      if(typeof v!=='boolean') bad(`${k}必须是真或假`);
    } else if(v!==null) {
      if(typeof v!=='string') bad(`${k}应为文本`);
      v=v.trim(); if(v.length>500) bad('单个字段长度不能超过500个字符');
    }
    out[k]=v;
  }
  return out;
}
export async function bootstrap(tx,{userId,groupId,ledgerId,companyId}) {
  const access=await accessFor(tx,userId);
  if(['vendor_contact','outsource_hr'].includes(access.persona?.profile_code)){
    const gid=access.persona.group_id;if(groupId&&!eq(groupId,gid))deny();
    const groups=(await tx.query('SELECT id,code,name,status FROM ty_group WHERE id=$1',[gid])).rows;
    return{groups,brands:[],ledgers:[],companies:[],departments:[],work_areas:[],jobs:[],grades:[],positions:[],people:[],employments:[],assignments:[],grants:[],accounts:[],external_identities:[],capabilities:{can_write:false,can_manage_access:false,can_create_group:false,can_write_shared:false},context:{group_id:gid,ledger_id:null,company_id:null},counts:{groups:groups.length,ledgers:0,companies:0,people:0,employments:0},legacy:{available:false}};
  }
  const allGroups=(await tx.query('SELECT * FROM ty_group ORDER BY id')).rows;
  const groups=allGroups.filter(g=>access.group(g.id));
  let gid=groupId || groups[0]?.id || null;
  if(gid && !groups.some(g=>eq(g.id,gid))) deny();
  const companies=gid ? (await tx.query('SELECT * FROM ty_company WHERE group_id=$1 ORDER BY id',[gid])).rows
    .filter(c=>access.row({...c,company_id:c.id})) : [];
  const ledgers=gid ? (await tx.query('SELECT * FROM ty_ledger WHERE group_id=$1 ORDER BY id',[gid])).rows
    .filter(l=>access.admin || access.grants.some(g=>eq(g.group_id,gid) && (!g.ledger_id||eq(g.ledger_id,l.id))
      && (!g.company_id || companies.some(c=>eq(c.id,g.company_id)&&eq(c.ledger_id,l.id))))) : [];
  if(ledgerId && !ledgers.some(l=>eq(l.id,ledgerId))) deny();
  if(companyId && !companies.some(c=>eq(c.id,companyId))) notFound();
  const ledgerIds=ledgerId?(await tx.query(`WITH RECURSIVE tree AS (SELECT id FROM ty_ledger WHERE id=$1 AND group_id=$2 UNION ALL SELECT l.id FROM ty_ledger l JOIN tree p ON (to_jsonb(l)->>'parent_ledger_id')::bigint=p.id) SELECT id FROM tree`,[ledgerId,gid])).rows.map(r=>String(r.id)):[];
  const companyIds=companyId?await companyDescendants(tx,companyId):[];
  if(companyId&&ledgerId&&!companies.some(c=>eq(c.id,companyId)&&ledgerIds.includes(String(c.ledger_id))))notFound();
  const scoped=companies.filter(c=>(!ledgerId||ledgerIds.includes(String(c.ledger_id)))&&(!companyId||companyIds.includes(String(c.id))));
  const ids=scoped.map(c=>Number(c.id));
  const shared=async table=>gid?(await tx.query(`SELECT * FROM ${table} WHERE group_id=$1 ORDER BY id`,[gid])).rows:[];
  const owned=async table=>ids.length?(await tx.query(`SELECT * FROM ${table} WHERE company_id=ANY($1::bigint[]) ORDER BY id`,[ids])).rows:[];
  const employments=(await owned('ty_employment')).filter(e=>!access.selfOnly||eq(e.person_id,access.selfPersonId));
  const pendingPeople=access.persona?.profile_code==='company_hr_director'?(await tx.query("SELECT DISTINCT entity_id FROM ty_audit a WHERE actor_id=$1 AND action='create'AND entity_kind='people'AND NOT EXISTS(SELECT 1 FROM ty_employment e WHERE e.person_id=a.entity_id)",[userId])).rows.map(r=>String(r.entity_id)):[];
  const people=(await shared('ty_person')).filter(p=>(!access.selfOnly||eq(p.id,access.selfPersonId))&&(access.shared(gid,true)||access.admin
    ||access.grants.some(g=>eq(g.group_id,gid)&&!g.ledger_id&&!g.company_id)
    ||pendingPeople.includes(String(p.id))||employments.some(e=>eq(e.person_id,p.id))));
  const assignments=(await owned('ty_position_assignment')).filter(a=>employments.some(e=>eq(e.id,a.employment_id)));
  const grants=access.admin ? await shared('ty_access_grant'):access.grants.filter(g=>eq(g.group_id,gid));
  // Company-only grants derive their ledger from the actual company row. A null
  // grant.ledger_id must not turn company A's write permission into ledger B's
  // UI capability when B is separately granted read-only.
  const canWrite=access.admin || scoped.some(c=>access.row({...c,company_id:c.id},true))
    || (!companyId && access.grants.some(g=>g.can_write&&eq(g.group_id,gid)&&!g.company_id
      &&(!ledgerId||!g.ledger_id||eq(g.ledger_id,ledgerId))));
  return {groups,brands:await shared('ty_brand'),ledgers,companies,
    departments:await owned('ty_department'),work_areas:await owned('ty_work_area'),jobs:await shared('ty_job'),grades:await shared('ty_grade'),
    positions:await owned('ty_company_position'),people,employments,assignments,grants,
    external_identities:(access.admin || access.grants.some(g=>eq(g.group_id,gid)&&!g.ledger_id&&!g.company_id)) ? (await shared('ty_external_identity')).filter(x=>people.some(p=>eq(p.id,x.person_id)) || (access.admin&&!x.person_id)):[],
    accounts:access.admin?(await tx.query(access.platformAdmin?'SELECT id,login,display_name,status FROM sys_account ORDER BY id':'SELECT a.id,a.login,a.display_name,a.status FROM sys_account a JOIN ty_test_account_profile p ON p.account_id=a.id WHERE p.group_id=$1 ORDER BY a.id',access.platformAdmin?[]:[gid])).rows:[],
    capabilities:{can_write:canWrite,can_write_people:access.canEmploymentWrite&&(access.shared(gid,true)||access.persona?.profile_code==='company_hr_director'),can_manage_access:access.admin,can_create_group:access.platformAdmin,can_write_shared:gid?access.shared(gid,true):access.admin},
    context:{group_id:gid,ledger_id:ledgerId||null,company_id:companyId||null},
    counts:{groups:groups.length,ledgers:ledgers.length,companies:scoped.length,people:people.length,employments:employments.length},
    legacy:{available:true,scope_notice:'兼容业务按原授权范围显示；新版帐套与公司筛选尚不改变旧业务数据范围'},
  };
}
export async function save(tx,{userId,collection,id,input}) {
  const spec=COLLECTIONS[collection];if(!spec)notFound();
  const [table]=spec;const access=await accessFor(tx,userId);
  let row=id?(await tx.query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0]:null;
  if(id&&!row)notFound();
  if(row)await check(tx,access,collection,row,true);
  const data=payload(collection,input);
  const merged={...row,...data};
  await check(tx,access,collection,merged,true);
  if(collection==='people'&&id&&(data.group_id&&!eq(data.group_id,row.group_id)||data.person_number&&!eq(data.person_number,row.person_number))) bad('集团身份和初始人员编号不能修改');
  if(collection==='grants') {
    const a=(await tx.query('SELECT id FROM sys_account WHERE id=$1 AND status=\'active\'',[data.account_id ?? row?.account_id])).rows[0];
    if(!a)bad('请先建立有效的登录账号，再配置授权');
  }
  let result;
  if(id && data.status==='inactive' && row.status!=='inactive') {
    const other=Object.keys(data).filter(k=>k!=='status' && String(data[k]??'')!==String(row[k]??''));
    if(other.length)bad('停用请单独提交，先保存其他修改再停用');
    await tx.query('SELECT fn_ty_deactivate($1,$2)',[collection,id]);
    result={...row,status:'inactive'};
  } else if(collection==='people'&&!id) {
    const v=(await tx.query('SELECT fn_ty_create_person($1,$2,$3) id',[data.group_id,data.person_number||null,data.full_name])).rows[0];
    if(Object.hasOwn(data,'status')) await tx.query('UPDATE ty_person SET status=$1 WHERE id=$2',[data.status,v.id]);
    result=(await tx.query('SELECT * FROM ty_person WHERE id=$1',[v.id])).rows[0];
  } else if(collection==='employments'&&id&&data.status==='ended') {
    if(!data.leave_date)bad('请填写离职日期');
    const changed=Object.keys(data).filter(k=>!['status','leave_date'].includes(k) && String(data[k]??'')!==String(row[k]??''));
    if(changed.length)bad('结束雇佣请单独保存离职日期，其他修改须先保存');
    await tx.query('SELECT fn_ty_end_employment($1,$2)',[id,data.leave_date ?? row.leave_date]);
    result=(await tx.query('SELECT * FROM ty_employment WHERE id=$1',[id])).rows[0];
  } else {
    const keys=Object.keys(data);
    if(!keys.length)bad('没有可以保存的字段');
    const params=keys.map(k=>data[k]);
    const sql=id?`UPDATE ${table} SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1} RETURNING *`
      :`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`;
    if(id)params.push(id);
    result=(await tx.query(sql,params)).rows[0];
  }
  await tx.query(`INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,before_data,after_data)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,[userId,id?'update':'create',collection,result.id,row?JSON.stringify(row):null,JSON.stringify(result)]);
  return {row:result};
}
export async function deactivate(tx,{userId,collection,id}) {
  if(['employments','assignments','external-identities','grants'].includes(collection))bad('请用结束日期或授权失效日期处理这类记录');
  const spec=COLLECTIONS[collection];if(!spec)notFound();
  const row=(await tx.query(`SELECT * FROM ${spec[0]} WHERE id=$1`,[id])).rows[0];if(!row)notFound();
  const access=await accessFor(tx,userId);await check(tx,access,collection,row,true);
  await tx.query('SELECT fn_ty_deactivate($1,$2)',[collection,id]);
  await tx.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id,before_data) VALUES($1,'deactivate',$2,$3,$4::jsonb)",[userId,collection,id,JSON.stringify(row)]);
  return {row:{...row,status:'inactive'}};
}
export async function timeline(tx,{userId,personId}) {
  const access=await accessFor(tx,userId);
  const p=(await tx.query('SELECT * FROM ty_person WHERE id=$1',[personId])).rows[0];
  if(!p||!access.group(p.group_id)||(access.selfOnly&&!eq(p.id,access.selfPersonId)))notFound();
  const all=(await tx.query(`SELECT e.*,c.ledger_id,c.name company_name,l.name ledger_name FROM ty_employment e
    JOIN ty_company c ON c.id=e.company_id JOIN ty_ledger l ON l.id=c.ledger_id WHERE e.person_id=$1 ORDER BY e.hire_date,e.id`,[personId])).rows;
  const employments=all.filter(e=>access.row(e));
  if(!employments.length&&!access.shared(p.group_id,true)&&!access.grants.some(g=>eq(g.group_id,p.group_id)&&!g.ledger_id&&!g.company_id))notFound();
  for(const e of employments) e.assignments=(await tx.query(`SELECT a.*,d.name department_name,p.name position_name,g.name grade_name,w.name work_area_name
    FROM ty_position_assignment a JOIN ty_department d ON d.id=a.department_id JOIN ty_company_position p ON p.id=a.position_id
    LEFT JOIN ty_grade g ON g.id=a.grade_id LEFT JOIN ty_work_area w ON w.id=a.work_area_id
    WHERE a.employment_id=$1 ORDER BY a.valid_from,a.id`,[e.id])).rows;
  return {person:p,employments};
}
export async function seedDemo(tx,{userId}) {
  const a=await accessFor(tx,userId);if(!a.admin)deny();
  const exists=(await tx.query("SELECT id FROM ty_group WHERE code='TYDEMO'")).rows[0];
  if(exists)return {seeded:false,group_id:exists.id,message:'示例集团已存在，未覆盖已有数据'};
  const insert=async(table,data)=>{const ks=Object.keys(data);return(await tx.query(`INSERT INTO ${table}(${ks.join(',')}) VALUES(${ks.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,ks.map(k=>data[k]))).rows[0];};
  const g=await insert('ty_group',{code:'TYDEMO',name:'示例餐饮集团'});
  const ba=await insert('ty_brand',{group_id:g.id,code:'BR-A',name:'示例甲品牌'}),bb=await insert('ty_brand',{group_id:g.id,code:'BR-B',name:'示例乙品牌'});
  const la=await insert('ty_ledger',{group_id:g.id,brand_id:ba.id,scope_mode:'brand',code:'LED-A',name:'甲品牌业务帐套'}),lb=await insert('ty_ledger',{group_id:g.id,brand_id:bb.id,scope_mode:'brand',code:'LED-B',name:'乙品牌业务帐套'});
  const ca=await insert('ty_company',{group_id:g.id,ledger_id:la.id,brand_id:ba.id,code:'STORE-A1',name:'甲店公司',company_kind:'store'}),cb=await insert('ty_company',{group_id:g.id,ledger_id:lb.id,brand_id:bb.id,code:'STORE-B1',name:'乙店公司',company_kind:'store'});
  await insert('ty_company',{group_id:g.id,ledger_id:la.id,brand_id:ba.id,code:'STORE-A2',name:'丙店公司',company_kind:'store'});
  const da=await insert('ty_department',{company_id:ca.id,code:'KITCHEN',name:'后厨部'}),db=await insert('ty_department',{company_id:cb.id,code:'KITCHEN',name:'后厨部'});
  await insert('ty_work_area',{company_id:ca.id,department_id:da.id,code:'WOK',name:'炉灶区',mode:'work_area_in_department'});
  await insert('ty_work_area',{company_id:cb.id,department_id:db.id,code:'KITCHEN-DEPT',name:'后厨档口',mode:'department_extension'});
  const job=await insert('ty_job',{group_id:g.id,code:'CHEF',name:'厨师',job_family:'后厨'}),grade=await insert('ty_grade',{group_id:g.id,code:'G3',name:'专业三级',level:3});
  const pa=await insert('ty_company_position',{group_id:g.id,company_id:ca.id,department_id:da.id,job_id:job.id,grade_id:grade.id,code:'CHEF',name:'后厨厨师岗'}),pb=await insert('ty_company_position',{group_id:g.id,company_id:cb.id,department_id:db.id,job_id:job.id,grade_id:grade.id,code:'CHEF',name:'后厨厨师岗'});
  const pid=(await tx.query("SELECT fn_ty_create_person($1,NULL,'演示员工甲') id",[g.id])).rows[0].id;
  const e1=await insert('ty_employment',{group_id:g.id,person_id:pid,company_id:ca.id,hire_date:'2026-01-01',leave_date:'2026-10-31',status:'ended',employment_type:'FT'});
  await insert('ty_position_assignment',{group_id:g.id,company_id:ca.id,employment_id:e1.id,department_id:da.id,position_id:pa.id,grade_id:grade.id,valid_from:'2026-01-01',valid_to:'2026-11-01',status:'ended'});
  const e2=await insert('ty_employment',{group_id:g.id,person_id:pid,company_id:cb.id,hire_date:'2026-11-01',rehire_link:e1.id,employment_type:'FT'});
  await insert('ty_position_assignment',{group_id:g.id,company_id:cb.id,employment_id:e2.id,department_id:db.id,position_id:pb.id,grade_id:grade.id,valid_from:'2026-11-01'});
  await insert('ty_external_identity',{group_id:g.id,person_id:pid,source_system:'demo_attendance',source_namespace:'LED-A',raw_id_text:'0000000001',review_status:'verified'});
  await tx.query("INSERT INTO ty_audit(actor_id,action,entity_kind,entity_id) VALUES($1,'demo_seed','groups',$2)",[userId,g.id]);
  return {seeded:true,group_id:g.id,message:'虚构示例已建立，包含双品牌帐套、门店公司、两类档口及同人跨帐套经历'};
}

export async function ledgerDescendants(tx,id){if(!id)return[];return(await tx.query(`WITH RECURSIVE x AS(SELECT id FROM ty_ledger WHERE id=$1 UNION ALL SELECT t.id FROM ty_ledger t JOIN x ON (to_jsonb(t)->>'parent_ledger_id')::bigint=x.id)SELECT id FROM x`,[id])).rows.map(r=>String(r.id));}
export async function companyDescendants(tx,id){if(!id)return[];return(await tx.query(`WITH RECURSIVE x AS(SELECT id FROM ty_company WHERE id=$1 UNION ALL SELECT t.id FROM ty_company t JOIN x ON (to_jsonb(t)->>'parent_company_id')::bigint=x.id)SELECT id FROM x`,[id])).rows.map(r=>String(r.id));}
