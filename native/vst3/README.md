# Native VST3 instruments in Apex Studio (Windows x64 desktop)

## Use the delivered channel workflow

1. Install a trusted Windows x64 VST3 instrument. Open **Instruments**, select an
   existing channel, expand **VST3 instruments — desktop only**, add its folder
   (the standard Common Files/VST3 location is included), and scan.
2. Stop transport, then **Load** an actual discovered instrument. Factory class
   ID/name/vendor/version and the supported native state are captured before
   publishing the selection. The channel owns one shared polyphonic instance.
3. Write notes in the existing Piano Roll/Channel Rack or arrange pattern clips
   in the Playlist. Play transport, use audition keys, or send existing hardware
   MIDI. Hardware notes hold until their actual note-off. Channel fader/pan,
   mixer fader/pan, supported insert FX/routing and master apply to native PCM.
4. Save/reopen the normal Apex project. Only identity and supported state are
   serialized—not executable handles, generated buffers or plugin binaries.
   Undo/redo preserves configuration. The generic parameter editor stages real
   writable values, then Apply commits an acknowledged native batch and one
   project history action. Original component/controller streams are preserved;
   explicit overrides are replayed after them. See [parameter guide](../../docs/VST3-PARAMETERS.md).
5. Export through the existing production song/pattern/bounce/export workflow.
   A separate native session renders scheduler MIDI into the actual offline
   channel/mixer graph **before** `OfflineAudioContext.startRendering()`.
   A missing instrument fails an audible export; no substitute synth is used.
6. If a load/state/file fails, original project data stays intact. Open Instruments
   to **Retry saved instrument**, add/scan a moved folder and **Relink / restore**
   the exact class ID, **Reset to plugin defaults** for invalid state (undoable),
   or explicitly replace the instrument.

The web application retains native configuration but explicitly refuses native
playback/audible native export. Built-in instruments still work in browsers.
Loading third-party code is desktop-only; it is not browser WebAssembly.

## Reproduce real native and production-DAW tests

Requirements: Node 22, Git, CMake >= 3.25; Windows x64 with installed Visual Studio
C++ build tools/Windows SDK, or Linux x64 with GCC and Ninja for automated DSP
verification. No commercial plugin, paid service or committed plugin binary.

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run native:vst3:build
npm run test:native-vst3
npm run test:vst3-daw
npm run test:audio
npm run test:history
npm run test:browser:node
npm run lint
npm run verify:desktop
npm run build
```

Set `CMAKE` if necessary (e.g. `/home/user/.local/bin/cmake`). Dependencies and
all generated evidence live under gitignored `build/`. Missing native builds
fail the dedicated tests rather than silently skipping.

`test:vst3-daw` uses the real service/helper and real SDK MDA instrument, the
**production AudioEngine/InstrumentRegistry/AudioClockTransport**, actual Web
Audio DSP and context.destination, production offline rendering, serializer,
normalizer, channel mutation and undo/redo. Independent native PCM references
must match live-graph and song-export samples. Other assertions cover fractional
onsets, pitch/velocity, overlapping notes/note-off, held MIDI, live gain/pan,
mixer/FX/master, missing/invalid state, browser refusal, ownership/queue bounds,
async-start cancellation, repeated replacement/cleanup, helper crash/hang and
retry. The non-audio fault executable is used ONLY for failure rejection.

Generated production evidence in `build/native-evidence/`:

- `apex-song-vst3-{16,24,32}.wav`: actual production song exports at 48 kHz.
- `apex-song-metrics.json`: intended note frame 108000; audible JX10 onset
  108014 (native envelope), native-reference difference RMS **0**, released RMS
  **0**. This includes bar-1 Playlist placement plus step-2 Piano Roll onset.
- `apex-live-vst3.wav`, `apex-live-metrics.json`: production transport/live output
  graph; 30 ms transport lead, audible onset 1454, overlapping voice RMS
  ~0.0963, released RMS **0**, native-reference difference RMS **0**.
- `apex-vst3-project.json`: actual serialized project configuration/state.
- Earlier `mda-jx10-*`/`metrics.json` are independent native-host reference tests,
  **not** production song or device-playback proof.

Node live tests use RenderingAudioContext to drive the genuine Web Audio graph
on a reproducible clock. They do not prove physical speaker/interface latency.

### Windows packaging and genuine Electron smoke

On Windows, with Electron installed (`npm ci --legacy-peer-deps`):

```sh
npm run package:win:dir
npm run test:vst3-daw
npm run smoke:win
```

Packaging builds the pinned native helper, statically links the MSVC CRT, stages
it and licenses outside ASAR at `resources/vst3/`, and includes only the narrow
main/preload service/adapter files. Missing helper staging fails packaging. The
MDA test plugin is NOT distributed in the application.

The existing packaged smoke now supplies the external real MDA test bundle via
main-process launch environment, and requires **real packaged preload IPC**,
genuine discovery/load/native PCM, production Chromium live master-graph signal,
production offline song timing and missing-plugin refusal. It saves via the
production IndexedDB writer into an isolated profile, exits the application,
then launches a second process and requires the actual UI to restore the native
channel. Native identity/state and exported PCM checksums must match across the
application restart. The real user profile is never modified.
It does not generate test-only replacement audio. Its entry is gated by the
existing smoke launch flag; ordinary sessions expose no test entry/API.
The Native VST3 and Desktop Validation workflows run these on Windows; native
DSP and deterministic DAW integration also run on Linux. Inspect final-head CI
for results—test source alone is not a claimed passing Windows run.

## Async architecture and explicit limits

- Registry adds optional **channel ownership**, preserving synchronous built-in
  voice dispatch. `playSingleVoice` dispatches native before per-note disposable
  gain/pan nodes. Native PCM flows through one channel gain into the same channel
  panner/mixer/master, never a parallel output or per-note frozen instrument.
- `play()` prepares native channels asynchronously before starting transport;
  built-in-only playback stays synchronous. No awaiting native IPC in the
  scheduler/audio callback. A control-thread producer schedules finite 1024-frame
  AudioBufferSource batches, targeting 50 ms buffered audio with a 5 ms pump.
  The audio thread only consumes already scheduled Web Audio buffers.
- One process request in flight per instance; max four live batches per pump,
  8 live channels, 16 total helpers including exports/loading/closing, 1024 held
  voices/channel, 8192 queued live events, 4096 events/native batch. MIDI remains
  sample-offset pitch/channel/velocity/note-ID note-on/off on the existing model.
- Direct monitoring starts with 40 ms lead plus buffered/device latency. The
  diagnostic reports buffered input delay; **not zero latency**. Late scheduled
  MIDI or >5 ms late PCM/underrun stops native audio with a visible diagnostic;
  sub-5 ms late PCM is trimmed, never replayed/time-shifted.
- Helpers have a 2 s operation deadline and bounded protocol frames/queues.
  Scans are limited to 256 bundles/30 s, approved real paths, no followed
  symlinks. At most two scans; duplicate owner scans are rejected. Main-frame
  IPC authorizes paths/ownership; renderer never chooses executable/raw command.
- Stop, replacement, context closure, renderer navigation/crash/destruction and
  app exit cancel/close owned resources. Disposed generations cannot play late
  PCM. Note release cleanup is bounded at 10 s; unusually long tails may be cut.
- Offline preparation is capped at **128 MiB native PCM across channels** (roughly
  5.8 minutes for one stereo channel at 48 kHz; fewer with multiple channels).
  Oversized exports fail explicitly; no silent/truncated export. Exports still
  use the existing isolated render lease, scheduler and mixer contracts.
- First slice supports x64 VST3 instruments with mono/stereo main output and
  **zero reported processing latency**. Other latency is rejected pending proper
  delay compensation. Plugins taking >2 s per operation are rejected.
- No VST2/AU/CLAP, native effects rack, plugin editor windows, full parameter automation lanes,
  per-note native pan, arbitrary-bus layouts or broad plugin certification.
  Native transport context is per-session; tempo-synchronized plugin internal
  sequencers/seek-position synchronization beyond scheduled MIDI are not claimed.
  Windows x64/MDA is the reproducible acceptance fixture; other plugins may vary.

### Isolation is not a security sandbox

Each plugin loads only in its helper, not Electron's renderer/main address space.
Abrupt exits, malformed protocol, hangs and cancellation reject/kill/reap helper
requests. Plugin code nevertheless has the user's OS privileges and can write
files, spawn children or attack the system. No hostile-plugin security guarantee
or physical-device listening/latency certification is claimed. Scan/load trusted
plugins only. No fallback oscillator or external service is used.

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
  a license to distribute users' plugins. Windows packaging ships the x64 helper outside ASAR with these notices
  and a statically linked MSVC runtime. No third-party plugin binaries are checked in.

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


## Generic parameter control contract (Issue #285)

`open` now forwards bounded genuine metadata; `describe` opens/restores a temporary
owned instance, returns validated metadata, then closes it. Names, short titles,
units, defaults, current normalized values, flags and step counts come from the
controller. A missing controller is explicit; invalid current values become
unavailable, not invented defaults. List choices require actual controller labels,
at most 128 choices per parameter and 4096 total labels. At most 4096 parameter
IDs / 4 MiB metadata are accepted, with duplicate IDs rejected.

During active playback, an edit waits for the current producer block and submits
changes **in the next actual PCM process block**, keeping MIDI ordering and the
held native voice. Only successful processing and scheduling can publish the new
configuration. Idle edits use a zero-sample processor flush; the host retains its
parameter queues for the next audible block too. This matters for the pinned MDA
sample-accurate processor, which otherwise accepts a zero-sample update without
recalculating audible coefficients. No generated block is thrown away or cursor
advanced by the idle flush.

The service excludes simultaneous process/parameter requests; the runtime
serializes its own producer and edits. IDs must be known uint32 integers and
values finite normalized [0,1]; duplicates, read-only, hidden, and program-change
writes are refused. Program changes can alter other parameters and require a
separate initialization/preset transaction, so this editor does not claim them.
Invalid native requests invalidate their instance; service preflight rejection
leaves a valid instance intact. Existing owner/origin/frame checks, limits,
2-second operation timeout, kill/reap and retry containment remain in force.

App checks abort, document generation, selected channel and the exact saved
instrument reference before publication through `mutateProjectState` /
`updateChannelInProjectState`. The immutable override list contains **only edits**;
metadata defaults are never copied wholesale. Old states with missing/empty
parameter overrides remain loadable. Undo/Redo is the existing native configuration
replacement path: it clears held notes and the restored instance is used on next
Play/audition, not a claim of sample-continuous history scrubbing.

`npm run test:vst3-browser` is an explicit native-required Chromium gate (no skip
when the helper is missing). It runs after building the real fixture on both
Windows and Linux in Native VST3 Validation, separately from the ordinary browser
suite. Its test-only transport uses the real privileged service, native DLL/SO
and production App/engine; it is not proof of Electron authorization. The packaged
Windows smoke separately exercises the actual preload/main bridge and reopens
edited state in a genuinely separate application process. Negative metadata UI
fixtures and protocol-fault tests are identified as such, never PCM evidence.
