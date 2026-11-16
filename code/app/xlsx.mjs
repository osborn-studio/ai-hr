// ============================================================================
// app/xlsx.mjs · 读 .xlsx（零依赖）
// ----------------------------------------------------------------------------
// 为什么不装 SheetJS：这个仓库的依赖只有 PGlite 与 pg，多一个"解析 Excel"的
// 大包意味着多一条供应链、多一份 CVE 订阅、多一次"它升级了我们不敢升"。
// 而我们需要的只是**读一个 sheet 的单元格文本** —— 这件事 xlsx 的格式本身
// 已经说清楚了：
//
//   .xlsx 就是一个 zip，里面 xl/worksheets/sheet1.xml 是单元格，
//   xl/sharedStrings.xml 是共享字符串，<c r="B3" t="s"><v>12</v></c> 表示
//   "B3 用第 12 个共享字符串"，t="inlineStr" 则文本直接在 <is><t> 里。
//
// 所以这里做两件事：解 zip（zlib.inflateRawSync）+ 认那几个标签。
// ★ 只支持**读**，不支持公式重算：单元格里如果是公式，取的是 Excel 上次
//   保存时算好的缓存值（<v>），而不是公式本身 —— 这正是导入要的（要数不要算式）。
//   公式在系统里另有一套（salary_item.formula），不从 Excel 里偷。
// ============================================================================
import { inflateRawSync } from 'node:zlib';

/** 读 zip 中央目录，返回 name → { method, size, offset } */
function readZipEntries(buf) {
  // EOCD 在文件末尾，签名 0x06054b50，后面可能有最多 64KB 注释
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('E_XLSX_ZIP: 不是有效的 zip（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, { method, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf, ent) {
  if (!ent) return null;
  const sig = buf.readUInt32LE(ent.offset);
  if (sig !== 0x04034b50) throw new Error('E_XLSX_ZIP: 本地文件头损坏');
  const nameLen = buf.readUInt16LE(ent.offset + 26);
  const extraLen = buf.readUInt16LE(ent.offset + 28);
  const start = ent.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + ent.csize);
  if (ent.method === 0) return raw.toString('utf8');
  if (ent.method === 8) return inflateRawSync(raw).toString('utf8');
  throw new Error(`E_XLSX_ZIP: 不支持的压缩方式 ${ent.method}`);
}

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

/** 共享字符串表：<si> 里可能有多段 <t>（富文本），拼起来 */
function readSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.match(/<si\b[\s\S]*?<\/si>/g) || []) {
    const parts = [...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]);
    out.push(unescapeXml(parts.join('')));
  }
  return out;
}

/** "B12" → 1（0 基列号） */
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref || '');
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 把第一个工作表读成二维数组（字符串）。
 * @param {Buffer} buf xlsx 文件内容
 * @returns {string[][]} 行 × 列，已按 <c r> 补齐空单元格
 */
export function readXlsx(buf) {
  const entries = readZipEntries(buf);
  const sheetName = [...entries.keys()]
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0];
  if (!sheetName) throw new Error('E_XLSX_NO_SHEET: 文件里没有工作表');

  const shared = readSharedStrings(readEntry(buf, entries.get('xl/sharedStrings.xml')));
  const sheet = readEntry(buf, entries.get(sheetName)) || '';

  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const attrs = rm[1];
    const rowNo = Number((/r="(\d+)"/.exec(attrs) || [])[1] || rows.length + 1);
    const cells = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)) {
      const cAttr = cm[1];
      const body = cm[3] || '';
      const ref = (/r="([A-Z]+\d+)"/.exec(cAttr) || [])[1];
      const type = (/t="([^"]+)"/.exec(cAttr) || [])[1] || '';
      const idx = colIndex(ref);
      if (idx === null) continue;
      let val = '';
      if (type === 'inlineStr') {
        val = unescapeXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
      } else {
        const v = (/<v>([\s\S]*?)<\/v>/.exec(body) || [])[1];
        if (v !== undefined) val = type === 's' ? (shared[Number(v)] ?? '') : unescapeXml(v);
      }
      cells[idx] = val;
    }
    // 补齐空洞（Excel 会跳过空单元格，colIndex 已经把位置算出来）
    const width = cells.length;
    rows[rowNo - 1] = Array.from({ length: width }, (_, i) => cells[i] ?? '');
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}
