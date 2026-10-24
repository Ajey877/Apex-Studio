// Optional, explicit native prototype dependencies. Never fetched by npm install
// or by a browser/desktop build. Immutable pins include SDK submodule revisions.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve('build/native-deps');
mkdirSync(root, { recursive: true });
const dependencies = [
  ['vst3sdk', 'https://github.com/steinbergmedia/vst3sdk.git', '9fad9770f2ae8542ab1a548a68c1ad1ac690abe0'],
  ['json', 'https://github.com/nlohmann/json.git', '9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03'],
];
function run(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
for (const [name, url, pin] of dependencies) {
  const dir = path.join(root, name);
  if (!existsSync(dir)) {
    run(['init', dir]);
    run(['remote', 'add', 'origin', url], dir);
    run(['fetch', '--depth=1', 'origin', pin], dir);
    run(['checkout', '--detach', 'FETCH_HEAD'], dir);
  }
  if (run(['rev-parse', 'HEAD'], dir) !== pin || run(['status', '--porcelain'], dir)) {
    throw new Error(`${name}: expected clean pinned revision ${pin}; refusing to overwrite local files`);
  }
  if (name === 'vst3sdk') {
    run(['submodule', 'update', '--init', '--depth=1', 'base', 'cmake', 'pluginterfaces', 'public.sdk'], dir);
    const submodules = run(['submodule', 'status', 'base', 'cmake', 'pluginterfaces', 'public.sdk'], dir);
    if (submodules.split('\n').some(line => /^[+U-]/.test(line.trimStart()))) throw new Error('SDK submodule revision mismatch');
    for (const module of ['base', 'cmake', 'pluginterfaces', 'public.sdk']) {
      if (run(['status', '--porcelain'], path.join(dir, module))) throw new Error(`Dirty SDK submodule: ${module}`);
    }
  }
}
console.log('Pinned native dependencies ready under build/native-deps. See native/vst3/README.md.');
