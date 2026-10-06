import type { ViewMode } from '../types/daw';
import {
  APPLICATION_MENU_COMMANDS,
  getApplicationMenuCommandView,
  type ApplicationMenuCommandId,
} from './applicationMenu';

/**
 * The real handlers behind every application menu row.
 *
 * `App` supplies these; each entry is an existing production entry point. Adding a
 * command to `applicationMenu.ts` without adding its handler here is a type error,
 * which is what keeps the menu from advertising anything the app cannot do.
 */
export interface ApplicationMenuCommandDeps {
  newSession: () => void | Promise<void>;
  openProjectManifest: () => void;
  save: () => void | Promise<unknown>;
  exportAudio: () => void;
  exportProjectBundle: () => void;
  exportProjectManifest: () => void;

  undo: () => void;
  redo: () => void;

  selectView: (view: ViewMode) => void;
  toggleBrowser: () => void;
  toggleInspector?: () => void;
  setDensity?: (density: 'compact' | 'comfy') => void;
  toggleFullscreen: () => void;

  openProjectHub: () => void;
  openProjectStatistics: () => void;
  editTempo: () => void;

  showInstrumentBrowser: () => void;
  addPlaylistTrack: () => void;
  toggleSelectedChannelMute: () => void;
  toggleSelectedChannelSolo: () => void;
  deleteSelectedChannel: () => void;

  toggleMetronome: () => void;
  toggleRecord: () => void;

  openMidiDevices: () => void;
  openMidiLearn: () => void;
  openKeyboardShortcuts: () => void;

  canUndo: () => boolean;
  canRedo: () => boolean;
  hasSelectedChannel: () => boolean;
  canDeleteSelectedChannel: () => boolean;
  currentView: () => ViewMode;
  isBrowserOpen: () => boolean;
  isInspectorOpen?: () => boolean;
  getDensity?: () => 'compact' | 'comfy';
  isFullscreen: () => boolean;
  isMetronomeOn: () => boolean;
  isRecording: () => boolean;
}

/** The subset of dependencies that only reports state; enough to render the menu. */
export type ApplicationMenuCommandStateSource = Pick<
  ApplicationMenuCommandDeps,
  | 'canUndo'
  | 'canRedo'
  | 'hasSelectedChannel'
  | 'canDeleteSelectedChannel'
  | 'currentView'
  | 'isBrowserOpen'
  | 'isInspectorOpen'
  | 'getDensity'
  | 'isFullscreen'
  | 'isMetronomeOn'
  | 'isRecording'
>;

export interface ApplicationMenuCommandState {
  isEnabled: (id: ApplicationMenuCommandId) => boolean;
  /** `undefined` when the command has no persistent state to report. */
  isChecked: (id: ApplicationMenuCommandId) => boolean | undefined;
}

const commandsRequiringASelectedChannel: readonly ApplicationMenuCommandId[] = [
  'track.muteSelectedChannel',
  'track.soloSelectedChannel',
  'track.deleteChannel',
];

const checkedStateResolvers: Partial<
  Record<ApplicationMenuCommandId, (deps: ApplicationMenuCommandStateSource) => boolean>
> = {
  'view.browser': deps => deps.isBrowserOpen(),
  'view.inspector': deps => deps.isInspectorOpen?.() ?? false,
  'view.densityCompact': deps => (deps.getDensity?.() ?? 'comfy') === 'compact',
  'view.densityComfy': deps => (deps.getDensity?.() ?? 'comfy') === 'comfy',
  'view.fullscreen': deps => deps.isFullscreen(),
  'audio.metronome': deps => deps.isMetronomeOn(),
  'audio.record': deps => deps.isRecording(),
};

/**
 * Whether a command can act right now. Only genuine no-op conditions disable an
 * item; disabled items are never silently runnable.
 */
export const isApplicationMenuCommandEnabled = (
  id: ApplicationMenuCommandId,
  deps: ApplicationMenuCommandStateSource & Pick<ApplicationMenuCommandDeps, 'hasSelectedChannel' | 'canDeleteSelectedChannel'>
): boolean => {
  switch (id) {
    case 'edit.undo':
      return deps.canUndo();
    case 'edit.redo':
      return deps.canRedo();
    case 'track.deleteChannel':
      // handleDeleteChannel refuses to remove the last remaining channel.
      return deps.hasSelectedChannel() && deps.canDeleteSelectedChannel();
    default:
      return commandsRequiringASelectedChannel.includes(id) ? deps.hasSelectedChannel() : true;
  }
};

export const isApplicationMenuCommandChecked = (
  id: ApplicationMenuCommandId,
  deps: ApplicationMenuCommandStateSource
): boolean | undefined => {
  const view = getApplicationMenuCommandView(id);
  if (view) return deps.currentView() === view;
  return checkedStateResolvers[id]?.(deps);
};

export const createApplicationMenuCommandState = (
  deps: ApplicationMenuCommandStateSource &
    Pick<ApplicationMenuCommandDeps, 'hasSelectedChannel' | 'canDeleteSelectedChannel'>
): ApplicationMenuCommandState => ({
  isEnabled: id => isApplicationMenuCommandEnabled(id, deps),
  isChecked: id => isApplicationMenuCommandChecked(id, deps),
});

export type ApplicationMenuCommandResult = 'handled' | 'disabled' | 'unsupported';

const runCommand = (id: ApplicationMenuCommandId, deps: ApplicationMenuCommandDeps): void => {
  switch (id) {
    case 'file.newSession':
      void deps.newSession();
      return;
    case 'file.openManifest':
      deps.openProjectManifest();
      return;
    case 'file.save':
      void deps.save();
      return;
    case 'file.exportAudio':
      deps.exportAudio();
      return;
    case 'file.exportBundle':
      deps.exportProjectBundle();
      return;
    case 'file.exportManifest':
      deps.exportProjectManifest();
      return;

    case 'edit.undo':
      deps.undo();
      return;
    case 'edit.redo':
      deps.redo();
      return;

    case 'view.browser':
      deps.toggleBrowser();
      return;
    case 'view.inspector':
      deps.toggleInspector?.();
      return;
    case 'view.densityCompact':
      deps.setDensity?.('compact');
      return;
    case 'view.densityComfy':
      deps.setDensity?.('comfy');
      return;
    case 'view.fullscreen':
      void deps.toggleFullscreen();
      return;

    case 'project.hub':
      deps.openProjectHub();
      return;
    case 'project.statistics':
      deps.openProjectStatistics();
      return;
    case 'project.tempo':
      deps.editTempo();
      return;

    case 'track.instrumentBrowser':
      deps.showInstrumentBrowser();
      return;
    case 'track.newPlaylistTrack':
      deps.addPlaylistTrack();
      return;
    case 'track.muteSelectedChannel':
      deps.toggleSelectedChannelMute();
      return;
    case 'track.soloSelectedChannel':
      deps.toggleSelectedChannelSolo();
      return;
    case 'track.deleteChannel':
      deps.deleteSelectedChannel();
      return;

    case 'audio.metronome':
      deps.toggleMetronome();
      return;
    case 'audio.record':
      deps.toggleRecord();
      return;

    case 'midi.devices':
      deps.openMidiDevices();
      return;
    case 'midi.learn':
      deps.openMidiLearn();
      return;

    case 'help.shortcuts':
      deps.openKeyboardShortcuts();
      return;

    default: {
      const view = getApplicationMenuCommandView(id);
      if (view) {
        deps.selectView(view);
        return;
      }
      // Exhaustiveness guard: every registered command must be handled above.
      throw new Error(`Unhandled application menu command: ${String(id)}`);
    }
  }
};

/**
 * Runs a menu command through its registered handler.
 *
 * Returns `unsupported` for ids that are not registered (defence in depth against
 * a menu row being added without a handler) and `disabled` when the command cannot
 * act, in which case the handler is never invoked.
 */
export const runApplicationMenuCommand = (
  id: ApplicationMenuCommandId,
  deps: ApplicationMenuCommandDeps
): ApplicationMenuCommandResult => {
  if (!(id in APPLICATION_MENU_COMMANDS)) return 'unsupported';
  if (!isApplicationMenuCommandEnabled(id, deps)) return 'disabled';
  runCommand(id, deps);
  return 'handled';
};
