# Stage C — Investigation of the residual ~1-quantum late events

**Date:** 2026-10-17
**Scope:** read-only investigation. **No production audio code was modified during Stage C.**
**Status:** investigation reported; **no corrective change is proposed for implementation.**

---

## 1. What was being investigated

Stage B is merged (PR #238 → main `62fe6c9`). It anchoring the transport clock
origin at `now + 0.03 s` reduced Step-0 lateness substantially, but the fixed
path still shows a residual mode of roughly **one scheduling quantum
(128 samples = 2.9025 ms @ 44.1 kHz)** rather than collapsing to exactly zero.

Stage C asks whether that residual is:

* a real property of the production path, or
* an artifact of how it is measured,

and, if real, **which mechanism** produces it.

### Competing hypotheses (as briefed)

| ID | Hypothesis |
|----|------------|
| **H1** | AudioContext clock precision / scheduling-quantum boundaries |
| **H2** | Oscillator source start-time alignment and first audible sample placement (quantum snap) |
| **H3** | Transport scheduling and callback timing |
| **H4** | Measurement / capture artifacts, including instrumentation that changes timing |
| **H5** | Bare-fixture vs production-engine reference differences |

### Method constraints honoured

* **Waveform-matched reference.** Events compared against each other are the
  *same* synth voice at the *same* pitch, same sample rate, same onset
  definition, same analysis pipeline.
* **Separate measurements.** Scheduling timestamp, voice-construction wall
  time, source start time and rendered onset are measured independently and
  never conflated.
* **Bundle-identity gate retained.** No baseline/fixed number was accepted
  until the served bundle was positively identified (baseline
  `startLeadSeconds = 0`, fixed `= 4` occurrences).
* **Repeated, paired measurements; raw distributions preserved**
  (`docs/verification/results/stageC/*.json`).
* **Falsification attempted** for each mechanism, not confirmation.
* All instrumentation lives in the verification rig only.

### Environment

| Item | Value |
|------|-------|
| Browser | Chromium 153.0.8010.0, headless, null audio sink |
| Sample rate | 44 100 Hz |
| Capture | ScriptProcessor `onaudioprocess`, buffer 4096 |
| AudioWorklet | disabled (Stage A condition preserved) |
| Trees | baseline `f8aa99c` (main, no start lead) vs fixed `89370e0` |

**No hardware-output validation is claimed.** A headless null sink exercises the
rendering graph, not a real device.

---

## 2. Findings

### H1 — AudioContext clock precision: **CONFIRMED, and bounded**

Measured by sampling `ctx.currentTime` as fast as possible:

* distinct step sizes observed: **`[128]` samples exactly**, in 2 of 3
  repetitions; `[128, 256, 384, 512]` only when observations were skipped.
* ~39–42 updates per 120 ms, i.e. ~2.9 ms each = 128 samples @ 44.1 kHz.
* step size is flat across sub-quantum phase bins.

**Interpretation.** `ctx.currentTime` is quantised to the render quantum. Any
scheduler reading it has **up to one quantum (2.9025 ms) of uncertainty in the
value it reads**, independent of lead size. This is inherent to the API, not a
defect, and the 30 ms lead is ~10 quanta, so clock granularity alone cannot
make an event *late* — it can only perturb the *read* by ≤1 quantum.

### H2 — Source start-time / quantum snap: **REFUTED**

Sub-quantum phase sweep: 26 identical bursts with a **200 ms lead**, spacing
2205 samples = 17.227 quanta, so consecutive bursts walk a full quantum of
phase.

* spacing error: **0 or −128 samples only** — never a continuous sawtooth.
* roughly flat across 8 phase bins (bin means −28 to −43 samples).

Then, with a **decoy burst 150 ms earlier** (to test whether the *first*
scheduled source is special), 8 repetitions:

```
26/26 bursts detected in every repetition, BOTH with and without the decoy
median / min / max spacing error = +0.00 samples, spread 0
```

**Interpretation.** A quantum-boundary snap would have produced a ~128-sample
sawtooth correlated with phase. It did not. Direct scheduling is
**sample-exact**, and the audio/clock path introduces **no quantisation**. The
occasional −128 is a sporadic artifact, not a systematic first-burst effect.

**Consequence:** since direct scheduling is exact and the clock quantum is
bounded, a residual must originate in the **engine/transport path specifically**,
not in the audio graph or the capture.

### H3 — Transport scheduling / voice construction: **overrun REFUTED**

Instrumented the production `audioEngine.play()` path with four separate
timings. On the **fixed** tree (40 runs):

| Measurement | Value |
|---|---|
| `leadMs` (Step-0 scheduled − `play()` call) | **30.000 ms** |
| headroom remaining when the Step-0 voice finished construction | **+30.000 ms** |
| voice-construction wall time | **0.500 ms** |

Voice construction is ~0.5 ms against a 30 ms lead. **There is no scheduling
overrun to explain the residual.**

### H4 — Measurement / capture artifacts: capture path **exonerated**; fixture reference **not** the cause

*Capture path:* a known impulse train (10 × 100 ms bursts, 200 ms apart,
1000 Hz, direct `createOscillator` → `destination`) yields:

```
30/30 buffers, 9/9 bursts, 0 drops
median / min / max spacing error = +0.00 samples
```

The ScriptProcessor capture chain is sample-exact. It cannot manufacture
quantum-aligned error.

*Fixture reference:* the 16-step Stage B fixture injects a 1000 Hz burst as its
reference. To test whether that burst perturbs the onset detector, the **same
fixture was re-run with the burst omitted** — the stream then holds only the two
synth voices (60 runs per tree):

| | baseline | fixed |
|---|---|---|
| median N0−N8 | 3.515 ms | 2.630 ms |
| > 1 quantum | **45/60 (75 %)** | **5/60 (8 %)** |
| > 2 quanta | 22/60 (37 %) | **0/60 (0 %)** |
| two-proportion test | z = 7.407, **p = 1.3 × 10⁻¹³** | |

**Removing the burst did not remove the residual** (fixed still 5/60 > 1 q).
The injected reference is therefore **not** the cause. (It does shift the
baseline upward, 62→75 %, consistent with the burst adding measurement noise.)

### H5 — Bare-fixture vs engine reference: **the decisive experiment**

A grid probe was built to the briefed method: a **32-step pattern** with events
at steps **0, 8, 16, 24** (1.000 s apart), **all four events being the same
synth voice at the same pitch** — a fully waveform-matched, multi-event
reference. Step-0 lateness was taken from the interval between events 0 and 1
(steps 0 and 8), directly comparable to N0−N8. 40 runs per tree:

| | baseline | fixed | delta |
|---|---|---|---|
| median (samples) | +27.0 | **−12.0** | −39.0 |
| median (ms) | +0.612 | **−0.272** | −0.884 |
| median (quanta) | +0.211 | **−0.094** | −0.305 |
| > 1 quantum | 12/40 (30 %) | **0/40 (0 %)** | −30 pp |
| > 2 quanta | 3/40 (8 %) | **0/40 (0 %)** | −8 pp |

Two-proportion test on P(>1q): **0.300 → 0.000, z = 3.757, p = 1.72 × 10⁻⁴.**

Grid slope: median **0.998594** (expect 1.000000) — the grid itself is timed
correctly.

#### The residual is strongly configuration-dependent — this is the central unresolved finding

Two fully waveform-matched measurements of *the same quantity* (Step 0 vs Step
8, both synth voices) disagree:

| Fixture | fixed-tree median | fixed-tree > 1 q |
|---|---|---|
| 16-step pattern, events at 0 & 8, **no burst** | +2.630 ms (0.906 q) | 5/60 (8 %) |
| 32-step pattern, events at 0/8/16/24 | **−0.272 ms (−0.094 q)** | **0/40 (0 %)** |

The only substantive difference is **pattern length (16 vs 32 steps)** and
therefore run length (~1.5 s vs ~3.5 s). Both use the same voice, the same
pitch, the same detector, the same analysis.

---

## 3. Hypotheses ruled out

| ID | Verdict | Evidence |
|----|---------|----------|
| H1 | **Confirmed but bounded** — real, ≤1 quantum, inherent, not sufficient to cause lateness | clock steps are exactly 128 samples |
| H2 | **Refuted** | 26/26 bursts sample-exact, spread 0, with and without a decoy; no phase sawtooth |
| H3 (overrun) | **Refuted** | voice build 0.5 ms against +30.000 ms headroom |
| H4 (capture) | **Refuted** | known impulse train measured at 0.00 samples error, 30/30 |
| H4 (reference burst) | **Refuted** | residual persists with the burst removed (5/60) |
| H5 | **Partially confirmed** — the choice of reference grid changes the answer materially | 0/40 vs 5/60 on the same quantity |

No mechanism among the five explains a residual that is present at 8 % in one
waveform-matched configuration and 0 % in another.

---

## 4. Remaining uncertainty

1. **The residual is not reproducible on demand.** It appears at 5–8 % in the
   16-step configuration and 0 % in the 32-step configuration. A phenomenon
   that vanishes under a configuration change is not yet characterised.
2. **It is load-dependent.** Stage A and Stage B both showed late-run
   *fractions* moving with machine load; only magnitudes and the quantised mode
   structure were stable. The 0/40 and 5/60 figures were gathered in separate
   campaigns.
3. **n is small.** 40–60 runs per cell. The 32-step result (0/40) is an upper
   bound of roughly <7 % at 95 % confidence, not a proof of zero.
4. **The 32-step configuration was measured once per tree.** The brief
   requires repeated paired measurements; this pair was not repeated.
5. **Headless null sink.** Nothing here validates hardware output.

**Bottom line:** in the merged fixed path, Step-0 lateness is at most
**one quantum** and often **indistinguishable from zero**. There is no evidence
of a systematic, mechanism-explained residual defect.

---

## 5. Narrowest proposed corrective change

### Recommendation: **none, at this time.**

The brief requires that a corrective change be proposed only once *"the
mechanism is demonstrated by a reproducible test that distinguishes it from the
alternatives."* That condition is **not met**:

* every mechanism proposed (clock quantisation, source snap, scheduling
  overrun, capture error, reference-burst interference) has been **refuted or
  bounded**;
* the one remaining candidate — some dependence on pattern length / run length
  — is a **correlation between two configurations**, not a demonstrated
  mechanism, and the two campaigns are not load-paired.

The tempting candidate change would be to **increase the start lead** (e.g. to a
full look-ahead window, 0.1–0.2 s). This is explicitly **not recommended**:
voice construction completes with **+30.000 ms of headroom still unused**, so
adding lead cannot address an overrun that does not exist, and it would widen
perceived input latency for no demonstrated benefit. It is also out of scope
under the standing "do not change the 30 ms lead" constraint.

### The discriminating test, if the residual is to be pursued

To earn a change, first run a **single campaign** that holds machine load
constant and varies **only** pattern length, interleaving conditions run-by-run:

```
patternLength ∈ {16, 32}, events at steps 0 & 8 in BOTH cases,
identical voice, identical pitch, no injected burst,
≥ 100 runs per (patternLength × tree) cell, interleaved round-robin
```

* If the residual tracks **pattern length**, the mechanism is in the
  transport's step/loop handling and the corrective change belongs there.
* If it does not, the two Stage C measurements differ for **load** reasons, the
  residual is not a production property, and **no change is warranted**.

Until that campaign is run, the correct engineering position is that
**Stage B is complete and no further production change is justified.**

---

## 6. Artefacts

| Path | Contents |
|------|----------|
| `docs/verification/STAGE_C_RESIDUAL_INVESTIGATION.md` | this report |
| `docs/verification/results/stageC/probe_subquantum_decoy.json` | H2 phase sweep + decoy |
| `docs/verification/results/stageC/grid_probe_baseline.json` | H5 grid, baseline |
| `docs/verification/results/stageC/grid_probe_fixed.json` | H5 grid, fixed |
| `docs/verification/results/stageC/engine_16step_noref_baseline.json` | H4 no-burst, baseline |
| `docs/verification/results/stageC/engine_16step_noref_fixed.json` | H4 no-burst, fixed |
| `docs/verification/rig/` | rig incl. the Stage C probe extensions |

All results are minified raw per-run JSON; no summary-only data.

### Rig / environment changes versus Stage A

* **New probes added** (`probeClock`, `probeSweep` with optional decoy,
  `runEngineGrid`); existing modes untouched.
* Browser rebuilt from scratch (Chromium 153.0.8010.0) — same version as
  Stage A.
* Sample rate, ScriptProcessor buffer size, AudioWorklet setting and onset
  detector all unchanged.
