/**
 * Best-effort forensic capture taken when a repetition fails, before the packaged
 * application is closed.
 *
 * Why it exists: the after-monitoring measurement never runs on a failing
 * repetition, so the only snapshot left is the warm-up one. A miss that happens
 * mid-session - one was measured at sequence 117, about 2.5 s into playback - looks
 * perfectly healthy in the first blocks, so reporting the warm-up window for that
 * failure described a passing picture of a run that had failed.
 *
 * Contract:
 *   - this never throws and never replaces the original acceptance error, which
 *     stays authoritative;
 *   - a capture problem is reported as `failureCaptureError` or
 *     `failureCaptureSkipped`, separately from the acceptance failure;
 *   - when no capture is possible the caller keeps the warm-up snapshot it already
 *     has, so evidence is only ever added, never lost.
 */
export async function captureFailureEvidence(options) {
  const { page, coldStartFrom, helperPids, label = 'failureCapture' } = options;
  const result = {};

  try {
    if (!page) {
      result.failureCaptureSkipped = 'no page at failure time';
      return result;
    }
    const available = await page
      .evaluate(() => typeof window.__apexAcceptance?.measureNativeMonitoringCoexistence === 'function')
      .catch(() => false);
    if (!available) {
      result.failureCaptureSkipped = 'acceptance probe unavailable at failure time';
      return result;
    }
    const atFailure = await page.evaluate(probeLabel => window.__apexAcceptance
      .measureNativeMonitoringCoexistence(probeLabel), label);
    // `coldStartFrom` is the same extractor the warm-up and after-monitoring
    // captures use, so a field cannot be present in one snapshot and missing here.
    result.coldStartAtFailure = coldStartFrom(atFailure.native, 'failure');
    if (typeof helperPids === 'function') result.helpersAtFailure = helperPids();
    return result;
  } catch (error) {
    // Diagnostic capture must never mask the failure it is describing.
    result.failureCaptureError = `${error?.message ?? error}`.split('\n')[0];
    return result;
  }
}
