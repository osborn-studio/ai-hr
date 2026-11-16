// ============================================================================
// app/csv.mjs · 全系统只有一个 CSV 写出器
// ----------------------------------------------------------------------------
// 导出曾经是"三行 join(',')"就完事的地方，而它有三类事故，都不报错：
//
//   ① **没有 BOM**：Excel 在中文 Windows 上按系统编码打开 → 列名全是乱码。
//      业务看到乱码的第一反应不是"编码问题"，是"这个文件坏了、系统不行"。
//   ② **不转义**：`张,三` 这样的值会把后面所有列挤偏一格。
//      文件照样打开、也不报错，而错的是一整列的数据。
//   ③ **不防公式**：值以 `=` `+` `-` `@` 开头时，Excel 会当公式**执行**
//      （`=cmd|'/c calc'!A1` 这类老问题）。HR 姓名、备注是外部可填的，
//      所以这条不是理论风险 —— 导出的文件会被转发给很多人。
//
// 规矩与 guard.mjs 的同一条：**不要"再掩一次"，要只有一份实现**。
// 工资条导出与报表导出都走 csv()，谁都不许自己拼字符串。
// ============================================================================

import { createHash } from 'node:crypto';

export const BOM = '\uFEFF';

// RFC 4180 的字段：包含分隔符 / 引号 / 换行时必须加引号，内部引号翻倍。
const NEED_QUOTE = /[",\r\n]/;

// 以这些字符开头的**文本**会被表格软件当公式或控制字符处理。
// ★ 注意 `-` 在列里：负数需要保留（那是数字，不是公式），
//   所以防护只对 text 列生效 —— 数字列走 numeric 分支，不做前缀。
const FORMULA_HEAD = /^[=+\-@\t\r]/;

/** 文本单元格：防公式 → 转义 → 需要时加引号 */
export function textCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (FORMULA_HEAD.test(s)) s = `'${s}`;          // 前置单引号：Excel 显示原文，不执行
  if (NEED_QUOTE.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 数字单元格：只输出**能当数读的形态**。
 * ★ 非数字一律写成空，而不是写 0：
 *   写 0 会让"没有权限/没有数据"变成"金额是 0"，而收到文件的人无从分辨。
 */
export function numCell(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(n);
}

/**
 * @param {{columns:{key:string,label:string,numeric?:boolean}[], rows:object[]}} spec
 * @returns {string} 带 BOM、CRLF 行尾的完整 CSV
 */
export function csv({ columns, rows }) {
  const line = (cells) => cells.join(',');
  const out = [line(columns.map((c) => textCell(c.label)))];
  for (const r of rows) {
    out.push(line(columns.map((c) => (c.numeric ? numCell(r[c.key]) : textCell(r[c.key])))));
  }
  return BOM + out.join('\r\n') + '\r\n';
}

/** 内容摘要：留痕要用（见 055 的 report_export.content_sha256） */
export const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

export const CSV_HEADERS = {
  'content-type': 'text/csv; charset=utf-8',
  // nosniff 对下载也重要：让浏览器不要猜类型去渲染它
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
