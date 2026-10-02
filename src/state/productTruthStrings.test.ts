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
    assert.match(readme, /dual (standard )?oscillators/i);
  });

  it('keeps the working capabilities it already documented', () => {
    for (const capability of [
      'Channel Rack',
      'Piano Roll',
      'Playlist Arranger',
      'Mixer',
      'Recording',
      'Export',
    ]) {
      assert.ok(readme.includes(capability), `README must still document ${capability}`);
    }
  });

  it('records which advanced surfaces are not production DSP', () => {
    for (const surface of ['Vocal Tuner', 'Warp', 'Take Comping', 'Wavetable', 'Polyphonic']) {
      assert.ok(
        readme.includes(surface),
        `README must state the status of ${surface} instead of leaving it unmentioned`
      );
    }
    assert.match(readme, /not (yet )?wired|stored intent|prototype|not applied/i);
  });

  it('keeps the no-AI statement, and no UI string contradicts it', () => {
    assert.match(readme, /does not include active AI generation/i);
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      assert.ok(!/AI Smart|AI-powered|AI generated/i.test(source), `${path.relative(root, file)} must not claim AI`);
    }
  });
});

describe('Phase 52 — truthful not-applied states', () => {
  it('Mastering Suite still declares its processors are out of the signal path', () => {
    const source = read('src/components/MasteringSuiteModal.tsx');
    assert.ok(source.includes('NOT APPLIED'));
    assert.ok(source.includes('NO PROCESSING IN SIGNAL PATH'));
    assert.ok(!/>\s*GR\s*</.test(source.replace(/NOT MEASURED/g, '')), 'no bare gain-reduction readout');
  });

  it('Polyphonic editor declares its demo blobs are not source-audio analysis', () => {
    const source = read('src/components/PolyphonicEditorModal.tsx');
    assert.match(source, /NOT APPLIED|PROTOTYPE|DEMO/i);
    assert.ok(!/Phase-Locked Resampling Active/i.test(source));
  });

  it('Take Comping is labelled as a demo and keeps its safe refusal', () => {
    const source = read('src/components/TakeCompingModal.tsx');
    assert.match(source, /DEMO|PROTOTYPE|INCOMPLETE/i);
    assert.ok(source.includes('no recorded audio asset'), 'the Phase 48 refusal must be preserved');
    assert.ok(!/Equal-Power Crossfade Algorithm Active/i.test(source));
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

  it('the mixer insert EQ is named for the band count it implements', () => {
    assert.ok(!/7-Band/i.test(read('src/components/Mixer.tsx')));
    assert.ok(!/7-Band/i.test(read('src/components/ParametricEqModal.tsx')));
    assert.match(read('src/components/Mixer.tsx'), /3-Band EQ/);
  });
});
