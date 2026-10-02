/* serve.js — the local app server (no dependencies).
 *   node tools/serve.js [port] [--library DIR]
 * Serves the app folder over http://localhost:<port>/ (default 8000), follows symlinks
 * (the library folder links to the loop WAVs), supports Range requests for audio, and
 * exposes two tiny endpoints so the app can save without dialogs:
 *   GET  /api/ping                          → {"ok":true,"library":"<mounted path>"}
 *   PUT  /library/<lib>/<name>.json         → writes that file (only *.json, only inside the library folder)
 * --library DIR mounts a different folder at /library/ (the tests use their fixture library). */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wav': 'audio/wav', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.csv': 'text/csv' };
function start({ port = 8000, libraryDir = path.join(ROOT, 'library'), log = false } = {}) {
  libraryDir = path.resolve(libraryDir);
  const server = http.createServer((req, res) => {
    let p; try { p = decodeURIComponent(req.url.split('?')[0]); } catch (_) { res.writeHead(400); return res.end(); }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
    if (p === '/api/ping') return json(200, { ok: true, library: libraryDir, version: '1.0.0' });
    if (req.method === 'PUT' && p.startsWith('/library/')) {
      const rel = p.slice('/library/'.length); const parts = rel.split('/');
      if (parts.length !== 2 || !/^[\w.\- ]+$/.test(parts[0]) || !/^[\w.\- ]+\.json$/.test(parts[1])) return json(400, { ok: false, error: 'only library/<lib>/<name>.json may be written' });
      const file = path.join(libraryDir, parts[0], parts[1]); if (!file.startsWith(libraryDir + path.sep)) return json(403, { ok: false });
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 50 * 1024 * 1024) { req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { const body = Buffer.concat(chunks); JSON.parse(body.toString('utf8')); fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, body); fs.renameSync(tmp, file); if (log) console.log('PUT', rel, size, 'bytes'); json(200, { ok: true, bytes: size, file: rel }); } catch (e) { json(400, { ok: false, error: 'body must be JSON: ' + e.message }); } });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p.endsWith('/')) p += 'index.html';
    let file;
    if (p === '/library' || p.startsWith('/library/')) file = path.join(libraryDir, p.slice('/library'.length));
    else file = path.join(ROOT, p);
    const base = p.startsWith('/library') ? libraryDir : ROOT; if (!file.startsWith(base)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      const ext = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': ext === '.wav' ? 'max-age=3600' : 'no-store' };
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (range && (range[1] || range[2])) {
        const start = range[1] ? parseInt(range[1], 10) : Math.max(0, st.size - parseInt(range[2], 10)), end = range[2] && range[1] ? Math.min(st.size - 1, parseInt(range[2], 10)) : st.size - 1;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`; headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers); if (req.method === 'HEAD') return res.end(); return fs.createReadStream(file, { start, end }).pipe(res);
      }
      headers['Content-Length'] = st.size; res.writeHead(200, headers); if (req.method === 'HEAD') return res.end(); fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, libraryDir })));
}
module.exports = { start };
if (require.main === module) {
  const args = process.argv.slice(2); const li = args.indexOf('--library'); const libraryDir = li >= 0 ? args[li + 1] : undefined; const port = parseInt(args.find(a => /^\d+$/.test(a)) || '8000', 10);
  start({ port, libraryDir, log: true }).then(({ port, libraryDir }) => console.log(`Note: http://localhost:${port}/  (library: ${libraryDir})`));
}
