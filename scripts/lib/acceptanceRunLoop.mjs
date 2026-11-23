/**
 * The repetition loop shared by the packaged native VST3 + live-input acceptance.
 *
 * Extracted from the acceptance script so its control flow can be tested directly:
 * whether a failed repetition ends the run is the difference between a fail-fast
 * production gate and a diagnostic pass, and that difference must not be able to
 * drift silently.
 *
 * The two modes differ in exactly one respect:
 *   - acceptance (default): the first failed repetition ends the loop;
 *   - diagnostic: every requested repetition is attempted.
 * Neither mode ever retries a repetition - the next index is a fresh attempt, never
 * a rerun of the one that failed. A repetition that failed stays failed, and the
 * returned status is FAIL if any repetition failed, so a diagnostic pass cannot
 * report success because its last repetition happened to pass.
 */
export async function runRepetitions(options) {
  const {
    runs,
    runOnce,
    continueAfterFailure = false,
    logStart = () => {},
    logPass = () => {},
    logError = () => {},
    describePass = null,
    describeFail = error => String(error?.message ?? error).split('\n')[0],
  } = options;

  const outcomes = [];
  let exitCode = 0;

  for (let index = 1; index <= runs; index++) {
    logStart(index, runs, continueAfterFailure);
    try {
      const run = await runOnce(index);
      outcomes.push({ run: index, status: 'PASS' });
      if (describePass) logPass(describePass(run));
    } catch (error) {
      exitCode = 1;
      const message = describeFail(error);
      outcomes.push({ run: index, status: 'FAIL', error: message });
      logError(message);
      if (!continueAfterFailure) break;
    }
  }

  const passed = outcomes.filter(outcome => outcome.status === 'PASS').length;
  return {
    exitCode,
    outcomes,
    requested: runs,
    attempted: outcomes.length,
    passed,
    failed: outcomes.length - passed,
    mode: continueAfterFailure ? 'diagnostic' : 'acceptance',
    // Any failure at all fails the whole pass, including in diagnostic mode.
    status: exitCode === 0 && passed === runs ? 'PASS' : 'FAIL',
  };
}
