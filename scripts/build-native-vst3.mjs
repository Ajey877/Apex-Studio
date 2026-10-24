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
      const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-12000)
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
run(cmake, ['--build', 'build/native-vst3', '--config', 'Release', '--target',
  'apex-vst3-host', 'mda-vst3', 'apex-vst3-protocol-fault', '--parallel', '2']);
