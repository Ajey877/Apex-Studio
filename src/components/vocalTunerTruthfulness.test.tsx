import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VocalTunerModal } from './VocalTunerModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { VocalTunerSettings } from '../types/daw';

/** Source with comments stripped, so prose about a defect is not mistaken for the defect. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const moduleSource = stripComments(
  readFileSync(path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'VocalTunerModal.tsx'), 'utf8')
);

const settings: VocalTunerSettings = {
  enabled: true,
  scale: 'minor',
  rootKey: 0,
  retuneSpeedMs: 15,
  formantShift: 0,
  vibratoDepth: 0.2,
  humanize: 0.3,
};

const render = (overrides: Partial<VocalTunerSettings> = {}): string =>
  renderToStaticMarkup(
    React.createElement(VocalTunerModal, {
      isOpen: true,
      onClose: () => {},
      vocalTunerSettings: { ...settings, ...overrides },
      onUpdateVocalTuner: () => {},
      channels: DEFAULT_PROJECT.channels,
    })
  );

describe('Phase 52 — Vocal Tuner has no fabricated pitch measurement', () => {
  it('does not simulate a detected pitch with a sine animation', () => {
    // Math.round for percentage labels is formatting, not synthesis; the ban is
    // on the trig/random primitives a generated pitch curve would need.
    assert.ok(!/Math\.sin/.test(moduleSource), 'the tuner must not fabricate pitch with Math.sin');
    assert.ok(!/Math\.cos/.test(moduleSource), 'the tuner must not fabricate pitch with Math.cos');
    assert.ok(!/Math\.random/.test(moduleSource), 'the tuner must not fabricate pitch with Math.random');
    assert.ok(!/requestAnimationFrame/.test(moduleSource), 'the tuner must not animate a fake needle');
    assert.ok(!/setDetectedPitch|detectedPitch/.test(moduleSource), 'no detected-pitch state may exist');
    assert.ok(!/targetSnapNote/.test(moduleSource), 'no snapped-note readout may exist');
  });

  it('does not open or imply a live microphone it never uses', () => {
    assert.ok(
      !/getUserMedia|MediaStream|isLiveMicActive/.test(moduleSource),
      'the tuner must not claim microphone analysis'
    );
  });

  it('does not render a detected note, frequency or cents value', () => {
    const html = render();
    assert.ok(!/Detected:/.test(html), 'no "Detected:" readout may be rendered');
    assert.ok(!/\d+\s*Hz/.test(html), 'no frequency measurement may be rendered');
    assert.ok(html.includes('PITCH DETECTION UNAVAILABLE'), 'the unavailable state must be rendered');
  });

  it('states that no pitch correction is applied to audio', () => {
    const html = render();
    assert.ok(/NOT APPLIED/i.test(html), 'the tuner must say its processing is not applied');
    assert.ok(
      !/>\s*ACTIVE\s*</.test(html),
      'an ACTIVE badge would imply a processor in the signal path'
    );
  });

  it('keeps the same message whether the tuner is enabled or bypassed', () => {
    // `enabled` changes nothing in the engine, so the UI must not present it as
    // a working bypass switch.
    const on = render({ enabled: true });
    const off = render({ enabled: false });
    assert.ok(/NOT APPLIED/i.test(on));
    assert.ok(/NOT APPLIED/i.test(off));
    assert.ok(!/>\s*ACTIVE\s*</.test(on));
  });
});

describe('Phase 52 — Vocal Tuner keeps its persisted settings', () => {
  it('still renders the stored scale and key so the settings survive the truth pass', () => {
    const html = render({ rootKey: 7, scale: 'dorian' });
    assert.ok(html.includes('G'), 'the root key control must still render');
    assert.ok(html.includes('Dorian'), 'the scale control must still render');
  });

  it('keeps the retune, formant, vibrato and humanize controls', () => {
    const html = render();
    for (const label of ['RETUNE', 'FORMANT', 'VIBRATO', 'HUMANIZE']) {
      assert.ok(html.toUpperCase().includes(label), `${label} control must be preserved`);
    }
  });
});
