import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLICATION_MENU_COMMANDS,
  APPLICATION_MENUS,
  type ApplicationMenuCommandId,
  type ApplicationMenuItem,
} from './applicationMenu';
import {
  isApplicationMenuCommandChecked,
  isApplicationMenuCommandEnabled,
  runApplicationMenuCommand,
  type ApplicationMenuCommandDeps,
} from './applicationMenuCommands';
import type { ViewMode } from '../types/daw';

interface Recorded {
  calls: string[];
  views: ViewMode[];
  order: string[];
}

const createDeps = (overrides: Partial<ApplicationMenuCommandDeps> = {}, recorded?: Recorded) => {
  const calls: string[] = recorded?.calls ?? [];
  const views: ViewMode[] = recorded?.views ?? [];
  const record = (name: string) => {
    calls.push(name);
    recorded?.order.push(name);
  };
  const deps: ApplicationMenuCommandDeps = {
    newSession: () => record('newSession'),
    openProjectManifest: () => record('openProjectManifest'),
    save: () => record('save'),
    exportAudio: () => record('exportAudio'),
    exportProjectBundle: () => record('exportProjectBundle'),
    exportProjectManifest: () => record('exportProjectManifest'),
    undo: () => record('undo'),
    redo: () => record('redo'),
    selectView: (view: ViewMode) => {
      record('selectView');
      views.push(view);
    },
    toggleBrowser: () => record('toggleBrowser'),
    toggleInspector: () => record('toggleInspector'),
    setDensity: () => record('setDensity'),
    toggleFullscreen: () => record('toggleFullscreen'),
    openProjectHub: () => record('openProjectHub'),
    openProjectStatistics: () => record('openProjectStatistics'),
    editTempo: () => record('editTempo'),
    openProjectSettings: () => record('openProjectSettings'),
    showInstrumentBrowser: () => record('showInstrumentBrowser'),
    addPlaylistTrack: () => record('addPlaylistTrack'),
    deleteSelectedChannel: () => record('deleteSelectedChannel'),
    toggleSelectedChannelMute: () => record('toggleSelectedChannelMute'),
    toggleSelectedChannelSolo: () => record('toggleSelectedChannelSolo'),
    toggleMetronome: () => record('toggleMetronome'),
    toggleRecord: () => record('toggleRecord'),
    openMidiDevices: () => record('openMidiDevices'),
    openMidiLearn: () => record('openMidiLearn'),
    openKeyboardShortcuts: () => record('openKeyboardShortcuts'),
    canUndo: () => true,
    canRedo: () => true,
    hasSelectedChannel: () => true,
    canDeleteSelectedChannel: () => true,
    currentView: () => 'playlist',
    isBrowserOpen: () => true,
    isInspectorOpen: () => true,
    getDensity: () => 'comfy' as const,
    isFullscreen: () => false,
    isMetronomeOn: () => false,
    isRecording: () => false,
    ...overrides,
  };
  return { deps, calls, views };
};

const allCommandIds = (): ApplicationMenuCommandId[] =>
  APPLICATION_MENUS.flatMap(menu =>
    menu.items
      .filter((item): item is Extract<ApplicationMenuItem, { kind: 'command' }> => item.kind === 'command')
      .map(item => item.id)
  );

/** command id -> the dependency method that must be invoked. */
const ROUTING: Record<ApplicationMenuCommandId, string> = {
  'file.newSession': 'newSession',
  'file.openManifest': 'openProjectManifest',
  'file.save': 'save',
  'file.exportAudio': 'exportAudio',
  'file.exportBundle': 'exportProjectBundle',
  'file.exportManifest': 'exportProjectManifest',
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  'view.channelRack': 'selectView',
  'view.pianoRoll': 'selectView',
  'view.playlist': 'selectView',
  'view.mixer': 'selectView',
  'view.instruments': 'selectView',
  'view.recorder': 'selectView',
  'view.browser': 'toggleBrowser',
  'view.inspector': 'toggleInspector',
  'view.densityCompact': 'setDensity',
  'view.densityComfy': 'setDensity',
  'view.fullscreen': 'toggleFullscreen',
  'project.hub': 'openProjectHub',
  'project.statistics': 'openProjectStatistics',
  'project.tempo': 'editTempo',
  'project.settings': 'openProjectSettings',
  'track.instrumentBrowser': 'showInstrumentBrowser',
  'track.newPlaylistTrack': 'addPlaylistTrack',
  'track.deleteChannel': 'deleteSelectedChannel',
  'track.muteSelectedChannel': 'toggleSelectedChannelMute',
  'track.soloSelectedChannel': 'toggleSelectedChannelSolo',
  'audio.metronome': 'toggleMetronome',
  'audio.record': 'toggleRecord',
  'midi.devices': 'openMidiDevices',
  'midi.learn': 'openMidiLearn',
  'help.shortcuts': 'openKeyboardShortcuts',
};

test('the routing table covers every command the menu renders, and nothing more', () => {
  const rendered = [...allCommandIds()].sort();
  const routed = (Object.keys(ROUTING) as ApplicationMenuCommandId[]).sort();
  assert.deepEqual(rendered, routed);
  assert.deepEqual(rendered, (Object.keys(APPLICATION_MENU_COMMANDS) as ApplicationMenuCommandId[]).sort());
});

test('every rendered menu command runs exactly its registered handler', () => {
  for (const id of allCommandIds()) {
    const recorded: Recorded = { calls: [], views: [], order: [] };
    const { deps, calls } = createDeps({}, recorded);
    const result = runApplicationMenuCommand(id, deps);
    assert.equal(result, 'handled', `${id} must be handled`);
    assert.deepEqual(calls, [ROUTING[id]], `${id} must invoke exactly ${ROUTING[id]}`);
  }
});

test('File -> New Session invokes the injected New Session entry point once', () => {
  const { deps, calls } = createDeps();
  assert.equal(runApplicationMenuCommand('file.newSession', deps), 'handled');
  assert.deepEqual(calls, ['newSession']);
});

test('File -> Open invokes the existing manifest open handler', () => {
  const { deps, calls } = createDeps();
  assert.equal(runApplicationMenuCommand('file.openManifest', deps), 'handled');
  assert.deepEqual(calls, ['openProjectManifest']);
});

test('File -> Save invokes the existing save handler', () => {
  const { deps, calls } = createDeps();
  assert.equal(runApplicationMenuCommand('file.save', deps), 'handled');
  assert.deepEqual(calls, ['save']);
});

test('File -> Export commands invoke the existing export handlers', () => {
  const { deps, calls } = createDeps();
  runApplicationMenuCommand('file.exportAudio', deps);
  runApplicationMenuCommand('file.exportBundle', deps);
  runApplicationMenuCommand('file.exportManifest', deps);
  assert.deepEqual(calls, ['exportAudio', 'exportProjectBundle', 'exportProjectManifest']);
});

test('view commands forward the matching workspace view', () => {
  const expectations: [ApplicationMenuCommandId, ViewMode][] = [
    ['view.channelRack', 'channel_rack'],
    ['view.pianoRoll', 'piano_roll'],
    ['view.playlist', 'playlist'],
    ['view.mixer', 'mixer'],
    ['view.instruments', 'instruments'],
    ['view.recorder', 'sampler'],
  ];
  for (const [id, view] of expectations) {
    const { deps, views } = createDeps();
    runApplicationMenuCommand(id, deps);
    assert.deepEqual(views, [view], `${id} must select ${view}`);
  }
});

test('Edit -> Undo and Redo invoke the existing history handlers', () => {
  const { deps, calls } = createDeps();
  runApplicationMenuCommand('edit.undo', deps);
  runApplicationMenuCommand('edit.redo', deps);
  assert.deepEqual(calls, ['undo', 'redo']);
});

test('Undo and Redo are disabled and inert when history has nothing to offer', () => {
  const { deps, calls } = createDeps({ canUndo: () => false, canRedo: () => false });
  assert.equal(isApplicationMenuCommandEnabled('edit.undo', deps), false);
  assert.equal(isApplicationMenuCommandEnabled('edit.redo', deps), false);
  assert.equal(runApplicationMenuCommand('edit.undo', deps), 'disabled');
  assert.equal(runApplicationMenuCommand('edit.redo', deps), 'disabled');
  assert.deepEqual(calls, []);
});

test('Delete Selected Channel is disabled when it would be a no-op', () => {
  const enabled = createDeps().deps;
  assert.equal(isApplicationMenuCommandEnabled('track.deleteChannel', enabled), true);

  const noChannel = createDeps({ hasSelectedChannel: () => false }).deps;
  assert.equal(isApplicationMenuCommandEnabled('track.deleteChannel', noChannel), false);
  assert.equal(runApplicationMenuCommand('track.deleteChannel', noChannel), 'disabled');

  const lastChannel = createDeps({ canDeleteSelectedChannel: () => false }).deps;
  assert.equal(isApplicationMenuCommandEnabled('track.deleteChannel', lastChannel), false);
  assert.equal(runApplicationMenuCommand('track.deleteChannel', lastChannel), 'disabled');
});

test('channel mute/solo commands need a selected channel', () => {
  const without = createDeps({ hasSelectedChannel: () => false }).deps;
  assert.equal(isApplicationMenuCommandEnabled('track.muteSelectedChannel', without), false);
  assert.equal(isApplicationMenuCommandEnabled('track.soloSelectedChannel', without), false);
  assert.equal(runApplicationMenuCommand('track.muteSelectedChannel', without), 'disabled');
});

test('checkmarks reflect real project and shell state, and are absent for stateless commands', () => {
  const { deps } = createDeps();
  assert.equal(isApplicationMenuCommandChecked('view.playlist', deps), true);
  assert.equal(isApplicationMenuCommandChecked('view.mixer', deps), false);
  assert.equal(isApplicationMenuCommandChecked('view.browser', deps), true);
  assert.equal(isApplicationMenuCommandChecked('view.fullscreen', deps), false);
  assert.equal(isApplicationMenuCommandChecked('audio.metronome', deps), false);
  assert.equal(isApplicationMenuCommandChecked('audio.record', deps), false);

  const recording = createDeps({
    isMetronomeOn: () => true,
    isRecording: () => true,
    isFullscreen: () => true,
    isBrowserOpen: () => false,
    currentView: () => 'mixer',
  }).deps;
  assert.equal(isApplicationMenuCommandChecked('audio.metronome', recording), true);
  assert.equal(isApplicationMenuCommandChecked('audio.record', recording), true);
  assert.equal(isApplicationMenuCommandChecked('view.fullscreen', recording), true);
  assert.equal(isApplicationMenuCommandChecked('view.browser', recording), false);
  assert.equal(isApplicationMenuCommandChecked('view.mixer', recording), true);

  assert.equal(isApplicationMenuCommandChecked('file.newSession', deps), undefined);
  assert.equal(isApplicationMenuCommandChecked('edit.undo', deps), undefined);
  assert.equal(isApplicationMenuCommandChecked('help.shortcuts', deps), undefined);
});

test('an unregistered command id is reported unsupported and never runs', () => {
  const { deps, calls } = createDeps();
  const forged = 'file.saveAs' as unknown as ApplicationMenuCommandId;
  assert.equal(runApplicationMenuCommand(forged, deps), 'unsupported');
  assert.deepEqual(calls, []);
});

test('running a command does not touch unrelated dependencies', () => {
  for (const id of allCommandIds()) {
    const recorded: Recorded = { calls: [], views: [], order: [] };
    const { deps } = createDeps({}, recorded);
    runApplicationMenuCommand(id, deps);
    assert.equal(recorded.order.length, 1, `${id} must invoke exactly one handler`);
  }
});

test('async command handlers are invoked without being awaited or swallowed', async () => {
  let resolved = false;
  const { deps } = createDeps({
    save: () => {
      resolved = true;
      return Promise.resolve();
    },
  });
  assert.equal(runApplicationMenuCommand('file.save', deps), 'handled');
  await Promise.resolve();
  assert.equal(resolved, true);
});
