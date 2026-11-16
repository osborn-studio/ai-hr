// ============================================================================
// app/pdf.mjs · HTML → PDF（调本机 Chrome 的 --print-to-pdf，零依赖）
// ----------------------------------------------------------------------------
// 客户问的第二句话是"能不能存 PDF"。在服务端产出 PDF，能想到三条路：
//
//   ① 装一个 PDF 库（pdfkit / puppeteer / wkhtmltopdf）
//      → 破"零第三方依赖"这条底线，而且要自己解决中文：PDF 库默认不带
//        CJK 字体，要么嵌一份 10MB 字体进仓，要么在客户机器上找字体 ——
//        后者在 Docker / Linux 上通常找不到，产出一份**全是方块**的工资单。
//        一张写着"□□□□"的工资单比没有 PDF 更糟：它看起来是"系统坏了"。
//   ② 自己手写 PDF 文法（画线、放字）
//      → 中文要子集化 TrueType 字体，等于在仓库里实现一个字体引擎。
//        这不是"多写 200 行"，是"多一个会静默画错的渲染器"。
//   ③ 借本机已有的浏览器排版引擎（本文件的方案）
//      → Chrome 的 --print-to-pdf 走的就是"用户按 Ctrl+P 另存为 PDF"那条路，
//        中文、字体、@page 尺寸、分页、表格宽度**全部由它负责** ——
//        我们交付的 HTML 就是用户打印时看到的那一份，不存在"屏幕上一套、
//        PDF 里另一套"的偏差。代价写在下面"局限"里。
//
// ★ 局限（如实写，别假装没有）：
//   · 目标机器上**必须有 Chrome**（默认路径见 DEFAULT_CHROME，可用 CHROME_BIN 覆盖）。
//     没有就返回 501 + 一句人话，让用户改用浏览器打印 —— 不假装成功。
//   · 页眉页脚（URL / 日期 / 页码）用 --no-pdf-header-footer 关掉了：
//     Chrome 那套页眉是**英文 + 文件路径**，直接印在工资单上没法看。
//     页码由打印页自己渲染（"第 N / M 张"），不靠浏览器。
//   · 每次调用起一个 Chrome 进程，约 0.5–2 秒（374 页实测 < 4 秒）。
//     没有常驻池：并发导出是低频动作，多一个常驻进程就多一个要管的东西。
//   · 不生成 PDF/A、不签名、不加密。要归档合规的那一天，这是**另一件事**
//     （要专门的库），不要在这条路上硬加。
// ============================================================================
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bizErr } from './errors.mjs';

/** macOS 上 Chrome 的默认位置（与 docs/50 的部署说明同一处） */
export const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * 这次该用哪个 Chrome。
 * ★ 每次调用现读环境变量，不在模块加载时固化 —— 否则测试里
 *   `CHROME_BIN=/nonexistent` 只能在启动进程前设，验不了"没有 Chrome"那一支。
 */
export function chromeBin() {
  const v = process.env.CHROME_BIN;
  return v && String(v).trim() ? String(v) : DEFAULT_CHROME;
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/**
 * 把一段 HTML 渲染成 PDF 字节。
 *
 * @param {string} html     完整的 HTML（打印页由服务端渲染，带 <style>）
 * @param {object} [opts]
 * @param {string} [opts.bin]         Chrome 可执行文件（缺省 chromeBin()）
 * @param {number} [opts.timeoutMs]   超时（缺省 30s）。超时按失败处理，不返回半个文件
 * @returns {Promise<Buffer>}
 * @throws E_PDF_NO_CHROME（→501）/ E_PDF_FAILED（→500）
 */
export async function htmlToPdf(html, { bin = null, timeoutMs = 30000 } = {}) {
  const exe = bin || chromeBin();
  if (!existsSync(exe)) {
    // ★ 501 而不是 500：这不是"服务坏了"，是"这台机器没装浏览器"，
    //   下一次部署换台机器就有了。500 会让人去翻日志找 bug。
    throw bizErr('E_PDF_NO_CHROME',
      `本机没有可用的 Chrome（${exe}），无法服务端生成 PDF；可改用浏览器打印`);
  }

  // 临时目录：Chrome 要写 user-data-dir（不能与用户正在用的那个抢），
  // 还要落 html 与 pdf。**用后即删** —— 工资单 HTML 落在 /tmp 里不删，
  // 等于把全店薪资明文留在磁盘上。
  const dir = mkdtempSync(join(tmpdir(), 'aihr-pdf-'));
  const src = join(dir, 'print.html');
  const out = join(dir, 'print.pdf');
  try {
    writeFileSync(src, String(html ?? ''), 'utf8');

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      // 页眉页脚（URL/日期/页码）默认是英文加文件路径，见文件头"局限"
      '--no-pdf-header-footer',
      // 给字体加载与布局一点虚拟时间：不给的话，偶发出现"最后一张是空白页"
      '--virtual-time-budget=5000',
      `--user-data-dir=${join(dir, 'profile')}`,
      `--print-to-pdf=${out}`,
      pathToFileURL(src).href,
    ];

    await new Promise((resolve, reject) => {
      const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (c) => {
        // ★ 只留尾巴：Chrome 的 stderr 动辄几十行 GPU 警告，全存下来会把
        //   真正的错误（比如"无法写入文件"）挤到看不到的地方。
        err = (err + c.toString('utf8')).slice(-4000);
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(bizErr('E_PDF_FAILED', `Chrome 渲染 PDF 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(bizErr('E_PDF_FAILED', `无法启动 Chrome：${String(e.message).split('\n')[0]}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else {
          const tail = err.trim().split('\n').slice(-2).join(' / ').slice(0, 300);
          reject(bizErr('E_PDF_FAILED', `Chrome 退出码 ${code}${tail ? `：${tail}` : ''}`));
        }
      });
    });

    if (!existsSync(out) || statSync(out).size === 0) {
      throw bizErr('E_PDF_FAILED', 'Chrome 返回成功但没写出 PDF 文件');
    }
    const buf = readFileSync(out);
    // ★ 校验文件头，不信任退出码：退出码 0 但产出一个空壳的情况真实存在
    //   （--print-to-pdf 指向不可写路径时早期版本就是静默成功）。
    //   回一个不是 PDF 的字节流给浏览器，用户看到的是"下载了个坏文件"。
    if (!buf.subarray(0, 5).equals(PDF_MAGIC)) {
      throw bizErr('E_PDF_FAILED', 'Chrome 产出的文件不是 PDF（缺少 %PDF- 文件头）');
    }
    return buf;
  } finally {
    // force:true 让"Chrome 还没释放句柄"不会把清理变成异常
    rmSync(dir, { recursive: true, force: true });
  }
}
