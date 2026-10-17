#!/usr/bin/env node
// Build the unmodified production audio engine from a clean git archive into a
// temporary browser bundle used only by the Stage C measurement rig.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, version as esbuildVersion } from 'esbuild';

const rigDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rigDir, '../../..');
const workDir = path.resolve(process.argv[2] ?? '/tmp/apex-stage-c');
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const dirtySource = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: repoRoot, encoding: 'utf8' }).trim();
if (branch !== 'arena/e6a78ed6-apex-studio') {
  throw new Error(`Refusing to build outside the fixed Arena branch: ${branch}`);
}
if (dirtySource) {
  throw new Error(`Refusing to build with modified production source files:\n${dirtySource}`);
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = execFileSync('git', ['archive', '--format=tar', sourceCommit, 'src'], {
  cwd: repoRoot,
  maxBuffer: 512 * 1024 * 1024,
});

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
execFileSync('tar', ['-xf', '-', '-C', workDir], { input: archive, maxBuffer: 512 * 1024 * 1024 });

let entry = readFileSync(path.join(rigDir, 'entry-stage-c.ts'), 'utf8');
entry = entry
  .replaceAll("'../../../src/audio/audioEngine'", "'./src/audio/audioEngine'")
  .replaceAll("'../../../src/audio/transport'", "'./src/audio/transport'")
  .replaceAll('__SOURCE_COMMIT__', sourceCommit);
const entryPath = path.join(workDir, 'entry-stage-c.ts');
writeFileSync(entryPath, entry);

const bundlePath = path.join(workDir, 'bundle-engine.js');
await build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2022'],
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  outfile: bundlePath,
  logLevel: 'info',
});
copyFileSync(path.join(rigDir, 'stage-c-rig.html'), path.join(workDir, 'stage-c-rig.html'));

const bundleBytes = readFileSync(bundlePath);
const manifest = {
  experiment: 'Apex Studio Stage C pattern-length campaign',
  sourceBranch: branch,
  sourceCommit,
  sourceArchiveSha256: hash(archive),
  bundleSha256: hash(bundleBytes),
  bundleBytes: statSync(bundlePath).size,
  builtAtUtc: new Date().toISOString(),
  esbuildVersion,
  build: {
    entry: 'docs/verification/rig/entry-stage-c.ts',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: false,
  },
  sourceTreeStatus: 'clean for src/; git archive of sourceCommit used',
};
writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ workDir, ...manifest }, null, 2));
