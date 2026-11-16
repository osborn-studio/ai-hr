import { createHash } from 'node:crypto';
import { bizErr } from '../errors.mjs';
import { accessFor } from './foundation.mjs';
import { readNamedWorkbook } from './customer-performance-import.mjs';

export const RESOURCES={foundation:'ledger'};
const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
const deny=m=>{throw bizErr('E_TY_FORBIDDEN',m);};
const eq=(a,b)=>String(a)===String(b);
const text=v=>v===null||v===undefined?'':String(v).trim();
const id=v=>{if(!Number.isSafeInteger(Number(v))||Number(v)<=0)bad('集团、帐套和公司编号必须为正整数');return Number(v);};
const q=async(tx,s,a=[]) => (await tx.query(s,a)).rows;
const issue=(code,message,extra={})=>({code,message,...extra});
function payload(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))bad('请提交导入参数对象');
  if(typeof input.content_base64!=='string'||input.content_base64.length>4000000)bad('请提交最多3MB的原生花名册XLSX');
  if(typeof input.filename!=='string'||!/\.xlsx$/i.test(input.filename)||input.filename.length>500)bad('请提供XLSX文件名');
  return {gid:id(input.group_id),lid:id(input.ledger_id),buf:Buffer.from(input.content_base64,'base64')};
}
const emptyCell=(sheet,ref)=>({value:null,error:null,formula:null,source_ref:{sheet,cell:ref}});
function validDay(year,month,day) {
  const d=new Date(Date.UTC(year,month-1,day));return d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?d.toISOString().slice(0,10):null;
}
function dateValue(c,date1904) {
  if(c.error)return {value:null,quality:'source_error'};
  const raw=c.value;
  if(raw===null||raw===undefined||text(raw)==='')return {value:null,quality:'empty'};
  if(typeof raw==='number'&&raw>=1&&raw<=100000&&Number.isInteger(raw)) {
    const d=new Date((Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:30))+raw*86400000);
    return {value:d.toISOString().slice(0,10),quality:c.formula?'cached':'literal'};
  }
  const s=text(raw);let m=/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/.exec(s);
  if(m){const value=validDay(Number(m[1]),Number(m[2]),Number(m[3]));return {value,quality:value?'text_iso':'invalid'};}
  m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if(m&&Number(m[1])>12) {const value=validDay(Number(m[3]),Number(m[2]),Number(m[1]));return {value,quality:value?'text_unambiguous_dmy':'invalid'};}
  return {value:null,quality:m?'ambiguous':'invalid'};
}

export function inspectRosterWorkbook(buf) {
  const w=readNamedWorkbook(buf);const s=w?.sheets.find(v=>v.name==='花名册');if(!s)bad('未找到具名工作表“花名册”；不按首张表猜测人员清单');
  const cell=ref=>s.cells.get(ref)||emptyCell(s.name,ref);
  for(const [ref,pattern] of [['B2',/编号|編號/],['D2',/姓名/],['I2',/部门|部門/],['J2',/入职|入職/],['K2',/职位|職位/],['L2',/用工类型|用工類型/],['AA2',/离职|離職/]])if(!pattern.test(text(cell(ref).value)))bad(`花名册${ref}表头与原生格式不同，需重新确认映射`);
  const rows=[],fatal=[],seen=new Set();const departments=new Map();
  for(let r=3;r<=s.max_row;r++) {
    const bc=cell(`B${r}`),nc=cell(`D${r}`);if(!text(bc.value)&&!text(nc.value))continue;
    const sourceId=bc.cell_type==='n'&&bc.raw_value_text!==null&&bc.raw_value_text!==undefined?String(bc.raw_value_text).trim():text(bc.value);
    const name=text(nc.value),department=text(cell(`I${r}`).value),status=text(cell(`C${r}`).value),position=text(cell(`K${r}`).value),type=text(cell(`L${r}`).value);
    if(!sourceId||bc.error){fatal.push(issue('SOURCE_ID_INVALID','来源编号缺失或错误',{source_row:r}));continue;}
    if(seen.has(sourceId)){fatal.push(issue('SOURCE_ID_DUPLICATE','同文件来源编号重复，不能唯一建人',{source_row:r}));continue;}seen.add(sourceId);
    if(!name||nc.error){fatal.push(issue('SOURCE_NAME_INVALID','中文姓名缺失或错误',{source_row:r}));continue;}
    if(!department){fatal.push(issue('SOURCE_DEPARTMENT_MISSING','来源部门/门店标签缺失',{source_row:r}));continue;}
    const hire=dateValue(cell(`J${r}`),w.date1904),leave=dateValue(cell(`AA${r}`),w.date1904),first=dateValue(cell(`AO${r}`),w.date1904);const issues=[];
    let state=null;
    if(!hire.value)issues.push(issue('HIRE_DATE_UNRESOLVED','入职日期缺失、错误或文本格式歧义；只建身份，雇佣待核验'));
    if(leave.quality!=='empty'&&!leave.value)issues.push(issue('LEAVE_DATE_UNRESOLVED','离职日期错误或存在歧义；不推定日期'));
    if(['在职','在職'].includes(status)&&leave.quality==='empty'&&hire.value)state='active';
    else if(['离职','離職'].includes(status)&&leave.value&&hire.value&&leave.value>=hire.value)state='ended';
    else issues.push(issue('EMPLOYMENT_STATUS_UNRESOLVED','来源在离职状态与日期不完整或不一致；雇佣待核验'));
    if(!['FT','PT','LTPT'].includes(type)){state=null;issues.push(issue('EMPLOYMENT_TYPE_UNRESOLVED','原用工类型不属于FT/PT/LTPT，待确认，不自动翻译法律类别'));}
    const hq=/(总经理室|總經理室)/.test(department);
    if(hq){state=null;issues.push(issue('HQ_ORGANIZATION_PENDING','总经理室为总部单位，仅建永久人员身份；所属经营/雇佣公司待明确'));
    }
    const rehired=text(cell(`AN${r}`).value);if(rehired==='是') {
      issues.push(issue('PRIOR_EMPLOYMENT_NOT_CREATED','来源标记二次入职；首次入职日期仅保留来源，不虚构既往离职或雇佣'));
      if(!first.value)issues.push(issue('FIRST_HIRE_DATE_MISSING','二次入职但首次入职日期缺失或不可判定'));
    }
    if(!position)issues.push(issue('POSITION_LABEL_MISSING','原职位标签缺失；不建立岗位/职级/任职'));
    const refs={};for(const col of ['B','C','D','I','J','K','L','AA','AB','AN','AO'])refs[col]=cell(`${col}${r}`);
    rows.push({source_row:r,source_id_text:sourceId,full_name:name,source_department:department,classification:hq?'hq_unit':'operating_company_candidate',source_status:status,
      hire_date:hire.value,leave_date:leave.value,employment_state:state,employment_type:type,source_position:position,termination_reason:text(cell(`AB${r}`).value),
      rehire_label:rehired,first_hire_date:first.value,date_quality:{hire:hire.quality,leave:leave.quality,first_hire:first.quality},source_ref:{sheet:s.name,range:`B${r}:AO${r}`},source_cells:refs,issues});
    const d=departments.get(department)||{source_label:department,classification:hq?'hq_unit':'operating_company_candidate',row_count:0};d.row_count++;departments.set(department,d);
  }
  if(!rows.length)fatal.push(issue('SOURCE_EMPTY','未找到有效花名册人员行'));
  const countBy=key=>Object.fromEntries([...new Set(rows.map(r=>r[key]))].map(v=>[v,rows.filter(r=>r[key]===v).length]));
  return {format:'hk_roster_z14',source_sha256:createHash('sha256').update(buf).digest('hex'),sheet:s.name,rows,source_companies:[...departments.values()],issues:fatal,
    summary:{source_rows:rows.length,source_company_labels:departments.size,operating_company_candidates:[...departments.values()].filter(v=>v.classification==='operating_company_candidate').length,
      headquarters_identity_only:rows.filter(v=>v.classification==='hq_unit').length,employment_ready:rows.filter(v=>v.employment_state).length,
      source_status_counts:countBy('source_status'),employment_type_counts:countBy('employment_type'),rehire_marked:rows.filter(v=>v.rehire_label==='是').length,
      rehire_missing_first_date:rows.filter(v=>v.rehire_label==='是'&&!v.first_hire_date).length,anomaly_rows:rows.filter(v=>v.issues.length).length},
    notice:'门店映射为经营核算公司，不据此证明独立法人；总经理室仅建身份待定。保留FT/PT/LTPT、职位原标签与真实入离职日期，不伪造内部部门、档口、标准岗位、职级或任职。来源编号按roster文件哈希命名空间保留needs_review，不按姓名跨文件合并。'};
}

async function prepare(tx,{userId,input}) {
  const p=payload(input),a=await accessFor(tx,userId);if(!a.admin)deny('原生基础导入仅限具有基础管理权限的管理员');
  const ledger=(await q(tx,'SELECT l.*,g.status group_status FROM ty_ledger l JOIN ty_group g ON g.id=l.group_id WHERE l.id=$1 AND l.group_id=$2',[p.lid,p.gid]))[0];
  if(!ledger||ledger.status!=='active'||ledger.group_status!=='active')bad('请选择有效集团及其有效帐套');
  if(!a.shared(p.gid,true)||!a.row({...ledger,group_id:p.gid,ledger_id:p.lid},true))deny('没有所选集团及帐套的基础写范围');
  const parsed=inspectRosterWorkbook(p.buf);const companies=await q(tx,'SELECT * FROM ty_company WHERE group_id=$1 AND ledger_id=$2 ORDER BY id',[p.gid,p.lid]);
  const existing=(await q(tx,'SELECT id,ledger_id,stats,status FROM ty_foundation_import_batch WHERE group_id=$1 AND source_sha256=$2',[p.gid,parsed.source_sha256]))[0];
  const issues=[...parsed.issues],mapping=input.company_mapping||{};
  if(!mapping||typeof mapping!=='object'||Array.isArray(mapping))bad('company_mapping必须为来源标签到映射对象');
  let created=0;const chosenIds=new Set();
  const source_companies=parsed.source_companies.map(s=>{
    const m=mapping[s.source_label];if(s.classification==='hq_unit') {
      if(m?.create)issues.push(issue('HQ_COMPANY_FORBIDDEN','总经理室不是经营门店，不能按该部门创建公司',{source_label:s.source_label}));
      return {...s,mapping:{kind:'hq_pending'},pending:true};
    }
    if(m?.company_id&&m?.create)issues.push(issue('COMPANY_MAPPING_AMBIGUOUS','已有公司与创建公司不能同时选择',{source_label:s.source_label}));
    if(m?.company_id) {
      const co=companies.find(c=>eq(c.id,m.company_id)&&c.status==='active'&&c.company_kind==='store'&&a.row({...c,company_id:c.id},true));
      if(!co)issues.push(issue('COMPANY_MAPPING_INVALID','公司不属于所选集团帐套、已停用或不是经营门店',{source_label:s.source_label}));
      else if(chosenIds.has(String(co.id)))issues.push(issue('COMPANY_MAPPING_DUPLICATE','不同来源门店映射到同一公司，需先核对稳定身份',{source_label:s.source_label}));
      if(co)chosenIds.add(String(co.id));return {...s,mapping:{company_id:m.company_id,kind:'existing'},pending:!co};
    }
    if(m?.create===true){created++;return {...s,mapping:{create:true,kind:'created_operating',internal_code_generated:true},pending:false};}
    issues.push(issue('COMPANY_MAPPING_REQUIRED','每个门店须显式选择现有公司或创建经营公司',{source_label:s.source_label}));return {...s,mapping:null,pending:true};
  });
  if(ledger.scope_mode==='store'&&(companies.length+created>1||source_companies.filter(v=>v.classification!=='hq_unit').length>1))issues.push(issue('LEDGER_SCOPE_INVALID','门店版帐套只能管理一家经营公司；多门店请用集团或品牌帐套'));
  if(!existing) {
    const conflicts=await q(tx,`SELECT DISTINCT raw_id_text FROM ty_external_identity WHERE group_id=$1 AND source_system='roster'
      AND raw_id_text=ANY($2::text[]) AND source_namespace<>$3`,[p.gid,parsed.rows.map(r=>r.source_id_text),'hk_roster_z14:'+parsed.source_sha256]);
    if(conflicts.length)issues.push(issue('CROSS_FILE_ID_REVIEW_REQUIRED','其他来源批次已有相同未核验编号；须先核验身份，不自动合并或重复建人',{count:conflicts.length}));
  }
  return {p,parsed,existing,view:{...parsed,group_id:p.gid,ledger_id:p.lid,filename:input.filename,source_companies,issues,
    existing_batch:existing||null,can_commit:!!existing||issues.length===0,
    expected:{identities:parsed.rows.length,employments:parsed.summary.employment_ready,pending_employments:parsed.rows.length-parsed.summary.employment_ready,
      companies_to_create:created,internal_company_codes_only:true,departments_to_create:0,jobs_to_create:0,assignments_to_create:0}}};
}
export async function preview(tx,args) {return (await prepare(tx,args)).view;}
export async function commit(tx,{userId,input}) {
  if(input?.review_ack!==true)bad('请核对来源、公司映射、日期及待定组织事项后明确review_ack');
  const p=await prepare(tx,{userId,input});if(!p.existing&&p.view.issues.length)bad(`导入预检未通过：${p.view.issues[0].message}`);
  const result=(await q(tx,'SELECT fn_ty_commit_foundation_import($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) result',
    [p.p.gid,p.p.lid,p.parsed.source_sha256,input.filename,JSON.stringify(p.parsed.rows),JSON.stringify(input.company_mapping||{}),userId,true]))[0].result;
  return {...result,source_sha256:p.parsed.source_sha256,notice:result.already_imported?'同一来源哈希已导入，未重复建人或雇佣；以原批次及原帐套为准':p.parsed.notice};
}
