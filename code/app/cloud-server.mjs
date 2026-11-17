import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApp } from './server.mjs';
import { attachFrontend } from './frontend-static.mjs';
import { createCloudApiExtension } from './cloud-api.mjs';
import { createBrokerApp } from './broker-app.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export function cloudConfiguration(env = process.env) {
  const mode = env.TYHR_DATA_MODE || (env.DATABASE_URL ? 'postgres' : null);
  if (!['postgres', 'broker', 'pglite_demo'].includes(mode)) throw new Error('必须显式配置TYHR_DATA_MODE及持久数据连接；演示可选pglite_demo');
  if (env.CONTROL_URL) throw new Error('云端标准采用单部署数据库及逻辑帐套，不启用CONTROL_URL物理分库');
  if (mode === 'postgres' && !env.DATABASE_URL) throw new Error('postgres模式缺少DATABASE_URL');
  if (mode === 'broker' && env.DATABASE_URL) throw new Error('broker模式不得同时配置DATABASE_URL');
  if (mode === 'pglite_demo' && (env.NODE_ENV === 'production' || env.DATABASE_URL)) throw new Error('pglite_demo仅可在隔离演示环境使用');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT无效');
  return { mode, port, host: env.HOST || '127.0.0.1', frontendDir: resolve(env.TYHR_FRONTEND_DIR || join(HERE, '..', 'dist')) };
}

export async function assertCloudMigrations(db) {
  const dir = join(HERE, '..', 'db');
  const names = (await readdir(dir)).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();
  const rows = (await db.query('SELECT file,sha256 FROM schema_migration ORDER BY file')).rows;
  const applied = new Map(rows.map(r => [r.file, r.sha256]));
  for (const name of names) {
    const expected = createHash('sha256').update(await readFile(join(dir, name))).digest('hex');
    if (applied.get(name) !== expected) throw new Error(`迁移未就绪或与可信账本不符：${name}；请使用受控迁移工具`);
  }
  if (rows.some(r => !names.includes(r.file))) throw new Error('数据库含当前发布版本未知迁移，不继续启动');
  return { applied: names.length, verified: true };
}

export async function createCloudApp() {
  const config = cloudConfiguration();
  if (config.mode === 'broker') return { ...(await createBrokerApp(config)), config };
  const app = await createApp({ apiExtension: createCloudApiExtension(), skipDemoSeed: true });
  try {
    await assertCloudMigrations(app.db);
    attachFrontend(app.server, config.frontendDir);
    const worker=await import('./workers/learning-worker.mjs');
    const stopBackgroundWorkers=worker.startLearningDeadlineWorker(app.db,{onError:error=>console.error('学习期限任务暂不可用',String(error.code||'E_LEARNING_WORKER').replace(/[^A-Z0-9_]/g,'').slice(0,64))});
    app.server.once('close',()=>Promise.resolve(stopBackgroundWorkers()).catch(()=>{}));
    return { ...app, config, stopBackgroundWorkers };
  } catch (error) { await app.db.close(); throw error; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const app = await createCloudApp();
  app.server.listen(app.config.port, app.config.host, () => console.log(`ty-hr ${app.config.mode} 单进程服务已启动 ${app.config.host}:${app.config.port}`));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(1), 15000).unref();
    app.server.close(async () => { await app.stopBackgroundWorkers?.(); await app.db?.close(); clearTimeout(timeout); });
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
