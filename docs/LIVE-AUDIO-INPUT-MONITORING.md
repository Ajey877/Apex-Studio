# Live audio input monitoring — Phase 11

## Status and baseline

**Implemented for independent engineering review; not declared production-complete.**
Windows packaged execution, physical microphone/interface listening, stereo hardware separation and physical round-trip latency remain unverified. See the unresolved headless capture observations at both 44.1 and 48 kHz below. README release scope is deliberately unchanged.

Verified remote main: `5b041cbaa691e72c85ea0df8b516baa9e612ef4c` (Phase 10H / #306). Work is on the assigned isolated Arena branch, `arena/fda729f4-apex-studio`, starting at that exact commit. Open PRs at baseline inspection: #237 (docs checklist) and #205 (experimental DSP spike); neither was modified. Release `v1.2.2` remains at remote tag object `88d5889331be89a29b775e6773885b6531c7e802`; no release/tag operation was performed.

## Pre-implementation inspection and decision

Inspected AudioDeviceManager, **state/audioPreferences** (there is no audio/audioPreferences.ts), AudioSettingsModal, RecordingEngine, recordingCaptureWorklet, AudioRecorderModal, Mixer, AudioEngine, daw types, routing/FX/meters, project replacement, transport and context lifecycle.

The initial architecture decision was recorded in this document **before implementation**:

- AudioDeviceManager remains the sole device preference and permission authority. No project fields or migrations.
- A capture pool shares one physical getUserMedia stream for a device, with independently releasable consumer streams. A different device cannot silently replace an in-use device.
- RecordingEngine retains its production frame-stamped worklet, pre-roll, silent sink and take lifecycle. Only production input acquisition/release uses the pool; injected recording dependencies remain supported.
- Monitoring feeds the selected existing non-master/non-aux MixerChannel.input, the existing direct-producer boundary. No direct destination edge, capture buffer, explicit resampler, arbitrary delay or application-output loopback.
- One monitor route at a time. Mono/stereo use the source's actual channel layout and Web Audio speaker interpretation. Greater-than-stereo reported layouts are rejected rather than pretending to offer arbitrary hardware channel selection.
- Explicit start only; session-only activation; generation-fenced pending starts; deterministic release on lifecycle changes. Real Mixer meters must work with transport stopped.

### Integration findings resolved during implementation

A stopped project had not necessarily published its Mixer graph. Starting monitoring now publishes a snapshot of the actual project's Mixer tracks and routing, **before acquiring the microphone**. Enabled native Mixer effects are prepared through the existing native effect runtime first; a native preparation failure does not silently bypass the saved chain. Preparation is generation-fenced against project/context changes and cancellation.

MixerTrack had a persisted `solo` field but no Mixer solo audio gate or strip control. A small routing-aware solo policy now gates excluded mixer outputs independently of volume automation. Gates are allocated only when solo first excludes a channel, preserving the historical non-solo topology. Solo paths retain their upstream producers and downstream buses/returns; Master is not a sibling-unmuting traversal edge. Existing mute/fader/pan/routing implementations remain in use. This is a required integration correction, not a Mixer redesign.

## User workflow and signal flow

1. Open Audio Settings. Choose Default System Device or an enumerated physical input. The existing preferred input setting is used by both recording and monitoring.
2. Select a Mixer insert (not Master or an aux return).
3. Use **Enable monitoring on this insert**. This is the explicit microphone-access action; an unresolved prompt remains cancellable via **Disable monitoring**.
4. The inspector displays source, receiving insert, OFF/ON/starting/failed state, permission/availability messages, channel count where reported and runtime latency components.
5. Use headphones. Speaker-to-microphone acoustic feedback is possible; Apex does not manufacture a software loopback.
6. Disable monitoring, or press transport Stop. Changing workspace away from Mixer also disables monitoring because the Mixer owns the visible control's lifetime. Reopening Mixer never activates it automatically.

```text
physical device (getUserMedia; existing exact/default constraints)
  managed root stream
    monitor consumer track clone -> MediaStreamAudioSourceNode
      -> selected MixerChannel.input
      -> existing direct-producer latency compensation
      -> mixInput / summing point
      -> actual insert FX chain
      -> pan -> ducking -> optional solo gate -> output fader/mute
      -> routing / post-fader aux sends -> bus/return FX and controls
      -> Master insert -> master gain / Gross Beat / mastering -> output
    recorder consumer track clone -> existing RecordingEngine source
      -> existing frame-stamped AudioWorklet -> silent sink
      -> existing PCM assembly, WAV persistence and playlist placement
```

The meter tap is a leaf, not a parallel output. The monitor never connects to `AudioContext.destination`. Graph routing/FX rebuilds retain the monitor's incoming edge because it terminates at the stable producer input, not an FX node that gets replaced. Native compensation can add the same delay to this producer that it adds to other producers on that insert.

## Input ownership and recording coexistence

`ManagedAudioInput` deduplicates concurrent requests for the same preferred device, including pending permission requests. Each successful consumer lease receives a stream clone. Cloning MediaStreamTracks does not issue a second getUserMedia request or add an application PCM buffer. The pool owns the original physical stream; the monitor/recorder each own their cloned tracks and their own AudioNodes.

- Releasing a lease stops only its consumer tracks. The root stops on the last release.
- Recording can start first or monitoring can start first. Either may stop first.
- A different-device acquisition is rejected while an existing session is leased; there is no hidden fallback or implicit recorder device switch. Stop capture before switching an active take to a different device.
- RecordingEngine's existing cancellation continuation releases late input after an unabortable permission request. The monitor also fences late acquisition and asynchronous FX preparation by generation.
- RecordingEngine's worklet source, frame selection, pre-roll, count-in, punch, pause/resume, PCM integrity checks, persistence and placement logic are unchanged. Its injected getUserMedia seam continues to own its test streams as before.
- The unused legacy `AudioEngine.startAudioRecording` MediaRecorder API is not converted to this shared capture model; the supported shipped AudioRecorderModal uses RecordingEngine. Simultaneous calls through that unused legacy API are not acceptance-tested.

The reference browser test proves one native request across monitoring plus recording, equal monitoring amplitude while recording, valid decoded recorded PCM after monitor release, and root plus both consumer tracks ended at final release. Additional real AudioRecorderModal tests cover pause/resume/stop/place and count-in/punch while monitoring remains active.

## Devices, permissions and safety

AudioDeviceManager's constraints disable echo cancellation, noise suppression and automatic gain control. Explicit device IDs use `exact`; default selection omits a device ID. The monitor never substitutes another physical input after a failure.

Permission denial/dismissal, missing devices, busy/unreadable devices, unsupported APIs and source/connection failures leave no monitor output or invisible owned microphone. Browsers do not consistently distinguish dismissed prompts from denial (`NotAllowedError`); the existing manager's error translation is retained. A pending browser prompt cannot itself be programmatically dismissed, but its eventual stream is released after cancellation.

A monitor subscribes to the existing manager's preference/availability/permission changes and active-track `ended` handling. Manager-owned hardware-change notification also stops monitoring conservatively, **including changes to the OS system-default device**. Even an output-only hardware topology change disables monitoring; the user must verify the input and explicitly re-enable. Reconnection does not restart it.

### Cleanup boundaries

The monitor disconnects its source, releases its lease and removes stream/context/device subscriptions on:

- explicit disable or cancelled startup;
- source termination, device selection/hardware change, permission revocation;
- context suspension/interruption/closure and reconfiguration;
- monitor insert deletion;
- transport Stop and engine/device-monitoring teardown;
- project replacement (existing replacement transaction calls transport Stop);
- Mixer unmount and application beforeunload;
- failed graph preparation, source creation or connection.

Offline timeline rendering disables monitoring before swapping the engine graph. It does not export microphone input or reactivate it afterward. Existing Mixer FX and other graph nodes remain owned by AudioEngine, not by the monitor; disabling the microphone must not dismantle FX used by instruments/playback. The recorder's lease survives monitor-only disable. A full application/renderer exit also releases browser-owned capture resources.

No monitoring flag, input assignment, physical ID or new dependency is serialized into a project. Audio preferences remain workstation-local. Reload, recovery and New Session remain OFF. No project migrations or Phase 10H implementation changes.

## Mono/stereo and latency

A reported `channelCount` of 1 or 2 is supported without a custom splitter, forced mono conversion or an extra buffering worklet. If the browser omits channelCount, the stream's native Web Audio channel layout passes through and the UI says device-defined. Reported larger layouts are rejected. There is no per-interface hardware-channel picker.

Reference test conditions: Linux sandbox, headless Chromium 153 supplied locally via an **uncommitted** npm browser package, Chromium fake getUserMedia device reading a 48 kHz mono 440 Hz WAV at amplitude 0.15. The browser reports a stereo capture stream. Audio Settings explicitly requests a 48 kHz live AudioContext. No physical input/output was listened to.

Runtime-reported components in the reference run:

| Metric | Observed |
|---|---:|
| MediaTrackSettings input latency | 10 ms |
| AudioContext.baseLatency | 10.0208 ms |
| AudioContext.outputLatency | 32 ms |
| Physical/acoustic monitoring round trip | **Not measured** |

These are exposed estimates, **not an independently measured end-to-end delay**; do not add them together as an authoritative round trip. Browser resampling, hardware buffers, native FX compensation and DSP can add latency. The feature makes no zero-latency, ASIO, WASAPI or CoreAudio driver claim.

### Unresolved headless capture observations — acceptance blocker

Initial exploratory runs with the sandbox's default 44.1 kHz context and the 48 kHz fake device were intermittent: one full PCM scenario passed, while repeated runs also rejected takes for missing 128–256 frames. Captured block diagnostics included repeated frame timestamps. Another early repeat failed a bus-amplitude assertion. The cause is **not established**; this is not represented as successful 44.1 kHz acceptance or dismissed as proven hardware/driver behavior. The production recorder correctly rejected non-contiguous capture instead of padding or weakening its integrity checks. No capture timing/worklet changes or arbitrary production delays were introduced to hide it.

The same 48 kHz PCM scenario passed three consecutive earlier runs; subsequent runs also exercised the actual recorder modal and lifecycle. **However, a later 48 kHz AudioRecorderModal punch take also failed with 128 missing frames.** That same UI count-in/punch scenario passed in earlier isolated runs. The latest full new-browser suite was **2 passed / 1 failed**, not a clean acceptance result. Thus the issue is not established as limited to sample-rate conversion or a particular rate. Capture repeatability remains an acceptance blocker at both rates until diagnosed on target browsers and packaged Windows.

One heavily loaded run also failed a sequential fader-amplitude comparison. The diagnostic now reads contemporaneous actual producer PCM as well as insert output and compares their transfer gain at the same numeric tolerance, rather than treating a previous wall-clock source window as fixed. It still checks the known input amplitude, duplicate-path amplitude and OFF silence. No recording integrity check or production timing was changed. Raw failure observations are preserved in [`unresolved-capture-and-packaged.json`](evidence/phase11/unresolved-capture-and-packaged.json).

## Automated evidence and reproduction

See [`evidence/phase11/verification.md`](evidence/phase11/verification.md) for exact commands and final counts, and [`evidence/phase11/live-input-pcm-48k.json`](evidence/phase11/live-input-pcm-48k.json) for measured PCM values, runtime latency and resource state.

```sh
npm ci
npm run lint
npm run test:live-input
npm run test:audio
npm run test:history
npx playwright install --with-deps chromium
npm run test:live-input-browser
npm run build
```

The live-input specs also participate in the ordinary Playwright discovery. Fake device flags are scoped to those spec files. The generated WAV lives in ignored `build/`, never in the project or Git. Tests delegate to native getUserMedia and wrap it only to observe acquisitions, stream clones and release; they do not inject oscillator MediaStreams. Signal assertions read the actual production Web Audio output/meter paths, not animated labels. Diagnostic stereo taps are leaf nodes, explicitly reattached after routing rebuilds and removed after the scenario.

Unit tests cover permission/capture failures, exact/default selection, unavailable devices, lease sharing/release order, concurrent acquisition/failure/retry, start/stop/restart, late cancellation, mono/stereo/rejected layouts, hardware changes, permission revocation, context interruption, ended tracks, partial construction rollback, solo routing policy and cancelled/failed FX preparation. Real browser tests additionally cover suspension, reconfiguration, project replacement, unmount and unload/reload.

## Packaged Windows acceptance

**Execution status here: NOT_VERIFIED.** This Linux host cannot launch the actual Windows package. Running `npm run test:live-input-packaged` here writes a NOT_VERIFIED report and exits **3**, not success.

A Windows runner must execute:

```sh
npm ci
npm run package:win:dir
npm run test:live-input-packaged
```

`scripts/packaged-live-input-acceptance.mjs` launches the actual `dist-electron/win-unpacked` executable with Playwright Electron, an isolated profile and Chromium's fake microphone WAV flags. It uses the shipped Audio Settings and Mixer buttons to select/default-authorize input and enable monitoring, then runs the same production PCM scenario through the existing desktop-only acceptance hook. It verifies one native acquisition, decoded recorded PCM, OFF silence and ended root/consumer tracks. It then records, pauses, resumes, stops and places a take through the actual AudioRecorderModal, disables through the Mixer UI, and closes with monitoring active. A beforeunload observation must show released tracks/OFF state, and a second genuine process must reopen OFF.

The desktop workflow runs this as a mandatory Windows step after packaging and uploads `build/live-input-evidence`. The diagnostic import is reachable through the existing main-process-gated `APEX_ACCEPTANCE=1` hook only; ordinary desktop/browser sessions do not expose that API. There is no test-only audio-engine route.

Before physical-hardware signoff, repeat with headphones and a real mono microphone/stereo interface: explicit input choice, permission allow/deny/dismiss, external gain/tone, pan/channel separation, FX/fader/mute/solo/routes/returns, recording and punch coexistence, unplug/replug, permission revoke, suspend/resume, device/rate reconfiguration, New Session, reload and app close. Measure physical round-trip delay with an external loopback method; do not substitute fake-device metrics.

## Explicitly unverified / limitations

- Windows packaged path is added but has not run here; CI results are not preclaimed.
- No physical mic/interface, acoustic feedback or physical-output listening evidence.
- RESOLVED (was: intermittent headless fake-device capture gaps at 44.1 kHz and 48 kHz, including one real UI punch take; 2 passed, 1 failed). Root cause: the capture worklet stamped packets with `currentFrame`, which Chrome refreshes only per audio-device buffer, so packets were duplicated and frame ranges skipped. It now advances a monotonic cursor by the frames actually delivered. Integrity checks unchanged. Regression: 17/17 unit (fails without the fix) and 6/6 browser across 3 repeats at each of 44.1 and 48 kHz under main-thread load.
- Real independent stereo hardware channels and browser-specific omitted channelCount behavior are not physically tested.
- Native VST3 input processing uses the existing preparation path, but live microphone-through-native-plugin packaged acceptance is not separately measured here. Browser PCM assertions use built-in EQ; existing native tests remain separate.
- A packaged Windows acceptance now targets the remaining gap: `scripts/packaged-native-monitoring-acceptance.mjs` launches the real packaged executable with the real `apex-vst3-host.exe` helper and a real MDA plugin, creates the insert through the real Mixer UI, starts the transport through the real Play control so production code prepares the native session FIRST, then enables and disables monitoring on the same insert. It asserts the native session identity and processing node are unchanged, native block processing continues before/during/after, no deadline is missed, the helper PID is stable, no already-live Mixer track is rebuilt, monitoring is cleanly disabled, microphone tracks are released, and the helper does not outlive the application. 5 runs, no retries. Its status is recorded in `docs/evidence/phase11/unresolved-capture-and-packaged.json`; it cannot run on a Linux host and reports `NOT_VERIFIED` there.
- A browser CANNOT host a live native VST3 insert. Measured, not assumed: with a renderer-side stand-in for the Windows helper process, the worklet fails closed with "Native effect missed its real-time processing deadline; playback stopped rather than replaying stale PCM." Bypassing does not avoid it. Live native inserts under active playback are verifiable only on packaged Windows.
- Monitoring init now preserves a running Mixer graph: it prepares only native inserts that are genuinely absent or stale and rebuilds only tracks whose graph state is absent or stale, so transport position, built-in FX live state, effect tails, routing and latency compensation survive enabling monitoring during playback. Verified in-browser at 140 BPM with zero chain rebuilds.
- Per-control transfer gain (fader/pan/mute/solo/routing/effects) and insert leakage are asserted against a silent graph, not during active playback: the monitored producer and the project's own instruments both enter an insert at `mixInput`, so the output tap cannot be attributed to either source while the transport plays.
- Safari/Firefox, OS exclusive-device modes and OS-specific permission UI are not acceptance-tested here.
- One route, mono/stereo, no arbitrary multichannel channel selection; no native driver integration.
- Monitoring is deliberately disabled by Stop, hardware changes, offline rendering and leaving the Mixer; it never auto-restarts.
