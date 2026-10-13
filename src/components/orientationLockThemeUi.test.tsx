/**
 * UI-03O — Orientation lock screen theme contract.
 *
 * `OrientationLockModal` is the one Batch-3 surface that is **not** a
 * `ModalFrame` dialog: it is a full-screen page state that self-detects
 * (`innerHeight > innerWidth` and touch-or-narrow) inside an effect, and the
 * shared shell suite pins that it keeps no dialog semantics and never adopts the
 * frame. Its visible markup is therefore produced only after an effect has run,
 * and this repository's unit suites have no DOM to run one in — the rendered
 * Light/Dark state is covered by `browser-tests/orientationLockTheme.spec.ts`
 * against the real Vite application at a portrait viewport.
 *
 * What this suite *can* pin without a DOM, and does:
 *
 *   - every `className` in the file resolves through the existing `--apex-*`
 *     tokens, with no literal, fixed palette utility or named-palette class;
 *   - the accent identity of the illustration and CTAs, and the semantic meter
 *     bars, are mapped onto the same tokens the UI-1C compatibility layer already
 *     resolved the legacy literals to;
 *   - the detection predicate, both dismiss paths, the effect's listener
 *     registration and cleanup, the overlay id and the accessible name are
 *     byte-for-byte unchanged;
 *   - the pre-effect (server) render stays empty, because the lock screen must
 *     never paint for a state the device has not reported yet.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrientationLockModal } from './OrientationLockModal';

const source = readFileSync('src/components/OrientationLockModal.tsx', 'utf8');

const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const classAttributes = (text: string): string[] => [
  ...[...text.matchAll(/className="([^"]*)"/g)].map((match) => match[1]),
  ...[...text.matchAll(/className=\{`([^`]*)`\}/g)].map((match) => match[1])
];

const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const includes = (haystack: string, needle: string, message: string): void => assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

/** The component reads screen geometry while rendering after its early return. */
const withWindowStub = <T,>(run: () => T): T => {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = {
    innerWidth: 420,
    innerHeight: 900,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete holder.window;
    else holder.window = previous;
  }
};

describe('Orientation lock screen theme contract (UI-03O)', () => {
  it('themes every class in the file through the existing tokens', () => {
    const classes = classAttributes(source);
    assert.ok(classes.length >= 15, `the lock screen declares its surfaces (found ${classes.length})`);
    const offenders = classes.filter((value) => UNTHEMED_CLASS.test(value));
    assert.deepEqual(offenders, [], 'every className resolves through a semantic token');
  });

  it('keeps the near-opaque veil, the illustration identity and the meter meanings', () => {
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-bg\)_96%,transparent\)\]/,
      'the full-screen veil keeps its near-opaque character over the themed background'
    );
    assert.match(source, /backdrop-blur-xl/, 'the veil keeps its blur');
    assert.match(source, /from-\[color-mix\(in_srgb,var\(--apex-accent\)_16%,transparent\)\]/, 'the glow keeps an accent wash');
    assert.match(source, /bg-\[var\(--apex-accent\)\]/, 'the phone chrome, arrow badge and primary CTA keep the accent fill');
    // Measured in Chromium: accent-on-accent-wash is 4.10:1 in Light for the
    // 11px identity pill (Dark clears it at 5.18:1). The wash and edge carry the accent; the label uses the
    // primary text token (UI-03L precedent).
    assert.doesNotMatch(source, /rounded-full text-\[var\(--apex-accent\)\]/, 'the identity pill label does not sit on the accent tone');
    assert.match(
      source,
      /border-\[color-mix\(in_srgb,var\(--apex-accent\)_48%,transparent\)\] rounded-full text-\[var\(--apex-text\)\]/,
      'the identity pill label follows the primary text token',
    );
    assert.match(source, /hover:bg-\[var\(--apex-accent-strong\)\]/, 'the primary CTA keeps a themed hover step');
    assert.match(source, /border-\[var\(--apex-accent\)\]/, 'the phone body keeps its accent edge');
    assert.match(source, /bg-\[var\(--apex-success\)\]/, 'the meter keeps its green bar meaning');
    assert.match(source, /bg-\[var\(--apex-danger\)\]/, 'the meter keeps its red bar meaning');
    assert.match(source, /text-\[var\(--apex-state-playing-fg\)\]/, 'filled controls use a theme-safe on-colour');
  });

  it('uses the shared surface/text steps for the card chrome and the CTAs', () => {
    for (const token of ['--apex-surface-2', '--apex-surface-3', '--apex-border', '--apex-text', '--apex-text-2', '--apex-text-3']) {
      assert.ok(source.includes(`var(${token})`), `lock-screen chrome consumes ${token}`);
    }
    assert.doesNotMatch(code, /bg-black/, 'the dark-only veil literal is gone');
  });

  it('stays outside the dialog frame and keeps its detection and dismissal contract', () => {
    assert.equal(source.includes('ModalFrame'), false, 'the lock screen must not adopt the frame');
    assert.equal(source.includes('role="dialog"'), false, 'it gains no dialog semantics');
    assert.equal(source.includes('aria-modal'), false, 'it gains no modal state');
    includes(source, 'id="fl-orientation-lock-overlay"', 'the overlay id is unchanged');
    includes(source, 'title="Dismiss lock screen"', 'the dismiss control keeps its accessible name');
    includes(source, 'handleDismiss', 'the dismiss path is unchanged');
    includes(source, 'handleRequestFullscreenAndLandscape', 'the fullscreen/orientation request is unchanged');
    includes(source, "const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;", 'the touch detection is unchanged');
    includes(source, 'const isMobile = isTouch || window.innerWidth < 768;', 'the narrow-width detection is unchanged');
    includes(source, 'const portrait = window.innerHeight > window.innerWidth;', 'the portrait detection is unchanged');
    includes(source, 'if (!isPortrait || dismissed || !isMobileDevice)', 'the visibility predicate is unchanged');
    includes(source, "window.addEventListener('resize', checkOrientation);", 'the resize listener is unchanged');
    includes(source, "window.addEventListener('orientationchange', checkOrientation);", 'the orientation listener is unchanged');
    includes(source, "window.removeEventListener('resize', checkOrientation);", 'the resize cleanup is unchanged');
    includes(source, "window.removeEventListener('orientationchange', checkOrientation);", 'the orientation cleanup is unchanged');
    includes(source, 'await document.documentElement.requestFullscreen();', 'the fullscreen request is unchanged');
    includes(source, "await screen.orientation.lock('landscape').catch(() => {});", 'the orientation lock request is unchanged');
    includes(source, 'if (onForceDismiss) onForceDismiss();', 'the dismissal callback is unchanged');
    includes(source, 'if (!isPortrait || dismissed || !isMobileDevice) {\n    return null;\n  }', 'the early return is unchanged');
  });

  it('never paints the lock screen before the device has reported its orientation', () => {
    const rendered = withWindowStub(() =>
      renderToStaticMarkup(
        React.createElement(OrientationLockModal, {
          onForceDismiss: () => undefined
        })
      )
    );
    assert.equal(rendered, '', 'the pre-effect render stays empty rather than guessing a state');
  });
});
