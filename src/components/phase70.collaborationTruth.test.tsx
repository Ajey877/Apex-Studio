/**
 * Phase 70 — F2: the Collaboration modal may only present project data.
 *
 * The modal used to be fed hard-coded demo producers ("Online Studio Session
 * (3 Producers)" with pulsing ONLINE/IDLE pills) and demo notes from component
 * state, so the panel presented people and annotations that were not in the
 * project — and a note the user typed was not written into `ProjectState` at
 * all. These tests render the real component from project data and assert that
 * everything shown is derived from the values it was handed, that no live
 * presence is claimed (this build has no network sync), and that `App.tsx`
 * no longer keeps a second, private source for either collection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { CollaborationModal } from './CollaborationModal';
import { createDefaultProjectState } from '../state/projectState';
import type { CollabComment, CollabUser } from '../types/daw';

const noop = () => undefined;

const collaborator = (id: string, overrides: Partial<CollabUser> = {}): CollabUser => ({
  id,
  name: `Producer ${id}`,
  color: '#00ff00',
  avatar: id.slice(0, 1).toUpperCase(),
  role: 'Producer',
  status: 'editing',
  lastActive: 'Now',
  ...overrides,
});

const note = (id: string, overrides: Partial<CollabComment> = {}): CollabComment => ({
  id,
  author: 'You',
  avatarColor: '#ff6e00',
  timestamp: 1700000000000,
  barPosition: 4,
  text: `project note ${id}`,
  resolved: false,
  ...overrides,
});

const render = (comments: CollabComment[], collaborators: CollabUser[]): string =>
  renderToStaticMarkup(
    React.createElement(CollaborationModal, {
      isOpen: true,
      onClose: noop,
      comments,
      collaborators,
      onAddComment: noop,
      onToggleResolveComment: noop,
    }),
  );

/** Visible text with tags stripped and the entities JSX emits decoded. */
const visibleText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const APP_SOURCE = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

describe('Phase 70 F2 — the collaboration panel renders project data only', () => {
  it('shows the persisted collaborators and derives the count from the project array', () => {
    const text = visibleText(render([], [collaborator('u-1', { name: 'Ada Session', role: 'Mixing Engineer' }), collaborator('u-2', { name: 'Bo Takes', role: 'Vocalist' })]));

    assert.ok(text.includes('Ada Session'), 'the first persisted collaborator must be listed');
    assert.ok(text.includes('Bo Takes'), 'the second persisted collaborator must be listed');
    assert.ok(text.includes('Mixing Engineer'), 'the stored role is real project data and stays visible');
    assert.ok(text.includes('(2)'), `the count must come from the project array (rendered: ${text})`);
  });

  it('never invents the removed demo producers', () => {
    const text = visibleText(render([], [collaborator('u-1', { name: 'Ada Session' })]));

    for (const demo of ['Maya Beats', 'Liam Vocal', 'Alex (You)']) {
      assert.ok(!text.includes(demo), `"${demo}" must not appear unless it is project data`);
    }
  });

  it('shows the persisted notes and hides notes that are not in the project', () => {
    const text = visibleText(render([note('c-1', { author: 'Ada Session', barPosition: 9, text: 'Check the vocal comp here' })], []));

    assert.ok(text.includes('Ada Session'));
    assert.ok(text.includes('Check the vocal comp here'));
    assert.ok(text.includes('BAR 9'), 'the stored bar position is rendered');
    assert.ok(!text.includes('Hook vocal drop starts here at Bar 9.'), 'the removed demo note must not appear');
    assert.ok(!text.includes('The 808 sub bass needs a tight sidechain ducking on kick hit.'), 'the removed demo note must not appear');
  });

  it('presents an empty project as empty — no producers, no notes, no session claim', () => {
    const text = visibleText(render([], []));

    assert.ok(!text.includes('Producers'), `an empty project must not report producers (rendered: ${text})`);
    assert.ok(!/online studio session/i.test(text), 'an empty project must not claim an online session');
    assert.ok(!/\bONLINE\b/.test(text), 'no collaborator can be reported online');
    assert.ok(!/\bIDLE\b/.test(text), 'no collaborator can be reported idle');
    assert.ok(!text.includes('animate-pulse'), 'the HTML must not contain a presence pulse marker');
    assert.ok(text.includes('(0)'), 'both lists must report their real empty count');
  });

  it('does not turn a stored status field into a live presence claim', () => {
    const html = render([], [collaborator('u-live', { name: 'Stored Status', status: 'online', lastActive: '1m ago' })]);
    const text = visibleText(html);

    assert.ok(text.includes('Stored Status'), 'the stored collaborator is still listed');
    assert.ok(!/\bONLINE\b/.test(html), 'a stored status is not authoritative presence');
    assert.ok(!/\bIDLE\b/.test(html), 'a stored status is not authoritative presence');
    assert.ok(!html.includes('animate-pulse'), 'no live presence indicator may be rendered');
  });

  it('counts exactly the collaborators the project holds', () => {
    const three = [collaborator('u-1'), collaborator('u-2'), collaborator('u-3')];
    const text = visibleText(render([], three));

    assert.ok(text.includes('(3)'), `three stored collaborators must render as three (rendered: ${text})`);
    assert.ok(text.includes('Producer u-1') && text.includes('Producer u-3'));
  });

  it('keeps the truthful local-storage copy', () => {
    const text = visibleText(render([], []));

    assert.ok(
      text.includes('Comments and collaborator data are stored in this project. No live network sync is active.'),
      'the modal must keep telling the truth about where the data lives',
    );
  });
});

describe('Phase 70 F2 — App has a single source of truth for collaboration data', () => {
  it('keeps no component-local collaboration collections', () => {
    assert.ok(!/useState<\s*CollabComment/.test(APP_SOURCE), 'App must not own a private comment store');
    assert.ok(!/useState<\s*CollabUser/.test(APP_SOURCE), 'App must not own a private collaborator store');
  });

  it('carries no hard-coded demo people or notes', () => {
    for (const demo of ['Maya Beats', 'Liam Vocal', 'Alex (You)']) {
      assert.ok(!APP_SOURCE.includes(demo), `App must not ship the demo value "${demo}"`);
    }
  });

  it('feeds the panel from the project document', () => {
    assert.ok(APP_SOURCE.includes('projectState.comments'), 'App must read notes from ProjectState');
    assert.ok(APP_SOURCE.includes('projectState.collaborators'), 'App must read collaborators from ProjectState');
    assert.ok(
      APP_SOURCE.includes('addCollabCommentInProjectState') && APP_SOURCE.includes('toggleCollabCommentResolvedInProjectState'),
      'App must mutate notes through the project mutation path',
    );
  });

  it('renders a project document that starts with no collaboration data', () => {
    const defaults = createDefaultProjectState();
    assert.deepEqual(defaults.comments, []);
    assert.deepEqual(defaults.collaborators, []);
  });
});
