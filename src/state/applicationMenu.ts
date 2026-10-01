import type { ViewMode } from '../types/daw';

/**
 * UI Milestone 1B — the Apex Studio application menu model.
 *
 * This module is deliberately free of React, DOM and persistence concerns. It is
 * the single source of truth for:
 *   - which application commands exist and what they are called,
 *   - which top-level menus render them,
 *   - which accelerators are advertised,
 *   - which commands were investigated and deliberately withheld, and why.
 *
 * Every command in `APPLICATION_MENU_COMMANDS` must be backed by a real handler in
 * `applicationMenuCommands.ts`. Nothing may be added here for appearance only.
 */

export const APPLICATION_MENU_IDS = [
  'file',
  'edit',
  'view',
  'project',
  'track',
  'audio',
  'midi',
  'help',
] as const;

export type ApplicationMenuId = (typeof APPLICATION_MENU_IDS)[number];

export type ApplicationMenuCommandId =
  // File — the four audited groups: New, Open, Save, Export.
  | 'file.newSession'
  | 'file.openManifest'
  | 'file.save'
  | 'file.exportAudio'
  | 'file.exportBundle'
  | 'file.exportManifest'
  // Edit — only the commands with genuine handlers.
  | 'edit.undo'
  | 'edit.redo'
  // View — the six real workspace views plus the two real shell toggles.
  | 'view.channelRack'
  | 'view.pianoRoll'
  | 'view.playlist'
  | 'view.mixer'
  | 'view.instruments'
  | 'view.recorder'
  | 'view.browser'
  | 'view.fullscreen'
  // Project — existing Hub, the currently unreachable statistics modal, and the
  // always-visible tempo field.
  | 'project.hub'
  | 'project.statistics'
  | 'project.tempo'
  // Track — real channel and playlist-track operations only.
  | 'track.instrumentBrowser'
  | 'track.newPlaylistTrack'
  | 'track.muteSelectedChannel'
  | 'track.soloSelectedChannel'
  | 'track.deleteChannel'
  // Audio — the two real transport-level audio toggles.
  | 'audio.metronome'
  | 'audio.record'
  // MIDI — the two existing MIDI surfaces.
  | 'midi.devices'
  | 'midi.learn'
  // Help
  | 'help.shortcuts';

export interface ApplicationMenuCommandEntry {
  readonly label: string;
  readonly accelerator?: string;
}

export interface ApplicationMenuCommandItem extends ApplicationMenuCommandEntry {
  readonly kind: 'command';
  readonly id: ApplicationMenuCommandId;
}

export interface ApplicationMenuSeparator {
  readonly kind: 'separator';
}

export type ApplicationMenuItem = ApplicationMenuCommandItem | ApplicationMenuSeparator;

export interface ApplicationMenu {
  readonly id: ApplicationMenuId;
  readonly label: string;
  readonly items: readonly ApplicationMenuItem[];
}

const command = (id: ApplicationMenuCommandId, entry: ApplicationMenuCommandEntry): ApplicationMenuCommandItem => ({
  kind: 'command',
  id,
  label: entry.label,
  accelerator: entry.accelerator,
});

const separator: ApplicationMenuSeparator = { kind: 'separator' };

/**
 * The complete command registry. Each entry carries the label and accelerator the
 * menu renders, so a command cannot be displayed without also being runnable.
 */
export const APPLICATION_MENU_COMMANDS: Readonly<Record<ApplicationMenuCommandId, ApplicationMenuCommandEntry>> = {
  'file.newSession': { label: 'New Session', accelerator: 'Ctrl+N' },
  'file.openManifest': { label: 'Open Project Manifest…', accelerator: 'Ctrl+O' },
  'file.save': { label: 'Save', accelerator: 'Ctrl+S' },
  'file.exportAudio': { label: 'Export Audio…' },
  'file.exportBundle': { label: 'Export Portable Project Bundle (.zip)…' },
  'file.exportManifest': { label: 'Save Project Manifest (.flmp)…' },

  'edit.undo': { label: 'Undo', accelerator: 'Ctrl+Z' },
  'edit.redo': { label: 'Redo', accelerator: 'Ctrl+Shift+Z' },

  'view.channelRack': { label: 'Channel Rack', accelerator: 'F6' },
  'view.pianoRoll': { label: 'Piano Roll', accelerator: 'F7' },
  'view.playlist': { label: 'Playlist', accelerator: 'F5' },
  'view.mixer': { label: 'Mixer', accelerator: 'F9' },
  'view.instruments': { label: 'Instruments', accelerator: 'F8' },
  'view.recorder': { label: 'Recorder' },
  'view.browser': { label: 'Studio Browser' },
  'view.fullscreen': { label: 'Fullscreen' },

  'project.hub': { label: 'Project Hub…' },
  'project.statistics': { label: 'Project Statistics…' },
  'project.tempo': { label: 'Edit Tempo (BPM)…' },

  'track.instrumentBrowser': { label: 'Show Instrument Browser' },
  'track.newPlaylistTrack': { label: 'New Playlist Track' },
  'track.muteSelectedChannel': { label: 'Mute Selected Channel' },
  'track.soloSelectedChannel': { label: 'Solo Selected Channel' },
  'track.deleteChannel': { label: 'Delete Selected Channel' },

  'audio.metronome': { label: 'Metronome', accelerator: 'M' },
  'audio.record': { label: 'Record', accelerator: 'R' },

  'midi.devices': { label: 'MIDI Devices & Controllers…' },
  'midi.learn': { label: 'MIDI Learn & Mapping…' },

  'help.shortcuts': { label: 'Keyboard Shortcuts' },
};

const VIEW_COMMAND_VIEWS: Partial<Record<ApplicationMenuCommandId, ViewMode>> = {
  'view.channelRack': 'channel_rack',
  'view.pianoRoll': 'piano_roll',
  'view.playlist': 'playlist',
  'view.mixer': 'mixer',
  'view.instruments': 'instruments',
  'view.recorder': 'sampler',
};

/** The workspace view a View-menu command selects, or null when it is not a view command. */
export const getApplicationMenuCommandView = (id: ApplicationMenuCommandId): ViewMode | null =>
  VIEW_COMMAND_VIEWS[id] ?? null;

export const APPLICATION_MENUS: readonly ApplicationMenu[] = [
  {
    id: 'file',
    label: 'File',
    items: [
      command('file.newSession', APPLICATION_MENU_COMMANDS['file.newSession']),
      separator,
      command('file.openManifest', APPLICATION_MENU_COMMANDS['file.openManifest']),
      separator,
      command('file.save', APPLICATION_MENU_COMMANDS['file.save']),
      separator,
      command('file.exportAudio', APPLICATION_MENU_COMMANDS['file.exportAudio']),
      command('file.exportBundle', APPLICATION_MENU_COMMANDS['file.exportBundle']),
      command('file.exportManifest', APPLICATION_MENU_COMMANDS['file.exportManifest']),
    ],
  },
  {
    id: 'edit',
    label: 'Edit',
    items: [
      command('edit.undo', APPLICATION_MENU_COMMANDS['edit.undo']),
      command('edit.redo', APPLICATION_MENU_COMMANDS['edit.redo']),
    ],
  },
  {
    id: 'view',
    label: 'View',
    items: [
      command('view.channelRack', APPLICATION_MENU_COMMANDS['view.channelRack']),
      command('view.pianoRoll', APPLICATION_MENU_COMMANDS['view.pianoRoll']),
      command('view.playlist', APPLICATION_MENU_COMMANDS['view.playlist']),
      command('view.mixer', APPLICATION_MENU_COMMANDS['view.mixer']),
      command('view.instruments', APPLICATION_MENU_COMMANDS['view.instruments']),
      command('view.recorder', APPLICATION_MENU_COMMANDS['view.recorder']),
      separator,
      command('view.browser', APPLICATION_MENU_COMMANDS['view.browser']),
      command('view.fullscreen', APPLICATION_MENU_COMMANDS['view.fullscreen']),
    ],
  },
  {
    id: 'project',
    label: 'Project',
    items: [
      command('project.hub', APPLICATION_MENU_COMMANDS['project.hub']),
      command('project.statistics', APPLICATION_MENU_COMMANDS['project.statistics']),
      separator,
      command('project.tempo', APPLICATION_MENU_COMMANDS['project.tempo']),
    ],
  },
  {
    id: 'track',
    label: 'Track',
    items: [
      command('track.instrumentBrowser', APPLICATION_MENU_COMMANDS['track.instrumentBrowser']),
      command('track.newPlaylistTrack', APPLICATION_MENU_COMMANDS['track.newPlaylistTrack']),
      separator,
      command('track.muteSelectedChannel', APPLICATION_MENU_COMMANDS['track.muteSelectedChannel']),
      command('track.soloSelectedChannel', APPLICATION_MENU_COMMANDS['track.soloSelectedChannel']),
      separator,
      command('track.deleteChannel', APPLICATION_MENU_COMMANDS['track.deleteChannel']),
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    items: [
      command('audio.metronome', APPLICATION_MENU_COMMANDS['audio.metronome']),
      command('audio.record', APPLICATION_MENU_COMMANDS['audio.record']),
    ],
  },
  {
    id: 'midi',
    label: 'MIDI',
    items: [
      command('midi.devices', APPLICATION_MENU_COMMANDS['midi.devices']),
      command('midi.learn', APPLICATION_MENU_COMMANDS['midi.learn']),
    ],
  },
  {
    id: 'help',
    label: 'Help',
    items: [command('help.shortcuts', APPLICATION_MENU_COMMANDS['help.shortcuts'])],
  },
];

/**
 * Commands that were investigated for UI Milestone 1B and deliberately withheld.
 *
 * They are recorded here so the omission is a documented decision rather than an
 * oversight, and so a regression test can prove none of them is rendered.
 * Do not add menu rows for these until the capability underneath exists.
 */
export interface UnsupportedApplicationMenuCommand {
  readonly id: string;
  readonly label: string;
  readonly menu: ApplicationMenuId;
  readonly reason: string;
}

export const UNSUPPORTED_APPLICATION_MENU_COMMANDS: readonly UnsupportedApplicationMenuCommand[] = [
  {
    id: 'file.openRecent',
    label: 'Open Recent / Recent Sessions',
    menu: 'file',
    reason:
      'No recents source of truth exists. listProjectBackups() returns at most 5 pre-replacement safety copies, not last-opened ordering.',
  },
  {
    id: 'file.saveAs',
    label: 'Save As…',
    menu: 'file',
    reason:
      'Persistence is single-slot: performSave() writes the one "current-project" record. There is no second document identity to save as.',
  },
  {
    id: 'file.closeSession',
    label: 'Close Session',
    menu: 'file',
    reason: 'Single-document application: there is no close semantics and no start screen to return to.',
  },
  {
    id: 'edit.cut',
    label: 'Cut',
    menu: 'edit',
    reason: 'No clipboard implementation exists for clips or notes.',
  },
  {
    id: 'edit.copy',
    label: 'Copy',
    menu: 'edit',
    reason: 'No clipboard implementation exists for clips or notes.',
  },
  {
    id: 'edit.paste',
    label: 'Paste',
    menu: 'edit',
    reason: 'No clipboard implementation exists for clips or notes.',
  },
  {
    id: 'edit.selectAll',
    label: 'Select All',
    menu: 'edit',
    reason:
      'Ctrl+A selects notes in the Piano Roll only. Presenting it globally would be false outside that view.',
  },
  {
    id: 'edit.deleteSelection',
    label: 'Delete Selection',
    menu: 'edit',
    reason:
      'Deletion is view-scoped: the Playlist and Piano Roll own their own keydown handlers. There is no central handler to call yet.',
  },
  {
    id: 'project.timeSignature',
    label: 'Time Signature',
    menu: 'project',
    reason:
      'updateProjectMetadataInProjectState() supports it, but no UI exists and it never reaches the transport or audio math. Needs an engine decision first.',
  },
  {
    id: 'project.sampleRate',
    label: 'Sample Rate',
    menu: 'project',
    reason: 'Not a project concept: the rate is read from the live AudioContext and written into the WAV header.',
  },
  {
    id: 'project.settings',
    label: 'Project Settings',
    menu: 'project',
    reason: 'No project settings surface exists.',
  },
  {
    id: 'track.rename',
    label: 'Rename Track',
    menu: 'track',
    reason: 'Playlist track names are generated ("Track N") and channel names come from the instrument catalog.',
  },
  {
    id: 'track.duplicate',
    label: 'Duplicate Track',
    menu: 'track',
    reason: 'Only notes and playlist clips can be duplicated; there is no track/channel duplication.',
  },
  {
    id: 'audio.settings',
    label: 'Audio Settings',
    menu: 'audio',
    reason: 'new AudioContext({ latencyHint: "interactive" }) is hardcoded; latency is read-only telemetry.',
  },
  {
    id: 'audio.monitoring',
    label: 'Monitoring',
    menu: 'audio',
    reason: 'No monitor toggle, no input-device enumeration and no input gain path exists.',
  },
  {
    id: 'help.about',
    label: 'About',
    menu: 'help',
    reason:
      'Version identity is unresolved: package.json 1.2.1, meta.version "4.5.2 Pro", preload.cjs "2.4.0".',
  },
];

export interface ApplicationMenuShortcutEvent {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * Resolves the application-shell accelerators this milestone adds.
 *
 * Only Ctrl/Cmd+N and Ctrl/Cmd+O are claimed. Ctrl+S stays with the existing
 * `resolveSaveShortcut`, and undo/redo stay with `resolveUndoRedoShortcut`, so no
 * existing working shortcut changes behaviour.
 *
 * Shift and Alt are rejected outright: every unmodified code belongs to the
 * virtual piano keyboard, so requiring Ctrl/Cmd and no other modifier keeps the
 * two input paths provably disjoint.
 */
export const resolveApplicationMenuShortcut = (
  event: ApplicationMenuShortcutEvent
): ApplicationMenuCommandId | null => {
  const isModifier = Boolean(event.ctrlKey || event.metaKey);
  if (!isModifier) return null;
  if (event.shiftKey || event.altKey) return null;

  const isN = event.code === 'KeyN' || event.key === 'n' || event.key === 'N';
  if (isN) return 'file.newSession';

  const isO = event.code === 'KeyO' || event.key === 'o' || event.key === 'O';
  if (isO) return 'file.openManifest';

  return null;
};

export interface ApplicationMenuBarState {
  readonly openMenu: ApplicationMenuId | null;
}

export type ApplicationMenuBarAction =
  | { readonly type: 'toggle'; readonly menu: ApplicationMenuId }
  | { readonly type: 'hover'; readonly menu: ApplicationMenuId }
  | { readonly type: 'dismiss' };

export const createApplicationMenuBarState = (): ApplicationMenuBarState => ({ openMenu: null });

/**
 * Drives the menu bar's open/close behaviour.
 *
 * `toggle` is the click/keyboard activation of a top-level menu, so activating a
 * different top-level menu replaces the open one and activating the same menu
 * closes it. `hover` only switches menus while a dropdown is already open, which
 * is the conventional desktop menu-bar feel. `dismiss` covers Escape, a click
 * outside the bar, and completing a command.
 */
export const reduceApplicationMenuBar = (
  state: ApplicationMenuBarState,
  action: ApplicationMenuBarAction
): ApplicationMenuBarState => {
  switch (action.type) {
    case 'toggle':
      return { openMenu: state.openMenu === action.menu ? null : action.menu };
    case 'hover':
      return state.openMenu === null ? state : { openMenu: action.menu };
    case 'dismiss':
      return state.openMenu === null ? state : { openMenu: null };
    default:
      return state;
  }
};
