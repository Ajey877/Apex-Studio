/**
 * Phase 1K — meter-aware transport beat display.
 *
 * The beat display is pure presentational math over the metronome pulse
 * layout, so the checks are static-render pin tests in the phase1h spirit:
 *   - 4/4 and 3/4 keep their historical bar.beat.step numbers exactly
 *     (the phase1h pins 02.2.2 / 02.2.1 must stay true);
 *   - 6/8 shows all six eighth pulses (two sixteenth subdivisions each) with
 *     the 3+3 dotted-quarter grouping made visible as a strip;
 *   - 7/8 shows the selected grouping (2+2+3 / 3+2+2 / 2+3+2) with the active
 *     group lit by the playhead's pulse;
 *   - the display only READS the meter — no stored note or clip position
 *     changes with the grouping (asserted via the pure models).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import TransportBar from './TransportBar';
import type { ProjectMetadata } from '../types/daw';
import type { TimeSignature } from '../music/musicalTime';
import type { SevenEightGrouping } from '../music/meterPulse';

const noop = () => {};

function renderBar(
  meter: TimeSignature,
  grouping?: SevenEightGrouping,
  currentStep = 0,
  currentBar = 1
): string {
  const meta: ProjectMetadata = {
    id: 'proj-1k',
    name: 'Phase 1K Fixture',
    author: 'Test',
    bpm: 128,
    timeSignature: [meter[0], meter[1]],
    sevenEightGrouping: grouping,
    swing: 0,
    masterVolume: 1,
    masterPitch: 0,
    created: 0,
    updated: 0,
    version: 'test',
    offlineReady: true,
    totalEditTimeSeconds: 0,
  };
  return renderToStaticMarkup(
    <TransportBar
      currentView="channel_rack"
      onSelectView={noop}
      isPlaying={false}
      onTogglePlay={noop}
      onStop={noop}
      playMode="pat"
      onTogglePlayMode={noop}
      isRecording={false}
      onToggleRecord={noop}
      meta={meta}
      onUpdateMeta={noop}
      currentStep={currentStep}
      currentBar={currentBar}
      metronome={false}
      onToggleMetronome={noop}
      onOpenExport={noop}
      onOpenProjectManager={noop}
      onOpenCollab={noop}
      onOpenAnalytics={noop}
      onOpenHotkeys={noop}
      onOpenMidi={noop}
      collaboratorCount={0}
      isSidebarOpen
      onToggleSidebar={noop}
    />
  );
}

function barPosition(html: string): string {
  const match = html.match(/title="Bar . beat . step">([^<]*)</);
  assert.ok(match, 'the Bar position cell must render');
  return match[1];
}

function groupStrip(html: string): { grouping: string; active: string; sizes: string[] } | null {
  const marker = html.match(
    /data-testid="transport-beat-groups" data-grouping="([^"]*)" data-active-group="(\d+)"/
  );
  if (!marker) return null;
  const sizes = [...html.matchAll(/data-group-index="\d+" data-group-size="(\d+)"/g)].map(
    match => match[1]
  );
  return { grouping: marker[1], active: marker[2], sizes };
}

describe('Phase 1K TEST 1 — 4/4 and 3/4 keep their historical beat display', () => {
  it('4/4 keeps the phase1h bar.beat.step numbers', () => {
    assert.equal(barPosition(renderBar([4, 4], undefined, 0, 1)), '01.1.1');
    assert.equal(barPosition(renderBar([4, 4], undefined, 5, 2)), '02.2.2', 'phase1h pin');
    assert.equal(barPosition(renderBar([4, 4], undefined, 12, 1)), '01.4.1');
  });

  it('3/4 keeps the phase1h bar.beat.step numbers', () => {
    assert.equal(barPosition(renderBar([3, 4], undefined, 4, 2)), '02.2.1', 'phase1h pin');
    // 3/4 keeps its historical four-way subdivision of the quarter beat.
    assert.equal(barPosition(renderBar([3, 4], undefined, 11, 1)), '01.3.4');
  });

  it('4/4 and 3/4 show no extra group strip (their beats already are the grouping)', () => {
    assert.equal(groupStrip(renderBar([4, 4])), null);
    assert.equal(groupStrip(renderBar([3, 4])), null);
  });
});

describe('Phase 1K TEST 2 — 6/8 shows the 3+3 dotted-quarter grouping', () => {
  it('renders all twelve eighth-pulse positions in a bar (6 pulses × 2 subdivisions)', () => {
    const expected = [
      '01.1.1', '01.1.2',
      '01.2.1', '01.2.2',
      '01.3.1', '01.3.2',
      '01.4.1', '01.4.2',
      '01.5.1', '01.5.2',
      '01.6.1', '01.6.2',
    ];
    expected.forEach((position, step) => {
      assert.equal(barPosition(renderBar([6, 8], undefined, step, 1)), position, `step ${step}`);
    });
  });

  it('shows the two dotted-quarter groups as a 3+3 strip', () => {
    const strip = groupStrip(renderBar([6, 8]));
    assert.ok(strip, '6/8 must render the group strip');
    assert.equal(strip.grouping, '3+3');
    assert.deepEqual(strip.sizes, ['3', '3']);
    assert.equal(strip.active, '0');
  });

  it('the active group follows the playhead (step 7 = pulse 3 = second group)', () => {
    const strip = groupStrip(renderBar([6, 8], undefined, 7, 1));
    assert.ok(strip);
    assert.equal(strip.active, '1');
  });
});

describe('Phase 1K TEST 3 — 7/8 renders the selected grouping, not a swapped display', () => {
  it('2+2+3: seven eighth pulses plus the matching strip', () => {
    const html = renderBar([7, 8], '2+2+3');
    // Step 9 is the second subdivision of the fifth pulse (pulses are 2 steps).
    assert.equal(barPosition(renderBar([7, 8], '2+2+3', 9, 1)), '01.5.2');
    assert.equal(barPosition(renderBar([7, 8], '2+2+3', 13, 1)), '01.7.2');
    const strip = groupStrip(html);
    assert.ok(strip);
    assert.equal(strip.grouping, '2+2+3');
    assert.deepEqual(strip.sizes, ['2', '2', '3']);
    assert.equal(strip.active, '0');
  });

  it('3+2+2 and 2+3+2 show their own strips', () => {
    const a = groupStrip(renderBar([7, 8], '3+2+2'));
    assert.ok(a);
    assert.equal(a.grouping, '3+2+2');
    assert.deepEqual(a.sizes, ['3', '2', '2']);
    const b = groupStrip(renderBar([7, 8], '2+3+2'));
    assert.ok(b);
    assert.equal(b.grouping, '2+3+2');
    assert.deepEqual(b.sizes, ['2', '3', '2']);
  });

  it('the active group follows the pulse of the selected grouping (step 4 → group 1 of 2+2+3)', () => {
    // Step 4 is the first pulse of the second 2-pulse group in 2+2+3,
    // but the first pulse of the 3-pulse group in 2+3+2 — same stored
    // position, displayed under each grouping without moving anything.
    const a = groupStrip(renderBar([7, 8], '2+2+3', 4, 1));
    assert.ok(a);
    assert.equal(a.active, '1');
    const b = groupStrip(renderBar([7, 8], '2+3+2', 4, 1));
    assert.ok(b);
    assert.equal(b.active, '1');
    const c = groupStrip(renderBar([7, 8], '2+3+2', 7, 1));
    assert.ok(c);
    assert.equal(c.active, '1', 'step 7 is the middle of the 3-pulse group');
    const d = groupStrip(renderBar([7, 8], '2+3+2', 10, 1));
    assert.ok(d);
    assert.equal(d.active, '2', 'step 10 is the final 2-pulse group');
  });
});

describe('Phase 1K TEST 4 — the display only reads the meter', () => {
  it('every grouping renders the same seven stored positions in 7/8', () => {
    for (const grouping of ['2+2+3', '3+2+2', '2+3+2'] as SevenEightGrouping[]) {
      const positions = Array.from({ length: 14 }, (_, step) =>
        barPosition(renderBar([7, 8], grouping, step, 1))
      );
      assert.deepEqual(positions[0], '01.1.1');
      assert.deepEqual(positions[13], '01.7.2', `${grouping} keeps the 14 stored steps`);
    }
  });

  it('the group strip sits inside the Bar cell without extra top-level layout columns', () => {
    const html = renderBar([7, 8], '2+2+3');
    // uiAudit.css indexes exactly 4 direct children of the top navbar row.
    const row = html.match(/class="h-12 flex items-center justify-between[^"]*">/);
    assert.ok(row, 'the transport row must render');
    assert.ok(html.includes('data-testid="transport-beat-groups"'));
  });
});
