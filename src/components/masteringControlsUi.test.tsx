/**
 * Phase 90 — Mastering Suite control bindings.
 *
 * The modal is rendered with `renderToStaticMarkup`, the same technique the
 * shell tests use, so these assertions run against the markup the app actually
 * produces rather than against a copy of it. Each control is located by its
 * `data-control-id`, and its `min`/`max`/`step`/`value` are compared against
 * `MASTERING_CONTROL_RANGES` and the state it was rendered from — so a control
 * that advertised a range the state layer would reject, or that displayed a
 * value other than the saved one, fails here.
 *
 * The write side of the binding is covered behaviourally by
 * `src/audio/masteringControls.test.ts`, which drives `applyMasteringControlChange`
 * — the exact function every `onChange` below calls.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MasteringSuiteModal } from './MasteringSuiteModal';
import type { MasteringSuiteTab } from './MasteringSuiteModal';
import {
  MASTERING_CONTROL_RANGES,
  MASTERING_CONTROL_TARGETS,
  bandRangeLabel,
} from '../audio/masteringControls';
import type { MasteringControlTarget } from '../audio/masteringControls';
import { DEFAULT_MASTERING_SUITE_STATE } from '../audio/masteringState';
import type { MasteringSuiteState } from '../types/daw';

const noop = (): void => {};

const render = (state: MasteringSuiteState, tab: MasteringSuiteTab): string =>
  renderToStaticMarkup(
    React.createElement(MasteringSuiteModal, {
      isOpen: true,
      onClose: noop,
      masteringState: state,
      onUpdateMasteringState: noop,
      isPlaying: false,
      initialTab: tab,
    })
  );

/** Pull the attributes of every element carrying a `data-control-id`. */
function controlsIn(markup: string): Map<string, Record<string, string>> {
  const found = new Map<string, Record<string, string>>();
  const tagPattern = /<(input|button)\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(markup)) !== null) {
    const attrs = match[2];
    const id = /data-control-id="([^"]+)"/.exec(attrs)?.[1];
    if (!id) continue;
    const record: Record<string, string> = {};
    const attrPattern = /([\w-]+)="([^"]*)"/g;
    let attr: RegExpExecArray | null;
    while ((attr = attrPattern.exec(attrs)) !== null) record[attr[1]] = attr[2];
    found.set(id, record);
  }
  return found;
}

/** A state with values distinct from the defaults, so bindings are observable. */
const CUSTOM_STATE: MasteringSuiteState = {
  ...DEFAULT_MASTERING_SUITE_STATE,
  lowCrossFreq: 240,
  highCrossFreq: 7200,
  maximizerRelease: 190,
  lowBand: { ...DEFAULT_MASTERING_SUITE_STATE.lowBand, attack: 33, release: 210, knee: 8.5, solo: true },
  midBand: { ...DEFAULT_MASTERING_SUITE_STATE.midBand, attack: 7, release: 95, knee: 1.5, mute: true },
  highBand: { ...DEFAULT_MASTERING_SUITE_STATE.highBand, attack: 55, release: 400, knee: 11 },
};

describe('Phase 90 — every exposed mastering control renders with its real range and value', () => {
  const multiband = controlsIn(render(CUSTOM_STATE, 'multiband'));
  const maximizer = controlsIn(render(CUSTOM_STATE, 'maximizer'));
  const all = new Map([...multiband, ...maximizer]);

  it('renders all twelve Phase 90 controls', () => {
    for (const target of MASTERING_CONTROL_TARGETS) {
      assert.ok(all.has(target), `no control rendered for ${target}`);
      assert.equal(all.get(target)?.type, 'range', `${target} must be a range input`);
    }
    assert.equal(
      multiband.size,
      2 + 3 * 8,
      '2 crossovers + 3 bands × (threshold, gain, ratio, attack, release, knee, solo, mute)'
    );
  });

  it('advertises min/max/step from MASTERING_CONTROL_RANGES, never its own numbers', () => {
    for (const target of MASTERING_CONTROL_TARGETS) {
      const range = (target === 'lowCrossFreq' || target === 'highCrossFreq' || target === 'maximizerRelease'
        ? MASTERING_CONTROL_RANGES[target]
        : MASTERING_CONTROL_RANGES[
            target.endsWith('.attack') ? 'bandAttack' : target.endsWith('.release') ? 'bandRelease' : 'bandKnee'
          ]) as { min: number; max: number; step: number };
      const el = all.get(target as MasteringControlTarget)!;
      assert.equal(Number(el.min), range.min, `${target} min`);
      assert.equal(Number(el.max), range.max, `${target} max`);
      assert.equal(Number(el.step), range.step, `${target} step`);
    }
  });

  it('displays the saved value of every control', () => {
    const expected: Record<string, number> = {
      lowCrossFreq: CUSTOM_STATE.lowCrossFreq,
      highCrossFreq: CUSTOM_STATE.highCrossFreq,
      maximizerRelease: CUSTOM_STATE.maximizerRelease,
      'lowBand.attack': CUSTOM_STATE.lowBand.attack,
      'lowBand.release': CUSTOM_STATE.lowBand.release,
      'lowBand.knee': CUSTOM_STATE.lowBand.knee,
      'midBand.attack': CUSTOM_STATE.midBand.attack,
      'midBand.release': CUSTOM_STATE.midBand.release,
      'midBand.knee': CUSTOM_STATE.midBand.knee,
      'highBand.attack': CUSTOM_STATE.highBand.attack,
      'highBand.release': CUSTOM_STATE.highBand.release,
      'highBand.knee': CUSTOM_STATE.highBand.knee,
    };
    for (const [target, value] of Object.entries(expected)) {
      assert.equal(Number(all.get(target)!.value), value, `${target} should render its saved value`);
    }
  });

  it('gives every control an accessible name', () => {
    for (const [target, el] of all) {
      assert.ok(el['aria-label'] && el['aria-label'].length > 0, `${target} has no aria-label`);
    }
  });

  it('shows solo and mute as pressed-state toggles reflecting the saved flags', () => {
    assert.equal(multiband.get('lowBand.solo')?.['aria-pressed'], 'true', 'the saved low solo is shown as active');
    assert.equal(multiband.get('lowBand.mute')?.['aria-pressed'], 'false');
    assert.equal(multiband.get('midBand.mute')?.['aria-pressed'], 'true', 'the saved mid mute is shown as active');
    assert.equal(multiband.get('midBand.solo')?.['aria-pressed'], 'false');
    assert.equal(multiband.get('highBand.solo')?.['aria-pressed'], 'false');
    assert.equal(multiband.get('highBand.mute')?.['aria-pressed'], 'false');
  });

  it('keeps the pre-existing band controls working alongside the new ones', () => {
    for (const band of ['lowBand', 'midBand', 'highBand']) {
      for (const field of ['threshold', 'gain', 'ratio']) {
        const el = multiband.get(`${band}.${field}`);
        assert.ok(el, `${band}.${field} control is missing`);
        assert.equal(Number(el!.value), CUSTOM_STATE[band as 'lowBand'][field as 'threshold'], `${band}.${field} value`);
      }
    }
  });
});

describe('Phase 90 — band headers follow the crossovers instead of hard-coding a range', () => {
  it('labels each band with the range the crossovers actually produce', () => {
    const markup = render(CUSTOM_STATE, 'multiband');
    for (const band of ['lowBand', 'midBand', 'highBand'] as const) {
      const label = bandRangeLabel(CUSTOM_STATE, band);
      assert.ok(markup.includes(label), `band header must show the derived range "${label}"`);
    }
  });

  it('changes the band labels when the crossovers change', () => {
    const narrow = render({ ...CUSTOM_STATE, lowCrossFreq: 80, highCrossFreq: 1800 }, 'multiband');
    const wide = render({ ...CUSTOM_STATE, lowCrossFreq: 500, highCrossFreq: 16000 }, 'multiband');
    assert.ok(narrow.includes('LOW BAND (20 Hz – 80 Hz)'), `expected the narrow low band label in: ${narrow.match(/LOW BAND \([^)]*\)/)?.[0]}`);
    assert.ok(wide.includes('LOW BAND (20 Hz – 500 Hz)'));
    assert.ok(narrow.includes('MID BAND (80 Hz – 1.80 kHz)'));
    assert.ok(wide.includes('MID BAND (500 Hz – 16.0 kHz)'));
  });

  it('no longer ships the stale hard-coded band ranges', () => {
    const markup = render(DEFAULT_MASTERING_SUITE_STATE, 'multiband');
    for (const stale of ['20 - 150 Hz', '150Hz - 3.5kHz', '3.5k - 20kHz']) {
      assert.ok(!markup.includes(stale), `stale hard-coded band range still rendered: ${stale}`);
    }
  });

  it('reports whether each band will be heard', () => {
    const markup = render(CUSTOM_STATE, 'multiband');
    // Low is soloed, mid is muted, high is unsoloed while another band is soloed.
    assert.equal((markup.match(/AUDIBLE/g) ?? []).length, 1, 'only the soloed low band is audible');
    assert.equal((markup.match(/SILENCED/g) ?? []).length, 2, 'the muted mid band and unsoloed high band are silenced');
  });
});

describe('Phase 90 — the maximizer tab exposes release without overclaiming', () => {
  const markup = render(CUSTOM_STATE, 'maximizer');

  it('renders the release control next to threshold and ceiling', () => {
    const maximizer = controlsIn(markup);
    assert.equal(Number(maximizer.get('maximizerRelease')!.value), CUSTOM_STATE.maximizerRelease);
    assert.ok(markup.includes('Maximizer Threshold (Drive)'));
    assert.ok(markup.includes('True Peak Ceiling'));
  });

  it('keeps the honest lookahead disclosure intact', () => {
    assert.ok(markup.includes('No delay — attack 1 ms on / 5 ms off'), 'the lookahead limitation must stay disclosed');
    assert.ok(markup.includes('no true-peak lookahead buffer'));
    assert.ok(markup.includes('This is compressor release, not lookahead'), 'the new control must not read as a lookahead limiter');
  });
});
