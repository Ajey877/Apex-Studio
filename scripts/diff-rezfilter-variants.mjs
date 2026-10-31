// Diagnostic-only: prove A/B/C generated RezFilter sources are distinct as labeled.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = process.argv[2] || 'build/native-vst3';
const outPath = process.argv[3] || '';
const files = {
  A: `${root}/generated-mdaRezFilter-upstream.cpp`,
  B: `${root}/generated-mdaRezFilter-fixture.cpp`,
  C: `${root}/generated-mdaRezFilter-fixture-trace.cpp`,
};
const missing = Object.entries(files).filter(([, path]) => !existsSync(path)).map(([id, path]) => ({ id, path }));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const errors = [];
if (missing.length) errors.push({ error: 'generated variant source missing', missing });
else {
  const text = Object.fromEntries(Object.entries(files).map(([id, path]) => [id, readFileSync(path, 'utf8')]));
  const hashes = Object.fromEntries(Object.entries(files).map(([id, path]) => [id, sha(path)]));
  if (text.A.includes('env=0.f; env2=0.f; phi=0.f;')) errors.push({ error: 'variant A is not unmodified upstream MDA' });
  if (!text.B.includes('env=0.f; env2=0.f; phi=0.f; bufl=0.f; ttrig=0; tatt=0; buf0=0.f;')) {
    errors.push({ error: 'variant B is missing the candidate fixture assignment' });
  }
  if (text.B.includes('APEX_REZ_SNAP') || text.B.includes('apexRezTrace')) {
    errors.push({ error: 'variant B must have tracing disabled' });
  }
  if (!text.C.includes('APEX_REZ_SNAP') || !text.C.includes('apexRezMeasureInputs')) {
    errors.push({ error: 'variant C must include read-only tracing and per-channel input measurement' });
  }
  if (text.C.includes('apexRezAccumIn(')) errors.push({ error: 'variant C must not count summed stereo input' });
  if (hashes.A === hashes.B) errors.push({ error: 'A and B must differ; do not describe B as unmodified upstream' });
  if (hashes.B === hashes.C) errors.push({ error: 'B and C must differ by tracing only' });
  const report = { hashes, sdkImmutable: !text.A.includes('apexRez'), errors };
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2));
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::notice title=RezFilter generated source variants::${JSON.stringify(report).slice(0, 3900)}`);
  }
  if (errors.length) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, hashes }, null, 2));
  process.exit(0);
}
if (outPath) writeFileSync(outPath, JSON.stringify({ ok: false, errors }, null, 2));
console.error(JSON.stringify({ ok: false, errors }, null, 2));
process.exit(1);
