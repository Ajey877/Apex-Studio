import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ApplicationMenuBarView,
  createApplicationMenuDismissHandlers,
} from '../components/ApplicationMenuBar';
import {
  createApplicationMenuBarState,
  reduceApplicationMenuBar,
} from './applicationMenu';
import { createApplicationMenuCommandState } from './applicationMenuCommands';

const commandState = createApplicationMenuCommandState({
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

const renderWithOpenMenu = (openMenu: Parameters<typeof ApplicationMenuBarView>[0]['openMenu']) =>
  renderToStaticMarkup(
    React.createElement(ApplicationMenuBarView, {
      openMenu,
      commandState,
      onToggleMenu: () => {},
      onHoverMenu: () => {},
      onDismiss: () => {},
      onRunCommand: () => {},
    })
  );

test('Escape closes an open dropdown and is consumed before editor handlers see it', () => {
  const dismissals: number[] = [];
  let propagationStopped = false;
  const handlers = createApplicationMenuDismissHandlers(() => null, () => dismissals.push(1));

  handlers.handleKeyDown({
    key: 'Escape',
    stopPropagation: () => {
      propagationStopped = true;
    },
  });

  assert.equal(dismissals.length, 1, 'Escape must close the menu');
  assert.equal(propagationStopped, true, 'Escape must not reach the window-level editor handlers');
});

test('other keys neither close the menu nor consume the event', () => {
  const dismissals: number[] = [];
  let propagationStopped = false;
  const handlers = createApplicationMenuDismissHandlers(() => null, () => dismissals.push(1));
  const stopPropagation = () => {
    propagationStopped = true;
  };

  for (const key of ['Enter', 'ArrowDown', 'n', 'Tab', 'Escape ']) {
    handlers.handleKeyDown({ key, stopPropagation });
  }

  assert.deepEqual(dismissals, []);
  assert.equal(propagationStopped, false);
});

test('a click outside the menu bar closes the dropdown', () => {
  const dismissals: number[] = [];
  const handlers = createApplicationMenuDismissHandlers(
    () => ({ contains: () => false }),
    () => dismissals.push(1)
  );

  handlers.handlePointerDown({ target: { tag: 'div' } });

  assert.equal(dismissals.length, 1);
});

test('a click inside the menu bar does not close the dropdown', () => {
  const dismissals: number[] = [];
  const handlers = createApplicationMenuDismissHandlers(
    () => ({ contains: () => true }),
    () => dismissals.push(1)
  );

  handlers.handlePointerDown({ target: { tag: 'button' } });

  assert.deepEqual(dismissals, []);
});

test('a click event with no target does not throw and closes the dropdown', () => {
  const dismissals: number[] = [];
  const handlers = createApplicationMenuDismissHandlers(
    () => ({ contains: () => false }),
    () => dismissals.push(1)
  );

  assert.doesNotThrow(() => handlers.handlePointerDown({ target: null }));
  assert.equal(dismissals.length, 1);
});

test('only one dropdown can ever be rendered at a time', () => {
  for (const openMenu of ['file', 'edit', 'view', 'project', 'track', 'audio', 'midi', 'help'] as const) {
    const html = renderWithOpenMenu(openMenu);
    assert.equal((html.match(/role="menu"/g) ?? []).length, 1, `${openMenu} must be the only open dropdown`);
  }
});

test('opening a second menu removes the first menu entirely', () => {
  const file = renderWithOpenMenu('file');
  assert.ok(file.includes('application-menu-command-file.save'));

  const view = renderWithOpenMenu('view');
  assert.equal(view.includes('application-menu-command-file.save'), false);
  assert.ok(view.includes('application-menu-command-view.mixer'));
});

test('dismiss is idempotent so a stray click cannot leave the bar in a stuck state', () => {
  const open = reduceApplicationMenuBar(createApplicationMenuBarState(), { type: 'toggle', menu: 'file' });
  const once = reduceApplicationMenuBar(open, { type: 'dismiss' });
  const twice = reduceApplicationMenuBar(once, { type: 'dismiss' });
  assert.deepEqual(once, { openMenu: null });
  assert.deepEqual(twice, { openMenu: null });
});
