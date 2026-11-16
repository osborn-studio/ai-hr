// ============================================================================
// tools/restore.mjs · 恢复：先核对，再打开
// ----------------------------------------------------------------------------
// 恢复的危险不在"恢复失败"，在**恢复成功但恢复的是错的那份**：
// 打开了一个空库、或者一个一周前的库，而服务已经连上去了。
//
// 所以顺序是：**校验和 → 清单 → 才装载**。
//   · 校验和不对：文件在传输/存储中坏了，装进去就是一堆坏页。
//   · 清单对不上：装进去的是另一个库（或备份时清单取错了时刻）。
// 任何一种都直接失败，不做"尽力恢复"——尽力恢复的结果是"一半的数据 + 看起来正常"。
//
// 用法：
//   node tools/restore.mjs --file backups/aihr-20261114T153000.tar.gz --to /tmp/aihr-restored
// ============================================================================
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { sha256, collect } from './backup.mjs';

/** 恢复并核对；返回 { manifest, actual, diffs } */
export async function restore({ file, targetDir }) {
  const bytes = readFileSync(file);
  const manifestPath = join(dirname(file), basename(file).replace(/\.tar\.gz$/, '.json'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  // ① 校验和：先确认这份文件就是清单描述的那份
  const digest = sha256(bytes);
  if (digest !== manifest.sha256) {
    throw new Error(`E_BACKUP_CORRUPT: 校验和不符（清单 ${manifest.sha256.slice(0, 12)}… 实际 ${digest.slice(0, 12)}…）`);
  }

  // ② 装载（PGlite 的 loadDataDir 接受 File/Blob）
  const blob = new File([bytes], basename(file), { type: 'application/gzip' });
  const db = await PGlite.create({ extensions: { btree_gist }, loadDataDir: blob });
  let actual;
  try { actual = await collect(db); } finally { await db.close(); }

  // ③ 拿同一把尺子比：备份前的清单 vs 恢复后的实际
  const diffs = [];
  if (actual.tables !== manifest.tables) diffs.push(`表数 ${manifest.tables}→${actual.tables}`);
  if (actual.business_functions !== manifest.business_functions) {
    diffs.push(`函数数 ${manifest.business_functions}→${actual.business_functions}`);
  }
  for (const [t, n] of Object.entries(manifest.counts || {})) {
    if (actual.counts[t] !== n) diffs.push(`${t} ${n}→${actual.counts[t] ?? '不存在'}`);
  }

  if (diffs.length > 0) {
    throw new Error(`E_BACKUP_MISMATCH: 恢复后的库与清单不一致：${diffs.slice(0, 4).join('、')}`);
  }

  // ④ 落盘到目标目录（真正交付用的那份）
  if (targetDir) {
    const db2 = await PGlite.create({ extensions: { btree_gist }, loadDataDir: blob, dataDir: targetDir });
    await db2.close();
  }

  return { manifest, actual, diffs, bytes: bytes.length };
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > -1 ? process.argv[i + 1] : d;
  };
  const file = arg('file');
  const to = arg('to');
  if (!file) {
    console.error('用法：node tools/restore.mjs --file backups/xxx.tar.gz [--to /data]');
    process.exit(2);
  }
  try {
    const r = await restore({ file, targetDir: to });
    console.log(`恢复完成：${file}`);
    console.log(`  备份时间：${r.manifest.taken_at} · 引擎 ${r.manifest.engine}`);
    console.log(`  核对通过：表 ${r.actual.tables} · 函数 ${r.actual.business_functions}`);
    console.log(`  关键表行数：${Object.entries(r.actual.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (to) console.log(`  已落盘到：${to}`);
  } catch (e) {
    console.error(String(e.message).split('\n')[0]);
    process.exit(1);
  }
}
