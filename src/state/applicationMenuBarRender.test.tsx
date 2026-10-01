import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ApplicationMenuBarView,
  APPLICATION_MENU_BAR_ID,
  getApplicationMenuDropdownId,
  getApplicationMenuTriggerId,
} from '../components/ApplicationMenuBar';
import {
  APPLICATION_MENUS,
  type ApplicationMenuCommandId,
  type ApplicationMenuId,
} from './applicationMenu';
import type { ApplicationMenuCommandState } from './applicationMenuCommands';
import { createApplicationMenuCommandState } from './applicationMenuCommands';

const renderBar = (
  openMenu: ApplicationMenuId | null,
  state?: ApplicationMenuCommandState
) => {
  const commandState = state ?? createApplicationMenuCommandState({
    canUndo: () => true,
    canRedo: () => true,
    hasSelectedChannel: () => true,
    canDeleteSelectedChannel: () => true,
    currentView: () => 'channel_rack',
    isBrowserOpen: () => false,
    isFullscreen: () => false,
    isMetronomeOn: () => false,
    isRecording: () => false,
  });
  return renderToStaticMarkup(
    React.createElement(ApplicationMenuBarView, {
      openMenu,
      commandState,
      onToggleMenu: () => {},
      onHoverMenu: () => {},
      onDismiss: () => {},
      onRunCommand: () => {},
    })
  );
};

test('the menu bar renders as a labelled menubar with all eight top-level menus', () => {
  const html = renderBar(null);
  assert.ok(html.includes(`id="${APPLICATION_MENU_BAR_ID}"`), 'menu bar root must carry a stable id');
  assert.ok(html.includes('role="menubar"'), 'menu bar must expose the menubar role');
  assert.ok(html.includes('aria-label="Application"'));
  for (const menu of APPLICATION_MENUS) {
    assert.ok(
      html.includes(`id="${getApplicationMenuTriggerId(menu.id)}"`),
      `top-level menu ${menu.label} must render a trigger`
    );
  }
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, APPLICATION_MENUS.length);
});

test('no dropdown is rendered while every top-level menu is closed', () => {
  const html = renderBar(null);
  assert.equal(html.includes('role="menu"'), false);
  assert.equal(html.includes(getApplicationMenuDropdownId('file')), false);
});

test('the top-level trigger reports its expanded state', () => {
  const closed = renderBar(null);
  assert.ok(closed.includes(`id="${getApplicationMenuTriggerId('file')}"`));
  assert.ok(/aria-expanded="false"/.test(closed));

  const open = renderBar('file');
  const triggerTag = open.slice(open.indexOf(`id="${getApplicationMenuTriggerId('file')}"`));
  assert.ok(
    triggerTag.slice(0, triggerTag.indexOf('>')).includes('aria-expanded="true"'),
    'the open menu trigger must report aria-expanded="true"'
  );
});

test('opening File renders only the six backed File commands', () => {
  const html = renderBar('file');
  assert.ok(html.includes(`id="${getApplicationMenuDropdownId('file')}"`));
  assert.ok(html.includes('role="menu"'));
  for (const id of [
    'file.newSession',
    'file.openManifest',
    'file.save',
    'file.exportAudio',
    'file.exportBundle',
    'file.exportManifest',
  ] as ApplicationMenuCommandId[]) {
    assert.ok(html.includes(`id="application-menu-command-${id}"`), `${id} must render`);
  }
});

test('the File dropdown shows the real accelerators for New Session, Open and Save', () => {
  const html = renderBar('file');
  const fileMenu = html.slice(html.indexOf(`id="${getApplicationMenuDropdownId('file')}"`));
  assert.ok(fileMenu.includes('<kbd'));
  for (const accelerator of ['Ctrl+N', 'Ctrl+O', 'Ctrl+S']) {
    assert.ok(fileMenu.includes(`>${accelerator}<`), `${accelerator} must be shown in the File menu`);
  }
});

test('no unsupported command is ever presented as a functional menu row', () => {
  const rendered = APPLICATION_MENUS.map(menu => renderBar(menu.id)).join('');
  for (const forbidden of [
    'Save As',
    'Open Recent',
    'Close Session',
    '>Cut<',
    '>Copy<',
    '>Paste<',
    'Select All',
    '>About<',
    'Time Signature',
    'Sample Rate',
    'Audio Settings',
    'Monitoring',
    'Duplicate Track',
    'Rename Track',
    'Delete Track',
  ]) {
    assert.equal(rendered.includes(forbidden), false, `unsupported command "${forbidden}" must not render`);
  }
});

test('the Edit dropdown contains Undo and Redo and nothing fabricated', () => {
  const html = renderBar('edit');
  assert.ok(html.includes('id="application-menu-command-edit.undo"'));
  assert.ok(html.includes('id="application-menu-command-edit.redo"'));
  assert.equal((html.match(/id="application-menu-command-/g) ?? []).length, 2);
});

test('the Help dropdown exposes only Keyboard Shortcuts', () => {
  const html = renderBar('help');
  assert.ok(html.includes('id="application-menu-command-help.shortcuts"'));
  assert.equal((html.match(/id="application-menu-command-/g) ?? []).length, 1);
});

test('stateful commands expose a real checked state and stateless ones do not', () => {
  const state = createApplicationMenuCommandState({
    canUndo: () => true,
    canRedo: () => true,
    hasSelectedChannel: () => true,
    canDeleteSelectedChannel: () => true,
    currentView: () => 'mixer',
    isBrowserOpen: () => true,
    isFullscreen: () => false,
    isMetronomeOn: () => true,
    isRecording: () => false,
  });
  const view = renderBar('view', state);
  assert.ok(/aria-checked="true"/.test(view), 'the active view must render a checked state');

  const mixerItem = view.slice(view.indexOf('id="application-menu-command-view.mixer"'));
  assert.ok(mixerItem.slice(0, mixerItem.indexOf('>')).includes('aria-checked="true"'));

  const playlistItem = view.slice(view.indexOf('id="application-menu-command-view.playlist"'));
  assert.ok(playlistItem.slice(0, playlistItem.indexOf('>')).includes('aria-checked="false"'));

  const file = renderBar('file', state);
  const saveItem = file.slice(file.indexOf('id="application-menu-command-file.save"'));
  assert.equal(saveItem.slice(0, saveItem.indexOf('>')).includes('aria-checked'), false);
});

test('commands that cannot act render disabled instead of pretending to work', () => {
  const state = createApplicationMenuCommandState({
    canUndo: () => false,
    canRedo: () => false,
    hasSelectedChannel: () => false,
    canDeleteSelectedChannel: () => false,
    currentView: () => 'playlist',
    isBrowserOpen: () => false,
    isFullscreen: () => false,
    isMetronomeOn: () => false,
    isRecording: () => false,
  });

  const edit = renderBar('edit', state);
  for (const id of ['edit.undo', 'edit.redo']) {
    const item = edit.slice(edit.indexOf(`id="application-menu-command-${id}"`));
    const tag = item.slice(0, item.indexOf('>'));
    assert.ok(tag.includes('disabled'), `${id} must render disabled`);
    assert.ok(tag.includes('aria-disabled="true"'), `${id} must be announced as disabled`);
  }

  const track = renderBar('track', state);
  const deleteItem = track.slice(track.indexOf('id="application-menu-command-track.deleteChannel"'));
  assert.ok(deleteItem.slice(0, deleteItem.indexOf('>')).includes('disabled'));
});

test('the menu bar renders nothing that could displace or cover the transport', () => {
  const html = renderBar('file');
  assert.equal(html.includes('fl-transport-bar'), false);
  assert.equal(html.includes('fl-view-tabs'), false);
  assert.equal(html.includes('phantom-mobile-daw'), false);
});
