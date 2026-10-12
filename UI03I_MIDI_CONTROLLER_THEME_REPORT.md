# UI-03I — MIDI Controller Light/Dark Theme Migration

Scope: `MidiControllerModal` only, one modal per PR. This continues the UI-03 per-component migration pattern: semantic tokens for UI chrome and MIDI status colors, with user/instrument identity colors preserved.

Not in scope: `MidiLearnModal` (a separate planned modal), global CSS or token changes, MIDI/audio engine behavior, persistence, any other modal, or the unplanned `ProjectBundleZipModal`.

Baseline: `main` at `f9ff0e67da34361a39a2f02054c333f3ecc58491`, the merge commit for PR #214 (UI-03H — Vocal Tuner). PR #214 is `MERGED` at `2026-10-12T17:26:57Z`, and the fixed session branch was clean and identical to `main` before implementation.

## Before implementation: audit

`MidiControllerModal.tsx` had approximately 131 legacy palette references in markup, including dark-only panel/table/key surfaces, white text utilities, orange selection/CTA colors, and literal MIDI-state colors. The `bg-black/80` overlay was redundant: `ModalFrame` already prepends `apex-modal-overlay`, whose background is `--apex-modal-overlay` in both themes.

The modal has no canvas. Its chrome is rendered as DOM classes, so it needs no palette seam or theme observer. The MIDI device listener and mapping flow are independent of theme; the important behavior to preserve includes listener add/remove, CC learn capture, mapping removal, quick-arm targets, octave bounds, and virtual-note dispatch.

The eight MPC-pad colors are instrument identities, not chrome. The note-on, note-off, CC, and other-event colors are MIDI state categories and must remain semantically distinct.

## What changed

1. **`src/components/MidiControllerModal.tsx`.** Neutral panel, header, table, button, key, border, hover, and text classes now use existing `--apex-*` tokens. The modal no longer carries fixed dark surfaces, fixed white/black text, Tailwind palette colors, or a hardcoded black scrim.
   - Panel/header/table surfaces use `--apex-surface`, `--apex-panel-header`, `--apex-surface-2`, `--apex-surface-3`, `--apex-canvas`, and `--apex-chrome-inset` as appropriate.
   - UI selection and CTA states use `--apex-state-selected`, `--apex-state-selected-border`, `--apex-accent`, `--apex-accent-strong`, and `--apex-state-playing-fg`.
   - Genuine ready/active indicators remain green through `--apex-success`; the static “Web MIDI Studio” capability badge uses cyan so green remains reserved for live status.
   - Live MIDI event badges retain their meanings: note-on → success, note-off → danger, CC → cyan, and other events → gold. The small CC readout uses `--apex-cyan-text` for Light-theme legibility.
   - The virtual keyboard’s structural natural-key surface now uses `--apex-piano-key-natural`; pressing a key uses the existing playing-state tokens.
   - All eight MPC-pad identity colors remain byte-for-byte unchanged and are still applied from each pad’s `color` data. MIDI event fields, target-channel identity, and mapping values remain untouched.
   - The dead `bg-black/80` class is removed. `ModalFrame` continues to supply the themed scrim; the blur/layout classes and dialog IDs are preserved.
   - No handler, state, MIDI listener, audio call, interaction, copy, or accessibility wiring changed. A source-level comparison with baseline, after removing className values and JSX comments, confirms the non-chrome component code is unchanged.
2. **`src/state/modalDialogShell.test.tsx`.** The MIDI Controller’s exact overlay-class expectation now excludes the dead black fill and documents the shared ModalFrame scrim. A now-stale UI-03G comment referring to the MIDI Controller as untouched is corrected; other modal contracts are unchanged.
3. **`src/components/midiControllerThemeUi.test.tsx` (new).** Eight focused unit tests cover dialog rendering and accessibility, tokenized classes, shared scrim, preserved MPC identities, semantic MIDI event categories, listener/learn/mapping/virtual-note wiring, zero non-identity color literals, and closed-state rendering.
4. **`browser-tests/midiControllerTheme.spec.ts` (new).** Two real Chromium tests exercise Dark and Light: themed panel/header/scrim and active-tab/status colors, text contrast, MIDI Learn quick-arm/cancel, unchanged MPC pad identity color, theme-aware virtual keys, the traffic-monitor empty state, and close behavior.
5. **`package.json`.** The new unit test is included in `test:history` so the repository test-discovery guard covers it.
6. **`UI03A_THEME_FOUNDATION_REPORT.md`.** The obsolete “remaining 24 bodies” wording is identified as a UI-03B snapshot, merged UI-03B–H work is recorded, and the verified planned modal order is maintained. UI-03I is explicitly not marked as merged.

## Validation

| Check | Result |
| --- | --- |
| Focused unit + shared modal-shell tests | **36/36 pass** (8 UI-03I + 28 modal-shell) |
| `npm run verify:test-discovery` | **Pass** — 233 test files, 0 orphaned |
| `npm run lint` | **Pass** — `tsc --noEmit` |
| `npm run test:history` | **Pass** — 912/912 tests; includes the new UI-03I unit suite and shared modal-shell checks |
| `npm run build` | **Pass** — 1,831 modules transformed |
| Production CSS token check | **Pass** — panel, selection, success, natural-key, border, text, and alert token utilities are emitted |
| `npx playwright test browser-tests/midiControllerTheme.spec.ts` | **Pass** — 2/2 tests, Chromium 153 (Dark + Light) |
| Git whitespace check | **Pass** — `git diff --check` |
| GitHub CI | **Pass** — Apex Studio CI (`verify`), Audio Validation (`audio-tests`), Desktop Validation (`windows-package`), and CodeRabbit. The final PR-head check is also reported in the session summary. |

The production build retains the repository’s existing Vite notice that the main JavaScript chunk is larger than 500 kB after minification; this migration does not change application architecture or chunking.

## Known limitations

- A physical MIDI controller was not available in the sandbox. Browser coverage verifies the no-device state, MIDI Learn UI, quick-arm/cancel flow, virtual-key rendering, and preserved MIDI state mapping; the existing MIDI runtime tests and untouched handler paths remain the behavior contract.
- MPC-pad identity hues intentionally remain data colors and are not remapped by theme. Their exact colors are regression-tested; the theme migration changes only surrounding chrome.
- The task is not marked complete on `main` until the PR is reviewed and merged. The final GitHub CI result and exact PR head are recorded in the session summary.

## Remaining planned UI-03 modal order

1. `MidiControllerModal` — UI-03I — implementation and local validation complete; PR CI passes; awaiting review/merge.
2. `GrossBeatModal`
3. `ArpeggiatorModal`
4. `MidiLearnModal`
5. `MasterMacroRackModal`
6. `MultiZoneSamplerModal`
7. `PolyphonicEditorModal`
8. `SidechainRoutingModal`
9. `TakeCompingModal`
10. `WarpAudioProcessorModal`
11. `CollaborationModal`
12. `HotkeysModal`
13. `AnalyticsModal`
14. `OrientationLockModal`
15. `DesktopAppModal`

The remaining order follows the verified UI-03 plan. Completed migrations and adequately themed modals are excluded; no additional unplanned modal is added to this phase.
