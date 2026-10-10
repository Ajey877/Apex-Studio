# Pre-Phase-1 Architecture Decision

**Decision: REVISE — not ready for production integration or Phase 1.** Continue only with isolated prototypes. This document records the evidence available on 2026-10-10; it is not approval to migrate production audio code or change CSP.

## Evidence boundary

Two branches are involved. PR #205 is on `arena/96cb2a8b-apex-studio`, head `ed0a79217cb455d87704b1c6ff02ee68687b81a5`. Its latest checks, run [#38055574687](https://github.com/Ajey877/Apex-Studio/actions/runs/38055574687), and the three accompanying `verify`, `audio-tests`, and `windows-package` workflows passed on that exact PR head. The Audio Spike run tested the existing shared-engine/bank Electron prototype in both packaging modes. It did **not** test the separate Worker prototype added on `arena/724da208-apex-studio` (implementation commit `0c60829`; report refresh `c008e70`).

At drafting, the fixed session branch was at `c008e70`; the Worker implementation is `0c60829` and `c008e70` only refreshed `REPORT.md`. Local Worker/browser results in `REPORT.md` §13 refer to that implementation snapshot, not to PR #205. Local results and historical hosted-run measurements below are evidence for those specific snapshots and configurations only. Green checks are not a readiness decision.

## Architecture assessment

### Live audio: shared engine is promising; bank topology is not proven

- A single ABI-v2 engine/memory with multiple slots avoids the per-node allocation ceiling observed at roughly 123–125 WASM memories. The existing prototype passed slot-isolation, individual-output parity, and slot-release checks. Engine/bank layouts initialized up to 512 logical units with one memory in the tested CI configurations.
- The 16-unit bank rendered through a real AudioWorklet. Its Float32 average differed from the single-stream reference by `1.1920928955078125e-7` (one Float32 ULP), within the test's `1e-6` tolerance, but **not bit-exact**. One-unit bank and individual slot cases remain exact.
- Electron 43.4.1 CI exercised the existing shared-engine/bank prototype unpackaged and asar-packaged. In run #38055574687, both layouts rendered 100% at 512 units in Electron; an earlier run recorded 95–96% rendering and 775–1,016 underruns for engine-nodes. In the latest Windows browser run, engine-nodes rendered 83% in Chrome and 72% in Edge, with 1,412 and 1,327 underruns; the bank rendered 100% with no underruns, but had three over-budget blocks. These differences across runs/platforms show variability, not a laptop guarantee.
- **Important scope limit:** the bank comparison feeds the same test signal to each logical unit. It does not prove correct independent track routing, real project mixing, effects ordering, automation, or a complete DSP graph.

**Conclusion:** Prefer one shared engine per audio thread over one WASM memory per node as the next live prototype. Keep a bank/graph node as the performance candidate, but validate distinct track inputs, routing, control changes, error recovery, and target load before selecting it for production.

### Offline export: retention is confirmed; Worker is only a kernel prototype

Repeated WASM-backed `OfflineAudioContext` worklet renders retain their memories until renderer/document teardown. The local Chromium test completed 7 per-node or 124 shared-engine/bank renders; then the main-thread probe could create 0 memories until reload. Electron CI also reproduced retention in both modes: per-node 7, then 123–124 shared-engine/bank renders before exhaustion. Reusing a shared engine **inside each new OfflineAudioContext does not solve this lifecycle failure**.

The serial Worker prototype instead creates one ABI-v2 engine with one fixed 131,072-byte memory and reuses it for 200 stereo PCM jobs of 4,800 frames. Node and Chromium tests report 200/200 bit-exact outputs, one engine, and unchanged memory size. It creates **zero** OfflineAudioContexts. This establishes a kernel reuse and message-transport candidate; it is **not** a complete export implementation. It does not schedule a project graph, render or route stems, preserve instrument/effect/automation semantics, implement cancellation/back-pressure, or integrate with the application's exporter. It therefore does not yet demonstrate that real repeated exports avoid retention.

**Next isolated prototype:** run a representative project fixture through a long-lived Worker export path with production-equivalent stage order and distinct stems/parameters. Reuse one engine across serial jobs; measure memory and output after each full export. Do not use WASM-backed worklets per offline export until that path passes the gate below. Shared imported memory is a separate, untested option and would add cross-origin-isolation/security requirements.

### Electron security: current strict policy blocks WASM; integration remains unverified

The latest packaged production-app probe loaded `app.asar/dist/index.html` and observed the current strict CSP block inline script and WebAssembly compile/module/instantiate. The spike replica's Electron `onHeadersReceived` hook handled 9/9 `file://` responses in unpackaged and asar runs; `production` blocked main-thread/worklet WASM, while the test-only `production-wasm` policy allowed both. This behavior conflicts with Electron's documentation about header CSP on `file://` and merits an owner/security review.

What remains unverified is the **actual production application's** loading and security behavior for a proposed AudioWorklet or dedicated Worker module, including the approved policy needed to permit WASM there. The production app currently has no such DSP module; the local Worker integration was not run in Electron. `production-wasm` results are from the spike harness, not approval or proof for the production application. **No CSP change is made or recommended by this decision.** Any change requires a separate security decision and tests against the actual packaged and unpackaged application.

### Performance: hosted observations are not device evidence

The 512-unit Chrome/Edge and Electron results above come from hosted CI and vary between runs. Local sustained 16-unit tests used fake/software audio output; the Worker test checked numerical correctness, not end-to-end export throughput. No representative Windows laptop, physical audio device, or production WaveOut (`force-wave-audio`) benchmark has been run. Thus neither the bank's apparent CI advantage nor the clean latest Electron run proves glitch-free production performance.

## What is supported, and what is unknown

**Supported by evidence:** per-node WASM allocation fails at ordinary high counts; sharing one engine removes that allocation bottleneck in the tested configurations; the existing shared-engine/bank tests pass in unpackaged and packaged Electron; offline worklet-memory retention is reproducible; a dedicated Worker can reuse one fixed engine for simple serial PCM jobs with exact kernel output.

**Unknown / unresolved:** realistic bank routing and sample-accurate controls; complete offline graph/export semantics; repeated full-export memory behavior; project save/load round-trip behavior under the new path; live/offline equivalence for a real project; Worker lifecycle, cancellation, error recovery and throughput in Electron; production-app Worklet/Worker CSP behavior; performance on a representative device; and production WASM toolchain/security approval.

## Acceptance gate before any production integration

All results must be attached to the **exact commit under evaluation**. Run the suite in Linux Chromium and in Electron 43.4.1 both unpackaged and asar-packaged; record browser/runtime versions, memory counts, output metrics, and failures. Do not infer these results from PR #205 checks if the Worker or bank changes are absent from that commit.

| Area | Measurable acceptance criteria |
|---|---|
| **Live engine and bank correctness** | Use at least 16 distinct deterministic track inputs with independent parameters/state, plus 128- and 512-unit stress cases. Assert one engine memory per audio thread, unique slot ownership, no cross-slot leakage, all slots released on dispose, finite output, and reference parity (kernel exact where expected; mixed bank `maxAbsDiff <= 1e-6` or a reviewed effect-specific tolerance). Test routing/mixing and automation—not repeated copies of one input only. |
| **Repeated full offline exports** | In one renderer/process without reload, complete **200 sequential full exports** of a documented multitrack fixture. Zero failed/truncated exports and zero WASM allocation failures. A long-lived Worker must retain exactly one 131,072-byte engine memory for the batch (or another predeclared fixed bound), with no per-export memory/Worker growth. Compare each output to a saved reference; prove a canceled/failed export is followed by a successful export and leaves no stale job or memory. |
| **Save/load** | Perform **10 save-close-reopen-render cycles** on a fixture containing clips/notes, routing, effect state, and automation. Canonical project state must match after every reload; no missing/duplicated events or altered parameter values. Rendered PCM must have equal frame count, no non-finite samples, and `maxAbsDiff <= 1e-6` against the same-runtime pre-save baseline (or a documented reviewed tolerance). |
| **Live/offline consistency** | Render the same project, sample rate, routing, parameters, and automation in live and offline paths in **three repeat runs**. After a documented latency alignment, require equal output length, no discontinuities/non-finite samples, and `maxAbsDiff <= 1e-6` for the deterministic fixture; any DSP needing a looser tolerance must be justified and approved before integration. |
| **Electron packaged/unpackaged and CSP** | In both modes, run the full live, export, save/load, cancellation and recovery suite. Assert current strict production CSP behavior explicitly (WASM blocked and reported without renderer crash). Test any proposed WASM-allowing policy only in a security-approved experiment, then re-test the **actual production app** in both modes; do not treat the spike replica's `production-wasm` result as sufficient. Verify module loading from `file://` and `app.asar`, and verify Worker/Worklet termination and bounded memory. |
| **Representative Windows laptop** | Before the run, identify the laptop, Windows/Electron versions, physical output device/backend, and a supported target load `N_target` from a representative project. At 48 kHz / 128-frame quantum, run **30 minutes at `N_target`** and **10 minutes at 1.5× stress**, repeat the target run three times, and capture loopback audio plus available underrun/xrun counters. At target: zero audible gaps, device underruns, frame discontinuities, or renderer/Worker crashes; p99 DSP time below 50% of the 2.667 ms quantum and no block at/over one quantum. At stress: no crash or unbounded memory growth; record and review any underrun/degradation. |

## Next-phase gate

**Do not integrate this architecture into production and do not start Phase 1.** The next step is one more isolated prototype: complete the Worker export fixture and independent-input bank/routing fixture, then run the acceptance suite above. Revisit the decision only when those results are on the exact candidate commit, the actual Electron security path is approved and tested, and the representative laptop gate passes. **Recommendation remains REVISE.**