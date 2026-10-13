/**
 * UI-03O — Collaboration modal theme contract.
 *
 * `CollaborationModal` is DOM-rendered with no canvas, so every chrome surface
 * follows the active palette through the existing `--apex-*` tokens; no palette
 * seam or theme observer is required.
 *
 * Two colour families are deliberately treated differently:
 *
 *   - **Chrome and identity** (panel, header band, cards, inset wells, borders,
 *     text steps, hover, and the accent tile / CTAs / BAR chip) resolves through
 *     semantic tokens. The notes identity stays on `--apex-accent`, which is the
 *     token the UI-1C compatibility layer already resolved these `#ff6e00`
 *     literals to, so the rendered identity hue is unchanged.
 *   - **The collaborator avatar's `text-black`** is the on-colour that belongs to
 *     the *stored* `CollabUser.color` painted behind it (`style`,
 *     `backgroundColor: user.color`), the same category UI-03A preserves for
 *     `ch.color` and `PAD_COLORS`. It is not theme chrome: swapping it for a
 *     theme on-colour would make a light stored colour unreadable in one of the
 *     two palettes. It therefore survives as the single fixed utility left in
 *     this file, and it is pinned here as exactly that one occurrence.
 *
 * The Phase 70 truthfulness contract (project data only, no invented people or
 * presence) is owned by `phase70.collaborationTruth.test.tsx`; this file pins the
 * presentation contract plus the wiring the modal itself owns.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CollaborationModal } from './CollaborationModal';
import type { CollabComment, CollabUser } from '../types/daw';

const source = readFileSync('src/components/CollaborationModal.tsx', 'utf8');

/** Source with comments stripped, so prose *about* a literal can neither satisfy
    nor trip the literal assertions. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const noop = (): void => {};

const collaborator = (id: string, overrides: Partial<CollabUser> = {}): CollabUser => ({
  id,
  name: `Producer ${id}`,
  color: '#ff6e00',
  avatar: id.slice(0, 1).toUpperCase(),
  role: 'Producer',
  status: 'editing',
  lastActive: 'Now',
  ...overrides
});

const note = (id: string, overrides: Partial<CollabComment> = {}): CollabComment => ({
  id,
  author: 'You',
  avatarColor: '#ff6e00',
  timestamp: 1700000000000,
  barPosition: 4,
  text: `project note ${id}`,
  resolved: false,
  ...overrides
});

const collaborators = [
  collaborator('u-1', {
    name: 'Ada Session',
    role: 'Mixing Engineer',
    avatar: 'A'
  }),
  collaborator('u-2', { name: 'Bo Takes', role: 'Vocalist', avatar: 'B' })
];
const comments = [
  note('c-1', {
    author: 'Ada Session',
    barPosition: 9,
    text: 'Check the vocal comp here'
  }),
  note('c-2', {
    author: 'Bo Takes',
    barPosition: 12,
    text: 'Resolved note',
    resolved: true
  })
];

const render = (
  mode: 'dark' | 'light',
  overrides: {
    isOpen?: boolean;
    collaborators?: CollabUser[];
    comments?: CollabComment[];
  } = {}
): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(CollaborationModal, {
        isOpen: overrides.isOpen ?? true,
        onClose: noop,
        comments: overrides.comments ?? comments,
        collaborators: overrides.collaborators ?? collaborators,
        onAddComment: noop,
        onToggleResolveComment: noop
      })
    )
  );

const classAttributes = (markup: string): string[] => [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** Any colour that cannot follow the theme: a literal, a fixed palette
    utility, or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

/** The one documented exception: the on-colour of the data-driven avatar. */
const DATA_COUPLED_AVATAR_CLASS = 'w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-black shadow-sm';

const includes = (haystack: string, needle: string, message: string): void => assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Collaboration modal theme markup (UI-03O)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the notes workspace with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="collab-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="collab-modal-title"', 'the dialog is named by its title');
      includes(markup, 'STUDIO NOTES &amp; COLLABORATION', 'the title text is unchanged');
      includes(markup, 'Local project notes &amp; collaboration workspace', 'the subtitle is unchanged');
      includes(markup, 'aria-label="Close collaboration"', 'the close control keeps its accessible name');
      includes(
        markup,
        'Comments and collaborator data are stored in this project. No live network sync is active.',
        'the truthful local-storage copy is unchanged'
      );
      includes(markup, 'Project Collaborators (2)', 'the collaborator count comes from the project array');
      includes(markup, 'Timeline Mix Feedback &amp; Annotations (2)', 'the note count comes from the project array');
      includes(markup, 'Ada Session', 'stored collaborators are listed');
      includes(markup, 'Mixing Engineer', 'the stored role is listed');
      includes(markup, 'BAR 9', 'the stored bar position is rendered');
      includes(markup, 'BAR 12', 'the resolved note keeps its bar position');
      includes(markup, 'MARK RESOLVED', 'the unresolved action renders');
      includes(markup, '>RESOLVED<', 'the resolved state renders');
      includes(markup, 'Leave Studio Note at Bar:', 'the composer label is unchanged');
      includes(markup, 'placeholder="e.g. Add sidechain compression on the 808 sub here..."', 'the placeholder is unchanged');
      includes(markup, 'COPY APP LINK', 'the share action renders');
      includes(markup, '>POST<', 'the composer action renders');
      assert.equal([...markup.matchAll(/<option /g)].length, 16, 'the bar selector still offers bars 1-16');
      includes(markup, '<option value="4" selected="">Bar 4</option>', 'the selector opens on bar 4');
    });
  }

  it('carries no fixed chrome palette, with the data-coupled avatar as the only exception', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const state of [
        render(mode),
        render(mode, { collaborators: [], comments: [] }),
        render(mode, {
          comments: [comments[0]],
          collaborators: [collaborators[0]]
        })
      ]) {
        const offenders = classAttributes(state).filter((value) => UNTHEMED_CLASS.test(value));
        assert.ok(
          offenders.every((value) => value === DATA_COUPLED_AVATAR_CLASS),
          `${mode} renders an unthemed class outside the documented avatar on-colour: ${JSON.stringify(offenders)}`
        );
      }
    }
  });

  it('uses existing semantic tokens for surfaces, text, borders and hover', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-panel-header',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover',
      '--apex-state-playing-fg'
    ]) {
      assert.ok(source.includes(`var(${token})`), `collaboration chrome consumes ${token}`);
    }
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('keeps the accent identity and the resolve-status meaning', () => {
    assert.match(source, /bg-\[var\(--apex-accent\)\]/, 'the share and post CTAs use the accent token');
    assert.match(source, /text-\[var\(--apex-accent\)\]/, 'the identity glyph, bar chip and selector keep the accent');
    assert.match(source, /bg-\[color-mix\(in_srgb,var\(--apex-accent\)_16%,transparent\)\]/, 'the identity tile keeps an accent wash');
    assert.match(source, /border-\[color-mix\(in_srgb,var\(--apex-accent\)_48%,transparent\)\]/, 'the identity tile keeps an accent edge');
    assert.match(source, /hover:bg-\[var\(--apex-accent-strong\)\]/, 'the accent CTAs keep a themed hover step');
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-success\)_20%,transparent\)\]/,
      'the unresolved action keeps a success wash instead of a raw neon literal'
    );
    // Measured in Chromium: success-on-success-wash is 4.08:1 (Light, resting)
    // and 4.33:1 (Dark, hover wash) — below the 4.5:1 floor for the 9px bold
    // label. The wash carries the green meaning; the label uses the text token.
    assert.doesNotMatch(source, /text-\[var\(--apex-success\)\]/, 'the resolve label does not sit on the success tone');
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-success\)_20%,transparent\)\] text-\[var\(--apex-text\)\]/,
      'the unresolved action label follows the primary text token'
    );
  });

  it('keeps exactly one fixed utility, and only as the stored avatar on-colour', () => {
    assert.equal((code.match(/text-black/g) ?? []).length, 1, 'the only fixed black utility is the stored avatar on-colour');
    const avatarBlock = code.slice(code.indexOf('rounded-full flex items-center justify-center'), code.indexOf('{user.avatar}'));
    assert.ok(avatarBlock.includes('text-black'), 'the on-colour sits on the data-painted avatar');
    assert.ok(avatarBlock.includes('backgroundColor: user.color'), 'the avatar background stays the stored project colour');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-sm z-50 flex items-center justify-center p-4"/,
      'the shared themed scrim replaces the dead bg-black/85 fill'
    );
  });

  it('keeps the composer, selector and resolve wiring intact', () => {
    assert.match(code, /onAddComment\(newCommentText\.trim\(\), targetBar\);/, 'POST publishes the trimmed note and bar');
    assert.match(code, /setNewCommentText\(''\);/, 'POST clears the composer');
    assert.match(code, /onChange=\{\(e\) => setTargetBar\(Number\(e\.target\.value\)\)\}/, 'the bar selector still parses its value');
    assert.match(code, /onClick=\{\(\) => onToggleResolveComment\(comment\.id\)\}/, 'the resolve action still routes the note id');
    assert.match(code, /navigator\.clipboard\.writeText\(window\.location\.href\)/, 'the share action still copies the app URL');
    assert.match(code, /setTimeout\(\(\) => setCopiedLink\(false\), 2000\)/, 'the copied state still self-clears');
    assert.match(code, /if \(!isOpen\) return null;/, 'the open guard is untouched');
  });

  it('renders the honest empty state when the project holds nothing', () => {
    const markup = render('light', { collaborators: [], comments: [] });
    includes(markup, 'No collaborators recorded in this project.', 'the empty collaborator note renders');
    includes(markup, 'No studio notes recorded in this project yet.', 'the empty note copy renders');
    includes(markup, 'Project Collaborators (0)', 'the empty count is real');
    includes(markup, 'Timeline Mix Feedback &amp; Annotations (0)', 'the empty note count is real');
    assert.doesNotMatch(markup, /ONLINE|IDLE/, 'no presence claim is rendered');
  });

  it('renders nothing while closed', () => {
    assert.equal(render('dark', { isOpen: false }), '<div data-theme="dark"></div>');
  });
});
