import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeCapture } from './analyze';

function visit(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? visit(join(dir, entry.name)) : entry.name.endsWith('.json.gz') ? [join(dir, entry.name)] : []);
}
const results = visit('docs/verification/capture-integrity/evidence').map(path => {
  const run = JSON.parse(gunzipSync(readFileSync(path)).toString());
  for (const r of run.records) {
    if (!r.pcm) {
      const bytes = Buffer.from(r.pcmBase64, 'base64');
      r.pcm = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readFloatLE(i * 4));
    }
  }
  const window = new Float32Array(run.endFrame - run.startFrame);
  for (const record of run.records) for (let i = 0; i < record.quantum; i++) {
    const index = record.frame + i - run.startFrame;
    if (index >= 0 && index < window.length) window[index] = record.pcm[i];
  }
  const selectedWindowSha256 = createHash('sha256').update(new Uint8Array(window.buffer)).digest('hex');
  return { path, selectedWindowSha256, browserVersion: run.browserVersion, environment: run.environment, ...analyzeCapture(run) };
});
writeFileSync('docs/verification/capture-integrity/run-ledger.json', JSON.stringify(results, null, 2));
console.log(`Reanalyzed ${results.length} raw captures; ${results.filter(r => r.passed).length} strict passes.`);
