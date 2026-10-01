import assert from 'node:assert/strict';
import test from 'node:test';
import { HOTKEY_GROUPS } from '../components/HotkeysModal';
import { APPLICATION_MENU_COMMANDS } from './applicationMenu';
import { resolveApplicationMenuShortcut } from './applicationMenu';
import { resolveSaveShortcut, resolveUndoRedoShortcut } from './projectHistory';

const documentedKeys = (): string[] => HOTKEY_GROUPS.flatMap(group => group.items.map(item => item.key));

const documented = () =>
  HOTKEY_GROUPS.flatMap(group => group.items.map(item => ({ category: group.category, ...item })));

test('no documented shortcut claims a handler that does not exist', () => {
  // These three rows were shipped by the audit-follow-up and then removed because
  // the application has no Ctrl+E, tool-switch, or global delete/erase handler.
  const keys = documentedKeys();
  for (const phantom of ['Ctrl + E', 'B / P', 'D / E']) {
    assert.equal(keys.includes(phantom), false, `HotkeysModal must not advertise the nonexistent shortcut ${phantom}`);
  }
});

test('every documented shortcut maps to a verified handler', () => {
  const verified = new Set([
    'Space',
    'L',
    'R',
    'Home / 0',
    'M',
    'F6 / 1',
    'F7 / 2',
    'F5 / 3',
    'F9 / 4',
    'F8 / 5',
    'Ctrl + Z',
    'Ctrl + Y',
    'Ctrl + N',
    'Ctrl + O',
    'Ctrl + S',
    'A - K',
    'W, E, T, Y, U',
    '1 - 9 (Numpad)',
    'Z / X',
  ]);
  for (const key of documentedKeys()) {
    assert.ok(verified.has(key), `${key} is documented but has no verified handler mapping`);
  }
});

test('the application menu advertises the same accelerators the hotkey modal documents', () => {
  const keys = documentedKeys();
  for (const label of ['Ctrl + N', 'Ctrl + O', 'Ctrl + S']) {
    assert.ok(keys.includes(label), `HotkeysModal must document ${label}`);
  }
  assert.equal(APPLICATION_MENU_COMMANDS['file.newSession'].accelerator, 'Ctrl+N');
  assert.equal(APPLICATION_MENU_COMMANDS['file.openManifest'].accelerator, 'Ctrl+O');
  assert.equal(APPLICATION_MENU_COMMANDS['file.save'].accelerator, 'Ctrl+S');
});

test('documented Ctrl+N and Ctrl+O really resolve through the application shortcut resolver', () => {
  assert.equal(
    resolveApplicationMenuShortcut({ code: 'KeyN', key: 'n', ctrlKey: true }),
    'file.newSession'
  );
  assert.equal(
    resolveApplicationMenuShortcut({ code: 'KeyO', key: 'o', ctrlKey: true }),
    'file.openManifest'
  );
});

test('documented Ctrl+Z, Ctrl+Y and Ctrl+S really resolve through the existing resolvers', () => {
  assert.equal(resolveUndoRedoShortcut({ code: 'KeyZ', key: 'z', ctrlKey: true }).action, 'undo');
  assert.equal(resolveUndoRedoShortcut({ code: 'KeyY', key: 'y', ctrlKey: true }).action, 'redo');
  assert.equal(resolveSaveShortcut({ code: 'KeyS', key: 's', ctrlKey: true }), true);
});

test('no documented row is empty or duplicated', () => {
  const seen = new Set<string>();
  for (const item of documented()) {
    assert.ok(item.desc.trim().length > 0, `${item.key} must explain what it does`);
    assert.ok(item.category.trim().length > 0);
    assert.equal(seen.has(item.key), false, `${item.key} is documented twice`);
    seen.add(item.key);
  }
});
