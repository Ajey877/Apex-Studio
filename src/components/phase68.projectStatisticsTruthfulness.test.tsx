/**
 * Phase 68 — F4: the statistics modal reports real project state, or nothing.
 *
 * Phase 67 proved that the Project Statistics modal (Project menu -> Project
 * Statistics…) rendered a fabricated stopwatch — `meta.totalEditTimeSeconds || 1840`
 * meant a brand-new project, whose persisted edit time is exactly 0, displayed
 * "00:30:40" — plus a hard-coded engine version and an unconditional
 * "Offline Backup Status: Synchronized & Cached" with no backup state behind it.
 *
 * The modal is rendered here through the same `renderToStaticMarkup` path the
 * repository's modal shell suite uses, with a real `createDefaultProjectState()`
 * document, so the assertions are about what a user sees. The backup row's async
 * states are pinned on the exported `describeOfflineBackupStatus()` contract,
 * which is what the rendered row prints.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnalyticsModal, describeOfflineBackupStatus } from './AnalyticsModal';
import { createDefaultProjectState } from '../state/projectState';
import type { ProjectBackupSummary } from '../state/projectBackup';
import type { ProjectMetadata } from '../types/daw';

const noop = () => undefined;

const renderModal = (meta: ProjectMetadata, saveError?: string | null): string => {
  const project = createDefaultProjectState();
  return renderToStaticMarkup(
    React.createElement(AnalyticsModal, {
      isOpen: true,
      onClose: noop,
      meta,
      channels: project.channels,
      clips: project.playlistClips,
      saveError,
    }),
  );
};

const backup = (createdAt: number): ProjectBackupSummary => ({
  id: `backup-${createdAt}`,
  name: 'Untitled Session',
  reason: 'replace',
  createdAt,
  channelCount: 2,
  clipCount: 1,
  recordingCount: 0,
  audioIds: [],
});

describe('Phase 68 F4 — recorded session time is the persisted value', () => {
  it('never invents half an hour for a project that has never recorded edit time', () => {
    const project = createDefaultProjectState();
    assert.equal(project.meta.totalEditTimeSeconds, 0, 'a new project starts at zero');

    const html = renderModal(project.meta);

    assert.ok(!html.includes('00:30:40'), 'the fabricated 1840-second stopwatch must be gone');
    assert.ok(!html.includes('1840'), 'no fabricated fallback may reach the markup');
    // The banner is relabelled from the old live-stopwatch wording: the number
    // below it is the recorded total, not a timer the modal keeps running.
    assert.match(html, /Recorded Studio Session Time/, 'the banner itself stays in the layout');
    assert.match(html, /Not recorded/, 'an unmeasured metric says so explicitly');
  });

  it('renders a persisted non-zero edit time exactly', () => {
    const meta = { ...createDefaultProjectState().meta, totalEditTimeSeconds: 3840 };
    const html = renderModal(meta);

    assert.match(html, /01:04:00/, 'the persisted value is what the user sees');
    assert.ok(!html.includes('Not recorded'), 'a measured value is not marked unrecorded');
  });
});

describe('Phase 68 F4 — engine version comes from the project document', () => {
  it('prints the project version instead of a hard-coded engine string', () => {
    const meta = { ...createDefaultProjectState().meta, version: '9.9.9 Test' };
    const html = renderModal(meta);

    assert.match(html, /v9\.9\.9 Test/, 'the project document owns this value');
    assert.ok(!html.includes('v4.5.2 Pro Low-Latency Core'), 'the hard-coded engine claim must be gone');
  });
});

describe('Phase 68 F4 — the backup row reports real persistence state', () => {
  it('does not claim a synchronized cache before any backup state is known', () => {
    const html = renderModal(createDefaultProjectState().meta);

    // `renderToStaticMarkup` escapes `&` to `&amp;`, so the claim is matched as
    // text: any synchronization wording is the fabricated copy returning.
    assert.ok(!/Synchronized|Cached/i.test(html), 'the unconditional claim must be gone');
    assert.match(html, /Checking offline backups/, 'the row states what it is actually doing');
  });

  it('surfaces a real save failure in the backup row', () => {
    const html = renderModal(createDefaultProjectState().meta, 'Quota exceeded');

    assert.match(html, /Save failed/, 'a failed write is the safety-critical truth');
    assert.match(html, /Quota exceeded/, 'the real error text reaches the user');
    assert.ok(!/Synchronized|Cached/i.test(html));
  });

  it('describes every real backup state without a fabricated claim', () => {
    assert.equal(
      describeOfflineBackupStatus({ loading: true }),
      'Checking offline backups…',
    );
    assert.equal(
      describeOfflineBackupStatus({ loading: false, backups: [] }),
      'No offline backup yet',
    );
    assert.equal(
      describeOfflineBackupStatus({ loading: false, backups: [backup(1_700_000_000_000)] }),
      `1 offline backup · newest ${new Date(1_700_000_000_000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`,
    );
    assert.match(
      describeOfflineBackupStatus({ loading: false, backups: [backup(1), backup(2), backup(3)] }),
      /^3 offline backups · newest /,
    );
    assert.equal(
      describeOfflineBackupStatus({ loading: false, error: 'IndexedDB unavailable' }),
      'Unavailable — IndexedDB unavailable',
    );
    assert.equal(
      describeOfflineBackupStatus({ loading: false, backups: [backup(1)], saveError: 'Quota exceeded' }),
      'Save failed — Quota exceeded',
      'a failed save outranks a stale backup listing',
    );
    for (const state of [
      { loading: true },
      { loading: false, backups: [] as ProjectBackupSummary[] },
      { loading: false, backups: [backup(1)] },
      { loading: false, error: 'unavailable' },
      { loading: false, saveError: 'failed' },
    ]) {
      assert.ok(!/Synchronized|Cached/i.test(describeOfflineBackupStatus(state)));
    }
  });
});

describe('Phase 68 F4 — the fabricated literals cannot come back', () => {
  it('leaves no hard-coded session time or backup claim in the modal source', () => {
    const source = readFileSync(new URL('./AnalyticsModal.tsx', import.meta.url), 'utf8');

    // The backup claim itself is pinned by the rendered markup and by the
    // exhaustive `describeOfflineBackupStatus` state matrix above; these two
    // literals have no legitimate reason to appear in this component at all.
    assert.ok(!source.includes('1840'), 'the 30:40 fallback must not return');
    assert.ok(!source.includes('Low-Latency Core'), 'the hard-coded engine claim must not return');
  });
});
