// ============================================================================
// tools/watch-dingtalk.mjs · 挂着等打卡：每 N 秒拉一次增量
// ----------------------------------------------------------------------------
// 用途：你在钉钉上打卡，这边几十秒内就出现在「打卡 → 打卡流水」里。
//
//   DATABASE_URL=postgres://.../aihr_demo node tools/watch-dingtalk.mjs --every 30
//
// 为什么是轮询而不是事件订阅：
//   · 钉钉的考勤打卡事件要「企业内部应用 + 事件订阅 + 回调地址」（公网 HTTPS 或
//     Stream 长连接），而 dws 的事件目录里没有考勤事件 —— 那条路要改钉钉后台。
//   · 轮询零配置、可中断、可回放，而且**幂等键在库里**（punch 的 (source,ext_id)），
//     所以"轮询多次"和"事件推送多次"是同一种安全。
//   · 真要秒级，把 listPunches 换成事件回调写同一个 fn_punch_ingest —— 上层不用改。
//
// ★ 它不是一个服务：Ctrl-C 就停。生产要交给调度器（cron / systemd timer / 容器 sidecar）。
// ============================================================================
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const every = Math.max(10, Number(arg('--every', '30')));
const store = arg('--store', '测试上海门店');

if (!process.env.DATABASE_URL) {
  console.error('必须给 DATABASE_URL（目标帐套的库）');
  process.exit(2);
}

let stopped = false;
process.on('SIGINT', () => { stopped = true; console.log('\n停止（已处理完当前一轮）'); });

const once = () => new Promise((resolve) => {
  const c = spawn(process.execPath, [join(HERE, 'sync-dingtalk.mjs'),
    '--only-punch', '--punch-days', '1', '--store', store], {
    cwd: join(HERE, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  c.stdout.on('data', (b) => { out += b; });
  c.stderr.on('data', (b) => { out += b; });
  c.on('close', () => {
    const line = out.split('\n').find((l) => l.startsWith('④')) || '';
    resolve(line.trim());
  });
});

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
while (!stopped) {
  const line = await once();
  if (line) console.log(`[${stamp()}] ${line}`);
  if (stopped || every <= 0) break;
  await new Promise((r) => setTimeout(r, every * 1000));
}
process.exit(0);
