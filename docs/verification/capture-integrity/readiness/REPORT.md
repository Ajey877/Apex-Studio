# Clean-host verification / readiness contract — blocked at GitHub authorization

> **Historical local-readiness report.** The authorization blocker below describes
> the original local phase, not the current status. Continue with the
> [132-capture hosted verification](HOSTED-REPORT.md), then the
> [240-trial isolation report](../isolation/REPORT.md). These later experiments
> did not establish a root cause or approve capture/automation parity. The
> documentation was handed off through PR #267, which was synchronized with
> `main` @ `25ac8e4`, revalidated and merged on 2026-10-21 under an explicit
> finishing mandate. The investigation findings and the closed automation-parity
> gate are unchanged by that merge.

## Outcome

**Hosted verification has NOT occurred. The automation-parity gate remains closed.**
A traceable processor-readiness protocol was implemented and exercised locally,
but GitHub rejected the diagnostic workflow push:

```
refusing to allow a GitHub App to create or update workflow
`.github/workflows/capture-integrity-diagnostic.yml` without `workflows` permission
```

This is the precise blocker, not browser availability or a failed hosted capture.
The connected GitHub App must be reauthorized/reconnected with workflows write
permission before the branch can be pushed. No credential was requested, no API
workaround attempted, and no existing unrelated workflow was dispatched.
**Zero hosted executions, zero new Actions artifacts, zero PRs.**

## Verified refs, isolation and preservation

Actual remote refs fetched and checked with `git ls-remote` at both ends:

- Starting `main`: `65f943875903c46f4dbc58d8710b39adc9c04ce3`
- Ending `main`: `65f943875903c46f4dbc58d8710b39adc9c04ce3`
- Stable `v1.2.2`: `88d5889331be89a29b775e6773885b6531c7e802` (unchanged)

PR #266 baseline workflows all completed successfully on that exact SHA:

| Workflow | Status | Run |
|---|---|---|
| Desktop Validation | success | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712123 |
| Audio Validation | success | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712137 |
| Apex Studio CI | success | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712193 |
| Deploy Apex Studio Web | success | https://github.com/Ajey877/Apex-Studio/actions/runs/39553712243 |

The fixed Arena branch `arena/44489220-apex-studio` is used as the isolated
diagnostic branch; no other branch was created or switched to. It was at the
baseline with only untracked audit deliverables at entry. Test-only diagnostic
sources and compact reports were committed locally; the attempted push of
`5dd3f69` was rejected in full, and the remote branch ref does not exist.
Subsequent fixes/reporting are in a follow-up local commit (see branch HEAD).
No reset, history rewrite, main commit, or stable-tag operation was performed.

The original 42 raw gzip captures remain local, ignored, and unchanged:
`original-42-sha256.txt` verifies all 42 successfully. Their analyzer and original
report are preserved; original report statements about untracked status describe
that earlier investigation, not the current local commits. The pre-existing
`docs/verification/automation-parity/` directory remains untracked and unchanged.
No original raw captures, large PCM files or previous automation artifacts were
committed. Production `src/`, original realtimeExportParity regression, dependency
files and existing production workflows have no changes from baseline.

## Hosted plan (implemented, NOT executed)

`.github/workflows/capture-integrity-diagnostic.yml` runs only on the exact
diagnostic branch, by path-filtered push or explicit dispatch. It does not change
ordinary production CI. Planned host is GitHub-hosted `ubuntu-24.04`, Node 22,
`npm ci`, and Playwright-managed Chromium installed from the locked Playwright
package. A second job selects runner-installed Google Chrome, recording its
actual version; an absent second browser fails explicitly rather than being
silently substituted. No hosted browser version is claimed before execution.

Each browser job runs two complete 9-case legacy protocol rounds with distinct
output directories, then five repetitions each of short, long and workload
readiness captures (15). The original capture function is unchanged; only its
local default evidence destination was made collision-resistant. Legacy failure
is recorded separately via step outcome and retained logs; it is not reported as
a passing legacy stream merely because the later readiness step passes. Readiness
failures fail the job. Matrix jobs do not fail-fast. Artifacts always retain raw
PCM, per-quantum metadata, summaries, environment/browser/Playwright versions,
source checksums, logs and separate step outcomes for 30 days. Raw PCM is excluded
from Git and intended for Actions artifact storage.

## Readiness contract and local environment

See `CONTRACT.md` and executable `readiness/capture.ts` / `analyze.ts`.
Each invocation, starting at callback zero, includes unique run ID, monotonic
sequence, frame before/after copy, sample rate, actual input/output channels and
lengths, processor state, previous end/streak, checksum and PCM. No captureActive
flag, sorting, deletion of initial records, or arbitrary correlation alignment.

Readiness is an explicit processor acknowledgement after 32 consecutive
contiguous quanta. The receiver independently verifies the proof from the raw
records while context state is running. At 128/44100 this is ~93 ms of observed
continuity, a warmup criterion, NOT a guarantee of future continuity. A jump
resets the streak and stays in startupAnomalies. Only after receiving readiness
is a source scheduled with 250 ms lead, 100 ms checked pre-source silence, and
150 ms checked post-source tail. Post-ready scheduling-lead discontinuities also
fail; the analysis does not just ignore everything outside the source's sound.
An armed acknowledgement must precede the selected start. An end marker must
cover the exact end frame and reconcile total block count.

Startup continuity, readiness, measurement integrity and PCM fidelity remain
separate outcomes. A passed post-ready capture can and does have
startupContinuous=false. UUID-bearing IDs and separate per-test stores reject
stale-run records. Producer/receiver hashes and post-drain checks verify ownership
and immutability. All source-frame comparisons are direct; **zero sample-error
tolerance is currently used**, so unexplained floating errors cannot be accepted.

Actual local execution only:

- Linux E2B sandbox, `6.1.158+`, x86_64; Node `22.22.3`.
- Playwright **1.63.0**, Chromium **153.0.8010.0** (`/tmp/chromium`).
- Mono explicit capture, **44,100 Hz**; actual observed quantum **128**.
- Same deterministic xorshift32 PCM seed as the original investigation.
- Fresh page, context, port and UUID for every run; one worker, no retry.
- Source durations: short 1 s; long 10 s; workload 3 s.
- Workload: 12 ms main-thread busy tasks every 20 ms after scheduling.
- Six runs (two repeats per case), then nine runs (three repeats per case).
- These are NOT an independent browser host or hosted verification.

## Results and first failures

**15/15 recorded readiness captures passed readiness, post-ready integrity and
bit-exact PCM fidelity. Eleven retained startup frame jumps; four had continuous
startup.** All post-ready gaps, missing/duplicate/conflicting samples, sequence
errors, stale-run IDs, layout errors, producer/receiver checksum differences,
buffer aliasing and post-receipt mutations were zero. Before/after-source silence
was exactly zero. Each expected/compared sample count matched. Per-run scheduled
start/end frames, ack frames, IDs, browser versions, block counts and raw gzip
SHA-256 are in `local-readiness-ledger.json`; raw files remain in ignored
`readiness/results/`.

First recorded v2 capture (short repeat 0, UUID `df7456c1-6096-4528-a046-d2dea89f71c9`):
sequence 0 frame 0, sequence 1 frame 1024 (expected 128). After 32 contiguous
quanta, ready sequence 32 ended at frame 5120. Arm at 5376; window 16401..71526,
source 20811..64911. It retained the startup gap, then received all 55,125 selected
samples once with zero sample error. This is evidence for distinguishing a valid
later interval, not evidence that the full startup stream was continuous.

Prototype failures are not hidden:

1. First local browser invocation: six cases reached a Node-side ESM writer error
   (`require is not defined`) after capture. The test had not persisted raw PCM
   before that exception, so those six are **not** counted as verified captures.
   The failure log is retained locally in `results/prototype-logs/`. Fixed by
   initializing an ESM-compatible createRequire at module load; later captures
   persist raw files before assertions.
2. Initial unit tests: 11/12 passed. The nominal valid fixture incorrectly placed
   scheduling at frame 13 before ready end 16. The analyzer correctly rejected
   it. Corrected the fixture to frame 16, without changing analyzer acceptance;
   final **12/12 passed**. The original failure log is preserved locally.

No raw data from a captured integrity failure has been discarded; all earlier
42-run raw records and all 15 persisted v2 records remain. The writer-error
prototype cannot be retroactively reconstructed and is explicitly excluded.

## Conflicting PCM investigation / root-cause limit

No duplicate-timestamp contradictory PCM appeared in these 15 standalone runs.
Synthetic regressions verify that the analyzer rejects same-frame contradictory
PCM and same-frame identical duplicates, rather than overwriting them. They are
not evidence that the historical failure has been reproduced in a live browser.

Hosted verification is a required gate, so source/capture lifecycle and Apex
playback, production tap, offline rendering and automation were **not** added.
No claim is made about reused arrays, stale callbacks, concurrency or port mixing
as the historical root cause. The previous evidence only localizes startup jumps
upstream of the main-thread receiver, with Apex absent. Exact browser startup
cause and historical conflicting PCM root cause remain unresolved.

## Files and validation

Local changes are limited to the opt-in diagnostic workflow and
`docs/verification/capture-integrity/`: legacy source/analyzer/tests preserved,
raw-data ignore rules and manifest, new readiness capture/analyzer/unit/browser
spec/config, contract, compact ledger and this report. No production modifications.

Executed locally:

- Legacy 7 + new readiness 5 deterministic unit tests: **12 passed** after the
  fixture correction. Tests distinguish startup from measurement, reject late arm,
  invalid proof, missing end, wrong run ID, missing final blocks and duplicate PCM.
- Readiness Chromium tests: **6 passed**, then **9 passed**, no retries.
- `npm run lint`: passed.
- `npm run build`: passed with existing chunk-size warning.
- Old 42 raw SHA-256 manifest verification: **42 passed**.
- Hosted protocol / hosted browser comparisons: **blocked**, never executed.
- Full production audio/browser suites and desktop smoke: not rerun this turn.
- PR: none; no merge considered.

## Next step and gate

Reauthorize GitHub with workflow-creation permission, then push the existing
session branch normally (no force) and watch the opt-in workflow on the exact
pushed diagnostic SHA. Download and independently reanalyze **every** run artifact,
including initial failures; record actual runner/browser/Playwright versions.
Do not substitute these local results for that step. Only after repeated hosted
window validation should lifecycle/Apex components be introduced incrementally.
**The harness is not yet approved for automation parity.**

## Every persisted v2 run

All rows: readiness=true, measurementIntegrity=true, fidelity=true, zero sample
max/RMS error and zero missing/duplicate/conflicting samples. Startup is separate.
The full UUID and exact frame schedule are retained in the compact JSON ledger.

| UUID | Case/repeat | Startup continuous | Ready sequence | Expected/compared samples | Blocks |
|---|---|---|---:|---:|---:|
| 51cf6218-93e4-42ba-9c00-cb04169daa82 | long-0 | False | 32 | 452025/452025 | 3652 |
| d7a585ce-edc7-42e1-9db3-3611d151e774 | long-0 | False | 32 | 452025/452025 | 3653 |
| 1f0afd26-7d84-4785-9e79-0d0ad9d0f1b8 | long-1 | True | 31 | 452025/452025 | 3653 |
| 30215256-c857-43e5-844d-d2425d2ee76e | long-1 | True | 31 | 452025/452025 | 3653 |
| a95efde9-ad1f-4392-88aa-2f2ea43c5b21 | long-2 | False | 32 | 452025/452025 | 3653 |
| 5cbfad6d-26e3-4f2a-999f-96597842ff0f | short-0 | False | 32 | 55125/55125 | 552 |
| df7456c1-6096-4528-a046-d2dea89f71c9 | short-0 | False | 32 | 55125/55125 | 552 |
| 061c3f11-6248-4317-af50-e8edcf633c18 | short-1 | False | 32 | 55125/55125 | 552 |
| 36a36654-08a0-4d2f-8d4b-546ccf8988c3 | short-1 | False | 32 | 55125/55125 | 552 |
| adc99b5b-083f-467c-bdfd-631c01468bfd | short-2 | False | 32 | 55125/55125 | 551 |
| 31f0079a-517e-453f-a4c9-4969c45eaaae | workload-0 | False | 32 | 143325/143325 | 1241 |
| 6153d4a3-73f2-4d8d-9bfa-f114f10e9573 | workload-0 | False | 32 | 143325/143325 | 1241 |
| 5f80c7e6-0de0-453f-bf85-aa26699b0e13 | workload-1 | True | 31 | 143325/143325 | 1241 |
| 7e9dbb08-fb11-4f46-9039-d6b2efdccbf4 | workload-1 | True | 31 | 143325/143325 | 1241 |
| 4ea0e071-72cb-4208-a872-d14011fd326a | workload-2 | False | 32 | 143325/143325 | 1241 |
