/**
 * UI-03Q — Project Replace Confirm residual scrim migration.
 * Unlike the framed dialogs, this standalone `alertdialog` had no
 * `apex-modal-overlay` class, so its `bg-black/80` was LIVE: near-black at
 * 80% in Light instead of the themed scrim (55% slate). It now carries the
 * shared primitive class directly — it still does not adopt ModalFrame
 * (pinned by modalDialogShell.test.tsx).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectReplaceConfirmModal } from './ProjectReplaceConfirmModal';
import type { ProjectReplacementPlan } from '../state/projectReplacement';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};
const plan: ProjectReplacementPlan = {
  requiresConfirmation: true, shouldBackup: true,
  currentName: 'Current Jam', incomingName: 'Incoming Demo',
  source: 'manifest-import', reason: 'current-has-work',
};
const render = (extra: Partial<{ backupError: string | null; error: string | null; isWorking: boolean }> = {}): string =>
  renderToStaticMarkup(
    React.createElement(ProjectReplaceConfirmModal, {
      plan, isWorking: extra.isWorking ?? false,
      backupError: extra.backupError ?? null, error: extra.error ?? null,
      onConfirm: noop, onCancel: noop,
    })
  );
const source = readFileSync('src/components/ProjectReplaceConfirmModal.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const luminance = ([r, g, b]: [number, number, number]): number => {
  const ch = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a: string, b: string): number => {
  const x = luminance(hexToRgb(a)); const y = luminance(hexToRgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Composite an rgba() scrim over a hex surface, returning hex. */
const composite = (rgba: string, hex: string): string => {
  const m = rgba.match(/rgba?\(([^)]+)\)/); assert.ok(m);
  const [r, g, b, a = 1]: number[] = m[1].split(',').map((s) => parseFloat(s));
  const bg = hexToRgb(hex);
  const out = [r, g, b].map((fg, i) => Math.round(fg * a + bg[i] * (1 - a)));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

describe('Project Replace Confirm residual theme migration (UI-03Q)', () => {
  it('renders the alertdialog contract and nothing without a plan', () => {
    const markup = render();
    assert.match(markup, /id="project-replace-confirm-modal"/);
    assert.match(markup, /role="alertdialog"/);
    assert.match(markup, /REPLACE CURRENT PROJECT\?/);
    assert.match(markup, /id="project-replace-confirm-btn"/);
    assert.match(markup, /id="project-replace-cancel-btn"/);
    assert.equal(renderToStaticMarkup(React.createElement(ProjectReplaceConfirmModal, {
      plan: null, isWorking: false, backupError: null, error: null, onConfirm: noop, onCancel: noop,
    })), '');
  });
  it('the scrim is the shared themed primitive, live in both themes', () => {
    const markup = render();
    const root = markup.slice(0, markup.indexOf('>') + 1);
    assert.ok(root.includes('apex-modal-overlay'), 'the standalone dialog carries the primitive class itself');
    assert.ok(!root.includes('bg-black'));
    assert.equal(/bg-black/.test(code), false);
    assert.equal(code.includes('ModalFrame'), false, 'still independent of the frame');
    // The two themes resolve different scrims, and each separates the panel.
    assert.notEqual(DARK_TOKENS['--apex-modal-overlay'], LIGHT_TOKENS['--apex-modal-overlay']);
    // Light: the white panel separates from the dimmed canvas by >= 3:1.
    // Dark: separation is by ordering (dimmed canvas darker than the app bg,
    // panel lighter than the dimmed canvas) plus the panel shadow/border.
    const lightDimmed = composite(LIGHT_TOKENS['--apex-modal-overlay'], LIGHT_TOKENS['--apex-bg']);
    assert.ok(contrast(LIGHT_TOKENS['--apex-surface'], lightDimmed) >= 3,
      `light panel vs dimmed canvas: ${contrast(LIGHT_TOKENS['--apex-surface'], lightDimmed).toFixed(2)}`);
    const darkDimmed = composite(DARK_TOKENS['--apex-modal-overlay'], DARK_TOKENS['--apex-bg']);
    assert.ok(luminance(hexToRgb(darkDimmed)) < luminance(hexToRgb(DARK_TOKENS['--apex-bg'])));
    assert.ok(luminance(hexToRgb(DARK_TOKENS['--apex-surface'])) > luminance(hexToRgb(darkDimmed)));
    // The rejected live literal: pure black at 80% over the Light canvas is
    // far darker than the themed Light scrim composited the same way.
    const rejected = composite('rgba(0, 0, 0, 0.8)', LIGHT_TOKENS['--apex-bg']);
    const adopted = composite(LIGHT_TOKENS['--apex-modal-overlay'], LIGHT_TOKENS['--apex-bg']);
    assert.ok(luminance(hexToRgb(rejected)) < luminance(hexToRgb(adopted)));
  });
  it('keeps the backup/error behaviour seams', () => {
    assert.match(render({ backupError: 'disk full' }), /id="project-replace-backup-error"/);
    assert.match(render({ backupError: 'disk full' }), /Retry Backup &amp; Replace|Retry Backup & Replace/);
    assert.match(render({ error: 'bad file' }), /id="project-replace-error"/);
    assert.match(render({ isWorking: true }), /Backing Up/);
  });
  it('title and body text clear AA on the panel in both themes', () => {
    for (const tokens of [DARK_TOKENS, LIGHT_TOKENS]) {
      assert.ok(contrast(tokens['--apex-text'], tokens['--apex-surface']) >= 4.5);
      assert.ok(contrast(tokens['--apex-text-2'], tokens['--apex-surface']) >= 4.5);
      assert.ok(contrast(tokens['--apex-state-playing-fg'], tokens['--apex-accent']) >= 4.5);
    }
  });
});
