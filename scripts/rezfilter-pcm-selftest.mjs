// Diagnostic-only: known nonzero stereo must be visible in host and plugin traces.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const helper = process.argv[2];
const plugin = process.argv[3];
const outPath = process.argv[4] || 'build/native-evidence/pcm-selftest.json';
if (!helper || !existsSync(helper) || !plugin || !existsSync(plugin)) {
  throw new Error('helper and plugin paths are required');
}
const { NativeVst3Client, discoverVst3 } = await import(pathToFileURL(path.resolve('native/vst3/client.mjs')).href);
const scanned = await discoverVst3(helper, [path.resolve(plugin)], { kind: 'effect' });
const identity = scanned.plugins.find(item => /rezfilter/i.test(item.name || ''));
if (!identity) throw new Error('mda RezFilter not found');
const sessionId = randomUUID();
const traceDir = path.resolve('build/native-evidence/pcm-selftest-traces');
rmSync(traceDir, { recursive: true, force: true });
mkdirSync(traceDir, { recursive: true });
process.env.APEX_REZFILTER_TRACE_DIR = traceDir;
process.env.APEX_REZFILTER_SESSION_ID = sessionId;

const frames = 1024;
const samples = new Float32Array(frames * 2);
for (let i = 0; i < frames; i++) {
  samples[i] = i % 8 === 0 ? 0.25 : 0;
  samples[frames + i] = i % 8 === 4 ? -0.5 : 0;
}
const leftNz = [...samples.subarray(0, frames)].filter(value => value !== 0).length;
const rightNz = [...samples.subarray(frames)].filter(value => value !== 0).length;
const client = new NativeVst3Client(helper, { timeoutMs: 15000, diagnosticSessionId: sessionId });
let hostTrace = null;
try {
  await client.open(identity, {
    sampleRate: 48000, mode: 'realtime', kind: 'effect', diagnosticSessionId: sessionId,
    state: { schema: 1, classId: identity.classId, parameters: [
      { id: 0, value: 0.8 }, { id: 1, value: 0.25 }, { id: 3, value: 0.5 },
      { id: 6, value: 0.5 }, { id: 8, value: 0 }, { id: 9, value: 1 },
    ] },
  });
  const result = await client.processAudio(frames, samples, [], 120, true);
  hostTrace = result.processTrace ?? null;
} finally {
  await client.dispose();
}

const pluginTraces = readdirSync(traceDir).filter(name => name.startsWith('rezfilter-pid-'));
const selftests = readdirSync(traceDir).filter(name => name.startsWith('pcm-selftest-'));
const hosts = readdirSync(traceDir).filter(name => name.startsWith('host-session-'));
const errors = [];
if (leftNz === 0 || rightNz === 0) errors.push('control stimulus is not nonzero stereo');
if (!hostTrace) errors.push('host processTrace missing');
if (hostTrace && Number(hostTrace.inputLeft?.nonzero) !== leftNz) {
  errors.push(`host input left nonzero ${hostTrace.inputLeft?.nonzero} != ${leftNz}`);
}
if (hostTrace && Number(hostTrace.inputRight?.nonzero) !== rightNz) {
  errors.push(`host input right nonzero ${hostTrace.inputRight?.nonzero} != ${rightNz}`);
}
if (hostTrace && Number(hostTrace.processorInputLeft?.nonzero) !== leftNz) {
  errors.push(`processor input left nonzero ${hostTrace.processorInputLeft?.nonzero} != ${leftNz}`);
}
if (pluginTraces.length !== 1) errors.push(`expected one plugin trace, found ${pluginTraces.length}`);
if (hosts.length !== 1) errors.push(`expected one host-session map, found ${hosts.length}`);
let pluginRec = null;
let summed = { inL: 0, inR: 0, outL: 0, outR: 0 };
if (pluginTraces.length) {
  const json = JSON.parse(readFileSync(path.join(traceDir, pluginTraces[0]), 'utf8'));
  const recs = json.records || [];
  const pres = recs.filter(rec => rec.stage === 'process-pre');
  pluginRec = pres.find(rec => Number(rec.inL?.nonzero) > 0 || Number(rec.inR?.nonzero) > 0) || pres[0];
  for (const rec of pres) {
    summed.inL += Number(rec.inL?.nonzero || 0);
    summed.inR += Number(rec.inR?.nonzero || 0);
  }
  for (const rec of recs.filter(rec => rec.stage === 'process-post')) {
    summed.outL += Number(rec.outL?.nonzero || 0);
    summed.outR += Number(rec.outR?.nonzero || 0);
  }
  if (json.sessionId !== sessionId) errors.push(`plugin sessionId ${json.sessionId} != ${sessionId}`);
  if (Number(json.dropped || 0) > 0) errors.push(`control session dropped ${json.dropped} records`);
  if (hosts.length) {
    const host = JSON.parse(readFileSync(path.join(traceDir, hosts[0]), 'utf8'));
    if (host.sessionId !== json.sessionId || Number(host.pid) !== Number(json.pid) || host.classId !== json.classId) {
      errors.push('plugin trace does not match host-session sessionId/pid/classId');
    }
  }
  if (summed.inL === 0 && summed.inR === 0) errors.push('plugin trace reports zero input on a known audible control session');
  if (summed.inL !== leftNz) errors.push(`plugin summed process-pre left nonzero ${summed.inL} != ${leftNz}`);
  if (summed.inR !== rightNz) errors.push(`plugin summed process-pre right nonzero ${summed.inR} != ${rightNz}`);
  if (summed.inL === leftNz + rightNz && summed.inR === 0) {
    errors.push('plugin trace appears to have summed stereo before counting nonzero');
  }
}
if (!selftests.length) errors.push('plugin measurement self-test file missing');
else {
  const self = JSON.parse(readFileSync(path.join(traceDir, selftests[0]), 'utf8'));
  if (!self.ok) errors.push(`plugin measurement self-test failed: ${self.error}`);
}

const report = {
  ok: errors.length === 0,
  sessionId, helperPid: client.pid, leftNz, rightNz, hostTrace, pluginRec,
  pluginTraces, hosts, selftests, errors,
  helperSha256: createHash('sha256').update(readFileSync(helper)).digest('hex'),
};
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=pcm selftest::${JSON.stringify({ ok: report.ok, errors, leftNz, rightNz }).slice(0, 3900)}`);
}
if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, leftNz, rightNz }, null, 2));
