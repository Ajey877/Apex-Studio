import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canRequestPermission, canCheckPermission } = require('../desktop-permissions.cjs');

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
  ['setPermissionRequestHandler', 'permission request policy'],
  ['setPermissionCheckHandler', 'permission check policy']
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

const appUrl = 'file:///app/dist/index.html';
for (const permission of ['media', 'midi', 'midiSysex']) {
  if (!canRequestPermission(appUrl, permission) || !canCheckPermission(appUrl, permission)) {
    throw new Error(`Desktop permission regression: app content must request and check ${permission}.`);
  }
}
for (const permission of ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write']) {
  if (!canCheckPermission(appUrl, permission)) {
    throw new Error(`Desktop permission regression: existing ${permission} check must remain available.`);
  }
  if (canRequestPermission(appUrl, permission)) {
    throw new Error(`Desktop permission regression: ${permission} must not be broadly request-granted.`);
  }
}
for (const url of ['https://example.com', 'http://localhost:3000.evil.test']) {
  if (canRequestPermission(url, 'midi') || canCheckPermission(url, 'midi')) {
    throw new Error(`Desktop permission regression: external origin received MIDI permission: ${url}`);
  }
}
for (const permission of ['geolocation', 'notifications', 'usb', 'hid']) {
  if (canRequestPermission(appUrl, permission) || canCheckPermission(appUrl, permission)) {
    throw new Error(`Desktop permission regression: unrelated ${permission} was granted.`);
  }
}

console.log('Desktop security configuration and permission semantics checks passed.');
