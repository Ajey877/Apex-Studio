# Post-merge: packaged native VST3 + live input coexistence failure at `98b8e81`

**Status: mechanism PROVEN · production fix NOT MADE · packaged Windows acceptance NOT VERIFIED**

This document records an investigation. It does not record a fix, because no
production defect in this repository was found that can be fixed without
weakening a real-time guarantee. That conclusion is the deliverable, and the
evidence for it follows. Nothing below was inferred from a deadline counter
alone; every claim is either an executed test, a source citation, or a quoted
field from the run's own annotations.

---

## 1. Baseline, verified before anything changed

| item | value |
|---|---|
| remote | `https://github.com/Ajey877/Apex-Studio.git` |
| `origin/main` at investigation start | `98b8e81b8536d0fc16b1910fa2f7f381fc6ed8db` |
| commit | "Merge pull request #308 from Ajey877/arena/0a7185bd-apex-studio", Ajey, Fri Nov 27 12:15:54 2026 +0530 |
| parents | `c313e8a` (base) + `75d696f` (Phase 12 docs) |
| newer commits fixing it | **none** — `git log origin/main` tops out at `98b8e81` |
| remote branches | `main`, `arena/0a7185bd-apex-studio` |
| worktrees | one |
| open PRs, untouched | `#237` (open), `#205` (draft) |
| failing run | Desktop Validation `45953961366`, `event: push`, `head_sha 98b8e81`, `run_attempt 1` |
| failing job | `windows-package` id `140356010397` |

The local checkout sat at `c313e8a` with 13 uncommitted files. Before touching
them, all 13 were proven byte-identical to `origin/main` with
`git hash-object` vs `git rev-parse origin/main:<path>` (13 identical, 0
differing), then the tree was reconciled to `98b8e81`. That is why the working
tree is clean rather than carrying redundant copies of already-merged work.

**The Phase 12 change is exonerated, and this is decisive rather than
rhetorical:**

```
git rev-parse 75d696f^{tree}   -> c461abddcd44b9164c3780130366140e1c4de5fd
git rev-parse 98b8e81^{tree}   -> c461abddcd44b9164c3780130366140e1c4de5fd
git diff --stat 75d696f 98b8e81 -> (empty)
```

The failing post-merge run and the passing PR run used **bit-identical source**.
`98b8e81` is a merge commit whose tree adds nothing to `75d696f`.

---

## 2. What actually failed

Job `windows-package` steps, read from the jobs API rather than inferred:

| step | verdict | name |
|---|---|---|
| 17 | **PASS** | Packaged Windows live input PCM and recording acceptance (fake microphone) |
| 18 | PASS | Upload live input acceptance evidence |
| **19** | **FAIL** | Packaged native VST3 + live input coexistence acceptance |
| 20 | PASS | Upload native VST3 + live input coexistence evidence |
| 21 | PASS | Cold-start deadline diagnostic (high volume, non-gating) |
| 22 | PASS | Upload cold-start diagnostic evidence |
| 23 | SKIP | Native VST3 editor acceptance through the packaged application |
| 24 | PASS | Record the cold-start diagnostic verdict |
| **25** | **FAIL** | Record the packaged acceptance verdict |
| 26 | PASS | Upload measured production VST3 evidence |
| 27 | SKIP | Upload Windows package |

Two of the three red marks are consequences, not independent failures. Step 23
was *skipped by its `if` condition* because step 19 failed, so **the packaged
editor acceptance did not run at all** — its status is NOT VERIFIED, not failed.
Step 25's name is accurate: it records the verdict, and the verdict was failure.

Step 19 failed in **3 m 43 s**, not at a 30-minute timeout: the warmup loop
expires at its own 60 s bound and the run stops there.

---

## 3. The mechanism, proven

### 3.1 The reported symptom

Two annotations with title `Packaged native VST3 coexistence failed at stage
'arm-probe'`, both carrying:

```
Warmup timed out: waitedMs=60015 of 60000  prepared=false
processedBlocks=3  priorBlocks=3  deadlineMisses=1  nativeFailures=0
failureMessages=[]
nativeDiagnostics=[{"trackId":1,"slotId":"vst3-fx-...",
  "message":"Native effect missed its real-time processing deadline;
             playback stopped rather than replaying stale PCM."}]
blockBudgetMs=21.3333  mainEventLoopLagMaxMs=71.12
```

`prepared=false` with `processedBlocks` frozen at 3 for the whole minute.

### 3.2 The chain, each link cited

1. **The budget.** `nativeVst3EffectRuntime.ts` uses
   `VST3_FX_BLOCK_FRAMES = 1024` and `VST3_FX_PIPELINE_FRAMES = 2048`, so block
   *N* is submitted at input frame `(N+1)*1024` and needed at output frame
   `2048 + N*1024`. The slack is exactly one block: **21.33 ms at 48 kHz**, which
   is `blockBudgetMs` in the evidence.

2. **One round trip exceeded it.** The recovered per-block decomposition shows
   the first blocks healthy and then one spike:

   | sequence | totalRoundTripMs | nativeServiceCallMs | budgetMs | accepted |
   |---|---|---|---|---|
   | 0 | 7 | 4.60 | 21.33 | true |
   | 1 | 7 | 4.01 | 21.33 | true |
   | **2** | — | **23.5022** | **21.3333** | — |

   Sequence 2 exceeded the budget by 2.17 ms. Its 23.28 ms helper round trip is
   accounted for by `helperPipeAndScheduleMs=11.1951` plus
   `helperInstanceProcessMs=10.8238`, which are two contributors that each fit
   the budget alone.

3. **The guard fails closed.** With block *N* still `pending` at its due frame,
   the per-sample path calls `reportPendingDeadlineMiss()` and
   `fail(PENDING_DEADLINE_MISSED)`.

4. **The worklet latches.** `fail(reason)` sets `this.failed = true`, clears
   `ready` and `dryReady`, and posts `{type:'failure', reason}`.
   `PENDING_DEADLINE_MISSED`'s text is verbatim the string in
   `nativeDiagnostics` above — this is where the reported message comes from.

5. **The session ends.** The control side receives `{type:'failure'}` and calls
   `fail(entry, reason)` → `reportVst3MixerEffect()` and
   `this.onFatal(...)` → `disposeEntry(entry)`, which removes the entry from
   `this.prepared`, so `isPrepared()` returns **false** — `prepared=false`.

6. **The transport stops.** `onFatal` is constructed as
   `new NativeVst3EffectRuntime(() => { this.stop(); })` in
   `audioEngine.ts:873`. The engine genuinely stops. The message is not
   metaphorical: playback really did stop rather than replay stale PCM.

7. **The count can therefore never advance.** `processedBlocks` is the number of
   completed worklet results. The acceptance warmup requires
   `prepared && processedBlocks > priorBlocks` within 60 s. Both halves are
   false and stay false, so the loop always expires and reports `arm-probe`.

Steps 4–7 were reproduced **executed, against the real shipped worklet source**,
by the test file added in this branch (see §4), not by reading the code.

### 3.3 Why "3" is the freeze point

The worklet stops submitting and stops accepting at the latch, and the engine
stops the transport, so nothing further can complete. The frozen value is
however many blocks had completed when the guard fired. Note the two mechanisms
are *redundant* — either the latch alone or the transport stop alone would
freeze the count — and the source shows both happen on the same event.

---

## 4. Why no production fix was made

The obvious candidates were each eliminated against the project's own evidence
and the constraints under which this work was commissioned.

These candidates are separated by how much is actually established, because the
three categories are not interchangeable.

**PROVEN — the fail-closed path is not the defect.** What is proven is the chain
in §3: a late result trips the guard, the entry is faulted and disposed,
`onFatal` stops the transport, and the warmup then cannot be satisfied. Every
link of that is executed in the tests on this branch or cited in the shipped
source. Nothing in that chain is broken behaviour; it is the guarantee working.

**PROVEN — the plug-in itself did not cause the latency.** The 60-run
diagnostic has instrumented eight failures with a full decomposition, and
`processor->process(data)` — the plug-in callback alone — never exceeded
**0.03 ms**, in a failing block or any neighbour.

**SUPPORTED BUT NOT ISOLATED — host/OS scheduling contention is the likely
explanation for the latency outlier.** The time is spread across host work and
OS scheduling with **no single contributor**: across the eight, host preparation
spiked to 13.26 and 12.59 ms, output collection to 7.68 ms, pipe plus OS
scheduling to 15.85 and 14.28 ms, main→renderer to 9.71 ms, and main-thread
event-loop lag reached 10.48 ms. The failing run's own
`mainEventLoopLagMaxMs=71.12` (against 48.88–55.09 ms on the passing run of the
*same tree*) is consistent with contention. **Consistent with** is the correct
strength: no experiment here holds load constant and varies one component, so
contention is the leading hypothesis that fits all the observations, not a
localised cause. A pre-warm addresses only the cold window and would not explain
the mid-session misses below, which is part of why it was never adopted.

**STILL UNRESOLVED — whether this is specific to hosted CI runners.** Nothing in
this investigation measures an ordinary user's machine. It is entirely possible
that the same latency outlier can occur under real-world load — a thermal-throttled
laptop, a busy audio interface driver, a machine under memory pressure — and if it
does, **a genuine missed deadline still stops playback.** The fail-closed design
means that outcome is a correct refusal, but it is a DAW reliability risk for the
user regardless, and this PR does not remove it. It only makes it diagnosable.

**The miss is not even confined to cold start.** The guard-named sequences across
those failures were 0, 2, 2, 2, 3, 3, **57** and **149** — two of eight well
past the helper's cold window. A pre-warm would not address them, and pre-warming
was already recorded as *supported but not proven* as a hypothesis.

**The guard must not be relaxed.** It is what stops playback instead of
replaying stale PCM, which is precisely the behaviour the constraints protect.
Loosening the 21.33 ms budget, or letting a latched insert resume, would be
weakening a real-time guarantee to make a test go green — explicitly forbidden.

**The acceptance must not be relaxed either.** Its warmup is the load-bearing
assertion; it was added precisely to catch this, and removing it would hide the
condition. Reducing the 5 reps, making the gate optional, adding
`continue-on-error`, retries or sleeps are all forbidden.

**So the remaining honest conclusion is that this is a measurement-design
problem, not a code defect.** The gate is a conjunction of 5 independent
per-run events, each of which fails with small probability `p` from CI
contention:

| sample | failures | per-run `p` | implied `P(gate 5/5 passes)` |
|---|---|---|---|
| `1803ac2`, 60 reps | 10 | 0.167 | 0.40 |
| `98b8e81`, 60 reps | 3 | 0.050 | 0.77 |
| `75d696f`, 60 reps | 1 | 0.017 | 0.92 |
| `68cdd20`, 37 reps | 1 | 0.027 | 0.87 |
| `71013f7`, 60 reps | 4 | 0.067 | 0.71 |
| `20b7637`, 60 reps | 9 | 0.150 | 0.44 |
| **pooled** | **24 / 337** | **0.071** | **0.69** |

**Read the ≈30 % figure as an estimate under an assumed model, not a measured
universal probability.** It follows only if two things hold: each repetition is
independent, and `p` is stationary (constant across runs and load conditions).
Under that model, `1 - (1 - 0.069)^5 ≈ 0.30`. Neither assumption is established.
The observed 2-pass / 1-fail record over three runs is far too small to test
them, and the recorded 4-in-60-then-0 on byte-identical code is itself evidence
that `p` is *not* stationary — it moves with runner load. If `p` is
load-dependent, the true gate failure rate is a mixture over load states and will
differ from 30 %, possibly substantially. The estimate is useful for deciding
that the gate is unreliable, and it is not a number to quote as the gate's
failure rate.

The further caveat is that the 60-run diagnostic executes at a different point in
the job than the gating 5 runs, so these are estimates of `p`, not a direct
measurement of the gate.

Fixing *that* means changing how the gate aggregates independent real-time
events — a product decision about what the gate should assert, not a bug fix.
The legitimate options, none of which were taken unilaterally:

- **A** — gate on a property that is deterministic, and demote the 5-run
  coexistence result to the recorded-diagnostic lane, since it is already
  measured at 60 reps in the same job (step 21, non-gating).
- **B** — keep 5 gating reps but treat *recovery* as the required property: a
  transient miss must be recoverable by re-preparing, which the product already
  supports.
- **C** — invest in removing the contention itself (dedicated or larger runner),
  which is infrastructure, not code.

Option **B** rests on recovery being real, and recovery is **tested at the
runtime level, not end-to-end**. Test 10 drives the shipped
`NativeVst3EffectRuntime` with a real recorded worklet failure message and
observes that the faulted entry is disposed and that the next Play opens a fresh,
usable session. What it does not cover is `audioEngine.stop()` (which the app's
`onFatal` calls), the real native helper (mocked), or the packaged application.
So option B is *supported by a product-path test* and is **not** verified as a
user-visible guarantee. See §11.

---

## 5. What this branch does contain

`src/audio/nativeVst3DeadlineLatch.test.ts` — 10 tests, in **two layers**, and the
distinction matters for what each one can claim.

**Tests 1–9 — the shipped worklet**, evaluated from `VST3_FX_WORKLET_SOURCE` in a
sandbox, the same methodology as `nativeVst3PendingGuardBoundary.test.ts`.
Control-port and live-port messages are delivered only between `process()` calls,
as the audio thread requires; every step is a synchronous call in a known order,
so there is no wall-clock race and no sleep, retry or relaxed timing anywhere.

**Test 10 — the shipped runtime.** It drives the real `NativeVst3EffectRuntime`
through `ensureTracksPrepared`, using the same narrow seams
`nativeVst3EffectRuntime.test.ts` already uses (`getBridge` injection and the
`AudioWorkletNode` global). The worklet's failure message is *captured from the
shipped worklet* rather than hard-coded, so the disposal it triggers is the real
one. The native helper is a bridge mock and `audioEngine.stop()` is not involved —
see §11 for exactly what that leaves unverified.

It fills the gap the failing run exposed: `nativeVst3PendingGuardBoundary.test.ts`
pins **when** the guard fires, but nothing pinned **what the session looks like
afterwards**, which is the layer that turns a real-time hiccup into a 60 s warmup
timeout and a red gate.

Every assertion states a **requirement that must keep holding**. None of them
asserts a defect, and none of them would start failing if the contention were
somehow removed:

1. one over-budget round trip trips the guard with the exact production text
2. the miss is reported on the due frame, not one frame early (`ead88bb`)
3. a latched insert emits silence for the rest of the session — never dry or
   stale audio
4. the request stream stops at the latch, so nothing queues without bound
5. a helper that never answers still fails closed
6. a result arriving after the latch is refused, so no stale PCM is replayed
7. a duplicate delivery is rejected **in a healthy session, with no latch** — the
   accepted-block count does not increase and the duplicate's audio is never
   rendered, so this proves duplicate handling rather than failure handling
8. the coexistence warmup predicate can never be satisfied after a latch — the
   arm-probe timeout's actual mechanism
9. a latched insert stops posting diagnostics: no message storm on the audio
   thread
10. the real runtime disposes a faulted entry and the next Play, issued **before
    that disposal finishes**, prepares a fresh, usable session — while refusing to
    revive the faulted one

### 5.1 Verified load-bearing by mutation, not by inspection

Every row below was re-run against the corrected tests on this branch.

| mutation | outcome |
|---|---|
| remove **both** fail-closed output guards | **caught by test 9** — without them a latched insert posts one diagnostic per quantum, **376 in one second**, forever |
| accept results after the latch (replay stale PCM) | **caught by test 6** |
| revert `ead88bb` (guard fires one frame early) | **caught by 1, 2, 6** |
| remove **both** pending-guard paths | **caught by 1, 2, 5, 10** |
| drop the `sequence === pending` term, so a duplicate is re-adopted | **caught by test 7** |
| runtime ignores the worklet failure message (no disposal) | **caught by test 10** |
| allow reuse of a latched entry (drop `disposed`, `stopping` **and** `faulted`) | **caught by test 10** |
| drop **only** the `faulted` term | **survives** — see below |
| remove **only** the outer pending-guard path | **correctly invisible** — the inner per-sample path catches the same overdue block; documented in test 5 |

Two rows deserve calling out, because both are cases where a test looks like it
proves more than it does.

**The first mutation survived until test 9 existed.** It is easy to assume the
second `failed` guard in `process()` is redundant, and it is not — `fail()` clears
both queues, so without the guard every later quantum finds its block missing in
the output loop, posts another `deadline-miss` event and breaks. `postMessage`
from the audio thread is the one operation here that is not real-time safe.

**Dropping only the `faulted` term survives, and that is expected.** Recovery is
protected by defence in depth: `fail(entry, ...)` calls `disposeEntry`, which sets
both `disposed` and `stopping` before the asynchronous disposal finishes, so those
two terms already block reuse even with `faulted` removed. Test 10 therefore pins
the **observable product behaviour** — a failed insert is disposed and the next
Play, even one issued before that disposal completes, prepares a fresh usable
session — and not any single intermediate term. It is also why the duplicate
test 7 had to be rewritten: the old version's assertion could be satisfied by the
latch rather than by duplicate handling, and a uniqueness check over a one-element
list cannot fail.

---

## 6. Verification

Run locally, Linux, Node v22.22.3. Test counts are unchanged from before the
test-quality corrections: test 7 and test 10 were replaced in place, so the file
still contributes 10 tests.

| command | exit | result |
|---|---|---|
| `npx tsx --test src/audio/nativeVst3DeadlineLatch.test.ts` | 0 | 10 / 10 |
| `npm run test:audio` | 0 | **2592 / 2592**, 485 suites (2582 before this file existed) |
| `npm run test:history` | 0 | **1283 / 1283** |
| `npm run test:all` | 0 | **4018 / 4018**, 613 suites (4008 before this file existed) |
| `npm run lint` (`tsc --noEmit`) | 0 | clean |
| `npm run build` | 0 | built in 7.29 s |

`npm run test:audio` runs `verify-test-discovery.mjs` first, so the new file is
confirmed covered rather than orphaned. `package-lock.json` was restored with
`git checkout --` after installing, so the lockfile is untouched.

### PASS / FAIL / NOT VERIFIED

**PASS**
- The failure mechanism, executed against the real shipped worklet source.
- The regression suite for it, including mutation coverage.
- The full local regression matrix above.
- That Phase 12 did not cause the failure (identical trees).
- That packaged live-input PCM (step 17) passed on the failing run.

**FAIL**
- Desktop Validation `45953961366`, job `140356010397`, step 19, on `98b8e81`.
  Unfixed and unchanged by this branch; it remains intermittent by nature.

**NOT VERIFIED — and these are the constraints that bind this work**
- **Packaged Windows acceptance was not run.** This environment is Linux
  (`process.platform === 'linux'`) with no Windows runner, no wine and no
  `makensis`, so `npm run package:win` and
  `packaged-native-monitoring-acceptance.mjs` cannot execute here at all. A
  packaged-Windows PASS cannot be claimed, and no result here should be read as
  one.
- **The packaged editor acceptance (step 23) never ran** — it was skipped
  because step 19 failed. Its status is unknown, not passing.
- **The four evidence artifacts were not opened.** All four are present and
  unexpired (`apex-packaged-vst3-evidence` 421,837 B, `…-native-diagnostic-…`
  669,245 B, `…-native-monitoring-…` 98,904 B, `…-live-input-…` 1,381 B), but
  `gh api .../artifacts/<id>/zip` returns 0 bytes and `gh api -i` shows a 302 to
  `productionresultssa1.blob.core.windows.net` followed by `EOF`: that host is
  outside this environment's allowlist. Job logs are unreachable for the same
  reason. Everything here about the run is therefore from
  `check-runs/<id>/annotations`, which are hard-truncated at ~3,900 characters —
  which is why the `coldStartBlocks` array is cut off after sequence 2 and
  sequences 3+ could not be read.
- **Physical hardware.** The microphone is Chromium's fake capture fixture and
  the insert input is a deterministic buffer. No acoustic or hardware
  equivalence is claimed.
- **Whether the contention can be removed.** That needs a different runner.

---

## 7. Limits

- The per-run `p` values are estimates from a diagnostic that runs 60 times at a
  different point in the job than the gating 5.
- Only three sequences of cold-start decomposition survived the annotation
  truncation, so sequences 3+ are unread. The conclusion does not depend on
  them — the guard names the sequence it abandoned, and it named 2 here.
- The fix for the *contention* is not in this repository's control.
- This branch changes no production code, so it cannot make the gate greener. It
  exists to make the next failure diagnosable in one line instead of a
  three-hour investigation, and to record that the remaining problem is a
  measurement-design decision rather than a defect to be patched.

---

## 8. Postscript: the packaged Windows acceptance DID run, and it passed

Written after PR #309's own Desktop Validation completed. This section supersedes
§6's "packaged Windows acceptance was not run" for the *production* path — the
test file added here is unmodified production code, so this is a genuine
packaged-Windows run of the path the investigation concerns.

**Run `45964493931`, job `140389814676` — conclusion `success`, 54 m 21 s.**

| step | verdict | name |
|---|---|---|
| 17 | **PASS** | Packaged Windows live input PCM and recording acceptance (fake microphone) |
| 19 | **PASS** | Packaged native VST3 + live input coexistence acceptance |
| 21 | **PASS** | Cold-start deadline diagnostic (high volume, non-gating) |
| **23** | **PASS** | Native VST3 editor acceptance through the packaged application |
| 25 | PASS | Record the packaged acceptance verdict |
| 26 | PASS | Upload measured production VST3 evidence |
| 27 | PASS | Upload Windows package |

Step 23 is the one that was **skipped** on the failing run `45953961366`. It ran
and passed here, so the packaged editor acceptance is no longer NOT VERIFIED.

**Both** coexistence lanes passed, from the annotations:

```
{"status":"PASS","passedRuns":5,"requestedRuns":5,  "deadlineMisses":0,"nativeFailures":0}
{"status":"PASS","passedRuns":60,"requestedRuns":60,"deadlineMisses":0,"nativeFailures":0,
 "helperProcessesLeakedAfterShutdown":[],"physicalHardware":"NOT_VERIFIED"}
```

with gating blocks before/during/after `23/79/77` and diagnostic
`23/80/77`, and the diagnostic's per-repetition verdicts a clean 60-character
run of `P`.

### Read this result correctly

**It is not a fix, and it is not evidence that the mechanism in §3 is wrong.**
Zero failures in 60 puts the per-run miss rate's plausible upper bound around
5 % (rule of three: 3/60), which is entirely consistent with the instrumented
pooled estimate of 6.9 % and with the previously recorded "4 failures in 60 and
then 0" on byte-identical code. The production code here is unchanged, so the
contention that causes the miss was simply absent for 64 consecutive repetitions.

The prediction that follows is falsifiable and stands: **a re-run of the same
gate can fail again on this same tree** with the same `arm-probe` signature. That
is what §4's probability model says, and it is why the measurement-design
decision remains open rather than being closed by a green run. If a future run
fails at `arm-probe`, §3's chain explains it in one line.

### What changed in the PASS/FAIL/NOT VERIFIED split

- **PASS** — packaged Windows coexistence 5/5 gating and 60/60 diagnostic, both
  with `deadlineMisses=0`; packaged live-input PCM (fake microphone); packaged
  editor acceptance (step 23); native DAW integration; editor session/recovery
  contract; editor/audio helper separation with real PIDs; packaged runtime
  smoke; Windows package built and uploaded.
- **FAIL** — nothing in this run. Run `45953961366` step 19 remains the
  historical failure, unfixed and intermittent by nature.
- **NOT VERIFIED** — physical hardware (fake capture fixture, deterministic
  insert buffer; no acoustic equivalence claimed); the four evidence-artifact
  zips (still redirect to a blob host outside this environment's allowlist);
  whether the contention can be removed, which needs a different runner.

---

## 9. Postscript 2: the same build failed 1 h 20 m after it passed 60/60 — the natural experiment

This section is the strongest evidence in this document, and it arrived by
accident: pushing the §8 documentation commit re-ran Desktop Validation on the
same source, and **it failed again with the identical signature.**

Run `45971762495`, job `140413641840`: **conclusion `failure`**.

| step | verdict | name |
|---|---|---|
| 17 | PASS | Packaged Windows live input PCM and recording acceptance (fake microphone) |
| **19** | **FAIL** | Packaged native VST3 + live input coexistence acceptance |
| **21** | **PASS** | Cold-start deadline diagnostic (high volume, non-gating) — **60/60** |
| 23 | SKIP | Native VST3 editor acceptance through the packaged application |
| 25 | FAIL | Record the packaged acceptance verdict (consequential) |

### The trees are identical where it matters

```
git diff --stat 1364d88 de1c928
  .../reports/POSTMERGE_COEXISTENCE_INVESTIGATION.md | 65 ++++++++++++++
```

The **only** difference is this document. `src/`, `native/`, `scripts/` and
`.github/` are byte-identical, and the shipped worklet source hash is the same
object at all three points:

```
1364d88:src/audio/nativeVst3EffectRuntime.ts -> 5cf8a20492510b83f8dfe83a81c08bab1b514485
de1c928:src/audio/nativeVst3EffectRuntime.ts -> 5cf8a20492510b83f8dfe83a81c08bab1b514485
98b8e81:src/audio/nativeVst3EffectRuntime.ts -> 5cf8a20492510b83f8dfe83a81c08bab1b514485
```

### What the same build did, in order, within 80 minutes

| time (UTC) | run | gating 5-rep coexistence | 60-rep diagnostic |
|---|---|---|---|
| 08:17–09:11 | `45964493931` | **PASS 5/5** | **PASS 60/60** |
| 09:33– | `45971762495` | **FAIL**, first repetition, 1.6 min | **PASS 60/60** |

The gate failed on its **first** repetition — so it completed no successful
repetition at all (`[acceptance] Cold-start aggregate: reps=1,
perRepetitionVerdicts="F"`) — while in the same job, minutes later, the 60-rep
diagnostic recorded a clean 60-character run of `P` with `deadlineMisses=0`.

### The failure was captured with the corrected correlation, and it confirms §3 exactly

This is the first run in this investigation where the failing block's own
decomposition survived. From `[acceptance] Cold-start detail run 1 (FAIL)`:

```
status              FAIL     capturedAt  failure
worstTotalRoundTripMs  7     worstMarginMs  14.33     blockBudgetMs  21.33
missedSequences     [2]      mainRecordedSequences  [0, 1, 2]
resultsAccepted     2        resultsRejected        1
deadlineMissEvents  [{"guard":"pending-deadline-miss","sequence":2,"phase":"cold",
                      "currentOutputFrame":4096,...}]
rejections          [{"seq":2,"reason":"after-failure","pending":2,
                      "recvFrame":4224,"dueFrame":4096,"rtt":28}]
```

Three things to read carefully.

1. **The miss is sequence 2 at output frame 4096** — `2048 + 2*1024` — which is
   the arithmetic §3 link 1 predicts, and the same sequence the failing
   production run named.
2. **The late round trip is `rtt=28` ms against a 21.33 ms budget**, delivered at
   frame 4224 against a due frame of 4096 — i.e. **128 frames, one full render
   quantum, late**. It was correctly rejected as `after-failure`, so no stale PCM
   was replayed. That is test 6's requirement, observed in production.
3. **`worstMarginMs=14.33` is a trap, and it is not a contradiction.** The
   `warmupSnapshotRetained` was captured at the warmup stage and covers only the
   blocks recorded *then*. The 28 ms round trip that actually missed was captured
   later, on the failure path. The extractor correlates a round trip to a missed
   block only when the result was **accepted** (`2f94494`), and this one
   was rejected, so the miss's own round trip does not appear in the warmup
   block's totals. Reading `worstMarginMs=14.33` as "nothing was late" would
   repeat the positive-margin artefact the project already documented and
   corrected; the `deadlineMissEvents` and `rejections` entries are the
   authoritative record.

### The decisive statistic

The **same binary** passed 60 consecutive cold repetitions and then failed its
first one. A 60/60 diagnostic pass therefore carries no information about
whether the next run will fail — which is precisely why §4 refused to treat the
green run as a fix, and why the gate's 5-repetition conjunction is the wrong
instrument for a per-run event at `p ≈ 5 %`.

Combining every observation in this document (~283 gating repetitions' worth of
diagnostic sampling): **4/60, 0/60, 0/60 fail rates for the identical scenario
within one working session.** The spread is the finding.

### Consequence for this PR

Nothing in this PR changes that, and this PR is not a fix. What it now has is a
**reproduction on the real packaged path**, with the failing block's own
numbers, that matches the seven-link chain in §3 link for link — and a test suite
that fails if any of those links changes. The measurement-design decision in §4
is now the only open question, and it is a product decision, not a bug.

---

## 10. Final tally: three packaged runs, one source

All three runs below executed **byte-identical** `src/`, `native/`, `scripts/`
and `.github/`. `nativeVst3EffectRuntime.ts` is the same blob
`5cf8a20492510b83f8dfe83a81c08bab1b514485` in every one, and at `main`
`98b8e81`. The runs differ only in this report, and this report is not built
into the application.

| run | job | gating 5-rep coexistence | 60-rep diagnostic | editor (step 23) |
|---|---|---|---|---|
| `45964493931` | `140389814676` | **PASS 5/5** | **PASS 60/60** | PASS |
| `45971762495` | `140413641840` | **FAIL** (first rep) | **PASS 60/60** | SKIP |
| `45979158807` | `140438344515` | **PASS 5/5** | **PASS 60/60** | PASS |

Every `deadlineMisses=0` and `nativeFailures=0` on every passing lane. No helper
process leaked on any run that reached shutdown.

### The numbers that matter

- The 60-repetition diagnostic passed **60/60 three times** — 180 clean
  repetitions — and the 5-repetition gate still failed once in three.
- The one gate failure happened on its **first** repetition, 1 h 20 m after a
  clean 60/60, and was a **28 ms** round trip against a 21.33 ms budget.
- Observed gate verdicts on unchanged production code: **2 pass / 1 fail**,
  consistent with the §4 model's `P(gate 5/5) ≈ 0.70`.

The finding, stated without overreaching: **the packaged scenario can pass
repeatedly on correct code, and the 5-repetition gate is a noisy instrument for
it** — 180 consecutive clean diagnostic repetitions did not make the next single
repetition predictable.

What must not be read into that. "The scenario passes often" is not "the
scenario is healthy". When a repetition misses its deadline the product does
exactly what it is designed to do - it stops playback rather than replaying stale
PCM - and that remains **a real reliability event for the user**, not a test
artefact. This investigation did not show that such misses are harmless, only
that they occur at a low rate on a contended shared runner and that the failure
was being attributed to the wrong layer. §4 records that it is unresolved whether
the same outlier can occur on ordinary user systems; if it can, this is a DAW
reliability risk that this PR makes diagnosable and does not remove.

### Remaining, honestly

- Physical hardware: NOT VERIFIED. Fake capture fixture, deterministic insert
  buffer. No acoustic equivalence claimed.
- Evidence zips: NOT VERIFIED, contents never read (blob host outside this
  environment's allowlist).
- Whether the CI contention can be removed: NOT VERIFIED, needs a different
  runner.
- The gate's aggregation policy: **OPEN, and a product decision.** Options A, B
  and C in §4 are unchanged and none was taken unilaterally.

---

## 11. What test 10 does and does not prove

Test 10 was rewritten from a second bare sandbox to the shipped runtime, so the
scope of the recovery claim changed. This section is the precise boundary,
because "recovery is tested" is easy to read as more than it is.

**Tested, at the runtime level.** With the real `NativeVst3EffectRuntime` and a
failure message captured from the shipped worklet:

- the control-port handler routes `{type:'failure', reason}` into the runtime's
  own `fail(entry, reason)` path;
- the faulted entry is reported once through the diagnostic feed the UI reads,
  and once through `onFatal` — the callback the application wires to
  `audioEngine.stop()`;
- `isPrepared()` becomes false and `nodeFor()` returns nothing, which is the
  `prepared=false` the acceptance reports;
- the entry is disposed: the worklet is sent `stop`, its port is closed, and the
  helper session is closed;
- the next `ensureTracksPrepared` — issued **before that asynchronous disposal
  finishes**, which is the window a user's next Play lands in — opens a *fresh*
  session and constructs a *new* worklet node, and the insert is usable again.

**Not tested, and not claimed.**

- **`audioEngine.stop()`.** `onFatal` is invoked and its arguments are asserted,
  but the production callback body is `() => { this.stop(); }` in
  `audioEngine.ts`, and test 10 substitutes a recorder. So "the transport
  genuinely stops" remains a **source citation plus the failing run's own
  evidence**, not a test in this file. It is well supported — the annotation
  shows `processedBlocks` frozen and `prepared=false`, which is what a stopped
  transport and a disposed insert produce together — but it is not unit-tested
  here.
- **The native helper.** `bridge` is a mock. No plugin is loaded, no IPC happens,
  no real audio is processed. The ~28 ms latency outlier that causes the miss
  cannot be reproduced by this test at all.
- **The packaged application.** Nothing here runs Electron, the staged helper, or
  the acceptance script.
- **An ordinary user's machine.** Even a passing CI run says nothing about this;
  see §4.

So the accurate statement is: **recovery after a faulted insert is exercised
against the shipped runtime with realistic mocks, and it is not verified
end-to-end.** Option B in §4 remains a proposal that this test *supports*, not a
guarantee it establishes.

---

## 12. The strongest single sample: gate 5/5 while the diagnostic failed 4/60

Desktop Validation run `45997738133` (job `140501287719`) on this PR's head
`71013f7` completed **green**, and is worth recording at length because it is the
cleanest measurement this investigation obtained.

| lane | result |
|---|---|
| gating coexistence, 5 repetitions | **PASS 5/5**, `deadlineMisses=0` |
| non-gating diagnostic, 60 repetitions | **FAIL 4/60** (`failingRepetitions = [1, 33, 39, 54]`) |
| packaged live-input PCM | PASS |
| packaged editor acceptance (step 23) | PASS |

**Both lanes ran in the same job, minutes apart, on the same installed build.**
The gate passed on a job whose diagnostic recorded four genuine missed deadlines.
That is not a contradiction in the instrumentation; it is the instrument behaving
exactly as the model predicts — a 5-repetition conjunction can pass while a
60-repetition survey fails, and the probability of that is `(1-p)^5 ≈ 0.70` at
`p = 0.067`.

### The four failures, decomposed

Every one was the same rejection shape, captured with the `accepted`-gated
correlation, and no stale PCM was adopted in any of them:

| run | missed seq | due frame | received frame | round trip | main event-loop lag |
|---|---|---|---|---|---|
| 1 | 2 | 4096 | 4224 | 23 ms | 77.34 |
| 33 | 2 | 4096 | 4224 | 24 ms | 76.10 |
| 39 | 2 | 4096 | 4224 | 23 ms | 78.06 |
| 54 | **0** | 2048 | 2176 | **11 ms** | 72.39 |

Three things follow directly.

1. **The failures cluster in the helper's cold window** — sequence 2 in three of
   four, sequence 0 in one — consistent with §4 and with the previously recorded
   population. This sample does not reproduce the mid-session (57/149) signature.
2. **`mainEventLoopLagMaxMs` is 72–78 ms on all four** — against 48.88–55.09 ms on
   the passing run of the earlier tree. That is the strongest direct support the
   investigation has for the contention hypothesis in §4, and it is still
   *support*, not isolation: load was not held constant.
3. **Run 54 is the sharpest case and deserves emphasis.** Its recorded round trip
   was **11 ms against a 21.33 ms budget** — comfortably inside — and the guard
   still fired, because the result arrived at frame 2176 when it was due at 2048:
   **one render quantum late regardless of the trip time.** This is the same
   `worstMarginMs` trap documented in §9, now in the opposite direction. It
   confirms that the quantity the guard acts on is *frame alignment*, not elapsed
   round-trip time, and that a short round trip can still miss if delivery lands
   across a quantum boundary. It also confirms the corrected correlation is doing
   its job: only `accepted` results contribute a margin.

### Consequence for the estimate

Pooling this sample moves the point estimate barely at all — `24/337 = 7.1 %`
once §13's sample is included — and it strengthens the case for reporting `p` as
a **mixture over runner load states** rather than a single number. Four failures
in one 60-run survey and zero in the earlier ones is the non-stationarity the §4
caveat describes, observed directly; §13 adds the adjacent 9/60 that makes it
unmistakable.

It also settles the practical question the PR was opened with: **a green gate on
this tree does not mean the underlying misses stopped**, and this run is the
clean demonstration.

---

## 13. Two adjacent runs on the same source: 4/60 then 9/60, and a gate that failed at 2/5

The documentation-only commits that followed §12 re-ran the packaged job twice more.
The results, on source that is identical apart from this document:

| run | job | gating lane | 60-rep diagnostic | max event-loop lag |
|---|---|---|---|---|
| `45997738133` | `140501287719` | **PASS 5/5** | **4/60**, `[1, 33, 39, 54]` | 72.39–78.06 ms |
| `46006658995` | `140531403200` | **FAIL 2/5** | **9/60**, `[1, 10, 20, 51, 56, 59]` | 60.74–70.25 ms |

Both jobs ran the same build. The second failed the gate at **2 of 5** — three
repetitions were lost to the warmup — and its diagnostic recorded **nine**
failures, more than twice the first run's four.

### What this does to the model

The pooled point estimate barely moves (`24/337 = 7.1 %`, essentially unchanged
from 6.9 %), and the model *predicts* that a gate can fail at any `k ≥ 1`. So the
failure itself is not surprising.

What it does show is the thing §4 warned about and could not previously
demonstrate at this strength: **`p` is not stationary.** Back-to-back runs of one
binary produced 4/60 and 9/60. The earlier four-in-60-then-0 pair said the same;
this pair says it twice as loudly, in the opposite direction. A single `p`
therefore understates the problem for a gate, because the gate's failure
probability is `1 - (1 - p_thisrun)^5` evaluated on *that run's* `p`, and
`p_thisrun` varied by more than 2× between adjacent jobs.

That is also the strongest support yet for the **contention** hypothesis in §4,
and it is still support rather than isolation: the lag figures sit in one band
(60–78 ms) across all sampled runs while the failure counts vary, so lag is
necessary-looking but not decisive on its own, and load was never held constant.

### Every failure in both samples has the same anatomy

All thirteen captured failures across the two surveys were rejected as
`after-failure`, so **no stale PCM was replayed in any of them**, and:

- **twelve of thirteen missed sequence 2** at due frame 4096, received at 4224 —
  one render quantum late, in the helper's cold window;
- **seven of them recorded a round trip inside the 21.33 ms budget** — 18, 19, 19,
  22, 23, 24 and 26 ms — and missed anyway, because they arrived a quantum late;
- run 51 has an empty `rejections` array, i.e. the result was never correlated to
  an accepted one, which is the documented capture behaviour for a rejected
  delivery rather than a distinct fault.

The round-trip distribution here (mostly 18–26 ms against a 21.33 ms budget)
explains the whole phenomenon in one sentence: **the helper's round trip sits
*at* the budget during cold start, so anything that delays delivery past a
quantum boundary converts a normal trip into a missed deadline.** That is why the
plug-in callback time is irrelevant, why a pre-warm was a plausible but partial
mitigation, and why event-loop lag on the shared runner matters.

### Consequence

A green gate on this tree means the run was lucky, not that the misses stopped —
§12 showed the gate passing while the survey failed, and this section shows the
survey failing twice as hard one job later with the gate going red. Both are the
same instrument reading the same disease at different sampling rates.

**Nothing here is a case for changing the gate, the guard or the acceptance in
this PR.** It is a case for the measurement-design decision in §4 being made
deliberately, with these numbers in hand.
