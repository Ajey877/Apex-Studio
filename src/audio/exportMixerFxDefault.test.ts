import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_INCLUDE_MIXER_FX,
  describeExportFxDefault,
  resolveExportFxChoice,
} from '../components/exportMixerFxPreference';

const repoFile = (relative: string): string =>
  readFileSync(path.resolve(fileURLToPath(new URL('../../', import.meta.url)), relative), 'utf8');

describe('Phase 52 — export mixer-FX default', () => {
  it('defaults exports to including mixer inserts, so the WAV matches monitoring', () => {
    assert.equal(DEFAULT_INCLUDE_MIXER_FX, true);
    assert.equal(resolveExportFxChoice(null), true);
  });

  it('still honours an explicit dry bounce', () => {
    assert.equal(resolveExportFxChoice('off'), false);
    assert.equal(resolveExportFxChoice('auto', false), false);
  });

  it('lets an explicit "include FX" override a dry project default', () => {
    assert.equal(resolveExportFxChoice('on', false), true);
  });

  it('states the default in the UI instead of leaving it implicit', () => {
    assert.match(describeExportFxDefault(true), /On/);
    assert.match(describeExportFxDefault(false), /Off/);
  });

  it('App passes the preference explicitly rather than relying on a silent default', () => {
    const app = repoFile('src/App.tsx');
    const open = app.indexOf('<ExportModal');
    assert.notEqual(open, -1, 'App must render ExportModal');

    // Slice out the whole element. Attribute values contain `=>` and `>`, so the
    // element ends at the first self-closing `/>` at brace depth 0.
    let depth = 0;
    let end = -1;
    for (let i = open + '<ExportModal'.length; i < app.length; i += 1) {
      const ch = app[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (depth === 0 && app.startsWith('/>', i)) {
        end = i + 2;
        break;
      }
    }
    assert.notEqual(end, -1, 'ExportModal element must be self-closing');
    const element = app.slice(open, end);

    assert.match(element, /includeMixerFx/, 'the ExportModal element must carry includeMixerFx');
    assert.match(element, /DEFAULT_INCLUDE_MIXER_FX/, 'App must pass the explicit product default');
  });

  it('keeps the engine boundary an explicit opt-in (callers must be deliberate)', () => {
    const engine = repoFile('src/audio/audioEngine.ts');
    assert.ok(
      /includeMixerFx:\s*boolean\s*=\s*false/.test(engine),
      'the engine default stays false so every caller states its intent'
    );
  });
});
