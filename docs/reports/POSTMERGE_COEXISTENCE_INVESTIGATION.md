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

**PROVEN — the instrumented plug-in callback did not account for the observed
delay.** The 60-run diagnostic has instrumented eight failures with a full
decomposition, and `processor->process(data)` — the plug-in callback alone, as the
helper measured it — never exceeded **0.03 ms**, in a failing block or any
neighbour.

**Scope of that claim, stated carefully.** It rules out *the measured plug-in
callback duration* as the source of the delay. It does **not** exclude every
plug-in-related effect, and it does not exclude host, driver, scheduling or system
effects: the callback is timed inside the helper's host thread, so time spent
outside it is invisible to this measurement. "The callback was 0.03 ms" is a
statement about where the *measured* time was not, not a general exoneration.

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
10. the real runtime disposes a faulted entry; the next Play, issued **before that
    disposal finishes**, prepares a fresh session and returns a new worklet node;
    and that fresh entry then **processes a block end to end**, returning the
    bridge's PCM (0.25) for a submitted input of 0.375 — while refusing to revive
    the faulted one. The bridge is a mock, so this is runtime routing and PCM
    return, not real plug-in DSP; see §15.

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
- the faulted entry is reported once through `onFatal` — the callback the
  application wires to `audioEngine.stop()`. The diagnostic feed the UI reads
  holds **exactly one entry for this slot, carrying the production message**; that
  is the feed's real guarantee, since `reportVst3MixerEffect` replaces rather than
  appends and a duplicate report would overwrite rather than accumulate;
- `isPrepared()` becomes false and `nodeFor()` returns nothing, which is the
  `prepared=false` the acceptance reports;
- the entry is disposed: the worklet is sent `stop`, its port is closed, and the
  helper session is closed;
- the next `ensureTracksPrepared` — issued **before that asynchronous disposal
  finishes**, which is the window a user's next Play lands in — opens a *fresh*
  session and constructs a *new* worklet node;
- **that fresh entry's request/response path then runs**: a
  `{type:'process', sequence:0, samples}` message injected into the **mocked** node
  port makes the shipped runtime call `bridge.processAudio` and post exactly one
  `{type:'result'}` back, carrying a full planar stereo block whose samples are the
  **bridge mock's** 0.25 and not the submitted 0.375. That proves the runtime
  forwards the request and returns the bridge's PCM rather than echoing or zeroing
  the input. It is **not** a worklet round trip and **not** plug-in DSP: the process
  request is injected directly, the node port is a mock, and the bridge returns a
  constant. No new failure is raised while doing so.

**Not tested, and not claimed.**

- **`audioEngine.stop()`.** `onFatal` is invoked and its arguments are asserted,
  but the production callback body is `() => { this.stop(); }` in
  `audioEngine.ts`, and test 10 substitutes a recorder. So "the transport
  genuinely stops" remains a **source citation plus the failing run's own
  evidence**, not a test in this file. It is well supported — the annotation
  shows `processedBlocks` frozen and `prepared=false`, which is what a stopped
  transport and a disposed insert produce together — but it is not unit-tested
  here.
- **The native helper.** `bridge.processAudio` is a mock returning a constant. No
  plug-in is loaded, no IPC happens, no real DSP runs. What the PCM assertion
  proves is that the runtime *routes and returns* a block through a fresh entry,
  **not** that a real plug-in processed it. The ~28 ms latency outlier that causes
  the miss cannot be reproduced by this test at all.
- **The shipped worklet's side of that round trip.** The test posts the `process`
  message itself rather than rendering quanta through the sandboxed worklet,
  because the worklet's `process()` drives the fixed 21.33 ms deadline pipeline and
  would need a second scheduler here. The worklet's own result handling is covered
  by tests 1–9.
- **The packaged application.** Nothing here runs Electron, the staged helper, or
  the acceptance script.
- **An ordinary user's machine.** Even a passing CI run says nothing about this;
  see §4.

So the accurate statement is: **recovery after a faulted insert is exercised
against the shipped runtime with realistic mocks, including a full PCM
request/response through the fresh entry, and it is not verified end-to-end.**
Option B in §4 remains a proposal that this test *supports*, not a guarantee it
establishes.

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

The documentation-only commits that followed §12 re-ran the packaged job three more times.
The results, on source that is identical apart from this document:

| run | job | gating lane | 60-rep diagnostic | max event-loop lag |
|---|---|---|---|---|
| `45997738133` | `140501287719` | **PASS 5/5** | **4/60**, `[1, 33, 39, 54]` | 72.39–78.06 ms |
| `46006658995` | `140531403200` | **FAIL 2/5** | **9/60**, `[1, 10, 20, 51, 56, 59]` | 60.74–70.25 ms |
| `46015836980` | `140562594035` | **PASS 5/5** | **5/60** | — |
| `46025549899` | `140595888501` | **PASS 5/5** | **1/60** | — |

Four consecutive jobs on one build produced **4, 9, 5 and 1 failures in 60**, with
the gate going pass, fail, pass, pass. That sequence is the clearest statement of
the problem in this document: the gating lane's verdict tracked runner luck, not a
change in the software. (These are earlier heads than the final `60fee68`; the
per-run samples continue in §12–§18.)

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
this pair says it twice as loudly, in the opposite direction. The two further
jobs — 5/60 and 1/60 — widen the spread to a **9× range** across four consecutive
runs of one build. A single `p` therefore understates the problem for a gate,
because the gate's failure probability is `1 - (1 - p_thisrun)^5` evaluated on
*that run's* `p`, and `p_thisrun` ranged from 1.7 % to 15 % between adjacent jobs.

The mean across these four is `19/240 = 7.9 %`, close to the pooled 7.1 %, which
is the useful summary: the average is stable while the per-run value is not.
Quoting the average as though it were the per-run rate is exactly the mistake
that makes a 5-repetition gate look more reliable than it is.

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

---

## 14. HISTORICAL CI snapshot — `0e269ff` (superseded; see §18 for the final head)

> **This section is a historical snapshot of commit `0e269ff` only.** It is kept
> because the failure it records is real and may recur. **It does not describe the
> current state of PR #309.** The final head is `60fee68`, whose five required
> checks all pass — see §18.

| check (on `0e269ff`) | verdict | note |
|---|---|---|
| `verify` (Apex Studio CI) | **pass** | |
| `audio-tests` | **pass** | |
| `Native DSP (ubuntu-latest)` | **pass** | |
| `windows-package` (Desktop Validation) | **pass** | step 19 PASS 5/5; diagnostic 57/60 |
| `Native DSP (windows-latest)` | **fail** | step 10; the same job passed on the *previous* head |

The `windows-package` lane — the one this investigation concerns — was **green on
this commit too**, with the gating coexistence at **5/5** and the non-gating
diagnostic at **57/60**. That was the fifth consecutive per-run diagnostic sample
on this build: 4, 9, 5, 1, 3 failures in 60.

### The one red check on `0e269ff` was not from this PR

`Native DSP (windows-latest)` failed at step 10, *"Prove editor/audio helper
process separation with real PIDs"*:

```
FAILED: the editor helper was a separate, live OS process from the audio helper ::
{"audioHelperPid":4224,"editorHelperPid":6072,"editorAlive":false,"audioAlive":true,"editorCmdline":[]}
```

The editor helper process had exited by the time liveness was probed
(`editorAlive: false`, empty `editorCmdline`). This is a native helper-lifetime
race in a lane this PR does not touch:

- the only two files this PR changes are
  `src/audio/nativeVst3DeadlineLatch.test.ts` (a test file, not built into the
  packaged application) and this report;
- the **same job passed on the previous head `2407baa`** (`46025549956`), and
  `git diff 2407baa 0e269ff -- src native scripts .github` is **empty** — the only
  difference between the passing and failing runs is this document;
- steps 6–9 of the same job all passed, so native DSP, Mixer latency
  compensation, DAW integration and the editor session contract are green.

It is recorded here rather than dismissed because it is a genuine intermittent
defect in the editor helper's process separation. It is simply not this PR's, and
this PR does not fix it.

**It did not reproduce on the next head.** `Native DSP (windows-latest)` passed on
`ecbc40d` (`46042730533`, job `140654271395`, 19 m 38 s), which is the intended
reading of an intermittent defect: one occurrence, not a standing red check.

---

## 15. Verification snapshot — head `ecbc40d` (superseded; see §18)

> **Snapshot of `ecbc40d` only.** It was the current head when written and is kept
> because it was independently verified. **It is not the final head**; the final
> head is `60fee68` — see §18.

Base `98b8e81`. Head **`ecbc40d7050ddd287b9107d2d019a0400a015e48`**. Verified twice —
independently, and again from the workflow APIs while writing this section.

| required check | verdict | job | duration |
|---|---|---|---|
| `verify` (Apex Studio CI) | **success** | `140654270933` | 8 m 25 s |
| `audio-tests` (Audio Validation) | **success** | `140654269348` | 7 m 09 s |
| `Native DSP (ubuntu-latest)` | **success** | `140654271874` | 8 m 35 s |
| `Native DSP (windows-latest)` | **success** | `140654271395` | 19 m 38 s |
| `windows-package` (Desktop Validation) | **success** | `140654269827` | 1 h 02 m 09 s |

**All five pass.** Within `windows-package` (run `46042730116`, 17:33:10–18:35:19 UTC):

| step | verdict | name |
|---|---|---|
| 17 | **SUCCESS** | Packaged Windows live input PCM and recording acceptance (fake microphone) |
| 19 | **SUCCESS** | Packaged native VST3 + live input coexistence acceptance — **5/5**, `deadlineMisses=0` |
| 21 | SUCCESS | Cold-start deadline diagnostic (high volume, non-gating) — 56/60 |
| 23 | **SUCCESS** | Native VST3 editor acceptance through the packaged application |
| 25 | SUCCESS | Record the packaged acceptance verdict |
| 27 | SUCCESS | Upload Windows package |

Both lanes the failing post-merge run could not complete are green here: step 19
(the original failure) and step 23, which `45953961366` **skipped**.

The diagnostic recorded `failingRepetitions = [1, 29, 33, 55]`, i.e. 4 of 60. That
is the sixth per-run sample on this build — 4, 9, 5, 1, 3, 4 — and it is the
reason §14's existence does not mean the condition was fixed. **The gate passing
here, and the survey finding four misses in the same job, are both true at once**;
§12 explains why.

### What test 10 now proves, and what it still does not

The test was corrected again after review, because its previous final step sent a
`{type:'profile', event:'live-bound'}` message and called that "accepts results
again". That was not a PCM claim and should not have been written as one.

**Now exercised: real block processing through the fresh entry.** After
`ensureTracksPrepared` prepares a new session, the test injects a
`{type:'process', sequence:0, samples}` message into the **mocked** node port and
asserts:

- exactly one `{type:'result'}` comes back, with `sequence: 0`;
- its sample array is `VST3_FX_BLOCK_FRAMES * 2`, a full planar stereo block;
- both channels carry **0.25**, the value the bridge mock returns, and **not**
  0.375, the value the test submitted. So the assertion cannot pass on an echoed
  input buffer or a zeroed one — the runtime returned the **bridge mock's** PCM.
  This is a runtime-level request/response check: the request is injected directly,
  the port is a mock, and no worklet rendered it and no plug-in processed it;
- `fatal.length` is still 1, so processing the fresh entry raised no new failure;
- the fresh entry is still prepared afterwards.

The two mutations that matter both fail the test: deleting the runtime's
`node.port.postMessage({type:'result', ...})` line, and making the assertion expect
the echoed input instead of the bridge PCM.

**Still not proven, and now stated as such in the test and here:**

- **the real native helper.** `bridge.processAudio` is a mock returning a constant.
  No plug-in is loaded, no IPC occurs, no real DSP runs. What is proven is that the
  runtime *routes and returns* PCM through a fresh entry, not that a real plug-in
  processed it;
- **the shipped worklet's contribution to the round trip.** The test posts the
  `process` message itself rather than rendering quanta through the sandboxed
  worklet, because that worklet's `process()` drives the fixed 21.33 ms deadline
  pipeline and would need a second scheduler here;
- **`audioEngine.stop()`.** The `onFatal` callback is a recorder;
- **the packaged application**, and **ordinary user machines**.

So recovery is verified at the runtime level *including PCM return*, and is still
**not verified end-to-end**. Option B in §4 remains supported, not guaranteed.

### The diagnostic-feed assertion, corrected

It previously checked `.some(...) === true` while the prose said "exactly once".
It now asserts a filtered **count of exactly one entry for this slot, carrying the
production message**, and documents the limit of that assertion in place:
`reportVst3MixerEffect` **replaces** any existing entry for a `(trackId, slotId)`
pair rather than appending, so a count of one means *at most one per slot*, not
*reported exactly once* — a double report would overwrite and still read 1. The
exact-once property is asserted where it is genuinely observable, on
`fatal.length`, which is the `onFatal` callback the app wires to the transport
stop.

### Local verification on this head

| command | exit | result |
|---|---|---|
| `npx tsx --test src/audio/nativeVst3DeadlineLatch.test.ts` | 0 | 10 / 10 |
| `npm run test:audio` | 0 | 2592 / 2592, 485 suites |
| `npm run test:all` | 0 | 4018 / 4018, 613 suites |
| `npm run lint` (`tsc --noEmit`) | 0 | clean |
| `npm run build` | 0 | built in 6.75 s |

No production code is changed by this PR. The only files it touches are
`src/audio/nativeVst3DeadlineLatch.test.ts` and this report.

---

## 16. HISTORICAL check state — head `639e4d5` (superseded)

§15 documents the independently verified state of **`ecbc40d`**, where all five
required checks passed. This revision, `639e4d5`, changed **only** the test file
and this report, so CI re-ran. Its results are recorded here, as they happened.

> **Superseded.** This section records one head's CI outcome, not the PR's final
> state. The final head is `60fee68` — see §18.

| check | verdict | job |
|---|---|---|
| `verify` (Apex Studio CI) | **pass** | `140919397225` (8 m 58 s) |
| `audio-tests` | **pass** | `140919397130` (9 m 24 s) |
| `Native DSP (ubuntu-latest)` | **pass** | `140919397319` (7 m 16 s) |
| `Native DSP (windows-latest)` | **pass** | `140919397084` (18 m 35 s) |
| `windows-package` | **FAIL** | `140919397146` (54 m 14 s) |

Four of five pass. `windows-package` failed at **step 19**, with step 23 skipped
and step 25 failing as a consequence — the original signature, on a commit whose
only changes are a test file that is not built into the packaged application and
this document.

### It failed on the first repetition while the survey passed 59/60

```
[acceptance]         Cold-start aggregate: reps=1, failing=[1]
[coldstart-diagnostic] Cold-start aggregate: reps=60, failing=[28]
coexistence notice:  FAIL 59/60   deadlineMisses=0 for every repetition that ran
```

The gating lane lost its very first repetition; the 60-repetition survey in the
**same job, on the same build** recorded one failure in sixty. This is the
inverse of §12, where the gate passed while the survey failed 4/60, and it is the
seventh per-run sample: **4, 9, 5, 1, 3, 4, 1 in 60.**

The two missed blocks, both captured with the `accepted`-gated correlation:

| attempt | missed seq | due frame | received | round trip | event-loop lag |
|---|---|---|---|---|---|
| 1 | 1 | 3072 | 3200 | **19 ms** | 71.28 |
| 2 | 2 | 4096 | 4224 | **23 ms** | 71.95 |

Both round trips were **inside** the 21.33 ms budget and both arrived **one
render quantum late** (3200−3072 = 4224−4096 = 128 frames). Both were rejected as
`after-failure`, so **no stale PCM was replayed**. This is the §13 anatomy again,
at sequence 1 as well as 2, and it is the fourth independent job in which the
recorded round trip for a missed block is under budget.

### What this means, and what it does not

**It does not mean this revision broke anything.** The only changes are a test
file and this document; `src/`, `native/`, `scripts/` and `.github/` are
identical to `ecbc40d`, where the same job passed all steps. It is the same
intermittent condition, at the rate §4 estimates.

**It does mean the check state of this exact head is 4 of 5, with step 19 red.**
Stating otherwise would be inaccurate, and re-rolling until a green appeared
would be exactly the sampling bias this document exists to expose. Anyone who
needs a green packaged run for this change set should read `ecbc40d`
(§15), which is the same production tree and has one.

The measurement-design decision in §4 remains the only open question, and remains
a product decision rather than a bug fix.

---

## 17. HISTORICAL check state — head `421c1a6` (superseded; see §18)

> **Snapshot of `421c1a6` only.** It is kept because the run is the cleanest
> packaged result in this document and worth citing. **It is not the final head**;
> the head this report ships on is `60fee68` — see §18.

This commit's CI re-ran after §16, and all five required checks passed.

**Head `421c1a6f3971b4f34f36877d44adca33c55bc16c`. All five required checks pass.**

| check | verdict | job | duration |
|---|---|---|---|
| `verify` (Apex Studio CI) | **success** | `140932578133` | 8 m 04 s |
| `audio-tests` (Audio Validation) | **success** | `140932577932` | 7 m 39 s |
| `Native DSP (ubuntu-latest)` | **success** | `140932578296` | 6 m 58 s |
| `Native DSP (windows-latest)` | **success** | `140932578143` | 19 m 10 s |
| `windows-package` (Desktop Validation) | **success** | `140932578354` | 54 m 11 s |

Within `windows-package`:

| step | verdict | name |
|---|---|---|
| 17 | **SUCCESS** | Packaged Windows live input PCM and recording acceptance (fake microphone) |
| 19 | **SUCCESS** | Packaged native VST3 + live input coexistence acceptance — **5/5**, `deadlineMisses=0` |
| 21 | SUCCESS | Cold-start deadline diagnostic (high volume, non-gating) — **60/60** |
| 23 | **SUCCESS** | Native VST3 editor acceptance through the packaged application |
| 25 | SUCCESS | Record the packaged acceptance verdict |
| 27 | SUCCESS | Upload Windows package |

This is the cleanest packaged run recorded anywhere in this document: **5/5
gating and 60/60 diagnostic, with `deadlineMisses=0` on every lane and no helper
process leaked.** Both lanes that the original post-merge failure could not
complete — step 19 (the failure itself) and step 23, which `45953961366` skipped
— passed.

### Read it in context, not as a resolution

A 60/60 does not contradict §16, which recorded step 19 failing on its first
repetition with the survey at 59/60 on the previous commit. These are the eighth
and seventh per-run samples of one build: **4, 9, 5, 1, 3, 4, 1, 0 failures in
60.**

Two adjacent commits, identical in every build input, produced **1/60 then 0/60**
in the gate outcomes *failed then passed*. That is the same non-stationarity §13
documents, in the direction that happens to be green. The finding stands: the
scenario passes often, the gate tracks runner luck, and **a genuine missed
deadline still stops playback and remains a DAW reliability risk** (§4).

No production code is changed by this PR at any commit. The only files it touches
are `src/audio/nativeVst3DeadlineLatch.test.ts` and this report. (§18 records the
final head.)

---

## 18. FINAL check state — head `60fee68`

**This is the final head of PR #309.** Everything in §14, §16 and §17 is a
historical snapshot of an earlier head and does not describe the PR's status.

Base `98b8e81b8536d0fc16b1910fa2f7f381fc6ed8db`.
Head **`60fee683f589139dd69b9af79890533d9879b8d5`**.

| required check | verdict | duration | job |
|---|---|---|---|
| `verify` (Apex Studio CI) | **pass** | 8 m 23 s | `140945787055` |
| `audio-tests` (Audio Validation) | **pass** | 7 m 54 s | `140945786847` |
| `Native DSP (ubuntu-latest)` | **pass** | 8 m 07 s | `140945787012` |
| `Native DSP (windows-latest)` | **pass** | 18 m 47 s | `140945786833` |
| `windows-package` (Desktop Validation) | **pass** | 59 m 22 s | `140945787032` |

**All five required checks pass.** Within `windows-package`: step 17 PASS,
**step 19 PASS 5/5** (`deadlineMisses=0`), step 21 PASS (diagnostic 59/60),
**step 23 PASS** (packaged editor acceptance), step 25 PASS.

The 60-repetition diagnostic in that job read **59/60** (`failing=[31]`) — so the
gate was green while the survey found one miss, which is the §12 pattern and the
ninth per-run sample on this build.

### What the tests prove, stated without overreach

**Two layers, two objects, deliberately not connected.**

Tests 1–9 evaluate `VST3_FX_WORKLET_SOURCE` in a sandbox and exercise the shipped
worklet's own guard, latching, result handling and duplicate rejection.

Test 10 does **not** connect a worklet to the runtime. It captures the shipped
worklet's real `{type:'failure', reason}` text in the sandbox, then **injects a
message with that same shape and text into a separately mocked `AudioWorkletNode`
port**. The shipped runtime's reaction to that message is what is under test. The
two live ports are never wired together; that wiring (`node.port.onmessage`) is
exercised against a mock the test drives directly, not against a worklet running
on an audio thread.

**The PCM step is a runtime-level request/response check, not a round trip.** The
test injects `{type:'process', sequence:0, samples}` into the mocked port; the
runtime calls `bridge.processAudio`; the **bridge mock** returns constant 0.25; the
runtime posts `{type:'result', …}` back; the test asserts the returned result and
its contents (0.25, not the submitted 0.375, so an echo or zeroed buffer cannot
pass). What that establishes is that the runtime accepts a request for the fresh
entry, forwards it, and returns the bridge's PCM. It does **not** establish a real
AudioWorklet round trip, and it does **not** establish plug-in DSP — no plug-in is
loaded, no IPC occurs, no audio is processed.

**Preserved limitations**, unchanged by this pass:

- Bridge processing is **mocked** (constant return; no plug-in, no IPC).
- The process request and the failure message are **injected directly** by the test.
- The `AudioWorkletNode` and its port are **mocked**.
- `audioEngine.stop()` is **recorded** via the `onFatal` callback, not exercised
  end-to-end; the app's `() => { this.stop(); }` body is not run.
- The packaged application is not exercised by these tests.
- **No physical-hardware claim**, and **no claim about ordinary-user-machine
  reliability**, is made anywhere in this document.

### The three categories, unchanged

**Proven** — the deadline miss, the fail-closed latch, entry disposal, the
transport stop, and propagation into the acceptance's `arm-probe` timeout.

**Supported but not isolated** — host/OS scheduling contention as the likely
explanation for the latency outlier. The measured plug-in callback never exceeded
0.03 ms, which rules out the *measured callback duration*, not every plug-in-related,
host, driver or system effect.

**Unresolved** — whether comparable misses occur on ordinary user systems. If they
do, a genuine missed deadline still stops playback, and that remains a DAW
reliability risk which this PR makes diagnosable and does not remove.
