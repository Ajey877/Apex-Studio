# UI-03L — MidiLearnModal Light/Dark Theme Migration

**Baseline:** `main` @ `1591432a830cf1419f09c22c244bcf8bd0610116` (PR #217, UI-03K ArpeggiatorModal, merged `2026-10-13T07:00:02Z`)
**Implementation branch:** `arena/0f0bf2b5-apex-studio` (Arena session-bound branch)
**Scope:** `MidiLearnModal` presentation only, its focused unit/browser coverage, the shared modal-shell expectation, test-suite discovery wiring, screenshot-artifact hygiene, and this report. No global CSS, no token definitions, no DSP, no MIDI semantics, no `ProjectState` implementation, and no other component changed.

## Recovery: state found before editing

This session was a recovery of an earlier run that died mid-task. The repository was inspected before any edit:

| Check | Finding |
| --- | --- |
| Branch / HEAD | `arena/0f0bf2b5-apex-studio` @ `1591432a830cf1419f09c22c244bcf8bd0610116`, working tree clean |
| Staged / unstaged / untracked | none |
| Remote branches | `origin/main` only; `origin/main` == HEAD |
| PR #217 (UI-03K ArpeggiatorModal) | `MERGED` at `2026-10-13T07:00:02Z`; merge commit == HEAD == `origin/main` |
| Existing UI-03L commits or PRs | none — `gh pr list --state all --search "UI-03L"` and `--search "MidiLearn"` both returned `[]` |
| `browser-tests/midiLearnTheme.spec.ts` | **did not exist** |
| `git stash list` / `git fsck --lost-found` | empty / no dangling objects |
| `git reflog --all` | only the clone and the branch creation |
| Commits touching `browser-tests/midiLearnTheme.spec.ts` | none in any ref |

**Conclusion: no recoverable implementation existed.** The previous session's repeated edits to `browser-tests/midiLearnTheme.spec.ts` were never committed, stashed, or pushed, and the clone is shallow (depth 1), so nothing was retrievable. UI-03L was therefore implemented from the verified `main` above. No patch was reconstructed from the prior session and no unverified test result from it was reused.

## Before implementation: audit

`MidiLearnModal.tsx` carried **74 hardcoded palette references** in the UI-03A inventory. It is DOM-rendered with no canvas, so the existing `--apex-*` tokens can theme every surface directly; no palette seam or theme observer is required. It already renders inside `ModalFrame`, so the framing dialog receives the shared themed scrim and the modal's own dark fill was redundant.

Several literals in use were **not covered** by the `index.css` compatibility layer at all, which is why the modal rendered as a dark body under Light:

- `bg-[#18181b]` (header, footer, cards, mapping rows) — the layer maps `#18181c`, not `#18181b`
- `border-[#2e2e32]`, `border-[#28282b]`, `border-[#333338]` — the layer maps `#2e2e34`, `#28282e`, `#333336`
- `text-[#aaa]` — unmapped
- the `from-[#ff6e00] to-[#ffaa00]` brand gradient — `from-*`/`to-*` are not remapped at all
- `hover:bg-[#333338]`, `text-white`, `text-black`, `text-red-400`, `hover:text-red-300` — unmapped

Three color families carry meaning and keep it in both themes:

- **The MIDI Learn accent** (armed badge, learn banner, arm toggle, primary bind CTA, CC identity chip, status toast) resolves through `--apex-accent` with the `--apex-state-playing-fg` on-colour. This is the same mapping the sibling `MidiControllerModal` MIDI Learn tab uses, and the same one the compatibility layer already resolved the legacy orange to here — so the migration keeps the two MIDI surfaces consistent and does not change what Dark renders for those literals.
- **Connected-hardware readiness** stays green through `--apex-success`, and is used *only* for a genuinely connected controller. The idle "WebMIDI ready" hint deliberately does not use it.
- **Destructive clear/delete** stays red through `--apex-danger`, replacing unmapped Tailwind `red-400`/`red-300`.

## What changed

1. **`src/components/MidiLearnModal.tsx`** — presentation only.
   - Panel, header/footer bands, hardware and quick-bind cards, mapping rows, the empty state, form controls, borders, hover states and the neutral text scale now use existing semantic tokens (`--apex-surface`, `--apex-panel-header`, `--apex-surface-2`, `--apex-surface-3`, `--apex-canvas`, `--apex-border`, `--apex-text`/`-2`/`-3`, `--apex-state-hover`).
   - Form controls follow the convention the other migrated modals use: `--apex-canvas` inset, `--apex-text` value, `--apex-border` edge. Nothing suppresses the global `focus-visible` ring.
   - The armed badge, learn banner and arm toggle carry the accent identity through a `color-mix` accent wash, accent border and the existing pulse; the primary bind CTA and status toast use a solid accent fill with `--apex-state-playing-fg`.
   - The CC identity chip moved to `--apex-surface-3`, which preserves the original recessed-chip-inside-row relationship in both themes and keeps a plain-hex token (a `color-mix` inset serializes differently across Chromium versions).
   - The brand gradient chip became a solid accent chip with a theme-safe icon colour; the dead `bg-black/85` scrim fill was removed, leaving ModalFrame's shared `--apex-modal-overlay` scrim and the existing blur, stacking and layout.
   - The icon-only per-row delete control gained an accessible name (`Remove MIDI CC {n} binding`). It previously had none.
   - **No fixed hex color, `rgb()`/`rgba()` literal, white/black palette utility, or Tailwind named-palette color remains anywhere in the file.**
2. **`src/components/midiLearnThemeUi.test.tsx` (new)** — nine focused tests: complete Dark/Light markup and dialog accessibility, semantic token classes across **eight rendered states** (both themes × idle/armed/with-device/empty), the shared ModalFrame scrim, the accent/success/danger meanings, accessible names and labelled form controls, the MIDI learn capture and binding behaviour, zero color literals, and the closed state. Added to `test:history`.
3. **`browser-tests/midiLearnTheme.spec.ts` (new)** — two **real Chromium** cases (Dark and Light) against the running Vite application. Every expected color was read from `getComputedStyle` on the live app rather than guessed. Covers themed panel/header/footer/scrim, cards, insets, form controls and borders; WCAG AA contrast on the title, subtitle, section labels, field labels, footer note, idle and armed toggles, banner text, bind CTA, status toast, CC chip, binding name/target text and Clear All; WCAG 1.4.11 3:1 non-text contrast on the banner icon and the icon-only delete control; the arm → LEARN ACTIVE → disarm selection cycle; the manual CC bind flow (2 → 3 bindings, toast, chip); per-row delete; focus rings on the CC input and on the Bind CC control reached by Tab; Escape; and state persistence across close/reopen.
4. **`src/state/modalDialogShell.test.tsx`** — only the MIDI Learn entry's expected overlay classes, to pin ModalFrame's shared scrim and drop the dead black fill. `OVERLAY_STUDIO` is unchanged and still used by eight other modals.
5. **`package.json`** — adds the new unit suite to `test:history`.
6. **`.gitignore`** — adds `test-results/`. `playwright-report/` was already ignored; running the browser suites writes Playwright traces and error contexts to `test-results/`, which would otherwise leak local artifacts into a diff.
7. **`UI03A_THEME_FOUNDATION_REPORT.md`** — records merged UI-03K and the in-progress UI-03L review status, and advances the planned modal order. The historical "largest offenders" table is left as the UI-03B snapshot, matching how UI-03B–K were recorded.

### Behavior explicitly untouched

Verified mechanically, not by inspection alone: the baseline and migrated sources were normalised by stripping JSX/line comments and blanking every `className` value, then diffed. **The only non-presentation difference in the whole file is the added `aria-label` on the icon-only delete button.**

MIDI Learn arming still attaches `handleLearnedCc` through `audioEngine.addMidiListener` and detaches it on cleanup; the first captured CC still binds through `resolveMidiLearnCapture`, publishes via `onUpdateMidiMappings(capture.mappings)`, echoes the CC into the manual field, reports the learned binding, and disarms. Manual binding still routes the FX slot target through `buildFxSlotParameterMapping` and every other target through `buildMidiLearnMapping` / `normalizeMidiLearnTargetSelection`. Duplicate-CC overwrite, delete, clear-all, the FX slot re-seed guard, the 0–127 CC range, the 3s status self-clear timers, and all Escape/focus-trap behaviour (owned by `ModalFrame`) are unchanged. No MIDI processing, audio DSP, global CSS, `ProjectState`, persistence, undo/redo, or unrelated component was modified.

## One real defect found and fixed during validation

The first migration mapped the armed badge label to `--apex-accent` on a 16% accent wash, mirroring the sibling MIDI modal. Measured against the surface it actually sits on (the `--apex-panel-header` band), that is **4.23:1 in Dark and 3.90:1 in Light** — below the 4.5:1 floor this 9px bold label needs, and *worse* than the legacy orange it replaced (4.70:1). The sibling modal passes only because its banner sits on a pure-white panel.

The label now uses `--apex-text`: **10.97:1 Dark, 11.09:1 Light**. The accent wash, accent border and pulse still carry the armed identity, and the adjacent arm toggle is a solid accent fill. The browser suite asserts both the passing value and that the rejected accent-on-wash combination is below 4.5, so the reasoning is pinned rather than remembered.

## Validation (observed in this run, not assumed)

| Check | Result |
| --- | --- |
| Focused new unit suite (`midiLearnThemeUi`) | **9/9 pass** |
| Negative control on the unit suite (2 dark-only literals injected) | **4 failures**, then 9/9 on restore — the assertions are not vacuous |
| Focused suites (`midiLearnThemeUi` + `modalDialogShell` + `phase81.fxAutomationTargets`) | **66/66 pass** |
| Playwright `browser-tests/midiLearnTheme.spec.ts` | **2/2 pass** — real Chromium, Dark and Light |
| Negative control on the browser suite (dark-only header band injected) | **2 failures**, then 2/2 on restore |
| Full Playwright browser suite | **69/69 pass** in 3.1 min — real Chromium 153, no simulation |
| `npm run test:history` (includes the new suite and the modal-shell contract) | **936/936 pass** |
| `npm run test:audio` | **1676/1676 pass** |
| `npm run test:shell` | **271/271 pass** |
| `npm run test:truth` | **98/98 pass** |
| `npm run verify:test-discovery` | **Pass** — 236 test files covered, 0 orphaned |
| `npm run lint` | **Pass** — `tsc --noEmit`, no errors |
| `npm run build` | **Pass** — 1831 modules transformed |
| Production CSS check | **Pass** — every token and `color-mix` utility the component uses is emitted |
| `git diff --check` | **Pass** (exit 0) |
| Final diff review | Only the seven intended files; see the artifact note below |

Browser coverage ran against the actual Vite dev server and a real Chromium 153.0.8010.0 binary. The Playwright CDN is unreachable from this sandbox, so the npm-distributed `@sparticuz/chromium` 153.0.0 binary was extracted to `/tmp/chromium` with its `al2023` libraries and fonts — exactly the paths `playwright.config.ts` already expects. These are genuine browser tests: they read live `getComputedStyle` values, click real controls, and drive real keyboard events.

### Unrelated change caught and reverted

Running the full browser suite rewrites four committed PNGs (`assets/screenshots/ui03b-mastering-light-after-live-switch.png`, `ui03c-aux-dark.png`, `ui03c-aux-light.png`, `ui03e-audio-slicer-dark.png`) because the **pre-existing** UI-03B/03C/03E specs call `page.screenshot()` into that directory, and re-encoding is not byte-stable. These are side effects of running the regression suite, not part of UI-03L, and were reverted with `git checkout --`. The final diff contains none of them.

### Two test-harness defects found while writing the browser suite

Both were investigated to a root cause rather than papered over:

- Controls carrying a Tailwind `transition` class report a **mid-transition** computed color immediately after a click (the arm toggle sampled at ~70% between `--apex-surface-3` and `--apex-accent`; Chromium even serializes a transitioning outline color as `oklab(...)`). Color and focus-ring assertions therefore retry via `expect.poll` — the standard Playwright auto-retrying pattern — instead of sampling once.
- Contrast must be measured against the **effective composited surface**. Translucent `color-mix` washes (armed badge, learn banner) and `--apex-state-hover` lifts are flattened onto the first opaque ancestor; comparing against a raw un-flattened wash would measure the wrong background. The stack walk starts at the element itself, because form controls and the CC chip own an opaque surface while text nodes inherit theirs.

## Known limitations

- **No physical MIDI controller was available.** The browser suite exercises the no-device branch, so the `--apex-success` connected-hardware row is verified by the unit suite (source-level) but not painted in a browser. The armed-and-capture path is likewise verified by source contract plus the arm/disarm UI cycle, not by a real inbound CC; the MIDI runtime suites in `test:audio` remain the behaviour contract for capture itself.
- **The Light-theme success green is not browser-measured** for the same reason. Its Dark and Light token values come from `index.css` and match the values the UI-03I suite already pins.
- No new design tokens were introduced. As with any shared semantic token, the exact legacy orange is not byte-identical; `--apex-accent` is the value the compatibility layer already resolved it to, so Dark is unchanged for those literals.
- The panel keeps its original `shadow-2xl` elevation utility, so its shadow is unchanged rather than moved to `--apex-shadow`.
- The `.gitignore` addition is a one-line hygiene change caused directly by adding a browser test; it is called out here because it is not a theme change.
- GitHub CI is external to these local checks and is verified against the exact final PR head SHA separately.
- **This migration is not merged.** Stop for review and merge approval; do not begin another modal migration.
