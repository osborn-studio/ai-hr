// ============================================================================
// backup.test.mjs · 备份与恢复：能核对，才叫备份
// ----------------------------------------------------------------------------
// "已经备过了"这句话在三种情况下是假的：文件坏了、清单取错了时刻、
// 恢复出来的是另一个库。所以这一组不测"能不能备份"，测**核对能不能拦住**。
// ============================================================================
import { mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readdirSync } from 'node:fs';
import { backup, collect } from '../tools/backup.mjs';
import { restore } from '../tools/restore.mjs';

const results = [];
const rec = (id, what, ok, note = '') => results.push({ id, what, ok, note });

const work = mkdtempSync(join(tmpdir(), 'aihr-bk-'));
const dataDir = join(work, 'db');
const outDir = join(work, 'backups');
const DB = join(import.meta.dirname, '..', 'db');

// 建一个"真实一点"的库：跑全部迁移 + 塞一条探针行
{
  const db = await PGlite.create({ extensions: { btree_gist }, dataDir });
  await db.exec('CREATE EXTENSION IF NOT EXISTS btree_gist');
  for (const m of readdirSync(DB).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort())
    await db.exec(readFileSync(join(DB, m), 'utf8'));
  // 用两张"插入不需要显式 id"的表做探针：person / leave_type 的主键是显式播种的，
  // 无 id 插入会撞 NOT NULL —— 这也正是 009 那次 IDENTITY 事故的同一类坑。
  await db.exec(`
    INSERT INTO sys_user_credential(user_id, pwd_hash) VALUES (9001, 'scrypt$bk');
    INSERT INTO app_request_log(actor, action, ok) VALUES ('bk', 'backup.probe', true);
  `);
  await db.close();
}

let bk;
{
  bk = await backup({ dataDir, outDir });
  const mf = JSON.parse(readFileSync(bk.manifest, 'utf8'));
  rec('B1','备份产物 = 一个自包含文件 + 一份清单（sha256 / 表数 / 函数数 / 关键表行数）',
      !!bk.sha256 && mf.sha256 === bk.sha256 && mf.tables > 60
      && mf.counts.sys_user_credential === 1 && mf.counts.app_request_log === 1,
      `${(bk.bytes / 1024 / 1024).toFixed(1)}MB 表=${mf.tables} 凭证=${mf.counts.sys_user_credential}`);
}

{
  const target = join(work, 'restored');
  const r = await restore({ file: bk.file, targetDir: target });
  // 恢复出来的库真的能读（不是"能打开"）：直接开一次查探针
  const db = await PGlite.create({ extensions: { btree_gist }, dataDir: target });
  const probe = (await db.query(
    `SELECT count(*)::int n FROM sys_user_credential WHERE user_id = 9001`)).rows[0].n;
  const actual = await collect(db);
  await db.close();
  rec('B2','恢复后行数与清单一致，且数据真的在（探针行查得到）',
      Number(probe) === 1 && r.diffs.length === 0
      && JSON.stringify(actual.counts) === JSON.stringify(r.manifest.counts),
      `探针=${probe} 差异=${r.diffs.length}`);
}

{
  // 坏文件：改一个字节，校验和必须拦住
  const bad = join(work, 'corrupt.tar.gz');
  const buf = readFileSync(bk.file);
  buf[buf.length - 100] ^= 0xff;
  writeFileSync(bad, buf);
  copyFileSync(bk.manifest, bad.replace(/\.tar\.gz$/, '.json'));

  let msg = '';
  try { await restore({ file: bad }); } catch (e) { msg = e.message; }
  rec('B3','文件损坏（改一个字节）→ E_BACKUP_CORRUPT（装进去只会得到一堆坏页）',
      msg.includes('E_BACKUP_CORRUPT'), String(msg).split('\n')[0].slice(0, 44));
}

{
  // 清单被改：校验和仍对得上文件，但"应该有多少"对不上 —— 拦住的是"装错库"
  const lying = join(work, 'lying.tar.gz');
  copyFileSync(bk.file, lying);
  const mf = JSON.parse(readFileSync(bk.manifest, 'utf8'));
  mf.sha256 = JSON.parse(readFileSync(bk.manifest, 'utf8')).sha256;   // 校验和不变
  mf.counts.sys_user_credential = 999;                               // 清单撒谎
  writeFileSync(lying.replace(/\.tar\.gz$/, '.json'), JSON.stringify(mf));

  let msg = '';
  try { await restore({ file: lying }); } catch (e) { msg = e.message; }
  rec('B4','清单与库不一致（校验和仍对）→ E_BACKUP_MISMATCH，不做"尽力恢复"',
      msg.includes('E_BACKUP_MISMATCH'), String(msg).split('\n')[0].slice(0, 44));
}

{ // B5 空库备份必须被拒：那是"成功"里最贵的一种
  // 先做出一个**真的**空库（有 PG_VERSION、没有任何迁移），而不是一个不存在的路径。
  // 两者的拒绝码不同，这是有意的：
  //   · 不存在的路径 → E_BACKUP_NOT_PGLITE（在开库之前就拦，免得 PGlite 顺手建一个空库）
  //   · 存在但空的库 → E_BACKUP_EMPTY（就是这一条：文件有 4MB、清单全 null）
  const emptyDir = join(work, 'empty');
  {
    const db = await PGlite.create({ extensions: { btree_gist }, dataDir: emptyDir });
    await db.close();
  }
  let msg = '';
  try { await backup({ dataDir: emptyDir, outDir: join(work, 'bk-empty') }); }
  catch (e) { msg = e.message; }
  rec('B5','备份一个空库 → E_BACKUP_EMPTY（文件有 4MB、清单全 null，出事那天才发现备的是空库）',
      msg.includes('E_BACKUP_EMPTY'), String(msg).split('\n')[0].slice(0, 40)); }

try { rmSync(work, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

const pass = results.filter(r => r.ok).length;
console.log(`\n备份 · 断言 ${results.length} 条 · 通过 ${pass} · 失败 ${results.length - pass}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id}  ${r.what}${r.note ? `   [${r.note}]` : ''}`);
console.log('');
process.exit(pass === results.length ? 0 : 1);
