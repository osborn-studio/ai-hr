// Read-only native workbook adapter. Formula caches are evidence, never approval.
// It reads named sheets and keeps cell pointers; it does not evaluate formulas,
// fetch external books, create employees or infer identities from names/ordinals.
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { bizErr } from '../errors.mjs';

const bad=m=>{throw bizErr('E_TY_ARGUMENT',m);};
const xml=s=>String(s??'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'")
  .replace(/&#x([0-9a-f]+);/gi,(_,v)=>String.fromCodePoint(parseInt(v,16))).replace(/&#(\d+);/g,(_,v)=>String.fromCodePoint(Number(v))).replace(/&amp;/g,'&');
const attrs=s=>Object.fromEntries([...s.matchAll(/([\w:]+)="([^"]*)"/g)].map(m=>[m[1],xml(m[2])]));
const tag=(s,n)=>new RegExp(`<${n}\\b[^>]*>([\\s\\S]*?)<\\/${n}>`).exec(s)?.[1];
const texts=s=>[...s.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m=>xml(m[1])).join('');
const num=v=>typeof v==='number'&&Number.isFinite(v)?v:null;
export function columnName(n){let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}

export function readNamedWorkbook(buf) {
  if(!Buffer.isBuffer(buf)||buf.length<22||buf.length>3000000)bad('原生绩效文件需为最多3MB的XLSX');
  let end=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-65558);i--)if(buf.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)bad('不是有效XLSX压缩包');
  const count=buf.readUInt16LE(end+10);if(count>10000)bad('工作簿压缩成员过多');
  let at=buf.readUInt32LE(end+16),expanded=0;const entries=new Map();
  for(let i=0;i<count;i++) {
    if(at+46>buf.length||buf.readUInt32LE(at)!==0x02014b50)bad('XLSX中央目录损坏');
    const compressed=buf.readUInt32LE(at+20),size=buf.readUInt32LE(at+24),nl=buf.readUInt16LE(at+28),el=buf.readUInt16LE(at+30),cl=buf.readUInt16LE(at+32);
    expanded+=size;if(expanded>40000000)bad('XLSX解压后超过40MB');
    const name=buf.toString('utf8',at+46,at+46+nl);entries.set(name,{compressed,size,method:buf.readUInt16LE(at+10),offset:buf.readUInt32LE(at+42)});at+=46+nl+el+cl;
  }
  const read=name=>{
    const e=entries.get(name);if(!e)return '';
    if(e.offset+30>buf.length||buf.readUInt32LE(e.offset)!==0x04034b50)bad('XLSX本地成员损坏');
    const start=e.offset+30+buf.readUInt16LE(e.offset+26)+buf.readUInt16LE(e.offset+28);if(start+e.compressed>buf.length)bad('XLSX成员超出文件范围');
    const b=buf.subarray(start,start+e.compressed);if(e.method===0)return b.toString('utf8');
    if(e.method!==8)bad('不支持该XLSX压缩方式');
    try{return inflateRawSync(b,{maxOutputLength:40000000}).toString('utf8');}catch{bad('XLSX解压失败或超限');}
  };
  const book=read('xl/workbook.xml');if(!book)return null;
  const relationships=new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)].map(m=>{const a=attrs(m[1]);return[a.Id,a.Target];}));
  const strings=[...read('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>texts(m[1]));
  const sheets=[];const errors=[];let formulas=0,external=0;
  for(const m of book.matchAll(/<sheet\b([^>]*?)\/?\s*>/g)) {
    const a=attrs(m[1]),target=relationships.get(a['r:id']);if(!target)continue;
    const path=target.startsWith('/')?target.slice(1):posix.normalize('xl/'+target);const raw=read(path);const cells=new Map();let maxRow=0,maxColumn=0;
    for(const cm of raw.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca=attrs(cm[1]),body=cm[2]||'',ref=ca.r;if(!/^[A-Z]+\d+$/.test(ref||''))continue;
      const f=/<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body),sharedFormula=/<f\b/.test(body);const rawValue=tag(body,'v');let value=null;
      if(ca.t==='s'&&rawValue!==undefined)value=strings[Number(rawValue)]??null;
      else if(ca.t==='inlineStr')value=texts(body);
      else if(ca.t==='e')value=xml(rawValue);
      else if(ca.t==='str')value=xml(rawValue);
      else if(rawValue!==undefined&&rawValue!=='')value=Number.isFinite(Number(rawValue))?Number(rawValue):xml(rawValue);
      const formula=sharedFormula?'='+xml(f?.[1]||''):null;const error=ca.t==='e'?String(value):null;
      if(sharedFormula)formulas++;if(formula&&/\[\d+\]/.test(formula))external++;
      if(error)errors.push({sheet:a.name,cell:ref,error});
      const row=Number(ref.match(/\d+$/)[0]);let col=0;for(const ch of ref.match(/^[A-Z]+/)[0])col=col*26+ch.charCodeAt(0)-64;
      maxRow=Math.max(maxRow,row);maxColumn=Math.max(maxColumn,col);
      cells.set(ref,{value,raw_value_text:rawValue??null,cell_type:ca.t||'n',formula,error,cache_state:error?'source_error':sharedFormula?(value===null?'cache_missing':'cached'):(value===null?'missing':'literal'),source_ref:{sheet:a.name,cell:ref}});
    }
    sheets.push({name:a.name,cells,max_row:maxRow,max_column:maxColumn,hidden:a.state==='hidden'});
  }
  return {sheets,errors,date1904:/<workbookPr\b[^>]*date1904="(?:1|true)"/.test(book),formula_count:formulas,external_formula_count:external,external_relationship_count:[...entries.keys()].filter(n=>/^xl\/externalLinks\/externalLink\d+\.xml$/.test(n)).length};
}
const blank=(sheet,cell)=>({value:null,formula:null,error:null,cache_state:'missing',source_ref:{sheet,cell}});
const cell=(sheet,ref)=>sheet.cells.get(ref)||blank(sheet.name,ref);
const at=(sheet,col,row)=>cell(sheet,`${columnName(col)}${row}`);
const label=c=>c.value===null?'':String(c.value).trim();
const metricSpecs=[
  ['misconduct_loss','罚款及损失'],['violation','违规操作'],['review','点评'],['mystery','神秘访客'],['svr','SVR'],['remote','远程巡店'],
  ['turnover_full','全职离职率'],['turnover_part','兼职离职率'],['revenue_attainment','预算营业额达成'],['profit_attainment','预算利润达成'],
];
const sourceIssue=(code,message,extra={})=>({code,message,...extra});

export function inspectSourcePerformance(buf,{year}={}) {
  const w=readNamedWorkbook(buf);if(!w)return null;
  const detail=w.sheets.find(s=>s.name==='员工明细第3季度'),summary=w.sheets.find(s=>s.name==='汇总判定'),management=w.sheets.find(s=>s.name==='AM KSP');
  if(!detail||!summary||!management)return null;
  if(!Number.isInteger(Number(year))||Number(year)<2000||Number(year)>2200)bad('原生绩效导入须明确来源年份');
  const months=[3,4,5].map(c=>Number(at(detail,c,3).value));
  if(months.join(',')!=='7,8,9')bad('检测到源表月份与三季度适配器不同，请使用规范模板并明确期间映射');
  const periods=months.map(m=>`${year}-${String(m).padStart(2,'0')}`);const people=[];
  for(let row=4;row<=detail.max_row;row++) {
    const ordinal=at(detail,1,row),name=at(detail,2,row);if(!Number.isInteger(Number(ordinal.value))||Number(ordinal.value)<=0||!label(name))continue;
    const monthly=periods.map((period,i)=>{
      const score=at(detail,9+i*2,row),amount=at(detail,15+i,row),rating=at(detail,10+i*2,row),company=at(detail,3+i,row),grade=at(detail,6+i,row);
      const factor={S:2,A:1.5,B:1.2,C:1,D:0}[label(rating)];const implied=score.value>0&&factor>0&&num(amount.value)!==null?amount.value/(score.value*factor):null;
      return {period,company_label:label(company),grade_label:label(grade),source_saved_score:num(score.value),source_saved_amount:num(amount.value),source_rating:label(rating),
        implied_base:implied,score_mode:score.formula&&/VLOOKUP/i.test(score.formula)?'company_lookup':'manual_or_management',
        quality:{score:score.cache_state,amount:amount.cache_state},source_cells:{company,grade,score,rating,amount},source_ref:{sheet:detail.name,range:`${columnName(3+i)}${row}:${columnName(15+i)}${row}`}};
    });
    const quarter=at(detail,18,row);
    people.push({source_ordinal:String(ordinal.value),source_row:row,name_label:label(name),months:monthly,
      source_saved_cycle_amount:num(quarter.value),quarter_source:quarter,source_saved_alternative_cycle_amount:num(at(detail,37,row).value),alternative_quarter_source:at(detail,37,row),identity_status:'mapping_required',
      notice:'序号仅为本次文件的映射键，不是集团员工编号；姓名不用于自动匹配'});
  }
  const companies=[];const blocks=[{period:periods[0],label:71,deduction:81,score:90,rating:91,hasRemote:false},{period:periods[1],label:36,deduction:47,score:57,rating:58,hasRemote:true},{period:periods[2],label:1,deduction:12,score:22,rating:23,hasRemote:true}];
  const rulesByMonth={};
  for(const block of blocks) {
    const specs=metricSpecs.filter(([code])=>block.hasRemote||code!=='remote');
    rulesByMonth[block.period]={metrics:specs.map(([code])=>({code:`source_deduction_${code}`,unit:'ratio',method:'direct_deduction'}))};
    for(let row=5;row<=summary.max_row;row++) {
      const co=at(summary,block.label,row),score=at(summary,block.score,row);if(!label(co)||score.value===null)continue;
      const ms=specs.map(([code,name],i)=>({code,name,raw:at(summary,block.label+1+i,row),deduction:at(summary,block.deduction+i,row),
        rule_text:label(at(summary,block.label+1+i,3)),source_weight:at(summary,block.deduction+i,4)}));
      companies.push({candidate_key:`${block.period}:${row}`,label:label(co),period:block.period,source_row:row,source_saved_score:num(score.value),source_rating:label(at(summary,block.rating,row)),
        score_source:score,metrics:ms,classification:'company_or_aggregate_unconfirmed',
        source_ref:{sheet:summary.name,range:`${columnName(block.label)}${row}:${columnName(block.rating)}${row}`}});
    }
  }
  const managers=[];
  for(let col=6;col<=32;col+=2) {
    const sourceName=at(management,col,3);if(!label(sourceName))continue;
    const monthly=periods.map((period,i)=>{
      const scoreRow=[20,42,65][i],ratingRow=[21,43,66][i],amountRow=[22,44,67][i];
      return {period,score:at(management,col,scoreRow),rating:at(management,col,ratingRow),amount:at(management,col,amountRow),
        source_ref:{sheet:management.name,range:`${columnName(col)}${scoreRow}:${columnName(col)}${amountRow}`}};
    });
    managers.push({candidate_key:columnName(col),name_label:label(sourceName),role_label:label(at(management,col,2)),months:monthly,
      quarter_score:at(management,col,77),quarter_rating:at(management,col,78),quarter_amount:at(management,col,79),
      responsibility_status:'counts_and_denominators_only_no_confirmed_company_set',
      notice:'源表计数/分母不等于已确认所辖公司清单；月金额/3及季度再次平均的基数口径待核验'});
  }
  const duplicates=[];for(const b of blocks){const seen=new Set();for(const c of companies.filter(c=>c.period===b.period)){if(seen.has(c.label))duplicates.push({period:c.period,label:c.label});seen.add(c.label);}}
  const warnings=[sourceIssue('SOURCE_IDENTITY_MAPPING_REQUIRED','源编号是报表序号，不自动建立人员主档'),
    sourceIssue('SOURCE_RULE_CONFIRMATION_REQUIRED','保存缓存、外链结果及推算基数均未核验，不能自动确认奖金'),
    sourceIssue('SOURCE_UNIT_REVIEW_REQUIRED','点评分值/百分比及管理金额分母须核对原规则'),
    sourceIssue('SOURCE_MANAGEMENT_SCOPE_REQUIRED','管理责任需要明确公司集合和权重，不能由姓名或店数推定')];
  if(duplicates.length)warnings.push(sourceIssue('SOURCE_DUPLICATE_COMPANY_LABEL','月块中有重复标签，可能是汇总/重复行，须逐行分类',{count:duplicates.length}));
  return {format:'source_s01',mapping_required:true,candidates:{people,companies,management:managers},source_summary:{
    sha256:createHash('sha256').update(buf).digest('hex'),sheets:w.sheets.map(s=>({name:s.name,max_row:s.max_row,max_column:s.max_column})),
    formula_count:w.formula_count,external_formula_count:w.external_formula_count,external_relationship_count:w.external_relationship_count,error_cell_count:w.errors.length,
    error_cells:w.errors,people_count:people.length,person_month_count:people.length*3,company_month_candidate_count:companies.length,
    management_candidate_count:managers.length,changed_company_count:people.filter(p=>new Set(p.months.map(m=>m.company_label).filter(Boolean)).size>1).length,
    changed_grade_count:people.filter(p=>new Set(p.months.map(m=>m.grade_label).filter(Boolean)).size>1).length,periods,
  },rules_proposal:{confirmed:false,aggregation:null,available_aggregations:['floor_average_months','average_score_last_grade'],
    alternative_eligibility:null,alternative_rounding:null,payout_assignment:'last_month_employment',score_base:1,score_floor:0,
    rating_bands:[{min_score:.995,grade:'S',factor:2},{min_score:.945,grade:'A',factor:1.5},{min_score:.845,grade:'B',factor:1.2},{min_score:.505,grade:'C',factor:1},{min_score:0,grade:'D',factor:0}],
    grade_bases:{},...rulesByMonth[periods[2]],month_overrides:rulesByMonth,
    management:{confirmed:false,method:'weighted_company_scores',rating_bands:[{min_score:1,grade:'S',factor:2},{min_score:.945,grade:'A',factor:1.5},{min_score:.845,grade:'B',factor:1.2},{min_score:.505,grade:'C',factor:1},{min_score:0,grade:'D',factor:0}]}},
    warnings,notice:'原生工作簿已按具名工作表读取。全部缓存仅作核验候选；不执行公式、不打开外链、不创建人员、不批准奖金。'};
}

const eq=(a,b)=>String(a)===String(b);
const day=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
export function mapSourcePerformance(source,{mapping={},cycle,companies,people,grades,employments,filename}) {
  const issues=[];const proposed={company_metrics:[],person_months:[],responsibilities:[]};const preview=[];const matchedKeys=new Set(),personMonthKeys=new Set();
  const issue=(code,message,extra={})=>issues.push(sourceIssue(code,message,extra));
  const excludes=new Set(mapping.exclude_company_rows||[]);
  for(const candidate of source.candidates.companies) {
    if(excludes.has(candidate.candidate_key)) {preview.push({candidate_key:candidate.candidate_key,status:'excluded',record_type:'company_metric'});continue;}
    const cid=mapping.company_rows?.[candidate.candidate_key]??mapping.companies?.[candidate.label];const co=companies.find(v=>eq(v.id,cid));
    if(!co){issue('COMPANY_MAPPING_REQUIRED','原门店/汇总标签尚未映射至周期内公司或明确排除',{candidate_key:candidate.candidate_key,label:candidate.label,period:candidate.period});continue;}
    const key=`${co.id}:${candidate.period}`;if(matchedKeys.has(key)){issue('COMPANY_MAPPING_DUPLICATE','多个源行映射到同一公司月份，须确认汇总/重复行并排除',{candidate_key:candidate.candidate_key});continue;}matchedKeys.add(key);
    if(candidate.period<day(cycle.start_date).slice(0,7)||candidate.period>=day(cycle.end_date).slice(0,7)){issue('PERIOD_MISMATCH','源月份不属于所选周期',{period:candidate.period});continue;}
    const metrics={};for(const m of candidate.metrics) {
      metrics[`source_deduction_${m.code}`]={value:num(m.deduction.value),unit:'ratio',status:m.deduction.error||m.raw.error||candidate.score_source.error?'source_error':'unverified',
        source_ref:{filename,...m.deduction.source_ref,formula:m.deduction.formula,raw_cell:m.raw.source_ref,raw_value:m.raw.value,raw_formula:m.raw.formula,raw_error:m.raw.error,rule_text:m.rule_text}};
    }
    proposed.company_metrics.push({company_id:co.id,period:candidate.period,metrics,source_saved_score:candidate.source_saved_score,source_ref:{filename,...candidate.source_ref,source_candidate_key:candidate.candidate_key}});
    preview.push({candidate_key:candidate.candidate_key,status:'matched_unverified',record_type:'company_metric',company_id:co.id,period:candidate.period});
  }
  const personExcludes=new Set(mapping.exclude_people||[]);
  for(const p of source.candidates.people) {
    if(personExcludes.has(p.source_ordinal)){preview.push({source_ordinal:p.source_ordinal,status:'excluded',record_type:'person_month'});continue;}
    const person=people.find(v=>eq(v.id,mapping.people?.[p.source_ordinal]));if(!person){issue('PERSON_MAPPING_REQUIRED','需以明确人员主档映射原序号；不按姓名自动匹配',{source_ordinal:p.source_ordinal,source_row:p.source_row});continue;}
    for(const [index,m] of p.months.entries()) {
      const cid=mapping.person_companies?.[`${p.source_ordinal}:${m.period}`]??mapping.companies?.[m.company_label];const co=companies.find(v=>eq(v.id,cid));
      const grade=grades.find(v=>eq(v.id,mapping.grades?.[m.grade_label]));
      if(!co||!grade){issue('PERSON_MONTH_MAPPING_REQUIRED','该月公司/职级标签尚未明确匹配',{source_ordinal:p.source_ordinal,period:m.period});continue;}
      const end=new Date(`${m.period}-01T00:00:00Z`);end.setUTCMonth(end.getUTCMonth()+1);const eid=mapping.employments?.[`${p.source_ordinal}:${m.period}`];
      const es=employments.filter(e=>eq(e.person_id,person.id)&&eq(e.company_id,co.id)&&e.status!=='cancelled'&&day(e.hire_date)<end.toISOString().slice(0,10)&&(!e.leave_date||day(e.leave_date)>=`${m.period}-01`)&&(!eid||eq(e.id,eid)));
      if(es.length!==1){issue('EMPLOYMENT_MAPPING_REQUIRED','该月无法唯一匹配既有雇佣；不自动新建入职/调动',{source_ordinal:p.source_ordinal,period:m.period});continue;}
      const personKey=`${person.id}:${m.period}`;
      if(personMonthKeys.has(personKey)){issue('PERSON_MAPPING_DUPLICATE','多个源序号映射到同一人员月份，请核验身份',{source_ordinal:p.source_ordinal,period:m.period});continue;}
      let scoreSource=mapping.score_sources?.[p.source_ordinal];
      if(!scoreSource&&m.score_mode==='company_lookup')scoreSource='company';
      if(!['company','management'].includes(scoreSource)){issue('SCORE_SOURCE_REQUIRED','手工/管理者达成度需明确计算来源与责任范围',{source_ordinal:p.source_ordinal,period:m.period});continue;}
      personMonthKeys.add(personKey);
      proposed.person_months.push({person_id:person.id,employment_id:es[0].id,company_id:co.id,grade_id:grade.id,period:m.period,score_source:scoreSource,
        eligibility_weight:1,eligibility_status:'unverified',bonus_base_override:m.implied_base,bonus_base_status:'unverified',
        source_saved_score:m.source_saved_score,source_saved_amount:m.source_saved_amount,source_saved_cycle_amount:index===p.months.length-1?p.source_saved_cycle_amount:null,
        source_saved_alternative_cycle_amount:index===p.months.length-1?p.source_saved_alternative_cycle_amount:null,
        source_ref:{filename,...m.source_ref,source_ordinal:p.source_ordinal,source_cells:m.source_cells,quarter_source:p.quarter_source,alternative_quarter_source:p.alternative_quarter_source}});
      preview.push({source_ordinal:p.source_ordinal,status:'matched_unverified',record_type:'person_month',company_id:co.id,person_id:person.id,period:m.period});
      if(scoreSource==='management'&&!Array.isArray(mapping.responsibilities))issue('MANAGEMENT_SCOPE_REQUIRED','管理者需另给所辖公司与权重，原表分母不等于责任门店清单',{source_ordinal:p.source_ordinal,period:m.period});
    }
  }
  if(Array.isArray(mapping.responsibilities))proposed.responsibilities=mapping.responsibilities.map(r=>({...r,status:'unverified'}));
  return {...source,filename,mapping_required:issues.length>0,mapping,preview,issues,can_apply:issues.length===0&&proposed.person_months.length>0,proposed};
}
