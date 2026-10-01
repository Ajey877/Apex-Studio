import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLICATION_MENUS,
  APPLICATION_MENU_COMMANDS,
  APPLICATION_MENU_IDS,
  UNSUPPORTED_APPLICATION_MENU_COMMANDS,
  createApplicationMenuBarState,
  getApplicationMenuCommandView,
  reduceApplicationMenuBar,
  resolveApplicationMenuShortcut,
  type ApplicationMenuCommandId,
  type ApplicationMenuId,
  type ApplicationMenuItem,
} from './applicationMenu';
import { KEY_NOTE_MAP } from './musicalKeyboard';

const commandItems = (): Extract<ApplicationMenuItem, { kind: 'command' }>[] =>
  APPLICATION_MENUS.flatMap(menu =>
    menu.items.filter((item): item is Extract<ApplicationMenuItem, { kind: 'command' }> => item.kind === 'command')
  );

const shortcutEvent = (overrides: {
  code?: string;
  key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}) => ({
  code: overrides.code,
  key: overrides.key,
  ctrlKey: overrides.ctrlKey ?? false,
  metaKey: overrides.metaKey ?? false,
  shiftKey: overrides.shiftKey ?? false,
  altKey: overrides.altKey ?? false,
});

test('application menu declares the eight audited top-level menus in order', () => {
  assert.deepEqual(
    APPLICATION_MENUS.map(menu => menu.label),
    ['File', 'Edit', 'View', 'Project', 'Track', 'Audio', 'MIDI', 'Help']
  );
  assert.deepEqual(
    APPLICATION_MENUS.map(menu => menu.id),
    ['file', 'edit', 'view', 'project', 'track', 'audio', 'midi', 'help']
  );
  assert.deepEqual([...APPLICATION_MENU_IDS], APPLICATION_MENUS.map(menu => menu.id));
});

test('every rendered menu command resolves to a registered command entry', () => {
  for (const item of commandItems()) {
    const entry = APPLICATION_MENU_COMMANDS[item.id];
    assert.ok(entry, `${item.id} must be registered in APPLICATION_MENU_COMMANDS`);
    assert.equal(item.label, entry.label, `${item.id} label must come from the registry`);
    assert.equal(item.accelerator, entry.accelerator, `${item.id} accelerator must come from the registry`);
  }
});

test('declared accelerators are unique so no two commands share a shortcut', () => {
  const seen = new Map<string, ApplicationMenuCommandId>();
  for (const item of commandItems()) {
    if (!item.accelerator) continue;
    const previous = seen.get(item.accelerator);
    assert.equal(previous, undefined, `accelerator ${item.accelerator} is claimed by both ${previous} and ${item.id}`);
    seen.set(item.accelerator, item.id);
  }
});

test('unsupported commands are documented but never rendered as menu items', () => {
  const unsupportedIds = new Set(UNSUPPORTED_APPLICATION_MENU_COMMANDS.map(entry => entry.id));
  assert.ok(unsupportedIds.size > 0, 'the audit must record why commands are withheld');
  for (const entry of UNSUPPORTED_APPLICATION_MENU_COMMANDS) {
    assert.ok(entry.reason.trim().length > 0, `${entry.id} must document a reason`);
    assert.ok(
      !(entry.id in APPLICATION_MENU_COMMANDS),
      `${entry.id} is marked unsupported and must not be a runnable command`
    );
  }
});

test('unsupported commands that must not be fabricated are absent from the menu tree', () => {
  const rendered = JSON.stringify(APPLICATION_MENUS);
  for (const forbidden of [
    'Open Recent',
    'Recent Sessions',
    'Save As',
    'Close Session',
    'Cut',
    'Copy',
    'Paste',
    'Select All',
    'About',
    'Time Signature',
    'Sample Rate',
    'Audio Settings',
    'Monitoring',
    'Duplicate',
    'Rename',
  ]) {
    assert.equal(
      rendered.includes(`"${forbidden}`),
      false,
      `menu tree must not present the unsupported command "${forbidden}"`
    );
  }
});

test('File menu exposes only New Session, Open, Save and Export commands', () => {
  const file = APPLICATION_MENUS.find(menu => menu.id === 'file');
  assert.ok(file);
  assert.deepEqual(
    file.items.filter((item): item is Extract<ApplicationMenuItem, { kind: 'command' }> => item.kind === 'command')
      .map(item => item.id),
    [
      'file.newSession',
      'file.openManifest',
      'file.save',
      'file.exportAudio',
      'file.exportBundle',
      'file.exportManifest',
    ]
  );
});

test('Edit menu exposes only the commands with real handlers', () => {
  const edit = APPLICATION_MENUS.find(menu => menu.id === 'edit');
  assert.ok(edit);
  assert.deepEqual(
    edit.items.filter((item): item is Extract<ApplicationMenuItem, { kind: 'command' }> => item.kind === 'command')
      .map(item => item.id),
    ['edit.undo', 'edit.redo']
  );
});

test('resolveApplicationMenuShortcut binds Ctrl+N and Ctrl+O and nothing else', () => {
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyN', key: 'n', ctrlKey: true })), 'file.newSession');
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyN', key: 'N', metaKey: true })), 'file.newSession');
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyO', key: 'o', ctrlKey: true })), 'file.openManifest');
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyO', key: 'O', metaKey: true })), 'file.openManifest');
});

test('resolveApplicationMenuShortcut never claims Ctrl+S, Ctrl+Shift+S, F11, or undo/redo keys', () => {
  // Ctrl+S is owned by the existing resolveSaveShortcut path and must keep exactly one implementation.
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyS', key: 's', ctrlKey: true })), null);
  // Save As does not exist and must never be advertised.
  assert.equal(
    resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyS', key: 'S', ctrlKey: true, shiftKey: true })),
    null
  );
  // Fullscreen handling exists but was not bound to a key; do not invent F11.
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'F11', key: 'F11' })), null);
  // Undo/redo stay owned by resolveUndoRedoShortcut.
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyZ', key: 'z', ctrlKey: true })), null);
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyY', key: 'y', ctrlKey: true })), null);
});

test('resolveApplicationMenuShortcut refuses every unmodified key', () => {
  // The global keydown handler drives note input from unmodified codes, so a bare
  // letter must never be treated as an application command.
  const codes = [...Object.keys(KEY_NOTE_MAP), 'KeyN', 'KeyO', 'KeyS', 'F11', 'Escape', 'Space', 'Delete'];
  for (const code of codes) {
    assert.equal(
      resolveApplicationMenuShortcut(shortcutEvent({ code, key: code })),
      null,
      `${code} without a modifier must not be an application menu shortcut`
    );
  }
});

test('resolveApplicationMenuShortcut ignores extra modifiers so it cannot steal note entry', () => {
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyN', key: 'n', ctrlKey: true, altKey: true })), null);
  assert.equal(
    resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyO', key: 'o', ctrlKey: true, altKey: true, shiftKey: true })),
    null
  );
});

test('no note key is stolen from the virtual piano: a bare note code is never an application command', () => {
  // Exhaustive proof over the whole note map. The global keydown handler only
  // reaches note entry when `!isModifier`, and every application menu shortcut
  // requires Ctrl/Cmd, so the two sets are disjoint by construction.
  for (const code of Object.keys(KEY_NOTE_MAP)) {
    assert.equal(
      resolveApplicationMenuShortcut(shortcutEvent({ code, key: 'a' })),
      null,
      `${code} without a modifier must stay a piano key`
    );
  }
});

test('a note code that shares a letter with a menu accelerator still plays its note', () => {
  // KeyO is both piano note 73 and the Ctrl+O accelerator. Claiming Ctrl+O must
  // not affect the unmodified key.
  assert.equal(KEY_NOTE_MAP.KeyO, 73);
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyO', key: 'o' })), null);
  assert.equal(resolveApplicationMenuShortcut(shortcutEvent({ code: 'KeyO', key: 'o', ctrlKey: true })), 'file.openManifest');
});

test('every application menu shortcut requires a modifier', () => {
  // Any combination the resolver accepts must carry Ctrl or Cmd.
  const modifiers = [
    { ctrlKey: true },
    { metaKey: true },
    { ctrlKey: true, shiftKey: true },
    { ctrlKey: true, altKey: true },
  ];
  for (const code of ['KeyN', 'KeyO', 'KeyS', 'KeyZ', 'KeyA', 'Semicolon', 'Numpad1']) {
    for (const modifier of modifiers) {
      const resolved = resolveApplicationMenuShortcut(shortcutEvent({ code, key: 'x', ...modifier }));
      if (resolved === null) continue;
      assert.ok(modifier.ctrlKey || modifier.metaKey, `${code} resolved without a modifier`);
      assert.equal(modifier.shiftKey, undefined, `${code} resolved while Shift was held`);
      assert.equal(modifier.altKey, undefined, `${code} resolved while Alt was held`);
    }
  }
});

test('getApplicationMenuCommandView maps only the six real workspace views', () => {
  assert.equal(getApplicationMenuCommandView('view.channelRack'), 'channel_rack');
  assert.equal(getApplicationMenuCommandView('view.pianoRoll'), 'piano_roll');
  assert.equal(getApplicationMenuCommandView('view.playlist'), 'playlist');
  assert.equal(getApplicationMenuCommandView('view.mixer'), 'mixer');
  assert.equal(getApplicationMenuCommandView('view.instruments'), 'instruments');
  assert.equal(getApplicationMenuCommandView('view.recorder'), 'sampler');
  assert.equal(getApplicationMenuCommandView('file.save'), null);
  assert.equal(getApplicationMenuCommandView('edit.undo'), null);
  assert.equal(getApplicationMenuCommandView('view.browser'), null);
});

test('menu bar starts with no dropdown open', () => {
  assert.deepEqual(createApplicationMenuBarState(), { openMenu: null });
});

test('activating a top-level menu opens it and activating it again closes it', () => {
  const opened = reduceApplicationMenuBar(createApplicationMenuBarState(), { type: 'toggle', menu: 'file' });
  assert.equal(opened.openMenu, 'file');
  assert.equal(reduceApplicationMenuBar(opened, { type: 'toggle', menu: 'file' }).openMenu, null);
});

test('clicking another top-level menu closes the previous one', () => {
  const file = reduceApplicationMenuBar(createApplicationMenuBarState(), { type: 'toggle', menu: 'file' });
  const view = reduceApplicationMenuBar(file, { type: 'toggle', menu: 'view' });
  assert.equal(view.openMenu, 'view');
});

test('dismiss closes an open menu and is idempotent', () => {
  const file = reduceApplicationMenuBar(createApplicationMenuBarState(), { type: 'toggle', menu: 'file' });
  assert.equal(reduceApplicationMenuBar(file, { type: 'dismiss' }).openMenu, null);
  assert.equal(reduceApplicationMenuBar(createApplicationMenuBarState(), { type: 'dismiss' }).openMenu, null);
});

test('hover only switches menus while a dropdown is already open', () => {
  const closed = createApplicationMenuBarState();
  assert.equal(reduceApplicationMenuBar(closed, { type: 'hover', menu: 'view' }).openMenu, null);

  const file = reduceApplicationMenuBar(closed, { type: 'toggle', menu: 'file' });
  assert.equal(reduceApplicationMenuBar(file, { type: 'hover', menu: 'view' }).openMenu, 'view');
  assert.equal(reduceApplicationMenuBar(file, { type: 'hover', menu: 'file' }).openMenu, 'file');
});

test('every application menu id can be opened and dismissed', () => {
  for (const id of APPLICATION_MENU_IDS as readonly ApplicationMenuId[]) {
    const opened = reduceApplicationMenuBar(createApplicationMenuBarState(), { type: 'toggle', menu: id });
    assert.equal(opened.openMenu, id);
    assert.equal(reduceApplicationMenuBar(opened, { type: 'dismiss' }).openMenu, null);
  }
});
