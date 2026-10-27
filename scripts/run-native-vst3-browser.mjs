import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const logPath = resolve('build/native-evidence/native-vst3-browser.log');
mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath);
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(command, ['run', 'test:vst3-browser'], {
  shell: process.platform === 'win32',
  stdio: ['inherit', 'pipe', 'pipe'],
});
let tail = '';
const maxTailBytes = 12000;
function forward(stream, output) {
  stream.on('data', chunk => {
    output.write(chunk);
    log.write(chunk);
    tail = (tail + chunk.toString()).slice(-maxTailBytes);
  });
}
forward(child.stdout, process.stdout);
forward(child.stderr, process.stderr);

let finished = false;
function fail(status, reason) {
  if (finished) return;
  finished = true;
  log.end(() => {
    const detail = `${reason}\n${tail}`.slice(-maxTailBytes)
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
