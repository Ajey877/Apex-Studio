# UI-03K — ArpeggiatorModal Light/Dark Theme Migration

**Baseline:** `main` @ `e9b799ba766f9c5546e980109ca7a6e14064c90a` (PR #216, UI-03J merged)
**Implementation branch:** `arena/4054bc14-apex-studio` (Arena session-bound branch)
**Scope:** `ArpeggiatorModal` presentation only, its focused unit/browser coverage, the modal-shell expectation, test-suite discovery wiring, and this report. No global CSS, token definitions, DSP code, MIDI semantics, or ProjectState implementation changed.

## Before implementation: audit

`ArpeggiatorModal.tsx` had 64 hardcoded palette references in the UI-03A inventory. It is DOM-rendered and has no canvas, so the existing `--apex-*` tokens can theme all of its surfaces directly; no palette seam or theme observer is required. The modal already renders inside `ModalFrame`, so the framing dialog receives the theme-aware scrim and the modal's own dark fill was redundant.

Three color families carry meaning and keep it in both themes:

- **Warm orange** (`#ff6e00` family) — the arpeggiator identity: icon tile, selected mode/rate, Euclidean accents, the gold Save action. Retained through the existing `--apex-gold` token (warm orange in Dark, legible amber/brown in Light), the same mapping UI-03J chose for Gross Beat's orange.
- **Green** (`#00ff88` family) — enabled/bypass and gate-length state. Retained through `--apex-success`.
- **Cyan** (`#00e5ff` family) — strum micro-delay and rotation readouts/sliders. Retained through `--apex-cyan` (controls) and `--apex-cyan-text` (text), the mapping UI-03D established for the wavetable.

## What changed

1. **`src/components/ArpeggiatorModal.tsx`**
   - Panel, header/footer, parameter and Euclidean cards, step visualizer inset, neutral text, borders, selected/hover states, and the scrim now use existing semantic surface/state tokens.
   - The dead dark overlay fill is removed from the `ModalFrame` class string; the existing backdrop blur, fade, stacking, and layout remain, and the shared `--apex-modal-overlay` scrim renders exactly as before (the unlayered token rule always overrode the dead fill).
   - The warm arpeggiator identity remains on the icon tile, gold-tinted panel border, selected mode/rate buttons, parameter readouts and accents, Euclidean accents, visualizer hits, and Save action via `--apex-gold`.
   - Enabled/bypass states stay distinct (`--apex-success`) and use theme-appropriate on-colour tokens (`--apex-state-playing-fg`); strum/rotation keep `--apex-cyan`/`--apex-cyan-text`.
   - No fixed hex color, white/black palette utility, or fixed dark surface/text utility remains in the component.
2. **`src/components/arpeggiatorThemeUi.test.tsx` (new)**
   - Seven tests pin complete Dark/Light markup, all six modes and six rates, the shared scrim, semantic token use, the preserved orange/success/cyan meanings, slider ranges and published settings wiring, the Euclidean visualizer (16 steps, 5 hits for `E(5, 16)`), and the closed state.
   - Added to `test:history`; `verify:test-discovery` confirms 235 covered files, 0 orphaned.
3. **`browser-tests/arpeggiatorTheme.spec.ts` (new)**
   - Two real Chromium cases cover Dark and Light computed panel/header/scrim colors, gold identity and title/CTA contrast (≥ 4.5:1), success/cyan readouts with AA contrast, the neutral hover shift, enabling the arp, switching to Euclidean, the painted grid (5 gold hits on the inset), live `E(5, 17)` regeneration, the octave slider, and Save-and-close.
4. **`src/state/modalDialogShell.test.tsx`** updates only the Arpeggiator's expected overlay classes to pin ModalFrame's shared scrim and preserve its existing layout contract.
5. **`package.json`** adds the new theme test to `test:history`. **`UI03A_THEME_FOUNDATION_REPORT.md`** records merged UI-03J and the in-progress UI-03K review status. No token/global stylesheet changes were needed.

### Behavior explicitly untouched

The modal still keeps a local `arpState` draft and publishes `{ ...channel, arp: arpState }` through `onUpdateChannel` only on Save; ON/OFF, the six modes, six rates, octave/gate/strum ranges, and Euclidean steps/hits/rotation keep their exact min/max/step values. `audioEngine.generateEuclideanPattern` still renders the visualizer and `audioEngine.playNote` still auditions a preview note; Escape/focus-trap behaviour remains ModalFrame's. App/ProjectState, save/load, undo/redo, live DSP, MIDI processing, and offline/export gate paths were not modified.

## Validation (observed in this run)

| Check | Result |
| --- | --- |
| Focused theme + modal-shell tests (`arpeggiatorThemeUi`, `modalDialogShell`) | **35/35 pass** (7 + 28) |
| Arp audio regressions (Phase 68 strum, Phase 70 tempo, Phase 1D transient gate) | **36/36 pass** |
| UI-03A/UI-04 theme foundation, theme storage, and shell token checks | **38/38 pass** |
| Full `npm run test:history` (includes the new theme suite and modal-shell contract) | **927/927 pass** |
| `npm run verify:test-discovery` | **Pass** — 235 test files covered, 0 orphaned |
| `npm run lint` | **Pass** — `tsc --noEmit` |
| `npm run build` | **Pass** — production build |
| Production CSS check | **Pass** — compiled gold/success/cyan, `color-mix` selected-mode and on-colour token utilities are present |
| Playwright (`browser-tests/arpeggiatorTheme.spec.ts`) | **Pass** — 2/2 with Chromium 153 (`@sparticuz/chromium` npm-distributed binary); Dark and Light both exercised in a real browser |
| `git diff --check` | **Pass** |

The production build prints the repository's existing Vite advisory that the minified JavaScript chunk exceeds 500 kB. The migration did not change chunking. Browser coverage used the npm-distributed Chromium 153 binary because no system Chromium was installed and the Playwright CDN is unreachable from the sandbox; the final browser checks ran against the actual Vite application.

## Review status and limitations

- No DSP, audio-engine, MIDI, persistence, or global CSS files were changed. Existing Phase 68/70/1D arp regressions pass.
- No new design tokens were introduced. `--apex-gold` preserves the effect's warm identity while adapting for Light; as with any shared semantic token, the exact legacy orange is not byte-identical. The panel keeps its original `shadow-2xl` elevation utility, so its shadow is unchanged rather than moved to `--apex-shadow`.
- The Audition button was not clicked in the browser suite (it would start real audio in headless Chromium); its wiring is pinned by the unit suite and its hover/paint are verified.
- GitHub CI is external to the local checks and is verified against the final pull-request head separately.
- This migration is not merged. Stop for review and merge approval; do not begin another modal migration.
