import { spawnSync } from 'node:child_process';
import path from 'node:path';
function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: false,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    // Make the actual compiler/configuration error visible in the check API as
    // well as downloadable logs (which may be inaccessible in restricted CI).
    if (process.env.GITHUB_ACTIONS) {
      const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-3500)
        .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
      console.error(`::error title=Native VST3 build failed::${tail}`);
    }
    process.exit(result.status ?? 1);
  }
}
run(process.execPath, ['scripts/setup-native-vst3.mjs']);
const cmake = process.env.CMAKE ?? 'cmake';
// Let CMake select the installed Visual Studio generation (windows-latest
// can move beyond VS2022); never pin to a toolchain absent from the runner.
const generator = process.platform === 'win32' ? ['-A', 'x64'] : ['-G', 'Ninja'];
run(cmake, ['-S', 'native/vst3', '-B', 'build/native-vst3', ...generator, '-DCMAKE_BUILD_TYPE=Release',
  `-DVST3_SDK_ROOT=${path.resolve('build/native-deps/vst3sdk')}`,
  `-DJSON_ROOT=${path.resolve('build/native-deps/json')}`]);
const targets = [
  'apex-vst3-host', 'mda-vst3', 'apex-vst3-protocol-fault',
  'apex-vst3-restart-flags-test', 'apex-latency-vst3',
  // Test-only: stereo effect + genuine VSTGUI editor + controller-exposed
  // parameters, which no pinned SDK sample provides all of at once.
  'apex-acceptance-vst3-test',
];
if (process.platform === 'win32') {
  // The VSTGUI editor half of the acceptance fixture needs the Windows bundle
  // layout (and VSTGUI needs X11 on Linux, which headless runners lack).
  targets.push('apex-acceptance-vst3');
}
if (process.platform === 'win32') {
  // `again` proves the genuine editor window. `data-exchange` is stereo-in /
  // stereo-out AND has a genuine VSTGUI editor, so it is the only SDK fixture that
  // can prove the PACKAGED Mixer-insert path without weakening the host's refusal
  // of audio effects with event input buses (AGain has one, so it cannot be a
  // Mixer insert at all). Both are built; neither substitutes for the other.
  targets.push('again', 'data-exchange');
}
run(cmake, ['--build', 'build/native-vst3', '--config', 'Release', '--target', ...targets, '--parallel', '2']);
