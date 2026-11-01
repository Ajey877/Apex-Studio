// Diagnostic-only: download a GitHub Actions artifact zip without --output.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const id = process.argv[2];
const dest = process.argv[3];
if (!id || !dest) throw new Error('usage: download-gh-artifact.mjs <artifact-id> <dest.zip>');
mkdirSync(path.dirname(dest), { recursive: true });
const result = spawnSync('gh', [
  'api', '-H', 'Accept: application/vnd.github+json',
  `/repos/Ajey877/Apex-Studio/actions/artifacts/${id}/zip`,
], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
if (result.status !== 0) {
  const err = (result.stderr || result.stdout || Buffer.from('gh api failed')).toString('utf8');
  throw new Error(`artifact ${id} download failed: ${err.slice(0, 1000)}`);
}
const body = result.stdout;
if (!body || body.length < 100) throw new Error(`artifact ${id} download empty (${body?.length || 0} bytes)`);
if (body[0] !== 0x50 || body[1] !== 0x4b) {
  throw new Error(`artifact ${id} is not a zip (magic=${Buffer.from(body.subarray(0, 4)).toString('hex')})`);
}
writeFileSync(dest, body);
const size = statSync(dest).size;
if (size < 100) throw new Error(`artifact zip too small: ${size}`);
console.log(JSON.stringify({ ok: true, id, dest, bytes: size }));
