import React, { useState } from 'react';
import { ModalFrame } from './ModalFrame';
import { stepsPerBar, type TimeSignature } from '../music/musicalTime';
import {
  SEVEN_EIGHT_GROUPINGS,
  SUPPORTED_TIME_SIGNATURES,
  describeStoredTimeSignature,
  formatTimeSignature,
  isSameTimeSignature,
  isSevenEightGrouping,
  parseSupportedTimeSignature,
  resolveMeterPulseLayout,
  resolveSevenEightGrouping,
  type MeterPulseLayout,
  type SevenEightGrouping,
} from '../music/meterPulse';
import { COUNT_IN_OPTIONS, describeCountInBars, isCountInBars, resolveCountInBars, type CountInBars } from '../music/countIn';

/**
 * Phase 1J — Project Settings: the time-signature selector and the 7/8
 * metronome accent grouping.
 *
 * The dialog only offers the four meters the runtime executes truthfully. Every
 * selection is parsed again by `selectProjectTimeSignature`, so a value that is
 * not 4/4, 3/4, 6/8 or 7/8 (a stale DOM value, a hand-built event) is rejected
 * with a visible message instead of being written to the project.
 */

export interface ProjectSettingsSelectionHandlers {
  onSelectTimeSignature: (meter: [number, number]) => void;
  onSelectSevenEightGrouping: (grouping: SevenEightGrouping) => void;
  /**
   * Phase 1K: recording count-in length. Optional so embedders without a
   * recording workflow keep the Phase 1J dialog unchanged; when provided the
   * dialog shows the Off / 1 bar / 2 bars selector.
   */
  onSelectCountInBars?: (bars: CountInBars) => void;
}

export type SelectionOutcome =
  | { status: 'applied'; label: string }
  | { status: 'unchanged'; label: string }
  | { status: 'rejected'; message: string };

/** Pure selector behaviour shared by the dialog and its tests. */
export function selectProjectTimeSignature(
  value: unknown,
  current: unknown,
  handlers: Pick<ProjectSettingsSelectionHandlers, 'onSelectTimeSignature'>
): SelectionOutcome {
  const meter = parseSupportedTimeSignature(value);
  if (!meter) {
    return {
      status: 'rejected',
      message: `${String(value)} is not available. Choose 4/4, 3/4, 6/8 or 7/8.`,
    };
  }
  const label = formatTimeSignature(meter);
  if (isSameTimeSignature(current as readonly number[] | undefined, meter)) return { status: 'unchanged', label };
  handlers.onSelectTimeSignature([meter[0], meter[1]]);
  return { status: 'applied', label };
}

export function selectSevenEightGrouping(
  value: unknown,
  current: unknown,
  handlers: Pick<ProjectSettingsSelectionHandlers, 'onSelectSevenEightGrouping'>
): SelectionOutcome {
  if (!isSevenEightGrouping(value)) {
    return { status: 'rejected', message: `${String(value)} is not a 7/8 grouping. Choose 2+2+3, 3+2+2 or 2+3+2.` };
  }
  if (resolveSevenEightGrouping({ sevenEightGrouping: current }) === value) {
    return { status: 'unchanged', label: value };
  }
  handlers.onSelectSevenEightGrouping(value);
  return { status: 'applied', label: value };
}

/** Phase 1K: pure count-in selector behaviour shared by the dialog and tests. */
export function selectRecordingCountIn(
  value: unknown,
  current: unknown,
  handlers: Pick<ProjectSettingsSelectionHandlers, 'onSelectCountInBars'>
): SelectionOutcome {
  if (!isCountInBars(value)) {
    return { status: 'rejected', message: `${String(value)} is not a count-in length. Choose Off, 1 bar or 2 bars.` };
  }
  if (resolveCountInBars({ countInBars: current }) === value) {
    return { status: 'unchanged', label: describeCountInBars(value) };
  }
  handlers.onSelectCountInBars?.(value);
  return { status: 'applied', label: describeCountInBars(value) };
}

const METER_DESCRIPTIONS: Record<string, string> = {
  '4/4': 'Four quarter-note beats',
  '3/4': 'Three quarter-note beats (waltz)',
  '6/8': 'Six eighth notes, felt 3+3',
  '7/8': 'Seven eighth notes, grouped below',
};

const PulsePreview: React.FC<{ layout: MeterPulseLayout; testId?: string }> = ({ layout, testId }) => (
  <span className="inline-flex items-center gap-1" aria-hidden="true" data-testid={testId}>
    {layout.pulses.map(pulse => (
      <span
        key={pulse.index}
        data-pulse-level={pulse.level}
        className={`inline-block rounded-full ${
          pulse.level === 'downbeat'
            ? 'h-2.5 w-2.5 bg-[var(--apex-accent)]'
            : pulse.level === 'accent'
              ? 'h-2 w-2 bg-[var(--apex-text)]'
              : 'h-1.5 w-1.5 bg-[var(--apex-text-3)]'
        }`}
      />
    ))}
  </span>
);

export interface ProjectSettingsModalProps extends ProjectSettingsSelectionHandlers {
  isOpen: boolean;
  /** The stored `meta.timeSignature` (may be unsupported in an older project). */
  timeSignature: unknown;
  /** The stored `meta.sevenEightGrouping` (optional). */
  sevenEightGrouping: unknown;
  /** Phase 1K: the stored `meta.countInBars` (optional). */
  countInBars?: unknown;
  onClose: () => void;
}

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({
  isOpen,
  timeSignature,
  sevenEightGrouping,
  countInBars,
  onSelectTimeSignature,
  onSelectSevenEightGrouping,
  onSelectCountInBars,
  onClose,
}) => {
  const [message, setMessage] = useState<string | null>(null);
  if (!isOpen) return null;

  const stored = describeStoredTimeSignature(timeSignature);
  const grouping = resolveSevenEightGrouping({ sevenEightGrouping });
  const activeLayout = resolveMeterPulseLayout(stored.runtime, grouping);
  const isSevenEight = stored.supported && stored.runtime[0] === 7 && stored.runtime[1] === 8;
  const countInSelection = resolveCountInBars({ countInBars });

  const handleMeter = (value: string) => {
    const outcome = selectProjectTimeSignature(value, timeSignature, { onSelectTimeSignature });
    setMessage(outcome.status === 'rejected' ? outcome.message : null);
  };
  const handleGrouping = (value: string) => {
    const outcome = selectSevenEightGrouping(value, sevenEightGrouping, { onSelectSevenEightGrouping });
    setMessage(outcome.status === 'rejected' ? outcome.message : null);
  };
  const handleCountIn = (value: unknown) => {
    const outcome = selectRecordingCountIn(value, countInBars, { onSelectCountInBars });
    setMessage(outcome.status === 'rejected' ? outcome.message : null);
  };

  return (
    <ModalFrame
      id="project-settings-modal"
      labelledBy="project-settings-modal-title"
      onClose={onClose}
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
    >
      <div className="apex-dialog w-[min(92vw,34rem)] border border-[var(--apex-border)] bg-[var(--apex-surface)] p-5 text-[var(--apex-text)]">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="project-settings-modal-title" className="text-base font-semibold">Project Settings</h2>
            <p className="mt-1 text-xs text-[var(--apex-text-2)]">Meter and metronome for this project</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close Project Settings" className="apex-icon-btn rounded-md px-2 text-[var(--apex-text-2)] hover:text-[var(--apex-text)]">✕</button>
        </div>

        <div className="mb-4 flex items-center justify-between rounded-lg border border-[var(--apex-border)] p-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--apex-text-3)]">Active time signature</div>
            <div id="project-settings-active-meter" className="font-mono text-2xl font-bold" data-active-meter={formatTimeSignature(stored.runtime)}>
              {formatTimeSignature(stored.runtime)}
            </div>
          </div>
          <PulsePreview layout={activeLayout} testId="project-settings-active-pulses" />
        </div>

        {!stored.supported && (
          <p role="alert" className="mb-3 rounded-md border border-[var(--apex-warning,#d97706)] p-2 text-xs">
            This project stores an unsupported time signature ({stored.label}); it plays as 4/4. Choose a supported meter to replace it.
          </p>
        )}

        <fieldset className="mb-4">
          <legend className="mb-2 text-sm font-semibold">Time signature</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Time signature">
            {SUPPORTED_TIME_SIGNATURES.map((meter: TimeSignature) => {
              const label = formatTimeSignature(meter);
              const checked = stored.supported && isSameTimeSignature(stored.runtime, meter);
              return (
                <label
                  key={label}
                  className={`cursor-pointer rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-[var(--apex-state-focus)] ${checked ? 'border-[var(--apex-accent)] bg-[var(--apex-state-selected)]' : 'border-[var(--apex-border)] hover:border-[var(--apex-accent)]'}`}
                >
                  <input type="radio" name="project-time-signature" value={label} checked={checked} onChange={() => handleMeter(label)} className="sr-only" />
                  <span className="block font-mono text-sm font-semibold">{label}</span>
                  <span className="mt-0.5 block text-[11px] text-[var(--apex-text-2)]">{METER_DESCRIPTIONS[label]} · {stepsPerBar(meter)} steps/bar</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {isSevenEight && (
          <fieldset className="mb-4">
            <legend className="mb-2 text-sm font-semibold">7/8 accent grouping</legend>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="7/8 accent grouping">
              {SEVEN_EIGHT_GROUPINGS.map(option => {
                const checked = grouping === option;
                return (
                  <label
                    key={option}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-[var(--apex-state-focus)] ${checked ? 'border-[var(--apex-accent)] bg-[var(--apex-state-selected)]' : 'border-[var(--apex-border)] hover:border-[var(--apex-accent)]'}`}
                  >
                    <input type="radio" name="project-seven-eight-grouping" value={option} checked={checked} onChange={() => handleGrouping(option)} className="sr-only" />
                    <span className="block font-mono text-sm font-semibold">{option}</span>
                    <span className="mt-1 block"><PulsePreview layout={resolveMeterPulseLayout([7, 8], option)} /></span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-[var(--apex-text-2)]">
              Sets which eighth notes the metronome accents and where the ruler draws group lines. It never moves notes.
            </p>
          </fieldset>
        )}

        {onSelectCountInBars && (
          <fieldset className="mb-4" data-testid="project-settings-count-in">
            <legend className="mb-2 text-sm font-semibold">Recording count-in</legend>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Recording count-in">
              {COUNT_IN_OPTIONS.map(option => {
                const checked = countInSelection === option;
                return (
                  <label
                    key={option}
                    className={`cursor-pointer rounded-lg border p-2.5 transition-colors focus-within:ring-2 focus-within:ring-[var(--apex-state-focus)] ${checked ? 'border-[var(--apex-accent)] bg-[var(--apex-state-selected)]' : 'border-[var(--apex-border)] hover:border-[var(--apex-accent)]'}`}
                  >
                    <input
                      type="radio"
                      name="project-count-in"
                      value={option}
                      checked={checked}
                      onChange={() => handleCountIn(option)}
                      className="sr-only"
                      data-count-in={option}
                    />
                    <span className="block font-mono text-sm font-semibold">{describeCountInBars(option)}</span>
                  </label>
                );
              })}
            </div>
            <p className="mt-2 text-[11px] text-[var(--apex-text-2)]">
              Bars of metronome clicks before recording starts, at the project tempo and meter. Count-in clicks are never recorded.
            </p>
          </fieldset>
        )}

        {message && <p role="alert" className="mb-3 text-xs text-[var(--apex-danger)]">{message}</p>}

        <p className="text-[11px] leading-relaxed text-[var(--apex-text-2)]">
          Clips keep their bar positions when the meter changes — a clip on bar 5 stays on bar 5 — so
          each bar becomes shorter or longer in time. Pattern notes are not moved. Undo restores the previous meter.
        </p>
      </div>
    </ModalFrame>
  );
};
