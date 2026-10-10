# Pre-Phase 1 spike report — shared AudioWorklet + WebAssembly DSP

**Status (follow-up revision):** spike remains stopped before Phase 1. The original
Audio Spike run #38051170797 passed on `f122952`. A later follow-up commit
`b86d47db0995ee655339e5d6cf927ef60420fea2` added controlled allocation, lifecycle,
single-engine and CSP investigations; run #38051848530 completed successfully on
Linux and Windows CI. Its check-run annotations provide the Windows browser
measurements in §12.6. They confirm that per-node WASM allocation fails in both
Windows Chrome and Edge at 124–125 memories when 128/256 instances are attempted.

* The measured limit is per live `WebAssembly.Memory`, not per module/instance; it
  is about 125 wasm32 memories in Linux Chromium and Windows Chrome/Edge. V8 source
  points to an 8 GiB guard-region reservation from a 1 TiB sandbox (§12.1), though
  the exact deployed V8 builds differ.
* The single-engine slot layouts initialize up to 512 logical units using one
  memory and preserve bit-exact output. They remove the **allocation** failure in
  those live-playback tests, but do not resolve offline-render memory retention or
  all high-load dropouts (§12.2, §12.3, §12.6).
* The Windows browser follow-up reproduced the failure and compared 15-second
  loads. One-node-per-unit engine layout showed 393 playback underruns in Chrome at
  512 units; the single bank-node layout had 0 in that run. CI measurements are not
  target-laptop results.
* The strict CSP matrix is confirmed over HTTP; the **actual packaged Electron
  `file://` CSP result remains NOT VERIFIED** because its JSON/log payload was not
  retrievable. Electron documentation says response-header CSP cannot be used with
  `file://`; no production security setting was changed.

**Recommendation: REVISE** (§10). The representative laptop is **NOT RUN**.

Date: 2026-10-10 · PR #205 latest inspected head: `b86d47db0995ee655339e5d6cf927ef60420fea2`

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
| Node.js, follow-up suite | **RAN locally — 26 passed, 0 skipped** | Node v22.22.3, Linux x86-64: original 18 tests + 5 engine tests + 3 investigation tests |
| Chromium, headless Linux sandbox | **RAN locally — 50 passed** in the follow-up (11 original + 39 investigation); plus two repeats of the 15-cell design comparison (30 tests) | Chromium 153.0.8010.0 / Playwright 1.63.0, 2 vCPU / 3 GB VM, software/fake audio output; not the target laptop |
| Linux bundled Chromium, run #38051848530 | **RAN — job SUCCESS** | Includes the original 11-case project plus `investigation.spec.mjs`; check-run annotations expose probe, lifecycle, design-comparison and CSP results (§12.6) |
| **Google Chrome stable — Windows**, headed | **RAN — 50 tests passed in run #38051848530** | Chrome 154.0.8037.58, Windows x64. Original 11 tests + 39 investigation tests; 15 s compare at 16/64/128/256/512 units across per-node, engine-nodes and engine-bank layouts. Per-node 128/256 allocation failure reproduced (§12.6). |
| **Microsoft Edge stable — Windows**, headed | **RAN — 50 tests passed in run #38051848530** | Edge 153.0.4234.48, Windows x64. Same test matrix and defaults; per-node 128/256 allocation failure reproduced (§12.6). |
| **Electron 43.4.1 — Windows, unpackaged** | **RAN — jobs SUCCESS** in runs #38051170797 and #38051848530 | Original harness in `none`, `production`, `production-wasm` modes. Strict-CSP mode records a probe but does not assert WASM is blocked; actual `file://` values are not available. |
| **Electron 43.4.1 — Windows, packaged asar** | **RAN — jobs SUCCESS** in runs #38051170797 and #38051848530 | Spike-only app packaged with `electron-builder --win --x64 --dir`; not the actual Apex Studio executable. `csp=none` proves the harness/worklet path in the asar; strict production-CSP result is **NOT VERIFIED**. |
| Representative mid-range Windows laptop / physical device | **NOT RUN** | CI measurements are not a hardware baseline. Instructions in README “Local benchmark”. |
| PR production checks on latest inspected head `b86d47db0995ee655339e5d6cf927ef60420fea2` | **RAN — PASS** | `verify`, `audio-tests`, `windows-package`, plus Linux/Windows Audio Spike jobs in run #38051848530 |

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

The Electron job ran the spike-only app in unpackaged and asar-packaged modes with
three policies: `none`, copied production CSP, and test-only CSP with
`'wasm-unsafe-eval'`. In `production` mode the runner only requires the CSP probe to
run; it does not require main-thread/worklet WASM to be blocked. Its output JSON is
therefore needed to answer actual packaged `file://` enforcement.

### Logs, annotations and artifacts

The GitHub API exposed the browser check-run `::notice` annotations, so the Windows
versions and measurements below are available even though the full logs and artifact
ZIPs redirected to `*.blob.core.windows.net` and could not be downloaded from this
workspace. Electron emitted no equivalent result annotation, so its per-mode JSON
remains unavailable; see §12.6. Run #38051848530 uploaded:

| Artifact | Size | SHA-256 |
|---|---:|---|
| `spike-results-windows-browsers` | 246,047 bytes | `3861332a8485c504143fdbd2bf923dd6dd570ecdfd837829954320f9d8af8d99` |
| `spike-results-linux` | 213,549 bytes | `8e681655165e26c7c668e57bf948c3abd2882bf70bcdbdbdfa5758039fca509e` |
| `spike-results-windows-electron` | 17,441 bytes | `95c5d738f646c4b3fe5695034a71504162658847b67cef21faddc4c31866d553` |

The browser annotations are **measurements from hosted CI runners**, not proof of
physical-device performance. The Electron packaged CSP observation remains
**NOT VERIFIED**.

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
| *Follow-up:* 3 engine units sharing one engine **inside AudioWorklet** (`OfflineAudioContext`) | PASS | units 0 and 2 = golden; unit 1 (different params) max \|diff\| 0; bank node (1 unit) = golden; engine `.wasm` 815 B, sha256 `207b12bc…e20b`, reproducible |

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
| Root production regressions rerun against this worktree (`lint`, `verify:desktop`, `test:audio` 1643/1643, `test:history` 699/699, `build`) | PASS locally |
| Root Playwright browser suite | **NOT RUN**: attempted, but all 11 cases were blocked before launch because the Chromium headless-shell executable is absent from the sandbox (`/home/user/.cache/ms-playwright/chromium_headless_shell-1243/...`). Windows/Linux spike CI browser jobs passed in run #38051848530 (§5, §12.5–12.6). |
| Production `dist/` contains no spike code | PASS (isolation test) |

### 6d. CSP (Electron production policy, served over HTTP in Chromium)

| Policy | Main-thread WASM | Worklet WASM | Page |
|---|---|---|---|
| None (web build) | allowed | allowed | OK |
| **Exact `electron.cjs` CSP** (`script-src 'self'`) | **BLOCKED** (CompileError, `wasm-eval` violation) | **BLOCKED** | OK, reported as `wasm-init` |
| Same plus `'wasm-unsafe-eval'` | allowed | allowed (bit-exact parity) | OK; `eval` still blocked |

The full follow-up matrix (7 policies × main thread, worklet, engine worklet and
dedicated Worker) is in §12.4 and was repeated in Windows Chrome/Edge (§12.6).
Windows Electron did run the packaged `csp=production` probe, but the actual
`file://` output was not retrieved and the test is characterization-only; whether
the policy is enforced is **NOT VERIFIED**. Electron's v43.4.1 documentation says
header-delivered CSP cannot be used for `file://` (§12.4).

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

1. **The strict production policy blocks WebAssembly when it is actually applied.**
   In the HTTP Chromium matrix, the production policy blocks WASM on the main thread
   and in worklets; adding `'wasm-unsafe-eval'` to `script-src` permits WASM without
   permitting JavaScript `eval` (§12.4, §12.6). That does **not** establish that the
   packaged Electron app applies that policy: Apex loads `file://…/dist/index.html`
   and sets CSP through a response-header hook. Electron's v43.4.1 security docs say
   header CSP cannot be used for `file://`; the packaged probe's actual output was
   not retrieved. Runtime enforcement is **NOT VERIFIED**, and no production CSP
   setting was changed.
2. **`performance.now()` is not exposed in `AudioWorkletGlobalScope`** (Chromium 153).
   Per-block timing falls back to `Date.now()` at 1 ms resolution. Means over
   thousands of blocks are statistically sound, but single-block overrun detection
   is coarse. `AudioContext.playbackStats` provides an independent underrun counter:
   it was present in the Windows Chrome 154 and Edge 153 CI results. Availability in
   Electron 43 is **NOT VERIFIED**.
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
   necessarily identical to the V8 builds shipped in those browsers. Electron's
   corresponding runtime allocation probe is **NOT RUN / NOT VERIFIED**.

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
   `app.asar` (packaged spike app) **worked in the `csp=none` Windows CI suite**.
   `parity-worklet-offline` requires `addModule` and worklet WASM instantiation to
   succeed; both Electron jobs passed in runs #38051170797 and #38051848530. This
   verifies the no-CSP test path, not that the packaged production CSP is enforced.
   Detailed Electron probe output was not retrievable (§5, §12.6).
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

This recommendation incorporates run #38051848530 on `b86d47` as well as the local
and original CI evidence. **REVISE remains appropriate; do not start Phase 1.**

**Why not PROCEED:**
* **Windows confirms the allocation risk, not a complete production design.** The
  per-node 128/256 tests fail at 124–125 memories in both Windows Chrome and Edge.
  The engine layouts initialize through 512 units with one memory, but the 15-second
  comparison is not a physical-device benchmark. At 512 `engine-nodes`, Chrome
  reported 97% rendered blocks and 393 browser underruns; `engine-bank` reported
  100% and zero in that run. These measurements are runner-specific, and the green
  comparison test asserts initialization, memory use and slot release—not audio
  health (§12.6).
* **Offline rendering retains WASM memories** in local Chromium and Windows Chrome /
  Edge. Repeated offline renders exhausted the page after 7 per-node or about 124–125
  engine-node/bank renders; after exhaustion no new WASM could be created until
  document reload (§12.2, §12.6). The engine layout does not fix this. No offline
  mitigation has been prototyped or tested as a rendering path.
* **Packaged Electron CSP enforcement is unresolved.** The HTTP policy matrix
  confirms that `'wasm-unsafe-eval'` in `script-src` is needed for WASM when the
  policy is applied. The packaged runner's actual `file://` probe output is
  **NOT VERIFIED**. Electron v43.4.1 documentation says response-header CSP cannot
  be used for `file://`; do not infer enforcement or change production security
  settings from the successful CI job (§12.4, §12.6).
* Real-device latency/dropouts with the production Windows audio backend, and
  sustained audio-health performance on a representative laptop, remain **NOT RUN**.

**Why not REJECT:**
* The per-node memory-allocation ceiling now reproduces in Linux Chromium and
  Windows Chrome/Edge, and the engine-per-audio-thread prototypes avoid that live
  initialization ceiling in tested cases (one memory for 16–512 units).
* The shared engine preserves bit-exact parity in Node and AudioWorklet tests;
  Windows parity/slot-release annotations also passed.
* Worker reuse and shared-memory approaches may address offline retention, but
  those are plausible candidates only—not validated solutions.

**Revisions required before Phase 1 can rely on this architecture:**
1. **Live:** continue with a small number of worklet nodes (e.g. a bank/graph inside
   an engine), then measure audio health on target hardware. Do not use one
   AudioWorkletNode per DSP unit at large counts based on current results.
2. **Offline:** prototype a rendering path that reuses WASM memory without creating
   a worklet memory per `OfflineAudioContext` (candidate: a long-lived Worker or
   main-thread engine; shared imported memory is another candidate). Repeat the
   200-render exhaustion test. Until then, offline WASM worklet rendering is
   **NOT READY**.
3. **CSP:** determine and test actual packaged `file://` policy enforcement using
   runtime output, then make the owner’s security-policy decision. Do not relax
   production CSP as part of this spike.
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
  teardown in Linux Chromium and Windows Chrome/Edge. Cross-isolate GC/reclamation
  mechanism was directly tested only in local Chromium (§12.2, §12.6).
* Windows Chrome/Edge browser runs are available. The Electron spike-only app ran
  unpackaged and asar-packaged, but actual packaged `file://` CSP enforcement is
  **NOT VERIFIED**; the production app's CSP security posture is therefore
  unresolved (§5, §12.6).
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

## 12. Follow-up investigation (2026-10-10, same branch / PR #205)

Unless noted as Windows CI below, the experiments in §§12.1–12.4 were run locally
in Chromium 153.0.8010.0 headless on Linux x86-64 (2 vCPU / 3 GB VM, fake audio),
Playwright 1.63.0, Node v22.22.3. Each local case ran in a **fresh browser context**
(a fresh renderer process). The tests are codified in
`tests/browser/investigation.spec.mjs`: `[must]` tests are requirements and `[char]`
tests characterize current browser behavior. Raw JSON is written to git-ignored
`results/*-investigation-*.json`; summaries come from `scripts/summarize-results.mjs`.
The Windows follow-up ran in GitHub Actions run #38051848530 on
`b86d47db0995ee655339e5d6cf927ef60420fea2`; Chrome/Edge annotation results are in
§12.6. Electron's packaged CSP result is **NOT VERIFIED**.

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
reservation size remains an inference, not a runtime measurement. Electron behavior
is **NOT RUN / NOT VERIFIED**.

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

**Mitigation candidates (untested as rendering paths):**
* (a) Render export DSP in one **long-lived Worker** (or on the main thread) that
  reuses one engine instance, feeding native-node stems to it. The same WASM kernel
  keeps parity at the kernel level, but it is no longer the same AudioWorklet code path.
* (b) Import one shared `WebAssembly.Memory` into every worklet scope instead of each
  scope creating its own. This needs SharedArrayBuffer, which means cross-origin
  isolation in the browser.
* (c) Cap offline renders per document and reload, which is not acceptable UX.

The Worker evidence above (memories released on `terminate()`) supports (a) only
partly. Nothing in (a)–(c) has been prototyped.

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
are from HTTP test pages; they do not prove the packaged Electron `file://` case.

**Packaged Electron CSP: NOT VERIFIED.** Electron v43.4.1's
[security tutorial](https://github.com/electron/electron/blob/v43.4.1/docs/tutorial/security.md#csp-meta-tag)
says header-delivered CSP is “not possible” when loading a resource with `file://`,
and recommends a `<meta>` tag or custom protocol. The Apex app loads
`file://…/dist/index.html` and has no CSP `<meta>` tag. This documentation raises a
security concern, but the packaged `csp=production` probe's actual output was not
retrieved. Its CI step passing is not proof of either enforcement or non-enforcement.
The runtime state is therefore **NOT VERIFIED**; production files and CSP settings
were not changed.

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
new follow-up investigations. Full logs and artifact ZIPs from both runs redirected
to external Actions storage that this workspace could not reach. The representative
Windows laptop is **NOT RUN**, and packaged Electron CSP enforcement is **NOT
VERIFIED**.

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

#### Electron packaged CSP: runtime result unavailable

The Windows Electron jobs passed in both unpackaged and asar-packaged modes, and the
`csp=none` parity case demonstrates that the spike harness can load its worklet and
instantiate WASM in those modes. The Electron `production` mode is
characterization-only: a passing step means the probe ran, not that the policy
blocked WASM. Check-run `114212401077` has only a deprecation warning and no CSP
values; the Electron artifact ZIP contents were not retrievable. Therefore the
actual packaged `file://` results (`headerHook.fileUrlCalls`, `cspActive`, main-thread
and worklet WASM probes) are **NOT RETRIEVED / NOT VERIFIED**. Electron v43.4.1
security documentation says header-delivered CSP cannot be used for `file://` and
recommends a meta tag or custom protocol (§12.4); that is a reason to investigate,
not a measured finding that the policy is or is not enforced.

**NOT RUN / NOT VERIFIED:** representative-laptop audio-health testing; packaged
Electron runtime CSP verification with captured probe output; and the Electron
memory-cap/offline-retention investigation. No production audio code or CSP setting
was changed.
