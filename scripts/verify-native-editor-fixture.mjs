// Verifies the REAL AGain VSTGUI editor fixture required by the editor MVP.
//
// Run after `npm run native:vst3:build`. Fails loudly (never skips) when the
// fixture is missing: the editor window is only credible if this plug-in built.
//
// Checks
//  1. the AGain bundle exists where the SDK build places it (Windows only);
//  2. its packaged resources contain the genuine `again.uidesc`;
//  3. Apex's own helper discovers it as a Mixer audio effect;
//  4. Apex's helper exposes its genuine controller parameters (Gain = ParamID 0);
//  5. the genuine editor view opens, close captures state, helper terminates.
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverVst3, NativeVst3Client } from '../native/vst3/client.mjs';
import { Vst3Service } from '../native/vst3/service.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const build = path.join(root, process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const executableName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', executableName), path.join(build, 'bin/Release', executableName)].find(existsSync);
/** Helper processes alive right now, read from the OS process table. */
function liveHelpers() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq apex-vst3-host.exe', '/NH'], { encoding: 'utf8' });
      return out.split('\n').filter(line => line.includes('apex-vst3-host.exe')).map(line => line.trim());
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8' });
    return out.split('\n').filter(line => line.includes('apex-vst3-host')).map(line => line.trim());
  } catch {
    return [];
  }
}

const failures = [];
const results = [];
const check = (name, ok, detail) => {
  results.push({ check: name, ok, detail });
  if (!ok) failures.push({ check: name, detail });
  return ok;
};

const report = { platform: { os: process.platform, arch: process.arch }, build, checks: results, failures };
const finish = () => {
  const target = path.join(build, '../native-evidence/native-editor-fixture.json');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`\n${failures.length} editor-fixture check(s) failed`);
    process.exit(1);
  }
  console.log('\nAGain editor fixture verified.');
};

if (!check('native helper binary exists', Boolean(executable), { executable })) finish();
const bundle = path.join(build, 'VST3/Release/again.vst3');
const bundleExists = existsSync(bundle);
check('AGain VSTGUI editor fixture bundle exists', bundleExists, { bundle });
if (!bundleExists) {
  // The SDK only builds AGain when SMTG_ENABLE_VSTGUI_SUPPORT is ON, which this
  // repository enables through APEX_BUILD_VST3_EDITOR_FIXTURE on Windows.
  check('editor fixture build option enabled', false,
    { hint: 'APEX_BUILD_VST3_EDITOR_FIXTURE=ON is Windows-only; on Windows run npm run native:vst3:build' });
  finish();
}

// ---- the genuine UI resource, inside the packaged bundle -------------------
// The bundle layout differs per platform (<arch>/again.vst3/Contents/Resources),
// so locate again.uidesc by walking the bundle rather than assuming a path.
function findFile(directory, name, depth = 0) {
  if (depth > 6) return undefined;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
const uidesc = findFile(bundle, 'again.uidesc');
check('real again.uidesc is packaged inside the fixture', Boolean(uidesc), { bundle });
if (uidesc) {
  const xml = readFileSync(uidesc, 'utf8');
  check('again.uidesc describes the plug-in view and its Gain control',
    /<vstgui-ui-description/.test(xml) && /Gain/i.test(xml), { bytes: statSync(uidesc).size, uidesc });
}

// ---- Apex's own host must discover the genuine editor effect ---------------
const { plugins, errors } = await discoverVst3(executable, [bundle], { kind: 'effect' });
const again = plugins.find(plugin => plugin.name === 'AGain');
check('Apex native VST3 host discovers AGain as a Mixer audio effect', Boolean(again),
  { plugins: plugins.map(plugin => plugin.name), errors });
if (again) {
  check('AGain is categorized as an effect, not an instrument', again.categories.includes('Fx'),
    { categories: again.categories });
}

// ---- controller parameters: the genuine ParamID 0 Gain ---------------------
if (again) {
  const service = new Vst3Service(executable, [path.dirname(bundle)]);
  const metadata = await service.describeEffect({
    ...again, state: { schema: 1, classId: again.classId, parameters: [] },
  }, 'fixture-check');
  const gain = metadata.parameters.find(parameter => parameter.id === 0);
  check('AGain controller exposes genuine ParamID 0 (Gain)', Boolean(gain),
    { parameterCount: metadata.parameters.length, ids: metadata.parameters.slice(0, 8).map(p => p.id) });
  if (gain) {
    check('the Gain parameter is writable and automatable', (gain.flags & 2) === 0 && (gain.flags & 1) !== 0,
      { flags: gain.flags, name: gain.name, units: gain.units });
  }
  await service.dispose();
}

// ---- helper process starts and terminates cleanly -------------------------
const client = new NativeVst3Client(executable, { timeoutMs: 10000 });
let cleanly = false;
try {
  if (again) {
    const opened = await client.open({ ...again }, { sampleRate: 48000, mode: 'offline', kind: 'effect',
      state: { schema: 1, classId: again.classId, parameters: [] } });
    const state = await client.snapshot();
    cleanly = Boolean(opened.plugin) && state.classId === again.classId;
    check('helper opens and captures a genuine AGain session state', cleanly,
      { classId: state.classId, hasComponentState: typeof state.component === 'string' });
    // The genuine editor view must exist and be constructible in this process.
    const editor = await client.openEditor({ path: again.path, classId: again.classId, state }).then(
      result => result.editor,
      error => ({ error: error.message }));
    check('the genuine AGain editor view opens in the helper', Boolean(editor && editor.available && !editor.error),
      { editor: editor && { available: editor.available, title: editor.title, width: editor.width, height: editor.height,
        resizable: editor.resizable, error: editor.error } });
    if (editor && editor.available) {
      const closed = await client.closeEditor();
      check('closing the editor captured the final plug-in state',
        Boolean(closed && closed.state && typeof closed.state.component === 'string'), { dirty: closed && closed.dirty });
    }
    await client.request({ command: 'close' });
    check('helper accepted an explicit close request', true, {});
  }
} catch (error) {
  check('helper opens and captures a genuine AGain session state', false, { error: error.message });
} finally {
  // A clean helper exit is a real assertion: dispose() sends `close` over the
  // framed pipe and waits for the process to exit. If the helper leaked or hung,
  // the request would time out and this check would record the failure.
  try {
    await client.dispose();
    // A real leak check: no helper process may survive the close.
    const survivors = liveHelpers();
    check('helper terminates cleanly after the session', survivors.length === 0, { surviving: survivors });
  } catch (error) {
    check('helper terminates cleanly after the session', false, { error: error.message });
  }
}
finish();
