import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const logPath = resolve('build/native-evidence/native-vst3-browser.log');
const jsonPath = resolve('build/native-evidence/native-vst3-browser.json');
mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath);
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(command, ['run', 'test:vst3-browser', '--', '--reporter=list,json'], {
  shell: process.platform === 'win32',
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: jsonPath },
});
let tail = '';
function forward(stream, output) {
  stream.on('data', chunk => {
    output.write(chunk);
    log.write(chunk);
    tail = (tail + chunk.toString()).slice(-12000);
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

function collectFailures() {
  try {
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const failures = [];
    const visit = (suite, parents = []) => {
      const path = [...parents, suite.title].filter(Boolean);
      for (const spec of suite.specs ?? []) {
        const title = [...path, spec.title].filter(Boolean).join(' › ');
        for (const test of spec.tests ?? []) for (const result of test.results ?? []) {
          const errors = result.errors?.length ? result.errors : result.error ? [result.error] : [];
          if (result.status !== 'passed' || errors.length) {
            failures.push({ title, project: test.projectName, status: result.status, errors });
          }
        }
      }
      for (const nested of suite.suites ?? []) visit(nested, path);
    };
    for (const suite of report.suites ?? []) visit(suite);
    return failures.slice(0, 4).map(failure => {
      const errors = failure.errors.map(error => [error.message, error.stack?.split('\n').slice(0, 5).join('\n')]
        .filter(Boolean).join('\n')).join('\n');
      return `${failure.project ?? 'browser'} ${failure.status}: ${failure.title}${errors ? `\n${errors}` : ''}`;
    }).join('\n').slice(0, 2400);
  } catch { return ''; }
}

let finished = false;
function fail(status, reason) {
  if (finished) return;
  finished = true;
  log.end(() => {
    const conciseFailure = collectFailures();
    const detail = `${reason}\n${conciseFailure || tail.slice(-1800)}`.slice(0, 2800)
      .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
    console.log(`::error title=Native VST3 browser integration failure::${detail}`);
    process.exitCode = status;
  });
}

child.on('error', error => fail(1, `Could not start native VST3 browser test: ${error.stack || error.message}`));
child.on('close', (code, signal) => {
  if (finished) return;
  if (code === 0) {
    finished = true;
    log.end();
    return;
  }
  fail(code ?? 1, `Native VST3 browser test exited with ${code ?? signal}`);
});
