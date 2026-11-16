import {
  createHash
} from 'node:crypto';
import {
  accessFor
} from './foundation.mjs';
import {
  bizErr
} from '../errors.mjs';
import {
  csv
} from '../csv.mjs';
import {
  calculate,
  difference,
  money,
  totals,
  parseFormula,
  validateFormula,
  SUPPORTED_OPERATORS
} from './customer-payroll-engine.mjs';
import {
  parseFiveTable,
  parseCsv,
  FIVE_TABLE_ITEMS
} from './customer-payroll-import.mjs';
import {regionCode,companyLocale,ruleJurisdiction,JURISDICTION_MODULES} from './payroll-jurisdiction.mjs';

const bad = m => {
    throw bizErr('E_TY_ARGUMENT', m);
  },
  deny = () => {
    throw bizErr('E_TY_FORBIDDEN', '当前账号缺少薪酬权限或该公司授权');
  },
  missing = () => {
    throw bizErr('E_TY_NOT_FOUND', '工资记录不存在或不在你的授权范围');
  };
const same = (a, b) => String(a) === String(b);
async function candidateMoney(tx,exact){
  if(typeof exact!=='string'||exact.length>200||!/^[-+]?\d+(?:\.\d*)?(?:e[-+]?\d+)?$/i.test(exact))throw new Error('绩效金额无效');
  const r=(await tx.query('SELECT round($1::numeric,2)::text amount,$1::numeric=round($1::numeric,2) exact,abs(round($1::numeric,2))<10000000000000000::numeric in_range',[exact])).rows[0];
  if(!r.in_range)throw new Error('绩效金额超出范围');return r;
}
const id = v => {
  if (!['string', 'number'].includes(typeof v) || !/^\d+$/.test(String(v)) || !Number.isSafeInteger(Number(
      v)) || Number(v) <= 0) bad('标识必须是正整数');
  return Number(v);
};
const str = (v, max = 500) => {
  if (typeof v !== 'string' || v.length > max) bad('文本内容无效或过长');
  return v.trim();
};
const json = v => JSON.stringify(v);
const hash = v => createHash('sha256').update(json(v)).digest('hex');
const kinds = new Set(['earning', 'deduction', 'employee_contribution', 'employer_contribution',
'reference']);
async function access(tx, userId, write = false) {
  const caps = (await tx.query(
    "SELECT fn_role_can($1,'payroll_run',$2) run,fn_role_can($1,'payroll_slips_read_all','read') amounts",
    [userId, write ? 'write' : 'read'])).rows[0];
  if (!caps?.run || !caps?.amounts) deny();
  return accessFor(tx, userId);
}
async function audit(tx, userId, batchId, action, detail = {}, rulesetId = null) {
  await tx.query(
    'INSERT INTO ty_payroll_audit(batch_id,ruleset_id,actor_id,action,detail) VALUES($1,$2,$3,$4,$5::jsonb)',
    [batchId, rulesetId, userId, action, json(detail)]);
}
async function companyContext(tx, companyId) {
  return (await tx.query('SELECT c.*,c.id company_id FROM ty_company c WHERE c.id=$1', [companyId])).rows[
  0];
}

function groupCheck(a, groupId, write = false) {
  if (!a.group(groupId, write)) deny();
}
async function mappingCheck(tx, a, gid, row, write = true) {
  if (!row.company_id) {
    if (!a.shared(gid, write)) deny();
    return;
  }
  const c = await companyContext(tx, row.company_id);
  if (!c || !same(c.group_id, gid) || !a.row(c, write)) deny();
  if (row.person_id) {
    const p = (await tx.query('SELECT group_id FROM ty_person WHERE id=$1', [row.person_id])).rows[0];
    if (!p || !same(p.group_id, gid)) bad('人员与工资集团不一致');
  }
  if (row.employment_id) {
    const e = (await tx.query('SELECT * FROM ty_employment WHERE id=$1', [row.employment_id])).rows[0];
    if (!e || !same(e.person_id, row.person_id) || !same(e.company_id, row.company_id) || !same(e.group_id,
        gid)) bad('雇佣、人员与公司不一致');
  }
}
async function load(tx, userId, batchId, {
  write = false,
  ledgerId = null,
  companyId = null,
  lock = false
} = {}) {
  const a = await access(tx, userId, write);
  const b = (await tx.query(`SELECT * FROM ty_payroll_batch WHERE id=$1${lock?' FOR UPDATE':''}`, [id(
    batchId)])).rows[0];
  if (!b || !a.group(b.group_id)) missing();
  const all = (await tx.query(
    `SELECT r.*,c.name company_name,c.code company_code,c.ledger_id,p.person_number,p.full_name,e.hire_date,e.leave_date,e.status employment_status FROM ty_payroll_row r LEFT JOIN ty_company c ON c.id=r.company_id LEFT JOIN ty_person p ON p.id=r.person_id LEFT JOIN ty_employment e ON e.id=r.employment_id WHERE r.batch_id=$1 ORDER BY r.id`,
    [b.id])).rows;
  const visible = all.filter(r => (!ledgerId||same(r.ledger_id,ledgerId))&&(!companyId || same(r.company_id, companyId)) && (r.company_id ? a.row({
    ...r,
    company_id: r.company_id
  }, write) : a.shared(b.group_id, write)));
  if (!visible.length) missing();
  return {
    a,
    b,
    all,
    rows: visible,
    complete: visible.length === all.length
  };
}

function checkMutable(b) {
  if (b.status === 'confirmed') throw bizErr('E_TY_CONFLICT', '该批次已确认并锁定，请建立更正批次');
}

function normalizeRow(raw, index) {
  if (raw?.provenance?.type === 'performance') bad('绩效来源只接受已确认结果的服务过账，不接受客户端provenance');
  for (const k of ['performance_bonus', 'performance_amount'])
    if (raw?.inputs?.[k] !== undefined) {
      let v;
      try {
        v = money(raw.inputs[k]);
      } catch {
        bad('绩效输入数值无效');
      }
      if (v !== '0.00') bad('绩效奖金须由已确认结果过账，不可手填冒充');
    } if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('工资行格式无效');
  const input = raw.inputs || {};
  if (Object.keys(input).length > 180) bad('输入字段过多');
  const inputs = {};
  for (const [k, v] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v)) bad(
      '工资输入只接受简单变量');
    inputs[k] = typeof v === 'string' ? str(v, 200) : v;
  }
  const rawitems = raw.items || [];
  if (!Array.isArray(rawitems) || rawitems.length > 150) bad('工资项目过多');
  const seen = new Set();
  const items = rawitems.map(it => {
    const code = str(it.code, 64);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(code) || seen.has(code) || !kinds.has(it.kind)) bad(
      '工资项目编码重复或性质无效');
    seen.add(code);
    let amount = null;
    if (it.amount !== null && it.amount !== undefined && it.amount !== '') {
      try {
        amount = money(it.amount);
      } catch {
        bad('工资项目金额无效');
      }
    }
    return {
      code,
      name: str(it.name || code, 300),
      kind: it.kind,
      amount,
      ...(it.source_cell ? {
        source_cell: str(it.source_cell, 120)
      } : {})
    };
  });
  const source_totals = {};
  for (const [k, v] of Object.entries(raw.source_totals || {})) {
    if (!['net_pay', 'employee_contribution', 'employer_contribution', 'income_total', 'deduction_total',
        'payable_gross'
      ].includes(k)) continue;
    if (v !== null && v !== undefined && v !== '') {
      try {
        source_totals[k] = money(v);
      } catch {
        bad('来源合计金额无效');
      }
    }
  }
  if (raw.source_issues !== undefined && !Array.isArray(raw.source_issues)) bad('来源异常须为数组');
  const source_issues = (raw.source_issues || []).map(x => ({
    code: str(x.code || 'SOURCE_ISSUE', 64),
    message: str(x.message || '来源待确认', 500)
  }));
  if (source_issues.length > 200) bad('来源异常过多');
  const input_review={};
  for(const [key,review] of Object.entries(raw.input_review||{})){
    if(!Object.hasOwn(inputs,key))continue;
    input_review[key]={status:'unverified',origin:str(review.origin||'source_input',40),
      ...(review.source_cell?{source_cell:str(review.source_cell,120)}:{})};
  }
  return {
    source_key: str(raw.source_key || `ROW!${index+1}`, 200),
    source_person_name: str(raw.source_person_name || '', 200),
    source_person_number: raw.source_person_number ? str(String(raw.source_person_number), 100) : null,
    source_company_name: str(raw.source_company_name || '', 200),
    source_period: raw.source_period ? str(raw.source_period, 20) : null,
    inputs,
    input_review,
    items,
    source_totals,
    source_issues,
    data_kind: raw.data_kind === 'inputs' ? 'inputs' : 'source_snapshot',
    reference_totals: raw.reference_totals || {},
    provenance: raw.provenance ? {
      type: str(raw.provenance.type || '', 40),
      source_key: str(raw.provenance.source_key || '', 200),
      cycle_id: raw.provenance.cycle_id ? id(raw.provenance.cycle_id) : null,
      result_version: raw.provenance.result_version
    } : null
  };
}

function validateHeader(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') bad('请提交对象格式的数据');
  const group_id = id(input.group_id),
    period = str(input.period, 7),
    currency = str(input.currency, 3).toUpperCase();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || Number(period.slice(0, 4)) < 2000) bad('期间须为YYYY-MM');
  if (!/^[A-Z]{3}$/.test(currency)) bad('请明确填写三位币种');
  return {
    group_id,
    period,
    currency,
    region_code:regionCode(input.region_code)
  };
}
async function performanceSources(tx, {
  userId,
  batchId,
  rows,
  fresh = true
}) {
  const stored = (await tx.query('SELECT * FROM ty_payroll_performance_input WHERE batch_id=$1 ORDER BY id',
    [batchId])).rows;
  const visible = stored.filter(s => rows.some(r => same(r.id, s.row_id)));
  if (!visible.length) return new Map();
  const {
    getPayrollCandidates
  } = await import('./customer-performance.mjs');
  const byCycle = new Map(),
    byRow = new Map();
  for (const s of visible) {
    const r = rows.find(r => same(r.id, s.row_id));
    if (fresh && !byCycle.has(String(s.cycle_id))) {
      const response = await getPayrollCandidates(tx, {
        userId,
        cycleId: s.cycle_id
      });
      byCycle.set(String(s.cycle_id), response.candidates || []);
    }
    const c = s.candidate;
    if (!same(c.person_id, r.person_id) || !same(c.company_id, r.company_id) || !same(c.employment_id, r
        .employment_id)) bad('已过账绩效与工资人员匹配已改变，请建立更正批次');
    if (fresh) {
      const match = byCycle.get(String(s.cycle_id)).find(c => c.source_key === s.source_key);
      const exact=match?String(match.amount_exact??match.amount):null;
      const amountOk=match?(await tx.query('SELECT $1::numeric=$2::numeric AND round($1::numeric,2)=$3::numeric ok',[exact,String(c.amount_exact??c.amount),s.amount])).rows[0].ok:false;
      if (!match || match.period !== c.period || match.currency_code !== s.currency || !amountOk || !same(match.person_id, r.person_id) || !same(match.company_id, r
          .company_id) || !same(match.employment_id, r.employment_id)) bad('绩效来源未确认、版本已变更或超出授权，不能用于工资确认');
    }
    if (!byRow.has(String(r.id))) byRow.set(String(r.id), []);
    byRow.get(String(r.id)).push(s);
  }
  return byRow;
}

function performanceTotal(sources) {
  return totals(sources.map(s => ({
    kind: 'earning',
    amount: money(s.amount)
  }))).income_total;
}

function inputState(row, performance='0.00'){
  return {
    inputs:{...row.source_data.inputs,...(row.input_overrides||{}),performance_bonus:performance,performance_amount:performance},
    review:{...(row.source_data.input_review||{}),...(row.input_review||{})},
  };
}

export async function editRowInputs(tx,{userId,rowId,input}){
  const record=(await tx.query('SELECT batch_id FROM ty_payroll_row WHERE id=$1',[id(rowId)])).rows[0];
  if(!record)missing();
  const {b,rows}=await load(tx,userId,record.batch_id,{write:true,lock:true});checkMutable(b);
  const row=rows.find(r=>same(r.id,rowId));if(!row)missing();
  if(!input||Array.isArray(input)||typeof input!=='object')bad('请输入对象格式的工资输入');
  const reason=str(input.reason||'',500);if(!reason)bad('请填写输入修改或核验依据');
  const changes=input.inputs||{};if(Array.isArray(changes)||typeof changes!=='object'||Object.keys(changes).length>180)bad('输入字段格式无效');
  const schema=new Map(inputSchema().fields.map(f=>[f.key,f]));
  const overrides={...(row.input_overrides||{})},reviews={...(row.input_review||{})};
  for(const [key,value]of Object.entries(changes)){
    if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)||['performance_bonus','performance_amount'].includes(key))bad('该输入名称不可编辑，绩效须从已确认结果过账');
    if(value!==null&&!['number','string','boolean'].includes(typeof value))bad('工资输入只接受数值、文字或真假');
    const field=schema.get(key);
    if(value!==null&&value!==''){
      if(field?.type==='boolean'&&typeof value!=='boolean')bad(key+'必须明确选择真或假');
      if(field?.type==='number'){try{money(value);}catch{bad(key+'必须是数值');}}
    }
    overrides[key]=typeof value==='string'?str(value,200):value;
  }
  const keys=input.reviewed_keys??Object.keys(changes);
  if(!Array.isArray(keys)||keys.length>180||keys.some(k=>typeof k!=='string'))bad('核验字段应为名称数组');
  const merged={...row.source_data.inputs,...overrides};
  for(const key of new Set([...Object.keys(changes),...keys])){
    if(!Object.hasOwn(merged,key)||['performance_bonus','performance_amount'].includes(key))bad('不能核验不存在的输入字段');
    const present=merged[key]!==null&&merged[key]!==undefined&&merged[key]!=='';
    reviews[key]={status:present?'verified':'unverified',origin:Object.hasOwn(changes,key)?'manual_override':'source_review',reason,actor_id:userId,verified_at:new Date().toISOString()};
  }
  const updated=(await tx.query("UPDATE ty_payroll_row SET input_overrides=$1::jsonb,input_review=$2::jsonb,result_data=NULL,validation='{}'::jsonb WHERE id=$3 RETURNING *",[json(overrides),json(reviews),row.id])).rows[0];
  await tx.query("UPDATE ty_payroll_batch SET status='draft' WHERE id=$1",[b.id]);
  await audit(tx,userId,b.id,'edit_inputs',{row_id:row.id,changed_keys:Object.keys(changes),reviewed_keys:keys,reason,before_hash:hash(row.input_overrides||{}),after_hash:hash(overrides)});
  const state=inputState(updated);
  return{row:updated,effective_inputs:state.inputs,input_review:state.review,schema:inputSchema()};
}

// Follow dependencies in rule order, including an intermediate reference item.
// Exactly one income line may consume a posted performance amount. A second
// income line derived from it would otherwise count the same bonus twice.
function performanceIncomeCodes(rules) {
  const dependent = new Set(['performance_bonus', 'performance_amount']);
  const income = [];
  for (const rule of rules) {
    const variables = new Set();
    const visit = node => {
      if (!node || typeof node !== 'object') return;
      if (node.var) variables.add(node.var);
      if (Array.isArray(node.args)) node.args.forEach(visit);
    };
    visit(rule.formula);
    if (![...variables].some(v => dependent.has(v))) continue;
    dependent.add(rule.code);
    if (rule.kind === 'earning') income.push(rule.code);
  }
  return income;
}
export async function applyPerformanceCandidates(tx, {
  userId,
  batchId,
  ledgerId,companyId,
  input
}) {
  const ctx = await load(tx, userId, batchId, {
    write: true,
    ledgerId,companyId,
    lock: true
  });
  checkMutable(ctx.b);
  if (!ctx.complete) deny();
  if(input.rounding!==undefined&&!['exact','round_2'].includes(input.rounding))bad('绩效过账舍入方式只能为exact或round_2');
  const {
    getPayrollCandidates
  } = await import('./customer-performance.mjs');
  const response = await getPayrollCandidates(tx, {
    userId,
    cycleId: id(input.cycle_id),
    period: ctx.b.period
  });
  const applied = [],
    already_applied = [],
    blocked = [];
  if (response.blocked) return {
    applied,
    already_applied,
    blocked: [{
      reason: String(response.blocked)
    }],
    notice: '仅已确认的绩效结果可用于工资'
  };
  for (const candidate of response.candidates || []) {
    const row = ctx.rows.find(r => same(r.person_id, candidate.person_id) && same(r.company_id, candidate
      .company_id) && same(r.employment_id, candidate.employment_id));
    if (!row) {
      blocked.push({
        source_key: candidate.source_key,
        reason: '没有匹配本周期雇佣和公司的工资行'
      });
      continue;
    }
    if (candidate.period !== ctx.b.period || candidate.currency_code !== ctx.b.currency) {
      blocked.push({
        source_key: candidate.source_key,
        reason: '期间或币种与工资批次不同'
      });
      continue;
    }
    const exact=String(candidate.amount_exact??candidate.amount);let posted,precisionExact;
    try{const amount=await candidateMoney(tx,exact);posted=amount.amount;precisionExact=amount.exact;}
    catch{blocked.push({source_key:candidate.source_key,reason:'绩效金额超出可过账金额范围'});continue;}
    const old = (await tx.query(
      'SELECT * FROM ty_payroll_performance_input WHERE batch_id=$1 AND (source_key=$2 OR (row_id=$3 AND cycle_id=$4))',
      [ctx.b.id, candidate.source_key, row.id, candidate.cycle_id])).rows[0];
    if (old) {
      if (old.source_key === candidate.source_key && money(old.amount) === posted) {
        already_applied.push({
          source_key: candidate.source_key,
          row_id: row.id
        });
        continue;
      }
      blocked.push({
        source_key: candidate.source_key,
        reason: '同周期已有其他绩效版本，请建立更正工资批次'
      });
      continue;
    }
    if(!precisionExact&&input.rounding!=='round_2'){
      blocked.push({source_key:candidate.source_key,reason:'绩效结果含分以下金额，请明确选择按分舍入(round_2)后再过账'});continue;
    }
    const snapshot={...candidate,amount_exact:exact,payroll_rounding:input.rounding==='round_2'?'round_2':'exact'};
    await tx.query(
      'INSERT INTO ty_payroll_performance_input(batch_id,row_id,source_key,cycle_id,result_version,amount,currency,candidate,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
      [ctx.b.id, row.id, candidate.source_key, candidate.cycle_id, candidate.result_version, posted,
        candidate.currency_code, json(snapshot), userId]);
    await tx.query("UPDATE ty_payroll_row SET result_data=NULL,validation='{}'::jsonb WHERE id=$1", [row
      .id]);
    applied.push({
      source_key: candidate.source_key,
      row_id: row.id,
      amount: posted,
      amount_exact:exact,rounding:snapshot.payroll_rounding,
      currency: ctx.b.currency
    });
  }
  if (applied.length) await tx.query("UPDATE ty_payroll_batch SET status='draft' WHERE id=$1", [ctx.b.id]);
  await audit(tx, userId, ctx.b.id, 'apply_performance', {
    cycle_id: input.cycle_id,
    rounding:input.rounding||'exact',
    applied: applied.length,
    already_applied: already_applied.length,
    blocked: blocked.length
  });
  return {
    applied,
    already_applied,
    blocked,
    notice: '绩效已作为独立输入过账。须由唯一收入项引用performance_bonus后重新试算；来源工资快照不变'
  };
}
export async function importPreview(tx, {
  userId,
  input
}) {
  const a = await access(tx, userId, true),
    header = validateHeader(input);
  groupCheck(a, header.group_id, true);
  let parsed;
  if (input.format === 'rows') {
    if (!Array.isArray(input.rows)) bad('rows须为数组');
    parsed = {
      metadata: {
        adapter: 'normalized-rows-v1'
      },
      rows: input.rows
    };
  } else {
    if (typeof input.content_base64 !== 'string' || input.content_base64.length > 12 * 1024 * 1024 || !
      /^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64)) bad('文件内容无效或超过上传上限');
    const buf = Buffer.from(input.content_base64, 'base64');
    try {
      if (input.format === 'csv') parsed = {
        metadata: {
          adapter: 'input-csv-v1',
          source_sha256: createHash('sha256').update(buf).digest('hex')
        },
        rows: parseCsv(buf.toString('utf8'))
      };
      else if (['xlsx', 'xlsm'].includes(input.format)) parsed = parseFiveTable(buf, {
        period: header.period,
        sheetName: input.sheet_name
      });
      else bad('仅接受CSV、XLSX、XLSM或规范行数据');
    } catch (e) {
      bad('导入失败：' + e.message);
    }
  }
  if (!parsed.rows.length || parsed.rows.length > 10000) bad('一次导入须为1至10000行');
  const rows = parsed.rows.map((r, i) => ({
    ...normalizeRow(r, i),
    company_id: r.company_id || null,
    person_id: r.person_id || null,
    employment_id: r.employment_id || null
  }));
  return {
    ...header,
    metadata: {
      ...parsed.metadata,
      filename: str(str(input.filename || '输入数据', 500).split(/[\\/]/).at(-1), 200)
    },
    rows,
    warnings: [{
      code: 'MASTER_STORE_OVERLAP',
      message: '总表、分店表和模板副本可能包含同一人员，只选一套本月来源。没有永久编号时不得靠姓名或表内序号自动去重；须人工匹配后核验。'
    }],
    issues: rows.flatMap(r => r.source_issues.map(x => ({
      ...x,
      source_key: r.source_key
    }))),
    summary: {
      rows: rows.length,
      unmatched: rows.filter(r => !r.company_id || !r.person_id || !r.employment_id).length,
      source_issues: rows.reduce((n, r) => n + r.source_issues.length, 0)
    }
  };
}
export async function createBatch(tx, {
  userId,
  input
}) {
  const a = await access(tx, userId, true),
    h = validateHeader(input);
  groupCheck(a, h.group_id, true);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 10000) bad('工资批次须包含1至10000行');
  const rows = input.rows.map(normalizeRow);
  if (new Set(rows.map(r => r.source_key)).size !== rows.length) bad('来源行键重复');
  const mappings = input.rows.map(r => ({
    company_id: r.company_id ? id(r.company_id) : null,
    person_id: r.person_id ? id(r.person_id) : null,
    employment_id: r.employment_id ? id(r.employment_id) : null
  }));
  for (const m of mappings) await mappingCheck(tx, a, h.group_id, m);
  h.region_code=(await companyLocale(tx,mappings.map(m=>m.company_id),{region:h.region_code,currency:h.currency})).region_code;
  const kind = input.kind === 'calculated' || rows.every(r => r.data_kind === 'inputs' || r.items.length ===
    0) ? 'calculated' : 'source_snapshot';
  if (input.metadata?.source_sha256 && !/^[a-f0-9]{64}$/.test(input.metadata.source_sha256)) bad(
    '来源摘要须为SHA256');
  const metadata = {
    filename: input.metadata?.filename ? str(input.metadata.filename, 200) : null,
    source_sha256: input.metadata?.source_sha256 ? str(input.metadata.source_sha256, 64) : hash(rows),
    adapter: input.metadata?.adapter ? str(input.metadata.adapter, 100) : 'normalized-rows-v1',
    notice: '来源金额与新月份计算分开保存；历史导入不代表规则获批'
  };
  if ((await tx.query(
      'SELECT id FROM ty_payroll_batch WHERE group_id=$1 AND period=$2 AND metadata->>\'source_sha256\'=$3',
      [h.group_id, h.period, metadata.source_sha256])).rows.length) throw bizErr('E_TY_CONFLICT',
    '同集团同工资月已有该来源，请检查已有批次，不要重复导入');
  const b = (await tx.query(
    'INSERT INTO ty_payroll_batch(group_id,period,currency,label,kind,metadata,created_by,region_code) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *',
    [h.group_id, h.period, h.currency, str(input.label || `${h.period}工资`, 200), kind, json(metadata),
      userId,h.region_code
    ])).rows[0];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i],
      m = mappings[i];
    await tx.query(
      'INSERT INTO ty_payroll_row(batch_id,group_id,source_key,source_data,company_id,person_id,employment_id,match_reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)',
      [b.id, h.group_id, r.source_key, json(r), m.company_id, m.person_id, m.employment_id, m.company_id ?
        '创建批次时明确指定' : null
      ]);
  }
  await audit(tx, userId, b.id, 'create', {
    row_count: rows.length,
    kind,
    source_sha256: metadata.source_sha256
  });
  return {
    batch: b,
    summary: {
      rows: rows.length
    }
  };
}
export async function listBatches(tx, {
  userId,
  groupId,
  ledgerId,
  companyId
}) {
  const a = await access(tx, userId);
  if (groupId) groupCheck(a, id(groupId));
  const batches = (await tx.query('SELECT * FROM ty_payroll_batch ORDER BY id DESC')).rows;
  const out = [];
  for (const b of batches) {
    if (groupId && !same(b.group_id, groupId) || !a.group(b.group_id)) continue;
    const rs = (await tx.query(
      'SELECT r.company_id,c.ledger_id FROM ty_payroll_row r LEFT JOIN ty_company c ON c.id=r.company_id WHERE r.batch_id=$1',
      [b.id])).rows;
    const shown = rs.filter(r => (!ledgerId || same(r.ledger_id, ledgerId)) && (!companyId || same(r
      .company_id, companyId)) && (r.company_id ? a.row({
      ...r,
      group_id: b.group_id
    }) : a.shared(b.group_id)));
    if (shown.length) out.push({
      ...b,
      row_count: shown.length,
      scope_complete: shown.length === rs.length,
      metadata: {
        adapter: b.metadata.adapter
      }
    });
  }
  return {
    batches: out
  };
}
export async function mapRow(tx, {
  userId,
  rowId,
  input
}) {
  const record = (await tx.query('SELECT batch_id FROM ty_payroll_row WHERE id=$1', [id(rowId)])).rows[0];
  if (!record) missing();
  const {
    a,
    b,
    rows
  } = await load(tx, userId, record.batch_id, {
    write: true,
    lock: true
  });
  checkMutable(b);
  const old = rows.find(r => same(r.id, rowId));
  if (!old) missing();
  const m = {
    company_id: id(input.company_id),
    person_id: id(input.person_id),
    employment_id: input.employment_id ? id(input.employment_id) : null
  };
  if (!m.employment_id) bad('请明确匹配本期间雇佣记录');
  await mappingCheck(tx, a, b.group_id, m);
  const reason = str(input.match_reason || '', 500);
  if (!reason) bad('请说明人员与门店匹配依据');
  const row = (await tx.query(
    'UPDATE ty_payroll_row SET company_id=$1,person_id=$2,employment_id=$3,match_reason=$4,validation=\'{}\'::jsonb,result_data=NULL WHERE id=$5 RETURNING *',
    [m.company_id, m.person_id, m.employment_id, reason, rowId])).rows[0];
  await tx.query("UPDATE ty_payroll_batch SET status='draft' WHERE id=$1", [b.id]);
  await audit(tx, userId, b.id, 'map_row', {
    row_id: row.id,
    company_id: m.company_id,
    person_id: m.person_id,
    employment_id: m.employment_id
  });
  return {
    row
  };
}

export async function setBatchLocale(tx,{userId,batchId,ledgerId,companyId,input}){
  const ctx=await load(tx,userId,batchId,{write:true,lock:true,ledgerId,companyId});checkMutable(ctx.b);if(!ctx.complete)deny();
  const selected=regionCode(input.region_code,{nullable:false});
  if(ctx.b.region_code&&ctx.b.region_code!==selected)bad('工资地区已明确，请建立新批次，不直接改写');
  const locale=await companyLocale(tx,ctx.rows.map(r=>r.company_id),{region:selected,currency:ctx.b.currency,requireRegion:true});
  const batch=(await tx.query("UPDATE ty_payroll_batch SET region_code=$1,status='draft' WHERE id=$2 RETURNING *",[locale.region_code,ctx.b.id])).rows[0];
  await tx.query("UPDATE ty_payroll_row SET result_data=NULL,validation='{}'::jsonb WHERE batch_id=$1",[batch.id]);
  await audit(tx,userId,batch.id,'set_region',{region_code:locale.region_code});return{batch};
}

function rowCheck(b, r) {
  const s = r.source_data,
    issues = [...(s.source_issues || []), ...(r.validation?.issues || []).filter(i => i.code ===
      'CALCULATION_BLOCKED')];
  if (!r.company_id || !r.person_id || !r.employment_id) issues.push({
    code: 'UNMATCHED',
    message: '须匹配公司、永久人员与期间雇佣'
  });
  if (s.source_period && s.source_period !== b.period) issues.push({
    code: 'PERIOD_MISMATCH',
    message: '来源期间与批次期间不同'
  });
  const start = b.period + '-01',
    end = new Date(Date.UTC(Number(b.period.slice(0, 4)), Number(b.period.slice(5)), 0)).toISOString().slice(
      0, 10);
  const date = v => v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null;
  if (r.employment_id && (date(r.hire_date) > end || date(r.leave_date) && date(r.leave_date) < start || r
      .employment_status === 'cancelled')) issues.push({
    code: 'EMPLOYMENT_PERIOD',
    message: '该雇佣未覆盖工资期间'
  });
  let result = r.result_data;
  if (b.kind === 'source_snapshot') {
    if (!s.items.length) issues.push({
      code: 'NO_ITEMS',
      message: '历史工资没有工资项目'
    });
    if (s.items.some(it => it.amount === null)) issues.push({
      code: 'MISSING_AMOUNT',
      message: '工资项目存在非数值或缺失缓存'
    });
    else result = {
      items: s.items,
      totals: totals(s.items),
      basis: 'source_snapshot'
    };
    if (!Object.hasOwn(s.source_totals, 'net_pay')) issues.push({
      code: 'MISSING_SOURCE_NET',
      message: '历史工资缺少可独立核对的来源实发'
    });
  } else if (!result) issues.push({
    code: 'NOT_CALCULATED',
    message: '尚未按规则完成试算'
  });
  const diffs = [];
  if (result) {
    for (const [k, v] of Object.entries(s.source_totals)) {
      const d = difference(result.totals[k], v);
      diffs.push({
        code: k,
        source_amount: v,
        calculated_amount: result.totals[k],
        difference: d
      });
      if (d !== '0.00') issues.push({
        code: 'TOTAL_DIFFERENCE',
        message: `${k}与来源保存值存在差异`
      });
    }
    if (b.kind === 'calculated')
      for (const it of s.items) {
        if (it.amount === null) continue;
        const calc = result.items.find(x => x.code === it.code);
        if (!calc) {
          issues.push({
            code: 'MISSING_CALCULATED_ITEM',
            message: `来源工资项目${it.code}未纳入计算规则`
          });
          continue;
        }
        const d = difference(calc.amount, it.amount);
        diffs.push({
          code: it.code,
          source_amount: it.amount,
          calculated_amount: calc.amount,
          difference: d
        });
        if (d !== '0.00') issues.push({
          code: 'ITEM_DIFFERENCE',
          message: `工资项目${it.code}与来源保存值不同`
        });
      }
  }
  return {
    ok: issues.length === 0,
    issues,
    differences: diffs,
    result
  };
}
async function validateLoaded(tx, {
  userId,
  b,
  rows,
  complete
}) {
  const locale=await companyLocale(tx,rows.map(r=>r.company_id),{region:b.region_code,currency:b.currency});
  if(!b.region_code&&locale.region_code&&complete){await tx.query('UPDATE ty_payroll_batch SET region_code=$1 WHERE id=$2',[locale.region_code,b.id]);b.region_code=locale.region_code;}
  let perf = new Map(),
    perfError = null;
  try {
    perf = await performanceSources(tx, {
      userId,
      batchId: b.id,
      rows
    });
  } catch (e) {
    perfError = e.message;
  }
  const duplicates = new Map();
  for (const r of rows)
    if (r.person_id && r.company_id) {
      const k = r.person_id + ':' + r.company_id;
      duplicates.set(k, (duplicates.get(k) || 0) + 1);
    } const posted = (await tx.query(
    'SELECT person_id,company_id,batch_id FROM ty_payroll_posted_person WHERE group_id=$1 AND period=$2',
    [b.group_id, b.period])).rows;
  const checks = [];
  for (const r of rows) {
    const check = rowCheck(b, r);
    if(!b.region_code){check.issues.push({code:'REGION_REQUIRED',message:'确认前须明确工资地区，不能从币种或名称推断'});check.ok=false;}
    if (posted.some(p => same(p.person_id, r.person_id) && same(p.company_id, r.company_id) && !same(p
        .batch_id, b.id))) {
      check.issues.push({
        code: 'ALREADY_CONFIRMED',
        message: '本期间该人员和公司已有已确认工资，补发更正尚需独立流程'
      });
      check.ok = false;
    }
    const ps = perf.get(String(r.id)) || [];
    if (perfError) {
      check.issues.push({
        code: 'PERFORMANCE_SOURCE_BLOCKED',
        message: perfError
      });
      check.ok = false;
    }
    if (ps.length) {
      const bonus = check.result?.items.find(i => i.code === check.result.performance_item_code && i.kind === 'earning');
      if (!bonus || bonus.amount !== performanceTotal(ps) || b.kind !== 'calculated') {
        check.issues.push({
          code: 'PERFORMANCE_NOT_INCLUDED',
          message: '已过账绩效须按确认金额纳入唯一收入项并重新试算'
        });
        check.ok = false;
      }
    }
    if (duplicates.get(r.person_id + ':' + r.company_id) > 1) {
      check.issues.push({
        code: 'DUPLICATE_PERSON_COMPANY',
        message: '同一人员在同公司重复工资行，须拆清期间或建立更正批次'
      });
      check.ok = false;
    }
    await tx.query('UPDATE ty_payroll_row SET validation=$1::jsonb WHERE id=$2', [json({
      ok: check.ok,
      issues: check.issues,
      differences: check.differences
    }), r.id]);
    checks.push({
      row_id: r.id,
      source_key: r.source_key,
      ok: check.ok,
      issues: check.issues,
      differences: check.differences
    });
  }
  const ok = checks.every(c => c.ok);
  if (complete) await tx.query('UPDATE ty_payroll_batch SET status=$1 WHERE id=$2', [ok ? 'validated' :
    'draft', b.id
  ]);
  await audit(tx, userId, b.id, 'validate', {
    row_count: checks.length,
    ok,
    scope_complete: complete
  });
  return {
    ok,
    checks,
    scope_complete: complete,
    summary: {
      rows: checks.length,
      valid: checks.filter(c => c.ok).length,
      blocked: checks.filter(c => !c.ok).length
    }
  };
}
export async function validateBatch(tx, {
  userId,
  batchId,
  companyId,ledgerId
}) {
  const ctx = await load(tx, userId, batchId, {
    write: true,
    companyId,ledgerId,
    lock: true
  });
  checkMutable(ctx.b);
  return validateLoaded(tx, {
    ...ctx,
    userId
  });
}
export async function confirmBatch(tx, {
  userId,
  batchId,
  companyId,ledgerId
}) {
  const ctx = await load(tx, userId, batchId, {
    write: true,
    companyId,ledgerId,
    lock: true
  });
  checkMutable(ctx.b);
  if (!ctx.complete) deny();
  const v = await validateLoaded(tx, {
    ...ctx,
    userId
  });
  if (!v.ok) bad('工资批次仍有匹配、来源或对账异常，不能确认');
  if (ctx.b.kind === 'calculated') {
    const rs = (await tx.query('SELECT * FROM ty_payroll_ruleset WHERE id=$1', [ctx.b.ruleset_id])).rows[0];
    if (!rs || rs.status !== 'approved') bad('试算规则尚未批准，不能确认工资');
  }
  const batch = (await tx.query(
    "UPDATE ty_payroll_batch SET status='confirmed',confirmed_by=$1,confirmed_at=now() WHERE id=$2 RETURNING *",
    [userId, ctx.b.id])).rows[0];
  await audit(tx, userId, batch.id, 'confirm', {
    rows: ctx.rows.length,
    kind: batch.kind
  });
  return {
    batch,
    ...v
  };
}
export async function report(tx, {
  userId,
  batchId,
  companyId,ledgerId
}) {
  const {
    b,
    rows,
    complete
  } = await load(tx, userId, batchId, {
    companyId,ledgerId
  });
  const perf = await performanceSources(tx, {
    userId,
    batchId: b.id,
    rows,
    fresh: false
  });
  const out = rows.map(r => {
    const check = rowCheck(b, r),
      ps = perf.get(String(r.id)) || [],
      bonus = performanceTotal(ps);
    if (ps.length && (!check.result?.items.some(it => it.code === check.result.performance_item_code && it.kind ===
        'earning' && it.amount === bonus) || b.kind !== 'calculated')) {
      check.ok = false;
      check.issues.push({
        code: 'PERFORMANCE_NOT_INCLUDED',
        message: '已过账绩效尚未纳入工资试算'
      });
    }
    return {
      ...r,
      effective_inputs: inputState(r,bonus).inputs,
      input_review:inputState(r,bonus).review,
      performance_inputs: ps.map(s => ({
        source_key: s.source_key,
        amount: money(s.amount),
        cycle_id: s.cycle_id,
        result_version: s.result_version
      })),
      validation: {
        ok: check.ok,
        issues: check.issues,
        differences: check.differences
      },
      result: check.result
    };
  });
  const allitems = out.flatMap(r => r.result?.items || []),
    summary = totals(allitems);
  await audit(tx, userId, b.id, 'read_report', {
    row_count: out.length,
    scope_complete: complete,
    company_id: companyId || null
  });
  return {
    batch: {
      ...b,
      metadata: {
        adapter: b.metadata.adapter,
        source_sha256: complete ? b.metadata.source_sha256 : undefined
      }
    },
    rows: out,
    summary: {
      ...summary,
      rows: out.length
    },
    scope_complete: complete,
    notice: b.kind === 'source_snapshot' ? '来源工资快照；仅核对保存金额，不代表系统规则重算通过' : '系统规则计算；来源快照保留，差异单独列示',
    input_schema:inputSchema()
  };
}
const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
} [c]));
export async function printHtml(tx, args) {
  const data = await report(tx, args);
  const html =
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>工资单</title><style>body{font:14px system-ui;margin:0;color:#111}.slip{padding:20mm;break-after:page;page-break-after:always}.slip:last-child{break-after:auto;page-break-after:auto}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{padding:7px;border:1px solid #aaa;text-align:left}.num{text-align:right}.note{font-size:12px;color:#555}@page{size:A4;margin:0}@media screen{.slip{max-width:180mm;margin:auto;border-bottom:1px solid #ddd}}</style>${data.rows.map(r=>{const result=r.result;return`<section class="slip"><h1>天意人力资源系统 · 工资单</h1><p>${escape(r.company_name||r.source_data.source_company_name)} · ${escape(data.batch.period)} · ${escape(data.batch.currency)}</p><p>员工：${escape(r.full_name||r.source_data.source_person_name)}　永久人员编号：${escape(r.person_number||'待匹配')}</p><p class="note">${escape(data.notice)}；${data.batch.status==='confirmed'?'已确认':'草稿 / 待确认，不作为发薪指令'}</p>${result?`<table><thead><tr><th>工资项目</th><th>性质</th><th class="num">金额</th></tr></thead><tbody>${result.items.map(it=>`<tr><td>${escape(it.name)}</td><td>${escape(({earning:'收入',deduction:'扣款',employee_contribution:'雇员供款',employer_contribution:'雇主供款',reference:'参考'})[it.kind])}</td><td class="num">${escape(it.amount)}</td></tr>`).join('')}</tbody></table><p>收入合计：${escape(result.totals.income_total)}　业务扣款：${escape(result.totals.deduction_total)}</p><p>扣款后应发：${escape(result.totals.payable_gross)}　雇员供款：${escape(result.totals.employee_contribution)}</p><h2>实发：${escape(result.totals.net_pay)} ${escape(data.batch.currency)}</h2><p>雇主供款：${escape(result.totals.employer_contribution)}（独立列示）</p>`:'<p>尚未完成试算</p>'}<p class="note">批次 ${escape(data.batch.id)} / 来源行 ${escape(r.source_key)}。${r.validation.ok?'核验通过':escape(r.validation.issues.map(i=>i.message).join('；'))}</p></section>`;}).join('')}</html>`;
  await audit(tx, args.userId, data.batch.id, 'print', {
    row_count: data.rows.length
  });
  return html;
}
export async function exportCsv(tx, args) {
  const data = await report(tx, args);
  const rows = data.rows.map(r => ({
    company: r.company_name || r.source_data.source_company_name,
    person_number: r.person_number || '',
    name: r.full_name || r.source_data.source_person_name,
    period: data.batch.period,
    currency: data.batch.currency,
    status: data.batch.status,
    basis: data.batch.kind,
    ...(r.result?.totals || {}),
    check: r.validation.ok ? '通过' : '待处理'
  }));
  await audit(tx, args.userId, data.batch.id, 'export_csv', {
    row_count: rows.length
  });
  return csv({
    columns: [{
      key: 'company',
      label: '公司'
    }, {
      key: 'person_number',
      label: '永久人员编号'
    }, {
      key: 'name',
      label: '姓名'
    }, {
      key: 'period',
      label: '期间'
    }, {
      key: 'currency',
      label: '币种'
    }, {
      key: 'income_total',
      label: '收入合计',
      numeric: true
    }, {
      key: 'deduction_total',
      label: '业务扣款',
      numeric: true
    }, {
      key: 'payable_gross',
      label: '扣款后应发',
      numeric: true
    }, {
      key: 'employee_contribution',
      label: '雇员供款',
      numeric: true
    }, {
      key: 'employer_contribution',
      label: '雇主供款',
      numeric: true
    }, {
      key: 'net_pay',
      label: '实发',
      numeric: true
    }, {
      key: 'status',
      label: '批次状态'
    }, {
      key: 'basis',
      label: '计算依据'
    }, {
      key: 'check',
      label: '核验'
    }],
    rows
  });
}

function normalizeRules(rules) {
  if (!Array.isArray(rules) || !rules.length || rules.length > 100) bad('规则须为1至100项');
  const codes = new Set();
  return rules.map(rule => {
    const code = str(rule.code, 64);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(code) || codes.has(code) || !kinds.has(rule.kind)) bad(
      '规则编码重复或性质无效');
    codes.add(code);
    let formula;
    try {
      formula = typeof rule.expression === 'string' ? parseFormula(rule.expression) : validateFormula(rule
        .formula);
    } catch (e) {
      bad(`规则${code}：${e.message}`);
    }
    return {
      code,
      name: str(rule.name || code, 200),
      kind: rule.kind,
      formula,
      jurisdiction_module:JURISDICTION_MODULES.includes(rule.jurisdiction_module||'BASE')?(rule.jurisdiction_module||'BASE'):bad('工资规则的地区模块无效'),
      ...(rule.expression ? {
        expression: rule.expression
      } : {})
    };
  });
}
export async function listRuleSets(tx, {
  userId,
  groupId
}) {
  const a = await access(tx, userId);
  groupCheck(a, id(groupId));
  return {
    rulesets: (await tx.query('SELECT * FROM ty_payroll_ruleset WHERE group_id=$1 ORDER BY id DESC', [
      groupId
    ])).rows
  };
}
export async function saveRuleSet(tx, {
  userId,
  input
}) {
  const a = await access(tx, userId, true),
    gid = id(input.group_id);
  if (!a.shared(gid, true)) deny();
  const rules = normalizeRules(input.rules),
    status = input.status === 'approved' ? 'approved' : 'draft',
    notes = str(input.policy_notes || '', 4000);
  const selectedRegion=regionCode(input.region,{nullable:false,generic:true});ruleJurisdiction(rules,selectedRegion,null);
  if (status === 'approved' && (!notes || input.approval_ack !== true)) bad('批准规则须确认适用地区、用工、MPF等标准并填写批准依据');
  const rs = (await tx.query(
    'INSERT INTO ty_payroll_ruleset(group_id,name,currency,region,status,rules,policy_notes,created_by,approved_by,approved_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) RETURNING *',
    [gid, str(input.name, 200), str(input.currency, 3).toUpperCase(), selectedRegion, status,
      json(rules), notes, userId, status === 'approved' ? userId : null, status === 'approved' ?
      new Date().toISOString() : null
    ])).rows[0];
  await audit(tx, userId, null, 'create_ruleset', {
    status,
    rule_count: rules.length
  }, rs.id);
  return {
    ruleset: rs
  };
}
export async function calculateBatch(tx, {
  userId,
  batchId,
  ledgerId,companyId,
  input
}) {
  const ctx = await load(tx, userId, batchId, {
    write: true,
    ledgerId,companyId,
    lock: true
  });
  checkMutable(ctx.b);
  if (!ctx.complete) deny();
  const rs = (await tx.query('SELECT * FROM ty_payroll_ruleset WHERE id=$1', [id(input.ruleset_id)])).rows[
    0];
  if (!rs || !same(rs.group_id, ctx.b.group_id) || rs.currency !== ctx.b.currency) bad('工资规则的集团与币种必须一致');
  const locale=await companyLocale(tx,ctx.rows.map(r=>r.company_id),{region:ctx.b.region_code||(rs.region==='CUSTOM'?null:rs.region),currency:ctx.b.currency});
  ruleJurisdiction(rs.rules,rs.region,locale.region_code);
  if(!ctx.b.region_code&&locale.region_code){await tx.query('UPDATE ty_payroll_batch SET region_code=$1 WHERE id=$2',[locale.region_code,ctx.b.id]);ctx.b.region_code=locale.region_code;}
  const rules = normalizeRules(rs.rules),
    checks = [],
    perf = await performanceSources(tx, {
      userId,
      batchId: ctx.b.id,
      rows: ctx.rows
    });
  for (const r of ctx.rows) {
    let result = null,
      issues = [];
    try {
      const ps = perf.get(String(r.id)) || [],
        bonus = performanceTotal(ps),
        state=inputState(r,bonus),inputs=state.inputs;
      for (const key of ['salary_rate', 'period_days', 'employed_days', 'worked_hours', 'overtime_hours'])
        if (inputs[key] !== undefined && Number(inputs[key]) < 0) throw new Error(key + '不能为负数');
      if (inputs.period_days !== undefined && (Number(inputs.period_days) < 1 || Number(inputs
          .period_days) > 31)) throw new Error('当月天数应为1至31');
      if (inputs.employed_days !== undefined && inputs.period_days !== undefined && Number(inputs
          .employed_days) > Number(inputs.period_days)) throw new Error('在职天数不能超过当月天数');
      const incomeCodes = performanceIncomeCodes(rules);
      if (ps.length && incomeCodes.length !== 1) throw new Error('已确认绩效须由唯一收入项引用，不能漏计或重复计入');
      const used=new Set();
      const calculated = calculate(rules, inputs,{onRead:key=>used.add(key)});
      const pending=[...used].filter(key=>(state.review[key]?.status==='unverified'||Object.hasOwn(r.input_overrides||{},key))&&state.review[key]?.status!=='verified');
      if(pending.length)throw new Error('来源或修改输入待核验：'+pending.join('、'));
      if (ps.length && calculated.items.find(i => i.code === incomeCodes[0])?.amount !== bonus)
        throw new Error('绩效收入项金额须与来源确认金额一致');
      result = {
        ...calculated,
        used_inputs:[...used],
        input_snapshot:Object.fromEntries([...used].map(key=>[key,inputs[key]])),
        performance_item_code: incomeCodes[0] || null,
        performance_sources: ps.map(s => ({
          source_key: s.source_key,
          amount: money(s.amount),
          cycle_id: s.cycle_id,
          result_version: s.result_version
        })),
        basis: 'rule_calculation',
        ruleset_id: rs.id,
        ruleset_hash: hash(rs.rules),
        calculated_at: new Date().toISOString()
      };
    } catch (e) {
      issues = [{
        code: 'CALCULATION_BLOCKED',
        message: e.message
      }];
    }
    await tx.query('UPDATE ty_payroll_row SET result_data=$1::jsonb,validation=$2::jsonb WHERE id=$3', [
      result ? json(result) : null, json({
        ok: false,
        issues
      }), r.id
    ]);
    checks.push({
      row_id: r.id,
      ok: !!result,
      issues
    });
  }
  await tx.query("UPDATE ty_payroll_batch SET kind='calculated',status='draft',ruleset_id=$1 WHERE id=$2", [
    rs.id, ctx.b.id
  ]);
  await audit(tx, userId, ctx.b.id, 'calculate', {
    ruleset_id: rs.id,
    ruleset_status: rs.status,
    rows: checks.length,
    blocked: checks.filter(r => !r.ok).length
  });
  return {
    ok: checks.every(c => c.ok),
    checks,
    ruleset: rs,
    notice: rs.status === 'approved' ? '试算完成后仍须逐项核对并确认' : '使用规则草稿试算，禁止确认发薪'
  };
}
export function ruleCatalog() {
  const rules = [{
    code: 'base_pay',
    name: '基本工资',
    kind: 'earning',
    expression: 'ROUND(IF(employment_type="FT",salary_rate/period_days*employed_days,IF(employment_type="PT",salary_rate*worked_hours,unsupported_employment_type)),2)'
  }, {
    code: 'overtime',
    name: '加班工资',
    kind: 'earning',
    expression: 'ROUND(IF(employment_type="PT",0,salary_rate/overtime_divisor*overtime_hours),2)'
  }];
  for (const item of FIVE_TABLE_ITEMS.filter(x => !['base_pay', 'overtime', 'mpf_employer', 'mpf_employee']
      .includes(x.code))) rules.push({
    ...item,
    expression: 'input_' + item.code
  });
  rules.push({
    code: 'mpf_employee',
    name: '雇员MPF',
    kind: 'employee_contribution',
    jurisdiction_module:'HK_MPF',
    expression: 'IF(employee_mpf_eligible,IF(mpf_relevant_income<employee_mpf_threshold,0,ROUND(MIN(mpf_relevant_income*mpf_rate,mpf_cap),2)),0)'
  }, {
    code: 'mpf_employer',
    name: '雇主MPF',
    kind: 'employer_contribution',
    jurisdiction_module:'HK_MPF',
    expression: 'IF(employer_mpf_eligible,ROUND(MIN(mpf_relevant_income*mpf_rate,mpf_cap)+employer_mpf_arrears,2),0)'
  });
  rules.push({
    code: 'performance_bonus',
    name: '已确认绩效奖金',
    kind: 'earning',
    expression: 'performance_bonus'
  });
  return {
    supported_operators: SUPPORTED_OPERATORS,
    text_functions: ['IF', 'MIN', 'MAX', 'ROUND', 'AND', 'OR'],
    text_operators: ['+', '-', '*', '/', '=', '!=', '<', '<=', '>', '>='],
    example: 'ROUND(IF(employment_type="FT",salary_rate/period_days*employed_days,salary_rate*worked_hours),2)',
    options:[
      {key:'fixed_monthly',name:'固定月薪',region:'CUSTOM',currency:'HKD',status:'draft',policy_notes:'测试帐套可自行启用；按明确月薪，加独立确认的绩效。法定扣缴另选模块。',rules:[{code:'base_pay',name:'固定月工资',kind:'earning',expression:'base_salary'},{code:'performance',name:'绩效奖金',kind:'earning',expression:'performance_bonus'}]},
      {key:'calendar_prorata',name:'月薪按日历天数折算',region:'CUSTOM',currency:'HKD',status:'draft',policy_notes:'自选计算方案：月工资/当月日历天数×在职天数。客户选择适用口径，不代表法定默认。',rules:[{code:'base_pay',name:'按日历天数基本工资',kind:'earning',expression:'ROUND(salary_rate/period_days*employed_days,2)'},{code:'performance',name:'绩效奖金',kind:'earning',expression:'performance_bonus'}]},
      {key:'workday_prorata',name:'月薪按约定计薪工作日折算',region:'CUSTOM',currency:'HKD',status:'draft',policy_notes:'自选计算方案：月工资/约定计薪天数×应计薪工作日；分母和计薪天数须明确输入。',rules:[{code:'base_pay',name:'按计薪工作日基本工资',kind:'earning',expression:'ROUND(salary_rate/standard_workdays*paid_workdays,2)'},{code:'performance',name:'绩效奖金',kind:'earning',expression:'performance_bonus'}]},
      {key:'hourly',name:'按核验工时计薪',region:'CUSTOM',currency:'HKD',status:'draft',policy_notes:'自选时薪方案：时薪×已核验工时。加班和法定扣缴需另行配置。',rules:[{code:'base_pay',name:'时薪基本工资',kind:'earning',expression:'ROUND(salary_rate*worked_hours,2)'},{code:'performance',name:'绩效奖金',kind:'earning',expression:'performance_bonus'}]},
    ],
    modules:[{key:'mpf_explicit',name:'MPF显式参数模块',region:'HK',rules:rules.filter(r=>['mpf_employee','mpf_employer'].includes(r.code)),notice:'仅适用资格和收入周期已核验的香港参数；不把月薪阈值直接用于其他支付周期。无参数时阻断。'}],
    draft: {
      name: '香港五表源公式参考草稿',
      region: 'HK',
      currency: 'HKD',
      status: 'draft',
      policy_notes: '仅参考来源五表：FT月薪按当月天数及在职天数，PT时薪按工时；OT除数、资格、MPF收入边界/比率/上下限/补缴须逐项确认，LTPT尚缺标准。金额不含中国个税自动推算。',
      rules
    },
    pending: ['FT/PT之外用工规则', '加班适用人群和除数', '津贴及假勤扣款标准', 'MPF资格、适用收入、比率、上下限与补缴', '币种、法主体与地区标准']
  };
}
export function inputTemplate() {
  const fields = [
    ['source_key', '来源唯一行键'],
    ['source_person_name', '来源姓名（不得用同名自动合并）'],
    ['source_person_number', '来源编号'],
    ['source_company_name', '来源门店名称'],
    ['company_id', '已核对系统公司ID'],
    ['person_id', '已核对永久人员ID'],
    ['employment_id', '本工资期间雇佣ID'],
    ['input.employment_type', 'FT月薪/PT时薪；LTPT需另订规则'],
    ['input.salary_rate', 'FT月薪或PT时薪'],
    ['input.period_days', '当月日历天数'],
    ['input.employed_days', '当月在职天数'],
    ['input.worked_hours', '已确认工时'],
    ['input.overtime_hours', '已确认加班工时'],
    ['input.overtime_divisor', '已批准加班除数'], ...FIVE_TABLE_ITEMS.filter(x => !['base_pay', 'overtime',
      'mpf_employee', 'mpf_employer'
    ].includes(x.code)).map(x => ['input.input_' + x.code, x.name + '（无金额须明确填0）']), [
      'input.employee_mpf_eligible', '已核对雇员MPF资格true/false'
    ],
    ['input.employer_mpf_eligible', '已核对雇主MPF资格true/false'],
    ['input.mpf_relevant_income', '已核对MPF有关入息'],
    ['input.employee_mpf_threshold', '已批准雇员供款入息下限'],
    ['input.mpf_rate', '已批准供款率（小数）'],
    ['input.mpf_cap', '已批准供款上限'],
    ['input.employer_mpf_arrears', '已核对雇主补缴，无则明确填0']
  ];
  return {
    fields: fields.map(([key, description]) => ({
      key,
      description
    })),
    csv: csv({
      columns: fields.map(([key]) => ({
        key,
        label: key
      })),
      rows: []
    }),
    instructions: '下载后每人每公司每期间一行。必须明确匹配人员与雇佣；空值保留缺失状态，不默认为零。每个金额使用工资期间同一币种。FT/PT/MPF规则只是源参考草稿，需有权人员批准。'
  };
}

export function inputSchema(){
  const extra=[
    {key:'base_salary',label:'固定月基本工资',type:'number',description:'可选算法使用的已确认月基本工资'},
    {key:'standard_workdays',label:'约定计薪天数',type:'number',description:'自选固定天数方案的分母，须明确配置'},
    {key:'paid_workdays',label:'应计薪工作天数',type:'number',description:'按工作日方案使用的已核验计薪天数'},
    {key:'performance_bonus',label:'已确认绩效奖金',type:'number',readonly:true,description:'仅从已确认绩效结果过账，不能手工冒充'},
  ];
  const fields=inputTemplate().fields.filter(f=>f.key.startsWith('input.')).map(f=>{
    const key=f.key.slice(6),boolean=['employee_mpf_eligible','employer_mpf_eligible'].includes(key);
    return{key,label:f.description.split('（')[0],type:boolean?'boolean':key==='employment_type'?'text':'number',description:f.description,
      ...(key==='employment_type'?{options:['FT','PT','LTPT']}:{})};
  });
  return{fields:[...fields,...extra],review_statuses:['unverified','verified'],notice:'来源缓存值为待核验建议输入；计算只使用当前公式实际读取且已经核验的字段。修改不覆盖源文件，已确认批次不可编辑。'};
}

// Entirely artificial demo input; never derived from a customer workbook.
export function syntheticInputRows({count=177,period='2026-11'}={}){
  if(!Number.isInteger(count)||count<1||count>10000)bad('合成样例行数须为1至10000');
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))bad('合成期间须为YYYY-MM');
  const days=String(new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5)),0)).getUTCDate());
  return Array.from({length:count},(_,i)=>({
    source_key:`SYNTHETIC:${period}:${String(i+1).padStart(6,'0')}`,
    source_person_name:`示范员工${String(i+1).padStart(4,'0')}`,
    source_person_number:`DEMO${String(i+1).padStart(6,'0')}`,
    source_company_name:`示范门店${String(i%3+1).padStart(3,'0')}`,
    data_kind:'inputs',inputs:{employment_type:i%4===0?'PT':'FT',base_salary:String(12000+(i%12)*250),salary_rate:i%4===0?'75':String(12000+(i%12)*250),period_days:days,employed_days:days,standard_workdays:'22',paid_workdays:'22',worked_hours:String(100+(i%20)*2),overtime_hours:'0',overtime_divisor:'216'},items:[],source_totals:{},source_issues:[],
    provenance:{type:'synthetic',source_key:'factory-v1'},
  }));
}
