import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ModalFrame,
  MODAL_DIALOG_SELECTOR,
  MODAL_FOCUSABLE_SELECTOR,
  DIALOG_ESCAPE_KEY,
  captureDialogOpener,
  getMountedModalIds,
  handleDialogEscapeKey,
  hasOpenModalDialog,
  isDialogEscapeKey,
  isTopmostModalId,
  isTrapFocusable,
  nextTrapFocus,
  registerModalId,
  resolveDialogInitialFocus,
  restoreDialogFocus,
  unregisterModalId,
  type DialogOpener,
  type FocusTrapCandidate,
} from '../components/ModalFrame';
import { AnalyticsModal } from '../components/AnalyticsModal';
import { ArpeggiatorModal } from '../components/ArpeggiatorModal';
import { AudioRecorderModal } from '../components/AudioRecorderModal';
import { AudioSlicerModal } from '../components/AudioSlicerModal';
import { CollaborationModal } from '../components/CollaborationModal';
import { DesktopAppModal } from '../components/DesktopAppModal';
import { ExportModal } from '../components/ExportModal';
import { GrossBeatModal } from '../components/GrossBeatModal';
import { HotkeysModal } from '../components/HotkeysModal';
import { MasterMacroRackModal } from '../components/MasterMacroRackModal';
import { MasteringSuiteModal } from '../components/MasteringSuiteModal';
import { MidiControllerModal } from '../components/MidiControllerModal';
import { MidiLearnModal } from '../components/MidiLearnModal';
import { MultiZoneSamplerModal } from '../components/MultiZoneSamplerModal';
import { ParametricEqModal } from '../components/ParametricEqModal';
import { PolyphonicEditorModal } from '../components/PolyphonicEditorModal';
import { ProjectBundleZipModal } from '../components/ProjectBundleZipModal';
import { ProjectManagerModal } from '../components/ProjectManagerModal';
import { ProjectReplaceConfirmModal } from '../components/ProjectReplaceConfirmModal';
import { SampleManagerModal } from '../components/SampleManagerModal';
import { SidechainRoutingModal } from '../components/SidechainRoutingModal';
import { TakeCompingModal } from '../components/TakeCompingModal';
import { VocalTunerModal } from '../components/VocalTunerModal';
import { WarpAudioProcessorModal } from '../components/WarpAudioProcessorModal';
import { WavetableSynthModal } from '../components/WavetableSynthModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { MasteringSuiteState, VocalTunerSettings } from '../types/daw';
import type { ProjectReplacementPlan as ReplacementPlan } from '../state/projectReplacement';

/**
 * UI Milestone 1C — Step 4: shared modal/dialog contract.
 *
 * The suite has no jsdom, so behaviour is pinned two ways: the ModalFrame
 * helpers are exercised directly through small injected fakes, and every
 * migrated modal is rendered with renderToStaticMarkup to pin the dialog
 * role, naming, preserved ids, preserved panel structure and close-button
 * names. The only browser API the suite explicitly provides is a minimal
 * window stub for the one modal that reads screen geometry during render.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const modalFrameSource = () => read('src/components/ModalFrame.tsx');
const appSource = () => read('src/App.tsx');
const indexCss = () => read('src/index.css');
const modalSource = (file: string) => read(`src/components/${file}`);

const render = (node: React.ReactElement): string => renderToStaticMarkup(node);

/** Escape for comparing source title text against static markup. */
const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const noop = () => undefined;

/** Counts non-overlapping occurrences of a literal substring. */
const countOf = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
};

/** The opening tag of the rendered dialog root (always the first element). */
const rootTagOf = (html: string): string => {
  assert.ok(html.startsWith('<div'), 'the dialog root is a div');
  return html.slice(0, html.indexOf('>') + 1);
};

/** Asserts the labelledby target exists and carries the existing title text. */
const assertTitleWiring = (html: string, titleId: string, titleText: string): void => {
  const target = html.indexOf(`id="${titleId}"`);
  assert.ok(target > 0, `the title element #${titleId} must render`);
  const blockEnd = html.indexOf('</h', target);
  assert.ok(blockEnd > target, 'the title element must close');
  const block = html.slice(target, blockEnd);
  assert.ok(
    block.includes(escapeHtml(titleText)),
    `#${titleId} must keep the existing title text "${titleText}"`
  );
};

// ---------------------------------------------------------------------------
// Fixtures: real project state, so renders exercise real data shapes.
// ---------------------------------------------------------------------------

const channels = DEFAULT_PROJECT.channels;
const mixerTracks = DEFAULT_PROJECT.mixerTracks;
const firstChannel = channels[0];
const firstMixerTrack = mixerTracks[0];

const masteringFixture: MasteringSuiteState = {
  enabled: true,
  lufsTarget: -14.0,
  lowCrossFreq: 150,
  highCrossFreq: 3500,
  lowBand: { enabled: true, threshold: -18, ratio: 3.0, attack: 20, release: 100, gain: 1.0, knee: 6, solo: false, mute: false },
  midBand: { enabled: true, threshold: -22, ratio: 2.5, attack: 15, release: 80, gain: 0.0, knee: 4, solo: false, mute: false },
  highBand: { enabled: true, threshold: -20, ratio: 2.0, attack: 10, release: 60, gain: 1.5, knee: 3, solo: false, mute: false },
  stereoSpread: 1.15,
  monoSubFreq: 120,
  maximizerThreshold: -3.5,
  maximizerCeiling: -0.2,
  maximizerRelease: 80,
  maximizerLookahead: true,
};

const vocalTunerFixture: VocalTunerSettings = {
  enabled: true,
  rootKey: 0,
  scale: 'minor',
  retuneSpeedMs: 15,
  formantShift: 0,
  vibratoDepth: 0.2,
  humanize: 0.3,
};

const replacementFixture: ReplacementPlan = {
  requiresConfirmation: true,
  shouldBackup: true,
  currentName: 'Current Jam',
  incomingName: 'Incoming Demo',
  source: 'manifest-import',
  reason: 'current-has-work',
};

/**
 * DesktopAppModal reads screen geometry while rendering (its resolution tab
 * reports live values). The suite explicitly provides that one browser
 * surface; nothing else in this file assumes browser APIs exist.
 */
const withDesktopWindowStub = <T,>(run: () => T): T => {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1,
    location: { origin: 'https://apex-studio.test' },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete holder.window;
    else holder.window = previous;
  }
};

interface ModalCase {
  name: string;
  file: string;
  /** The modal's existing overlay id; null when it never had one. */
  modalId: string | null;
  titleId: string;
  titleText: string;
  closeLabel: string;
  /** The modal's existing overlay classes, preserved verbatim. */
  overlayClass: string;
  open: React.ReactElement;
  closed: React.ReactElement;
}

const OVERLAY_SHELL = 'fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4';
const OVERLAY_SHELL_PADDED = 'fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-4';
const OVERLAY_STUDIO = 'fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none';
const OVERLAY_FLOATING = 'fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-md animate-fade-in select-none';
const OVERLAY_HUB = 'fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in';

const MODAL_CASES: ModalCase[] = [
  {
    name: 'Hotkeys', file: 'HotkeysModal.tsx', modalId: 'hotkeys-modal',
    titleId: 'hotkeys-modal-title', titleText: 'STUDIO KEYBOARD SHORTCUTS & HOTKEYS',
    closeLabel: 'Close hotkeys', overlayClass: OVERLAY_SHELL,
    open: React.createElement(HotkeysModal, { isOpen: true, onClose: noop }),
    closed: React.createElement(HotkeysModal, { isOpen: false, onClose: noop }),
  },
  {
    name: 'Export', file: 'ExportModal.tsx', modalId: 'export-modal',
    titleId: 'export-modal-title', titleText: 'PROJECT EXPORT',
    closeLabel: 'Close export', overlayClass: OVERLAY_SHELL,
    open: React.createElement(ExportModal, {
      isOpen: true, onClose: noop, channels, clips: DEFAULT_PROJECT.playlistClips,
      mixerTracks, meta: DEFAULT_PROJECT.meta, patternLengthSteps: 16,
      playlistTracks: DEFAULT_PROJECT.playlistTracks,
    }),
    closed: React.createElement(ExportModal, {
      isOpen: false, onClose: noop, channels, clips: DEFAULT_PROJECT.playlistClips,
      mixerTracks, meta: DEFAULT_PROJECT.meta, patternLengthSteps: 16,
      playlistTracks: DEFAULT_PROJECT.playlistTracks,
    }),
  },
  {
    name: 'Project Manager', file: 'ProjectManagerModal.tsx', modalId: 'project-manager-modal',
    titleId: 'project-manager-modal-title', titleText: 'STUDIO PROJECT HUB & DEMO TEMPLATES',
    closeLabel: 'Close project manager', overlayClass: OVERLAY_SHELL,
    open: React.createElement(ProjectManagerModal, {
      isOpen: true, onClose: noop, currentState: DEFAULT_PROJECT,
      onLoadProject: noop, onUpdateMeta: noop, onRequestManifestImport: noop,
    }),
    closed: React.createElement(ProjectManagerModal, {
      isOpen: false, onClose: noop, currentState: DEFAULT_PROJECT,
      onLoadProject: noop, onUpdateMeta: noop, onRequestManifestImport: noop,
    }),
  },
  {
    name: 'Sample Manager', file: 'SampleManagerModal.tsx', modalId: null,
    titleId: 'sample-manager-modal-title', titleText: 'DIRECTWAVE AUDIO SAMPLE LOADER',
    closeLabel: 'Close sample manager', overlayClass: OVERLAY_FLOATING,
    open: React.createElement(SampleManagerModal, {
      isOpen: true, onClose: noop, channels, sampleLibrary: DEFAULT_PROJECT.sampleLibrary ?? [],
      selectedChannel: firstChannel, onSampleImported: noop, onAssignSampleToChannel: noop,
      onCreateChannelFromSample: noop,
    }),
    closed: React.createElement(SampleManagerModal, {
      isOpen: false, onClose: noop, channels, sampleLibrary: DEFAULT_PROJECT.sampleLibrary ?? [],
      selectedChannel: firstChannel, onSampleImported: noop, onAssignSampleToChannel: noop,
      onCreateChannelFromSample: noop,
    }),
  },
  {
    name: 'MIDI Controller', file: 'MidiControllerModal.tsx', modalId: 'midi-controller-modal-overlay',
    titleId: 'midi-controller-modal-title', titleText: 'Hardware MIDI & Controller Hub',
    closeLabel: 'Close MIDI controller', overlayClass: OVERLAY_HUB,
    open: React.createElement(MidiControllerModal, {
      isOpen: true, onClose: noop, channels, mixerTracks,
      midiMappings: DEFAULT_PROJECT.midiMappings, onUpdateMidiMappings: noop,
      activeChannel: firstChannel,
    }),
    closed: React.createElement(MidiControllerModal, {
      isOpen: false, onClose: noop, channels, mixerTracks,
      midiMappings: DEFAULT_PROJECT.midiMappings, onUpdateMidiMappings: noop,
      activeChannel: firstChannel,
    }),
  },
  {
    name: 'Analytics', file: 'AnalyticsModal.tsx', modalId: 'analytics-modal',
    titleId: 'analytics-modal-title', titleText: 'STUDIO TELEMETRY & PRODUCTION METRICS',
    closeLabel: 'Close analytics', overlayClass: OVERLAY_SHELL_PADDED,
    open: React.createElement(AnalyticsModal, {
      isOpen: true, onClose: noop, meta: DEFAULT_PROJECT.meta, channels,
      clips: DEFAULT_PROJECT.playlistClips,
    }),
    closed: React.createElement(AnalyticsModal, {
      isOpen: false, onClose: noop, meta: DEFAULT_PROJECT.meta, channels,
      clips: DEFAULT_PROJECT.playlistClips,
    }),
  },
  {
    name: 'Collaboration', file: 'CollaborationModal.tsx', modalId: 'collab-modal',
    titleId: 'collab-modal-title', titleText: 'STUDIO NOTES & COLLABORATION',
    closeLabel: 'Close collaboration', overlayClass: OVERLAY_SHELL_PADDED,
    open: React.createElement(CollaborationModal, {
      isOpen: true, onClose: noop, comments: [], collaborators: [],
      onAddComment: noop, onToggleResolveComment: noop,
    }),
    closed: React.createElement(CollaborationModal, {
      isOpen: false, onClose: noop, comments: [], collaborators: [],
      onAddComment: noop, onToggleResolveComment: noop,
    }),
  },
  {
    name: 'Audio Recorder', file: 'AudioRecorderModal.tsx', modalId: 'audio-recorder-modal',
    titleId: 'audio-recorder-modal-title', titleText: 'AUDIO RECORDER',
    closeLabel: 'Close audio recorder', overlayClass: OVERLAY_SHELL_PADDED,
    open: React.createElement(AudioRecorderModal, {
      isOpen: true, projectGeneration: 0, getCurrentProjectGeneration: () => 0,
      onClose: noop, onRegisterProjectReplacementHandler: noop, onSaveRecording: noop,
    }),
    closed: React.createElement(AudioRecorderModal, {
      isOpen: false, projectGeneration: 0, getCurrentProjectGeneration: () => 0,
      onClose: noop, onRegisterProjectReplacementHandler: noop, onSaveRecording: noop,
    }),
  },
  {
    name: 'Audio Slicer', file: 'AudioSlicerModal.tsx', modalId: 'audio-slicer-modal',
    titleId: 'audio-slicer-modal-title', titleText: 'EDISON TRANSIENT SLICER & CHOPPER',
    closeLabel: 'Close audio slicer', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(AudioSlicerModal, {
      isOpen: true, onClose: noop, channels, onUpdateChannel: noop,
    }),
    closed: React.createElement(AudioSlicerModal, {
      isOpen: false, onClose: noop, channels, onUpdateChannel: noop,
    }),
  },
  {
    name: 'Desktop App', file: 'DesktopAppModal.tsx', modalId: 'fl-desktop-app-modal',
    titleId: 'fl-desktop-app-modal-title', titleText: 'WINDOWS .EXE & DESKTOP SUITE',
    closeLabel: 'Close desktop app', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(DesktopAppModal, { isOpen: true, onClose: noop }),
    closed: React.createElement(DesktopAppModal, { isOpen: false, onClose: noop }),
  },
  {
    name: 'Gross Beat', file: 'GrossBeatModal.tsx', modalId: 'gross-beat-modal',
    titleId: 'gross-beat-modal-title', titleText: 'TIME FX BUFFER',
    closeLabel: 'Close Gross Beat', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(GrossBeatModal, { isOpen: true, onClose: noop, currentStep: 0, isPlaying: false }),
    closed: React.createElement(GrossBeatModal, { isOpen: false, onClose: noop, currentStep: 0, isPlaying: false }),
  },
  {
    name: 'Master Macro Rack', file: 'MasterMacroRackModal.tsx', modalId: 'fl-master-macro-modal',
    titleId: 'fl-master-macro-modal-title', titleText: 'MASTER MACRO PERFORMANCE RACK',
    closeLabel: 'Close macro rack', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(MasterMacroRackModal, {
      isOpen: true, onClose: noop, mixerTracks, channels,
      macroKnobs: DEFAULT_PROJECT.macroKnobs ?? [], onUpdateMacros: noop,
    }),
    closed: React.createElement(MasterMacroRackModal, {
      isOpen: false, onClose: noop, mixerTracks, channels,
      macroKnobs: DEFAULT_PROJECT.macroKnobs ?? [], onUpdateMacros: noop,
    }),
  },
  {
    name: 'Mastering Suite', file: 'MasteringSuiteModal.tsx', modalId: null,
    titleId: 'mastering-suite-modal-title', titleText: 'APEX MASTERING SUITE',
    closeLabel: 'Close mastering suite', overlayClass: OVERLAY_FLOATING,
    open: React.createElement(MasteringSuiteModal, {
      isOpen: true, onClose: noop, masteringState: masteringFixture,
      onUpdateMasteringState: noop, isPlaying: false,
    }),
    closed: React.createElement(MasteringSuiteModal, {
      isOpen: false, onClose: noop, masteringState: masteringFixture,
      onUpdateMasteringState: noop, isPlaying: false,
    }),
  },
  {
    name: 'MIDI Learn', file: 'MidiLearnModal.tsx', modalId: 'fl-midi-learn-modal',
    titleId: 'fl-midi-learn-modal-title', titleText: 'MIDI CONTROLLER LEARN & MAPPING',
    closeLabel: 'Close MIDI learn', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(MidiLearnModal, {
      isOpen: true, onClose: noop, midiMappings: DEFAULT_PROJECT.midiMappings,
      onUpdateMidiMappings: noop, channels, mixerTracks,
      connectedDevices: DEFAULT_PROJECT.connectedMidiDevices ?? [],
      isMidiLearnActive: false, onToggleMidiLearn: noop,
    }),
    closed: React.createElement(MidiLearnModal, {
      isOpen: false, onClose: noop, midiMappings: DEFAULT_PROJECT.midiMappings,
      onUpdateMidiMappings: noop, channels, mixerTracks,
      connectedDevices: DEFAULT_PROJECT.connectedMidiDevices ?? [],
      isMidiLearnActive: false, onToggleMidiLearn: noop,
    }),
  },
  {
    name: 'Multi-Zone Sampler', file: 'MultiZoneSamplerModal.tsx', modalId: 'fl-multizone-sampler-modal',
    titleId: 'fl-multizone-sampler-modal-title', titleText: 'DIRECTWAVE MULTI-SAMPLE KEYMAPPER',
    closeLabel: 'Close multi-zone sampler', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(MultiZoneSamplerModal, {
      isOpen: true, onClose: noop, channels,
      sampleLibrary: DEFAULT_PROJECT.sampleLibrary ?? [], onUpdateChannel: noop,
    }),
    closed: React.createElement(MultiZoneSamplerModal, {
      isOpen: false, onClose: noop, channels,
      sampleLibrary: DEFAULT_PROJECT.sampleLibrary ?? [], onUpdateChannel: noop,
    }),
  },
  {
    name: 'Parametric EQ', file: 'ParametricEqModal.tsx', modalId: 'parametric-eq-modal-overlay',
    titleId: 'parametric-eq-modal-title', titleText: '7-Band EQ — Dynamic Equalizer',
    closeLabel: 'Close parametric EQ', overlayClass: OVERLAY_HUB,
    open: React.createElement(ParametricEqModal, {
      isOpen: true, onClose: noop, mixerTrack: firstMixerTrack, onUpdateTrack: noop,
    }),
    closed: React.createElement(ParametricEqModal, {
      isOpen: false, onClose: noop, mixerTrack: firstMixerTrack, onUpdateTrack: noop,
    }),
  },
  {
    name: 'Polyphonic Editor', file: 'PolyphonicEditorModal.tsx', modalId: 'fl-polyphonic-editor-modal',
    titleId: 'fl-polyphonic-editor-modal-title', titleText: 'MELODYNE / ARA2 POLYPHONIC AUDIO BLOB EDITOR',
    closeLabel: 'Close polyphonic editor', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(PolyphonicEditorModal, { isOpen: true, onClose: noop }),
    closed: React.createElement(PolyphonicEditorModal, { isOpen: false, onClose: noop }),
  },
  {
    name: 'Project Bundle Zip', file: 'ProjectBundleZipModal.tsx', modalId: 'fl-project-zip-modal',
    titleId: 'fl-project-zip-modal-title', titleText: 'PROJECT ZIP ARCHIVE BUNDLER',
    closeLabel: 'Close project bundler', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(ProjectBundleZipModal, {
      isOpen: true, onClose: noop, projectState: DEFAULT_PROJECT, onLoadProjectState: noop,
    }),
    closed: React.createElement(ProjectBundleZipModal, {
      isOpen: false, onClose: noop, projectState: DEFAULT_PROJECT, onLoadProjectState: noop,
    }),
  },
  {
    name: 'Arpeggiator', file: 'ArpeggiatorModal.tsx', modalId: null,
    titleId: 'arpeggiator-modal-title', titleText: `${firstChannel.name} ARPEGGIATOR`,
    closeLabel: 'Close arpeggiator', overlayClass: OVERLAY_FLOATING,
    open: React.createElement(ArpeggiatorModal, {
      isOpen: true, onClose: noop, channel: firstChannel, onUpdateChannel: noop, bpm: 128,
    }),
    closed: React.createElement(ArpeggiatorModal, {
      isOpen: false, onClose: noop, channel: firstChannel, onUpdateChannel: noop, bpm: 128,
    }),
  },
  {
    name: 'Sidechain Routing', file: 'SidechainRoutingModal.tsx', modalId: 'fl-sidechain-routing-modal',
    titleId: 'fl-sidechain-routing-modal-title', titleText: 'DYNAMIC SIDECHAIN DUCKING & MODULATION MATRIX',
    closeLabel: 'Close sidechain routing', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(SidechainRoutingModal, {
      isOpen: true, onClose: noop, mixerTracks, onUpdateMixerTracks: noop,
    }),
    closed: React.createElement(SidechainRoutingModal, {
      isOpen: false, onClose: noop, mixerTracks, onUpdateMixerTracks: noop,
    }),
  },
  {
    name: 'Take Comping', file: 'TakeCompingModal.tsx', modalId: 'fl-take-comping-modal',
    titleId: 'fl-take-comping-modal-title', titleText: 'STACKED MULTI-TAKE SWIPE COMPING STUDIO',
    closeLabel: 'Close take comping', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(TakeCompingModal, {
      isOpen: true, onClose: noop, onPromoteCompToPlaylist: noop,
    }),
    closed: React.createElement(TakeCompingModal, {
      isOpen: false, onClose: noop, onPromoteCompToPlaylist: noop,
    }),
  },
  {
    name: 'Vocal Tuner', file: 'VocalTunerModal.tsx', modalId: 'fl-vocal-tuner-modal',
    titleId: 'fl-vocal-tuner-modal-title', titleText: 'AUTO-PITCH & VOCAL TUNER',
    closeLabel: 'Close vocal tuner', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(VocalTunerModal, {
      isOpen: true, onClose: noop, vocalTunerSettings: vocalTunerFixture,
      onUpdateVocalTuner: noop, channels,
    }),
    closed: React.createElement(VocalTunerModal, {
      isOpen: false, onClose: noop, vocalTunerSettings: vocalTunerFixture,
      onUpdateVocalTuner: noop, channels,
    }),
  },
  {
    name: 'Warp Processor', file: 'WarpAudioProcessorModal.tsx', modalId: 'fl-warp-processor-modal',
    titleId: 'fl-warp-processor-modal-title', titleText: 'ADVANCED TIME-STRETCH & TRANSIENT WARP ENGINE',
    closeLabel: 'Close warp processor', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(WarpAudioProcessorModal, {
      isOpen: true, onClose: noop, selectedClip: null, onUpdateClip: noop,
    }),
    closed: React.createElement(WarpAudioProcessorModal, {
      isOpen: false, onClose: noop, selectedClip: null, onUpdateClip: noop,
    }),
  },
  {
    name: 'Wavetable Synth', file: 'WavetableSynthModal.tsx', modalId: 'fl-wavetable-synth-modal',
    titleId: 'fl-wavetable-synth-modal-title', titleText: 'ADVANCED WAVETABLE SYNTHESIZER',
    closeLabel: 'Close wavetable synth', overlayClass: OVERLAY_STUDIO,
    open: React.createElement(WavetableSynthModal, {
      isOpen: true, onClose: noop, channels, onUpdateChannel: noop,
    }),
    closed: React.createElement(WavetableSynthModal, {
      isOpen: false, onClose: noop, channels, onUpdateChannel: noop,
    }),
  },
];

const renderCase = (modalCase: ModalCase, node: React.ReactElement): string =>
  modalCase.file === 'DesktopAppModal.tsx' ? withDesktopWindowStub(() => render(node)) : render(node);

// ---------------------------------------------------------------------------
// 1. ModalFrame unit contracts: Escape, focus, registry, guard
// ---------------------------------------------------------------------------

test('only the Escape key dismisses a dialog', () => {
  assert.equal(DIALOG_ESCAPE_KEY, 'Escape');
  assert.equal(isDialogEscapeKey('Escape'), true);
  for (const other of ['Enter', 'Tab', ' ', 'a', 'Esc', 'escape', '']) {
    assert.equal(isDialogEscapeKey(other), false, `${other || '(empty)'} must not dismiss`);
  }

  let closes = 0;
  const handled = handleDialogEscapeKey(
    { key: 'Escape', preventDefault: noop, stopPropagation: noop },
    () => { closes += 1; }
  );
  assert.equal(handled, true);
  assert.equal(closes, 1);

  for (const other of ['Enter', 'Tab', 'a']) {
    const ignored = handleDialogEscapeKey(
      { key: other, preventDefault: noop, stopPropagation: noop },
      () => { closes += 1; }
    );
    assert.equal(ignored, false);
  }
  assert.equal(closes, 1, 'no other key may close the dialog');
});

test('Escape never leaks to outer dialogs or the global shell shortcuts', () => {
  let prevented = 0;
  let stopped = 0;
  let closes = 0;
  handleDialogEscapeKey(
    {
      key: 'Escape',
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
    },
    () => { closes += 1; }
  );
  assert.equal(closes, 1);
  assert.equal(prevented, 1, 'the default key action is suppressed');
  assert.equal(stopped, 1, 'bubbling stops so outer dialogs and window handlers never see it');

  // Non-Escape keys pass through untouched.
  prevented = 0;
  stopped = 0;
  handleDialogEscapeKey(
    {
      key: 'Tab',
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
    },
    () => { closes += 1; }
  );
  assert.equal(closes, 1);
  assert.equal(prevented, 0);
  assert.equal(stopped, 0);
});

test('the opener is captured from the active element, defensively', () => {
  const opener: DialogOpener = { focus: noop, isConnected: true };
  assert.equal(captureDialogOpener({ activeElement: opener }), opener);
  assert.equal(captureDialogOpener({ activeElement: null }), null);
  assert.equal(captureDialogOpener({}), null);
  assert.equal(captureDialogOpener(null), null);
  assert.equal(captureDialogOpener(undefined), null);
  // Whatever is focused must be focusable to count as an opener.
  assert.equal(captureDialogOpener({ activeElement: 'not-an-element' }), null);
  assert.equal(captureDialogOpener({ activeElement: { isConnected: true } }), null);
});

test('focus returns to the opener on close, unless it left the document', () => {
  let focused = 0;
  assert.equal(restoreDialogFocus({ focus: () => { focused += 1; }, isConnected: true }), true);
  assert.equal(focused, 1);
  assert.equal(restoreDialogFocus({ focus: () => { focused += 1; } }), true);
  assert.equal(focused, 2, 'an opener without connectivity metadata is still honoured');
  assert.equal(
    restoreDialogFocus({ focus: () => { focused += 1; }, isConnected: false }),
    false
  );
  assert.equal(focused, 2, 'a detached opener must not be focused');
  assert.equal(restoreDialogFocus(null), false);
  assert.equal(restoreDialogFocus(undefined), false);
});

test('initial focus lands on the first tabbable descendant, else the dialog', () => {
  const dialog: FocusTrapCandidate = { focus: noop };
  const first: FocusTrapCandidate = { focus: noop };
  const second: FocusTrapCandidate = { focus: noop };
  assert.equal(resolveDialogInitialFocus(dialog, [first, second]), first);
  assert.equal(resolveDialogInitialFocus(dialog, []), dialog);
  assert.equal(
    resolveDialogInitialFocus(dialog, [{ focus: noop, disabled: true }, second]),
    second,
    'hidden and disabled descendants are skipped'
  );
  assert.equal(
    resolveDialogInitialFocus(dialog, [{ focus: noop, hidden: true }]),
    dialog,
    'a dialog with nothing tabbable keeps focus itself'
  );
});

test('hidden, disabled and untabbable elements never join the focus trap', () => {
  const visibleButton: FocusTrapCandidate = {
    focus: noop,
    tabIndex: 0,
    getAttribute: () => null,
    getClientRects: () => [{ width: 8, height: 8 }],
  };
  assert.equal(isTrapFocusable(visibleButton), true);
  assert.equal(isTrapFocusable({ focus: noop }), true, 'a plain focusable counts');
  assert.equal(isTrapFocusable(null), false);
  assert.equal(isTrapFocusable(undefined), false);
  assert.equal(isTrapFocusable({ focus: noop, disabled: true }), false);
  assert.equal(isTrapFocusable({ focus: noop, hidden: true }), false);
  assert.equal(isTrapFocusable({ focus: noop, tabIndex: -1 }), false);
  assert.equal(
    isTrapFocusable({ focus: noop, getAttribute: (name) => (name === 'aria-hidden' ? 'true' : null) }),
    false
  );
  assert.equal(
    isTrapFocusable({ focus: noop, getClientRects: () => [] }),
    false,
    'a display:none element has no rects and is skipped'
  );
});

test('Tab and Shift+Tab cycle inside the dialog and wrap at both ends', () => {
  const first: FocusTrapCandidate = { focus: noop };
  const middle: FocusTrapCandidate = { focus: noop };
  const last: FocusTrapCandidate = { focus: noop };
  const list = [first, middle, last] as const;

  assert.equal(nextTrapFocus(list, first, false), middle);
  assert.equal(nextTrapFocus(list, middle, false), last);
  assert.equal(nextTrapFocus(list, last, false), first, 'Tab wraps from last to first');
  assert.equal(nextTrapFocus(list, last, true), middle);
  assert.equal(nextTrapFocus(list, middle, true), first);
  assert.equal(nextTrapFocus(list, first, true), last, 'Shift+Tab wraps from first to last');

  const hidden: FocusTrapCandidate = { focus: noop, hidden: true };
  assert.equal(
    nextTrapFocus([first, hidden, last], first, false),
    last,
    'hidden entries are skipped while cycling'
  );
  assert.equal(
    nextTrapFocus([first, hidden, last], last, true),
    first,
    'hidden entries are skipped while cycling backwards'
  );

  assert.equal(nextTrapFocus([first], first, false), first, 'a lone control keeps focus');
  assert.equal(nextTrapFocus([first], first, true), first, 'a lone control keeps focus');
  assert.equal(nextTrapFocus([], null, false), null);
  assert.equal(nextTrapFocus([hidden], null, false), null);
  assert.equal(nextTrapFocus(list, null, false), first, 'Tab from outside lands on first');
  assert.equal(nextTrapFocus(list, null, true), last, 'Shift+Tab from outside lands on last');
  assert.equal(nextTrapFocus(list, { focus: noop }, false), first);
});

test('duplicate modal ids are rejected and the stack stays ordered', () => {
  const bottom = 'step4-test-bottom-modal';
  const top = 'step4-test-top-modal';
  try {
    assert.equal(registerModalId(bottom), true);
    assert.equal(registerModalId(bottom), false, 'a duplicate mount must be rejected');
    assert.equal(registerModalId(top), true);
    assert.deepEqual(getMountedModalIds(), [bottom, top], 'open order is preserved');
    assert.equal(isTopmostModalId(top), true, 'the last opened dialog is topmost');
    assert.equal(isTopmostModalId(bottom), false);
    assert.equal(isTopmostModalId('step4-test-missing-modal'), false);

    unregisterModalId(top);
    assert.deepEqual(getMountedModalIds(), [bottom]);
    assert.equal(isTopmostModalId(bottom), true, 'closing the top dialog reveals the one below');
    unregisterModalId('step4-test-missing-modal');
    assert.deepEqual(getMountedModalIds(), [bottom], 'unknown ids unregister harmlessly');
  } finally {
    unregisterModalId(bottom);
    unregisterModalId(top);
  }
  assert.deepEqual(getMountedModalIds(), [], 'the registry is empty once every dialog closes');
});

test('the pinned modal id contract itself holds no duplicates', () => {
  const ids = MODAL_CASES.map((modalCase) => modalCase.modalId).filter(
    (modalId): modalId is string => modalId !== null
  );
  assert.equal(ids.length, 21, 'twenty-one migrated modals carry overlay ids');
  assert.equal(new Set(ids).size, ids.length, 'every modal id must be unique');
  const titleIds = MODAL_CASES.map((modalCase) => modalCase.titleId);
  assert.equal(new Set(titleIds).size, titleIds.length, 'every title id must be unique');
});

test('the App-level guard only fires while a dialog surface is mounted', () => {
  assert.equal(MODAL_DIALOG_SELECTOR, '[role="dialog"], [role="alertdialog"]');
  assert.equal(hasOpenModalDialog({ querySelector: () => ({}) }), true);
  assert.equal(hasOpenModalDialog({ querySelector: () => null }), false);
  assert.equal(hasOpenModalDialog(null), false);
  assert.equal(hasOpenModalDialog(undefined), false);
  assert.equal(
    hasOpenModalDialog({} as unknown as { querySelector: (selectors: string) => unknown }),
    false
  );

  let seen: string | null = null;
  hasOpenModalDialog({
    querySelector: (selectors: string) => {
      seen = selectors;
      return null;
    },
  });
  assert.equal(seen, MODAL_DIALOG_SELECTOR, 'both dialog roles are honoured');
});

test('the focusable pre-filter covers the controls dialogs actually render', () => {
  for (const token of [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    'audio[controls]',
    'video[controls]',
    '[contenteditable="true"]',
    '[tabindex]',
  ]) {
    assert.ok(MODAL_FOCUSABLE_SELECTOR.includes(token), `${token} must be collected`);
  }
});

// ---------------------------------------------------------------------------
// 2. ModalFrame render contracts
// ---------------------------------------------------------------------------

test('ModalFrame renders the dialog semantics and keeps the panel a direct child', () => {
  const html = render(
    React.createElement(
      ModalFrame,
      { id: 'step4-frame-modal', labelledBy: 'step4-frame-title', onClose: noop, className: 'frame-overlay' },
      React.createElement(
        'div',
        { className: 'frame-panel' },
        React.createElement('h2', { id: 'step4-frame-title' }, 'Frame Title')
      )
    )
  );
  const root = rootTagOf(html);
  assert.ok(root.includes('id="step4-frame-modal"'));
  assert.ok(root.includes('role="dialog"'));
  assert.ok(root.includes('aria-modal="true"'));
  assert.ok(root.includes('aria-labelledby="step4-frame-title"'));
  assert.ok(root.includes('tabindex="-1"'), 'the dialog itself is the focus fallback');
  assert.ok(root.includes('apex-modal-overlay'), 'the overlay primitive is wired');
  assert.ok(root.includes('frame-overlay'), 'existing overlay classes are preserved');
  assert.equal(countOf(html, 'role="dialog"'), 1, 'exactly one dialog role per frame');
  assert.ok(
    html.slice(root.length).startsWith('<div'),
    'the panel stays the direct child div of the dialog root'
  );
  assert.ok(html.includes('id="step4-frame-title"'));
});

test('ModalFrame needs no overlay id to name and trap a dialog', () => {
  const html = render(
    React.createElement(
      ModalFrame,
      { labelledBy: 'step4-idless-title', onClose: noop },
      React.createElement(
        'div',
        null,
        React.createElement('h2', { id: 'step4-idless-title' }, 'Idless Title')
      )
    )
  );
  const root = rootTagOf(html);
  assert.ok(root.includes('role="dialog"'));
  assert.ok(root.includes('aria-modal="true"'));
  assert.ok(root.includes('aria-labelledby="step4-idless-title"'));
  assert.ok(root.includes('apex-modal-overlay'));
  assert.equal(root.includes('id='), false, 'modals without an overlay id keep having none');
  assert.ok(html.slice(root.length).startsWith('<div'));
});

test('stacked ModalFrames nest as distinct dialogs with the inner one last', () => {
  const html = render(
    React.createElement(
      ModalFrame,
      { id: 'step4-outer-modal', labelledBy: 'step4-outer-title', onClose: noop },
      React.createElement(
        'div',
        null,
        React.createElement('h2', { id: 'step4-outer-title' }, 'Outer'),
        React.createElement(
          ModalFrame,
          { id: 'step4-inner-modal', labelledBy: 'step4-inner-title', onClose: noop },
          React.createElement(
            'div',
            null,
            React.createElement('h2', { id: 'step4-inner-title' }, 'Inner')
          )
        )
      )
    )
  );
  assert.equal(countOf(html, 'role="dialog"'), 2);
  assert.equal(countOf(html, 'aria-modal="true"'), 2);
  const outer = html.indexOf('id="step4-outer-modal"');
  const inner = html.indexOf('id="step4-inner-modal"');
  assert.ok(outer > 0 && inner > outer, 'the inner dialog nests inside the outer one');
  assert.ok(html.includes('aria-labelledby="step4-outer-title"'));
  assert.ok(html.includes('aria-labelledby="step4-inner-title"'));
});

test('ModalFrame owns Escape on the overlay and offers no backdrop dismissal', () => {
  const source = modalFrameSource();
  assert.ok(source.includes('onKeyDown={handleKeyDown}'), 'the overlay handles keydown');
  assert.ok(
    source.includes('handleDialogEscapeKey(event, onCloseRef.current)'),
    'the overlay delegates to the shared Escape handler'
  );
  assert.equal(source.includes('onClick'), false, 'no backdrop-click dismissal exists');
});

test('ModalFrame keeps every hook before any conditional early return', () => {
  // The frame's render path is unconditional — every conditional lives inside
  // an effect callback or an event handler — so hook order cannot drift.
  const component = modalFrameSource().slice(modalFrameSource().indexOf('export const ModalFrame'));
  for (const hook of ['useRef', 'useEffect']) {
    assert.ok(component.includes(hook), `${hook} stays in the unconditional prefix`);
  }
  assert.equal(component.includes('return null'), false, 'the frame never early-returns');
  assert.equal(component.includes('if (!isOpen)'), false, 'open guards stay in the modals');
});

// ---------------------------------------------------------------------------
// 3. Every migrated modal renders the dialog contract
// ---------------------------------------------------------------------------

test('all twenty-four migrated modals render role, modal state and naming', () => {
  assert.equal(MODAL_CASES.length, 24, 'the audit counts twenty-four migrated surfaces');
  for (const modalCase of MODAL_CASES) {
    const html = renderCase(modalCase, modalCase.open);
    const root = rootTagOf(html);
    assert.ok(root.includes('role="dialog"'), `${modalCase.name} needs role="dialog"`);
    assert.ok(root.includes('aria-modal="true"'), `${modalCase.name} needs aria-modal="true"`);
    assert.ok(
      root.includes(`aria-labelledby="${modalCase.titleId}"`),
      `${modalCase.name} must name itself from its title`
    );
    assertTitleWiring(html, modalCase.titleId, modalCase.titleText);
  }
});

test('all modal ids are preserved and id-less modals gain none', () => {
  for (const modalCase of MODAL_CASES) {
    const html = renderCase(modalCase, modalCase.open);
    const root = rootTagOf(html);
    if (modalCase.modalId === null) {
      assert.equal(
        root.includes('id='),
        false,
        `${modalCase.name} never had an overlay id and must not gain one`
      );
    } else {
      assert.ok(
        root.includes(`id="${modalCase.modalId}"`),
        `${modalCase.name} must keep id="${modalCase.modalId}" on the dialog root`
      );
      assert.equal(
        countOf(html, `id="${modalCase.modalId}"`),
        1,
        `${modalCase.modalId} must occur exactly once`
      );
    }
  }
});

test('the panel structure and overlay classes survive the migration', () => {
  for (const modalCase of MODAL_CASES) {
    const html = renderCase(modalCase, modalCase.open);
    const root = rootTagOf(html);
    assert.ok(
      html.slice(root.length).startsWith('<div'),
      `${modalCase.name} must keep its panel as the direct child div`
    );
    assert.equal(countOf(html, 'role="dialog"'), 1, `${modalCase.name} owns exactly one dialog`);
    assert.ok(
      root.includes(modalCase.overlayClass),
      `${modalCase.name} must keep its overlay classes verbatim`
    );
    assert.ok(root.includes('apex-modal-overlay'), `${modalCase.name} wires the overlay primitive`);
  }
});

test('every icon-only close control carries an accessible name', () => {
  for (const modalCase of MODAL_CASES) {
    const html = renderCase(modalCase, modalCase.open);
    assert.ok(
      html.includes(`aria-label="${modalCase.closeLabel}"`),
      `${modalCase.name} needs aria-label="${modalCase.closeLabel}"`
    );
  }
});

test('closed modals still render nothing: isOpen wiring is untouched', () => {
  for (const modalCase of MODAL_CASES) {
    assert.equal(renderCase(modalCase, modalCase.closed), '', `${modalCase.name} stays shut when closed`);
  }
});

// ---------------------------------------------------------------------------
// 4. Migration source contracts
// ---------------------------------------------------------------------------

test('every migrated modal delegates its frame and keeps its own wiring', () => {
  for (const modalCase of MODAL_CASES) {
    const source = modalSource(modalCase.file);
    assert.ok(
      source.includes("from './ModalFrame'"),
      `${modalCase.name} must import the shared frame`
    );
    assert.ok(source.includes('<ModalFrame'), `${modalCase.name} must render the shared frame`);
    assert.ok(
      source.includes('onClose={onClose}'),
      `${modalCase.name} must keep its existing onClose wiring`
    );
    assert.ok(
      source.includes(`labelledBy="${modalCase.titleId}"`),
      `${modalCase.name} must name the dialog from its title`
    );
    if (modalCase.modalId !== null) {
      assert.ok(
        source.includes(`id="${modalCase.modalId}"`),
        `${modalCase.name} must keep its overlay id`
      );
    }
    assert.ok(
      source.includes('if (!isOpen) return null;'),
      `${modalCase.name} must keep its existing open guard`
    );
    // The frame owns dialog semantics; the modal must not hand-roll its own.
    assert.equal(source.includes('role="dialog"'), false, `${modalCase.name} must not redeclare the role`);
    assert.equal(source.includes('aria-modal'), false, `${modalCase.name} must not redeclare modal state`);
    // No backdrop-click dismissal may sneak onto the frame usage.
    const frameOpen = source.indexOf('<ModalFrame');
    const frameTagEnd = source.indexOf('>', frameOpen);
    assert.ok(frameOpen > 0 && frameTagEnd > frameOpen);
    assert.equal(
      source.slice(frameOpen, frameTagEnd).includes('onClick'),
      false,
      `${modalCase.name} must not dismiss on backdrop click`
    );
  }
});

test('every migrated modal keeps all hooks before its conditional early return', () => {
  for (const modalCase of MODAL_CASES) {
    const source = modalSource(modalCase.file);
    const guard = source.indexOf('if (!isOpen) return null;');
    assert.ok(guard > 0, `${modalCase.name} keeps its open guard`);
    for (const match of source.matchAll(/\buse(State|Effect|Ref|Memo|Callback|Context|Id)\(/g)) {
      const at = match.index ?? -1;
      assert.ok(
        at !== -1 && at < guard,
        `${modalCase.name} must call ${match[0]} before the early return`
      );
    }
  }
});

test('the shell-launched seven all migrated first', () => {
  const shellSeven = [
    'HotkeysModal.tsx',
    'ExportModal.tsx',
    'ProjectManagerModal.tsx',
    'SampleManagerModal.tsx',
    'MidiControllerModal.tsx',
    'AnalyticsModal.tsx',
    'CollaborationModal.tsx',
  ];
  for (const file of shellSeven) {
    assert.ok(
      MODAL_CASES.some((modalCase) => modalCase.file === file),
      `${file} must be in the migrated set`
    );
    assert.ok(modalSource(file).includes('<ModalFrame'), `${file} must render the shared frame`);
  }
});

// ---------------------------------------------------------------------------
// 5. Untouched surfaces stay intact
// ---------------------------------------------------------------------------

test('ProjectReplaceConfirmModal keeps its alertdialog pattern and stays independent', () => {
  const html = render(
    React.createElement(ProjectReplaceConfirmModal, {
      plan: replacementFixture,
      isWorking: false,
      backupError: null,
      error: null,
      onConfirm: noop,
      onCancel: noop,
    })
  );
  const root = rootTagOf(html);
  assert.ok(root.includes('id="project-replace-confirm-modal"'));
  assert.ok(root.includes('role="alertdialog"'), 'the confirm keeps its alertdialog role');
  assert.ok(root.includes('aria-modal="true"'));
  assert.ok(root.includes('aria-labelledby="project-replace-confirm-title"'));
  assert.ok(html.includes('id="project-replace-confirm-title"'));
  assert.ok(html.includes('REPLACE CURRENT PROJECT?'));
  assert.equal(countOf(html, 'role="alertdialog"'), 1);

  const source = modalSource('ProjectReplaceConfirmModal.tsx');
  assert.equal(source.includes('ModalFrame'), false, 'the confirm must not adopt the frame');
  assert.ok(source.includes('role="alertdialog"'));
  assert.ok(
    source.includes('title="Keep current project"'),
    'its existing close control is untouched'
  );
});

test('OrientationLockModal keeps its behaviour and stays outside the frame', () => {
  const source = modalSource('OrientationLockModal.tsx');
  assert.equal(source.includes('ModalFrame'), false, 'the lock screen must not adopt the frame');
  assert.equal(source.includes('role="dialog"'), false, 'it gains no dialog semantics');
  assert.equal(source.includes('aria-modal'), false, 'it gains no modal state');
  assert.ok(source.includes('id="fl-orientation-lock-overlay"'));
  assert.ok(source.includes('handleDismiss'), 'its dismiss path is untouched');
  assert.ok(source.includes('Dismiss lock screen'));
});

// ---------------------------------------------------------------------------
// 6. App-level guard: shell shortcuts stay inert behind a modal
// ---------------------------------------------------------------------------

test('App guards its global hotkeys while any modal owns the interaction', () => {
  const app = appSource();
  assert.ok(
    app.includes("from './components/ModalFrame'"),
    'App must import the shared dialog guard'
  );
  const handler = app.indexOf('const handleKeyDown = (e: KeyboardEvent) => {');
  assert.ok(handler > 0, 'the global keydown handler must stay');
  const guard = app.indexOf('hasOpenModalDialog(', handler);
  assert.ok(guard > handler, 'the handler must consult the dialog guard');
  const guardLineEnd = app.indexOf('\n', guard);
  assert.ok(
    app.slice(handler, guardLineEnd).includes("typeof document === 'undefined'"),
    'the guard must stay server-render safe'
  );
  for (const shortcut of ['resolveApplicationMenuShortcut(e)', 'resolveUndoRedoShortcut(e)', 'resolveSaveShortcut(e)']) {
    const at = app.indexOf(shortcut, handler);
    assert.ok(at > guard, `${shortcut} must only run when no modal is open`);
  }
});

// ---------------------------------------------------------------------------
// 7. Shared modal CSS
// ---------------------------------------------------------------------------

test('the shared modal tokens and primitives are wired without a new palette', () => {
  const css = indexCss();
  assert.ok(css.includes('--apex-modal-overlay:'), 'the overlay token must be defined');
  assert.ok(css.includes('.apex-modal-overlay'), 'the overlay primitive must exist');

  const overlayBlock = css.slice(css.indexOf('.apex-modal-overlay {'), css.indexOf('}', css.indexOf('.apex-modal-overlay {')));
  assert.ok(
    overlayBlock.includes('background-color: var(--apex-modal-overlay)'),
    'the overlay primitive themes the scrim from the token'
  );
  assert.ok(css.includes('.apex-modal-overlay:focus'), 'programmatic dialog focus stays ring-free');

  assert.ok(css.includes('.apex-dialog'), 'the dialog surface primitive must exist');
  assert.ok(
    css.includes('.apex-modal-overlay > div'),
    'the surface treatment reaches every framed panel through the preserved structure'
  );
  assert.ok(css.includes('border-radius: var(--apex-radius-lg)'), 'the surface reuses the modal radius');
  assert.ok(css.includes('box-shadow: var(--apex-shadow)'), 'the surface reuses the modal shadow');

  // The existing modal-id coupling the panels depend on stays pinned.
  assert.ok(
    css.includes('[id$="-modal"] > div, [id*="-modal"] > div'),
    'the modal id CSS coupling must stay'
  );

  // The Step 4 block introduces no new palette, gradients or neon.
  const step4Start = css.indexOf('UI Milestone 1C Step 4');
  assert.ok(step4Start > 0, 'the Step 4 section must be marked');
  const step4Block = css.slice(step4Start);
  assert.equal(step4Block.includes('#'), false, 'no literal colours in the Step 4 block');
  assert.equal(step4Block.includes('linear-gradient'), false, 'no gradients in the Step 4 block');
  assert.equal(step4Block.includes('radial-gradient'), false, 'no gradients in the Step 4 block');
  assert.equal(step4Block.includes('!important'), false, 'no specificity escapes in the Step 4 block');
});
