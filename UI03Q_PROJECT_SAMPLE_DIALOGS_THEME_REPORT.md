# UI-03Q — Batch 5: Project & Sample Dialogs — Last Literal Scrims

**Baseline:** `main` @ `bba0d13014a35f6c920fbfb4de251215eb59ed30` — PR #222, *UI-03 Fast-Track Batch 4: Residual Surfaces*, `MERGED`; the merge commit **is** `origin/main` **is** this branch's base.
**Implementation branch:** `arena/05890349-apex-studio`
**Batch:** 5 — *the last literal scrims* (five framed dialogs still carrying dead `bg-black/*` fills, one standalone alertdialog whose black scrim was live, and one undefined-token warning border)
**Files migrated:** `ExportModal.tsx`, `ProjectManagerModal.tsx`, `SampleManagerModal.tsx`, `MasteringSuiteModal.tsx`, `ProjectSettingsModal.tsx`, `ProjectReplaceConfirmModal.tsx`
**Scope:** those six components' presentation only, the shared expectations they touch (`modalDialogShell`, `masteringSuiteThemeUi`, `ui04ThemeConsistency`), five new focused unit suites, four new browser specs, appended to the existing `test:history` glob, and this report. **No global CSS, no token definitions, no new token, no DSP, no routing/recording/transport semantics, no `ProjectState` shape, no `ModalFrame` behaviour change, no AI feature, and no other component changed. The UI-1C compatibility-layer deletion (§6) and the UI-03F/UI-03M timing flakes were explicitly left as separate reviewable work, per the batch brief.**

---

## 1. Baseline verification before editing (Step 1)

| Check | Finding |
| --- | --- |
| `git fetch origin` | `origin/main` == `bba0d13014a35f6c920fbfb4de251215eb59ed30` |
| PR #222 | `MERGED`, merge commit `bba0d13…`, head `arena/32696a7b-apex-studio` |
| Post-merge check-runs on `bba0d13` | `deploy` ✅ · `audio-tests` ✅ · `build` ✅ · `verify` ✅ · `windows-package` ✅ — all `success`; workflow runs (Apex Studio CI, Desktop Validation, Audio Validation, Deploy) all `success` |
| Batch 4 implementation + report | present (`UI03P_RESIDUAL_SURFACES_THEME_REPORT.md`, five migrated components, 32 unit + 12 browser tests) |
| Branch / HEAD / tree before work | `arena/05890349-apex-studio` @ `bba0d13`, working tree clean, nothing to preserve |
| Suites on the untouched baseline (this sandbox) | `verify:desktop` PASS · `lint` PASS · `verify:test-discovery` PASS (252 files, 0 orphaned) · `test:shell` 271/271 · `test:truth` 98/98 · `test:history` 1083/1083 · `test:audio` 1676/1676 · `npm run build` PASS (CSS 108.14 kB / JS 1,213.93 kB) |
| Browser suite on baseline | **not runnable in this sandbox** — no Chromium is installed and the Playwright CDN is unreachable from the sandbox network (§7.1). CI runs the full Playwright suite on every PR (§5.2). |

## 2. Scope selection (Step 2, evidence-based)

A literal census over every non-test `src/**/*.{ts,tsx}` (comments excluded) after Batch 4 showed the modal interiors are fully tokenised; the only remaining hardcoded **chrome** colours in dialog surfaces were the overlay fills:

| Component | Interior `--apex-*` refs | Remaining literal | Live or dead? |
| --- | --- | --- | --- |
| `ExportModal` | 78 | `bg-black/85` on `ModalFrame` | dead — unlayered `.apex-modal-overlay` already wins |
| `ProjectManagerModal` | 80 | `bg-black/85` on `ModalFrame` | dead |
| `SampleManagerModal` | 85 | `bg-black/80` on `ModalFrame` | dead |
| `MasteringSuiteModal` | 232 | `bg-black/80` on `ModalFrame` | dead (interior migrated in UI-03B; scrim was pinned verbatim by its suite) |
| `ProjectSettingsModal` | 32 | `bg-black/60` on `ModalFrame`; `var(--apex-warning,#d97706)` alert border | dead scrim; **live fixed amber** — `--apex-warning` is defined nowhere in the tree |
| `ProjectReplaceConfirmModal` | 38 | `bg-black/80` on a standalone `alertdialog` div | **LIVE** — no `ModalFrame`, no `apex-modal-overlay` class, so Light kept a near-black 80 % scrim |

Excluded, with reasons: `App.tsx`/`presets.ts`/`DrumSamplerPanel`/`ChannelRack`/`StudioBrowser` hex (stored identity/data hues, UI-03A preserved), `PlaylistArranger`'s preserved audio wash + fade scrim (UI-03P §3.5), theme-seam palette tables (`*Theme.ts`, intentional Dark hex tables resolved through tokens), and the dead UI-1C layer deletion (separate reviewable work, §6).

## 3. What changed

Every change follows the exact pattern of UI-03B…P: remove the dead literal fill; `ModalFrame`'s `apex-modal-overlay` primitive (background `var(--apex-modal-overlay)`: `rgba(5,7,12,0.66)` Dark / `rgba(24,32,45,0.55)` Light) owns the scrim.

1. **Five framed dialogs** (`Export`, `ProjectManager`, `SampleManager`, `MasteringSuite`, `ProjectSettings`): `bg-black/*` removed from the overlay class string. Rendered pixels are unchanged today (the primitive already won the cascade); the source no longer depends on that cascade accident, and Tailwind stops emitting the dead utilities.
2. **`ProjectReplaceConfirmModal` (the genuine defect):** the standalone alertdialog now carries `apex-modal-overlay` itself and drops `bg-black/80`. In Light its scrim changes from pure black at 80 % to the themed slate at 55 % — the same dim every other dialog gets. It still does **not** adopt `ModalFrame` (pinned by `modalDialogShell.test.tsx`), keeps `role="alertdialog"`, `z-[60]`, and all backup/replace behaviour.
3. **`ProjectSettingsModal` warning border:** `border-[var(--apex-warning,#d97706)]` → `border-[var(--apex-gold)]`. `--apex-warning` exists nowhere, so the border was a fixed `#d97706` amber in both themes (3.19:1 on the Light surface). `--apex-gold` is the theme's existing caution hue (Dark `#ffb86b` 9.98:1 / Light `#9a5d00` 5.33:1 on the panel) — no new token, no architecture change. The alert text was and remains `--apex-text` on `--apex-surface` (AA in both themes).

### 3.1 Files touched

| File | Change |
| --- | --- |
| `src/components/ExportModal.tsx` | scrim literal removed |
| `src/components/ProjectManagerModal.tsx` | scrim literal removed |
| `src/components/SampleManagerModal.tsx` | scrim literal removed |
| `src/components/MasteringSuiteModal.tsx` | scrim literal removed |
| `src/components/ProjectSettingsModal.tsx` | scrim literal removed; warning border → `--apex-gold` |
| `src/components/ProjectReplaceConfirmModal.tsx` | `apex-modal-overlay` added; live `bg-black/80` removed |
| `src/state/modalDialogShell.test.tsx` | `OVERLAY_SHELL` / `OVERLAY_FLOATING` fixtures updated to the rendered themed-scrim strings, with UI-03Q comments (intended-state change, as in every prior batch) |
| `src/components/masteringSuiteThemeUi.test.tsx` | the one assertion pinning `bg-black/80` verbatim now pins its absence (intended-state change) |
| `src/state/ui04ThemeConsistency.test.ts` | `ProjectSettingsModal`, `ProjectReplaceConfirmModal`, `MasteringSuiteModal` added to `THEMED_SURFACES` so the legacy-utility guard covers them |
| `src/components/{export,projectManager,sampleManager,projectSettings,projectReplaceConfirm}ThemeUi.test.tsx` | **new** — 20 unit tests |
| `browser-tests/{export,projectManager,sampleManager,projectSettings}Theme.spec.ts` | **new** — 12 browser tests (Dark, Light, theme-flip per surface) |
| `package.json` | five new suites appended to the existing `test:history` glob (no new script, no check removed) |
| `UI03Q_PROJECT_SAMPLE_DIALOGS_THEME_REPORT.md` | this report |

### 3.2 Behaviour explicitly untouched

Export render/audition flow and its `dismissible={!isRendering}` guard, Project Hub load/backup/manifest seams, Sample Manager import/assign/create seams and trim markers, Mastering state, Project Settings meter/count-in selection, and the replace-confirm backup/retry flow are all pinned by the new suites plus the pre-existing `modalDialogShell`, `exportAudition`, `phase1j.projectSettings`, and `ui04ThemeConsistency` suites — all green (§5).

## 4. Contrast evidence (palette math; rendered pixels run in CI)

Tokens parsed live from `src/index.css` (`themeTestDocument.ts`), asserted in the unit suites:

| Pairing | Dark | Light | Floor |
| --- | --- | --- | --- |
| `--apex-text` / panel (`--apex-surface`) | ≥ 4.5 ✓ | ≥ 4.5 ✓ | 4.5 |
| `--apex-text-2` / panel | ≥ 4.5 ✓ | ≥ 4.5 ✓ | 4.5 |
| `--apex-gold` warning border / `--apex-surface` | 9.98 | 5.33 | 3 (SC 1.4.11) |
| rejected `#d97706` / Light surface | — | 3.19 | (borderline, fixed-hue) |
| Light panel / Light scrim composited over Light bg | — | ≥ 3 ✓ (unit-asserted) | 3 |
| `--apex-success`/`--apex-danger` trim markers / `--apex-canvas` | ≥ 3 ✓ | ≥ 3 ✓ | 3 |
| `--apex-state-playing-fg` / `--apex-accent` (confirm CTA) | ≥ 4.5 ✓ | ≥ 4.5 ✓ | 4.5 |

The four browser specs measure the rendered scrim (`getComputedStyle` == `--apex-modal-overlay`, no `bg-black` in the class), title AA on its effective surface, and a no-reload theme flip, in both palettes, through the real entry points (`#fl-export-btn`; Studio Browser “New”; Tools → `#fl-sampler-modal-btn`; Project menu → Project Settings). They run in CI (§5.2); they could not run in this sandbox (§7.1).

## 5. Validation

### 5.1 Unit gates (frozen tree, this sandbox)

| Gate | Result |
| --- | --- |
| `npm run verify:desktop` | PASS |
| `npm run lint` (`tsc --noEmit`, covers `browser-tests/`) | PASS |
| `npm run verify:test-discovery` | 257 files (252 + 5 new), **0 orphaned** |
| `npm run test:shell` | 271/271 |
| `npm run test:truth` | 98/98 |
| `npm run test:history` | **1103/1103** (1083 baseline + 20 new) |
| `npm run test:audio` | 1676/1676 |
| `npm run build` | PASS — CSS 108.31 kB (gzip 16.81) vs baseline 108.14; JS 1,213.87 kB (gzip 318.38) vs 1,213.93 |
| `npx playwright test --list` (new specs) | 12 tests discovered, parse clean |

### 5.2 Browser suite

Not runnable locally (§7.1). The full Playwright suite — including the 12 new tests — runs in CI on the PR (`Apex Studio CI` and `Audio Validation` workflows both execute `npx playwright test`). **The PR must not be merged until those checks are green on the exact head SHA**; results are reported on the PR.

## 6. Compatibility-layer audit (UI-1C) — unchanged, deliberately

The UI-1C layer in `index.css` still has zero live consumers (UI-03P §6) and is still **not** deleted here: the batch brief reserves it as separate reviewable work. This batch neither adds nor removes any consumer of it.

## 7. Known limitations

1. **No local browser evidence.** This sandbox has no Chromium and cannot download one (Playwright/Google CDNs are outside the sandbox network allowlist; `npx playwright install chromium` fails with `ECONNRESET`). The four new specs follow the UI-03P spec conventions exactly, typecheck, and are discovered by Playwright; their rendered-pixel evidence is produced by CI on the PR. The eight `ui03q-*.png` screenshots the specs write are therefore generated in the CI workspace and are **not committed** in this PR (prior batches committed locally-generated screenshots; that step was impossible here and is not faked).
2. **`ProjectReplaceConfirmModal` has no browser coverage** — reaching it requires making the open project “have work” and then replacing it, which would mutate the project under test. Its evidence is the server-rendered unit suite (dialog contract, error/working states, scrim-token math) plus the palette table in §4. Same category as `AppErrorBoundary` in UI-03P.
3. **The pre-existing Vite CSS warning** (Tailwind scanning `--apex-*` in comments, UI-03P §7.6) is unchanged and not introduced by this batch.
4. **Known UI-03F/UI-03M browser timing flakes** are untouched, per the brief; if a CI run fails in those specs, it should be re-run and reported, not silently absorbed.

## 8. Remaining UI-03 work after this batch

1. Delete the now-dead UI-1C compatibility layer in `index.css` (separate PR, per brief).
2. Stabilise the UI-03F/UI-03M timing flakes (separate PR, per brief).
3. Optional designer-requested residuals from UI-03P §7: audio-clip body/fade scrim, marker quick-add washes.

## 9. Merge recommendation

**Request review; do not merge from the implementation agent.** All locally-runnable gates pass on the frozen tree; merge is conditional on the PR's CI browser suite (and all other required checks) passing on the exact head SHA.
