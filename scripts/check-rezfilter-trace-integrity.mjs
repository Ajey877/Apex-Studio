// Diagnostic-only: instrumented RezFilter evidence must not pass empty.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--class-id') flags.classId = argv[++i];
  else if (argv[i] === '--require-traces') flags.requireTraces = argv[++i] !== 'false';
  else if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  else positional.push(argv[i]);
}
const dir = positional[0];
const outPath = positional[1] || '';
const requireTraces = flags.requireTraces !== false;

function fail(report) {
  report.ok = false;
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=trace integrity::${JSON.stringify({
      ok: false, error: report.error, mismatches: (report.mismatches || []).slice(0, 8),
      hostSessions: report.hostSessions, traces: report.traces, expected: report.expected,
    }).slice(0, 3900)}`);
  }
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

if (!dir || !existsSync(dir)) {
  fail({ error: `trace directory missing: ${dir || '(none)'}`, hostSessions: 0, traces: 0 });
}

function bitsToFloat(bits) {
  const value = typeof bits === 'string' ? Number.parseInt(bits, 16) : Number(bits);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE((Number.isFinite(value) ? value : 0) >>> 0, 0);
  return buf.readFloatLE(0);
}

const files = readdirSync(dir);
const hostFiles = files.filter(name => name.startsWith('host-session-') && name.endsWith('.json'));
const traceFiles = files.filter(name => name.startsWith('rezfilter-pid-') && name.endsWith('.json'));
const mismatches = [];
const hosts = [];
for (const name of hostFiles) {
  try {
    const json = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    hosts.push({ file: name, ...json });
  } catch (error) {
    mismatches.push({ file: name, error: `host-session parse failed: ${error}` });
  }
}

const traces = [];
for (const name of traceFiles) {
  const full = path.join(dir, name);
  if (!statSync(full).isFile()) continue;
  try {
    const json = JSON.parse(readFileSync(full, 'utf8'));
    traces.push({ file: name, ...json });
  } catch (error) {
    mismatches.push({ file: name, error: `malformed or incomplete trace JSON: ${error}` });
  }
}

const classId = flags.classId || process.env.APEX_REZFILTER_CLASS_ID || traces.find(t => t.classId)?.classId || null;
const expectedHosts = classId
  ? hosts.filter(host => String(host.classId || '') === String(classId))
  : [];

if (requireTraces && traces.length === 0) {
  fail({
    error: 'instrumented run produced zero RezFilter traces; empty evidence is not successful validation',
    dir, hostSessions: hosts.length, traces: 0, expected: expectedHosts.length, classId, mismatches,
  });
}

if (classId && expectedHosts.length === 0 && traces.length === 0 && requireTraces) {
  fail({
    error: 'no expected RezFilter host-sessions and no plugin traces',
    dir, hostSessions: hosts.length, traces: 0, classId, mismatches,
  });
}

const usedTraceFiles = new Set();
if (classId) {
  for (const host of expectedHosts) {
    const matches = traces.filter(trace =>
      String(trace.sessionId || '') === String(host.sessionId || '') &&
      Number(trace.pid) === Number(host.pid) &&
      String(trace.classId || '') === String(host.classId || ''));
    if (matches.length === 0) {
      mismatches.push({
        sessionId: host.sessionId, pid: host.pid, classId: host.classId,
        error: 'missing plugin trace for expected RezFilter session',
      });
      continue;
    }
    if (matches.length !== 1) {
      mismatches.push({
        sessionId: host.sessionId, pid: host.pid, classId: host.classId,
        error: `duplicate traces for RezFilter session: ${matches.length}`,
        files: matches.map(trace => trace.file),
      });
    }
    for (const trace of matches) usedTraceFiles.add(trace.file);
  }
}

for (const trace of traces) {
  const recs = trace.records || [];
  if (!trace.sessionId || !trace.pid || !trace.classId || trace.instanceGen == null) {
    mismatches.push({ file: trace.file, error: 'trace missing sessionId, pid, classId, or instanceGen' });
  }
  if (Number(trace.dropped || 0) > 0) {
    mismatches.push({
      file: trace.file,
      error: `incomplete evidence window: dropped=${trace.dropped} capacity=${trace.capacity ?? 'unknown'} count=${trace.count}`,
    });
  }
  if (!recs.length || Number(trace.count || 0) === 0) {
    mismatches.push({ file: trace.file, error: 'zero-record trace' });
  }
  const processRecs = recs.filter(rec => String(rec.stage || '').startsWith('process-'));
  if (!processRecs.length) {
    mismatches.push({ file: trace.file, error: 'lifecycle-only trace; processing records were expected' });
  }
  for (const rec of processRecs) {
    const frames = Number(rec.frames || 0);
    const finite = Number(rec.framesFFinite || 0);
    const nan = Number(rec.framesFNan || 0);
    const inf = Number(rec.framesFInf || 0);
    if (frames && finite + nan + inf !== frames) {
      mismatches.push({
        file: trace.file, stage: rec.stage, block: rec.block,
        error: `cutoff accounting frames=${frames} != finite+nan+inf (${finite}+${nan}+${inf})`,
      });
    }
    const fNeg = Number(rec.framesFNeg || 0);
    if (fNeg > 0) {
      const example = bitsToFloat(rec.fNegExample);
      if (!Number.isFinite(example) || !(example < 0)) {
        mismatches.push({
          file: trace.file, error: 'negative-cutoff count without a finite-negative bit pattern',
          fNeg, fNegExample: rec.fNegExample, example,
        });
      }
    }
    if (nan > 0 && fNeg > 0 && !Number.isFinite(bitsToFloat(rec.fNegExample))) {
      mismatches.push({ file: trace.file, error: 'NaN cutoff must not be described as a negative finite cutoff' });
    }
  }
  const last = [...processRecs].reverse().find(rec => rec.stage === 'process-post');
  const outNz = Number(trace.outL?.nonzero || 0) + Number(trace.outR?.nonzero || 0);
  if (last && outNz > 0) {
    const recOut = Number(last.outL?.nonzero || 0) + Number(last.outR?.nonzero || 0);
    if (recOut === 0) {
      mismatches.push({ file: trace.file, error: 'nonzero plugin output not reflected in per-channel output measurement' });
    }
  }
  if (classId && String(trace.classId) === String(classId) && !usedTraceFiles.has(trace.file)) {
    const hostMatches = expectedHosts.filter(host =>
      String(host.sessionId) === String(trace.sessionId) &&
      Number(host.pid) === Number(trace.pid) &&
      String(host.classId) === String(trace.classId));
    if (hostMatches.length !== 1) {
      mismatches.push({
        file: trace.file, sessionId: trace.sessionId, pid: trace.pid, classId: trace.classId,
        error: `plugin trace does not have exactly one matching host-session, found ${hostMatches.length}`,
      });
    }
  }
}

const report = {
  ok: mismatches.length === 0 && (!requireTraces || traces.length > 0),
  dir, classId,
  hostSessions: hosts.length,
  expected: expectedHosts.length,
  traces: traces.length,
  matched: usedTraceFiles.size,
  mismatches,
};
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=trace integrity::${JSON.stringify({
    ok: report.ok, hostSessions: report.hostSessions, traces: report.traces,
    expected: report.expected, mismatchCount: mismatches.length, mismatches: mismatches.slice(0, 8),
  }).slice(0, 3900)}`);
}
if (!report.ok) fail(report);
console.log(JSON.stringify({ ok: true, hostSessions: hosts.length, traces: traces.length, expected: expectedHosts.length }, null, 2));
