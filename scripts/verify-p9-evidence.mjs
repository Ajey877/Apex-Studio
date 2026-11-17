#!/usr/bin/env node
// Decides whether one lane of the P9 workflow may be green.
//
// The acceptance script (scripts/native-editor-dpi-acceptance.mjs) reports what
// it measured and exits 0 (all PASS), 1 (a FAIL), 2 (cannot run) or 3 (nothing
// failed, some cases NOT_VERIFIED). Exit code 3 is honest for a person at a desk
// with one monitor. It is NOT an acceptable result for a CI lane whose whole
// purpose is to run the cases that code 3 leaves out. So the workflow does not
// judge by exit code alone: this file reads the evidence JSON and applies the
// policy of the lane.
//
//   branch                  single display. P9-A/B/C/G/H/I/J/K/L/M must be PASS.
//                           P9-D/E/F may be NOT_VERIFIED (there is one display).
//   branch-second-display   two displays. ALL cases must be PASS, P9-D/E/F
//                           explicitly, each with executed checks. Exit code 3
//                           is rejected.
//   baseline                the native sources from before the fix. The lane is
//                           green only when the run REPRODUCES THE KNOWN DEFECT:
//                           P9-K fails because the editor is oversized after a
//                           real DPI change, while everything else the old helper
//                           can do still passes. A build failure, a missing
//                           report, a harness error or any other failure is not a
//                           reproduction and fails the lane.
//
// In every lane: the report must be for this lane and this commit, must contain
// no harness error, and the display configuration must have been restored.
//
// Usage:
//   node scripts/verify-p9-evidence.mjs --lane <lane> --evidence <file>
//        --exit-code <n> [--commit <sha>] [--expected-native-tree <tree>]
//        [--out <file>] [--expect-rejection [--ignore-host-label]]
//
// --expect-rejection inverts the result: it succeeds only when the policy
// REJECTS the evidence. The workflow uses it as a negative control, to prove on
// the runner that single-display evidence cannot pass the two-display policy.
// --ignore-host-label is allowed only together with it: the control would
// otherwise be rejected for the trivial reason that the evidence carries another
// lane's name, and would show nothing about the policy itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALL_CASES = ['P9-A', 'P9-B', 'P9-C', 'P9-D', 'P9-E', 'P9-F', 'P9-G', 'P9-H', 'P9-I', 'P9-J', 'P9-K', 'P9-L', 'P9-M'];
export const MULTI_MONITOR_CASES = ['P9-D', 'P9-E', 'P9-F'];
export const SINGLE_DISPLAY_CASES = ALL_CASES.filter(id => !MULTI_MONITOR_CASES.includes(id));
/** What the helper built from the pre-fix sources can do, and did correctly. */
export const BASELINE_MUST_PASS = ['P9-A', 'P9-B', 'P9-C', 'P9-H', 'P9-I', 'P9-J'];
export const LANES = ['branch', 'branch-second-display', 'baseline'];

/**
 * The defect the baseline must show (docs/VST3-EDITOR-DPI-ACCEPTANCE.md, "Scale
 * change while the editor is open"): after a real WM_DPICHANGED the old host
 * leaves the editor LARGER than the scaled size, in both dimensions. The margin
 * keeps a one- or two-pixel rounding difference from counting as the defect.
 * Measured on every recorded run: 548x182 for 437x150, then 626x202 for 525x180.
 */
export const BASELINE_DEFECT = {
  case: 'P9-K',
  config: 'live-scale',
  transitions: ['to-125', 'to-150'],
  minimumOversizeRatio: 1.08,
  recordedMeasurements: { 'to-125': { width: 548, height: 182 }, 'to-150': { width: 626, height: 202 } },
};

const caseOf = (report, id) => (Array.isArray(report?.cases) ? report.cases.find(entry => entry.id === id) : null) ?? null;
const statusOf = (report, id) => report?.statuses?.[id] ?? caseOf(report, id)?.status ?? 'MISSING';
/** The first check with this name: names repeat when a scale is visited twice. */
const firstCheck = (run, name) => run?.checks?.find(check => check.name === name) ?? null;

/** Checks that hold for every lane. */
function commonProblems(report, { lane, exitCode, commit, expectedNativeTree, ignoreHostLabel = false }) {
  const problems = [];
  if (!report || typeof report !== 'object') return ['the evidence is not a JSON object'];
  if (!(report.schemaVersion >= 2)) problems.push(`evidence schemaVersion is ${report.schemaVersion}; version 2 (with restoration and verdict) is required`);
  if (!ignoreHostLabel && report.host !== lane) problems.push(`the evidence is for host "${report.host}", not for lane "${lane}"`);
  if (commit && report.commit !== commit) problems.push(`the evidence is for commit ${report.commit}, not ${commit}`);
  if (report.blocked) problems.push(`the run was blocked and measured nothing: ${report.blocked}`);
  if (expectedNativeTree && report.nativeSourceTree !== expectedNativeTree) {
    problems.push(`the helper was built from native/vst3 tree ${report.nativeSourceTree}, expected ${expectedNativeTree}`);
  }
  if (!Array.isArray(report.cases) || report.cases.length === 0) problems.push('the evidence lists no cases');
  for (const id of ALL_CASES) if (statusOf(report, id) === 'MISSING') problems.push(`${id} is missing from the evidence`);
  // statuses and cases must tell the same story; a hand-edited summary must not pass.
  for (const id of ALL_CASES) {
    const entry = caseOf(report, id);
    if (entry && report.statuses && entry.status !== report.statuses[id]) problems.push(`${id}: statuses says ${report.statuses[id]}, the case entry says ${entry.status}`);
    if (entry?.status === 'PASS') {
      const runs = entry.runs ?? [];
      const bad = runs.filter(run => run.status === 'PASS' && (!Array.isArray(run.checks) || run.checks.length === 0 || run.checks.some(check => check.ok !== true)));
      if (runs.length === 0 || bad.length) problems.push(`${id} is reported PASS without executed, passing checks`);
    }
  }
  if (Array.isArray(report.harnessErrors) && report.harnessErrors.length) {
    problems.push(`the harness itself reported errors: ${report.harnessErrors.map(e => `${e.where}: ${e.message}`).join(' | ').slice(0, 600)}`);
  } else if (!Array.isArray(report.harnessErrors)) problems.push('the evidence has no harnessErrors list');
  // Restoration: required, and judged from what Windows reported afterwards.
  const restoration = report.restoration;
  if (!restoration) problems.push('the evidence has no display restoration record');
  else {
    if (restoration.ok !== true) {
      const differences = (restoration.differences ?? []).map(d => `${d.device ?? 'desktop'} ${d.setting}: original ${JSON.stringify(d.original)}, final ${JSON.stringify(d.final)}`).join('; ');
      problems.push(`the display configuration was not restored: ${differences || 'no comparison available'}`);
    }
    if (!restoration.original?.displays?.length) problems.push('the restoration record has no original display configuration');
    if (!restoration.final?.displays?.length) problems.push('the restoration record has no final display configuration read back from Windows');
    if ((restoration.differences ?? []).length && restoration.ok === true) problems.push('the restoration record says ok but lists differences');
  }
  // The script's verdict, its exit code and the exit code the workflow saw must agree.
  const expectedExit = { PASS: 0, FAIL: 1, NOT_VERIFIED: 3 }[report.verdict];
  if (expectedExit === undefined) problems.push(`the evidence has no usable verdict (${report.verdict})`);
  else if (exitCode !== expectedExit) problems.push(`the harness exited ${exitCode} but its evidence says ${report.verdict} (exit ${expectedExit})`);
  return problems;
}

function branchProblems(report, { exitCode }) {
  const problems = [];
  if (exitCode !== 0 && exitCode !== 3) problems.push(`harness exit code ${exitCode}; this lane accepts 0 (all PASS) or 3 (only P9-D/E/F NOT_VERIFIED)`);
  for (const id of SINGLE_DISPLAY_CASES) {
    const status = statusOf(report, id);
    if (status !== 'PASS') problems.push(`${id} is ${status}; it must be PASS on a single display`);
  }
  for (const id of MULTI_MONITOR_CASES) {
    const status = statusOf(report, id);
    if (status !== 'PASS' && status !== 'NOT_VERIFIED') problems.push(`${id} is ${status}; only PASS or NOT_VERIFIED is acceptable here`);
  }
  return problems;
}

function secondDisplayProblems(report, { exitCode }) {
  const problems = [];
  if (exitCode !== 0) {
    problems.push(`harness exit code ${exitCode}; the two-display lane requires 0. Exit code 3 (cases NOT_VERIFIED) is not accepted here`);
  }
  const monitors = report?.environment?.monitorsAtStart;
  if (!Array.isArray(monitors) || monitors.length < 2) {
    problems.push(`Windows reported ${Array.isArray(monitors) ? monitors.length : 'no'} monitor(s) at the start of the run; two are required`);
  }
  const original = report?.restoration?.original?.displays;
  if (Array.isArray(original) && original.length < 2) problems.push(`the recorded display configuration has ${original.length} display(s); two are required`);
  for (const id of ALL_CASES) {
    const status = statusOf(report, id);
    if (status !== 'PASS') problems.push(`${id} is ${status}; every case must be PASS in the two-display lane`);
  }
  // P9-D/E/F are the reason this lane exists: require the runs themselves.
  for (const id of MULTI_MONITOR_CASES) {
    const entry = caseOf(report, id);
    for (const config of entry?.needs ?? []) {
      const run = (entry.runs ?? []).find(candidate => candidate.config === config && candidate.status === 'PASS');
      if (!run) { problems.push(`${id}: configuration ${config} has no passing run`); continue; }
      const checks = run.checks ?? [];
      if (checks.length === 0) problems.push(`${id} ${config}: no checks were executed`);
      const notPassing = checks.filter(check => check.ok !== true);
      if (notPassing.length) problems.push(`${id} ${config}: ${notPassing.length} check(s) not passing (${notPassing.slice(0, 4).map(c => c.name).join(', ')})`);
    }
    if (!entry?.needs?.length) problems.push(`${id}: the evidence does not say which configurations it needs`);
    if ((entry?.missing ?? []).length) problems.push(`${id}: configurations not covered: ${entry.missing.join(', ')}`);
  }
  return problems;
}

/**
 * The baseline lane. Returns problems that mean "this is NOT the expected
 * reproduction", plus the measurements that show the defect when it is.
 */
function baselineProblems(report, options) {
  const { exitCode } = options;
  const problems = [];
  const reproduction = { transitions: {} };
  // Without this, "the baseline" could silently be the current sources.
  if (!options.expectedNativeTree) problems.push('the tree of the pre-fix native sources was not stated, so the evidence cannot be tied to them');
  if (exitCode !== 1) problems.push(`harness exit code ${exitCode}; a reproduced defect is a FAIL (exit 1). ${exitCode === 2 ? 'Exit 2 means the helper was not built or could not run.' : ''}`.trim());
  // The old helper works: these cases pass. If they do not, the build or the
  // harness is broken, and a red P9-K would prove nothing about the defect.
  for (const id of BASELINE_MUST_PASS) {
    const status = statusOf(report, id);
    if (status !== 'PASS') problems.push(`${id} is ${status}; it passes on the pre-fix sources, so this run is broken in some other way`);
  }
  for (const id of ALL_CASES) {
    if (id !== BASELINE_DEFECT.case && statusOf(report, id) === 'FAIL') problems.push(`${id} FAILED; only ${BASELINE_DEFECT.case} is expected to fail on the pre-fix sources`);
  }
  if (statusOf(report, BASELINE_DEFECT.case) !== 'FAIL') {
    problems.push(`${BASELINE_DEFECT.case} is ${statusOf(report, BASELINE_DEFECT.case)}; the defect was not reproduced`);
    return { problems, reproduction };
  }
  const run = (caseOf(report, BASELINE_DEFECT.case)?.runs ?? []).find(candidate => candidate.config === BASELINE_DEFECT.config);
  if (!run) {
    problems.push(`${BASELINE_DEFECT.case} has no ${BASELINE_DEFECT.config} run; it failed for some other reason`);
    return { problems, reproduction };
  }
  // The editor opened correctly at 100% before the scale was changed.
  if (firstCheck(run, 'opened-at-100')?.ok !== true) problems.push('the editor did not open correctly at 100%, so the failure is not the DPI-change defect');
  for (const label of BASELINE_DEFECT.transitions) {
    // The scale change really happened and really reached the window and the plug-in...
    for (const precondition of ['windows-sent-WM_DPICHANGED', 'window-dpi', 'content-scale-factor']) {
      const check = firstCheck(run, `${label}:${precondition}`);
      if (check?.ok !== true) problems.push(`${label}: "${precondition}" is ${check ? (check.ok === false ? 'failing' : 'not executed') : 'absent'}; without it a wrong size is not evidence of the sizing defect`);
    }
    // ...and the editor then has the wrong size in the expected direction.
    const width = firstCheck(run, `${label}:client-width`);
    const height = firstCheck(run, `${label}:client-height`);
    const measured = { width: width?.actual ?? null, height: height?.actual ?? null, expectedWidth: width?.expected ?? null, expectedHeight: height?.expected ?? null };
    reproduction.transitions[label] = measured;
    for (const [axis, check] of [['width', width], ['height', height]]) {
      if (!check) { problems.push(`${label}: the client ${axis} was not measured`); continue; }
      if (check.ok !== false) { problems.push(`${label}: the client ${axis} is correct (${check.actual}); the sizing defect is absent`); continue; }
      if (typeof check.actual !== 'number' || typeof check.expected !== 'number') { problems.push(`${label}: the client ${axis} has no numeric measurement`); continue; }
      const ratio = check.actual / check.expected;
      if (!(ratio >= BASELINE_DEFECT.minimumOversizeRatio)) {
        problems.push(`${label}: client ${axis} is ${check.actual} for an expected ${check.expected} (ratio ${ratio.toFixed(3)}); the known defect leaves the editor at least ${BASELINE_DEFECT.minimumOversizeRatio}x too large`);
      }
    }
    const recorded = BASELINE_DEFECT.recordedMeasurements[label];
    measured.equalsRecordedMeasurement = measured.width === recorded.width && measured.height === recorded.height;
  }
  return { problems, reproduction };
}

/**
 * Apply the policy of `lane` to an evidence report.
 * Returns { ok, lane, problems[], summary, ... }. Pure: no I/O.
 */
export function evaluateLane(report, options) {
  const { lane } = options;
  if (!LANES.includes(lane)) return { ok: false, lane, problems: [`unknown lane "${lane}"`], summary: `unknown lane "${lane}"` };
  if (!Number.isInteger(options.exitCode)) return { ok: false, lane, problems: ['the harness exit code is unknown'], summary: 'the harness exit code is unknown' };
  const problems = commonProblems(report, options);
  const statuses = Object.fromEntries(ALL_CASES.map(id => [id, statusOf(report, id)]));
  let reproduction;
  if (lane === 'branch') problems.push(...branchProblems(report, options));
  else if (lane === 'branch-second-display') problems.push(...secondDisplayProblems(report, options));
  else {
    // For the baseline a FAIL verdict with exit code 1 is the expected outcome,
    // and the common exit-code consistency check above already covers it.
    const baseline = baselineProblems(report, options);
    problems.push(...baseline.problems);
    reproduction = baseline.reproduction;
  }
  const ok = problems.length === 0;
  const list = ids => ids.map(id => `${id.slice(3)}:${statuses[id]}`).join(' ');
  let summary;
  if (lane === 'baseline') {
    const sizes = Object.entries(reproduction?.transitions ?? {}).map(([label, m]) => `${label} ${m.width}x${m.height} (expected ${m.expectedWidth}x${m.expectedHeight})`).join(', ');
    summary = ok
      ? `baseline: the known P9-K defect is REPRODUCED on the pre-fix sources. Editor oversized after a real DPI change: ${sizes}. ${BASELINE_MUST_PASS.join(', ')} pass, no other case fails, display restored.`
      : `baseline: this run is NOT the expected reproduction of the P9-K sizing defect. ${problems.length} problem(s).`;
  } else if (lane === 'branch-second-display') {
    summary = ok
      ? `branch-second-display: all 13 cases PASS, P9-D/E/F executed on two displays, harness exit code 0, display restored. [${list(ALL_CASES)}]`
      : `branch-second-display: REJECTED. ${problems.length} problem(s). [${list(ALL_CASES)}]`;
  } else {
    summary = ok
      ? `branch: the ten single-display cases PASS; P9-D/E/F are ${MULTI_MONITOR_CASES.map(id => statuses[id]).join('/')} on this one-display runner; display restored. [${list(ALL_CASES)}]`
      : `branch: REJECTED. ${problems.length} problem(s). [${list(ALL_CASES)}]`;
  }
  return {
    ok, lane, problems, summary, statuses,
    exitCode: options.exitCode,
    commit: options.commit ?? null,
    expectedNativeTree: options.expectedNativeTree ?? null,
    nativeSourceTree: report?.nativeSourceTree ?? null,
    restorationOk: report?.restoration?.ok ?? null,
    ...(reproduction ? { reproduction } : {}),
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------
function parseArguments(argv) {
  const options = { expectRejection: false };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) throw new Error(`${name} needs a value`);
      return argv[++index];
    };
    if (name === '--lane') options.lane = value();
    else if (name === '--evidence') options.evidence = value();
    else if (name === '--exit-code') options.exitCode = value();
    else if (name === '--commit') options.commit = value();
    else if (name === '--expected-native-tree') options.expectedNativeTree = value();
    else if (name === '--out') options.out = value();
    else if (name === '--label') options.label = value();
    else if (name === '--expect-rejection') options.expectRejection = true;
    else if (name === '--ignore-host-label') options.ignoreHostLabel = true;
    else throw new Error(`unknown argument ${name}`);
  }
  if (options.ignoreHostLabel && !options.expectRejection) throw new Error('--ignore-host-label is only allowed with --expect-rejection');
  return options;
}

function main() {
  const annotate = Boolean(process.env.GITHUB_ACTIONS);
  const encode = text => String(text).slice(0, 3900).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  let options;
  try { options = parseArguments(process.argv.slice(2)); }
  catch (error) { console.error(`verify-p9-evidence: ${error.message}`); return 2; }
  const label = options.label ?? options.lane;
  const exitCode = /^-?\d+$/.test(String(options.exitCode ?? '')) ? Number(options.exitCode) : NaN;
  let result;
  if (!options.lane || !options.evidence) {
    result = { ok: false, lane: options.lane ?? null, problems: ['--lane and --evidence are required'], summary: 'verify-p9-evidence was called without --lane or --evidence' };
  } else if (!existsSync(options.evidence)) {
    // No evidence is never a pass and never a "reproduction".
    result = { ok: false, lane: options.lane, problems: [`no evidence file at ${options.evidence}: the run measured nothing (harness exit code ${options.exitCode})`],
      summary: `${options.lane}: REJECTED. The run produced no evidence file.` };
  } else {
    let report = null;
    try { report = JSON.parse(readFileSync(options.evidence, 'utf8')); }
    catch (error) { result = { ok: false, lane: options.lane, problems: [`the evidence file is not valid JSON: ${error.message}`], summary: `${options.lane}: REJECTED. Unreadable evidence.` }; }
    result ??= evaluateLane(report, { lane: options.lane, exitCode, commit: options.commit || undefined,
      expectedNativeTree: options.expectedNativeTree || undefined, ignoreHostLabel: options.ignoreHostLabel === true });
  }
  const accepted = result.ok;
  const success = options.expectRejection ? !accepted : accepted;
  const record = { ...result, verifiedAt: new Date().toISOString(), evidence: options.evidence ?? null, expectRejection: options.expectRejection, laneMayBeGreen: success };
  if (options.out) {
    mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    writeFileSync(options.out, JSON.stringify(record, null, 2));
  }
  const problemText = result.problems.map((problem, index) => `${index + 1}. ${problem}`).join('\n');
  if (options.expectRejection) {
    const text = accepted
      ? `NEGATIVE CONTROL FAILED: the "${options.lane}" policy ACCEPTED evidence it must reject. ${result.summary}`
      : `Negative control OK: the "${options.lane}" policy rejects this evidence, as it must.\n${problemText}`;
    console.log(`P9-NEGATIVE-CONTROL ${label} ${text}`);
    if (annotate) console.log(`::${accepted ? 'error' : 'notice'} title=P9-NEGATIVE-CONTROL ${label}::${encode(text)}`);
  } else {
    const text = accepted ? result.summary : `${result.summary}\n${problemText}`;
    console.log(`P9-LANE-VERDICT ${label} ${accepted ? 'ACCEPTED' : 'REJECTED'} ${text}`);
    if (annotate) console.log(`::${accepted ? 'notice' : 'error'} title=P9-LANE-VERDICT ${label}::${encode(text)}`);
  }
  return success ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
