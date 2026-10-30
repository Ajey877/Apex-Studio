import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function sha256File(filePath) {
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return null;
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function findPluginModule(bundle) {
  if (!bundle || !existsSync(bundle)) return null;
  if (statSync(bundle).isFile()) return bundle;
  const stack = [bundle];
  let best = null, bestSize = -1;
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (/\.(vst3|dll|so|dylib)$/i.test(name)) {
        const size = statSync(full).size;
        if (size > bestSize) { best = full; bestSize = size; }
      }
    }
  }
  return best;
}

function firstExisting(paths) {
  return paths.find(path => existsSync(path)) ?? null;
}

const unpacked = firstExisting([
  join(process.cwd(), 'dist-electron', 'win-unpacked'),
  join(process.cwd(), 'frozen-app'),
]);
const exe = unpacked ? readdirSync(unpacked)
  .map(name => join(unpacked, name))
  .find(path => path.toLowerCase().endsWith('.exe') && !path.toLowerCase().includes('uninstall')) : null;
const asar = firstExisting([
  unpacked && join(unpacked, 'resources', 'app.asar'),
  join(process.cwd(), 'dist', 'index.html'),
].filter(Boolean));
const renderer = firstExisting([
  join(process.cwd(), 'dist', 'assets') && existsSync(join(process.cwd(), 'dist', 'assets'))
    ? readdirSync(join(process.cwd(), 'dist', 'assets')).filter(n => n.endsWith('.js')).map(n => join(process.cwd(), 'dist', 'assets', n))[0]
    : null,
].filter(Boolean));
const helper = firstExisting([
  unpacked && join(unpacked, 'resources', 'vst3', 'apex-vst3-host.exe'),
  join(process.cwd(), 'build', 'native-vst3', 'bin', 'Release', 'apex-vst3-host.exe'),
  join(process.cwd(), 'build', 'native-vst3', 'bin', 'apex-vst3-host'),
].filter(Boolean));
const pluginBundle = firstExisting([
  join(process.cwd(), 'build', 'native-vst3', 'VST3', 'Release', 'mda-vst3.vst3'),
  join(process.cwd(), 'swapped-plugin'),
]);
const pluginModule = findPluginModule(pluginBundle);
const manifest = {
  cwd: process.cwd(),
  applicationExecutable: exe, applicationExecutableSha256: sha256File(exe),
  applicationAsar: asar, applicationAsarSha256: sha256File(asar),
  rendererBundle: renderer, rendererBundleSha256: sha256File(renderer),
  helperPath: helper, helperSha256: sha256File(helper),
  pluginBundle, pluginModule, pluginModuleSha256: sha256File(pluginModule),
};
const dest = process.argv[2] || join(process.cwd(), 'build', 'native-evidence', 'frozen-manifest.json');
writeFileSync(dest, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=frozen binary manifest::${JSON.stringify(manifest)}`);
}
