// Diagnostic-only: every RezFilter trace must match exactly one host-session
// record with the same session ID, process ID, and plugin class ID.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const outPath = process.argv[3] || '';
if (!dir || !existsSync(dir)) {
  const report = { ok: false, error: `trace directory missing: ${dir || '(none)'}` };
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(report.error);
  process.exit(1);
}

function bitsToFloat(bits) {
  const value = typeof bits === 'string' ? Number.parseInt(bits, 16) : Number(bits);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE((Number.isFinite(value) ? value : 0) >>> 0, 0);
  return buf.readFloatLE(0);
}
function isFiniteNumber(value) {
  return Number.isFinite(value);
}

const files = readdirSync(dir);
const hostFiles = files.filter(name => name.startsWith('host-session-') && name.endsWith('.json'));
const traceFiles = files.filter(name => name.startsWith('rezfilter-pid-') && name.endsWith('.json'));
const hosts = [];
const mismatches = [];
for (const name of hostFiles) {
  try {
    hosts.push({ file: name, ...JSON.parse(readFileSync(path.join(dir, name), 'utf8')) });
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
    mismatches.push({ file: name, error: `trace parse failed: ${error}` });
  }
}

const usedHosts = new Set();
for (const trace of traces) {
  const sessionId = String(trace.sessionId || '');
  const pid = Number(trace.pid);
  const classId = String(trace.classId || '');
  const matches = hosts.filter(host =>
    String(host.sessionId || '') === sessionId &&
    Number(host.pid) === pid &&
    String(host.classId || '') === classId);
  if (matches.length !== 1) {
    mismatches.push({
      file: trace.file, sessionId, pid, classId,
      error: `expected exactly one host-session with same sessionId/pid/classId, found ${matches.length}`,
      hostFiles: matches.map(host => host.file),
    });
    continue;
  }
  usedHosts.add(matches[0].file);
  if (Number(trace.dropped || 0) > 0) {
    mismatches.push({
      file: trace.file, sessionId, pid,
      error: `incomplete evidence window: dropped=${trace.dropped} capacity=${trace.capacity ?? 'unknown'} count=${trace.count}`,
    });
  }
  const cutoff = trace.cutoff || {};
  const fNeg = Number(cutoff.framesFNeg || 0);
  const fNan = Number(cutoff.framesFNan || 0);
  const example = bitsToFloat(cutoff.fNegExample);
  if (fNan > 0 && fNeg > 0 && !isFiniteNumber(example)) {
    mismatches.push({ file: trace.file, error: 'NaN cutoff must not be described as a negative finite cutoff' });
  }
  if (fNeg > 0) {
    if (!isFiniteNumber(example) || !(example < 0)) {
      mismatches.push({
        file: trace.file, error: 'reported negative-cutoff frame without a corresponding finite negative value',
        fNeg, fNegExample: cutoff.fNegExample, example,
      });
    }
  }
  const outNz = Number(trace.outL?.nonzero || 0) + Number(trace.outR?.nonzero || 0);
  const last = (trace.records || []).findLast?.(rec => rec.stage === 'process-post') ||
    [...(trace.records || [])].reverse().find(rec => rec.stage === 'process-post');
  if (last) {
    const recOut = Number(last.outL?.nonzero || 0) + Number(last.outR?.nonzero || 0);
    if (outNz > 0 && recOut === 0) {
      mismatches.push({ file: trace.file, error: 'nonzero plugin output not reflected in per-channel output measurement' });
    }
  }
}

const unexplainedHosts = hosts.filter(host => !usedHosts.has(host.file) && traceFiles.length);
const report = {
  ok: mismatches.length === 0,
  dir,
  hostSessions: hosts.length,
  traces: traces.length,
  matched: usedHosts.size,
  mismatches,
  unusedHostSessions: unexplainedHosts.map(host => ({ file: host.file, sessionId: host.sessionId, pid: host.pid, classId: host.classId })),
};
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=trace integrity::${JSON.stringify({
    ok: report.ok, hostSessions: report.hostSessions, traces: report.traces, mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, 8),
  }).slice(0, 3900)}`);
}
if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, hostSessions: hosts.length, traces: traces.length }, null, 2));
