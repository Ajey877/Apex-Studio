import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeMixerMeterLevel } from './Mixer';

/**
 * Phase 45 metering UI guards.
 *
 * `computeMixerMeterLevel` is tested as behaviour (it is a pure export, the way
 * `applyMixerRoutingSelection` is). The mastering surface is checked at the
 * source boundary because its whole purpose is which strings it may show; a
 * rendered-DOM test would not catch a fabricated seed any better than this does.
 */

const MIXER_SOURCE = readFileSync(new URL('./Mixer.tsx', import.meta.url), 'utf8');
const MODAL_SOURCE = readFileSync(new URL('./MasteringSuiteModal.tsx', import.meta.url), 'utf8');

describe('Phase 45: mixer meter scaling is applied once', () => {
  it('passes the post-fader tap straight through', () => {
    // The channel analyser sits after the fader, so 0.5 in must be 0.5 out.
    assert.equal(computeMixerMeterLevel(0.5, true), 0.5);
    assert.equal(computeMixerMeterLevel(1, true), 1);
    assert.equal(computeMixerMeterLevel(0.25, true), 0.25);
  });

  it('does not apply a second -6 dB at half volume', () => {
    const raw = 0.5;
    // The defect: peak * (track.volume || 1.0) with volume 0.5 -> 0.25, i.e. a
    // meter reading 6 dB below the audio actually on the bus.
    const doubleScaled = Math.min(1.0, raw * 0.5);
    assert.notEqual(computeMixerMeterLevel(raw, true), doubleScaled);
    assert.equal(20 * Math.log10(doubleScaled / raw), -6.020599913279624);
  });

  it('goes to zero when the transport is stopped and clamps above unity', () => {
    assert.equal(computeMixerMeterLevel(0.9, false), 0);
    assert.equal(computeMixerMeterLevel(1.4, true), 1);
  });

  it('is inert on non-finite input instead of painting NaN bars', () => {
    assert.equal(computeMixerMeterLevel(Number.NaN, true), 0);
    assert.equal(computeMixerMeterLevel(-1, true), 0);
  });

  it('leaves no volume multiplication in the peak pipeline', () => {
    assert.doesNotMatch(MIXER_SOURCE, /peak \* \(t\.volume/, 'fader must not be applied twice');
    assert.doesNotMatch(MIXER_SOURCE, /getMixerTrackPeak\([^\n]*\)[^\n]*\* \(/);
    assert.match(MIXER_SOURCE, /computeMixerMeterLevel\(audioEngine\.getMixerTrackPeak\(t\.id\), isPlaying\)/);
  });
});

describe('Phase 45: mastering modal readouts', () => {
  it('renders em-dashes for unmeasured values rather than a number', () => {
    assert.match(MODAL_SOURCE, /value === null \|\| value === undefined \? '—'/);
    assert.match(MODAL_SOURCE, /NOT MEASURED/);
    assert.match(MODAL_SOURCE, /measurement\?\.shortTermReady \? formatDb\(measurement\?\.shortTermLufs\) : '—'/);
  });

  it('reports the oversampling factor it actually used for true peak', () => {
    assert.match(MODAL_SOURCE, /measurement\.oversampleFactor\}× ISP/);
    assert.match(MODAL_SOURCE, /sample peak \{formatDb\(measurement\?\.samplePeakDbfs\)\} dBFS/);
    assert.doesNotMatch(MODAL_SOURCE, /CLIP DETECTED' : 'HEADROOM OK'/, 'a two-state verdict without measurement is not allowed');
  });

  it('keeps the readouts honest about the transport state', () => {
    assert.match(MODAL_SOURCE, /LAST MEASUREMENT \(TRANSPORT NOT RUNNING\)/);
    assert.match(MODAL_SOURCE, /NO SIGNAL ON MASTER BUS/);
    assert.match(MODAL_SOURCE, /UNAVAILABLE DURING OFFLINE BOUNCE/);
    assert.match(MODAL_SOURCE, /TRANSPORT: \{isPlaying \? 'PLAYING' : 'STOPPED'\}/);
    assert.match(MODAL_SOURCE, /SAMPLES UNREAD/);
  });

  it('reports the real master processing path without claiming a delivery target was achieved', () => {
    for (const label of ['3-BAND MULTIBAND COMPRESSOR', 'STEREO IMAGER / SUB-MONO', 'MAXIMIZER / BRICKWALL LIMITER']) {
      assert.ok(MODAL_SOURCE.includes(label), `${label} status missing`);
    }
    assert.match(MODAL_SOURCE, /PROCESSING ENABLED/);
    assert.match(MODAL_SOURCE, /LIVE \+ OFFLINE PATH/);
    assert.match(MODAL_SOURCE, /BYPASSED/);
    assert.doesNotMatch(MODAL_SOURCE, /NOT APPLIED/);
    assert.match(MODAL_SOURCE, /NOT MEASURED/);
  });

  it('polls the engine instead of only sampling while playing', () => {
    assert.match(MODAL_SOURCE, /const next = audioEngine\.getMasterLoudnessMetrics\(\);/);
    assert.doesNotMatch(MODAL_SOURCE, /if \(isPlaying\) \{\s*const metrics = audioEngine\.getMasterLoudnessMetrics/, 'the poll must not be gated on transport, or values freeze silently');
  });
});
