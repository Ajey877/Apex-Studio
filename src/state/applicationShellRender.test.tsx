import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApplicationMenuBarView } from '../components/ApplicationMenuBar';
import { TransportBar } from '../components/TransportBar';
import { createApplicationMenuCommandState } from './applicationMenuCommands';

/**
 * Renders the real shell chrome to static markup and inspects the resulting DOM.
 *
 * This is the strongest available check of the audit's layout hazard without a
 * browser: `src/uiAudit.css` positions the transport with
 * `#fl-transport-bar > div:first-child > div:nth-child(4)`, so the transport's
 * child order is a contract. If a future change adds a row inside the header, or
 * wraps the transport, these assertions fail instead of silently moving the
 * workspace.
 */

/** Counts direct `<div>` children of the first element nested inside the matched id. */
const countDirectDivChildrenOfFirstChild = (html: string, id: string): number => {
  const idIndex = html.indexOf(`id="${id}"`);
  assert.ok(idIndex >= 0, `expected an element with id ${id}`);

  const outerOpenEnd = html.indexOf('>', idIndex) + 1;
  const innerStart = html.indexOf('<div', outerOpenEnd);
  assert.ok(innerStart >= 0, `expected a <div> first child inside ${id}`);
  const innerOpenEnd = html.indexOf('>', innerStart) + 1;

  let depth = 1;
  let index = innerOpenEnd;
  let children = 0;

  while (depth > 0 && index < html.length) {
    const nextOpen = html.indexOf('<div', index);
    const nextClose = html.indexOf('</div>', index);
    if (nextClose < 0) break;

    if (nextOpen >= 0 && nextOpen < nextClose) {
      if (depth === 1) children += 1;
      depth += 1;
      index = nextOpen + 4;
    } else {
      depth -= 1;
      index = nextClose + 6;
    }
  }

  return children;
};

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

const renderShell = (openMenu: 'file' | null = null): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { id: 'phantom-mobile-daw' },
      React.createElement(ApplicationMenuBarView, {
        openMenu,
        commandState,
        onToggleMenu: () => {},
        onHoverMenu: () => {},
        onDismiss: () => {},
        onRunCommand: () => {},
      }),
      React.createElement(TransportBar, {
        currentView: 'channel_rack',
        onSelectView: () => {},
        isPlaying: false,
        onTogglePlay: () => {},
        onStop: () => {},
        playMode: 'pat',
        onTogglePlayMode: () => {},
        isRecording: false,
        onToggleRecord: () => {},
        meta: {
          id: 'proj-shell',
          name: 'Shell Fixture',
          author: 'Test',
          bpm: 128,
          timeSignature: [4, 4],
          swing: 0,
          masterVolume: 1,
          masterPitch: 0,
          created: 0,
          updated: 0,
          version: 'test',
          offlineReady: true,
          totalEditTimeSeconds: 0,
        },
        onUpdateMeta: () => {},
        currentStep: 0,
        currentBar: 1,
        metronome: false,
        onToggleMetronome: () => {},
        onOpenExport: () => {},
        onOpenProjectManager: () => {},
        onOpenCollab: () => {},
        onOpenAnalytics: () => {},
        onOpenHotkeys: () => {},
        onOpenMidi: () => {},
        collaboratorCount: 0,
        isSidebarOpen: true,
        onToggleSidebar: () => {},
      })
    )
  );

test('the real transport still renders through the shell', () => {
  const html = renderShell();
  assert.ok(html.includes('id="fl-transport-bar"'), 'the transport must still render');
  assert.ok(html.includes('id="fl-view-tabs"'), 'the view tab ribbon must still render');
});

test('the menu bar renders above the transport and is not nested inside it', () => {
  const html = renderShell();
  const menuIndex = html.indexOf('id="application-menu-bar"');
  const transportIndex = html.indexOf('id="fl-transport-bar"');
  assert.ok(menuIndex >= 0 && transportIndex >= 0);
  assert.ok(menuIndex < transportIndex, 'the menu must precede the transport in document order');
  // The menu closes before the transport opens, so it cannot be a descendant.
  const menuCloseIndex = html.indexOf('</header>', menuIndex);
  assert.ok(menuCloseIndex < transportIndex, 'the menu bar must be a sibling, not a wrapper');
});

test('the transport top row keeps exactly the four direct children the positional CSS indexes into', () => {
  const html = renderShell();
  // `#fl-transport-bar > div:first-child > div:nth-child(4)` must keep resolving
  // to the right-hand status strip. Four children is the audited contract.
  assert.equal(countDirectDivChildrenOfFirstChild(html, 'fl-transport-bar'), 4);
});

test('the transport keeps its top row and view ribbon as the first two children', () => {
  const html = renderShell();
  const headerOpen = html.indexOf('id="fl-transport-bar"');
  const firstNavIndex = html.indexOf('<nav', headerOpen);
  assert.ok(firstNavIndex > 0, 'the header must still contain the view ribbon');
  assert.ok(
    html.startsWith('<nav id="fl-view-tabs"', firstNavIndex),
    'the first element after the transport top row must still be the #fl-view-tabs ribbon'
  );
  // The ribbon is the second direct child, so nothing was inserted between it and
  // the top row that the responsive overrides could pick up.
  assert.equal(countDirectDivChildrenOfFirstChild(html, 'fl-transport-bar'), 4);
});

test('every transport control still renders after the shell change', () => {
  const html = renderShell();
  for (const id of [
    'fl-playmode-toggle',
    'fl-play-btn',
    'fl-stop-btn',
    'fl-record-btn',
    'fl-metronome-btn',
    'fl-bpm-input',
    'fl-export-btn',
    'fl-fullscreen-btn',
    'fl-hotkeys-btn',
    'nav-channel-rack',
    'nav-piano-roll',
    'nav-playlist',
    'nav-mixer',
    'nav-instruments',
    'nav-sampler',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `transport control ${id} must still render`);
  }
});

test('the transport wraps no part of the menu, and an open dropdown does not displace it', () => {
  const closed = renderShell(null);
  const open = renderShell('file');

  assert.equal(
    countDirectDivChildrenOfFirstChild(open, 'fl-transport-bar'),
    4,
    'opening a dropdown must not change the transport structure'
  );
  const transportIndexClosed = closed.indexOf('id="fl-transport-bar"');
  const transportIndexOpen = open.indexOf('id="fl-transport-bar"');
  assert.ok(transportIndexOpen > 0);
  // The dropdown renders before the transport in document order, i.e. it is part
  // of the menu bar, not injected into the workspace.
  assert.ok(open.indexOf('id="application-menu-file-menu"') < transportIndexOpen);
  assert.ok(transportIndexClosed > 0);
});
