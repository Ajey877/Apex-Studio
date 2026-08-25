import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronConfig = fs.readFileSync(path.join(root, 'electron.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');

const devDependencies = packageJson.devDependencies ?? {};

const required = {
  electron: devDependencies.electron,
  'electron-builder': devDependencies['electron-builder']
};

for (const [name, version] of Object.entries(required)) {
  if (!version) throw new Error(`Missing required desktop devDependency: ${name}`);
}

const requiredSnippets = [
  ['app.enableSandbox()', 'global renderer sandboxing'],
  ['nodeIntegration: false', 'Node integration disabled'],
  ['contextIsolation: true', 'context isolation enabled'],
  ['sandbox: true', 'renderer sandbox explicitly enabled'],
  ['webSecurity: true', 'web security enabled'],
  ['allowRunningInsecureContent: false', 'insecure content disabled'],
  ["'Content-Security-Policy'", 'production CSP'],
  ["on('will-navigate'", 'navigation guard'],
  ['setWindowOpenHandler', 'new-window guard'],
  ["on('will-attach-webview'", 'webview blocked'],
  ['setPermissionRequestHandler', 'permission policy']
];

for (const [snippet, label] of requiredSnippets) {
  if (!electronConfig.includes(snippet)) {
    throw new Error(`Electron security regression: missing ${label}`);
  }
}

if (/nodeIntegration:\s*true/.test(electronConfig)) {
  throw new Error('Electron security regression: nodeIntegration must never be enabled.');
}

if (/webSecurity:\s*false/.test(electronConfig)) {
  throw new Error('Electron security regression: webSecurity must never be disabled.');
}

if (/allowRunningInsecureContent:\s*true/.test(electronConfig)) {
  throw new Error('Electron security regression: insecure content must never be enabled.');
}

const validIpcSendChannels = preload.match(/const validChannels = \[(.*?)\]/s)?.[1] ?? '';
if (!validIpcSendChannels.includes("'toMain'") || !validIpcSendChannels.includes("'audio-stream'") || !validIpcSendChannels.includes("'midi-event'")) {
  throw new Error('Preload IPC allowlist is missing an expected channel.');
}

if (preload.includes('exposeInMainWorld(\'electron\'')) {
  throw new Error('Preload must not expose the raw Electron API.');
}

console.log('Desktop security configuration checks passed.');
