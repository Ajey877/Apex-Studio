# Post-readiness duplicate-frame isolation — not reproduced, cause unresolved

> **Documentation handoff:** recovered from the original untracked report for
> [PR #267](https://github.com/Ajey877/Apex-Studio/pull/267), merged into `main`
> on 2026-10-21 after synchronization with `main` @ `25ac8e4` and revalidation.
> Investigation
> outcomes and refs below describe the completed diagnostic phase, not a new run.
> Earlier phases: [local readiness](../readiness/REPORT.md) and
> [132-capture hosted verification](../readiness/HOSTED-REPORT.md). The gate remains closed.
>
> **Correction (2026-10-21, merge finalization):** the job-status tally in
> "Tests, changes and remaining limits" originally read "five jobs failed final
> experiment status, three succeeded". Re-verification against the GitHub run
> [39566258125](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125)
> job metadata (and the fidelity tables in this report, which show exactly four
> browser/mode combinations containing failures) established the actual outcome:
> **four** isolation jobs failed and **four** succeeded. Only the tally sentence
> was corrected; no measurement, table, artifact or investigation outcome changed.

## Verdict

The target `5248,5248,5504` post-readiness pattern was **not reproduced in 240
new hosted fresh-context trials**. This is not a resolution or a harness approval.
The historical first failure was re-extracted read-only from its original
artifact and its SHA-256 reverified. It coincides with the processor's transition
from `ready` to `armed`, but that single observation does not prove arm messaging
caused it. No Chromium/product defect is claimed. No production code was changed,
no PR was opened, and no Apex/automation/export stage was introduced.

The investigation separated a reproducible **immediate-scheduling alignment
problem** from frame-clock continuity: 23/60 zero-lead controls failed exact PCM
while their frame streams remained continuous after readiness. This explains
those control failures, NOT the historical duplicate. Two non-immediate captures
also had tiny exactness errors; no tolerances were widened to pass them.

## Refs and preservation

- Starting local and fetched diagnostic SHA:
  `a2e23bb8acddc91b2728340b14f67b6d407967dc`.
- Capture experiment SHA: `4b7cbcfa13c620768f9bfeff62dc378930367053`.
- Ending local/remote diagnostic SHA:
  `5c7ff6b08e914e088f13c3adcc855c2567959bdf`.
- Branch remains `arena/44489220-apex-studio`; no new branch/reset/force push.
- Starting/ending main: `65f943875903c46f4dbc58d8710b39adc9c04ce3`.
- Starting/ending `v1.2.2`: `88d5889331be89a29b775e6773885b6531c7e802`.

All 42 original and 15 prior local raw captures verified against their existing
manifests before experimentation. Previous reports, archived hosted captures,
independent reanalyses and manifests remain intact. API artifact digests were
checked; original failing raw bytes were then downloaded/verified on a hosted
runner, because direct artifact downloads remain unavailable in the sandbox.
Historical compact reports previously untracked were committed for preservation;
raw PCM stayed ignored/local or in workflow artifacts. Existing automation audit
remains untouched. The report and compact evidence manifest/checksum index are now tracked for
the documentation handoff. The larger supplemental local ledger is preserved
untracked; individual raw records and per-job ledgers remain Actions artifacts.

## Evidence recheck for documentation handoff

GitHub Actions API metadata was rechecked without rerunning any experiment:
all eight capture artifacts and the historical extraction artifact are available
and unexpired. Exact names and URLs below match their run artifact listings.
Current archive SHA-256 digests and sizes are recorded in
[hosted/evidence-manifest.json](hosted/evidence-manifest.json); individual raw
recording hashes are indexed in [hosted/raw-sha256.txt](hosted/raw-sha256.txt).

The earlier [independent hosted reanalysis, run 39564296460](https://github.com/Ajey877/Apex-Studio/actions/runs/39564296460)
completed successfully at `a2e23bb8acddc91b2728340b14f67b6d407967dc`.
Its conclusions belong to the preceding 132-capture phase, not the 240 new trials.
This handoff rechecks metadata, reports, manifests and preserved per-run records;
it does not claim a new download or reanalysis of every archived PCM recording.
Direct redirected artifact storage remains unavailable from this sandbox, as
noted below. Historical failed experiments remain failed.

## Reused implementation, controls and unchanged assertions

Instrumented the **existing** `captureWithReadiness` function; did not implement a
replacement capture protocol. Default lead mode and original `analyzeReady`
acceptance criteria remain intact, including 32 contiguous quanta, exact PCM,
post-ready continuity even before the source, and all earlier startup records.
`analyzeIsolation` reports the original contract result separately from each
control's own source geometry. A deliberate control success is never relabeled
as a baseline-contract pass.

Four modes, each ten repetitions of short (1 s), long (10 s), workload (3 s):

1. **lead:** original 250 ms lead + 100 ms pre-source silence, 150 ms tail.
2. **no-ready:** same lead, but scheduling does not wait for ready receipt.
   The 32-quanta proof is still emitted and checked later; only this explicitly
   marked control may arm before acknowledgement. It is NOT baseline scheduling.
3. **immediate:** source scheduled at the current sample frame after ready
   receipt, no pre-source lead; exact source-frame errors still fail. The
   original safer scheduling-contract failure remains reported separately.
4. **generated:** no BufferSource connection/start; continuous deterministic
   frame-addressed worklet output, copied and checked directly. This is output
   fidelity, not input-buffer fidelity, and is explicitly labeled. A repeated
   frame would generate repeated PCM, so this control alone cannot identify a
   physical sample-clock progression independently of the frame metadata.

No warmup extension, correlation search, sorting, deduplication or message gate.
All callbacks are recorded from initial invocation. New fields: processor instance
and context IDs, callback-local count, frame on entry/after copying/before post,
`currentTime`, actual layouts, detached transfer length observed on the next
callback, checksum and PCM. Worklet `currentTime` is audio-clock seconds; main-thread
`performance.now()` is a separate clock and is used only for event order and
receiver timing, not directly equated to audio frames. Main-thread events cover ready/arm receipt, source
start call/return, end/drain, disconnect, context and port closure. Natural source
end is defined by buffer length; no explicit source.stop was introduced.

All cases use fresh context, node, port, UUID and store. Main-thread workload is
12 ms every 20 ms after source scheduling. Each failing experiment uploads its
raw file before assertions and retains a failed final job status. No retried case
or first failure is overwritten. Continuous stream checks use the preceding
actual quantum length, not a hard-coded 128 assumption.

## Hosted environment and executions

[Capture workflow 39566258125](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125)
completed with **failure**, correctly retaining individual fidelity failures.
[Historical evidence extraction 39567197925](https://github.com/Ajey877/Apex-Studio/actions/runs/39567197925)
completed successfully; it replayed no captures and replaced no original data.

All jobs: GitHub-hosted Ubuntu 24.04.5 LTS, Node 22.23.3, Playwright **1.63.0**,
44,100 Hz mono, observed quantum **128**, one worker, no retries.

**Runner/browser drift is a comparison limitation**, not silently normalized:

- Image `ubuntu24/20261012.334.1`, kernel `6.17.0-1022-azure`: lead/immediate
  jobs on both browsers and Chrome no-ready. Chromium **153.0.8010.12**;
  Chrome **155.0.8059.39**.
- Image `ubuntu24/20261018.339.1`, kernel `7.0.0-1017-azure`: both generated
  jobs and Playwright no-ready. Chromium still **153.0.8010.12**; runner Chrome
  updated to **155.0.8059.84** for generated mode.

Thus generated versus lead is not a pinned-host/browser A/B comparison. Neither
absence of duplicates nor a pass-rate difference establishes a causal mode effect.
Exact environment.txt contents are retained in the manifest and raw artifacts.

## Results

All 240 runs proved readiness, had complete unique selected-window coverage, and
had **zero post-ready clock anomalies**. Startup anomalies remain in 146/240.
All 240 UUIDs were distinct; callback count/sequence/instance identity checks and
buffer-detachment checks passed. No same-frame conflicting PCM appeared. Python
stdlib raw-source regeneration/checksum analysis independently agreed with every
TS fidelity result and reconciled each raw hash with its summary.

| Browser / mode | Runs | Startup-discontinuous | Post-ready anomalies | Coverage | Exact fidelity |
|---|---:|---:|---:|---:|---:|
| Chromium 153 / lead | 30 | 23 | 0 | 30/30 | 30/30 |
| Chromium 153 / no-ready | 30 | 20 | 0 | 30/30 | **29/30** |
| Chromium 153 / immediate | 30 | 24 | 0 | 30/30 | **11/30** |
| Chromium 153 / generated | 30 | 23 | 0 | 30/30 | 30/30 |
| Chrome 155.39 / lead | 30 | 12 | 0 | 30/30 | **29/30** |
| Chrome 155.39 / no-ready | 30 | 14 | 0 | 30/30 | 30/30 |
| Chrome 155.39 / immediate | 30 | 14 | 0 | 30/30 | **26/30** |
| Chrome 155.84 / generated | 30 | 16 | 0 | 30/30 | 30/30 |

Coverage and clock continuity do not imply exact source timing. In immediate
mode, 19/23 failed cases logged source.start being called AFTER the recorded
scheduled source frame. Four others read the same main-thread frame at call but
still produced a source-alignment error; that clock snapshot cannot guarantee
audio-thread execution at the same instant. None of the 37 exact immediate cases
had a logged start call after its scheduled frame. This is evidence of the
zero-lead scheduling race, not evidence of the duplicate-frame cause.

Example first failed Chromium short immediate case:
`39566258125-immediate-short-1-b98efa07-76b3-4904-a4c4-9fa58d466e57`.
Ready ends at 5120; ready received/main source target at 5248; source.start call
and armed acknowledgement at **5376**, `tooLate=true`. Expected source sample
zero at frame 5248 was `-0.09066605567932129`; actual captured value was zero.
Max absolute error ~0.499, RMS ~0.191. Exact comparison failed without fitting
or shifting the data. Port/context disconnection happened only after end/drain.

Two non-immediate exactness failures are retained, not waved away:

- Chrome lead short-0 (`7ba44d0d-3dce-479d-8688-c58c6cb7b999`): max error
  `9.094947017729282e-13`, RMS `4.744292991356825e-15`.
- Chromium no-ready short-1 (`2c3dbdbb-c335-4ba7-8d39-a1355f81ee4a`): max error
  `2.2737367544323206e-13`, RMS `9.684247515905552e-16`.

Both first errors were at source index 8098 (near-zero sample), not an onset.
The numerical source/interpolation cause is not established in this phase. They
remain exact-fidelity failures, consistent with the original conservative gate.

## Historical duplicate — exact raw records reverified

[Original raw Playwright artifact](https://github.com/Ajey877/Apex-Studio/actions/runs/39562499637/artifacts/12329025501)
contains run `39562499637-chromium-workload-2-73c39967-ab8c-4d9e-a1c9-c6a74b68023b`.
Its raw SHA-256 remains
`0e8e6e0e1c2b83490af257aa76d2ae93b9141230a2b964847632c9fa6cd2ca48`.

| Sequence | Entry frame | After-copy frame | Processor state | PCM checksum |
|---:|---:|---:|---|---:|
| 31 | 4864 | 4864 | warming | 1299645893 |
| 32 | 4992 | 4992 | warming; ready emitted afterward | 1299645893 |
| 33 | 5120 | 5120 | ready | 1299645893 |
| 34 | **5248** | **5248** | **ready** | 1299645893 |
| 35 | **5248** | **5248** | **armed** | 1299645893 |
| 36 | **5504** | **5504** | armed | 1299645893 |
| 37 | 5632 | 5632 | armed | 1299645893 |

Raw records 34/35 have byte-identical all-zero PCM, independently checked, not
merely matching checksums. Ready proof is sequence 32/end 5120; arm receipt is
frame **5248**; main scheduling snapshot also **5248**. Source target is 20683,
selected interval 16273..159598. The first repeated frame crosses the ready→armed
state transition. This narrows the earliest recorded boundary to callback 35,
not main-thread reconstruction. It is a correlation with arm delivery, not proof
that arm delivery or source.start caused the duplicate.

Receiver arrival timestamps for callbacks 31..34 were 96.9 ms, armed marker
97.1 ms, callbacks 35..37 106.9 ms (relative page performance clock). Equal receiver arrival times are consistent with queue
batching, but do not establish why producer frame metadata repeated. Original code creates one processor per context/run; old raw
records lack the newly added explicit instance identifier, so that field cannot
be retroactively checked. New trials found no cross-instance/context/port mixing,
but do not retroactively prove every hypothesis false for the old run.

No original explicit source.start-call/port-close event trace existed. Therefore
new detailed traces cannot be projected onto that historical failure. Exact root
cause and a live reproducible duplicate remain unresolved. No additional live
duplicate was found to claim on-demand reproduction.

## Raw artifacts and independent evidence

Each artifact holds every UUID's raw gzip PCM/records, summary, independent
Python ledger, captured lifecycle events, environment.txt and test log. All first
failures and successes remain separate; expires 2026-11-20.

| Browser/mode | Artifact |
|---|---|
| isolation-chrome-lead-39566258125 | [12330605814](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12330605814) |
| isolation-chrome-immediate-39566258125 | [12330461701](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12330461701) |
| isolation-chrome-no-ready-39566258125 | [12330257450](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12330257450) |
| isolation-playwright-immediate-39566258125 | [12330086843](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12330086843) |
| isolation-chrome-generated-39566258125 | [12330061903](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12330061903) |
| isolation-playwright-generated-39566258125 | [12329923112](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12329923112) |
| isolation-playwright-lead-39566258125 | [12329678591](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12329678591) |
| isolation-playwright-no-ready-39566258125 | [12329368831](https://github.com/Ajey877/Apex-Studio/actions/runs/39566258125/artifacts/12329368831) |
| original-duplicate-and-runner-metadata-39567197925 | [12330238061](https://github.com/Ajey877/Apex-Studio/actions/runs/39567197925/artifacts/12330238061) |


The sandbox still cannot directly reach redirected artifact storage. Hosted
inspection used the normal Actions artifact-download mechanism. Complete
compressed check-annotation payloads were fetched via GitHub API, reassembled and
SHA-256 verified, never interpreted from partial/truncated messages. Compact
per-run metadata, raw hashes and historical neighboring-record hashes are in
[hosted/evidence-manifest.json](hosted/evidence-manifest.json) and
[hosted/raw-sha256.txt](hosted/raw-sha256.txt); full decoded summaries remain in ignored local results as well as
hosted artifacts. No raw PCM was added to Git.

## Tests, changes and remaining limits

- Existing 12 integrity tests + four new classifier tests: **16 passed locally
  and in each of eight hosted jobs**. Synthetic tests are not live root-cause proof.
- Lint/build passed locally and in all hosted jobs (existing chunk warning).
- Four local short-mode smoke tests passed after fixing a newly introduced trace
  helper/MessageEvent name collision; the initial timeout raw run remains retained.
- Hosted tests: 240 cases, no retry, **215 exact-fidelity passes / 25 failures**;
  four jobs failed final experiment status (chrome lead, chrome immediate,
  playwright no-ready, playwright immediate), four succeeded. All uploads succeeded.
- Independent Python checks agreed on all 240 fidelity classifications and
  archive hashes; no post-ready frame discontinuity was found by either analyzer.
- Production files and original realtimeExportParity regression unchanged.
- Existing opt-in workflow extended only; ordinary CI unchanged; no PR/merge.

Changes: existing experimental capture instrumentation and explicit controls,
optional generated-reference support/error preservation in the Python checker,
isolation spec/config/classifier/tests, lossless summary publication, historical
artifact extraction, and reports/manifests. No production bug fix is claimed.

The original scheduling acceptance result is retained as baselineContractPass.
No-ready/immediate/generated controls can fail that original geometry/input
contract while satisfying their explicitly labeled diagnostic coverage checks.
Those control passes must not be reported as baseline-harness validation.

## Next justified step

Keep the gate closed. Run paired original-uninstrumented versus instrumented
capture on the SAME pinned runner/browser build to bound observer effects. Then
separate arm delivery from source.start, changing their order/one operation at a
time while retaining the original source target/lead and all post-ready assertions.
The historical ready→armed boundary is the strongest current localization, not a
proved cause. Increasing warmup or dropping scheduling-lead records is unjustified.
Startup clock behavior and tiny exactness errors also remain unresolved. All
capture-to-Apex and automation-parity conclusions remain provisional.

## Results split by profile

Each cell is a count out of ten fresh contexts. Ready and coverage are 10/10 for
all rows; post-ready duplicate/gap counts are zero for every row. Individual UUID,
ready/arm/schedule frames, error values and lifecycle events are in each
artifact's `diagnostic-isolation/ledger.json` and retained supplemental local ledger.

| Browser/mode | Profile | Startup-anomalous runs | Exact fidelity |
|---|---|---:|---:|
| isolation (chrome, generated) | short | 6/10 | 10/10 |
| isolation (chrome, generated) | long | 4/10 | 10/10 |
| isolation (chrome, generated) | workload | 6/10 | 10/10 |
| isolation (chrome, immediate) | short | 5/10 | 9/10 |
| isolation (chrome, immediate) | long | 5/10 | 8/10 |
| isolation (chrome, immediate) | workload | 4/10 | 9/10 |
| isolation (chrome, lead) | short | 4/10 | 9/10 |
| isolation (chrome, lead) | long | 4/10 | 10/10 |
| isolation (chrome, lead) | workload | 4/10 | 10/10 |
| isolation (chrome, no-ready) | short | 5/10 | 10/10 |
| isolation (chrome, no-ready) | long | 6/10 | 10/10 |
| isolation (chrome, no-ready) | workload | 3/10 | 10/10 |
| isolation (playwright, generated) | short | 8/10 | 10/10 |
| isolation (playwright, generated) | long | 8/10 | 10/10 |
| isolation (playwright, generated) | workload | 7/10 | 10/10 |
| isolation (playwright, immediate) | short | 9/10 | 4/10 |
| isolation (playwright, immediate) | long | 8/10 | 4/10 |
| isolation (playwright, immediate) | workload | 7/10 | 3/10 |
| isolation (playwright, lead) | short | 7/10 | 10/10 |
| isolation (playwright, lead) | long | 9/10 | 10/10 |
| isolation (playwright, lead) | workload | 7/10 | 10/10 |
| isolation (playwright, no-ready) | short | 7/10 | 9/10 |
| isolation (playwright, no-ready) | long | 7/10 | 10/10 |
| isolation (playwright, no-ready) | workload | 6/10 | 10/10 |
