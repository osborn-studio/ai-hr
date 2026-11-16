import {
  inflateRawSync
} from 'node:zlib';
import {
  createHash
} from 'node:crypto';
import {
  money
} from './customer-payroll-engine.mjs';
const fail = message => {
  throw new Error(message);
};
const xml = s => String(s || '').replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const attr = (s, k) => xml(new RegExp('(?:^|\\s)' + k + '="([^"]*)"').exec(s)?.[1] || '');
export function workbookCells(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.length > 9 * 1024 * 1024) fail('工作簿须小于9MB');
  let e = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 65558); p--)
    if (buf.readUInt32LE(p) === 0x06054b50) {
      e = p;
      break;
    }
  if (e < 0) fail('工作簿ZIP目录无效');
  if (buf.readUInt16LE(e + 4) || buf.readUInt16LE(e + 6)) fail('不支持分卷文件');
  const count = buf.readUInt16LE(e + 10),
    entries = new Map();
  if (count > 3000) fail('工作簿文件数量超限');
  let p = buf.readUInt32LE(e + 16),
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('工作簿目录损坏');
    const flags = buf.readUInt16LE(p + 8),
      method = buf.readUInt16LE(p + 10),
      compressed = buf.readUInt32LE(p + 20),
      size = buf.readUInt32LE(p + 24),
      nl = buf.readUInt16LE(p + 28),
      el = buf.readUInt16LE(p + 30),
      cl = buf.readUInt16LE(p + 32),
      offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nl + el + cl > buf.length) fail('工作簿目录越界');
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    if (flags & 1) fail('请先解密工作簿');
    if (name.includes('..') || entries.has(name)) fail('工作簿路径无效');
    total += size;
    if (total > 120 * 1024 * 1024 || size > 40 * 1024 * 1024) fail('解压后工作簿过大');
    entries.set(name, {
      method,
      compressed,
      size,
      offset
    });
    p += 46 + nl + el + cl;
  }

  function read(name) {
    const ent = entries.get(name);
    if (!ent) return '';
    const o = ent.offset;
    if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) fail('工作簿内容头损坏');
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    if (start + ent.compressed > buf.length) fail('工作簿内容越界');
    const raw = buf.subarray(start, start + ent.compressed);
    const out = ent.method === 0 ? raw : ent.method === 8 ? inflateRawSync(raw, {
      maxOutputLength: 40 * 1024 * 1024
    }) : fail('工作簿压缩方式不支持');
    if (out.length !== ent.size) fail('工作簿解压尺寸不符');
    const s = out.toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(s)) fail('不支持XML实体声明');
    return s;
  }
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => [...m[1]
    .matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)
  ].map(t => xml(t[1])).join(''));
  const rels = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b([^>]*?)\/?\s*>/g)]
    .map(m => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const sheets = [];
  for (const m of read('xl/workbook.xml').matchAll(/<sheet\b([^>]*?)\/?\s*>/g)) {
    const name = attr(m[1], 'name'),
      rid = attr(m[1], 'r:id'),
      target = rels.get(rid);
    if (!target || target.includes('..')) fail('工作表关系无效');
    const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const cells = new Map();
    let seen = 0;
    for (const c of read(path).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      if (++seen > 600000) fail('工作表单元格数量超限');
      const ref = attr(c[1], 'r'),
        body = c[2] || '',
        t = attr(c[1], 't'),
        v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1],
        formula = /<f\b[^>]*>([\s\S]*?)<\/f>|<f\b[^>]*\/>/.test(body);
      let value = v === undefined ? '' : xml(v);
      if (t === 's') value = shared[Number(value)] ?? '';
      else if (t === 'inlineStr') value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(q => xml(q[1]))
        .join('');
      if (value !== '' || formula) cells.set(ref, {
        value,
        formula,
        error: t === 'e'
      });
    }
    sheets.push({
      name,
      cells
    });
  }
  if (!sheets.length) fail('未找到工作表');
  return sheets;
}
const itemCols = [
  ['AI', 'base_pay', '基本工资', 'earning'],
  ['AJ', 'overtime', '加班工资', 'earning'],
  ['AK', 'attendance', '全勤奖金', 'earning'],
  ['AL', 'housing', '住房津贴', 'earning'],
  ['AM', 'transport', '交通津贴', 'earning'],
  ['AN', 'position', '岗位津贴', 'earning'],
  ['AO', 'multi_store', '多店津贴', 'earning'],
  ['AP', 'probation', '试用期奖金', 'earning'],
  ['AQ', 'newcomer', '新人奖金', 'earning'],
  ['AR', 'seasonal', '季节奖金', 'earning'],
  ['AS', 'family_bonus', '婚育奖金', 'earning'],
  ['AT', 'special', '特别奖金', 'earning'],
  ['AU', 'statutory_holiday', '法定假日补薪', 'earning'],
  ['AV', 'annual_leave', '年假折现', 'earning'],
  ['AW', 'adjustment', '工资调整', 'earning'],
  ['AX', 'sick_deduction', '病假扣款', 'deduction'],
  ['AY', 'injury_deduction', '工伤扣款', 'deduction'],
  ['AZ', 'maternity_deduction', '产假扣款', 'deduction'],
  ['BA', 'paternity_deduction', '侍产假扣款', 'deduction'],
  ['BB', 'unpaid_deduction', '无薪扣款', 'deduction'],
  ['BC', 'adjustment_deduction', '其他扣款', 'deduction'],
  ['BD', 'notice_pay', '代通知金', 'earning'],
  ['BE', 'severance', '遣散费', 'earning'],
  ['BF', 'long_service', '长期服务金', 'earning'],
  ['BG', 'settlement', '离职结算', 'earning'],
  ['BJ', 'mpf_employer', '雇主MPF', 'employer_contribution'],
  ['BK', 'mpf_employee', '雇员MPF', 'employee_contribution']
];
const inputCols = {
  J: 'worked_hours',
  K: 'overtime_hours',
  L: 'employment_type',
  M: 'salary_rate',
  N: 'employed_days',
  O: 'worked_days',
  P: 'age',
  Q: 'daily_rate',
  R: 'paid_rest_days',
  S: 'statutory_holiday_days',
  T: 'annual_leave_days',
  U: 'birthday_leave_days',
  V: 'bereavement_days',
  W: 'marriage_days',
  X: 'child_leave_days',
  Y: 'exam_leave_days',
  Z: 'paid_sick_days',
  AA: 'injury_days',
  AB: 'maternity_days',
  AC: 'paternity_days',
  AD: 'unpaid_holiday_days',
  AE: 'unpaid_leave_days',
  AF: 'annual_leave_balance',
  AG: 'full_pay_days',
  AH: 'eighty_percent_days'
};

function excelPeriod(value) {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Number(value) * 86400000);
  return Number.isNaN(+d) ? null : d.toISOString().slice(0, 7);
}
export function parseFiveTable(buf, {
  period,
  sheetName
} = {}) {
  const sheets = workbookCells(buf),
    candidates = sheets.filter(s => /^\d{1,2}月薪酬$/.test(s.name));
  const sheet = sheetName ? sheets.find(s => s.name === sheetName) : candidates.length === 1 ? candidates[0] :
    null;
  if (!sheet) fail('请选择唯一的“月薪酬”工作表');
  const get = (col, row) => sheet.cells.get(col + row);
  if (!/姓名/.test(get('B', 2)?.value || '') || !/MPF|強積金|强积金/i.test([get('BJ', 2)?.value, get('BK', 2)?.value]
      .join(' '))) fail('五表工资单表头与已审核模板不符');
  const rows = [];
  const nums = new Set([...sheet.cells.keys()].map(s => Number(s.replace(/^[A-Z]+/, ''))).filter(n => n >=
  3));
  for (const n of [...nums].sort((a, b) => a - b)) {
    const name = get('B', n)?.value?.trim();
    if (!name || /^(合计|合計|总计|總計|Total)$/i.test(name)) continue;
    const issues = [];
    const val = (col, required = false) => {
      const c = get(col, n);
      if (c?.error) {
        issues.push({
          code: 'SOURCE_ERROR',
          message: `${sheet.name}!${col}${n}包含错误值`
        });
        return null;
      }
      if (!c || c.value === '') {
        if (required || c?.formula) issues.push({
          code: 'SOURCE_MISSING_CACHE',
          message: `${sheet.name}!${col}${n}无已保存的数值`
        });
        return c?.formula || required ? null : '0.00';
      }
      try {
        return money(c.value);
      } catch {
        issues.push({
          code: 'SOURCE_NON_NUMERIC',
          message: `${sheet.name}!${col}${n}为待计算或非数值`
        });
        return null;
      }
    };
    const inputs = {}, input_review = {};
    for (const [col, key] of Object.entries(inputCols)) {
      const value = get(col, n)?.value;
      if (value !== undefined && value !== '') {
        inputs[key] = value;
        input_review[key]={status:'unverified',origin:'source_input',source_cell:`${sheet.name}!${col}${n}`};
      }
    }
    if (period) {
      const days = new Date(Number(period.slice(0, 4)), Number(period.slice(5)), 0).getDate();
      inputs.period_days = String(days);
    }
    const items = itemCols.map(([col, code, label, kind]) => ({
      code,
      name: get(col, 2)?.value || label,
      kind,
      amount: val(col),
      source_cell: `${sheet.name}!${col}${n}`
    }));
    for(const item of items.filter(it=>!['base_pay','overtime','mpf_employee','mpf_employer'].includes(it.code))){
      if(item.amount===null)continue;
      inputs['input_'+item.code]=item.amount;
      input_review['input_'+item.code]={status:'unverified',origin:'source_item',source_cell:item.source_cell};
    }
    const relevantIncome=val('BI');
    if(relevantIncome!==null){inputs.mpf_relevant_income=relevantIncome;input_review.mpf_relevant_income={status:'unverified',origin:'source_total',source_cell:`${sheet.name}!BI${n}`};}
    const sourcePeriod = excelPeriod(get('E', n)?.value || '');
    if (sourcePeriod && period && sourcePeriod !== period) issues.push({
      code: 'PERIOD_MISMATCH',
      message: `来源期间${sourcePeriod}与批次期间不一致`
    });
    rows.push({
      source_key: `${sheet.name}!${n}`,
      source_person_name: name,
      source_person_number: null,
      source_company_name: get('H', n)?.value || '',
      inputs,
      input_review,
      items,
      source_totals: {
        net_pay: val('BM', true),
        employee_contribution: val('BK', true),
        employer_contribution: val('BJ', true)
      },
      reference_totals: {
        source_total_income: val('BH'),
        source_relevant_income: val('BI'),
        source_total_deduction: val('BL')
      },
      source_period: sourcePeriod,
      source_issues: issues
    });
  }
  if (!rows.length) fail('工资表没有有效人员行');
  return {
    metadata: {
      adapter: 'hk-five-table-v1',
      sheet: sheet.name,
      sheets: sheets.map(s => s.name),
      source_sha256: createHash('sha256').update(buf).digest('hex'),
      policy_status: 'source_snapshot_not_approved_rules',
      omitted_fields: ['bank_account', 'document_number', 'raw_formulas']
    },
    rows
  };
}
export function parseCsv(text) {
  if (text.length > 9 * 1024 * 1024) fail('CSV过大');
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') {
      if (cell) fail('CSV引号位置不正确');
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
    if (rows.length > 10000) fail('CSV超过10000行');
  }
  if (quoted) fail('CSV引号未闭合');
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) fail('CSV为空');
  const headers = rows.shift().map(x => x.replace(/^\uFEFF/, '').trim());
  if (new Set(headers).size !== headers.length) fail('CSV列名重复');
  return rows.map((r, i) => {
    if (r.length !== headers.length) fail(`CSV第${i+2}行列数不一致`);
    const data = Object.fromEntries(headers.map((h, j) => [h, r[j]]));
    const inputs = {};
    for (const [k, v] of Object.entries(data))
      if (k.startsWith('input.') && v !== '') inputs[k.slice(6)] = v === 'true' ? true : v === 'false' ?
        false : v;
    return {
      source_key: data.source_key || `CSV!${i+2}`,
      source_person_name: data.source_person_name || '',
      source_person_number: data.source_person_number || null,
      source_company_name: data.source_company_name || '',
      person_id: data.person_id || null,
      company_id: data.company_id || null,
      employment_id: data.employment_id || null,
      inputs,
      items: [],
      source_totals: {},
      source_issues: [],
      data_kind: 'inputs'
    };
  });
}
export const FIVE_TABLE_ITEMS = itemCols.map(([, code, name, kind]) => ({
  code,
  name,
  kind
}));
