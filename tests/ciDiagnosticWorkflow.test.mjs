// Contract test for the Windows cold-start diagnostic in desktop-validation.yml.
//
// The defect this pins: the sixty-run diagnostic used to be conditioned on
// `runner.os == 'Windows'` alone. In GitHub Actions, when a step without
// `continue-on-error` fails, the remaining default-conditioned steps are skipped
// and the job ends as a failure. So the diagnostic never ran in exactly the
// situation it exists for - after the five-run gate had failed.
//
// These assertions are about the workflow's control flow, not about any measured
// timing. They check the conditions and the flags that decide what runs, in what
// order, and which of them may fail the job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import YAML from 'js-yaml';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workflow = YAML.load(
  readFileSync(path.join(root, '.github', 'workflows', 'desktop-validation.yml'), 'utf8'),
);

const job = Object.values(workflow.jobs).find((candidate) =>
  (candidate.steps || []).some((step) => String(step.name).includes('Cold-start deadline')));

const step = (predicate) => {
  const found = job.steps.find(predicate);
  assert.ok(found, 'the desktop validation job must contain the step under test');
  return found;
};

const gate = step((s) => s.id === 'native-coexistence-gate');
const diagnostic = step((s) => s.id === 'native-diagnostic');
const diagnosticUpload = step((s) => String(s.name).includes('Upload cold-start diagnostic evidence'));
const gateUpload = step((s) => String(s.name).includes('coexistence evidence'));
const gateVerdict = step((s) => String(s.name) === 'Record the packaged acceptance verdict');
const diagnosticVerdict = step((s) => String(s.name).includes('Record the cold-start diagnostic verdict'));

const byId = Object.fromEntries(job.steps.filter((s) => s.id).map((s) => [s.id, s]));
const indexOf = (s) => job.steps.indexOf(s);

// Evaluates the workflow's own condition language for the operators it actually
// uses here (&&, ||, ==, !cancelled(), always()), so the assertions exercise the
// real expression rather than a restatement of it. Returns the boolean value of
// the expression for one scenario.
function evaluates(ifExpression, { cancelled, outcomes }) {
  const flat = String(ifExpression)
    .replace(/steps\.([\w-]+)\.outcome/g, (_, id) => JSON.stringify(outcomes[id] ?? 'skipped'))
    .replace(/!cancelled\(\)/g, String(!cancelled))
    .replace(/always\(\)/g, 'true')
    .replace(/success\(\)/g, 'true')
    .replace(/failure\(\)/g, 'false')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = flat.split(' ').filter(Boolean);
  // Collapse `left == right` into a single boolean token first.
  const values = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (tokens[i + 1] === '==') {
      const unquote = (v) => v.replace(/^['"]|['"]$/g, '');
      const left = unquote(token);
      const right = unquote(tokens[i + 2]);
      values.push(left === right);
      i += 2;
      continue;
    }
    if (token === '&&' || token === '||') { values.push(token); continue; }
    values.push(token === 'true');
  }
  // Flat left-to-right fold; these expressions mix no precedence levels.
  let acc = values[0];
  for (let i = 1; i < values.length; i += 2) {
    acc = values[i] === '&&' ? acc && values[i + 1] : acc || values[i + 1];
  }
  return Boolean(acc);
}

const scenarios = {
  'gate passed, everything ran': {
    cancelled: false,
    runnerOs: 'Windows',
    outcomes: { 'windows-package-dir': 'success', 'native-helper-build': 'success' },
  },
  'gate FAILED, prerequisites succeeded': {
    cancelled: false,
    runnerOs: 'Windows',
    outcomes: { 'windows-package-dir': 'success', 'native-helper-build': 'success' },
  },
  'packaging failed, so there is nothing to measure': {
    cancelled: false,
    runnerOs: 'Windows',
    outcomes: { 'windows-package-dir': 'failure', 'native-helper-build': 'success' },
  },
  'helper build failed, so there is nothing to measure': {
    cancelled: false,
    runnerOs: 'Windows',
    outcomes: { 'windows-package-dir': 'success', 'native-helper-build': 'failure' },
  },
  'run was cancelled': {
    cancelled: true,
    runnerOs: 'Windows',
    outcomes: { 'windows-package-dir': 'success', 'native-helper-build': 'success' },
  },
  'not Windows': {
    cancelled: false,
    runnerOs: 'Linux',
    outcomes: { 'windows-package-dir': 'success', 'native-helper-build': 'success' },
  },
};

function runsWhen(expression, scenario) {
  const withRunner = String(expression ?? 'true').replace(/runner\.os == '(\w+)'/g,
    (_, os) => String(os === scenario.runnerOs));
  return evaluates(withRunner, scenario);
}

test('the diagnostic runs after a failed five-run gate, not only after a passing one', () => {
  assert.equal(
    runsWhen(diagnostic.if, scenarios['gate FAILED, prerequisites succeeded']),
    true,
    'a gate failure is exactly when the diagnostic evidence is needed',
  );
  assert.equal(
    runsWhen(diagnostic.if, scenarios['gate passed, everything ran']),
    true,
    'the diagnostic still runs on a passing gate',
  );
});

test('the diagnostic does not run when there is nothing to measure, or on a cancelled run', () => {
  for (const name of [
    'packaging failed, so there is nothing to measure',
    'helper build failed, so there is nothing to measure',
    'run was cancelled',
    'not Windows',
  ]) {
    assert.equal(runsWhen(diagnostic.if, scenarios[name]), false, `${name} must skip it`);
  }
});

test('the diagnostic does not rely on an implicit success() condition', () => {
  // This is the actual bug: a step with no `if`, or one that only tests the OS,
  // inherits GitHub Actions' default `success()` condition, so it is skipped as
  // soon as an earlier step fails - which is what happened when the gate failed.
  assert.ok(diagnostic.if, 'the diagnostic must state an explicit condition');
  assert.ok(
    /!cancelled\(\)|always\(\)/.test(String(diagnostic.if)),
    'the condition must opt out of the implicit success() requirement',
  );
  for (const s of [diagnostic, diagnosticUpload, diagnosticVerdict, gateVerdict]) {
    assert.ok(s.if, `${s.name} must not fall back to the implicit success() condition`);
  }
});

test('the diagnostic is non-gating and the gate is strict', () => {
  assert.equal(
    diagnostic['continue-on-error'],
    true,
    'a diagnostic miss must never decide the job verdict',
  );
  assert.notEqual(
    gate['continue-on-error'],
    true,
    'the five-run gate must be able to fail the job',
  );
  assert.equal(
    gate.env.APEX_NATIVE_MONITORING_CONTINUE_AFTER_FAILURE,
    undefined,
    'the gate stays fail-fast: it does not continue after a failed repetition',
  );
  assert.equal(gate.env.APEX_NATIVE_MONITORING_RUNS, '5', 'the gate stays at five repetitions');
});

test('the diagnostic attempts all sixty and continues after individual failures', () => {
  assert.equal(diagnostic.env.APEX_NATIVE_MONITORING_RUNS, '60');
  assert.equal(diagnostic.env.APEX_NATIVE_MONITORING_CONTINUE_AFTER_FAILURE, '1');
});

test('no repetition is retried: the diagnostic never lowers or repeats a run count', () => {
  const diagnosticSteps = job.steps.filter(
    (s) => String(s.run || '').includes('test:native-monitoring-packaged'),
  );
  assert.equal(diagnosticSteps.length, 2, 'exactly one gate invocation and one diagnostic invocation');
  for (const s of diagnosticSteps) {
    assert.ok(!/--retr/i.test(String(s.run)), 'no retry flag may be passed');
    assert.ok(
      !/reroll|re-run|reattempt/i.test(String(s.run)),
      'no repetition may be re-rolled or counted twice',
    );
  }
  const counts = diagnosticSteps.map((s) => Number(s.env.APEX_NATIVE_MONITORING_RUNS));
  assert.deepEqual([...new Set(counts)].sort((a, b) => a - b), [5, 60]);
});

test('the gate and the diagnostic write to different evidence directories', () => {
  const gateDir = gate.env.APEX_NATIVE_MONITORING_EVIDENCE_DIR;
  const diagnosticDir = diagnostic.env.APEX_NATIVE_MONITORING_EVIDENCE_DIR;
  assert.ok(gateDir, 'the gate must name its evidence directory explicitly');
  assert.ok(diagnosticDir, 'the diagnostic must name its evidence directory explicitly');
  assert.notEqual(gateDir, diagnosticDir, 'the diagnostic must not overwrite the gate evidence');
  for (const dir of [gateDir, diagnosticDir]) {
    assert.ok(
      dir.startsWith('${{ github.workspace }}/'),
      `an absolute workspace path is required so the upload step can find it, got ${dir}`,
    );
  }
});

test('both evidence directories are uploaded, and the diagnostic upload happens after it runs', () => {
  for (const upload of [gateUpload, diagnosticUpload]) {
    assert.equal(
      String(upload.if).includes('always()'),
      true,
      `${upload.name} must upload even when a gate failed`,
    );
  }
  assert.equal(
    diagnosticUpload.with.path,
    'build/native-diagnostic-evidence',
    'the diagnostic upload must read the diagnostic directory',
  );
  assert.ok(
    indexOf(diagnosticUpload) > indexOf(diagnostic),
    'uploading before the diagnostic runs would leave its evidence on the runner',
  );
  assert.ok(
    indexOf(diagnostic) > indexOf(gate),
    'the diagnostic runs after the gate has already recorded its verdict',
  );
});

test('the diagnostic never converts a failed gate into a pass', () => {
  // A job's conclusion reflects every step that ran without continue-on-error, so
  // the gate alone can fail the job and the diagnostic cannot undo that. Assert the
  // mechanism directly: no later step may reset, ignore or overwrite the gate.
  const after = job.steps.slice(indexOf(gate) + 1);
  for (const s of after) {
    const run = String(s.run || '');
    assert.ok(
      !/GITHUB_STEP_SUMMARY=|::set-output|exit 0\s*#/.test(run),
      `${s.name} must not rewrite the job verdict`,
    );
    if (s.name && String(s.name).includes('Cold-start')) {
      assert.equal(s['continue-on-error'], true);
    }
  }
  assert.equal(
    byId['native-coexistence-gate']['continue-on-error'] ?? false,
    false,
    'the gating step keeps the authority to fail the job',
  );
});

test('both verdicts are recorded, and separately', () => {
  assert.ok(gateVerdict, 'the gating verdict is recorded');
  assert.ok(diagnosticVerdict, 'the diagnostic verdict is recorded separately');
  assert.equal(
    String(gateVerdict.if).includes('!cancelled()'),
    true,
    'the gating verdict must still be recorded when the gate itself failed',
  );
  const env = diagnosticVerdict.env || {};
  assert.ok(
    String(env.GATE_OUTCOME || '').includes('native-coexistence-gate.outcome'),
    'the diagnostic verdict step must report the gate outcome, not only its own',
  );
  assert.ok(
    String(env.DIAGNOSTIC_OUTCOME || '').includes('native-diagnostic.outcome'),
    'the diagnostic outcome is reported as its own value',
  );
  assert.ok(
    String(diagnosticVerdict.run).includes('never gates'),
    'the step states plainly that the diagnostic does not gate',
  );
});
