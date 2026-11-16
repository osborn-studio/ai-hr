// ============================================================================
// app/sheet.mjs · 读表格：CSV / TSV / 分号分隔
// ----------------------------------------------------------------------------
// csv.mjs 是**写**（导出），这里是**读**（导入）。两者分开，不共用一个函数：
// 写的规则（什么时候加引号、怎么转义）与读的容错（BOM、CRLF、多余空行）
// 是两套不同的知识，塞进一个模块里迟早会互相污染。
//
// 这一版要对付的真实情况：
//   · Excel 另存 CSV 带 UTF-8 BOM（\uFEFF），第一列名会莫名变成 "工号"；
//   · 中文 Windows 下常导出 GBK —— 那是编码问题，得在调用方用 Buffer 转，
//     这里只管"已经是一串字符之后"的事；
//   · 字段里有逗号（"张三,临时工"）→ 必须认双引号；
//   · 双引号里的双引号是 "" 转义；
//   · 行尾可能是 \r\n、\n、\r 三种；
//   · 末尾空行不该产出一行全空数据。
// ============================================================================

/** 猜分隔符：逗号、制表符、分号，取"表头行里出现次数最多"的那个 */
export function sniffDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 3).join('\n');
  const cands = [',', '\t', ';'];
  let best = ',', bestN = 0;
  for (const d of cands) {
    const n = head.split(d).length - 1;
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

/**
 * 解析成二维数组（全部按字符串给，数值转换交给调用方 ——
 * "1,300.00" 这种带千分位的金额由业务层决定怎么读，不该由表格层猜）。
 */
export function parseDelimited(text, delimiter = null) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);          // BOM
  const d = delimiter || sniffDelimiter(s);
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === d) { row.push(field); field = ''; continue; }
    if (c === '\r') { continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  // 丢掉全空行（Excel 另存常在末尾留一堆）
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

/** 首行当表头，trim 掉空格；重名列保留第一个（导入时重名要报错，不能静默丢数据） */
export function toObjects(rows) {
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map(h => String(h ?? '').trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const o = {};
    headers.forEach((h, idx) => { if (h) o[h] = String(r[idx] ?? '').trim(); });
    // cells 是原始一行（按列序）：导入时按列号取值比按表头 key 稳，
    // 表头重名或为空时 key 会互相覆盖，而列号不会。
    out.push({ row_no: i + 1, data: o, cells: r.map(x => String(x ?? '').trim()) });
  }
  return { headers, rows: out };
}

/** 金额：容忍千分位、¥、空格、括号负数（(1,200) = -1200） */
export function toAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).trim().replace(/[¥￥,\s]/g, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}
