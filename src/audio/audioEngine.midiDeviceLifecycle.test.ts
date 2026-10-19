import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { audioEngine, type MidiEventPayload } from './audioEngine';

interface FakeMidiPort {
  id: string;
  name: string;
  type: 'input' | 'output';
  state: 'connected' | 'disconnected';
  onmidimessage: ((event: { data: Uint8Array }) => void) | null;
}

interface FakeMidiAccess {
  inputs: Map<string, FakeMidiPort>;
  outputs: Map<string, FakeMidiPort>;
  onstatechange: ((event: { port: FakeMidiPort }) => void) | null;
}

const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalMidiAccess = (audioEngine as unknown as { midiAccess: unknown }).midiAccess;

const makePort = (id: string, type: FakeMidiPort['type']): FakeMidiPort => ({
  id,
  name: id,
  type,
  state: 'connected',
  onmidimessage: null,
});

const installFakeAccess = async (access: FakeMidiAccess): Promise<void> => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { requestMIDIAccess: async () => access } as unknown as Navigator,
  });
  await audioEngine.initMidi();
};

const fireStateChange = (access: FakeMidiAccess, port: FakeMidiPort): void => {
  assert.ok(access.onstatechange, 'initMidi must subscribe to MIDIAccess state changes');
  access.onstatechange({ port });
};

afterEach(() => {
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
  (audioEngine as unknown as { midiAccess: unknown }).midiAccess = originalMidiAccess;
});

describe('AudioEngine Web MIDI device lifecycle', () => {
  it('emits one deviceState event per input disconnect and ignores duplicate notifications', async () => {
    const input = makePort('keyboard-1', 'input');
    const access: FakeMidiAccess = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map(),
      onstatechange: null,
    };
    const events: MidiEventPayload[] = [];
    let cleanupCount = 0;
    const listener = (event: MidiEventPayload) => {
      events.push(event);
      if (event.type === 'deviceState' && event.deviceState === 'disconnected') cleanupCount += 1;
    };
    audioEngine.addMidiListener(listener);

    try {
      await installFakeAccess(access);
      input.state = 'disconnected';
      fireStateChange(access, input);
      fireStateChange(access, input); // duplicate delivery for the same disconnect

      assert.deepEqual(events, [{ type: 'deviceState', deviceState: 'disconnected', deviceId: input.id }]);
      assert.equal(cleanupCount, 1, 'a single physical disconnect must invoke cleanup only once');
    } finally {
      audioEngine.removeMidiListener(listener);
    }
  });

  it('does not emit input-disconnect events for output changes or input reconnects', async () => {
    const input = makePort('keyboard-2', 'input');
    const output = makePort('synth-output-1', 'output');
    const access: FakeMidiAccess = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map([[output.id, output]]),
      onstatechange: null,
    };
    const events: MidiEventPayload[] = [];
    const listener = (event: MidiEventPayload) => events.push(event);
    audioEngine.addMidiListener(listener);

    try {
      await installFakeAccess(access);
      output.state = 'disconnected';
      fireStateChange(access, output);
      input.state = 'connected';
      fireStateChange(access, input);

      assert.deepEqual(events, []);
    } finally {
      audioEngine.removeMidiListener(listener);
    }
  });

  it('reattaches note handling on reconnect and reports a later genuine disconnect once', async () => {
    const input = makePort('keyboard-3', 'input');
    const access: FakeMidiAccess = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map(),
      onstatechange: null,
    };
    const events: MidiEventPayload[] = [];
    const listener = (event: MidiEventPayload) => events.push(event);
    audioEngine.addMidiListener(listener);

    try {
      await installFakeAccess(access);
      assert.equal(typeof input.onmidimessage, 'function', 'the initial input must be attached');

      input.state = 'disconnected';
      fireStateChange(access, input);
      input.onmidimessage = null; // model the stale handler being detached while the port is absent
      input.state = 'connected';
      fireStateChange(access, input);
      assert.equal(typeof input.onmidimessage, 'function', 'reconnected input must be reattached');

      input.onmidimessage?.({ data: new Uint8Array([0x90, 60, 100]) });
      assert.ok(events.some(event => event.type === 'noteOn' && event.note === 60));

      input.state = 'disconnected';
      fireStateChange(access, input);
      fireStateChange(access, input);

      assert.deepEqual(
        events.filter(event => event.type === 'deviceState'),
        [
          { type: 'deviceState', deviceState: 'disconnected', deviceId: input.id },
          { type: 'deviceState', deviceState: 'disconnected', deviceId: input.id },
        ],
      );
      assert.equal(events.filter(event => event.type === 'noteOn').length, 1);
    } finally {
      audioEngine.removeMidiListener(listener);
    }
  });
});
