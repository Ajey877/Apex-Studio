#!/usr/bin/env node
// Minimal static server for the spike harness (no dependencies).
//
// The URL prefix selects the Content-Security-Policy applied to EVERY response,
// mirroring how electron.cjs applies its CSP header to every packaged response:
//   /csp-none/...              no CSP header
//   /csp-production/...        the exact CSP string from electron.cjs (packaged app)
//   /csp-production-wasm/...   the same plus 'wasm-unsafe-eval' in script-src
//   further investigation-only variants: see CSP_MODES in server/csp.mjs (the
//   csp-split-* modes give worklet/worker script responses a different policy
//   from the document).
// Any other path is served without CSP.
//
//   node server/serve.mjs [--port 4173] [--host 127.0.0.1]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP_MODES, cspFor } from './csp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const port = Number(arg('port', process.env.SPIKE_PORT || 4173));
const host = arg('host', '127.0.0.1');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.wat': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  let mode = null;
  const m = path.match(/^\/(csp-[a-z-]+)(\/.*)$/);
  if (m && Object.hasOwn(CSP_MODES, m[1])) {
    mode = m[1];
    path = m[2];
  }
  if (path === '/' || path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
    const csp = mode ? cspFor(mode, file) : null;
    if (csp) headers['Content-Security-Policy'] = csp;
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

server.listen(port, host, () => {
  console.log(`[spike] serving ${root} at http://${host}:${port}/web/  (CSP variants: ${Object.keys(CSP_MODES).map(k => `/${k}/web/`).join(', ')})`);
});
