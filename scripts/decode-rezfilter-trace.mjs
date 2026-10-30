import { readFileSync, existsSync } from 'node:fs';

function bitsToFloat(hex) {
  const bits = Number.parseInt(hex, 16);
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, bits, true);
  return new DataView(buf).getFloat32(0, true);
}

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.log('no RezFilter internal-state trace');
  process.exit(0);
}
const raw = JSON.parse(readFileSync(path, 'utf8'));
const decoded = (raw.records || []).map(record => {
  const floats = {};
  for (const key of ['env', 'env2', 'phi', 'bufl', 'buf0', 'buf1', 'buf2', 'fff', 'fenv', 'flfo', 'dphi', 'fq', 'fg', 'fmax', 'att', 'rel', 'tthr', 'p0', 'p1', 'p3', 'p6', 'p8', 'p9']) {
    if (record[key]) floats[key] = { bits: record[key], value: bitsToFloat(record[key]) };
  }
  return { ...record, floats };
});
const summary = {
  count: raw.count,
  stages: decoded.map(r => r.stage),
  firstProcess: decoded.find(r => String(r.stage).includes('first-process')),
  construct: decoded.find(r => r.stage === 'construct'),
  setActive: decoded.filter(r => String(r.stage).startsWith('setActive')),
  setProcessing: decoded.filter(r => String(r.stage).startsWith('setProcessing')),
};
console.log(JSON.stringify({ summary, decoded: decoded.slice(0, 24) }, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=RezFilter internal state::${JSON.stringify(summary).slice(0, 3900)}`);
}
