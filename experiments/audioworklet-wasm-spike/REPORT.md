# Pre-Phase 1 spike report — shared AudioWorklet + WebAssembly DSP

**Status:** pre-Phase 1 spike remains stopped. The Audio Spike workflow ran on PR #205
(commit `f122952e78968c0c874ddaa92daa8b00d910ec04`) and its Linux Chromium,
Windows Chrome/Edge, and Windows Electron unpackaged/packaged jobs all completed
successfully (run #38051170797). This corrects the stale “Windows NOT RUN” statements
below. **The run's log archive and uploaded artifact payloads could not be retrieved
from this workspace**: GitHub's log/artifact endpoints redirected to external result
storage and the downloads returned EOF. I verified the Actions job steps, outcomes,
artifact names/digests, workflow and harness source, but cannot truthfully quote the
per-run capacity counts or packaged CSP observations. In particular, job success is
not evidence that all 400 WASM allocations succeeded or that the strict CSP blocked
WASM; see §§5, 6d, 8.3.

The Windows browser suite ran its default 16-instance/20-second live test and a
separate `instance-capacity` characterization (up to 400 worklet processors, then a
second round after disposal). **128- and 256-instance sustained Windows runs were
NOT RUN.** Whether the Windows characterization hit the prior Linux Chromium
~125-memory failure is **NOT CONFIRMED** because its JSON artifact was unavailable.
The packaged Electron workflow likewise ran a characterization against a spike-only
asar app, but its `file://` CSP observations are **NOT VERIFIED** here.

An isolated, Node-only single-engine prototype now allocates 256 independent filter
slots in one 64 KiB WASM memory, produces bit-exact output, and reaches/reuses its
512-slot table. It is not wired into an AudioWorklet and is not target-platform proof.
The unexplained per-instance allocation failure remains unresolved.
**Recommendation: REVISE**; no production files or security settings were changed.

Date: 2026-10-10 · Original PR head: `arena/96cb2a8b-apex-studio` · PR #205

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

The original PR #205 adds the isolated harness under
`experiments/audioworklet-wasm-spike/` and activates
`.github/workflows/audio-spike.yml`. This follow-up's changes are confined to the
experiment directory; it does not edit that workflow or production files.

The follow-up adds `dsp/shared_engine.wat`,
`tests/node/shared-engine.test.mjs`, a focused `test:shared-engine` script, and an
isolation assertion that the spike Electron runner's CSP directives match the
production `electron.cjs` policy. The original prototype files remain as listed in
[`README.md`](./README.md).

No changes to production `src/`, root `package.json`/lockfile, `electron.cjs`,
`vite.config.ts`, `tsconfig.json`, `index.html`, or production CSP. The workflow's
CI tests independently assert that the production build contains no spike code.
Note: because root `tsconfig.json` has no `include` and `allowJs: true`,
`tsc --noEmit` lists the spike's JS files. With `checkJs` off they are not
type-checked; `npm run lint` still passes.

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
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chromium   # or chrome / msedge
node electron/run-electron.mjs                     # Electron unpackaged (Windows CI ran all 3 CSP modes)
node electron/stage-electron-app.mjs && node ../../node_modules/electron-builder/cli.js --win --x64 --dir --publish never --projectDir results/electron-app && node electron/run-electron.mjs --packaged   # Windows CI ran this spike-only asar app
```

This follow-up reran the repository checks listed in §12. Root Playwright (`npx
playwright test`) was **NOT RUN in this follow-up**; its browser suite was not part of
these local reruns. The earlier report recorded the existing Playwright suite at
11/11, and the active Audio Spike workflow separately ran its 11-case Chromium,
Chrome and Edge projects.

---

## 5. Platforms and versions

| Platform | Status | Details |
|---|---|---|
| Node.js, current follow-up | **RAN — 21 passed** | Node v22.22.3, Linux x86-64. Includes 2 new single-engine tests and exact CSP-copy isolation check; `check:wasm` also passed. |
| Chromium 153, headless Linux sandbox (prior local run) | **RAN — 11 passed** | Earlier local run, not the Windows CI run. At default 16 instances; separate prior 128/256 sustained trials failed at instance #125 (§7, §8.3). Chromium 153.0.8010.0 / Playwright 1.63.0, 2 vCPU / 3 GB VM, no physical audio device. |
| Bundled Chromium, Linux CI, run #38051170797 | **RAN — job SUCCESS** | The workflow completed build, `check:wasm`, Node tests and the 11-test Chromium project; results uploaded as `spike-results-linux`. Per-run JSON measurements are not available in this workspace. |
| **Google Chrome stable — Windows CI** | **RAN — job SUCCESS** | Headed installed Chrome (`SPIKE_HEADED=1`), 11 Playwright cases; default `sustained-live` is 16 instances × 20 s. `instance-capacity` separately attempts up to 400 worklet processors twice, with a 2 s gap after disposing round one. Browser version and measured counts are not verifiable without the artifact. |
| **Microsoft Edge stable — Windows CI** | **RAN — job SUCCESS** | Same 11 cases and defaults as Chrome, in its own Playwright project. Browser version and measured counts are not verifiable without the artifact. |
| **Electron 43.4.1 — Windows, unpackaged** | **RAN — job SUCCESS** | Spike runner on `file://`, modes `none`, `production`, `production-wasm`; see exact scope below. Per-mode JSON is not available here. |
| **Electron 43.4.1 — Windows, packaged** | **RAN — job SUCCESS** | Spike-only app staged and packaged with `asar` (`electron-builder --win --x64 --dir`), then run in the three modes above. This is not the production Apex Studio package. `file://` CSP observations are not verifiable without the artifact. |
| Representative mid-range Windows laptop / physical audio device | **NOT RUN** | CI VMs are not the target laptop. Follow README “Local benchmark”. |
| Production CI on PR #205 at `f122952e78968c0c874ddaa92daa8b00d910ec04` | **RAN — PASS** | `verify`, `audio-tests`, `windows-package`, and the three Audio Spike jobs all SUCCESS. |

### What run #38051170797 actually exercised

The run was triggered by `pull_request` on PR #205, head `f122952e78968c0c874ddaa92daa8b00d910ec04`; the Linux, Windows-browser and Windows-Electron jobs all completed successfully. The Windows Playwright spec defines 9 `csp-none` cases—capabilities; direct WASM parity; offline AudioWorklet parity; live lifecycle; failure handling/isolation; kernel benchmark; 30 s offline throughput; 16 × 20 s sustained live; and `instance-capacity`—plus 2 CSP cases (strict policy blocks compilation; test-only `wasm-unsafe-eval` allows compilation and offline worklet parity). Playwright runs each test in a fresh page, serially, without retries. Therefore a green browser job establishes that these assertions passed; it does not provide a physical-device benchmark.

Important distinction: the Windows browser job did **not** run the sustained-live case at 128 or 256 instances. Its separate `instance-capacity` case attempts sequential worklet-node creation up to 400, disposes created handles, waits 2 s, then repeats. Its assertion is only that characterization completes without crashing; allocation failure is recorded as data and does not fail the job. Thus a green job does not establish that the 400 limit was reached, or where it failed. The actual first/second-round counts are in the JSON artifact, which I could not retrieve. **Whether Windows reproduces the Linux ~125 allocation failure is NOT CONFIRMED.**

Each unpackaged and packaged Electron runner invocation uses the same `file://` harness and three modes:

* `none`: all 9 default harness tests (including `instance-capacity`), with default 16-instance / 20 s sustained load.
* `production`: `capabilities` plus `cspProbe`, using the copied production policy. The runner's pass criterion is only that a probe exists and the renderer did not crash; it records, but does not assert, whether CSP is enforced or WASM is blocked.
* `production-wasm`: `cspProbe` plus offline AudioWorklet parity using a **test-only** policy with `'wasm-unsafe-eval'`; it requires WASM in the worklet and parity to pass. This does not alter production settings.

The packaged artifact is a spike-only asar app, not the actual Apex Studio executable; the runner copies the production switches, sandbox/webPreferences, header hook and CSP string. CI job success proves its runner criteria passed, but **does not prove the production CSP blocked WASM on packaged `file://`**. The `headerHook.fileUrlCalls`, `cspActive`, `mainThreadWasm`, `workletWasm`, and policy-violation values needed to answer that are in the inaccessible packaged JSON.

### Log and artifact access

I verified run/job metadata, all workflow steps and their conclusions through GitHub's API, and the artifact names, sizes and SHA-256 digests. `gh run view --log` and `gh run download 38051170797` both failed with EOF after GitHub redirected to external Actions result storage, so the uploaded JSON contents were **not inspected**:

| Artifact | Size | SHA-256 |
|---|---:|---|
| `spike-results-linux` | 151,209 bytes | `719085c89bd68af4b8738170a4785ff5034136d272949de5be979662f0f5bc74` |
| `spike-results-windows-browsers` | 162,902 bytes | `d2ceae244791f5eee0ef7c0f60870ba08118278e3dfce62d6193bfbb554bebc4` |
| `spike-results-windows-electron` | 17,414 bytes | `2ec10dcaf0c8ee0e8140705cd348d8d97995530c6e32f746f95c842282eb632a` |

The missing payload is why this report does not claim specific Windows capacity counts, browser versions, or actual packaged CSP enforcement. The activated workflow is `.github/workflows/audio-spike.yml`; it is no longer parked.

---

## 6. Test results (local Chromium 153 unless stated)

### 6a. Numerical parity (says nothing about real time)

| Test | Result | Measured |
|---|---|---|
| WASM in Node vs JS reference | PASS | max \|diff\| **0** both channels; 0/96 000 samples differ; SHA-256 = golden |
| WASM on browser main thread vs reference | PASS | max \|diff\| **0**; SHA-256 = golden |
| WASM **inside AudioWorklet**, rendered by `OfflineAudioContext` | PASS | max \|diff\| **0**; SHA-256 = golden `ef56f2bf…5eb1` |
| Block-size independence (37 / 128 / 4096 frames) | PASS | identical hashes |
| Committed `.wasm` reproducible from `.wat` | PASS (Linux + Windows CI `check:wasm` step) | 681 B, sha256 `3ce00d84…7f8f`; Windows check step SUCCESS in run #38051170797 |

Tolerance: max \|diff\| ≤ **1e-6** (about −120 dBFS). Observed: **bit-exact**
(difference 0), as designed (same IEEE-754 f64 operations, one f32 rounding).

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
| Production suites (`test:audio` 1643/1643, `test:history` 699/699, `lint`, `verify:desktop`, `build`, existing Playwright 11/11) | PASS locally and in PR CI |
| Production `dist/` contains no spike code | PASS (isolation test) |

### 6d. CSP behavior in local Chromium over HTTP (not packaged Electron)

| Policy | Main-thread WASM | Worklet WASM | Page |
|---|---|---|---|
| None (web build) | allowed | allowed | OK |
| **Exact `electron.cjs` CSP** (`script-src 'self'`) | **BLOCKED** (CompileError, `wasm-eval` violation) | **BLOCKED** | OK, reported as `wasm-init` |
| Same plus `'wasm-unsafe-eval'` | allowed | allowed (bit-exact parity) | OK; `eval` still blocked |

These are the earlier local Chromium HTTP results. They do not determine how
Electron's `onHeadersReceived` handles packaged `file://` pages.

### Packaged Electron `file://` CSP (Windows CI characterization)

The Windows job did run both unpackaged and packaged spike apps through the strict
production policy and the test-only `production-wasm` policy. The packaged runner
records `headerHook.fileUrlCalls`, CSP enforcement (`cspActive`), main-thread and
worklet WASM outcomes, and violation details. The per-run JSON could not be fetched
(§5), and the strict-CSP mode only asserts that the probe ran—not that blocking
occurred. Therefore actual packaged strict-CSP enforcement is **NOT VERIFIED** by
the evidence available in this workspace. The packaged job is not a test of the
production Apex Studio executable, and no production CSP setting was changed.

---

## 7. Performance (measurements, kept separate from correctness)

The table below is from the earlier local Chromium run, not from run #38051170797;
the Windows/Linux CI result JSON could not be fetched (§5). At 48 kHz, a 128-frame
render quantum is **2.667 ms**. Dev sandbox VM, fake audio output: indicative only,
**not** the agreed Windows-laptop baseline.

| Measurement | Result |
|---|---|
| Kernel on the audio thread (20 000 stereo blocks) | **1.1 µs per stereo block = 0.04% of budget** (~4.3 ns/sample) |
| Main thread: WASM vs JS reference | 0.98 µs vs 2.44 µs per stereo block (JS figure includes allocation) |
| Offline throughput, 16 instances, 30 s of audio | worklet 36× real time vs native Gain + Biquad 67× (graph and copy overhead) |
| Sustained live, 16 instances × 20 s | total worklet DSP **1.53% of quantum**; worst block 1 ms; **0 overruns; 0 detected dropouts** (max lag 11.3 ms); 7501/7500 blocks; browser `playbackStats.underrunEvents` **0** |
| Sustained live, 30 s sweep | 16 inst: PASS (1.6%); 64 inst: PASS (6.1%, worst block 2 ms); **128 inst: FAIL** and **256 inst: FAIL**, because instance index **#125** (the 126th) failed to initialise (§8.3), so neither load was ever reached. In the "256" run (125 live instances) there were also 3 over-budget blocks (worst 10 ms) and 0 dropouts. That was a single run on a noisy 2-vCPU VM, so it is inconclusive |

The CPU budget used by the harness: total worklet DSP ≤ 50% of the quantum at the
defined load (16 stereo instances), with 0 over-budget blocks and 0 detected dropouts.

---

## 8. Limitations discovered

1. **CSP / packaged behavior.** In the earlier local Chromium HTTP test, the exact
   production policy (`script-src 'self'`) blocked main-thread and worklet WASM;
   adding `'wasm-unsafe-eval'` in a test-only policy allowed it while `eval` stayed
   blocked. That does **not** establish whether Electron's `onHeadersReceived`
   enforces the policy on a packaged `file://` response. The Windows packaged
   characterization ran, but its JSON values were not retrievable (§5), and its
   strict-mode runner passes when the probe runs even if WASM is allowed. Actual
   packaged strict-CSP enforcement is **NOT VERIFIED**. No production CSP change
   was made or recommended without owner security review.
2. **Timing / browser capability details.** `performance.now()` is not exposed in
   `AudioWorkletGlobalScope` in the earlier Chromium 153 run, so per-block timing
   fell back to `Date.now()` at 1 ms resolution. `AudioContext.playbackStats` is
   probed when present. The Windows jobs did run the capability checks, but exact
   browser/Electron versions and API values are in the inaccessible artifacts;
   stable Chrome, Edge and Electron API availability is therefore **NOT VERIFIED**.
3. **Repeatable initialisation failure at instance index #125 (UNRESOLVED).** In
   the earlier local Chromium 153 test, one WASM instance per AudioWorkletNode
   repeatedly failed at index #125 (the 126th) with
   `RangeError: WebAssembly.Instance(): Out of memory: Cannot allocate Wasm memory
   for new instance`. The failure was reported as `wasm-init`; the page did not
   crash and already-running processors continued.

   Evidence gathered in the earlier local Chromium 153 run (headless Linux, 2 vCPU /
   3 GB VM):

   | Observation | Result |
   |---|---|
   | 128- and 256-instance sustained runs | failed at index #125, every time; neither target count was reached |
   | `instanceCapacity`: 3 separate runs, default flags | 125, 124, 125 created, then the same RangeError |
   | After disposing all and waiting 2 s (no forced GC) | 0 new instances could be created |
   | Main thread, no worklet | also stopped at 125 with the same RangeError |
   | Audio thread after main thread used that budget | 0 instances creatable |
   | Chromium with `--js-flags=--no-wasm-trap-handler` (2 runs) | still 124; no change |
| Node 22 (V8, not Chromium), same module | prior local run: 12,986 before failure; this follow-up: 512/512 created, no failure |
| Process limits | `ulimit -v` unlimited; each instance defines one 64 KiB memory |
   | Windows Chrome/Edge capacity characterization | suite ran; actual first/second-round counts unavailable in artifact; reproduction **NOT CONFIRMED** |
   | Windows 128/256 sustained runs | **NOT RUN** (CI sustained test uses default 16) |

   **What the Linux evidence supports:** this module hit a repeatable limit of about
   124–125 live WASM memories in that specific Chromium renderer/test environment;
   the main-thread and worklet observations suggested a shared budget. Disposal did
   not promptly make more slots available without forced GC. It does not identify
   the mechanism or establish behavior on other Chromium builds or Windows.

   **Mechanism remains unconfirmed.** The earlier V8 sandbox / per-memory
   reservation hypothesis was not confirmed: disabling the trap handler did not
   raise the count. The flag may not affect the relevant allocation path, or the
   cause may differ. There is no source-level or Windows evidence here that resolves
   it. A successful Windows job alone cannot answer this: `instanceCapacity` records
   allocation failures but deliberately passes if it completes without crashing.

   **Isolated single-engine slot-table follow-up (Node only):**
   `dsp/shared_engine.wat` keeps 512 logical gain/biquad slots—per-slot parameters
   and two-channel filter state—in one fixed 64 KiB linear memory. The focused test
   creates exactly one `WebAssembly.Instance`, allocates and processes 256
   independent slots across two channels and two 128-frame blocks, and compares
   every output sample bit-for-bit with the JS reference. A second test fills all
   512 slots, confirms the 513th is rejected by the table, destroys/reuses slots,
   and confirms the memory buffer never grows or changes. Both tests pass in Node
   v22.22.3. This demonstrates the *slot-table data layout* can avoid per-node WASM
   instances; it does not reproduce the browser limit, and it is not yet integrated
   into an AudioWorklet or tested in Chrome, Edge, Electron, or on Windows hardware.

   **Design consequence / next proof:** a DAW should not create one WASM instance
   per effect, voice or node. A fixed, small number of WASM engines per audio thread
   with preallocated DSP slots is a plausible revision, but the browser/audio-thread
   version must prove slot lifecycle, graph routing, parameter updates, parity,
   real-time headroom, and behavior at 128/256 logical units before this risk is
   considered resolved. First retrieve the Windows capacity/CSP JSON or rerun with
   those values exposed, then run dedicated sustained 128/256 Windows tests and the
   engine-slot worklet proof; investigate V8/Chromium internals without assuming a
   guard-region cause.
4. `.wasm` fetch behavior was recorded by the Electron `capabilities` probe on
   `file://`, but the value is unavailable with the artifact. The harness embeds
   bytes and does not depend on `fetch()` for loading.
5. The packaged spike app's `none` and `production-wasm` modes exercised worklet
   module loading and offline parity from `file://` inside its asar; green job status
   means the runner's pass criteria succeeded. This is evidence for the spike app,
   not the actual production executable. Strict production-CSP behavior remains
   **NOT VERIFIED** as in item 1. An `app://` fallback is only needed if a future
   production implementation demonstrates a file loading failure.
6. Production forces `force-wave-audio` (WaveOut) on Windows. Its latency and
   dropout behavior with AudioWorklet remain unmeasured on a representative device;
   the spike runner keeps the switch for CI.
7. The prior Linux CI/local environment used software/fake audio output. The Windows
   workflow queried CPU, sound-device and AudioSrv metadata, but the values are not
   available here. No CI result replaces the representative Windows laptop/device
   benchmark.

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

**Why not PROCEED:**

* Windows Chrome, Edge and Electron **did run** on CI (§5), but their per-run
  capacity and packaged-CSP observations could not be read from the uploaded
  artifacts. In particular, no 128/256 sustained Windows test ran, and a green
  `instance-capacity` characterization is not a pass at a particular allocation
  count.
* The #125 failure is repeatable in the prior Linux Chromium test, its mechanism is
  unconfirmed, and the Windows reproduction status is **NOT CONFIRMED** (§8.3).
  The single-engine slot-table prototype is a Node-only proof, not an AudioWorklet
  integration or real-time test.
* Local Chromium over HTTP confirmed that the exact strict policy blocks WASM, but
  actual strict-CSP enforcement on packaged Electron `file://` is **NOT VERIFIED**.
  No production CSP change is justified by these results.
* The agreed representative Windows laptop / physical audio device benchmark is
  **NOT RUN**.

**Why not REJECT:** the original prototype passed its modest-load Linux tests, and
run #38051170797's Linux, Windows-browser, and Windows-Electron jobs all completed
successfully. The spike shows the basic AudioWorklet/WASM path can be exercised on
the tested CI configurations; the new Node prototype shows 256 independent DSP
slots can share one fixed WASM engine while remaining bit-exact to the reference.
Those findings support another isolated proof, not a production migration.

**Revisions required before any production decision:**

0. Retrieve the Windows/Linux result JSON (or re-run with its key values included in
   the job summary) to establish browser versions, capacity counts and actual
   packaged `file://` CSP behavior. Do not infer these from the green job alone.
1. Run explicit sustained 128/256 load tests in Windows Chrome, Edge and Electron;
   the current CI sustained test is only 16 × 20 s.
2. Integrate the slot-table engine into a **spike-only AudioWorklet**, then prove
   lifecycle, routing, parameter updates, parity, 128/256 logical-slot behavior and
   real-time headroom in Chromium, Chrome, Edge, Electron (packaged and unpackaged),
   followed by the representative laptop test.
3. Keep production CSP unchanged until a packaged-production-policy finding is
   available and the owner makes a security decision. `'wasm-unsafe-eval'` was used
   only in the spike's test mode.
4. Choose and licence-review a production WASM toolchain.

## 11. Remaining risks before migrating any production DSP

* The earlier local Chromium renderer hit ~124–125 live WASM memories; cause,
  Windows reproduction and reclamation behavior on target builds remain unknown.
* Windows CI executed browser/Electron suites, but the measured capacity and CSP
  values are unavailable. Windows sustained 128/256 and the target laptop are
  **NOT RUN**; actual packaged strict-CSP enforcement is **NOT VERIFIED**.
* The new 256/512-slot engine is tested only as WAT from Node. AudioWorklet
  integration, graph routing, AudioParams/message updates, memory contention,
  deadline behavior and browser/Windows compatibility are **NOT RUN**.
* Real-device latency/dropouts (especially WaveOut via `force-wave-audio`) on a
  mid-range laptop are unmeasured.
* Main-thread jank, GC, and tab/window backgrounding effects on a large DSP engine
  are not exercised beyond the existing 16 ms ticker.
* Parameter automation, denormal behavior in more complex DSP, and memory growth
  are not exercised by this kernel.
* Determinism here relies on avoiding transcendental functions and FMA. DSP using
  `sin`, `exp` or SIMD will need explicit tolerances, not hash equality.
* Migrating native-node DSP changes sound. Every migrated effect needs A/B
  listening and numerical comparison against the current engine, behind a flag,
  with the native path kept as a fallback.
* All processors in an AudioContext share an audio rendering thread; headroom must
  be measured on target hardware before setting real slot counts.

---

## 12. Follow-up regression checks

| Check | Result |
|---|---|
| `npm run test:node` (spike directory) | **PASS — 21/21**; includes existing WASM/mock/isolation tests, exact production-CSP-copy assertion, and both shared-engine tests |
| `npm run test:shared-engine` (spike directory) | **PASS — 2/2**; 256-slot bit-exact processing and fixed 512-slot allocation/reuse |
| `npm run check:wasm` (spike directory) | **PASS**; original 681-byte kernel reproducible, SHA-256 `3ce00d847b02903ff6ef16126a8ce94d2bbe413354ab003da615ccf36be67f8f` |
| Root `npm run verify:desktop` | **PASS** |
| Root `npm run lint` | **PASS** (`tsc --noEmit`) |
| Root `npm run test:audio` | **PASS — 1643/1643** |
| Root `npm run test:history` | **PASS — 699/699** |
| Root `npm run build` | **PASS**; Vite transformed 1,823 modules; emitted the existing >500 kB chunk warning |
| Root Playwright suite | **NOT RUN in this follow-up**; separate from the successful Audio Spike CI browser jobs |
| Node control: original WASM module instances | **512/512 created** on Node v22.22.3; confirms the prior ~125 count was not reproduced in this Node control, but does not identify Chromium's limit |

The last successful CI run remains #38051170797 on PR head
`f122952e78968c0c874ddaa92daa8b00d910ec04`. It predates this follow-up's local
single-engine prototype and report edits; no new Audio Spike CI result is claimed for
them.
