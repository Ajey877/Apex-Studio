# Pre-Phase 1 spike report — shared AudioWorklet + WebAssembly DSP

**Status (bounded follow-ups, 2026-10-10):** the spike remains stopped before Phase 1;
**Recommendation: REVISE** (§10, §14). The follow-ups add the serial offline Worker
and a synthetic four-track live/offline project prototype. All changes remain under
`experiments/audioworklet-wasm-spike/`; production audio, CSP and CI workflows are
unchanged.

* On implementation commit `1e725c009eb73f561eca44815d2d4fc07045fe07`,
  `npm run check:wasm`, `npm run test:node` (**36/36**), syntax checks and all five
  targeted bundled-Chromium project tests pass. The Worker completed 200 full
  4.25-second fixture exports with one fixed 131,072-byte WASM memory (§14).
* The four-track/two-bus live Worklet output, Worker float output, stems and buses
  match the scalar reference within `1e-6`; live/offline master outputs were also
  directly compared. A live fader update affected only its addressed track. This
  remains a synthetic graph, not the production Apex project/export path (§14).
* Stable Chrome and Edge test bodies are **NOT RUN** (all five launches per browser
  stopped because their binaries are absent). Unpackaged/packaged Electron is
  **NOT RUN** (binary acquisition failed and no packaged app is staged). Physical
  Windows hardware is **NOT RUN**. No result is inferred from PR #205.
* PR #205 remains on `arena/96cb2a8b-apex-studio`, head
  `ed0a79217cb455d87704b1c6ff02ee68687b81a5`; its run #38055574687 covers the
  earlier shared-engine/bank prototype, not this four-track Worker/Worklet code.

**Untested:** actual Apex project serialization and production instrument/effect
semantics, save/load, actual-app CSP, Chrome/Edge on Windows, Worker/Worklet in both
Electron packaging modes, and representative physical Windows-laptop audio.
These remain **NOT RUN**. Detailed scope and decision gates are in §14.

Date: 2026-10-10 · Tested implementation commit: `1e725c009eb73f561eca44815d2d4fc07045fe07` · PR #205 inspected head: `ed0a79217cb455d87704b1c6ff02ee68687b81a5` · session branch: `arena/724da208-apex-studio`

---

## 1. Baseline verified

| Item | Value |
|---|---|
| `origin/main` at start (after `git fetch`) | `9dc4b5f247a1f14f0cff244f6677c8d44b65ca72` — merge of PR #204 (Phase 1M) |
| Spike branch base | same commit (`git rev-parse HEAD origin/main` identical) |
| Open PRs at start | none (PRs #185–#204 all merged) |
| Production files changed by the spike | **none** — the diff against `main` is confined to `experiments/audioworklet-wasm-spike/` |

### Current production architecture (verified by reading the code)

* **Live scheduling:** `src/audio/transport.ts` `AudioClockTransport` uses a classic
  look-ahead scheduler: a main-thread `setTimeout` every 25 ms schedules steps up to
  100 ms ahead against `AudioContext.currentTime`.
* **Generation and processing:** everything is native Web Audio nodes created on the
  main thread. Instruments (`src/audio/instruments/*`) build per-note Oscillator,
  BufferSource, Gain and BiquadFilter graphs. Effects (`src/audio/effects/*`, `audioEngine.ts`)
  use BiquadFilter, WaveShaper, DynamicsCompressor and Convolver nodes. Mastering
  (`masteringProcessor.ts`) is native nodes. Metering pulls from `AnalyserNode` on a
  20 ms `setInterval` (`audioEngine.ts` around line 5304).
* **Offline rendering:** `audioEngine.renderTimelineOffline` rebuilds the same native
  graph inside an `OfflineAudioContext`. "Parity" is graph parity: the same node
  types in both contexts. There is no shared custom DSP code.
* **AudioWorklet / WebAssembly:** **not used anywhere** in production or in tests.
  `src/components/DesktopAppModal.tsx:555` says so in the UI ("No AudioWorklet
  processor is used by the engine today"). `audioWorklet: true` in `electron.cjs`
  webPreferences is not an Electron option and has no effect.
* **Electron:** `electron.cjs` uses `app.enableSandbox()`, `contextIsolation`,
  `sandbox: true`, and the switches `enable-exclusive-audio`, `disable-renderer-backgrounding`
  and `force-wave-audio` (forces the legacy WaveOut API on Windows). It loads
  `file://…/dist/index.html` when packaged and sets a CSP via
  `session.webRequest.onHeadersReceived` whose `script-src` is `'self'` only.
* **Web build:** Vite → GitHub Pages, with no CSP header or meta tag.
* **Reusable test infrastructure:** `node:test` via `tsx`; Playwright 1.63
  (`browser-tests/`, Chromium only, Linux CI); Electron 43.4.1 packaged smoke test on
  `windows-latest` (`desktop-validation.yml`).

### What a shared DSP architecture would change, and what it should leave alone

It would move **per-sample DSP** (filters, dynamics, synthesis, metering maths)
into WASM, executed by AudioWorklet processors in both `AudioContext` and
`OfflineAudioContext`, so live and export use literally the same code.
It should leave **outside the audio thread**: the transport and scheduler policy,
project state, UI, parameter mapping and coefficient design (or at least their
validation), file I/O and decoding, error reporting, and lifecycle and recovery.

---

## 2. Files changed

All new files are under `experiments/audioworklet-wasm-spike/`.

`README.md`, `REPORT.md`, `package.json`, `package-lock.json`, `.gitignore`,
`dsp/gain_biquad.wat`, `dsp/gain_biquad.wasm`,
`web/{gain-filter-processor.js, host.mjs, reference.mjs, harness.mjs, golden.mjs, wasm-bytes.mjs, index.html, ui.mjs}`,
`server/{serve.mjs, csp.mjs}`, `scripts/{build-wasm.mjs, make-golden.mjs, summarize-results.mjs}`,
`tests/node/{wasm, processor-mocked-scope, isolation}.test.mjs`,
`tests/browser/{playwright.config.mjs, spike.spec.mjs}`,
`electron/{main.cjs, run-electron.mjs, stage-electron-app.mjs}`,
`ci/audio-spike.yml` (parked workflow; since moved by the owner to `.github/workflows/audio-spike.yml`, see §5).

Added in the follow-up investigation (all under the same directory):
`dsp/gain_biquad_engine.{wat,wasm}` (single-engine kernel, ABI v2, 1024 slots),
`web/{engine-processor.js, investigation.mjs, repro.mjs, wasm-engine-bytes.mjs, wasm-probe-worker.js}`,
`tests/node/{engine, investigation}.test.mjs`, `tests/browser/investigation.spec.mjs`.
Modified: `scripts/build-wasm.mjs` builds both kernels (v1 output byte-identical),
`scripts/summarize-results.mjs`, `server/{csp.mjs, serve.mjs}` (investigation-only CSP
variants; `PRODUCTION_CSP` unchanged and still checked against `electron.cjs`),
`web/host.mjs` (optional `processorName` / `processorOptions`; defaults unchanged),
`web/reference.mjs` (`engineProcessDirect`). The workflow itself was moved by the owner
to `.github/workflows/audio-spike.yml` (`7d2600c`, `f122952`) and is **not** modified
by this follow-up. Its existing Playwright steps pick up `investigation.spec.mjs`
automatically, because the config matches `*.spec.mjs`.

Bounded follow-up additions: `web/{offline-engine-core.mjs, offline-engine-worker.js}`
(one prototype Worker/serial PCM core), `tests/node/offline-engine-core.test.mjs`,
and a 200-job Worker regression plus multi-unit bank precision checks in
`tests/browser/investigation.spec.mjs`. The same follow-up modifies
`web/investigation.mjs` and the spike-only `electron/{main.cjs, run-electron.mjs}`
to gather shared-engine/bank and Worker results when Electron is available. These
changes remain inside the experiment directory.

No changes to `src/`, `package.json`, `package-lock.json`, `electron.cjs`,
`vite.config.ts`, `tsconfig.json`, `index.html` or the existing workflows.
Note: because the root `tsconfig.json` has no `include` and `allowJs: true`,
`tsc --noEmit` lists the spike's JS files. With `checkJs` off they are not
type-checked, and `npm run lint` still passes.

---

## 3. Prototype architecture

```
main thread (host.mjs)                          audio thread (AudioWorkletGlobalScope)
detectSupport() ─► addModule(processor.js) ───► registerProcessor('apex-spike-gain-filter')
new AudioWorkletNode({processorOptions:{wasmBytes, params}})
                                                constructor: new WebAssembly.Module(bytes)  [681 B, sync]
                                                             new WebAssembly.Instance(module, {})
            ◄── 'ready' | 'init-error' ───────  configure() → reset()
source ─► AudioWorkletNode ─► destination       process(): per channel copy in → exports.process(ch,128) → copy out
            ◄── 'processorerror' ─────────────  (throw inside process) → host disconnects node, notifies
'dispose' ────────────────────────────────────► process() returns false → node collectable
```

* **Kernel:** gain → RBJ low-pass biquad (transposed direct form II), f64 state,
  f32 I/O, explicit denormal flush below 1e-30 (WebAssembly has no FTZ/DAZ mode).
  Fixed linear memory (one 64 KiB page, never grows), no imports, ABI v1, error codes.
* **Toolchain:** hand-written WAT assembled by `wabt` 1.0.39 (npm, Apache-2.0,
  dev-only). The build is byte-reproducible and verified by `npm run check:wasm`.
  The binary is also embedded as base64, so loading never depends on `fetch()` of
  `file://` URLs.
* **Reference:** an independent JS float64 implementation in the same operation
  order. The golden SHA-256 is computed from the **JS reference**, not from WASM.
  The test signal (LCG noise, saw, square, impulses, silence) avoids `Math.sin`, so
  it is identical in every JS engine.
* **Instrumentation:** per-block processing time (worst, mean, over-budget count),
  `currentFrame` continuity, render-lag dropout detector (wall time minus rendered
  time > 50 ms counts as one event, then the reference re-bases), non-finite output,
  and Chromium's `AudioContext.playbackStats` underrun counter when exposed.
* **Failure handling:** `createGainFilter()` never throws. It reports `unsupported`,
  `worklet-module-load`, `node-construct`, `wasm-init` or `timeout`, and tears down
  any half-built node.
* **Cleanup:** `dispose()` is idempotent and verified quiescent (no further blocks),
  then `disconnect()` and `port.close()`. Tests also `close()` their contexts.

---

## 4. Commands

```bash
# repo root
npm install --legacy-peer-deps
# spike
cd experiments/audioworklet-wasm-spike
npm ci && npm run check:wasm && npm run test:node
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chromium   # or chrome / msedge; runs spike.spec.mjs + investigation.spec.mjs
#   investigation knobs: SPIKE_COMPARE_SECONDS=15  SPIKE_COMPARE_COUNTS=16,64,128,256,512
node electron/run-electron.mjs                     # Electron unpackaged (not runnable in this sandbox; ran in Windows CI)
node electron/stage-electron-app.mjs && node ../../node_modules/electron-builder/cli.js --win --x64 --dir --publish never --projectDir results/electron-app && node electron/run-electron.mjs --packaged   # (not runnable in this sandbox; ran in Windows CI)
```

Production regression commands rerun against this worktree (repo root): `npm run verify:desktop`,
`npm run lint`, `npm run test:audio`, `npm run test:history`, and `npm run build` — all PASS.
The root `npm run test:browser:playwright` was attempted but its 11 cases did not execute:
the sandbox lacks the Playwright Chromium headless-shell binary (§6c).

---

## 5. Platforms and versions

| Platform | Status | Details |
|---|---|---|
| Node.js, earlier follow-up suite | **RAN locally — 26 passed, 0 skipped** | Node v22.22.3, Linux x86-64; historical run before the bounded offline Worker tests |
| Node.js, bounded follow-up (current workspace) | **RAN locally — 28 passed, 0 failed** | `npm run test:node`; includes 200 serial core jobs and malformed-job rejection; not a Worker/browser/Electron integration result |
| Chromium, headless Linux sandbox (earlier follow-up) | **RAN locally — 50 passed** (11 original + 39 investigation); plus two repeats of the 15-cell design comparison (30 tests) | Chromium 153.0.8010.0 / Playwright 1.63.0, 2 vCPU / 3 GB VM, software/fake audio output; historical run, not the bounded offline Worker follow-up |
| Chromium, targeted bounded follow-up | **RAN locally — 5 passed** | Chromium 153.0.8010.0 / Playwright 1.63.0; Worker 200-job parity, engine/bank parity, offline retention, per-node x128 and x256. Full browser suite is **NOT RUN** for these edits. |
| Linux bundled Chromium, run #38051848530 | **RAN — job SUCCESS** | Includes the original 11-case project plus `investigation.spec.mjs`; check-run annotations expose probe, lifecycle, design-comparison and CSP results (§12.6) |
| **Google Chrome stable — Windows**, headed | **RAN — 50 tests passed in run #38051848530** | Chrome 154.0.8037.58, Windows x64. Original 11 tests + 39 investigation tests; 15 s compare at 16/64/128/256/512 units across per-node, engine-nodes and engine-bank layouts. Per-node 128/256 allocation failure reproduced (§12.6). |
| **Microsoft Edge stable — Windows**, headed | **RAN — 50 tests passed in run #38051848530** | Edge 153.0.4234.48, Windows x64. Same test matrix and defaults; per-node 128/256 allocation failure reproduced (§12.6). |
| **Electron 43.4.1 — Windows, unpackaged spike app** | **RAN — SUCCESS** in run #38055574687 on PR head `ed0a79217cb455d87704b1c6ff02ee68687b81a5` | Shared-engine/bank parity, 128/512 comparisons, offline-retention probes, and CSP modes ran. At 512 units, engine-nodes and engine-bank both rendered 100% with 0 underruns in this run (earlier run #380547 had engine-nodes at 96% / 1,016 underruns). Offline retention: per-node 7, engine-nodes/bank 124; after exhaustion 0, after reload 124. |
| **Electron 43.4.1 — Windows, packaged asar spike app** | **RAN — SUCCESS** in run #38055574687 on PR head `ed0a79217cb455d87704b1c6ff02ee68687b81a5` | Shared-engine/bank parity, 128/512 comparisons, offline-retention probes, and CSP modes ran. At 512 units, engine-nodes and engine-bank both rendered 100% with 0 underruns in this run (earlier run #380547 had engine-nodes at 95% / 775 underruns). Offline retention: per-node 7, engine-nodes/bank 123; after exhaustion 0, after reload 123. |
| **Packaged production-app CSP probe** | **RAN — SUCCESS** in runs #38054717669 and #38055574687 | The Windows probe loaded `app.asar/dist/index.html`; strict production CSP blocked inline script and WASM compile/module/instantiate. The newer run reported `memoryCap: 123`. This was a packaged production build probe, not the Worker prototype. |
| **Electron — new local Worker integration** | **NOT RUN** | The local `offlineWorkerPrototype` and new 16-unit bank precision assertion were not in PR CI. Local Electron was unavailable; no new Electron launch occurred. |
| Representative mid-range Windows laptop / physical device | **NOT RUN** | CI measurements are not a hardware baseline. Instructions in README “Local benchmark”. |
| PR #205 current checks, head `ed0a79217cb455d87704b1c6ff02ee68687b81a5` | **ALL PASS** | Run #38055574687: `verify`, `audio-tests`, `windows-package`, Audio Spike Linux Chromium, Windows Chrome/Edge, and Windows Electron all succeeded. It validates the PR head, including existing engine/bank Electron tests; it does **not** include the local offline Worker / 16-unit bank precision edits on the separate session branch. |

### Run history and scope

Run #38051170797 was on `f122952e78968c0c874ddaa92daa8b00d910ec04` and ran the original
suite. The follow-up commit `b86d47db0995ee655339e5d6cf927ef60420fea2` added
`investigation.spec.mjs`; run #38051848530 completed successfully on that head.
Each Windows browser project ran the 11 original cases plus 39 investigation cases:
8 main-thread memory probes, a V8 flag/GC probe, lifecycle/reclaim and cross-isolate
cases, 1000-cycle churn for three layouts, offline-render retention, real-Worklet
engine parity, 15 design/load comparisons (3 layouts × 5 counts, 15 s each), and 7
CSP-policy cases. This specifically includes sustained comparison attempts at 128
and 256 logical units; the per-node layout fails during initialization at 124–125
WASM memories before those live intervals start.

Electron run #38053541244 emitted compact annotations for the spike harness in both
packaging modes: the `file://` hook handled 9/9 responses, `production` blocked WASM,
and `production-wasm` allowed it. Runs #38054717669 (`243ae`) and #38055574687
(current head `ed0a792`) also tested the existing shared-engine/bank layout, engine
parity, 128/512-unit comparisons, and OfflineAudioContext retention in unpackaged
and packaged modes; each included a packaged production-app CSP probe that blocked
WASM. The latest current-head run #38055574687 validates PR code only, not the local
Worker prototype or local 16-unit bank tolerance assertion on this separate session
branch.

### Logs, annotations and artifacts

The GitHub API exposed the browser check-run `::notice` annotations, so the Windows
versions and measurements below are available even though the full logs and artifact
ZIPs redirected to `*.blob.core.windows.net` and could not be downloaded from this
workspace. The earlier Electron run #38051848530 emitted no runtime result annotation;
the later Electron run #38053541244 did, so its `114217319452` annotations are the
source for the values in §13. Run #38051848530 uploaded:

| Artifact | Size | SHA-256 |
|---|---:|---|
| `spike-results-windows-browsers` | 246,047 bytes | `3861332a8485c504143fdbd2bf923dd6dd570ecdfd837829954320f9d8af8d99` |
| `spike-results-linux` | 213,549 bytes | `8e681655165e26c7c668e57bf948c3abd2882bf70bcdbdbdfa5758039fca509e` |
| `spike-results-windows-electron` | 17,441 bytes | `95c5d738f646c4b3fe5695034a71504162658847b67cef21faddc4c31866d553` |

The browser annotations are **measurements from hosted CI runners**, not proof of
physical-device performance. Electron's previous spike-only `file://` CSP result is
now **VERIFIED in CI annotations** (run #38053541244); that result is not a test of
the production executable or of the bounded follow-up's new engine/Worker integration.

---

## 6. Test results (local Chromium 153 unless stated)

### 6a. Numerical parity (says nothing about real time)

| Test | Result | Measured |
|---|---|---|
| WASM in Node vs JS reference | PASS | max \|diff\| **0** both channels; 0/96 000 samples differ; SHA-256 = golden |
| WASM on browser main thread vs reference | PASS | max \|diff\| **0**; SHA-256 = golden |
| WASM **inside AudioWorklet**, rendered by `OfflineAudioContext` | PASS | max \|diff\| **0**; SHA-256 = golden `ef56f2bf…5eb1` |
| Block-size independence (37 / 128 / 4096 frames) | PASS | identical hashes |
| Committed `.wasm` reproducible from `.wat` | PASS (Linux locally; Linux and Windows CI step passed, 2 runs) | 681 B, sha256 `3ce00d84…7f8f` |
| *Follow-up:* single-engine kernel, slots 0 and 1023, in Node | PASS | max \|diff\| **0**; SHA-256 = golden; 64 interleaved slots with different parameters each match their own reference exactly |
| *Follow-up:* 3 engine units sharing one engine **inside AudioWorklet** (`OfflineAudioContext`) | PASS | units 0 and 2 = golden; unit 1 (different params) max \|diff\| 0; one-unit bank = golden; engine `.wasm` 815 B, sha256 `207b12bc…e20b`, reproducible |
| *Bounded follow-up:* 200 serial jobs in a real module Worker | PASS | 200/200 jobs bit-exact, max \|diff\| 0; one engine and fixed 131,072-byte memory throughout; kernel-only PCM path |
| *Bounded follow-up:* 16-unit engine bank vs the one-stream reference | PASS within tolerance | max \|diff\| `1.1920928955078125e-7`, 0 non-finite samples; not bit-exact because Float32 averaging accumulates rounding. One-unit bank remains golden/bit-exact. |

Tolerance for multi-unit comparisons: max \|diff\| ≤ **1e-6** (about −120 dBFS).
Single-unit engine and one-unit bank results were bit-exact; the 16-unit bank's
observed one-ULP rounding difference is not bit-exact and must not be represented as such.

### 6b. Live playback (real-time `AudioContext`, fake audio output device)

| Check | Result |
|---|---|
| Context running; processor ready (WASM instantiated on the audio thread) | PASS |
| ≥ 90% of wall-clock blocks rendered (2 s) | PASS (752 of 750 expected) |
| Output non-silent and finite; no `currentFrame` discontinuities | PASS |
| After `dispose`: processor quiescent (block count frozen) | PASS (752 → 752) |
| Context `close()` → `closed`; creating a node on a closed context fails gracefully | PASS |

### 6c. Failure handling and isolation

| Scenario | Result |
|---|---|
| Unsupported environment (no AudioWorklet / WASM) | PASS → `{ok:false, stage:'unsupported'}` |
| Worklet module 404 | PASS → `worklet-module-load` (AbortError) |
| Corrupt WASM bytes | PASS → `wasm-init` (CompileError) |
| Non-finite parameter | PASS → `wasm-init` (kernel `configure` returned -3) |
| Exception thrown in `process()` | PASS → `processorerror` caught; node disconnected |
| Bystander oscillator **in the same context** after all failures | PASS (still advancing, peak 1.0) |
| New processor in the same context afterwards | PASS |
| Uncaught page errors / crashes | none |
| Bounded follow-up browser cases in headless Chromium 153 | PASS — 5/5 targeted tests | 200-job module Worker; engine/bank parity; offline-render retention; expected per-node x128 and x256 failures. Full spike browser suite was **NOT RUN** for these edits. |
| Root production regressions rerun against the earlier worktree (`lint`, `verify:desktop`, `test:audio` 1643/1643, `test:history` 699/699, `build`) | PASS locally (historical) |
| Root Playwright browser suite | **NOT RUN**: prior attempt was blocked before launch by missing Chromium headless-shell. The bounded spike tests used a separate sandbox Chromium; that does not validate the root browser suite. |
| Existing shared-engine/bank and offline-retention Electron tests | **RAN — PASS** in both packaging modes on current PR head `ed0a792`; the new Worker and 16-unit bank-tolerance additions remain **NOT RUN** in Electron (§13). |
| Production `dist/` contains no spike code | PASS (earlier isolation test) |

### 6d. CSP (Electron production policy, served over HTTP in Chromium)

| Policy | Main-thread WASM | Worklet WASM | Page |
|---|---|---|---|
| None (web build) | allowed | allowed | OK |
| **Exact `electron.cjs` CSP** (`script-src 'self'`) | **BLOCKED** (CompileError, `wasm-eval` violation) | **BLOCKED** | OK, reported as `wasm-init` |
| Same plus `'wasm-unsafe-eval'` | allowed | allowed (bit-exact parity) | OK; `eval` still blocked |

The full HTTP matrix (7 policies × main thread, worklet, engine worklet and
dedicated Worker) is in §12.4 and was repeated in Windows Chrome/Edge (§12.6).
Electron 43.4.1 annotations from runs #38053541244 and #38055574687 show the
spike-only `file://` header hook handled 9/9 responses: `production` blocked
main-thread/worklet WASM, and `production-wasm` allowed both. The latest run also
probed the packaged production app; strict CSP blocked inline script and WASM
compile/module/instantiate there. The Electron docs say header CSP cannot be used
for `file://`, so this observed result merits owner review and careful regression
coverage, but is no longer **NOT VERIFIED**. The Worker prototype itself remains
**NOT RUN** in Electron (§13); production CSP was not changed.

---

## 7. Performance (measurements, kept separate from correctness)

48 kHz, render quantum 128 frames = **2.667 ms budget**. Dev sandbox VM, fake audio
output: indicative only, **not** the agreed Windows-laptop baseline.

| Measurement | Result |
|---|---|
| Kernel on the audio thread (20 000 stereo blocks) | **1.1 µs per stereo block = 0.04% of budget** (~4.3 ns/sample) |
| Main thread: WASM vs JS reference | 0.98 µs vs 2.44 µs per stereo block (JS figure includes allocation) |
| Offline throughput, 16 instances, 30 s of audio | worklet 36× real time vs native Gain + Biquad 67× (graph and copy overhead) |
| Sustained live, 16 instances × 20 s | total worklet DSP **1.53% of quantum**; worst block 1 ms; **0 overruns; 0 detected dropouts** (max lag 11.3 ms); 7501/7500 blocks; browser `playbackStats.underrunEvents` **0** |
| Sustained live, 30 s sweep | 16 inst: PASS (1.6%); 64 inst: PASS (6.1%, worst block 2 ms); **128 inst: FAIL** and **256 inst: FAIL**, because instance index **#125** (the 126th) failed to initialise (§8.3), so neither load was ever reached. In the "256" run (125 live instances) there were also 3 over-budget blocks (worst 10 ms) and 0 dropouts. That was a single run on a noisy 2-vCPU VM, so it is inconclusive |

The CPU budget used by the harness: total worklet DSP ≤ 50% of the quantum at the
defined load (16 stereo instances), with 0 over-budget blocks and 0 detected dropouts.

Follow-up re-run (`spike.spec.mjs`, same machine): sustained 16 instances × 20 s =
2.0% of quantum, 0 overruns, 0 dropouts; kernel 1.15 µs per stereo block. The design
comparison at 16–512 units is in §12.3.

---

## 8. Limitations discovered

1. **Strict CSP behavior is confirmed in the packaged production build, but CSP relaxation remains an owner decision.**
   The HTTP Chromium matrix shows that `script-src 'self'` blocks WASM and adding
   `'wasm-unsafe-eval'` permits it without permitting JavaScript `eval` (§12.4,
   §12.6). Electron 43.4.1 CI annotations from runs #38053541244 and #38055574687
   show the spike's `onHeadersReceived` hook handled 9/9 `file://` responses in both
   unpackaged and asar-packaged modes: copied `production` CSP blocked main-thread
   and worklet WASM; `production-wasm` allowed both. The latest run also loaded the
   packaged production `app.asar/dist/index.html`; it recorded inline-script and WASM
   CSP violations, with compile/module/instantiate blocked. These results contradict
   Electron's documentation that header CSP cannot be used for `file://`; no policy
   change was made. The new offline Worker integration was not tested in Electron.
2. **`performance.now()` is not exposed in `AudioWorkletGlobalScope`** (Chromium 153).
   Per-block timing falls back to `Date.now()` at 1 ms resolution. Means over
   thousands of blocks are statistically sound, but single-block overrun detection
   is coarse. `AudioContext.playbackStats` provides an independent underrun counter;
   it was present in Windows Chrome 154, Edge 153, and Electron 43.4.1 CI results.
   Electron run #380547 reported 775–1,016 engine-node underruns at 512 units, while
   #380555 reported zero; the latest Windows browser run reported 1,327–1,412 for
   engine-nodes at 512. The variation is itself a warning, and all counters come
   from hosted/fake audio output, not a physical device.
3. **Initialisation failure at instance index #125: cause strongly supported by
   Linux and Windows browser execution (follow-up, §12.1, §12.6).** With one WASM
   instance per AudioWorkletNode, 128/256/512-unit attempts fail during setup at
   approximately 124–125 live memories in both Windows Chrome and Edge. The failure
   is reported cleanly as `wasm-init`; the page does not crash and already-running
   nodes continue processing.

   **Confirmed locally and reproduced in Windows Chrome/Edge CI:**

   * The limiting resource is **live `WebAssembly.Memory` objects per renderer**,
     not the number of modules, instances or AudioWorkletNodes by themselves. The
     Windows investigation confirms the same 124–125 per-node ceiling; local
     Chromium also reproduced it on the main thread with `new WebAssembly.Memory({initial: 1})`
     and no audio.
   * Locally, 1000 memory-less instances and 1000 instances importing **one** shared
     memory succeed; changing `maximum` or `shared` does not change the cap.
     Local memory64 memories cap at 61–62, about half. Physical memory is not the
     constraint in the local probe: resident memory grows about 4–5 MB for 125
     memories, and renderer virtual size stays about 1.48 TB.
   * The main thread and audio thread share the budget in the local probe. V8 flags
     reach V8; `--wasm-enforce-bounds-checks` does **not** change the cap.

   **Mechanism indicated by V8 source (not a measurement of the deployed builds):**
   V8 HEAD `a74948bb81a5` documents `GetWasmReservationSize()` reserving
   `kFullGuardSize32` = **8 GiB** per wasm32 memory (16 GiB for memory64). With the
   V8 sandbox, these reservations come from the process-wide 1 TiB desktop x64
   sandbox. The 8 GiB / 1 TiB arithmetic predicts about 128 allocations, consistent
   with Linux Chromium and Windows Chrome/Edge measurements; V8 HEAD is not
   necessarily identical to the V8 builds shipped in those browsers. In the prior
   Electron 43.4.1 CI harness (run #38053541244), the probe created 105 memories,
   then failed on the next allocation; after disposing the test nodes, its second
   round created 0. This is a probe-specific observed count, not proof of Electron's
   exact reservation size. The *new shared-engine/offline Worker follow-up* has no
   Electron allocation result (**NOT RUN**).

   **Corrections to the previous revision of this report:**

   * The `--js-flags=--no-wasm-trap-handler` experiment was **invalid**. That flag
     does not exist in this Chromium build: `strings` finds no `wasm_trap_handler`
     flag, and V8 silently ignores unknown flags. It neither confirmed nor refuted
     anything. The guard-region hypothesis was wrongly withdrawn because of it.
     The reservation mechanism is now strongly supported by the Linux and Windows
     browser counts plus V8 source, but the exact reservation was not instrumented
     in the deployed browser builds.
   * "Disposed processors do not free their slot" was an **artifact of the test**.
     `instanceCapacity` uses an `OfflineAudioContext` that is never rendered. In a
     **running realtime context**, disposed processors' memories *are* reclaimed:
     10 × 100 create/dispose and 4 × 120 near-cap churn all succeeded.
     `AudioContext.close()` releases everything. Offline contexts are different:
     see §12.2. That is a real, separate limitation.

   **Design consequence:** use a small, fixed number of WASM memories per renderer,
   with many DSP units per engine (§12.3). The engine layout does **not** address
   offline-context retention (§12.2).

4. `fetch()` of the `.wasm` file works over HTTP. Over `file://` it is NOT RUN.
   Embedding the bytes avoids the question.
5. Worklet module loading from `file://` (unpackaged Electron) and from inside
   `app.asar` (packaged spike app) worked under `csp=none`. PR run #38055574687
   exercised the existing shared-engine/bank parity, 128/512-unit comparisons, and
   OfflineAudioContext retention in both modes (§13). The `production` CSP hook was
   enforced on 9/9 file responses; the test-only `production-wasm` policy allowed
   WASM. A separate packaged production-app probe confirmed that strict CSP blocks
   inline script and WASM. The new long-lived offline Worker and 16-unit bank
   precision regression added on the session branch were **NOT RUN** in Electron.
6. Production forces `force-wave-audio` (WaveOut) on Windows. Its latency and
   dropout behaviour with AudioWorklet are unmeasured, and the Electron runner keeps
   that switch so the CI numbers reflect production.
7. CI runners have no physical audio device, so live and dropout numbers come from
   Chromium's fake output stream.

---

## 9. Licensing

| Dependency | Scope | License | Maintenance | Notes |
|---|---|---|---|---|
| `wabt` 1.0.39 (pinned) | spike devDependency only, separate lockfile | Apache-2.0 | Last stable Nov 2025, nightlies to Dec 2025; upstream WebAssembly/wabt is maintained by the WebAssembly CG | Zero runtime deps, no install scripts, no native build, runs on Linux and Windows. Not shipped; the generated `.wasm` is our own code |
| Playwright, Electron, electron-builder | already in the repo | Apache-2.0 / MIT / MIT | — | No version changes |
| `@sparticuz/chromium` 153.0.0 | **sandbox-only**, installed in `/tmp`, not in the repo | MIT (Chromium BSD-3 and others) | — | Used only to run Chromium locally |

Unresolved: the production WASM toolchain (Rust plus wasm-bindgen, Emscripten/C++,
or AssemblyScript) has not been chosen or licence-reviewed. Hand-written WAT is
fine for a proof but not for real DSP.

---

## 10. Recommendation: **REVISE**

This recommendation incorporates run #38051848530 (`b86d47`), the prior PR run
#38053541244 (`1800123`), and the bounded local follow-up in §13. **REVISE remains
appropriate; do not start Phase 1.** The current PR head and checks are tracked in §13.

**Why not PROCEED:**
* **Windows confirms the allocation risk, not a complete production design.** The
  per-node 128/256 tests fail at 124–125 memories in Windows Chrome and Edge. The
  engine layouts initialize through 512 units with one memory, but the 15-second
  comparison is not a physical-device benchmark. In latest run #380555, 512-unit
  `engine-nodes` rendered 83% in Chrome (1,412 underruns) and 72% in Edge (1,327);
  `engine-bank` rendered 100% with no underruns, though it had 3 over-budget blocks.
  Earlier runs varied substantially. These runner-specific comparisons assert
  initialization, memory use and slot release—not audio health (§12.6, §13).
* **Offline rendering retains WASM memories** in local Chromium and Windows Chrome /
  Edge. Repeated offline renders exhausted the page after 7 per-node or about 124–125
  engine-node/bank renders; after exhaustion no new WASM could be created until
  document reload (§12.2, §12.6, §13). A prototype Worker now reuses one engine for
  200 serial PCM-kernel jobs in Node and Chromium, but it creates no
  `OfflineAudioContext` and integrates no complete export graph; the retention risk
  is therefore reduced only as a candidate, not resolved.
* **Production Electron CSP is confirmed to block WASM in the tested packaged build.**
  Current CI run #38055574687 measured the spike-only replica in both packaging
  modes and also probed the packaged production app: strict CSP blocked inline
  scripts and WASM compile/module/instantiate. The Electron documentation disagrees
  with the header-hook behavior, and the `production-wasm` allowance was tested only
  in the spike replica. No production CSP setting was changed; any relaxation
  requires owner/security review, and the new Worker path was not tested under CSP
  (§13).
* Real-device latency/dropouts with the production Windows audio backend, and
  sustained audio-health performance on a representative laptop, remain **NOT RUN**.

**Why not REJECT:**
* The per-node memory-allocation ceiling now reproduces in Linux Chromium and
  Windows Chrome/Edge, and the engine-per-audio-thread prototypes avoid that live
  initialization ceiling in tested cases (one memory for 16–512 units).
* Individual shared-engine units and the one-unit bank preserve bit-exact parity
  in Node/AudioWorklet tests; Windows parity/slot-release annotations also passed.
  The new 16-unit bank average is within `1.1920928955078125e-7` of the reference,
  not bit-exact, due to Float32 accumulation (§13).
* A dedicated Worker prototype reused one fixed WASM memory across 200 serial jobs
  and passed bit-exact kernel parity in Node and Chromium. It does not render a full
  graph, exercise repeated exports, or validate Electron; shared imported memory is
  still untested. This is useful evidence for a candidate, not a validated solution.

**Revisions required before Phase 1 can rely on this architecture:**
1. **Live:** continue with a small number of worklet nodes (e.g. a bank/graph inside
   an engine), then measure audio health on target hardware. Do not use one
   AudioWorkletNode per DSP unit at large counts based on current results.
2. **Offline:** extend the passing kernel-only Worker prototype into a real export
   path (PCM transfer, graph/stem semantics, cancellation/error cleanup, and resource
   ownership). Then run 200+ repeated full exports and verify memory retention stays
   bounded in Chromium, Chrome/Edge, and both Electron packaging modes. Shared
   imported memory is a separate untested candidate. Until that evidence exists,
   offline WASM worklet rendering is **NOT READY**.
3. **CSP:** the spike replica now has a positive CI observation for `file://`, but
   validate the exact runtime path in the actual Apex executable because Electron's
   docs disagree with the replica result. Make the owner’s security-policy decision
   from that evidence; do not relax production CSP as part of this spike.
4. **Hardware:** run the README benchmark on a representative Windows laptop with
   the production audio device/backend; record dropouts, underruns, headroom and
   browser/Electron versions. **NOT RUN.**
5. Choose and licence-review a production WASM toolchain.

## 11. Remaining risks before migrating any production DSP

* Per-renderer WASM memory allocation ceiling of about 124–125 memories reproduced
  in Linux Chromium and Windows Chrome/Edge. V8 source suggests an 8 GiB reservation
  per wasm32 memory in a 1 TiB sandbox, but that reservation is inferred, not
  measured in the deployed builds. Shared-budget interaction with third-party WASM
  remains a capacity risk (§8.3, §12.1, §12.6).
* `OfflineAudioContext` worklet scopes retained their WASM memories until document
  teardown in Linux Chromium and Windows Chrome/Edge. A long-lived Worker now passes
  200 serial kernel-only jobs using one 128 KiB memory in local Node/Chromium, but
  full offline graph/export integration and retention behavior in that path remain
  **NOT RUN**. Cross-isolate GC/reclamation was directly tested only in local
  Chromium (§12.2, §12.6, §13).
* Windows Chrome/Edge browser runs are available. Current PR CI measured the
  existing shared-engine/bank path in unpackaged and asar Electron and separately
  probed a packaged production build's strict CSP. The production probe blocked
  WASM as configured; the Electron docs/test discrepancy and any CSP relaxation
  decision remain open. The new long-lived Worker path was **NOT RUN** in Electron
  (§5, §13).
* Real-device latency and dropouts (especially WaveOut via `force-wave-audio`) on a
  mid-range laptop are **NOT RUN**.
* Main-thread jank, GC, and tab or window backgrounding effects on the audio thread are not exercised beyond a 16 ms ticker.
* Parameter automation (sample-accurate AudioParams vs messages), denormal behaviour in
  more complex DSP, and memory growth are not exercised by this kernel.
* Determinism holds here because the kernel avoids transcendental functions and FMA.
  DSP using `sin`, `exp` or SIMD will need explicit tolerances, not hash equality.
* Migrating native-node DSP changes the sound. Every migrated effect needs
  A/B listening plus numerical comparison against the current engine, behind a
  flag, with the native path kept as a fallback.
* Single-thread capacity: all AudioWorklet processors in a context share one thread,
  so headroom must be measured on target hardware.

---

## 12. Prior follow-up investigation (2026-10-10; historical PR #205 CI on `b86d47`)

Unless noted as Windows CI below, the experiments in §§12.1–12.4 were run locally
in Chromium 153.0.8010.0 headless on Linux x86-64 (2 vCPU / 3 GB VM, fake audio),
Playwright 1.63.0, Node v22.22.3. Each local case ran in a **fresh browser context**
(a fresh renderer process). The tests are codified in
`tests/browser/investigation.spec.mjs`: `[must]` tests are requirements and `[char]`
tests characterize current browser behavior. Raw JSON is written to git-ignored
`results/*-investigation-*.json`; summaries come from `scripts/summarize-results.mjs`.
The Windows browser follow-up ran in GitHub Actions run #38051848530 on
`b86d47db0995ee655339e5d6cf927ef60420fea2`; Chrome/Edge annotation results are in
§12.6. The older §12 Electron-CSP statements are historical: a later prior-PR run
#38053541244 exposed the spike replica's `file://` results, summarized in §13. Those
older Electron checks do not validate the new bounded follow-up integration.

### 12.1 Minimal reproduction: what is limited

| Probe on the main thread (no audio), fresh renderer each | Created (limit 1000) | Error |
|---|---|---|
| `new WebAssembly.Memory({initial:1})` | **124–125** | `RangeError: WebAssembly.Memory(): could not allocate memory` |
| same, `maximum: 1` | 124–125 | same |
| same, `shared: true, maximum: 1` | 124–125 | same |
| memory64 `{initial: 1n, address: 'i64'}` | **61–62** | same |
| instances of `(module (memory 1))` | 124–125 | `WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new instance` (the original error) |
| instances of `(module)` (no memory) | 1000 | none |
| instances importing **one** shared memory | 1000 | none |
| 64 KiB `ArrayBuffer`s | 1000 | none |

| Variable | Result |
|---|---|
| `--js-flags=--expose-gc`: do flags reach V8? | yes (`typeof gc === 'function'`) |
| `--wasm-enforce-bounds-checks` (a real flag in this build) | cap unchanged (124 vs 125) |
| `--no-wasm-trap-handler` (previous revision) | **flag absent from this build: experiment invalid** |
| Drop references, then allocate again (same isolate) | 124 again: V8 runs GC and retries on failure (`gc_retry` in `backing-store.cc`) |
| Two pages in separate renderers | 125 each: the budget is per renderer process |
| Main thread uses the budget, then the worklet tries | worklet gets 0 (shared across isolates) |

**Windows Chrome/Edge follow-up (run #38051848530, check-run annotations):**

| Attempt | Chrome 154.0.8037.58 | Edge 153.0.4234.48 |
|---|---|---|
| Per-node layout, 128 units | Fails during allocation at about 124 memories | Fails at about 124 |
| Per-node layout, 256 units | Fails at about 124 | Fails at about 125 |
| Per-node layout, 512 units | Fails at about 124–125 | Fails at about 124–125 |
| `engine-nodes` / `engine-bank`, through 512 logical units | Initializes with one WASM memory | Initializes with one WASM memory |

Thus the allocation failure reproduces on Windows Chrome and Edge, including at
both requested 128- and 256-unit loads. These results do not establish Electron's
renderer behavior. The Linux direct probes show that the limiting resource is a
live memory and that memory-less/shared-memory instances avoid the per-memory cap;
the Windows per-node and engine comparison results are consistent with that.

**Mechanism indicated by V8 source, not directly measured:** each live wasm32 memory
is predicted to reserve 8 GiB from a 1 TiB per-process pool (see §8.3). The source
uses the same desktop x64 sandbox branch for Linux and Windows, and the measured
Linux plus Windows Chrome/Edge ceilings are consistent with the calculation.
V8 HEAD is not necessarily the exact V8 revision in these browser builds, so the
reservation size remains an inference, not a runtime measurement. The later Electron
43.4.1 cap and offline-retention results are in §13; those do not confirm the exact
V8 reservation mechanism.

### 12.2 Lifecycle: when are memories released?

| Scenario (100 per-node instances unless stated) | Memories creatable afterwards |
|---|---|
| Realtime context: dispose, then `AudioContext.close()` | **124–125** (released) |
| Realtime context churn: 10 × 100 create/dispose (all 3 layouts) | **1000/1000** succeeded in every layout |
| 150 realtime open → 4 engine units → close cycles | 150/150 |
| `OfflineAudioContext` never rendered: dispose, drop references | 24–25 (**retained**) |
| same, plus forced main-thread `gc()` | 24–25 (retained) |
| `OfflineAudioContext` **rendered to completion**, then dispose | 24 (retained) |
| **Repeated offline renders (16 units each)**: per-node | stops at render **7** of 40 |
| repeated offline renders: **engine-nodes** / **engine-bank** (one memory per render) | stop at render **124** / **124** of 200 |
| after exhaustion: idle 30 s with forced `gc()` every second | still **0** memories; a new realtime context cannot create the engine either |
| after exhaustion: **page reload** (same renderer) | 124 again (released at document teardown) |
| 200 sequential dedicated Workers, each with a memory, `terminate()`d | 200/200, budget intact |
| main thread holds 124, drops references, worklet allocates | **fails**, also after 3 s idle; succeeds only after a main-thread `gc()` |

**Windows Chrome/Edge lifecycle annotations (run #38051848530):** repeated offline
renders showed the same retention pattern in both browsers. The per-node layout
completed only **7** renders before exhaustion; `engine-nodes` and `engine-bank`
completed about **124–125 of 200**. After exhaustion, the main-thread allocation
probe created **0** memories; after document reload, about **124–125** were available
again. These are CI-browser observations, not a physical-device test. Detailed
cross-isolate GC checks in the preceding table were run locally, not claimed for
Windows.

**Confirmed:**
* Local Chromium and Windows Chrome/Edge retained `OfflineAudioContext` worklet
  scopes and their memories until document teardown. Each offline render that
  instantiates WASM in its worklet consumes one of the ~125 page-level slots until
  teardown.
* In the **local Chromium** cross-isolate probe, a failed allocation only triggers
  GC in the allocating isolate. Unreferenced memories in another isolate keep
  blocking it until that isolate collects; this GC mechanism was not separately
  verified on Windows.

**Hypothesis, not tested:** the retention is a Chromium implementation detail
(offline worklet threads or global scopes live with the document). I did not find
or check a Chromium bug for it; the bug tracker is not reachable from this sandbox.

**Mitigation candidates (not validated as complete rendering paths):**
* (a) Render export DSP in one **long-lived Worker** (or on the main thread) that
  reuses one engine instance, feeding native-node stems to it. A prototype module
  Worker now processes 200 serial PCM kernel jobs with one ABI-v2 engine and fixed
  128 KiB memory; Node and Chromium output are bit-exact. It creates no
  `OfflineAudioContext`, imports no real export stems, and does not implement full
  graph/export semantics, so the mitigation path remains untested.
* (b) Import one shared `WebAssembly.Memory` into every worklet scope instead of each
  scope creating its own. This needs SharedArrayBuffer, which means cross-origin
  isolation in the browser; not prototyped.
* (c) Cap offline renders per document and reload, which is not acceptable UX; not
  prototyped.

The Worker prototype terminates after its serial batch, but only confirms kernel
reuse and teardown—not the behavior of an actual export pipeline.

### 12.3 Design comparison (3 runs per cell, ranges are min–max)

`per-node` = the original layout, one instance and memory per AudioWorkletNode.
`engine-nodes` = one AudioWorkletNode per unit, sharing one engine per audio thread.
`engine-bank` = one AudioWorkletNode running N units. Each live run: looping test
signal, 1 s warm-up, then **15 s** measured. Units all read the same input.
"Headroom" = how many more `WebAssembly.Memory` objects the page could still create
while the units were alive. RSS = summed renderer VmRSS from `/proc`, baseline
103–106 MB. Overruns use the worklet's 1 ms `Date.now` clock (a block counts if it
measures ≥ 3 ms against the 2.67 ms budget), so single-block counts are coarse.

| Design | Units | Init | Init ms | WASM memories | Headroom | Renderer RSS peak MB | DSP % of quantum | Rendered % | Overruns | Lag > 50 ms | Browser underruns |
|---|---|---|---|---|---|---|---|---|---|---|---|
| per-node | 16 | OK | 12–14 | 16 | 108–109 | 127–130 | 1.6–2.1 | 100 | 0 | 0 | 0–1 |
| per-node | 64 | OK | 27–61 | 64 | 60–61 | 131–132 | 7.1–8.5 | 100 | 0 | 0 | 0–1 |
| per-node | 128 | **FAIL at #124–125** | 45–62 | 124–125 | 0 | 104–106 | NOT RUN | | | | |
| per-node | 256 | **FAIL at #125** | 45–98 | 125 | 0 | 104–106 | NOT RUN | | | | |
| per-node | 512 | **FAIL at #124–125** | 63–71 | 124–125 | 0 | 104–105 | NOT RUN | | | | |
| engine-nodes | 16 | OK | 14–19 | 1 | 123–124 | 128–130 | 1.6–1.9 | 100 | 0 | 0 | 0 |
| engine-nodes | 64 | OK | 13–18 | 1 | 123–124 | 130 | 6.1–7.0 | 100 | 0 | 0 | 0–3 |
| engine-nodes | 128 | OK | 28–34 | 1 | 123–124 | 133 | 11.8–14.2 | 100 | 0–1 | 0 | 0–4 |
| engine-nodes | 256 | OK | 66–94 | 1 | 123–124 | 135–137 | 24.4–26.3 | 100 | 0–1 | 0–1 | 0–71 |
| engine-nodes | 512 | OK | 238–275 | 1 | 123–124 | 148 | 47.5–53.6 | **72–82** | 0–1 | **52–83** | **1496–1506** |
| engine-bank | 16 | OK | 8–11 | 1 | 123–124 | 127–128 | 1.2–1.8 | 100 | 0 | 0 | 0 |
| engine-bank | 64 | OK | 10–12 | 1 | 123–124 | 127–128 | 5.2–5.5 | 100 | 0–1 | 0 | 0 |
| engine-bank | 128 | OK | 8–9 | 1 | 123–124 | 127–129 | 9.2–10.5 | 100 | 0–2 | 0 | 0 |
| engine-bank | 256 | OK | 8–10 | 1 | 123–124 | 127–128 | 18.0–21.0 | 100 | 0–4 | 0 | 0 |
| engine-bank | 512 | OK | 9–42 | 1 | 123–124 | 126–128 | 35.3–40.9 | 100 | 3–11 | 0 | 0–1 |

Logical WASM memory: per-node 64 KiB linear + 8 GiB reserved address space **per
unit**; engine 128 KiB linear + 8 GiB reserved **per audio thread**. The reservation
is derived from V8 source, not measured.

**What the tests prove (this machine only):**
* Both engine layouts initialise every tested count, 16–512, with exactly one
  memory, in 3 of 3 runs. Slots return to 0 after dispose, deterministically, in
  every run.
* The per-node layout cannot exceed about 125 units and leaves 0 headroom for any
  other WASM in the page.

**What they do not prove:**
* That any layout is glitch-free on target hardware. Sporadic 1–11 underruns or
  overruns occur in every layout here, including the 16-unit per-node baseline, on a
  shared 2-vCPU VM with fake output.
* The one robust performance signal: engine-nodes at 512 collapses in 3 of 3 runs,
  and engine-bank at 512 does not. Bank DSP time is about 25–30% lower at 256–512
  units, the cost of per-node call and copy overhead. The bank's renderer RSS stays
  flat (126–129 MB), while engine-nodes grows to 148 MB at 512.

### 12.4 CSP: exact requirement (production policy copied byte-for-byte from `electron.cjs`; not modified)

| Policy (served over HTTP to Chromium 153) | `eval` | Main thread | Worklet (per-node) | Worklet (engine) | Dedicated Worker |
|---|---|---|---|---|---|
| none | allowed | allowed | allowed | allowed | allowed |
| **production as-is** | blocked | **BLOCKED** | **BLOCKED** | **BLOCKED** | **BLOCKED** |
| **production + `'wasm-unsafe-eval'` in `script-src`** | **blocked** | allowed | allowed | allowed | allowed |
| `'wasm-unsafe-eval'` in `default-src` only | blocked | BLOCKED | BLOCKED | BLOCKED | BLOCKED |
| `'unsafe-eval'` in `script-src` (broader) | **allowed** | allowed | allowed | allowed | allowed |
| document has wasm token, script responses do not | blocked | allowed | **allowed** | **allowed** | BLOCKED |
| document lacks wasm token, script responses have it | blocked | BLOCKED | **BLOCKED** | **BLOCKED** | allowed |

**Exact HTTP requirement (confirmed in local Chromium and Windows Chrome/Edge):**
add `'wasm-unsafe-eval'` to **`script-src`** of the policy that governs the document.
AudioWorklets inherit the document's policy and ignore the worklet script's own
response header. If a dedicated Worker is used (for example offline mitigation (a)),
the Worker script response's policy also needs it. Putting the token in `default-src`
does nothing when an explicit `script-src` takes precedence. `'unsafe-eval'` also
works but re-enables `eval`/`new Function`, so it is not recommended. These results
are from HTTP test pages; Electron's `file://` behavior must be measured separately.

**Spike-only Electron CSP observation (prior PR run #38053541244):** Electron
43.4.1/Chrome 150/V8 15.0.245.28 ran both unpackaged and asar-packaged harnesses.
For each, the response-header hook handled 9/9 `file://` responses; the copied
`production` policy was reported enforced and blocked main-thread/worklet WASM, and
`production-wasm` allowed both. This contradicts Electron v43.4.1's
[security tutorial](https://github.com/electron/electron/blob/v43.4.1/docs/tutorial/security.md#csp-meta-tag),
which says header CSP is not possible for `file://` and recommends a `<meta>` tag or
custom protocol. The latest PR run #38055574687 also probed the packaged production
build at `app.asar/dist/index.html` and recorded inline-script and WASM CSP blocks
(§13). The current production policy therefore was exercised in that packaged CI
build; the long-lived Worker and 16-unit bank-precision additions remain **NOT RUN**
in Electron. Production files and CSP settings were not changed.

### 12.5 CI run status

Run [#38051848530](https://github.com/Ajey877/Apex-Studio/actions/runs/38051848530)
completed with **SUCCESS** on head
`b86d47db0995ee655339e5d6cf927ef60420fea2`. The Linux spike tests, Windows Chrome
and Edge investigations, Windows Electron unpackaged/packaged jobs, and the PR's
`verify`, `audio-tests` and `windows-package` regression checks all passed. The
Windows browser job ran the new investigation spec and exposed detailed compact
`::notice` annotations (environment, probes, lifecycle, offline renders, engine
parity, comparisons and CSP matrix) through the GitHub check-runs API. See §12.6.

The Electron check-run (`114212401077`) has **no runtime CSP measurements** in its
annotations (only a Node.js deprecation warning). The run uploaded an Electron
artifact, but its ZIP contents/logs could not be retrieved from this workspace.
Therefore Electron's passing job status does not settle packaged `file://` CSP
behavior. Windows browser artifact metadata is available; the browser annotations,
not the artifact contents, are the source for §12.6 measurements.

The older [run #38051170797](https://github.com/Ajey877/Apex-Studio/actions/runs/38051170797)
on `f122952e78968c0c874ddaa92daa8b00d910ec04` covered the original suite, not the
new follow-up investigations. Full logs and artifact ZIPs from those runs redirected
to external Actions storage that this workspace could not reach. The Electron
annotations from the later prior-PR run #38053541244 are summarized in §13; they
supersede the older CSP **NOT VERIFIED** statement for the spike replica only. The
representative Windows laptop remains **NOT RUN**. Current PR #205 head/check status
and the local bounded follow-up are distinct; see §13.

### 12.6 Windows browser and packaged Electron findings (run #38051848530)

Source: Windows browser check-run annotations for `114212401187`, on head
`b86d47db0995ee655339e5d6cf927ef60420fea2`. Browser versions reported by the run:
Chrome **154.0.8037.58** and Edge **153.0.4234.48**. The follow-up investigation
ran in addition to the original suite; it is separate from the older run on
`f122952`.

#### Allocation and engine initialization

| Layout / requested logical units | Chrome 154 | Edge 153 |
|---|---|---|
| per-node, 128 | allocation fails at about **124** memories | fails at about **124** |
| per-node, 256 | fails at about **124** | fails at about **125** |
| per-node, 512 | fails at about **124–125** | fails at about **124–125** |
| `engine-nodes` and `engine-bank`, through 512 | initialize with **one** WASM memory | initialize with **one** WASM memory |

**Answer to the Windows reproduction question: yes.** The 128- and 256-unit
per-node allocation failures reproduce in both Windows browsers, with the same
approximately 124–125-memory ceiling observed locally. `engine-nodes`/`engine-bank`
slot release and parity annotations passed. The reported parity checks were all true:
shared engine, distinct slots, golden/reference comparisons, bank output, and slot
release on dispose. This is evidence for the tested browser builds, not Electron.

#### 512-unit live comparison (15-second CI observations)

| Browser | Layout | Reported DSP load (% of quantum) | Rendered | Lag events (>50 ms) | Browser underruns |
|---|---|---:|---:|---:|---:|
| Chrome 154 | `engine-nodes` | 35.7% | 97% | 10 | 393 |
| Chrome 154 | `engine-bank` | 24.7% | 100% | 0 | 0 |
| Edge 153 | `engine-nodes` | 33.7% | 100% | 0 | 0 |
| Edge 153 | `engine-bank` | 26.7% | 100% | 0 | 0 |

The bank and both Edge cases also reported zero over-budget blocks; the Chrome
`engine-nodes` annotation summary did not provide an over-budget count. These are
short CI-runner observations, not physical-device measurements. The green comparison
tests assert initialization, memory use and slot release; they do **not** assert
healthy audio output. Do not treat these figures as a laptop benchmark or a
production performance guarantee.

#### Windows lifecycle probes

Realtime churn reached **1000/1000** for per-node, `engine-nodes` and `engine-bank`.
Repeated offline-context renders reproduced retained WASM memories: the per-node
layout completed only **7** renders; the engine-node and engine-bank layouts reached
about **124–125** renders before exhaustion. After exhaustion the main-thread memory
probe created **0**; after document reload about **124–125** were available again.
This confirms the offline-context retention in Windows Chrome and Edge. The more
detailed cross-isolate forced-GC experiment was local-only (§12.2).

#### CSP matrix in Windows Chrome/Edge (HTTP test server only)

The bit order is `[eval, mainThread, per-node worklet, engine worklet, dedicated
Worker]`; `1` means allowed and `0` blocked. Chrome and Edge reported the same
matrix:

| Policy | Allowed/blocked bits |
|---|---|
| none | `11111` |
| production | `00000` |
| production + `wasm-unsafe-eval` in `script-src` | `01111` |
| production + `wasm-unsafe-eval` in `default-src` only | `00000` |
| production + `unsafe-eval` in `script-src` | `11111` |
| document has WASM token, script responses use production policy | `01110` |
| document uses production policy, script responses have WASM token | `00001` |

This confirms the HTTP test matrix: a document `script-src` with
`'wasm-unsafe-eval'` permits WASM but not JS `eval`; a token in `default-src` alone
does not suffice when `script-src` is explicit. Split-policy results show the
AudioWorklet follows the document policy, while the dedicated Worker follows its
script response policy. These browser results **do not establish** behavior for the
Electron app's `file://` page.

#### Electron CSP and allocation observations (later prior-PR run #38053541244)

The older check-run `114212401077` from run #38051848530 had no Electron runtime
values. A later run on prior PR head `1800123529b2de3de37af0e67d75ad5217f73ec1`
emitted check-run `114217319452` annotations for both unpackaged and asar-packaged
modes (Electron 43.4.1, Chrome 150.0.7871.224, V8 15.0.245.28-electron.0):

* With `production` CSP, the response hook was installed, saw 9/9 `file://` calls,
  reported CSP enforced, and main-thread/worklet WASM were blocked; all checks passed.
* With `production-wasm`, the same hook saw 9/9 `file://` calls and allowed both
  main-thread and worklet WASM; all checks passed.
* With `csp=none`, each mode created 105 memories before the next allocation failed;
  the second allocation round after dispose created 0. Sustained 16-unit load passed
  in both modes (1.45% packaged / 1.34% unpackaged CPU, 0 overruns, 0 dropouts,
  0 underruns).

This run is measured evidence for the **spike-only Electron replica** and does not
itself test the Apex executable; its CSP observation conflicts with the Electron
docs (§12.4). Current-head run #38055574687 adds engine/bank, offline retention and
packaged production-app CSP evidence (§13). The long-lived Worker prototype and
16-unit bank precision assertion remain **NOT RUN** in Electron. The
representative-laptop benchmark is **NOT RUN**. No production audio code or CSP
setting was changed.

---

## 13. Bounded offline Worker and Electron follow-up (2026-10-10)

### Scope, branch and CI boundary

The follow-up changes are isolated to `experiments/audioworklet-wasm-spike/`. The
session branch is `arena/724da208-apex-studio`; PR #205 is on the separate
`arena/96cb2a8b-apex-studio` branch. PR #205's current head is
`ed0a79217cb455d87704b1c6ff02ee68687b81a5`. The Actions run
[#38055574687](https://github.com/Ajey877/Apex-Studio/actions/runs/38055574687)
completed **SUCCESS**: `verify`, `audio-tests`, `windows-package`, Linux Audio Spike,
Windows Chrome/Edge, and Windows Electron all passed on the PR head. It includes the
PR branch's existing engine/bank Electron coverage and packaged production CSP probe,
but not the local offline Worker prototype or local 16-unit bank precision
assertion. Those local follow-up changes have no CI validation. The preceding green
run #38054717669 was on PR head `243ae88052fc21c187d6ee1415070a82c6cd605e`; earlier
#38053541244 was on `1800123529b2de3de37af0e67d75ad5217f73ec1`.

No production audio-engine file, production CSP, or workflow was changed. No PR was
created or merged, and Phase 1 was not started.

### Offline memory investigation and prototype

The reported failure is still reproduced by creating independent worklet memories
for each `OfflineAudioContext`. In headless Linux Chromium 153.0.8010.0, the
regression case produced these exact results:

| Layout | Requested | Completed | Failure / observation |
|---|---:|---:|---|
| per-node | 40 offline renders × 16 units | 7 | Next worklet reported `WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory for new instance` |
| engine-nodes | 200 renders × 16 units | 124 | Same WASM memory allocation error on render 124 |
| engine-bank | 200 renders × 16 units | 124 | Same WASM memory allocation error on render 124 |
| after exhaustion | main-thread probe | 0 memories | No additional one-page WASM memory could be created |
| after document reload | main-thread probe | 124 memories | Allocation capacity returned at document teardown |

The Worker prototype (`offline-engine-core.mjs`, `offline-engine-worker.js`) owns one
ABI-v2 engine with one slot and fixed 131,072-byte WASM memory, processes serial
stereo PCM jobs, resets slot state per job, transfers output buffers back, and is
terminated after the batch. Results:

* Node core test: **200/200** independent jobs match the JS reference bit-exactly;
  one engine and 131,072 bytes are reused. Malformed jobs are rejected without
  incrementing the render count.
* Real module Worker in Chromium: **200/200** jobs completed, **200/200 exact**,
  max absolute difference **0**, frames per job **4,800**, one engine instance,
  memory remained **131,072 bytes**; `OfflineAudioContext` count was **0**.
* Scope limitation: this proves reusable kernel PCM processing and Worker transport,
  not a complete render/export pipeline. It does not schedule a graph, render native
  stems, serialize project effects/automation, cover cancellation or integrate with
  the application's exporter. Consequently it is not evidence that actual repeated
  offline exports avoid retention.

### Shared-engine and bank regression results

Targeted headless Chromium 153 AudioWorklet tests passed:

* Three engine units shared one ABI-v2 instance/memory and occupied distinct slots;
  individual outputs matched their independent references exactly, and `dispose()`
  returned slots to zero.
* The 16-unit bank used one engine instance and 16 slots. Averaging identical
  Float32 streams produced max absolute difference
  **1.1920928955078125e-7** (one Float32 ULP) against the single-stream reference,
  with **0 non-finite samples**. It is **not bit-exact**: each channel had 24,976
  / 23,930 differing samples. This is within the configured `1e-6` comparison
  tolerance. A separate one-unit bank still matched the golden hash exactly.
* The initial 16-unit bank exact-hash assertion failed. Inspection isolated normal
  Float32 accumulation rounding in the repeated sum/average; the regression now
  correctly requires tolerance for the multi-unit mixer and retains exact-hash
  coverage for the one-unit bank. This distinction corrects the older unqualified
  multi-unit “bit-exact bank” wording.

The same Chromium run reran the known per-node failure tests: x128 and x256 each
created **125** instances before the next allocation failed. Those are passing
regression assertions for the known failure, not success of the per-node design.

### Shared-engine, bank and offline-retention results in Electron CI

The latest PR run #38055574687 (head `ed0a79217cb455d87704b1c6ff02ee68687b81a5`)
ran Electron 43.4.1 / Chrome 150.0.7871.224 in both unpackaged and asar-packaged
modes. Source: check-run `114223207904` annotations. It validated the engine/bank
prototype on that PR head; the Worker prototype added on the separate session branch
is not present in those annotations. Prior run #38054717669 on head `243ae` showed
more variable 512-unit results, summarized below as historical comparison evidence.

| Probe | Unpackaged | Packaged asar |
|---|---|---|
| Shared-engine parity / slot release | **PASS**; shared engine, distinct slots, individual golden/reference parity, slot release; one-unit bank golden | **PASS**; same checks |
| x128 layout comparison | Per-node fails at 124; engine-nodes and engine-bank initialize with 1 memory and render 100% | Per-node fails at 123; engine-nodes and engine-bank initialize with 1 memory and render 100% |
| x512 engine-nodes | 32.0% quantum, 100% rendered, 0 lag/underruns in latest run | 32.3% quantum, 100% rendered, 0 lag/underruns in latest run |
| x512 engine-bank | 24.7% quantum, 100% rendered, 0 underruns | 24.7% quantum, 100% rendered, 0 underruns |
| Offline-context retention | per-node 7; engine-nodes/bank 124; after exhaustion 0; after reload 124 | per-node 7; engine-nodes/bank 123; after exhaustion 0; after reload 123 |
| `csp=none` allocation probe | 104 successes, next allocation fails; second-after-dispose 0 | 105 successes, next allocation fails; second-after-dispose 0 |
| CSP `production` / `production-wasm` | Hook saw 9/9 `file://`; production blocks main/worklet WASM; production-wasm allows both | Same |

The latest Electron run rendered all x512 cases at 100%, but earlier run #380547
showed engine-nodes at 95–96% with 775–1,016 underruns while engine-bank remained
at 100% with none. In the latest Windows browser run #380555, engine-nodes fell to
83% / 1,412 underruns in Chrome and 72% / 1,327 in Edge; engine-bank rendered 100%
with no underruns (3 over-budget blocks). This variance across hosted runs is a
finding, not a stable performance guarantee or a physical-device benchmark. The
unpackaged Electron churn annotation was 123/1000 in #380547 but 1000/1000 in
#380555; packaged was 1000/1000 in both. Record the discrepancy rather than
assuming deterministic lifecycle behavior.

A packaged production-app CSP probe in the latest run opened
`app.asar/dist/index.html`: `metaCsp=false`, inline script blocked, CSP violations
reported for `script-src` / `wasm-eval`, and WASM compile, synchronous module
compilation, and instantiation blocked. The probe reported `AudioWorkletNode`
available and `memoryCap: 123` (run #380547 reported 124). This confirms strict CSP
behavior for the tested packaged build, while Electron docs still disagree with the
observed header-hook behavior. It does not test the new offline Worker under CSP.

### Validation performed on these local changes

| Check | Result | What it covers / does not cover |
|---|---|---|
| `npm run check:wasm` | **PASS** | `gain_biquad` 681 bytes / SHA-256 `3ce00d847b02903ff6ef16126a8ce94d2bbe413354ab003da615ccf36be67f8f`; engine 815 bytes / SHA-256 `207b12bcd2380032cae38396551c7ad4115e58262b9118f216c65771e5abe20b`; reproducible |
| `npm run test:node` | **PASS — 28 passed, 0 failed** | Includes new 200-job core reuse and malformed-job rejection; does not test browser or Electron APIs |
| JavaScript syntax checks (`node --check` on modified/new `.mjs`, `.js`, `.cjs`) | **PASS** | Parse/syntax only; no Electron launch |
| Targeted Playwright, `--project=chromium` | **PASS — 5/5** | Worker 200-job parity (1), engine/bank parity (1), offline retention (1), per-node allocation x128/x256 (2) |
| Full spike Playwright matrix, installed Chrome/Edge, root browser suite | **NOT RUN** for these changes | Only the five listed Chromium cases were run; CI green jobs are for other commits |
| New local Electron Worker / 16-unit bank precision assertion | **NOT RUN locally** | The existing shared-engine/bank Electron path was exercised on PR head `ed0a792` in run #38055574687 (see above). The new Worker prototype and 16-unit tolerance assertion are absent from that run. Local Electron executable was absent; `npm rebuild electron` did not produce it, and installer fetch failed with `TypeError: fetch failed`. No local Electron app launched; no `DISPLAY`, `xvfb-run`, or `Xvfb` is available. |
| Representative physical audio device / Windows laptop | **NOT RUN** | The local browser uses headless Chromium and software/fake audio; no hardware performance evidence. |

Earlier Electron 43.4.1 run #38053541244 tested the CSP/allocation harness and
reported 105 allocations before failure in both packaging modes, plus 9/9 CSP-hook
calls. Runs #38054717669 and #38055574687 include the shared-engine/bank and
OfflineAudioContext retention coverage summarized above. Neither contains the local
long-lived offline Worker or the 16-unit bank precision assertion.

### Current risks and recommendation

The bounded Worker prototype is a viable **candidate** for avoiding one worklet
memory per export, but the full export semantics and repeated-export lifecycle have
not been implemented or tested. Worklet-backed offline rendering still exhausts
memory. The bank's multi-unit output has measurable Float32 rounding and now uses a
tolerance check; this is tiny for the measured fixture but should not be generalized
as exact equality. The new Electron integrations and the actual Apex CSP path remain
untested in this follow-up. Browser/CI measurements do not replace physical-device
audio tests.

**Recommendation remains REVISE.** Do not merge on the strength of these green local
checks, do not start Phase 1, and do not alter production audio code or CSP. Required
next evidence is full offline-export integration with repeated renders, unpackaged
and packaged Electron execution of the shared-engine/bank and Worker prototypes,
confirmation on the production app's actual CSP path, current-branch CI for the
follow-up changes, and a representative hardware audio-health run. All unrun items
remain explicitly **NOT RUN**.

---

## 14. Bounded synthetic multi-track live/offline prototype (2026-10-10)

### Scope and exact source snapshot

Implementation and test code are in `1e725c009eb73f561eca44815d2d4fc07045fe07`
on the fixed session branch. This is a prototype-only model; it does not read,
serialize or export an Apex Studio project. It changes no production audio code,
CSP or workflow. No PR was created or merged.

### Representative fixture and supported semantics

`fixtures/representative-project.mjs` defines a deterministic 48 kHz, 120 BPM,
4/4, two-bar fixture with a 250 ms tail: **204,000 frames / 4.25 seconds**, four
independent tracks and **48 clip events**. Kick and closed-hat use generated
one-shot sample-like sources; bass and chord/pad use simple saw/triangle note
voices. Tracks have distinct scheduled inputs, ADSR/release, low-pass/gain inserts,
independent fader automation and pan, two buses (`rhythm`, `music`), static sends,
bus gains/drives, and a master gain.

Implemented stage order is **source scheduling → per-track WASM gain+biquad →
sample-rate fader automation → pan → track-to-bus routing → bus gain+soft clip →
master sum/gain → stereo PCM16 WAV**. The live Worklet accepts four distinct mono
AudioBuffer inputs and captures per-track, per-bus and master output. The live test
harness schedules pre-rendered deterministic fixture buffers; its source scheduler
is not Apex's production transport. The Worker performs clip/note scheduling and
source generation during each export, routes the tracks, applies the same supported
DSP stages, and encodes a WAV in memory. It is one long-lived module Worker and one
ABI-v2 engine for the serial batch.

The JavaScript reference uses the same fixture schedule/source model (so event
content is shared) but independently filters and mixes in scalar JS. This validates
WASM DSP, track/bus mixing, routing and stage order against a defined reference;
it does not independently validate production project parsing or instrument
implementation. Supported DSP is limited to one gain+biquad insert per track,
linear track-fader automation, static pan/sends, bus gain and a simple rational soft
clip. Missing/mocked: saved `.apex` state, project save/load, production
instruments/sample decoding, real effect/plugin state or chains, automation beyond
track volume, tempo changes, sidechains, latency compensation, clip warp, mastering,
application export integration, file I/O, and production error/lifecycle policy.
This is **not** a complete DAW export path.

### Results on implementation commit `1e725c009eb73f561eca44815d2d4fc07045fe07`

Executed from `experiments/audioworklet-wasm-spike/` on the implementation commit:

```text
npm run check:wasm
npm run test:node
find web tests electron scripts server fixtures -type f \
  \( -name '*.mjs' -o -name '*.js' -o -name '*.cjs' \) -print0 | xargs -0 -r -n1 node --check
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chromium --grep 'prototype-only representative Apex-style multitrack project'
```

Availability attempts (both browser commands exit before any test body; Electron
commands do not reach app launch):

```text
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chrome --grep 'prototype-only representative Apex-style multitrack project'
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=msedge --grep 'prototype-only representative Apex-style multitrack project'
node electron/run-electron.mjs
node electron/run-electron.mjs --packaged
```

| Test | Result and measurements |
|---|---|
| `npm run check:wasm` | **PASS**; 681-byte v1 and 815-byte ABI-v2 WASM rebuilds match committed binaries. |
| `npm run test:node` | **36/36 PASS**, 0 failures/skips. Includes fixture scheduling/release, independent reference, effect-order sensitivity, 12 serial full-project exports, slot/memory reuse, cancellation recovery, WAV/float interleave validation and project validation. |
| JavaScript syntax checks | **PASS**; command above checks `.mjs`, `.js` and `.cjs` under `web/`, `tests/`, `electron/`, `scripts/`, `server/`, and `fixtures/`. |
| Targeted Playwright on bundled Chromium | **5/5 PASS**; `project-prototype.spec.mjs`, Linux Chromium 153.0.8010.0 / Playwright 1.63.0 / Node 22.22.3, 2 vCPU / 3 GB sandbox, software/fake audio. Covers live routing/effect order, parameter update, direct live/offline float parity, 200 Worker exports, and cancellation/recovery. Not a full browser-suite run. |
| Chrome stable / Edge stable | **NOT RUN**. Exact commands used the same config/grep with `--project=chrome` then `--project=msedge`. All five test launches per project failed before the body because `/opt/google/chrome/chrome` and `/opt/microsoft/msedge/msedge` are absent; **0 test bodies ran**. No result is inferred from older PR CI. |
| Electron unpackaged / packaged asar | **NOT RUN**: `node electron/run-electron.mjs` could not acquire Electron (`TypeError: fetch failed`), no executable launched; `node electron/run-electron.mjs --packaged` found no staged app. The test harness/stager includes the fixture and project suite, but neither mode executed. |
| Representative Windows laptop / physical output | **NOT RUN**. |

**Live Worklet:** four slots, one engine instance, fixed **131,072-byte** WASM
memory. Across **204,000 captured frames**, maximum absolute difference against
the JS reference was **2.9802322387695312e-8** (acceptance tolerance `1e-6`); track
stems, buses and master were compared. The alternate ordering (fader automation
before, rather than after, the biquad) differed by `7.674098014831543e-6`, making
the order test observable. A live bass fader update from `0.78` to `0.12` was
acknowledged at project frame **34,048** (requested near frame 33,600); the bass
region RMS fell to **0.153846** of its unchanged baseline while the hat stem stayed
bit-exact. All four slots were returned on dispose.

The direct **live Worklet vs Worker Float32 master** comparison passed: maximum
absolute difference **2.9802322387695312e-8** across both channels and all frames,
within `1e-6`; each side also matched the JS reference to the same maximum. The
Worker transferred 1,632,000 bytes of interleaved float PCM for this one-off
consistency case, plus a valid 816,044-byte WAV. Both live and offline DSP used one
engine and 131,072-byte WASM memory; live slots returned to zero.

In this Chromium run, the 4.25 s capture took **4,423 ms** wall time. Worklet
processing averaged **0.126 ms/block**, observed p95/p99 **1 ms**, max **1 ms**,
with a 2.667 ms quantum budget, **0** over-budget blocks, **0** frame discontinuities
during the scheduled project interval, and **0** `playbackStats` underruns. There
was **one 1,024-frame startup discontinuity before the scheduled project start**;
it is classified separately, not hidden. Worklet timing used `Date.now()` (1 ms
resolution in this runtime), so the percentile figures are coarse and are not
hardware/audio-health evidence.

**Long-lived Worker:** **200/200** full fixture exports completed sequentially in
one Worker. Each produced 204,000 frames and an **816,044-byte** PCM16 stereo WAV;
200 outputs total **163,208,800 bytes**. The Worker reported one engine and a fixed
**131,072-byte** WASM memory at every snapshot, with no growth across jobs. The
non-cryptographic 32-bit output checksum was stable (`02b3d4af`) across all 200
files. Total batch time was **16,091.8 ms** (**12.43 exports/s**, **52.82×** audio
real time). Per-export core render p50/p95/max: **69.5 / 82.5 / 122.8 ms**; WAV
encode: **7.8 / 9.2 / 15.6 ms**; end-to-end Worker export: **78.2 / 92.2 / 140.9 ms**.

Decoded first-export output differed from the scalar-reference PCM by at most
**1.5273690223693848e-5**, within the declared PCM16 tolerance
`1/32767 + 1e-7 = 3.0618509475997195e-5`, with zero non-finite samples. **18 PCM16
samples differ from reference quantization; the WAV bytes/hash are not bit-exact**
(reference hash `aee78fca`, Worker hash `02b3d4af`). The difference is within one
16-bit quantization step; repeat outputs are mutually stable. Do not describe the
WAV as bit-exact. Cancellation at **2,048/204,000 frames** was acknowledged; a
subsequent full export in the same Worker succeeded with the same fixed WASM memory
and passed the same numerical tolerance. Browser `performance.memory` used-heap
was 23.1 MB before/after (total heap 26 MB); this is the **renderer** heap, not a
measurement of Worker JS heap or total process RSS. Explicit Worker/engine/memory
counters are the basis for the fixed-WASM-memory claim.

The performance figures are from one hosted-style Linux sandbox with fake output,
not repeated physical-device trials. Older PR #205 CI checks are on separate head
`ed0a79217cb455d87704b1c6ff02ee68687b81a5` and do not contain this fixture, Worker,
or Worklet.

### What remains before any physical Windows-laptop test

First build a project fixture from an actual saved Apex project and map its real
track/instrument/effect/automation semantics into the isolated prototype; compare
live and offline outputs and retain a production-equivalent reference. Then execute
the exact candidate in installed Windows Chrome and Edge and in Electron 43.4.1,
unpackaged and asar-packaged, under the separately reviewed CSP test policy. For the
hardware run, record laptop model/CPU/RAM, Windows and browser/Electron versions,
physical audio device/backend (including production WaveOut setting), supported
track/voice load `N_target`, sample rate and buffer size. Capture loopback audio,
underrun/xrun counters and p99 DSP time for three 30-minute `N_target` runs and one
10-minute 1.5× stress run at 48 kHz / 128 frames. The agreed target gate is zero
audible gaps/underruns/frame discontinuities/crashes, p99 DSP below 50% of the
2.667 ms quantum and no block at/over one quantum; stress must not crash or grow
memory unboundedly. This entire hardware step is **NOT RUN**.

### Decision

**REVISE. Do not integrate into production and do not start Phase 1.** The synthetic
prototype supports a four-track shared live engine and repeated Worker exports for
its limited fixture; it does not resolve actual Apex project semantics, browser and
Electron validation, production CSP approval, or physical audio health. The exact
next decision is only whether to fund one more isolated prototype using a real saved
Apex project and production-equivalent graph, followed by the Chrome/Edge/Electron
and representative-laptop gates above. If those gates cannot be met, reject this
architecture rather than treating the synthetic fixture or passing Chromium tests
as approval.
