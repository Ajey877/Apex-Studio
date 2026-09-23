import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(process.cwd(), 'dist-electron', 'win-unpacked');
const candidates = readdirSync(packageRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  .map(entry => join(packageRoot, entry.name));

const executable = candidates.find(path => path.toLowerCase().includes('apex')) ?? candidates[0];

if (!executable || !existsSync(executable)) {
  console.error('[Apex Studio smoke] packaged executable not found');
  process.exit(1);
}

console.log(`[Apex Studio smoke] launching ${executable}`);

const child = spawn(executable, [], {
  env: { ...process.env, APEX_SMOKE_TEST: '1' },
  stdio: 'inherit',
  windowsHide: true,
});

const timeout = setTimeout(() => {
  console.error('[Apex Studio smoke] timed out waiting for packaged app');
  child.kill();
  process.exit(1);
}, 60_000);

child.on('error', error => {
  clearTimeout(timeout);
  console.error('[Apex Studio smoke] launch failed:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearTimeout(timeout);
  if (code === 0) {
    console.log('[Apex Studio smoke] packaged runtime smoke test passed');
    process.exit(0);
  }
  console.error(`[Apex Studio smoke] packaged app exited unsuccessfully: code=${code}, signal=${signal ?? 'none'}`);
  process.exit(code ?? 1);
});
