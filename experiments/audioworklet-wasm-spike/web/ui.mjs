// Harness UI for manual / local benchmark runs (kept out of index.html so it
// also loads under the strict production CSP, which forbids inline scripts).
import { runAll } from './harness.mjs';
const $ = id => document.getElementById(id);
let last = null;
const opts = () => {
  const instances = Number($('instances').value), seconds = Number($('seconds').value), lagThresholdMs = Number($('lag').value);
  return { sustainedLive: { instances, seconds, lagThresholdMs }, offlineThroughput: { instances } };
};
const go = async tests => {
  $('out').textContent = 'Running…';
  $('summary').innerHTML = '';
  last = await runAll({ ...opts(), tests, onProgress: r => {
    $('summary').insertAdjacentHTML('beforeend', `<div class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'PASS' : 'FAIL'} — ${r.name} [${r.kind}] (${r.durationMs} ms)</div>`);
  } });
  $('out').textContent = JSON.stringify(last, null, 2);
  $('download').disabled = false;
};
$('run').onclick = () => go(undefined);
$('runLive').onclick = () => go(['capabilities', 'sustainedLive']);
$('download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(last, null, 2)], { type: 'application/json' }));
  a.download = `apex-spike-results-${Date.now()}.json`;
  a.click();
};
