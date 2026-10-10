import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

const read = (relative: string): string => readFileSync(path.resolve(root, relative), 'utf8');

/** Every user-facing source file that can carry a product claim. */
const sourceFiles = (): string[] => {
  const walk = (dir: string, acc: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, acc);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };
  return walk(path.join(root, 'src'));
};

/**
 * Third-party product and technology names. A DAW may legitimately reference
 * compatibility formats; it may not name a vendor's engine or editor for
 * functionality it does not implement, because that reads as a shipped claim.
 */
const THIRD_PARTY_CLAIMS: ReadonlyArray<{ brand: string; reason: string }> = [
  { brand: 'Élastique', reason: 'zplane resampling technology that Apex does not implement' },
  { brand: 'elastique', reason: 'zplane resampling technology that Apex does not implement' },
  { brand: 'Melodyne', reason: 'Celemony editor that Apex does not implement' },
  { brand: 'ARA2', reason: 'Celemony/ARA plugin API that Apex does not implement' },
  { brand: 'DirectWave', reason: 'Image-Line sampler product name' },
  { brand: 'Edison', reason: 'Image-Line audio editor product name' },
];

describe('Phase 52 — product naming', () => {
  it('does not brand unimplemented features with third-party product names', () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const { brand, reason } of THIRD_PARTY_CLAIMS) {
        assert.ok(
          !source.includes(brand),
          `${path.relative(root, file)} must not use "${brand}" (${reason})`
        );
      }
    }
  });

  it('does not make legal claims about licensing or certification', () => {
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      assert.ok(
        !/licensed (by|from)|certified|trademark of|official(ly)? (licen|certif)/i.test(source),
        `${path.relative(root, file)} must not assert a legal or certification claim`
      );
    }
  });
});

describe('Phase 52 — README matches the implementation', () => {
  const readme = read('README.md');

  it('does not claim wavetable oscillators the engine does not have', () => {
    assert.ok(
      !/wavetable oscillator/i.test(readme),
      'the README must not claim wavetable oscillators; the engine has no PeriodicWave'
    );
  });

  it('describes the synth with the oscillators it actually builds', () => {
    // The honest wording is "dual-oscillator subtractive synth". The invariant
    // is that the README names the voice the engine really builds (two standard
    // oscillators, subtractive) and says outright that no wavetable engine
    // exists, instead of implying one ships.
    assert.match(readme, /dual[- ]oscillator/i);
    assert.match(readme, /subtractive/i);
    assert.match(
      readme,
      /no wavetable engine|not implemented in engine/i,
      'README must deny a wavetable engine rather than implying one is present'
    );
  });

  it('keeps the working capabilities it already documented', () => {
    for (const capability of [
      /Channel Rack/i,
      /Piano Roll/i,
      /Playlist Arranger/i,
      /Mixer/,
      /Recording/i,
      /Export/i,
    ]) {
      assert.match(readme, capability, `README must still document ${capability}`);
    }
  });

  it('records which advanced surfaces are not production DSP', () => {
    const lines = readme.split('\n');
    const disclosedAsNotProductionDsp =
      /prototype|demo|not implemented|not applied|stored intent|preview surface|seeded|static/i;

    // The surfaces the README is contracted to disclose. Each must be named
    // *and* named as something other than production DSP — a bare mention is
    // not a disclosure.
    for (const surface of [/Vocal Tuner/i, /Warp Processor/i, /Take Comping/i, /Wavetable Synth/i, /Polyphonic Blob Editor/i]) {
      const mentions = lines.filter((line) => surface.test(line));
      assert.ok(
        mentions.length > 0,
        `README must state the status of ${surface} instead of leaving it unmentioned`
      );
      assert.ok(
        mentions.some((line) => disclosedAsNotProductionDsp.test(line)),
        `README must disclose ${surface} as not production DSP, not merely mention it`
      );
    }

    // The restored Feature status section distinguishes these surfaces from
    // the working capabilities instead of using the newer transparency section.
    assert.match(
      readme,
      /in the app but not wired into the audio engine yet/i,
      'README must keep the explicit distinction between these surfaces and engine capabilities'
    );

    // A prototype surface must never be upgraded to a shipped status in the
    // capability table.
    for (const surface of [/Vocal Tuner/i, /Warp Processor/i, /Wavetable/i, /Take comping/i, /Polyphonic/i]) {
      for (const line of lines) {
        if (!surface.test(line)) continue;
        assert.ok(
          !/\|\s*(?:implemented|complete|done|verified|full)\s*\|/i.test(line),
          `README must not present ${surface} as implemented: "${line.trim()}"`
        );
      }
    }
  });

  it('keeps its unfinished-feature disclosure and makes no marketing overclaim', () => {
    assert.match(readme, /Features that are not production-ready are not presented as finished/i);
    // A superlative is allowed only inside a sentence that denies it — the
    // README may say it is *not* a fully featured professional DAW, but must
    // never market itself as one.
    const superlative = /best DAW|better than FL Studio|fully featured|industry[- ]standard/i;
    for (const line of readme.split('\n')) {
      if (!superlative.test(line)) continue;
      assert.ok(
        /\bnot\b|\bno\b|never/i.test(line),
        `README must not market the project above its verified status: "${line.trim()}"`
      );
    }
  });

  it('keeps the no-AI statement, and no UI string contradicts it', () => {
    // The restored README explicitly denies active AI capabilities; a blanket
    // ban on mentioning AI generation would incorrectly reject that disclosure.
    assert.match(readme, /does not include active AI generation, AI stem separation, or an AI API integration/i);
    assert.ok(
      !/artificial intelligence|machine learning|neural network/i.test(readme),
      'README must not claim AI/ML capability the product does not have'
    );
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      assert.ok(!/AI Smart|AI-powered|AI generated/i.test(source), `${path.relative(root, file)} must not claim AI`);
    }
  });
});

describe('Phase 52 — truthful not-applied states', () => {
  it('Mastering Suite accurately reports its implemented processing path', () => {
    const source = read('src/components/MasteringSuiteModal.tsx');
    assert.ok(source.includes('PROCESSING ENABLED'));
    assert.ok(source.includes('LIVE + OFFLINE PATH'));
    assert.ok(source.includes('BYPASSED'));
    assert.ok(!source.includes('NO PROCESSING IN SIGNAL PATH'));
    assert.ok(!/\\bGR\\b/.test(source.replace(/NOT MEASURED/g, '')), 'no bare gain-reduction readout');
  });

  it('Polyphonic editor declares its demo blobs are not source-audio analysis', () => {
    const source = read('src/components/PolyphonicEditorModal.tsx');
    assert.match(source, /NOT APPLIED|PROTOTYPE|DEMO/i);
    assert.ok(!/Phase-Locked Resampling Active/i.test(source));
  });

  it('Phase 1M: Take Comping is a real feature connected to project data', () => {
    const source = read('src/components/TakeCompingModal.tsx');
    // The modal now receives real playlist clips from project state
    assert.ok(source.includes('playlistClips: PlaylistClip[]'), 'the modal must accept real clips');
    // It uses the take manager to resolve groups
    assert.ok(source.includes('getTakeGroupIds'), 'the modal must use the take manager');
    // It allows selecting the active take
    assert.ok(source.includes('onSelectActiveTake'), 'the modal must expose take selection');
    // No demo labels
    assert.ok(!/DEMO|PROTOTYPE|INCOMPLETE/i.test(source), 'the modal is no longer a demo');
  });

  it('Warp processor describes repitch only', () => {
    const source = read('src/components/WarpAudioProcessorModal.tsx');
    assert.match(source, /REPITCH|playback rate|playback-rate/i);
    assert.ok(!/granular|formant|transient warp|time-stretch/i.test(source));
  });

  it('Wavetable surface stops claiming a wavetable oscillator', () => {
    const source = read('src/components/WavetableSynthModal.tsx');
    assert.ok(!/256-FRAME/i.test(source));
    assert.ok(!/Real-time Wavetable Osc Routing active/i.test(source));
    assert.match(source, /NOT APPLIED|PREVIEW|not (yet )?wired|subtractive/i);
  });

  it('Vocal Tuner states that no pitch processing is applied', () => {
    // In addition to the restored README disclosure, the modal must keep
    // saying its settings are stored intent and that
    // no pitch analysis or correction is in the signal path. (The ban on
    // fabricated readouts — Math.sin, "Detected:", Hz — is enforced separately
    // by src/components/vocalTunerTruthfulness.test.tsx, which strips comments
    // before asserting so prose about the removed defect is not mistaken for
    // the defect itself.)
    const source = read('src/components/VocalTunerModal.tsx');
    assert.ok(source.includes('NOT APPLIED'), 'the tuner must say its processing is not applied');
    assert.match(source, /NO PITCH ANALYSIS IN SIGNAL PATH|NO PROCESSING IN SIGNAL PATH/);
  });

  it('Sidechain drops its lookahead claim', () => {
    const source = read('src/components/SidechainRoutingModal.tsx');
    assert.ok(!/lookahead/i.test(source));
  });

  it('transport tooltips describe implemented behaviour', () => {
    const source = read('src/components/TransportToolsMenu.tsx');
    assert.ok(!/multiband processing and limiter/i.test(source));
    assert.ok(!/Advanced time-stretch and transient warp modes/i.test(source));
    assert.ok(!/Real-time auto-pitch and pitch correction/i.test(source));
    assert.ok(!/3D wavetable morphing synthesizer/i.test(source));
    assert.ok(!/7-band/i.test(source));
  });

  it('the Gross Beat menu entry names the amplitude gate it opens', () => {
    // Phase 57: this entry used to be labelled "Time FX" with a "tape-stop
    // brake" tooltip. The engine implements neither - it implements a 16-step
    // amplitude gate on the master bus.
    const source = read('src/components/TransportToolsMenu.tsx');
    assert.ok(!/Time FX/i.test(source), 'the menu must not advertise time FX');
    assert.ok(!/tape-stop/i.test(source), 'the menu must not advertise a tape-stop brake');
    assert.match(source, /label: 'Master Gate'/);
    assert.match(source, /Sixteen-step amplitude gate on the master bus/);
  });

  it('the mixer insert EQ is named for the band count it implements', () => {
    assert.ok(!/7-Band/i.test(read('src/components/Mixer.tsx')));
    assert.ok(!/7-Band/i.test(read('src/components/ParametricEqModal.tsx')));
    assert.match(read('src/components/Mixer.tsx'), /3-Band EQ/);
  });
});
