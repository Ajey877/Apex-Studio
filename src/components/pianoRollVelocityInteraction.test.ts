import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(new URL('./PianoRoll.tsx', import.meta.url), 'utf8');
const drawerStart = source.indexOf('{/* Velocity Stalks Editor Drawer */}');
const velocityDrawer = source.slice(drawerStart);

/**
 * This is a deliberately narrow component-wiring guard. The browser workflow
 * test drives real pointer events; this catches the original regression early:
 * a visible “Click & drag” control wired only to `onClick` cannot receive a
 * continuous drag stream.
 */
test('Piano Roll velocity stalks start a note-id-stable pointer interaction', () => {
  assert.notEqual(drawerStart, -1, 'the velocity drawer is present');
  assert.match(velocityDrawer, /data-velocity-note-id=\{n\.id\}/,
    'each rendered stalk exposes its stable project note id');
  assert.match(velocityDrawer, /onPointerDown=\{\(event\) => beginVelocityInteraction\(event, n\.id\)\}/,
    'the stalk begins editing on pointer down rather than waiting for click');
  assert.doesNotMatch(velocityDrawer, /onClick=\{\(e\) => \{/,
    'a release-only click handler must not be the velocity-edit path');
  assert.match(velocityDrawer, /h-20 shrink-0/,
    'the flex layout must preserve enough lane height for visible, hittable stalks');
});

test('Piano Roll velocity gestures publish continuous note updates and clean up outside the lane', () => {
  assert.match(source, /note\.id === noteId/,
    'edits are applied by stable note id rather than current selection or array position');
  assert.match(source, /Math\.max\(0\.05, Math\.min\(1,/,
    'velocity keeps the established 0.05–1.0 range');
  assert.match(source, /onUpdateChannelRef\.current\(active\.channelId,\s*\{ notes: newNotes \},\s*\{ isContinuous: true \}\)/,
    'live velocity values flow through the existing continuous project mutation path');
  assert.match(source, /window\.addEventListener\('pointermove'/,
    'drag updates continue after the pointer leaves the original stalk');
  assert.match(source, /window\.addEventListener\('pointerup'/,
    'release outside the stalk finalizes the interaction');
  assert.match(source, /window\.addEventListener\('pointercancel'/,
    'pointer cancellation finalizes the interaction');
});
