// Diagnostic-only: classify whether original 41053753392 serialized component
// bytes exist. Never substitute another session's state.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || 'original-41053753392/extracted';
const outPath = process.argv[3] || 'build/native-evidence/original-component-state.json';
const catalog = JSON.parse(readFileSync('native/vst3/diag/original-silent-sessions-41053753392.json', 'utf8'));

function walk(dir, acc = []) {
  if (!dir || !existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const files = walk(root);
const bins = files.filter(file => file.endsWith('.bin')).map(file => {
  const buf = readFileSync(file);
  return { file, length: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
});
const hexCandidates = [];
for (const file of files.filter(name => name.endsWith('.json'))) {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const hex = json?.stateFingerprints?.rezFilterComponentHex
      || json?.rezFilterComponentHex
      || json?.plugin?.rezFilter?.component
      || json?.componentDump?.rezFilterComponent;
    if (typeof hex === 'string' && hex.length > 32 && /^[0-9a-fA-F]+$/.test(hex)) {
      const buf = Buffer.from(hex, 'hex');
      hexCandidates.push({
        file, length: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
      });
    }
  } catch { /* ignore non-evidence json */ }
}

const size536 = [...bins, ...hexCandidates].filter(item => item.length === 536);
const report = {
  exactOriginalStateReplayAvailable: false,
  reason: 'serialized component-state payload was not found as recoverable original bytes',
  catalogRunId: catalog.runId,
  artifactId: catalog.artifactId,
  searchedRoot: root,
  binCount: bins.length,
  bins: bins.slice(0, 32),
  hexCandidates: hexCandidates.slice(0, 16),
  size536,
  sessions: catalog.sessions,
};
if (size536.length) {
  report.note = '536-byte files exist but are not treated as original session state without matching catalog provenance';
}
writeFileSync(outPath, JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=original component state::${JSON.stringify({
    exactOriginalStateReplayAvailable: report.exactOriginalStateReplayAvailable,
    reason: report.reason, binCount: bins.length, size536: size536.length,
  }).slice(0, 3900)}`);
}
console.log(JSON.stringify({ exactOriginalStateReplayAvailable: false, outPath }, null, 2));
