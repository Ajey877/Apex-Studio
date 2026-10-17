# Stage B — Post-Fix Real-Time Verification

**Read-only measurement.** No production code was modified to improve the result,
the 30 ms lead was not changed, and no test was weakened.

## VERDICT

> ## REAL-TIME IMPROVEMENT VERIFIED

The start lead produces a **large, statistically significant, directionally
consistent reduction in first-note lateness** through the production
`audioEngine.play()` path, with **no regression** in grid alignment, step
identity, omissions or duplicates.

| Engine, production path (100 runs per tree) | baseline | with lead | delta |
|---|---|---|---|
| median first-note lateness | 3.515 ms | **1.179 ms** | **−2.336 ms** |
| p90 | 6.417 ms | 5.533 ms | −0.884 ms |
| **> 1 render quantum** | **62 / 100** | **13 / 100** | **−49 pp** |
| > 2 quanta | 16 / 100 | 2 / 100 | −14 pp |
| > 3 quanta | 4 / 100 | 1 / 100 | −3 pp |

Two-proportion z = 7.157 (**p = 8.3 × 10⁻¹³**); Mann-Whitney z = 6.118
(**p = 9.5 × 10⁻¹⁰**); bootstrap 95 % CI for the median difference
**−3.787 … −0.884 ms** (excludes zero).

On the bare transport fixture — where the reference is **waveform-matched** —
the lateness is eliminated outright: **2/60 → 0/60** (reused context) and
**7/30 → 0/30** (fresh context).

**Honest caveat:** one fixed engine run reached 11.34 ms, above the baseline
maximum of 9.32 ms. The improvement is in the distribution, not in the
single worst sample. A residual ~1-quantum mode also persists in ~37 % of
engine runs; its cause is not established (see *Residual*).

---

## 1. What was compared

| | |
|---|---|
| **Baseline** | `f8aa99c01fb45391b569dd1d382d93037caf43d1` — current `main`, no start lead |
| **Fixed** | `89370e0cd5e78a123a96d77822ffd1c471ec24de` — `main` + start lead (PR #238) |
| **Branch** | `arena/00f03da4-apex-studio` |
| **Parent of the fix** | `f8aa99c` (rebased onto current `main`) |

Both trees contain PR #236 (`nextAbsoluteStep`), so this comparison isolates
**exactly** the start lead — which is what PR #238 changes.

Two read-only source trees were built with `git archive <rev> src` and each was
bundled independently:

| tree | bundle size | `startLeadSeconds` | `start()` anchoring |
|---|---|---|---|
| `verify-baseline` | 10 683 B | **0** | `clockOrigin = now - positionSeconds` |
| `verify-fixed` | 10 958 B | **4** | `clockOrigin = now + startLeadSeconds - positionSeconds` |

`seek()` is byte-identical across the two trees.

## 2. Measurement setup

| item | value |
|---|---|
| Browser | Chromium **153.0.8010.0** headless (`@sparticuz/chromium@153.0.0`) |
| Driver | Playwright `connectOverCDP`, port 9222 |
| Audio capture | **ScriptProcessorNode**, 44 100 Hz, bufferSize 4096 |
| AudioWorklet | **non-functional** in this build (`process()` never fires) |
| 1 render quantum | 128 / 44100 = **2.9025 ms** |
| Onset detection | hysteresis, 10 ms sustained-quiet re-arm, all bursts identical 1000 Hz |
| Onset matching | **structural** — k-th detected onset ↔ k-th scheduled burst |
| Grid | 120 BPM, 16 steps, step = 125 ms |

**This is a headless null audio sink. It measures the rendered audio graph, not
hardware output. No hardware validation is claimed.**

### Statistic definitions

- **Bare fixture** — five *identical* 1000 Hz bursts share one captured stream,
  so the reference is waveform-matched and the unknown stream-start constant
  cancels exactly:
  `lateness(X) = (sample(X) − sample(Nref))/sr − (S(X) − S(Nref))`.
  `N0` = transport step 0 (the suspect); `Nsmall0` = +50 ms, `Nsmall1` = +100 ms,
  `Nref` = +500 ms, `N8` = transport step 8 (controls).
- **Engine fixture** — production `audioEngine.play()` fires the real synth
  voice. The reported statistic is the **`N0 − N8` differential**: N0 and N8 are
  the same voice so waveform-detection bias cancels, and the injected `Nref`
  anchor cancels algebraically. `N0 − Nref` is reported for corroboration but is
  **not** relied on, because the burst anchor carries a large constant
  waveform bias (≈ +3.9 ms here) and is itself occasionally unstable.

## 3. Raw run counts and capture validity

| condition | runs | structurally valid | onset-count mismatches | droppedBuffers |
|---|---|---|---|---|
| `gapProof` (ground truth) | 3 × 10 impulses | — | — | 0 |
| `bare_reused_60` | 60 | 60 | 0 | 0 |
| `bare_fresh_30` | 30 | 30 | 0 | 0 |
| `engine_reused` | 100 | 100 | 0 | 0 |

Identical for both trees — **190 validated runs per tree, 380 total**.

**Ground truth** (known 10-impulse train, 4096-sample spacing): **30/30 detected**
in both trees, `meanStepSamples` = 4096 vs expected 4096, 0 dropped buffers,
`maxAbsSpacingError` ≤ 128 samples (1 quantum of session capture noise).

### Bundle-identity gate

Every campaign is gated on an independent check that the *executed* bundle is
the intended one: under the lead, `start()` anchors at `now + 0.030 s`, so
`median(scheduledStep0 − tCall)` must be ≈ 0 ms (baseline) or ≈ 30 ms (fixed).

| campaign | gate | result |
|---|---|---|
| baseline | +0.000 ms in all 3 conditions | **PASS** |
| fixed | +30.000 ms in all 3 conditions | **PASS** |

This gate exists because an earlier campaign was silently corrupted: a static
server returned `304 Not Modified` and the browser reused the *other* tree's
cached bundle. The harness now serves `Cache-Control: no-store`, strips
conditional request headers, and uses tree-specific bundle URLs.

## 4. Results

### 4a. Bare transport (waveform-matched reference)

| condition | baseline — N0 > 1 quantum | fixed — N0 > 1 quantum |
|---|---|---|
| reused context (60 runs) | 2 / 60 (max 2.902 ms) | **0 / 60** (max 0.000 ms) |
| fresh context (30 runs) | 7 / 30 (max 8.481 ms) | **1 / 30 \*** (max 2.902 ms) |

\* The single fixed outlier is a **run-level capture artifact**, not N0
lateness: in that run *both* `N0` and `Nsmall0` read exactly +128 samples
(meanStep 4096 vs expected 4096) — a whole-stream slip. Genuine count: **0/30**.

All control bursts read **0.000 ms** in every other run of both trees.

### 4b. Production engine — `audioEngine.play()`, `N0 − N8`

| metric | baseline | fixed | delta |
|---|---|---|---|
| runs | 100 | 100 | — |
| **median** | **3.515 ms** | **1.179 ms** | **−2.336 ms** |
| p90 | 6.417 ms | 5.533 ms | −0.884 ms |
| max | 9.320 ms | 11.338 ms | +2.018 ms |
| mean | 3.060 ms | 1.644 ms | −1.416 ms |

**Mode structure** (lateness rounded to nearest quantum):

| | +0 q | +1 q | +2 q | +3 q | +4 q |
|---|---|---|---|---|---|
| baseline | 36 % | 46 % | 13 % | 5 % | — |
| fixed | **50 %** | 37 % | 11 % | 1 % | 1 % |

Corroborating absolute measure `N0 − Nref` (constant waveform bias, so only the
*change* is meaningful): median 7.370 ms → 4.014 ms (−3.356 ms), same direction.
Control `N8 − Nref`: 3.855 ms → 4.286 ms — stable, as required.

## 5. Correctness — no regressions

| check | baseline | fixed |
|---|---|---|
| grid: scheduled `step8 − step0` | 1000.000000 ms | 1000.000000 ms |
| onset count == expected | 190 / 190 | 190 / 190 |
| step 0 skipped or duplicated | none (`triggerCount` 15/16 both trees) | none (`triggerCount` 15/16) |
| later-step alignment (bare `N8`) | 0.000 ms | 0.000 ms |

The musical grid is bit-exact and unchanged; no step is omitted, duplicated or
mis-numbered.

## 6. Residual and limitations

1. **A ~1-quantum residual persists in ~37 % of fixed engine runs** (down from
   ~64 %). The fix shifts the distribution but does not eliminate the mode.
2. **Its cause is not established.** Instrumentation shows step 0's voice
   finishes building with a **full +30 ms of headroom** remaining even in late
   runs (`headroomAtDone` median +30.000 ms, `doneMs` ≈ 0.6 ms), which
   **refutes** "voice construction overruns the lead". Remaining candidates —
   `AudioParam` first-quantum automation behaviour, or graph latency through the
   mixer/FX chain — were **not** tested here.
3. **One fixed run (11.34 ms) exceeds the baseline maximum (9.32 ms).** The
   improvement is distributional, not a guaranteed per-run bound.
4. **Not hardware-validated** — headless null sink.
5. **AudioWorklet unusable** in this Chromium build; capture uses the deprecated
   ScriptProcessorNode. Sample-exact on a known impulse train, but not the
   production audio path.
6. **~1 quantum of session capture noise** (gapProof `maxAbsSpacingError` =
   128 samples), comparable in size to the residual under study.
7. The baseline defect is **intermittent and load-dependent**; late-run
   *fractions* move with machine load (an earlier session of the same
   measurement saw 16/30 and 9/30 on identical code). Magnitudes and the
   quantised mode structure are stable; absolute fractions are not.

## 7. Reproducing

```
docs/verification/rig/       fixture, driver, analyzer, bundle-id gate, no-cache server
docs/verification/results/   raw per-run JSON for both trees
```

Rig is confined to `docs/verification/` — no production code is touched.
