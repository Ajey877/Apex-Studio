# PHASE 1G — TIMELINE CAPACITY EXPANSION: IMPLEMENTATION REPORT

## Summary

```text
Phase 1G:      Timeline capacity 64 -> 512 bars, single authority (MAX_TIMELINE_BARS)
Base SHA:      4a2c9262365aaf3c75f991d0737f0b5e1089f538 (main = origin/main, Phase 1F merge PR #197)
Head:          uncommitted working tree on arena/2b9de911-apex-studio (no commit, no push, no PR)
Files changed: 2 tracked files modified (src/state/playlistTimeline.ts, package.json)
               3 untracked files added (2 test files, this report)
Production:    src/state/playlistTimeline.ts (MAX_TIMELINE_BARS 64 -> 512, doc comment)
Registration:  package.json, test:history: +1 explicit file (src/state/phase1g.timelineCapacity.test.ts)
CI coverage:   The 37 Phase 1G state tests now run under test:history (executed by ci.yml).
RED tests:     30 of 52 fail against the unchanged 64-bar production code (audit reproduction)
GREEN tests:   52/52 pass after the single production change
test:history:  647/647 (baseline 610 + 37 Phase 1G state tests)
test:audio:    1386/1386 (baseline 1371 + 15 Phase 1G audio tests)
test:all:      2143/2143 (baseline 2091 + 52 Phase 1G tests)
Discovery:     194/194 test files matched by a test:* pattern, 0 orphaned.
               This is a pattern check. It does not prove CI execution (see "CI test-registration coverage").
TypeScript:    npm run lint (tsc --noEmit) exit 0
Build:         npm run build exit 0
Browser:       Playwright 11 failures: Chromium not installed (environmental). Node harness 8/8 pass.
Memory:        Calculated estimates only, not benchmarks (see "Memory and performance assessment").
```

## Baseline (verified before implementation)

- `main` = `origin/main` = `HEAD` = `4a2c926` (merge of PR #197, Phase 1F).
- Working tree clean on `arena/2b9de911-apex-studio` before any edit.
- `MAX_TIMELINE_BARS = 64` in `src/state/playlistTimeline.ts`.
- No Phase 1G artifacts existed anywhere in the workspace or on the remote.
- `node_modules` was absent. Bootstrapped with `npm ci` against the committed `package-lock.json`. The lockfile is unchanged.
- Baseline suites before the change (for comparison): `test:all` 2091, `test:audio` 1371, `test:history` 610, `test:timing` 115. These match the Phase 1F report.

## The audited problem

The playlist timeline was hard-capped at 64 bars. `normalizeTimelineBars` clamps every timeline length to `MAX_TIMELINE_BARS`, and the load path, project replacement, undo/redo and the arranger's +8 control all resolve through it. A project longer than 64 bars could not be created, and a stored long arrangement was clamped (and its clips relocated) on load.

## The capacity authority

`src/state/playlistTimeline.ts` remains the only declaration of the timeline cap:

- `MAX_TIMELINE_BARS = 512`
- `normalizeTimelineBars(value)` clamps to `[MIN_TIMELINE_BARS, MAX_TIMELINE_BARS]`, rounding first.
- Every consumer resolves through this module: `getProjectTimelineBars`, `clampStartBarToTimeline`, `clampClipToTimeline(s)`, `setTimelineBarsInProjectState`, `revalidateProjectTimeline`, `normalizeProjectState`, and the arranger's +8 control (`Math.min(MAX_TIMELINE_BARS, totalBars + 8)`).

No second capacity was introduced. No other production file declares `MAX_TIMELINE_BARS` or hard-codes a 64-bar timeline clamp. Clip validation (`validatePlaylistClip`) takes its bound from the timeline length it is handed, so it has no independent 64-bar geometry limit.

## What changed (production)

Only one production file changed:

```diff
-/** Bounds the arranger's -8 / +8 controls have always enforced. */
+/** Lower bound of the arranger's -8 control. */
 export const MIN_TIMELINE_BARS = 8;
-export const MAX_TIMELINE_BARS = 64;
+/**
+ * Phase 1G — the single capacity authority for the playlist timeline (512 bars).
+ * Every timeline length is resolved through `normalizeTimelineBars`, which clamps
+ * to this value; no other module may declare or hard-code a timeline cap.
+ */
+export const MAX_TIMELINE_BARS = 512;
```

The doc comment on `MIN_TIMELINE_BARS` was narrowed because the old comment claimed the same bounds applied to the +8 control. Behaviour is unchanged for the minimum.

## Registration change (CI coverage fix)

One explicit file was added to the `test:history` list in `package.json`, directly after its paired suite `src/state/playlistTimeline.test.ts`:

```diff
-... src/state/playlistTimeline.test.ts src/state/playlistHistory.test.ts ...
+... src/state/playlistTimeline.test.ts src/state/phase1g.timelineCapacity.test.ts src/state/playlistHistory.test.ts ...
```

This follows the repository's existing explicit-file-list convention. It is the only `package.json` change. No script, workflow, or dependency was altered, and `package-lock.json` is byte-identical to the committed version.

## Runtime and export coupling (not changed)

The runtime consumers take the timeline length as an argument and do not read the capacity. The Phase 1G changes do not touch them:

- `getOfflineRenderPlan(clips, bpm, totalBars)`: window from its argument.
- `getProjectRenderBars(...)` / `buildStandardMidiFile(...)`: window from clips and `totalBars`.
- `renderTimelineOffline(...)` / playback / bounce: duration from `totalBars` and clip extents. Bounce is sized by `MIN_BOUNCE_BARS` and the channel's own playable length.
- Metering, MIDI writer, and Phase 1E/1F meter resolution: no timeline dependency.

A guard test asserts that no runtime module in `src/audio`, `src/music`, or `src/utils/exportUtils.ts` references `MAX_TIMELINE_BARS` or imports `playlistTimeline`.

## Tests

Two new test files:

- `src/state/phase1g.timelineCapacity.test.ts`: 37 tests. Registered in `test:history` (see above).
- `src/audio/phase1g.timelineCapacity.test.ts`: 15 tests. Discovered by the existing `test:audio` glob for `src/audio/*.test.ts`. `test:audio` is run by `ci.yml`, `audio-validation.yml` and `release.yml`.

**`src/state/phase1g.timelineCapacity.test.ts` (37 tests)**

- Capacity authority: 512 value; MIN/DEFAULT unchanged; `MAX_TIMELINE_BARS` declared exactly once in production source; no hard-coded 64 clamp next to a timeline identifier (both orders); arranger consumes the shared constant.
- Accepted/clamped lengths: 65, 96, 128, 256, 512 accepted; 513, 1024, 4096 and `MAX_SAFE_INTEGER` clamp to 512; fractional rounding.
- Save/load (real `serializeProjectState` → `normalizeProjectState` path): 65, 128, 512 bars round-trip; bar-100 clip on 128 survives; bar-508 clip on 512 survives; a clip spread across the whole span round-trips exactly.
- Clip geometry: clips at 64, 100, 300, 508 legal on 512; 510+4 rejected; grid-click producer creates a legal clip at bar 300 and throws past 512; clamping of start bars and long clips.
- Shrink: 512 → 128 relocates (not deletes) clips; 512 → 64 relocates; undo restores bar 400; re-expansion stable; same-length set is a no-op.
- Load revalidation: stored 512 arrangement overhanging its boundary is pulled back; valid 128-bar long arrangement is returned identical.
- Legacy/malformed (regression anchors): 32 and 64 bars load unchanged; absent/NaN/non-numeric/zero/negative/infinite lengths fall back to the default; malformed and zero-length clips are returned untouched.

**`src/audio/phase1g.timelineCapacity.test.ts` (15 tests)**

- Offline render planning: bar-100 at 200 s on a 512 window; bar-508 clip truncated at the declared end; clips beyond the window excluded; persisted 128-bar and 512-bar projects render their long-bar clips at the correct seconds; 512 → 128 shrink renders the relocated clip at its new bar.
- Export window: song export ends at last clip (104 for bar-100 clip on 128) and never exceeds the timeline handed in; a persisted 128-bar project exports 104 bars; pattern window independent of timeline length.
- MIDI (decoded with a self-contained MIDI reader, 480 PPQ, 1920 ticks/bar in 4/4): legacy bar-60 note at tick 60 bars; persisted 512-bar notes at bars 400 and 508 at exact ticks.
- Runtime isolation: no runtime audio/music/export module references the capacity; offline plan is a pure function of its declared window.

Test counts by kind:

| Kind | State file | Audio file | Total |
| --- | ---: | ---: | ---: |
| RED on 64-bar code (new capacity required) | 24 | 6 | 30 |
| Regression anchor (passes before and after) | 13 | 9 | 22 |
| **Total** | **37** | **15** | **52** |

## RED → GREEN evidence

1. **Baseline check.** Test files were written before any production change. Run against the unchanged 64-bar code: `52 tests, 22 pass, 30 fail`. Failures are the expected ones, for example `64 !== 512` on the authority test, and bar-100 and bar-508 clips clamped or dropped on save/load. The anchors that pass include legacy 32/64 loads, malformed-input fallbacks and the runtime-isolation scan.
2. **Guard refinement.** The no-literal-64 guard was first written to match `timelineIdentifier ... 64` only. Review found that `Math.min(64, totalBars + 8)` (number first) would evade it, so the regex was extended to match both orders before the mutation pass.
3. **Test correction.** One test had an arithmetic error in its expected value: bar 500 with length 4 ends at 504, which is legal, so it correctly stays at 500. The test was corrected to use bar 510 as the overflowing case, with 500 as an in-range control. Production code was not changed for this.
4. **GREEN.** After the one-line production change: `52/52` pass.

## Mutation guards

Fifteen single-defect mutants were applied to production code, one at a time, and the two Phase 1G test files were run against each. Every original file was restored and its SHA-256 checked against the pre-mutation checksum. The independent audit re-created the same mutant set against a scratch copy and reproduced 15/15 with identical failing counts.

| # | Mutant | Result |
| --- | --- | --- |
| M01 | Cap raised to 1024 | Caught (6 fail) |
| M02 | Cap lowered to 511 | Caught (18 fail) |
| M03 | Normalize drops upper clamp | Caught (4 fail) |
| M04 | Normalize clamps to literal 64 | Caught (29 fail) |
| M05 | Start clamp uses literal 64 ceiling | Caught (19 fail) |
| M06 | Clip relocation disabled | Caught (6 fail) |
| M07 | Clip deleted instead of moved | Caught (6 fail) |
| M08 | Load/shrink revalidation disabled | Caught (7 fail) |
| M09 | Load path caps length at 64 | Caught (15 fail) |
| M10 | Offline render window capped at 64 | Caught (6 fail) |
| M11 | Export window capped at 64 | Caught (5 fail) |
| M12 | Clip validator capped at 64 | Caught (3 fail) |
| M13 | Arranger +8 uses literal 64 (number-first form) | Caught (1 fail, by the strengthened guard) |
| M14 | Runtime audio module references the capacity | Caught (1 fail, coupling guard) |
| M15 | Second capacity authority in another module | Caught (2 fail, single-authority guard) |

**15/15 caught.** The mutants cover the production paths that carry the cap: normalization, clip geometry, load/shrink revalidation, offline render window, export window, the arranger control, and the runtime-isolation boundary.

## Validation

Final results for this fix, run in the workspace after the `package.json` change:

| Gate | Command | Result |
| --- | --- | --- |
| Registration executed | `npm run test:history` | 647/647 pass, 0 fail. All 37 Phase 1G state test names reported `ok`, none missing. |
| History (CI step) | `npm run test:history` | 647/647 (baseline 610 + 37) |
| Audio (CI step) | `npm run test:audio` | 1386/1386 pass |
| All | `npm run test:all` | 2143/2143 pass (unchanged: the state file was already in the `src/**` glob) |
| Phase 1G, both suites | `tsx --test` on the two files | 52/52 pass |
| Lint / TypeScript | `npm run lint` (`tsc --noEmit`) | exit 0 |
| Build | `npm run build` | exit 0 |
| Discovery | `npm run verify:test-discovery` | 194/194 matched by a pattern, 0 orphaned (runs as the first step of `test:history`) |
| Timing | `npm run test:timing` | 115/115 (carried from the implementation run; not re-run in this fix, which did not touch `src/music`) |
| Browser (Playwright) | `npm run test:browser:playwright` | 11 fail, all `browserType.launch: Executable doesn't exist` (Chromium not installed). Environmental. Reproduced in the independent audit. |
| Browser (Node harness) | `npm run test:browser:node` | 8/8 pass (reproduced in the independent audit) |
| Phase 1E / 1F regression | `tsx --test` on the Phase 1E and 1F suites | 74/74 pass (in the implementation run; both suites are inside `test:audio`, which passed 1386/1386 here) |

Note on the browser wrapper: `npm run test:browser` falls back to the Node harness when Playwright fails, which would report exit 0 here. The results above are reported separately so the environmental failure is not hidden.

## CI test-registration coverage

**What CI runs.** There are five workflows in `.github/workflows/`. Only some of them run the unit-test scripts:

| Workflow | Triggers | Unit-test scripts it runs |
| --- | --- | --- |
| `ci.yml` | push to listed branches; pull request to `main` | `test:history`, `test:audio` (plus `verify:desktop`, `lint`, Playwright, `build`) |
| `audio-validation.yml` | pull request to `main`, `phase-0-foundation-ui`, `phase-5-5-song-mode-verification`; push to listed branches | `test:audio` (plus `verify:desktop`, `lint`, Playwright, `build`) |
| `release.yml` | tags `v*`; manual dispatch | `test:audio`, `test:history` (plus `verify:desktop`) |
| `desktop-validation.yml` | pull request to `main`; push to listed branches | none (`verify:desktop`, `lint`, `build`, packaging, smoke) |
| `web-deploy.yml` | push to `main`; manual dispatch | none |

A pull request to `main` therefore runs `test:history` and `test:audio` through `ci.yml`, and `test:audio` again through `audio-validation.yml`. No workflow runs `npm run test:all`.

**Which Phase 1G tests CI executes.**

| Suite | Tests | Executed by | Mechanism |
| --- | ---: | --- | --- |
| `src/state/phase1g.timelineCapacity.test.ts` | 37 | `test:history` (`ci.yml`, `release.yml`) | Explicit file in the `test:history` list (added by this fix) |
| `src/audio/phase1g.timelineCapacity.test.ts` | 15 | `test:audio` (`ci.yml`, `audio-validation.yml`, `release.yml`) | Matched by the `src/audio/*.test.ts` glob in `test:audio` |

All 52 Phase 1G tests are therefore in a CI-executed script. Whether a PR run actually reports them is confirmed only by the post-PR CI run.

**The gap.** Before this fix, `test:history` (610 tests) did not list the 37-test state file, and `test:audio` does not match `src/state/*`. The state file was therefore discovered only by `test:all`, which CI does not run. The discovery check passed because it matches patterns across all `test:*` scripts, so it could not detect this.

**The fix.** The state file is now in the `test:history` explicit list (see "Registration change"). Verified results:

- `npm run test:history` is 647/647, so the test count went up by exactly 37.
- Each of the 37 state test names from the source file appears as `ok` in the output, and none is missing or failing.
- After the change, 185 of 194 test files are run by CI scripts, up from 184. The Phase 1G state file is in the CI set.

**Pre-existing gaps, not fixed here.** Nine test files were already not run by any CI script. They are out of scope for Phase 1G and are listed for a separate follow-up:

- `src/components/AppearanceSettingsModal.test.tsx`
- `src/components/grossBeatTruth.test.tsx`
- `src/components/pianoRollOperations.test.ts` (run only by `test:pianoroll`, which CI does not invoke)
- `src/state/theme.test.ts`
- `src/state/ui04ThemeConsistency.test.ts`
- `src/state/workspaceLayout.test.ts`
- `src/state/workspaceShell.test.ts`
- `tests/desktopPermissions.test.cjs` (run only by `test:desktop-permissions`)
- `tests/playlistGeometry.test.mjs` (run only by `test:playlist-geometry`)

The static analysis here matches scripts to files. Whether CI actually executes them is confirmed only by the post-PR CI run.

## Scope audit

Verified with `git status`, `git diff`, and SHA-256 checksums:

- Modified tracked: `src/state/playlistTimeline.ts` (production, unchanged by this fix) and `package.json` (one explicit-file entry in `test:history`).
- Added: `src/state/phase1g.timelineCapacity.test.ts` and `src/audio/phase1g.timelineCapacity.test.ts` (both unchanged by this fix), and `PHASE_1G_IMPLEMENTATION_REPORT.md`.
- Untouched: `package-lock.json` (byte-identical to committed), `.github/` (workflows), and every other source file.
- Generated and not committed: `node_modules/`, `dist/` (both git-ignored). No Playwright artifacts were created in the workspace in this fix.

Final verification (re-run on the final tree before this report was written):

- `npm run test:history`: exit 0, 647 tests, 647 pass, 0 fail. The 37 Phase 1G state test names each report `ok`.
- `git status --porcelain`: ` M package.json`, ` M src/state/playlistTimeline.ts`, `?? PHASE_1G_IMPLEMENTATION_REPORT.md`, `?? src/audio/phase1g.timelineCapacity.test.ts`, `?? src/state/phase1g.timelineCapacity.test.ts`. Tracked diff is 8 insertions and 3 deletions across 2 files.
- SHA-256 (production and tests unchanged from the audited baseline): `playlistTimeline.ts` `e3b9c05a…`, state test `2b488c40…`, audio test `2ff95ec8…`, `package-lock.json` `6124f57b…`.
- The report's own checksum is not recorded here, because a file cannot record its own hash without changing it.

## Memory and performance assessment

**Status: calculated estimates, not measurements.** No render, memory, or DOM benchmark was run, because no browser was available and the fix does not change the renderer.

**Method.** The render path is `OfflineAudioContext(2, ceil(sampleRate × duration), sampleRate)` in `renderTimelineOffline`, with `duration = bars × beatsPerBar × 60 / bpm`. The export then encodes the result with `audioBufferToWav`, which allocates a second `ArrayBuffer` of the encoded size while the `AudioBuffer` is still referenced.

- `AudioBuffer` bytes = frames × 2 channels × 4 bytes (Float32).
- WAV 24-bit (the export default) bytes = frames × 2 × 3, plus a 44-byte header.
- "Peak" = `AudioBuffer` + WAV `ArrayBuffer`. This is a **lower bound**. It excludes `Blob` copies, `OfflineAudioContext` internal graph and voice buffers, and the process baseline.

**Assumptions.**

- Time signature 4/4. This is the longer case per bar, so 3/4 renders about 25% less.
- Two output channels, Float32.
- Sample rate 44.1 kHz or 48 kHz. The live engine uses its own rate, falling back to 44.1 kHz.
- Worst case: the last clip ends at the timeline's last bar (512). The render length is `min(last clip end, timeline)`, so typical projects render far less.
- Tempo range: the UI tempo input advertises `min="40" max="260"`. The offline engine clamps to 20–300, so 20 BPM is reachable only by typing an out-of-range value.

**Calculated render-buffer sizes:**

| Bars | BPM | Render length | AudioBuffer @ 44.1 kHz | AudioBuffer @ 48 kHz | Lower-bound peak during WAV24 encode @ 44.1 kHz |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 64 | 120 | 128 s | 43 MiB | 47 MiB | 75 MiB |
| **512** | **120** | 1024 s | **≈ 345 MiB** | ≈ 375 MiB | ≈ 603 MiB |
| 64 | 40 | 384 s | 129 MiB | ≈ 141 MiB | 226 MiB |
| **512** | **40** | 3072 s | **≈ 1.0 GiB** (1,034 MiB) | **≈ 1.1 GiB** (1,125 MiB) | **≈ 1.8 GiB** (1,809 MiB) |
| 64 | 20 | 768 s | 258 MiB | 281 MiB | 452 MiB |
| **512** | **20** | 6144 s | **≈ 2.0 GiB** (2,067 MiB) | **≈ 2.2 GiB** (2,250 MiB) | **≈ 3.5 GiB** (3,618 MiB) |

**What the numbers mean.**

- The change is exactly 8× (512 / 64) at every tempo and sample rate. The hazard already exists at 64 bars. At 20 BPM, 64 bars already needed about 258 MiB for the render buffer.
- The absolute risk is driven by tempo. At 120 BPM, 512 bars is about 345 MiB. At the UI's minimum of 40 BPM it is about 1.0–1.1 GiB, with a peak near 1.8 GiB while encoding WAV. At the engine floor of 20 BPM it is about 2.0–2.2 GiB, with a peak near 3.5 GiB.
- Whether this is a stability risk depends on the machine, which was not measured. A peak near 1.8 GiB is plausible on a 16 GB desktop and risky on an 8 GB machine, where the browser or Electron process already uses a share of memory. I did not measure either case.
- The risk is reached only when a clip is placed late in a long timeline and the user exports that far. Projects that stay short are unaffected.

**Arranger DOM (calculated from code structure, not measured).** Each lane renders one `w-24` cell per bar, and so does the header. The default preset has 5 lanes. At 512 bars that is 512 header cells plus 5 × 512 lane cells, about 3,072 nodes, against about 384 at 64 bars. The row is 512 × 96 px = 49,152 px wide, and the cells are not virtualized. The cost is linear and probably tolerable, but it is unmeasured.

**Playback.** No live-playback or scheduling path reads the timeline length. Its `totalBars` uses are the offline render, the stem exporter, and bounce arguments, which take the length as input.

**Why this is not a Phase 1G blocker.** Phase 1G changes the capacity constant, not the renderer. The export window is bounded by content, and the hazard is 8× the existing 64-bar hazard. But it is a real risk that should be disclosed, not hidden.

**Possible separate future improvements (not implemented, out of Phase 1G scope):**

1. Chunked or streamed offline rendering and WAV writing, so the full render never sits in one `AudioBuffer`.
2. A render-size guard or warning in the export dialog above an estimated-peak threshold.
3. Virtualization of the arranger's bar cells.
4. Measured benchmarks in a real browser on target hardware, to choose any threshold from data.

## Environmental limitations

- **Dependencies.** `node_modules` was absent at the start of this fix. The environment dropped it again, as in the previous phase. I installed it with `npm ci`, which uses the committed lockfile. The lockfile checksum is unchanged (`6124f57b…`).
- **Exit 127.** The first `test:history` attempt exited 127 because `tsx` was not installed, which was the missing-dependency state above. It is not a test failure. The reported result is from the re-run after `npm ci`.
- **Chromium.** Not installed here, so the 11 Playwright tests cannot launch. This is environmental, not a production failure. CI installs Chromium (`npx playwright install --with-deps chromium`), so those tests run in CI.
- **Install command difference.** Local runs used `npm ci`. CI uses `npm install --legacy-peer-deps`, so its resolution may differ. CI is the authority after the PR is opened.
- **No measurements.** No browser render, memory profile, or arranger timing was taken. All memory figures are calculated.

## Remaining known issues and risks

1. **Offline render memory at low tempo.** Calculated peaks of about 1.8 GiB at 40 BPM and about 3.5 GiB at 20 BPM, for a 512-bar render. Unmeasured. Mitigation is a separate follow-up (see "Memory and performance assessment"). The PR should disclose this.
2. **Arranger DOM scales with bars.** About 3,072 cells at 512 bars with the default 5 lanes. Unmeasured. No virtualization in this phase.
3. **Browser coverage.** No test in this phase exercises a real `OfflineAudioContext` or arranger layout at 512 bars. The Phase 1G tests drive production functions with deterministic inputs. The CI Playwright job runs existing browser tests, not 512-bar-specific ones.
4. **Nine pre-existing CI coverage gaps.** Listed above. Not fixed here, per scope.
5. **Discovery check blind spot.** `verify-test-discovery` confirms that every file matches a `test:*` pattern. It does not confirm that CI runs the script that matches. This is why the Phase 1G gap was not caught earlier. A follow-up could check coverage against the scripts CI invokes.
6. **Low-value test assertions (non-blocking).** The "+8 arranger step" test reproduces the `Math.min` arithmetic rather than exercising the component. The offline-plan "purity" test compares a function's output with itself. Both are harmless, and the mutation results show the substantive tests are meaningful.
7. **Earlier counts.** An earlier working-tree summary cited `39/39`, `2130/2130` and `1383/1383`. Those counts were not reproduced. The counts in this report come from the files in the workspace and were produced by the commands listed above.

## Recommendation

The fix is complete and validated: the 37 state tests execute under `test:history` (647/647), and production code and both test suites are unchanged.

The independent delta check of the one-line `package.json` change, the `test:history` count of 647, and this report has passed. Next step: open the PR. The PR description should disclose the calculated offline-render memory risk and the nine pre-existing CI coverage gaps as separate follow-ups.
