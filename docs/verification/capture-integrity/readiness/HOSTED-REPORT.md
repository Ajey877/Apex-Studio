# Hosted AudioWorklet verification — executed, gate remains closed

## Result

The GitHub workflow permission update worked. The existing branch was pushed
normally, and the exact existing capture protocols ran on GitHub-hosted runners.
**Two capture executions produced 132 retained captures.** A separate hosted
Python verifier independently reconstructed every known source window, recomputed
per-block FNV checksums and reconciled archive hashes and frame/sequence metadata.

All 132 selected source windows had full unique sample coverage and exact PCM,
including checked leading/trailing silence. **This is not a clean overall pass:**
one of 60 v2 captures had a duplicate frame followed by a skipped frame AFTER
its 32-quantum readiness acknowledgement, during scheduling lead. The contract
correctly rejected that run. Two of 72 legacy streams failed their full-stream
check because of pre-window discontinuities. Passing job status in execution 2
does not erase these continue-on-error legacy failures.

**No Apex playback, mastering, automation, or export stages were introduced.
No production changes, no PR, no merge. The automation-parity gate stays closed.**

## Refs / preservation

- Entry local diagnostic HEAD: `747f59bd0db24b1f821c3ceaac7c903679c86dbd`.
- This exact SHA was pushed successfully first and produced capture execution 1.
- Final verified remote diagnostic branch `arena/44489220-apex-studio`:
  `a2e23bb8acddc91b2728340b14f67b6d407967dc`.
- Starting and ending remote `main`:
  `65f943875903c46f4dbc58d8710b39adc9c04ce3`.
- Starting and ending `v1.2.2`:
  `88d5889331be89a29b775e6773885b6531c7e802`, untouched.

The original 42 raw captures and 15 local v2 captures passed their checksum
manifests at entry. They and the earlier automation audit are preserved; no
original evidence was regenerated or discarded. No PCM was committed. Production
`src/`, `browser-tests/`, dependencies and existing production workflows have no
diff from baseline. Capture functions/analyzers were unchanged between the two
hosted capture executions. Additional commits only expose diagnostic evidence
and independently inspect archived raw data.

All four PR #266 exact-baseline workflows remain completed/success:
[Desktop](https://github.com/Ajey877/Apex-Studio/actions/runs/39553712123),
[Audio](https://github.com/Ajey877/Apex-Studio/actions/runs/39553712137),
[CI](https://github.com/Ajey877/Apex-Studio/actions/runs/39553712193),
[Web](https://github.com/Ajey877/Apex-Studio/actions/runs/39553712243).

## Hosted executions

| Execution | Source SHA | Outcome |
|---|---|---|
| [39562499637](https://github.com/Ajey877/Apex-Studio/actions/runs/39562499637) | `747f59b` | Completed/failure: Playwright v2 14/15; Chrome v2 15/15; legacy 36/36 |
| [39563380457](https://github.com/Ajey877/Apex-Studio/actions/runs/39563380457) | `8400dee` | Completed/success: v2 30/30; legacy 34/36 (Chrome legacy errors explicitly tolerated by diagnostic workflow) |
| [39564296460](https://github.com/Ajey877/Apex-Studio/actions/runs/39564296460) | `a2e23bb` | Completed/success: independent raw analysis of BOTH capture executions, no new captures |

Intermediate raw-inspection execution
[39564107883](https://github.com/Ajey877/Apex-Studio/actions/runs/39564107883)
also completed, but its compact annotation transport was incomplete. Final
inspection supersedes that transport, not its underlying raw data.

### Environment

Recorded host: GitHub-hosted `ubuntu-24.04`, **Ubuntu 24.04.5 LTS**, Linux
`6.17.0-1022-azure`, x86_64. Node **22.23.3**, npm **10.9.9**, Playwright **1.63.0**.
The hosted versions are not the sandbox versions:

- Playwright-managed Chromium **153.0.8010.12**, installed by locked Playwright
  (`chromium-1243`, Linux build).
- Runner-installed Google Chrome **155.0.8059.39**.

One worker/no retries; fresh page/context/port/store for each capture. Mono,
44,100 Hz; observed quantum 128, checked using actual per-record lengths. Both
browser jobs were executed in each capture workflow. Per-browser source
versions and runtime metadata are preserved in artifacts.

Each browser/execution ran two original nine-case rounds (18), then five
repetitions each of short (1 s source), long (10 s), and main-thread workload
(3 s), for 15 v2 captures. The original rounds include 1/2/5/15-second windows
and a standalone concurrent OfflineAudioContext stress case; no Apex export path
was used. Workload remains 12 ms busy tasks every 20 ms. No capture tolerances
were changed.

## Results — separate outcomes

| Capture run | Browser | Legacy strict pass | v2 readiness | v2 startup-discontinuous runs | v2 post-ready continuity pass | v2 exact selected PCM |
|---|---|---:|---:|---:|---:|---:|
| 39562499637 | Chromium 153 | 18/18 | 15/15 | 15/15 | **14/15** | 15/15 |
| 39562499637 | Chrome 155 | 18/18 | 15/15 | 6/15 | 15/15 | 15/15 |
| 39563380457 | Chromium 153 | 18/18 | 15/15 | 9/15 | 15/15 | 15/15 |
| 39563380457 | Chrome 155 | **16/18** | 15/15 | 11/15 | 15/15 | 15/15 |

Across all 132: zero selected-window holes, overlaps, duplicated samples,
conflicting samples, sequence errors, nonfinite samples, producer-checksum
mismatches, reported receiver-checksum failures, storage aliasing, post-receipt
changes, or same-timestamp conflicting PCM blocks. Exact source alignment used
scheduled frame offsets, no correlation search. Maximum absolute PCM error,
RMS error and checked silence peak were all **zero**. All 60 v2 archive hashes matched
the archived test summaries. Legacy summaries have no reference raw-file hash,
so their 72 SHA-256 values were computed for identification, not compared with
a pre-existing summary reference. Reanalysis agreed with archived pass/fail outcomes.

The failed v2 capture's `measurementIntegrity=false` is deliberately broader than
selected-window coverage: it checks continuity from readiness through scheduling
lead and the selected end. Its source-window coverage was complete, but the
post-ready stream was not continuous. Startup discontinuities remain visible
for 41/60 v2 captures. They are not converted into full-stream passes.

### First v2 failure — retained exact identity

Execution 39562499637, Playwright Chromium workload repeat 2:

`39562499637-chromium-workload-2-73c39967-ab8c-4d9e-a1c9-c6a74b68023b`

Raw path inside the Playwright artifact:
`diagnostic-results/readiness/<run-id>.json.gz`

Raw SHA-256:
`0e8e6e0e1c2b83490af257aa76d2ae93b9141230a2b964847632c9fa6cd2ca48`

| Invocation | Expected frame | Reported frame | Classification |
|---:|---:|---:|---|
| 1 | 128 | 1024 | Startup discontinuity, retained |
| 35 | 5376 | **5248** | Duplicate frame AFTER readiness |
| 36 | 5376 | **5504** | Skipped frame AFTER readiness |

Invocation 34 already covered frame 5248; invocation 35 repeated it. Their PCM
was identical, not contradictory (`conflictingTimestampBlocks=0`). Sequence
numbers remained continuous, buffer/checksum/ID checks passed. This localizes
this observed duplicate upstream of receiver ordering/reconstruction. It does
not establish an exact browser or callback scheduling root cause.

Selected interval was `[16273,159598)`; source began 20683 and contained 132300
samples. All 143325 selected samples were present once and exact. The anomaly
occurred before this interval but after the readiness acknowledgement. It is NOT
silently reclassified as acceptable startup to make the run pass.

### Legacy strict failures

Chrome run 39563380457, `short-1` in EACH legacy round: invocation 1 expected
1024, reported 1536 (pre-window). Selected intervals and source samples were
complete and exact, but strict legacy stream continuity failed. Both raw files
are retained, even though their deterministic archive hashes are identical:
`c5a3dcfa10ae37ed6334166479f0bb0d12a15ec5c4f5db2656bc65cef1299403`.
Legacy records do not have v2 UUIDs; separate round directories identify them.

## Independent inspection and evidence access

Direct artifact/log downloads from this sandbox failed because GitHub redirected
to unavailable Azure/results hosts. No alternate credentials were used. A
GitHub-hosted inspection job downloaded the originals using Actions' normal
artifact action, then ran a separate **Python stdlib** verifier (not the TS
analyzer). It regenerates seeded float32 source samples, compares scheduled
frame offsets, reconstructs sample coverage, recalculates every block checksum,
checks v2 IDs, sequences/layouts and the actual 32-record readiness proof, and
compares v2 raw archive hashes against the original summaries. The legacy
protocol has no UUID or reference raw-file hash.

Compact results were retrieved through GitHub's check-annotation API. Transport
itself needed two test-only corrections: individual notices are silently truncated
at 4096 characters, and a step retains at most ten notices. Final publication
uses bounded fragments across four explicit steps. Both 66-record datasets were
reassembled from **all 34 fragments each** and their SHA-256 verified before
interpretation. No partial annotation array was accepted as a complete result.
The publisher was round-trip tested locally against all 15 preserved v2 records.
These are reporting fixes only, not changes to the capture or tolerances.

`hosted/evidence-manifest.json` contains artifact metadata and verified payload
hashes; `hosted/run-ledger.json` contains all 132 individual outcomes and first
error details; `hosted/raw-file-sha256.txt` identifies every raw archive. For legacy rows, `rawHashMatchesSummary` is the verifier's
default identification result, not an independent reference comparison;
`rawHashComparisonAvailable=false` makes that limitation explicit in the local
ledger. For v2 rows it is a real reference comparison. These new
compact report files are local deliverables; diagnostic source/workflow changes
through `a2e23bb` are pushed. Raw data remains on GitHub, not in Git.

### Downloadable workflow artifacts (expire 2026-11-20)

| Dataset | Artifact |
|---|---|
| First Chromium: raw, per-quantum metadata, summaries, logs | [12329025501](https://github.com/Ajey877/Apex-Studio/actions/runs/39562499637/artifacts/12329025501) |
| First Chrome: raw, per-quantum metadata, summaries, logs | [12329215741](https://github.com/Ajey877/Apex-Studio/actions/runs/39562499637/artifacts/12329215741) |
| Second Chromium | [12328498212](https://github.com/Ajey877/Apex-Studio/actions/runs/39563380457/artifacts/12328498212) |
| Second Chrome | [12328108982](https://github.com/Ajey877/Apex-Studio/actions/runs/39563380457/artifacts/12328108982) |
| Independent raw reanalysis of first execution | [12328654391](https://github.com/Ajey877/Apex-Studio/actions/runs/39564296460/artifacts/12328654391) |
| Independent raw reanalysis of second execution | [12329416990](https://github.com/Ajey877/Apex-Studio/actions/runs/39564296460/artifacts/12329416990) |

## Validation / scope

Each hosted capture job passed the 12 integrity unit tests and lint/build in both
executions. All capture cases ran with retries disabled. Capture execution 1
failed its v2 step as expected; execution 2's green job status is NOT evidence
that its tolerated legacy errors passed. Inspection jobs completed independently.
No first failure was deleted or rerun in place.

The exact old **different-PCM/same-timestamp** failure was NOT reproduced. A
same-timestamp/identical-PCM metadata duplicate now HAS been independently
observed after readiness on a clean host. Only one v2 run reproduced that
post-ready pattern, so no exact root cause is claimed. Startup anomalies are
not exclusive to the sandbox. The 32-quantum contract is auditable and detects
corruption, but is not sufficient to guarantee uninterrupted future callbacks.

Next justified task: keep the gate closed; isolate post-ready source scheduling
and arm/port lifecycle in the minimal graph, one operation at a time. Instrument
callback entry/exit, command receipt and source-start scheduling; repeat enough
fresh contexts to reproduce the frame-5248 pattern before claiming cause. Do not
just extend warmup or exclude scheduling-lead anomalies to manufacture a pass.
No Apex stage or automation parity should proceed until this is resolved or a
separately justified measurement contract is repeatedly validated.

## Per-run outcomes

Every row below has exact selected PCM (max/RMS error zero), complete unique
selected samples and passing producer/receiver ownership checks. `Strict` is the
archived test outcome, not the workflow job color. `Pre` counts retained startup
or pre-window anomalies; `Post` counts post-ready/window anomalies. V2 readiness
is independently verified; the legacy protocol has no readiness acknowledgement.

| Execution | Browser | Protocol / capture file | Ready | Pre | Post | Selected samples | Strict |
|---|---|---|---|---:|---:|---:|---|
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-long-0-81a43b1a-6d39-4af2-af25-b04afe4e86ad | True | 0 | 0 | 452025/452025 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-long-1-f394d337-d06f-4410-805e-d9e150ee7b2b | True | 0 | 0 | 452025/452025 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-long-2-06b2ba9e-3e72-44d2-8797-1a12d3614359 | True | 0 | 0 | 452025/452025 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-long-3-201ac05c-e896-4d2e-8f8a-a149fea6c0b2 | True | 1 | 0 | 452025/452025 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-long-4-8b53d615-92fa-49f5-aa39-7a757dd8f388 | True | 0 | 0 | 452025/452025 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-short-0-716e0cab-6edd-4baf-a6c1-c339ee5a2806 | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-short-1-7d6795ef-cb4b-4840-bc6f-f08eb83713b4 | True | 0 | 0 | 55125/55125 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-short-2-2b6bd831-1d4e-4fd0-af98-31bcec80522f | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-short-3-10e404b8-56fe-4566-8ee4-8c945d1e8c15 | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-short-4-b206eba3-c11e-47b2-927e-367fb3d476d0 | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-workload-0-840c992f-9a10-44c7-8a30-29473d428934 | True | 0 | 0 | 143325/143325 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-workload-1-ab0d42c4-31a6-44b7-b2ae-9780c31714b6 | True | 1 | 0 | 143325/143325 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-workload-2-497d70a2-24bb-4a09-9e62-84c76bfbe35b | True | 0 | 0 | 143325/143325 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-workload-3-0dfcd73d-d4c0-477b-b7cf-9f13512ac9b8 | True | 0 | 0 | 143325/143325 | pass |
| 39562499637 | 155.0.8059.39 | readiness-v2: 39562499637-chromium-workload-4-434dfc2d-7e5e-4452-a17b-b7a4aab015e1 | True | 0 | 0 | 143325/143325 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/short-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-1/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/short-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39562499637 | 155.0.8059.39 | legacy: hosted-chrome-2/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-long-0-00a91163-d6ff-42ab-9063-4e373c4833af | True | 1 | 0 | 452025/452025 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-long-1-b36e4cc1-88f4-4fa8-b600-856d67017999 | True | 1 | 0 | 452025/452025 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-long-2-cc0e6dfb-4bcf-45a1-b20e-629e22b3f4db | True | 1 | 0 | 452025/452025 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-long-3-f8eccdff-47df-4e3b-acd9-ec2ed6536691 | True | 1 | 0 | 452025/452025 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-long-4-89793773-0d21-42b7-8ee2-5d84da304eca | True | 1 | 0 | 452025/452025 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-short-0-198c4e99-3bb8-462e-bdd5-82f200d52cdc | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-short-1-4e1ba1c0-c6f4-4e95-994d-0723c1435bac | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-short-2-60dcb051-68c1-48ee-a0f3-4d182f1c5d52 | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-short-3-515773ff-26a2-46ca-98b0-b79099a9e749 | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-short-4-7a0348d7-1d28-47d3-858e-30ac836c0c7c | True | 1 | 0 | 55125/55125 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-workload-0-155cd8ab-760a-46af-8e9c-a440d5f42942 | True | 1 | 0 | 143325/143325 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-workload-1-976b0dd2-35fb-4cca-ad03-1d6359ace7f0 | True | 1 | 0 | 143325/143325 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-workload-2-73c39967-ab8c-4d9e-a1c9-c6a74b68023b | True | 1 | 2 | 143325/143325 | **FAIL** |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-workload-3-0532d7cb-86c1-44b0-923a-43ef981801ae | True | 1 | 0 | 143325/143325 | pass |
| 39562499637 | 153.0.8010.12 | readiness-v2: 39562499637-chromium-workload-4-8667a05e-8b23-4537-808b-a50dfced2c39 | True | 1 | 0 | 143325/143325 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/short-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-1/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/short-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39562499637 | 153.0.8010.12 | legacy: hosted-playwright-2/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-long-0-f37423dd-374d-43b3-b4fd-8cad6eb6c0f0 | True | 1 | 0 | 452025/452025 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-long-1-75bef93c-c5f2-4831-a3ce-aea3e0c09606 | True | 0 | 0 | 452025/452025 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-long-2-cae55737-12c5-4b27-aa67-02a39530812e | True | 1 | 0 | 452025/452025 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-long-3-d2d62c44-b9f4-468a-8890-b1fecce3a939 | True | 0 | 0 | 452025/452025 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-long-4-cd2f3c33-ce88-41d5-9d72-90fd43cdcf64 | True | 1 | 0 | 452025/452025 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-short-0-111d9f97-5aec-405b-ab8d-92a38219d883 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-short-1-f90f9e3d-bff1-41c0-9f46-9403f3140be3 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-short-2-66b735d6-b536-47f0-9b31-dd944eb47c78 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-short-3-f55eccf5-e7fb-474e-bc17-67604a4e0722 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-short-4-d16cd497-7d41-42da-a7ac-e21d7f2a5124 | True | 0 | 0 | 55125/55125 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-workload-0-2456217f-96ca-44c9-869f-f24e0184af46 | True | 1 | 0 | 143325/143325 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-workload-1-de6c24a4-cdc1-4154-95c0-710fc03159d4 | True | 1 | 0 | 143325/143325 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-workload-2-a4a77fa0-c71f-48a9-9ccc-dd14cb41fc01 | True | 1 | 0 | 143325/143325 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-workload-3-a9eed956-17be-4cb9-9a2e-98ea7113770f | True | 1 | 0 | 143325/143325 | pass |
| 39563380457 | 155.0.8059.39 | readiness-v2: 39563380457-chromium-workload-4-5f58c4bf-acb1-4114-ad14-8ae1890b036b | True | 0 | 0 | 143325/143325 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/short-1 | n/a | 1 | 0 | 44100/44100 | **FAIL** |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-1/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/short-1 | n/a | 1 | 0 | 44100/44100 | **FAIL** |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39563380457 | 155.0.8059.39 | legacy: hosted-chrome-2/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-long-0-948186a5-13bf-4bad-bfd4-59e2ee537bab | True | 0 | 0 | 452025/452025 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-long-1-3d28ed19-405c-40eb-a2f0-ffbc3dfdb901 | True | 0 | 0 | 452025/452025 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-long-2-52a0c0cc-65fa-4253-9865-87f9e17a01a6 | True | 1 | 0 | 452025/452025 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-long-3-78769f44-fbf6-4f48-8cc0-325d698b5ba5 | True | 1 | 0 | 452025/452025 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-long-4-1aeed9d9-99af-41b7-9987-dbdfdac1a3cb | True | 0 | 0 | 452025/452025 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-short-0-e2fcacbc-68e7-4bbe-9dea-c41ae3fcc048 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-short-1-7f301829-1d79-47c3-9be2-20ff8e3616d2 | True | 0 | 0 | 55125/55125 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-short-2-92471bba-85cb-4f06-b9f7-05b5cf83dee7 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-short-3-4b87663e-4f96-42ee-9abf-1b421a1e91b3 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-short-4-44256c9d-1ed1-4b46-ba00-8c9bac28fa43 | True | 1 | 0 | 55125/55125 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-workload-0-af592aca-96c8-455b-995e-5016acaaf017 | True | 1 | 0 | 143325/143325 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-workload-1-01714c62-3027-484f-922f-21944c6da610 | True | 0 | 0 | 143325/143325 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-workload-2-88a45b15-ea1a-42fc-acc3-ee692f6ffdac | True | 1 | 0 | 143325/143325 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-workload-3-b24a0047-9e43-4c4d-aeae-3761f73b1d0a | True | 0 | 0 | 143325/143325 | pass |
| 39563380457 | 153.0.8010.12 | readiness-v2: 39563380457-chromium-workload-4-cb9c7460-ee74-4e33-b862-efcb609e77f5 | True | 1 | 0 | 143325/143325 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/short-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-1/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/extended | n/a | 0 | 0 | 661500/661500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/long-1 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/long-2 | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/offline-contexts | n/a | 0 | 0 | 220500/220500 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/repeat-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/repeat-2 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/short-1 | n/a | 0 | 0 | 44100/44100 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/workload-1 | n/a | 0 | 0 | 88200/88200 | pass |
| 39563380457 | 153.0.8010.12 | legacy: hosted-playwright-2/workload-2 | n/a | 0 | 0 | 220500/220500 | pass |
