// ============================================================================
// persist.test.mjs · 重启不丢库（PGLITE_DATA_DIR）
// ----------------------------------------------------------------------------
// 「重启即丢」这件事，在会话上只是"重新登录"，在数据库上是**丢全部考勤与工资条**。
// 所以持久化不能只写在 Dockerfile 的注释里，它得有一条断言。
//
// 这一组只回答两个问题：
//   ① 设了 PGLITE_DATA_DIR，重启之后数据还在吗？
//   ② 重启会不会把种子**再灌一遍**（撞主键 / 悄悄多出一套数据）？
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app/server.mjs';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok, note });

const dir = mkdtempSync(join(tmpdir(), 'aihr-'));
process.env.PGLITE_DATA_DIR = dir;

const probe = '2099-01-01';

{
  const { db } = await createApp();
  await db.query(
    `INSERT INTO leave_grant(employee_id, leave_type_id, qty, valid_from)
     VALUES (1, 1, 1, $1::date)`, [probe]);
  const rows = Number((await db.query(
    'SELECT count(*)::int n FROM leave_grant')).rows[0].n);
  globalThis.__before = rows;
  await db.close();
}

{
  const { db, server } = await createApp();
  const rows = Number((await db.query(
    'SELECT count(*)::int n FROM leave_grant')).rows[0].n);
  const marker = Number((await db.query(
    `SELECT count(*)::int n FROM leave_grant WHERE valid_from = $1::date`, [probe])).rows[0].n);
  const att = Number((await db.query(
    'SELECT count(*)::int n FROM attendance_daily_store')).rows[0].n);

  rec('P1','重启后数据还在：落盘的库不需要重新灌一遍（探针行仍在）',
      marker === 1, `探针=${marker} 授予总数 ${globalThis.__before}→${rows}`);

  rec('P2','重启不会重灌种子：行数不变（否则会撞主键，或悄悄多出一套数据）',
      rows === globalThis.__before, `授予 ${globalThis.__before}→${rows}`);

  // 种子只有两条考勤；若重灌，会因为 uuid/主键冲突直接失败，这里再确认一遍数
  rec('P3','种子数据没有翻倍（考勤仍是 2 条）', att === 2, `考勤=${att} 条`);

  // 口令也在库里：重启后仍能登录（会话表也一起活下来）
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  const lr = await fetch(`${B}/login?user=1&pwd=demo1234`, { method: 'POST' });
  const lb = await lr.json();
  rec('P4','重启后仍能登录（口令与账号都在库里的，不在进程内存里）',
      lr.status === 200 && !!lb.token, `${lr.status} token=${!!lb.token}`);
  server.close();
  await db.close();
}

try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

const pass = results.filter(r => r.ok).length;
console.log(`\n持久化 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}${r.note ? `   [${r.note}]` : ''}`);
console.log('');
process.exit(pass === results.length ? 0 : 1);
