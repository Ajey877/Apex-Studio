# Pre-Phase 1 spike report — shared AudioWorklet + WebAssembly DSP

**Status:** spike stopped with the evidence available. **Windows Chrome, Windows Edge
and Windows Electron are NOT RUN** (see §5). **No cross-platform validation is claimed.**
A **repeatable initialisation failure** was found: instance index #125 never
initialises (§8.3). **Recommendation: REVISE**, pending investigation of that failure
and Windows validation (§10).

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
`ci/audio-spike.yml` (parked workflow, see §5).

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
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chromium   # or chrome / msedge
node electron/run-electron.mjs                     # Electron unpackaged (NOT RUN here)
node electron/stage-electron-app.mjs && node ../../node_modules/electron-builder/cli.js --win --x64 --dir --publish never --projectDir results/electron-app && node electron/run-electron.mjs --packaged   # (NOT RUN here)
```

Production regression commands run (repo root): `npm run verify:desktop`, `npm run lint`,
`npm run test:audio`, `npm run test:history`, `npm run build`, `npx playwright test`.

---

## 5. Platforms and versions

| Platform | Status | Details |
|---|---|---|
| Node.js (WASM numerics, mocked-scope processor, isolation) | **RAN locally — 18 passed** | Node v22.22.3, Linux x86-64 sandbox |
| Chromium, headless, Linux (dev sandbox) | **RAN locally — 11 passed** (at the default 16-instance load; the 128-instance sweep FAILED, §7 and §8.3) | Chromium 153.0.8010.0 (from the `@sparticuz/chromium` 153.0.0 npm build, installed in `/tmp` and not added to the repo), Playwright 1.63.0, 2 vCPU / 3 GB VM, kernel 6.1, no audio hardware (Chromium fake audio output) |
| **Google Chrome — Windows** | **NOT RUN** | Needs the CI workflow (below) |
| **Microsoft Edge — Windows** | **NOT RUN** | Needs the CI workflow |
| **Electron 43.4.1 — Windows, unpackaged** | **NOT RUN** | Needs the CI workflow; the Electron binary download is blocked in this sandbox |
| **Electron 43.4.1 — Windows, packaged (asar)** | **NOT RUN** | Needs the CI workflow |
| Bundled Chromium on Linux CI | **NOT RUN** | Needs the CI workflow |
| Representative mid-range Windows laptop | **NOT RUN** | No access. Instructions in README "Local benchmark" |
| Existing production CI on PR #205 | **RAN — PASS** | `verify` (CI), `audio-tests` (Audio Validation), `windows-package` (Windows build + package + packaged smoke) |

**Why Windows is NOT RUN:** the sandbox's GitHub App token lacks the `workflows`
permission. Three pushes of `.github/workflows/audio-spike.yml` were rejected
("refusing to allow a GitHub App to create or update workflow … without `workflows`
permission"). The owner has no local terminal to push the file, so no Windows CI has
run. The workflow is complete but untested; it is parked at `ci/audio-spike.yml`.
Anyone with `workflows` permission can activate it with one commit (or by moving the
file in the GitHub web UI):

```bash
git mv experiments/audioworklet-wasm-spike/ci/audio-spike.yml .github/workflows/audio-spike.yml
git commit -m "Activate spike CI" && git push
```

It then runs Chrome and Edge headed on `windows-latest`, Electron unpackaged and
packaged in three CSP modes, Linux Chromium, and `check:wasm` plus the Node tests
on Windows. It uploads JSON artifacts and writes a Markdown summary.

---

## 6. Test results (local Chromium 153 unless stated)

### 6a. Numerical parity (says nothing about real time)

| Test | Result | Measured |
|---|---|---|
| WASM in Node vs JS reference | PASS | max \|diff\| **0** both channels; 0/96 000 samples differ; SHA-256 = golden |
| WASM on browser main thread vs reference | PASS | max \|diff\| **0**; SHA-256 = golden |
| WASM **inside AudioWorklet**, rendered by `OfflineAudioContext` | PASS | max \|diff\| **0**; SHA-256 = golden `ef56f2bf…5eb1` |
| Block-size independence (37 / 128 / 4096 frames) | PASS | identical hashes |
| Committed `.wasm` reproducible from `.wat` | PASS (Linux) | 681 B, sha256 `3ce00d84…7f8f`; Windows (CRLF) NOT RUN |

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

Whether `onHeadersReceived` actually applies to `file://` responses in packaged
Electron (that is, whether the packaged app enforces this CSP today) is **NOT RUN**.
The Electron runner records it (`headerHook.fileUrlCalls`).

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
3. **Repeatable initialisation failure at instance index #125 (UNRESOLVED BLOCKER).**
   With one WASM instance per AudioWorkletNode, instance index #125 (the 126th)
   fails every time with `RangeError: WebAssembly.Instance(): Out of memory: Cannot
   allocate Wasm memory for new instance`. It is reported cleanly as `wasm-init`;
   the page did not crash and the already-running instances kept processing.

   Evidence gathered (local Chromium 153, headless Linux, 2 vCPU / 3 GB VM):

   | Observation | Result |
   |---|---|
   | 128- and 256-instance sustained runs | failed at index #125, every time |
   | `instanceCapacity` test: 3 separate runs, default flags | 125, 124, 125 instances created, then the same RangeError |
   | After disposing all of them and waiting 2 s (no forced GC) | **0** new instances could be created |
   | **Main thread** of the page, no worklet | also stops at **125**, same RangeError |
   | Audio thread after the main thread has used that budget | **0** instances creatable |
   | Chromium with `--js-flags=--no-wasm-trap-handler` (2 runs) | still 124: **no change** |
   | Node 22 (V8, not Chromium), same module | 12 986 instances before failure |
   | Process limits | `ulimit -v` unlimited; each instance defines only one 64 KiB memory |

   **What the evidence supports:** this is a **renderer-process-wide limit on live
   WebAssembly memories** (~124–125 for this module), shared by the main thread and
   the audio thread. It is not specific to AudioWorklet, the kernel, or the host
   code. Disposed processors do not free their slot promptly; the memory is held
   until garbage collection, which we do not control.

   **What it does not support:** a confirmed mechanism. My first hypothesis (V8
   sandbox virtual-address cage divided by per-memory guard-region reservations) is
   **not confirmed**. Disabling the trap handler, which should remove guard regions,
   did not raise the cap. The flag may not reach the relevant isolate, or the cause
   may be different. It may also be specific to this headless Linux build or VM.
   **Windows Chrome, Edge and Electron behaviour is NOT RUN.**

   **Design consequence (holds whatever the mechanism):** a DAW cannot create one
   WASM instance per effect, voice or node, nor create instances during a session.
   The production design needs a fixed, small number of WASM memories per renderer:
   one engine instance (or one shared imported `WebAssembly.Memory`) per audio thread,
   with many DSP units in a pre-allocated slot table. This layout has **not** been
   prototyped; it is the first thing the revised spike must prove.

   Next investigation steps: confirm the cap on Windows Chrome, Edge and Electron
   (the `instance-capacity` test is already in the parked workflow); test one shared
   imported memory with many instances; check Chromium/V8 source or bug tracker for
   the per-process WASM memory limit.
4. `fetch()` of the `.wasm` file works over HTTP. Over `file://` it is NOT RUN.
   Embedding the bytes avoids the question.
5. Worklet module loading from `file://` and from inside `app.asar` is NOT RUN. A
   custom `app://` protocol (`protocol.handle`) is the standard fallback if it fails.
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

## 10. Recommendation: **REVISE**, pending investigation of the repeatable initialisation failure and Windows validation

**Why not PROCEED:**
* **Windows Electron, Chrome and Edge were NOT RUN** (§5). The agreed objective is
  reliable operation on exactly those platforms, so it is unproven.
* **Instance index #125 fails to initialise every time** (§8.3). Its exact mechanism
  is unconfirmed, and the one-engine-per-thread layout that should avoid it has not
  been prototyped.
* **The production Electron CSP blocks WebAssembly** (§8.1), so the packaged app
  cannot use this architecture without a security-policy change.

**Why not REJECT:** nothing fundamental failed. On Chromium 153 the mechanism works
end to end:

* WASM instantiated and ran inside an AudioWorklet.
* Output was **bit-identical** to an independent reference across Node, the main
  thread, and the worklet under `OfflineAudioContext`. That is exactly the live and
  export parity property the product needs.
* Lifecycle and cleanup are clean, and failures are contained without harming the
  rest of the graph in the same context.
* Kernel cost is about 0.04% of the block budget.

Each blocker has a standard, well-understood mitigation.

**Revisions required before a follow-up proof:**

0. **Investigate the #125 failure** (§8.3 next steps), including on Windows.
1. **One engine per audio thread:** a single WASM instance (or a single shared
   `WebAssembly.Memory`) hosting many DSP units with a fixed-capacity slot allocator.
   No WASM instance per node, and no instance creation during a session.
2. **CSP decision:** owner approval to add `'wasm-unsafe-eval'` to the packaged
   CSP. Also confirm whether that CSP is enforced for `file://` today.
3. **Run the parked workflow** to obtain Windows Chrome, Edge and Electron
   (unpackaged and packaged) evidence. Then run the README benchmark on the
   representative laptop.
4. **Choose and licence-review a real WASM toolchain.**

## 11. Remaining risks before migrating any production DSP

* Unresolved per-renderer WASM memory limit (~125 live memories in local Chromium,
  shared with any main-thread WASM, not reclaimed promptly). Mechanism and Windows
  behaviour unknown (§8.3).
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
