/**
 * Capture-integrity diagnostic report truthfulness.
 *
 * The 240-trial isolation report (docs/verification/capture-integrity/isolation/
 * REPORT.md) shipped with one prose miscount: it claimed "five jobs failed final
 * experiment status, three succeeded" while GitHub run 39566258125 and the
 * report's own fidelity tables show exactly four failing browser/mode jobs
 * (chrome lead, chrome immediate, playwright no-ready, playwright immediate)
 * and four successes. The count was corrected during PR #267 merge
 * finalization; this suite pins the correction and the surrounding internal
 * consistency so a summary sentence can never again contradict the retained
 * per-job tables, the evidence manifest, or the raw-hash index.
 *
 * Everything here is offline and deterministic: it parses the tracked reports,
 * the tracked evidence manifest and the tracked checksum index only. Live
 * GitHub metadata (run/job conclusions, artifact digests) was re-verified
 * through the Actions API during merge finalization; the manifest values parsed
 * here are the recorded copies of that metadata.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DOC_ROOT = 'docs/verification/capture-integrity';
/** Line-ending agnostic reader — the repo convention for source-inspection tests
    (see productTruthStrings.test.ts): Windows runners check text files out with
    CRLF, which must not change what the parsers below see. */
const read = (relative: string): string => readFileSync(`${DOC_ROOT}/${relative}`, 'utf8').replace(/\r\n/g, '\n');

const isolationReport = read('isolation/REPORT.md');
const readinessHostedReport = read('readiness/HOSTED-REPORT.md');
const isolationManifest = JSON.parse(read('isolation/hosted/evidence-manifest.json'));
const readinessManifest = JSON.parse(read('readiness/hosted/evidence-manifest.json'));
const rawHashIndex = read('isolation/hosted/raw-sha256.txt');

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

interface SummaryRow {
  browser: string;
  mode: string;
  runs: number;
  startupAnomalous: number;
  postReadyAnomalies: number;
  coveragePass: number;
  fidelityPass: number;
  fidelityTotal: number;
}

/** Parses the eight "| Browser / mode | Runs | Startup | Post-ready | Coverage | Fidelity |" rows. */
const parseSummaryTable = (report: string): SummaryRow[] => {
  const rows: SummaryRow[] = [];
  const line = /^\| (Chromium 153|Chrome [\d.]+) \/ (lead|no-ready|immediate|generated) \| (\d+) \| (\d+) \| (\d+) \| (\d+)\/(\d+) \| \*{0,2}(\d+)\/(\d+)\*{0,2} \|$/;
  for (const text of report.split('\n')) {
    const match = text.match(line);
    if (!match) continue;
    rows.push({
      browser: match[1],
      mode: match[2],
      runs: Number(match[3]),
      startupAnomalous: Number(match[4]),
      postReadyAnomalies: Number(match[5]),
      coveragePass: Number(match[6]),
      fidelityPass: Number(match[8]),
      fidelityTotal: Number(match[9]),
    });
  }
  return rows;
};

/** Maps summary-table browser labels to the artifact/job naming used everywhere else. */
const jobName = (row: SummaryRow): string =>
  `${row.browser.startsWith('Chromium') ? 'playwright' : 'chrome'}, ${row.mode}`;

const summaryRows = parseSummaryTable(isolationReport);

describe('Capture-integrity isolation report — internal consistency', () => {
  it('the browser/mode summary table covers the full 240-trial matrix', () => {
    assert.equal(summaryRows.length, 8, 'two browsers x four modes');
    assert.equal(summaryRows.reduce((sum, r) => sum + r.runs, 0), 240, 'the matrix ran 240 trials');
    assert.equal(summaryRows.reduce((sum, r) => sum + r.fidelityPass, 0), 215, 'report states 215 exact-fidelity passes');
    assert.equal(summaryRows.reduce((sum, r) => sum + (r.fidelityTotal - r.fidelityPass), 0), 25, 'report states 25 failures');
    for (const row of summaryRows) {
      assert.equal(row.postReadyAnomalies, 0, `${jobName(row)}: zero post-ready clock anomalies in every mode`);
      assert.equal(row.coveragePass, row.runs, `${jobName(row)}: complete selected-window coverage`);
    }
  });

  it('the per-profile split aggregates exactly to the summary table', () => {
    const aggregated = new Map<string, number>();
    const line = /^\| isolation \((chrome|playwright), (generated|immediate|lead|no-ready)\) \| (short|long|workload) \| (\d+)\/10 \| (\d+)\/10 \|$/;
    let profileRows = 0;
    for (const text of isolationReport.split('\n')) {
      const match = text.match(line);
      if (!match) continue;
      profileRows += 1;
      const key = `${match[1]}, ${match[2]}`;
      aggregated.set(key, (aggregated.get(key) ?? 0) + Number(match[5]));
    }
    assert.equal(profileRows, 24, 'eight jobs x three profiles');
    for (const row of summaryRows) {
      assert.equal(aggregated.get(jobName(row)), row.fidelityPass, `${jobName(row)} profile fidelity sums to the summary cell`);
    }
  });

  it('the job-status sentence matches the tables and the GitHub-verified run outcome (4 failed / 4 succeeded)', () => {
    const failingJobs = summaryRows.filter(r => r.fidelityPass < r.fidelityTotal).map(jobName).sort();
    assert.deepEqual(
      failingJobs,
      ['chrome, immediate', 'chrome, lead', 'playwright, immediate', 'playwright, no-ready'],
      'exactly these four jobs contain fidelity failures — matching run 39566258125 job conclusions'
    );

    const sentence = isolationReport.match(/([a-z]+) jobs failed final experiment status[^.]*?, ([a-z]+) succeeded\./);
    assert.ok(sentence, 'the report states a failed/succeeded job tally');
    assert.equal(NUMBER_WORDS[sentence![1]], failingJobs.length,
      'the prose failed-job tally must equal the number of jobs whose own fidelity table shows failures (GitHub metadata: 4)');
    assert.equal(NUMBER_WORDS[sentence![2]], 8 - failingJobs.length,
      'the prose succeeded-job tally must equal the remaining jobs (GitHub metadata: 4)');

    // The correction note must stay, so the original miscount remains traceable.
    assert.match(isolationReport, /four isolation jobs failed and \*\*four\*\* succeeded|actual outcome:\n> \*\*four\*\* isolation jobs failed/, 'the correction note records the verified 4/4 outcome');
  });

  it('every artifact link in both reports resolves to a recorded evidence manifest entry', () => {
    const manifestEntries = new Set<string>();
    for (const section of [isolationManifest.captureArtifacts, isolationManifest.historyArtifacts]) {
      for (const artifact of section.artifacts) {
        manifestEntries.add(`${artifact.workflow_run.id}/${artifact.id}`);
      }
    }
    for (const phase of Object.values(readinessManifest.artifactMetadata) as { artifacts: { id: number; workflow_run: { id: number } }[] }[]) {
      for (const artifact of phase.artifacts) {
        manifestEntries.add(`${artifact.workflow_run.id}/${artifact.id}`);
      }
    }

    const linked = (report: string): string[] =>
      [...report.matchAll(/actions\/runs\/(\d+)\/artifacts\/(\d+)/g)].map(m => `${m[1]}/${m[2]}`);

    const isolationLinks = linked(isolationReport);
    assert.equal(isolationLinks.length, 10, 'nine isolation-phase artifacts plus the historical original-capture artifact');
    const readinessLinks = linked(readinessHostedReport);
    assert.equal(readinessLinks.length, 6, 'the 132-capture phase lists six downloadable datasets');
    for (const link of [...isolationLinks, ...readinessLinks]) {
      assert.ok(manifestEntries.has(link), `artifact link ${link} must exist in a recorded evidence manifest`);
    }

    // The isolation manifest itself: 8 capture artifacts + 1 historical extraction, all unexpired records.
    assert.equal(isolationManifest.captureArtifacts.total_count, 8);
    assert.equal(isolationManifest.captureArtifacts.artifacts.length, 8);
    assert.equal(isolationManifest.historyArtifacts.total_count, 1);
    for (const artifact of [...isolationManifest.captureArtifacts.artifacts, ...isolationManifest.historyArtifacts.artifacts]) {
      assert.match(artifact.digest, /^sha256:[0-9a-f]{64}$/, `${artifact.name} records an API digest`);
      assert.equal(artifact.expired, false, `${artifact.name} recorded as unexpired (expires 2026-11-20)`);
    }
  });

  it('the raw-hash index covers exactly the 240-trial matrix, 30 per job', () => {
    const lines = rawHashIndex.split('\n').filter(l => l.trim().length > 0);
    assert.equal(lines.length, 240, 'one hash per isolation trial');
    const hashes = lines.map(l => l.split(/\s+/)[0]);
    assert.ok(hashes.every(h => /^[0-9a-f]{64}$/.test(h)), 'every line starts with a sha256 hex digest');
    assert.equal(new Set(hashes).size, 240, 'every raw file hash is unique (unique UUID per trial)');
    const perJob = new Map<string, number>();
    for (const line of lines) {
      const job = line.split(/\s+/).slice(1).join(' ').split('/')[0];
      perJob.set(job, (perJob.get(job) ?? 0) + 1);
    }
    assert.equal(perJob.size, 8, 'eight isolation jobs');
    for (const [job, count] of perJob) {
      assert.equal(count, 30, `${job}: ten repetitions x three profiles`);
    }
  });

  it('keeps the honest-outcome statements: unresolved cause, retained failures, closed gate', () => {
    assert.match(isolationReport, /not reproduced in 240/, 'the historical duplicate was not reproduced');
    assert.match(isolationReport, /not a resolution or a harness approval/, 'non-reproduction is not claimed as a fix');
    assert.match(isolationReport, /cause unresolved/, 'the anomaly cause stays unresolved');
    assert.match(isolationReport, /The gate remains closed|gate closed/, 'the automation-parity gate remains closed');
    assert.match(isolationReport, /0e8e6e0e1c2b83490af257aa76d2ae93b9141230a2b964847632c9fa6cd2ca48/, 'the historical raw SHA-256 stays pinned');
    assert.match(isolationReport, /9\.094947017729282e-13/, 'the first tiny non-immediate PCM failure stays recorded');
    assert.match(isolationReport, /2\.2737367544323206e-13/, 'the second tiny non-immediate PCM failure stays recorded');
    assert.match(isolationReport, /no tolerances were widened/, 'no tolerance widening to manufacture passes');
    assert.match(readinessHostedReport, /This is not a clean overall pass/, 'the 132-capture phase keeps its failure disclosure');
  });
});
