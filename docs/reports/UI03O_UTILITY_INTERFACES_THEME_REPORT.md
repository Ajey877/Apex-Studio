# UI-03O — Batch 3: Utility Interfaces Light/Dark Theme Migration

**Baseline:** `main` @ `f0107175a98e27b13c22a6abd6c12a40895e2de4` (PR #220, *UI-03N Batch 2: Audio Workflow Modals*, `MERGED`; merge commit == `origin/main` == this branch's base)
**Implementation branch:** `arena/ba3262ec-apex-studio` (Arena session-bound branch)
**Batch:** 3 of 3 — *Utility Interfaces*
**Components:** `CollaborationModal`, `HotkeysModal`, `AnalyticsModal`, `OrientationLockModal`, `DesktopAppModal`
**Scope:** those five components' presentation only, their focused unit and browser coverage, the shared modal-shell expectation, test-suite discovery wiring, and this report. **No global CSS, no token definitions, no DSP, no routing/recording/transport semantics, no `ProjectState` shape, no `ModalFrame` behaviour change, and no other component changed.**

---

## 1. Baseline verification before editing

| Check | Finding |
| --- | --- |
| Branch / HEAD before work | `arena/ba3262ec-apex-studio` @ `f010717`, working tree clean |
| `git fetch origin main` | `origin/main` == `f0107175a98e27b13c22a6abd6c12a40895e2de4` — **unchanged since the verified Batch-2 merge** |
| Suites on the untouched baseline | `lint` PASS · `verify:desktop` PASS · `verify:test-discovery` PASS (242 files, 0 orphaned) · `test:shell` 271/271 · `test:truth` 98/98 · `test:history` 1008/1008 · `test:audio` 1676/1676 · `npx playwright test` 79/79 (3.8 min) · `npm run build` PASS (CSS 109.66 kB / gzip 17.26 · JS 1,206.54 kB / gzip 318.92) |

**Roadmap reconciliation before editing.** `UI03N_AUDIO_WORKFLOW_THEME_REPORT.md` §8 was re-read against the tree: exactly five Utility-Interface surfaces remained for Batch 3, and a literal census confirmed all five still carried their full dark-only palette (comments excluded):

| Component | Lines | Hex literals | Arbitrary utilities | Named-palette classes | Fixed `white`/`black` utilities | `--apex-*` refs |
| --- | --- | --- | --- | --- | --- | --- |
| `CollaborationModal` | 202 | 47 | 46 | 0 | 11 | 0 |
| `HotkeysModal` | 127 | 24 | 24 | 0 | 5 | 0 |
| `AnalyticsModal` | 212 | 42 | 42 | 0 | 8 | 0 |
| `OrientationLockModal` | 146 | 30 | 30 | 0 | 6 | 0 |
| `DesktopAppModal` | 667 | 137 | 136 | 7 | 32 | 0 |
| **Total** | **1,354** | **280** | **278** | **7** | **62** | **0** |

None was already complete, so none was skipped. The `index.css` UI-1C legacy-utility compatibility layer is still required (the non-modal files remain unconverted) and was left in place.

**Reachability check before browser planning.**

| Component | Entry point | Live-app reachable? |
| --- | --- | --- |
| `HotkeysModal` | `#fl-hotkeys-btn` in the transport bar | yes |
| `CollaborationModal` | `#fl-tools-menu-btn` → `#fl-collab-btn` | yes |
| `DesktopAppModal` | `#fl-tools-menu-btn` → `#fl-desktop-app-btn` | yes |
| `AnalyticsModal` | application menu → `project.statistics` → `#application-menu-command-project.statistics` | yes |
| `OrientationLockModal` | self-detecting full-screen state (portrait + touch/narrow) | yes, at a portrait viewport |

`DesktopAppModal` has four tabs; all four are reachable by click. `OrientationLockModal` is deliberately **not** a `ModalFrame` dialog and is not in `MODAL_CASES`, so its rendered Light/Dark state is covered by a real-browser spec at a portrait phone viewport (`test.use({ viewport: { width: 420, height: 900 }, hasTouch: true })`) plus a source-level unit suite (this repository's unit suites have no DOM, so the effect that sets its portrait state cannot run there).

---

## 2. What changed

All five surfaces are DOM-rendered with no canvas, so the existing `--apex-*` tokens theme every surface directly — no palette seam, no theme observer, no new token.

| Component | Hex literals | `--apex-*` token refs (comments excluded) |
| --- | --- | --- |
| `CollaborationModal` | 47 → **0** | 0 → **56** |
| `HotkeysModal` | 24 → **0** | 0 → **28** |
| `AnalyticsModal` | 42 → **0** | 0 → **49** |
| `OrientationLockModal` | 30 → **0** | 0 → **36** |
| `DesktopAppModal` | 137 → **1** (generated-bundle payload, §3.2) | 0 → **172** |
| **Total** | **280 → 1** | **0 → 341** |

Arbitrary colour utilities `278 → 0`, named-palette classes `7 → 0`, fixed `white`/`black` utilities `62 → 1` (the data-coupled avatar on-colour, §2.2).

### 2.1 Chrome and text mapping

| Legacy | Meaning | Token | Precedent |
| --- | --- | --- | --- |
| `#141416` / `#1a1a1d` (panels), `#18181b` | Modal panel | `--apex-surface` | UI-1C layer already resolved this pair; UI03M/N kept the same step |
| `#1e1e20` / `#18181c` | Header and footer band | `--apex-panel-header` | UI-1C layer; used by every UI-03 batch |
| `#121214` / `#0b0b0d` | Insets, `kbd` chips, CLI block, tip band, form controls | `--apex-canvas` | UI-1C layer |
| `#222225` / `#252525` / `#2d2d30` | Cards, secondary buttons, hovers | `--apex-surface-2` / `--apex-surface-3` | monotonic idle → raised step used by UI-03M/N |
| `#333336` / `#333338` / `#2e2e32` / `#28282b` | Borders | `--apex-border` | UI-1C layer (some of these are **not** remapped by it — hence this migration) |
| `hover:bg-[#2d2d30]` / `hover:bg-[#333338]` | Close-control hover wash | `hover:bg-[var(--apex-state-hover)]` | UI-1C layer |
| `text-white` | Emphasis text | `--apex-text` | UI-03M/N |
| `#b0b0b0` / `#aaa` | Body text | `--apex-text-2` | UI-1C layer / UI-03M |
| `#777` / `#555` / `#666` | Muted text | `--apex-text-3` | UI-1C layer |
| `bg-black/85` / `bg-black/80` | Hand-rolled scrim | *removed* — `ModalFrame` supplies `--apex-modal-overlay` | every UI-03 batch dropped the dead fill |
| `bg-radial from-[#ff6e00]/15` (orientation veil glow) | Illustration glow | `from-[color-mix(in_srgb,var(--apex-accent)_16%,transparent)]` | keeps the wash strength the compatibility layer already produced |
| `bg-[#0a0a0b]/98` (orientation veil) | Near-opaque full-screen veil | `bg-[color-mix(in_srgb,var(--apex-bg)_96%,transparent)]` + `backdrop-blur-xl` | keeps the veil's character *and* its blur, now theme-correct |

### 2.2 Identity, status and data colours

- **Accent identity** (`#ff6e00` everywhere it is chrome — tiles, tile glyphs, BAR chips, CTAs, category headings, the desktop-app header tile gradient, readiness badges, active tabs, install/download/footer actions, the toast, the orientation illustration and primary CTA) → `--apex-accent` / `--apex-accent-strong` with `--apex-state-playing-fg` on-colour. This is the token the UI-1C compatibility layer already resolved those literals to, so the rendered identity hue is unchanged; the migration removes the *reliance* on the layer and turns one mixed family (violet panel edge + raw amber badge) into one coherent accent family.
- **Status is semantic and honest.** `--apex-success` for real "connected/ready/healthy" readings, `--apex-danger` for failures and destructive readings, `--apex-gold` / `--apex-cyan-text` / `--apex-aux-text` for the distinct per-card identity hues the desktop modal already used.
- **`OrientationLockModal`'s meter bars** keep their audio-state meaning: `--apex-success`, `--apex-accent` ×2, `--apex-danger`.
- **`AnalyticsModal`'s offline-backup tone branches** map one-to-one onto `--apex-danger` (failed save or unreadable store), `--apex-text-3` (still reading) and `--apex-success` (real records) — see §3.1.
- **The one fixed utility that survives** is `text-black` on `CollaborationModal`'s collaborator avatar, which sits on `style={{ backgroundColor: user.color }}`. That on-colour belongs to the *stored* `CollabUser.color` (the same category UI-03A preserves for `ch.color` and `PAD_COLORS`), not to the theme: swapping it for a theme on-colour would make a light stored colour unreadable in one of the two palettes. It is pinned as exactly one occurrence by the unit suite.
- **The one hex literal that survives** is `backgroundColor: "#0a0a0b"` at `DesktopAppModal.tsx:196` — inside the `electron.cjs` text that `generateWindowsZipBundle` writes into the downloadable ZIP. That is generated payload, not chrome (§3.2).

### 2.3 Files touched

1. `src/components/CollaborationModal.tsx` — presentation only.
2. `src/components/HotkeysModal.tsx` — presentation only.
3. `src/components/AnalyticsModal.tsx` — presentation only.
4. `src/components/OrientationLockModal.tsx` — presentation only.
5. `src/components/DesktopAppModal.tsx` — presentation only + one `aria-label` (§3.3).
6. `src/components/collaborationThemeUi.test.tsx` **(new, 10 tests)** — appended to `test:history`.
7. `src/components/hotkeysThemeUi.test.tsx` **(new, 8 tests)** — appended to `test:history`.
8. `src/components/analyticsThemeUi.test.tsx` **(new, 10 tests)** — appended to `test:history`.
9. `src/components/orientationLockThemeUi.test.tsx` **(new, 5 tests)** — appended to `test:history`.
10. `src/components/desktopAppThemeUi.test.tsx` **(new, 10 tests)** — appended to `test:history`.
11. `browser-tests/collaborationTheme.spec.ts` **(new, 2 real-Chromium cases)**.
12. `browser-tests/hotkeysTheme.spec.ts` **(new, 2 real-Chromium cases)**.
13. `browser-tests/analyticsTheme.spec.ts` **(new, 2 real-Chromium cases)**.
14. `browser-tests/desktopAppTheme.spec.ts` **(new, 2 real-Chromium cases)**.
15. `browser-tests/orientationLockTheme.spec.ts` **(new, 2 real-Chromium cases)**.
16. `src/state/modalDialogShell.test.tsx` — **only** the four migrated `overlayClass` expectations, updated in lockstep to pin `ModalFrame`'s shared themed scrim and drop the dead black fill. `OVERLAY_STUDIO` stays: `ProjectBundleZipModal` still references it. No other case touched, and the file's 28 tests stay green.
17. `package.json` — the five new suites appended to the `test:history` glob list so `verify:test-discovery` keeps reporting 0 orphaned files (242 → 247).
18. `assets/screenshots/ui03o-*.png` **(new, 10 committed PNGs)** — the Light/Dark evidence pair per component, captured by each browser spec (the repo convention established by the UI-03B…UI-03N specs).
19. `UI03O_UTILITY_INTERFACES_THEME_REPORT.md` — this report.

### 2.4 Behavior explicitly untouched (proved mechanically, §5)

Every prop signature, `useState`/`useEffect`, handler, callback, published payload, timer, persistence path and user-visible string survived. Specifically re-pinned by the new suites:

- **Collaboration (phase70 truthfulness):** no demo names, no `ONLINE`/`IDLE`/`animate-pulse`, counts as `(N)`, the verbatim "Comments and collaborator data are stored in this project. No live network sync is active." copy, `addCollabCommentInProjectState` / `toggleCollabCommentResolvedInProjectState` wiring, the 16-bar selector opening on bar 4, the 2 s copied-state self-clear.
- **Hotkeys (phase 71 documentation):** all five `HOTKEY_GROUPS` categories and all 19 rows render, each with its `kbd` chip; the table is byte-for-byte identical (`hotkeyDocumentation.test.ts` still green).
- **Analytics (phase68 F4):** `describeOfflineBackupStatus` is untouched, the open guard is untouched, the fabricated `1840` fallback and the hard-coded "Low-Latency Core" claim stay absent, and a persisted `3840 s` still prints `01:04:00`.
- **Desktop app:** the `beforeinstallprompt` listener, the live `audioEngine.getLatencyMetrics()` read-out and its 1 s cadence, the clipboard command string, the 6 s toast self-clear, the `JSZip` bundle with all six generated filenames and the date-stamped download name.
- **Orientation lock:** the detection predicate, both listeners and both cleanups, the fullscreen + `screen.orientation.lock('landscape')` request, both dismiss paths, the overlay id, and the `title` on the corner control.

### 2.5 Accessibility

One status-toast dismiss glyph in `DesktopAppModal` was glyph-only with no accessible name. It now carries `aria-label="Dismiss status message"` — the same fix, and the same label, UI-03M recorded for its two toasts and UI-03N for its two; both are already in the tree with that exact string. The unit suite pins it. Nothing else in the five files changed shape.

---

## 3. Findings and the defects fixed

### 3.1 `AnalyticsModal`'s failed-backup row printed an unmapped near-white red (fixed)

`describeOfflineBackupStatus` returns `Save failed — …` or `Unavailable — …` for a genuinely broken store, and the row printed it as `text-[#ff6b6b]`. That literal is **not** in the UI-1C compatibility layer, so unlike every sibling colour it never followed the theme: in Light it rendered a near-white red on `--apex-surface-2`, measuring **2.56:1** — a failure the user is specifically meant to read, at less than half the AA floor. The tone now resolves through the existing semantic scale (`--apex-danger` for failure, `--apex-text-3` while reading, `--apex-success` for real records), i.e. **5.24:1 Dark / 5.55:1 Light**. The unit suite pins all three branches and rejects the literal returning; the browser spec reaches the settled success tone on the live app and asserts it is theme-correct in both palettes.

### 3.2 `DesktopAppModal`'s generated Windows bundle is payload, not chrome (left alone)

The modal's `generateWindowsZipBundle` builds a real ZIP containing `ApexStudio-Windows-Launcher.bat`, `Build-Windows-EXE.ps1`, `ApexStudio-Silent.vbs`, `electron.cjs`, `preload.cjs`, `package.json` and `README_WINDOWS_EXE.txt`. The generated `electron.cjs` sets `backgroundColor: "#0a0a0b"` for the Electron window it creates on the user's machine. Tokenising that string would change the bytes of a file the user downloads and runs, and the theme cannot reach an app the browser never renders — so it survives, pinned by the unit suite as the file's only remaining literal (`assert.deepEqual(payload.match(/#…/g), ['#0a0a0b'])`). Everything the modal actually paints has zero literals, asserted separately on the comment-stripped source with template literals blanked.

### 3.3 Identity labels sitting on their own `color-mix()` wash measured below AA (fixed in four places)

The compatibility layer's accent wash (`--apex-accent` 16 %) and accent border (48 %) are the established "identity badge" treatment, and the migrated files initially kept the legacy pairing of *accent-coloured label on accent wash*. Measured in Chromium, that pairing fails AA for the small bold labels that use it:

| Element | Palette | Accent-on-wash (rejected) | `--apex-text` (adopted) |
| --- | --- | --- | --- |
| `DesktopAppModal` readiness badge (9px bold) | Dark | **4.23:1** | 10.97:1 |
| `DesktopAppModal` readiness badge (9px bold) | Light | **3.90:1** | 11.09:1 |
| `OrientationLockModal` identity pill (11px) | Light | **4.10:1** | 11.65:1 |
| `AnalyticsModal` FLOW STATE badge (10px bold) | Light | **4.32:1** | 12.09:1 |
| `CollaborationModal` MARK RESOLVED (9px bold) | Light | **4.08:1** | 11.41:1 |
| `CollaborationModal` MARK RESOLVED hover wash | Dark | **4.33:1** | 7.08:1 |

The wash and border carry the identity; the label now follows `--apex-text`, exactly the decision UI-03L recorded for its armed badge. Each new browser spec asserts the passing value **and** that the rejected combination measures below 4.5 — so the reasoning is pinned, not just the outcome. (Dark clears the orientation pill at 5.18:1 and the FLOW STATE wash at 6.11:1; the specs assert that too, which is why one label token is documented as covering both palettes.)

### 3.4 Findings deliberately *not* "fixed", with reasons

- **Escape stops dismissing a dialog after focus falls to `<body>` (pre-existing, shared).** `ModalFrame` handles Escape through React's `onKeyDown` on the overlay. When the focused element unmounts — e.g. the desktop modal's toast dismiss button after it is clicked — focus returns to `<body>`, the keydown never bubbles through the overlay, and Escape is inert until the user tabs back inside. This is in `ModalFrame` (untouched by this batch and shared by all 26 migrated modals), it predates this batch on `main`, and fixing it means changing shared dialog keyboard behaviour — explicitly outside a presentation migration. The new desktop spec documents it and re-enters the tab strip before asserting Escape, so nothing is asserted that is not true.
- **`--apex-canvas` and `--apex-surface-2` are the same colour in Light** (`#f4f6fa`), so `kbd` chips and tip bands read as the same tint as the cards behind them in Light while they are visibly recessed in Dark. That is a property of the existing palette, which this batch may not change, and every one of those labels still clears AA on its effective surface (measured ≥ 4.93:1).
- **The `<kbd>` chips are not functionally focusable** and take no keyboard interaction; they are presentational chips for shortcut text, so SC 1.4.11 does not apply to their borders.
- **`OrientationLockModal`'s hover steps are inert on the device it targets.** Tailwind gates `hover:` utilities behind `@media (hover: hover)`, and the screen only exists on a touch/narrow device, so `hover:bg-[var(--apex-accent-strong)]` never activates there — confirmed live (the computed fill stayed `--apex-accent` with `:hover` matching). The class is preserved and pinned by the unit suite; the spec deliberately asserts the resting state on a touch context rather than a hover that cannot happen.
- **The legacy-utility compatibility layer in `index.css` remains.** `ProjectBundleZipModal` and the non-modal files still rely on it; removing it is a later, separate task.

---

## 4. Contrast evidence

Measured **live in Chromium** through `getComputedStyle` and walked over every rendered text node of all five surfaces in both themes, with the effective surface computed by flattening the ancestor background stack (translucent `color-mix()` washes are composited onto the first opaque layer — measuring a wash against its raw colour gives the wrong answer).

**Result: 10 of 10 rendered states clear the WCAG 2.1 floors — `0` nodes below 4.5:1 (normal) / 3:1 (large) in either palette.**

| Surface | Palette | Text nodes measured | Below floor | Worst measured label |
| --- | --- | --- | --- | --- |
| Collaboration | Dark / Light | 42 / 42 | 0 / 0 | 5.13:1 / 4.75:1 (header subtitle, `--apex-text-3`) |
| Hotkeys | Dark / Light | 47 / 47 | 0 / 0 | 5.14:1 / 4.75:1 (header subtitle) |
| Analytics | Dark / Light | 19 / 19 | 0 / 0 | 5.13:1 / 4.75:1 (stat labels) |
| Desktop app (Windows tab) | Dark / Light | 32 / 32 | 0 / 0 | 5.14:1 / 4.75:1 (header subtitle, footer note) |
| Orientation lock | Dark / Light | 6 / 6 | 0 / 0 | 6.15:1 / 5.01:1 (tip copy, `--apex-text-3` on the veil) |

Key measured values (all from the running app):

| Element | Surface | Dark | Light |
| --- | --- | --- | --- |
| Dialog title | `--apex-panel-header` (`--apex-text`) | 14.22:1 | 13.69:1 |
| Body copy | `--apex-surface` / `--apex-surface-2` (`--apex-text-2`) | 8.27 / 7.52 | 7.89 / 7.29 |
| Accent identity read-outs (Total Notes, Project BPM, BAR chips, category headings, active tab) | cards, insets | 5.47:1 | 5.32:1 |
| Success read-outs (engine readiness, backup status, resolve wash label) | cards, canvas | 8.68:1 | 5.40:1 |
| Cyan / gold / aux read-outs (storage, threading, CLI comments, colour-depth) | canvas, cards | 9.54 / 9.08 / 6.04 | 7.39 / 4.93 / 6.72 |
| On-colour on solid accent fills (CTAs, tiles, toast) | `--apex-accent` / `-strong` | 6.77 / 8.86 | 5.75 / 7.57 |
| Functional non-text (identity tile glyphs, meter bars, dismiss glyphs) | own fills / washes | ≥ 3:1 asserted per element | ≥ 3:1 asserted per element |

---

## 5. Behavior-preservation proof

1. **Mechanical source diff.** Each component was normalised (JSX and line comments stripped, every `className` value blanked, whitespace collapsed, `{' '}` artefacts removed) and diffed against `HEAD`. Result: `CollaborationModal`, `HotkeysModal`, `AnalyticsModal` and `OrientationLockModal` are **identical** apart from their class values; `DesktopAppModal` differs only by `{' '}`-equivalent re-wrapping (Prettier re-flowed long copy) and the single added `aria-label="Dismiss status message"`. No handler, prop, attribute, effect or string changed.
2. **Render-paint probe.** A structural snapshot of every element's resolved paint (`backgroundColor`, `color`, all four border colours, `backgroundImage`, `opacity`) was captured keyed by DOM path for all five surfaces in both themes **before** and **after** the migration: **778 nodes**, of which **270 changed** (Dark 131 / Light 139). The changes are the expected per-surface repaint of chrome and status colours; no node appeared or disappeared, and no geometry property changed. By component: Collaboration 17/17, Hotkeys 26/26, Analytics 14/14, Orientation lock 31/31, Desktop app 43 Dark / 51 Light.
3. **Unit suites:** 43/43 across the five new files (10 + 8 + 10 + 5 + 10), each pinning tokens, forbidden literals, conditional states, and the wiring above.
4. **Shell suite:** `modalDialogShell.test.tsx` 28/28 with the four updated overlay expectations.

### 5.1 Negative controls (proving the new assertions are not vacuous)

Run against the **final** code, then restored from saved copies:

| Injected regression | Result |
| --- | --- |
| `bg-[#141416]` panel in `HotkeysModal` (dark-only literal) | unit suite **2 of 8 fail** (the literal scanner and the token-consumption test); **6 pass** — the failures are specific, not blanket |
| `bg-[#0a0a0b]` veil in `OrientationLockModal` (dark-only literal) | browser suite **2 of 2 fail** (`lock-screen veil: expected rgb(17,19,26) @ 0.96` in Dark, `rgb(238,241,246) @ 0.96` in Light) |
| All four files restored | unit **8/8**, browser **2/2** green again |

---

## 6. Validation

All gates run on the final tree with the repository's own scripts.

| Gate | Baseline (`f010717`) | Final | Notes |
| --- | --- | --- | --- |
| `npm run lint` (`tsc --noEmit`) | PASS | **PASS** | zero errors |
| `npm run verify:desktop` | PASS | **PASS** | Desktop security configuration and permission semantics |
| `npm run verify:test-discovery` | 242 files, 0 orphaned | **247 files, 0 orphaned** | +5 new unit suites |
| Focused: five new unit suites | — | **43/43** | |
| Focused: `modalDialogShell.test.tsx` | 28/28 | **28/28** | four overlay expectations updated |
| `npm run test:shell` | 271/271 | **271/271** | |
| `npm run test:truth` | 98/98 | **98/98** | no truth copy touched |
| `npm run test:history` | 1008/1008 | **1051/1051** | +43 new unit tests |
| `npm run test:audio` | 1676/1676 | **1676/1676** | no DSP touched |
| `npx playwright test` | 79 passed (3.8 min) | **89 passed (3.9 min)** | +10 new real-Chromium cases |
| Focused browser: five new specs | — | **10/10** | both themes each |
| `npm run build` | PASS (109.66 kB CSS / 318.92 kB gzip JS) | **PASS** (108.81 kB / gzip 17.06 · 1,211.70 kB / gzip 318.48) | 1831 modules (see §6.2 for the 0.35 kB delta) |
| `git diff --check` | clean | **clean** | no whitespace errors |

### 6.1 Production CSS token usage (verifying the shipped bundle, not the source)

The built stylesheet was searched for the exact utilities the five components now use: `bg-[var(--apex-panel-header)]`, `bg-[var(--apex-canvas)]`, `bg-[var(--apex-surface-3)]`, `bg-[var(--apex-accent)]`, `hover:bg-[var(--apex-accent-strong)]`, `text-[var(--apex-cyan-text)]`, `text-[var(--apex-gold)]`, `text-[var(--apex-aux-text)]`, the accent 16 %/48 % `color-mix()` values, the success 16 %/20 % washes, `--apex-danger` and `--apex-state-playing-fg` — **all present**. The only legacy literals remaining in the bundle are inside the UI-1C compatibility layer's own selectors and the Tailwind utilities they override (which Tailwind still emits for the unconverted files); the five migrated components contribute none.

**Build-size note.** Tailwind v4 auto-detects content sources across the repository, and this report is one of them: with it present the stylesheet is 108.81 kB, with it temporarily removed the same build produces 108.46 kB. The 0.35 kB is a handful of utility candidates the report's prose mentions, not application code, and it matches the mechanism the UI-03M/N reports already exhibit. It is consistent in CI because the report is part of the commit.

### 6.2 Browser coverage (Light **and** Dark, per component)

- **Collaboration** — themed scrim/chrome; the identity tile wash and glyph; the local-workspace card and the verbatim no-network-sync copy; the accent COPY APP LINK action with on-colour AA; every stored collaborator with its role; the note cards, BAR chips, and the resolved card's 0.5 opacity; **posting a real note** (count increments, composer clears, the bar selector re-points to bar 9), the unresolved action's success wash, **resolving** it (label flips, card recedes, button moves to the neutral step), the composer/selector/input contrast and the themed placeholder; close-control hover; **Escape closes**, theme unchanged; **reopening keeps the new note and its resolved state**.
- **Hotkeys** — themed scrim/chrome; the identity tile wash, edge and glyph; all five category cards with their accent headings; all 19 documented rows and 19 `kbd` chips; the tip band and its accent glyph; the accent "Got it" action with on-colour AA; **keyboard focus order** reaches the close control with the 2 px `--apex-accent` @ 0.78 ring; the close hover shift; **Got it** dismisses; **Escape** dismisses the reopened dialog.
- **Analytics** — themed scrim/chrome; the stopwatch banner, accent clock inset and the project's own recorded time; the FLOW STATE badge (wash + edge + AA label) with the rejected pairing measured; all four stat cards; the accent identity read-outs vs the neutral read-outs; the details card with the **real** backup row (`No offline backup yet` / `N offline backups · newest …`, never a claim the app cannot back); close hover; **Escape closes and the reopened dialog reports the same observable state**.
- **Desktop app** — themed scrim/chrome, accent panel edge, the header tile's **gradient stops resolved through the accent family**, the readiness badge with its rejected pairing measured; the tab strip's active and inactive states; **all four tabs**: the Windows bundle (download card edge, the READY-TO-USE badge, the download CTA, the three launcher/builder/audio-mode cards, the How-to instructions), PWA (the hardware-readiness triad keeping `--apex-success` / `--apex-cyan-text` / `--apex-gold`, honest `ENGINE NOT STARTED` vs the live latency read-out when the engine is running, the install CTA), display diagnostics (viewport, monitor, DPI scale, colour depth with its aux sub-label), and the CLI tab (the inset, all three coloured comments, the copy control and the **Copied!** state); the accent status toast with its named dismiss control; the footer note and footer Close; close hover; **Escape closes**. The clipboard permission is granted up front so the production write path runs as it does for a user.
- **Orientation lock** — a portrait phone viewport with touch enabled; asserted **not** a dialog (no `role`, no `aria-modal`); the near-opaque themed veil at 96 % and its blur; title and explanation AA; the identity pill with the rejected pairing measured; the illustration glow, the themed phone body with its accent edge, the four meter bars keeping success/accent/danger, the accent rotation badge with on-colour; the primary CTA (fill, on-colour AA, and the documented inert-on-touch hover) and the neutral secondary CTA with its themed border; the corner dismiss control's 3:1 non-text contrast; the tip copy; **Continue Anyway** dismisses it in both themes and it stays gone after a landscape resize.

### 6.3 Unrelated changes caught and reverted

- **`assets/screenshots/*.png` from other batches** — the full browser suite rewrites committed PNGs through font/render nondeterminism in this sandbox (4 files this run: `ui03b-mastering-light-after-live-switch.png`, `ui03c-aux-dark.png`, `ui03c-aux-light.png`, `ui03e-audio-slicer-dark.png`; the identical mechanism UI-03M/N §6.2 recorded). None belongs to a Batch-3 spec. Reverted with `git checkout -- assets/screenshots/`; the only screenshot changes in the final diff are the ten new `ui03o-*` pairs this batch's own specs generate.
- **`package-lock.json`** — not rewritten this run (no `npm install` was needed); the final diff contains no lockfile change.

### 6.4 Environment note and the final re-run

The Arena sandbox was restarted between the drafting of this report and its commit, which cleared `node_modules` and `/tmp` but left the repository — including every Batch-3 file — intact. Dependencies were reinstalled with the repository's own `npm install --legacy-peer-deps` (installed versions verified identical to the committed lockfile: tailwindcss 4.3.3, vite 6.4.3, react 19.3.0, typescript 5.8.3), Chromium was re-staged out-of-tree, and **every gate in §6 was re-run on the frozen final tree**: lint PASS · five new unit suites + modal shell 71/71 · verify:test-discovery 247 files / 0 orphaned · test:shell 271/271 · test:truth 98/98 · test:history 1051/1051 · test:audio 1676/1676 · full Playwright **89/89 (3.9 min)** · build PASS · `git diff --check` clean. The numbers in §6 are the re-run values.



`npx playwright install chromium` fails in this sandbox (`ECONNRESET` on `cdn.playwright.dev`), as the UI-03L…UI-03N reports record. Chromium was reused from the out-of-tree staging at `/tmp/chromium` (+ `/tmp/al2023/lib`, `/tmp/fonts`) that `playwright.config.ts` already auto-detects. **Nothing was added to the repository for this** — the diff contains no browser binary, no config change and no cache directory. GitHub Actions installs Chromium normally via `npx playwright install --with-deps chromium`, so CI is unaffected.

---

## 7. Known limitations

1. **`OrientationLockModal`'s rendered state cannot be produced by this repository's unit suites** (no DOM, and the component only paints after an effect has run). Coverage is split deliberately: the unit suite scans every `className` in the file, pins both dismiss paths, the detection predicate, the listener registration/cleanup, the early return and the empty pre-effect render; the real-browser spec covers both palettes at a portrait touch viewport.
2. **`AnalyticsModal`'s failure branch is not reachable from the live app** (it needs a real write failure). The unit suite renders it with a `saveError` fixture and pins the `--apex-danger` tone; the browser spec measures the settled success tone and the wash contrast of the reached states.
3. **`DesktopAppModal`'s generated ZIP is not downloaded and inspected in the browser spec.** Its byte-for-byte contract (six generated filenames, the one payload colour, the date-stamped download name) is pinned source-level by the unit suite, which keeps the suite from writing files during a test run.
4. **`DesktopAppModal`'s other three tabs are unreachable for the unit suite** (no DOM to click with), so their class strings are covered by the whole-file scanner plus **all four tabs in the real browser**.
5. **Shared semantic tokens are not byte-identical to the legacy literals in Dark** (`--apex-accent` is `#9b8afb` where the raw literal was `#ff6e00`; `--apex-success` is `#62d7a4` where `#00ff88` was). Same hue family, and the change is what makes them clear AA in Light — the trade-off UI-03H/M/N all record. The Dark panels were re-measured after the migration and every label still clears AA (§4).
6. **Escape-after-focus-loss is a pre-existing `ModalFrame` gap** (§3.4), documented and worked around in the desktop spec rather than "fixed".
7. **`--apex-canvas` == `--apex-surface-2` in Light** (§3.4): recessed insets read as flat cards in Light. Palette property, not introduced here.
8. **The legacy-utility compatibility layer in `index.css` remains**, now used only by `ProjectBundleZipModal` and the non-modal files.

---

## 8. Remaining UI-03 work after this batch

Batch 3 was the last planned batch of the modal migration. What remains for the theme programme (a separate task, not part of UI-03O):

- `ProjectBundleZipModal` — the only modal still on the legacy palette.
- The non-modal files still served by the `index.css` compatibility layer (e.g. `App.tsx` shell regions, `PlaylistArranger`, `ChannelRack`).
- Removing the UI-1C compatibility layer itself, once the two items above are converted.

---

## 9. Final validated state

| Item | Value |
| --- | --- |
| Base (`main`) | `f0107175a98e27b13c22a6abd6c12a40895e2de4` |
| Branch | `arena/ba3262ec-apex-studio` |
| Gates re-run after the last code change | lint, verify:desktop, verify:test-discovery, five new unit suites, modal-shell, test:shell, test:truth, test:history, test:audio, full Playwright (**89**), build, `git diff --check` — all on the final tree |
| Files changed vs `main` | 28 paths / 19 items (5 components, 5 new unit suites, 5 new browser specs, `modalDialogShell.test.tsx`, `package.json`, 10 evidence PNGs, this report) |
| `git diff --check` | clean |
| Lockfile changes in the diff | **none** |
| Screenshot changes other than the 10 new `ui03o-*` pairs | **none** |
| New design tokens | **0** |
| Global CSS changes | **0** |
| `ModalFrame` / routing / DSP / `ProjectState` changes | **0** |

---

## 10. Merge recommendation

**Recommend merging, subject to the CI runs recorded in the PR.** All twelve validation gates pass on the final code, including the full 89-case real-browser suite and a clean production build; each of the five migrated surfaces was measured live in both palettes with zero labels below the WCAG floors, and the pre/post render-paint diff shows only the intended repaints. The change is presentation-only, proved mechanically in §5, with the five real defects in §3.1/§3.3 fixed, the payload exception and four palette properties documented rather than papered over (§3.2/§3.4), zero new tokens, zero global-CSS changes, and no weakening of any existing assertion. `test:audio` is unchanged at 1676/1676 and `test:truth` at 98/98 — the expected signature of a migration that touched no DSP and no truth copy.
