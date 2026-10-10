# AudioWorklet + WebAssembly spike (EXPERIMENTAL — not production)

Pre-Phase 1 architecture proof for Apex Studio. It answers one question:
**can one shared AudioWorklet + WebAssembly DSP implementation run reliably in
Windows Electron, Google Chrome and Microsoft Edge?**

Nothing here is imported by the app (`src/`, `index.html`, `electron.cjs`,
`vite.config.ts`, `package.json` are untouched, and `tests/node/isolation.test.mjs`
enforces this). Findings and the recommendation: [`REPORT.md`](./REPORT.md).

## Layout

| Path | Purpose |
|---|---|
| `dsp/gain_biquad.wat` | WASM kernel source (gain → RBJ biquad, TDF-II, f64 state, f32 I/O, denormal flush) |
| `dsp/gain_biquad.wasm` | Built binary (681 B), committed; CI verifies it rebuilds byte-identically |
| `web/wasm-bytes.mjs` | Generated base64 embedding of the binary (no `fetch()` of `file://` needed) |
| `web/gain-filter-processor.js` | `AudioWorkletProcessor`: instantiates WASM, processes, records timing/overruns |
| `web/host.mjs` | Main-thread lifecycle: capability detection, load, init timeout, fault isolation, dispose |
| `web/reference.mjs` | Independent JS reference, deterministic test signal, comparison + hashing |
| `web/golden.mjs` | SHA-256 of the **JS reference** output (golden value) |
| `web/harness.mjs` | In-page test suite shared by Playwright and Electron |
| `web/index.html`, `web/ui.mjs` | Manual harness page (local benchmarks on real hardware) |
| `server/serve.mjs`, `server/csp.mjs` | Static server; `/csp-none/`, `/csp-production/`, `/csp-production-wasm/` prefixes plus investigation-only variants (`csp-split-*` give worklet/worker scripts a different policy from the document) |
| `tests/node/` | Node tests: WASM numerics, mocked-scope processor logic, isolation guards |
| `tests/browser/` | Playwright config + spec (projects `chromium`, `chrome`, `msedge`) |
| `electron/` | Electron runner replicating production switches/sandbox/CSP; packaging stager |
| `dsp/gain_biquad_engine.wat` / `.wasm` | Follow-up: **single-engine** kernel (ABI v2): one instance/memory per audio thread, 1024 gain→biquad slots, same arithmetic (bit-exact) |
| `web/engine-processor.js` | Follow-up: processors `apex-spike-engine-unit` (one node per unit, shared engine) and `apex-spike-engine-bank` (one node, N units); deterministic slot release on dispose/fault |
| `web/repro.mjs` | Follow-up: minimal probes for the WASM memory budget (no audio) |
| `web/investigation.mjs`, `web/wasm-probe-worker.js` | Follow-up: design comparison, churn, offline-render, reclaim and CSP-matrix experiments |
| `tests/browser/investigation.spec.mjs` | Follow-up: codified investigation (`[must]` requirements, `[char]` browser characterisation); see REPORT.md §12 |
| `fixtures/representative-project.mjs` | Synthetic 2-bar, 48-event fixture: two generated sample tracks, two simple synth tracks, four independent routes/sends, two buses and automation. It is not an Apex-saved project. |
| `web/project-model.mjs` | Bounded clip/event scheduling and deterministic sample/triangle/saw source generation for the fixture. |
| `web/project-processor.js` | Project-level live AudioWorklet: one shared engine, one slot per track, inserts, fader automation, pan, routing, bus effect, master mix and timing probes. |
| `web/project-render-core.mjs`, `web/project-export-worker.js` | Project scheduler/mixer and long-lived Worker: repeated WASM-backed exports, PCM16 WAV generation, optional float32 transfer for live/offline comparison, cooperative cancellation and memory counters. |
| `web/project-render-reference.mjs`, `web/project-prototype.mjs` | Scalar-JS comparison renderer and browser/Electron prototype test entrypoints. The reference shares fixture scheduling/source generation but independently renders the DSP/mix path. |
| `tests/node/project-render.test.mjs`, `tests/browser/project-prototype.spec.mjs` | Bounded project correctness, live/offline float parity, repeated export, cancellation/recovery and live-engine acceptance checks; see REPORT.md §14. |
| `.github/workflows/audio-spike.yml` (repo root) | CI workflow (Linux Chromium; Windows Chrome + Edge; Windows Electron unpackaged + packaged). Originally parked here as `ci/audio-spike.yml`; activated by the owner in `7d2600c` |

## Signal flow

```
main thread (host.mjs)                         audio rendering thread
──────────────────────                         ─────────────────────────────────────────
detectSupport()                                AudioWorkletGlobalScope
audioWorklet.addModule(processor.js)  ───────► registerProcessor('apex-spike-gain-filter')
new AudioWorkletNode(ctx, name, {              constructor:
  processorOptions: { wasmBytes, params } })     new WebAssembly.Module(bytes)  (sync, 681 B)
                                                 new WebAssembly.Instance(module, {})
         ◄──── port: 'ready' | 'init-error' ───  configure(gain, b0..a2) → reset()
                                               process(inputs, outputs) every 128 frames:
source ─► AudioWorkletNode ─► destination        for each channel:
                                                   input → WASM IN scratch (memory.buffer)
                                                   exports.process(ch, 128)
                                                   WASM OUT scratch → output
         ◄──── 'processorerror' (if process throws) → host disconnects + notifies
port 'dispose' ──────────────────────────────►  state='disposed' → process() returns false
```

Coefficients, error handling, and lifecycle live on the main thread; only the
per-sample loop runs on the audio thread.

## Build and test

Prerequisites: Node ≥ 20, repo dependencies installed at the root
(`npm install --legacy-peer-deps`, which provides Playwright and Electron).

```bash
cd experiments/audioworklet-wasm-spike
npm ci                       # wabt@1.0.39 (dev-only, Apache-2.0)
npm run build:wasm           # .wat -> .wasm + web/wasm-bytes.mjs
npm run check:wasm           # verify committed artifacts are reproducible
npm run test:node            # Node: numerics, mocked-scope processor, isolation + project renderer

# Bounded synthetic project acceptance suite (five project tests; serial)
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chromium --grep 'prototype-only representative Apex-style multitrack project'

# Real browsers (one Playwright test per harness test; serial, no retries)
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chromium
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chrome
node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=msedge
#   env: SPIKE_HEADED=1  SPIKE_INSTANCES=16  SPIKE_SECONDS=20

# Electron (repo's pinned Electron), three CSP modes
node electron/run-electron.mjs
# Packaged (asar) spike-only app, Windows:
node electron/stage-electron-app.mjs
node ../../node_modules/electron-builder/cli.js --win --x64 --dir --publish never --projectDir results/electron-app
node electron/run-electron.mjs --packaged

node scripts/summarize-results.mjs   # Markdown summary of results/*.json
```

Results land in `results/` (git-ignored).

## Local benchmark on a representative Windows laptop

CI runners are virtual machines with no physical audio device, so their
numbers are not the agreed baseline. On the target mid-range laptop:

1. Plug in the charger, select the *Balanced* power plan, close other apps,
   and use the default output device (note its name and sample rate).
2. Run the steps above through `npm run test:node`, then
   `npm run serve` and open `http://127.0.0.1:4173/web/` in **Chrome**, then **Edge**.
3. Set *Instances* = 16 and *Sustained seconds* = 300, click **Run full suite**,
   and download the JSON. Then repeat **Run sustained live only** with instances
   64, 128, 256 until `sustained-live` fails; the last passing count is the headroom.
4. For Electron: `set SPIKE_SECONDS=300` then `node electron/run-electron.mjs`
   (and `--packaged` after packaging). This uses production's switches,
   including `force-wave-audio`.
5. Design comparison on real hardware (per-node vs single-engine layouts,
   16–512 units, 15 s each; ~5 min per browser), from the spike directory:
   `set SPIKE_HEADED=1` then
   `node ../../node_modules/@playwright/test/cli.js test --config tests/browser/playwright.config.mjs --project=chrome tests/browser/investigation.spec.mjs`
   (and `--project=msedge`). Optional: `set SPIKE_COMPARE_SECONDS=60`.
   `node scripts/summarize-results.mjs` prints the tables.
6. Record laptop model, CPU, RAM, Windows build, audio device, and browser
   versions alongside the JSON files.

Pass criteria per run (also enforced by the harness): 0 detected dropouts
(render lag never > 50 ms), 0 over-budget blocks, total worklet DSP time ≤ 50%
of the 2.667 ms render quantum, and ≥ 95% of wall-clock blocks rendered.

## Removal

The spike is fully removable:

```bash
git rm -r experiments/audioworklet-wasm-spike   # plus .github/workflows/audio-spike.yml if it was activated
```

No other file in the repository references it.
