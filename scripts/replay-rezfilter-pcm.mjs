// Diagnostic-only: replay preserved native PCM through a frozen helper+plugin.
// Does not mutate original corpus files. Direct-native isolation only.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).flatMap((arg, index, all) => {
  if (!arg.startsWith('--')) return [];
  const key = arg.slice(2);
  const next = all[index + 1];
  if (!next || next.startsWith('--')) return [[key, true]];
  return [[key, next]];
}));

const helper = args.helper;
const plugin = args.plugin;
const corpusDir = args['corpus-dir'];
const catalogPath = args.catalog || 'native/vst3/diag/original-silent-sessions-41053753392.json';
const outPath = args.out || 'build/native-evidence/rezfilter-replay.json';
const traceDir = args['trace-dir'] || process.env.APEX_REZFILTER_TRACE_DIR;
const sampleRate = Number(args['sample-rate'] || 48000);
const framesPerBlock = Number(args.frames || 1024);
if (!helper || !existsSync(helper)) throw new Error(`helper missing: ${helper}`);
if (!plugin || !existsSync(plugin)) throw new Error(`plugin missing: ${plugin}`);
if (traceDir) mkdirSync(traceDir, { recursive: true });

const { NativeVst3Client, discoverVst3 } = await import(pathToFileURL(path.resolve('native/vst3/client.mjs')).href);
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const overlay = catalog.overlayParameters ?? [];
const requested = new Set((catalog.sessions ?? []).map(session => session.sessionId));

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
function findModule(bundle) {
  if (!bundle || !existsSync(bundle)) return null;
  if (statSync(bundle).isFile()) return bundle;
  const stack = [bundle];
  let best = null, bestSize = -1;
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(vst3|dll|so|dylib)$/i.test(entry.name)) {
        const size = statSync(full).size;
        if (size > bestSize) { best = full; bestSize = size; }
      }
    }
  }
  return best;
}
function loadManifest(dir) {
  if (!dir || !existsSync(dir)) return null;
  const direct = path.join(dir, 'manifest.json');
  if (existsSync(direct)) return JSON.parse(readFileSync(direct, 'utf8'));
  const nested = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.includes('pcm-corpus'))
    .map(entry => path.join(dir, entry.name, 'manifest.json'))
    .find(file => existsSync(file));
  if (nested) return JSON.parse(readFileSync(nested, 'utf8'));
  const walk = [dir];
  while (walk.length) {
    const current = walk.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk.push(full);
      else if (entry.name === 'manifest.json') return JSON.parse(readFileSync(full, 'utf8'));
    }
  }
  return null;
}
function resolveReplayFile(file, root) {
  if (!file) return null;
  if (existsSync(file)) return file;
  const base = path.basename(file);
  const walk = [root];
  while (walk.length) {
    const current = walk.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk.push(full);
      else if (entry.name === base) return full;
    }
  }
  return null;
}

const pluginModule = findModule(plugin);
if (!pluginModule) throw new Error(`plugin module missing under ${plugin}`);
const pluginSha = sha256Buf(readFileSync(pluginModule));
const helperSha = sha256Buf(readFileSync(helper));
const roots = [path.resolve(plugin)];
const scanned = await discoverVst3(helper, roots, { kind: 'effect' });
const identity = scanned.plugins.find(item => /rezfilter/i.test(item.name || ''))
  ?? scanned.plugins.find(item => /rez filter/i.test(item.name || ''));
if (!identity) {
  writeFileSync(outPath, JSON.stringify({
    ok: false, error: 'mda RezFilter not found', plugin, pluginModule, pluginSha, helperSha, scanned,
  }, null, 2));
  throw new Error('mda RezFilter not found in swapped plugin');
}

const manifest = loadManifest(corpusDir);
const sessions = [];
const catalogById = Object.fromEntries((catalog.sessions ?? []).map(session => [session.sessionId, session]));

async function replaySession(sessionId, inputPath, expectedOutPath, expected) {
  const input = readFileSync(inputPath);
  const inputSha = sha256Buf(input);
  const samples = new Float32Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / 4));
  const blockFloats = framesPerBlock * 2;
  const blockCount = Math.floor(samples.length / blockFloats);
  const client = new NativeVst3Client(helper, { timeoutMs: 15000 });
  const outputs = [];
  let outputNonzero = 0, inputNonzero = 0, silentBlocks = 0;
  try {
    if (traceDir) process.env.APEX_REZFILTER_TRACE_DIR = traceDir;
    await client.open(identity, {
      sampleRate, mode: 'realtime', kind: 'effect', diagnosticSessionId: sessionId,
      state: { schema: 1, classId: identity.classId, parameters: overlay },
    });
    for (let index = 0; index < blockCount; index++) {
      const block = samples.subarray(index * blockFloats, (index + 1) * blockFloats);
      for (let i = 0; i < block.length; i++) if (block[i] !== 0) inputNonzero++;
      const result = await client.processAudio(framesPerBlock, Float32Array.from(block), [], 120, false);
      const out = result.samples;
      outputs.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
      let blockOutNz = 0;
      for (let i = 0; i < out.length; i++) if (out[i] !== 0) { outputNonzero++; blockOutNz++; }
      let blockInNz = 0;
      for (let i = 0; i < block.length; i++) if (block[i] !== 0) blockInNz++;
      if (blockInNz && !blockOutNz) silentBlocks++;
    }
  } finally {
    await client.dispose();
  }
  const outBuf = Buffer.concat(outputs);
  const outputSha = sha256Buf(outBuf);
  const expectedOutSha = expectedOutPath && existsSync(expectedOutPath) ? sha256Buf(readFileSync(expectedOutPath)) : expected?.completeOutputSha256 ?? null;
  return {
    sessionId,
    label: expected?.label ?? null,
    blockCount,
    inputSha256: inputSha,
    catalogInputSha256: expected?.completeInputSha256 ?? null,
    inputMatch: expected?.completeInputSha256 ? inputSha === expected.completeInputSha256 : null,
    replayOutputSha256: outputSha,
    originalOutputSha256: expectedOutSha,
    outputMatch: expectedOutSha ? outputSha === expectedOutSha : null,
    inputNonzero, outputNonzero, silentBlocks,
    pluginSilent: outputNonzero === 0 && inputNonzero > 0,
  };
}

if (manifest?.sessions) {
  for (const entry of manifest.sessions) {
    const sessionId = String(entry.sessionId ?? '');
    if (requested.size && !requested.has(sessionId) && !args.all) continue;
    const inputPath = resolveReplayFile(entry.replayFiles?.input, corpusDir);
    const outputPath = resolveReplayFile(entry.replayFiles?.output, corpusDir);
    if (!inputPath) {
      sessions.push({ sessionId, error: 'input PCM missing', silentInsert: entry.silentInsert ?? null });
      continue;
    }
    sessions.push(await replaySession(sessionId, inputPath, outputPath, catalogById[sessionId] ?? entry));
  }
} else {
  for (const session of catalog.sessions ?? []) {
    sessions.push({ sessionId: session.sessionId, error: 'original corpus directory missing; cannot replay PCM', catalog: session });
  }
}

const report = {
  helper, helperSha256: helperSha, plugin, pluginModule, pluginSha256: pluginSha,
  classId: identity.classId, name: identity.name,
  sampleRate, framesPerBlock, overlay,
  catalogRunId: catalog.runId, artifactId: catalog.artifactId,
  sessions,
  scannedErrors: scanned.errors,
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=rezfilter pcm replay::${JSON.stringify({
    helperSha, pluginSha, sessions: sessions.map(session => ({
      sessionId: session.sessionId, inputMatch: session.inputMatch, outputMatch: session.outputMatch,
      pluginSilent: session.pluginSilent, silentBlocks: session.silentBlocks, error: session.error ?? null,
    })),
  }).slice(0, 3900)}`);
}
console.log(JSON.stringify({ ok: true, outPath, sessions: sessions.length }, null, 2));
