# AudioWorklet capture integrity investigation

## Verdict / limits

**Production untouched. No product defect established, no PR, and no acoustic
parity measurements promoted.** The standalone capture localizes a reproducible
startup clock/callback discontinuity upstream of main-thread message handling.
It does **not** yet explain the earlier audit's conflicting PCM at equal frame
timestamps. Full-stream integrity is not repeatably passing, so Apex was not
reintroduced and the existing automation audit remains opt-in and provisional.

42 fresh-context runs: **37 strict passes, 5 strict failures**. All 42 selected
capture windows had full frame/sample coverage, zero duplicate/conflicting sample
ranges, contiguous port sequence numbers, matching producer/receiver checksums,
unique transferred buffers, and no post-receipt mutation. Forty selected windows
were exactly sample-identical to the known source; two had a maximum single-sample
error of `2.2737367544323206e-13` (RMS at most `1.0827317878249147e-15`).

The five failures each have a single **pre-window** frame jump at sequence 1:
`0 -> 640` or `0 -> 1024` with 128-sample quanta. These imply 512 or 896 skipped
clock frames but **not dropped port messages** (sequence remains 0,1,2,...).
Both Chromium builds exhibit this. No duplicate timestamps or conflicting PCM
were reproduced by this new minimal test.

## Baseline / PR #266 / CI

Start and end HEAD and fetched `origin/main`:
`65f943875903c46f4dbc58d8710b39adc9c04ce3` (no intervening main commits).
GitHub confirms PR #266 merged with exactly this merge SHA.
Start/end `v1.2.2`: `88d5889331be89a29b775e6773885b6531c7e802`.
Fetches completed at start and end; stable tag not moved. The only local work
branch remains `arena/44489220-apex-studio`; no new branch, commit or push.

All four exact-SHA workflows completed successfully, verified twice this turn:

| Workflow | Run |
|---|---|
| Desktop Validation | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712123 |
| Audio Validation | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712137 |
| Apex Studio CI | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712193 |
| Deploy Apex Studio Web | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712243 |

The pre-existing untracked `docs/verification/automation-parity/` artifacts were
inspected and preserved unchanged. No other experimental local branches existed.
`src/`, `browser-tests/realtimeExportParity.spec.ts`, dependency files and workflows
are unchanged from HEAD (`git diff --exit-code` checked).

## Environments

Linux x86_64 E2B sandbox, kernel `6.1.158+`, Node `v22.22.3`, Playwright repository
lockfile installation. Headless Chromium from npm `@sparticuz/chromium`:

| Package / actual browser | Binary SHA-256 |
|---|---|
| Existing 153 / `153.0.8010.0` | `53a15d6c3a3d27dfb54c4ba60278b1683136f70cf1e67e989da7dfbd3d451ef0` |
| `143.0.4` / `143.0.7499.0` | `52bfc7e573cc3d0f1647ef4c10e646c47ae7bf5f9a7e8c0f7832abd961fb5c0c` |

The alternate build was downloaded from registry.npmjs.org into local ignored
`.cache/`; no dependency or lockfile changes. Both use the root Playwright config's
headless/no-sandbox launch settings, shared-library path and Desktop Chrome
profile. The Windows user-agent is that **profile override**, not the OS: actual
OS is Linux; browser.version and binary --version are authoritative build records.
All runs: running AudioContext, 44,100 Hz, mono explicit input/output, observed
quantum size 128, baseLatency 0.01 s, outputLatency 0.032 s. Per-run records include
actual input channel counts and input/output quantum sizes, never infer missing
messages from whether the source is silent.

**Independent-host confirmation unavailable.** The second Chromium build is a
same-host comparison, NOT a clean GitHub runner or independent environment.
Existing Audio Validation CI has no workflow_dispatch/custom-test entrypoint and
the uncommitted opt-in experiment is not on a remote ref. No remote workflow or
mandatory CI changes, speculative PR, or unrelated patch workflow was used.

## Minimal graph and protocol

`standaloneCapture` imports/initializes **no Apex modules**. It runs on an empty
HTML document (the last nine runs also record request URLs and assert no `/src/`
requests). Vite only supplies a localhost secure origin. The graph is:

```
seeded mono AudioBufferSource -> IntegrityTap AudioWorklet -> destination
                               (writes silence to output)
```

Xorshift32 seed `0x7135ace1`, float32 conversion, known nonperiodic PCM in +/-0.25.
The source starts exactly 6,615 frames after the selected window begins and ends
6,615 frames before the window ends. Initial/final silence is deliberate and is
still captured/checked. Window durations: 1, 2, 5, and 15 seconds. The start frame
is explicitly scheduled ~200 ms ahead; source and context sample rates match.
No cross-correlation or gain normalization is used.

The processor copies input into a fresh Float32Array for every call, computes
FNV-1a over its bytes, reports sequence, `currentFrame` before/after copy,
`currentTime`, processor-side frame delta, actual input channels/lengths and actual
output quantum length, then transfers the unique buffer. No mutable worklet
storage is reused. It emits an armed marker and an explicit end marker with
block count after the last block. A safety cap and timeout fail closed.

The receiver retains **every** message, in received order, without a captureActive
boolean or sorting/deduplication. It records initial hashes and buffer identities,
then waits for the FIFO end marker plus 100 ms drain time and verifies hashes
again. Private received PCM is never written after receipt; record/metadata
objects are frozen. Window selection/reconstruction uses the scheduled start/end
and frame metadata, checks every sample including zero regions, and rejects
holes, overlapping ranges and conflicting values. Sequence continuity and
producer-side deltas distinguish callback metadata failures from port loss.
Expected block count uses the observed quantum size, not an assumed 128; variable
sizes would still be checked pairwise and by complete sample coverage. In these
runs only 128 occurred. A bit-exact sample gate was intentionally retained; no
parity tolerance was widened.

Workload case: 12 ms busy main-thread tasks every 20 ms. The input/worklet code
is unchanged. Extra `offline-contexts` cases repeatedly render unrelated 1-second
OfflineAudioContexts while live capture continues; per-run offline-render counts
are recorded. They do not substitute offline rendering for live capture.

## First failure: raw processor evidence

`evidence/short-1.json.gz` (first chronological run), Chromium 153:

```
sequence=0 frame=0   frameAfterCopy=0   quantum=128 deltaInProcessor=null
sequence=1 frame=640 frameAfterCopy=640 quantum=128 deltaInProcessor=640
```

Both PCM blocks are zeros with matching producer/receiver FNV checksum
`1299645893`. Port sequence is continuous through explicit end marker 414.
Observed blocks 414 versus expected full-stream 418. Selected window has exactly
44,100 unique samples, no missing or duplicated samples. The pre-window four
quanta were not represented by callbacks/messages; the receiver did not drop
four messages. This cannot be explained by the source's silence: a silent
worklet still emits records on both sides of the jump.

The two tiny sample errors occur at absolute frame **24057**, source sample
**8098**, actual `-2.326327148693963e-6` vs expected
`-2.3263273760676384e-6` (one float32 ULP there). This is **not** a source boundary.
An earlier conversational boundary explanation was an unverified inference;
retained raw data disproves it. Precise arithmetic/source conversion provenance
is not established; the error is not treated as a production graph defect.

## Diagnosis / confidence

1. **High confidence:** the observed standalone startup frame discontinuity is
   already present in processor metadata and callback progression. The observer
   records it before transport; port sequence/checksums/buffer ownership remain
   valid. Apex engine, mixer, automation and mastering are absent.
2. **High confidence:** missing message handling, queued-message boolean gating,
   aliasing and reconstruction do not explain these five minimal startup jumps.
   That does not retroactively clear the old audit: it lacked this protocol and
   raw per-quantum evidence.
3. **Moderate confidence:** browser/headless audio execution/startup is involved.
   Both 143 and 153 exhibit the same startup pattern on this host. A specific
   Chromium version regression or host-only failure is **not proved**; no
   independent host and no native callback tracing were available.
4. **Unresolved:** earlier mid-capture duplicate timestamps/conflicting PCM.
   Minimal tests did not reproduce them, including concurrent offline workload.
   There is no evidence connecting them causally to the startup jump. Neither
   an Apex audio-graph defect nor an exact browser root cause can be claimed.

**Overall reliability gate remains closed.** Selected-window evidence is strong
in these 42 trials, but an all-stream strict gate is intermittent and the prior
conflict remains unexplained. No new Apex stages or automation claims were run.

## Tests and files

New opt-in directory only: capture implementation, analyzer, Playwright config,
standalone scenarios, deterministic integrity unit tests, raw reanalysis script,
compressed per-run raw PCM/metadata, per-run summaries, complete run ledger and
this report. Raw captures use lossless `base64-float32-le` PCM in gzip JSON
(~30 MB for all 42, retained specifically as requested evidence). Initial raw
files were losslessly repacked from numeric JSON arrays; previous audit data was
not modified. No raw data is averaged or discarded.

`run-ledger.json` reanalyzes **all** raw files using the latest analyzer; the
original `.summary.json` files preserve each run's original result. First batch
is at evidence root, then batch-2, chromium143, concurrent153, concurrent143,
batch-3 and chromium143-repeat in chronological order.

- Deterministic integrity tests: **7 passed**. Includes identical duplicate frames
  (zero PCM error but fails ranges/counts), conflicting duplicates, missing/reordered
  messages, alias/mutation flags, and a trailing block discarded by premature
  main-thread stop gating. This specifically prevents old overwrite/zero-padding
  reconstruction from accepting corruption.
- Standalone browser runs: **37 passed / 5 failed**, no retries; per-run table below.
- `npm run lint`: passed after capture implementation/compact evidence writer.
- `npm run build`: passed, existing large-chunk warning.
- Post-analysis edits were rechecked by the 7 unit tests; final lint was repeated.
- Production audio suite and full mandatory browser suite: not rerun this turn
  (production unchanged); baseline exact-SHA CI passed. No desktop executable smoke.

Reproduction, from repository root (fresh output label preserves previous runs):

```
node --import tsx --test docs/verification/capture-integrity/integrity.test.ts
CAPTURE_BATCH=new-run npx playwright test --config docs/verification/capture-integrity/playwright.config.ts
# Optional alternate installed browser, same host (not independent-host proof):
CAPTURE_BATCH=alternate-run CAPTURE_CHROMIUM=/absolute/path/to/chromium \
  npx playwright test --config docs/verification/capture-integrity/playwright.config.ts
node --import tsx docs/verification/capture-integrity/summarize.ts
```

The root config supplies library/font paths for `/tmp/chromium`; install a normal
Playwright Chromium on a supported host if those local binaries are absent.
Default standalone discovery remains confined to `browser-tests/`: neither new
opt-in config nor old automation audit is mandatory CI.

## Next justified task

Run this exact minimal protocol on clean GitHub-hosted Ubuntu with ordinary
Playwright Chromium, retaining raw artifacts; add audio-service startup tracing
and an explicit worklet-ready/window-armed handshake while preserving all
pre-ready records. Determine whether startup clock leaps are expected lifecycle
behavior and define a defensible readiness contract. Do not simply suppress them.
Then reproduce the prior conflict using a continuous sequence-instrumented tap
across repeated graph connection/export lifecycles, one change at a time. Only
once that gate repeatedly passes should Apex dry playback and a single supported
automation target be reintroduced. Every prior automation parity conclusion
remains provisional; no test-only or production PR was opened.

## Per-run ledger

Sequence/ownership/checksum/mutation errors and selected missing/duplicate/conflict
sample counts are **zero for every row**. `pre/in` are processor frame-delta errors
outside/inside the selected window. Counts include pre-window messages. For the
five failed rows, count shortfall is entirely before the selected window.

| Run (evidence path) | Chromium | seconds | blocks / expected | pre/in | max sample error | RMS error | Strict |
|---|---|---:|---:|---|---:|---:|---|
| short-1 | 153 | 1 | 414 / 418 | 1/0 | 2.27e-13 | 1.08e-15 | **FAIL** |
| long-1 | 153 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| workload-1 | 153 | 2 | 752 / 752 | 0/0 | 0 | 0 | pass |
| repeat-1 | 153 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| repeat-2 | 153 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| long-2 | 153 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| batch-2/extended | 153 | 15 | 5230 / 5230 | 0/0 | 0 | 0 | pass |
| batch-2/long-1 | 153 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| batch-2/long-2 | 153 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| batch-2/repeat-1 | 153 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| batch-2/repeat-2 | 153 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| batch-2/short-1 | 153 | 1 | 414 / 414 | 0/0 | 0 | 0 | pass |
| batch-2/workload-1 | 153 | 2 | 752 / 752 | 0/0 | 0 | 0 | pass |
| batch-2/workload-2 | 153 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| chromium143/extended | 143 | 15 | 5230 / 5230 | 0/0 | 0 | 0 | pass |
| chromium143/long-1 | 143 | 5 | 1789 / 1789 | 0/0 | 0 | 0 | pass |
| chromium143/long-2 | 143 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| chromium143/repeat-1 | 143 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| chromium143/repeat-2 | 143 | 1 | 410 / 410 | 0/0 | 0 | 0 | pass |
| chromium143/short-1 | 143 | 1 | 410 / 410 | 0/0 | 0 | 0 | pass |
| chromium143/workload-1 | 143 | 2 | 752 / 752 | 0/0 | 0 | 0 | pass |
| chromium143/workload-2 | 143 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| concurrent153/offline-contexts | 153 | 5 | 1792 / 1799 | 1/0 | 0 | 0 | **FAIL** |
| concurrent143/offline-contexts | 143 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| batch-3/extended | 153 | 15 | 5230 / 5230 | 0/0 | 0 | 0 | pass |
| batch-3/long-1 | 153 | 5 | 1792 / 1796 | 1/0 | 2.27e-13 | 4.84e-16 | **FAIL** |
| batch-3/long-2 | 153 | 5 | 1781 / 1781 | 0/0 | 0 | 0 | pass |
| batch-3/offline-contexts | 153 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| batch-3/repeat-1 | 153 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| batch-3/repeat-2 | 153 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| batch-3/short-1 | 153 | 1 | 414 / 421 | 1/0 | 0 | 0 | **FAIL** |
| batch-3/workload-1 | 153 | 2 | 752 / 752 | 0/0 | 0 | 0 | pass |
| batch-3/workload-2 | 153 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/extended | 143 | 15 | 5230 / 5230 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/long-1 | 143 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/long-2 | 143 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/offline-contexts | 143 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/repeat-1 | 143 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/repeat-2 | 143 | 1 | 407 / 407 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/short-1 | 143 | 1 | 414 / 421 | 1/0 | 0 | 0 | **FAIL** |
| chromium143-repeat/workload-1 | 143 | 2 | 752 / 752 | 0/0 | 0 | 0 | pass |
| chromium143-repeat/workload-2 | 143 | 5 | 1785 / 1785 | 0/0 | 0 | 0 | pass |

The repeat-1/repeat-2 selected-window SHA-256 hashes match within each of the
four full batches containing both runs (batch-2, batch-3, chromium143,
chromium143-repeat); equality is checked on reconstructed PCM, not aggregate RMS.
