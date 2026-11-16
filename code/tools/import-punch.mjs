// ============================================================================
// tools/import-punch.mjs · 考勤机文件导入（CSV：工号,时间,方向）
// ----------------------------------------------------------------------------
// 用法：
//   node tools/import-punch.mjs --file 打卡.csv --preview          # 只看会进哪些
//   node tools/import-punch.mjs --file 打卡.csv --commit --by hr    # 真落库
//   PGLITE_DATA_DIR=./data node tools/import-punch.mjs --file x.csv --commit
//   DATABASE_URL=postgres://... node tools/import-punch.mjs --file x.csv --commit
//
// 文件格式（表头必须有，列序不限，多余列忽略）：
//   工号,时间,方向
//   E0001,2026-06-01 09:00:00,in
//   E0001,2026-06-01 18:05:00,out
//
// 三条与库里一致的规矩：默认**只预览**；匹配不到工号的行跳过并报原因（不建人）；
// 同一份文件导两次不翻倍（幂等键 工号|时间|方向）。
// ============================================================================
import { readFileSync } from 'node:fs';
import { createDb } from '../app/db.mjs';

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] || def) : def;
};
const file = arg('--file');
const commit = process.argv.includes('--commit');
const by = arg('--by', 'file_import');

if (!file) {
  console.error('用法：node tools/import-punch.mjs --file 打卡.csv [--commit] [--by hr]');
  process.exit(2);
}

// ---- 解析 CSV：只要三列，容错顺序；时间统一成 ISO --------------------------
const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
const head = lines.shift().split(',').map((s) => s.trim());
const col = (names) => {
  for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; }
  return -1;
};
const iNo = col(['工号', 'emp_no', 'employee_no']);
const iAt = col(['时间', '打卡时间', 'at', 'time']);
const iKind = col(['方向', '类型', 'kind', 'in_out']);

if (iNo < 0 || iAt < 0 || iKind < 0) {
  console.error(`表头必须包含 工号 / 时间 / 方向，当前表头：${head.join(',')}`);
  process.exit(2);
}

const rows = lines.map((l) => {
  const c = l.split(',');
  const at = String(c[iAt] || '').trim().replace(' ', 'T');
  // 没有时区的本地时间按 +08:00 解释（香港/内地门店的默认）；有 Z 或 +hh:mm 就照用
  const iso = /Z$|[+-]\d{2}:\d{2}$/.test(at) ? at : `${at}+08:00`;
  return { emp_no: String(c[iNo] || '').trim(), at: iso, kind: String(c[iKind] || '').trim().toLowerCase() };
});

const db = await createDb({
  dataDir: process.env.PGLITE_DATA_DIR || undefined,
  url: process.env.DATABASE_URL || undefined,
});

const out = (await db.query(
  `SELECT * FROM fn_punch_import($1::jsonb,$2,$3,$4)`,
  [JSON.stringify(rows), by, !commit, file.split('/').pop()])).rows;

const by_status = out.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
console.log(`\n${commit ? '导入' : '预览'}：共 ${out.length} 行 → `
  + `ok ${by_status.ok || 0} · dup ${by_status.dup || 0} · skip ${by_status.skip || 0}\n`);
for (const r of out.filter((x) => x.status !== 'ok')) {
  console.log(`  第 ${r.row_no} 行 ${r.status}：${r.reason || ''}`);
}
if (!commit) console.log('\n这是预览，一行都没写进库。确认无误后加 --commit。');
process.exit(0);
