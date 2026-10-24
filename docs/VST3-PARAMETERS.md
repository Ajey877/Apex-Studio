# Editing native VST3 instrument parameters

## User workflow

1. In the **Windows x64 desktop application**, open Instruments and select a channel. Load/relink a trusted, supported VST3 instrument using the existing folder scan. Browsers retain native plugin data but cannot host, edit or export native instruments.
2. Expand **VST3 instruments — desktop only**. **Native instrument parameters** loads genuine controller metadata. If the instrument lacks a controller, metadata fails, or a current value is unavailable, the panel says so rather than inventing controls/values.
3. Search by name, short title, units or ID. The editor shows at most **32 rows per page**. Hidden parameters are omitted. Read-only parameters are text, not sliders. Program-change parameters are not editable here because they can reset multiple parameters and require a separate initialization/preset transaction.
4. Adjust a slider (keyboard-accessible) or a discrete selector. Selectors use actual labels supplied by the controller, never fabricated names. Numbers beside controls are **normalized 0–1 values**, not implied physical ranges; any plugin units are separately identified as metadata.
5. Edits are explicitly **draft-only** until **Apply parameter changes**. One Apply sends the staged batch to the real native processor and records one **Edit VST3 parameters** history action. Several slider movements do not flood Undo with entries. Discard leaves audio/project unchanged.
6. Apply can change a currently held note without reopening its native instance when the plugin supports the parameter/process contract. Existing queued audio is not retroactively rewritten: allow roughly 50 ms plus a 1024-frame block and device latency. A busy/slow/crashing plugin can fail or underrun; the error is visible, not silent success.
7. Save normally. Reopen/relink restores the original component/controller streams, then the explicitly edited normalized overrides. Other plugin defaults are not blindly serialized. Class ID is preserved exactly.
8. Project Undo/Redo restores the previous/new saved sound. As with other native instrument configuration replacement, it clears held notes; Play/audition the restored configuration again. It is not seamless audio-history scrubbing. Undo history is session-local; committed settings persist across application restart.

Switching channels/projects, replacing/relinking/resetting the instrument, stopping native playback, cancelling a pending edit, or closing the panel fences late acknowledgements. A failed/stale edit never publishes its draft; its native instance is closed and can be retried from the saved state. A cancellation cannot erase already-heard queued audio. If a parameter is rejected or the editor was cancelled, close/reopen or Retry saved instrument before another attempt.

Only install plugins you trust: process isolation contains crashes but is **not a security sandbox**. Native code has your OS user privileges.

## Delivered scope

This adds a generic parameter editor, not native plugin GUI windows. No universal VST3 compatibility, complete parameter automation lanes, plugin delay compensation, physical output-latency improvements, or physical-device testing is claimed. Existing zero-reported-latency, mono/stereo, x64 instrument-only restrictions remain. Plugins requiring unsupported restart/reinitialization behavior may reject editing. No AI functionality, effects-rack expansion or new runtime dependency is included.

## Implementation and validation map

- Native `host.cpp`: bounded/unique genuine controller metadata and real choices; whole-batch validation; controller + processor queues; idle zero-frame flush retained for subsequent audio; existing snapshots/restoration.
- `parameters.mjs`, service/client, desktop main/preload and TypeScript contract: metadata forwarding, authorized narrow operations, normalized validation, process/update exclusion, cancellation/timeout/failure cleanup. The new service module is included in the desktop package.
- `nativeVst3Runtime.ts` / `audioEngine.ts`: serialize against the producer, carry live changes in a real scheduled audio block, retain the running instance/key on acknowledged edits, discard stale/failing transactions.
- `Vst3ParameterEditor.tsx`, existing panel/rack and App: accessible filtered/paged draft controls and guarded immutable publication through the existing history mutation route. Only explicit overrides are added, with component/controller streams retained.
- `nativeVst3Parameters.test.ts`: metadata negative contracts, read-only/hidden/program validation, boundaries, immutable/history/persistence and legacy state behavior. Included automatically by `test:audio`.
- Existing `nativeVst3.test.mjs` / `vst3DawIntegration.test.mjs` / `vst3Ui.test.mjs`: genuine MDA metadata/queues/snapshot/reopen; unknown/malformed/duplicate/oversized values; real service ownership/concurrency; faults, stale cancellation, retry and package wiring; actual live/export/history sound.
- `native-browser-tests/vst3Parameters.spec.ts`: actual App controls → real service/MDA → actual history/IndexedDB/undo/redo/reload and production song export. Negative readonly/hidden/missing/error metadata cases are explicit **contract fixtures**, not claimed real-plugin audio proof. A late real native acknowledgement after changing channel is discarded. The desktop smoke algorithm is also tested through this test-only transport, not confused with packaged Electron IPC.
- Actual packaged Windows smoke uses real preload/main IPC and two separate application processes; it saves an edited parameter, checks native restored value and edited PCM, and verifies the same export/state after restart.

### Measured local PCM evidence

Actual pinned MIT Steinberg SDK **mda JX10**, class `5653544D44416A6D6461206A78313000`, **VCF Freq (ID 6)** from controller metadata: reference **0.8999999761581421**, edited **0.05**, **48,000 Hz**. No fake oscillator/processor supplies positive evidence.

| Comparison | Measurement |
|---|---:|
| Live held-note reference RMS, frames [24,000, 44,000) | 0.12046029084986844 |
| Same region, edited RMS | 0.003909849660044013 |
| Live edited/reference difference RMS | **0.12288343011151114** |
| Live unchanged-value negative-control difference RMS | **0** |
| Production song export difference RMS, frames [0, 192,000) | **0.0977642103588447** |
| Export Undo / Redo / serialized reload difference from respective references | **0 / 0 / 0** |
| Replayed live Undo/reference difference; live Redo/reload difference | **0 / 0** |

The live test uses production AudioClockTransport, registry, native service, channel/mixer/master and real Web Audio DSP destination, with a deterministic RenderingAudioContext clock (not physical speakers). The export test uses `renderTimelineOffline`, and an independently opened native client/reference MIDI sequence agrees within 1e-6 RMS on frames [98,000, 150,000). Held-voice updates retain the same running service instance. Undo/reload checks use the normal project serializer/history and re-audition the restored state, not invented control text.

The actual Chromium App/IndexedDB test measures a production export RMS change **0.20511906039155664 → 0.017258156221965103** at 48,000 Hz; diagnostic hashes **3762177780 → 3038522905**. One Undo restores the original export exactly after several staged slider movements, Redo restores the edit exactly, and page reload restores its control value and export exactly. Hashes are diagnostics, not cross-platform guarantees; tests compare each run dynamically rather than hard-coding hashes.

### Commands / discovery

Build first: `npm run native:vst3:build`. In the sandbox CMake/Ninja were installed as user tools and invoked with `PATH=/home/user/.local/bin:$PATH CMAKE=/home/user/.local/bin/cmake`; no repository dependency was added. Required gates:

```
npm run test:native-vst3
npm run test:vst3-daw
npm run test:vst3-browser
npm run test:audio
npm run test:history
npm run test:browser:node
npm run test:desktop-permissions
npm run verify:desktop
npm run verify:test-discovery
npm run lint
npm run build
npx playwright test --workers=1
```

Native/browser tests fail rather than skip when the helper/fixture is missing. The new native browser gate is in the existing Linux/Windows native workflow. Standard web CI still runs its normal browser suite; no existing test/retry policy is weakened. See the PR/Issue #285 for exact final-head CI links, final gate results and any initial failures/rechecks. Generated native binaries/audio/reports remain under ignored build directories.

Base: `4d2120511491bbf26f7236d2be2a817f89292bd7`. Approved branch: `arena/a17efba0-apex-studio`. Stable `v1.2.2` remains at `88d5889331be89a29b775e6773885b6531c7e802`.
