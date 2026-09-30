const DEV_URL = 'http://localhost:3000';
const APP_PERMISSIONS = new Set(['media', 'midi', 'midiSysex']);
// These are existing desktop capabilities, not newly granted browser permissions.
const PRESERVED_DESKTOP_CHECKS = new Set([
  'fullscreen',
  'clipboard-read',
  'clipboard-sanitized-write',
  'deprecated-sync-clipboard-read'
]);

function isAppContent(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith('file://')) return true;
  try {
    const parsed = new URL(url);
    const dev = new URL(DEV_URL);
    return parsed.origin === dev.origin;
  } catch {
    return false;
  }
}

function canRequestPermission(url, permission) {
  return isAppContent(url) && APP_PERMISSIONS.has(permission);
}

function canCheckPermission(url, permission) {
  if (!isAppContent(url)) return false;
  return APP_PERMISSIONS.has(permission) || PRESERVED_DESKTOP_CHECKS.has(permission);
}

module.exports = { isAppContent, canRequestPermission, canCheckPermission };
