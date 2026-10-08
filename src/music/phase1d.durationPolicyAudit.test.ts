/**
 * Phase 1D — the note-duration policy completeness guard.
 *
 * ## What this guard is for
 *
 * Five layers used to disagree about the shortest legal note. The fix is a
 * single policy module; the risk is that the fix decays — somebody adds a sixth
 * layer with its own floor, or edits one of the five back to a literal. This
 * file exists so that either move fails a test with a message that names the
 * site.
 *
 * ## Design: declaration first, scanner second
 *
 * The primary guard is an explicit declaration. Every production site that
 * intentionally sets, floors, rounds or converts a musical duration is listed in
 * `DURATION_ALTERING_LAYERS` with its file, its symbols, literal source anchors
 * that must still be present, and the shortest duration it may emit. This test
 * pins that inventory with literals of its own, so an entry cannot be deleted
 * or reclassified without a failure here.
 *
 * The secondary guard is a deliberately narrow source scan for *unowned*
 * duration arithmetic. It is not a static analyzer and does not try to be one:
 * it looks for three shapes only (a `Math.*` transform of a step-domain duration
 * name, a numeric fallback read through a duration name, and a `MIN…DURATION`
 * constant declaration), it skips names that declare another unit (`…Seconds`,
 * `…Ms`, `…Bars`, `…Frames`, `…Samples`, `…Pixels`), and it skips test files.
 * Envelope, DSP, CSS-geometry and audio-asset durations therefore never reach
 * it. A weak net that never cries wolf beats a clever one that does: the
 * declaration above is what carries the correctness burden.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MidiParser } from '../utils/midiParser';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { planMidiImport } from '../components/pianoRollMidiImport';
import { resizeNoteRight } from '../components/pianoRollOperations';
import { resolveArpNoteDurationSteps, resolveArpRateSteps } from '../audio/noteGate';
import type { Channel, Note } from '../types/daw';
import type { DurationPolicyLayer } from './noteDurationPolicy';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------------------
// The narrow source scan
// ---------------------------------------------------------------------------

/** Names that declare a unit other than sixteenth-note steps are not in scope. */
const NON_STEP_UNIT = /(Seconds|Sec\b|_sec|Ms\b|Millis|Bars\b|Frames|Samples|Pixels|stepWidth)/;
/** A step-domain duration name being written. */
const DURATION_ASSIGNMENT = /(?:^|[^A-Za-z0-9_.])((?:duration|dur)[A-Za-z0-9_]*)\s*[:=](?!=)/;
const DURATION_READ = /(?:^|[^A-Za-z0-9_])(?:duration|dur)[A-Za-z0-9_]*/;
const MATH_TRANSFORM = /Math\.(round|floor|ceil|max|min)\s*\(/;
/** A numeric fallback: `? … : 2` or `|| 2`. */
const NUMERIC_FALLBACK = /(\?[^?:]*:\s*-?\d|\|\|\s*-?\d)/;
/** A constant whose name declares a minimum duration. */
const MINIMUM_DECLARATION =
  /const\s+[A-Za-z0-9_]*(?:MIN[A-Za-z0-9_]*DURATION|DURATION[A-Za-z0-9_]*MIN)[A-Za-z0-9_]*\s*=/i;

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'case',
  'function', 'const', 'let', 'var', 'class', 'await', 'yield', 'typeof', 'new', 'with',
]);
const TOP_LEVEL_DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/;
const NESTED_FUNCTION = /^  (?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/;
const NESTED_ARROW =
  /^  (?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*(?::[^=]*)?=>/;
const CLASS_METHOD =
  /^  (?:public\s+|private\s+|protected\s+)(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z0-9_$]+)\s*\(/;
const BARE_METHOD = /^  (?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?::\s*[^=;{]+)?\{\s*$/;
const DECLARATION_PATTERNS = [TOP_LEVEL_DECLARATION, NESTED_FUNCTION, NESTED_ARROW, CLASS_METHOD, BARE_METHOD];

export type ScanRule = 'math-transform' | 'numeric-fallback' | 'minimum-declaration';

export interface DurationAuthoritySite {
  /** Repo-relative POSIX path. */
  file: string;
  line: number;
  rule: ScanRule;
  symbol: string;
  text: string;
}

const listProductionSources = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(join(root, 'src'));
  return out.sort();
};

/** Strips line comments and comment-only lines so prose cannot trigger a rule. */
const stripComments = (line: string): string =>
  line.replace(/\/\/.*$/, '').replace(/^\s*[/*].*$/, '');

const enclosingSymbol = (lines: readonly string[], index: number): string => {
  for (let i = index; i >= 0; i -= 1) {
    for (const pattern of DECLARATION_PATTERNS) {
      const match = lines[i].match(pattern);
      if (match && !KEYWORDS.has(match[1])) return match[1];
    }
  }
  return '<module>';
};

/**
 * True when a statement visibly continues onto the next line, so the numeric
 * fallback may live there. A line closed by `;`, `,`, `{`, `}` or `]` is complete
 * as far as this scan is concerned; a line ending on `)` or on a bare operand is
 * not. This is what lets the scan see a duration fallback written across three
 * lines without also reading the next property of an object literal.
 */
const endsMidStatement = (line: string): boolean => {
  const trimmed = line.trimEnd();
  return trimmed.length > 0 && !/[;,{\]}]\s*$/.test(trimmed);
};

/**
 * The narrow scan. Returns the sites that look like independently-owned
 * duration arithmetic, each resolved to its enclosing function.
 */
export const scanDurationAuthoritySites = (root: string): DurationAuthoritySite[] => {
  const sites: DurationAuthoritySite[] = [];
  for (const absolute of listProductionSources(root)) {
    const raw = readFileSync(absolute, 'utf8').split('\n');
    const code = raw.map(stripComments);
    const file = relative(root, absolute).split(sep).join('/');

    code.forEach((line, index) => {
      let rule: ScanRule | null = null;
      const assignment = line.match(DURATION_ASSIGNMENT);

      if (assignment && !NON_STEP_UNIT.test(assignment[1]) && !NON_STEP_UNIT.test(line)) {
        if (MATH_TRANSFORM.test(line)) {
          rule = 'math-transform';
        } else {
          const rhs = line.slice(line.indexOf(assignment[0]) + assignment[0].length);
          const readsDuration = rhs.match(DURATION_READ);
          if (readsDuration && !NON_STEP_UNIT.test(readsDuration[0])) {
            // Same statement, or a ternary continued onto the next lines.
            const window = endsMidStatement(line) ? code.slice(index, index + 3).join(' ') : rhs;
            if (NUMERIC_FALLBACK.test(window)) rule = 'numeric-fallback';
          }
        }
      }
      if (!rule && MINIMUM_DECLARATION.test(line) && !NON_STEP_UNIT.test(line)) rule = 'minimum-declaration';

      if (rule) {
        sites.push({ file, line: index + 1, rule, symbol: enclosingSymbol(raw, index), text: line.trim() });
      }
    });
  }
  return sites;
};

const siteKey = (site: DurationAuthoritySite): string => `${site.file}::${site.symbol}`;

// ---------------------------------------------------------------------------
// The literal inventory this phase declares (independent of the registry)
// ---------------------------------------------------------------------------

interface ExpectedLayer {
  id: string;
  file: string;
  role: string;
  domain: string;
  consumesPolicy: boolean;
  declaredMinimum: number | null;
  /** Observed shortest emitted duration, measured by a probe below. */
  probeExpected?: number;
}

const EXPECTED_INVENTORY: readonly ExpectedLayer[] = Object.freeze([
  { id: 'policy.owner', file: 'src/music/noteDurationPolicy.ts', role: 'POLICY_OWNER', domain: 'note-steps', consumesPolicy: true, declaredMinimum: 0.25, probeExpected: 0.25 },
  { id: 'piano-roll.edit-floor', file: 'src/components/pianoRollOperations.ts', role: 'EDIT_FLOOR', domain: 'note-steps', consumesPolicy: true, declaredMinimum: 0.25, probeExpected: 0.25 },
  { id: 'piano-roll.quantize', file: 'src/components/PianoRoll.tsx', role: 'QUANTIZE', domain: 'note-steps', consumesPolicy: true, declaredMinimum: 0.25, probeExpected: 0.25 },
  { id: 'midi.import', file: 'src/utils/midiParser.ts', role: 'IMPORT_FLOOR', domain: 'note-steps', consumesPolicy: true, declaredMinimum: 0.25, probeExpected: 0.25 },
  { id: 'midi.import-unterminated-fallback', file: 'src/utils/midiParser.ts', role: 'FALLBACK', domain: 'note-steps', consumesPolicy: false, declaredMinimum: 2, probeExpected: 2 },
  { id: 'midi.export-piano-roll', file: 'src/utils/midiParser.ts', role: 'EXPORT_TICK_FLOOR', domain: 'midi-ticks', consumesPolicy: true, declaredMinimum: 1, probeExpected: 1 },
  { id: 'midi.export-project', file: 'src/utils/exportUtils.ts', role: 'EXPORT_TICK_FLOOR', domain: 'midi-ticks', consumesPolicy: true, declaredMinimum: 1, probeExpected: 1 },
  { id: 'midi.export-content-fallback', file: 'src/utils/exportUtils.ts', role: 'FALLBACK', domain: 'note-steps', consumesPolicy: false, declaredMinimum: 1, probeExpected: 1 },
  { id: 'midi.import-plan', file: 'src/components/pianoRollMidiImport.ts', role: 'PASS_THROUGH', domain: 'note-steps', consumesPolicy: false, declaredMinimum: null, probeExpected: 0.25 },
  { id: 'engine.bass-extraction-fallback', file: 'src/audio/audioEngine.ts', role: 'FALLBACK', domain: 'note-steps', consumesPolicy: false, declaredMinimum: 2 },
  { id: 'engine.offline-render-window', file: 'src/audio/audioEngine.ts', role: 'NON_MUSICAL', domain: 'audio-seconds', consumesPolicy: false, declaredMinimum: null },
  { id: 'polyphonic.blob-audition', file: 'src/components/PolyphonicEditorModal.tsx', role: 'PASS_THROUGH', domain: 'note-steps', consumesPolicy: false, declaredMinimum: null },
  { id: 'gate.note-gate', file: 'src/audio/noteGate.ts', role: 'AUDIBLE_GATE_SEPARATE_POLICY', domain: 'audio-seconds', consumesPolicy: false, declaredMinimum: null },
  { id: 'gate.arp-transient-duration', file: 'src/audio/noteGate.ts', role: 'AUDIBLE_GATE_SEPARATE_POLICY', domain: 'note-steps', consumesPolicy: false, declaredMinimum: null, probeExpected: 0.05 },
  { id: 'gate.instrument-policy', file: 'src/audio/instrumentGatePolicy.ts', role: 'AUDIBLE_GATE_SEPARATE_POLICY', domain: 'note-steps', consumesPolicy: false, declaredMinimum: 1 },
  { id: 'render.offline-note-gate', file: 'src/audio/offlineProjectRenderer.ts', role: 'AUDIBLE_GATE_SEPARATE_POLICY', domain: 'audio-seconds', consumesPolicy: false, declaredMinimum: null },
  { id: 'dsp.sample-trim-drumpad', file: 'src/audio/instruments/drumPad.ts', role: 'NON_MUSICAL', domain: 'audio-seconds', consumesPolicy: false, declaredMinimum: null },
  { id: 'dsp.sample-trim-sampler', file: 'src/audio/instruments/sampler.ts', role: 'NON_MUSICAL', domain: 'audio-seconds', consumesPolicy: false, declaredMinimum: null },
]);

/** Every site the narrow scan is expected to find, once the policy is in place. */
const EXPECTED_SCANNED_SITES: readonly string[] = Object.freeze([
  'src/audio/audioEngine.ts::extractBassNotesFromChords',
  'src/audio/instruments/drumPad.ts::renderDrumPadVoice',
  'src/audio/instruments/sampler.ts::renderSamplerVoice',
  'src/components/pianoRollOperations.ts::DEFAULT_MIN_NOTE_DURATION',
  'src/components/pianoRollOperations.ts::resizeNoteLeft',
  'src/components/pianoRollOperations.ts::resizeNoteRight',
  'src/components/pianoRollOperations.ts::validateNote',
  'src/music/noteDurationPolicy.ts::MIN_NOTE_DURATION_STEPS',
  'src/music/noteDurationPolicy.ts::minNoteDurationTicks',
  'src/utils/exportUtils.ts::contentEventsAtStep',
  'src/utils/exportUtils.ts::emitAtStep',
  'src/utils/midiParser.ts::parseMidiFile',
]);

/**
 * Modules whose duration-shaped numbers are seconds, samples, bars, CSS pixels
 * or envelope arithmetic. The scan must never flag them: a guard that cries wolf
 * on DSP gets ignored, and then it guards nothing.
 */
const MUST_NOT_FLAG_FILES: readonly string[] = Object.freeze([
  'src/audio/instrumentGatePolicy.ts',
  'src/audio/instruments/independentPluck.ts',
  'src/audio/instruments/legacyAcoustic.ts',
  'src/audio/instruments/legacySynth.ts',
  'src/audio/instruments/subtractiveSynth.ts',
  'src/audio/noteGate.ts',
  'src/audio/offlineProjectRenderer.ts',
  'src/audio/presets.ts',
  'src/audio/recordingPipeline.ts',
  'src/components/PlaylistArranger.tsx',
  'src/components/PolyphonicEditorModal.tsx',
  'src/components/WarpAudioProcessorModal.tsx',
  'src/components/pianoRollMidiImport.ts',
]);

const MUST_NOT_FLAG_SITES: readonly string[] = Object.freeze([
  // Offline render window length, in seconds.
  'src/audio/audioEngine.ts::renderTimelineOffline',
  // Note rectangle geometry, in CSS pixels.
  'src/components/pianoRollOperations.ts::getNoteRect',
  // Note rendering widths and newly drawn note defaults.
  'src/components/PianoRoll.tsx::PianoRoll',
  'src/components/PianoRoll.tsx::handleVelocityChange',
]);

// ---------------------------------------------------------------------------
// Probes: measure the real shortest duration each layer emits
// ---------------------------------------------------------------------------

const PPQ = 480;
const TICKS_PER_STEP = 120;

const writeVlq = (value: number): number[] => {
  const bytes = [value & 0x7f];
  let rest = value >> 7;
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest >>= 7;
  }
  return bytes;
};

const buildFormat0 = (events: ReadonlyArray<{ delta: number; data: readonly number[] }>): ArrayBuffer => {
  const track: number[] = [];
  for (const event of events) track.push(...writeVlq(event.delta), ...event.data);
  track.push(0x00, 0xff, 0x2f, 0x00);
  const bytes = [
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01,
    (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff, (track.length >> 8) & 0xff, track.length & 0xff,
    ...track,
  ];
  return new Uint8Array(bytes).buffer;
};

/** First note-on→note-off delta in the file, in ticks. */
const firstNoteDeltaTicks = (buffer: ArrayBuffer): number => {
  const view = new DataView(buffer);
  const headerLength = view.getUint32(4);
  const length = view.getUint32(8 + headerLength + 4);
  let index = 8 + headerLength + 8;
  const end = index + length;
  let tick = 0;
  let runningStatus = 0;
  let noteOnTick: number | null = null;

  while (index < end) {
    let delta = 0;
    let byte = 0;
    do {
      byte = view.getUint8(index);
      index += 1;
      delta = (delta << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    tick += delta;

    let status = view.getUint8(index);
    if (status & 0x80) {
      runningStatus = status;
      index += 1;
    } else {
      status = runningStatus;
    }
    if (status === 0xff) {
      index += 1; // meta type byte precedes the length
      let metaLength = 0;
      let metaByte = 0;
      do {
        metaByte = view.getUint8(index);
        index += 1;
        metaLength = (metaLength << 7) | (metaByte & 0x7f);
      } while (metaByte & 0x80);
      index += metaLength;
      continue;
    }
    const type = status >> 4;
    const velocity = view.getUint8(index + 1);
    index += 2;
    if (type === 0x9 && velocity > 0) {
      if (noteOnTick === null) noteOnTick = tick;
    } else if ((type === 0x8 || (type === 0x9 && velocity === 0)) && noteOnTick !== null) {
      return tick - noteOnTick;
    }
  }
  throw new Error('no note pair found in the probe file');
};

const makeChannel = (notes: Note[]): Channel => ({
  id: 'probe-channel',
  name: 'Probe',
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes,
  synthParams: {} as Channel['synthParams'],
});

const projectExportDeltaTicks = async (duration: number): Promise<number> => {
  const blob = buildStandardMidiFile(
    [makeChannel([{ id: 'probe', pitch: 60, start: 0, duration, velocity: 0.8 }])],
    [],
    { bpm: 120, timeSignature: [4, 4] },
    { scope: 'pattern', patternLengthSteps: 16 },
  );
  return firstNoteDeltaTicks(await blob.arrayBuffer());
};

/**
 * Measured shortest emitted duration per layer, in that layer's declared domain.
 * A layer with no probe is one whose module is too heavy to import here; its
 * declared behaviour is pinned by source anchors instead.
 */
const LAYER_PROBES: Readonly<Record<string, () => number | Promise<number>>> = Object.freeze({
  'policy.owner': async () => {
    const policy = await import('./noteDurationPolicy');
    return policy.quantizeDurationSteps(policy.MIN_NOTE_DURATION_STEPS);
  },
  'piano-roll.edit-floor': () =>
    resizeNoteRight({ id: 'probe', pitch: 60, start: 0, duration: 4, velocity: 0.8 }, 0.05).duration,
  'piano-roll.quantize': async () => {
    const policy = await import('./noteDurationPolicy');
    return policy.quantizeDurationSteps(0.25);
  },
  'midi.import': async () => {
    const tracks = await MidiParser.parseMidiFile(
      buildFormat0([{ delta: 0, data: [0x90, 60, 100] }, { delta: 30, data: [0x80, 60, 0] }]),
    );
    return tracks[0].notes[0].durationSteps;
  },
  'midi.import-unterminated-fallback': async () => {
    // A note-on with no note-off anywhere in the track.
    const tracks = await MidiParser.parseMidiFile(buildFormat0([{ delta: 0, data: [0x90, 60, 100] }]));
    return tracks[0].notes[0].durationSteps;
  },
  'midi.export-piano-roll': async () => {
    const blob = MidiParser.exportNotesToMidi(
      [{ id: 'probe', pitch: 60, start: 0, duration: 0.001, velocity: 0.8 }],
      120,
      'Probe',
    );
    return firstNoteDeltaTicks(await blob.arrayBuffer());
  },
  'midi.export-project': () => projectExportDeltaTicks(0.001),
  'midi.export-content-fallback': async () => (await projectExportDeltaTicks(Number.NaN)) / TICKS_PER_STEP,
  'midi.import-plan': () =>
    planMidiImport([{ name: 'Probe', notes: [{ pitch: 60, startStep: 0, durationSteps: 0.25, velocity: 0.8 }] }])
      .destinations[0].notes[0].duration,
  // The shortest length the transient arpeggiator gate can emit: the 1/32 rate
  // (0.5 steps) at the shortest gate the arp slider offers (0.1). Landing below
  // the musical minimum is the POINT — this probe exists so that clamping or
  // snapping the helper to the note-duration policy fails the audit.
  'gate.arp-transient-duration': () => resolveArpNoteDurationSteps(resolveArpRateSteps('1/32'), 0.1),
});

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

interface AuditOptions {
  root: string;
  layers: readonly DurationPolicyLayer[];
  expectedInventory: readonly ExpectedLayer[];
  expectedSites: readonly string[];
  probes: Readonly<Record<string, () => number | Promise<number>>>;
}

/**
 * Throws with a message naming the offending site whenever the declared policy
 * and the production source disagree.
 */
export const auditDurationPolicy = async (options: AuditOptions): Promise<void> => {
  const { root, layers, expectedInventory, expectedSites, probes } = options;
  const failures: string[] = [];

  // 1. The inventory is exactly what this phase declared — no omission, no
  //    reclassification, no surprise addition.
  const actual = layers.map(layer => ({
    id: layer.id,
    file: layer.file,
    role: layer.role,
    domain: layer.domain,
    consumesPolicy: layer.consumesPolicy,
    declaredMinimum: layer.declaredMinimum,
  }));
  const expected = expectedInventory.map(entry => ({
    id: entry.id,
    file: entry.file,
    role: entry.role,
    domain: entry.domain,
    consumesPolicy: entry.consumesPolicy,
    declaredMinimum: entry.declaredMinimum,
  }));
  const byId = (list: readonly { id: string }[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  if (JSON.stringify(byId(actual)) !== JSON.stringify(byId(expected))) {
    const actualIds = new Set(actual.map(entry => entry.id));
    const expectedIds = new Set(expected.map(entry => entry.id));
    for (const id of expectedIds) if (!actualIds.has(id)) failures.push(`policy entry missing: "${id}"`);
    for (const id of actualIds) if (!expectedIds.has(id)) failures.push(`policy entry not declared by this phase: "${id}"`);
    for (const want of expected) {
      const got = actual.find(entry => entry.id === want.id);
      if (!got) continue;
      for (const field of ['file', 'role', 'domain', 'consumesPolicy', 'declaredMinimum'] as const) {
        if (got[field] !== want[field]) {
          failures.push(`policy entry "${want.id}" misclassified: ${field} is ${JSON.stringify(got[field])}, expected ${JSON.stringify(want[field])}`);
        }
      }
    }
  }

  const ids = new Set<string>();
  for (const layer of layers) {
    // 2. Every entry documents itself.
    if (ids.has(layer.id)) failures.push(`duplicate policy entry id "${layer.id}"`);
    ids.add(layer.id);
    if (!layer.behavior) failures.push(`"${layer.id}" does not describe its current behaviour`);
    if (!layer.reason) failures.push(`"${layer.id}" does not say why it has that role`);
    if (!Array.isArray(layer.symbols) || layer.symbols.length === 0) failures.push(`"${layer.id}" declares no symbols`);
    if (!Array.isArray(layer.anchors) || layer.anchors.length === 0) failures.push(`"${layer.id}" declares no source anchors`);
    if (layer.domain === 'note-steps' && typeof layer.declaredMinimum === 'number' && layer.declaredMinimum < 0.25) {
      failures.push(`"${layer.id}" declares a step-domain minimum of ${layer.declaredMinimum}, below the policy minimum 0.25`);
    }

    // 3. The declared site exists and still says what the entry claims.
    const absolute = join(root, layer.file);
    if (!existsSync(absolute)) {
      failures.push(`"${layer.id}" points at ${layer.file}, which does not exist`);
      continue;
    }
    const source = readFileSync(absolute, 'utf8');
    for (const symbol of layer.symbols) {
      if (!source.includes(symbol)) failures.push(`"${layer.id}" declares symbol "${symbol}", absent from ${layer.file}`);
    }
    for (const anchor of layer.anchors) {
      if (!source.includes(anchor)) failures.push(`"${layer.id}" anchor "${anchor}" is gone from ${layer.file}`);
    }
    for (const forbidden of layer.forbiddenAnchors ?? []) {
      if (source.includes(forbidden)) {
        failures.push(`"${layer.id}" reintroduced the independent rule "${forbidden}" in ${layer.file}`);
      }
    }

    // 4. Ownership. A layer that claims to consume the policy must really import
    //    it. The reverse is only asserted for the two roles that must stay out of
    //    the policy's way: the Phase 1C audible-gate system (a separate policy
    //    with a separate purpose) and non-musical durations. A file may host both
    //    a consuming and a non-consuming layer — `midiParser.ts` does — so the
    //    check is per role, not per file.
    const isPolicyModule = layer.file === 'src/music/noteDurationPolicy.ts';
    const importsPolicy = isPolicyModule || source.includes('music/noteDurationPolicy');
    if (layer.consumesPolicy && !importsPolicy) {
      failures.push(`"${layer.id}" claims to consume the shared policy but ${layer.file} does not import it`);
    }
    const mustStaySeparate = layer.role === 'AUDIBLE_GATE_SEPARATE_POLICY' || layer.role === 'NON_MUSICAL';
    if (mustStaySeparate && importsPolicy) {
      failures.push(`"${layer.id}" pulls ${layer.file} into the duration policy; that layer must stay independent`);
    }

    // 5. The declared minimum is what the layer actually emits.
    const probe = probes[layer.id];
    if (probe) {
      const observed = await probe();
      const want = expectedInventory.find(entry => entry.id === layer.id)?.probeExpected;
      if (want === undefined) failures.push(`"${layer.id}" has a probe but no declared probe expectation`);
      else if (observed !== want) failures.push(`"${layer.id}" emits ${observed}, not the declared ${want}`);
    }
  }

  // 6. No unowned duration arithmetic anywhere in production source.
  const sites = scanDurationAuthoritySites(root);
  const claimed = new Set<string>();
  for (const layer of layers) {
    for (const symbol of layer.symbols) claimed.add(`${layer.file}::${symbol}`);
  }
  for (const site of sites) {
    if (!claimed.has(siteKey(site))) {
      failures.push(
        `undeclared duration-altering site ${site.file}:${site.line} in ${site.symbol}() [${site.rule}]: ` +
        `${site.text.slice(0, 120)} — declare it in DURATION_ALTERING_LAYERS`,
      );
    }
  }
  const scannedKeys = [...new Set(sites.map(siteKey))].sort();
  if (JSON.stringify(scannedKeys) !== JSON.stringify([...expectedSites].sort())) {
    const missing = expectedSites.filter(key => !scannedKeys.includes(key));
    const extra = scannedKeys.filter(key => !expectedSites.includes(key));
    if (missing.length) failures.push(`known duration-authority sites no longer detected: ${missing.join(', ')}`);
    if (extra.length) failures.push(`new duration-authority sites detected: ${extra.join(', ')}`);
  }
  for (const file of MUST_NOT_FLAG_FILES) {
    const flagged = sites.filter(site => site.file === file);
    if (flagged.length) {
      failures.push(`false positive: ${file} is DSP/envelope/asset code but was flagged at ${flagged.map(s => s.line).join(', ')}`);
    }
  }
  for (const key of MUST_NOT_FLAG_SITES) {
    if (scannedKeys.includes(key)) failures.push(`false positive: ${key} is not a musical-duration authority`);
  }

  if (failures.length > 0) throw new Error(`[DurationPolicy]\n  - ${failures.join('\n  - ')}`);
};

// ---------------------------------------------------------------------------
// Throwaway copies for the mutation checks
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
const makeTempDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `phase1d-${label}-`));
  tempDirs.push(dir);
  return dir;
};

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

let mutationCounter = 0;

/** Copies the policy module (and its one import) and applies a text mutation. */
const mutatedPolicyModule = async (mutate: (source: string) => string): Promise<typeof import('./noteDurationPolicy')> => {
  const dir = makeTempDir(`policy${mutationCounter++}`);
  mkdirSync(join(dir, 'music'), { recursive: true });
  const original = readFileSync(join(REPO_ROOT, 'src/music/noteDurationPolicy.ts'), 'utf8');
  const mutated = mutate(original);
  assert.notEqual(mutated, original, 'the mutation did not change the policy source');
  writeFileSync(join(dir, 'music/noteDurationPolicy.ts'), mutated);
  cpSync(join(REPO_ROOT, 'src/music/musicalTime.ts'), join(dir, 'music/musicalTime.ts'));
  return import(pathToFileURL(join(dir, 'music/noteDurationPolicy.ts')).href);
};

const auditWithRegistry = (layers: readonly DurationPolicyLayer[]): Promise<void> =>
  auditDurationPolicy({
    root: REPO_ROOT,
    layers,
    expectedInventory: EXPECTED_INVENTORY,
    expectedSites: EXPECTED_SCANNED_SITES,
    probes: LAYER_PROBES,
  });

const expectAuditFailure = async (run: () => Promise<void>, fragment: string): Promise<void> => {
  await assert.rejects(run, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(
      message.includes(fragment),
      `expected a failure mentioning "${fragment}", got:\n${message}`,
    );
    return true;
  });
};

// ---------------------------------------------------------------------------

describe('Phase 1D D — every duration-altering production layer is declared', () => {
  it('the declared inventory matches the production source', async () => {
    const policy = await import('./noteDurationPolicy');
    await auditWithRegistry(policy.DURATION_ALTERING_LAYERS);
  });

  it('the runtime completeness guard agrees', async () => {
    const policy = await import('./noteDurationPolicy');
    assert.equal(policy.assertCompleteDurationPolicy(), true);
  });

  it('the narrow scan finds exactly the known duration-authority sites', () => {
    const keys = [...new Set(scanDurationAuthoritySites(REPO_ROOT).map(siteKey))].sort();
    assert.deepEqual(keys, [...EXPECTED_SCANNED_SITES].sort());
  });

  it('never flags envelope, DSP, CSS-geometry or audio-asset durations', () => {
    const sites = scanDurationAuthoritySites(REPO_ROOT);
    const keys = new Set(sites.map(siteKey));
    const flaggedFiles = new Set(sites.map(site => site.file));
    for (const file of MUST_NOT_FLAG_FILES) {
      assert.ok(!flaggedFiles.has(file), `${file} must not be flagged`);
    }
    for (const key of MUST_NOT_FLAG_SITES) {
      assert.ok(!keys.has(key), `${key} must not be flagged`);
    }
  });

  it('classifies the two sample-trim floors as non-musical rather than ignoring them', async () => {
    const policy = await import('./noteDurationPolicy');
    const sites = scanDurationAuthoritySites(REPO_ROOT);
    for (const file of ['src/audio/instruments/drumPad.ts', 'src/audio/instruments/sampler.ts']) {
      const flagged = sites.filter(site => site.file === file);
      assert.equal(flagged.length, 1, `${file} has one duration-shaped floor`);
      const layer = policy.DURATION_ALTERING_LAYERS.find(entry => entry.file === file);
      assert.ok(layer, `${file} must be declared`);
      assert.equal(layer.role, 'NON_MUSICAL');
      assert.equal(layer.domain, 'audio-seconds');
    }
  });

  it('a new duration-altering layer with its own floor fails the guard', async () => {
    // Throwaway copy of the whole source tree plus one undeclared layer.
    const dir = makeTempDir('newlayer');
    cpSync(join(REPO_ROOT, 'src'), join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src/components/phase99.rogueDurationLayer.ts'),
      [
        "import type { Note } from '../types/daw';",
        'export const ROGUE_MIN_DURATION = 0.5;',
        'export const rogueTighten = (note: Note): Note => ({',
        '  ...note,',
        '  duration: Math.max(ROGUE_MIN_DURATION, Math.round(note.duration * 2) / 2),',
        '});',
        '',
      ].join('\n'),
    );

    const policy = await import('./noteDurationPolicy');
    await expectAuditFailure(
      () =>
        auditDurationPolicy({
          root: dir,
          layers: policy.DURATION_ALTERING_LAYERS,
          expectedInventory: EXPECTED_INVENTORY,
          expectedSites: EXPECTED_SCANNED_SITES,
          probes: {},
        }),
      'undeclared duration-altering site',
    );
  });
});

describe('Phase 1D E — deleting a policy entry fails the guard', () => {
  it('rejects a registry with any single entry removed', async () => {
    const policy = await import('./noteDurationPolicy');
    for (const doomed of policy.DURATION_ALTERING_LAYERS) {
      const mutant = policy.DURATION_ALTERING_LAYERS.filter(layer => layer.id !== doomed.id);
      await expectAuditFailure(() => auditWithRegistry(mutant), `policy entry missing: "${doomed.id}"`);
    }
  });

  it('rejects a throwaway copy of the policy module with an entry deleted', async () => {
    const mutant = await mutatedPolicyModule(source => {
      const start = source.indexOf("    id: 'midi.import',");
      assert.ok(start > 0, 'the midi.import entry must exist to be deleted');
      const end = source.indexOf('  },\n', start);
      assert.ok(end > start, 'the midi.import entry must be closable');
      return source.slice(0, start - 4) + source.slice(end + 5);
    });
    await expectAuditFailure(() => auditWithRegistry(mutant.DURATION_ALTERING_LAYERS), 'policy entry missing: "midi.import"');
  });
});

describe('Phase 1D F — misclassifying a policy entry fails the guard', () => {
  it('rejects a throwaway copy whose MIDI import entry claims a 0.5-step minimum', async () => {
    const mutant = await mutatedPolicyModule(source => {
      const start = source.indexOf("    id: 'midi.import',");
      assert.ok(start > 0, 'the midi.import entry must exist to be misclassified');
      const end = source.indexOf('  },\n', start);
      const entry = source.slice(start, end);
      assert.match(entry, /declaredMinimum: 0\.25/, 'the entry must start out declaring 0.25');
      const mutatedEntry = entry.replace('declaredMinimum: 0.25', 'declaredMinimum: 0.5');
      return source.slice(0, start) + mutatedEntry + source.slice(end);
    });
    await expectAuditFailure(
      () => auditWithRegistry(mutant.DURATION_ALTERING_LAYERS),
      'misclassified: declaredMinimum is 0.5, expected 0.25',
    );
  });

  it('rejects a throwaway copy that reclassifies the Piano Roll floor as independent of the policy', async () => {
    const mutant = await mutatedPolicyModule(source => {
      const start = source.indexOf("    id: 'piano-roll.edit-floor',");
      assert.ok(start > 0);
      const end = source.indexOf('  },\n', start);
      const entry = source.slice(start, end);
      assert.match(entry, /consumesPolicy: true/);
      return source.slice(0, start) + entry.replace('consumesPolicy: true', 'consumesPolicy: false') + source.slice(end);
    });
    await expectAuditFailure(
      () => auditWithRegistry(mutant.DURATION_ALTERING_LAYERS),
      'misclassified: consumesPolicy is false, expected true',
    );
  });

  it('rejects a step-domain entry that declares a minimum below the policy minimum', async () => {
    const policy = await import('./noteDurationPolicy');
    const mutant = policy.DURATION_ALTERING_LAYERS.map(layer =>
      layer.id === 'midi.import' ? { ...layer, declaredMinimum: 0.125 } : layer,
    );
    await expectAuditFailure(() => auditWithRegistry(mutant), 'below the policy minimum 0.25');
  });
});

describe('Phase 1D — the MIDI 0.5-step floor cannot come back silently', () => {
  it('rejects a throwaway copy of the importer that restores the hard-coded floor', async () => {
    const dir = makeTempDir('midifloor');
    cpSync(join(REPO_ROOT, 'src'), join(dir, 'src'), { recursive: true });
    const target = join(dir, 'src/utils/midiParser.ts');
    const source = readFileSync(target, 'utf8');
    const restored = source
      .replace(/minNoteDurationTicks\(ticksPerStep\)/g, 'ticksPerStep / 2')
      .replace(/midiTicksToDurationSteps\(durTicks, ticksPerStep\)/g, 'Math.max(0.5, Math.round((durTicks / ticksPerStep) * 4) / 4)');
    assert.notEqual(restored, source, 'the mutation must change the importer');
    writeFileSync(target, restored);

    const policy = await import('./noteDurationPolicy');
    await expectAuditFailure(
      () =>
        auditDurationPolicy({
          root: dir,
          layers: policy.DURATION_ALTERING_LAYERS,
          expectedInventory: EXPECTED_INVENTORY,
          expectedSites: EXPECTED_SCANNED_SITES,
          probes: {},
        }),
      'reintroduced the independent rule',
    );
  });

  it('rejects a throwaway copy of the Piano Roll that restores the 1-step quantize floor', async () => {
    const dir = makeTempDir('quantize');
    cpSync(join(REPO_ROOT, 'src'), join(dir, 'src'), { recursive: true });
    const target = join(dir, 'src/components/PianoRoll.tsx');
    const source = readFileSync(target, 'utf8');
    const restored = source.replace('duration: quantizeDurationSteps(n.duration)', 'duration: Math.max(1, Math.round(n.duration))');
    assert.notEqual(restored, source, 'the mutation must change the quantize handler');
    writeFileSync(target, restored);

    const policy = await import('./noteDurationPolicy');
    await expectAuditFailure(
      () =>
        auditDurationPolicy({
          root: dir,
          layers: policy.DURATION_ALTERING_LAYERS,
          expectedInventory: EXPECTED_INVENTORY,
          expectedSites: EXPECTED_SCANNED_SITES,
          probes: {},
        }),
      'reintroduced the independent rule',
    );
  });

  it('rejects a throwaway copy of the Piano Roll minimum that restates 0.25 as a literal', async () => {
    const dir = makeTempDir('editfloor');
    cpSync(join(REPO_ROOT, 'src'), join(dir, 'src'), { recursive: true });
    const target = join(dir, 'src/components/pianoRollOperations.ts');
    const source = readFileSync(target, 'utf8');
    const restored = source.replace(
      'export const DEFAULT_MIN_NOTE_DURATION = MIN_NOTE_DURATION_STEPS;',
      'export const DEFAULT_MIN_NOTE_DURATION = 0.25;',
    );
    assert.notEqual(restored, source, 'the mutation must change the constant');
    writeFileSync(target, restored);

    const policy = await import('./noteDurationPolicy');
    await expectAuditFailure(
      () =>
        auditDurationPolicy({
          root: dir,
          layers: policy.DURATION_ALTERING_LAYERS,
          expectedInventory: EXPECTED_INVENTORY,
          expectedSites: EXPECTED_SCANNED_SITES,
          probes: {},
        }),
      'anchor',
    );
  });
});

describe('Phase 1D — the two policy systems stay separate', () => {
  it('the instrument gate policy does not import the duration policy', () => {
    for (const file of ['src/audio/instrumentGatePolicy.ts', 'src/audio/noteGate.ts']) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      assert.ok(!source.includes('noteDurationPolicy'), `${file} must not consume the duration policy`);
    }
  });

  it('the duration policy does not import or restate the gate policy', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/music/noteDurationPolicy.ts'), 'utf8');
    // The inventory names the gate layers, so the module mentions them in prose.
    // What it must never do is import them or restate their seconds arithmetic.
    for (const forbidden of ['GATE_SECONDS_PER_STEP_AT_60BPM', 'characterFactor', 'from \'./noteGate\'', 'instrumentGatePolicy\'']) {
      assert.ok(!source.includes(forbidden), `the duration policy must not reference ${forbidden}`);
    }
    const imports = [...source.matchAll(/^import\s[^;]*?from\s*'([^']+)'/gm)].map(match => match[1]);
    assert.deepEqual(imports, ['./musicalTime'], 'the policy builds on canonical musical time and nothing else');
  });

  it('gate fallback steps are untouched by this phase', () => {
    const source = readFileSync(join(REPO_ROOT, 'src/audio/instrumentGatePolicy.ts'), 'utf8');
    const fallbacks = [...source.matchAll(/fallbackSteps:\s*([0-9.]+)/g)].map(match => Number(match[1]));
    assert.equal(fallbacks.length, 18, 'the 18 duration-gated instruments each declare a fallback');
    assert.equal(Math.min(...fallbacks), 1);
    assert.equal(Math.max(...fallbacks), 2);
  });
});
