import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MidiControllerModal,
  describeChannelMidiRouteStatus,
  describeMidiDeviceStatus,
} from './MidiControllerModal';
import { ExportModal, describeExternalMidiExportNotice } from './ExportModal';
import { resolveChannelMidiOutputRouting } from '../audio/midiOutputScheduler';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import {
  getChannelUpdateLabel,
  isContinuousChannelUpdate,
  updateChannelInProjectState,
} from '../state/projectMutations';
import type { MidiDeviceInfo } from '../types/daw';

describe('External MIDI Output — Project Persistence, Undo/Redo, and UI Truthfulness', () => {
  it('persists Channel.midiOutput across save/reopen, preserves unavailable outputDeviceId verbatim, and normalizes legacy projects', () => {
    const initial = createDefaultProjectState();
    const targetId = initial.channels[0].id;

    const routed = updateChannelInProjectState(initial, targetId, {
      midiOutput: {
        outputDeviceId: 'sequential-prophet-6-usb',
        midiChannel: 12,
        mode: 'external',
      },
    });

    // Round-trip through JSON serialization + normalizeProjectState (save & reopen):
    const serialized = JSON.stringify(routed);
    const reopened = normalizeProjectState(JSON.parse(serialized));
    assert.deepEqual(reopened.channels[0].midiOutput, {
      outputDeviceId: 'sequential-prophet-6-usb',
      midiChannel: 12,
      mode: 'external',
    });

    // Legacy project files without midiOutput normalize cleanly without throwing and resolve to Off / Ch 1 / null:
    const legacyRaw = JSON.parse(serialized);
    delete legacyRaw.channels[0].midiOutput;
    const migrated = normalizeProjectState(legacyRaw);
    assert.deepEqual(resolveChannelMidiOutputRouting(migrated.channels[0]), {
      outputDeviceId: null,
      midiChannel: 1,
      mode: 'off',
    });
  });

  it('records discrete undo/redo history entries for per-channel MIDI output routing mutations', () => {
    const initial = createDefaultProjectState();
    const chId = initial.channels[0].id;

    assert.equal(
      isContinuousChannelUpdate({ midiOutput: { outputDeviceId: 'moog-matriarch', midiChannel: 4, mode: 'mirror' } }),
      false,
    );
    assert.equal(
      getChannelUpdateLabel({ midiOutput: { outputDeviceId: 'moog-matriarch', midiChannel: 4, mode: 'mirror' } }),
      'Update MIDI output routing',
    );

    let history = createHistory(initial);

    // Step 1: Configure Mirror on Ch 4
    const step1 = updateChannelInProjectState(history.present, chId, {
      midiOutput: { outputDeviceId: 'moog-matriarch', midiChannel: 4, mode: 'mirror' },
    });
    history = history.commit(step1, 'Update MIDI output routing');

    // Step 2: Switch to External Only on Ch 9
    const step2 = updateChannelInProjectState(history.present, chId, {
      midiOutput: { outputDeviceId: 'moog-matriarch', midiChannel: 9, mode: 'external' },
    });
    history = history.commit(step2, 'Update MIDI output routing');

    assert.deepEqual(history.present.channels[0].midiOutput, {
      outputDeviceId: 'moog-matriarch',
      midiChannel: 9,
      mode: 'external',
    });

    // Undo once -> back to Mirror Ch 4
    history = history.undo();
    assert.deepEqual(history.present.channels[0].midiOutput, {
      outputDeviceId: 'moog-matriarch',
      midiChannel: 4,
      mode: 'mirror',
    });

    // Undo again -> back to Off Ch 1
    history = history.undo();
    assert.deepEqual(resolveChannelMidiOutputRouting(history.present.channels[0]), {
      outputDeviceId: null,
      midiChannel: 1,
      mode: 'off',
    });

    // Redo twice -> External Only Ch 9 restored
    history = history.redo().redo();
    assert.deepEqual(history.present.channels[0].midiOutput, {
      outputDeviceId: 'moog-matriarch',
      midiChannel: 9,
      mode: 'external',
    });
  });

  it('separates input and output devices, refuses to mark enumerated closed ports Ready, and keeps missing configured devices visibly unavailable', () => {
    const project = createDefaultProjectState();
    const ch0 = {
      ...project.channels[0],
      midiOutput: {
        outputDeviceId: 'unplugged-oberheim-ob-x8',
        midiChannel: 6,
        mode: 'external' as const,
      },
    };
    const ch1 = {
      ...project.channels[1],
      midiOutput: {
        outputDeviceId: 'out-closed-port',
        midiChannel: 2,
        mode: 'mirror' as const,
      },
    };
    const ch2 = {
      ...project.channels[2],
      midiOutput: {
        outputDeviceId: 'out-ready-synth',
        midiChannel: 5,
        mode: 'external' as const,
      },
    };

    const devices: MidiDeviceInfo[] = [
      {
        id: 'in-keystep',
        name: 'KeyStep Pro In',
        manufacturer: 'Arturia',
        state: 'connected',
        type: 'input',
        connection: 'open',
        usable: true,
      },
      {
        id: 'out-closed-port',
        name: 'Enumerated Closed Interface',
        manufacturer: 'Generic USB',
        state: 'connected',
        type: 'output',
        connection: 'closed',
        usable: false,
        statusReason: 'Port enumerated but connection is closed',
      },
      {
        id: 'out-ready-synth',
        name: 'Prophet-5 MIDI Out',
        manufacturer: 'Sequential',
        state: 'connected',
        type: 'output',
        connection: 'open',
        usable: true,
      },
    ];

    assert.equal(describeMidiDeviceStatus(devices[1]).label, 'Port Unavailable');
    assert.notEqual(describeMidiDeviceStatus(devices[1]).tone, 'success', 'enumerated closed port is NOT Ready');
    assert.equal(describeMidiDeviceStatus(devices[2]).label, 'Ready');

    const missingStatus = describeChannelMidiRouteStatus(
      ch0,
      devices.filter(d => d.type === 'output'),
      { status: 'ready', errorMessage: null },
    );
    assert.equal(missingStatus.label, 'Unavailable (Disconnected)');
    assert.equal(missingStatus.tone, 'danger');

    // Hot-unplugged port still enumerated in MIDIAccess.outputs with state === 'disconnected':
    const hotDisconnectedPort: MidiDeviceInfo = {
      id: 'out-ready-synth',
      name: 'Prophet-5 MIDI Out',
      manufacturer: 'Sequential',
      state: 'disconnected',
      type: 'output',
      connection: 'closed',
      usable: false,
      statusReason: 'Hardware device disconnected',
    };
    assert.equal(describeMidiDeviceStatus(hotDisconnectedPort).label, 'Disconnected');
    const hotDisconnectedRouteStatus = describeChannelMidiRouteStatus(
      ch2,
      [devices[1], hotDisconnectedPort],
      { status: 'ready', errorMessage: null },
    );
    assert.equal(hotDisconnectedRouteStatus.label, 'Disconnected');
    assert.equal(hotDisconnectedRouteStatus.tone, 'danger');
    assert.equal(hotDisconnectedRouteStatus.detail, 'Hardware device disconnected');

    const markup = renderToStaticMarkup(
      <MidiControllerModal
        isOpen
        onClose={() => undefined}
        channels={[ch0, ch1, ch2]}
        mixerTracks={project.mixerTracks}
        midiMappings={project.midiMappings}
        onUpdateMidiMappings={() => undefined}
        activeChannel={ch0}
        onUpdateChannel={() => undefined}
        midiAccessStateOverride={{ status: 'ready', errorMessage: null }}
        devicesOverride={devices}
      />,
    );

    assert.match(markup, /data-testid="midi-input-devices-section"/);
    assert.match(markup, /data-testid="midi-output-devices-section"/);
    assert.match(markup, /data-testid="channel-midi-output-routing"/);
    assert.match(markup, /data-testid="midi-output-panic-btn"/);
    assert.match(markup, /KeyStep Pro In/);
    assert.match(markup, /Prophet-5 MIDI Out/);
    assert.match(markup, /Port Unavailable/, 'enumerated closed output port displays Port Unavailable instead of Ready');
    assert.match(
      markup,
      /Unavailable: unplugged-oberheim-ob-x8 \(Disconnected\)/,
      'missing configured device remains visibly selected as Unavailable rather than substituted',
    );
    assert.match(markup, /Ready · Ch 5/);
  });

  it('renders honest Web MIDI unsupported / permission-denied banners and ExportModal external-MIDI truthfulness notice', () => {
    const project = createDefaultProjectState();
    const unsupportedMarkup = renderToStaticMarkup(
      <MidiControllerModal
        isOpen
        onClose={() => undefined}
        channels={project.channels}
        mixerTracks={project.mixerTracks}
        midiMappings={project.midiMappings}
        onUpdateMidiMappings={() => undefined}
        activeChannel={project.channels[0]}
        midiAccessStateOverride={{
          status: 'unsupported',
          errorMessage: 'Web MIDI API is not supported in this browser.',
        }}
        devicesOverride={[]}
      />,
    );
    assert.match(unsupportedMarkup, /Web MIDI Unavailable in This Browser/);

    const deniedMarkup = renderToStaticMarkup(
      <MidiControllerModal
        isOpen
        onClose={() => undefined}
        channels={project.channels}
        mixerTracks={project.mixerTracks}
        midiMappings={project.midiMappings}
        onUpdateMidiMappings={() => undefined}
        activeChannel={project.channels[0]}
        midiAccessStateOverride={{
          status: 'denied',
          errorMessage: 'User denied MIDI permission.',
        }}
        devicesOverride={[]}
      />,
    );
    assert.match(deniedMarkup, /Web MIDI Permission Denied/);

    // ExportModal with all channels Off -> no external MIDI warning banner
    assert.equal(describeExternalMidiExportNotice(project.channels), null);
    const defaultExportMarkup = renderToStaticMarkup(
      <ExportModal
        isOpen
        onClose={() => undefined}
        channels={project.channels}
        clips={project.playlistClips}
        meta={project.meta}
        mixerTracks={project.mixerTracks}
      />,
    );
    assert.doesNotMatch(defaultExportMarkup, /data-testid="export-external-midi-notice"/);

    // ExportModal with External-only channel -> renders explicit external hardware audio notice
    const externalChannels = project.channels.map((ch, idx) =>
      idx === 0
        ? { ...ch, name: 'Analog Bass', midiOutput: { outputDeviceId: 'moog-1', midiChannel: 1, mode: 'external' as const } }
        : ch,
    );
    const externalExportMarkup = renderToStaticMarkup(
      <ExportModal
        isOpen
        onClose={() => undefined}
        channels={externalChannels}
        clips={project.playlistClips}
        meta={project.meta}
        mixerTracks={project.mixerTracks}
      />,
    );
    assert.match(externalExportMarkup, /data-testid="export-external-midi-notice"/);
    assert.match(externalExportMarkup, /External MIDI hardware audio is not included in offline WAV\/stem exports/);
    assert.match(externalExportMarkup, /Analog Bass/);
  });
});
