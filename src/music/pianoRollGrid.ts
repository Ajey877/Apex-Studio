/**
 * Phase 1K — meter-aware Piano Roll grid model (pure).
 *
 * The Piano Roll stores notes in sixteenth-note steps, unchanged. This module
 * only describes how the grid is DECORATED for the active meter:
 *
 *   - 4/4 and 3/4 (quarter-note pulses) keep their historical appearance
 *     exactly: a strong line and a running label on every quarter step
 *     (`1, 2, 3, …` counted across bars), which is what the editor has always
 *     shown. This is the "preserve existing 4/4 behaviour" contract.
 *   - 6/8 and 7/8 (eighth-note pulses) draw three line levels — bar lines,
 *     beat-group lines and eighth pulses — and label each pulse with its
 *     position inside the bar (`1 … 6` for 6/8, `1 … 7` for 7/8). The group
 *     lines are the same dotted-quarter / selected 7/8 grouping the metronome
 *     accents (`resolveMeterPulseLayout`), so the grid, the transport readout
 *     and the click all agree on where the beats are.
 *
 * Nothing here moves notes: labels and line strengths are presentation only,
 * and every stored `Note.start`/`duration` keeps its sixteenth-step meaning.
 */
import { stepsPerBar, type TimeSignature } from './musicalTime';
import {
  resolveMeterPulseLayout,
  type MeterPulseLayout,
  type SevenEightGrouping,
} from './meterPulse';

export type PianoRollLineStrength = 'bar' | 'group' | 'pulse' | 'none';

export interface PianoRollStepDecoration {
  readonly step: number;
  readonly strength: PianoRollLineStrength;
  /** Ruler label for this step, or null when the step carries no label. */
  readonly label: string | null;
  /** 0-based pulse index inside the bar, or -1 when the step is not a pulse. */
  readonly pulseIndexInBar: number;
  /** 0-based beat-group index inside the bar, or -1 off-pulse. */
  readonly groupIndexInBar: number;
  /** 0-based bar index from the grid origin, or -1 off-pulse. */
  readonly barIndex: number;
}

export interface PianoRollGridModel {
  readonly meter: TimeSignature;
  readonly layout: MeterPulseLayout;
  readonly stepsPerBar: number;
  /** Sixteenth steps between metronome pulses (4 in /4 meters, 2 in /8). */
  readonly stepsPerPulse: number;
  /** Step delta of one-bar navigation (Alt+Arrow). */
  readonly barSteps: number;
  /** Step delta of one-pulse navigation (Shift+Arrow) — 4 in 4/4/3/4. */
  readonly pulseSteps: number;
  /** True while the grid uses the historical quarter-note decoration. */
  readonly legacyQuarterDecoration: boolean;
  /** One entry per grid step. */
  readonly steps: readonly PianoRollStepDecoration[];
}

const LEGACY_QUARTER_METERS: ReadonlySet<string> = new Set(['4/4', '3/4']);

/**
 * Builds the grid decoration for `totalSteps` steps of the active meter.
 * Pure and total: any meter resolves through the runtime authority first, so
 * an unsupported stored value decorates the legacy 4/4 grid exactly like the
 * rest of the runtime plays it.
 */
export function resolvePianoRollGridModel(
  meter: TimeSignature,
  grouping: SevenEightGrouping,
  totalSteps: number
): PianoRollGridModel {
  const layout = resolveMeterPulseLayout(meter, grouping);
  const barSteps = stepsPerBar(layout.meter);
  const legacyQuarterDecoration = LEGACY_QUARTER_METERS.has(`${layout.meter[0]}/${layout.meter[1]}`);
  const stepsPerPulse = layout.stepsPerPulse;

  // Pulse index -> group index lookup derived from the layout's groups.
  const groupOfPulse: number[] = [];
  layout.groups.forEach((size, groupIndex) => {
    for (let i = 0; i < size; i++) groupOfPulse.push(groupIndex);
  });

  const safeTotal = Number.isFinite(totalSteps) && totalSteps > 0 ? Math.floor(totalSteps) : 0;
  const steps: PianoRollStepDecoration[] = [];
  for (let step = 0; step < safeTotal; step++) {
    const isPulse = step % stepsPerPulse === 0;
    if (!isPulse) {
      steps.push({ step, strength: 'none', label: null, pulseIndexInBar: -1, groupIndexInBar: -1, barIndex: -1 });
      continue;
    }
    const pulseIndexInBar = (step % barSteps) / stepsPerPulse;
    const barIndex = Math.floor(step / barSteps);
    const groupIndexInBar = groupOfPulse[pulseIndexInBar] ?? -1;

    if (legacyQuarterDecoration) {
      // Historical scheme: uniform quarter lines with a running quarter count.
      steps.push({
        step,
        strength: 'pulse',
        label: String(Math.floor(step / stepsPerPulse) + 1),
        pulseIndexInBar,
        groupIndexInBar,
        barIndex,
      });
      continue;
    }

    const strength: PianoRollLineStrength =
      pulseIndexInBar === 0 ? 'bar' : layout.pulses[pulseIndexInBar]?.level === 'accent' ? 'group' : 'pulse';
    steps.push({
      step,
      strength,
      label: String(pulseIndexInBar + 1),
      pulseIndexInBar,
      groupIndexInBar,
      barIndex,
    });
  }

  return Object.freeze({
    meter: layout.meter,
    layout,
    stepsPerBar: barSteps,
    stepsPerPulse,
    barSteps: barSteps,
    pulseSteps: stepsPerPulse,
    legacyQuarterDecoration,
    steps: Object.freeze(steps),
  });
}

/**
 * Navigation deltas for the editor. `pulseSteps` keeps the historical
 * Shift+Arrow nudge of one quarter (4 steps) in 4/4 and 3/4, and becomes one
 * eighth (2 steps) in 6/8 and 7/8. `barSteps` is the meter's real bar.
 */
export function pianoRollNavigationDeltas(model: PianoRollGridModel): { pulseSteps: number; barSteps: number } {
  return { pulseSteps: model.pulseSteps, barSteps: model.barSteps };
}
