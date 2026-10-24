import { spawnSync } from 'node:child_process';
import path from 'node:path';
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ['scripts/setup-native-vst3.mjs']);
const cmake = process.env.CMAKE ?? 'cmake';
const generator = process.platform === 'win32' ? ['-G', 'Visual Studio 17 2022', '-A', 'x64'] : ['-G', 'Ninja'];
run(cmake, ['-S', 'native/vst3', '-B', 'build/native-vst3', ...generator, '-DCMAKE_BUILD_TYPE=Release',
  `-DVST3_SDK_ROOT=${path.resolve('build/native-deps/vst3sdk')}`,
  `-DJSON_ROOT=${path.resolve('build/native-deps/json')}`]);
run(cmake, ['--build', 'build/native-vst3', '--config', 'Release', '--target',
  'apex-vst3-host', 'mda-vst3', 'apex-vst3-protocol-fault', '--parallel', '2']);
