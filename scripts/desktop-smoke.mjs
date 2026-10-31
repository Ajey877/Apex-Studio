import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(process.cwd(), 'dist-electron', 'win-unpacked');
const candidates = readdirSync(packageRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  .map(entry => join(packageRoot, entry.name));
const executable = candidates.find(path => path.toLowerCase().includes('apex')) ?? candidates[0];
if (!executable || !existsSync(executable)) throw new Error('Packaged executable not found');
const fixture = join(process.cwd(), 'build/native-vst3/VST3/Release/mda-vst3.vst3');
if (!existsSync(fixture)) throw new Error('Build the real MDA VST3 fixture before packaged smoke');
const evidence = join(process.cwd(), 'build/native-evidence');
mkdirSync(evidence, { recursive: true });
const traceRoot = process.env.APEX_REZFILTER_TRACE_DIR || '';
if (traceRoot) mkdirSync(traceRoot, { recursive: true });
const profile = mkdtempSync(join(process.cwd(), 'build/vst3-smoke-profile-'));
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
async function launch(reopening) {
  const output = join(evidence, `apex-packaged-smoke-${reopening ? 'reopen' : 'save'}.json`);
  const traceDir = traceRoot ? join(traceRoot, reopening ? 'reopen' : 'save') : '';
  if (traceDir) mkdirSync(traceDir, { recursive: true });
  console.log(`[Apex Studio smoke] ${reopening ? 'reopening saved project in new process' : 'launching isolated profile'}: ${executable}`);
  const exit = await new Promise(resolve => {
    const child = spawn(executable, [], {
      env: { ...process.env, APEX_SMOKE_TEST: '1', APEX_SMOKE_REOPEN: reopening ? '1' : '0',
        APEX_VST3_SMOKE_PLUGIN: fixture, APEX_SMOKE_EVIDENCE: output, APEX_SMOKE_USER_DATA: profile,
        ...(traceDir ? { APEX_REZFILTER_TRACE_DIR: traceDir } : {}) },
      stdio: 'inherit', windowsHide: true,
    });
    const attempts = Number(process.env.APEX_REZFILTER_ATTEMPTS || 20);
    const timeoutMs = Math.max(600_000, (Number.isFinite(attempts) && attempts > 0 ? attempts : 20) * 45_000 + 180_000);
    const timeout = setTimeout(() => { child.kill(); resolve({ code: null, signal: 'timeout' }); }, timeoutMs);
    child.on('error', error => { clearTimeout(timeout); resolve({ code: null, signal: String(error) }); });
    child.on('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  const payload = readJson(output);
  const parity = readJson(output.replace(/\.json$/i, '') + '-rezfilter-parity.json');
  return { reopening, ...exit, output, payload, parity };
}
function phaseReport(launchResult, label) {
  const mixer = launchResult.payload?.vst3?.mixerEffects ?? launchResult.parity;
  const independent = mixer?.independent ?? mixer?.rezFilterParity?.independent ?? null;
  const twoInsert = mixer?.rezFilterParity?.summary ?? mixer?.summary ?? null;
  return {
    label, exitCode: launchResult.code, signal: launchResult.signal,
    processOk: launchResult.code === 0,
    mixerStatus: mixer?.status ?? (launchResult.payload?.smokeError ? 'failed' : null),
    independent, twoInsert,
    smokeError: launchResult.payload?.smokeError ?? null,
    identities: mixer?.identities ?? mixer?.rezFilterParity?.identities ?? launchResult.parity?.identities ?? null,
  };
}
const saved = await launch(false);
const reopened = await launch(true);
const report = {
  saved: phaseReport(saved, 'save'),
  reopened: phaseReport(reopened, 'reopen'),
};
writeFileSync(join(evidence, 'apex-packaged-smoke-independent-phases.json'), JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=independent save::${JSON.stringify(report.saved).slice(0, 3900)}`);
  console.log(`::notice title=independent reopen::${JSON.stringify(report.reopened).slice(0, 3900)}`);
}
const saveFailed = !report.saved.processOk || report.saved.mixerStatus === 'failed';
const reopenFailed = !report.reopened.processOk || report.reopened.mixerStatus === 'failed';
if (saveFailed) console.error('[Apex Studio smoke] SAVE PHASE FAILED (retained; reopen still executed)', report.saved);
if (reopenFailed) console.error('[Apex Studio smoke] REOPEN PHASE FAILED (does not override save)', report.reopened);
if (!saveFailed && !reopenFailed) {
  writeFileSync(join(evidence, 'apex-packaged-smoke.json'), JSON.stringify({ saved: saved.payload, reopened: reopened.payload, applicationRestartEqual: true }, null, 2));
  console.log('[Apex Studio smoke] packaged live/export/save/application-restart smoke passed');
  rmSync(profile, { recursive: true, force: true });
} else {
  console.error(`[Apex Studio smoke] failed isolated profile retained at ${profile}`);
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::error title=Packaged VST3 restart failed::saveFailed=${saveFailed} reopenFailed=${reopenFailed}`);
  }
  process.exitCode = 1;
}
