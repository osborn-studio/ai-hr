// ============================================================================
// app/xlsx-write.mjs · 写 .xlsx（零依赖）
// ----------------------------------------------------------------------------
// 与 xlsx.mjs（只读）成对：那个文件回答"Excel 里写了什么"，这个回答
// "怎么让财务拿到一个双击就能开的 Excel"。客户最常问的两句之一就是
// "能不能导出 Excel" —— 而 CSV 在中文 Windows 上要过一道"编码/分隔符"的劫，
// 财务的实际反馈是"打开是乱的 / 全挤在一列"。
//
// ★ 为什么字符串一律用 inlineStr，不用 sharedStrings
//   sharedStrings 是**性能优化**：同一个字符串只存一次，单元格里存索引。
//   代价是一张索引表 + 两处（sheet 与 sst）必须同时正确，且删行后还要维护
//   count/uniqueCount —— 而我们的导出是"一次性生成、打开、扔掉"，同一份清单里
//   重复最多的值是门店名（几十次）。省下那几百字节，换来一个"索引错位一列全错"
//   的新失败模式，不划算。inlineStr 让**每个单元格自带文本**：
//   生成器只写一遍，读的人（含本仓的 xlsx.mjs）不需要第二张表。
//
// ★ 为什么数字写 <v> 而不是文本
//   写成文本的数字在 Excel 里左对齐、求和为 0、排序按字符串走（"10000" < "9"）。
//   财务拿到这样的表会先手工转一遍数字 —— 那就等于这个导出没做。
//   金额保留 2 位（写入时就按 2 位四舍五入，并挂 #,##0.00 格式），
//   因为库里是 numeric，浮点尾巴（6500.000000001）在 Excel 里会显示成
//   一列对齐不齐的怪数。
//
// ★ 日期写成文本 YYYY-MM-DD，**不写 Excel 的序列号**
//   Excel 的日期是"从 1899-12-30 起的天数"，且受 1900 闰年 bug 与本地时区影响。
//   写序列号意味着生成器要正确实现那套换算，读的人还要知道 numFmt 是不是日期。
//   而工资条上的日期（期间、发放日）本来就是给人看的标签，不是用来算差的 ——
//   文本形态在任何区域设置下都不会变成 1900-01-04 那种鬼日期。
//
// ★ 单元格里以 = + - @ 开头的文本**不需要前缀单引号**
//   CSV 需要（csv.mjs 的 FORMULA_HEAD 那段），因为 CSV 没有类型，Excel 只能猜。
//   xlsx 里 t="inlineStr" 已经把类型说死了是字符串，Excel 不会执行它。
//   这里不照抄 CSV 的防护 —— 抄了反而会在单元格里多出一个撇号。
// ============================================================================
import { makeZip } from './zip.mjs';
import { bizErr } from './errors.mjs';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// XML 1.0 不允许的控制字符（0x00-0x08 / 0x0B / 0x0C / 0x0E-0x1F）。
// ★ 不处理它们的后果不是"报错"，是 Excel 打开时弹"文件已损坏，是否修复" ——
//   而修复提示会让人以为整个文件不可信。备注里粘进一个 \u0007 就能触发。
const XML_UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * XML 文本/属性转义。
 * ★ `&` 必须第一个换，否则 `&amp;` 会被二次转义成 `&amp;amp;`。
 */
export function xmlText(v) {
  return String(v ?? '')
    .replace(XML_UNSAFE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 工作表名：Excel 禁止 `[]:*?/\`，且上限 31 字符、首尾不许是撇号。
 * ★ 不做这一步的表现是"文件打不开"，而错误只说"发现不可读取的内容" ——
 *   从那段话反推不到"工作表名里有个斜杠"。
 */
export function sheetName(name, fallback = 'Sheet1') {
  const s = String(name ?? '')
    .replace(/[\[\]:*?\/\\]/g, '')   // Excel 明令禁止的 7 个字符
    .replace(/^'+|'+$/g, '')          // 首尾撇号：Excel 不许（会与"引用表名"的语法混淆）
    .trim()
    .slice(0, 31);
  return s || fallback;
}

/** 0 → A, 25 → Z, 26 → AA */
export function colLetter(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 日期值 → YYYY-MM-DD（文本）。认 Date、认 ISO 串，其它原样转字符串 */
function dateText(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(v ?? '');
}

// ---------------------------------------------------------------------------
// 最小 OOXML 部件
// ---------------------------------------------------------------------------
// styles.xml 只留三样东西，各有各的理由（删掉任何一样 Excel 都会"修复"文件）：
//   ① fills 必须**至少两格**且第二格是 gray125 —— 这是写过 xlsx 的人都知道的
//      一条"格式规定"（没有任何文档解释它，但不满足时 Excel 会抱怨）。
//   ② cellXfs[0] 是默认格式，所有没挂样式的单元格都指它。
//   ③ 自定义 numFmtId 从 164 起：0-163 是内置号，占用会撞掉内置的日期/百分比格式。
function stylesXml() {
  return `${XML_DECL}
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
  <fonts count="2">
    <font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F3F5"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="3">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"
        applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

const STYLE_DEFAULT = 0;
const STYLE_HEADER = 1;
const STYLE_MONEY = 2;

function contentTypesXml() {
  return `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

function rootRelsXml() {
  return `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function workbookXml(sheet) {
  return `${XML_DECL}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="${xmlText(sheet)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

function workbookRelsXml() {
  return `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

const isBlank = (v) => v === null || v === undefined || v === '';

/**
 * 一个单元格。
 * ★ 数值列遇到空值/null 时**写空单元格，不写 0** —— 与 csv.mjs 的 numCell 同一条：
 *   写 0 会让"没有权限 / 没有数据"变成"金额是 0 元"，而收到文件的人无从分辨。
 */
function cellXml(ref, col, v) {
  if (isBlank(v)) return `<c r="${ref}"/>`;
  if (col.numeric) {
    const n = Number(v);
    if (!Number.isFinite(n)) return `<c r="${ref}"/>`;
    const dec = Number.isInteger(col.decimals) ? col.decimals : null;
    const val = dec === null ? n : Number(n.toFixed(dec));
    const s = dec === 2 ? STYLE_MONEY : STYLE_DEFAULT;
    return `<c r="${ref}" s="${s}"><v>${val}</v></c>`;
  }
  if (col.date) {
    return `<c r="${ref}" t="inlineStr"><is><t>${xmlText(dateText(v))}</t></is></c>`;
  }
  const text = String(v);
  // 前后有空格时要声明 preserve，否则 Excel 会吃掉 —— 而工号、备注的空格
  // 有时是数据的一部分（" XX1127" 是另一个工号）。
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"><is><t${preserve}>${xmlText(text)}</t></is></c>`;
}

function sheetXml(cols, rows) {
  const width = cols.length;
  const last = `${colLetter(Math.max(width - 1, 0))}${rows.length + 1}`;

  const head = `<row r="1">${cols.map((c, i) => {
    const ref = `${colLetter(i)}1`;
    return `<c r="${ref}" s="${STYLE_HEADER}" t="inlineStr"><is><t>${xmlText(c.label ?? c.key)}</t></is></c>`;
  }).join('')}</row>`;

  const body = rows.map((r, ri) => {
    const n = ri + 2;
    const cells = cols.map((c, ci) => cellXml(`${colLetter(ci)}${n}`, c, r[c.key])).join('');
    return `<row r="${n}">${cells}</row>`;
  }).join('');

  // 列宽按表头长度估：中文按 2 个字宽算，最短 10、最长 40。
  // 不做这一步的话，打开是"####"或全挤在一起，用户第一反应是"导错了"。
  const colsXml = cols.map((c, i) => {
    const label = String(c.label ?? c.key);
    const units = [...label].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
    const w = Math.min(40, Math.max(10, (c.width || units) + 2));
    return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
  }).join('');

  return `${XML_DECL}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${last}"/>
  <sheetViews><sheetView workbookViewId="0">
    <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
  </sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <cols>${colsXml}</cols>
  <sheetData>${head}${body}</sheetData>
</worksheet>`;
}

/**
 * 二维表 → .xlsx 字节。
 *
 * @param {object} spec
 * @param {string} [spec.sheetName] 工作表名（会按 Excel 的规则清洗并限长 31）
 * @param {Array<{key:string,label:string,numeric?:boolean,decimals?:number,date?:boolean}>} spec.columns
 * @param {Array<object>} spec.rows  每行一个对象，按 col.key 取值
 * @param {Date} [spec.now]          只用于 zip 里的时间戳（测试可固定）
 * @returns {Buffer}
 */
export function writeXlsx({ sheetName: rawSheet = 'Sheet1', columns, rows = [], now = null } = {}) {
  const cols = Array.isArray(columns) ? columns.filter((c) => c && c.key !== undefined) : [];
  if (cols.length === 0) {
    // 没有列就没有表头，也就没有"表" —— 产出空工作簿等于让人打开一个白板。
    throw bizErr('E_ARG_INVALID', 'xlsx 至少要有一列（columns 不能为空）');
  }
  const body = Array.isArray(rows) ? rows : [];
  const sheet = sheetName(rawSheet);

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypesXml() },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'xl/workbook.xml', data: workbookXml(sheet) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml() },
    { name: 'xl/styles.xml', data: stylesXml() },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(cols, body) },
  ], now ? { now } : {});
}

export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export const XLSX_HEADERS = {
  'content-type': XLSX_CONTENT_TYPE,
  // nosniff 对下载同样重要：不要让浏览器去猜这个 zip 是不是能直接渲染
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
