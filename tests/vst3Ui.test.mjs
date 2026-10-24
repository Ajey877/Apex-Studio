import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstrumentRack } from '../src/components/InstrumentRack.tsx';
import { Vst3InstrumentPanel, Vst3StatusBanner } from '../src/components/Vst3InstrumentPanel.tsx';
import { reportVst3, reconcileVst3Diagnostics } from '../src/audio/nativeVst3Runtime.ts';
import { createDefaultProjectState } from '../src/state/projectState.ts';

const channel = { ...createDefaultProjectState().channels[0], instrumentType: 'vst3', vst3: {
  path: 'C:\\Plugins\\Missing.vst3', classId: '5653544D44416A6D6461206A78313000', name: 'Missing saved instrument', vendor: 'mda', version: '3.8.0',
  state: { schema: 1, classId: '5653544D44416A6D6461206A78313000', parameters: [], component: '01020304' },
} };

test('browser native UI explicitly declares unsupported playback/export while retaining the saved channel', () => {
  delete globalThis.desktopApp;
  const original = JSON.stringify(channel);
  const html = renderToStaticMarkup(React.createElement(Vst3InstrumentPanel, { channel, onUpdateChannel() { throw new Error('SSR must not publish changes'); } }));
  assert.match(html, /Windows desktop application/);
  assert.match(html, /native playback\/export is unavailable/);
  assert.doesNotMatch(html, /Scan configured folders/);
  assert.equal(JSON.stringify(channel), original);
});

test('native rack does not imply that built-in synth parameters/editors control a VST3 processor', () => {
  const html = renderToStaticMarkup(React.createElement(InstrumentRack, {
    channel, allChannels: [channel], onSelectChannel() {}, onUpdateChannel() {},
    onPreviewNote() {}, onEditSample() {},
  }));
  assert.match(html, /VST3 audition keys/);
  assert.match(html, /buffered, not zero latency/);
  assert.doesNotMatch(html, /OSCILLATOR|FILTER &amp;|SYNTH ENGINE|Fine Tune/);
});

test('native failures stay visible, but diagnostics for removed/replaced non-native channels do not outlive their project', () => {
  reportVst3(channel.id, 'VST3 plugin missing; retry or relink');
  assert.match(renderToStaticMarkup(React.createElement(Vst3StatusBanner)), /Saved instrument data is retained/);
  reconcileVst3Diagnostics([{ ...channel, instrumentType: 'minisynth' }]);
  assert.equal(renderToStaticMarkup(React.createElement(Vst3StatusBanner)), '');
});


test('packaging includes every module required by the privileged parameter bridge', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const file of ['desktop-vst3.cjs', 'native/vst3/client.mjs', 'native/vst3/service.mjs', 'native/vst3/parameters.mjs']) assert.ok(pkg.build.files.includes(file), `Missing packaged module ${file}`);
  const preload = readFileSync('preload.cjs', 'utf8'), main = readFileSync('desktop-vst3.cjs', 'utf8');
  for (const operation of ['describe', 'parameters']) { assert.ok(preload.includes(`vst3:${operation}`)); assert.ok(main.includes(`handle('${operation}'`)); }
  assert.ok(main.includes("VST3 IPC denied for untrusted frame"));
});
