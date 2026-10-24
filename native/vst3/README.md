# Native VST3 instrument host — integration prototype, not a shipped feature

**Apex cannot yet select or play a VST3 instrument as a project channel.** This
change implements and tests a real native host, not the requested production
vertical slice. No plugin UI, preload API, project schema, or fallback synth was
added. The helper is intentionally **not in the desktop package**. Web and
built-in instrument behavior are unchanged.

## Run the real instrument tests

Requirements: Node 22, Git, CMake >= 3.25; Windows x64 with Visual Studio 2022 or newer C++
build tools and Windows SDK, or Linux x64 with GCC and Ninja. No audio device,
commercial plugin, VSTGUI, JACK, Electron download or paid service is required.

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run native:vst3:build
npm run test:native-vst3
```

If CMake isn't on PATH, set the `CMAKE` environment variable to its executable.
For example, on this Linux verification environment:
`CMAKE=/home/user/.local/bin/cmake npm run native:vst3:build`.
Everything downloaded/generated is under the existing gitignored `build/` tree.
A missing native build **fails** the dedicated tests; they never silently skip.
Normal web/package builds do not fetch or compile native dependencies.

Outputs under `build/native-evidence/`:

- `mda-jx10-{16,24,32}.wav`: real MDA JX10 PCM, encoded with Apex's production
  `audioBufferToWav` function. These are test exports, **not Apex song exports**.
- `metrics.json`: plugin factory identity, measured signal comparisons and PCM
  digest. There is no signal generator in the helper or test adapter.
- `plugin-state.json`: factory identity, actual component state stream and edited
  parameter IDs/values. This is a prototype state file, **not a saved Apex project**.

The native CI workflow builds/runs these tests on Windows and Linux and uploads
these outputs with third-party notices. Listening to a WAV demonstrates the
plugin's native DSP, **not live playback through the Apex transport**.

## Architecture implemented

`NativeVst3Client` asynchronously launches one standalone helper process per
instrument instance. No Node addon or Electron ABI dependency: the target
Electron version remains 43.4.1, Windows package architecture remains x64. The
C++ executable uses the official SDK's module loader, factory, `PlugProvider`,
component, controller, audio processor, event queues and parameter queues.

- `discoverVst3(executable, roots)` recursively scans explicitly supplied paths.
  Each `.vst3` bundle is opened in a separate helper. Only factory audio classes
  with an `Instrument` subcategory are returned, with actual class ID, name,
  vendor/version and bundle path. Missing roots and broken bundles retain
  explicit diagnostics. Symlinks aren't followed; traversal/candidate limits
  prevent unbounded scans. No fabricated discovery results.
- `open` resolves **exactly** the requested class ID, initializes and connects
  component/controller, selects event bus 0 and mono/stereo main output 0,
  configures float32 processing and activates the instance. No first-class or
  built-in-instrument substitution. Mono output is copied to both channels.
- `process` sends bounded batches of sample-offset note-on/off events (pitch,
  MIDI channel, velocity, stable note ID), normalized parameter changes keyed by
  VST `ParamID`, and transport sample position/tempo/meter. One persistent plugin
  instance handles polyphony across batches. It returns the plugin's actual PCM
  and honors output silence flags. Invalid/nonfinite results fail explicitly.
- Both VST `kRealtime` and `kOffline` modes use this processor. Tests compare their
  PCM across different batch sizes. `kRealtime` here does **not** mean device
  streaming, AudioWorklet integration or low-latency performance has been tested.
- `snapshot` preserves supported component/controller `IBStream` bytes and
  explicit parameter overrides. Unedited controller defaults are not sent back
  as DSP changes: the MDA mapped pitch-bend controller's default differs from
  the processor's actual initialized value. Restore rejects wrong identities,
  schemas, absent parameter IDs, corrupt streams or plugin API failures.
- Normal close disconnects/terminates plugin objects before unloading the
  module. Partial initialization/process/restore errors invalidate the instance.
  Parent-side queue bounds, response size validation, deadlines, cancellation,
  EOF and process-exit handling ensure requests reject instead of returning
  fabricated audio. Tests cover cancellation, abrupt helper exit, malformed
  frames and hangs using a separate **non-audio** IPC fault executable.

Protocol: newline-delimited JSON requests; responses contain little-endian
32-bit JSON length and PCM byte length, UTF-8 JSON, then planar stereo float32.
Batches are 1–16384 frames; the sequence-render utility defaults to 4096. No
blocking IPC and no per-sample cross-process messages. This is a bounded
prototype pipe protocol, **not yet a realtime audio transport**.

### Isolation and security

Only the helper loads third-party native code. An exited/hung helper is detected
and killed/reaped without terminating the Node parent in the fault tests. This
is **not an OS sandbox**: plugin code has the user's filesystem/process/network
privileges, may spawn children, write stdout and break framing, or destabilize
the system. Fault injection tests exercise helper failures, not arbitrary hostile
plugins or verified Windows Electron crash isolation. Do not scan untrusted
plugins. No security claim beyond the tested process boundary is made.

## Pinned SDK, fixture and licensing

- `steinbergmedia/vst3sdk` **3.8.0 build 66**:
  `9fad9770f2ae8542ab1a548a68c1ad1ac690abe0`.
  Required submodules are pinned by that SDK commit: base
  `3d2e82f8e6bff59c1d8b7a27491a29c2286b5206`, cmake
  `de6e54eeaaab35b7145f5c32c279b5e892146e04`, pluginterfaces
  `31d6eeba6daaa3e2a8bfbe3e7a90ca0b7fbfbc1c`, public.sdk
  `a3911a4615dabbfdfd9d181ee26b05c70c289a95`.
- `nlohmann/json` **3.11.3**:
  `9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03`.
- The pinned SDK and its required components use MIT, as do JSON and the MDA
  examples. Full notices are retained in `licenses/`; the examples retain Paul
  Kellett's attribution. This does not confer Steinberg trademark/logo rights or
  a license to distribute users' plugins. Future packaging must ship the helper
  outside ASAR, include its notices and Windows runtime dependencies, and build
  matching architectures. No third-party plugin binaries are checked in.

**Fixture correction:** the pinned MDA `SampleAccurateBaseProcessor` consumes an
input event at a 16-frame slice boundary in the preceding slice (`<=`); the
instrument's synth loop never applies an event at the end of that slice. This
caused a real all-silence failure at note frame 4800. CMake generates a copy of
`mdaBaseProcessor.cpp` retaining its license with exactly this correction:

```diff
-if (event.sampleOffset <= data.numSamples)
+if (event.sampleOffset < data.numSamples)
```

The checkout is not modified. This is a test-instrument correction, not a host
special case or a replacement oscillator. Tests explicitly check onsets at 0,
1, 16, 704, 4096 and 4800. The built bundle exposes the real MDA DX10, EPiano,
JX10 and Piano instruments; DSP assertions use JX10 and Piano as independent
instruments, plus silence, held/released notes, pitch, velocity and filter
parameter negative controls.

## Integration decision gate: exact boundary and smallest remaining change

The native SDK is viable; this work does **not** establish that VST3 hosting is
impossible. It stops short of enabling an unsafe or misleading production path.
The missing component is an asynchronous, channel-owned PCM bridge:

1. `src/audio/instrumentRegistry.ts`: `InstrumentVoiceRenderer` returns
   `InstrumentVoiceHandle | void` **synchronously**. The registry falls back for
   unknown types. `AudioEngine.playSingleVoice` calls it synchronously, rejects a
   Promise as an invalid handle, and owns note-specific gain/pan cleanup. A
   polyphonic VST instance instead has one shared channel audio output and many
   MIDI voices. Returning a Promise, routing a whole instance through the first
   note's disposable gain node, or falling back to MiniSynth is incorrect.
2. `src/audio/transport.ts`: the scheduler has a 100ms lookahead and short start
   lead. `AudioEngine.play` and the hardware-MIDI `playNote` path cannot await an
   IPC round trip. Waiting in the callback will not give the AudioContext native
   PCM and risks missed deadlines. Pipe tests don't prove realtime scheduling.
3. `AudioEngine.renderTimelineOffline` temporarily swaps in its isolated offline
   context under a render lease, calls the **same synchronous** step/registry
   scheduling path and then `startRendering()`. An async renderer can return PCM
   after scheduling/rendering has finished, producing a misleading silent export.
   `offlineProjectRenderer.ts` is **not** the production export entry point.
4. `src/types/daw.ts`, `state/projectState.ts`, `state/projectPersistence.ts` and
   `state/projectHistory.ts` currently own serializable channels/history snapshots;
   `audio/audioPersistence.ts` and `sampleBufferPersistence.ts` separately own
   audio assets. Native process handles must never enter snapshots or audio-asset
   garbage collection. Snapshot capture must precede save/history publication;
   missing-plugin metadata/state must remain intact for relink/retry. No new
   native state has been written into these contracts yet.
5. `midiRecording.ts` already records the existing fractional-step `Note` model;
   instrument renderers resolve its gate using project BPM. Keep that model and
   registry. Extend the registry with a channel-level native session lifecycle,
   separate from synchronous built-in note voices, rather than inventing a
   second piano roll or a detached demo transport.

The smallest safe follow-up is: a typed desktop-only bridge for asynchronous
session preparation/state capture; a channel-owned AudioWorklet PCM FIFO with
bounded batched delivery, generation fencing, underrun diagnostics and measured
latency; and an explicit async native preparation/flush stage **before** the
production offline context renders. Route both through existing channel mixer
inputs, preserving sends/FX, tempo, seeking, mute/solo and render leases. Tie
session disposal/cancellation to project/channel replacement and undo/redo. Only
then add validated persisted identity/state plus a relink UI, and only then ship
plugin selection. Shared-memory rings (with explicit cross-origin isolation) or
transferred batches need benchmarking in the packaged Electron environment.
Migrating the entire mixer/device backend to native is viable but much larger;
per-note frozen buffers lose shared-instance/held-note semantics and are not an
acceptable substitute. None of these alternatives is claimed implemented here.

### Acceptance status

Native prototype discovery/load, MIDI/pitch/velocity/note-off DSP, polyphony,
state-file reload, explicit failures/retry and resource-failure handling are
implemented and tested. **Unmet:** production user-configured path UI, VST3
channel selection, registry/Piano Roll live playback, hardware-MIDI monitoring,
physical-device playback, native instrument participation in Apex song/stem
export, Apex project/history state integration and relink UI, packaged-helper
integration and packaged Electron/native end-to-end tests. Existing regression
checks do not turn these unmet criteria into passes.
