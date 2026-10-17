# Stage C — Final Controlled Pattern-Length Experiment

**Verdict:** No stable pooled pattern-length effect of one render quantum (2.902 ms) or greater was reproduced; the exact paired sign-based equivalence tests support the pooled median contrast lying within that margin. An exploratory time trend in the paired contrast remains, and the strict 16-then-32 order cannot separate run-position/time variation from a transient interaction.

**Recommendation:** Close the pattern-length investigation without a speculative production fix. The remaining residual is run-variable, but this campaign does not prove that the cause is load: measured proxies were weakly associated and a time/order signal remains. Effects below one quantum and causes not tracked by the headless rig are unresolved; if attribution is still required, use a reversed-order interleaved follow-up.

This was a headless Chromium capture through the null audio sink. It is not hardware validation.

## 1. Source, branch, bundle, and capture identity

- Source branch: `arena/e6a78ed6-apex-studio`
- Exact source commit used to build production audio code: `62fe6c95d58746ebf0095e1a0c501763e58a6e26`
- Source `src/` archive SHA-256: `e8316f04ac94e6658d6958dc513f1fe9b9896f54e458b2eb2c20fb828490007b`
- Executed engine bundle SHA-256: `ad65bad7f4256103b37bea6184933445b5a639250ba1b6b9f8e54957f8af2ddb` (386459 bytes; esbuild 0.28.2)
- Bundle HTTP identity gate: status `200`, body hash match `True`, cache `no-store, no-cache, must-revalidate, max-age=0`, service worker `False`.
- Rig HTML SHA-256: `c7cabe44617b06d01b5d13d6b15ee4b388d028f8397554b2b0ee71bec5eb01bb`; copied work-directory HTML matched byte-for-byte: `True`.
- Campaign runner SHA-256: `90ef38e6384b0d683fb080b655aff33bf7267dba43806707a67f2fb7a42406f8`; bundle builder SHA-256: `ce746b79c37e398fba7e9da4879420728cf53a8f93624630046077f882bd7507`.
- Runtime source marker matched on each run: `True`.
- Browser: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.0 Safari/537.36`; AudioContext sample rate `44100 Hz`; capture `running` at initialization.
- Raw data: `docs/verification/results/stage_c_pattern_length_campaign.json`.

No production audio source or tests were edited for this campaign. The rig is confined to `docs/verification/`.

## 2. Experimental design and measurement

| Setting | Controlled value |
|---|---|
| Conditions | 16-step vs 32-step Pattern mode |
| Events | Steps 0 and 8 in both; same channel, pitch, velocity, voice and synth parameters |
| Voice | MiniSynth, sequencer MIDI pitch 60, channel transpose 0, channel volume 0.9; default oscillator/waveform parameters saved in raw metadata |
| Tempo / grid | 120 BPM, 125 ms per sixteenth, step-0-to-step-8 nominal interval 1.000 s |
| Sample rate / capture | 44,100 Hz; ScriptProcessorNode buffer 4,096; 128-frame render quantum |
| Playback path | Production `audioEngine.play()` → `AudioClockTransport` → `triggerCurrentStep()` → production voice renderer |
| Capture path | Same Stage B hysteresis detector, same thresholds, masterGain tap and zero-gain sink for every run |
| Reference | No injected reference burst in either condition; onset differential cancels capture origin and matched voice onset bias |
| Order | Strict round-robin: 16-step, 32-step, 16-step, 32-step throughout |
| Primary endpoint | `N0 − N8` = scheduled gap minus observed onset gap; positive means step 0 is later relative to step 8 |

Fixture hash (all fixed channel settings except pattern length/storage length): `5edc1bb178e20603717e30967e581fe11f6b30dde9f22c84fa07a8969e75c2bf`.

## 3. Run accounting, exclusions, capture integrity

| Pattern | Attempts | Valid | Excluded | Exclusion reasons (counts; reasons can overlap) |
|---:|---:|---:|---:|---|
| 16 | 100 | 100 | 0 | none |
| 32 | 100 | 100 | 0 | none |

| Pattern | Valid capture chunks | Dropped buffers | Chunk lengths consistent | Median scheduled step-0→8 gap | Median step-grid error | Median start offset |
|---:|---:|---:|---|---:|---:|---:|
| 16 | 2000 | 0 | True | 1000.000000 ms | +0.000 ms | +30.000 ms |
| 32 | 2000 | 0 | True | 1000.000000 ms | +0.000 ms | +30.000 ms |

There were **100 valid complete pairs** in the primary analysis. The start-lead offset is reported as a bundle diagnostic and was not used to exclude runs; median values should be near `30.0 ms` for both conditions.
Invalid captures are retained in the raw JSON with explicit `exclusionReasons`; valid high/low residuals and Tukey-flagged outliers remain in all analyses.

## 4. Residual distributions

All values are milliseconds. The primary per-condition endpoint is the `N0 − N8` relative scheduling residual.

| Series | n | Mean | SD | Min | p10 | Q1 | Median | Q3 | p90 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 16-step | 100 | +1.615 | +2.197 | -0.272 | -0.272 | -0.272 | +2.619 | +2.630 | +5.533 | +8.435 |
| 32-step | 100 | +1.408 | +2.102 | -0.272 | -0.272 | -0.272 | -0.272 | +2.630 | +5.533 | +8.435 |
| Paired difference (32 − 16) | 100 | -0.207 | +3.104 | -8.707 | -2.902 | -2.902 | +0.000 | +2.902 | +2.902 | +8.707 |

- 16-step median: `+2.619 ms`, 95% percentile-bootstrap CI `-0.272 … +2.630 ms`.
- 32-step median: `-0.272 ms`, 95% percentile-bootstrap CI `-0.272 … +2.630 ms`.
- Paired median difference (32 − 16): `+0.000 ms`, 95% paired-bootstrap CI `+0.000 … +0.000 ms`; distribution-free 90% order-statistic median CI `+0.000 … +0.000 ms`.
- Paired mean difference: `-0.207 ms`, 95% paired-bootstrap CI `-0.816 … +0.400 ms`.

## 5. Paired statistical comparison

- Exact two-sided paired sign test of zero median contrast: `27` positive, `32` negative, `41` zero; `p = 0.602923` (non-zero pairs only).
- Tie-corrected Wilcoxon signed-rank normal approximation (continuity corrected): `W+ = 819.0`, `z = -0.516`, `p = 0.605664`; zero differences omitted.
- Distribution-free paired sign-based equivalence test, margin ± one render quantum (`±2.9025 ms`): lower one-sided `p = 6.28958e-06`, upper one-sided `p = 7.95266e-09`; equivalence at α=0.05: **True**.

The paired sign test and Wilcoxon signed-rank test use the interleaved complete pairs, not independent condition samples. The equivalence margin is one 128-frame quantum; it does not rule out sub-quantum effects.

## 6. Outliers and run-order / load diagnostics

Outliers are flagged with Tukey 1.5×IQR fences for description only; they are not removed.

- **16-step residuals:** 3 flagged outside `-4.626 … +6.984 ms`.
  - C101 (round 50): `+8.435 ms`
  - C107 (round 53): `+8.435 ms`
  - C189 (round 94): `+8.435 ms`
- **32-step residuals:** 1 flagged outside `-4.626 … +6.984 ms`.
  - C174 (round 86): `+8.435 ms`
- **Paired differences:** 0 flagged outside `-11.610 … +11.610 ms`.

- Strict-round-robin paired contrast (16-step then 32-step): `n=100`, median 32−16 `+0.000 ms`; each run alternated conditions, but within-pair order was fixed.

### Exploratory temporal diagnostics

The paired contrast was also inspected in two chronological halves (exploratory, not a pre-registered subgroup test):

| Paired rounds | n | 16-step median | 32-step median | Median 32−16 | Mean 32−16 | Positive / negative / zero pairs |
|---|---:|---:|---:|---:|---:|---:|
| First half | 50 | -0.261 ms | +2.630 ms | +0.000 ms | +0.548 ms | 18 / 11 / 21 |
| Second half | 50 | +2.630 ms | -0.272 ms | +0.000 ms | -0.961 ms | 9 / 21 / 20 |

Spearman correlation of the paired 32−16 difference with round index: `ρ=-0.258`. No p-value is attached: this post-hoc time diagnostic is exposed to serial dependence and the fixed within-pair order confounds condition position with time.

- Spearman rank correlations of paired residual difference (32−16) with the within-pair change in measured preparation/build/capture-jitter proxies:
  - `pairedDifferenceVsPlayCallPreparationDeltaMs`: `-0.054`
  - `pairedDifferenceVsStep0BuildDeltaMs`: `-0.038`
  - `pairedDifferenceVsCaptureJitterDeltaQuanta`: `-0.007`

The residual distribution is visibly run-variable. The measured runtime/capture proxies above show little monotonic association, so the campaign does not establish that load specifically caused the residual. The exploratory paired time trend may be load/order variation or a transient interaction; the current ordering cannot distinguish these explanations.

## 7. Decision and limitations

- **Decision:** No stable pooled pattern-length effect of one render quantum (2.902 ms) or greater was reproduced; the exact paired sign-based equivalence tests support the pooled median contrast lying within that margin. An exploratory time trend in the paired contrast remains, and the strict 16-then-32 order cannot separate run-position/time variation from a transient interaction.
- **Recommendation:** Close the pattern-length investigation without a speculative production fix. The remaining residual is run-variable, but this campaign does not prove that the cause is load: measured proxies were weakly associated and a time/order signal remains. Effects below one quantum and causes not tracked by the headless rig are unresolved; if attribution is still required, use a reversed-order interleaved follow-up.
- No production fix was implemented. No test was weakened or altered.
- The analysis compares the relative onset residual of two identical production MiniSynth events. It does not claim a hardware output timing result: Chromium ran headlessly with a null audio sink.
- The same graph, detector, sample rate, capture buffer, channel/mixer fixture, tempo, pitches, waveforms, event positions, and non-length settings were used for both patterns. The pattern-length metadata and matching step-storage length were the only condition changes.
- Uncertainty remaining: the fixed 16→32 position within each pair is confounded with within-pair time; the exploratory time trend cannot be attributed to load or to a transient pattern interaction. Effects below one render quantum, defects masked by this headless capture path, and causes not represented by the recorded proxies remain unresolved.

## 8. Reproduction commands

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund
python3 -m pip install --target /tmp/stage-c-brotli brotli
PYTHONPATH=/tmp/stage-c-brotli bash docs/verification/rig/setup_chromium.sh
node docs/verification/rig/build_stage_c_bundle.mjs /tmp/apex-stage-c
python3 docs/verification/rig/serve_stage_c.py /tmp/apex-stage-c 8099
# In another process, launch /tmp/scz/package/bin/chromium with the recorded Stage C CDP flags.
STAGE_C_VALID_PAIRS=100 STAGE_C_MAX_ROUNDS=150 node docs/verification/rig/run-stage-c.mjs
python3 docs/verification/rig/analyze_stage_c.py docs/verification/results/stage_c_pattern_length_campaign.json --out docs/verification/STAGE_C_PATTERN_LENGTH_REPORT.md
npx tsc --noEmit
npx tsx --test src/audio/transportStartLead.test.ts
```

The raw JSON is the source of truth: it contains every attempted run, event-time sequence, onset sample, capture coverage field, validity/exclusion decision, condition order, bundle identity marker and measurement proxy.
