// Isolation guards: the spike must not be reachable from the production app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { PRODUCTION_CSP } from '../../server/csp.mjs';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(spikeRoot, '..', '..');
const MARKERS = ['audioworklet-wasm-spike', 'apex-spike-gain-filter', 'gain_biquad'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('no production source file references the spike', () => {
  const files = [
    ...walk(join(repoRoot, 'src')),
    join(repoRoot, 'index.html'), join(repoRoot, 'electron.cjs'), join(repoRoot, 'preload.cjs'),
    join(repoRoot, 'vite.config.ts'), join(repoRoot, 'package.json'),
  ];
  const offenders = files.filter(f => MARKERS.some(m => readFileSync(f, 'utf8').includes(m)));
  assert.deepEqual(offenders.map(f => relative(repoRoot, f)), []);
});

test('production build output (if present) contains no spike code', { skip: !existsSync(join(repoRoot, 'dist')) && 'dist/ not built (run `npm run build` at repo root first)' }, () => {
  const offenders = walk(join(repoRoot, 'dist'))
    .filter(f => statSync(f).size < 20e6)
    .filter(f => MARKERS.some(m => readFileSync(f).includes(m)));
  assert.deepEqual(offenders.map(f => relative(repoRoot, f)), []);
});

test('server/csp.mjs PRODUCTION_CSP is byte-identical to the policy in electron.cjs', () => {
  const src = readFileSync(join(repoRoot, 'electron.cjs'), 'utf8');
  const block = src.match(/'Content-Security-Policy':\s*\[\s*\[([\s\S]*?)\]\.join\('; '\)/);
  assert.ok(block, 'CSP block found in electron.cjs');
  const directives = [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.equal(directives.join('; '), PRODUCTION_CSP);
});

test('Electron spike runner copies the same production CSP directives', () => {
  const src = readFileSync(join(spikeRoot, 'electron', 'main.cjs'), 'utf8');
  const block = src.match(/const PRODUCTION_CSP = \[([\s\S]*?)\];/);
  assert.ok(block, 'PRODUCTION_CSP definition found in electron/main.cjs');
  const directives = [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  assert.equal(directives.join('; '), PRODUCTION_CSP);
});
