import React from 'react';
import { resolveMeterPulseLayout, resolveRulerTicks, type SevenEightGrouping } from '../music/meterPulse';
import type { TimeSignature } from '../music/musicalTime';

/**
 * Phase 1J — meter-aware beat divisions inside one playlist ruler bar.
 *
 * Bars keep their fixed on-screen width (so a clip's `startBar` maps to the
 * same pixel column in every meter); only the subdivisions inside the bar
 * follow the resolved meter: 3 quarter ticks in 3/4, 6 eighth ticks with a
 * stronger 3+3 line in 6/8, 7 eighth ticks with the chosen grouping in 7/8.
 */
export const PlaylistRulerTicks: React.FC<{ meter: TimeSignature; grouping: SevenEightGrouping }> = ({ meter, grouping }) => {
  const layout = resolveMeterPulseLayout(meter, grouping);
  return (
    <span
      className="pointer-events-none absolute inset-0"
      aria-hidden="true"
      data-ruler-pulses={layout.pulses.length}
      data-ruler-steps-per-bar={layout.stepsPerBar}
    >
      {resolveRulerTicks(layout).map(tick => (
        <span
          key={tick.fraction}
          data-ruler-tick={tick.level}
          className={`absolute bottom-0 w-px ${tick.level === 'accent' ? 'h-3 bg-[var(--apex-text-2)]' : 'h-1.5 bg-[var(--apex-text-3)]'}`}
          style={{ left: `${(tick.fraction * 100).toFixed(4)}%` }}
        />
      ))}
    </span>
  );
};
