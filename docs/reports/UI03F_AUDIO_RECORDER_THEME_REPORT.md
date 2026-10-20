# UI-03F — Audio Recorder Light/Dark Theme Migration

Scope: `AudioRecorderModal` only, one modal per PR. Follows the UI-03B (Mastering), UI-03C (Mixer), UI-03D (Wavetable) and UI-03E (Audio Slicer) pattern: semantic tokens for chrome, a per-mode palette seam for the canvas, and intentional signal colours kept as constants per mode.

Not in scope: `ParametricEqModal` (its own pass), global CSS, the design-system foundation (`src/index.css` is unchanged), and any recording, audio or persistence code.

Baseline: `main` at `4ac848b` (PR #211 merge). Post-merge CI on that commit was already green across all workflows and was not rerun.

## Before implementation: audit

`AudioRecorderModal.tsx` (608 lines) carried:

- **Hardcoded colours**: about 90 class-string references to `#hex` literals, the Tailwind `text-white`/`text-black`/`bg-black` utilities, `red-*` and `#d97706` palette utilities, and `bg-black/85` on the overlay.
- **Imperative canvas**: a `requestAnimationFrame` loop that fills `#0a0a0b` and strokes `#ff6e00` on every frame while open. Its effect depends only on `[isOpen]`, so a theme flip could never repaint it.
- **Legacy layer dependence**: most `bg-[#…]` / `text-[#…]` literals only looked right in Dark because `src/index.css` maps them to tokens. The unmapped literals (`text-white`, `#d97706`, `red-*`, `#101012`, `hover:bg-[#2d2d30]`) render as written in both themes.
- **Light-only failures**: white labels on surfaces that flip light, and muted text on surfaces that stay dark.

Behaviour that had to stay unchanged, verified in the diff below: the count-in and punch flow, `RecordingEngine` start/stop/cancel, the punch window publication, take placement, the project-replacement handler, the close and escape paths, the `requestAnimationFrame` loop and its cancel on cleanup, every `aria-label` and `data-*` hook, and all Phase 1K/1L copy.

## What changed

1. **`src/components/audioRecorderTheme.ts` (new).** The palette seam:
   - The canvas background is read from `--apex-canvas` through the shared `canvasThemeTokens.ts` resolver.
   - The waveform is a per-mode signal colour. Dark keeps `#ff6e00`. Light uses `--apex-gold` (`#9a5d00`), the same Light value as the Audio Slicer waveform.
   - The palette is cached per (document, mode). The draw loop reads it on every frame, so a theme flip is picked up on the next frame. No `MutationObserver` is needed, and none is attached.
2. **`src/components/AudioRecorderModal.tsx`.**
   - Every colour literal is replaced with a semantic token class. The file now has no hex literal in class strings, no `text-white`/`text-black`/`bg-black`, no `rgba()`, and no palette utility.
   - The canvas paints from the seam (`readRecorderPalette()` each frame). This is the only logic-adjacent change.
   - The dead `bg-black/85` is removed from the overlay string. `ModalFrame` already applies `apex-modal-overlay` to every framed modal, so the rendered scrim is the shared token in both themes. Verified: computed overlay background is `rgba(5, 7, 12, 0.66)` in Dark and `rgba(24, 32, 45, 0.55)` in Light.
3. **`src/state/modalDialogShell.test.tsx`.** The shared shell test pinned this modal's overlay class verbatim. That one entry is updated to the new string, with a comment, mirroring UI-03E. Other modals' pins are untouched.
4. **`package.json`.** The two new unit test files are added to `test:history`, so `verify:test-discovery` covers them (229 files, 0 orphaned).
5. **Tests.** Listed below.

### Token mapping (summary)

| Literal (main) | Token | Notes |
| --- | --- | --- |
| `#141416`, `#1a1a1d` | `--apex-surface` | Panel, header, chips |
| `#222225`, `#2d2d30` (hover) | `--apex-surface-2`, `--apex-surface-3` | Cancel, Pause, close |
| `#0a0a0b`, `#101012` | `--apex-bg` | Timer well, punch section, take waveform |
| `#121214` | `--apex-canvas` | Canvas, inputs, track select |
| `#333336`, `#222225` (border) | `--apex-border` | |
| `#b0b0b0` | `--apex-text-2` | |
| `#777` | `--apex-text-3` | |
| `text-white` | `--apex-text` | Title, timer, inputs, labels |
| `#ff6e00` (UI accent) | `--apex-accent` / `--apex-accent-strong` | Start, chips, switch, Place Take |
| `text-black`, `bg-black` (on accent) | `--apex-state-playing-fg` | On-accent labels |
| `bg-[#ff0000]`, `hover:bg-red-600`, `text-white` (Stop) | `--apex-state-recording` / `--apex-state-recording-fg` | Pairs with the existing `bg-[var(--apex-danger)] text-[var(--apex-state-recording-fg)]` pattern |
| `#ff6e00` @ 15–50% (chips, range cells) | `--apex-state-selected` / `--apex-state-selected-border` | |
| `#d97706` (warnings) | `--apex-gold` | |
| `red-300`, `red-200`, `red-950/30`, `red-800/50` (errors) | `--apex-danger`, mixed toward `--apex-text` (70/30) for text; danger `color-mix` wash and border | See Dark deltas |
| `#ff6e00` waveform (canvas) | per-mode signal, `#ff6e00` Dark / `#9a5d00` Light | Seam |
| `#0a0a0b` canvas fill | `--apex-canvas` via seam | Seam |
| `bg-black/85` overlay | `ModalFrame`'s `apex-modal-overlay` (already applied) | Rendered scrim unchanged |

## Tests

| Layer | File | What it proves |
| --- | --- | --- |
| Unit (seam) | `src/components/audioRecorderTheme.test.ts` (10 tests) | Canvas background follows the theme token; Dark waveform is the exact shipped literal; Light waveform is `--apex-gold`; waveform clears 3:1 on the canvas in both themes; the shipped Dark orange would have failed on Light; no stale palette after a flip; cache identity; per-document caches; no-DOM and missing-token fallbacks. |
| Unit (markup/source) | `src/components/audioRecorderThemeUi.test.tsx` (10 tests) | Full dialog renders in each punch state; no colour literal or white/black/palette utility in any class attribute; chrome uses the expected `var(--apex-…)` tokens; Start uses its on-accent label; overlay is supplied by `ModalFrame`; the frame callback reads the palette, the loop is still cancelled, and no observer is attached; on-colour pairs match; the source has no literal colour, white/black or palette utility; Phase 1K/1L copy is unchanged. |
| Real browser | `browser-tests/audioRecorderTheme.spec.ts` (5 tests) | Idle and error states: every visible text node and form value reaches AA against its composited background, in Dark and Light; overlay computed colour is the token; canvas background and waveform are this theme's and the other's are absent; a live theme flip repaints the open waveform in both directions with no stale pixels. |

Negative controls:

- Reintroducing `text-white` on the title and a hardcoded canvas palette made 3 markup/source tests fail. Restored: 10/10 pass.
- Running the browser spec against an unmodified `main` worktree fails 4 of 5 tests (Light AA, Dark canvas, flip). The one passing test is Dark error text, which was already AA on `main`.

## Results (actual, this sandbox)

| Check | Result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | pass |
| `npm run verify:test-discovery` | pass (229 files, 0 orphaned) |
| `npm run verify:desktop` | pass |
| `npm run test:shell` | 271/271 |
| `npm run test:history` (includes the 20 new recorder unit tests) | 850/850 |
| `npm run test:audio` | 1676/1676 |
| Focused: `audioRecorderTheme`, `audioRecorderThemeUi`, `modalDialogShell`, `phase1l.punchRecorderUi`, `recording.integration` | 71/71 |
| `npx playwright test browser-tests/audioRecorderTheme.spec.ts` | 5/5 |
| `npm run build` | pass |

The full Playwright suite runs in CI; the new spec was run locally against Chromium 153 (see Known limitations).

## Contrast evidence

Measured in the browser, text composited against its effective background. Minimum per state, all visible text and form values:

| State | Theme | `main` minimum | UI-03F minimum |
| --- | --- | --- | --- |
| Idle | Dark | 5.64:1 | 5.64:1 |
| Idle | Light | **1.00:1** (`AUDIO RECORDER`; 4 nodes below AA) | 5.01:1 |
| Validation + error | Dark | 5.64:1 | 5.64:1 |
| Validation + error | Light | **1.00:1** (18 nodes below AA) | 5.01:1 |
| Recording (Stop & Save, Pause) | Dark | **2.95:1** (`STOP & SAVE`) | 6.43:1 (`STOP & SAVE`) |
| Recording (Stop & Save, Pause) | Light | **1.08:1** (`PAUSE`) | 15.12:1 (`PAUSE`), 6.00:1 (`STOP & SAVE`) |
| Count-in (Cancel) | Light | **1.08:1** (`CANCEL`) | 13.81:1 |
| Recorded take | Light | **1.00:1** (`RECORDED TAKE`) | 16.36:1 |

Key elements, Light `main` → UI-03F: `AUDIO RECORDER` 1.00 → ≥5.0; timer `00:00` 1.13 → ≥5.0; `Punch recording` 3.35 → ≥5.0; the punch validation message 1.35 → ≥5.0.

Canvas, measured from the bitmap:

| Theme | `main` background | UI-03F background | Waveform |
| --- | --- | --- | --- |
| Dark | `rgb(10,10,11)` `#0a0a0b` | `rgb(21,24,33)` `#151821` (`--apex-canvas`) | `#ff6e00` present |
| Light | `rgb(10,10,11)` `#0a0a0b` (dark hole on a light panel) | `rgb(244,246,250)` `#f4f6fa` | `#9a5d00` present; `#ff6e00` absent |

Theme flip with the dialog open: Dark → Light → Dark repaints with no stale pixels.

Screenshots (captured from the real browser): `assets/screenshots/ui03f-audio-recorder-{dark,light}.png` show punch on with a valid window, idle. `ui03f-audio-recorder-{dark,light}-error.png` show a window that cannot be recorded (punch-out before punch-in), with Start refused and the error box shown.

## Dark-theme deltas (deliberate)

Dark is not pixel-identical. Where a literal was already remapped by the legacy layer, there is no rendered change. The deltas below are the cases where the literal rendered as written, or where the authored alpha was capped.

- **Stop & Save label**: `text-white` → `--apex-state-recording-fg` (near-black). White on the Dark danger fill measured **2.95:1**, which fails AA for 14 px bold text. The new pair measures 6.43:1. This is the largest Dark change and the one a reviewer should look at first.
- **Validation / error text**: `#fca5a5`-family pale red → danger mixed 70% toward primary text. Dark text is a lighter coral pink, measuring 5.64:1 (plain danger measured 4.79:1 and was rejected).
- **Warnings**: `#d97706` → `--apex-gold` (`#ffb86b`), a lighter amber.
- **Canvas well**: `#0a0a0b` → `--apex-canvas` (`#151821`), the same canvas token the Audio Slicer uses.
- **Punch range cells and borders**: the legacy layer silently capped `bg-[#ff6e00]/35` to 16%. Now `--apex-state-selected` (18%), with borders at 60%. Slightly stronger.
- **Hover fills**: `hover:bg-[#2d2d30]` → `--apex-surface-3` (`#262b38`). Stop's hover goes from a darker `red-600` to an 80% opacity hover.
- **Negligible**: punch container `#101012` → `--apex-bg` (`#11131a`); text inputs `#fff` → `--apex-text` (`#f4f5f8`).

Unchanged in Dark: the waveform `#ff6e00`, the scrim, every button fill that the legacy layer already mapped, the Start/Place Take/chip fills and labels (`#9b8afb` with near-black text), the idle and error text (5.64:1 minimum on both `main` and the branch).

## Light-theme deltas (repairs)

Light was broken for this modal. The changes are repairs, not cosmetic moves:

- Labels that were `text-white` on surfaces that flip light (title, timer, Cancel, Pause, recorded-take label, inputs, select) now use `--apex-text`.
- Muted labels that stayed on dark-treated surfaces now use the token scale, so text and background move together.
- The canvas stops being a dark hole. It follows `--apex-canvas` and the waveform uses `--apex-gold`, which measures 4.93:1 on the Light canvas (the shipped orange measured 2.59:1).
- The on-accent label is `--apex-state-playing-fg`, which is white in Light. Light accent buttons (`#6552ce`) keep the same fill as before.

## Behaviour explicitly preserved

The non-class content of the file was compared with `main` after blanking every class string. The only differences are the new import, the explanatory comments, and the two canvas paint lines (`fillStyle` and `strokeStyle`, now from the seam). Handlers, state, effects, refs, the recording engine calls, the count-in and punch paths, the publication path, the project-replacement handler, JSX structure, `aria-*` and `data-*` attributes, and all copy are unchanged. No recording, audio, permission or persistence logic was touched.

I did not run a real microphone capture. The recording states were exercised in a local probe with Chromium's fake audio input (see Known limitations).

## Known limitations

1. **Recording-state contrast is verified locally, not committed.** The Stop, Pause, Cancel, count-in and recorded-take states need a microphone, so the committed browser spec covers idle and error only. I measured the recording states with a throwaway probe using Chromium fake-media flags (both themes, `main` and branch). I did not add those flags to the shared Playwright config. The probe is not in the repo.
2. **Hover and disabled states are not measured.** The Stop button's hover is an 80% opacity change, and disabled controls (`opacity-40`/`50`) are excluded, as in UI-03D/E.
3. **Recorded-take bars remain violet in Dark.** They use `--apex-accent`, the same as the legacy mapping showed before this change. The live canvas uses the orange signal colour. That visual split predates this phase and is unchanged.
4. **Local browser binary.** Playwright's own Chromium download is blocked in this sandbox. The suite ran against Chromium 153 from the `@sparticuz/chromium` npm package, placed at `/tmp/chromium` and not added to `package.json`. This is an environment detail; CI uses its own browser.
5. **Windows packaging and the packaged smoke test** were not run locally. They run in CI.
6. **Canvas repaint is verified by pixels.** The spec reads the bitmap histogram; I did not inspect the captured screenshots beyond confirming the Dark and Light renders.

## Next phase

Remaining canvas modal: `ParametricEqModal`. It needs its own seam pass and PR. The legacy `bg-black/85` scrim string also remains on other modals and can be swept separately.
