# Pre-Phase 1 spike report — shared AudioWorklet + WebAssembly DSP

**Status (follow-up revision):** spike stopped with the evidence available.
The owner activated the spike CI workflow (`7d2600c`). **Windows Chrome, Windows Edge
and Windows Electron (unpackaged and packaged) have now RUN on GitHub `windows-latest`
CI, and every step passed in 2 runs** (§5). Those runs cover the *original* spike
suite. I could not retrieve their detailed numbers from this sandbox. CI VMs are not
the laptop baseline. **No cross-platform validation of the follow-up findings is
claimed**: everything in §12 is local Linux Chromium 153 unless §12.5 says otherwise.

* The instance-#125 failure is now **explained**. Every `WebAssembly.Memory` reserves a
  fixed 8 GiB of address space inside V8's 1 TiB per-process sandbox, so a renderer
  can hold about 125 live WASM memories (§8.3, §12.1). This is confirmed by minimal
  reproduction and matches V8 source constants.
* A **single-engine layout** (one WASM memory per audio thread, many units in a slot
  table) **removes the live initialisation failure in tests**: 16–512 units
  initialised in 3 of 3 runs with one memory (§12.3). Bit-exact parity is preserved.
* **New blocker, not fixed by the engine layout:** each `OfflineAudioContext` keeps
  its worklet's WASM memory until the page is reloaded. After about 124 offline
  renders in one document, *no* WebAssembly can be created anywhere in that page
  (§12.2).
* **CSP:** the exact requirement is `'wasm-unsafe-eval'` in `script-src` (§12.4). The
  production CSP was not changed.

**Recommendation: REVISE** (§10).

Date: 2026-10-10 · Branch `arena/96cb2a8b-apex-studio` · Draft PR #205

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

Production regression commands run (repo root): `npm run verify:desktop`, `npm run lint`,
`npm run test:audio`, `npm run test:history`, `npm run build`, `npx playwright test`.

---

## 5. Platforms and versions

| Platform | Status | Details |
|---|---|---|
| Node.js (WASM numerics, mocked-scope processor, isolation) | **RAN locally — 18 passed** (original run); follow-up run **26 passed, 0 skipped** (the 18 original + 5 engine + 3 investigation) | Node v22.22.3, Linux x86-64 sandbox |
| Chromium, headless, Linux (dev sandbox) | **RAN locally — 11 passed** (original `spike.spec.mjs`, at the default 16-instance load; the 128-instance sweep FAILED, §7 and §8.3). Follow-up run: **50 passed** (the same 11 + 39 in `investigation.spec.mjs`), plus 2 extra repeats of the 15 design-comparison tests (30 passed) | Chromium 153.0.8010.0 (from the `@sparticuz/chromium` 153.0.0 npm build, installed in `/tmp` and not added to the repo), Playwright 1.63.0, 2 vCPU / 3 GB VM, kernel 6.1, no audio hardware (Chromium fake audio output) |
| **Google Chrome — Windows** (installed stable, headed, `windows-latest`) | **RAN in CI — step PASSED, 2 runs** (`38051166108` on `7d2600c`, `38051170797` on `f122952`), original 11-test `spike.spec.mjs` | Step took 40 s. Pass implies all 11 tests passed: Playwright exits non-zero on any failure, on "no tests found" or on a missing channel, with 0 retries. Browser version and numbers **not retrieved** (see below) |
| **Microsoft Edge — Windows** (same) | **RAN in CI — step PASSED, 2 runs** (same runs) | Step took 38 s. Same caveats |
| **Electron 43.4.1 — Windows, unpackaged** | **RAN in CI — step PASSED, 2 runs** | Pass implies: `csp=none` full default suite passed; `csp=production-wasm` CSP probe + worklet parity passed; `csp=production` is **characterisation only** (passes whenever the probe runs), so **whether the production CSP is enforced over `file://` is still unknown to me** |
| **Electron 43.4.1 — Windows, packaged (asar)** | **RAN in CI — step PASSED, 2 runs** | Same criteria as unpackaged, with the app packaged by electron-builder `--dir` (asar) |
| Bundled Chromium on Linux CI | **RAN in CI — step PASSED, 2 runs** | — |
| Representative mid-range Windows laptop | **NOT RUN** | No access. Instructions in README "Local benchmark" |
| Existing production CI on PR #205 | **RAN — PASS** | `verify` (CI), `audio-tests` (Audio Validation), `windows-package` (Windows build + package + packaged smoke) |

**How Windows came to run:** the sandbox's GitHub App cannot push to
`.github/workflows/`; three pushes were rejected for lack of the `workflows`
permission. The workflow was therefore parked at `ci/audio-spike.yml`. The owner
moved it into place with the GitHub web UI: commit `7d2600c` "Activate isolated
audio spike CI" and `f122952` "Remove parked copy …". This follow-up does **not**
modify the workflow, because the app still cannot push workflow changes.

**What I could and could not read:** job and step status and timing, and check-run
annotations, are readable through `api.github.com`. **Artifacts and job logs are
not**: both redirect to `*.blob.core.windows.net`, which this sandbox cannot reach.
So I can state *that* the steps passed and *which* assertions that implies. I can't
state browser versions, the Windows `instance-capacity` count, performance figures,
or whether the packaged CSP is enforced. Those are in the run's **Summary** page and
artifacts on GitHub (Actions → "Audio Spike (AudioWorklet + WASM, experimental)" →
run → Summary). To make key numbers readable without artifacts, the follow-up's
`investigation.spec.mjs` emits compact `::notice` annotations in CI (§12.5).

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
| Production suites (`test:audio` 1643/1643, `test:history` 699/699, `lint`, `verify:desktop`, `build`, existing Playwright 11/11) | PASS locally and in PR CI |
| Production `dist/` contains no spike code | PASS (isolation test) |

### 6d. CSP (Electron production policy, served over HTTP in Chromium)

| Policy | Main-thread WASM | Worklet WASM | Page |
|---|---|---|---|
| None (web build) | allowed | allowed | OK |
| **Exact `electron.cjs` CSP** (`script-src 'self'`) | **BLOCKED** (CompileError, `wasm-eval` violation) | **BLOCKED** | OK, reported as `wasm-init` |
| Same plus `'wasm-unsafe-eval'` | allowed | allowed (bit-exact parity) | OK; `eval` still blocked |

The full follow-up matrix (7 policies × main thread, worklet, engine worklet and
dedicated Worker) is in §12.4. Whether the packaged app enforces this CSP over
`file://` today is **NOT RUN**. Electron's own documentation says header-delivered
CSP cannot be used for `file://` (§12.4). The Electron runner records it
(`headerHook.fileUrlCalls`).

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

1. **The production Electron CSP blocks WebAssembly** on the main thread and in
   worklets. Shipping WASM DSP in the desktop app requires adding `'wasm-unsafe-eval'`
   to `script-src`. That is a security-policy decision for the owner. It does not
   re-enable `eval` (verified).
2. **`performance.now()` is not exposed in `AudioWorkletGlobalScope`** (Chromium 153).
   Per-block timing falls back to `Date.now()` at 1 ms resolution. Means over
   thousands of blocks are statistically sound, but single-block overrun detection
   is coarse. Chromium's `AudioContext.playbackStats` (exposed in 153) provides an
   independent underrun counter. Availability in stable Chrome, Edge and Electron 43
   is NOT RUN.
3. **Initialisation failure at instance index #125: cause identified (follow-up, §12.1).**
   With one WASM instance per AudioWorkletNode, instance index #125 (the 126th)
   fails every time with `RangeError: WebAssembly.Instance(): Out of memory: Cannot
   allocate Wasm memory for new instance`. It is reported cleanly as `wasm-init`;
   the page does not crash and running instances keep processing.

   **Confirmed by execution (local Chromium 153):**

   * The limit is on **live `WebAssembly.Memory` objects per renderer process**
     (124–125). It is **not** on instances, modules, AudioWorklet, the kernel or the
     host code. It reproduces on the main thread with `new WebAssembly.Memory({initial: 1})`
     and no audio at all.
   * 1000 memory-less instances, or 1000 instances importing **one** shared memory,
     succeed. The declared `maximum` and the `shared` flag make no difference.
     **memory64 memories cap at 61–62, about half.** Physical memory is not the
     constraint: resident memory grows about 4–5 MB for 125 memories, and the
     renderer's virtual size stays constant at about 1.48 TB.
   * The main thread and the audio thread share the budget.
   * `--js-flags` reach V8 (verified with the `--expose-gc` canary).
     `--wasm-enforce-bounds-checks` does **not** change the cap.

   **Confirmed by V8 source (documentation, V8 HEAD `a74948bb81a5`):**
   `GetWasmReservationSize()` reserves `kFullGuardSize32` = **8 GiB** per wasm32
   memory with guard regions (16 GiB for memory64). With the V8 sandbox these
   reservations come from the process-wide sandbox, `kSandboxSizeLog2 = 40` →
   **1 TiB** on desktop x64 (Linux and Windows branch). 1 TiB / 8 GiB = 128 and
   1 TiB / 16 GiB = 64, matching the measured 125 and 61. V8 HEAD is not
   necessarily identical to Chromium 153's V8, but the measured 2:1 ratio
   independently supports it.

   **Corrections to the previous revision of this report:**

   * The `--js-flags=--no-wasm-trap-handler` experiment was **invalid**. That flag
     does not exist in this Chromium build: `strings` finds no `wasm_trap_handler`
     flag, and V8 silently ignores unknown flags. It neither confirmed nor refuted
     anything. The guard-region hypothesis was wrongly withdrawn because of it and
     is now confirmed by the evidence above.
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
   `app.asar` (packaged) **worked in Windows CI**. This is implied by the passing
   `csp=none` default suite in both modes: `parity-worklet-offline` requires
   `addModule` and WASM instantiation in the worklet to succeed, 2 runs. I did not
   see the detailed per-test output (§5).
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

This replaces the previous revision's REVISE rationale with the follow-up evidence (§12).

**Why not PROCEED:**
* **The follow-up findings are not yet validated on Windows.** The original suite
  passed on Windows Chrome, Edge and Electron (unpackaged and packaged) in CI
  (2 runs, §5). The memory-budget, offline-retention, engine and CSP-matrix results
  in §12 come from local Linux Chromium (Windows CI status: §12.5). CI VMs are also
  not the representative laptop.
* **Offline rendering with WASM in an AudioWorklet leaks one memory per
  `OfflineAudioContext` for the life of the document** (§12.2). Every layout tested,
  including both single-engine variants, stops after about 124 offline renders. After
  that, *no* WebAssembly can be created in the page, live engine included, until a
  reload. An export, bounce or freeze path built on per-render `OfflineAudioContext`
  + worklet WASM is therefore not reliable. The engine layout does not fix this.
* **One AudioWorkletNode per unit does not scale on CPU.** With 512 engine-backed
  nodes the run collapsed (72–82% of blocks rendered, about 1500 underruns) in 3 of 3
  runs. The same 512 units in **one** bank node rendered 100% (§12.3).
* The production CSP blocks WASM (exact fix known, §12.4). Whether that CSP is even
  in effect for packaged `file://` loading is NOT RUN; Electron's documentation
  suggests it may not be.

**Why not REJECT:**
* The #125 cause is understood and has a tested remedy for live playback. One
  engine per audio thread initialised 16–512 units with one memory in 3 of 3 runs,
  leaving 123–124 memories free.
* Parity holds bit-exactly through the shared engine, both standalone and with three
  units in one worklet.
* The offline problem has plausible mitigations that keep the *same WASM kernel*
  (§12.2). They are **untested** as rendering paths.

**Revisions required before Phase 1 can rely on this architecture:**
1. **Live:** adopt the engine-per-audio-thread layout with **few nodes**: a bank or
   graph inside the engine, not one AudioWorkletNode per unit.
2. **Offline:** prototype and test an export path that does not create a new
   AudioWorklet WASM memory per render. Candidates: a long-lived Worker or the main
   thread reusing one engine instance, or one shared imported memory. Then repeat
   the 200-render test.
3. **Windows:** activate the parked workflow (web-UI steps in §5). Confirm the memory
   cap (`instance-capacity` / investigation probes), the offline retention, and the
   CSP behaviour on Windows Chrome, Edge and Electron (unpackaged and packaged).
   Then run the README benchmark on the representative laptop.
4. **CSP decision** by the owner (§12.4). Also check whether the packaged CSP is
   currently enforced over `file://`.
5. Choose and licence-review a real WASM toolchain.

## 11. Remaining risks before migrating any production DSP

* Per-renderer WASM memory budget of about 125 memories (8 GiB reservation each in
  a 1 TiB sandbox), shared by every isolate in the renderer, including any
  third-party WASM such as decoders. Mechanism confirmed locally; Windows NOT RUN
  (§8.3, §12.1).
* `OfflineAudioContext` worklet scopes keep their WASM memories until document
  teardown (§12.2). Unreferenced memories in one isolate are not reclaimed by an
  allocation failure in another isolate (§12.2).
* No Windows execution evidence yet (Chrome, Edge, Electron, packaged asar, `file://` worklet loading).
* Real-device latency and dropouts (especially WaveOut via `force-wave-audio`) on a mid-range laptop are unmeasured.
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

Environment for everything in this section: local Chromium 153.0.8010.0 headless,
Linux x86-64, 2 vCPU / 3 GB VM, fake audio output, Playwright 1.63.0, Node v22.22.3.
Every case ran in a **fresh browser context**, which here means a fresh renderer
process. Codified in `tests/browser/investigation.spec.mjs`: `[must]` tests are
requirements, `[char]` tests characterise current browser behaviour. Raw JSON is
written to `results/*-investigation-*.json` (git-ignored). The summary comes from
`scripts/summarize-results.mjs`. **Windows: NOT RUN.**

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

**Confirmed:** each live wasm32 memory costs one 8 GiB reservation from a 1 TiB
per-process pool (see §8.3 for the V8 source references).
**Hypothesis, not tested:** Windows desktop Chrome, Edge and Electron behave the
same. The V8 source uses the same 1 TiB sandbox branch for Windows x64, but Electron
build flags and Windows behaviour are NOT RUN.

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

**Confirmed:**
* AudioWorklet global scopes of `OfflineAudioContext`s, and the memories inside them,
  are **retained until the document is torn down**, whether or not they rendered.
  Each offline render that instantiates WASM in its worklet permanently uses one of
  the ~125 slots for that page.
* A failed allocation only triggers GC in the **allocating** isolate. Unreferenced
  memories in another isolate keep blocking it until that isolate collects.

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

**Exact requirement (confirmed in Chromium 153):** add `'wasm-unsafe-eval'` to
**`script-src`** of the policy that governs the **document**. AudioWorklets inherit
the document's policy and ignore the worklet script's own response header. If a
dedicated Worker is used (for example offline mitigation (a)), the Worker script
response's policy also needs it. Since `electron.cjs` applies one header to every
response, a single `script-src` change covers both. Putting it in `default-src` does
nothing, because the explicit `script-src` takes precedence. `'unsafe-eval'` also
works but re-enables `eval`/`new Function`, so it is not recommended.

**Documentation, not executed:** Electron's security tutorial (electron/electron
`main` @ `04449e98`, 2026-10-10) says header-delivered CSP "is not possible to use …
when loading a resource using the `file://` protocol", and recommends a `<meta>` tag
or a custom protocol. The packaged Apex app loads `file://…/dist/index.html`, and
`index.html` has no CSP `<meta>` tag. **If the documentation is accurate, the
packaged app's production CSP may not be enforced today.** In that case WASM would
not actually be blocked, and neither would anything else the policy is meant to
block. This is a production security question outside this spike. It is NOT RUN; the
parked Electron job records `headerHook.fileUrlCalls` and `cspActive` to settle it.
No production file was changed.

### 12.5 Windows / Linux CI status of the follow-up tests

Pushing this follow-up triggers the owner-activated workflow. Its existing Playwright
steps run `investigation.spec.mjs` on Linux bundled Chromium and on Windows Chrome
and Edge. The Electron job runs the original harness only. The spec emits compact
`::notice` annotations (env, probes, flags, lifecycle, offline-renders,
engine-parity, compare, csp), readable through the check-runs API. **Status at this
commit: pending.** Results are recorded below only once they have actually run.
