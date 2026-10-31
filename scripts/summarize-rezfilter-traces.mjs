// Diagnostic-only: print per-instance RezFilter JSON traces without overwriting them.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'build/native-evidence/rezfilter-traces';
const outPath = process.argv[3] || '';
if (!existsSync(dir)) {
  console.log('no RezFilter per-instance traces');
  process.exit(0);
}

function bitsToFloat(bits) {
  const value = typeof bits === 'string' ? Number.parseInt(bits, 16) : Number(bits);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE((Number.isFinite(value) ? value : 0) >>> 0, 0);
  return buf.readFloatLE(0);
}

const files = readdirSync(dir).filter(name => name.startsWith('rezfilter-pid-') && name.endsWith('.json'));
const traces = [];
for (const name of files) {
  const full = path.join(dir, name);
  if (!statSync(full).isFile()) continue;
  try {
    const json = JSON.parse(readFileSync(full, 'utf8'));
    const recs = json.records ?? json.recs ?? [];
    const first = recs.find(rec => rec.stage === 'process-pre') ?? recs[0];
    const last = [...recs].reverse().find(rec => rec.stage === 'process-post') ?? recs[recs.length - 1];
    traces.push({
      file: name,
      sessionId: json.sessionId,
      classId: json.classId,
      instanceGen: json.instanceGen,
      pid: json.pid,
      recs: recs.length,
      dropped: json.dropped,
      flushed: json.flushed,
      silenceOrigin: json.silenceOrigin,
      cutoff: json.cutoff,
      inL: json.inL, inR: json.inR, outL: json.outL, outR: json.outR,
      firstStage: first?.stage ?? null,
      lastStage: last?.stage ?? null,
      first: first ? {
        stage: first.stage, block: first.block, sequence: first.sequence,
        env: bitsToFloat(first.env_bits ?? first.env), phi: bitsToFloat(first.phi_bits ?? first.phi),
        fff: bitsToFloat(first.fff_bits ?? first.fff), fenv: bitsToFloat(first.fenv_bits ?? first.fenv),
        flfo: bitsToFloat(first.flfo_bits ?? first.flfo), buf0: bitsToFloat(first.buf0_bits ?? first.buf0),
        framesFNeg: first.framesFNeg, framesIZero: first.framesIZero,
        inL: first.inL, inR: first.inR, outL: first.outL, outR: first.outR,
      } : null,
      last: last ? {
        stage: last.stage, block: last.block, sequence: last.sequence,
        env: bitsToFloat(last.env_bits ?? last.env), phi: bitsToFloat(last.phi_bits ?? last.phi),
        fff: bitsToFloat(last.fff_bits ?? last.fff), fenv: bitsToFloat(last.fenv_bits ?? last.fenv),
        framesFNeg: last.framesFNeg, framesIZero: last.framesIZero,
        inL: last.inL, inR: last.inR, outL: last.outL, outR: last.outR,
      } : null,
    });
  } catch (error) {
    traces.push({ file: name, error: String(error) });
  }
}

const hostMaps = readdirSync(dir).filter(name => name.startsWith('host-session-')).map(name => {
  try { return JSON.parse(readFileSync(path.join(dir, name), 'utf8')); }
  catch (error) { return { file: name, error: String(error) }; }
});

const summary = { dir, files: files.length, traces, hostMaps };
if (outPath) writeFileSync(outPath, JSON.stringify(summary, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=RezFilter per-instance traces::${JSON.stringify({
    files: files.length,
    traces: traces.map(trace => ({
      file: trace.file, sessionId: trace.sessionId, gen: trace.instanceGen, pid: trace.pid,
      recs: trace.recs, cutoff: trace.cutoff, first: trace.first, last: trace.last, error: trace.error ?? null,
    })),
  }).slice(0, 3900)}`);
} else {
  console.log(JSON.stringify(summary, null, 2));
}
