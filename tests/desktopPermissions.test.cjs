const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { canRequestPermission, canCheckPermission } = require('../desktop-permissions.cjs');

const appFile = 'file:///app/dist/index.html';
const appDev = 'http://localhost:3000/';

test('app content may request media, MIDI, and MIDI sysex', () => {
  for (const permission of ['media', 'midi', 'midiSysex']) {
    assert.equal(canRequestPermission(appFile, permission), true, `${permission} file app`);
    assert.equal(canRequestPermission(appDev, permission), true, `${permission} dev app`);
  }
});

test('unrelated requests are not broadly granted', () => {
  for (const permission of ['fullscreen', 'clipboard-read', 'geolocation', 'notifications', 'usb']) {
    assert.equal(canRequestPermission(appFile, permission), false, permission);
  }
});

test('permission checks allow only app Web MIDI/media plus preserved desktop capabilities', () => {
  for (const permission of ['media', 'midi', 'midiSysex']) {
    assert.equal(canCheckPermission(appFile, permission), true, permission);
  }
  for (const permission of ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write']) {
    assert.equal(canCheckPermission(appFile, permission), true, `${permission} remains available`);
  }
  for (const permission of ['geolocation', 'notifications', 'usb', 'hid']) {
    assert.equal(canCheckPermission(appFile, permission), false, permission);
  }
});

test('external origins cannot receive MIDI or other permission checks', () => {
  for (const url of ['https://example.com', 'http://localhost:3000.evil.test', 'http://localhost:3001']) {
    assert.equal(canRequestPermission(url, 'midi'), false, url);
    assert.equal(canCheckPermission(url, 'midi'), false, url);
  }
});

test('request and check handlers are both wired to the shared policy', () => {
  const source = fs.readFileSync(require.resolve('../electron.cjs'), 'utf8');
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /setPermissionCheckHandler/);
  assert.match(source, /canRequestPermission\(webContents\.getURL\(\), permission\)/);
  assert.match(source, /canCheckPermission\(requestingOrigin, permission\)/);
});
