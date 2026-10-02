/* serve.js — tiny static server for the app (no dependencies).
 * Usage: node tests/serve.js [port]   → http://localhost:8000/
 * Equivalent to `python3 -m http.server 8000` run in the app directory. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.md': 'text/markdown', '.png': 'image/png', '.svg': 'image/svg+xml' };
function start(port = 0) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const start = range[1] ? parseInt(range[1], 10) : 0, end = range[2] ? parseInt(range[2], 10) : st.size - 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`; headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers); return fs.createReadStream(file, { start, end }).pipe(res);
      }
      headers['Content-Length'] = st.size; res.writeHead(200, headers); fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
module.exports = { start };
if (require.main === module) start(parseInt(process.argv[2] || '8000', 10)).then(({ port }) => console.log(`Note: http://localhost:${port}/`));
