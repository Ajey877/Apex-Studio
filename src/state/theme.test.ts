import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_THEME, THEME_STORAGE_KEY, normalizeThemeMode } from './theme';

test('UI-03 defaults to the existing dark appearance', () => {
  assert.equal(DEFAULT_THEME, 'dark');
  assert.equal(normalizeThemeMode(undefined), 'dark');
  assert.equal(normalizeThemeMode('invalid'), 'dark');
});

test('UI-03 accepts only light and dark modes', () => {
  assert.equal(normalizeThemeMode('light'), 'light');
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(THEME_STORAGE_KEY, 'apex:theme');
});

test('theme preference is independent from project state', () => {
  assert.notEqual(THEME_STORAGE_KEY, 'projectState');
  assert.notEqual(THEME_STORAGE_KEY, 'apex:project');
});
