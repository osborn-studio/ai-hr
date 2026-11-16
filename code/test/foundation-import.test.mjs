// Entirely fabricated roster. No real workbook, name, source ID or date is used.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { makeZip } from '../app/zip.mjs';
import * as importer from '../app/services/foundation-import.mjs';

let db;
if(process.env.DATABASE_URL) {
  const pg=(await import('pg')).default;pg.types.setTypeParser(20,v=>Number(v));pg.types.setTypeParser(1082,v=>new Date(`${v}T00:00:00Z`));
  const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query("SET TIME ZONE 'UTC'");
  db={query:(s,a)=>c.query(s,a),exec:s=>c.query(s),close:()=>c.end()};console.log('花名册导入驱动：真实 PostgreSQL');
}else{db=await PGlite.create({extensions:{btree_gist}});console.log('花名册导入驱动：PGlite');}
const results=[];const rec=(name,ok)=>results.push({name,ok:!!ok});
const q=async(s,a=[]) => (await db.query(s,a)).rows;
const insert=async(table,data)=>{const ks=Object.keys(data);return Number((await q(`INSERT INTO ${table}(${ks.join(',')}) VALUES(${ks.map((_,i)=>`$${i+1}`).join(',')}) RETURNING id`,Object.values(data)))[0].id);};
async function tx(fn){await db.exec('BEGIN');try{const r=await fn(db);await db.exec('COMMIT');return r;}catch(e){await db.exec('ROLLBACK');throw e;}}
async function reject(name,fn,code='E_TY_'){try{await tx(fn);rec(name,false);}catch(e){rec(name,String(e.message).includes(code));}}
const run=(fn,input,userId=1000)=>tx(t=>fn(t,{userId,input}));
const esc=v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const xc=(ref,v)=>typeof v==='number'?`<c r="${ref}"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
function fixture({idPrefix='',duplicate=false,badDate=false,badHeader=false,short=false}={}) {
  const headers={B:'编号',C:'就业状态Employment Status',D:'姓名 Name',I:'部门 Department',J:'入职日期 Date of Employment',K:'职位 Position',L:'用工类型 Employment Type',AA:'离职日期 Termination Date',AN:'是否2次入职',AO:'首次入职日期'};
  if(badHeader)headers.K='未知列';let body=`<row r="2">${Object.entries(headers).map(([c,v])=>xc(c+'2',v)).join('')}</row>`;
  for(let i=1;i<=(short?3:218);i++) {
    const r=i+2,ended=i<=214&&i%11===0,hq=!short&&i>214;
    const values={B:idPrefix+String(duplicate&&i===2?1:i).padStart(6,'0'),C:ended?'离职':'在职',D:`虚构人员${String(i).padStart(4,'0')}`,
      I:hq?'总经理室':`演示经营门店${i%6+1}`,J:badDate&&i===1?'04/05/2020':`2020-02-${String(i%28+1).padStart(2,'0')}`,
      K:`演示工作标签${i%8+1}`,L:['FT','PT','LTPT'][i%3],AA:ended?`2024-05-${String(i%28+1).padStart(2,'0')}`:'',
      AN:i%17===0?'是':'',AO:i%17===0&&i!==17?'2018-01-01':'',M:'该列不导入',Z:'不导入的虚构银行文本'};
    body+=`<row r="${r}">${Object.entries(values).map(([c,v])=>xc(c+r,v)).join('')}</row>`;
  }
  return makeZip([
    {name:'xl/workbook.xml',data:'<workbook xmlns:r="r"><sheets><sheet name="说明" r:id="r1"/><sheet name="花名册" r:id="r2"/></sheets></workbook>'},
    {name:'xl/_rels/workbook.xml.rels',data:'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Target="worksheets/sheet2.xml"/></Relationships>'},
    {name:'xl/worksheets/sheet1.xml',data:'<worksheet><sheetData/></worksheet>'},
    {name:'xl/worksheets/sheet2.xml',data:`<worksheet><sheetData>${body}</sheetData></worksheet>`},
  ]);
}

try {
  for(const f of ['193_tyhr_foundation.sql','194_tyhr_foundation_governance.sql','198_tyhr_foundation_import.sql'])await db.exec(readFileSync(new URL('../db/'+f,import.meta.url),'utf8'));
  await db.exec(`CREATE FUNCTION fn_role_can(uid bigint,resource text,action text) RETURNS boolean LANGUAGE sql AS $$ SELECT uid=1000 AND resource='ledger' $$;`);
  const g=await insert('ty_group',{code:'IMPORT-DEMO',name:'虚构导入测试集团'}),l=await insert('ty_ledger',{group_id:g,scope_mode:'group',code:'IMPORT',name:'虚构集团帐套'});
  const buf=fixture(),input={group_id:g,ledger_id:l,filename:'synthetic-roster.xlsx',content_base64:buf.toString('base64')};
  const parsed=importer.inspectRosterWorkbook(buf);rec('具名花名册读取218个完全虚构人员而非首张表',parsed.rows.length===218&&parsed.format==='hk_roster_z14');
  rec('部门列分类6家经营候选与总部4身份',parsed.source_companies.length===7&&parsed.summary.operating_company_candidates===6&&parsed.summary.headquarters_identity_only===4);
  rec('原始编号文本保留前导零',parsed.rows[0].source_id_text==='000001');
  rec('保留FT/PT/LTPT原标签不推定法定类型',Object.keys(parsed.summary.employment_type_counts).sort().join(',')==='FT,LTPT,PT');
  rec('原入职日期与职位标签可追溯',parsed.rows[0].hire_date==='2020-02-02'&&parsed.rows[0].source_position==='演示工作标签2');
  rec('未选公司映射的预检不可提交',!(await run(importer.preview,input)).can_commit);
  const mapping=Object.fromEntries(parsed.source_companies.filter(v=>v.classification!=='hq_unit').map(v=>[v.source_label,{create:true}]));
  const payload={...input,company_mapping:mapping,review_ack:true};
  const ready=await run(importer.preview,payload);rec('显式创建经营公司映射后可以提交',ready.can_commit&&ready.expected.companies_to_create===6&&ready.expected.employments===214&&ready.expected.pending_employments===4);
  await reject('未明确核验ack不能提交',t=>importer.commit(t,{userId:1000,input:{...payload,review_ack:false}}),'E_TY_ARGUMENT');
  await reject('非基础管理员不能预检读取人员',t=>importer.preview(t,{userId:1001,input:payload}),'E_TY_FORBIDDEN');
  const hq=await run(importer.preview,{...payload,company_mapping:{...mapping,'总经理室':{create:true}}});rec('总经理室不能被导入为经营公司',!hq.can_commit&&hq.issues.some(i=>i.code==='HQ_COMPANY_FORBIDDEN'));
  const committed=await run(importer.commit,payload);rec('提交创建218身份和214条合成来源雇佣',!committed.already_imported&&committed.stats.identities_created===218&&committed.stats.employments_created===214&&committed.stats.pending_employments===4);
  const companies=await q('SELECT * FROM ty_company WHERE group_id=$1',[g]);rec('仅创建6家门店经营公司且不造独立法人名称',companies.length===6&&companies.every(c=>c.company_kind==='store'&&c.legal_name===null&&c.code.startsWith('IMP-'))&&!companies.some(c=>c.name==='总经理室'));
  rec('人员使用集团自动分配永久号',Number((await q("SELECT count(*) n FROM ty_person WHERE group_id=$1 AND person_number ~ '^TY[0-9]{6}$'",[g]))[0].n)===218);
  rec('外部编号全在roster源哈希命名空间且待核验',Number((await q("SELECT count(*) n FROM ty_external_identity WHERE group_id=$1 AND source_system='roster' AND source_namespace=$2 AND review_status='needs_review'",[g,'hk_roster_z14:'+parsed.source_sha256]))[0].n)===218);
  const leave=await q('SELECT * FROM ty_employment WHERE group_id=$1 AND status=\'ended\'',[g]);rec('源离职日期原样保存且没有伪造当前日期',leave.length===19&&leave.every(e=>String(e.leave_date).includes('2024')||e.leave_date instanceof Date&&e.leave_date.getUTCFullYear()===2024));
  rec('不伪造内部部门档口岗位职级和任职',Number((await q('SELECT (SELECT count(*) FROM ty_department)+(SELECT count(*) FROM ty_work_area)+(SELECT count(*) FROM ty_job)+(SELECT count(*) FROM ty_grade)+(SELECT count(*) FROM ty_company_position)+(SELECT count(*) FROM ty_position_assignment) n'))[0].n)===0);
  const provenance=(await q('SELECT source_data FROM ty_foundation_import_row ORDER BY source_row LIMIT 1'))[0].source_data;
  rec('只保留必要来源字段不收集工资银行列',provenance.source_position==='演示工作标签2'&&!Object.hasOwn(provenance.source_cells,'M')&&!Object.hasOwn(provenance.source_cells,'Z'));
  rec('重聘来源只留历史提示未虚构旧雇佣',Number((await q('SELECT count(*) n FROM ty_employment WHERE group_id=$1',[g]))[0].n)===214&&Number((await q("SELECT count(*) n FROM ty_foundation_import_event WHERE event_kind='source_anomaly'"))[0].n)>4);
  const repeated=await run(importer.commit,{...payload,filename:'renamed.xlsx'});rec('相同源哈希改文件名不会重复建人',repeated.already_imported&&Number((await q('SELECT count(*) n FROM ty_person WHERE group_id=$1',[g]))[0].n)===218);
  const l2=await insert('ty_ledger',{group_id:g,scope_mode:'group',code:'SECOND',name:'另一虚构帐套'});
  const repeatedLedger=await run(importer.commit,{...payload,ledger_id:l2});rec('同集团相同文件跨帐套仍幂等且说明原帐套',repeatedLedger.already_imported&&Number(repeatedLedger.ledger_id)===l);
  const badDates=fixture({badDate:true});const conflict=await run(importer.preview,{...payload,content_base64:badDates.toString('base64')});rec('不同来源文件同未核验编号不自动合并或重复建人',!conflict.can_commit&&conflict.issues.some(x=>x.code==='CROSS_FILE_ID_REVIEW_REQUIRED'));
  const second=fixture({idPrefix:'v2-'}),existingMapping=Object.fromEntries(companies.map(c=>[c.name,{company_id:c.id}]));
  const c2=await run(importer.commit,{...payload,content_base64:second.toString('base64'),company_mapping:existingMapping});rec('不同来源新编号不会凭同名合并为老员工',!c2.already_imported&&Number((await q('SELECT count(*) n FROM ty_person WHERE group_id=$1',[g]))[0].n)===436);
  const dup=importer.inspectRosterWorkbook(fixture({duplicate:true}));rec('同文件重复来源编号被预检阻断',dup.issues.some(i=>i.code==='SOURCE_ID_DUPLICATE'));
  const dateAmbiguous=importer.inspectRosterWorkbook(fixture({badDate:true}));rec('日期格式歧义只保留身份不猜日期建雇佣',dateAmbiguous.rows[0].hire_date===null&&dateAmbiguous.rows[0].employment_state===null&&dateAmbiguous.rows[0].issues.some(x=>x.code==='HIRE_DATE_UNRESOLVED'));
  await reject('来源header变化不能猜列',async()=>importer.inspectRosterWorkbook(fixture({badHeader:true})),'E_TY_ARGUMENT');
  const outside=(await q('SELECT id FROM ty_company WHERE group_id=$1 ORDER BY id LIMIT 1',[g]))[0].id;
  const wrong=await run(importer.preview,{...payload,ledger_id:l2,content_base64:fixture({idPrefix:'v3-'}).toString('base64'),company_mapping:{...mapping,'演示经营门店1':{company_id:outside}}});rec('公司映射不能跨帐套',!wrong.can_commit&&wrong.issues.some(i=>i.code==='COMPANY_MAPPING_INVALID'));
  await reject('批次来源不可覆盖',t=>t.query('UPDATE ty_foundation_import_row SET source_data=\'{}\''),'E_TY_CONFLICT');
  await reject('来源异常日志不可清空',t=>t.query('TRUNCATE ty_foundation_import_event'),'E_TY_CONFLICT');
  const sg=await insert('ty_group',{code:'SMALL',name:'歧义源虚构集团'}),sl=await insert('ty_ledger',{group_id:sg,scope_mode:'group',code:'SMALL',name:'歧义源虚构帐套'});
  const tiny=fixture({short:true,badDate:true,idPrefix:'tiny-'}),tinyParsed=importer.inspectRosterWorkbook(tiny),tinyMapping=Object.fromEntries(tinyParsed.source_companies.map(v=>[v.source_label,{create:true}]));
  const tinyReceipt=await run(importer.commit,{group_id:sg,ledger_id:sl,filename:'synthetic-small.xlsx',content_base64:tiny.toString('base64'),company_mapping:tinyMapping,review_ack:true});
  rec('缺失明确日期仍可建身份并记录待定而不虚构雇佣',tinyReceipt.stats.identities_created===3&&tinyReceipt.stats.employments_created===2&&tinyReceipt.stats.pending_employments===1);
}finally{await db.close();}
for(const r of results)console.log(`${r.ok?'PASS':'FAIL'} ${r.name}`);
const failed=results.filter(r=>!r.ok).length;console.log(`原生花名册导入 ${results.length} 条，通过 ${results.length-failed}，失败 ${failed}`);process.exitCode=failed?1:0;
