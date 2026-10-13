# UI-03J — GrossBeatModal Light/Dark Theme Migration

**Baseline:** `main` @ `11c5e00902aafbe81d82d155f2afdb11979de937` (PR #215, UI-03I merged)
**Implementation branch:** `arena/da397333-apex-studio` (Arena session-bound branch)
**Scope:** `GrossBeatModal` presentation only, its focused unit/browser coverage, the modal-shell expectation, test-suite discovery wiring, and this report. No global CSS, token definitions, DSP code, or ProjectState implementation changed.

## Before implementation: audit

`GrossBeatModal.tsx` had 72 hardcoded palette references in the UI-03A inventory. It is DOM-rendered and has no canvas, so the existing `--apex-*` tokens can theme all of its surfaces directly; no palette seam or theme observer is required. The framed dialog already receives the theme-aware scrim from `ModalFrame`, making the modal's own `bg-black/85` fill redundant.

The bright orange family identifies Gross Beat and its open gate steps. It is retained through the existing `--apex-gold` token: warm orange in Dark and the same legible amber/brown family in Light. Enabled, playing, and brake states remain distinct: `--apex-success`, `--apex-state-playing`, and `--apex-danger`, respectively.

## What changed

1. **`src/components/GrossBeatModal.tsx`**
   - Panel, header/footer, cards, inset grid, select, neutral text, borders, hover/selected states, and shadow now use existing semantic surface/state tokens.
   - The dead black scrim fill is removed; the existing backdrop blur, stacking, layout, and `ModalFrame` wiring remain.
   - The warm Gross Beat identity remains on the icon tile, amplitude badge, depth readout, preset selection, active gate steps, and Apply & Close action via `--apex-gold`.
   - Effect enabled, current playhead, and triggered brake keep distinct semantic status colors and use theme-appropriate on-colour tokens.
   - No fixed hex color, white/black palette utility, or fixed dark surface/text utility remains in the component.
2. **`src/components/grossBeatThemeUi.test.tsx` (new)**
   - Eight tests pin complete Dark/Light markup, all 16 steps and six presets, the shared scrim, semantic token use, meaningful effect/status colors, gate-value wiring, depth and brake controls, and the closed state.
   - Added to `test:history`; `verify:test-discovery` confirms it is covered.
3. **`browser-tests/grossBeatTheme.spec.ts` (new)**
   - Two real Chromium cases cover Dark and Light computed panel/header/scrim colors, effect identity and depth contrast, on-colour contrast, enabling the effect, loading a preset, toggling a step, All Open/Invert, adjusting gate depth, and closing.
4. **`src/state/modalDialogShell.test.tsx`** updates only Gross Beat's expected overlay classes to pin ModalFrame's shared scrim and preserve its existing layout contract.
5. **`UI03A_THEME_FOUNDATION_REPORT.md`** records merged UI-03I and the in-progress UI-03J review status. No token/global stylesheet changes were needed.

### Behavior explicitly untouched

Gross Beat still publishes `enabled`, `mix`, and the same 16-step pattern through `onUpdateGrossBeat`; preset contents and All Open/Invert/step-toggle behavior remain unchanged. The master-brake duration choices, transient brake state, and `audioEngine.triggerMasterBrake` connection remain unchanged. `currentStep`/`isPlaying` still select the playhead marker, and App/ProjectState, save/load, undo/redo, live DSP, and offline/export gate paths were not modified.

## Validation (observed in this run)

| Check | Result |
| --- | --- |
| Focused UI + truth + modal-shell tests (`grossBeatThemeUi`, `grossBeatTruth`, `modalDialogShell`) | **54/54 pass** |
| Gross Beat DSP, offline/render, Phase 58 master-gate, and Phase 79 ProjectState/persistence regressions | **71/71 pass** |
| UI-03A/UI-04 theme foundation and modal-shell checks | **45/45 pass** |
| `npm run verify:test-discovery` | **Pass** — 234 test files covered, 0 orphaned |
| `npm run lint` | **Pass** — `tsc --noEmit` |
| `npm run build` | **Pass** — 1,831 modules transformed |
| Production CSS check | **Pass** — compiled surface, inset, gold, accent and selected-preset token utilities are present |
| Playwright (`browser-tests/grossBeatTheme.spec.ts`) | **Pass** — 2/2 with Chromium 153; Dark and Light both exercised in a real browser |
| `git diff --check` | **Pass** |

The production build prints the repository's existing Vite advisory that the minified JavaScript chunk exceeds 500 kB. The migration did not change chunking. Browser coverage used the npm-distributed Chromium 153 binary because no system Chromium was installed; the final browser checks ran against the actual Vite application.

## Review status and limitations

- No DSP, audio-engine, persistence, or global CSS files were changed. Existing Phase 57/79 regression tests pass.
- No new design tokens were introduced. `--apex-gold` preserves the effect's warm identity while adapting for Light; as with any shared semantic token, the exact legacy orange is not byte-identical.
- GitHub CI is external to the local checks and is verified against the final pull-request head separately.
- This migration is not merged. Stop for review and merge approval; do not begin another modal migration.
