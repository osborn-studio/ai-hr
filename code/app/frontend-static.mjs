import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webp': 'image/webp' };
export const FRONTEND_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
};
export function createFrontendHandler(directory) {
  const root = resolve(directory);
  return async function serve(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!(pathname === '/' || pathname === '/app' || pathname.startsWith('/app/') || pathname.startsWith('/assets/'))) return false;
    if (!['GET', 'HEAD'].includes(req.method)) return false;
    let relative;
    try { relative = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return true; }
    if (relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) { res.writeHead(404); res.end(); return true; }
    const asset = pathname.startsWith('/assets/');
    const file = resolve(root, asset ? relative.slice(1) : 'index.html');
    try {
      const physicalRoot = await realpath(root);
      const physical = await realpath(file);
      if (!physical.startsWith(physicalRoot + sep)) throw new Error('outside build root');
      const info = await stat(physical);
      if (!info.isFile()) throw new Error('not a file');
      const content = req.method === 'HEAD' ? null : await readFile(physical);
      res.writeHead(200, { ...FRONTEND_HEADERS, 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': info.size, 'cache-control': asset ? 'public, max-age=31536000, immutable' : 'no-store' });
      res.end(content);
    } catch {
      // Never substitute the SPA HTML for missing JS, API or downloaded files.
      res.writeHead(asset ? 404 : 503, { ...FRONTEND_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(asset ? '资源不存在' : '前端尚未构建，请先执行构建命令');
    }
    return true;
  };
}

export function attachFrontend(server, directory) {
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  const serve = createFrontendHandler(directory);
  server.on('request', async (req, res) => {
    try {
      if (await serve(req, res)) return;
      for (const handler of handlers) handler.call(server, req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'E_FRONTEND', message: '页面服务暂不可用' }));
    }
  });
}
