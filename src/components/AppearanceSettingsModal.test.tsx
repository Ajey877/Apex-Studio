import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppearanceSettingsModal } from './AppearanceSettingsModal';

test('Appearance settings exposes an accessible keyboard-operable theme group', () => {
  const html = renderToStaticMarkup(
    <AppearanceSettingsModal isOpen mode="dark" onChange={() => undefined} onClose={() => undefined} />,
  );
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /role="radiogroup" aria-label="Color theme"/);
  assert.match(html, /type="radio"[^>]*name="theme-mode"[^>]*value="dark"/);
  assert.match(html, /type="radio"[^>]*name="theme-mode"[^>]*value="light"/);
  assert.match(html, /focus-within:ring/);
  assert.match(html, /aria-label="Close Settings"/);
});

test('Appearance settings reports the selected mode through checked radio state', () => {
  const html = renderToStaticMarkup(
    <AppearanceSettingsModal isOpen mode="light" onChange={() => undefined} onClose={() => undefined} />,
  );
  assert.match(html, /value="light"[^>]*checked=""|checked=""[^>]*value="light"/);
  assert.doesNotMatch(html, /value="dark"[^>]*checked=""|checked=""[^>]*value="dark"/);
});
