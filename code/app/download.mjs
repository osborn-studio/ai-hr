// ============================================================================
// app/download.mjs · 下载头只有一份写法（文件名转义也在这里）
// ----------------------------------------------------------------------------
// 为什么值得单独一个文件：Content-Disposition 里的文件名有两处会出事，
// 而且都不会报错 ——
//
//   ① **中文名**：`filename="工资单.xlsx"` 在 HTTP 头里是非法的（头是 latin-1）。
//      现代浏览器靠 RFC 5987 的 `filename*=UTF-8''<百分号编码>` 才拿到中文名。
//      只写前者，下载下来叫 `download` 或一串乱码。
//   ② **引号与反斜杠**：文件名里有一个 `"` 就把头的语法破掉，浏览器会
//      截断文件名甚至拒收整个响应头 —— 而我们的文件名是拼接出来的
//      （含期间、批次号），一旦以后带上人名/门店名就会踩到。
//      所以 ascii 那份把 `"` 与 `\` 换成 `_`，中文那份做百分号编码。
//
// ★ 两份都给（不是二选一）：老浏览器只认 filename，新浏览器优先 filename*。
//   这一条与 zip 打包那段（server.mjs 的 payslip-pack）是同一个规矩，
//   区别只是这里把它收成一个函数，别让第三个导出再抄一遍。
// ============================================================================

/**
 * @param {string} asciiName 纯 ASCII 兜底名（如 `paylist_run1.xlsx`）
 * @param {string} [utf8Name] 给人看的中文名（如 `发放清单_2026-06.xlsx`）
 */
export function contentDisposition(asciiName, utf8Name = null) {
  const ascii = String(asciiName ?? 'download')
    .replace(/["\\]/g, '_')
    .replace(/[\u0000-\u001F\u007F]/g, ' ');
  if (utf8Name === null || utf8Name === undefined) {
    return `attachment; filename="${ascii}"`;
  }
  // RFC 5987 的 attr-char 不含 ' ( ) * —— encodeURIComponent 恰好放过这四个，
  // 所以要补一遍。漏掉它们的表现是："下载了但名字少了几个字"，不报错。
  const star = encodeURIComponent(String(utf8Name))
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}
