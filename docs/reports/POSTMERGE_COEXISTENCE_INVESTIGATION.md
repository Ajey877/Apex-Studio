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

**Not a defect in this repository's audio code.** The 60-run diagnostic has
instrumented eight failures with a full decomposition. The plug-in callback
`processor->process(data)` never exceeded **0.03 ms** — in a failing block or
any neighbour. The time is host work and OS scheduling spread across processes,
and there is **no single contributor**: across the eight, host preparation
spiked to 13.26 and 12.59 ms, output collection to 7.68 ms, pipe plus OS
scheduling to 15.85 and 14.28 ms, main→renderer to 9.71 ms, and main-thread
event-loop lag reached 10.48 ms. That is contention on a shared CI runner, and
the failing run's own `mainEventLoopLagMaxMs=71.12` (against 48.88–55.09 ms on
the passing run of the *same tree*) is consistent with it.

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
| **pooled** | **15 / 217** | **0.069** | **0.70** |

Roughly a **30 % chance of a red gate on correct, unchanged code** — which is
exactly the run-to-run spread the project's own record already describes ("two
consecutive runs of the same binary measured 4 failures in 60 and then 0"). The
caveat is that the 60-run diagnostic executes at a different point in the job
than the gating 5 runs, so these are estimates of `p`, not a direct measurement
of the gate.

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

Option **B** has a concrete basis: `ensureTracksPrepared` treats a `faulted`
entry as non-reusable and disposes it, so the next Play opens a fresh session.
That path is pinned by test 10.

---

## 5. What this branch does contain

`src/audio/nativeVst3DeadlineLatch.test.ts` — 10 tests against the real shipped
worklet source in a sandbox, the same methodology as
`nativeVst3PendingGuardBoundary.test.ts`. Control-port and live-port messages are
delivered only between `process()` calls, as the audio thread requires; every
step is a synchronous call in a known order, so there is no wall-clock race and
no sleep, retry or relaxed timing anywhere.

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
7. an accepted block is never accepted twice
8. the coexistence warmup predicate can never be satisfied after a latch — the
   arm-probe timeout's actual mechanism
9. a latched insert stops posting diagnostics: no message storm on the audio
   thread
10. a fresh processor is healthy again, so the failure is recoverable by
    re-preparation

### 5.1 Verified load-bearing by mutation, not by inspection

| mutation | outcome |
|---|---|
| remove **both** fail-closed output guards | **caught by test 9** — without them a latched insert posts one diagnostic per quantum, **376 in one second**, forever |
| accept results after the latch (replay stale PCM) | **caught by test 6** |
| revert `ead88bb` (guard fires one frame early) | **caught by 1, 2, 6, 10** |
| remove **both** pending-guard paths | **caught by 1, 2, 5** |
| remove **only** the outer guard path | **correctly invisible** — the inner per-sample path catches the same overdue block; documented in test 5 |

The first mutation is worth calling out: it survived until test 9 existed. It is
easy to assume the second `failed` guard in `process()` is redundant, and it is
not — `fail()` clears both queues, so without the guard every later quantum
finds its block missing in the output loop, posts another `deadline-miss` event
and breaks. `postMessage` from the audio thread is the one operation here that
is not real-time safe.

---

## 6. Verification

Run locally on this branch (`7f52f3e`), Linux, Node v22.22.3.

| command | exit | result |
|---|---|---|
| `npx tsx --test src/audio/nativeVst3DeadlineLatch.test.ts` | 0 | 10 / 10 |
| `npm run test:audio` | 0 | **2592 / 2592**, 485 suites (was 2582) |
| `npm run test:history` | 0 | **1283 / 1283** |
| `npm run test:all` | 0 | **4018 / 4018**, 613 suites (was 4008) |
| `npm run lint` (`tsc --noEmit`) | 0 | clean |
| `npm run build` | 0 | built in 7.19 s |

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
