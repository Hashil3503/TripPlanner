/* static.js - public/ 아래 파일만 정적으로 제공한다 (경로 이탈 방지, 디렉터리 목록 없음, 점(.)으로 시작하는 파일 차단) */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('찾을 수 없어요');
}

/** publicDir 는 fs.realpathSync 를 거친 절대 경로여야 한다 */
function serveStatic(req, res, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('허용되지 않는 메서드예요');
  }
  const raw = String(req.url || '').split(/[?#]/)[0];
  if (!raw.startsWith('/')) return notFound(res);
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (e) {
    return notFound(res);
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return notFound(res);
  const segments = decoded.split('/').filter(Boolean);
  // '..' / 숨김 파일 / 윈도우 대체 스트림(:) 차단
  if (segments.some((s) => s.startsWith('.') || s.includes(':'))) return notFound(res);
  if (decoded.endsWith('/') && segments.length) return notFound(res); // 디렉터리 목록 없음
  const rel = segments.length ? segments : ['index.html'];
  const full = path.join(publicDir, ...rel);
  if (!full.startsWith(publicDir + path.sep)) return notFound(res);

  fs.realpath(full, (err, real) => {
    // 심볼릭 링크로 public 밖을 가리키는 경우도 차단
    if (err || !real.startsWith(publicDir + path.sep)) return notFound(res);
    fs.stat(real, (err2, st) => {
      if (err2 || !st.isFile()) return notFound(res);
      const type = MIME[path.extname(real).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(real);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  });
}

module.exports = { serveStatic };
