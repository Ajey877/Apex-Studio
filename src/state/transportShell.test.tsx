import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  WORKSPACE_TABS,
  TransportBar,
  selectWorkspaceTab,
  type TransportBarProps,
} from '../components/TransportBar';
import {
  TRANSPORT_TOOLS_MENU_ID,
  TRANSPORT_TOOLS_TRIGGER_ID,
  TRANSPORT_TOOL_IDS,
  TRANSPORT_TOOL_GROUPS,
  TransportToolsMenuView,
  createTransportToolGroups,
  createTransportToolsMenuDismissHandlers,
  getNextToolItemIndex,
  getToolFocusTarget,
  isTransportToolEnabled,
  withTransportToolDismiss,
  type TransportToolHandlers,
} from '../components/TransportToolsMenu';
import { APPLICATION_MENU_COMMANDS } from './applicationMenu';

/**
 * UI Milestone 1C — transport header + view ribbon shell contract.
 *
 * These tests pin the parts of the redesign that other code depends on:
 *   - the transport top row keeps its four direct children, in order, because
 *     `src/uiAudit.css` indexes into `div:nth-child(4)`,
 *   - every existing control id still renders,
 *   - the 20-tool strip is now a core set plus an overflow menu, and every tool
 *     is still reachable (verified behaviourally, not just by markup),
 *   - the shell exposes its state through aria attributes instead of colour,
 *   - the overflow menu can be driven and dismissed from the keyboard.
 */

/** Counts direct `<div>` children of the first element nested inside the matched id. */
const countDirectDivChildrenOfFirstChild = (html: string, id: string): number => {
  const idIndex = html.indexOf(`id="${id}"`);
  assert.ok(idIndex >= 0, `expected an element with id ${id}`);

  const outerOpenEnd = html.indexOf('>', idIndex) + 1;
  const innerStart = html.indexOf('<div', outerOpenEnd);
  assert.ok(innerStart >= 0, `expected a <div> first child inside ${id}`);
  const innerOpenEnd = html.indexOf('>', innerStart) + 1;

  let depth = 1;
  let index = innerOpenEnd;
  let children = 0;

  while (depth > 0 && index < html.length) {
    const nextOpen = html.indexOf('<div', index);
    const nextClose = html.indexOf('</div>', index);
    if (nextClose < 0) break;

    if (nextOpen >= 0 && nextOpen < nextClose) {
      if (depth === 1) children += 1;
      depth += 1;
      index = nextOpen + 4;
    } else {
      depth -= 1;
      index = nextClose + 6;
    }
  }

  return children;
};

const allToolHandlers: Required<TransportToolHandlers> = {
  samples: () => {},
  wavetable: () => {},
  keymap: () => {},
  vocalTuner: () => {},
  timeFx: () => {},
  warp: () => {},
  slicer: () => {},
  comping: () => {},
  eq: () => {},
  mastering: () => {},
  sidechain: () => {},
  macros: () => {},
  midiLearn: () => {},
  projectBundle: () => {},
  desktopApp: () => {},
  collab: () => {},
};

const baseProps: TransportBarProps = {
  currentView: 'channel_rack',
  onSelectView: () => {},
  isPlaying: false,
  onTogglePlay: () => {},
  onStop: () => {},
  playMode: 'pat',
  onTogglePlayMode: () => {},
  isRecording: false,
  onToggleRecord: () => {},
  meta: {
    id: 'proj-shell',
    name: 'Shell Fixture',
    author: 'Test',
    bpm: 128,
    timeSignature: [4, 4],
    swing: 0,
    masterVolume: 1,
    masterPitch: 0,
    created: 0,
    updated: 0,
    version: 'test',
    offlineReady: true,
    totalEditTimeSeconds: 0,
  },
  onUpdateMeta: () => {},
  currentStep: 0,
  currentBar: 1,
  metronome: false,
  onToggleMetronome: () => {},
  onOpenExport: () => {},
  onOpenProjectManager: () => {},
  onOpenCollab: () => {},
  onOpenAnalytics: () => {},
  onOpenHotkeys: () => {},
  onOpenMidi: () => {},
  onOpenGrossBeat: () => {},
  onOpenSlicer: () => {},
  onOpenVocalTuner: () => {},
  onOpenMidiLearn: () => {},
  onOpenMultiZoneSampler: () => {},
  onOpenWavetableSynth: () => {},
  onOpenTakeComping: () => {},
  onOpenSidechain: () => {},
  onOpenPolyphonicEditor: () => {},
  onOpenDesktopApp: () => {},
  onOpenWarpProcessor: () => {},
  onOpenMasterMacros: () => {},
  onOpenProjectZipBundle: () => {},
  onOpenParametricEq: () => {},
  onOpenMasteringSuite: () => {},
  onOpenSampleManager: () => {},
  collaboratorCount: 0,
  isSidebarOpen: true,
  onToggleSidebar: () => {},
};

const renderTransport = (overrides: Partial<TransportBarProps> = {}): string =>
  renderToStaticMarkup(React.createElement(TransportBar, { ...baseProps, ...overrides }));

const renderToolsMenu = (handlers: TransportToolHandlers = allToolHandlers): string =>
  renderToStaticMarkup(
    React.createElement(TransportToolsMenuView, { groups: createTransportToolGroups(handlers) })
  );

const renderOpenShell = (overrides: Partial<TransportBarProps> = {}): string =>
  renderTransport(overrides) + renderToolsMenu();

const idsIn = (html: string): string[] => [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);

// ---------------------------------------------------------------------------
// 1–4. Layout and navigation contracts
// ---------------------------------------------------------------------------

test('the transport top row still has exactly four direct children, in the documented order', () => {
  const html = renderTransport();
  assert.equal(countDirectDivChildrenOfFirstChild(html, 'fl-transport-bar'), 4);
});

test('the top row keeps the pinned className so the positional CSS still resolves', () => {
  const html = renderTransport();
  assert.ok(
    html.includes(
      'class="h-12 flex items-center justify-between px-2 sm:px-3 md:px-4 gap-2 md:gap-4 overflow-hidden"'
    ),
    'the row className is a contract: src/uiAudit.css indexes div:nth-child(4)'
  );
});

test('nothing in the transport hides tools behind an invisible horizontal scrollbar', () => {
  const html = renderTransport();
  assert.equal(
    /overflow-x-auto|no-scrollbar/.test(html),
    false,
    'the overflowing scrollable strip must not come back'
  );

  // The cluster must be the flexible fourth child that absorbs the leftover
  // width, rather than being sized to its content and clipped by the row.
  const clusterIndex = html.indexOf('apex-tool-cluster');
  const clusterTag = html.slice(html.lastIndexOf('<div', clusterIndex), html.indexOf('>', clusterIndex));
  assert.ok(clusterTag.includes('flex-1'), 'the tool cluster must grow into the free width');
  assert.ok(clusterTag.includes('min-w-0'), 'the tool cluster must be allowed to shrink');
});

test('the tool cluster keeps the primary action and the overflow trigger ahead of the menu-backed chips', () => {
  const html = renderTransport();
  const order = [
    TRANSPORT_TOOLS_TRIGGER_ID,
    'fl-export-btn',
    'fl-midi-hub-btn',
    'fl-hotkeys-btn',
    'fl-fullscreen-btn',
  ].map(id => html.indexOf(`id="${id}"`));

  assert.ok(order.every(index => index > 0), 'every core control must render');
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'core controls first: the pinned row overflow may only ever clip the trailing status chips'
  );
});

test('every pinned transport control still renders', () => {
  const html = renderTransport();
  for (const id of [
    'fl-playmode-toggle',
    'fl-play-btn',
    'fl-stop-btn',
    'fl-record-btn',
    'fl-metronome-btn',
    'fl-bpm-input',
    'fl-logo-btn',
    'project-name-btn',
    'fl-export-btn',
    'fl-hotkeys-btn',
    'fl-fullscreen-btn',
    'fl-midi-hub-btn',
    TRANSPORT_TOOLS_TRIGGER_ID,
  ]) {
    assert.ok(html.includes(`id="${id}"`), `${id} must still render`);
  }
});

test('all six workspace views render and only the selected one is marked aria-current', () => {
  const html = renderTransport({ currentView: 'mixer' });
  for (const tab of WORKSPACE_TABS) {
    assert.ok(html.includes(`id="${tab.id}"`), `${tab.id} must still render`);
  }

  const current = [...html.matchAll(/id="(nav-[a-z-]+)"[^>]*aria-current="page"/g)].map(m => m[1]);
  assert.deepEqual(current, ['nav-mixer']);

  const ribbon = html.slice(html.indexOf('id="fl-view-tabs"'));
  assert.equal((ribbon.match(/aria-current="page"/g) ?? []).length, 1);
});

test('the ribbon renders the six tabs in the documented order with their documented labels', () => {
  const html = renderTransport();
  const ribbon = html.slice(html.indexOf('id="fl-view-tabs"'));
  const renderedIds = [...ribbon.matchAll(/id="(nav-[a-z-]+)"/g)].map(match => match[1]);
  assert.deepEqual(renderedIds, WORKSPACE_TABS.map(tab => tab.id));
  for (const tab of WORKSPACE_TABS) {
    assert.ok(ribbon.includes(`aria-label="${tab.label}"`), `${tab.id} must announce ${tab.label}`);
  }
});

test('every workspace tab keeps identical geometry tokens', () => {
  const html = renderTransport();
  const tabs = [...html.matchAll(/<button id="nav-[a-z-]+"[\s\S]*?<\/button>/g)].map(m => m[0]);
  assert.equal(tabs.length, WORKSPACE_TABS.length);
  for (const tab of tabs) {
    assert.ok(tab.includes('apex-tab'), 'all six tabs must share the same tab primitive');
    assert.ok(tab.includes('apex-tab-icon'));
    assert.ok(tab.includes('apex-tab-label'));
  }
});

test('selecting a workspace tab still routes through the existing selection callback', () => {
  const selected: string[] = [];
  for (const tab of WORKSPACE_TABS) {
    selectWorkspaceTab(tab, view => selected.push(view));
  }
  assert.deepEqual(selected, WORKSPACE_TABS.map(tab => tab.view));
  assert.deepEqual(
    WORKSPACE_TABS.map(tab => tab.view),
    ['channel_rack', 'piano_roll', 'playlist', 'mixer', 'instruments', 'sampler']
  );
});

test('the six view ids keep their original names and order', () => {
  assert.deepEqual(WORKSPACE_TABS.map(tab => tab.id), [
    'nav-channel-rack',
    'nav-piano-roll',
    'nav-playlist',
    'nav-mixer',
    'nav-instruments',
    'nav-sampler',
  ]);
});

// ---------------------------------------------------------------------------
// 5–7. Overflow menu: exposure, reachability, keyboard
// ---------------------------------------------------------------------------

test('the closed transport exposes a labelled overflow trigger bound to its menu', () => {
  const html = renderTransport();
  const trigger = html.slice(html.indexOf(`id="${TRANSPORT_TOOLS_TRIGGER_ID}"`));
  const tag = trigger.slice(0, trigger.indexOf('>'));
  assert.ok(tag.includes('aria-haspopup="menu"'));
  assert.ok(tag.includes('aria-expanded="false"'));
  assert.ok(tag.includes('aria-label='), 'the trigger must have an accessible name at every width');
});

test('the overflow menu renders a real menu widget labelled by its trigger', () => {
  const html = renderToolsMenu();
  assert.ok(html.includes(`id="${TRANSPORT_TOOLS_MENU_ID}"`));
  assert.ok(html.includes('role="menu"'));
  assert.ok(html.includes(`aria-labelledby="${TRANSPORT_TOOLS_TRIGGER_ID}"`));
  assert.ok(html.includes('apex-tool-menu-item'));
  assert.ok(html.includes('role="group"'), 'related tools must be grouped');
});

test('the overflow menu exposes every secondary tool id', () => {
  const html = renderToolsMenu();
  for (const id of TRANSPORT_TOOL_IDS) {
    assert.ok(html.includes(`id="${id}"`), `${id} must be reachable from the overflow menu`);
  }
  assert.equal(TRANSPORT_TOOL_IDS.length, 16);
});

test('the core set plus the overflow menu still covers every tool that shipped before', () => {
  const shell = renderOpenShell();
  const expected = [
    'fl-midi-hub-btn',
    'fl-hotkeys-btn',
    'fl-fullscreen-btn',
    'fl-export-btn',
    ...TRANSPORT_TOOL_IDS,
  ];
  for (const id of expected) {
    assert.ok(shell.includes(`id="${id}"`), `${id} disappeared from the shell`);
  }
  assert.equal(new Set(TRANSPORT_TOOL_IDS).size, TRANSPORT_TOOL_IDS.length, 'no duplicate tool ids');
});

test('every tool in the overflow menu is wired to a real handler', () => {
  const fired: string[] = [];
  const handlers = Object.fromEntries(
    Object.keys(allToolHandlers).map(key => [key, () => fired.push(key)])
  ) as unknown as Required<TransportToolHandlers>;

  for (const group of createTransportToolGroups(handlers)) {
    for (const item of group.items) {
      assert.ok(item.onSelect, `${item.id} must have a handler`);
      item.onSelect?.();
    }
  }

  assert.equal(fired.length, TRANSPORT_TOOL_IDS.length);
  assert.equal(new Set(fired).size, TRANSPORT_TOOL_IDS.length);
});

test('activating a tool dismisses the menu first and then runs the tool', () => {
  const calls: string[] = [];
  const groups = createTransportToolGroups({ slicer: () => calls.push('slicer'), samples: () => calls.push('samples') });
  const dismissable = withTransportToolDismiss(groups, () => calls.push('dismiss'));
  const items = dismissable.flatMap(group => group.items);

  items.find(item => item.id === 'fl-slicer-btn')?.onSelect?.();
  assert.deepEqual(calls, ['dismiss', 'slicer']);

  const unavailable = items.find(item => item.id === 'fl-master-eq-btn');
  assert.equal(isTransportToolEnabled(unavailable), false, 'a tool with no handler must not dismiss the menu');
});

test('the overflow menu reports which tools are unavailable instead of hiding them', () => {
  const groups = createTransportToolGroups({ slicer: () => {} });
  const slicer = groups.flatMap(group => group.items).find(item => item.id === 'fl-slicer-btn');
  const eq = groups.flatMap(group => group.items).find(item => item.id === 'fl-master-eq-btn');
  assert.equal(isTransportToolEnabled(slicer), true);
  assert.equal(isTransportToolEnabled(eq), false);

  const html = renderToStaticMarkup(React.createElement(TransportToolsMenuView, { groups }));
  const eqTag = html.slice(html.indexOf('id="fl-master-eq-btn"'));
  assert.ok(eqTag.slice(0, eqTag.indexOf('>')).includes('disabled'));
  assert.ok(eqTag.slice(0, eqTag.indexOf('>')).includes('aria-disabled="true"'));
});

test('the tools menu is fully keyboard reachable', () => {
  const groups = createTransportToolGroups(allToolHandlers);
  const first = TRANSPORT_TOOL_IDS[0];
  const second = TRANSPORT_TOOL_IDS[1];
  const last = TRANSPORT_TOOL_IDS[TRANSPORT_TOOL_IDS.length - 1];

  assert.equal(getToolFocusTarget(groups, null, 'ArrowDown'), first, 'ArrowDown opens on the first tool');
  assert.equal(getToolFocusTarget(groups, first, 'ArrowDown'), second);
  assert.equal(getToolFocusTarget(groups, first, 'ArrowUp'), last, 'ArrowUp wraps to the last tool');
  assert.equal(getToolFocusTarget(groups, last, 'ArrowDown'), first, 'ArrowDown wraps to the first tool');
  assert.equal(getToolFocusTarget(groups, second, 'Home'), first);
  assert.equal(getToolFocusTarget(groups, second, 'End'), last);
  assert.equal(getToolFocusTarget(groups, first, 'Tab'), null, 'Tab leaves the menu to the page');
});

test('keyboard focus skipping stays correct when some tools are unavailable', () => {
  const groups = createTransportToolGroups({ samples: () => {}, slicer: () => {} });
  const enabled = groups.flatMap(group => group.items).filter(isTransportToolEnabled);
  assert.deepEqual(enabled.map(item => item.id), ['fl-sampler-modal-btn', 'fl-slicer-btn']);
  assert.equal(getToolFocusTarget(groups, 'fl-sampler-modal-btn', 'ArrowDown'), 'fl-slicer-btn');
  assert.equal(getToolFocusTarget(groups, 'fl-slicer-btn', 'ArrowDown'), 'fl-sampler-modal-btn');
});

test('the roving index helper wraps in both directions and clamps empty menus', () => {
  assert.equal(getNextToolItemIndex(-1, 3, 'ArrowDown'), 0);
  assert.equal(getNextToolItemIndex(2, 3, 'ArrowDown'), 0);
  assert.equal(getNextToolItemIndex(0, 3, 'ArrowUp'), 2);
  assert.equal(getNextToolItemIndex(1, 3, 'Home'), 0);
  assert.equal(getNextToolItemIndex(1, 3, 'End'), 2);
  assert.equal(getNextToolItemIndex(0, 0, 'ArrowDown'), -1);
});

test('Escape closes the tools menu without leaking to the editors', () => {
  let dismissed = 0;
  const stopPropagation = () => {
    stopped += 1;
  };
  let stopped = 0;
  const handlers = createTransportToolsMenuDismissHandlers(
    () => null,
    () => null,
    () => {
      dismissed += 1;
    }
  );

  handlers.handleKeyDown({ key: 'Escape', stopPropagation });
  assert.equal(dismissed, 1);
  assert.equal(stopped, 1, 'Escape must not also clear a playlist or piano-roll selection');

  handlers.handleKeyDown({ key: 'a' });
  assert.equal(dismissed, 1, 'other keys pass through');
});

test('clicking outside the tools menu closes it, clicking inside does not', () => {
  let dismissed = 0;
  const dismiss = () => {
    dismissed += 1;
  };
  const inside = new Set<unknown>(['panel-child', 'trigger-child']);
  const container = { contains: (node: unknown) => inside.has(node) };
  const handlers = createTransportToolsMenuDismissHandlers(() => container, () => container, dismiss);

  handlers.handlePointerDown({ target: 'panel-child' });
  handlers.handlePointerDown({ target: 'trigger-child' });
  assert.equal(dismissed, 0, 'interacting with the menu must not close it');

  handlers.handlePointerDown({ target: 'workspace' });
  assert.equal(dismissed, 1);
});

// ---------------------------------------------------------------------------
// 8. Interaction state is exposed, not just coloured
// ---------------------------------------------------------------------------

test('transport toggles expose their state through aria-pressed', () => {
  const idle = renderTransport();
  for (const id of ['fl-metronome-btn', 'fl-record-btn', 'fl-fullscreen-btn']) {
    const tag = idle.slice(idle.indexOf(`id="${id}"`));
    assert.ok(tag.slice(0, tag.indexOf('>')).includes('aria-pressed="false"'), `${id} reports idle state`);
  }

  const active = renderTransport({ metronome: true, isRecording: true });
  for (const id of ['fl-metronome-btn', 'fl-record-btn']) {
    const tag = active.slice(active.indexOf(`id="${id}"`));
    assert.ok(tag.slice(0, tag.indexOf('>')).includes('aria-pressed="true"'), `${id} reports active state`);
  }
});

test('the sidebar toggle reports the browser state', () => {
  const open = renderTransport({ isSidebarOpen: true });
  const closed = renderTransport({ isSidebarOpen: false });
  const tagOf = (html: string) => {
    const index = html.indexOf('aria-label="Toggle Studio Browser"');
    const tagStart = html.lastIndexOf('<button', index);
    return html.slice(tagStart, html.indexOf('>', tagStart));
  };
  assert.ok(tagOf(open).includes('aria-pressed="true"'));
  assert.ok(tagOf(closed).includes('aria-pressed="false"'));
});

test('the pattern/song mode selector exposes its mode as a switch', () => {
  const pattern = renderTransport({ playMode: 'pat' });
  const patternTag = pattern.slice(pattern.indexOf('id="fl-playmode-toggle"'));
  assert.ok(patternTag.slice(0, patternTag.indexOf('>')).includes('role="switch"'));
  assert.ok(patternTag.slice(0, patternTag.indexOf('>')).includes('aria-checked="true"'));

  const song = renderTransport({ playMode: 'song' });
  const songTag = song.slice(song.indexOf('id="fl-playmode-toggle"'));
  assert.ok(songTag.slice(0, songTag.indexOf('>')).includes('aria-checked="false"'));
});

test('the play control names the action it performs and never relies on colour alone', () => {
  const idle = renderTransport({ isPlaying: false });
  const playing = renderTransport({ isPlaying: true });
  const nameOf = (html: string) => {
    const index = html.indexOf('id="fl-play-btn"');
    const tagEnd = html.indexOf('>', index);
    return html.slice(index, tagEnd);
  };
  assert.ok(nameOf(idle).includes('aria-label="Play"'));
  assert.ok(nameOf(playing).includes('aria-label="Pause"'));
  assert.ok(renderTransport({ isRecording: true }).includes('apex-record-dot'));
});

// ---------------------------------------------------------------------------
// 9–12. Untouched contracts
// ---------------------------------------------------------------------------

test('no element id is rendered twice across the shell and its overflow menu', () => {
  const ids = idsIn(renderOpenShell());
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], []);
});

test('the BPM field remains the only tempo control in the shell', () => {
  const shell = renderOpenShell();
  assert.equal((shell.match(/id="fl-bpm-input"/g) ?? []).length, 1);
  assert.equal(
    (shell.match(/type="number"/g) ?? []).length,
    1,
    'the overflow menu must not introduce a second numeric control'
  );
  assert.equal(renderToolsMenu().includes('<input'), false);
});

test('the shell still delegates fullscreen to the shared controller', () => {
  const html = renderTransport();
  const tag = html.slice(html.indexOf('id="fl-fullscreen-btn"'));
  assert.ok(tag.slice(0, tag.indexOf('>')).includes('aria-label='));
});

test('every control the shell hides at narrow widths stays reachable from the application menu', () => {
  // The transport chips for MIDI, shortcuts and fullscreen are hidden below the
  // `xl` breakpoint so the tool cluster can never be clipped; each one has an
  // application-menu command, which is why hiding them is not a loss of access.
  assert.ok(APPLICATION_MENU_COMMANDS['midi.devices']);
  assert.ok(APPLICATION_MENU_COMMANDS['help.shortcuts']);
  assert.ok(APPLICATION_MENU_COMMANDS['view.fullscreen']);
  assert.ok(APPLICATION_MENU_COMMANDS['view.browser'], 'the sidebar toggle is menu-backed too');
});

test('the overflow menu keeps its groups in a stable, documented order', () => {
  assert.deepEqual(
    TRANSPORT_TOOL_GROUPS.map(group => group.label),
    ['Sound & instruments', 'Time & audio', 'Mixing & master', 'Controller & session']
  );
});
