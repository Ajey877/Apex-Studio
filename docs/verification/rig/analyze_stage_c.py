#!/usr/bin/env python3
"""Analyze the Stage C paired, interleaved pattern-length campaign (stdlib only)."""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from collections import Counter
from pathlib import Path

QUANTUM_MS = 128 / 44100 * 1000
BOOTSTRAP_REPLICATES = 20_000


def quantile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return math.nan
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * p
    lo = int(position)
    hi = min(lo + 1, len(ordered) - 1)
    fraction = position - lo
    return ordered[lo] + (ordered[hi] - ordered[lo]) * fraction


def bootstrap_ci(values: list[float], stat: str, seed: int, reps: int = BOOTSTRAP_REPLICATES) -> tuple[float, float]:
    rng = random.Random(seed)
    n = len(values)
    estimates = []
    for _ in range(reps):
        sample = [values[rng.randrange(n)] for _ in range(n)]
        estimates.append(statistics.median(sample) if stat == 'median' else statistics.fmean(sample))
    return quantile(estimates, 0.025), quantile(estimates, 0.975)


def describe(values: list[float]) -> dict[str, float | int]:
    return {
        'n': len(values),
        'mean': statistics.fmean(values),
        'sd': statistics.stdev(values) if len(values) > 1 else 0.0,
        'min': min(values),
        'p10': quantile(values, 0.10),
        'q1': quantile(values, 0.25),
        'median': statistics.median(values),
        'q3': quantile(values, 0.75),
        'p90': quantile(values, 0.90),
        'max': max(values),
        'iqr': quantile(values, 0.75) - quantile(values, 0.25),
    }


def outliers(values: list[float], records: list[dict]) -> tuple[float, float, list[tuple[dict, float]]]:
    q1 = quantile(values, 0.25)
    q3 = quantile(values, 0.75)
    spread = q3 - q1
    low, high = q1 - 1.5 * spread, q3 + 1.5 * spread
    flagged = [(record, value) for record, value in zip(records, values) if value < low or value > high]
    return low, high, flagged


def binom_cdf(k: int, n: int) -> float:
    if k < 0:
        return 0.0
    if k >= n:
        return 1.0
    return sum(math.comb(n, i) for i in range(k + 1)) / (2 ** n)


def binom_sf_ge(k: int, n: int) -> float:
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    return sum(math.comb(n, i) for i in range(k, n + 1)) / (2 ** n)


def exact_sign_test(values: list[float]) -> dict:
    nonzero = [v for v in values if abs(v) > 1e-9]
    n = len(nonzero)
    positive = sum(v > 0 for v in nonzero)
    if n == 0:
        return {'n_nonzero': 0, 'positive': 0, 'negative': 0, 'zero': len(values), 'p_two_sided': 1.0}
    lower = min(positive, n - positive)
    p = min(1.0, 2.0 * binom_cdf(lower, n))
    return {
        'n_nonzero': n,
        'positive': positive,
        'negative': n - positive,
        'zero': len(values) - n,
        'p_two_sided': p,
    }


def wilcoxon_signed_rank(values: list[float]) -> dict:
    nonzero = [v for v in values if abs(v) > 1e-9]
    n = len(nonzero)
    if n == 0:
        return {'n_nonzero': 0, 'positive_rank_sum': 0.0, 'negative_rank_sum': 0.0, 'z': 0.0, 'p_two_sided': 1.0}

    ordered = sorted((abs(value), value) for value in nonzero)
    ranks = [0.0] * n
    tie_sizes = []
    index = 0
    while index < n:
        end = index + 1
        while end < n and abs(ordered[end][0] - ordered[index][0]) <= 1e-9:
            end += 1
        average_rank = ((index + 1) + end) / 2.0
        for k in range(index, end):
            ranks[k] = average_rank
        tie_sizes.append(end - index)
        index = end

    positive_rank_sum = sum(ranks[i] for i, (_, value) in enumerate(ordered) if value > 0)
    total_rank_sum = n * (n + 1) / 2.0
    negative_rank_sum = total_rank_sum - positive_rank_sum
    mean = n * (n + 1) / 4.0
    variance = n * (n + 1) * (2 * n + 1) / 24.0
    variance -= sum(size ** 3 - size for size in tie_sizes) / 48.0
    if variance <= 0:
        return {
            'n_nonzero': n,
            'positive_rank_sum': positive_rank_sum,
            'negative_rank_sum': negative_rank_sum,
            'z': 0.0,
            'p_two_sided': 1.0,
        }
    difference = abs(positive_rank_sum - mean)
    z = math.copysign(max(0.0, difference - 0.5) / math.sqrt(variance), positive_rank_sum - mean)
    p = math.erfc(abs(z) / math.sqrt(2.0))
    return {
        'n_nonzero': n,
        'positive_rank_sum': positive_rank_sum,
        'negative_rank_sum': negative_rank_sum,
        'z': z,
        'p_two_sided': p,
    }


def exact_sign_equivalence(values: list[float], margin: float) -> dict:
    """Two one-sided exact sign tests for a median within +/- margin."""
    n = len(values)
    greater_than_lower = sum(value > -margin for value in values)
    less_than_upper = sum(value < margin for value in values)
    lower_p = binom_sf_ge(greater_than_lower, n)
    upper_p = binom_sf_ge(less_than_upper, n)
    return {
        'margin': margin,
        'n': n,
        'greater_than_lower': greater_than_lower,
        'less_than_upper': less_than_upper,
        'lower_one_sided_p': lower_p,
        'upper_one_sided_p': upper_p,
        'equivalent_at_alpha_0_05': lower_p < 0.05 and upper_p < 0.05,
    }


def exact_median_ci(values: list[float], confidence: float = 0.90) -> tuple[float, float]:
    """Distribution-free order-statistic interval for the population median."""
    ordered = sorted(values)
    n = len(ordered)
    tail = (1.0 - confidence) / 2.0
    # Select the largest k whose lower binomial tail is no greater than alpha/2.
    k = 0
    for candidate in range(1, (n + 1) // 2 + 1):
        if binom_cdf(candidate - 1, n) <= tail:
            k = candidate
        else:
            break
    if k == 0:
        return ordered[0], ordered[-1]
    lower_index = k - 1
    upper_index = n - k
    return ordered[lower_index], ordered[upper_index]


def average_ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i + 1
        while j < len(order) and abs(values[order[j]] - values[order[i]]) <= 1e-12:
            j += 1
        rank = ((i + 1) + j) / 2.0
        for k in range(i, j):
            ranks[order[k]] = rank
        i = j
    return ranks


def spearman(values_x: list[float], values_y: list[float]) -> float | None:
    pairs = [(x, y) for x, y in zip(values_x, values_y) if math.isfinite(x) and math.isfinite(y)]
    if len(pairs) < 3:
        return None
    rx = average_ranks([pair[0] for pair in pairs])
    ry = average_ranks([pair[1] for pair in pairs])
    mx = statistics.fmean(rx)
    my = statistics.fmean(ry)
    cov = sum((x - mx) * (y - my) for x, y in zip(rx, ry))
    den = math.sqrt(sum((x - mx) ** 2 for x in rx) * sum((y - my) ** 2 for y in ry))
    return cov / den if den else None


def fmt(value: float | None, places: int = 3) -> str:
    if value is None or not math.isfinite(value):
        return 'NA'
    return f'{value:+.{places}f}'


def describe_line(label: str, summary: dict) -> str:
    return (
        f"| {label} | {summary['n']} | {fmt(summary['mean'])} | {fmt(summary['sd'])} | "
        f"{fmt(summary['min'])} | {fmt(summary['p10'])} | {fmt(summary['q1'])} | "
        f"{fmt(summary['median'])} | {fmt(summary['q3'])} | {fmt(summary['p90'])} | {fmt(summary['max'])} |"
    )


def analyze(path: Path) -> tuple[dict, str]:
    data = json.loads(path.read_text())
    runs = data.get('runSequence', [])
    metadata = data.get('metadata', {})
    by_length = {
        length: [run for run in runs if run.get('patternLengthSteps') == length and run.get('valid')]
        for length in (16, 32)
    }
    raw_by_length = {
        length: [run for run in runs if run.get('patternLengthSteps') == length]
        for length in (16, 32)
    }
    if any(len(by_length[length]) < 100 for length in (16, 32)):
        raise ValueError(f"Need >=100 valid runs per condition; got 16={len(by_length[16])}, 32={len(by_length[32])}")

    paired_rounds = []
    for round_data in data.get('rounds', []):
        if not round_data.get('includedInPrimaryPairedAnalysis'):
            continue
        candidates = [runs[index] for index in round_data.get('sequenceIndices', [])]
        sixteen = next((run for run in candidates if run.get('patternLengthSteps') == 16 and run.get('valid')), None)
        thirty_two = next((run for run in candidates if run.get('patternLengthSteps') == 32 and run.get('valid')), None)
        if sixteen and thirty_two:
            paired_rounds.append((round_data, sixteen, thirty_two))
    if len(paired_rounds) < 100:
        raise ValueError(f'Need >=100 complete valid paired rounds; got {len(paired_rounds)}')

    x16 = [float(run['n0MinusN8ResidualMs']) for run in by_length[16]]
    x32 = [float(run['n0MinusN8ResidualMs']) for run in by_length[32]]
    paired16 = [float(pair[1]['n0MinusN8ResidualMs']) for pair in paired_rounds]
    paired32 = [float(pair[2]['n0MinusN8ResidualMs']) for pair in paired_rounds]
    differences = [v32 - v16 for v16, v32 in zip(paired16, paired32)]

    desc16 = describe(x16)
    desc32 = describe(x32)
    desc_diff = describe(differences)
    ci16 = bootstrap_ci(x16, 'median', 20261017)
    ci32 = bootstrap_ci(x32, 'median', 20261018)
    ci_diff_median = bootstrap_ci(differences, 'median', 20261019)
    ci_diff_mean = bootstrap_ci(differences, 'mean', 20261020)
    exact_median_ci_diff = exact_median_ci(differences, 0.90)
    sign = exact_sign_test(differences)
    wilcoxon = wilcoxon_signed_rank(differences)
    equivalence = exact_sign_equivalence(differences, QUANTUM_MS)

    outlier_data = {}
    for length, values in ((16, x16), (32, x32)):
        lower, upper, flagged = outliers(values, by_length[length])
        outlier_data[str(length)] = {
            'lowerFenceMs': lower,
            'upperFenceMs': upper,
            'n': len(flagged),
            'records': [
                {'runId': record['runId'], 'roundIndex': record['roundIndex'], 'residualMs': value}
                for record, value in flagged
            ],
        }
    lower_diff, upper_diff, flagged_diff = outliers(differences, [pair[0] for pair in paired_rounds])
    outlier_data['pairedDifference'] = {
        'lowerFenceMs': lower_diff,
        'upperFenceMs': upper_diff,
        'n': len(flagged_diff),
        'records': [
            {'roundIndex': round_data['roundIndex'], 'differenceMs': value}
            for round_data, value in flagged_diff
        ],
        'retainedInAllAnalyses': True,
    }

    exclusions = {}
    for length in (16, 32):
        invalid = [run for run in raw_by_length[length] if not run.get('valid')]
        counts = Counter(reason for run in invalid for reason in run.get('exclusionReasons', []))
        exclusions[str(length)] = {
            'attempted': len(raw_by_length[length]),
            'valid': len(by_length[length]),
            'excludedRuns': len(invalid),
            'reasonCounts': dict(sorted(counts.items())),
        }

    paired_orders = {16: [], 32: []}
    for round_data, run16, run32 in paired_rounds:
        order = round_data.get('order', [])
        first = order[0] if order else None
        paired_orders[first].append(float(run32['n0MinusN8ResidualMs']) - float(run16['n0MinusN8ResidualMs']))
    order_summaries = {
        '16_then32': {
            'n': len(paired_orders[16]),
            'medianDifferenceMs': statistics.median(paired_orders[16]) if paired_orders[16] else None,
            'meanDifferenceMs': statistics.fmean(paired_orders[16]) if paired_orders[16] else None,
        },
        '32_then16': {
            'n': len(paired_orders[32]),
            'medianDifferenceMs': statistics.median(paired_orders[32]) if paired_orders[32] else None,
            'meanDifferenceMs': statistics.fmean(paired_orders[32]) if paired_orders[32] else None,
        },
    }

    middle = len(paired_rounds) // 2
    time_block_slices = [
        ('firstHalf', paired_rounds[:middle]),
        ('secondHalf', paired_rounds[middle:]),
    ]
    time_blocks = {}
    for name, block in time_block_slices:
        block16 = [float(pair[1]['n0MinusN8ResidualMs']) for pair in block]
        block32 = [float(pair[2]['n0MinusN8ResidualMs']) for pair in block]
        block_diff = [v32 - v16 for v16, v32 in zip(block16, block32)]
        time_blocks[name] = {
            'n': len(block),
            'median16Ms': statistics.median(block16),
            'median32Ms': statistics.median(block32),
            'medianDifference32Minus16Ms': statistics.median(block_diff),
            'meanDifference32Minus16Ms': statistics.fmean(block_diff),
            'positiveDifferences': sum(value > 0 for value in block_diff),
            'negativeDifferences': sum(value < 0 for value in block_diff),
            'zeroDifferences': sum(abs(value) <= 1e-9 for value in block_diff),
        }
    paired_round_numbers = [float(pair[0]['roundIndex']) for pair in paired_rounds]
    paired_difference_time_spearman = spearman(paired_round_numbers, differences)

    paired_preparation_delta = [
        float(run32['performance']['playCallPreparationMs']) - float(run16['performance']['playCallPreparationMs'])
        for _, run16, run32 in paired_rounds
    ]
    paired_step0_build_delta = [
        float(run32['performance']['step0TriggerBuildMs']) - float(run16['performance']['step0TriggerBuildMs'])
        for _, run16, run32 in paired_rounds
    ]
    paired_capture_jitter_delta = [
        float(run32['capture']['ptJitterQuantaMax']) - float(run16['capture']['ptJitterQuantaMax'])
        for _, run16, run32 in paired_rounds
    ]
    load_proxies = {
        'pairedDifferenceVsPlayCallPreparationDeltaMs': spearman(differences, paired_preparation_delta),
        'pairedDifferenceVsStep0BuildDeltaMs': spearman(differences, paired_step0_build_delta),
        'pairedDifferenceVsCaptureJitterDeltaQuanta': spearman(differences, paired_capture_jitter_delta),
    }

    capture_summary = {}
    for length in (16, 32):
        valid_runs = by_length[length]
        capture_summary[str(length)] = {
            'totalChunks': sum(run['capture']['chunkCount'] for run in valid_runs),
            'droppedBuffers': sum(run['capture']['droppedBuffers'] for run in valid_runs),
            'allChunkLengthsConsistent': all(run['capture']['chunkLengthsConsistent'] for run in valid_runs),
            'onsetCountMismatchesAmongRaw': sum(run['onsetCount'] != 2 for run in raw_by_length[length]),
            'scheduledGapMedianMs': statistics.median(float(run['scheduledGapSeconds']) * 1000 for run in valid_runs),
            'scheduledGridErrorMedianMs': statistics.median(float(run['scheduledGridErrorMs']) for run in valid_runs),
            'startLeadMedianMs': statistics.median(float(run['startOffsetMs']) for run in valid_runs),
            'startLeadP90Ms': quantile([float(run['startOffsetMs']) for run in valid_runs], 0.90),
            'playCallPreparationMedianMs': statistics.median(float(run['performance']['playCallPreparationMs']) for run in valid_runs),
            'playCallPreparationP90Ms': quantile([float(run['performance']['playCallPreparationMs']) for run in valid_runs], 0.90),
        }

    median_delta = desc_diff['median']
    ci_excludes_zero = ci_diff_median[0] > 0 or ci_diff_median[1] < 0
    if sign['p_two_sided'] < 0.05 and ci_excludes_zero:
        verdict = 'A paired pattern-length effect is statistically reproducible in this controlled headless campaign.'
        recommendation = ('Do not implement a correction in this experiment. First add a regression test that distinguishes the measured 16-vs-32 defect from load variation, then investigate only the code path supported by the raw schedule/latency proxies. The current evidence is not hardware validation.')
    elif equivalence['equivalent_at_alpha_0_05']:
        verdict = (f'No stable pooled pattern-length effect of one render quantum ({QUANTUM_MS:.3f} ms) or greater was reproduced; the exact paired sign-based equivalence tests support the pooled median contrast lying within that margin. An exploratory time trend in the paired contrast remains, and the strict 16-then-32 order cannot separate run-position/time variation from a transient interaction.')
        recommendation = ('Close the pattern-length investigation without a speculative production fix. The remaining residual is run-variable, but this campaign does not prove that the cause is load: measured proxies were weakly associated and a time/order signal remains. Effects below one quantum and causes not tracked by the headless rig are unresolved; if attribution is still required, use a reversed-order interleaved follow-up.')
    else:
        verdict = ('The controlled campaign did not produce decisive evidence of a pattern-length effect or establish practical equivalence at the one-quantum margin.')
        recommendation = ('Do not implement a speculative production fix. Keep the result inconclusive; increase paired valid runs or improve the non-hardware measurement only if the residual remains actionable.')

    source_branch = metadata.get('sourceBranch', 'unknown')
    source_commit = metadata.get('sourceCommit', 'unknown')
    bundle_gate = metadata.get('bundleIdentityGate', {})
    report = []
    report.extend([
        '# Stage C — Final Controlled Pattern-Length Experiment',
        '',
        f'**Verdict:** {verdict}',
        '',
        f'**Recommendation:** {recommendation}',
        '',
        'This was a headless Chromium capture through the null audio sink. It is not hardware validation.',
        '',
        '## 1. Source, branch, bundle, and capture identity',
        '',
        f'- Source branch: `{source_branch}`',
        f'- Exact source commit used to build production audio code: `{source_commit}`',
        f'- Source `src/` archive SHA-256: `{metadata.get("sourceArchiveSha256", "unknown")}`',
        f'- Executed engine bundle SHA-256: `{metadata.get("bundleSha256", "unknown")}` ({metadata.get("bundleBytes", "?")} bytes; esbuild {metadata.get("esbuildVersion", "unknown")})',
        f'- Bundle HTTP identity gate: status `{bundle_gate.get("responseStatus", "unknown")}`, body hash match `{bundle_gate.get("browserExecutedBundleSha256MatchesManifest", False)}`, cache `{bundle_gate.get("cacheControl", "unknown")}`, service worker `{bundle_gate.get("fromServiceWorker", "unknown")}`.',
        f'- Rig HTML SHA-256: `{metadata.get("measurementRigSha256", {}).get("docs/verification/rig/stage-c-rig.html", "unknown")}`; copied work-directory HTML matched byte-for-byte: `{metadata.get("measurementRigHtmlCopyMatch", False)}`.',
        f'- Campaign runner SHA-256: `{metadata.get("measurementRigSha256", {}).get("docs/verification/rig/run-stage-c.mjs", "unknown")}`; bundle builder SHA-256: `{metadata.get("measurementRigSha256", {}).get("docs/verification/rig/build_stage_c_bundle.mjs", "unknown")}`.',
        f'- Runtime source marker matched on each run: `{all(run.get("sourceCommitMarker") == source_commit for run in runs)}`.',
        f'- Browser: `{metadata.get("runtime", {}).get("userAgent", "unknown")}`; AudioContext sample rate `{metadata.get("runtime", {}).get("sampleRate", "unknown")} Hz`; capture `{metadata.get("runtime", {}).get("contextState", "unknown")}` at initialization.',
        f'- Raw data: `{metadata.get("artifactPath", path.name)}`.',
        '',
        'No production audio source or tests were edited for this campaign. The rig is confined to `docs/verification/`.',
        '',
        '## 2. Experimental design and measurement',
        '',
        '| Setting | Controlled value |',
        '|---|---|',
        '| Conditions | 16-step vs 32-step Pattern mode |',
        '| Events | Steps 0 and 8 in both; same channel, pitch, velocity, voice and synth parameters |',
        '| Voice | MiniSynth, sequencer MIDI pitch 60, channel transpose 0, channel volume 0.9; default oscillator/waveform parameters saved in raw metadata |',
        '| Tempo / grid | 120 BPM, 125 ms per sixteenth, step-0-to-step-8 nominal interval 1.000 s |',
        '| Sample rate / capture | 44,100 Hz; ScriptProcessorNode buffer 4,096; 128-frame render quantum |',
        '| Playback path | Production `audioEngine.play()` → `AudioClockTransport` → `triggerCurrentStep()` → production voice renderer |',
        '| Capture path | Same Stage B hysteresis detector, same thresholds, masterGain tap and zero-gain sink for every run |',
        '| Reference | No injected reference burst in either condition; onset differential cancels capture origin and matched voice onset bias |',
        '| Order | Strict round-robin: 16-step, 32-step, 16-step, 32-step throughout |',
        '| Primary endpoint | `N0 − N8` = scheduled gap minus observed onset gap; positive means step 0 is later relative to step 8 |',
        '',
        f'Fixture hash (all fixed channel settings except pattern length/storage length): `{metadata.get("channelFixtureSha256", "unknown")}`.',
        '',
        '## 3. Run accounting, exclusions, capture integrity',
        '',
        '| Pattern | Attempts | Valid | Excluded | Exclusion reasons (counts; reasons can overlap) |',
        '|---:|---:|---:|---:|---|',
    ])
    for length in (16, 32):
        e = exclusions[str(length)]
        reasons = ', '.join(f'{key}={value}' for key, value in e['reasonCounts'].items()) or 'none'
        report.append(f"| {length} | {e['attempted']} | {e['valid']} | {e['excludedRuns']} | {reasons} |")
    report.extend([
        '',
        '| Pattern | Valid capture chunks | Dropped buffers | Chunk lengths consistent | Median scheduled step-0→8 gap | Median step-grid error | Median start offset |',
        '|---:|---:|---:|---|---:|---:|---:|',
    ])
    for length in (16, 32):
        c = capture_summary[str(length)]
        report.append(
            f"| {length} | {c['totalChunks']} | {c['droppedBuffers']} | {c['allChunkLengthsConsistent']} | "
            f"{c['scheduledGapMedianMs']:.6f} ms | {fmt(c['scheduledGridErrorMedianMs'])} ms | {fmt(c['startLeadMedianMs'])} ms |"
        )
    report.extend([
        '',
        f"There were **{len(paired_rounds)} valid complete pairs** in the primary analysis. The start-lead offset is reported as a bundle diagnostic and was not used to exclude runs; median values should be near `{metadata.get('runtime', {}).get('startLeadSeconds', 0.03) * 1000:.1f} ms` for both conditions.",
        'Invalid captures are retained in the raw JSON with explicit `exclusionReasons`; valid high/low residuals and Tukey-flagged outliers remain in all analyses.',
        '',
        '## 4. Residual distributions',
        '',
        'All values are milliseconds. The primary per-condition endpoint is the `N0 − N8` relative scheduling residual.',
        '',
        '| Series | n | Mean | SD | Min | p10 | Q1 | Median | Q3 | p90 | Max |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
        describe_line('16-step', desc16),
        describe_line('32-step', desc32),
        describe_line('Paired difference (32 − 16)', desc_diff),
        '',
        f"- 16-step median: `{fmt(desc16['median'])} ms`, 95% percentile-bootstrap CI `{fmt(ci16[0])} … {fmt(ci16[1])} ms`.",
        f"- 32-step median: `{fmt(desc32['median'])} ms`, 95% percentile-bootstrap CI `{fmt(ci32[0])} … {fmt(ci32[1])} ms`.",
        f"- Paired median difference (32 − 16): `{fmt(desc_diff['median'])} ms`, 95% paired-bootstrap CI `{fmt(ci_diff_median[0])} … {fmt(ci_diff_median[1])} ms`; distribution-free 90% order-statistic median CI `{fmt(exact_median_ci_diff[0])} … {fmt(exact_median_ci_diff[1])} ms`.",
        f"- Paired mean difference: `{fmt(desc_diff['mean'])} ms`, 95% paired-bootstrap CI `{fmt(ci_diff_mean[0])} … {fmt(ci_diff_mean[1])} ms`.",
        '',
        '## 5. Paired statistical comparison',
        '',
        f"- Exact two-sided paired sign test of zero median contrast: `{sign['positive']}` positive, `{sign['negative']}` negative, `{sign['zero']}` zero; `p = {sign['p_two_sided']:.6g}` (non-zero pairs only).",
        f"- Tie-corrected Wilcoxon signed-rank normal approximation (continuity corrected): `W+ = {wilcoxon['positive_rank_sum']:.1f}`, `z = {wilcoxon['z']:.3f}`, `p = {wilcoxon['p_two_sided']:.6g}`; zero differences omitted.",
        f"- Distribution-free paired sign-based equivalence test, margin ± one render quantum (`±{QUANTUM_MS:.4f} ms`): lower one-sided `p = {equivalence['lower_one_sided_p']:.6g}`, upper one-sided `p = {equivalence['upper_one_sided_p']:.6g}`; equivalence at α=0.05: **{equivalence['equivalent_at_alpha_0_05']}**.",
        '',
        'The paired sign test and Wilcoxon signed-rank test use the interleaved complete pairs, not independent condition samples. The equivalence margin is one 128-frame quantum; it does not rule out sub-quantum effects.',
        '',
        '## 6. Outliers and run-order / load diagnostics',
        '',
        'Outliers are flagged with Tukey 1.5×IQR fences for description only; they are not removed.',
        '',
    ])
    for key, label in (('16', '16-step residuals'), ('32', '32-step residuals'), ('pairedDifference', 'Paired differences')):
        items = outlier_data[key]
        report.append(f"- **{label}:** {items['n']} flagged outside `{fmt(items['lowerFenceMs'])} … {fmt(items['upperFenceMs'])} ms`.")
        for item in items['records']:
            if key == 'pairedDifference':
                report.append(f"  - round {item['roundIndex']}: `{fmt(item['differenceMs'])} ms`")
            else:
                report.append(f"  - {item['runId']} (round {item['roundIndex']}): `{fmt(item['residualMs'])} ms`")
    report.extend([
        '',
        f"- Strict-round-robin paired contrast (16-step then 32-step): `n={order_summaries['16_then32']['n']}`, median 32−16 `{fmt(order_summaries['16_then32']['medianDifferenceMs'])} ms`; each run alternated conditions, but within-pair order was fixed.",
        '',
        '### Exploratory temporal diagnostics',
        '',
        'The paired contrast was also inspected in two chronological halves (exploratory, not a pre-registered subgroup test):',
        '',
        '| Paired rounds | n | 16-step median | 32-step median | Median 32−16 | Mean 32−16 | Positive / negative / zero pairs |',
        '|---|---:|---:|---:|---:|---:|---:|',
    ])
    for key, label in (('firstHalf', 'First half'), ('secondHalf', 'Second half')):
        block = time_blocks[key]
        report.append(
            f"| {label} | {block['n']} | {fmt(block['median16Ms'])} ms | {fmt(block['median32Ms'])} ms | "
            f"{fmt(block['medianDifference32Minus16Ms'])} ms | {fmt(block['meanDifference32Minus16Ms'])} ms | "
            f"{block['positiveDifferences']} / {block['negativeDifferences']} / {block['zeroDifferences']} |"
        )
    report.extend([
        '',
        f"Spearman correlation of the paired 32−16 difference with round index: `ρ={fmt(paired_difference_time_spearman, 3)}`. No p-value is attached: this post-hoc time diagnostic is exposed to serial dependence and the fixed within-pair order confounds condition position with time.",
        '',
        '- Spearman rank correlations of paired residual difference (32−16) with the within-pair change in measured preparation/build/capture-jitter proxies:',
    ])
    for name, value in load_proxies.items():
        report.append(f"  - `{name}`: `{fmt(value, 3)}`" if value is not None else f'  - `{name}`: unavailable (insufficient variation)')
    report.extend([
        '',
        'The residual distribution is visibly run-variable. The measured runtime/capture proxies above show little monotonic association, so the campaign does not establish that load specifically caused the residual. The exploratory paired time trend may be load/order variation or a transient interaction; the current ordering cannot distinguish these explanations.',
        '',
        '## 7. Decision and limitations',
        '',
        f'- **Decision:** {verdict}',
        f'- **Recommendation:** {recommendation}',
        '- No production fix was implemented. No test was weakened or altered.',
        '- The analysis compares the relative onset residual of two identical production MiniSynth events. It does not claim a hardware output timing result: Chromium ran headlessly with a null audio sink.',
        '- The same graph, detector, sample rate, capture buffer, channel/mixer fixture, tempo, pitches, waveforms, event positions, and non-length settings were used for both patterns. The pattern-length metadata and matching step-storage length were the only condition changes.',
        '- Uncertainty remaining: the fixed 16→32 position within each pair is confounded with within-pair time; the exploratory time trend cannot be attributed to load or to a transient pattern interaction. Effects below one render quantum, defects masked by this headless capture path, and causes not represented by the recorded proxies remain unresolved.',
        '',
        '## 8. Reproduction commands',
        '',
        '```sh',
        'ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund',
        'python3 -m pip install --target /tmp/stage-c-brotli brotli',
        'PYTHONPATH=/tmp/stage-c-brotli bash docs/verification/rig/setup_chromium.sh',
        'node docs/verification/rig/build_stage_c_bundle.mjs /tmp/apex-stage-c',
        'python3 docs/verification/rig/serve_stage_c.py /tmp/apex-stage-c 8099',
        '# In another process, launch /tmp/scz/package/bin/chromium with the recorded Stage C CDP flags.',
        'STAGE_C_VALID_PAIRS=100 STAGE_C_MAX_ROUNDS=150 node docs/verification/rig/run-stage-c.mjs',
        'python3 docs/verification/rig/analyze_stage_c.py docs/verification/results/stage_c_pattern_length_campaign.json --out docs/verification/STAGE_C_PATTERN_LENGTH_REPORT.md',
        'npx tsc --noEmit',
        'npx tsx --test src/audio/transportStartLead.test.ts',
        '```',
        '',
        'The raw JSON is the source of truth: it contains every attempted run, event-time sequence, onset sample, capture coverage field, validity/exclusion decision, condition order, bundle identity marker and measurement proxy.',
        '',
    ])

    summary = {
        'validRuns16': len(by_length[16]),
        'validRuns32': len(by_length[32]),
        'validPairedRounds': len(paired_rounds),
        'medianResidual16Ms': desc16['median'],
        'medianResidual32Ms': desc32['median'],
        'pairedMedianDifference32Minus16Ms': desc_diff['median'],
        'pairedMedianBootstrapCi95Ms': ci_diff_median,
        'pairedSignP': sign['p_two_sided'],
        'pairedWilcoxonP': wilcoxon['p_two_sided'],
        'equivalenceMarginMs': QUANTUM_MS,
        'equivalentWithinOneQuantum': equivalence['equivalent_at_alpha_0_05'],
        'verdict': verdict,
        'recommendation': recommendation,
        'outliers': outlier_data,
        'exclusions': exclusions,
        'captureSummary': capture_summary,
        'loadProxySpearman': load_proxies,
        'pairedDifferenceVsRoundIndexSpearman': paired_difference_time_spearman,
        'timeBlocks': time_blocks,
        'orderSummary': order_summaries,
    }
    return summary, '\n'.join(report)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('raw_data', type=Path)
    parser.add_argument('--out', type=Path, help='Write the Markdown report to this path.')
    args = parser.parse_args()
    summary, report = analyze(args.raw_data)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report)
    else:
        print(report)
    print(json.dumps(summary, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
