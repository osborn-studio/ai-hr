// 天意 HR 工作空间。基础资料使用新版 API；业务页面保留原授权边界。
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const same = (a, b) => String(a ?? '') === String(b ?? '');
const text = (v) => v === null || v === undefined || v === '' ? '—' : esc(v);
const date = (v) => v ? esc(String(v).slice(0, 10)) : '—';
const STORAGE = 'tyhr.workspace.token';
const CONTEXT_STORAGE = 'tyhr.workspace.context';
const safeRead = (key, fallback = '') => { try { return sessionStorage.getItem(key) || fallback; } catch { return fallback; } };
const safeWrite = (key, value) => { try { value ? sessionStorage.setItem(key, value) : sessionStorage.removeItem(key); } catch { /* storage is optional */ } };
let context = {group_id:'', ledger_id:'', company_id:''};
try { context = {...context, ...JSON.parse(safeRead(CONTEXT_STORAGE, '{}'))}; } catch { /* start with no scope */ }
import { canOpenRoute } from './workspace-permissions.mjs';
const state = {token:safeRead(STORAGE), me:null, permissions:{}, data:{}, context, page:1, query:'', route:'home', loadId:0, editor:null};
const pageSize = 15;

const statusLabels = {active:'启用',inactive:'停用',ended:'已结束',cancelled:'已取消',draft:'草稿',pending:'待核'};
const enumLabels = {
  group:'集团帐套',brand:'品牌帐套',store:'门店公司',headquarters:'总部公司',kitchen:'中央厨房',
  department_extension:'部门化档口',work_area_in_department:'部门内工作区',
  full_time:'全职',part_time:'兼职',hourly:'小时工',outsourced:'外包',FT:'全职（FT）',PT:'兼职（PT）',LTPT:'长期兼职（LTPT）',
};
const options = (...pairs) => pairs.map(([value,label]) => ({value,label}));
const field = (key,label,type='text',extra={}) => ({key,label,type,...extra});
const groupField = () => field('group_id','所属集团','select',{source:'groups',required:true});
const companyField = () => field('company_id','所属公司','select',{source:'companies',required:true});
const codeName = () => [field('code','编码','text',{required:true}),field('name','名称','text',{required:true})];
const regionCurrencyFields=()=>[field('region_code','业务地区','select',{help:'可留空表示不设统一地区；财务业务确认前仍需有明确公司地区',options:options(['CN','中国内地'],['HK','中国香港'])}),field('currency_code','默认业务币种','select',{help:'与地区同时填写，或同时留空',options:options(['CNY','人民币 CNY'],['HKD','港元 HKD'])})];
const ref = (source,id,fallback='—') => {
  const r=(state.data[source]||[]).find(x=>same(x.id,id));
  return r ? esc(r.full_name || r.name || r.login || r.code) : esc(fallback);
};
const col = (label,render) => ({label,render});
const nameCol = () => col('名称',r=>`<span class="cell-title">${text(r.name)}</span><span class="cell-sub">${text(r.code)}</span>`);
const companyCol = () => col('公司',r=>ref('companies',r.company_id));
const statusCol = () => col('状态',r=>badge(r.status));
const GROUP = '组织基础';
const configs = {
  groups:{label:'集团',section:'平台基础',collection:'groups',endpoint:'groups',description:'集团是人员身份的统一范围；不同集团的数据分别授权。',note:'集团编码用于识别管理范围，名称可以调整。',fields:()=>codeName(),columns:[nameCol(),statusCol()]},
  brands:{label:'品牌',section:'平台基础',collection:'brands',endpoint:'brands',description:'统一维护品牌，同一地点下的不同品牌门店分别建档。',fields:()=>[groupField(),...codeName(),...regionCurrencyFields()],columns:[nameCol(),col('地区',r=>text(({CN:'中国内地',HK:'中国香港'})[r.region_code]||'待配置')),col('币种',r=>text(r.currency_code||'待配置')),col('集团',r=>ref('groups',r.group_id)),statusCol()]},
  ledgers:{label:'业务帐套',section:'平台基础',collection:'ledgers',endpoint:'ledgers',description:'按集团、品牌或单店划定业务帐套范围。',note:'品牌帐套须选择品牌；门店帐套只能对应一家经营核算公司。',fields:()=>[groupField(),...codeName(),field('scope_mode','帐套范围','select',{required:true,options:options(['group','集团帐套'],['brand','品牌帐套'],['store','门店帐套'])}),field('brand_id','所属品牌','select',{source:'brands'}),...regionCurrencyFields()],columns:[nameCol(),col('地区',r=>text(({CN:'中国内地',HK:'中国香港'})[r.region_code]||'待配置')),col('币种',r=>text(r.currency_code||'待配置')),col('范围',r=>text(r.scope_mode==='store'?'门店帐套':enumLabels[r.scope_mode])),col('品牌',r=>ref('brands',r.brand_id)),col('集团',r=>ref('groups',r.group_id)),statusCol()]},
  companies:{label:'门店公司',section:GROUP,collection:'companies',endpoint:'companies',description:'门店作为经营核算公司管理，公司内部另设部门；法定主体关系单独核实。',note:'经营核算公司与独立法人资格分别管理。请填写稳定编码，避免用商场或门店名称合并不同品牌。',fields:()=>[groupField(),field('ledger_id','业务帐套','select',{source:'ledgers',required:true}),field('brand_id','所属品牌','select',{source:'brands'}),...codeName(),field('company_kind','公司类型','select',{required:true,options:options(['store','门店公司'],['headquarters','总部公司'],['kitchen','中央厨房'])}),field('legal_name','已核实的法定主体名称','text',{placeholder:'未知时留空'}),field('address','地址','text',{wide:true})],columns:[nameCol(),col('品牌',r=>ref('brands',r.brand_id)),col('帐套',r=>ref('ledgers',r.ledger_id)),col('类型',r=>text(enumLabels[r.company_kind]||r.company_kind)),col('法定主体',r=>r.legal_name?text(r.legal_name):'<span class="badge pending">待核实</span>'),statusCol()]},
  departments:{label:'部门',section:GROUP,collection:'departments',endpoint:'departments',description:'维护公司内部行政部门，父子部门须属于同一家公司。',fields:()=>[companyField(),field('parent_department_id','上级部门','select',{source:'departments'}),...codeName()],columns:[nameCol(),companyCol(),col('上级部门',r=>ref('departments',r.parent_department_id,'公司直属')),statusCol()]},
  workareas:{label:'档口与工作区',section:GROUP,collection:'work_areas',endpoint:'work-areas',description:'档口关联公司内部门，可作为部门化档口或部门内部工作区。',note:'部门化档口沿用一个部门的组织职责；部门内工作区保留所属部门。两种模式都不代替岗位。',fields:()=>[companyField(),field('department_id','归口部门','select',{source:'departments',required:true}),...codeName(),field('mode','档口模式','select',{required:true,options:options(['department_extension','部门化档口'],['work_area_in_department','部门内工作区'])})],columns:[nameCol(),companyCol(),col('归口部门',r=>ref('departments',r.department_id)),col('模式',r=>text(enumLabels[r.mode])),statusCol()]},
  jobs:{label:'标准岗位',section:GROUP,collection:'jobs',endpoint:'jobs',description:'集团统一的岗位目录，例如厨师、服务员、店长，与部门和系统权限角色分别管理。',fields:()=>[groupField(),...codeName(),field('job_family','岗位序列','text',{placeholder:'如：厨房、服务、管理'})],columns:[nameCol(),col('岗位序列',r=>text(r.job_family)),col('集团',r=>ref('groups',r.group_id)),statusCol()]},
  grades:{label:'职级',section:GROUP,collection:'grades',endpoint:'grades',description:'职级描述任职等级，独立于标准岗位和部门。',fields:()=>[groupField(),...codeName(),field('level','排序等级','number',{min:0,help:'用于职级排序，可留空'})],columns:[nameCol(),col('排序等级',r=>text(r.level)),col('集团',r=>ref('groups',r.group_id)),statusCol()]},
  positions:{label:'公司岗位设置',section:GROUP,collection:'positions',endpoint:'positions',description:'把标准岗位设置到具体公司的部门，作为员工任职的组织位置。',fields:()=>[groupField(),companyField(),field('department_id','所属部门','select',{source:'departments',required:true}),field('job_id','标准岗位','select',{source:'jobs',required:true}),field('grade_id','参考职级','select',{source:'grades'}),...codeName()],columns:[nameCol(),companyCol(),col('部门',r=>ref('departments',r.department_id)),col('标准岗位',r=>ref('jobs',r.job_id)),col('职级',r=>ref('grades',r.grade_id)),statusCol()]},
  people:{label:'人员档案',section:'人员与任职',collection:'people',endpoint:'people',description:'集团人员身份长期保留；跨店、调动或复聘时沿用原始人员编号。',note:'同名不代表同一人。人员编号一经分配不复用，复聘请在原档案下新增雇佣经历。',fields:()=>[groupField(),field('person_number','永久人员编号','text',{help:'新增时留空由系统分配；原编号不因调店而变化'}),field('full_name','姓名','text',{required:true})],columns:[col('人员',r=>`<span class="cell-title">${text(r.full_name)}</span><span class="cell-sub">${text(r.person_number)}</span>`),col('集团',r=>ref('groups',r.group_id)),col('雇佣记录',r=>String((state.data.employments||[]).filter(e=>same(e.person_id,r.id)).length)),statusCol()]},
  employments:{label:'雇佣经历',section:'人员与任职',collection:'employments',endpoint:'employments',description:'每次入职保存独立雇佣段；跨公司入职与短期跨店支援分别处理。',note:'离职日包含当天。复聘关联原已结束的雇佣经历，人员身份与编号保持不变。',fields:()=>[groupField(),field('person_id','人员','select',{source:'people',required:true}),companyField(),field('employment_type','用工类型','select',{required:true,options:options(['full_time','全职'],['part_time','兼职'],['hourly','小时工'],['outsourced','外包'],['FT','FT'],['PT','PT'],['LTPT','LTPT'])}),field('hire_date','入职日','date',{required:true}),field('leave_date','离职日','date',{help:'离职日当天仍计在雇佣范围'}),field('rehire_link','复聘关联原雇佣','select',{source:'employments'}),field('legal_subject_name','已核实的雇佣主体','text',{placeholder:'未知时留空'})],columns:[col('人员',r=>ref('people',r.person_id)),companyCol(),col('用工类型',r=>text(enumLabels[r.employment_type]||r.employment_type)),col('入职日',r=>date(r.hire_date)),col('离职日',r=>date(r.leave_date)),statusCol()]},
  assignments:{label:'任职记录',section:'人员与任职',collection:'assignments',endpoint:'assignments',description:'任职记录关联雇佣、公司岗位与部门，保留起止期间和主兼职信息。',note:'失效日为不再任职的第一天。例如任职至月底，失效日填写下月1日。同一雇佣的主任职期间不能重叠。',fields:()=>[groupField(),companyField(),field('employment_id','雇佣经历','select',{source:'employments',required:true}),field('department_id','任职部门','select',{source:'departments',required:true}),field('position_id','公司岗位','select',{source:'positions',required:true}),field('grade_id','人员职级','select',{source:'grades'}),field('work_area_id','档口或工作区','select',{source:'work_areas'}),field('valid_from','生效日','date',{required:true}),field('valid_to','失效日（不含当天）','date'),field('is_primary','任职性质','select',{required:true,options:options(['true','主任职'],['false','兼任'])})],columns:[col('人员 / 雇佣',r=>{const e=(state.data.employments||[]).find(e=>same(e.id,r.employment_id));return `${ref('people',e?.person_id)}<span class="cell-sub">${date(e?.hire_date)} 入职</span>`;}),companyCol(),col('部门 / 岗位',r=>`${ref('departments',r.department_id)}<span class="cell-sub">${ref('positions',r.position_id)}</span>`),col('档口',r=>ref('work_areas',r.work_area_id)),col('有效期',r=>`${date(r.valid_from)} 至 ${r.valid_to?date(r.valid_to):'持续'}`),col('性质',r=>r.is_primary?'主任职':'兼任'),statusCol()]},
  grants:{label:'基础资料授权',section:'平台管理',collection:'grants',endpoint:'grants',description:'授权账号访问指定集团、帐套或公司的新版基础资料。',note:'此处授权只作用于新版组织与人员基础，不自动授予工资、考勤等兼容业务权限。失效日为不再生效的第一天。',fields:()=>[field('account_id','系统账号','select',{source:'accounts',required:true}),groupField(),field('ledger_id','帐套范围','select',{source:'ledgers',help:'留空表示当前集团内授权范围'}),field('company_id','公司范围','select',{source:'companies',help:'留空表示上层已选范围'}),field('can_read','查看权限','select',{required:true,options:options(['true','允许查看'],['false','不允许查看'])}),field('can_write','维护权限','select',{required:true,options:options(['false','只读'],['true','允许维护'])}),field('valid_from','生效日','date',{required:true}),field('valid_to','失效日（不含当天）','date')],columns:[col('账号',r=>ref('accounts',r.account_id)),col('集团',r=>ref('groups',r.group_id)),col('帐套',r=>ref('ledgers',r.ledger_id,'集团范围')),col('公司',r=>ref('companies',r.company_id,'上层范围')),col('权限',r=>r.can_write?'查看与维护':r.can_read?'只读':'无查看权限'),col('有效期',r=>`${date(r.valid_from)} 至 ${r.valid_to?date(r.valid_to):'持续'}`)]},
};

const legacy = {
  home:['原业务工作台','个人工作'],ledger:['原业务帐套与账号','平台管理'],employees:['兼容员工档案','人员与任职'],
  contract:['人事合同','人员与任职'],exceptions:['业务例外','平台管理'],org:['组织机构图','组织基础'],
  headcount:['编制管理','组织基础'],exit:['离职交接','人员与任职'],severance:['离职结算','人员与任职'],cashout:['年假与折现','考勤排班'],
  roster:['排班','考勤排班'],punch:['打卡','考勤排班'],attendance:['考勤明细','考勤排班'],attx:['考勤异常','考勤排班'],att:['考勤月报','考勤排班'],close:['考勤封账','考勤排班'],leave:['假期额度','考勤排班'],leavereq:['请假单','考勤排班'],
  payroll:['算薪工作台','薪酬管理'],payslip:['工资条','薪酬管理'],salaryitem:['工资项目','薪酬管理'],adjust:['工资调整','薪酬管理'],siledger:['社保台账','薪酬管理'],declare:['申报表','薪酬管理'],settlement:['外包结算','薪酬管理'],
  recruit:['招聘','招聘与发展'],perf:['绩效','招聘与发展'],training:['培训与考试','招聘与发展'],dashboard:['数据看板','经营分析'],report:['报表','经营分析'],approval:['待办审批','个人工作'],roles:['我的权限','个人工作'],policy:['业务制度','平台管理'],paypolicy:['薪酬政策','薪酬管理'],health:['运行自检','平台管理'],mcp:['AI开放接口','平台管理'],
};
const navGroups = [
  ['概览',[['home','工作台','▦']]],
  ['组织基础',[['organization','组织全景','⌘'],['companies','门店公司','□'],['departments','部门','⌘'],['workareas','档口与工作区','◇'],['jobs','标准岗位','◫'],['grades','职级','≡'],['positions','公司岗位设置','⊞'],['legacy-org','组织机构图','⌘'],['legacy-headcount','编制管理','▦']]],
  ['人员与任职',[['people','人员档案','○'],['employments','雇佣经历','↗'],['assignments','任职记录','◷'],['legacy-employees','兼容员工档案','▣'],['legacy-contract','人事合同','▤'],['legacy-exit','离职交接','↗'],['legacy-severance','离职结算','≡']]],
  ['考勤排班',[['legacy-roster','排班','▤'],['legacy-punch','打卡','◉'],['legacy-attendance','考勤人日','▥'],['legacy-attx','考勤异常','!'],['legacy-att','考勤月报','▥'],['legacy-close','考勤封账','⊡'],['legacy-leave','假期额度','◴'],['legacy-leavereq','请假单','◻'],['legacy-cashout','年假与折现','◴']]],
  ['薪酬管理',[['customer-payroll','薪酬核算','▤'],['hk-tools','香港用工与日薪','◷'],['legacy-payroll','算薪工作台','▤'],['legacy-payslip','工资条','▧'],['legacy-salaryitem','工资项目','＋'],['legacy-adjust','工资调整','↗'],['legacy-paypolicy','薪酬政策','≡'],['legacy-siledger','社保台账','▣'],['legacy-declare','申报表','▥'],['legacy-settlement','外包结算','□']]],
  ['招聘与发展',[['legacy-recruit','招聘','○'],['customer-performance','绩效考核','◇'],['legacy-perf','绩效','◇'],['legacy-training','培训与考试','▱']]],
  ['经营分析',[['legacy-dashboard','数据看板','▥'],['legacy-report','报表','▤']]],
  ['个人工作',[['my-payroll','我的工资','▧'],['my-leave','我的假期','◴'],['my-training','我的培训与考试','▱'],['legacy-home','原业务工作台','▦'],['legacy-approval','待办审批','✓'],['legacy-roles','我的权限','◈']]],
  ['平台管理',[['groups','集团','⊞'],['brands','品牌','◇'],['ledgers','业务帐套','▣'],['grants','基础资料授权','⌘'],['foundation-bridge','业务接续','⇄'],['foundation-import','花名册导入','⇧'],['legacy-ledger','原业务帐套与账号','▣'],['legacy-policy','业务制度','≡'],['legacy-exceptions','业务例外','!'],['legacy-health','运行自检','◉'],['legacy-mcp','AI开放接口','⌁']]],
];

function badge(status) { const v=status||'active';return `<span class="badge ${v==='active'?'':v==='pending'||v==='draft'?'pending':'inactive'}">${esc(statusLabels[v]||v)}</span>`; }
function toast(message,bad=false) {const t=$('#toast');t.textContent=message;t.className='toast'+(bad?' bad':'');t.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.hidden=true,bad?6000:3000);}
function showLogin(message='') {document.querySelectorAll('dialog[open]').forEach(d=>d.close());$('#loginScreen').hidden=false;$('#workspace').hidden=true;$('#loginError').hidden=!message;$('#loginError').textContent=message;}
async function request(path,{method='GET',body,authenticate=true}={}) {
  let response;
  try {response=await fetch(path,{method,headers:{...(authenticate&&state.token?{authorization:`Bearer ${state.token}`}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
  catch {throw new Error('无法连接本地服务，请确认服务已启动。');}
  let result;try{result=await response.json();}catch{throw new Error(`服务返回了无法读取的结果（HTTP ${response.status}）。`);}
  if(!response.ok){if(response.status===401&&authenticate){state.token='';safeWrite(STORAGE,'');showLogin('登录已失效，请重新登录。');}const hint=result.message||(response.status===409?'记录冲突，请检查重复编码、已有关系或有效期重叠。':response.status===403?'当前账号没有操作此范围的权限。':response.status===400?'内容未通过校验，请检查必填项、日期和关联范围。':'');throw new Error(`${result.error||`HTTP ${response.status}`}${hint?'：'+hint:''}`);}
  return result;
}
function activeCollection(name){return state.data[name]||[];}
function canWrite(key=state.route){
  const c=state.data.capabilities||{};
  if(key==='grants')return !!c.can_manage_access;
  if(key==='groups')return !!c.can_create_group;
  if(['brands','ledgers','jobs','grades','people'].includes(key))return !!c.can_write_shared;
  return !!c.can_write;
}
function today(){return String(state.me?.today||new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})).slice(0,10);}
function rememberContext(){safeWrite(CONTEXT_STORAGE,JSON.stringify(state.context));}
function contextQuery(){return new URLSearchParams(Object.entries(state.context).filter(([,v])=>v!==''&&v!==null)).toString();}
async function refresh(){
  const requestId=(state.requestId||0)+1;state.requestId=requestId;
  const data=await request('/api/foundation/bootstrap'+(contextQuery()?'?'+contextQuery():''));
  if(requestId!==state.requestId)return;
  state.data=data;
  if(state.data.context)Object.keys(state.context).forEach(k=>state.context[k]=state.data.context[k]===null?'':String(state.data.context[k]??''));
  renderContexts();renderNavigation();await renderPage();
}
function makeContextOptions(id,rows,empty,current){
  const select=$(id);select.innerHTML=`<option value="">${esc(empty)}</option>`+rows.map(r=>`<option value="${esc(r.id)}">${esc(r.name||r.code)}</option>`).join('');
  select.value=rows.some(r=>same(r.id,current))?String(current):'';
  return select.value;
}
function renderContexts(){
  const d=state.data,c=state.context;
  c.group_id=makeContextOptions('#groupContext',d.groups||[],'选择集团',c.group_id);
  c.ledger_id=makeContextOptions('#ledgerContext',(d.ledgers||[]).filter(r=>!c.group_id||same(r.group_id,c.group_id)),'全部授权帐套',c.ledger_id);
  c.company_id=makeContextOptions('#companyContext',(d.companies||[]).filter(r=>(!c.group_id||same(r.group_id,c.group_id))&&(!c.ledger_id||same(r.ledger_id,c.ledger_id))),'全部授权公司',c.company_id);
  rememberContext();
}
function renderNavigation(){
  state.navOpen ||= new Set(['组织基础']);
  const currentSection=navGroups.find(([heading,items])=>heading!=='概览'&&items.some(([key])=>key===state.route));
  if(currentSection)state.navOpen=new Set([currentSection[0]]);
  $('#navigation').innerHTML=navGroups.map(([heading,items])=>{
    const visible=items.filter(([key])=>canOpenRoute(key,state.permissions)&&(key!=='grants'||state.data.capabilities?.can_manage_access));
    if(!visible.length)return '';
    const content=visible.map(([key,label,icon])=>`<button class="nav-item ${key===state.route?'active':''}" data-route="${key}" ${key===state.route?'aria-current="page"':''}><span class="nav-icon" aria-hidden="true">${icon}</span>${esc(label)}</button>`).join('');
    if(heading==='概览')return `<section class="nav-section">${content}</section>`;
    const open=state.navOpen.has(heading)||visible.some(([key])=>key===state.route);
    return `<details class="nav-section" data-nav-section="${esc(heading)}" ${open?'open':''}><summary class="nav-heading">${esc(heading)}<span class="nav-caret" aria-hidden="true">›</span></summary><div class="nav-children">${content}</div></details>`;
  }).join('');
  $('#navigation').querySelectorAll('[data-nav-section]').forEach(section=>section.addEventListener('toggle',()=>{
    if(section.open){state.navOpen=new Set([section.dataset.navSection]);$('#navigation').querySelectorAll('[data-nav-section]').forEach(other=>{if(other!==section)other.open=false;});}
    else state.navOpen.delete(section.dataset.navSection);
  }));
  $('#navigation').querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>navigate(b.dataset.route));
}
function navigate(route){
  if(route===state.route){renderPage();return;}
  location.hash=route;
}
function heading(title,description,actions=''){return `<div class="page-heading"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions?`<div class="heading-actions">${actions}</div>`:''}</div>`;}
async function renderPage(){
  const id=++state.loadId,route=state.route,container=$('#content');document.querySelectorAll('dialog.customer-dialog').forEach(d=>d.close());container.onclick=null;
  const oldFrame=container.querySelector('iframe');if(oldFrame)oldFrame.src='about:blank';
  container.className='';container.scrollTop=0;
  if(!canOpenRoute(route,state.permissions)){
    $('#breadcrumb').innerHTML='<b>当前岗位权限</b>';container.innerHTML='<section class="card"><h2>当前账号未开放此功能</h2><p class="muted">请从左侧菜单进入已授权的业务。</p><a href="#home">返回工作台</a></section>';return;
  }
  const isLegacy=route.startsWith('legacy-');
  $('.contextbar').classList.toggle('legacy-context',isLegacy);
  ['#groupContext','#ledgerContext','#companyContext'].forEach(k=>$(k).disabled=isLegacy);
  $('#contextHelp').textContent=isLegacy?'兼容业务使用原授权范围':'基础资料按当前范围显示';
  if(route==='home'){$('#breadcrumb').innerHTML='<b>工作台</b>';renderHome();return;}
  if(['my-payroll','my-training','my-leave'].includes(route)){$('#breadcrumb').innerHTML=`<b>${route==='my-payroll'?'我的工资':route==='my-leave'?'我的假期':'我的培训与考试'}</b>`;return renderEmployeeSelf({kind:route==='my-payroll'?'pay':route==='my-leave'?'leave':'training',container,request,me:state.me,token:state.token,toast,capabilities:state.permissions,isCurrent:()=>id===state.loadId});}
  if(route==='hk-tools'){$('#breadcrumb').innerHTML='<b>香港用工与日薪</b>';return renderHKTools({container,bootstrap:state.data,context:state.context,token:state.token,request,toast,isCurrent:()=>id===state.loadId});}
  if(route==='organization'){$('#breadcrumb').innerHTML='<b>组织全景</b>';return renderOrganization({container,bootstrap:state.data,context:state.context,asOf:today(),token:state.token,isCurrent:()=>id===state.loadId});}
  if(route==='foundation-import'){$('#breadcrumb').innerHTML='<b>花名册导入</b>';return renderFoundationImport({container,request,bootstrap:state.data,context:state.context,token:state.token,toast,capabilities:state.permissions,isCurrent:()=>id===state.loadId});}
  if(['customer-payroll','customer-performance','foundation-bridge'].includes(route)){
    const kind=route==='foundation-bridge'?'bridge':route==='customer-payroll'?'payroll':'performance';
    $('#breadcrumb').innerHTML=`<b>${esc(kind==='bridge'?'业务接续':kind==='payroll'?'薪酬核算':'绩效考核')}</b>`;
    return renderCustomer({kind,container,request,bootstrap:state.data,context:state.context,token:state.token,toast,capabilities:state.permissions,isCurrent:()=>id===state.loadId});
  }
  if(isLegacy){const key=route.slice(7),meta=legacy[key];if(!meta){navigate('home');return;}$('#breadcrumb').innerHTML=`${esc(meta[1])}<span class="slash">/</span><b>${esc(meta[0])}</b>`;renderLegacy(key,meta);return;}
  const config=configs[route];if(!config){navigate('home');return;}
  $('#breadcrumb').innerHTML=`${esc(config.section)}<span class="slash">/</span><b>${esc(config.label)}</b>`;
  if(id!==state.loadId)return;
  renderList(config);
}

function renderHome(){
  const d=state.data,c=state.context;
  const visibleCompanies=getRows(configs.companies),companyFoot=[['store','家门店'],['headquarters','家总部'],['kitchen','家中央厨房']].map(([kind,label])=>{const n=visibleCompanies.filter(r=>r.company_kind===kind).length;return n?`${n} ${label}`:'';}).filter(Boolean).join(' · ')||'当前授权范围';
  const stat=(key,label,foot)=>`<button class="stat" data-home-route="${key}"><span class="stat-label">${label}</span><strong class="stat-number">${key==='companies'?(d.counts?.companies??getRows(configs[key]).length):activeCollection(configs[key].collection).length}</strong><span class="stat-foot">${foot}</span></button>`;
  const current=(source,id,all)=>id?ref(source,id):esc(all);
  $('#content').innerHTML=heading('工作台','从公司组织到人员任职，先把基础关系维护清楚。',`<button id="reloadHome">刷新</button>`)+
    `<div class="stats-grid">${stat('companies','经营公司总数',companyFoot)}${stat('departments','公司内部部门','各公司分别维护')}${stat('people','集团人员档案','永久编号保留')}${stat('employments','雇佣经历','含历史雇佣段')}</div>
     <div class="home-grid"><section class="card"><h2>基础配置路径</h2><div class="workflow">
       <a href="#ledgers"><span class="step-number">1</span><span><b>建立集团、品牌与帐套</b><small>确定业务归属和管理范围</small></span><span class="arrow">›</span></a>
       <a href="#companies"><span class="step-number">2</span><span><b>配置门店公司与内部组织</b><small>公司、部门、档口和岗位各有自己的位置</small></span><span class="arrow">›</span></a>
       <a href="#people"><span class="step-number">3</span><span><b>建人员档案，记录每次雇佣</b><small>同一个人调店、复聘，身份编号保持连续</small></span><span class="arrow">›</span></a>
       <a href="#assignments"><span class="step-number">4</span><span><b>明确部门、岗位与任职期间</b><small>保留历史，避免覆盖原来的任职经历</small></span><span class="arrow">›</span></a>
     </div></section><section class="card"><h2>当前工作范围</h2><dl class="scope-list"><div><dt>集团</dt><dd>${current('groups',c.group_id,'全部已授权集团')}</dd></div><div><dt>帐套</dt><dd>${current('ledgers',c.ledger_id,'全部已授权帐套')}</dd></div><div><dt>公司</dt><dd>${current('companies',c.company_id,'全部已授权公司')}</dd></div><div><dt>基础维护</dt><dd>${canWrite()?'允许维护':'只读'}</dd></div></dl><div class="quick-links"><a href="#organization">组织全景</a><a href="#people">查人员经历</a><a href="#positions">设公司岗位</a><a href="#legacy-approval">待办审批</a></div></section></div>
     ${!activeCollection('groups').length&&d.capabilities?.can_manage_access&&state.permissions.profile_code!=='config_admin'?'<section class="card"><h2>开始本机演示</h2><p class="muted">创建一组虚构集团、双帐套与门店组织，用于检验基础配置。不会导入客户或员工原始资料。</p><button id="seedDemo">初始化虚构演示基础</button><div id="seedError" class="form-error" hidden></div></section>':''}`;
  $('#reloadHome').onclick=()=>runRefresh();
  if(state.permissions.profile_code&&!['config_admin','demo'].includes(state.permissions.profile_code)){
    const workflow=$('#content .workflow');
    if(workflow){workflow.previousElementSibling.textContent='岗位工作入口';workflow.innerHTML=navGroups.flatMap(([,items])=>items).filter(([route])=>route!=='home'&&canOpenRoute(route,state.permissions)).slice(0,8).map(([route,label,icon])=>`<a href="#${esc(route)}"><span class="step-number">${esc(icon)}</span><span><b>${esc(label)}</b><small>按当前账号与数据范围进入</small></span><span class="arrow">›</span></a>`).join('');}
  }
  $('#content').querySelectorAll('[data-home-route]').forEach(button=>{if(!canOpenRoute(button.dataset.homeRoute,state.permissions))button.disabled=true;});
  if(d.capabilities?.can_manage_access&&state.permissions.resources?.payroll_run?.can_write&&state.permissions.resources?.perf_cycle?.can_write&&state.permissions.resources?.payroll_slips_read_all?.can_read){
    const card=document.createElement('section');card.className='card';card.innerHTML='<h2>天意集团 · 双品牌20门店</h2><p class="muted">建立香香鱼米、大富烤肉各10家门店，以及人员任职、薪酬与绩效案例。所有名称、编号和金额均为独立生成的假数据；已建立时进入原测试帐套。</p><div class="toolbar"><label>初始绩效算法 <select id="testAggregation"><option value="floor_average_months">逐月奖金取均后向下取整</option><option value="average_score_last_grade">平均达成度与末月职级基数</option></select></label><button class="primary" id="seedCompleteTest">建立完整测试帐套</button></div><p class="form-error" id="completeTestError" hidden></p>';$('#content').append(card);
    card.querySelector('#seedCompleteTest').onclick=async e=>{e.target.disabled=true;try{const r=await request('/api/foundation/test-seed',{method:'POST',body:{confirm_synthetic:true,selected_aggregation:card.querySelector('#testAggregation').value}});state.context={group_id:String(r.group_id),ledger_id:'',company_id:''};rememberContext();await refresh();navigate('home');toast('已进入完整虚构测试帐套');}catch(error){card.querySelector('#completeTestError').textContent=error.message;card.querySelector('#completeTestError').hidden=false;e.target.disabled=false;}};
  }
  document.querySelectorAll('[data-home-route]').forEach(b=>b.onclick=()=>navigate(b.dataset.homeRoute));
  const seed=$('#seedDemo');if(seed)seed.onclick=async()=>{seed.disabled=true;try{await request('/api/foundation/demo-seed',{method:'POST',body:{}});await refresh();toast('虚构演示基础已创建');}catch(e){$('#seedError').textContent=e.message;$('#seedError').hidden=false;seed.disabled=false;}};
  $('#content').querySelectorAll('a[href^="#"]').forEach(a=>{if(!canOpenRoute(a.getAttribute('href').slice(1),state.permissions))a.hidden=true;});
}

function getRows(config){
  let rows=[...activeCollection(config.collection)];
  if(config.collection==='companies')rows=rows.filter(r=>(!state.context.ledger_id||same(r.ledger_id,state.context.ledger_id))&&(!state.context.company_id||same(r.id,state.context.company_id)));
  const q=state.query.trim().toLocaleLowerCase();
  if(q)rows=rows.filter(r=>Object.values(r).some(v=>v!==null&&typeof v!=='object'&&String(v).toLocaleLowerCase().includes(q))||config.columns.some(c=>c.render(r).replace(/<[^>]*>/g,'').toLocaleLowerCase().includes(q)));
  return rows;
}
function renderList(config){
  const permission=canWrite(state.route);
  $('#content').innerHTML=heading(config.label,config.description,`<button id="reloadList">刷新</button>${permission?`<button class="primary" id="newRecord">＋ 新增${esc(config.label)}</button>`:''}`)+
    `${!permission?'<div class="notice">当前账号以只读方式查看此范围的基础资料。</div>':''}`+
    `<section class="card list-card"><div class="list-tools"><input class="search-input" id="listSearch" aria-label="搜索${esc(config.label)}" placeholder="搜索名称、编码或相关组织" value="${esc(state.query)}"><span class="record-total" id="recordTotal"></span></div><div class="table-wrap" id="listTable"></div><div class="pagination" id="listPagination"></div></section>`;
  $('#reloadList').onclick=()=>runRefresh();
  if($('#newRecord'))$('#newRecord').onclick=()=>openEditor(state.route);
  $('#listSearch').oninput=e=>{state.query=e.target.value;state.page=1;renderTable(config);};
  renderTable(config);
}
function renderTable(config){
  const rows=getRows(config),total=rows.length,pages=Math.max(1,Math.ceil(total/pageSize));state.page=Math.min(Math.max(1,state.page),pages);
  const shown=rows.slice((state.page-1)*pageSize,state.page*pageSize),writable=canWrite(state.route);
  $('#recordTotal').textContent=`共 ${total} 条`;
  const actions=writable||state.route==='people';
  $('#listTable').innerHTML=shown.length?`<table><thead><tr>${config.columns.map(c=>`<th>${esc(c.label)}</th>`).join('')}${actions?'<th>操作</th>':''}</tr></thead><tbody>${shown.map(r=>`<tr>${config.columns.map(c=>`<td>${c.render(r)}</td>`).join('')}${actions?`<td><div class="cell-actions">${state.route==='people'?`<button class="text-button" data-timeline="${esc(r.id)}">经历</button>`:''}${writable?`<button class="text-button" data-edit="${esc(r.id)}">编辑</button>${['grants','employments','assignments'].includes(state.route)||r.status==='inactive'?'':`<button class="text-button" data-deactivate="${esc(r.id)}">停用</button>`}`:''}</div></td>`:''}</tr>`).join('')}</tbody></table>`:`<div class="empty-state"><h3>${state.query?'没有找到匹配的记录':'当前范围还没有记录'}</h3><p>${state.query?'试试其他名称或编码。':writable?'点击“新增”开始维护，或调整顶部业务范围。':'可调整顶部业务范围，或联系管理员确认授权。'}</p></div>`;
  $('#listPagination').innerHTML=`<span>${total?`${(state.page-1)*pageSize+1}–${Math.min(state.page*pageSize,total)} / ${total}`:'0 条'}</span><button id="prevPage" ${state.page===1?'disabled':''}>上一页</button><span>${state.page} / ${pages}</span><button id="nextPage" ${state.page===pages?'disabled':''}>下一页</button>`;
  $('#prevPage').onclick=()=>{state.page--;renderTable(config);};$('#nextPage').onclick=()=>{state.page++;renderTable(config);};
  $('#listTable').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openEditor(state.route,activeCollection(config.collection).find(x=>same(x.id,b.dataset.edit))));
  $('#listTable').querySelectorAll('[data-timeline]').forEach(b=>b.onclick=()=>openTimeline(b.dataset.timeline));
  $('#listTable').querySelectorAll('[data-deactivate]').forEach(b=>b.onclick=async()=>{
    const r=activeCollection(config.collection).find(x=>same(x.id,b.dataset.deactivate));
    if(!confirm(`停用“${r.name||r.full_name||r.code}”？历史记录会保留。`))return;
    b.disabled=true;try{await request(`/api/foundation/${config.endpoint}/${r.id}/deactivate`,{method:'POST',body:{}});await refresh();toast('已停用，历史资料保留');}catch(e){toast(e.message,true);b.disabled=false;}
  });
}

function initialValues(key,row){
  const value={...row};const c=state.context;
  if(!row){
    if(c.group_id)value.group_id=c.group_id;if(c.company_id)value.company_id=c.company_id;if(c.ledger_id)value.ledger_id=c.ledger_id;
    if(key==='companies')value.company_kind='store';if(key==='ledgers')value.scope_mode='group';if(key==='workareas')value.mode='work_area_in_department';
    if(key==='employments'){value.employment_type='full_time';value.hire_date=today();}
    if(key==='assignments'){value.is_primary=true;value.valid_from=today();}
    if(key==='grants'){value.can_read=true;value.can_write=false;value.valid_from=today();}
  }
  return value;
}
function selectionLabel(source,r){
  if(source==='people')return `${r.full_name} · ${r.person_number}`;
  if(source==='employments'){const p=activeCollection('people').find(x=>same(x.id,r.person_id));const c=activeCollection('companies').find(x=>same(x.id,r.company_id));return `${p?.full_name||'人员'} · ${c?.name||'公司'} · ${String(r.hire_date||'').slice(0,10)}`;}
  if(source==='accounts')return `${r.name||r.display_name||r.login||'账号'}${r.login?' · '+r.login:''}`;
  return `${r.name||r.code}${r.code&&r.name?' · '+r.code:''}`;
}
function sourceOptions(f,values){
  let rows=activeCollection(f.source);const group=values.group_id||state.context.group_id,company=values.company_id,department=values.department_id;
  if(f.key==='rehire_link'&&state.editor?.rehireCandidates)rows=state.editor.rehireCandidates;
  if(group&&f.source!=='groups')rows=rows.filter(r=>r.group_id===undefined||same(r.group_id,group));
  if(f.source==='companies'&&values.ledger_id)rows=rows.filter(r=>same(r.ledger_id,values.ledger_id));
  if(company&&f.key!=='rehire_link'&&['departments','work_areas','positions','employments'].includes(f.source))rows=rows.filter(r=>same(r.company_id,company));
  if(department&&['work_areas','positions'].includes(f.source))rows=rows.filter(r=>same(r.department_id,department));
  if(f.key==='parent_department_id'&&state.editor?.row)rows=rows.filter(r=>!same(r.id,state.editor.row.id));
  if(f.key==='rehire_link'){rows=rows.filter(r=>(r.status==='ended'||r.leave_date)&&(!values.person_id||same(r.person_id,values.person_id))&&(!state.editor?.row||!same(r.id,state.editor.row.id)));}
  return rows;
}
function renderEditorFields(values){
  const {key,row}=state.editor,config=configs[key],fields=config.fields();
  if(row&&['employments','assignments'].includes(key))fields.push(field('status','记录状态','select',{required:true,options:options(['active','在职 / 有效'],['ended','已结束'],['cancelled','已取消'])}));
  if(row&&!['employments','assignments','grants'].includes(key))fields.push(field('status','使用状态','select',{options:options(['active','启用'],['inactive','停用'])}));
  state.editor.fields=fields;
  $('#editorFields').innerHTML=fields.map(f=>{
    const required=f.required?' required':'',id=`field-${f.key}`,v=values[f.key]??'';
    let control;
    if(f.type==='select'){
      let os=f.options||sourceOptions(f,values).map(r=>({value:String(r.id),label:selectionLabel(f.source,r)}));
      if(v!==''&&!os.some(o=>same(o.value,v))&&f.options)os=[...os,{value:String(v),label:String(v)}];
      const lockedGroup=f.key==='group_id'&&(state.context.group_id||(row&&key==='people'));
      control=`<select id="${id}" name="${f.key}"${required}${lockedGroup?' disabled':''}><option value="">${f.required?'请选择':'不指定'}</option>${os.map(o=>`<option value="${esc(o.value)}" ${same(o.value,v)?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`;
    }else control=`<input id="${id}" name="${f.key}" type="${f.type}" value="${esc(f.type==='date'?String(v).slice(0,10):v)}"${required}${f.min!==undefined?` min="${f.min}"`:''}${f.placeholder?` placeholder="${esc(f.placeholder)}"`:''}${row&&key==='people'&&f.key==='person_number'?' readonly':''}>`;
    return `<label class="field${f.wide?' wide':''}" for="${id}"><span>${esc(f.label)}${f.required?'<span class="required">*</span>':''}</span>${control}${f.help?`<small>${esc(f.help)}</small>`:''}</label>`;
  }).join('');
  $('#editorFields').querySelectorAll('select').forEach(s=>s.onchange=async()=>{
    const currentEditor=state.editor;
    let next=editorValues();
    const clear=(...keys)=>keys.forEach(k=>next[k]='');
    if(s.name==='group_id')clear('ledger_id','brand_id','company_id','person_id','department_id','parent_department_id','position_id','grade_id','job_id','employment_id','work_area_id','rehire_link');
    if(s.name==='ledger_id'){
      clear('company_id','department_id','parent_department_id','position_id','employment_id','work_area_id');
      const l=activeCollection('ledgers').find(x=>same(x.id,s.value));if(l?.brand_id)next.brand_id=l.brand_id;
    }
    if(s.name==='brand_id'&&key==='ledgers'){const b=activeCollection('brands').find(b=>same(b.id,s.value));if(!next.region_code)next.region_code=b?.region_code||'';if(!next.currency_code)next.currency_code=b?.currency_code||'';}
    if(s.name==='region_code'&&!next.currency_code)next.currency_code=next.region_code==='HK'?'HKD':next.region_code==='CN'?'CNY':'';
    if(s.name==='company_id')clear('department_id','parent_department_id','position_id','employment_id','work_area_id');
    if(s.name==='department_id')clear('position_id','work_area_id');
    if(s.name==='person_id'){
      clear('rehire_link');currentEditor.rehireCandidates=[];
      if(key==='employments'&&next.person_id){
        const historyPerson=next.person_id;
        try{const history=await request(`/api/foundation/people/${encodeURIComponent(historyPerson)}/timeline`);if(state.editor!==currentEditor||!same(editorValues().person_id,historyPerson))return;currentEditor.rehireCandidates=(history.timeline||history).employments||[];next={...editorValues(),rehire_link:''};}
        catch(error){if(state.editor!==currentEditor)return;$('#editorError').textContent=error.message;$('#editorError').hidden=false;}
      }
    }
    if(state.editor!==currentEditor)return;
    renderEditorFields(next);
  });
}
function editorValues(){const values={};for(const f of state.editor.fields){const input=$(`#field-${f.key}`);values[f.key]=input?.value??'';}return values;}
function openEditor(key,row=null){
  if(!canWrite(key)){toast('当前账号没有维护此范围的权限。',true);return;}
  state.editor={key,row,fields:[]};const c=configs[key];$('#editorTitle').textContent=`${row?'编辑':'新增'}${c.label}`;$('#editorEyebrow').textContent=c.section;$('#editorNote').textContent=c.note||c.description;$('#editorError').hidden=true;$('#saveEditor').disabled=false;renderEditorFields(initialValues(key,row));$('#editor').showModal();
  if(key==='employments'&&row?.person_id){const currentEditor=state.editor;request(`/api/foundation/people/${row.person_id}/timeline`).then(history=>{if(state.editor===currentEditor&&$('#editor').open){currentEditor.rehireCandidates=(history.timeline||history).employments||[];renderEditorFields(editorValues());}}).catch(error=>{if(state.editor===currentEditor&&$('#editor').open){$('#editorError').textContent=error.message;$('#editorError').hidden=false;}});}
}
async function saveEditor(e){
  e.preventDefault();const editor=state.editor,{key,row,fields}=editor,c=configs[key],raw=editorValues(),body={};
  for(const f of fields){let v=raw[f.key];if(f.type==='select'&&['is_primary','can_read','can_write'].includes(f.key))v=v==='true';else if((f.key.endsWith('_id')||f.key==='rehire_link'||f.type==='number')&&v!=='')v=Number(v);else if(v==='')v=null;body[f.key]=v;}
  // Related IDs are selected by the user; the server owns all relation checks.
  const selectedCompany=activeCollection('companies').find(r=>same(r.id,body.company_id));
  if(!body.group_id&&selectedCompany?.group_id)body.group_id=selectedCompany.group_id;
  if(key==='people'&&!row&&!body.person_number)delete body.person_number;
  if(key==='employments'&&body.leave_date&&!body.status)body.status='ended';
  if(key==='assignments'&&body.valid_to&&!body.status)body.status='ended';
  if(row){
    for(const f of fields){
      if(!Object.hasOwn(body,f.key))continue;
      let original=row[f.key]??null;
      if(f.type==='date'&&original)original=String(original).slice(0,10);
      if(body[f.key]===original||(body[f.key]!==null&&original!==null&&String(body[f.key])===String(original)))delete body[f.key];
    }
    if(!Object.keys(body).length){$('#editor').close();state.editor=null;toast('内容没有变化');return;}
  }
  $('#saveEditor').disabled=true;$('#editorError').hidden=true;
  try{await request(`/api/foundation/${c.endpoint}${row?'/'+row.id:''}`,{method:row?'PUT':'POST',body});$('#editor').close();state.editor=null;await refresh();toast(`${c.label}已保存`);}
  catch(error){$('#editorError').textContent=error.message;$('#editorError').hidden=false;$('#saveEditor').disabled=false;}
}

async function openTimeline(personId){
  $('#detailTitle').textContent='人员经历';$('#detailBody').className='detail-body';$('#detailBody').innerHTML='<p class="muted">正在读取经历…</p>';$('#detail').showModal();
  try{
    const result=await request(`/api/foundation/people/${personId}/timeline`),d=result.timeline||result,p=d.person||{},employment=d.employments||[];
    $('#detailTitle').textContent=p.full_name?`${p.full_name}的经历`:'人员经历';
    $('#detailBody').innerHTML=`<div class="detail-facts"><span>永久编号<b>${text(p.person_number)}</b></span><span>集团<b>${ref('groups',p.group_id)}</b></span></div>${employment.length?employment.map(e=>`<section class="timeline-section"><h3>${text(e.company_name||activeCollection('companies').find(c=>same(c.id,e.company_id))?.name)} ${badge(e.status)}</h3><div class="timeline-item"><b>${date(e.hire_date)} 入职${e.leave_date?'，'+date(e.leave_date)+' 离职':''}</b><p>${text(enumLabels[e.employment_type]||e.employment_type)} · ${text(e.ledger_name)}</p>${(e.assignments||[]).map(a=>`<div class="timeline-item"><b>${text(a.department_name)} / ${text(a.position_name)}</b><p>${date(a.valid_from)} 至 ${a.valid_to?date(a.valid_to)+'（失效日）':'持续'} · ${a.is_primary?'主任职':'兼任'}${a.work_area_name?' · '+esc(a.work_area_name):''}</p></div>`).join('')}</div></section>`).join(''):'<div class="empty-state"><h3>暂无当前授权范围内的雇佣经历</h3><p>人员档案已保留，可在“雇佣经历”中登记入职。</p></div>'}`;
  }catch(error){$('#detailBody').innerHTML=`<div class="notice error">${esc(error.message)}</div>`;}
}

function sendLegacySession(frame){
  if(frame?.contentWindow&&state.token)frame.contentWindow.postMessage({type:'tyhr:session',token:state.token,group_id:state.context.group_id,ledger_id:state.context.ledger_id,company_id:state.context.company_id},location.origin);
}
function renderLegacy(key,meta){
  const notice=state.data.legacy?.scope_notice||'兼容业务按原授权范围显示；新版帐套与公司筛选尚不改变旧业务数据范围。';
  $('#content').className='legacy-host';
  $('#content').innerHTML=`<div class="legacy-heading">${heading(meta[0],'')}<div class="notice warning">${esc(notice)} 顶部范围选择在此暂停。</div></div><iframe class="legacy-frame" id="legacyFrame" title="${esc(meta[0])}" src="/?embed=1#${encodeURIComponent(key)}"></iframe>`;
  $('#legacyFrame').addEventListener('load',()=>sendLegacySession($('#legacyFrame')));
}
window.addEventListener('message',event=>{
  const frame=$('#legacyFrame');if(event.origin!==location.origin||!frame||event.source!==frame.contentWindow)return;
  if(event.data?.type==='tyhr:ready')sendLegacySession(frame);
  if(['tyhr:auth-expired','tyhr:auth-required'].includes(event.data?.type)){state.token='';safeWrite(STORAGE,'');showLogin('业务会话已失效，请重新登录。');}
});
async function runRefresh(){try{await refresh();}catch(e){toast(e.message,true);}}
async function enter(){
  const [me,permissions]=await Promise.all([request('/api/me'),request('/api/me/capabilities')]);state.me=me;state.permissions=permissions;$('#accountName').textContent=state.me.name||state.me.login||'已登录账号';$('#avatar').textContent=(state.me.name||'人').slice(0,1);
  try{await refresh();}catch(error){if(!Object.values(state.context).some(Boolean)||!/E_TY_FORBIDDEN|E_TY_NOT_FOUND/.test(error.message))throw error;state.context={group_id:'',ledger_id:'',company_id:''};rememberContext();await refresh();}$('#loginScreen').hidden=true;$('#workspace').hidden=false;
}
$('#loginForm').onsubmit=async e=>{
  e.preventDefault();const submit=$('#loginForm button[type="submit"]');submit.disabled=true;$('#loginError').hidden=true;
  try{const r=await request('/login',{method:'POST',authenticate:false,body:{login:$('#loginUser').value.trim(),password:$('#loginPassword').value}});state.token=r.token;safeWrite(STORAGE,state.token);state.context={group_id:'',ledger_id:'',company_id:''};rememberContext();state.route='home';history.replaceState(null,'',location.pathname+location.search+'#home');await enter();$('#loginPassword').value='';}
  catch(error){showLogin(error.message);}finally{submit.disabled=false;}
};
$('#fillDemo').onclick=()=>{$('#loginUser').value='demo';$('#loginPassword').value='';$('#loginPassword').focus();};
$('#logout').onclick=async()=>{try{await request('/api/me/logout',{method:'POST',body:{}});}catch{/* local state still clears if the server is unavailable */}finally{state.loadId++;state.data={};state.permissions={};state.token='';safeWrite(STORAGE,'');$('#content').innerHTML='';showLogin();}};
$('#menuToggle').onclick=()=>$('#workspace').classList.toggle('nav-open');
$('#closeEditor').onclick=$('#cancelEditor').onclick=()=>$('#editor').close();
$('#closeDetail').onclick=()=>$('#detail').close();
$('#editorForm').onsubmit=saveEditor;
['group','ledger','company'].forEach(level=>{
  $(`#${level}Context`).onchange=async e=>{
    state.context[`${level}_id`]=e.target.value;
    if(level==='group'){state.context.ledger_id='';state.context.company_id='';}if(level==='ledger')state.context.company_id='';
    state.page=1;state.query='';rememberContext();await runRefresh();
  };
});
function readRoute(){const key=(location.hash.slice(1).split('/')[0]||'home');return key==='home'||configs[key]||['my-payroll','my-training','my-leave','customer-payroll','customer-performance','foundation-bridge','foundation-import','organization','hk-tools'].includes(key)||(key.startsWith('legacy-')&&legacy[key.slice(7)])?key:'home';}
window.addEventListener('hashchange',()=>{state.route=readRoute();state.page=1;state.query='';$('#workspace').classList.remove('nav-open');if(state.token){renderNavigation();renderPage();}});
state.route=readRoute();
if(state.token)enter().catch(error=>showLogin(error.message));else showLogin();
import { renderCustomer } from './customer-workbench.mjs';

import { renderFoundationImport } from './foundation-import-ui.mjs';

import { renderOrganization } from './organization-view.mjs';

import { renderHKTools } from './hk-tools-ui.mjs';
import { renderEmployeeSelf } from './employee-self-ui.mjs';
