import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const neutralLegacyUtility = /\b(?:hover:|active:|focus:|focus-visible:)?(?:bg|text|border|ring|accent)-\[#(?:0a0a0b|0a0a0c|070709|0c0c0e|0e0e10|101012|111113|11131a|121214|121215|141416|151821|161618|17171a|18181b|18181c|18181d|191c25|1a1a1d|1b1b1f|1c1c20|1e1e20|1e1e24|202024|202430|222225|222226|242428|25252a|262629|28282b|28282e|282830|29292d|2a2a2e|2a2a30|2b3040|2d2d30|2e2e32|2e2e34|333|333336|333338|333339|3e3e44|444|555|666|777|888|999|aaa|b0b0b0|d0d0d0|ddd|e0e0e0|ffffff)\](?:\/[\d.]+)?/i;

const tokenMap = (block: string): Record<string, string> => Object.fromEntries(
  [...block.matchAll(/(--apex-[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()])
);

const themeTokens = (css: string, mode: 'dark' | 'light'): Record<string, string> => {
  const defaults = [...css.matchAll(/:root\s*\{([^}]+)\}/g)]
    .map(match => tokenMap(match[1]))
    .reduce((combined, block) => ({ ...combined, ...block }), {});
  if (mode === 'dark') return defaults;
  const lightBlock = css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
  return { ...defaults, ...(lightBlock ? tokenMap(lightBlock) : {}) };
};

const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (color: string): number => {
    const match = color.match(/^#([0-9a-f]{6})$/i);
    assert.ok(match, `expected a six-digit hex token, received ${color}`);
    const channels = [0, 2, 4].map(offset => parseInt(match[1].slice(offset, offset + 2), 16) / 255);
    const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

const THEMED_SURFACES = [
  'src/App.tsx',
  'src/components/StudioBrowser.tsx',
  'src/components/PlaylistArranger.tsx',
  'src/components/PianoRoll.tsx',
  'src/components/Mixer.tsx',
  'src/components/ChannelRack.tsx',
  'src/components/InstrumentRack.tsx',
  'src/components/DrumSamplerPanel.tsx',
  'src/components/SampleLibraryPanel.tsx',
  'src/components/SampleSlicerPanel.tsx',
  'src/components/SampleManagerModal.tsx',
  'src/components/ProjectManagerModal.tsx',
  'src/components/ExportModal.tsx',
  'src/components/ProjectReplaceConfirmModal.tsx',
];

test('UI-04 defines shared dark and light surface, state, grid and piano-key tokens', () => {
  const css = read('src/index.css');
  const darkRootBlocks = [...css.matchAll(/:root\s*\{([^}]+)\}/g)].map(match => match[1]);
  const darkTokens = darkRootBlocks.find(block => block.includes('--apex-piano-key-natural:'));
  const lightTokens = css.match(/:root\[data-theme="light"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(darkTokens, 'dark defaults define the DAW surface token set');
  assert.ok(lightTokens, 'the light theme has a distinct override block');

  for (const token of [
    '--apex-panel:', '--apex-panel-header:', '--apex-canvas:',
    '--apex-state-hover:', '--apex-state-selected:', '--apex-state-selected-border:', '--apex-state-drop:', '--apex-state-playing-fg:',
    '--apex-state-recording-fg:', '--apex-grid-line:', '--apex-grid-line-strong:',
    '--apex-piano-key-natural:', '--apex-piano-key-accidental:',
    '--apex-piano-row-natural:', '--apex-piano-row-accidental:',
    '--apex-scrollbar-thumb:',
  ]) {
    assert.ok(darkTokens.includes(token), `dark defaults define ${token}`);
    assert.ok(lightTokens.includes(token), `light theme overrides ${token}`);
  }
  assert.match(css, /:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark/);
  assert.match(css, /:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light/);
});

test('workspace theme selection applies before paint and persists outside project/audio state', () => {
  const app = read('src/App.tsx');
  const html = read('index.html');
  const themeState = read('src/state/theme.ts');
  const projectPersistence = read('src/state/projectPersistence.ts');
  const audioEngine = read('src/audio/audioEngine.ts');

  const bootstrapIndex = html.indexOf("document.documentElement.dataset.theme=localStorage.getItem('apex:theme')");
  assert.ok(bootstrapIndex >= 0, 'the pre-React bootstrap restores the theme preference');
  assert.ok(bootstrapIndex < html.indexOf('<div id="root"></div>'), 'the bootstrap runs before the React root');
  assert.match(html, /document\.documentElement\.dataset\.theme=localStorage\.getItem\('apex:theme'\)==='light'\?'light':'dark'/);
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*document\.documentElement\.dataset\.theme = themeMode;/);
  assert.match(app, /writeThemePreference\(themeMode\)/);
  assert.match(themeState, /window\.localStorage\.getItem\(THEME_STORAGE_KEY\)/);
  assert.match(themeState, /window\.localStorage\.setItem\(THEME_STORAGE_KEY, mode\)/);
  assert.doesNotMatch(themeState, /audioEngine|ProjectState|serializeProject/i);
  assert.doesNotMatch(projectPersistence, /THEME_STORAGE_KEY|themeMode/);
  assert.doesNotMatch(audioEngine, /THEME_STORAGE_KEY|readThemePreference|writeThemePreference/);
});

test('UI-04 target surfaces no longer use the old neutral black/gray utility palette', () => {
  for (const file of THEMED_SURFACES) {
    const source = read(file);
    assert.equal(neutralLegacyUtility.test(source), false, `${file} should use semantic theme tokens for neutral surfaces`);
  }
});

test('Playlist, Piano Roll and Channel Rack expose theme-aware DAW interaction states', () => {
  const css = read('src/index.css');
  const playlist = read('src/components/PlaylistArranger.tsx');
  const piano = read('src/components/PianoRoll.tsx');
  const channelRack = read('src/components/ChannelRack.tsx');

  assert.match(playlist, /apex-playlist-selection-panel/);
  assert.match(playlist, /apex-playlist-drop-target/);
  assert.match(playlist, /--apex-state-hover/);
  assert.match(piano, /--apex-piano-key-natural/);
  assert.match(piano, /--apex-piano-key-accidental/);
  assert.match(piano, /--apex-piano-row-natural/);
  assert.match(piano, /--apex-piano-row-accidental/);
  assert.match(channelRack, /apex-step-active/);
  assert.match(css, /\.apex-step-active\s*\{[^}]*var\(--apex-accent\)/s);
  assert.match(css, /#fl-playlist-arranger \.apex-playlist-drop-target\s*\{[^}]*var\(--apex-state-drop\)/s);
});

test('UI-04 keeps track, pad, waveform and VU colors intentional', () => {
  const drumSampler = read('src/components/DrumSamplerPanel.tsx');
  const channelRack = read('src/components/ChannelRack.tsx');
  const mixer = read('src/components/Mixer.tsx');
  const playlist = read('src/components/PlaylistArranger.tsx');
  const slicer = read('src/components/SampleSlicerPanel.tsx');
  const sampleManager = read('src/components/SampleManagerModal.tsx');

  assert.match(drumSampler, /const PAD_COLORS = \[/);
  assert.match(channelRack, /style=\{\{ color: ch\.color \|\| 'var\(--apex-text\)' \}\}/);
  assert.match(mixer, /linear-gradient\(to top, #00ff00 60%, #ff6e00 85%, #ff0000 100%\)/);
  assert.match(playlist, /color: '#00ff88'/, 'dropped audio clips keep their intentional waveform identity');
  assert.match(slicer, /bg-\[var\(--apex-state-selected\)\]/, 'sample-slicer waveforms retain the light accent wash');
  assert.match(sampleManager, /isInsideTrim \? 'bg-\[var\(--apex-accent\)\]'/, 'trimmed sample waveform bars retain the accent color');
  assert.match(sampleManager, /shadow-\[0_0_8px_var\(--apex-success\)\]/);
  assert.match(sampleManager, /shadow-\[0_0_8px_var\(--apex-danger\)\]/);
});

test('light scrollbar thumbs remain discoverable across light semantic surfaces', () => {
  const tokens = themeTokens(read('src/index.css'), 'light');
  const backgrounds = ['--apex-panel', '--apex-panel-header', '--apex-canvas'];
  const thumbTokens = ['--apex-scrollbar-thumb', '--apex-scrollbar-thumb-hover'];

  for (const thumb of thumbTokens) {
    for (const surface of backgrounds) {
      const ratio = contrastRatio(tokens[thumb], tokens[surface]);
      assert.ok(ratio >= 3, `${thumb} should reach 3:1 against ${surface} (currently ${ratio.toFixed(2)}:1)`);
    }
  }
  assert.ok(
    contrastRatio(tokens['--apex-scrollbar-thumb-hover'], tokens['--apex-canvas']) >
      contrastRatio(tokens['--apex-scrollbar-thumb'], tokens['--apex-canvas']),
    'the hover thumb is more visible than the resting thumb'
  );
});

test('selected notes, pads and sample trim markers retain clear semantic colors in both themes', () => {
  const piano = read('src/components/PianoRoll.tsx');
  const drumSampler = read('src/components/DrumSamplerPanel.tsx');
  const sampleManager = read('src/components/SampleManagerModal.tsx');

  assert.match(
    piano,
    /isSelected\s*\?\s*'bg-\[var\(--apex-surface-3\)\] border-\[var\(--apex-accent\)\] text-\[var\(--apex-text\)\] ring-2 ring-\[var\(--apex-accent\)\]'/,
    'selected notes use a neutral fill plus an accent outline/ring'
  );
  assert.match(
    drumSampler,
    /selected\?\.id === pad\.id \? 'border-\[var\(--apex-accent\)\] ring-2 ring-\[var\(--apex-accent\)\]'/,
    'selected drum pads keep a distinct accent outline/ring'
  );
  assert.match(sampleManager, /bg-\[var\(--apex-success\)\] shadow-\[0_0_8px_var\(--apex-success\)\]/);
  assert.match(sampleManager, /bg-\[var\(--apex-danger\)\] shadow-\[0_0_8px_var\(--apex-danger\)\]/);

  const css = read('src/index.css');
  for (const mode of ['dark', 'light'] as const) {
    const tokens = themeTokens(css, mode);
    assert.ok(contrastRatio(tokens['--apex-accent'], tokens['--apex-surface-3']) >= 3, `${mode} selected-note outline`);
    assert.ok(contrastRatio(tokens['--apex-text'], tokens['--apex-surface-3']) >= 4.5, `${mode} selected-note text`);
    assert.ok(contrastRatio(tokens['--apex-accent'], tokens['--apex-surface-2']) >= 3, `${mode} selected-pad outline`);
    assert.ok(contrastRatio(tokens['--apex-success'], tokens['--apex-canvas']) >= 3, `${mode} sample start marker`);
    assert.ok(contrastRatio(tokens['--apex-danger'], tokens['--apex-canvas']) >= 3, `${mode} sample end marker`);
  }
});
