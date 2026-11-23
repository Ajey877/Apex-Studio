/**
 * The cold-start forensic snapshot for one measurement of the native probe.
 *
 * One extractor for all three capture points - warm-up, after monitoring, and the
 * failure path - so a field added for one of them cannot be silently missing from
 * another. That is exactly what happened once: a run that failed at the warm-up
 * never reached the later capture, so the one repetition whose block decomposition
 * mattered emitted none at all.
 *
 * Every field defaults to null or an empty list. A measurement that did not produce
 * a value stays visibly absent rather than becoming a zero, because "0 ms" and
 * "not measured" mean opposite things in a real-time deadline investigation.
 */
export function coldStartFrom(native, capturedAt) {
  const source = native ?? {};
  return {
    blockBudgetMs: source.blockBudgetMs ?? null,
    worstTotalRoundTripMs: source.worstColdStartTotalMs ?? null,
    worstMarginMs: source.worstColdStartMarginMs ?? null,
    mainEventLoopLagMaxMs: source.mainEventLoopLagMaxMs ?? null,
    mainEventLoopLagDuringAudioMs: source.mainEventLoopLagDuringAudioMs ?? null,
    mainEventLoopWorstStalls: source.mainEventLoopWorstStalls ?? null,
    helperStartup: source.helperStartup ?? null,
    blocks: source.coldStartBlocks ?? [],
    // A miss at sequence 117 proved the first blocks alone can look perfectly
    // healthy in a run that still failed, so the guard also names the sequences it
    // gave up on and the blocks either side of them are captured.
    blocksAroundMiss: source.blocksAroundMiss ?? [],
    missedSequences: source.missedSequences ?? [],
    deadlineMissEvents: source.deadlineMissEvents ?? [],
    mainRecordedSequences: source.mainRecordedSequences ?? [],
    // Whether the AudioWorklet actually accepted the results these timings were
    // built from. A run whose blocks were rejected has no valid round trips or
    // margins, and that has to be visible next to the numbers rather than assumed.
    workletResultsAccepted: source.workletResultsAccepted ?? null,
    workletResultsRejected: source.workletResultsRejected ?? null,
    workletResultsUnattributable: source.workletResultsUnattributable ?? null,
    workletResultRejections: source.workletResultRejections ?? [],
    capturedAt,
  };
}
